# Mars data pipelines

mars.html reads from five sources. Each has an explicit degradation path, and
the page always states which one produced what is on screen — see
`__marsLab.feedState()` (and `__marsLab.tileState()` for the imagery) for the
machine-readable version.

| Feed | Route | Live source | Falls back to |
|------|-------|-------------|---------------|
| Traverse / rover position | `/api/mars/route` | NASA MMGIS waypoints | bundled `perseverance-route.json` |
| Mars geometry + season | `/api/mars/ephemeris` | JPL Horizons | analytic model in `js/mars-mission-state.js` |
| Surface weather | `/api/mars/weather` | NASA MEDA / REMS / InSight | bundled MEDA snapshot (sol 1133) |
| Sky directions | `/api/horizons` | JPL Horizons topocentric | nothing — bodies report unavailable |
| Surface imagery tiles | `/api/mars/tiles` | NASA Solar System Treks WMTS | bundled 1440×720 Viking texture |

## What "real-time" means on this page

**No spacecraft images Mars continuously.** There is no live surface feed and
there will not be one, so the page splits the claim in two and states both
halves wherever imagery is drawn:

- **The map is archival.** Every mosaic in the tile stack carries an epoch and
  a native resolution — Viking MDIM 2.1 (1976–80, 232 m/px), THEMIS day IR
  (2002–11, 100 m/px), CTX (2006–22, ~5 m/px), MOLA colour relief (1997–2001,
  463 m/px). The layer row prints them.
- **The view is live.** Rotation, sub-solar point, terminator, local mean solar
  time, season and Earth range come from `/api/mars/ephemeris` (JPL Horizons)
  and move in real time over that archival map.

Anything that claims a *current* observation of the surface is a bug. If a
genuinely live imagery product is ever adopted (MARCI daily global maps are the
realistic candidate), it is a FEED and belongs in the table above with a
freshness contract — not in the archival tile catalogue.

**Freshness reality check.** Of these, only the Horizons feeds are dependably
current. The NASA rover daily-summary endpoints under `mars.nasa.gov/rss/api/`
have been intermittent-to-frozen since 2024, which is why the bundled MEDA
snapshot exists and why `/api/mars/weather` now returns a per-upstream
`sources[]` roll-up: when the page says "no observation", it can name which
endpoint failed and why instead of shrugging.

## Monitoring

All three Mars routes are registered in `js/pipeline-registry.js` under the
`planetary` category, which is what puts them on **`/status.html`** (Proxy
Freshness card) and into the **medium** pre-warm tier
(`api/cron/prewarm-medium.js`, every 30 min). `node tests/pipeline-registry.mjs`
gates the registration.

| Registry id | Endpoint | Green means | Amber means |
|-------------|----------|-------------|-------------|
| `mars-ephemeris` | `/api/mars/ephemeris` | JPL Horizons answered | fell back to the analytic Ls model |
| `mars-route` | `/api/mars/route` | live MMGIS traverse | serving the bundled route snapshot |
| `mars-weather` | `/api/mars/weather` | a rover returned a usable observation | every NASA rover feed is offline |
| `mars-tiles` | `/api/mars/tiles` | every catalogued mosaic answered | at least one layer is unreachable; the page falls back to the bundled texture for it |

**These routes never return 5xx.** Each has a working client-side fallback, and
a 5xx would be indistinguishable from "the site is down" to a client whose
fallback is a static file. They signal degradation with a top-level
`freshness: 'stale'`, which `status.html`'s `_rtProxyHealth()` already scores as
amber. **If you remove that field, a dead NASA feed renders green.**

**`mars-weather` is expected to sit amber.** That is not an alert to chase — it
is the frozen-upstream state described above, and the page says so in its own
provenance line. `mars-ephemeris` going amber is worth investigating; it means
JPL Horizons is unreachable, and the terminator has silently dropped to a model
that can be ~11° of Ls wrong.

Upstream reachability from the Vercel edge is separately pinged by
`/api/health` (`mars-mmgis`, `mars-rss`, `jpl-horizons`). Those rows are
`edge_authoritative` because all three are proxied server-side.

## Surface imagery tiles (`/api/mars/tiles`)

Everything on the page used to sample ONE 1440×720 global texture — 4 px/°,
≈14.8 km/px. The 520 km regional patch spans ~37 of those texels, which is why
landing the surface explorer rendered a smooth wash and why `js/terrain-wfc.js`
had to synthesize over the gap. This route streams the real mosaics instead:
NASA's Solar System Treks publish them as WMTS pyramids, taking the ground
sample distance under the camera to 232 m/px, 100 m/px or ~5 m/px.

