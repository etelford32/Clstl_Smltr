# Space Weather Dashboard v2 — full-customization redesign plan

> **Plan only — no implementation in this document's commit.** Product
> target: `space-weather.html` becomes a per-user mission-control surface —
> "make it YOURS" — composed from the platform's now-validated forecast
> engine (flux-rope Phases 0–5), the Phase 4 consumer modules, and the
> existing live-feed spine. Decisions marked ⚠ need the author's call
> (§12) before their phase starts.

---

## 1. Vision

Today the dashboard is a *general* page: ~20 author-arranged panels that
are the same for a satellite operator at 2 a.m. during a G4 watch and a
first-visit aurora hopeful in Ohio. The redesign inverts it: **the page is
an empty grid + a panel catalog + your data**. Users compose the dashboard
from panels that each accept *their* location, *their* thresholds, *their*
assets (satellites, ground sites), and *their* horizon — and the platform's
differentiator (physics-first, validated, honest uncertainty) is visible in
every panel: fans not lines, probabilities not verdicts, skill numbers not
vibes.

One sentence: **from "our page about space weather" to "your console for
your exposure to space weather."**

## 2. What exists (build on it, don't rediscover it)

| Asset | State | Redesign role |
|---|---|---|
| **Layout Lab** (`js/layout-lab.js`, 573 lines, node-tested) | SHIPPED: drag-reorder, hide/show, full-width spans, per-panel resize, personal layout in localStorage, A/B variants (`data/layout-variants/space-weather.json`), export/import JSON, experiment goals `sw_panel_interact` / `sw_dwell_60s` | The v2 foundation. v1 rearranges *author-authored* panels; v2 adds a **registry** (panels as self-describing modules), **add-from-gallery**, **per-panel config**, **presets**, **cloud sync**. Do NOT fork it — extend it. |
| ~20 tagged panels (`data-lab-panel=`) | SHIPPED | Become registry entries with declared config schemas |
| Flux-rope forecast panel (`js/flux-rope-dashboard.js`) | SHIPPED (Phase 3/4) | First fully-configurable v2 panel (thresholds, horizon, event picker) |
| Shared forecast provider (`js/flux-rope-forecast.js`) | SHIPPED (Phase 4) | THE data spine for every forecast panel — one pipeline, many views |
| `js/ring-current-outlook.js`, `stormOutlook()` verdict tier, `api/_lib/aurora-tiers.js` | SHIPPED (Phase 4) | Dst-outlook panel; storm-tier banner; per-user threshold unification (§6) |
| `SolarWindDriver` contract + hindcast bundles + pinned validation numbers | SHIPPED | The trust assets behind the Skill/Scorecard panels (§7a) |
| `telemetry.recordFeature` (kind `'feature'`, migrated 2026-07-13) + `js/experiments.js` | SHIPPED | Product-analytics channel (§7b) — no new DB kinds needed for most events |
| Verdict-card patterns (`draggable-panel.js`, stable-header/re-rendered-body, fail-quiet mounts) | SHIPPED | House interaction + resilience patterns to reuse verbatim |
| `DESIGN_TOKENS.md` (earth.html token system) | SHIPPED for earth.html only | Port the token discipline to space-weather (§8) — the page currently carries its own inline paint-shop |
| `js/tier-config.js` + `user_profiles` one-column-per-flag | SHIPPED | Gating + persistence conventions (§9) |

Hard constraints carried forward: **no frameworks, no bundler**, flat
`*.html`, ES modules, browser-direct NOAA / edge-proxied NASA, fail-quiet
panel mounts, additive Layout Lab (applying a layout never creates/destroys
panel internals).

## 3. Personas → presets (the usability spine)

Each persona is a JOB, and each maps to a **named preset layout** shipped
as data (same JSON shape Layout Lab already exports), selectable at
first-run and re-applicable anytime. Presets are starting points, not
modes — everything stays editable after.

1. **Aurora Chaser** — "Will I see it from HERE, and when should I drive?"
   Location-anchored: aurora odds tonight + 3-night strip, tiered alert
   status at *my* Kp threshold, cloud cover, flux-rope arrival countdown,
   dark-window clock.
2. **Satellite Operator (B2G wedge)** — "What does the next 72 h do to MY
   assets?" Dst outlook, LEO density/drag index + Starlink-2022 context,
   arrival window with uncertainty, GEO charging scale, per-asset altitude
   config, alert ledger for shift handoff.
3. **Forecaster / Researcher** — "Show me the model guts." Bz fan with
   ensemble controls, ESS/λ assimilation chip, STEREO-A conditioning
   status, three-way validation chips, raw feed strips, event replay links
   into the Flux Rope Simulator / Hindcast Lab.
