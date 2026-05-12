# Predictive Weather Analytics — Pickup Plan

Branch: `claude/earth-sim-time-analysis-GLF1y`

This document is the cold-start brief for the next session. The
24-hour replay layer (history ring, resolver, slider, rotation
toggle) shipped in commits up to `5b3696c`. The work below extends
it forward in time with a forecast layer.

---

## Where we are (already committed)

| Component | File | What it does |
|---|---|---|
| Coarse history ring | `js/weather-history.js` | IDB ring, 24 hourly frames × 9 channels, CHW Float32, ~94 KB/frame, ~2.24 MB total. `bracket(t)`, `nearest(t)`, `all()`. |
| Decode pipeline | `js/weather-feed.js` | `_extractCoarse(rows, w, h) → Float32Array(w*h*9)`. `_decodeCoarse(coarse, w, h) → {weatherBuf, windBuf, cloudBuf}`. Pure functions. |
| Resolver | `js/weather-frame-resolver.js` | LRU of decoded frames, lerp between bracketing frames, dispatches synthetic `weather-update` keyed to `simTimeMs`. |
| Cold-start backfill | `api/weather/grid.js` (range mode), `WeatherFeed.backfill()` | `?since=<ISO>&limit=<N>` returns up to 24 frames; client ingests on page load. |
| Time slider | `earth.html` `#tc-scrub` | `[-1440, 0]` minutes. Pure data scrubber over `simTimeMs`. Auto-pause on past-scrub. |
| Rotation toggle | `earth.html` SW panel header | `planetRotationEnabled`, default OFF. localStorage-persisted. Decoupled from `simTimeMs`. |

### Existing forecast scaffolding (Kp / point-temp only — patterns to mirror)

| File | What to reuse |
|---|---|
| `js/solar-weather-forecast.js:97-108` | `fitAR(series, p) → {phi, sigma2, mu}` — works on any 1D series. |
| `js/solar-weather-forecast.js:142-176` | `forecastAR(model, history, h) → {mean, lo80, hi80, lo95, hi95, sigma}` |
| `js/solar-weather-forecast.js:316-342` | `persistenceForecast(kpNow, history, h)` — null-baseline pattern. |
| `js/forecast-validation.js:60-83` | `summarize(rows, modelKey) → {n, mae, rmse, bias, hit_rate}` |
| `js/forecast-validation.js:85-99` | `skillScore(completed, modelKey, refKey)` — Murphy score. |
| `js/temp-forecast.js:272-305` | Ridge/GFS ensemble with horizon-decaying weights. Same pattern works for AR/persistence blend. |

---

## Goal

Gridded forecast for **U, V, T** (and optionally P, RH) at horizons
**{1, 3, 6, 12, 24 h}**, measured by **skill vs persistence** (Murphy
score on MAE).

Targets:
- +10% skill at 1 h
- +5% skill at 6 h
- Roughly even with persistence at 24 h (diurnal cycle dominates)

If we hit those, we have a real analytics tool. If we miss, the
validator tells us before we ship.

---

## Phased plan

Each phase is independently shippable. Start at Phase 1.

### Phase 1 — Persistence baseline + gridded validator (~2 files)

The foundation. Without it, any later "ML" claim is vapor.

**New file: `js/weather-forecast.js`**
```js
import { NUM_COARSE_CHANNELS } from './weather-history.js';

const CHANNELS = ['T', 'P', 'RH', 'U', 'V',
                  'cl_low', 'cl_mid', 'cl_high', 'precip'];
const FORECAST_HORIZONS_H = [1, 3, 6, 12, 24];

export class WeatherForecaster {
    constructor({ history }) {
        this._history = history;
        this._latest = null;
    }

    forecast() {
        const frames = this._history.all();
        if (frames.length === 0) return null;
        const newest = frames[frames.length - 1];
        const { gridW, gridH, coarse } = newest;
        const N = gridW * gridH;

        // Naive persistence: every horizon gets the current frame.
        // Output coarse-format Float32Arrays so they can flow through
        // the same _decodeCoarse pipeline observations use.
        const persistence = {};
        for (let ch = 0; ch < NUM_COARSE_CHANNELS; ch++) {
            persistence[CHANNELS[ch]] = {};
            const slice = coarse.subarray(ch * N, (ch + 1) * N);
            for (const h of FORECAST_HORIZONS_H) {
                persistence[CHANNELS[ch]][h] = new Float32Array(slice);
            }
        }
        this._latest = {
            issued_ms: newest.t,
            persistence,
            horizons: FORECAST_HORIZONS_H,
            gridW, gridH,
        };
        return this._latest;
    }

    getLatest() { return this._latest; }
}

export { CHANNELS, FORECAST_HORIZONS_H };
```

