/**
 * neptune-moon-textures.js — procedural equirectangular surface maps for the
 * Neptunian moons.
 *
 * Each moon is generated once at load into a pair of THREE.DataTextures:
 *   - map  : sRGB albedo (base colour + crater rays/floors + polar cap +
 *            cantaloupe dimples + geyser wind-streaks)
 *   - bump : linear height field driving MeshStandardMaterial.bumpMap so the
 *            craters and dimples catch the terminator.
 *
 * The fields are sampled on the unit sphere (3-D value-noise + Worley), so they
 * are seamless across the ±180° longitude wrap and undistorted at the poles —
 * no equirectangular pinching. Lighting is left to the scene's directional Sun
 * + ambient fill, so the moons show a real day/night terminator.
 *
 * The recipes are illustrative, not photographic. Triton's pink south-polar
 * nitrogen-frost cap, its dimpled "cantaloupe terrain", and the dark
 * plume-fallout streaks Voyager 2 imaged in 1989 are the headline features;
 * Proteus is rendered near-black and saturated with craters; the small
 * ring-region moonlets are dark, reddened, irradiated rubble.
 *
 * References: Smith et al. (1989) Science 246 (Voyager 2 imaging);
 * Schenk & Jackson (1993) cantaloupe terrain; Croft et al. (1995) Neptune book.
 */

import * as THREE from 'three';

// ── Small math helpers (CPU procedural noise on the sphere) ──────────────────
const fract = x => x - Math.floor(x);
const fade  = t => t * t * (3 - 2 * t);
const lerp  = (a, b, t) => a + (b - a) * t;
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

function hash3(i, j, k) {
    // Sine hash — fine for visual noise, handles negative lattice indices.
    return fract(Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453);
}
function vnoise3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = fade(xf), v = fade(yf), w = fade(zf);
    const c = (a, b, d) => hash3(xi + a, yi + b, zi + d);
    const x00 = lerp(c(0,0,0), c(1,0,0), u);
    const x10 = lerp(c(0,1,0), c(1,1,0), u);
    const x01 = lerp(c(0,0,1), c(1,0,1), u);
    const x11 = lerp(c(0,1,1), c(1,1,1), u);
    return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}
function fbm3(x, y, z, oct) {
    let a = 0.5, s = 0, f = 1;
    for (let i = 0; i < oct; i++) { s += a * vnoise3(x*f, y*f, z*f); f *= 2.0; a *= 0.5; }
    return s;
}
// Worley F1 distance — drives Triton's cellular "cantaloupe" dimples.
function worley3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let f1 = 9;
    for (let a = -1; a <= 1; a++)
    for (let b = -1; b <= 1; b++)
    for (let d = -1; d <= 1; d++) {
        const gx = xi + a, gy = yi + b, gz = zi + d;
        const px = gx + hash3(gx, gy, gz);
        const py = gy + hash3(gy, gz, gx);
        const pz = gz + hash3(gz, gx, gy);
        const dx = px - x, dy = py - y, dz = pz - z;
        const dd = dx*dx + dy*dy + dz*dz;
        if (dd < f1) f1 = dd;
    }
    return Math.sqrt(f1);
}

// Deterministic PRNG so each moon's craters/streaks are stable across reloads.
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function dirFromLonLat(lon, lat) {
    const cl = Math.cos(lat);
    return [cl * Math.cos(lon), Math.sin(lat), cl * Math.sin(lon)];
}

