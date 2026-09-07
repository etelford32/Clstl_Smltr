/**
 * bootes/scene.js — the 3D stage on bootes-void.html
 * ═══════════════════════════════════════════════════════════════════════════
 * Rendering only. Every number this file draws arrives already computed from
 * js/bootes-void-model.js and js/bootes-web-model.js; there is no physics here
 * and there must never be, or the picture and the figures beside it could
 * disagree about the same quantity.
 *
 * THE FRAME. Void-centred, comoving Mpc, right-handed EQUATORIAL — the same
 * frame js/bootes-void-data.js resolves anchors into, so a cluster direction
 * needs no conversion to be drawn. `SCENE_SCALE` is the only place Mpc becomes
 * scene units, and it exists purely so the near/far planes and the camera
 * distances are ordinary numbers.
 *
 * THE LINE OF SIGHT IS NOT AN AXIS. `losUnitFromVoid()` is an oblique
 * direction in this frame, and the redshift-space displacement is applied
 * along it. Snapping it to +Z would produce a figure that looks entirely
 * correct and distorts the void along the wrong direction — which is worse
 * than not drawing it, because it cannot be spotted by eye.
 *
 * WHAT THE VECTOR FIELD DRAWS, AND WHY IT IS A LINE AND NOT A CONE
 * ───────────────────────────────────────────────────────────────
 * Arrows are LineSegments with a two-stroke head, not instanced cone meshes.
 * At 700 arrows the cones measured ~4× the frame cost for a shape nobody can
 * resolve at this density, and — more importantly — a lit mesh encodes
 * magnitude in its SIZE, which competes with the length that already encodes
 * it. Lines encode magnitude in length and colour and nothing else.
 *
 * ARROW LENGTH IS NORMALISED PER MODE, AND THE PAGE SAYS SO. The four fields
 * differ in magnitude by more than an order of magnitude — Δg outside the wall
 * is a fraction of g_A inside it — so a single absolute scale would render
 * three of the four modes as invisible stubs. Each mode is scaled to its own
 * maximum and the legend prints that maximum, so the picture stays comparable
 * in DIRECTION across modes and the numbers stay honest about magnitude.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** Mpc per scene unit. Only conversion in the file. */
export const SCENE_SCALE = 20;

const mpc = (v) => v / SCENE_SCALE;

/** Blue → white → orange, matching the charts' void/wall pair. */
function rampColor(t, out = new THREE.Color()) {
    const x = Math.max(0, Math.min(1, t));
    if (x < 0.5) {
        const u = x / 0.5;
        return out.setRGB(0.16 + 0.68 * u, 0.55 + 0.4 * u, 0.92 + 0.06 * u);
    }
    const u = (x - 0.5) / 0.5;
    return out.setRGB(0.84 + 0.16 * u, 0.95 - 0.35 * u, 0.98 - 0.64 * u);
}

/**
 * Build the stage. Returns null if WebGL is unavailable — the caller falls
 * back to the figures alone, which carry every number the render illustrates.
 * A page that hard-fails on no-WebGL loses the science along with the picture.
 */
