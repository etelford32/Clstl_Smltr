// js/flare-hxr-kernels.js
//
// Phase 3.2 — Hard X-Ray footpoint kernels for the impulsive phase.
//
// During a flare's impulsive phase, electrons accelerated at the
// reconnection site stream down both legs of each reconnected loop and
// slam into the dense chromosphere at the footpoints. The collisions
// produce hard X-ray bremsstrahlung (>25 keV) seen as compact, intensely
// bright kernels at the ends of each loop — almost always in conjugate
// pairs, one per ribbon. They strobe sub-second (elementary flare bursts)
// and fade fast even as GOES soft X-ray flux is still rising.
//
// We render each conjugate footpoint as a screen-aligned quad lifted just
// above the photosphere, intensity modulated by:
//   • a per-kernel high-frequency flicker (~5–10 Hz)
//   • a Neupert-shaped impulsive envelope: sin(πt/T) × exp(-t/τ)
//     peaks at ~10 sim-seconds after onset, gone by ~30
//   • a per-kernel intensity scaled by the loop's apex height (taller =
//     more energetic loop = brighter footpoint)
//
// All kernels share one ShaderMaterial / one InstancedMesh / one draw
// call, so the cost is constant regardless of footpoint pair count up to
// MAX_KERNELS pairs (×2 = 32 kernels).

import * as THREE from 'three';

const MAX_PAIRS   = 16;          // ⇒ 32 kernels max
const MAX_KERNELS = MAX_PAIRS * 2;
const KERNEL_LIFT = 1.003;       // R☉ — small offset above photosphere

// Visibility envelope cutoff in sim-time units. The fragment shader
// computes the same envelope but we use this on the JS side to early-out
// instance count → 0 once the kernels have fully faded.
const ENVELOPE_END_T = 32.0;

// Camera-facing quad geometry: a unit square in xy plane with corners at
// (-1,-1) … (+1,+1). The vertex shader uses these as 2D billboard offsets
// in view space.
function _buildQuad() {
    const verts = new Float32Array([
        -1, -1, 0,
         1, -1, 0,
         1,  1, 0,
        -1,  1, 0,
    ]);
    const idx = [0, 1, 2, 0, 2, 3];
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g.setIndex(idx);
    return g;
}

const VERT = /* glsl */ `
precision highp float;

attribute vec3  aPos;        // unit-sphere photospheric anchor (per-instance)
attribute float aSeed;       // [0,1] per-instance random for animation phase
attribute float aIntensity;  // [0,1] per-instance brightness (apex-derived)

uniform float uKernelSize;   // R☉

varying vec2  vUv;
varying float vSeed;
varying float vIntensity;

void main() {
    vec3 anchor = aPos * float(${KERNEL_LIFT});

    // Build the billboard in view space so the quad always faces the
    // camera regardless of where on the sphere it sits.
    vec4 viewAnchor = modelViewMatrix * vec4(anchor, 1.0);
    viewAnchor.xy += position.xy * uKernelSize;
    gl_Position = projectionMatrix * viewAnchor;

    vUv = position.xy;
    vSeed = aSeed;
    vIntensity = aIntensity;
}
`;

const FRAG = /* glsl */ `
precision highp float;

varying vec2  vUv;
varying float vSeed;
varying float vIntensity;

uniform float uTime;
uniform float uFlareT;

#define PI 3.141592653589793

void main() {
    // Radial gaussian glow: sharp white-hot core + soft halo.
    float r = length(vUv);
    if (r > 1.0) discard;
    float core = exp(-r * r * 9.0);
    float halo = exp(-r * r * 1.6) * 0.30;
    float shape = core + halo;

    // High-frequency flicker (elementary flare bursts, ~5–10 Hz).
    float flicker = 0.5 + 0.5 * sin(uTime * 56.0 + vSeed * 31.0);
    flicker = pow(flicker, 0.55);
    // Slower strobe overlay so adjacent kernels don't lock-step.
    float strobe = 0.55 + 0.45 * sin(uTime * 7.3 + vSeed * 17.0);

    // Neupert-shaped impulsive envelope: rises through the first ~10 s,
    // fades by ~30. Peaks where dGOES/dt is largest, not where GOES is.
    float t01 = clamp(uFlareT / 30.0, 0.0, 1.0);
    float env = sin(PI * t01) * exp(-uFlareT / 14.0);

    // HXR colour: hot, white shading toward UV-blue. Matches AIA 94/131
    // hot-channel palette where the flare core peaks during impulsive.
    vec3 col = vec3(0.92, 1.00, 1.35);

    float intensity = vIntensity * env * shape * flicker * strobe;
    // Premultiplied alpha (matches src=ONE, dst=ONE_MINUS_SRC_ALPHA).
    gl_FragColor = vec4(col * intensity * 2.4, 0.0);
}
`;

