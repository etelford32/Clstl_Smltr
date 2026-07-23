#!/usr/bin/env node
/**
 * stage-model.mjs — fixture gate for the Stage scene model
 * (js/stage/model.js), including the KERNEL-ORACLE PIN: the model builds
 * rope geometry only through the view.js mirrors, and this gate proves
 * those mirrors still agree with the committed WASM's effective-dynamics
 * probes (fr_apex_km_at / fr_sigma_apex_km_at) on the St. Patrick's v1.4
 * validated fit. If rope.rs kinematics change, THIS fails until the
 * mirrors are re-synced — same contract as the flux-rope view.
 *
 *   node tests/stage-model.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadFluxRopeKernel } from '../js/flux-rope-kernel.js';
import { ST_PATRICK_FIT } from '../js/flux-rope-presets.js';
import { ropeFrame } from '../js/flux-rope/view.js';
import {
    ropeSurfacePoint, ropeSurfaceGrid, ropeAxisPoints, ropeSpecAt,
    ghostMembers, quantileWeighted, wavefrontRadiiAu,
    shueSurfaceGrid, parkerSpiralPoints, stationDefs, easeInOutCubic,
    flightPose, D0_KM_DEFAULT, dynamicPressure,
    ovalLatAtLon, ovalBandGrid, kpBandAt, subsolarLonDeg, earthLocal,
    sunEclipticLonDeg, temeToStageRe, parseTleRaan, assetOrbitRing, mySkyPose,
    windFieldAt, AMBIENT_V_KMS, AMBIENT_N_CC, memberFieldRows,
    xrayClassOf, sunActivityAt, flareFlashAt,
    normalizeFlares, parcelProbe, liftoffAt,
    sepStateAt, SEP_V_KMS,
} from '../js/stage/model.js';
import { shueStandoffRe, shueAlpha } from '../js/ring-current-model.js';
import { magneticLatitude, boundaryForKp } from '../js/verdict-engine.js';
import { density, kpToAp } from '../js/upper-atmosphere-engine.js';
import { AU_KM, RE_KM, EARTH_S } from '../js/stage/scale.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const H = 3600;

const kernel = await loadFluxRopeKernel(await readFile(fileURLToPath(
    new URL('../js/flux-rope-wasm/flux_rope_core.wasm', import.meta.url))));

/* ── THE kernel-oracle pin ──────────────────────────────────────────── */

test('JS mirror apex/σ ≡ WASM effective probes on the St. Patrick fit', () => {
    const fit = ST_PATRICK_FIT.standoffFit.rope;
    kernel.reset();
    kernel.setRope(fit);
    for (const tH of [6, 24, 48, 90]) {
        const spec = ropeSpecAt(fit, fit.wKms, tH * H);
        const apexKm = kernel.apexKmAt(0, tH * H);
        const sigKm = kernel.sigmaApexKmAt(0, tH * H);
        const relD = Math.abs(spec.dAu * AU_KM - apexKm) / apexKm;
        const relS = Math.abs(spec.sigApexAu * AU_KM - sigKm) / sigKm;
        assert.ok(relD < 1e-6, `apex t=${tH}h rel ${relD.toExponential(2)}`);
        assert.ok(relS < 1e-6, `sigma t=${tH}h rel ${relS.toExponential(2)}`);
    }
});

/* ── Rope surface geometry (the SDF zero level) ─────────────────────── */

const SPEC = { frame: ropeFrame(0, 0, 0), dAu: 1, sigApexAu: 0.1 };

