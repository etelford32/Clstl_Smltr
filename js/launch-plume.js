/**
 * launch-plume.js — Shader-driven engine plume.
 *
 * One ShaderMaterial cone per engine. Vertex shader sculpts the plume
 * shape (bell-mouth taper, tail wobble, altitude-driven expansion);
 * fragment shader paints the temperature gradient (white core → mid →
 * outer smoke), shock-diamond bands along the axis, turbulent shimmer,
 * and a silhouette-boosted volumetric alpha. A small additive disc at
 * the bell mouth keeps the nozzle visibly "lit" at low throttle.
 *
 * Public API (backward-compatible with the previous cone-stack version):
 *   buildPlume({
 *     coreRadius, coreLen,           // bell exit radius drives plume width
 *     midRadius, midLen,             // (ignored — kept for old call sites)
 *     outerRadius, outerLen,         // outerLen drives plume length
 *     coreColor, midColor, outerColor,
 *     name = 'Plume',
 *   }) → THREE.Group
 *
 *   tickPlume(plumeGroup, t, throttle, altKm = 0)
 *     t       — render-loop elapsed seconds (drives shimmer / diamonds)
 *     throttle — 0..1
 *     altKm   — current altitude above pad in kilometers; the shader
 *               uses this to widen and lengthen the plume as ambient
 *               pressure falls (sea-level: tight overexpanded plume with
 *               crisp Mach diamonds; vacuum: wide diffuse plume, diamonds
 *               stretch and dim).
 */

import * as THREE from 'three';

// ── Shaders ─────────────────────────────────────────────────────────────────

const PLUME_VERT = /* glsl */`
    uniform float uThrottle;
    uniform float uTime;
    uniform float uExpansion;       // 0 sea-level, 1 above ~30 km

    varying vec2  vUv;
    varying float vAxial;           // 0 at bell exit, 1 at tail tip
    varying vec3  vMvPos;
    varying vec3  vNormalView;

    void main() {
        vUv = uv;
        // ConeGeometry uv.y is 1 at apex, 0 at base. We rotate the cone π
        // around X so the apex sits at -Y (downstream); after that flip
        // the apex *still* has uv.y = 1. So tail = uv.y = 1, bell = 0.
        vAxial = uv.y;

        // ── Shape modulation ───────────────────────────────────────────
        float altPuff = 1.0 + uExpansion * 1.6;    // up to 2.6× wider at altitude
        float altLen  = 1.0 + uExpansion * 0.8;    // up to 1.8× longer at altitude
        float thrW    = mix(0.35, 1.0, uThrottle);
        float thrL    = mix(0.30, 1.0, uThrottle);

        // Bell mouth: the very top (bell exit, vAxial < 0.06) narrows
        // slightly so the plume neck reads as inside the nozzle.
        float bell = smoothstep(0.0, 0.06, vAxial);
        float bellShape = mix(0.55, 1.0, bell);

        // Tail taper: the gas re-condenses at the end of the plume.
        float tailTaper = mix(1.0, 0.55, smoothstep(0.55, 1.0, vAxial));

        // High-frequency wobble in the tail — reads as turbulence.
        float wob = sin(uv.x * 18.0 + uTime * 6.0 + vAxial * 12.0)
                  * vAxial * 0.04;

        vec3 p = position;
        float wMul = altPuff * thrW * bellShape * tailTaper * (1.0 + wob);
        float lMul = altLen * thrL;
        p.x *= wMul;
        p.z *= wMul;
        p.y *= lMul;

        vec4 mvPos = modelViewMatrix * vec4(p, 1.0);
        vMvPos = mvPos.xyz;
        vNormalView = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mvPos;
    }
`;

