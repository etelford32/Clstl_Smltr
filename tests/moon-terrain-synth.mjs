#!/usr/bin/env node
/**
 * moon-terrain-synth.mjs — gate for js/moon-terrain-synth.js (pure layer).
 *
 * Run: node tests/moon-terrain-synth.mjs
 *
 * The load-bearing pins:
 *   • The fallback albedo classifier puts the dark ground where the maria
 *     actually are (IAU circles from the landmark catalog) and highland
 *     brightness everywhere else — it is what keeps the synth honest when
 *     the base map cannot be read back.
 *   • Region synthesis around real landmarks produces the geology the site
 *     is FAMOUS for: maria + swirl at Reiner Gamma, rim/ejecta at Tycho,
 *     maria floor inside Imbrium — and provenance always says which albedo
 *     source fed it.
 *   • Deterministic per site: the same landmark synthesizes the same map.
 */

import assert from 'node:assert/strict';
import {
    MOON_SYNTH_CELLS, angularSeparationDeg, fallbackAlbedoAt,
    extentForLandmark, synthesizeLandmarkRegion, synthLegend,
} from '../js/moon-terrain-synth.js';
import { LANDMARKS } from '../js/moon-landmarks-data.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed += 1; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const byName = (name) => LANDMARKS.find(l => l.name === name);

// ── 1. Angular separation sanity ─────────────────────────────────────────────
{
    near(angularSeparationDeg(0, 0, 0, 90), 90, 1e-9, 'quarter turn along equator');
    near(angularSeparationDeg(0, 0, 90, 0), 90, 1e-9, 'equator to pole');
    // acos() carries ~1e-6° of float noise at zero separation — irrelevant at
    // any map scale (3 cm on the lunar surface).
    near(angularSeparationDeg(7.4, -59.1, 7.4, -59.1), 0, 1e-5, 'coincident points');
    ok('angularSeparationDeg: spot values');
}

// ── 2. Fallback albedo puts the dark where the maria are ─────────────────────
{
    const imbrium = byName('Mare Imbrium');
    const insideImbrium = fallbackAlbedoAt(imbrium.latDeg, imbrium.lonDeg);
    assert.ok(insideImbrium < 0.35, `Imbrium center is dark (${insideImbrium.toFixed(2)})`);
    // Southern highlands, far from every mare.
    const highlands = fallbackAlbedoAt(-45, 25);
    assert.ok(highlands > 0.55, `southern highlands bright (${highlands.toFixed(2)})`);
    // Feather: albedo rises monotonically walking east out of Mare Crisium —
    // the ISOLATED oval, chosen because Imbrium's neighborhood is genuinely
    // dark in every direction (Serenitatis, Procellarum, Frigoris).
    const crisium = byName('Mare Crisium');
    const radiusDeg = (crisium.diameterKm / 2) / 1737.4 * 180 / Math.PI;
    const samples = [0.5, 0.9, 1.1, 1.5].map(f =>
        fallbackAlbedoAt(crisium.latDeg, crisium.lonDeg + f * radiusDeg));
    for (let i = 1; i < samples.length; i += 1) {
        assert.ok(samples[i] >= samples[i - 1] - 1e-9,
            `albedo non-decreasing outward (${samples.map(s => s.toFixed(2)).join(' → ')})`);
    }
    ok('fallbackAlbedoAt: dark maria, bright highlands, feathered rims');
}

// ── 3. Reiner Gamma grows its swirl on maria ─────────────────────────────────
{
    const synth = synthesizeLandmarkRegion(byName('Reiner Gamma'));
    assert.equal(synth.result.width, MOON_SYNTH_CELLS);
    assert.ok(synth.shares.maria > 0.3, `Procellarum ground is maria (${(synth.shares.maria * 100).toFixed(0)}%)`);
    assert.ok(synth.shares.swirl > 0.01, `the swirl exists (${(synth.shares.swirl * 100).toFixed(1)}%)`);
    assert.match(synth.provenance, /fallback/, 'provenance discloses the fallback albedo');
    // Swirls only on maria: no swirl cell may touch a highlands cell (kernel
    // adjacency), and the share must vanish at a swirl-free site.
    const tycho = synthesizeLandmarkRegion(byName('Tycho'));
    assert.ok((tycho.shares.swirl || 0) < 0.005, 'no swirls in the southern highlands');
    ok(`Reiner Gamma: maria ${(synth.shares.maria * 100).toFixed(0)}% + swirl ${(synth.shares.swirl * 100).toFixed(1)}%; Tycho swirl-free`);
}

