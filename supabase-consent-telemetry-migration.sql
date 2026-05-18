-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — consent telemetry + opt-in rate
-- Run in Supabase Dashboard → SQL Editor → New Query (idempotent).
-- ═══════════════════════════════════════════════════════════════
--
-- Why this exists
-- ---------------
-- Every consent-gated KPI on the admin dashboard (Visitors, Sign-ins,
-- Minutes, GA4 …) is a *lower bound*: events only fire after a visitor
-- accepts the analytics cookie. Nobody knew the size of that gap.
-- js/cookie-consent.js now records two anonymous-safe signals through
-- the existing client_telemetry pipeline:
--
--   kind='consent', metadata.event = 'prompt_shown'  (banner displayed)
--   kind='consent', metadata.event = 'decision'      (user chose)
--       metadata: { analytics:0|1, functional:0|1,
--                   action:'accept_all'|'reject'|'save', gpc:0|1 }
--
-- These carry no PII / fingerprint / IP — same first-party operational
-- justification as the auth funnel. Measuring the consent decision
-- cannot itself be gated behind consent.
--
-- This migration does three things, all idempotent:
--   1. Widen client_telemetry_kind_check to allow 'consent'.
--   2. Refresh log_client_telemetry()'s in-RPC whitelist to match
--      (the schema-drift guard from ANALYTICS.md — CHECK and whitelist
--      must move together or the RPC silently drops every consent row).
--   3. Add consent_optin_rate(p_days) for the admin KPI.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Widen the kind CHECK constraint ─────────────────────────
-- Postgres can't ALTER a CHECK in place; drop + re-add with the full
-- list (every existing kind MUST be repeated or existing rows' inserts
-- start failing) plus 'consent'.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'client_telemetry'
          AND constraint_name = 'client_telemetry_kind_check'
    ) THEN
        ALTER TABLE public.client_telemetry
            DROP CONSTRAINT client_telemetry_kind_check;
    END IF;
END$$;

ALTER TABLE public.client_telemetry
    ADD CONSTRAINT client_telemetry_kind_check
    CHECK (kind IN (
        'error',
        'auth_failure',
        'not_found',
        'redirect',
        'web_vital',
        'app_perf',
        'auth_funnel',
        'consent'        -- NEW: cookie-consent prompt impressions + decisions
    ));


-- ── 2. Refresh log_client_telemetry() whitelist ────────────────
-- Faithful reproduction of the current body (last defined in
-- supabase-auth-funnel-migration.sql); the ONLY change is adding
-- 'consent' to the v_kind IN (...) gate.
CREATE OR REPLACE FUNCTION public.log_client_telemetry(
    p_events JSONB,
    p_user_id UUID DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
    v_event JSONB;
    v_inserted INTEGER := 0;
    v_kind TEXT;
    v_severity TEXT;
    v_route TEXT;
    v_session_id TEXT;
    v_metadata JSONB;
BEGIN
    IF jsonb_typeof(p_events) <> 'array' THEN
        RAISE EXCEPTION 'p_events must be a JSONB array' USING ERRCODE = '22023';
    END IF;

    FOR v_event IN SELECT * FROM jsonb_array_elements(p_events)
    LOOP
        v_kind := v_event->>'kind';
        IF v_kind NOT IN (
            'error','auth_failure','not_found','redirect',
            'web_vital','app_perf','auth_funnel','consent'
        ) THEN
            CONTINUE;
        END IF;

        v_severity := COALESCE(v_event->>'severity', 'info');
        IF v_severity NOT IN ('info','warning','error') THEN
            v_severity := 'info';
        END IF;

        v_route := LEFT(COALESCE(v_event->>'route', ''), 256);
        IF v_route = '' THEN v_route := NULL; END IF;

        v_session_id := LEFT(COALESCE(v_event->>'session_id', ''), 64);
        IF v_session_id = '' THEN v_session_id := NULL; END IF;

        v_metadata := COALESCE(v_event->'metadata', '{}'::jsonb);
        IF length(v_metadata::text) > 4096 THEN
            v_metadata := jsonb_build_object(
                'truncated', true,
                'original_size', length(v_metadata::text),
                'fingerprint', COALESCE(v_metadata->>'fingerprint', 'unknown'),
                'message', LEFT(COALESCE(v_metadata->>'message', ''), 256)
            );
        END IF;

        INSERT INTO public.client_telemetry
            (kind, severity, route, user_id, session_id, metadata)
        VALUES
            (v_kind, v_severity, v_route, p_user_id, v_session_id, v_metadata);
        v_inserted := v_inserted + 1;
    END LOOP;

    RETURN v_inserted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.log_client_telemetry(JSONB, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_client_telemetry(JSONB, UUID) TO service_role;


-- ── 3. consent_optin_rate(p_days) ──────────────────────────────
-- One row of aggregate counters + derived rates. Admin-gated (matches
-- analytics_unique_counts) so the KPI can render for admins, not just
-- superadmins — it's the correction factor for the Overview cards.
--
--   prompts            consent prompts shown
--   decisions          prompts that produced a choice
--   analytics_opt_in   decisions that allowed analytics
--   functional_opt_in  decisions that allowed functional
--   optin_rate         analytics_opt_in / decisions          (0..1)
--   engagement_rate    decisions / prompts                    (0..1)
--
-- optin_rate is the multiplier: a consent-gated KPI of N reflects
-- roughly N / optin_rate real events. NULLIF guards divide-by-zero
-- (no prompts/decisions yet → NULL, rendered as "—" client-side).
CREATE OR REPLACE FUNCTION public.consent_optin_rate(p_days INT DEFAULT 30)
RETURNS TABLE(
    prompts            BIGINT,
    decisions          BIGINT,
    analytics_opt_in   BIGINT,
    functional_opt_in  BIGINT,
    optin_rate         NUMERIC,
    engagement_rate    NUMERIC
) AS $$
DECLARE
    v_since TIMESTAMPTZ;
    v_prompts   BIGINT;
    v_decisions BIGINT;
    v_an        BIGINT;
    v_fn        BIGINT;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'consent_optin_rate: admin only';
    END IF;

    p_days  := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
    v_since := now() - (p_days || ' days')::interval;

    SELECT
        COUNT(*) FILTER (WHERE metadata->>'event' = 'prompt_shown'),
        COUNT(*) FILTER (WHERE metadata->>'event' = 'decision'),
        COUNT(*) FILTER (WHERE metadata->>'event' = 'decision'
                           AND metadata->>'analytics' = '1'),
        COUNT(*) FILTER (WHERE metadata->>'event' = 'decision'
                           AND metadata->>'functional' = '1')
      INTO v_prompts, v_decisions, v_an, v_fn
      FROM public.client_telemetry
     WHERE kind = 'consent'
       AND created_at > v_since;

    RETURN QUERY SELECT
        v_prompts,
        v_decisions,
        v_an,
        v_fn,
        ROUND(v_an::numeric      / NULLIF(v_decisions, 0), 4),
        ROUND(v_decisions::numeric / NULLIF(v_prompts,  0), 4);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION public.consent_optin_rate(INT) TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Smoke test (run after applying, as an admin user):
--
--   SELECT * FROM public.consent_optin_rate(30);
--
-- Expect one row. Before any traffic: prompts/decisions = 0,
-- optin_rate / engagement_rate = NULL.
-- ═══════════════════════════════════════════════════════════════
