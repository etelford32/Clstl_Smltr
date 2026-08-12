#!/usr/bin/env node
/**
 * moon-relief.mjs — gate for js/moon-relief.js (the Moon's displaced relief).
 *
 * Run: node tests/moon-relief.mjs
 *
 * The load-bearing pins:
 *   • The sampler maps the raster's gray levels onto the DOCUMENTED nominal
 *     lunar span (−9.1 … +10.8 km), bilinearly, with longitude wrapping and
 *     latitude clamping — this is the mapping the drawn terrain claims.
 *   • radiusAtFactory keeps the drawn Moon inside the camera's floor: even
 *     the Selenean summit at 4× stays under radius 1.03 (controls.minDistance
 *     is 1.04 — terrain must never trap the camera).
 *   • displaceSphereGeometry is idempotent (base positions stashed once) and
 *     restoreSphereGeometry puts the smooth sphere back EXACTLY — the
 *     Terrain Relief toggle round-trips.
 *   • The unreadable-raster path returns null (no invented terrain).
 */

import assert from 'node:assert/strict';
import {
    MOON_RADIUS_KM, MOON_RELIEF_MIN_M, MOON_RELIEF_MAX_M, MOON_RELIEF_EXAGGERATION,
    reliefSamplerFromPixels, reliefSamplerFromImage, radiusAtFactory,
    displaceSphereGeometry, restoreSphereGeometry,
} from '../js/moon-relief.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed += 1; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

const SPAN = MOON_RELIEF_MAX_M - MOON_RELIEF_MIN_M;
const grayRaster = (width, height, grayFn) => {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const g = grayFn(x, y);
            const i = (y * width + x) * 4;
            pixels[i] = g; pixels[i + 1] = g; pixels[i + 2] = g; pixels[i + 3] = 255;
        }
    }
    return pixels;
};

// ── 1. Gray → elevation mapping, wrap, clamp, bilinear ───────────────────────
{
    const flat = reliefSamplerFromPixels(grayRaster(8, 4, () => 128), 8, 4);
    near(flat.elevationAt(0, 0), MOON_RELIEF_MIN_M + (128 / 255) * SPAN, 1, 'gray 128 maps mid-span');
    near(flat.elevationAt(89.9, 12), flat.elevationAt(-89.9, -170), 1e-9, 'uniform raster is uniform');

    const extremes = reliefSamplerFromPixels(grayRaster(8, 4, (x) => (x < 4 ? 0 : 255)), 8, 4);
    near(extremes.elevationAt(0, -135), MOON_RELIEF_MIN_M, 40, 'gray 0 ⇒ Antoniadi floor');
    near(extremes.elevationAt(0, 100), MOON_RELIEF_MAX_M, 40, 'gray 255 ⇒ Selenean summit');
    // Bilinear midpoint between a 0 column and a 255 column.
    const mid = extremes.elevationAt(0, -180 + (3.5 / 7) * 360 + 360 / 14 / 2);
    assert.ok(mid > MOON_RELIEF_MIN_M + SPAN * 0.2 && mid < MOON_RELIEF_MAX_M - SPAN * 0.2,
        `column boundary interpolates (${Math.round(mid)} m)`);

    // Longitude wraps continuously; latitude clamps rather than reflecting.
    near(extremes.elevationAt(10, 180), extremes.elevationAt(10, -180), 1e-9, 'antimeridian wraps');
    near(extremes.elevationAt(95, 0), extremes.elevationAt(90, 0), 1e-9, 'latitude clamps');
    ok('sampler: nominal span mapping, bilinear, wrap + clamp');
}

