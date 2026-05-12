/**
 * satellite-models.js — rough 3D shapes for orbital probes
 * ═══════════════════════════════════════════════════════════════════════════
 * Builds approximate Three.js meshes for the named satellites the
 * upper-atmosphere page tracks. Style is "recognisable silhouette",
 * not "engineering CAD" — the goal is for a user who's zoomed close
 * enough to see "that's the ISS truss" or "that's a Starlink panel"
 * without needing megabytes of GLTF assets.
 *
 * Body-frame convention (matches _stepSatellites' lookAt in
 * upper-atmosphere-globe.js):
 *
 *   −Z  = velocity vector (ram direction)
 *   +Y  = radial-out (away from Earth, "up" in the local-orbit frame)
 *   ±X  = orbit-normal (cross-track) — solar panels typically extend
 *          along this axis on Earth-pointing missions.
 *
 * All dimensions are in scene units (1 = Earth radius = 6371 km). The
 * artistic scale is intentionally exaggerated: a real ISS at 110 m
 * would be ~1.7e-5 units across, way too small to see. We render at
 * ~0.04 units (~250 km equivalent) so the silhouette is visible at
 * useful camera distances.
 *
 * Each builder returns a THREE.Group with a `.userData.kind` set so
 * the picker can resolve clicks back to the satellite spec.
 */

import * as THREE from 'three';

// ── Shared materials (cheap; reused across all meshes) ──────────────────────
//
// Cached at module scope so building 50 satellites doesn't allocate
// 50 copies of the same MaterialBasic. They use Basic (not Standard)
// to avoid forcing a lighting pass — the page already has a busy
// shader budget for the atmosphere shells.

const _M = {
    bus:       new THREE.MeshBasicMaterial({ color: 0xeeeeee }),                   // white aluminum
    busDark:   new THREE.MeshBasicMaterial({ color: 0x9aa6b8 }),                   // shaded panels
    truss:     new THREE.MeshBasicMaterial({ color: 0xb8c0cc }),                   // structural
    panel:     new THREE.MeshBasicMaterial({ color: 0x1a2a6c }),                   // solar cells
    panelEdge: new THREE.MeshBasicMaterial({ color: 0xffd060 }),                   // gold edge trim
    antenna:   new THREE.MeshBasicMaterial({ color: 0xffd060 }),                   // gold-MLI dish
    nozzle:    new THREE.MeshBasicMaterial({ color: 0x4a4a52 }),                   // engine bell
    radiator:  new THREE.MeshBasicMaterial({ color: 0xe8e8f0 }),                   // white thermal
};

/** Convenience: tint a fresh basic material. Used when the spec wants
 *  the bus colour-coded (Starlink shells in blue, Iridium in purple…). */
function _matTinted(hex) {
    return new THREE.MeshBasicMaterial({ color: new THREE.Color(hex) });
}

// ── ISS ─────────────────────────────────────────────────────────────────────
//
// The defining ISS silhouette is the Integrated Truss Structure (ITS)
// running cross-track with eight large solar arrays at the ends, and
// the pressurised modules running along the velocity axis. We model:
//   • Main truss as a long thin box along X (cross-track)
//   • 8 solar arrays as dark blue rectangles, 4 per side
//   • Pressurised modules as a stack of 3 short cylinders along Z
//   • Cupola + Soyuz/Dragon as small protrusions
//
// Total span ~0.06 units (≈ 380 km artistic — visible from a couple
// Earth radii out without overwhelming the layer shells).

