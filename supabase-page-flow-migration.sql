-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — site-wide visitor-flow telemetry (page_flow)
-- Run in Supabase Dashboard → SQL Editor → New Query (idempotent).
-- ═══════════════════════════════════════════════════════════════
--
-- Why this exists
-- ---------------
-- The admin Visitor Flow card computed everything from the consent-
-- gated analytics_events table. Measured July 2026: 1,722 consent
-- prompts shown → 29 decisions (17 accept / 12 reject). ~98% of
-- visitors never touch the banner, so that card was describing ~2% of
-- traffic — mostly the author. Meanwhile the consent-exempt funnel
-- stream saw 1,104 distinct landing visitors in the same 30 days.
--
-- js/page-flow.js (loaded by nav.js on every page) now emits two
-- events per pageview on the operational pipeline:
--
--   kind='page_flow', metadata =
--     { phase:'enter', pv, ref, landing:0|1, device, visitor_id }
--     { phase:'exit',  pv, dwell_s, visible_s, active_s, clicks,
--       scroll_pct, exit_to, visitor_id }
--
-- pv joins an enter to its exit(s); a pageview may ship multiple exits
-- (tab re-engagement refreshes them) and readers MUST take the
-- max-dwell exit per pv. `ref` is an internal pathname (the from→to
-- transition edge — survives tab boundaries, unlike session ordering)
-- or an external origin. No PII, no fingerprint, no IP — the same
-- anonymous-write justification as the auth funnel (ANALYTICS.md §5).
--
-- This migration:
--   1. Widens client_telemetry_kind_check to allow 'page_flow'.
--   2. Refreshes log_client_telemetry()'s in-RPC whitelist to match
--      (CHECK and whitelist must move together — ANALYTICS.md drift
--      guard).
--   3. Ships three superadmin reporting RPCs:
--        telemetry_page_flow_kpis(days)        — sitewide totals
--        telemetry_page_flow_pages(days,limit) — per-page engagement /
--                                                bounce hotspots
--        telemetry_page_transitions(days,limit)— from→to edges + exits
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Widen the kind CHECK constraint ─────────────────────────
-- Postgres can't ALTER a CHECK in place; drop + re-add with the full
-- list (every existing kind MUST be repeated or existing rows' inserts
-- start failing) plus 'page_flow'.
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
        'feature',
        'page_flow'       -- NEW: site-wide visitor flow (enter/exit per pageview)
    ));


