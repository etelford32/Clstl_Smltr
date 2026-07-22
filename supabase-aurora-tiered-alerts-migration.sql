-- supabase-aurora-tiered-alerts-migration.sql
-- APPLIED 2026-07-22 to aijsboodkivnhzfstvdq on the author's explicit go
-- (migration name: aurora_tiered_alerts_ledger). Verified post-apply:
-- both ledger columns present, confirm_token backfill complete (0 nulls),
-- confirmed-status partial index in place. The cron's migration guard
-- remains as defense for other environments.
-- (flux-rope Phase 4 — the AurOracle alert-sender fix.)
--
-- Per-subscriber ledger for the tiered sender (api/cron/aurora-alerts.js):
-- WATCH → WARNING → NOWCAST, evaluated per subscriber against the
-- kp_threshold / lat / lon / city columns that
-- supabase-aurora-alert-prefs-migration.sql added but nothing ever read.
-- The sender fires on tier escalation immediately and re-fires the same
-- tier only after a 24 h cooldown — these two columns are that memory.
--
-- Service-role-only access pattern (the cron uses the service key; no new
-- policies — aurora_subscribers already carries its RLS posture). Additive
-- and idempotent.

alter table public.aurora_subscribers
    add column if not exists last_alert_tier text
        check (last_alert_tier in ('watch', 'warning', 'nowcast')),
    add column if not exists last_alert_at timestamptz;

-- Older rows predating the confirm-token default must still be able to
-- unsubscribe from per-recipient tier mail (?token= link).
update public.aurora_subscribers
   set confirm_token = gen_random_uuid()
 where confirm_token is null;

-- The sender's hot path: confirmed subscribers only.
create index if not exists aurora_subscribers_confirmed_idx
    on public.aurora_subscribers (status)
 where status = 'confirmed';
