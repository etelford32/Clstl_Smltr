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
  only), `utm` (UTM parameters), `viewport`, `locale`, `device`, `consent`,
  and `visitor_id`.
- `visitor_id` — the persistent, cross-tab anonymous id (localStorage
  `pp_vid`, the SAME id `js/experiments.js` + `js/analytics.js` use). Unlike
  `funnel_id` (per-tab, sessionStorage, un-joinable across sessions), this
  persists, so it is what lets the admin answer *"has this visitor been here
  before?"* — new vs returning vs repeat-bouncer. It rides in the context
  block (once per funnel) **and, since the identity-fragmentation fix, as a
  top-level `visitor_id` on every event** — the latter is the fallback join
  key that stitches a visitor's stages across funnel_ids when a tab boundary
  forks the funnel (landing → signup.html in a fresh tab mints a new per-tab
  `funnel_id`). See the privacy note below before treating this as free.

### Canonical stages

Stage names are listed in `supabase-auth-funnel-migration.sql` (the
`stages(stage, stage_order)` CTE). Adding a new stage requires updating
that migration too — anything not in the CTE still gets stored, but
won't show up in the ordered funnel summary.

| Page | Stage | When |
|---|---|---|
| index.html | `landing_view` | Page load |
| index.html | `landing_cta_click` | Any `[data-funnel-cta]` click (hero `hero_magnetosphere` — the ONE hero ask since 2026-09-06; `hero_signup` / `hero_alerts_submit` are historical, retired after 0 clicks / 0 submits in 60 days — the console chip `console_signup`, the CTA rail `rail_alerts` / `rail_signup`, the post-capture `aurora_capture_upsell`, pricing, depth ladder, footer) |
| index.html / earth.html / gannon / st-patrick | `aurora_capture_view` → `focus` → `submit` → `succeeded` / `failed` | The anonymous email capture (`js/aurora-capture.js`). Every stage carries `source`; index.html carries the `home` (S5 band) placement — `home-hero` (above the fold, 2026-09) is historical, retired 2026-09-06 |
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
| signup.html | `checkout_started` | Paid plan — fired just before the Stripe redirect |
| signin.html | `signin_view` | Page load |
| signin.html | `signin_method_selected` | Magic-link toggle |
| signin.html | `signin_first_interaction` | First field focus |
| signin.html | `signin_signup_cta_click` | "Create a free account" exit clicked (`placement` = sub-line / `signin-create-account` button). Not in the ordered stages CTE — visible in replay + raw rows only |
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
| auth-callback.html | `email_confirm_link_clicked` | Landed via the email-confirm link (`type=signup`) |
| auth-callback.html | `auth_callback_enter` | Callback page hits boot |
| auth-callback.html | `auth_callback_succeeded` | Returning user |
| auth-callback.html | `auth_callback_signup` | New OAuth/magic-link account |
| auth-callback.html | `auth_callback_failed` | Provider/Supabase error |

**Load-order trap (fixed 2026-09).** signin.html / signup.html fire every
post-view stage from CLASSIC `<script>` blocks, which run at parse time —
before any `<script type="module">` has set `window.ppFunnel`. They used to
capture `window.ppFunnel || stub` once, so `signin_first_interaction`,
`signin_submit`, `signin_succeeded`, `signup_first_interaction` … were
silently dropped and the admin card read "signin_view → first_interaction:
100% lost". The pages now resolve `window.ppFunnel` at call time and queue
early calls on `window.ppFunnelQueue`, which `js/auth-funnel.js` drains on
load. `node tests/funnel-shim.mjs` pins the shape; `tests/auth-funnel.spec.js`
observes the stages on the wire. Funnel rows before the fix under-count every
stage after `signin_view` / `signup_view` — don't read a pre-fix "100% lost"
as user behaviour.

### Reading the funnel

Three superadmin RPCs (see migration):

- `telemetry_auth_funnel_summary(days)` — one row per stage with
  occurrences, distinct funnels, distinct users, first/last seen.
