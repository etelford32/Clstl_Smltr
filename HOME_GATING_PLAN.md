# HOME_GATING_PLAN.md — Conversion gates + home-page funnel

> Status: **PLAN / not yet built.** Source copy: the external "ParkersPhysics.com — Gate
> Modal Copy" doc (15 modal variants across two gate types). This file translates that
> doc into this repo's reality (vanilla ES modules, no framework) and sequences the work.
>
> Read `CLAUDE.md` §4 (load-bearing invariants) and §7 (B2G pivot) before implementing.

---

## 0. TL;DR

- Build **one** vanilla modal component `js/gate-modal.js` + a data-driven `GATE_VARIANTS`
  registry. It **dims** the sim behind it, never destroys it.
- **Gate 1** = free-account capture, fired at the *moment of ownership* (save / favorite /
  set-location / open a gated sim).
- **Gate 2** = paid upsell, fired when reaching for depth/power (30-day outlook, storm push,
  advanced solvers, API).
- Most Gate-1 trigger points **don't exist yet** — the save/favorite feature must be built
  before the gate has anything to fire on.
- Prices in the copy are already correct; only the tier *names* need reconciling.

---

## 1. Ground truth (what already exists — do not rebuild)

| Concern | What's there | File |
|---|---|---|
| Live home page | `index.html` — hero → live Stage attract iframe → proof ticker → **anonymous aurora email capture** → depth ladder → featured sims → pricing (`?plan=free/basic/advanced`) → agencies door. Every CTA carries `data-funnel-cta`. | `index.html` |
| Anonymous email capture | Working, no-account aurora signup band | `js/aurora-capture.js` |
| A/B + funnel tracking | `experiments.assign(key)`, `experiments.track(stage, props)` | `js/experiments.js` |
| Product telemetry | `telemetry.recordFeature(feature, action, meta)` — kind `'feature'`, 100% sampled | `js/telemetry.js:337` |
| Auth predicates | `isSignedIn()`, `getPlan()`, `getRole()`, `isPro()`, `requireAuth()`, `ready()` | `js/auth.js` |
| Magic-link / OAuth | `signInWithMagicLink(email)`, `signInWithProvider('google')` | `js/auth.js:952,994` |
| Paid soft-gate (banner) | `js/page-tier-gate.js` — soft, non-blocking, `meta[name=required-tier]`; **no telemetry**, `advanced`-only | `js/page-tier-gate.js` |
| Tier model | `TIER.FREE/PRO` bucket + full `TIERS` table (basic $9.99, advanced $100) | `js/config.js`, `js/tier-config.js` |
| Signup params | `?plan=`, `?email=`, `?code=`, `?trial=` supported. **`?next=`/`?resume=` NOT supported.** | `signup.html`, `js/auth.js` |
| Sign-in return-to-origin | `requireAuth()` stashes `?next=` (same-origin guarded) + `sessionStorage.pp_auth_redirect` | `js/auth.js:885` |

**There is no generic modal/paywall component.** `page-tier-gate.js` is a banner, not a modal.

---

## 2. Decisions (recommended defaults — override any of these)

| # | Decision | Recommended default | Why / cost of the alternative |
|---|---|---|---|
| D1 | Tier naming ("Forecaster/Researcher" vs real labels) | **Rename copy → Basic/Advanced** | The `basic`/`advanced` plan *ids* are load-bearing across the Supabase `plan` CHECK, Stripe products, and every `?plan=` link. A rebrand is a full cascade for zero functional gain. Prices ($9.99 / $100) already match. |
| D2 | Gate-2 paid destination | **Stripe self-serve** (`signup.html?plan=basic\|advanced`) for the consumer sims; keep `request-access.html` for the operator/agency door only | Matches the copy's "Start … — $9.99/mo" CTAs. The B2G surface (§7) stays reserved for agencies, not aurora hobbyists. |
| D3 | Home aurora band | **Keep anonymous email**; fire the free-account gates on ownership moments elsewhere | The band is a working, lowest-friction top-of-funnel. Converting the busiest entry point to an account wall adds friction where it hurts most. Revisit via A/B (Phase 5) if desired. |
| D4 | Account-creation mechanism inside Gate 1 | **Inline email + Google OAuth in the modal** (magic-link one-tap), `signup.html` as fallback | The copy's §0 rule: "email + one tap … don't ask for a password up front," and "dim the sim, don't destroy it." Inline capture keeps the "whoa" on screen. Redirect-to-signup is the fallback for password users. |
| D5 | First-build scope | **Foundation + existing triggers (Phases 1–2)**, then Phase 3 | Ship a real, measured gate fast against actions that already exist; defer building brand-new save features. |