// ── Per-moon surface recipes ─────────────────────────────────────────────────
// base/cap/streak colours are linear 0..1 RGB. res is [W,H].
// Power-of-two dimensions so mipmaps + repeat-wrap are valid in any context.
const D = [512, 256], M = [256, 128], L = [128, 64];
export const MOON_SURFACES = {
    triton: {
        res: D, seed: 17, base: [0.80, 0.81, 0.83], bright: 1.06,
        craters: 7, craterSize: 0.09, craterDepth: 0.45, noise: 0.05, noiseFreq: 4,
        cap: { color: [0.95, 0.80, 0.76], lat0: -0.95, lat1: -0.30, soft: 0.22, mottle: 0.10 },
        cantaloupe: { strength: 0.16, freq: 7.0, band: 0.9 },   // dimpled terrain
        streaks: { count: 8, color: [0.28, 0.22, 0.20], strength: 0.55 },
    },
    proteus: {
        res: D, seed: 41, base: [0.115, 0.112, 0.118], bright: 1.0,
        craters: 46, craterSize: 0.12, craterDepth: 0.7, rim: 0.20, noise: 0.14, noiseFreq: 5,
    },
    larissa: {
        res: M, seed: 73, base: [0.30, 0.27, 0.25], bright: 1.0,
        craters: 34, craterSize: 0.15, craterDepth: 0.6, rim: 0.18, noise: 0.20, noiseFreq: 6,
    },
    nereid: {
        res: M, seed: 91, base: [0.39, 0.41, 0.43], bright: 1.0,
        craters: 22, craterSize: 0.13, craterDepth: 0.5, rim: 0.16, noise: 0.14, noiseFreq: 5,
    },
    galatea:   { res: M, seed: 23, base: [0.21, 0.16, 0.14], bright: 1.0, craters: 16, craterSize: 0.17, craterDepth: 0.55, rim: 0.10, noise: 0.24, noiseFreq: 6 },
    despina:   { res: M, seed: 29, base: [0.21, 0.16, 0.14], bright: 1.0, craters: 15, craterSize: 0.17, craterDepth: 0.55, rim: 0.10, noise: 0.24, noiseFreq: 6 },
    naiad:     { res: L, seed: 31, base: [0.23, 0.17, 0.15], bright: 1.0, craters: 9,  craterSize: 0.20, craterDepth: 0.5,  rim: 0.08, noise: 0.30, noiseFreq: 7 },
    thalassa:  { res: L, seed: 37, base: [0.23, 0.17, 0.15], bright: 1.0, craters: 9,  craterSize: 0.20, craterDepth: 0.5,  rim: 0.08, noise: 0.30, noiseFreq: 7 },
    hippocamp: { res: L, seed: 43, base: [0.24, 0.18, 0.15], bright: 1.0, craters: 7,  craterSize: 0.22, craterDepth: 0.5,  rim: 0.08, noise: 0.32, noiseFreq: 7 },
    // Captured irregulars — tiny, dark, reddened.
    sao:       { res: L, seed: 53, base: [0.19, 0.14, 0.12], bright: 1.0, craters: 10, craterSize: 0.20, craterDepth: 0.5, rim: 0.08, noise: 0.30, noiseFreq: 7 },
    laomedeia: { res: L, seed: 59, base: [0.19, 0.14, 0.12], bright: 1.0, craters: 10, craterSize: 0.20, craterDepth: 0.5, rim: 0.08, noise: 0.30, noiseFreq: 7 },
    halimede:  { res: L, seed: 61, base: [0.18, 0.14, 0.13], bright: 1.0, craters: 10, craterSize: 0.20, craterDepth: 0.5, rim: 0.08, noise: 0.30, noiseFreq: 7 },
    psamathe:  { res: L, seed: 67, base: [0.18, 0.13, 0.11], bright: 1.0, craters: 10, craterSize: 0.20, craterDepth: 0.5, rim: 0.08, noise: 0.30, noiseFreq: 7 },
    neso:      { res: L, seed: 71, base: [0.19, 0.14, 0.12], bright: 1.0, craters: 10, craterSize: 0.20, craterDepth: 0.5, rim: 0.08, noise: 0.30, noiseFreq: 7 },
};

const _cache = {};

/**
 * Build (and cache) the albedo + bump DataTextures for a moon.
 * @param {string} key  moon key (see MOON_SURFACES)
 * @returns {{ map: THREE.DataTexture, bump: THREE.DataTexture } | null}
 */
