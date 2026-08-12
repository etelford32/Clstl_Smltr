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
 *   • Adjacency is NEVER violated — checked against an INDEPENDENT oracle
 *     re-implemented here from the declarative tileset fields (base adjacency
 *     lists, family ports, backgrounds), so a solver bug and an oracle bug
 *     would have to agree to slip through.
 *   • LINEAR classes grow as lines — the directional port rules make chains
 *     emergent: no isolated single cells, mean chain length well above
 *     speckle, and every chain stays one cell wide (no 2×2 family block).
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
    MARS_TILESET, MOON_TILESET, buildTileset, validateTileset, collapse,
    marsClassPriors, moonClassPriors, expandClassPriors, expandClassPriorsFlow,
    slopeField, flowAccumulation, marsChannelRouting, hashSeed, mulberry32, regionSeed,
    destinationLatLon, localOffsetKm, regionGrid, sampleClass, classShares,
} from '../js/terrain-wfc.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed += 1; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

const classIndex = (ts, id) => ts.classes.findIndex(c => c.id === id);

// ── Independent adjacency oracle ─────────────────────────────────────────────
// Re-derives tile compatibility from the DECLARATIVE tileset fields, without
// touching the kernel's compiled masks or tilesCompatible(). Port bits are the
// documented convention: N=1, E=2, S=4, W=8; dir 0..3 = N,E,S,W; opposite is
// (d+2)%4 with the matching bit.
const PORT_BIT = [1, 2, 4, 8];
const OPP = [2, 3, 0, 1];
function oracleCompatible(ts, a, dir, b) {
    const ta = ts.tiles[a];
    const tb = ts.tiles[b];
    const aFam = ta.kind >= 0;
    const bFam = tb.kind >= 0;
    if (!aFam && !bFam) return ts.baseAdjacency[ta.classId].includes(tb.classId);
    const aOpen = aFam && (ta.ports & PORT_BIT[dir]) !== 0;
    const bOpen = bFam && (tb.ports & PORT_BIT[OPP[dir]]) !== 0;
    if (aFam && bFam) {
        if (ta.classId !== tb.classId) return false;
        if (aOpen && bOpen) return !(ta.kind === 1 && tb.kind === 1);   // no bend↔bend
        return false;
    }
    if (aFam) return !aOpen && ts.families[ta.classId].background.includes(tb.classId);
    return !bOpen && ts.families[tb.classId].background.includes(ta.classId);
}

function assertAdjacencyHolds(result) {
    const { grid, width, height, tileset } = result;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const here = grid[y * width + x];
            if (x + 1 < width) {
                const east = grid[y * width + x + 1];
                assert.ok(oracleCompatible(tileset, here, 1, east),
                    `adjacency violated at (${x},${y}): ${tileset.tiles[here].id} |E| ${tileset.tiles[east].id}`);
            }
            if (y + 1 < height) {
                const south = grid[(y + 1) * width + x];
                assert.ok(oracleCompatible(tileset, here, 2, south),
                    `adjacency violated at (${x},${y}): ${tileset.tiles[here].id} |S| ${tileset.tiles[south].id}`);
            }
        }
    }
}

/** Connected components (4-neighborhood) of one class's cells. */
function classChains(result, classId) {
    const { grid, width, height, tileset } = result;
    const ci = classIndex(tileset, classId);
    const inClass = (c) => tileset.classOfTile[grid[c]] === ci;
    const seen = new Uint8Array(width * height);
    const chains = [];
    for (let start = 0; start < width * height; start += 1) {
        if (seen[start] || !inClass(start)) continue;
        const stack = [start];
        seen[start] = 1;
        let size = 0;
        let touchesBorder = false;
        while (stack.length) {
            const c = stack.pop();
            size += 1;
            const x = c % width;
            const y = (c - x) / width;
            if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
            for (const nb of [
                y > 0 ? c - width : -1, y < height - 1 ? c + width : -1,
                x > 0 ? c - 1 : -1, x < width - 1 ? c + 1 : -1,
            ]) {
                if (nb >= 0 && !seen[nb] && inClass(nb)) { seen[nb] = 1; stack.push(nb); }
            }
        }
        chains.push({ size, touchesBorder });
    }
    return chains;
}

