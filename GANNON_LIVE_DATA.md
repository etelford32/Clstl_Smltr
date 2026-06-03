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

## Lift 3: how the density mirror lands

TU Delft retired the open **HTTP** tree for the Doornbos v02 accelerometer
density products in favour of **FTP-only** distribution. Vercel's Edge
runtime can't `fetch()` an `ftp://` URL, so `/api/density/tudelft` can no
longer pull the daily files live. The fix is an R2 mirror, populated from a
workstation that *can* speak FTP:

```
workstation: pull daily files off TU Delft FTP   (operator, manual)
        │   e.g. lftp/wget grcfo_density_2024_05_*.txt + swrmc_density_*
        ▼
  node scripts/build-density-mirror.mjs --local-dir ./tudelft_dl --upload
        │   parse (shared api/_lib/tudelft-parse.js) → dedupe → canonical JSON
        ▼
  R2:  hindcast/gannon/density-grace_fo-v1.json
       hindcast/gannon/density-swarm_c-v1.json
        │
        ▼
  GET /api/density/tudelft?mission=…  ── serves the mirror, no upstream touch
        │
        ▼
  page lift 3: real GRACE-FO / Swarm-C truth scatter → density_truth badge ●
```

`/api/density/tudelft` now tries the **R2 mirror first** and falls back to
the **live HTTP fetch** (retained for any window/mission still on HTTP, and
for envs without R2). `?source=mirror|live` forces a path for debugging.
The response shape is unchanged (`data.samples[]`), so the page lift is
untouched. The parser is shared between the mirror builder and the live
fallback via `api/_lib/tudelft-parse.js`, so the two can't drift.

**Mirror artifact** (`density-<mission>-v1.json`):

```jsonc
{
  "schema": "tudelft-density-mirror/v1",
  "mission": "grace_fo",
  "source": "TU Delft … — mirrored to R2 on <date>",
  "coverage": { "start": "...", "end": "...", "n_records": 0, "days": [...] },
  "parser_version": "tudelft-v02-v1",
  "records": [ { "t": "...", "alt_km": 0, "lat_deg": 0, "lon_deg": 0, "rho_kg_m3": 0 } ]
}
```

Records are stored already-parsed + altitude-filtered; the endpoint just
windows + subsamples per request. `--base-subsample N` shrinks the upload
(default 1 = full ~10 s cadence). Bump the `-vN` key suffix in lockstep
with the schema. `--self-test` proves the parser is wired up with no I/O.

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

### Building + publishing the artifact

`scripts/build-gannon-model-artifact.mjs` assembles the contract above from
the pipeline outputs and (optionally) uploads it to R2:

```
# after a real BATS-R-US run produces the hindcast + fits + residuals:
node scripts/build-gannon-model-artifact.mjs --upload
```

It reads `--bundle` for the grid (window + `ap_real.length` + `f107_daily`),
resamples the hindcast's `phi_pc_kv`/`hpi_gw` onto that grid, applies the
pseudo-Ap fits to get `ap_mhd`/`ap_gnd`, and recomputes `msis_apmhd`/
`msis_apgnd` at 400 km via `js/upper-atmosphere-engine.js density()` — the
same surrogate that produced the bundle's `msis_apreal`, so all three
density traces share one backend. The ground track (`ap_gnd`, `sme_nt`,
`msis_apgnd`) is added only when `--ground-fit` + `--ground-features` are
supplied; `skill` is filled from `--residuals` (validate_density output).

**Integrity gate:** the hindcast/fit JSONs carry `is_placeholder` /
`is_placeholder_input` sentinels when produced by the plumbing generators
rather than a real run. The tool refuses to assemble from them without
`--allow-placeholder`, and **never** uploads a placeholder-derived
artifact (so the page can't be made to show ✓ VALIDATED for synthetic
data). `--self-test` recomputes `msis_apreal` from the bundle to prove the
density backend matches before you trust a run.

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
