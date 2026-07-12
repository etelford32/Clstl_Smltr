#!/usr/bin/env node
/**
 * layout-lab.mjs — pure-Node validation of the layout algebra in
 * js/layout-lab.js (mergeOrder / normalizeLayout / layoutsEqual).
 * DOM apply/capture and the designer UI are exercised in the browser;
 * these invariants are what keeps a saved/committed layout from
 * corrupting a page that has since shipped new panels.
 *
 *   node tests/layout-lab.mjs
 */

import assert from 'node:assert/strict';
import { mergeOrder, normalizeLayout, layoutsEqual, LAYOUT_VERSION }
    from '../js/layout-lab.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

/* ── mergeOrder ─────────────────────────────────────────────────────── */

test('identity: saved order == dom order', () => {
    assert.deepEqual(mergeOrder(['a', 'b', 'c'], ['a', 'b', 'c']), ['a', 'b', 'c']);
});

test('reorder is honored', () => {
    assert.deepEqual(mergeOrder(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b']);
});

test('stale saved ids (panel removed from page) are dropped', () => {
    assert.deepEqual(mergeOrder(['a', 'c'], ['c', 'ghost', 'a']), ['c', 'a']);
});

test('new panel keeps DOM locality, not dumped at the end', () => {
    // Page shipped new panel 'x' between b and c after the layout was saved.
    assert.deepEqual(mergeOrder(['a', 'b', 'x', 'c'], ['c', 'a', 'b']),
        ['c', 'a', 'b', 'x']);
    // New first panel lands first.
    assert.deepEqual(mergeOrder(['x', 'a', 'b'], ['b', 'a']), ['x', 'b', 'a']);
});

test('empty saved order falls back to DOM order', () => {
    assert.deepEqual(mergeOrder(['a', 'b'], []), ['a', 'b']);
    assert.deepEqual(mergeOrder(['a', 'b'], undefined), ['a', 'b']);
});

test('duplicates in either input are deduped', () => {
    assert.deepEqual(mergeOrder(['a', 'a', 'b'], ['b', 'b', 'a']), ['b', 'a']);
});

/* ── normalizeLayout ────────────────────────────────────────────────── */

const good = {
    v: LAYOUT_VERSION, page: 'space-weather',
    zones: { main: { order: ['a', 'b'], hidden: ['b'], wide: [] } },
};

test('valid layout round-trips', () => {
    const l = normalizeLayout(good, 'space-weather');
    assert.equal(l.page, 'space-weather');
    assert.deepEqual(l.zones.main.order, ['a', 'b']);
    assert.deepEqual(l.zones.main.hidden, ['b']);
});

test('wrong version / wrong page / garbage → null', () => {
    assert.equal(normalizeLayout({ ...good, v: 99 }, 'space-weather'), null);
    assert.equal(normalizeLayout(good, 'earth'), null);
    assert.equal(normalizeLayout(null), null);
    assert.equal(normalizeLayout('[]'), null);
    assert.equal(normalizeLayout({ v: 1 }), null);           // no zones
    assert.equal(normalizeLayout({ v: 1, zones: [] }), null); // zones not object
});

test('non-string ids and duplicates are stripped, missing lists default', () => {
    const l = normalizeLayout({
        v: 1, zones: { g: { order: ['a', 42, 'a', null, 'b'], hidden: 'nope' } },
    }, 'p');
    assert.deepEqual(l.zones.g.order, ['a', 'b']);
    assert.deepEqual(l.zones.g.hidden, []);
    assert.deepEqual(l.zones.g.wide, []);
});

test('unknown extra keys are not preserved (import surface is minimal)', () => {
    const l = normalizeLayout({ v: 1, evil: '<script>', zones: { m: { order: ['a'] } } }, 'p');
    assert.equal('evil' in l, false);
});

/* ── layoutsEqual ───────────────────────────────────────────────────── */

test('layoutsEqual ignores field-order noise via normalization', () => {
    const a = { v: 1, page: 'p', zones: { m: { order: ['a'], hidden: [], wide: [] } } };
    const b = { v: 1, page: 'p', zones: { m: { wide: [], hidden: [], order: ['a'] } } };
    assert.equal(layoutsEqual(a, b), true);
    assert.equal(layoutsEqual(a, { ...a, zones: { m: { order: ['b'] } } }), false);
});

console.log(`layout-lab: ALL PASS (${n} tests)`);
