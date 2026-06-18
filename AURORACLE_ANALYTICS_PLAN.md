# AurOracle — analytics roadmap

> Living plan for the predictive aurora analytics that make AurOracle worth the
> intro subscription. Keep this in sync with `js/auroracle.js`,
> `js/auroracle-globe.js`, and `js/aurora-forecast.js`. Physics-first — every
> number should trace to a feed or a cited climatology, never a black box
> (see CLAUDE.md §7).

## Product frame

Two layers, deliberately separated (see `js/auroracle.js` header):

- **TEASER (free / signed-out):** first-principles odds for the user's exact
  sky — tonight, 7 nights, 30-day recurrence — plus the live 3D analyzer and
  *tonight's viewing window*. This is the hook; it must be genuinely useful so
  people return nightly.
- **UNLOCK (Basic+, $9.99 intro):** the live OVATION ensemble, the model
  breakdown, custom alerts, and the deeper predictive analytics below.

The Earth tab cross-sells into this (`earth.html` → `data-funnel-cta=
"earth_aurora_to_auroracle"`): Earth shows *live* aurora power/Kp; AurOracle
owns the *prediction*.

## Shipped

| Analytic | Where | Data |
|----------|-------|------|
| Tonight + best-night odds, 7-night, 30-day recurrence | hero / week / month | geomag-lat vs oval edge vs forecast Kp |
| **Tonight's viewing window** (dark-sky window + solar-midnight substorm peak + odds at peak) | `renderViewingWindow` / `tonightWindow` | `sun-altitude.solarPosition` + Kp |
| Real-time 3D analyzer (live OVATION footprint, brightest regions, location pins) | `auroracle-globe.js` | `/api/noaa/aurora-grid` → browser-direct fallback |
| Live ensemble (AR(3) + Kp-blend + persistence), agreement, P(exceedance), drivers | `renderEnsemble` etc. (unlock) | OVATION power history + 3-day Kp + RTSW Bz |
| Multi-location watch list (chips + globe pins, per-location scoring) | `user-location.js` list helpers | localStorage |
| Email alert at a Kp threshold | `/api/subscribe/aurora` | — |

## Next — prioritized

### P1 — deepen "tonight" (highest conversion leverage; nightly habit)
1. **Hourly tonight curve.** Replace the single peak with an hour-by-hour
   odds strip across the dark window (intersect the SWPC 3-day Kp profile,
   already fetched in `patchOperational`, with the darkness window). "Best
   90-minute window: 11:40pm–1:10am." *Data in hand; no new feed.*
2. **Moon interference.** Bright moonlight washes out faint aurora. Add a
   moon-altitude + illuminated-fraction term (same astronomy style as
   `sun-altitude.js`) and fold it into the viewing-window quality. "Waxing
   gibbous, up till 2am — wait for moonset."
3. **Cloud-cover gate.** The aurora can be strong and still invisible under
   cloud. Pull the user's location nightly cloud forecast (the Earth weather
   feed already has grids) → "62% odds, but 80% cloud at peak — low chance to
   actually see it." Turns odds into *see-ability*.

### P2 — sharper physics (trust + differentiation)
4. **Substorm-onset nowcast.** Magnetic midnight is climatology; real onsets
   are driven by IMF Bz southward turnings + loading/unloading. Track the
   AL/AE-proxy and Bz integral to flag "loading now — onset likely within
   30–60 min." Ties to the MHD differentiator (CLAUDE.md §7).
5. **Overhead vs on-the-horizon.** Distinguish "oval overhead" (corona,
   directly above) from "glow on the poleward horizon." Use the user's
   geomag-lat vs the live oval equatorward/poleward edges
   (`upper-atmosphere-aurora-physics.auroralOvalLatBand`) → a viewing-
   direction + altitude-angle hint ("look N, ~20° up").
6. **Color/altitude prediction.** Red (>230 km, O), green (~120 km, O),
   purple/blue (N₂⁺) depend on energy flux + Kp. Predict the dominant color
   from the OVATION energy-flux product. Memorable and shareable.

### P3 — retention + reach
7. **"Notify me when my sky lights up" push,** not just email — fire when the
   *live* oval crosses the user's location, per saved location.
8. **Backcast accuracy badge.** Log each night's forecast vs the realized
   OVATION peak (`forecast_log` / `AuroraHistory`) and show a rolling Brier
   score. "AurOracle called 7 of the last 10 nights." Proof, not promises.
9. **Shareable "last night" card** rendered from the globe — social hook.
10. **Photography assist.** Suggested ISO/shutter from predicted intensity +
    moon + the viewing window. Niche but high-affinity.

## Data + physics references
- OVATION Prime nowcast — `ovation_aurora_latest.json` (browser-direct; WAF
  403s server-side — see `js/swpc-feed.js` header).
- SWPC 3-day Kp — `/api/noaa/forecast-3day` (already consumed).
- RTSW Bz — `rtsw_mag_1m.json` (browser-direct).
- Oval boundaries — Feldstein–Starkov / Newell, in
  `js/upper-atmosphere-aurora-physics.js`.
- Hemispheric power ← Kp — Zhang–Paxton (same module).
- Sun/moon geometry — `js/sun-altitude.js`.

## Guardrails
- No new server-side NOAA fetches for live data — browser-direct or the
  downsampled edge route with a browser fallback.
- Keep the teaser fast and dependency-light; heavy analytics hydrate only on
  unlock (`hydrateLive`).
- Every prediction shows its driver. Physics-first, not "AI-powered."