export function buildISSModel() {
    const g = new THREE.Group();
    g.name = 'iss-model';

    // Central pressurised module stack (lab + nodes + Russian segment),
    // running along the velocity axis (Z). Three short cylinders give
    // the right "tube of cans" feel without modeling each module.
    for (let i = -1; i <= 1; i++) {
        const mod = new THREE.Mesh(
            new THREE.CylinderGeometry(0.0035, 0.0035, 0.011, 12),
            _M.bus,
        );
        mod.rotation.x = Math.PI / 2;          // long axis → Z
        mod.position.z = i * 0.011;
        g.add(mod);
    }

    // Cross-track truss — the iconic ISS spar.
    const truss = new THREE.Mesh(
        new THREE.BoxGeometry(0.060, 0.0025, 0.0025),
        _M.truss,
    );
    g.add(truss);

    // Eight solar arrays, four per truss end. Arranged in 4 stacked
    // pairs (port-outboard, port-inboard, stbd-inboard, stbd-outboard).
    const arrayGeom = new THREE.BoxGeometry(0.013, 0.0006, 0.0085);
    const positions = [
        // port (−X)
        { x: -0.030, y:  0.005, z:  0.005 },
        { x: -0.030, y:  0.005, z: -0.005 },
        { x: -0.030, y: -0.005, z:  0.005 },
        { x: -0.030, y: -0.005, z: -0.005 },
        // starboard (+X)
        { x:  0.030, y:  0.005, z:  0.005 },
        { x:  0.030, y:  0.005, z: -0.005 },
        { x:  0.030, y: -0.005, z:  0.005 },
        { x:  0.030, y: -0.005, z: -0.005 },
    ];
    for (const p of positions) {
        const arr = new THREE.Mesh(arrayGeom, _M.panel);
        arr.position.set(p.x, p.y, p.z);
        g.add(arr);
        // Thin gold trim along the long edge — sells the silhouette.
        const trim = new THREE.Mesh(
            new THREE.BoxGeometry(0.013, 0.0007, 0.0008),
            _M.panelEdge,
        );
        trim.position.set(p.x, p.y + 0.0008 * Math.sign(p.y), p.z);
        g.add(trim);
    }

    // Two thermal-control radiators perpendicular to solar arrays —
    // gives a recognisable "white wings" cue distinct from the dark
    // solar panels.
    for (const sgn of [-1, 1]) {
        const rad = new THREE.Mesh(
            new THREE.BoxGeometry(0.018, 0.0006, 0.005),
            _M.radiator,
        );
        rad.position.set(sgn * 0.014, 0, 0.012);
        g.add(rad);
    }

    // Soyuz / Dragon dock at the −Z (forward) end — short cylinder.
    const visit = new THREE.Mesh(
        new THREE.CylinderGeometry(0.002, 0.002, 0.006, 10),
        _M.bus,
    );
    visit.rotation.x = Math.PI / 2;
    visit.position.z = -0.018;
    g.add(visit);

    return g;
}

// ── Hubble Space Telescope ─────────────────────────────────────────────────
//
// The HST is essentially a 13-m cylindrical tube with two solar arrays
// on opposite sides and an aperture door at one end. Long axis points
// inertially at the science target (not nadir or velocity), so this
// builder reflects the canonical "cylinder + wings" profile without
// trying to model attitude.

export function buildHubbleModel() {
    const g = new THREE.Group();
    g.name = 'hubble-model';

    // Main optical tube (long axis along Z = "ram" by convention; in
    // reality HST points wherever it's commanded, but Z is fine for
    // the silhouette).
    const tube = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0055, 0.0055, 0.026, 18),
        _M.bus,
    );
    tube.rotation.x = Math.PI / 2;
    g.add(tube);

    // Aperture door at +Z end — short open cap.
    const door = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0055, 0.0055, 0.0035, 18),
        _M.busDark,
    );
    door.rotation.x = Math.PI / 2;
    door.position.z = 0.014;
    g.add(door);

    // Two solar arrays extended along ±X from the mid-tube. Single
    // wing each (HST's are roller-blind cylindrical arrays in real
    // life, but a flat panel reads correctly at this scale).
    for (const sgn of [-1, 1]) {
        const wing = new THREE.Mesh(
            new THREE.BoxGeometry(0.020, 0.0005, 0.008),
            _M.panel,
        );
        wing.position.set(sgn * 0.012, 0, 0);
        g.add(wing);
        // Boom connecting wing to bus.
        const boom = new THREE.Mesh(
            new THREE.CylinderGeometry(0.0008, 0.0008, 0.005, 6),
            _M.truss,
        );
        boom.rotation.z = Math.PI / 2;
        boom.position.set(sgn * 0.0035, 0, 0);
        g.add(boom);
    }

    // High-gain antenna dish on a boom (one of two real HGAs).
    const dish = new THREE.Mesh(
        new THREE.SphereGeometry(0.003, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
        _M.antenna,
    );
    dish.rotation.x = Math.PI;          // bowl faces +Y (Earth)
    dish.position.set(0, -0.008, 0.005);
    g.add(dish);

    return g;
}