- `telemetry_auth_funnel_top_drops(days, limit)` — biggest stage→stage
  drops in the chosen window. Fastest way to find what's broken. Stitches on
  a **session-bounded `visitor_id`** with a `funnel_id` fallback
  (`supabase-auth-funnel-visitor-stitch-migration.sql`), so a handoff that
  crosses a tab boundary — landing → signup.html in a fresh tab, which mints a
  new per-tab `funnel_id` — is counted as a continuation, not abandonment.
  Rows with no `visitor_id` fall back to `funnel_id` and read exactly as
  before. Here "funnels" means stitched journeys, not raw tabs.
- `telemetry_auth_funnel_replay(funnel_id)` — ordered stage list for
  one specific funnel. Use when debugging a support ticket.
- `telemetry_auth_funnel_dropoffs(days, limit, grace)` — one row per
  *stalled* session (latest stage is not a success terminal), carrying
  `reason`/`code`, the first-event traffic context (`referrer`,
  `utm_source`, `utm_campaign`, `device`), and the persistent
  `visitor_id` + `prior_funnels` (how many earlier journeys this visitor
  had). Powers the admin drop-offs list.
- `telemetry_funnel_visitor_summary(days)` — the anonymous-visitor
  population keyed on `visitor_id`: distinct / new / returning / converted
  / repeat-bouncer counts. The pre-auth "do they come back?" view the
  per-tab `funnel_id` could never give.
- `telemetry_funnel_failure_codes(days, limit)` — top-N histogram over the
  stable `code` enum on `*_failed` / `*_validation_error` events, with a
  representative `reason` and the flow (signin/signup/oauth/callback) each
  code appears in most. Groups by `code` so free-text wording drift can't
  fragment it. Pre-enum rows bucket as `(uncategorized)`.