// ── 2. radiusAt keeps the terrain under the camera floor ─────────────────────
{
    const summit = reliefSamplerFromPixels(grayRaster(4, 4, () => 255), 4, 4);
    const floor = reliefSamplerFromPixels(grayRaster(4, 4, () => 0), 4, 4);
    const rMax = radiusAtFactory(summit)(0, 0);
    const rMin = radiusAtFactory(floor)(0, 0);
    near(rMax, 1 + (MOON_RELIEF_MAX_M / (MOON_RADIUS_KM * 1000)) * MOON_RELIEF_EXAGGERATION, 1e-9, 'summit radius');
    near(rMin, 1 + (MOON_RELIEF_MIN_M / (MOON_RADIUS_KM * 1000)) * MOON_RELIEF_EXAGGERATION, 1e-9, 'floor radius');
    assert.ok(rMax < 1.03, `4× Selenean summit (${rMax.toFixed(4)}) stays under the 1.04 camera floor`);
    assert.ok(rMin > 0.97, 'floor stays a sphere-ish radius');
    ok(`radiusAt: ${rMin.toFixed(4)} … ${rMax.toFixed(4)} at ${MOON_RELIEF_EXAGGERATION}× — camera floor safe`);
}

// ── 3. Displacement is idempotent and restores exactly ───────────────────────
{
    // Duck-typed BufferGeometry — the module must not need three.js.
    const dirs = [
        [1, 0, 0],            // lat 0, lon 0
        [0, 1, 0],            // north pole
        [0, 0, -1],           // lat 0, lon 90°E
        [0.5, Math.SQRT1_2, 0.5],
    ];
    const array = new Float32Array(dirs.flat());
    let normalsComputed = 0;
    const geometry = {
        attributes: { position: { array, count: dirs.length, needsUpdate: false } },
        userData: {},
        computeVertexNormals: () => { normalsComputed += 1; },
        computeBoundingSphere: () => {},
    };
    const radiusAt = (latDeg, lonDeg) => 1 + 0.01 * Math.sin(latDeg * Math.PI / 180) + 0.002 * Math.cos(lonDeg * Math.PI / 180);
    const original = array.slice();

    const stats = displaceSphereGeometry(geometry, radiusAt);
    near(Math.hypot(array[0], array[1], array[2]), radiusAt(0, 0), 1e-6, 'equator vertex at radiusAt(0,0)');
    near(Math.hypot(array[3], array[4], array[5]), radiusAt(90, 0), 1e-6, 'pole vertex at radiusAt(90,·)');
    near(Math.hypot(array[6], array[7], array[8]), radiusAt(0, 90), 1e-6, 'east vertex at radiusAt(0,90)');
    assert.ok(stats.maxRadius >= stats.minRadius && Number.isFinite(stats.minRadius), 'stats sane');
    assert.ok(normalsComputed >= 1, 'normals recomputed');

    const once = array.slice();
    displaceSphereGeometry(geometry, radiusAt);
    assert.deepEqual(Array.from(array), Array.from(once), 'idempotent (base stashed once)');

    assert.equal(restoreSphereGeometry(geometry), true, 'restore reports success');
    assert.deepEqual(Array.from(array), Array.from(original), 'smooth sphere restored EXACTLY');
    ok('displacement: correct radii, idempotent, exact restore');
}

// ── 4. Unreadable rasters refuse to invent terrain ───────────────────────────
{
    assert.equal(reliefSamplerFromImage({ width: 0, height: 0 }, () => ({})), null, 'no image ⇒ null');
    assert.equal(reliefSamplerFromImage({ width: 1, height: 1 }, () => ({})), null, '1×1 fallback texture ⇒ null');
    const tainted = {
        getContext: () => ({ drawImage() {}, getImageData() { throw new Error('tainted'); } }),
    };
    assert.equal(
        reliefSamplerFromImage({ width: 64, height: 32 }, () => tainted), null,
        'CORS taint ⇒ null');
    // And the injectable-canvas path works without any DOM at all.
    const fake = {
        getContext: () => ({
            drawImage() {},
            getImageData: (x, y, w, h) => ({ data: grayRaster(w, h, () => 255) }),
        }),
    };
    const sampler = reliefSamplerFromImage({ width: 64, height: 32 }, () => {
        fake.width = 0; fake.height = 0;
        return fake;
    });
    near(sampler.elevationAt(0, 0), MOON_RELIEF_MAX_M, 1, 'node-injected canvas path samples');
    ok('honesty: unreadable raster ⇒ null (smooth sphere), injectable canvas works headless');
}

console.log(`\nmoon-relief: ${passed} groups passed`);
