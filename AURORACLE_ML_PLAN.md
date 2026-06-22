# AurOracle — data-analytics & ML prediction review

> Companion to `WEATHER_PREDICTIVE_ANALYTICS_PLAN.md` and
> `EARTH_ML_FIRST_PRINCIPLES.md`, scoped to the **aurora** product.
> AurOracle (`auroracle.html`, controller `js/auroracle.js`) is the consumer
> intro landing page — a public teaser that **unlocks** the full live data +
> model breakdown for the **Basic+** tier (the $9.99/mo intro, mapped to the
> existing `basic` plan; see the `auroracle`→`basic` alias in `signup.html`).
>
> **House rule (CLAUDE.md §7):** physics-first, not a black box. Every number
> AurOracle shows must trace to a driver (Kp, Bz, OVATION power, a coronal
> hole) or to a named, scoreable model — never to "AI magic." This document
> keeps that honest.

---

## 0. TL;DR of what shipped in this PR

| Surface | Audience | Source |
|---|---|---|
| Tonight + best-night odds, 7-night week | everyone (teaser); nights 4–7 frosted for free | first-principles odds model (geomag-lat vs oval-edge vs Kp) |
| Live Kp patch of nights 1–3 | everyone | `/api/noaa/forecast-3day` |
| 30-day recurrence outlook + "on the horizon" | **Basic+** | 27-day recurrence model + `/api/hek/coronal-holes` |
| **Forecast ensemble** (Persistence / AR(3) / Kp-blend / Blend + spread) | **Basic+** | `js/aurora-forecast.js` over live OVATION `AuroraHistory` |
| **Probability of exceedance** (interactive Kp-threshold slider) | **Basic+** (computed for all, gated visually) | normal CDF over the forecast Kp median ± spread |
| **Live drivers** (hemispheric power, IMF Bz, Kp trend, dominant coronal hole) | **Basic+** | `/api/noaa/aurora`, NOAA RTSW wind, `/api/hek/coronal-holes` |
| **Custom alerts** (email + Kp threshold) | **Basic+** | `/api/subscribe/aurora` (existing `aurora_subscribers` plumbing) |

The teaser is intentionally first-principles so it renders instantly with zero
data dependencies and works signed-out. The ML/analytics layer **hydrates only
on unlock** and grows sharper the longer the page is open (OVATION ingests every
5 min into the 30-day `AuroraHistory` ring).

---

## 1. The engine we already have (`js/aurora-forecast.js`)

A genuine multi-model ensemble — **not** a placeholder. It consumes an
`AuroraHistory` (north/south hemispheric power in GW, concurrent Kp + Bz) and a
forward Kp map, and produces 1/3/6/24-hour forecasts of hemispheric power.

**Members**
- **Persistence** — naïve "tonight ≈ now." The reference everything is scored against.
- **AR(3)** — autoregression on `log1p(power)` (heavy right tail tamed in log space), re-fit on every call over in-memory history.
- **Kp-blend** — OLS of `log1p(power)` on `Kp` and `max(0,−Bz)`, projected onto the forward Kp/Bz.
- **Blend** — horizon-weighted combination: ~80% AR at +1h → ~90% Kp-blend at +24h (short horizons trust momentum, long horizons trust the driver).

**Strengths**
- Three *independent* signals → their disagreement is a real, free uncertainty estimate (surfaced as "ensemble agreement" in the panel).
- Log-space handling is correct for a quantity that swings from ~3 GW (quiet) to 200+ GW (G5).
- Cheap: closed-form OLS on ≤8K samples, runs client-side in <10 ms.

**Limitations (what the roadmap below targets)**
- AR(3) needs history; on a cold first visit it collapses toward persistence. (Mitigation shipped: keep the page open / return visits accumulate a real series in IndexedDB.)
- Blend weights are **fixed by horizon**, not *learned* — there is no live skill scoring yet, so we cannot yet say "Kp-blend is currently beating persistence by X%."
- Power → *visibility-from-your-sky* is done by the separate first-principles odds model, not the engine. Unifying them (power → local oval → odds) is future work.

---

## 2. Data-analytics layer for users (shipped + near-term)

**Shipped**
1. **Ensemble table** — per-model power at each horizon + blended value + spread. The "physics shown."
2. **Ensemble-agreement chip** — Tight / Moderate / Wide from the coefficient of variation across members. An honest confidence proxy *today*, with no new backend.
3. **Probability-of-exceedance** — `P(Kp ≥ threshold tonight)` from a normal fit to the forecast median ± spread, with an interactive threshold slider defaulted to the user's visibility Kp. Answers the question users actually ask: *"will my sky light up?"*
4. **Live drivers** — the causal chain (southward Bz couples energy → power rises → oval expands equatorward), shown as labeled chips, color-coded by severity.

**Near-term (no new ML, small lifts)**
- **Per-location calibration** of the power→odds map using the user's saved location history (was last night's "Possible" actually seen?).
- **"Why this call" expander** — one sentence generated from the dominant driver each refresh.
- **Forecast-vs-observed strip** — once the accumulator (§3) exists, show last 7 days of AurOracle's own calls against what NOAA observed. Trust is earned by showing the misses.

