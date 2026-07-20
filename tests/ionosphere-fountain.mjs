#!/usr/bin/env node
/**
 * ionosphere-fountain.mjs — pure-Node validation of the equatorial fountain &
 * plasma-bubble kernel (js/ionosphere-fountain.js, Track A of
 * IONOSPHERE_EXPLORATION_PLAN.md).
 *
 * Pins:
 *   1. Climatology: PRE peak inside 18–19.5 LT at 40–60 m/s; daytime upward
 *      20–40 m/s; night downward. Dip equator snakes ±9–10°, south over the
 *      Americas, north over SE Asia.
 *   2. Crests: a quiet diurnal run builds Appleton crests at ±10–18° maglat,
 *      brighter in the evening than at dawn.
 *   3. Penetration coupling: an eastward ΔA step (undershielding) during the
 *      trigger window spawns MORE bubbles than quiet; a westward step
 *      (overshielding) spawns FEWER — the M-I coupling storyline.
 *   4. Disturbance dynamo: sustained high Kp winds `dynamo` up on the ~4 h
 *      lag and pulls the dusk drift DOWN (the delayed suppression phase).
 *   5. Determinism: identical inputs ⇒ identical bubble id sets; different
 *      sim-dates reseed. Bubbles rise toward the apex cap, drift EAST, and
 *      die within TTL. hF stays bounded over 48 h.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import {
    N_CELLS, climatologyDrift, climatologyHF, penetrationGate, rtGrowthRate,
    verticalDrift, dipEquatorLat, IonosphereFountain, K_PEN, AIRGLOW_ALT_KM,
    gravityWaveSeed, gravityWaveModes, GW_LAMBDA_MIN_KM, GW_LAMBDA_MAX_KM,
    KM_PER_DEG,
} from '../js/ionosphere-fountain.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const DAY = 86400000;
// Fixed sim epoch — kernels take time as input (no ambient Date.now()).
const T0 = Date.UTC(2026, 6, 15);

/** Step a model with the house cadence (30 s substeps via tick). */
function run(model, fromMs, hours, dtS, drivers = {}) {
    const steps = Math.round(hours * 3600 / dtS);
    for (let s = 1; s <= steps; s++) {
        model.tick(fromMs + s * dtS * 1000, dtS, drivers);
    }
    return fromMs + steps * dtS * 1000;
}

// ── 1. Climatology shapes ────────────────────────────────────────────────────
{
    let vMax = -1e9, ltMax = 0;
    for (let lt = 0; lt < 24; lt += 0.01) {
        const v = climatologyDrift(lt);
        if (v > vMax) { vMax = v; ltMax = lt; }
    }
    assert.ok(ltMax > 18 && ltMax < 19.5, `PRE peak at ${ltMax} LT`);
    assert.ok(vMax > 40 && vMax < 60, `PRE magnitude ${vMax} m/s`);
    assert.ok(climatologyDrift(11) > 15 && climatologyDrift(11) < 40, 'daytime upward 20–40');
    assert.ok(climatologyDrift(2) < -10, 'night downward');
    assert.ok(climatologyHF(19.3) > climatologyHF(12), 'post-sunset hF loft');

    // Penetration gate polarity: eastward day/dusk, westward post-midnight.
    assert.ok(penetrationGate(16) > 0.9 && penetrationGate(19) > 0.5, 'gate + at dusk');
    assert.ok(penetrationGate(4) < -0.9, 'gate − post-midnight');

    // Dip equator snakes: south over the Americas (−73°W), north at +107°E.
    const south = dipEquatorLat(-72.68 * Math.PI / 180) * 180 / Math.PI;
    const north = dipEquatorLat(107.32 * Math.PI / 180) * 180 / Math.PI;
    assert.ok(south < -8 && south > -11, `dip equator ${south}° over Americas`);
    assert.ok(north > 8 && north < 11, `dip equator ${north}° over SE Asia`);

    // R-T growth: lofted bottomside grows much faster; low bottomside stable.
    assert.ok(rtGrowthRate(350) > 3 * rtGrowthRate(300), 'loft accelerates R-T');
    assert.ok(rtGrowthRate(240) < 0, 'low bottomside is R-T stable');
    ok('climatology: PRE 18–19.5 LT at 40–60 m/s, gate polarity, snaking dip equator, R-T(hF)');
}

// ── 2. Appleton crests from a quiet diurnal run ──────────────────────────────
{
    const m = new IonosphereFountain({ kp: 2 });
    run(m, T0, 36, 60);          // spin up 1.5 days, quiet
    // Evening sector cells (LT 19–21) vs pre-dawn cells (LT 4–6).
    const utH = ((T0 + 36 * 3.6e6) / 3.6e6) % 24;
    const byLT = (lo, hi) => m.cells.filter(c => {
        const lt = (utH + c.lonDeg / 15 + 24) % 24;
        return lt >= lo && lt < hi;
    });
    const mean = (cs) => cs.reduce((s, c) => s + c.crest, 0) / cs.length;
    const evening = mean(byLT(19, 21));
    const preDawn = mean(byLT(4, 6));
    assert.ok(evening > 0.25, `evening crest intensity ${evening}`);
    assert.ok(evening > 1.5 * preDawn, `evening ${evening} > pre-dawn ${preDawn}`);
    // Crest latitude in the Appleton band for every cell.
    for (const c of m.cells) {
        const lat = m.crestLatDeg(c);
        assert.ok(lat >= 10 && lat <= 18, `crest lat ${lat}`);
    }
    ok('crests: build by day, decay overnight, ±10–18° maglat band');
}

