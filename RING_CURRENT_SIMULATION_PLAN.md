# Ring Current Simulation — real-time digital twin of Earth's ring current

> Status: Phase 0 + Phase 1 implemented in this branch (`claude/ring-current-simulation-earth-12ry38`).
> Phases 2–3 are specified here but intentionally not started.

---

## 1. Goal

A **physics-first, real-time digital twin of Earth's ring current** at
`ring-current.html`, driven minute-by-minute by measured L1 solar wind, and
validated live against the Kyoto Dst index. The page answers, at a glance:

- *How much energy is trapped in the ring current right now?* (Joules, via
  the Dessler–Parker–Sckopke relation)
- *Is it injecting or recovering, and why?* (southward IMF Bz → dawn–dusk
  electric field VBs → injection; charge exchange / drift loss → decay)
- *What happens in the next ~30–60 minutes?* (a **genuine forecast** — the
  most recent L1 samples measure plasma that has not yet reached Earth)
- *Is the model any good?* (model Dst vs observed Kyoto Dst on the same
  chart, with live skill numbers — the "physics-first ground truth" frame,
  not an ML black box)

This is the same product wedge as the LEO-drag work: an operator-credible,
physically grounded nowcast + short-horizon forecast, with its skill shown
rather than asserted.

---

## 2. Physics background (what we model)

The ring current is a toroidal westward electric current at ~2–7 R_E carried
mostly by 10–300 keV ions (H⁺, O⁺) injected from the plasma sheet during
periods of southward IMF. Its magnetic perturbation depresses the horizontal
field at the equator — that depression **is** the Dst index.

**Dynamics — O'Brien & McPherron (2000)** (primary), Burton et al. (1975)
(comparison mode):

```
dDst*/dt = Q(VBs) − Dst*/τ(VBs)

Q   = a·(VBs − Ec)   for VBs > Ec, else 0     a = −4.4 nT/h per mV/m, Ec = 0.49 mV/m
τ   = 2.40 · exp( 9.74 / (4.69 + VBs) )       hours (shorter decay when driven)
VBs = v · max(0, −Bz) · 10⁻³                  mV/m  (v in km/s, Bz GSM in nT)
```

**Pressure correction** (magnetopause currents contaminate raw Dst):

```
Dst* = Dst − b·√Pdyn + c        b = 7.26 nT/√nPa, c = 11 nT
Pdyn = 1.67·10⁻⁶ · n · v²       nPa
```

**Energy content — Dessler–Parker–Sckopke:**

```
ΔB/B₀ = −(2/3)·(W_RC / W_m)     W_m = (4π/3μ₀)·B₀²·R_E³ ≈ 8.3×10¹⁷ J
⇒  W_RC ≈ 4.0×10¹³ J per nT of |Dst*|
```

A −100 nT storm therefore holds ~4×10¹⁵ J — the number the HUD leads with.

**Morphology for the 3D twin:**

- Radial profile: current density peaks near L≈4 quiet, moves earthward
  toward L≈2.5 as |Dst*| grows (empirical smooth fit).
- **Partial ring current**: during the main phase the current is strongly
  asymmetric, peaking near dusk (~18–21 MLT); it symmetrizes in recovery.
  Asymmetry is driven by VBs in the model.
- Drift kinematics: gradient–curvature drift, **ions westward, electrons
  eastward** — T_d ≈ 1.05/(L·E_MeV) hours (Schulz–Lanzerotti), animated at a
  stated time compression.
- Plasmapause (Carpenter & Anderson 1992, Lpp = 5.6 − 0.46·Kp) shown as
  context — it bounds the charge-exchange loss region.

**Forecast horizon:** RTSW `time_tag`s are observation times at L1
(~1.5×10⁶ km upstream). Ballistic arrival delay = 1.5×10⁶ km / v ≈ 62 min at
400 km/s. Samples not yet arrived at Earth are integrated forward to produce
the forecast strip — this is real lead time, not extrapolation.

---

## 3. Data feeds

```
NOAA RTSW rtsw_wind_1m.json  ─┐  (plasma: v, n, T — 1-min, full day)
NOAA RTSW rtsw_mag_1m.json   ─┤  (IMF: bt, bz, bx, by — 1-min, full day)
                              │
        ┌─────────────────────┴──────────────────────────────┐
        │                                                     │
   BROWSER-DIRECT (CORS-enabled,                    api/cron/refresh-solar-wind.js
   the sanctioned NOAA pattern)                     (every minute, Vercel cron)
        │                                                     │
        │                                       Supabase solar_wind_samples
        │                                       (7-day ring buffer, RPC-written)
        │                                                     │
        │                                       /api/solar-wind/latest[?series=1]
        │                                                     │
        └───────────────┬─────────────────────────────────────┘
                        ▼
              js/ring-current-feed.js          ← assembles driver series
                        ▼
              js/ring-current-model.js         ← O'Brien–McPherron + DPS
                        ▼
        ring-current.html + js/ring-current-globe.js
                        ▲
NOAA kyoto-dst.json ────┘  (observed Dst, browser-direct, T3 cadence)
NOAA planetary_k_index_1m ─┘  (Kp → plasmapause, T2 cadence)
```

