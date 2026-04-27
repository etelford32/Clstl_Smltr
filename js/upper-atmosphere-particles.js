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

// Maxwell-Boltzmann per-component standard-deviation factor.
// vth = √(8kT/πm) is the *mean* speed; per-axis Gaussian σ = √(kT/m)
// = vth · √(π/8) ≈ 0.6267 · vth. Using this, the resulting |v| follows
// the proper MB speed distribution f(v) ∝ v² · exp(-v²/2σ²).
const MB_PER_AXIS_STD = Math.sqrt(Math.PI / 8);   // ≈ 0.6267

// ── Thermospheric neutral wind ──────────────────────────────────────────────
// In the upper thermosphere, solar EUV heating drives a global subsolar→
// antisolar circulation: dayside gas expands and flows around the planet
// to the cold nightside. Typical speeds: ~150 m/s at solar minimum,
// ~400 m/s at solar maximum, with strong polar enhancement during storms
// (Joule + ion-drag forcing on Earth's open field lines).
//
// At each particle we project the sun direction onto the local tangent
// plane and apply −1 × that vector as the wind direction (away from sun).
// The unnormalised tangent has length sin(SZA), which gives a natural
// "zero at sub-solar / anti-solar, peak at terminator" magnitude
// envelope without an explicit sin(SZA) multiplier.
//
// The vis factor here is intentionally larger than VTH_VIS_FACTOR — wind
// is a *coherent bulk drift*, so it needs to be visible across a few
// seconds of integration without compressing into noise. Calibrated so
// 200 m/s reads as ~15 km/s of visual drift = a particle traverses ~5°
// of the planet over a 30-s session.
const WIND_VIS_FACTOR     = 1 / 1.0e5;   // R⊕ per (m/s · s) for bulk wind
const WIND_BASE_M_PER_S   = 80;          // quiet-time floor
const WIND_F107_GAIN_M_S  = 320;         // adds proportional to (F10.7 - 65) / (300 - 65)
const WIND_STORM_GAIN_M_S = 200;         // adds proportional to storm factor

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

// Layers that feel the thermospheric wind. Mesosphere is below the EUV-
// heating maximum, so we exclude it — wind there is dominated by
// atmospheric tides + gravity waves which we don't model in this view.
const WIND_LAYERS = new Set([
    'lower-thermosphere',
    'upper-thermosphere',
    'inner-exosphere',
    'outer-exosphere',
]);

/**
 * Standard normal sample via Box-Muller. Reused by the MB velocity
 * sampler. Avoids the trig + log overhead per call by keeping a spare
 * sample around (the second output of each Box-Muller pair). The
 * spare-counter is module-scoped — every particle system shares it,
 * which is fine since they all just pull random numbers.
 */
let _gaussSpare = null;
function _gauss() {
    if (_gaussSpare !== null) {
        const s = _gaussSpare; _gaussSpare = null; return s;
    }
    let u1, u2;
    do { u1 = Math.random(); } while (u1 === 0);   // log(0) guard
    u2 = Math.random();
    const mag = Math.sqrt(-2 * Math.log(u1));
    const ang = 2 * Math.PI * u2;
    _gaussSpare = mag * Math.sin(ang);
    return mag * Math.cos(ang);
}