// ── 3. Penetration coupling: ΔA steps modulate bubble counts ─────────────────
{
    const evening = (dA) => {
        // ΔA held across the whole UT day so every cell's local evening sees
        // the same shielding state (a step at one UT instant would leave the
        // cells whose PRE already passed un-driven — banked lofts are real
        // physics but they blur the contrast this fixture measures).
        const m = new IonosphereFountain({ kp: 3 });
        let t = run(m, T0, 17, 60, { dA });            // UT 00 → 17
        run(m, t, 7, 30, { dA });                      // UT 17 → 24
        let n = 0;
        for (const c of m.cells) n += c.spawnCount;
        return n;
    };
    const quiet = evening(0);
    const east = evening(+0.6);      // undershielding — super-fountain
    const west = evening(-0.6);      // overshielding — suppression
    // The CONTRAST is the deliverable: quiet nights bubble in a few sectors
    // only, undershielding erupts the dusk swath, overshielding kills it.
    assert.ok(quiet >= 2 && quiet <= 40, `quiet evening a few sectors (${quiet})`);
    assert.ok(east > 2 * quiet && east >= 30,
        `eastward ΔA erupts the swath: ${east} vs quiet ${quiet}`);
    assert.ok(west <= Math.max(1, quiet / 2),
        `westward ΔA suppresses: ${west} vs quiet ${quiet}`);

    // The drift itself moves with ΔA at dusk by ~K_PEN·g scale.
    const dv = verticalDrift(19, 0.6, 0) - verticalDrift(19, 0, 0);
    assert.ok(dv > 0.3 * K_PEN * 0.6 && dv <= K_PEN * 0.6, `dusk Δv ${dv} m/s`);
    ok(`penetration: east ΔA ⇒ ${east} bubbles > quiet ${quiet} > west ${west}`);
}

// ── 4. Disturbance dynamo: lagged suppression ────────────────────────────────
{
    const m = new IonosphereFountain({ kp: 8 });
    assert.equal(m.dynamo, 0, 'dynamo starts unwound');
    run(m, T0, 1, 60);
    const early = m.dynamo;
    run(m, T0 + 3.6e6, 8, 60);
    const late = m.dynamo;
    assert.ok(early < 0.25 * (8 - 2), `1 h in, dynamo still winding (${early})`);
    assert.ok(late > 0.8 * (8 - 2), `9 h in, dynamo wound up (${late})`);
    // Wound-up dynamo pulls the dusk drift down vs storm onset.
    assert.ok(verticalDrift(19, 0, late) < verticalDrift(19, 0, early) - 10,
        'dynamo suppresses the dusk fountain hours after onset');
    ok('disturbance dynamo: ~4 h wind-up, then dusk suppression (two-phase storm)');
}

// ── 5. Determinism, bubble kinematics, boundedness ───────────────────────────
{
    const spawnAll = () => {
        const m = new IonosphereFountain({ kp: 3 });
        let t = run(m, T0, 17, 60);
        run(m, t, 7, 30, { dA: 0.6 });
        return m;
    };
    const a = spawnAll(), b = spawnAll();
    const ids = (m) => m.cells.flatMap(c => c.bubbles.map(x => x.id)).sort().join(',');
    assert.equal(ids(a), ids(b), 'identical inputs ⇒ identical bubble sets');
    assert.ok(ids(a).length > 0, 'bubble set non-empty');

    // A different sim-date reseeds the evening.
    const c2 = (() => {
        const m = new IonosphereFountain({ kp: 3 });
        let t = run(m, T0 + 3 * DAY, 17, 60);
        run(m, t, 7, 30, { dA: 0.6 });
        return m;
    })();
    assert.notEqual(ids(a), ids(c2), 'different sim-date ⇒ different seeds');

    // Kinematics: bubbles drift EAST of their birth cell and rise; the
    // flat list exposes shell-crossing extents inside the wedge range.
    for (const bub of a.allBubbles()) {
        const cell = a.cells[bub.cell];
        assert.ok(bub.lonDeg > cell.lonDeg - 2.5 - 1e-9, 'never west of birth jitter');
        assert.ok(bub.apexKm > AIRGLOW_ALT_KM, 'risen above the shell');
        assert.ok(bub.latExtentDeg > 0 && bub.latExtentDeg < 22, 'wedge extent 0–22°');
        assert.ok(bub.ageS <= bub.ttlS, 'alive ⇒ within TTL');
    }
    // Bubbles die: two more quiet days sweep every TTL past its end.
    const aliveT = a.cells.reduce((s, c) => s + c.bubbles.length, 0);
    assert.ok(aliveT > 0, 'bubbles alive at evening end');
    run(a, T0 + DAY, 26, 300);
    // (spot-check boundedness on the same long run)
    for (const c of a.cells) {
        assert.ok(c.hF >= 200 && c.hF <= 600, `hF bounded (${c.hF})`);
    }
    ok('determinism per (cell, sim-date); eastward drift; rise; TTL; hF bounded');
}

