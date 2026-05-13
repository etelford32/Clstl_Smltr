/**
 * launch-engine-bell.js — Shared high-detail engine-bell builder.
 *
 * Replaces the simple lathe-cone "cylinder placeholders" in each vehicle
 * file. Every engine on every vehicle (RS-25, Raptor, Raptor-Vacuum,
 * Merlin 1D, Merlin-Vacuum, RSRM SRB) is built from the same primitive
 * set, parameterized by:
 *
 *   - Nozzle profile (Rao / conical / vacuum / standard de Laval) chosen
 *     per engine type. Profile is a Vector2 list rotated via LatheGeometry.
 *   - Regen-cooling tubes wrapping the bell exterior (TubeGeometry curves
 *     running axially from throat-flange to exit lip, one per tube angle).
 *   - Gimbal mount: ring around the throat + two cross-pin cylinders
 *     suggesting the universal-joint axes + two hydraulic-actuator stubs.
 *     RSRM solid motors still gimbal (the bell pivots in a flex bearing)
 *     so we keep the mount for them, but no tubes (ablative-cooled).
 *   - Powerhead: turbopump block + plumbing ring above the gimbal.
 *
 * Detail levels:
 *   'high'   — full set (24 tubes, full gimbal + actuators, powerhead).
 *               Use for low-engine-count vehicles: 3 SSMEs, 1 MVac.
 *   'medium' — 14 tubes, gimbal cross-pins only, simpler powerhead.
 *               Use for 9-Merlin octaweb, Ship's 3-6 sea-level Raptors.
 *   'low'    — bell + hot glow only. Use for Super Heavy's 33-engine
 *               cluster where individual engines are mostly dots.
 *
 * Public API:
 *   buildEngineBell({
 *     type:      'rs25' | 'raptor' | 'raptor_vac' | 'merlin' | 'merlin_vac'
 *              | 'rsrm' | 'generic',
 *     throatR, exitR, length,            // override defaults
 *     bellColor, tubeColor, hotColor,    // override colors
 *     detail:    'high' | 'medium' | 'low',
 *     gimbal:    boolean,                // include the mount + actuators
 *     powerhead: boolean,                // include the turbopump block
 *   }) → THREE.Group
 */

import * as THREE from 'three';

// ── Profile generators ──────────────────────────────────────────────────────
// Each profile returns Vector2[] of (radius, y) points from throat (y=0,
// r=throatR) to exit (y=-length, r=exitR). LatheGeometry sweeps the profile
// around Y to produce the bell.

function bellProfile(throatR, exitR, length, type, N = 22) {
    const pts = [];
    for (let i = 0; i <= N; i++) {
        const t = i / N;
        let f;
        switch (type) {
            case 'rao':
                // Rao optimum nozzle — sharp expansion just past the throat,
                // then flattens out toward a parallel-flow exit. Used for
                // high-performance liquid bells (RS-25, Raptor 2/3).
                f = Math.pow(1 - Math.pow(1 - t, 2.4), 0.7);
                break;
            case 'vacuum':
                // High-expansion-ratio bells (Merlin Vacuum, Raptor Vacuum).
                // Even more aggressive flare for low-pressure flow.
                f = Math.pow(t, 0.42);
                break;
            case 'conical':
                // Solid-motor / ablative nozzle (RSRM). Nearly straight cone.
                f = Math.pow(t, 0.9);
                break;
            default:
                // Standard de Laval bell — moderate curve.
                f = Math.pow(t, 0.55);
        }
        pts.push(new THREE.Vector2(throatR + (exitR - throatR) * f, -t * length));
    }
    return pts;
}

// ── Engine-type presets ─────────────────────────────────────────────────────

