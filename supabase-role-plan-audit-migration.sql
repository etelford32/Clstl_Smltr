-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Role / plan / Stripe-link audit migration
-- ═══════════════════════════════════════════════════════════════
--
-- Run in Supabase Dashboard → SQL Editor → New Query (idempotent).
--
-- Adds:
--   1. is_superadmin() helper            — distinguishes superadmin from admin
--   2. user_profiles_audit table         — every change to a tracked column
--   3. AFTER UPDATE/INSERT/DELETE trigger on user_profiles
--   4. promote_user(p_user_id, p_role)   — admin/superadmin role mutation
--   5. set_user_plan_override(p_user_id, p_plan, p_reason)
--                                          superadmin-only manual plan grant
--   6. recent_role_audit(p_limit)        — superadmin-only read RPC
--
-- Why this exists:
--   * The plan-lockdown migration blocks self-mutation of role/plan but
--     leaves no audit trail when service_role / Stripe webhook / future
--     admin RPC mutates them. With Stripe roles + comp accounts in play
--     we need a forensic record of who changed what, when, and why.
--   * superadmin minting stays SQL-only (no UI path) so a compromised
--     admin can't escalate. Every UI mutation runs through the audited
--     RPCs.
--
-- Idempotent — safe to re-run. Doesn't backfill historical changes
-- (the audit table starts empty by design — new changes only).
-- ═══════════════════════════════════════════════════════════════


-- ── 1. is_superadmin() helper ────────────────────────────────────────
-- Mirrors the existing is_admin() / is_tester() pattern. SECURITY
-- DEFINER + STABLE so RLS policies can call it without permission
-- recursion. Returns FALSE when auth.uid() is NULL (anon, service_role
-- bypassing RLS at the SQL Editor level).
CREATE OR REPLACE FUNCTION public.is_superadmin()
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = auth.uid() AND role = 'superadmin'
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;


