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
import { magneticLatitude, boundaryForKp } from '../verdict-engine.js';
import { AU_KM, EARTH_S, RE_KM, stageRadius } from './scale.js';

export { dynamicPressure };

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

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

/* ── Aurora oval band (§5.2 Earth, phase S2) ─────────────────────────
   The oval is drawn as the band between the p10 and p90 equatorward
   boundaries of the FORECAST Kp distribution — uncertainty as geometry.
   Oracles: verdict-engine boundaryForKp (the NOAA table) and
   magneticLatitude (the dipole) — this module only INVERTS the dipole
   numerically; the node gate pins the inversion against the oracle. */

/**
 * Geographic latitude where |magneticLatitude| equals `boundaryMlat` on
 * the given meridian. Bisection over [0°, 82°] (monotone there for every
 * longitude; the NOAA table never exceeds 66.5°). hemisphere: +1 N, −1 S.
 */
export function ovalLatAtLon(boundaryMlat, lonDeg, hemisphere = 1) {
    let lo = 0, hi = 82;
    for (let i = 0; i < 40; i++) {
        const mid = 0.5 * (lo + hi);
        if (Math.abs(magneticLatitude(hemisphere * mid, lonDeg)) < boundaryMlat) lo = mid;
        else hi = mid;
    }
    return hemisphere * 0.5 * (lo + hi);
}

/**
 * Boundary polylines for a Kp distribution {p10, p50, p90} (Kp p10 low →
 * POLEWARD edge; Kp p90 high → EQUATORWARD edge). Latitudes per sampled
 * longitude, one hemisphere.
 */
export function ovalBandGrid(kpBand, nLon = 90, hemisphere = 1) {
    const lons = new Float32Array(nLon + 1);
    const poleward = new Float32Array(nLon + 1);
    const median = new Float32Array(nLon + 1);
    const equatorward = new Float32Array(nLon + 1);
    const bPole = boundaryForKp(kpBand.p10);
    const bMed = boundaryForKp(kpBand.p50);
    const bEq = boundaryForKp(kpBand.p90);
    for (let i = 0; i <= nLon; i++) {
        const lon = -180 + 360 * (i / nLon);
        lons[i] = lon;
        poleward[i] = ovalLatAtLon(bPole, lon, hemisphere);
        median[i] = ovalLatAtLon(bMed, lon, hemisphere);
        equatorward[i] = ovalLatAtLon(bEq, lon, hemisphere);
    }
    return { lons, poleward, median, equatorward };
}

/**
 * Kp distribution at τ from the page's forecast_timeline payload (the
 * 'earth-forecast-update' event — the EXISTING probabilistic-Kp oracle:
 * AR(p) + persistence + SWPC consensus; we consume its arp mean/lo80/hi80,
 * never re-derive). Past or missing trajectory → degenerate band at kpNow.
 */
export function kpBandAt(tauMs, timeline, kpNow) {
    const traj = timeline?.trajectory;
    const clampKp = (v) => Math.min(9, Math.max(0, v));
    const start = traj?.start_ms ?? timeline?.updated_at;
    if (traj?.arp?.mean?.length && Number.isFinite(start) && tauMs > start) {
        const idx = Math.min(traj.arp.mean.length - 1,
            Math.max(0, Math.round((tauMs - start) / 3.6e6) - 1));
        const p50 = traj.arp.mean[idx], lo = traj.arp.lo80[idx], hi = traj.arp.hi80[idx];
        if ([p50, lo, hi].every(Number.isFinite)) {
            return { p10: clampKp(lo), p50: clampKp(p50), p90: clampKp(hi) };
        }
    }
    if (!Number.isFinite(kpNow)) return null;
    const k = clampKp(kpNow);
    return { p10: k, p50: k, p90: k };
}

/* ── Earth-local geographic frame (S2) ───────────────────────────────
   Stage Earth-local axes: z = north, the SUN sits in the −x direction
   from Earth. Geography is placed by MEAN SOLAR TIME: the subsolar
   meridian faces −x. Documented display tolerances: the equation of
   time (±4 min ≈ ±1° of longitude) and Earth's obliquity (subsolar
   latitude pinned to 0°) are ignored — context display only; real pass
   timing stays with js/pass-predictor.js. */

/** Mean-sun subsolar longitude (°E) at τ. */
export function subsolarLonDeg(tauMs) {
    const utcH = (tauMs / 3.6e6) % 24;
    let lon = (12 - utcH) * 15;
    while (lon > 180) lon -= 360;
    while (lon < -180) lon += 360;
    return lon;
}

