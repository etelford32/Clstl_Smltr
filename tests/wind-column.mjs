#!/usr/bin/env node
/**
 * wind-column.mjs
 *
 * Pins the pure half of js/wind-column.js — the vertical wind-profile
 * columns that tie the four particle layers into one readable shear glyph.
 *
 * What this gate protects:
 *
 *   1. THE FRAME. `tangentBasis` must produce a genuinely orthonormal
 *      east/north/up triad in the page's canonical frame
 *      (x = cosφcosλ, y = sinφ, z = −cosφsinλ). Three separate bugs in this
 *      repo's history came from re-deriving a local frame by hand, and an
 *      east vector that is subtly wrong points every arrow slightly off the
 *      wind it claims to show — which is invisible until someone tries to
 *      read a veering profile off it.
 *
 *   2. NO-DATA IS NOT CALM. A level with no upstream wind must contribute no
 *      arrow. Drawing a zero-length one says "calm here", which is a factual
 *      claim the feed did not make.
 *
 *   3. THE SITE GRID is stable and bounded — snapped to a fixed lattice so
 *      it cannot shimmer as the camera nudges, and never over the budget.
 *
 * Exits 0 on pass, non-zero on failure.
 */

import assert from 'node:assert/strict';
import {
    tangentBasis, columnGrid, columnSegments, maxVerticesPerColumn,
} from '../js/wind-column.js';

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const DEG = Math.PI / 180;

console.log('wind-column — vertical wind-profile columns');

// ── 1. The local frame ───────────────────────────────────────────────────────
check('tangentBasis is orthonormal everywhere it is used', () => {
    for (let lat = -80; lat <= 80; lat += 10) {
        for (let lon = -180; lon < 180; lon += 30) {
            const { up, east, north } = tangentBasis(lat, lon);
            for (const [nm, v] of [['up', up], ['east', east], ['north', north]]) {
                assert.ok(Math.abs(len(v) - 1) < 1e-12,
                    `${nm} not unit at ${lat},${lon}: |v|=${len(v)}`);
            }
            assert.ok(Math.abs(dot(up, east))   < 1e-12, `up·east   ${lat},${lon}`);
            assert.ok(Math.abs(dot(up, north))  < 1e-12, `up·north  ${lat},${lon}`);
            assert.ok(Math.abs(dot(east, north)) < 1e-12, `east·north ${lat},${lon}`);
        }
    }
});

check('up matches the page geoToXYZ mapping', () => {
    // The whole layer hangs off this: `up` must be the same direction
    // earth.html's geoToXYZ produces, or every column is planted somewhere
    // other than the site it is labelled with.
    for (const [lat, lon] of [[0, 0], [45, 90], [-30, -120], [70, 175]]) {
        const phi = lat * DEG, lam = lon * DEG;
        const want = [Math.cos(phi) * Math.cos(lam), Math.sin(phi), -Math.cos(phi) * Math.sin(lam)];
        const { up } = tangentBasis(lat, lon);
        for (let i = 0; i < 3; i++) {
            assert.ok(Math.abs(up[i] - want[i]) < 1e-12,
                `up[${i}] at ${lat},${lon}: ${up[i]} vs ${want[i]}`);
        }
    }
});

check('east points to increasing longitude, north to increasing latitude', () => {
    // Sign errors here flip a westerly into an easterly and read as a
    // plausible-but-wrong forecast. Verified against a finite difference of
    // the position mapping rather than against the formula's own algebra.
    const p = (la, lo) => {
        const phi = la * DEG, lam = lo * DEG;
        return [Math.cos(phi) * Math.cos(lam), Math.sin(phi), -Math.cos(phi) * Math.sin(lam)];
    };
    for (const [lat, lon] of [[0, 0], [30, 45], [-55, 160]]) {
        const { east, north } = tangentBasis(lat, lon);
        const h = 1e-4;
        const dE = p(lat, lon + h).map((v, i) => v - p(lat, lon)[i]);
        const dN = p(lat + h, lon).map((v, i) => v - p(lat, lon)[i]);
        assert.ok(dot(east, dE) > 0,  `east backwards at ${lat},${lon}`);
        assert.ok(dot(north, dN) > 0, `north backwards at ${lat},${lon}`);
    }
});

// ── 2. Column geometry ───────────────────────────────────────────────────────
const COL = [1, 1, 1];
function mkLevels(over = {}) {
    const base = [
        { key: 'sfc',  radius: 1.0030, u: 0.5, v: 0.0, speed01: 0.5, color: COL, hasData: true },
        { key: '850',  radius: 1.0160, u: 0.0, v: 0.6, speed01: 0.6, color: COL, hasData: true },
        { key: '500',  radius: 1.0513, u: -0.4, v: 0.2, speed01: 0.45, color: COL, hasData: true },
        { key: '250',  radius: 1.0928, u: 0.9, v: 0.1, speed01: 0.9, color: COL, hasData: true },
    ];
    return base.map((l, i) => ({ ...l, ...(over[i] ?? {}) }));
}
function mkOut(levels) {
    const cap = maxVerticesPerColumn(levels.length);
    return { pos: new Float32Array(cap * 3), col: new Float32Array(cap * 3), n: 0 };
}

check('a full 4-level column emits masts plus one arrow per level', () => {
    const levels = mkLevels();
    const out = mkOut(levels);
    const written = columnSegments(20, 30, levels, out);
    // 3 mast gaps × 2 verts + 4 arrows × 6 verts
    assert.equal(written, 3 * 2 + 4 * 6);
    assert.equal(out.n, written);
    assert.ok(written <= maxVerticesPerColumn(4), 'exceeded the declared budget');
});