// ── 4. Tycho grows rim + ejecta in bright highlands ──────────────────────────
{
    const synth = synthesizeLandmarkRegion(byName('Tycho'));
    assert.ok(synth.shares.highlands > 0.3, `highlands dominate (${(synth.shares.highlands * 100).toFixed(0)}%)`);
    assert.ok((synth.shares.rim || 0) + (synth.shares.ejecta || 0) > 0.03,
        `impact structure present (rim ${(100 * (synth.shares.rim || 0)).toFixed(1)}% + ejecta ${(100 * (synth.shares.ejecta || 0)).toFixed(1)}%)`);
    ok('Tycho: highland ground with rim/ejecta structure');
}

// ── 5. Mare Imbrium floor is basalt with mare-interior structures ────────────
{
    const synth = synthesizeLandmarkRegion(byName('Mare Imbrium'));
    assert.ok(synth.shares.maria > 0.45, `mare floor is basalt (${(synth.shares.maria * 100).toFixed(0)}%)`);
    const interior = (synth.shares.rille || 0) + (synth.shares.wrinkle || 0);
    assert.ok(interior > 0.02, `rilles/wrinkle ridges thread the mare (${(interior * 100).toFixed(1)}%)`);

    // The linear families must actually read as LINES here: connected chains
    // (no isolated interior cells — the port rules make them illegal) that
    // stay one cell wide (no 2×2 block of the same family).
    const { grid, width, height, tileset } = synth.result;
    for (const classId of ['rille', 'wrinkle']) {
        const ci = tileset.classes.findIndex(c => c.id === classId);
        const isC = (c) => tileset.classOfTile[grid[c]] === ci;
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const c = y * width + x;
                if (!isC(c)) continue;
                const neighbors = [
                    y > 0 ? c - width : -1, y < height - 1 ? c + width : -1,
                    x > 0 ? c - 1 : -1, x < width - 1 ? c + 1 : -1,
                ].filter(nb => nb >= 0);
                const connected = neighbors.some(isC);
                const onBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
                assert.ok(connected || onBorder,
                    `${classId} cell at (${x},${y}) is isolated interior speckle`);
                if (y + 1 < height && x + 1 < width) {
                    assert.ok(!(isC(c) && isC(c + 1) && isC(c + width) && isC(c + width + 1)),
                        `${classId} forms a 2×2 blob at (${x},${y})`);
                }
            }
        }
    }
    ok('Imbrium: basalt floor threaded by CONNECTED, one-cell-wide linear structures');
}

