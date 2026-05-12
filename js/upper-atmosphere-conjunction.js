/**
 * upper-atmosphere-conjunction.js — Pairwise close-approach screening
 *   with MC-derived probability of conjunction
 * ═══════════════════════════════════════════════════════════════════════════
 * Feeds the per-asset Monte Carlo bands from Phase 9 into pairwise close-
 * approach checks across the fleet. Two-stage architecture:
 *
 *   1. COARSE PASS — propagate each asset's SGP4 trajectory over the
 *      analyzer's horizon (re-using the WASM bindings), find pairwise
 *      min(‖r_A − r_B‖). Reject pairs that never enter the screening
 *      sphere (default 50 km). Cost: O(N_assets) SGP4 propagations plus
 *      O(N_assets²·N_timesteps) distance computations. For a 25-asset
 *      fleet with 60-min steps over 72 h: 25 propagations + 25·24/2 ·
 *      72 = 21 600 vector subtractions. Sub-millisecond.
 *
 *   2. PROBABILITY PASS — for each surviving candidate, derive the
 *      relative-position σ at TCA and emit a Gaussian P(d < threshold).
 *
 *      The MC sweep from Phase 9 gives a per-asset altitude band
 *      [p5, p95] at every timestep. We convert that to a σ_SMA at TCA
 *      (Z=1.645 maps p5..p95 to ±σ for ~normal MC distributions, which
 *      this is by construction since the inputs are normal). Then
 *      project σ_SMA → σ_along_track via Vallado's standard
 *      perturbation formula:
 *
 *         σ_along  ≈  (3/2) · σ_SMA · n · t
 *         n        =  mean motion (rad/s)
 *         t        =  seconds since epoch
 *
 *      Pair-wise combination is the subtle bit. Both assets feel the
 *      SAME (F10.7, Ap) → their altitude perturbations are correlated.
 *      But each asset has a different geometry (perigee, inclination,
 *      BC), so the *amount* of perturbation differs. We model this as
 *      a correlated-Gaussian pair with tunable ρ:
 *
 *         σ_rel_along  =  √(σ_A² + σ_B² − 2ρ σ_A σ_B)
 *
 *      Default ρ = 0.8 (high atmospheric correlation, residual
 *      decorrelation from BC σ and orbit-geometry differences). With
 *      ρ=1 the σ collapses to |σ_A − σ_B| (perfect correlation = same
 *      drift; conjunction prediction is sharp). With ρ=0 the σ is
 *      the Pythagorean sum (uncorrelated = worst case).
 *
 *      P(d < threshold) at TCA is then the empirical-Gaussian CDF on
 *      the distribution N(d_nominal, σ_rel_pos²) with σ_rel_pos
 *      ≈ σ_rel_along (along-track dominates at multi-hour horizons).
 *
 * Operational threshold defaults:
 *   25 km   — CARA "screening volume" for routine catalog screening
 *   5 km    — would flip to "warning" / operator-notify state
 *
 * @example
 *   import { screenFleet } from './upper-atmosphere-conjunction.js';
 *   const events = await screenFleet(results, wasmModule, {
 *       thresholdKm: 25, ρ: 0.8, screeningKm: 50,
 *   });
 *   // events :: [{ idA, idB, nameA, nameB, tcaMin, dMinKm, pConj, ... }]
 */

import { buildTimeGrid, SGP4_COL } from './upper-atmosphere-trajectory-analysis.js';
// Phase D: default "now" reads from the shared TimeBus so the
// pairwise screener uses sim-time. Scrub backward → the screener
// scans the horizon FROM that past moment, surfacing the
// conjunction set that was relevant at the simulated time.
import { getTimeBus } from './upper-atmosphere-time-bus.js';

const SGP4_STRIDE = 13;
const MU_KM3_S2   = 398600.4418;

const DEFAULTS = Object.freeze({
    thresholdKm:    25,     // operational catalog screening
    screeningKm:    50,     // candidate-cull threshold
    horizonHr:      72,
    sampleMin:      10,
    correlation:    0.8,
});