const PLUME_FRAG = /* glsl */`
    uniform vec3  uCoreColor;
    uniform vec3  uMidColor;
    uniform vec3  uOuterColor;
    uniform float uThrottle;
    uniform float uExpansion;
    uniform float uTime;

    varying vec2  vUv;
    varying float vAxial;
    varying vec3  vMvPos;
    varying vec3  vNormalView;

    // 2D value-noise.
    float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
            mix(hash(i),               hash(i + vec2(1., 0.)), f.x),
            mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x),
            f.y
        );
    }

    void main() {
        // ── Temperature gradient ────────────────────────────────────────
        // 0..0.04 : blinding core (uCoreColor with +brightness)
        // 0.04..0.30 : transition to uMidColor (orange / blue depending on fuel)
        // 0.30..0.85 : fade to uOuterColor (smoke / cool outer flame)
        // 0.85..1.00 : alpha falls off
        vec3 col = mix(uCoreColor, uMidColor, smoothstep(0.04, 0.30, vAxial));
        col      = mix(col,        uOuterColor, smoothstep(0.30, 0.85, vAxial));

        // ── Mach diamonds ───────────────────────────────────────────────
        // Standing compression / expansion cells along the plume axis.
        // Cell wavelength grows with altitude (less ambient pressure →
        // longer shock cells), and diamonds fade out past the supersonic
        // region (~50 % of plume length) where the flow has gone
        // turbulent / subsonic.
        float cellFreq = mix(36.0, 14.0, uExpansion);
        float diamonds = pow(0.5 + 0.5 * cos(vAxial * cellFreq), 8.0);
        diamonds *= smoothstep(0.02, 0.08, vAxial)
                  * smoothstep(0.55, 0.30, vAxial)
                  * uThrottle;
        col += diamonds * uCoreColor * 1.6;

        // ── Turbulence shimmer ──────────────────────────────────────────
        // Adds high-frequency variation to the middle / tail of the plume
        // so it doesn't look like a stencil. Animated against time.
        float turb = noise(vec2(vUv.x * 10.0, vAxial * 14.0 - uTime * 1.8));
        turb = (turb - 0.5) * 0.30;
        col += turb * uMidColor * smoothstep(0.10, 0.70, vAxial) * uThrottle;

        // ── Volumetric alpha ────────────────────────────────────────────
        // Surface facing camera = thin sliver of gas → dimmer.
        // Surface edge-on (silhouette) = camera looks through more gas
        // along the cone → brighter. Combined with additive blending this
        // produces the "depth" look of a real plume instead of a flat
        // cardboard cutout.
        vec3 viewDir = normalize(-vMvPos);
        float facing = abs(dot(vNormalView, viewDir));
        float silhouette = 1.0 - facing;

        float alpha = uThrottle
                    * (1.0 - vAxial * 0.5)
                    * mix(0.45, 1.0, silhouette);
        alpha *= smoothstep(1.0, 0.55, vAxial);     // tail fade-out
        alpha = clamp(alpha + turb * 0.35, 0.0, 1.0);

        gl_FragColor = vec4(col, alpha);
    }
`;

// ── Builders ────────────────────────────────────────────────────────────────

function makePlumeBody({ baseRadius, length, coreColor, midColor, outerColor }) {
    // High segment count so the vertex-shader sculpt is smooth, not faceted.
    const geo = new THREE.ConeGeometry(baseRadius, length, 36, 64, true);
    // Move geometry so the BASE sits at the origin (rather than centered),
    // then rotate so the apex points -Y (downstream).
    geo.translate(0, -length / 2, 0);
    geo.rotateX(Math.PI);

    const uniforms = {
        uTime:       { value: 0 },
        uThrottle:   { value: 0 },
        uExpansion:  { value: 0 },
        uCoreColor:  { value: new THREE.Color(coreColor) },
        uMidColor:   { value: new THREE.Color(midColor) },
        uOuterColor: { value: new THREE.Color(outerColor) },
    };

    const mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader:   PLUME_VERT,
        fragmentShader: PLUME_FRAG,
        transparent: true,
        blending:    THREE.AdditiveBlending,
        depthWrite:  false,
        side:        THREE.DoubleSide,
        fog:         false,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.kind = 'body';
    mesh.userData.uniforms = uniforms;
    return mesh;
}

// Additive disc at the bell mouth so the nozzle reads as "lit" even when
// the plume tail thins at low throttle. Kept as plain MeshBasicMaterial —
// no need to shader this one.
function makeBellFlare(baseRadius, coreColor) {
    const flare = new THREE.Mesh(
        new THREE.CircleGeometry(baseRadius * 1.05, 32),
        new THREE.MeshBasicMaterial({
            color: coreColor,
            transparent: true,
            opacity: 0.95,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
            fog: false,
        })
    );
    flare.rotation.x = Math.PI / 2;
    flare.position.y = -0.02;          // just below the bell exit plane
    flare.userData.kind = 'flare';
    flare.userData.baseOpacity = 0.95;
    return flare;
}

// ── Public ──────────────────────────────────────────────────────────────────

export function buildPlume(opts) {
    const {
        coreRadius = 0.4,
        outerLen   = 36,
        coreColor  = 0xfff5d8,
        midColor   = 0xffaa44,
        outerColor = 0x6a3a18,
        name = 'Plume',
    } = opts;

    const g = new THREE.Group();
    g.name = name;
    g.visible = false;             // toggled by host UI

    g.add(makePlumeBody({
        baseRadius: coreRadius * 1.6,
        length:     outerLen,
        coreColor, midColor, outerColor,
    }));
    g.add(makeBellFlare(coreRadius * 1.6, coreColor));

    return g;
}

export function tickPlume(plume, t, throttle = 1, altKm = 0) {
    if (!plume.visible) return;
    const expansion = Math.min(1, Math.max(0, altKm / 30));   // 0 SL, 1 ≥ 30 km

    for (const child of plume.children) {
        const u = child.userData;
        if (u.kind === 'body') {
            const uf = u.uniforms;
            uf.uTime.value      = t;
            uf.uThrottle.value  = throttle;
            uf.uExpansion.value = expansion;
        } else if (u.kind === 'flare') {
            const flick = 0.85 + Math.sin(t * 18) * 0.15;
            const lit   = throttle > 0.02 ? throttle : 0;
            const scale = Math.max(0.05, 0.6 + 0.6 * lit) * flick;
            child.scale.setScalar(scale);
            child.material.opacity = u.baseOpacity * lit * (0.85 + 0.15 * Math.sin(t * 18));
        }
    }
}
