# Weather Predictive Analytics — Phase 1+ Implementation Plan

Branch: `claude/plan-weather-prediction-MCF0J`

This is the implementation-ready brief for the next build phase. It extends
the work already shipped in `WEATHER_FORECAST_PLAN.md`,
`EARTH_LOD_NASA_PRECIP_PLAN.md`, and `EARTH_ML_FIRST_PRINCIPLES.md` with a
concrete sequenced rollout. No code in this doc — paths, schemas, signatures,
and ordering only.

---

## 1. Goals

Expose the predictive-analytics work already living in the backend to users
through the Earth simulator UI, while laying the foundation (cold storage +
forecaster registry) for the ML / analog / NN tracks that come later. Track
choices locked with the user:

1. **Cold storage:** Cloudflare R2 (zero egress, S3-compatible).
2. **Anonymous gating on Probability Picker:** *soft* — at 5 min new queries
   freeze, the last result stays visible, sign-in is a banner not a modal.
3. **No LLM query parser in Phase 1.** Picker is structured input only.
4. **Storage strategy:** tiered (hot Supabase 7 d hourly + warm Supabase 30 d
   6-hourly + R2 cold 90 d hourly) instead of a flat retention bump.

---

## 2. Current state (1-paragraph reference)

Backend is mature: 8 weather proxy endpoints (`api/weather/*`), a Rust WASM
5-member ensemble blender (`rust-forecast/`) emitting P10/P50/P90 quantiles
across 11 surface fields at hourly resolution, polar-vortex extractor +
NOAA AO/NAO teleconnections + surface-outlook regime classifier, NASA IMERG
inverter, precip climatology + AR(3) blender. Supabase ring buffers cover
weather grid (72 h), polar vortex (30 d, ~180 MB), solar wind (7 d).
UI exposes layers and a `[-1440, 0]` min replay slider; the forecast half is
unwired. Phase 3 optical-flow nowcaster, accumulator, NN, analogs not yet
built.

---

## 3. Phase 1 scope (this build)

Five workstreams that can land in any order; each ships independently.

### 3.1 — Forecast time slider (A1)

**Files touched:**
- `earth.html` — extend `#tc-scrub` range from `[-1440, 0]` to `[-1440, +360]` min.
- `js/weather-frame-resolver.js` — accept positive offsets; when `simTimeMs >
  now`, pull from forecast cache instead of history ring.
- `js/weather-forecast.js` — expose `getForecastFrame(t) → CHW Float32` for
  the resolver, sourced from the Rust blender's hourly output already
  computed.

**Behavior:**
- Past scrub: existing behavior (history ring lerp).
- Future scrub: lerp between the two bracketing hourly forecast frames.
- Visual marker on slider at `t=0` separating past/future (subtle vertical
  rule).

**Out of scope:** beyond +6 h. The Rust blender's 24 h horizon exists but the
useful UI window is +6 h; later phases extend.

---

### 3.2 — Skill leaderboard endpoint (A4)

**New endpoint:** `GET /api/weather/skill`

Query params:
- `lat` (required, float)
- `lon` (required, float)
- `field` (required, one of the 11 blender fields)
- `window` (optional, hours back; default 168 = 7 d)

Response:
```
{
  cell: { lat, lon, gx, gy },
  field: "temperature_2m",
  window_hours: 168,
  reference: "persistence",
  members: [
    { model_id: "AR1", n: 142, mae: 1.83, rmse: 2.41, bias: -0.12, skill: 0.18, beat_ref_pct: 0.73 },
    { model_id: "DIURNAL", ... },
    { model_id: "NWP_BC", ... },
    ...
  ],
  blender: { mae: 1.61, rmse: 2.12, skill: 0.27 },
  computed_at: "2026-05-12T..."
}
```

**Data source:** `forecast_log` (Phase 1 D1 table — see §3.5). Until that
table has data, the endpoint can fall back to reading the browser's
`weather-forecast-validation.js` Welford state via a `POST` from the client,
or simply return `n: 0` per member until accumulator data is sufficient.

**UI:** new collapsible "Models" panel in the existing SW strip. Single row
per member with a sparkline of last-N skill scores. Marketing copy: "Our
AR1 has beaten persistence 73 % of the past 7 days at this cell."

---

### 3.3 — Probability-of-Exceedance Picker (B1)

