#!/usr/bin/env node
/**
 * ring-current-particles.mjs — pure-Node tests for the GPU population
 * attribute builder (js/ring-current-particles.js), the module shared by the
 * worker (normal path) and the globe (fallback):
 *
 *   1. Buffer shapes: seed/kin are count×3 Float32Arrays.
 *   2. Physical ranges: L ∈ [1.9, 6.5]; θ₀ ∈ [0, 2π); mirror latitude below
 *      the field-line footpoint (r = 1) for every particle.
 *   3. Scene drift sign: ions and O⁺ positive (westward = θ increasing in
 *      the GSM-mapped frame), electrons negative.
 *   4. Species bounce physics survives packing: mean O⁺ bounce rate ≈ 1/4 of
 *      H⁺ (T_b ∝ √m); electrons orders of magnitude faster.
 *   5. Deterministic under an injected rng.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import { buildPopulation, POPULATIONS } from '../js/ring-current-particles.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

/** mulberry32 — tiny deterministic rng for reproducible assertions. */
function rng32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const mean = arr => arr.reduce((s, x) => s + x, 0) / arr.length;
const kinCol = (pop, c) => Array.from({ length: pop.count }, (_, i) => pop.kin[i * 3 + c]);

// ── 1–2. shapes & physical ranges ────────────────────────────────────────────
{
    const p = buildPopulation(500, 'ion', rng32(7));
    assert.equal(p.count, 500);
    assert.equal(p.seed.length, 1500);
    assert.equal(p.kin.length, 1500);
    assert.ok(p.seed instanceof Float32Array && p.kin instanceof Float32Array);
    for (let i = 0; i < p.count; i++) {
        const L = p.seed[i * 3], th = p.seed[i * 3 + 1], lm = p.seed[i * 3 + 2];
        assert.ok(L >= 1.9 && L <= 6.5, `L = ${L}`);
        assert.ok(th >= 0 && th < 2 * Math.PI);
        // Mirror point must stay on the field line above r = 1:
        // footpoint latitude λ_f = acos(√(1/L)).
        assert.ok(lm >= 0 && lm < Math.acos(Math.sqrt(1 / L)), `λ_m = ${lm} at L = ${L}`);
        assert.ok(p.kin[i * 3 + 1] > 0, 'bounce rate positive');
    }
    ok('shapes + ranges: count×3 buffers, L / θ₀ / λ_m physical, mirrors trapped');
}

// ── 3. scene drift signs ─────────────────────────────────────────────────────
{
    const h = buildPopulation(300, 'ion', rng32(1));
    const o = buildPopulation(300, 'oxygen', rng32(2));
    const e = buildPopulation(300, 'electron', rng32(3));
    assert.ok(kinCol(h, 0).every(v => v > 0), 'H⁺ westward ⇒ scene θ increasing');
    assert.ok(kinCol(o, 0).every(v => v > 0), 'O⁺ westward (drift is mass-independent)');
    assert.ok(kinCol(e, 0).every(v => v < 0), 'electrons eastward ⇒ scene θ decreasing');
    ok('drift signs match the GSM scene convention per species');
}

// ── 4. species bounce physics ────────────────────────────────────────────────
{
    // Same rng seed ⇒ identical (L, E, α) draws ⇒ the rate ratio isolates
    // the mass term: √(m_O/m_H) = √15.88 ≈ 3.985 per particle (O is
    // 15.999 u, not 16 proton masses; plus a ~10⁻⁴ relativistic nudge).
    const h = buildPopulation(400, 'ion', rng32(42));
    const o = buildPopulation(400, 'oxygen', rng32(42));
    for (let i = 0; i < 400; i++) {
        const ratio = h.kin[i * 3 + 1] / o.kin[i * 3 + 1];
        assert.ok(Math.abs(ratio - 3.985) < 0.02, `per-particle H⁺/O⁺ rate ratio = ${ratio}`);
    }
    const e = buildPopulation(400, 'electron', rng32(42));
    assert.ok(mean(kinCol(e, 1)) / mean(kinCol(h, 1)) > 20, 'electrons ≫ faster bounce');
    ok('bounce: O⁺ √(m_O/m_H) ≈ 3.99× slower per particle; electrons ≫ ions');
}

// ── 5. determinism + POPULATIONS spec ────────────────────────────────────────
{
    const a = buildPopulation(64, 'ion', rng32(9));
    const b = buildPopulation(64, 'ion', rng32(9));
    assert.deepEqual(Array.from(a.seed), Array.from(b.seed));
    assert.deepEqual(Array.from(a.kin), Array.from(b.kin));
    const keys = Object.keys(POPULATIONS);
    assert.deepEqual(keys.sort(), ['electrons', 'ionsH', 'ionsO']);
    assert.ok(Object.values(POPULATIONS).every(p => p.count > 0 && p.species));
    ok('deterministic under injected rng; POPULATIONS spec sane');
}

console.log(`\nring-current-particles: all ${n} test groups passed`);