check('a level with no data plants NO arrow (no-data is not calm)', () => {
    const levels = mkLevels({ 2: { hasData: false } });
    const out = mkOut(levels);
    const written = columnSegments(20, 30, levels, out);
    // Mast is unchanged (it is a reference line, not a claim about wind);
    // one arrow's worth of vertices is gone.
    assert.equal(written, 3 * 2 + 3 * 6);
});

check('a genuinely calm level plants no arrow either', () => {
    const levels = mkLevels({ 1: { u: 0, v: 0, speed01: 0 } });
    const out = mkOut(levels);
    const written = columnSegments(20, 30, levels, out);
    assert.equal(written, 3 * 2 + 3 * 6);
});

check('every vertex sits at its own level radius, in the tangent plane', () => {
    // The arrow is drawn in the local tangent plane, so its vertices are
    // slightly FURTHER from the origin than the shell radius (they are on the
    // tangent plane, not the sphere). What must hold is that the radial
    // component is exactly the level radius.
    const levels = mkLevels();
    const out = mkOut(levels);
    columnSegments(37, -95, levels, out);
    const { up } = tangentBasis(37, -95);
    const radials = new Set();
    for (let i = 0; i < out.n; i++) {
        const p = [out.pos[i * 3], out.pos[i * 3 + 1], out.pos[i * 3 + 2]];
        radials.add(dot(p, up).toFixed(6));
    }
    for (const lv of levels) {
        assert.ok(radials.has(lv.radius.toFixed(6)),
            `no vertex at radial ${lv.radius} — level ${lv.key} detached from its shell`);
    }
});

check('arrow direction follows the wind vector', () => {
    // Pure easterly at the surface: the shaft must run along +east.
    const levels = [
        { key: 'a', radius: 1.01, u: 1, v: 0, speed01: 1, color: COL, hasData: true },
        { key: 'b', radius: 1.05, u: 0, v: 1, speed01: 1, color: COL, hasData: true },
    ];
    const out = mkOut(levels);
    columnSegments(0, 0, levels, out);
    const { east, north, up } = tangentBasis(0, 0);
    // Vertex order for 2 levels: 0,1 = the single mast segment; then level a's
    // arrow as 2=shaft tail, 3=shaft head, 4..7 = the two barbs.
    const tail = [out.pos[2 * 3], out.pos[2 * 3 + 1], out.pos[2 * 3 + 2]];
    const head = [out.pos[3 * 3], out.pos[3 * 3 + 1], out.pos[3 * 3 + 2]];
    const d = head.map((v, i) => v - tail[i]);
    assert.ok(dot(d, east) > 0, 'easterly shaft did not point east');
    assert.ok(Math.abs(dot(d, north)) < 1e-9, 'easterly shaft drifted north');
    assert.ok(Math.abs(dot(d, up)) < 1e-9, 'shaft left the tangent plane');
});

check('arrow length carries speed', () => {
    const mk = (s) => {
        const levels = [
            { key: 'a', radius: 1.01, u: 1, v: 0, speed01: s, color: COL, hasData: true },
            { key: 'b', radius: 1.05, u: 1, v: 0, speed01: s, color: COL, hasData: true },
        ];
        const out = mkOut(levels);
        columnSegments(0, 0, levels, out);
        // Shaft is vertices 2 and 3 (see the order note above) — measuring a
        // BARB instead would also scale with speed and hide a shaft bug.
        const tail = [out.pos[6],  out.pos[7],  out.pos[8]];
        const head = [out.pos[9],  out.pos[10], out.pos[11]];
        return Math.hypot(head[0] - tail[0], head[1] - tail[1], head[2] - tail[2]);
    };
    assert.ok(mk(1.0) > mk(0.2) * 1.5, 'fast arrow is not meaningfully longer');
    assert.ok(mk(0.0) > 0, 'slow-but-moving arrow must still be visible');
});

// ── 3. The site grid ─────────────────────────────────────────────────────────
check('site count respects the budget at every zoom', () => {
    for (let z = 0; z <= 1.0001; z += 0.1) {
        const { sites } = columnGrid({ focusLat: 12, focusLon: -70, zoom01: z, maxSites: 96 });
        assert.ok(sites.length > 0, `no sites at zoom ${z}`);
        assert.ok(sites.length <= 96, `${sites.length} sites at zoom ${z}`);
    }
});

check('grid is snapped, so a nudged camera does not shimmer', () => {
    // Two camera positions inside the same lattice cell must produce the
    // identical site list — otherwise the columns crawl as the user drags.
    const a = columnGrid({ focusLat: 20.0, focusLon: 40.0, zoom01: 0.5 });
    const b = columnGrid({ focusLat: 20.4, focusLon: 40.4, zoom01: 0.5 });
    assert.equal(JSON.stringify(a.sites), JSON.stringify(b.sites));
    // …and a move to the next cell must actually move them.
    const c = columnGrid({ focusLat: 20.0, focusLon: 52.0, zoom01: 0.5 });
    assert.notEqual(JSON.stringify(a.sites), JSON.stringify(c.sites));
});

check('spacing tightens with zoom and sites stay in latitude bounds', () => {
    const far  = columnGrid({ focusLat: 0, focusLon: 0, zoom01: 0 });
    const near = columnGrid({ focusLat: 0, focusLon: 0, zoom01: 1 });
    assert.ok(near.step < far.step, 'spacing did not tighten on zoom-in');
    assert.ok(near.extent < far.extent, 'cap did not shrink on zoom-in');
    for (const s of columnGrid({ focusLat: 85, focusLon: 0, zoom01: 0.3 }).sites) {
        assert.ok(Math.abs(s.lat) <= 78, `site at lat ${s.lat} past the polar clamp`);
        assert.ok(s.lon >= -180 && s.lon <= 180, `site lon ${s.lon} unwrapped`);
    }
});

console.log('──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