export class LayerParticleSystem {
    /**
     * @param {object}   opts
     * @param {THREE.Scene|THREE.Object3D} opts.parent   where to mount
     * @param {object}   opts.layer    one entry from ATMOSPHERIC_LAYER_SCHEMA
     * @param {number}   [opts.maxRunitR=2.0]  outer-radius soft clip in R⊕
     * @param {THREE.Vector3} [opts.sunDir]    unit vector toward the sun
     *        (world frame). Used by the thermospheric-wind drift to push
     *        particles away from the sub-solar point along the local
     *        tangent plane. Defaults to +X if unset; setSunDir() can
     *        update it later (e.g. when sunDir tilts with season).
     */
    constructor({ parent, layer, maxRunitR = 2.0, sunDir }) {
        this.layer = layer;
        this._parent = parent;
        this._maxRunitR = maxRunitR;

        // Sun direction (unit vector, world frame). Stored as a {x,y,z}
        // triple so the per-particle wind step doesn't pay for vector
        // method dispatch in the hot loop.
        this._sun = { x: 1, y: 0, z: 0 };
        if (sunDir) this.setSunDir(sunDir);

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
        // Per-axis Maxwell-Boltzmann standard deviation in vis units.
        // Cached in setPhysics() — every spawn + decorrelation reuses it
        // instead of recomputing the same vth-based product.
        this._mbAxisStd = 0;
        // Thermospheric wind drift speed in R⊕/s — applied per-frame
        // along the local tangent direction away from the sun.
        this._windRunitPerS = 0;
        // Direction-decorrelation accumulator (s remaining).
        this._decorrAcc = new Float32Array(cap);
    }

    /**
     * Update the cached sun direction. Cheap; the per-particle wind
     * step reads this every frame.
     */
    setSunDir(sunDir) {
        const v = (sunDir && typeof sunDir.x === 'number')
            ? new THREE.Vector3(sunDir.x, sunDir.y, sunDir.z)
            : new THREE.Vector3(1, 0, 0);
        v.normalize();
        this._sun.x = v.x; this._sun.y = v.y; this._sun.z = v.z;
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

        // Cache a per-layer step magnitude in R⊕. Note: stepMag is the
        // *mean* MB speed (matches vth_m_s); per-axis Gaussian σ is
        // smaller by √(π/8) so the resulting |v| follows the MB speed
        // distribution and the visualisation stays SI-consistent.
        const stepMag = Math.min(MAX_STEP_RUNIT,
            phys.vth_m_s * VTH_VIS_FACTOR);
        this._stepMag   = stepMag;
        this._mbAxisStd = stepMag * MB_PER_AXIS_STD;

        // Direction-decorrelation rate from regime.
        this._decorrHz = REGIME_DECORRELATION_HZ[phys.regime] ?? 1;

        // ── Thermospheric wind ────────────────────────────────────────
        // Wind speed (m/s) scales with EUV heating (F10.7) plus a storm
        // boost from Joule + ion-drag forcing during geomagnetic storms.
        // Only thermospheric+ layers feel it — mesosphere is pinned to
        // 0 (its dynamics are tides/GW, not modelled in this view).
        if (WIND_LAYERS.has(this.layer.id)) {
            const f107 = state?.f107 ?? 150;
            const f107Norm = Math.max(0, Math.min(1, (f107 - 65) / (300 - 65)));
            const windMS = WIND_BASE_M_PER_S
                + WIND_F107_GAIN_M_S * f107Norm
                + WIND_STORM_GAIN_M_S * stormFactor;
            this._windRunitPerS = windMS * WIND_VIS_FACTOR;
        } else {
            this._windRunitPerS = 0;
        }
    }

