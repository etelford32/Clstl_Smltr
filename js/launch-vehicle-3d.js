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
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildStarship } from './launch-vehicle-starship.js';
import { buildFalcon9 } from './launch-vehicle-falcon9.js';
import { buildPad as buildPadInfra, tickBeacons } from './launch-pad-3d.js';
import { createMissionClock } from './launch-mission-clock.js';
import { ENGINES } from './launch-engines.js';
import { buildThrustOverlay, tickThrustOverlay } from './launch-thrust-overlay.js';
import { buildPlume as buildPlumeShared, tickPlume } from './launch-plume.js';

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

    // SRB nozzle — exposed bell at the very base. Built via lathe so the bell
    // contour is curved, not just a cone.
    const nozPts = [];
    for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        const r = R * 0.55 + (R * 0.95 - R * 0.55) * Math.pow(t, 0.55);
        nozPts.push(new THREE.Vector2(r, -t * 1.6));
    }
    const nozzle = new THREE.Mesh(
        new THREE.LatheGeometry(nozPts, 24),
        mkMat(COLORS.nozzle, { roughness: 0.35, metalness: 0.55 })
    );
    nozzle.castShadow = true;
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
// Powerhead block + bell nozzle, both lathed for smooth contour.

function buildSSME() {
    const g = new THREE.Group();
    g.name = 'SSME';

    // Powerhead — chunky block at top with plumbing detail.
    const head = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.6, 0.7, 16),
        mkMat(COLORS.metalDark, { roughness: 0.4, metalness: 0.7 })
    );
    head.position.y = 0.4;
    head.castShadow = true;
    g.add(head);

    // Bell nozzle — lathe profile that flares like a real rocket bell.
    const bellPts = [];
    const N = 18;
    for (let i = 0; i <= N; i++) {
        const t = i / N;
        // Throat at t=0 (small), exit at t=1 (large). Shape is a slight
        // parabola so the curve is visible.
        const r = 0.32 + (0.95 - 0.32) * Math.pow(t, 0.55);
        bellPts.push(new THREE.Vector2(r, -t * 1.9));
    }
    const bell = new THREE.Mesh(
        new THREE.LatheGeometry(bellPts, 28),
        mkPhys(COLORS.nozzle, { roughness: 0.3, metalness: 0.55, clearcoat: 0.4 })
    );
    bell.castShadow = true;
    g.add(bell);

    // Inner bell glow (hot-when-firing). Faintly emissive so it reads even
    // when the plume is off.
    const glow = new THREE.Mesh(
        new THREE.LatheGeometry(bellPts.map(p => new THREE.Vector2(p.x * 0.92, p.y + 0.05)), 24),
        new THREE.MeshBasicMaterial({ color: COLORS.nozzleHot, side: THREE.BackSide })
    );
    g.add(glow);

    return g;
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
    closeup:      { dir: [ 0.55, 0.20,  0.78], biasY: -0.48, distMul: 0.28 },
};

// Compute world-space bounding box of just the visible vehicle hardware,
// excluding the engine plume cones (off by default + huge when on) and the
// pad-anchored ascent trail (lives on the scene root).
function computeVehicleBBox(vehicleRoot) {
    vehicleRoot.updateMatrixWorld(true);
    const bbox = new THREE.Box3();
    vehicleRoot.traverse(o => {
        if (!o.isMesh) return;
        // Skip plume groups (children named 'Plume') so an invisible cone
        // doesn't bloat the bbox.
        let p = o;
        while (p) {
            if (p.name === 'Plume') return;
            p = p.parent;
        }
        bbox.expandByObject(o);
    });
    return bbox;
}

