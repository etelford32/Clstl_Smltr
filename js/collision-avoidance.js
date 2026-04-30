/**
 * collision-avoidance.js — probability of collision + Δv recommendations
 * ═══════════════════════════════════════════════════════════════════════════
 * Operational COLA (collision-avoidance) math at the
 * back-of-the-envelope precision suitable for a visualization-grade
 * conjunction screener. Two outputs:
 *
 *   1. Probability of Collision (Pc) — Foster's 2D method assuming a
 *      spherical hard-body radius and an isotropic combined covariance
 *      proxied from the pair's altitude.
 *
 *   2. Recommended evasion Δv — minimum in-track or radial impulse
 *      that, applied N orbits before TCA, displaces the asset by the
 *      desired safety margin at TCA. Falls out of the linearised
 *      Clohessy-Wiltshire (CW) equations for relative motion in a
 *      circular reference orbit.
 *
 * These are NOT a substitute for an operational CDM (Conjunction Data
 * Message) workflow — operational COLA needs per-object covariance,
 * a true 3-D miss vector with relative velocity, and Mahalanobis-
 * weighted Pc. The model here:
 *
 *   • assumes circular orbits (eccentricity ≈ 0),
 *   • uses a single-axis Gaussian for Pc (1-D Foster),
 *   • assumes a 1-σ position uncertainty proxy that scales with TCA
 *     lookahead (closer in time → tighter; further out → looser, since
 *     TLE propagation error grows ~linearly with prediction span),
 *   • picks the smallest Δv that achieves a target miss distance from
 *     a CW phase-stability assumption (in-track Δv displaces in-track
 *     by 3·n·Δv·t at time t after burn, which dominates the radial
 *     contribution by an order of magnitude past one orbit).
 */

const MU_KM3_S2 = 398600.4418;          // Earth GM
const RE_KM     = 6378.135;

// Hard-body radius (m) — sum of physical radii of the two objects.
// Defaults assume a 1-m bus + a 0.3-m fragment; bumped to 5 m for
// "asset-asset" pairs (intact birds with antennas + solar arrays).
export const HARD_BODY_RADIUS_M = {
    'asset-asset':  5.0,
    'asset-debris': 1.5,
};

/**
 * Mean motion n (rad/s) at altitude.
 */
export function meanMotionRad(altKm) {
    const r = RE_KM + altKm;
    return Math.sqrt(MU_KM3_S2 / (r * r * r));
}

/**
 * Orbital period (s) at altitude.
 */
export function periodSec(altKm) {
    return (2 * Math.PI) / meanMotionRad(altKm);
}

/**
 * Position-error 1-σ (m) proxied from TCA lookahead. This is the
 * combined-covariance proxy used by Pc — it has to be a function of
 * something, and TLE propagation error grows roughly linearly with
 * the lookahead span (≈ 1 km/day at LEO is the SGP4 accuracy figure
 * widely cited; we use 0.5 km/day as a defensible mid-band).
 *
 * The minimum 50 m is a floor for "right now" — even a fresh TLE has
 * some position uncertainty (the 18 SDS vector estimation residuals
 * sit at ~10–100 m for well-tracked objects, more for tumbling debris).
 */
export function positionSigmaM(tcaSeconds) {
    const days = Math.max(0, tcaSeconds) / 86400;
    return Math.max(50, 500 * days);    // metres
}

/**
 * Probability of Collision via Foster's 2D method (collapsed to 1D
 * for the visualization-grade case where we have miss distance but
 * not a 2D B-plane miss vector).
 *
 *   Pc ≈ (HBR / (σ √(2π))) · exp(-d² / (2σ²))
 *
 * Where d is miss distance, HBR is hard-body radius, σ is the
 * combined position uncertainty. This is the "tight covariance"
 * limit — sharp peak at d=0, falls off as Gaussian.
 *
 * For operational ranges (10⁻⁷ … 10⁻³) the result is meaningful as
 * a relative ranking; treat absolute values as order-of-magnitude.
 *
 * @param {object} args
 * @param {number} args.missKm     miss distance (km) at TCA
 * @param {number} args.tcaSec     time-to-TCA (s) — drives σ
 * @param {string} [args.kind]     'asset-asset' | 'asset-debris'
 *                                 (selects HBR default)
 * @param {number} [args.hbrM]     hard-body radius (m), overrides kind default
 * @returns {{pc:number, sigmaM:number, hbrM:number}}
 */
export function probabilityOfCollision({ missKm, tcaSec, kind = 'asset-debris', hbrM }) {
    const sigmaM = positionSigmaM(tcaSec);
    const HBR    = (hbrM != null) ? hbrM : HARD_BODY_RADIUS_M[kind] ?? 1.5;
    const dM     = Math.max(0, missKm) * 1000;
    const exp    = Math.exp(-(dM * dM) / (2 * sigmaM * sigmaM));
    const peak   = HBR / (sigmaM * Math.sqrt(2 * Math.PI));
    const pc     = Math.min(1, peak * exp);
    return { pc, sigmaM, hbrM: HBR };
}

