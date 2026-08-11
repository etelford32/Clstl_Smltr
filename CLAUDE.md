# CLAUDE.md — agent orientation for parkersphysics.com

> **Read this file in full before making any edits.** It exists to prevent the reversion pattern this repo has accumulated. If you skim, you will rediscover bugs that have already been fixed.

---

## 1. What this repo is (and isn't)

This is **parkersphysics.com** — a physics-first space weather forecasting platform serving satellite operators, government, and research. It is a **~110k-line production web application**, not the celestial simulator the repo name and historical README suggested.

- **NOT** a pygame demo. Files like `star_simulation.py`, `celestial_studio.py`, `main.py`, `simple_star_test.py`, `test_display.py`, and the toy `rust/` crate are origin artifacts — kept for archaeological reasons, not deployed. Do not modify them in the course of unrelated work. Do not delete them either; doing so has surprised the author.
- **NOT** a Next.js / React / Vue / Svelte / SvelteKit / Astro app. There is no bundler. Pages are individual `*.html` files at the repo root that load ES modules from `js/` directly. **Do not introduce a framework or bundler under any circumstances.** Past sessions have tried; it is always wrong.
- **IS** a Vercel-deployed app with ~55 HTML pages, ~75 serverless functions in `api/`, ~100 ES modules in `js/`, multiple Rust crates compiled to WASM, and Python pipelines for SWMF / DSMC.

---

## 2. Mental model of the stack

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (vanilla HTML + ES modules from js/)                    │
│    auth.js  ─────────┐                                            │
│    telemetry.js ─┐   │                                            │
│    config.js     │   │                                            │
│    nav.js        │   │ (singleton, isConfigured() / getSupabase)  │
│    ...           │   │                                            │
└──────────────────┼───┼────────────────────────────────────────────┘
                   │   │
                   │   └── Supabase JS (self-hosted) ───┐
                   │                                     │
                   ▼                                     ▼
