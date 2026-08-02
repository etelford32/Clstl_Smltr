/**
 * moon-exosphere.js — renderer for the lunar surface-boundary exosphere.
 * ═══════════════════════════════════════════════════════════════════════════
 * Renderer ONLY. Every number drawn here comes from js/moon-exosphere-model.js
 * (the pure kernel with its own Node gate, tests/moon-exosphere-model.mjs).
 *
 * ── WHAT IS PHYSICS AND WHAT IS DECORATION ───────────────────────────────
 *   PHYSICS (from the kernel):
 *     • The glow shell's radial falloff — exp(−(b−1)/H) in the view ray's
 *       impact parameter, with H the kernel's own scale heights (suprathermal
 *       Na ≈ 267 km dayside, cold thermal gas ≈ 100–130 km nightside, in
 *       moon-radius units). The halo really is ~15–25% of a radius deep;
 *       almost no exaggeration was needed, which is itself the point.
 *     • Day/night colour split: the dayside glows sodium-yellow (Na D
 *       resonance scattering needs sunlight); the nightside is the faint
 *       blue-grey of the cold He/Ar gas that concentrates there.
 *     • The dawn-limb argon bulge — condensable ⁴⁰Ar released at sunrise
 *       (the LACE signature). The dawn limb is computed from the sun
 *       direction and the Moon's spin axis, not hand-placed.
 *     • Tail brightness and glow intensity scale with the kernel's live
 *       sodium source total (PSD + sputtering + impacts), so magnetotail
 *       passage visibly dims it and meteor showers visibly feed it.
 *   DECORATION (disclosed):
 *     • Absolute brightness — a real exosphere is invisible to the eye;
 *       drawing it AT ALL is the exaggeration, and the panel says so.
 *     • The tail's on-screen length (~8 R_moon) COMPRESSES a structure
 *       observed to stream for hundreds of moon radii (the "sodium spot"
 *       passes Earth at new moon). Particle motion pacing is art.
 */

import * as THREE from 'three';
import { speciesProfile } from './moon-exosphere-model.js';
import { R_MOON_KM } from './moon-interior-model.js';

// ── Glow shell shader ───────────────────────────────────────────────────────
// Drawn on a BackSide sphere at r = SHELL_R: only the far hemisphere renders
// and the Moon's own depth buffer occludes the disk, leaving a clean limb
// halo. The camera can enter the shell (minDistance 1.04) — BackSide keeps
// rendering and the exp falloff handles it.
const SHELL_R = 1.45;

const GLOW_VERT = /* glsl */`
varying vec3 vPos;
void main() {
    vPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const GLOW_FRAG = /* glsl */`
precision highp float;
uniform vec3  u_sun_dir;
uniform vec3  u_dawn_dir;     // sunrise limb (from sun dir × spin axis)
uniform float u_h_day;        // dayside (suprathermal Na) scale height, moon radii
uniform float u_h_night;      // nightside (cold thermal gas) scale height, moon radii
uniform float u_activity;     // live Na source total, ×quiet (kernel)
uniform float u_intensity;    // master visibility gain (decoration, disclosed)
varying vec3 vPos;

