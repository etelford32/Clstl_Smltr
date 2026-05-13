/**
 * rocket-body-model.js — Instanced 3D rocket-body debris for the
 * Operations globe. Phases 2 + 4 of the "real models in place of
 * dots" pipeline.
 *
 * Members:
 *   - SL-16 / Zenit-2 second stage. ~9 t each, ~11 m long, ~18 of
 *     them clustered between 800–900 km. McKnight et al.'s #1 most
 *     statistically-concerning class in LEO.
 *   - SL-8 / Cosmos-3M second stage. ~1.4 t each, ~6 m long, but
 *     there are ~290 of them — the population that dominates the
 *     "objects per shell" count between 700–1000 km.
 *
 * Both render through a shared `RocketBodyFleet` class — a single
 * InstancedMesh keyed to a CelesTrak NAME-filter group, gravity-
 * gradient orientation (cylinder long axis aligned with local zenith),
 * with an optional per-instance tumble around that axis. SL-16 is
 * rendered stable (canonical gravity-gradient pose); SL-8 gets a slow
 * tumble phased off NORAD ID so neighbours don't move in lockstep —
 * matches the radar-observed behaviour of much of the Cosmos-3M
 * upper-stage population.
 *
 * Why a hand-rolled merged geometry instead of CylinderGeometry +
 * BufferGeometryUtils.mergeGeometries: keeps the module dependency
 * surface to plain `three` (no addons/utils import) and lets the
 * vertex-colour scheme be face-aware (engine bell darker than tank,
 * paint band a different hue from the surrounding cylinder, etc.).
 */

import * as THREE from 'three';

// CelesTrak group ids the proxy uses for the NAME lookups. Must match
// the keys registered in `api/celestrak/tle.js`.
const SL16_GROUP = 'sl-16-rb';
const SL8_GROUP  = 'sl-8-rb';

// Common exaggeration factor — same as the Starlink renderer so all
// "real model" layers compose at consistent visual sizes. The geometry
// itself encodes the relative dimensions (SL-8 is built smaller in
// model units than SL-16), so one shared scale is enough.
const MODEL_SCALE_SCENE = 0.006;

// Cylinder circumferential segments. 24 reads as smooth even on
// close zoom and stays cheap on the per-body triangle count
// (~600 tris per body). Bumped from the original 18 as part of the
// phase-4 polish pass.
const CYL_SEGMENTS = 24;

// ── Shared palette ────────────────────────────────────────────────
// Per-body palettes below override only what's distinctive (paint
// band, tank colour) and re-use these for the engine bell + cap so
// the two rockets read as belonging to the same lighting universe.
const COL_NOZZLE_OUT  = [0.32, 0.27, 0.22];  // engine bell exterior
const COL_NOZZLE_IN   = [0.12, 0.09, 0.07];  // engine bell interior (almost black)
const COL_END_CAP     = [0.46, 0.42, 0.36];  // forward dome / interstage ring

// ── SL-16 palette: warm cream tankage + amber paint band ──────────
const SL16_BODY_CYL   = [0.80, 0.76, 0.68];
const SL16_BAND       = [0.55, 0.42, 0.18];
const SL16_INTERSTAGE = [0.50, 0.46, 0.38];

// ── SL-8 palette: cool grey tankage + dark band ───────────────────
const SL8_BODY_CYL    = [0.72, 0.72, 0.70];
const SL8_BAND        = [0.18, 0.18, 0.20];

/**
 * Append a cylinder section (no caps) to vertex/normal/colour/index
 * arrays. Frustum-aware: works for tapers and cones too. Side-only;
 * end caps are added separately when wanted.
 */
