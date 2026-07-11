/**
 * ring-current-globe.js — Three.js digital twin scene for ring-current.html
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * FRAME — true GSM, rigidly mapped (Earth at origin, 1 unit = 1 R_E):
 *   scene +X = GSM +X  (Sun–Earth line: the Sun really is exactly there)
 *   scene +Y = GSM +Z  ("north")
 *   scene −Z = GSM +Y  (dusk)   ⇒ right-handed, no mirroring
 * MLT = (12 − θ·12/π) mod 24 where θ = atan2(z, x): noon at +X, DAWN at +Z,
 * dusk at −Z. (Before 2026-07-11 the code used MLT = 12 + θ·12/π, which is a
 * MIRRORED frame — impossible to reconcile with a real Earth texture — and
 * under it the "dusk" partial-ring arc actually rendered at 13 MLT. Verified
 * numerically before the flip; both are fixed together.)
 *
 * REAL-TIME accuracy (all clock-driven, independent of the drift slider):
 *   · Earth spins at the true rate with the true phase: the subsolar
 *     longitude faces +X and the axis tilts by the live solar declination
 *     (subsolarPoint), so the terminator, seasons and day/night hemisphere
 *     are the actual ones right now.
 *   · The whole magnetosphere group (field cage, populations, torus, arc,
 *     plasmapause) tilts about scene Z by −ψ, the live GSM dipole tilt
 *     (dipoleTiltRad) — by GSM's definition the dipole axis lies in the
 *     X–Z(GSM) plane, so one axis suffices. Watch the ±11° diurnal wobble
 *     ride on the ±23° seasonal tilt, in real time.
 *   · Bounce runs at the TRUE physical rate (bouncePeriodSeconds — ions
 *     seconds-to-a-minute, O⁺ 4× slower, electrons sub-second), never
 *     compressed. Only DRIFT uses the time-compression slider (1× = fully
 *     real); the incoming stream was already real-time.
 *
 *   earth          textured sphere + additive atmosphere shell
 *   fieldLines     dipole cage — r = L·cos²λ at L = 2…6 × 12 meridians
 *   ions H⁺        ~2100 points, WESTWARD drift + REAL field-line bounce
 *                  between mirror points (pitch angles above the loss cone)
 *   ions O⁺        ~1100 points, same drift (gradient–curvature drift period
 *                  is mass-independent at fixed energy) but visibly slower
 *                  bounce (T_b ∝ √m — 4× for O⁺; drawn at 2.5× for
 *                  legibility). Relative BRIGHTNESS of the two ion
 *                  populations tracks the model's storm-time O⁺ energy
 *                  fraction (oxygenFraction), so a deep main phase visibly
 *                  turns the ring ionospheric-green.
 *   electrons      ~1400 points, EASTWARD, same trapped-motion geometry
 *   ringTorus      symmetric glow at the model's peak L (|Dst*|-driven)
 *   partialArc     dusk-centred arc — the partial ring current bulge
 *   plasmapause    thin cyan ring at Carpenter–Anderson Lpp(Kp)
 *   sun + transit  Sun sprite at +X and the incoming solar wind stream:
 *                  every not-yet-arrived L1 parcel (feed state.transit)
 *                  rendered at its REAL time-to-arrival along the corridor,
 *                  colored by Bz (southward hot / northward cool), brightness
 *                  by dynamic pressure. This is the visible bridge between
 *                  the Sun-side and Earth-side digital twins: the forecast
 *                  window as matter in flight, in true real time.
 *
 * Drift in scene θ: ions WESTWARD = MLT decreasing = θ INCREASING under this
 * frame (sceneRate = −driftRateRadPerHour); electrons the reverse. Both
 * still carry westward current.
 *
 * PIPELINE (2026-07-11 rework):
 *   · Population attributes are built OFF-THREAD by js/ring-current-worker.js
 *     (transferred ArrayBuffers; synchronous buildPopulation fallback when
 *     Workers are unavailable).
 *   · Per-frame particle KINEMATICS run on the GPU: trappedPointsMaterial's
 *     vertex shader integrates drift (θ₀ + rate·uDriftHours) and bounce
 *     (λ_m·sin(rate·uBounceSec + φ)) from static attributes, and evaluates
 *     the radial profile, dusk asymmetry, and a nightside injection pulse
 *     per vertex. The attribute buffers upload ONCE; each frame costs the
 *     CPU a handful of uniform writes instead of 4700 position/color writes.
 *     The GLSL is a port of radialProfile/azimuthalWeight/ringPeakL — KEEP
 *     IN SYNC with js/ring-current-model.js (node tests pin the JS side;
 *     the shader mirrors it line for line).
 *   · Earth renders through the SHARED EarthSkin stack (js/earth-skin.js —
 *     same renderer as earth.html / space-weather-globe): Blue Marble, city
 *     lights, ocean specular, topographic bump, Rayleigh–Mie atmosphere,
 *     magnetic-latitude aurora oval (cloud shell deliberately OFF — see
 *     _buildEarth) — all driven by
 *     this page's live state (Kp, Bz, ap, and the model's own Dst feeding
 *     the skin's ring-current heating glow). The accurate spin phase is
 *     visible as the actual night hemisphere, live.
 *
 * Drift runs at real rate × timeCompression (default 600×, so a 100 keV ion
 * at L=3 laps Earth in ~14 s of viewing; set 1× for true real time).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    ringPeakL, dynamicPressure, subsolarPoint, dipoleTiltRad,
} from './ring-current-model.js';
import { buildPopulation, POPULATIONS } from './ring-current-particles.js';
import { EarthSkin } from './earth-skin.js';

const ION_COLOR      = new THREE.Color(1.00, 0.62, 0.22);   // H⁺ (solar wind)
const ION_O_COLOR    = new THREE.Color(0.58, 1.00, 0.34);   // O⁺ (ionospheric outflow)
const ELECTRON_COLOR = new THREE.Color(0.35, 0.75, 1.00);

// Fraction of ion PARTICLES built as O⁺ (POPULATIONS in
// js/ring-current-particles.js). Fixed at build time (species can't flip
// mid-flight without a bounce-phase jump); the on-screen ENERGY mix is
// steered per frame by a brightness uniform, normalised to this ratio.
const O_BUILD_FRACTION =
    POPULATIONS.ionsO.count / (POPULATIONS.ionsH.count + POPULATIONS.ionsO.count);

// Soft-glow point shader: every particle renders as a gaussian orb with a
// hot core instead of a hard square — used by the transit stream and the
// pressure envelope (per-vertex colors). Trapped populations use
// trappedPointsMaterial below, which computes kinematics on the GPU.
function glowPointsMaterial(size, opacity) {
    return new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexColors: true,
        uniforms: { uSize: { value: size } },
        vertexShader: `uniform float uSize; varying vec3 vC;
            void main() {
                vC = color;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = uSize * 320.0 / -mv.z;
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: `varying vec3 vC;
            void main() {
                float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
                float a = exp(-4.5 * r * r) - 0.011;
                if (a <= 0.0) discard;
                gl_FragColor = vec4(vC * (1.0 + 0.7 * (1.0 - r)), a * ${opacity.toFixed(2)});
            }`,
    });
}


/**
 * GPU trapped-particle material: the vertex shader IS the kinematics.
 * Attributes (from js/ring-current-particles.js, built off-thread):
 *   position = (L, θ₀, λ_m)     kin = (driftRate rad/h, bounceRate rad/s, φ)
 * Uniforms advance per frame (uDriftHours × compression, uBounceSec wall
 * clock) and per state tick (uDstStar, uAsymAmp, uMix, uInjection). The
 * brightness weight ports radialProfile · azimuthalWeight · intensity from
 * js/ring-current-model.js — KEEP THE GLSL IN SYNC with the JS — plus a
 * nightside injection pulse: fresh plasma-sheet plasma entering near ~1 MLT,
 * scaled by the live O'Brien–McPherron injection |Q|. That's the ring's
 * actual dynamic: nightside feed-in, westward drift, dusk build-up.
 */
