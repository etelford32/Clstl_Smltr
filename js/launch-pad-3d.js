/**
 * launch-pad-3d.js — Pluggable launch-pad geometry.
 *
 * Different rockets fly from very different ground infrastructure. This
 * module exposes one builder per pad style so the framework can swap pads
 * the same way it swaps vehicles. Each builder returns:
 *
 *   { root, beacons }
 *
 *   root      THREE.Group with the entire pad + tower + ground, base at y=0
 *   beacons   Array of { mesh, phase, color } — red/white aviation warning
 *             lights the framework's tick loop blinks at ~0.5 Hz
 *
 * Pad styles:
 *   'lc39a'        — KSC LC-39A: MLP deck, Fixed Service Structure (FSS),
 *                    crew-access arm, sound-suppression water tank,
 *                    Rotating Service Structure (retracted), 3 lightning
 *                    masts. Used for the Space Shuttle.
 *   'mechazilla'   — SpaceX Stage 0 / Boca Chica OLIT: Orbital Launch Mount
 *                    on 6 legs, integration tower with chopstick catch arms,
 *                    Quick-Disconnect (QD) arm, lightning rods, propellant
 *                    farm (4 cryo tanks). Used for Starship.
 *   'generic'      — Minimal MLP + lattice tower fallback for any vehicle
 *                    without a dedicated pad.
 *
 * Public API:
 *   buildPad(id, opts) → { root, beacons }
 */

import * as THREE from 'three';

// ── Materials ────────────────────────────────────────────────────────────────

const PAD_COLORS = {
    concrete:       0x3a3a40,
    concreteLight:  0x4f4f56,
    gravel:         0x2a2620,
    asphalt:        0x161618,
    fssOrange:      0xc15028,        // Florida-coast pad red-orange
    chopstickYellow:0xd0a020,        // Mechazilla yellow
    steel:          0xa8acb2,
    steelDark:      0x4a4e54,
    tankWhite:      0xe2e6ec,
    waterBlue:      0x1a2c44,
    beaconRed:      0xff2010,
    beaconWhite:    0xfff2c0,
    floodlight:     0xffe6a0,
    rust:           0x8a3a18,
};

function flatMat(color, roughness = 0.85, metalness = 0.05) {
    return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function steelMat(color = PAD_COLORS.steel, roughness = 0.55, metalness = 0.6) {
    return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function emissiveMat(color, intensity = 1.0) {
    return new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: intensity,
        roughness: 0.4,
        metalness: 0.0,
    });
}

// ── Shared sub-builders ──────────────────────────────────────────────────────

// Lattice column made from 4 corner tubes + diagonal cross-bracing every Δ m.
// Returns a Group rooted at (0,0,0), tower extends up +Y to y=height.
function buildLatticeTower({
    height,
    footprint = 6,
    color     = PAD_COLORS.fssOrange,
    diagonal  = true,
    bandStep  = 7,
}) {
    const g = new THREE.Group();
    const mat = flatMat(color, 0.7, 0.15);
    const beamGeo = new THREE.BoxGeometry(0.45, height, 0.45);
    const half = footprint / 2;

    // 4 corner columns
    for (const [dx, dz] of [[-half, -half], [half, -half], [-half, half], [half, half]]) {
        const col = new THREE.Mesh(beamGeo, mat);
        col.position.set(dx, height / 2, dz);
        col.castShadow = true;
        col.receiveShadow = true;
        g.add(col);
    }

    // Cross-bracing rings + optional diagonals
    const skinny = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.15 });
    function beam(p0, p1) {
        const v0 = new THREE.Vector3(...p0);
        const v1 = new THREE.Vector3(...p1);
        const len = v0.distanceTo(v1);
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, len), skinny);
        m.position.copy(v0).lerp(v1, 0.5);
        m.lookAt(v1);
        m.castShadow = true;
        g.add(m);
    }
    for (let y = bandStep; y < height; y += bandStep) {
        beam([-half, y, -half], [ half, y, -half]);
        beam([-half, y,  half], [ half, y,  half]);
        beam([-half, y, -half], [-half, y,  half]);
        beam([ half, y, -half], [ half, y,  half]);
        if (diagonal) {
            beam([-half, y - bandStep, -half], [ half, y, -half]);
            beam([-half, y - bandStep,  half], [ half, y,  half]);
            beam([-half, y - bandStep, -half], [-half, y,  half]);
            beam([ half, y - bandStep, -half], [ half, y,  half]);
        }
    }

    return g;
}