Two forms, split on whether a tile coordinate is present:

```sh
curl -s https://parkersphysics.com/api/mars/tiles | jq '.resolved, .unreachable'
curl -s 'https://parkersphysics.com/api/mars/tiles?layer=imagery&z=3&x=5&y=2' -o tile.jpg
```

**The layer identifiers are UNVERIFIED.** Egress to trek.nasa.gov was blocked
by policy when this shipped, so each logical layer resolves from an ordered
CANDIDATE LIST in `js/mars-tiles.js` and the route reports which one answered —
the same pattern as `api/_lib/noaa-regions.js`. **One production request against
the capability form settles the schema; record the winners in
`assets/mars/SOURCES.md` and only then trim the candidate lists.**

Three things about this route are deliberate:

1. **Browser-direct first, proxy second.** `js/mars-tile-inset.js` fetches each
   tile straight from the upstream and only falls back to this route. A descent
   pulls tens of tiles and routing all of them through a serverless function
   would be pure waste. CORS is *required*, not merely nice: WebGL refuses to
   upload a tainted canvas, so a non-CORS tile breaks the whole stitched inset.
2. **Tile failures pass the upstream status through unchanged.** A 404 is a real
   coverage hole in the CTX mosaic (draw the base map and move on); a 5xx is an
   outage. Flattening both to one status erases a distinction the client uses.
3. **No passthrough URL parameter, ever.** The client names a layer and a
   z/row/col; the URL is rebuilt from the frozen catalogue. Adding a URL
   parameter would turn a public endpoint into an open proxy —
   `tests/mars-tiles-route.mjs` gates that.

Below the deepest published level the plan sets `upsampled` and the page says
"beyond native resolution" rather than quietly interpolating. At whole-globe
framing no inset is fetched at all (`MIN_INSET_GAIN`): the pyramid there
resolves no better than the texture already on the sphere, and dozens of round
trips for an invisible difference is not a feature.

The client's own view of which tier won is `window.__marsLab.feedState()`.

# Perseverance route snapshot

`perseverance-route.json` is the OFFLINE FALLBACK for `/api/mars/route`, not
the primary source. It is a compact normalization of NASA/JPL's public
MMGIS rover-waypoint GeoJSON:

- Source: https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json
- Human-facing map: https://mars.nasa.gov/maps/location/?mission=M20&site=NOW
- Snapshot checked: 2026-08-05
- Coverage: 690 localization stops through sol 1940; 44.14 km total

The source endpoint is the same dataset used by NASA's “Where is
Perseverance?” map. Each retained point contains the sol, Rover Motion
Counter site/drive IDs, planetocentric east-positive coordinate, elevation,
and published cumulative distance. NASA uses a zero odometer for some
mid-drive localization records; the normalizer writes those values as `null`
so the interface cannot misrepresent them as a return to the landing site.

The normalization rules live in `js/mars-route-normalize.js` and are shared by
the baker below and by `api/mars/route.js`, which serves the identical shape
live. Keep them shared: if the two ever diverged, the globe would draw a
different traverse depending on whether NASA's endpoint happened to be up.
`node tests/mars-route-normalize.mjs` pins that parity against this file.

Rebuild with:

```sh
node scripts/build-mars-route-snapshot.mjs M20_waypoints.json data/mars/perseverance-route.json YYYY-MM-DD
# or fetch MMGIS directly:
node scripts/build-mars-route-snapshot.mjs --fetch data/mars/perseverance-route.json
```

## Mars geometry (`/api/mars/ephemeris`)

Areocentric solar longitude (Ls), the sub-solar and sub-Earth points,
Earth–Mars range, one-way light time, solar elongation, phase angle, and
apparent diameter — one JPL Horizons observer query per 15-minute cache window:

- Target / center: `499` seen from `500@399` (Earth geocenter)
- Quantities: `13,14,15,20,21,23,24,44` (44 is apparent solar longitude, L_s)
- Source: https://ssd.jpl.nasa.gov/horizons/

**Why this route exists.** Everything seasonal on the page previously came from
`marsSolarLongitudeFromJulianDate` — a linear mean-motion model. Mars' orbit has
e ≈ 0.0934, so a constant-rate Ls runs up to ~11° from the true value near the
solstices, and that error lands directly on the terminator and on any
dust-season call. The response carries BOTH the Horizons value and the analytic
one, plus `ls_model_delta_deg` between them, so the page can show the gap rather
than quietly picking a number.

