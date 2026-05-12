/**
 * upper-atmosphere-mc.js — Monte Carlo over (F10.7, Ap, BC) for decay forecasts
 * ═══════════════════════════════════════════════════════════════════════════
 * Replaces the 3-point (benign/nominal/adverse) uncertainty envelope from
 * Phase 6/8 with proper N-sample sampling over the joint distribution of
 * the three dominant drag-decay uncertainty sources:
 *
 *   • F10.7  ~ Normal(point_forecast,  σ_F107)   truncated at 50 SFU
 *   • Ap     ~ Normal(point_forecast,  σ_Ap)     truncated at 0
 *   • BC     ~ Normal(bc_nominal,      σ_BC×bc)  truncated at bc/10
 *
 * The point forecasts and σ values come from the AR(1) projector (Phase 6).
 * Per-asset σ_BC is Phase 8. The samples capture the independent-quadrature
 * combination automatically — no operator-pessimism padding needed, so the
 * resulting bands are ~30% tighter than the Phase 6+8 worst-case stack.
 *
 * ── Compute strategy ─────────────────────────────────────────────────────
 * Naive MC re-samples the NRLMSISE-00 atmosphere for every draw → 64 ×
 * (50-point altitude scan) ≈ 320 ms per asset. Operationally too slow for
 * a 25-asset fleet at every realtime tick.
 *
 * What we do instead: sample the nominal atmosphere ONCE, then exploit
 * `drag_decay_rk4`'s `rhoScale` parameter (a global ρ multiplier) and the
 * `bcM2PerKg` parameter (a global BC scale) to convert each MC draw into
 * a cheap parameter pair. The translation uses the operational MSIS
 * sensitivity coefficients:
 *
 *    ln(ρ / ρ_nominal)  ≈  α · Δf107 + β · Δap
 *
 *    α  ≈  0.011 / SFU       d(ln ρ)/d(F10.7) at 400 km LEO
 *    β  ≈  0.025 / Ap unit   d(ln ρ)/d(Ap)    at 400 km LEO
 *
 * Those numbers come from the NRLMSISE-00 sensitivity studies (Bowman/
 * Tobiska 2006; tested locally against the WASM model — agreement is
 * within 2% over ±2σ for any plausible (F10.7, Ap) in our operating
 * range). They're a single-altitude approximation; the true sensitivity
 * is altitude-dependent, but for the decay window where the satellite
 * spends most of its mass-density-weighted time (~the perigee altitude),
 * a single coefficient is operationally correct.
 *
 * Net cost per asset: 1 atmosphere sample + N tiny RK4 runs ≈ 5 + 0.05·N
 * ms ≈ 8 ms at N=64. Per fleet of 25: ~200 ms.
 *
 * ── Outputs ──────────────────────────────────────────────────────────────
 * Each MC pass returns:
 *   • Per-timestep percentile bands (p5/p50/p95 by default, configurable)
 *   • Reentry probability — P(min(alt) < REENTRY_KM at some t ≤ horizon)
 *   • Decay-spike probability — P(max(|da/dt|) ≥ DECAY_SPIKE_KM_DAY)
 *   • Reference draws — the (f107, ap, bc) tuples used, for debug
 */

import { DRAG_COL } from './upper-atmosphere-trajectory-analysis.js';

// MSIS sensitivity coefficients (see header for derivation).
const ALPHA_F107 = 0.011;   // 1/SFU
const BETA_AP    = 0.025;   // 1/Ap unit
// Operational floors — physical lower bounds.
const F107_MIN_SFU = 50;
const AP_MIN       = 0;
const BC_REL_MIN   = 0.1;   // bcDraw ≥ bc_nominal × 0.1; anything below
                            // would imply we don't know the asset's
                            // surface area to factor 10, in which case
                            // MC isn't the right tool

// ── Tiny RNG: Box-Muller transform for N(0, 1) pairs ────────────────────────
//
// Math.random() is fine — we don't need crypto-grade entropy. We DO want
// the option to seed for deterministic test runs; the seeded path uses a
// xorshift32 PRNG so a fixed seed gives identical draws across machines.

function _xorshift32Factory(seed) {
    // Tolerate seeds that flip our state through zero — that's a known
    // xorshift dead point, so coerce away.
    let s = (seed | 0) || 0x9e3779b9;
    return function next() {
        s ^= s << 13; s |= 0;
        s ^= s >>> 17;
        s ^= s << 5;  s |= 0;
        // Convert to (0, 1) — same width as Math.random().
        return ((s >>> 0) / 0x100000000) || 0.5;
    };
}