function trappedPointsMaterial(size, opacity, color) {
    return new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: {
            uSize:       { value: size },
            uOpacity:    { value: opacity },
            uColor:      { value: new THREE.Color(color) },
            uDriftHours: { value: 0 },      // model-hours (advances × compression)
            uBounceSec:  { value: 0 },      // wall-clock seconds (never compressed)
            uDstStar:    { value: -10 },
            uAsymAmp:    { value: 0 },
            uAsymMlt:    { value: 19 },
            uMix:        { value: 1 },      // composition brightness steer
            uInjection:  { value: 0 },      // |Q| / 12 nT/h, clamped 0..1
        },
        vertexShader: `
            uniform float uSize, uDriftHours, uBounceSec, uDstStar,
                          uAsymAmp, uAsymMlt, uMix, uInjection;
            attribute vec3 kin;
            varying float vW;
            const float PI = 3.14159265358979;
            void main() {
                // Kinematics: drift + bounce along the dipole field line.
                float L     = position.x;
                float theta = position.y + kin.x * uDriftHours;
                float lam   = position.z * sin(kin.y * uBounceSec + kin.z);
                float cl    = cos(lam);
                float r     = L * cl * cl;
                vec3 p = vec3(r * cl * cos(theta), r * sin(lam), r * cl * sin(theta));

                // radialProfile(L, Dst*) — GLSL port (sync with model JS).
                float d     = min(0.0, uDstStar);
                float peak  = 2.4 + 1.6 * exp(d / 120.0);          // ringPeakL
                float sigma = L < peak ? 0.55 : 1.15;
                float g     = exp(-(L - peak) * (L - peak) / (2.0 * sigma * sigma))
                            / (1.0 + exp(-(L - 1.8) / 0.12))       // inner truncation
                            / (1.0 + exp((L - 6.8) / 0.35));       // outer skirt
                // azimuthalWeight — MLT = (12 − θ·12/π) mod 24 (GSM frame).
                float mlt = mod(12.0 - theta * 12.0 / PI, 24.0);
                float azw = 1.0 + uAsymAmp * cos((mlt - uAsymMlt) / 24.0 * 2.0 * PI);
                // Nightside injection: gaussian sector near ~1 MLT (the
                // storm-time injection boundary), live-scaled by |Q|.
                float dmlt = mod(mlt - 1.0 + 12.0, 24.0) - 12.0;
                float inj  = uInjection * exp(-dmlt * dmlt / 12.5);

                float intensity = (0.25 + 0.75 * min(1.0, abs(uDstStar) / 150.0)) * uMix;
                vW = (0.06 + 0.94 * min(1.3, g * azw * intensity)) * (1.0 + 1.4 * inj * g);

                vec4 mv = modelViewMatrix * vec4(p, 1.0);
                gl_PointSize = uSize * 320.0 / -mv.z;
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: `
            uniform vec3 uColor; uniform float uOpacity;
            varying float vW;
            void main() {
                float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
                float a = exp(-4.5 * r * r) - 0.011;
                if (a <= 0.0) discard;
                gl_FragColor = vec4(uColor * (1.0 + 0.7 * (1.0 - r)) * vW, a * uOpacity);
            }`,
    });
}


/** Thin polar axis line through the origin, length ±halfLen. */
function axisLine(halfLen, color, opacity) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
        new Float32Array([0, -halfLen, 0, 0, halfLen, 0]), 3));
    return new THREE.Line(geo, new THREE.LineBasicMaterial({
        color, transparent: true, opacity, depthWrite: false,
        blending: THREE.AdditiveBlending,
    }));
}

// ── Incoming solar wind stream (the Sun→Earth twin bridge) ──────────────────
// Each parcel = one not-yet-arrived L1 sample from feed state.transit,
// rendered as a small cluster at the corridor position matching its REAL
// time-to-arrival (this deliberately ignores the drift time compression —
// the stream is an honest, real-time forecast display, not an animation).
const TRANSIT = Object.freeze({
    MAX_PARCELS: 120,
    PTS_PER:     14,     // per-slot budget; VISIBLE count scales with density
    X_MP:        11,     // corridor end ≈ subsolar magnetopause (R_E)
    X_SUN:       52,     // corridor start, toward the Sun sprite
    LEAD_MAX:    75,     // minutes mapped across the corridor
    WAVE_Y:      4.2,    // baseline height of the barometric density trace
    WAVE_AMP:    3.2,    // trace amplitude at n = N_REF
    N_REF:       20,     // density (cm⁻³) that saturates count/trace scaling
});

// Stream color modes. 'bz' keeps the driver semantics (southward hot /
// northward cool); 'temp' is a plasma-temperature heat map (log₁₀ T over
// 10⁴–10⁶ K, blue → orange → white); 'density' maps n to teal → white.
function streamColor(mode, p) {
    if (mode === 'temp') {
        const t = Number.isFinite(p.temp) ? p.temp : 8e4;
        const f = Math.max(0, Math.min(1, (Math.log10(Math.max(1e4, t)) - 4) / 2));
        return f < 0.5
            ? [0.15 + 1.7 * f, 0.25 + 0.9 * f, 1.0 - 1.4 * f]     // blue → orange
            : [1.0, 0.70 + 0.6 * (f - 0.5), 0.30 + 1.4 * (f - 0.5)]; // orange → white
    }
    if (mode === 'density') {
        const f = Math.max(0, Math.min(1, (Number.isFinite(p.n) ? p.n : 3) / TRANSIT.N_REF));
        return [0.15 + 0.85 * f, 0.55 + 0.45 * f, 0.65 + 0.35 * f];  // teal → white
    }
    const south = Number.isFinite(p.bz) && p.bz < 0;
    const mag = Number.isFinite(p.bz) ? Math.min(1, Math.abs(p.bz) / 15) : 0.2;
    return south ? [1.0, 0.45 - 0.15 * mag, 0.22] : [0.30, 0.75, 1.0];
}

export class RingCurrentGlobe {
    constructor(container, opts = {}) {
        this._container = container;
        this._timeCompression = opts.timeCompression ?? 600;
        this._state = {       // safe quiet defaults until the first feed state
            dstStar: -10, peakL: ringPeakL(-10),
            asym: { amplitude: 0, mltPeakHours: 19 },
            plasmapauseL: 4.7,
            injection: 0,     // |Q|/12, clamped 0..1 — drives the nightside pulse
        };
        this._disposed = false;
        this._raf = 0;
        this._lastT = 0;
        this._tView = 0;          // wall-clock seconds — TRUE bounce time
        this._driftHours = 0;     // model-hours — drift time × compression
        this._builtPeakL = 0;
        this._parcels = [];       // in-transit L1 samples (state.transit)

        const w = container.clientWidth || 800;
        const h = container.clientHeight || 600;

        this._scene = new THREE.Scene();
        this._camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 300);
        this._camera.position.set(8.5, 6.0, 9.5);

        this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this._renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        this._renderer.setSize(w, h);
        container.appendChild(this._renderer.domElement);

        this._controls = new OrbitControls(this._camera, this._renderer.domElement);
        this._controls.enableDamping = true;
        this._controls.dampingFactor = 0.06;
        this._controls.minDistance = 2.5;
        this._controls.maxDistance = 140;   // far enough to frame the Sun corridor

        // Lighting: Sun from +X — exactly the GSM Sun line, so the lit
        // hemisphere IS the real dayside once Earth's spin phase is set.
        this._scene.add(new THREE.AmbientLight(0x8899bb, 0.55));
        const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
        sun.position.set(1, 0, 0);
        this._scene.add(sun);

        // Everything dipole-anchored lives here and tilts together by the
        // live GSM dipole tilt −ψ (see header). Earth is NOT in this group —
        // its axis tilts by the solar declination instead, so the ~11°
        // dipole-vs-rotation-axis offset is visible, wobbling daily.
        this._magGroup = new THREE.Group();
        this._scene.add(this._magGroup);

        this._buildEarth();
        this._buildFieldLines();
        this._buildParticles();
        this._buildRings();
        this._buildSunAndTransit();

        this._onResize = () => this._resize();
        window.addEventListener('resize', this._onResize);

        this._animate = (t) => {
            if (this._disposed) return;
            const dt = this._lastT ? Math.min(0.1, (t - this._lastT) / 1000) : 0.016;
            this._lastT = t;
            this.tick(dt);
            this._raf = requestAnimationFrame(this._animate);
        };
        this._raf = requestAnimationFrame(this._animate);
    }

    // ── Scene construction ──────────────────────────────────────────────────

    _buildEarth() {
        // Shared Earth renderer (js/earth-skin.js — the same skin earth.html
        // and the space-weather globe use): Blue Marble + city lights + ocean
        // specular glint + topographic bump, Rayleigh–Mie atmosphere rim,
        // procedural cloud shell with relief lighting, magnetic-latitude
        // aurora oval, and a ring-current nightside heating glow (u_dst_norm)
        // that THIS page feeds from its own live O'Brien–McPherron model —
        // the Earth's appearance and the 3D ring around it share one physics
        // state (see setState).
        //
        // Frame: js/geo/coords.js maps lon 0 → +X and EAST → −Z — identical
        // to this scene's GSM mapping (dusk at −Z), so the spin phase stays
        // rotation.y = −λ_subsolar with the Sun fixed on world +X (that is
        // what GSM means). Tilt group carries rotation.z = −declination; the
        // spin group inside rotates about the tilted axis. Both update every
        // frame from the wall clock in _updateGeometry() — the terminator,
        // city-light hemisphere, and season are the actual ones right now.
        this._earthTilt = new THREE.Group();   // rotation.z = −declination
        this._earthSpin = new THREE.Group();   // rotation.y = −subsolar lon
        this._earthTilt.add(this._earthSpin);
        this._scene.add(this._earthTilt);

        // NO cloud shell, deliberately (clouds: false): this is a
        // magnetosphere page — the procedural cloud deck read as noise here
        // and was removed on request. Do not re-enable it.
        this._skin = new EarthSkin(this._earthSpin, new THREE.Vector3(1, 0, 0), {
            radius: 1, segments: 48, clouds: false, atmosphere: true,
        });
        this._skin.loadTextures({
            anisotropy: this._renderer.capabilities.getMaxAnisotropy(),
        });   // resolves even on CDN failure — safe per-slot fallbacks

        // Geographic spin axis — with the dipole axis in _magGroup this makes
        // the daily wobble between the two visibly legible.
        this._earthTilt.add(axisLine(1.38, 0xdfe8ff, 0.5));
    }

    _buildFieldLines() {
        const group = new THREE.Group();
        const mat = new THREE.LineBasicMaterial({
            color: 0x5f79b8, transparent: true, opacity: 0.20,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const SEGS = 48;
        for (const L of [2, 3, 4, 5, 6]) {
            const lamMax = Math.acos(Math.sqrt(1 / L));   // field line reaches r = 1
            for (let m = 0; m < 12; m++) {
                const th = (m / 12) * 2 * Math.PI;
                const pts = [];
                for (let s = 0; s <= SEGS; s++) {
                    const lam = -lamMax + (2 * lamMax * s) / SEGS;
                    const r = L * Math.cos(lam) ** 2;
                    const req = r * Math.cos(lam);
                    pts.push(new THREE.Vector3(req * Math.cos(th), r * Math.sin(lam), req * Math.sin(th)));
                }
                group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
            }
        }
        this._magGroup.add(group);
    }

    /**
     * Populations are BUILT off-thread (js/ring-current-worker.js) and
     * rendered from static GPU attributes — see header. The worker path is
     * fire-and-forget at construction; until buffers arrive the ring simply
     * hasn't populated yet (~a frame or two). Any worker failure falls back
     * to building inline with the same buildPopulation the worker runs.
     */
    _buildParticles() {
        this._popPoints = {};    // key → { points, mat }
        this._pendingMix = 0.06; // quiet-time O⁺ energy mix until first state
        const styles = {
            ionsH:     { color: ION_COLOR,      size: 0.085 },
            ionsO:     { color: ION_O_COLOR,    size: 0.095 },
            electrons: { color: ELECTRON_COLOR, size: 0.060 },
        };
        const addPop = (key, pop) => {
            if (this._disposed) return;
            this._popPoints[key] = this._makePoints(pop, styles[key].color, styles[key].size);
            this._setCompositionMix(this._pendingMix);
        };
        const buildInline = () => {
            for (const [key, spec] of Object.entries(POPULATIONS)) {
                if (!this._popPoints[key]) addPop(key, buildPopulation(spec.count, spec.species));
            }
        };
        try {
            if (typeof Worker === 'undefined') throw new Error('no Worker API');
            const w = new Worker(new URL('./ring-current-worker.js', import.meta.url), { type: 'module' });
            let got = 0;
            const bail = (e) => { console.warn('[ring-current] population worker failed:', e); w.terminate(); buildInline(); };
            const timer = setTimeout(() => bail(new Error('timeout')), 8000);
            w.onerror = (e) => { clearTimeout(timer); bail(e.error ?? e.message ?? e); };
            w.onmessage = (ev) => {
                const m = ev.data;
                if (!m?.ok) { clearTimeout(timer); bail(m?.error); return; }
                addPop(m.id, m);
                if (++got === Object.keys(POPULATIONS).length) { clearTimeout(timer); w.terminate(); }
            };
            for (const [key, spec] of Object.entries(POPULATIONS)) {
                w.postMessage({ id: key, type: 'population', count: spec.count, species: spec.species });
            }
        } catch (e) {
            console.warn('[ring-current] Workers unavailable, building populations inline:', e);
            buildInline();
        }
    }

    /** Brightness-steer the two ion populations to an O⁺ energy fraction
     *  (writes the uMix uniforms; safe before the buffers have arrived). */
    _setCompositionMix(fO) {
        const f = Math.max(0, Math.min(0.8, Number.isFinite(fO) ? fO : 0.06));
        this._pendingMix = f;
        const o = this._popPoints?.ionsO, h = this._popPoints?.ionsH;
        if (o) o.mat.uniforms.uMix.value = Math.min(1.8, f / O_BUILD_FRACTION);
        if (h) h.mat.uniforms.uMix.value = Math.min(1.3, (1 - f) / (1 - O_BUILD_FRACTION));
    }

    /** Static-attribute Points: position=(L, θ₀, λ_m), kin=(drift, bounce, φ).
     *  Uploaded once; all motion happens in the vertex shader. */
    _makePoints(pop, color, size) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pop.seed, 3));
        geo.setAttribute('kin',      new THREE.BufferAttribute(pop.kin, 3));
        const mat = trappedPointsMaterial(size, 0.9, color);
        this._syncStateUniforms(mat);
        const points = new THREE.Points(geo, mat);
        points.frustumCulled = false;   // position attr holds (L,θ₀,λ_m), not xyz
        this._magGroup.add(points);
        return { points, mat };
    }

    /** Push the current model state into one material's uniforms. */
    _syncStateUniforms(mat) {
        const u = mat.uniforms;
        u.uDriftHours.value = this._driftHours;
        u.uBounceSec.value  = this._tView;
        u.uDstStar.value    = this._state.dstStar;
        u.uAsymAmp.value    = this._state.asym.amplitude;
        u.uAsymMlt.value    = this._state.asym.mltPeakHours;
        u.uInjection.value  = this._state.injection;
    }

    _buildRings() {
        // Symmetric baseline glow at the model's peak L.
        this._torusMat = new THREE.MeshBasicMaterial({
            color: 0xff9a3d, transparent: true, opacity: 0.10,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        });
        // Dusk-centred partial-ring bulge (main-phase asymmetry).
        this._arcMat = new THREE.MeshBasicMaterial({
            color: 0xffb066, transparent: true, opacity: 0.0,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        });
        this._torus = null;
        this._arc   = null;
        this._rebuildTorus(this._state.peakL);

        this._ppMat = new THREE.MeshBasicMaterial({
            color: 0x59e0d8, transparent: true, opacity: 0.35, depthWrite: false,
        });
        this._plasmapause = new THREE.Mesh(new THREE.TorusGeometry(4.7, 0.018, 8, 160), this._ppMat);
        this._plasmapause.rotation.x = Math.PI / 2;
        this._magGroup.add(this._plasmapause);

        // Dipole axis — tilts with the magnetosphere; compare against the
        // white geographic axis to watch the real daily wobble between them.
        this._magGroup.add(axisLine(1.75, 0xff9a3d, 0.45));
    }

    _rebuildTorus(peakL) {
        if (this._torus) {
            this._magGroup.remove(this._torus);
            this._torus.geometry.dispose();
        }
        if (this._arc) {
            this._magGroup.remove(this._arc);
            this._arc.geometry.dispose();
        }
        this._torus = new THREE.Mesh(new THREE.TorusGeometry(peakL, 0.55, 14, 96), this._torusMat);
        this._torus.rotation.x = Math.PI / 2;
        this._magGroup.add(this._torus);

        // 120°-wide arc centred on dusk (19 MLT ⇒ scene θ = −7π/12). With
        // Euler 'XYZ' the Z rotation acts first, in the torus' local plane,
        // then rotation.x = π/2 lays it flat with local sweep angle φ mapping
        // to scene θ = φ + rotation.z ⇒ rotation.z = θc − ARC/2. (The old
        // −(7π/12 − ARC/2) landed the arc at 13 MLT — see header.)
        const ARC = (2 * Math.PI) / 3;
        this._arc = new THREE.Mesh(new THREE.TorusGeometry(peakL, 0.72, 14, 64, ARC), this._arcMat);
        this._arc.rotation.x = Math.PI / 2;
        this._arc.rotation.z = -7 * Math.PI / 12 - ARC / 2;
        this._magGroup.add(this._arc);
        this._builtPeakL = peakL;
    }

    _buildSunAndTransit() {
        // Sun glow: canvas radial-gradient sprite at +X (noon MLT direction).
        const cv = document.createElement('canvas');
        cv.width = cv.height = 128;
        const g = cv.getContext('2d');
        const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0.00, 'rgba(255,244,214,1)');
        grad.addColorStop(0.25, 'rgba(255,214,120,0.85)');
        grad.addColorStop(0.60, 'rgba(255,150,60,0.25)');
        grad.addColorStop(1.00, 'rgba(255,120,40,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
        const tex = new THREE.CanvasTexture(cv);
        this._sunMat = new THREE.SpriteMaterial({
            map: tex, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.95,
        });
        this._sun = new THREE.Sprite(this._sunMat);
        this._sun.position.set(TRANSIT.X_SUN + 8, 0, 0);
        this._sun.scale.setScalar(11);
        this._scene.add(this._sun);

        // Transit parcel points (positions/colors filled per frame).
        const N = TRANSIT.MAX_PARCELS * TRANSIT.PTS_PER;
        this._transitGeo = new THREE.BufferGeometry();
        this._transitPos = new Float32Array(N * 3);
        this._transitCol = new Float32Array(N * 3);
        this._transitGeo.setAttribute('position', new THREE.BufferAttribute(this._transitPos, 3).setUsage(THREE.DynamicDrawUsage));
        this._transitGeo.setAttribute('color',    new THREE.BufferAttribute(this._transitCol, 3).setUsage(THREE.DynamicDrawUsage));
        // Fixed per-slot cluster offsets (YZ disc + slight x scatter) so
        // parcels keep a stable shape as they advance.
        this._transitOff = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const a = Math.random() * 2 * Math.PI;
            const r = Math.sqrt(Math.random()) * 1.35;
            this._transitOff[i * 3]     = (Math.random() - 0.5) * 0.9;
            this._transitOff[i * 3 + 1] = Math.sin(a) * r;
            this._transitOff[i * 3 + 2] = Math.cos(a) * r;
        }
        const mat = glowPointsMaterial(0.16, 0.95);
        this._transit = new THREE.Points(this._transitGeo, mat);
        this._transit.frustumCulled = false;
        this._scene.add(this._transit);
        this._streamMode = 'bz';

        // Barometric trace: n(x) as a polyline riding above the corridor —
        // the pressure-wave shape of the incoming wind, sliding Earthward in
        // real time as the plasma it describes actually approaches.
        this._waveN = TRANSIT.MAX_PARCELS;
        this._wavePos = new Float32Array(this._waveN * 3);
        this._waveGeo = new THREE.BufferGeometry();
        this._waveGeo.setAttribute('position', new THREE.BufferAttribute(this._wavePos, 3).setUsage(THREE.DynamicDrawUsage));
        this._wave = new THREE.Line(this._waveGeo, new THREE.LineBasicMaterial({
            color: 0x7fe6c3, transparent: true, opacity: 0.75,
            blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        this._wave.frustumCulled = false;
        this._scene.add(this._wave);

        // 3D pressure envelope: a ring of points around the corridor axis at
        // each sample, radius ∝ density — the barometric wave as a volume.
        this._envSeg = 10;
        const EN = TRANSIT.MAX_PARCELS * this._envSeg;
        this._envPos = new Float32Array(EN * 3);
        this._envCol = new Float32Array(EN * 3);
        this._envGeo = new THREE.BufferGeometry();
        this._envGeo.setAttribute('position', new THREE.BufferAttribute(this._envPos, 3).setUsage(THREE.DynamicDrawUsage));
        this._envGeo.setAttribute('color',    new THREE.BufferAttribute(this._envCol, 3).setUsage(THREE.DynamicDrawUsage));
        this._env = new THREE.Points(this._envGeo, glowPointsMaterial(0.10, 0.55));
        this._env.frustumCulled = false;
        this._scene.add(this._env);
        const base = new Float32Array([TRANSIT.X_MP, TRANSIT.WAVE_Y, 0, TRANSIT.X_SUN, TRANSIT.WAVE_Y, 0]);
        const baseGeo = new THREE.BufferGeometry();
        baseGeo.setAttribute('position', new THREE.BufferAttribute(base, 3));
        this._scene.add(new THREE.Line(baseGeo, new THREE.LineBasicMaterial({
            color: 0x5f79b8, transparent: true, opacity: 0.25, depthWrite: false,
        })));
    }

    /** Stream coloring: 'bz' (driver) | 'temp' (heat map) | 'density'. */
    setStreamMode(mode) {
        this._streamMode = mode === 'temp' || mode === 'density' ? mode : 'bz';
    }

    // In-scene live stat labels: one pinned to the incoming wind corridor,
    // one above the ring current — the numbers travel with the physics they
    // describe, refreshed on every feed state tick.
    _makeLabel(x, y, z, w = 7.5) {
        const cv = document.createElement('canvas');
        cv.width = 512; cv.height = 224;
        const tex = new THREE.CanvasTexture(cv);
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({
            map: tex, transparent: true, depthWrite: false, opacity: 0.95,
        }));
        sp.position.set(x, y, z);
        sp.scale.set(w, w * 224 / 512, 1);
        this._scene.add(sp);
        return { cv, tex, sp };
    }

    _drawLabel(lab, title, lines, accent = '#7fe6c3') {
        const g = lab.cv.getContext('2d');
        g.clearRect(0, 0, 512, 224);
        g.fillStyle = 'rgba(3,1,14,0.55)';
        g.fillRect(0, 0, 512, 224);
        g.strokeStyle = 'rgba(255,255,255,0.18)';
        g.strokeRect(1, 1, 510, 222);
        g.fillStyle = accent;
        g.font = '700 30px system-ui';
        g.fillText(title, 16, 40);
        g.fillStyle = '#e8edf7';
        g.font = '600 27px system-ui';
        lines.forEach((s, i) => g.fillText(s, 16, 82 + i * 36));
        lab.tex.needsUpdate = true;
    }

    /** Corridor rendering: real time-to-arrival → position between Sun and
     *  magnetopause. Runs every frame so parcels creep Earthward in true
     *  real time and vanish exactly when their plasma reaches Earth. */
    _updateTransit() {
        const now = Date.now();
        const pos = this._transitPos, col = this._transitCol, off = this._transitOff;
        let slot = 0, wi = 0;
        for (const p of this._parcels) {
            if (slot >= TRANSIT.MAX_PARCELS) break;
            const mins = (p.tArrive - now) / 60_000;
            if (mins <= 0 || mins > TRANSIT.LEAD_MAX) continue;
            const x = TRANSIT.X_MP + (mins / TRANSIT.LEAD_MAX) * (TRANSIT.X_SUN - TRANSIT.X_MP);
            const nNorm = Math.max(0, Math.min(1, (Number.isFinite(p.n) ? p.n : 3) / TRANSIT.N_REF));
            const [R, G, B] = streamColor(this._streamMode, p);
            const pdyn = dynamicPressure(p.n, p.v);
            const bright = 0.30 + 0.70 * Math.min(1, (pdyn ?? 1.5) / 8);
            // BAROMETRIC compression: visible particle count per 1-min sample
            // scales with density — compression fronts read as dense bright
            // bands, exactly like a longitudinal pressure wave.
            const visible = 3 + Math.round((TRANSIT.PTS_PER - 3) * nNorm);
            for (let k = 0; k < TRANSIT.PTS_PER; k++) {
                const j = (slot * TRANSIT.PTS_PER + k) * 3;
                if (k < visible) {
                    pos[j]     = x + off[j];
                    pos[j + 1] = off[j + 1];
                    pos[j + 2] = off[j + 2];
                    col[j]     = R * bright;
                    col[j + 1] = G * bright;
                    col[j + 2] = B * bright;
                } else {
                    pos[j] = pos[j + 1] = pos[j + 2] = 0;
                    col[j] = col[j + 1] = col[j + 2] = 0;
                }
            }
            // Wave trace vertex: pressure curve above the corridor.
            const w = wi * 3;
            this._wavePos[w]     = x;
            this._wavePos[w + 1] = TRANSIT.WAVE_Y + TRANSIT.WAVE_AMP * nNorm;
            this._wavePos[w + 2] = 0;
            // 3D envelope ring at this sample — the wave revolved around the
            // corridor axis (radius ∝ density), slowly rotating for depth.
            const rad = 1.0 + 2.6 * nNorm;
            const spin = now / 9000;
            for (let k = 0; k < this._envSeg; k++) {
                const a = spin + (k / this._envSeg) * 2 * Math.PI;
                const e = (wi * this._envSeg + k) * 3;
                this._envPos[e]     = x;
                this._envPos[e + 1] = Math.sin(a) * rad;
                this._envPos[e + 2] = Math.cos(a) * rad;
                this._envCol[e]     = R * 0.5;
                this._envCol[e + 1] = G * 0.5;
                this._envCol[e + 2] = B * 0.5;
            }
            wi++;
            slot++;
        }
        // Park unused envelope rings.
        for (let s = wi * this._envSeg; s < TRANSIT.MAX_PARCELS * this._envSeg; s++) {
            this._envPos[s * 3] = this._envPos[s * 3 + 1] = this._envPos[s * 3 + 2] = 0;
            this._envCol[s * 3] = this._envCol[s * 3 + 1] = this._envCol[s * 3 + 2] = 0;
        }
        this._envGeo.attributes.position.needsUpdate = true;
        this._envGeo.attributes.color.needsUpdate = true;
        // Park unused point slots (black under additive = invisible).
        for (let s = slot * TRANSIT.PTS_PER; s < TRANSIT.MAX_PARCELS * TRANSIT.PTS_PER; s++) {
            pos[s * 3] = pos[s * 3 + 1] = pos[s * 3 + 2] = 0;
            col[s * 3] = col[s * 3 + 1] = col[s * 3 + 2] = 0;
        }
        // Collapse unused trace vertices onto the last real one.
        if (wi === 0) { this._wavePos[0] = TRANSIT.X_MP; this._wavePos[1] = TRANSIT.WAVE_Y; this._wavePos[2] = 0; wi = 1; }
        for (let s = wi; s < this._waveN; s++) {
            const w = s * 3, l = (wi - 1) * 3;
            this._wavePos[w] = this._wavePos[l];
            this._wavePos[w + 1] = this._wavePos[l + 1];
            this._wavePos[w + 2] = this._wavePos[l + 2];
        }
        this._waveGeo.attributes.position.needsUpdate = true;
        this._transitGeo.attributes.position.needsUpdate = true;
        this._transitGeo.attributes.color.needsUpdate = true;
    }

    // ── State & animation ───────────────────────────────────────────────────

    /** Feed the latest model state (detail of ring-current-feed 'state'). */
    setState(state) {
        this._parcels = state?.transit?.parcels?.slice(0, TRANSIT.MAX_PARCELS) ?? [];
        // Live in-scene stats (created lazily so a WebGL-only failure can't
        // block construction).
        if (!this._windLab) {
            this._windLab = this._makeLabel((TRANSIT.X_MP + TRANSIT.X_SUN) / 2, TRANSIT.WAVE_Y + 6.2, 0, 9);
            this._ringLab = this._makeLabel(0, 7.8, 0, 9);
        }
        const d = state?.drivers, nw = state?.now;
        const f1 = (x, u, dg = 1) => Number.isFinite(x) ? `${x.toFixed(dg)}${u}` : '—';
        if (d) this._drawLabel(this._windLab, 'INCOMING WIND — LIVE (L1)', [
            `v ${f1(d.v, ' km/s', 0)}   n ${f1(d.n, ' /cm³')}`,
            `Bz ${f1(d.bz, ' nT')}   Pdyn ${f1(d.pdyn, ' nPa', 2)}`,
            `VBs ${f1(d.vbs, ' mV/m', 2)}`,
            `${state?.transit?.parcels?.length ?? 0} parcels in transit`,
        ], '#ffd9b0');
        if (nw) this._drawLabel(this._ringLab, 'RING CURRENT — LIVE', [
            `Dst ${f1(nw.dstModel, ' nT')} (obs ${f1(nw.dstObserved, '', 0)})`,
            `W ${Number.isFinite(nw.energyJ) ? (nw.energyJ / 1e15).toFixed(2) + '×10¹⁵ J' : '—'}`,
            `peak L ${f1(nw.peakL, ' Rᴇ', 2)}   τ ${f1(nw.tauHours, ' h')}`,
            `${nw.storm?.label ?? ''}${Number.isFinite(nw.oxygenFraction)
                ? ` · O⁺ ${Math.round(nw.oxygenFraction * 100)}%` : ''}`,
        ]);
        // Sun glow tracks the strongest incoming driver — a storm you can
        // see coming before it arrives.
        const sv = state?.transit?.strongest?.vbs ?? 0;
        if (this._sunMat) this._sunMat.opacity = 0.75 + 0.25 * Math.min(1, sv / 6);
        const now = state?.now;
        if (!now) return;
        this._state = {
            dstStar:      Number.isFinite(now.dstStarModel) ? now.dstStarModel : -10,
            peakL:        Number.isFinite(now.peakL) ? now.peakL : ringPeakL(-10),
            asym:         now.asymmetry || { amplitude: 0, mltPeakHours: 19 },
            plasmapauseL: Number.isFinite(now.plasmapauseL) ? now.plasmapauseL : 4.7,
            // Live injection strength: |Q| ≈ 12 nT/h is already a strong
            // storm main phase — saturate the nightside pulse there.
            injection:    Math.min(1, Math.abs(now.injectionQ ?? 0) / 12),
        };
        this._setCompositionMix(now.oxygenFraction);
        for (const p of Object.values(this._popPoints ?? {})) this._syncStateUniforms(p.mat);
        // Drive the EarthSkin from the SAME live state as the ring: aurora
        // oval from Kp + southward Bz + ap-proxied hemispheric power, and the
        // skin's ring-current nightside heating glow from this page's own
        // model Dst. Normalisations match earth.html / space-weather-globe
        // (−Bz/30, −Dst/200, (ap−12)/110).
        const bz = state?.drivers?.bz;
        this._skin.setSpaceWeather({
            kp:       Number.isFinite(now.kp) ? now.kp : 0,
            bzSouth:  Number.isFinite(bz) ? Math.max(0, Math.min(1, -bz / 30)) : 0,
            auroraOn: true,
            auroraAW: Number.isFinite(now.apNow) ? Math.max(0, Math.min(1, (now.apNow - 12) / 110)) : 0,
            dstNorm:  Number.isFinite(now.dstModel) ? Math.max(0, Math.min(1, -now.dstModel / 200)) : 0,
        });
        if (Math.abs(this._state.peakL - this._builtPeakL) > 0.12) {
            this._rebuildTorus(this._state.peakL);
        }
        const intensity = Math.min(1, Math.abs(this._state.dstStar) / 150);
        this._torusMat.opacity = 0.06 + 0.22 * intensity;
        this._arcMat.opacity   = 0.30 * intensity * this._state.asym.amplitude;
        const pp = this._state.plasmapauseL;
        this._plasmapause.scale.setScalar(pp / 4.7);
    }

    setTimeCompression(x) {
        this._timeCompression = Math.max(1, x);
    }

    tick(dt) {
        const dtH = (dt * this._timeCompression) / 3600;   // viewing → model hours
        this._tView += dt;
        this._driftHours += dtH;
        this._updateGeometry();
        this._skin.update(this._tView);   // aurora animation clock
        // All particle motion is in the vertex shader — the per-frame CPU
        // cost of 4 700 particles is these two uniform writes per material.
        for (const p of Object.values(this._popPoints ?? {})) {
            p.mat.uniforms.uDriftHours.value = this._driftHours;
            p.mat.uniforms.uBounceSec.value  = this._tView;
        }
        this._updateTransit();
        this._controls.update();
        this._renderer.render(this._scene, this._camera);
    }

    /** Wall-clock-accurate Earth spin/tilt + magnetosphere dipole tilt.
     *  Always real time — deliberately NOT scaled by the drift compression,
     *  same policy as the transit stream. ~40 flops; fine every frame. */
    _updateGeometry() {
        const nowMs = Date.now();
        const sp = subsolarPoint(nowMs);
        this._earthTilt.rotation.z = -sp.latDeg * Math.PI / 180;   // axis by declination
        this._earthSpin.rotation.y = -sp.lonDeg * Math.PI / 180;   // subsolar lon → +X
        this._magGroup.rotation.z  = -dipoleTiltRad(nowMs);        // GSM dipole tilt ψ
    }

    _resize() {
        const w = this._container.clientWidth, h = this._container.clientHeight;
        if (!w || !h) return;
        this._camera.aspect = w / h;
        this._camera.updateProjectionMatrix();
        this._renderer.setSize(w, h);
    }

    dispose() {
        this._disposed = true;
        cancelAnimationFrame(this._raf);
        window.removeEventListener('resize', this._onResize);
        this._scene.traverse(o => {
            o.geometry?.dispose?.();
            if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
        });
        this._renderer.dispose();
        this._renderer.domElement.remove();
    }
}
