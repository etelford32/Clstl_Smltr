-- Mirrors supabase-aurora-alert-prefs-migration.sql (repo-root convention copy).
-- Applied to prod 2026-07-19 via MCP apply_migration; recorded there as
-- version 20260719142149. This file keeps supabase/migrations/ replayable
-- for preview branches per SUPABASE_BRANCHING_RUNBOOK.md.

-- supabase-aurora-alert-prefs-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Per-subscriber alert preferences: Kp threshold + location.
--
-- Layered on supabase-aurora-subscribers-migration.sql. The AurOracle alert
-- form always collected a Kp threshold and a location, but the client never
-- put them in the request body, so every subscriber row landed identical and
-- the sender had nothing to trigger on. This migration gives the row a home
-- for those fields and extends subscribe_aurora() to accept them.
--
-- Sender v1 trigger contract: forecast Kp >= kp_threshold → email.
-- (v2 swaps raw Kp for the visibility model evaluated at lat/lon — later.)
--
-- The old 3-arg subscribe_aurora(text,text,jsonb) is DROPPED, not kept as an
-- overload: the edge function calls the RPC with named args via PostgREST,
-- and two signatures that both satisfy {p_email,p_source,p_utm} would make
-- every legacy-shaped call fail with 300 Multiple Choices. The new function
-- defaults the added params to null, so 3-arg callers keep working.
--
-- Security posture is unchanged from the parent migration: service_role
-- only, explicit anon/authenticated revokes (Supabase default privileges
-- re-grant EXECUTE to them on every new function — a PUBLIC revoke alone
-- is insufficient on this project).
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.aurora_subscribers
    add column if not exists kp_threshold numeric default 5,
    add column if not exists lat double precision,
    add column if not exists lon double precision,
    add column if not exists city text;

drop function if exists public.subscribe_aurora(text, text, jsonb);

-- ── RPC: subscribe (v2 — alert prefs) ─────────────────────────────────────
-- Idempotent, same contract as v1: always returns a token for a 'pending'
-- row; already-confirmed emails get status only and a NULL token (endpoint
-- then sends nothing → no enumeration via email send).
--
-- Prefs are coalesced so a re-subscribe with a new threshold/location
-- overwrites, while a legacy 3-arg call (or a body missing the fields)
-- leaves the existing prefs untouched.
create or replace function public.subscribe_aurora(
    p_email text,
    p_source text default null,
    p_utm jsonb default null,
    p_kp numeric default null,
    p_lat double precision default null,
    p_lon double precision default null,
    p_city text default null
) returns table (out_status text, out_token uuid)
language plpgsql security definer set search_path = public as $$
declare
    v_email text := lower(trim(p_email));
    -- The endpoint clamps too; this is the backstop for direct service-role
    -- calls so a bad value can never make the sender fire on every forecast.
    -- NULL must stay NULL (Postgres greatest/least IGNORE nulls, so a bare
    -- greatest(3, p_kp) would turn "not provided" into threshold 3).
    v_kp numeric := case when p_kp is null then null
                         else least(9, greatest(3, p_kp)) end;
    v_row public.aurora_subscribers;
begin
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        raise exception 'invalid_email' using errcode = '22023';
    end if;

    select * into v_row from public.aurora_subscribers
        where lower(email) = v_email;

    if not found then
        insert into public.aurora_subscribers (email, source, utm, kp_threshold, lat, lon, city)
        values (v_email, p_source, p_utm, coalesce(v_kp, 5), p_lat, p_lon, p_city)
        returning * into v_row;
        return query select 'pending'::text, v_row.confirm_token;
    elsif v_row.status = 'confirmed' then
        -- No token (anti-enumeration), but DO honor a prefs update: the
        -- natural way to change your threshold is to submit the form again.
        update public.aurora_subscribers
           set kp_threshold = coalesce(v_kp, kp_threshold),
               lat          = coalesce(p_lat, lat),
               lon          = coalesce(p_lon, lon),
               city         = coalesce(p_city, city)
         where id = v_row.id;
        return query select 'already_confirmed'::text, null::uuid;
    else  -- pending or previously unsubscribed → re-arm as pending
        update public.aurora_subscribers
           set status          = 'pending',
               confirm_token   = gen_random_uuid(),
               source          = coalesce(p_source, source),
               utm             = coalesce(p_utm, utm),
               kp_threshold    = coalesce(v_kp, kp_threshold),
               lat             = coalesce(p_lat, lat),
               lon             = coalesce(p_lon, lon),
               city            = coalesce(p_city, city),
               unsubscribed_at = null
         where id = v_row.id
        returning * into v_row;
        return query select 'pending'::text, v_row.confirm_token;
    end if;
end $$;

revoke all on function public.subscribe_aurora(text,text,jsonb,numeric,double precision,double precision,text) from public;
revoke execute on function public.subscribe_aurora(text,text,jsonb,numeric,double precision,double precision,text) from anon, authenticated;
grant execute on function public.subscribe_aurora(text,text,jsonb,numeric,double precision,double precision,text) to service_role;