/** Any 2×2 block entirely of one family class? (lines must stay thin) */
function hasFatBlock(result, classId) {
    const { grid, width, height, tileset } = result;
    const ci = classIndex(tileset, classId);
    const isC = (c) => tileset.classOfTile[grid[c]] === ci;
    for (let y = 0; y + 1 < height; y += 1) {
        for (let x = 0; x + 1 < width; x += 1) {
            const c = y * width + x;
            if (isC(c) && isC(c + 1) && isC(c + width) && isC(c + width + 1)) return true;
        }
    }
    return false;
}

/** Per-class uniform priors helper (per-tile array from a class vector). */
function uniformClassPriors(tileset, cells, override = {}) {
    const priors = new Float32Array(cells * tileset.tiles.length);
    const vec = new Float32Array(tileset.classes.length).fill(1);
    for (const [id, v] of Object.entries(override)) vec[classIndex(tileset, id)] = v;
    for (let c = 0; c < cells; c += 1) expandClassPriors(tileset, vec, priors, c);
    return priors;
}

// ── 1. Tilesets validate; a broken build is caught ───────────────────────────
{
    assert.ok(validateTileset(MARS_TILESET), 'mars tileset valid');
    assert.ok(validateTileset(MOON_TILESET), 'moon tileset valid');
    assert.equal(MARS_TILESET.tiles.length, 6 + 10, 'mars: 6 base + channel family');
    assert.equal(MOON_TILESET.tiles.length, 5 + 20, 'moon: 5 base + rille + wrinkle families');
    assert.throws(() => buildTileset({
        body: 'broken',
        classes: [
            { id: 'a', label: 'A', color: [0, 0, 0], reliefAmpM: 0, grain: 1 },
            { id: 'b', label: 'B', color: [0, 0, 0], reliefAmpM: 0, grain: 1 },
        ],
        base: { a: { weight: 1, adj: ['a', 'b'] }, b: { weight: 1, adj: ['b'] } },   // not symmetric
        families: {},
    }), /not symmetric/);
    ok('both tilesets validate (16 + 25 tiles); asymmetric base adjacency rejected');
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

// ── 4. Adjacency never violated (independent oracle), both bodies ────────────
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
    ok('oracle adjacency holds across 6 runs (Mars + Moon, 40×40, incl. port rules)');
}

// ── 5. LINES: rilles and ridges grow as thin connected chains ────────────────
{
    // Mare-floor conditions everywhere: dark albedo, no crater context.
    const cells = 48;
    const priors = new Float32Array(cells * cells * MOON_TILESET.tiles.length);
    const vec = moonClassPriors({ albedo: 0.25, latDeg: 20 });
    for (let c = 0; c < cells * cells; c += 1) expandClassPriors(MOON_TILESET, vec, priors, c);
    for (const seed of [11, 2026, 777]) {
        const result = collapse({ tileset: MOON_TILESET, width: cells, height: cells, seed, priors });
        assertAdjacencyHolds(result);
        for (const classId of ['rille', 'wrinkle']) {
            const chains = classChains(result, classId);
            const cellsOfClass = chains.reduce((s, v) => s + v.size, 0);
            assert.ok(cellsOfClass > 0, `${classId} exists on a mare floor (seed ${seed})`);
            // Port matching makes an isolated INTERIOR cell illegal: an
            // end-cap's open port demands a family neighbor, so minimum chain
            // is 2 — except at the map border, where a 1-cell chain is a line
            // arriving from beyond the window (its open port hangs off-map).
            assert.equal(chains.filter(ch => ch.size === 1 && !ch.touchesBorder).length, 0,
                `${classId}: no interior single-cell speckle (seed ${seed})`);
            const mean = cellsOfClass / chains.length;
            assert.ok(mean >= 3, `${classId}: mean chain ≥ 3 cells (got ${mean.toFixed(2)}, seed ${seed})`);
            assert.ok(!hasFatBlock(result, classId), `${classId}: no 2×2 block — lines stay thin (seed ${seed})`);
            const share = cellsOfClass / (cells * cells);
            assert.ok(share > 0.005 && share < 0.30,
                `${classId}: share in honest band (${(share * 100).toFixed(1)}%)`);
        }
    }
    ok('moon linear classes: connected thin chains, no speckle, mean length ≥ 3 (3 seeds)');
}

