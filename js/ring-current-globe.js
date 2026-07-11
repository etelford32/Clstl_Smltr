/**
 * ring-current-globe.js — Three.js digital twin scene for ring-current.html
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONE CLOCK. Every population moves at its TRUE physical velocity through
 * its region's spatial scale, driven by the single SimClock τ
 * (js/sim-clock.js). Apparent speed = physical km/s × τ ÷ local km/unit.
 * Nothing is animated at a "looks nice" speed — liveliness comes from
 * rendering cues (trails, heartbeat pulses, arrival flashes), never from
 * faking a velocity. See RING_CURRENT_VISUAL_PLAN.md.
 *
 * Scene (Earth at origin, 1 unit = 1 R_E, equatorial plane = XZ, north = +Y,
 * Sun toward +X):
 *
 *   earth          textured sphere + additive atmosphere shell
 *   fieldLines     dipole cage — r = L·cos²λ at L = 2…6 × 12 meridians
 *   ions           ~3200 points, WESTWARD drift + REAL field-line bounce
 *                  between mirror points (pitch angles above the loss cone);
 *                  visible count + brightness track |Dst*| (quiet = thin dim
 *                  torus, storm = dense hot asymmetric)
 *   electrons      ~1400 points, EASTWARD, same trapped-motion geometry
 *   ringTorus      symmetric glow at the model's peak L (|Dst*|-driven)
 *   partialArc     dusk-centred arc — the partial ring current bulge
 *   plasmapause    thin cyan ring at Carpenter–Anderson Lpp(Kp)
 *   sun + transit  Sun sprite at +X and the incoming solar wind stream:
 *                  every not-yet-arrived L1 parcel (feed state.transit)
 *                  advected by ITS OWN measured speed — position is the
 *                  fraction of its L1→Earth transit elapsed at simTime,
 *                  evaluated per frame (fast parcels visibly overtake slow
 *                  ones — real stream interaction). Colored by Bz
 *                  (southward hot / northward cool), trail length ∝ speed.
 *                  At τ=1 this is the honest real-time forecast window;
 *                  at τ>1 the SAME data sweeps as fast-forward and wraps.
 *   flashes        magnetopause interaction flash when a parcel arrives,
 *                  intensity ∝ its VBs — the visual handoff from
 *                  "in transit" to "coupled"
 *   injections     nightside tail bursts triggered by arriving southward
 *                  parcels: fast earthward entry (~100–350 km/s), visible
 *                  deceleration, settling into slow westward drift — WHY
 *                  storms pump the ring. Penetrate deeper when Lpp shrinks.
 *
 * Azimuth convention: position = (r·cosθ, y, r·sinθ);
 * MLT = (12 + θ·12/π) mod 24 — noon (12 MLT) at +X, the dusk bulge at
 * 19 MLT ⇒ θ = 7π/12. Ions step θ negative (westward, decreasing MLT),
 * electrons positive; both carry westward current.
 *
 * Physics weights come from js/ring-current-model.js — this file only draws.
 * Bounce motion is decorative texture (viewing-rate, like
 * js/van-allen-particles.js — real bounce is seconds-scale, sub-perceptual
 * at drift compression); DRIFT and TRANSIT both run on the SimClock.
 * At τ=300: a 500 km/s parcel crosses the corridor in ~10 s of viewing
 * while a 100 keV ion at L=4 laps Earth in ~30 s — the stream races, the
 * ring is stately. That contrast is the lesson.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    radialProfile, azimuthalWeight, driftRateRadPerHour, driftPeriodHours,
    ringPeakL, dipoleFieldLinePoint, mirrorLatitude, lossConeAngle,
    dynamicPressure, couplingVBs,
} from './ring-current-model.js';
import { SimClock, SCALE, apparentUnitsPerSec } from './sim-clock.js';

// Keep in sync with js/earth-skin.js EARTH_TEXTURES (version-pinned CDN).
const EARTH_DAY_TEXTURE = 'https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg';

const ION_COLOR      = new THREE.Color(1.00, 0.62, 0.22);
const ELECTRON_COLOR = new THREE.Color(0.35, 0.75, 1.00);

// Soft-glow point shader: every particle renders as a gaussian orb with a
// hot core instead of a hard square — one material for populations, transit
// stream, and pressure envelope.
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

// Fresnel rim-glow atmosphere — the limb brightens like scattered light.
function atmosphereMaterial() {
    return new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        vertexShader: `varying vec3 vN; varying vec3 vP;
            void main() {
                vN = normalize(normalMatrix * normal);
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vP = mv.xyz;
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: `varying vec3 vN; varying vec3 vP;
            void main() {
                float f = pow(1.0 - abs(dot(normalize(vN), normalize(-vP))), 2.5);
                gl_FragColor = vec4(vec3(0.25, 0.52, 1.0) * f * 1.7, f * 0.9);
            }`,
    });
}


/**
 * Trapped population with REAL dipole bounce geometry: each particle gets an
 * equatorial pitch angle sampled ABOVE the loss cone (below it precipitates —
 * those never appear), the corresponding mirror latitude from μ-conservation,
 * and oscillates along its field line r = L·cos²λ between ±λ_m. Bounce runs
 * at a viewing-friendly rate (real bounce is ~seconds — far below frame
 * perception at drift compression; same pedagogical decoupling as
 * js/van-allen-particles.js), deeper mirrors bouncing slower (T_b grows as
 * α_eq shrinks). Drift stays physical: rate × timeCompression.
 */
