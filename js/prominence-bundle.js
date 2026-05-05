// js/prominence-bundle.js
//
// Phase 2 prominence renderer — microhair bundle scaffold.
//
// Each PIL-anchored closed loop in the field-line atlas spawns a bundle of N
// thin instanced ribbons ("threads"). Threads are real geometry, not a
// texture: hundreds of separate instances, each sampling tFieldPositions and
// tFieldTangents along its parent line and offset laterally to fan out the
// bundle. The structure produces real parallax, depth occlusion, and
// per-thread animation (counter-streaming, brightening cycles, Alfvén
// oscillation).
//
// First cut: QP (quiescent-class) only. The shader has hooks for the other
// six classes (IP, ARP, hedgerow, tornado, eruptive, post-flare rain) but
// branching on classId comes in the next pass — for now everything renders
// as QP. The point of this scaffold is the *pipeline*: WASM → atlas → field
// textures → instanced bundle → screen.
//
// On-disk vs limb is unified via premultiplied-alpha custom blending:
//   src factor = ONE,  dst factor = ONE_MINUS_SRC_ALPHA.
// Limb (camera looking past the bundle into space):  bright additive Hα.
// Disk (bundle in front of the photosphere):         dark filament absorption.
// One material, one draw call, no depth-sort gymnastics.

import * as THREE from 'three';

// ─── Quality tiers — peak active thread budget ──────────────────────
export const THREAD_BUDGETS = Object.freeze({ low: 50, mid: 500, high: 1500 });

// ─── Class catalog (subset — full taxonomy lands later) ─────────────
export const CLASS = Object.freeze({
    QP:       0, // quiescent (long polar/mid-lat filaments)
    IP:       1, // intermediate (decayed-AR filaments) — Phase 2.2
    ARP:      2, // active-region prominence            — Phase 2.2
    HEDGEROW: 3, // wall / vertical-thread curtain      — Phase 2.3
    TORNADO:  4, // strongly twisted rope               — Phase 2.3
    EP:       5, // eruptive                            — Phase 2.4
    RAIN:     6, // post-flare loop arcade rain         — Phase 3
});

// ─── Geometry: a single shared ribbon strip ─────────────────────────
//
// 32 segments along arclength (s ∈ [0,1]), 2 verts wide (t ∈ {-1,+1}).
// Total: 66 vertices, 192 triangles per instance. With 1500 instances peak
// that's 288k triangles — comfortably under any mid-range GPU budget.
const STRIP_SEGMENTS = 32;

function buildStripGeometry() {
    const segs = STRIP_SEGMENTS;
    const verts = (segs + 1) * 2;
    const aS = new Float32Array(verts);
    const aT = new Float32Array(verts);
    for (let i = 0; i <= segs; i++) {
        const s = i / segs;
        aS[i * 2    ] = s;  aT[i * 2    ] = -1;
        aS[i * 2 + 1] = s;  aT[i * 2 + 1] =  1;
    }
    const idx = [];
    for (let i = 0; i < segs; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, b, c,  b, d, c);
    }
    const geom = new THREE.InstancedBufferGeometry();
    geom.setAttribute('aS', new THREE.BufferAttribute(aS, 1));
    geom.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
    geom.setIndex(idx);
    // a placeholder 'position' attribute is required by Three.js for some
    // pipeline checks even though we compute position entirely in the shader
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    return geom;
}

// ─── Shaders ────────────────────────────────────────────────────────

