#!/usr/bin/env node
/**
 * forecast-leaderboard.mjs — unit test for rankBySkill(), the pure ranking
 * behind the Earth-page model skill leaderboard.
 */
import assert from 'node:assert/strict';

const ROOT = '/home/user/ParkersPhysics';
globalThis.indexedDB = { open() { const r = {}; queueMicrotask(() => r.onerror?.({ target: { error: new Error('no IDB') } })); return r; } };
globalThis.document = { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
globalThis.CustomEvent = class { constructor(t, i = {}) { this.type = t; this.detail = i.detail ?? null; } };

const { rankBySkill } = await import(ROOT + '/js/weather-forecast-validation.js');

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); } };

// Murphy skill = 1 − mse_model/mse_ref. Horizons are 1,3,6,12,24.
const summary = {
    'persistence-v1': { T: { 1: { n: 10, mse: 4 }, 6: { n: 10, mse: 9 } }, precip: { 1: { n: 10, mse: 1 } } },
    'good-model-v1':  { T: { 1: { n: 10, mse: 1 }, 6: { n: 10, mse: 9 } } },   // (0.75 + 0)/2 = 0.375
    'bad-model-v1':   { T: { 1: { n: 10, mse: 16 } } },                        // 1 − 16/4 = −3
    'warming-v1':     { T: { 1: { n: 2,  mse: 1 } } },                         // n<5 → null
    'precip-spec-v1': { precip: { 1: { n: 10, mse: 0.5 } } },                  // 1 − 0.5/1 = 0.5
};

console.log('forecast-leaderboard.mjs');
console.log('────────────────────────');

const ranked = rankBySkill(summary, { minN: 5 });

check('persistence (the reference) is excluded', () => {
    assert.ok(!ranked.some(r => r.model === 'persistence-v1'));
});
check('ranked best-first by Murphy skill', () => {
    assert.equal(ranked[0].model, 'precip-spec-v1', `1st: ${ranked[0].model}`);
    assert.equal(ranked[1].model, 'good-model-v1',  `2nd: ${ranked[1].model}`);
    assert.equal(ranked[2].model, 'bad-model-v1',   `3rd: ${ranked[2].model}`);
});
check('skill values correct', () => {
    const by = Object.fromEntries(ranked.map(r => [r.model, r]));
    assert.ok(Math.abs(by['precip-spec-v1'].skill - 0.5)   < 1e-9, `precip ${by['precip-spec-v1'].skill}`);
    assert.ok(Math.abs(by['good-model-v1'].skill  - 0.375) < 1e-9, `good ${by['good-model-v1'].skill}`);
    assert.ok(Math.abs(by['bad-model-v1'].skill   + 3)     < 1e-9, `bad ${by['bad-model-v1'].skill}`);
    assert.equal(by['good-model-v1'].buckets, 2, 'good covers 2 buckets');
});
check('models below minN warm up (skill null) and sink to the bottom', () => {
    const warm = ranked.find(r => r.model === 'warming-v1');
    assert.equal(warm.skill, null, 'warming skill is null');
    assert.equal(ranked[ranked.length - 1].model, 'warming-v1', 'warming sorted last');
});
check('no reference model → empty ranking', () => {
    assert.deepEqual(rankBySkill({ 'a-v1': { T: { 1: { n: 9, mse: 1 } } } }, { minN: 5 }), []);
});
check('respects a higher minN threshold', () => {
    const r = rankBySkill(summary, { minN: 11 });   // nothing has n≥11 → all warming
    assert.ok(r.every(row => row.skill === null), 'all warming at minN=11');
});

console.log('────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
