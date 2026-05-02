# Auth flow — current state + automation candidates

A reference for the next iteration on `signin.html` / `signup.html` and the
post-signup journey. Snapshot taken alongside the Phase-3 onboarding work.

## Inventory

### Sign in (`signin.html`, ~446 lines)
- **Method**: email + password only. Supabase Auth via `auth.signIn()` in
  `js/auth.js`.
- **Reset path**: separate form on the same page, calls
  `supabase.auth.resetPasswordForEmail()`.
- **Social auth**: placeholder comment at line ~297 — *not implemented*.
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
1. **No social signin (Google / Apple / GitHub).**
   Supabase Auth supports OAuth providers natively — wiring a third
   provider is a config change + button. Recommended next move: Google,
   then Apple if there's iOS demand. The signin.html placeholder comment
   already anticipates this.
2. **No magic-link / passwordless** option. Supabase Auth supports it
   (`signInWithOtp`); useful for users who lose passwords. ~1 day of
   work including the reset-flow merge.
3. **Password reset is "lost in the inbox" by design.** No in-app
   confirmation of "reset email sent" beyond the toast — users come
   back asking "did it work?" Could surface a "Resend" button after
   60s.

### Telemetry gaps
1. **`signin_failed` is a fake event right now.** RLS on
   `activation_events` blocks unauth writes. To actually log failed
   signins we need either (a) a server-side edge endpoint that wraps
   Supabase's `signInWithPassword` and logs the failure with the
   service-role key, or (b) a separate `auth_failures` table with
   permissive insert RLS (gated on rate-limit). Option (a) is cleaner
   because the rate limit is automatic via Supabase's own auth flow.
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
2. **Onboarding nudge** (T+24h if `wizard_completed` not fired).
   Cron job (pg_cron) reads `activation_events` for users who have
   `signup` but not `wizard_completed`; fires a "finish setup" email
   with a deep link `/dashboard?welcome=1`.
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

**2.** Add a server-side `signin_failed` endpoint (item 1 in telemetry
gaps) — the current retry_count proxy is fine for headline metrics, but
debugging a real auth regression needs the actual error reasons.

**3.** Onboarding nudge (item 2 in automation) — biggest potential
activation-rate lift; the wizard is already wired, the cron just has to
ping users who didn't finish. Reuses the welcome-email pattern with a
window query (`signup` ∧ ¬`wizard_completed` ∧ created > 24h ago).

**4.** Social signin (Google, then Apple). Cuts password-related
support tickets and shrinks the signup form to one click. Mostly a
config + UI sprint.

Everything else can wait until (2)–(4) are deployed and we have data
on which gap actually moves the activation needle.
