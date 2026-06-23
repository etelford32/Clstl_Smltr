/**
 * uranus-moon-textures.js — procedural equirectangular surface maps for the
 * Uranian moons.
 *
 * Each moon is generated once at load into a pair of THREE.DataTextures:
 *   - map  : sRGB albedo (base colour + craters + grooved corona/chasma terrain
 *            + placed bright/dark patches)
 *   - bump : linear height field driving MeshStandardMaterial.bumpMap so the
 *            craters, scarps and grooves catch the terminator.
 *
 * The fields are sampled on the unit sphere (3-D value-noise + Worley), so they
 * are seamless across the ±180° longitude wrap and undistorted at the poles.
 *
 * The recipes are illustrative, not photographic. Headline features:
 *   - Miranda: chaotic grooved coronae (Inverness "chevron", Arden, Elsinore)
 *     and the bright Verona Rupes scarp — the tallest cliff known (~20 km).
 *   - Ariel: the brightest Uranian moon; young surface cut by bright-floored
 *     fault canyons (Kachina Chasmata).
 *   - Umbriel: the darkest moon, uniformly cratered, with the single bright
 *     ring-deposit Wunda near its equator.
 *   - Titania: largest moon; grey with the long Messina Chasmata rift.
 *   - Oberon: dark, reddish, saturated with craters that have dark floors.
 *   - Inner moons & irregulars: tiny, dark, reddened rubble (Sycorax is red).
 *
 * References: Smith et al. (1986) Science 233 (Voyager 2 imaging);
 * Croft & Soderblom (1991) Uranus satellite geology; Schenk & Moore (2020).
 */

import * as THREE from 'three';

// ── Small math helpers (CPU procedural noise on the sphere) ──────────────────
const fract = x => x - Math.floor(x);
const fade  = t => t * t * (3 - 2 * t);
const lerp  = (a, b, t) => a + (b - a) * t;
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

