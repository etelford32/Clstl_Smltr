/**
 * upper-atmosphere-vector-fields.js — vectorised T & radiation overlays
 * ═══════════════════════════════════════════════════════════════════════════
 * Renders an instanced cone field across each atmospheric layer, used to
 * visualise the *direction* and *magnitude* of two scalar/vector fields:
 *
 *   • 'temperature'  — arrows along ∇T (the temperature-gradient vector).
 *                      In the thermosphere dT/dz > 0 (T rises sharply with
 *                      altitude up to the exospheric ceiling), and dT/dx
 *                      points toward the sub-solar point (EUV heating
 *                      maximum). The combined gradient ≈ a radially-
 *                      outward direction tilted by an EUV term toward
 *                      the sun. Magnitude scales with the local layer
 *                      temperature relative to the layer's nominal floor.
 *
 *   • 'radiation'    — arrows representing energetic-flux flow lines
 *                      INTO the atmosphere from the sun. On the dayside
 *                      this is EUV + soft X-ray (continuous); during a
 *                      storm both polar cusps light up with energetic-
 *                      particle precipitation (Ap-driven). Magnitude
 *                      scales with F10.7 (baseline) + Ap (storm boost).
 *
 *   • 'off'          — group hidden; no per-frame work.
 *
 * One LayerVectorField per atmospheric layer. Each holds a single
 * InstancedMesh whose count == nInstances; setPhysics() recomputes
 * each instance's transform from the active mode + the latest physics.
 *
 * Rendering choice: instanced cones give us up-and-to-the-direction
 * read-ability without any custom shader work — Three.js handles the
 * matrix-per-instance dance, and InstancedBufferAttribute carries the
 * per-instance scale + colour we need.
 *
 * Performance: with ~64 instances per layer × 5 layers = 320 cones, all
 * drawn in 5 instanced draws. Per-physics-update cost is one Matrix4
 * compose + one Color set per instance — a couple hundred μs per layer.
 *
 * @example
 *     const vf = new LayerVectorField({
 *         parent:  scene,
 *         layer:   ATMOSPHERIC_LAYER_SCHEMA[0],
 *         sunDir:  new THREE.Vector3(1, 0.35, 0.2).normalize(),
 *     });
 *     vf.setMode('temperature');
 *     vf.setPhysics(phys, { f107: 150, ap: 30 });
 */

import * as THREE from 'three';

const R_EARTH_KM = 6371;

// Default sample count per layer. 64 reads as a coherent field across
// the full sphere without flickering at typical zoom levels; bumping
// to 128 looks denser but doubles the per-update cost.
const DEFAULT_INSTANCE_COUNT = 64;

// Cone geometry — short + narrow so the field reads as "vector arrows"
// rather than blocky tetrahedra. Positioned with apex along +Y so the
// instance matrix's rotation aligns it with the per-instance vector.
const CONE_HEIGHT = 0.030;   // R⊕
const CONE_RADIUS = 0.0085;  // R⊕

// Reusable scratch objects to avoid per-instance allocation churn —
// 320 instances × Matrix4/Vec3/Quat allocation per setPhysics tick was
// adding measurable GC pressure at higher refresh rates.
const _M  = new THREE.Matrix4();
const _Q  = new THREE.Quaternion();
const _U  = new THREE.Vector3(0, 1, 0);
const _V  = new THREE.Vector3();
const _S  = new THREE.Vector3();
const _PT = new THREE.Vector3();

