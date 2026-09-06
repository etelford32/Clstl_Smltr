# tests/fixtures/sdo — full-disk frames for the Sun page tests

**`synthetic_*.png` are NOT observations.** They are rendered by
`scripts/make-sdo-synthetic-fixtures.mjs` with the same geometry as NASA's
`latest_<res>_<code>.jpg` browse frames (centred disk, HMI ≈ 0.465 / AIA ≈ 0.390
of the frame radius, limb darkening / brightening, faint off-limb corona) and
three PLANTED active regions at heliographic coordinates recorded in
`manifest.json`. `tests/sun-observed.mjs` uses that ground truth to pin the
disk→sphere projection and the disk measurement; `tests/sun-smoke.spec.js`
serves them in place of `/api/solar/aia` so CI never needs nasa.gov.

The build sandbox cannot reach nasa.gov, which is why real frames are not
committed here. On a machine that can, `node scripts/fetch-sdo-fixtures.mjs`
writes `real_<channel>.jpg` + `real-manifest.json`; `tests/sun-visual.spec.js`
(the `@gpu` screenshot baseline) prefers the real set when it exists. Real
frames are public-domain NASA imagery.

Do not hand-edit the PNGs; regenerate them.
