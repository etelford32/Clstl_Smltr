-- supabase-auth-funnel-visitor-stitch-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Adds visitor_id as a FALLBACK JOIN KEY to the funnel drop-off RPC so the
-- landing_cta_click → signup_view handoff stops reading as abandonment when it
-- is really identity fragmentation across a tab boundary.
--
-- WHY (the diagnostic that motivated this):
--   funnel_id is a per-tab UUID (sessionStorage). signup.html boots with a
--   FRESH sessionStorage — a new tab / fresh session — so it mints a NEW
--   funnel_id. A join keyed on funnel_id therefore CANNOT stitch the CTA click
--   (tab A) to the signup view (tab B): a one-off join over client_telemetry
--   recovered ZERO landing_cta_click→signup_view handoffs by funnel_id, even
--   though the visitor plainly continued. That is fragmentation, not a UX leak.
--
--   The companion client change (js/auth-funnel.js) now writes the persistent,
--   cross-tab visitor_id (localStorage pp_vid) as a top-level `visitor_id` on
--   EVERY auth_funnel event — not just the once-per-funnel context block — so a
--   fallback join key exists on the very rows this RPC pairs.
--
-- WHAT this migration does:
--   1. Indexes metadata->>'visitor_id' for auth_funnel rows (mirrors the
--      existing funnel_id index) so the fallback join stays fast.
--   2. Replaces telemetry_auth_funnel_top_drops so its stitch key is a
--      SESSION-BOUNDED VISITOR identity that falls back to funnel_id:
--        • If a funnel carries a visitor_id anywhere, its events join under
--          'v:<visitor_id>:<visit#>' — so sibling tabs of the SAME sitting
--          collapse to one journey and the cross-tab handoff is credited.
--        • If a funnel has no visitor_id (pre-instrumentation rows, or
--          localStorage blocked), its events keep 'f:<funnel_id>' — IDENTICAL
--          to the old per-tab behaviour. The change is therefore additive:
--          nothing regresses for rows that lack the new key.
--
-- SESSION BOUNDING — why visit#, not raw visitor_id:
--   visitor_id persists forever, so grouping a whole window by visitor_id alone
--   would merge genuinely separate return visits (Monday's bounce + Tuesday's
--   signup) into one journey and OVERSTATE conversion. We only want to bridge
--   the tab boundary WITHIN a single sitting (landing → signup.html seconds
--   later), so a new "visit" starts after a gap longer than v_session_gap_min.
--   Rows without a visitor_id are never sessionised, so a long idle inside one
--   tab is never split.
--
-- SEMANTIC NOTE (read before "fixing" the column names):
--   funnels_at_from / funnels_at_to now count STITCHED JOURNEYS, not raw tabs.
--   That is the correct denominator for a conversion drop. The columns keep
--   their names for admin-UI compatibility (the Onboarding card calls this RPC
--   as telemetry_auth_funnel_top_drops(30, 8) and reads these columns by name).
--   telemetry_auth_funnel_summary.distinct_funnels is deliberately LEFT as a
--   per-tab count — it answers "how many browser tabs reached this stage", a
--   legitimately tab-scoped question — so this migration does not touch it.
--
-- Privacy posture is unchanged: visitor_id is a random UUID with no PII,
-- first-party operational telemetry, the same id the visitor already carries
-- for experiments/analytics. See ANALYTICS.md "Privacy posture".
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Fallback-join index ───────────────────────────────────────────────────
-- Mirrors idx_client_telemetry_funnel_id (base migration) for the new key.
CREATE INDEX IF NOT EXISTS idx_client_telemetry_funnel_visitor
    ON public.client_telemetry ((metadata->>'visitor_id'), created_at)
    WHERE kind = 'auth_funnel';


-- ── 2. Top-drops RPC: stitch on session-bounded visitor_id, fall back to funnel_id ──
-- Same signature, same RETURNS TABLE, same transitions as the Phase-3 version
-- (supabase-auth-funnel-phase3-migration.sql) — only the funnel_stage CTE's
-- stitch key changes. CREATE OR REPLACE keeps the (INTEGER, INTEGER) signature
-- so existing callers and grants are undisturbed.
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
DECLARE
    -- Session window: two events of the same visitor more than this many
    -- minutes apart start a new "visit". 30 min is the conventional session
    -- gap; the CTA→signup tab handoff happens in seconds, well inside it.
    v_session_gap_min CONSTANT INTEGER := 30;
