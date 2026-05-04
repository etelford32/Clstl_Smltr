-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Client telemetry migration
-- ═══════════════════════════════════════════════════════════════
--
-- Run in Supabase Dashboard → SQL Editor → New Query (idempotent).
--
-- Adds a unified telemetry pipeline so superadmins can see:
--   * JS errors (uncaught exceptions, unhandled rejections)
--   * Auth failures (broader than the existing auth_failures table —
--     OAuth callback errors, session refresh failures, dashboard-gate
--     redirects, RLS denials)
--   * 404s (paths users tried to reach that don't exist)
--   * Web Vitals (LCP, FCP, CLS, INP) per route
--   * App-specific perf marks (WASM init time, dashboard mount, etc.)
--
-- One table with a typed `kind` column, four read RPCs for the admin
-- card top-N panels, an hourly pg_cron pruner, and a SECURITY DEFINER
-- writer RPC the edge function calls.
--
-- The existing `auth_failures` table stays in place — it captures
-- pre-auth signin attempts (no JWT) where the email is HMAC-hashed.
-- This new table captures everything else (post-auth or non-auth
-- failures) where the user_id is known or the event is anonymous but
-- non-PII.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.client_telemetry (
    id          BIGSERIAL PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN (
                    'error',          -- uncaught exception / unhandled rejection
                    'auth_failure',   -- post-auth or non-credential auth failure
                    'not_found',      -- 404.html load or broken-link click
                    'redirect',       -- requireAuth() bounced to signin
                    'web_vital',      -- LCP / FCP / CLS / INP
                    'app_perf'        -- custom mark (wasm_init, dashboard_mount, etc.)
                )),
    severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','error')),
    route       TEXT,                                       -- pathname only — query string stripped client-side
    user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    session_id  TEXT,                                       -- browser-generated, sessionStorage-scoped
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,         -- kind-specific payload (see below)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- metadata shape per kind (informational; not enforced):
--   error        → { fingerprint, message, stack (scrubbed), source, line, col }
--   auth_failure → { reason, provider?, code?, source: 'oauth_callback' | 'refresh' | ... }
--   not_found    → { referrer? }
--   redirect     → { from, to, reason }
--   web_vital    → { name: 'LCP'|'FCP'|'CLS'|'INP', value, rating: 'good'|'ni'|'poor' }
--   app_perf     → { name, value_ms }

-- Hot-path indexes — admin card queries always filter by kind + window
-- and group by metadata->>'fingerprint' (errors) or route (404s, vitals).
CREATE INDEX IF NOT EXISTS idx_client_telemetry_kind_time
    ON public.client_telemetry (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_telemetry_user
    ON public.client_telemetry (user_id, created_at DESC)
    WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_client_telemetry_route
    ON public.client_telemetry (route, kind, created_at DESC)
    WHERE route IS NOT NULL;
-- Errors deduplicate by fingerprint — separate functional index on the
-- JSONB key so the top-N query stays fast as the table grows.
CREATE INDEX IF NOT EXISTS idx_client_telemetry_error_fp
    ON public.client_telemetry ((metadata->>'fingerprint'), created_at DESC)
    WHERE kind = 'error';


-- ── 2. RLS — superadmin reads only; writes via SECURITY DEFINER RPC ──
ALTER TABLE public.client_telemetry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Superadmin can view client telemetry" ON public.client_telemetry;
CREATE POLICY "Superadmin can view client telemetry"
    ON public.client_telemetry FOR SELECT
    USING (public.is_superadmin());

-- No INSERT/UPDATE/DELETE policies — direct writes denied. The edge
-- function calls log_client_telemetry() with service_role, which
-- bypasses RLS. Pruner is service_role too.


-- ── 3. log_client_telemetry() — batched writer for the edge endpoint ─
-- Accepts an array of events as JSONB. Returns the number of rows
-- inserted. Edge function is responsible for rate-limiting + JWT
-- verification BEFORE calling this — the RPC trusts its inputs.
--
-- Why an RPC instead of letting the edge function INSERT directly?
-- Two reasons:
--   1. Bounds-check the kind/severity values server-side so a buggy
--      client can't insert garbage that breaks downstream queries.
--   2. Truncate over-long fields (route 256 chars, metadata 4 KB).
CREATE OR REPLACE FUNCTION public.log_client_telemetry(
    p_events JSONB,           -- array of event objects
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
        IF v_kind NOT IN ('error','auth_failure','not_found','redirect','web_vital','app_perf') THEN
            CONTINUE;  -- skip silently; one bad event shouldn't fail the batch
        END IF;

        v_severity := COALESCE(v_event->>'severity', 'info');
        IF v_severity NOT IN ('info','warning','error') THEN
            v_severity := 'info';
        END IF;

        v_route := LEFT(COALESCE(v_event->>'route', ''), 256);
        IF v_route = '' THEN v_route := NULL; END IF;

        v_session_id := LEFT(COALESCE(v_event->>'session_id', ''), 64);
        IF v_session_id = '' THEN v_session_id := NULL; END IF;

        -- Truncate over-large metadata payloads. 4 KB is plenty for a
        -- scrubbed stack + fingerprint; anything bigger is suspicious.
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
-- service_role only — granted via the edge function. authenticated
-- callers cannot invoke directly; they go through the rate-limited
-- /api/telemetry/log endpoint.
GRANT EXECUTE ON FUNCTION public.log_client_telemetry(JSONB, UUID) TO service_role;


-- ── 4. Read RPCs — top-N panels for the superadmin Telemetry tab ─────

-- 4a. Top-N JS error fingerprints in the window.
-- Returns count, first/last seen, sample message + stack for each
-- distinct fingerprint. Errors with NULL fingerprint are bucketed
-- together as "(unfingerprinted)".
CREATE OR REPLACE FUNCTION public.telemetry_top_errors(
    p_days  INTEGER DEFAULT 30,
    p_limit INTEGER DEFAULT 25
)
RETURNS TABLE (
    fingerprint    TEXT,
    occurrences    BIGINT,
    distinct_users BIGINT,
    distinct_routes BIGINT,
    first_seen     TIMESTAMPTZ,
    last_seen      TIMESTAMPTZ,
    sample_message TEXT,
    sample_route   TEXT,
    sample_stack   TEXT
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days  := LEAST(GREATEST(COALESCE(p_days, 30), 1), 180);
    p_limit := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 200);

    RETURN QUERY
        SELECT COALESCE(t.metadata->>'fingerprint', '(unfingerprinted)') AS fingerprint,
               COUNT(*)                                AS occurrences,
               COUNT(DISTINCT t.user_id)               AS distinct_users,
               COUNT(DISTINCT t.route)                 AS distinct_routes,
               MIN(t.created_at)                       AS first_seen,
               MAX(t.created_at)                       AS last_seen,
               (array_agg(t.metadata->>'message' ORDER BY t.created_at DESC))[1]   AS sample_message,
               (array_agg(t.route                ORDER BY t.created_at DESC))[1]   AS sample_route,
               (array_agg(t.metadata->>'stack'   ORDER BY t.created_at DESC))[1]   AS sample_stack
          FROM public.client_telemetry t
         WHERE t.kind = 'error'
           AND t.created_at > now() - (p_days || ' days')::interval
         GROUP BY 1
         ORDER BY occurrences DESC
         LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.telemetry_top_errors(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_top_errors(INTEGER, INTEGER) TO authenticated;


-- 4b. Top-N auth failure reasons in the window.
-- UNIONs the new client_telemetry auth_failure events WITH the
-- existing auth_failures table (signin failures), so the panel shows
-- a complete top-N across both pre-auth and post-auth failures.
CREATE OR REPLACE FUNCTION public.telemetry_top_auth_failures(
    p_days  INTEGER DEFAULT 30,
    p_limit INTEGER DEFAULT 15
)
RETURNS TABLE (
    reason          TEXT,
    source          TEXT,
    occurrences     BIGINT,
    distinct_actors BIGINT,
    last_seen       TIMESTAMPTZ
) AS $$
DECLARE
    v_has_auth_failures BOOLEAN := to_regclass('public.auth_failures') IS NOT NULL;
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days  := LEAST(GREATEST(COALESCE(p_days, 30), 1), 180);
    p_limit := LEAST(GREATEST(COALESCE(p_limit, 15), 1), 100);

    IF v_has_auth_failures THEN
        RETURN QUERY
        WITH combined AS (
            SELECT COALESCE(t.metadata->>'reason', '(no reason)')        AS reason,
                   COALESCE(t.metadata->>'source', 'client_telemetry')   AS source,
                   t.user_id::text                                       AS actor,
                   t.created_at
              FROM public.client_telemetry t
             WHERE t.kind = 'auth_failure'
               AND t.created_at > now() - (p_days || ' days')::interval
            UNION ALL
            SELECT COALESCE(af.reason, '(no reason)')                    AS reason,
                   'signin_endpoint'                                     AS source,
                   af.email_hash                                         AS actor,
                   af.created_at
              FROM public.auth_failures af
             WHERE af.created_at > now() - (p_days || ' days')::interval
        )
        SELECT c.reason,
               c.source,
               COUNT(*)                  AS occurrences,
               COUNT(DISTINCT c.actor)   AS distinct_actors,
               MAX(c.created_at)         AS last_seen
          FROM combined c
         GROUP BY 1, 2
         ORDER BY occurrences DESC
         LIMIT p_limit;
    ELSE
        RETURN QUERY
        SELECT COALESCE(t.metadata->>'reason', '(no reason)')        AS reason,
               COALESCE(t.metadata->>'source', 'client_telemetry')   AS source,
               COUNT(*)                  AS occurrences,
               COUNT(DISTINCT t.user_id::text) AS distinct_actors,
               MAX(t.created_at)         AS last_seen
          FROM public.client_telemetry t
         WHERE t.kind = 'auth_failure'
           AND t.created_at > now() - (p_days || ' days')::interval
         GROUP BY 1, 2
         ORDER BY occurrences DESC
         LIMIT p_limit;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.telemetry_top_auth_failures(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_top_auth_failures(INTEGER, INTEGER) TO authenticated;


-- 4c. Top-N 404 paths in the window.
CREATE OR REPLACE FUNCTION public.telemetry_top_404s(
    p_days  INTEGER DEFAULT 30,
    p_limit INTEGER DEFAULT 25
)
RETURNS TABLE (
    route       TEXT,
    occurrences BIGINT,
    distinct_sessions BIGINT,
    last_seen   TIMESTAMPTZ
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days  := LEAST(GREATEST(COALESCE(p_days, 30), 1), 180);
    p_limit := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 200);

    RETURN QUERY
        SELECT t.route,
               COUNT(*)                          AS occurrences,
               COUNT(DISTINCT t.session_id)      AS distinct_sessions,
               MAX(t.created_at)                 AS last_seen
          FROM public.client_telemetry t
         WHERE t.kind = 'not_found'
           AND t.created_at > now() - (p_days || ' days')::interval
           AND t.route IS NOT NULL
         GROUP BY t.route
         ORDER BY occurrences DESC
         LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.telemetry_top_404s(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_top_404s(INTEGER, INTEGER) TO authenticated;


-- 4d. Web Vitals + app perf summary — p50/p95 per metric per route.
-- Returns one row per (metric, route) pair with quantiles in ms.
-- LCP / FCP / INP / app_perf values are milliseconds; CLS is unitless
-- (multiplied by 1000 here so a single numeric column works).
CREATE OR REPLACE FUNCTION public.telemetry_perf_summary(
    p_days  INTEGER DEFAULT 7,
    p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
    metric_name TEXT,
    route       TEXT,
    samples     BIGINT,
    p50         NUMERIC,
    p95         NUMERIC,
    poor_count  BIGINT
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days  := LEAST(GREATEST(COALESCE(p_days, 7), 1), 90);
    p_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);

    RETURN QUERY
        SELECT (t.metadata->>'name')                         AS metric_name,
               t.route                                       AS route,
               COUNT(*)                                      AS samples,
               ROUND(percentile_cont(0.50) WITHIN GROUP (
                   ORDER BY (t.metadata->>'value')::NUMERIC) * 1.0, 2)  AS p50,
               ROUND(percentile_cont(0.95) WITHIN GROUP (
                   ORDER BY (t.metadata->>'value')::NUMERIC) * 1.0, 2)  AS p95,
               COUNT(*) FILTER (WHERE t.metadata->>'rating' = 'poor')   AS poor_count
          FROM public.client_telemetry t
         WHERE t.kind IN ('web_vital','app_perf')
           AND t.created_at > now() - (p_days || ' days')::interval
           AND t.metadata->>'name'  IS NOT NULL
           AND t.metadata->>'value' IS NOT NULL
         GROUP BY 1, 2
         HAVING COUNT(*) >= 5  -- noise floor — single-sample rows aren't useful
         ORDER BY samples DESC
         LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.telemetry_perf_summary(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_perf_summary(INTEGER, INTEGER) TO authenticated;


-- ── 5. Optional: pg_cron retention pruner ───────────────────────────
-- Errors / 404s / auth failures: 30 days. Web vitals / app perf: 14
-- days (high volume, low forensic value beyond a couple weeks).
-- Skipped if pg_cron isn't installed — apply
-- supabase-weather-pgcron-migration.sql first.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        RAISE NOTICE 'pg_cron not installed — skipping client_telemetry retention schedule.';
        RETURN;
    END IF;

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-client-telemetry-vitals') THEN
        PERFORM cron.unschedule('prune-client-telemetry-vitals');
    END IF;
    PERFORM cron.schedule(
        'prune-client-telemetry-vitals',
        '47 * * * *',         -- 47 past every hour (off-peak from existing pruners)
        $cron$
            DELETE FROM public.client_telemetry
             WHERE kind IN ('web_vital','app_perf')
               AND created_at < now() - interval '14 days';
        $cron$
    );

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-client-telemetry-errors') THEN
        PERFORM cron.unschedule('prune-client-telemetry-errors');
    END IF;
    PERFORM cron.schedule(
        'prune-client-telemetry-errors',
        '52 * * * *',
        $cron$
            DELETE FROM public.client_telemetry
             WHERE kind IN ('error','auth_failure','not_found','redirect')
               AND created_at < now() - interval '30 days';
        $cron$
    );
END $$;


-- ═══════════════════════════════════════════════════════════════
-- Verification queries
-- ═══════════════════════════════════════════════════════════════
-- 1. Direct INSERT MUST be denied for authenticated users:
--      INSERT INTO public.client_telemetry (kind, route, metadata)
--        VALUES ('error', '/test', '{}'::jsonb);
--    Expected: 42501 / new row violates row-level security policy.
--
-- 2. log_client_telemetry rejects unauthenticated authenticated calls:
--      SELECT public.log_client_telemetry(
--          '[{"kind":"error","route":"/x","metadata":{}}]'::jsonb);
--    Expected from authenticated: permission denied (function execute).
--    Expected from service_role: returns 1.
--
-- 3. Top-N RPCs gated to superadmin:
--      As admin (not super):  SELECT public.telemetry_top_errors(7, 5);
--      Expected: 42501 / "forbidden: superadmin only".
--
-- 4. Round-trip via the edge function:
--      curl -X POST https://parkersphysics.com/api/telemetry/log \
--           -H "Content-Type: application/json" \
--           -d '{"events":[{"kind":"error","route":"/test",
--                "metadata":{"fingerprint":"E:test:1","message":"hello"}}]}'
--      → 200 { ok: true, accepted: 1 }
--      Then: SELECT * FROM public.telemetry_top_errors(1, 5);
--      → row with fingerprint='E:test:1'.
--
-- 5. Cron jobs registered (after running this migration once):
--      SELECT jobname, schedule FROM cron.job
--       WHERE jobname LIKE 'prune-client-telemetry-%';
--      → 2 rows.
-- ═══════════════════════════════════════════════════════════════
