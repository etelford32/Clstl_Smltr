# DASHBOARD_TIERING_PLAN.md — dynamic, tier-aware dashboards + contextual upsell

> Status: **PLAN / not yet built.** Companion to `HOME_GATING_PLAN.md` (the gate
> modal + free-account capture, shipped) and `SPACE_WEATHER_DASHBOARD_PLAN.md`
> (the console architecture, shipped through S2/D2). This doc adds the
> **paid-upsell layer** on top of both, without rebuilding either.
>
> **Decision on record (author, this session): ADDITIVE.** The free signed-in
> console stays *full* (the growth loop — authN, not paywall, per
> `SPACE_WEATHER_DASHBOARD_PLAN.md` §3). Paid tiers add *depth* — premium
> panels and capabilities — which appear to un-entitled users as **contextual
> upsell teasers** wired to the gate modals. We do **not** gate core console
> panels behind paid tiers.

---

## 1. The one model

Every dashboard already has a panel/card system with **zero tier awareness in
the panel path today**. The whole feature is: **a panel declares the tier it
needs; the dashboard composes itself per user.**

```
panel.tier = free | basic | advanced | institution        (default: free)
panel.gate = <gate-modal variant key>                      (the upsell CTA)
                    │
   compose time ────┤  tierLevel(user) >= tierLevel(panel.tier) ?
                    │
        ┌───────────┴────────────┐
   render LIVE              render LOCKED TEASER ──► openGate(panel.gate,
   (full data)            (blurred preview + lock       { next: '<this page>' })
                           chip + "Unlock with X")   → Stripe checkout / contact
```

One registry field + one render branch = the console re-composes by tier, and
every upsell is **contextual** (the user sees exactly the premium panel they'd
get, not a generic pricing page). Server-side RLS already enforces the real
data, so client-side gating is **UX/upsell only** — the fail-open, authN-only
posture of the console gate is preserved.

---

## 2. Surfaces (unchanged separation — do not merge)

| Surface | Role | What this plan adds |
|---|---|---|
| **`space-weather.html`** (the console) | Signed-in, customizable panel dock (Stage + instruments). Free = full console. | Tier-aware panels: premium ones render as locked teasers → `openGate`. Gallery shows tier badges. |
| **`dashboard.html`** (the account hub) | Account home; bridge tile to the console. Today `applyTierLayout()` **hides** paid cards from free users and replaces them with *nothing*. | Replace the hidden-card vacuum with **upsell tiles** → `openGate`. Remove dead upgrade code. |
| **`account.html`** / **`welcome.html`** | Settings + post-signup hub. Upgrade paths are static `pricing.html` links. | Repoint the "Upgrade to Basic" banner + upgrade pill to contextual `openGate` modals (keep `pricing.html` as the "compare all plans" secondary). |

---

## 3. Reuse map — the exact extension points (verified)

Nothing here is a rebuild. Each is a small, additive hook on a proven system.

### 3.1 Registry — `js/space-weather-registry.js`
Panel schema today: `{ id, zone, family, title, blurb, personas, multiInstance?, config? }`.
Add two **optional** fields (default `tier:'free'`, no `gate`):
```
tier?: 'free' | 'basic' | 'advanced' | 'institution'   // entitlement to render live
gate?: <gate-modal variant key>                          // which upsell modal a locked panel opens
```
- Closed vocabulary, same discipline as `family`/`personas`.
- Extend `tests/space-weather-registry.mjs` to validate the new fields (drift gate). Panels without `tier` default to free — the whole existing catalog stays free, honoring §1.

