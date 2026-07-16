-- supabase-auth-funnel-dropoffs-context-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 2 of the analytics fix: extend telemetry_auth_funnel_dropoffs() so
-- each stalled session also carries its traffic context — referrer origin,
-- utm_source / utm_campaign, and coarse device class. This lets an operator
-- see at a glance whether a bounce cluster is one bad traffic source (a
-- broken campaign link, a mobile-only layout break) rather than a general
-- funnel problem.
--
-- Where the context lives:
--   auth-funnel.js attaches a `context` block to the FIRST funnel event of
--   each funnel_id only (see captureContext()):
--     metadata->'context' = {
--       page, referrer (origin only), utm:{utm_source,…}, viewport,
--       locale, device, consent
--     }
--   The existing dropoffs RPC keyed off the LATEST event per funnel, which
--   never carries context. So we add a per-funnel "earliest context" CTE and
--   left-join it onto the latest-stage row.
--
-- Privacy posture is unchanged: referrer is origin-only, UTMs are public
-- marketing identifiers, device is a mobile/desktop bucket. No PII, no IP,
-- no full UA — same floor documented in ANALYTICS.md.
--
-- Signature change: this widens the RETURNS TABLE, which CREATE OR REPLACE
-- cannot do in-place, so we DROP then CREATE. The (INTEGER, INTEGER, INTEGER)
-- argument signature is unchanged, so callers (js/admin-analytics.js
-- fetchAuthFunnelDropoffs) keep working — they read the new columns off the
-- returned rows and ignore them when absent.
--
-- Idempotent. Re-run safe.
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.telemetry_auth_funnel_dropoffs(INTEGER, INTEGER, INTEGER);

CREATE FUNCTION public.telemetry_auth_funnel_dropoffs(
    p_days        INTEGER DEFAULT 7,
    p_limit       INTEGER DEFAULT 50,
    p_grace_secs  INTEGER DEFAULT 120   -- ignore funnels whose last event is fresher than this
)
RETURNS TABLE (
    funnel_id     TEXT,
    last_stage    TEXT,
    last_reason   TEXT,
    last_code     TEXT,
    last_route    TEXT,
    last_method   TEXT,
    last_provider TEXT,
    last_seen     TIMESTAMPTZ,
    stage_count   BIGINT,
    -- NEW (Phase 2): first-event traffic context for the funnel.
    referrer      TEXT,
    utm_source    TEXT,
    utm_campaign  TEXT,
    device        TEXT
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days       := LEAST(GREATEST(COALESCE(p_days, 7), 1), 90);
    p_limit      := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
    p_grace_secs := LEAST(GREATEST(COALESCE(p_grace_secs, 120), 0), 3600);

    RETURN QUERY
    -- NB: column aliased to `fid` inside the body to avoid colliding with
    -- the RETURNS TABLE OUT-param `funnel_id` ("column reference is ambiguous").
    WITH window_rows AS (
        SELECT
            (t.metadata->>'funnel_id')::text AS fid,
            (t.metadata->>'stage')::text     AS stage,
            t.metadata                       AS metadata,
            t.route                          AS route,
            t.created_at                     AS created_at
        FROM public.client_telemetry t
        WHERE t.kind = 'auth_funnel'
          AND t.created_at > now() - (p_days || ' days')::interval
          AND t.metadata->>'funnel_id' IS NOT NULL
          AND t.metadata->>'stage'     IS NOT NULL
    ),
    latest AS (
        -- One row per funnel_id: the most recent stage event observed.
        SELECT DISTINCT ON (w.fid)
            w.fid,
            w.stage,
            w.metadata,
            w.route,
            w.created_at
        FROM window_rows w
        ORDER BY w.fid, w.created_at DESC
    ),
    ctx AS (
        -- One row per funnel_id: the EARLIEST event that carried a context
        -- block. auth-funnel.js only attaches context on the first step()
        -- call, so this is the funnel's acquisition context.
        SELECT DISTINCT ON (w.fid)
            w.fid,
            w.metadata->'context' AS context
        FROM window_rows w
        WHERE w.metadata ? 'context'
        ORDER BY w.fid, w.created_at ASC
    ),
    counts AS (
        SELECT w.fid, COUNT(*)::BIGINT AS stage_count
        FROM window_rows w
        GROUP BY w.fid
    )
    SELECT
        l.fid                                          AS funnel_id,
        l.stage                                        AS last_stage,
        LEFT(COALESCE(l.metadata->>'reason', ''), 200) AS last_reason,
        LEFT(COALESCE(l.metadata->>'code',   ''),  80) AS last_code,
        l.route                                        AS last_route,
        LEFT(COALESCE(l.metadata->>'method', ''),  40) AS last_method,
        LEFT(COALESCE(l.metadata->>'provider', ''),40) AS last_provider,
        l.created_at                                   AS last_seen,
        c.stage_count,
        LEFT(NULLIF(x.context->>'referrer', ''), 120)              AS referrer,
        LEFT(NULLIF(x.context->'utm'->>'utm_source', ''), 80)      AS utm_source,
        LEFT(NULLIF(x.context->'utm'->>'utm_campaign', ''), 80)    AS utm_campaign,
        LEFT(NULLIF(x.context->>'device', ''), 20)                 AS device
    FROM latest l
    JOIN counts c ON c.fid = l.fid
    LEFT JOIN ctx x ON x.fid = l.fid
    WHERE l.stage NOT IN (
            'signin_succeeded',
            'auth_callback_succeeded',
            'signup_succeeded',
            'signin_already_signed_in',
            'signup_already_signed_in',
            'auth_callback_signup'
        )
      AND l.created_at < now() - (p_grace_secs || ' seconds')::interval
    ORDER BY l.created_at DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
   SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.telemetry_auth_funnel_dropoffs(INTEGER, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_auth_funnel_dropoffs(INTEGER, INTEGER, INTEGER) TO authenticated;

-- ── Smoke test ───────────────────────────────────────────────────────────
-- As a superadmin:
--   SELECT funnel_id, last_stage, referrer, utm_source, utm_campaign, device
--     FROM public.telemetry_auth_funnel_dropoffs(7, 50, 120);
-- Expect the four new columns populated for funnels whose first event carried
-- a context block, NULL for older rows recorded before context capture, and
-- no change to ordering or the success-terminal exclusion.
