#!/usr/bin/env node
/**
 * terrain-wfc.mjs — gate for js/terrain-wfc.js (the WFC terrain synthesis kernel).
 *
 * Run: node tests/terrain-wfc.mjs
 *
 * The load-bearing pins:
 *   • Determinism — same (tileset, size, priors, seed) ⇒ byte-identical grid.
 *     The renderers rebuild terrain on camera moves; a nondeterministic kernel
 *     would make the same site flicker between geologies.
 *   • Adjacency is NEVER violated — the rules encode real geologic contacts
 *     (channels emerge from chaos, swirls live on maria) and a violation means
 *     the solver, not the tileset, is broken.
 *   • Priors are honored — hard-zero excludes a class outright, and the
 *     measured-data mappings (marsClassPriors / moonClassPriors) put the right
 *     geology in the right physical regime (ice at the poles, maria where the
 *     base map is dark). This is the "accurate mapping" half of the contract.
 *   • regionGrid cell centers land at accurate great-circle coordinates and
 *     survive the antimeridian — cells are WHERE the caller samples rasters,
 *     so an offset here misregisters the entire synth layer.
 */

import assert from 'node:assert/strict';
import {
    MARS_TILESET, MOON_TILESET, validateTileset, collapse,
    marsClassPriors, moonClassPriors, hashSeed, mulberry32, regionSeed,
    destinationLatLon, localOffsetKm, regionGrid, sampleClass, classShares,
} from '../js/terrain-wfc.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed += 1; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

const tileIndex = (ts, id) => ts.tiles.findIndex(t => t.id === id);

function assertAdjacencyHolds(result) {
    const { grid, width, height, tileset } = result;
    const allow = {};
    for (const t of tileset.tiles) allow[t.id] = new Set(tileset.adjacency[t.id]);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const here = tileset.tiles[grid[y * width + x]].id;
            if (x + 1 < width) {
                const right = tileset.tiles[grid[y * width + x + 1]].id;
                assert.ok(allow[here].has(right), `adjacency violated at (${x},${y}): ${here} | ${right}`);
            }
            if (y + 1 < height) {
                const below = tileset.tiles[grid[(y + 1) * width + x]].id;
                assert.ok(allow[here].has(below), `adjacency violated at (${x},${y}): ${here} / ${below}`);
            }
        }
    }
}

// ── 1. Tilesets validate; a broken one is caught ─────────────────────────────
{
    assert.ok(validateTileset(MARS_TILESET), 'mars tileset valid');
    assert.ok(validateTileset(MOON_TILESET), 'moon tileset valid');
    assert.throws(() => validateTileset({
        body: 'broken',
        tiles: [
            { id: 'a', color: [0, 0, 0], weight: 1, reliefAmpM: 0, grain: 1 },
            { id: 'b', color: [0, 0, 0], weight: 1, reliefAmpM: 0, grain: 1 },
        ],
        adjacency: { a: ['a', 'b'], b: ['b'] },   // not symmetric
    }), /not symmetric/);
    ok('both tilesets validate; asymmetric adjacency is rejected');
}

// ── 2. Seeds are stable and honestly quantized ───────────────────────────────
{
    assert.equal(hashSeed('mars', 1, 2), hashSeed('mars', 1, 2), 'hashSeed stable');
    assert.notEqual(hashSeed('mars', 1, 2), hashSeed('moon', 1, 2), 'body changes seed');
    const r = mulberry32(42);
    const seq = [r(), r(), r()];
    const r2 = mulberry32(42);
    assert.deepEqual(seq, [r2(), r2(), r2()], 'mulberry32 deterministic');
    // Quarter-degree quantization: float jitter keeps the site's terrain.
    assert.equal(regionSeed('mars', 18.4082, 77.6873), regionSeed('mars', 18.4081, 77.6874));
    assert.notEqual(regionSeed('mars', 18.4082, 77.6873), regionSeed('mars', 20.0, 77.6873));
    ok('regionSeed: stable per site, distinct across sites');
}

