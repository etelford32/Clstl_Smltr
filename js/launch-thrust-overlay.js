/**
 * launch-thrust-overlay.js — Per-engine thrust-vector visualization.
 *
 * A toggleable physics-inspector overlay that lives as a child of the
 * vehicle's root group, so it inherits all liftoff transforms (pitch,
 * roll, altitude). Three layers:
 *
 *   1. Per-engine arrows  — one short downward-pointing arrow at every
 *                            engine bell exit, length proportional to
 *                            that engine's live thrust (per_engine_kn ×
 *                            throttle). Color-coded: orange for engines
 *                            that gimbal (inner rings), gray for fixed.
 *                            Gimbaling engines wobble subtly when firing.
 *   2. Center-of-mass     — magenta sphere at the vehicle's CoM. Rises
 *                            during the clip as booster propellant burns
 *                            off (mass shifts upward toward the upper
 *                            stage).
 *   3. Net thrust vector  — single thick red arrow rooted at the CoM,
 *                            pointing along the vehicle's -Y axis, length
 *                            ∝ total live thrust. Reads as "where the
 *                            net force is acting on the rocket."
 *
 * Public API:
 *   buildThrustOverlay(vehicle) → THREE.Group  (visible:false by default)
 *   tickThrustOverlay(overlay, { throttle, T, height })
 */

import * as THREE from 'three';

// ── Builders ─────────────────────────────────────────────────────────────────

const ARROW_HEAD_FRAC = 0.28;

// Single arrow pointing in local -Y. Origin sits at the arrow's TAIL,
// so the arrow grows downward when scale.y > 1. baseLength is the
// nominal length we built; scale.y = liveLen / baseLength.
function buildArrow({ length, radius, color, opacity = 0.85 }) {
    const g = new THREE.Group();
    const headLen  = length * ARROW_HEAD_FRAC;
    const shaftLen = length - headLen;

    const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, depthWrite: false, fog: false,
    });

    const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, shaftLen, 12),
        mat
    );
    shaft.position.y = -shaftLen / 2;
    g.add(shaft);

    const head = new THREE.Mesh(
        new THREE.ConeGeometry(radius * 2.6, headLen, 16),
        mat
    );
    head.position.y = -shaftLen - headLen / 2;
    head.rotation.x = Math.PI;
    g.add(head);

    g.userData.material = mat;
    g.userData.baseLength = length;
    return g;
}

// Per-engine arrow — short, color-coded by gimbal capability.
function buildEngineArrow(eng) {
    const color = eng.gimbal ? 0xffaa44 : 0x99a3ad;
    const radius = 0.12 + eng.thrust_kn / 80000;       // bigger for SRBs
    const length = 6 + eng.thrust_kn / 1000;            // nominal scale
    const arrow = buildArrow({ length, radius, color, opacity: 0.85 });
    arrow.position.set(eng.x || 0, eng.y || 0, eng.z || 0);
    arrow.userData.eng = eng;
    return arrow;
}

// ── Public: build overlay ────────────────────────────────────────────────────

export function buildThrustOverlay(vehicle) {
    const root = new THREE.Group();
    root.name = 'ThrustOverlay';
    root.visible = false;

    const layout = vehicle.engineLayout;
    if (!layout) return root;     // vehicle didn't expose a layout — empty overlay

    // Per-engine arrows — booster engines fire at liftoff, upper engines
    // are dimmed (they only fire after stage separation).
    const engineArrows = [];
    let totalThrust = 0;
    for (const eng of (layout.boosterEngines || [])) {
        const arrow = buildEngineArrow(eng);
        arrow.userData.stage = 'booster';
        root.add(arrow);
        engineArrows.push({ arrow, eng, stage: 'booster' });
        totalThrust += eng.thrust_kn;
    }
    for (const eng of (layout.upperEngines || [])) {
        const arrow = buildEngineArrow(eng);
        arrow.userData.stage = 'upper';
        // Upper-stage arrows render dimmer — they're "what would fire next."
        arrow.userData.material.opacity = 0.25;
        root.add(arrow);
        engineArrows.push({ arrow, eng, stage: 'upper' });
    }

    // Net thrust vector — at the CoM, big red arrow pointing -Y.
    const netLength = 18;
    const netArrow = buildArrow({
        length: netLength,
        radius: 0.65,
        color: 0xff3322,
        opacity: 0.85,
    });
    netArrow.userData.kind = 'net';
    root.add(netArrow);

    // Center of mass marker — magenta sphere with a thin halo.
    const com = new THREE.Mesh(
        new THREE.SphereGeometry(0.85, 24, 16),
        new THREE.MeshBasicMaterial({
            color: 0xff66cc, transparent: true, opacity: 0.95,
            depthWrite: false, fog: false,
        })
    );
    com.userData.kind = 'com';
    root.add(com);

    const halo = new THREE.Mesh(
        new THREE.SphereGeometry(1.4, 16, 12),
        new THREE.MeshBasicMaterial({
            color: 0xff66cc, transparent: true, opacity: 0.18,
            depthWrite: false, fog: false,
        })
    );
    com.add(halo);

    root.userData.engineArrows = engineArrows;
    root.userData.netArrow = netArrow;
    root.userData.com = com;
    root.userData.height = vehicle.height;
    root.userData.totalBoosterThrust = totalThrust;

    return root;
}

