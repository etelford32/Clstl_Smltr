# Auth flow — current state + automation candidates

A reference for the next iteration on `signin.html` / `signup.html` and the
post-signup journey. Snapshot taken alongside the Phase-3 onboarding work.

## Inventory

### Sign in (`signin.html`, ~446 lines)
- **Method**: email + password (primary) plus **Google OAuth** via
  `auth.signInWithProvider('google')`. The `Continue with Google`
  button renders below the divider when `js/config.js`
  `SOCIAL_PROVIDERS` includes `'google'`. Apple is staged behind the
  same flag — code paths are provider-agnostic; flipping the flag
  after configuring Apple in the Supabase dashboard turns it on.
- **OAuth callback**: Supabase redirects to `/auth-callback.html`
  (which must be on the project's Redirect URLs allow-list). The
  callback page hydrates the session, distinguishes new vs returning
  users, fires `signup` + welcome-email POST for new users (with the
  same idempotency guarantees the password flow uses), and bounces
  to `/dashboard.html`.
- **Reset path**: separate form on the same page, calls
  `supabase.auth.resetPasswordForEmail()`.
- **Telemetry** *(new this PR)*:
  - `signin_succeeded` activation event with `metadata.retry_count`
    (sessionStorage counter incremented on each failure).
  - No anonymous `signin_failed` event — RLS forbids unauth writes; the
    retry-count proxy is the only failure signal.
- **Redirects**: `auth.getPostLoginRedirect()` if set, else `dashboard.html`.

### Sign up (`signup.html`, ~698 lines)
- **Method**: email + password + name + plan dropdown.
- **Plan paths**:
  - `free` / class-seat redemption / comp invite → straight to dashboard
    (with `pp_welcome_pending=1` set in localStorage so the welcome
    wizard fires on the next dashboard load).
  - paid plan → Stripe checkout → returns to dashboard with same flag set.
- **Email confirmation**:
  - When Supabase requires it, the success view shows "Check your email"
    and the user has to click a link before signing in.
  - Otherwise, the user is auto-signed-in by `auth.signUp()` and we
    redirect immediately.
- **Telemetry** *(new this PR)*: `signup` activation event with
  `metadata.plan` and `metadata.source` (`invite` vs `organic`).

### Sessions
- **Storage**: Supabase JWT in localStorage (default) or sessionStorage
  (`remember = false`). Mirrored to a `pp_auth` JSON for legacy code that
  hasn't migrated to the auth module.
- **Refresh**: Supabase client auto-refreshes tokens.
- **Sign-out**: `auth.signOut()` clears both stores.

## What works well
1. **Single source of truth** for plan + role on the client (`js/auth.js`
   delegates feature gates to `tier-config.js`).
2. **Welcome wizard flag** survives the Stripe round-trip, so paid
   signups land on the wizard the same as free.
3. **Activation funnel** is finally collecting clean data after fixing
   the `isLoggedIn`/`isSignedIn` typo in `js/activation.js` (the
   pre-existing bug silently dropped every event since the table was
   created).

## Gaps + automation candidates

### Auth method gaps
1. ~~No social signin~~ — **Google SHIPPED**, Apple staged. The
   `Continue with Google` button renders on signin + signup behind
   the `SOCIAL_PROVIDERS` flag in `js/config.js`; flipping the flag
   to include `'apple'` after configuring the provider in the
   Supabase dashboard turns Apple on in the same UI surface.
   Operator runbook: `OAUTH_SETUP.md`.
2. **No magic-link / passwordless** option. Supabase Auth supports it
   (`signInWithOtp`); useful for users who lose passwords. ~1 day of
   work including the reset-flow merge.
3. **Password reset is "lost in the inbox" by design.** No in-app
   confirmation of "reset email sent" beyond the toast — users come
   back asking "did it work?" Could surface a "Resend" button after
   60s.

### Telemetry gaps
1. ~~`signin_failed` is a fake event right now.~~ **SHIPPED**. New
   `auth_failures` table fed by the SECURITY DEFINER `log_auth_failure`
   RPC, called fire-and-forget by `signin.html` via the
   `/api/auth/log-failure` edge function. Plaintext email is HMAC-SHA-
   256-hashed with a server-side pepper before persisting, so we can
   count distinct failing emails without storing PII. Rate-limited at
   10/hour/email_hash to keep abuse out. The admin Onboarding > Auth
   flow card now shows the real failure count and per-user failure
   rate alongside the existing retry-count proxy.
2. **No tracking of email-confirm completion.** When email-confirm is
   required, we don't know whether the user ever clicked the link. A
   `profile_completed` trigger on confirm would close the loop — Supabase
   exposes `auth.users.confirmed_at`.
3. **No funnel for paid signups.** The Stripe checkout abandonment rate
   is invisible to us — could log a `checkout_started` event before the
   redirect and reconcile with the Stripe webhook on completion.

### Automation candidates
The drumbeat below is what we'd realistically build with the existing
edge-function + Resend infrastructure.

1. **Welcome email** (T+0 minutes after signup) — **SHIPPED**.
   `signup.html` success branch fires a fire-and-forget POST to
   `/api/welcome/send`. The edge function verifies the JWT, checks for
   an existing `welcome_email_sent` activation event (idempotency
   pre-check; the unique partial index in
   `supabase-welcome-email-migration.sql` is the authoritative gate),
   builds the welcome HTML with the user's display name + plan label,
   sends via Resend, and logs the activation event. Send rate +
   per-signup ratio surface on the admin Onboarding → Auth flow card.
2. **Onboarding nudge** (T+24h if `wizard_completed` not fired) — **SHIPPED**.
   Vercel cron at `/api/cron/onboarding-nudge` runs daily at 16:30 UTC,
   calls `pending_onboarding_nudges(24, 7, 200)` to fetch users whose
   signup is 24h–7d old without a `wizard_completed` row, and emails
   each one a friendly "finish setting up" message with a deep link
   `/dashboard?welcome=1` that re-opens the wizard. Idempotent at
   three layers: cron schedule, RPC pre-filter, unique partial index
   on `nudge_sent`. Send count + per-signup ratio surface on the
   admin Onboarding > Auth flow card. Manual ops invocations:
   `?dry=1` (no Resend, masked emails) and `?max=N` (canary cap).
3. **Inactivity re-engagement** (T+14d / T+30d after last session).
   Joins `user_profiles.updated_at` against `activation_events`; emails
   users who've gone quiet with a "what's new" digest. Suppress for
   anyone who's actively unsubscribed (need an unsubscribe link / pref
   first — `/account#notifications` already has the toggle).
