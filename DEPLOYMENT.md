# Parker Physics — Deployment Guide

End-to-end deployment for **parkersphysics.com**: the static front-end +
Vercel Edge Functions in `/api/**`, the Supabase database + auth, the
Stripe billing integration, and the email + cron pipeline.

For local development, see `QUICK_START.md`.

## 🌐 Web Deployment via Vercel

The site deploys as a static asset bundle plus serverless Edge Functions
under `/api/*`. There is no build step for the front-end (HTML/JS shipped
verbatim); the only build action is `bash build-wasm.sh` for the Rust →
WASM bundles in `/rust/www`.

1. **Connect the GitHub repo** to a Vercel project (Vercel dashboard →
   Add new → Project → import this repo). Default settings work; Vercel
   reads `vercel.json` for build/output/cron configuration.

2. **Set Production environment variables** (see the Supabase Setup
   section below for the full list). Mark every secret value as
   **Sensitive** so the value isn't visible to project collaborators or
   captured in build logs.

3. **Set the production domain alias** to `parkersphysics.com`
   (Vercel dashboard → Project → Settings → Domains).

4. **Push to `main`** — Vercel auto-deploys. Cron jobs declared in
   `vercel.json` register on the next production deploy.

## 🔐 Supabase Setup & Admin Bootstrap

Required once per Supabase project, before the first sign-up. The
migrations are idempotent — safe to re-run if you ever rebuild.

**1. Apply the schema migrations in order** (Supabase Dashboard → SQL
Editor → paste each file → Run):

```
# Foundational schema
supabase-schema.sql                       # core tables, RLS, helpers
supabase-migration.sql                    # role + tester support extension
supabase-admin.sql                        # admin RPCs, is_admin() helper

# Saved-locations + per-plan limits
supabase-multi-location-migration.sql     # per-plan saved-location caps

# Weather pipeline
supabase-weather-cache-migration.sql      # weather_grid_cache table
supabase-weather-pgcron-migration.sql     # original pg_cron Open-Meteo refresh
supabase-weather-pgcron-fix-migration.sql # SSL/timeout fix for above
supabase-weather-unschedule-migration.sql # un-schedule pg_cron once Vercel cron took over

# Pipeline observability + supplementary feeds
supabase-pipeline-heartbeat-migration.sql # admin "Pipeline Health" backing tables
supabase-solar-wind-migration.sql         # solar-wind ring buffer
supabase-solar-wind-freshness-fix.sql     # freshness gate fix for above
supabase-polar-vortex-migration.sql       # polar_vortex_snapshots schema

# Security + auditing
supabase-security-tighten-migration.sql   # analytics + session RLS hardening
supabase-invites-email-migration.sql      # email-targeted invites + RPCs
supabase-email-rate-limit-migration.sql   # DB-backed email rate limit + audit
supabase-schema-hardening-migration.sql   # role/endpoint CHECKs + delete_user_data RPC
supabase-retention-cron-migration.sql     # analytics/alert retention + cron-status RPC

# Onboarding-blocker fixes (added April 2026 — REQUIRED before opening signups)
supabase-daily-digest-migration.sql       # per-location digest opt-in column
supabase-plan-lockdown-migration.sql      # blocks self-grant of paid plans (CRITICAL)

# Educator wedge (April 2026)
supabase-class-seats-migration.sql        # class-seat invite RPCs + activation_events table
```

If any `CREATE EXTENSION` line errors out (`pg_cron`, `http`), enable
the extension via Database → Extensions in the Supabase dashboard,
then re-run the migration.

**2. Set Vercel environment variables** (Project → Settings →
Environment Variables, scope = Production):

| Var | Required for | Sensitive? |
|---|---|---|
| `SUPABASE_URL` | every `/api/*` endpoint | no |
| `SUPABASE_SERVICE_KEY` | every `/api/*` endpoint (service_role, server-only) | **yes** |
| `RESEND_API_KEY` | `/api/alerts/email`, `/api/cron/daily-forecast-digest`, `/api/invites/send` | **yes** |
| `INVITE_FROM_EMAIL` | optional; defaults to `Parker Physics <invites@parkersphysics.com>` | no |
| `ALERT_FROM_EMAIL` | optional; defaults to `Parker Physics Alerts <alerts@parkersphysics.com>` | no |
| `APP_URL` | optional; defaults to `https://parkersphysics.com` (used in invite magic links) | no |
| `STRIPE_SECRET_KEY` | paid tiers (Stripe API calls from `/api/stripe/*`) | **yes** |
| `STRIPE_*_PRICE_ID` | one per price; maps Stripe → plan tier | no |
| `STRIPE_WEBHOOK_SECRET` | `/api/stripe/webhook` signature verification | **yes** |
| `CRON_SECRET` | `/api/cron/*` Bearer token (recommended over `x-vercel-cron` fallback) | **yes** |
| `METNO_USER_AGENT` | optional; identifies us to MET Norway | no |

