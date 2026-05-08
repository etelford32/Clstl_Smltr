# MHD-driven thermospheric density product — plan

Branch: `claude/mhd-density-product-planning-8KPQO`

Companion to `EARTH_LOD_NASA_PRECIP_PLAN.md` and `WEATHER_FORECAST_PLAN.md`.
This is the planning artifact for a commercial **upper-atmosphere
density nowcast + forecast** built on top of the existing SWMF/BATS-R-US
(`swmf/`) and DSMC/SPARTA + NRLMSISE-00 (`dsmc/`) pipelines. No code is
proposed for this commit — the goal is to align on customer value and
the build sequence before we touch anything.

## What we already have

| Capability | Where | Notes |
|---|---|---|
| Live F10.7 / Ap / Kp ingestion | `dsmc/pipeline/ingest_indices.py` | NOAA SWPC, daemonised, Postgres-backed. |
| L1 IMF ingestion (DSCOVR / ACE) | `swmf/pipeline/ingest_l1.py` | Feeds BATS-R-US PARAM.in. |
| BATS-R-US MHD orchestrator | `swmf/pipeline/run_forecast.py` | mpiexec + post-process to JSON. |
| Empirical density (NRLMSISE-00) | `dsmc/pipeline/atmosphere.py` | With SPARTA lookup-table fastpath. |
| Drag forecast for one TLE | `dsmc/pipeline/drag_forecast.py` | King-Hele decay + perigee density. |
| Frontend simulator | `upper-atmosphere.html` + `js/upper-atmosphere-engine.js` | 80–2000 km, 7-species. |
| Edge profile endpoint | `api/atmosphere/profile.js` | Same-origin, JS seed-grid fallback. |

The pieces are all there. What's missing is the **causal coupling**
between the MHD solver and the thermosphere, and a productised contract
that LEO operators actually want to integrate with.

## The product, in one line

> Per-satellite, per-orbit neutral-density estimates **driven by the
> MHD-resolved magnetospheric energy input**, delivered as a JSON
> nowcast (last 6 h) and a 24–72 h forecast with calibrated uncertainty.

That phrasing matters: empirical models (MSIS, JB2008, DTM) already
exist and are free. The wedge is **MHD-conditioned** — i.e. when a CME
hits, our density spikes hours before MSIS catches up via Ap, because
Ap is a 3-hour-after-the-fact summary and BATS-R-US is solving the
energy deposition in real time.

## Why operators care (Spire, Planet, SpaceX)

| Operator | Asset profile | Density-driven pain | What we sell them |
|---|---|---|---|
| **Spire** | ~150 cubesats, 400–550 km, GNSS-RO and AIS. Cubesats have low ballistic coefficient → very drag-sensitive. | Conjunction screening false-positive rate spikes during storms; RO occultation point planning needs accurate sub-orbit drag. | **Per-spacecraft 6 h nowcast + 72 h forecast**, with hourly perigee-altitude prediction band. JSON push to their ops console. |
| **Planet** | ~200 Doves @ ~475 km + SkySats higher. Optical revisit cadence depends on along-track timing. | Ground-track drift during storms desyncs imaging plan; reaction-wheel duty cycle climbs. | Same nowcast, plus an **along-track timing-error forecast** (∆t at next equator crossing). Lets their tasking system rebook tiles before the slip. |
| **SpaceX (Starlink)** | 6000+ shells from 340–570 km. Ballistic coefficient varies enormously (operational vs. parking orbit). The Feb 2022 loss of 38 satellites is the canonical worst case. | Decision to delay a launch into a forecast storm; per-plane raise-burn scheduling; reentry timing for end-of-life vehicles. | **Constellation-wide density grid** (lat × lon × alt × time), updated hourly. Internal flight dynamics teams ingest the netCDF and run their own propagator. Sold as a data feed, not a per-sat product. |

The Feb 2022 Starlink event is **the** marketing hook. It is the only
recent commercial loss directly attributable to thermospheric density
being underforecast, and every flight-dynamics team in LEO has a slide
about it. Our pitch in one sentence: *"Our MHD-coupled forecast had
the energy input from that storm 6 h before MSIS+Ap did."* (We need to
prove that with hindcasts — see Phase 0 below.)

## The science wedge — why MHD beats empirical

Empirical models are driven by **F10.7** (EUV/UV, governs the quiet
thermosphere) and **Ap/Kp** (geomagnetic activity proxy, governs the
storm-time response). Two structural problems:

1. **Ap is a 3-hour summary.** The actual Joule-heating power deposited
   in the auroral oval can swing by 10× inside that window. Density at
   400 km can double in 90 minutes during a sudden commencement.
   Empirical models can't see that.
2. **Ap saturates.** It's capped at 400. The May 2024 Gannon storm
   pinned Ap at 400 for an entire UT day; MSIS had no way to
   distinguish a "pinned 400" storm from a slightly-less-pinned 400
   storm. BATS-R-US sees the actual cross-polar-cap potential and
   Poynting flux — neither saturates.

What the MHD run actually gives us that we feed into the
thermosphere:

| MHD output | Thermospheric driver |
|---|---|
| Cross-polar-cap potential (Φ_PC) | Ion convection → ion-neutral frictional heating |
| Region-1 / Region-2 FAC pattern | Joule heating spatial distribution |
| Hemispheric power index (HPI) from particle precip | Auroral E-region heating |
| Solar-wind dynamic pressure pulses | Direct compression of the magnetopause → cusp heating |

We don't need to run a full GITM/TIEGCM coupled model on day 1.
**Phase 1** is "pseudo-Ap": derive an *effective* Ap from the live
BATS-R-US Φ_PC and HPI using a regression fit against historical
storms, then drive NRLMSISE-00 with that. **Phase 2** is replacing
NRLMSISE with a proper TIEGCM run when the MHD outputs justify it.