4. **First aurora-visible nudge** (event-driven, not time-driven).
   When the SWPC alert engine fires `geomagnetic_storm_warning` AND
   the user has saved a location whose latitude is now within the
   aurora oval, send a one-off "go look up" email even if they don't
   have email_alerts on. This is the "we promised personalised alerts —
   here's the value" moment.
5. **Stripe checkout abandonment recovery** (T+24h after
   `checkout_started` without `subscription_started`). Email with the
   plan summary + a link straight back into checkout.
6. **Class-roster nudge for educators** (T+7d after seat redemption
   if `< 3` students joined). Reminds the educator that they have
   capacity left and can invite more students from `/account#team`.

### What's next
**1.** ~~Welcome email~~ — **shipped**. The plumbing is now proven; the
remaining items can reuse the same `/api/welcome/send` shape (JWT
verify → idempotency check → Resend send → activation log).

**2.** ~~`signin_failed` edge endpoint~~ — **shipped**. The admin card
now shows real failure counts; the next signal-quality improvement is
slicing the `reason` string into a small histogram (the table already
stores it; the RPC just needs to expose a top-N).

**3.** ~~Onboarding nudge cron~~ — **shipped**. Once the cron has run
for a couple weeks the nudge-rate column on the admin card will tell
us whether the wizard friction is meaningful or marginal.

**4.** ~~Google OAuth~~ — **shipped**. Apple is **wired and waiting**:
brand button + click handler are in `js/oauth-buttons.js`,
`auth-callback.html` handles its return URL identically to Google's,
and `OAUTH_SETUP.md` § Apple is now a complete step-by-step (App ID
→ Services ID → .p8 key → Supabase paste → flag flip). One config
change (`SOCIAL_PROVIDERS = ['google', 'apple']`) ships the button
the moment the Apple developer + Supabase steps are done.