**New file: `js/weather-forecast-validation.js`**

Mirror `js/forecast-validation.js` shape. Pending/completed in
localStorage. **Pool aggregation per channel × horizon** — do NOT
store per-cell scores (2592 cells × 9 channels × 5 horizons = 116K
entries — too noisy and storage-heavy).

Use Welford's online algorithm for running mean + variance:
```
state[channel][horizon] = { n, mean, M2, mae_sum }
```
~45 entries total (9 × 5). Easily fits in localStorage at < 5 KB.

On every new frame ingested into `WeatherHistory`:
1. For each pending forecast whose `target_ms` is within ±30 min of
   the new frame's `t`, compute per-cell error against the new
   frame's coarse values. Aggregate to channel-level MAE.
2. Update Welford state for `(channel, horizon)`.
3. Drop the matched pending entry.
4. Dispatch `weather-forecast-validation` event with the latest
   skill summary.

When `WeatherForecaster.forecast()` is called, also push pending
entries for each `(channel, horizon)` so they can be matched later.

**Wiring in `earth.html`:**
- Instantiate `WeatherForecaster` after `wxResolver`.
- Instantiate `WeatherForecastValidator` and start it (subscribes to
  history-ingest events).
- New SW-panel sub-row "Forecast skill" with a small grid:
  rows = channels (T, U, V, RH), cols = horizons (1h, 3h, 6h, 12h,
  24h), cells = MAE numbers. Reuse `forecast-timeline.js` styling.

**Validity test before shipping:**
- Wait a few hours; verify persistence MAE numbers populate.
- Hand-compute MAE on one channel × horizon, confirm match.

### Phase 2 — Pooled AR(p) per channel (~1 file extension)

The first real predictive model. Reuse the AR machinery from
`solar-weather-forecast.js`.

**Key insight**: don't fit per-cell AR — 24 samples is too few. Fit
**one AR(3) per channel, pooled across all 2592 cells**. Each cell
contributes 24 samples, giving ~62 K samples per channel — plenty
for stable coefficients.

Per-cell forecasting then applies the global AR coefficients to
each cell's 24-sample tail.

Extend `js/weather-forecast.js`:
```js
import { fitAR, forecastAR } from './solar-weather-forecast.js';

forecastAR_pooled() {
    const frames = this._history.all();
    if (frames.length < 6) return null;  // need samples
    const { gridW, gridH } = frames[frames.length - 1];
    const N = gridW * gridH;

    const ar = {};
    for (let ch = 0; ch < NUM_COARSE_CHANNELS; ch++) {
        // Pool: concatenate every cell's 24-sample series into one
        // long vector for fitting. Cells are stationary in space but
        // not in mean — demean per-cell before pooling.
        const pooled = new Float32Array(frames.length * N);
        const cellMean = new Float32Array(N);
        // ... compute cell means, demean, pack ...
        const model = fitAR(Array.from(pooled), 3);

        // Apply per-cell: for each cell, take its tail, run forecastAR
        // re-add cell mean.
        ar[CHANNELS[ch]] = {};
        for (const h of FORECAST_HORIZONS_H) {
            ar[CHANNELS[ch]][h] = new Float32Array(N);
            for (let k = 0; k < N; k++) {
                const tail = /* extract cell k's 24-sample history */;
                const fc = forecastAR(model, tail, h);
                ar[CHANNELS[ch]][h][k] = fc.mean[h - 1] + cellMean[k];
            }
        }
    }
    // ...
}
```

**Blend with persistence** at horizon-decaying weights (mirrors
`temp-forecast.js:295`):
- 1 h: 80% AR, 20% persistence
- 3 h: 60% AR, 40% persistence
- 6 h: 40% AR, 60% persistence
- 12 h: 25% AR, 75% persistence
- 24 h: 10% AR, 90% persistence