const VERT = /* glsl */ `
precision highp float;

attribute float aS;       // [0,1] along arclength (per-vertex)
attribute float aT;       // {-1,+1} ribbon-width sign (per-vertex)

attribute float aLineIdx;     // which atlas line this thread follows
attribute float aThreadId;    // [0,1] thread id within bundle (per-instance)
attribute vec2  aOffset;      // (Nfrac, Bfrac) lateral offset within bundle frame
attribute float aBundleNorm;  // [0,1] brightness normalisation (length × apex)
attribute float aClassId;     // CLASS.* — selects behavior in vert + frag

uniform sampler2D tFieldPositions;   // RGBA float, W=samplesPerLine, H=lineCount
uniform sampler2D tFieldTangents;
uniform float uLineCount;
uniform float uTime;
uniform float uActivity;
uniform float uThreadHalfWidth;       // R☉ — physical thread half-width
uniform float uBundleHalfRadius;      // R☉ — bundle lateral radius

varying float vS;
varying float vT;
varying float vThreadId;
varying float vBundleNorm;
varying float vClassId;
varying vec3  vWorldPos;
varying vec3  vSurfaceNormal;

#define PI 3.141592653589793

void main() {
    float lineV = (aLineIdx + 0.5) / uLineCount;
    vec3 P = texture2D(tFieldPositions, vec2(aS, lineV)).xyz;
    vec3 T = normalize(texture2D(tFieldTangents, vec2(aS, lineV)).xyz);

    // Local frame: outward radial, ribbon-width N, ribbon-flat B.
    vec3 outward = normalize(P);
    vec3 N = normalize(cross(T, outward) + vec3(1e-6));
    vec3 B = normalize(cross(N, T));

    // Lateral offset within the bundle (each thread sits in its own column).
    vec3 lateral = N * (aOffset.x * uBundleHalfRadius)
                 + B * (aOffset.y * uBundleHalfRadius);

    // Apex sag: cool plasma sags toward the photosphere. Sin(πs) puts max
    // displacement at the loop apex; magnitude scales with class.
    float sagMag = 0.005;                         // QP: gentle, ~3.5 Mm
    float sag = sagMag * sin(PI * aS) * sin(PI * aS);

    // Alfvén transverse oscillation. Different per-thread phase produces a
    // shimmer rather than a synchronised wave. Disabled at low-end activity.
    float alfvenAmp = 0.0012 * (0.5 + 0.5 * uActivity);  // ~0.85 Mm peak
    float alfvenFreq = 0.85;                              // ~7 s period
    float wob = sin(uTime * alfvenFreq + aThreadId * 13.0 + aS * 4.0)
              * alfvenAmp * sin(PI * aS);

    // Ribbon edge offset (the +/-1 of aT widens the strip into a ribbon).
    vec3 widen = N * (aT * uThreadHalfWidth);

    vec3 pos = P + lateral - outward * sag + N * wob + widen;

    vWorldPos = pos;
    vSurfaceNormal = outward;
    vS = aS;
    vT = aT;
    vThreadId = aThreadId;
    vBundleNorm = aBundleNorm;
    vClassId = aClassId;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

varying float vS;
varying float vT;
varying float vThreadId;
varying float vBundleNorm;
varying float vClassId;
varying vec3  vWorldPos;
varying vec3  vSurfaceNormal;

uniform float uTime;
uniform float uActivity;
uniform vec3  uCameraPos;

#define PI 3.141592653589793

void main() {
    // ── Counter-streaming flow ──────────────────────────────────────
    // Adjacent threads carry plasma in opposite directions at ~10–25 km/s.
    // Sign chosen by thread id parity → bright dashes scrolling either way.
    float flowSign = (mod(floor(vThreadId * 47.0), 2.0) < 1.0) ? 1.0 : -1.0;
    float scrollSpeed = 0.18;
    float scrollPhase = (vS - flowSign * uTime * scrollSpeed) * 14.0
                      + vThreadId * 6.28;
    float dashes = 0.5 + 0.5 * sin(scrollPhase);
    dashes = pow(dashes, 1.6);                  // sharper bright bands

    // ── Per-thread brightening cycle ───────────────────────────────
    // Real threads cycle bright/dim on ~minute timescales (thermal
    // non-equilibrium). Different phases per thread → bundle shimmers.
    float bright = 0.65 + 0.35 * sin(uTime * 0.42 + vThreadId * 9.7);

    // ── Arch shape: brighter at footpoints AND apex, slight mid-loop dip.
    float foot = pow(sin(PI * vS), 0.6);
    float archShape = 0.45 + 0.55 * foot;

    // ── Ribbon edge softening (anti-aliased thread edges). ─────────
    float edge = 1.0 - abs(vT);
    edge = smoothstep(0.0, 0.3, edge);

    // ── Hα palette, cool→warm along arclength. ─────────────────────
    // Footpoints: red-pink (~7000 K base). Apex: pink-magenta (cooler core).
    vec3 colFoot = vec3(0.92, 0.22, 0.34);
    vec3 colApex = vec3(0.88, 0.46, 0.68);
    vec3 col = mix(colFoot, colApex, foot);

    // ── Class-specific tint (QP only for now; hooks in place). ─────
    if (vClassId > 0.5 && vClassId < 1.5) {       // IP
        col *= vec3(1.05, 0.95, 0.95);
    } else if (vClassId > 1.5 && vClassId < 2.5) {// ARP
        col = mix(col, vec3(1.00, 0.42, 0.30), 0.35);
    } else if (vClassId > 4.5 && vClassId < 5.5) {// EP — blueshift toward white-blue
        col = mix(col, vec3(0.85, 0.92, 1.10), 0.55);
    }
    // QP (0), HEDGEROW (3), TORNADO (4), RAIN (6) → palette unchanged for now.

    float intensity = vBundleNorm * archShape * bright
                    * (0.55 + 0.45 * dashes)
                    * edge;

    // ── On-disk vs limb mode (unified shader, premultiplied-alpha blend).
    // facing > 0 → outward normal points toward the camera → on-disk.
    // facing < 0 → outward normal points away from camera → limb / off-limb.
    vec3 toCam = normalize(uCameraPos - vWorldPos);
    float facing = dot(vSurfaceNormal, toCam);
    float disk = smoothstep(0.10, 0.45, facing);

    // Disk path: dark Hα absorption — black premultiplied with intensity.
    vec3  colDisk = vec3(0.0);
    float aDisk = clamp(intensity * 0.85, 0.0, 0.92);

    // Limb path: bright Hα emission — colour premultiplied with intensity,
    // alpha 0 so it adds on top of the existing scene.
    vec3  colLimb = col * intensity * 1.6;
    float aLimb = 0.0;

    vec3  outRgb = mix(colLimb, colDisk, disk);
    float outA   = mix(aLimb,   aDisk,   disk);

    // Premultiplied alpha: src factor must be ONE in the material.
    gl_FragColor = vec4(outRgb, outA);
}
`;

