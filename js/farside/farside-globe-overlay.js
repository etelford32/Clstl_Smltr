/**
 * js/farside/farside-globe-overlay.js — 3D Far-Side Watch overlay (Phase 4 /
 * Tier 5). A reusable Three.js layer that drops onto any solar-globe scene
 * (the Sun engine, the Space-Weather globe) to show far-side detections, the
 * east-limb "horizon," and the front/far visibility terminator.
 *
 * Convention matches the Sun engine's active-region markers exactly:
 *   pos = (cos(lat)·sin(cmd), sin(lat), cos(lat)·cos(cmd))
 * where `cmd` is the central-meridian distance (sub-Earth = +Z, east limb at
 * cmd = -90 → -X, west limb at +90 → +X). Far-side detections (|cmd| > 90) land
 * at negative Z and are naturally occluded by the opaque photosphere until the
 * camera orbits around — which is the "rotating into view" story made literal.
 *
 * THREE is INJECTED (not imported) so the host page's single Three.js instance
 * is reused — the repo loads Three from a CDN importmap, no bundler.
 *
 *   const ov = createFarSideOverlay(THREE, { radius: 1.0 });
 *   scene.add(ov.group);
 *   ov.update({ tracks });           // tracks from farSideWatchList / buildTracks
 */

const DEG = Math.PI / 180;

export function createFarSideOverlay(THREE, opts = {}) {
    const R = opts.radius ?? 1.0;
    const group = new THREE.Group();
    group.name = 'farside-overlay';

    const horizon = new THREE.Group();
    const markers = new THREE.Group();
    group.add(horizon, markers);

    const dir = (cmd, lat) => new THREE.Vector3(
        Math.cos(lat * DEG) * Math.sin(cmd * DEG),
        Math.sin(lat * DEG),
        Math.cos(lat * DEG) * Math.cos(cmd * DEG),
    );

    // ── Canvas-texture label sprite ───────────────────────────────
    function makeLabel(text, pos, hex) {
        const cv = document.createElement('canvas');
        cv.width = 128; cv.height = 40;
        const ctx = cv.getContext('2d');
        ctx.font = '600 22px ui-monospace, monospace';
        ctx.fillStyle = '#' + hex.toString(16).padStart(6, '0');
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 6, 22);
        const tex = new THREE.CanvasTexture(cv);
        tex.minFilter = THREE.LinearFilter;
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({
            map: tex, transparent: true, depthTest: true, depthWrite: false,
        }));
        spr.position.copy(pos);
        spr.scale.set(0.22, 0.069, 1);
        spr.userData._tex = tex;
        return spr;
    }

    // ── Static horizon geometry ───────────────────────────────────
    function buildHorizon() {
        // East-limb meridian (cmd = -90), pole to pole — the emergence horizon.
        const eastPts = [];
        for (let l = -90; l <= 90; l += 3) eastPts.push(dir(-90, l).multiplyScalar(R * 1.006));
        horizon.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(eastPts),
            new THREE.LineBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.85 }),
        ));
        // Visibility terminator (z = 0 great circle): front/far boundary.
        const termPts = [];
        for (let a = 0; a <= 360; a += 4) {
            termPts.push(new THREE.Vector3(Math.cos(a * DEG) * R * 1.004, Math.sin(a * DEG) * R * 1.004, 0));
        }
        horizon.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(termPts),
            new THREE.LineBasicMaterial({ color: 0x335577, transparent: true, opacity: 0.4 }),
        ));
        horizon.add(makeLabel('E-limb', dir(-90, 0).multiplyScalar(R * 1.13), 0x66ccff));
    }

    // ── Per-detection marker ──────────────────────────────────────
    function makeMarker(t) {
        const g = new THREE.Group();
        const p = dir(t.cmd, t.lat).multiplyScalar(R * 1.02);
        g.position.copy(p);
        const strong = t.strong;
        const hex = strong ? 0xffd166 : 0xff9966;

        // Node sphere.
        g.add(new THREE.Mesh(
            new THREE.SphereGeometry(strong ? 0.03 : 0.022, 16, 16),
            new THREE.MeshBasicMaterial({ color: hex }),
        ));
        // Radial spike outward (reads edge-on at the limb).
        const n = p.clone().normalize();
        g.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([
                n.clone().multiplyScalar(R * 1.0),
                n.clone().multiplyScalar(R * (strong ? 1.10 : 1.07)),
            ]),
            new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 0.8 }),
        ));
        // ETA label (skip for already-Earth-facing tracks).
        if (!t.onDisc) {
            g.add(makeLabel(`~${t.etaDays.toFixed(1)}d`, n.clone().multiplyScalar(R * 1.16), hex));
        }
        g.userData = { lon: t.lon, lat: t.lat, cmd: t.cmd, etaDays: t.etaDays };
        return g;
    }

    function disposeChildren(obj) {
        obj.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                if (o.material.map) o.material.map.dispose();
                o.material.dispose();
            }
            if (o.userData?._tex) o.userData._tex.dispose();
        });
        obj.clear();
    }

    /** Repaint markers from a watch/track list. */
    function update({ tracks = [] } = {}) {
        disposeChildren(markers);
        for (const t of tracks) {
            if (typeof t.cmd !== 'number') continue;
            markers.add(makeMarker(t));
        }
        return markers.children.length;
    }

    function setVisible(v) { group.visible = !!v; }
    function dispose() { disposeChildren(markers); disposeChildren(horizon); }

    buildHorizon();
    return { group, markers, horizon, update, setVisible, dispose, dir };
}
