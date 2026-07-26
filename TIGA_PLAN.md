# TIGA — status, decisions and open work

**Page:** `tiga.html` · **Kernels:** `js/geomag/*` · **Edge:** `api/geomag/observatories.js`
**Last updated:** 2026-07-26

---

## 1. What TIGA is, said precisely

TIGA (Temporally Integrated Geomagnetic Assimilation) is a **sequential Bayesian
state estimator**: a Kalman filter whose state is the degree-1 *external* Gauss
coefficients (q₁⁰, q₁¹, s₁¹) plus their rates, updated each minute from
whichever observatories reported.

It is **not a simulation.** Nothing is integrated forward physically; the
"model" is an integrated random walk, which is a statistical prior, not
dynamics.

It is **not a forecast.** Zero lead time. It does not compete with L1-driven
forecast models on their axis — it is what you have when L1 is unavailable.

**And neither is Dst.** Retain only the zonal term of the degree-1 expansion and
the cosine-weighted station average *is* the least-squares estimator of q₁⁰ —
an algebraic identity, exact to 10⁻¹⁴, checked for every station subset in
`tests/geomag-tiga.mjs`. So the distinction is not estimator-versus-index.
Everything here is an estimator; they differ in how many parameters they fit,
how they weight stations, and whether they carry a prior. **Dst is the
one-parameter, equal-weight, no-memory degenerate case.**

That identity is load-bearing three ways, and each one is a product argument:

| Because… | …therefore |
|---|---|
| the observation operator H is rebuilt every epoch from whoever is present | dropout tolerance is **architectural, not trained** — which is why the curve stays flat from 64 stations down to 3, with the knee at the fitted-parameter count |
| a Bayesian estimator emits a posterior | there is **an uncertainty to sell**. Neither Kyoto nor USGS publishes one. It is also currently miscalibrated, which makes it the headline open problem rather than a footnote |
| the estimand is a physical coefficient rather than the index | estimation error (4.97 nT) can be **separated from the index's own definition error** (11.36 nT). Estimate "SYM-H" directly and the two are inseparable |

### 1.1 The trap: two quantities are in play

TIGA estimates **q₁⁰**. It is scored against **SYM-H** — a specific six-station
arithmetic recipe that differs from q₁⁰ by ~11 nT of aliasing. Every results
table therefore carries **two RMSEs**, and **calibration must be judged against
q₁⁰**. Score a coefficient estimator against an index and you are measuring the
index. Conflating these two is the single easiest way to produce a
confident-looking wrong number here.

---

## 2. Architecture

```
js/geomag/
  igrf14-coefficients.js   IGRF-14 table, 195 coefficients × 27 epochs. DATA.
  coastlines.js            schematic outlines for the field map. DATA.
  observatories.js         Kyoto Table 1 roster + USGS IAGA codes. DATA + provenance.
  igrf.js                  ← SINGLE SOURCE OF TRUTH for field evaluation
  dipole.js                centred-dipole coords, SM frame, dipole tilt
  tiga.js                  the estimator + the classical index as its degenerate case
  core-model.js            layers, dimensionless numbers, free decay, mantle screening
  dynamo.js                Rikitake + αΩ parity selection
  osse.js                  observing-system experiment (offline, deterministic)
  ingest.js                live USGS → epochs → nowcast
api/geomag/observatories.js  USGS edge proxy
tiga.html                    the three-layer page
```

**Hard rule:** `igrf.js` is the only place field evaluation happens. Three
separate bugs in the research programme this was ported from came from
re-deriving something that already existed and getting a sign or a stride wrong.
Every other module imports it.

**Layering by timescale is the product idea**, and each layer carries an honest
label on the page:

| Layer | Timescale | What it is | Label |
|---|---|---|---|
| Core | 10³–10⁵ yr | reduced dynamo models (Rikitake, αΩ mean-field) | *model* |
| Field | 1–10² yr | IGRF-14 evaluated live, degree 13 | *observation-derived* |
| External | minutes | TIGA nowcast from live observatories | *real-time estimate* |

Only the third is real-time. **Do not let copy call any of this a geodynamo
simulation.** A real 3-D MHD dynamo needs a supercomputer and the best published
runs still sit eight orders of magnitude from Earth's Ekman number — a number
the page prints.

---

## 3. Gates

Run all five before touching anything here:

```
node tests/geomag-igrf.mjs        # analytic anchors + the two regression traps
node tests/geomag-tiga.mjs        # T1–T5, aliasing, robustness, the SM frame
node tests/geomag-core-model.mjs  # Bessel zeros, decay times, screening
node tests/geomag-dynamo.mjs      # αΩ vs the SciPy eigensolver (~40 s)
node tests/geomag-osse.mjs        # the definition floor, dropout, calibration
npx playwright test tests/tiga-smoke.spec.js
```

### 3.1 Numerical gates, all passing