The marquee Phase 1 feature.

#### 3.3.1 New endpoint: `POST /api/weather/probability`

Body:
```
{
  lat: 40.0, lon: -105.3,
  field: "temperature_2m",          // any of the 11 blended fields
  op: "lt" | "gt" | "lte" | "gte",
  threshold: 32,
  units: "F" | "C" | "mm" | "mph" | "hPa" | "%",
  window: { start_offset_h: 48, end_offset_h: 96 },  // relative to now
  distribution_hint: "auto" | "normal" | "lognormal"  // auto picks lognormal for precip/wind, normal else
}
```

Response:
```
{
  probability: 0.234,
  by_member: [
    { model_id: "GFS",    probability: 0.31, weight: 0.22 },
    { model_id: "ECMWF",  probability: 0.18, weight: 0.28 },
    { model_id: "ICON",   probability: 0.22, weight: 0.18 },
    { model_id: "GEM",    probability: 0.25, weight: 0.14 },
    { model_id: "BLEND",  probability: 0.23, weight: 0.18 }
  ],
  ensemble_iqr: 0.13,                 // disagreement metric
  basis: {
    hours_evaluated: [48,49,...,96],
    distribution_fit: "lognormal",
    blender_quantiles_used: true
  },
  confidence: "moderate",              // derived from iqr + member agreement
  ttl_seconds: 600
}
```

**Compute path:**
- Server fetches `/api/weather/forecast?type=ensemble` for the cell (already
  edge-cached).
- For each hour in the window, fits the chosen distribution to the four
  members + their weights and integrates the tail above/below threshold.
- P(event in window) = `1 − Π(1 − P_h)` (independence assumption — flagged
  in basis).

**Caching:** edge `s-maxage=600, stale-while-revalidate=600`. Cache key
includes a rounded `(lat,lon,field,op,threshold,window)` tuple.

#### 3.3.2 Server-side anonymous rate-limit

**New helper:** `api/_lib/anonymous-rate-limit.js`

API:
```
checkAnonymousQuota(req, { feature, maxSeconds = 300, slidingWindow = true })
  → { allowed: bool, remaining_seconds: number, requires_signin: bool }
```

Storage: in-memory LRU on the edge function instance keyed by
`hash(ip + feature)`, with a Supabase fallback for distributed coordination
(`anonymous_session_quota` table, lightweight, RLS service-role only).

Signed-in users (presence of valid Supabase JWT) bypass entirely.

Response when over quota: HTTP 200 with `{ allowed: false, requires_signin:
true, last_result_id }` so the client can render the soft-freeze state.

#### 3.3.3 Client picker UI

**New file:** `js/probability-picker.js`

Mounted on the Earth page as a collapsible panel. Structured inputs:

| Control | Type | Notes |
|---|---|---|
| Field | dropdown | 11 blender fields; human-friendly labels |
| Operator | segmented | `<` `≤` `≥` `>` |
| Threshold | number + unit | unit chip auto-set by field |
| Window | preset chips | "next 6 h", "next 24 h", "this weekend", "next 7 d (limited)" + custom range |
| Location | uses cursor / saved-location | reuses existing `#rd-temp` hover machinery |
| Run | button | disables during request |

Output card:
- Big P(event) number.
- Sparkline of P per hour over the window.
- Per-member breakdown (collapsed by default).
- Confidence chip (re-uses B3 styling).
- "Why?" expander naming the dominant member(s).

#### 3.3.4 Client-side soft timer

**New file:** `js/anonymous-session-timer.js`

API:
```
new AnonymousSessionTimer({
  feature: "probability-picker",
  maxSeconds: 300,
  onTick: (remaining) => void,
  onSoftExpire: () => void,    // freeze new queries; keep result visible
})
```

Persistence: `localStorage` slot `pp_anon_timer__probability-picker` storing
`{ started_at, elapsed_seconds, expired }`. Survives reload. Reset on
sign-in event (listens to existing `auth.js` event bus).

UI:
- Countdown chip in panel header: "4:23 left — sign in for unlimited" with a
  subtle progress bar.
- On soft-expire: chip flips to a yellow banner "Sign in to run new
  probability queries". The last result + sparkline stay rendered. Run
  button disabled with tooltip.

**Soft-expire UX rationale:** keeps the user looking at a real, useful
result while introducing friction only on the *next* interaction — converts
better than a hard modal and is more honest.

