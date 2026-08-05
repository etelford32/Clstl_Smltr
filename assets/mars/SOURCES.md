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