test('apex cross-section: known exact points', () => {
    // ψ=π, θ=0: outward along ê_dir → [d + σ_apex, 0, 0].
    const p = ropeSurfacePoint(SPEC, Math.PI, 0);
    assert.ok(Math.hypot(p[0] - 1.1, p[1], p[2]) < 1e-12);
    // θ=π: inward → [d − σ_apex, 0, 0].
    const q = ropeSurfacePoint(SPEC, Math.PI, Math.PI);
    assert.ok(Math.hypot(q[0] - 0.9, q[1], q[2]) < 1e-12);
    // θ=π/2: out of plane along n̂ (z for an untilted rope).
    const z = ropeSurfacePoint(SPEC, Math.PI, Math.PI / 2);
    assert.ok(Math.abs(z[2] - 0.1) < 1e-12 && Math.abs(z[0] - 1) < 1e-12);
});

test('footpoints pinch to the Sun (σ→0, axis→origin)', () => {
    const p = ropeSurfacePoint(SPEC, 0.05, 1.3);
    assert.ok(Math.hypot(...p) < 0.03, `|p| ${Math.hypot(...p)}`);
});

test('surface grid: shapes, finite, indices in range', () => {
    const g = ropeSurfaceGrid(SPEC, 32, 16);
    assert.equal(g.positions.length, 33 * 17 * 3);
    assert.ok(g.positions.every(Number.isFinite));
    assert.equal(g.indices.length, 32 * 16 * 6);
    assert.ok(Math.max(...g.indices) < 33 * 17);
});

test('axis polyline is the d/2 circle through the Sun', () => {
    const pts = ropeAxisPoints(SPEC, 48);
    for (let i = 0; i <= 48; i++) {
        const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
        assert.ok(Math.abs(Math.hypot(x - 0.5, y) - 0.5) < 1e-6, `on-circle at ${i}`);
        assert.ok(Math.abs(z) < 1e-12, 'untilted rope stays in the ecliptic');
    }
});

/* ── Ghost members + wavefronts ─────────────────────────────────────── */

test('ghostMembers unpacks the wrapper layout and fades by weight', () => {
    const members = 10, stride = 7;
    const mp = new Float32Array(members * stride);
    for (let m = 0; m < members; m++) {
        mp[m * stride] = m;            // lonDeg = member index (marker)
        mp[m * stride + 3] = 500 + m;  // v0
        mp[m * stride + 5] = 0.1;      // sigma
        mp[m * stride + 6] = 1;
    }
    const ens = { members, memberStride: stride, ropesPerMember: 1, memberParams: mp };
    const g = ghostMembers(ens, null, 4);
    assert.equal(g.length, 4);
    assert.deepEqual(g.map((x) => x.lonDeg), [0, 2, 5, 7]);
    assert.ok(g.every((x) => x.weight === 1));
    const weights = new Float32Array(members).fill(0.02);
    weights[0] = 0.2;
    const gw = ghostMembers(ens, weights, 4);
    assert.equal(gw[0].weight, 1);
    assert.ok(Math.abs(gw[1].weight - 0.1) < 1e-6, 'faded relative to the max weight');
});

test('quantileWeighted: unweighted median + weighted skew', () => {
    assert.equal(quantileWeighted([5, 1, 3, 2, 4], null, 0.5), 3);
    assert.equal(quantileWeighted([1, 2, 3], [0.98, 0.01, 0.01], 0.5), 1);
    assert.equal(quantileWeighted([NaN, 2], null, 0.5), 2);
    assert.equal(quantileWeighted([], null, 0.5), null);
});

test('wavefronts: ordered quantiles, advancing with τ, null before launch', () => {
    const members = Array.from({ length: 100 }, (_, i) => ({
        v0Kms: 450 + 6 * i, gammaPerKm: 0.2e-7,
    }));
    const w40 = wavefrontRadiiAu(members, 400, 40 * H);
    assert.ok(w40.p10 < w40.p50 && w40.p50 < w40.p90, 'spread ordering');
    const w50 = wavefrontRadiiAu(members, 400, 50 * H);
    assert.ok(w50.p50 > w40.p50, 'the front advances');
    assert.equal(wavefrontRadiiAu(members, 400, 0), null);
});

/* ── Magnetopause + context dressing ────────────────────────────────── */