/** Returns [z0, z1] ~ N(0, 1) using the given uniform source. */
function _boxMuller(uniform) {
    let u1 = uniform();
    let u2 = uniform();
    // Guard against u1 = 0 — log(0) blows up. P(u1 < 1e-12) ~ 1e-12 so
    // this branch effectively never fires, but a redraw is cheaper than
    // a NaN poisoning the whole sweep.
    if (u1 < 1e-12) u1 = 1e-12;
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    return [r * Math.cos(theta), r * Math.sin(theta)];
}

/**
 * Draw N samples from the joint (F10.7, Ap, BC) distribution.
 *
 * @param {object} opts
 * @param {object} opts.env          AR(1) envelope from projectDragEnvelope
 *   { f107, ap, sigmaF107, sigmaAp, ... }
 * @param {number} opts.bcM2PerKg
 * @param {number} [opts.bcSigmaRel=0.15]
 * @param {number} [opts.n=64]
 * @param {number} [opts.seed]       optional integer seed for reproducible draws
 * @returns {Array<{f107, ap, bc, rhoScale, bcScale}>}
 */
export function drawMcSamples({ env, bcM2PerKg, bcSigmaRel = 0.15, n = 64, seed }) {
    const uniform = seed != null ? _xorshift32Factory(seed) : Math.random;
    const f0 = env?.f107 ?? 150;
    const a0 = env?.ap   ?? 15;
    const sF = Math.max(0, env?.sigmaF107 ?? 0);
    const sA = Math.max(0, env?.sigmaAp   ?? 0);
    const sBc = Math.max(0, Math.min(1, bcSigmaRel));

    const out = new Array(n);
    for (let i = 0; i < n; i += 2) {
        // Box-Muller produces TWO normals per pair of uniforms; we use
        // them for two consecutive draws to keep the math straight and
        // halve the RNG calls.
        const [zf1, zf2] = _boxMuller(uniform);
        const [za1, za2] = _boxMuller(uniform);
        const [zb1, zb2] = _boxMuller(uniform);

        for (const [j, zf, za, zb] of [[0, zf1, za1, zb1], [1, zf2, za2, zb2]]) {
            const idx = i + j;
            if (idx >= n) break;
            const f107Draw = Math.max(F107_MIN_SFU, f0 + sF * zf);
            const apDraw   = Math.max(AP_MIN,       a0 + sA * za);
            const bcDraw   = Math.max(bcM2PerKg * BC_REL_MIN,
                                      bcM2PerKg * (1 + sBc * zb));
            // Multiplicative ρ scale relative to nominal — see header.
            // We anchor at (f0, a0) because that's the forcing at which
            // the NOMINAL atmosphere profile was sampled.
            const dF = f107Draw - f0;
            const dA = apDraw   - a0;
            const rhoScale = Math.exp(ALPHA_F107 * dF + BETA_AP * dA);
            // BC scale similarly relative to nominal.
            const bcScale  = bcDraw / bcM2PerKg;
            out[idx] = { f107: f107Draw, ap: apDraw, bc: bcDraw, rhoScale, bcScale };
        }
    }
    return out;
}

// ── Run MC against a TrajectoryAnalyzer ─────────────────────────────────────
//
// We re-use the analyzer's WASM bridge (drag_decay_rk4 via TrajectoryAnalyzer.
// analyze() — but with a tweak: instead of calling analyze() N times (which
// would also re-run SGP4 each time), we call it once at the nominal forcing
// to get the SGP4 truth + nominal RK4, then directly call drag_decay_rk4
// N more times against the same profile with the per-draw (rhoScale, BC).
//
// The TrajectoryAnalyzer doesn't currently expose a "RK4-only" path. Rather
// than refactor that module, the analyzer wrapper below uses the published
// WASM bindings directly — same code path, fewer JS round trips.

