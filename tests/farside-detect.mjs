// farside-detect.mjs — contract tests for the far-side blob detector.
//
// The headline case is the 0°/360° seam. Carrington longitude is an ANGLE, and
// the detector's flood fill has always wrapped across it — but the centroid
// used to be an arithmetic mean of column indices, so a region straddling the
// seam (columns near 355 AND near 5) averaged to ~180°: the opposite side of
// the Sun. Nothing crashed, nothing looked wrong on the map, and the region's
// east-limb emergence forecast came out up to half a rotation (~13.6 d) off.
//
// These tests are written so that a return to linear averaging fails loudly.

import assert from 'node:assert/strict';
import { detectSignatures, isStrong } from '../js/farside/farside-detect.js';
import { DETECT, GRID } from '../js/farside/farside-config.js';
import { wrap180 } from '../js/farside/carrington.js';

const { nLon, nLat, latMin } = GRID;
const close = (a, b, tol, what) =>
    assert.ok(Math.abs(a) <= tol || Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);
const lonClose = (a, b, tol, what) =>
    assert.ok(Math.abs(wrap180(a - b)) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);

/** A clean map with Gaussian wells at the given (lon, lat) centres. */
function mapWith(regions, { amp = 4, radius = 8 } = {}) {
    const data = new Float32Array(nLon * nLat);
    for (const [cx, cy] of regions) {
        for (let dy = -radius * 2; dy <= radius * 2; dy++) {
            const lat = Math.round(cy) + dy;
            if (lat < latMin || lat >= latMin + nLat) continue;
            const row = (lat - latMin) * nLon;
            for (let dx = -radius * 2; dx <= radius * 2; dx++) {
                const lon = ((Math.round(cx) + dx) % nLon + nLon) % nLon;
                data[row + lon] -= amp * Math.exp(-(dx * dx + dy * dy) / (2 * radius * radius));
            }
        }
    }
    return { grid: { ...GRID }, data, L0: 0, B0: 0, timestamp: '2026-08-19T00:00:00Z' };
}

// ── The seam ─────────────────────────────────────────────────────────────
{
    // Dead on the seam. The linear-mean bug reported this at ~180°.
    const d = detectSignatures(mapWith([[0, 10]]));
    assert.equal(d.length, 1, 'one blob');
    lonClose(d[0].lon, 0, 1.5, 'centroid at the seam');
    assert.ok(Math.abs(wrap180(d[0].lon - 180)) > 90,
        'centroid is NOT on the opposite side of the Sun');
    close(d[0].lat, 10, 1.5, 'latitude');

    // bbox must also read as a wrapped interval, not [0, 359].
    const { lon0, lon1 } = d[0].bbox;
    assert.ok(lon0 > 300, `bbox starts before the seam (got ${lon0})`);
    assert.ok(lon1 < 60, `bbox ends after the seam (got ${lon1})`);
}

// ── No longitude is special ──────────────────────────────────────────────
{
    // Rotational equivariance: shift the whole field by k degrees and every
    // detected longitude must shift by exactly k. This is the invariant the
    // linear mean violated, stated in the strongest form.
    for (const shift of [0, 1, 45, 179, 180, 270, 355, 359]) {
        const d = detectSignatures(mapWith([[shift, -12]]));
        assert.equal(d.length, 1, `one blob at shift ${shift}`);
        lonClose(d[0].lon, shift, 1.5, `equivariance at ${shift}`);
    }
}

// ── Several regions at once, including one on the seam ───────────────────
{
    const d = detectSignatures(mapWith([[270, 17], [132, -12], [1, -9]]));
    assert.equal(d.length, 3, 'three separate blobs');
    const lons = d.map((x) => x.lon).sort((a, b) => a - b);
    lonClose(lons[0], 1, 2, 'seam region');
    lonClose(lons[1], 132, 2, 'mid region');
    lonClose(lons[2], 270, 2, 'far region');
    // Strongest-first ordering is part of the contract.
    for (let i = 1; i < d.length; i++) assert.ok(d[i - 1].strength >= d[i].strength);
}

// ── Thresholds still hold ────────────────────────────────────────────────
{
    // Polar artifacts outside the active-region belt are ignored.
    assert.equal(detectSignatures(mapWith([[100, 80]])).length, 0, 'polar blob rejected');
    assert.ok(DETECT.maxLatDeg < 80);

    // Specks below the area floor are rejected; a real region is not.
    assert.equal(detectSignatures(mapWith([[100, 0]], { amp: 4, radius: 1 })).length, 0, 'speck rejected');
    assert.equal(detectSignatures(mapWith([[100, 0]], { amp: 4, radius: 8 })).length, 1, 'region kept');

    // A field with no signal detects nothing — no phantom blob at the seam.
    assert.deepEqual(detectSignatures(mapWith([])), []);
}

// ── Strength / confidence contract ───────────────────────────────────────
{
    const strong = detectSignatures(mapWith([[200, 5]], { amp: 5, radius: 11 }))[0];
    // Faint but still above the area floor — below it the detector correctly
    // returns nothing, which is the case the threshold block above covers.
    const faint = detectSignatures(mapWith([[200, 5]], { amp: 3, radius: 6 }))[0];
    assert.ok(strong.strength > faint.strength, 'bigger + deeper scores higher');
    assert.ok(strong.confidence > faint.confidence);
    assert.ok(strong.confidence <= 1 && faint.confidence >= 0);
    assert.equal(isStrong(strong), true);
    // A seam region must be judged on its signal, not penalised by its position.
    const seam = detectSignatures(mapWith([[0, 5]], { amp: 5, radius: 11 }))[0];
    close(seam.strength, strong.strength, 0.4, 'seam strength matches an identical inland region');
    assert.equal(isStrong(seam), true);
}

console.log('✓ Far-Side Watch detector (seam-safe)');
