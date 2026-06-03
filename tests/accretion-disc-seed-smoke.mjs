#!/usr/bin/env node
/**
 * accretion-disc-seed-smoke.mjs
 *
 * Pure-Node smoke test for the seeded RNG that makes accretion-disc runs
 * reproducible (Phase 0.1 of ACCRETION_DISC_WORKSHOP_PLAN.md).
 *
 * We can't boot accretion-disc.html here (it imports three from a CDN), but the
 * stochastic surface lives in two dependency-light modules we CAN import:
 *   - js/accretion-disc/rng.js        (makeRng / normalizeSeed / randomSeed)
 *   - js/accretion-disc/scenarios.js  (buildInitialBodies, only imports physics.js)
 *
 * Coverage
 *   1. makeRng is deterministic: same seed ⇒ identical stream; different seeds
 *      ⇒ different streams; output stays in [0, 1).
 *   2. normalizeSeed: numbers truncate to uint32, decimal strings parse, and
 *      memorable names hash stably to a uint32.
 *   3. buildInitialBodies(scenario, rng) is reproducible: the same seed yields
 *      byte-identical body state (positions, velocities, inclinations), and a
 *      different seed perturbs it — proving no hidden Math.random() remains.
 *   4. The Theia/proto-Earth co-planar coupling invariant survives seeding
 *      (Theia inherits Earth's inclination + node so the giant impact happens).
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import { makeRng, normalizeSeed, randomSeed } from '../js/accretion-disc/rng.js';
import { SOLAR_SYSTEM, buildInitialBodies } from '../js/accretion-disc/scenarios.js';

let passed = 0;
function ok(label) { console.log('  ✓ ' + label); passed++; }

// ── 1. makeRng determinism ──────────────────────────────────────────────────
{
    const a = makeRng(12345);
    const b = makeRng(12345);
    const seqA = Array.from({ length: 32 }, () => a());
    const seqB = Array.from({ length: 32 }, () => b());
    assert.deepEqual(seqA, seqB, 'same seed must reproduce the same stream');
    for (const v of seqA) assert.ok(v >= 0 && v < 1, 'rng output in [0,1)');

    const c = makeRng(12346);
    const seqC = Array.from({ length: 32 }, () => c());
    assert.notDeepEqual(seqA, seqC, 'different seeds must differ');
    ok('makeRng is deterministic per-seed, divergent across seeds, in range');
}

// ── 2. normalizeSeed ─────────────────────────────────────────────────────────
{
    assert.equal(normalizeSeed(42), 42, 'integer passes through');
    assert.equal(normalizeSeed('42'), 42, 'decimal string parses to number');
    const h1 = normalizeSeed('theia');
    const h2 = normalizeSeed('theia');
    assert.equal(h1, h2, 'string hash is stable');
    assert.ok(Number.isInteger(h1) && h1 >= 0 && h1 <= 0xffffffff, 'string hash is uint32');
    assert.notEqual(normalizeSeed('theia'), normalizeSeed('gaia'), 'distinct names differ');
    // randomSeed produces a valid uint32.
    const r = randomSeed();
    assert.ok(Number.isInteger(r) && r >= 0 && r <= 0xffffffff, 'randomSeed is uint32');
    ok('normalizeSeed handles numbers, decimal strings, and names');
}

// ── helper: snapshot the kinematic state buildInitialBodies cares about ───────
function snapshot(bodies) {
    return bodies.map(b => [b.name, b.x, b.y, b.z, b.vx, b.vy, b.vz, b.m]);
}

// ── 3. buildInitialBodies reproducibility ─────────────────────────────────────
{
    const s1 = snapshot(buildInitialBodies(SOLAR_SYSTEM, makeRng(777)));
    const s2 = snapshot(buildInitialBodies(SOLAR_SYSTEM, makeRng(777)));
    assert.deepEqual(s1, s2, 'same seed ⇒ identical initial bodies');

    const s3 = snapshot(buildInitialBodies(SOLAR_SYSTEM, makeRng(778)));
    assert.notDeepEqual(s1, s3, 'different seed ⇒ different bodies (no stray Math.random)');

    // Body count + names are seed-independent (only the random phases/tilts move).
    assert.deepEqual(s1.map(r => r[0]), s3.map(r => r[0]), 'body set is seed-independent');
    ok('buildInitialBodies reproduces an identical world for a fixed seed');
}

// ── 4. Theia / proto-Earth co-planar coupling invariant ──────────────────────
{
    const bodies = buildInitialBodies(SOLAR_SYSTEM, makeRng(2024));
    const earth = bodies.find(b => b.flagEarth);
    const theia = bodies.find(b => b.flagTheia);
    assert.ok(earth && theia, 'scenario contains proto-Earth and Theia');
    // They share an orbital plane: the unit angular-momentum vectors must align.
    const Lh = (b) => {
        const Lx = b.y * b.vz - b.z * b.vy;
        const Ly = b.z * b.vx - b.x * b.vz;
        const Lz = b.x * b.vy - b.y * b.vx;
        const m = Math.hypot(Lx, Ly, Lz);
        return [Lx / m, Ly / m, Lz / m];
    };
    const [ex, ey, ez] = Lh(earth);
    const [tx, ty, tz] = Lh(theia);
    const dot = ex * tx + ey * ty + ez * tz;
    assert.ok(dot > 0.9999, `Theia must share Earth's plane (cos=${dot.toFixed(6)})`);
    ok('Theia inherits proto-Earth orbital plane after seeding (giant-impact invariant)');
}

console.log(`\naccretion-disc seed smoke: ${passed}/4 checks passed`);
