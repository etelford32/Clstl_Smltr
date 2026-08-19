/**
 * js/corridor/corridor-view.js — the 3D Earth-arrival corridor.
 *
 * Browser-only renderer. ALL testable logic lives in
 * js/corridor/corridor-model.js (node-gated); this file only draws what that
 * module, js/stage/scale.js and the flux-rope kernel already say.
 *
 * ── One scene, three programmes ────────────────────────────────────────
 *
 *   Far-Side Watch  → the Sun's phase-shift field and the tracked source
 *                     regions rotating across the disc.
 *   Flux-rope       → the compounding train in transit, geometry straight
 *                     from the kernel probes the shared provider ran.
 *   CME forecast    → the issue-locked arrival window, drawn at Earth as a
 *                     TIME interval and never as invented rope geometry.
 *
 * Nothing here recomputes any of them.
 *
 * ── Frames and the one bit of trickery ─────────────────────────────────
 *
 * Heliocentric, +x Sun→Earth, +z ecliptic north — the flux-rope convention,
 * so rope frames drop in untouched.
 *
 * The Sun is NOT rotated as an object. Its photosphere shader derives
 * Carrington longitude per fragment from the world direction plus the
 * uniform `uL0`, so advancing the clock sweeps the field while the mesh
 * stands still. That matters because the source-region markers are placed
 * in the world frame from their central-meridian distance (which already
 * contains L0): rotating a textured mesh under fixed markers is exactly how
 * a field and its own detections drift apart, and there is no rotation here
 * to get wrong. uL0 is the single place the clock touches the Sun.
 *
 * ── Disclosed dishonesty ───────────────────────────────────────────────
 *
 * Radial distance is log-compressed and the bodies are enlarged, both via
 * js/stage/scale.js — the ONE place the repo keeps its spatial fibs, with
 * the factors it states. This view adds none of its own: every position
 * goes through stagePoint(), every body radius through BODY. The compression
 * is removable (`setTrueScale`), which is what makes it honest.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { stagePoint, stageRadius, rulerTicks, BODY, EARTH_S } from '../stage/scale.js';
import { ropeSurfaceGrid } from '../stage/model.js';
import { fieldCanvas } from '../farside/farside-render.js';
import { SUN_R_AU } from './corridor-model.js';

const DEG = Math.PI / 180;
const N_PSI = 40, N_THETA = 16;

const ROPE_COLORS = [0x8fd8ff, 0xc792ea, 0xffb454, 0x7fe6c3, 0xff8aa8, 0x9ebaff];

/* ── Photosphere ─────────────────────────────────────────────────────── */

const SUN_VERT = /* glsl */`
    varying vec3 vDir;
    void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;

// vDir is the CMD direction because the mesh is never rotated (see header).
// Carrington longitude = CMD + L0, which is the only place the clock enters.
const SUN_FRAG = /* glsl */`
    precision highp float;
    uniform sampler2D uField;
    uniform float uL0;          // degrees
    uniform float uHasField;
    varying vec3 vDir;
    const float PI = 3.141592653589793;
    void main() {
        float cmd = atan(vDir.y, vDir.x) * 180.0 / PI;
        float carr = mod(cmd + uL0, 360.0);
        vec2 uv = vec2(carr / 360.0, 0.5 + asin(clamp(vDir.z, -1.0, 1.0)) / PI);
        vec3 col = uHasField > 0.5
            ? texture2D(uField, uv).rgb
            : vec3(0.32, 0.16, 0.06);
        // vDir.x > 0 faces Earth. Lift the near side, wash the far side violet
        // so "which half can we not see" reads without a label.
        float face = vDir.x;
        col *= mix(0.72, 1.20, smoothstep(-0.25, 0.85, face));
        float far = smoothstep(0.15, -0.7, face);
        col = mix(col, col * vec3(0.62, 0.5, 1.05) + vec3(0.05, 0.03, 0.10), far * 0.5);
        gl_FragColor = vec4(col, 1.0);
    }`;

function disposeDeep(obj) {
    obj?.traverse?.((o) => {
        o.geometry?.dispose?.();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => { x.map?.dispose?.(); x.dispose?.(); });
        else if (m) { m.map?.dispose?.(); m.dispose?.(); }
    });
}

/** Screen-space text sprite (same recipe as the far-side globe). */
function makeLabel(text, color = '#cdd5e4', scale = 0.16) {
    const pad = 8, font = 42;
    const cvs = document.createElement('canvas');
    const probe = cvs.getContext('2d');
    probe.font = `700 ${font}px ui-monospace, Menlo, monospace`;
    cvs.width = Math.ceil(probe.measureText(text).width) + pad * 2;
    cvs.height = font + pad * 2;
    const ctx = cvs.getContext('2d');
    ctx.font = `700 ${font}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(4,6,20,0.66)';
    ctx.fillRect(0, 0, cvs.width, cvs.height);
    ctx.fillStyle = color;
    ctx.fillText(text, pad, cvs.height / 2);
    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthTest: false,
    }));
    spr.scale.set(scale * (cvs.width / cvs.height), scale, 1);
    return spr;
}

