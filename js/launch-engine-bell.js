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

    return g;
}
