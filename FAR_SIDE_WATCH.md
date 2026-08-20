# Far-Side Watch — architecture & runbook

> The nowcast→forecast jump. The Parkers Physics CME forecast warns *hours*
> ahead; Far-Side Watch extends the horizon to *days-to-weeks* by detecting
> active regions on the **far side** of the Sun and forecasting their east-limb
> emergence. The product is not the map — it's the **measured warning
> horizon** (detection rate, lead time, false-alarm rate). That triplet is the
> SBIR pitch and the operator demo.
>
> Write the brand out. Bare "Parker" means Eugene Parker everywhere else in
> this repo (Parker spiral, Parker 1958), which is the wrong association on a
> solar-physics page.

## Where it lives

| Layer | File(s) |
|-------|---------|
| Reusable physics + data package | `js/farside/` (importable barrel: `js/farside/index.js`) |
| Page controller | `js/farside-watch.js` |
| Page | `far-side-watch.html` (Space Weather dropdown, `id: far-side-watch`) |
| Edge proxy + read API | `api/solar/farside.js` |
| Ingestion cron (Phase 1) | `api/cron/farside-ingest.js` |
| Shared upstream resolver | `api/_lib/farside-sources.js` |
| FITS reader | `api/_lib/fits.js` |
| DB migration | `supabase-farside-maps-migration.sql` |
| Site feed registration | `js/config.js` → `FARSIDE` block |
| Nav entry | `js/nav.js` → Space Weather dropdown |
| Cron schedule | `vercel.json` → `/api/cron/farside-ingest` (`30 1,13 * * *`) |

The `js/farside/` package is **DOM-free and feed-loop-free** by design, so the
Sun (`sun.html`) and Space-Weather (`space-weather.html`) engines can import the
same detection/tracking/ETA helpers and renderers later without copy-paste.

## The package (`js/farside/`)

- **`farside-clock.js`** — the simulation clock (`simBounds`, `advanceEpoch`,
  `epochToFraction`, `emergenceMarkers`). Pure, no ambient time. The scrub
  window is [−7 d, +one full synodic rotation]; the forward half is exactly
  `SYNODIC_PERIOD_DAYS` **on purpose**, because `emergenceETA` returns a
  forward distance mod 360 — so every region on the watch list is guaranteed
  to have its emergence tick somewhere on the bar.
- **`carrington.js`** — Carrington-frame geometry. `carringtonL0(date)` (Meeus
  ch. 29, ~0.1°), `emergenceETA(lonFeat, L0)`, `limbLongitudes(L0)`,
  `SYNODIC_DEG_PER_DAY = 13.199`. Pure, dependency-free.
- **`farside-config.js`** — sources, grid (1°×1°), detection thresholds, alert
  window, and the **validation cases** (AR13664 Gannon; late-May 2026).