export function createBootesScene(canvas, {
    onHover = null,
} = {}) {
    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (err) {
        return null;
    }
    if (!renderer.getContext()) return null;

    renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
    renderer.setClearColor(0x03010e, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
    camera.position.set(mpc(210), mpc(150), mpc(240));

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = mpc(40);
    controls.maxDistance = mpc(900);
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.32;

    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 0.5);
    key.position.set(1, 1, 1);
    scene.add(key);

    // ── Groups, so a rebuild can replace one layer without touching others ──
    const groups = {
        tracers: new THREE.Group(),
        web: new THREE.Group(),
        shell: new THREE.Group(),
        field: new THREE.Group(),
        markers: new THREE.Group(),
    };
    Object.values(groups).forEach(g => scene.add(g));

    const disposables = [];
    const track = (obj) => { disposables.push(obj); return obj; };
    function clear(group) {
        while (group.children.length) {
            const child = group.children.pop();
            child.geometry?.dispose?.();
            child.material?.dispose?.();
        }
    }

    // ── The void shell + its wall, drawn once ───────────────────────────────
    function buildShell(rEffMpc, rsMpc) {
        clear(groups.shell);
        // R_eff: a faint wireframe sphere. Deliberately NOT a solid surface —
        // the void has no boundary, it has a profile, and a hard surface is
        // the single most common way these renders lie about what a void is.
        const wire = new THREE.Mesh(
            new THREE.SphereGeometry(mpc(rEffMpc), 48, 32),
            new THREE.MeshBasicMaterial({
                color: 0x4fc3f7, wireframe: true, transparent: true, opacity: 0.075,
            }));
        groups.shell.add(wire);
        // The zero crossing r_s, where δ changes sign: the honest "edge".
        const cross = new THREE.Mesh(
            new THREE.SphereGeometry(mpc(rsMpc), 64, 40),
            new THREE.MeshBasicMaterial({
                color: 0x4fc3f7, transparent: true, opacity: 0.045,
                side: THREE.BackSide, depthWrite: false,
            }));
        groups.shell.add(cross);
    }

    // ── Tracer galaxies ─────────────────────────────────────────────────────
    function buildTracers(tracers, { redshiftSpace = null } = {}) {
        clear(groups.tracers);
        if (!tracers?.length) return;
        const positions = new Float32Array(tracers.length * 3);
        const colors = new Float32Array(tracers.length * 3);
        const c = new THREE.Color();
        tracers.forEach((t, i) => {
            const p = redshiftSpace ? redshiftSpace(t) : t.offsetMpc;
            positions[i * 3] = mpc(p[0]);
            positions[i * 3 + 1] = mpc(p[1]);
            positions[i * 3 + 2] = mpc(p[2]);
            // Colour by local galaxy contrast: void interior cool, wall warm.
            rampColor((t.deltaG + 1) / 1.6, c);
            colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
        });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        const mat = new THREE.PointsMaterial({
            size: 0.085, vertexColors: true, transparent: true, opacity: 0.9,
            sizeAttenuation: true, depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        groups.tracers.add(track(new THREE.Points(geo, mat)));
    }

    // ── The web: filaments as lines, nodes as points sized by mass ──────────
    function buildWeb(web) {
        clear(groups.web);
        if (!web) return;
        const segs = new Float32Array(web.filaments.length * 6);
        web.filaments.forEach((f, i) => {
            const a = web.nodes[f.a].offsetMpc;
            const b = web.nodes[f.b].offsetMpc;
            segs[i * 6] = mpc(a[0]); segs[i * 6 + 1] = mpc(a[1]); segs[i * 6 + 2] = mpc(a[2]);
            segs[i * 6 + 3] = mpc(b[0]); segs[i * 6 + 4] = mpc(b[1]); segs[i * 6 + 5] = mpc(b[2]);
        });
        const lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.BufferAttribute(segs, 3));
        groups.web.add(track(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({
            color: 0xff9a56, transparent: true, opacity: 0.34,
        }))));

        // Nodes. Point size cannot vary per-vertex in PointsMaterial without a
        // custom shader, so mass is encoded in BRIGHTNESS instead — which is
        // the honest choice anyway, since a bigger dot at this density reads
        // as "closer" more than as "heavier".
        const maxMass = Math.max(...web.nodes.map(n => n.massMsun)) || 1;
        const np = new Float32Array(web.nodes.length * 3);
        const nc = new Float32Array(web.nodes.length * 3);
        web.nodes.forEach((n, i) => {
            np[i * 3] = mpc(n.offsetMpc[0]);
            np[i * 3 + 1] = mpc(n.offsetMpc[1]);
            np[i * 3 + 2] = mpc(n.offsetMpc[2]);
            const b = 0.35 + 0.65 * Math.sqrt(n.massMsun / maxMass);
            nc[i * 3] = b; nc[i * 3 + 1] = b * 0.66; nc[i * 3 + 2] = b * 0.36;
        });
        const ng = new THREE.BufferGeometry();
        ng.setAttribute('position', new THREE.BufferAttribute(np, 3));
        ng.setAttribute('color', new THREE.BufferAttribute(nc, 3));
        groups.web.add(track(new THREE.Points(ng, new THREE.PointsMaterial({
            size: 0.34, vertexColors: true, transparent: true, opacity: 0.95,
            sizeAttenuation: true, blending: THREE.AdditiveBlending, depthWrite: false,
        }))));
    }

    // ── Named anchors + the line of sight ───────────────────────────────────
    function buildMarkers(anchors, losUnit, rEffMpc) {
        clear(groups.markers);
        // The sightline back to the Milky Way, drawn out to 1.6 R_eff so it
        // reads as a direction rather than as a structure.
        const l = mpc(rEffMpc * 1.6);
        const losGeo = new THREE.BufferGeometry();
        losGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
            0, 0, 0, losUnit[0] * l, losUnit[1] * l, losUnit[2] * l,
        ]), 3));
        groups.markers.add(track(new THREE.Line(losGeo, new THREE.LineBasicMaterial({
            color: 0xc792ea, transparent: true, opacity: 0.5,
        }))));

        if (!anchors?.length) return;
        const ap = new Float32Array(anchors.length * 3);
        anchors.forEach((a, i) => {
            ap[i * 3] = mpc(a.offsetMpc[0]);
            ap[i * 3 + 1] = mpc(a.offsetMpc[1]);
            ap[i * 3 + 2] = mpc(a.offsetMpc[2]);
        });
        const ag = new THREE.BufferGeometry();
        ag.setAttribute('position', new THREE.BufferAttribute(ap, 3));
        groups.markers.add(track(new THREE.Points(ag, new THREE.PointsMaterial({
            color: 0xffffff, size: 0.55, transparent: true, opacity: 0.9,
            sizeAttenuation: true, depthWrite: false,
        }))));
    }

    /**
     * The vector field. `samples` is an array of { position, vector } already
     * in comoving Mpc / SI, and `maxMagnitude` is the normaliser the caller
     * chose — passed in rather than computed here so the legend and the arrows
     * cannot disagree about what "full length" means.
     */
    function buildField(samples, maxMagnitude, { arrowMpc = 17 } = {}) {
        clear(groups.field);
        if (!samples?.length || !(maxMagnitude > 0)) return;
        // 3 segments per arrow: the shaft plus two head strokes.
        const verts = new Float32Array(samples.length * 3 * 2 * 3);
        const cols = new Float32Array(samples.length * 3 * 2 * 3);
        const c = new THREE.Color();
        const tmp = new THREE.Vector3();
        const dir = new THREE.Vector3();
        const perpA = new THREE.Vector3();
        const perpB = new THREE.Vector3();
        let o = 0;
        const push = (ax, ay, az, bx, by, bz, col) => {
            verts[o] = ax; verts[o + 1] = ay; verts[o + 2] = az;
            cols[o] = col.r; cols[o + 1] = col.g; cols[o + 2] = col.b;
            o += 3;
            verts[o] = bx; verts[o + 1] = by; verts[o + 2] = bz;
            cols[o] = col.r; cols[o + 1] = col.g; cols[o + 2] = col.b;
            o += 3;
        };
        for (const s of samples) {
            const v = s.vector;
            const mag = Math.hypot(v[0], v[1], v[2]);
            const t = Math.min(1, mag / maxMagnitude);
            if (t < 0.008) continue;
            rampColor(t, c);
            dir.set(v[0], v[1], v[2]).normalize();
            const len = mpc(arrowMpc) * (0.25 + 0.75 * Math.sqrt(t));
            const ax = mpc(s.position[0]);
            const ay = mpc(s.position[1]);
            const az = mpc(s.position[2]);
            tmp.copy(dir).multiplyScalar(len);
            const bx = ax + tmp.x;
            const by = ay + tmp.y;
            const bz = az + tmp.z;
            push(ax, ay, az, bx, by, bz, c);
            // Head: two strokes back along the shaft, splayed on an arbitrary
            // perpendicular pair. Orientation of the splay does not matter at
            // this scale and picking one saves a per-arrow basis solve.
            perpA.set(-dir.y, dir.x, 0);
            if (perpA.lengthSq() < 1e-6) perpA.set(0, -dir.z, dir.y);
            perpA.normalize().multiplyScalar(len * 0.18);
            perpB.copy(dir).multiplyScalar(-len * 0.3);
            push(bx, by, bz, bx + perpB.x + perpA.x, by + perpB.y + perpA.y, bz + perpB.z + perpA.z, c);
            push(bx, by, bz, bx + perpB.x - perpA.x, by + perpB.y - perpA.y, bz + perpB.z - perpA.z, c);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(verts.subarray(0, o), 3));
        geo.setAttribute('color', new THREE.BufferAttribute(cols.subarray(0, o), 3));
        groups.field.add(track(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true, opacity: 0.92,
        }))));
    }

    // ── Render loop ─────────────────────────────────────────────────────────
    let running = true;
    let visible = true;
    function resize() {
        const w = canvas.clientWidth || 800;
        const h = canvas.clientHeight || 480;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    function frame() {
        if (!running) return;
        requestAnimationFrame(frame);
        controls.update();
        // Pause only the GL work when off-screen; controls damping still
        // settles so returning to the tab does not snap the camera.
        if (!visible) return;
        renderer.render(scene, camera);
    }
    resize();
    frame();

    const observer = typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0 })
        : null;
    observer?.observe(canvas);

    return {
        renderer, scene, camera, controls, groups,
        resize,
        buildShell, buildTracers, buildWeb, buildMarkers, buildField,
        setLayerVisible(name, on) { if (groups[name]) groups[name].visible = on; },
        setAutoRotate(on) { controls.autoRotate = on; },
        frameAll(rEffMpc) {
            const d = mpc(rEffMpc) * 3.9;
            camera.position.set(d * 0.72, d * 0.5, d * 0.78);
            controls.target.set(0, 0, 0);
            controls.update();
        },
        dispose() {
            running = false;
            observer?.disconnect();
            Object.values(groups).forEach(clear);
            controls.dispose();
            renderer.dispose();
        },
    };
}
