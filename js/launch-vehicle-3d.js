/**
 * launch-vehicle-3d.js — High-fidelity procedural 3D launch vehicle canvas.
 *
 * Renders a generic stack — currently the Space Shuttle Transportation System
 * (orbiter + external tank + 2 SRBs + pad) — built entirely from THREE
 * primitives so we don't depend on any external GLB/OBJ asset. Intended as a
 * placeholder until we secure permission to use operator-supplied vehicle
 * models.
 *
 * Approximately to-scale (1 unit ≈ 1 m):
 *   External Tank   46.9 m × 8.4 m diameter
 *   SRB             45.5 m × 3.7 m diameter (×2)
 *   Orbiter         37.2 m × 23.8 m wingspan, 17.3 m tail height
 *
 * Visual features beyond the stack itself:
 *   · 3-point studio lighting + hemisphere fill, soft PCF shadows
 *   · Atmospheric horizon-gradient sky (canvas-generated background)
 *   · Twinkling starfield (custom point shader, time-driven)
 *   · Engine plume — three layered additive cones, animated flicker
 *   · Subtle bloom-like halo via emissive + tone-mapped HDR exposure
 *   · IntersectionObserver pauses the loop when off-screen
 *   · Camera presets (front · side · top · 3-quarter) with smooth tween
 *
 * Public API:
 *   initVehicleCanvas(canvas, opts) →
 *     { dispose, setView, setAutoRotate, setPlume, setPad }
 *
 * `setVehicle()` is reserved for v2 — only the shuttle is implemented today.
 */

import * as THREE from 'three';
import { buildStarship } from './launch-vehicle-starship.js';
import { buildFalcon9 } from './launch-vehicle-falcon9.js';
import { buildPad as buildPadInfra, tickBeacons } from './launch-pad-3d.js';
import { createMissionClock } from './launch-mission-clock.js';
import { ENGINES } from './launch-engines.js';
import { buildThrustOverlay, tickThrustOverlay } from './launch-thrust-overlay.js';
import { buildPlume as buildPlumeShared, tickPlume } from './launch-plume.js';
import { buildEngineBell, buildTankDomeFittings } from './launch-engine-bell.js';

// ── Constants ────────────────────────────────────────────────────────────────

const COLORS = {
    foam:        0xb95f24,   // ET unpainted post-STS-3 foam
    foamDark:    0x8a4516,
    foamLight:   0xd47b3a,
    srbWhite:    0xece8de,
    srbAft:      0x9c9c92,
    srbRing:     0xb6b3a8,
    orbiterWhite:0xf4f1e8,
    tile:        0x141418,
    tileBack:    0x1f1f24,
    cockpit:     0x121723,
    cockpitGlow: 0x88aaff,
    metalDark:   0x4a4a52,
    metalBright: 0x8c8c92,
    nozzle:      0x2c2c30,
    nozzleHot:   0x6a4f30,
    plumeCore:   0xfff5d8,
    plumeMid:    0xffaa44,
    plumeOuter:  0x6a3a18,
    pad:         0x1a1a22,
    tower:       0xcc5022,   // pad gantry orange
    horizon:     0x1a1428,
    deepSpace:   0x02010a,
};

const DIM = {
    ET_LEN:        46.9,
    ET_R:           4.2,
    SRB_LEN:       45.5,
    SRB_R:          1.85,
    ORBITER_LEN:   37.2,
    ORBITER_FUSE_R: 2.4,
    WING_HALF:     11.9,    // wing half-span
    TAIL_H:         5.5,    // vertical-stab height
};

// ── Material factory ─────────────────────────────────────────────────────────

function mkMat(color, opts = {}) {
    return new THREE.MeshStandardMaterial({
        color,
        roughness: opts.roughness ?? 0.62,
        metalness: opts.metalness ?? 0.04,
        emissive:  opts.emissive  ?? 0x000000,
        emissiveIntensity: opts.emissiveIntensity ?? 0.0,
        flatShading: opts.flatShading ?? false,
    });
}

function mkPhys(color, opts = {}) {
    return new THREE.MeshPhysicalMaterial({
        color,
        roughness: opts.roughness ?? 0.4,
        metalness: opts.metalness ?? 0.0,
        clearcoat: opts.clearcoat ?? 0.3,
        clearcoatRoughness: opts.clearcoatRoughness ?? 0.3,
    });
}

// ── External Tank ────────────────────────────────────────────────────────────
// LH2 (lower) tank + intertank ribbed band + LO2 (upper) tank + ogive nose.
// Built as a single Lathe profile so the cross-section is naturally smooth.

function buildExternalTank() {
    const g = new THREE.Group();
    g.name = 'ExternalTank';

    const L = DIM.ET_LEN;
    const R = DIM.ET_R;

    // Profile from base (y=0) to nose (y=L). Slight diameter changes mark the
    // LH2 / intertank / LO2 boundaries; the ogive nose curves from R to 0.
    const pts = [
        new THREE.Vector2(0,           0),
        new THREE.Vector2(R * 0.92,    0),
        new THREE.Vector2(R,           L * 0.02),     // base dome curve
        new THREE.Vector2(R,           L * 0.55),     // top of LH2 tank
        new THREE.Vector2(R * 1.005,   L * 0.57),     // intertank flange
        new THREE.Vector2(R * 1.005,   L * 0.65),
        new THREE.Vector2(R,           L * 0.67),     // bottom of LO2 tank
        new THREE.Vector2(R,           L * 0.86),     // top of LO2 tank cylinder
        new THREE.Vector2(R * 0.95,    L * 0.89),     // ogive transition
        new THREE.Vector2(R * 0.78,    L * 0.93),
        new THREE.Vector2(R * 0.5,     L * 0.97),
        new THREE.Vector2(R * 0.22,    L * 0.99),
        new THREE.Vector2(0,           L),
    ];

    const tank = new THREE.Mesh(
        new THREE.LatheGeometry(pts, 64),
        mkMat(COLORS.foam, { roughness: 0.92 })
    );
    tank.castShadow = true;
    tank.receiveShadow = true;
    g.add(tank);

    // Intertank ribs — vertical stringers around the band region. Cheap
    // detail that sells the ET silhouette.
    const ribGeo = new THREE.BoxGeometry(0.18, L * 0.085, 0.18);
    const ribMat = mkMat(COLORS.foamDark, { roughness: 0.95 });
    for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const rib = new THREE.Mesh(ribGeo, ribMat);
        rib.position.set(Math.cos(a) * R * 1.012, L * 0.605, Math.sin(a) * R * 1.012);
        rib.rotation.y = -a;
        rib.castShadow = true;
        g.add(rib);
    }

    // Cable tray — runs full length of the ET on the orbiter side (+Z).
    const trayGeo = new THREE.BoxGeometry(0.7, L * 0.95, 0.22);
    const tray = new THREE.Mesh(trayGeo, mkMat(COLORS.foamDark, { roughness: 0.85 }));
    tray.position.set(0, L * 0.5, R * 1.01);
    tray.castShadow = true;
    g.add(tray);

    // LO2 feedline — runs along the orbiter side, from the intertank up to
    // the LO2 dome. A thin pipe with two elbow boxes selling the routing.
    const feedGeo = new THREE.CylinderGeometry(0.18, 0.18, L * 0.32, 16);
    const feedMat = mkMat(COLORS.foamLight, { roughness: 0.7 });
    const feed = new THREE.Mesh(feedGeo, feedMat);
    feed.position.set(0.6, L * 0.78, R * 1.04);
    feed.castShadow = true;
    g.add(feed);

    // LH2 aft-dome fittings — small central sump, anti-vortex baffle, and
    // the big 17" LH2 feedline outlet that exits on the orbiter side (+Z).
    // The ET's main lathe profile already builds the dome shell; we add
    // just the hardware that hangs off its underside. A smaller pressur-
    // ization-vent stub sits opposite the feedline outlet (−Z side).
    //
    // surfaceY = 0.02 so fittings sit just below the dome lip rather than
    // z-fighting with the lathe at exactly y=0.
    const aftDome = buildTankDomeFittings({
        domeRadius: R * 0.9,
        sumpR:      0.08,                       // small central LH2 outlet
        sumpH:      0.10,
        baffle:     true,
        asymmetricFeed: {
            angle:   Math.PI / 2,               // +Z: orbiter side
            radial:  0.55,                      // 55% of dome radius from axis
            sizeMul: 1.8,                       // 17" feedline is conspicuously fat
        },
        pressurizationPort: {
            angle:   -Math.PI / 2,              // -Z: opposite the feedline
            radial:  0.6,
        },
        surfaceY: () => 0.02,
    });
    g.add(aftDome);

    return g;
}

// ── Solid Rocket Booster ─────────────────────────────────────────────────────
// 5-segment casing + ogive nose cone + aft skirt with attach struts. Joint
// rings highlight the segment seams the way they do on the real article.

function buildSRB() {
    const g = new THREE.Group();
    g.name = 'SRB';

    const L = DIM.SRB_LEN;
    const R = DIM.SRB_R;

    // Casing — single lathe with a slight aft skirt flare and ogive nose.
    const pts = [
        new THREE.Vector2(0,           0),
        new THREE.Vector2(R * 1.18,    0),
        new THREE.Vector2(R * 1.18,    L * 0.025),
        new THREE.Vector2(R,           L * 0.05),
        new THREE.Vector2(R,           L * 0.85),
        new THREE.Vector2(R * 0.92,    L * 0.89),
        new THREE.Vector2(R * 0.7,     L * 0.93),
        new THREE.Vector2(R * 0.4,     L * 0.97),
        new THREE.Vector2(0,           L),
    ];
    const casing = new THREE.Mesh(
        new THREE.LatheGeometry(pts, 36),
        mkMat(COLORS.srbWhite, { roughness: 0.55 })
    );
    casing.castShadow = true;
    casing.receiveShadow = true;
    g.add(casing);

    // Segment joint rings (4 rings dividing the cylindrical body into 5 segs).
    const ringMat = mkMat(COLORS.srbRing, { roughness: 0.5, metalness: 0.2 });
    for (let i = 1; i <= 4; i++) {
        const ring = new THREE.Mesh(
            new THREE.TorusGeometry(R * 1.005, 0.075, 10, 36),
            ringMat
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.y = L * (0.05 + i * 0.16);
        ring.castShadow = true;
        g.add(ring);
    }

    // Aft skirt detail: 3 attach struts protruding from the base (truncated
    // boxes). Visual only — they're meant to read as the hold-down posts.
    const strutMat = mkMat(COLORS.metalDark, { roughness: 0.4, metalness: 0.6 });
    for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
        const strut = new THREE.Mesh(
            new THREE.BoxGeometry(0.6, 0.8, 0.6),
            strutMat
        );
        strut.position.set(Math.cos(a) * R * 1.18, 0.4, Math.sin(a) * R * 1.18);
        strut.castShadow = true;
        g.add(strut);
    }

    // Forward frustum + parachute compartment — short cylindrical section
    // just below the nose cone, slightly wider than the casing, painted
    // gray to differentiate from the white casing. Real SRB has this band
    // recovering the recovery-system parachutes.
    const frustum = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 1.02, R * 1.02, 1.6, 32, 1, true),
        mkMat(COLORS.srbAft, { roughness: 0.55 })
    );
    frustum.position.y = L * 0.86;
    g.add(frustum);

    // SRB nozzle — exposed bell at the very base. RSRM uses an ablative-
    // cooled conical nozzle (no regen-cooling tubes) but does have a flex-
    // bearing gimbal for thrust vectoring. Shared builder handles both.
    const nozzle = buildEngineBell({
        type:     'rsrm',
        throatR:  R * 0.55,
        exitR:    R * 0.95,
        length:   1.6,
        detail:   'high',     // SRBs are big and prominent on the silhouette
    });
    g.add(nozzle);

    return g;
}

