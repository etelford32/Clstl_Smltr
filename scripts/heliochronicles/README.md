# Heliochronicles snapshot pipeline

Build-time scripts that compile the `data/heliochronicles/` submodule into
compact static artifacts under `data/history/` that the ParkersPhysics browser
stack loads directly. No database, no Supabase — everything is a static file.

## Layout

```
data/heliochronicles/          # submodule (upstream)
  data/
    hourly/hourly_YYYY-YYYY.csv    NASA OMNI (populated by `npm run build`)
    daily/daily_YYYY-YYYY.csv      SILSO + GFZ + F10.7 + ISGI
    cycles/{solar_cycles,grand_minima}.json
    events/{historical_storms,aurora_observations}.json
    regions/notable_regions.json

data/history/                  # generated — outputs of this pipeline
  tier1-recent.json            last 30 d hourly, SolarWeatherHistory shape
  tier2-4yr.json               last 4 yr daily means, same shape
  archive-daily.bin            full daily record, Float64 t + Float32 fields
  archive-hourly/hourly_*.bin  per-decade hourly OMNI, Float64 t + Float32 fields
  index.json                   catalog with paths, counts, ranges, sha256
```

Catalog JSON (cycles, storms, aurora, regions) is **not** copied into
`data/history/`. `index.json` points at the in-tree submodule paths so
attribution stays with the source and bytes aren't duplicated.

## Usage

```bash
# 1) Populate upstream CSVs (network required: NASA SPDF, SILSO, GFZ, ISGI).
cd data/heliochronicles
npm run build

# 2) Compile into snapshots (no network).
cd ../..
npm run data:snapshots

# 3) Sanity-check the output.
npm run data:verify
```

Flags for `build-snapshots.mjs`:

| Flag              | Effect                                                       |
|-------------------|--------------------------------------------------------------|
| `--skip-archive`  | Skip bulky decade hourly + daily binaries; keep tier1/tier2  |
| `--input <dir>`   | Override source path (default `data/heliochronicles/data`)   |
| `--out <dir>`     | Override output path (default `data/history`)                |
| `--quiet`         | Suppress progress logs                                       |

## Graceful degradation

When upstream CSVs are empty (fresh checkout, no network for `npm run build`),
the pipeline still emits `data/history/index.json` with `populated:
"catalog_only"` and a manifest of the catalog JSON. Vercel builds stay green
and the browser falls back to `seedSyntheticHistory()` as before. Once CSVs
are populated and the script re-runs, `populated` flips to `"full"`.

## Output shapes

### Tier JSON (`tier1-recent.json`, `tier2-4yr.json`)

Array of packed records matching `SolarWeatherHistory._rings[*]` exactly:

```json
{ "t": 1713456000000, "v": 423, "bz": -3.1, "by": 0, "n": 5.2,
  "pdyn": 1.8, "kp": 3.0, "dst": -18, "epsilon": 12.4, "substorm": 0.134 }
```

Fields:

- `t`       ms since epoch (UTC, at the top of the hour or noon for daily)
- `v`       bulk wind speed (km/s, OMNI `v_sw`)
- `bz`      IMF Bz GSM (nT, OMNI `bz_gsm`)
- `by`      IMF By GSM (nT) — **placeholder 0**, OMNI2 subset omits By
- `n`       proton density (cm⁻³, OMNI `n_p`)
- `pdyn`    dynamic pressure (nPa, OMNI `pressure` or derived 0.5·ρ·v²)
- `kp`      planetary Kp (0–9, derived from ap via GFZ lookup)
- `dst`     Disturbance-storm-time index (nT, OMNI `dst`). For tier2 daily
            rows, this is the **minimum** (deepest) Dst seen that day — not
            the mean — because it reads as the storm signature downstream.
- `epsilon` Akasofu ε proxy (GW) using `b_total`+`bz` without `by`
- `substorm` AE/1000 clamped to [0,1]

Nulls pass through when OMNI flags a fill value. `solar-weather-history.js`
`packRecord` already nullish-coalesces to quiet-Sun defaults, so the live
pipeline is unaffected.

### Binary archives

Each record is laid out as:

```
offset  bytes  type       field
0       8      Float64LE  t_ms
8+4k    4      Float32LE  field[k]
```

Field order is recorded in `index.json`:

- `archive-daily.bin`: `[t_ms, ssn, kp_daily, ap, f107_obs, aa]` (stride 28)
- `archive-hourly/hourly_<decade>s.bin`:
  `[t_ms, v_sw, n_p, bz_gsm, b_total, pressure, dst, ap, ae]` (stride 40)

`NaN` marks null/missing. Decode with `DataView`:

```js
const view = new DataView(buf);
const stride = 40;
const n = buf.byteLength / stride;
for (let i = 0; i < n; i++) {
    const off = i * stride;
    const t   = view.getFloat64(off, true);
    const v   = view.getFloat32(off + 8, true);
    // ... etc
}
```

### `index.json`

Single catalog consumed by the future `history-loader.js`. Example:

```json
{
  "generated_at": "2026-04-21T...",
  "populated": "full",
  "upstream": { "submodule": "data/heliochronicles",
                "manifest": "../heliochronicles/data/MANIFEST.json" },
  "artifacts": {
    "catalog": [ { "id": "solar_cycles", "path": "...", "count": 25, ... }, ... ],
    "tier1_recent": { "path": "tier1-recent.json", "count": 720, ... },
    "tier2_4yr":    { "path": "tier2-4yr.json",    "count": 1461, ... },
    "archive_hourly": [ { "decade": 1960, "rows": 61488, ... }, ... ],
    "archive_daily":  { "rows": 75614, ... }
  }
}
```

## Provenance

- Hourly: NASA OMNI 2 merged dataset (SPDF).
- Daily: SILSO SSN (Royal Obs. Belgium), GFZ Kp/ap, DRAO F10.7 (via GFZ), ISGI aa.
- Catalogs: curated in heliochronicles with per-entry peer-reviewed citations.

Full provenance: `data/heliochronicles/SOURCES.md`.
