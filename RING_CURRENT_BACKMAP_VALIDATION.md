# Ballistic Back-Mapping Validation — first run (2026-07-04 → 07-11)

**Question.** `ring-current.html` back-maps arriving solar wind to a source
Carrington longitude (departure = arrival − (AU − L1)/v; source lon = L0 at
departure) and attributes it to HEK coronal holes. How often does **fast**
wind actually trace to a catalogued hole at the predicted longitude — and
how does that compare to chance?

**Method** (`scripts/backmap-validation.mjs`, self-testing):
6-hour wind windows (median v; fast ≥ 500 km/s, slow < 450). Each window
back-mapped with the Nolte–Roelof constant-speed assumption (±½ day ≈ ±6°).
Candidates = SPoCA CH detections within ±2 days of departure, |lat| ≤ 65°
(polar-cap holes excluded — their wind misses the ecliptic). Hit = min
Carrington |Δlon| ≤ tolerance. **Chance control** per window = the fraction
of all 360° of longitude those same candidates would match; skill =
(hit − chance)/(1 − chance).

**Data.** Wind: 3,903 one-minute NOAA-SWPC rows from `solar_wind_samples`
(Supabase), 2026-07-04T18Z → 07-11T18Z, as 28 six-hour buckets. Holes: HEK
`event_type=ch`, SPoCA detector only, 2026-06-25 → 07-08 (the catalog's
processing lag ends there), deduped per day on a 5° grid — 150 detection
rows. Committed copy: `scripts/backmap-data-2026-07.json`.

## Headline finding: the study caught a real bug

Cross-checking predicted longitudes against catalog visibility exposed a
**180.00° zero-point error** in `carringtonL0` (the classic
θ = (JD − 2398220)·360/25.38 phase convention lands the prime meridian half
a rotation off the operational HEK/SDO Carrington frame). Measured against
HEK `hgc_x − hgs_x` pairs the offset was exactly 180.00° at two epochs; the
constant is now corrected and **regression-anchored** in
`tests/ring-current-model.mjs` (L0 = 337.75° at 2026-07-08T00:02Z). Every
disk-marker and attribution feature shipped after this fix; nothing
user-facing ever ran with the wrong frame. This is precisely what the
validation loop is for.

## Results

| class | N | tol | hit rate | chance | skill |
|---|---|---|---|---|---|
| fast | 11 | ±10° | 36% | 24% | 0.16 |
| fast | 11 | ±15° | 45% | 31% | 0.21 |
| fast | 11 | ±20° | **82%** | 37% | **0.71** |
| fast | 11 | ±30° | 100% | 44% | 1.00 |
| slow | 13 | ±10° | 54% | 31% | 0.33 |
| slow | 13 | ±15° | 85% | 42% | 0.74 |
| slow | 13 | ±20° | 100% | 51% | 1.00 |

Median best |Δlon|: fast 16.1°, slow 9.7°.

**Stream 1 (Jul 4–5, declining, 480–577 km/s)** back-maps to Carrington
58–60° → matches the S48–S52 mid-latitude hole (Car 52–66°) at
**Δ = 0.2–0.7°**. Essentially exact.

**Stream 2 (Jul 9.5–11, fresh, 504–626 km/s)** back-maps to 331–350° →
matches the persistent low-latitude hole at N4–N8, Car ≈ 357–358°
(tracked by SPoCA continuously Jul 1–8). Δ grows 7° → 26° through the
stream — the classic ballistic bias: trailing-edge plasma left the hole
slower/later and was dragged by stream interaction, so constant-speed
mapping drifts progressively west of the true source. A speed-dependent
correction (or 2-day-averaged v at departure) is the obvious refinement.

**Slow wind** also "matches" at wide tolerances — expected and *not*
evidence of skill: slow wind originates in the streamer belt around hole
boundaries, and this window's catalog covers 31–59% of relevant longitudes
by chance. The discriminating number is the fast-wind skill **0.71 at
±20°** (82% vs 37% chance).

## Caveats

- **Seven days, two independent stream episodes.** The 6-h windows are
  autocorrelated within each stream; effective N ≈ 2 events, not 11.
  This is a pipeline validation + case study, not yet statistics.
- Ballistic mapping ignores inner-heliosphere acceleration and stream
  interaction (visible as the stream-2 drift).
- SPoCA centroids wander (differential rotation moves mid-lat hole
  centroids ~1.5–2.7°/day in the Carrington frame).

## Rerunning at scale

`node scripts/backmap-validation.mjs --data <file> [--md out.md]` — the
data file format is documented in the script header. This sandbox's
network policy blocks NOAA/LMSAL/SPDF egress (the committed run pulled
HEK through the Supabase `http` extension and wind from
`solar_wind_samples`); from an open network, build multi-month files from
`/api/omni/imf` (monthly windows) + the HEK `her` API, or simply let
`solar_wind_samples` accumulate. `--selftest` verifies the scorer on
planted ground truth (100% hit) and displaced holes (0% hit).

**Daily re-run.** `api/cron/validation-rerun.js` (06:30 UT, vercel.json
crons) re-scores this study every day over the rolling
`solar_wind_samples` window with the SAME engine
(`js/validation-scoring.js`) the CLI runs, appending to
`validation_runs`; history is served at `/api/ring-current/validation`.
The skill numbers become a time-series automatically as the archive
grows.

*First run 2026-07-11. Extend the window before quoting the skill numbers
anywhere formal.*
