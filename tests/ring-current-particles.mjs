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
import {
    buildPopulation, POPULATIONS, particlePose, hash1, DEATH_WINDOW,
} from '../js/ring-current-particles.js';
import { chargeExchangeLifetimeHours } from '../js/ring-current-model.js';

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
    assert.equal(p.life.length, 2000);
    assert.equal(p.eKev.length, 500);
    assert.ok(p.seed instanceof Float32Array && p.life instanceof Float32Array);
    for (let i = 0; i < p.count; i++) {
        const L = p.seed[i * 3], th = p.seed[i * 3 + 1], lm = p.seed[i * 3 + 2];
        assert.ok(L >= 1.9 && L <= 6.5, `L = ${L}`);
        // Birth θ confined to the nightside injection sector (π ± π/6).
        assert.ok(Math.abs(th - Math.PI) <= Math.PI / 6 + 1e-6, `θ_birth = ${th}`);
        // Mirror point must stay on the field line above r = 1:
        // footpoint latitude λ_f = acos(√(1/L)).
        assert.ok(lm >= 0 && lm < Math.acos(Math.sqrt(1 / L)), `λ_m = ${lm} at L = ${L}`);
        assert.ok(p.kin[i * 3 + 1] > 0, 'bounce rate positive');
        assert.ok(p.eKev[i] >= 20 && p.eKev[i] <= 250);
        // Lifetime positive; birth offset inside the first life.
        const k = i * 4;
        assert.ok(p.life[k + 1] > 0 && Number.isFinite(p.life[k + 1]));
        assert.ok(p.life[k] >= 0 && p.life[k] < p.life[k + 1]);
        assert.ok([-1, 0, 1].includes(p.life[k + 2]));
    }
    ok('shapes + ranges: seed/kin/life/eKev buffers, nightside births, trapped mirrors');
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
    assert.deepEqual(Array.from(a.life), Array.from(b.life));
    const keys = Object.keys(POPULATIONS);
    assert.deepEqual(keys.sort(), ['electrons', 'ionsH', 'ionsO']);
    assert.ok(Object.values(POPULATIONS).every(p => p.count > 0 && p.species));
    ok('deterministic under injected rng; POPULATIONS spec sane');
}

// ── 6. lifetimes carry the physics ───────────────────────────────────────────
{
    const h = buildPopulation(600, 'ion', rng32(11));
    const o = buildPopulation(600, 'oxygen', rng32(11));   // same (L, E, α) draws
    // Ion lifetimes ARE the charge-exchange formula (spot-check via stored
    // L/eKev — float32 storage tolerance).
    for (const i of [0, 100, 599]) {
        const want = chargeExchangeLifetimeHours(h.eKev[i], h.seed[i * 3], 'ion');
        assert.ok(Math.abs(h.life[i * 4 + 1] - want) / want < 1e-3,
            `life[${i}] = ${h.life[i * 4 + 1]} vs ${want}`);
    }
    // Same draws ⇒ per-particle O⁺/H⁺ lifetime ratio is σ·v physics: O⁺
    // lives SHORTER at ring-current energies (flat σ_O vs collapsed σ_H
    // above ~40 keV; slower for the same E below that).
    let oShorter = 0;
    for (let i = 0; i < 600; i++) if (o.life[i * 4 + 1] < h.life[i * 4 + 1]) oShorter++;
    assert.ok(oShorter / 600 > 0.55, `O⁺ shorter-lived fraction = ${oShorter / 600}`);
    // Loss channels: ions mostly charge-exchange with a deep-mirror
    // precipitating minority; electrons always precipitate.
    const precipFrac = pop => {
        let c = 0;
        for (let i = 0; i < pop.count; i++) if (pop.life[i * 4 + 2] !== 0) c++;
        return c / pop.count;
    };
    const pfH = precipFrac(h);
    assert.ok(pfH > 0.02 && pfH < 0.45, `ion precip fraction = ${pfH}`);
    const e = buildPopulation(300, 'electron', rng32(12));
    assert.equal(precipFrac(e), 1, 'electrons always precipitate');
    for (let i = 0; i < e.count; i++) {
        assert.ok(e.life[i * 4 + 1] >= 24 && e.life[i * 4 + 1] <= 48, 'nominal e⁻ band');
    }
    ok('lifetimes: exact CE formula, O⁺ dies sooner, loss channels sane');
}

