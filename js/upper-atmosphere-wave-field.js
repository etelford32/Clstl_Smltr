/**
 * upper-atmosphere-wave-field.js — animated turbulence ripple overlay
 * ═══════════════════════════════════════════════════════════════════════════
 * Visualises the per-zone turbulence index (see
 * upper-atmosphere-turbulence.js) as a TRAVELLING ATMOSPHERIC DISTURBANCE
 * (TAD) ripple riding on each zone's shell. When a geomagnetic storm
 * launches large-scale gravity waves out of the auroral oval, the
 * thermosphere's density surfaces ripple — this overlay is the visual
 * proxy for that, with the ripple amplitude driven by each zone's live
 * turbulence index.
 *
 * One ZoneWaveField per atmospheric zone. Each is a single displaced
 * icosphere at the zone's peak radius, animated entirely on the GPU:
 *
 *   • vertex shader displaces each vertex along its normal by
 *     amp · sin(k·ϕ + m·θ − ω·t)  — a spiralling travelling wave
 *   • amp comes from the zone's turbulence index (setTurbulence)
 *   • fragment shader paints an additive glow whose alpha tracks the
 *     crest displacement, so crests read as bright ridges sweeping
 *     across the shell
 *
 * Cost is one uniform write per frame per visible zone (uTime); the wave
 * is computed in-shader. Hidden zones (amp ≈ 0 or master-off) cost
 * nothing — `mesh.visible` gates the draw.
 *
 * Mirrors the LayerVectorField contract (constructor mounts under a
 * parent group, setVisible / setTurbulence / update / dispose) so the
 * globe wires it the same way it wires the vector fields.
 *
 * @example
 *     const wf = new ZoneWaveField({ parent: group, layer });
 *     wf.setTurbulence(0.6);     // ripple amplitude tracks the index
 *     // per frame:
 *     wf.update(elapsedSeconds);
 */

import * as THREE from 'three';

const R_EARTH_KM = 6371;

// Icosphere tessellation. detail 5 → 10·4⁵+2 ≈ 10242 vertices: smooth
// enough that the displacement reads as a continuous wave rather than a
// faceted blob, still one cheap draw.
const ICO_DETAIL = 5;

// Peak displacement at ti = 1, as a fraction of the shell radius. Kept
// small so the ripple reads as a perturbation of the shell, not a
// pulsating balloon that collides with neighbouring zones.
const MAX_AMP_FRAC = 0.022;

// Wave numbers (spatial frequency along latitude / longitude) and angular
// speed. Chosen so a few crest bands wrap the globe and sweep across it on
// a ~20 s period — fast enough to read as "live", slow enough not to
// strobe.
const K_LAT   = 6.0;
const M_LON   = 5.0;
const OMEGA   = 0.55;

const VERT = /* glsl */`
    uniform float uTime;
    uniform float uAmp;      // peak displacement (world units)
    uniform float uK;        // latitude wavenumber
    uniform float uM;        // longitude wavenumber
    uniform float uOmega;    // angular speed
    varying float vCrest;    // -1..1 crest signal for the fragment stage

    void main() {
        // Spherical angles from the unit position. The icosphere is a
        // unit sphere pre-scale, so the position is already ~unit length.
        vec3  p   = normalize(position);
        float lat = asin(clamp(p.y, -1.0, 1.0));      // -π/2..π/2
        float lon = atan(p.z, p.x);                   // -π..π

        // Spiralling travelling wave: latitude + longitude phase minus
        // ω·t makes crests sweep across the shell over time.
        float phase = uK * lat + uM * lon - uOmega * uTime;
        float crest = sin(phase);
        vCrest = crest;

        // Displace along the (unit) normal — which on a sphere is p.
        vec3 displaced = position + p * (crest * uAmp);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
    }
`;

const FRAG = /* glsl */`
    precision mediump float;
    uniform vec3  uColor;
    uniform float uOpacity;  // master opacity, scales with turbulence
    varying float vCrest;

    void main() {
        // Bright on crests, dim in troughs — a soft ridge highlight.
        float crest = 0.5 + 0.5 * vCrest;            // 0..1
        float a = uOpacity * (0.12 + 0.88 * pow(crest, 2.0));
        gl_FragColor = vec4(uColor * (0.6 + 0.4 * crest), a);
    }
`;

export class ZoneWaveField {
    /**
     * @param {object} opts
     * @param {THREE.Object3D} opts.parent  group / scene to mount under
     * @param {object}         opts.layer   ATMOSPHERIC_LAYER_SCHEMA entry
     */
    constructor({ parent, layer }) {
        this.layer = layer;
        this._ti = 0;

        const peakKm = Number.isFinite(layer.peakKm)
            ? layer.peakKm
            : (layer.minKm + layer.maxKm) / 2;
        this._radius = 1 + peakKm / R_EARTH_KM;

        // Colour: reuse the zone's shell hue so the ripple reads as "this
        // zone's turbulence", not a free-floating effect.
        const hi = new THREE.Color(layer.colorHigh ?? 0xffffff);

        this._material = new THREE.ShaderMaterial({
            uniforms: {
                uTime:    { value: 0 },
                uAmp:     { value: 0 },
                uK:       { value: K_LAT },
                uM:       { value: M_LON },
                uOmega:   { value: OMEGA },
                uColor:   { value: hi },
                uOpacity: { value: 0 },
            },
            vertexShader:   VERT,
            fragmentShader: FRAG,
            transparent:    true,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
            side:           THREE.FrontSide,
        });

        const geom = new THREE.IcosahedronGeometry(this._radius, ICO_DETAIL);
        this.mesh = new THREE.Mesh(geom, this._material);
        this.mesh.frustumCulled = false;
        this.mesh.visible = false;             // master-off until shown
        this.mesh.renderOrder = 3;             // after the gradient shells
        this.mesh.userData = {
            kind: 'zone-wave-field',
            id:   layer.id,
            name: `${layer.name} turbulence`,
        };

        this._masterOn = false;
        parent.add(this.mesh);
    }

    /** Master visibility toggle (the operator's "turbulence field" switch). */
    setVisible(on) {
        this._masterOn = !!on;
        this._applyVisibility();
    }

    /**
     * Push the zone's turbulence index (0..1). Drives ripple amplitude +
     * glow opacity. A zone below the visibility floor collapses to a flat,
     * invisible shell so a calm atmosphere doesn't shimmer.
     */
    setTurbulence(ti) {
        this._ti = Number.isFinite(ti) ? Math.max(0, Math.min(1, ti)) : 0;
        // Amplitude eases in with a slight gamma so low indices stay
        // subtle and high indices clearly stand out.
        const eased = Math.pow(this._ti, 1.3);
        this._material.uniforms.uAmp.value     = eased * MAX_AMP_FRAC * this._radius;
        this._material.uniforms.uOpacity.value = 0.10 + 0.55 * eased;
        this._applyVisibility();
    }

    /** Advance the travelling-wave phase. Call once per animation frame. */
    update(elapsedSeconds) {
        if (!this.mesh.visible) return;
        this._material.uniforms.uTime.value = elapsedSeconds;
    }

    _applyVisibility() {
        // Only draw when the master switch is on AND there's enough
        // turbulence to be worth a draw call.
        this.mesh.visible = this._masterOn && this._ti > 0.02;
    }

    dispose() {
        this.mesh.geometry?.dispose();
        this._material?.dispose();
        this.mesh.parent?.remove(this.mesh);
    }
}