test('Shue grid relays the ring-current oracle and breathes with Pdyn', () => {
    const quiet = shueSurfaceGrid(2, 0);
    assert.ok(Math.abs(quiet.r0 - shueStandoffRe(2, 0)) < 1e-12);
    assert.ok(Math.abs(quiet.alpha - shueAlpha(2, 0)) < 1e-12);
    // Nose points at the Sun: first lattice row is (−r0, 0, 0).
    assert.ok(Math.abs(quiet.positions[0] + quiet.r0) < 1e-5);
    assert.ok(Math.abs(quiet.positions[1]) < 1e-6 && Math.abs(quiet.positions[2]) < 1e-6);
    const storm = shueSurfaceGrid(30, -20);
    assert.ok(storm.r0 < quiet.r0, 'storm compresses the nose');
    assert.ok(storm.r0 < 6.6, 'the 30 nPa / −20 nT case bites inside GEO');
    // Tail cap honored.
    for (let i = 0; i < quiet.positions.length; i += 3) {
        const r = Math.hypot(quiet.positions[i], quiet.positions[i + 1], quiet.positions[i + 2]);
        assert.ok(r <= 28 * 1.01, `tail capped (r=${r})`);
    }
    assert.ok(Math.abs(dynamicPressure(5, 450) - 1.67e-6 * 5 * 450 * 450) < 1e-9);
});

test('Parker spiral curls with distance (context only)', () => {
    const pts = parkerSpiralPoints(400, 0, 60, 1.1);
    assert.equal(pts.length, 180);
    const phi = (i) => Math.atan2(pts[i * 3 + 1], pts[i * 3]);
    // Unwrapped azimuth strictly decreases (trailing spiral for Ω > 0).
    let prev = phi(0), unwrapped = prev;
    for (let i = 1; i < 60; i++) {
        let d = phi(i) - prev;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        assert.ok(d < 0, `spiral trails at ${i}`);
        unwrapped += d; prev = phi(i);
    }
    assert.ok(unwrapped < -1, 'a 1 AU line winds substantially');
});

/* ── Stations & flights ─────────────────────────────────────────────── */

test('six stations in narrative order with sane frames', () => {
    const s = stationDefs();
    assert.deepEqual(s.map((x) => x.id),
        ['solar-watch', 'corridor', 'l1-approach', 'magnetosphere', 'my-sky', 'orbit-ops']);
    for (const st of s) {
        assert.ok([...st.pos, ...st.target].every(Number.isFinite));
        assert.ok(st.minD > 0 && st.maxD > st.minD);
    }
    const l1 = s[2];
    assert.ok(l1.target[0] < l1.pos[0], 'L1 Approach looks sunward');
    // The persona stagings live in the Earth neighbourhood.
    for (const st of [s[4], s[5]]) {
        assert.ok(Math.hypot(st.pos[0] - EARTH_S, st.pos[1], st.pos[2]) < 0.6, st.id);
    }
});

test('flight easing: endpoints exact, midpoint eased', () => {
    assert.equal(easeInOutCubic(0), 0);
    assert.equal(easeInOutCubic(1), 1);
    assert.equal(easeInOutCubic(0.5), 0.5);
    const [a, b] = stationDefs();
    assert.deepEqual(flightPose(a, b, 0).pos, a.pos);
    assert.deepEqual(flightPose(a, b, 1).target, b.target);
});

/* ── S2: aurora oval band (oracle = verdict-engine dipole + table) ──── */

test('ovalLatAtLon inverts the magneticLatitude oracle on both hemispheres', () => {
    for (const kp of [2, 5, 9]) {
        const b = boundaryForKp(kp);
        for (const lon of [-180, -72.7, 0, 95]) {
            for (const hemi of [1, -1]) {
                const lat = ovalLatAtLon(b, lon, hemi);
                assert.ok(hemi * lat > 0, `hemisphere sign kp=${kp} lon=${lon}`);
                const m = Math.abs(magneticLatitude(lat, lon));
                assert.ok(Math.abs(m - b) < 0.02,
                    `kp=${kp} lon=${lon} hemi=${hemi}: |mlat| ${m.toFixed(3)} vs boundary ${b.toFixed(3)}`);
            }
        }
    }
});