function makePopulation(count, species) {
    const L       = new Float32Array(count);
    const theta   = new Float32Array(count);
    const eKev    = new Float32Array(count);
    const mirrorL = new Float32Array(count);  // mirror latitude (rad)
    const bRate   = new Float32Array(count);  // bounce viewing rate (rad/s)
    const bPhase  = new Float32Array(count);
    const rate    = new Float32Array(count);  // drift rad/h, signed
    for (let i = 0; i < count; i++) {
        L[i]     = 1.9 + Math.random() * 4.6;
        theta[i] = Math.random() * 2 * Math.PI;
        eKev[i]  = 20 * Math.pow(250 / 20, Math.random());      // log-uniform 20–250 keV
        // Pitch angle above the loss cone, biased toward 90° (trapped
        // distributions peak at equatorial mirroring).
        const lc = lossConeAngle(L[i]);
        const alpha = lc + (Math.PI / 2 - lc) * Math.pow(Math.random(), 0.45);
        mirrorL[i] = mirrorLatitude(alpha);
        bRate[i]   = (1.1 + Math.random() * 1.2) / (1 + 1.8 * mirrorL[i]);
        bPhase[i]  = Math.random() * 2 * Math.PI;
        rate[i]    = driftRateRadPerHour(eKev[i], L[i], species);
    }
    return { count, species, L, theta, eKev, mirrorL, bRate, bPhase, rate };
}

// ── Incoming solar wind stream (the Sun→Earth twin bridge) ──────────────────
// Each parcel = one not-yet-arrived L1 sample from feed state.transit.
// Position = fraction of its OWN L1→Earth transit elapsed at simTime
// (per-parcel measured speed ⇒ fast parcels overtake slow ones), evaluated
// every frame from the SimClock — never only at data-fetch time. Corridor
// geometry lives in the SCALE registry (js/sim-clock.js) so the leg's
// spatial compression is explicit, not smuggled in as an animation speed.
const TRANSIT = Object.freeze({
    MAX_PARCELS: 120,
    PTS_PER:     14,     // per-slot budget; VISIBLE count scales with density
    X_MP:        SCALE.CORRIDOR.X_MP,    // ≈ subsolar magnetopause (R_E)
    X_SUN:       SCALE.CORRIDOR.X_SUN,   // corridor start, toward the Sun
    WAVE_Y:      4.2,    // baseline height of the barometric density trace
    WAVE_AMP:    3.2,    // trace amplitude at n = N_REF
    N_REF:       20,     // density (cm⁻³) that saturates count/trace scaling
});

