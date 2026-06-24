# Sign-in health check — daily "can users actually sign in?" automation

A daily synthetic probe that signs a dedicated test account through the real
Supabase auth surface and records whether it worked. It exists so the recurring
"is sign-in broken?" question has an automated, always-on answer instead of
waiting for a user (or you) to notice.

> Background: the live Google sign-in outage was a Supabase **redirect-URL**
> config gap (the `?from=` query on the callback didn't match the allow-list, so
> Supabase fell back to the Site URL root). This automation catches the *backend*
> classes of breakage — auth down, RLS/schema drift, a disabled provider — that
> would silently lock users out.

## What it checks (daily, 13:00 UTC)

`api/cron/auth-healthcheck.js` runs four probes against `SUPABASE_URL`:

| Probe | How | Pass means |
|---|---|---|
| **password** | `POST /auth/v1/token?grant_type=password` as the test account | A session JWT can be minted |
| **profile** | With that JWT, `GET /rest/v1/user_profiles?id=eq.<uid>` | A signed-in user can read its own row → **can pass the dashboard gate** |
| **google** | `GET /auth/v1/settings` → `external.google === true` | The Google OAuth provider is still enabled/wired |
| **magiclink** | `POST /auth/v1/otp` *(opt-in: `HEALTHCHECK_MAGICLINK=1`)* | The magic-link path is alive. **Off by default** — it emails the test inbox each run |

**Overall verdict** = `password && profile && google`. (Magic-link is reported
but never fails the run unless you choose to wire it in.)

## Where results go

- **`auth_healthcheck_log`** — one rich row per run (per-method ok + detail + latency). Service-role-only table; read by admins via the `auth_healthcheck_summary()` RPC.
- **`pipeline_heartbeat`** (`auth_signin`) — `record_pipeline_success/failure`, so the existing **`pipeline-watchdog`** cron also emails on a 3-run fail streak and the row shows on the admin heartbeat card.
- **Email (Resend), same-day** — on the first failing run, `auth-healthcheck` emails `ALERT_OPS_EMAIL` immediately (with a ~20h cooldown so a multi-day outage doesn't spam). This is faster than the watchdog's streak alert.
- **Admin dashboard** — `admin.html` → Onboarding tab → **"Sign-in health check"** card: overall pill (`USERS CAN SIGN IN` / `SIGN-IN FAILING`), per-method ✓/✗, latency, and recent pass-rate.

## One-time setup

1. **Apply the migration** (creates the log table + read RPC + seeds the heartbeat row):
   ```bash
   psql "$SUPABASE_DB_URL" -f supabase-auth-healthcheck-migration.sql
   ```
2. **Create the dedicated test account** (idempotent; resets the password if it exists):
   ```bash
   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
   AUTH_HEALTHCHECK_EMAIL=signin-healthcheck@parkersphysics.com \
   AUTH_HEALTHCHECK_PASSWORD='<strong-password>' \
   node scripts/setup-auth-healthcheck-user.mjs
   ```
3. **Set env vars in Vercel** (Project → Settings → Environment Variables):

   | Var | Purpose |
   |---|---|
   | `AUTH_HEALTHCHECK_EMAIL` / `AUTH_HEALTHCHECK_PASSWORD` | the test account |
   | `SUPABASE_SERVICE_KEY` | writes the log + heartbeat (usually already set) |
   | `SUPABASE_ANON_KEY` | public client key (optional — falls back to the project publishable key) |
   | `RESEND_API_KEY` + `ALERT_OPS_EMAIL` | failure email (reuses the watchdog's setup) |
   | `CRON_SECRET` | recommended — lets you trigger the route manually |
   | `HEALTHCHECK_MAGICLINK=1` | optional — enable the magic-link probe |

4. The cron is already registered in `vercel.json`. It runs on the next deploy.

## Run it on demand

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "https://parkersphysics.com/api/cron/auth-healthcheck?source=manual" | jq
```
`200` = all green, `207` = a probe failed (see `results`).

## When it goes red — triage

- **password fails** → Supabase Auth down, the test account got disabled, or its password drifted from the env var (re-run the setup script).
- **profile fails** but password passes → RLS on `user_profiles` changed, or the `handle_new_user` trigger never created the row. This is the "signed in but can't reach the site" signal.
- **google fails** → the Google provider was toggled off in Authentication → Providers (this won't catch a redirect-URL allow-list regression — that's a client-side concern; see `OAUTH_SETUP.md`).
