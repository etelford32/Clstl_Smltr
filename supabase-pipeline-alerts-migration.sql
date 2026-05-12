-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Pipeline Alert State (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Adds rate-limit state to public.pipeline_heartbeat so the
-- /api/cron/pipeline-watchdog cron can decide whether to send an
-- alert email or skip (already alerted recently).
--
-- Without this column the watchdog would either spam an email every
-- 30 minutes for a long-running outage, or have to keep its own
-- state somewhere — both worse than a single column on the row that
-- triggers the alert in the first place.
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.pipeline_heartbeat
    ADD COLUMN IF NOT EXISTS last_alert_at TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════════
-- record_pipeline_alert_sent(name)
-- Called by the watchdog cron after a successful Resend send.
-- Trivial helper, but keeping the column write inside a SECURITY
-- DEFINER function means the cron endpoint never needs row-write
-- privileges on pipeline_heartbeat directly — its only Supabase
-- contact surface is the SECURITY DEFINER RPCs.
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.record_pipeline_alert_sent(p_name TEXT)
RETURNS void AS $$
    UPDATE public.pipeline_heartbeat
       SET last_alert_at = now(),
           updated_at    = now()
     WHERE pipeline_name = p_name;
$$ LANGUAGE sql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.record_pipeline_alert_sent(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_pipeline_alert_sent(TEXT) FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════
-- 1. Confirm the column exists:
--      SELECT column_name, data_type
--        FROM information_schema.columns
--       WHERE table_schema = 'public'
--         AND table_name   = 'pipeline_heartbeat'
--         AND column_name  = 'last_alert_at';
--
-- 2. Confirm the function exists and has the right grants:
--      SELECT proname, prosecdef
--        FROM pg_proc
--       WHERE proname = 'record_pipeline_alert_sent';
-- ═══════════════════════════════════════════════════════════════
