/**
 * hero-mesh.js — Single-instance mesh manager for LVLH-stable hero
 * objects (ISS, Hubble, Tiangong, …).
 *
 * Generalises the position + orientation pipeline that
 * `envisat-model.js` runs for a single satellite. Each instance:
 *   - watches a specific NORAD via tracker.getPositionXYZ
 *   - hides itself when the body isn't in the catalog (layer off,
 *     TLE not loaded yet) so a fresh mount doesn't flash at origin
 *   - orients in LVLH: -Z = nadir, +Y = along-track, +X = cross-track
 *   - optionally applies a constant rotation rate around local +Z
 *     (zenith) — useful for the Envisat tumble pattern, off for the
 *     other heroes (which are actively attitude-controlled)
 *
 * Geometry + material are passed in, so this file stays
 * spacecraft-agnostic. Per-spacecraft modules (iss-model.js etc.)
 * build the geometry and call the factory below.
 *
 * Envisat keeps its own dedicated module for now — it was built
 * before this base existed and its docstring is intertwined with the
 * tumble math. Future passes can migrate it onto HeroMesh.
 */

import * as THREE from 'three';

export class HeroMesh {
    /**
     * @param {object} globe   OperationsGlobe — used for the scene
     * @param {object} tracker SatelliteTracker
     * @param {object} opts
     * @param {number} opts.norad
     * @param {THREE.BufferGeometry} opts.geometry
     * @param {THREE.Material}       opts.material
     * @param {number} [opts.modelScale=0.010]
     * @param {number} [opts.tumbleRateRadPerSec=0]
     * @param {number} [opts.tumbleEpochMs=0] — phase reference for tumble
     * @param {string} [opts.name='hero-mesh']
     */
    constructor(globe, tracker, opts = {}) {
        const {
            norad,
            geometry,
            material,
            modelScale          = 0.010,
            tumbleRateRadPerSec = 0,
            tumbleEpochMs       = 0,
            name                = 'hero-mesh',
        } = opts;
        if (!Number.isFinite(norad)) throw new Error('HeroMesh: norad required');
        if (!geometry) throw new Error('HeroMesh: geometry required');
        if (!material) throw new Error('HeroMesh: material required');

        this._tracker        = tracker;
        this._norad          = norad;
        this._modelScale     = modelScale;
        this._tumbleRate     = tumbleRateRadPerSec;
        this._tumbleEpochMs  = tumbleEpochMs;
        this._visible        = false;

        this._geometry = geometry;
        this._material = material;
        this._mesh = new THREE.Mesh(geometry, material);
        this._mesh.frustumCulled    = false;
        this._mesh.visible          = false;
        this._mesh.matrixAutoUpdate = false;
        this._mesh.name             = name;
        globe.getScene().add(this._mesh);

        // Finite-diff state for along-track recovery.
        this._prevX = NaN;
        this._prevY = NaN;
        this._prevZ = NaN;

        // Scratch — keep allocations out of tick().
        this._pos     = new THREE.Vector3();
        this._zenith  = new THREE.Vector3();
        this._along   = new THREE.Vector3();
        this._cross   = new THREE.Vector3();
        this._rotM    = new THREE.Matrix4();
        this._tumbleM = new THREE.Matrix4();
        this._scaleM  = new THREE.Matrix4().makeScale(modelScale, modelScale, modelScale);
        this._m       = new THREE.Matrix4();
    }

    setVisible(on) {
        this._visible = !!on;
        this._mesh.visible = this._visible;
        if (!this._visible) {
            this._prevX = this._prevY = this._prevZ = NaN;
        }
    }
    isVisible() { return this._visible; }
    getMesh()   { return this._mesh; }
    getNorad()  { return this._norad; }

    tick(simTimeMs) {
        if (!this._visible) return;

        const pos = this._tracker.getPositionXYZ?.(this._norad, this._pos);
        if (!pos
            || !Number.isFinite(pos.x)
            || !Number.isFinite(pos.y)
            || !Number.isFinite(pos.z)
            || (pos.x === 0 && pos.y === 0 && pos.z === 0)) {
            // Body absent or unpropagated — hide rather than flash
            // at the origin. The wrapping layer can re-show next
            // tick once propagation lands.
            this._mesh.visible = false;
            return;
        }
        this._mesh.visible = true;
        const px = pos.x, py = pos.y, pz = pos.z;

        // Zenith (radial outward).
        this._zenith.set(px, py, pz);
        const r = this._zenith.length();
        if (r < 1e-9) return;
        this._zenith.multiplyScalar(1 / r);

        // Along-track from finite difference between frames.
        let alongOk = false;
        if (Number.isFinite(this._prevX)) {
            const dx = px - this._prevX;
            const dy = py - this._prevY;
            const dz = pz - this._prevZ;
            const vlen = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (vlen > 1e-9) {
                const inv = 1 / vlen;
                const vx = dx * inv, vy = dy * inv, vz = dz * inv;
                const d = vx * this._zenith.x + vy * this._zenith.y + vz * this._zenith.z;
                this._along.set(
                    vx - d * this._zenith.x,
                    vy - d * this._zenith.y,
                    vz - d * this._zenith.z,
                );
                if (this._along.lengthSq() > 1e-12) {
                    this._along.normalize();
                    alongOk = true;
                }
            }
        }
        if (!alongOk) {
            // First-frame fallback: pick a stable horizon-plane axis
            // so the mesh isn't pinned to world-Y until the next
            // sample lands.
            this._along.set(0, 1, 0);
            const d = this._along.dot(this._zenith);
            this._along.x -= d * this._zenith.x;
            this._along.y -= d * this._zenith.y;
            this._along.z -= d * this._zenith.z;
            const m = this._along.length();
            if (m < 1e-6) this._along.set(1, 0, 0);
            else          this._along.multiplyScalar(1 / m);
        }
        this._cross.crossVectors(this._along, this._zenith).normalize();

        // LVLH basis. Columns are world directions of local +X / +Y / +Z.
        //   local +X = cross-track
        //   local +Y = along-track
        //   local +Z = zenith  (→ −Z faces nadir = Earth)
        this._rotM.makeBasis(this._cross, this._along, this._zenith);

        if (this._tumbleRate !== 0) {
            // Pure function of simTimeMs so scrubbing winds the
            // tumble forward / back deterministically. Z-rotation
            // matches Envisat's observed principal-axis spin.
            const angle = ((simTimeMs - this._tumbleEpochMs) / 1000) * this._tumbleRate;
            this._tumbleM.makeRotationZ(angle);
            this._m.multiplyMatrices(this._rotM, this._tumbleM);
            this._m.multiply(this._scaleM);
        } else {
            this._m.multiplyMatrices(this._rotM, this._scaleM);
        }
        this._m.elements[12] = px;
        this._m.elements[13] = py;
        this._m.elements[14] = pz;

        this._mesh.matrix.copy(this._m);
        this._mesh.matrixWorldNeedsUpdate = true;

        this._prevX = px;
        this._prevY = py;
        this._prevZ = pz;
    }

    dispose() {
        if (this._mesh.parent) this._mesh.parent.remove(this._mesh);
        this._geometry.dispose();
        this._material.dispose();
    }
}

/** Shared standard material — flat shading + vertex colours, low metalness. */
export function buildHeroMaterial({ roughness = 0.55, metalness = 0.10 } = {}) {
    return new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness,
        metalness,
        flatShading:  true,
    });
}