// ── 7. particlePose — the GLSL reference implementation ─────────────────────
{
    const p = buildPopulation(400, 'ion', rng32(21));
    // Mid-life: on the field line (r = L·cos²λ), θ = birth + drift·t.
    for (const i of [3, 77, 250]) {
        const lt = p.life[i * 4 + 1];
        // Choose a drift time that puts this particle mid-life (ph ≈ 0.5).
        const tH = (0.5 - p.life[i * 4] / lt) * lt + lt * 4;   // +4 whole cycles
        const q = particlePose(p, i, tH, 12.3);
        assert.ok(Math.abs(q.ph - 0.5) < 1e-3, `ph = ${q.ph}`);
        assert.equal(q.dying, 0);
        const rXZ = Math.hypot(q.x, q.z), r = Math.hypot(rXZ, q.y);
        const L = p.seed[i * 3];
        const lam = Math.atan2(q.y, rXZ);
        assert.ok(Math.abs(r - L * Math.cos(lam) ** 2) < 1e-4, 'on its dipole field line');
        // θ matches birth + rate·(ph·lt) with the cycle-4 jitter applied.
        const jit = hash1(p.life[i * 4 + 3] * 61.7 + 4);
        const want = p.seed[i * 3 + 1] + (jit - 0.5) * 0.7 + p.kin[i * 3] * 0.5 * lt;
        const dTheta = Math.atan2(Math.sin(q.theta - want), Math.cos(q.theta - want));
        assert.ok(Math.abs(dTheta) < 1e-3, `θ drift/jitter mismatch ${dTheta}`);
    }
    // Death windows. Find an ENA ion and a precipitator.
    const iENA = Array.from({ length: 400 }, (_, i) => i).find(i => p.life[i * 4 + 2] === 0);
    const iPre = Array.from({ length: 400 }, (_, i) => i).find(i => p.life[i * 4 + 2] !== 0);
    assert.ok(iENA != null && iPre != null, 'both channels present');
    const atPhase = (i, ph) => {
        const lt = p.life[i * 4 + 1];
        return particlePose(p, i, (ph - p.life[i * 4] / lt) * lt + lt * 2, 5);
    };
    // ENA: escapes OUTWARD (radius grows beyond any field-line point ≤ L).
    const qE = atPhase(iENA, 1 - DEATH_WINDOW / 2);
    assert.ok(qE.dying > 0 && qE.mode === 0);
    const rE = Math.hypot(qE.x, qE.y, qE.z);
    assert.ok(rE > p.seed[iENA * 3], `ENA escaping: r = ${rE} > L`);
    // Precipitator: at death's end it reaches the footpoint — r → 1
    // (Earth's surface), at auroral latitude, hemisphere per its channel.
    const qP = atPhase(iPre, 0.9999);
    const rP = Math.hypot(qP.x, qP.y, qP.z);
    assert.ok(Math.abs(rP - 1) < 0.02, `precipitates to the surface: r = ${rP}`);
    assert.ok(Math.sign(qP.y) === Math.sign(p.life[iPre * 4 + 2]), 'correct hemisphere');
    // Rebirth: just after wrap, θ = θ_birth + new-cycle jitter + drift over
    // 1% of the new life — EXACT prediction (for long-lived particles even
    // 1% of a lifetime is real drift, so no "still near midnight" shortcut).
    const qB = atPhase(iPre, 0.01);
    const ltP = p.life[iPre * 4 + 1];
    const jitB = hash1(p.life[iPre * 4 + 3] * 61.7 + qB.cycle);
    const wantB = p.seed[iPre * 3 + 1] + (jitB - 0.5) * 0.7 + p.kin[iPre * 3] * 0.01 * ltP;
    const dB = Math.atan2(Math.sin(qB.theta - wantB), Math.cos(qB.theta - wantB));
    assert.ok(Math.abs(dB) < 1e-3, `rebirth θ exact: Δ = ${dB}`);
    assert.equal(qB.dying, 0);
    ok('particlePose: field-line life, ENA escape, surface impact, exact rebirth');
}

console.log(`\nring-current-particles: all ${n} test groups passed`);
