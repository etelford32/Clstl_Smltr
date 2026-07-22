# Space Weather Dashboard v2 — the signed-in mission console (plan)

> **Plan only — no implementation in this document's commits.** Product
> target: a RE-DO of `space-weather.html` as the platform's signed-in,
> per-user **space weather dashboard** for two primary personas —
> **Aurora Chasers** and **Satellite Operators** — built around a
> true-3D **Stage** (one continuous Sun→Earth scene) with a fully
> customizable instrument dock. It is its own surface: the account
> dashboard (`dashboard.html`) remains the account dashboard —
> especially for superuser/admin — and is NOT absorbed or renamed.
> Decisions marked ⚠ need the author's call (§13) before their phase.
>
> Decisions already made by the author (2026-07-22): the dashboard is
> **sign-in gated** (authenticated users only); primary personas are
> **Aurora Chaser + Satellite Operator**; the 3D presentation is a
> first-class design object, not a widget. The six §13 questions were
> answered 2026-07-22, and #1 was REVISED same day: no account-home
> absorption — this is a redesign of the space-weather page itself, with
> additional features for signed-in users. §13 is the decisions-on-record
> table; no open blockers remain.

---

## 1. Vision

Today the page is a *general* feed viewer: ~20 author-arranged panels and
three separate pseudo-3D views that are actually 2D-canvas projections
(`getContext('2d')` — the helio hero, the transit view, the globe). The
platform's REAL 3D and its validated physics live elsewhere: the
raymarched flux-rope heliosphere (kernel-oracle GLSL), the EarthView
globe, the ring-current layers, the Shue magnetopause form, the aurora
boundary tables, TLE pass prediction.

v2 inverts both axes at once:

- **Presentation**: one cinematic, data-true 3D **Stage** — a continuous
  Sun→Earth corridor the camera inhabits — replaces the disconnected
  2D pseudo-views. Panels stop being the page; they become the
  **instrument dock** around the Stage.
- **Ownership**: the page is composed per user — panels, thresholds,
  locations, assets, camera home — and lives behind sign-in. It is the
  platform's retention core as the SPACE WEATHER surface; account
  administration stays on the account dashboard, which it does not
  replace.

One sentence: **your sky and your fleet, on one stage, with honest
uncertainty — arranged by you.**

## 2. What exists (build on it, don't rediscover it)

| Asset | State | v2 role |
|---|---|---|
| **Layout Lab** (`js/layout-lab.js`, node-tested) | SHIPPED: drag-reorder, hide, span, resize, personal layouts (localStorage), A/B variants, export/import, `sw_panel_interact` / `sw_dwell_60s` goals | Foundation of the instrument dock; v2 adds registry, gallery, per-panel config, presets, cloud sync — extend, don't fork |
| Flux-rope engine + shared provider (`js/flux-rope-forecast.js`) | SHIPPED, 5 validated generations | The Stage's CME actors + every forecast instrument's data spine |
| Raymarched heliosphere view (`js/flux-rope/view.js`, WebGL2) | SHIPPED on flux-rope.html | Seed of the Stage's corridor renderer (kernel-oracle discipline proven) |
| EarthView globe stack (earth.html: THREE, aurora, city markers, sat tracker, `nextPasses`) | SHIPPED | Seed of the Stage's Earth station + My Sky staging |
| Ring-current globe/ionosphere layers, `shueStandoffRe`/`shueAlpha` | SHIPPED | Magnetosphere station geometry (Shue surface IS the validated form) |
| `boundaryForKp` (verdict engine), `stormOutlook`, aurora tiers | SHIPPED | Aurora oval banding + tier banner, one threshold grammar |
| τ-clock discipline (flux-rope page), hindcast replay bundles | SHIPPED | The Stage's global timeline (past-replay / now / forecast) |
| `js/preview-mode.js` (`?preview=1` fullscreen-stage, zero interactivity) | SHIPPED | The attract loop / marketing embed of the Stage, and the signed-out teaser |
| Auth stack (`js/auth.js`, signin redirects, `tests/auth-tier-redirect.spec.js`, funnel telemetry) | SHIPPED | The sign-in gate mechanics (§4) |
| `telemetry.recordFeature` + `js/experiments.js` | SHIPPED | Product analytics channel (§9b) |
| `DESIGN_TOKENS.md`, tier-config, verdict-card interaction patterns | SHIPPED | Visual system port + gating + house UX patterns |

