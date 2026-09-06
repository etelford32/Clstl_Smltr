# SUN_VISUALS_WORLD_CLASS_PLAN.md — the observed Sun, rendered like an engine would

> Plan to take `sun.html` from "procedural model with SDO reference images
> in a side drawer" to "the real Sun, live, wrapped on the sphere by
> default, with an engine-grade HDR render pipeline around it". Read
> CLAUDE.md §4 (load-bearing invariants) and §5 (the reversion pattern)
> before touching any of the files named here; read
> `SUN_CONVECTION_UPGRADE_PLAN.md` for the convection work this plan sits on
> top of and does NOT redo.

*Status: Phases 0–3 IMPLEMENTED (2026-09-06); Phases 4–6 planned. Decisions
in §1 are locked by the repo owner.*

### Progress log

- **2026-09-06** — plan written. Owner decisions: no game engine (§2),
  observed-by-default disk (§1).
- **2026-09-06 — Phase 0 (done, software-GL half).** `tests/sun-visual.spec.js`
  (`@gpu`, skipped unless `SUN_GPU=1`; 6 scenes × 720p/1440p; fixtures
  routed, off-origin blocked, sim clock frozen via `__sun.freeze`), the
  `snapshotPathTemplate` in `playwright.config.js` → `tests/__visual__/`,
  `window.__sun.perf` (p50/p95 over 120 frames) and `__sun.freeze`.
  **NASA egress is blocked from the build sandbox**, so the committed
  fixtures are SYNTHETIC (`tests/fixtures/sdo/synthetic_*.png`, 512², ~0.9 MB,
  rendered by `scripts/make-sdo-synthetic-fixtures.mjs` with the real
  browse-frame geometry + three planted ARs; README in the folder says so).
  `scripts/fetch-sdo-fixtures.mjs` writes the real set on a machine with
  egress and the visual spec prefers it. **The baseline PNGs are NOT yet
  captured** — that half of Phase 0 needs the owner's GPU:
  `SUN_GPU=1 npx playwright test tests/sun-visual.spec.js --update-snapshots`,
  then commit `tests/__visual__/` and add the GPU + perf numbers here.
- **2026-09-06 — Phase 1 (done).** `js/sun-observed.js` (pure half:
  Meeus B0/P ephemeris — pinned to the ±7.25° / ±26.25° extremes —,
  disk→sphere projection, disk MEASUREMENT from the decoded frame with
  per-instrument fallbacks, chip label; browser half: fetch through the
  proxy, cross-fade, keep-last-good, visibility-aware refresh),
  `tests/sun-observed.mjs` (17 checks incl. the 1.5° AR-alignment tolerance
  on the fixture ground truth), sunFS observed sample + composite (white
  light, EUV, magnetogram; far-side 15° graticule), the `#sun-provenance`
  chip (top-centre; click toggles Observed ↔ Model; `?observed=0`),
  `api/solar/aia.js` provenance headers + `meta=1` JSON, `solar-aia`
  registered in `js/pipeline-registry.js` (it had been unmonitored since
  July) + `sdo-latest` in `api/health.js`. `tests/sun-smoke.spec.js` gains
  four tests (feed-down → MODEL, observed boot, channel/cutaway/Doppler/chip
  round-trips, `?observed=0`); all 10 green on software GL. Verified by
  eye on software GL only: the planted west spot lands upper-right, the east
  spots left, north up. **Decisions and findings made while building:**
  - **Observed ⇒ real-time rotation.** The page's sim rotates ~2900× real
    time (0.014 rad per sim unit at 0.6 units/s), which would carry an
    observed frame off the near side in ~6 min. While Observed is on,
    `u_rot` = `REAL_TIME_ROT_MUL` × the rotation slider (one synodic
    rotation in 27.28 d); Model restores the slider's sim rate; the HUD
    says "real-time". The frame is also de-rotated in sunFS by exactly the
    AR-slot rotation, so image spots and shader spots stay locked whatever
    the clock does.
  - **Pre-existing discrepancy, not touched:** the AR slots (`u_arSpots`)
    rotate EASTWARD at 0.014 rad/unit while the marker `regionGroup`
    rotates WESTWARD at 0.004·2π/unit (`solarRotAngle`) — markers and
    shader sunspots have always drifted apart at sim rate. Invisible at
    real-time rate; a Phase 4 fix candidate (make both the slot math).
  - **B0 is applied, P is not.** NASA's browse frames are north-up, so only
    B0 (disk-centre latitude, up to ±7.25°) orients the projection; P is
    computed and shown in the chip tooltip as `not applied`. The default
    camera now sits on Earth's direction `(0, sin B0, cos B0)` so the
    visible limb and the observed/model terminator coincide on load.
  - **Disk radius is measured, per instrument.** HMI ≈ 0.465 and AIA ≈
    0.390 of the frame radius (plate scales differ). The Stage
    (`js/stage/stage.js:307`) uses 0.485 for both, ~25 % too large for its
    171 shell — recorded here, not fixed here (different page).
  - **Far-side graticule is 15°, not the 3° the plan first said** — 3° is
    a moiré at 128 segments. GONG far-side seeding of the far hemisphere is
    DEFERRED (the `series` format exists on `/api/solar/farside`; wiring it
    into a plage term is a small follow-up, listed in §9).
  - **HMI tint** `u_obsTint` (1.25, 1.02, 0.70) and the observed/procedural
    seam brightness were set on software GL and need the owner's eye; both
    are live on `__sun.uniforms`.
