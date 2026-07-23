# CME Forecasting & Validation Pipeline — Design + Phasing

*Status: Phases 0–3 + 6 + 7 shipped (CME schema APPLIED 2026-07-12; the
live lock/resolve loop + `/api/cme/skill` + the calendar scorecard shipped
2026-07-23 on `claude/session-c9y6k9`; the Phase 7 HSS corotation program —
schema APPLIED 2026-07-23 — extends the same loop to the second weather).
Phase 4 (hindcast backtest CLI) and the Phase 0 human-confirmation runbook
remain open. Last updated 2026-07-23.*

The physics differentiator of this platform is validated, physics-first
forecasting — skill shown, not claimed. This plan turns the existing daily
CME arrival check into a full forecasting/validation program: durable
per-event records, issue-time-locked predictions, authoritative external
truth, a per-model skill leaderboard, and a space-weather dashboard that
surfaces all of it — with panel placement driven by the owner through a
drag-and-drop Layout Lab and measured with A/B experiments.

---

## 1. What already exists (do NOT rebuild)

| Layer | Asset | Role |
|---|---|---|
| Feed | `api/donki/cme.js` | DONKI CMEAnalysis + WSA-ENLIL proxy; dedup per physical CME, `earth_directed` cone test, ENLIL shock-arrival merge; `?days=` and `?start&end` historical windows |
| Physics | `js/cme-propagation.js` | Drag-Based Model (Vršnak 2013): `dbmTransitTime`, `adaptiveGamma`, `sheathCompression`, `predictImpact` (O'Brien–McPherron Dst, Newell Kp) |
| Physics | `js/ring-current-model.js` | `cmeTransit()` (21.5 R☉→Earth ±15% band), `integrateDst`, `skill()` |
| Scoring | `js/validation-scoring.js` | `detectShockArrivals()` (Pdyn-jump), `scoreCmeArrivals()` (hit rate, MAE-h, ENLIL-vs-ballistic cross-check) |
| Cron | `api/cron/validation-rerun.js` (daily 06:30) | Study 3 = CME arrival scoring → `validation_runs(kind='cme')` |
| DB | `validation_runs`, `solar_wind_samples`, `omni_hourly`, `geomag_indices`, `ring_current_log`, `pipeline_heartbeat` | aggregate scores, L1 ring buffer, OMNI2 archive (in-DB HAPI fetch), Kyoto Dst/Kp truth |
| UI | `ring-current.html` `#rc-spark-cme` | CME arrival skill sparkline (aggregate) |
| UI | `space-weather.html` `#cme-prediction-section` | DBM per-CME cards + `CME ETA` in storm-timing card |
| A/B | `js/experiments.js` | deterministic bucketing, deduped exposure, goals charted in `admin.html` |
| Hindcast | `api/hindcast/gannon.js`, `data/hindcast/gannon_may_2024_replay.json` | Gannon May-2024 replay + flare catalog |

## 2. The five gaps this program closes

1. **No durable per-CME record.** The cron refetches a rolling DONKI window;
   only aggregates survive. → `cme_events`.
2. **No issue-time-locked forecasts.** Predictions are recomputed at scoring
   time, so "what did we say beforehand?" is unanswerable. → `cme_arrival_forecasts`
   (the record-before-predict discipline `forecast_log` already enforces for weather).
3. **Truth is self-detected only.** Arrival hits validate against our own
   Pdyn shocks — no external authority. → `cme_l1_observations` +
   `cme_geomag_observations` filled from OMNI/SYM-H, DONKI IPS, Richardson–Cane.
4. **No per-model leaderboard.** The DBM that drives the dashboard UI is
   never scored at all; only ENLIL-vs-ballistic cross-checks exist. →
   `cme_model_skill` view + `/api/cme/skill`.
5. **Arrival-timing only.** Predicted Kp/Dst from `predictImpact` are never
   verified against observed geomagnetic response. → impact columns on the
   forecast table, scored against `cme_geomag_observations`.

## 3. Architecture — three loops, one schema

```
   OFFLINE (hindcast truth)          LIVE (forward validation)
┌──────────────────────────┐   ┌─────────────────────────────────┐
│ pipelines/cme/step0_pull │   │ cron: validation-rerun (daily)  │
│  DONKI + OMNI/HAPI + R–C │   │  lock forecasts at issue time   │
│  → discrepancy report    │   │  (enlil / ballistic / dbm-v1)   │
│  → reviewed inserts.sql  │   │  resolve truth after passage    │
└────────────┬─────────────┘   └───────────────┬─────────────────┘
             ▼                                 ▼
   cme_events ── cme_arrival_forecasts ── cme_l1_observations
        │                                      │  cme_geomag_observations
        └─────────────► cme_model_skill (view) ◄┘
                              │
                    PRESENTATION: /api/cme/skill →
                    space-weather.html CME panel (leaderboard chips,
                    predicted-vs-actual), ring-current sparkline,
                    hindcast markers in the time-warp scrubber
```

Access model for all four tables: RLS enabled, **zero policies**,
service-role-only — identical to `validation_runs` (CLAUDE.md §4.2). The
advisor will flag it; that is expected.

---

## 4. Phases

### Phase 0 — Truth data pull  ✅ shipped (this branch)

`pipelines/cme/step0_pull.py` + `phase1_hindcast_events.csv` (13 events:
5 Tier A pre-DONKI 2000–2005, 8 Tier B 2012–2024 including Starlink Feb-2022
and Gannon May-2024). See `pipelines/cme/README.md` for usage.

Hardening applied relative to the original draft:
- **Per-parameter HAPI fill sentinels** (`null_fills`): a blanket `|x|>9.9e3`
  cut misses `proton_density` fill 999.99 and `KP1800` fill 99 — those would
  have entered the truth record as real observations.
- Shock detector requires ≥30 valid 1-min points before diffing.
- `sql_escape` renders booleans as SQL `TRUE/FALSE`; date-only timestamps parse.
- Self-test covers all of the above (`--self-test`, no network; passes).

**Runbook (owner):**
1. `cd pipelines/cme && python step0_pull.py --events phase1_hindcast_events.csv --outdir ./step0_out`
2. Read `step0_out/discrepancy_report.md`; manually confirm every shock time
   flagged `CONFIRM MANUALLY`; enter CDAW kinematics for the 5 Tier A events.
3. Commit `phase1_hindcast_events_verified.csv` back into `pipelines/cme/`.
4. After Phase 1 is applied, run the reviewed `step0_out/inserts.sql`.

### Phase 1 — Schema  ✅ applied 2026-07-12 (migration `cme_validation_program`)

`supabase-cme-validation-migration.sql`: `cme_events`,
`cme_arrival_forecasts` (issue-locked, `inputs` jsonb freezes model inputs
for exact replay), `cme_l1_observations` (+`arrived=false` rows to score
false alarms), `cme_geomag_observations`, `cme_model_skill` view.
No RPCs needed yet — cron writes via service role. Tables are empty until a
successful Phase 0 pull is reviewed and its inserts applied.

> **Phase 0 network note:** the step0 pull requires egress to
> `kauai.ccmc.gsfc.nasa.gov`, `cdaweb.gsfc.nasa.gov`, `izw1.caltech.edu`.
> Remote Claude sessions with a restricted network policy get a proxy 403 on
> all three — run the pull locally (or widen the environment's network
> policy). A failed pull now reports `NO PRIMARY DATA — NOT verified` and
> emits no inserts, so it can never masquerade as verification.

### Phase 2 — Issue-time forecast locking (live loop) ✅ SHIPPED 2026-07-23

Extend `api/cron/validation-rerun.js` (new step before scoring), or a small
`api/cron/cme-forecast-lock.js` if the function budget allows a cleaner split:

- For each Earth-directed DONKI CME not yet in `cme_events`: insert the event
  (`PP-RT-<launch-date>-<seq>`), then one forecast row per model at first
  sight and again if DONKI revises kinematics (a new `issued_at` row — never
  UPDATE):
  - `enlil` — DONKI WSAEnlil `shock_arrival` + `kp_*` bands (when present)
  - `ballistic-v1` — `cmeTransit()` with its ±15% window
  - `dbm-v1` — `dbmTransitTime()` + `adaptiveGamma`; impact via `predictImpact`
- Model ids live in `cme_arrival_forecasts.model_id` (own namespace —
  deliberately **no FK** into the weather `forecaster_registry`).
- Heartbeat: reuse the existing `pipeline_heartbeat` write the cron already does.
- Cron cadence: no new `vercel.json` entry needed if folded into
  validation-rerun; if split out, **must** be added to `crons` (§4.3 CLAUDE.md).

### Phase 3 — Truth resolution + scoring (live loop) ✅ SHIPPED 2026-07-23
> **As-built notes (Phases 2+3, both folded into validation-rerun — no new
> cron entry):** event ids are `PP-RT-<donki-id>` (deterministic from the
> DONKI activity id — no sequence counter, so concurrent runs can never
> split an event; deviates from the `<seq>` sketch below on purpose).
> dbm-v1 locks through the SAME `CmeEvent` model the dashboard displays
> (adaptiveGamma + sheath + O'Brien/Newell impact), so the forecast on
> record is the forecast the user saw. Decision logic is pure and
> node-tested (`validation-scoring.js`: `rtEventId`, `needsNewIssue`,
> `resolveEventTruth` — the last with a DATA-COVERAGE guard: a Pdyn gap
> resolves as 'pending', never as a false alarm). Deferred from the
> sketch: `cme_geomag_observations` fill (impact-magnitude scoring) and
> the DONKI-IPS cross-check — arrival timing ships first. The dashboard
> surface is the CME arrival calendar's prediction scorecard
> (js/cme-calendar.js, browser-gated), which supersedes the Phase 5
> "CME panel v2" card sketch.

After expected passage (+3 days), the same cron resolves truth per event:
1. Shock: `detectShockArrivals()` over `validation_pdyn_series` (exists),
   cross-checked against DONKI IPS Earth records; store in `cme_l1_observations`
   with `confirmed_by_human=false`.
2. Geomagnetic: min/max over `geomag_indices` + `omni_hourly` in the passage
   window → `cme_geomag_observations`.
3. No arrival after window + margin → `arrived=false` (false-alarm ledger).
4. Aggregate run row still lands in `validation_runs(kind='cme')` (keeps the
   ring-current sparkline unchanged), now with `detail.event_ids`.

New read endpoint `api/cme/skill.js` (service role → `cme_model_skill`,
pattern: `api/ring-current/validation.js`): per-model `n, hits_12h,
mae_hours, bias_hours, false_alarms, misses`, split hindcast/realtime.

### Phase 4 — Hindcast backtest (offline loop)

`scripts/cme-hindcast.mjs` — CLI mirroring `backmap-validation.mjs` /
`recurrence-validation.mjs` (self-testing, committed data snapshot):
runs `dbm-v1` + `ballistic-v1` on the *verified* Phase 0 launch kinematics,
scores against the truth tables, writes `validation_runs(kind='cme',
detail:{hindcast:true})` and a results doc `CME_HINDCAST_RESULTS.md`.

**Acceptance gates:**
- DBM beats constant-speed ballistic on MAE-hours across the 13-event set
  (literature says ~10 h vs ~14 h; if not, `adaptiveGamma` needs refit —
  that refit is *the point of the loop*).
- Every event's scored numbers reproducible from `inputs` jsonb alone.
- Starlink Feb-2022 is scored for arrival AND impact: the weak-Dst,
  high-drag outcome must be representable (this is the B2G proof point).

### Phase 5 — Dashboard integration (`space-weather.html`)

Constraints (from the page survey — respect all):
- Three.js modules stay lazily imported behind `_threeOk` (3D failures must
  not kill the data plane).
- `ForecastValidator.start()` before `ForecastTimeline.start()`.
- Wind trend writes only on `status==='live'`.
- Nav-lint ratchet: page is baselined for `ghostCss` only; no new violation types.

Work items, in order of value:
1. **CME panel v2** (`#cme-prediction-section`): per-CME cards gain
   (a) model chips — DBM / ENLIL / ballistic ETAs side by side with each
   model's live MAE from `/api/cme/skill` ("DBM ±10.2 h over 13 storms"),
   (b) arrival-window band instead of a point ETA, (c) after passage, a
   predicted-vs-actual strike-through line. Footer: "skill shown, not
   claimed" (ring-current wording).
2. **Sun→Earth propagation strip**: adapt `js/gannon-superstorm-sun-earth.js`
   (SVG scene already driven by `dbmAnalytical` + scrubber) from replay-fed
   to live-DONKI-fed. Zero new Three.js.
3. **Hindcast markers**: the 13 `PP-HC-*` events become markers in the
   existing `#helio-timewarp` scrubber (`#tw-events`), deep-linking a replay
   of each storm — the Gannon page pattern, generalized.
4. **Provenance/token pass**: adopt `js/design-tokens.css` for NEW panels
   (page-wide retrofit is its own PR; canvas/SVG read tokens via
   `getComputedStyle`), fix the stale "GOES (7 days)" flare-panel label
   (source is DONKI now — survey finding).

### Phase 6 — Layout Lab + A/B  ✅ shipped (this branch)

The dashboard's *arrangement* is now user-driven, not agent-hardcoded. The
**🎛 Customize** button shows for every visitor (`?layoutlab=0` hides it);
personal layouts live in their browser. Panels marked `data-lab-resize`
(the heliosphere hero and the magnetosphere globe canvas) additionally have
an always-on bottom-edge drag handle — heights persist per user in a
separate override store (`pp-layout-size.<page>`) so resizing never pulls a
visitor out of their A/B arrangement bucket; double-click resets. Resize
fires the `sw_panel_resize` engagement event.

- `js/layout-lab.js` — apply/design/measure layers. Page opts in via
  `data-lab-zone` / `data-lab-panel` attributes; `space-weather.html` has two
  zones: `main` (12 sections) and `grid` (10 data-cards, full-width toggle).
  Layout resolution: personal (localStorage) > A/B variant > as-authored.
  Applying a layout only reorders/hides existing nodes — every
  `getElementById` wire-up keeps working; non-panel chrome (header, alert
  bars) never moves.
- `tests/layout-lab.mjs` — 11 node tests on the layout algebra (stale-id
  drop, new-panel locality, import sanitization). Browser-probed end to end.
- Experiment `sw_layout_v1` registered **paused** in `js/experiments.js`;
  goals: `sw_panel_interact` (primary), `sw_dwell_60s`. Variants file:
  `data/layout-variants/space-weather.json`.

**How you drive it:**
1. Open `/space-weather.html` → click **🎛 Customize**.
2. Drag panels to reorder (sections vertically, cards within the grid),
   👁 to hide, ⬌ for full-width cards.
3. **Save mine** = your personal layout (this browser, wins over variants).
4. **Export** → paste the JSON as a variant in
   `data/layout-variants/space-weather.json` and commit. Publishing is a
   git operation on purpose — variants are reviewable, the anon surface
   stays read-only. *(`sw_layout_v1` is RUNNING as of 2026-07-12:
   control = sim-first authored order, b = forecast-first reorder.
   Re-exporting over `b` updates the running experiment — prefer a new
   experiment key for a materially different hypothesis.)*
5. QA a variant with `?exp_sw_layout_v1=b`. Read results in `admin.html`'s
   experiment charts (goals above, segmented by variant automatically).
6. Kill switch: flip back to `'paused'` (everyone gets control), or
   `?layoutlab=0` to hide the Lab button.

### Phase 7 — HSS corotation program (the second weather) ✅ SHIPPED 2026-07-23

Same architecture, second phenomenon: every coronal hole the platform
detects gets an issue-time-locked corotation arrival window, and the daily
cron scores it against the observed L1 speed rise. One scorecard covers
both kinds of space weather.

- **Schema** — `supabase-hss-validation-migration.sql`, **APPLIED
  2026-07-23** (migration `hss_validation_program`): `hss_events`
  (`hole_id` unique — `HSS-YYYY-MM-DD-E20`, 5° Stonyhurst bins),
  `hss_arrival_forecasts` (UNIQUE(hole_id, model_id), INSERT-only),
  `hss_l1_observations`, the `hss_model_skill` view (shaped like
  `cme_model_skill`; a hit = arrival inside the ±1 d window), and the
  `validation_speed_series(p_days)` RPC (15-min `speed_km_s` medians from
  `solar_wind_samples`; EXECUTE revoked from anon/authenticated). All
  tables are zero-policy service-role-only — same intentional advisor
  flag as the CME rows in CLAUDE.md §4.2.
- **Detection source** — the cron reads recent HEK SPoCA coronal holes
  (|lat| ≤ 65°, |Stonyhurst lon| ≤ 75°), NOT the Stage's client-side 171
  detector: server truth must not depend on a browser having been open.
  Dedupe is Carrington-aware (<20° apart within 20 days = same hole
  recurring). The Stage's `detectCoronalHoles` remains the *visual* story;
  the two agree on the corotation oracle below.
- **Model** — `corotation-v1`: the hole corotates to the central meridian
  (`hssArrivalWindow` in `js/stage/model.js`, Carrington synodic 27.2753 d,
  east-positive Stonyhurst) + a 600 km/s transit; window = ETA ± 1 d.
  The oracle lives in the Stage model and is re-exported by
  `js/validation-scoring.js` so cron and canvas can never disagree.
- **Truth** — `resolveHssTruth` (node-gated): baseline = median speed over
  [start−24 h, start−6 h]; arrived if the window's peak exceeds baseline
  + 80 km/s, with `arrival_at` = first sample ≥ baseline + 50 km/s.
  DATA-COVERAGE guard (≥8 baseline AND ≥8 window samples, resolve only
  after window end + 12 h) — a feed gap resolves as *pending*, never as a
  false alarm. Same honesty rule as `resolveEventTruth`.
- **Read path** — `/api/cme/skill` gains a `hss:{models, events}` section
  (three flat reads stitched by `hole_id` — text joins, no FK embedding;
  missing tables degrade to empty so the CME data still serves).
- **Calendar** — `js/cme-calendar.js` renders corotation windows as teal
  `◐` chips (upcoming = window countdown; scored = struck prediction →
  bold speed-rise time with the same signed error convention, + = forecast
  late; false alarm = `✗ no stream`), and `corotation-v1` joins the ONE
  merged skill strip as `Corotation·HSS`. Pure parts node-gated
  (`hssCalendarRows`/`hssByDay` in tests/cme-calendar.mjs), page wiring
  browser-gated (tests/cme-calendar.spec.js).
- **Calendar diagnosability** (the "calendar seems broke" fix, same
  round): a `DEMO_KEY` bus flag (`donki_key_mode`) surfaces as an amber
  note naming `NASA_API_KEY`, and a failed `/api/cme/skill` fetch renders
  a scorecard-feed-unavailable note — data-plane starvation is *named*,
  never mistaken for a quiet sun.

---

## 5. Ops / hygiene

- `pipelines/` is `.vercelignore`d; `pipelines/cme/step0_out/` is gitignored.
- New cron files must be registered in `vercel.json` `crons` (silent-miss
  hazard, CLAUDE.md §4.3).
- Advisor warnings for the four new zero-policy tables are expected — add
  them to the CLAUDE.md §4.2 list when the migration is applied.
- Tests to run when touching this program: `node tests/layout-lab.mjs`,
  `node tests/validation-scoring.mjs`, `node tests/cme-calendar.mjs`,
  `npx playwright test tests/cme-calendar.spec.js`,
  `python3 pipelines/cme/step0_pull.py --self-test`,
  `node scripts/lint-nav.mjs`.

## 6. Shipped on this branch

- `pipelines/cme/{step0_pull.py, phase1_hindcast_events.csv, README.md}`
- `supabase-cme-validation-migration.sql` (draft — not applied)
- `js/layout-lab.js`, `tests/layout-lab.mjs`,
  `data/layout-variants/space-weather.json`
- `space-weather.html`: zone/panel attributes + isolated Layout Lab boot
- `js/experiments.js`: `sw_layout_v1` (paused) + goals
- `.vercelignore` / `.gitignore` entries
- This plan.

Next concrete step after review: apply the Phase 1 migration, then run the
Phase 0 pull and human-confirm the shock times.