export function makeMoonTexture(key) {
    if (_cache[key]) return _cache[key];
    const cfg = MOON_SURFACES[key];
    if (!cfg) return null;

    const [W, H] = cfg.res;
    const rnd = mulberry32(cfg.seed * 2654435761);

    // Pre-roll craters (unit-vector centre, angular radius, depth, rim).
    const craters = [];
    for (let n = 0; n < (cfg.craters || 0); n++) {
        const lon = rnd() * Math.PI * 2;
        const lat = Math.asin(rnd() * 2 - 1);
        const sz  = cfg.craterSize * (0.4 + rnd() * 1.1);
        craters.push({ dir: dirFromLonLat(lon, lat), r: sz, cosr: Math.cos(sz) });
    }
    // Pre-roll geyser streaks (Triton) — anchored near the south cap edge,
    // drawn out toward the equator (the prevailing-wind / sub-solar side).
    const streaks = [];
    if (cfg.streaks) {
        for (let n = 0; n < cfg.streaks.count; n++) {
            const lon = rnd() * Math.PI * 2;
            const lat = -0.55 - rnd() * 0.5;                 // southern latitudes
            const C = dirFromLonLat(lon, lat);
            // Tangent pointing toward the north pole (along the surface).
            const up = [0, 1, 0];
            let T = [up[0] - C[0]*C[1], up[1] - C[1]*C[1], up[2] - C[2]*C[1]];
            const tl = Math.hypot(T[0], T[1], T[2]) || 1;
            T = [T[0]/tl, T[1]/tl, T[2]/tl];
            const B = [C[1]*T[2]-C[2]*T[1], C[2]*T[0]-C[0]*T[2], C[0]*T[1]-C[1]*T[0]];
            streaks.push({ C, T, B, la: 0.22 + rnd()*0.18, lb: 0.018 + rnd()*0.012 });
        }
    }

    const map  = new Uint8Array(W * H * 4);
    const bump = new Uint8Array(W * H * 4);
    const base = cfg.base, bri = cfg.bright || 1;

    for (let j = 0; j < H; j++) {
        const lat = (0.5 - (j + 0.5) / H) * Math.PI;         // +π/2 (top) → −π/2
        for (let i = 0; i < W; i++) {
            const lon = ((i + 0.5) / W) * Math.PI * 2;
            const dir = dirFromLonLat(lon, lat);
            const dx = dir[0], dy = dir[1], dz = dir[2];

            // Base mottling.
            const nf = cfg.noiseFreq || 5;
            let shade = 1 + (fbm3(dx*nf, dy*nf, dz*nf, 4) - 0.5) * 2 * (cfg.noise || 0.15);
            let height = 0.5 + (fbm3(dx*nf*2, dy*nf*2, dz*nf*2, 3) - 0.5) * 0.25;

            let r = base[0], g = base[1], b = base[2];

            // Cantaloupe dimples (Triton): Worley pits.
            if (cfg.cantaloupe) {
                const cf = cfg.cantaloupe.freq;
                const w = worley3(dx*cf, dy*cf, dz*cf);
                const pit = smooth(0.0, 0.45, w);            // 0 at cell centres (pits)
                const dimple = (1 - pit);
                shade *= 1 - dimple * cfg.cantaloupe.strength;
                height -= dimple * 0.22;
            }

            // Craters.
            let craterShade = 1, rimAdd = 0;
            for (const c of craters) {
                const cosA = dx*c.dir[0] + dy*c.dir[1] + dz*c.dir[2];
                if (cosA <= c.cosr) continue;
                const a = Math.acos(Math.min(1, cosA)) / c.r;  // 0 centre → 1 rim
                // Bowl floor darkens, rim brightens slightly.
                craterShade *= 1 - (cfg.craterDepth || 0.5) * (1 - smooth(0.75, 1.0, a)) * (1 - a*0.3);
                if (cfg.rim) rimAdd += cfg.rim * smooth(0.78, 0.96, a) * (1 - smooth(0.96, 1.08, a));
                height -= 0.28 * (1 - a) - 0.10 * smooth(0.8, 1.0, a);
            }
            shade *= craterShade;
            shade += rimAdd;

            // Polar cap (Triton south).
            if (cfg.cap) {
                const cp = cfg.cap;
                const latN = Math.sin(lat);                  // -1..1
                let capf = smooth(cp.lat0, cp.lat1, latN);   // 1 deep south → 0
                capf = 1 - capf;                             // strongest at pole
                capf *= 1 - smooth(0, 1, (latN - cp.lat1) / cp.soft);
                capf = clamp01(capf);
                const m = 1 + (fbm3(dx*9, dy*9, dz*9, 3) - 0.5) * 2 * cp.mottle;
                r = lerp(r, cp.color[0]*m, capf);
                g = lerp(g, cp.color[1]*m, capf);
                b = lerp(b, cp.color[2]*m, capf);
            }

            // Geyser wind-streaks (Triton).
            if (streaks.length) {
                let dark = 0;
                for (const s of streaks) {
                    const ox = dx - s.C[0], oy = dy - s.C[1], oz = dz - s.C[2];
                    const a = ox*s.T[0] + oy*s.T[1] + oz*s.T[2];     // along (toward N)
                    const bb = ox*s.B[0] + oy*s.B[1] + oz*s.B[2];    // across
                    if (a < -0.05) continue;                         // only downwind
                    dark += Math.exp(-(a*a)/(2*s.la*s.la) - (bb*bb)/(2*s.lb*s.lb));
                }
                dark = clamp01(dark) * cfg.streaks.strength;
                r = lerp(r, cfg.streaks.color[0], dark);
                g = lerp(g, cfg.streaks.color[1], dark);
                b = lerp(b, cfg.streaks.color[2], dark);
                height -= dark * 0.06;
            }

            const o = (j * W + i) * 4;
            // Albedo (sRGB-encoded for DataTexture sRGB colour space).
            const enc = v => Math.round(clamp01(Math.pow(clamp01(v), 1/2.2)) * 255);
            map[o]   = enc(r * shade * bri);
            map[o+1] = enc(g * shade * bri);
            map[o+2] = enc(b * shade * bri);
            map[o+3] = 255;
            // Bump (linear height).
            const hv = Math.round(clamp01(height) * 255);
            bump[o] = bump[o+1] = bump[o+2] = hv; bump[o+3] = 255;
        }
    }

    const mapTex = new THREE.DataTexture(map, W, H, THREE.RGBAFormat);
    mapTex.colorSpace = THREE.SRGBColorSpace;
    mapTex.wrapS = THREE.RepeatWrapping;
    mapTex.wrapT = THREE.ClampToEdgeWrapping;
    mapTex.minFilter = THREE.LinearMipmapLinearFilter;
    mapTex.magFilter = THREE.LinearFilter;
    mapTex.generateMipmaps = true;
    mapTex.flipY = true;
    mapTex.needsUpdate = true;

    const bumpTex = new THREE.DataTexture(bump, W, H, THREE.RGBAFormat);
    bumpTex.wrapS = THREE.RepeatWrapping;
    bumpTex.wrapT = THREE.ClampToEdgeWrapping;
    bumpTex.minFilter = THREE.LinearMipmapLinearFilter;
    bumpTex.magFilter = THREE.LinearFilter;
    bumpTex.generateMipmaps = true;
    bumpTex.flipY = true;
    bumpTex.needsUpdate = true;

    _cache[key] = { map: mapTex, bump: bumpTex };
    return _cache[key];
}