// Aviation warning beacon — small emissive sphere + tiny spike, returned
// alongside its phase so the framework can blink it. Beacons are usually
// visible from a long way off, so we cheat a bit on emissive intensity.
function buildBeacon({ color = PAD_COLORS.beaconRed, intensity = 2.0 } = {}) {
    const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 12, 8),
        emissiveMat(color, intensity)
    );
    return sphere;
}

// Ground deck — concrete pad tile + surrounding gravel. Sized to feel
// "site-scale" so the camera sees real ground at all but the closest views.
function buildGroundPlane({ size = 320, padSize = 60, padColor = PAD_COLORS.concrete }) {
    const g = new THREE.Group();

    // Outer terrain
    const terrain = new THREE.Mesh(
        new THREE.CircleGeometry(size, 64),
        flatMat(PAD_COLORS.gravel, 0.95)
    );
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.y = -0.25;
    terrain.receiveShadow = true;
    g.add(terrain);

    // Inner pad
    const pad = new THREE.Mesh(
        new THREE.CircleGeometry(padSize, 64),
        flatMat(padColor, 0.9)
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = -0.20;
    pad.receiveShadow = true;
    g.add(pad);

    // Concentric apron stripe
    const apron = new THREE.Mesh(
        new THREE.RingGeometry(padSize, padSize + 4, 64),
        flatMat(PAD_COLORS.concreteLight, 0.92)
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.21;
    apron.receiveShadow = true;
    g.add(apron);

    return g;
}

// Pole-mounted floodlight — used for perimeter and tower lighting. Returns a
// group with a pole, lamp head, and a faint halo sprite that reads as a
// light source when the camera is far away.
function buildFloodlight({ height = 18, color = PAD_COLORS.floodlight } = {}) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.22, height, 10),
        steelMat(PAD_COLORS.steelDark, 0.6, 0.4)
    );
    pole.position.y = height / 2;
    pole.castShadow = true;
    g.add(pole);

    const head = new THREE.Mesh(
        new THREE.BoxGeometry(1.4, 0.5, 1.0),
        steelMat(PAD_COLORS.steelDark, 0.4, 0.5)
    );
    head.position.set(0.5, height - 0.3, 0);
    head.castShadow = true;
    g.add(head);

    const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 12, 8),
        new THREE.MeshBasicMaterial({
            color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
            depthWrite: false,
        })
    );
    halo.position.set(0.5, height - 0.3, 0);
    g.add(halo);

    return g;
}

// ── LC-39A (Space Shuttle) ───────────────────────────────────────────────────

