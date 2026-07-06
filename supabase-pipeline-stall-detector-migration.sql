-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Pipeline stall detector
-- Run in the Supabase SQL Editor (or via the MCP).
-- ═══════════════════════════════════════════════════════════════
-- Why this exists:
--   pipeline_heartbeat is updated by the Vercel cron handlers
--   (record_pipeline_success / record_pipeline_failure). When the
--   Vercel cron itself goes silent — disabled by a plan-limit drop,
--   a paused project, a failed deploy — the heartbeat row freezes
--   at the last attempt the cron made. The dashboard shows "critical
--   · 28d stale" which reads like "the upstream is broken", masking
--   the real problem: the cron is not firing at all.
--
--   This is the diagnosis we hit on 2026-04-27: weather_grid froze at
--   updated_at = 2026-04-27 11:00 UTC, consecutive_fail = 36. The
--   handler always writes the heartbeat — even worker-timeouts hit a
--   record_pipeline_failure via the in-handler watchdog — so a frozen
--   updated_at means the handler is never being invoked.
--
-- What this migration does:
--   1. Adds public.detect_stalled_pipelines(jsonb) — for every
--      pipeline_heartbeat row whose updated_at is older than the
--      pipeline's threshold, calls record_pipeline_failure() with
--      reason 'cron_silent_stall: heartbeat unchanged for Xm
--      (threshold Ym)'. Each call increments consecutive_fail and
--      refreshes updated_at, so the row stays "warm" and the
--      pipeline-watchdog email actually fires.
--   2. Schedules detect_stalled_pipelines() at */30 via pg_cron.
--
-- What this migration does NOT do:
--   - It does not bring the Vercel cron back to life. That's a
--     Vercel-side fix (check plan/billing/deploys). This detector
--     just makes silent stalls VISIBLE in the admin dashboard and
--     in the watchdog alert email, so the next stall is caught in
--     minutes rather than weeks.
--   - It does not change the existing heartbeat writers. The
--     pg_cron job runs from inside Supabase — it does NOT call any
--     external API, so it doesn't share the Open-Meteo per-IP
--     limit risk that motivated unscheduling refresh_weather_grid.
--
-- Per-pipeline thresholds (default jsonb):
--   weather_grid             120 m   (cron cadence: hourly)
--   solar_wind                10 m   (cron cadence: 1 min)
--   refresh_saved_locations   90 m   (cron cadence: 30 min)
--   _default                 120 m   (fallback for any unknown pipeline)
--
-- Safe to re-run: function is CREATE OR REPLACE; cron schedule is
-- unscheduled-then-rescheduled inside the DO block.
-- ═══════════════════════════════════════════════════════════════

-- ── Function ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.detect_stalled_pipelines(
    p_thresholds jsonb DEFAULT '{
        "weather_grid": 120,
        "solar_wind": 10,
        "refresh_saved_locations": 90,
        "_default": 120
    }'::jsonb
)
RETURNS TABLE(pipeline_name text, mins_silent integer, threshold_min integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    r          record;
    mins_age   integer;
    threshold  integer;
    reason     text;
BEGIN
    FOR r IN
        SELECT h.pipeline_name AS name, h.updated_at
          FROM public.pipeline_heartbeat h
    LOOP
        -- Pick the per-pipeline threshold, else the _default key, else 120.
        threshold := COALESCE(
            NULLIF(p_thresholds ->> r.name, '')::integer,
            NULLIF(p_thresholds ->> '_default', '')::integer,
            120
        );
        mins_age := GREATEST(0, (EXTRACT(EPOCH FROM (now() - r.updated_at)) / 60)::integer);

        IF mins_age > threshold THEN
            reason := format(
                'cron_silent_stall: heartbeat unchanged for %s min (threshold %s min)',
                mins_age, threshold
            );
            PERFORM public.record_pipeline_failure(r.name, reason);

            -- Return one row per flagged pipeline so the pg_cron job's
            -- last-result log is self-explanatory.
            pipeline_name := r.name;
            mins_silent   := mins_age;
            threshold_min := threshold;
            RETURN NEXT;
        END IF;
    END LOOP;
    RETURN;
END;
$$;

-- Lock the function down: only the Supabase superuser and the pg_cron
-- service role need to execute it. Anon/authenticated roles must not.
REVOKE ALL ON FUNCTION public.detect_stalled_pipelines(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.detect_stalled_pipelines(jsonb) FROM anon, authenticated;

COMMENT ON FUNCTION public.detect_stalled_pipelines(jsonb) IS
$cmt$For each pipeline_heartbeat row whose updated_at is older than the
per-pipeline threshold (jsonb arg, falls back to _default key, falls
back to 120 min), call record_pipeline_failure() with a
'cron_silent_stall' reason. Returns the flagged pipelines so the
pg_cron last-result log is self-explanatory.$cmt$;

-- ── Schedule ────────────────────────────────────────────────────
DO $$
BEGIN
    -- Drop the prior schedule on re-run so we don't end up with
    -- duplicate cron entries (pg_cron allows two jobs with the same
    -- jobname only since v1.5; we don't want to depend on that).
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'detect-stalled-pipelines') THEN
        PERFORM cron.unschedule('detect-stalled-pipelines');
        RAISE NOTICE 'Unscheduled previous detect-stalled-pipelines job.';
    END IF;

    PERFORM cron.schedule(
        'detect-stalled-pipelines',
        '*/30 * * * *',
        -- Use the function's default thresholds. Tune by re-running
        -- the migration with a different default jsonb, or by
        -- re-scheduling with an explicit literal here.
        $sql$SELECT public.detect_stalled_pipelines();$sql$
    );
    RAISE NOTICE 'Scheduled detect-stalled-pipelines at */30 * * * *.';
END $$;

-- ═══════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════
-- 1. Function exists and is callable:
--      SELECT * FROM public.detect_stalled_pipelines();
--    Expect: one row per currently-stalled pipeline.
--    Example today: weather_grid | 37847 | 120
--
-- 2. Cron job is scheduled:
--      SELECT jobid, jobname, schedule, active
--        FROM cron.job
--       WHERE jobname = 'detect-stalled-pipelines';
--    Expect: one row, schedule = '*/30 * * * *', active = true.
--
-- 3. After the next */30 tick (or after running the function
--    manually as in step 1), the weather_grid heartbeat row's
--    updated_at and last_failure_at should refresh and
--    consecutive_fail should increment:
--      SELECT pipeline_name, consecutive_fail, last_failure_reason,
--             updated_at
--        FROM public.pipeline_heartbeat
--       WHERE pipeline_name = 'weather_grid';
--    Expect: updated_at = (just now), last_failure_reason starting
--    with 'cron_silent_stall:'.
--
-- 4. The next pipeline-watchdog run (every 30 min from Vercel) will
--    then see a non-cooldown'd candidate and — if RESEND_API_KEY
--    and ALERT_OPS_EMAIL are set in Vercel env — fire the alert
--    email. If those env vars aren't set, the watchdog will keep
--    skipping silently; see api/cron/pipeline-watchdog.js for the
--    no_resend_key / no_ops_email branches.
-- ═══════════════════════════════════════════════════════════════