**5.** Top-N reasons histogram for `auth_failures.reason` so an admin
can spot a sudden spike in (e.g.) "Email not confirmed" without
opening Supabase logs.

**6.** Magic-link / passwordless (`signInWithOtp`) — useful for users
who lose passwords; reduces support tickets but rarely the headline
issue.

Everything else can wait until we have data on which gap actually
moves the activation needle. The OAuth + email-automation triad is
the headline activation work; the items above are polish.

## 2026-07-28 robustness pass (returning users + subscribers)

Telemetry-driven review of "sign-in is messed up" reports. Findings and
fixes (branch `claude/parkers-physics-signin-robustness-5ouogw`):

1. **CDN single point of failure (the headline).** 950
   `auth_init_fallback_to_mock` failures across 811 of 1,595 sessions in
   45 days: jsDelivr's supabase-js ESM bundle wouldn't load (blockers,
   proxies), so auth silently fell to MOCK mode on production — where
   sign-in "succeeds" with any credentials into a fake session.
   * `js/supabase-config.js` now tries jsDelivr → esm.sh → unpkg with an
     8 s cap per attempt and remembers the last working CDN per session.
   * `auth.signIn()` refuses mock-accepting credentials when Supabase IS
     configured but unreachable (honest "can't reach the sign-in
     service" error instead of a fake success). localhost + webdriver
     keep mock sign-in, so dev servers and Playwright are unaffected.
     Mock session *restore* is untouched — an already-signed-in user
     still keeps a degraded session through a CDN blip.
   * Vendoring the client into the repo (no CDN at all) would be
     stronger, but CLAUDE.md §9 reserves that call for the author.
2. **Stale `pp_auth` split-brain for returning users.** When the
   Supabase session died on its own (expired/revoked refresh token),
   nothing cleared the `pp_auth` mirror, and nav.js + the dashboard gate
   trust it → signed-in nav over a dead session. auth.js now clears
   supabase-written mirrors (provider === 'supabase' only, so mock/test
   seeds survive) on SIGNED_OUT and on a restore that finds no session.
3. **Subscriber demotion on transient profile-fetch failure.** Session
   restore/sign-in persisted the bare mapped user (plan 'free', role
   'user') over the mirror before `fetchProfile`; one RLS/network blip
   left a paying user rendered as free (admins demoted too). The early
   persist now carries over profile-owned fields from the stored mirror
   (same account only), and `fetchProfile` retries transient failures
   (2 s / 8 s, two attempts). The §"persist before fetchProfile"
   ordering is unchanged — it's load-bearing.
4. **The password-side funnel was dark.** signin/signup's classic
   scripts captured `window.ppFunnel` before the deferred modules set
   it: 269 `signin_view` rows, zero `signin_submit`/`signin_succeeded`
   ever. Both pages now resolve the funnel lazily per call.
5. **Apple button rendered while Apple OAuth is unconfigured.**
   `SOCIAL_PROVIDERS` had drifted to `['google','apple']` (in an
   unrelated ring-current PR) while OAUTH_SETUP.md documents Apple as
   staged; every click would error. Back to `['google']` until the
   Apple steps are actually done.
6. **signOut hardening.** Guarded + 4 s-capped + `scope:'local'` — a
   network failure or already-revoked token can no longer strand the
   user unable to sign out, and signing out one browser no longer
   revokes every device's session.
7. **OAuth callback poll extended 3 s → ~9.5 s** — slow PKCE exchanges
   on mobile links were being declared failures while they completed.

Known gaps left OPEN deliberately: the "Remember me" checkbox still
doesn't change Supabase's storage (JWT always lands in localStorage —
docs claiming sessionStorage-when-unchecked are wrong, and honoring it
would mean a custom storage adapter; author's call). `client_telemetry.
user_id` is null on 100% of rows — setUserToken piping deserves its own
look. The six `oauth_redirect_misland` recoveries (latest 2026-07-23)
mean a Supabase redirect-allow-list entry is still missing or stale —
that's a dashboard config fix, not a code fix.