---

### 3.4 — Confidence chip (B3)

**Files touched:**
- `js/weather-frame-resolver.js` — also compute per-cell ensemble IQR (`p90 −
  p10`) and expose alongside `p50`.
- `earth.html` — `#rd-temp`, `#rd-precip` hover badges gain a colored dot:
  green (IQR < 0.5σ of climatology) / yellow / red.

No new endpoint. Pure client compute over data already in the resolver.

---

### 3.5 — Accumulator (D1) — parallel track

#### 3.5.1 Supabase migration

**New file:** `supabase-forecast-accumulator-migration.sql`

Tables:

```
forecaster_registry (
  model_id      TEXT PRIMARY KEY,         -- "AR1", "DIURNAL", "NWP_BC", "GFS", ...
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,
  code_hash     TEXT,                     -- git sha or rust crate hash
  family        TEXT,                     -- "statistical" | "nwp" | "blend" | "ml"
  deployed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at    TIMESTAMPTZ,
  notes         TEXT
);

forecast_log (
  id            BIGSERIAL PRIMARY KEY,
  made_at       TIMESTAMPTZ NOT NULL,
  valid_at      TIMESTAMPTZ NOT NULL,
  lead_minutes  INTEGER GENERATED ALWAYS AS (EXTRACT(EPOCH FROM (valid_at - made_at))/60) STORED,
  lat           REAL NOT NULL,
  lon           REAL NOT NULL,
  field         TEXT NOT NULL,
  model_id      TEXT NOT NULL REFERENCES forecaster_registry(model_id),
  value         REAL,
  p10           REAL,
  p50           REAL,
  p90           REAL,
  sim_time_ms   BIGINT,
  archived      BOOLEAN NOT NULL DEFAULT FALSE,
  observation   REAL,                      -- backfilled by validator
  obs_at        TIMESTAMPTZ
);

CREATE INDEX forecast_log_valid_cell ON forecast_log(valid_at, lat, lon, field) WHERE archived = FALSE;
CREATE INDEX forecast_log_made       ON forecast_log(made_at, model_id);
CREATE INDEX forecast_log_unarchived ON forecast_log(made_at) WHERE archived = FALSE;

forecast_archive_pointer (
  day          DATE PRIMARY KEY,
  r2_key       TEXT NOT NULL,             -- "forecasts/2026/05/12.jsonl.gz"
  row_count    INTEGER NOT NULL,
  bytes        BIGINT NOT NULL,
  sha256       TEXT NOT NULL,
  written_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Functions:
- `trim_forecast_log()` — DELETE WHERE `archived = TRUE AND made_at < NOW() - INTERVAL '7 days'`.
- `register_forecaster(...)` — UPSERT into `forecaster_registry` with code_hash dedup.

RLS:
- `forecaster_registry`: SELECT public, INSERT/UPDATE service_role only.
- `forecast_log`: INSERT public (rate-limited), SELECT public for own + aggregates.
- `forecast_archive_pointer`: SELECT public, all writes service_role.

#### 3.5.2 Write endpoint

**New:** `POST /api/forecast/log`

Body: array (≤ 100) of forecast records matching `forecast_log` shape.
Anonymous-allowed; rate-limited to 1 req / 10 s / IP. Validates `model_id`
exists in registry. Returns `{ ingested: N, rejected: M }`.

#### 3.5.3 Read endpoint

**New:** `GET /api/forecast/replay`

Params: `from` ISO, `to` ISO, optional `field`, `model_id`, `bbox`.
Streams JSONL. Reads from `forecast_log` first; if window extends past 7 d,
streams gzipped JSONL directly from R2 using signed URLs.

#### 3.5.4 Archival cron

**New:** `api/cron/archive-forecasts.js`

Vercel cron `0 2 * * *` (daily 02:00 UTC).
1. Select rows with `made_at < NOW() - INTERVAL '7 days' AND archived = FALSE`.
2. Group by `made_at::date`.
3. For each day:
   - Stream rows to gzipped JSONL.
   - Upload to `r2://parker-physics-cold/forecasts/{yyyy}/{mm}/{dd}.jsonl.gz`.
   - Insert into `forecast_archive_pointer`.
   - Flip `archived=TRUE` on the rows.
4. Call `trim_forecast_log()`.

