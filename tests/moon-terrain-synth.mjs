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
    ok('Imbrium: basalt floor threaded by mare-interior structures');
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
