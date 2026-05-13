/**
 * rocket-body-model.js — Instanced 3D rocket-body debris for the
 * Operations globe. Phase 2 of the "real models in place of dots"
 * pipeline.
 *
 * First target: the SL-16 / Zenit-2 second stage. McKnight et al.'s
 * statistically-most-concerning ranking puts the SL-16 R/B cluster at
 * the top of the LEO debris-risk list: ~9 t each, ~11 m long, ~18 of
 * them stacked between 800–900 km. Visually identifiable as a long
 * cylinder + a single RD-120 nozzle bell + a short interstage ring.
 *
 * Geometry pipeline mirrors `starlink-model.js`:
 *   - one merged BufferGeometry with vertex colours
 *   - one InstancedMesh sized for the catalog (256 slots; ~18 SL-16
 *     R/Bs in service today, room to grow)
 *   - per-instance matrix written each frame from the tracker's
 *     scene-space positions
 *
 * Orientation: long axis aligned with the local zenith. This is the
 * gravity-gradient-stable pose a long thin body tends toward over
 * years on orbit — the cylinder ends up pointing roughly radially.
 * (Some tumble; rendering them spinning is a future polish item.)
 * The nozzle is on the −Y model end and faces Earth in this pose,
 * which reads cleanly as a "rocket body silhouette" at a glance.
 *
 * Why a hand-rolled merged geometry instead of CylinderGeometry +
 * BufferGeometryUtils.mergeGeometries: keeps the module dependency
 * surface to plain `three` (no addons/utils import) and lets the
 * vertex-colour scheme be face-aware (engine bell shaded darker than
 * the body cylinder, end caps darker still).
 */

import * as THREE from 'three';

// CelesTrak group id the proxy uses for the NAME=SL-16 lookup. Must
// match the key registered in `api/celestrak/tle.js`.
const SL16_GROUP = 'sl-16-rb';

// Same exaggeration factor the Starlink renderer uses, so a Starlink
// and an SL-16 R/B read at roughly the same visual size when both
// layers are on. The real ratio (Starlink bus ~3 m vs SL-16 ~11 m)
// gets compressed; that's fine — the scene is already 500 000× off
// scale, the comparison is qualitative.
const MODEL_SCALE_SCENE = 0.006;

// 256 instance slots. There are ~18 SL-16 R/Bs in service plus ~70
// Zenit-related upper stages historically; sized to cover the broader
// family even if the NAME filter widens later.
const MAX_INSTANCES = 256;

// Vertex colours. Picked for the same lighting set-up Starlink uses
// (single sun directional + ambient floor) so the two layers read as
// the same scene, not two re-tinted layers.
const COL_BODY_CYL    = [0.78, 0.74, 0.66];  // sun-bleached white/cream tankage
const COL_BODY_END    = [0.55, 0.50, 0.44];  // forward dome / shadow side
const COL_INTERSTAGE  = [0.46, 0.42, 0.36];  // skirt / interstage adapter
const COL_NOZZLE_OUT  = [0.32, 0.27, 0.22];  // engine bell exterior
const COL_NOZZLE_IN   = [0.18, 0.14, 0.10];  // engine bell interior (almost black)

/**
 * Append a cylinder section (no caps) to vertex/normal/colour/index
 * arrays. radiusBottom/Top, length along local Y, centred at (0,yCenter,0).
 * Side-only — caps are added separately when wanted.
 */
function pushCylinderSide(out, radiusBottom, radiusTop, height, yCenter, segments, color) {
    const halfH = height / 2;
    const yBot  = yCenter - halfH;
    const yTop  = yCenter + halfH;
    const dr    = radiusTop - radiusBottom;
    // Slant for the normal — for a frustum the normal isn't pure-radial,
    // it tilts toward the smaller end. (height, dr) defines the slant
    // triangle; the radial component is `height`, the axial is `-dr`.
    const slant = Math.hypot(height, dr);
    const nRadial = slant > 0 ? height / slant : 1;
    const nAxial  = slant > 0 ? -dr    / slant : 0;

    for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        const cos0 = Math.cos(a0), sin0 = Math.sin(a0);
        const cos1 = Math.cos(a1), sin1 = Math.sin(a1);
        // 4 fresh vertices per face for flat per-segment shading
        const base = out.positions.length / 3;
        // bottom-left, bottom-right, top-right, top-left
        out.positions.push(
            cos0 * radiusBottom, yBot, sin0 * radiusBottom,
            cos1 * radiusBottom, yBot, sin1 * radiusBottom,
            cos1 * radiusTop,    yTop, sin1 * radiusTop,
            cos0 * radiusTop,    yTop, sin0 * radiusTop,
        );
        // Average normal at the midpoint of the face — close enough
        // for flat shading on a 24-segment cylinder.
        const mid = (a0 + a1) / 2;
        const nx = Math.cos(mid) * nRadial;
        const nz = Math.sin(mid) * nRadial;
        const ny = nAxial;
        for (let k = 0; k < 4; k++) {
            out.normals.push(nx, ny, nz);
            out.colors.push(color[0], color[1], color[2]);
        }
        out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
}