#### 3.5.5 Client hook

`js/weather-forecast-validation.js` — after each `summarize()` cycle, also
POST the predictions to `/api/forecast/log` (batched, fire-and-forget).
Throttled to one POST per 10 s.

---

### 3.6 — Tiered weather grid storage (replaces old A3 flat bump)

**Files:**

New migration `supabase-weather-cache-warm-migration.sql`:
```
weather_grid_cache_warm (same shape as weather_grid_cache, 6-hourly cadence, 30 d retention)
trim_weather_grid_cache_warm()  -- keep ≤ 120 rows
```

New cron `api/cron/archive-weather-grid.js` (daily 03:00 UTC):
1. Pull last 24 h of `weather_grid_cache` rows.
2. Insert one row into `weather_grid_cache_warm` per 6 h (decimated).
3. Stream the 24 raw rows to `r2://parker-physics-cold/weather-grid/{yyyy}/{mm}/{dd}.jsonl.gz`.
4. Existing `trim_weather_grid_cache()` already keeps `weather_grid_cache`
   at 72 h — no change needed.

Existing `/api/weather/grid` gets a new optional `?tier=hot|warm|cold` param;
default `hot`.

---

## 4. R2 wiring

**Bucket:** `parker-physics-cold` (private; access via signed URLs only).

**Layout:**
```
forecasts/{yyyy}/{mm}/{dd}.jsonl.gz       — daily forecast_log archives
weather-grid/{yyyy}/{mm}/{dd}.jsonl.gz    — daily decimated grid archives
README.txt                                — generated, lists schema versions
```

**Env vars** (Vercel project settings):
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET=parker-physics-cold`
- `R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com`

**SDK:** `aws4fetch` (smallest edge-compatible S3 signer; ~5 KB).

**Cost estimate:** at 90 d of hourly grid + forecast logs at ~95 KB/frame
compressed (gzip on top of JSONB → JSONL ~2–3× smaller) ≈ 2–3 GB cold
storage → $0.03–$0.05 / month at R2's $0.015/GB rate. Class B reads (signed
URL access) on replay are $0.36 / million — negligible at expected volume.

---

## 5. Phase 2 (next sprint after Phase 1)

### A2 — Optical-flow nowcast
Implement `js/weather-flow.js` (currently stubbed). Lucas-Kanade pyramidal
flow against the last 6 IMERG frames; emit 0–120 min advective forecast
overlay. New layer toggle `#lyr-nowcast` in `earth.html`.

### B2 — Composite indices
New file `js/composite-indices.js`. Computes (all from already-blended
fields, no new endpoint):
- Apparent temperature (Steadman 1979)
- Wind chill (NWS 2001)
- Fosberg Fire Weather Index
- Hot-Dry-Windy Index
- Frost risk (dew point < 0 °C ∧ T_min quantile)
- Lifted Index approximation from pressure-level data
UI: a single horizontal "Advisories" strip that lights up only when a
threshold is crossed; clicking expands to a breakdown.

### C3 — Renewables (promoted)
**New endpoint:** `GET /api/weather/renewables`

Inputs: `lat`, `lon`, optional `panel_tilt`, `panel_azimuth`, `wind_hub_height`
(default 80 m), `turbine_model` (default IEC Class II generic).

Outputs:
```
{
  solar: { ghi, dni, dhi, poa, ac_kw_per_m2, capacity_factor_24h },
  wind:  { hub_speed_m_s, power_kw_normalized, capacity_factor_24h, cut_state },
  hourly: [...]                  // 24 h hourly arrays
}
```

Compute: clear-sky model (Bird & Hulstrom 1981) × cloud transmittance
(Kasten–Czeplak), Hay-Davies transposition for POA. Wind: log shear from 10
m to hub height, generic v³ curve with cut-in 3 m/s / rated 12 m/s /
cut-out 25 m/s.

UI: paired gauge pair in the operations/satellite-operator panels; education
mode shows the curve overlay.

---

## 6. Phase 3+ (sequenced backlog)

| Phase | Item | Depends on |
|-------|------|-----------|
| 3 | C1 atmospheric river / IVT | none |
| 3 | C2 drought / SPI | tiered storage (3.6) |
| 4 | C4 sub-seasonal (MJO/ENSO) | none |
| 4 | C5 air quality / smoke | none |
| 5 | D2 analog forecasting | 30 d accumulator data |
| 6 | D3 NN residual correction | 30 d accumulator data |