function frameForView(name, vehicle, fovDeg, aspect) {
    const preset = VIEW_PRESETS[name] || VIEW_PRESETS.threequarter;
    const bbox = vehicle.bbox || new THREE.Box3();
    const center = bbox.getCenter(new THREE.Vector3());
    const size   = bbox.getSize(new THREE.Vector3());

    // Bias the look-at along Y for presets that want to favor a section of
    // the stack (e.g. closeup pulls the eye toward the engines).
    center.y += preset.biasY * size.y;

    // Fit the larger of vertical extent and horizontal extent (modulated by
    // canvas aspect) to the viewport. 1.05 = 5 % padding so the silhouette
    // doesn't kiss the frame edge.
    const halfFovV = (fovDeg * Math.PI / 180) / 2;
    const halfFovH = Math.atan(Math.tan(halfFovV) * aspect);
    const halfV = Math.max(size.y, 1) * 0.5 * 1.05;
    const halfH = Math.max(size.x, size.z, 1) * 0.5 * 1.05;
    const distFitV = halfV / Math.tan(halfFovV);
    const distFitH = halfH / Math.tan(halfFovH);
    let dist = Math.max(distFitV, distFitH) * preset.distMul;

    // Clamp so we don't punch through the near plane on tiny vehicles or
    // sail past the far plane on huge ones.
    dist = Math.max(dist, 8);

    const dir = new THREE.Vector3(...preset.dir).normalize();
    const pos = center.clone().addScaledVector(dir, dist);
    return { pos: pos.toArray(), target: center.toArray(), dist };
}

