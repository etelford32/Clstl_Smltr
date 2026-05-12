/**
 * aurora-forecast.js — short-horizon prediction of hemispheric power
 *
 * Three forecasters competing for the headline number on the SW panel.
 * They all consume an AuroraHistory and produce {north_gw, south_gw}
 * at four horizons: +1 h, +3 h, +6 h, +24 h.
 *
 *   1. Persistence
 *      "Tomorrow's aurora looks like the last sample." Floor that any
 *      smarter model has to beat. Survives Kp surges by definition
 *      *worse* than physics-aware models — that's the point.
 *
 *   2. AR(3) on log-power
 *      Fits an AR(3) to log1p(north_gw) (and separately for south).
 *      log1p tames the heavy right-tail: a quiet hour has 1-3 GW,
 *      a Kp 8 storm has 200+ GW; raw AR underweights the storm regime.
 *      Forecasts in log space, expm1's back. Auto-degrades to
 *      persistence when there are < 12 samples (~1 hour of history)
 *      or when the AR coefficients come back NaN.
 *
 *   3. Kp-blend
 *      Linear regression of log1p(power) on Kp + Bz_south, fit on the
 *      historical pairs in AuroraHistory. Forecast = use the SWPC
 *      3-day Kp forecast (already on the page) and the latest Bz to
 *      project forward. Beats raw AR at 12-24 h horizons because Kp
 *      carries the diurnal/storm rhythm AR can't see.
 *
 * Combined headline (the number the HUD shows):
 *   +1 h:  80 % AR + 20 % persistence
 *   +3 h:  60 % AR + 40 % Kp-blend
 *   +6 h:  35 % AR + 65 % Kp-blend
 *  +24 h:  10 % AR + 90 % Kp-blend
 *
 * Why blend rather than pick the single "best" model: at short horizons
 * AR is right because the system is highly autocorrelated; at long
 * horizons it walks toward its mean and is dominated by whatever Kp is
 * forecast to do. The validator (forecast-validation.js's Murphy skill)
 * will tell us if the blend weights are wrong.
 */

import { fitAR, forecastAR } from './solar-weather-forecast.js';

// Standard horizon set. 1/3/6/24 mirrors the cadence the SW panel paints
// for the Kp forecaster — keeps the visualisation symmetric across
// space-weather products.
export const AURORA_HORIZONS_H = [1, 3, 6, 24];

// Convert a single AuroraHistory sample into a {n, s, kp, bz} record
// for the regression machinery. Skips rows with non-finite power on
// either side — we don't want NaN poisoning the AR coefficients.
function _normaliseSample(s) {
    if (!s) return null;
    const n  = Number.isFinite(s.north_gw) ? Math.max(0, s.north_gw) : null;
    const so = Number.isFinite(s.south_gw) ? Math.max(0, s.south_gw) : null;
    if (n == null && so == null) return null;
    return {
        t:  s.t,
        n,
        s:  so,
        kp: Number.isFinite(s.kp) ? s.kp : null,
        bz: Number.isFinite(s.bz) ? s.bz : null,
    };
}

// ── Persistence ────────────────────────────────────────────────────────────

export function persistenceForecastAurora(history) {
    const all = (history?.all?.() ?? []).map(_normaliseSample).filter(Boolean);
    if (all.length === 0) return null;
    const last = all[all.length - 1];
    const out = {};
    for (const h of AURORA_HORIZONS_H) {
        out[h] = {
            north_gw: last.n,
            south_gw: last.s,
            sigma_n:  null,
            sigma_s:  null,
        };
    }
    return { model_id: 'aurora-persistence-v1', issued_ms: last.t, frames: out };
}

// ── AR(3) on log1p ─────────────────────────────────────────────────────────

const AR_ORDER = 3;
const MIN_SAMPLES_FOR_AR = AR_ORDER + 12;     // need >12 samples to fit stably

