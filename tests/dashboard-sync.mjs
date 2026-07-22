#!/usr/bin/env node
/**
 * dashboard-sync.mjs — fixture gate for the pure decision core of the
 * D2 cloud sync (js/dashboard-sync.js): who syncs (tier gate, decision
 * #2), which side wins (last-write-wins by updated_at), and how the
 * supabase-js session token is recognized across its storage shapes.
 *
 *   node tests/dashboard-sync.mjs
 */

import assert from 'node:assert/strict';
import { tierAllowsSync, pickNewer, parseSbToken } from '../js/dashboard-sync.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

test('tier gate: Basic+ syncs; free does not; testers and admins ride along', () => {
    assert.equal(tierAllowsSync('free', 'user'), false);
    assert.equal(tierAllowsSync('basic', 'user'), true);
    assert.equal(tierAllowsSync('educator', 'user'), true);
    assert.equal(tierAllowsSync('institution', 'user'), true);
    assert.equal(tierAllowsSync('enterprise', 'user'), true);
    assert.equal(tierAllowsSync('tester', 'user'), true);
    assert.equal(tierAllowsSync('free', 'superadmin'), true, 'role overrides plan');
    assert.equal(tierAllowsSync(undefined, undefined), false);
});

test('last-write-wins decisions', () => {
    const at = (iso) => ({ updatedAt: iso });
    const row = (iso) => ({ updated_at: iso });
    assert.equal(pickNewer(null, row('2026-07-22T10:00:00Z')), 'remote', 'never synced → take remote');
    assert.equal(pickNewer(at('2026-07-22T09:00:00Z'), row('2026-07-22T10:00:00Z')), 'remote');
    assert.equal(pickNewer(at('2026-07-22T11:00:00Z'), row('2026-07-22T10:00:00Z')), 'local');
    assert.equal(pickNewer(at('2026-07-22T10:00:00Z'), row('2026-07-22T10:00:00Z')), 'equal');
    assert.equal(pickNewer(at('2026-07-22T10:00:00Z'), null), 'local', 'no remote row → local');
    assert.equal(pickNewer(null, null), 'local', 'nothing anywhere → keep local life');
});

test('session-token extraction across supabase-js storage shapes', () => {
    const tok = 'x'.repeat(40);
    assert.equal(parseSbToken({ access_token: tok }), tok);
    assert.equal(parseSbToken({ currentSession: { access_token: tok } }), tok);
    assert.equal(parseSbToken({ access_token: 'short' }), null);
    assert.equal(parseSbToken(null), null);
    assert.equal(parseSbToken({}), null);
});

console.log(`dashboard-sync: ALL PASS (${n} tests)`);
