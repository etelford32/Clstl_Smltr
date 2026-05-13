/**
 * starlink-model.js — Instanced 3D Starlink satellites for the Operations
 * globe.
 *
 * Phase 1 of replacing the generic per-satellite point with an actual
 * model. Starlink first because it dominates the catalog (~6.5 k of
 * ~30 k tracked LEO objects) and is the most visually identifiable
 * spacecraft on orbit — single deployed solar array, flat-pack bus, the
 * iconic "train" silhouette.
 *
 * Architecture:
 *   - `buildStarlinkGeometry()` returns a single merged BufferGeometry
 *     (bus + solar array + phased-array patch) with vertex colours, so
 *     the whole satellite renders in one draw call per instance.
 *   - `StarlinkFleet` owns a single `THREE.InstancedMesh` sized to
 *     `maxInstances`. Each frame, after the tracker has propagated
 *     positions, it walks the tracker's satellite list, picks out the
 *     Starlink rows, and writes a 4×4 transform per instance:
 *       - position: scene-space ECEF from the tracker's position buffer
 *       - orientation: nadir-pointing body (-Z model axis toward Earth
 *         centre), velocity-aligned long axis (+Y model along-track)
 *   - Velocity is recovered by finite-differencing the position buffer
 *     between frames. Cheaper than re-propagating from TLE and stays in
 *     sync with the live tracker regardless of scrub speed.
 *
 * Why InstancedMesh and not per-object Mesh: 6.5 k Mesh objects = 6.5 k
 * draw calls + 6.5 k matrix uploads on a controls move. One
 * InstancedMesh = one draw call + one matrix buffer upload per frame
 * for the visible subset.
 *
 * Why exaggerated scale: a real Starlink (~3 m bus, ~8 m array span) on
 * a unit-Earth scene (Earth radius = 1.0 = 6378 km) is ~1.3 × 10⁻⁶ scene
 * units — sub-pixel at every reasonable zoom. We blow the model up to
 * ~0.013 scene units (~83 km) so the geometry actually communicates.
 * This is the same convention as every other "see the constellation"
 * visualiser; nothing in the scene is to scale except the planet.
 */

import * as THREE from 'three';

const STARLINK_GROUP = 'starlink';

// Default scale of the rendered model in scene units. The merged geometry
// below spans ~2.2 model units wide (bus + array), so the on-screen
// satellite ends up ~2.2 × MODEL_SCALE_SCENE wide.
const MODEL_SCALE_SCENE = 0.006;

// Hard cap on the number of Starlinks we'll draw as full meshes. Anything
// past this stays as a point. Current Starlink catalog is ~6.5 k; the
// generation-2 plan is ~12 k. Sized to fit foreseeable growth while
// keeping the instance buffer modest (8000 × 64 bytes = 512 KB).
const MAX_INSTANCES = 8000;

// Vertex colour palette. Picked to read against both the Earth daylight
// terminator and the black-sky night side under the existing sun
// + ambient lighting in `operations/globe.js`.
const COL_BUS_WHITE     = [0.84, 0.86, 0.90];  // bus body — matte white
const COL_BUS_BOTTOM    = [0.55, 0.50, 0.42];  // -Z face hint of the phased-array antennas
const COL_ARRAY_FRONT   = [0.10, 0.13, 0.28];  // solar-cell side — deep navy
const COL_ARRAY_BACK    = [0.32, 0.28, 0.20];  // panel rear — warm grey
const COL_ARRAY_EDGE    = [0.20, 0.20, 0.22];  // panel edges

/**
 * Build one merged BufferGeometry containing the Starlink bus + solar
 * array + a bottom-face accent for the phased-array antennas. All in
 * one geometry so the InstancedMesh is a single draw call.
 *
 * Model frame:
 *   +X = solar-array deployment direction
 *   +Y = along-track (velocity) direction
 *   -Z = nadir (Earth-pointing)
 */
