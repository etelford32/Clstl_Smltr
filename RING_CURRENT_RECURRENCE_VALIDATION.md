# Recurrence-Forecast Validation — first hindcast (2026-07-04 → 07-11)

**Question.** Standing at time t0 with only the data available then, how
well does the page's recurrence forecast (`holeArrivalForecast`: hole
meridian crossing from solar rotation + ballistic transit + the hole's own
wind record, or a labeled 450–650 km/s climatology) predict the arrival
**day** and **speed** of the next high-speed stream? Day-level timing is
the operational benchmark for 27-day persistence products of this kind.

**Method** (`scripts/recurrence-validation.mjs`, self-testing;
out-of-sample by construction): forecasts issued every 12 h through the
window; at each issue, hole records are computed **only from wind data
before the issue time**; truth = rising crossings of 500 km/s in the 6-h
median series; a forecast scores a HIT when its predicted arrival lands
within ±1.25 d of an onset (matching window ±2.5 d). Timing skill =
1 − MAE/1.25 d (0 = random placement inside the matching window).
Self-test: a planted hole one climatology-transit ahead of a synthetic
onset scores 17/17 hits (MAE 0.01 d); the same hole displaced 120° scores
zero.

**Data.** The committed `scripts/backmap-data-2026-07.json`: 28 six-hour
wind buckets (3,903 NOAA-SWPC 1-min rows, Supabase) + 150 SPoCA
coronal-hole detections (HEK).

## Results

| metric | value |
|---|---|
| forecasts issued | 36 (9 issue times × visible holes) |
| hits | 17 (47 % of all; **17/17 for the onset-bearing hole**) |
| timing MAE (matched) | **0.57 d** |
| timing skill vs random | **0.55** |
| speed MAE | 88 km/s |
| onsets missed entirely | **0** |
| independent stream events | **1** (say it plainly) |

**The headline case.** The equatorial hole (N6–N8, Carrington 357–358°)
was forecast to arrive **July 9 ≈ 15 UT from every issue time, starting
4.5 days before onset** — and the actual onset came +0.34…+0.40 d later
(observed peak 626 km/s vs the 550 climatology midpoint, −76 km/s). This
was a genuinely blind prediction: the hole had **no wind record** before
its stream arrived (climatology basis), so the timing came purely from
rotation geometry + ballistic transit. The forecast was also **stable** —
nine consecutive issues moved the predicted arrival by less than 2 hours.

**The unmatched forecasts** (S50–S62 southern-hole complex, July 5–7
issues) are a definition artifact, not false alarms in the ordinary
sense: those holes' wind WAS arriving (the declining 420–500 km/s phase
of stream 1), but a declining stream never produces a rising-500 onset to
match. A "stream present" verification (sustained v ≥ 450) would credit
most of them. Kept as-is deliberately — onset timing is the harder and
more useful test.

**Slight late bias** (+0.37 d on the headline hole): the stream's leading
edge ran faster than the climatology midpoint (626 observed vs 550
assumed). This is the known conservative bias of climatology-basis
recurrence timing; it shrinks automatically as holes acquire their own
records (the archive already feeds `holeWindAssociation`).

## Caveats

- **One independent stream event.** 36 forecasts, 9 issue times, but a
  single onset — this validates the pipeline end-to-end and provides a
  case study, not statistics. The harness reruns on any window in one
  command as `solar_wind_samples` accumulates; past one Carrington
  rotation (~27 d), east-limb holes inherit last-rotation records and the
  record-basis branch becomes testable at scale.
- Onset definition (rising 500 km/s) is strict; see above.
- Published verification of 27-day persistence techniques typically finds
  day-level arrival accuracy for well-behaved recurrent streams — this
  first case (0.37 d, blind) is consistent with that class, but quote
  nothing beyond "consistent" until the sample grows.

## Rerunning

```
node scripts/recurrence-validation.mjs --data <file>     # any window
node scripts/recurrence-validation.mjs --selftest        # planted truth
```

**Daily re-run.** `api/cron/validation-rerun.js` (06:30 UT, vercel.json
crons) re-runs this hindcast every day over the rolling
`solar_wind_samples` window with the SAME engine
(`js/validation-scoring.js`), appending to `validation_runs`; history is
served at `/api/ring-current/validation`. Past one Carrington rotation
the record-basis branch enters the daily score automatically.

*First run 2026-07-11, alongside RING_CURRENT_BACKMAP_VALIDATION.md — the
two halves of the same loop: back-mapping attributes what arrived;
recurrence predicts what will.*