// ─── System factory ─────────────────────────────────────────────────

const DEFAULT_BUNDLE_HALF_RADIUS = 0.012;   // R☉ ≈ 8 Mm  (QP nominal)
const DEFAULT_THREAD_HALF_WIDTH  = 0.0006;  // R☉ ≈ 0.4 Mm (microhair scale)

/**
 * Create a prominence-bundle rendering system attached to a Three.js scene.
 *
 * @param {object} opts
 * @param {THREE.Scene} opts.scene   — scene to attach the InstancedMesh to
 * @param {'low'|'mid'|'high'} [opts.quality='mid'] — peak thread budget tier
 *
 * @returns handle with:
 *   .update(atlas, textures)  — recompute instance attrs from new atlas
 *   .tick(timeSec)            — advance shader time uniform
 *   .setQuality(q)            — change tier (forces re-update on next .update)
 *   .setVisible(b)
 *   .dispose()                — full GPU cleanup
 */
export function createProminenceBundleSystem({ scene, quality = 'mid' } = {}) {
    if (!scene) throw new Error('prominence-bundle: scene is required');

    let _quality = quality;
    let _budget = THREAD_BUDGETS[_quality] ?? THREAD_BUDGETS.mid;

    const stripGeom = buildStripGeometry();

    // Allocate instance attributes at the high-water mark so we never have to
    // re-create the geometry. setDrawRange() lets us tell Three.js how many
    // instances to actually render.
    const MAX_INSTANCES = THREAD_BUDGETS.high;
    const aLineIdx    = new Float32Array(MAX_INSTANCES);
    const aThreadId   = new Float32Array(MAX_INSTANCES);
    const aOffset     = new Float32Array(MAX_INSTANCES * 2);
    const aBundleNorm = new Float32Array(MAX_INSTANCES);
    const aClassId    = new Float32Array(MAX_INSTANCES);

    stripGeom.setAttribute('aLineIdx',    new THREE.InstancedBufferAttribute(aLineIdx, 1));
    stripGeom.setAttribute('aThreadId',   new THREE.InstancedBufferAttribute(aThreadId, 1));
    stripGeom.setAttribute('aOffset',     new THREE.InstancedBufferAttribute(aOffset, 2));
    stripGeom.setAttribute('aBundleNorm', new THREE.InstancedBufferAttribute(aBundleNorm, 1));
    stripGeom.setAttribute('aClassId',    new THREE.InstancedBufferAttribute(aClassId, 1));
    stripGeom.instanceCount = 0;

    const uniforms = {
        tFieldPositions:    { value: null },
        tFieldTangents:     { value: null },
        uLineCount:         { value: 1 },
        uTime:              { value: 0 },
        uActivity:          { value: 0.5 },
        uThreadHalfWidth:   { value: DEFAULT_THREAD_HALF_WIDTH },
        uBundleHalfRadius:  { value: DEFAULT_BUNDLE_HALF_RADIUS },
        uCameraPos:         { value: new THREE.Vector3() },
    };

    const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader:   VERT,
        fragmentShader: FRAG,
        transparent:    true,
        depthWrite:     false,
        side:           THREE.DoubleSide,
        blending:       THREE.CustomBlending,
        blendSrc:       THREE.OneFactor,
        blendDst:       THREE.OneMinusSrcAlphaFactor,
        blendEquation:  THREE.AddEquation,
    });

    const mesh = new THREE.Mesh(stripGeom, material);
    mesh.frustumCulled = false;        // bundle radius >> mesh bbox; just always draw
    mesh.renderOrder = 5;              // after photosphere, before postprocess
    mesh.userData.label = 'prominence bundles (Phase 2 scaffold)';
    scene.add(mesh);

    const handle = {
        mesh, material, uniforms,
        get quality() { return _quality; },
        get threadBudget() { return _budget; },
        get activeThreads() { return stripGeom.instanceCount; },

        setQuality(q) {
            if (!(q in THREAD_BUDGETS)) return;
            _quality = q;
            _budget = THREAD_BUDGETS[q];
        },

        setVisible(b) { mesh.visible = !!b; },

        update(atlas, textures, opts = {}) {
            updateInstances(atlas, textures, _budget, {
                aLineIdx, aThreadId, aOffset, aBundleNorm, aClassId,
            }, stripGeom, uniforms, opts);
        },

        tick(timeSec, cameraPos) {
            uniforms.uTime.value = timeSec;
            if (cameraPos) uniforms.uCameraPos.value.copy(cameraPos);
        },

        dispose() {
            scene.remove(mesh);
            stripGeom.dispose();
            material.dispose();
        },
    };
    return handle;
}

