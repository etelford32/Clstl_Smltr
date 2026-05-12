-- supabase-auth-funnel-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Adds an `auth_funnel` event kind to client_telemetry so the intro / sign-in
-- / sign-up flow can be measured stage-by-stage, plus a summary RPC for the
-- admin Onboarding > Auth flow card.
--
-- Why client_telemetry and not analytics_events?
--   * analytics_events writes are gated by cookie-consent in js/analytics.js.
--     Most of the funnel happens BEFORE the user has interacted with the
--     consent banner, so consent-gated tables are blind to it.
--   * client_telemetry writes go through /api/telemetry/log which is anon-
--     allowed by design (it's how we capture pre-signin errors). It carries
--     no PII, no cookies, no fingerprinting — first-party operational
--     telemetry that legitimately bypasses the analytics consent gate.
--
-- Privacy posture for `auth_funnel` rows:
--   * No email, no name, no IP (the edge function logs IP separately).
--   * Stage names are an internal vocabulary, not user-supplied.
--   * Metadata limited to enums and short identifiers (provider, plan, etc.)
--   * `funnel_id` is a per-tab UUID stored in sessionStorage — it cannot be
--     joined to anything across sessions / devices.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Extend the kind CHECK constraint ──────────────────────────────────────
-- The existing constraint on client_telemetry locks `kind` to a closed set.
-- We need to add 'auth_funnel' without dropping the table; Postgres requires
-- a DROP-then-ADD on CHECK constraints to widen them.

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
        'auth_funnel'    -- NEW: intro / sign-in / sign-up / OAuth callback stages
    ));

-- Mirror the constraint widening into log_client_telemetry()'s in-RPC
-- whitelist, otherwise the RPC will silently CONTINUE past every
-- auth_funnel event the edge function forwards.
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
            'web_vital','app_perf','auth_funnel'
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


-- ── 2. Stage-aware index ─────────────────────────────────────────────────────
-- Funnel summary queries always group by metadata->>'stage'. Functional index
-- so a 30-day window stays sub-second even at hundreds of millions of rows.
CREATE INDEX IF NOT EXISTS idx_client_telemetry_funnel_stage
    ON public.client_telemetry ((metadata->>'stage'), created_at DESC)
    WHERE kind = 'auth_funnel';

-- Per-funnel session correlation index — for debugging individual user
-- journeys via the stitch RPC below.
CREATE INDEX IF NOT EXISTS idx_client_telemetry_funnel_id
    ON public.client_telemetry ((metadata->>'funnel_id'), created_at)
    WHERE kind = 'auth_funnel';


-- ── 3. RPC: telemetry_auth_funnel_summary ────────────────────────────────────
-- Returns one row per stage with its event count, distinct funnel_ids
-- (i.e. distinct browser tabs), and the conversion ratio against the
-- preceding "anchor" stage in the funnel definition. Superadmin only.
--
-- Stage order is hard-coded here — it's the canonical funnel that the
-- admin card renders. New stages need to be added explicitly so an
-- accidental client-side typo doesn't show up as a fake funnel branch.

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
            -- intro / landing
            ('landing_view',                  10),
            ('landing_cta_click',             20),
            -- signup
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
            ('signup_succeeded',              60),
            -- signin
            ('signin_view',                   70),
            ('signin_method_selected',        75),
            ('signin_first_interaction',      78),
            ('signin_validation_error',       79),
            ('signin_submit',                 80),
            ('signin_failed',                 85),
            ('signin_succeeded',              90),
            -- secondary auth methods
            ('oauth_button_clicked',          92),
            ('magic_link_resend_clicked',     93),
            ('magic_link_back_to_password',   94),
            -- password reset
            ('password_reset_view',           95),
            ('password_reset_requested',      96),
            -- callback
            ('auth_callback_enter',          110),
            ('auth_callback_succeeded',      120),
            ('auth_callback_failed',         125),
            ('auth_callback_signup',         130)
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
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.telemetry_auth_funnel_summary(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_auth_funnel_summary(INTEGER) TO authenticated;


-- ── 4. RPC: telemetry_auth_funnel_top_drops ──────────────────────────────────
-- Returns the steepest stage→stage drop-offs in the chosen window, joined
-- on funnel_id. Useful for spotting where users abandon the flow.
--
-- Method: pair each stage with the immediately-following stage in the same
-- funnel_id (LEAD()), then count funnels that had stage A but not stage B.
-- Returns the top N largest absolute drops.

CREATE OR REPLACE FUNCTION public.telemetry_auth_funnel_top_drops(
    p_days  INTEGER DEFAULT 7,
    p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
    from_stage     TEXT,
    to_stage       TEXT,
    funnels_at_from BIGINT,
    funnels_at_to   BIGINT,
    drop_count     BIGINT,
    drop_pct       NUMERIC
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
    -- Canonical stage transitions to evaluate. Hard-coded so noise stages
    -- (e.g. validation_error, oauth_button_clicked) don't pollute the drop
    -- list with spurious "transitions".
    transitions(from_stage, to_stage) AS (
        VALUES
            ('landing_view',          'landing_cta_click'),
            ('landing_cta_click',     'signup_view'),
            ('signup_view',           'signup_plan_selected'),
            ('signup_plan_selected',  'signup_first_interaction'),
            ('signup_first_interaction','signup_submit'),
            ('signup_submit',         'signup_succeeded'),
            ('signup_succeeded',      'auth_callback_signup'),
            ('signin_view',           'signin_first_interaction'),
            ('signin_first_interaction','signin_submit'),
            ('signin_submit',         'signin_succeeded'),
            ('oauth_button_clicked',  'auth_callback_succeeded'),
            ('password_reset_view',   'password_reset_requested')
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
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.telemetry_auth_funnel_top_drops(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_auth_funnel_top_drops(INTEGER, INTEGER) TO authenticated;


-- ── 5. RPC: telemetry_auth_funnel_replay ─────────────────────────────────────
-- Returns the ordered stages for a single funnel_id. For deep-diving a
-- specific user journey (e.g. the one that filed a "sign-in is broken"
-- support ticket).
CREATE OR REPLACE FUNCTION public.telemetry_auth_funnel_replay(
    p_funnel_id TEXT
)
RETURNS TABLE (
    stage      TEXT,
    route      TEXT,
    metadata   JSONB,
    created_at TIMESTAMPTZ
) AS $$
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    IF p_funnel_id IS NULL OR length(p_funnel_id) = 0 THEN
        RAISE EXCEPTION 'p_funnel_id required' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
        SELECT t.metadata->>'stage', t.route, t.metadata, t.created_at
        FROM public.client_telemetry t
        WHERE t.kind = 'auth_funnel'
          AND t.metadata->>'funnel_id' = p_funnel_id
        ORDER BY t.created_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

REVOKE ALL ON FUNCTION public.telemetry_auth_funnel_replay(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.telemetry_auth_funnel_replay(TEXT) TO authenticated;
