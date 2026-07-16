-- supabase-auth-funnel-phase3-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 3 of the analytics fix — "understand our users":
--
--   1. Register two new canonical stages so they appear in the ordered funnel
--      summary and the top-drops list:
--        • email_confirm_link_clicked — closes the loop that
--          signup_email_confirmation_required opens (did the user who was told
--          to "check your email" ever come back through the link?).
--        • checkout_started — fires before the Stripe redirect, so paid-signup
--          abandonment (checkout_started − subscription_started) is finally
--          visible.
--
--   2. Extend telemetry_auth_funnel_dropoffs() with the persistent anonymous
--      visitor id (context->>'visitor_id', the shared `pp_vid`) and a
--      prior_funnels count, so an operator can see at a glance that a stalled
--      session belongs to a visitor who has bounced N times before.
--
--   3. Add telemetry_funnel_visitor_summary() — the new/returning/repeat-
--      bouncer/converted breakdown of ANONYMOUS visitors, keyed off visitor_id.
--      This is the pre-auth population view the per-tab funnel_id could never
--      give us.
--
-- Privacy note: visitor_id is a random UUID with no PII, attached only to the
-- once-per-funnel context block (not every event). It is the SAME id that
-- js/experiments.js + js/analytics.js already use. Adding it to the pre-consent
-- funnel is a deliberate, documented posture change (see ANALYTICS.md) — it is
-- what lets the funnel answer "has this visitor been here before".
--
-- Idempotent. Re-run safe. All functions superadmin-gated server-side.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Summary RPC: register the two new stages ─────────────────────────────
-- Only the stages CTE changes vs supabase-auth-funnel-migration.sql; the body
-- is otherwise identical. New stages slot into the canonical order:
--   …signup_email_confirmation_required (58) → email_confirm_link_clicked (59)
--   → signup_succeeded (60) → checkout_started (62)…