| Gate | Threshold | Current |
|---|---|---|
| Pure dipole on a sphere, max/min | 2.000 ± 1e-4 | **2.000000** |
| Pure dipole on WGS-84 | = 2(a/b)³ | **2.020253** (flattening, not a bug) |
| SAA minimum, 2025 | 22,071 ± 5 nT | **22,071.4** |
| Dipole free-decay time, n = 1 | 23,884 ± 50 yr | **23,884** |
| Magnetic Reynolds number | 1135 ± 5 | **1135** |
| First zeros of jₙ vs SciPy | < 5e-4 | passes n = 1…20 |
| T3 identity: cos-average ≡ −q₁⁰ | < 1e-10 nT | **2.8e-14** |
| `designRow` ≡ paper Eq. (1) | < 1e-12 | **1.1e-16** |
| αΩ growth rates vs SciPy (N=400) | < 0.3% | passes at D = −200, −600, −1500 |
| Index definition floor | 11.36 nT | **11.36** (exact — it is deterministic) |
| Grid evaluator vs scalar path | identical | **0.0** |

### 3.2 Regression traps — each was a real bug, each fails silently

1. **Legendre stride.** Allocate at stride `NMAX+1`, never `nmax+1`. A truncated
   allocation gives silent NaN for every n < 13.
2. **Geodetic rotation sign.** `X_gd = X cos ψ + Z sin ψ`, `Z_gd = −X sin ψ + Z cos ψ`.
   A flipped sign is **exactly zero at the equator**, so an equator-only test
   passes a broken transform. Test off-equator.
3. **Coordinate tables.** Kyoto Table 1 carries both `G.M. LAT.` (centred
   dipole, what SYM-H uses) and `INVARIANT LAT.` Taking the wrong column cost
   9.35° at Hermanus and presented as a *model* error for a while. Both columns
   are kept side by side in `observatories.js` so the mistake is visible.
4. **Unlit data spheres.** Never Phong-shade a colormapped data texture — the
   lighting multiplies the values.
5. **αΩ timestep and conditioning** (new, found during this build). Two bugs:
   an analytic RK4 stability bound that was marginally too loose and produced a
   Nyquist grid mode masquerading as a growth rate of +69; and an
   ill-conditioned three-term recurrence that returned μ = 1 exactly (growth 0)
   for a genuinely decaying non-oscillatory mode. Fixed by measuring ρ(M)
   directly and guarding on the snapshot *correlation*.
6. **Convergence near an eigenvalue collision** (new). A fixed settle budget
   left the quadrupole family unconverged near |D| ≈ 220 — where two of its
   real eigenvalues collide into a complex pair — returning +3.76 for a value
   near −0.5. That single bad sample inverted the family comparison and put a
   phantom window edge at |D| ≈ 185, ten times too narrow. `familyGrowth` now
   iterates to convergence and reports `converged`; the gate asserts the margin
   changes sign exactly twice.

---

## 4. Results (OSSE — simulated; no real observatory data yet)

| Quantity | Value |
|---|---|
| Index definition floor | **11.36 nT** — irreducible; the index's own aliasing |
| TIGA estimation error in q₁⁰ | **4.97 nT** — 2.3× below the floor |
| Dropout, 64 → 3.2 stations | 4.97 → 3.25 nT — **flat across a 20× reduction** |
| Calibration, nominal 68 / 95% | **41.9 / 69.2%** — open problem |
| vs memoryless control (zonal) | 4.97 vs 5.08 nT |

(The reference implementation reported 4.30 nT of estimation error against the
same 11.36 nT floor. The floor is deterministic and reproduces exactly; the
estimation error depends on the synthetic network draw and the observation
noise, and this port uses its own PRNG, so it lands nearby rather than
identically. Structural claims are what the gates pin.)

### 4.1 Prediction scorecard — the falsifications stay in the record

| # | Prediction | Outcome |
|---|---|---|
| 2 | Excluding the canonical eleven ≫ hurts | **FALSIFIED** — gap +0.07 nT. Three parameters are already over-determined by 64 stations. |
| 3 | Flat, then steep, knee at the parameter count | **CONFIRMED** — knee at 3. |
| 4a | Sector loss worse than random loss | **CONFIRMED** — 21.5 vs 19.0 ± 0.5 nT |
| 4b | The sector penalty decays with time since loss | **FALSIFIED** — a memoryless control decays identically. The decay is the storm, not the memory. |
| 5 | Station-set-dependent bias | **CONFIRMED** — bias, not variance, is the dropout signature |

Three confirmed, two falsified. The falsifications are the useful half: each was
caught by a control or by a frozen protocol, and **none would have been visible
on real data**, where there is no truth to check against.

### 4.2 An unplanned result: station count is the wrong variable

Losing **23** clustered Europe/Africa stations *improved* the order-1 estimate;
losing **9** well-placed American stations made it much worse. The mechanism is
conditioning and it is measurable. **Longitudinal spread is the right variable**
(`longitudeClustering` in `observatories.js`, `coverageDiagnostics` in
`ingest.js`), and it gives operators an actionable criterion. For a USGS-only
network it is the binding constraint — fourteen stations, a ~14 h MLT gap.

---

## 5. Open problems — do not paper over these