function pushCylinderSide(out, radiusBottom, radiusTop, height, yCenter, segments, color) {
    const halfH = height / 2;
    const yBot  = yCenter - halfH;
    const yTop  = yCenter + halfH;
    const dr    = radiusTop - radiusBottom;
    // Slant for the side normal — for a frustum the normal tilts
    // toward the smaller end. (height, dr) defines the slant
    // triangle.
    const slant = Math.hypot(height, dr);
    const nRadial = slant > 0 ? height / slant : 1;
    const nAxial  = slant > 0 ? -dr    / slant : 0;

    for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        const cos0 = Math.cos(a0), sin0 = Math.sin(a0);
        const cos1 = Math.cos(a1), sin1 = Math.sin(a1);
        const base = out.positions.length / 3;
        out.positions.push(
            cos0 * radiusBottom, yBot, sin0 * radiusBottom,
            cos1 * radiusBottom, yBot, sin1 * radiusBottom,
            cos1 * radiusTop,    yTop, sin1 * radiusTop,
            cos0 * radiusTop,    yTop, sin0 * radiusTop,
        );
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

/** Flat disc cap at y=yPos. up=true → normal +Y, else −Y. */
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
 * Composition (model units, +Y = forward / payload end):
 *   - main tank cylinder: r 0.18, length 1.0
 *   - paint band:         r 0.182, length 0.05 at y = 0.15 (amber)
 *   - interstage skirt:   r 0.20, length 0.10 at y = 0.55
 *   - forward dome cap:   r 0.20 at y = 0.60
 *   - engine bay taper:   0.18 → 0.15, length 0.08 at y = -0.54
 *   - nozzle bell:        0.10 → 0.22, length 0.22 at y = -0.69
 *   - nozzle exit plane:  r 0.22 at y = -0.80 (dark interior)
 *
 * Total length ≈ 1.40 model units → ~54 km on screen at MODEL_SCALE_SCENE.
 */
export function buildSL16Geometry() {
    const out = { positions: [], normals: [], colors: [], indices: [] };
    const seg = CYL_SEGMENTS;

    pushCylinderSide(out, 0.18, 0.18, 1.0, 0.0, seg, SL16_BODY_CYL);

    // Paint band — slightly proud of the tank so it reads as a
    // detail at a glance, not as part of the tank shading. Amber to
    // suggest Cyrillic markings characteristic of Zenit-2 stages.
    pushCylinderSide(out, 0.184, 0.184, 0.05, 0.15, seg, SL16_BAND);

    pushCylinderSide(out, 0.20, 0.20, 0.10, 0.55, seg, SL16_INTERSTAGE);
    pushCap(out, 0.20, 0.60, seg, true, COL_END_CAP);

    pushCylinderSide(out, 0.18, 0.15, 0.08, -0.54, seg, SL16_INTERSTAGE);
    pushCylinderSide(out, 0.10, 0.22, 0.22, -0.69, seg, COL_NOZZLE_OUT);
    pushCap(out, 0.22, -0.80, seg, false, COL_NOZZLE_IN);

    return finalizeGeometry(out);
}

/**
 * Build a merged BufferGeometry for the SL-8 / Cosmos-3M second stage.
 *
 * Stubbier than SL-16: ~6 m × 2.4 m in real units (aspect ratio
 * ~2.5:1 vs SL-16's ~2.8:1), simpler engine deck (one main RD-216
 * nozzle, the four small verniers are too fine to render at this
 * scale), and a darker paint band lower on the tank.
 *
 * Composition (model units):
 *   - main tank cylinder: r 0.22, length 0.70
 *   - paint band:         r 0.224, length 0.04 at y = -0.05 (dark)
 *   - forward dome cap:   r 0.22 at y = 0.35
 *   - engine bay taper:   0.22 → 0.18, length 0.06 at y = -0.38
 *   - main nozzle bell:   0.12 → 0.18, length 0.14 at y = -0.48
 *   - nozzle exit plane:  r 0.18 at y = -0.55
 *
 * Total length ≈ 0.90 model units → ~36 km on screen — visibly
 * smaller than SL-16 (~54 km) at the same MODEL_SCALE_SCENE, which
 * preserves the real-world size relationship without per-class
 * scale-tuning.
 */
export function buildSL8Geometry() {
    const out = { positions: [], normals: [], colors: [], indices: [] };
    const seg = CYL_SEGMENTS;

    pushCylinderSide(out, 0.22, 0.22, 0.70, 0.0, seg, SL8_BODY_CYL);

    // Paint band — lower on the tank than the SL-16's amber ring,
    // and darker, so a side-by-side view reads as "different rocket"
    // at a glance even before zooming in.
    pushCylinderSide(out, 0.224, 0.224, 0.04, -0.05, seg, SL8_BAND);

    pushCap(out, 0.22, 0.35, seg, true, COL_END_CAP);

    pushCylinderSide(out, 0.22, 0.18, 0.06, -0.38, seg, SL8_BAND);
    pushCylinderSide(out, 0.12, 0.18, 0.14, -0.48, seg, COL_NOZZLE_OUT);
    pushCap(out, 0.18, -0.55, seg, false, COL_NOZZLE_IN);

    return finalizeGeometry(out);
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

export function buildRocketBodyMaterial() {
    return new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness:    0.78,
        metalness:    0.10,
        flatShading:  true,
    });
}

/**
 * RocketBodyFleet — shared instanced-mesh renderer for upper-stage
 * debris. Both SL-16 and SL-8 instantiate this with different geometry
 * + tumble parameters.
 *
 * Orientation: long axis aligned with the local zenith (gravity-
 * gradient-stable pose), cross-track axis disambiguated by velocity
 * finite difference between frames.
 *
 * Optional tumble: a rotation around the cylinder's local +Y axis at
 * `tumbleRateRadPerSec`, phased per-instance so neighbouring rockets
 * don't move in lockstep. The phase derives from NORAD ID so the same
 * rocket has a reproducible phase across reloads + scrubs.
 */
