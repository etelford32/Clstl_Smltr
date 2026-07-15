/**
 * earth-dem-inset.mjs — pure-math sanity for js/earth-dem-inset.js (T1b DEM inset)
 * ═══════════════════════════════════════════════════════════════════════════════
 * The DEM inset fetches Web-Mercator terrain-RGB tiles and resamples them into an
 * equirectangular window the terrain-patch vertex shader displaces by. Wrong tile
 * math would fetch the wrong ground (terrain misaligned with the map) or request
 * out-of-range tiles (404 → no inset); a wrong Terrarium decode would scale every
 * mountain wrong. The fetch/resample is browser-only, but the tile selection and
 * the elevation decode are pure functions and are checked here.
 *
 * Checks:
 *   1. slippy lon↔tileX and lat↔tileY round-trip
 *   2. Terrarium decode matches the spec on known anchors (0 m, Everest, Dead Sea)
 *   3. the GLSL decode constants match the JS decode (drift guard)
 *   4. pickZoom is monotonic (smaller footprint → higher zoom) and clamped
 *   5. planDemTiles covers the footprint corners and stays within the tile grid
 *   6. an antimeridian-straddling footprint wraps tile columns into [0, 2^z)
 *
 * Run: node tests/earth-dem-inset.mjs
 */

import {
    lon2tileX, lat2tileY, tileX2lon, tileY2lat,
    decodeTerrarium, pickZoom, planDemTiles,
} from '../js/earth-dem-inset.js';

import { readFileSync } from 'node:fs';

let checks = 0;
function assert(cond, msg) {
    checks++;
    if (!cond) { console.error(`  ✗ ${msg}`); process.exitCode = 1; return false; }
    console.log(`  ✓ ${msg}`);
    return true;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// 1. Slippy round-trips
for (const z of [6, 9, 12]) {
    for (const lon of [-179, -40, 0, 84.2, 179]) {
        const rt = tileX2lon(lon2tileX(lon, z), z);
        assert(near(rt, lon, 1e-4), `lon round-trip z${z} lon=${lon} → ${rt.toFixed(4)}`);
    }
    for (const lat of [-70, -12, 0, 27.98, 70]) {
        const rt = tileY2lat(lat2tileY(lat, z), z);
        assert(near(rt, lat, 1e-4), `lat round-trip z${z} lat=${lat} → ${rt.toFixed(4)}`);
    }
}

// 2. Terrarium decode anchors — encoding = (R·256 + G + B/256) − 32768 metres.
assert(decodeTerrarium(128, 0, 0) === 0, `sea level (128,0,0) → 0 m`);
// 8848 m (Everest): 32768 + 8848 = 41616 = 162·256 + 144 → (162,144,0)
assert(decodeTerrarium(162, 144, 0) === 8848, `Everest (162,144,0) → 8848 m`);
// −430 m (Dead Sea): 32768 − 430 = 32338 = 126·256 + 82 → (126,82,0)
assert(decodeTerrarium(126, 82, 0) === -430, `Dead Sea (126,82,0) → −430 m (bathy/depression)`);
// fractional metre via blue channel
assert(near(decodeTerrarium(128, 0, 128), 0.5, 1e-9), `blue channel gives sub-metre (128,0,128) → 0.5 m`);

// 3. Drift guard: the GLSL decode in earth-terrain-patch.js must use the same
// constants (·256, /256, −32768) as the JS decode.
const vertSrc = readFileSync(new URL('../js/earth-terrain-patch.js', import.meta.url), 'utf8');
assert(/c\.r \* 256\.0 \+ c\.g \+ c\.b \/ 256\.0\) - 32768\.0/.test(vertSrc),
    `GLSL demMetres matches JS decodeTerrarium constants`);
assert(/\* 255\.0/.test(vertSrc), `GLSL scales the 0..1 sample back to 0..255 before decode`);

// 4. pickZoom monotonic + clamped
const zWide = pickZoom(20), zMid = pickZoom(5), zTight = pickZoom(1);
assert(zWide <= zMid && zMid <= zTight, `pickZoom monotonic: ${zWide} ≤ ${zMid} ≤ ${zTight}`);
assert(pickZoom(0.001) <= 12 && pickZoom(400) >= 6, `pickZoom clamped to [6,12]`);

// 5. planDemTiles covers the footprint (Himalaya window) and stays in-grid
const fp = { latMin: 27, latMax: 30, lonMin: 84, spanLonDeg: 3, spanLatDeg: 3 };
const plan = planDemTiles(fp);
const n = 1 << plan.z;
let inGrid = true;
for (const t of plan.tiles) if (t.x < 0 || t.x >= n || t.y < 0 || t.y >= n) inGrid = false;
assert(inGrid, `all ${plan.tiles.length} tiles within [0, 2^${plan.z}) grid`);
// the tile covering the SW corner must be in the plan
const cx = ((Math.floor(lon2tileX(fp.lonMin, plan.z)) % n) + n) % n;
const cy = Math.floor(lat2tileY(fp.latMax, plan.z));   // north = top row
assert(plan.tiles.some(t => t.x === cx && t.y === cy), `plan includes the NW-corner tile (${cx},${cy})`);
assert(near(plan.bounds.lonSpan, fp.spanLonDeg) && near(plan.bounds.latSpan, fp.latMax - fp.latMin),
    `equirect output bounds equal the footprint`);

// 6. Antimeridian straddle wraps columns
const fpAM = { latMin: -1, latMax: 2, lonMin: 179, spanLonDeg: 3, spanLatDeg: 3 };
const planAM = planDemTiles(fpAM);
const nAM = 1 << planAM.z;
let wrapped = true;
for (const t of planAM.tiles) if (t.x < 0 || t.x >= nAM) wrapped = false;
assert(wrapped, `antimeridian footprint wraps tile columns into [0, 2^${planAM.z})`);

if (process.exitCode) {
    console.error('\nearth-dem-inset: FAILED');
} else {
    console.log(`\nearth-dem-inset: ${checks} checks passed`);
}
