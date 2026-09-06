/**
 * corona-loop-density.js — PFSS field lines → loop-density volume, and the
 * white-light K / F-corona line-of-sight integrals (plan Phase 3)
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE: no DOM, no three, no fetch — `tests/corona-volumetric.mjs` gates it.
 *
 * ── Loop density ────────────────────────────────────────────────────────
 * The DEM raymarcher (js/corona-volumetric.js) used to invent its arcades as
 * half-tori around each AR and its coronal holes as Gaussian cells. Both are
 * now DERIVED from field topology: the PFSS-lite atlas (`js/field-atlas.js`,
 * rust-sunfield) is splatted into a `size`³ voxel grid —
 *
 *     R = closed-line density   → lights the arcades as a DEM term
 *     G = open-line density     → suppresses emission (coronal holes)
 *
 * — on a SHELL grid (longitude × latitude × stretched height), not a
 * Cartesian cube: the corona is a thin shell and the traced AR arcades peak
 * only 0.005–0.15 R☉ up (measured 0.007 for the buried-dipole seeds), which
 * a 64³ cube (voxel 0.078 R☉) could not resolve at all. Height is stored
 * as h_n = √((r−1)/(r_max−1)), so slice 1 of 32 already sits at 1.5 Mm and
 * the low corona gets most of the resolution. Stored as a 2-D SLICE ATLAS
 * (tilesX × tilesY tiles of NLON × NLAT) so the shader reads it with two
 * bilinear `texture2D` taps and a slice mix on GLSL ES 1.0 (no sampler3D).
 * The longitude seam (±180°, far side) is a one-cell discontinuity by
 * construction — bilinear cannot wrap across tiles; accepted, far side.
 * Each line contributes equal total weight (1/samplesPerLine per sample,
 * trilinear splat), each channel is normalised at its 99th percentile, and
 * the stored byte is √(density/norm) — a 20-loop stack and a lone polar loop
 * then land at 1.0 and ~0.2 instead of 1.0 and 0.016 (measured), so faint
 * structure survives 8 bits. The shader SQUARES the read back to linear
 * density before using it. `sampleLoopDensity` is the JS mirror of the
 * shader read (encoded value) — the test pins the two agree.
 *
 * ── K and F corona ──────────────────────────────────────────────────────
 * Thomson-scattered K-corona brightness at impact parameter b (R☉) from the
 * Baumbach–Allen electron density
 *     n_e(r) = 10⁸ (0.036 r⁻¹·⁵ + 1.55 r⁻⁶ + 2.99 r⁻¹⁶) cm⁻³,
 * integrated along the whole line of sight in closed form:
 *     ∫ (b² + s²)^(−k/2) ds = b^(1−k) · √π Γ((k−1)/2) / Γ(k/2).
 * The scattering-angle and limb-darkening factors of the full Thomson
 * kernel are omitted (they change the profile by tens of percent, not the
 * orders of magnitude the power laws span) and the result is normalised to
 * 1 at the limb. The F-corona (dust, van de Hulst) is the empirical b⁻²·³,
 * set to 10 % of K at the limb. Both are MIRRORED in sun.html's coronaFS
 * with the same constants — change here first, then the GLSL.
 */

export const LOOP_GRID_SIZE = 64;      // legacy name; see LOOP_DIMS
export const LOOP_DIMS = Object.freeze({ nlon: 256, nlat: 128, nh: 32 });
export const LOOP_RMAX = 2.5;          // R☉ — the volumetric corona's outer radius
export const TOPOLOGY = Object.freeze({ CLOSED: 0, OPEN_POS: 1, OPEN_NEG: 2, STRAY: 3 });
export const META_STRIDE = 8;

/** 2-D slice-atlas layout for an nlon × nlat × nh shell grid (height slices tiled). */
export function atlasLayout(dims = LOOP_DIMS) {
    const { nlon, nlat, nh } = dims;
    const tilesX = Math.max(1, Math.round(Math.sqrt(nh * nlat / nlon)));
    const tilesY = Math.ceil(nh / tilesX);
    return { nlon, nlat, nh, tilesX, tilesY, width: tilesX * nlon, height: tilesY * nlat };
}

/** Pixel offset (x, y) of shell voxel (ilon, ilat, ih) inside the slice atlas. */
export function atlasPixel(ilon, ilat, ih, layout) {
    const tx = ih % layout.tilesX, ty = Math.floor(ih / layout.tilesX);
    return [tx * layout.nlon + ilon, ty * layout.nlat + ilat];
}