// ── Orbiter ──────────────────────────────────────────────────────────────────
// Lathe fuselage with non-trivial profile, double-delta wings extruded from a
// 2D shape, swept vertical stabilizer, OMS pods, body flap, and a 3-bell SSME
// cluster at the aft. Black thermal-tile underside is a curved overlay shell.

function buildOrbiter() {
    const g = new THREE.Group();
    g.name = 'Orbiter';

    const L = DIM.ORBITER_LEN;
    const R = DIM.ORBITER_FUSE_R;

    // Fuselage profile — half-cylinder then taper to nose. Origin centered
    // along Y (tail at -L/2, nose at +L/2). Slight nose droop is added later
    // by displacing the nose forward (+Z) a touch.
    const fusePts = [
        new THREE.Vector2(0,             -L * 0.50),
        new THREE.Vector2(R * 1.05,      -L * 0.46),
        new THREE.Vector2(R * 1.10,      -L * 0.40),
        new THREE.Vector2(R * 1.05,      -L * 0.20),
        new THREE.Vector2(R * 1.00,       0.0),
        new THREE.Vector2(R * 0.96,       L * 0.20),
        new THREE.Vector2(R * 0.85,       L * 0.32),
        new THREE.Vector2(R * 0.62,       L * 0.40),
        new THREE.Vector2(R * 0.32,       L * 0.46),
        new THREE.Vector2(R * 0.10,       L * 0.49),
        new THREE.Vector2(0,              L * 0.50),
    ];
    const fuselage = new THREE.Mesh(
        new THREE.LatheGeometry(fusePts, 32),
        mkPhys(COLORS.orbiterWhite, { roughness: 0.55, clearcoat: 0.25 })
    );
    fuselage.castShadow = true;
    fuselage.receiveShadow = true;
    g.add(fuselage);

    // Black thermal-tile belly — half-shell on the −Z side (the side facing
    // the ET when stacked, and the side that takes the brunt of reentry
    // heating when flying belly-first). Open arc spans ~140° of the
    // underside, centered on theta = 3π/2 (the −Z direction in CylinderGeometry).
    const bellyArc = 1.55 * Math.PI / 2;
    const bellyMat = mkMat(COLORS.tile, { roughness: 0.95 });
    for (let yFrac = -0.45; yFrac <= 0.45 - 0.001; yFrac += 0.18) {
        const seg = new THREE.Mesh(
            new THREE.CylinderGeometry(R * 1.06, R * 1.06, L * 0.18, 48, 1, true,
                                       3 * Math.PI / 2 - bellyArc / 2, bellyArc),
            bellyMat
        );
        seg.position.y = (yFrac + 0.09) * L;
        seg.castShadow = true;
        g.add(seg);
    }

    // Cockpit hump + windows. Hump: clipped sphere on the +Z (back) side near
    // the nose. Sphere is rotated so its dome curves +Z (up out of fuselage)
    // with the flat opening at -Z; we sit it just above the fuselage spine
    // (z = R*0.85, fuselage radius at this Y is ~R*0.85 along the lathe
    // taper) so the opening hides flush against the spine instead of cutting
    // a seam through the body 1 m below the surface.
    const cockpitR = R * 0.95;
    const cockpit = new THREE.Mesh(
        new THREE.SphereGeometry(cockpitR, 32, 18, 0, Math.PI * 2, 0, Math.PI * 0.55),
        mkMat(COLORS.orbiterWhite, { roughness: 0.5 })
    );
    const cockpitY = L * 0.31;
    cockpit.position.set(0, cockpitY, R * 0.85);
    cockpit.rotation.x = Math.PI / 2;
    cockpit.castShadow = true;
    g.add(cockpit);

    const winMat = new THREE.MeshPhysicalMaterial({
        color: COLORS.cockpit,
        roughness: 0.05,
        metalness: 0.0,
        transmission: 0.0,
        emissive: COLORS.cockpitGlow,
        emissiveIntensity: 0.18,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
    });
    // 6 forward windows in two rows of three. Each window sits on the
    // dome's forward-facing surface — z derived from the sphere equation so
    // the panes follow the dome's curve regardless of where we mounted the
    // hump.
    const winGeo = new THREE.BoxGeometry(0.8, 0.55, 0.2);
    for (let row = 0; row < 2; row++) {
        for (let col = -1; col <= 1; col++) {
            const w = new THREE.Mesh(winGeo, winMat);
            const yOff = cockpitY + 0.55 + row * 0.6;
            const xOff = col * 0.95;
            const yFromDome = yOff - cockpitY;
            const zOnDome   = Math.sqrt(
                Math.max(0, cockpitR * cockpitR - yFromDome * yFromDome - xOff * xOff)
            );
            const zPos = R * 0.85 + zOnDome - 0.08;
            w.position.set(xOff, yOff, zPos);
            w.rotation.x = -0.32;          // slight forward rake
            g.add(w);
        }
    }

    // Wings — double-delta planform. Defined as a 2D shape in (X-outboard, Y-fwd)
    // and extruded a small depth for thickness.
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0,    6.0);     // glove leading edge near root
    wingShape.lineTo(2.4,  3.5);     // glove break
    wingShape.lineTo(DIM.WING_HALF, -7.5);   // main-wing leading edge to tip
    wingShape.lineTo(DIM.WING_HALF, -9.0);   // tip chord
    wingShape.lineTo(8.0,           -10.5);
    wingShape.lineTo(0,             -10.5);  // trailing-edge root
    wingShape.lineTo(0,              6.0);

    const wingGeo = new THREE.ExtrudeGeometry(wingShape, {
        depth: 0.6,
        bevelEnabled: true,
        bevelThickness: 0.18,
        bevelSize: 0.18,
        bevelSegments: 2,
    });
    const wingMat = mkPhys(COLORS.orbiterWhite, { roughness: 0.55, clearcoat: 0.15 });
    for (const xSign of [-1, 1]) {
        const wing = new THREE.Mesh(wingGeo, wingMat);
        // Shape lives in XY (x=outboard, y=fwd-aft) extruded in Z (thickness).
        // That already matches our world axes — no rotation needed; just
        // mirror around the orbiter centerline for the port wing.
        wing.scale.x = xSign;
        // Sink the wing slightly below the centerline so it visually sits
        // at the orbiter belly rather than threading through the spine.
        wing.position.set(0, 0, -R * 0.35);
        wing.castShadow = true;
        wing.receiveShadow = true;
        g.add(wing);

        // Black wing leading-edge "RCC" stripe — thin tube traced along the
        // glove + main-wing leading edges for visual contrast.
        const lePts = [
            new THREE.Vector3(0,                                     6.0,  -R * 0.35),
            new THREE.Vector3(2.4 * xSign,                           3.5,  -R * 0.35),
            new THREE.Vector3(DIM.WING_HALF * xSign,                -7.5,  -R * 0.35),
        ];
        const leGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(lePts), 16, 0.14, 6, false);
        const leMesh = new THREE.Mesh(leGeo, mkMat(COLORS.tile, { roughness: 0.7 }));
        leMesh.castShadow = true;
        g.add(leMesh);
    }

    // Vertical stabilizer — swept fin in the YZ plane, root at orbiter top.
    const tailShape = new THREE.Shape();
    tailShape.moveTo(0,            0);
    tailShape.lineTo(2.5,          DIM.TAIL_H);
    tailShape.lineTo(4.5,          DIM.TAIL_H);
    tailShape.lineTo(6.0,          0.5);
    tailShape.lineTo(6.0,          0);
    tailShape.lineTo(0,            0);
    const tailGeo = new THREE.ExtrudeGeometry(tailShape, {
        depth: 0.35,
        bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 1,
    });
    const tail = new THREE.Mesh(tailGeo, wingMat);
    // Map shape (chord-x, height-y, thickness-z) → world (chord=Y, height=Z, thickness=X)
    // so the fin's plane sits in YZ, extending outward in +Z from the orbiter spine.
    tail.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    tail.position.set(0, -L * 0.45, R * 0.85);
    tail.castShadow = true;
    g.add(tail);

    // OMS pods — twin elongated bumps at the aft top, flanking the SSMEs.
    // Each pod gets a small black aft thruster cap so the silhouette reads
    // as the real OMS/RCS bays rather than a smooth blob.
    for (const xSign of [-1, 1]) {
        const oms = new THREE.Mesh(
            new THREE.CapsuleGeometry(0.85, 3.4, 8, 16),
            mkMat(COLORS.orbiterWhite, { roughness: 0.5 })
        );
        oms.rotation.x = Math.PI / 2;
        oms.position.set(xSign * 1.7, -L * 0.40, R * 0.5);
        oms.castShadow = true;
        g.add(oms);

        const omsCap = new THREE.Mesh(
            new THREE.CylinderGeometry(0.55, 0.7, 0.5, 14),
            mkMat(COLORS.tile, { roughness: 0.85 })
        );
        omsCap.rotation.x = Math.PI / 2;
        omsCap.position.set(xSign * 1.7, -L * 0.46 + 0.3, R * 0.5);
        omsCap.castShadow = true;
        g.add(omsCap);
    }

    // Aft thermal-blanket band — distinctive dark band wrapping the orbiter
    // aft just forward of the SSME cluster. Sells the silhouette as the
    // real STS rather than a generic white-fuselage.
    const aftBand = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 1.025, R * 1.025, 1.6, 48, 1, true),
        mkMat(COLORS.tile, { roughness: 0.9 })
    );
    aftBand.position.y = -L * 0.43;
    aftBand.castShadow = true;
    g.add(aftBand);

    // Body flap — fence-like control surface hanging BELOW the SSMEs on the
    // belly side. Position it just outside the fuselage radius (z=-R-0.05)
    // so it actually reads as a flap, not as a slab buried in the spine.
    const bodyFlap = new THREE.Mesh(
        new THREE.BoxGeometry(R * 1.6, 0.4, 1.7),
        mkMat(COLORS.tile, { roughness: 0.85 })
    );
    bodyFlap.position.set(0, -L * 0.46 - 1.2, -R * 0.4);
    bodyFlap.rotation.x = -0.18;     // slight nose-up angle, neutral trim
    bodyFlap.castShadow = true;
    g.add(bodyFlap);

    // Forward RCS module — black thruster ports on the orbiter nose belly
    // (real shuttle has 14 thrusters in the FRCS). Render as 4 small dark
    // squares for the silhouette.
    for (const dx of [-0.55, -0.18, 0.18, 0.55]) {
        const port = new THREE.Mesh(
            new THREE.BoxGeometry(0.22, 0.12, 0.22),
            mkMat(COLORS.tile, { roughness: 0.95 })
        );
        port.position.set(dx, L * 0.43, -R * 0.78);
        g.add(port);
    }

    // SSMEs — 3 bell-shaped engines, 1 high-center + 2 lower flanking.
    const ssmePositions = [
        [ 0,    -L * 0.46 + 0.6,  -0.3],
        [-1.2,  -L * 0.46 - 0.4,  -0.3],
        [ 1.2,  -L * 0.46 - 0.4,  -0.3],
    ];
    for (const [dx, dy, dz] of ssmePositions) {
        const ssme = buildSSME();
        ssme.position.set(dx, dy, dz);
        ssme.userData.kind = 'ssme';
        g.add(ssme);
    }

    return g;
}

