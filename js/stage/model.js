/**
 * stage/model.js — pure scene model for the Stage's Sun→Earth corridor
 * (SPACE_WEATHER_DASHBOARD_PLAN.md §5.2, phase S1). No DOM, no THREE, no
 * fetch. Node gate: tests/stage-model.mjs (includes the kernel-oracle pin).
 *
 * Oracle discipline (§5.7 "oracle discipline extended"):
 *   · Rope kinematics + cross-section: this module builds geometry ONLY
 *     through the mirrors ALREADY exported by js/flux-rope/view.js
 *     (ropeFrame / dbmApexKm / sigmaApexKm — the pinned ports of
 *     rust-flux-rope). No third copy of the math exists here; the node
 *     gate additionally pins JS apex/σ against the committed WASM's
 *     fr_apex_km_at / fr_sigma_apex_km_at probes.
 *   · Rope surface = the zero level of the view.js SDF: axis circle of
 *     radius d/2 in the (ê_dir, ê_P) plane through the Sun, tube radius
 *     σ(ψ) = σ_apex·sin²(ψ/2). Rendered vertex FIELD color is sampled
 *     from the kernel itself (kernel.fieldAt) by the renderer — oracle-
 *     direct, no mirror.
 *   · Magnetopause: Shue-form via ring-current-model's shueStandoffRe /
 *     shueAlpha (THE validated form — imported, not re-derived).
 *   · Wavefronts: weighted quantiles of the ENSEMBLE members' apex
 *     distances at τ — the spread is the data, not an artist's ring.
 *   · Parker spiral: context dressing ONLY (documented display-only —
 *     nothing reads physics from it).
 *
 * Frames: heliocentric, +x Sun→Earth, z ecliptic north (view.js
 * convention). Physical positions in AU; the renderer maps them through
 * stage/scale.js. Member ghost kinematics use the FIT-LEVEL effective
 * wind per rope (same documented approximation as view.js — a member's
 * true wake would depend on its own leader's draw).
 */

import { ropeFrame, dbmApexKm, sigmaApexKm } from '../flux-rope/view.js';
import { shueStandoffRe, shueAlpha, dynamicPressure } from '../ring-current-model.js';
import { AU_KM, EARTH_S, stageRadius } from './scale.js';

export { dynamicPressure };

const TAU = Math.PI * 2;

/* ── Rope geometry (SDF zero level, physical AU) ─────────────────────── */

/**
 * One point on the rope surface. ψ ∈ [0, 2π) runs footpoint → apex (π)
 * → footpoint along the axis circle; θ ∈ [0, 2π) around the tube.
 * @param {object} spec { frame: ropeFrame(), dAu, sigApexAu }
 */
export function ropeSurfacePoint(spec, psi, theta, out = [0, 0, 0]) {
    const { frame, dAu, sigApexAu } = spec;
    const halfD = 0.5 * dAu;
    const sinHalf = Math.sin(0.5 * psi);
    const sig = sigApexAu * sinHalf * sinHalf;
    // Axis point: u = d/2·(1−cosψ) along ê_dir, w = d/2·sinψ along ê_P.
    const au = halfD * (1 - Math.cos(psi));
    const aw = halfD * Math.sin(psi);
    // In-plane radial direction at ψ (from the axis-circle centre).
    const rIn = [
        -Math.cos(psi) * frame.eDir[0] + Math.sin(psi) * frame.eP[0],
        -Math.cos(psi) * frame.eDir[1] + Math.sin(psi) * frame.eP[1],
        -Math.cos(psi) * frame.eDir[2] + Math.sin(psi) * frame.eP[2],
    ];
    const ct = Math.cos(theta), st = Math.sin(theta);
    for (let k = 0; k < 3; k++) {
        out[k] = frame.eDir[k] * au + frame.eP[k] * aw
               + sig * (ct * rIn[k] + st * frame.nHat[k]);
    }
    return out;
}

/**
 * Triangle-strip-ready surface grid: positions (Float32Array, AU) on a
 * (nPsi+1)×(nTheta+1) lattice with wrapped θ seam, plus an index array.
 * ψ is clamped inside [psiMin, 2π−psiMin] — σ→0 at the footpoints makes
 * the exact ends degenerate.
 */
export function ropeSurfaceGrid(spec, nPsi = 48, nTheta = 20, psiMin = 0.12) {
    const positions = new Float32Array((nPsi + 1) * (nTheta + 1) * 3);
    const p = [0, 0, 0];
    for (let i = 0; i <= nPsi; i++) {
        const psi = psiMin + (TAU - 2 * psiMin) * (i / nPsi);
        for (let j = 0; j <= nTheta; j++) {
            const theta = TAU * (j / nTheta);
            ropeSurfacePoint(spec, psi, theta, p);
            const o = (i * (nTheta + 1) + j) * 3;
            positions[o] = p[0]; positions[o + 1] = p[1]; positions[o + 2] = p[2];
        }
    }
    const indices = [];
    for (let i = 0; i < nPsi; i++) {
        for (let j = 0; j < nTheta; j++) {
            const a = i * (nTheta + 1) + j, b = a + nTheta + 1;
            indices.push(a, b, a + 1, b, b + 1, a + 1);
        }
    }
    return { positions, indices: new Uint32Array(indices), nPsi, nTheta };
}

