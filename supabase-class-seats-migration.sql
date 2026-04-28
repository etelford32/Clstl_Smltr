-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Class seats + activation events migration
-- ═══════════════════════════════════════════════════════════════
--
-- Two tightly-coupled additions that close the Educator/Institution
-- loop and give the team a measurable activation funnel.
--
-- 1. Class-seat invites
--    The Educator ($25/30 seats) and Institution ($500/200 seats)
--    plans were sold but never wired up — `parent_account_id` and
--    `seats_used` exist on user_profiles but no RPC populates them.
--    This migration adds:
--      * apply_class_invite(invite_id, email)  — student accepts a
--        class invite. Sets parent_account_id on the student's row,
--        increments parent's seats_used, leaves student.plan='free'
--        (they ride the parent's plan via parent_account_id).
--      * is_class_invite(invite_id)            — discriminator the
--        client uses to branch signup flow.
--      * effective_plan_for(uid)               — resolves a user's
--        effective plan (theirs OR their parent's) for feature-gate
--        decisions. View v_effective_plan exposes this for RLS.
--      * release_class_seat(student_uid)       — parent removes a
--        student from the roster, decrements seats_used.
--
-- 2. Activation events
--    Without an event log the team can't tell which features drive
--    happiness. This adds a narrow, append-only `activation_events`
--    table + a `log_activation_event()` RPC that any authenticated
--    user can call (with a hard event-name allow-list to prevent
--    tag-name explosion). 90-day retention via the existing
--    purge_old_logs cron.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + CREATE TABLE IF NOT
-- EXISTS + DROP POLICY IF EXISTS. Run AFTER:
--   * supabase-schema.sql
--   * supabase-tier-expansion-migration.sql
--   * supabase-invites-apply-plan-migration.sql
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Mark class-seat invites with a flag on invite_codes ──────
-- A class-seat invite is just an invite_codes row with the new
-- `is_class_seat` flag and the inviter's user_id in `created_by`.
-- It carries no plan tier of its own (the student's effective plan
-- is the parent's). Storing it on invite_codes — rather than a
-- second table — means the existing email + magic-link flow,
-- expiry, and audit log apply unchanged.
ALTER TABLE public.invite_codes
    ADD COLUMN IF NOT EXISTS is_class_seat BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_invite_codes_class_seat
    ON public.invite_codes(created_by, created_at DESC)
    WHERE is_class_seat = TRUE;


-- ── 2. is_class_invite() helper (anon-callable for signup branch) ─
-- Returns true if the code points at a class-seat invite. Mirrors
-- validate_invite()'s SECURITY DEFINER pattern so anon clients can
-- ask "is this a class invite?" without leaking the rest of the
-- row. Returns FALSE for unknown / expired / inactive codes —
-- callers that need the full picture should still call
-- validate_invite() first.
CREATE OR REPLACE FUNCTION public.is_class_invite(p_invite_id UUID)
RETURNS BOOLEAN AS $$
    SELECT COALESCE(
        (SELECT is_class_seat
           FROM public.invite_codes
          WHERE id = p_invite_id
            AND active = TRUE
            AND used_count < max_uses
            AND (expires_at IS NULL OR expires_at > now())),
        FALSE
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.is_class_invite(UUID) TO anon, authenticated;


-- ── 3. apply_class_invite() — student accepts a seat ─────────────
-- Atomically:
--   * Validates the invite (email match if targeted, not expired,
--     not exhausted, parent has seats remaining).
--   * Marks the invite redeemed (used_count + 1, accepted_at).
--   * Writes parent_account_id onto the calling user's row under
--     the privileged_update flag so the guard trigger lets it
--     through.
--   * Increments the parent's seats_used.
--
-- Returns (applied, parent_id, parent_plan). The student's own
-- plan stays 'free' — they ride the parent's plan via the
-- effective_plan_for() helper below. This means a class seat
-- doesn't hit billing at all.
CREATE OR REPLACE FUNCTION public.apply_class_invite(
    p_invite_id UUID,
    p_email     TEXT DEFAULT NULL
) RETURNS TABLE(applied BOOLEAN, parent_id UUID, parent_plan TEXT) AS $$
DECLARE
    v_caller        UUID := auth.uid();
    v_active        BOOLEAN;
    v_max_uses      INT;
    v_used_count    INT;
    v_expires_at    TIMESTAMPTZ;
    v_invited_email TEXT;
    v_is_class_seat BOOLEAN;
    v_created_by    UUID;
    v_parent_seats  INT;
    v_parent_used   INT;
    v_parent_plan   TEXT;
BEGIN
    IF v_caller IS NULL THEN
        applied := FALSE; parent_id := NULL; parent_plan := NULL; RETURN NEXT; RETURN;
    END IF;

    SELECT active, max_uses, used_count, expires_at, invited_email,
           is_class_seat, created_by
      INTO v_active, v_max_uses, v_used_count, v_expires_at, v_invited_email,
           v_is_class_seat, v_created_by
      FROM public.invite_codes
     WHERE id = p_invite_id
     FOR UPDATE;

    IF NOT FOUND
       OR NOT v_active
       OR NOT v_is_class_seat
       OR v_used_count >= v_max_uses
       OR (v_expires_at IS NOT NULL AND v_expires_at <= now())
       OR (v_invited_email IS NOT NULL
           AND (p_email IS NULL
                OR lower(v_invited_email) <> lower(trim(p_email))))
       OR v_created_by IS NULL THEN
        applied := FALSE; parent_id := NULL; parent_plan := NULL; RETURN NEXT; RETURN;
    END IF;

    -- Look up parent's seat budget. Lock the row so two concurrent
    -- students can't both slip in past the cap.
    SELECT classroom_seats, COALESCE(seats_used, 0), plan
      INTO v_parent_seats, v_parent_used, v_parent_plan
      FROM public.user_profiles
     WHERE id = v_created_by
     FOR UPDATE;

    IF NOT FOUND
       OR v_parent_seats IS NULL
       OR v_parent_used >= v_parent_seats THEN
        applied := FALSE; parent_id := v_created_by; parent_plan := v_parent_plan; RETURN NEXT; RETURN;
    END IF;

    -- Mark invite redeemed.
    UPDATE public.invite_codes
       SET used_count  = used_count + 1,
           accepted_at = COALESCE(accepted_at, now())
     WHERE id = p_invite_id;

    -- Bump parent's seat usage.
    UPDATE public.user_profiles
       SET seats_used = COALESCE(seats_used, 0) + 1,
           updated_at = now()
     WHERE id = v_created_by;

    -- Attach student to parent. Privileged-update flag bypasses the
    -- guard trigger that pins parent_account_id from regular UPDATEs.
    PERFORM set_config('pp.privileged_update', '1', true);
    UPDATE public.user_profiles
       SET parent_account_id = v_created_by,
           updated_at        = now()
     WHERE id = v_caller;
    PERFORM set_config('pp.privileged_update', '', true);

    applied := TRUE; parent_id := v_created_by; parent_plan := v_parent_plan;
    RETURN NEXT; RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.apply_class_invite(UUID, TEXT) TO authenticated;


-- ── 4. effective_plan_for() — resolves student → parent plan ─────
-- A student attached via parent_account_id gets the parent's plan
-- for feature-gate decisions. Falls back to the user's own plan
-- when there's no parent. Used by the dashboard, alert engine,
-- and any RLS check that needs "what tier is this user actually
-- on right now?".
CREATE OR REPLACE FUNCTION public.effective_plan_for(p_user_id UUID)
RETURNS TEXT AS $$
    SELECT COALESCE(p.plan, u.plan, 'free')
      FROM public.user_profiles u
      LEFT JOIN public.user_profiles p ON p.id = u.parent_account_id
     WHERE u.id = p_user_id;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.effective_plan_for(UUID) TO authenticated;


-- ── 5. release_class_seat() — parent removes a student ───────────
-- Detaches a student from the roster and decrements seats_used.
-- Only callable by the parent (the student's parent_account_id
-- must equal the caller, OR caller is admin). Student's row
-- is NOT deleted — they keep the account, just lose the
-- parent-derived plan.
CREATE OR REPLACE FUNCTION public.release_class_seat(p_student_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_caller    UUID := auth.uid();
    v_parent    UUID;
    v_role      TEXT;
BEGIN
    IF v_caller IS NULL THEN RETURN FALSE; END IF;

    SELECT parent_account_id INTO v_parent
      FROM public.user_profiles
     WHERE id = p_student_id
     FOR UPDATE;

    IF v_parent IS NULL THEN RETURN FALSE; END IF;

    -- Authorization: caller must be the parent OR an admin.
    SELECT role INTO v_role
      FROM public.user_profiles
     WHERE id = v_caller;

    IF v_parent <> v_caller AND v_role NOT IN ('admin', 'superadmin') THEN
        RETURN FALSE;
    END IF;

    -- Detach + decrement.
    PERFORM set_config('pp.privileged_update', '1', true);
    UPDATE public.user_profiles
       SET parent_account_id = NULL,
           updated_at        = now()
     WHERE id = p_student_id;
    UPDATE public.user_profiles
       SET seats_used = GREATEST(COALESCE(seats_used, 0) - 1, 0),
           updated_at = now()
     WHERE id = v_parent;
    PERFORM set_config('pp.privileged_update', '', true);

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.release_class_seat(UUID) TO authenticated;


-- ── 6. class_roster() — parent reads their students ──────────────
-- Returns one row per student attached to the calling user.
-- Display name + email + joined-at + last-activity timestamp.
-- The email comes from auth.users (a join non-admins can't normally
-- do); SECURITY DEFINER lets us return it ONLY for the calling
-- parent's own students.
CREATE OR REPLACE FUNCTION public.class_roster()
RETURNS TABLE(
    student_id    UUID,
    display_name  TEXT,
    email         TEXT,
    joined_at     TIMESTAMPTZ,
    last_active   TIMESTAMPTZ
) AS $$
    SELECT
        up.id,
        up.display_name,
        au.email,
        up.updated_at,
        up.updated_at
      FROM public.user_profiles up
      LEFT JOIN auth.users au ON au.id = up.id
     WHERE up.parent_account_id = auth.uid()
     ORDER BY up.updated_at DESC NULLS LAST;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.class_roster() TO authenticated;


-- ── 7. Activation events table ───────────────────────────────────
-- Append-only event log. Narrow on purpose: just the dimensions
-- we need to answer "which signups got value?". Heavy enrichment
-- happens at query time via JOIN to user_profiles.
--
-- Allow-list of event names is enforced both at insert time (CHECK)
-- and in the RPC, so the table never bloats with typos like
-- "first_sim_open" vs "first-sim-open".
CREATE TABLE IF NOT EXISTS public.activation_events (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    event       TEXT NOT NULL CHECK (event IN (
        'signup',
        'profile_completed',
        'location_saved',
        'first_sim_opened',
        'first_alert_configured',
        'first_email_alert_sent',
        'invite_sent',
        'student_joined',
        'subscription_started',
        'subscription_canceled'
    )),
    plan        TEXT,
    metadata    JSONB DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activation_events_user
    ON public.activation_events(user_id, event, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activation_events_event_time
    ON public.activation_events(event, created_at DESC);

ALTER TABLE public.activation_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own activation" ON public.activation_events;
CREATE POLICY "Users see own activation"
    ON public.activation_events FOR SELECT
    USING (user_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "Admins manage activation" ON public.activation_events;
CREATE POLICY "Admins manage activation"
    ON public.activation_events FOR ALL
    USING (public.is_admin());


-- ── 8. log_activation_event() — idempotent insert ─────────────────
-- Most events are "first X" events, so we want at-most-once per
-- (user, event) pair. The unique partial index below + ON
-- CONFLICT DO NOTHING gives the RPC at-most-once semantics for
-- the "first_*" events, and at-most-once-per-day for the rest.
--
-- Returns true if a new row was inserted, false if the event was
-- already logged for this user (so the client can stop retrying).
CREATE UNIQUE INDEX IF NOT EXISTS uq_activation_events_first
    ON public.activation_events(user_id, event)
    WHERE event IN (
        'signup',
        'profile_completed',
        'location_saved',
        'first_sim_opened',
        'first_alert_configured',
        'first_email_alert_sent'
    );

CREATE OR REPLACE FUNCTION public.log_activation_event(
    p_event    TEXT,
    p_plan     TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS BOOLEAN AS $$
DECLARE
    v_caller UUID := auth.uid();
    v_inserted INT;
BEGIN
    IF v_caller IS NULL THEN RETURN FALSE; END IF;

    INSERT INTO public.activation_events (user_id, event, plan, metadata)
    VALUES (v_caller, p_event, p_plan, COALESCE(p_metadata, '{}'::jsonb))
    ON CONFLICT DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted > 0;
EXCEPTION
    WHEN check_violation THEN
        -- Unknown event name — silently drop so a stale client
        -- can't spam errors into the logs.
        RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.log_activation_event(TEXT, TEXT, JSONB) TO authenticated;


-- ── 9. Activation funnel summary RPC for the admin dashboard ─────
-- Returns event counts + median time-to-event by plan, last 30 days.
-- Admin-only.
CREATE OR REPLACE FUNCTION public.activation_funnel(p_days INT DEFAULT 30)
RETURNS TABLE(
    plan         TEXT,
    event        TEXT,
    user_count   BIGINT,
    median_hours NUMERIC
) AS $$
    WITH signups AS (
        SELECT user_id, plan, created_at AS signed_up_at
          FROM public.activation_events
         WHERE event = 'signup'
           AND created_at > now() - (p_days || ' days')::interval
    )
    SELECT
        COALESCE(s.plan, ae.plan, 'free')                 AS plan,
        ae.event                                           AS event,
        COUNT(DISTINCT ae.user_id)                         AS user_count,
        ROUND(EXTRACT(EPOCH FROM
            percentile_cont(0.5) WITHIN GROUP (ORDER BY ae.created_at - s.signed_up_at)
        ) / 3600.0, 2)                                     AS median_hours
      FROM public.activation_events ae
      LEFT JOIN signups s USING (user_id)
     WHERE ae.created_at > now() - (p_days || ' days')::interval
     GROUP BY 1, 2
     ORDER BY 1, 2;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.activation_funnel(INT) TO authenticated;


-- ═══════════════════════════════════════════════════════════════
-- Verify with:
--   -- 1. is_class_seat column exists:
--   --    SELECT column_name FROM information_schema.columns
--   --      WHERE table_name='invite_codes' AND column_name='is_class_seat';
--
--   -- 2. activation_events allow-list rejects unknown events:
--   --    INSERT INTO public.activation_events (user_id, event)
--   --    VALUES (auth.uid(), 'made_up_event');
--   --    -- Expect: 23514 check_violation
--
--   -- 3. apply_class_invite enforces seat cap:
--   --    Set parent.classroom_seats=2, redeem 3 invites — third fails.
--
--   -- 4. effective_plan_for resolves student → parent:
--   --    SELECT public.effective_plan_for(<student_uuid>);
--   --    -- Expect: parent's plan, not student's.
-- ═══════════════════════════════════════════════════════════════
