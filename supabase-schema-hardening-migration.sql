-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Schema hardening: role/endpoint enums + user-deletion RPC
-- ═══════════════════════════════════════════════════════════════
-- Three small additions, one migration. Apply AFTER the prior
-- migrations (schema, security-tighten, invites-email, email-rate-limit).
-- Idempotent: pre-flight DO blocks, DROP CONSTRAINT IF EXISTS,
-- CREATE OR REPLACE FUNCTION.
--
-- What this adds:
--   1. CHECK constraint on user_profiles.role — typo-proofs the
--      single column the entire admin gate depends on.
--   2. CHECK constraint on email_send_log.endpoint — same shape,
--      keeps the audit log strictly typed.
--   3. delete_user_data() RPC — the public-schema half of the
--      "right to be forgotten" / GDPR deletion procedure. Wipes
--      all PII tagged with a user's UUID and anonymizes log rows
--      that reference the user's email. Auth row deletion is a
--      separate step (see runbook in this file's header).
--
-- WHY THIS MATTERS PRE-LAUNCH
--   * Without the role CHECK, a typo'd role ('admim') silently
--     fails every is_admin() check — a real footgun.
--   * Without the endpoint CHECK, a future bug could write garbage
--     endpoint names to email_send_log, polluting the dashboard.
--   * Without delete_user_data, there is no documented procedure
--     for handling a deletion request. You'd be assembling the
--     DELETE statements ad-hoc in the SQL Editor while a user
--     waits — error-prone and audit-unfriendly.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. user_profiles.role CHECK constraint ────────────────────
-- Pre-flight: refuse to add the constraint if any existing row
-- would violate it. Surfaces drift loudly so a silent demotion
-- (admin → user) can't happen.

DO $$
DECLARE
    v_bad INT;
BEGIN
    SELECT count(*) INTO v_bad
      FROM public.user_profiles
     WHERE role IS NOT NULL
       AND role NOT IN ('user', 'tester', 'admin', 'superadmin');

    IF v_bad > 0 THEN
        RAISE EXCEPTION
            'Cannot add user_profiles_role_valid: % rows have invalid role values. Inspect with:  SELECT id, role FROM public.user_profiles WHERE role NOT IN (''user'',''tester'',''admin'',''superadmin'');',
            v_bad;
    END IF;
END $$;

ALTER TABLE public.user_profiles
    DROP CONSTRAINT IF EXISTS user_profiles_role_valid;

ALTER TABLE public.user_profiles
    ADD CONSTRAINT user_profiles_role_valid
    CHECK (role IN ('user', 'tester', 'admin', 'superadmin'));


-- ── 2. email_send_log.endpoint CHECK constraint ───────────────
-- Same shape. New endpoints (e.g. 'digest', 'welcome') are
-- expected to drop the constraint and re-add with the new value
-- as part of their feature migration.

DO $$
DECLARE
    v_bad INT;
BEGIN
    SELECT count(*) INTO v_bad
      FROM public.email_send_log
     WHERE endpoint NOT IN ('alerts', 'invites');

    IF v_bad > 0 THEN
        RAISE EXCEPTION
            'Cannot add email_send_log_endpoint_valid: % rows have unknown endpoint values. Inspect or DELETE them first.',
            v_bad;
    END IF;
END $$;

ALTER TABLE public.email_send_log
    DROP CONSTRAINT IF EXISTS email_send_log_endpoint_valid;

ALTER TABLE public.email_send_log
    ADD CONSTRAINT email_send_log_endpoint_valid
    CHECK (endpoint IN ('alerts', 'invites'));


-- ═══════════════════════════════════════════════════════════════
-- 3. delete_user_data() — the data-side of "delete account"
-- ═══════════════════════════════════════════════════════════════
-- Wipes every PII row in the public schema for one user, in a
-- single transaction. Anonymizes (does not delete) audit rows so
-- the operational history remains intact for security review.
--
-- Tables handled:
--   DELETED:
--     - public.satellite_alerts        (per-user alert subscriptions)
--     - public.alert_history           (per-user fired alerts)
--     - public.user_locations          (per-user saved coords)
--     - public.user_profiles           (the row itself)
--   ANONYMIZED (when p_anonymize_logs = true):
--     - public.invite_codes.invited_email      → NULL where == user.email
--     - public.email_send_log.recipient_email  → NULL where == user.email
--   AUTOMATICALLY HANDLED via existing FK ON DELETE behaviour:
--     - public.analytics_events.user_id → SET NULL
--     - public.user_sessions.user_id    → SET NULL
--     - public.email_send_log.user_id   → SET NULL
--     - public.invite_codes.created_by  → SET NULL
--   NOT HANDLED (caller's responsibility):
--     - auth.users  — delete via Supabase Admin API in a server-
--                     side endpoint (service_role key required).
--                     See runbook below.
--     - Stripe customer record — handle via Stripe Dashboard or
--                                a stripe.customers.del() call.
--
-- Auth: caller must be admin. Self-deletion via this RPC is
-- blocked; future work is a separate `delete_my_account()` RPC
-- that requires re-auth.
--
-- Returns: row count breakdown so the caller can audit / display.
-- Idempotent: calling on a non-existent user returns all zeros.
--
-- ── Runbook for handling a deletion request ───────────────────
--   STEP 1. Look up the user UUID:
--     SELECT id, email FROM auth.users WHERE email = 'user@example.com';
--
--   STEP 2. Anonymize + delete public-schema rows:
--     SELECT * FROM public.delete_user_data('<uuid>'::uuid);
--     (Inspect the returned counts to confirm.)
--
--   STEP 3. Delete the auth.users row from a server-side context
--           that has the service_role key. From a Node/Edge
--           function:
--     await supabase.auth.admin.deleteUser('<uuid>');
--           Or from the Supabase Dashboard:
--           Authentication → Users → row menu → Delete user.
--
--   STEP 4. If the user had a paid plan, void/refund their Stripe
--           subscription via the Stripe Dashboard.
--
--   STEP 5. Record the deletion in your audit log (separate
--           future feature) with the requesting admin, timestamp,
--           and reason.
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.delete_user_data(
    p_user_id        UUID,
    p_anonymize_logs BOOLEAN DEFAULT true
) RETURNS TABLE (
    profile_deleted          INT,
    locations_deleted        INT,
    sat_alerts_deleted       INT,
    alert_history_deleted    INT,
    invite_emails_anonymized INT,
    log_emails_anonymized    INT
) AS $$
DECLARE
    v_user_email   TEXT;
    v_profile      INT := 0;
    v_locations    INT := 0;
    v_sat_alerts   INT := 0;
    v_history      INT := 0;
    v_invite_anon  INT := 0;
    v_log_anon     INT := 0;
BEGIN
    -- Auth gate: only admins may run this. is_admin() reads the
    -- caller's user_profiles.role via SECURITY DEFINER.
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'delete_user_data: caller is not admin';
    END IF;

    -- Don't allow an admin to delete their own account through
    -- this path — too easy to lock yourself out of the dashboard
    -- by accident. Self-deletion needs a separate flow with
    -- explicit re-auth.
    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'delete_user_data: cannot delete your own account via this RPC';
    END IF;

    -- Look up the user's email for PII anonymization in tables
    -- that key on email rather than user_id.
    SELECT email INTO v_user_email FROM auth.users WHERE id = p_user_id;

    -- ── Anonymize log PII keyed on email ────────────────────
    IF p_anonymize_logs AND v_user_email IS NOT NULL THEN
        UPDATE public.invite_codes
           SET invited_email = NULL
         WHERE lower(invited_email) = lower(v_user_email);
        GET DIAGNOSTICS v_invite_anon = ROW_COUNT;

        UPDATE public.email_send_log
           SET recipient_email = NULL
         WHERE lower(recipient_email) = lower(v_user_email);
        GET DIAGNOSTICS v_log_anon = ROW_COUNT;
    END IF;

    -- ── DELETE PII rows keyed on user_id ────────────────────
    -- Order matters only for FK constraints; these tables have
    -- independent FKs to auth.users so the order is cosmetic.

    DELETE FROM public.satellite_alerts WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_sat_alerts = ROW_COUNT;

    DELETE FROM public.alert_history WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_history = ROW_COUNT;

    DELETE FROM public.user_locations WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_locations = ROW_COUNT;

    DELETE FROM public.user_profiles WHERE id = p_user_id;
    GET DIAGNOSTICS v_profile = ROW_COUNT;

    RETURN QUERY SELECT
        v_profile, v_locations, v_sat_alerts, v_history,
        v_invite_anon, v_log_anon;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Lock down: revoke from anon/public, grant to authenticated so
-- admin clients can call it. The internal is_admin() check is
-- the actual gate; the GRANT just lets the call reach the body.
REVOKE ALL ON FUNCTION public.delete_user_data(UUID, BOOLEAN)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_user_data(UUID, BOOLEAN)
    TO authenticated;


-- ═══════════════════════════════════════════════════════════════
-- Verification — paste after running
-- ═══════════════════════════════════════════════════════════════
-- 1. Constraints in place:
--      SELECT conname, pg_get_constraintdef(oid)
--        FROM pg_constraint
--       WHERE conname IN ('user_profiles_role_valid',
--                         'email_send_log_endpoint_valid');
--    Expect both rows with their CHECK definitions.
--
-- 2. Constraint actually enforces (run as service_role / SQL editor):
--      INSERT INTO public.user_profiles (id, role)
--      VALUES (gen_random_uuid(), 'admim');
--    Expect: error 23514 "violates check constraint
--    user_profiles_role_valid". Then:
--      INSERT INTO public.email_send_log (endpoint) VALUES ('garbage');
--    Same error.
--
-- 3. delete_user_data() refuses non-admin caller:
--      In a fresh anon session, run:
--        SELECT * FROM public.delete_user_data(gen_random_uuid());
--      Expect: error "delete_user_data: caller is not admin".
--
-- 4. delete_user_data() refuses self-deletion:
--      As an admin in the SQL editor (which runs as service role,
--      bypassing the is_admin check), test in an actual admin
--      session via the dashboard JS console:
--        await supabase.rpc('delete_user_data', { p_user_id: <your_id> });
--      Expect: error "cannot delete your own account via this RPC".
--
-- 5. Successful deletion returns counts:
--      SELECT * FROM public.delete_user_data('<some-test-user-uuid>');
--    Expect: 6 columns of integer counts, all >= 0.
-- ═══════════════════════════════════════════════════════════════