export function buildStarlinkGeometry() {
    const positions = [];
    const normals   = [];
    const colors    = [];
    const indices   = [];

    // pushBox(cx,cy,cz,sx,sy,sz, faceColors) where faceColors is a 6-tuple
    // for [+X, -X, +Y, -Y, +Z, -Z]. Each colour is a 3-tuple.
    function pushBox(cx, cy, cz, sx, sy, sz, faceColors) {
        const hx = sx / 2, hy = sy / 2, hz = sz / 2;
        // 8 corners
        const c = [
            [cx - hx, cy - hy, cz - hz], // 0 ---
            [cx + hx, cy - hy, cz - hz], // 1 +--
            [cx + hx, cy + hy, cz - hz], // 2 ++-
            [cx - hx, cy + hy, cz - hz], // 3 -+-
            [cx - hx, cy - hy, cz + hz], // 4 --+
            [cx + hx, cy - hy, cz + hz], // 5 +-+
            [cx + hx, cy + hy, cz + hz], // 6 +++
            [cx - hx, cy + hy, cz + hz], // 7 -++
        ];
        // Faces: 6 quads, each gets 4 fresh vertices so per-face normals
        // and colours stay flat (no smoothing across edges).
        const faces = [
            { corners: [1, 2, 6, 5], normal: [ 1,  0,  0], color: faceColors[0] }, // +X
            { corners: [3, 0, 4, 7], normal: [-1,  0,  0], color: faceColors[1] }, // -X
            { corners: [2, 3, 7, 6], normal: [ 0,  1,  0], color: faceColors[2] }, // +Y
            { corners: [0, 1, 5, 4], normal: [ 0, -1,  0], color: faceColors[3] }, // -Y
            { corners: [4, 5, 6, 7], normal: [ 0,  0,  1], color: faceColors[4] }, // +Z
            { corners: [3, 2, 1, 0], normal: [ 0,  0, -1], color: faceColors[5] }, // -Z
        ];
        for (const f of faces) {
            const base = positions.length / 3;
            for (const ci of f.corners) {
                positions.push(c[ci][0], c[ci][1], c[ci][2]);
                normals.push(f.normal[0], f.normal[1], f.normal[2]);
                colors.push(f.color[0], f.color[1], f.color[2]);
            }
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
    }

    // ── Bus (chassis) ──────────────────────────────────────────────
    // Flat-pack rectangular bus. Aspect-ratio sketches a Starlink v1.5:
    // wider in the orbit-plane direction than along-track, thin in the
    // nadir axis. The -Z face gets a darker tint to read as the
    // phased-array antenna deck.
    pushBox(
        0, 0, 0,           // centred at origin
        0.55, 0.42, 0.10,  // sx (cross-track), sy (along-track), sz (zenith/nadir)
        [
            COL_BUS_WHITE,   // +X (toward array root) — bus side
            COL_BUS_WHITE,   // -X (away from array)
            COL_BUS_WHITE,   // +Y (leading)
            COL_BUS_WHITE,   // -Y (trailing)
            COL_BUS_WHITE,   // +Z (zenith / sky-facing)
            COL_BUS_BOTTOM,  // -Z (nadir / phased-array deck)
        ],
    );

    // ── Solar array ────────────────────────────────────────────────
    // One large panel deployed off the +X side, in the orbital plane.
    // Real Starlinks deploy a single wing that pivots to track the
    // sun; we render it in the stowed-on-station "midway" pose — flat
    // and coplanar with the bus, which reads cleanly at this scale and
    // doesn't require per-instance sun-tracking math.
    // Panel root sits just outside the bus +X face; tip extends ~1.6
    // units further. Slight Z offset so the panel doesn't z-fight the
    // bus where they meet.
    pushBox(
        0.55 / 2 + 1.6 / 2 + 0.01, 0, 0.005, // centre +X of bus
        1.6, 0.45, 0.02,                     // long, narrow, very thin
        [
            COL_ARRAY_EDGE,   // +X (outboard tip edge)
            COL_ARRAY_EDGE,   // -X (root edge meeting bus)
            COL_ARRAY_EDGE,   // +Y
            COL_ARRAY_EDGE,   // -Y
            COL_ARRAY_FRONT,  // +Z (cell side, sun-facing in this pose)
            COL_ARRAY_BACK,   // -Z (rear)
        ],
    );

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    return geo;
}

/**
 * Build the material for the Starlink mesh. Standard PBR so it picks
 * up the same sun direction the rest of the operations scene uses, but
 * with a low roughness on the array hint to suggest the glassy solar
 * cells.
 */
export function buildStarlinkMaterial() {
    return new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness:    0.55,
        metalness:    0.15,
        flatShading:  true,        // emphasise the panel + bus facets
    });
}