const PRESETS = {
    rs25: {       // Shuttle Main Engine — long Rao bell, very high expansion ratio.
        profile:    'rao',
        throatR:    0.32,
        exitR:      0.95,
        length:     1.95,
        bellColor:  0x2c2c30,
        tubeColor:  0x4a3522,
        hotColor:   0x6a4f30,
    },
    raptor: {     // SpaceX Raptor 2/3 — full-flow staged combustion, shorter bell.
        profile:    'rao',
        throatR:    0.40,
        exitR:      0.65,
        length:     1.25,
        bellColor:  0x32302e,
        tubeColor:  0x3a2818,
        hotColor:   0x8a5530,
    },
    raptor_vac: { // Raptor Vacuum — much larger expansion ratio.
        profile:    'vacuum',
        throatR:    0.40,
        exitR:      1.05,
        length:     1.85,
        bellColor:  0x32302e,
        tubeColor:  0x3a2818,
        hotColor:   0x8a5530,
    },
    merlin: {     // Merlin 1D (sea level) — gas-generator cycle.
        profile:    'standard',
        throatR:    0.18,
        exitR:      0.46,
        length:     1.95,
        bellColor:  0x2a2a2c,
        tubeColor:  0x4a3522,
        hotColor:   0xa05030,
    },
    merlin_vac: { // Merlin Vacuum — much larger exit area, niobium-alloy nozzle extension.
        profile:    'vacuum',
        throatR:    0.22,
        exitR:      0.92,
        length:     3.00,
        bellColor:  0x4a3a2a,             // niobium has a warmer tint than steel
        tubeColor:  0x4a3522,
        hotColor:   0xa05030,
    },
    rsrm: {       // Shuttle SRB — solid-motor ablative nozzle, no regen cooling.
        profile:    'conical',
        throatR:    0.55,
        exitR:      1.55,
        length:     2.40,
        bellColor:  0x33302a,
        tubeColor:  0x33302a,             // (no tubes drawn, but kept for API)
        hotColor:   0x885530,
    },
    generic: {
        profile:    'standard',
        throatR:    0.30,
        exitR:      0.80,
        length:     1.80,
        bellColor:  0x2c2c30,
        tubeColor:  0x4a3522,
        hotColor:   0x6a4f30,
    },
};

// ── Geometry helpers ────────────────────────────────────────────────────────

function buildBell(profilePts, color) {
    const geo = new THREE.LatheGeometry(profilePts, 36);
    geo.computeVertexNormals();
    const mat = new THREE.MeshPhysicalMaterial({
        color,
        roughness: 0.32,
        metalness: 0.62,
        clearcoat: 0.4,
        clearcoatRoughness: 0.35,
        side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    return mesh;
}

// Inner glow ring — a slightly smaller lathe with BackSide so the inside of
// the bell shows a hot tint. Reads as "engine ready to fire" without needing
// to enable the full plume.
function buildHotGlow(profilePts, color) {
    const inner = profilePts.map(p => new THREE.Vector2(p.x * 0.92, p.y + 0.04));
    const geo = new THREE.LatheGeometry(inner, 24);
    return new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color, side: THREE.BackSide })
    );
}

// One regen tube — a TubeGeometry following the bell profile at a fixed
// azimuth, offset outward by tubeOffset so it sits proud of the bell wall.
function buildOneTube(profilePts, angle, tubeR, tubeOffset, mat) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const pts3 = profilePts.map(p => new THREE.Vector3(
        (p.x + tubeOffset) * cos,
        p.y,
        (p.x + tubeOffset) * sin,
    ));
    const curve = new THREE.CatmullRomCurve3(pts3);
    const geo = new THREE.TubeGeometry(curve, 18, tubeR, 5, false);
    return new THREE.Mesh(geo, mat);
}

function buildRegenTubes(profilePts, count, color, tubeR = 0.018, tubeOffset = 0.022) {
    const g = new THREE.Group();
    g.name = 'RegenTubes';
    const mat = new THREE.MeshStandardMaterial({
        color,
        metalness: 0.45,
        roughness: 0.55,
    });
    for (let i = 0; i < count; i++) {
        g.add(buildOneTube(profilePts, (i / count) * Math.PI * 2, tubeR, tubeOffset, mat));
    }
    // Brazed manifold rings at the throat and exit — small tori that bind
    // the tubes together visually.
    const ringMat = new THREE.MeshStandardMaterial({
        color: 0x1a1a1c, metalness: 0.7, roughness: 0.4,
    });
    const throatR = profilePts[0].x + tubeOffset;
    const exitR   = profilePts[profilePts.length - 1].x + tubeOffset;
    const exitY   = profilePts[profilePts.length - 1].y;
    const throatRing = new THREE.Mesh(
        new THREE.TorusGeometry(throatR, tubeR * 1.4, 6, 28),
        ringMat,
    );
    throatRing.rotation.x = Math.PI / 2;
    throatRing.position.y = 0;
    g.add(throatRing);
    const exitRing = new THREE.Mesh(
        new THREE.TorusGeometry(exitR, tubeR * 1.4, 6, 28),
        ringMat,
    );
    exitRing.rotation.x = Math.PI / 2;
    exitRing.position.y = exitY;
    g.add(exitRing);
    return g;
}