- **`farside-feed.js`** — Phase 0/1 ingestion. Prefers a numeric grid from the
  proxy (`format=json`); falls back to a **labelled synthetic** field so the
  pipeline is demoable today. Planted regions are pinned in Carrington longitude
  (real regions don't move in the co-rotating frame), so emergence ETAs shrink
  honestly as time advances.
- **`farside-detect.js`** — Phase 2 classical baseline: threshold + connected
  components (longitude-wrapping). Stable `detectSignatures(map)` contract so the
  ML scorer (Felipe & Asensio Ramos style) drops in behind it later.
- **`farside-track.js`** — Phase 3: nearest-neighbour linking in Carrington
  (lon, lat), strength trend, transient rejection (≥2 frames), and the emergence
  forecast with a confidence band. `farSideWatchList(series)` is the product output.
- **`farside-alerts.js`** — Phase 4 "region rotating into view" trigger. Emits
  the shared `user-alert` window CustomEvent (no edit to `js/alert-engine.js`).
- **`farside-render.js`** — Canvas2D `renderFlatMap()` (Carrington image + limb
  markers + tracks) and `renderTopDown()` (rotation schematic, east-limb horizon).

## The rotation simulation (page + clock)

Far-Side Watch is a forecast **about rotation**, so the page lets you drive it:
play/pause, a scrubber over the whole window, speed presets, `Now`, space and
←/→ keys. Everything — the flat map's limb markers, the 3D globe's
orientation, every lead time in the watch list — re-derives from one
`setEpoch(ms)` in `js/farside-watch.js`.

**The clock moves the observer, not the data.** The phase-shift field is an
OBSERVATION and is held fixed while L0 sweeps past it at the synodic rate.
That is the product, not a simplification of it: a far-side forecast is
exactly "given where this region is now, rotation puts it on the east limb in
N days". Synthesizing an evolving future field would draw regions growing and
decaying on evidence nobody has.

Three things are load-bearing:

1. **Two instants, never one.** `farside-feed.js` takes both an `anchorMs`
   (the session's reference now, which pins planted regions in Carrington
   longitude) and a `whenMs` (the observed instant, which sets L0 and the
   noise seed). Re-deriving the anchor from `whenMs` drags the regions along
   with the observer: CMD never changes, ETAs never count down, nothing ever
   crosses the limb — and the page still renders perfectly. `tests/farside-sim.mjs`
   pins it, including a deliberate proof that the wrong anchoring *does* move
   things, so the guard is not a tautology.
2. **The globe's rotation IS the forecast.** `FarSideGlobe.setEpoch()` sets
   orientation from `carringtonL0(ms)`. It used to free-run at an
   "illustrative" 3.2°/s unrelated to the L0 its markers were placed from, so
   within a second a marker labelled "~10.1 d" was nowhere near where a
   10.1-day lead puts it. Do not reintroduce a spin term — animate the clock.
3. **Never simulate an alert.** `dispatchEmergenceAlerts` and the CSV export
   read the **anchor** projection. An alert is a claim about now; firing one
   because someone dragged the clock into next week would be a fabricated
   warning.

Cost model (why it scrubs at 60 fps): detect + link runs ONCE per observation;
per frame only `projectTracks()` over a handful of tracks, three limb lines,
and one group rotation. `farside-track.js` splits a track's time-invariant
half (position, strength, frames) from its viewing-time half (CMD, lead time,
emergence date) — `projectTrack()` is the single implementation of the latter,
so the watch list, the scrubber ticks and the globe cannot quote three
slightly different answers.

**Accuracy of the projection.** `emergenceETA` advances at the constant
`SYNODIC_DEG_PER_DAY`, while `carringtonL0` is the true Meeus ephemeris whose
rate breathes with Earth's orbital eccentricity. The residual is bounded and
measured in `tests/farside-clock.mjs`: **≤ 1.02° ≈ 1.9 h** at worst over two
years of anchors and the full circle of longitudes — comfortably inside the
±0.5 d floor the watch list already quotes as its band.

## Fixed: the 0°/360° seam bug (2026-08)

`detectSignatures()` flood-filled with longitude wrapping but computed the
blob centroid as an **arithmetic mean of column indices**. A region straddling
the seam has columns near 355 *and* near 5, whose linear mean is ~180° — the
opposite side of the Sun. Nothing crashed and the map looked fine; the
region's east-limb emergence forecast was simply up to **half a rotation
(~13.6 d) wrong**, silently, for any region near Carrington longitude 0.

Centroid and bbox are circular now (`atan2` over strength-weighted unit
vectors). `tests/farside-detect.mjs` pins it, including a rotational-
equivariance sweep: shift the whole field by k degrees and every detected
longitude must shift by exactly k — no longitude is special. The synthetic
demo field deliberately plants a region within a few degrees of Carrington 0
so the realistic path exercises it too.

## Downstream: the 3D corridor on cme-forecast.html

`js/corridor/*` reuses this package to put the tracked source regions on a Sun
in the CME forecast's 3D Sun→Earth corridor, alongside the compounding rope
train and the issue-locked arrival window — the "globe overlay on another
engine" this package was kept DOM-free for. It consumes `projectTracks` and
`farside-clock` directly, so the two pages cannot disagree about where a
region is or what time it is. Details in `CME_CORRIDOR_3D.md`.

Two things there depend on this package's contracts: `summarizeTrack` now
carries `areaDeg2` (the flare climatology ranks regions by size and must not
pick its own frame out of `points`), and `farside-render.fieldCanvas` is
exported so the flat map, the far-side globe and the corridor share ONE
field→bitmap implementation.

## Data sources (honest priority order)

1. **GONG far-side** seismic holography — always available, 12-hourly, free,
   already fed to NOAA SWPC. The backbone.
2. **Solar Orbiter EUV** (ESA archive) — direct imaging, *geometry-gated*.
3. **STEREO-A SECCHI/EUVI** — direct imaging, *geometry-gated*.
4. **HMI/JSOC** seismic — alternate pipeline, cross-check GONG.

### Edge proxy + env overrides

`api/solar/farside.js` streams the upstream image (keeps rate limits + CORS off
the browser, exactly like `api/solar/aia.js`). Real archive URLs shift and may
need **network-policy allow-listing** before they resolve — each is overridable
without a code change:

```
FARSIDE_GONG_URL, FARSIDE_SOLO_URL, FARSIDE_STEREO_URL, FARSIDE_HMI_URL
```

## Phase 1 ingestion (cron → Supabase)

`api/cron/farside-ingest.js` runs every 12 h (`30 1,13 * * *`). Per source it:
fetches the upstream → if FITS, `readFITS` → `resample` to 360×180 → `zNormalize`
→ `detectSignatures` (the **same** DOM-free module the browser runs) → archives
the original bytes to R2 for provenance → upserts one `farside_maps` row
(numeric grid inline as base64 Float32 + detections jsonb). GONG is required and
gates the `farside_ingest` heartbeat; SolO/STEREO/HMI are best-effort.

Reads flow back through the proxy: `format=json` returns the latest stored grid
(base64 Float32 → the browser decodes and renders the real field); `format=series`
returns recent maps' detections so the tracker builds the watch-list from real
history. Both return **501** until the cron has populated rows, so the browser
cleanly falls back to its labelled synthetic field — `format=json` is no longer a
permanent 501.

**Heartbeat + watchdog:** the cron calls `record_pipeline_success/failure` with
`pipeline_name = 'farside_ingest'`. `pipeline-watchdog` is dynamic (alerts on any
heartbeat row with `consecutive_fail ≥ 3`), so this is covered with no extra wiring.

**Apply the migration:** run `supabase-farside-maps-migration.sql` in the Supabase
SQL Editor (repo convention — these `.sql` files are applied manually). Creates
`farside_maps` (service-role-only) + `trim_farside_maps()` retention (keep 180
rows/source ≈ 90 days). Then set the upstream env vars (and allow-list the hosts
in the network policy) for live data:
`FARSIDE_GONG_URL`, `FARSIDE_SOLO_URL`, `FARSIDE_STEREO_URL`, `FARSIDE_HMI_URL`.

## Phase status

- **Phase 0 (spike)** ✅ — flat Carrington render + edge proxy.
- **Phase 1 (ingestion)** ✅ — 12 h cron → `farside_maps`; FITS reader; grid +
  detections served back through the proxy; R2 provenance; heartbeat/watchdog.
- **Phase 2 (detection)** ✅ — classical baseline; ML is a drop-in follow-up.
- **Phase 3 (tracking + ETA)** ✅ — synodic projection, confidence band; runs on
  both fresh maps and the cron's stored detection history.
- **Phase 4 (product surface)** ✅ — page panel, rotation view, emergence alert,
  CSV export, and the **driveable rotation simulation** (see above). Globe overlay on the Solar Physics Engine: import from
  `js/farside/index.js` (deferred).
- **Phase 5 (validation = the moat)** ✅ — `js/farside/farside-validate.js`.
  `runBacktest(frames, truth)` is a pure evaluator over detection frames (the
  cron's stored shape), reporting detection rate, median lead time, false-alarm
  rate, and ETA accuracy. `runSyntheticBacktest()` drives the demo over the
  canonical cases (AR13664 Gannon + late-May 2026) via per-case windows; surfaced
  on the page as the "Validation backtest" panel. Swaps to the real `farside_maps`
  archive (one window per known emergence) once it has a few rotations of history.

## Validation methodology (Phase 5)

Each ground-truth region is pinned at the Carrington longitude that makes it
cross the east limb on its real date (CMD = -90 at the crossing instant), then
the synthetic detector observes it across a per-case far-side window (≤ the
~13.6-day far-side dwell — NOT one continuous span, which would recur every
rotation). Metrics:

- **detection rate** — regions flagged on the far side before crossing / total.
- **median lead time** — days of warning bought (capped by the far-side dwell).
- **false-alarm rate** — alert-worthy tracks that matched no truth region. A
  persistent far-side decoy is planted so this is non-trivially measurable.
- **ETA accuracy** — predicted vs. actual crossing date from the first-detection
  frame (validates the synodic projection; ~0.02 d on synthetic ground truth).

The numbers are labelled SYNTHETIC until the archive supplies real history. The
harness — not the synthetic figures — is the SBIR deliverable.

## Gating

"Gated for sign-ups": the page is a public **PRO PREVIEW**. The map + the single
soonest emergence are visible to everyone; the full watch list, the emergence
alert, and CSV/REST export unlock on **sign-up** (`/signup.html?from=far-side-watch`).
Full historical/operator export is the **Advanced** tier (`planToTier → PRO`).

## Tests

Run after ANY edit to `js/farside/*` or `js/farside-watch.js`:

```
node tests/farside-clock.mjs      # scrub window, playback, emergence ticks,
                                  #   and the constant-rate error bound
node tests/farside-detect.mjs     # seam safety + rotational equivariance
node tests/farside-sim.mjs        # regions pinned / observer moves; crossing
                                  #   instant invariant under re-projection
npx playwright test tests/far-side-watch.spec.js
```

All three node gates are pure — no DOM, no network, no ambient time. The
browser gate needs no stubbing: with `farside_maps` unpopulated the page runs
on the labelled synthetic field, and the spec asserts the simulation contract
(clock does not free-run, a tick runs its region out to CMD = −90, playback
starts and stops, the 3D view owns its canvas).

Render functions need a browser (Canvas2D / WebGL); `farside-globe.js` stays
out of the `js/farside/index.js` barrel so the node gates can import the barrel
without a `three` resolver.