test('oval band: poleward > median > equatorward at every longitude', () => {
    const g = ovalBandGrid({ p10: 3, p50: 5, p90: 7 }, 36);
    assert.equal(g.lons.length, 37);
    for (let i = 0; i < g.lons.length; i++) {
        assert.ok(g.poleward[i] > g.median[i] && g.median[i] > g.equatorward[i],
            `ordering at lon ${g.lons[i]}`);
    }
    // Storm band sits equatorward of a quiet band.
    const quiet = ovalBandGrid({ p10: 1, p50: 2, p90: 3 }, 36);
    assert.ok(g.median[0] < quiet.median[0]);
});

test('kpBandAt: τ-indexed arp band, degenerate past/missing, clamped', () => {
    const T0 = Date.parse('2026-07-22T00:00:00Z');
    const timeline = { updated_at: T0, trajectory: {
        h_steps: 3, start_ms: T0,
        arp: { mean: [4, 5, 6], lo80: [3, 4, 5], hi80: [5, 7, 12] },
    } };
    const b2 = kpBandAt(T0 + 2 * 3.6e6, timeline, 2);
    assert.deepEqual(b2, { p10: 4, p50: 5, p90: 7 });
    assert.equal(kpBandAt(T0 + 3 * 3.6e6, timeline, 2).p90, 9, 'hi80 clamps to Kp 9');
    assert.deepEqual(kpBandAt(T0 - 3.6e6, timeline, 2), { p10: 2, p50: 2, p90: 2 });
    assert.deepEqual(kpBandAt(T0 + 3.6e6, null, 3.5), { p10: 3.5, p50: 3.5, p90: 3.5 });
    assert.equal(kpBandAt(T0, null, null), null);
});

/* ── S2: geographic + orbital display frames ────────────────────────── */

test('mean-sun geography: subsolar meridian faces the Sun (−x), poles on ±z', () => {
    const noon = Date.parse('2026-07-22T12:00:00Z');
    assert.ok(Math.abs(subsolarLonDeg(noon)) < 1e-9, '12:00 UTC → subsolar 0°E');
    const p = earthLocal(0, subsolarLonDeg(noon), 1, noon);
    assert.ok(Math.hypot(p[0] + 1, p[1], p[2]) < 1e-12, 'subsolar point at −x');
    assert.ok(Math.hypot(...earthLocal(90, 0, 1, noon).map((v, i) => v - [0, 0, 1][i])) < 1e-9);
    const q = earthLocal(30, 40, 2.5, noon);
    assert.ok(Math.abs(Math.hypot(...q) - 2.5) < 1e-12, 'radius preserved');
});

test('mean solar longitude: J2000 anchor + daily rate', () => {
    const j2000 = Date.UTC(2000, 0, 1, 12);
    assert.ok(Math.abs(sunEclipticLonDeg(j2000) - 280.46) < 0.01);
    const d10 = sunEclipticLonDeg(j2000 + 10 * 86400e3) - sunEclipticLonDeg(j2000);
    const wrapped = ((d10 % 360) + 360) % 360;
    assert.ok(Math.abs(wrapped - 9.856474) < 1e-6);
});

test('temeToStageRe: rigid rotation about z, km → R_E', () => {
    const t = Date.parse('2026-07-22T05:00:00Z');
    const v = temeToStageRe({ x: 5000, y: -3000, z: 4000 }, t);
    assert.ok(Math.abs(Math.hypot(...v) - Math.hypot(5000, -3000, 4000) / RE_KM) < 1e-9);
    assert.ok(Math.abs(v[2] - 4000 / RE_KM) < 1e-12, 'z untouched');
});