function _arForecastChannel(seriesGW, horizonsH, cadenceMin) {
    const series = seriesGW
        .filter(v => Number.isFinite(v))
        .map(v => Math.log1p(Math.max(0, v)));
    if (series.length < MIN_SAMPLES_FOR_AR) return null;
    const model = fitAR(series, AR_ORDER);
    // OVATION cadence is 5 minutes; horizons are in hours. Convert each
    // horizon into "AR steps" so forecastAR walks the right number of
    // recursions.
    const stepsPerHour = 60 / cadenceMin;
    const maxSteps = Math.ceil(Math.max(...horizonsH) * stepsPerHour);
    if (maxSteps <= 0) return null;
    const fc = forecastAR(model, series, maxSteps);
    const out = {};
    for (const h of horizonsH) {
        const k = Math.max(1, Math.round(h * stepsPerHour));
        const idx = Math.min(fc.mean.length - 1, k - 1);
        // Note: forecastAR's internal clamp [0, 9] is for Kp values; for
        // log-power it's a soft upper bound that effectively caps at
        // expm1(9) ≈ 8000 GW — far above any plausible auroral storm,
        // so the clamp doesn't bite.
        out[h] = {
            mean_gw:  Math.max(0, Math.expm1(fc.mean[idx])),
            sigma_gw: Math.max(0, Math.expm1(fc.sigma[idx]) - 1),
        };
    }
    return out;
}

export function arForecastAurora(history, { cadenceMin = 5 } = {}) {
    const all = (history?.all?.() ?? []).map(_normaliseSample).filter(Boolean);
    if (all.length < MIN_SAMPLES_FOR_AR) return null;
    const issued = all[all.length - 1].t;
    const N = _arForecastChannel(all.map(s => s.n), AURORA_HORIZONS_H, cadenceMin);
    const S = _arForecastChannel(all.map(s => s.s), AURORA_HORIZONS_H, cadenceMin);
    if (!N && !S) return null;
    const out = {};
    for (const h of AURORA_HORIZONS_H) {
        out[h] = {
            north_gw: N?.[h]?.mean_gw ?? null,
            south_gw: S?.[h]?.mean_gw ?? null,
            sigma_n:  N?.[h]?.sigma_gw ?? null,
            sigma_s:  S?.[h]?.sigma_gw ?? null,
        };
    }
    return { model_id: 'aurora-ar3-v1', issued_ms: issued, frames: out };
}

// ── Kp blend ───────────────────────────────────────────────────────────────
//
// log1p(power) ≈ a + b · Kp + c · max(0, -Bz)
//
// Closed-form OLS. Re-fit on every forecast call — the regression is
// O(N) over ≤ 8 K samples (30 days × 12/h), which is well under one
// frame even on mobile.

function _fitKpBlendChannel(samples, key) {
    const x1 = [], x2 = [], y = [];
    for (const s of samples) {
        const v = s[key];
        if (!Number.isFinite(v) || !Number.isFinite(s.kp)) continue;
        x1.push(s.kp);
        x2.push(Number.isFinite(s.bz) ? Math.max(0, -s.bz) : 0);
        y.push(Math.log1p(Math.max(0, v)));
    }
    if (y.length < 12) return null;
    // Simple normal-equations OLS for [a, b, c].
    let n = y.length;
    let s0 = 0, s1 = 0, s2 = 0, sy = 0;
    let s11 = 0, s12 = 0, s22 = 0, s1y = 0, s2y = 0;
    for (let i = 0; i < n; i++) {
        s0  += 1;
        s1  += x1[i];
        s2  += x2[i];
        sy  += y[i];
        s11 += x1[i] * x1[i];
        s12 += x1[i] * x2[i];
        s22 += x2[i] * x2[i];
        s1y += x1[i] * y[i];
        s2y += x2[i] * y[i];
    }
    // Solve 3x3 system  A · β = b   where
    //   A = [[n, s1, s2], [s1, s11, s12], [s2, s12, s22]]
    //   b = [sy, s1y, s2y]
    const M = [
        [s0, s1, s2, sy],
        [s1, s11, s12, s1y],
        [s2, s12, s22, s2y],
    ];
    // Gauss-Jordan (3 unknowns; partial pivoting handles zero kp/bz columns).
    for (let i = 0; i < 3; i++) {
        let piv = i;
        for (let r = i + 1; r < 3; r++) {
            if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
        }
        if (Math.abs(M[piv][i]) < 1e-9) return null;
        if (piv !== i) [M[i], M[piv]] = [M[piv], M[i]];
        for (let r = 0; r < 3; r++) {
            if (r === i) continue;
            const f = M[r][i] / M[i][i];
            for (let c = i; c < 4; c++) M[r][c] -= f * M[i][c];
        }
    }
    return [
        M[0][3] / M[0][0],
        M[1][3] / M[1][1],
        M[2][3] / M[2][2],
    ];
}

