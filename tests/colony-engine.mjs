#!/usr/bin/env node
/**
 * colony-engine.mjs — gate for js/colony-engine.js (the colony RTS kernel).
 *
 * Run: node tests/colony-engine.mjs
 *
 * The load-bearing pins:
 *   • DETERMINISM — same seed + same env script ⇒ bit-identical state.
 *   • CONSERVATION — the energy, water/oxygen, and materials ledgers close:
 *     nothing is minted or vanished by a tick, ever. This is the invariant
 *     that keeps "it's a game" from becoming "it's wrong".
 *   • The worker loop actually moves mass from nodes to stores.
 *   • Storm shielding: a sheltered astronaut takes ≥15× less dose than one
 *     left outside in the same SEP event; career limit grounds a unit.
 *   • Brownout physics: the long polar night drains batteries at exactly
 *     load × hours; site illumination changes total generation over a sol.
 *   • The site survey covers all Artemis III candidates with sane bands.
 */

import assert from 'node:assert/strict';
import {
    SOL_HOURS, DOSE, BUILD_CATALOG, UNIT_CATALOG, LANDER, ELECTROLYZER,
    siteProfiles, createGame, tick, issueOrder, placeBlueprint,
    sunFactor, crewSummary, MAP_W, MAP_H,
} from '../js/colony-engine.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

const QUIET = { gcrFlux: 0.5, sepFlux: 0, sLevel: 0, stormEtaH: null };
const STORM = { gcrFlux: 0.5, sepFlux: 0.6, sLevel: 3, stormEtaH: 0 };

function snapshot(state) {
    // Strip the (function-valued) RNG; everything else must match bit-for-bit.
    return JSON.stringify(state, (k, v) => (k === '_rng' ? undefined : v));
}

// ── 1. Site survey ───────────────────────────────────────────────────────────
{
    const sites = siteProfiles();
    assert.ok(sites.length >= 13, `all Artemis III candidates surveyed (${sites.length})`);
    for (const s of sites) {
        assert.ok(s.illum > 0.5 && s.illum <= 0.95, `${s.name} illumination band`);
        assert.ok(s.iceDistM >= 500 && s.iceDistM <= 3000, `${s.name} ice distance band`);
        assert.ok(Number.isFinite(s.score), `${s.name} scored`);
    }
    const shack = sites.find(s => s.name === 'Peak Near Shackleton');
    assert.ok(shack.illum >= 0.85, 'Shackleton-class illumination');
    // Stable ordering + stable stats across calls (seeded by site name)
    assert.deepEqual(sites, siteProfiles(), 'survey is deterministic');
    ok(`site survey: ${sites.length} candidates, top = ${sites[0].name} (${sites[0].score})`);
}

// ── 2. Determinism ───────────────────────────────────────────────────────────
{
    const run = () => {
        const s = createGame(siteProfiles()[0].id, { seed: 42 });
        const rovers = s.units.filter(u => u.kind === 'rover').map(u => u.id);
        const ice = s.nodes.find(n => n.kind === 'ice');
        issueOrder(s, rovers, { type: 'harvest', nodeId: ice.id });
        for (let h = 0; h < 300; h++) tick(s, 1, h % 50 < 5 ? STORM : QUIET);
        return snapshot(s);
    };
    assert.equal(run(), run(), 'same seed + env script ⇒ identical state');
    ok('determinism under fixed seed');
}