test('TLE line-2 RAAN parse (ISS sample)', () => {
    assert.equal(parseTleRaan(
        '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537'), 247.4627);
    assert.equal(parseTleRaan(null), 0);
});

test('asset orbit ring: constant mean-altitude radius, inclination sets max |z|', () => {
    const ring = assetOrbitRing({ inclDeg: 51.6, raanDeg: 247.5, altKm: 420 }, 64);
    const r = (RE_KM + 420) / RE_KM;
    let zMax = 0;
    for (let k = 0; k <= 64; k++) {
        const x = ring[k * 3], y = ring[k * 3 + 1], z = ring[k * 3 + 2];
        assert.ok(Math.abs(Math.hypot(x, y, z) - r) < 1e-6, `radius at ${k}`);
        zMax = Math.max(zMax, Math.abs(z));
    }
    assert.ok(Math.abs(zMax - r * Math.sin(51.6 * Math.PI / 180)) < 1e-3);
    // The ascending node sits along the RAAN direction in the equator plane.
    // f32 storage: tolerances at the Float32Array quantum, not f64.
    const eq = assetOrbitRing({ inclDeg: 0, raanDeg: 90, altKm: 420 }, 4);
    assert.ok(Math.abs(eq[0]) < 1e-6 && Math.abs(eq[1] - r) < 1e-6, 'u=0 at the node');
});

test('mySkyPose: camera just above the pin, target on the northward horizon', () => {
    const t = Date.parse('2026-07-22T06:00:00Z');
    const { pos, target } = mySkyPose(45, -105, t);
    assert.ok(Math.abs(Math.hypot(...pos) - 1.10) < 1e-9);
    assert.ok(Math.abs(Math.hypot(...target) - 1.02) < 1e-9);
    assert.ok(target[2] > pos[2], 'looking poleward');
});

/* ── S2: the drag oracle the heat-shell colors encode ───────────────── */

test('thermosphere density rises with activity (UA-engine oracle)', () => {
    const at = (kp) => density({ altitudeKm: 550, f107Sfu: 150, ap: kpToAp(kp) }).rho;
    assert.ok(at(5) > at(2) && at(8) > at(5), 'monotone in Kp');
    assert.ok(at(8) / at(2) > 1.5, 'a G4 storm is a visible drag event at 550 km');
});

test('S5a windFieldAt: ambient = the driver sample, clamped density', () => {
    // The particle field is MEASUREMENT in quiet time: speed passes the
    // driver sample through untouched, density is relative-to-climatology.
    const r = windFieldAt(0.5, { vKms: 520, nCc: 10 });
    assert.equal(r.regime, 'ambient');
    assert.equal(r.vKms, 520);
    assert.equal(r.nRel, 2);                       // 10 / AMBIENT_N_CC
    // Clamps: a gust can neither wash out nor empty the scene.
    assert.equal(windFieldAt(0.5, { nCc: 500 }).nRel, 4);
    assert.equal(windFieldAt(0.5, { nCc: 0.01 }).nRel, 0.2);
    // Honest fallbacks with no driver.
    const f = windFieldAt(0.5);
    assert.equal(f.vKms, AMBIENT_V_KMS);
    assert.equal(f.nRel, 1);
    assert.equal(AMBIENT_N_CC, 5);                 // matches provider ambientNCc
});

