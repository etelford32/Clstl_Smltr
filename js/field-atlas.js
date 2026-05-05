// js/field-atlas.js
//
// JS wrapper around the rust-sunfield WASM (PFSS-lite field-line tracer).
//
// Three responsibilities:
//   1. Lazy-load and cache the WASM module.
//   2. Run a trace on demand and pack the resulting atlas into Three.js
//      DataTextures (positions / tangents / meta). These textures are the
//      single source of truth that Phase 2 prominence ribbons and Phase 3
//      flare-arcade shaders will sample for geometry.
//   3. Build a debug LineSegments mesh, colour-coded by topology, for the
//      `?debug=field` validation viewer.
//
// Data shapes (matching the Rust crate):
//   activeRegions[i] = { latDeg, lonDeg, area, polarity, tiltDeg, complexity }
//   coronalHoles[i]  = { latDeg, lonDeg, area, sign }
//   params           = { sourceSurface?, step?, maxSteps?, samplesPerLine?,
//                        seedsPerAr?, seedsGlobal?, maxLines? }
//
// Atlas (returned to JS):
//   { lineCount, samplesPerLine, positions, tangents, meta }
//   positions: Float32Array — line × sample × {x,y,z}
//   tangents:  Float32Array — line × sample × {x,y,z}  (unit B̂)
//   meta:      Float32Array — line × 8
//     [0] topology  (0 closed, 1 open+, 2 open-, 3 stray)
//     [1] seedKind  (0 arcade, 1 global, 2 pil)
//     [2] arIndex   (-1 if none)
//     [3] apexHeight (R☉)
//     [4] totalLength (R☉)
//     [5] footALat  (rad, NaN if open at A end)
//     [6] footALon  (rad)
//     [7] reserved (twist — Phase 2)

import * as THREE from 'three';

// ─── module-level cache ─────────────────────────────────────────────
let _wasm = null;
let _initPromise = null;
let _lastAtlas = null;
let _lastTextures = null;

const WASM_URL = './js/sunfield-wasm/sunfield_wasm.js';

/** Load the WASM module once. Idempotent and concurrent-safe. */
export function ensureFieldAtlasWasm() {
    if (_wasm) return Promise.resolve(_wasm);
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
        const mod = await import(WASM_URL);
        await mod.default();
        _wasm = mod;
        return mod;
    })();
    return _initPromise;
}

// ─── trace ──────────────────────────────────────────────────────────

const META_STRIDE = 8;

/**
 * Run the WASM tracer. Returns a plain-object atlas with three Float32Arrays.
 * Throws if the WASM is not yet initialised — call ensureFieldAtlasWasm() first.
 */
export function computeFieldAtlas(activeRegions, coronalHoles, params = {}) {
    if (!_wasm) throw new Error('field-atlas: WASM not initialised — await ensureFieldAtlasWasm() first');
    const result = _wasm.compute_field_lines({
        activeRegions: activeRegions || [],
        coronalHoles:  coronalHoles  || [],
        params,
    });
    const atlas = {
        lineCount:      result.line_count,
        samplesPerLine: result.samples_per_line,
        positions:      new Float32Array(result.positions()),
        tangents:       new Float32Array(result.tangents()),
        meta:           new Float32Array(result.meta()),
    };
    _lastAtlas = atlas;
    _lastTextures = null; // invalidate
    return atlas;
}

/** Most recent atlas, or null. */
export function getFieldAtlas() { return _lastAtlas; }

// ─── DataTexture packing ────────────────────────────────────────────
//
// Layout per texture (RGBA float, sized W = samplesPerLine, H = lineCount,
// except meta which is W = 2, H = lineCount because META_STRIDE = 8 floats).
//
// Three.js shaders read these with:
//   vec4 p = texture2D(uFieldPositions, vec2(s, line));    // s in [0,1]
//   vec3 xyz = p.xyz;
//
// Positions and tangents are RGB+1.0 padding; the alpha lane is reserved
// (we'll repurpose it later for per-sample twist or arclength).

