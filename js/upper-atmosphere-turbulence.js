/**
 * upper-atmosphere-turbulence.js — per-zone thermospheric turbulence index
 * ═══════════════════════════════════════════════════════════════════════════
 * "Turbulence" in the thermosphere isn't the eddy turbulence of the lower
 * atmosphere — above the homopause the flow is laminar and increasingly
 * collisionless. What an LEO operator actually feels as "turbulence" is
 * UNPREDICTABLE DRAG: short-timescale density variability. The measured,
 * weather-bearing driver of that is the STORM-DRIVEN DENSITY SWING:
 *
 *   • the thermosphere inflates when a geomagnetic storm dumps energy
 *     into it. Each zone's density has a different sensitivity dρ/dAp
 *     (the upper thermosphere swings hardest — this is the Feb-2022
 *     Starlink story). We multiply that local sensitivity by the *recent
 *     geomagnetic volatility* (σ of the Ap proxy over a trailing window)
 *     to get the fractional density perturbation δρ/ρ the zone is
 *     currently experiencing.
 *
 * That δρ/ρ maps through a saturating curve to a turbulence index
 * `ti ∈ [0, 1]` and a coarse `state` label. The index is what the
 * dashboard paints as a bar + badge, and what the globe's wave-field
 * overlay reads as its per-zone ripple amplitude (storms are what launch
 * the travelling atmospheric disturbances the ripple depicts, so the
 * visual and the index share one driver).
 *
 * Note on gravity-wave residuals: an earlier design folded
 * `gravityWaveActivity()`'s RMS departure-from-exponential into the
 * index. That measure conflates genuine wave structure with the
 * thermosphere's *intrinsic* log-density curvature (scale height grows
 * with altitude), so over a smooth surrogate/MSIS profile it reads
 * hundreds of percent regardless of weather — pure baseline curvature,
 * not turbulence. It carried no weather signal and pegged the index, so
 * it's deliberately excluded. Real gravity-wave detection needs measured
 * density (e.g. the TU Delft accelerometer feed), not a model profile.
 *
 * Pure compute over `density()` — no I/O, cheap enough to run every
 * realtime tick.
 */

import { ATMOSPHERIC_LAYER_SCHEMA } from './upper-atmosphere-layers.js';
import { density } from './upper-atmosphere-engine.js';

// Saturating scale for the δρ/ρ → ti map. ti = 1 − exp(−frac / SCALE).
// A storm that doubles local density (frac ≈ 1.0) reads ti ≈ 0.92; a
// 20 % swing reads ti ≈ 0.39. Tuned so quiet days sit near 0 and a real
// G-class storm pegs the bar without clipping at modest perturbations.
const TI_SCALE = 0.55;

// Trailing window (hours) for the Ap-volatility estimate. ~6 h captures
// the substorm timescale that drives the fastest operationally-relevant
// density swings without smearing in day-old quiet history.
const AP_WINDOW_HR = 6;

// State thresholds on ti. Names echo the engine's gravity-wave bands
// (quiet/active/strong/extreme) but in operator-facing language.
function _stateForTI(ti) {
    if (!Number.isFinite(ti)) return 'calm';
    if (ti < 0.20) return 'calm';
    if (ti < 0.45) return 'unsettled';
    if (ti < 0.75) return 'turbulent';
    return 'severe';
}

function _clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function _peakKm(layer) {
    return Number.isFinite(layer.peakKm)
        ? layer.peakKm
        : (layer.minKm + layer.maxKm) / 2;
}

/**
 * Geomagnetic volatility: the standard deviation of the Ap proxy over the
 * trailing `windowHr` of the realtime ring buffer. This is the "how much
 * is the storm forcing jumping around right now" scalar that, multiplied
 * by each zone's density sensitivity, becomes the storm-driven δρ/ρ.
 *
 * @param {Array<{t:number, ap?:number, apProxy?:number}>} history
 * @param {object} [opts]
 * @param {number} [opts.nowMs=Date.now()]
 * @param {number} [opts.windowHr=AP_WINDOW_HR]
 * @returns {number} σ(Ap) over the window (0 when too few samples)
 */