### Phase 0 — the feed fix (prerequisite, applied in this branch)

`api/cron/refresh-solar-wind.js` fetched **only** `rtsw_wind_1m.json`, which
is plasma-only — so `cleanField(row,'bz_gsm')` never matched a key and
`bz_nt/bt_nt/bx_nt/by_nt` were written **NULL for every row**, starving any
ring-current / coupling model of its southward-IMF driver. The uploaded patch
(applied verbatim):

- also fetches `rtsw_mag_1m.json` and merges the latest valid mag row
  (best-effort: plasma still writes if mag fails — no regression);
- adds a stale-RTSW fallback (fixes the ~24 h "stale feed" heartbeat
  failures). NOTE: the patch's original `products/solar-wind/*` DSCOVR URLs
  turned out to be retired at NOAA (404, verified live 2026-07-10); the
  fallback now uses `products/geospace/propagated-solar-wind-1-hour.json`,
  which carries plasma + IMF in one product and stays live when RTSW gaps;
- preserves the pipeline contract: `noaa-swpc` source tag,
  `record_pipeline_*` heartbeats, ±9.5 min staleness threshold, same RPC.

### Client-side cadence (respects `INTERVALS` in js/config.js)

| Feed | Source | Cadence |
|------|--------|---------|
| Solar wind + IMF, full day | NOAA RTSW wind+mag, browser-direct | on load, re-sync at T3 (15 min) |
| Latest sample append | `/api/solar-wind/latest` (Supabase cache, 30 s CDN) | T1 (60 s) |
| Observed Dst (24 h) | NOAA `kyoto-dst.json`, browser-direct | T3 (15 min) |
| Kp (plasmapause) | NOAA `planetary_k_index_1m.json`, browser-direct | T2 (5 min) |
| GOES Hp (GEO cross-check) | NOAA `goes/primary/magnetometers-1-day.json`, browser-direct, best-effort | T3 (15 min) |
| Server skill ledger | `/api/ring-current/skill` (Supabase join, 10-min CDN TTL) | T3 (15 min) |

Fallback: if browser-direct NOAA is unreachable, the feed degrades to
`/api/solar-wind/latest?series=1` (60 min) + `/api/noaa/dst` (recent
readings) — shorter window, page still live.

---

## 4. Architecture (Phase 1, this branch)

| File | Role |
|------|------|
| `js/ring-current-model.js` | Pure physics, no DOM/THREE — unit-testable. Coupling, OBM/Burton integration, pressure correction, DPS energy, radial profile, asymmetry, drift periods, storm classification, ballistic L1 propagation, skill metrics (RMSE/bias). |
| `js/ring-current-feed.js` | Data layer. Polls the feeds above, normalises fill values, assembles a merged 1-min driver series, anchors the model on observed Dst 24 h ago, re-integrates, emits `state` events. |
| `js/ring-current-globe.js` | Three.js scene: Earth (pinned three-globe CDN textures), dipole field lines, drift-animated ion/electron particle populations with Dst*-driven density + dusk-side partial-ring asymmetry, plasmapause ring. |
| `ring-current.html` | Page shell: canonical nav (`<nav></nav>` + `initNav`), HUD panels (drivers / state / forecast / validation), model-vs-observed Dst chart with forecast strip (2D canvas, no chart lib). |
| `api/ring-current/skill.js` | Published skill ledger (Phase 2b): edge function joining `ring_current_log` ↔ `geomag_indices` via service role — aggregates only, raw rows never leave. Pure core `ledgerSkillSummary` is node-tested. |
| `tests/ring-current-model.mjs` | Node physics tests (same pattern as `tests/abell85-physics.mjs`). |
| `tests/ring-current-skill-endpoint.mjs` | Node tests for the ledger join/aggregation. |

Navigation: one new entry in the **Space Weather** dropdown of `js/nav.js`
(`ring-current.html`, id `ring-current`, badge NEW). `scripts/lint-nav.mjs`
must stay green; the new page is fully compliant (no baseline entry).

Constraints honoured: flat `*.html` at root, no framework/bundler, vendored
Three.js 0.160 importmap, NOAA browser-direct / NASA via edge.

---

## 5. Visualization spec

- **Scene** (1 unit = 1 R_E, Earth at origin, Sun direction +X): textured
  Earth, faint dipole field-line cage (L = 2,3,4,5,6 × 8 MLT meridians),
  ~3,000-particle ion population (westward drift, warm colors) +
  ~1,200-particle electron population (eastward, cool colors), both weighted
  by the model's radial profile and MLT asymmetry; translucent equatorial
  torus whose opacity/thickness tracks |Dst*|; plasmapause ring from Kp.
