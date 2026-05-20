# Weather LSTM offline trainer

Produces the pretrained per-channel weight files that ship as static
assets under `/js/`. v1 ships two channels:

| Channel | Input size | Output | Output file |
|---------|------------|--------|-------------|
| `temperature` | 8 | 1 (`T_norm`) | `js/weather-temperature-lstm-weights.json` |
| `wind` | 9 | 2 (`U_norm`, `V_norm`) | `js/weather-wind-lstm-weights.json` |

Per-channel config (variables to fetch, normalisation, feature layout,
output path) lives in [`channels.py`](./channels.py). Adding a third
channel — precipitation, surface pressure, cloud cover — is the same
shape: define a `ChannelConfig`, write a small `_extract_*` function
that returns the dynamic features + targets + normalisation dict, and
register it in the `CHANNELS` map. The data fetcher, window slicer,
train loop, and weight exporter are channel-agnostic.

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
# from the repo root — temperature
python -m scripts.train_weather_lstm.train \
    --start 2024-01-01 --end 2025-01-01 \
    --epochs 12

# wind (U, V) — same shape, different normalisation
python -m scripts.train_weather_lstm.train --channel wind \
    --start 2024-01-01 --end 2025-01-01 \
    --epochs 12
```

The first invocation per channel downloads the Open-Meteo archive
(~10–20 MB for temperature; ~20–40 MB for wind which needs both speed
and direction) and caches it under
`scripts/train_weather_lstm/.cache/archive-<channel>.npz`. Subsequent
runs reuse the cache. Pass `--cache /shared.npz` if you want one
cache file to serve multiple channels — `data.py` does a key-set
check and refetches only if a needed variable is missing.

The output file defaults to the channel's `output_path` from
`channels.py`; override with `--output some/other.json`.

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
| `metrics.val_mae_norm[<feature>]` | Per-output normalised MAE — one entry  |
|                           | per output dimension (1 for temperature, 2 for     |
|                           | wind), useful for spotting whether U or V is the   |
|                           | weaker component.                                  |
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

## Extending to precip / cloud / surface pressure

The wind channel is a worked example of the multi-output path. To
add another channel:

1. Define an `_extract_<name>` function in `channels.py` that returns
   `(dynamic_features, targets, norm_meta)` — all already normalised
   to roughly `[-1, 1]` or `[0, 1]`. For heavy-tailed channels (precip)
   apply `log1p(mm)` before normalising; the JS-side denormaliser
   inverts via `expm1`.
2. Build a `ChannelConfig`: list of `hourly_vars` to fetch from
   Open-Meteo, `output_size`, `feature_layout`, default `output_path`,
   physical-units `unit` and `physical_scale`. Register it in the
   `CHANNELS` map.
3. Run `python -m scripts.train_weather_lstm.train --channel <name>`.
   The data fetcher, window slicer, train loop, gate-remap exporter,
   and Murphy-skill metric all pick it up automatically.

For channels that benefit from a classification + intensity head
(precip is the canonical case — predict `P(rain > threshold)` for
threshold ∈ {0.1, 1, 5, 10 mm} alongside conditional intensity), use
`output_size = 5` and put the per-threshold class logits + intensity
in successive output slots. The exporter ships the full vector head
without needing changes.

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
