/**
 * saturn-skin.js — Reusable 3D Saturn renderer: banded disc + atmosphere rim +
 * a physically-structured, *living* ring system.
 *
 * Mirrors the JupiterSkin / NeptuneSkin pattern. The ring is the whole point of
 * this page, so it is not a stack of flat translucent annuli (the Jupiter/
 * Neptune approach) — it is a single ShaderMaterial annulus whose fragment
 * shader evaluates the real radial structure (D/C/B/Cassini/A/F, plus the
 * Encke & Keeler gaps) AND a set of moon-driven, time-dependent features:
 *
 *   • the sharp B-ring outer edge, held as a 2-lobed pattern that co-rotates
 *     with Mimas at its 2:1 inner Lindblad resonance (this is what opens the
 *     Cassini Division);
 *   • the A-ring outer edge, a 7-lobed pattern co-rotating with Janus (7:6);
 *   • spiral density-wave trains launched at the Janus 2:1, Mimas 5:3 and
 *     Prometheus resonances — each train's pattern speed equals the perturbing
 *     moon's mean motion, so the spirals visibly wind around as the moons move;
 *   • scalloped wakes on the Encke- and Keeler-gap edges, co-rotating with the
 *     embedded moonlets Pan and Daphnis;
 *   • Saturn's own shadow cast across the rings (computed in world space, so it
 *     stays correct at any tilt / camera angle).
 *
 * Because every pattern speed is a real moon mean motion, advancing or scrubbing
 * the simulation clock makes the whole ring evolve in lock-step with the moons.
 *
 * ── Frame note ────────────────────────────────────────────────────────────
 *   By default this class keeps Saturn's pole along LOCAL +Y and the rings flat
 *   in the local X–Z plane (tiltSelf:false). The caller is expected to tilt the
 *   whole system group by Saturn's 26.7° obliquity so the rings, moons and orbit
 *   rings all lean together. Pass tiltSelf:true to bake the obliquity here.
 *
 * ── Data-quality notes ───────────────────────────────────────────────────────
 *   Clouds are procedural, not imagery. Ring radii are real (R_S = 60,268 km);
 *   wave amplitudes and gap widths are exaggerated for on-screen legibility,
 *   but their radii and pattern speeds are physical.
 */

import * as THREE from 'three';

const QUALITY_MAP = { low: 0, medium: 1, high: 2 };
const D2R = Math.PI / 180;

// Saturn obliquity to its orbit: 26.73°. Sidereal (System III) rotation:
// 10h 33m 38s ≈ 38,018 s.
const OBLIQUITY    = 26.73 * D2R;
const ROT_PERIOD_S = 10 * 3600 + 33 * 60 + 38;