Constraints carried forward: no frameworks/bundlers, flat `*.html`, ES
modules, fail-quiet mounts, additive Layout Lab semantics, kernel-oracle
discipline for anything the GPU draws.

## 3. The sign-in gate (new commitment)

- **Hard gate, authentication not paywall**: `space-weather.html` checks
  the session at boot (before heavy init); signed-out visitors are
  redirected to `signin.html?next=/space-weather.html` (house pattern —
  the tier-redirect spec already pins this flow family). **DECIDED**: the
  gate is authentication-only — free signed-in accounts get the full
  customizable console (the growth loop); Basic+ gates cloud sync /
  multi-dashboards; Institution gates org sharing / kiosk.
- **The signed-out moment is a marketing asset, not a wall**: the signin
  page (and pricing/landing embeds) get the Stage's **attract loop** — a
  non-interactive cinematic auto-flight at *current live conditions* via
  `?preview=1` (the mechanism exists) — so the gate sells what it
  protects. CTA pair: "Sign in" / "Request access" (B2G path,
  request-access.html per the strategic frame).
- **Deep links survive** the round-trip (`?next=` preserved, layout and
  station params included).
- **Funnel instrumentation**: `gate_view → signin_start → signin_done →
  first_layout_touch` through the existing auth-funnel channel; the gate
  is an experiment surface (copy/att­ract variants) via experiments.js.
- **DECIDED (revised 2026-07-22) — separate surfaces, no absorption.**
  `dashboard.html` REMAINS the account dashboard — the admin/superuser
  home (view-as tier debugging, admin analytics, account management stay
  there, untouched). The redesigned space-weather page keeps its own
  identity ("Space Weather" in nav — no naming collision to resolve) and
  is reached from nav and from a prominent "Open your space weather
  dashboard" tile on the account dashboard (a bridge, not a merge). The
  post-signin default destination is UNCHANGED. Deep links into
  space-weather still round-trip through `?next=`. QA note: the
  superadmin `pp-view-as` override applies here like any tier-gated
  surface — the tool for testing Basic+/Institution gating of cloud sync
  and org features.