/**
 * Append a flat disc cap (single-sided) at y=yPos with the given
 * radius, normal facing +Y if `up` is true else −Y.
 */
function pushCap(out, radius, yPos, segments, up, color) {
    const ny = up ? 1 : -1;
    const center = out.positions.length / 3;
    out.positions.push(0, yPos, 0);
    out.normals.push(0, ny, 0);
    out.colors.push(color[0], color[1], color[2]);
    for (let i = 0; i <= segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        out.positions.push(Math.cos(a) * radius, yPos, Math.sin(a) * radius);
        out.normals.push(0, ny, 0);
        out.colors.push(color[0], color[1], color[2]);
    }
    // Fan from centre. Winding flips with face direction so back-face
    // culling is consistent — without the flip the −Y cap would be
    // visible only from inside the model.
    for (let i = 0; i < segments; i++) {
        const a = center + 1 + i;
        const b = center + 1 + ((i + 1) % (segments + 1));
        if (up) out.indices.push(center, a, b);
        else    out.indices.push(center, b, a);
    }
}

/**
 * Build a merged BufferGeometry for the SL-16 / Zenit-2 second stage.
 *
 * Composition (in model units):
 *   - main tank cylinder: r 0.18, length 1.0
 *   - interstage skirt at +Y (forward, payload side): r 0.20, length 0.10
 *   - engine bay at −Y: r 0.18 → 0.15, length 0.08
 *   - nozzle bell at −Y: r 0.10 → 0.22 flaring outward, length 0.22
 *
 * Total length ≈ 1.40 model units. With MODEL_SCALE_SCENE = 0.006 the
 * on-screen body is ~0.0084 scene units (~54 km), comparable to a
 * Starlink — fine for a constellation overview view.
 */
export function buildSL16Geometry() {
    const out = { positions: [], normals: [], colors: [], indices: [] };
    const seg = 18;  // circumferential segments — 18 reads as smooth from
                    // operational zoom but stays cheap (≈400 tris per body).

    // Main tank, centred at y=0. Side only — the +Y end gets capped
    // by the interstage skirt, the −Y by the engine bay below.
    pushCylinderSide(out, 0.18, 0.18, 1.0, 0.0, seg, COL_BODY_CYL);

    // Interstage skirt: short cylinder above the tank with a slightly
    // larger radius, evoking the payload adapter ring you can pick out
    // in NORAD imagery of these stages.
    pushCylinderSide(out, 0.20, 0.20, 0.10, 0.55, seg, COL_INTERSTAGE);
    pushCap(out, 0.20, 0.60, seg, true, COL_BODY_END);    // forward dome (+Y)

    // Engine bay: a short taper from tank radius down to the throat-bell
    // root, sitting just below y = −0.50.
    pushCylinderSide(out, 0.18, 0.15, 0.08, -0.54, seg, COL_INTERSTAGE);

    // Engine nozzle bell: cone flaring outward away from the body.
    // RD-120 has a single nozzle — geometry is one truncated cone with
    // a darker inner-bell colour visible through the open end.
    pushCylinderSide(out, 0.10, 0.22, 0.22, -0.69, seg, COL_NOZZLE_OUT);
    pushCap(out, 0.22, -0.80, seg, false, COL_NOZZLE_IN);  // nozzle exit plane (−Y)

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3));
    geo.setAttribute('normal',   new THREE.Float32BufferAttribute(out.normals, 3));
    geo.setAttribute('color',    new THREE.Float32BufferAttribute(out.colors, 3));
    geo.setIndex(out.indices);
    geo.computeBoundingSphere();
    return geo;
}

export function buildRocketBodyMaterial() {
    return new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness:    0.78,   // weathered tankage — almost diffuse
        metalness:    0.10,   // a touch, to catch the terminator highlight
        flatShading:  true,
    });
}

/**
 * SL16Fleet — InstancedMesh wrapper that mirrors the tracker's SL-16
 * R/B positions each frame and orients each instance along the local
 * zenith (gravity-gradient-stable cylinder pose).
 *
 * The on/off toggle and the dot-suppression for the underlying point
 * are driven from `operations/fleet.js`, mirroring the Starlink
 * integration.
 */
