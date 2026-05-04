/**
 * launch-vehicle-3d.js — Procedural 3D launch vehicle canvas.
 *
 * Renders a generic stack — currently the Space Shuttle Transportation System
 * (orbiter + external tank + 2 SRBs) — built entirely from THREE primitives so
 * we don't depend on any external GLB/OBJ asset. Intended as a placeholder
 * until we secure permission to use operator-supplied vehicle models.
 *
 * The model is roughly to-scale across components (1 unit ≈ 1 m):
 *   External Tank   46.9 m × 8.4 m diameter
 *   SRB             45.5 m × 3.7 m diameter (×2)
 *   Orbiter         37.2 m × 23.8 m wingspan
 *
 * Public API:
 *   initVehicleCanvas(canvas, opts) → { dispose, setVehicle }
 *
 * `setVehicle('shuttle' | 'falcon9' | ...)` is reserved for v2 — for now only
 * the shuttle is implemented and the function is a no-op for unknown ids.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Color palette. The shuttle is famously orange-foam ET + white orbiter +
// white SRBs — we lean a little warmer on the foam and add a faint specular
// highlight on the orbiter for readability against a dark background.
const COLORS = {
    foam:    0xc56a2a,   // ET sprayed-on foam (post-STS-3 unpainted look)
    srb:     0xe6e6e0,
    orbiter: 0xf2f2ee,
    tile:    0x2c2c30,   // black thermal tiles on orbiter underside
    cockpit: 0x223344,
    flame:   0xffaa44,
    smoke:   0xddd6cc,
};

function mkMat(color, opts = {}) {
    return new THREE.MeshStandardMaterial({
        color,
        roughness: opts.roughness ?? 0.65,
        metalness: opts.metalness ?? 0.05,
        emissive: opts.emissive ?? 0x000000,
        emissiveIntensity: opts.emissiveIntensity ?? 0.0,
    });
}

// ── Build the Shuttle stack ──────────────────────────────────────────────────
// Origin is the base of the stack at the pad (y=0). +Y is up the stack.

function buildShuttleStack() {
    const group = new THREE.Group();
    group.name = 'STS_stack';

    // External tank — capped cylinder. ET nose is an ogive, but a
    // hemisphere reads close enough at this scale.
    const ET_LEN = 46.9, ET_R = 4.2;
    const tankBody = new THREE.Mesh(
        new THREE.CylinderGeometry(ET_R, ET_R, ET_LEN * 0.92, 36, 1, false),
        mkMat(COLORS.foam, { roughness: 0.85 })
    );
    tankBody.position.y = ET_LEN * 0.46;
    group.add(tankBody);

    const tankNose = new THREE.Mesh(
        new THREE.SphereGeometry(ET_R, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2),
        mkMat(COLORS.foam, { roughness: 0.85 })
    );
    tankNose.position.y = ET_LEN * 0.92;
    group.add(tankNose);

    const tankBase = new THREE.Mesh(
        new THREE.CylinderGeometry(ET_R * 0.85, ET_R, ET_LEN * 0.04, 36),
        mkMat(COLORS.foam, { roughness: 0.85 })
    );
    tankBase.position.y = ET_LEN * 0.02;
    group.add(tankBase);

    // Inter-tank ribbing band — a thinner darker ring near 60% height that
    // sells the "tank" silhouette without heavy geometry.
    const band = new THREE.Mesh(
        new THREE.CylinderGeometry(ET_R * 1.005, ET_R * 1.005, 1.6, 36, 1, true),
        mkMat(0x9a4a1c, { roughness: 0.9 })
    );
    band.position.y = ET_LEN * 0.62;
    group.add(band);

    // ── SRBs ────────────────────────────────────────────────────────────────
    const SRB_LEN = 45.5, SRB_R = 1.85;
    const srbOffset = ET_R + SRB_R + 0.35;
    for (const xSign of [-1, 1]) {
        const srb = new THREE.Group();

        const body = new THREE.Mesh(
            new THREE.CylinderGeometry(SRB_R, SRB_R, SRB_LEN * 0.9, 28),
            mkMat(COLORS.srb)
        );
        body.position.y = SRB_LEN * 0.45;
        srb.add(body);

        // SRB nose cone — ogive approximated as a tall cone.
        const nose = new THREE.Mesh(
            new THREE.ConeGeometry(SRB_R, SRB_LEN * 0.1, 28),
            mkMat(COLORS.srb)
        );
        nose.position.y = SRB_LEN * 0.95;
        srb.add(nose);

        // Aft skirt — slightly flared.
        const skirt = new THREE.Mesh(
            new THREE.CylinderGeometry(SRB_R * 1.1, SRB_R * 1.18, SRB_LEN * 0.05, 28),
            mkMat(0x999990)
        );
        skirt.position.y = SRB_LEN * 0.025;
        srb.add(skirt);

        // Segment joint rings — 4 thin stripes for the booster casing joints.
        for (let i = 1; i <= 4; i++) {
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(SRB_R * 1.005, 0.06, 8, 28),
                mkMat(0xbbbbb0)
            );
            ring.rotation.x = Math.PI / 2;
            ring.position.y = SRB_LEN * (0.15 + i * 0.16);
            srb.add(ring);
        }

        srb.position.x = xSign * srbOffset;
        srb.userData.kind = 'srb';
        srb.userData.side = xSign < 0 ? 'L' : 'R';
        group.add(srb);
    }

    // ── Orbiter ─────────────────────────────────────────────────────────────
    // Built as fuselage + wings + vertical stabilizer + nose + payload bay
    // doors. Mounted on the +Z side of the ET at the height where the
    // orbiter's belly sits against the foam.
    const orbiter = buildOrbiter();
    orbiter.position.set(0, 18, ET_R + 1.4);  // attach to "front" face of ET
    orbiter.userData.kind = 'orbiter';
    group.add(orbiter);

    // ── Pad / launch mount stub ─────────────────────────────────────────────
    // Just a faint disc so the stack doesn't float in the void. The full
    // mobile launcher platform is out of scope for the placeholder.
    const pad = new THREE.Mesh(
        new THREE.CylinderGeometry(18, 18, 0.6, 48),
        new THREE.MeshStandardMaterial({ color: 0x282834, roughness: 0.95 })
    );
    pad.position.y = -0.3;
    group.add(pad);

    // Recenter on the stack's vertical midpoint so OrbitControls' default
    // target works without a tweak.
    group.position.y = -ET_LEN * 0.5;

    return group;
}

function buildOrbiter() {
    const orbiter = new THREE.Group();
    const ORBITER_LEN = 37.2;
    const FUSE_R = 2.4;

    // Fuselage — vertical cylinder (CylinderGeometry's axis is local +Y, which
    // matches the stacked orientation when the orbiter parent is upright).
    const fuselage = new THREE.Mesh(
        new THREE.CylinderGeometry(FUSE_R, FUSE_R * 0.9, ORBITER_LEN * 0.78, 24),
        mkMat(COLORS.orbiter)
    );
    orbiter.add(fuselage);

    // Nose cap (top of orbiter when on pad)
    const nose = new THREE.Mesh(
        new THREE.SphereGeometry(FUSE_R * 0.95, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
        mkMat(COLORS.orbiter)
    );
    nose.position.y = ORBITER_LEN * 0.39;
    orbiter.add(nose);

    // Cockpit windows — a small dark wedge near the nose.
    const cockpit = new THREE.Mesh(
        new THREE.SphereGeometry(FUSE_R * 0.85, 18, 12, 0, Math.PI, 0, Math.PI * 0.45),
        new THREE.MeshStandardMaterial({ color: COLORS.cockpit, roughness: 0.25, metalness: 0.6 })
    );
    cockpit.position.set(0, ORBITER_LEN * 0.32, FUSE_R * 0.55);
    cockpit.rotation.x = Math.PI / 2;
    orbiter.add(cockpit);

    // Black thermal-tile underside — a thin curved shell pinned to the −Z
    // face of the fuselage. Built from a half-cylinder of slightly larger
    // radius so it visually overlays the white surface.
    const belly = new THREE.Mesh(
        new THREE.CylinderGeometry(FUSE_R * 1.005, FUSE_R * 0.905, ORBITER_LEN * 0.78, 24, 1, true, Math.PI - 0.9, 1.8),
        mkMat(COLORS.tile, { roughness: 0.95 })
    );
    orbiter.add(belly);

    // Wings — delta planform via flat ExtrudeGeometry, two halves.
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, 0);
    wingShape.lineTo(11.9, -7);          // tip back along orbiter length
    wingShape.lineTo(11.9, -10);
    wingShape.lineTo(2.5, -14);
    wingShape.lineTo(0, -14);
    wingShape.lineTo(0, 0);
    const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.6, bevelEnabled: false });
    const wingMat = mkMat(COLORS.orbiter);
    for (const xSign of [-1, 1]) {
        const wing = new THREE.Mesh(wingGeo, wingMat);
        wing.scale.x = xSign;
        wing.position.set(xSign * FUSE_R * 0.7, -8, -0.3);
        wing.rotation.x = Math.PI / 2;
        orbiter.add(wing);
    }

    // Vertical stabilizer — same idea, narrow swept fin on the tail.
    const tailShape = new THREE.Shape();
    tailShape.moveTo(0, 0);
    tailShape.lineTo(3.5, 5.5);
    tailShape.lineTo(5.0, 5.5);
    tailShape.lineTo(6.0, 0);
    tailShape.lineTo(0, 0);
    const tailGeo = new THREE.ExtrudeGeometry(tailShape, { depth: 0.35, bevelEnabled: false });
    const tail = new THREE.Mesh(tailGeo, mkMat(COLORS.orbiter));
    tail.position.set(-0.18, ORBITER_LEN * -0.42 + 1, FUSE_R * 0.1);
    orbiter.add(tail);

    // OMS pods — twin bumps at the aft, flanking the main engine cluster.
    for (const xSign of [-1, 1]) {
        const oms = new THREE.Mesh(
            new THREE.CapsuleGeometry(0.8, 3.0, 6, 12),
            mkMat(COLORS.orbiter)
        );
        oms.rotation.x = Math.PI / 2;
        oms.position.set(xSign * 1.6, ORBITER_LEN * -0.42 + 1.5, -0.4);
        orbiter.add(oms);
    }

    // SSME bell cluster (3 engines) at the aft end.
    for (const [dx, dy] of [[0, 0.9], [-1.0, -0.4], [1.0, -0.4]]) {
        const bell = new THREE.Mesh(
            new THREE.ConeGeometry(0.65, 1.6, 18, 1, true),
            new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.4, metalness: 0.7, side: THREE.DoubleSide })
        );
        bell.position.set(dx, ORBITER_LEN * -0.42 + dy, -0.3);
        bell.rotation.x = Math.PI;     // opening points down (away from stack top)
        orbiter.add(bell);
    }

    return orbiter;
}

// ── Scene + render loop ──────────────────────────────────────────────────────

export function initVehicleCanvas(canvas, opts = {}) {
    if (!canvas) throw new Error('initVehicleCanvas: canvas element required');

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = null;     // transparent, page bg shows through

    // Faint star background from a far-side sphere with a procedural texture.
    scene.add(buildStarfield());

    const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
    camera.position.set(55, 25, 70);

    // Lighting — sun-from-above + warm fill from the flame side + soft ambient.
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(40, 90, 50);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffaa66, 0.35);
    fill.position.set(-30, -10, 20);
    scene.add(fill);

    const stack = buildShuttleStack();
    scene.add(stack);

    // Point the camera at the stack's middle.
    const target = new THREE.Vector3(0, 5, 0);

    const controls = new OrbitControls(camera, canvas);
    controls.target.copy(target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 30;
    controls.maxDistance = 220;
    controls.maxPolarAngle = Math.PI * 0.95;
    controls.autoRotate = opts.autoRotate ?? true;
    controls.autoRotateSpeed = 0.6;

    // ResizeObserver keeps the renderer matched to the canvas's CSS box.
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

    // Animation loop. Pause when off-screen (IntersectionObserver) so we don't
    // burn battery on a hidden canvas.
    let running = true;
    let rafId = 0;
    const io = new IntersectionObserver(([entry]) => {
        running = entry.isIntersecting;
        if (running && !rafId) tick();
    }, { threshold: 0.05 });
    io.observe(canvas);

    function tick() {
        if (!running) { rafId = 0; return; }
        controls.update();
        renderer.render(scene, camera);
        rafId = requestAnimationFrame(tick);
    }
    tick();

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
        setVehicle(_id) { /* reserved — only shuttle implemented */ },
        setAutoRotate(on) { controls.autoRotate = !!on; },
    };
}

// Procedural starfield — Points cloud on a large sphere shell. Cheap and looks
// fine behind a static-ish vehicle render.
function buildStarfield() {
    const N = 600;
    const positions = new Float32Array(N * 3);
    const R = 1500;
    for (let i = 0; i < N; i++) {
        const u = Math.random() * 2 - 1;
        const t = Math.random() * Math.PI * 2;
        const r = Math.sqrt(1 - u * u);
        positions[i * 3]     = R * r * Math.cos(t);
        positions[i * 3 + 1] = R * u;
        positions[i * 3 + 2] = R * r * Math.sin(t);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.7 });
    return new THREE.Points(geo, mat);
}