// ── SSME (Space Shuttle Main Engine) ─────────────────────────────────────────
// Full detail RS-25: Rao-profile bell, 24 regen-cooling tubes wrapping the
// outside, gimbal mount with hydraulic actuators, and the powerhead /
// turbopump block above the throat. Shared builder in launch-engine-bell.js.

function buildSSME() {
    return buildEngineBell({ type: 'rs25', detail: 'high' });
}

// ── Engine plume ────────────────────────────────────────────────────────────
// Wraps the shared plume builder with shuttle-flavored colors. See
// js/launch-plume.js for the shock-diamond + bell-flare implementation.

function buildPlume() {
    return buildPlumeShared({
        coreRadius:  0.4, coreLen:  18,
        midRadius:   0.8, midLen:   26,
        outerRadius: 1.4, outerLen: 36,
        coreColor:  COLORS.plumeCore,
        midColor:   COLORS.plumeMid,
        outerColor: COLORS.plumeOuter,
        name: 'Plume',
    });
}

// ── Ascent trail (pad-anchored exhaust column) ───────────────────────────────
// Vertical additive cylinder with a procedurally-painted vertical gradient.
// Anchored to the pad in world space so the trail rises straight up regardless
// of how the rocket pitches and rolls — produces the iconic "smoke pillar
// while the vehicle arcs over" silhouette real ascents have.

function buildAscentTrail() {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 256;
    const ctx = c.getContext('2d');
    // Gradient: bright hot top → cooling middle → transparent bottom.
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0.00, 'rgba(255,230,170,0.95)');
    g.addColorStop(0.15, 'rgba(255,170, 80,0.70)');
    g.addColorStop(0.55, 'rgba(220,150, 90,0.35)');
    g.addColorStop(1.00, 'rgba(140, 90, 60,0.00)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 16, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;

    // Tapered cylinder — bottom radius 1.6× top so the column reads like a
    // real exhaust trail: tight under the rocket (recent exhaust), wider
    // and more diffuse near the pad (older, dispersed). Default cylinder
    // geometry's top is at +Y.
    const trail = new THREE.Mesh(
        new THREE.CylinderGeometry(1.0, 1.6, 1, 28, 1, true),
        new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
            fog: false,
        })
    );
    trail.visible = false;
    return trail;
}

// ── Pad steam vents (water deluge) ───────────────────────────────────────────
// Rocket pads suppress acoustic energy at ignition by dumping millions of
// gallons of water through deck nozzles; the result is a curtain of white
// steam clouds boiling off the deck. Modelled as 10 small additive spheres
// scattered around the deck whose scale + opacity grow and fade on a per-
// puff phase, gated to the ignition / early-ascent window.
function buildPadSteam() {
    const g = new THREE.Group();
    g.name = 'PadSteam';
    g.visible = false;

    const N = 10;
    for (let i = 0; i < N; i++) {
        const angle  = (i / N) * Math.PI * 2 + Math.random() * 0.4;
        const radius = 6 + Math.random() * 8;
        const puff = new THREE.Mesh(
            new THREE.SphereGeometry(2.4 + Math.random() * 1.2, 12, 10),
            new THREE.MeshBasicMaterial({
                color: 0xf0f3f8,
                transparent: true,
                opacity: 0.0,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                fog: false,
            })
        );
        puff.position.set(
            Math.cos(angle) * radius,
            0.5 + Math.random() * 0.6,
            Math.sin(angle) * radius,
        );
        puff.userData.phase = Math.random() * Math.PI * 2;
        puff.userData.baseScale = 0.6 + Math.random() * 0.5;
        g.add(puff);
    }
    return g;
}

function tickPadSteam(steam, T, throttle) {
    if (!steam) return;
    // Active from T-3 (ignition spool-up) through T+8 (rocket clear of pad).
    const active = T > -3.2 && T < 8;
    steam.visible = active && throttle > 0.05;
    if (!steam.visible) return;
    // Envelope: rises 0 → 1 over T-3..T-0.5 (ignition surge), holds, then
    // fades 1 → 0 over T+5..T+8 as the rocket climbs out of view of the pad.
    let env;
    if (T < -0.5)      env = (T + 3) / 2.5;
    else if (T < 5)    env = 1;
    else               env = Math.max(0, 1 - (T - 5) / 3);

    steam.children.forEach((puff, i) => {
        const phase = puff.userData.phase;
        const base  = puff.userData.baseScale;
        // Each puff has its own slow grow-and-fade over ~2 s, plus a small
        // jitter on position so the cloud volume looks alive.
        const cycle = 0.5 + 0.5 * Math.sin(T * 1.4 + phase);
        const s = base * (0.6 + 1.6 * cycle) * (0.6 + 0.4 * env);
        puff.scale.setScalar(s);
        puff.material.opacity = 0.65 * cycle * env;
    });
}

// ── Stack assembly ───────────────────────────────────────────────────────────

function buildShuttleStack() {
    const stack = new THREE.Group();
    stack.name = 'STS_stack';

    const et = buildExternalTank();
    stack.add(et);

    const srbOffset = DIM.ET_R + DIM.SRB_R + 0.4;
    for (const xSign of [-1, 1]) {
        const srb = buildSRB();
        srb.position.x = xSign * srbOffset;
        srb.userData.kind = 'srb';
        stack.add(srb);
    }

    // Orbiter — long axis = +Y. Local: belly = -Z, cockpit/back = +Z,
    // wingspan = X. Mounted on +Z side of ET so the belly (-Z) faces the ET
    // and the cockpit (+Z) faces the camera-side viewer. No Y-rotation
    // needed — the local frame already matches the desired world frame.
    const orbiter = buildOrbiter();
    // Raise the orbiter so the SSME bell exits clear the MLP deck (deck top
    // sits at world y=4.2, root.position.y=4.2, so the SSME exit at stack
    // y_local needs to clear y=0). With the previous +0.5 m mount offset
    // the lower bells were sinking ~0.3 m into the deck because the deck
    // flame trench is narrower in Z than the orbiter's engine cluster.
    const orbiterY = DIM.ORBITER_LEN * 0.5 + 1.5;
    orbiter.position.set(0, orbiterY, DIM.ET_R + DIM.ORBITER_FUSE_R + 0.4);
    stack.add(orbiter);

    // Attach hardware bridging the 0.4 m gap between the ET and the orbiter
    // belly + the SRBs. The real shuttle has a forward bipod attaching the
    // orbiter to the ET intertank and two aft struts at the orbiter aft;
    // each SRB has a forward attach strut + aft sway brace. We render
    // simplified cylindrical struts so the orbiter and SRBs visibly mate
    // with the ET instead of floating beside it.
    const strutMat   = mkMat(COLORS.metalDark, { roughness: 0.45, metalness: 0.7 });
    const strutGapZ  = DIM.ET_R + 0.05;                        // strut tail at ET surface
    const strutLenZ  = (DIM.ET_R + DIM.ORBITER_FUSE_R + 0.4) - DIM.ET_R - DIM.ORBITER_FUSE_R; // 0.4
    function addOrbiterAttach(yLocal) {
        const strut = new THREE.Mesh(
            new THREE.CylinderGeometry(0.18, 0.18, 0.55, 12),
            strutMat
        );
        strut.rotation.x = Math.PI / 2;                        // along Z
        strut.position.set(0, yLocal, DIM.ET_R + 0.27);
        strut.castShadow = true;
        stack.add(strut);
    }
    addOrbiterAttach(orbiterY +  6.5);   // forward bipod (ET intertank area)
    addOrbiterAttach(orbiterY - 12);     // aft attach upper
    addOrbiterAttach(orbiterY - 15.5);   // aft attach lower

    // SRB forward + aft attach brackets — small cylindrical fittings between
    // each SRB casing and the ET. Forward attach mid-tank, aft attach near
    // the LH2 base. Mirrored on both SRBs.
    const srbStrutLen = (srbOffset) - DIM.ET_R - DIM.SRB_R; // = 0.4
    function addSRBAttach(xSign, yLocal) {
        const strut = new THREE.Mesh(
            new THREE.CylinderGeometry(0.16, 0.16, srbStrutLen + 0.15, 10),
            strutMat
        );
        strut.rotation.z = Math.PI / 2;                        // along X
        const midX = xSign * (DIM.ET_R + (srbStrutLen / 2));
        strut.position.set(midX, yLocal, 0);
        strut.castShadow = true;
        stack.add(strut);
    }
    for (const s of [-1, 1]) {
        addSRBAttach(s, DIM.ET_LEN * 0.55);   // forward attach (mid-stack)
        addSRBAttach(s, DIM.ET_LEN * 0.10);   // aft attach (lower LH2)
    }

    // Plume — one under each SRB, one under the SSME cluster. Positioned at
    // the bell exits in stack-local space so the cones emerge from the right
    // place on the rocket. Stored on userData so the tick loop can flicker
    // all three together.
    const plumes = [];
    for (const xSign of [-1, 1]) {
        const p = buildPlume();
        p.position.set(xSign * srbOffset, -1.7, 0);
        plumes.push(p);
        stack.add(p);
    }
    // SSME bells exit at orbiter-local y = -L*0.46 - 1.9 ≈ -19.0; with the
    // orbiter mounted at stack-y = L*0.5 + 1.5, that puts the cluster exit at
    // stack-y ≈ 1.0. Place the plume's base just below the bells so the cone
    // emerges from the nozzle exit, not somewhere inside the engine.
    const ssmeP = buildPlume();
    ssmeP.position.set(0, 1.0, DIM.ET_R + DIM.ORBITER_FUSE_R + 0.4);
    plumes.push(ssmeP);
    stack.add(ssmeP);

    stack.userData.plumes = plumes;

    return stack;
}