Two conventions are converted once, in `js/mars-ephemeris.js`, and must not be
re-derived elsewhere: Horizons sub-longitudes are **west-positive** (Mars is a
prograde rotator) while this repo is east-positive, and Horizons sub-latitudes
are **planetodetic** while the globe is planetocentric. The inverse of
`marsPlanetocentricToGeodetic` in `js/horizons.js` is duplicated there rather
than imported, only to keep VSOP87 out of the edge bundle —
`tests/mars-ephemeris.mjs` imports both and pins the round-trip to 1e-12.

## Mars sky ephemeris

Sun, Earth, Moon, Ceres, and Vesta directions are not bundled snapshots. The
page calls the existing `/api/horizons` proxy through `js/horizons.js` and
requests JPL Horizons airless apparent azimuth/elevation (observer quantities
4 and 20) from a user-defined site on Mars:

- Center: `coord@499`
- Commands: `10`, `399`, `301`, `1;`, `4;`
- Frame/site model: `IAU_MARS`
- Samples: the UTC hour bracketing the current time, interpolated in-browser
- Source: https://ssd.jpl.nasa.gov/horizons/

NASA MMGIS provides planetocentric, east-positive rover coordinates. Horizons
expects geodetic latitude and west-positive Mars longitude, so the shared
adapter converts latitude on the IAU_MARS reference ellipsoid and reverses the
longitude sign before constructing `SITE_COORD`. Failed requests never produce
a synthetic sky position; the layer reports the affected body as unavailable.

## Surface climate field (`js/mars-atmosphere-model.js`)

**This one is not a feed.** The "Surface climate field" layer is MODELLED, and
the page says so on the layer row, in the provenance note under the controls,
and in `MARS_CLIMATE_MODEL.summary`. It is here because it is the only thing on
mars.html that renders numbers no instrument produced, and that deserves the
same accounting as a feed.

What it is: a 1-D surface energy balance (thermal-inertia diurnal wave over a
hydrostatic CO₂ column) evaluated per point from latitude, MOLA elevation, Ls,
local true solar time, albedo and thermal inertia. It is **not** a GCM — no
dynamics, no advection, no water cycle, and therefore **no winds**.

| Input | Comes from | Degrades to |
|-------|-----------|-------------|
| Season (Ls) | `/api/mars/ephemeris` (JPL Horizons) | the analytic Ls model, ~11° worse near solstice |
| Elevation | the bundled MOLA raster, same sampler the relief uses | 0 m, i.e. datum pressure everywhere |
| Albedo → thermal inertia | luminance measured off the bundled Viking mosaic | a stated uniform albedo, disclosed in the provenance line |
| Dust opacity τ | seasonal climatology in the kernel | — (it has no live source; see below) |

**Two known gaps, both deliberate and both disclosed on the page:**

1. **Thermal inertia is a proxy, not a measurement.** It is derived from
   basemap albedo through the MGS-TES albedo/inertia anti-correlation. The real
   fix is to bundle the TES global thermal-inertia raster (8 px/°, PDS / USGS
   Astrogeology) under `assets/mars/` and sample it exactly as MOLA is sampled.
   `surfaceClimate` already takes `thermalInertia` as an explicit argument for
   this reason — adopting the raster changes one call site in
   `js/mars-climate-layer.js`, not the kernel.
2. **Dust opacity is a climatology, not an observation.** Real τ is episodic:
   global dust events are the whole story and a seasonal curve cannot know
   about them. The kernel's `dustOpacity` is pinned by
   `tests/mars-atmosphere-model.mjs` against the τ bands
   `api/mars/weather.js` already advertises, so the page cannot ship two
   disagreeing dust models. A live τ source (MCS or MARCI-derived) would be a
   genuine feed and would belong in the table above.

**Validation lives in the test, not in prose.** `tests/mars-atmosphere-model.mjs`
scores the model against Viking Lander 1, Curiosity/REMS, the bundled MEDA
sol-1133 record (read from `PERSEVERANCE_MEDA_SNAPSHOT`, so refreshing that
snapshot re-scores the model), and the Hellas/Olympus column pressures. Measured
residuals are in the kernel header. If you change the physics, that gate tells
you what you broke.