/**
 * StarlinkFleet — InstancedMesh wrapper that mirrors the tracker's
 * Starlink positions each frame and writes an oriented 4×4 transform
 * per visible instance.
 *
 * Usage from `fleet.js`:
 *   const starlink = new StarlinkFleet(globe, tracker);
 *   globe.onTick(simTimeMs => starlink.tick(simTimeMs));
 *   starlink.setVisible(true);   // when 'starlink' layer toggles on
 *
 * The class is independent of layer-load timing: it iterates whatever
 * Starlink rows the tracker has at tick time, so it works correctly
 * whether the layer was on at boot or toggled on later.
 */
export class StarlinkFleet {
    /**
     * @param {object} globe   OperationsGlobe — used for the scene and earth radius
     * @param {object} tracker SatelliteTracker instance
     * @param {object} [opts]
     * @param {number} [opts.maxInstances=8000]
     * @param {number} [opts.modelScale=MODEL_SCALE_SCENE]
     */
    constructor(globe, tracker, { maxInstances = MAX_INSTANCES, modelScale = MODEL_SCALE_SCENE } = {}) {
        this._tracker      = tracker;
        this._maxInstances = maxInstances;
        this._modelScale   = modelScale;
        this._visible      = false;

        this._geometry = buildStarlinkGeometry();
        this._material = buildStarlinkMaterial();

        this._mesh = new THREE.InstancedMesh(this._geometry, this._material, maxInstances);
        this._mesh.frustumCulled = false;   // positions are recomputed every frame; the
                                            // stale bounding sphere from construction would
                                            // mis-cull as the catalog moves.
        this._mesh.count   = 0;             // grow as the tracker reports Starlinks
        this._mesh.visible = false;
        this._mesh.name    = 'starlink-fleet';
        globe.getScene().add(this._mesh);

        // Per-instance previous scene-space position. Used to recover a
        // velocity direction by finite difference between frames so the
        // model's long axis can be aligned with along-track motion. A
        // single Float32Array keeps it cache-friendly; NaN sentinel
        // marks "no previous sample" so the first frame after load
        // falls back to a planar best-guess orientation.
        this._prevPos = new Float32Array(maxInstances * 3);
        this._prevPos.fill(NaN);

        // Scratch matrices / vectors so the per-frame hot loop never
        // allocates.
        this._m       = new THREE.Matrix4();
        this._scaleM  = new THREE.Matrix4().makeScale(this._modelScale, this._modelScale, this._modelScale);
        this._pos     = new THREE.Vector3();
        this._zenith  = new THREE.Vector3();
        this._vel     = new THREE.Vector3();
        this._along   = new THREE.Vector3();
        this._cross   = new THREE.Vector3();
        this._rotM    = new THREE.Matrix4();

        // Hidden-instance matrix: zero scale collapses unused slots so
        // they draw nothing. Pre-built once so toggling visibility off
        // is a single matrix copy per slot, not a fresh allocation.
        this._zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
    }

    /** Show or hide the entire Starlink mesh fleet. */
    setVisible(on) {
        this._visible = !!on;
        this._mesh.visible = this._visible;
        if (!this._visible) {
            // Reset finite-difference history so the first frame after
            // a re-enable doesn't see a stale "velocity" computed from
            // a long-ago position.
            this._prevPos.fill(NaN);
        }
    }

    isVisible() { return this._visible; }

    /** Underlying InstancedMesh — exposed for picking / debug. */
    getMesh() { return this._mesh; }

    /**
     * Mirror Starlink positions from the tracker into the InstancedMesh
     * and orient each instance nadir-down, velocity-forward.
     *
     * Called every frame from the globe's render loop, *after* the
     * tracker tick has updated `_positions`. No-op when the mesh is
     * hidden — saves the per-instance matrix work when no one's
     * looking.
     */
    tick() {
        if (!this._visible) return;

        const sats = this._tracker._satellites;
        const posAttr = this._tracker._positions;
        if (!sats || !posAttr) {
            this._mesh.count = 0;
            return;
        }
        const posArr = posAttr.array;
        const n = sats.length;

        let slot = 0;
        const cap = this._maxInstances;
        for (let i = 0; i < n && slot < cap; i++) {
            const sat = sats[i];
            if (sat.group !== STARLINK_GROUP) continue;

            const off = i * 3;
            const px = posArr[off];
            const py = posArr[off + 1];
            const pz = posArr[off + 2];
            // Skip slots that haven't been propagated yet (NaN from a
            // freshly loaded TLE that the WASM registry hasn't seen).
            if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
                continue;
            }
            // Skip the Earth-centred origin too — that's the
            // last-known-position sentinel for parse-failed rows.
            if (px === 0 && py === 0 && pz === 0) continue;

            this._writeInstance(slot, px, py, pz);
            slot++;
        }

