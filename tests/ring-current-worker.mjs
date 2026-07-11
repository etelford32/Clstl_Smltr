#!/usr/bin/env node
/**
 * ring-current-worker.mjs — pure-Node tests for the worker dispatch
 * (js/ring-current-worker.js handleRequest — the exact function the module
 * worker's onmessage calls; importing the module under node is safe because
 * the self.onmessage wiring is guarded):
 *
 *   1. population: returns transferable seed/kin buffers matching
 *      buildPopulation's shape, transfer list carries both ArrayBuffers.
 *   2. state: byte-for-byte the same result as calling computeState directly
 *      (same module, same arguments — the worker cannot drift physics).
 *   3. unknown type → ok:false with a message; malformed population request
 *      → ok:false (error captured, never thrown).
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import { handleRequest } from '../js/ring-current-worker.js';
import { computeState } from '../js/ring-current-feed.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

// ── 1. population request ────────────────────────────────────────────────────
{
    const { response, transfer } = handleRequest(
        { id: 'ionsO', type: 'population', count: 128, species: 'oxygen' });
    assert.equal(response.id, 'ionsO');
    assert.equal(response.ok, true);
    assert.equal(response.count, 128);
    assert.equal(response.species, 'oxygen');
    assert.equal(response.seed.length, 384);
    assert.equal(response.kin.length, 384);
    assert.equal(response.life.length, 512);
    assert.equal(response.eKev.length, 128);
    assert.deepEqual(transfer, [
        response.seed.buffer, response.kin.buffer,
        response.life.buffer, response.eKev.buffer,
    ]);
    ok('population: seed/kin/life/eKev buffers listed for zero-copy transfer');
}

// ── 2. state request ≡ direct computeState ───────────────────────────────────
{
    const T0 = Date.parse('2026-07-10T00:00:00Z');
    const drivers = [], observed = [];
    for (let m = 0; m <= 6 * 60; m++) {
        drivers.push({ t: T0 + m * 60_000, v: 600, n: 15, bz: -15, bt: 16, temp: 2e5 });
    }
    for (let h = 0; h <= 7; h++) observed.push({ t: T0 + h * 3.6e6, dst: -20 });
    const nowMs = T0 + 6 * 3.6e6;

    const { response } = handleRequest(
        { id: 3, type: 'state', drivers, observed, kp: 4, nowMs, f107: 150 });
    const direct = computeState(drivers, observed, 4, nowMs, 150);
    assert.equal(response.ok, true);
    assert.deepEqual(response.state, direct);
    assert.ok(response.state.now.dstModel < -60, 'fixture is a storm');

    // Insufficient inputs → null state, still ok (not an error).
    const empty = handleRequest({ id: 4, type: 'state', drivers: [], observed, kp: 4, nowMs });
    assert.equal(empty.response.ok, true);
    assert.equal(empty.response.state, null);
    ok('state: identical to direct computeState; null-state passthrough');
}

// ── 3. failure paths never throw ─────────────────────────────────────────────
{
    const bad = handleRequest({ id: 9, type: 'nonsense' });
    assert.equal(bad.response.ok, false);
    assert.match(bad.response.error, /unknown request type/);

    const boom = handleRequest({ id: 10, type: 'population', count: -5, species: 'ion' });
    assert.equal(boom.response.ok, false);
    assert.ok(boom.response.error.length > 0);

    assert.equal(handleRequest(null).response.ok, false);
    ok('failure paths: unknown type, invalid count, null message → ok:false');
}

console.log(`\nring-current-worker: all ${n} test groups passed`);