CREATE OR REPLACE FUNCTION public.telemetry_auth_funnel_summary(
    p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
    stage             TEXT,
    stage_order       INTEGER,
    occurrences       BIGINT,
    distinct_funnels  BIGINT,
    distinct_users    BIGINT,
    first_seen        TIMESTAMPTZ,
    last_seen         TIMESTAMPTZ
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days := LEAST(GREATEST(COALESCE(p_days, 30), 1), 180);

    RETURN QUERY
    WITH stages(stage, stage_order) AS (
        VALUES
            ('landing_view',                  10),
            ('landing_cta_click',             20),
            ('signup_view',                   30),
            ('signup_plan_selected',          35),
            ('signup_invite_validated',       38),
            ('signup_first_interaction',      40),
            ('signup_password_strength',      45),
            ('signup_terms_checked',          48),
            ('signup_validation_error',       49),
            ('signup_submit',                 50),
            ('signup_failed',                 55),
            ('signup_email_confirmation_required', 58),
            ('email_confirm_link_clicked',    59),   -- NEW (Phase 3)
            ('signup_succeeded',              60),
            ('checkout_started',              62),   -- NEW (Phase 3)
            ('signin_view',                   70),
            ('signin_method_selected',        75),
            ('signin_first_interaction',      78),
            ('signin_validation_error',       79),
            ('signin_submit',                 80),
            ('signin_failed',                 85),
            ('signin_succeeded',              90),
            ('oauth_button_clicked',          92),
            ('magic_link_resend_clicked',     93),
            ('magic_link_back_to_password',   94),
            ('password_reset_view',           95),
            ('password_reset_requested',      96),
            ('auth_callback_enter',          110),
            ('auth_callback_succeeded',      120),
            ('auth_callback_failed',         125),
            ('auth_callback_signup',         130),
            ('aurora_capture_view',          140),
            ('aurora_capture_focus',         145),
            ('aurora_capture_submit',        150),
            ('aurora_capture_succeeded',     155),
            ('aurora_capture_failed',        158),
            ('aurora_confirmed',             160)
    ),
    counted AS (
        SELECT
            t.metadata->>'stage'                       AS stage,
            COUNT(*)                                   AS occurrences,
            COUNT(DISTINCT t.metadata->>'funnel_id')   AS distinct_funnels,
            COUNT(DISTINCT t.user_id)                  AS distinct_users,
            MIN(t.created_at)                          AS first_seen,
            MAX(t.created_at)                          AS last_seen
        FROM public.client_telemetry t
        WHERE t.kind = 'auth_funnel'
          AND t.created_at > now() - (p_days || ' days')::interval
          AND t.metadata->>'stage' IS NOT NULL
        GROUP BY t.metadata->>'stage'
    )
    SELECT
        s.stage,
        s.stage_order,
        COALESCE(c.occurrences, 0)::BIGINT       AS occurrences,
        COALESCE(c.distinct_funnels, 0)::BIGINT  AS distinct_funnels,
        COALESCE(c.distinct_users, 0)::BIGINT    AS distinct_users,
        c.first_seen,
        c.last_seen
    FROM stages s
    LEFT JOIN counted c ON c.stage = s.stage
    ORDER BY s.stage_order;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
   SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.telemetry_auth_funnel_summary(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_auth_funnel_summary(INTEGER) TO authenticated;


-- ── 2. Top-drops RPC: add the email-confirmation transition ─────────────────
-- The confirmation loop is the one clean new transition. checkout_started has
-- no funnel success terminal (completion is the subscription_started
-- activation event), so it is intentionally NOT added as a transition here —
-- it would show a spurious 100% "drop" for every free signup.

CREATE OR REPLACE FUNCTION public.telemetry_auth_funnel_top_drops(
    p_days  INTEGER DEFAULT 7,
    p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
    from_stage      TEXT,
    to_stage        TEXT,
    funnels_at_from BIGINT,
    funnels_at_to   BIGINT,
    drop_count      BIGINT,
    drop_pct        NUMERIC
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days  := LEAST(GREATEST(COALESCE(p_days, 7), 1), 180);
    p_limit := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);

    RETURN QUERY
    WITH funnel_stage AS (
        SELECT
            (t.metadata->>'funnel_id')::text AS funnel_id,
            (t.metadata->>'stage')::text     AS stage,
            t.created_at
        FROM public.client_telemetry t
        WHERE t.kind = 'auth_funnel'
          AND t.created_at > now() - (p_days || ' days')::interval
          AND t.metadata->>'funnel_id' IS NOT NULL
          AND t.metadata->>'stage'     IS NOT NULL
    ),
    transitions(from_stage, to_stage) AS (
        VALUES
            ('landing_view',          'landing_cta_click'),
            ('landing_cta_click',     'signup_view'),
            ('signup_view',           'signup_plan_selected'),
            ('signup_plan_selected',  'signup_first_interaction'),
            ('signup_first_interaction','signup_submit'),
            ('signup_submit',         'signup_succeeded'),
            ('signup_email_confirmation_required', 'email_confirm_link_clicked'),  -- NEW (Phase 3)
            ('signup_succeeded',      'auth_callback_signup'),
            ('signin_view',           'signin_first_interaction'),
            ('signin_first_interaction','signin_submit'),
            ('signin_submit',         'signin_succeeded'),
            ('oauth_button_clicked',  'auth_callback_succeeded'),
            ('password_reset_view',   'password_reset_requested'),
            ('aurora_capture_view',     'aurora_capture_submit'),
            ('aurora_capture_submit',   'aurora_capture_succeeded'),
            ('aurora_capture_succeeded','aurora_confirmed')
    ),
    funnels_with_from AS (
        SELECT tr.from_stage, tr.to_stage, fs.funnel_id
        FROM transitions tr
        JOIN funnel_stage fs ON fs.stage = tr.from_stage
        GROUP BY tr.from_stage, tr.to_stage, fs.funnel_id
    ),
    funnels_with_to AS (
        SELECT tr.from_stage, tr.to_stage, fs.funnel_id
        FROM transitions tr
        JOIN funnel_stage fs ON fs.stage = tr.to_stage
        GROUP BY tr.from_stage, tr.to_stage, fs.funnel_id
    ),
    paired AS (
        SELECT
            f.from_stage,
            f.to_stage,
            COUNT(DISTINCT f.funnel_id)                          AS funnels_at_from,
            COUNT(DISTINCT t.funnel_id) FILTER (WHERE t.funnel_id IS NOT NULL)
                                                                  AS funnels_at_to
        FROM funnels_with_from f
        LEFT JOIN funnels_with_to t
               ON t.from_stage = f.from_stage
              AND t.to_stage   = f.to_stage
              AND t.funnel_id  = f.funnel_id
        GROUP BY f.from_stage, f.to_stage
    )
    SELECT
        p.from_stage,
        p.to_stage,
        p.funnels_at_from,
        p.funnels_at_to,
        (p.funnels_at_from - p.funnels_at_to)                 AS drop_count,
        CASE
            WHEN p.funnels_at_from = 0 THEN 0
            ELSE ROUND(100.0 *
                       (p.funnels_at_from - p.funnels_at_to)::NUMERIC
                       / p.funnels_at_from, 1)
        END                                                   AS drop_pct
    FROM paired p
    WHERE p.funnels_at_from > 0
    ORDER BY (p.funnels_at_from - p.funnels_at_to) DESC,
             p.from_stage
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
   SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.telemetry_auth_funnel_top_drops(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_auth_funnel_top_drops(INTEGER, INTEGER) TO authenticated;


-- ── 3. Drop-offs RPC: add visitor_id + prior_funnels ────────────────────────
-- Widens the RETURNS TABLE again (Phase 2 added referrer/utm/device; Phase 3
-- adds visitor_id + prior_funnels), so DROP then CREATE.
--   • visitor_id  — the funnel's persistent anonymous id (context block).
--   • prior_funnels — how many OTHER funnels this same visitor started earlier
--     in the window. > 0 means a repeat visitor; a repeat visitor stalling
--     again is a stronger signal than a one-off bounce.

DROP FUNCTION IF EXISTS public.telemetry_auth_funnel_dropoffs(INTEGER, INTEGER, INTEGER);

CREATE FUNCTION public.telemetry_auth_funnel_dropoffs(
    p_days        INTEGER DEFAULT 7,
    p_limit       INTEGER DEFAULT 50,
    p_grace_secs  INTEGER DEFAULT 120
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
    referrer      TEXT,
    utm_source    TEXT,
    utm_campaign  TEXT,
    device        TEXT,
    visitor_id    TEXT,
    prior_funnels BIGINT
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days       := LEAST(GREATEST(COALESCE(p_days, 7), 1), 90);
    p_limit      := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
    p_grace_secs := LEAST(GREATEST(COALESCE(p_grace_secs, 120), 0), 3600);

    RETURN QUERY
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
        SELECT DISTINCT ON (w.fid)
            w.fid, w.stage, w.metadata, w.route, w.created_at
        FROM window_rows w
        ORDER BY w.fid, w.created_at DESC
    ),
    ctx AS (
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
    ),
    -- Per-funnel start time + resolved visitor id, used to count how many
    -- earlier funnels the same visitor already had in the window.
    starts AS (
        SELECT
            w.fid,
            MIN(w.created_at)                              AS started_at,
            NULLIF((SELECT x.context->>'visitor_id' FROM ctx x WHERE x.fid = w.fid), '') AS vid
        FROM window_rows w
        GROUP BY w.fid
    ),
    prior AS (
        SELECT
            s.fid,
            COUNT(s2.fid) FILTER (
                WHERE s2.vid IS NOT NULL
                  AND s2.fid <> s.fid
                  AND s2.started_at < s.started_at
            ) AS prior_funnels
        FROM starts s
        LEFT JOIN starts s2 ON s2.vid = s.vid
        GROUP BY s.fid
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
        LEFT(NULLIF(x.context->>'device', ''), 20)                 AS device,
        LEFT(NULLIF(x.context->>'visitor_id', ''), 64)             AS visitor_id,
        COALESCE(pr.prior_funnels, 0)::BIGINT                      AS prior_funnels
    FROM latest l
    JOIN counts c ON c.fid = l.fid
    LEFT JOIN ctx x ON x.fid = l.fid
    LEFT JOIN prior pr ON pr.fid = l.fid
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


-- ── 4. Visitor summary RPC: the pre-auth population view ────────────────────
-- Answers "who are our anonymous visitors?" keyed on the persistent
-- visitor_id, which the per-tab funnel_id could never do:
--   • distinct_visitors  — distinct visitor_ids active in the window
--   • new_visitors       — of those, ones with exactly ONE funnel ever
--   • returning_visitors — of those, ones with ≥2 funnels ever (been here before)
--   • converted_visitors — of those, ones who ever reached a success terminal
--   • repeat_bouncers    — returning visitors who have NEVER converted (the
--                          "keeps coming back but never gets through" cohort)
--   • avg_funnels        — avg distinct funnels per visitor in the window
--
-- "ever" = across all auth_funnel rows that carry a visitor_id, so the
-- returning / bounce signal strengthens as data accumulates. Before this
-- migration ships no rows carry visitor_id, so early results read as
-- all-new / zero-returning — expected, not a bug.

CREATE OR REPLACE FUNCTION public.telemetry_funnel_visitor_summary(
    p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
    distinct_visitors  BIGINT,
    new_visitors       BIGINT,
    returning_visitors BIGINT,
    converted_visitors BIGINT,
    repeat_bouncers    BIGINT,
    avg_funnels        NUMERIC
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
    p_days := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);

    RETURN QUERY
    -- fid → visitor id, resolved once per funnel from the context block.
    WITH fid_vid AS (
        SELECT DISTINCT ON (t.metadata->>'funnel_id')
            (t.metadata->>'funnel_id')::text                         AS fid,
            NULLIF(t.metadata->'context'->>'visitor_id', '')::text   AS vid,
            t.created_at
        FROM public.client_telemetry t
        WHERE t.kind = 'auth_funnel'
          AND t.metadata->'context'->>'visitor_id' IS NOT NULL
        ORDER BY (t.metadata->>'funnel_id'), t.created_at ASC
    ),
    -- Per funnel: did it ever reach a success terminal, and when did it start?
    fid_meta AS (
        SELECT
            (t.metadata->>'funnel_id')::text AS fid,
            bool_or(t.metadata->>'stage' = ANY (v_success)) AS converted,
            MIN(t.created_at) AS started_at
        FROM public.client_telemetry t
        WHERE t.kind = 'auth_funnel'
          AND t.metadata->>'funnel_id' IS NOT NULL
        GROUP BY (t.metadata->>'funnel_id')
    ),
    -- Visitors active in the window (started a funnel within p_days).
    win_visitors AS (
        SELECT DISTINCT fv.vid
        FROM fid_vid fv
        JOIN fid_meta fm ON fm.fid = fv.fid
        WHERE fv.vid IS NOT NULL
          AND fm.started_at > now() - (p_days || ' days')::interval
    ),
    -- All-time per-visitor rollup (funnel count + ever-converted).
    all_time AS (
        SELECT
            fv.vid,
            COUNT(DISTINCT fv.fid)         AS total_funnels,
            bool_or(fm.converted)          AS ever_converted
        FROM fid_vid fv
        JOIN fid_meta fm ON fm.fid = fv.fid
        WHERE fv.vid IS NOT NULL
        GROUP BY fv.vid
    ),
    -- Window-scoped funnel count per visitor, for the avg.
    win_counts AS (
        SELECT fv.vid, COUNT(DISTINCT fv.fid) AS n
        FROM fid_vid fv
        JOIN fid_meta fm ON fm.fid = fv.fid
        WHERE fv.vid IS NOT NULL
          AND fm.started_at > now() - (p_days || ' days')::interval
        GROUP BY fv.vid
    )
    SELECT
        COUNT(*)::BIGINT                                                       AS distinct_visitors,
        COUNT(*) FILTER (WHERE a.total_funnels = 1)::BIGINT                    AS new_visitors,
        COUNT(*) FILTER (WHERE a.total_funnels >= 2)::BIGINT                   AS returning_visitors,
        COUNT(*) FILTER (WHERE a.ever_converted)::BIGINT                       AS converted_visitors,
        COUNT(*) FILTER (WHERE a.total_funnels >= 2 AND NOT a.ever_converted)::BIGINT AS repeat_bouncers,
        COALESCE(ROUND(AVG(wc.n), 2), 0)                                       AS avg_funnels
    FROM win_visitors w
    JOIN all_time a   ON a.vid = w.vid
    LEFT JOIN win_counts wc ON wc.vid = w.vid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
   SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.telemetry_funnel_visitor_summary(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_funnel_visitor_summary(INTEGER) TO authenticated;


-- ── Smoke tests (as a superadmin) ───────────────────────────────────────────
--   SELECT * FROM public.telemetry_auth_funnel_summary(30)
--     WHERE stage IN ('email_confirm_link_clicked','checkout_started');
--   SELECT funnel_id, visitor_id, prior_funnels
--     FROM public.telemetry_auth_funnel_dropoffs(7, 50, 120);
--   SELECT * FROM public.telemetry_funnel_visitor_summary(30);