### 3.2 The single choke point — `applyLayout` in `js/layout-lab.js`
The per-panel loop already toggles `lab-hidden`. Add a sibling toggle:
```
p.classList.toggle('lab-locked', !userEntitled(panel.tier));   // ← new, alongside lab-hidden
```
Every preset / A/B variant / personal-layout path flows through `applyLayout`, so this one line governs all of them. A `.lab-locked` panel:
- keeps its authored markup (the teaser — it's real chrome, blurred like auroracle's `.au-pinner`),
- gets a lock overlay (reuse the auroracle `.au-gate` pattern: 🔒 + "what you'd get" + an **Unlock** button that calls `openGate(panel.gate, { next: '/space-weather.html' })`).

Tier source: `pp_auth {plan, role}` is already in scope on the page (read by the gate + `dashboard-sync`); pass it into `initLayoutLab` or call `tierLevel(plan, role)` from `tier-config.js` directly.

### 3.3 Gallery drawer — `buildGallery` in `js/layout-lab.js`
Add a tier badge + lock affordance per row, next to the existing
`multiInstance` / `config` / `missing` branches. A locked panel in the gallery
shows "Basic" / "Advanced" and, when added, mounts in its locked-teaser state.

### 3.4 Account hub — `dashboard.html` `applyTierLayout()`
Today it hides `alert-card`, `impact-card`, `alert-history-card`,
`trip-planning-card`, `class-roster-card` from free users. Change: instead of
`keep:false → hidden`, render a compact **upsell tile** in the card's place:
```
alert-card / alert-history-card / impact-card   → openGate('storm-push')   (Basic)
month-outlook (if gated)                         → openGate('outlook-30day') (Basic)
trip-planning-card                               → openGate('advanced-solvers') (Advanced)
API / raw-engine surfaces                        → openGate('api-access')   (Advanced)
```
Delete the dead `_renderSubscriptionCard` / `sl-gate` code paths (DOM already gone).

### 3.5 Account / welcome repoint
`account.html` `#notif-gate-msg` "Upgrade to Basic" and `welcome.html`
`#upgrade-pill` → `openGate('storm-push')` (or the relevant variant), with
`pricing.html` kept as a secondary "see all plans" link.

---

## 4. Gate variants — reuse + additions

Existing paid variants (shipped in `js/gate-modal.js`): `outlook-30day` (Basic),
`storm-push` (Basic), `advanced-solvers` (Advanced), `api-access` (Advanced).

**Add** (data-only, same registry shape — the dashboard capabilities that have
no home today):
| new variant | tier / plan | drives |
|---|---|---|
| `cloud-sync` | Basic | "Save this layout to every device" (dashboard-sync is already Basic+ gated via `tierAllowsSync`) |
| `multi-dashboard` | Basic | named/multiple dashboards |
| `org-sharing` | Institution | shared team dashboards / kiosk |
| `custom-branding` | Institution | white-label (matches `hasCustomBranding`) |

Each follows copy §2 voice (acknowledge the free thing → name the deeper thing
→ upgrade) and routes to `signup.html?plan=<basic|institution>` for checkout,
exactly like the existing paid variants.

---

## 5. The tier × panel matrix (additive — free console stays full)

| Tier | Gate variant | Panels / capabilities surfaced as upsell to lower tiers |
|---|---|---|
| **Free** (full console) | — | The Stage, all live-now (solar wind, Kp/G-R-S, X-ray, DONKI), 7-night aurora, basic forecast panels (Bz fan, arrival countdown), single **local** layout |
| **Basic $9.99** | `outlook-30day`, `storm-push`, `cloud-sync`, `multi-dashboard` | 30-day / Dst outlook panel, "my alert tier" with real push, cloud sync, named/multi dashboards, multi-location alerts |
| **Advanced $100** | `advanced-solvers`, `api-access` | Parameter controls / advanced solvers, per-asset LEO drag (operator), API panel, deep forecast-vs-actual analytics |
| **Institution $500** | `org-sharing`, `custom-branding` | Org/shared dashboards, kiosk mode, white-label branding |

Maps onto the real capability flags in `js/tier-config.js`: `alerts` @ Basic,
`advancedAlerts` + `proBucket` @ Advanced, `embed`/`customBranding` @
Institution. `tierLevel`: free=1, basic/educator=2, advanced+=3.