- **2026-09-06 — Phase 2 (done).** `js/sun-post.js`: ONE composer pass
  replacing both `UnrealBloomPass`es and the retired radial K-corona gather
  (`radialDiffusePass` + its 80-line shader are deleted — Phase 3's Thomson
  K-corona replaces what it approximated). Jimenez mip-chain bloom (13-tap
  downsample, Karis average on mip 0, six half-res mips at 720p, 9-tap tent
  upsample, no threshold ⇒ no rings), GPU 1×1 log-luminance reduction read
  back every 4 frames into the PURE `ExposureController`
  (`tests/sun-post.mjs`, 6 checks: geometric-mean calibration, τ 1.2 s /
  0.5 s asymmetry to 63.2 %, EV clamps, NaN-safe, recalibrate), soft
  shoulder above 1.0, dither, and lens effects (ghosts / CA / grain) behind
  `?lens=1` — OFF in Observed by default. `__sun.post.state` exposes EV,
  L̄, strength, mips. Smoke spec asserts the chain is live (6 mips, finite
  readback, lens off). The two rendering-panel bloom checkboxes still work
  (ambient = base strength, flare = boost). **Findings:**
  - **A global strength boost on an un-thresholded bloom lit the whole disk
    white on an X-flare (measured).** The flare boost is therefore applied
    to the BRIGHT PASS of the blurred image only (`max(bloom − 0.65, 0)`),
    which is what "tight, on-demand" meant in the old two-pass design.
  - **Lens ghosts must read the NORMALISED bloom** — `tBloom` is the sum of
    the whole chain (n+1 mips); an un-normalised ghost read blew the disk
    out at 7× (measured). Ghosts also threshold at 0.55 so the disk's own
    glow cannot re-light the disk.
  - **The flare kernel / ribbons / arcade / EIT wave are captured as
    `flareAdd`** (everything that section adds to `col`) and drawn ON TOP
    of the observed disk at 0.7 as an event overlay — the observed mix had
    silently erased the page's GOES-driven flare visuals on the near side.
    Observed pixels are still never recoloured; this is an additive marker.
  - **Exposure calibration is frame-count based** (20 readbacks × every 4
    frames = 80 frames ≈ 1.3 s at 60 fps); on software GL (~2 fps) it
    reaches calibration only after ~40 s, so headless screenshots show
    EV 0 — expected, not a fault.
  - **Colour pipeline is still display-referred upstream** (sunFS's own
    acesFilm; no OutputPass). The exposure multiply here is adaptation on
    tonemapped input; moving tone mapping to the end of the chain is Phase 6.
- **2026-09-06 — Phase 3 (done).** The volumetric AIA corona
  (`js/corona-volumetric.js`) is now the DEFAULT corona of every EUV channel
  view — it had been hiding behind `?corona=volumetric` while the channel
  views drew NO corona at all. It mounts lazily on the first channel view
  (`ensureVolumetricCorona()` in sun.html), renders on camera layer 1 through
  the new `js/corona-accumulate.js` pass (interleaved-gradient jitter per
  pixel advanced by the golden ratio per frame; history blended 1/(n+1)
  down to 1/33 while the camera is still; any camera motion, channel switch,
  AR update or loop rebuild resets — no reprojection needed for an additive,
  camera-locked layer), and lights its arcades from the PFSS-lite atlas
  splatted into a loop-density volume (`js/corona-loop-density.js`, PURE:
  R = closed lines → emission, G = open lines → topological coronal-hole
  suppression; `tests/corona-volumetric.mjs`, 10 checks). White light gains
  the Thomson K-corona + dust F-corona in coronaFS from the closed-form
  Baumbach–Allen LOS integrals (constants pinned by the node test and
  printed for the GLSL mirror; `u_kcorona` = 0 disables). **Findings:**
  - **`js/field-atlas.js` could never load its WASM**: `'./js/sunfield-wasm/…'`
    resolves relative to the module (already in `js/`) → `js/js/…` → every
    atlas build, including `?debug=field` / `?debug=prominence`, had been
    failing silently. Fixed (one path); the loop volume now builds in
    ~70–120 ms for ~300 lines.
  - **The tracer's AR arcades peak only 0.005–0.008 R☉ up** (measured on
    three planted ARs; the seed ring sits at 0.04–0.10 rad and the buried
    dipole keeps those lines low). A 64³ Cartesian cube (voxel 0.078 R☉)
    could not resolve them and a 12-step chord march sampled that layer
    ~once — so the volume moved to a **256×128×32 SHELL grid** (lon × lat ×
    √-stretched height; slice 1 is at 1.5 Mm) and the march is **two-scale**
    (6 coarse steps outside r = 1.30, 10 fine steps inside, 6 coarse behind
    on limb rays; front-to-back order kept). A/B against the legacy march
    via `u_marchLegacy` (kept as the perf/brightness reference): mean
    accumulated brightness 0.0169 vs 0.0204, peak 0.79 vs 0.81 — same
    energy, finer structure. At the default framing the loops are still
    ~1 px tall; they show at the limb and when zoomed. **Raising the seed
    ring / apex heights to the observed 0.05–0.15 R☉ is a Rust change**
    (cargo test + WASM rebuild per CLAUDE.md) — Phase 4 candidate, not
    done here.
  - **The smoke suite's noise filter was swallowing shader-compile
    errors**: a failed compile dumps the GLSL source, whose comments mention
    swpc/noaa/sdo, so the whole message matched the "expected feed noise"
    regex. coronaFS failed to compile for an entire run while all 10 tests
    stayed green. `isExpectedNoise` now refuses anything matching
    `Shader Error|GLSL|ERROR: 0:|program not valid` before the feed regex.
  - The magnetogram view shows no EUV corona (a magnetogram has none); the
    layer toggle now routes to whichever corona renderer the view uses.
  - Verified on software GL only (2 fps, accumulation reaches ~18 frames in
    the screenshots); the K-corona is deliberately subtle (0.048 of the limb
    brightness at 2 R☉) and needs a GPU + real frames to judge.