/** Sun-local point (R☉) → continuous shell-grid coordinates (lon, lat, h index); null outside. */
export function shellCoords(p, dims, rMax) {
    const r = Math.hypot(p[0], p[1], p[2]);
    if (!(r >= 1) || r > rMax) return null;
    const lon = Math.atan2(p[0], p[2]);                         // scene convention: lon = atan(x, z)
    const lat = Math.asin(Math.max(-1, Math.min(1, p[1] / r)));
    const hn = Math.sqrt((r - 1) / (rMax - 1));
    return [(lon / (2 * Math.PI) + 0.5) * dims.nlon - 0.5, (lat / Math.PI + 0.5) * dims.nlat - 0.5, hn * (dims.nh - 1)];
}

function percentile(arr, p) {
    const nz = [];
    for (let i = 0; i < arr.length; i++) if (arr[i] > 0) nz.push(arr[i]);
    if (!nz.length) return 0;
    nz.sort((a, b) => a - b);
    return nz[Math.min(nz.length - 1, Math.floor(p * (nz.length - 1)))];
}

/**
 * Splat the atlas's polylines into the voxel grid.
 * @param {{ lineCount:number, samplesPerLine:number, positions:Float32Array, meta:Float32Array }} atlas
 * @param {{ size?:number, rMax?:number, maxLines?:number }} [opts]
 * @returns {{ data:Uint8Array, layout, size, rMax, stats }} RGBA slice atlas + stats
 */
export function rasterizeLoopDensity(atlas, opts = {}) {
    const dims = opts.dims ?? LOOP_DIMS;
    const rMax = opts.rMax ?? LOOP_RMAX;
    const layout = atlasLayout(dims);
    const { nlon, nlat, nh } = dims;
    const nvox = nlon * nlat * nh;
    const closed = new Float32Array(nvox);
    const open   = new Float32Array(nvox);
    const stats = { closed: 0, open: 0, stray: 0, splats: 0, lines: 0 };
    const idx = (il, ia, ih) => (ih * nlat + ia) * nlon + il;
    if (!atlas || !atlas.lineCount || !atlas.positions) {
        return { data: new Uint8Array(layout.width * layout.height * 4), layout, dims, rMax, stats, empty: true };
    }
    const n = atlas.samplesPerLine;
    const lines = Math.min(atlas.lineCount, opts.maxLines ?? atlas.lineCount);
    const w = 1 / n;
    for (let l = 0; l < lines; l++) {
        const topo = atlas.meta ? atlas.meta[l * META_STRIDE] : TOPOLOGY.CLOSED;
        if (topo === TOPOLOGY.STRAY) { stats.stray++; continue; }
        const grid = topo === TOPOLOGY.CLOSED ? closed : open;
        if (topo === TOPOLOGY.CLOSED) stats.closed++; else stats.open++;
        stats.lines++;
        for (let s = 0; s < n; s++) {
            const o = (l * n + s) * 3;
            const c = shellCoords([atlas.positions[o], atlas.positions[o + 1], atlas.positions[o + 2]], dims, rMax);
            if (!c) continue;
            const [vl, va, vh] = c;
            const l0 = Math.floor(vl), a0 = Math.floor(va), h0 = Math.floor(vh);
            const fl = vl - l0, fa = va - a0, fh = vh - h0;
            for (let dh = 0; dh <= 1; dh++) for (let da = 0; da <= 1; da++) for (let dl = 0; dl <= 1; dl++) {
                const il = ((l0 + dl) % nlon + nlon) % nlon;          // longitude wraps
                const ia = a0 + da, ih = h0 + dh;
                if (ia < 0 || ia >= nlat || ih < 0 || ih >= nh) continue;
                const wt = (dl ? fl : 1 - fl) * (da ? fa : 1 - fa) * (dh ? fh : 1 - fh) * w;
                grid[idx(il, ia, ih)] += wt;
                stats.splats++;
            }
        }
    }
    const cNorm = percentile(closed, 0.99) || 1;
    const oNorm = percentile(open, 0.99) || 1;
    const data = new Uint8Array(layout.width * layout.height * 4);
    for (let ih = 0; ih < nh; ih++) for (let ia = 0; ia < nlat; ia++) for (let il = 0; il < nlon; il++) {
        const v = idx(il, ia, ih);
        const [px, py] = atlasPixel(il, ia, ih, layout);
        const p = (py * layout.width + px) * 4;
        data[p]     = Math.min(255, Math.round(255 * Math.sqrt(closed[v] / cNorm)));
        data[p + 1] = Math.min(255, Math.round(255 * Math.sqrt(open[v] / oNorm)));
        data[p + 2] = 0;
        data[p + 3] = 255;
    }
    return { data, layout, dims, rMax, stats, empty: stats.lines === 0 };
}