void main() {
    // Impact parameter of the view ray w.r.t. the Moon's centre (origin)
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vPos - ro);
    float tca = dot(-ro, rd);
    vec3 closest = ro + rd * max(tca, 0.0);
    float b = length(closest);
    vec3 cdir = closest / max(b, 1e-5);

    // Day/night from where the ray grazes the exosphere
    float dayness = clamp(dot(cdir, normalize(u_sun_dir)) * 0.5 + 0.5, 0.0, 1.0);
    float H = mix(u_h_night, u_h_day, dayness);

    // Column falloff in the impact parameter — the kernel's scale height
    float x = max(b - 1.0, 0.0) / max(H, 1e-4);
    float col = exp(-x);

    // Sodium-yellow by day (D-line resonance scattering), cold blue-grey by night
    vec3 naCol = vec3(1.00, 0.82, 0.35);
    vec3 coldCol = vec3(0.45, 0.55, 0.80);
    vec3 tint = mix(coldCol, naCol, dayness);

    // Dawn-limb argon bulge (LACE sunrise release)
    float dawn = pow(clamp(dot(cdir, normalize(u_dawn_dir)), 0.0, 1.0), 8.0);
    tint += vec3(0.55, 0.62, 0.85) * dawn * 0.6;
    col *= 1.0 + 0.8 * dawn;

    // Live activity brightens the dayside sodium component
    float act = clamp(u_activity, 0.0, 3.0);
    float gain = mix(0.6, 0.6 + 0.4 * act, dayness);

    float a = u_intensity * col * gain;
    gl_FragColor = vec4(tint * a, a);
}`;

// ── Sodium tail shader ──────────────────────────────────────────────────────
// Particles stream anti-sunward inside a widening cone. Geometry is built in
// a local frame with the cone axis on +X; the group quaternion rotates +X to
// −sunDir. Per-particle seeds live in an attribute; positions are computed
// in the vertex shader so the outflow animates without CPU writes.
const TAIL_SPAN = 8.0;    // on-screen tail length, moon radii (compressed — see header)
const TAIL_R0 = 1.06;   // cone start just above the surface

const TAIL_VERT = /* glsl */`
attribute vec4 a_seed;        // (s0 ∈ [0,1) along-tail phase, angle, radial ∈ [0,1], size)
uniform float u_time;
uniform float u_strength;     // live Na source total, ×quiet
varying float vFade;
void main() {
    float span = ${TAIL_SPAN.toFixed(1)};
    // Outflow: phase drifts down-tail; faster when the source runs hot
    float s = fract(a_seed.x + u_time * 0.022 * (0.6 + 0.4 * u_strength));
    float x = ${TAIL_R0.toFixed(2)} + s * span;
    // Cone widens down-tail; radial jitter from the seed
    float spread = (0.10 + 0.24 * s * span) * a_seed.z;
    vec3 pos = vec3(x, cos(a_seed.y) * spread, sin(a_seed.y) * spread);
    // Fade in off the surface, fade out down-tail (photoionization death)
    vFade = smoothstep(0.0, 0.06, s) * pow(1.0 - s, 1.4);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    // Fine-grained stream: a few px per atom-packet, capped so near
    // particles can't balloon into blobs
    gl_PointSize = min(9.0, a_seed.w * 16.0 / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
}`;

const TAIL_FRAG = /* glsl */`
precision mediump float;
uniform float u_opacity;
varying float vFade;
void main() {
    // Soft round sprite
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    float soft = 1.0 - smoothstep(0.05, 0.25, r2);
    vec3 naCol = vec3(1.0, 0.84, 0.38);
    gl_FragColor = vec4(naCol, u_opacity * vFade * soft);
}`;

// ═══════════════════════════════════════════════════════════════════════════
export class MoonExosphere {
    constructor(parent, sunDir = new THREE.Vector3(1, 0.15, 0.3), { radius = 1.0 } = {}) {
        this.group = new THREE.Group();
        this.group.name = 'moon-exosphere';
        this.group.scale.setScalar(radius);
        parent.add(this.group);

        this._disposables = [];
        const track = (o) => { this._disposables.push(o); return o; };

        // Kernel scale heights → moon-radius units (the falloff the shader draws)
        const na = speciesProfile('na');
        const he = speciesProfile('he');
        const hDay = na.scaleHeightDayKm / R_MOON_KM;      // suprathermal Na, ~0.15
        const hNight = he.scaleHeightNightKm / R_MOON_KM;  // cold thermal gas, ~0.07

        // Dawn limb: with spin axis +Y and the terminator at 90° from the sun,
        // surface points rotate from the (sunDir × up) side into sunlight.
        const dawnDir = new THREE.Vector3().crossVectors(sunDir, new THREE.Vector3(0, 1, 0)).normalize();

        this._glowU = {
            u_sun_dir: { value: sunDir.clone() },
            u_dawn_dir: { value: dawnDir },
            u_h_day: { value: hDay },
            u_h_night: { value: hNight },
            u_activity: { value: 1 },
            u_intensity: { value: 0.65 },
        };
        const glowMat = track(new THREE.ShaderMaterial({
            vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
            uniforms: this._glowU, side: THREE.BackSide,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this._glowMesh = new THREE.Mesh(track(new THREE.SphereGeometry(SHELL_R, 64, 48)), glowMat);
        this._glowMesh.renderOrder = 4;
        this.group.add(this._glowMesh);

        // Sodium tail — points in a local +X frame, rotated anti-sunward
        const N = 1100;
        const seeds = new Float32Array(N * 4);
        for (let i = 0; i < N; i++) {
            seeds[i * 4] = Math.random();                    // along-tail phase
            seeds[i * 4 + 1] = Math.random() * Math.PI * 2;      // azimuth in the cone
            seeds[i * 4 + 2] = Math.pow(Math.random(), 0.7);     // radial (edge-biased slightly in)
            seeds[i * 4 + 3] = 0.5 + Math.random();              // size
        }
        const tailGeo = track(new THREE.BufferGeometry());
        // Static placeholder positions — the vertex shader computes the real ones
        tailGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(N * 3), 3));
        tailGeo.setAttribute('a_seed', new THREE.Float32BufferAttribute(seeds, 4));
        // The cone spans the whole tail; give the culler the true bounds
        tailGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(TAIL_SPAN / 2, 0, 0), TAIL_SPAN);

        this._tailU = {
            u_time: { value: 0 },
            u_strength: { value: 1 },
            u_opacity: { value: 0.5 },
        };
        const tailMat = track(new THREE.ShaderMaterial({
            vertexShader: TAIL_VERT, fragmentShader: TAIL_FRAG,
            uniforms: this._tailU,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this._tailPoints = new THREE.Points(tailGeo, tailMat);
        this._tailPoints.renderOrder = 4;
        // Rotate local +X onto the anti-sunward direction
        this._tailPoints.quaternion.setFromUnitVectors(
            new THREE.Vector3(1, 0, 0),
            sunDir.clone().multiplyScalar(-1).normalize()
        );
        this.group.add(this._tailPoints);

        this._glowOn = true;
        this._tailOn = true;
        this._mode = true;   // surface-view visibility gate
        this._applyVisibility();
    }

    _applyVisibility() {
        this._glowMesh.visible = this._mode && this._glowOn;
        this._tailPoints.visible = this._mode && this._tailOn;
    }

    /** Master gate — false in the interior cutaway view. */
    setVisible(v) { this._mode = !!v; this._applyVisibility(); }
    setGlowVisible(v) { this._glowOn = !!v; this._applyVisibility(); }
    setTailVisible(v) { this._tailOn = !!v; this._applyVisibility(); }

    /**
     * Feed the kernel's live sodium source total (×quiet). Glow and tail
     * brighten with the source; the magnetotail dip and shower spikes come
     * through this one number.
     */
    setActivity(total) {
        const a = Math.max(0, total);
        this._glowU.u_activity.value = a;
        this._tailU.u_strength.value = a;
        this._tailU.u_opacity.value = Math.min(0.85, 0.3 + 0.28 * a);
    }

    update(t) {
        this._tailU.u_time.value = t;
    }

    dispose() {
        this.group.parent?.remove(this.group);
        for (const o of this._disposables) o.dispose?.();
        this._disposables.length = 0;
    }
}
