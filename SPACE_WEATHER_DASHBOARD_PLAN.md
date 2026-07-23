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
  **REVISED 2026-07-22 (author: "a more efficient sign-in gate")**: the
  gate is now a CLASSIC inline script that runs at parse time — pp_auth
  mirror (or a raw sb-*-auth-token) checked synchronously, overlay
  removed before first paint for signed-in visitors, immediate
  `location.replace` for anonymous ones. The previous module-script gate
  deferred behind the page's whole module graph (seconds of overlay).
  Exemptions (preview / OAuth-hash) and the fail-open rule unchanged.
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
  (2026-07-22: the `gate_view` step was dropped with the inline gate —
  it required importing the funnel module before redirecting, defeating
  the efficiency goal; signin_start onward still fires on signin.html.)
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

~~First-run (post-signin): persona → location → threshold in ≤3 taps →
staged reveal~~ **REMOVED 2026-07-22 — the author rejected the modal
flow on sight ("remove the 3 modal questions… not cool"). Standing
rule from this: no blocking onboarding UI on this surface; personas
stay one click away in the Layout Lab preset picker.** Edit mode:
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
  ([now−7 d, now+30 d] since the 2026-07-22 fix round — widened from
  −24 h/+72 h to match the CME arrival calendar; Now, ×9000 play)
  dispatches `sw-tau` {tauMs, regime}; the flux-rope panel chart cursor
  and the calendar's day cursor follow. The Stage
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
  · **First-run flow (§11) — REMOVED 2026-07-22 at the author's
    direction** ("remove the 3 modal questions… not cool"): the
    persona/location/threshold modal shipped in this arc and was pulled
    the same week — js/sw-first-run.js deleted, mount + staged-reveal
    hook removed, spec seeds stripped. The lesson stands in §11: no
    blocking onboarding UI without an explicit ask. The stores it wrote
    (presets, saveUserLocation, threshold profile) all remain reachable
    through the gallery, the header location box, and the band ⚙.
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
- **D3 — Analytics & trust. ✅ CORE SHIPPED 2026-07-22** (trust panels +
  §9b Stage instrumentation + print briefing; still open within D3:
  the alert ledger + forecast-vs-actual strips [server-side history
  needed], density/ops mode, the a11y + perf CI gates, and the first
  analytics tuning pass). Landed as:
  · **Validation scorecard** (panel `scorecard`, family trust): the
    pinned hindcast numbers (St. Patrick's shock 0.0 h / min 1.3% /
    r 0.686; Gannon leading −0.8 h / internal Δ0.1 h / min 0.3% /
    r 0.663) AND the documented −280-vs−412 Dst-ceiling miss, with a
    comment pointing at the enforcing gates.
  · **Personal storm log** (panel `storm-log`, family trust):
    js/storm-log.js — rising-edge crossings of YOUR threshold-profile
    Kp line with hysteresis (one episode, one entry), localStorage
    ring; tests/storm-log.mjs.
  · **§9b Stage instrumentation**: recordFeature('sw_stage', …) for
    station_change, timeline_scrub_future (once/session — the §14
    engagement metric), stage_pick, truescale_toggle.
  · **Print briefing** (decision #5): @media print light theme — the
    status band + forecast/trust panels ARE the shift briefing;
    canvas-heavy sims and chrome drop out; 🖨 button in the header.
    Browser gate: tests/space-weather-d3.spec.js (3).
- **S3/D4 — Polish & reach. ✅ ATTRACT + PARITY REVIEW SHIPPED
  2026-07-22** (still open: layout links, org dashboards, kiosk mode,
  mobile fallback frames). Landed as:
  · **Attract loop (decision #6)**: `data-preview-stage` moved from the
    helio hero to the Stage — `?preview=1` now promotes the Stage; in
    preview the Stage runs the cinematic (7 s auto-flight cycle through
    the stations, ENDING on the persona moment: Orbit Ops + "Where will
    it be when it reaches you?"; reduced-motion holds a static corridor
    with the line). Shipped to all three touchpoints: the signin gate
    (fixed backdrop iframe behind the auth card, faded in on the
    preview's 'preview-ready' post), the landing page ("The storm, on
    one stage" section + CTA pair incl. request-access), and the
    pricing hero. All embeds lazy — the pages never wait on them.
  · **2D pseudo-view PARITY REVIEW — conclusion: gates NOT met, nothing
    retired.** The honest gap table:
      – helio hero vs Stage: the Stage lacks the hypothetical-mode
        scenario dials (Sprint 5), flare-event pips, and planet
        ephemeris context. Retirement gate: scenario mode + flare pips
        on the Stage, plus a side-by-side session showing no unique
        reads left.
      – transit view vs Stage: the Stage's L1 chip covers the live
        values, but not the transit view's parcel lead-time readouts
        and arrival-clock strip. Retirement gate: a corridor-station
        parcel/lead-time annotation with pass-predictor-grade timing.
      – globe vs Stage: ~~the Stage Earth has no texture/terminator
        detail~~ (2026-07-22 fix round: the Stage Earth is now
        blue-marble day/night textured with a mean-sun terminator,
        mapped through the SAME earthLocal convention as the pin/oval),
        but still no aurora TEXTURE rendering and no per-CME impact
        animation the globe carries. Retirement gate (remaining):
        oval-band visual parity at the My Sky station + impact animation.
    The three panels REMAIN in the registry and presets (hidden by
    default where personas don't need them) — per the standing rule,
    they retire only when these gates pass, panel by panel.
- **FIX ROUND — ✅ SHIPPED 2026-07-22** (author's live-testing feedback,
  same day as the S3/D4 push). Landed as:
  · **First-run modal REMOVED** (see §11 — author's direction).
  · **Inline synchronous sign-in gate** (see §3 revision).
  · **Header location box**: js/sw-location-box.js under the page
    title — displays/edits the ONE ppx_user_location store through
    js/user-location.js (profile-mirror seed on first visit); the band,
    Stage pin, and aurora-spot cards follow via 'user-location-changed'.
  · **Data-flow hardening**: /api/noaa/passthrough (allowlisted
    same-origin SWPC mirror) as an automatic fallback in js/swpc-feed.js
    and js/flux-rope-live.js for clients whose networks block NOAA
    (the "data isn't flowing" class from the field — root cause was
    client-side blocking, not the pipeline); plus the previously-missing
    END-TO-END live-path spec (tests/space-weather-live-path.spec.js:
    faithful DONKI+RTSW fixtures through the REAL WASM ensemble to
    panel + Stage + band, and a NOAA-blocked mirror-fallback case).
  · **CME arrival calendar**: js/cme-calendar.js replaced the event-card
    row in the cme-forecast panel — rolling −7 d (observed band,
    visually distinct) … +30 d UTC grid; ⊕ arrival chips (WSA-ENLIL
    preferred, DBM CmeEvent fallback — SAME oracle as the globe),
    launch dots, ensemble P10–P90 span + P50 day from the ONE provider
    run; two-way τ link (day/chip click → __swStage.setTau; sw-tau →
    day cursor). The Stage τ window widened to [−7 d, +30 d] (×9000
    play) to match. Node gate tests/cme-calendar.mjs; browser gate
    tests/cme-calendar.spec.js.
  · **Stage visuals**: procedural Sun (fbm granulation + limb
    darkening + corona halo — display dressing, documented) and the
    textured Earth described in the parity row above.
- **VALIDATION ROUND — ✅ SHIPPED 2026-07-23** (author: "turn the
  calendar into a tracking scorecard for CME prediction correctness so
  we can begin improving our models"). The calendar became the LIVE
  forward ledger of CME_FORECAST_VALIDATION_PLAN.md Phases 2–3:
  api/cron/validation-rerun.js now locks issue-time forecasts per model
  (enlil / ballistic-v1 / dbm-v1 — INSERT-only, revisions issue new
  rows) into the applied cme_* tables and resolves L1 truth after
  passage (Pdyn-shock or honest false alarm; data gaps stay pending);
  /api/cme/skill serves the cme_model_skill leaderboard + recent
  events; js/cme-calendar.js renders the skill strip (per-model MAE /
  bias / ≤12 h hit rate, "skill shown, not claimed"), rewrites resolved
  chips as predicted-vs-actual (strike-through + signed error, false
  alarms marked), adds the next-arrival countdown, an honest
  quiet-corridor note, and a reduced-motion-gated animation pass
  (entrance stagger, today pulse, next-arrival glow). Hindcast receipts
  stay on the separate D3 card — the strip is live-forward only.

Each phase is a PR-sized arc with its own gates (pure-model node
fixtures; Playwright: gate flow, compose/persist, station flights,
timeline sync, a11y), per house workflow.

## 13. Decisions on record (author, 2026-07-22)

| # | Question | Decision |
|---|---|---|
| 1 | Relation to `dashboard.html` | **REVISED 2026-07-22: separate surfaces.** dashboard.html stays the account dashboard (admin/superuser home, untouched); this is a re-do of the space-weather page as the signed-in customized dashboard, keeping its own nav identity, linked by a bridge tile — no absorption, no renames, post-signin destination unchanged |
| 2 | Gate scope | **Authentication-only** — free signed-in accounts get full customization; Basic+ gates cloud sync/multi-dashboards; Institution gates org sharing/kiosk |
| 3 | Cloud-sync shape | **Named/versioned `dashboards` table** (several per user, org-ready); migration SQL committed, **APPLIED 2026-07-22** on the author's go (with the aurora tiered-alerts ledger in the same session) |
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

## 15. S5 — Particle activity (PLANNED 2026-07-23; author: "as dynamic and representative as possible")

The Stage gets a particle layer whose every behavior traces to a
measured feed or the kernel — particles as INSTRUMENTS, not decoration.
"Dynamic" comes from real motion at a disclosed time-lapse; "representative"
means an auditor can point at any particle behavior and name the feed
that drives it.

### 15.1 Oracle → motion map (the honesty contract)

| Particle behavior | Driven by | Oracle |
|---|---|---|
| Ambient stream speed | measured V at τ | SolarWindDriver samples (replay = archived RTSW, live = now-cast, forecast = ensemble driver) — the ONE provider's driver, never a second fetch |
| Stream density (points/volume) | measured n | 'swpc-update' `solar_wind.density` (norm already computed by the feed) |
| Particle color | Bz polarity + \|B\| | driver Bz at τ (SOUTH/NORTH palette shared with the rope) |
| Sheath pile-up (density spike + jitter) | shock/ejecta radii + compression | kernel wavefront quantiles + the v1.x sheath compression ratio — same probes the wavefront shells use |
| Ejecta interior character | field rotation | kernel.fieldAt sampling (rope vertex-color pipeline, decimated) |
| Arrival-spread fan | member kinematics | prior members + assimilated weights (ghost data, re-used) |
| SEP streaks (radiation storm) | GOES proton flux | `proton_flux_10mev` / `sep_storm_level` (S-scale gate); spiral-aligned, minutes-scale transit — visually DISTINCT from the day-scale wind |
| Aurora precipitation at Earth | oval + Kp/Bz | existing kpBandAt / boundaryForKp band (Earth-local frame) |
| Pause/regime | τ scrubber | 'sw-tau' — replay/forecast change the DRIVER SAMPLES, not just playback rate |

### 15.2 The one NEW disclosed dishonesty: flow time-lapse

At wall-clock LIVE, a 450 km/s parcel takes ~4 days Sun→Earth —
imperceptible. The ambient flow therefore renders at a TIME-LAPSE
(default ×3600: one transit ≈ 100 s on screen). Per the §5 scale
doctrine this lives in `js/stage/scale.js` beside the spatial
compression, joins the on-stage disclosure line ("flow shown at
×3600"), and the true-scale toggle drops it to ×1 (an honestly
motionless corridor). τ-playback (×9000) and scrubbing override it —
those move the CLOCK, and the particles follow the driver at τ.

### 15.3 Architecture (perf-first, CI-safe)

- ONE `THREE.Points` GPU system; positions computed IN-SHADER from a
  per-particle seed + uniforms — zero per-frame CPU writes (the
  software-GL CI constraint that killed per-frame geometry updates
  elsewhere).
- Pure field model `windFieldAt(rAu, tauMs, ctx)` →
  `{vKms, nRel, regime: 'ambient'|'sheath'|'ejecta'}` in
  `js/stage/model.js` — node-tested against the kernel probes; baked to
  a small 1D texture at the existing 250 ms updateScene throttle; the
  shader only ever reads the texture.
- Budgets: ≤16k points desktop, ≤4k mobile; excluded from My Sky (sky
  staging); pauses with the existing render-loop gates; reduced-motion
  renders static dust (no advection).
- Test surface: `__swStage` gains `particles` probes (count, timeLapse,
  regimeAt) so Playwright asserts state, not pixels.

### 15.4 Phasing (PR-sized arcs, each behind the standing gates)

- **S5a — Ambient stream. ✅ SHIPPED 2026-07-23.** Landed as: FLOW +
  flowLapse in stage/scale.js (the temporal dishonesty beside the
  spatial one; true-scale blends to ×1); pure windFieldAt in
  stage/model.js (ambient passthrough + the S5b regime boundaries,
  node-pinned); 16k/4k-point in-shader stream in stage.js — one
  advected phase uniform, stageRadius sampled from a baked texture
  (no third copy of the scale math), speed/density/Bz-tint from
  driver.at(τ) with honest climatology fallback, deterministic LCG
  seeds, My Sky excluded, reduced-motion static, disclosure line
  updated. Probes on __swStage.particles; stage spec test 7 pins
  flow/stillness/hiding.
- **S5b — CME structure. ✅ SHIPPED 2026-07-23.** The §15.4b member
  binding, literal: 60/25/15 of the cloud is ambient/ejecta/sheath by
  deterministic seed; each CME particle carries a slot into a 128×2
  member texture baked per updateScene from the PURE memberFieldRows
  (apexes via the same dbmApexKm mirror the wavefronts use, per-member
  lon/lat direction in the ropeFrame eDir convention, filter weight →
  brightness — the fan IS the assimilated distribution). Sheath band
  rides each member front out to sheathK × the kernel σ_apex probe;
  its glow scales with the R–H compression from the EXISTING
  sheathCompression oracle (swap to a kernel probe when the wrapper
  exposes one); ejecta tint from ONE decimated kernel.fieldAt probe at
  the median nose (the rope mesh keeps full-fidelity vertex colors).
  No live forecast → kinds collapse to ambient (measurement, never
  prediction — pinned offline in the stage spec). Probes:
  particles.{cmeActive, members, comp, ejSouth}; live-path spec pins
  the bound cloud end-to-end. Ghosts stay lines — no double-encoding.
- **EVENT REPLAY — ✅ SHIPPED 2026-07-23** (author: "we should be able
  to scrub historically through the most recent events using the
  calendar… show the actual events as options for the canvas").
  New contract `sw-replay-cme` {cme: swpc-feed row} | null: clicking an
  ⊕ arrival chip scrubs τ AND re-runs the page's ONE flux-rope
  provider seeded with that event (`sources.cmes` override — the same
  pipeline, never a fork); the republished result time-travels every
  consumer together: Stage rope + member-bound cloud at the event's
  own transit, band cells relabeled `Outlook/Arrival · REPLAY` (a past
  event must never read as the live watch — node-pinned), panel banner
  with "back to live", Stage Now button exits replay. Assimilation is
  honest per event age: inside the RTSW archive window the filter
  conditions on the ACTUAL observed L1 record; outside it the run is
  the launch-time ensemble and the banner says so. Locked-forecast
  visibility rode along: chips show 🔒 + per-model locked ETAs in the
  tooltip and the strip counts locked events before any resolve —
  the predictor is visibly working while skill accrues. Gate:
  live-path spec 'calendar replay' (full pipeline, both directions).
- **SUN BEHAVIOR — ✅ SHIPPED 2026-07-23** (author: "the sun always has
  behavior… what is the sun doing right now?"). The star expresses its
  MEASURED state at every τ, CME or no CME. swpc-feed keeps a
  ~288-point decimated GOES X-ray series on the bus (`xray_series`);
  pure oracles in stage/model.js — `xrayClassOf` (A/B/C/M/X grammar),
  `sunActivityAt` (nearest-sample τ-lookup, act = log-scaled 0..1,
  latest-flux fallback so live τ always reads the header value) and
  `flareFlashAt` (per-flare envelope: 10-min rise, 40-min decay,
  C/M/X weighted, max-over) — all node-pinned. stage.js drives the
  surface shader (uAct brightens + whitens the granulation), the
  corona sprite (opacity + scale breathe with activity, flash kicks),
  and the always-on vitals chip `☀ X-ray <cls> · FLARE · N ARs
  (n complex) · F10.7` under the Sun (AR disc markers landed with the
  2026-07-23 bug round at Stonyhurst = Carrington − L0(τ)). Scrubbing
  τ through a flare replays it. Probes: __swStage.sun.{cls, act,
  flash}; stage-spec S2 test injects an M5 series + fresh flare and
  pins cls/act/chip.
- **S5c — SEP + aurora ends. ✅ SHIPPED 2026-07-23.** SEP streaks:
  swpc-feed keeps a τ-indexed ≥10 MeV `proton_series` on the bus
  (same decimation as xray_series); pure `sepStateAt` gates on NOAA's
  S-scale AT τ (S1+ per the plan — replaying an old proton event
  lights the spirals then) with log intensity S1→0…S5→1, and
  `SEP_V_KMS` (~0.3 c, documented representative 10–100 MeV speed) —
  both node-pinned. Rendering: THREE.Points SHARING the context
  spirals' geometries (the polyline IS the field line — no second
  spiral math); the shader lights vertices near moving phase fronts,
  racing at 0.3 c under the SAME disclosed flowLapse (true scale =
  1 AU in ~28 real minutes, honestly slow); spirals tint violet and
  the vitals chip appends `☢ S<n> SEP`. Aurora curtains: a wall along
  the oval's MEDIAN ring built from the SAME ovalBandGrid the band
  rebuild computes (never a second oval model), rising AURORA.DRAWN_RE
  per the new scale.js constant — the disclosed ~×10.6 vertical
  exaggeration, stated in the on-stage scale line; green base → red
  top (557.7/630 nm ordering), bounded-arg ray shimmer, intensity
  from the same kpBandAt median. Curtains STAY in My Sky (the sky
  story); streaks hide there. Probes: __swStage.sep.{on,s,pfu10,
  intensity,visible}, curtains.{visible,intensity}. Spec pins the
  S-scale gate, DONKI-free quiet default, disclosure text, and the
  My Sky split. §9b dwell instrumentation rides the existing
  stage_pick/staging telemetry — revisit after the next usage pull.
- **S7 — SYSTEM COMPLETENESS. ✅ SHIPPED 2026-07-23** (author: "Sun ·
  Earth · Moon · Magnetosphere — live photosphere + corona, Shue-1998
  magnetopause, Van Allen belts, Kp/Bz simulation… tied
  deterministically to real-time"). Four additions, each on an
  existing oracle: (1) LIVE PHOTOSPHERE — the Earth-facing hemisphere
  of the Stage sun samples the actual SDO/HMI continuum through the
  house /api/solar/aia proxy (12-min cadence), orthographic disk→
  sphere projection on the near side only; far side stays procedural
  (we don't see it — that's the far-side program's job); fail-quiet:
  offline stays procedural, probe sun.live says which. (2) THE MOON —
  pure moonLocalRe on the SAME new-moon epoch + synodic month as
  verdict-engine moonPhase (the two can never disagree); in the
  Earth-local frame −x is the mean sun, so the synodic angle IS the
  geometry: every full moon the Moon crosses the magnetotail (probe
  moon.inTail; chip says so; node-pinned). World-frame terminator
  shading; drawn 1.1 R_E (×4, the smallest disclosed body
  exaggeration — scale.js BODY.moonExaggeration). (3) VAN ALLEN
  BELTS — pure beltShellGrid dipole L-shells r = L·cos²λ (same dipole
  convention as the oval oracle; house L-values from
  magnetosphere-engine: inner 1.6, outer 5); the OUTER belt breathes
  with the MEASURED GOES ≥2 MeV electron flux on the bus (log ramp
  10²→10⁵ pfu — storm dropouts included, because the data includes
  them). (4) LIVE SHUE READOUT — updateMagnetopause now also fires
  from the bus's measured L1 wind (no longer waits for the forecast
  provider), and a nose chip states `⌓ Shue r₀ · Pdyn · Bz` from the
  same shueStandoffRe oracle the surface is built from. Plus
  DIAGONALIZED DETERMINISM in the provider: eventSeed(id) = FNV-1a
  over the event identity ⊕ base — every catalogued CME gets its OWN
  bit-reproducible ensemble on every load and replay (node-pinned in
  the forecast gate). Probes: __swStage.{moon, belts, shue, sun.live}.
- **S6 — MY SKY DOME. ✅ SHIPPED 2026-07-23** (the sky-dome follow-up
  the S5c walls were "the input" for). The staging now renders the sky
  story FROM UNDERNEATH at the pin, and it is the Stage's only
  scale-HONEST staging: real 100–300 km curtains are tall in ANGLE, so
  no height exaggeration is needed from below. Pure oracles in
  stage/model.js — `bearingGamma` + `apparentAltitudeRad` (exact
  spherical-Earth altitude: why mid-latitudes only ever see storm
  aurora low on the poleward horizon), `skyCurtainRibbon` (the oval's
  median boundary in az/alt from the SAME ovalLatAtLon oracle; node
  pins: quiet oval overhead at Fairbanks, G3 displacement to
  Fairbanks's SOUTHERN sky, Kp 9 Miami = low northern glow, quiet
  Miami = honestly empty), `enuBasis` (numerical from earthLocal —
  the dome can't disagree with the geography) + `skyDir`. Renderer:
  background dome at the pin (twilight gradient + hash stars, darkness
  from the ONE verdict-engine sunAltitudeDeg — scrubbing τ into
  daylight honestly washes the sky out), curtain ribbon sharing the
  walls' uInt but with a quiet-arc base floor (from directly beneath
  even the quiet oval is plainly visible), N/E/S/W horizon marks,
  camera-up = local vertical (world-z twisted the horizon at high
  latitudes), mySkyPose now looks POLEWARD in both hemispheres
  (southern observers face the aurora australis). In My Sky the
  ×10.6-exaggerated walls AND the flat band annulus yield to the dome
  (map chrome reads as glitch sheets from the ground; staging change
  busts the ovalKey cache). No pin → no observer → no sky, honestly.
  Probes: __swStage.mySky.{dome, ribbonPts, ribbonVisible, sunAltDeg,
  dark}. House lesson (2026-07-23): headless-CI screenshots of the
  canvas go stale — capture via canvas.toDataURL inside a rAF
  callback, not page.screenshot.
- **S5d — MEASUREMENT: the virtual probe. ✅ SHIPPED 2026-07-23**
  (author: "how can we show particle trajectories? I want some
  measurement ability here"). Click empty corridor → a stationary
  virtual monitor (like L1, anywhere): pure `parcelProbe` in
  stage/model.js reads the SAME windFieldAt oracle the particles
  render (regime flips exactly when a wavefront sweeps the probe),
  plus lead time to Earth at the local flow speed and the
  Parker-spiral source longitude (same Ω + 0.05 AU base as
  parkerSpiralPoints — node-pinned that the drawn connectivity curve
  passes through the probe). TWO trajectory lines, honestly labeled:
  the RADIAL dashed line is the parcel path (solar wind moves
  ~radially); the SPIRAL is magnetic connectivity, a pattern — the
  chip says `path ⟶ radial · field ⟿ src N°` so they can't be
  conflated, and appends `⇢ AR n` when the footpoint lands within 15°
  of a catalogued region. Picking: empty-click drops/moves (mix-aware
  stageRadiusInvMix inverse in scale.js, node-pinned), clicking the
  probe retrieves it, `sw-pick {type:'probe'}` dispatched, `?`-hook
  `__swStage.setProbe(rAu, lonDeg)` for tests/deep links. Probes:
  __swStage.probe. The transit-panel retire review (§12) remains OPEN.
- **SOLAR PROCESSES — ✅ SHIPPED 2026-07-23** (author: "maybe we also
  show active processes of the sun"). Two honest additions: (1) flare
  LOCALIZATION — state.flares now merges recent_flares + donki_flares
  via pure `normalizeFlares` (NOAA retired its flare JSON, so live
  flares arrive DONKI-only; the 07-23 flash feature never fired in
  production until this landed — spec-pinned on the DONKI-only path),
  and when the catalog names the source AR the marker ERUPTS
  (white-hot, swollen by the flash envelope) with the chip reading
  `FLARE @ AR n` — no region on record, no site invented; (2) CME
  LIFTOFF — pure `liftoffAt` envelope (15-min rise / 90-min decay)
  drives a directional plume at the provider event's own lon/lat while
  τ crosses its launch. Probes: sun.{flareRegion, liftoff}.

### 15.4b Refinement (author framing 2026-07-23: "animate in 4D,
depicting and predicting what could happen")

The 4th axis is τ, but the future half of τ is a BUNDLE of timelines,
not one: in S5b each particle is BOUND TO AN ENSEMBLE MEMBER and
inherits its kinematics and filter weight — heavily-weighted members
contribute dense bright streams, near-dead members faint stragglers.
The on-screen spread of the cloud then IS the forecast distribution:
scrub forward and the futures diverge; scrub to now and they converge
on what the L1 data allows (the hourglass). No separate "uncertainty
layer" — the uncertainty is the cloud. Honesty note: the ensemble
covers the CME corridor only; quiet-time ambient particles represent
MEASUREMENT (nowcast persistence), not prediction, and the disclosure
must never imply otherwise.

### 15.5 Open author decisions (none block S5a)

1. Time-lapse default ×3600 (recommended) vs slower.
2. True-scale toggle zeroing the time-lapse (recommended yes — one
   button = full honesty).
3. SEP streak gate at S1 (recommended — rare enough to stay special)
   vs S2.

---

*Updated 2026-07-22 (later the same day): phase D1+G shipped — see §12.
Earlier: sign-in gate committed; personas locked (Aurora
Chaser + Satellite Operator); the Stage (§5) added as the presentation
centerpiece — supersedes the earlier grid-only framing. Companions:
FLUX_ROPE_SIMULATOR_PLAN.md, DESIGN_TOKENS.md, js/layout-lab.js header,
js/preview-mode.js header.*