// Gimbal mount sits at the very top of the bell (throat plane), with:
//   - A torus ring around the throat (the gimbal bearing)
//   - Two perpendicular cross-pin cylinders (the universal joint axes)
//   - Two hydraulic actuator stubs offset at 45° (the TVC actuators that
//     pitch/yaw the bell)
function buildGimbalMount(throatR, detail = 'high') {
    const g = new THREE.Group();
    g.name = 'Gimbal';
    const matDark = new THREE.MeshStandardMaterial({
        color: 0x222024, metalness: 0.85, roughness: 0.32,
    });
    const matBronze = new THREE.MeshStandardMaterial({
        color: 0x6a4a26, metalness: 0.75, roughness: 0.4,
    });

    // Bearing ring around the throat
    const ring = new THREE.Mesh(
        new THREE.TorusGeometry(throatR * 1.05, throatR * 0.16, 8, 22),
        matDark,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = throatR * 0.08;
    g.add(ring);

    // Cross-pin cylinders (perpendicular universal-joint axes)
    for (let i = 0; i < 2; i++) {
        const pin = new THREE.Mesh(
            new THREE.CylinderGeometry(throatR * 0.10, throatR * 0.10, throatR * 2.6, 10),
            matBronze,
        );
        pin.rotation.z = Math.PI / 2;
        pin.rotation.y = i * Math.PI / 2;
        pin.position.y = throatR * 0.18;
        g.add(pin);
    }

    if (detail === 'high') {
        // Hydraulic actuator stubs at 45° — the visible TVC piston rods.
        for (let i = 0; i < 2; i++) {
            const a = (i * Math.PI) + Math.PI / 4;
            const stub = new THREE.Mesh(
                new THREE.CylinderGeometry(throatR * 0.09, throatR * 0.13, throatR * 1.7, 10),
                matDark,
            );
            stub.position.set(
                Math.cos(a) * throatR * 1.6,
                throatR * 0.9,
                Math.sin(a) * throatR * 1.6,
            );
            stub.rotation.z = -Math.cos(a) * 0.55;
            stub.rotation.x =  Math.sin(a) * 0.55;
            g.add(stub);
        }
    }

    return g;
}

// Powerhead — the turbopump / preburner block that sits above the gimbal.
// On a real RS-25 this is a ~1 m tall assembly of pumps, valves, and
// plumbing. We hint at it with a tapered cylinder + plumbing rings.
function buildPowerhead(throatR, detail = 'high') {
    const g = new THREE.Group();
    g.name = 'Powerhead';
    const matBody = new THREE.MeshStandardMaterial({
        color: 0x3a3530, metalness: 0.7, roughness: 0.4,
    });
    const matRing = new THREE.MeshStandardMaterial({
        color: 0x554f3e, metalness: 0.9, roughness: 0.32,
    });

    const headH = throatR * 2.2;
    const headR = throatR * 1.45;
    const block = new THREE.Mesh(
        new THREE.CylinderGeometry(headR, headR * 0.85, headH, 18),
        matBody,
    );
    block.position.y = headH * 0.5 + throatR * 0.4;
    block.castShadow = true;
    g.add(block);

    if (detail === 'high') {
        // Plumbing rings — two tori around the powerhead block at different heights.
        for (let i = 0; i < 2; i++) {
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(headR * 1.05, throatR * 0.08, 6, 20),
                matRing,
            );
            ring.rotation.x = Math.PI / 2;
            ring.position.y = throatR * 0.6 + headH * (0.25 + i * 0.5);
            g.add(ring);
        }
        // Two feed-line stubs on opposite sides (the LH2 / LO2 inlets).
        for (let i = 0; i < 2; i++) {
            const a = i * Math.PI;
            const feed = new THREE.Mesh(
                new THREE.CylinderGeometry(throatR * 0.18, throatR * 0.18, throatR * 0.7, 10),
                matRing,
            );
            feed.position.set(
                Math.cos(a) * headR * 1.05,
                throatR * 0.4 + headH * 0.8,
                Math.sin(a) * headR * 1.05,
            );
            feed.rotation.z = Math.PI / 2;
            feed.rotation.y = -a;
            g.add(feed);
        }
    }

    return g;
}