// ── 6. Gravity-wave spectral seeding (2026-07-20 decision, Q3) ───────────────
{
    const dayN = 20649;   // any fixed sim-day
    const modes = gravityWaveModes(dayN);
    assert.equal(modes.length, 6, 'six modes');
    for (const m of modes) {
        assert.ok(m.lambdaKm >= GW_LAMBDA_MIN_KM && m.lambdaKm <= GW_LAMBDA_MAX_KM,
            `mode wavelength ${m.lambdaKm} in band`);
    }
    // Determinism per day; different days re-draw the spectrum.
    assert.equal(gravityWaveSeed(37.3, dayN), gravityWaveSeed(37.3, dayN), 'seed deterministic');
    assert.notEqual(gravityWaveSeed(37.3, dayN), gravityWaveSeed(37.3, dayN + 1),
        'different day, different field');

    // Crest-to-crest spacing of the field itself sits in the observed band.
    const spacings = [];
    let lastCrest = null;
    for (let lon = -60; lon <= 60; lon += 0.05) {
        const a = gravityWaveSeed(lon - 0.05, dayN, modes);
        const b = gravityWaveSeed(lon, dayN, modes);
        const c = gravityWaveSeed(lon + 0.05, dayN, modes);
        if (b > a && b >= c) {
            if (lastCrest !== null) spacings.push((lon - lastCrest) * KM_PER_DEG);
            lastCrest = lon;
        }
    }
    spacings.sort((x, y) => x - y);
    const median = spacings[Math.floor(spacings.length / 2)];
    assert.ok(median >= GW_LAMBDA_MIN_KM * 0.6 && median <= GW_LAMBDA_MAX_KM * 1.2,
        `median crest spacing ${median.toFixed(0)} km in/near the 100–400 band`);

    // Bubbles land on crests, and in-cell pairs carry the wave spacing.
    // Accumulate BIRTH positions during the run (bubbles die on 1–2 h TTLs
    // and drift east afterward — an end-of-run census sees neither the full
    // population nor the spawn longitudes).
    const m2 = new IonosphereFountain({ kp: 3 });
    for (let s = 1; s <= 17 * 60; s++) m2.tick(T0 + s * 60000, 60, { dA: 0.6 });
    const t2 = T0 + 17 * 3600e3;
    const births = new Map();   // id → { lonDeg at first sight, cell, gwDay }
    for (let s = 1; s <= 7 * 120; s++) {
        m2.tick(t2 + s * 30000, 30, { dA: 0.6 });
        if (s % 2 === 0) {      // every sim-min: drift since birth ≤ ~7 km
            for (const b of m2.allBubbles()) {
                // Record the GW day IN EFFECT at birth — the run crosses UT
                // midnight, where the spectrum redraws; checking a bubble
                // against the wrong day's field is meaningless.
                if (!births.has(b.id)) {
                    births.set(b.id, { lonDeg: b.lonDeg, cell: b.cell, gwDay: m2._gwDay });
                }
            }
        }
    }
    assert.ok(births.size >= 30, `driven evening bubbles (${births.size})`);
    let onCrest = 0;
    for (const b of births.values()) if (gravityWaveSeed(b.lonDeg, b.gwDay) > 0) onCrest++;
    assert.ok(onCrest / births.size > 0.8,
        `${onCrest}/${births.size} bubbles born on positive seed (crest side)`);
    const byCell = new Map();
    for (const b of births.values()) {
        if (!byCell.has(b.cell)) byCell.set(b.cell, []);
        byCell.get(b.cell).push(b.lonDeg);
    }
    const inCell = [];
    for (const lons of byCell.values()) {
        if (lons.length < 2) continue;
        lons.sort((x, y) => x - y);
        for (let i = 1; i < lons.length; i++) {
            inCell.push((lons[i] - lons[i - 1]) * KM_PER_DEG);
        }
    }
    assert.ok(inCell.length >= 5, `multi-bubble cells present (${inCell.length} pairs)`);
    inCell.sort((x, y) => x - y);
    const medCell = inCell[Math.floor(inCell.length / 2)];
    assert.ok(medCell >= 60 && medCell <= 450,
        `median in-cell bubble spacing ${medCell.toFixed(0)} km ≈ observed 100–400`);
    ok(`gravity-wave seeding: spectrum in band, bubbles on crests, in-cell spacing ${medCell.toFixed(0)} km`);
}

console.log(`\nionosphere-fountain: ${passed}/6 groups passed`);