-- ── 2. Refresh the ingest RPC whitelist ────────────────────────
-- Byte-for-byte the live definition with 'page_flow' added to the
-- kind whitelist. If you have edited log_client_telemetry since,
-- merge rather than overwrite.
CREATE OR REPLACE FUNCTION public.log_client_telemetry(p_events JSONB, p_user_id UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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
            'feature','page_flow'
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
$$;

REVOKE ALL ON FUNCTION public.log_client_telemetry(JSONB, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_client_telemetry(JSONB, UUID) TO service_role;


-- ── 3. RPC: telemetry_page_flow_kpis ───────────────────────────
-- One row of sitewide totals for the chosen window. Sessions are the
-- per-tab telemetry session (pp_telemetry_session); visitors are the
-- persistent anonymous visitor_id. Bounce definitions:
--   bounce_sessions      — sessions with exactly one enter
--   hard_bounce_sessions — single-enter sessions whose best exit shows
--                          dwell < 15s AND zero clicks (or no exit at
--                          all — the tab died before engaging)
-- Engaged medians come from the max-dwell exit per pv.
CREATE OR REPLACE FUNCTION public.telemetry_page_flow_kpis(
    p_days INTEGER DEFAULT 7
)
RETURNS TABLE (
    sessions              BIGINT,
    visitors              BIGINT,
    pageviews             BIGINT,
    landings              BIGINT,
    bounce_sessions       BIGINT,
    hard_bounce_sessions  BIGINT,
    identified_sessions   BIGINT,
    anon_converted        BIGINT,
    med_page_dwell_s      NUMERIC,
    med_active_s          NUMERIC,
    avg_scroll_pct        NUMERIC,
    med_session_dwell_s   NUMERIC
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days := LEAST(GREATEST(COALESCE(p_days, 7), 1), 90);

    RETURN QUERY
    WITH enters AS (
        SELECT t.session_id,
               t.metadata->>'pv'                          AS pv,
               t.metadata->>'visitor_id'                  AS vid,
               (t.metadata->>'landing') = '1'             AS landing,
               t.user_id,
               t.created_at
        FROM public.client_telemetry t
        WHERE t.kind = 'page_flow'
          AND t.metadata->>'phase' = 'enter'
          AND t.created_at > now() - (p_days || ' days')::interval
          AND t.session_id IS NOT NULL
    ),
    best_exit AS (
        -- max-dwell exit per pv (re-engagement refreshes ship the same pv).
        -- Same window as enters: exits always postdate their enter, so an
        -- in-window enter's exit is in-window too.
        SELECT DISTINCT ON (t.metadata->>'pv')
               t.metadata->>'pv'                          AS pv,
               (t.metadata->>'dwell_s')::numeric          AS dwell_s,
               (t.metadata->>'active_s')::numeric         AS active_s,
               (t.metadata->>'clicks')::numeric           AS clicks,
               (t.metadata->>'scroll_pct')::numeric       AS scroll_pct
        FROM public.client_telemetry t
        WHERE t.kind = 'page_flow'
          AND t.metadata->>'phase' = 'exit'
          AND t.created_at > now() - (p_days || ' days')::interval
        ORDER BY t.metadata->>'pv', (t.metadata->>'dwell_s')::numeric DESC NULLS LAST
    ),
    per_session AS (
        SELECT e.session_id,
               COUNT(*)                                    AS views,
               BOOL_OR(e.landing)                          AS has_landing,
               BOOL_OR(e.user_id IS NOT NULL)              AS identified,
               BOOL_AND(e.user_id IS NULL)
                 FILTER (WHERE e.created_at = s.first_at)  AS first_anon,
               SUM(COALESCE(x.dwell_s, 0))                 AS session_dwell_s,
               MAX(CASE WHEN x.pv IS NOT NULL THEN 1 ELSE 0 END) AS has_exit,
               MAX(COALESCE(x.dwell_s, 0))                 AS best_dwell_s,
               MAX(COALESCE(x.clicks, 0))                  AS best_clicks
        FROM enters e
        JOIN (SELECT session_id, MIN(created_at) AS first_at
              FROM enters GROUP BY session_id) s USING (session_id)
        LEFT JOIN best_exit x ON x.pv = e.pv
        GROUP BY e.session_id
    )
    SELECT
        (SELECT COUNT(*) FROM per_session)::BIGINT,
        (SELECT COUNT(DISTINCT vid) FROM enters WHERE vid IS NOT NULL)::BIGINT,
        (SELECT COUNT(*) FROM enters)::BIGINT,
        (SELECT COUNT(*) FROM enters WHERE landing)::BIGINT,
        (SELECT COUNT(*) FROM per_session WHERE views = 1)::BIGINT,
        (SELECT COUNT(*) FROM per_session
          WHERE views = 1
            AND (has_exit = 0 OR (best_dwell_s < 15 AND best_clicks = 0)))::BIGINT,
        (SELECT COUNT(*) FROM per_session WHERE identified)::BIGINT,
        (SELECT COUNT(*) FROM per_session WHERE identified AND first_anon)::BIGINT,
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY dwell_s)
           FROM best_exit WHERE dwell_s IS NOT NULL),
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY active_s)
           FROM best_exit WHERE active_s IS NOT NULL),
        (SELECT ROUND(AVG(scroll_pct), 1) FROM best_exit),
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY session_dwell_s)
           FROM per_session WHERE session_dwell_s > 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
   SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.telemetry_page_flow_kpis(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_page_flow_kpis(INTEGER) TO authenticated;


-- ── 4. RPC: telemetry_page_flow_pages ──────────────────────────
-- Per-page engagement + bounce hotspots. `entries` counts enters,
-- `land_n` those that started a visit here, `exits_n` pageviews that
-- were the session's last, `hard_bounce_n` landings that were the
-- session's ONLY pageview and never engaged (dwell < 15s, no clicks,
-- or no exit event). Engagement columns read the max-dwell exit per pv.
CREATE OR REPLACE FUNCTION public.telemetry_page_flow_pages(
    p_days  INTEGER DEFAULT 7,
    p_limit INTEGER DEFAULT 25
)
RETURNS TABLE (
    page            TEXT,
    entries         BIGINT,
    land_n          BIGINT,
    exits_n         BIGINT,
    hard_bounce_n   BIGINT,
    med_dwell_s     NUMERIC,
    med_active_s    NUMERIC,
    avg_scroll_pct  NUMERIC,
    avg_clicks      NUMERIC
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days  := LEAST(GREATEST(COALESCE(p_days, 7), 1), 90);
    p_limit := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);

    RETURN QUERY
    WITH enters AS (
        SELECT t.route,
               t.session_id,
               t.metadata->>'pv'                AS pv,
               (t.metadata->>'landing') = '1'   AS landing,
               t.created_at
        FROM public.client_telemetry t
        WHERE t.kind = 'page_flow'
          AND t.metadata->>'phase' = 'enter'
          AND t.created_at > now() - (p_days || ' days')::interval
          AND t.session_id IS NOT NULL
          AND t.route IS NOT NULL
    ),
    best_exit AS (
        SELECT DISTINCT ON (t.metadata->>'pv')
               t.metadata->>'pv'                    AS pv,
               (t.metadata->>'dwell_s')::numeric    AS dwell_s,
               (t.metadata->>'active_s')::numeric   AS active_s,
               (t.metadata->>'clicks')::numeric     AS clicks,
               (t.metadata->>'scroll_pct')::numeric AS scroll_pct
        FROM public.client_telemetry t
        WHERE t.kind = 'page_flow'
          AND t.metadata->>'phase' = 'exit'
          AND t.created_at > now() - (p_days || ' days')::interval
        ORDER BY t.metadata->>'pv', (t.metadata->>'dwell_s')::numeric DESC NULLS LAST
    ),
    session_stats AS (
        SELECT session_id, COUNT(*) AS views, MAX(created_at) AS last_at
        FROM enters GROUP BY session_id
    ),
    joined AS (
        SELECT e.route, e.pv, e.landing,
               (s.views = 1)                        AS only_view,
               (e.created_at = s.last_at)           AS is_last,
               x.dwell_s, x.active_s, x.clicks, x.scroll_pct
        FROM enters e
        JOIN session_stats s USING (session_id)
        LEFT JOIN best_exit x ON x.pv = e.pv
    )
    SELECT
        j.route                                        AS page,
        COUNT(*)::BIGINT                               AS entries,
        COUNT(*) FILTER (WHERE j.landing)::BIGINT      AS land_n,
        COUNT(*) FILTER (WHERE j.is_last)::BIGINT      AS exits_n,
        COUNT(*) FILTER (
            WHERE j.landing AND j.only_view
              AND (j.dwell_s IS NULL OR (j.dwell_s < 15 AND COALESCE(j.clicks,0) = 0))
        )::BIGINT                                      AS hard_bounce_n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY j.dwell_s)
            FILTER (WHERE j.dwell_s IS NOT NULL)       AS med_dwell_s,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY j.active_s)
            FILTER (WHERE j.active_s IS NOT NULL)      AS med_active_s,
        ROUND(AVG(j.scroll_pct), 1)                    AS avg_scroll_pct,
        ROUND(AVG(j.clicks), 1)                        AS avg_clicks
    FROM joined j
    GROUP BY j.route
    ORDER BY COUNT(*) DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
   SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.telemetry_page_flow_pages(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_page_flow_pages(INTEGER, INTEGER) TO authenticated;


-- ── 5. RPC: telemetry_page_transitions ─────────────────────────
-- from→to navigation edges. Internal edges come from enter.ref (the
-- previous page's pathname — survives tab boundaries and target=_blank,
-- which session ordering does not). Exit edges ('(exit)') are sessions'
-- last pageviews. A from = to row is a reload loop — the admin renders
-- it flagged, don't filter it here (a reload loop on a gated page IS a
-- drop-off signal).
CREATE OR REPLACE FUNCTION public.telemetry_page_transitions(
    p_days  INTEGER DEFAULT 7,
    p_limit INTEGER DEFAULT 25
)
RETURNS TABLE (
    from_page TEXT,
    to_page   TEXT,
    n         BIGINT
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days  := LEAST(GREATEST(COALESCE(p_days, 7), 1), 90);
    p_limit := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);

    RETURN QUERY
    WITH enters AS (
        SELECT t.route,
               t.session_id,
               t.metadata->>'ref'  AS ref,
               t.created_at
        FROM public.client_telemetry t
        WHERE t.kind = 'page_flow'
          AND t.metadata->>'phase' = 'enter'
          AND t.created_at > now() - (p_days || ' days')::interval
          AND t.session_id IS NOT NULL
          AND t.route IS NOT NULL
    ),
    internal_edges AS (
        SELECT e.ref AS from_page, e.route AS to_page, COUNT(*) AS n
        FROM enters e
        WHERE e.ref LIKE '/%'
        GROUP BY e.ref, e.route
    ),
    exit_edges AS (
        SELECT last_e.route AS from_page, '(exit)'::text AS to_page, COUNT(*) AS n
        FROM (
            SELECT DISTINCT ON (e.session_id) e.route
            FROM enters e
            ORDER BY e.session_id, e.created_at DESC
        ) last_e
        GROUP BY last_e.route
    )
    SELECT u.from_page, u.to_page, u.n::BIGINT
    FROM (
        SELECT * FROM internal_edges
        UNION ALL
        SELECT * FROM exit_edges
    ) u
    ORDER BY u.n DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
   SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.telemetry_page_transitions(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_page_transitions(INTEGER, INTEGER) TO authenticated;