test('S5a windFieldAt: regime boundaries at the kernel radii (S5b contract)', () => {
    const amb = { vKms: 420, nCc: 5 };
    const cme = { shockAu: 0.8, ejectaAu: 0.7, compression: 3, vKms: 750 };
    // Upstream of the shock: undisturbed ambient.
    assert.equal(windFieldAt(0.9, amb, cme).regime, 'ambient');
    assert.equal(windFieldAt(0.9, amb, cme).vKms, 420);
    // Between ejecta front and shock: sheath — CME speed, piled-up density.
    const sh = windFieldAt(0.75, amb, cme);
    assert.equal(sh.regime, 'sheath');
    assert.equal(sh.vKms, 750);
    assert.equal(sh.nRel, 3);                      // 1 × compression
    // Behind the ejecta front: ejecta — CME speed, no pile-up.
    const ej = windFieldAt(0.5, amb, cme);
    assert.equal(ej.regime, 'ejecta');
    assert.equal(ej.vKms, 750);
    assert.equal(ej.nRel, 1);
    // Degenerate structure (shock not ahead of ejecta) → ambient.
    assert.equal(windFieldAt(0.5, amb, { shockAu: 0.6, ejectaAu: 0.7 }).regime,
        'ambient');
    // Compression is clamped (RH limit is 4; guard allows headroom to 6).
    assert.equal(windFieldAt(0.75, amb, { ...cme, compression: 99 }).nRel, 6);
});

test('S5b memberFieldRows: member-bound rows — apex growth, weights, empty slots', () => {
    const members = [
        { v0Kms: 900, gammaPerKm: 2e-7, weight: 1.0, lonDeg: -10, latDeg: 5 },
        { v0Kms: 500, gammaPerKm: 2e-7, weight: 0.25, lonDeg: 8, latDeg: -3 },
    ];
    const H = 3600;
    const r1 = memberFieldRows(members, 400, 24 * H, { shockOffsetAu: 0.05 });
    const r2 = memberFieldRows(members, 400, 48 * H, { shockOffsetAu: 0.05 });
    assert.equal(r1.count, 2);
    // Apexes advance with τ; the faster member leads — the FAN is real.
    assert.ok(r2.apexAu[0] > r1.apexAu[0]);
    assert.ok(r1.apexAu[0] > r1.apexAu[1], 'fast member ahead of slow');
    // Shock rides a fixed offset ahead of each member front. (Float32
    // storage: 1e-6 tolerance, the house lesson.)
    assert.ok(Math.abs(r1.shockAu[0] - r1.apexAu[0] - 0.05) < 1e-6);
    // Filter weights carried; slots past count stay weight 0 (invisible).
    assert.equal(r1.weight[0], 1);
    assert.equal(r1.weight[1], 0.25);
    assert.equal(r1.weight[2], 0);
    // Front speed: positive, decayed below v0, above the ambient wind
    // for a decelerating fast member.
    assert.ok(r1.vKms[0] > 400 && r1.vKms[0] < 900);
    // Directions in radians, ropeFrame eDir convention (Float32 tol).
    assert.ok(Math.abs(r1.lonRad[0] + 10 * Math.PI / 180) < 1e-6);
    assert.ok(Math.abs(r1.latRad[1] + 3 * Math.PI / 180) < 1e-6);
    // Degenerate inputs refuse honestly.
    assert.equal(memberFieldRows([], 400, 3600), null);
    assert.equal(memberFieldRows(members, 400, 0), null);
});

