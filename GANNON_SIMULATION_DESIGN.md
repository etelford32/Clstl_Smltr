# Gannon Superstorm Simulation — page design & MVP

Branch: `claude/gannon-superstorm-simulation-CpFh8`

Target URL: `/gannon-superstorm` (file: `gannon-superstorm.html`).
Companion to the runbook in `MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md`.
This doc fixes the architecture and the MVP cut so the page can be
shipped with scientific defensibility, customer resonance, and
share-worthy visuals from day one.

## Architecture review — what we build on

We already have three patterns in this repo. The Gannon page **reuses
all three**; we don't invent a fourth.

### 1. Static HTML + ES-module JS engine (`upper-atmosphere.html`)

* Page is a self-contained HTML with inline CSS and a `<script
  type="module">` that imports from `js/upper-atmosphere-*.js`.
* `js/upper-atmosphere-engine.js` is the canonical density engine —
  Bates temperature, 7-species number densities, `density({altitudeKm,
  f107Sfu, ap})`, `kpToAp`. Re-export from here; do not duplicate.
* Time-scrubber, fleet, globe, ribbons, conjunctions are independent
  modules wired in `<script>` blocks at the bottom of the HTML.
* This is the pattern Gannon's page follows.

### 2. Rust crates → WASM (`crates/stellar-mhd-2d`, `rust-*`)

* Two flavours in the repo:
  * **Workspace crates** (`crates/disc-hydro`, `crates/stellar-mhd-2d`)
    — zero external deps, `cdylib` + `rlib`, hand-written C-ABI WASM.
    `stellar-mhd-2d/src/wasm.rs` is the binding layer. Already a 2.5-D
    resistive HLLD MHD solver with GLM divergence cleaning. **This is
    exactly the kernel we want for the Gannon magnetosphere slice
    visualization**, modulo: it was authored for stellar flares, not
    Earth's magnetosphere — geometry, boundary conditions, and the
    driving conditions need adaptation.
  * **Standalone crates** (`rust-sgp4`, `rust-forecast`, `rust-sstar`,
    `rust-sunfield`, `rust-sirius`) — built via `build-wasm.sh` →
    `wasm-bindgen --target web --out-dir js/<name>-wasm/`.
    Loaded from HTML by `import init from './js/<name>-wasm/<name>.js'`.
* Build constraint: the Vercel deploy uses
  `wasm32-unknown-unknown` and may not have `wasm-bindgen` CLI on the
  build image — the script falls back to copying the raw `.wasm`. The
  workspace crates' hand-written C-ABI bindings sidestep this entirely.

### 3. Static data fixtures + edge API (`api/atmosphere/profile.js`)

* JSON pre-baked into `data/` is the fast path. Edge endpoints sit
  on top for live drivers.
* Gannon is a **replay**, not a live driver: the source of truth is
  a static JSON file dropped into `data/hindcast/`.

### Decision: WASM or no WASM for v0?

**No WASM in MVP.** The MHD field is *pre-computed* (from the
BATS-R-US replay in `data/hindcast/gannon_may_2024_hindcast.json`)
and *served as a timeseries of pre-rendered slice snapshots*. The
browser is doing playback + species/density math via the existing
JS engine, not a live MHD solve.

WASM enters in **Phase 1** of the page (post-MVP) if we want a live
"what if the dipole tilt were different" mode driven by
`stellar-mhd-2d`. That's not in the MVP cut.

## MVP deliverables

The cut is organised by the three forces driving the page: science
defensibility, customer resonance, share-worthy visuals. Each item is
gated on **must / should / nice** so we know what gets dropped if we
slip.

### A. Scientific validity (must clear all)