## Build phases

### Phase 0 — Hindcast validation (week 1–2, **gating**)

Before we sell anyone anything we need a paper trail. Pick five
historical events:

- Feb 2022 Starlink storm (32 of 49 lost)
- May 2024 Gannon (G5)
- Oct 2024 X9 flare event (we already have data: see
  `ET&CLAUDE_SUN_MHD_NASA_X9.0_Flare_2024-10-03/`)
- Halloween 2003 (canonical)
- One quiet-time control week

For each: replay the L1 stream into BATS-R-US, run our pseudo-Ap
regression, compare the resulting density at 400 km against:
- NRLMSISE-00 forced by historical Ap (the baseline we have to beat)
- GRACE-FO accelerometer-derived density (the truth)
- CHAMP-era density if relevant

**Success bar:** RMSE on 400 km storm-time density ≥ 25% better than
MSIS-with-real-Ap. If we can't clear that on hindcasts, the product
doesn't ship.

### Phase 1 — Pseudo-Ap MHD coupling (week 3–4)

- New module `dsmc/pipeline/mhd_drivers.py`: reads the latest
  `swmf/results/forecast_*.json`, extracts Φ_PC and HPI, runs the
  regression to emit a 1-minute-cadence "MHD-Ap".
- `atmosphere.density(...)` gains an optional `ap_source="mhd"` kwarg.
- `drag_forecast.forecast_drag(...)` exposes a `density_source` field
  in its return so we can A/B against MSIS-Ap on the same TLE.
- Backfill the MHD-Ap timeseries for the Phase 0 events so we have
  hindcasts to point at in marketing.

### Phase 2 — Constellation grid product (week 5–7)

This is the SpaceX-shaped product.

- New endpoint `/v1/density/grid` returning a netCDF or zstd-compressed
  CBOR grid: `(time, lat, lon, alt) → ρ, T, [O], [N₂], [He], σ_ρ`.
- Initial resolution: 1 h × 5° × 5° × 25 km, 0–24 h forecast horizon.
- Driven by hourly BATS-R-US runs (current `FORECAST_CADENCE_H=1`).
- Per-cell uncertainty σ_ρ from the Phase 0 hindcast residuals — this
  is what flight dynamics teams will actually use to size their margin.

### Phase 3 — Per-spacecraft drag forecast service (week 6–8, parallel)

Spire- and Planet-shaped product.

- `/v1/drag/forecast?norad_id=…&horizon_h=72` returns:
  - perigee-altitude time series (mean + 1σ)
  - along-track timing error vs nominal at the next 24 ascending nodes
  - reentry-probability distribution if the object is below 250 km
- Subscription model: customer registers their NORAD list, we recompute
  on every BATS-R-US cadence and push deltas via webhook.
- Auth via the existing API-key system
  (`supabase-api-keys-migration.sql`).

### Phase 4 — TIEGCM coupling (month 3+, optional)

Replace the pseudo-Ap regression with a real coupled
thermosphere-ionosphere solve. Driven by Phase 0/1 data telling us
where the regression breaks (likely: high-latitude, high-altitude,
post-storm recovery phase).

## Pricing posture — initial

| Tier | Audience | What's included | Notes |
|---|---|---|---|
| **Free** | Existing simulator users | The current `upper-atmosphere.html` page, MSIS-driven. | No change. |
| **Pro** | Universities, individual ops engineers | Per-spacecraft drag forecast for ≤ 5 NORAD IDs, JSON only. | Slot into existing `Pro` tier. |
| **Enterprise — Operator** | Spire, Planet, etc. | Unlimited NORAD IDs, webhook push, 72 h horizon, MHD-Ap timeseries. | Negotiated; ~$X k/yr per N-spacecraft slab. |
| **Enterprise — Constellation** | SpaceX, OneWeb | netCDF grid feed, hourly cadence, hindcast access. | Custom; six-figure starting point, justified by Feb 2022 LOC. |

`pricing.html` and `contact-enterprise.html` already exist; the
landing for this product would slot in as a new card on `pricing.html`
plus a deep-dive page (`mhd-density.html` or similar).

## Risks + open questions

1. **MHD compute cost.** A 1-hour-cadence BATS-R-US run on
   `MPI_NPROC=4` is fine for one tier; if we ramp to 15-minute cadence
   for storm response we need a bigger box. Budget a GPU node or a
   burstable cluster before Phase 2.
2. **Calibration data access.** GRACE-FO accelerometer densities are
   public but lagged. We need a data-sharing pact with ASTRA / TU Delft
   for near-real-time density observations to *continuously* recalibrate
   in production, not just in Phase 0 hindcasts.
3. **Liability framing.** Operators will not pay for a forecast they
   can sue us over if it's wrong. The product is sold as **decision
   support with calibrated uncertainty**, never as an alert. Legal
   needs to bless `eula.html` updates before the first enterprise
   contract.
4. **Coupling vs. competing.** SpaceX likely has internal flight
   dynamics tooling already. We win not by being more accurate than
   their tool — we win by being an **independent second opinion** with
   documented hindcasts, that costs less than building it themselves.

## Concrete next step

Phase 0, item 1: replay the Oct 2024 X9 flare event we already have
local data for through `swmf/pipeline/run_forecast.py` in hindcast
mode, dump Φ_PC and HPI, fit the pseudo-Ap regression against the
historical Ap timeseries from `dsmc/pipeline/ingest_indices.py`, and
write a one-page residual analysis. That tells us within a week
whether the wedge is real before we commit to Phase 1.