// ── Per-engine plumbing ─────────────────────────────────────────────────────
// Two feed lines (fuel + oxidizer) extending UP from the powerhead crown,
// each routed via a TubeGeometry curve with a 90° bend so it doesn't look
// like a straight stick, terminating in a flange/connector at the top.
//
// In real hardware these are the LH2 + LO2 (SSME), CH4 + LO2 (Raptor),
// or RP-1 + LO2 (Merlin) lines that route from the propellant tanks down
// through the thrust structure to each engine's preburner. We don't
// render the full route — just the visible last meter or two above the
// powerhead — but it's enough to break up the silhouette.

function buildEnginePlumbing(throatR, headY) {
    const g = new THREE.Group();
    g.name = 'Plumbing';

    const fuelMat = new THREE.MeshStandardMaterial({
        color: 0x6a7a8a,           // chrome / brushed steel cryo line
        metalness: 0.65, roughness: 0.4,
    });
    const oxMat = new THREE.MeshStandardMaterial({
        color: 0x9aa8b8,           // lighter LOX line
        metalness: 0.7, roughness: 0.35,
    });
    const flangeMat = new THREE.MeshStandardMaterial({
        color: 0x4a4438, metalness: 0.9, roughness: 0.3,
    });

    const pipeR  = throatR * 0.20;
    const liftH  = throatR * 4.5;     // total height above the powerhead crown
    const bendY  = throatR * 1.0;     // elbow height above the powerhead
    const inX    = throatR * 0.85;    // attachment X on the powerhead
    const outX   = throatR * 1.55;    // final feed-flange X (offset outward)

    for (let i = 0; i < 2; i++) {
        const side = i === 0 ? -1 : 1;
        const mat  = i === 0 ? fuelMat : oxMat;

        // CatmullRom curve through 4 points: attach → vertical → elbow → top
        const pts = [
            new THREE.Vector3(side * inX,  headY,                  0),
            new THREE.Vector3(side * inX,  headY + bendY,          0),
            new THREE.Vector3(side * outX, headY + bendY + throatR * 0.5, 0),
            new THREE.Vector3(side * outX, headY + liftH,          0),
        ];
        const curve = new THREE.CatmullRomCurve3(pts);
        const tube = new THREE.Mesh(
            new THREE.TubeGeometry(curve, 24, pipeR, 10, false),
            mat,
        );
        tube.castShadow = true;
        g.add(tube);

        // Flange at the top — short fat cylinder, suggests a bolt-up connector.
        const flange = new THREE.Mesh(
            new THREE.CylinderGeometry(pipeR * 1.5, pipeR * 1.5, pipeR * 0.8, 16),
            flangeMat,
        );
        flange.position.set(side * outX, headY + liftH, 0);
        g.add(flange);

        // Attach collar at the powerhead crown — small torus suggesting the
        // socket weld where the pipe joins the engine.
        const collar = new THREE.Mesh(
            new THREE.TorusGeometry(pipeR * 1.4, pipeR * 0.3, 6, 14),
            flangeMat,
        );
        collar.rotation.x = Math.PI / 2;
        collar.position.set(side * inX, headY + pipeR * 0.3, 0);
        g.add(collar);
    }

    return g;
}