export class SL16Fleet {
    /**
     * @param {object} globe   OperationsGlobe — used for the scene
     * @param {object} tracker SatelliteTracker instance
     * @param {object} [opts]
     * @param {number} [opts.maxInstances=MAX_INSTANCES]
     * @param {number} [opts.modelScale=MODEL_SCALE_SCENE]
     */
    constructor(globe, tracker, { maxInstances = MAX_INSTANCES, modelScale = MODEL_SCALE_SCENE } = {}) {
        this._tracker      = tracker;
        this._maxInstances = maxInstances;
        this._modelScale   = modelScale;
        this._visible      = false;

        this._geometry = buildSL16Geometry();
        this._material = buildRocketBodyMaterial();

        this._mesh = new THREE.InstancedMesh(this._geometry, this._material, maxInstances);
        this._mesh.frustumCulled = false;
        this._mesh.count   = 0;
        this._mesh.visible = false;
        this._mesh.name    = 'sl-16-rb-fleet';
        globe.getScene().add(this._mesh);

        // Per-instance previous scene-space position for finite-diff
        // velocity recovery — used as the cross-track-axis disambiguator
        // when building the orientation basis. Zenith alone fixes one
        // axis; we need a second deterministic axis or the rotation is
        // free.
        this._prevPos = new Float32Array(maxInstances * 3);
        this._prevPos.fill(NaN);

        this._m       = new THREE.Matrix4();
        this._scaleM  = new THREE.Matrix4().makeScale(this._modelScale, this._modelScale, this._modelScale);
        this._zenith  = new THREE.Vector3();
        this._vel     = new THREE.Vector3();
        this._along   = new THREE.Vector3();
        this._cross   = new THREE.Vector3();
        this._rotM    = new THREE.Matrix4();
        this._zeroM   = new THREE.Matrix4().makeScale(0, 0, 0);
    }

    setVisible(on) {
        this._visible = !!on;
        this._mesh.visible = this._visible;
        if (!this._visible) this._prevPos.fill(NaN);
    }

    isVisible() { return this._visible; }
    getMesh()   { return this._mesh; }

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
            if (sat.group !== SL16_GROUP) continue;

            const off = i * 3;
            const px = posArr[off];
            const py = posArr[off + 1];
            const pz = posArr[off + 2];
            if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
            if (px === 0 && py === 0 && pz === 0) continue;

            this._writeInstance(slot, px, py, pz);
            slot++;
        }
        for (let k = slot; k < this._mesh.count; k++) {
            this._mesh.setMatrixAt(k, this._zeroM);
        }
        this._mesh.count = slot;
        this._mesh.instanceMatrix.needsUpdate = true;
    }

    /**
     * Write the per-instance transform. Model frame:
     *   +Y = cylinder long axis (forward, payload end)
     *   −Y = engine nozzle
     *   +X / +Z = radial
     *
     * Mapping to world:
     *   model +Y → world zenith (gravity-gradient axis)
     *   model +Z → world along-track (velocity ⊥ zenith)
     *   model +X → world cross-track (zenith × along-track), right-handed
     *
     * If velocity isn't yet known (first frame after load) we pick the
     * cross-track axis from world Y so the orientation is still
     * deterministic. The next frame's finite difference replaces it.
     */
    _writeInstance(slot, px, py, pz) {
        this._zenith.set(px, py, pz);
        const r = this._zenith.length();
        if (r < 1e-9) {
            this._mesh.setMatrixAt(slot, this._zeroM);
            return;
        }
        this._zenith.multiplyScalar(1 / r);

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
            this._vel.set(0, 1, 0);
        }
        // Project velocity onto the horizon plane to get pure along-track.
        const dot = this._vel.dot(this._zenith);
        this._along.set(
            this._vel.x - dot * this._zenith.x,
            this._vel.y - dot * this._zenith.y,
            this._vel.z - dot * this._zenith.z,
        );
        let m = this._along.length();
        if (m < 1e-9) {
            // Pathological case (velocity parallel to zenith). Fall
            // back to a stable cross-zenith direction.
            this._along.set(1, 0, 0);
            const d2 = this._along.dot(this._zenith);
            this._along.x -= d2 * this._zenith.x;
            this._along.y -= d2 * this._zenith.y;
            this._along.z -= d2 * this._zenith.z;
            m = this._along.length();
            if (m < 1e-9) this._along.set(0, 0, 1);
            else          this._along.multiplyScalar(1 / m);
        } else {
            this._along.multiplyScalar(1 / m);
        }
        this._cross.crossVectors(this._zenith, this._along).normalize();

        // makeBasis takes columns = world-direction of local axes.
        //   local +X = cross-track
        //   local +Y = zenith
        //   local +Z = along-track
        this._rotM.makeBasis(this._cross, this._zenith, this._along);

        this._m.multiplyMatrices(this._rotM, this._scaleM);
        this._m.elements[12] = px;
        this._m.elements[13] = py;
        this._m.elements[14] = pz;
        this._mesh.setMatrixAt(slot, this._m);

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
