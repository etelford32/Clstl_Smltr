/**
 * envisat-model.js — Single-mesh 3D Envisat for the Operations globe.
 * Phase 3 of the "real models in place of dots" pipeline.
 *
 * Envisat is a one-of-a-kind hero asset, not a class — NORAD 27386, ESA's
 * defunct polar Earth-observation satellite. It's the largest single
 * piece of debris in LEO at ~8.2 t, ~26 m wing-tip-to-wing-tip, and has
 * been tumbling silently around its principal axis at ~2.67°/s since
 * ESA lost contact in April 2012. The visual silhouette — a tall bus
 * with one enormous gold solar wing and a flat-plate ASAR radar
 * antenna on the side — is recognisable enough that we model it as a
 * dedicated single Mesh rather than reusing the instanced pipeline.
 *
 * Pose model:
 *   - nominal frame is nadir-pointing, +Y along-track (like Starlink)
 *   - a slow tumble around the local zenith approximates the observed
 *     post-2012 attitude. Driven by the time-bus simTimeMs so scrubbing
 *     winds the tumble forward/backward in lockstep with everything
 *     else on the globe.
 *
 * Position lookup goes through `tracker.getPositionXYZ(noradId, out)`
 * — the same O(1) NORAD→slot map the conjunction screener uses — so
 * the model doesn't care which group the TLE was loaded under as long
 * as the satellite is in the tracker's catalog.
 */

import * as THREE from 'three';

// Envisat's NORAD catalog number. Stable since launch (2002-009A).
export const ENVISAT_NORAD_ID = 27386;

// Slightly larger than the constellation models. Envisat is genuinely
// big (~26 m diagonal) — bumping the scale lets the silhouette read
// without flooding the screen.
const MODEL_SCALE_SCENE = 0.010;

// Observed tumble rate from radar tracking after the 2012 loss of
// contact. ~2.67°/s ≈ 0.0466 rad/s. Applied around the local zenith.
const TUMBLE_RATE_RAD_PER_SEC = 0.0466;

const COL_BUS_TOP    = [0.86, 0.86, 0.86];  // sun-facing white MLI
const COL_BUS_SIDE   = [0.72, 0.72, 0.74];  // MLI side panels
const COL_BUS_NADIR  = [0.28, 0.28, 0.32];  // sensor side (MIPAS/MERIS/GOMOS/AATSR) — dark cluster
const COL_ASAR_FACE  = [0.42, 0.46, 0.52];  // ASAR antenna face — radar-grey
const COL_ASAR_BACK  = [0.30, 0.32, 0.36];
const COL_ASAR_EDGE  = [0.22, 0.24, 0.28];
const COL_PANEL_GOLD = [0.78, 0.62, 0.18];  // gold kapton solar array
const COL_PANEL_BACK = [0.36, 0.30, 0.16];
const COL_PANEL_EDGE = [0.42, 0.34, 0.18];

/**
 * Push one rectangular box into the accumulator arrays. Six per-face
 * colours so each face can be tinted independently — matches the
 * `pushBox` helper in `starlink-model.js` but with explicit names so
 * the geometry below reads as a description rather than as a sequence
 * of magic constants.
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

/**
 * Build the Envisat geometry. Three components in one merged
 * BufferGeometry:
 *
 *   1. Polar Platform bus — tall rectangular box, dark nadir face for
 *      the instrument cluster.
 *   2. ASAR antenna — large flat plate cantilevered off the +X side
 *      of the bus, oriented in the X-Y plane.
 *   3. Solar array — single wing extending in +Y from the forward end
 *      of the bus, gold-tinted to read against the white MLI bus.
 *
 * Model frame (matches the Starlink convention so the two layers
 * compose cleanly):
 *   +X = ASAR deployment direction (cross-track, in nominal pose)
 *   +Y = along-track (velocity) — solar wing also extends in +Y
 *   -Z = nadir (Earth-pointing)
 */