function buildLC39A() {
    const root = new THREE.Group();
    root.name = 'LC-39A';
    const beacons = [];

    // Ground
    root.add(buildGroundPlane({ size: 280, padSize: 55 }));

    // Mobile Launcher Platform — square deck under the stack with a flame
    // trench slot. Taller than a generic deck (the real MLP is ~7.5 m).
    const mlpBase = new THREE.Mesh(
        new THREE.BoxGeometry(40, 4.2, 36),
        flatMat(PAD_COLORS.concreteLight, 0.85)
    );
    mlpBase.position.y = 2.1;
    mlpBase.castShadow = true;
    mlpBase.receiveShadow = true;
    root.add(mlpBase);

    // Flame trench cut — visible black opening below the SRB exhausts.
    const trench = new THREE.Mesh(
        new THREE.BoxGeometry(20, 5.0, 7),
        new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    trench.position.y = 1.7;
    root.add(trench);

    // Hold-down posts on the deck — eight small concrete blocks where SRB
    // skirts and orbiter aft attach.
    for (const [x, z] of [[-7,-2],[-7,2],[7,-2],[7,2],[-2,-7],[-2,7],[2,-7],[2,7]]) {
        const post = new THREE.Mesh(
            new THREE.BoxGeometry(1.4, 0.8, 1.4),
            flatMat(PAD_COLORS.concrete, 0.9)
        );
        post.position.set(x, 4.4, z);
        post.castShadow = true;
        post.receiveShadow = true;
        root.add(post);
    }

    // Fixed Service Structure (FSS) — orange lattice tower NORTH of the
    // stack (we put it at -X). Real FSS is ~107 m; we use 92 m so it
    // doesn't dominate the camera frame.
    const fssH = 92;
    const fss = buildLatticeTower({ height: fssH, footprint: 7, color: PAD_COLORS.fssOrange });
    fss.position.set(-22, 4.2, 0);
    root.add(fss);

    // Crew-access arm — extends from FSS at orbiter cabin height (~64 m)
    // toward the stack. Retracted at T-7s in real ops; we draw it half-
    // extended for visual continuity with the orbiter.
    const cabArm = new THREE.Mesh(
        new THREE.BoxGeometry(15, 1.2, 1.6),
        flatMat(PAD_COLORS.fssOrange, 0.7, 0.1)
    );
    cabArm.position.set(-15, 4.2 + 64, 4);
    cabArm.castShadow = true;
    root.add(cabArm);

    // Crew-access room (the "white room" pod at the arm tip)
    const whiteRoom = new THREE.Mesh(
        new THREE.BoxGeometry(2.5, 2.5, 2.5),
        flatMat(0xeeeeee, 0.7)
    );
    whiteRoom.position.set(-7.5, 4.2 + 64, 4);
    whiteRoom.castShadow = true;
    root.add(whiteRoom);

    // GOX vent arm + "beanie cap" — at top of FSS, normally over the ET
    // nose during fueling. We park it retracted to the FSS.
    const gox = new THREE.Mesh(
        new THREE.ConeGeometry(2.2, 3.0, 16),
        flatMat(0xeeeeee, 0.7)
    );
    gox.position.set(-22, 4.2 + fssH - 6, 0);
    gox.castShadow = true;
    root.add(gox);

    // 3 lightning masts at the top of the FSS
    for (let i = 0; i < 3; i++) {
        const mast = new THREE.Mesh(
            new THREE.CylinderGeometry(0.10, 0.10, 16, 10),
            steelMat(PAD_COLORS.steelDark, 0.4, 0.7)
        );
        mast.position.set(-22 + (i - 1) * 3.2, 4.2 + fssH + 8, -2.5);
        mast.castShadow = true;
        root.add(mast);
    }

    // Rotating Service Structure (RSS) — large rectangular "barn" in
    // retracted position, swung 120° away from the stack. Drawn as a few
    // solid panels for visual mass.
    const rssH = 56;
    const rssBarn = new THREE.Group();
    const wall = (w, h, d, color = PAD_COLORS.fssOrange) =>
        new THREE.Mesh(new THREE.BoxGeometry(w, h, d), flatMat(color, 0.75));
    const panel1 = wall(18, rssH, 8);
    panel1.position.set(0, rssH / 2, 0);
    panel1.castShadow = true;
    panel1.receiveShadow = true;
    rssBarn.add(panel1);
    // RSS hinge column
    const rssHinge = wall(2.5, rssH + 4, 2.5, PAD_COLORS.fssOrange);
    rssHinge.position.set(-9, (rssH + 4) / 2, 4);
    rssHinge.castShadow = true;
    rssBarn.add(rssHinge);
    rssBarn.position.set(-32, 4.2, 24);
    rssBarn.rotation.y = Math.PI * 0.55;
    root.add(rssBarn);

    // Sound-suppression water tank — the iconic white sphere on stilts at
    // the south side of the pad. Fired ~1.1 million gallons of water
    // through pad outlets at T-6 to dampen acoustic energy.
    const wtFrame = new THREE.Group();
    const wtSphere = new THREE.Mesh(
        new THREE.SphereGeometry(8, 28, 18),
        flatMat(PAD_COLORS.tankWhite, 0.6, 0.1)
    );
    wtSphere.position.y = 22;
    wtSphere.castShadow = true;
    wtSphere.receiveShadow = true;
    wtFrame.add(wtSphere);
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const leg = new THREE.Mesh(
            new THREE.CylinderGeometry(0.3, 0.3, 18, 8),
            steelMat(PAD_COLORS.steelDark, 0.6, 0.3)
        );
        leg.position.set(Math.cos(a) * 4, 9, Math.sin(a) * 4);
        leg.castShadow = true;
        wtFrame.add(leg);
    }
    wtFrame.position.set(38, 0, 22);
    root.add(wtFrame);

    // Perimeter floodlights
    for (const [x, z] of [[-30, 30], [30, -30], [-50, -10], [50, 30]]) {
        const fl = buildFloodlight({ height: 18 });
        fl.position.set(x, 0, z);
        root.add(fl);
    }

    // Aviation warning beacons — top of FSS (red), top of RSS (red).
    const fssBeacon = buildBeacon({ color: PAD_COLORS.beaconRed });
    fssBeacon.position.set(-22, 4.2 + fssH + 17, -2.5);
    root.add(fssBeacon);
    beacons.push({ mesh: fssBeacon, phase: 0,    color: PAD_COLORS.beaconRed });

    const wtBeacon = buildBeacon({ color: PAD_COLORS.beaconRed });
    wtBeacon.position.set(38, 30.2, 22);
    root.add(wtBeacon);
    beacons.push({ mesh: wtBeacon, phase: 1.5, color: PAD_COLORS.beaconRed });

    return { root, beacons };
}