// ── Sky + starfield ──────────────────────────────────────────────────────────
// Background gradient generated on a 2D canvas → equirectangular texture so
// it works as scene.background. Goes from deep-space top to faint atmospheric
// horizon glow at the bottom.

function buildSkyTexture() {
    const c = document.createElement('canvas');
    c.width = 4; c.height = 512;
    const ctx = c.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0.0,  '#02010a');
    grad.addColorStop(0.45, '#0a0820');
    grad.addColorStop(0.78, '#1a1428');
    grad.addColorStop(0.92, '#2a1c34');
    grad.addColorStop(1.0,  '#3a2640');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 4, 512);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    return tex;
}

// Custom-shader starfield with subtle per-star twinkle.
function buildStarfield() {
    const N = 1500;
    const positions = new Float32Array(N * 3);
    const sizes     = new Float32Array(N);
    const phases    = new Float32Array(N);
    const R = 1500;
    for (let i = 0; i < N; i++) {
        // Bias stars toward the upper hemisphere — looks more like deep
        // space above and an atmospheric glow below.
        const u = Math.random() * 1.6 - 0.6;     // -0.6..1.0
        const t = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.max(0, 1 - u * u));
        positions[i * 3]     = R * r * Math.cos(t);
        positions[i * 3 + 1] = R * u;
        positions[i * 3 + 2] = R * r * Math.sin(t);
        sizes[i]  = Math.random() * 1.6 + 0.6;
        phases[i] = Math.random() * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('size',     new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('phase',    new THREE.BufferAttribute(phases, 1));

    const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 } },
        transparent: true,
        depthWrite: false,
        vertexShader: `
            attribute float size;
            attribute float phase;
            uniform float uTime;
            varying float vAlpha;
            void main() {
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_Position = projectionMatrix * mv;
                float twinkle = 0.55 + 0.45 * sin(uTime * 1.4 + phase * 3.0);
                gl_PointSize = size * twinkle * (300.0 / -mv.z);
                vAlpha = 0.55 + 0.45 * twinkle;
            }
        `,
        fragmentShader: `
            varying float vAlpha;
            void main() {
                vec2 d = gl_PointCoord - vec2(0.5);
                float r = length(d);
                if (r > 0.5) discard;
                float a = smoothstep(0.5, 0.0, r);
                gl_FragColor = vec4(1.0, 0.97, 0.92, a * vAlpha);
            }
        `,
    });
    return new THREE.Points(geo, mat);
}

// ── Camera presets ───────────────────────────────────────────────────────────
// Each preset is a unit-length direction vector from the framing target
// outward to the camera, plus an optional target-Y bias and distance multiplier.
// Distance is computed from the vehicle's actual world-space bounding box
// (so a 56 m shuttle and a 125 m starship are both fit-to-frame), the
// camera FOV, and the canvas aspect — meaning the rocket actually centers
// in the viewport instead of relying on hardcoded fractions.
//
//   targetBias.y  → bbox.center.y + bias * bbox.size.y   (negative aims lower)
//   distMul       → multiply fit-distance for tighter / wider shots

const VIEW_PRESETS = {
    threequarter: { dir: [ 0.62, 0.30,  0.85], biasY:  0.00, distMul: 1.10 },
    front:        { dir: [ 0.00, 0.18,  1.00], biasY:  0.00, distMul: 1.20 },
    side:         { dir: [ 1.00, 0.18,  0.00], biasY:  0.00, distMul: 1.20 },
    top:          { dir: [ 0.00, 1.00,  0.001], biasY:  0.00, distMul: 0.85 },
    // Engines preset — bias the look-at toward the booster base. distMul is
    // a fraction of the full-stack fit-distance; we floor it to a meters
    // value below to stop tall stacks from clipping inside the booster skirt.
    closeup:      { dir: [ 0.55, 0.20,  0.78], biasY: -0.48, distMul: 0.28, distMinM: 14 },
};

// Compute world-space bounding box of just the visible vehicle hardware,
// excluding the engine plume cones (off by default + huge when on) and the
// pad-anchored ascent trail (lives on the scene root).
function computeVehicleBBox(vehicleRoot) {
    vehicleRoot.updateMatrixWorld(true);
    const bbox = new THREE.Box3();
    vehicleRoot.traverse(o => {
        if (!o.isMesh) return;
        // Skip non-rocket helpers so they don't bloat the framing bbox:
        //   Plume         — invisible engine cone, off by default but huge
        //                   when on.
        //   ThrustOverlay — debug arrows that extend ~18 m DOWN from each
        //                   engine. Always added to v.root before bbox is
        //                   computed, and although invisible by default
        //                   their geometry is in the world-bounds traversal.
        //                   Without the skip the Shuttle SRB arrows pushed
        //                   bbox.min.y to ~-16 m, shifting target.y down
        //                   ~13 m and biasing the whole frame toward the
        //                   booster + launch tower.
        let p = o;
        while (p) {
            if (p.name === 'Plume' || p.name === 'ThrustOverlay') return;
            p = p.parent;
        }
        bbox.expandByObject(o);
    });
    return bbox;
}

function frameForView(name, vehicle, fovDeg, aspect) {
    const preset = VIEW_PRESETS[name] || VIEW_PRESETS.threequarter;
    let bbox = vehicle.bbox;
    // Degenerate-bbox guard. An empty Box3 has min=+Inf / max=-Inf; left
    // unchecked it makes halfX/halfZ Infinity → dist Infinity → the camera
    // flies to (Inf,Inf,Inf) and the scene renders as a bare pad/tower with
    // no rocket. A near-zero box collapses dist to the floor and parks the
    // camera at ground level inside the launch-tower lattice. Either way the
    // symptom is "camera defaults to staring at the orange tower". Synthesize
    // a sane box from the vehicle's nominal height so framing is always
    // finite and rocket-centred even if the mesh bbox is missing/degenerate.
    const finiteBox = bbox && !bbox.isEmpty() &&
        Number.isFinite(bbox.min.y) && Number.isFinite(bbox.max.y) &&
        Number.isFinite(bbox.min.x) && Number.isFinite(bbox.max.x) &&
        Number.isFinite(bbox.min.z) && Number.isFinite(bbox.max.z) &&
        (bbox.max.y - bbox.min.y) > 1;
    if (!finiteBox) {
        const h     = Math.max(Number(vehicle.height) || 50, 10);
        const baseY = Number(vehicle.basePadY) || 0;
        const r     = Math.max(h * 0.12, 4);
        bbox = new THREE.Box3(
            new THREE.Vector3(-r, baseY,     -r),
            new THREE.Vector3( r, baseY + h,  r),
        );
    }
    const center = bbox.getCenter(new THREE.Vector3());
    const size   = bbox.getSize(new THREE.Vector3());

    // Look-at locked to the rocket's vertical axis (x=0, z=0) — every vehicle
    // builder anchors its stack at that line. Using bbox.center.x/z instead
    // would aim the camera at the bbox geometric centroid, which for an
    // asymmetric stack (Shuttle: orbiter mounted ~8.5 m to +Z of the ET;
    // anything with a side payload / boattail) sits several meters off the
    // stack axis. The result is a permanently lopsided 3/4 frame where the
    // rocket appears shoved to one side. autoRotate previously hid this by
    // sweeping the camera continuously around the off-axis target.
    const target = new THREE.Vector3(
        0,
        center.y + preset.biasY * size.y,
        0,
    );

    // Fit-distance must use the *radial* extents of the bbox measured from
    // the on-axis target, not bbox.size/2. For an asymmetric stack
    // size.z/2 underestimates how far the bbox actually reaches in +Z away
    // from x=z=0 — the orbiter would clip out of frame. Take the max of the
    // four signed extents per horizontal axis.
    const halfX = Math.max(Math.abs(bbox.max.x), Math.abs(bbox.min.x));
    const halfZ = Math.max(Math.abs(bbox.max.z), Math.abs(bbox.min.z));
    const halfYV = Math.max(size.y, 1) * 0.5 * 1.05;
    const halfH  = Math.max(halfX, halfZ, 1) * 1.05;

    // Fit the larger of vertical extent and horizontal extent (modulated by
    // canvas aspect) to the viewport. 1.05 = 5 % padding so the silhouette
    // doesn't kiss the frame edge.
    const halfFovV = (fovDeg * Math.PI / 180) / 2;
    const halfFovH = Math.atan(Math.tan(halfFovV) * aspect);
    const distFitV = halfYV / Math.tan(halfFovV);
    const distFitH = halfH  / Math.tan(halfFovH);
    let dist = Math.max(distFitV, distFitH) * preset.distMul;

    // Clamp so we don't punch through the near plane on tiny vehicles or
    // sail past the far plane on huge ones. Per-preset floor (distMinM) lets
    // tight presets like 'closeup' stop short of clipping into the booster
    // skirt on tall stacks (Starship's 9 m booster + 0.28 distMul → ~5 m,
    // which puts the camera inside the skirt; floor to ~14 m).
    dist = Math.max(dist, preset.distMinM ?? 8);

    const dir = new THREE.Vector3(...preset.dir).normalize();
    const pos = target.clone().addScaledVector(dir, dist);
    return { pos: pos.toArray(), target: target.toArray(), dist };
}