BEGIN
    IF NOT public.is_superadmin() THEN
        RAISE EXCEPTION 'forbidden: superadmin only' USING ERRCODE = '42501';
    END IF;
    p_days  := LEAST(GREATEST(COALESCE(p_days, 7), 1), 180);
    p_limit := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);

    RETURN QUERY
    WITH raw AS (
        SELECT
            (t.metadata->>'funnel_id')::text AS funnel_id,
            (t.metadata->>'stage')::text     AS stage,
            t.created_at,
            -- Prefer the per-event visitor_id (new instrumentation, on every
            -- event); fall back to the context-block copy for older rows.
            NULLIF(COALESCE(t.metadata->>'visitor_id',
                            t.metadata->'context'->>'visitor_id'), '')::text AS raw_vid
        FROM public.client_telemetry t
        WHERE t.kind = 'auth_funnel'
          AND t.created_at > now() - (p_days || ' days')::interval
          AND t.metadata->>'funnel_id' IS NOT NULL
          AND t.metadata->>'stage'     IS NOT NULL
    ),
    -- Resolve ONE visitor_id per funnel. The per-event copy is on every new
    -- event, but a funnel that carried it only in its context block (or on a
    -- subset of events) still gets it backfilled onto all of its events here.
    -- Funnels with no visitor_id anywhere stay NULL → funnel_id fallback below.
    fvid AS (
        SELECT funnel_id, MAX(raw_vid) AS vid
        FROM raw
        GROUP BY funnel_id
    ),
    ev AS (
        SELECT r.stage, r.created_at, r.funnel_id, f.vid
        FROM raw r
        JOIN fvid f USING (funnel_id)
    ),
    -- Mark the first event of each visitor visit (gap-and-islands). Rows with
    -- no visitor_id are left at 0 so they never trigger a split.
    marked AS (
        SELECT
            ev.stage,
            ev.created_at,
            ev.funnel_id,
            ev.vid,
            CASE
                WHEN ev.vid IS NULL THEN 0
                WHEN LAG(ev.created_at) OVER (PARTITION BY ev.vid ORDER BY ev.created_at) IS NULL THEN 1
                WHEN ev.created_at - LAG(ev.created_at) OVER (PARTITION BY ev.vid ORDER BY ev.created_at)
                     > (v_session_gap_min || ' minutes')::interval THEN 1
                ELSE 0
            END AS new_visit
        FROM ev
    ),
    -- The STITCH key. Aliased `funnel_id` so every CTE below is byte-for-byte
    -- the Phase-3 logic — only what "a funnel" means has widened to "a
    -- session-bounded visitor journey, or a lone tab when no visitor_id".
    funnel_stage AS (
        SELECT
            CASE
                WHEN m.vid IS NULL THEN 'f:' || m.funnel_id
                ELSE 'v:' || m.vid || ':' ||
                     SUM(m.new_visit) OVER (
                         PARTITION BY m.vid ORDER BY m.created_at
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                     )::text
            END              AS funnel_id,
            m.stage,
            m.created_at
        FROM marked m
    ),
    transitions(from_stage, to_stage) AS (
        VALUES
            ('landing_view',          'landing_cta_click'),
            ('landing_cta_click',     'signup_view'),
            ('signup_view',           'signup_plan_selected'),
            ('signup_plan_selected',  'signup_first_interaction'),
            ('signup_first_interaction','signup_submit'),
            ('signup_submit',         'signup_succeeded'),
            ('signup_email_confirmation_required', 'email_confirm_link_clicked'),  -- Phase 3
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


-- ── 3. Verification (run manually as superadmin after applying) ──────────────
-- Before/after the landing_cta_click→signup_view drop should shrink once the
-- client change has been live long enough for visitor_id to populate both
-- stages within one visit:
--
--   SELECT * FROM public.telemetry_auth_funnel_top_drops(30, 20)
--    WHERE from_stage = 'landing_cta_click' AND to_stage = 'signup_view';
--
-- Sanity: rows with NO visitor_id must produce the SAME numbers as before —
-- confirm on historical data (all pre-instrumentation) that funnels_at_from
-- is unchanged from the Phase-3 definition.