// ── 5b. Mars channels are linear too ─────────────────────────────────────────
{
    const cells = 48;
    const priors = new Float32Array(cells * cells * MARS_TILESET.tiles.length);
    // Steep lowland — channel country (Chryse/Ares Vallis conditions).
    const vec = marsClassPriors({ elevationM: -3200, slopeDeg: 2.4, latDeg: 12 });
    for (let c = 0; c < cells * cells; c += 1) expandClassPriors(MARS_TILESET, vec, priors, c);
    const result = collapse({ tileset: MARS_TILESET, width: cells, height: cells, seed: 40, priors });
    assertAdjacencyHolds(result);
    const chains = classChains(result, 'channel');
    assert.ok(chains.length > 0, 'channels exist in channel country');
    assert.equal(chains.filter(ch => ch.size === 1 && !ch.touchesBorder).length, 0,
        'no interior single-cell channels');
    assert.ok(chains.reduce((s, v) => s + v.size, 0) / chains.length >= 3, 'channel chains ≥ 3 cells mean');
    assert.ok(!hasFatBlock(result, 'channel'), 'channels stay one cell wide');
    ok('mars channels: thin connected chains in outflow country');
}

// ── 5c. Flow-aware priors: channels run down the real slopes ─────────────────
{
    const smoothstep = (a, b, v) => {
        const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
        return t * t * (3 - 2 * t);
    };
    const tileIdx = (id) => MARS_TILESET.tiles.findIndex(t => t.id === id);
    const NS = tileIdx('channel:ns');
    const EW = tileIdx('channel:ew');

    // Unit behavior: a pure north-south axis boosts NS segments, starves EW
    // ones (floored, never zero), leaves bends neutral; zero strength is
    // byte-identical to the flow-blind expansion.
    const T = MARS_TILESET.tiles.length;
    const vec = marsClassPriors({ elevationM: -3000, slopeDeg: 2.5, latDeg: 10 });
    const plain = new Float32Array(T);
    const flowed = new Float32Array(T);
    expandClassPriors(MARS_TILESET, vec, plain, 0);
    expandClassPriorsFlow(MARS_TILESET, vec, flowed, 0,
        { channel: { axisEast: 0, axisNorth: 1, strength: 0.85 } });
    assert.ok(flowed[NS] > plain[NS] * 1.5, 'NS axis boosts NS segments');
    assert.ok(flowed[EW] < plain[EW] * 0.3 && flowed[EW] > 0, 'EW segments starved but never zeroed');
    // On a cardinal axis a bend sits BETWEEN the two segments (0.71 score):
    // above the starved cross-segment, below the aligned one — and on a
    // DIAGONAL axis the bend must WIN, or the chain has no way to track it.
    const bend = tileIdx('channel:ne');
    assert.ok(flowed[bend] > flowed[EW] && flowed[bend] < flowed[NS],
        'cardinal axis: bend between the two segments');
    const diag = new Float32Array(T);
    expandClassPriorsFlow(MARS_TILESET, vec, diag, 0,
        { channel: { axisEast: 1, axisNorth: 1, strength: 0.85 } });
    assert.ok(diag[bend] > diag[NS] && diag[bend] > diag[EW],
        'diagonal axis: bends beat both segments (zigzag tracks the diagonal)');
    const zeroStrength = new Float32Array(T);
    expandClassPriorsFlow(MARS_TILESET, vec, zeroStrength, 0,
        { channel: { axisEast: 0, axisNorth: 1, strength: 0 } });
    assert.deepEqual(Array.from(zeroStrength), Array.from(plain), 'strength 0 ⇒ flow-blind');

    // Shared harness: synthetic terrain → slopeField → priors+flow → collapse.
    const cells = 48;
    const extentKm = 120;
    const stepM = extentKm / cells * 1000;
    const localKm = (idx) => ({
        eastKm: ((idx % cells + 0.5) / cells - 0.5) * extentKm,
        northKm: (0.5 - (Math.floor(idx / cells) + 0.5) / cells) * extentKm,
    });
    const synthOn = (elevFn, seed) => {
        const elev = new Float32Array(cells * cells);
        for (let i = 0; i < cells * cells; i += 1) {
            const { eastKm, northKm } = localKm(i);
            elev[i] = elevFn(eastKm, northKm);
        }
        const field = slopeField(elev, cells, stepM);
        const drain = flowAccumulation(elev, cells, stepM);
        const priors = new Float32Array(cells * cells * T);
        for (let i = 0; i < cells * cells; i += 1) {
            // THE page recipe, via the shared kernel helper: routed axis,
            // slope-or-accumulation strength, convergence-thresholded
            // drainage for the prior.
            const routing = marsChannelRouting(field, drain, i, cells);
            const v = marsClassPriors({
                elevationM: elev[i], slopeDeg: field.wallSlopeDeg[i], latDeg: 12,
                drainage: routing.drainageNorm,
            });
            expandClassPriorsFlow(MARS_TILESET, v, priors, i, {
                channel: { axisEast: routing.axisEast, axisNorth: routing.axisNorth, strength: routing.strength },
            });
        }
        return collapse({ tileset: MARS_TILESET, width: cells, height: cells, seed, priors });
    };
    const segCounts = (result) => {
        let ns = 0;
        let ew = 0;
        for (const t of result.grid) {
            if (t === NS) ns += 1;
            else if (t === EW) ew += 1;
        }
        return { ns, ew };
    };

    // Tilted plane falling north (40 m/km ≈ 2.3°): fall line is N-S, so NS
    // segments must dominate; the orthogonal tilt flips the answer.
    const northTilt = synthOn((e, n) => -2500 - n * 40, 21);
    const nsTilt = segCounts(northTilt);
    assert.ok(nsTilt.ns >= 3 * Math.max(1, nsTilt.ew),
        `N-S fall line ⇒ NS segments dominate (ns ${nsTilt.ns}, ew ${nsTilt.ew})`);
    const eastTilt = synthOn((e, n) => -2500 - e * 40, 21);
    const ewTilt = segCounts(eastTilt);
    assert.ok(ewTilt.ew >= 3 * Math.max(1, ewTilt.ns),
        `E-W fall line ⇒ EW segments dominate (ns ${ewTilt.ns}, ew ${ewTilt.ew})`);

    // V-valley running east-west (45 m/km walls, gentle 6 m/km fall east along
    // the floor). The honest LOCAL-physics claim: on the walls the fall line
    // runs DOWN THE WALL into the valley, so wall channels are north-south
    // tributaries — that IS "channels run down the real slopes". (A trunk
    // channel along the flat floor needs drainage ACCUMULATION, not local
    // slope — deliberately out of scope; the floor rows are excluded here.)
    const valley = synthOn((e, n) => -3000 + Math.abs(n) * 45 - e * 6, 33);
    assertAdjacencyHolds(valley);
    let wallNs = 0;
    let wallEw = 0;
    for (let i = 0; i < cells * cells; i += 1) {
        if (Math.abs(localKm(i).northKm) < extentKm * 0.06) continue;   // skip the floor band
        if (valley.grid[i] === NS) wallNs += 1;
        else if (valley.grid[i] === EW) wallEw += 1;
    }
    assert.ok(wallNs + wallEw > 0, 'valley walls grow channels at all');
    assert.ok(wallNs >= 2 * Math.max(1, wallEw),
        `wall channels dive down-slope into the valley (ns ${wallNs}, ew ${wallEw})`);
    ok(`flow priors: fall-line alignment (${nsTilt.ns}:${nsTilt.ew} NS-tilt, ${ewTilt.ns}:${ewTilt.ew} EW-tilt), valley walls ${wallNs}:${wallEw} down-slope`);
}