> If you disagree with any default, say which — D2/D3/D5 most change the shape of the build.

---

## 3. Architecture — the reusable modal

### 3.1 `js/gate-modal.js` (new)

Public API (mirrors the copy's §0 shell + §4 note, translated to vanilla):

```js
import { openGate, GATE_VARIANTS } from './js/gate-modal.js';

openGate('save-satellite', {          // variant key from the registry
  next: '/satellite-designer.html',   // return-to-origin path (same-origin only)
  resume: draftId,                    // optional: what to rehydrate on return
  onSuccess() { /* re-run the ownership action */ },
});
```

- **Self-injecting** namespaced `.pp-gate-*` CSS (same pattern as `verdict-card.js`,
  `aurora-capture.js`, `page-tier-gate.js`) — no global stylesheet dependency.
- **Dims, never destroys**: a `pointer-events`-blocking scrim over the page; the sim keeps
  rendering behind it (copy global rule).
- **Quiet exit** always present: "Already have an account? Sign in" + an ✕ (copy rule).
- **Focus trap + Esc + backdrop-click dismiss**, `role="dialog"` / `aria-modal`, restores
  focus to the trigger on close (a11y parity with the rest of the app).
- **Success state** swaps the body to `successMsg` (copy §0), then runs `onSuccess`.

### 3.2 `GATE_VARIANTS` registry (data, not code)

One object literal keyed by variant id; each entry is the §0 shell filled from §1/§2:

```js
{ eyebrow, headline, body, primaryCta:{label, plan?}, secondaryLink, finePrint?, successMsg, gateType:'free'|'paid' }
```

- Gate-1 entries carry the fixed fine print "No credit card. Free forever." (copy rule).
- Primary CTA `plan` field drives the destination per D2:
  `free` → inline capture; `basic`/`advanced` → `signup.html?plan=…` (or `request-access` if D2 changes).

### 3.3 Telemetry (copy §4)

Every open/convert/dismiss → `telemetry.recordFeature('<variantId>_gate', 'gate_view'|'gate_signup'|'gate_dismiss', { gateType, plan })`.
The `'feature'` kind is already migrated (`supabase-feature-telemetry-migration.sql`, applied 2026-07-13) — **no new migration needed**. For funnel-summary visibility, optionally also emit `experiments.track('gate_view', {variant})`.

### 3.4 Return-to-origin plumbing (NET-NEW — copy §4)

`signup.html` gains `?next=` (+ optional `?resume=`) support, mirroring sign-in's
**same-origin open-redirect guard** (`js/auth.js:883`). After account creation the user lands
back on the origin path; the origin page reads `?resume=` and rehydrates.
For the designers, the local draft already persists in `localStorage` (`pp_sd_draft`), so
"resume" for those is mostly "the draft is still there when they return" — server-side
pre-account draft persistence is only needed for sims without a local draft.

---

## 4. Trigger-point audit (which gates can fire today)

| Copy variant | Sim | Ownership action today | Work needed |
|---|---|---|---|
| 1.3 Set home location | earth / account | Location editor exists (verdict card owns it) | Wire gate on save-for-anon |
| 1.4 Save satellite | `satellite-designer.html` | **Cloud-save already gated behind sign-in** | Replace the inline sign-in prompt with the modal |
| 1.5 Save rocket | `spaceship-designer.html` | **Cloud-save already gated behind sign-in** | Same as 1.4 |
| 1.10 7-night outlook | `auroracle.html` | **Real Basic+ gate exists** | Convert gate CTA → modal; 30-day = Gate 2.1 |
| 1.1 Aurora alerts | home / auroracle | Anonymous email band exists | Per D3, leave anonymous; optional account variant |
| 1.2 Storm spike notify | `ring-current.html` | **Open, no save/notify** | Build "notify me" opt-in, then gate |
| 1.6 Save launch plan | `launch-planner.html` | **Open, no save** | Build save, then gate |
| 1.7 Save mission | `mission-planner.html` | **Open, no save** | Build save, then gate |
| 1.8 Save score | `satellite-game.html` | **Open, cosmetic "saved" only** | Build score persistence, then gate |
| 1.9 Favorite a sim | all sims | **No favorites system** | Build favorites store + UI, then gate |
| 1.11 Breadth sims | galactic-map / wr102 / sirius-planetary | **Fully open** | Decide if these become account-gated at all (strategic) |
| 2.1 30-day outlook | auroracle | Advanced-alerts gate exists | Paid modal |
| 2.2 Storm push | auroracle / alerts | Alert engine exists | Paid modal |
| 2.3 Advanced solvers | star2d-advanced / rust | `page-tier-gate.js` banner | Upgrade banner → paid modal |
| 2.4 API / params | operators | — | Paid modal → per D2 |

**Takeaway:** 1.4, 1.5, 1.10, 2.3 are wireable immediately (Phase 2). Everything else needs
its ownership action built first (Phase 3).

---

## 5. Phasing

- **Phase 1 — Foundation.** `js/gate-modal.js` + `GATE_VARIANTS` (all 15 as data) + telemetry
  + `?next=`/`?resume=` on `signup.html` + shared states/microcopy (copy §3). Prove end-to-end
  on ONE live trigger (satellite-designer save). Add `tests/gate-modal-smoke.spec.js`.
- **Phase 2 — Wire existing triggers.** 1.4, 1.5 (designers), 1.3 (set-location), 1.10 +
  2.1 (auroracle), 2.3/2.4 (convert `page-tier-gate.js` banner path to the paid modal, and
  give it the telemetry it currently lacks).
- **Phase 3 — Build missing ownership actions + gates.** 1.6, 1.7, 1.8, 1.9, 1.2, 1.11. Each
  is its own PR (save/favorite feature + migration if server-persisted + the gate).
- **Phase 4 — Home page.** Reconcile per D3; decide whether the home carries a persistent
  free-account value-prop or stays sim-triggered. No framework, no new page.
- **Phase 5 — Instrumentation & A/B.** Variant tagging, the 1.1 headline A/B via
  `experiments.assign()`, a gate-funnel view in `admin.html`.

---

## 6. Guardrails (from CLAUDE.md)

- **No framework / no bundler.** `gate-modal.js` is a plain ES module, self-injecting CSS.
- **Nav lint gate.** Any page edits must still pass `node scripts/lint-nav.mjs`.
- **Don't touch load-bearing auth order** (`CLAUDE.md` §4.1) — the gate only *reads* auth
  state and calls existing methods; it does not reorder `_init`.
- **Plan ids are load-bearing** (D1) — never change `basic`/`advanced` casually.
- **Fail open.** If the modal errors, the sim must remain usable (mirror the space-weather
  gate's fail-open posture).
- **Preview/iframe exemption.** Gates must not fire inside `?preview=1` / embedded attract
  frames (respect `html[data-preview]`).

---

## 7. Open questions to confirm before Phase 3

- 1.11: do the breadth sims (galaxy / WR-102 / Sirius) actually become account-gated, or stay
  fully open? (Currently open; gating them adds friction to exploration.)
- 1.9 favorites: server-persisted (new `user_profiles` column / table + migration) or
  local-only to start?
- Whether any of this should route through the B2G `request-access.html` surface (§7 pivot)
  beyond the operator/agency door.
