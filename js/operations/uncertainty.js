/**
 * uncertainty.js — Synthetic TLE position uncertainty (Vallado age-map).
 *
 * CelesTrak GP TLEs ship without covariance. For decision-grade
 * conjunction analysis operators want real CSpOC / Space-Track
 * covariance — see the synthetic-vs-real disclosure on the model
 * chip. Until then we synthesise a reasonable σ envelope from
 * element-set age, calibrated to Vallado's published LEO drift
 * tables in the RTN frame:
 *
 *   • along-track (T) is the dominant error: drag drift accumulates
 *     linearly-ish in time, ~1 km at epoch + ~1 km / day for a
 *     typical LEO target, with a multiplicative storm factor when
 *     Ap is elevated.
 *   • cross-track (N) is ~σ_along / 3
 *   • radial    (R) is ~σ_along / 5
 *
 * Sigma values are returned in km. Ap modifies only the along-track
 * component because storm-driven density bumps the drag coefficient,
 * which translates almost entirely into in-track drift.
 */

import * as THREE from 'three';
import { propagate, tleEpochToJd } from '../satellite-tracker.js';

const MIN_PER_DAY = 1440;
const MS_PER_DAY  = 86_400_000;

export function jdFromMs(ms) { return ms / MS_PER_DAY + 2440587.5; }

/**
 * Returns { along, cross, radial, ageDays } in km for the given TLE
 * at simTimeMs. Capped at 14 days to keep the ellipsoid from blowing
 * up on stale TLEs that should have refreshed already.
 */
export function tleAgeUncertainty(tle, simTimeMs, ap = 15) {
    const epochJd = tleEpochToJd(tle);
    const ageDays = Math.max(0, Math.min(14, jdFromMs(simTimeMs) - epochJd));
    const stormFactor = Math.max(1, ap / 27);
    const sigmaAlong  = (1 + 1.0 * ageDays) * stormFactor;
    return {
        along:    sigmaAlong,
        cross:    sigmaAlong / 3,
        radial:   sigmaAlong / 5,
        ageDays,
    };
}

/**
 * Build an orthonormal RTN basis at the propagated position of the
 * TLE at simTimeMs.
 *
 *   R  : radial (outward, from Earth centre)
 *   T  : along-track (≈ velocity direction, made orthogonal to R)
 *   N  : cross-track (R × T, completes the right-handed frame)
 *
 * Velocity is inferred from a 10 s finite-difference on propagate()
 * (which exports position only). All vectors are returned in the
 * native TEME frame (no GMST rotation applied) — callers that need
 * ECEF should rotate the basis themselves.
 *
 * Returns { posTeme, R, T, N, sigmaAlong, sigmaCross, sigmaRadial,
 *           ageDays } with vectors as THREE.Vector3.
 */
export function rtnBasis(tle, simTimeMs, ap = 15) {
    const jdNow  = jdFromMs(simTimeMs);
    const tsBase = (jdNow - tleEpochToJd(tle)) * MIN_PER_DAY;
    const dtMin  = 10 / 60;

    const a = propagate(tle, tsBase);
    const b = propagate(tle, tsBase + dtMin);

    const posTeme = new THREE.Vector3(a.x, a.y, a.z);
    const velTeme = new THREE.Vector3(
        (b.x - a.x) / 10,
        (b.y - a.y) / 10,
        (b.z - a.z) / 10,
    );

    // R: radial unit vector
    const R = posTeme.clone().normalize();
    // N: out-of-plane = R × V, then normalise (ensures orthogonality)
    const N = new THREE.Vector3().crossVectors(R, velTeme).normalize();
    // T: complete the right-handed RTN frame: T = N × R (≈ along velocity)
    const T = new THREE.Vector3().crossVectors(N, R).normalize();

    const sigma = tleAgeUncertainty(tle, simTimeMs, ap);

    return {
        posTeme,
        R, T, N,
        sigmaAlong:  sigma.along,
        sigmaCross:  sigma.cross,
        sigmaRadial: sigma.radial,
        ageDays:     sigma.ageDays,
    };
}

/**
 * Combined miss-plane uncertainty for a primary/secondary pair.
 * Uses Pythagorean σ-add since the two objects' uncertainties are
 * independent. Returns km values:
 *   { sigmaAlong, sigmaCross, missAlong, missCross }
 *
 * The miss vector is decomposed only by its magnitude here — without
 * the relative-velocity direction we can't faithfully project onto
 * the true B-plane axes, so the inset visualises a polar-style
 * combined-σ ring with the miss as a single dot at the right radius.
 */
export function combinedMissEnvelope(aSigma, bSigma) {
    return {
        sigmaAlong: Math.sqrt(aSigma.sigmaAlong  ** 2 + bSigma.sigmaAlong  ** 2),
        sigmaCross: Math.sqrt(aSigma.sigmaCross  ** 2 + bSigma.sigmaCross  ** 2),
        sigmaRadial:Math.sqrt(aSigma.sigmaRadial ** 2 + bSigma.sigmaRadial ** 2),
    };
}