function hash3(i, j, k) {
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
// base colours are linear 0..1 RGB. res is [W,H] (power-of-two).
//   grooves : { strength, freq, bright? }  parallel warped ridges/canyons
//   spots   : [{ lon°, lat°, r(rad), color?[r,g,b], bright?, bump?, strength }]
const D = [512, 256], M = [256, 128], L = [128, 64];
export const MOON_SURFACES = {
    // ── Five major moons ─────────────────────────────────────────────────────
    miranda: {
        res: D, seed: 11, base: [0.40, 0.41, 0.43], bright: 1.05,
        craters: 16, craterSize: 0.10, craterDepth: 0.5, rim: 0.12, noise: 0.10, noiseFreq: 5,
        grooves: { strength: 0.34, freq: 24 },          // chaotic corona ridges
        spots: [
            { lon: 200, lat: -32, r: 0.62, color: [0.30, 0.31, 0.33], strength: 0.55, bump: -0.10 }, // Arden corona
            { lon:  20, lat: -48, r: 0.50, color: [0.34, 0.35, 0.37], strength: 0.55, bump: -0.08 }, // Inverness "chevron"
            { lon: 110, lat:   8, r: 0.48, color: [0.33, 0.34, 0.36], strength: 0.45, bump: -0.06 }, // Elsinore corona
            { lon: 317, lat: -18, r: 0.10, bright: 1.7, strength: 1.0, bump: 0.30 },                 // Verona Rupes bright scarp
        ],
    },
    ariel: {
        res: D, seed: 23, base: [0.46, 0.46, 0.47], bright: 1.06,
        craters: 11, craterSize: 0.09, craterDepth: 0.45, rim: 0.10, noise: 0.08, noiseFreq: 5,
        grooves: { strength: 0.26, freq: 15, bright: true }, // bright-floored chasmata
    },
    umbriel: {
        res: D, seed: 37, base: [0.165, 0.16, 0.17], bright: 1.0,
        craters: 42, craterSize: 0.12, craterDepth: 0.6, rim: 0.10, noise: 0.10, noiseFreq: 5,
        spots: [
            { lon: 350, lat: 12, r: 0.16, bright: 1.4, strength: 1.0, bump: 0.05 }, // Wunda bright ring
        ],
    },
    titania: {
        res: D, seed: 53, base: [0.37, 0.35, 0.34], bright: 1.02,
        craters: 30, craterSize: 0.11, craterDepth: 0.55, rim: 0.12, noise: 0.10, noiseFreq: 5,
        grooves: { strength: 0.18, freq: 11 },          // Messina Chasmata
    },
    oberon: {
        res: D, seed: 67, base: [0.31, 0.27, 0.25], bright: 1.0,
        craters: 40, craterSize: 0.12, craterDepth: 0.65, rim: 0.12, noise: 0.12, noiseFreq: 5,
        grooves: { strength: 0.10, freq: 9 },           // Mommur Chasma
        spots: [
            { lon: 120, lat: -10, r: 0.14, color: [0.16, 0.12, 0.11], strength: 0.7, bump: -0.06 }, // Hamlet dark floor
            { lon: 300, lat:  20, r: 0.10, color: [0.17, 0.13, 0.12], strength: 0.6, bump: -0.05 },
        ],
    },

    // ── Inner ring-moons (dark, reddened rubble) ─────────────────────────────
    puck:      { res: M, seed: 83, base: [0.13, 0.125, 0.125], bright: 1.0, craters: 14, craterSize: 0.18, craterDepth: 0.6, rim: 0.10, noise: 0.22, noiseFreq: 6 },
    portia:    { res: M, seed: 89, base: [0.125, 0.115, 0.112], bright: 1.0, craters: 12, craterSize: 0.18, craterDepth: 0.55, rim: 0.09, noise: 0.24, noiseFreq: 6 },
    juliet:    { res: L, seed: 97, base: [0.125, 0.115, 0.112], bright: 1.0, craters: 9,  craterSize: 0.20, craterDepth: 0.5, rim: 0.08, noise: 0.28, noiseFreq: 7 },
    cressida:  { res: L, seed: 101, base: [0.13, 0.118, 0.114], bright: 1.0, craters: 9,  craterSize: 0.20, craterDepth: 0.5, rim: 0.08, noise: 0.28, noiseFreq: 7 },
    desdemona: { res: L, seed: 103, base: [0.13, 0.118, 0.114], bright: 1.0, craters: 8,  craterSize: 0.20, craterDepth: 0.5, rim: 0.08, noise: 0.28, noiseFreq: 7 },
    cordelia:  { res: L, seed: 107, base: [0.12, 0.11, 0.108], bright: 1.0, craters: 7,  craterSize: 0.22, craterDepth: 0.5, rim: 0.07, noise: 0.30, noiseFreq: 7 },
    ophelia:   { res: L, seed: 109, base: [0.12, 0.11, 0.108], bright: 1.0, craters: 7,  craterSize: 0.22, craterDepth: 0.5, rim: 0.07, noise: 0.30, noiseFreq: 7 },
    bianca:    { res: L, seed: 113, base: [0.125, 0.113, 0.110], bright: 1.0, craters: 7,  craterSize: 0.22, craterDepth: 0.5, rim: 0.07, noise: 0.30, noiseFreq: 7 },
    rosalind:  { res: L, seed: 127, base: [0.125, 0.113, 0.110], bright: 1.0, craters: 7,  craterSize: 0.22, craterDepth: 0.5, rim: 0.07, noise: 0.30, noiseFreq: 7 },
    cupid:     { res: L, seed: 131, base: [0.12, 0.11, 0.108], bright: 1.0, craters: 5,  craterSize: 0.24, craterDepth: 0.5, rim: 0.06, noise: 0.32, noiseFreq: 8 },
    belinda:   { res: L, seed: 137, base: [0.125, 0.113, 0.110], bright: 1.0, craters: 8,  craterSize: 0.20, craterDepth: 0.5, rim: 0.08, noise: 0.28, noiseFreq: 7 },
    perdita:   { res: L, seed: 139, base: [0.12, 0.11, 0.108], bright: 1.0, craters: 5,  craterSize: 0.24, craterDepth: 0.5, rim: 0.06, noise: 0.32, noiseFreq: 8 },
    mab:       { res: L, seed: 149, base: [0.13, 0.118, 0.114], bright: 1.0, craters: 5,  craterSize: 0.24, craterDepth: 0.5, rim: 0.06, noise: 0.32, noiseFreq: 8 },

    // ── Captured irregulars — tiny, dark, reddened (Sycorax notably red) ──────
    francisco: { res: L, seed: 151, base: [0.16, 0.12, 0.10], bright: 1.0, craters: 8, craterSize: 0.20, craterDepth: 0.5, rim: 0.07, noise: 0.30, noiseFreq: 7 },
    caliban:   { res: L, seed: 157, base: [0.20, 0.13, 0.11], bright: 1.0, craters: 9, craterSize: 0.20, craterDepth: 0.5, rim: 0.07, noise: 0.30, noiseFreq: 7 },
    stephano:  { res: L, seed: 163, base: [0.18, 0.13, 0.11], bright: 1.0, craters: 8, craterSize: 0.20, craterDepth: 0.5, rim: 0.07, noise: 0.30, noiseFreq: 7 },
    trinculo:  { res: L, seed: 167, base: [0.17, 0.12, 0.10], bright: 1.0, craters: 7, craterSize: 0.22, craterDepth: 0.5, rim: 0.06, noise: 0.32, noiseFreq: 8 },
    sycorax:   { res: M, seed: 173, base: [0.24, 0.14, 0.11], bright: 1.0, craters: 12, craterSize: 0.18, craterDepth: 0.55, rim: 0.08, noise: 0.26, noiseFreq: 6 },
    margaret:  { res: L, seed: 179, base: [0.17, 0.13, 0.11], bright: 1.0, craters: 6, craterSize: 0.22, craterDepth: 0.5, rim: 0.06, noise: 0.32, noiseFreq: 8 },
    prospero:  { res: L, seed: 181, base: [0.19, 0.13, 0.11], bright: 1.0, craters: 9, craterSize: 0.20, craterDepth: 0.5, rim: 0.07, noise: 0.30, noiseFreq: 7 },
    setebos:   { res: L, seed: 191, base: [0.19, 0.13, 0.11], bright: 1.0, craters: 9, craterSize: 0.20, craterDepth: 0.5, rim: 0.07, noise: 0.30, noiseFreq: 7 },
    ferdinand: { res: L, seed: 193, base: [0.17, 0.12, 0.10], bright: 1.0, craters: 6, craterSize: 0.22, craterDepth: 0.5, rim: 0.06, noise: 0.32, noiseFreq: 8 },
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
    // Pre-roll placed spots (coronae, bright deposits, scarps).
    const spots = [];
    if (cfg.spots) {
        for (const s of cfg.spots) {
            spots.push({
                dir: dirFromLonLat(s.lon * Math.PI / 180, s.lat * Math.PI / 180),
                r: s.r, cosr: Math.cos(s.r),
                color: s.color || null, bright: s.bright, bump: s.bump || 0,
                strength: s.strength != null ? s.strength : 1,
            });
        }
    }
    // Stable per-moon groove orientation.
    const gAxis = (() => {
        const a = rnd() * Math.PI * 2;
        return [Math.cos(a), Math.sin(a) * 0.6, Math.sin(a)];
    })();

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

            // Grooved corona / chasma terrain — warped parallel ridges.
            if (cfg.grooves) {
                const gf = cfg.grooves.freq;
                const warp = fbm3(dx*2.0, dy*2.0, dz*2.0, 3);
                const proj = dx*gAxis[0] + dy*gAxis[1] + dz*gAxis[2];
                let ridge = Math.abs(Math.sin(proj * gf + warp * 5.0));
                ridge = smooth(0.0, 0.40, ridge);            // sharpen the lineaments
                const groove = (1 - ridge) * cfg.grooves.strength;
                if (cfg.grooves.bright) { shade += groove; height += groove * 0.20; }
                else                    { shade -= groove; height -= groove * 0.20; }
            }

            // Craters.
            let craterShade = 1, rimAdd = 0;
            for (const c of craters) {
                const cosA = dx*c.dir[0] + dy*c.dir[1] + dz*c.dir[2];
                if (cosA <= c.cosr) continue;
                const a = Math.acos(Math.min(1, cosA)) / c.r;  // 0 centre → 1 rim
                craterShade *= 1 - (cfg.craterDepth || 0.5) * (1 - smooth(0.75, 1.0, a)) * (1 - a*0.3);
                if (cfg.rim) rimAdd += cfg.rim * smooth(0.78, 0.96, a) * (1 - smooth(0.96, 1.08, a));
                height -= 0.28 * (1 - a) - 0.10 * smooth(0.8, 1.0, a);
            }
            shade *= craterShade;
            shade += rimAdd;

            // Placed spots (coronae, bright deposits, scarps).
            for (const s of spots) {
                const cosA = dx*s.dir[0] + dy*s.dir[1] + dz*s.dir[2];
                if (cosA <= s.cosr) continue;
                const a = Math.acos(Math.min(1, cosA)) / s.r;  // 0..1
                const w = (1 - smooth(0.55, 1.0, a)) * s.strength;
                if (s.color) {
                    r = lerp(r, s.color[0], w);
                    g = lerp(g, s.color[1], w);
                    b = lerp(b, s.color[2], w);
                } else if (s.bright != null) {
                    shade *= 1 + (s.bright - 1) * w;
                    if (shade < 0) shade = 0;
                }
                height += s.bump * w;
            }

            const o = (j * W + i) * 4;
            const enc = v => Math.round(clamp01(Math.pow(clamp01(v), 1/2.2)) * 255);
            map[o]   = enc(r * shade * bri);
            map[o+1] = enc(g * shade * bri);
            map[o+2] = enc(b * shade * bri);
            map[o+3] = 255;
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