// ── 5d. Drainage accumulation: pits fill, area is conserved, trunks form ─────
{
    const cells = 48;
    const extentKm = 120;
    const stepM = extentKm / cells * 1000;
    const localKm = (idx) => ({
        eastKm: ((idx % cells + 0.5) / cells - 0.5) * extentKm,
        northKm: (0.5 - (Math.floor(idx / cells) + 0.5) / cells) * extentKm,
    });
    const buildElev = (fn) => {
        const elev = new Float32Array(cells * cells);
        for (let i = 0; i < cells * cells; i += 1) {
            const { eastKm, northKm } = localKm(i);
            elev[i] = fn(eastKm, northKm);
        }
        return elev;
    };
    const exitSum = (drain) => {
        let sum = 0;
        for (let i = 0; i < cells * cells; i += 1) {
            if (drain.downstream[i] < 0) sum += drain.accumulation[i];
        }
        return sum;
    };
    const assertNoCycles = (drain) => {
        for (let start = 0; start < cells * cells; start += 1) {
            let c = start;
            let steps = 0;
            while (drain.downstream[c] >= 0) {
                c = drain.downstream[c];
                steps += 1;
                assert.ok(steps <= cells * cells, `drainage cycle from cell ${start}`);
            }
        }
    };

    // Plane falling south: D8 runs straight down-column, so accumulation at
    // row r is exactly r+1 — and every unit of area exits once.
    const plane = flowAccumulation(buildElev((e, n) => -2500 + n * 40), cells, stepM);
    for (const col of [0, 17, 47]) {
        for (const row of [0, 5, 30, 47]) {
            near(plane.accumulation[row * cells + col], row + 1, 1e-6,
                `plane accumulation grows down-column (row ${row}, col ${col})`);
        }
    }
    assertNoCycles(plane);
    near(exitSum(plane), cells * cells, 1e-3, 'plane: all area exits exactly once');

    // Closed bowl punched into the same plane: priority-flood must fill it so
    // the interior still drains to the border — no stalls, no cycles, same
    // conservation invariant.
    const bowl = flowAccumulation(buildElev((e, n) =>
        -2500 + n * 40 + 900 * Math.exp(-((e + 10) ** 2 + (n - 8) ** 2) / 180) * -1), cells, stepM);
    assertNoCycles(bowl);
    near(exitSum(bowl), cells * cells, 1e-3, 'bowl: depression fills and drains');

    // Routed directions are unit vectors (or zero at map exits).
    for (let i = 0; i < cells * cells; i += 1) {
        const len = Math.hypot(plane.dirEast[i], plane.dirNorth[i]);
        assert.ok(len < 1e-9 || Math.abs(len - 1) < 1e-6, 'routed dir is unit or zero');
    }

    // Convergence thresholds: a plane's parallel drainage must NOT read as
    // channel trunk (max accumulation ≈ cells sits below the cells·1..4 ramp).
    const field = slopeField(buildElev((e, n) => -2500 + n * 40), cells, stepM);
    let maxNorm = 0;
    for (let i = 0; i < cells * cells; i += 1) {
        maxNorm = Math.max(maxNorm, marsChannelRouting(field, plane, i, cells).drainageNorm);
    }
    near(maxNorm, 0, 1e-9, 'parallel plane drainage scores zero trunk-ness');
    ok('flowAccumulation: exact plane growth, pit filling, conservation, convergence gating');
}

