# Earth LOD — NASA precipitation deep-dive

Branch: `claude/earth-lod-nasa-data-b2b8h`

Companion to `EARTH_ML_FIRST_PRINCIPLES.md` and `WEATHER_FORECAST_PLAN.md`.
This document captures what just shipped and where the historical-analysis
work goes next.

## What landed in this branch

Three new client modules, registered into the existing
`weather-forecast.js::ForecastRegistry`. They share the same Forecaster
interface as `PersistenceForecaster`, so the existing
`WeatherForecastValidator` scores them automatically against the
persistence baseline.

| File | Role |
|---|---|
| `js/precip-climatology.js` | IDB-backed per-cell × per-local-hour running mean (Welford). Survives reloads. **Forever-growing** — every observation contributes, so older sessions compound into stronger priors. |
| `js/nasa-precip-extractor.js` | Inverts the NASA IMERG GIBS colour ramp pixel-by-pixel into a 72×36 mm/hr `Float32Array`. Emits `nasa-precip-update`. Independent observation source vs Open-Meteo's modelled precip. |
| `js/precip-forecast.js` | Three precip-specialised forecasters: `PrecipClimatologyForecaster`, `PrecipAnomalyPersistenceForecaster`, `PrecipAnomalyARForecaster`. All emit full 9-channel CHW frames so the validator can score them. |

The SW-panel skill table now also renders a precip section with Murphy
skill (% relative to persistence-v1) once each model has ≥5 matched
targets.

## Why this is the right next step

The 24-hour history ring forgets the diurnal cycle every day. That's why
naive persistence is so hard to beat at 12-24 h horizons — it
rediscovers the cycle from the most recent observation. **Anomaly-based
forecasting** (subtract climatology → persist or AR the anomaly → re-add
climatology at the target hour) is the standard meteorological remedy.
The persistent climatology store unlocks it.

Precipitation specifically benefits because:
- **Heavy-tailed.** AR on raw mm/hr is biased; AR on `log1p(precip - climatology)` isn't.
- **Diurnal-dominated.** Convective storms peak at solar noon over land,
  pre-dawn over the open ocean. A per-(cell, local-hour) prior nails this.
- **Independent observation.** Open-Meteo's precip is modelled (GFS/ECMWF).
  NASA IMERG is observed (microwave + IR fusion). Disagreement is signal.

## Predictive ladder, current state

| Phase | Module | Status |
|---|---|---|
| Persistence baseline | `weather-forecast.js::PersistenceForecaster` | shipped (prior session) |
| Climatology floor | `PrecipClimatologyForecaster` | **shipped this session** |
| Anomaly persistence | `PrecipAnomalyPersistenceForecaster` | **shipped this session** |
| Pooled AR(3) on log-anomaly | `PrecipAnomalyARForecaster` | **shipped this session** |
| Cross-validation w/ NASA observation | `NasaPrecipExtractor` (emits `nasa-precip-update`) | **shipped this session** |
| Optical-flow / advective nowcast (Phase 3) | `js/weather-flow.js` | next session |
| Server-trained NN (Phase 4) | requires 30 d retention bump | gated on backend |

## Concrete answer: "Can we get more detailed predictions if we do more historical analysis?"

Yes — and the architecture is now wired to make it happen automatically.

1. **The climatology store grows monotonically.** After ~14 days of
   normal usage, every (cell, local-hour) bin will have ~14 samples.
   That's enough for a stable diurnal cycle estimate. After ~30 days,
   the per-bin standard error drops by ~√2 again. You don't need to do
   anything — just leave a tab open or revisit the page periodically.

2. **The anomaly forecasters get strictly better as the climatology
   improves.** Day 0: climatology is empty, the anomaly forecasters
   degrade gracefully to persistence. Day 14: they should beat raw
   persistence at 12-24 h horizons by ~5-15 %. Day 30: the AR variant
   should beat both on every horizon.

3. **The NASA observation gives us a bias-correction signal.** Once we
   have ≥7 days of paired (modelled, observed) precip frames, we can
   compute a per-cell bias correction for Open-Meteo and feed the
   bias-corrected field forward into the AR forecaster. That's the
   "fusion" leg of the deep-dive — easy to add as a fourth forecaster
   in a follow-up.

## What to do next session

1. **Bias-correction forecaster.** New `PrecipFusionForecaster` that
   blends Open-Meteo with the rolling bias estimate from
   `nasa-precip-update`. Cheap once the extractor is in place.
2. **Coverage HUD.** Surface `precipClimatology.coverage()` in the SW
   panel so the user can watch the long-memory store fill up.
3. **Optical-flow nowcast (`weather-flow.js`).** Phase 3 of the
   `WEATHER_FORECAST_PLAN.md` — earns the "watch the storm move" UX.
4. **Server-side cold archive (`EARTH_ML_FIRST_PRINCIPLES.md` Phase
   0a).** Bump `weather_grid_cache` retention from 72 h → 720 h (30
   days). Unlocks Phase 4 NN training.

## Open questions

- **IMERG colour-ramp accuracy.** The current anchor table is
  approximate. A `GetLegendGraphic` parser would tighten absolute
  calibration; rank ordering is already fine for skill scoring.
- **AMSR2 layer.** A second observation source (`precip-amsr2`) is
  available in `EarthObsFeed` but currently default-off. Activating it
  and extending the extractor would give us a microwave-only
  cross-check for the IMERG fusion product.
- **Local-hour binning resolution.** 24 bins are coarse for thunderstorm
  modelling (peaks are tighter than 1 h). Half-hourly bins would double
  the store to ~1 MB per resolution — still trivial, but worth scoring
  the marginal benefit before bumping.
