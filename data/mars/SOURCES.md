# Perseverance route snapshot

`perseverance-route.json` is a compact normalization of NASA/JPL's public
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

Rebuild with:

```sh
node scripts/build-mars-route-snapshot.mjs M20_waypoints.json data/mars/perseverance-route.json YYYY-MM-DD
```

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