// ── 3. Collapse is deterministic; seeds matter ───────────────────────────────
{
    const a = collapse({ tileset: MARS_TILESET, width: 32, height: 32, seed: 1234 });
    const b = collapse({ tileset: MARS_TILESET, width: 32, height: 32, seed: 1234 });
    assert.deepEqual(Array.from(a.grid), Array.from(b.grid), 'same seed ⇒ identical grid');
    const c = collapse({ tileset: MARS_TILESET, width: 32, height: 32, seed: 99 });
    assert.ok(Array.from(a.grid).some((v, i) => v !== c.grid[i]), 'different seed ⇒ different grid');
    ok('collapse deterministic per seed (32×32 Mars)');
}

// ── 4. Adjacency never violated, both bodies, several seeds ──────────────────
{
    for (const tileset of [MARS_TILESET, MOON_TILESET]) {
        for (const seed of [7, 1234, 987654]) {
            const result = collapse({ tileset, width: 40, height: 40, seed });
            assertAdjacencyHolds(result);
            const shares = classShares(result);
            const total = Object.values(shares).reduce((s, v) => s + v, 0);
            near(total, 1, 1e-9, `${tileset.body} shares sum to 1`);
        }
    }
    ok('adjacency rules hold across 6 runs (Mars + Moon, 40×40)');
}

// ── 5. Priors: hard constraints are respected ────────────────────────────────
{
    const T = MARS_TILESET.tiles.length;
    const W = 16;
    const ice = tileIndex(MARS_TILESET, 'ice');

    // Pin the center cell to ice; leave everything else uniform.
    const priors = new Float32Array(W * W * T).fill(1);
    const centerCell = (W / 2) * W + W / 2;
    for (let t = 0; t < T; t += 1) priors[centerCell * T + t] = t === ice ? 1 : 0;
    const pinned = collapse({ tileset: MARS_TILESET, width: W, height: W, seed: 5, priors });
    assert.equal(pinned.grid[centerCell], ice, 'hard-pinned cell collapsed to ice');
    assertAdjacencyHolds(pinned);

    // Zero a class everywhere ⇒ it never appears.
    const noIce = new Float32Array(W * W * T).fill(1);
    for (let c = 0; c < W * W; c += 1) noIce[c * T + ice] = 0;
    const iceless = collapse({ tileset: MARS_TILESET, width: W, height: W, seed: 5, priors: noIce });
    assert.ok(Array.from(iceless.grid).every(v => v !== ice), 'zeroed class never appears');
    ok('hard priors: pin honored (with legal neighbors), zero excludes');
}

// ── 6. Mars priors put geology in the right physical regime ──────────────────
{
    const argmax = (p) => p.indexOf(Math.max(...p));
    const polar = marsClassPriors({ elevationM: -2800, slopeDeg: 0.4, latDeg: 84 });
    assert.equal(MARS_TILESET.tiles[argmax(Array.from(polar))].id, 'ice', 'polar cap ⇒ ice leads');

    const northernPlain = marsClassPriors({ elevationM: -4200, slopeDeg: 0.5, latDeg: 35 });
    const leaders = Array.from(northernPlain)
        .map((w, i) => [MARS_TILESET.tiles[i].id, w])
        .sort((x, y) => y[1] - x[1])
        .slice(0, 2)
        .map(e => e[0]);
    assert.ok(leaders.includes('plains') || leaders.includes('dunes'),
        `northern lowlands favor plains/dunes (got ${leaders.join(', ')})`);

    const southernHighland = marsClassPriors({ elevationM: 1800, slopeDeg: 2.8, latDeg: -35 });
    assert.equal(MARS_TILESET.tiles[argmax(Array.from(southernHighland))].id, 'cratered',
        'steep southern highlands ⇒ cratered leads');

    const tharsis = marsClassPriors({ elevationM: 9500, slopeDeg: 1.5, latDeg: 12 });
    assert.equal(MARS_TILESET.tiles[argmax(Array.from(tharsis))].id, 'lava', 'Tharsis summit ⇒ lava');

    const iceIdx = tileIndex(MARS_TILESET, 'ice');
    assert.equal(marsClassPriors({ elevationM: 0, slopeDeg: 1, latDeg: 10 })[iceIdx], 0,
        'no equatorial surface ice');
    ok('marsClassPriors: ice@poles, plains/dunes@lowlands, cratered@highlands, lava@Tharsis');
}

