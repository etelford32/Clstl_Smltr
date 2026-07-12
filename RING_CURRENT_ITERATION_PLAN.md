# Ring Current / Sun→Earth Pipeline — Iterative Improvement Plan

> The loop that now exists: **measure** (L1 + Kyoto + GOES + HEK) →
> **model** (OBM ring current, ballistic back-mapping, recurrence
> forecast) → **render** (the one-clock digital twin) → **score daily**
> (validation_runs cron) → **improve** (this document). Every item below
> names its acceptance signal — most of them are movements in a number
> the pipeline already publishes at `/api/ring-current/validation`.
> Nothing here proposes an ML black box; each step is a physics
> refinement whose effect is measurable in the existing ledgers
> (CLAUDE.md §7: physics-first is the differentiator).

## Phase A — data accumulation (no code, just time)

The archive is the rate limiter. `solar_wind_samples` grows ~500
rows/day; HEK is queried fresh by the daily cron.

- **A1 · One Carrington rotation (~Jul 31).** East-limb holes start
  inheriting last-rotation records through `holeWindAssociation`;
  the recurrence hindcast's record-basis branch enters the daily score
  automatically. *Signal: `basis:'record'` fraction in
  validation_runs.detail rises from ~0.*
- **A2 · Three rotations (~Sep).** Enough independent stream events
  (~6–12) for the first quotable statistics. *Signal:
  `metrics.independentEvents ≥ 6` in a single run's window — then and
  only then quote hit rates externally.*

## Phase B — model refinements (each falsifiable against the daily score)

- **B1 · Speed-corrected ballistic mapping.** The July stream showed the
  classic bias: Δlon drifting 7°→26° through the stream (trailing plasma
  dragged by stream interaction), and the recurrence hindcast ran
  +0.37 d late. Refit: use a 2-day-median departure speed instead of the
  instantaneous sample, and/or the standard ~10% inner-heliosphere
  acceleration correction. *Accept if: back-map median |Δlon| drops
  below 12° and recurrence MAE below 0.45 d over ≥3 rotations — measured
  by simply flipping the correction on in validation-scoring and
  comparing daily rows before/after.*
- **B2 · Per-hole climatology → per-hole priors.** Replace the flat
  450–650 band for record-less holes with a prior from hole AREA and
  latitude (HEK provides area fields; larger low-latitude holes → faster
  wind, an established empirical relation). *Accept if: climatology-basis
  speed MAE (currently 88 km/s) improves.*
- **B3 · Hole tracking across days.** SPoCA centroids drift ~1.5–2.7°/day
  in the Carrington frame (differential rotation — measured in our own
  July pulls). Track structures across detections (nearest-neighbor in
  lon/lat, ±1 rotation) so records and forecasts attach to *structures*,
  not grid cells. *Accept if: dedup count stabilizes and per-hole record
  n grows instead of fragmenting.*
- **B4 · Onset definition v2.** The rising-500 onset misses declining
  streams (July's "unmatched forecasts" artifact). Add a second
  verification mode — "stream present" (sustained v ≥ 450) — scored in
  parallel, never replacing the strict one. *Accept if: both numbers
  published per run; strict stays the headline.*
- **B5 · Probabilistic windows.** The forecast already carries
  early/late bounds; score them as intervals (fraction of onsets inside
  the band → reliability diagram) instead of point hits only. *Accept
  if: interval coverage ≈ nominal (a well-calibrated band).* 

## Phase C — product surface (each rides existing machinery)

- **C1 · Skill sparklines** *(shipped with this commit)* — daily skill
  history in the validation panel from `/api/ring-current/validation`.
- **C2 · Recurrence alert.** When a hole's forecast enters <3 d with
  record basis, surface it in the existing alert bar (`rc-alert`) and as
  a `notify_*` toggle (CLAUDE.md §8 pattern: one column, one check in
  alert-engine, one toggle in account.html). *Genuine lead time measured
  in days, not the L1 hour — the page's strongest operational claim.*
- **C3 · Skill page section.** A `/space-weather` or ring-current
  subsection plotting validation_runs history with the method notes —
  the public, linkable version of "skill shown, not claimed". Feeds the
  B2G narrative (SBIR reviewers can see live verification).
- **C4 · Journey provenance tooltip.** Parcel tooltips already date their
  solar departure; add the attributed source (hole + basis + Δlon) so a
  hover tells the full story: born at CH S25 → 2.8 d flight → arrival →
  sheath → tail → ring.

## Phase D — rendering/perf (telemetry-driven, not speculative)

- **D1 · Read the `ring3d_*` app_perf telemetry** now accumulating in
  client_telemetry before optimizing anything further. The section EMAs
  will name the next bottleneck (prediction: EarthSkin fragment cost at
  dpr 2). *Rule: no perf work without a telemetry row pointing at it.*
- **D2 · Tail sheet + boundaries LOD tier** — include in quality tier 2
  if D1 shows fill-rate pressure on mid GPUs.

## Phase E — the paper

Target: a short research note — "Live per-structure verification of
ballistic back-mapping and 27-day recurrence forecasting from an
operational web pipeline."

1. Wait for A2 (≥6 independent events).
2. Figures already producible from committed artifacts: (i) Δlon
   distribution vs chance (backmap), (ii) predicted-vs-actual arrival
   scatter with the stream-interaction drift, (iii) daily skill
   time-series (validation_runs), (iv) the 180° L0 anchor finding as a
   methods cautionary note.
3. Benchmark framing: day-level arrival accuracy is the recurrence-
   product standard; report ours beside the published persistence-model
   literature (qualitative until N justifies more).

## Standing rules (apply to every phase)

- One clock, honest speeds, disclosed exceptions — no exceptions.
- Every model constant lands in `tests/ring-current-model.mjs` with a
  literature or empirical anchor before it ships (the 180° L0 bug is the
  reason this rule exists).
- Scoring changes go through `js/validation-scoring.js` so the CLI, the
  cron, and any future notebook run identical code.
- Skill shown, not claimed: no number is quoted externally that the
  daily cron isn't reproducing.

*Created 2026-07-12. Revisit at each Phase A milestone.*