// Nightside injection bursts (Phase 4): triggered when an arriving parcel
// carries VBs above the O'Brien–McPherron coupling cutoff. Entry speed and
// deceleration are physical (exponential approach, initial ~(r0−L)/T_IN R_E
// per sim-second ≈ 100–350 km/s); the FADE is a rendering cue in wall time.
const INJECT = Object.freeze({
    CAP:        900,     // particle pool
    T_IN_S:     90,      // inflow time constant (sim seconds)
    LIFE_S:     26,      // wall-clock fade after settling into drift
    VBS_MIN:    0.5,     // ≈ OBM Ec — northward/weak parcels don't inject
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
        // THE clock. Page passes a shared SimClock so UI and scene agree;
        // standalone use gets its own. `timeCompression` opt kept as the
        // legacy spelling of the initial τ.
        this._clock = opts.clock ?? new SimClock({ tau: opts.timeCompression ?? 300 });
        this._seenWraps = this._clock.wraps;
        this._lastSimNow = this._clock.now();
        this._state = {       // safe quiet defaults until the first feed state
            dstStar: -10, peakL: ringPeakL(-10),
            asym: { amplitude: 0, mltPeakHours: 19 },
            plasmapauseL: 4.7,
        };
        this._disposed = false;
        this._raf = 0;
        this._lastT = 0;
        this._tView = 0;          // viewing-time clock for the bounce motion
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

        // Lighting: Sun from +X.
        this._scene.add(new THREE.AmbientLight(0x8899bb, 0.55));
        const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
        sun.position.set(1, 0.12, 0);
        this._scene.add(sun);

        this._buildEarth();
        this._buildFieldLines();
        this._buildParticles();
        this._buildRings();
        this._buildSunAndTransit();
        this._buildFlashes();
        this._buildInjections();
        this._initTooltip();

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
        const mat = new THREE.MeshPhongMaterial({ color: 0x2a4d8f, shininess: 18 });
        new THREE.TextureLoader().load(EARTH_DAY_TEXTURE, (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            mat.map = tex;
            mat.color.set(0xffffff);
            mat.needsUpdate = true;
        }, undefined, () => { /* CDN unreachable → keep the plain blue globe */ });
        this._earth = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 48), mat);
        this._scene.add(this._earth);

        const atmo = new THREE.Mesh(
            new THREE.SphereGeometry(1.045, 48, 48),
            atmosphereMaterial(),
        );
        this._scene.add(atmo);
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
        this._scene.add(group);
    }

    _buildParticles() {
        this._ions      = this._makePoints(makePopulation(3200, 'ion'),      ION_COLOR,      0.085);
        this._electrons = this._makePoints(makePopulation(1400, 'electron'), ELECTRON_COLOR, 0.060);
    }

    _makePoints(pop, baseColor, size) {
        const geo = new THREE.BufferGeometry();
        const pos = new Float32Array(pop.count * 3);
        const col = new Float32Array(pop.count * 3);
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('color',    new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
        const mat = glowPointsMaterial(size, 0.9);
        const points = new THREE.Points(geo, mat);
        points.frustumCulled = false;
        this._scene.add(points);
        return { pop, geo, pos, col, baseColor, points };
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
        this._scene.add(this._plasmapause);
    }

    _rebuildTorus(peakL) {
        if (this._torus) {
            this._scene.remove(this._torus);
            this._torus.geometry.dispose();
        }
        if (this._arc) {
            this._scene.remove(this._arc);
            this._arc.geometry.dispose();
        }
        this._torus = new THREE.Mesh(new THREE.TorusGeometry(peakL, 0.55, 14, 96), this._torusMat);
        this._torus.rotation.x = Math.PI / 2;
        this._scene.add(this._torus);

        // 120°-wide arc; TorusGeometry arcs start at its local +X and sweep CCW,
        // so rotate the mesh to centre the arc on 19 MLT (θ = 7π/12).
        const ARC = (2 * Math.PI) / 3;
        this._arc = new THREE.Mesh(new THREE.TorusGeometry(peakL, 0.72, 14, 64, ARC), this._arcMat);
        this._arc.rotation.x = Math.PI / 2;
        this._arc.rotation.z = -(7 * Math.PI / 12 - ARC / 2);
        this._scene.add(this._arc);
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

    /** Corridor rendering, all on the SimClock: each parcel sits at the
     *  fraction of its OWN L1→Earth transit elapsed at simTime, so its
     *  apparent speed = measured km/s × τ ÷ SCALE.CORRIDOR.kmPerUnit —
     *  faster parcels visibly overtake slower ones (real stream
     *  interaction). Evaluated every frame; at τ=1 this is true real time
     *  and parcels vanish exactly when their plasma reaches Earth. */
    _updateTransit(simNow, wallNow) {
        const tau = this._clock.tau;
        const spanX = TRANSIT.X_SUN - TRANSIT.X_MP;
        const pos = this._transitPos, col = this._transitCol, off = this._transitOff;
        // Heartbeat: parcels pulse on their 1-min sample cadence (wall time —
        // it's live instrumentation, not physics). Prominent in Real mode.
        const hbAmp = tau === 1 ? 0.22 : 0.07;
        let slot = 0;
        const waveSamples = [];   // {x, nNorm, R, G, B} — sorted by x below
        this._slotParcel = this._slotParcel || [];
        this._slotParcel.length = 0;
        for (const p of this._parcels) {
            if (slot >= TRANSIT.MAX_PARCELS) break;
            const dur = p.tArrive - p.tL1;              // real transit ms at measured v
            if (!(dur > 0) || dur > 3 * 3.6e6) continue;
            const remain = p.tArrive - simNow;
            if (remain <= 0) continue;                   // arrived (in sim) — handled by flashes
            const f = Math.min(1, remain / dur);         // 1 = just left L1, 0 = arriving
            const x = TRANSIT.X_MP + f * spanX;
            const nNorm = Math.max(0, Math.min(1, (Number.isFinite(p.n) ? p.n : 3) / TRANSIT.N_REF));
            const [R, G, B] = streamColor(this._streamMode, p);
            const pdyn = dynamicPressure(p.n, p.v);
            let bright = 0.30 + 0.70 * Math.min(1, (pdyn ?? 1.5) / 8);
            bright *= 1 + hbAmp * Math.cos(2 * Math.PI * ((wallNow - (p.tL1 ?? 0)) % 60_000) / 60_000);
            if (tau === 1) {
                // Flow-field pulse (Real mode only): a brightness wave sliding
                // Earthward at an INDICATOR speed — positions stay true, the
                // pulse only conveys direction while honest motion is sub-pixel.
                bright *= 1 + 0.30 * Math.sin(2 * Math.PI * (x / 9 + wallNow / 3000));
            }
            // Trail length ∝ apparent speed (invariant: km/s × τ ÷ km/unit) —
            // fast parcels streak, slow ones stay compact; ~0 at τ=1.
            const trail = Math.min(7, Math.max(0.15,
                0.45 * apparentUnitsPerSec(Number.isFinite(p.v) ? p.v : 400, SCALE.CORRIDOR.kmPerUnit, tau)));
            // BAROMETRIC compression: visible particle count per 1-min sample
            // scales with density — compression fronts read as dense bright
            // bands, exactly like a longitudinal pressure wave.
            const visible = 3 + Math.round((TRANSIT.PTS_PER - 3) * nNorm);
            for (let k = 0; k < TRANSIT.PTS_PER; k++) {
                const j = (slot * TRANSIT.PTS_PER + k) * 3;
                if (k < visible) {
                    // Motion is toward −x, so the trail extends sunward (+x),
                    // fading toward its tip.
                    const tFrac = visible > 1 ? k / (visible - 1) : 0;
                    const fade = 1 - 0.62 * tFrac;
                    pos[j]     = x + off[j] * 0.5 + tFrac * trail;
                    pos[j + 1] = off[j + 1];
                    pos[j + 2] = off[j + 2];
                    col[j]     = R * bright * fade;
                    col[j + 1] = G * bright * fade;
                    col[j + 2] = B * bright * fade;
                } else {
                    pos[j] = pos[j + 1] = pos[j + 2] = 0;
                    col[j] = col[j + 1] = col[j + 2] = 0;
                }
            }
            this._slotParcel[slot] = p;   // hover tooltip lookup
            waveSamples.push({ x, nNorm, R, G, B });
            slot++;
        }
        // Barometric trace + envelope, x-sorted (overtaking can reorder
        // parcels relative to arrival order — the trace is n(x), not n(t)).
        waveSamples.sort((a, b) => a.x - b.x);
        let wi = 0;
        for (const s of waveSamples) {
            const w = wi * 3;
            this._wavePos[w]     = s.x;
            this._wavePos[w + 1] = TRANSIT.WAVE_Y + TRANSIT.WAVE_AMP * s.nNorm;
            this._wavePos[w + 2] = 0;
            // 3D envelope ring at this sample — the wave revolved around the
            // corridor axis (radius ∝ density), slowly rotating for depth.
            const rad = 1.0 + 2.6 * s.nNorm;
            const spin = wallNow / 9000;
            for (let k = 0; k < this._envSeg; k++) {
                const a = spin + (k / this._envSeg) * 2 * Math.PI;
                const e = (wi * this._envSeg + k) * 3;
                this._envPos[e]     = s.x;
                this._envPos[e + 1] = Math.sin(a) * rad;
                this._envPos[e + 2] = Math.cos(a) * rad;
                this._envCol[e]     = s.R * 0.5;
                this._envCol[e + 1] = s.G * 0.5;
                this._envCol[e + 2] = s.B * 0.5;
            }
            wi++;
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

    // ── Arrival flashes + injection triggers ────────────────────────────────

    /** Fire the parcels whose tArrive fell inside (lastSimNow, simNow] this
     *  frame: a magnetopause flash scaled by the parcel's VBs, and — for
     *  southward parcels above the coupling cutoff — a nightside injection
     *  burst. Interval crossing (not a seen-set) so each parcel fires once
     *  per sweep and replays honestly after a wrap. */
    _detectArrivals(simNow) {
        let flashes = 0;
        for (const p of this._parcels) {
            if (!(p.tArrive > this._lastSimNow && p.tArrive <= simNow)) continue;
            const vbs = couplingVBs(p.v, p.bz) ?? 0;
            if (flashes < 3) {
                this._spawnFlash(vbs, p.bz);
                flashes++;
            }
            if (vbs >= INJECT.VBS_MIN) {
                this._spawnInjection(vbs, this._state.plasmapauseL);
            }
        }
    }

    _buildFlashes() {
        // Shared soft radial texture; per-flash tint via material color.
        const cv = document.createElement('canvas');
        cv.width = cv.height = 64;
        const g = cv.getContext('2d');
        const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0.0, 'rgba(255,255,255,1)');
        grad.addColorStop(0.4, 'rgba(255,255,255,0.5)');
        grad.addColorStop(1.0, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 64, 64);
        const tex = new THREE.CanvasTexture(cv);
        this._flashes = [];
        for (let i = 0; i < 8; i++) {
            const mat = new THREE.SpriteMaterial({
                map: tex, blending: THREE.AdditiveBlending, depthWrite: false,
                transparent: true, opacity: 0,
            });
            const sp = new THREE.Sprite(mat);
            sp.visible = false;
            this._scene.add(sp);
            this._flashes.push({ sp, mat, age: 0, life: 0.9, base: 1 });
        }
    }

    /** Interaction flash at the magnetopause — the visible handoff from
     *  "in transit" to "coupled". Intensity ∝ VBs; southward reads hot. */
    _spawnFlash(vbs, bz) {
        const f = this._flashes?.find(f => !f.sp.visible) ?? null;
        if (!f) return;
        const south = Number.isFinite(bz) && bz < 0;
        f.mat.color.setRGB(...(south ? [1.0, 0.55, 0.3] : [0.45, 0.7, 1.0]));
        f.sp.position.set(
            TRANSIT.X_MP + 0.3,
            (Math.random() - 0.5) * 2.2,
            (Math.random() - 0.5) * 2.2,
        );
        f.base = 1.4 + 2.4 * Math.min(1, vbs / 6);
        f.age = 0;
        f.o0 = south ? 0.85 : 0.4;
        f.sp.scale.setScalar(f.base);
        f.mat.opacity = f.o0;
        f.sp.visible = true;
    }

    _updateFlashes(dt) {
        for (const f of this._flashes) {
            if (!f.sp.visible) continue;
            f.age += dt;
            const k = f.age / f.life;
            if (k >= 1) { f.sp.visible = false; f.mat.opacity = 0; continue; }
            f.sp.scale.setScalar(f.base * (1 + 1.8 * k));
            f.mat.opacity = f.o0 * (1 - k) ** 1.4;
        }
    }

    // ── Injection dynamics (Phase 4 — why storms pump the ring) ─────────────

    _buildInjections() {
        const N = INJECT.CAP;
        this._injGeo = new THREE.BufferGeometry();
        this._injPos = new Float32Array(N * 3);
        this._injCol = new Float32Array(N * 3);
        this._injGeo.setAttribute('position', new THREE.BufferAttribute(this._injPos, 3).setUsage(THREE.DynamicDrawUsage));
        this._injGeo.setAttribute('color',    new THREE.BufferAttribute(this._injCol, 3).setUsage(THREE.DynamicDrawUsage));
        this._injPts = new THREE.Points(this._injGeo, glowPointsMaterial(0.11, 0.95));
        this._injPts.frustumCulled = false;
        this._scene.add(this._injPts);
        this._inj = {
            mode:    new Uint8Array(N),      // 0 free · 1 inflow · 2 drift
            theta:   new Float32Array(N),
            r:       new Float32Array(N),
            targetL: new Float32Array(N),
            rate:    new Float32Array(N),    // drift rad/h (westward, signed)
            age:     new Float32Array(N),    // wall-s since spawn (fade cue)
            yAmp:    new Float32Array(N),
            bPh:     new Float32Array(N),
        };
        this._injCursor = 0;
    }

    /** Burst of hot ions entering from the nightside tail. Count scales with
     *  the arriving parcel's VBs and inversely with τ (at high compression
     *  parcels arrive many per second — the stream of bursts is continuous,
     *  which is exactly the storm-time picture). Injections penetrate deeper
     *  when the plasmapause contracts. */
    _spawnInjection(vbs, lpp) {
        const inj = this._inj;
        const tauScale = Math.min(1, 60 / this._clock.tau);
        const count = Math.max(4, Math.round((6 + 11 * Math.min(6, vbs)) * tauScale));
        for (let c = 0; c < count; c++) {
            // Ring cursor; skip slots still alive (pool full ⇒ drop, not grow).
            let i = -1;
            for (let probe = 0; probe < INJECT.CAP; probe++) {
                const j = (this._injCursor + probe) % INJECT.CAP;
                if (inj.mode[j] === 0) { i = j; this._injCursor = j + 1; break; }
            }
            if (i < 0) return;
            inj.mode[i]    = 1;
            inj.theta[i]   = Math.PI + (Math.random() - 0.5) * 1.4;   // ~21–03 MLT
            inj.r[i]       = 7.8 + Math.random() * 1.6;
            inj.targetL[i] = Math.max(2.2, lpp - 0.4 - Math.random() * 1.6);
            const eKev     = 30 + 220 * Math.random() ** 2;
            inj.rate[i]    = driftRateRadPerHour(eKev, inj.targetL[i], 'ion');
            inj.age[i]     = 0;
            inj.yAmp[i]    = (Math.random() - 0.5) * 0.7;
            inj.bPh[i]     = Math.random() * 2 * Math.PI;
        }
    }

    /** Inflow: exponential approach to the target L on the SIM clock —
     *  initial speed ≈ (r₀−L)/T_IN R_E per sim-second (~100–350 km/s), with
     *  the deceleration that makes the fast-arrival → slow-drift transition
     *  legible. Drift: the particle's own energy-dependent westward rate.
     *  Fade is wall-clock (a rendering cue, not physics). */
    _updateInjections(dt, dSimH) {
        const inj = this._inj;
        const pos = this._injPos, col = this._injCol;
        const dSimS = dSimH * 3600;
        const ease = 1 - Math.exp(-dSimS / INJECT.T_IN_S);
        for (let i = 0; i < INJECT.CAP; i++) {
            const j = i * 3;
            if (inj.mode[i] === 0) {
                col[j] = col[j + 1] = col[j + 2] = 0;
                continue;
            }
            inj.age[i] += dt;
            if (inj.age[i] > INJECT.LIFE_S) {
                inj.mode[i] = 0;
                col[j] = col[j + 1] = col[j + 2] = 0;
                continue;
            }
            if (inj.mode[i] === 1) {
                inj.r[i] += (inj.targetL[i] - inj.r[i]) * ease;
                inj.theta[i] += inj.rate[i] * dSimH * 0.6;   // partial drift while entering
                if (inj.r[i] - inj.targetL[i] < 0.1) inj.mode[i] = 2;
            } else {
                inj.theta[i] += inj.rate[i] * dSimH;
            }
            const th = inj.theta[i];
            const y = inj.yAmp[i] * Math.sin(inj.bPh[i] + this._tView * 1.4);
            pos[j]     = inj.r[i] * Math.cos(th);
            pos[j + 1] = y;
            pos[j + 2] = inj.r[i] * Math.sin(th);
            // Hot white-yellow at entry, cooling to ion orange, then fading.
            const heat = Math.max(0, 1 - inj.age[i] / 8);
            const fade = 1 - inj.age[i] / INJECT.LIFE_S;
            const b = (0.55 + 0.65 * heat) * fade;
            col[j]     = (ION_COLOR.r + (1.00 - ION_COLOR.r) * heat) * b;
            col[j + 1] = (ION_COLOR.g + (0.95 - ION_COLOR.g) * heat) * b;
            col[j + 2] = (ION_COLOR.b + (0.62 - ION_COLOR.b) * heat) * b;
        }
        this._injGeo.attributes.position.needsUpdate = true;
        this._injGeo.attributes.color.needsUpdate = true;
    }

    // ── Hover tooltips — the data behind any particle ───────────────────────

    _initTooltip() {
        const el = document.createElement('div');
        el.style.cssText =
            'position:absolute;display:none;pointer-events:none;z-index:5;' +
            'background:rgba(3,1,14,.88);border:1px solid rgba(255,255,255,.2);' +
            'border-radius:6px;padding:6px 9px;font:600 11px system-ui;' +
            'color:#e8edf7;line-height:1.5;max-width:250px;white-space:nowrap;';
        this._container.appendChild(el);
        this._tipEl = el;
        this._ray = new THREE.Raycaster();
        this._ndc = new THREE.Vector2();
        this._pointerPx = null;
        this._pointerDirty = false;
        const dom = this._renderer.domElement;
        this._onPointerMove = (e) => {
            const rect = dom.getBoundingClientRect();
            this._ndc.set(
                ((e.clientX - rect.left) / rect.width) * 2 - 1,
                -((e.clientY - rect.top) / rect.height) * 2 + 1,
            );
            this._pointerPx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            this._pointerDirty = true;
        };
        this._onPointerLeave = () => {
            this._pointerPx = null;
            this._tipEl.style.display = 'none';
        };
        this._onPointerDown = () => { this._dragging = true; this._tipEl.style.display = 'none'; };
        this._onPointerUp = () => { this._dragging = false; };
        dom.addEventListener('pointermove', this._onPointerMove);
        dom.addEventListener('pointerleave', this._onPointerLeave);
        dom.addEventListener('pointerdown', this._onPointerDown);
        window.addEventListener('pointerup', this._onPointerUp);
    }

    _updateTooltip(wallNow) {
        if (!this._pointerDirty || !this._pointerPx || this._dragging) return;
        this._pointerDirty = false;
        this._ray.setFromCamera(this._ndc, this._camera);

        // Ring populations (tight threshold), skipping Dst-hidden particles.
        this._ray.params.Points.threshold = 0.24;
        let best = null;
        for (const P of [this._ions, this._electrons]) {
            for (const hit of this._ray.intersectObject(P.points)) {
                if (hit.index >= (P.nVis ?? P.pop.count)) continue;
                if (hit.point.length() < 1.1) continue;      // parked/inside Earth
                if (!best || hit.distance < best.hit.distance) best = { kind: 'ring', P, hit };
                break;
            }
        }
        // Transit parcels (fat threshold — they're far away and clustered).
        this._ray.params.Points.threshold = 1.0;
        for (const hit of this._ray.intersectObject(this._transit)) {
            if (hit.point.length() < 1.6) continue;
            const p = this._slotParcel?.[Math.floor(hit.index / TRANSIT.PTS_PER)];
            if (!p) continue;
            if (!best || hit.distance < best.hit.distance) best = { kind: 'parcel', p, hit };
            break;
        }

        if (!best) { this._tipEl.style.display = 'none'; return; }
        const fmt = (x, d, u) => Number.isFinite(x) ? `${x.toFixed(d)}${u}` : '—';
        let html;
        if (best.kind === 'ring') {
            const { pop } = best.P, i = best.hit.index;
            const T = driftPeriodHours(pop.eKev[i], pop.L[i]);
            html = `<b style="color:${pop.species === 'ion' ? '#ffa040' : '#59baff'}">` +
                `${pop.species === 'ion' ? 'Ion' : 'Electron'}</b> · ${pop.eKev[i].toFixed(0)} keV` +
                `<br>L ${pop.L[i].toFixed(2)} Rᴇ · drift ${fmt(T, 1, ' h')}/lap ` +
                `${pop.species === 'ion' ? 'westward' : 'eastward'}`;
        } else {
            const p = best.p;
            const etaMin = Math.max(0, Math.round((p.tArrive - wallNow) / 60_000));
            html = `<b style="color:#ffd9b0">L1 parcel</b> · v ${fmt(p.v, 0, ' km/s')}` +
                `<br>Bz ${fmt(p.bz, 1, ' nT')} · n ${fmt(p.n, 1, ' /cm³')}` +
                `<br>arrives in ${etaMin} min (real)`;
        }
        this._tipEl.innerHTML = html;
        this._tipEl.style.left = `${this._pointerPx.x + 14}px`;
        this._tipEl.style.top = `${this._pointerPx.y + 12}px`;
        this._tipEl.style.display = 'block';
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
            `${nw.storm?.label ?? ''}`,
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
        };
        if (Math.abs(this._state.peakL - this._builtPeakL) > 0.12) {
            this._rebuildTorus(this._state.peakL);
        }
        const intensity = Math.min(1, Math.abs(this._state.dstStar) / 150);
        this._torusMat.opacity = 0.06 + 0.22 * intensity;
        this._arcMat.opacity   = 0.30 * intensity * this._state.asym.amplitude;
        const pp = this._state.plasmapauseL;
        this._plasmapause.scale.setScalar(pp / 4.7);
    }

    /** The shared SimClock — the page's τ UI drives this same instance. */
    get clock() { return this._clock; }

    /** Legacy spelling kept for probes/back-compat: sets the SimClock τ. */
    setTimeCompression(x) {
        this._clock.setTau(x);
    }

    tick(dt) {
        const wallNow = Date.now();
        const simNow = this._clock.now(wallNow);
        if (this._clock.wraps !== this._seenWraps) {
            // Sweep restarted (wrap or τ change) — don't fire the whole
            // window's arrivals as one burst.
            this._seenWraps = this._clock.wraps;
            this._lastSimNow = simNow;
        }
        const dSimH = this._clock.dSim(dt * 1000) / 3.6e6;   // wall s → sim hours
        this._tView += dt;
        this._updatePopulation(this._ions, dSimH);
        this._updatePopulation(this._electrons, dSimH);
        this._updateTransit(simNow, wallNow);
        this._detectArrivals(simNow);
        this._lastSimNow = simNow;
        this._updateFlashes(dt);
        this._updateInjections(dt, dSimH);
        this._updateTooltip(wallNow);
        this._controls.update();
        this._renderer.render(this._scene, this._camera);
    }

    _updatePopulation(P, dtH) {
        const { pop, pos, col, baseColor } = P;
        const { dstStar, asym } = this._state;
        const depth = Math.min(1, Math.abs(dstStar) / 150);
        const intensity = 0.25 + 0.75 * depth;
        // Dst coupling, count edition: quiet ⇒ thin dim torus, storm main
        // phase ⇒ dense. Hidden particles keep drifting (positions advance)
        // so deepening storms reveal a coherent ring, not a fresh scatter.
        const nVis = Math.floor(pop.count * (0.40 + 0.60 * depth));
        P.nVis = nVis;
        const tv = this._tView;
        for (let i = 0; i < pop.count; i++) {
            let th = pop.theta[i] + pop.rate[i] * dtH;
            if (th > 2 * Math.PI) th -= 2 * Math.PI;
            else if (th < 0) th += 2 * Math.PI;
            pop.theta[i] = th;

            // Bounce along the field line r = L·cos²λ between ±mirror
            // latitude — the particle physically follows its flux tube, so
            // the ring reads as a true 3D shell, not a flat annulus.
            const L = pop.L[i];
            const lam = pop.mirrorL[i] * Math.sin(pop.bRate[i] * tv + pop.bPhase[i]);
            const fl = dipoleFieldLinePoint(L, lam);
            const j = i * 3;
            pos[j]     = fl.rho * Math.cos(th);
            pos[j + 1] = fl.y;
            pos[j + 2] = fl.rho * Math.sin(th);

            if (i >= nVis) {   // black under additive blending = invisible
                col[j] = col[j + 1] = col[j + 2] = 0;
                continue;
            }
            const mlt = (12 + th * 12 / Math.PI) % 24;
            const w = radialProfile(L, dstStar) * azimuthalWeight(mlt, asym) * intensity;
            const b = 0.06 + 0.94 * Math.min(1.3, w);
            col[j]     = baseColor.r * b;
            col[j + 1] = baseColor.g * b;
            col[j + 2] = baseColor.b * b;
        }
        P.geo.attributes.position.needsUpdate = true;
        P.geo.attributes.color.needsUpdate = true;
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
        this._renderer.domElement.removeEventListener('pointermove', this._onPointerMove);
        this._renderer.domElement.removeEventListener('pointerleave', this._onPointerLeave);
        this._renderer.domElement.removeEventListener('pointerdown', this._onPointerDown);
        window.removeEventListener('pointerup', this._onPointerUp);
        this._tipEl?.remove();
        this._scene.traverse(o => {
            o.geometry?.dispose?.();
            if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
        });
        this._renderer.dispose();
        this._renderer.domElement.remove();
    }
}