// ── Starlink (v1.0 / v1.5 generic) ──────────────────────────────────────────
//
// Starlink v1.x is a flat slab bus with a single roll-out solar
// array deployed once on orbit. Stowed it's a tabletop; deployed it's
// a long single wing. We build the deployed configuration since
// that's what the page is showing operational birds in.

export function buildStarlinkModel(tintHex = '#60a0ff') {
    const g = new THREE.Group();
    g.name = 'starlink-model';
    const tint = _matTinted(tintHex);

    // Bus: thin flat slab. Antenna face (+Y nadir) tinted with the
    // constellation colour for visual ID.
    const bus = new THREE.Mesh(
        new THREE.BoxGeometry(0.012, 0.0025, 0.014),
        _M.bus,
    );
    g.add(bus);
    // Tinted nadir-facing phased-array slab.
    const arr = new THREE.Mesh(
        new THREE.BoxGeometry(0.011, 0.0006, 0.013),
        tint,
    );
    arr.position.y = -0.0016;
    g.add(arr);

    // Single solar wing extended along +X (asymmetric is correct for
    // Starlink; the v1.5 birds fold out one side).
    const panel = new THREE.Mesh(
        new THREE.BoxGeometry(0.030, 0.0006, 0.008),
        _M.panel,
    );
    panel.position.set(0.020, 0, 0);
    g.add(panel);
    // Boom mounting the panel.
    const boom = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0007, 0.0007, 0.006, 6),
        _M.truss,
    );
    boom.rotation.z = Math.PI / 2;
    boom.position.set(0.008, 0, 0);
    g.add(boom);

    return g;
}

// ── Iridium NEXT ────────────────────────────────────────────────────────────
//
// Iridium NEXT has a triangular bus with three large mission antennas
// arrayed around it (the L-band cross-link and main mission antenna),
// plus a solar array. The triangular bus + radial antennas give the
// "starfish" silhouette seen in flares.

export function buildIridiumModel(tintHex = '#a080ff') {
    const g = new THREE.Group();
    g.name = 'iridium-model';
    const tint = _matTinted(tintHex);

    // Triangular-prism bus along Z.
    const bus = new THREE.Mesh(
        new THREE.CylinderGeometry(0.006, 0.006, 0.012, 3),
        _M.bus,
    );
    bus.rotation.x = Math.PI / 2;
    g.add(bus);

    // Three mission antenna panels arrayed at 120° around the bus.
    // These are the famous "Iridium flare" surfaces.
    for (let i = 0; i < 3; i++) {
        const ang = (i / 3) * Math.PI * 2;
        const pn = new THREE.Mesh(
            new THREE.BoxGeometry(0.013, 0.0008, 0.012),
            tint,
        );
        pn.position.set(Math.cos(ang) * 0.009, Math.sin(ang) * 0.009, 0);
        pn.rotation.z = ang;
        g.add(pn);
    }

    // Solar array along +X.
    const panel = new THREE.Mesh(
        new THREE.BoxGeometry(0.020, 0.0006, 0.007),
        _M.panel,
    );
    panel.position.set(0.018, 0, 0);
    g.add(panel);

    return g;
}

// ── Generic cubesat / bus + panels ──────────────────────────────────────────
//
// Used for everything we don't have a custom model for (constellation
// dots, debris payloads, etc.). Cube bus with two solar wings — the
// universal "satellite" silhouette.

