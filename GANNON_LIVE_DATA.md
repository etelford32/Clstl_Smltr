# Gannon hindcast — live data lift architecture

How the May-2024 Gannon case-study page (`gannon-superstorm.html`) replaces
its shipped **placeholder** bundle with real archival data, channel by
channel, at runtime — with no front-end redeploy required when new data
lands.

> The page boots from a static bundle (`data/hindcast/gannon_may_2024_replay.json`,
> stamped `_is_placeholder: true`). Four background "lifts" then fetch real
> data through Vercel Edge endpoints and splice it into the in-memory
> `replay` object. Every lift is **silent-fail**: if the endpoint is
> blocked, offline, or has no data yet, the page keeps the placeholder for
> that channel and the rest of the page is unaffected.

## The four lifts

| # | Channel(s) | Source | Endpoint | Feeds | Status badge |
|---|---|---|---|---|---|
| 1 | `cme_events` (launch, v₀, AR) | NASA **DONKI** CMEAnalysis+FLR | `/api/hindcast/gannon` | Sun→Earth transit, shock front, flare flash | `cme` |
| 2 | `bz_nt`, `v_kms`, **`ae_nt`, `pdyn_npa`, `sym_h_nt`** | NASA **SPDF OMNI** HRO 1-min | `/api/omni/imf` | Bz river, magnetosphere compression, aurora, Bz/V/Dst readouts | `imf` |
| 3 | `truth_400km` (GRACE-FO, Swarm-C ρ) | **TU Delft** Doornbos v02 | `/api/density/tudelft` | density-truth scatter | `density_truth` |
| 4 | `ap_mhd`, `ap_gnd`, `msis_apmhd`, `msis_apgnd` | **BATS-R-US / SWMF** pipeline artifact | `/api/hindcast/gannon-model` | Ap-saturation + density + residuals charts; lifts `_is_placeholder` | `model` |

A small status row under the hero pill (`#gn-sources`) flips each badge from
`○` (placeholder) to `●` (live) as its lift resolves — so the silent-fail
lifts are observable in production. `markSourceLive(key, label)` drives it.

## What's live vs still placeholder

- **Lifts 1–3** pull genuinely real **archival** data for the fixed
  May-8–13 2024 window. Once they resolve, the **Bz river, magnetosphere
  compression, shock fronts, flare flashes, aurora, and the Bz/V/Dst
  readouts in the Sun→Earth scene are all driven by real data.**
- **Lift 4 is the last placeholder piece.** The Ap* surrogates and the
  MHD-corrected 400 km density are **model outputs**, not a public feed —
  they come from the offline BATS-R-US / SWMF run. They cannot be
  "fetched"; they must be **produced** by the pipeline, uploaded, and then
  relayed by `/api/hindcast/gannon-model`.

## New in this change (OMNI indices → scene)

The OMNI endpoint already parsed `ae`, `pdyn`, and `sym_h` but the page
never requested or used them. They now ride lift #2:

- **AE (auroral electrojet)** → auroral-oval brightness (`auroraFromAE`,
  ~2000 nT reference). A direct measure of auroral current; replaces the
  synthetic `hpi_gw` proxy when present.
- **Pdyn (dynamic pressure)** → magnetopause standoff (`comprFromPdyn`,
  Shue-like `R ∝ Pdyn^(−1/6)`). The physical driver of boundary position;
  replaces the `v_kms` proxy when present.
- **SYM-H (≈ Dst)** → the `Dst … nT` readout, the canonical storm-severity
  index (Gannon bottomed near −412 nT).

The engine (`gannon-superstorm-engine.js`) passes these through `sample()`
as `ae_nt` / `pdyn_npa` / `sym_h_nt` (null until lifted). The scene falls
back to its bundle proxies when they're absent, so nothing breaks pre-lift.

## Lift 4: how the model artifact lands

```
BATS-R-US / SWMF run (workstation)        ── see MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md
        │  produces ap_mhd / ap_gnd + msis_apmhd / apgnd over the bundle grid
        ▼
  upload to object storage (R2):  hindcast/gannon/model-v1.json
        │
        ▼
  GET /api/hindcast/gannon-model   ── relays the artifact (or { available:false })
        │
        ▼
  page lift: splice tracks → re-mount the 3 model-trace charts →
             recompute skill → flip pill to ✓ VALIDATED HINDCAST
```

### Artifact contract (`hindcast/gannon/model-v1.json`)

Arrays must match the bundle grid length (`drivers_compact.ap_real.length`).

```jsonc
{
  "event": "gannon_may_2024",
  "run_id": "...",                // surfaced in provenance
  "generated_at": "ISO-8601",
  "source": "BATS-R-US / SWMF ...",
  "window": { "start": "...", "end": "...", "step_minutes": 60, "anchor_iso": "..." },
  "drivers_compact": {
    "ap_mhd": [...], "ap_gnd": [...],
    "phi_pc_kv": [...], "hpi_gw": [...], "sme_nt": [...]   // optional, also lifted
  },
  "density_400km": { "msis_apmhd": [...], "msis_apgnd": [...] },
  "skill": { "rmse_base": 0, "rmse_mhd": 0, "rmse_gnd": 0, "skill_mhd": 0, "skill_gnd": 0 }
}
```

The endpoint returns `200 { available: false, reason }` when R2 isn't
configured or the artifact isn't uploaded yet — the page lift treats that
as a clean no-op. **Bump `ARTIFACT_KEY`'s version suffix in lockstep with
the pipeline** whenever the artifact schema changes.

## Verification notes

- Lifts 1–4 hit external hosts. **The Claude-on-the-web sandbox blocks
  egress (HTTP 403 from the proxy) to NASA/SPDF/TU-Delft**, so the *real
  fetch* must be verified in a Vercel preview/prod where egress is allowed.
- The **splice + render logic** is verified headlessly: the engine passes
  `ae_nt`/`pdyn_npa`/`sym_h_nt` through, and the scene renders AE-driven
  aurora, Pdyn-driven compression, and the Dst readout across the full
  scrub range with no exceptions (see the harness in the PR history).
- `NASA_API_KEY` (DONKI) falls back to the heavily rate-limited `DEMO_KEY`
  if unset — set it in the Vercel project for reliable lift #1.
