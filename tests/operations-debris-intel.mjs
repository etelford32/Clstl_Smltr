#!/usr/bin/env node
/**
 * operations-debris-intel.mjs — pins the debris-catalog attribution the
 * Operations console's debris-intelligence surfaces depend on (conjunction
 * sub-row family chips, density-map dominant-family tooltips + legend).
 *
 *   1. Registry sanity: unique ids, colors, valid hazard tiers, sane
 *      NORAD ranges — a malformed family entry would silently break
 *      chip colors and range attribution.
 *   2. classifyDebris: NORAD-range attribution (with name cross-check),
 *      name-pattern fallback, unknown fallthrough.
 *   3. annotate + hazardEnergyMJ: KE scales as v² — the conjunction chip
 *      quotes KE at the screen's actual closing speed.
 *   4. shortFamilyName: the year-fold used by the tight UI rows.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import {
    DEBRIS_FAMILIES, classifyDebris, annotate, hazardEnergyMJ,
    shortFamilyName, getFamily,
} from '../js/debris-catalog.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

// ── 1. Registry sanity ──
{
    const ids = new Set();
    const tiers = new Set(['critical', 'high', 'medium', 'low']);
    for (const f of DEBRIS_FAMILIES) {
        assert.ok(f.id && !ids.has(f.id), `unique id (${f.id})`);
        ids.add(f.id);
        assert.ok(/^#[0-9a-f]{6}$/i.test(f.color), `${f.id}: color is a hex swatch`);
        assert.ok(tiers.has(f.hazardTier), `${f.id}: hazard tier valid`);
        if (f.noradMin != null || f.noradMax != null) {
            assert.ok(f.noradMin <= f.noradMax, `${f.id}: NORAD range ordered`);
        }
    }
    assert.ok(getFamily('unknown'), 'unknown family exists as the fallthrough');
    ok(`registry: ${DEBRIS_FAMILIES.length} families, unique ids, valid swatches + tiers`);
}

// ── 2. Attribution ──
{
    // Fengyun-1C ASAT: in-range NORAD + matching name.
    const fy = classifyDebris({ noradId: 30000, name: 'FENGYUN 1C DEB' });
    assert.equal(fy.id, 'fengyun-1c', 'Fengyun range + name → fengyun-1c');

    // Same NORAD range but a non-matching name must NOT be swept in
    // (the range cross-checks the name pattern when one exists).
    const notFy = classifyDebris({ noradId: 30000, name: 'SOMETHING ELSE' });
    assert.notEqual(notFy.id, 'fengyun-1c', 'range hit without name match not swept');

    // Name-pattern fallback with an out-of-range id.
    const ir = classifyDebris({ noradId: 99999, name: 'IRIDIUM 33 DEB' });
    assert.equal(ir.id, 'cosmos-iridium-2009', 'name pattern → Iridium/Cosmos family');
    const cs = classifyDebris({ norad_id: 99998, name: 'COSMOS 2251 DEB' });
    assert.equal(cs.id, 'cosmos-iridium-2009', 'norad_id key alias accepted');

    // Unknown fallthrough.
    const un = classifyDebris({ noradId: 1, name: 'TIROS 1' });
    assert.equal(un.id, 'unknown', 'unattributed object → unknown');
    ok('classifyDebris: range + name cross-check, pattern fallback, unknown fallthrough');
}

// ── 3. Annotation + KE scaling ──
{
    const a = annotate({ noradId: 30000, name: 'FENGYUN 1C DEB' });
    assert.equal(a.family.id, 'fengyun-1c');
    assert.ok(a.size?.massKg > 0, 'size estimate carries a mass');
    assert.ok(a.hazardMJ > 0, 'hazard energy positive');

    // KE ∝ v²: doubling the closing speed quadruples the chip's MJ.
    const ke14 = hazardEnergyMJ(100, 14);
    const ke28 = hazardEnergyMJ(100, 28);
    assert.ok(Math.abs(ke28 / ke14 - 4) < 1e-9, `KE scales as v² (${ke28 / ke14})`);
    ok('annotate + hazardEnergyMJ: mass, positive KE, v² scaling');
}

// ── 4. Short labels ──
{
    assert.equal(
        shortFamilyName({ name: 'Fengyun-1C ASAT (2007)' }),
        'Fengyun-1C ASAT ’07', 'year folds to a tick');
    const noYear = shortFamilyName({ name: 'Rocket bodies' });
    assert.equal(noYear, 'Rocket bodies', 'no-year names pass through');
    assert.equal(shortFamilyName(null), '', 'null-safe');
    ok('shortFamilyName: year fold, passthrough, null-safe');
}

console.log(`\nAll ${passed} checks passed.`);