- **What signing in unlocks (vs the old public page)**: the entire v2
  feature set is signed-in — composition (registry/gallery/presets),
  per-panel config, the threshold profile, saved locations + fleet
  assets on the Stage, cloud sync (Basic+), the alert ledger and
  personal analytics. The old page's PUBLIC marketing/SEO role transfers
  to the attract loop on the landing/pricing heroes and `?preview=1`
  embeds (decision #6) — a stated consequence of the gate, mitigated,
  not ignored.

## 4. Personas (locked) → stagings + presets

Primary (design-polish priority, D1/S1):

1. **Aurora Chaser** — *"Will I see it from here, and when do I drive?"*
2. **Satellite Operator** — *"What does the next 72 h do to my fleet?"*

Secondary presets (ship as layouts, polish later): Forecaster/Researcher,
Educator, Casual. Each persona = a **Stage staging** (camera home +
scene dressing, §5.6) + an **instrument dock preset** + default
thresholds. Everything remains editable — presets are starting points.

## 4½. THE HOOK — one image, aimed at the pain

The Stage is architecture; the HOOK is the single recurring image every
touchpoint leads with: **something real, approaching something YOURS,
with the uncertainty visibly tightening.** Possession + approach +
countdown — never "here is the solar system."

- **Chaser hook shot**: the aurora oval BAND (p10/p50/p90 edges) sliding
  toward *your pin* as you scrub to tonight, with one number — "edge
  ≈ 180 km north of you at 23:40" — and the drive-ring drawing the
  decision. Pain mapped: wasted drives and missed nights caused by
  planetary numbers that say nothing about *their* horizon; the band
  (not a line) is the anti-hype trust repair.
- **Operator hook shot**: P10/P50/P90 arrival wavefronts bearing down on
  *your fleet*; the magnetopause breathing toward GEO at arrival; your
  altitude shell warming through the drag ramp with the Starlink-2022
  reference scar. Pain mapped: the 2022 blindside (indices ≠ my asset,
  my altitude, when) and the unanswerable "are we exposed?" — the hook
  IS the briefing slide (hence the D3 print theme).
- **Signature move (the differentiator as a feeling)**: ghost ropes
  pruning and wavefronts pulling together as L1/STEREO data arrives —
  the user WATCHES the forecast firm up. Storm anxiety is mostly
  not-knowing-when; the hook shows the not-knowing shrink. Only a
  client-side ensemble can render this.
- **Placement rule**: the attract loop ENDS on the persona moment with
  the line "Where will it be when it reaches you?"; first sign-in lands
  on your staging with your pin placed; every alert email deep-links to
  the exact Stage view that fired it. Same image at every distance from
  the product. Design-review test for any Stage/dock work: does this
  screen still read as *approach toward something the user owns*?

## 5. THE STAGE — the 3D presentation architecture

This is the centerpiece. Not "a 3D widget in a card": **one continuous,
data-true Sun→Earth scene** that the whole dashboard is arranged around.

### 5.1 Why one scene

Three separate canvases with three implicit cameras (today) means no
narrative continuity, competing focal points, and physics drawn three
different ways. One scene gives: cause→effect as camera motion (the Sun
*launches*, the corridor *carries*, the magnetosphere *receives*, your
sky *responds*); one lighting/scale/color grammar; one render budget;
and picking/synchronization between 3D objects and dock instruments.

### 5.2 Scene graph (every element has a data oracle — nothing decorative)

- **Sun** — live active regions (SRS/HEK feeds already ingested), flare
  glints on X-ray events; rotation at true Carrington rate under the
  τ-clock.
- **Inner heliosphere corridor** — Parker-spiral context geometry
  (ambient field lines, faint); **CME flux ropes as the raymarched
  croissants** (the existing kernel-oracle GLSL — geometry from the SAME
  member params the forecast uses), with ensemble ghost ropes
  weight-faded exactly as the flux-rope page already does.
- **L1 sentinel** — a marked station with a live instrument chip
  (current Bz/V/N, assimilation ESS/λ when the filter is armed); the
  "now-line in space".
- **Magnetosphere** — Shue-form magnetopause surface (`shueStandoffRe`,
  `shueAlpha` — validated, already in the codebase), bow shock, tail;
  the surface BREATHES with Pdyn (observed now; forecast band later on
  the timeline).
- **Earth** — night lights, live cloud layer (existing mosaic tech),
  terminator; **aurora oval as a BAND** (p10/p50/p90 equatorward
  boundaries from `boundaryForKp` over the Kp forecast distribution —
  uncertainty as geometry, not error bars); the user's location pin(s)
  with a sightline to the oval edge.
- **Orbital shells** — LEO/MEO/GEO context rings; live asset orbits from
  TLEs (satTracker/pass-predictor tech); **drag heat-shell**: a
  translucent altitude shell colored by the density outlook at the
  operator's configured altitude.
- **Arrival wavefronts** — translucent shells at the ensemble's P10 /
  P50 / P90 arrival distances: the storm's *where-is-it-now* made
  visible, honest about spread.

### 5.3 Scale honesty

True Sun–Earth scale is unusable (Earth would be sub-pixel). The
corridor uses **piecewise-compressed distance** (near-Sun and near-Earth
zones near-true, mid-corridor log-compressed) with a persistent scale
ruler and a "true scale" toggle that animates the compression away —
honesty about the compression is part of the design, stated on-stage.

### 5.4 Camera stations & flights (the narrative grammar)

Authored stations, smooth flights between them; user orbit within bounds
per station; double-click reset (house pattern). Every flight is a
cause→effect edge:

1. **Solar Watch** — Sun close-up; ARs, flare pips, launch history.
2. **Corridor** — side-on Sun→Earth; ropes in flight, wavefronts, L1.
3. **L1 Approach** — ride at the sentinel; the fan chart docks beside
   live in-situ; assimilation visually "grabs" ghost ropes (weight fade)
   as data arrives.
4. **Magnetosphere** — the receiving end; magnetopause vs GEO ring,
   ring-current glow tie-in.
5. **My Sky** (Aurora Chaser home) — ground-level look-north from the
   user's pin: horizon, cloud layer, the oval band overhead/poleward,
   dark-window shading; "the forecast as you'd see it".
6. **Orbit Ops** (Operator home) — Earth with shells + assets; drag
   heat-shell; magnetopause proximity to GEO; conjunction/decay chips.

### 5.5 Time — the global τ-timeline

ONE scrubber governs the Stage and every dock instrument (chart cursors
included): **past** (observed replay from bundles/feeds) | **now-line**
| **future** (forecast regime — the scene renders the ensemble: ghost
ropes, oval band, wavefront spread). τ-presets ×1/×100/×1000 (the
flux-rope τ-clock discipline generalizes). Scrubbing into tomorrow night
and WATCHING the oval band cross your pin is the aurora product;
scrubbing arrival and watching the magnetopause compress past GEO is
the operator product.

### 5.6 Persona stagings

- **Aurora Chaser staging**: My Sky home; oval band breathing with the
  forecast Kp distribution; drive-ring annotation ("oval edge ≈ 220 km
  north at 23:10 local"); cloud overlay; moon phase lighting; one-tap
  "show me why" flight to the Corridor and back.
- **Operator staging**: Orbit Ops home; per-asset config (altitude;
  **DECIDED**: assets come from a CelesTrak picker — search by name /
  NORAD ID over the already-ingested catalogs, no uploads in v1); drag
  heat-shell at asset altitudes with
  the Starlink-2022 reference band; timeline pins at P10/P50/P90 arrival;
  tier banner wired to *fleet* thresholds (Dst/density), not just Kp.

### 5.7 Presentation & staging principles

- **One WebGL context** for the Stage; dock instruments are 2D
  (charts/HTML). Hero band layout: Stage persistent at top (resizable —
  the `data-lab-resize` machinery exists), dock grid below/beside;
  "Stage solo" mode for wall screens.
- **Picking = navigation**: click a rope → its forecast panel focuses +
  chart cursors sync; click the pin → My Sky; click an asset → its risk
  chip. The Stage is the index into the dock.
- **Annotation grammar**: billboarded labels with leader lines, chips
  anchored to 3D objects, max N annotations per station (declutter
  rule), all text in the HTML overlay layer (crisp, accessible,
  screen-reader reachable) — never rasterized into the canvas.
- **Uncertainty grammar (the differentiator, visualized)**: bands and
  ghosts, never single lines, in the future regime; sharpening as
  assimilation narrows (ESS visibly prunes ghosts). Motto on record:
  **no single-line futures in 3D.**
- **Degraded-state visibility**: a stale feed DIMS its element and chips
  "NOAA mag stale 14 min" — fail-quiet must be visible, never silent.
- **Performance budget**: adaptive DPR, off-viewport/backgrounded pause,
  context-loss recovery, LOD per station; mobile gets the same scene at
  reduced dressing + a static-frame fallback for WebGL-less clients;
  `prefers-reduced-motion` swaps flights for cuts. (Software-GL CI
  lesson applies: interaction tests must not depend on frame rate.)
- **Oracle discipline extended**: every Stage element that encodes data
  has a pinned source of truth (kernel probes for ropes, Shue form for
  the magnetopause, boundary tables for the oval, TLE propagator for
  assets) and a node/browser gate, exactly like the flux-rope view's
  kernel-mirror contract. Display-only omissions get documented headers.

## 6. The instrument dock (customization model — unchanged core, now around the Stage)

Layout Lab v1 → v2 as previously planned: **registry** (self-describing
panels with config schemas, multi-instance), **gallery drawer** with live
previews, **grid** with density modes (comfortable/compact/ops), **per-
panel config sheets**, **presets** as named layout-variants, **persist**
localStorage-first + cloud sync signed-in (**DECIDED**: the named/
versioned `dashboards` table — several per user, org-ready; migration
ships as SQL and is applied only on the author's go), **share** via
layout links/export. The Stage registers as a special
always-first panel whose "config" is station + dressing + solo mode.

## 7. Panel catalog v2 (dock instruments)

Forecast family (all via the ONE shared provider): Bz fan (thresholds
drawn on-fan, horizon, ESS detail), arrival countdown (big-type P10–P90 +
P(hit)), Dst/storm-depth outlook, **my alert tier** (Watch/Warning/
Nowcast at MY threshold + inline subscribe — closes the loop with the
fixed sender), per-location aurora tonight (multi-instance), LEO drag
index (per-asset altitude).
Live-now family (existing, gain config): solar wind strip, Kp/G-R-S,
X-ray, DONKI list.
Trust family (§9a): validation scorecard, personal storm log, alert
ledger, forecast-vs-actual.
Utility: notes/ops-log, clock strip, links.

## 8. One threshold system

Unified per-user profile `{ kp, gScale, minBzNt, dstNt, leoAltKm }` with
a single editor; consumed by every instrument, the Stage (oval band
emphasis, heat-shell coloring, tier banner), the verdict tier, and the
aurora alert sender. Set your line once; the whole console honors it.

## 9. Analytics — both meanings

**a) FOR the user (trust + retention):** validation scorecard wearing the
pinned hindcast numbers AND misses (St. Patrick's shock 0.0 h / min
1.3%; Gannon internal shock 0.2 h / min 0.3%; the −280-vs−412 pipeline-
ceiling finding); personal storm log (crossings of YOUR threshold, with
"what the engine said N h before" replay links); alert ledger
(hit/false-alarm record per user — honesty as a feature); rolling
forecast-vs-actual strips.

**b) ABOUT usage (tune the product):** instrument the customization loop
and the STAGE (station changes, flight usage, scrub depth into the
future, picking) through `recordFeature` + experiment goals:
`panel_add/remove/config/move`, `preset_apply`, `layout_save/share`,
`station_change`, `timeline_scrub_future`, `stage_pick`,
`threshold_set` (bucketed), per-panel dwell. Decisions it feeds: default
station per persona, panel kill-list, threshold-default tuning, attract
loop content. Privacy posture unchanged (anonymous surface, no raw
locations, bucketed values).

## 10. Visual system

Port the DESIGN_TOKENS discipline to this page (one `:root`, surfaces /
text scale / borders / spacing / transitions); ONE status grammar
(quiet / elevated / watch / warning / severe — colorblind-safe,
shape+text redundant) shared by Stage elements, chips, fan thresholds,
tier banner, and alert emails; one card chrome (title · source chip ·
freshness · ⚙ · drag); glance-first **status band** (tier at your
threshold · arrival countdown · Kp now · tonight at your pin) pinned
above the Stage; numeric KPIs in the mono stack at 3 sizes; chart
language identical to the flux-rope charts sitewide; motion restraint
(≤200 ms tweens, pulses only on threshold crossings).

## 11. Usability program

First-run (post-signin): persona → location → threshold in ≤3 taps →
staged reveal (attract-style flight lands on your staging). Edit mode:
explicit toggle, gallery drawer with live previews, drag/resize/undo/
reset-to-preset, full keyboard operability + aria-live announcements.
Mobile: status band sticky, Stage as a swipe-station carousel, single-
column dock with its own priority order, bottom-sheet config. Perf: <2.5 s
LCP on the default preset (Stage streams in after first paint), lazy
dock mounts, ONE feed bus. A11y gate in CI (axe + keyboard walkthrough).

## 12. Phasing (D = dock, S = stage; interleaved)

- **D1+G — Foundation + gate. ✅ SHIPPED 2026-07-22.** Sign-in gate +
  funnel + attract stub (current page in `?preview=1`); the
  account-dashboard bridge tile (dashboard.html itself otherwise
  untouched); registry with legacy adapters; grid + v2 layout schema
  (+ v1 migrator); gallery; five presets; status band; token port.
  Exit criteria met: signed-in users compose/save/restore
  (tests/space-weather-compose.spec.js); signed-out see gate + teaser
  (tests/space-weather-gate.spec.js); nav-lint + existing gates green.
  Landed as: gate module in space-weather.html (preview + OAuth-hash
  exemptions, fail-open posture documented inline);
  `js/space-weather-registry.js` (+ registry↔page↔presets drift gate
  tests/space-weather-registry.mjs); layout-lab v2 `{v:2, preset}` with
  a permanent v1 migrator; `data/layout-presets/space-weather.json`
  (five persona presets, total orders); gallery drawer + preset picker
  in the Layout Lab designer; `js/space-weather-status-band.js` (pure
  model over the verdict-engine oracles + tests/space-weather-status-band.mjs;
  consumes the ONE provider run `js/flux-rope-dashboard.js` publishes
  via the 'flux-rope-forecast' event); the `--sw-*` token block in the
  page `:root`. Deferred within D1 scope, deliberately: gallery live
  previews, density modes, and per-panel config sheets (D2).
- **S1 — Stage core. ✅ SHIPPED 2026-07-22.** One-context corridor scene:
  Sun, ropes (kernel-oracle), L1, Earth, compressed-scale ruler;
  stations 1–4 + flights; τ-timeline driving Stage + chart cursors.
  Landed as: `js/stage/scale.js` (piecewise-compressed radial map +
  true-scale mix + disclosed body/local-frame exaggerations;
  tests/stage-scale.mjs) and `js/stage/model.js` (rope surface = the
  view.js SDF zero level built ONLY through the already-exported
  view.js mirrors; ghost members + weighted wavefront quantiles; Shue
  surface via the ring-current oracle; stations/flights;
  tests/stage-model.mjs pins the mirrors against the committed WASM's
  fr_apex_km_at / fr_sigma_apex_km_at) + `js/stage/stage.js` (three.js
  renderer: median rope probed straight off the provider's LIVE kernel
  instance, vertex Bz sampled oracle-DIRECT via kernel.fieldAt, ghosts
  weight-faded by the assimilated fan, P10/P50/P90 wavefront shells,
  breathing Shue magnetopause at disclosed Earth-local R_E scale, HTML
  overlay annotations, DPR clamp + visibility pause + context-loss
  fallback + reduced-motion cuts). τ contract: the Stage scrubber
  ([now−24 h, now+72 h], Now, ×1000 play) dispatches `sw-tau`
  {tauMs, regime}; the flux-rope panel chart cursor follows. The Stage
  registers as panel `stage`, first in all five presets. Browser gate:
  tests/space-weather-stage.spec.js (boot, stations, τ contract,
  true-scale toggle — offline, quiet-corridor). **The three 2D
  pseudo-views are NOT yet retired** — that stays behind explicit
  parity review, as planned. S2 upgrades on record: live active
  regions on the Sun, forecast-band magnetopause breathing, aurora
  oval band + persona stagings, picking→dock sync.
- **S2 — Persona stagings. ✅ SHIPPED 2026-07-22.** My Sky + Orbit Ops
  (oval band, drive ring, shells, heat-shell, CelesTrak asset picker),
  uncertainty grammar complete (ghosts, wavefronts, magnetopause
  breathing), picking→dock sync. Landed as: stations 5–6 in
  `js/stage/model.js` stationDefs; the aurora oval as a p10–p90 BAND
  between forecast-Kp boundary quantiles — `ovalLatAtLon` numerically
  inverts the verdict-engine dipole (node-pinned against the oracle) and
  `kpBandAt` consumes the page's EXISTING probabilistic-Kp trajectory
  (the 'earth-forecast-update' arp mean/lo80/hi80 — never re-derived);
  mean-sun geographic + TEME display frames (equation-of-time and
  obliquity omissions documented in the module header; real pass timing
  stays with js/pass-predictor.js); My Sky = ground-level look-north
  from the ppx_user_location pin with the drive-ring annotation ("oval
  edge ≈ N km poleward", via the same verdict-engine oracles the alert
  products use); Orbit Ops = LEO/GEO shells + drag heat-shell colored
  by the UA-engine density ratio at the fleet's mean altitude +
  CelesTrak picker (/api/celestrak/tle by NORAD id or name over the
  edge-cached active group; ≤8 assets, localStorage-persisted; live
  dots via the house SGP4 js/satellite-tracker.js propagate, orbit
  rings from mean elements); picking (rope → forecast-panel focus,
  pin → My Sky, asset → label highlight) dispatching `sw-pick` —
  one-way Stage→dock like sw-tau. Scale-honesty consolidation rode
  along: the drawn Earth is now EXACTLY 1 R_E in the Earth-local frame
  (stage/scale.js BODY), so surface features, shells, and the
  magnetopause share ONE local scale. The forecast-band magnetopause
  breathing (vs observed-now) remains an S3-era upgrade.
- **D2 — Personalization depth. ✅ FULLY SHIPPED 2026-07-22** (core arc
  + the remainder in a second round). The remainder landed as:
  · **Multi-instance panels**: registry entries may set `multiInstance`
    (no static markup; a `<template id>` + a page `instantiate` factory
    instead — drift test amended); instance ids are 'base#n'; applyLayout
    recreates saved instances through the factory before merging; the
    gallery gets ＋Add / per-instance ✕. First tenant: the aurora-spot
    card (js/aurora-spot-card.js — 'Aurora tonight — <spot>' via the
    SAME verdict-engine GO oracle, location per instance from the
    ppx_user_locations list + pin, persisted in the panel-config store).
    Presets deliberately exclude multi-instance ids (user-created).
  · **Mobile order**: v2 zones gain optional `orderMobile`; applyLayout
    picks it under 768 px; capture follows "arrange on the device you're
    on" (mergeCapturedOrder preserves the other side from the prior
    doc); chaser + operator presets carry curated single-column orders.
  · **First-run flow (§11)**: js/sw-first-run.js — once, post-signin,
    skipped for existing users and previews: persona → location →
    Kp line in ≤3 taps, writing through the REAL stores (preset layout,
    saveUserLocation, saveProfile with the alert handoff), then a
    staged reveal — one reload and the Stage flies to your persona's
    home staging. Funnel: first_run_view→…→done.
  The earlier core landed as:
  · **Threshold profile (§8)**: `js/threshold-profile.js` — ONE line
    {kp, minBzNt, dstNt, leoAltKm} (gScale DERIVED from kp, never
    stored), localStorage + 'threshold-profile-changed', ⚙ editor on
    the status band (stable-shell markup so refreshes can't eat it).
    Consumers: the band's Kp cell escalates at YOUR line; the Stage's
    heat-shell altitude defaults to leoAltKm and the oval median goes
    warning-orange when forecast p50 crosses your Kp. THE HANDOFF:
    saving writes user_profiles.aurora_kp_threshold via
    auth.updateProfile — the same column alert-engine, account.html,
    and the alert products already read. tests/threshold-profile.mjs.
  · **Config sheets (§6)**: registry entries may carry typed `config`
    schemas (stage: default station / spirals / ghost count); values
    live in the per-page panel-config store (OUTSIDE the layout doc —
    the sizes-store rationale: never silently re-bucket an A/B view),
    surfaced via window.__swPanelConfig + 'sw-panel-config'; gallery
    rows get ⚙ sheets; the Stage consumes live + at boot.
  · **Cloud sync (§6, decisions #2/#3)**: `supabase-dashboards-
    migration.sql` committed **PENDING — apply only on the author's
    go**; ownership-only RLS (tier gating client-side, rationale in the
    header); doc = {layout, config, sizes} per (user, page, name).
    `js/dashboard-sync.js`: local-first, Basic+/tester/admin gate,
    JWT from the sb-* session entry, pull-newer-wins with ONE guarded
    reload, debounced push on save/config events, self-disables on
    the missing table (PGRST205 → 'migration-pending').
    tests/dashboard-sync.mjs + tests/space-weather-d2.spec.js (4).
- **D3 — Analytics & trust.** User-facing analytics family, product
  instrumentation + first tuning pass, density/ops mode, a11y + perf
  gates, print/light theme for operator shift briefings (DECIDED: in
  scope).
- **S3/D4 — Polish & reach.** Attract loop shipped to BOTH the signin
  gate and the public landing/pricing heroes (DECIDED), layout links,
  org dashboards, kiosk mode, mobile fallback frames.

Each phase is a PR-sized arc with its own gates (pure-model node
fixtures; Playwright: gate flow, compose/persist, station flights,
timeline sync, a11y), per house workflow.

## 13. Decisions on record (author, 2026-07-22)

| # | Question | Decision |
|---|---|---|
| 1 | Relation to `dashboard.html` | **REVISED 2026-07-22: separate surfaces.** dashboard.html stays the account dashboard (admin/superuser home, untouched); this is a re-do of the space-weather page as the signed-in customized dashboard, keeping its own nav identity, linked by a bridge tile — no absorption, no renames, post-signin destination unchanged |
| 2 | Gate scope | **Authentication-only** — free signed-in accounts get full customization; Basic+ gates cloud sync/multi-dashboards; Institution gates org sharing/kiosk |
| 3 | Cloud-sync shape | **Named/versioned `dashboards` table** (several per user, org-ready); migration SQL committed, applied only on the author's go |
| 4 | Operator asset ingestion | **CelesTrak picker** (name / NORAD ID search over ingested catalogs); no uploads in v1 |
| 5 | Print/light theme | **Yes — D3 scope** (operator shift briefings) |
| 6 | Attract-loop placement | **Signin gate + public landing/pricing heroes** |

No open blockers remain — every phase can start.

## 14. Success metrics

Gate funnel: gate_view→signin conversion ≥ baseline signup ×1.5 (the
attract loop earns its keep or gets iterated); account-dashboard bridge
tile CTR tracked (does the surface pull daily returns without being the
forced home?). ≥40% of returning
signed-in users run a non-default layout within 30 days. Preset adoption
≥60% of first-runs; median time-to-first-custom-panel < 2 min.
Stage engagement: ≥50% of sessions change station or scrub the future
(else the Stage is decoration — redesign it). Threshold-profile setters
≥25% of signed-in users (bridge into the alert product). Zero
regression: all existing per-panel + nav + boot gates stay green
through every phase.

---

*Updated 2026-07-22 (later the same day): phase D1+G shipped — see §12.
Earlier: sign-in gate committed; personas locked (Aurora
Chaser + Satellite Operator); the Stage (§5) added as the presentation
centerpiece — supersedes the earlier grid-only framing. Companions:
FLUX_ROPE_SIMULATOR_PLAN.md, DESIGN_TOKENS.md, js/layout-lab.js header,
js/preview-mode.js header.*
