-- supabase-aurora-broadcast-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Storm-broadcast plumbing for the aurora-alert audience (follow-on to
-- supabase-aurora-subscribers-migration.sql). See §8 of
-- AURORA_ALERT_CAPTURE_SPEC.md.
--
-- The cron (api/cron/aurora-storm-blast.js) reads NOAA Kp; when Kp ≥ 6 it
-- fires ONE Resend Broadcast to AURORA_AUDIENCE_ID. The debounce below turns
-- a multi-day storm into ONE email instead of five: a blast is claimed only
-- if there hasn't been one in the last ~12h.
--
-- Security posture matches the rest of the aurora surface: RLS on, no policies
-- (service-role-only), RPCs are the API and are EXECUTE-able by service_role
-- only (NOT anon/authenticated — Supabase default privileges grant those past
-- a bare REVOKE FROM PUBLIC, so we revoke explicitly).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.aurora_broadcast_log (
    id                  uuid primary key default gen_random_uuid(),
    blasted_at          timestamptz not null default now(),
    kp                  numeric,
    storm_level         int,
    recipients          int,
    resend_broadcast_id text,
    metadata            jsonb
);

create index if not exists aurora_broadcast_log_blasted_at_idx
    on public.aurora_broadcast_log (blasted_at desc);

alter table public.aurora_broadcast_log enable row level security;
-- No policies → service-role-only.

-- ── RPC: try_claim_aurora_blast ───────────────────────────────────────────
-- Atomic debounce. Serializes concurrent cron ticks with a transaction-scoped
-- advisory lock, then inserts a claim row ONLY if the most recent blast is
-- older than p_window_hours. Returns the claim id so the cron can fill in the
-- broadcast id / recipient count after a successful send (or release it on
-- failure so the next tick retries).
create or replace function public.try_claim_aurora_blast(
    p_kp           numeric,
    p_storm_level  int,
    p_window_hours int default 12
) returns table (claimed boolean, claim_id uuid, last_blast_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
    v_last timestamptz;
    v_id   uuid;
begin
    perform pg_advisory_xact_lock(hashtext('aurora_storm_blast'));

    select max(blasted_at) into v_last from public.aurora_broadcast_log;

    if v_last is not null
       and v_last > now() - make_interval(hours => greatest(coalesce(p_window_hours, 12), 1)) then
        return query select false, null::uuid, v_last;
        return;
    end if;

    insert into public.aurora_broadcast_log (kp, storm_level)
    values (p_kp, p_storm_level)
    returning id into v_id;

    return query select true, v_id, v_last;
end $$;

-- ── RPC: record_aurora_blast ──────────────────────────────────────────────
-- Fill in send results on a claimed row (non-fatal best-effort from the cron).
create or replace function public.record_aurora_blast(
    p_id           uuid,
    p_broadcast_id text default null,
    p_recipients   int  default null,
    p_metadata     jsonb default null
) returns text
language plpgsql security definer set search_path = public as $$
begin
    update public.aurora_broadcast_log
       set resend_broadcast_id = coalesce(p_broadcast_id, resend_broadcast_id),
           recipients          = coalesce(p_recipients, recipients),
           metadata            = coalesce(p_metadata, metadata)
     where id = p_id;
    return 'ok';
end $$;

-- ── RPC: release_aurora_blast ─────────────────────────────────────────────
-- Roll back a claim when the Resend send failed, so the next cron tick can
-- retry during the same active storm instead of being suppressed for 12h.
create or replace function public.release_aurora_blast(p_id uuid)
returns text
language plpgsql security definer set search_path = public as $$
begin
    delete from public.aurora_broadcast_log where id = p_id;
    return 'ok';
end $$;

-- ── RPC: unsubscribe_aurora_by_email ──────────────────────────────────────
-- Reconcile path for Resend's native broadcast unsubscribe. The Resend
-- webhook (api/subscribe/resend-webhook.js) hands us an email, not a token,
-- so this flips our DB row to keep aurora_subscribers authoritative.
create or replace function public.unsubscribe_aurora_by_email(p_email text)
returns text
language plpgsql security definer set search_path = public as $$
begin
    update public.aurora_subscribers
       set status = 'unsubscribed', unsubscribed_at = now()
     where lower(email) = lower(trim(p_email))
       and status <> 'unsubscribed';
    return 'ok';
end $$;

-- ── RPC: unsubscribe_aurora (token) — return the email ────────────────────
-- Superseding the bare 'ok' version from the subscribers migration: the
-- token-unsubscribe endpoint (api/subscribe/unsubscribe.js) needs the email
-- back so it can also flip the matching Resend Audience contact. Same return
-- type (text), so CREATE OR REPLACE is safe.
create or replace function public.unsubscribe_aurora(p_token uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare v_email text;
begin
    update public.aurora_subscribers
       set status = 'unsubscribed', unsubscribed_at = now()
     where confirm_token = p_token
    returning email into v_email;
    return v_email;   -- NULL when no row matched
end $$;

-- ── Grants: service-role-only ─────────────────────────────────────────────
revoke all on function public.try_claim_aurora_blast(numeric,int,int)        from public;
revoke all on function public.record_aurora_blast(uuid,text,int,jsonb)       from public;
revoke all on function public.release_aurora_blast(uuid)                     from public;
revoke all on function public.unsubscribe_aurora_by_email(text)              from public;
revoke execute on function public.try_claim_aurora_blast(numeric,int,int)    from anon, authenticated;
revoke execute on function public.record_aurora_blast(uuid,text,int,jsonb)   from anon, authenticated;
revoke execute on function public.release_aurora_blast(uuid)                 from anon, authenticated;
revoke execute on function public.unsubscribe_aurora_by_email(text)          from anon, authenticated;
revoke execute on function public.unsubscribe_aurora(uuid)                   from anon, authenticated;
grant execute on function public.try_claim_aurora_blast(numeric,int,int)     to service_role;
grant execute on function public.record_aurora_blast(uuid,text,int,jsonb)    to service_role;
grant execute on function public.release_aurora_blast(uuid)                  to service_role;
grant execute on function public.unsubscribe_aurora_by_email(text)           to service_role;
grant execute on function public.unsubscribe_aurora(uuid)                    to service_role;
