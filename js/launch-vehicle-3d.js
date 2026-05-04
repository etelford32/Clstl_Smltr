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
    // the nose. Windows: 6 dark wedge panels on the front face of the hump.
    const cockpit = new THREE.Mesh(
        new THREE.SphereGeometry(R * 0.95, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.55),
        mkMat(COLORS.orbiterWhite, { roughness: 0.5 })
    );
    cockpit.position.set(0, L * 0.31, R * 0.55);
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
    // 6 forward windows in two rows of three.
    const winGeo = new THREE.BoxGeometry(0.8, 0.55, 0.2);
    for (let row = 0; row < 2; row++) {
        for (let col = -1; col <= 1; col++) {
            const w = new THREE.Mesh(winGeo, winMat);
            const yOff = L * 0.31 + 0.55 + row * 0.6;
            const xOff = col * 0.95;
            w.position.set(xOff, yOff, R * 1.32);
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
    for (const xSign of [-1, 1]) {
        const oms = new THREE.Mesh(
            new THREE.CapsuleGeometry(0.85, 3.4, 8, 16),
            mkMat(COLORS.orbiterWhite, { roughness: 0.5 })
        );
        oms.rotation.x = Math.PI / 2;
        oms.position.set(xSign * 1.7, -L * 0.40, R * 0.5);
        oms.castShadow = true;
        g.add(oms);
    }

    // Body flap — small box hanging below the SSMEs.
    const bodyFlap = new THREE.Mesh(
        new THREE.BoxGeometry(R * 1.6, 0.4, 1.6),
        mkMat(COLORS.tile, { roughness: 0.85 })
    );
    bodyFlap.position.set(0, -L * 0.49, -R * 0.4);
    bodyFlap.castShadow = true;
    g.add(bodyFlap);

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

// ── Engine plume (animated) ──────────────────────────────────────────────────
// Three nested additive cones: hot core (white-yellow), mid (orange), outer
// (smoky tail). Their lengths and opacities flicker via setters in the tick
// loop. Plume only renders when enabled — call setPlume(true).

function buildPlume() {
    const g = new THREE.Group();
    g.name = 'Plume';
    g.visible = false;     // off by default; toggled by UI

    const layers = [
        { color: COLORS.plumeCore,  r: 0.4,  len: 18, opacity: 0.95 },
        { color: COLORS.plumeMid,   r: 0.8,  len: 26, opacity: 0.55 },
        { color: COLORS.plumeOuter, r: 1.4,  len: 36, opacity: 0.25 },
    ];

    for (const L of layers) {
        const cone = new THREE.Mesh(
            new THREE.ConeGeometry(L.r, L.len, 28, 1, true),
            new THREE.MeshBasicMaterial({
                color: L.color,
                transparent: true,
                opacity: L.opacity,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
            })
        );
        // Cone default has tip at +Y and base at -Y; we want plume going DOWN
        // (-Y) from a position attached to engine bell exits.
        cone.rotation.x = Math.PI;
        cone.position.y = -L.len / 2;
        cone.userData.baseOpacity = L.opacity;
        cone.userData.baseLen = L.len;
        g.add(cone);
    }
    return g;
}

function tickPlume(plume, t, throttle = 1) {
    if (!plume.visible) return;
    // Subtle flicker — 4 Hz core, 2 Hz outer, slight phase.
    // Throttle drives length + width + opacity together so the plume
    // visibly shrinks during a max-Q throttle bucket and grows back.
    const wMul = 0.25 + 0.75 * throttle;       // never quite zero so the
                                                // bell isn't visibly bare
    const lMul = 0.30 + 0.70 * throttle;
    plume.children.forEach((cone, i) => {
        const flicker = 1 + Math.sin(t * (4 - i) * 1.5 + i) * 0.04;
        const w = wMul * flicker;
        cone.scale.set(w, lMul, w);
        cone.material.opacity = cone.userData.baseOpacity * throttle *
            (0.92 + Math.sin(t * (6 - i) + i * 2) * 0.08);
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

    const trail = new THREE.Mesh(
        // Open-ended cylinder; UVs map vertical → V so the gradient runs
        // top→bottom along the column. Default cylinder geometry has its
        // "top" at +Y, which we orient as "near the rocket" by flipping.
        new THREE.CylinderGeometry(1, 1, 1, 24, 1, true),
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
    orbiter.position.set(0, DIM.ORBITER_LEN * 0.5 + 0.5, DIM.ET_R + DIM.ORBITER_FUSE_R + 0.4);
    stack.add(orbiter);

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
    // orbiter mounted at stack-y = L*0.5 + 0.5, that puts the cluster exit at
    // stack-y ≈ -0.05. Round to 0 and offset the plume base by a small gap.
    const ssmeP = buildPlume();
    ssmeP.position.set(0, 0.0, DIM.ET_R + DIM.ORBITER_FUSE_R + 0.4);
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
// Presets are *ratios* of the current vehicle's stack height, plus an offset
// from the stack base, so the same preset frames a 56 m shuttle on its MLP
// and a 150 m starship on the OLM equally well. setView() re-evaluates
// these for the active vehicle each call.
//
// Each ratio is interpreted as:
//   pos.y  →  baseY + posY * height
//   target →  baseY + targetYFrac * height
// where baseY is the world-Y of the vehicle's base (top of MLP / OLM table).

const VIEW_RATIOS = {
    threequarter: { pos: [1.10, 0.65, 1.40], targetYFrac: 0.45 },
    front:        { pos: [0.0,  0.55, 2.20], targetYFrac: 0.45 },
    side:         { pos: [2.20, 0.55, 0.0],  targetYFrac: 0.45 },
    top:          { pos: [0.0,  3.00, 0.001], targetYFrac: 0.4 },
    closeup:      { pos: [0.55, 0.35, 0.70], targetYFrac: 0.20 },
};

function viewForVehicle(name, vehicle) {
    const v = VIEW_RATIOS[name];
    if (!v) return null;
    const h = vehicle.height;
    const baseY = vehicle.root.position.y;
    return {
        pos:    [v.pos[0] * h, baseY + v.pos[1] * h, v.pos[2] * h],
        target: [0, baseY + v.targetYFrac * h, 0],
    };
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
    return {
        root,
        plumes: root.userData.plumes,
        height,
        padId: 'lc39a',
        info: {
            name:           'Space Shuttle (STS)',
            years:          '1981 — 2011',
            height_m:       '56.1',
            diameter_m:     '8.4 (ET)',
            booster_engines:'2 SRBs',
            ship_engines:   '3 SSMEs',
            liftoff_mass_t: '2,030',
            leo_payload_t:  '27.5',
            pad:            'KSC LC-39A',
            notes:          '135 missions, ISS construction, Hubble servicing.',
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

    const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 8000);

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

    // ── Mission clock (drives liftoff animation) ──────────────────────────
    const missionClock = createMissionClock();
    let missionActive = false;
    // Save baseline scene parameters so we can restore after a flight.
    const baseFogColor   = scene.fog.color.clone();
    const baseFogDensity = scene.fog.density;
    const skyEndColor    = new THREE.Color(0x040614);

    // ── Pad (replaced per vehicle in setVehicle) ──────────────────────────
    let padState = { root: null, beacons: [] };

    function swapPad(padId) {
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
        const built = buildPadInfra(padId || 'generic');
        scene.add(built.root);
        padState = built;
    }

    // ── OrbitControls ──────────────────────────────────────────────────────
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.95;
    controls.autoRotate = opts.autoRotate ?? true;
    controls.autoRotateSpeed = 0.45;

    // ── Vehicle state (mutable — replaced by setVehicle) ───────────────────
    let current = {
        id: null,
        variant: null,
        root: null,
        plumes: [],
        height: 1,
        info: null,
        // Mutated each frame during liftoff:
        basePadY: 0,         // pad-top Y captured on vehicle build
        baseTargetY: 0,      // controls.target.y captured on vehicle build
        baseCamY: 0,         // camera.position.y captured on vehicle build
        lastAltitude: 0,
        trailWidthM: 9,      // pad-specific trail width
    };

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
        // Aim the key light at the middle of the stack.
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
        current = {
            id, variant, ...v,
            basePadY: v.root.position.y,
            baseTargetY: 0,
            baseCamY: 0,
            lastAltitude: 0,
            // Per-pad trail width — wider for Stage 0's 33-engine cluster.
            trailWidthM: (v.padId === 'mechazilla') ? 14 : 9,
        };
        scene.add(v.root);

        // Swap pad infrastructure to whichever site this vehicle flies from.
        swapPad(v.padId);

        // Re-fit camera + shadow camera to the new height + base.
        const view = viewForVehicle('threequarter', current);
        camera.position.set(...view.pos);
        controls.target.set(...view.target);
        controls.minDistance = v.height * 0.45;
        controls.maxDistance = v.height * 4.5;
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
        // Vehicle pose
        current.root.position.y = current.basePadY + s.altitude;
        current.root.rotation.y = s.roll;
        current.root.rotation.x = -s.pitch;

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

        // Sky / fog — tint toward upper-atmosphere black + clear out fog
        // density as the rocket climbs.
        scene.fog.color.copy(baseFogColor).lerp(skyEndColor, s.skyMix);
        scene.fog.density = baseFogDensity * (1 - 0.75 * s.skyMix);

        // Pad fade
        applyPadOpacity(s.padOpacity);
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

        // Reset vehicle pose
        current.root.position.y = current.basePadY;
        current.root.rotation.set(0, 0, 0);

        // Restore camera/target to where they were before liftoff.
        controls.target.y -= current.lastAltitude;
        camera.position.y -= current.lastAltitude;
        current.lastAltitude = 0;

        // Restore scene state
        trail.visible = false;
        scene.fog.color.copy(baseFogColor);
        scene.fog.density = baseFogDensity;
        applyPadOpacity(1);

        // Note: we leave plume + auto-rotate to whatever the user toggles.
        // The UI button-state listener flips its own label.
        if (typeof opts.onLiftoffEnd === 'function') opts.onLiftoffEnd();
    }

    // Initial vehicle.
    setVehicle(opts.vehicle || 'shuttle', opts.variant);

    // ── Resize handling ────────────────────────────────────────────────────
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
        renderer.render(scene, camera);
        rafId = requestAnimationFrame(tick);
    }
    tick();

    // ── Public API ─────────────────────────────────────────────────────────
    function setView(name) {
        const view = viewForVehicle(name, current);
        if (!view) return;
        const fromPos = camera.position.toArray();
        const fromTgt = controls.target.toArray();
        const wasAuto = controls.autoRotate;
        controls.autoRotate = false;
        tween(fromPos, view.pos, 800, p => camera.position.set(p[0], p[1], p[2]));
        tween(fromTgt, view.target, 800, p => controls.target.set(p[0], p[1], p[2]),
              () => { controls.autoRotate = wasAuto; });
    }

    function setPlume(on) {
        for (const p of current.plumes) p.visible = !!on;
    }
    function setPad(on)        { if (padState.root) padState.root.visible = !!on; }
    function setAutoRotate(on) { controls.autoRotate = !!on; }

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
        setVehicle,
        liftoff,
        cancelLiftoff,
        get isAscending() { return missionActive; },
        get missionT()    { return missionClock.T; },
        get currentInfo() { return current.info; },
    };
}