// ── Cluster thrust-frame manifold ───────────────────────────────────────────
// A single central plenum + horizontal ring sitting above the engine plate.
// Visually this is the "thrust frame" that ties all the engines into one
// structure on a cluster like the Falcon 9 octaweb or Super Heavy. Call
// once per cluster, AFTER you've placed the engines.
//
// Options:
//   plateRadius — outer radius of the engine plate
//   centerY     — vertical offset above the plate (where the ring sits)
//   engineCount — drives the ring's tessellation
//   copvs       — render COPV (composite overwrap pressure vessel) helium
//                  bottles around the central plenum (true for Raptor
//                  clusters, false for kerolox)
//   style       — 'cryo' (LH2/LOX/CH4) or 'kerolox' (RP-1/LO2); just
//                  changes the manifold color tint.

// Tank dome cap — bulges DOWN over the engine bay (it's the bottom of the
// propellant tank above). Built as a LatheGeometry with the profile going
// from (0,0) at the tip (lowest point) up to (radius, height) at the outer
// edge where the dome meets the cylindrical tank wall. Sump fitting +
// anti-vortex baffle + radial feed-line penetrations make it read as a
// real tank bottom rather than a smooth shell.
function buildTankDomeCap({ radius, height, color, feedPenetrations = 6 }) {
    const g = new THREE.Group();
    g.name = 'TankDome';

    // Dome profile — quarter-ellipse from tip (axis, low) to edge (rim, high).
    const profile = [];
    const N = 18;
    for (let i = 0; i <= N; i++) {
        const t = i / N;
        const a = t * Math.PI / 2;
        profile.push(new THREE.Vector2(
            radius * Math.sin(a),
            height * (1 - Math.cos(a)),
        ));
    }
    // Close the bottom rim of the dome so the underside reads as a solid
    // shell, not an open cone — add the axis point.
    profile.unshift(new THREE.Vector2(0, 0));

    const domeMat = new THREE.MeshStandardMaterial({
        color,
        metalness: 0.55,
        roughness: 0.55,
        side: THREE.DoubleSide,
    });
    const dome = new THREE.Mesh(
        new THREE.LatheGeometry(profile, 40),
        domeMat,
    );
    dome.castShadow = true;
    dome.receiveShadow = true;
    g.add(dome);

    // Central sump — small cylindrical fitting at the dome tip. This is
    // the main propellant outlet on a real tank, where the fluid pools
    // and exits down through a feed line.
    const sumpR = radius * 0.12;
    const sumpH = radius * 0.16;
    const fittingMat = new THREE.MeshStandardMaterial({
        color: 0x554f3e, metalness: 0.85, roughness: 0.32,
    });
    const sump = new THREE.Mesh(
        new THREE.CylinderGeometry(sumpR, sumpR * 0.85, sumpH, 18),
        fittingMat,
    );
    sump.position.y = -sumpH / 2;
    sump.castShadow = true;
    g.add(sump);

    // Anti-vortex baffle — a small ring around the sump that prevents
    // bathtub-drain vortices from forming as propellant drains during burn.
    const baffleR = sumpR * 1.95;
    const baffle = new THREE.Mesh(
        new THREE.TorusGeometry(baffleR, sumpR * 0.14, 6, 22),
        new THREE.MeshStandardMaterial({
            color: 0x33312a, metalness: 0.8, roughness: 0.4,
        }),
    );
    baffle.rotation.x = Math.PI / 2;
    baffle.position.y = -sumpR * 0.2;
    g.add(baffle);

    // Radial feed-line penetrations — small cylindrical flanges on the
    // dome where individual engine-feed lines exit. Positioned at 0.62×
    // dome radius so they read as "between" the central sump and the
    // outer wall.
    if (feedPenetrations > 0) {
        const ringR = radius * 0.62;
        // Y on the dome surface at radial ringR — invert the profile.
        // height * (1 - cos(a)) where sin(a) = ringR/radius → cos(a) = √(1-(ringR/radius)²)
        const sinA = ringR / radius;
        const cosA = Math.sqrt(Math.max(0, 1 - sinA * sinA));
        const ringY = height * (1 - cosA);
        const penR = sumpR * 0.45;
        const penH = sumpR * 1.2;
        for (let i = 0; i < feedPenetrations; i++) {
            const a = (i / feedPenetrations) * Math.PI * 2;
            // Flange disc flush against dome surface
            const flange = new THREE.Mesh(
                new THREE.CylinderGeometry(penR * 1.6, penR * 1.6, penR * 0.4, 14),
                fittingMat,
            );
            flange.position.set(Math.cos(a) * ringR, ringY, Math.sin(a) * ringR);
            g.add(flange);
            // Short stub protruding through (the pipe outlet below the dome)
            const stub = new THREE.Mesh(
                new THREE.CylinderGeometry(penR, penR, penH, 10),
                fittingMat,
            );
            stub.position.set(Math.cos(a) * ringR, ringY - penH / 2 - penR * 0.2, Math.sin(a) * ringR);
            g.add(stub);
        }
    }

    return g;
}

