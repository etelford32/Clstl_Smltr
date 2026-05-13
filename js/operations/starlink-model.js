/**
 * starlink-model.js — Instanced 3D Starlink satellites for the
 * Operations globe.
 *
 * Phase 1 of replacing the generic per-satellite point with an actual
 * model. Starlink first because it dominates the catalog (~6.5 k of
 * ~30 k tracked LEO objects) and is the most visually identifiable
 * spacecraft on orbit — single deployed solar array, flat-pack bus,
 * the iconic "train" silhouette.
 *
 * Visual fidelity passes:
 *   - phase 1: oriented bus + coplanar panel (LVLH, finite-diff
 *     velocity)
 *   - phase 5 (this file): solar-array drive assembly (SADA) tracks
 *     the Sun. The panel rotates around its deployment axis to keep
 *     its normal pointed at the Sun as the satellite sweeps the
 *     terminator. In Earth shadow the panel feathers (coplanar with
 *     bus, edge-on to velocity) — same drag-minimisation pose real
 *     Starlinks use when they don't need power.
 *
 * Architecture:
 *   - `buildStarlinkBusGeometry()` returns the bus (chassis only).
 *   - `buildStarlinkPanelGeometry()` returns the panel with its
 *     pivot at the model origin, so a single rotation around local
 *     +X spins it around its SADA hinge.
 *   - `StarlinkFleet` owns *two* InstancedMesh objects sharing
 *     `count`. Each frame, after the tracker has propagated, the
 *     fleet walks the Starlink rows and writes:
 *       - bus matrix   = T(pos) · R_lvlh · S
 *       - panel matrix = T(pos) · R_lvlh · S · T_hinge · R_sada
 *   - One Sun-direction read per tick, reused across all instances.
 *
 * Why two InstancedMesh objects instead of a custom shader: two
 * draw calls + two matrix uploads is still trivial for the 6–8 k
 * range, and the bus/panel decomposition stays as plain THREE
 * geometry — no GLSL, no `onBeforeRender` hooks, no shader-chunk
 * patching. The shader path is reserved for when we want per-vertex
 * sun-glint or eclipse-shadow effects.
 */

import * as THREE from 'three';

const STARLINK_GROUP = 'starlink';

// Default scale of the rendered model in scene units.
const MODEL_SCALE_SCENE = 0.006;

// Hard cap on the number of Starlinks we'll draw as full meshes.
const MAX_INSTANCES = 8000;

// Bus dimensions (model units). Cross-track wider than along-track,
// thin in zenith — a flat-pack v1.5-ish chassis.
const BUS_SX = 0.55, BUS_SY = 0.42, BUS_SZ = 0.10;

// Solar-array dimensions and hinge geometry.
//   Panel root sits just outside the bus +X face. The SADA hinge is
//   along the line X = BUS_SX/2 + GAP. In panel-model-space we
//   shift the panel so the hinge passes through the model origin —
//   that way a pure makeRotationX(theta) rotates around the SADA
//   without an offset.
const PANEL_GAP = 0.01;
const PANEL_LEN = 1.6;   // along +X (out from hinge)
const PANEL_W   = 0.45;  // along +Y
const PANEL_T   = 0.02;  // along +Z (thickness)
const PANEL_HINGE_X = BUS_SX / 2 + PANEL_GAP;  // in BUS model space

const COL_BUS_WHITE     = [0.84, 0.86, 0.90];
const COL_BUS_BOTTOM    = [0.55, 0.50, 0.42];
const COL_ARRAY_FRONT   = [0.10, 0.13, 0.28];  // navy — cell side (+Z face of panel)
const COL_ARRAY_BACK    = [0.32, 0.28, 0.20];
const COL_ARRAY_EDGE    = [0.20, 0.20, 0.22];

/**
 * pushBox(out, cx,cy,cz, sx,sy,sz, faceColors) where faceColors is a
 * 6-tuple of 3-vectors for [+X, -X, +Y, -Y, +Z, -Z].
 */