export class CorridorView {
    constructor(canvas) {
        this.canvas = canvas;
        this._raf = 0;
        this._mix = 0;              // 0 = compressed, 1 = true scale
        this._L0 = 0;
        this._userMoved = false;

        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
        this.scene = new THREE.Scene();

        this.camera = new THREE.PerspectiveCamera(40, 1, 0.005, 200);
        this.camera.up.set(0, 0, 1);            // ecliptic north is +z
        this.camera.position.set(1.4, -4.2, 2.4);

        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.enablePan = false;
        // minDistance is well inside the drawn Sun (0.12 units) so the
        // surface regions can actually be inspected — this scene has content
        // at two very different scales and the camera has to reach both.
        this.controls.minDistance = 0.18;
        this.controls.maxDistance = 22;
        this.controls.target.set(EARTH_S * 0.5, 0, 0);
        this.controls.addEventListener('start', () => { this._userMoved = true; });

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));

        this._buildSun();
        this._buildEarth();
        this._buildRuler();

        this._ropeGroup = new THREE.Group();
        this.scene.add(this._ropeGroup);
        this._sourceGroup = new THREE.Group();
        this.scene.add(this._sourceGroup);
        this._sourceMeta = [];
        this._trainMeta = [];

        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(canvas);
        this._resize();
    }

    /* ── Static furniture ────────────────────────────────────────────── */

    _buildSun() {
        this._sunUniforms = {
            uField: { value: null },
            uL0: { value: 0 },
            uHasField: { value: 0 },
        };
        this.sunMesh = new THREE.Mesh(
            new THREE.SphereGeometry(1, 64, 48),
            new THREE.ShaderMaterial({
                uniforms: this._sunUniforms,
                vertexShader: SUN_VERT,
                fragmentShader: SUN_FRAG,
            }),
        );
        this.sunMesh.scale.setScalar(BODY.sunRadiusUnits);
        this.scene.add(this.sunMesh);

        // Corona wash, and the east limb — the line regions cross to become
        // visible, and the one place the far-side programme hands over.
        const glow = new THREE.Mesh(
            new THREE.SphereGeometry(1, 32, 24),
            new THREE.MeshBasicMaterial({
                color: 0xffb454, transparent: true, opacity: 0.1, side: THREE.BackSide,
            }),
        );
        glow.scale.setScalar(BODY.sunRadiusUnits * 1.45);
        this.scene.add(glow);

        const limb = new THREE.Mesh(
            new THREE.TorusGeometry(BODY.sunRadiusUnits * 1.02, BODY.sunRadiusUnits * 0.012, 8, 96),
            new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.75 }),
        );
        // Ring in the plane x = 0: the terminator between the hemisphere Earth
        // can see and the one only holography reaches.
        limb.rotation.y = Math.PI / 2;
        this.scene.add(limb);
        // No text label here: it sits inside the same few tenths of a unit as
        // every source-region caption and collided with all of them. The blue
        // ring plus the panel legend carry it.
    }

    _buildEarth() {
        this.earth = new THREE.Mesh(
            new THREE.SphereGeometry(BODY.earthRadiusUnits * 4, 24, 18),
            new THREE.MeshBasicMaterial({ color: 0x4d8cff }),
        );
        this.scene.add(this.earth);
        this._earthLabel = makeLabel('Earth · L1', '#9ec8ff', 0.13);
        this.scene.add(this._earthLabel);

        // The arrival window, drawn as a shell at Earth. It is a TIME interval
        // from the issue-locked ledger, not a modelled surface, so it never
        // pretends to be rope geometry.
        // Wireframe, not a solid shell: filled, it read as a large brown
        // OBJECT sitting at L1 — the biggest thing in a scene that is about a
        // Sun and a rope. An uncertainty region should look like a region.
        this._arrival = new THREE.LineSegments(
            new THREE.WireframeGeometry(new THREE.SphereGeometry(1, 16, 10)),
            new THREE.LineBasicMaterial({
                color: 0xffb454, transparent: true, opacity: 0.3, depthWrite: false,
            }),
        );
        this._arrival.visible = false;
        this.scene.add(this._arrival);
        this._placeEarth();
    }

    _placeEarth() {
        const s = stageRadius(1, this._mix);
        this.earth.position.set(s, 0, 0);
        this._earthLabel.position.set(s, 0, BODY.earthRadiusUnits * 12);
        this._arrival.position.set(s, 0, 0);
    }

    _buildRuler() {
        if (this._ruler) { this.scene.remove(this._ruler); disposeDeep(this._ruler); }
        this._ruler = new THREE.Group();
        for (const { rAu, s } of rulerTicks(this._mix)) {
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(s, 0.0035, 6, 96),
                new THREE.MeshBasicMaterial({
                    // Faint: these are a measuring grid, and at full strength
                    // they read as orbits — which would be a physics claim.
                    color: 0x6a7590, transparent: true, opacity: rAu === 1 ? 0.3 : 0.13,
                }),
            );
            this._ruler.add(ring);          // torus lies in the xy plane already
            const lab = makeLabel(`${rAu} AU`, '#5c6480', 0.06);
            lab.position.set(0, -s, 0);
            this._ruler.add(lab);
        }
        this.scene.add(this._ruler);
    }

    /* ── Inputs ──────────────────────────────────────────────────────── */

    /** The far-side phase-shift field to wrap on the photosphere. */
    setField(map) {
        this._sunUniforms.uField.value?.dispose?.();
        if (!map?.data) {
            this._sunUniforms.uField.value = null;
            this._sunUniforms.uHasField.value = 0;
            return this;
        }
        const tex = new THREE.CanvasTexture(fieldCanvas(map));
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.anisotropy = 4;
        this._sunUniforms.uField.value = tex;
        this._sunUniforms.uHasField.value = 1;
        return this;
    }

    /**
     * Orient the Sun's field to an instant. Markers are NOT moved here — the
     * caller passes already-projected regions to setSources, so both come
     * from the one projection the watch list also uses.
     */
    setL0(l0Deg) {
        this._L0 = l0Deg;
        this._sunUniforms.uL0.value = l0Deg;
        return this;
    }

    /**
     * Source regions from Far-Side Watch, already placed by
     * corridor-model.placeSourceRegions.
     */
    setSources(regions) {
        this.scene.remove(this._sourceGroup);
        disposeDeep(this._sourceGroup);
        this._sourceGroup = new THREE.Group();
        this._sourceMeta = (regions || []).map((r) => ({ cmd: r.cmd, hasFlare: !!r.flare }));

        for (const r of regions || []) {
            const color = r.onDisc ? 0x7fe6c3 : (r.strong ? 0xffd166 : 0xffab6b);
            const pos = new THREE.Vector3(...r.dir).multiplyScalar(BODY.sunRadiusUnits * 1.03);

            const blip = new THREE.Mesh(
                new THREE.SphereGeometry(BODY.sunRadiusUnits * (r.strong ? 0.13 : 0.1), 12, 10),
                new THREE.MeshBasicMaterial({ color }),
            );
            blip.position.copy(pos);
            this._sourceGroup.add(blip);

            // Caption: the flare base rate when the climatology can support
            // one, otherwise the rotation lead time. Never a fabricated
            // percentage — a null base rate simply does not print.
            // Rotation lead time first — it is what this page can actually
            // forecast. The flare figure is the DAILY base rate (never the
            // compounded passage bound, which saturates at ~100 %) and is
            // suffixed so it cannot be read as a prediction about this region.
            const eta = r.onDisc ? 'on disc' : `~${(r.etaDays ?? 0).toFixed(1)}d`;
            const caption = r.flare
                ? `${eta} · ${Math.round(r.flare.pDaily * 100)}%/d M base`
                : eta;
            const lab = makeLabel(caption, r.onDisc ? '#7fe6c3' : '#ffd9bf', 0.075);
            lab.position.copy(pos.clone().multiplyScalar(1.0)
                .add(new THREE.Vector3(0, 0, BODY.sunRadiusUnits * (r.strong ? 1.5 : 1.0))));
            this._sourceGroup.add(lab);
        }
        this.scene.add(this._sourceGroup);
        return this;
    }

    /**
     * The rope train at this instant, from corridor-model.trainAt.
     *
     * Surface vertices arrive in physical AU and are pushed through
     * stagePoint so the ropes live under the same compression as everything
     * else. Rebuilt per call: at ~40×16 vertices a rope this is cheaper than
     * tracking which member changed, and the train membership itself changes
     * as members launch.
     */
    setTrain(train) {
        this.scene.remove(this._ropeGroup);
        disposeDeep(this._ropeGroup);
        this._ropeGroup = new THREE.Group();
        this._trainMeta = (train || []).map((m) => ({
            index: m.index, lonDeg: m.rope.lonDeg, dAu: m.geometry.dAu, oracle: m.geometry.oracle,
        }));

        for (const member of train || []) {
            const { positions, indices } = ropeSurfaceGrid(member.geometry, N_PSI, N_THETA);
            const mapped = new Float32Array(positions.length);
            const p = [0, 0, 0];
            for (let i = 0; i < positions.length; i += 3) {
                stagePoint([positions[i], positions[i + 1], positions[i + 2]], this._mix, p);
                mapped[i] = p[0]; mapped[i + 1] = p[1]; mapped[i + 2] = p[2];
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(mapped, 3));
            geo.setIndex(new THREE.BufferAttribute(indices, 1));   // already Uint32Array
            geo.computeVertexNormals();

            const color = ROPE_COLORS[member.index % ROPE_COLORS.length];
            this._ropeGroup.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
                color, transparent: true, opacity: 0.3,
                side: THREE.DoubleSide, depthWrite: false,
            })));
            this._ropeGroup.add(new THREE.LineSegments(
                new THREE.WireframeGeometry(geo),
                new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.16 }),
            ));

            // Apex marker: how far this member has actually got.
            const apex = new THREE.Vector3(...member.geometry.frame.eDir)
                .multiplyScalar(stageRadius(member.geometry.dAu, this._mix));
            const nose = new THREE.Mesh(
                new THREE.SphereGeometry(0.028, 12, 10),
                new THREE.MeshBasicMaterial({ color }),
            );
            nose.position.copy(apex);
            this._ropeGroup.add(nose);
        }
        this.scene.add(this._ropeGroup);
        return this;
    }

    /** Arrival-window state from corridor-model.arrivalWindowState. */
    setArrival(state) {
        if (!state) { this._arrival.visible = false; return this; }
        this._arrival.visible = true;
        // Radius shrinks as τ crosses the window: wide while the arrival is
        // uncertain and far off, tight when it is imminent.
        const t = Math.min(Math.max(state.fraction, 0), 1);
        // Sized against the DRAWN Earth, not the corridor: at the old scale
        // this bubble was five times the Sun and read as the dominant object
        // in a scene that is supposed to be about the Sun and a rope.
        const r = BODY.earthRadiusUnits * (11 - 6 * t);
        this._arrival.scale.setScalar(r);
        this._arrival.material.color.setHex(state.open ? 0xff6b8a : 0xffb454);
        this._arrival.material.opacity = state.past ? 0.1 : (state.open ? 0.55 : 0.3);
        return this;
    }

    /**
     * Jump the camera to a named vantage.
     *
     * The corridor spans four orders of magnitude — a region a few hundredths
     * of a unit across, and Earth three units away — so "just drag" is not a
     * usable way to get between the two ends of the story.
     */
    flyTo(station) {
        const s = stageRadius(1, this._mix);
        const poses = {
            sun: { pos: [0.42, -0.42, 0.26], target: [0, 0, 0] },
            corridor: { pos: [s * 0.45, -s * 1.4, s * 0.8], target: [s * 0.5, 0, 0] },
            earth: { pos: [s + 0.5, -0.75, 0.42], target: [s, 0, 0] },
        };
        const p = poses[station] || poses.corridor;
        this.camera.position.set(...p.pos);
        this.controls.target.set(...p.target);
        this.controls.update();
        if (!this._raf) this.renderOnce();
        return this;
    }

    /**
     * Scene facts for the browser gate (tests/cme-corridor.spec.js).
     *
     * Reports what was actually BUILT, not what was asked for: counting the
     * meshes in the scene is the only way a test can tell "the train is drawn"
     * from "the train was requested and silently produced nothing".
     */
    probe() {
        return {
            L0: this._L0,
            mix: this._mix,
            earthX: this.earth.position.x,
            rulerRadii: rulerTicks(this._mix).map((t) => t.s),
            sources: this._sourceMeta.length,
            firstSourceCmd: this._sourceMeta[0]?.cmd ?? null,
            flareCaptions: this._sourceMeta.filter((m) => m.hasFlare).length,
            ropes: this._trainMeta.length,
            ropeHeadings: this._trainMeta.map((m) => m.lonDeg),
            leadApexAu: this._trainMeta.reduce((a, m) => Math.max(a, m.dAu), 0),
            arrivalVisible: !!this._arrival.visible,
        };
    }

    /** Blend the radial compression away (1 = true scale). */
    setTrueScale(on) {
        this._mix = on ? 1 : 0;
        this._placeEarth();
        this._buildRuler();
        return this;
    }

    /* ── Loop ────────────────────────────────────────────────────────── */

    _resize() {
        const w = this.canvas.clientWidth || 600;
        const h = this.canvas.clientHeight || 300;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / Math.max(h, 1);
        this.camera.updateProjectionMatrix();
        if (!this._raf) this.renderOnce();
    }

    renderOnce() {
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
        this.canvas.dataset.ready = 'true';
    }

    /** Render loop — advances nothing; the page's clock owns time. */
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

    dispose() {
        this.stop();
        this._ro?.disconnect();
        this.controls?.dispose();
        disposeDeep(this.scene);
        this._sunUniforms?.uField?.value?.dispose?.();
        this.renderer?.dispose();
    }
}