---

## 3. ML prediction roadmap (aurora-specialized)

Adapted from the two parent plans. Ordered by leverage-per-effort.

### Phase A — Accumulator (prerequisite for everything else)
*From `EARTH_ML_FIRST_PRINCIPLES.md` "record before predict."*
- Log every AurOracle forecast (model_id, issued_at, horizon, mean, sigma, location bucket) to `forecast_log`, plus the matching OVATION/Kp observation when it lands.
- Hot ring in IndexedDB client-side (already have `AuroraHistory`); cold archive via a daily cron to Supabase + R2, keyed `(feed_id, YYYY/MM/DD/HH, sha)`.
- **Unlocks:** replay, offline re-scoring, and honest skill numbers.

### Phase B — Skill leaderboard + confidence
*From `WEATHER_PREDICTIVE_ANALYTICS_PLAN.md` A4/B3.*
- `GET /api/forecast/skill` → per-horizon MAE and **Murphy skill vs persistence** for each member.
- Replace the static blend weights with **skill-weighted blending**, recomputed nightly.
- Upgrade the agreement chip to a real **calibrated confidence** (does the 80% band contain truth 80% of the time?).

### Phase C — Probability endpoint
*From `WEATHER_PREDICTIVE_ANALYTICS_PLAN.md` B1.*
- `POST /api/forecast/probability` for structured queries: *"P(hemispheric power > 50 GW in the next 6 h)"*, integrating the tail across the window: `P = 1 − Π(1 − P_h)`.
- Anonymous rate-limit (5 min/IP, soft freeze) so it stays a conversion hook, not an abuse vector.

### Phase D — Unusual methodologies (research track, ship the cheap wins)
*From `EARTH_ML_FIRST_PRINCIPLES.md` §4 — each becomes a scoreable `model_id` on the same leaderboard, so it only ships if it beats persistence.*
- **D1 Reservoir computing (ESN)** — ~1K-neuron echo-state network, only the linear readout trained; closed-form solve in ~10 ms in JS. Strong candidate for the 1–6 h horizon where AR(3) is weak on a cold start.
- **D2 Symbolic regression** — search for a human-readable `power = f(Kp, Bz, dBz/dt, hole_area)` law. Goal: rediscover the coupling, not just fit it. Auditable by definition.
- **D3 LLM-as-feature-namer (Claude, logged as a model_id)** — every 6 h, classify the solar-wind regime ("CH-HSS onset", "CME sheath", "quiet") and use it to *gate* which member the blend trusts. Cost-capped ≤10K tokens/day with prompt caching; scored gated-vs-ungated like any other model.

### Phase E — Physics unification
- Replace the dual model (engine power + first-principles odds) with one chain: forecast power → infer instantaneous oval boundary (OVATION-style) → integrate visibility for the user's exact lat/lon and local sky conditions (cloud cover from the existing weather feed via `js/local-sky.js`). This is the differentiator: **odds for *your* backyard, with the physics shown.**

---

## 4. Gating & funnel

- **Access:** `tierLevel(plan, role) >= 2` (basic/educator/advanced/institution/enterprise/tester/admin). Free + signed-out get the teaser. Re-evaluated live on the `auth-changed` event.
- **Conversion telemetry:** every CTA carries `data-funnel-cta="auroracle_*"` (banner, mid, lede, unlock-month/model/alerts, final). Tie these into the existing auth-funnel so we can see which lock drives sign-ups.
- **Pricing decision (this PR):** AurOracle intro == Basic ($10/mo, presented as $9.99 intro). No `plan` enum change — keeps the DB consumer-shaped surface stable (CLAUDE.md §6/§9). Revisit only if AurOracle becomes a distinct SKU.

---

## 5. Open questions for the product owner

1. Should the teaser expose **night 1–3** odds to signed-out users, or require a free account even for those? (Currently: fully public.)
2. Do we want a **free-account middle tier** (save one location, tonight-only) between the public teaser and Basic, to capture sign-ups before the paywall?
3. Alerts currently reuse the anonymous `aurora_subscribers` email path. For signed-in users, should they instead flow through the authenticated `notify_*` columns + `js/alert-engine.js` so they live in the account's notification center?

## 6. Build spec — historically-driven month + daily Kp-LSTM (locked plan)

> Operationalises §3 (Phases A/B) plus a new **month-forecast track**. Replaces
> the synthetic month in `js/auroracle.js` `buildMonth()` (hard-coded gaussians,
> days 7–29) with a real, observation/recurrence-driven outlook, then layers a
> trained Kp-LSTM **as a scored member that must beat the baseline** before it
> touches a user-visible number.

**Decisions (2026-06-22 session — locked):**
1. **Baseline first, LSTM second.** Ship the historically-driven month now;
   the LSTM is added only where the skill leaderboard says it beats it.
2. **Server-side cron + Supabase cache.** The Kp outlook is *global* (only the
   per-sky scoring is local), so it's computed once per cycle and shared — not
   run per-browser.