export function buildFieldTextures(atlas) {
    if (!atlas) atlas = _lastAtlas;
    if (!atlas || atlas.lineCount === 0) return null;
    if (_lastTextures && _lastTextures.atlasRef === atlas) return _lastTextures;

    const w = atlas.samplesPerLine;
    const h = atlas.lineCount;
    const N = w * h;

    const posRGBA = new Float32Array(N * 4);
    const tanRGBA = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
        const o3 = i * 3, o4 = i * 4;
        posRGBA[o4    ] = atlas.positions[o3    ];
        posRGBA[o4 + 1] = atlas.positions[o3 + 1];
        posRGBA[o4 + 2] = atlas.positions[o3 + 2];
        posRGBA[o4 + 3] = 1.0;
        tanRGBA[o4    ] = atlas.tangents[o3    ];
        tanRGBA[o4 + 1] = atlas.tangents[o3 + 1];
        tanRGBA[o4 + 2] = atlas.tangents[o3 + 2];
        tanRGBA[o4 + 3] = 0.0;
    }

    const positions = new THREE.DataTexture(posRGBA, w, h, THREE.RGBAFormat, THREE.FloatType);
    const tangents  = new THREE.DataTexture(tanRGBA, w, h, THREE.RGBAFormat, THREE.FloatType);
    // META_STRIDE = 8 → 2 RGBA pixels per line.
    const meta = new THREE.DataTexture(atlas.meta, META_STRIDE / 4, h, THREE.RGBAFormat, THREE.FloatType);

    for (const t of [positions, tangents, meta]) {
        t.minFilter = THREE.NearestFilter;
        t.magFilter = THREE.NearestFilter;
        t.wrapS = THREE.ClampToEdgeWrapping;
        t.wrapT = THREE.ClampToEdgeWrapping;
        t.generateMipmaps = false;
        t.needsUpdate = true;
    }

    _lastTextures = { positions, tangents, meta, atlasRef: atlas };
    return _lastTextures;
}

/** Most recently packed textures (or null). */
export function getFieldTextures() { return _lastTextures; }

/** Free GPU memory held by the cached textures. Safe to call repeatedly. */
export function disposeFieldTextures() {
    if (!_lastTextures) return;
    _lastTextures.positions.dispose();
    _lastTextures.tangents.dispose();
    _lastTextures.meta.dispose();
    _lastTextures = null;
}

// ─── debug viewer ───────────────────────────────────────────────────

const COLOR_CLOSED       = [1.00, 0.85, 0.40]; // gold
const COLOR_OPEN_POS     = [0.40, 0.85, 1.00]; // cyan
const COLOR_OPEN_NEG     = [1.00, 0.40, 0.85]; // magenta
const COLOR_PIL          = [0.55, 1.00, 0.65]; // green tint (PIL-anchored closed loops)
const COLOR_STRAY        = [0.50, 0.50, 0.50]; // gray (shouldn't happen often)

/**
 * Build a single THREE.LineSegments mesh from the atlas, colour-coded by
 * topology. Uses gl.LINES (one segment per (sample i, sample i+1) pair) so
 * we don't need separate draw calls per line.
 *
 * opts:
 *   opacity (default 0.85)
 *   linewidth (default 1; note WebGL ignores >1 on most platforms)
 */
export function buildFieldDebugMesh(atlas, opts = {}) {
    if (!atlas) atlas = _lastAtlas;
    if (!atlas || atlas.lineCount === 0) return new THREE.Group();

    const { lineCount, samplesPerLine, positions, meta } = atlas;
    const segPerLine = samplesPerLine - 1;
    const totalSegs = lineCount * segPerLine;

    const segPos = new Float32Array(totalSegs * 2 * 3);
    const segCol = new Float32Array(totalSegs * 2 * 3);

    for (let i = 0; i < lineCount; i++) {
        const m0 = i * META_STRIDE;
        const topology = meta[m0];
        const seedKind = meta[m0 + 1];

        let col;
        if (topology === 3) col = COLOR_STRAY;
        else if (seedKind === 2 && topology === 0) col = COLOR_PIL;
        else if (topology === 0) col = COLOR_CLOSED;
        else if (topology === 1) col = COLOR_OPEN_POS;
        else                     col = COLOR_OPEN_NEG;

        const base = i * samplesPerLine * 3;
        const segBase = i * segPerLine * 2 * 3;

        for (let s = 0; s < segPerLine; s++) {
            const a = base + s * 3;
            const b = a + 3;
            const o = segBase + s * 2 * 3;
            segPos[o    ] = positions[a    ];
            segPos[o + 1] = positions[a + 1];
            segPos[o + 2] = positions[a + 2];
            segPos[o + 3] = positions[b    ];
            segPos[o + 4] = positions[b + 1];
            segPos[o + 5] = positions[b + 2];

            // Fade alpha-equivalent into colour: brighter at apex, dim near footpoints.
            // (LineBasicMaterial doesn't support per-vertex alpha, so we modulate value.)
            const ta = s        / segPerLine; // 0..1
            const tb = (s + 1)  / segPerLine;
            const fa = 0.55 + 0.45 * Math.sin(Math.PI * ta);
            const fb = 0.55 + 0.45 * Math.sin(Math.PI * tb);
            segCol[o    ] = col[0] * fa;
            segCol[o + 1] = col[1] * fa;
            segCol[o + 2] = col[2] * fa;
            segCol[o + 3] = col[0] * fb;
            segCol[o + 4] = col[1] * fb;
            segCol[o + 5] = col[2] * fb;
        }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(segPos, 3));
    geom.setAttribute('color',    new THREE.BufferAttribute(segCol, 3));

    const mat = new THREE.LineBasicMaterial({
        vertexColors:  true,
        transparent:   true,
        opacity:       opts.opacity ?? 0.85,
        depthWrite:    false,
        blending:      THREE.AdditiveBlending,
        linewidth:     opts.linewidth ?? 1,
    });

    const mesh = new THREE.LineSegments(geom, mat);
    mesh.userData.fieldAtlasDebug = true;
    return mesh;
}

