/**
 * js/farside/farside-globe.js — Three.js 3D "rotating into view" simulation.
 *
 * The 3D successor to renderTopDown() in farside-render.js. Where the flat
 * schematic looks DOWN the rotation axis, this puts the Sun in the round:
 * Earth fixed off the +x side, the far-side hemisphere genuinely behind the
 * limb, the GONG phase-shift field wrapped on the photosphere, and far-side
 * detections placed on the surface so you watch them rotate across the blue
 * east-limb "horizon" into Earth-facing view.
 *
 * It is deliberately NOT re-exported from js/farside/index.js: it imports
 * `three` (bare specifier resolved by the page importmap), so keeping it out of
 * the barrel preserves the Node smoke test (carrington → detect → track) that
 * imports the barrel with only a `window` stub. The page controller loads it
 * with a dynamic import() and falls back to the Canvas2D renderTopDown() if the
 * import fails (no WebGL, importmap edge case, offline vendor file).
 *
 * Geometry (Earth fixed at world +x; solar north +y, tilted by B0):
 *   - A surface feature at Carrington longitude `lon`, latitude `lat` lands at
 *     world direction (cos cmd, .., -sin cmd) on the equator, with the
 *     central-meridian distance cmd = wrap180(lon - L0):
 *       cmd =   0  → +x  (sub-Earth)
 *       cmd = -90  → +z  (EAST limb — where regions emerge)
 *       cmd = +90  → -z  (WEST limb — where they exit)
 *       |cmd| > 90 → -x hemisphere (the far side, away from Earth)
 *   - The whole Sun lives in `sunGroup`, rotated by γ = π − L0 about the tilt
 *     axis so the sub-Earth point faces Earth. Markers + field are children of
 *     sunGroup, so a slow spin of the group carries them across the limb
 *     exactly as the real synodic rotation would. Earth, the east-limb arc and
 *     the sub-Earth reticle live in the world frame and stay put.
 *
 * ROTATION IS THE SIMULATION, NOT DECORATION. This view used to spin the Sun
 * at a fixed `SPIN_DEG_PER_SEC = 3.2` "illustrative" rate, free-running and
 * unrelated to the L0 the markers were placed from. Within a second of
 * loading, a marker labelled "~10.1 d" was no longer anywhere near where a
 * 10.1-day lead time puts it, and the page had to disclaim the one thing a
 * viewer could actually watch. Orientation now comes from setEpoch(ms) →
 * carringtonL0(ms), so the drawn rotation IS the forecast: the Sun turns at
 * the true synodic rate under the page's clock, and a marker reaches the blue
 * east-limb horizon exactly when its ETA reads zero. Do not reintroduce a
 * free-running spin term — animate the clock instead.
 *
 * Usage (mirrors space-weather-globe.js):
 *   import { FarSideGlobe } from './farside/farside-globe.js';
 *   const globe = new FarSideGlobe(canvasEl);
 *   globe.render(map, { tracks });   // (re)build for a new map / watch list
 *   globe.setEpoch(Date.now());      // orient to an instant
 *   globe.start();                   // begin the render loop
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { carringtonL0 } from './carrington.js';
import { rampRGB } from './farside-render.js';

const DEG = Math.PI / 180;
const R = 1;                         // Sun radius in scene units

/**
 * Surface unit vector for a Carrington (lon, lat), in sunGroup-local coords.
 * Matches THREE.SphereGeometry's default UV so the equirectangular field
 * texture (u = lon/360, v = (90−lat)/180) registers exactly under the markers.
 */
function surface(lonDeg, latDeg) {
    const lon = lonDeg * DEG, lat = latDeg * DEG;
    const cl = Math.cos(lat);
    return new THREE.Vector3(-Math.cos(lon) * cl, Math.sin(lat), Math.sin(lon) * cl);
}

