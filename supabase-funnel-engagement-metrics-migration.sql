-- supabase-funnel-engagement-metrics-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Engagement metrics — "which sources / devices / flows are worth fixing":
--
--   1. telemetry_funnel_failure_codes(days, limit)
--      Top-N histogram over the stable `code` enum on failed funnel events
--      (the last open item in AUTH_FLOW_REVIEW.md). Groups by code so the
--      histogram survives free-text `reason` wording drift; carries a
--      representative reason + the flow (signin/signup/oauth/callback) each
--      code most often appears in. Pre-deploy rows (no code yet) bucket as
--      '(uncategorized)' so the card shows failure VOLUME immediately.
--
--   2. telemetry_funnel_dimension_conversion(days, dimension, limit)
--      Per-source / per-device outcome breakdown from the funnel context.
--      dimension ∈ {referrer, utm_source, utm_campaign, device}. For each
--      value: funnels, engaged, converted, and the derived rates. Three
--      tiers so the "convert vs just bounce" question is answerable even when
--      full conversion is rare (which it is — most landing funnels never
--      reach a CTA):
--        • bounced   — funnel emitted ONLY passive stages (views / exposure /
--                      dwell); never interacted.
--        • engaged   — funnel did something (CTA click, submit, interaction…)
--                      but did not reach a success terminal.
--        • converted — funnel reached a success terminal.
--
-- Both superadmin-gated. Idempotent, re-run safe.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Failure-code histogram ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.telemetry_funnel_failure_codes(
    p_days  INTEGER DEFAULT 30,
    p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
    code             TEXT,
    modal_flow       TEXT,
    occurrences      BIGINT,
    distinct_funnels BIGINT,
    sample_reason    TEXT,
    last_seen        TIMESTAMPTZ
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days  := LEAST(GREATEST(COALESCE(p_days, 30), 1), 180);
    p_limit := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);

    RETURN QUERY
    WITH failed AS (
        SELECT
            COALESCE(NULLIF(t.metadata->>'code', ''), '(uncategorized)') AS code,
            CASE
                WHEN t.metadata->>'stage' LIKE 'signin%'        THEN 'signin'
                WHEN t.metadata->>'stage' LIKE 'signup%'        THEN 'signup'
                WHEN t.metadata->>'stage' LIKE 'oauth%'         THEN 'oauth'
                WHEN t.metadata->>'stage' LIKE 'auth_callback%' THEN 'callback'
                ELSE 'other'
            END                                                           AS flow,
            t.metadata->>'funnel_id'                                      AS fid,
            NULLIF(t.metadata->>'reason', '')                             AS reason,
            t.created_at
        FROM public.client_telemetry t
        WHERE t.kind = 'auth_funnel'
          AND t.created_at > now() - (p_days || ' days')::interval
          AND (
              t.metadata->>'stage' LIKE '%\_failed'
           OR t.metadata->>'stage' LIKE '%\_validation\_error'
          )
    )
    SELECT
        f.code,
        mode() WITHIN GROUP (ORDER BY f.flow)                 AS modal_flow,
        COUNT(*)::BIGINT                                      AS occurrences,
        COUNT(DISTINCT f.fid)::BIGINT                         AS distinct_funnels,
        (ARRAY_AGG(f.reason ORDER BY f.created_at DESC)
            FILTER (WHERE f.reason IS NOT NULL))[1]           AS sample_reason,
        MAX(f.created_at)                                     AS last_seen
    FROM failed f
    GROUP BY f.code
    ORDER BY occurrences DESC, f.code
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
   SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.telemetry_funnel_failure_codes(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_funnel_failure_codes(INTEGER, INTEGER) TO authenticated;


-- ── 2. Per-dimension conversion (source / device) ───────────────────────────

CREATE OR REPLACE FUNCTION public.telemetry_funnel_dimension_conversion(
    p_days      INTEGER DEFAULT 30,
    p_dimension TEXT    DEFAULT 'referrer',
    p_limit     INTEGER DEFAULT 20
)
RETURNS TABLE (
    value           TEXT,
    funnels         BIGINT,
    engaged         BIGINT,
    converted       BIGINT,
    bounced         BIGINT,
    engagement_rate NUMERIC,
    conversion_rate NUMERIC
) AS $$
DECLARE
    v_success TEXT[] := ARRAY[
        'signin_succeeded','auth_callback_succeeded','signup_succeeded',
        'signin_already_signed_in','signup_already_signed_in','auth_callback_signup'
    ];
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days  := LEAST(GREATEST(COALESCE(p_days, 30), 1), 180);
    p_limit := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
    IF p_dimension NOT IN ('referrer','utm_source','utm_campaign','device') THEN
        RAISE EXCEPTION 'invalid dimension: %', p_dimension USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH win AS (
        SELECT
            (t.metadata->>'funnel_id')::text AS fid,
            (t.metadata->>'stage')::text     AS stage,
            t.metadata                       AS metadata,
            t.created_at
        FROM public.client_telemetry t
        WHERE t.kind = 'auth_funnel'
          AND t.created_at > now() - (p_days || ' days')::interval
          AND t.metadata->>'funnel_id' IS NOT NULL
          AND t.metadata->>'stage'     IS NOT NULL
    ),
    -- One dimension value per funnel, taken from the earliest context block.
    fid_val AS (
        SELECT DISTINCT ON (w.fid)
            w.fid,
            CASE p_dimension
                WHEN 'referrer'     THEN NULLIF(w.metadata->'context'->>'referrer', '')
                WHEN 'utm_source'   THEN NULLIF(w.metadata->'context'->'utm'->>'utm_source', '')
                WHEN 'utm_campaign' THEN NULLIF(w.metadata->'context'->'utm'->>'utm_campaign', '')
                WHEN 'device'       THEN NULLIF(w.metadata->'context'->>'device', '')
            END AS val
        FROM win w
        WHERE w.metadata ? 'context'
        ORDER BY w.fid, w.created_at ASC
    ),
    -- Per-funnel outcome flags. "Passive" = a stage that implies no
    -- interaction (a bare view, an experiment exposure, a dwell timer).
    fid_outcome AS (
        SELECT
            w.fid,
            bool_or(w.stage = ANY (v_success)) AS converted,
            bool_or(
                w.stage NOT LIKE '%\_view'
                AND w.stage NOT IN ('experiment_exposure','hero_dwell',
                                    'landing_section_view','sw_dwell_60s',
                                    'auth_callback_enter')
            ) AS engaged
        FROM win w
        GROUP BY w.fid
    )
    SELECT
        COALESCE(v.val, '(unknown)')                                          AS value,
        COUNT(*)::BIGINT                                                       AS funnels,
        COUNT(*) FILTER (WHERE o.engaged)::BIGINT                              AS engaged,
        COUNT(*) FILTER (WHERE o.converted)::BIGINT                            AS converted,
        COUNT(*) FILTER (WHERE NOT COALESCE(o.engaged, false))::BIGINT         AS bounced,
        ROUND(100.0 * COUNT(*) FILTER (WHERE o.engaged)
              / NULLIF(COUNT(*), 0), 1)                                        AS engagement_rate,
        ROUND(100.0 * COUNT(*) FILTER (WHERE o.converted)
              / NULLIF(COUNT(*), 0), 1)                                        AS conversion_rate
    FROM fid_val v
    JOIN fid_outcome o ON o.fid = v.fid
    GROUP BY COALESCE(v.val, '(unknown)')
    ORDER BY funnels DESC, value
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
   SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.telemetry_funnel_dimension_conversion(INTEGER, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_funnel_dimension_conversion(INTEGER, TEXT, INTEGER) TO authenticated;


-- ── Smoke tests (as a superadmin) ───────────────────────────────────────────
--   SELECT * FROM public.telemetry_funnel_failure_codes(30, 20);
--   SELECT * FROM public.telemetry_funnel_dimension_conversion(30, 'referrer', 20);
--   SELECT * FROM public.telemetry_funnel_dimension_conversion(30, 'device', 10);