function pushBox(out, cx, cy, cz, sx, sy, sz, faceColors) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const c = [
        [cx - hx, cy - hy, cz - hz],
        [cx + hx, cy - hy, cz - hz],
        [cx + hx, cy + hy, cz - hz],
        [cx - hx, cy + hy, cz - hz],
        [cx - hx, cy - hy, cz + hz],
        [cx + hx, cy - hy, cz + hz],
        [cx + hx, cy + hy, cz + hz],
        [cx - hx, cy + hy, cz + hz],
    ];
    const faces = [
        { corners: [1, 2, 6, 5], normal: [ 1,  0,  0], color: faceColors[0] },
        { corners: [3, 0, 4, 7], normal: [-1,  0,  0], color: faceColors[1] },
        { corners: [2, 3, 7, 6], normal: [ 0,  1,  0], color: faceColors[2] },
        { corners: [0, 1, 5, 4], normal: [ 0, -1,  0], color: faceColors[3] },
        { corners: [4, 5, 6, 7], normal: [ 0,  0,  1], color: faceColors[4] },
        { corners: [3, 2, 1, 0], normal: [ 0,  0, -1], color: faceColors[5] },
    ];
    for (const f of faces) {
        const base = out.positions.length / 3;
        for (const ci of f.corners) {
            out.positions.push(c[ci][0], c[ci][1], c[ci][2]);
            out.normals.push(f.normal[0], f.normal[1], f.normal[2]);
            out.colors.push(f.color[0], f.color[1], f.color[2]);
        }
        out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
}

function finalizeGeometry(out) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3));
    geo.setAttribute('normal',   new THREE.Float32BufferAttribute(out.normals, 3));
    geo.setAttribute('color',    new THREE.Float32BufferAttribute(out.colors, 3));
    geo.setIndex(out.indices);
    geo.computeBoundingSphere();
    return geo;
}

/**
 * Bus-only geometry. Same model frame the rest of the operations
 * scene uses for nadir-pointing spacecraft:
 *   +X = cross-track (panel deployment direction)
 *   +Y = along-track (velocity)
 *   -Z = nadir (Earth-pointing)
 * The −Z face gets a darker tint to read as the phased-array antenna
 * deck.
 */
export function buildStarlinkBusGeometry() {
    const out = { positions: [], normals: [], colors: [], indices: [] };
    pushBox(out, 0, 0, 0, BUS_SX, BUS_SY, BUS_SZ, [
        COL_BUS_WHITE,   // +X (toward array root)
        COL_BUS_WHITE,   // -X
        COL_BUS_WHITE,   // +Y
        COL_BUS_WHITE,   // -Y
        COL_BUS_WHITE,   // +Z (zenith)
        COL_BUS_BOTTOM,  // -Z (nadir / phased-array deck)
    ]);
    return finalizeGeometry(out);
}

/**
 * Solar-array-only geometry, in PANEL-model-space.
 *
 * The panel's SADA hinge is at the panel model origin (x=0, y=0,
 * z=0). The cell-side face (+Z in panel space) starts pointing at
 * the bus's zenith when SADA angle = 0. Rotating the InstancedMesh
 * matrix by makeRotationX(θ) then rotates the panel around the hinge
 * — at θ = 0 the panel is coplanar with the bus, at θ = ±π/2 it
 * sticks out perpendicular.
 *
 * To position the panel relative to the bus at render time we
 * post-multiply by T_hinge in bus-model-space (handled in tick()),
 * not bake it into the geometry.
 */