/** Free a debug mesh built by buildFieldDebugMesh. */
export function disposeFieldDebugMesh(mesh) {
    if (!mesh) return;
    mesh.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
    });
}

// ─── adapters: sun.html data shapes → WASM input shapes ────────────

/**
 * Convert sun.html's liveRegions to the WASM activeRegions shape.
 * Requires the page's parseLoc(loc) -> { lat, lon } helper.
 *
 * Heuristics for fields not present in the SWPC feed:
 *   - polarity:   Hale-law proxy from hemisphere (cycle 25 N=positive).
 *   - tiltDeg:    Joy's-law proxy ≈ 0.5 × lat (signed by hemisphere).
 *   - complexity: 0=α, 1=β, 2=β-γ, 3=β-γ-δ — parsed from mag_class string.
 *   - area:       normalised from millionths-of-disk (cap at ~800).
 */
export function arsFromLiveRegions(liveRegions, parseLoc) {
    if (!liveRegions || !liveRegions.length) return [];
    return liveRegions.map(r => {
        const ll = parseLoc(r.loc);
        if (!ll) return null;

        const mag = String(r.mag || '').toLowerCase();
        let complexity = 1; // β default
        if (mag.includes('delta') || mag.includes('β-γ-δ') || mag.includes('beta-gamma-delta') || mag.includes('bgd')) {
            complexity = 3;
        } else if (mag.includes('gamma') || mag.includes('β-γ') || mag.includes('beta-gamma') || mag.includes('bg')) {
            complexity = 2;
        } else if (mag === 'a' || mag.includes('alpha') || mag.includes('α')) {
            complexity = 0;
        }

        const polarity = ll.lat >= 0 ? 1 : -1;
        const tiltDeg  = 0.5 * ll.lat;
        const area     = Math.max(0.05, Math.min(1, (r.area || 50) / 800));

        return { latDeg: ll.lat, lonDeg: ll.lon, area, polarity, tiltDeg, complexity };
    }).filter(Boolean);
}

/**
 * Default polar coronal holes when no live hole feed is available.
 * `activity` ∈ [0,1]: solar maximum has smaller polar holes; minimum larger.
 */
export function defaultPolarHoles(activity = 0.5) {
    const sz = 0.30 + 0.30 * (1 - Math.max(0, Math.min(1, activity)));
    return [
        { latDeg:  85, lonDeg:   0, area: sz, sign:  1 },
        { latDeg: -85, lonDeg: 180, area: sz, sign: -1 },
    ];
}

// ─── Phase 2/3 helpers (preview API — used by upcoming prominence/flare shaders) ─

/**
 * Group line indices by AR. Returns { arIndex -> { all, pil, arcade } } where
 * each is a sorted array of line indices into the atlas. Phase 2 prominence
 * ribbons read `pil`; Phase 3 flare arcades read `arcade`.
 */
export function indexLinesByAr(atlas) {
    if (!atlas) atlas = _lastAtlas;
    if (!atlas) return new Map();
    const out = new Map();
    for (let i = 0; i < atlas.lineCount; i++) {
        const m0 = i * META_STRIDE;
        const seedKind = atlas.meta[m0 + 1];
        const arIdx    = atlas.meta[m0 + 2];
        if (arIdx < 0) continue;
        const key = arIdx | 0;
        if (!out.has(key)) out.set(key, { all: [], pil: [], arcade: [] });
        const entry = out.get(key);
        entry.all.push(i);
        if (seedKind === 2)      entry.pil.push(i);
        else if (seedKind === 0) entry.arcade.push(i);
    }
    return out;
}