// ── 7. Moon priors follow measured albedo (+ context) ────────────────────────
{
    const argmax = (p) => p.indexOf(Math.max(...p));
    const mare = moonClassPriors({ albedo: 0.24, latDeg: 8 });
    assert.equal(MOON_TILESET.tiles[argmax(Array.from(mare))].id, 'maria', 'dark base map ⇒ maria');
    const hl = moonClassPriors({ albedo: 0.72, latDeg: -40 });
    assert.equal(MOON_TILESET.tiles[argmax(Array.from(hl))].id, 'highlands', 'bright base map ⇒ highlands');

    const rimIdx = tileIndex(MOON_TILESET, 'rim');
    const atRim = moonClassPriors({ albedo: 0.5, latDeg: 0, craterDistNorm: 1.0 });
    const farField = moonClassPriors({ albedo: 0.5, latDeg: 0, craterDistNorm: 6 });
    assert.ok(atRim[rimIdx] > farField[rimIdx] * 5, 'rim class peaks on the crater rim');

    const swirlIdx = tileIndex(MOON_TILESET, 'swirl');
    const reiner = moonClassPriors({ albedo: 0.3, latDeg: 7.4, swirlBoost: 1 });
    const quiet = moonClassPriors({ albedo: 0.3, latDeg: 7.4 });
    assert.ok(reiner[swirlIdx] > quiet[swirlIdx] * 10, 'swirlBoost raises swirl weight');
    const brightSwirl = moonClassPriors({ albedo: 0.8, latDeg: 7.4, swirlBoost: 1 });
    assert.ok(brightSwirl[swirlIdx] < reiner[swirlIdx] * 0.2,
        'swirls only live on dark maria, boost or not');
    ok('moonClassPriors: albedo splits maria/highlands; rim band + swirl context work');
}

// ── 8. regionGrid: accurate coordinates, correct row order ───────────────────
{
    const MARS_R_KM = 3396.19;
    const jezero = { lat: 18.4082, lon: 77.6873 };
    const g = regionGrid({
        centerLatDeg: jezero.lat, centerLonDeg: jezero.lon,
        extentKm: 520, cells: 40, radiusKm: MARS_R_KM,
    });
    near(g.spacingKm, 13, 1e-9, 'cell spacing = extent/cells');

    // The 4 central cells straddle the site center symmetrically.
    const mid = (40 / 2 - 1) * 40 + (40 / 2 - 1);
    const lat4 = [g.latDeg[mid], g.latDeg[mid + 1], g.latDeg[mid + 40], g.latDeg[mid + 41]];
    const lon4 = [g.lonDeg[mid], g.lonDeg[mid + 1], g.lonDeg[mid + 40], g.lonDeg[mid + 41]];
    near(lat4.reduce((s, v) => s + v, 0) / 4, jezero.lat, 0.02, 'central cells average to site lat');
    near(lon4.reduce((s, v) => s + v, 0) / 4, jezero.lon, 0.02, 'central cells average to site lon');

    // Row 0 is the NORTH edge (canvas y-down convention).
    assert.ok(g.latDeg[0] > g.latDeg[39 * 40], 'row 0 sits north of the last row');

    // Adjacent cells sit one great-circle step apart.
    const p0 = { lat: g.latDeg[mid], lon: g.lonDeg[mid] };
    const p1 = destinationLatLon(p0.lat, p0.lon, g.spacingKm, 0, MARS_R_KM);
    near(p1.lonDeg, g.lonDeg[mid + 1], 0.02, 'eastward neighbor ≈ one spacing step east');
    ok('regionGrid: Jezero cells at accurate great-circle coordinates');
}