┌──────────────────────────────┐    ┌────────────────────────────────┐
│  Vercel serverless (api/*)   │    │  Supabase (aijsboodkivnhzfstvdq)│
│  - Node 22, ESM              │    │  - Postgres 17, us-east-1       │
│  - One file per route        │    │  - Auth: email+password +Google │
│  - 5 cron schedules          │    │  - Storage: localStorage JWT    │
│  - _lib/ helpers             │    │  - RLS on every public table    │
└──────────────────────────────┘    │  - 50+ SECURITY DEFINER funcs   │
                   │                 └────────────────────────────────┘
                   ▼
   External: NOAA SWPC, NASA DONKI/HEK, CelesTrak, NWS, Stripe, Resend
```

**Build:** `build-wasm.sh` compiles the Rust crates to WASM. Vercel runs it on deploy. There is no JS bundle step — the browser loads ES modules directly.

**Dev:** `node dev-server.mjs` (or `npm run dev`) on port 3000. It serves static files AND runs the edge functions locally by dynamically importing them. **Not** `vercel dev` — that was used historically but the homegrown server is current.

---

## 3. Files an agent should read before specific work

| If you're touching… | Read first |
|---------------------|-----------|
| Auth (signin/signup/callback/admin gate) | `AUTH_FLOW_REVIEW.md`, then `js/auth.js` end-to-end, then `OAUTH_SETUP.md` |
| Tier gates / plan logic | `js/config.js` (TIER constants), `js/tier-config.js`, `TIER_EXPANSION_SPRINT.md` |
| Telemetry / analytics RPCs | `ANALYTICS.md`, `js/telemetry.js`, `js/auth-funnel.js` |
| Vercel cron / pipeline ops | `OPERATIONS_STATUS.md`, `vercel.json`, `api/cron/*` |
| Operations console decay math (operations.html Decay Watch / orbit inspector) | `OPERATIONS_STATUS.md` (roadmap + known limits), then `js/operations/msis-drag.js` header — NRLMSISE-00 orbit-averaged decay integration with the King-Hele surrogate as the deliberate no-WASM fallback (results carry `model: 'msis'\|'surrogate'`; keep BOTH paths). Run `node tests/operations-msis-drag.mjs` after ANY decay-math edit. The drag shell / prop budget (`sw-model.js` `drag.rho450` ÷ `RHO_REF_450`) stay on the Bates surrogate ON PURPOSE — numerator and reference must move to MSIS together or the ×N-vs-quiet overhead silently skews |
| SWMF Docker container | `swmf/Dockerfile` header comments, `MHD_DENSITY_PHASE0_RUNBOOK.md` |
| Gannon hindcast | `GANNON_SIMULATION_DESIGN.md`, `MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md` |
| Hindcast database (new events, scorecards) | `HINDCAST_BACKLOG.md`, `HINDCAST_DATABASE_STANDARD.md`, then the per-event runbook |
| Hindcast Lab pages (st-patrick-storm.html + future event pages) | `js/hindcast-replay-engine.js` + `js/hindcast-charts.js` headers (generic, event-agnostic — new events get a bundle via a `scripts/build-*-replay.mjs` baker, NOT a fork of the Gannon modules) |
| Shielding Lab (shielding-lab.html / rust-shielding) | `SHIELDING_LAB_PLAN.md` (status + guardrails), then `rust-shielding/src/lib.rs` header; run `cargo test` in `rust-shielding/` after ANY kernel edit and refresh the committed WASM (`node tests/shielding-kernel-smoke.mjs` catches drift) |
| Flux Rope Simulator (flux-rope.html / flux-rope-live.html / rust-flux-rope) | `FLUX_ROPE_SIMULATOR_PLAN.md` (status + decisions), then `FLUX_ROPE_PHYSICS_SPEC.md` — the NORMATIVE physics; the Rust is a transcription of it, fix both together. After ANY kernel edit: `cargo test` in `rust-flux-rope/`, rebuild + commit `js/flux-rope-wasm/flux_rope_core.wasm`, `node tests/flux-rope-kernel-smoke.mjs` (pins the St. Patrick's 2015 hindcast validation; the reference fit lives ONLY in `js/flux-rope-presets.js`). The GLSL heliosphere view (`js/flux-rope/view.js`) MIRRORS the kernel field math — kernel is the oracle, change Rust first (`MAX_VIEW_ROPES` moves in lockstep with the kernel `MAX_ROPES`). The universal `SolarWindDriver` contract is `js/solar-wind-driver.js` (+ `tests/solar-wind-driver.mjs`) — every sim that adopts it gets forecast/hindcast/what-if modes for free; do not fork per-page driver schemas. Phase 4 consumers go through the ONE shared provider `js/flux-rope-forecast.js` (`tests/flux-rope-forecast.mjs`) — dashboard panel, `js/ring-current-outlook.js`, the verdict-card `stormOutlook` row, the server-side tiered aurora sender `api/cron/aurora-alerts.js` (+ `api/_lib/aurora-tiers.js`, `tests/aurora-tiers.mjs`), and the real-time compounding page all consume it; do NOT re-implement the DONKI→ensemble→assimilation pipeline per consumer. The provider models the COMPOUNDING TRAIN (spec §12.1: last-24 h ∪ in-transit Earth-relevant CMEs, §16 interaction ON, epoch = earliest = rope 0 — the Stage probes rope 0) and honestly idles with `cme-train-passed` on stale storms — replays pass `relevanceFilter: false`, never re-widen the filter. Background Bz noise is MEASURED (`js/flux-rope-noise.js` + `tests/flux-rope-noise.mjs`) and feeds the §14 sheath δ + §11 filter σ, disclosed — don't re-fix them as constants. `flux-rope-live.html` (nav "Compounding Watch") is the operational, data-driven view — no parameter sliders by design; flux-rope.html stays the sandbox. Deep review + findings ledger: `FLUX_ROPE_SIMULATOR_REVIEW.md`. v1.6 (spec §19–§21: segmented kinematics, momentum exchange, evolving wake, deflection) ships DEFAULT-OFF — the fitted presets keep every knob off ON PURPOSE (the Gannon momentum overshoot is a pinned tripwire, spec §19 measured value); the DAILY per-flare validation loop (`js/flux-rope-validation.js` + `js/forecast-verification.js` + `js/flux-rope-inversion.js`, model_id flux-rope-v1 in validation-rerun → `/api/cme/skill` → the page ledger) is where those knobs get fitted — run `node tests/flux-rope-{validation,inversion}.mjs tests/forecast-verification.mjs` after touching any of it. Browser gates: `tests/flux-rope-smoke.spec.js` + `tests/flux-rope-live-page.spec.js` (offline → Gannon DEMO badge is deliberate — feeds down must look down, never quiet). |
| TIGA / geomagnetic estimator (tiga.html, js/geomag/*) | `TIGA_PLAN.md` (status + the licensing decision + open problems), then the `js/geomag/igrf.js` + `tiga.js` headers. **`igrf.js` is the SINGLE SOURCE OF TRUTH for field evaluation** — every other geomag module imports it; three bugs in the research programme came from re-deriving it. TIGA is a *sequential Bayesian estimator*, NOT a simulation and NOT a forecast — and neither is Dst, which is its one-parameter, equal-weight, no-memory degenerate case (T3 identity, exact to 1e-14). THE TRAP: TIGA estimates q₁⁰ but is scored against SYM-H, which differs by ~11 nT of the index's OWN definition error — always report both RMSEs, and judge CALIBRATION against q₁⁰ only. The posterior is knowingly miscalibrated (68% nominal covers ~42%) and `tests/geomag-osse.mjs` GATES that shortfall on purpose, so "improving" it by widening the bars fails. The live baseline is a trailing median, a PROVISIONAL placeholder for a causal S_q baseline — the page says so. Live data is USGS-only for LICENSING reasons (INTERMAGNET is CC BY-NC), which is a decision, not a stopgap. Never call any layer a geodynamo simulation. Run `node tests/geomag-{igrf,tiga,core-model,dynamo,osse}.mjs` + `npx playwright test tests/tiga-smoke.spec.js` after ANY edit |
| Ring current sim (ring-current.html: twin + pressure/ENA layers) | `js/ring-current-model.js` (empirical Dst) + `js/ring-current-transport.js` (bounce-averaged transport core; run `node tests/ring-current-transport.mjs`) + `js/ring-current-globe.js` header. The transport core is ALSO a Rust/WASM kernel (`rust-ring-current/`, opt-in `?rcwasm=1`): **the JS module is the reference oracle** — after editing EITHER, mirror the change in the other, run `cargo test` in `rust-ring-current/`, and `node tests/ring-current-kernel-smoke.mjs` (pins WASM ↔ JS equal) + refresh the committed `js/ring-current-wasm/*.wasm`. |
| Ionosphere / M-I coupling layer (ring-current.html: efield bars, teardrop plasmapause, airglow + bubbles, WFC map, descent camera) | `IONOSPHERE_EXPLORATION_PLAN.md` (tracks + status + the four 2026-07-20 decisions), then `js/ring-current-efield.js` + `js/ionosphere-fountain.js` + `js/ionosphere-cells.js` + `js/ionosphere-descent.js` headers (pure kernels — run the matching `node tests/<name>.mjs` after edits; the Maynard–Chen A(Kp) in efield MIRRORS `ring-current-transport.js` `convectionAmplitude` — change together; efield τ_sh mirrors the Shielding Lab's τ_s default — the SAPS bridge; SCALE.ATMOSPHERE_VERTICAL in sim-clock mirrors descent EXAG_MAX, pinned by the descent test; the cage shader's tanh-via-exp keeps its argument CLAMP — unclamped it overflows at cage radii and Inf vertices stall software GL by seconds per frame). Rendering in `js/ring-current-ionosphere.js`; browser smoke `tests/ring-current-iono-smoke.spec.js`. |
| Moon page (moon.html: radiation lab, interior cutaway, exosphere, landmarks) | `js/moon-interior-model.js` + `js/moon-exosphere-model.js` headers — PURE kernels (structure/tides/paleo-dynamo; species table/Jeans escape/live sodium weather); the renderers draw ONLY kernel numbers. The Moon has NO collisional atmosphere and NO living dynamo — the page says so on purpose: the "atmosphere" layer is a collisionless exosphere and the dynamo scrubber is a memorial with per-epoch mechanisms. Landmark data `js/moon-landmarks-data.js` pins IAU coords + the Reiner Gamma cross-link to `CRUSTAL_ANOMALIES` (one place, two views). Run `node tests/moon-interior-model.mjs tests/moon-exosphere-model.mjs tests/moon-landmarks.mjs` after kernel/data edits; browser gates `tests/moon-interior-smoke.spec.js` + `tests/moon-surface-smoke.spec.js` (the latter hovers a marker via the `window.__moonLab` hook) |
| Real-Time Mars (mars.html: globe, surface explorer, mission panels) | `data/mars/SOURCES.md` (the four feeds, their degradation ladders, and the monitoring table — the three `/api/mars/*` routes NEVER 5xx and signal degradation with `freshness: 'stale'`; remove that and a dead NASA feed renders green on status.html), then the `js/mars-view.js` constants block. FOUR things are load-bearing and were each a bug: (1) `reliefRadiusAtLatLon` is a HOT PATH — 66k calls per terrain rebuild — so the relief flag is cached in `reliefEnabled`, never re-read from the DOM; (2) everything on the ground goes through `anchorRadiusAtLatLon`, and anything that changes the surface radius MUST call `refreshSurfaceAnchors()` or markers detach and float ~150 km up again; (3) near/far are per-mode constants and the star field is camera-locked and rescaled by `applyCameraRange` — the two are coupled, and the old 5,000,000:1 depth ratio is what made coincident surface layers flicker; (4) the regional patch carries its OWN exaggeration (`REGIONAL_RELIEF_EXAGGERATION`, 18×) while the MOLA readout stays TRUE — never scale the readout to match the geometry. The quality ladder trades fidelity, never instruments. **`controls` is a `let` and gets REBUILT** — OrbitControls caches its orbit axis from `camera.up` at construction (vendored r160, `OrbitControls.js:176`), so surface mode's local-horizon frame only reaches it via `refreshControlFrame()`; without that every polar limit lands on Mars' spin axis instead (72° off at Jezero) and the camera swings underground. Anything that changes `camera.up` must call it, and `__marsLab` exposes `controls` through a getter so the rebuild cannot strand a reference. Camera-mode changes and auto-rotate stops belong to `beginManualCamera()`, which fires on a confirmed DRAG, never on pointerdown — a bare click is a selection. Season comes from `/api/mars/ephemeris` (JPL) and `applyWeatherUi` deliberately will NOT overwrite it with the analytic Ls. Run `node tests/mars-{ephemeris,route-normalize,route,sky,landmarks,mission-state}.mjs` + `npx playwright test tests/mars-smoke.spec.js` after ANY edit |
| Earth / weather forecast | `WEATHER_FORECAST_PLAN.md`, `EARTH_LOD_NASA_PRECIP_PLAN.md` |
| EarthView verdict card (earth.html dashboard) | §4.4 below, then `js/verdict-engine.js` + `js/verdict-card.js` headers; run `node tests/verdict-engine.mjs` after engine edits |
| EarthView globe markers (location beacon, city dots) | `js/location-beacon.js` + `js/city-markers.js` headers; city data in `js/data/major-cities.js` (run `node tests/major-cities.mjs` after edits); hover/click wiring lives with the shared raycast handlers in earth.html |
| Space-weather dashboard (space-weather.html: sign-in gate, panel registry, presets, status band) | `SPACE_WEATHER_DASHBOARD_PLAN.md` (§3 gate decisions + §12 phasing), then the `js/space-weather-registry.js` + `js/space-weather-status-band.js` headers. The page is SIGN-IN GATED (authN-only; `?preview=1` and OAuth-hash payloads are deliberate exemptions — read the gate comment in the page before touching it; it FAILS OPEN by design). The registry is drift-gated against the page markup — run `node tests/space-weather-registry.mjs` + `tests/space-weather-status-band.mjs` + `tests/layout-lab.mjs` (+ `tests/threshold-profile.mjs` + `tests/dashboard-sync.mjs` for the D2 layer) after edits; browser gates `tests/space-weather-gate.spec.js` + `tests/space-weather-compose.spec.js` + `tests/space-weather-d2.spec.js`. The §8 threshold profile is ONE line: `js/threshold-profile.js` hands kp off to user_profiles.aurora_kp_threshold (the column alert-engine/account already read) — never add a second threshold store. Per-panel config lives in the panel-config store OUTSIDE the layout doc (sizes-store rationale). Cloud sync (`js/dashboard-sync.js`) is local-first and migration-guarded — `supabase-dashboards-migration.sql` was APPLIED 2026-07-22 on the author's go (the guard stays as defense for other environments). Layout schema is v2 (`{v:2, preset}`) with a PERMANENT v1 migrator — never strand saved layouts. The status band computes nothing: verdict-engine owns the tier/aurora oracles, and the band consumes the ONE flux-rope provider run the page's forecast panel publishes ('flux-rope-forecast' event) — do not add a second ensemble compute. dashboard.html stays the separate account dashboard (bridge tile, no merge). |
| The Stage (space-weather.html panel `stage`: js/stage/*) | Plan §5, then the `js/stage/{scale,model,stage}.js` headers. scale.js/model.js are PURE and node-gated (`tests/stage-scale.mjs`, `tests/stage-model.mjs` — the latter PINS the view.js mirrors against the committed WASM probes AND the oval-band inversion against verdict-engine magneticLatitude; if either oracle changes, that gate fails until re-sync). model.js builds rope geometry ONLY through the mirrors view.js already exports — do not add a third copy of the kernel math; the renderer samples vertex field color oracle-DIRECT via kernel.fieldAt on the provider's live kernel instance. The S2 stagings consume EXISTING oracles only: the oval band's Kp distribution is the page's 'earth-forecast-update' arp trajectory (never a second Kp model), the drive-ring margin comes from verdict-engine, the heat-shell ratio from upper-atmosphere-engine, asset positions from js/satellite-tracker.js propagate. Spatial dishonesty (compression, body sizes, Earth-local R_E frame — the drawn Earth IS 1 R_E in that frame) lives ONLY in scale.js, disclosed on-stage and removable via the true-scale toggle — never smuggle scale into geometry elsewhere; the geographic/TEME display frames use mean-sun time with documented tolerances — real pass timing stays with js/pass-predictor.js. The τ scrubber dispatches `sw-tau` {tauMs, regime} and picking dispatches `sw-pick` {type, norad?}; dock instruments follow both ONE-WAY (Stage→dock). The three 2D pseudo-views (helio hero, transit, globe) are NOT retired — the S3/D4 parity review (plan §12) documents the per-panel retirement gates; none are met yet. The Stage IS the `?preview=1` attract surface (`data-preview-stage` lives on the stage panel; attract mode auto-flies the stations and ends on the tagline) — signin/index/pricing embed it as lazy iframes. The render loop marches STATE every frame and pauses only GL work when hidden/offscreen — do not move the early-return above the state block (frozen-tween regression). **The stage is Z-UP and `controls` is a `let` that gets REBUILT** — OrbitControls caches its orbit axis from `camera.up` at construction (vendored r160, `OrbitControls.js:177`) and ignores every later assignment, so `camera.up.set(0,0,1)` MUST stay above `createControls()` and My Sky's local-vertical swap MUST call `refreshControlFrame()`. Built in the wrong order it orbited about world +Y in a Z-up scene: dragging tumbled the ecliptic and the gimbal poles sat IN it. Browser gates: `tests/space-weather-stage.spec.js` (incl. the orbit-axis gate — verified to fail on the old ordering) + `tests/space-weather-attract.spec.js`. |
| Navigation across pages | Run `node scripts/lint-nav.mjs`. There is a structural CI gate. |
| Icons / glyphs / the brand mark | `js/glyphs.js` header, then `icons/logo-mark.svg`. The nav's 47 icons are SVG glyphs, NOT emoji — emoji made the nav look like a different product per OS and could not take the accent colour. Every glyph is a 24×24 `currentColor` stroke drawing built from the mark's own primitives (tilted ring / axis / node); never hard-code a colour in one. `navIcon()` in `nav.js` falls back to rendering an unknown id as raw text on purpose, so `node tests/glyphs.mjs` is what stops a typo from silently printing the id into the menu. That test also gates two things that fail SILENTLY in the brand SVGs: a double hyphen inside an XML comment (makes the file unparseable → broken `<img>` on all 55 pages) and a missing `width`/`height` on the root `<svg>` (no intrinsic size → `width:auto` lays the 30px logo out as a 150px box). Both were hit while building this. |
| Design system / tokens | `DESIGN_TOKENS.md` |
| Deploy procedure | `DEPLOYMENT.md`, `VERCEL_SETUP.md`, `WEB_DEPLOYMENT.md` |

---

## 4. Load-bearing invariants — do not "clean these up"

These are things that **look** wrong to a fresh reader, **are** intentional, and have been re-broken at least once already. Every item here has scar tissue behind it.

### 4.1 In `js/auth.js`

- **`_persistToStorage()` is called BEFORE `await this.fetchProfile()`** in `_init`. Reason: a transient RLS error on `user_profiles` (network blip, brief schema drift) used to leave `pp_auth` empty, which made the dashboard's localStorage fallback fail the auth gate even though Supabase had a valid session. Order matters. Don't reorder it.
- **The `onAuthStateChange` handler MERGES the new auth payload onto the existing `_user` object — it does not replace it.** Reason: `_mapSupabaseUser` builds from `user_metadata`, which does NOT carry `role` / `plan` / seat info (those live in `user_profiles` and arrive via `fetchProfile`). Wiping `_user` on every `TOKEN_REFRESHED` event silently demoted admins. Keep the merge.
- **`SIGNED_OUT` clears `_user`; everything else merges and re-runs `fetchProfile`.** That asymmetry is the fix.
- **`fetchProfile` has a fallback `select` that omits `role`** for the case where the SQL migration hasn't been run yet. It's defensive against developers running against a stale Supabase project. Don't remove it without verifying every environment has run `supabase-admin.sql`.
- **`telemetry.recordAuthFailure('token_refresh_failed', ...)` fires on `TOKEN_REFRESHED` with a missing `access_token`.** Supabase doesn't surface a dedicated refresh-failure event, so this inference is the only signal we have. Don't delete it as "dead code."
- **`_effectiveRole()` and `_effectivePlan()` honor a `sessionStorage['pp-view-as']` override, but ONLY when `_user.role === 'superadmin'`.** This is the "view as a different tier" debugging tool. `getRealRole()` bypasses it. Keep both.
- **The `effective_plan_for` RPC call in `fetchProfile`** resolves class-seat students to their parent account's plan. Failure is non-fatal — `getPlan()` falls back to the stored value. Don't promote the failure to an error.

### 4.2 In Supabase / Postgres

These advisor warnings will fire on every `get_advisors` call. They are **intentional**:

- **~50 `SECURITY DEFINER` functions are EXECUTE-able by the `anon` role.** This is the telemetry surface — `log_auth_failure`, `log_activation_event`, `log_client_telemetry`, `session_heartbeat`, etc. are called fire-and-forget by signed-out users. Revoking EXECUTE breaks anonymous instrumentation.
- **`analytics_events`, `user_sessions`, `feedback`, `beta_invite_uses`** have permissive RLS (`WITH CHECK (true)` on INSERT). Again, anonymous instrumentation. Required.
- **`forecast_log`, `solar_wind_samples`, `weather_grid_cache`** have RLS enabled but zero policies. **This is correct** — they are service-role-only (written by cron jobs, read by RPCs). Adding a permissive policy would expose internal data. The advisor flag is a false positive in this context.
- **`cme_events`, `cme_arrival_forecasts`, `cme_l1_observations`, `cme_geomag_observations`** (migration `cme_validation_program`, 2026-07) — same zero-policy, service-role-only pattern as the row above, same intentional advisor flag. See `CME_FORECAST_VALIDATION_PLAN.md`.
- **Three different `redeem_invite` overloads exist** (`(text, text, uuid)`, `(uuid)`, `(uuid, text)`). They are not duplicates — they are progressively expanded signatures for different invite flows. Resist the urge to consolidate without reading every call site.
- **Leaked-password protection is disabled in Supabase Auth.** Decision was conscious — the bcrypt server-side hash plus rate-limited `log_auth_failure` is judged sufficient for the threat model. Flip it on only if you're confident the HaveIBeenPwned check won't degrade signup conversion.
- **The `http` extension is in the `public` schema.** Should be moved, but doing so breaks `record_solar_wind_sample` and other functions that call it unqualified. Coordinate the schema move with a function-update migration if you change this.

### 4.3 In the Vercel surface

- **`api/auth/log-failure.js`** HMAC-SHA-256-hashes the email with a server-side pepper before persisting. Plaintext emails never hit `auth_failures`. Don't "simplify" this away — it is the PII guarantee that lets the table exist at all.
- **`build-wasm.sh` checks BOTH `~/.cargo/bin` and `/rust/bin`** for rustc. Vercel's build image uses `/rust/bin`; local dev typically uses `~/.cargo/env`. Don't pick one and remove the other.
- **The `crons` array in `vercel.json` is the source of truth for scheduled jobs.** If you add a function to `api/cron/`, you MUST add it to `crons` or it won't run. Conversely, an entry in `crons` for a missing function will surface as a deploy warning, not a hard error — easy to overlook.

### 4.4 The EarthView verdict card (earth.html)

`earth.html` is branded **EarthView** (title / meta / HUD wordmark). Its default
dashboard is the **verdict card** — a draggable, touch-optimized answer card
mounted at `#verdict-host` (first left-panel element; z-index 70 so it sits
above loc-panel 51 / storm-watch 60 — panels stack-and-drag by design).
Two 2026-08 adjustments after the card grew tall enough to bury the storm
watch panel completely ("not showing up at all" report): (1) while
`body.ev-verdict-solo` is active the storm panel's HOME position is beside
the card, not under it — the rule lives in `js/storm-watch-panel.js`'s
injected stylesheet, which wins cascade ties against earth.html's static
CSS because it's appended at mount time (this ordering is also why the
panel's mobile-sheet rules live there); (2) the stacked left panels + the
card use `makePanelDraggable`'s `raiseOnGrab` (z band 76–89, below
tooltips at 90+) so grabbing a buried panel surfaces it. Gate:
`tests/storm-watch-visibility.spec.js`.

- **Modules:** `js/verdict-engine.js` (PURE fusion logic — no DOM, no fetch,
  no ambient time; unit-tested by `tests/verdict-engine.mjs`),
  `js/verdict-card.js` (DOM / styles / drag / telemetry, all CSS namespaced
  `.ev-verdict-*`), `js/air-quality-feed.js` (per-location Open-Meteo:
  AQI + UV + hourly/daily — intentionally per-location because the page's
  `WeatherFeed` grid is global 5° cells; it duplicates no existing fetch).
- **Flag:** default ON. Opt out with `?verdict=0` (one visit) or
  `localStorage ev_verdict='0'` (sticky). "Explore ›" collapses the card to
  a pill — it does NOT destroy it.
- **The card OWNS the location UX** (2026-07 consolidation, explicitly
  requested): it carries the location editor row (typeable + saved-place
  datalist, ↵ geocodes via the page-supplied `searchLocation` dep,
  auto-flies + zooms via `flyTo`, arrival turns `controls.autoRotate` off),
  the Fly here / Clear buttons, and the sun / ISS / clock stats. While it
  is active, `body.ev-verdict-solo` hides `#hud`, `#loc-panel`, and the
  mobile-toolbar Location button. Do NOT resurrect those alongside the
  card — one location panel is the point — and do NOT delete them either:
  they are the fallback UI for `?verdict=0` and for card-boot failure
  (the init's catch removes the class). The editor row is a STABLE element
  like the header; putting it in the re-rendered body would blow away the
  input mid-keystroke.
- **The collapsed pill is a second drag handle** (`makePanelDraggable`'s
  `handle` option) — the header is `display:none` while minimised, so
  without it the pill can't be moved. The collapsed card container is
  `pointer-events:none` (pill re-enables) so its invisible footprint
  doesn't block globe rotation.
- **Otherwise the card is additive chrome.** Do not remove the layer
  system, the research panels, the forecast-validation suite, or any other
  panel in its favor — and do not remove the card in theirs.
  `verdict-card.js`'s header documents the stable-header /
  re-rendered-body split that keeps drag wiring alive across data
  refreshes; don't "simplify" it into a full innerHTML re-render.
- **Telemetry:** `telemetry.recordFeature(feature, action, meta)` → kind
  `'feature'`, 100% sampled. The kind exists in the DB via
  `supabase-feature-telemetry-migration.sql` (applied 2026-07-13). The CHECK
  constraint and the RPC whitelist must move together — see that file.
- **The aurora GO threshold in `auroraVerdict` is margin ≤ 5°**, not the 2°
  "overhead-only" figure from the NOAA table. Deliberate — the May 2024
  Gannon storm put overhead aurora well equatorward of the table boundary,
  and the acceptance tests encode Kp 9 @ 44° mlat → GO. Don't tighten it
  back without reading the function comment.
- **Playwright smoke:** `tests/verdict-card-smoke.spec.js` (Open-Meteo
  routes are mocked; runs without live network).

### 4.5 In `js/nav.js` and friends

- There is a **CI gate** (`scripts/lint-nav.mjs`, workflow `nav-lint.yml`) that runs on every PR. It checks that every page uses the canonical navigation structure. The workflow comment explicitly states: "so parallel sessions cannot merge new nav drift." Respect the gate. If you must edit `js/nav.js` or any page's `<nav>` block, run `node scripts/lint-nav.mjs` locally before opening a PR.
- The lint-baseline is `scripts/nav-lint-baseline.json`. Adding pages to it is a deliberate choice, not a default.

---

## 5. The reversion pattern — how to not become part of it

This repo's history contains an instructive failure mode. The same PR title sometimes appears 3–5 times in a row, and in several cases (PRs #762, #763, #765, #766 all titled "3d satellite orbit") **all but the first had zero net code changes** — they were empty merges. Other series (admin analytics, swmf container review, earth scrub bar) show genuine code churn that goes back and forth.

**Before opening a PR:**

1. **Read the last 30 commits.** `git log --since="30 days ago" --oneline`. If your intended title or scope matches a recent commit, your change may already be merged.
2. **Diff your work against `origin/main` and look at it skeptically.** If `git diff origin/main` is empty, do not open the PR. If it reverts changes from the last week, stop and read those commits' messages and inline comments — they exist for a reason.
3. **Search inline comments in the file you're editing for the keywords `CRITICAL`, `WARNING`, `previously`, `silently`, `regression`, `hot path`, `load-bearing`.** If any apply to the lines you're about to change, treat that as a stop sign. Read what the previous session wrote before deciding to override it.
4. **If you genuinely need to revert a recent fix**, say so in the PR title — `revert: ...` or `Reapply: ...`. Don't title a revert with the same name as the original fix; that's how the history got muddled.

---

## 6. Database orientation (Supabase project `aijsboodkivnhzfstvdq`)

- **Postgres 17.6**, us-east-1, free tier, status `ACTIVE_HEALTHY`.
- **Auth methods:** email+password + Google OAuth. Apple staged behind `SOCIAL_PROVIDERS` flag in `js/config.js`. MFA scaffolding exists (`auth.mfa_factors`, `auth.mfa_challenges`) but is unused.
- **Sessions:** Supabase JWT in localStorage by default, sessionStorage when "remember me" is unchecked. Mirrored to `pp_auth` JSON for legacy modules.
- **Tables that matter:**
  - `auth.users` — Supabase-managed. PK joined by FK from `public.user_profiles.id`.
  - `public.user_profiles` — 45+ columns. Role, plan, location, 13 notify_* toggles, Stripe IDs, classroom seats, branding JSON. **One column = one feature flag** is the prevailing pattern; resist normalization without a migration plan.
  - `public.analytics_events` (3000+ rows), `public.user_sessions` (500+), `public.client_telemetry` (1500+) — anonymous-write surface.
  - `public.solar_wind_samples` (6700+ rows) — NOAA-SWPC samples, the primary live data feed.
  - `public.forecast_log` — empty as of last check; populated by `record_forecast_batch`.
  - `public.pipeline_heartbeat` — three rows, three cron pipelines. Watchdog cron reads this.
- **The `user_profiles.plan` enum** is: `free`, `basic`, `educator`, `advanced`, `institution`, `enterprise`. There is also a `tester` plan that some functions accept but the enum CHECK constraint does NOT include — `apply_invite_plan` writes it with a coalesce. This is a known split; do not "fix" the enum without coordinating with `js/config.js planToTier()`.

---

## 7. Strategic frame (so you know what to optimize for)

The product is pivoting from a consumer-SaaS framing (Stripe tiers, classroom seats, branding, signup flow with plan dropdown) to a B2G + satellite-operator framing (SBIR, NAICS 541715/541330/541511/541512, LEO drag forecasting wedge, `request-access.html` replacing the signup page). The database schema is still consumer-shaped. **When in doubt about whether to build for the consumer or the B2G surface, ask the user — do not assume.**

The physics differentiator is **MHD-grounded modeling** (SWMF / BATS-R-US) and physics-first ground truth, NOT ML black boxes. The February 2022 Starlink event (38 satellites lost, NRLMSIS underperformance) is the canonical proof point. The Gannon May-2024 G5 storm is the hindcast validation. **Marketing copy should reflect this; do not generate generic "AI-powered space weather" language.**

---

## 8. Heuristics for common asks

- **"Add a new alert type"** → New `notify_*` column on `user_profiles` (via migration), new check in `js/alert-engine.js`, new toggle in `account.html`, audit telemetry in `js/activation.js`.
- **"Add a new data feed"** → New file in `api/<source>/`, new `INTERVALS` bucket assignment in `js/config.js`, new module under `js/`, wire to the page that needs it. NOAA endpoints are browser-direct (CORS-enabled); NASA endpoints go through the edge to protect the API key. **Then register it in `js/pipeline-registry.js`** — that one append is what puts the endpoint on `status.html`, into the right `api/cron/prewarm-*` tier, and under `node tests/pipeline-registry.mjs`. Skipping it fails SILENTLY: the route works, and is simply never monitored or pre-warmed (`/api/mars/weather` shipped that way and sat unwatched). A new `category` must also be added to `CATEGORIES` or the status page renders no table for it. If the route degrades to a fallback instead of erroring, emit a top-level `freshness: 'stale'` — a 200 is otherwise scored as healthy no matter what it's actually serving. Add the true upstream to `api/health.js` if it isn't already there.
- **"Add a new page"** → New top-level `*.html`, copy the `<nav>` block from `dashboard.html`, copy the `<head>` from a sibling page, register in `scripts/nav-lint-baseline.json` only if you cannot make it pass `lint-nav.mjs` immediately. **Don't** create the page as a subdirectory `index.html` — Vercel-style routing in this repo is flat `*.html` only.
- **"Make this responsive / fix mobile"** → Check `DESIGN_TOKENS.md` first. Mobile breakpoint is `@media (max-width: 768px)`. Many pages have already been mobile-tuned; do not undo container queries that already work.
- **"Add a new SECURITY DEFINER function"** → Create the migration under the top-level `supabase-*-migration.sql` naming pattern. SET `search_path = public, pg_temp` explicitly to avoid the mutable-search-path advisor. Revoke EXECUTE from `anon` if it's not part of the anonymous-telemetry surface.

---

## 9. Things to ASK before doing

Always ask before:

- Removing pygame / OpenGL / `rust/` origin files (the author has emotional attachment).
- Consolidating the three `redeem_invite` overloads.
- Disabling `SECURITY DEFINER` on any function called from a signed-out page.
- Changing the `*.html`-at-root layout to a folder structure.
- Switching from CDN-loaded Supabase JS to a bundled import. *(Resolved 2026-08-01 with the author's approval: the client is now self-hosted — unmodified official UMD build in `js/vendor/supabase-js-<v>-umd.js`, jsdelivr CDN retained as fallback. See `js/vendor/README-supabase-js.md`. Still ask before changing the loading strategy again.)*
- Moving the `http` extension out of `public`.
- Deleting any file under `swmf/` or `dsmc/` — these are physics pipeline assets that took weeks to wire up.
- Adding a JS framework or bundler.
- Renaming the repo or the GitHub Pages deploy. The repo was renamed from `Clstl_Smltr` to `ParkersPhysics` in May 2026; one frozen schema identifier (`clstl_smltr.system.v1` in `sirius-planetary.html`) intentionally preserves the legacy name so saved system payloads stay valid — do not rename that string.

---

## 10. Quick session-start checklist

When you start a new Claude Code session in this repo:

1. Run `git log --since="14 days ago" --oneline` and read the last two weeks of commits.
2. Run `git status` and `git diff origin/main` — confirm a clean baseline.
3. If your task touches auth, read `AUTH_FLOW_REVIEW.md` even if you "remember" the auth setup.
4. If your task touches the database, run a `list_tables` against `aijsboodkivnhzfstvdq` — schema may have moved since the last session.
5. State to the user, in one line, what you understand the task to be and which files you expect to change. **Wait for confirmation** before making large edits.
6. After making changes, run the relevant smoke test under `tests/`. If you can't run it, say so explicitly — don't claim verification you didn't do.
7. Before opening a PR, re-read section 5 of this file.

---

*Last updated: 2026-05-23. If the repo state has drifted significantly from what this document describes, that is a signal to update this document — not to ignore it.*
