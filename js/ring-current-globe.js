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
 * Physics weights come from js/ring-current-model.js — this file only draws.
 * Drift runs at real rate × timeCompression (default 600×, so a 100 keV ion
 * at L=3 laps Earth in ~14 s of viewing; set 1× for true real time).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    radialProfile, azimuthalWeight, driftRateRadPerHour, ringPeakL,
    dipoleFieldLinePoint, mirrorLatitude, lossConeAngle, dynamicPressure,
    bouncePeriodSeconds, subsolarPoint, dipoleTiltRad,
} from './ring-current-model.js';

// Keep in sync with js/earth-skin.js EARTH_TEXTURES (version-pinned CDN).
const EARTH_DAY_TEXTURE = 'https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg';

const ION_COLOR      = new THREE.Color(1.00, 0.62, 0.22);   // H⁺ (solar wind)
const ION_O_COLOR    = new THREE.Color(0.58, 1.00, 0.34);   // O⁺ (ionospheric outflow)
const ELECTRON_COLOR = new THREE.Color(0.35, 0.75, 1.00);

// Fraction of ion PARTICLES built as O⁺. Fixed at build time (species can't
// flip mid-flight without a bounce-phase jump); the on-screen energy mix is
// steered per frame by brightness, normalised against this build ratio.
const O_BUILD_FRACTION = 1100 / 3200;

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
 * Trapped population with REAL dipole bounce: each particle gets an
 * equatorial pitch angle sampled ABOVE the loss cone (below it precipitates —
 * those never appear), the corresponding mirror latitude from μ-conservation,
 * and oscillates along its field line r = L·cos²λ between ±λ_m at its TRUE
 * bounce period (bouncePeriodSeconds — species mass matters: O⁺ is 4× slower
 * than H⁺ at the same energy, electrons buzz sub-second). Bounce time is
 * wall-clock, never compressed. Drift is physical rate × timeCompression,
 * sign flipped into scene θ (see header: westward = θ increasing).
 *
 * @param {'ion'|'oxygen'|'electron'} species
 */
function makePopulation(count, species) {
    const L       = new Float32Array(count);
    const theta   = new Float32Array(count);
    const eKev    = new Float32Array(count);
    const mirrorL = new Float32Array(count);  // mirror latitude (rad)
    const bRate   = new Float32Array(count);  // TRUE bounce rate 2π/T_b (rad/s)
    const bPhase  = new Float32Array(count);
    const rate    = new Float32Array(count);  // drift, scene-θ rad/h, signed
    const driftSpecies = species === 'electron' ? 'electron' : 'ion';
    for (let i = 0; i < count; i++) {
        L[i]     = 1.9 + Math.random() * 4.6;
        theta[i] = Math.random() * 2 * Math.PI;
        eKev[i]  = 20 * Math.pow(250 / 20, Math.random());      // log-uniform 20–250 keV
        // Pitch angle above the loss cone, biased toward 90° (trapped
        // distributions peak at equatorial mirroring).
        const lc = lossConeAngle(L[i]);
        const alpha = lc + (Math.PI / 2 - lc) * Math.pow(Math.random(), 0.45);
        mirrorL[i] = mirrorLatitude(alpha);
        bRate[i]   = 2 * Math.PI / bouncePeriodSeconds(eKev[i], L[i], alpha, species);
        bPhase[i]  = Math.random() * 2 * Math.PI;
        rate[i]    = -driftRateRadPerHour(eKev[i], L[i], driftSpecies);
    }
    return { count, species, L, theta, eKev, mirrorL, bRate, bPhase, rate };
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
        const mat = new THREE.MeshPhongMaterial({ color: 0x2a4d8f, shininess: 18 });
        new THREE.TextureLoader().load(EARTH_DAY_TEXTURE, (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            mat.map = tex;
            mat.color.set(0xffffff);
            mat.needsUpdate = true;
        }, undefined, () => { /* CDN unreachable → keep the plain blue globe */ });
        // Tilt group carries the axial tilt (rotation.z = −declination, pole
        // toward the Sun in northern summer); the mesh inside spins about the
        // tilted axis. Spin phase: THREE.SphereGeometry puts the equirect
        // texture's center meridian (lon 0) on +X at rotation.y = 0, and a
        // point at east longitude λ at scene θ = −λ; rotation.y = −λ_subsolar
        // therefore faces the true subsolar longitude at the Sun. Updated
        // every frame from the wall clock in tick().
        this._earthTilt = new THREE.Group();
        this._earth = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 48), mat);
        this._earthTilt.add(this._earth);
        this._scene.add(this._earthTilt);

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
        this._magGroup.add(group);
    }

    _buildParticles() {
        // Ion budget split H⁺/O⁺ at O_BUILD_FRACTION. O⁺ drifts identically
        // (drift period is mass-independent at fixed energy) but bounces at
        // its TRUE 4×-slower period via the species mass in makePopulation.
        this._ionsH     = this._makePoints(makePopulation(2100, 'ion'),      ION_COLOR,      0.085);
        this._ionsO     = this._makePoints(makePopulation(1100, 'oxygen'),   ION_O_COLOR,    0.095);
        this._electrons = this._makePoints(makePopulation(1400, 'electron'), ELECTRON_COLOR, 0.060);
        // Start at the quiet-time energy mix (≈6% O⁺).
        this._setCompositionMix(0.06);
    }

    /** Brightness-steer the two ion populations to an O⁺ energy fraction. */
    _setCompositionMix(fO) {
        const f = Math.max(0, Math.min(0.8, Number.isFinite(fO) ? fO : 0.06));
        this._ionsO.mix = Math.min(1.8, f / O_BUILD_FRACTION);
        this._ionsH.mix = Math.min(1.3, (1 - f) / (1 - O_BUILD_FRACTION));
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
        this._magGroup.add(points);
        return { pop, geo, pos, col, baseColor, points, mix: 1 };
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
        };
        this._setCompositionMix(now.oxygenFraction);
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
        this._updateGeometry();
        this._updatePopulation(this._ionsH, dtH);
        this._updatePopulation(this._ionsO, dtH);
        this._updatePopulation(this._electrons, dtH);
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
        this._earth.rotation.y     = -sp.lonDeg * Math.PI / 180;   // subsolar lon → +X
        this._magGroup.rotation.z  = -dipoleTiltRad(nowMs);        // GSM dipole tilt ψ
    }

    _updatePopulation(P, dtH) {
        const { pop, pos, col, baseColor, mix } = P;
        const { dstStar, asym } = this._state;
        // mix: composition brightness steer (H⁺ vs O⁺ energy share).
        const intensity = (0.25 + 0.75 * Math.min(1, Math.abs(dstStar) / 150)) * mix;
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

            const mlt = ((12 - th * 12 / Math.PI) % 24 + 24) % 24;   // frame: dawn at +Z
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
        this._scene.traverse(o => {
            o.geometry?.dispose?.();
            if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
        });
        this._renderer.dispose();
        this._renderer.domElement.remove();
    }
}