// ── 5e. The payoff: a trunk channel runs along the flat valley floor ─────────
{
    // Same shared harness as 5c (full routing recipe). V-valley running
    // east-west with a gentle eastward floor tilt: the walls converge ~24
    // cells of upstream area per column into the floor, so accumulation
    // crosses the convergence threshold almost immediately and a TRUNK forms
    // along ground that is nearly flat — the thing local slope alone could
    // not do (5c only pinned the wall tributaries).
    const cells = 48;
    const extentKm = 120;
    const NS = MARS_TILESET.tiles.findIndex(t => t.id === 'channel:ns');
    const EW = MARS_TILESET.tiles.findIndex(t => t.id === 'channel:ew');
    const channelClass = classIndex(MARS_TILESET, 'channel');
    const localKm = (idx) => ({
        eastKm: ((idx % cells + 0.5) / cells - 0.5) * extentKm,
        northKm: (0.5 - (Math.floor(idx / cells) + 0.5) / cells) * extentKm,
    });
    // Rebuild the 5c harness inline (kept separate so 5c's pins stay exactly
    // as they were when this group is edited).
    const T = MARS_TILESET.tiles.length;
    const stepM = extentKm / cells * 1000;
    const elev = new Float32Array(cells * cells);
    for (let i = 0; i < cells * cells; i += 1) {
        const { eastKm, northKm } = localKm(i);
        elev[i] = -3000 + Math.abs(northKm) * 45 - eastKm * 6;
    }
    const field = slopeField(elev, cells, stepM);
    const drain = flowAccumulation(elev, cells, stepM);
    const priors = new Float32Array(cells * cells * T);
    for (let i = 0; i < cells * cells; i += 1) {
        const routing = marsChannelRouting(field, drain, i, cells);
        const v = marsClassPriors({
            elevationM: elev[i], slopeDeg: field.wallSlopeDeg[i], latDeg: 12,
            drainage: routing.drainageNorm,
        });
        expandClassPriorsFlow(MARS_TILESET, v, priors, i, {
            channel: { axisEast: routing.axisEast, axisNorth: routing.axisNorth, strength: routing.strength },
        });
    }
    const valley = collapse({ tileset: MARS_TILESET, width: cells, height: cells, seed: 33, priors });
    assertAdjacencyHolds(valley);

    // Floor band: |north| ≤ 2 km — the two TRUE floor rows only. One row
    // further out is already wall (169 m up at 45 m/km), whose legitimate
    // NS tributaries would pollute the trunk-orientation count.
    let floorChannels = 0;
    let floorEw = 0;
    let floorNs = 0;
    for (let i = 0; i < cells * cells; i += 1) {
        if (Math.abs(localKm(i).northKm) > 2) continue;
        if (MARS_TILESET.classOfTile[valley.grid[i]] !== channelClass) continue;
        floorChannels += 1;
        if (valley.grid[i] === EW) floorEw += 1;
        else if (valley.grid[i] === NS) floorNs += 1;
    }
    assert.ok(floorChannels >= 20, `trunk occupies the floor (${floorChannels} channel cells in band)`);
    assert.ok(floorEw >= 2 * Math.max(1, floorNs),
        `trunk runs ALONG the flat floor (ew ${floorEw}, ns ${floorNs})`);

    // The trunk is one connected chain of respectable length, not fragments:
    // largest channel component touching the floor band.
    const seen = new Uint8Array(cells * cells);
    let largestFloorChain = 0;
    for (let start = 0; start < cells * cells; start += 1) {
        if (seen[start] || MARS_TILESET.classOfTile[valley.grid[start]] !== channelClass) continue;
        const stack = [start];
        seen[start] = 1;
        let size = 0;
        let touchesFloor = false;
        while (stack.length) {
            const c = stack.pop();
            size += 1;
            if (Math.abs(localKm(c).northKm) <= 2) touchesFloor = true;
            const x = c % cells;
            const y = (c - x) / cells;
            for (const nb of [
                y > 0 ? c - cells : -1, y < cells - 1 ? c + cells : -1,
                x > 0 ? c - 1 : -1, x < cells - 1 ? c + 1 : -1,
            ]) {
                if (nb >= 0 && !seen[nb]
                    && MARS_TILESET.classOfTile[valley.grid[nb]] === channelClass) {
                    seen[nb] = 1;
                    stack.push(nb);
                }
            }
        }
        if (touchesFloor) largestFloorChain = Math.max(largestFloorChain, size);
    }
    assert.ok(largestFloorChain >= 15,
        `the trunk is a connected chain (largest floor component ${largestFloorChain} cells)`);
    ok(`drainage trunk: ${floorChannels} floor channel cells (${floorEw}:${floorNs} along:across), largest chain ${largestFloorChain}`);
}

