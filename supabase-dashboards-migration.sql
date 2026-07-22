-- supabase-dashboards-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- STATUS: APPLIED 2026-07-22 to project aijsboodkivnhzfstvdq on the
-- author's explicit go (migration name: dashboards_cloud_sync). Verified
-- post-apply: table + RLS enabled + 4 ownership policies. The
-- migration-guard in js/dashboard-sync.js remains as defense for other
-- environments (a fresh project without this table gets quiet
-- localStorage-only behavior, never an error).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Named/versioned per-user dashboards (SPACE_WEATHER_DASHBOARD_PLAN.md §6,
-- decision #3 on record: "several per user, org-ready"). One row per
-- (user, page, name); D2 uses a single name 'default' per page — the
-- unique key already carries multi-dashboard and, later, org sharing
-- (an org_id column + policies) without a rewrite.
--
-- doc shape (jsonb): { layout, config, sizes }
--   layout — the Layout Lab v2 doc ({v:2, page, preset, zones})
--   config — the per-panel config store (sanitized scalars)
--   sizes  — the per-panel height overrides
-- The CLIENT normalizes on read (normalizeLayout / sanitizeConfig) — the
-- server stores, it does not interpret. version mirrors LAYOUT_VERSION
-- for future server-side migrations.
--
-- Tier gating (decision #2: Basic+ gates cloud sync): enforced
-- CLIENT-side (js/dashboard-sync.js tierAllowsSync). RLS here enforces
-- OWNERSHIP only — deliberately: a free user hand-crafting REST calls to
-- sync their own layout gains nothing that harms anyone, and keeping the
-- policies plan-agnostic avoids coupling RLS to the user_profiles.plan
-- enum (which has a known tester split — see CLAUDE.md §6). Revisit only
-- if sync volume ever becomes a cost concern.

create table if not exists public.dashboards (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references auth.users(id) on delete cascade,
    page        text not null,
    name        text not null default 'default',
    doc         jsonb not null,
    version     int  not null default 2,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    unique (user_id, page, name)
);

create index if not exists dashboards_user_page_idx
    on public.dashboards (user_id, page);

alter table public.dashboards enable row level security;

-- Ownership-only policies (see header note on tier gating).
create policy dashboards_select on public.dashboards
    for select using (auth.uid() = user_id);
create policy dashboards_insert on public.dashboards
    for insert with check (auth.uid() = user_id);
create policy dashboards_update on public.dashboards
    for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy dashboards_delete on public.dashboards
    for delete using (auth.uid() = user_id);

-- Signed-in surface only — nothing here is part of the anonymous
-- telemetry surface (CLAUDE.md §4.2), so anon gets nothing.
revoke all on public.dashboards from anon;
grant select, insert, update, delete on public.dashboards to authenticated;
