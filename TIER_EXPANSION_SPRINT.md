# Tier Expansion Sprint — Educator / Institution / Enterprise

Adds three new self-serve and lead-gen tiers between the existing Basic ($10) and
Advanced ($100) and the (currently invisible) "site license" gap. Total effort
is sized for **one engineer over ~5 working days** assuming the existing Stripe +
Supabase plumbing is healthy. Items in *italics* are out-of-band (Stripe
dashboard, DNS, Resend) — they have to be done by a human even when the code
is shipped.

## Target tiers (recap)

| key            | label         | price            | seats | self-serve | notes                                                                |
| -------------- | ------------- | ---------------- | ----- | ---------- | -------------------------------------------------------------------- |
| `educator`     | Educator      | $25 / mo         | 30    | Yes        | Embed permission, classroom license, "Powered by Parker Physics" req'd |
| `institution`  | Institution   | $500 / mo        | 200   | Yes        | Site license, custom branding, priority support                       |
| `enterprise`   | Enterprise    | Contact for quote| custom | Lead form | Satellite ops, FinServ, custom API/data; no published price            |

`enterprise` is a marketing tier — it never appears as a Stripe price ID and
the Checkout API rejects it. Lead capture writes to a new
`enterprise_leads` table and pings sales via Resend.

## Day 1 — schema + price plumbing

1. **DB migration** (`supabase-tier-expansion-migration.sql`, new file).
   - Drop & re-add the `plan` `CHECK` on `user_profiles` to include
     `educator`, `institution`, `enterprise`.
   - Drop & re-add the `plan` `CHECK` on `invite_codes` (same five values).
   - Extend `plan_location_limit()` so educator → 5, institution → 25,
     enterprise → 100.
   - New columns on `user_profiles`:
     - `classroom_seats INTEGER` — provisioned seats (30/200/custom).
     - `seats_used INTEGER DEFAULT 0` — billing safety net.
     - `parent_account_id UUID` — NULL for the seat-buyer; set for invited
       students/staff (enables nested RLS on educator/institution accounts in a
       follow-up sprint).
     - `branding JSONB DEFAULT '{}'::jsonb` — `{ logo_url, primary_color, footer_text }`
       for institution custom branding.
     - `attribution_required BOOLEAN DEFAULT FALSE` — `TRUE` for educator
       (renders the "Powered by Parker Physics" badge regardless of preference).
   - New table `enterprise_leads` (id, name, org, email, role, use_case, message,
     status, created_at, contacted_at) with RLS: insert open, select admin-only.
2. ***Stripe dashboard:*** create three products + prices, capture the price IDs:
   - `STRIPE_EDUCATOR_PRICE_ID` ($25/mo)
   - `STRIPE_INSTITUTION_PRICE_ID` ($500/mo)
   - (Enterprise has no Stripe price.)
3. **`api/stripe/checkout.js`** — extend `PRICE_MAP`, allow new plans,
   reject `enterprise` with a 400 + a hint to use the contact form.
4. **`api/stripe/webhook.js`** — extend `PRICE_TO_PLAN`. `enterprise` is set
   manually by an admin once the contract is signed; webhook never assigns it.

## Day 2 — auth, nav, feature gates

1. `js/auth.js` — `canUseAlerts()` already includes basic/advanced; extend so
   educator + institution + enterprise also count. Add helpers:
   `canUseEmbed()` (educator+), `hasCustomBranding()` (institution+),
   `requiresAttribution()` (educator only).
2. `js/nav.js` — extend `_tierLevel()` so educator=2 (alongside basic),
   institution=3, enterprise=3 (Advanced-equivalent feature access).
3. `js/saved-locations.js` — extend `PLAN_LIMITS` to match the SQL function.
4. `js/greeting.js` — same tier-level mapping update.
5. `js/alert-engine.js` — `isAdvanced` gate becomes `canUseAdvancedAlerts()`
   so it correctly includes institution/enterprise via the auth helper.
6. `js/admin-analytics.js` — extend `VALID_TARGET_PLAN`; add educator + institution
   + enterprise to `loadRevenueKPIs()` so MRR is correct.
7. `js/admin-invites.js` — bump the inline schema comment so future readers
   don't trust the stale CHECK constraint.

## Day 3 — pricing page, signup, dashboard

1. **`pricing.html`** — restructure the grid from 3 to 4 cards (Free, Basic,
   Educator, Advanced) with a secondary row for Institution + Enterprise.
   New "Education & Institutions" section heading. Update the comparison
   table with new columns. Update FAQ entries (institutional discount,
   embed/attribution, enterprise lead-time).
2. **`signup.html`** — radio-pill set goes from 3 to 5 (Free, Basic, Educator,
   Institution, Advanced). Enterprise is a separate "Talk to sales →" link
   that routes to `/contact-enterprise.html` (or adds an inline drawer).
3. **`dashboard.html`** — add `.plan-educator` and `.plan-institution` badge
   styles; extend `_renderPlanBadge()` and `_renderSubscriptionCard()` so
   they don't fall through to "Free Plan · upgrade" for the new tiers.
4. **`admin.html`** — extend the user table badge logic, add KPI tiles for
   the new tiers in the Revenue panel, update MRR to factor in $25 / $500.

## Day 4 — Enterprise lead capture + attribution

1. **`/api/contact/enterprise.js`** (new): rate-limited, no auth, validates
   email + body, writes to `enterprise_leads`, fires a Resend email to
   `sales@parkerphysics.com`. CSRF-safe via Origin header check.
2. **`contact-enterprise.html`** (new): a single-page form with the qualification
   bullets (anomaly correlation, GNSS scintillation forecasting,
   launch-window briefings) baked in as ad-copy + a few use-case checkboxes
   that flow into the lead row's `use_case` column.