export function buildEnvisatGeometry() {
    const out = { positions: [], normals: [], colors: [], indices: [] };

    // ── Polar Platform bus ────────────────────────────────────────
    // Real dimensions ~10 × 4 × 5 m. In model units: 1.0 along-track,
    // 0.5 cross-track, 0.6 nadir-to-zenith. The −Z face (nadir, sensor
    // side) gets a darker tint to read as the optical/SAR instrument
    // cluster crammed into the Earth-facing deck.
    pushBox(
        out,
        0, 0, 0,
        0.5, 1.0, 0.6,
        [
            COL_BUS_SIDE,   // +X (ASAR-side wall)
            COL_BUS_SIDE,   // -X
            COL_BUS_SIDE,   // +Y (forward, solar-array side)
            COL_BUS_SIDE,   // -Y (aft)
            COL_BUS_TOP,    // +Z (zenith, sun-facing white MLI)
            COL_BUS_NADIR,  // -Z (nadir instrument deck)
        ],
    );

    // ── ASAR (Advanced Synthetic Aperture Radar) ──────────────────
    // Distinctive 10 × 1.3 m flat-plate antenna mounted on the +X side
    // of the bus. Lies roughly in the X-Y plane (cross-track / along-
    // track), tilted slightly down for off-nadir radar look in real
    // life — we render it level for clarity at this scale.
    //   Y span: 1.2 (slightly shorter than the bus's 1.0 + overhang)
    //   X depth: 0.85 (extends out from +X face of bus)
    //   Z thickness: 0.06
    // Mounted just above the bus mid-Z so the antenna face reads as
    // sky-facing on +Z and Earth-facing on −Z (the radar look
    // direction in operational use).
    pushBox(
        out,
        0.5 / 2 + 0.85 / 2 + 0.01, 0, 0.05,
        0.85, 1.2, 0.06,
        [
            COL_ASAR_EDGE,   // +X (outboard edge)
            COL_ASAR_EDGE,   // -X (root edge meeting bus)
            COL_ASAR_EDGE,   // +Y
            COL_ASAR_EDGE,   // -Y
            COL_ASAR_FACE,   // +Z (sky)
            COL_ASAR_BACK,   // -Z (Earth-facing radar face — darker)
        ],
    );

    // ── Solar array (single wing) ─────────────────────────────────
    // Real Envisat had a single 14 × 5 m wing on one side. We deploy
    // it from the +Y (forward) face along +Y. Gold kapton on the sun-
    // facing side, dark on the back.
    //   Y extending: 1.6 (well beyond bus +Y face)
    //   X span: 0.5
    //   Z thickness: 0.03
    pushBox(
        out,
        0, 1.0 / 2 + 1.6 / 2 + 0.01, 0.10,
        0.5, 1.6, 0.03,
        [
            COL_PANEL_EDGE,  // +X (outboard tip strip)
            COL_PANEL_EDGE,  // -X
            COL_PANEL_EDGE,  // +Y (far tip)
            COL_PANEL_EDGE,  // -Y (root edge)
            COL_PANEL_GOLD,  // +Z (cell side / gold kapton)
            COL_PANEL_BACK,  // -Z (rear)
        ],
    );

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3));
    geo.setAttribute('normal',   new THREE.Float32BufferAttribute(out.normals, 3));
    geo.setAttribute('color',    new THREE.Float32BufferAttribute(out.colors, 3));
    geo.setIndex(out.indices);
    geo.computeBoundingSphere();
    return geo;
}

export function buildEnvisatMaterial() {
    return new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness:    0.50,   // a bit shinier than the rocket body — MLI catches the sun
        metalness:    0.20,
        flatShading:  true,
    });
}

/**
 * EnvisatModel — single Mesh that mirrors NORAD 27386's position each
 * frame, oriented in the nominal LVLH frame plus a slow tumble around
 * the local zenith.
 *
 * Visibility is gated by an explicit setVisible(); the wrapping layer
 * in `fleet.js` is responsible for ensuring the underlying TLE is
 * loaded before the mesh is shown (otherwise tick() finds nothing and
 * the mesh just stays hidden at the origin).
 */