// ── 8b. localOffsetKm is the exact inverse of destinationLatLon ──────────────
{
    const R = 1737.4;
    for (const [east, north] of [[120, -80], [-300, 45], [0.5, 0.5], [-140, -140]]) {
        const p = destinationLatLon(7.4, -59.1, east, north, R);   // Reiner Gamma
        const back = localOffsetKm(7.4, -59.1, p.latDeg, p.lonDeg, R);
        near(back.eastKm, east, 0.05, `east roundtrip (${east},${north})`);
        near(back.northKm, north, 0.05, `north roundtrip (${east},${north})`);
    }
    ok('localOffsetKm inverts destinationLatLon (graticule ↔ cell layout agree)');
}

// ── 9. Antimeridian: grid stays normalized and continuous ────────────────────
{
    const g = regionGrid({ centerLatDeg: -5.9, centerLonDeg: 179.4, extentKm: 400, cells: 24, radiusKm: 1737.4 });
    for (let i = 0; i < g.lonDeg.length; i += 1) {
        assert.ok(g.lonDeg[i] > -180.0001 && g.lonDeg[i] <= 180.0001, 'lon normalized');
        assert.ok(Number.isFinite(g.latDeg[i]), 'lat finite');
    }
    // Continuity along a row: wrapped deltas stay near one cell spacing.
    for (let col = 1; col < 24; col += 1) {
        let d = g.lonDeg[col] - g.lonDeg[col - 1];
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        assert.ok(Math.abs(d) < 2, `row-0 lon step wraps cleanly (got ${d})`);
    }
    ok('antimeridian: Daedalus-centered grid wraps without a seam');
}

// ── 10. Full pipeline: priors from a synthetic raster → collapse → sample ────
{
    const MARS_R_KM = 3396.19;
    const cells = 40;
    const g = regionGrid({ centerLatDeg: 84, centerLonDeg: 0, extentKm: 600, cells, radiusKm: MARS_R_KM });
    const T = MARS_TILESET.tiles.length;
    const priors = new Float32Array(cells * cells * T);
    for (let c = 0; c < cells * cells; c += 1) {
        // Synthetic polar site: cap in the north half, plains in the south.
        const elevationM = g.latDeg[c] > 84 ? -2500 : -3800;
        const p = marsClassPriors({ elevationM, slopeDeg: 0.6, latDeg: g.latDeg[c] });
        priors.set(p, c * T);
    }
    const result = collapse({
        tileset: MARS_TILESET, width: cells, height: cells,
        seed: regionSeed('mars', 84, 0), priors,
    });
    assertAdjacencyHolds(result);
    const shares = classShares(result);
    assert.ok(shares.ice > 0.15, `polar site grows a cap (ice share ${shares.ice.toFixed(2)})`);
    assert.ok(shares.chaos < 0.05, 'no chaos terrain at a flat polar site');

    const sampled = sampleClass(result, 0.5, 0.1);   // northern interior
    assert.ok(sampled.color.every(v => v >= 0 && v <= 1), 'sampled color in range');
    assert.ok(sampled.tile.id.length > 0, 'dominant tile reported');
    assert.ok(Number.isFinite(sampled.reliefAmpM) && sampled.reliefAmpM >= 0, 'relief budget finite');
    ok(`pipeline: polar Mars synth — ice ${Math.round(shares.ice * 100)}%, adjacency clean, sampling sane`);
}

// ── 11. Restarts stay bounded at production sizes ────────────────────────────
{
    const t0 = process.hrtime.bigint();
    const runs = [
        collapse({ tileset: MARS_TILESET, width: 48, height: 48, seed: 2026 }),
        collapse({ tileset: MOON_TILESET, width: 48, height: 48, seed: 2026 }),
    ];
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    for (const r of runs) assert.ok(r.restarts <= 3, `restarts bounded (${r.restarts})`);
    assert.ok(ms < 5000, `48×48 pair solves fast enough (${ms.toFixed(0)} ms)`);
    ok(`production size: two 48×48 solves in ${ms.toFixed(0)} ms, ≤3 restarts`);
}

console.log(`\nterrain-wfc: ${passed} groups passed`);