| # | Deliverable | Source of truth |
|---|---|---|
| A1 | Three timeseries traces overlaid on one panel: real Ap (saturated at 400), Ap*_mhd, Ap*_gnd. The visible saturation flat-line vs. the climbing surrogates **is the point** of the page. | `data/hindcast/gannon_may_2024_hindcast.json` |
| A2 | A density-at-400 km panel: MSIS+real-Ap (baseline), MSIS+Ap*_mhd, MSIS+Ap*_gnd, GRACE-FO + Swarm-C truth scatter overlaid. | hindcast JSON + truth CSVs converted to JSON. |
| A3 | Residuals histogram, segmented by storm phase (ramp / peak / recovery). Static SVG generated at bake time — no client compute. | validator output. |
| A4 | Methodology pane: window, BATS-R-US grid parameters, fitted coefficients with R², link to the runbook. Plain prose, click-through citations. | `MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md` + DOI links. |
| A5 | Data provenance pill: every chart shows where its numbers came from (OMNI / GFZ / TU Delft / SuperMAG / our BATS-R-US run). | same pattern as `upper-atmosphere.html` source-pill. |

**Pass condition:** an external space physicist visiting the page
should be able to reconstruct the claim end-to-end from the panels
alone, without trusting us. If they can't, A is not done.

### B. Customer appreciation (must clear B1–B3, should clear B4)

| # | Deliverable | Audience |
|---|---|---|
| B1 | A "what would have happened to your fleet" picker: drop in 1–N NORAD IDs, see perigee-altitude band across the 72 h replay, with a counterfactual MSIS-only band overlaid. | Spire, Planet, individual ops engineers |
| B2 | Aggregate constellation impact card: pre-baked numbers for Starlink shells and Spire's then-fleet — "Without MHD-corrected density, our forecast would have undershot total drag by X% at 400 km on May 11". | SpaceX flight dynamics, Spire mission ops |
| B3 | Two-button CSV/JSON export of the full replay (timeseries + residuals + per-altitude grid). Watermarked with the methodology link. | every customer evaluator. |
| B4 | A "rate this hindcast" feedback widget that emails the team and posts to the existing `supabase-feedback-migration.sql` table. | warm-lead capture. |

**Pass condition:** an operations engineer hitting the page cold can
within 60 seconds answer "would this have mattered for my fleet".

### C. Visual shareability (must clear C1–C2, should clear C3)

| # | Deliverable | Why |
|---|---|---|
| C1 | A hero animation: 72 h time-scrubber driving a globe with aurora oval + thermospheric-density bulge that **expands visibly** as the storm peaks. Loops at 60×–600× speed. | The shareable artefact. Reuse `js/upper-atmosphere-globe.js` + `js/upper-atmosphere-aurora-physics.js`. |
| C2 | A single-image OG card auto-generated from the peak-density frame, sized 1200×630, baked into `static/og/gannon-superstorm.jpg` so Twitter/LinkedIn previews carry the same hero. | Every retweet then carries the hindcast. |
| C3 | A "share this moment" button: at any scrubber position, copy a URL with `?t=2024-05-11T07:30Z` that deep-links the scrubber and re-renders the OG card for that timestamp. | High-engagement: each customer can share *their* moment. |
| C4 | nice — a 15 s MP4 export rendered offline (puppeteer through the page in headless mode) for direct upload to social. | not in MVP. |

**Pass condition:** the OG preview alone makes a flight-dynamics
engineer click. If it looks like every other plot panel, C is not
done.

### D. Out of scope for MVP (deferred)