function tween(from, to, ms, onUpdate, onDone) {
    const start = performance.now();
    function step(now) {
        const t = Math.min(1, (now - start) / ms);
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // easeInOutQuad
        const v = from.map((f, i) => f + (to[i] - f) * e);
        onUpdate(v);
        if (t < 1) requestAnimationFrame(step);
        else if (onDone) onDone();
    }
    requestAnimationFrame(step);
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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
    const camera = new THREE.PerspectiveCamera(cameraFov, 1, 0.5, 8000);

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

    // ── OrbitControls ──────────────────────────────────────────────────────
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    // Allow looking slightly above horizon (so 'Top' preset can swing wide)
    // while still preventing flipping past zenith.
    controls.maxPolarAngle = Math.PI * 0.96;
    controls.minPolarAngle = 0.05;
    controls.autoRotate = opts.autoRotate ?? true;
    controls.autoRotateSpeed = 0.45;
    // Pan = right-click drag on desktop, two-finger drag on touch. Pan in
    // screen-space so it feels predictable regardless of camera tilt.
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.panSpeed = 0.9;
    controls.rotateSpeed = 0.8;
    controls.zoomSpeed = 0.9;

    // ── Vehicle state (mutable — replaced by setVehicle) ───────────────────
    let current = {
        id: null,
        variant: null,
        root: null,
        plumes: [],
        height: 1,
        info: null,
        bbox: new THREE.Box3(),
        // Mutated each frame during liftoff:
        basePadY: 0,         // pad-top Y captured on vehicle build
        baseTargetY: 0,      // controls.target.y captured on vehicle build
        baseCamY: 0,         // camera.position.y captured on vehicle build
        lastAltitude: 0,
        trailWidthM: 9,      // pad-specific trail width
    };
    // Track which preset is active so recenter() can re-frame using the
    // user's current choice rather than always slamming back to threequarter.
    let currentViewName = 'threequarter';

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

        // Cancel any in-flight animation before swapping.
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

        // A new vehicle starts framed from the canonical 3/4 angle so the
        // UI highlight (which the host page resets to 3/4 on every vehicle
        // pick) always matches what the camera is doing.
        currentViewName = 'threequarter';
        // Re-fit camera + shadow camera using the vehicle's actual bbox.
        const aspect = camera.aspect || 16/10;
        const view = frameForView(currentViewName, current, cameraFov, aspect);
        camera.position.set(...view.pos);
        controls.target.set(...view.target);
        // Distance bounds: tight enough to crop in on engines, loose enough
        // to take in the full pad complex with room to breathe.
        controls.minDistance = Math.max(view.dist * 0.18, 6);
        controls.maxDistance = view.dist * 5.0;
        fitShadowCameraToVehicle(current);

        // Capture camera/target Y for liftoff offset math.
        current.baseTargetY = controls.target.y;
        current.baseCamY    = camera.position.y;

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

        // Camera follow: target rises with the vehicle, camera position
        // rises by the same Δ so the user-chosen orbital framing is
        // preserved. lastAltitude tracks last-applied altitude so we only
        // shift by the *delta* each frame.
        const dy = s.altitude - current.lastAltitude;
        if (dy !== 0) {
            controls.target.y    += dy;
            camera.position.y    += dy;
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
        missionClock.start();
        missionActive = true;
        // Force plume on so you can actually see the engines fire.
        for (const p of current.plumes) p.visible = true;
        // Disable auto-rotate so we don't fight the camera follow.
        controls.autoRotate = false;
    }

    function cancelLiftoff() {
        if (!missionActive) return;
        missionActive = false;
        missionClock.reset();

        // Reset vehicle pose — including the per-frame vibration offset
        // and twang in X/Z that the launch loop accumulated.
        current.root.position.set(0, current.basePadY, 0);
        current.root.rotation.set(0, 0, 0);

        // Restore camera/target to where they were before liftoff.
        controls.target.y -= current.lastAltitude;
        camera.position.y -= current.lastAltitude;
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

    // ── Resize handling ────────────────────────────────────────────────────
    // Sized BEFORE the initial setVehicle so frameForView sees the correct
    // canvas aspect from the very first frame — otherwise the default 1:1
    // PerspectiveCamera aspect leads to a tall, low-margin fit on a 16:10
    // canvas and the rocket spills out the sides.
    function resize() {
        const w = canvas.clientWidth || 600;
        const h = canvas.clientHeight || 400;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

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
        clock.getDelta();
        const t = clock.elapsedTime;
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

        for (const p of current.plumes) tickPlume(p, t, throttle);
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

    // ── Public API ─────────────────────────────────────────────────────────
    function setView(name) {
        if (!VIEW_PRESETS[name]) return;
        currentViewName = name;
        const aspect = camera.aspect || 16/10;
        const view = frameForView(name, current, cameraFov, aspect);
        const fromPos = camera.position.toArray();
        const fromTgt = controls.target.toArray();
        const wasAuto = controls.autoRotate;
        controls.autoRotate = false;
        tween(fromPos, view.pos, 800, p => camera.position.set(p[0], p[1], p[2]));
        tween(fromTgt, view.target, 800, p => controls.target.set(p[0], p[1], p[2]),
              () => { controls.autoRotate = wasAuto; });
    }

    // Dolly along the current view direction without changing target.
    // factor < 1 zooms in (closer to subject); > 1 zooms out.
    function setZoom(factor) {
        const dir = camera.position.clone().sub(controls.target);
        const dist = dir.length();
        const next = THREE.MathUtils.clamp(dist * factor,
            controls.minDistance, controls.maxDistance);
        dir.setLength(next);
        camera.position.copy(controls.target).add(dir);
    }

    // Snap back to the vehicle-bbox center using the current preset; useful
    // after the user pans / orbits into deep space.
    function recenter() {
        setView(currentViewName || 'threequarter');
    }

    // FOV cycler: 28 (tele) → 38 (default) → 52 (wide). Acts like a lens
    // swap — we dolly the camera along its current axis so the subject
    // subtends the same vertical angle after the FOV change. That preserves
    // any panning the user has done instead of yanking them back to the
    // preset.
    function setFOV(deg) {
        const next = THREE.MathUtils.clamp(deg, 18, 80);
        if (Math.abs(next - cameraFov) < 0.5) return;
        const prevHalf = Math.tan((cameraFov * Math.PI / 180) / 2);
        const nextHalf = Math.tan((next      * Math.PI / 180) / 2);
        cameraFov = next;
        camera.fov = cameraFov;
        camera.updateProjectionMatrix();
        const dir = camera.position.clone().sub(controls.target);
        const dist = dir.length();
        const newDist = dist * (prevHalf / nextHalf);
        dir.setLength(THREE.MathUtils.clamp(newDist,
            controls.minDistance, controls.maxDistance));
        camera.position.copy(controls.target).add(dir);
    }
    function cycleFOV() {
        const cycle = [28, 38, 52];
        const i = cycle.findIndex(v => Math.abs(v - cameraFov) < 1);
        setFOV(cycle[(i + 1 + cycle.length) % cycle.length] || 38);
        return cameraFov;
    }

    function setPlume(on) {
        for (const p of current.plumes) p.visible = !!on;
    }
    function setPad(on)        { if (padState.root) padState.root.visible = !!on; }
    function setAutoRotate(on) { controls.autoRotate = !!on; }
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
