-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Telemetry perf alerts migration
-- ═══════════════════════════════════════════════════════════════
--
-- Run in Supabase Dashboard → SQL Editor → New Query (idempotent).
--
-- Wires the existing pipeline-watchdog cron into the
-- client_telemetry pipeline so perf regressions emit alerts the same
-- way pipeline failures do today.
--
-- The watchdog reads two RPCs from this migration on each tick:
--
--   1. telemetry_perf_alert_candidates(...)
--      Returns (metric, route, p95, samples) rows where
--      p95 > threshold AND samples >= floor AND the metric/route
--      pair hasn't been alerted within the cooldown window.
--
--   2. record_perf_alert_sent(p_metric, p_route)
--      Stamps perf_alert_state so the next tick correctly skips.
--
-- The watchdog sends one notification per (metric, route) per
-- cooldown window. When all windows return to good values for
-- p_resolve_streak consecutive ticks, a follow-up "resolved" alert
-- is emitted (so a slow-then-fast route doesn't leave the channel
-- thinking it's still on fire).
-- ═══════════════════════════════════════════════════════════════


-- ── 1. State table ─────────────────────────────────────────────────
-- One row per (metric, route) pair we've ever alerted on. last_alerted_at
-- drives cooldown; current_streak / last_p95 let us detect resolution.
CREATE TABLE IF NOT EXISTS public.perf_alert_state (
    metric_name      TEXT NOT NULL,
    route            TEXT NOT NULL,
    last_alerted_at  TIMESTAMPTZ,
    last_resolved_at TIMESTAMPTZ,
    last_p95         NUMERIC,
    -- Consecutive ticks where the metric is BELOW the threshold; resets
    -- on every breach. When >= the resolve_streak parameter the watchdog
    -- emits a "resolved" event and clears last_alerted_at.
    healthy_streak   INTEGER NOT NULL DEFAULT 0,
    -- Free-form notes (e.g., last threshold used, last sample count).
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (metric_name, route)
);

-- Read-only for superadmins (the watchdog uses service_role and is
-- exempt from RLS). Plain authenticated users have no business reading
-- the state table — they consume the perf data via telemetry_perf_summary.
ALTER TABLE public.perf_alert_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Superadmin reads perf_alert_state" ON public.perf_alert_state;
CREATE POLICY "Superadmin reads perf_alert_state"
    ON public.perf_alert_state FOR SELECT
    USING (public.is_superadmin());


-- ── 2. telemetry_perf_alert_candidates ─────────────────────────────
-- Returns the routes that should trigger an alert RIGHT NOW.
--
-- Args:
--   p_metric          name to check (e.g. 'LCP')
--   p_threshold_ms    alert if p95 > this (CLS uses unitless raw value)
--   p_window_hours    look at the last N hours of samples
--   p_min_samples     ignore routes with fewer than this many samples
--                     (avoids alerting on noisy single-user spikes)
--   p_cooldown_hours  don't re-alert if last_alerted_at is fresher
--   p_route_limit     cap candidates returned per call
--
-- Returns one row per (route) with the current p95 + sample count.
-- The watchdog iterates these, fans out alerts, then calls
-- record_perf_alert_sent for each one that succeeded.
CREATE OR REPLACE FUNCTION public.telemetry_perf_alert_candidates(
    p_metric         TEXT    DEFAULT 'LCP',
    p_threshold_ms   NUMERIC DEFAULT 4000,
    p_window_hours   INTEGER DEFAULT 6,
    p_min_samples    INTEGER DEFAULT 30,
    p_cooldown_hours INTEGER DEFAULT 6,
    p_route_limit    INTEGER DEFAULT 20
)
RETURNS TABLE (
    metric_name     TEXT,
    route           TEXT,
    samples         BIGINT,
    p95             NUMERIC,
    threshold_ms    NUMERIC,
    last_alerted_at TIMESTAMPTZ
) AS $$
DECLARE
    v_window  INTERVAL := (p_window_hours   || ' hours')::interval;
    v_cool    INTERVAL := (p_cooldown_hours || ' hours')::interval;
BEGIN
    p_route_limit := LEAST(GREATEST(COALESCE(p_route_limit, 20), 1), 100);

    RETURN QUERY
    WITH agg AS (
        SELECT (t.metadata->>'name')                                      AS metric_name,
               t.route                                                    AS route,
               COUNT(*)                                                   AS samples,
               percentile_cont(0.95) WITHIN GROUP (
                   ORDER BY (t.metadata->>'value')::NUMERIC)              AS p95
          FROM public.client_telemetry t
         WHERE t.kind IN ('web_vital','app_perf')
           AND t.created_at > now() - v_window
           AND t.metadata->>'name'  = p_metric
           AND t.metadata->>'value' IS NOT NULL
           AND t.route IS NOT NULL
         GROUP BY t.route
        HAVING COUNT(*) >= p_min_samples
           AND percentile_cont(0.95) WITHIN GROUP (
               ORDER BY (t.metadata->>'value')::NUMERIC) > p_threshold_ms
    )
    SELECT a.metric_name,
           a.route,
           a.samples,
           ROUND(a.p95, 2),
           p_threshold_ms,
           s.last_alerted_at
      FROM agg a
 LEFT JOIN public.perf_alert_state s
        ON s.metric_name = a.metric_name AND s.route = a.route
     WHERE s.last_alerted_at IS NULL
        OR s.last_alerted_at < now() - v_cool
     ORDER BY a.p95 DESC
     LIMIT p_route_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.telemetry_perf_alert_candidates(TEXT, NUMERIC, INTEGER, INTEGER, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_perf_alert_candidates(TEXT, NUMERIC, INTEGER, INTEGER, INTEGER, INTEGER) TO service_role;


-- ── 3. record_perf_alert_sent ─────────────────────────────────────
-- Called by the watchdog after a successful Slack/email send. Upserts
-- perf_alert_state so the cooldown is honoured on the next tick. Also
-- resets healthy_streak so a flapping route doesn't immediately
-- self-resolve.
CREATE OR REPLACE FUNCTION public.record_perf_alert_sent(
    p_metric_name TEXT,
    p_route       TEXT,
    p_p95         NUMERIC DEFAULT NULL,
    p_metadata    JSONB   DEFAULT '{}'::jsonb
)
RETURNS BOOLEAN AS $$
BEGIN
    INSERT INTO public.perf_alert_state
        (metric_name, route, last_alerted_at, last_p95, healthy_streak, metadata)
    VALUES (p_metric_name, p_route, now(), p_p95, 0, COALESCE(p_metadata, '{}'::jsonb))
    ON CONFLICT (metric_name, route) DO UPDATE
        SET last_alerted_at = EXCLUDED.last_alerted_at,
            last_p95        = EXCLUDED.last_p95,
            healthy_streak  = 0,
            metadata        = EXCLUDED.metadata;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.record_perf_alert_sent(TEXT, TEXT, NUMERIC, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_perf_alert_sent(TEXT, TEXT, NUMERIC, JSONB) TO service_role;


-- ── 4. telemetry_perf_alert_resolved ──────────────────────────────
-- Returns previously-alerted (metric, route) pairs whose p95 has been
-- back below the threshold for p_resolve_streak consecutive ticks.
-- The watchdog emits a "resolved" notification + clears
-- last_alerted_at so the same route can re-alert if it regresses.
--
-- Healthy_streak is incremented per-tick by the watchdog when a
-- previously-alerted route doesn't appear in the candidate list
-- (handled by tick_perf_alert_health below).
CREATE OR REPLACE FUNCTION public.telemetry_perf_alert_resolved(
    p_resolve_streak INTEGER DEFAULT 3
)
RETURNS TABLE (
    metric_name     TEXT,
    route           TEXT,
    last_alerted_at TIMESTAMPTZ,
    last_p95        NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT s.metric_name, s.route, s.last_alerted_at, s.last_p95
      FROM public.perf_alert_state s
     WHERE s.last_alerted_at IS NOT NULL
       AND s.healthy_streak >= GREATEST(p_resolve_streak, 1);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.telemetry_perf_alert_resolved(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_perf_alert_resolved(INTEGER) TO service_role;


-- ── 5. tick_perf_alert_health ─────────────────────────────────────
-- Called by the watchdog at the END of each tick AFTER it has fetched
-- candidates. Increments healthy_streak for any previously-alerted
-- (metric, route) NOT in the offending set, signalling recovery
-- progress. Routes still over threshold get streak=0.
CREATE OR REPLACE FUNCTION public.tick_perf_alert_health(
    p_offending JSONB     -- array of {metric, route} that ARE currently bad
)
RETURNS INTEGER AS $$
DECLARE
    v_updated INTEGER := 0;
BEGIN
    -- Reset streak for currently-offending routes (they're not healthy).
    UPDATE public.perf_alert_state s
       SET healthy_streak = 0
      FROM jsonb_array_elements(COALESCE(p_offending, '[]'::jsonb)) AS o
     WHERE s.metric_name = o->>'metric'
       AND s.route       = o->>'route';

    -- Increment streak for every previously-alerted route NOT in the
    -- offending set.
    WITH bad AS (
        SELECT (o->>'metric') AS metric_name,
               (o->>'route')  AS route
          FROM jsonb_array_elements(COALESCE(p_offending, '[]'::jsonb)) AS o
    ),
    upd AS (
        UPDATE public.perf_alert_state s
           SET healthy_streak = s.healthy_streak + 1
         WHERE s.last_alerted_at IS NOT NULL
           AND NOT EXISTS (
               SELECT 1 FROM bad b
                WHERE b.metric_name = s.metric_name
                  AND b.route       = s.route
           )
         RETURNING 1
    )
    SELECT COUNT(*) INTO v_updated FROM upd;

    RETURN v_updated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.tick_perf_alert_health(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tick_perf_alert_health(JSONB) TO service_role;


-- ── 6. record_perf_alert_resolved ─────────────────────────────────
-- Called by the watchdog after a "resolved" notification has been
-- sent. Clears last_alerted_at + resets streak so the row goes back
-- to "no alert active" state.
CREATE OR REPLACE FUNCTION public.record_perf_alert_resolved(
    p_metric_name TEXT,
    p_route       TEXT
)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE public.perf_alert_state
       SET last_resolved_at = now(),
           last_alerted_at  = NULL,
           healthy_streak   = 0
     WHERE metric_name = p_metric_name AND route = p_route;
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.record_perf_alert_resolved(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_perf_alert_resolved(TEXT, TEXT) TO service_role;


-- ═══════════════════════════════════════════════════════════════
-- Verification queries
-- ═══════════════════════════════════════════════════════════════
-- 1. Direct INSERT denied for normal users:
--      INSERT INTO public.perf_alert_state (metric_name, route)
--        VALUES ('LCP', '/x');
--    Expected (as authenticated, not service_role): RLS denial.
--
-- 2. Candidates RPC with a low threshold returns rows that match
--    your current p95 distribution (sanity check the query):
--      SELECT * FROM public.telemetry_perf_alert_candidates(
--          'LCP', 100, 24, 5, 0, 10);
--    Expected: routes with p95 > 100 ms, last_alerted_at NULL.
--
-- 3. Watchdog round-trip:
--      a. Lower the threshold to a value that has candidates.
--      b. Trigger /api/cron/pipeline-watchdog (with CRON_SECRET).
--      c. SELECT * FROM public.perf_alert_state — last_alerted_at
--         should be set for each alerted (metric, route) pair.
--      d. Re-trigger immediately — candidates RPC should return zero
--         (cooldown active).
--      e. UPDATE perf_alert_state SET last_alerted_at = now() - '7h'
--         to force the cooldown to expire; trigger again — candidates
--         re-emerge.
-- ═══════════════════════════════════════════════════════════════