- `telemetry_funnel_dimension_conversion(days, dimension, limit)` —
  per-value outcome breakdown where `dimension ∈ {referrer, utm_source,
  utm_campaign, device}`. Three tiers per source/device: **bounced** (only
  passive views), **engaged** (interacted, didn't convert), **converted**
  (reached a success terminal). Answers "which sources / devices convert vs
  just bounce" even when full conversion is rare. A value with high
  engagement but zero conversion points at a page/flow to fix, not a bad
  source.

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
- **Persistent `visitor_id` posture (Phase 3):** the funnel now carries a
  cross-session anonymous id in its context block. This is a *deliberate*
  softening of the original "per-tab, un-joinable" posture, made so we can
  measure returning visitors and repeat bounces pre-auth. It is defensible
  because the id is a random UUID with **no PII**, is first-party
  operational telemetry, and reuses the id the visitor already carries for
  experiments/analytics (no new tracking surface). It was originally written
  once per funnel (context block only); the **identity-fragmentation fix**
  additionally attaches it as a top-level `visitor_id` on every event so the
  CTA→signup handoff — which crosses a tab boundary and therefore a
  `funnel_id` — remains joinable. The footprint cost is one UUID per event on
  a low-volume, auth-flow-bounded stream. If the threat model tightens, gate
  `getVisitorId()` behind `window.ppConsent.has('analytics')` in **both**
  `captureContext()` and `step()` — but note that gating it blinds the
  pre-consent bounce measurement it exists to provide.
- **Sample rate:** funnel events are 100% sampled (volume is small —
  bounded by the size of the auth flow). Vitals/perf are still 25%.
- **Retention:** `client_telemetry` rows older than 90 days are pruned
  by the existing telemetry-retention cron. Funnel rows ride along.
- **Dashboards:** the admin Activation → Onboarding tab renders three
  funnel surfaces, in order of altitude:
  1. **Auth funnel — stage-by-stage** (`#auth-funnel-summary-container`):
     one bar per canonical stage (distinct browser tabs) from
     `telemetry_auth_funnel_summary(30)`, plus the steepest stage→stage
     losses from `telemetry_auth_funnel_top_drops(30, 8)`. This is the
     "shape of the leak" — where the anonymous population thins out.
  2. **Auth funnel drop-offs** (`#auth-dropoffs-container`): individual
     stalled sessions from `telemetry_auth_funnel_dropoffs(7, 50)`, each
     classified client-side into **viewed only** (landed, never
     interacted — an empty `reason` is EXPECTED, not a bug), **attempted ·
     failed** (`*_failed` / `*_validation_error` — where `reason`/`code`
     live), and **abandoned mid-form**. Filterable by class.
  3. Traffic context (`referrer`, `utm_source`, `utm_campaign`, `device`)
     is joined from each funnel's first-event `context` block by
     `supabase-auth-funnel-dropoffs-context-migration.sql` so a bounce
     cluster can be traced to one bad source. The UI renders these columns
     only when present, so it degrades cleanly before the migration runs.
  4. **Anonymous visitors** (`#funnel-visitor-container`): the pre-auth
     population from `telemetry_funnel_visitor_summary(30)` — distinct /
     first-time / returning / ever-converted / repeat-bouncer counts keyed
     on the persistent `visitor_id`. Distinct from the authenticated
     New-vs-returning card. Drop-off rows also flag `↻ seen N× before` when
     `prior_funnels > 0`. Both land with `supabase-auth-funnel-phase3-migration.sql`
     and read all-zeros until `visitor_id` instrumentation has been live a
     session or two.
  - **Population caveat:** the New-vs-returning, Returning-sessions, and
    Avg-retries cards are **authenticated users only** (sourced from
    `activation_events`), NOT the anonymous funnel above — they're labelled
    as such so the two populations aren't conflated.
- **Failure `code` vs `reason`:** `*_failed` steps now carry a stable
  `code` (from `classifyAuthError()` in `js/auth-funnel.js`) alongside the
  free-text `reason`. `reason` is the human detail; `code` is the closed,
  machine-groupable bucket a top-reasons histogram should group by, since
  Supabase/Resend wording drifts over time. Add a bucket only for a
  genuinely new failure class — unmatched errors fall to `unknown`.
- **Schema drift guard:** the `kind` CHECK constraint and the in-RPC
  whitelist must stay in sync. The migration updates both. If you add
  another kind later, do both edits in the same SQL file.

## 4. Data-pipeline health — `client_telemetry.kind = 'data_pipeline'`

**What it answers:** "Is the live-data plumbing actually working in real
browsers?" — the class of failure CI can't see: a GIBS layer ID retiring,
a snapshot endpoint rejecting timestamps, a regional CDN outage, or a
composite that silently degrades to a fallback.

**Where it lives:** `client_telemetry`, `kind = 'data_pipeline'`.
Recorded via `telemetry.recordPipeline(name, metadata)` — 100% sampled
(volume is bounded by feed cadence, not user count). Migration:
`supabase-cloud-pipeline-telemetry-migration.sql` (constraint + RPC
whitelist move together, same drift guard as the funnel).

**First consumer — the cloud mosaic** (`js/satellite-feed.js`, name
`cloud_mosaic`, at most ~6 events/hour/viewer). One event per refresh:

| metadata key      | meaning                                                    |
|-------------------|------------------------------------------------------------|
| `ok`, `mode`      | fetch outcome; `mosaic` / `modis` fallback / `none`        |
| `ms`              | wall time of the whole refresh                             |
| `regions`         | per-region layer + imagery age, e.g. `GOES-East=…@23m`     |
| `attempts`, `failures`, `failed` | fallback-ladder depth; first failing URLs   |
| `coverage`        | fraction of the globe with confident observation           |
| `mean_cloudiness` | confidence-weighted global cloud fraction                  |
| `gap_max_deg`, `gap_center_lon` | widest low-coverage longitude arc — a value ≥ ~20° names the exact sector that will render as a procedural-cloud wedge |

`severity` is `warning` whenever the refresh fell back or failed, so
`select … where kind='data_pipeline' and severity='warning'` is the
triage query. The full-resolution diagnostics (every URL attempted, per
region) live on `window.__cloudDiag` in the running page.

**Useful queries:**

```sql
-- Fallback / failure rate over the last 7 days
select metadata->>'mode' as mode, count(*)
  from client_telemetry
 where kind = 'data_pipeline' and metadata->>'name' = 'cloud_mosaic'
   and created_at > now() - interval '7 days'
 group by 1;

-- Which layers are rotting (named in the first-failures list)
select metadata->'failed' as failed, count(*)
  from client_telemetry
 where kind = 'data_pipeline' and severity = 'warning'
   and created_at > now() - interval '7 days'
 group by 1 order by 2 desc limit 20;
```

## 5. Site-wide visitor flow — `client_telemetry.kind = 'page_flow'`

**What it answers:** "Where do visitors go, where do they bounce, and how
deeply do they engage — for the FULL population, on every page?"

**Why it exists:** the consent-gated analytics_events pipeline (§3)
structurally cannot answer this. Measured July 2026: 1,722 consent
prompts shown → 29 decisions (17 accept / 12 reject). ~98% of visitors
never touch the banner, so §3 describes roughly 2% of traffic — heavily
biased toward the author and power users. In the same 30 days the
consent-exempt funnel stream saw 1,104 distinct landing visitors.

**Where it lives:** `client_telemetry`, `kind = 'page_flow'`. Emitted by
`js/page-flow.js` (loaded via `js/nav.js` on every page that mounts the
nav — all ~72), logic in `js/page-flow-core.js` (pure; tested by
`tests/page-flow.mjs`), transported by `telemetry.recordFlow()`. 100%
sampled. Migration: `supabase-page-flow-migration.sql` (kind CHECK + RPC
whitelist move together — same drift guard as the funnel).

**Exactly two events per pageview:**

| phase | when | metadata |
|---|---|---|
| `enter` | page load | `pv` (per-pageview join id), `ref` (internal pathname OR external origin), `landing` 0/1, `device`, `visitor_id` |
| `exit`  | pagehide / first tab-hide | `pv`, `dwell_s` (wall), `visible_s`, `active_s` (input-gap engaged time), `clicks`, `scroll_pct`, `exit_to`, `visitor_id` |

Notes that matter when reading the data:

- **A pageview can ship MORE THAN ONE exit** — a tab that re-engages
  after the first hide refreshes its exit (same `pv`). Readers must take
  the max-dwell exit per `pv`; the RPCs do.
- **Transitions come from `enter.ref`, not session ordering.** An
  internal referrer pathname IS the from→to edge, and it survives tab
  boundaries / `target=_blank`, which per-tab session ordering does not.
- **`active_s` vs `dwell_s`:** active is the sum of inter-input gaps
  under 10 s while visible — passively watching a simulation counts
  toward `visible_s` but not `active_s`. A background tab counts toward
  neither. Bots that execute JS typically show dwell with zero active —
  which is why "hard bounce" requires zero clicks AND < 15 s dwell.
- **Privacy floor (same as the funnel, §1):** no PII, no fingerprint, no
  IP, pathname-only pages, origin-only external referrers (queries
  stripped — see `classifyRef`), first-party only, 90-day retention via
  the existing telemetry cron. This is a deliberate extension of the
  Phase-3 posture ("softened for measurement, defensible because no
  PII"): CNIL-style first-party audience measurement. Rollback lever: if
  the threat model tightens, remove the `import './page-flow.js'` line
  from nav.js — the pipeline stops instantly, the tables just stop
  filling, and the admin card falls back to the consented sample.

**Reading it — three superadmin RPCs:**

- `telemetry_page_flow_kpis(days)` — sitewide sessions / visitors /
  pageviews / landings / bounce + hard-bounce counts / identified split /
  median dwell / median active / avg scroll.
- `telemetry_page_flow_pages(days, limit)` — per-page entries, landings,
  exits, hard bounces, median dwell/active, avg scroll/clicks. Powers the
  admin "Bounce Hotspots & Engagement Depth" table.
- `telemetry_page_transitions(days, limit)` — from→to edges including
  `(exit)` rows; a from = to row is a reload loop (the admin flags it —
  a reload loop on a gated page is a drop-off signal, not noise).

The admin Visitor Flow card prefers this source (badge: **full
population**) and falls back to the §3 consented-sample computation with
an amber badge when the migration hasn't run or the window has no rows.