* Live BATS-R-US re-runs from the browser. Replay only.
* WASM-driven MHD field perturbation ("what if Bz were stronger by
  20 %"). Phase 1 candidate, would consume `stellar-mhd-2d`.
* Multi-event navigator (Gannon + Feb 2022 + Halloween 2003). Once
  we have ≥ 3 events the navigator is the obvious cross-sell, but
  shipping the page with one event is fine — the runbook is the
  forward-narrative.

## File layout

```
gannon-superstorm.html                     # the page
js/gannon-superstorm-engine.js             # replay player + driver math
js/gannon-superstorm-ui.js                 # left/center/right panels
js/gannon-superstorm-fleet.js              # B1 NORAD picker / band chart
data/hindcast/
  gannon_may_2024_replay.json              # the static bundle the page loads
  gannon_may_2024_residuals.json           # A3 input
static/og/gannon-superstorm.jpg            # C2 OG image (baked at deploy)
```

`gannon-superstorm-engine.js` imports from
`upper-atmosphere-engine.js` for `density`, `batesTemperature`,
`kpToAp` — we do not re-derive. The Gannon engine is responsible only
for replay timing, driver-selection (which Ap track), and the
counterfactual A/B math.

## The replay bundle schema

Pinning this now so the runbook's day-3 export step and the page can
agree before either is written.

```jsonc
{
  "event": "gannon_may_2024",
  "window": { "start": "2024-05-10T12:00:00Z",
              "end":   "2024-05-13T12:00:00Z",
              "step_minutes": 5 },
  "drivers": {
    "t": ["2024-05-10T12:00:00Z", "..."],
    "bz_nt":         [/* IMF Bz GSM, 1-min upsampled to 5-min */],
    "v_kms":         [/* solar wind speed */],
    "pdyn_npa":      [/* dynamic pressure */],
    "ap_real":       [/* GFZ historical Ap, stepwise 3-h */],
    "ap_mhd":        [/* fitted Ap*_mhd from Φ_PC + HPI */],
    "ap_gnd":        [/* fitted Ap*_gnd from SME + jh_proxy */],
    "phi_pc_kv":     [/* MHD output */],
    "hpi_gw":        [/* MHD output */],
    "sme_nt":        [/* ground-mag */],
    "jh_proxy_gw":   [/* ground-mag derived Joule heating proxy */]
  },
  "density_400km": {
    "msis_apreal":   [/* baseline at 400 km, kg/m³ */],
    "msis_apmhd":    [/* MHD-driven */],
    "msis_apgnd":    [/* mag-driven */]
  },
  "truth": {
    "grace_fo": [{ "t": "...", "alt_km": 490.2, "lat": 12.3, "lon": -45.0, "rho_kgm3": 1.2e-12 }, "..."],
    "swarm_c":  [{ "t": "...", "alt_km": 450.7, "lat":  0.1, "lon":  10.0, "rho_kgm3": 9.5e-13 }, "..."]
  },
  "fit": {
    "mhd":    { "a": 0.0, "b": 0.0, "c": 0.0, "r2": 0.0 },
    "ground": { "a": 0.0, "b": 0.0, "c": 0.0, "d": 0.0, "r2": 0.0 }
  },
  "residuals": { /* per-sample residuals for A3 histogram */ },
  "provenance": {
    "imf":           "OMNI HRO 1-min via SPDF",
    "ap":            "GFZ Kp_ap_Ap_SN_F107 v1.2",
    "grace_fo":      "TU Delft v02",
    "swarm_c":       "ESA / TU Delft",
    "ground_mag":    "SuperMAG / INTERMAGNET, locally reconstructed",
    "mhd":           "BATS-R-US, SWMF tag <fill at runtime>, MPI_NPROC=4",
    "regression":    "OLS, single-event",
    "validator_git": "<commit sha at validate time>"
  },
  "schema_version": 1
}
```

## Build / deploy notes

* The page is a static HTML, served by Vercel from the repo root —
  same path pattern as every other `*.html` page (and routed clean
  via `vercel.json` if we want `/gannon-superstorm` instead of
  `/gannon-superstorm.html`).
* The replay bundle is committed under `data/hindcast/` (currently
  gitignored — confirm: only the *raw* fetches are gitignored, the
  derived replay JSON should be tracked since it's small and the
  page can't load without it).
* No build step touches the Rust workspace for MVP. WASM remains
  out-of-tree until Phase 1.

## Cut order if we slip

If we have to drop scope on the way to ship, drop in this order:

1. C3 (deep-link share). Replace with static OG only.
2. B4 (feedback widget).
3. A3 segmented residuals → single residual histogram.
4. B2 aggregate constellation card.

Do **not** drop anything in A1–A2 or B1. Those three are the page.
