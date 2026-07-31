#!/usr/bin/env node
/**
 * moon-interior-model.mjs — gate for js/moon-interior-model.js.
 *
 * Run: node tests/moon-interior-model.mjs
 *
 * The load-bearing pins:
 *   • The layers must integrate to the MEASURED lunar mass (<1%) and give
 *     the measured surface gravity — retuning one density breaks this.
 *   • Central pressure ~5 GPa (the accepted figure), monotone outward.
 *   • The partial-melt layer must EMERGE from T ≥ solidus in exactly the
 *     Weber et al. (2011) 330–480 km band — melt is derived, not painted.
 *   • The fluid outer core is the ONLY vS = 0 layer (S-wave shadow).
 *   • The anomalistic tidal clock is periodic at 27.554550 days with the
 *     perigee peak dominating apogee.
 *   • The dynamo timeline: Earth-like at 4 Ga, exactly zero today.
 */

import assert from 'node:assert/strict';
import {
    R_MOON_KM, MOON_MASS_MEASURED_KG, MOON_MASS_MODEL_KG, LAYERS, layerAt,
    enclosedMassKg, gravityMS2, pressureGPa,
    selenothermK, solidusK, meltFraction, crustThicknessKm,
    ANOMALISTIC_MONTH_DAYS, REF_PERIGEE_MS, anomalisticPhase, deepMoonquakeRate,
    DEEP_NESTS, SHALLOW_QUAKE_FACTS,
    DYNAMO_EPOCHS, dynamoSurfaceFieldMicroT, CRUSTAL_ANOMALIES,
} from '../js/moon-interior-model.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ── 1. Layer structure: contiguous, ordered, no gaps ─────────────────────────
{
    assert.equal(LAYERS[0].rInnerKm, 0, 'innermost layer starts at center');
    assert.equal(LAYERS[LAYERS.length - 1].rOuterKm, R_MOON_KM, 'outermost layer ends at surface');
    for (let i = 1; i < LAYERS.length; i++) {
        assert.equal(LAYERS[i].rInnerKm, LAYERS[i - 1].rOuterKm,
            `layer ${LAYERS[i].key} contiguous with ${LAYERS[i - 1].key}`);
    }
    // Weber et al. 2011 radii
    assert.equal(LAYERS.find(l => l.key === 'inner-core').rOuterKm, 240, 'inner core 240 km');
    assert.equal(LAYERS.find(l => l.key === 'outer-core').rOuterKm, 330, 'outer core 330 km');
    assert.equal(LAYERS.find(l => l.key === 'lvz').rOuterKm, 480, 'LVZ top 480 km');
    // layerAt containment
    assert.equal(layerAt(0).key, 'inner-core');
    assert.equal(layerAt(300).key, 'outer-core');
    assert.equal(layerAt(400).key, 'lvz');
    assert.equal(layerAt(1000).key, 'mantle');
    assert.equal(layerAt(R_MOON_KM).key, 'crust', 'surface belongs to crust');
    assert.equal(layerAt(-1), null);
    assert.equal(layerAt(R_MOON_KM + 1), null);
    ok('layer structure contiguous with Weber (2011) radii');
}

// ── 2. The planet adds up: mass, gravity, pressure ───────────────────────────
{
    const massErr = Math.abs(MOON_MASS_MODEL_KG - MOON_MASS_MEASURED_KG) / MOON_MASS_MEASURED_KG;
    assert.ok(massErr < 0.01, `integrated mass within 1% of measured (err ${(massErr * 100).toFixed(3)}%)`);
    near(gravityMS2(R_MOON_KM), 1.62, 0.02, 'surface gravity 1.62 m/s²');
    const pc = pressureGPa(0);
    assert.ok(pc > 4 && pc < 6, `central pressure ~5 GPa (got ${pc.toFixed(2)})`);
    near(pressureGPa(R_MOON_KM), 0, 1e-6, 'surface pressure zero');
    // monotone: pressure decreases outward, enclosed mass increases
    for (let r = 0; r < R_MOON_KM; r += 100) {
        assert.ok(pressureGPa(r) > pressureGPa(r + 100), `P monotone at ${r}`);
        assert.ok(enclosedMassKg(r) < enclosedMassKg(r + 100), `m monotone at ${r}`);
    }
    // gravity peaks inside (density contrast), is zero at center
    near(gravityMS2(0), 0, 1e-9, 'g(0) = 0');
    ok(`mass ${(MOON_MASS_MODEL_KG / 1e22).toFixed(4)}e22 kg, g=1.62, P(0)=${pc.toFixed(2)} GPa`);
}

// ── 3. Selenotherm + derived melt ────────────────────────────────────────────
{
    for (let r = 0; r < R_MOON_KM; r += 50) {
        assert.ok(selenothermK(r) >= selenothermK(r + 50) - 1e-9, `T monotone outward at ${r}`);
    }
    near(selenothermK(0), 1700, 1, 'central T anchor');
    near(selenothermK(R_MOON_KM), 250, 1, 'surface T anchor');
    // Melt emerges in — and only in — the Weber LVZ band
    assert.ok(meltFraction(400) > 0.02, 'partial melt present mid-LVZ');
    assert.ok(meltFraction(340) > 0, 'melt at LVZ base');
    assert.equal(meltFraction(600), 0, 'no melt at 600 km');
    assert.equal(meltFraction(1000), 0, 'no melt at 1000 km');
    assert.equal(meltFraction(1690), 0, 'no melt under crust');
    assert.equal(meltFraction(100), 0, 'silicate melt fraction not defined in core');
    assert.ok(meltFraction(400) < 0.3, 'melt fraction stays in the published ~5–30% band');
    ok('melt fraction emerges from T ≥ solidus only in 330–480 km');
}