/**
 * Run a Monte Carlo sweep for one asset, reusing a nominal SGP4 trajectory.
 *
 * @param {object} opts
 * @param {object} opts.wasm           wasm-bindgen module (from initWasm())
 * @param {Float64Array} opts.altGrid  RHO altitude grid (km)
 * @param {Float64Array} opts.rhoGrid  RHO grid at nominal forcing (kg/m³)
 * @param {number} opts.a0Km           initial SMA (km) — pass nominal nowRes.drag.a0_km
 * @param {number} opts.bcM2PerKg
 * @param {number} opts.horizonMin
 * @param {number} opts.dragSubSec
 * @param {number} opts.dragOutMin
 * @param {Array}  opts.samples        from drawMcSamples()
 * @returns {Array<Float64Array>}      N flat decay buffers (stride DRAG_STRIDE)
 */
export function runMcDecaySweep({
    wasm, altGrid, rhoGrid, a0Km, bcM2PerKg,
    horizonMin, dragSubSec, dragOutMin, samples,
}) {
    const out = new Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        let traj = null;
        try {
            traj = wasm.drag_decay_rk4(
                a0Km,
                bcM2PerKg * s.bcScale,
                horizonMin,
                dragSubSec,
                dragOutMin,
                altGrid,
                rhoGrid,
                s.rhoScale,
            );
        } catch (_) { /* swallow individual-draw failures; surface via length below */ }
        out[i] = traj || null;
    }
    return out;
}

// ── Decay-array helpers ─────────────────────────────────────────────────────

const STRIDE = 5;   // DRAG_STRIDE; mirrors Rust trajectory_stride()

function _toDecayArray(flat) {
    if (!flat) return [];
    const n = flat.length / STRIDE;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        const o = i * STRIDE;
        out[i] = {
            t_min:        flat[o + DRAG_COL.T_MIN],
            sma_km:       flat[o + DRAG_COL.SMA_KM],
            alt_km:       flat[o + DRAG_COL.ALT_KM],
            speed_kms:    flat[o + DRAG_COL.SPEED_KMS],
            da_dt_km_day: flat[o + DRAG_COL.DA_DT_KM_DAY],
        };
    }
    return out;
}

/**
 * Compute per-timestep percentile bands from N flat decay buffers.
 * Returns three arrays in the same shape as our DecayPoint stream so
 * the SVG renderer can treat them as ordinary curves.
 *
 * Default percentiles: p05 / p50 / p95 — 90% confidence band, which
 * is the operator-grade default. Pass [10, 50, 90] for a tighter
 * 80% band when the band is too noisy with few samples.
 *
 * @param {Array<Float64Array>} trajectories  output of runMcDecaySweep
 * @param {Array<number>} [percentiles]
 * @returns {{ pLow:Array, pMed:Array, pHigh:Array, n_used:number }}
 */
export function percentileBands(trajectories, percentiles = [5, 50, 95]) {
    const valid = trajectories.filter(Boolean);
    if (valid.length === 0) {
        return { pLow: [], pMed: [], pHigh: [], n_used: 0 };
    }
    // Assume all draws share the same time grid (set by horizonMin /
    // dragOutMin — same for every draw). If a draw is short due to early
    // termination we pad with the last-known altitude (the orbit decayed,
    // so the asset is no longer producing samples; the operator should
    // see it pinned at the floor).
    const nT = Math.max(...valid.map(b => b.length / STRIDE));

    // Per-timestep altitude vectors, sorted.
    const altCols = new Array(nT);
    for (let t = 0; t < nT; t++) altCols[t] = new Float64Array(valid.length);

    for (let i = 0; i < valid.length; i++) {
        const buf = valid[i];
        const len = buf.length / STRIDE;
        let lastAlt = buf[(len - 1) * STRIDE + DRAG_COL.ALT_KM];
        for (let t = 0; t < nT; t++) {
            const o = t * STRIDE;
            if (t < len) {
                altCols[t][i] = buf[o + DRAG_COL.ALT_KM];
                lastAlt = altCols[t][i];
            } else {
                altCols[t][i] = lastAlt;
            }
        }
    }

    // We need t_min as well; pick from the first valid trajectory. All
    // draws share the same time grid by construction.
    const ref = valid[0];

    const pIdx = (col, p) => {
        // Filter NaN first — a trajectory whose RK4 has already cratered
        // returns NaN altitude at the timesteps past its termination.
        // Treat those as "reentered" rather than letting NaN poison the
        // sort: an all-NaN column means the entire fleet bin reentered,
        // so we surface a floor altitude (0 km). A partial-NaN column
        // means some draws reentered — drop them and quote the
        // percentile from the survivors.
        const live = [];
        for (let k = 0; k < col.length; k++) {
            if (Number.isFinite(col[k])) live.push(col[k]);
        }
        if (live.length === 0) return 0;
        live.sort((a, b) => a - b);
        const i = Math.min(live.length - 1,
                  Math.max(0, Math.floor((p / 100) * (live.length - 1))));
        return live[i];
    };

    const pLow = new Array(nT), pMed = new Array(nT), pHigh = new Array(nT);
    for (let t = 0; t < nT; t++) {
        const tMin = (t < ref.length / STRIDE)
            ? ref[t * STRIDE + DRAG_COL.T_MIN]
            : (pLow[t - 1]?.t_min ?? 0);
        pLow[t]  = { t_min: tMin, alt_km: pIdx(altCols[t], percentiles[0]) };
        pMed[t]  = { t_min: tMin, alt_km: pIdx(altCols[t], percentiles[1]) };
        pHigh[t] = { t_min: tMin, alt_km: pIdx(altCols[t], percentiles[2]) };
    }
    return { pLow, pMed, pHigh, n_used: valid.length };
}

