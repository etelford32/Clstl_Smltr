/**
 * upper-atmosphere-particles.js — per-layer molecular visualisation
 * ═══════════════════════════════════════════════════════════════════════════
 * One LayerParticleSystem per atmospheric layer. Each system:
 *
 *   • renders THREE.Points sprites distributed inside its altitude band
 *   • count scales with log(n_total) — visibly denser layers carry more
 *     dots, tied to *real* number density rather than decoration
 *   • per-frame motion model:
 *       - thermal jitter step:   Δp ~ N(0, vth · dt)   isotropic
 *       - direction-decorrelation rate ~ collision frequency. In the
 *         continuum regime (mesosphere) particles change heading
 *         every step; in the free-molecular regime (exosphere) they
 *         hold a heading for many seconds, drifting in long ballistic
 *         arcs.
 *       - solar-wind drift: when Kp ≥ ~4 (Ap ≥ 27) particles in
 *         lower-thermosphere and above gain a small radially-outward
 *         velocity component — Joule heating expansion of the
 *         thermosphere is exactly this physics, and the visual reads
 *         it as "atmosphere puffs up under solar forcing".
 *   • point colour = the layer's `speciesHint` colour (atomic O → orange,
 *     He → pink, H → yellow, N₂ → blue) so the user can see composition
 *     change with altitude at a glance
 *
 * Mounted as a child of the scene (NOT earthMesh — there's no
 * geographic anchoring; particles represent the layer in aggregate).
 * Per-system .visible toggles are controlled by the UI via
 * AtmosphereGlobe.setLayerVisible(id, bool).
 *
 * Performance budget (5 layers × ~250 avg particles = ~1250 sprites,
 * one Points draw call per layer):
 *   • position update on CPU per frame: ~7500 mul-adds @ 60 fps =
 *     ~450 K ops/sec. Trivial; no need for shader-side compute.
 *   • allocate one Float32Array per attribute, write in-place.
 */

import * as THREE from 'three';

const R_EARTH_KM = 6371;

// Visualisation-time scaling — converts the SI thermal speed (m/s)
// into a per-frame world-units jitter step. At true scale a 1500 K H
// atom moves ~6 km/s = 0.001 R⊕/frame, which is too fast to read as
// thermal motion — particles would teleport. We compress by this
// factor so motion *reads* as thermal (slow drift in dense layers,
// faster ballistic arcs in rarefied ones) without losing the
// proportionality between layers.
const VTH_VIS_FACTOR = 1 / 1.6e7;   // R⊕ per (m/s · s)

// Cap the per-frame step so even free-molecular hydrogen looks like
// motion, not teleportation.
const MAX_STEP_RUNIT = 0.0009;

// Solar-wind expansion: Joule heating heats the thermosphere during
// storms; bulk effect is a radially outward "puff". Mapped from Ap
// linearly above the threshold.
const STORM_AP_THRESHOLD = 27;       // ≈ Kp 4
const STORM_DRIFT_RUNIT_PER_S = 0.012;   // peak outward drift @ Ap 200

const MIN_PARTICLES = 18;
const REGIME_DECORRELATION_HZ = {
    'continuum':       60,    // re-randomise direction every frame
    'slip':            12,
    'transition':       2,
    'free-molecular':   0.15,  // ~7 s between direction changes
    'unknown':          1,
};


export class LayerParticleSystem {
    /**
     * @param {object}   opts
     * @param {THREE.Scene|THREE.Object3D} opts.parent   where to mount
     * @param {object}   opts.layer    one entry from ATMOSPHERIC_LAYER_SCHEMA
     * @param {number}   [opts.maxRunitR=2.0]  outer-radius soft clip in R⊕
     */
    constructor({ parent, layer, maxRunitR = 2.0 }) {
        this.layer = layer;
        this._parent = parent;
        this._maxRunitR = maxRunitR;

        const cap = layer.particleCap ?? 200;
        this._cap = cap;
        this._n   = 0;          // active particle count (≤ cap; tracks density)

        // Pre-allocate to cap so we never re-allocate buffers — instead
        // we draw the first this._n vertices via geometry.setDrawRange().
        this._positions  = new Float32Array(cap * 3);
        this._velocities = new Float32Array(cap * 3);
        this._colors     = new Float32Array(cap * 3);

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position',
            new THREE.BufferAttribute(this._positions, 3));
        geom.setAttribute('color',
            new THREE.BufferAttribute(this._colors, 3));
        geom.setDrawRange(0, 0);     // start hidden until first density push