- **HUD left — Live drivers**: v, n, Bz (GSM), Bt, Pdyn, VBs, feed freshness.
- **HUD right — Ring current state**: W_RC (J), Dst observed / Dst* model /
  Dst model (uncorrected), storm class (Quiet→Extreme, same thresholds as
  `api/noaa/dst.js`), injection Q vs decay Dst*/τ balance, τ, asymmetry %.
- **Bottom chart**: 24 h model-vs-observed Dst + shaded forecast strip
  (arrival-time propagated L1 samples), RMSE/bias over the window.
- Time-compression control for drift animation (default ~900×), pause on
  `document.hidden` (battery/API hygiene).

---

## 6. Validation

- **Unit tests (this branch)**: τ monotonicity, Q gating at Ec, steady-state
  Dst* = Q·τ under constant driving, DPS constant ≈ 4.0×10¹³ J/nT, pressure
  correction sign, integration stability, ballistic ordering, classification
  thresholds, skill metrics.
- **Live skill (this branch)**: RMSE + bias of model vs Kyoto Dst over the
  trailing 24 h, always visible on the page.
- **Phase 2 hindcast**: replay the Gannon May-2024 G5 storm through
  `/api/omni/imf` (`sym_h` field already exposed) and score model Dst against
  SYM-H — same validation frame as the existing Gannon MHD work.

---

## 7. Later phases

- **Phase 2 — persistence (LANDED 2026-07-10)**: see
  `supabase-solar-wind-enrichment-migration.sql`. The existing cron now also
  (a) batch-backfills the full-day RTSW series hourly via
  `record_solar_wind_backfill` (outage holes self-heal; the RPC only fills
  NULLs), (b) writes MAG-ONLY rows when plasma is stale but the magnetometer
  is live (speed IS NULL — the 2026-07 outage's needless Bz hole), (c)
  upserts hourly Kyoto Dst + Kp into `geomag_indices` every 15 min, and (d)
  logs the O'Brien–McPherron nowcast into `ring_current_log` using the same
  `js/ring-current-model.js` the page runs. All zero-policy-RLS
  service-role tables (intentional — advisor false positive). Newell (2007)
  coupling added to the model + page HUD (derivable from stored fields — no
  schema change).
- **Phase 2b — hindcast (LANDED)**: Gannon SYM-H replay mode on the page via
  `/api/omni/imf` (PR #914). O⁺/H⁺ composition split (2026-07-11):
  `oxygenFraction(dstStar)` in the model (Hamilton 1988 / Daglis 1999
  anchors, display-only — it partitions energy, it does NOT feed back into
  the OBM integration, whose τ fit already absorbs composition-dependent
  decay in aggregate), HUD row, and a brightness-steered H⁺/O⁺ particle
  split on the globe (species fixed at build so bounce phase never jumps;
  the ENERGY mix is steered by relative brightness). Skill-ledger panel
  (2026-07-11): `api/ring-current/skill.js` joins `ring_current_log` ↔
  `geomag_indices` server-side with the SAME `skill()` the page runs, and
  the page's "Independent validation" panel shows 24 h / 7 d RMSE+bias plus
  daily bars. Only aggregates leave the endpoint — the tables stay
  service-role-only.
- **Phase 3 — operator surface (partial)**: GOES magnetometer cross-check
  LANDED 2026-07-11 — browser-direct `json/goes/primary/magnetometers-1-day`
  (T3, best-effort), `parseGoesMag` / `goesCrossCheck` in the feed. Hp vs
  its 24 h median is an INDEPENDENT in-situ measurement, never a model
  input; disagreement renders as 'mixed' (local-time / compression), not as
  an error. REMAINING: Dst-threshold alert type (`notify_*` column +
  `js/alert-engine.js` check + `account.html` toggle, per CLAUDE.md
  heuristic — needs a `user_profiles` migration, keep it a dedicated PR),
  coupling to the LEO-drag forecast (ring-current heating → thermosphere
  density).

---

## 8. Invariants / cautions for future sessions

- The cron patch **preserves the pipeline contract** documented in
  `api/cron/refresh-solar-wind.js` — source tag, heartbeats, staleness
  window, single-RPC write. Do not "simplify" the mag merge away: plasma and
  IMF genuinely live in separate NOAA products.
- `js/ring-current-model.js` is deliberately THREE-free and DOM-free so node
  tests exercise the exact code the page runs. Keep it that way.
- The model anchors on **observed** Kyoto Dst at the start of the 24 h
  window, then free-runs. Do not re-anchor every tick — that would hide model
  error and make the skill numbers meaningless.
- Dst thresholds for storm classes intentionally mirror `api/noaa/dst.js`.
  Change them in both places or neither.