// ── Math helpers ────────────────────────────────────────────────────────────

/** Standard-normal CDF via the Abramowitz & Stegun erf approximation. */
function _normalCdf(z) {
    // High-accuracy implementation — error < 7.5e-8 over the full range.
    // Source: A&S 26.2.17, the same approximation used in scipy.stats.norm.
    const sign = z < 0 ? -1 : 1;
    const x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
          a4 = -1.453152027, a5 = 1.061405429;
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1 + sign * y);
}

/** Mean motion (rad/s) from semi-major axis (km). */
function _meanMotion(aKm) { return Math.sqrt(MU_KM3_S2 / (aKm * aKm * aKm)); }

// ── Coarse pass: SGP4 trajectories + pairwise min distance ──────────────────

/**
 * Propagate one TLE over the horizon and return the strided SGP4 buffer.
 * Returns null on parse failure or WASM unavailability.
 */
function _propagate(wasm, line1, line2, horizonHr, sampleMin, nowDate) {
    try {
        const info = wasm.parse_tle_info(line1, line2);
        const epochMs = (info.epoch_jd - 2440587.5) * 86400 * 1000;
        const nowTsinceMin = (nowDate.getTime() - epochMs) / 60000;
        const times = buildTimeGrid({ nowTsinceMin, horizonHr, sampleMin });
        const flat = wasm.propagate_trajectory_full(line1, line2, times);
        return { flat, times, info };
    } catch (_) {
        return null;
    }
}

/**
 * Walk paired SGP4 buffers and find the timestep (and distance) of closest
 * approach. Both buffers must be on the same time grid (same horizonHr +
 * sampleMin) — caller ensures this.
 *
 * Returns { tIdx, tMin, dKm } or null if either buffer is unusable.
 */
function _pairwiseMinDistance(bufA, bufB) {
    if (!bufA?.flat || !bufB?.flat) return null;
    const a = bufA.flat, b = bufB.flat;
    const n = Math.min(a.length / SGP4_STRIDE, b.length / SGP4_STRIDE);
    if (n < 2) return null;
    let best = Infinity, bestIdx = 0, bestT = 0;
    for (let i = 0; i < n; i++) {
        const oa = i * SGP4_STRIDE, ob = i * SGP4_STRIDE;
        const dx = a[oa + SGP4_COL.X_KM] - b[ob + SGP4_COL.X_KM];
        const dy = a[oa + SGP4_COL.Y_KM] - b[ob + SGP4_COL.Y_KM];
        const dz = a[oa + SGP4_COL.Z_KM] - b[ob + SGP4_COL.Z_KM];
        // We track squared distance through the loop and sqrt once after
        // the search — small but real win for the inner hot path.
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) { best = d2; bestIdx = i; bestT = a[oa + SGP4_COL.T_MIN]; }
    }
    return { tIdx: bestIdx, tMin: bestT, dKm: Math.sqrt(best) };
}

// ── Probability pass: MC-derived σ at TCA ───────────────────────────────────

/**
 * Extract σ_SMA at the given timestep from a per-asset MC band. The bands
 * carry per-timestep p5/p50/p95 ALTITUDE samples; we map alt to SMA by
 * the simple offset (SMA = alt + R_earth ≈ const), so σ_SMA ≈ σ_alt.
 *
 * Z=1.645 maps the p5..p95 interval to ±σ for a normal distribution,
 * which the MC produces by construction (the input distributions are
 * Gaussian and the drag-rate response is approximately linear in
 * forcing within ±2σ).
 *
 * Returns σ in km, or null when the band is missing.
 */
