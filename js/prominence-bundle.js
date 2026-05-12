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
// All seven classes (QP, IP, ARP, HEDGEROW, TORNADO, EP, RAIN) share this
// shader; class-specific behaviors are switched on aClassId + aClassParams.
// The classifier in js/prominence-classifier.js decides class per bundle
// from the atlas + live AR/flare feed.
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
attribute vec4  aClassParams; // class-specific parameters (see classifier)

uniform sampler2D tFieldPositions;   // RGBA float, W=samplesPerLine, H=lineCount
uniform sampler2D tFieldTangents;
uniform float uLineCount;
uniform float uTime;
uniform float uActivity;
uniform float uThreadHalfWidth;       // R☉ — physical thread half-width
uniform float uBundleHalfRadius;      // R☉ — bundle lateral radius (QP nominal)

varying float vS;
varying float vT;
varying float vThreadId;
varying float vBundleNorm;
varying float vClassId;
varying vec4  vClassParams;
varying vec3  vWorldPos;
varying vec3  vSurfaceNormal;

#define PI 3.141592653589793

// Rotate vector v around a unit axis by angle (Rodrigues).
vec3 rotAroundAxis(vec3 v, vec3 axis, float angle) {
    float c = cos(angle), s = sin(angle);
    return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

void main() {
    float lineV = (aLineIdx + 0.5) / uLineCount;
    vec3 P = texture2D(tFieldPositions, vec2(aS, lineV)).xyz;
    vec3 T = normalize(texture2D(tFieldTangents, vec2(aS, lineV)).xyz);

    // Local frame: outward radial, ribbon-width N, ribbon-flat B.
    vec3 outward = normalize(P);
    vec3 N = normalize(cross(T, outward) + vec3(1e-6));
    vec3 B = normalize(cross(N, T));

    int classId = int(aClassId + 0.5);

    // ── Class-specific bundle frame & lateral offset ─────────────────
    float bundleScale  = 1.0;   // multiplies uBundleHalfRadius
    float verticality  = 0.0;   // 0 = normal, 1 = full radial drape (HEDGEROW)
    float helicalTurns = 0.0;   // signed, full turns over the line  (TORNADO)
    float twistRad     = 0.0;   // rigid bundle-frame rotation       (ARP)
    float epScale      = 1.0;   // EP bundle radius growth
    float epAntiSag    = 0.0;   // EP rises (anti-sag); 0..1

    if (classId == 1) {                                 // IP
        bundleScale = 1.10;
    } else if (classId == 2) {                          // ARP
        bundleScale = 0.55;
        twistRad    = aClassParams.x;                   // moderate rigid twist
    } else if (classId == 3) {                          // HEDGEROW
        bundleScale = 0.85;
        verticality = aClassParams.x;
    } else if (classId == 4) {                          // TORNADO
        bundleScale = 0.70;
        helicalTurns = aClassParams.x;
    } else if (classId == 5) {                          // EP
        epScale   = aClassParams.z;                     // 1..8 over the eruption
        bundleScale = epScale;
        // anti-sag activates during erupt+fade stages
        epAntiSag = clamp(aClassParams.y - 0.2, 0.0, 1.0);
    } else if (classId == 6) {                          // RAIN — post-flare arcade
        bundleScale = 0.70;                             // moderately tight loops
    }

    float halfR = uBundleHalfRadius * bundleScale;

    // Lateral offset within the bundle frame.
    vec3 lateral;
    if (classId == 4) {
        // TORNADO: helical winding. Each thread sits on a circle at radius
        // |aOffset|, and the whole circle rotates with arclength so the
        // bundle looks like a rope.
        float r = halfR * length(aOffset) * 0.9;
        float phase = atan(aOffset.y, aOffset.x);
        float angle = helicalTurns * 2.0 * PI * aS + phase + aThreadId * 0.7;
        lateral = N * (cos(angle) * r) + B * (sin(angle) * r);
    } else {
        vec3 dirN = N;
        vec3 dirB = B;
        if (twistRad != 0.0) {
            // Rigid bundle-frame rotation around the local tangent.
            float a = twistRad * aS;
            dirN = rotAroundAxis(N, T, a);
            dirB = rotAroundAxis(B, T, a);
        }
        // HEDGEROW: blend the B (flat) direction toward outward — produces
        // the wall/curtain look where threads stack vertically.
        vec3 flat = mix(dirB, outward, verticality);
        lateral = dirN * (aOffset.x * halfR)
                + flat * (aOffset.y * halfR * (1.0 + 0.6 * verticality));
    }

    // Apex sag — cool plasma sags; EP class flips it to anti-sag (rising).
    // RAIN class: gentle sag (the arcade is hot enough to support itself);
    // the rain visual comes from droplets sliding *along* the loops, not
    // from sag.
    float sagMag = 0.005 * (classId == 5 ? mix(1.0, -1.4, epAntiSag) : 1.0);
    if (classId == 1) sagMag *= 1.20;                   // IP slightly heavier
    if (classId == 3) sagMag *= 0.4;                    // HEDGEROW: less arching
    if (classId == 6) sagMag *= 0.3;                    // RAIN: hot loops, minimal sag
    float sag = sagMag * sin(PI * aS) * sin(PI * aS);

    // Alfvén transverse oscillation. Different per-thread phase produces a
    // shimmer rather than a synchronised wave.
    float alfvenAmp = 0.0012 * (0.5 + 0.5 * uActivity);
    float alfvenFreq = 0.85;
    if (classId == 2) alfvenFreq = 1.6;                 // ARP: faster
    if (classId == 4) alfvenFreq = 1.8;                 // TORNADO: faster
    if (classId == 5) {                                 // EP: erupt motion
        alfvenAmp *= 1.0 + 4.0 * epAntiSag;
        alfvenFreq *= 1.4;
    }
    if (classId == 6) {                                 // RAIN: condensation jiggle
        alfvenAmp *= 0.6;
        alfvenFreq = 1.2;
    }
    float wob = sin(uTime * alfvenFreq + aThreadId * 13.0 + aS * 4.0)
              * alfvenAmp * sin(PI * aS);

    // Ribbon edge offset (the +/-1 of aT widens the strip into a ribbon).
    vec3 widen = N * (aT * uThreadHalfWidth);

    vec3 pos = P + lateral - outward * sag + N * wob + widen;

    vWorldPos      = pos;
    vSurfaceNormal = outward;
    vS             = aS;
    vT             = aT;
    vThreadId      = aThreadId;
    vBundleNorm    = aBundleNorm;
    vClassId       = aClassId;
    vClassParams   = aClassParams;

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
varying vec4  vClassParams;
varying vec3  vWorldPos;
varying vec3  vSurfaceNormal;

uniform float uTime;
uniform float uActivity;
uniform vec3  uCameraPos;

#define PI 3.141592653589793

void main() {
    int classId = int(vClassId + 0.5);

    // ── Counter-streaming flow ──────────────────────────────────────
    // Adjacent threads carry plasma in opposite directions at ~10–25 km/s.
    // HEDGEROW: all threads downflow only ("falling rain" curtain look).
    // EP: fast outflow, no counter-streaming (everything moves with eruption).
    float flowSign = (mod(floor(vThreadId * 47.0), 2.0) < 1.0) ? 1.0 : -1.0;
    float scrollSpeed = 0.18;
    float dashFreq = 14.0;

    if (classId == 1)      { scrollSpeed = 0.22; }                    // IP
    else if (classId == 2) { scrollSpeed = 0.32; flowSign *= 1.0;  }  // ARP — faster
    else if (classId == 3) { scrollSpeed = 0.55; flowSign = -1.0; dashFreq = 22.0; } // HEDGEROW
    else if (classId == 4) { scrollSpeed = 0.40; }                    // TORNADO
    else if (classId == 5) { scrollSpeed = 0.85; flowSign = 1.0;  dashFreq = 8.0; }  // EP
    else if (classId == 6) { scrollSpeed = 0.50; flowSign = -1.0; dashFreq = 22.0; } // RAIN — droplets fall

    float scrollPhase = (vS - flowSign * uTime * scrollSpeed) * dashFreq
                      + vThreadId * 6.28;
    float dashes = 0.5 + 0.5 * sin(scrollPhase);
    // RAIN: sharper dashes → tight bright droplets between dim gaps (the
    // characteristic "beads on a string" visual of coronal rain).
    dashes = pow(dashes, classId == 6 ? 2.6 : 1.6);

    // ── Per-thread brightening cycle ───────────────────────────────
    float cycleFreq = 0.42;
    if (classId == 2) cycleFreq = 0.85;            // ARP twitchier
    if (classId == 5) cycleFreq = 1.30;            // EP very fast
    if (classId == 6) cycleFreq = 0.30;            // RAIN: slower, condensation timescale
    float bright = 0.65 + 0.35 * sin(uTime * cycleFreq + vThreadId * 9.7);

    // ── Arch shape: brighter at footpoints AND apex, slight mid-loop dip.
    float foot = pow(sin(PI * vS), 0.6);
    float archShape = 0.45 + 0.55 * foot;

    // ── Ribbon edge softening (anti-aliased thread edges). ─────────
    float edge = smoothstep(0.0, 0.3, 1.0 - abs(vT));

    // ── Hα palette, cool→warm along arclength. ─────────────────────
    vec3 colFoot = vec3(0.92, 0.22, 0.34);
    vec3 colApex = vec3(0.88, 0.46, 0.68);
    vec3 col = mix(colFoot, colApex, foot);

    // ── Class-specific tint and final colour adjustments ───────────
    if (classId == 1) {                                              // IP
        col *= vec3(1.04, 0.96, 0.94);
    } else if (classId == 2) {                                       // ARP
        col = mix(col, vec3(1.00, 0.42, 0.30), 0.40);
    } else if (classId == 3) {                                       // HEDGEROW
        col = mix(col, vec3(0.94, 0.30, 0.22), 0.30);
    } else if (classId == 4) {                                       // TORNADO
        // Twist hue: subtle violet undertone toward the tornado axis
        col = mix(col, vec3(0.85, 0.30, 0.55), 0.25);
    } else if (classId == 5) {                                       // EP
        // Doppler blueshift increases through the erupt stage.
        float stage = vClassParams.y;
        float blue  = clamp((stage > 0.5) ? (stage - 0.5) * 2.0 : 0.0, 0.0, 1.0);
        col = mix(col, vec3(0.85, 0.92, 1.20), 0.35 + 0.40 * blue);
    } else if (classId == 6) {                                       // RAIN (Phase 3 hook)
        float coolingT = vClassParams.x;
        vec3 hotCol  = vec3(0.30, 0.85, 0.95);    // 131/94 Å teal
        vec3 midCol  = vec3(1.00, 0.80, 0.30);    // 171 Å gold
        vec3 coolCol = vec3(0.95, 0.30, 0.30);    // 304 Å red
        col = mix(mix(hotCol, midCol, smoothstep(0.0, 0.5, coolingT)),
                  coolCol, smoothstep(0.5, 1.0, coolingT));
    }

    // ── Class-driven alpha modulator (EP fade-out + RAIN viz envelope) ─
    float classFade = 1.0;
    if (classId == 5) {
        classFade = vClassParams.w;               // EP: 0..1 alpha modulator
    } else if (classId == 6) {
        classFade = vClassParams.y;               // RAIN: viz scale (fade-in/out)
    }

    float intensity = vBundleNorm * archShape * bright
                    * (0.55 + 0.45 * dashes)
                    * edge * classFade;

    // ── On-disk vs limb mode (unified shader, premultiplied-alpha blend).
    vec3 toCam = normalize(uCameraPos - vWorldPos);
    float facing = dot(vSurfaceNormal, toCam);
    float disk = smoothstep(0.10, 0.45, facing);

    // Disk: cool prominences absorb chromospheric Hα → render as dark
    // filaments (premultiplied black with alpha = intensity).  Hot
    // classes (EP rising, RAIN arcade) instead emit on top of the disk
    // as well, so we mix the bright limb colour into the disk path.
    float emitOnDisk = 0.0;
    if (classId == 5) emitOnDisk = 0.6;                // EP: mostly emit
    if (classId == 6) emitOnDisk = 0.85;               // RAIN: emit dominant
    float diskAlpha = intensity * 0.85 * (1.0 - emitOnDisk);
    vec3  colDisk = col * intensity * 1.6 * emitOnDisk;
    float aDisk   = clamp(diskAlpha, 0.0, 0.92);

    // Limb: bright Hα emission (premultiplied colour, alpha = 0).
    float limbBoost = 1.6;
    if (classId == 2) limbBoost = 2.1;            // ARP punchier
    if (classId == 5) limbBoost = 2.8;            // EP very bright
    if (classId == 6) limbBoost = 2.2;            // RAIN: hot arcade glows hard
    vec3  colLimb = col * intensity * limbBoost;
    float aLimb   = 0.0;

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
    const aLineIdx     = new Float32Array(MAX_INSTANCES);
    const aThreadId    = new Float32Array(MAX_INSTANCES);
    const aOffset      = new Float32Array(MAX_INSTANCES * 2);
    const aBundleNorm  = new Float32Array(MAX_INSTANCES);
    const aClassId     = new Float32Array(MAX_INSTANCES);
    const aClassParams = new Float32Array(MAX_INSTANCES * 4);

    stripGeom.setAttribute('aLineIdx',     new THREE.InstancedBufferAttribute(aLineIdx, 1));
    stripGeom.setAttribute('aThreadId',    new THREE.InstancedBufferAttribute(aThreadId, 1));
    stripGeom.setAttribute('aOffset',      new THREE.InstancedBufferAttribute(aOffset, 2));
    stripGeom.setAttribute('aBundleNorm',  new THREE.InstancedBufferAttribute(aBundleNorm, 1));
    stripGeom.setAttribute('aClassId',     new THREE.InstancedBufferAttribute(aClassId, 1));
    stripGeom.setAttribute('aClassParams', new THREE.InstancedBufferAttribute(aClassParams, 4));
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
                aLineIdx, aThreadId, aOffset, aBundleNorm, aClassId, aClassParams,
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
// Walks the bundle list produced by the classifier and distributes the
// thread budget across them. Trivial PILs aren't culled — they're already
// attenuated by the classifier via the weight factor (apex × length × class
// multiplier), so they fade toward zero brightness instead of vanishing.

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

    // Classifier-supplied bundle list (already class-tagged + weighted).
    // Falls back to a built-in QP-only filter if no classifier output is
    // provided — keeps the module usable on its own.
    const bundles = opts.bundles || _fallbackQpBundles(atlas);
    if (bundles.length === 0) {
        geom.instanceCount = 0;
        return;
    }

    // Distribute the thread budget across bundles proportional to weight,
    // with a floor of 1 thread/bundle.
    const totalW = bundles.reduce((s, b) => s + Math.max(0.04, b.weight), 0);
    const allocs = bundles.map(b => Math.max(1, Math.round((Math.max(0.04, b.weight) / totalW) * budget)));
    let allocSum = allocs.reduce((s, n) => s + n, 0);
    while (allocSum > budget && allocs.some(n => n > 1)) {
        const idx = allocs.indexOf(Math.max(...allocs));
        allocs[idx] -= 1;
        allocSum -= 1;
    }

    const aLineIdx     = attrs.aLineIdx;
    const aThreadId    = attrs.aThreadId;
    const aOffset      = attrs.aOffset;
    const aBundleNorm  = attrs.aBundleNorm;
    const aClassId     = attrs.aClassId;
    const aClassParams = attrs.aClassParams;

    let n = 0;
    for (let bi = 0; bi < bundles.length; bi++) {
        const bundle = bundles[bi];
        const nThreads = allocs[bi];
        const norm = clamp(0.20 + 0.80 * bundle.weight, 0, 1);
        const rng = mulberry32(0x9E3779B9 ^ (bundle.lineIdx * 0x85EBCA6B));

        // Tornado bundles want threads spread on a circle, not a disc.
        // For everything else, sqrt(r) gives uniform area coverage.
        const useRing = bundle.classId === CLASS.TORNADO;

        for (let ti = 0; ti < nThreads; ti++) {
            if (n >= MAX_INSTANCES) break;
            const tid = (ti + 0.5) / nThreads;
            const r = useRing ? (0.7 + 0.3 * rng()) : Math.sqrt(rng());
            const a = rng() * Math.PI * 2;
            aLineIdx[n]      = bundle.lineIdx;
            aThreadId[n]     = tid;
            aOffset[n * 2    ] = Math.cos(a) * r;
            aOffset[n * 2 + 1] = Math.sin(a) * r * (useRing ? 1.0 : 0.6);
            aBundleNorm[n]   = norm;
            aClassId[n]      = bundle.classId;
            const p = bundle.params;
            const o4 = n * 4;
            aClassParams[o4    ] = p ? p[0] : 0;
            aClassParams[o4 + 1] = p ? p[1] : 0;
            aClassParams[o4 + 2] = p ? p[2] : 0;
            aClassParams[o4 + 3] = p ? p[3] : 0;
            n++;
        }
        if (n >= MAX_INSTANCES) break;
    }

    geom.attributes.aLineIdx.needsUpdate     = true;
    geom.attributes.aThreadId.needsUpdate    = true;
    geom.attributes.aOffset.needsUpdate      = true;
    geom.attributes.aBundleNorm.needsUpdate  = true;
    geom.attributes.aClassId.needsUpdate     = true;
    geom.attributes.aClassParams.needsUpdate = true;
    geom.instanceCount = n;
}

/** Self-contained fallback when no classifier output is supplied: every
 *  PIL-anchored closed loop becomes a QP bundle. Keeps the module usable
 *  in isolation (e.g. unit tests). */
function _fallbackQpBundles(atlas) {
    const meta = atlas.meta;
    const out = [];
    for (let i = 0; i < atlas.lineCount; i++) {
        const m0 = i * META_STRIDE;
        if (meta[m0] !== 0 || meta[m0 + 1] !== 2) continue;
        const apex = meta[m0 + 3], length = meta[m0 + 4];
        const w = clamp(apex / 0.05, 0, 1) * clamp(length / 0.30, 0, 1);
        out.push({ lineIdx: i, classId: CLASS.QP, weight: Math.max(0.04, w),
                   params: [0, 0, 0, 0], stateAge: 0 });
    }
    return out;
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