/** Geographic (lat°, lon°, radius) → Earth-local xyz, same radial units
 *  in as out. The subsolar point maps to the −x axis. */
export function earthLocal(latDeg, lonDeg, r, tauMs, out = [0, 0, 0]) {
    const d = (lonDeg - subsolarLonDeg(tauMs)) * DEG;
    const phi = latDeg * DEG;
    out[0] = -r * Math.cos(phi) * Math.cos(d);
    out[1] = -r * Math.cos(phi) * Math.sin(d);
    out[2] = r * Math.sin(phi);
    return out;
}

/* ── Orbital assets (S2, Orbit Ops) ──────────────────────────────────
   Elements come from /api/celestrak/tle (parsed name/inclination/
   period/apogee/perigee + raw lines). Live positions use the house SGP4
   (js/satellite-tracker.js propagate → TEME km); the display frame is
   TEME rotated so the mean Sun sits at −x, consistent (to the same
   documented mean-sun tolerance) with the geographic frame above. */

/** Mean solar ecliptic longitude (°) — the standard mean-sun series. */
export function sunEclipticLonDeg(tauMs) {
    const d = (tauMs - Date.UTC(2000, 0, 1, 12)) / 86400e3;   // days since J2000
    let L = 280.460 + 0.9856474 * d;
    L %= 360;
    return L < 0 ? L + 360 : L;
}

/** TEME km → Earth-local display frame, in R_E. Rotation about z chosen
 *  so the mean-sun direction lands on −x. */
export function temeToStageRe(temeKm, tauMs, out = [0, 0, 0]) {
    const a = (180 - sunEclipticLonDeg(tauMs)) * DEG;
    const c = Math.cos(a), s = Math.sin(a);
    out[0] = (c * temeKm.x - s * temeKm.y) / RE_KM;
    out[1] = (s * temeKm.x + c * temeKm.y) / RE_KM;
    out[2] = temeKm.z / RE_KM;
    return out;
}

/** RAAN (°) from TLE line 2, columns 18–25. */
export function parseTleRaan(line2) {
    const v = parseFloat(String(line2 ?? '').slice(17, 25));
    return Number.isFinite(v) ? v : 0;
}

/**
 * Orbit context ring for an asset: a CIRCLE at the mean altitude in the
 * asset's orbital plane (inclination + RAAN), in TEME axes, R_E units.
 * Display context only — the live dot uses the real SGP4 propagation;
 * the ring shows plane + altitude, not eccentricity.
 */
export function assetOrbitRing({ inclDeg = 0, raanDeg = 0, altKm = 550 }, n = 96) {
    const r = (RE_KM + altKm) / RE_KM;
    const i = inclDeg * DEG, o = raanDeg * DEG;
    // P = node direction, Q = in-plane normal to P (rotated by inclination).
    const P = [Math.cos(o), Math.sin(o), 0];
    const Q = [-Math.sin(o) * Math.cos(i), Math.cos(o) * Math.cos(i), Math.sin(i)];
    const out = new Float32Array((n + 1) * 3);
    for (let k = 0; k <= n; k++) {
        const u = TAU * (k / n);
        const cu = Math.cos(u), su = Math.sin(u);
        out[k * 3] = r * (cu * P[0] + su * Q[0]);
        out[k * 3 + 1] = r * (cu * P[1] + su * Q[1]);
        out[k * 3 + 2] = r * (cu * P[2] + su * Q[2]);
    }
    return out;
}

/* ── My Sky pose (S2, Aurora Chaser staging) ─────────────────────────
   Ground-level look-north from the user's pin, in Earth-local R_E:
   camera floats just above the pin, target on the northward horizon. */
export function mySkyPose(latDeg, lonDeg, tauMs) {
    const pos = earthLocal(latDeg, lonDeg, 1.10, tauMs);
    const northLat = Math.min(88, latDeg + 24);
    const target = earthLocal(northLat, lonDeg, 1.02, tauMs);
    return { pos, target };
}

/* ── Stations & flights (§5.4 — stations 1–4 in S1, 5–6 in S2) ───────── */

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
        // S2 persona stagings. My Sky's nominal pose is the no-pin
        // fallback — with a pin the renderer overrides it via mySkyPose.
        { id: 'my-sky', title: 'My Sky',
          pos: [e - 0.09, 0, 0.05], target: [e, 0, 0.02], minD: 0.004, maxD: 0.5 },
        { id: 'orbit-ops', title: 'Orbit Ops',
          pos: [e - 0.28, -0.22, 0.38], target: [e, 0, 0], minD: 0.05, maxD: 1.6 },
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

