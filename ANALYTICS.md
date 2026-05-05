# Analytics & sign-in funnel

The intro / sign-in / sign-up flow has three stacked telemetry pipelines.
Each answers a different question, and they're intentionally separate so a
failure in one never blinds another.

## 1. The conversion funnel — `client_telemetry.kind = 'auth_funnel'`

**What it answers:** "Where do users drop off between landing and a working
session?"

**Where it lives:** the `client_telemetry` table, `kind = 'auth_funnel'`.
Inserted via `/api/telemetry/log` (anon-allowed) using
`telemetry.recordFunnel(stage, metadata)`.

**Why it bypasses cookie-consent:** the events carry no PII, no fingerprint,
no IP (logged separately by the edge function if at all). They're first-party
operational telemetry that legitimately runs before the consent banner has
been touched. Without this, every funnel stage measured pre-consent would be
invisible.

**How to record events:**

```js
import { funnel } from './js/auth-funnel.js';
funnel.step('signin_view');
funnel.step('signin_method_selected', { method: 'magic_link' });
funnel.step('signin_succeeded', { method: 'password', retry_count: 1 });
```

`funnel.step()` automatically attaches:
- `funnel_id` — per-tab UUID stored in `sessionStorage.pp_funnel_id`. Lets
  the admin RPCs stitch a single user's stages together server-side.
- `t_since_landing_ms` — milliseconds since this funnel started. Use this
  to spot users who hesitated or got stuck.
- On the first call only: a `context` block with `page`, `referrer` (origin
  only), `utm` (UTM parameters), `viewport`, `locale`, `device`, `consent`.

### Canonical stages

Stage names are listed in `supabase-auth-funnel-migration.sql` (the
`stages(stage, stage_order)` CTE). Adding a new stage requires updating
that migration too — anything not in the CTE still gets stored, but
won't show up in the ordered funnel summary.

| Page | Stage | When |
|---|---|---|
| index.html | `landing_view` | Page load |
| index.html | `landing_cta_click` | Any `[data-funnel-cta]` click |
| signup.html | `signup_view` | Page load |
| signup.html | `signup_plan_selected` | Plan pill clicked |
| signup.html | `signup_invite_entered` | Invite code entered |
| signup.html | `signup_invite_validated` | Invite RPC returns |
| signup.html | `signup_first_interaction` | First field focus |
| signup.html | `signup_password_strength` | Strength tier crossed (2/4/5) |
| signup.html | `signup_terms_checked` | Terms checkbox toggled |
| signup.html | `signup_validation_error` | Submit blocked by client-side check |
| signup.html | `signup_submit` | Form submit accepted |
| signup.html | `signup_failed` | Auth/Supabase error |
| signup.html | `signup_email_confirmation_required` | Supabase sent confirm email |
| signup.html | `signup_succeeded` | Auto-confirmed signup |
| signin.html | `signin_view` | Page load |
| signin.html | `signin_method_selected` | Magic-link toggle |
| signin.html | `signin_first_interaction` | First field focus |
| signin.html | `signin_validation_error` | Submit blocked |
| signin.html | `signin_submit` | Form submit accepted |
| signin.html | `signin_failed` | Bad credentials / magic-link error |
| signin.html | `signin_succeeded` | Successful sign-in |
| signin.html | `magic_link_resend_clicked` | Resend button |
| signin.html | `magic_link_back_to_password` | Returned to password mode |
| signin.html | `magic_link_sent` | Magic-link email dispatched |
| signin.html | `password_reset_view` | Forgot-password tab opened |
| signin.html | `password_reset_requested` | Reset form submitted |
| signin.html / signup.html | `oauth_button_clicked` | Google/Apple click |
| signin.html / signup.html | `oauth_start_failed` | `auth.signInWithProvider` rejected |
| auth-callback.html | `auth_callback_enter` | Callback page hits boot |
| auth-callback.html | `auth_callback_succeeded` | Returning user |
| auth-callback.html | `auth_callback_signup` | New OAuth/magic-link account |
| auth-callback.html | `auth_callback_failed` | Provider/Supabase error |

### Reading the funnel

Three superadmin RPCs (see migration):

- `telemetry_auth_funnel_summary(days)` — one row per stage with
  occurrences, distinct funnels, distinct users, first/last seen.
- `telemetry_auth_funnel_top_drops(days, limit)` — biggest stage→stage
  drops in the chosen window. Fastest way to find what's broken.
- `telemetry_auth_funnel_replay(funnel_id)` — ordered stage list for
  one specific funnel. Use when debugging a support ticket.

Example queries:

```sql
-- Funnel summary, last 30 days.
select * from public.telemetry_auth_funnel_summary(30);

-- Where are users dropping off this week?
select * from public.telemetry_auth_funnel_top_drops(7, 10);

-- Replay a specific user's journey.
select * from public.telemetry_auth_funnel_replay('11111111-2222-…');
```

## 2. Activation events — `activation_events`

**What it answers:** "Which signed-in users hit landmark milestones?"

These are auth-required idempotent events (`signup`, `first_sim_opened`,
`location_saved`, `wizard_completed`, etc.) backed by a unique partial
index per `(user_id, event)`. Suitable for cohort analysis ("of users who
signed up in May, what % opened a simulation in week 1?").

`logActivation()` short-circuits when there's no Supabase user, so it
cannot replace the funnel for pre-auth stages.

## 3. Page analytics — `analytics_events`

**What it answers:** "Page views, scroll depth, click heatmap, GA4 cross-
property reporting."

Consent-gated (`window.ppConsent.has('analytics')`). Driven by
`js/analytics.js`. Provides `analytics.identify(userId, traits)` which
attaches the user_id to subsequent `analytics_events` rows AND to GA4's
user property store.

Sign-in / sign-up / auth-callback all call `analytics.identify()` on
success — so once a user signs in, every subsequent dashboard event
(scroll, click, custom event) attaches to their user_id without an extra
join against `auth.users`.

## Why three pipelines?

| | Funnel | Activation | Analytics |
|---|---|---|---|
| Anonymous-safe | ✓ | ✗ | partial |
| Cookie-consent required | ✗ | ✗ | ✓ |
| Idempotent at DB layer | ✗ | ✓ | ✗ |
| GA4 mirrored | ✗ | ✗ | ✓ |
| Volume per user | ~10–30 events/journey | ~5–20 events/lifetime | hundreds/session |
| Best for | conversion optimisation | retention cohorts | UX heatmaps + GA4 |

Funnel is the new pipeline added in `supabase-auth-funnel-migration.sql`.
Activation has been around since `supabase-class-seats-migration.sql`.
Analytics has been around since the original `supabase-bootstrap-fresh.sql`.

## Operating notes

- **Privacy floor:** funnel metadata must never include email, password,
  IP, full UA, or any value that could identify a user when joined with
  another column. UTMs are public marketing identifiers — fine.
- **Sample rate:** funnel events are 100% sampled (volume is small —
  bounded by the size of the auth flow). Vitals/perf are still 25%.
- **Retention:** `client_telemetry` rows older than 90 days are pruned
  by the existing telemetry-retention cron. Funnel rows ride along.
- **Dashboards:** add a "Funnel" card to the admin Onboarding tab that
  calls `telemetry_auth_funnel_summary(30)` and renders one bar per
  stage. The drop-offs RPC powers a "Where users get stuck" panel.
- **Schema drift guard:** the `kind` CHECK constraint and the in-RPC
  whitelist must stay in sync. The migration updates both. If you add
  another kind later, do both edits in the same SQL file.
