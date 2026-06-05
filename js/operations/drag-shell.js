/**
 * drag-shell.js — Atmospheric drag shell for the Operations globe.
 *
 * A translucent shell at a representative LEO altitude (~450 km) whose
 * brightness and colour encode the thermospheric mass density the fleet is
 * flying through. It reads `drag.rho450` from the provenance store — the
 * same density the decay maths consume — so when the space-weather model
 * (sw-model.js) drives the indices forward through a forecast storm, the
 * shell brightens in lockstep with the decay ETAs shortening. Without this
 * coupling the shell would be a backdrop; with it, it is the forecast made
 * visible.
 *
 * The density model (upper-atmosphere-engine.density) has no local-solar-
 * time term — T∞ is global — so the shell's overall intensity encodes the
 * *global* drag state at simTimeMs honestly. A subtle dayside brightening
 * is layered on for legibility using the globe's sun direction; it is
 * cosmetic, not a claim about diurnal density structure.
 */

import * as THREE     from 'three';
import { provStore }  from './provenance.js';
import { SHELL_ALTITUDE_KM, RHO_REF_450 } from './sw-model.js';

const EARTH_RADIUS_KM = 6371;
// Reference (quiet) density the colour ramp is normalised against — shared
// with the "drag ×N vs quiet" overhead so the globe and the panel agree.
const RHO_REF = RHO_REF_450;

// Calm → storm colour endpoints (linear RGB-ish; the additive blend warms
// them further on screen).
const CALM_COLOR  = new THREE.Color(0x1f8fff);
const STORM_COLOR = new THREE.Color(0xff5a1e);

const VERT = /* glsl */`
    varying vec3 vNormalW;
    varying vec3 vViewDir;
    void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - worldPos.xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
`;

const FRAG = /* glsl */`
    precision mediump float;
    uniform vec3  uColor;
    uniform float uOpacity;
    uniform vec3  uSunDir;
    varying vec3  vNormalW;
    varying vec3  vViewDir;
    void main() {
        // Rim glow: strongest where the shell is edge-on to the camera,
        // which reads as a luminous atmosphere limb.
        float fres = pow(1.0 - max(dot(vViewDir, vNormalW), 0.0), 2.2);
        // Cosmetic dayside lift so the lit hemisphere reads brighter.
        float day  = 0.6 + 0.4 * clamp(dot(vNormalW, uSunDir), 0.0, 1.0);
        float a = uOpacity * (0.35 + 0.65 * fres) * day;
        gl_FragColor = vec4(uColor * day, a);
    }
`;

export class DragShell {
    constructor(globe, opts = {}) {
        this.globe = globe;
        const Rscene = globe.getEarthRadius();
        const shellR = Rscene * (1 + SHELL_ALTITUDE_KM / EARTH_RADIUS_KM);

        this.material = new THREE.ShaderMaterial({
            uniforms: {
                uColor:   { value: CALM_COLOR.clone() },
                uOpacity: { value: 0.08 },
                uSunDir:  { value: new THREE.Vector3(1, 0, 0) },
            },
            vertexShader:   VERT,
            fragmentShader: FRAG,
            transparent: true,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
            side:        THREE.FrontSide,
        });

        this.mesh = new THREE.Mesh(new THREE.SphereGeometry(shellR, 64, 48), this.material);
        this.mesh.renderOrder = 2;   // after Earth + base atmosphere
        this.mesh.visible = opts.visible ?? true;
        globe.getScene().add(this.mesh);

        this._color = new THREE.Color();
        this._applyDensity(provStore.get('drag.rho450')?.value);
        this._off = provStore.subscribe((key) => {
            if (key === 'drag.rho450') this._applyDensity(provStore.get('drag.rho450')?.value);
        });
    }

    /** Map ρ(450 km) → shell colour + opacity via a log ratio to quiet. */
    _applyDensity(rho) {
        if (!Number.isFinite(rho) || rho <= 0) return;
        const lr = Math.log10(rho / RHO_REF);           // 0 at quiet reference
        // Quiet reads calm (t≈0.12) so a storm pops; a G5 (~20× ρ, lr≈1.3)
        // saturates the ramp to full storm colour.
        const t  = THREE.MathUtils.clamp((lr + 0.12) / 1.0, 0, 1);
        this._color.copy(CALM_COLOR).lerp(STORM_COLOR, t);
        this.material.uniforms.uColor.value.copy(this._color);
        this.material.uniforms.uOpacity.value = 0.05 + 0.24 * t;
    }

    /** Per-frame: refresh the cosmetic dayside direction from the globe. */
    tick() {
        if (!this.mesh.visible) return;
        const sun = this.globe.getSunDirection?.();
        if (sun) this.material.uniforms.uSunDir.value.copy(sun);
    }

    setVisible(on) { this.mesh.visible = !!on; }
    isVisible() { return this.mesh.visible; }

    dispose() {
        this._off?.();
        this.globe.getScene().remove(this.mesh);
        this.mesh.geometry.dispose();
        this.material.dispose();
    }
}
