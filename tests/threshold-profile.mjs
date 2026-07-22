#!/usr/bin/env node
/**
 * threshold-profile.mjs — fixture gate for the §8 unified threshold
 * profile (js/threshold-profile.js): one per-user line
 * { kp, minBzNt, dstNt, leoAltKm }, clamped, with the G-scale DERIVED
 * from kp (never stored — a stored copy could contradict it).
 *
 *   node tests/threshold-profile.mjs
 */

import assert from 'node:assert/strict';
import { PROFILE_DEFAULTS, normalizeProfile, gScaleForKp, profilesEqual,
         loadProfile, STORAGE_KEY, CHANGE_EVENT }
    from '../js/threshold-profile.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

test('defaults are the documented moderate-storm line', () => {
    assert.deepEqual(PROFILE_DEFAULTS, { kp: 5, minBzNt: -10, dstNt: -50, leoAltKm: 550 });
});

test('normalize completes and clamps every field', () => {
    assert.deepEqual(normalizeProfile(null), { ...PROFILE_DEFAULTS });
    assert.deepEqual(normalizeProfile({}), { ...PROFILE_DEFAULTS });
    const p = normalizeProfile({ kp: 14, minBzNt: -200, dstNt: 40, leoAltKm: 12, junk: 'x' });
    assert.deepEqual(p, { kp: 9, minBzNt: -60, dstNt: 0, leoAltKm: 200 });
    assert.equal('junk' in p, false, 'unknown keys stripped');
    assert.equal(normalizeProfile({ kp: 'not a number' }).kp, PROFILE_DEFAULTS.kp);
    assert.equal(normalizeProfile({ kp: '6.5' }).kp, 6.5, 'numeric strings accepted (form inputs)');
});

test('gScale is DERIVED from kp on the NOAA boundaries', () => {
    assert.equal(gScaleForKp(4.9), 0);
    assert.equal(gScaleForKp(5), 1);      // G1
    assert.equal(gScaleForKp(6.7), 2);    // G2
    assert.equal(gScaleForKp(9), 5);      // G5
    assert.equal(gScaleForKp(null), 0);
});

test('profilesEqual normalizes before comparing', () => {
    assert.ok(profilesEqual({ kp: 5 }, { ...PROFILE_DEFAULTS }));
    assert.ok(!profilesEqual({ kp: 4 }, { kp: 5 }));
    assert.ok(profilesEqual({ kp: 99 }, { kp: 9 }), 'clamp then compare');
});

test('node-safe surface: loadProfile without DOM storage → defaults', () => {
    assert.deepEqual(loadProfile(), { ...PROFILE_DEFAULTS });
    assert.equal(typeof STORAGE_KEY, 'string');
    assert.equal(typeof CHANGE_EVENT, 'string');
});

console.log(`threshold-profile: ALL PASS (${n} tests)`);