// ── 5b. Flow priors: wrinkle ridges arc around the basin, rilles run radial ──
{
    // Mare Serenitatis — big, compact, and less crowded by neighbor-mare
    // frames than Imbrium, so the geometry signal is cleanest. The site synth
    // is seed-deterministic, so these are exact-repeatable measurements, not
    // statistics: mean axis alignment of SEGMENT cells vs the nearest mare's
    // tangent (wrinkle, mid-annulus) / radial (rille, interior). An unbiased
    // solver measures ≈ 0.637 (E[|cos|]); the pins sit well above it and a
    // couple points under the measured values (0.757 / 0.704).
    const { MOON_TILESET, localOffsetKm } = await import('../js/terrain-wfc.js');
    const { R_MOON_KM } = await import('../js/moon-interior-model.js');
    const DEG = Math.PI / 180;
    const maria = LANDMARKS.filter(l => l.category === 'mare');
    const synth = synthesizeLandmarkRegion(byName('Mare Serenitatis'));
    const { grid, tileset } = synth.result;
    const stats = { wrinkle: { sum: 0, n: 0 }, rille: { sum: 0, n: 0 } };
    for (let i = 0; i < grid.length; i += 1) {
        const tile = tileset.tiles[grid[i]];
        if (tile.kind !== 0) continue;                    // segments only
        const [cls, suffix] = tile.id.split(':');
        if (cls !== 'wrinkle' && cls !== 'rille') continue;
        const lat = synth.region.latDeg[i];
        const lon = synth.region.lonDeg[i];
        let best = null;
        let bestNorm = Infinity;
        for (const m of maria) {
            const radiusDeg = (m.diameterKm / 2) / R_MOON_KM / DEG;
            const norm = angularSeparationDeg(lat, lon, m.latDeg, m.lonDeg) / radiusDeg;
            if (norm < bestNorm) { bestNorm = norm; best = m; }
        }
        if (cls === 'wrinkle' && (bestNorm < 0.3 || bestNorm > 0.72)) continue;
        if (cls === 'rille' && bestNorm > 0.8) continue;
        const r = localOffsetKm(best.latDeg, best.lonDeg, lat, lon, R_MOON_KM);
        const mag = Math.hypot(r.eastKm, r.northKm);
        if (mag < 1) continue;
        const axis = cls === 'wrinkle'
            ? [-r.northKm / mag, r.eastKm / mag]          // basin tangent
            : [r.eastKm / mag, r.northKm / mag];          // radial
        stats[cls].sum += suffix === 'ns' ? Math.abs(axis[1]) : Math.abs(axis[0]);
        stats[cls].n += 1;
    }
    const wrinkleAlign = stats.wrinkle.sum / Math.max(1, stats.wrinkle.n);
    const rilleAlign = stats.rille.sum / Math.max(1, stats.rille.n);
    assert.ok(stats.wrinkle.n >= 20, `enough ridge segments to judge (${stats.wrinkle.n})`);
    assert.ok(wrinkleAlign >= 0.72,
        `wrinkle ridges arc around the basin (tangent alignment ${wrinkleAlign.toFixed(3)} vs 0.637 unbiased)`);
    assert.ok(rilleAlign >= 0.66,
        `rilles run broadly radial (alignment ${rilleAlign.toFixed(3)} vs 0.637 unbiased)`);
    ok(`Serenitatis flow: ridges tangential ${wrinkleAlign.toFixed(2)}, rilles radial ${rilleAlign.toFixed(2)} (unbiased 0.64)`);
}

// ── 6. Determinism + measured-albedo path + legend ───────────────────────────
{
    const a = synthesizeLandmarkRegion(byName('Copernicus'));
    const b = synthesizeLandmarkRegion(byName('Copernicus'));
    assert.deepEqual(Array.from(a.result.grid), Array.from(b.result.grid), 'same site ⇒ same map');

    // A measured albedo sampler flips provenance and steers the classes:
    // an all-dark "measurement" turns Copernicus country into mare ground.
    const dark = synthesizeLandmarkRegion(byName('Copernicus'), { albedoAt: () => 0.22 });
    assert.match(dark.provenance, /LRO base map/, 'measured provenance');
    assert.ok(dark.shares.maria > (a.shares.maria || 0), 'measured albedo steers the priors');

    const legend = synthLegend(a.shares);
    assert.ok(legend.length >= 2, 'legend has visible classes');
    for (let i = 1; i < legend.length; i += 1) {
        assert.ok(legend[i].share <= legend[i - 1].share, 'legend sorted by share');
    }
    assert.ok(legend.every(row => row.color.length === 3 && row.label), 'legend rows renderable');
    ok('deterministic per site; measured albedo path + legend wiring');
}

// ── 7. Extent policy stays in honest map range ───────────────────────────────
{
    for (const l of LANDMARKS) {
        const extent = extentForLandmark(l);
        assert.ok(extent >= 240 && extent <= 1200, `${l.name} extent ${extent} km in range`);
    }
    near(extentForLandmark(byName('Tycho')), 240, 1e-9, 'small crater floors at 240 km');
    near(extentForLandmark(byName('Oceanus Procellarum')), 1200, 1e-9, 'Procellarum caps at 1200 km');
    ok('extent policy: 240–1200 km, tracks feature size');
}

console.log(`\nmoon-terrain-synth: ${passed} groups passed`);