export function buildStarlinkPanelGeometry() {
    const out = { positions: [], normals: [], colors: [], indices: [] };
    // Panel extends from x = 0 (hinge) to x = PANEL_LEN, centred in
    // Y and slightly offset in +Z so when rendered coplanar with the
    // bus there's a hairline gap rather than a z-fight at the seam.
    pushBox(out,
        PANEL_LEN / 2, 0, 0.005,
        PANEL_LEN, PANEL_W, PANEL_T,
        [
            COL_ARRAY_EDGE,   // +X (tip)
            COL_ARRAY_EDGE,   // -X (root)
            COL_ARRAY_EDGE,   // +Y
            COL_ARRAY_EDGE,   // -Y
            COL_ARRAY_FRONT,  // +Z (cell side — sun-facing at θ=0)
            COL_ARRAY_BACK,   // -Z (rear)
        ],
    );
    return finalizeGeometry(out);
}

/**
 * Combined-geometry path kept around for any external caller that
 * imported the old `buildStarlinkGeometry`. New code should use the
 * split bus + panel geometries above.
 */
export function buildStarlinkGeometry() {
    const out = { positions: [], normals: [], colors: [], indices: [] };
    pushBox(out, 0, 0, 0, BUS_SX, BUS_SY, BUS_SZ, [
        COL_BUS_WHITE, COL_BUS_WHITE, COL_BUS_WHITE,
        COL_BUS_WHITE, COL_BUS_WHITE, COL_BUS_BOTTOM,
    ]);
    pushBox(out,
        PANEL_HINGE_X + PANEL_LEN / 2, 0, 0.005,
        PANEL_LEN, PANEL_W, PANEL_T,
        [
            COL_ARRAY_EDGE, COL_ARRAY_EDGE, COL_ARRAY_EDGE,
            COL_ARRAY_EDGE, COL_ARRAY_FRONT, COL_ARRAY_BACK,
        ],
    );
    return finalizeGeometry(out);
}

export function buildStarlinkMaterial() {
    return new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness:    0.55,
        metalness:    0.15,
        flatShading:  true,
    });
}

/**
 * StarlinkFleet — InstancedMesh pair (bus + panel) that mirrors the
 * tracker's Starlink positions each frame, orients each instance
 * along the LVLH frame, and rotates the panel around its SADA so the
 * cell side tracks the Sun. In Earth shadow the panel feathers
 * (coplanar with bus, edge-on to velocity).
 */
export class StarlinkFleet {
    constructor(globe, tracker, { maxInstances = MAX_INSTANCES, modelScale = MODEL_SCALE_SCENE } = {}) {
        this._globe        = globe;
        this._tracker      = tracker;
        this._maxInstances = maxInstances;
        this._modelScale   = modelScale;
        this._visible      = false;
        // Earth radius in scene units — needed for the eclipse check.
        // Stored once so the hot loop doesn't call back into globe per
        // instance.
        this._earthR       = globe.getEarthRadius();
        this._earthR2      = this._earthR * this._earthR;

        // Single material shared between bus and panel — colours
        // come from per-vertex attributes, so the same material
        // shades both with no per-mesh overrides.
        this._material = buildStarlinkMaterial();
        this._busGeo   = buildStarlinkBusGeometry();
        this._panelGeo = buildStarlinkPanelGeometry();

        this._busMesh = new THREE.InstancedMesh(this._busGeo, this._material, maxInstances);
        this._busMesh.frustumCulled = false;
        this._busMesh.count   = 0;
        this._busMesh.visible = false;
        this._busMesh.name    = 'starlink-bus-fleet';

        this._panelMesh = new THREE.InstancedMesh(this._panelGeo, this._material, maxInstances);
        this._panelMesh.frustumCulled = false;
        this._panelMesh.count   = 0;
        this._panelMesh.visible = false;
        this._panelMesh.name    = 'starlink-panel-fleet';

        globe.getScene().add(this._busMesh);
        globe.getScene().add(this._panelMesh);

        // Per-instance previous position for velocity finite-diff.
        this._prevPos = new Float32Array(maxInstances * 3);
        this._prevPos.fill(NaN);

        // Scratch — keep allocations out of the hot loop.
        this._mBus     = new THREE.Matrix4();
        this._mPanel   = new THREE.Matrix4();
        this._scaleM   = new THREE.Matrix4().makeScale(modelScale, modelScale, modelScale);
        this._tHingeM  = new THREE.Matrix4().makeTranslation(PANEL_HINGE_X, 0, 0);
        this._sadaM    = new THREE.Matrix4();
        this._panelLM  = new THREE.Matrix4();
        this._zenith   = new THREE.Vector3();
        this._vel      = new THREE.Vector3();
        this._along    = new THREE.Vector3();
        this._cross    = new THREE.Vector3();
        this._rotM     = new THREE.Matrix4();
        this._zeroM    = new THREE.Matrix4().makeScale(0, 0, 0);
        this._sunDir   = new THREE.Vector3(1, 0, 0);
    }