// ─── Instance assignment ────────────────────────────────────────────
//
// Walks the atlas, picks PIL-anchored closed loops as bundle parents, and
// distributes the thread budget across them proportional to a soft
// length × apex weight. Trivial PILs aren't culled — they're attenuated
// via aBundleNorm so they fade toward zero brightness instead of vanishing
// abruptly.

const META_STRIDE = 8;

function updateInstances(atlas, textures, budget, attrs, geom, uniforms, opts) {
    if (!atlas || !textures || atlas.lineCount === 0) {
        geom.instanceCount = 0;
        return;
    }

    uniforms.tFieldPositions.value = textures.positions;
    uniforms.tFieldTangents.value  = textures.tangents;
    uniforms.uLineCount.value = atlas.lineCount;
    if (typeof opts.activity === 'number') uniforms.uActivity.value = opts.activity;

    // 1. Collect candidate bundle parent lines: PIL-anchored CLOSED loops.
    //    (closed = topology 0; PIL = seedKind 2)
    const candidates = [];
    const meta = atlas.meta;
    for (let i = 0; i < atlas.lineCount; i++) {
        const m0 = i * META_STRIDE;
        const topology = meta[m0];
        const seedKind = meta[m0 + 1];
        if (topology !== 0 || seedKind !== 2) continue;
        const apex   = meta[m0 + 3];
        const length = meta[m0 + 4];
        // Soft-clamp normalisation: brightness scales with size but is
        // already capped, so trivial PILs render dim instead of getting
        // visually overdone (per design).
        const weight = clamp(apex / 0.05, 0, 1) * clamp(length / 0.30, 0, 1);
        candidates.push({ i, apex, length, weight });
    }

    if (candidates.length === 0) {
        geom.instanceCount = 0;
        return;
    }

    // 2. Distribute the thread budget across candidates proportional to
    //    weight, but with a floor (every bundle gets at least 1 thread).
    const totalW = candidates.reduce((s, c) => s + Math.max(0.05, c.weight), 0);
    let remaining = Math.min(budget, THREAD_BUDGETS.high);
    const allocs = candidates.map(c => {
        const share = (Math.max(0.05, c.weight) / totalW) * budget;
        return Math.max(1, Math.round(share));
    });
    // Trim if over-budget (rounding can push us over).
    let allocSum = allocs.reduce((s, n) => s + n, 0);
    while (allocSum > remaining && allocs.some(n => n > 1)) {
        const idx = allocs.indexOf(Math.max(...allocs));
        allocs[idx] -= 1;
        allocSum -= 1;
    }

    // 3. Fill instance attributes. A small deterministic PRNG keeps
    //    thread positions stable across atlas updates with the same input.
    const aLineIdx    = attrs.aLineIdx;
    const aThreadId   = attrs.aThreadId;
    const aOffset     = attrs.aOffset;
    const aBundleNorm = attrs.aBundleNorm;
    const aClassId    = attrs.aClassId;

    let n = 0;
    for (let bi = 0; bi < candidates.length; bi++) {
        const cand = candidates[bi];
        const nThreads = allocs[bi];
        const norm = clamp(0.20 + 0.80 * cand.weight, 0, 1);
        const rng = mulberry32(0x9E3779B9 ^ (cand.i * 0x85EBCA6B));

        for (let ti = 0; ti < nThreads; ti++) {
            if (n >= MAX_INSTANCES) break;
            const tid = (ti + 0.5) / nThreads;     // [0,1]
            // Lateral offset: uniform in a 2D disc within the bundle frame.
            const r = Math.sqrt(rng()) * 1.0;
            const a = rng() * Math.PI * 2;
            aLineIdx[n]    = cand.i;
            aThreadId[n]   = tid;
            aOffset[n * 2    ] = Math.cos(a) * r;
            aOffset[n * 2 + 1] = Math.sin(a) * r * 0.6; // squash B-direction (loop is wider than tall)
            aBundleNorm[n] = norm;
            aClassId[n]    = CLASS.QP;
            n++;
        }
        if (n >= MAX_INSTANCES) break;
    }

    // 4. Mark attributes dirty + tell Three.js how many instances to draw.
    geom.attributes.aLineIdx.needsUpdate    = true;
    geom.attributes.aThreadId.needsUpdate   = true;
    geom.attributes.aOffset.needsUpdate     = true;
    geom.attributes.aBundleNorm.needsUpdate = true;
    geom.attributes.aClassId.needsUpdate    = true;
    geom.instanceCount = n;
}

const MAX_INSTANCES = THREAD_BUDGETS.high;

// ─── tiny utilities ─────────────────────────────────────────────────

function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

/** Deterministic 32-bit PRNG. Seed → [0,1) generator. */
function mulberry32(seed) {
    let s = seed >>> 0;
    return function() {
        s |= 0; s = (s + 0x6D2B79F5) | 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Map a string ('low'|'mid'|'high') to a known quality key. Defaults to 'mid'. */
export function getQualityFromString(s) {
    s = String(s || '').toLowerCase();
    if (s === 'low' || s === 'lo' || s === 'l') return 'low';
    if (s === 'high' || s === 'hi' || s === 'h') return 'high';
    return 'mid';
}