export class EnvisatModel {
    constructor(globe, tracker, { modelScale = MODEL_SCALE_SCENE } = {}) {
        this._tracker    = tracker;
        this._modelScale = modelScale;
        this._visible    = false;

        // Velocity finite-difference state — same trick the instanced
        // fleets use, but for one object so it's just three floats.
        this._prevX = NaN;
        this._prevY = NaN;
        this._prevZ = NaN;

        this._geometry = buildEnvisatGeometry();
        this._material = buildEnvisatMaterial();
        this._mesh = new THREE.Mesh(this._geometry, this._material);
        this._mesh.frustumCulled = false;
        this._mesh.visible = false;
        this._mesh.name    = 'envisat';
        globe.getScene().add(this._mesh);

        // Scratch vectors / matrices to keep tick() allocation-free.
        this._pos     = new THREE.Vector3();
        this._zenith  = new THREE.Vector3();
        this._along   = new THREE.Vector3();
        this._cross   = new THREE.Vector3();
        this._rotM    = new THREE.Matrix4();
        this._tumbleM = new THREE.Matrix4();
        this._scaleM  = new THREE.Matrix4().makeScale(modelScale, modelScale, modelScale);
        this._m       = new THREE.Matrix4();

        // Tumble epoch: we want the rendered tumble phase to be
        // reproducible — same simTime → same orientation — so the
        // angle is computed from absolute simTimeMs, not accumulated
        // dt. Picking the launch epoch as the zero is arbitrary;
        // the only constraint is that two viewers at the same
        // simTimeMs see the same orientation.
        this._tumbleEpochMs = 0;
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

    /**
     * Update Envisat's mesh transform. Called from the globe tick
     * loop. The simTimeMs argument is the same value the tracker tick
     * used, so tumble phase stays in lockstep with positions even at
     * 3600× scrub speed.
     */
    tick(simTimeMs) {
        if (!this._visible) return;

        // Position lookup. The tracker stores positions in its
        // internal scene-space buffer, addressable by NORAD ID.
        const pos = this._tracker.getPositionXYZ(ENVISAT_NORAD_ID, this._pos);
        if (!pos) {
            // TLE not loaded yet — hide until it lands. Avoids
            // flashing the mesh at the origin while the proxy fetch
            // is in flight.
            this._mesh.visible = false;
            return;
        }
        if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
            this._mesh.visible = false;
            return;
        }
        if (pos.x === 0 && pos.y === 0 && pos.z === 0) {
            // Origin-sentinel for an un-propagated slot. Wait one
            // more frame before showing the mesh.
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

        // Along-track from finite-difference between frames, projected
        // perpendicular to zenith. Same logic as the instanced fleets.
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
            // First frame — pick a stable horizon-plane direction so
            // the mesh isn't pinned to a world axis until the second
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

        // LVLH basis: columns are world directions of local +X / +Y / +Z.
        //   local +X = cross-track (ASAR antenna direction)
        //   local +Y = along-track (solar wing extends here)
        //   local +Z = zenith (so -Z faces Earth, the nadir instrument deck)
        this._rotM.makeBasis(this._cross, this._along, this._zenith);

        // Tumble: rotate around the local +Z (zenith). The angle is a
        // pure function of simTimeMs, so scrubbing wind it forward
        // or back deterministically. makeRotationAxis would re-derive
        // the world axis every frame; building it in local space and
        // multiplying by the LVLH basis lets us reuse the same axis
        // (0,0,1).
        const tumbleAngle = ((simTimeMs - this._tumbleEpochMs) / 1000) * TUMBLE_RATE_RAD_PER_SEC;
        this._tumbleM.makeRotationZ(tumbleAngle);

        // Compose: world = T · R_lvlh · R_tumble · S
        this._m.multiplyMatrices(this._rotM, this._tumbleM);
        this._m.multiply(this._scaleM);
        this._m.elements[12] = px;
        this._m.elements[13] = py;
        this._m.elements[14] = pz;

        // Apply directly to the Mesh's matrix; matrixAutoUpdate=false
        // keeps THREE from clobbering it on the next render.
        this._mesh.matrixAutoUpdate = false;
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