    setVisible(on) {
        this._visible = !!on;
        this._busMesh.visible   = this._visible;
        this._panelMesh.visible = this._visible;
        if (!this._visible) this._prevPos.fill(NaN);
    }

    isVisible() { return this._visible; }
    getMesh()   { return this._busMesh; }   // for picking — bus is the visual anchor

    tick() {
        if (!this._visible) return;

        const sats = this._tracker._satellites;
        const posAttr = this._tracker._positions;
        if (!sats || !posAttr) {
            this._busMesh.count = this._panelMesh.count = 0;
            return;
        }
        const posArr = posAttr.array;
        const n = sats.length;

        // Snapshot the current sun direction once per tick. Every
        // instance projects this into its own LVLH frame to derive
        // its SADA angle — the projection is cheap (3 dot products)
        // so we don't precompute anything else.
        this._sunDir.copy(this._globe.getSunDirection());
        const sx = this._sunDir.x, sy = this._sunDir.y, sz = this._sunDir.z;

        let slot = 0;
        const cap = this._maxInstances;
        for (let i = 0; i < n && slot < cap; i++) {
            const sat = sats[i];
            if (sat.group !== STARLINK_GROUP) continue;

            const off = i * 3;
            const px = posArr[off];
            const py = posArr[off + 1];
            const pz = posArr[off + 2];
            if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
            if (px === 0 && py === 0 && pz === 0) continue;

            this._writeInstance(slot, px, py, pz, sx, sy, sz);
            slot++;
        }

        for (let k = slot; k < this._busMesh.count; k++) {
            this._busMesh.setMatrixAt(k, this._zeroM);
            this._panelMesh.setMatrixAt(k, this._zeroM);
        }
        this._busMesh.count   = slot;
        this._panelMesh.count = slot;
        this._busMesh.instanceMatrix.needsUpdate   = true;
        this._panelMesh.instanceMatrix.needsUpdate = true;
    }