export function buildGenericSatModel(tintHex = '#cccccc') {
    const g = new THREE.Group();
    g.name = 'generic-sat-model';
    const tint = _matTinted(tintHex);

    const bus = new THREE.Mesh(
        new THREE.BoxGeometry(0.008, 0.008, 0.012),
        tint,
    );
    g.add(bus);

    // Two solar wings, ±X.
    for (const sgn of [-1, 1]) {
        const wing = new THREE.Mesh(
            new THREE.BoxGeometry(0.018, 0.0005, 0.007),
            _M.panel,
        );
        wing.position.set(sgn * 0.013, 0, 0);
        g.add(wing);
    }

    // Small high-gain antenna dish nadir (+Y down? we use −Y for nadir
    // since +Y is radial-out by convention).
    const dish = new THREE.Mesh(
        new THREE.SphereGeometry(0.0025, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
        _M.antenna,
    );
    dish.rotation.x = Math.PI;
    dish.position.set(0, -0.005, 0);
    g.add(dish);

    return g;
}

// ── Spent rocket body ──────────────────────────────────────────────────────
//
// Long cylinder + tapered nozzle at one end. No solar panels (these
// are dead hardware). Used for the rocket-bodies debris family when
// the camera is close enough to see one.

export function buildRocketBodyModel(tintHex = '#60d8a0') {
    const g = new THREE.Group();
    g.name = 'rb-model';
    const tint = _matTinted(tintHex);

    // Main stage cylinder (Z axis).
    const stage = new THREE.Mesh(
        new THREE.CylinderGeometry(0.005, 0.005, 0.030, 12),
        tint,
    );
    stage.rotation.x = Math.PI / 2;
    g.add(stage);

    // Conical nozzle at −Z end.
    const noz = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0035, 0.006, 0.006, 14),
        _M.nozzle,
    );
    noz.rotation.x = -Math.PI / 2;
    noz.position.z = -0.018;
    g.add(noz);

    // Nose cap (or interstage) at +Z end.
    const nose = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0035, 0.005, 0.005, 12),
        _M.bus,
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.z = 0.0175;
    g.add(nose);

    return g;
}

// ── Debris fragment (small irregular shard) ────────────────────────────────
//
// A jagged tetrahedron-ish shape with a single small panel-like flap.
// Tiny — meant to be visible only when the camera is right next to a
// fragment. Tint matches the source-event family colour.

export function buildDebrisFragmentModel(tintHex = '#ff7099') {
    const g = new THREE.Group();
    g.name = 'debris-frag-model';
    const tint = _matTinted(tintHex);

    // Irregular core: a low-poly icosahedron offset slightly.
    const core = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.005, 0),
        tint,
    );
    core.rotation.set(0.4, 0.7, 0.2);
    g.add(core);

    // Bent panel-fragment hanging off one side (gives the shard a sense
    // of "this used to be part of something larger").
    const flap = new THREE.Mesh(
        new THREE.BoxGeometry(0.010, 0.0005, 0.005),
        _M.panel,
    );
    flap.position.set(0.005, 0.002, 0.001);
    flap.rotation.z = 0.6;
    flap.rotation.y = 0.3;
    g.add(flap);

    return g;
}

// ── Builder dispatch ───────────────────────────────────────────────────────
//
// Maps a satellite spec.id (or a constellation id) to the right
// builder. Falls back to the generic builder so unknown specs still
// get a recognisable shape. The dispatch covers both the named probes
// (iss, hubble, starlink, iridium) and constellation-cloud entries
// (where spec._constellationId resolves the family).

export function buildSatelliteModel(spec) {
    const id = spec?.id || '';
    const cId = spec?._constellationId || '';
    const tint = spec?.color || '#cccccc';

    if (id === 'iss')                                return buildISSModel();
    if (id === 'hubble')                             return buildHubbleModel();
    if (id === 'starlink' || cId.startsWith('starlink')) return buildStarlinkModel(tint);
    if (id === 'iridium'  || cId === 'iridium')      return buildIridiumModel(tint);
    return buildGenericSatModel(tint);
}

/**
 * Build a low-poly version of the same shape (currently identical to
 * the high-poly builder; kept as a separate entry point so we can
 * decimate later without touching call sites).
 *
 * The LOD tier list in upper-atmosphere-globe.js plugs both this and
 * buildSatelliteModel into a THREE.LOD.
 */
export function buildSatelliteModelLow(spec) {
    return buildSatelliteModel(spec);
}
