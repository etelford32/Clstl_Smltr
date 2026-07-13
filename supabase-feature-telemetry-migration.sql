-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — feature-interaction telemetry kind
-- Run in Supabase Dashboard → SQL Editor → New Query (idempotent).
-- ═══════════════════════════════════════════════════════════════
--
-- Why this exists
-- ---------------
-- The EarthView verdict card (earth.html) ships with product-success
-- instrumentation: impressions, CTA clicks, chip taps, Explore-rate.
-- js/telemetry.js gained recordFeature(feature, action, meta), which
-- emits through the existing client_telemetry pipeline as:
--
--   kind='feature', metadata = { feature:'verdict_card',
--                                action:'impression'|'cta_alert'|'explore'
--                                       |'chip'|'day_tap'|'feed_degraded'|…,
--                                ...action-specific fields }
--
-- No PII, no fingerprint — same anonymous-write justification as the
-- auth funnel. 100% sampled; volume is bounded by explicit user
-- interactions.
--
-- This migration does two things, both idempotent (same shape as
-- supabase-consent-telemetry-migration.sql / the cloud-pipeline one):
--   1. Widen client_telemetry_kind_check to allow 'feature'.
--   2. Refresh log_client_telemetry()'s in-RPC whitelist to match
--      (CHECK and whitelist must move together or the RPC silently
--      drops every feature row — the schema-drift guard from
--      ANALYTICS.md).
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Widen the kind CHECK constraint ─────────────────────────
-- Postgres can't ALTER a CHECK in place; drop + re-add with the full
-- list (every existing kind MUST be repeated or existing rows' inserts
-- start failing) plus 'feature'.
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
        'consent',
        'data_pipeline',
        'feature'         -- NEW: product-feature interactions (verdict card)
    ));


-- ── 2. Refresh log_client_telemetry() whitelist ────────────────
-- Faithful reproduction of the current body (last defined in
-- supabase-cloud-pipeline-telemetry-migration.sql; verified against the
-- live definition on 2026-07-13); the ONLY change is adding 'feature'
-- to the v_kind IN (...) gate.
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
            'web_vital','app_perf','auth_funnel','consent','data_pipeline',
            'feature'
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

-- ═══════════════════════════════════════════════════════════════
-- Smoke test (run after applying):
--
--   SELECT public.log_client_telemetry(
--     '[{"kind":"feature","metadata":{"feature":"verdict_card","action":"smoke"}}]'::jsonb
--   );
--
-- Expect 1. Then:
--   SELECT kind, metadata FROM public.client_telemetry
--    WHERE kind='feature' ORDER BY created_at DESC LIMIT 1;
-- ═══════════════════════════════════════════════════════════════