/**
 * Create the HXR kernel system. Returns a handle:
 *   .update(footpointPairs)  — refresh instance attrs from {a,b,apex,lineIdx}[]
 *   .tick(timeSec, flareT)   — advance shader uniforms each frame
 *   .clear()                 — instance count → 0
 *   .setVisible(b)
 *   .dispose()
 */
export function createHxrKernelSystem({ scene } = {}) {
    if (!scene) throw new Error('flare-hxr-kernels: scene is required');

    const geom = _buildQuad();

    const aPos       = new Float32Array(MAX_KERNELS * 3);
    const aSeed      = new Float32Array(MAX_KERNELS);
    const aIntensity = new Float32Array(MAX_KERNELS);
    geom.setAttribute('aPos',       new THREE.InstancedBufferAttribute(aPos, 3));
    geom.setAttribute('aSeed',      new THREE.InstancedBufferAttribute(aSeed, 1));
    geom.setAttribute('aIntensity', new THREE.InstancedBufferAttribute(aIntensity, 1));
    geom.instanceCount = 0;

    const uniforms = {
        uTime:       { value: 0 },
        uFlareT:     { value: 0 },
        uKernelSize: { value: 0.012 },        // R☉ — ~8 Mm visible glow
    };

    const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader:   VERT,
        fragmentShader: FRAG,
        transparent:    true,
        depthWrite:     false,
        depthTest:      true,
        side:           THREE.DoubleSide,
        // Premultiplied alpha. Same blend as the prominence-bundle shader,
        // additive-on-bright in the photospheric pipeline.
        blending:       THREE.CustomBlending,
        blendSrc:       THREE.OneFactor,
        blendDst:       THREE.OneMinusSrcAlphaFactor,
        blendEquation:  THREE.AddEquation,
    });

    const mesh = new THREE.Mesh(geom, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;                     // after photosphere shader pass
    mesh.userData.label = 'HXR footpoint kernels (Phase 3.2)';
    scene.add(mesh);

    function update(footpointPairs) {
        if (!footpointPairs || footpointPairs.length === 0) {
            geom.instanceCount = 0;
            return;
        }

        // Take up to MAX_PAIRS, ranked by apex height (most energetic loops
        // light up brightest in HXR).
        const ranked = footpointPairs
            .slice()
            .sort((p, q) => (q.apex || 0) - (p.apex || 0))
            .slice(0, MAX_PAIRS);

        // Normalise apex range across the kept set so the brightest pair
        // hits ~1.0 even when the absolute apex values are small.
        const maxApex = Math.max(0.01, ...ranked.map(p => p.apex || 0));

        let n = 0;
        for (const pair of ranked) {
            const norm = 0.40 + 0.60 * Math.min(1, (pair.apex || 0) / maxApex);
            // Two kernels per pair — conjugate footpoints A & B.
            for (const xyz of [pair.a, pair.b]) {
                aPos[n * 3    ] = xyz[0];
                aPos[n * 3 + 1] = xyz[1];
                aPos[n * 3 + 2] = xyz[2];
                aSeed[n] = _hashSeed(pair.lineIdx, n & 1);
                aIntensity[n] = norm;
                n++;
            }
        }

        geom.attributes.aPos.needsUpdate = true;
        geom.attributes.aSeed.needsUpdate = true;
        geom.attributes.aIntensity.needsUpdate = true;
        geom.instanceCount = n;
    }

    function tick(timeSec, flareT) {
        uniforms.uTime.value = timeSec;
        uniforms.uFlareT.value = flareT;
        // JS-side early-out: once the envelope has fully faded, drop instance
        // count to zero so we don't run the per-fragment shader at all.
        if (flareT > ENVELOPE_END_T && geom.instanceCount > 0) {
            geom.instanceCount = 0;
        }
    }

    function clear()           { geom.instanceCount = 0; }
    function setVisible(b)     { mesh.visible = !!b; }
    function dispose() {
        scene.remove(mesh);
        geom.dispose();
        material.dispose();
    }

    return {
        mesh, material, uniforms,
        update, tick, clear, setVisible, dispose,
        get activeKernels() { return geom.instanceCount; },
    };
}

// Deterministic hash so kernel flicker phases stay stable across atlas
// updates with the same input.
function _hashSeed(lineIdx, side) {
    let h = (lineIdx * 0x9E3779B9) ^ (side * 0x85EBCA77);
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    h = h ^ (h >>> 16);
    return ((h >>> 0) / 4294967296);
}