/**
 * Categorical risk label for a given Pc — matches the standard
 * NASA/CCSDS COLA decision thresholds:
 *   ≥ 1e-4  red    "maneuver"
 *   ≥ 1e-5  amber  "monitor"
 *   ≥ 1e-7  yellow "watch"
 *   else    green  "nominal"
 */
export function pcRisk(pc) {
    if (pc >= 1e-4) return { tier: 'maneuver', color: '#ff3060', label: 'maneuver' };
    if (pc >= 1e-5) return { tier: 'monitor',  color: '#ff9050', label: 'monitor'  };
    if (pc >= 1e-7) return { tier: 'watch',    color: '#ffcc60', label: 'watch'    };
    return                 { tier: 'nominal',  color: '#80c890', label: 'nominal'  };
}

/**
 * Recommended in-track Δv (m/s) to clear a target miss distance,
 * applied `leadTimeSec` before TCA, on a circular orbit at altitude
 * `altKm`. From the Clohessy-Wiltshire equations: a tangential
 * impulse Δv (along-track) at t=0 produces a secular in-track drift:
 *
 *   y_secular(t) = -3·Δv·t      (the periodic 4·Δv/n·sin(nt) term
 *                                averages out across one orbit)
 *
 * So to add a desired in-track separation Δx at time t:
 *
 *   Δv = Δx / (3·t)
 *
 * This is the cheapest evasion direction by ~an order of magnitude vs
 * radial; operational COLA almost always uses in-track. A radial
 * impulse Δv produces a maximum in-track excursion of 2·Δv/n, so the
 * radial-equivalent for clearance Δx is Δv = n·Δx/2 — included for
 * the trade-off discussion in the UI.
 *
 * @param {object} args
 * @param {number} args.altKm           reference orbit altitude (km)
 * @param {number} args.tcaSec          time to TCA (s)
 * @param {number} args.currentMissKm   current predicted miss distance (km)
 * @param {number} [args.targetMissKm]  desired miss distance (km), default 5
 * @param {number} [args.minLeadSec]    minimum lead time (s); the burn
 *                                      can't be applied later than this
 *                                      before TCA
 * @returns {{dvInTrackMS:number, dvRadialMS:number, leadSec:number,
 *           clearKm:number, periodMin:number, feasible:boolean}}
 */
export function recommendDeltaV({
    altKm, tcaSec, currentMissKm,
    targetMissKm = 5,
    minLeadSec   = 5 * 60,
}) {
    const n = meanMotionRad(altKm);
    const T = periodSec(altKm);
    const periodMin = T / 60;

    // Lead time = full TCA budget minus a small "decision + tasking"
    // buffer (operationally ~1 orbit; we use minLeadSec). If TCA is
    // very near, fall back to the smallest non-negative lead.
    const leadSec = Math.max(minLeadSec, tcaSec - 60);
    if (leadSec <= 0) {
        return {
            dvInTrackMS: NaN, dvRadialMS: NaN,
            leadSec: 0, clearKm: 0, periodMin,
            feasible: false,
        };
    }

    // Required in-track displacement to clear the target miss. If
    // current miss already exceeds the target the recommendation is
    // "no action" — return 0 m/s.
    const clearKm = Math.max(0, targetMissKm - currentMissKm);
    if (clearKm === 0) {
        return {
            dvInTrackMS: 0, dvRadialMS: 0,
            leadSec, clearKm: 0, periodMin, feasible: true,
        };
    }
    const clearM = clearKm * 1000;

    const dvInTrack = clearM / (3 * leadSec);                // m/s — secular CW
    const dvRadial  = (n * clearM) / 2;                       // m/s — peak excursion

    return {
        dvInTrackMS: dvInTrack,
        dvRadialMS:  dvRadial,
        leadSec,
        clearKm,
        periodMin,
        feasible: true,
    };
}

/**
 * Tiny formatter for Δv in mm/s … m/s. COLA burns at LEO are usually
 * sub-m/s so mm/s is the natural unit.
 */
export function formatDeltaV(ms) {
    if (!Number.isFinite(ms)) return '—';
    if (ms === 0)             return '0 m/s (no action)';
    if (ms < 0.001)           return `${(ms * 1e6).toFixed(0)} µm/s`;
    if (ms < 1)               return `${(ms * 1000).toFixed(1)} mm/s`;
    return `${ms.toFixed(2)} m/s`;
}

/**
 * Fuel-budget translation: convert Δv (m/s) → mass burned (kg) using
 * Tsiolkovsky for a typical Hall-effect thruster (Isp = 1500 s).
 * Useful for "this is X% of station-keeping budget" framing.
 */
export function deltaVToFuelKg(dvMS, drySpacecraftKg = 1500, ispS = 1500) {
    if (!Number.isFinite(dvMS) || dvMS <= 0) return 0;
    const ve = ispS * 9.80665;
    // Δv = ve · ln(m0/mf) → mf = m0 / e^(Δv/ve)
    const mf = drySpacecraftKg / Math.exp(dvMS / ve);
    return drySpacecraftKg - mf;
}