4. **Educator** — curated storytelling order: Sun → transit → Earth →
   effects; annotations on; jargon-light labels; classroom share link.
5. **Casual / first visit** — the current page's job: a good general
   default (this preset ≈ today's layout, so nothing regresses).

⚠ §12-Q1: which TWO personas get design-polish priority in D1? (Strategy
doc says B2G + operators; traffic says aurora chasers. Recommend: Operator
+ Aurora Chaser first.)

## 4. The customization model (Layout Lab v1 → Dashboard v2)

Four layers, each strictly additive:

1. **Registry.** Every panel becomes a self-describing entry:
   `{ id, title, blurb, category, tier, sizes: [1x1|2x1|2x2|wide],
   configSchema, dataNeeds: [feed keys], mount(el, config), preview() }`.
   Existing DOM panels register with a thin adapter (no rewrite);
   new panels (§7) are registry-native modules under `js/dashboard/panels/`.
   The registry is what turns "reorder what the author wrote" into
   "compose from a catalog", including MULTIPLE INSTANCES of one panel
   with different configs (two aurora panels: home + cabin).
2. **Grid.** CSS grid with explicit spans replaces the current
   section-flow; Layout Lab's zone/order/span/hide model extends with
   `{cols, size}` per placement. Mobile: single-column reflow by a
   user-orderable priority list (the mobile order ≠ desktop order — small
   screens get their own drag list). Density modes: comfortable / compact /
   **ops** (max data per pixel, for wall screens; pairs with an auto-cycle
   "kiosk" toggle).
3. **Per-panel config.** Each panel's ⚙ opens a config sheet generated
   from its `configSchema`: location (defaults to the account/saved
   location system), thresholds (§6), horizon (24 h / 72 h / 27-day),
   units, data source variants, asset altitude, chart style. Config edits
   re-render only that panel body (verdict-card stable-header pattern).
4. **Presets + persistence + sharing.**
   - Presets: the five §3 layouts shipped in `data/layout-variants/` (the
     mechanism already exists — presets are just named variants surfaced
     in UI instead of assigned by experiment).
   - Personal layouts: localStorage first (works signed-out, keeps the
     anonymous surface), **cloud sync when signed in** so the dashboard
     follows the user across devices. ⚠ §12-Q2 storage shape: a
     `dashboards` table (named, versioned, several per user — enables the
     institution "shared org dashboard" later) vs a single
     `user_profiles.dashboard_layout` JSONB column. Recommend the table.
   - Sharing: "copy layout link" (URL-fragment-encoded layout, no server),
     plus export/import JSON (exists). Org-shared dashboards = later phase,
     institution tier.

## 5. Panel catalog v2 (what "specific to their needs" means concretely)

**Forecast family (the flux-rope payoff — all via the ONE shared provider):**
- **Bz forecast fan** — configurable thresholds drawn on the fan, horizon,
  members, "show assimilation detail" toggle (ESS/λ), event picker when
  multiple CMEs are in flight.
- **Arrival countdown** — big-type P10–P90 window + P(hit), counts down;
  the panel most people will screenshot.
- **Dst / storm-depth outlook** — ring-current pipeline over the forecast
  driver; G-scale banding at the user's threshold.
- **My alert tier** — the aurora-alerts Watch/Warning/Nowcast state
  evaluated at *my* threshold + *my* location, with inline threshold
  editor and email-subscribe handoff (closes the loop with the fixed
  sender).
- **Aurora tonight (per location)** — verdict-engine `auroraVerdict` +
  cloud + dark window; multi-instance for multiple sites.
- **LEO drag index (operator)** — density outlook at a configurable
  altitude, Starlink-2022 reference band, link to the Gannon density page.

**Live-now family (exists, gains config):** solar wind strip, Kp/G-R-S
scales, X-ray flares, DONKI CME list, globe, transit view, heliosphere
hero — each gets thresholds/units/source options instead of one-size copy.

**Trust family (new, differentiating, §7a):** validation scorecard,
personal storm log, forecast-vs-actual replay.

**Utility:** notes/ops-log (shift handoff), clock strip (UTC + local +
Bartels rotation), links/bookmarks.

Every panel declares empty/loading/degraded states up front — the
fail-quiet culture becomes a *visible design element* ("NOAA feed stale
14 min" chip), not silent absence.

## 6. One threshold system (the coherence move)

Today thresholds are scattered: AurOracle slider (`kp_threshold`),
alert-engine prefs (`aurora_kp_threshold`, `storm_g_threshold`), verdict
GO margins, hard-coded panel copy. v2 introduces a single per-user
**threshold profile** `{ kp, gScale, minBzNt, dstNt, leoAltKm }` with one
editor, consumed by every panel, the verdict tier, and the alert sender.
Set "Kp ≥ 5" once → the fan draws your line, the countdown colors at your
line, the alert tier fires at your line, the email matches the page.
(Mapping helpers already exist: `kpFromMinBz`, G-scale tables,
`stormClass` — this is unification, not new science.)

## 7. Analytics — both meanings, explicitly

**a) Analytics FOR the user (product value):**
- **Validation scorecard panel** — the pinned hindcast numbers (St.
  Patrick's min-Bz 1.3% / shock 0.0 h; Gannon min 0.3% / internal shock
  0.2 h; the −280-vs−412 pipeline-ceiling finding) rendered as the trust
  badge with links to the receipts. No competitor shows their misses;
  we pin ours to the dashboard.
- **Personal storm log** — every crossing of *your* threshold since you
  set it (from stored Kp/Dst history), with "what the engine said N hours
  before" replay links.
- **Alert ledger** — the tier emails/in-app alerts you actually received,
  vs what happened (per-user hit/false-alarm record — honesty as a
  feature).
- **Forecast-vs-actual strip** — rolling 27-day overlay of issued fans vs
  observed Bz/Kp (extends `forecast_log`/`archive-forecasts` plumbing).

**b) Product analytics (learn what users need):**
- Instrument the customization loop itself via existing channels
  (`recordFeature` kind `'feature'`; experiment goals): `panel_add`,
  `panel_remove`, `panel_config` (which field), `panel_move`,
  `preset_apply`, `layout_save`, `layout_share`, `density_change`,
  `threshold_set` (value bucket, not raw location), mobile-order edits,
  dwell per panel (extend `sw_panel_interact` to per-panel dwell buckets).