**3. Promote the first admin** — after you've signed up your own
account through `/signup`, run this in the Supabase SQL Editor (one
time per project, replace the email with yours):

```sql
UPDATE public.user_profiles
   SET role = 'superadmin'
 WHERE id = (
     SELECT id FROM auth.users WHERE email = 'you@example.com'
 );
```

There is no UI path for this on purpose — `is_admin()` gates
admin-only routes in the database, so the very first admin must be
promoted out-of-band. Subsequent admins can be promoted by an
existing `superadmin` from the admin dashboard.

**4. Sanity check** — sign in, visit `/admin`, confirm the dashboard
loads (KPIs, Email Activity, Invites tabs all populate). If "Not
authorized" appears, the role update didn't apply or the JWT hasn't
refreshed; sign out, sign back in.

**5. Recommended Supabase Auth hardening** (Dashboard → Authentication
→ Providers / Policies, no code change):
- Password minimum length: 10+
- Enable "Protect against breached passwords" (HaveIBeenPwned check)
- Session timeout: 7 days for normal users, shorter for staff
- Confirm email enabled (default)

**6. Account-deletion runbook** (handle a user's deletion request):

```sql
-- Step 1: find the UUID
SELECT id, email FROM auth.users WHERE email = 'user@example.com';

-- Step 2: wipe public-schema PII + anonymize logs
SELECT * FROM public.delete_user_data('<uuid>'::uuid);
-- Returns row counts; verify they look sensible.
```

Then **Step 3**: delete the `auth.users` row from the Supabase
Dashboard (Authentication → Users → row menu → Delete user) or from
a server-side context with the service-role key
(`supabase.auth.admin.deleteUser('<uuid>')`). The public-schema RPC
deliberately can't reach `auth.users` from plpgsql.

**Step 4** if the user had a paid plan: void/refund the Stripe
subscription via the Stripe Dashboard. Future work is wrapping all
four steps behind a single `/api/admin/delete-user` endpoint.

## 🛡️ Vercel Firewall — required rate-limit rules

These rules live in the Vercel dashboard, not in `vercel.json`, so this
section is the system-of-record for what should be configured. After
provisioning a new Vercel project for this codebase, recreate them here:

**Vercel dashboard → Project → Firewall → Rate Limiting → Add rule**

| Rule | Path pattern | Limit | Action |
|---|---|---|---|
| `forecast-per-ip`         | `/api/weather/forecast`         | 60 req / min / IP | 429, 60s deny window |
| `weather-grid-per-ip`     | `/api/weather/grid`             | 30 req / min / IP | 429, 60s deny window |
| `alerts-email-per-ip`     | `/api/alerts/email`             | 20 req / min / IP | 429, 60s deny window |

**Why:** The hourly forecast strip (added in `claude/add-location-forecasting`)
fans out one `/api/weather/forecast?type=hourly` call per saved location on
every dashboard render. A 25-saved-location Pro user is already a 25× amplifier
at the application layer, so abuse from a logged-in attacker scales fast.
60 req/min is well above any legitimate dashboard load (one render = ~25
calls; bouncing a refresh every 5 s for diagnostics is ~5 req/s = 300/min,
still flagged but not user-blocking).

WAF rate limits block **before** the function invokes, which means a blocked
request costs nothing (no Vercel function $, no Open-Meteo quota). This is
strictly cheaper than any in-code limiter.

**Cron auth (recommended):** also set `CRON_SECRET` in
**Vercel → Project → Settings → Environment Variables** so the cron
endpoints can drop their `x-vercel-cron`-header fallback if needed.

## 🚀 Onboarding Readiness Checklist

Single source of truth before opening signups to paying users.
Each item is independently verifiable; if you can't tick it, don't open
the front door yet.

### Vercel — environment variables

- [ ] All secrets marked **Sensitive** (Vercel will nag with a
      "Needs Attention" badge until you do):
  - `RESEND_API_KEY`
  - `SUPABASE_SERVICE_KEY` (and `SUPABASE_SECRET_KEY` if dual-named)
  - `STRIPE_SECRET_KEY`
  - `STRIPE_WEBHOOK_SECRET`
  - `STEAM_WEB_API_KEY` (if used)
- [ ] `CRON_SECRET` set and **Sensitive**
- [ ] Production domain alias = `parkersphysics.com`

### Supabase — migrations applied (in order)

Run all 19 in the order listed in the Supabase Setup section above.
The two onboarding-blocker migrations at the end (`supabase-daily-digest-migration.sql`,
`supabase-plan-lockdown-migration.sql`) are required for paid-tier integrity:

- [ ] `supabase-daily-digest-migration.sql` — adds the `daily_digest_enabled` column
- [ ] `supabase-plan-lockdown-migration.sql` — closes the two plan-self-grant paths.
      Verify with the queries inline at the bottom of that file:
  - Self `UPDATE plan='advanced'` returns `42501 / insufficient_privilege`
  - `signUp({ options: { data: { plan: 'advanced' } } })` results in `plan='free'`

### Vercel Firewall — rate-limit rules

- [ ] `forecast-per-ip` @ 60 req/min/IP
- [ ] `weather-grid-per-ip` @ 30 req/min/IP
- [ ] `alerts-email-per-ip` @ 20 req/min/IP

### Stripe — billing wiring

- [ ] Webhook endpoint = `https://parkersphysics.com/api/stripe/webhook`
- [ ] Selected events: `checkout.session.completed`, `customer.subscription.created`,
      `customer.subscription.updated`, `customer.subscription.deleted`
- [ ] `STRIPE_WEBHOOK_SECRET` copied to Vercel as **Sensitive**
- [ ] Webhook test event delivered + appears in `email_send_log` /
      `user_profiles.subscription_status` updates correctly
- [ ] Webhook fails-CLOSED if the secret is missing
      (verified by `api/stripe/webhook.js` change in commit `4e333cc`)

### Resend — email pipeline

- [ ] Sending domain (`parkersphysics.com`) verified with DKIM/SPF in Resend
- [ ] `ALERT_FROM_EMAIL` and `INVITE_FROM_EMAIL` use addresses on the verified domain
- [ ] Test send via dry-run cron:
      `curl -H "Authorization: Bearer $CRON_SECRET" "https://parkersphysics.com/api/cron/daily-forecast-digest?dry=1"`
      → returns `{ ok: true, dryRun: true, scanned, previewSample: [...] }` with
      no Resend invocation

### Cron health — admin dashboard

- [ ] `/admin` → Pipeline Health: zero red rows in the last 24h
- [ ] All 6 crons registered in `vercel.json` are firing on schedule:
      ```
      0 * * * *      /api/cron/refresh-weather-grid
      */5 * * * *    /api/cron/prewarm-hot
      */30 * * * *   /api/cron/prewarm-medium
      0 */6 * * *    /api/cron/prewarm-cold
      0 11 * * *     /api/cron/daily-forecast-digest
      */30 * * * *   /api/cron/refresh-saved-locations
      ```
- [ ] `/api/cron/daily-forecast-digest` real run (not dry-run) reports
      `sent > 0` once at least one user has `daily_digest_enabled = true`

### Smoke tests — paid-tier integrity (RUN BEFORE OPENING DOORS)

- [ ] Sign up new account → confirm `plan = 'free'` in `user_profiles`
- [ ] Attempt direct `UPDATE` of own plan via Supabase JS SDK → expect `42501`
- [ ] Attempt signup with `options.data.plan = 'advanced'` → confirm row lands as `'free'`
- [ ] Stripe test-mode checkout → webhook grants the correct plan tier
- [ ] Cancel subscription → webhook downgrades to `'free'`
- [ ] User can save locations up to their per-plan cap (5 / 25), not beyond
- [ ] User can enable digest only up to their per-plan cap (5 / 10), not beyond
- [ ] Hourly strip renders with valid forecast data for a saved location
- [ ] Daily digest email arrives at the user's address (set timezone tolerance ±1h around 11:00 UTC)

## 🆘 Need help?

Open an issue on the GitHub repo or check the admin dashboard's
"Pipeline Health" + "Email Activity" panels for live diagnostics.