// ── Mechazilla / Stage 0 (Starship) ──────────────────────────────────────────

function buildMechazilla() {
    const root = new THREE.Group();
    root.name = 'Mechazilla';
    const beacons = [];

    // Boca Chica: sandy ground, big concrete OLM apron in the middle.
    root.add(buildGroundPlane({
        size: 360, padSize: 70, padColor: PAD_COLORS.concrete,
    }));

    // Orbital Launch Mount (OLM) — 6-legged hexagonal table the booster
    // sits on. Real OLM legs are ~20 m tall.
    const olmH = 20;
    const olmRingR = 9;        // hexagonal table outer radius
    const olm = new THREE.Group();
    // 6 legs
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        const leg = new THREE.Mesh(
            new THREE.CylinderGeometry(0.7, 0.9, olmH, 12),
            flatMat(PAD_COLORS.fssOrange, 0.7, 0.15)
        );
        leg.position.set(Math.cos(a) * (olmRingR - 1.2), olmH / 2, Math.sin(a) * (olmRingR - 1.2));
        leg.castShadow = true;
        leg.receiveShadow = true;
        olm.add(leg);
    }
    // Hexagonal table top (with a hole in the middle for booster engine plume)
    const tableShape = new THREE.Shape();
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const x = Math.cos(a) * olmRingR;
        const z = Math.sin(a) * olmRingR;
        if (i === 0) tableShape.moveTo(x, z); else tableShape.lineTo(x, z);
    }
    tableShape.closePath();
    const hole = new THREE.Path();
    hole.absarc(0, 0, 4.0, 0, Math.PI * 2, true);
    tableShape.holes.push(hole);
    const tableGeo = new THREE.ExtrudeGeometry(tableShape, { depth: 1.4, bevelEnabled: false });
    const table = new THREE.Mesh(tableGeo, flatMat(PAD_COLORS.fssOrange, 0.7, 0.15));
    table.rotation.x = -Math.PI / 2;
    table.position.y = olmH;
    table.castShadow = true;
    table.receiveShadow = true;
    olm.add(table);

    // Hold-down clamps — 20 small posts around the inner ring of the table.
    for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2;
        const clamp = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 0.7, 0.5),
            steelMat(PAD_COLORS.steelDark, 0.5, 0.5)
        );
        clamp.position.set(Math.cos(a) * 4.6, olmH + 1.7, Math.sin(a) * 4.6);
        clamp.castShadow = true;
        olm.add(clamp);
    }

    // Cross-bracing between OLM legs (X-pattern)
    const braceMat = flatMat(PAD_COLORS.fssOrange, 0.7, 0.15);
    for (let i = 0; i < 6; i++) {
        const a0 = (i / 6) * Math.PI * 2 + Math.PI / 6;
        const a1 = ((i + 1) / 6) * Math.PI * 2 + Math.PI / 6;
        const r = olmRingR - 1.2;
        const v0 = new THREE.Vector3(Math.cos(a0) * r, 4, Math.sin(a0) * r);
        const v1 = new THREE.Vector3(Math.cos(a1) * r, 16, Math.sin(a1) * r);
        const v2 = new THREE.Vector3(Math.cos(a0) * r, 16, Math.sin(a0) * r);
        const v3 = new THREE.Vector3(Math.cos(a1) * r, 4, Math.sin(a1) * r);
        for (const [p0, p1] of [[v0, v1], [v2, v3]]) {
            const len = p0.distanceTo(p1);
            const beam = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, len), braceMat);
            beam.position.copy(p0).lerp(p1, 0.5);
            beam.lookAt(p1);
            beam.castShadow = true;
            olm.add(beam);
        }
    }

    olm.position.y = 0;
    root.add(olm);

    // Water deluge plate — flat steel plate at the base under the OLM.
    const deluge = new THREE.Mesh(
        new THREE.CylinderGeometry(7, 7, 0.5, 32),
        flatMat(PAD_COLORS.steel, 0.4, 0.6)
    );
    deluge.position.y = 0.25;
    deluge.receiveShadow = true;
    root.add(deluge);

    // Mechazilla integration tower — square lattice tower on the +X side,
    // Z-aligned so the chopstick arms reach toward the stack at origin.
    const mtH = 145;             // real OLIT is ~146 m
    const towerX = -16;          // tower offset; chopsticks extend toward +X
    const tower = buildLatticeTower({
        height: mtH, footprint: 8, color: PAD_COLORS.fssOrange, bandStep: 9,
    });
    tower.position.set(towerX, 0, 0);
    root.add(tower);

    // Chopstick arms (Mechazilla) — 2 horizontal yellow arms reaching from
    // the tower toward the stack at ~booster-catch height (~80 m).
    const armColor = PAD_COLORS.chopstickYellow;
    const armMat = flatMat(armColor, 0.55, 0.2);
    function buildChopstickArm(z) {
        const arm = new THREE.Group();
        // Spine — long box from hinge outboard
        const spine = new THREE.Mesh(new THREE.BoxGeometry(20, 1.2, 1.8), armMat);
        spine.position.set(10, 0, 0);
        spine.castShadow = true;
        arm.add(spine);
        // Pincer pad at the tip
        const pad = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.6, 4.5), armMat);
        pad.position.set(19.5, 0, 0);
        pad.castShadow = true;
        arm.add(pad);
        // Hinge box at the tower side
        const hinge = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.5, 2.5), armMat);
        hinge.position.set(0.5, 0, 0);
        hinge.castShadow = true;
        arm.add(hinge);
        // Z-axis offset (one arm in -Z, other in +Z)
        arm.position.set(towerX + 4, 80, z);
        return arm;
    }
    root.add(buildChopstickArm(-3.5));
    root.add(buildChopstickArm( 3.5));

    // Quick-Disconnect (QD) arm — slimmer arm at ship hot-stage-ring height
    // (~95 m) for ship fuel/electrical umbilicals. Drawn slightly retracted.
    const qd = new THREE.Group();
    const qdSpine = new THREE.Mesh(new THREE.BoxGeometry(14, 1.0, 1.4), armMat);
    qdSpine.position.set(7, 0, 0);
    qdSpine.castShadow = true;
    qd.add(qdSpine);
    const qdHead = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.4, 2.2), armMat);
    qdHead.position.set(13.5, 0, 0);
    qdHead.castShadow = true;
    qd.add(qdHead);
    qd.position.set(towerX + 4, 95, 0);
    qd.rotation.y = -0.18;       // partially swung away
    root.add(qd);

    // Lightning rods — 4 thin spikes on top of the tower
    for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const rod = new THREE.Mesh(
            new THREE.CylinderGeometry(0.10, 0.10, 18, 10),
            steelMat(PAD_COLORS.steelDark, 0.4, 0.7)
        );
        rod.position.set(towerX + Math.cos(a) * 3, mtH + 9, Math.sin(a) * 3);
        rod.castShadow = true;
        root.add(rod);
    }

    // Propellant farm — 4 vertical cryo tanks NW of the OLM. Real Stage 0
    // has many more (subcoolers, vents, etc.), but a quartet reads cleanly.
    function buildCryoTank({ height, radius, color }) {
        const g = new THREE.Group();
        const body = new THREE.Mesh(
            new THREE.CylinderGeometry(radius, radius, height, 28),
            flatMat(color, 0.55, 0.1)
        );
        body.position.y = height / 2 + 1.2;
        body.castShadow = true;
        body.receiveShadow = true;
        g.add(body);
        // Domed top + bottom
        const dome = new THREE.Mesh(
            new THREE.SphereGeometry(radius, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2),
            flatMat(color, 0.55, 0.1)
        );
        dome.position.y = height + 1.2;
        dome.castShadow = true;
        g.add(dome);
        const dome2 = new THREE.Mesh(
            new THREE.SphereGeometry(radius, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2),
            flatMat(color, 0.55, 0.1)
        );
        dome2.position.y = 1.2;
        dome2.rotation.x = Math.PI;
        dome2.castShadow = true;
        g.add(dome2);
        // Slim support stand
        const stand = new THREE.Mesh(
            new THREE.CylinderGeometry(radius * 0.4, radius * 0.5, 1.4, 12),
            flatMat(PAD_COLORS.steelDark, 0.7)
        );
        stand.position.y = 0.7;
        stand.castShadow = true;
        g.add(stand);
        return g;
    }

    const tankSpecs = [
        { x: 50,  z: -25, h: 24, r: 5, c: PAD_COLORS.tankWhite },     // LOX (largest)
        { x: 60,  z:  -8, h: 22, r: 4.5, c: PAD_COLORS.tankWhite },   // CH4
        { x: 50,  z:  18, h: 18, r: 4, c: PAD_COLORS.tankWhite },     // LN2
        { x: 38,  z:  35, h: 14, r: 3.2, c: PAD_COLORS.tankWhite },   // helium
    ];
    for (const s of tankSpecs) {
        const tank = buildCryoTank({ height: s.h, radius: s.r, color: s.c });
        tank.position.set(s.x, 0, s.z);
        root.add(tank);

        // Each tank gets a small red beacon at its dome.
        const tb = buildBeacon({ color: PAD_COLORS.beaconRed, intensity: 1.5 });
        tb.position.set(s.x, s.h + 2.5, s.z);
        tb.scale.setScalar(0.6);
        root.add(tb);
        beacons.push({ mesh: tb, phase: Math.random() * Math.PI * 2, color: PAD_COLORS.beaconRed });
    }

    // Tower-top + tower-mid aviation beacons (red, blinking out of phase).
    const topBeacon = buildBeacon({ color: PAD_COLORS.beaconRed, intensity: 2.5 });
    topBeacon.position.set(towerX, mtH + 4, 0);
    topBeacon.scale.setScalar(1.2);
    root.add(topBeacon);
    beacons.push({ mesh: topBeacon, phase: 0, color: PAD_COLORS.beaconRed });

    const midBeacon = buildBeacon({ color: PAD_COLORS.beaconWhite, intensity: 1.6 });
    midBeacon.position.set(towerX, mtH * 0.5, 4.5);
    root.add(midBeacon);
    beacons.push({ mesh: midBeacon, phase: 1.0, color: PAD_COLORS.beaconWhite });

    // Perimeter floodlights — taller than LC-39A's; Boca Chica uses
    // tall poles around the launch table.
    for (const [x, z] of [[-40, 40], [40, -40], [-40, -30], [55, 35], [25, -55]]) {
        const fl = buildFloodlight({ height: 22 });
        fl.position.set(x, 0, z);
        root.add(fl);
    }

    return { root, beacons };
}

