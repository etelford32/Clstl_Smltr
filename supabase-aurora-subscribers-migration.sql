-- supabase-aurora-subscribers-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- Anonymous aurora-alert email capture. No auth.users coupling.
--
-- Captures email from anonymous burst traffic (aurora / storm events) with
-- zero account friction. Every other email path in this repo requires a
-- Supabase JWT; this one deliberately does not — see AURORA_ALERT_CAPTURE_SPEC.md.
--
-- Security posture mirrors the telemetry surface (supabase-auth-funnel-migration.sql):
--   * RLS on, NO policies → anon/auth roles cannot touch the table directly.
--   * The edge function (api/subscribe/*.js) uses the service-role key, which
--     bypasses RLS; the three SECURITY DEFINER RPCs below ARE the public API.
--   * RPCs are EXECUTE-able by service_role only — NOT anon. The endpoint, not
--     the browser, calls them. This is stricter than the telemetry RPCs (which
--     are anon-callable) because there is no reason for a browser to reach the
--     subscription RPCs directly.
--   * search_path pinned to `public` to dodge the mutable-search-path advisor.
--
-- Privacy: email + UTM only. No IP, no fingerprint — matches the privacy floor
-- in ANALYTICS.md. Keep it that way.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.aurora_subscribers (
    id              uuid primary key default gen_random_uuid(),
    email           text not null,
    status          text not null default 'pending'
                        check (status in ('pending','confirmed','unsubscribed')),
    confirm_token   uuid not null default gen_random_uuid(),
    source          text,                       -- capturing page, e.g. 'earth'
    utm             jsonb,                       -- {source,medium,campaign}
    created_at      timestamptz not null default now(),
    confirmed_at    timestamptz,
    unsubscribed_at timestamptz
);

-- Case-insensitive uniqueness without the citext extension dependency.
create unique index if not exists aurora_subscribers_email_lower_uidx
    on public.aurora_subscribers (lower(email));
create index if not exists aurora_subscribers_token_idx
    on public.aurora_subscribers (confirm_token);
create index if not exists aurora_subscribers_status_idx
    on public.aurora_subscribers (status) where status = 'confirmed';

alter table public.aurora_subscribers enable row level security;
-- No policies → anon/auth roles cannot touch the table directly.
-- Service role (used by the edge fn) bypasses RLS; RPCs below are the API.

-- ── RPC: subscribe ────────────────────────────────────────────────────────
-- Idempotent. Always returns a token for a 'pending' row so the endpoint can
-- (re)send confirmation. For already-confirmed emails returns status only and
-- a NULL token (endpoint then sends nothing → no enumeration via email send).
create or replace function public.subscribe_aurora(
    p_email  text,
    p_source text default null,
    p_utm    jsonb default null
) returns table (out_status text, out_token uuid)
language plpgsql security definer set search_path = public as $$
declare
    v_email text := lower(trim(p_email));
    v_row   public.aurora_subscribers;
begin
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        raise exception 'invalid_email' using errcode = '22023';
    end if;

    select * into v_row from public.aurora_subscribers
        where lower(email) = v_email;

    if not found then
        insert into public.aurora_subscribers (email, source, utm)
        values (v_email, p_source, p_utm)
        returning * into v_row;
        return query select 'pending'::text, v_row.confirm_token;
    elsif v_row.status = 'confirmed' then
        return query select 'already_confirmed'::text, null::uuid;
    else  -- pending or previously unsubscribed → re-arm as pending
        update public.aurora_subscribers
           set status          = 'pending',
               confirm_token   = gen_random_uuid(),
               source          = coalesce(p_source, source),
               utm             = coalesce(p_utm, utm),
               unsubscribed_at = null
         where id = v_row.id
        returning * into v_row;
        return query select 'pending'::text, v_row.confirm_token;
    end if;
end $$;

-- ── RPC: confirm ──────────────────────────────────────────────────────────
create or replace function public.confirm_aurora(p_token uuid)
returns table (out_email text, out_status text)
language plpgsql security definer set search_path = public as $$
declare v_row public.aurora_subscribers;
begin
    update public.aurora_subscribers
       set status = 'confirmed', confirmed_at = coalesce(confirmed_at, now())
     where confirm_token = p_token
       and status <> 'unsubscribed'
    returning * into v_row;

    if not found then
        return query select null::text, 'invalid'::text;
    else
        return query select v_row.email, 'confirmed'::text;
    end if;
end $$;

-- ── RPC: unsubscribe ──────────────────────────────────────────────────────
create or replace function public.unsubscribe_aurora(p_token uuid)
returns text
language plpgsql security definer set search_path = public as $$
begin
    update public.aurora_subscribers
       set status = 'unsubscribed', unsubscribed_at = now()
     where confirm_token = p_token;
    return 'ok';
end $$;

-- Expose only the RPCs to the service path. Unlike the telemetry RPCs, the
-- subscription RPCs are NOT granted to anon — the browser never calls them
-- directly; the service-role edge function does. This keeps the edge
-- function's rate-limit + honeypot from being bypassed by direct RPC calls.
--
-- NOTE: `REVOKE ... FROM PUBLIC` alone is INSUFFICIENT on this Supabase
-- project. Supabase installs ALTER DEFAULT PRIVILEGES that grant EXECUTE on
-- every new public function to `anon` and `authenticated` directly, so those
-- grants survive a PUBLIC revoke. We must revoke from them explicitly.
revoke all on function public.subscribe_aurora(text,text,jsonb)  from public;
revoke all on function public.confirm_aurora(uuid)               from public;
revoke all on function public.unsubscribe_aurora(uuid)           from public;
revoke execute on function public.subscribe_aurora(text,text,jsonb) from anon, authenticated;
revoke execute on function public.confirm_aurora(uuid)              from anon, authenticated;
revoke execute on function public.unsubscribe_aurora(uuid)          from anon, authenticated;
grant execute on function public.subscribe_aurora(text,text,jsonb) to service_role;
grant execute on function public.confirm_aurora(uuid)              to service_role;
grant execute on function public.unsubscribe_aurora(uuid)          to service_role;
