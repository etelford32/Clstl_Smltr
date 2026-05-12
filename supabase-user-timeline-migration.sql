-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Per-user telemetry timeline RPC
-- ═══════════════════════════════════════════════════════════════
--
-- Run in Supabase Dashboard → SQL Editor → New Query (idempotent).
--
-- Adds telemetry_user_timeline(p_user_id, p_days, p_limit) — a
-- superadmin-only read RPC that returns one merged, chronologically-
-- sorted view of everything we know about a single user:
--
--   * client_telemetry rows  (errors, auth_failures, redirects,
--                              not_founds, web_vitals, app_perf)
--   * activation_events rows (signup, signin_succeeded, wizard
--                              progress, subscription events, etc.)
--
-- Used by the /superadmin User Management table — clicking a user
-- opens a modal that calls this RPC and renders the timeline so the
-- superadmin can answer "what did this user actually experience?"
-- without joining tables in the SQL editor.
--
-- The role-change / plan-override audit log lives in
-- user_profiles_audit and surfaces on the existing Audit Log tab. We
-- intentionally don't UNION it in here — that's "what did WE do to
-- them" not "what did THEY experience" — they're meaningfully
-- different views.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. telemetry_user_timeline() ────────────────────────────────────
-- Standardised output columns so the UI doesn't need to switch on
-- source. `source` is always one of:
--   'client_telemetry'  — kind = error / auth_failure / not_found /
--                         redirect / web_vital / app_perf
--   'activation_event'  — kind = the event_type column verbatim
CREATE OR REPLACE FUNCTION public.telemetry_user_timeline(
    p_user_id UUID,
    p_days    INTEGER DEFAULT 30,
    p_limit   INTEGER DEFAULT 250
)
RETURNS TABLE (
    source     TEXT,
    kind       TEXT,
    severity   TEXT,
    route      TEXT,
    payload    JSONB,
    created_at TIMESTAMPTZ
) AS $$
DECLARE
    v_window INTERVAL;
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days  := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
    p_limit := LEAST(GREATEST(COALESCE(p_limit, 250), 1), 2000);
    v_window := (p_days || ' days')::interval;

    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'p_user_id required' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
        SELECT 'client_telemetry'::TEXT          AS source,
               t.kind                            AS kind,
               t.severity                        AS severity,
               t.route                           AS route,
               t.metadata                        AS payload,
               t.created_at                      AS created_at
          FROM public.client_telemetry t
         WHERE t.user_id   = p_user_id
           AND t.created_at > now() - v_window
        UNION ALL
        SELECT 'activation_event'::TEXT          AS source,
               ae.event                          AS kind,
               'info'::TEXT                      AS severity,
               NULL                              AS route,
               COALESCE(ae.metadata, '{}'::jsonb)
                 || jsonb_build_object('plan', ae.plan)
                                                 AS payload,
               ae.created_at                     AS created_at
          FROM public.activation_events ae
         WHERE ae.user_id   = p_user_id
           AND ae.created_at > now() - v_window
         ORDER BY created_at DESC
         LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.telemetry_user_timeline(UUID, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_user_timeline(UUID, INTEGER, INTEGER) TO authenticated;


-- ── 2. telemetry_user_summary() ─────────────────────────────────────
-- Lightweight companion that returns a single row of aggregate
-- counts so the timeline modal can show a header strip without
-- re-iterating the full timeline payload client-side.
CREATE OR REPLACE FUNCTION public.telemetry_user_summary(
    p_user_id UUID,
    p_days    INTEGER DEFAULT 30
)
RETURNS TABLE (
    errors          BIGINT,
    auth_failures   BIGINT,
    not_founds      BIGINT,
    redirects       BIGINT,
    web_vitals      BIGINT,
    activation_events BIGINT,
    last_seen_at    TIMESTAMPTZ
) AS $$
DECLARE
    v_window INTERVAL;
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days  := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
    v_window := (p_days || ' days')::interval;

    RETURN QUERY
    WITH ct AS (
        SELECT kind, MAX(created_at) AS mx
          FROM public.client_telemetry
         WHERE user_id   = p_user_id
           AND created_at > now() - v_window
         GROUP BY kind
    ),
    ae AS (
        SELECT MAX(created_at) AS mx, COUNT(*) AS n
          FROM public.activation_events
         WHERE user_id   = p_user_id
           AND created_at > now() - v_window
    )
    SELECT
        (SELECT COUNT(*) FROM public.client_telemetry t
          WHERE t.user_id = p_user_id AND t.created_at > now() - v_window AND t.kind = 'error'),
        (SELECT COUNT(*) FROM public.client_telemetry t
          WHERE t.user_id = p_user_id AND t.created_at > now() - v_window AND t.kind = 'auth_failure'),
        (SELECT COUNT(*) FROM public.client_telemetry t
          WHERE t.user_id = p_user_id AND t.created_at > now() - v_window AND t.kind = 'not_found'),
        (SELECT COUNT(*) FROM public.client_telemetry t
          WHERE t.user_id = p_user_id AND t.created_at > now() - v_window AND t.kind = 'redirect'),
        (SELECT COUNT(*) FROM public.client_telemetry t
          WHERE t.user_id = p_user_id AND t.created_at > now() - v_window AND t.kind IN ('web_vital','app_perf')),
        (SELECT n FROM ae),
        GREATEST(
            (SELECT MAX(mx) FROM ct),
            (SELECT mx FROM ae)
        );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.telemetry_user_summary(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_user_summary(UUID, INTEGER) TO authenticated;


-- ═══════════════════════════════════════════════════════════════
-- Verification queries
-- ═══════════════════════════════════════════════════════════════
-- 1. Gate works:
--      As admin (not super): SELECT public.telemetry_user_timeline(
--          '<uuid>', 7, 50);
--    Expected: 42501 / "forbidden: superadmin only".
--
-- 2. Round-trip with a known-active user:
--      As superadmin:
--      SELECT source, kind, severity, route, created_at
--        FROM public.telemetry_user_timeline(
--            (SELECT id FROM auth.users WHERE email = 'me@example.com'),
--            30, 50);
--    Expected: rows interleaving the user's signin_succeeded,
--    wizard_*, web_vital and any captured errors.
--
-- 3. Summary numbers agree with the timeline payload:
--      SELECT * FROM public.telemetry_user_summary(
--          '<uuid>', 30);
--      Compare each count to GROUP BY kind on the timeline call.
--
-- 4. p_user_id required:
--      SELECT public.telemetry_user_timeline(NULL, 7, 5);
--    Expected: 22023 / "p_user_id required".
-- ═══════════════════════════════════════════════════════════════