export function apVolatility(history, { nowMs = Date.now(), windowHr = AP_WINDOW_HR } = {}) {
    if (!Array.isArray(history) || history.length < 3) return 0;
    const cutoff = nowMs - windowHr * 3600_000;
    const vals = [];
    for (const h of history) {
        if (!Number.isFinite(h?.t) || h.t < cutoff) continue;
        const ap = Number.isFinite(h.ap) ? h.ap : h.apProxy;
        if (Number.isFinite(ap)) vals.push(ap);
    }
    if (vals.length < 3) return 0;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    let s2 = 0;
    for (const v of vals) s2 += (v - mean) * (v - mean);
    return Math.sqrt(s2 / vals.length);
}

/**
 * Turbulence index for a single zone given the forcing state, the recent
 * Ap volatility, and the live gravity-wave residual.
 *
 * @param {object} layer  ATMOSPHERIC_LAYER_SCHEMA entry
 * @param {object} opts
 * @param {number} opts.f107
 * @param {number} opts.ap
 * @param {number} opts.sigmaAp   σ(Ap) from apVolatility()
 * @returns {{
 *   zoneId:string, name:string, peakKm:number,
 *   ti:number, state:string,
 *   deltaRhoFracPct:number,   // storm-driven δρ/ρ as a percent
 *   sensitivity:number,       // (1/ρ)(dρ/dAp), per unit Ap
 *   sigmaAp:number
 * }}
 */
export function zoneTurbulence(layer, { f107, ap, sigmaAp = 0 }) {
    const peakKm = _peakKm(layer);

    // Local density sensitivity to geomagnetic forcing — a one-sided
    // numeric derivative (1/ρ)(dρ/dAp). The Ap step scales with the
    // current Ap so we probe a physically-sized perturbation at both
    // quiet and storm baselines (and never a zero step).
    const dAp = Math.max(2, 0.15 * ap);
    let sensitivity = 0;
    try {
        const rho0 = density({ altitudeKm: peakKm, f107Sfu: f107, ap }).rho;
        const rho1 = density({ altitudeKm: peakKm, f107Sfu: f107, ap: ap + dAp }).rho;
        if (rho0 > 0) sensitivity = Math.abs(rho1 - rho0) / rho0 / dAp;
    } catch (_) { /* below-floor altitude etc. — leave sensitivity 0 */ }

    // Storm-driven fractional density swing the zone is *currently*
    // experiencing: local sensitivity × how much the forcing is moving.
    const stormFrac = sensitivity * sigmaAp;
    const ti = _clamp(1 - Math.exp(-stormFrac / TI_SCALE), 0, 1);

    return {
        zoneId:          layer.id,
        name:            layer.name,
        peakKm,
        ti,
        state:           _stateForTI(ti),
        deltaRhoFracPct: stormFrac * 100,
        sensitivity,
        sigmaAp,
    };
}

/**
 * One-shot convenience: compute the per-zone turbulence array for the
 * current forcing + realtime history. Derives Ap volatility from the ring
 * once, then evaluates each zone's storm-driven density variability.
 *
 * This is what the dashboard and the globe both call each tick.
 *
 * @param {object} opts
 * @param {number} opts.f107
 * @param {number} opts.ap
 * @param {Array}  [opts.history=[]]  realtime ring buffer
 * @param {number} [opts.nowMs=Date.now()]
 * @returns {Array} one zoneTurbulence() result per layer, schema order
 */
export function computeZoneTurbulence({ f107, ap, history = [], nowMs = Date.now() }) {
    const sigmaAp = apVolatility(history, { nowMs });
    return ATMOSPHERIC_LAYER_SCHEMA.map(L => zoneTurbulence(L, { f107, ap, sigmaAp }));
}
