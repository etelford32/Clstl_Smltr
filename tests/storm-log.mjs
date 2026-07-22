#!/usr/bin/env node
/**
 * storm-log.mjs — fixture gate for the personal storm log's pure core
 * (js/storm-log.js feedSample): rising-edge detection with hysteresis —
 * one storm episode is ONE entry, and nothing is recorded below the line.
 *
 *   node tests/storm-log.mjs
 */

import assert from 'node:assert/strict';
import { feedSample, LOG_MAX } from '../js/storm-log.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const T = 1_753_000_000_000;

test('a crossing records once; staying above does not repeat it', () => {
    let r = feedSample(null, 3, 5, T);
    assert.equal(r.crossed, false);
    r = feedSample(r.state, 5.3, 5, T + 1000);
    assert.equal(r.crossed, true);
    assert.deepEqual(r.state.entries, [{ t: T + 1000, kp: 5.3, thr: 5 }]);
    r = feedSample(r.state, 6.7, 5, T + 2000);      // still in-episode
    assert.equal(r.crossed, false);
    assert.equal(r.state.entries.length, 1);
});

test('hysteresis: a new entry only after dropping back below the line', () => {
    let r = feedSample(null, 6, 5, T);              // episode 1
    r = feedSample(r.state, 4, 5, T + 1000);        // back below
    assert.equal(r.crossed, false);
    r = feedSample(r.state, 5.1, 5, T + 2000);      // episode 2
    assert.equal(r.crossed, true);
    assert.equal(r.state.entries.length, 2);
    assert.equal(r.state.entries[0].t, T + 2000, 'newest first');
});

test('below the line nothing records; junk inputs are inert', () => {
    let r = feedSample(null, 4.9, 5, T);
    assert.equal(r.state.entries.length, 0);
    r = feedSample(r.state, NaN, 5, T);
    assert.equal(r.crossed, false);
    r = feedSample(r.state, 6, null, T);
    assert.equal(r.crossed, false);
});

test('ring buffer caps at LOG_MAX', () => {
    let state = null;
    for (let i = 0; i < LOG_MAX + 10; i++) {
        state = feedSample(state, 6, 5, T + i * 2000).state;      // cross
        state = feedSample(state, 3, 5, T + i * 2000 + 1000).state; // reset
    }
    assert.equal(state.entries.length, LOG_MAX);
    assert.equal(state.entries[0].t, T + (LOG_MAX + 9) * 2000, 'newest kept');
});

console.log(`storm-log: ALL PASS (${n} tests)`);