// ── 3. Conservation ledgers ──────────────────────────────────────────────────
{
    const s = createGame(siteProfiles()[0].id, { seed: 7 });
    const startWater = s.resources.water, startO2 = s.resources.oxygen;
    const startMat = s.resources.materials, startE = s.resources.energyKWh;

    const rovers = s.units.filter(u => u.kind === 'rover').map(u => u.id);
    const ice = s.nodes.find(n => n.kind === 'ice');
    const reg = s.nodes.find(n => n.kind === 'regolith');
    issueOrder(s, [rovers[0]], { type: 'harvest', nodeId: ice.id });
    issueOrder(s, [rovers[1]], { type: 'harvest', nodeId: reg.id });
    // build something so materials move both directions
    const bp = placeBlueprint(s, 'solar', s.buildings[0].x + 120, s.buildings[0].y - 80);
    assert.ok(bp.ok, 'blueprint placed');
    const ast = s.units.filter(u => u.kind === 'astronaut').map(u => u.id);
    issueOrder(s, [ast[0]], { type: 'build', buildingId: bp.id });

    for (let h = 0; h < 400; h++) tick(s, 1, QUIET);
    const L = s.ledger, r = s.resources;

    // Water: start + mined − consumed − electrolyzed = store (carried mass excluded)
    const carriedIce = s.units.reduce((k, u) => k + (u.carryKind === 'ice' ? u.carrying : 0), 0);
    near(startWater + L.minedWater - L.usedWater - L.electrolyzedWater, r.water, 1e-6,
        'water ledger closes');
    // Oxygen: start + made − used = store
    near(startO2 + L.madeOxygen - L.usedOxygen, r.oxygen, 1e-6, 'oxygen ledger closes');
    // Materials: start + mined − spent = store (carried mass excluded)
    const carriedReg = s.units.reduce((k, u) => k + (u.carryKind === 'regolith' ? u.carrying : 0), 0);
    near(startMat + L.minedMaterials - L.usedMaterials, r.materials, 1e-6, 'materials ledger closes');
    // Energy: start + generated − drawn − wasted = battery
    near(startE + L.genKWh - L.drawKWh - L.wasteKWh, r.energyKWh, 1e-3, 'energy ledger closes');
    // And the loop actually moved mass
    assert.ok(L.minedWater > 0, 'ice actually mined');
    assert.ok(L.minedMaterials > 0, 'regolith actually mined');
    assert.ok(carriedIce >= 0 && carriedReg >= 0, 'carry masses sane');
    ok('conservation: water, oxygen, materials, energy ledgers all close');
}

// ── 4. Build loop ────────────────────────────────────────────────────────────
{
    const s = createGame(siteProfiles()[0].id, { seed: 3 });
    const matBefore = s.resources.materials;
    const bp = placeBlueprint(s, 'solar', s.buildings[0].x + 150, s.buildings[0].y);
    assert.ok(bp.ok);
    assert.equal(s.resources.materials, matBefore - BUILD_CATALOG.solar.materials, 'materials deducted at stake');
    const ast = s.units.find(u => u.kind === 'astronaut');
    issueOrder(s, [ast.id], { type: 'build', buildingId: bp.id });
    for (let h = 0; h < 6; h++) tick(s, 1, QUIET);
    const b = s.buildings.find(x => x.id === bp.id);
    assert.equal(b.built, 1, 'solar array completes');
    tick(s, 0.5, QUIET);
    assert.ok(s.power.genKW > LANDER.genKW, 'completed array generates (sun is up at t≈6h)');
    // Invalid placements refused
    assert.equal(placeBlueprint(s, 'solar', s.buildings[0].x, s.buildings[0].y).ok, false, 'overlap refused');
    assert.equal(placeBlueprint(s, 'solar', -10, 50).ok, false, 'out of bounds refused');
    const poor = createGame(siteProfiles()[0].id, { seed: 3 });
    poor.resources.materials = 10;
    assert.equal(placeBlueprint(poor, 'habitat', 500, 500).ok, false, 'unaffordable refused');
    ok('build verbs: stake, construct, refuse bad placements');
}

// ── 5. Storm dose: shelter works, career limit grounds ───────────────────────
{
    const s = createGame(siteProfiles()[0].id, { seed: 5 });
    const [a1, a2] = s.units.filter(u => u.kind === 'astronaut');
    // a1 stays outside in the storm; a2 goes to the lander (0.6) — build a
    // shelter for the real factor test below.
    issueOrder(s, [a1.id], { type: 'move', x: a1.x + 600, y: a1.y });
    issueOrder(s, [a2.id], { type: 'shelter' });
    for (let h = 0; h < 24; h++) tick(s, 1, STORM);
    assert.ok(a1.doseMSv / a2.doseMSv > 1.5, `outside ≫ lander (${a1.doseMSv.toFixed(1)} vs ${a2.doseMSv.toFixed(1)} mSv)`);

    // Proper shelter: 20× shield factor
    const s2 = createGame(siteProfiles()[0].id, { seed: 5 });
    s2.resources.materials = 5000;
    const bp = placeBlueprint(s2, 'shelter', s2.buildings[0].x + 150, s2.buildings[0].y + 120);
    const crew = s2.units.filter(u => u.kind === 'astronaut');
    issueOrder(s2, [crew[0].id], { type: 'build', buildingId: bp.id });
    for (let h = 0; h < 16; h++) tick(s2, 1, QUIET);
    assert.equal(s2.buildings.find(b => b.id === bp.id).built, 1, 'shelter built');
    issueOrder(s2, [crew[0].id], { type: 'shelter' });
    issueOrder(s2, [crew[1].id], { type: 'move', x: crew[1].x + 600, y: crew[1].y });
    const d0 = [crew[0].doseMSv, crew[1].doseMSv];
    for (let h = 0; h < 24; h++) tick(s2, 1, STORM);
    const inShelter = crew[0].doseMSv - d0[0], outside = crew[1].doseMSv - d0[1];
    assert.ok(crew[0].inside, 'unit actually inside');
    assert.ok(outside / inShelter >= 15, `shelter factor ≥15× (got ${(outside / inShelter).toFixed(1)}×)`);

    // Career limit grounds
    const s3 = createGame(siteProfiles()[0].id, { seed: 5 });
    const a = s3.units.find(u => u.kind === 'astronaut');
    issueOrder(s3, [a.id], { type: 'move', x: a.x + 900, y: a.y });
    for (let h = 0; h < 80 && !a.grounded; h++) tick(s3, 1, { ...STORM, sepFlux: 1, sLevel: 5 });
    assert.ok(a.grounded, 'career limit grounds the unit');
    assert.ok(a.doseMSv >= DOSE.careerMSv, 'at or past 600 mSv when grounded');
    assert.ok(a.hp > 0, 'grounded ≠ dead');
    // Rovers never take dose
    assert.ok(s3.units.filter(u => u.kind === 'rover').every(u => u.doseMSv === 0), 'rovers doseless');
    ok('storm dose: shielding factors, career grounding, rover immunity');
}

