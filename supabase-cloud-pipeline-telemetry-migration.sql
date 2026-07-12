-- supabase-cloud-pipeline-telemetry-migration.sql
-- ─────────────────────────────────────────────────────────────────────
-- Adds the 'data_pipeline' telemetry kind: client-side data-pipeline
-- outcome events (cloud mosaic refreshes, feed fallback chains).
-- Emitted by js/telemetry.js recordPipeline(), first consumer is the
-- GIBS cloud mosaic (js/satellite-feed.js → name 'cloud_mosaic').
--
-- Follows the exact widening pattern established by
-- supabase-auth-funnel-migration.sql and
-- supabase-consent-telemetry-migration.sql: the kind CHECK constraint and
-- the log_client_telemetry() in-RPC whitelist MUST move together,
-- otherwise the RPC silently CONTINUEs past every data_pipeline event the
-- edge function forwards. The whitelist below is the FULL current set
-- (including 'consent' from the consent migration) plus 'data_pipeline' —
-- a widening migration must always restate every kind that's live.
-- ─────────────────────────────────────────────────────────────────────

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
        'data_pipeline'   -- NEW: client data-pipeline outcomes (cloud mosaic, feeds)
    ));

-- Mirror the constraint widening into log_client_telemetry()'s in-RPC
-- whitelist. Body otherwise identical to the consent migration's
-- definition — keep future widenings this mechanical.
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
            'web_vital','app_perf','auth_funnel','consent','data_pipeline'
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