test('the sun always has behavior: X-ray grammar, τ-lookup, flare flash', () => {
    // Class grammar matches the ticker's A/B/C/M/X bands.
    assert.equal(xrayClassOf(2.3e-6), 'C2.3');
    assert.equal(xrayClassOf(5.0e-5), 'M5.0');
    assert.equal(xrayClassOf(2.0e-4), 'X2.0');
    assert.equal(xrayClassOf(0), 'A0.0');
    // τ-lookup: nearest sample, edge-clamped; act is the log ramp
    // A(1e-8)→0 … X(1e-4)→1.
    const T = Date.parse('2026-07-22T00:00Z');
    const series = [
        { t: T, flux: 1e-7 },              // B-class background
        { t: T + 3.6e6, flux: 5e-5 },      // M5 flare hour
    ];
    assert.equal(sunActivityAt(series, T + 3.5e6).cls, 'M5.0');
    assert.equal(sunActivityAt(series, T - 999e9).cls, 'B1.0');   // edge clamp
    assert.ok(Math.abs(sunActivityAt(series, T).act - 0.25) < 1e-9);  // B = 0.25
    // Fallbacks: no series → latest scalar → quiet A-class.
    assert.equal(sunActivityAt(null, T, 3e-6).cls, 'C3.0');
    assert.equal(sunActivityAt([], T).cls, 'A1.0');
    // Flare flash: fast rise, 40-min decay, class-weighted, max-over.
    const flares = [{ timeMs: T, letter: 'M' }, { timeMs: T + 9e9, letter: 'X' }];
    assert.equal(flareFlashAt(flares, T), 0.7);                   // M peak
    assert.ok(Math.abs(flareFlashAt(flares, T + 20 * 60e3) - 0.35) < 1e-9);
    assert.equal(flareFlashAt(flares, T + 3.6e6), 0);             // decayed
    assert.equal(flareFlashAt(flares, T - 30 * 60e3), 0);         // not yet
    assert.equal(flareFlashAt([{ timeMs: T, letter: 'B' }], T), 0);  // sub-C ignored
    assert.equal(flareFlashAt(null, T), 0);
});

test('S5d measurement: parcelProbe reads the field, lead time, Parker source', () => {
    const T = Date.parse('2026-07-22T00:00Z');
    // Ambient monitor at 0.5 AU, 400 km/s: lead time to Earth is the
    // remaining half-AU at the local flow speed (~52 h), and the Parker
    // source longitude sits WEST of (ahead of) the probe longitude.
    const p = parcelProbe(0.5, 0.3, { vKms: 400, nCc: 5 }, null, T);
    assert.equal(p.regime, 'ambient');
    assert.ok(Math.abs(p.leadHours - 0.5 * 1.495978707e8 / 400 / 3600) < 1e-9);
    assert.ok(Math.abs(p.etaMs - (T + p.leadHours * 3.6e6)) < 1);
    assert.ok(p.srcLonRad > 0.3, 'source longitude ahead of the probe');
    // The connectivity curve parkerSpiralPoints draws from spiralPhi0Deg
    // passes through the probe point (same Ω, same 0.05 AU base).
    const pts = parkerSpiralPoints(p.vKms, p.spiralPhi0Deg, 901, 1.12);
    let best = Infinity;
    for (let i = 0; i < 901; i++) {
        const r = Math.hypot(pts[i * 3], pts[i * 3 + 1]);
        const phi = Math.atan2(pts[i * 3 + 1], pts[i * 3]);
        best = Math.min(best, Math.hypot(r - 0.5, phi - 0.3));
    }
    assert.ok(best < 5e-3, `spiral passes through the probe (miss ${best})`);
    // A faster wind unwinds the spiral: source longitude closer to the probe.
    const fast = parcelProbe(0.5, 0.3, { vKms: 700, nCc: 5 }, null, T);
    assert.ok(fast.srcLonRad < p.srcLonRad);
    // CME structure flips the regime through the SAME windFieldAt oracle.
    const cme = { shockAu: 0.6, ejectaAu: 0.45, compression: 3, vKms: 800 };
    assert.equal(parcelProbe(0.5, 0, {}, cme, T).regime, 'sheath');
    assert.equal(parcelProbe(0.4, 0, {}, cme, T).regime, 'ejecta');
    assert.equal(parcelProbe(0.7, 0, {}, cme, T).regime, 'ambient');
    // At/past 1 AU there is nothing left to lead.
    assert.equal(parcelProbe(1.0, 0, {}, null, T).leadHours, null);
});