/** Build a CanvasTexture from the far-side phase-shift field (equirectangular). */
function fieldTexture(map) {
    const { nLon, nLat } = map.grid;
    const data = map.data;
    const cvs = document.createElement('canvas');
    cvs.width = nLon; cvs.height = nLat;
    const ctx = cvs.getContext('2d');
    const img = ctx.createImageData(nLon, nLat);
    for (let r = 0; r < nLat; r++) {
        const srcRow = (nLat - 1 - r) * nLon;     // flip so +90 lat is the top row
        for (let c = 0; c < nLon; c++) {
            const [rr, gg, bb] = rampRGB(data[srcRow + c]);
            const o = (r * nLon + c) * 4;
            img.data[o] = rr; img.data[o + 1] = gg; img.data[o + 2] = bb; img.data[o + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
}

/** Photosphere shader: field colour, a near-side brightness lift + far-side violet tint. */
function sunMaterial(tex) {
    return new THREE.ShaderMaterial({
        uniforms: { uField: { value: tex } },
        vertexShader: /* glsl */`
            varying vec2 vUv;
            varying vec3 vWorld;
            void main() {
                vUv = uv;
                vWorld = normalize((modelMatrix * vec4(position, 1.0)).xyz);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: /* glsl */`
            precision highp float;
            uniform sampler2D uField;
            varying vec2 vUv;
            varying vec3 vWorld;
            void main() {
                vec3 col = texture2D(uField, vUv).rgb;
                // worldX > 0 faces Earth (near side); < 0 is the far side.
                float face = vWorld.x;                       // -1 (far) .. +1 (near)
                float near = smoothstep(-0.2, 0.85, face);   // Earth-facing brightening
                col *= mix(0.78, 1.18, near);
                // Subtle violet wash on the far side so the hemisphere reads.
                float far = smoothstep(0.15, -0.7, face);
                col = mix(col, col * vec3(0.62, 0.5, 1.05) + vec3(0.05, 0.03, 0.10), far * 0.55);
                gl_FragColor = vec4(col, 1.0);
            }`,
    });
}

/** Warm additive corona shell (Fresnel rim). */
function coronaMesh() {
    const mat = new THREE.ShaderMaterial({
        transparent: true,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        uniforms: {},
        vertexShader: /* glsl */`
            varying float vR;
            void main() {
                vec3 n = normalize(normalMatrix * normal);
                vec3 v = normalize((modelViewMatrix * vec4(position, 1.0)).xyz);
                vR = pow(1.0 - abs(dot(n, v)), 2.4);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: /* glsl */`
            precision highp float;
            varying float vR;
            void main() {
                gl_FragColor = vec4(vec3(1.0, 0.62, 0.32) * vR, vR);
            }`,
    });
    return new THREE.Mesh(new THREE.SphereGeometry(R * 1.18, 64, 48), mat);
}

/** A small camera-facing text label as a sprite. */
function makeLabel(text, color = '#cdd', scale = 0.42) {
    const pad = 8, font = 44;
    const cvs = document.createElement('canvas');
    const ctx = cvs.getContext('2d');
    ctx.font = `700 ${font}px ui-monospace, Menlo, monospace`;
    const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
    cvs.width = w; cvs.height = font + pad * 2;
    const c2 = cvs.getContext('2d');
    c2.font = `700 ${font}px ui-monospace, Menlo, monospace`;
    c2.textBaseline = 'middle';
    c2.fillStyle = 'rgba(6,4,15,0.62)';
    c2.fillRect(0, 0, cvs.width, cvs.height);
    c2.fillStyle = color;
    c2.fillText(text, pad, cvs.height / 2);
    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.scale.set(scale * (cvs.width / cvs.height), scale, 1);
    return spr;
}

/** Marker caption: lead time, or "on disc" once the region has emerged. */
function etaLabel(t) {
    return t.onDisc ? 'on disc' : `~${(t.etaDays ?? 0).toFixed(1)}d`;
}

export class FarSideGlobe {
    constructor(canvas) {
        this.canvas = canvas;
        this._raf = 0;
        this._last = 0;
        this._tracks = [];
        this._fieldTex = null;
        this._markerGroup = null;

        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
        this.camera.position.set(2.7, 1.25, 3.4);
        // Design framing distance — the closest the auto-fit will ever place
        // the camera. See _fitDistance().
        this._designDist = this.camera.position.length();
        this._userMoved = false;

        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.enablePan = false;
        this.controls.minDistance = 2.0;
        // Roomy enough for _fitDistance() on a square-ish canvas (~9.6). At the
        // old 9.0 cap OrbitControls.update() clamped the auto-frame straight
        // back in, silently re-cropping Earth on exactly the aspects the fit
        // exists to handle.
        this.controls.maxDistance = 14.0;
        this.controls.target.set(0, 0, 0);
        // Hand framing over to the user the moment they grab the view.
        this.controls.addEventListener('start', () => { this._userMoved = true; });

        // sunGroup carries the (fixed) B0 tilt; spinGroup is the animated
        // Carrington rotation nested inside it, so the synodic spin never
        // corrupts the tilt. Sun + corona + markers are children of spinGroup.
        this.sunGroup = new THREE.Group();
        this.scene.add(this.sunGroup);
        this.spinGroup = new THREE.Group();
        this.sunGroup.add(this.spinGroup);
        this.spinGroup.add(coronaMesh());

        this.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 64), sunMaterial(null));
        this.spinGroup.add(this.sunMesh);

        this._buildWorldFurniture();
        this._resize();
        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(canvas);
    }

    /** Earth, the east-limb horizon arc, the limb circle, sub-Earth reticle — world-fixed. */
    _buildWorldFurniture() {
        // Limb (terminator) — full great circle in the y-z plane, faint.
        const limbPts = [];
        for (let a = 0; a <= 360; a += 4) limbPts.push(new THREE.Vector3(0, R * Math.sin(a * DEG), R * Math.cos(a * DEG)));
        this.scene.add(new THREE.LineLoop(
            new THREE.BufferGeometry().setFromPoints(limbPts),
            new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 }),
        ));

        // East-limb "horizon" — the +z half-meridian where regions emerge.
        const eastPts = [];
        for (let a = -90; a <= 90; a += 3) eastPts.push(new THREE.Vector3(0, R * 1.002 * Math.sin(a * DEG), R * 1.002 * Math.cos(a * DEG)));
        this.scene.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(eastPts),
            new THREE.LineBasicMaterial({ color: 0x66ccff, linewidth: 2 }),
        ));
        const eLabel = makeLabel('E-limb · emerges', '#66ccff', 0.36);
        eLabel.position.set(0, R * 1.18, R * 0.55);
        this.scene.add(eLabel);

        // Sub-Earth reticle (small ring on +x, facing Earth).
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(R * 0.05, R * 0.08, 24),
            new THREE.MeshBasicMaterial({ color: 0x99aaff, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
        );
        ring.position.set(R * 1.004, 0, 0);
        ring.lookAt(R * 4, 0, 0);
        this.scene.add(ring);

        // Earth marker + dashed sight line out the +x axis.
        const earth = new THREE.Mesh(
            new THREE.SphereGeometry(0.12, 24, 16),
            new THREE.MeshBasicMaterial({ color: 0x4d8cff }),
        );
        earth.position.set(3.1, 0, 0);
        this.scene.add(earth);
        const eLab = makeLabel('→ Earth', '#9cf', 0.4);
        eLab.position.set(3.1, 0.32, 0);
        this.scene.add(eLab);

        // Points the auto-framing must keep on screen: the far corners of the
        // Earth caption (the outermost thing in the scene) and the Sun's limb.
        // Taken from the sprite's real extent rather than a guessed constant,
        // because the caption's width depends on the rendered text metrics.
        const hw = eLab.scale.x / 2, hh = eLab.scale.y / 2;
        this._framePoints = [
            new THREE.Vector3(eLab.position.x + hw, eLab.position.y + hh, 0),
            new THREE.Vector3(eLab.position.x + hw, eLab.position.y - hh, 0),
            new THREE.Vector3(-R * 1.25, R * 1.25, 0),
            new THREE.Vector3(-R * 1.25, -R * 1.25, 0),
        ];

        const lineGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(R * 1.05, 0, 0), new THREE.Vector3(2.92, 0, 0),
        ]);
        const sight = new THREE.Line(lineGeo, new THREE.LineDashedMaterial({
            color: 0x9cf, dashSize: 0.12, gapSize: 0.1, transparent: true, opacity: 0.6,
        }));
        sight.computeLineDistances();
        this.scene.add(sight);

        // Rotation-axis hint (north pole pip).
        const axisPts = [new THREE.Vector3(0, R * 1.05, 0), new THREE.Vector3(0, R * 1.45, 0)];
        this.scene.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(axisPts),
            new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 }),
        ));
    }

    /**
     * (Re)build for a map + watch list.
     * @param {object} map   FarSideMap (grid/data/L0/B0)
     * @param {object} opts  { tracks?: object[] }
     */
    render(map, opts = {}) {
        this._tracks = opts.tracks || [];

        // Field texture on the photosphere.
        if (this._fieldTex) this._fieldTex.dispose();
        this._fieldTex = fieldTexture(map);
        this.sunMesh.material.uniforms.uField.value = this._fieldTex;

        // Orient the Carrington frame: tilt the axis by B0, then turn so the
        // sub-Earth point (Carrington lon = L0) faces Earth at +x.
        this.sunGroup.rotation.set(0, 0, (map.B0 || 0) * DEG);   // disc-centre heliographic-latitude tilt
        this._orient(map.L0 || 0);

        // Detection markers (children of spinGroup so they rotate with the surface).
        if (this._markerGroup) { this.spinGroup.remove(this._markerGroup); this._disposeGroup(this._markerGroup); }
        this._markerGroup = new THREE.Group();
        this._labels = [];
        for (const t of this._tracks) {
            const strong = !!t.strong;
            const col = strong ? 0xffd166 : 0xffccaa;
            const pos = surface(t.lon, t.lat).multiplyScalar(R * 1.012);

            const blip = new THREE.Mesh(
                new THREE.SphereGeometry(strong ? 0.05 : 0.038, 16, 12),
                new THREE.MeshBasicMaterial({ color: col }),
            );
            blip.position.copy(pos);
            this._markerGroup.add(blip);

            // Soft glow sprite behind the blip.
            const glow = makeGlowSprite(col);
            glow.position.copy(pos);
            glow.scale.setScalar(strong ? 0.34 : 0.24);
            this._markerGroup.add(glow);

            // ETA label, pushed slightly off the surface.
            const text = etaLabel(t);
            const lbl = makeLabel(text, strong ? '#ffd166' : '#ffd9bf', 0.3);
            lbl.position.copy(pos.clone().multiplyScalar(1.16));
            this._markerGroup.add(lbl);
            this._labels.push({ id: t.id, sprite: lbl, text, color: strong ? '#ffd166' : '#ffd9bf' });
        }
        this.spinGroup.add(this._markerGroup);

        if (!this._raf) this._renderOnce();
    }

    /**
     * Refresh marker labels in place for re-projected tracks.
     *
     * Only redraws a sprite whose TEXT actually changed. Playback calls this
     * every frame, and a label reads to one decimal — regenerating four
     * canvas textures 60 times a second to write the same four strings is
     * pure waste, and leaks the old textures unless each is disposed.
     */
    _relabel(tracks) {
        if (!this._labels?.length) return;
        const byId = new Map(tracks.map((t) => [t.id, t]));
        for (const entry of this._labels) {
            const t = byId.get(entry.id);
            if (!t) continue;
            const text = etaLabel(t);
            if (text === entry.text) continue;
            const next = makeLabel(text, entry.color, 0.3);
            entry.sprite.material.map?.dispose();
            entry.sprite.material.dispose();
            entry.sprite.material = next.material;
            entry.sprite.scale.copy(next.scale);
            entry.text = text;
        }
    }

    /** Point the sub-Earth Carrington longitude L0 at Earth (+x). */
    _orient(L0) {
        this._L0 = L0;
        this.spinGroup.rotation.set(0, Math.PI - L0 * DEG, 0);
    }

    /**
     * Orient the Sun to a simulated instant.
     *
     * The ONLY way this view rotates. Tilt (B0) is refreshed too: over a full
     * synodic rotation the disc-centre heliographic latitude moves by a
     * degree or two, and holding it fixed would show the axis nodding back to
     * the load-time value whenever a new map arrives.
     *
     * @param {number} epochMs
     * @param {object} [opts] { tracks } — re-label markers with fresh ETAs
     */
    setEpoch(epochMs, opts = {}) {
        const { L0, B0 } = carringtonL0(new Date(epochMs));
        this.sunGroup.rotation.set(0, 0, B0 * DEG);
        this._orient(L0);
        if (opts.tracks) this._relabel(opts.tracks);
        if (!this._raf) this._renderOnce();
        return this;
    }

    /**
     * Dolly out until everything in `_framePoints` is inside the frustum.
     *
     * PerspectiveCamera's `fov` is VERTICAL, so horizontal coverage shrinks as
     * the canvas gets taller relative to its width. Earth sits way out at world
     * x = 3.1 with a caption beyond it, and on a narrow canvas (a phone, or
     * simply a taller panel) it slides out of shot — the sight line runs to the
     * edge and stops, which reads as a rendering bug.
     *
     * Tested against the real frustum rather than solved analytically: the
     * camera is OFF-AXIS (it looks at the origin from above and to the side),
     * so "half the scene width over tan(hFov/2)" is not the answer and quietly
     * under-shoots on square-ish canvases — which is exactly where the problem
     * lives.
     *
     * Monotone by design: never closer than the hand-tuned design framing, only
     * further back when the aspect demands it. Fitting a bounding sphere at the
     * origin instead would be "correct" and would shrink the Sun to a dot,
     * throwing away the composition this view is built around.
     */
    _frameToFit() {
        if (!this._framePoints) return;
        const dir = this.camera.position.clone().normalize();
        const frustum = new THREE.Frustum();
        const mat = new THREE.Matrix4();
        let d = this._designDist;
        for (let i = 0; i < 26; i++) {
            this.camera.position.copy(dir).multiplyScalar(d);
            this.camera.lookAt(this.controls.target);
            this.camera.updateMatrixWorld();
            frustum.setFromProjectionMatrix(mat.multiplyMatrices(
                this.camera.projectionMatrix, this.camera.matrixWorldInverse));
            if (this._framePoints.every((p) => frustum.containsPoint(p))) return;
            d *= 1.07;
            if (d > this.controls.maxDistance) { d = this.controls.maxDistance; break; }
        }
        this.camera.position.copy(dir).multiplyScalar(d);
        this.camera.lookAt(this.controls.target);
    }

    _resize() {
        const w = this.canvas.clientWidth || 600;
        const h = this.canvas.clientHeight || 300;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / Math.max(h, 1);
        this.camera.updateProjectionMatrix();
        // Only auto-frame until the user takes the controls — re-dollying
        // after someone has deliberately zoomed in would fight them.
        if (!this._userMoved) this._frameToFit();
        if (!this._raf) this._renderOnce();
    }

    _renderOnce() {
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    /**
     * Render loop. It advances NOTHING — orientation belongs to setEpoch().
     * It exists so OrbitControls damping stays smooth while the user drags.
     */
    start() {
        if (this._raf) return this;
        const loop = () => {
            this._raf = requestAnimationFrame(loop);
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        };
        this._raf = requestAnimationFrame(loop);
        return this;
    }

    stop() {
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = 0;
        return this;
    }

    _disposeGroup(g) {
        g.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                if (o.material.map) o.material.map.dispose();
                o.material.dispose();
            }
        });
    }

    dispose() {
        this.stop();
        try { this._ro.disconnect(); } catch (_) {}
        this.controls.dispose();
        if (this._fieldTex) this._fieldTex.dispose();
        this._disposeGroup(this.scene);
        this.renderer.dispose();
    }
}

/** Radial glow sprite (additive) for a detection blip. */
function makeGlowSprite(colorHex) {
    const c = new THREE.Color(colorHex);
    const size = 64;
    const cvs = document.createElement('canvas');
    cvs.width = cvs.height = size;
    const ctx = cvs.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    const rgb = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
    g.addColorStop(0, `rgba(${rgb},0.9)`);
    g.addColorStop(0.4, `rgba(${rgb},0.35)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
}