---

## 1. Scope & locked decisions

Two forks were decided up front, in conversation with the owner:

- **No game engine.** Unreal has no web target (HTML5 export died in
  UE 4.24; UE5 never had one); Pixel Streaming means a GPU server per
  concurrent viewer, which Vercel serverless cannot host and which turns a
  simulation into a video service. Unity/Godot web exports ship a 30–80 MB
  runtime that owns the canvas and cannot reuse the Rust PFSS tracer, the GPU
  Navier–Stokes solver, the DEM corona raymarcher, or any live feed. CLAUDE.md
  §1 forbids frameworks and bundlers for the same reason. **The stack stays
  three.js + custom GLSL/WGSL.** Every "world class" Sun in a game engine or a
  film is a custom material + volumetrics + post chain; the gap here is
  technique and pipeline, not engine. Offline UE/Blender renders are fine for
  *marketing footage* (an MP4), never for the live page.
- **Observed by default.** When `sun.html` loads, the Earth-facing disk is the
  REAL Sun — SDO/HMI continuum in white light, SDO/AIA in the EUV modes —
  fetched through the house edge proxy. The procedural photosphere becomes
  (a) the far side, (b) the fallback when the feed is down, and (c) the
  opt-in "Model" mode that the convection plan's toggles (cutaway, Doppler,
  fluid) continue to run in. The product story is *observed where observed,
  modelled where not*, and the page says which is which at all times.

### 1.1 Explicitly OUT of scope

- Re-tuning the convection drift speeds or the fluid solver parameters
  (`SUN_CONVECTION_UPGRADE_PLAN.md` — tuned once, do not revert).
