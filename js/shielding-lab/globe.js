/**
 * globe.js — spherical 3D view for the Shielding Lab.
 *
 * The solved ionospheric state (Φ, ΣP, |E|, ring-current P) is uploaded
 * every frame as nmlt×nlat DataTextures and sampled in a fragment shader
 * on a sphere: the fragment reconstructs (MLAT, MLT) from the surface
 * normal (the js/ring-current-ionosphere.js pattern — periodic wrapS on
 * the MLT axis, cell-centered rows on T). The COLOR MATH deliberately
 * mirrors render.js `_drawHeat` ramp-for-ramp — the 2D dial is the color
 * oracle; if you retune a ramp, change both files in the same commit.
 *
 * Frame convention (self-consistent with the dial's noon-up polar view):
 *   +Y = magnetic north pole, +X = noon (12 MLT), +Z = dusk (18 MLT).
 *   This is the MLAT/MLT frame — the Sun direction is FIXED at +X and
 *   the Earth rotates beneath it, which is why no continents are drawn:
 *   painting geography onto a magnetic-local-time sphere would be a lie.
 *
 * Streaklets are advected in (lat, MLT) by the SOLVED drift field with
 * the exact same math and spatial scale as render.js `_drawStreaks`
 * (physical m/s on the one sim clock), then lifted onto the sphere.
 *
 * Camera: stock OrbitControls (house convention — ring-current-globe.js),
 * damped, gentle auto-rotate until first user grab, double-click resets.
 *
 * The module is loaded lazily by engine.js; any failure (no WebGL, no
 * vendored three) leaves the 2D dial as the view — the page never dies
 * on this file.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const TAU = Math.PI * 2;
const R_ION = 6.481e6;         // ionospheric shell radius (m) — matches render.js
const N_STREAKS = 420;
const TRAIL = 6;               // history points per streak (5 segments)

const VERT = /* glsl */ `
    varying vec3 vDir;
    void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const FRAG = /* glsl */ `
    precision highp float;
    varying vec3 vDir;
    uniform sampler2D uPhi, uSigma, uEmag, uPress;
    uniform float uLatMinDeg;      // 40.0 — equatorward edge of the domain
    uniform float uPhiStepKv;      // contour interval (span/6); 0 disables
    uniform float uCutMlt;         // analysis meridian (hours); <0 hides
    uniform int uCond, uEfield, uContours, uPressOn;

    const float PI = 3.14159265358979;

    void main() {
        vec3 n = normalize(vDir);
        float mlatDeg = degrees(asin(clamp(n.y, -1.0, 1.0)));
        float lon = atan(n.z, n.x);                    // 0 at noon (+X)
        float mltHrs = mod(12.0 + lon * (12.0 / PI), 24.0);

        // Base: dark sphere + faint graticule (10° MLAT / 6 h MLT).
        vec3 col = vec3(0.012, 0.022, 0.05);
        float dLat = fwidth(mlatDeg) + 1e-4;
        float gLat = abs(fract(mlatDeg / 10.0 + 0.5) - 0.5) * 10.0;
        col += vec3(0.045, 0.055, 0.075) * (1.0 - smoothstep(0.0, dLat * 1.2, gLat));
        float mltWrapped = fract(mltHrs / 6.0 + 0.5) - 0.5;   // ±0.5, 0 on a spoke
        float dMlt = fwidth(mltHrs) + 1e-4;
        float gMlt = abs(mltWrapped) * 6.0;
        // Fade spokes near the poles where they'd bunch into noise.
        float spokeFade = smoothstep(87.0, 80.0, abs(mlatDeg));
        col += vec3(0.045, 0.055, 0.075) * (1.0 - smoothstep(0.0, dMlt * 1.2, gMlt)) * spokeFade;

        // Fixed-Sun day tint: honest for this frame — noon IS +X here.
        float day = clamp(dot(n, vec3(1.0, 0.0, 0.0)), 0.0, 1.0);
        col += vec3(0.030, 0.024, 0.012) * day * day;

        // Solved domain: the northern polar cap, MLAT ≥ uLatMinDeg.
        if (mlatDeg >= uLatMinDeg) {
            // Texel mapping: u = mlt/24 (RepeatWrapping does the periodic
            // bilinear), v = fraction of colatitude span — row i center at
            // latMin + (i+0.5)·dlat lands exactly on texel center (i+0.5)/nlat.
            vec2 uv = vec2(mltHrs / 24.0, (mlatDeg - uLatMinDeg) / (90.0 - uLatMinDeg));

            // ΣP 0.5–14 S — deep blue-gray ramp (mirror of render.js).
            if (uCond == 1) {
                float sp = texture2D(uSigma, uv).r;
                float t = min(log(1.0 + sp) / log(15.0), 1.0);
                col = vec3(8.0 + 40.0 * t, 14.0 + 58.0 * t, 26.0 + 84.0 * t) / 255.0;
            }
            // Ring-current pressure 0.5→25 nPa — violet glow (drift R2 only).
            if (uPressOn == 1) {
                float p = texture2D(uPress, uv).r;
                float t = clamp((p - 0.5) / 24.5, 0.0, 1.0);
                float w = sqrt(t) * 0.85;
                col = mix(col, vec3(185.0, 80.0, 255.0) / 255.0, w);
            }
            // |E| 5→60 mV/m — transparent → amber → hot. SAPS glows here.
            if (uEfield == 1) {
                float e = texture2D(uEmag, uv).r;
                float t = clamp((e - 5.0) / 55.0, 0.0, 1.0);
                float w = t * t * (3.0 - 2.0 * t);
                col = mix(col, vec3(255.0, 140.0 + 60.0 * (1.0 - t), 60.0 * (1.0 - t)) / 255.0, w);
            }
            // Φ equipotentials = E×B streamlines. Same levels as the dial:
            // 6 per sign of the symmetric span, zero level skipped; cyan
            // positive (dawn cell), amber negative (dusk cell).
            if (uContours == 1 && uPhiStepKv > 0.0) {
                float phi = texture2D(uPhi, uv).r;
                float f = phi / uPhiStepKv;
                float k = floor(f + 0.5);
                if (abs(k) > 0.5) {
                    float d = abs(f - k) / max(fwidth(f), 1e-4);
                    float line = 1.0 - smoothstep(0.5, 1.6, d);
                    vec3 lc = phi > 0.0 ? vec3(0.0, 0.78, 1.0) : vec3(1.0, 0.69, 0.40);
                    col = mix(col, lc, line * 0.75);
                }
            }
        }

        // Domain rim at 40° MLAT (the Φ = 0 boundary — dial's cyan rim).
        float rim = 1.0 - smoothstep(0.0, dLat * 1.6, abs(mlatDeg - uLatMinDeg));
        col = mix(col, vec3(0.0, 0.78, 1.0), rim * 0.35);

        // Analysis meridian (SAPS profile cut) — amber arc, subauroral north.
        if (uCutMlt >= 0.0 && mlatDeg > uLatMinDeg) {
            float dm = abs(mltHrs - uCutMlt);
            dm = min(dm, 24.0 - dm);
            float cut = 1.0 - smoothstep(0.0, dMlt * 1.5 + 0.02, dm);
            col = mix(col, vec3(1.0, 0.69, 0.40), cut * 0.45);
        }

        gl_FragColor = vec4(col, 1.0);
    }