The validator scores both AR-blend and persistence; the headline
number is the skill delta.

### Phase 3 — Advective nowcasting (~1 file)

Where we earn "watch the storm move into LA's future." Captures
spatial motion that AR can't.

**New file: `js/weather-flow.js`**

Compute a 2D velocity field on the coarse grid from consecutive
frames using either:
- **Lucas-Kanade optical flow** (per pixel — accurate, ~100 ms for
  2592 cells)
- **Simple cross-correlation** (per patch — faster, less accurate)

Forecast = displace current frame by `velocity × horizon`. Bilinear
sample at the displaced coordinates.

Particularly strong for moving features (fronts, low-pressure
systems) where AR/persistence struggle. Combine with the AR-blend:
take cell-wise max of (AR forecast, advection forecast) — or
weighted blend by horizon (advection wins at short horizons,
AR/persistence at long ones).

### Phase 4 — Server-trained NN model (stretch)

Only worth doing if Phase 2-3 hit a skill ceiling. Substantial work.

**Server side:**
1. Bump `weather_grid_cache` retention from 72 → 720 rows (30 days).
   Edit `supabase-weather-cache-migration.sql`.
2. Python training pipeline — read history, train UNet or ConvLSTM
   for next-frame prediction.
3. Export weights to `/data/weather-model-v1.json` (TF.js layers
   format) or ONNX.

**Client side:**
1. Add TF.js (~500 KB) or ONNX Runtime Web (~1 MB).
2. Cache weights in IDB after first fetch.
3. Run inference per page load, score with the Phase 1 validator.

Allocate 2-3 sessions for this work alone.

---

## UI extensions (any phase)

**Slider future range**: change `<input type="range">` in
`earth.html`:
```html
<input type="range" id="tc-scrub" min="-1440" max="360" step="1"
       value="0">
```
- `[-1440, 0]`: replay (history)
- `[0, +360]`: forecast (6 h ahead)

Style positive range distinctly so users know they're seeing
predictions:
```css
#tc-scrub::-webkit-slider-runnable-track {
    background: linear-gradient(to right,
        var(--past-color) 0%,
        var(--past-color) 80%,    /* up to thumb at value=0 */
        var(--future-dashed) 80%, /* dashed past 0 */
        var(--future-dashed) 100%);
}
```

Resolver should render forecast frames using the same `_decodeCoarse`
path — that's why Phase 1's persistence outputs are coarse-format
arrays.

---

## Hand-off notes

1. **Forecast outputs flow through the same decode pipeline as
   observations.** Don't duplicate `_decodeCoarse`. The resolver
   can render forecasts identically to historical frames if they're
   in the same shape.
2. **Pool training across cells.** 24 samples per cell is too few
   for any per-cell model. Pooling across the 2592 cells gives
   ~62 K samples per channel — stable.
3. **Validator first, model second.** Without skill scoring you
   can't tell good ML from bad ML. Phase 1 must land before Phase 2.
4. **Single source of truth for time:** `simTimeMs`. Forecast frames
   are addressed by `target_ms = issued_ms + horizon × 3600e3`.
5. **Server retention is the bottleneck for serious ML.** Phase 4
   needs the migration bump first.

---

## Recommended next-session order

1. Write `js/weather-forecast.js` (Phase 1 forecaster, persistence
   only).
2. Write `js/weather-forecast-validation.js` (Welford-based scoring).
3. Wire both in `earth.html`. Add SW-panel skill table.
4. Verify validator populates with hand-computed numbers.
5. If context permits in the same session: extend
   `js/weather-forecast.js` with `forecastAR_pooled()` (Phase 2).

Phases 3 and 4 are separate sessions due to new dependencies.

---

## Blockers / known limitations

- **Server-side history retention is 72 h.** Phase 4 needs ≥ 30 days.
  See `supabase-weather-cache-migration.sql:38-48`.
- **In-browser training is unstable on 24 samples per cell.** Phase 2
  pools across cells to compensate.
- **No Python training pipeline exists.** Phase 4 starts from scratch
  on that.
- **WindParticles + IsobarLayer** subscribe to `weather-update`. The
  resolver already feeds them historical frames; forecast frames
  flow through the same path so the visual feedback "just works"
  for free — but verify on the first Phase 1 ship.