// ── 4. S-wave shadow: fluid outer core only ──────────────────────────────────
{
    const fluidLayers = LAYERS.filter(l => l.vsKmS === 0);
    assert.equal(fluidLayers.length, 1, 'exactly one vS=0 layer');
    assert.equal(fluidLayers[0].key, 'outer-core', 'and it is the outer core');
    assert.equal(fluidLayers[0].state, 'fluid');
    ok('S-waves cross everything except the fluid outer core');
}

// ── 5. Crustal asymmetry ─────────────────────────────────────────────────────
{
    const near0 = crustThicknessKm(0, 0);
    const far0 = crustThicknessKm(0, 180);
    near(near0, 30, 0.5, 'nearside center ~30 km');
    near(far0, 52, 0.5, 'farside center ~52 km');
    assert.ok(far0 > near0, 'farside crust thicker than nearside');
    // Global mean of a degree-1 field = its constant term
    let sum = 0, n = 0;
    for (let lat = -85; lat <= 85; lat += 10) {
        const w = Math.cos(lat * Math.PI / 180);
        for (let lon = -175; lon <= 175; lon += 10) { sum += w * crustThicknessKm(lat, lon); n += w; }
    }
    near(sum / n, 41, 0.5, 'global mean ~41 km (GRAIL-era range)');
    ok('crustal thickness: nearside thin, farside thick, mean in GRAIL band');
}

// ── 6. Tidal clock ───────────────────────────────────────────────────────────
{
    near(anomalisticPhase(REF_PERIGEE_MS), 0, 1e-9, 'phase 0 at reference perigee');
    const oneMonth = ANOMALISTIC_MONTH_DAYS * 86400000;
    near(anomalisticPhase(REF_PERIGEE_MS + oneMonth), 0, 1e-9, 'periodic after one anomalistic month');
    near(anomalisticPhase(REF_PERIGEE_MS + oneMonth / 2), 0.5, 1e-9, 'apogee at phase 0.5');
    near(anomalisticPhase(REF_PERIGEE_MS - oneMonth / 4), 0.75, 1e-9, 'negative time wraps');
    // Rate: perigee peak > apogee peak > quadrature floor
    const rPeri = deepMoonquakeRate(0), rApo = deepMoonquakeRate(0.5), rQuad = deepMoonquakeRate(0.25);
    assert.ok(rPeri > rApo, 'perigee peak dominates apogee');
    assert.ok(rApo > rQuad, 'apogee secondary peak above quiet floor');
    assert.ok(rQuad >= 1 && rQuad < 1.3, 'quadrature near the floor');
    near(deepMoonquakeRate(1.25), rQuad, 1e-12, 'rate periodic in phase');
    ok('anomalistic clock periodic; perigee-dominant bimodal trigger');
}

// ── 7. Moonquake catalogues ──────────────────────────────────────────────────
{
    const a1 = DEEP_NESTS.find(n => n.id === 'A1');
    assert.ok(a1 && a1.real, 'A1 present and flagged real');
    for (const nest of DEEP_NESTS) {
        assert.ok(nest.depthKm >= 700 && nest.depthKm <= 1200,
            `${nest.id} depth in the 700–1200 km deep-moonquake band`);
        const rKm = R_MOON_KM - nest.depthKm;
        assert.equal(layerAt(rKm).key, 'mantle', `${nest.id} sits in the mantle`);
    }
    assert.equal(SHALLOW_QUAKE_FACTS.recorded, 28);
    assert.ok(SHALLOW_QUAKE_FACTS.largestMagnitude >= 5, 'shallow quakes reach magnitude 5+');
    ok('deep nests in-band and in-mantle; shallow-quake facts pinned');
}

// ── 8. The dead dynamo ───────────────────────────────────────────────────────
{
    assert.equal(dynamoSurfaceFieldMicroT(0), 0, 'today: no global field');
    assert.equal(dynamoSurfaceFieldMicroT(0.5), 0, '0.5 Ga: dead');
    assert.ok(dynamoSurfaceFieldMicroT(4.0) >= 20, 'high-field epoch is Earth-like (≥20 µT)');
    near(dynamoSurfaceFieldMicroT(4.0), 50, 1, 'plateau central estimate 50 µT');
    // Decline is monotone from the plateau to death
    for (let a = 3.56; a > 0.85; a -= 0.1) {
        assert.ok(dynamoSurfaceFieldMicroT(a) >= dynamoSurfaceFieldMicroT(a - 0.1) - 1e-9,
            `field non-increasing toward present at ${a.toFixed(2)} Ga`);
    }
    // Continuity at the epoch seams
    near(dynamoSurfaceFieldMicroT(1.9), 3, 0.01, '3 µT at 1.9 Ga from both branches');
    near(dynamoSurfaceFieldMicroT(3.56), 50, 0.01, '50 µT at 3.56 Ga from both branches');
    // Epoch table covers 4.42 Ga → today with no gaps
    for (let i = 1; i < DYNAMO_EPOCHS.length; i++) {
        assert.equal(DYNAMO_EPOCHS[i].fromGa, DYNAMO_EPOCHS[i - 1].toGa, 'epoch table contiguous');
    }
    assert.equal(DYNAMO_EPOCHS[DYNAMO_EPOCHS.length - 1].toGa, 0, 'epochs reach the present');
    assert.ok(CRUSTAL_ANOMALIES.some(a => a.name === 'Reiner Gamma'), 'Reiner Gamma present');
    ok('dynamo: Earth-like at 4 Ga, monotone decline, exactly zero today');
}

console.log(`\nmoon-interior-model: ${passed} groups passed`);