> This matrix is the monetization surface — adjust per-panel freely; the
> mechanism (§1–3) doesn't change when a panel moves tiers.

---

## 6. Cloud-sync & entitlement interplay

`js/dashboard-sync.js` already tier-gates sync (Basic+ via `tierAllowsSync`) and
is local-first + migration-guarded. Two notes:
- A locked panel's state is **UX-only** — never write an "unlocked" flag into
  the synced layout `zones`; entitlement is derived live from `pp_auth`, not
  persisted. (If ever needed, it belongs in the sibling `config` store, not the
  layout doc.)
- The `cloud-sync` upsell variant is the natural CTA when a free user tries to
  turn on sync (state `off:tier`).

---

## 7. Telemetry

- Reuse the gate's `gate_view / gate_signup / gate_dismiss` (already 100%
  sampled via `recordFeature`), tagged by variant.
- Add one **upsell-impression** signal when a locked teaser renders
  (`recordFeature('<panel>_upsell', 'impression', { tier, gate })`) so we can
  measure teaser→gate→checkout per panel and A/B teaser copy via
  `experiments.js`. Impressions must be throttled (once per panel per session)
  to avoid flooding on every re-layout.

---

## 8. Phasing

- **T1 — Foundation.** Registry `tier`/`gate` fields + drift-test extension;
  `userEntitled()` helper + `lab-locked` hook in `applyLayout`; the shared
  locked-teaser overlay component + `openGate` wiring. Prove end-to-end on ONE
  premium panel (e.g. the 30-day outlook panel → `outlook-30day`). Browser gate
  extends `tests/space-weather-compose.spec.js`.
- **T2 — Console coverage.** Tag the premium panels per §5; gallery tier
  badges; upsell-impression telemetry.
- **T3 — Account hub.** Replace `applyTierLayout()` hidden-card vacuum with
  upsell tiles; delete dead upgrade code; repoint `account.html` / `welcome.html`
  upgrade paths to `openGate`.
- **T4 — New variants + capability upsells.** `cloud-sync`, `multi-dashboard`,
  `org-sharing`, `custom-branding` variants; wire the sync `off:tier` CTA.

Each phase is its own PR; T1 is the only one that touches the shared
`layout-lab.js` choke point.

---

## 9. Guardrails (from CLAUDE.md + the dashboard plan)

- **No rebuild.** Panels stay authored markup; the registry stays metadata; the
  gate stays authN-only + fail-open. We add one field + one class toggle.
- **Respect the drift gate.** Any registry edit must keep
  `tests/space-weather-registry.mjs` (+ the page-markup cross-check) green.
- **RLS is the real enforcement.** Client gating is upsell UX; never rely on it
  for data protection. Locked panels must fail *open*-ish (if entitlement can't
  be read, show the panel, don't wrongly lock a paying user).
- **No framework / no bundler / flat `*.html`.**
- **Don't merge the surfaces.** `dashboard.html` stays the account hub; the
  console stays the console (bridge tile only).
- **Preview/embed exemption.** Locked teasers must not fire gates inside
  `?preview=1` / attract frames (`openGate` already suppresses there).

---

## 10. Open decisions (confirm before the phase that needs them)

- **T4 variants:** ship all four new paid variants, or start with just
  `cloud-sync` (the highest-intent one)?
- **Educator tier:** the matrix above is chaser/operator-shaped. Do educator
  seats surface any dashboard upsell, or is that purely a `pricing.html` /
  classroom-invite flow? (Educator has `embed` but not `proBucket`.)
- **Teaser fidelity:** do locked premium panels show a *blurred live preview*
  (like auroracle's frosted month card) or a *static mock*? Live preview
  converts better but means computing premium data for non-payers (cheap for
  most panels; the API/solver panels should be static mocks).