function _projectKpBlendChannel(beta, kpForward, bzForward) {
    const out = {};
    for (const h of AURORA_HORIZONS_H) {
        const kp = Number.isFinite(kpForward[h]) ? kpForward[h] : (Number.isFinite(kpForward[0]) ? kpForward[0] : 2);
        const bz = Number.isFinite(bzForward[h]) ? bzForward[h] : (Number.isFinite(bzForward[0]) ? bzForward[0] : 0);
        const yhat = beta[0] + beta[1] * kp + beta[2] * Math.max(0, -bz);
        out[h] = Math.max(0, Math.expm1(yhat));
    }
    return out;
}

/**
 * @param {object} history       AuroraHistory
 * @param {object} kpForecast    Map { 0: kpNow, 1, 3, 6, 24: kp_at_horizon }
 * @param {object} [bzForecast]  Map of Bz at each horizon (defaults to current Bz)
 */
export function kpBlendForecastAurora(history, kpForecast, bzForecast = {}) {
    const all = (history?.all?.() ?? []).map(_normaliseSample).filter(Boolean);
    if (all.length === 0 || !kpForecast) return null;
    const issued = all[all.length - 1].t;
    const betaN = _fitKpBlendChannel(all, 'n');
    const betaS = _fitKpBlendChannel(all, 's');
    if (!betaN && !betaS) return null;
    const N = betaN ? _projectKpBlendChannel(betaN, kpForecast, bzForecast) : null;
    const S = betaS ? _projectKpBlendChannel(betaS, kpForecast, bzForecast) : null;
    const out = {};
    for (const h of AURORA_HORIZONS_H) {
        out[h] = {
            north_gw: N?.[h] ?? null,
            south_gw: S?.[h] ?? null,
            sigma_n:  null,
            sigma_s:  null,
        };
    }
    return {
        model_id: 'aurora-kp-blend-v1',
        issued_ms: issued,
        frames: out,
        _meta: { betaN, betaS },
    };
}

// ── Headline blend ─────────────────────────────────────────────────────────

const BLEND_WEIGHTS = {
    1:  { ar: 0.80, kp: 0.00, persist: 0.20 },
    3:  { ar: 0.60, kp: 0.40, persist: 0.00 },
    6:  { ar: 0.35, kp: 0.65, persist: 0.00 },
    24: { ar: 0.10, kp: 0.90, persist: 0.00 },
};

function _blendOne(ar, kp, persist, w) {
    if (ar == null && kp == null && persist == null) return null;
    let num = 0, den = 0;
    if (ar      != null) { num += w.ar      * ar;      den += w.ar; }
    if (kp      != null) { num += w.kp      * kp;      den += w.kp; }
    if (persist != null) { num += w.persist * persist; den += w.persist; }
    return den > 0 ? num / den : null;
}

/**
 * One-stop call for the HUD: computes all three sub-forecasts and
 * returns the blended headline number per hemisphere per horizon.
 *
 * Returns null when there isn't enough history for any sub-model to
 * fire (i.e. the store is empty). With at least one sample, the
 * persistence path always succeeds — so the only way this returns null
 * is a fresh tab with zero ingests yet.
 */
export function forecastAurora({ history, kpForecast = null, bzForecast = null }) {
    const persist = persistenceForecastAurora(history);
    if (!persist) return null;
    const ar  = arForecastAurora(history);
    const kp  = kpForecast ? kpBlendForecastAurora(history, kpForecast, bzForecast ?? {}) : null;

    const blended = {};
    for (const h of AURORA_HORIZONS_H) {
        const w = BLEND_WEIGHTS[h];
        blended[h] = {
            north_gw: _blendOne(ar?.frames[h]?.north_gw, kp?.frames[h]?.north_gw, persist.frames[h]?.north_gw, w),
            south_gw: _blendOne(ar?.frames[h]?.south_gw, kp?.frames[h]?.south_gw, persist.frames[h]?.south_gw, w),
        };
    }
    return {
        model_id: 'aurora-blend-v1',
        issued_ms: persist.issued_ms,
        frames: blended,
        components: { ar, kp, persistence: persist },
    };
}

export default forecastAurora;