        // Collapse any tail slots that used to be active but aren't
        // this frame (e.g. a sat decayed, or the catalog shrunk). One
        // zero-scale matrix renders nothing.
        for (let k = slot; k < this._mesh.count; k++) {
            this._mesh.setMatrixAt(k, this._zeroM);
        }

        this._mesh.count = slot;
        this._mesh.instanceMatrix.needsUpdate = true;
    }

    /**
     * Write the instance matrix for one Starlink at scene-space (px,py,pz),
     * using a velocity estimate recovered from the previous frame's
     * position. Tight loop — keep allocations zero.
     */
    _writeInstance(slot, px, py, pz) {
        // Zenith direction (away from Earth centre). Earth is at the
        // origin in the operations scene, so this is just the position
        // vector normalised.
        this._zenith.set(px, py, pz);
        const r = this._zenith.length();
        if (r < 1e-9) {
            this._mesh.setMatrixAt(slot, this._zeroM);
            return;
        }
        this._zenith.multiplyScalar(1 / r);

        // Velocity direction by finite difference. First frame after
        // load uses an orbit-plane fallback so the model isn't
        // axis-locked to world-Y until a second sample lands.
        const off = slot * 3;
        const prevX = this._prevPos[off];
        let alongOk = false;
        if (Number.isFinite(prevX)) {
            const dx = px - prevX;
            const dy = py - this._prevPos[off + 1];
            const dz = pz - this._prevPos[off + 2];
            const vlen = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (vlen > 1e-9) {
                this._vel.set(dx / vlen, dy / vlen, dz / vlen);
                alongOk = true;
            }
        }
        if (!alongOk) {
            // Best-guess: cross zenith with world-Y, which gives a
            // direction in the local horizon plane. Wrong half the time
            // but stable, and gets replaced on the next tick.
            this._vel.set(0, 1, 0);
            const dot = this._vel.dot(this._zenith);
            this._vel.x -= dot * this._zenith.x;
            this._vel.y -= dot * this._zenith.y;
            this._vel.z -= dot * this._zenith.z;
            const m = this._vel.length();
            if (m < 1e-6) this._vel.set(1, 0, 0);
            else          this._vel.multiplyScalar(1 / m);
        } else {
            // Project velocity perpendicular to zenith so the along
            // axis stays in the local horizon plane even when the
            // orbit isn't perfectly circular.
            const dot = this._vel.dot(this._zenith);
            this._vel.x -= dot * this._zenith.x;
            this._vel.y -= dot * this._zenith.y;
            this._vel.z -= dot * this._zenith.z;
            const m = this._vel.length();
            if (m < 1e-9) this._vel.set(1, 0, 0);
            else          this._vel.multiplyScalar(1 / m);
        }
        this._along.copy(this._vel);

        // Cross-track (array deployment) direction completes the
        // right-handed frame.
        this._cross.crossVectors(this._along, this._zenith).normalize();

        // Compose rotation: columns are world directions of local +X,
        // +Y, +Z.
        //   local +X = cross-track (array deployment)
        //   local +Y = along-track (velocity)
        //   local +Z = zenith (so -Z faces Earth — the nadir antenna deck)
        this._rotM.makeBasis(this._cross, this._along, this._zenith);

        // Final transform: T · R · S. Multiplying rotation by the
        // pre-built scale matrix and then setting position is faster
        // than building from Quaternion + Vector3 + Vector3.
        this._m.multiplyMatrices(this._rotM, this._scaleM);
        this._m.elements[12] = px;
        this._m.elements[13] = py;
        this._m.elements[14] = pz;
        this._mesh.setMatrixAt(slot, this._m);

        // Stash for the next finite-difference sample.
        this._prevPos[off]     = px;
        this._prevPos[off + 1] = py;
        this._prevPos[off + 2] = pz;
    }

    dispose() {
        if (this._mesh.parent) this._mesh.parent.remove(this._mesh);
        this._geometry.dispose();
        this._material.dispose();
    }
}