export class RocketBodyFleet {
    constructor(globe, tracker, {
        groupId,
        geometry,
        material,
        maxInstances        = 256,
        modelScale          = MODEL_SCALE_SCENE,
        tumbleRateRadPerSec = 0,
    }) {
        if (!groupId)  throw new Error('RocketBodyFleet: groupId required');
        if (!geometry) throw new Error('RocketBodyFleet: geometry required');
        if (!material) throw new Error('RocketBodyFleet: material required');

        this._tracker      = tracker;
        this._groupId      = groupId;
        this._maxInstances = maxInstances;
        this._modelScale   = modelScale;
        this._tumbleRate   = tumbleRateRadPerSec;
        this._visible      = false;

        this._geometry = geometry;
        this._material = material;

        this._mesh = new THREE.InstancedMesh(geometry, material, maxInstances);
        this._mesh.frustumCulled = false;
        this._mesh.count   = 0;
        this._mesh.visible = false;
        this._mesh.name    = `${groupId}-fleet`;
        globe.getScene().add(this._mesh);

        this._prevPos = new Float32Array(maxInstances * 3);
        this._prevPos.fill(NaN);

        // Scratch — all per-tick allocations live here, none in the
        // hot loop.
        this._m       = new THREE.Matrix4();
        this._scaleM  = new THREE.Matrix4().makeScale(modelScale, modelScale, modelScale);
        this._tumbleM = new THREE.Matrix4();
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

    tick(simTimeMs = 0) {
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
            if (sat.group !== this._groupId) continue;

            const off = i * 3;
            const px = posArr[off];
            const py = posArr[off + 1];
            const pz = posArr[off + 2];
            if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
            if (px === 0 && py === 0 && pz === 0) continue;

            this._writeInstance(slot, px, py, pz, simTimeMs, sat.tle.norad_id | 0);
            slot++;
        }
        for (let k = slot; k < this._mesh.count; k++) {
            this._mesh.setMatrixAt(k, this._zeroM);
        }
        this._mesh.count = slot;
        this._mesh.instanceMatrix.needsUpdate = true;
    }

    /**
     * Write one instance matrix. Frame:
     *   model +Y → world zenith
     *   model +Z → world along-track
     *   model +X → world cross-track (right-handed)
     *
     * If tumble is enabled, an extra rotation around model +Y is
     * applied (the cylinder spins around its long axis), phased by
     * NORAD ID so each rocket has a distinct phase.
     */
    _writeInstance(slot, px, py, pz, simTimeMs, noradId) {
        this._zenith.set(px, py, pz);
        const r = this._zenith.length();
        if (r < 1e-9) {
            this._mesh.setMatrixAt(slot, this._zeroM);
            return;
        }
        this._zenith.multiplyScalar(1 / r);

        // Velocity finite difference → along-track axis.
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

        const dot = this._vel.dot(this._zenith);
        this._along.set(
            this._vel.x - dot * this._zenith.x,
            this._vel.y - dot * this._zenith.y,
            this._vel.z - dot * this._zenith.z,
        );
        let m = this._along.length();
        if (m < 1e-9) {
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

        this._rotM.makeBasis(this._cross, this._zenith, this._along);

        if (this._tumbleRate !== 0) {
            // Per-instance phase. The NORAD ID, fractional-multiplied
            // by an irrational, gives a uniform distribution of phases
            // over the catalog without needing a separate RNG seed.
            // φ ≡ id × (golden-ratio fraction) × 2π (mod 2π).
            const phase = ((noradId * 0.6180339887) % 1) * Math.PI * 2;
            const angle = (simTimeMs / 1000) * this._tumbleRate + phase;
            this._tumbleM.makeRotationY(angle);
            this._m.multiplyMatrices(this._rotM, this._tumbleM);
            this._m.multiply(this._scaleM);
        } else {
            this._m.multiplyMatrices(this._rotM, this._scaleM);
        }
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

/* ── Factory helpers ─────────────────────────────────────────────────
 * Thin wrappers so the operations/fleet.js wiring reads as
 *   this.sl16Fleet = createSL16Fleet(globe, tracker);
 * instead of a 6-line config object at the call site.
 */

export function createSL16Fleet(globe, tracker) {
    return new RocketBodyFleet(globe, tracker, {
        groupId:             SL16_GROUP,
        geometry:            buildSL16Geometry(),
        material:            buildRocketBodyMaterial(),
        maxInstances:        256,
        // SL-16 R/Bs are typically gravity-gradient-stable on long
        // baselines — render them stationary so the "stable axial
        // pose" reads visually. Most observed tumble rates are slow
        // enough (<0.1°/s) that they wouldn't add much at 1× sim
        // speed anyway.
        tumbleRateRadPerSec: 0,
    });
}

export function createSL8Fleet(globe, tracker) {
    return new RocketBodyFleet(globe, tracker, {
        groupId:             SL8_GROUP,
        geometry:            buildSL8Geometry(),
        material:            buildRocketBodyMaterial(),
        // ~290 SL-8 R/Bs catalogued today; 512 leaves room for the
        // unindexed tail without doubling the matrix buffer again.
        maxInstances:        512,
        // ~1°/s tumble, phased by NORAD ID. Matches the observed
        // attitude state of much of the Cosmos-3M upper-stage
        // population — slow enough to look stately at 1× speed,
        // dramatic at 60–3600× scrub.
        tumbleRateRadPerSec: Math.PI / 180,
    });
}

