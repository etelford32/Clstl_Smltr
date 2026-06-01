# Far-Side Watch — architecture & runbook

> The nowcast→forecast jump. Parker's CME nowcast warns *hours* ahead;
> Far-Side Watch extends the horizon to *days-to-weeks* by detecting active
> regions on the **far side** of the Sun and forecasting their east-limb
> emergence. The product is not the map — it's the **measured warning
> horizon** (detection rate, lead time, false-alarm rate). That triplet is the
> SBIR pitch and the operator demo.

## Where it lives

| Layer | File(s) |
|-------|---------|
| Reusable physics + data package | `js/farside/` (importable barrel: `js/farside/index.js`) |
| Page controller | `js/farside-watch.js` |
| Page | `far-side-watch.html` (Space Weather dropdown, `id: far-side-watch`) |
| Edge proxy | `api/solar/farside.js` |
| Site feed registration | `js/config.js` → `FARSIDE` block |
| Nav entry | `js/nav.js` → Space Weather dropdown |

The `js/farside/` package is **DOM-free and feed-loop-free** by design, so the
Sun (`sun.html`) and Space-Weather (`space-weather.html`) engines can import the
same detection/tracking/ETA helpers and renderers later without copy-paste.

## The package (`js/farside/`)

- **`carrington.js`** — Carrington-frame geometry. `carringtonL0(date)` (Meeus
  ch. 29, ~0.1°), `emergenceETA(lonFeat, L0)`, `limbLongitudes(L0)`,
  `SYNODIC_DEG_PER_DAY = 13.199`. Pure, dependency-free.
- **`farside-config.js`** — sources, grid (1°×1°), detection thresholds, alert
  window, and the **validation cases** (AR13664 Gannon; late-May 2026).
- **`farside-feed.js`** — Phase 0/1 ingestion. Prefers a numeric grid from the
  proxy (`format=json`); falls back to a **labelled synthetic** field so the
  pipeline is demoable today. Planted regions are pinned in Carrington longitude
  (real regions don't move in the co-rotating frame), so emergence ETAs shrink
  honestly as time advances.
- **`farside-detect.js`** — Phase 2 classical baseline: threshold + connected
  components (longitude-wrapping). Stable `detectSignatures(map)` contract so the
  ML scorer (Felipe & Asensio Ramos style) drops in behind it later.
- **`farside-track.js`** — Phase 3: nearest-neighbour linking in Carrington
  (lon, lat), strength trend, transient rejection (≥2 frames), and the emergence
  forecast with a confidence band. `farSideWatchList(series)` is the product output.
- **`farside-alerts.js`** — Phase 4 "region rotating into view" trigger. Emits
  the shared `user-alert` window CustomEvent (no edit to `js/alert-engine.js`).
- **`farside-render.js`** — Canvas2D `renderFlatMap()` (Carrington image + limb
  markers + tracks) and `renderTopDown()` (rotation schematic, east-limb horizon).

## Data sources (honest priority order)

1. **GONG far-side** seismic holography — always available, 12-hourly, free,
   already fed to NOAA SWPC. The backbone.
2. **Solar Orbiter EUV** (ESA archive) — direct imaging, *geometry-gated*.
3. **STEREO-A SECCHI/EUVI** — direct imaging, *geometry-gated*.
4. **HMI/JSOC** seismic — alternate pipeline, cross-check GONG.

### Edge proxy + env overrides

`api/solar/farside.js` streams the upstream image (keeps rate limits + CORS off
the browser, exactly like `api/solar/aia.js`). Real archive URLs shift and may
need **network-policy allow-listing** before they resolve — each is overridable
without a code change:

```
FARSIDE_GONG_URL, FARSIDE_SOLO_URL, FARSIDE_STEREO_URL, FARSIDE_HMI_URL
```

`format=json` returns **501 today** — the FITS→grid numeric pipeline is the
Phase-1 ingestion job; until it ships, the browser uses its labelled synthetic
field rather than guessing numbers.

## Phase status

- **Phase 0 (spike)** ✅ — flat Carrington render + edge proxy.
- **Phase 2 (detection)** ✅ — classical baseline; ML is a drop-in follow-up.
- **Phase 3 (tracking + ETA)** ✅ — synodic projection, confidence band.
- **Phase 4 (product surface)** ✅ — page panel, rotation view, emergence alert,
  CSV export. Globe overlay on the Solar Physics Engine: import from
  `js/farside/index.js` (deferred).
- **Phase 1 (ingestion)** ⏳ — scheduled worker → Supabase raw-map archive +
  `format=json` server-side FITS parse. Slots beside the existing 12-feed
  architecture as the slowest (12 h) bucket.
- **Phase 5 (validation = the moat)** ⏳ — backtest harness over historical GONG
  maps vs. the NOAA emergence record. Report detection rate, median lead time,
  false-alarm rate against AR13664 (Gannon) and the late-May 2026 region.

## Gating

"Gated for sign-ups": the page is a public **PRO PREVIEW**. The map + the single
soonest emergence are visible to everyone; the full watch list, the emergence
alert, and CSV/REST export unlock on **sign-up** (`/signup.html?from=far-side-watch`).
Full historical/operator export is the **Advanced** tier (`planToTier → PRO`).

## Smoke test

The pure data path runs under Node (stub `globalThis.window`):
`carringtonL0` → `getMapSeries('gong')` → `detectSignatures` → `farSideWatchList`
→ `buildEmergenceAlerts`. Render functions need a browser (Canvas2D).