export class LayerVectorField {
    /**
     * @param {object} opts
     * @param {THREE.Object3D}  opts.parent  group / scene to mount under
     * @param {object}          opts.layer   ATMOSPHERIC_LAYER_SCHEMA entry
     * @param {THREE.Vector3}   opts.sunDir  unit vector toward the sun (world frame)
     * @param {number}          [opts.instanceCount=DEFAULT_INSTANCE_COUNT]
     */
    constructor({ parent, layer, sunDir, instanceCount = DEFAULT_INSTANCE_COUNT }) {
        this.layer  = layer;
        this.sunDir = sunDir.clone();
        this.mode   = 'off';

        const peakKm = Number.isFinite(layer.peakKm)
            ? layer.peakKm
            : (layer.minKm + layer.maxKm) / 2;
        this._radius = 1 + peakKm / R_EARTH_KM;

        // Fibonacci sphere — ~uniform angular sampling without grid
        // artefacts. We keep the points in a typed array because we read
        // them every setPhysics() tick.
        this._samples = _fibonacciSphere(instanceCount);

        // The cone is drawn at unit height; per-instance scale carries
        // the magnitude. Standard MeshBasicMaterial with vertex colours
        // off — instance colour rides on InstancedBufferAttribute below.
        const geom = new THREE.ConeGeometry(CONE_RADIUS, CONE_HEIGHT, 8, 1, false);
        // ConeGeometry's apex is +Y; pivot point is at the *centre* of
        // the cone. Translate so the *base* sits at origin → instance
        // matrix can plant the base on the sphere and the apex points
        // outward along the rotation axis.
        geom.translate(0, CONE_HEIGHT / 2, 0);

        const mat = new THREE.MeshBasicMaterial({
            color:       0xffffff,
            transparent: true,
            opacity:     0.85,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });

        this.mesh = new THREE.InstancedMesh(geom, mat, instanceCount);
        this.mesh.frustumCulled = false;
        this.mesh.visible = false;
        this.mesh.userData = {
            kind: 'layer-vector-field',
            id:   layer.id,
            name: `${layer.name} field`,
        };
        // Per-instance colour. Three.js allocates the buffer when we set
        // the count, but only allocates the underlying typed array on
        // first setColorAt() — so we touch it here to ensure existence.
        this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
            new Float32Array(instanceCount * 3), 3,
        );

        // Initial pose — hide everything by collapsing scale to zero.
        // setPhysics() rescales to the right magnitude when called.
        for (let i = 0; i < instanceCount; i++) {
            _M.identity().scale(_S.set(0, 0, 0));
            this.mesh.setMatrixAt(i, _M);
        }
        this.mesh.instanceMatrix.needsUpdate = true;