// ── Public: tick ─────────────────────────────────────────────────────────────
// Update arrow lengths + CoM position + net vector each frame. Cheap (no
// new geometry, just scalar / vector tweaks). Skips entirely when the
// overlay is hidden so pre-launch idle is free.

const _wobble = new THREE.Vector2();

export function tickThrustOverlay(overlay, opts) {
    if (!overlay || !overlay.visible) return;

    const throttle = Math.max(0, Math.min(1, opts.throttle ?? 0));
    const T        = opts.T ?? 0;
    const height   = overlay.userData.height || 50;

    // Per-engine arrow length + opacity
    for (const { arrow, eng, stage } of overlay.userData.engineArrows) {
        const isBooster = stage === 'booster';
        const live = isBooster ? throttle : 0;          // upper engines off pre-MECO
        const baseLen = arrow.userData.baseLength;
        // Map live thrust → 0.05..1.0 of the nominal arrow length.
        const scaleY = Math.max(0.05, 0.15 + 0.85 * live);
        arrow.scale.y = scaleY;

        // Opacity: idle (T < -0.2) faint, ascent live full, upper dim.
        const m = arrow.userData.material;
        if (isBooster) {
            m.opacity = 0.30 + 0.55 * live;
        } else {
            // Upper-stage arrows brighten only after T+90 (sim of MECO).
            m.opacity = 0.20 + 0.45 * Math.max(0, Math.min(1, (T - 90) / 10));
        }

        // Gimbal wobble — visible-only-when-firing low-amplitude oscillation.
        // Outer-ring engines on Starship don't gimbal; mid + inner do. Use
        // each engine's own (x,z) as a phase seed so neighbors don't all
        // wobble in lockstep (looks more like real engine actuator chatter).
        if (eng.gimbal && live > 0.05) {
            const phase = (eng.x || 0) * 0.7 + (eng.z || 0) * 1.3;
            arrow.rotation.x = Math.sin(T * 1.7 + phase) * 0.025;
            arrow.rotation.z = Math.cos(T * 1.4 + phase) * 0.025;
        } else {
            arrow.rotation.x = 0;
            arrow.rotation.z = 0;
        }
    }

    // CoM rises during flight: at T=0 sits ~28% up the stack, by T=50 has
    // climbed to ~50% as booster propellant burns off.
    const tFrac = Math.max(0, Math.min(1, T / 50));
    const comY  = height * (0.28 + 0.22 * tFrac);
    overlay.userData.com.position.y = comY;
    // Subtle pulse on CoM marker so it reads as "live."
    const pulse = 1 + Math.sin(T * 2.2) * 0.06;
    overlay.userData.com.scale.setScalar(pulse);

    // Net thrust vector — anchored at CoM, length ∝ total live thrust.
    overlay.userData.netArrow.position.y = comY;
    const totalKn = overlay.userData.totalBoosterThrust * throttle;
    // Cap at 96 MN (Starship V3) for normalization. Never < 0.05 so
    // the geometry stays sane when thrust is zero.
    const netScale = Math.max(0.05, Math.min(2.5, totalKn / 30000));
    overlay.userData.netArrow.scale.y = netScale;
    // Net arrow opacity tracks throttle.
    overlay.userData.netArrow.userData.material.opacity = 0.30 + 0.55 * throttle;
}