- A second heavy raymarch (the convective-zone cutaway stays shading-only,
  per that plan's §8).
- Historical Helioviewer JP2 retrieval for the scrubber. `api/solar/aia.js`
  already documents it as a deferred follow-up and labels scrubbed views
  honestly (`X-AIA-Mode: live-fallback`). It stays deferred; see §9.
- Touching `js/sun-shader.js` / `js/sun-skin.js` beyond what §5 needs — those
  are shared with `heliosphere3d.js` and the space-weather globe.

---

## 2. What exists today (verified 2026-09-06)

`sun.html` (11,690 lines) renders with the vendored three.js **r160**
(`js/vendor/three-0.160.0/`, shared by ~40 pages) and an EffectComposer chain:

```
RenderPass → UnrealBloomPass (ambient, 0.18/0.28/0.85)
           → UnrealBloomPass (flare,   0.00/0.20/1.10)
           → ShaderPass radialDiffuse (K-corona limb gather; off by default)
           → ShaderPass spaceOcclusion
```
at `sun.html:2353–2550`, ACES tonemap at fixed exposure 1.05
(`sun.html:2339`), sRGB output, DPR capped at 2.

Seven structural shells (core → corona), the photosphere `sunFS` inline at
~`sun.html:2632`, the GPU Stable-Fluids solver in `js/solar-fluid.js`, the
PFSS-lite tracer in `rust-sunfield/` → `js/sunfield-wasm/`, and the DEM
raymarched corona in `js/corona-volumetric.js` (mounted lazily by
`js/corona-volumetric-mount.js`).

**The EUV "wavelength views" are synthetic.** `u_viewMode` 1–6 at
`sun.html:3422` recolours the procedural disc from structural fields (network,
plage, fluid temperature, a noise-generated "coronal hole" field) into
AIA-styled ramps. The live SDO images exist on the page only as `<img>`
thumbnails in the `#sdo-drawer` strip (`sun.html:785`) and the
`js/sdo-compare-panel.js` A/B inset. **Nothing on `sun.html` wraps the
observed disk onto the sphere.**

**Other pages already do.** `js/stage/stage.js:307–470` samples the SDO/HMI
continuum on the Earth-facing hemisphere by orthographic disk→sphere
projection, keeps procedural granulation on the far side, is fail-quiet
offline, and runs a 171 shell + a magnetogram layer off the same proxy.
`js/space-weather-globe.js:470` and `js/heliosphere3d.js:1035` do the same
with `createSolarDisk` from `js/solar-disk.js`. All three go through
`api/solar/aia.js` (edge, 12-min `s-maxage`, channels `white | mag | 94 |
131 | 171 | 193 | 211 | 304`, resolutions 512–4096, CORS headers). **That
pattern is the thing to port — not a new one.**

Far side: `api/solar/farside.js` + `api/cron/farside-ingest.js` already
proxy/ingest GONG helioseismic far-side maps (`api/_lib/farside-sources.js`).
`js/sun-rotation.js` provides `carringtonL0` and Carrington→scene longitude,
which is what orients any synoptic texture.

Testing: `tests/sun-smoke.spec.js` (6 tests: boot, 7-layer toggle, loop,
cutaway, Doppler, wavelength cycle) on **software WebGL**. There is no
screenshot baseline anywhere in `tests/`, and the convection plan's own log
says every visual phase was "verified" without a GPU. That is the first thing
to fix (§3 Phase 0).

### 2.1 What is actually holding the render back

1. **LDR-flavoured post chain.** Two `UnrealBloomPass`es over a fixed-exposure
   ACES tonemap. UnrealBloom's ring artefacts are the "circles" the owner
   complained about in June; the de-bloom rework shrank them rather than
   replacing the pass. No exposure adaptation, so disk and corona cannot both
   be right in one frame and flying into the corona changes nothing.
2. **The fluid domain is 2-D equirectangular.** Pole pinch, no granule relief,
   no limb faculae, so the limb — where real imagery is most striking — reads
   flat.
3. **Single-sample corona raymarch.** No blue-noise jitter, no temporal
   accumulation, so it is either noisy or smeared; the PFSS loops are drawn as
   separate lines rather than lighting the volume.
4. **The disk is invented** while a free, near-real-time observation of the
   same disk is already proxied and cached for three other pages.
5. **No GPU verification loop.**

---

## 3. Phases

Each phase is one PR, independently verifiable, in the order given. Phase 0
first, always. Phases 1–2 are the product decision; 3–5 are the engine-grade
polish; 6 is the architectural lever that unlocks 3-D convection.

### Phase 0 — GPU screenshot baseline (small)

**Goal:** stop judging visual work on software GL.

- `tests/sun-visual.spec.js`: Playwright, tagged `@gpu`, skipped unless
  `SUN_GPU=1`. Loads `sun.html?visual=baseline` (fixed seed, fixed time via
  `window.__sun.setClock(iso)`, feeds mocked with committed fixture images so
  the frame is deterministic), waits for `__sun.ready`, captures the canvas at
  1280×720 and 2560×1440 for: white-light, 171, 304, Model mode, cutaway,
  Doppler. Stores under `tests/__visual__/sun/`.
- Fixture images: one 1024² frame per channel, committed under
  `tests/fixtures/sdo/` (public NASA imagery; ~8 files ≈ 2 MB). The page's
  loader takes a base URL override (`__sun.aiaBase`) so the spec points it at
  the fixtures instead of `/api/solar/aia`.
- Run locally on the owner's machine (real GPU) and attach the baseline PNGs
  to the PR. CI keeps running `sun-smoke.spec.js` on software GL; the visual
  spec is opt-in. Perceptual diff threshold 0.5% via Playwright's
  `toHaveScreenshot({ maxDiffPixelRatio })`.
- Add `window.__sun.perf` (rolling frame-time p50/p95 + GPU timer query when
  `EXT_disjoint_timer_query_webgl2` exists) so every later phase reports a
  number, not "seems fine".

**Exit:** baseline PNGs committed, spec green on real hardware, and a line in
this file's progress log with the GPU + frame times it was captured on.

### Phase 1 — Observed disk by default (medium) ★ the product decision

**Goal:** on load, the near hemisphere is the live SDO Sun.

New module **`js/sun-observed.js`** (page-scoped, three-free where possible so
`tests/sun-observed.mjs` can unit-test the projection math):

- `loadChannel(channel, { res, bucket })` → `/api/solar/aia?channel=…&res=2048&b=<5-min bucket>`
  — same URL contract as `space-weather-globe.js:478`. 2048 for the
  `sun.html` hero (it fills the viewport; 1024 visibly softens at 1440p);
  drop to 1024 on `devicePixelRatio < 1.5` or when `__sun.perf` p95 > 24 ms.
- **Projection.** Orthographic disk→sphere on the Earth-facing hemisphere,
  exactly the `stage.js:307` approach, but with the three SDO header angles
  applied instead of assumed: the disk centre/radius from the FITS-style
  metadata the proxy will start forwarding (`X-SDO-CRPIX1/2`, `X-SDO-R_SUN`,
  `X-SDO-CROTA2` — see the `api/solar/aia.js` change below), the P-angle
  roll, and B0 tilt so the projected disk's heliographic equator lines up with
  the AR markers `js/sun-rotation.js` already places. `projectDiskUV(dirObj,
  { cx, cy, rSun, pAngle, b0 })` is the pure function; the smoke test asserts
  an AR at (lat, lon) from the SWPC list lands on its sunspot in the HMI
  fixture within 1.5° (the fixture is a real frame with a known AR list).
- **Limb blend.** The observed disk is authoritative for `mu > 0.08`; a
  0.08→0.0 `smoothstep` cross-fades into the procedural limb + spicule fringe
  so the terminator between observed and modelled is never a hard edge and
  the chromosphere shell still has something to sit on.
- **Far side.** Procedural granulation seeded from the GONG far-side map when
  `/api/solar/farside?source=gong` answers: the map's strong-field cells
  modulate `u_regions` for the back hemisphere (dim plage, no invented
  sunspots — a helioseismic map has no continuum detail and the page must not
  pretend it does). No map → plain procedural far side. Either way the far
  hemisphere carries a subtle 3° graticule so a viewer can tell at a glance
  which half is observation.
- **EUV modes become observed.** `u_viewMode` 1–5 switch the near-side texture
  to the matching AIA channel (2048, same bucket) instead of the synthetic
  recolour; the synthetic ramp stays as the far-side fill and the offline
  fallback. Magnetogram (mode 6) uses `channel=mag`. The `photDim` table in
  `js/corona-volumetric.js` keeps dimming the disk under the volumetric
  corona exactly as now; the observed 171/193/211 disk is already the "disk
  is dark, loops are bright" look those dims were emulating.
- **Refresh.** 5-min bucket re-fetch (matches the globe), cross-fade over
  ~1.5 s between frames so the 12-min AIA cadence reads as a slow live feed
  rather than a hard cut. Tab hidden → no fetch (`document.visibilityState`).
- **Failure = honesty, never a blank.** Any fetch failure keeps the last good
  frame if there is one (with the status chip going amber + its age), else
  falls back to the procedural disk with the chip reading *Model (feed
  down)*. This is the `tests/sun-smoke.spec.js` path in CI, so the procedural
  branch stays exercised every run — it is NOT dead code.
- **Status chip + provenance line** (top-left, beside the existing view
  controls): `OBSERVED · SDO/HMI 4500 Å · 2026-09-06 14:12 UTC · 7 min old`
  or `MODEL · procedural photosphere` or `OBSERVED (stale 41 min)`. Clicking
  it toggles Observed ↔ Model. Model mode is what the convection plan's
  cutaway / Doppler / fluid toggles switch into automatically (they already
  snapshot-and-restore visibility; they add "observed" to that snapshot).
- **`api/solar/aia.js`**: forward the frame's UTC timestamp and disk geometry
  as response headers (parse the NASA "latest" JPEG's sidecar when available,
  else `Date` of the upstream response + the fixed SDO crop geometry —
  `latest_*` JPEGs are pre-centred, radius 0.455 of the frame, which is the
  `diskR: 0.455` constant `heliosphere3d.js:991` already uses). Add
  `X-SDO-Observed-At`. Register `solar-aia` in `js/pipeline-registry.js`
  (category `space-weather`, cadence 720 s, prewarm `hot`, warn 30 min, crit
  90 min) — it is currently unmonitored, exactly the `/api/mars/weather`
  failure CLAUDE.md §8 warns about. Emit `freshness: 'stale'` semantics via
  the `X-AIA-Mode` header the status probe can read.
- Delete nothing: the `#sdo-drawer` strip stays (it is the multi-channel
  picker), `js/sdo-compare-panel.js` stays (it becomes the A/B against the
  wrapped disk — now genuinely useful).

**Tests:** `tests/sun-observed.mjs` (projection pure function + AR alignment
on the fixture), `tests/sun-smoke.spec.js` gains "boots in Model mode when
the AIA route 502s" and "boots Observed with fixtures, chip says OBSERVED",
and the wavelength-cycle test asserts the texture swaps per channel.
Phase 0 visual baseline re-captured.

**Exit:** default load shows the real Sun; chip is truthful in all three
states; CI green on software GL with the feed down.

### Phase 2 — HDR post chain (medium)

**Goal:** kill the bloom rings, make disk and corona coexist, give the page a
camera.

New module **`js/sun-post.js`** replacing the two `UnrealBloomPass`es:

- **Mip-chain bloom** (Jimenez 2014 "Next Generation Post Processing in Call
  of Duty" — 13-tap downsample with Karis average on the first mip, 9-tap
  tent upsample, 6 mips at 1280p). Physically it is a wide, smooth PSF, no
  threshold, no ring. Strength ≤ 0.06 as an *additive fraction* — the
  observed disk is already correctly exposed; bloom exists for the limb, the
  flares, and the corona, not to make the disk glow.
- **Exposure adaptation.** Log-luminance average of a 64² mip of the scene,
  smoothed with τ = 1.2 s (brighten) / 0.5 s (darken), key value 0.18,
  clamped to EV range [−2, +4] around the Phase 1 calibration so the disk
  never crushes to white. Flying inside 1.4 R☉ shifts the key so the corona
  comes up as the disk leaves the frame. Exposed as `__sun.camera.ev`.
- **Lens.** Tasteful and OFF by default in Observed mode, ON in the
  cinematic camera paths (Phase 5): 6-ghost lens flare from a thresholded
  copy of the bloom source, subtle chromatic aberration (≤ 1.5 px at the
  frame edge), film grain at 0.015 amplitude, blue-noise dithered before the
  8-bit output. All four are one `ShaderPass`.
- **Colour.** Keep ACES; render targets `HalfFloatType` (r160
  `EffectComposer` already defaults to it — verify with
  `composer.renderTarget1.texture.type`, do not assume). Flare flash goes
  into the HDR buffer as a real >1.0 value, so the flash shows up as bloom +
  exposure drop rather than a white-out uniform.
- Retire `radialDiffusePass` (off by default since June; the Phase 3 K-corona
  replaces what it was for). Keep `spaceOcclusion`.

**Tests:** shader-compile assertion in the smoke spec; `__sun.perf` p95 must
not regress more than 2 ms at 1280p vs the Phase 1 baseline on the same GPU;
visual baseline re-captured. `tests/sun-post.mjs` unit-tests the exposure
controller (pure: given a luminance series, the EV trajectory).

**Exit:** no visible ring at any bloom strength; a flare reads as a real HDR
event; owner sign-off on the baseline PNGs.

### Phase 3 — Corona that shows structure (medium)

**Goal:** loops and streamers you can see, not a haze.

In `js/corona-volumetric.js` (kernel is the header; the physics stays):

- **Blue-noise jitter + temporal accumulation.** Per-pixel ray-start offset
  from a 64² blue-noise tile, accumulate 8 frames with camera-motion reject
  (reprojection via previous view-projection; reset on scrub / channel /
  camera change). Effective 8× samples at 1× cost. Static-camera frames
  converge in ~130 ms.
- **Field-aligned emission.** Rasterise the PFSS lines (already in
  `Float32Array` from `rust-sunfield`) into a 128³ "loop density" 3-D
  texture (R8, ~2 MB, rebuilt on AR-list update on a worker) and add it as a
  DEM term with the AR's loop temperature. The raymarcher then lights the
  loops as volume, so 171/193/211 show bright arcades where the tracer says
  there are closed loops and dark where field is open — the coronal-hole
  subtraction becomes derived from field topology (`Topology::Open`) instead
  of a Gaussian cell.
- **K-corona** from Thomson scattering of an electron-density model
  (Baumbach-Allen `n_e(r) = 10^8 (0.036 r^-1.5 + 1.55 r^-6 + 2.99 r^-16)`
  cm⁻³, with the streamer belt modulated by the source-surface neutral line
  from the tracer) plus a smooth **F-corona** term — visible in white light
  and the cinematic mode; this is what `radialDiffusePass` was approximating.
- LASCO C2/C3 (`js/soho-feed.js`) as an optional *observed* coronagraph plane
  beyond 2.2 R☉ in white light, occulter drawn honestly. Same chip/provenance
  rules as Phase 1.

**Tests:** new `tests/corona-volumetric.mjs` (there is none today) with a
loop-density rasteriser check (a known closed loop lights the expected voxels); smoke spec asserts
the accumulation resets on channel change (no ghosting of the previous
channel); visual baseline re-captured for 171/193.

### Phase 4 — Photosphere detail behind the observation (medium)

**Goal:** the far side and the Model mode stop looking flat, and the observed
disk gains what a 2048 JPEG cannot carry.

- **Cube-sphere fluid domain.** `js/solar-fluid.js` moves from one
  equirect target to six 256² faces with edge-copy boundaries (the standard
  cube-map fluid trick). Kills the pole pinch. Same solver, same tunables,
  same drift coefficients — *only the domain changes*. Sampled via
  `textureCube`. The procedural granulation is what it drives, so this is the
  far-side / Model-mode surface.
- **Granule relief and limb faculae.** Height field from the fluid
  temperature → micro-normal → the existing 5-term limb darkening gets a
  per-pixel μ perturbation. Near the limb (`mu < 0.3`) the intergranular
  lanes brighten (faculae) — the real "hot wall" effect. In Observed mode the
  same micro-normal is applied to the observed disk as a *shading* term only
  (never geometry, never colour), scaled by the local contrast of the HMI
  frame so it adds sub-pixel detail where the image has granulation and
  nothing where it is saturated.
- **Multi-scale detail.** At `camera.distance < 2 R☉` a second tile of
  procedural granulation at 8× frequency fades in under the observed disk so
  a 4K viewport still resolves individual granules. Disclosed in the chip
  (`OBSERVED + synthesised sub-pixel detail`) — the Mars regolith rule:
  everything below the raster's sample spacing is synthesised and says so.

**Tests:** `node tests/solar-fluid.mjs` (new; asserts divergence after
projection < 1e-3 on each face and continuity across a face edge);
convection plan's drift tunables asserted unchanged; visual baseline.

### Phase 5 — Cinematography (small)

- Scripted camera paths (`js/sun-camera.js`, pure keyframe math, unit-tested
  timing): *Approach* (6 → 1.3 R☉, lens on, exposure ramps), *Limb ride*
  (grazing pass over an AR with the 304 channel), *Flare* (triggered on a
  live M/X event or on demand — pull to the source AR, HDR flash, bloom
  bloom-out, exposure recovery). Each ends with the chip visible.
- Depth of field: one bokeh pass (hexagonal, CoC from a fixed focus at the
  photosphere) only during the paths, off in the free camera.
- `?preview=1` attract mode plays *Approach* → *Limb ride* on a loop (the
  Stage's attract pattern in `js/stage/stage.js`; do not fork its
  scheduler — import and drive it).

### Phase 6 — WebGPU renderer, page-scoped (large; only after 1–5 ship)

**Goal:** compute shaders for a 3-D convective shell and GPU field-line
tracing. This is the one phase that touches the vendored three.js.

- **Second vendored three, page-scoped.** WebGPU + TSL need ≥ r165; the r160
  `OrbitControls` behaviour is load-bearing on Mars, Moon, and the Stage
  (CLAUDE.md, the `camera.up` capture). So: `js/vendor/three-0.17x/` used
  ONLY by `sun.html`'s import map; r160 stays for the other ~40 pages.
  Nothing else changes its import. There is no vendor-audit script today;
  add `scripts/lint-three-vendor.mjs` in this phase so a page importing the
  wrong copy fails CI instead of silently mixing two three.js instances.
- `renderer = navigator.gpu ? new WebGPURenderer() : new WebGLRenderer()`
  with the Phase 2 post chain written once in TSL so it compiles to both
  WGSL and GLSL. Feature-gate, never feature-require: Safari 26 / Firefox
  141+ / Chrome all ship WebGPU as of 2026, but software-GL CI does not, so
  the WebGL2 path remains the tested default in `sun-smoke.spec.js` and the
  WebGPU path is tested by the `@gpu` visual spec.
- **3-D convection.** A 96×96×24 spherical-shell Boussinesq solver in
  compute (the convection plan's Phase 2 shading becomes real depth), driving
  the cutaway and the surface simultaneously. The 2-D cube-sphere solver from
  Phase 4 stays as the WebGL fallback — two paths, both live, like
  `msis | surrogate`.
- **PFSS on the GPU.** RK4 tracing in compute from the same seeds
  `rust-sunfield` builds; the Rust tracer stays the oracle and
  `tests/sunfield-kernel-smoke.mjs` (new) pins GPU ↔ Rust equality on a
  fixed AR list. Loop-density texture (Phase 3) then rebuilds per frame,
  which is what makes a flare's arcade evolve live.

**Exit:** WebGPU path within 10% of the WebGL frame time at 1440p on the
owner's GPU, and *identical* screenshots on the Phase 0 baseline scenes
(diff < 0.5%) — a renderer change must not be a look change.

---

## 4. File map

| Phase | New | Modified |
|---|---|---|
| 0 | `tests/sun-visual.spec.js`, `tests/fixtures/sdo/*`, `scripts/make-sdo-synthetic-fixtures.mjs`, `scripts/fetch-sdo-fixtures.mjs`, `scripts/lib/sdo-synth.mjs`, `tests/__visual__/` (baselines: pending GPU) | `sun.html` (`__sun.freeze`, `__sun.perf`), `playwright.config.js` (`snapshotPathTemplate`) |
| 1 | `js/sun-observed.js`, `tests/sun-observed.mjs` | `sun.html` (photosphere uniforms + sunFS + chip UI + mode handlers), `api/solar/aia.js` (headers + `meta=1`), `js/pipeline-registry.js` (`solar-aia`), `api/health.js` (`sdo-latest`), `tests/sun-smoke.spec.js` |
| 2 | `js/sun-post.js`, `tests/sun-post.mjs` | `sun.html` (composer wiring: UnrealBloom ×2 + radialDiffuse → `SunPostPass`; Doppler save/restore; resize; animate drive; `flareAdd` overlay in sunFS), `tests/sun-smoke.spec.js` |
| 3 | `js/corona-loop-density.js`, `js/corona-accumulate.js`, `tests/corona-volumetric.mjs` | `js/corona-volumetric.js` (loop sampler, two-scale jittered march, `u_marchLegacy`), `js/corona-volumetric-mount.js` (layer 1, `setLoopDensity`, `setJitter`), `js/field-atlas.js` (WASM path fix), `sun.html` (lazy default mount, accumulation pass, loop rebuild, K/F corona in coronaFS), `tests/sun-smoke.spec.js` |
| 4 | `tests/solar-fluid.mjs` | `js/solar-fluid.js`, `sun.html` `sunFS` |
| 5 | `js/sun-camera.js`, `tests/sun-camera.mjs` | `sun.html`, `js/preview-mode.js` |
| 6 | `js/vendor/three-0.17x/`, `js/sun-render.js`, `tests/sunfield-kernel-smoke.mjs`, `scripts/lint-three-vendor.mjs` | `sun.html` import map |

Extraction rule: shader code that Phase 2/6 needs to compile for two
back-ends moves out of `sun.html` into the module that owns it *in the phase
that needs it*, never as a standalone "cleanup" PR (§5 of CLAUDE.md — a
10k-line reshuffle with no visual change is exactly the diff nobody can
review).

---

## 5. Honesty rules (apply to every phase)

These mirror the rules the Mars and Moon pages already live by
(CLAUDE.md §3, Mars tiles: "the map is ARCHIVAL, the view is LIVE").

1. **The chip is never wrong.** Observed / Model / Stale with a UTC timestamp
   and an age. If a test can make the chip say OBSERVED while the texture is
   procedural, that test fails.
2. **Observation beats model on the near side, always.** No procedural term
   may change the *colour* or *shape* of an observed pixel; shading-only
   detail (Phase 4) is disclosed.
3. **The far side never invents sunspots.** Helioseismic maps give strong-field
   regions, not continuum. Plage-like dimming only.
4. **A dead feed is visible, not quiet.** Same as `flux-rope-live.html`'s
   DEMO badge — feeds down must look down.
5. **Scale is honest.** Corona extent, R☉ units, the 2.5 R☉ volume — no
   compression is introduced; the Stage's `scale.js` stays the only place
   that does that, on its own page.
6. **Nothing is "verified" without a GPU screenshot** in the PR after Phase 0
   exists.

---

## 6. Data sources

| Product | Route | Cadence | Used by |
|---|---|---|---|
| SDO/HMI continuum (`white`), LOS magnetogram (`mag`) | `/api/solar/aia` (exists) | 12 min | Phase 1 near-side disk |
| SDO/AIA 94/131/171/193/211/304 | `/api/solar/aia` (exists) | 12 min | Phase 1 EUV modes, Phase 3 |
| GONG far-side helioseismic map | `/api/solar/farside?source=gong` (exists) | ~24 h | Phase 1 far side |
| SOHO/LASCO C2, C3 | `js/soho-feed.js` URLs (direct, `<img>`-safe); needs an edge proxy if used as a texture | 20–30 min | Phase 3 coronagraph plane |
| NOAA SWPC AR list, GOES X-ray | existing feeds | 1 min–daily | unchanged |

Helioviewer JP2 (historical frames) — deferred, §9.

---

## 7. Performance budget

Target: 60 fps at 1440p on a 2022 laptop GPU (Apple M2 / RTX 3050 class) in
Observed white-light with the corona on; 30 fps floor on Intel Iris Xe.
Measured via `__sun.perf`, reported in every phase's PR.

| Item | Budget (ms @1440p) |
|---|---|
| Photosphere + observed disk | 1.5 |
| Corona raymarch (Phase 3, 1 sample + accumulation) | 4.0 |
| Post chain (Phase 2) | 1.8 |
| Fluid step (Phase 4, 6×256²) | 1.2 |
| Everything else (shells, particles, UI) | 3.0 |
| **Total** | **≤ 11.5** |

The existing quality ladder (`u_quality`, sphere LOD 128/72/40) stays and
gains the resolution switch from Phase 1; a ladder step trades fidelity,
never the chip or the instruments.

---

## 8. Sequencing and PR discipline

1. Phase 0 — one PR, baseline PNGs attached. Nothing visual merges before it.
2. Phase 1 — the headline. Ship it, capture the baseline on real hardware,
   get the owner's eyes on the chip in all three states before Phase 2.
3. Phase 2 — post chain. Owner sign-off on bloom/exposure from screenshots.
4. Phases 3 and 4 are independent; either order.
5. Phase 5 — polish, after 2 and 3.
6. Phase 6 — only after 1–5 are merged and stable for a couple of weeks; it
   is the one phase with cross-page blast radius (the second vendored three).

Every PR: `node tests/sun-observed.mjs` (once it exists) + `npx playwright
test tests/sun-smoke.spec.js` in CI, `SUN_GPU=1 npx playwright test
tests/sun-visual.spec.js` on hardware, and a line in this file's progress
log. Re-read CLAUDE.md §5 before opening it.

---

## 9. Deferred / open

- **GONG far-side plage seeding** (`/api/solar/farside?format=series` →
  the strongest detections modulate a far-hemisphere plage term; no
  invented sunspots). Deferred from Phase 1; small.
- **Markers vs shader spots rotation sense** — see the Phase 1 log entry;
  fold into Phase 4 when the photosphere shader is open anyway.
- **Historical frames for the scrubber** (Helioviewer `getJP2Image` →
  edge decode). Needs a JP2 decoder at the edge or a client-side WASM
  OpenJPEG; not free. Until then the scrubber keeps the honest
  `live-fallback` label.
- **Doppler mode in Observed.** HMI Dopplergrams exist
  (`latest_1024_HMID.jpg`); adding a `dop` channel to the proxy would make the
  convection plan's Phase 5 view observed too. Cheap; do it in Phase 1 if the
  NASA URL resolves from the deploy's network policy.
- **Solar Orbiter EUI far-side EUV** when geometry cooperates
  (`farside-sources.js` already lists it) — would let the far hemisphere be
  observed some of the time. Chip must say which spacecraft.
- **Stereo pair / VR** — nothing here blocks it, nothing here does it.