        parent.add(this.mesh);
    }

    /** 'off' | 'temperature' | 'radiation' */
    setMode(mode) {
        this.mode = mode || 'off';
        this.mesh.visible = this.mode !== 'off';
        // If we have a cached physics push, re-apply with the new mode.
        if (this._lastPhys && this.mode !== 'off') {
            this.setPhysics(this._lastPhys, this._lastState);
        }
    }

    /**
     * Push the latest physics + state. Recomputes every instance's
     * direction + magnitude + colour. Cheap enough to call on every
     * profile/state change (~few hundred μs per layer).
     *
     * @param {object} phys   from layerPhysics()
     * @param {object} state  { f107, ap }
     */
    setPhysics(phys, state = {}) {
        this._lastPhys  = phys;
        this._lastState = { ...state };

        if (this.mode === 'off') return;

        const f107 = Number.isFinite(state.f107) ? state.f107 : 150;
        const ap   = Number.isFinite(state.ap)   ? state.ap   : 15;

        // Per-mode scalar drivers — kept local so they're easy to read.
        // Temperature: layer-relative scaling around the engine's T.
        //   Below 600 K → low gradient; above 2000 K → saturated.
        const tNorm   = _clamp((phys.T - 600) / (2000 - 600), 0, 1);
        // Radiation:  EUV proxy from F10.7, energetic-particle proxy
        //   from Ap. Quiet-time floor ~0.05 so even quiet shows a hint.
        const euvNorm = _clamp((f107 - 65) / (300 - 65), 0, 1);
        const epNorm  = _clamp((ap   - 12) / (200 - 12), 0, 1);
        const radNorm = _clamp(0.05 + 0.65 * euvNorm + 0.50 * epNorm, 0, 1.0);

        const colorLow  = this._lowColor();
        const colorHigh = this._highColor();
        const _C = new THREE.Color();

        for (let i = 0; i < this._samples.length / 3; i++) {
            const sx = this._samples[i * 3 + 0];
            const sy = this._samples[i * 3 + 1];
            const sz = this._samples[i * 3 + 2];

            // Sample point on the layer's peak-radius sphere.
            _PT.set(sx, sy, sz).multiplyScalar(this._radius);

            // Surface-normal direction from sphere centre.
            _V.set(sx, sy, sz).normalize();

            // Solar zenith term — 0 on far side, 1 at sub-solar point.
            const sun = Math.max(0, _V.dot(this.sunDir));

            // Choose direction + magnitude per mode.
            let mag = 0;
            if (this.mode === 'temperature') {
                // ∇T: dominant +radial component (dT/dz > 0) plus a
                // dayside-tilted component because EUV heating peaks
                // at the sub-solar point. Direction lerps between
                // radial and "radial blended toward sun" by a small
                // factor so the field still looks like an outward
                // vector cloud.
                const tilt = 0.35 * sun;            // 0..0.35
                _V.lerp(this.sunDir, tilt).normalize();
                // Magnitude: temperature scaling boosted on the
                // dayside (where heating occurs — there's where the
                // gradient is biggest in real life).
                mag = (0.35 + 0.65 * tNorm) * (0.55 + 0.45 * sun);
            } else if (this.mode === 'radiation') {
                // Solar EUV / energetic-particle FLUX flows inward.
                // On the dayside this is direct EUV; on the night
                // side we still show a faint baseline to convey
                // omni-directional galactic + magnetospheric input.
                _V.multiplyScalar(-1);              // point INWARD
                // Storm boost: cusps (high-latitude) get extra flow
                // when Ap is high, since particle precipitation
                // funnels in through the open field lines there.
                const cusp = Math.abs(sy);          // 0 at equator, 1 at pole
                const cuspBoost = epNorm * cusp;
                mag = (0.20 + 0.80 * radNorm) * (0.30 + 0.70 * sun + 0.40 * cuspBoost);
                mag = Math.min(mag, 1.4);
            }

            // Drop entirely-invisible instances by collapsing their
            // scale — keeps the visual clean instead of a uniform haze.
            if (mag < 0.04) {
                _M.identity().scale(_S.set(0, 0, 0));
                this.mesh.setMatrixAt(i, _M);
                continue;
            }

            // Build the instance matrix: orient the cone's local +Y
            // along _V, then translate so its base sits at the sample
            // point on the peak-radius sphere.
            _Q.setFromUnitVectors(_U, _V);
            _S.set(mag, mag, mag);
            _M.compose(_PT, _Q, _S);
            this.mesh.setMatrixAt(i, _M);

            // Colour: lerp between mode-low and mode-high by magnitude,
            // with a slight dayside warming so the cusps stand out.
            _C.copy(colorLow).lerp(colorHigh, mag);
            this.mesh.setColorAt(i, _C);
        }

        this.mesh.instanceMatrix.needsUpdate = true;
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }

    /** Update the sun direction (used for direction calc on next push). */
    setSunDir(sunDir) {
        this.sunDir.copy(sunDir);
    }

    dispose() {
        this.mesh.geometry?.dispose();
        this.mesh.material?.dispose();
        this.mesh.parent?.remove(this.mesh);
    }

    // ── Per-mode colour pair ────────────────────────────────────────
    _lowColor()  {
        if (this.mode === 'temperature') return new THREE.Color(0x4080ff);
        if (this.mode === 'radiation')   return new THREE.Color(0x40e0d0);
        return new THREE.Color(0x444444);
    }
    _highColor() {
        if (this.mode === 'temperature') return new THREE.Color(0xffaa20);
        if (this.mode === 'radiation')   return new THREE.Color(0xff4dff);
        return new THREE.Color(0xffffff);
    }
}

// ── helpers ─────────────────────────────────────────────────────────

function _clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Fibonacci sphere — packs `n` points roughly evenly across the unit
 * sphere with no grid artefacts. Returned as a flat Float32Array of
 * (x, y, z) triples so the caller can read it without per-iteration
 * object allocation.
 */
function _fibonacciSphere(n) {
    const out = new Float32Array(n * 3);
    const phi = Math.PI * (3 - Math.sqrt(5));    // golden angle
    for (let i = 0; i < n; i++) {
        // Map i to [-1, 1] along Y, then derive (x, z) from the radius
        // of the latitude circle at that Y.
        const y    = 1 - (i / (n - 1)) * 2;
        const r    = Math.sqrt(Math.max(0, 1 - y * y));
        const lon  = i * phi;
        out[i * 3 + 0] = r * Math.cos(lon);
        out[i * 3 + 1] = y;
        out[i * 3 + 2] = r * Math.sin(lon);
    }
    return out;
}