/** Axis-circle polyline (for ghost members), physical AU. */
export function ropeAxisPoints(spec, nPts = 64) {
    const { frame, dAu } = spec;
    const halfD = 0.5 * dAu;
    const out = new Float32Array((nPts + 1) * 3);
    for (let i = 0; i <= nPts; i++) {
        const psi = TAU * (i / nPts);
        const au = halfD * (1 - Math.cos(psi));
        const aw = halfD * Math.sin(psi);
        out[i * 3] = frame.eDir[0] * au + frame.eP[0] * aw;
        out[i * 3 + 1] = frame.eDir[1] * au + frame.eP[1] * aw;
        out[i * 3 + 2] = frame.eDir[2] * au + frame.eP[2] * aw;
    }
    return out;
}

/** Rope spec at time t since launch, from fit-level params (mirrors only).
 *  d0Km defaults to the kernel's 21.5 R_sun Enlil boundary. */
export const D0_KM_DEFAULT = 21.5 * 6.957e5;
export function ropeSpecAt(params, wEffKms, tS, d0Km = D0_KM_DEFAULT) {
    const dKm = dbmApexKm(d0Km, params.v0Kms, wEffKms, params.gammaPerKm, Math.max(0, tS));
    const sigKm = sigmaApexKm(params.sigma1AuAu, dKm, params.nSigma ?? 1.14);
    return {
        frame: ropeFrame(params.lonDeg, params.latDeg, params.tiltDeg),
        dAu: dKm / AU_KM,
        sigApexAu: sigKm / AU_KM,
    };
}

/* ── Ensemble ghosts + wavefronts ────────────────────────────────────── */

/**
 * Pick K representative members from an ensembleRun result (rope 0 of
 * each member — S1 renders single-CME forecasts). Weights come from the
 * assimilated fan when provided, else uniform. Layout per the wrapper:
 * [lonDeg, latDeg, tiltDeg, v0Kms, gammaPerKm, sigma1AuAu, handedness].
 */
export function ghostMembers(ens, weights = null, K = 16) {
    if (!ens?.memberParams?.length || !ens.members) return [];
    const stride = ens.memberStride, rpm = ens.ropesPerMember || 1;
    const n = Math.min(K, ens.members);
    const out = [];
    let wMax = 0;
    if (weights) for (const w of weights) wMax = Math.max(wMax, w);
    for (let k = 0; k < n; k++) {
        const m = Math.floor(k * ens.members / n);
        const o = m * rpm * stride;
        out.push({
            lonDeg: ens.memberParams[o],
            latDeg: ens.memberParams[o + 1],
            tiltDeg: ens.memberParams[o + 2],
            v0Kms: ens.memberParams[o + 3],
            gammaPerKm: ens.memberParams[o + 4],
            sigma1AuAu: ens.memberParams[o + 5],
            handedness: ens.memberParams[o + 6],
            // Relative weight ∈ (0,1]: 1 under uniform weights; under an
            // assimilated fan, faded exactly like the flux-rope overlay.
            weight: weights && wMax > 0 ? weights[m] / wMax : 1,
        });
    }
    return out;
}

/** Weighted quantile (linear on the weighted CDF). values finite. */
export function quantileWeighted(values, weights, q) {
    const idx = values.map((v, i) => [v, weights ? weights[i] : 1])
        .filter(([v, w]) => Number.isFinite(v) && w > 0)
        .sort((a, b) => a[0] - b[0]);
    if (!idx.length) return null;
    const total = idx.reduce((s, [, w]) => s + w, 0);
    let acc = 0;
    for (const [v, w] of idx) {
        acc += w;
        if (acc / total >= q) return v;
    }
    return idx[idx.length - 1][0];
}

/**
 * The arrival wavefronts: P10/P50/P90 of the ensemble apex distance at
 * t seconds after launch — "where is it now", honest about spread.
 * @returns {{p10:number, p50:number, p90:number}} in AU (may exceed 1).
 */
export function wavefrontRadiiAu(members, wEffKms, tS, weights = null, d0Km = D0_KM_DEFAULT) {
    if (!members?.length || !(tS > 0)) return null;
    const apex = members.map((m) =>
        dbmApexKm(d0Km, m.v0Kms, wEffKms, m.gammaPerKm, tS) / AU_KM);
    const w = weights && weights.length === members.length ? weights : null;
    return {
        p10: quantileWeighted(apex, w, 0.10),
        p50: quantileWeighted(apex, w, 0.50),
        p90: quantileWeighted(apex, w, 0.90),
    };
}