/**
 * JS mirror of the shader's read: trilinear over the slice atlas, returns the
 * ENCODED [√closed, √open] in 0..1 for a sun-local point (R☉).
 */
export function sampleLoopDensity(rast, p) {
    const { data, layout, dims, rMax } = rast;
    const c = shellCoords(p, dims, rMax);
    if (!c) return [0, 0];
    const { nlon, nlat, nh } = dims;
    const [vl, va, vh] = c;
    const l0 = Math.floor(vl), a0 = Math.floor(va), h0 = Math.floor(vh);
    const fl = vl - l0, fa = va - a0, fh = vh - h0;
    const read = (il, ia, ih, ch) => {
        il = Math.max(0, Math.min(nlon - 1, il)); ia = Math.max(0, Math.min(nlat - 1, ia)); ih = Math.max(0, Math.min(nh - 1, ih));   // clamp (shader: no wrap across tiles)
        const [px, py] = atlasPixel(il, ia, ih, layout);
        return data[(py * layout.width + px) * 4 + ch] / 255;
    };
    const out = [0, 0];
    for (let ch = 0; ch < 2; ch++) {
        let acc = 0;
        for (let dh = 0; dh <= 1; dh++) for (let da = 0; da <= 1; da++) for (let dl = 0; dl <= 1; dl++) {
            acc += read(l0 + dl, a0 + da, h0 + dh, ch) * (dl ? fl : 1 - fl) * (da ? fa : 1 - fa) * (dh ? fh : 1 - fh);
        }
        out[ch] = acc;
    }
    return out;
}

/** Build a synthetic atlas from explicit polylines — for tests and demos. */
export function atlasFromPolylines(lines) {
    const n = Math.max(...lines.map(l => l.points.length));
    const positions = new Float32Array(lines.length * n * 3);
    const meta = new Float32Array(lines.length * META_STRIDE);
    lines.forEach((l, li) => {
        for (let s = 0; s < n; s++) {
            const p = l.points[Math.min(s, l.points.length - 1)];
            positions.set(p, (li * n + s) * 3);
        }
        meta[li * META_STRIDE] = l.topology ?? TOPOLOGY.CLOSED;
    });
    return { lineCount: lines.length, samplesPerLine: n, positions, meta, tangents: new Float32Array(0) };
}

// ── K / F corona ───────────────────────────────────────────────────────────

const SQRT_PI = Math.sqrt(Math.PI);
/** Lanczos Γ for the LOS constants (only ever called at construction). */
function gamma(z) {
    const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
        -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
    z -= 1;
    let x = c[0];
    for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
    const t = z + g + 0.5;
    return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}
/** ∫ (b²+s²)^(−k/2) ds over the whole line = b^(1−k) · losConst(k). */
export function losConst(k) { return SQRT_PI * gamma((k - 1) / 2) / gamma(k / 2); }

export const BAUMBACH_ALLEN = Object.freeze([[0.036, 1.5], [1.55, 6.0], [2.99, 16.0]]);
const K_TERMS = BAUMBACH_ALLEN.map(([a, k]) => [a * losConst(k), k]);
const K_LIMB = K_TERMS.reduce((s, [c]) => s + c, 0);

/** Normalised K-corona LOS brightness at impact parameter b (R☉): kCoronaLos(1) = 1. */
export function kCoronaLos(b) {
    if (!(b >= 1)) return b > 0 ? kCoronaLos(1) : 0;
    let s = 0;
    for (const [c, k] of K_TERMS) s += c * Math.pow(b, 1 - k);
    return s / K_LIMB;
}

export const F_LIMB_FRACTION = 0.10;
/** F-corona (dust) LOS brightness, b⁻²·³, 10 % of K at the limb. */
export function fCoronaLos(b) {
    if (!(b >= 1)) return b > 0 ? F_LIMB_FRACTION : 0;
    return F_LIMB_FRACTION * Math.pow(b, -2.3);
}

/** The constants the GLSL mirror must carry (printed by the test for copy-checking). */
export function kCoronaGlslConstants() {
    return { terms: K_TERMS.map(([c, k]) => [c / K_LIMB, 1 - k]), fLimb: F_LIMB_FRACTION, fExp: -2.3 };
}