- Decision uses: default preset per traffic source, which panels earn
  D-phase polish, threshold distributions → alert-tier default tuning,
  kill-list for never-added panels.
- Privacy posture unchanged: anonymous-write telemetry surface, no
  locations in analytics (bucketed mlat at most), thresholds bucketed.

## 8. Visual refinement (the design system pass)

- **Port the token discipline** from `DESIGN_TOKENS.md` to
  space-weather.html: one `:root` block (surfaces, text scale, borders,
  radii, spacing rhythm, transitions) + a **status grammar** shared by
  every panel: quiet / elevated / watch / warning / severe map to one
  color family (colorblind-safe, shape+text redundant) — the SAME grammar
  the G/R/S chips, tier banner, fan thresholds, and alert emails use.
- **One card chrome**: uniform header (title · source chip · freshness ·
  ⚙ · drag affordance), uniform body padding, uniform skeleton/degraded
  states. Kill the per-panel bespoke borders/glows; accent via a thin
  category keyline only.
- **Glance hierarchy**: a persistent top **status band** (the "answer
  row"): tier state at your threshold · arrival countdown · Kp now ·
  your location's tonight verdict. Everything below is depth-on-demand.
- **Type discipline**: numeric KPIs in the mono stack at 3 fixed sizes;
  prose only in notes/blurbs. Charts follow the flux-rope chart language
  (fan bands, dashed observed, threshold rules) so every plot on the site
  reads identically.
- **Motion restraint**: state changes tween ≤200 ms; live tickers pulse
  only on threshold crossings; `prefers-reduced-motion` honored
  everywhere; heavy sims (globe, heliosphere) pause when off-viewport
  (perf + battery).
- Light theme + print/PDF stylesheet for the operator briefing use-case
  (⚠ §12-Q3 — worth D3 scope?).

## 9. Usability program

- **First-run**: one screen — "What brings you here?" → persona preset +
  location + threshold in ≤3 taps; skippable to the Casual preset.
  (Repo has onboarding-nudge/funnel precedents to hang this on.)
- **Edit mode**: explicit Customize toggle (exists) opens the gallery
  drawer — panels shown as LIVE mini-previews with one-line "why you'd
  want this"; drag from drawer to grid; in-grid drag/resize/span; undo
  stack + "reset to preset"; everything keyboard-operable (roving focus,
  arrow-key move, announced via aria-live).
- **Empty states sell**: an empty grid cell offers the 3 most-added
  panels for your persona (analytics loop feeding UX).
- **Mobile**: bottom-sheet config, priority-order editor, swipe between
  "boards" (pages of the grid); the status band becomes the sticky
  header.
- **Performance budget**: lazy-mount panels on first visibility; ONE
  feed bus (existing `SpaceWeatherFeed` + INTERVALS) fans data to all
  panels — a panel never fetches what the bus already has; WASM loads
  once and is shared (provider already does this); target < 2.5 s LCP
  with the default preset on mid mobile.
- **Accessibility gate**: axe pass + keyboard-only walkthrough added to
  the Playwright suite.

## 10. Technical architecture (named, but not built here)

- `js/dashboard/registry.js` — panel registry + adapter for legacy
  `data-lab-panel` sections; pure core (node-testable like
  `mergeOrder`).
- `js/dashboard/grid.js` — grid model (placement algebra pure; DOM apply
  thin) extending layout-lab; layout schema `LAYOUT_VERSION: 2` with a
  v1→v2 migrator (v1 saved layouts must keep working — merge semantics
  already exist).
- `js/dashboard/config-sheet.js` — schema-driven per-panel config UI.
- `js/dashboard/panels/*.js` — new panels; each fail-quiet, each with a
  node fixture test for its pure compute (house pattern).
- `js/threshold-profile.js` — the §6 unified thresholds (pure +
  storage).
- Persistence: localStorage keys extend layout-lab's store; cloud sync
  via a new migration (⚠ §12-Q2) following the repo's SECURITY DEFINER +
  RLS conventions; sync is last-write-wins with updated_at, layouts are
  small JSON.
- Tests: pure-model node fixtures (registry merge, grid algebra,
  threshold mapping, v1→v2 layout migration) + one Playwright suite
  (boot default, apply preset, add/configure/move/persist a panel,
  mobile reflow, a11y pass) + the existing per-panel gates keep running.
- Telemetry: no schema change expected (kind `'feature'` + experiments
  goals); IF a new event kind becomes necessary, CHECK constraint + RPC
  whitelist move together (documented invariant).

## 11. Phasing

- **D1 — Foundation (registry + grid + presets).** Registry with legacy
  adapters, grid model + v2 layout schema (+migrator), gallery drawer,
  the five presets, status band, token port for the card chrome. Two
  polished personas (⚠ Q1). Exit: compose/save/restore a personal
  dashboard signed-out; all existing panels still work; gates green.
- **D2 — Personalization depth.** Per-panel config sheets on the
  forecast family, threshold profile unification (incl. alert-sender
  handoff), multi-instance panels, mobile priority order, cloud sync
  migration (⚠ Q2), first-run flow.
- **D3 — Analytics & trust.** User-facing family (scorecard, storm log,
  alert ledger, forecast-vs-actual), product-analytics instrumentation +
  first default-tuning pass, density/ops mode, a11y gate, perf budget
  enforcement, (⚠ Q3) print/light theme.
- **D4 — Sharing & org.** Layout links, institution shared dashboards,
  kiosk mode, marketing screenshots pipeline.

Each phase lands as one PR-sized arc with its own gates, per house
workflow (implement → measure → pin → docs → gates → push).

## 12. Open questions for the author (blocking their phases only)

1. **Persona priority** for D1 polish — recommend Satellite Operator +
   Aurora Chaser (B2G strategy + traffic reality). Confirm?
2. **Cloud-sync shape** — new `dashboards` table (named, versioned,
   multiple per user; institution-ready) vs a `user_profiles` JSONB
   column (simpler, fits one-column-per-flag culture). Recommend the
   table; needs your DB sign-off either way (migration will be committed
   as SQL and applied only on your go, per the aurora-ledger precedent).
3. **Print/light theme** for operator briefings — in scope for D3?
4. **Tier gating** — recommend: composing/customizing FREE (it's the
   growth loop), cloud sync + multi-dashboards Basic+, org sharing +
   kiosk Institution. Confirm against pricing strategy.
5. **Kiosk/ops wall mode** — worth pulling forward for SBIR demo optics?

## 13. Success metrics

- ≥40% of returning visitors have a non-default layout within 30 days
  (product analytics: `layout_save` reach).
- Preset adoption ≥60% of first-runs; median time-to-first-custom-panel
  < 2 min.
- Panel dwell concentration DOWN (users see *their* panels, not scroll
  past ours); `sw_dwell_60s` up on customized layouts vs default (A/B
  via the existing experiments channel).
- Alert-threshold setters (the §6 profile) ≥25% of signed-in users —
  the bridge metric into the tiered alert product.
- Zero regression: existing per-panel gates + nav-lint + boot probes
  stay green through every phase.

---

*Created 2026-07-22 (flux-rope Phase 4 close-out planning). Companion
docs: FLUX_ROPE_SIMULATOR_PLAN.md (engine + consumers),
DESIGN_TOKENS.md (token discipline to port), js/layout-lab.js header
(the v1 foundation this extends).*
