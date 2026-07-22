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
import { mergeOrder, normalizeLayout, layoutsEqual, LAYOUT_VERSION,
         clampSize, SIZE_MIN, SIZE_MAX }
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

/* ── size map (resizable panels) ────────────────────────────────────── */

test('clampSize bounds and rejects garbage', () => {
    assert.equal(clampSize(520), 520);
    assert.equal(clampSize(1), SIZE_MIN);
    assert.equal(clampSize(99999), SIZE_MAX);
    assert.equal(clampSize('740'), 740);      // storage round-trips strings
    assert.equal(clampSize('12px'), null);
    assert.equal(clampSize(NaN), null);
    assert.equal(clampSize(undefined), null);
});

test('normalizeLayout clamps size map and drops invalid entries', () => {
    const l = normalizeLayout({
        v: 1,
        zones: { m: { order: ['a'], size: { a: 700, b: 5, c: 'huge', d: 1e6 } } },
    }, 'p');
    assert.deepEqual(l.zones.m.size, { a: 700, b: SIZE_MIN, d: SIZE_MAX });
});

test('missing size map defaults to empty object', () => {
    const l = normalizeLayout({ v: 1, zones: { m: { order: ['a'] } } }, 'p');
    assert.deepEqual(l.zones.m.size, {});
});

/* ── v2 preset field + v1 migration ─────────────────────────────────── */

test('v2 preset field survives normalization; junk presets drop to null', () => {
    const base = { v: 2, page: 'p', zones: { m: { order: ['a'] } } };
    assert.equal(normalizeLayout({ ...base, preset: 'chaser' }, 'p').preset, 'chaser');
    assert.equal(normalizeLayout(base, 'p').preset, null);
    assert.equal(normalizeLayout({ ...base, preset: 42 }, 'p').preset, null);
    assert.equal(normalizeLayout({ ...base, preset: 'x'.repeat(41) }, 'p').preset, null);
});

test('v1 docs are accepted forever via migration (preset = null)', () => {
    const v1 = { v: 1, page: 'p', zones: { m: { order: ['a', 'b'], hidden: ['b'] } } };
    const l = normalizeLayout(v1, 'p');
    assert.equal(l.v, LAYOUT_VERSION);
    assert.equal(l.preset, null);
    assert.deepEqual(l.zones.m.order, ['a', 'b']);
});

/* ── layoutsEqual ───────────────────────────────────────────────────── */

test('layoutsEqual ignores field-order noise via normalization', () => {
    const a = { v: 1, page: 'p', zones: { m: { order: ['a'], hidden: [], wide: [] } } };
    const b = { v: 1, page: 'p', zones: { m: { wide: [], hidden: [], order: ['a'] } } };
    assert.equal(layoutsEqual(a, b), true);
    assert.equal(layoutsEqual(a, { ...a, zones: { m: { order: ['b'] } } }), false);
});

console.log(`layout-lab: ALL PASS (${n} tests)`);