export function buildClusterManifold({
    plateRadius,
    centerY    = 0.5,
    engineCount = 9,
    copvs      = false,
    style      = 'cryo',
    tankDome   = true,                   // render the tank dome cap above the manifold
    domeColor,                           // override default per-style
    domeHeight,                          // override default
} = {}) {
    const g = new THREE.Group();
    g.name = 'ClusterManifold';

    const ringMat = new THREE.MeshStandardMaterial({
        color: style === 'kerolox' ? 0x6a5a48 : 0x6a7a8a,
        metalness: 0.7, roughness: 0.4,
    });
    const plenumMat = new THREE.MeshStandardMaterial({
        color: 0x2a2a32, metalness: 0.75, roughness: 0.4,
    });

    // Horizontal manifold ring — sits above the engine-plate radius slightly
    // inside it. Connects to each engine's plumbing flange.
    const ringR = plateRadius * 0.78;
    const ring = new THREE.Mesh(
        new THREE.TorusGeometry(ringR, plateRadius * 0.04, 8, Math.max(24, engineCount * 3)),
        ringMat,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = centerY;
    ring.castShadow = true;
    g.add(ring);

    // Central plenum — small dome at axis. Hints at the "main propellant
    // distribution" plenum that the per-engine feed lines branch off of.
    const plenumR = plateRadius * 0.16;
    const plenum = new THREE.Mesh(
        new THREE.SphereGeometry(plenumR, 18, 14, 0, Math.PI * 2, 0, Math.PI / 2),
        plenumMat,
    );
    plenum.position.y = centerY + plateRadius * 0.02;
    plenum.castShadow = true;
    g.add(plenum);

    // Radial spokes from plenum to ring (the visible structural ribs that
    // tie the central plenum to the outer manifold; on a Falcon octaweb
    // this is the iconic spider-web look).
    const spokeMat = new THREE.MeshStandardMaterial({
        color: 0x1a1a1f, metalness: 0.85, roughness: 0.3,
    });
    const spokeCount = Math.min(8, engineCount);
    for (let i = 0; i < spokeCount; i++) {
        const a = (i / spokeCount) * Math.PI * 2;
        const len = ringR - plenumR;
        const spoke = new THREE.Mesh(
            new THREE.BoxGeometry(len, plateRadius * 0.05, plateRadius * 0.04),
            spokeMat,
        );
        spoke.position.set(
            Math.cos(a) * (plenumR + len / 2),
            centerY,
            Math.sin(a) * (plenumR + len / 2),
        );
        spoke.rotation.y = -a;
        g.add(spoke);
    }

    // Tank dome cap — bottom of the propellant tank, bulging down over
    // the engine bay. Positioned with its tip just above the manifold
    // ring so the dome's underside is what the user sees when looking up
    // through the engines.
    if (tankDome) {
        const dRadius = plateRadius * 0.95;
        const dHeight = domeHeight ?? plateRadius * 0.42;
        const dColor  = domeColor ?? (style === 'kerolox'
            ? 0x9c9a96             // RP-1 tank — matte alloy
            : 0xc8cdd3);           // cryo tank — stainless / aluminum
        const dome = buildTankDomeCap({
            radius:           dRadius,
            height:           dHeight,
            color:            dColor,
            feedPenetrations: engineCount > 9 ? 8 : 6,
        });
        dome.position.y = centerY + plateRadius * 0.08;
        g.add(dome);
    }

    // COPVs — composite pressure vessels around the central plenum. Real
    // Super Heavy has these visibly arranged at the base. Off-white tone.
    if (copvs) {
        const copvMat = new THREE.MeshStandardMaterial({
            color: 0xe0d8c0, metalness: 0.25, roughness: 0.55,
        });
        const copvCapMat = new THREE.MeshStandardMaterial({
            color: 0x5a564a, metalness: 0.7, roughness: 0.4,
        });
        const copvR = plateRadius * 0.04;
        const copvLen = plateRadius * 0.22;
        const ringForCopvs = plateRadius * 0.34;
        const count = 12;
        for (let i = 0; i < count; i++) {
            const a = (i / count) * Math.PI * 2;
            const cyl = new THREE.Mesh(
                new THREE.CylinderGeometry(copvR, copvR, copvLen, 14),
                copvMat,
            );
            cyl.position.set(
                Math.cos(a) * ringForCopvs,
                centerY + copvLen * 0.2,
                Math.sin(a) * ringForCopvs,
            );
            g.add(cyl);
            // Hemispheric caps
            const capTop = new THREE.Mesh(
                new THREE.SphereGeometry(copvR, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
                copvCapMat,
            );
            capTop.position.set(cyl.position.x, cyl.position.y + copvLen / 2, cyl.position.z);
            g.add(capTop);
        }
    }

    return g;
}

// ── Public ──────────────────────────────────────────────────────────────────

export function buildEngineBell(opts = {}) {
    const type   = opts.type || 'generic';
    const preset = PRESETS[type] || PRESETS.generic;

    const throatR   = opts.throatR   ?? preset.throatR;
    const exitR     = opts.exitR     ?? preset.exitR;
    const length    = opts.length    ?? preset.length;
    const bellColor = opts.bellColor ?? preset.bellColor;
    const tubeColor = opts.tubeColor ?? preset.tubeColor;
    const hotColor  = opts.hotColor  ?? preset.hotColor;
    const detail    = opts.detail    ?? 'high';

    // RSRM solid motor has no regen tubes (ablative-cooled nozzle).
    const hasTubes  = (opts.tubes ?? (type !== 'rsrm')) && detail !== 'low';
    const hasGimbal = opts.gimbal    ?? (detail !== 'low');
    const hasPowerhead = opts.powerhead ?? (detail === 'high');

    const tubeCount = opts.tubeCount ?? (detail === 'high' ? 24 : detail === 'medium' ? 14 : 0);

    const g = new THREE.Group();
    g.name = `EngineBell:${type}`;

    const pts = bellProfile(throatR, exitR, length, preset.profile);

    g.add(buildBell(pts, bellColor));
    g.add(buildHotGlow(pts, hotColor));
    if (hasTubes && tubeCount > 0) {
        // Tube radius / offset scale with throat so tubes look proportional
        // on a tiny Merlin and a fat Raptor alike.
        g.add(buildRegenTubes(
            pts,
            tubeCount,
            tubeColor,
            throatR * 0.055,
            throatR * 0.075,
        ));
    }
    if (hasGimbal)    g.add(buildGimbalMount(throatR, detail));
    if (hasPowerhead) g.add(buildPowerhead(throatR, detail));

    // Per-engine plumbing — two feed lines extending from the powerhead
    // crown up to a flange. Adds the "thrust frame manifold" look the user
    // sees on real engine bays. Skipped on solid motors (no plumbing) and
    // on 'low' detail (cluster filler engines).
    const hasPlumbing = opts.plumbing ?? (detail !== 'low' && type !== 'rsrm');
    if (hasPlumbing) {
        // Powerhead top y ≈ throatR * 0.4 (gimbal offset) + headH (powerhead
        // height) = throatR * (0.4 + 2.2) = throatR * 2.6. Match buildPowerhead.
        const headY = throatR * 2.6;
        g.add(buildEnginePlumbing(throatR, headY));
    }

    return g;
}