// ── 6. Priors: hard constraints are respected ────────────────────────────────
{
    const W = 16;
    const priors = uniformClassPriors(MARS_TILESET, W * W);
    // Pin the center cell to ice (a base class, one tile).
    const iceTile = MARS_TILESET.tiles.findIndex(t => t.id === 'ice');
    const T = MARS_TILESET.tiles.length;
    const centerCell = (W / 2) * W + W / 2;
    for (let t = 0; t < T; t += 1) priors[centerCell * T + t] = t === iceTile ? 1 : 0;
    const pinned = collapse({ tileset: MARS_TILESET, width: W, height: W, seed: 5, priors });
    assert.equal(pinned.grid[centerCell], iceTile, 'hard-pinned cell collapsed to ice');
    assertAdjacencyHolds(pinned);

    // Zero a CLASS everywhere ⇒ it never appears (all its variants excluded).
    const noChannel = uniformClassPriors(MARS_TILESET, W * W, { channel: 0 });
    const dry = collapse({ tileset: MARS_TILESET, width: W, height: W, seed: 5, priors: noChannel });
    assert.equal(classShares(dry).channel, 0, 'zeroed class never appears');
    ok('hard priors: pin honored (with legal neighbors), class-zero excludes every variant');
}

// ── 7. Mars priors put geology in the right physical regime ──────────────────
{
    const argmax = (p) => p.indexOf(Math.max(...p));
    const id = (i) => MARS_TILESET.classes[i].id;
    const polar = marsClassPriors({ elevationM: -2800, slopeDeg: 0.4, latDeg: 84 });
    assert.equal(id(argmax(Array.from(polar))), 'ice', 'polar cap ⇒ ice leads');

    const northernPlain = marsClassPriors({ elevationM: -4200, slopeDeg: 0.5, latDeg: 35 });
    const leaders = Array.from(northernPlain)
        .map((w, i) => [id(i), w])
        .sort((x, y) => y[1] - x[1])
        .slice(0, 2)
        .map(e => e[0]);
    assert.ok(leaders.includes('plains') || leaders.includes('dunes'),
        `northern lowlands favor plains/dunes (got ${leaders.join(', ')})`);

    const southernHighland = marsClassPriors({ elevationM: 1800, slopeDeg: 2.8, latDeg: -35 });
    assert.equal(id(argmax(Array.from(southernHighland))), 'cratered',
        'steep southern highlands ⇒ cratered leads');

    const tharsis = marsClassPriors({ elevationM: 9500, slopeDeg: 1.5, latDeg: 12 });
    assert.equal(id(argmax(Array.from(tharsis))), 'lava', 'Tharsis summit ⇒ lava');

    const iceIdx = classIndex(MARS_TILESET, 'ice');
    assert.equal(marsClassPriors({ elevationM: 0, slopeDeg: 1, latDeg: 10 })[iceIdx], 0,
        'no equatorial surface ice');
    ok('marsClassPriors: ice@poles, plains/dunes@lowlands, cratered@highlands, lava@Tharsis');
}