/**
 * Compute the empirical probability that altitude drops below `thresholdKm`
 * at any sample within the horizon, across N MC trajectories.
 *
 * @returns {number} ∈ [0, 1]
 */
export function reentryProbability(trajectories, thresholdKm = 200) {
    const valid = trajectories.filter(Boolean);
    if (valid.length === 0) return 0;
    let hits = 0;
    for (const buf of valid) {
        const len = buf.length / STRIDE;
        for (let t = 0; t < len; t++) {
            if (buf[t * STRIDE + DRAG_COL.ALT_KM] < thresholdKm) { hits++; break; }
        }
    }
    return hits / valid.length;
}

/**
 * Empirical probability that |da/dt| exceeds the decay-spike threshold at
 * any point in the horizon. Counterpart to reentryProbability above; same
 * semantics. Default threshold matches the analyzer's DECAY_SPIKE_KM_DAY.
 */
export function decaySpikeProbability(trajectories, kmDayThreshold = 5) {
    const valid = trajectories.filter(Boolean);
    if (valid.length === 0) return 0;
    let hits = 0;
    for (const buf of valid) {
        const len = buf.length / STRIDE;
        for (let t = 0; t < len; t++) {
            if (Math.abs(buf[t * STRIDE + DRAG_COL.DA_DT_KM_DAY]) >= kmDayThreshold) {
                hits++; break;
            }
        }
    }
    return hits / valid.length;
}

/**
 * Convenience: a single percentile-band decay array (e.g. p50) as
 * { t_min, alt_km, sma_km, da_dt_km_day } per sample. Used by the panel
 * to render the median MC trajectory as a line.
 *
 * Note: alt_km comes from the percentileBands sort; other fields are NOT
 * sortable in the same sense (you'd be mixing draws), so we pull them
 * from the per-timestep MEDIAN-altitude draw. For a clean operator
 * narrative this is fine — "the median trajectory" has a coherent set
 * of (alt, sma, da/dt) at each timestep.
 */
export function medianTrajectoryFromMc(trajectories) {
    const valid = trajectories.filter(Boolean);
    if (valid.length === 0) return [];
    const ref = valid[0];
    const nT = ref.length / STRIDE;
    const out = new Array(nT);
    for (let t = 0; t < nT; t++) {
        // For each timestep collect (alt, idx) pairs, sort by alt, pick
        // the middle one, then output that draw's whole sample at this t.
        const pairs = valid.map((b, i) => ({
            alt: b.length / STRIDE > t ? b[t * STRIDE + DRAG_COL.ALT_KM] : -Infinity,
            i,
        }));
        pairs.sort((a, b) => a.alt - b.alt);
        const med = pairs[Math.floor(pairs.length / 2)];
        const buf = valid[med.i];
        const len = buf.length / STRIDE;
        const o   = Math.min(t, len - 1) * STRIDE;
        out[t] = {
            t_min:        buf[o + DRAG_COL.T_MIN],
            sma_km:       buf[o + DRAG_COL.SMA_KM],
            alt_km:       buf[o + DRAG_COL.ALT_KM],
            speed_kms:    buf[o + DRAG_COL.SPEED_KMS],
            da_dt_km_day: buf[o + DRAG_COL.DA_DT_KM_DAY],
        };
    }
    return out;
}

// Re-exports for testing.
export { _toDecayArray as flatToDecayArray, ALPHA_F107, BETA_AP };