`;

// Fresnel atmosphere shell — presentation only, carries no data.
const ATMO_VERT = /* glsl */ `
    varying vec3 vN, vV;
    void main() {
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
    }
`;
const ATMO_FRAG = /* glsl */ `
    precision highp float;
    varying vec3 vN, vV;
    void main() {
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
        gl_FragColor = vec4(vec3(0.0, 0.55, 0.9) * f, f * 0.55);
    }
`;

/** (lat°, MLT h) → unit-sphere position in the frame above. */
function toSphere(latDeg, mltHrs, r, out) {
    const th = (90 - latDeg) * Math.PI / 180;       // colatitude
    const lon = ((mltHrs - 12) / 24) * TAU;         // 0 at noon
    const s = Math.sin(th);
    out.set(r * s * Math.cos(lon), r * Math.cos(th), r * s * Math.sin(lon));
    return out;
}

function labelSprite(text, { size = 44, color = 'rgba(205,213,228,0.9)' } = {}) {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const font = `600 ${size}px 'Segoe UI', system-ui, sans-serif`;
    ctx.font = font;
    c.width = Math.ceil(ctx.measureText(text).width) + 16;
    c.height = size + 18;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, c.width / 2, c.height / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false,
    }));
    const base = 0.14;
    spr.scale.set(base * c.width / c.height, base, 1);
    return spr;
}

const HOME_POS = new THREE.Vector3(1.15, 2.15, 1.55);

export class GlobeRenderer {
    /** meta: {nlat, nmlt, latMinDeg, dlatDeg} from kernel.js */
    constructor(canvas, meta) {
        this.canvas = canvas;
        this.meta = meta;
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        const gl = this.renderer.getContext();
        if (!gl) throw new Error('WebGL unavailable');
        this.renderer.setClearColor(0x000000, 0);

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
        this.camera.position.copy(HOME_POS);

        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.06;
        this.controls.minDistance = 1.35;
        this.controls.maxDistance = 7;
        this.controls.enablePan = false;
        this.controls.autoRotate = true;          // attract until first grab
        this.controls.autoRotateSpeed = 0.5;
        this.controls.addEventListener('start', () => { this.controls.autoRotate = false; });
        canvas.addEventListener('dblclick', () => this.resetView());

        const { nlat, nmlt } = meta;
        // Linear filtering of float textures needs OES_texture_float_linear
        // (near-universal, but a guarantee it is not) — degrade to nearest
        // texel sampling rather than sampling black.
        const floatLinear = !!gl.getExtension('OES_texture_float_linear');
        const filt = floatLinear ? THREE.LinearFilter : THREE.NearestFilter;
        const mkTex = () => {
            const t = new THREE.DataTexture(
                new Float32Array(nlat * nmlt), nmlt, nlat,
                THREE.RedFormat, THREE.FloatType,
            );
            t.wrapS = THREE.RepeatWrapping;          // MLT is periodic
            t.wrapT = THREE.ClampToEdgeWrapping;
            t.magFilter = filt;
            t.minFilter = filt;
            return t;
        };
        this.tex = { phi: mkTex(), sigma: mkTex(), emag: mkTex(), press: mkTex() };

        this.uniforms = {
            uPhi: { value: this.tex.phi },
            uSigma: { value: this.tex.sigma },
            uEmag: { value: this.tex.emag },
            uPress: { value: this.tex.press },
            uLatMinDeg: { value: meta.latMinDeg },
            uPhiStepKv: { value: 0 },
            uCutMlt: { value: 21 },
            uCond: { value: 1 },
            uEfield: { value: 1 },
            uContours: { value: 1 },
            uPressOn: { value: 0 },
        };
        this.globe = new THREE.Mesh(
            new THREE.SphereGeometry(1, 128, 96),
            new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms }),
        );
        this.scene.add(this.globe);

        const atmo = new THREE.Mesh(
            new THREE.SphereGeometry(1.045, 64, 48),
            new THREE.ShaderMaterial({
                vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG,
                transparent: true, side: THREE.BackSide, depthWrite: false,
            }),
        );
        this.scene.add(atmo);

        this._buildChrome();
        this._buildStreaks();
        this._buildProbeMarker();

        this._v = new THREE.Vector3();
        this._raycaster = new THREE.Raycaster();
        this.size = 0;
        this.resize();
    }

    _buildChrome() {
        const { latMinDeg } = this.meta;
        const mat = new THREE.LineBasicMaterial({
            color: 0x7890b4, transparent: true, opacity: 0.28, depthWrite: false,
        });
        const v = new THREE.Vector3();
        // MLAT reference rings (the dial's 50/60/70/80° rings).
        for (const lat of [50, 60, 70, 80]) {
            const pts = [];
            for (let i = 0; i <= 96; i++) {
                pts.push(toSphere(lat, (i / 96) * 24, 1.004, v).clone());
            }
            this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
        }
        // MLT anchor labels just off the rim, and one ring label at noon.
        const put = (spr, lat, mlt, r) => {
            toSphere(lat, mlt, r, v);
            spr.position.copy(v);
            this.scene.add(spr);
        };
        put(labelSprite('12 · noon'), latMinDeg - 4, 12, 1.10);
        put(labelSprite('00'), latMinDeg - 4, 0, 1.10);
        put(labelSprite('06 · dawn'), latMinDeg - 4, 6, 1.10);
        put(labelSprite('18 · dusk'), latMinDeg - 4, 18, 1.10);
        put(labelSprite('70°', { color: 'rgba(139,148,173,0.85)', size: 34 }), 70, 12, 1.05);
        put(labelSprite('50°', { color: 'rgba(139,148,173,0.85)', size: 34 }), 50, 12, 1.05);
        // North-pole tick so orientation reads at a glance while orbiting.
        put(labelSprite('N · magnetic pole', { color: 'rgba(139,148,173,0.8)', size: 30 }), 90, 0, 1.09);
    }

    _buildStreaks() {
        // TRAIL−1 segments per streak, position buffer updated in place.
        const segs = N_STREAKS * (TRAIL - 1);
        this._streakGeom = new THREE.BufferGeometry();
        this._streakPos = new Float32Array(segs * 2 * 3);
        this._streakCol = new Float32Array(segs * 2 * 3);
        this._streakGeom.setAttribute('position', new THREE.BufferAttribute(this._streakPos, 3));
        this._streakGeom.setAttribute('color', new THREE.BufferAttribute(this._streakCol, 3));
        this._streakLines = new THREE.LineSegments(
            this._streakGeom,
            new THREE.LineBasicMaterial({
                vertexColors: true, transparent: true, opacity: 0.85,
                blending: THREE.AdditiveBlending, depthWrite: false,
            }),
        );
        this.scene.add(this._streakLines);
        this.streaks = [];
    }

    _buildProbeMarker() {
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.018, 0.026, 32),
            new THREE.MeshBasicMaterial({
                color: 0x7fe6c3, side: THREE.DoubleSide, transparent: true,
                opacity: 0.95, depthWrite: false,
            }),
        );
        ring.visible = false;
        this.scene.add(ring);
        this._probeRing = ring;
    }

    resize() {
        const css = Math.max(240, Math.min(this.canvas.clientWidth, this.canvas.clientHeight)
            || this.canvas.clientWidth || 560);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const px = Math.round(css * dpr);
        if (px === this.size) return;
        this.size = px;
        this.renderer.setPixelRatio(dpr);
        this.renderer.setSize(css, css, false);
        this.camera.aspect = 1;
        this.camera.updateProjectionMatrix();
    }

    resetView() {
        this.camera.position.copy(HOME_POS);
        this.controls.target.set(0, 0, 0);
        this.controls.update();
    }

    /** Device-pixel canvas coords → {mlatDeg, mltHrs} on the cap, or null. */
    fromScreen(x, y) {
        const ndc = { x: (x / this.size) * 2 - 1, y: -((y / this.size) * 2 - 1) };
        this._raycaster.setFromCamera(ndc, this.camera);
        const hits = this._raycaster.intersectObject(this.globe, false);
        if (!hits.length) return null;
        const n = hits[0].point.clone().normalize();
        const mlatDeg = Math.asin(Math.min(Math.max(n.y, -1), 1)) * 180 / Math.PI;
        if (mlatDeg < this.meta.latMinDeg) return null;
        let mlt = 12 + Math.atan2(n.z, n.x) * (12 / Math.PI);
        mlt = ((mlt % 24) + 24) % 24;
        return { mlatDeg, mltHrs: mlt };
    }

    _sample(field, latDeg, mltHrs) {
        const { nlat, nmlt, latMinDeg, dlatDeg } = this.meta;
        const dmlt = 24 / nmlt;
        let fi = (latDeg - latMinDeg) / dlatDeg - 0.5;
        fi = Math.min(Math.max(fi, 0), nlat - 1.001);
        let fj = mltHrs / dmlt - 0.5;
        if (fj < 0) fj += nmlt;
        const i0 = Math.floor(fi), j0 = Math.floor(fj) % nmlt;
        const fx = fi - i0, fy = fj - Math.floor(fj);
        const i1 = Math.min(i0 + 1, nlat - 1), j1 = (j0 + 1) % nmlt;
        const a = field[i0 * nmlt + j0], b = field[i0 * nmlt + j1];
        const c = field[i1 * nmlt + j0], d = field[i1 * nmlt + j1];
        return (a * (1 - fy) + b * fy) * (1 - fx) + (c * (1 - fy) + d * fy) * fx;
    }

    _spawnStreak() {
        const u = Math.random();
        return {
            lat: u < 0.55 ? 55 + Math.random() * 25 : 41 + Math.random() * 48,
            mlt: Math.random() * 24,
            age: 0,
            life: 1200 + Math.random() * 2400,
            speed: 0,
            hist: null,
        };
    }

    /** Same advection math + spatial scale as render.js _drawStreaks. */
    _advectStreaks(frame, dtSimS) {
        const { latMinDeg } = this.meta;
        while (this.streaks.length < N_STREAKS) this.streaks.push(this._spawnStreak());
        const latMax = 90 - 0.4, latMin = latMinDeg + 0.3;
        const sub = Math.min(Math.ceil(dtSimS / 40), 8) || 1;
        const dt = dtSimS / sub;
        const v = this._v;
        for (const p of this.streaks) {
            for (let ss = 0; ss < sub; ss++) {
                const vE = this._sample(frame.vE, p.lat, p.mlt);
                const vN = this._sample(frame.vN, p.lat, p.mlt);
                const colat = (90 - p.lat) * Math.PI / 180;
                p.lat += (vN / R_ION) * dt * (180 / Math.PI);
                p.mlt += (vE / (R_ION * Math.sin(Math.max(colat, 0.02)))) * dt * (24 / TAU);
                p.speed = Math.hypot(vE, vN);
            }
            p.mlt = ((p.mlt % 24) + 24) % 24;
            p.age += dtSimS;
            if (p.lat > latMax || p.lat < latMin || p.age > p.life) {
                Object.assign(p, this._spawnStreak());
            }
            toSphere(p.lat, p.mlt, 1.006, v);
            if (!p.hist) {
                p.hist = new Float32Array(TRAIL * 3);
                for (let h = 0; h < TRAIL; h++) p.hist.set([v.x, v.y, v.z], h * 3);
            } else {
                p.hist.copyWithin(3, 0, (TRAIL - 1) * 3);
                p.hist.set([v.x, v.y, v.z], 0);
            }
        }
        // Rebuild segment buffers: head bright, tail dark, speed-weighted.
        const pos = this._streakPos, col = this._streakCol;
        let o = 0;
        for (const p of this.streaks) {
            const w = Math.min((p.speed || 0) / 900, 1);
            const r = (140 + 80 * w) / 255, g = 220 / 255, b = 1;
            for (let hSeg = 0; hSeg < TRAIL - 1; hSeg++) {
                const fade = (0.25 + 0.55 * w) * (1 - hSeg / (TRAIL - 1));
                pos.set(p.hist.subarray(hSeg * 3, hSeg * 3 + 3), o);
                pos.set(p.hist.subarray(hSeg * 3 + 3, hSeg * 3 + 6), o + 3);
                col[o] = r * fade; col[o + 1] = g * fade; col[o + 2] = b * fade;
                col[o + 3] = r * fade * 0.6; col[o + 4] = g * fade * 0.6; col[o + 5] = b * fade * 0.6;
                o += 6;
            }
        }
        this._streakGeom.attributes.position.needsUpdate = true;
        this._streakGeom.attributes.color.needsUpdate = true;
    }

    /**
     * frame: {phi, sigmaP, emag, vE, vN, pressure} Float32Arrays.
     * opts: {layers, dtSimS, probe, cutMlt} — same contract as DialRenderer
     * plus cutMlt (the analysis meridian, hours; null hides it).
     */
    draw(frame, opts) {
        const u = this.uniforms;
        this.tex.phi.image.data.set(frame.phi);
        this.tex.sigma.image.data.set(frame.sigmaP);
        this.tex.emag.image.data.set(frame.emag);
        this.tex.phi.needsUpdate = true;
        this.tex.sigma.needsUpdate = true;
        this.tex.emag.needsUpdate = true;
        if (opts.layers.pressure && frame.pressure) {
            this.tex.press.image.data.set(frame.pressure);
            this.tex.press.needsUpdate = true;
        }

        // Contour interval: same symmetric-span/6 rule as the 2D dial.
        let lo = Infinity, hi = -Infinity;
        const phi = frame.phi;
        for (let k = 0; k < phi.length; k++) {
            const p = phi[k];
            if (p < lo) lo = p;
            if (p > hi) hi = p;
        }
        const span = Math.max(hi, -lo);
        u.uPhiStepKv.value = span > 0.5 ? span / 6 : 0;

        u.uCond.value = opts.layers.cond ? 1 : 0;
        u.uEfield.value = opts.layers.efield ? 1 : 0;
        u.uContours.value = opts.layers.contours ? 1 : 0;
        u.uPressOn.value = opts.layers.pressure && frame.pressure ? 1 : 0;
        u.uCutMlt.value = opts.cutMlt == null ? -1 : opts.cutMlt;

        this._streakLines.visible = !!opts.layers.drift;
        if (opts.layers.drift && opts.dtSimS > 0) this._advectStreaks(frame, opts.dtSimS);

        if (opts.probe) {
            toSphere(opts.probe.mlatDeg, opts.probe.mltHrs, 1.008, this._v);
            this._probeRing.position.copy(this._v);
            this._probeRing.lookAt(this._v.clone().multiplyScalar(2));
            this._probeRing.visible = true;
        } else {
            this._probeRing.visible = false;
        }

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}