---

## 7. PR sequencing

Each row is one PR. Independent unless noted.

| # | PR | Files | Notes |
|---|----|-------|-------|
| 1 | Accumulator schema + writer | `supabase-forecast-accumulator-migration.sql`, `api/forecast/log.js`, `api/_lib/r2-client.js` | Lands first so other PRs can write |
| 2 | Accumulator archive cron | `api/cron/archive-forecasts.js`, `vercel.json` cron entry | Depends on #1 |
| 3 | Skill leaderboard endpoint | `api/weather/skill.js` | Depends on #1 having data; ship with empty-state UI |
| 4 | Forecast time slider | `earth.html`, `js/weather-frame-resolver.js`, `js/weather-forecast.js` | Independent |
| 5 | Confidence chip | `earth.html`, `js/weather-frame-resolver.js` | Independent |
| 6 | Anonymous session timer | `js/anonymous-session-timer.js`, `api/_lib/anonymous-rate-limit.js`, `supabase-anonymous-quota-migration.sql` | Independent |
| 7 | Probability picker server | `api/weather/probability.js` | Depends on #6 |
| 8 | Probability picker UI | `js/probability-picker.js`, `earth.html` panel | Depends on #7 |
| 9 | Tiered weather grid | `supabase-weather-cache-warm-migration.sql`, `api/cron/archive-weather-grid.js`, `api/weather/grid.js` (tier param) | Independent |

Phase 2 PRs queue behind these.

---

## 8. Smoke-test checklist (per PR)

- Anonymous user can run picker, sees countdown chip, soft-freeze fires at
  exactly 5:00.
- Sign-in flow clears timer and unlocks Run button without page reload.
- Server returns `requires_signin: true` independent of client timer (curl
  test).
- Time slider future side renders a valid frame at `t = +120 min`.
- `/api/weather/skill` returns sane skill values for at least one populated
  cell after accumulator has 24 h of data.
- R2 archive cron creates a valid gzipped JSONL readable by `zcat` and
  `forecast_archive_pointer` row matches the file's sha256.
- Tiered grid: `?tier=warm` returns 6-hourly rows; `?tier=cold` returns
  signed URL or streamed JSONL.

---

## 9. Risks / open items

1. **`forecast_log` row volume** — at 2592 cells × 11 fields × 5 members ×
   24 hourly predictions / refresh × 1 refresh/h = 33.7 M rows/day if naive.
   *Mitigation:* log only a stratified sample of cells (every Nth) +
   per-blender summary; full granularity in R2 only. Decide stratification
   rate in PR #1.
2. **Edge in-memory quota for anonymous timer** — Vercel edge functions are
   per-region/per-instance. Use Supabase as the source of truth for
   distributed enforcement; in-memory only as fast-path.
3. **R2 signed URL TTL** — default 1 h; long replays may need re-signing.
   Document in `/api/forecast/replay` response.
4. **Privacy on `forecast_log`** — anonymous POSTs may include user location
   via lat/lon. Round to 0.5° before logging to avoid PII concerns. Document
   in `SECURITY.md`.
5. **Probability distribution fit quality** — lognormal for precip is a
   crude assumption; ship with that, log fit residuals in `basis`, swap for
   non-parametric tail integration in Phase 2 if residuals are bad.

---

## 10. What is *not* in this plan

- LLM-based query parser for the picker — deferred.
- Phase 3+ items (atm-river, drought, sub-seasonal, air quality, analogs, NN).
- Full Phase-0 "first principles" accumulator from
  `EARTH_ML_FIRST_PRINCIPLES.md` §3–5 (forecaster registry + log are the
  minimum subset; reservoir / symbolic / topological / IB / self-distillation
  forecasters are out of scope here).

---

## 11. Definition of done for Phase 1

- Time slider scrubs past *and* future on `earth.html`.
- Probability picker is live, free, with soft 5-min anonymous timer.
- Confidence chip lights up on hover badges.
- Accumulator schema deployed; at least one model writing to it; archive
  cron has produced at least one R2 file.
- `/api/weather/skill` returns non-empty results for a populated cell.
- Tiered storage cron has produced at least one warm row and one cold
  archive.
- No regressions on existing layers, slider past side, or auth flow.