    /**
     * Write the bus + panel matrices for one Starlink at scene-space
     * (px, py, pz). (sx, sy, sz) is the unit Sun direction shared
     * across all instances this tick.
     *
     * Compute order:
     *   1. Zenith, along-track, cross-track basis (LVLH).
     *   2. Bus matrix = T(pos) · R_lvlh · S.
     *   3. Eclipse check (is Earth between this sat and the Sun?).
     *   4. SADA angle:
     *        lit:     atan2(-localSun.y, localSun.z) — panel normal
     *                 tracks the sun-projection in the Y-Z plane
     *        shadow:  0 — panel coplanar with bus, edge-on to velocity
     *                 (same drag-minimisation pose real Starlinks use)
     *   5. Panel matrix = M_bus · T_hinge · R_sada.
     */
    _writeInstance(slot, px, py, pz, sx, sy, sz) {
        // ── 1. LVLH basis ─────────────────────────────────────────
        this._zenith.set(px, py, pz);
        const r2 = px * px + py * py + pz * pz;
        const r  = Math.sqrt(r2);
        if (r < 1e-9) {
            this._busMesh.setMatrixAt(slot, this._zeroM);
            this._panelMesh.setMatrixAt(slot, this._zeroM);
            return;
        }
        const invR = 1 / r;
        this._zenith.multiplyScalar(invR);

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
        if (!alongOk) this._vel.set(0, 1, 0);

        const vdot = this._vel.dot(this._zenith);
        this._along.set(
            this._vel.x - vdot * this._zenith.x,
            this._vel.y - vdot * this._zenith.y,
            this._vel.z - vdot * this._zenith.z,
        );
        let m = this._along.length();
        if (m < 1e-9) {
            this._along.set(1, 0, 0);
            const d2 = this._along.dot(this._zenith);
            this._along.x -= d2 * this._zenith.x;
            this._along.y -= d2 * this._zenith.y;
            this._along.z -= d2 * this._zenith.z;
            m = this._along.length();
            if (m < 1e-6) this._along.set(0, 0, 1);
            else          this._along.multiplyScalar(1 / m);
        } else {
            this._along.multiplyScalar(1 / m);
        }
        this._cross.crossVectors(this._along, this._zenith).normalize();

        //   local +X = cross-track
        //   local +Y = along-track
        //   local +Z = zenith
        this._rotM.makeBasis(this._cross, this._along, this._zenith);

        // ── 2. Bus matrix ─────────────────────────────────────────
        this._mBus.multiplyMatrices(this._rotM, this._scaleM);
        this._mBus.elements[12] = px;
        this._mBus.elements[13] = py;
        this._mBus.elements[14] = pz;
        this._busMesh.setMatrixAt(slot, this._mBus);

        // ── 3. Eclipse check ──────────────────────────────────────
        // Sat is in Earth shadow when the line from the sat in the
        // +sunDir direction passes within EARTH_R of the origin AND
        // the closest-approach point lies ahead of the sat (i.e. the
        // sat is on the anti-sun side of Earth).
        //
        //   s* = -(p · sunDir)   closest-approach parameter
        //   d² = |p|² - (p·sunDir)²
        //   eclipse iff (s* > 0) ∧ (d² < EARTH_R²)
        //               i.e. (p·sunDir < 0) ∧ (d² < EARTH_R²)
        const pDotSun = px * sx + py * sy + pz * sz;
        let eclipsed = false;
        if (pDotSun < 0) {
            const d2 = r2 - pDotSun * pDotSun;
            if (d2 < this._earthR2) eclipsed = true;
        }

        // ── 4. SADA angle ─────────────────────────────────────────
        // Project the world-space sun direction into the bus's local
        // frame:
        //   localSun.x = cross  · sunDir
        //   localSun.y = along  · sunDir
        //   localSun.z = zenith · sunDir
        // Panel rotates around local +X, so only the (y,z) components
        // matter. Maximise (panel_normal · localSun) where
        //   panel_normal(θ) = (0, -sin θ, cos θ)
        //   →  θ = atan2(-localSun.y, localSun.z)
        let theta;
        if (eclipsed) {
            theta = 0;
        } else {
            const lsy = this._along.x * sx + this._along.y * sy + this._along.z * sz;
            const lsz = this._zenith.x * sx + this._zenith.y * sy + this._zenith.z * sz;
            theta = Math.atan2(-lsy, lsz);
        }
        this._sadaM.makeRotationX(theta);

        // ── 5. Panel matrix ───────────────────────────────────────
        // M_panel = M_bus · T_hinge · R_sada
        // We don't apply the scale a second time — it's already baked
        // into M_bus, and T_hinge/R_sada operate in pre-scale model
        // space.
        this._panelLM.multiplyMatrices(this._tHingeM, this._sadaM);
        this._mPanel.multiplyMatrices(this._mBus, this._panelLM);
        this._panelMesh.setMatrixAt(slot, this._mPanel);

        this._prevPos[off]     = px;
        this._prevPos[off + 1] = py;
        this._prevPos[off + 2] = pz;
    }

    dispose() {
        if (this._busMesh.parent)   this._busMesh.parent.remove(this._busMesh);
        if (this._panelMesh.parent) this._panelMesh.parent.remove(this._panelMesh);
        this._busGeo.dispose();
        this._panelGeo.dispose();
        this._material.dispose();
    }
}