// Cancellable tween. Returns a handle whose `cancelled = true` short-circuits
// further steps. `getTo` may be a function — re-evaluated each frame so a
// tween can chase a moving destination (used during liftoff so view-switching
// follows the rocket instead of landing on a stale ground-level frame).
function tween(from, getTo, ms, onUpdate, onDone) {
    const start = performance.now();
    const handle = { cancelled: false };
    const fromCopy = from.slice();
    const toFn = typeof getTo === 'function' ? getTo : () => getTo;
    function step(now) {
        if (handle.cancelled) return;
        const t = Math.min(1, (now - start) / ms);
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // easeInOutQuad
        const to = toFn();
        const v = fromCopy.map((f, i) => f + (to[i] - f) * e);
        onUpdate(v);
        if (t < 1) requestAnimationFrame(step);
        else if (onDone) onDone();
    }
    requestAnimationFrame(step);
    return handle;
}

// ── Vehicle registry ─────────────────────────────────────────────────────────
// Each vehicle id maps to a builder that returns:
//   { root, plumes, height, info }
// `info` is metadata for the side panel; framework forwards it via the
// `onVehicleChange` callback so the host page can update its stats card.

function buildShuttleVehicle() {
    const root = buildShuttleStack();
    // Internal stack origin already places ET/SRB bases at y=0. The LC-39A
    // pad's MLP top sits at world y = 4.2, so put the stack origin there
    // and the SRB skirts land flush on the deck.
    root.position.y = 4.2;
    const height = DIM.ET_LEN;     // ~47 m; slightly under 56 m stack but
                                   // close enough for camera framing.

    // Thrust at liftoff: 2 SRBs (12.5 MN each) + 3 SSMEs (1.86 MN each) =
    // 30.58 MN. SRBs are the dominant contributor; SSMEs run continuously
    // through ascent while SRBs separate at T+125 s.
    const liftoffKn = 2 * ENGINES.rsrm.sl_kn + 3 * ENGINES.rs_25.sl_kn;
    const massT = 2030;

    // Engine layout — 2 SRBs flanking ET (no gimbal), 3 SSMEs on orbiter
    // aft (gimbal). Coordinates match buildShuttleStack().
    const srbOffset = DIM.ET_R + DIM.SRB_R + 0.4;
    const orbiterZ  = DIM.ET_R + DIM.ORBITER_FUSE_R + 0.4;
    const engineLayout = {
        boosterEngines: [
            { x: -srbOffset, y: -1.7, z: 0, thrust_kn: ENGINES.rsrm.sl_kn,
              gimbal: false, ring: 'srb' },
            { x:  srbOffset, y: -1.7, z: 0, thrust_kn: ENGINES.rsrm.sl_kn,
              gimbal: false, ring: 'srb' },
        ],
        upperEngines: [
            { x:  0,   y: 1.5, z: orbiterZ, thrust_kn: ENGINES.rs_25.sl_kn,
              gimbal: true, ring: 'ssme' },
            { x: -1.2, y: 1.0, z: orbiterZ, thrust_kn: ENGINES.rs_25.sl_kn,
              gimbal: true, ring: 'ssme' },
            { x:  1.2, y: 1.0, z: orbiterZ, thrust_kn: ENGINES.rs_25.sl_kn,
              gimbal: true, ring: 'ssme' },
        ],
    };

    return {
        root,
        plumes: root.userData.plumes,
        height,
        padId: 'lc39a',
        engineLayout,
        info: {
            name:           'Space Shuttle (STS)',
            years:          '1981 — 2011',
            height_m:       '56.1',
            diameter_m:     '8.4 (ET)',
            booster_engines:'2 × RSRM Solid',
            ship_engines:   '3 × RS-25 (SSME)',
            liftoff_mass_t: '2,030',
            leo_payload_t:  '27.5',
            pad:            'KSC LC-39A',
            notes:          '135 missions, ISS construction, Hubble servicing.',
            thrust: {
                liftoff_kn:    liftoffKn,
                liftoff_mn:    liftoffKn / 1000,
                per_engine_kn: ENGINES.rsrm.sl_kn,
                engine_count:  5,
                booster_engine: ENGINES.rsrm.name,
                upper_engine:   ENGINES.rs_25.name,
                propellant:    'APCP (SRB) + LH2/LOX (SSME)',
                twr_initial:   liftoffKn / (massT * 9.80665),
                mass_t:        massT,
                ref_id:        'shuttle',
            },
        },
    };
}

function buildStarshipVehicle(variant = 'v2') {
    const built = buildStarship({ variant });
    // Starship sits on the OLM table at ~21 m above ground.
    built.root.position.y = 21.4;
    built.padId = 'mechazilla';
    if (built.info) built.info.pad = 'SpaceX Stage 0 (Mechazilla)';
    return built;
}

function buildFalcon9Vehicle(variant = 'block5') {
    const built = buildFalcon9({ variant });
    // Falcon 9 sits on a TEL (transporter-erector-launcher) at LC-39A /
    // SLC-40 — pad-deck top is at world y = 4.2 (matches MLP top).
    built.root.position.y = 4.2;
    built.padId = 'falcon_tel';
    if (built.info) built.info.pad = 'KSC LC-39A / CCSFS SLC-40';
    return built;
}

const VEHICLE_BUILDERS = {
    shuttle:   () => buildShuttleVehicle(),
    starship:  (variant) => buildStarshipVehicle(variant || 'v2'),
    falcon9:   (variant) => buildFalcon9Vehicle(variant || 'block5'),
};

// ── Main entry point ─────────────────────────────────────────────────────────

