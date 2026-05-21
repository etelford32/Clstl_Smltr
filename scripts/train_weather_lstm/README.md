# Weather LSTM offline trainer

Produces the pretrained per-channel weight files that ship as static
assets under `/js/`. v1 covers `temperature_2m`; the package is
factored so adding U/V/precip is a matter of (a) swapping the feature
builder, (b) bumping the model's `output_size`, and (c) registering a
new channel name in `train.py`.

The browser-side loader pattern (`solar-lstm.js#loadPretrainedWeights`)
expects the exact JSON shape this exporter produces — see
[`export.py`](./export.py) for the gate-order remap from PyTorch's
`[i, f, g, o]` to the `[f, i, c, o]` convention `js/solar-lstm.js`
uses.

## Why a trainer at all

Today every weather forecaster in the page is classical:
ridge regression for temperature, AR(3) for precipitation, persistence
everywhere else. A pretrained LSTM gives us a fourth peer in the
`ForecastRegistry` — scored on the same Murphy-skill scorer — without
needing the user to wait for in-browser training to converge.
`solar-lstm.js` shipped 70 k pretrained steps for the same reason.

## Install

```bash
pip install -r scripts/train_weather_lstm/requirements.txt
```

Torch CPU wheels are ~200 MB. CUDA isn't required for v1 — training
on the default 10° grid × 12 months × 64 hidden takes ~10–20 min on a
modern laptop CPU.

> **Note on remote / cloud environments**: the trainer reaches out to
> `archive-api.open-meteo.com`. If you're running it in a sandboxed
> environment with an outbound allowlist (Claude Code on the web,
> some CI runners), add that host or pre-generate the cache locally
> and commit `scripts/train_weather_lstm/.cache/archive.npz` to LFS /
> a release artifact. The trainer is fully cache-driven once the
> `.npz` exists.

## Run

```bash
# from the repo root
python -m scripts.train_weather_lstm.train \
    --start 2024-01-01 --end 2025-01-01 \
    --epochs 12 \
    --output js/weather-temperature-lstm-weights.json
```

The first invocation downloads the Open-Meteo archive (~10–20 MB at
10° grid resolution) and caches it under
`scripts/train_weather_lstm/.cache/archive.npz`. Subsequent runs reuse
the cache; pass `--cache /tmp/other.npz` (or delete the file) to
force a refresh.

### Smoke run

To exercise the pipeline end-to-end in seconds rather than minutes:

```bash
python -m scripts.train_weather_lstm.train \
    --epochs 1 --max-windows 5000 \
    --output /tmp/weights.json
```

Useful in CI to verify the trainer still runs after a refactor without
burning the 12-month archive pull every time.

## Output

`js/weather-temperature-lstm-weights.json` is a git-committed asset.
Top-level keys:

| Key                       | Meaning                                            |
|---------------------------|----------------------------------------------------|
| `version`                 | Schema version. `1` matches `solar-lstm.js`.       |
| `channel`                 | `"temperature_2m"` for v1.                         |
| `inputSize` / `hiddenSize` / `outputSize` / `seqLen` | Architecture. |
| `featureLayout`           | Names of the 8 input features, in order.           |
| `normalization`           | Min/max used to map physical units to [0, 1].      |
| `metrics.val_mae_C`       | Held-out MAE in degrees Celsius.                   |
| `metrics.persistence_mae_C` | Naive "next hour = this hour" baseline MAE.     |
| `metrics.skill_vs_persistence_1h` | `1 − MAE_model / MAE_persistence`, the    |
|                           | Murphy skill score the in-page validator computes. |
| `metrics.n_train_windows` / `metrics.n_val_windows` | Sample counts. |
| `nTrained`                | Total SGD steps, matches solar-lstm's bookkeeping. |
| `trainedAt`               | ISO UTC timestamp of the train run.                |
| `trainingPeriod`          | `{start, end}` dates of the archive pull.          |
| `lstm.{Wf,Wi,Wc,Wo}`      | Gate weights, row-major `(hidden, input + hidden)`.|
| `lstm.{bf,bi,bc,bo}`      | Gate biases.                                       |
| `dense.{W, b}`            | Linear head — `W` is `(output, hidden)` row-major. |

## Pipeline overview

```
fetch_archive_grid()    -> 36×18 cells × 8760 hours of T (NaN where missing)
    │
    ▼
WindowDataset           -> (seq_len=72, features=8) windows, NaN-filtered
    │   features = [T_norm, sin/cos(hod), sin/cos(doy), sin/cos(lat), lon_norm]
    ▼
WeatherLSTM (PyTorch)   -> 1-layer LSTM(8→64) + Linear(64→1), Huber loss
    │
    ▼
export_weights()        -> JSON in the solar-lstm.js shape, including
                           Murphy skill vs the persistence baseline
```

## Reliability notes

* The data fetcher already retries on 429 / 5xx with exponential
  backoff, honours `Retry-After`, and fails fast on 4xx
  (bad coordinate / date format) so a malformed CLI flag doesn't
  silently burn the Open-Meteo daily quota.
* Coverage report (`[data] coverage: …`) flags cells with >5 % NaNs
  — historically a sign Open-Meteo masked an ocean cell or the
  date range straddled a data-availability boundary.
* `--max-windows` deterministically subsamples (seeded) so the CI
  smoke run produces a reproducible subset of windows.

## Extending to U/V/precip

1. Pull `wind_speed_10m,wind_direction_10m,precipitation` alongside
   `temperature_2m` in `data.py`. Decompose wind to U/V at fetch time
   to keep the trainer channel-agnostic.
2. Adjust `T_MIN_C`/`T_MAX_C` to per-channel physical bounds (e.g. wind
   `|v| ≤ 60 m/s`, precip `log1p(mm)` to compress the heavy tail).
3. Bump `ModelSpec.output_size` if a channel benefits from multi-output
   (e.g. precip as `[P(rain), intensity_log_mm]` per the earlier design
   review).
4. Write one weights file per channel — `weather-{channel}-lstm-weights.json`.
   The browser registry pattern is one forecaster per file.

## What's intentionally not here

* No in-trainer hyperparameter sweep — the next iteration adds a grid
  over `hidden ∈ {32, 64, 128}`, `seq ∈ {24, 48, 72}`, and reports the
  Pareto front. Out of scope for v1's "smallest blast radius" remit.
* No ensemble blending — the LSTM is just one peer in the registry,
  weighted by its rolling Murphy skill at the orchestration layer
  (separate work).
* No ERA5 native ingest — Open-Meteo's `/v1/archive` already serves
  ERA5 reanalysis under the hood (no credentials, no rate-limit dance).
  A direct Copernicus CDS hook would only matter if we needed
  variables ERA5 has but Open-Meteo doesn't surface.