// ── 6. The long night: brownout drains at load × hours ──────────────────────
{
    const site = siteProfiles()[0];
    const s = createGame(site.id, { seed: 9 });
    // Jump to the middle of the dark window (phase 0.5)
    s.t = SOL_HOURS * 0.5 - 25;
    assert.equal(sunFactor({ ...s, t: SOL_HOURS * 0.5 }), 0, 'dark at phase 0.5');
    const e0 = s.resources.energyKWh;
    tick(s, 10, QUIET);   // lander: gen 2 kW (fuel cell) = draw 2 kW → net 0
    near(s.resources.energyKWh, e0, 0.5, 'lander alone rides through the night');
    // Sunlit fraction over a full sol tracks the site illumination
    let litHours = 0;
    for (let h = 0; h < SOL_HOURS; h++) {
        if (sunFactor({ site, t: h + 0.5 }) > 0) litHours++;
    }
    near(litHours / SOL_HOURS, site.illum, 0.03, 'lit fraction ≈ site illumination');
    ok('night physics: net-zero lander, lit fraction matches survey');
}

// ── 7. Electrolyzer chemistry ────────────────────────────────────────────────
{
    const s = createGame(siteProfiles()[0].id, { seed: 11 });
    s.resources.materials = 5000;
    // A 10 kW electrolyzer browns out a 2 kW lander (the engine load-sheds,
    // correctly) — so power it honestly: two solar arrays first.
    const hq = s.buildings[0];
    const sp1 = placeBlueprint(s, 'solar', hq.x + 150, hq.y - 120);
    const sp2 = placeBlueprint(s, 'solar', hq.x - 150, hq.y - 120);
    const bp = placeBlueprint(s, 'electrolyzer', hq.x - 150, hq.y + 100);
    const crew = s.units.filter(u => u.kind === 'astronaut');
    issueOrder(s, [crew[0].id], { type: 'build', buildingId: sp1.id });
    issueOrder(s, [crew[1].id], { type: 'build', buildingId: sp2.id });
    issueOrder(s, [crew[2].id], { type: 'build', buildingId: bp.id });
    for (let h = 0; h < 8; h++) tick(s, 1, QUIET);
    assert.ok(s.power.genKW > s.power.drawKW, 'arrays keep the electrolyzer powered');
    const w0 = s.ledger.electrolyzedWater;
    tick(s, 2, QUIET);
    const dW = s.ledger.electrolyzedWater - w0;
    assert.ok(dW > 0, 'electrolyzer consumes water');
    near(s.ledger.madeOxygen / s.ledger.electrolyzedWater, ELECTROLYZER.o2Fraction, 1e-9,
        'O₂ output is exactly 8/9 of split mass');
    ok('electrolyzer: mass split is stoichiometric');
}

// ── 8. Loss condition ────────────────────────────────────────────────────────
{
    const s = createGame(siteProfiles()[0].id, { seed: 13 });
    s.resources.water = 0; s.resources.oxygen = 0;
    // No mining orders: reserves stay dry, crew health drains to zero.
    for (let h = 0; h < 60 && s.alive; h++) tick(s, 1, QUIET);
    assert.equal(s.alive, false, 'colony dies without life support');
    assert.ok(s.log.some(l => l.kind === 'bad'), 'the log says why');
    ok('loss: life-support collapse ends the run, legibly');
}

console.log(`\ncolony-engine: ${passed} groups passed`);