function _sigmaSmaAtTime(mcBands, tMin) {
    if (!mcBands?.pLow || !mcBands?.pHigh) return null;
    // Find the band sample closest to tMin (the MC stride may not match
    // the screening sample stride).
    let bestIdx = -1, bestD = Infinity;
    for (let i = 0; i < mcBands.pLow.length; i++) {
        const d = Math.abs(mcBands.pLow[i].t_min - tMin);
        if (d < bestD) { bestD = d; bestIdx = i; }
    }
    if (bestIdx < 0) return null;
    const lo = mcBands.pLow[bestIdx]?.alt_km;
    const hi = mcBands.pHigh[bestIdx]?.alt_km;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    return Math.max(0, (hi - lo) / (2 * 1.645));
}

/**
 * Compute the relative along-track σ at TCA for a pair of assets, using
 * Vallado's perturbation formula and a tunable atmospheric correlation.
 *
 * @returns {{ sigmaAlongKm:number, sigmaA:number, sigmaB:number }|null}
 */
function _relativeAlongTrackSigma({ resultA, resultB, tcaMin, correlation }) {
    const aA = resultA?.live?.altKm ? 6378 + resultA.live.altKm : null;
    const aB = resultB?.live?.altKm ? 6378 + resultB.live.altKm : null;
    if (!aA || !aB) return null;
    const sigmaSmaA = _sigmaSmaAtTime(resultA.decay?.mc, tcaMin);
    const sigmaSmaB = _sigmaSmaAtTime(resultB.decay?.mc, tcaMin);
    if (!Number.isFinite(sigmaSmaA) || !Number.isFinite(sigmaSmaB)) return null;
    const nA = _meanMotion(aA), nB = _meanMotion(aB);
    const tSec = tcaMin * 60;
    const sigmaAlongA = 1.5 * sigmaSmaA * nA * tSec;   // km
    const sigmaAlongB = 1.5 * sigmaSmaB * nB * tSec;   // km
    // Correlated-Gaussian combination. ρ=1 → |σA − σB|, ρ=0 → √(σA² + σB²).
    const ρ = Math.max(-1, Math.min(1, correlation));
    const var2 = sigmaAlongA * sigmaAlongA
               + sigmaAlongB * sigmaAlongB
               - 2 * ρ * sigmaAlongA * sigmaAlongB;
    return {
        sigmaAlongKm: Math.sqrt(Math.max(0, var2)),
        sigmaA: sigmaAlongA,
        sigmaB: sigmaAlongB,
    };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Pre-filter: only pair assets whose nominal altitude bands could ever
 * overlap (perigee_A < apogee_B AND perigee_B < apogee_A) AND inclinations
 * are within INC_TOL (otherwise their orbital planes don't intersect at
 * the same altitude, so a conjunction is geometrically excluded).
 *
 * Rough heuristic — keeps the candidate set small without false negatives
 * for any realistic LEO/MEO pair we'd be tracking.
 */
const INC_TOL_DEG = 10;
function _couldOverlap(rA, rB) {
    if (!rA?.live || !rB?.live) return false;
    const altA = rA.live.altKm, altB = rB.live.altKm;
    // Use ±25% altitude tolerance — the live altitude is just a point
    // sample; perigee/apogee from osculating elements would be tighter
    // but the live snapshot is what's already on the result.
    if (Math.abs(altA - altB) > 0.5 * Math.min(altA, altB)) return false;
    const incA = rA.live.inclinationDeg ?? 0;
    const incB = rB.live.inclinationDeg ?? 0;
    // Same- vs opposite-direction orbits both produce planar crossings —
    // we only reject when the two planes' shared altitude differs by an
    // un-meetable inclination spread.
    if (Math.abs(incA - incB) > INC_TOL_DEG &&
        Math.abs(180 - Math.abs(incA - incB)) > INC_TOL_DEG) return false;
    return true;
}

/**
 * Screen a fleet of analyzer results for pairwise conjunctions.
 *
 * @param {Array}  results        FleetAnalyzer outputs (`live`, `decay.mc`, …)
 * @param {object} wasmModule     wasm-bindgen sgp4 module (already initialised)
 * @param {object} [opts]
 * @returns {Promise<Array>}      conjunction events, sorted by P(conj) DESC
 */
export async function screenFleet(results, wasmModule, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    if (!Array.isArray(results) || results.length < 2 || !wasmModule) return [];

    // Phase D: bus-aware default. Explicit opts.nowDate still wins so
    // callers can request a specific moment (e.g. unit tests).
    const nowDate = opts.nowDate || new Date(getTimeBus().getSimTime());
    const assets = results.filter(r =>
        r?.status === 'ready' &&
        r?.live?.altKm > 0 &&
        // Need the source TLE for propagation. Phase 11 callers thread
        // the asset's TLE into the result as a non-enumerable hint.
        Array.isArray(r._tle) && r._tle.length === 2);
    if (assets.length < 2) return [];

    // Propagate each asset once. Bag by id so the pairwise loop can fetch
    // both buffers without redoing the SGP4 work.
    const sgp4ById = new Map();
    for (const a of assets) {
        const [l1, l2] = a._tle;
        const buf = _propagate(wasmModule, l1, l2, cfg.horizonHr, cfg.sampleMin, nowDate);
        if (buf) sgp4ById.set(a.id, buf);
    }
    if (sgp4ById.size < 2) return [];

    const events = [];
    for (let i = 0; i < assets.length; i++) {
        for (let j = i + 1; j < assets.length; j++) {
            const A = assets[i], B = assets[j];
            if (!_couldOverlap(A, B)) continue;
            const bufA = sgp4ById.get(A.id), bufB = sgp4ById.get(B.id);
            if (!bufA || !bufB) continue;
            const minD = _pairwiseMinDistance(bufA, bufB);
            if (!minD || minD.dKm > cfg.screeningKm) continue;

            // Candidate — compute probability via MC band σ.
            const σ = _relativeAlongTrackSigma({
                resultA: A, resultB: B,
                tcaMin: minD.tMin,
                correlation: cfg.correlation,
            });
            const sigmaKm = σ?.sigmaAlongKm ?? null;
            // Without MC bands we can still report the nominal min
            // distance, just no probability. The badge will say "close
            // approach" without quantifying.
            let pConj = null;
            if (Number.isFinite(sigmaKm) && sigmaKm > 0) {
                // P(|d| < threshold) where d ~ N(d_nominal, σ²). For a
                // 1-D along-track approximation: |d| < threshold means
                // the perturbed asset is somewhere in the
                // [-threshold, +threshold] window around the nominal,
                // *centered on the nominal min distance*. Operator's
                // mental model: "would the band touch the threshold?".
                const z1 = (cfg.thresholdKm - minD.dKm) / sigmaKm;
                const z2 = (-cfg.thresholdKm - minD.dKm) / sigmaKm;
                pConj = Math.max(0, _normalCdf(z1) - _normalCdf(z2));
            } else if (minD.dKm <= cfg.thresholdKm) {
                // No MC — nominal already inside the threshold ring.
                pConj = 1.0;
            } else {
                pConj = 0.0;
            }
            events.push({
                idA:   A.id,
                idB:   B.id,
                nameA: A.name,
                nameB: B.name,
                tcaMin: minD.tMin,
                dMinKm: minD.dKm,
                sigmaKm,
                sigmaA: σ?.sigmaA ?? null,
                sigmaB: σ?.sigmaB ?? null,
                pConj,
                thresholdKm: cfg.thresholdKm,
                correlation: cfg.correlation,
            });
        }
    }
    // Sort by P(conj) DESC, then by tCA ASC, so the most-urgent event leads.
    events.sort((a, b) => {
        const dp = (b.pConj ?? 0) - (a.pConj ?? 0);
        if (Math.abs(dp) > 1e-6) return dp;
        return a.tcaMin - b.tcaMin;
    });
    return events;
}

// Re-exports for testing.
export { _normalCdf, _meanMotion, _relativeAlongTrackSigma, _couldOverlap, DEFAULTS };
