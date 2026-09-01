#!/usr/bin/env node
/**
 * atmo-scale.mjs
 *
 * Pins js/atmo-scale.js — the ONE owner of troposphere vertical
 * exaggeration. What this gate is actually protecting:
 *
 *   1. CALIBRATION. E_FAR must reproduce the historical globe-view stack
 *      (surface 1.003 / 850 1.008 / 500 1.013 / 250 1.018, decks
 *      1.006/1.011/1.016). The ramp exists to add depth on approach, not to
 *      change what the planet looks like from orbit — if a retune drifts the
 *      far view, that is a regression, not a preference.
 *
 *   2. MONOTONICITY + ORDER. The stack may never invert. Higher real
 *      altitude ⇒ larger radius, at every exaggeration, and the ramp itself
 *      must be monotone in camera distance (a non-monotone ramp makes the
 *      layers cross each other mid-dolly).
 *
 *   3. THE CLEARANCE FLOOR. The surface layer is pinned, not scaled — it
 *      must stay put at every exaggeration while the levels above it fan
 *      out. This is the property that makes the fan-out readable.
 *
 *   4. THE OUTER-SHELL LIFT. Aurora / stratosphere / atmosphere rim must be
 *      untouched at globe view and strictly above the volume top once the
 *      ramp grows past them, or the limb glow paints under the cirrus.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import {
    R_EARTH_KM, LEVEL_ALTITUDE_KM, DECK_ALTITUDE_KM,
    VOLUME_TOP_KM, VOLUME_BASE_KM, SURFACE_CLEARANCE_R,
    RAMP_FAR_DIST, RAMP_NEAR_DIST, E_FAR, E_NEAR,
    exaggerationAt, radiusForAltitude, altitudeForRadius,
    shellRadii, outerShellRadii, cameraFloor, disclosureText, layerAtRadius,
} from '../js/atmo-scale.js';

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}

console.log('atmo-scale — troposphere vertical exaggeration');

// ── 1. Calibration against the historical constants ──────────────────────────
// These are the radii earth.html hard-coded before the ramp existed. The
// tolerance is deliberately tight: 0.0035 R ≈ the thickness of one shell gap.
check('E_FAR reproduces the historical globe-view stack', () => {
    const r = shellRadii(E_FAR);
    const near = (got, want, tol, what) =>
        assert.ok(Math.abs(got - want) <= tol,
            `${what}: ${got.toFixed(5)} vs historical ${want} (tol ${tol})`);
    near(r.windSfc,   1.003, 0.0005, 'surface wind trails');
    near(r.wind850,   1.008, 0.0035, '850 hPa trails');
    near(r.wind500,   1.013, 0.0035, '500 hPa trails');
    near(r.wind250,   1.018, 0.0035, '250 hPa jet trails');
    near(r.deckLow,   1.006, 0.0035, 'low deck');
    near(r.deckMid,   1.011, 0.0035, 'mid deck');
    near(r.deckHigh,  1.016, 0.0035, 'high deck');
});

check('far view keeps the whole volume under the historical atmosphere rim', () => {
    // R_ATM was 1.026 before the ramp. At globe view the marched volume must
    // still fit beneath it, or the very first frame renders cloud outside the
    // atmosphere.
    const r = shellRadii(E_FAR);
    assert.ok(r.volumeTop < 1.026,
        `volume top ${r.volumeTop.toFixed(5)} must sit under the 1.026 rim`);
});

// ── 2. Monotonicity and ordering ─────────────────────────────────────────────
check('ramp is monotone non-increasing in camera distance', () => {
    let prev = Infinity;
    for (let d = RAMP_NEAR_DIST - 0.5; d <= RAMP_FAR_DIST + 2; d += 0.02) {
        const e = exaggerationAt(d);
        assert.ok(e <= prev + 1e-9, `ramp rose at d=${d.toFixed(2)}: ${e} > ${prev}`);
        prev = e;
    }
});

check('ramp clamps to [E_FAR, E_NEAR] outside its anchors', () => {
    assert.equal(exaggerationAt(RAMP_FAR_DIST), E_FAR);
    assert.equal(exaggerationAt(10), E_FAR);
    assert.equal(exaggerationAt(RAMP_NEAR_DIST), E_NEAR);
    assert.equal(exaggerationAt(1.0), E_NEAR);
    // A non-finite distance (camera not yet placed) must not produce NaN
    // radii — it falls back to the far view.
    assert.equal(exaggerationAt(NaN), E_FAR);
});

check('stack never inverts, at any exaggeration on the ramp', () => {
    for (let d = 1.0; d <= 3.0; d += 0.05) {
        const r = shellRadii(exaggerationAt(d));
        // windSfc (10 m) sits below volumeBase (50 m fog base) — the
        // anemometer level really is under the lowest cloud we draw.
        const order = [
            ['windSfc', r.windSfc], ['volumeBase', r.volumeBase],
            ['deckLow', r.deckLow], ['wind850', r.wind850],
            ['deckMid', r.deckMid], ['wind500', r.wind500],
            ['deckHigh', r.deckHigh], ['wind250', r.wind250],
            ['volumeTop', r.volumeTop],
        ];
        // windSfc and volumeBase both sit on the clearance floor; everything
        // beyond must strictly ascend with real altitude.
        for (let i = 1; i < order.length; i++) {
            assert.ok(order[i][1] >= order[i - 1][1] - 1e-9,
                `d=${d.toFixed(2)}: ${order[i][0]} (${order[i][1].toFixed(5)}) < ` +
                `${order[i - 1][0]} (${order[i - 1][1].toFixed(5)})`);
        }
    }
});

check('higher real altitude always maps to larger radius', () => {
    for (const exag of [1, E_FAR, 25, E_NEAR, 200]) {
        let prev = -Infinity;
        for (const km of [0, 0.5, 1.5, 5.6, 10.4, 14]) {
            const r = radiusForAltitude(km, exag);
            assert.ok(r > prev, `exag ${exag}: ${km} km did not ascend`);
            prev = r;
        }
    }
});

// ── 3. The clearance floor ───────────────────────────────────────────────────
check('surface layer is pinned, not scaled', () => {
    // The whole point of measuring altitude up from a clearance floor: the
    // ground layer stays welded to the deck while the stack fans out above.
    const far  = shellRadii(E_FAR).windSfc;
    const near = shellRadii(E_NEAR).windSfc;
    assert.ok(Math.abs(far - near) < 1e-4,
        `surface shell moved ${(near - far).toFixed(6)} R across the ramp`);
    assert.ok(far >= SURFACE_CLEARANCE_R, 'surface shell sits on the floor');
    // …while 850 hPa demonstrably does fan out.
    const s850far  = shellRadii(E_FAR).wind850;
    const s850near = shellRadii(E_NEAR).wind850;
    assert.ok(s850near > s850far + 0.005,
        `850 hPa should fan out; moved only ${(s850near - s850far).toFixed(5)}`);
});

check('altitudeForRadius inverts radiusForAltitude', () => {
    for (const exag of [E_FAR, 30, E_NEAR]) {
        for (const km of [0.05, 1.5, 5.6, 10.4, 14]) {
            const back = altitudeForRadius(radiusForAltitude(km, exag), exag);
            assert.ok(Math.abs(back - km) < 1e-9,
                `exag ${exag}, ${km} km round-tripped to ${back}`);
        }
    }
    // Degenerate exaggeration must not divide by zero into Infinity.
    assert.equal(altitudeForRadius(1.01, 0), 0);
});

check('camera floor clears the surface shell but stays inside the stack', () => {
    for (const exag of [E_FAR, E_NEAR]) {
        const floor = cameraFloor(exag);
        const r = shellRadii(exag);
        assert.ok(floor > r.windSfc, 'floor is above the pinned surface shell');
        assert.ok(floor < r.volumeTop, 'floor is inside the volume — fly-through');
    }
    // At full fan-out the floor must be well below 850 hPa, or "descend into
    // the boundary layer" is not reachable.
    assert.ok(cameraFloor(E_NEAR) < shellRadii(E_NEAR).wind850);
});

// ── 4. The outer-shell lift ──────────────────────────────────────────────────
const HISTORICAL_OUTER = { aurora: 1.019, strat: 1.022, atm: 1.026 };

check('outer shells only ever move UP, and only a little at globe view', () => {
    // The marched volume has real extent where the old decals had none, so
    // the shells meant to sit above the weather do lift at globe view. That
    // is intended (see outerShellRadii's note) — what must not happen is a
    // shell moving DOWN, or ballooning far enough to change the planet's
    // silhouette from orbit.
    const top = shellRadii(E_FAR).volumeTop;
    const o = outerShellRadii(top, HISTORICAL_OUTER);
    for (const k of ['aurora', 'strat', 'atm']) {
        assert.ok(o[k] >= HISTORICAL_OUTER[k], `${k} moved down`);
        assert.ok(o[k] - HISTORICAL_OUTER[k] <= 0.010,
            `${k} lifted ${(o[k] - HISTORICAL_OUTER[k]).toFixed(4)} R at globe view — too far`);
    }
});

check('outer shells lift clear of the volume once the ramp grows past them', () => {
    for (let d = 1.0; d <= 3.0; d += 0.05) {
        const top = shellRadii(exaggerationAt(d)).volumeTop;
        const o = outerShellRadii(top, HISTORICAL_OUTER);
        assert.ok(o.aurora > top, `d=${d.toFixed(2)}: aurora inside the volume`);
        assert.ok(o.strat  > o.aurora, `d=${d.toFixed(2)}: strat below aurora`);
        assert.ok(o.atm    > o.strat,  `d=${d.toFixed(2)}: rim below strat`);
    }
});

// ── 5. Disclosure + the fly-through readout ──────────────────────────────────
check('disclosure names the live factor', () => {
    const t = disclosureText(E_NEAR);
    assert.ok(t.includes(`×${E_NEAR}`), `disclosure missing the factor: ${t}`);
    assert.ok(/exaggerat/i.test(t), 'disclosure must say it is exaggerated');
});

check('layerAtRadius names the band the camera is flying in', () => {
    const exag = E_NEAR;
    const r = shellRadii(exag);
    assert.equal(layerAtRadius(r.wind850, exag).key, '850');
    assert.equal(layerAtRadius(r.wind500, exag).key, '500');
    assert.equal(layerAtRadius(r.wind250, exag).key, '250');
    // Above the volume there is no troposphere band to report.
    assert.equal(layerAtRadius(r.volumeTop + 0.01, exag), null);
    // The reported altitude is the REAL one, not the drawn one.
    const at = layerAtRadius(r.wind500, exag);
    assert.ok(Math.abs(at.cameraAltKm - LEVEL_ALTITUDE_KM[500]) < 1e-6,
        `reported ${at.cameraAltKm} km, expected the real 5.6 km`);
});

// ── 6. Table sanity — the altitudes themselves ───────────────────────────────
check('altitude table is physically ordered and spans the troposphere', () => {
    assert.ok(LEVEL_ALTITUDE_KM.sfc < LEVEL_ALTITUDE_KM[850]);
    assert.ok(LEVEL_ALTITUDE_KM[850] < LEVEL_ALTITUDE_KM[500]);
    assert.ok(LEVEL_ALTITUDE_KM[500] < LEVEL_ALTITUDE_KM[250]);
    for (const k of ['low', 'mid', 'high']) {
        const d = DECK_ALTITUDE_KM[k];
        assert.ok(d.base < d.mid && d.mid < d.top, `deck ${k} centroid outside its extent`);
    }
    assert.ok(DECK_ALTITUDE_KM.high.top <= VOLUME_TOP_KM,
        'marched volume must contain the cirrus top');
    assert.ok(VOLUME_BASE_KM < DECK_ALTITUDE_KM.low.base,
        'marched volume must reach below the low deck base (fog/stratus)');
    assert.equal(R_EARTH_KM, 6371);
});

console.log('──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