-- ── 2. Audit table ──────────────────────────────────────────────────
-- One row per UPDATE statement that touches a tracked column, plus
-- one row each on INSERT (signup) and DELETE (account wipe). The
-- changed_columns array makes it cheap to filter ("show me all role
-- changes in the last 30 days") without parsing JSONB diffs.
--
-- Tracked columns are the four privilege-bearing buckets:
--   * role
--   * plan
--   * subscription_status / subscription_period_end
--   * stripe_customer_id / stripe_subscription_id / stripe_price_id
-- A change to any of those captures a row. Edits to display_name,
-- notification preferences, etc. are NOT logged here — they're not
-- privilege-bearing.
CREATE TABLE IF NOT EXISTS public.user_profiles_audit (
    id              BIGSERIAL PRIMARY KEY,
    target_user_id  UUID NOT NULL,                          -- the row that was changed
    changed_by_uid  UUID,                                   -- the actor (NULL for service_role / SQL Editor)
    changed_by_role TEXT,                                   -- captured at change time so demotion-after-the-fact stays attributable
    operation       TEXT NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
    source          TEXT NOT NULL CHECK (source IN (
                        'trigger',                          -- caught by the column trigger
                        'rpc_promote_user',                 -- explicit role-change RPC
                        'rpc_set_user_plan_override',       -- explicit plan-override RPC
                        'stripe_webhook',                   -- Stripe webhook (sets jwt_claim before mutating)
                        'system'                            -- bootstrap / migration (default catch-all)
                    )),
    changed_columns TEXT[] NOT NULL DEFAULT '{}',           -- e.g. {plan, subscription_status}
    old_values      JSONB,                                  -- only the changed columns, NULL for INSERT
    new_values      JSONB,                                  -- only the changed columns, NULL for DELETE
    reason          TEXT,                                   -- required for plan overrides; NULL for trigger-captured
    request_origin  TEXT,                                   -- e.g. PostgREST gateway / SQL Editor (best-effort)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_audit_target
    ON public.user_profiles_audit (target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_profiles_audit_actor
    ON public.user_profiles_audit (changed_by_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_profiles_audit_recent
    ON public.user_profiles_audit (created_at DESC);


-- ── 3. RLS — superadmin reads only; INSERT only via SECURITY DEFINER ──
ALTER TABLE public.user_profiles_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Superadmin can view audit log"  ON public.user_profiles_audit;
CREATE POLICY "Superadmin can view audit log"
    ON public.user_profiles_audit FOR SELECT
    USING (public.is_superadmin());

-- No INSERT/UPDATE/DELETE policies — all writes go through SECURITY
-- DEFINER functions. service_role bypasses RLS so the trigger below
-- can write regardless. Direct anon/authenticated writes are denied
-- by the absence of a permissive policy.


-- ── 4. AFTER trigger — captures every change to tracked columns ──────
-- Sits AFTER the existing BEFORE-UPDATE lockdown trigger
-- (lock_user_profile_protected_columns) so we only audit changes that
-- the lockdown ALLOWED through. service_role and the audited RPCs both
-- pass through the lockdown; everyone else is rejected before reaching
-- this trigger.
CREATE OR REPLACE FUNCTION public.audit_user_profile_changes()
RETURNS TRIGGER AS $$
DECLARE
    v_changed       TEXT[] := '{}';
    v_old           JSONB  := '{}'::jsonb;
    v_new           JSONB  := '{}'::jsonb;
    v_actor_uid     UUID;
    v_actor_role    TEXT;
    v_source        TEXT;
    v_reason        TEXT;
    v_origin        TEXT;
BEGIN
    -- Pull the actor + override hint set by the SECURITY DEFINER RPCs.
    -- Both are best-effort: NULL when called from service_role / SQL Editor.
    BEGIN v_actor_uid := auth.uid();                                    EXCEPTION WHEN OTHERS THEN v_actor_uid := NULL;  END;
    BEGIN v_actor_role := current_setting('request.jwt.claims', true)::jsonb->>'role'; EXCEPTION WHEN OTHERS THEN v_actor_role := NULL; END;
    BEGIN v_source     := current_setting('app.audit_source', true);    EXCEPTION WHEN OTHERS THEN v_source := NULL;     END;
    BEGIN v_reason     := current_setting('app.audit_reason', true);    EXCEPTION WHEN OTHERS THEN v_reason := NULL;     END;
    BEGIN v_origin     := current_setting('request.headers', true)::jsonb->>'host'; EXCEPTION WHEN OTHERS THEN v_origin := NULL; END;

    IF v_source IS NULL OR v_source = '' THEN
        v_source := CASE
            WHEN v_actor_role = 'service_role' THEN 'system'
            ELSE 'trigger'
        END;
    END IF;

    -- Per-operation diff.
    IF (TG_OP = 'INSERT') THEN
        v_new := jsonb_build_object(
            'role', NEW.role,
            'plan', NEW.plan,
            'subscription_status', NEW.subscription_status,
            'subscription_period_end', NEW.subscription_period_end,
            'stripe_customer_id', NEW.stripe_customer_id,
            'stripe_subscription_id', NEW.stripe_subscription_id,
            'stripe_price_id', NEW.stripe_price_id
        );
        v_changed := ARRAY['__insert__'];

        INSERT INTO public.user_profiles_audit (
            target_user_id, changed_by_uid, changed_by_role,
            operation, source, changed_columns,
            old_values, new_values, reason, request_origin
        ) VALUES (
            NEW.id, v_actor_uid, v_actor_role,
            'INSERT', v_source, v_changed,
            NULL, v_new, v_reason, v_origin
        );
        RETURN NEW;
    END IF;

    IF (TG_OP = 'DELETE') THEN
        v_old := jsonb_build_object(
            'role', OLD.role,
            'plan', OLD.plan,
            'subscription_status', OLD.subscription_status,
            'subscription_period_end', OLD.subscription_period_end,
            'stripe_customer_id', OLD.stripe_customer_id,
            'stripe_subscription_id', OLD.stripe_subscription_id,
            'stripe_price_id', OLD.stripe_price_id
        );
        v_changed := ARRAY['__delete__'];

        INSERT INTO public.user_profiles_audit (
            target_user_id, changed_by_uid, changed_by_role,
            operation, source, changed_columns,
            old_values, new_values, reason, request_origin
        ) VALUES (
            OLD.id, v_actor_uid, v_actor_role,
            'DELETE', v_source, v_changed,
            v_old, NULL, v_reason, v_origin
        );
        RETURN OLD;
    END IF;

    -- TG_OP = 'UPDATE': only audit if a tracked column actually changed.
    IF NEW.role IS DISTINCT FROM OLD.role THEN
        v_changed := array_append(v_changed, 'role');
        v_old := v_old || jsonb_build_object('role', OLD.role);
        v_new := v_new || jsonb_build_object('role', NEW.role);
    END IF;
    IF NEW.plan IS DISTINCT FROM OLD.plan THEN
        v_changed := array_append(v_changed, 'plan');
        v_old := v_old || jsonb_build_object('plan', OLD.plan);
        v_new := v_new || jsonb_build_object('plan', NEW.plan);
    END IF;
    IF NEW.subscription_status IS DISTINCT FROM OLD.subscription_status THEN
        v_changed := array_append(v_changed, 'subscription_status');
        v_old := v_old || jsonb_build_object('subscription_status', OLD.subscription_status);
        v_new := v_new || jsonb_build_object('subscription_status', NEW.subscription_status);
    END IF;
    IF NEW.subscription_period_end IS DISTINCT FROM OLD.subscription_period_end THEN
        v_changed := array_append(v_changed, 'subscription_period_end');
        v_old := v_old || jsonb_build_object('subscription_period_end', OLD.subscription_period_end);
        v_new := v_new || jsonb_build_object('subscription_period_end', NEW.subscription_period_end);
    END IF;
    IF NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id THEN
        v_changed := array_append(v_changed, 'stripe_customer_id');
        v_old := v_old || jsonb_build_object('stripe_customer_id', OLD.stripe_customer_id);
        v_new := v_new || jsonb_build_object('stripe_customer_id', NEW.stripe_customer_id);
    END IF;
    IF NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id THEN
        v_changed := array_append(v_changed, 'stripe_subscription_id');
        v_old := v_old || jsonb_build_object('stripe_subscription_id', OLD.stripe_subscription_id);
        v_new := v_new || jsonb_build_object('stripe_subscription_id', NEW.stripe_subscription_id);
    END IF;
    IF NEW.stripe_price_id IS DISTINCT FROM OLD.stripe_price_id THEN
        v_changed := array_append(v_changed, 'stripe_price_id');
        v_old := v_old || jsonb_build_object('stripe_price_id', OLD.stripe_price_id);
        v_new := v_new || jsonb_build_object('stripe_price_id', NEW.stripe_price_id);
    END IF;

    IF array_length(v_changed, 1) IS NULL THEN
        RETURN NEW;  -- nothing tracked changed; skip the audit row entirely
    END IF;

    INSERT INTO public.user_profiles_audit (
        target_user_id, changed_by_uid, changed_by_role,
        operation, source, changed_columns,
        old_values, new_values, reason, request_origin
    ) VALUES (
        NEW.id, v_actor_uid, v_actor_role,
        'UPDATE', v_source, v_changed,
        v_old, v_new, v_reason, v_origin
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_audit_user_profile_changes ON public.user_profiles;
CREATE TRIGGER trg_audit_user_profile_changes
    AFTER INSERT OR UPDATE OR DELETE ON public.user_profiles
    FOR EACH ROW EXECUTE FUNCTION public.audit_user_profile_changes();


-- ── 5. Patch the existing lockdown trigger to honour the audited RPCs ─
-- The original lockdown blocks plan/role/stripe_* changes from anyone
-- but service_role. We extend it so an authenticated request that has
-- explicitly opted in (via SET LOCAL app.allow_protected_update = 'true'
-- inside an audited RPC) is also allowed through. Outside of that path,
-- the lockdown is unchanged.
CREATE OR REPLACE FUNCTION public.lock_user_profile_protected_columns()
RETURNS TRIGGER AS $$
DECLARE
    caller_role         TEXT;
    explicit_allow      TEXT;
BEGIN
    caller_role := current_setting('request.jwt.claims', true)::jsonb->>'role';

    -- service_role + the rare "no JWT at all" admin-script path: bypass.
    IF caller_role = 'service_role' OR caller_role IS NULL THEN
        RETURN NEW;
    END IF;

    -- Audited-RPC bypass — the RPC body sets this flag inside the same
    -- transaction. The flag clears at COMMIT/ROLLBACK so it can't leak
    -- to subsequent statements on the same connection.
    BEGIN explicit_allow := current_setting('app.allow_protected_update', true);
    EXCEPTION WHEN OTHERS THEN explicit_allow := NULL; END;
    IF explicit_allow = 'true' THEN
        RETURN NEW;
    END IF;

    IF NEW.plan IS DISTINCT FROM OLD.plan THEN
        RAISE EXCEPTION 'protected_column: user_profiles.plan is managed by the Stripe webhook'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.role IS DISTINCT FROM OLD.role THEN
        RAISE EXCEPTION 'protected_column: user_profiles.role is managed by service_role only'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.stripe_customer_id     IS DISTINCT FROM OLD.stripe_customer_id
       OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
       OR NEW.stripe_price_id        IS DISTINCT FROM OLD.stripe_price_id
       OR NEW.subscription_status    IS DISTINCT FROM OLD.subscription_status
       OR NEW.subscription_period_end IS DISTINCT FROM OLD.subscription_period_end
    THEN
        RAISE EXCEPTION 'protected_column: stripe_* fields are managed by the Stripe webhook'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ── 6. promote_user(p_user_id, p_new_role) ───────────────────────────
-- Role mutation RPC. Two callers:
--   * admin       → may set role IN ('user', 'tester') only.
--                   Cannot touch other admins. Cannot promote to admin.
--   * superadmin  → may set role IN ('user', 'tester', 'admin').
--                   Cannot mint new superadmins (SQL Editor only).
--                   Cannot demote themselves (last-superadmin guard).
--
-- Audit row is written by the AFTER trigger; this function just sets
-- the source/reason settings so the trigger captures attribution.
CREATE OR REPLACE FUNCTION public.promote_user(
    p_user_id   UUID,
    p_new_role  TEXT,
    p_reason    TEXT DEFAULT NULL
)
RETURNS TABLE (id UUID, role TEXT, updated_at TIMESTAMPTZ) AS $$
DECLARE
    v_caller_uid   UUID := auth.uid();
    v_caller_role  TEXT;
    v_target_role  TEXT;
    v_remaining_sa INTEGER;
BEGIN
    IF v_caller_uid IS NULL THEN
        RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
    END IF;

    SELECT up.role INTO v_caller_role
        FROM public.user_profiles up WHERE up.id = v_caller_uid;
    SELECT up.role INTO v_target_role
        FROM public.user_profiles up WHERE up.id = p_user_id;
    IF v_target_role IS NULL THEN
        RAISE EXCEPTION 'target user not found' USING ERRCODE = 'P0002';
    END IF;

    -- Only admins and superadmins can call.
    IF v_caller_role NOT IN ('admin', 'superadmin') THEN
        RAISE EXCEPTION 'forbidden: caller is not admin/superadmin'
            USING ERRCODE = '42501';
    END IF;

    -- Validate the requested role.
    IF p_new_role NOT IN ('user', 'tester', 'admin') THEN
        RAISE EXCEPTION 'invalid role: superadmin minting is SQL-only; allowed values are user, tester, admin'
            USING ERRCODE = '22023';
    END IF;

    -- Admin-scope: only user↔tester. Cannot touch admins/superadmins.
    IF v_caller_role = 'admin' THEN
        IF p_new_role NOT IN ('user', 'tester') THEN
            RAISE EXCEPTION 'forbidden: admin may only set role to user or tester'
                USING ERRCODE = '42501';
        END IF;
        IF v_target_role IN ('admin', 'superadmin') THEN
            RAISE EXCEPTION 'forbidden: admin may not demote another admin/superadmin'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    -- Superadmin-scope: cannot demote themselves if they are the last superadmin.
    IF v_caller_role = 'superadmin'
       AND p_user_id = v_caller_uid
       AND p_new_role <> 'superadmin' THEN
        SELECT COUNT(*) INTO v_remaining_sa
            FROM public.user_profiles WHERE role = 'superadmin';
        IF v_remaining_sa <= 1 THEN
            RAISE EXCEPTION 'forbidden: cannot self-demote — you are the last superadmin'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    -- No-op: return current state without touching the row.
    IF v_target_role = p_new_role THEN
        RETURN QUERY SELECT up.id, up.role, up.updated_at
            FROM public.user_profiles up WHERE up.id = p_user_id;
        RETURN;
    END IF;

    -- Mark the audit context so the AFTER trigger attributes correctly,
    -- then bypass the lockdown for this transaction only.
    PERFORM set_config('app.audit_source', 'rpc_promote_user', true);
    PERFORM set_config('app.audit_reason', COALESCE(p_reason, ''), true);
    PERFORM set_config('app.allow_protected_update', 'true', true);

    UPDATE public.user_profiles
       SET role = p_new_role, updated_at = now()
     WHERE id = p_user_id;

    -- Clear the override flag eagerly (also clears at COMMIT, but defensive).
    PERFORM set_config('app.allow_protected_update', 'false', true);

    RETURN QUERY SELECT up.id, up.role, up.updated_at
        FROM public.user_profiles up WHERE up.id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.promote_user(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.promote_user(UUID, TEXT, TEXT) TO authenticated;


-- ── 7. set_user_plan_override(p_user_id, p_plan, p_reason) ───────────
-- Superadmin-only manual plan grant. Reason required (10–500 chars).
-- Used for comp accounts that didn't go through the invite flow, or
-- corrective action when Stripe state diverges from intent.
--
-- Does NOT touch stripe_customer_id / subscription_status — those stay
-- under Stripe-webhook control. The override only flips the `plan`
-- column. If Stripe later sends a webhook update for the same user, it
-- can overwrite this — so use this only for users without a Stripe
-- subscription.
CREATE OR REPLACE FUNCTION public.set_user_plan_override(
    p_user_id  UUID,
    p_new_plan TEXT,
    p_reason   TEXT
)
RETURNS TABLE (id UUID, plan TEXT, updated_at TIMESTAMPTZ) AS $$
DECLARE
    v_caller_uid  UUID := auth.uid();
    v_caller_role TEXT;
    v_target      RECORD;
BEGIN
    IF v_caller_uid IS NULL THEN
        RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
    END IF;

    SELECT up.role INTO v_caller_role
        FROM public.user_profiles up WHERE up.id = v_caller_uid;
    IF v_caller_role IS DISTINCT FROM 'superadmin' THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;

    IF p_new_plan NOT IN ('free', 'basic', 'educator', 'advanced', 'institution', 'enterprise') THEN
        RAISE EXCEPTION 'invalid plan' USING ERRCODE = '22023';
    END IF;

    IF p_reason IS NULL OR length(btrim(p_reason)) < 10 OR length(p_reason) > 500 THEN
        RAISE EXCEPTION 'reason required (10–500 characters)' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_target FROM public.user_profiles WHERE user_profiles.id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'target user not found' USING ERRCODE = 'P0002';
    END IF;

    -- Refuse to override a user with an active Stripe subscription —
    -- that's a Stripe-side problem, not a manual override.
    IF v_target.stripe_subscription_id IS NOT NULL
       AND v_target.subscription_status IN ('active', 'trialing', 'past_due') THEN
        RAISE EXCEPTION 'refused: target has an active Stripe subscription (%) — cancel in Stripe first',
                        v_target.subscription_status
            USING ERRCODE = '0L000';  -- "invalid grantor" — closest fit
    END IF;

    PERFORM set_config('app.audit_source', 'rpc_set_user_plan_override', true);
    PERFORM set_config('app.audit_reason', p_reason, true);
    PERFORM set_config('app.allow_protected_update', 'true', true);

    UPDATE public.user_profiles
       SET plan = p_new_plan, updated_at = now()
     WHERE user_profiles.id = p_user_id;

    PERFORM set_config('app.allow_protected_update', 'false', true);

    RETURN QUERY SELECT up.id, up.plan, up.updated_at
        FROM public.user_profiles up WHERE up.id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.set_user_plan_override(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_user_plan_override(UUID, TEXT, TEXT) TO authenticated;


-- ── 8. recent_role_audit(p_limit) ────────────────────────────────────
-- Superadmin-only read RPC. Joins audit rows to user emails so the
-- dashboard table can show who-did-what without the client running its
-- own auth.users join (which RLS blocks anyway).
CREATE OR REPLACE FUNCTION public.recent_role_audit(p_limit INTEGER DEFAULT 100)
RETURNS TABLE (
    id              BIGINT,
    target_user_id  UUID,
    target_email    TEXT,
    changed_by_uid  UUID,
    changed_by_email TEXT,
    changed_by_role TEXT,
    operation       TEXT,
    source          TEXT,
    changed_columns TEXT[],
    old_values      JSONB,
    new_values      JSONB,
    reason          TEXT,
    created_at      TIMESTAMPTZ
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;

    p_limit := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000);

    RETURN QUERY
        SELECT a.id,
               a.target_user_id,
               tu.email AS target_email,
               a.changed_by_uid,
               cu.email AS changed_by_email,
               a.changed_by_role,
               a.operation,
               a.source,
               a.changed_columns,
               a.old_values,
               a.new_values,
               a.reason,
               a.created_at
          FROM public.user_profiles_audit a
     LEFT JOIN auth.users tu ON tu.id = a.target_user_id
     LEFT JOIN auth.users cu ON cu.id = a.changed_by_uid
      ORDER BY a.created_at DESC
         LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.recent_role_audit(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recent_role_audit(INTEGER) TO authenticated;


-- ── 9. list_users_for_admin(p_limit, p_offset) ───────────────────────
-- Admin/superadmin user-management listing. Returns role + plan for
-- every user, so the management UI can render the table without each
-- row firing its own RLS-checked query. is_admin() already gates
-- SELECT on user_profiles for admins, but joining auth.users for
-- email is RLS-blocked from the client — this RPC bridges the gap.
CREATE OR REPLACE FUNCTION public.list_users_for_admin(
    p_limit  INTEGER DEFAULT 200,
    p_offset INTEGER DEFAULT 0,
    p_search TEXT    DEFAULT NULL
)
RETURNS TABLE (
    id           UUID,
    email        TEXT,
    display_name TEXT,
    role         TEXT,
    plan         TEXT,
    subscription_status TEXT,
    created_at   TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ
) AS $$
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
    END IF;

    p_limit  := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
    p_offset := GREATEST(COALESCE(p_offset, 0), 0);

    RETURN QUERY
        SELECT up.id,
               up.email,
               up.display_name,
               up.role,
               up.plan,
               up.subscription_status,
               up.created_at,
               u.last_sign_in_at AS last_seen_at
          FROM public.user_profiles up
     LEFT JOIN auth.users u ON u.id = up.id
         WHERE p_search IS NULL
            OR up.email ILIKE '%' || p_search || '%'
            OR up.display_name ILIKE '%' || p_search || '%'
      ORDER BY up.created_at DESC
         LIMIT p_limit OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.list_users_for_admin(INTEGER, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_users_for_admin(INTEGER, INTEGER, TEXT) TO authenticated;


-- ═══════════════════════════════════════════════════════════════
-- Verification queries
-- ═══════════════════════════════════════════════════════════════
-- 1. is_superadmin() returns the correct boolean for the calling user:
--      SELECT public.is_superadmin();
--
-- 2. Self-mutation of role still blocked for normal users:
--      UPDATE public.user_profiles SET role='admin' WHERE id = auth.uid();
--    Expected: 42501 / "protected_column: user_profiles.role …"
--
-- 3. Admin promoting a user → tester succeeds and writes one audit row:
--      SELECT public.promote_user('<some-user-uuid>'::uuid, 'tester',
--             'evaluating educator features');
--      SELECT * FROM public.recent_role_audit(5);  -- as superadmin
--
-- 4. Admin attempting to promote to admin is rejected:
--      SELECT public.promote_user('<user-uuid>'::uuid, 'admin', 'why');
--    Expected (called as admin): 42501 "admin may only set role to user or tester"
--
-- 5. Superadmin self-demotion attempt blocked when they are the last:
--      SELECT public.promote_user(auth.uid(), 'admin', 'rotating');
--    Expected (only one superadmin): 42501 "last superadmin"
--
-- 6. set_user_plan_override requires reason ≥ 10 chars:
--      SELECT public.set_user_plan_override('<uuid>'::uuid, 'educator', 'short');
--    Expected: 22023 "reason required (10–500 characters)"
--
-- 7. set_user_plan_override on a Stripe-active user is refused:
--      Run on someone with subscription_status='active' — expect 0L000.
--
-- 8. Stripe webhook plan grant (service_role) still succeeds and
--    writes one audit row with source='system'.
-- ═══════════════════════════════════════════════════════════════