// ── Generic pad (fallback) ───────────────────────────────────────────────────

function buildGenericPad() {
    const root = new THREE.Group();
    root.name = 'GenericPad';
    const beacons = [];

    root.add(buildGroundPlane({ size: 240, padSize: 50 }));

    const mlp = new THREE.Mesh(
        new THREE.BoxGeometry(34, 1.4, 34),
        flatMat(PAD_COLORS.concrete, 0.95)
    );
    mlp.position.y = 0.7;
    mlp.castShadow = true;
    mlp.receiveShadow = true;
    root.add(mlp);

    const trench = new THREE.Mesh(
        new THREE.BoxGeometry(8, 1.6, 4),
        new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    trench.position.y = 0.7;
    root.add(trench);

    const tower = buildLatticeTower({ height: 80, footprint: 7, color: PAD_COLORS.fssOrange });
    tower.position.set(-22, 1.4, 0);
    root.add(tower);

    const beacon = buildBeacon({ color: PAD_COLORS.beaconRed });
    beacon.position.set(-22, 84, 0);
    root.add(beacon);
    beacons.push({ mesh: beacon, phase: 0, color: PAD_COLORS.beaconRed });

    return { root, beacons };
}

// ── Public dispatcher ────────────────────────────────────────────────────────

const PAD_BUILDERS = {
    lc39a:      buildLC39A,
    mechazilla: buildMechazilla,
    generic:    buildGenericPad,
};

export function buildPad(id = 'generic') {
    const builder = PAD_BUILDERS[id] || PAD_BUILDERS.generic;
    return builder();
}

// Animate beacons — call from the framework's tick loop with current time t
// (seconds). Each beacon pulses every ~2 s (0.5 Hz) with its own phase.
export function tickBeacons(beacons, t) {
    if (!beacons || !beacons.length) return;
    for (const b of beacons) {
        if (!b.mesh.material) continue;
        const v = (Math.sin(t * Math.PI + b.phase) + 1) * 0.5;     // 0..1
        const lit = v > 0.85 ? 1 : 0.05;                           // crisp blink
        b.mesh.material.emissiveIntensity = 0.3 + lit * 2.5;
        b.mesh.scale.setScalar(0.85 + lit * 0.6);
    }
}