test('S5d flare sourcing: normalizeFlares merges NOAA + DONKI honestly', () => {
    const T = Date.parse('2026-07-22T00:00Z');
    const noaa = [{ time: new Date(T), parsed: { letter: 'M' }, region: 14001 }];
    const donki = [
        // Same event seen by DONKI 2 min later (dedupe, keep NOAA row)…
        { peak_time: new Date(T + 2 * 60e3), class_letter: 'M', active_region: 14001 },
        // …and a DONKI-only X flare (NOAA feed retired — the production path).
        { peak_time: new Date(T + 7.2e6), class_letter: 'X', active_region: 14002 },
    ];
    const merged = normalizeFlares(noaa, donki);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].letter, 'X');              // most recent first
    assert.equal(merged[0].region, 14002);
    assert.equal(merged[1].timeMs, T);                // NOAA row kept
    // DONKI-only input works alone (recent_flares empty in production).
    const only = normalizeFlares([], donki);
    assert.equal(only.length, 2);
    assert.ok(only.every((f) => Number.isFinite(f.timeMs) && f.letter));
    // …and feeds the flash envelope directly.
    assert.equal(flareFlashAt(only, T + 7.2e6), 1);   // X peak
    assert.equal(normalizeFlares(null, null).length, 0);
});

test('S5c SEP: S-scale gate at τ, log intensity, honest speed', () => {
    const T = Date.parse('2026-07-22T00:00Z');
    // NOAA S-scale boundaries: S1 at 10 pfu, ×10 per step. Below S1 the
    // streaks are OFF — quiet corridors stay quiet.
    assert.equal(sepStateAt(null, T, 9).on, false);
    assert.equal(sepStateAt(null, T, 9).s, 0);
    assert.deepEqual(
        [10, 100, 1e3, 1e4, 1e5].map((f) => sepStateAt(null, T, f).s),
        [1, 2, 3, 4, 5]);
    // Intensity is the log ramp S1→0 … S5→1, monotone.
    assert.equal(sepStateAt(null, T, 10).intensity, 0);
    assert.equal(sepStateAt(null, T, 1e5).intensity, 1);
    assert.ok(sepStateAt(null, T, 1e3).intensity > sepStateAt(null, T, 100).intensity);
    // τ-lookup: nearest series sample wins over the fallback scalar —
    // replaying yesterday's proton event lights the spirals THEN.
    const series = [
        { t: T, flux: 2 },                 // quiet
        { t: T + 3.6e6, flux: 500 },       // S2 storm hour
    ];
    assert.equal(sepStateAt(series, T + 3.5e6, 2).s, 2);
    assert.equal(sepStateAt(series, T, 500).on, false);      // quiet at THIS τ
    assert.equal(sepStateAt(series, T + 999e9, 0).s, 2);     // edge clamp
    assert.equal(sepStateAt([], T).on, false);               // null-safe
    // Representative streak speed: a 10–100 MeV proton (0.15–0.43 c).
    const c = 299792;
    assert.ok(SEP_V_KMS > 0.25 * c && SEP_V_KMS < 0.45 * c);
    // The visual contrast the plan names: SEP transit is ~200× faster
    // than a 450 km/s wind parcel.
    assert.ok(SEP_V_KMS / 450 > 100);
});

test('S5d liftoff: envelope rises into launch and decays over 90 min', () => {
    const L = Date.parse('2026-07-22T06:00Z');
    assert.equal(liftoffAt(L, L - 3.6e6), 0);          // an hour before: nothing
    assert.ok(Math.abs(liftoffAt(L, L - 7.5 * 60e3) - 0.5) < 1e-9);  // rising
    assert.equal(liftoffAt(L, L), 1);                  // eruption
    assert.ok(Math.abs(liftoffAt(L, L + 45 * 60e3) - 0.5) < 1e-9);   // decaying
    assert.equal(liftoffAt(L, L + 2 * 3.6e6), 0);      // cleared the corona
    assert.equal(liftoffAt(null, L), 0);               // no event, no plume
});

console.log(`stage-model: ALL PASS (${n} tests)`);