    /**
     * Per-frame integration. dtSec capped to 1/15s so a tab-switch pause
     * doesn't fling every particle out of its layer on resume.
     */
    update(dtSec) {
        if (!this._phys || this._n === 0) return;
        const dt = Math.min(0.0667, Math.max(0.001, dtSec));
        const sigma   = this._mbAxisStd;
        const drift   = this._driftRunitPerS;
        const decorrHz = this._decorrHz;
        const wind    = this._windRunitPerS;     // R⊕/s, 0 if not a wind layer
        const sx = this._sun.x, sy = this._sun.y, sz = this._sun.z;
        const innerR  = 1 + this.layer.minKm / R_EARTH_KM;
        const outerR  = Math.min(this._maxRunitR,
            1 + this.layer.maxKm / R_EARTH_KM);

        const pos = this._positions;
        const vel = this._velocities;
        const dec = this._decorrAcc;

        for (let i = 0; i < this._n; i++) {
            const j = i * 3;

            // Direction decorrelation: probability per frame = decorrHz·dt.
            // On a "collision" we re-sample the full MB velocity — three
            // independent Gaussians per axis — instead of a fixed-magnitude
            // isotropic direction. This makes the velocity ensemble track
            // the proper Maxwell-Boltzmann distribution: most particles
            // hover near vth, a few drift slowly, a few fly fast in the tail.
            dec[i] += dt;
            if (dec[i] > 1 / decorrHz || Math.random() < decorrHz * dt) {
                this._mbVelocity(j, sigma);
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

            // Integrate thermal velocity.
            pos[j]   += vel[j]   * dt * 60;   // frame-time normalisation
            pos[j+1] += vel[j+1] * dt * 60;
            pos[j+2] += vel[j+2] * dt * 60;

            // Thermospheric neutral wind: subsolar→antisolar tangent
            // flow. We project the sun direction onto the local tangent
            // plane (sun − radial(sun·radial)) and apply −1× that as a
            // bulk advection term. The unnormalised tangent length is
            // sin(SZA), giving a natural "zero at sub-solar / peak at
            // terminator / zero at anti-solar" magnitude envelope. This
            // is wholly separate from the per-particle thermal velocity
            // — wind is coherent advection of the gas as a whole, not
            // randomised per-collision.
            if (wind > 0) {
                const r = Math.hypot(pos[j], pos[j+1], pos[j+2]) || 1;
                const rx = pos[j] / r, ry = pos[j+1] / r, rz = pos[j+2] / r;
                const sdotr = sx*rx + sy*ry + sz*rz;
                const tx = sx - rx * sdotr;
                const ty = sy - ry * sdotr;
                const tz = sz - rz * sdotr;
                const adv = wind * dt;       // R⊕ this frame, magnitude pre-modulated by |t| ∝ sin(SZA)
                pos[j]   -= tx * adv;
                pos[j+1] -= ty * adv;
                pos[j+2] -= tz * adv;
            }

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
        // Uniform random POSITION on sphere shell × random radius inside
        // the layer band. Position sampling stays uniform — only the
        // velocity distribution should be Maxwell-Boltzmann.
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

        // Maxwell-Boltzmann velocity. Per-axis σ is √(kT/m) =
        // (mean speed) × √(π/8), already cached on _mbAxisStd by
        // setPhysics(). Spawn-from-stale-state guard: if setPhysics
        // hasn't run yet (very early in boot), fall back to the
        // pre-MB-cache scalar derivation.
        const sigma = this._mbAxisStd > 0
            ? this._mbAxisStd
            : Math.min(MAX_STEP_RUNIT, phys.vth_m_s * VTH_VIS_FACTOR) * MB_PER_AXIS_STD;
        this._mbVelocity(j, sigma);
        this._decorrAcc[i] = Math.random() * 0.5;
    }

    /**
     * Sample a Maxwell-Boltzmann velocity into _velocities[j..j+2].
     * Each axis is independently Gaussian with std σ; the resulting
     * |v| follows the MB speed distribution f(v) ∝ v² exp(-v²/2σ²).
     * Mean speed is √(8/π)·σ — i.e., σ × 1.596 — which matches the
     * vth_m_s expected by the rest of the visualisation.
     */
    _mbVelocity(j, sigma) {
        this._velocities[j]     = sigma * _gauss();
        this._velocities[j + 1] = sigma * _gauss();
        this._velocities[j + 2] = sigma * _gauss();
    }

    /**
     * Legacy entry point — preserved so any future caller that wants a
     * specific scalar speed (e.g. for a deterministic test) still has
     * a way in. The decorrelation path now uses _mbVelocity directly.
     */
    _randomVelocity(j, stepMag) {
        this._mbVelocity(j, stepMag * MB_PER_AXIS_STD);
    }
}
