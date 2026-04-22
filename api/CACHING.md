# API caching policy

How every endpoint under `/api/` decides its `Cache-Control` values. Read
this before adding a new endpoint or touching a TTL.

Scope: this doc is about EDGE cache semantics (Vercel's CDN) — the layer
that sits between browsers and our Edge functions. Browser-side caching
is governed by separate client-side code.

## tl;dr

| Tier        | s-maxage | SWR  | Used by                                |
| ----------- | -------- | ---- | -------------------------------------- |
| T1 realtime | 60 s     | 30 s | solar-wind, Kp 1-min, X-ray flux       |
| T2 nowcast  | 300 s    | 60 s | NOAA alerts, DST, aurora, electrons, protons |
| T3 event    | 900 s    | 120 s | DONKI CME/FLR/GST/SEP/notify, flares, regions, launches, weather forecast |
| NWS alerts  | 180 s    | 120 s | nws/convective                         |
| daily       | 3600 s   | 1800 s | F10.7 radio flux                      |
| archive     | 86400 s  | 43200 s | weather/forecast type=archive         |
| error       | 60 s     | —    | all upstream errors                    |
| rate-limit  | 120 s    | —    | Open-Meteo 429                         |

All values set via `api/_lib/responses.js` helpers. Individual endpoints
declare their own `CACHE_TTL` + `CACHE_SWR` constants and pass them
through `jsonOk(..., { maxAge, swr })`.

## Why these values

We chose each TTL to match the upstream's refresh cadence **minus** a
small margin. The guiding rule: **cache at least one refresh window** so
every model turnover is captured, but no longer, so stale data doesn't
mask real changes.

Examples:

- **T1 realtime (60s)** — NOAA publishes 1-minute files. Cache 60s +
  SWR 30s → every reload either gets a fresh copy or a copy at most
  ~90s old while a background refresh runs. That's the tightest loop
  that's actually worth caching; anything shorter costs more in edge
  round-trips than it saves upstream.

- **T3 event (900s)** — 15 min matches Open-Meteo's GFS model-turnover
  cadence. SWR 120s gives upstream time to finish a slow refresh
  without every tab hitting the cold path simultaneously.

- **NWS alerts (180s)** — NWS itself publishes new alerts within 1–2
  minutes of issuance. 3 min caps the worst-case delay between a
  Tornado Warning going live and our users seeing it.

- **archive (24 h)** — Open-Meteo's historical reanalysis data for any
  date >30 days old doesn't change until the next reanalysis release
  (months later). 24h is just a convenience number; we could go to
  7 days safely.

- **error (60s)** — long enough to protect a struggling upstream from
  retry storms, short enough that recovery is visible within one
  page reload. Open-Meteo 429s get 120s specifically because their
  rate-limit windows are ~1 minute.

## Stale-while-revalidate

Every success response sets `stale-while-revalidate` alongside
`s-maxage`. This is critical for our failure model:

- User hits endpoint at T=0. Edge cache is fresh. Fast response.
- Cache expires at T=15min. User hits endpoint at T=15min+1s.
- Edge serves the **stale** cached copy immediately (~20ms) while
  firing a background refresh against upstream.
- Next user (or same user's next request) gets the fresh copy.

Net effect: no user ever waits for Open-Meteo's round-trip under normal
load. The ONLY cold-cache path is an endpoint that has never been hit
within the current edge POP, which the cron pre-warm eliminates for the
launch-planner flow.

## Pre-warming

`/api/cron/warm-forecasts` runs every 10 min (vercel.json `crons`).
It fetches the upcoming-launches list, derives unique pad coords, and
fires batched GETs against `/api/weather/forecast?type=launch&...` for
each pad, plus one GET against `/api/nws/convective`.

The 10-min cadence is 5 min shorter than the 15-min forecast cache TTL,
which means the cache is refreshed BEFORE it expires — so real users
never hit a cold cache for the hot-path pads.

Gotcha: the cron does a **self-fetch** against the site's public URL
(VERCEL_URL for preview, parkersphysics.com for prod). This is
deliberate — it routes through the CDN and populates the edge cache.
A direct handler invocation would warm Open-Meteo but leave our own
edge cold.

## Adding a new endpoint

When you add an endpoint under `/api/`, follow this checklist:

1. **Choose a tier** from the table above. If the upstream refreshes at
   a cadence not in the table, pick a TTL that's half the refresh
   period (Nyquist-ish rule of thumb).

2. **Use the shared helpers**. Import from `api/_lib/responses.js`:
   - `jsonOk(body, { maxAge, swr })` for successes
   - `jsonError(code, detail, { status, maxAge, source })` for failures
   - `fetchWithTimeout(url, { timeoutMs, headers })` for upstream calls
     — default 10s timeout is usually right; tighten for fast upstreams.

3. **Register in dev-server.mjs**. Add your path → file mapping to
   `API_ROUTES` so local testing works.

4. **Error-cache briefly**. Default 60s via `jsonError` — don't set
   longer unless the upstream has documented backoff requirements.

5. **CORS**. Add a headers block to `vercel.json` for the new path
   prefix. The `/api/weather/*` and `/api/nws/*` entries are templates.

6. **Don't cache POST or auth'd endpoints**. `jsonOk` is only for
   read-only public data. Auth'd endpoints (invites, stripe, alert
   email send) use their own no-cache response builders.

## Quantized coordinates

For endpoints that take `lat`/`lon`, quantize to 3 decimal places
(~110m) on both the client and server. Open-Meteo's coarsest model
grid is ~11 km, so 3dp is finer than any model difference. Coarser
quantization means more callers share a cache entry, which is the
single biggest cache-hit lever.

Precedent: `/api/weather/forecast` does this. See
`api/weather/forecast.js` → `COORD_DECIMALS = 3`.

## Known tension: cache vs freshness

There's an inherent trade-off between cache dedup (many users share
one upstream call) and freshness (every user sees the latest model
run). Our bias is toward dedup because:

- The launch planner shows 30–50 pads per pageview; undeduped
  traffic scales linearly with visitors and destroyed Open-Meteo's
  free-tier rate limit.
- Model refresh cadence (hourly for GFS) is already coarser than
  any reasonable cache TTL, so serving a 15-min-old forecast is
  effectively the same as serving a 0-min-old one except at the
  minute the hourly run drops.

If a specific endpoint needs sub-minute freshness (e.g. live solar
wind during a G4 storm), it belongs in Tier 1 with a 60s TTL, not in
Tier 3.