        const mat = new THREE.PointsMaterial({
            size:             layer.particleSize ?? 0.005,
            vertexColors:     true,
            sizeAttenuation:  true,
            transparent:      true,
            opacity:          0.85,
            depthWrite:       false,
            blending:         THREE.AdditiveBlending,
        });

        this._geom = geom;
        this._mat  = mat;
        this.points = new THREE.Points(geom, mat);
        this.points.renderOrder = 5;            // above shells (0–4), under sat rings
        this.points.userData = {
            kind: 'layer-particles',
            id:    layer.id,
            name:  layer.name,
        };
        this.points.frustumCulled = false;      // we span the full globe
        parent.add(this.points);

        // Last-known physics + state — populated by setPhysics(state).
        this._phys = null;
        this._driftRunitPerS = 0;
        // Direction-decorrelation accumulator (s remaining).
        this._decorrAcc = new Float32Array(cap);
    }

    /**
     * Push the latest physics + solar state. Drives:
     *   • how many of the cap are visible (∝ log nTotal)
     *   • per-particle colour (from layer's species hint)
     *   • thermal-step magnitude (from vth)
     *   • storm-drift magnitude (from ap)
     *
     * Cheap to call every refresh — no buffer resize, only re-population
     * of the visible-prefix.
     *
     * @param {object} phys  output of layerPhysics(layer, …)
     * @param {object} state { f107, ap }
     */
    setPhysics(phys, state) {
        this._phys = phys;

        // Particle count from log(n) — clamp so even the rarefied outer
        // exosphere shows some particles.
        const log10n = Math.log10(Math.max(phys.n, 1));
        // Empirically: thermosphere n ~ 1e14, exosphere ~ 1e8, inner-
        // exosphere ~ 1e10. Map [8..16] → [MIN..cap].
        const t = Math.max(0, Math.min(1, (log10n - 8) / 8));
        const target = Math.max(MIN_PARTICLES,
            Math.round(MIN_PARTICLES + t * (this._cap - MIN_PARTICLES)));

        // Spawn / despawn delta — write only the new particles.
        if (target > this._n) {
            for (let i = this._n; i < target; i++) {
                this._spawnParticle(i, phys);
            }
        } else if (target < this._n) {
            // Implicit despawn — drawRange shrinks; the extra trailing
            // entries stay in the buffer but don't render.
        }
        this._n = target;
        this._geom.setDrawRange(0, target);

        // Colour: paint every visible particle by the dominant-species
        // hue. Cheap; only N writes per refresh, not per frame.
        const c = new THREE.Color(phys.dominantColor);
        for (let i = 0; i < target; i++) {
            this._colors[i * 3 + 0] = c.r;
            this._colors[i * 3 + 1] = c.g;
            this._colors[i * 3 + 2] = c.b;
        }
        this._geom.attributes.color.needsUpdate = true;

        // Solar-wind drift: above the storm threshold, scale linearly
        // until Ap≈200. Free-molecular layers feel it more strongly
        // because there's nothing to thermalise the input.
        const ap = state?.ap ?? 0;
        const stormFactor = Math.max(0,
            (ap - STORM_AP_THRESHOLD) / (200 - STORM_AP_THRESHOLD));
        // Apply only to thermospheric+ layers (no Joule heating in
        // mesosphere — that's stratosphere/ionosphere coupling, separate
        // physics).
        const layerIdx = ['mesosphere','lower-thermosphere','upper-thermosphere','inner-exosphere','outer-exosphere']
            .indexOf(this.layer.id);
        const layerWeight = layerIdx <= 0 ? 0 : Math.min(1, layerIdx / 3);
        this._driftRunitPerS = stormFactor * STORM_DRIFT_RUNIT_PER_S * layerWeight;

        // Cache a per-layer step magnitude in R⊕.
        const stepMag = Math.min(MAX_STEP_RUNIT,
            phys.vth_m_s * VTH_VIS_FACTOR);
        this._stepMag = stepMag;

        // Direction-decorrelation rate from regime.
        this._decorrHz = REGIME_DECORRELATION_HZ[phys.regime] ?? 1;
    }

    /**
     * Per-frame integration. dtSec capped to 1/15s so a tab-switch pause
     * doesn't fling every particle out of its layer on resume.
     */
    update(dtSec) {
        if (!this._phys || this._n === 0) return;
        const dt = Math.min(0.0667, Math.max(0.001, dtSec));
        const stepMag = this._stepMag;
        const drift   = this._driftRunitPerS;
        const decorrHz = this._decorrHz;
        const innerR  = 1 + this.layer.minKm / R_EARTH_KM;
        const outerR  = Math.min(this._maxRunitR,
            1 + this.layer.maxKm / R_EARTH_KM);

        const pos = this._positions;
        const vel = this._velocities;
        const dec = this._decorrAcc;

        for (let i = 0; i < this._n; i++) {
            const j = i * 3;

            // Direction decorrelation: probability per frame = decorrHz·dt.
            dec[i] += dt;
            if (dec[i] > 1 / decorrHz || Math.random() < decorrHz * dt) {
                this._randomVelocity(j, stepMag);
                dec[i] = 0;
            }

            // Solar-wind radial drift: add an outward component scaled
            // by the layer's height inside its band (upper-band
            // particles get the bigger push).
            if (drift > 0) {
                const r = Math.hypot(pos[j], pos[j+1], pos[j+2]) || 1;
                const inv = drift / r;
                vel[j]   += pos[j]   * inv * dt;
                vel[j+1] += pos[j+1] * inv * dt;
                vel[j+2] += pos[j+2] * inv * dt;
            }

            // Integrate.
            pos[j]   += vel[j]   * dt * 60;   // frame-time normalisation
            pos[j+1] += vel[j+1] * dt * 60;
            pos[j+2] += vel[j+2] * dt * 60;

            // Reflect off layer boundaries — keeps each layer's
            // particles in its own altitude band so the visual reads
            // as "molecules in this layer" not "particles drifting
            // randomly".
            const r2 = pos[j] * pos[j] + pos[j+1] * pos[j+1] + pos[j+2] * pos[j+2];
            const r  = Math.sqrt(r2);
            if (r < innerR || r > outerR) {
                // Project back to the boundary it crossed.
                const target = r < innerR ? innerR + 0.0005 : outerR - 0.0005;
                const k = target / r;
                pos[j]   *= k;
                pos[j+1] *= k;
                pos[j+2] *= k;
                // Flip radial velocity component to bounce.
                const radVx = pos[j]   / target;
                const radVy = pos[j+1] / target;
                const radVz = pos[j+2] / target;
                const vDotR = vel[j]*radVx + vel[j+1]*radVy + vel[j+2]*radVz;
                vel[j]   -= 2 * vDotR * radVx;
                vel[j+1] -= 2 * vDotR * radVy;
                vel[j+2] -= 2 * vDotR * radVz;
            }
        }
        this._geom.attributes.position.needsUpdate = true;
    }

    setVisible(v) {
        this.points.visible = !!v;
    }

    dispose() {
        this._parent?.remove(this.points);
        this._geom.dispose();
        this._mat.dispose();
    }

    // ── Internals ───────────────────────────────────────────────────────────

    _spawnParticle(i, phys) {
        // Uniform random direction on sphere + uniform random radius
        // inside the layer band. Maxwell-Boltzmann speed (visual scale).
        const j = i * 3;
        const innerR = 1 + this.layer.minKm / R_EARTH_KM;
        const outerR = 1 + this.layer.maxKm / R_EARTH_KM;
        const r = innerR + Math.random() * (outerR - innerR);
        const theta = 2 * Math.PI * Math.random();
        const phi   = Math.acos(1 - 2 * Math.random());
        const sinphi = Math.sin(phi);
        this._positions[j]     = r * sinphi * Math.cos(theta);
        this._positions[j + 1] = r * Math.cos(phi);
        this._positions[j + 2] = r * sinphi * Math.sin(theta);

        const stepMag = Math.min(MAX_STEP_RUNIT,
            phys.vth_m_s * VTH_VIS_FACTOR);
        this._randomVelocity(j, stepMag);
        this._decorrAcc[i] = Math.random() * 0.5;
    }

    _randomVelocity(j, stepMag) {
        // Isotropic random direction × thermal-magnitude.
        const theta = 2 * Math.PI * Math.random();
        const phi   = Math.acos(1 - 2 * Math.random());
        const sinphi = Math.sin(phi);
        this._velocities[j]     = stepMag * sinphi * Math.cos(theta);
        this._velocities[j + 1] = stepMag * Math.cos(phi);
        this._velocities[j + 2] = stepMag * sinphi * Math.sin(theta);
    }
}
