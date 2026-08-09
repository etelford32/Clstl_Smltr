# Mars data pipelines

mars.html reads from four sources. Each has an explicit degradation path, and
the page always states which one produced what is on screen — see
`__marsLab.feedState()` for the machine-readable version.

| Feed | Route | Live source | Falls back to |
|------|-------|-------------|---------------|
| Traverse / rover position | `/api/mars/route` | NASA MMGIS waypoints | bundled `perseverance-route.json` |
| Mars geometry + season | `/api/mars/ephemeris` | JPL Horizons | analytic model in `js/mars-mission-state.js` |
| Surface weather | `/api/mars/weather` | NASA MEDA / REMS / InSight | bundled MEDA snapshot (sol 1133) |
| Sky directions | `/api/horizons` | JPL Horizons topocentric | nothing — bodies report unavailable |

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