3. **Powered-by attribution**: add `js/attribution-badge.js` that renders a
   small fixed-bottom-right badge whenever
   `auth.requiresAttribution()` is true. Wire it into `nav.js` so every page
   gets it automatically. The badge cannot be dismissed by the user (it is a
   licensing condition for the educator tier).
4. **`api-policy.html`** — add Educator (no API), Institution (capped at
   Advanced's 1k/day shared across the org), and Enterprise (negotiated)
   rows to the rate-limit table.

## Day 5 — tests, docs, manual QA

1. Extend `tests/auth-flows.spec.js` with smoke checks:
   - Each plan pill renders + selects correctly.
   - Stripe checkout returns `400 invalid_plan` when posting `enterprise`.
   - Enterprise contact form posts to `/api/contact/enterprise` with valid
     body and is rejected with a 400 on missing email.
2. ***Stripe portal config:*** ensure the billing portal exposes upgrades
   between Basic ↔ Educator ↔ Institution ↔ Advanced (Stripe dashboard).
3. *Manual QA pass*: sign up as each tier in test mode → confirm the Supabase
   `user_profiles.plan` lands the right value, the dashboard badge is right,
   the saved-locations cap is right, and the attribution badge appears for
   Educator only.
4. Update `README.md` and `DEPLOYMENT.md` with the new env vars
   (`STRIPE_EDUCATOR_PRICE_ID`, `STRIPE_INSTITUTION_PRICE_ID`,
   `SALES_EMAIL`).

## Out-of-scope follow-ups (track separately)

- Per-seat invitation flows for Educator (30 student emails) and Institution
  (200 staff emails) using the existing invite code system + a new
  `parent_account_id` linkage. Sketched in the schema but not wired up here.
- Custom-branding admin UI on the dashboard (logo upload, primary color,
  footer text). Storage column exists in the schema; the editor is a
  separate sprint.
- Embed permission enforcement (CSP `frame-ancestors` based on
  `parent_account_id` of the authenticated session). The DB flag exists; the
  middleware is a follow-up.
- SCIM provisioning for Institution+ — only worth doing once a real customer
  asks for it.

## Integration-review findings (separate from the work above)

These are issues uncovered while auditing the existing code that should be
fixed regardless of tier expansion. They block clean implementation of the new
tiers but each is a small standalone change:

1. **Two parallel tier-vocabulary systems.** `js/config.js:24-27` defines
   `TIER.FREE` / `TIER.PRO` and uses it to multiply storm-mode T-counts.
   Nothing else in the app uses `TIER.PRO`. Either delete the constant or
   alias `PRO` → `advanced`. Today, an Advanced subscriber gets the
   `TIER.FREE` multiplier because nothing assigns `TIER.PRO`.
2. **`subscription_status` is read but never persisted on the client object.**
   `dashboard.html:1233` reads `liveUser.alerts?.subscription_status ??
   liveUser.subscription_status`, but `auth.fetchProfile()` does not select
   that column. So the "past_due" / "canceled" copy never fires until the
   page is reloaded post-webhook. Add `subscription_status` and
   `subscription_period_end` to the `select(...)` list.
3. **Plan downgrade-on-cancel is silent.** `webhook.js:160-171` flips a
   user back to `free` when Stripe sends `customer.subscription.deleted`,
   without grace until `current_period_end`. Stripe defaults to "cancel at
   period end" in the portal, so this is *usually* fine — but for an
   immediate-cancel issued via the API the user loses access mid-cycle. The
   fix is to gate the downgrade on `sub.cancel_at_period_end` /
   `current_period_end`.
4. **Webhook signature verification uses a non-constant-time string
   compare.** `webhook.js:62`'s `expectedHex === sig` leaks timing, which —
   for a `WHSEC` HMAC — is mostly theoretical but worth fixing with a
   constant-time compare loop. Stripe's official SDK does this, the manual
   edge implementation here doesn't.
5. **`invite_codes` `Public can validate invite codes`** policy
   (`supabase-schema.sql:233-235`) lets anyone enumerate every active code
   if they bypass the RPC. The new `validate_invite` RPC in
   `supabase-invites-email-migration.sql` was added to fix this, but the
   permissive policy is still on the table. Drop it as part of this sprint —
   no production code path needs raw SELECT.
6. **`api/invites/send.js:53` rate limit is per-admin, but invite plan tier
   is not included in the audit log subject line.** Educator and Institution
   invites should be logged distinctly so a compromised admin issuing a
   thousand free→advanced invites is observable. Add `plan` to the log
   subject.
7. **No CSRF / origin check on `/api/stripe/checkout`.** The endpoint relies
   on a Supabase JWT, so a CSRF attempt from another origin would still need
   a valid token, but tightening with an `Origin` allow-list (parkerphysics.com,
   parkerphysics.app) is a 4-line defense-in-depth fix.
8. **Stripe customer creation (`getOrCreateCustomer`) is racy.** If a user
   double-clicks "Get Basic →" in the half-second before
   `stripe_customer_id` is persisted, they get two Stripe customers. Add a
   `SELECT … FOR UPDATE` (via an RPC) or a unique partial index on
   `(supabase_uid)` in Stripe metadata so the second call returns the first
   customer. Low impact today, will hurt at higher volume.

The implementation that follows in this branch executes the Day-1, Day-2,
Day-3, and Day-4 items above plus the schema + Stripe + frontend changes
needed to ship Educator and Institution as self-serve tiers and Enterprise
as a lead-capture form. Items flagged "follow-up" or "out-of-band" are
deliberately not touched.
