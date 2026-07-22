#!/usr/bin/env node
/**
 * space-weather-registry.mjs — drift gate for the dashboard panel registry
 * (js/space-weather-registry.js), the committed persona presets
 * (data/layout-presets/space-weather.json), and the Layout Lab v2 schema
 * (js/layout-lab.js). Three contracts:
 *
 *   1. REGISTRY ↔ PAGE: every `data-lab-panel` in space-weather.html has a
 *      registry entry with the right zone, and vice versa — the gallery
 *      drawer can never list a panel that isn't there, or miss one that is.
 *   2. PRESETS ⊆ REGISTRY, and each preset is total: every zone order lists
 *      EVERY registry panel of that zone exactly once, so applying a preset
 *      is fully deterministic (no mergeOrder guesswork on fresh pages).
 *   3. v1 → v2: the committed A/B variants file stays v1 and must keep
 *      normalizing through migrateLayout — bumping LAYOUT_VERSION must
 *      never strand a committed or personally-saved v1 layout.
 *
 *   node tests/space-weather-registry.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PANELS, FAMILIES, PERSONAS, byId, panelsForZone, galleryGroups }
    from '../js/space-weather-registry.js';
import { normalizeLayout, migrateLayout, LAYOUT_VERSION } from '../js/layout-lab.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const at = (p) => fileURLToPath(new URL(p, import.meta.url));

const html = await readFile(at('../space-weather.html'), 'utf8');
const presetsDoc = JSON.parse(await readFile(at('../data/layout-presets/space-weather.json'), 'utf8'));
const variantsDoc = JSON.parse(await readFile(at('../data/layout-variants/space-weather.json'), 'utf8'));

/* ── 0. Registry integrity ──────────────────────────────────────────── */

test('registry ids unique; zones/families/personas from closed vocabularies', () => {
    const ids = PANELS.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate panel id');
    for (const p of PANELS) {
        assert.ok(['main', 'grid'].includes(p.zone), `${p.id}: zone ${p.zone}`);
        assert.ok(p.family in FAMILIES, `${p.id}: family ${p.family}`);
        assert.ok(p.title && p.blurb, `${p.id}: title/blurb required`);
        for (const per of p.personas) {
            assert.ok(PERSONAS.includes(per), `${p.id}: persona ${per}`);
        }
    }
    assert.equal(byId().get('globe')?.zone, 'main');
    const grouped = galleryGroups().flatMap(g => g.panels.map(p => p.id));
    assert.equal(new Set(grouped).size, ids.length, 'galleryGroups must cover every panel');
});

/* ── 1. Registry ↔ page markup ──────────────────────────────────────── */

test('every data-lab-panel in the page has a registry entry, and vice versa', () => {
    const inPage = [...html.matchAll(/data-lab-panel="([^"]+)"/g)].map(m => m[1]);
    assert.equal(new Set(inPage).size, inPage.length, 'duplicate data-lab-panel in page');
    assert.deepEqual(new Set(inPage), new Set(PANELS.map(p => p.id)));
});

test('registry zone assignment matches the page nesting', () => {
    // The grid cards live inside the data-grid container (which opens the
    // "grid" zone) and the next main-zone panel after it is "imagery".
    // This pins today's authored structure on purpose — if the page is
    // restructured, this test is the reminder to re-check the registry.
    const gridStart = html.indexOf('data-lab-zone="grid"');
    const gridEnd = html.indexOf('data-lab-panel="imagery"');
    assert.ok(gridStart > 0 && gridEnd > gridStart, 'page structure moved — update this test');
    for (const p of PANELS) {
        if (p.id === 'data-grid') continue;   // the container itself is a main panel
        const pos = html.indexOf(`data-lab-panel="${p.id}"`);
        const inGridSpan = pos > gridStart && pos < gridEnd;
        assert.equal(inGridSpan, p.zone === 'grid', `${p.id}: zone ${p.zone} vs page position`);
    }
});

/* ── 2. Presets ─────────────────────────────────────────────────────── */

test('five presets, keyed by the locked personas, each labeled', () => {
    assert.deepEqual(Object.keys(presetsDoc.presets).sort(), [...PERSONAS].sort());
    for (const [k, p] of Object.entries(presetsDoc.presets)) {
        assert.ok(p.label && p.blurb, `${k}: label/blurb required`);
    }
});

test('every preset normalizes as v2 with its own name stamped', () => {
    for (const [k, p] of Object.entries(presetsDoc.presets)) {
        const l = normalizeLayout(p.layout, 'space-weather');
        assert.ok(l, `${k}: layout must normalize`);
        assert.equal(l.v, LAYOUT_VERSION);
        assert.equal(l.preset, k, `${k}: preset field must self-identify`);
    }
});

test('presets are total and closed over the registry (deterministic apply)', () => {
    const zoneIds = {
        main: panelsForZone('main').map(p => p.id),
        grid: panelsForZone('grid').map(p => p.id),
    };
    for (const [k, p] of Object.entries(presetsDoc.presets)) {
        for (const [zone, ids] of Object.entries(zoneIds)) {
            const spec = p.layout.zones[zone];
            assert.ok(spec, `${k}/${zone}: zone spec required`);
            assert.deepEqual(new Set(spec.order), new Set(ids),
                `${k}/${zone}: order must list every registry panel exactly`);
            assert.equal(new Set(spec.order).size, spec.order.length,
                `${k}/${zone}: duplicate id in order`);
            for (const id of [...spec.hidden, ...spec.wide]) {
                assert.ok(spec.order.includes(id), `${k}/${zone}: ${id} not in order`);
            }
            // applyLayout only honours wide in zones marked data-lab-wide="1"
            // — on this page that is the grid alone.
            if (zone === 'main') assert.equal(spec.wide.length, 0, `${k}: wide is grid-only`);
        }
        // A preset that hides everything in a zone is a broken default.
        assert.ok(p.layout.zones.main.hidden.length < zoneIds.main.length, `${k}: main all hidden`);
        assert.ok(p.layout.zones.grid.hidden.length < zoneIds.grid.length, `${k}: grid all hidden`);
    }
});

/* ── 3. v1 migration (the committed variants file is the live witness) ─ */

test('committed v1 A/B variant still normalizes through migrateLayout', () => {
    const b = variantsDoc.variants.b;
    assert.equal(b.v, 1, 'variants file stays v1 — regenerate deliberately, not by drift');
    const l = normalizeLayout(b, 'space-weather');
    assert.ok(l, 'v1 variant must migrate');
    assert.equal(l.v, LAYOUT_VERSION);
    assert.equal(l.preset, null, 'migrated v1 docs carry no preset attribution');
    assert.deepEqual(l.zones.main.order, b.zones.main.order);
});

test('migrateLayout touches only plain v1 objects', () => {
    assert.equal(migrateLayout(null), null);
    assert.equal(migrateLayout('x'), 'x');
    const v2 = { v: 2, preset: 'chaser', zones: {} };
    assert.equal(migrateLayout(v2), v2);
    const v9 = { v: 9, zones: {} };
    assert.equal(migrateLayout(v9), v9);
});

console.log(`space-weather-registry: ALL PASS (${n} tests)`);