// ── 8. Moon priors follow measured albedo (+ context) ────────────────────────
{
    const argmax = (p) => p.indexOf(Math.max(...p));
    const id = (i) => MOON_TILESET.classes[i].id;
    const mare = moonClassPriors({ albedo: 0.24, latDeg: 8 });
    assert.equal(id(argmax(Array.from(mare))), 'maria', 'dark base map ⇒ maria');
    const hl = moonClassPriors({ albedo: 0.72, latDeg: -40 });
    assert.equal(id(argmax(Array.from(hl))), 'highlands', 'bright base map ⇒ highlands');

    const rimIdx = classIndex(MOON_TILESET, 'rim');
    const atRim = moonClassPriors({ albedo: 0.5, latDeg: 0, craterDistNorm: 1.0 });
    const farField = moonClassPriors({ albedo: 0.5, latDeg: 0, craterDistNorm: 6 });
    assert.ok(atRim[rimIdx] > farField[rimIdx] * 5, 'rim class peaks on the crater rim');

    const swirlIdx = classIndex(MOON_TILESET, 'swirl');
    const reiner = moonClassPriors({ albedo: 0.3, latDeg: 7.4, swirlBoost: 1 });
    const quiet = moonClassPriors({ albedo: 0.3, latDeg: 7.4 });
    assert.ok(reiner[swirlIdx] > quiet[swirlIdx] * 10, 'swirlBoost raises swirl weight');
    const brightSwirl = moonClassPriors({ albedo: 0.8, latDeg: 7.4, swirlBoost: 1 });
    assert.ok(brightSwirl[swirlIdx] < reiner[swirlIdx] * 0.2,
        'swirls only live on dark maria, boost or not');
    ok('moonClassPriors: albedo splits maria/highlands; rim band + swirl context work');
}

// ── 9. regionGrid: accurate coordinates, correct row order ───────────────────
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

// ── 9b. localOffsetKm is the exact inverse of destinationLatLon ──────────────
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

// ── 10. Antimeridian: grid stays normalized and continuous ───────────────────
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

// ── 11. Full pipeline: priors from a synthetic raster → collapse → sample ────
{
    const MARS_R_KM = 3396.19;
    const cells = 40;
    const g = regionGrid({ centerLatDeg: 84, centerLonDeg: 0, extentKm: 600, cells, radiusKm: MARS_R_KM });
    const priors = new Float32Array(cells * cells * MARS_TILESET.tiles.length);
    for (let c = 0; c < cells * cells; c += 1) {
        // Synthetic polar site: cap in the north half, plains in the south.
        const elevationM = g.latDeg[c] > 84 ? -2500 : -3800;
        const vec = marsClassPriors({ elevationM, slopeDeg: 0.6, latDeg: g.latDeg[c] });
        expandClassPriors(MARS_TILESET, vec, priors, c);
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

// ── 12. Restarts stay bounded at production sizes ────────────────────────────
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