- **The posterior is not calibrated.** 68% nominal covers ~42%. A rank-1
  common-mode term in R fixed most of a 25× overconfidence (2.7% → ~45%); the
  rest is open. `tests/geomag-osse.mjs` gates the shortfall *deliberately*, so
  that a change which "improves" it by widening the bars fails the gate rather
  than passing quietly.
- **The live baseline is a placeholder.** `removeBaseline` subtracts a trailing
  median. The real thing is a causal trailing-window secular-variation and S_q
  baseline per USGS OFR 2011-1030, strictly one-sided. Until that exists the
  live nowcast's *shape* is meaningful and its absolute *level* is not, and the
  page carries a PROVISIONAL badge saying exactly that.
- **TIGA loses to a memoryless filter on the order-1 terms** (−11.7% in the
  reference runs) while winning on the zonal (+8.6%). Four retunes failed to fix
  it. It is a real trade-off, not a bug: the optimal process noise scales with
  storm amplitude, so a value tuned on one storm does not transfer. That is a
  defect in the *selection design*, and the fix is a causal activity proxy
  trained on a multi-storm set — not a new constant. **It bounds the ASY-H
  ambition.** Do not retune `DEFAULT_Q_RATE` without reading its comment.
- **The OSSE draws station latitude and longitude independently**, losing the
  real island/continent correlation. The eleven canonical stations are real
  coordinates; the synthetic tail is not.

---

## 6. Milestones

- **M0 — Foundation.** ✅ Kernels ported, gates green, page shipped.
- **M1 — Reference floors.** Compute RMS(SMR − SYM-H) and quicklook-vs-final
  Dst over ≥ 5 years. *Neither exists in the literature.* Without them a
  reported RMSE has no denominator. **Blocked on network access** to SuperMAG
  (needs a logon) and on Kyoto permission for quicklook comparisons.
- **M2 — Causal S_q baseline.** Trailing-window SV and S_q, strictly causal,
  tested in isolation against a non-causal oracle. *Accept: the causal penalty
  is quantified in nT.* Predicted to dominate the real-data error budget —
  measure it before building on it.
- **M3 — Held-out-station evaluation. THE DECISION POINT.** Fit on N−1
  observatories, predict the Nth station's actual reading. *Accept: RMSE for
  leave-one-out, leave-out-Pacific, leave-out-institute.* If the forward model
  cannot predict an unseen observatory, stop — no index-level tuning will save it.
- **M4 — Live scorecard.** 30 days continuous uptime, calibrated uncertainty
  published alongside every value, rolling comparison against Kyoto as
  provisionals appear.

---

## 7. Licensing — a commercial blocker, not a technical one

The chain is: **their data (free) → our estimator → an estimate with honest
uncertainty (the product).** The data passes through; it is never resold. We are
a step in the pipeline, not a reseller.

The legal ambiguity lives in **whose machine the data lands on**:

| Shape | Status |
|---|---|
| Data through our servers → free public index | Fine, NC-compatible |
| Data through our servers → paid output | **Grey zone** — "commercial use" is undefined |
| Our software on their infrastructure, their access | **Clean** — the data never touches us. This is the enterprise shape and the least friction |

- **INTERMAGNET is CC BY-NC 4.0.** A free research index is fine; a paid API
  serving a derived index is not, without written permission from each operating
  institute — roughly fifty of them.
- **SuperMAG prohibits redistribution.**
- **Kyoto requires permission** before publishing quicklook comparisons.
- **USGS is the clean path**: fourteen observatories, effectively public domain,
  among the fastest feeds in the network. `api/geomag/observatories.js` uses
  USGS only, and that is a deliberate decision, not a stopgap. A USGS-only fit
  is a *harder* problem with worse longitude coverage — **which makes the
  dropout result more impressive, not less.**

Resolve the tier question before any paid surface ships.

---

## 8. Non-goals

- 3-D MHD geodynamo simulation.
- Claiming to predict reversals. Rikitake shows reversals need no trigger; that
  is a statement about dynamos, not a forecast.
- Forecasting SYM-H. TIGA is a nowcast with zero lead time.
- Beating the t+1h forecasting literature. Different axis; the comparison is
  meaningless in either direction.

---

## 9. Practices this work earned the hard way

1. **Verify reference data, not just code.** The worst bug in the programme was
   a correct transform fed a wrong column. Isolate the transform with analytic
   anchors; isolate the data with an independent source. `tests/geomag-tiga.mjs`
   runs T1b (transform) before T1 (data) for exactly this reason.
2. **Every comparison needs a control.** "The penalty decays with time" looked
   true until a memoryless filter decayed identically. Build the null first.
3. **Freeze the protocol before looking.** Refitting the calibration per dropout
   level made degradation look like improvement.
4. **Separate estimation error from definition error.** Scoring against an index
   that carries its own aliasing measures the index.
5. **Render it and look at it.** Three chart bugs survived correct code in the
   research programme, and two more were caught by screenshotting this page.
6. **Record falsified predictions.** They were the most informative results here.