3. **New daily Kp-LSTM, hourly model untouched.** A bespoke daily-cadence net
   for 1–30 d; `js/solar-lstm.js` / `sun.html` (0–24 h live HUD) is left alone.

### Why a month-out LSTM is *not* the headline (read before "making it accurate")
Geomagnetic activity past ~7 days is recurrence-dominated and intrinsically
low-skill — NOAA's own 27-day outlook is recurrence, not dynamics. So the
honest accuracy gains are: **days 1–7** (near-term Kp trajectory) and
**modulating the recurrence amplitude** (is the recurrent CH-HSS strengthening
or decaying rotation-over-rotation?). We do not claim to pin day 23. "Tendency,
not a timeline" stays on the chart.

### Phase 1 — Historically-driven month (no ML) — *the immediate win*
**Data (all already proxied):**
- **NOAA 45-day Ap forecast** via `api/noaa/ap-history.js` (`45-day-ap-forecast.txt`,
  observed + predicted 3-h Ap). Convert Ap→Kp by inverting the canonical table in
  `js/upper-atmosphere-engine.js` (`kpToAp`); daily-aggregate to daily-max Kp.
- **27-day recurrence analog** from the observed planetary-K record (~60–90 d),
  superposed at +27 d / +54 d, amplitude-weighted by the `f107-history` trend.
- **Climatology CI** conditioned on the current F10.7 / solar-cycle phase.

**Compute & serve:**
- `api/cron/aurora-outlook.js` (new; ~every 6 h) computes a 30-day daily Kp
  **p10/p50/p90** + per-day driver attribution and upserts to a cache table
  `aurora_outlook_cache` (proposed: `made_at, valid_date, kp_p10/p50/p90,
  dominant_driver, source_blend jsonb`). Register in `vercel.json` crons.
- `api/aurora/outlook.js` (new; GET) reads the cache (browser-direct, cached).
- `js/auroracle.js`: `buildMonth()` + the back half of `buildWeek()` consume
  `/api/aurora/outlook`, **falling back to the current synthetic model on any
  fetch failure** (teaser stays instant). Each chart point carries its driver
  label ("NOAA 45-day" / "27-day recurrence" / "climatology").

### Phase 2 — Score the baseline (prerequisite for any ML)
- Log daily-median Kp predictions to `forecast_log` via `api/forecast/log.js`,
  `field: 'kp_planetary'`, `model_id ∈ {aurora-noaa45-v1, aurora-recurrence-v1,
  aurora-month-blend-v1}`. The archive cron + `js/forecast-validation.js`
  back-fill observations and compute **Murphy skill vs persistence**.
- Surface "vs persistence / vs recurrence" skill + a public "called X of last Y
  nights" badge in the model-breakdown panel.

### Phase 3 — Daily Kp-LSTM (mirror the proven weather-LSTM path)
**Train — `scripts/train_aurora_kp_lstm/`** (mirrors `scripts/train_weather_lstm/`):
- `data.py`: GFZ Potsdam Kp/ap (3-hourly, **1932–present, ~770k pts**) + F10.7
  (1947–) + SILSO sunspot. Daily features:
  `[Kp_norm, Kp@−27d, Kp@−54d, F107_norm, F107_81d_norm, sin(doy), cos(doy), cycle_phase]`.
- `model.py`: encoder-LSTM (hidden ≈48) over `seq_len ≈ 81` days (3 rotations)
  → **direct 30-day × 3-quantile head** (pinball loss). Direct multi-horizon +
  daily cadence avoids the autoregressive error blow-up of rolling an hourly
  net 720 steps; **recurrence-as-input** means it learns the *correction on
  physics*, not the 27-day period from scratch.
- `export.py`: serialise to `js/aurora-kp-lstm-weights.json` in the same fused-
  gate JSON shape `solar-lstm.js` consumes. `train.py`: walk-forward backtest
  (never train on the future), report skill vs persistence + recurrence.

**Infer — `js/aurora-kp-lstm.js`** (forward pass like `solar-lstm.js`, inference
only): loaded by `api/cron/aurora-outlook.js`, run on the latest daily window.
Outlook blend = **skill-weighted** combo of {noaa45, recurrence, kp-lstm}; the
LSTM contributes only at horizons where its rolling score beats baseline.
Retrain monthly (manual or a scheduled GitHub Action); commit new weights.

### Phase 4 — Calibration + unification
Calibrated quantiles (80% band contains truth ~80% of the time), nightly skill-
weighted reblend, and the power→oval→your-sky chain (§3 Phase E).

### Guardrails
- Teaser stays instant: outlook fetch is best-effort with synthetic fallback.
- No heavy ML in the browser or the request path; inference is server-side in
  the cron, weights are a small JSON. Browser does inference-only at most.
- Every number traces to a driver or a scored `model_id`. No black box.
- Do **not** modify `js/solar-lstm.js` / `sun.html` (anti-regression, CLAUDE.md §5).

*Last updated: 2026-06-22.*