/* ── Magnetosphere (Shue form, Earth-local R_E) ──────────────────────── */

/**
 * Shue-form magnetopause surface r(θ) = r0·(2/(1+cosθ))^α as a lattice in
 * EARTH-LOCAL R_E, nose toward the Sun (−x). Tail truncated at maxTailRe.
 */
export function shueSurfaceGrid(pdynNPa, bzNt, nTheta = 36, nPhi = 24, maxTailRe = 28) {
    const r0 = shueStandoffRe(pdynNPa, bzNt);
    const alpha = shueAlpha(pdynNPa, bzNt);
    const positions = new Float32Array((nTheta + 1) * (nPhi + 1) * 3);
    // θ span: stop before the flank angle where r would exceed the tail cap.
    for (let i = 0; i <= nTheta; i++) {
        const theta = Math.PI * 0.86 * (i / nTheta);   // never fully closed
        let r = r0 * Math.pow(2 / (1 + Math.cos(theta)), alpha);
        r = Math.min(r, maxTailRe);
        for (let j = 0; j <= nPhi; j++) {
            const phi = TAU * (j / nPhi);
            const o = (i * (nPhi + 1) + j) * 3;
            positions[o] = -r * Math.cos(theta);                  // nose → Sun (−x)
            positions[o + 1] = r * Math.sin(theta) * Math.cos(phi);
            positions[o + 2] = r * Math.sin(theta) * Math.sin(phi);
        }
    }
    const indices = [];
    for (let i = 0; i < nTheta; i++) {
        for (let j = 0; j < nPhi; j++) {
            const a = i * (nPhi + 1) + j, b = a + nPhi + 1;
            indices.push(a, b, a + 1, b, b + 1, a + 1);
        }
    }
    return { positions, indices: new Uint32Array(indices), r0, alpha, nTheta, nPhi };
}

/* ── Parker spiral context (display-only, documented) ────────────────── */

const OMEGA_SUN = 2.865e-6;   // rad/s sidereal Carrington

/** One spiral field line footed at heliolongitude phi0 (display dressing —
 *  no physics reads it). Points in physical AU on the ecliptic. */
export function parkerSpiralPoints(vKms = 400, phi0Deg = 0, nPts = 80, rMaxAu = 1.15) {
    const out = new Float32Array(nPts * 3);
    const phi0 = phi0Deg * Math.PI / 180;
    for (let i = 0; i < nPts; i++) {
        const r = 0.05 + (rMaxAu - 0.05) * (i / (nPts - 1));
        const phi = phi0 - OMEGA_SUN * (r - 0.05) * AU_KM / vKms;
        out[i * 3] = r * Math.cos(phi);
        out[i * 3 + 1] = r * Math.sin(phi);
        out[i * 3 + 2] = 0;
    }
    return out;
}

/* ── Stations & flights (§5.4, stations 1–4) ─────────────────────────── */

/** Camera stations in STAGE units (+x Sun→Earth, z north; Earth at
 *  [EARTH_S,0,0]). Poses framed for the compressed map (mix=0) — the
 *  true-scale toggle re-frames via the same defs on the fly. */
export function stationDefs(mix = 0) {
    const sL1 = stageRadius(0.99, mix);
    const e = EARTH_S;
    return [
        { id: 'solar-watch', title: 'Solar Watch',
          pos: [0.55, -0.85, 0.4], target: [0, 0, 0], minD: 0.35, maxD: 2.5 },
        { id: 'corridor', title: 'Corridor',
          pos: [e * 0.48, -3.1, 1.25], target: [e * 0.46, 0, 0], minD: 1.2, maxD: 6.5 },
        { id: 'l1-approach', title: 'L1 Approach',
          pos: [sL1 + 0.34, -0.42, 0.16], target: [sL1 - 0.8, 0, 0], minD: 0.15, maxD: 2.2 },
        { id: 'magnetosphere', title: 'Magnetosphere',
          pos: [e - 0.62, -0.5, 0.24], target: [e, 0, 0], minD: 0.18, maxD: 2.2 },
    ];
}

export function easeInOutCubic(t) {
    const x = Math.min(1, Math.max(0, t));
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Camera pose along a flight a→b at progress t (eased). */
export function flightPose(a, b, t) {
    const k = easeInOutCubic(t);
    const lerp3 = (p, q) => [0, 1, 2].map((i) => p[i] + (q[i] - p[i]) * k);
    return { pos: lerp3(a.pos, b.pos), target: lerp3(a.target, b.target) };
}