// ── Planet cloud shader (compact, procedural pale-gold bands + terminator
//    + a faint north-polar hexagon) ──────────────────────────────────────
const SAT_VERT = /* glsl */`
    varying vec3 vObjN;     // object-space normal → latitude bands + hexagon
    varying vec3 vViewN;    // view-space normal   → terminator + rim
    void main() {
        vObjN  = normalize(normal);
        vViewN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;

const SAT_FRAG = /* glsl */`
    precision highp float;
    uniform float u_time;
    uniform float u_spin;        // [0,1) System-III rotation phase
    uniform float u_quality;
    uniform float u_nightFill;
    uniform vec3  u_sunDir;      // view space
    varying vec3 vObjN;
    varying vec3 vViewN;

    float hash(float n){ return fract(sin(n) * 43758.5453123); }
    float noise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n = i.x + i.y * 57.0;
        return mix(mix(hash(n), hash(n + 1.0), f.x),
                   mix(hash(n + 57.0), hash(n + 58.0), f.x), f.y);
    }
    float fbm(vec2 p){
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++){ v += a * noise(p); p *= 2.0; a *= 0.5; }
        return v;
    }

    void main() {
        float lat = clamp(vObjN.y, -1.0, 1.0);            // -1..1 (pole = ±1)
        float lon = atan(vObjN.z, vObjN.x) + u_spin * 6.28318;

        // Pale-gold base, gently banded by latitude. Saturn's belts are subtle.
        float bands = 0.5 + 0.5 * sin(lat * 26.0);
        float warp  = (u_quality > 0.5) ? (fbm(vec2(lon * 1.6, lat * 9.0 + u_time * 0.02)) - 0.5) : 0.0;
        bands = 0.5 + 0.5 * sin(lat * 26.0 + warp * 2.2);

        vec3 cLight = vec3(0.91, 0.82, 0.62);     // bright zone
        vec3 cDark  = vec3(0.79, 0.67, 0.46);     // tan belt
        vec3 col = mix(cDark, cLight, bands);

        // Equatorial brightening + soft polar darkening (bluish high latitudes).
        col = mix(col, vec3(0.95, 0.88, 0.70), smoothstep(0.30, 0.0, abs(lat)) * 0.25);
        col = mix(col, vec3(0.62, 0.66, 0.70), smoothstep(0.78, 1.0, abs(lat)) * 0.45);

        // Faint north-polar hexagon (the real one circles ~78°N).
        if (lat > 0.80) {
            float hex = cos(6.0 * lon);                    // 6-fold ripple
            float ring = smoothstep(0.86, 0.90, lat) * (1.0 - smoothstep(0.95, 0.985, lat));
            col = mix(col, vec3(0.70, 0.72, 0.64), ring * (0.30 + 0.30 * hex));
        }

        // Terminator: lit by the sun (view-space dot), with a soft night fill.
        float ndl = dot(normalize(vViewN), normalize(u_sunDir));
        float lit = smoothstep(-0.18, 0.30, ndl);
        col *= mix(u_nightFill, 1.0, lit);

        // Limb darkening.
        col *= mix(0.6, 1.0, abs(vViewN.z));
        gl_FragColor = vec4(col, 1.0);
    }`;

// ── Ring shader ──────────────────────────────────────────────────────────
const NW = 4;   // density-wave slots
const NG = 2;   // moonlet-gap slots

const RING_VERT = /* glsl */`
    uniform float u_planetRadius;
    varying float vR;        // radius in R_S
    varying float vTheta;    // azimuth (rad)
    varying vec3  vWorld;
    void main() {
        // RingGeometry lies in the local XY plane (z = 0); 1 scene unit = 1 R_S.
        vR     = length(position.xy) / u_planetRadius;
        vTheta = atan(position.y, position.x);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld  = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
    }`;

const RING_FRAG = /* glsl */`
    precision highp float;
    #define NW ${NW}
    #define NG ${NG}
    uniform float u_time;            // simulation seconds
    uniform float u_waveStrength;    // global wave amplitude multiplier
    uniform float u_quality;
    uniform float u_planetRadius;
    uniform vec3  u_sunWorld;        // sun direction (world)
    uniform vec3  u_planetWorld;     // planet centre (world)
    uniform float u_mimasOmega;      // rad/s — B-edge pattern speed (Mimas)
    uniform float u_janusOmega;      // rad/s — A-edge pattern speed (Janus)
    uniform float u_waveR[NW];
    uniform float u_waveM[NW];
    uniform float u_waveOmega[NW];
    uniform float u_waveAmp[NW];
    uniform float u_gapR[NG];
    uniform float u_gapHalf[NG];
    uniform float u_gapOmega[NG];
    varying float vR;
    varying float vTheta;
    varying vec3  vWorld;

    float bandf(float r, float a, float b, float e){
        return smoothstep(a - e, a + e, r) * (1.0 - smoothstep(b - e, b + e, r));
    }

    void main() {
        // Moon-held ring edges (co-rotate with the perturber's pattern speed).
        float bEdge = 1.951 + 0.006 * cos(2.0 * (vTheta - u_mimasOmega * u_time));
        float aEdge = 2.269 + 0.004 * cos(7.0 * (vTheta - u_janusOmega * u_time));

        // Base radial optical-depth profile.
        float tau = 0.0;
        tau += bandf(vR, 1.110, 1.236, 0.004) * 0.06;   // D
        tau += bandf(vR, 1.239, 1.527, 0.004) * 0.16;   // C
        tau += bandf(vR, 1.527, bEdge, 0.004) * 0.95;   // B
        tau += bandf(vR, bEdge, 2.027, 0.004) * 0.10;   // Cassini Division
        tau += bandf(vR, 2.027, aEdge, 0.004) * 0.55;   // A
        tau += bandf(vR, 2.324, 2.328, 0.0016) * 0.75;  // F

        // Static interior structure so the bright rings aren't flat.
        tau += bandf(vR, 1.30, 1.52, 0.02) * 0.05 * (0.5 + 0.5 * sin(vR * 240.0));
        tau += bandf(vR, 1.55, bEdge, 0.02) * 0.08 * (0.5 + 0.5 * sin(vR * 180.0 + 1.0));

        // Where ring material actually exists (so waves only ride on the ring).
        float present = smoothstep(0.02, 0.12, tau);

        // Spiral density-wave trains. Each propagates outward from its
        // resonance radius; the pattern co-rotates at the moon's mean motion.
        for (int i = 0; i < NW; i++) {
            float dr = vR - u_waveR[i];
            if (u_waveAmp[i] > 0.0 && dr > 0.0) {
                float win   = exp(-pow(dr / 0.020, 2.0));               // outward envelope
                float wind  = 170.0 * dr + 2600.0 * dr * dr;            // dispersive winding
                float phase = u_waveM[i] * vTheta - u_waveM[i] * u_waveOmega[i] * u_time + wind;
                tau += u_waveAmp[i] * u_waveStrength * win * present * (0.5 + 0.5 * cos(phase));
            }
        }

        // Embedded-moonlet gaps (Encke / Keeler) — subtract, with scalloped
        // edges that co-rotate with the moonlet.
        for (int i = 0; i < NG; i++) {
            float scallop = 0.0010 * cos(8.0 * (vTheta - u_gapOmega[i] * u_time));
            float d = abs(vR - (u_gapR[i] + scallop));
            if (d < u_gapHalf[i]) tau *= smoothstep(0.0, u_gapHalf[i], d) * 0.10;
        }

        // Composition tint by radius (matches saturn-rings.js ringColor()).
        vec3 col = vec3(0.42, 0.39, 0.35);
        col = mix(col, vec3(0.54, 0.50, 0.45), smoothstep(1.236, 1.30, vR));
        col = mix(col, vec3(0.86, 0.78, 0.61), smoothstep(1.50, 1.56, vR));
        col = mix(col, vec3(0.43, 0.39, 0.33), smoothstep(bEdge - 0.012, bEdge + 0.012, vR));
        col = mix(col, vec3(0.80, 0.72, 0.54), smoothstep(2.02, 2.05, vR));
        col = mix(col, vec3(0.93, 0.89, 0.81), smoothstep(2.30, 2.324, vR));

        // Saturn's shadow on the rings (cylindrical approximation, world space).
        vec3 toFrag = vWorld - u_planetWorld;
        vec3 s = normalize(u_sunWorld);
        float along = dot(toFrag, s);
        float shadow = 1.0;
        if (along < 0.0) {
            float perp = length(toFrag - along * s);
            shadow = mix(0.18, 1.0, smoothstep(u_planetRadius * 0.97, u_planetRadius * 1.06, perp));
        }

        float bright = (0.55 + 0.75 * tau) * shadow;
        float alpha  = smoothstep(0.0, 0.05, tau) * min(1.0, 0.22 + tau * 0.95);
        gl_FragColor = vec4(col * bright, alpha);
    }`;

export class SaturnSkin {
    /**
     * @param {THREE.Object3D} parent
     * @param {object} opts
     * @param {number}  [opts.radius=1.0]
     * @param {string}  [opts.quality='medium']
     * @param {boolean} [opts.rings=true]
     * @param {boolean} [opts.atmosphere=true]
     * @param {number}  [opts.segments=48]
     * @param {boolean} [opts.tiltSelf=false]  Bake obliquity onto the meshes.
     * @param {number}  [opts.ringInner=1.11]  Inner ring radius (R_S).
     * @param {number}  [opts.ringOuter=2.33]  Outer ring radius (R_S).
     * @param {Array}   [opts.features=[]]      Moon-driven ring features.
     *        Each: { type:'wave'|'edge'|'gap', perturber, r, m, omega, amp }.
     */
    constructor(parent, {
        radius     = 1.0,
        quality    = 'medium',
        rings      = true,
        atmosphere = true,
        segments   = 48,
        tiltSelf   = false,
        ringInner  = 1.11,
        ringOuter  = 2.33,
        features   = [],
    } = {}) {
        this._parent = parent;
        this._radius = radius;
        this._rotPhase = 0;
        const tilt = tiltSelf ? OBLIQUITY : 0;

        // ── Cloud deck ────────────────────────────────────────────────────
        this.saturnU = {
            u_time:      { value: 0 },
            u_spin:      { value: 0 },
            u_quality:   { value: QUALITY_MAP[quality] ?? 1 },
            u_nightFill: { value: 0.16 },
            u_sunDir:    { value: new THREE.Vector3(0, 0, 1) },
        };
        const cloudMat = new THREE.ShaderMaterial({
            vertexShader: SAT_VERT, fragmentShader: SAT_FRAG, uniforms: this.saturnU,
        });
        this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, segments, segments), cloudMat);
        this.mesh.name = 'saturn';
        this.mesh.rotation.x = tilt;
        parent.add(this.mesh);

        // Slight oblateness — Saturn is the flattest planet (f ≈ 0.098).
        this.mesh.scale.set(1, 0.90, 1);

        // ── Atmosphere rim glow ───────────────────────────────────────────
        if (atmosphere) {
            const atmU = {
                uSunDir:  { value: new THREE.Vector3(0, 0, 1) },
            };
            const atmMat = new THREE.ShaderMaterial({
                uniforms: atmU, transparent: true, depthWrite: false,
                blending: THREE.AdditiveBlending, side: THREE.BackSide,
                vertexShader: /* glsl */`
                    varying vec3 vN;
                    void main(){ vN = normalize(normalMatrix * normal);
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
                fragmentShader: /* glsl */`
                    precision highp float;
                    uniform vec3 uSunDir; varying vec3 vN;
                    void main(){
                        float fres = pow(1.0 - abs(vN.z), 3.0);
                        float ndl  = dot(normalize(vN), normalize(uSunDir));
                        float lit  = smoothstep(-0.5, 0.5, ndl);
                        vec3 base  = vec3(0.95, 0.85, 0.62);
                        float a = fres * (0.07 + 0.30 * lit);
                        gl_FragColor = vec4(base, a);
                    }`,
            });
            const atm = new THREE.Mesh(
                new THREE.SphereGeometry(radius * 1.05, Math.round(segments * 0.7), Math.round(segments * 0.7)),
                atmMat);
            atm.scale.set(1, 0.90, 1);
            atm.rotation.x = tilt;
            atm.renderOrder = 2;
            parent.add(atm);
            this._atmMesh = atm;
            this._atmU = atmU;
        }

        // ── Ring system (the centrepiece) ─────────────────────────────────
        this._ringMeshes = [];
        if (rings) {
            // Build the moon-driven feature uniforms.
            const waveR = new Array(NW).fill(0), waveM = new Array(NW).fill(0),
                  waveO = new Array(NW).fill(0), waveA = new Array(NW).fill(0);
            const gapR = new Array(NG).fill(0), gapH = new Array(NG).fill(0), gapO = new Array(NG).fill(0);
            let wi = 0, gi = 0, mimasOmega = 0, janusOmega = 0;
            for (const f of features) {
                if (f.type === 'wave' && wi < NW) {
                    waveR[wi] = f.r; waveM[wi] = f.m; waveO[wi] = f.omega; waveA[wi] = f.amp; wi++;
                } else if (f.type === 'gap' && gi < NG) {
                    gapR[gi] = f.r; gapH[gi] = f.half ?? 0.003; gapO[gi] = f.omega; gi++;
                } else if (f.type === 'edge') {
                    if (f.perturber === 'mimas') mimasOmega = f.omega;
                    if (f.perturber === 'janus') janusOmega = f.omega;
                }
            }

            this.ringU = {
                u_time:        { value: 0 },
                u_waveStrength:{ value: 1.0 },
                u_quality:     { value: QUALITY_MAP[quality] ?? 1 },
                u_planetRadius:{ value: radius },
                u_sunWorld:    { value: new THREE.Vector3(1, 0.2, 0).normalize() },
                u_planetWorld: { value: new THREE.Vector3(0, 0, 0) },
                u_mimasOmega:  { value: mimasOmega },
                u_janusOmega:  { value: janusOmega },
                u_waveR:       { value: waveR },
                u_waveM:       { value: waveM },
                u_waveOmega:   { value: waveO },
                u_waveAmp:     { value: waveA },
                u_gapR:        { value: gapR },
                u_gapHalf:     { value: gapH },
                u_gapOmega:    { value: gapO },
            };
            const ringMat = new THREE.ShaderMaterial({
                vertexShader: RING_VERT, fragmentShader: RING_FRAG, uniforms: this.ringU,
                transparent: true, depthWrite: false, side: THREE.DoubleSide,
            });
            const geo = new THREE.RingGeometry(radius * ringInner, radius * ringOuter, 384, 6);
            const ring = new THREE.Mesh(geo, ringMat);
            ring.rotation.x = tiltSelf ? (OBLIQUITY - Math.PI / 2) : (-Math.PI / 2);
            ring.renderOrder = 3;
            parent.add(ring);
            this._ringMeshes.push(ring);
            this._mainRing = ring;

            // Faint, broad outer rings (G + E) drawn as simple translucent
            // annuli — too diffuse to deserve shader structure.
            const faint = [
                [2.754, 2.903, 0x5d5a52, 0.05],   // G
                [2.99,  5.20,  0x33454e, 0.05],   // E (Enceladus-fed, bluish)
            ];
            for (const [a, b, color, op] of faint) {
                const g = new THREE.RingGeometry(radius * a, radius * b, 128);
                const m = new THREE.MeshBasicMaterial({
                    color, side: THREE.DoubleSide, transparent: true, opacity: op,
                    depthWrite: false, blending: THREE.AdditiveBlending,
                });
                const r = new THREE.Mesh(g, m);
                r.rotation.x = tiltSelf ? (OBLIQUITY - Math.PI / 2) : (-Math.PI / 2);
                r.renderOrder = 1;
                parent.add(r);
                this._ringMeshes.push(r);
            }
        }
    }

    /** Wall-clock animation: turbulence churn + rotation phase. */
    update(t, opts = {}) {
        this.saturnU.u_time.value = t;
        if (opts.spinPhase !== undefined) {
            this.saturnU.u_spin.value = opts.spinPhase;
            this.mesh.rotation.y = opts.spinPhase * Math.PI * 2;
        } else {
            this._rotPhase += (2 * Math.PI / ROT_PERIOD_S) * (1 / 60);
            this.saturnU.u_spin.value = ((t / ROT_PERIOD_S) % 1 + 1) % 1;
            this.mesh.rotation.y = this._rotPhase;
        }
    }

    /** Advance the *ring* evolution to simulation time t_s (seconds). */
    setSimTime(t_s) {
        if (this.ringU) this.ringU.u_time.value = t_s;
    }

    /** Point lighting at the sun. dirView = sun direction in VIEW space. */
    setSun(dirView) {
        this.saturnU.u_sunDir.value.copy(dirView);
        if (this._atmU) this._atmU.uSunDir.value.copy(dirView);
    }

    /** Sun + planet centre in WORLD space — drives the ring shadow. */
    setRingShadow(sunWorld, planetWorld) {
        if (!this.ringU) return;
        this.ringU.u_sunWorld.value.copy(sunWorld);
        if (planetWorld) this.ringU.u_planetWorld.value.copy(planetWorld);
    }

    setWaveStrength(s) { if (this.ringU) this.ringU.u_waveStrength.value = s; }

    setQuality(q) {
        const v = QUALITY_MAP[q] ?? 1;
        this.saturnU.u_quality.value = v;
        if (this.ringU) this.ringU.u_quality.value = v;
    }

    setVisible(v) {
        this.mesh.visible = v;
        if (this._atmMesh) this._atmMesh.visible = v;
        for (const r of this._ringMeshes) r.visible = v;
    }

    /** Toggle only the ring system. */
    setRingsVisible(v) { for (const r of this._ringMeshes) r.visible = v; }
}

export { OBLIQUITY as SATURN_OBLIQUITY, ROT_PERIOD_S as SATURN_ROT_PERIOD_S };
