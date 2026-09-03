# Real-Time Mars visual sources

- `mars-viking-jpl.jpg` — global simple-cylindrical Viking image mosaic,
  1440×720, from the NASA/JPL Solar System Simulator texture archive.
  Source: https://space.jpl.nasa.gov/tmaps/mars.html
- `mola-topography.png` — browser-ready height texture derived without
  resampling from `MEGT90N000CB.IMG`, the 4-pixels/degree Mars Global
  Surveyor MOLA Mission Experiment Gridded Data Record. The source grid is
  signed 16-bit big-endian topography in metres, with a published range of
  -8068 m to +21134 m. Its 0–360°E longitude axis is rolled into -180–180°
  to align with the color texture and Parker's Physics globe coordinates.
  Source and label:
  https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg004/megt90n000cb.img
  https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg004/megt90n000cb.lbl

The page credits the original NASA/JPL/USGS and NASA/GSFC MOLA sources in
the visible interface. `scripts/build-mars-mola-texture.mjs` documents and
reproduces the binary-grid-to-PNG conversion.

## These two files are the FALLBACK, not the map

Both rasters are 1440×720 — 4 pixels/degree, ≈14.8 km/px at the equator. That
is the resolution mars.html rendered *everything* at before the tile stack, and
it is why the 520 km surface patch (~37 texels across) came out as a smooth
wash with the WFC synth layer covering the gap.

The map proper is now streamed from NASA's Solar System Treks through
`/api/mars/tiles` — see the "Surface imagery tiles" section of
`data/mars/SOURCES.md`. These files are what the page falls back to when that
service is unreachable, and the layer row says so by name and by number when it
does. **Keep them.** They are also the offline-boot texture and the static
globe in `.mars-render-fallback`.

### Verified Trek layer identifiers

The candidate lists in `js/mars-tiles.js` were written with egress to
trek.nasa.gov blocked, so none of the identifiers below is confirmed. Record
them here as production settles them, then trim the candidate lists to match:

| Logical layer | Verified identifier | Verified on |
|---------------|--------------------|-------------|
| `imagery` | _(unverified — run `curl -s https://parkersphysics.com/api/mars/tiles \| jq .resolved`)_ | — |
| `thermal` | _(unverified)_ | — |
| `highres` | _(unverified)_ | — |
| `topo` | _(unverified)_ | — |