/* ── S5a: the particle wind field (plan §15) ─────────────────────────
   PURE oracle for the Stage's particle layer: given a heliocentric
   radius and the ambient sample at τ (from the ONE provider's
   SolarWindDriver — never a second fetch), plus optionally the
   kernel-derived CME structure (S5b), classify the regime and return
   the flow speed and relative density there. The renderer bakes this
   to a small texture; the shader only advects. Quiet-time honesty
   (plan §15.4b): with no CME context this REPRESENTS MEASUREMENT
   (nowcast persistence), not prediction. Node gate: tests/stage-model.mjs. */

export const AMBIENT_V_KMS = 400;   // climatological fallback (driver absent)
export const AMBIENT_N_CC = 5;      // matches flux-rope-forecast ambientNCc

/**
 * @param {number} rAu      heliocentric radius [AU]
 * @param {object} [ambient] { vKms?, nCc? } — driver sample at τ
 * @param {object} [cme]     { shockAu, ejectaAu, compression?, vKms? } —
 *        kernel CME structure at τ (shock AHEAD of ejecta: ejectaAu<shockAu)
 * @returns {{ vKms:number, nRel:number, regime:'ambient'|'sheath'|'ejecta' }}
 */
export function windFieldAt(rAu, ambient = {}, cme = null) {
    const v0 = Number.isFinite(ambient.vKms) && ambient.vKms > 50
        ? ambient.vKms : AMBIENT_V_KMS;
    const n0 = Number.isFinite(ambient.nCc) && ambient.nCc > 0
        ? ambient.nCc : AMBIENT_N_CC;
    // Relative density vs climatology, clamped so a gust can neither
    // wash out the scene nor empty it.
    const nRel = Math.min(4, Math.max(0.2, n0 / AMBIENT_N_CC));
    if (cme && Number.isFinite(cme.shockAu) && Number.isFinite(cme.ejectaAu)
        && cme.ejectaAu < cme.shockAu && rAu >= 0 && rAu <= cme.shockAu) {
        const vCme = Number.isFinite(cme.vKms) && cme.vKms > 50 ? cme.vKms : v0;
        if (rAu > cme.ejectaAu) {
            const comp = Math.min(6, Math.max(1, cme.compression ?? 1));
            return { vKms: vCme, nRel: Math.min(8, nRel * comp), regime: 'sheath' };
        }
        return { vKms: vCme, nRel, regime: 'ejecta' };
    }
    return { vKms: v0, nRel, regime: 'ambient' };
}

/* ── S5b: per-member field rows for the particle-cloud bake ──────────
   Each CME particle is BOUND to an ensemble member (plan §15.4b): the
   renderer bakes these rows to a texture; the shader places a member's
   plume at ITS apex along ITS direction (the ropeFrame eDir convention:
   (cosλcosφ, cosλsinφ, sinλ)), faded by ITS filter weight — so the
   cloud's on-screen spread IS the forecast distribution. Apexes come
   from the SAME dbmApexKm mirror the wavefront shells use (kernel-
   pinned by this file's gate); front speed is its finite difference.
   Slots past `count` keep weight 0 — invisible, never wrong. PURE. */
export function memberFieldRows(members, wEffKms, tS,
    { M = 128, d0Km = D0_KM_DEFAULT, shockOffsetAu = 0 } = {}) {
    const count = Math.min(M, members?.length ?? 0);
    if (!count || !(tS > 0)) return null;
    const apexAu = new Float32Array(M), shockAu = new Float32Array(M);
    const weight = new Float32Array(M), vKms = new Float32Array(M);
    const lonRad = new Float32Array(M), latRad = new Float32Array(M);
    const dt = Math.min(600, tS * 0.5);
    for (let i = 0; i < count; i++) {
        const m = members[i];
        const a1 = dbmApexKm(d0Km, m.v0Kms, wEffKms, m.gammaPerKm, tS);
        const a0 = dbmApexKm(d0Km, m.v0Kms, wEffKms, m.gammaPerKm, tS - dt);
        apexAu[i] = a1 / AU_KM;
        shockAu[i] = a1 / AU_KM + Math.max(0, shockOffsetAu);
        weight[i] = Math.max(0, Math.min(1, m.weight ?? 1));
        vKms[i] = Math.max(0, (a1 - a0) / dt);
        lonRad[i] = (m.lonDeg ?? 0) * DEG;
        latRad[i] = (m.latDeg ?? 0) * DEG;
    }
    return { apexAu, shockAu, weight, vKms, lonRad, latRad, count };
}