export function initVehicleCanvas(canvas, opts = {}) {
    if (!canvas) throw new Error('initVehicleCanvas: canvas element required');

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    // Pixel ratio LOCKED to 1.
    //
    // On Retina displays setPixelRatio(devicePixelRatio) doubles the canvas
    // drawing buffer (`canvas.width = clientWidth × 2`). That doubled value
    // is what CSS treats as the canvas's intrinsic content size — and any
    // ancestor grid track using plain '1fr' inherits it as a min-content
    // floor and blows past the viewport. minmax(0, 1fr) + contain: layout
    // size in CSS *should* isolate that, but Mac Firefox/Safari leak it
    // through certain ancestor chains in practice (the repeated "canvas
    // takes over" / "canvas overflows right" regression has been this on
    // every prior occurrence). Locking pixelRatio = 1 makes the drawing
    // buffer always equal the CSS display size, so the intrinsic content
    // size matches what the layout expects and the feedback loop is
    // categorically impossible. Slight loss of sharpness on HiDPI is
    // imperceptible for this content; stability is the higher priority.
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    scene.background = buildSkyTexture();
    // Atmospheric fog — pulls distant scenery into a soft purple-night haze
    // and hides the hard edge where the ground plane cuts off.
    scene.fog = new THREE.FogExp2(0x1a1428, 0.0025);

    const stars = buildStarfield();
    scene.add(stars);

    // Ground horizon disc — large, faintly glowing edge to suggest atmosphere.
    const horizon = new THREE.Mesh(
        new THREE.RingGeometry(280, 1600, 96, 1),
        new THREE.MeshBasicMaterial({
            color: 0x3a2a4c, transparent: true, opacity: 0.45,
            side: THREE.DoubleSide, depthWrite: false, fog: false,
        })
    );
    horizon.rotation.x = -Math.PI / 2;
    horizon.position.y = -1;
    scene.add(horizon);

    // Default FOV is intentionally a touch wider than a stills lens (38°
    // ≈ 50 mm equivalent) so the rocket has a sense of presence without
    // looking like a telephoto-flat travel postcard. Cycle via setFOV().
    let cameraFov = 38;
    // Default aspect 16/10 (not 1) matches the host's CSS aspect-ratio, so if
    // the panel mounts collapsed and the very first frame ever paints before
    // the ResizeObserver delivers a real box, it's a sane wide frame rather
    // than a square one. The real aspect is applied the moment a non-zero
    // box exists (see resize()).
    const camera = new THREE.PerspectiveCamera(cameraFov, 16 / 10, 0.5, 8000);

    // ── Lighting ────────────────────────────────────────────────────────────
    scene.add(new THREE.HemisphereLight(0x6688aa, 0x2a1830, 0.55));
    scene.add(new THREE.AmbientLight(0xffffff, 0.18));

    const key = new THREE.DirectionalLight(0xfff2dc, 1.4);
    key.position.set(60, 90, 50);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias        = -0.0008;
    key.shadow.normalBias  = 0.04;
    scene.add(key);

    const fill = new THREE.DirectionalLight(0xffaa66, 0.55);
    fill.position.set(-40, 25, 30);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(0x88aaff, 0.4);
    rim.position.set(0, 30, -80);
    scene.add(rim);

    // ── Ascent trail (pad-anchored, world-space) ──────────────────────────
    const trail = buildAscentTrail();
    scene.add(trail);
    const padSteam = buildPadSteam();
    scene.add(padSteam);

    // ── Mission clock (drives liftoff animation) ──────────────────────────
    const missionClock = createMissionClock();
    let missionActive = false;
    // Thrust-vector overlay state (toggleable; persists across vehicle swaps)
    let vectorsOn = false;
    // Save baseline scene parameters so we can restore after a flight.
    const baseFogColor   = scene.fog.color.clone();
    const baseFogDensity = scene.fog.density;
    const skyEndColor    = new THREE.Color(0x040614);

    // ── Pad (replaced per vehicle in setVehicle) ──────────────────────────
    let padState = { root: null, beacons: [] };

    function swapPad(padId, opts = {}) {
        if (padState.root) {
            scene.remove(padState.root);
            padState.root.traverse(o => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) {
                    const mats = Array.isArray(o.material) ? o.material : [o.material];
                    mats.forEach(m => m.dispose());
                }
            });
        }
        const built = buildPadInfra(padId || 'generic', opts);
        scene.add(built.root);
        padState = built;
    }

    // ── God-mode flight camera ─────────────────────────────────────────────
    // OrbitControls is gone. This is a free-fly camera with FPS-style
    // mouse-look + WASD/QE keyboard, plus snap-to-preset on view buttons.
    //
    // Inputs:
    //   Left-click drag on canvas → mouse-look (yaw + pitch).
    //   W / S                     → forward / back along view direction.
    //   A / D                     → strafe left / right.
    //   Q / E                     → down / up in world Y.
    //   Shift                     → sprint (3× speed).
    //   Mouse wheel on canvas     → smooth dolly along view direction.
    //   Preset buttons / +/− / FOV / recenter → snap or tween to a frame.
    //
    // State held in `cam`:
    //   pos   (Vector3) — camera world position. camera.position is written
    //                     from this each frame.
    //   yaw   (rad)     — rotation around world Y. 0 = looking toward -Z.
    //   pitch (rad)     — rotation around camera X. +ve = looking up.
    //                     Clamped to ±(π/2 − 0.02) so we never gimbal-flip.
    //   keys  (object)  — current pressed state for movement keys.
    //
    // `controls` is kept as a compat shim with .target (Vector3) so the
    // existing liftoff / view-tween code can continue to write to it. The
    // target is purely informational — camera orientation comes from
    // (yaw, pitch), not from look-at.
    const cam = {
        pos:       new THREE.Vector3(0, 30, 80),
        yaw:       0,
        pitch:     0,
        keys:      Object.create(null),
        dragging:  false,
        lastX:     0,
        lastY:     0,
        moveSpeed: 80,       // m/s base
        sprintMul: 3,
        lookSpeed: 0.003,    // rad/px of mouse drag
        dollyStep: 6,        // m per wheel notch
        pitchMin: -Math.PI / 2 + 0.02,
        pitchMax:  Math.PI / 2 - 0.02,
    };

    // Latches true the moment the user actually manipulates the free-fly
    // camera (look-drag, wheel-dolly, WASD/QE move). While false, every
    // resize re-auto-frames the current preset; once true, resizes only
    // re-measure (aspect) and leave the user's framing alone. Reset to
    // false on vehicle swap and on explicit preset/recenter so auto-framing
    // resumes for the new shot.
    let userControlledCamera = false;

    const _fwd   = new THREE.Vector3();
    const _right = new THREE.Vector3();
    const _move  = new THREE.Vector3();

    function camForward(out) {
        return out.set(
            -Math.sin(cam.yaw) * Math.cos(cam.pitch),
             Math.sin(cam.pitch),
            -Math.cos(cam.yaw) * Math.cos(cam.pitch),
        );
    }
    function camRight(out) {
        return out.set(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)).normalize();
    }
    function setLookAt(targetVec) {
        const dir = new THREE.Vector3().subVectors(targetVec, cam.pos);
        if (dir.lengthSq() < 1e-6) return;
        dir.normalize();
        cam.yaw   = Math.atan2(-dir.x, -dir.z);
        cam.pitch = THREE.MathUtils.clamp(Math.asin(dir.y), cam.pitchMin, cam.pitchMax);
    }
    function applyCamToThree() {
        camera.position.copy(cam.pos);
        camera.rotation.set(cam.pitch, cam.yaw, 0, 'YXZ');
    }

    // Compat shim — old code reads/writes `controls.target` and calls
    // `controls.update()`. We give it a real Vector3 target (for liftoff
    // bookkeeping) and an update() that runs the god-camera tick.
    const controls = {
        target:        new THREE.Vector3(0, 0, 0),
        autoRotate:    false,
        autoRotateSpeed: 0,
        minDistance:   6,
        maxDistance:   2000,
        // Unused fields kept so legacy code doesn't crash if it sets them.
        minAzimuthAngle: -Infinity, maxAzimuthAngle: Infinity,
        minPolarAngle:   0,         maxPolarAngle:   Math.PI,
        enableDamping: false, dampingFactor: 0,
        enableZoom: false, enablePan: false, rotateSpeed: 0,
        _dt: 0,
        update() {
            const dt = this._dt;
            // Movement keys → cam.pos.
            camForward(_fwd);
            camRight(_right);
            _move.set(0, 0, 0);
            if (cam.keys.w) _move.add(_fwd);
            if (cam.keys.s) _move.sub(_fwd);
            if (cam.keys.a) _move.sub(_right);
            if (cam.keys.d) _move.add(_right);
            if (cam.keys.q) _move.y -= 1;
            if (cam.keys.e) _move.y += 1;
            if (_move.lengthSq() > 0 && dt > 0) {
                const sprint = cam.keys.shift ? cam.sprintMul : 1;
                _move.normalize().multiplyScalar(cam.moveSpeed * sprint * dt);
                cam.pos.add(_move);
            }
            applyCamToThree();
        },
        dispose() {
            canvas.removeEventListener('pointerdown', onPointerDown);
            canvas.removeEventListener('pointermove', onPointerMove);
            canvas.removeEventListener('pointerup',   onPointerUp);
            canvas.removeEventListener('pointercancel', onPointerUp);
            canvas.removeEventListener('wheel',       onWheel);
            canvas.removeEventListener('contextmenu', onContextMenu);
            window.removeEventListener('keydown',     onKeyDown);
            window.removeEventListener('keyup',       onKeyUp);
            window.removeEventListener('blur',        onBlur);
        },
    };

    // ── Input handlers ─────────────────────────────────────────────────────
    function onPointerDown(e) {
        if (e.button !== 0) return;              // left-click only
        cam.dragging = true;
        cam.lastX = e.clientX;
        cam.lastY = e.clientY;
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        // preventScroll: focusing the canvas otherwise triggers the
        // browser's scroll-into-view, which on a wide page shifts the
        // whole document sideways when you click the canvas.
        canvas.focus({ preventScroll: true });
    }
    function onPointerMove(e) {
        if (!cam.dragging) return;
        const dx = e.clientX - cam.lastX;
        const dy = e.clientY - cam.lastY;
        cam.lastX = e.clientX;
        cam.lastY = e.clientY;
        if (dx || dy) userControlledCamera = true;   // real look-drag
        cam.yaw   -= dx * cam.lookSpeed;
        cam.pitch -= dy * cam.lookSpeed;
        cam.pitch  = THREE.MathUtils.clamp(cam.pitch, cam.pitchMin, cam.pitchMax);
    }
    function onPointerUp(e) {
        if (!cam.dragging) return;
        cam.dragging = false;
        try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    function onContextMenu(e) {
        // Suppress right-click menu inside canvas so a stray right-click
        // doesn't break flow. Doesn't affect anywhere else on the page.
        e.preventDefault();
    }
    function onWheel(e) {
        // Smooth dolly along view direction. Negative deltaY (scroll up)
        // moves forward. We do preventDefault here because we want the
        // wheel to drive the camera when the cursor is on the canvas.
        e.preventDefault();
        userControlledCamera = true;                 // wheel-dolly
        camForward(_fwd);
        const dir = e.deltaY > 0 ? -1 : 1;
        cam.pos.addScaledVector(_fwd, dir * cam.dollyStep);
    }
    function setKey(key, down) {
        const k = key.length === 1 ? key.toLowerCase() : key;
        if (k === 'Shift' || k === 'shift') { cam.keys.shift = down; return; }
        if ('wasdqe'.includes(k)) {
            cam.keys[k] = down;
            if (down) userControlledCamera = true;    // WASD/QE fly
        }
    }
    function onKeyDown(e) {
        // Only intercept movement keys when the canvas has focus, so
        // typing in forms anywhere else on the page is unaffected.
        if (document.activeElement !== canvas) return;
        setKey(e.key, true);
        if ('wasdqeWASDQE'.includes(e.key) || e.key === 'Shift') e.preventDefault();
    }
    function onKeyUp(e) {
        setKey(e.key, false);
    }
    function onBlur() {
        // Window lost focus — release all held keys so the camera doesn't
        // glide off forever when the user alt-tabs mid-press.
        for (const k of Object.keys(cam.keys)) cam.keys[k] = false;
        cam.dragging = false;
    }

    canvas.tabIndex = 0;                          // make focusable
    canvas.style.outline = 'none';                // no focus ring
    canvas.addEventListener('pointerdown',   onPointerDown);
    canvas.addEventListener('pointermove',   onPointerMove);
    canvas.addEventListener('pointerup',     onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel',         onWheel, { passive: false });
    canvas.addEventListener('contextmenu',   onContextMenu);
    window.addEventListener('keydown',       onKeyDown);
    window.addEventListener('keyup',         onKeyUp);
    window.addEventListener('blur',          onBlur);

    // ── Vehicle state (mutable — replaced by setVehicle) ───────────────────
    let current = {
        id: null, variant: null, root: null, plumes: [],
        height: 1, info: null,
        bbox: new THREE.Box3(),
        basePadY: 0,
        baseTargetY: 0,
        baseCamY: 0,
        lastAltitude: 0,
        trailWidthM: 9,
    };
    let currentViewName = 'threequarter';

    // ── View tween state ───────────────────────────────────────────────────
    // setView fires ONE tween (carrying both cam.pos and controls.target as
    // a 6-vec) so cancellation is a single handle. cameraFollowSuppressed
    // gates applyMissionState's per-frame Δy add during the tween, since
    // the tween itself bakes the live altitude offset into each step.
    let activeTween = null;
    let cameraFollowSuppressed = false;

    function cancelViewTween() {
        if (activeTween) { activeTween.cancelled = true; activeTween = null; }
        cameraFollowSuppressed = false;
    }

    function liveOffsetY() {
        return current.root ? (current.root.position.y - current.basePadY) : 0;
    }

    function disposeMeshes(obj) {
        obj.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach(m => m.dispose());
            }
        });
    }

    function fitShadowCameraToVehicle(vehicle) {
        // Wrap the directional shadow camera around the current vehicle +
        // its pad so it actually casts useful shadows from a 56 m shuttle
        // up to a 150 m+ starship + tower.
        const h = vehicle.height;
        const baseY = vehicle.root.position.y;
        const r = h * 1.4;
        key.shadow.camera.left   = -r;
        key.shadow.camera.right  =  r;
        key.shadow.camera.top    =  baseY + h * 1.4;
        key.shadow.camera.bottom = -10;
        key.shadow.camera.near   = 30;
        key.shadow.camera.far    = h * 6;
        key.shadow.camera.updateProjectionMatrix();
        // Position the key light proportional to vehicle height so a 200 m
        // future-Starship is still lit from above instead of from its
        // mid-section. Aim at the bbox center.
        const lightY = baseY + h * 1.05;
        key.position.set(h * 0.85, lightY, h * 0.55);
        key.target.position.set(0, baseY + h * 0.5, 0);
        key.target.updateMatrixWorld();
        scene.add(key.target);
    }

    function setVehicle(id, variant) {
        const builder = VEHICLE_BUILDERS[id];
        if (!builder) { console.warn(`Unknown vehicle: ${id}`); return; }

        // Cancel any in-flight animation + view-tween before swapping. A
        // stale tween from the prior vehicle would keep writing camera.pos
        // for ~800 ms, fighting the new vehicle's framing.
        cancelViewTween();
        cameraFollowSuppressed = false;
        if (missionActive) cancelLiftoff();

        // Tear down previous vehicle.
        if (current.root) {
            scene.remove(current.root);
            disposeMeshes(current.root);
        }

        const v = builder(variant);

        // Build a thrust-vector overlay matching this vehicle's engine
        // layout. Parented to the vehicle root so it inherits liftoff
        // pitch/roll transforms automatically.
        const thrustOverlay = buildThrustOverlay(v);
        thrustOverlay.visible = vectorsOn;            // honor user toggle across vehicle changes
        v.root.add(thrustOverlay);

        scene.add(v.root);

        current = {
            id, variant, ...v,
            bbox: computeVehicleBBox(v.root),
            basePadY: v.root.position.y,
            baseTargetY: 0,
            baseCamY: 0,
            lastAltitude: 0,
            thrustOverlay,
            // Per-pad trail width — wider for Stage 0's 33-engine cluster.
            trailWidthM: (v.padId === 'mechazilla') ? 14 : 9,
        };

        // Swap pad infrastructure to whichever site this vehicle flies from.
        // Pass the booster diameter so adaptive pads (Mechazilla) can size
        // their hole + clamp ring to the actual stack.
        const padOpts = { boosterDiameter: parseFloat(v.info?.diameter_m) || undefined };
        swapPad(v.padId, padOpts);

        // A new vehicle starts framed from the canonical 3/4 angle, and
        // re-arms auto-framing so any post-swap resize keeps it centred
        // until the user grabs the camera again.
        currentViewName = 'threequarter';
        userControlledCamera = false;
        const aspect = camera.aspect || 16/10;
        const view = frameForView(currentViewName, current, cameraFov, aspect);
        cam.pos.set(...view.pos);
        controls.target.set(...view.target);
        setLookAt(controls.target);
        applyCamToThree();
        fitShadowCameraToVehicle(current);

        // Capture baseline Y so the liftoff Δ-follow can re-baseline cleanly.
        current.baseTargetY = controls.target.y;
        current.baseCamY    = cam.pos.y;

        if (typeof opts.onVehicleChange === 'function') {
            opts.onVehicleChange({ id, variant, info: v.info });
        }
    }

    // ── Liftoff animation ──────────────────────────────────────────────────
    // Apply the mission-clock snapshot to the scene each frame: vehicle
    // pose, plume throttle, exhaust trail, sky/fog tint, pad fade, and a
    // 1:1 camera follow that preserves the user's orbital framing.
    function applyMissionState(s) {
        // Hold-down release "twang" — at T=0 the real shuttle SRBs fire,
        // hold-down posts release, and the stack springs upward by ~15 cm
        // before settling into ascent. Add a damped sine kick that decays
        // over the first ~1 s so the launch reads with a satisfying jolt.
        const T = s.T;
        let twang = 0;
        if (T >= 0 && T < 1.2) {
            const decay = Math.exp(-T * 3.2);
            twang = 0.55 * decay * Math.sin(T * Math.PI * 5);
        }

        // Vehicle pose
        current.root.position.y = current.basePadY + s.altitude + twang;
        current.root.rotation.y = s.roll;
        current.root.rotation.x = -s.pitch;

        // High-frequency vibration during liftoff & first 12 s of ascent —
        // tiny lateral wobble suggesting acoustic loading without making
        // the rocket look broken.
        const vibAmp = (T > -0.5 && T < 12) ? 0.02 + 0.03 * Math.max(0, 1 - T / 12) : 0;
        if (vibAmp > 0) {
            current.root.position.x = Math.sin(T * 41) * vibAmp;
            current.root.position.z = Math.cos(T * 47) * vibAmp;
        } else {
            current.root.position.x = 0;
            current.root.position.z = 0;
        }

        // Camera follow: target rises with the vehicle, cam.pos rises by
        // the same Δ so the user's framing is preserved. Suppressed during
        // a view-tween so the tween's absolute writes don't race this
        // delta-add.
        if (!cameraFollowSuppressed) {
            const dy = s.altitude - current.lastAltitude;
            if (dy !== 0) {
                controls.target.y += dy;
                cam.pos.y         += dy;
            }
        }
        current.lastAltitude = s.altitude;

        // Trail — pad-anchored cylinder, height = altitude. Hide once the
        // rocket is back on the pad (T < 0).
        if (s.trailH > 0.5) {
            trail.visible = true;
            const w = current.trailWidthM * 0.5;
            trail.scale.set(w, s.trailH, w);
            trail.position.set(0, current.basePadY + s.trailH / 2, 0);
        } else {
            trail.visible = false;
        }

        // Pad steam vents — visible only in the ignition + early-ascent
        // window. Anchored to the pad deck (basePadY), independent of the
        // rocket's altitude.
        padSteam.position.y = current.basePadY - 4;
        tickPadSteam(padSteam, T, s.throttle);

        // Sky / fog — tint toward upper-atmosphere black + clear out fog
        // density as the rocket climbs.
        scene.fog.color.copy(baseFogColor).lerp(skyEndColor, s.skyMix);
        scene.fog.density = baseFogDensity * (1 - 0.75 * s.skyMix);

        // Pad fade
        applyPadOpacity(s.padOpacity);
    }

    // Compute a small camera shake offset for the loudest acoustic window —
    // ignition + first few seconds of liftoff. Returned as a {x,y,z} delta
    // that the caller adds before render and removes after, so the offset
    // doesn't get fed back into OrbitControls' damping target.
    function shakeOffsetFor(T) {
        if (T < -0.5 || T > 5) return null;
        const env = T < 0
            ? Math.max(0, (T + 0.5) / 0.5) * 0.6   // ignition build
            : Math.max(0, 1 - T / 5);              // post-liftoff decay
        if (env <= 0) return null;
        const amp = 0.08 * env;
        return {
            x: Math.sin(T * 73 + 0.7) * amp,
            y: Math.sin(T * 83 + 1.3) * amp,
            z: Math.sin(T * 79 + 2.1) * amp,
        };
    }

    // Walks the pad's mesh tree applying an opacity. Idempotent.
    function applyPadOpacity(o) {
        if (!padState.root) return;
        const transparent = (o < 1);
        padState.root.traverse(node => {
            if (!node.isMesh || !node.material) return;
            const mats = Array.isArray(node.material) ? node.material : [node.material];
            for (const m of mats) {
                if (transparent) {
                    m.transparent = true;
                    m.opacity = o;
                } else if (m.transparent) {
                    m.transparent = false;
                    m.opacity = 1;
                }
            }
        });
    }

    function liftoff() {
        if (missionActive) { cancelLiftoff(); return; }

        // Cancel any active view-tween — otherwise its absolute camera-pos
        // writes for the next several hundred ms would race the per-frame
        // ascent follow, producing a visible camera judder right at T-0.
        cancelViewTween();
        cameraFollowSuppressed = false;

        // Re-baseline vertical follow before the delta-tracking loop runs.
        // lastAltitude must equal the y-offset already in the camera, or
        // the first `dy = altitude - lastAltitude` snaps the camera by the
        // stale residual. Snap target.y / camera.y back to the framing
        // captured by setVehicle() and leave x/z alone so the user's
        // azimuth/orbit survives. controls.update() flushes any damping
        // residual so it can't race the manual y-writes next frame.
        current.lastAltitude = 0;
        controls.target.y    = current.baseTargetY;
        cam.pos.y            = current.baseCamY;

        missionClock.start();
        missionActive = true;
        // Force plume on so you can actually see the engines fire.
        for (const p of current.plumes) p.visible = true;
    }

    function cancelLiftoff() {
        if (!missionActive) return;
        missionActive = false;
        missionClock.reset();

        // Same reasoning as liftoff() — kill any in-flight view tween before
        // we restore the base framing, so the tween can't drag the camera
        // back into mid-air after we settle it back on the pad.
        cancelViewTween();
        cameraFollowSuppressed = false;

        // Reset vehicle pose — including the per-frame vibration offset
        // and twang in X/Z that the launch loop accumulated.
        current.root.position.set(0, current.basePadY, 0);
        current.root.rotation.set(0, 0, 0);

        // Restore baseline Y so subsequent launches start clean.
        controls.target.y    = current.baseTargetY;
        cam.pos.y            = current.baseCamY;
        current.lastAltitude = 0;

        // Restore scene state
        trail.visible = false;
        padSteam.visible = false;
        scene.fog.color.copy(baseFogColor);
        scene.fog.density = baseFogDensity;
        applyPadOpacity(1);

        // Note: we leave plume + auto-rotate to whatever the user toggles.
        // The UI button-state listener flips its own label.
        if (typeof opts.onLiftoffEnd === 'function') opts.onLiftoffEnd();
    }

    // Snap the camera to the canonical frame for the current preset and the
    // *live* canvas aspect. Mirrors setVehicle's framing but without the
    // 800 ms view tween, so a canvas that was just revealed (panel expanded)
    // pops straight to the correct frame instead of animating from a stale
    // pose. Sets controls.target + flushes the god-camera so the pose is
    // applied even if the render loop is currently paused (collapsed panel).
    function reframeCurrentView() {
        if (!current || !current.root) return;
        cancelViewTween();
        const aspect = camera.aspect || 16 / 10;
        const view   = frameForView(currentViewName || 'threequarter',
                                    current, cameraFov, aspect);
        const dy = liveOffsetY();
        cam.pos.set(view.pos[0],    view.pos[1]    + dy, view.pos[2]);
        controls.target.set(view.target[0], view.target[1] + dy, view.target[2]);
        setLookAt(controls.target);
        controls.update();
        applyCamToThree();
        // Re-baseline the on-pad reference Y (excludes any in-flight offset)
        // so a later liftoff Δ-follow stays consistent.
        current.baseTargetY = controls.target.y - dy;
        current.baseCamY    = cam.pos.y - dy;
    }

    // ── Resize handling ────────────────────────────────────────────────────
    // Sized BEFORE the initial setVehicle so frameForView sees the correct
    // canvas aspect from the very first frame — otherwise the default
    // PerspectiveCamera aspect leads to a tall, low-margin fit and the rocket
    // spills out the sides.
    //
    // The canvas host (.lh-vehicle-canvas-host, inside .lp-collapse-body) can
    // mount display:none when its panel restores a persisted "collapsed"
    // state. While collapsed, clientWidth/clientHeight are 0. We must NOT
    // derive aspect from that (0/0 = NaN) nor setSize(0), and we must NOT
    // substitute an arbitrary fallback size — doing so bakes a wrong aspect
    // into setVehicle's framing that nothing ever corrects.
    //
    // CAMERA-FRAMING CONTRACT (the "fix it once and for all" rule):
    //   Auto-reframe on EVERY resize, for as long as the user hasn't grabbed
    //   the free-fly camera. Page layout — especially the documented Mac
    //   Firefox/Safari grid-track thrash — emits a *sequence* of resize
    //   boxes during load (intermediate width, aspect-ratio not yet applied,
    //   min-height-only, …) before settling. A one-shot "frame on the first
    //   valid box" latch frames against whichever transient box arrives
    //   first and is then stuck there forever — the recurring "camera
    //   defaults to the orange tower" bug. Reframing on every resize means
    //   the camera is correct the instant layout settles, no matter what it
    //   passed through. Once the user actually drags / wheels / WASDs the
    //   camera (userControlledCamera = true) we stop yanking it — they own
    //   it from then until the next vehicle swap or explicit recenter.
    function resize() {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (!w || !h) return;                 // collapsed / not yet laid out
        // pixelRatio is locked to 1 (see WebGLRenderer init), so the drawing
        // buffer always equals the CSS box and can't overflow the grid track.
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        if (!userControlledCamera) reframeCurrentView();
    }
    // Observe the host element, not just the canvas: the host is what
    // gains/loses its layout box when the collapse panel toggles
    // display:none ⇄ block, so observing it guarantees the expand
    // notification (and the density aspect-ratio change) in every browser.
    const resizeHost = canvas.parentElement || canvas;
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(resizeHost);

    // Initial vehicle.
    setVehicle(opts.vehicle || 'shuttle', opts.variant);

    // ── Render loop (paused when off-screen) ───────────────────────────────
    let running = true;
    let rafId = 0;
    const clock = new THREE.Clock();
    const io = new IntersectionObserver(([entry]) => {
        running = entry.isIntersecting;
        if (running && !rafId) tick();
    }, { threshold: 0.05 });
    io.observe(canvas);

    function tick() {
        if (!running) { rafId = 0; return; }
        const dt = clock.getDelta();
        const t = clock.elapsedTime;
        controls._dt = dt;
        controls.update();
        stars.material.uniforms.uTime.value = t;

        // Liftoff state — advance clock, apply pose/sky/pad/trail, drive plume throttle.
        let throttle = 1;
        if (missionActive) {
            missionClock.update(performance.now());
            const s = missionClock.snapshot();
            applyMissionState(s);
            throttle = s.throttle;
            if (missionClock.finished()) {
                // Auto-end + reset; UI listener resets its button.
                cancelLiftoff();
            }
        }

        // Live altitude (km) feeds the plume shader so it widens / lengthens
        // as ambient pressure falls. liveOffsetY() is meters above pad.
        const altKm = liveOffsetY() / 1000;
        for (const p of current.plumes) tickPlume(p, t, throttle, altKm);
        tickBeacons(padState.beacons, t);
        // Camera shake — applied just before render and undone right after,
        // so the offset shows in this frame but isn't fed back into
        // OrbitControls' damping next tick.
        const shake = missionActive ? shakeOffsetFor(missionClock.T) : null;
        if (shake) {
            camera.position.x += shake.x;
            camera.position.y += shake.y;
            camera.position.z += shake.z;
        }
        // Thrust-vector overlay — read live throttle + mission time.
        if (current.thrustOverlay && current.thrustOverlay.visible) {
            tickThrustOverlay(current.thrustOverlay, {
                throttle: missionActive ? throttle : (vectorsOn ? 0.05 : 0),
                T:        missionActive ? missionClock.T : 0,
            });
        }
        renderer.render(scene, camera);
        if (shake) {
            camera.position.x -= shake.x;
            camera.position.y -= shake.y;
            camera.position.z -= shake.z;
        }
        rafId = requestAnimationFrame(tick);
    }
    tick();

    // ── Public camera API ──────────────────────────────────────────────────

    // Single-tween view swap. Pos + target ride a 6-vec so cancellation is
    // one handle. The destination is a function of the live rocket Y so a
    // view-pick mid-flight lands on the moving rocket, not the empty pad.
    function setView(name) {
        if (!VIEW_PRESETS[name]) return;
        currentViewName = name;
        // Picking a preset (or recenter) re-arms auto-framing: the user
        // explicitly asked for a canonical shot, so a later resize should
        // keep THAT preset framed rather than freeze the tween's end pose.
        userControlledCamera = false;
        cancelViewTween();

        const aspect = camera.aspect || 16/10;
        const base   = frameForView(name, current, cameraFov, aspect);

        cameraFollowSuppressed = missionActive;

        const from = [
            cam.pos.x, cam.pos.y, cam.pos.z,
            controls.target.x, controls.target.y, controls.target.z,
        ];
        const toFn = () => {
            const dy = liveOffsetY();
            return [
                base.pos[0],    base.pos[1]    + dy, base.pos[2],
                base.target[0], base.target[1] + dy, base.target[2],
            ];
        };

        activeTween = tween(from, toFn, 800,
            v => {
                cam.pos.set(v[0], v[1], v[2]);
                controls.target.set(v[3], v[4], v[5]);
                setLookAt(controls.target);
            },
            () => {
                if (missionActive) {
                    current.lastAltitude = missionClock.snapshot().altitude;
                }
                cameraFollowSuppressed = false;
                activeTween = null;
            }
        );
    }

    // God-mode dolly along the current view direction. factor < 1 zooms
    // in (forward), > 1 zooms out (back). 20 m per click is comfortable.
    function setZoom(factor) {
        userControlledCamera = true;                 // deliberate user dolly
        camForward(_fwd);
        const stepM = (factor < 1) ? 20 : -20;
        cam.pos.addScaledVector(_fwd, stepM);
    }

    function recenter() {
        setView(currentViewName || 'threequarter');
    }

    // FOV swap. No dolly compensation — in god-mode the user owns position
    // explicitly; FOV is purely a lens-swap.
    function setFOV(deg) {
        const next = THREE.MathUtils.clamp(deg, 18, 80);
        if (Math.abs(next - cameraFov) < 0.5) return;
        cameraFov = next;
        camera.fov = cameraFov;
        camera.updateProjectionMatrix();
    }
    function cycleFOV() {
        const cycle = [28, 38, 52];
        let i = cycle.findIndex(v => Math.abs(v - cameraFov) < 1);
        if (i < 0) i = cycle.indexOf(38);
        setFOV(cycle[(i + 1) % cycle.length]);
        return cameraFov;
    }

    function setPlume(on) {
        for (const p of current.plumes) p.visible = !!on;
    }
    function setPad(on) { if (padState.root) padState.root.visible = !!on; }

    // No-op in god-mode — the Auto button toggles its CSS state but doesn't
    // do anything to the camera. Left as a stub so the host UI doesn't break.
    function setAutoRotate(_on) {}
    function setVectors(on) {
        vectorsOn = !!on;
        if (current.thrustOverlay) current.thrustOverlay.visible = vectorsOn;
    }

    return {
        dispose() {
            running = false;
            cancelAnimationFrame(rafId);
            ro.disconnect();
            io.disconnect();
            controls.dispose();
            renderer.dispose();
            scene.traverse(o => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) {
                    const mats = Array.isArray(o.material) ? o.material : [o.material];
                    mats.forEach(m => m.dispose());
                }
            });
        },
        setView,
        setAutoRotate,
        setPlume,
        setPad,
        setVectors,
        setVehicle,
        setZoom,
        setFOV,
        cycleFOV,
        recenter,
        // Force a re-measure + reframe. The host page can call this after it
        // programmatically expands the vehicle panel (the collapse UI fires
        // no event) or after any layout change the ResizeObserver can't see.
        // Optional explicit w/h is an escape hatch for callers that already
        // know the target box.
        refresh() {
            // Explicit host request to re-fit — re-arm auto-framing so the
            // reframe actually happens even if the user had grabbed the cam.
            userControlledCamera = false;
            resize();
        },
        resize(w, h) {
            if (w > 0 && h > 0) {
                renderer.setSize(w, h, false);
                camera.aspect = w / h;
                camera.updateProjectionMatrix();
                reframeCurrentView();
            } else {
                userControlledCamera = false;
                resize();
            }
        },
        liftoff,
        cancelLiftoff,
        get fov() { return cameraFov; },
        get isAscending() { return missionActive; },
        get missionT()    { return missionClock.T; },
        get currentInfo() { return current.info; },
        // Live thrust + g-force readout for the MET HUD. Returns:
        //   { throttle, thrust_mn, twr, g, mass_t }
        // Mass loss approximated as 35% over the clip (T-3 → T+50) so
        // T/W rises through ascent, mirroring real propellant burn-off.
        getLiveThrust() {
            const info = current.info;
            const t = info?.thrust;
            if (!t) return null;
            const throttle = missionActive
                ? missionClock.snapshot().throttle
                : 0;
            const T = missionActive ? missionClock.T : 0;
            const massFrac = Math.max(0.55, 1 - 0.35 * Math.max(0, Math.min(1, T / 50)));
            const massNow  = t.mass_t * massFrac;
            const liveKn   = t.liftoff_kn * throttle;
            const twr      = liveKn / (massNow * 9.80665);
            return {
                throttle,
                thrust_mn:  liveKn / 1000,
                thrust_max_mn: t.liftoff_mn,
                twr,
                g:          twr,                        // felt g-force ≈ TWR
                mass_t:     Math.round(massNow),
            };
        },
    };
}
