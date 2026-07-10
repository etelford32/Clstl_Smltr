/**
 * ring-current-globe.js — Three.js digital twin scene for ring-current.html
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Scene (Earth at origin, 1 unit = 1 R_E, equatorial plane = XZ, north = +Y,
 * Sun toward +X):
 *
 *   earth          textured sphere + additive atmosphere shell
 *   fieldLines     dipole cage — r = L·cos²λ at L = 2…6 × 12 meridians
 *   ions           ~3200 points, WESTWARD drift + REAL field-line bounce
 *                  between mirror points (pitch angles above the loss cone)
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
 * Azimuth convention: position = (r·cosθ, y, r·sinθ);
 * MLT = (12 + θ·12/π) mod 24 — noon (12 MLT) at +X, the dusk bulge at
 * 19 MLT ⇒ θ = 7π/12. Ions step θ negative (westward, decreasing MLT),
 * electrons positive; both carry westward current.
 *
 * Physics weights come from js/ring-current-model.js — this file only draws.
 * Bounce motion is decorative (viewing-rate, like js/van-allen-particles.js);
 * drift runs at real rate × timeCompression (default 600×, so a 100 keV ion
 * at L=3 laps Earth in ~14 s of viewing).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    radialProfile, azimuthalWeight, driftRateRadPerHour, ringPeakL,
    dipoleFieldLinePoint, mirrorLatitude, lossConeAngle, dynamicPressure,
} from './ring-current-model.js';

// Keep in sync with js/earth-skin.js EARTH_TEXTURES (version-pinned CDN).
const EARTH_DAY_TEXTURE = 'https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg';

const ION_COLOR      = new THREE.Color(1.00, 0.62, 0.22);
const ELECTRON_COLOR = new THREE.Color(0.35, 0.75, 1.00);

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
// Each parcel = one not-yet-arrived L1 sample from feed state.transit,
// rendered as a small cluster at the corridor position matching its REAL
// time-to-arrival (this deliberately ignores the drift time compression —
// the stream is an honest, real-time forecast display, not an animation).
const TRANSIT = Object.freeze({
    MAX_PARCELS: 120,
    PTS_PER:     8,
    X_MP:        11,     // corridor end ≈ subsolar magnetopause (R_E)
    X_SUN:       52,     // corridor start, toward the Sun sprite
    LEAD_MAX:    75,     // minutes mapped across the corridor
});

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
            new THREE.MeshBasicMaterial({
                color: 0x3d6bff, transparent: true, opacity: 0.08,
                blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
            }),
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
        const mat = new THREE.PointsMaterial({
            size, vertexColors: true, transparent: true, opacity: 0.9,
            blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
        });
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
        const mat = new THREE.PointsMaterial({
            size: 0.16, vertexColors: true, transparent: true, opacity: 0.95,
            blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
        });
        this._transit = new THREE.Points(this._transitGeo, mat);
        this._transit.frustumCulled = false;
        this._scene.add(this._transit);
    }

    /** Corridor rendering: real time-to-arrival → position between Sun and
     *  magnetopause. Runs every frame so parcels creep Earthward in true
     *  real time and vanish exactly when their plasma reaches Earth. */
    _updateTransit() {
        const now = Date.now();
        const pos = this._transitPos, col = this._transitCol, off = this._transitOff;
        let slot = 0;
        for (const p of this._parcels) {
            if (slot >= TRANSIT.MAX_PARCELS) break;
            const mins = (p.tArrive - now) / 60_000;
            if (mins <= 0 || mins > TRANSIT.LEAD_MAX) continue;
            const x = TRANSIT.X_MP + (mins / TRANSIT.LEAD_MAX) * (TRANSIT.X_SUN - TRANSIT.X_MP);
            // Southward Bz (the injector) renders hot; northward renders cool.
            const south = Number.isFinite(p.bz) && p.bz < 0;
            const mag = Number.isFinite(p.bz) ? Math.min(1, Math.abs(p.bz) / 15) : 0.2;
            const R = south ? 1.0 : 0.30, G = south ? 0.45 - 0.15 * mag : 0.75, B = south ? 0.22 : 1.0;
            const pdyn = dynamicPressure(p.n, p.v);
            const bright = 0.30 + 0.70 * Math.min(1, (pdyn ?? 1.5) / 8);
            for (let k = 0; k < TRANSIT.PTS_PER; k++) {
                const j = (slot * TRANSIT.PTS_PER + k) * 3;
                pos[j]     = x + off[j];
                pos[j + 1] = off[j + 1];
                pos[j + 2] = off[j + 2];
                col[j]     = R * bright;
                col[j + 1] = G * bright;
                col[j + 2] = B * bright;
            }
            slot++;
        }
        // Park unused slots at the origin, black (invisible under additive).
        for (let s = slot * TRANSIT.PTS_PER; s < TRANSIT.MAX_PARCELS * TRANSIT.PTS_PER; s++) {
            pos[s * 3] = pos[s * 3 + 1] = pos[s * 3 + 2] = 0;
            col[s * 3] = col[s * 3 + 1] = col[s * 3 + 2] = 0;
        }
        this._transitGeo.attributes.position.needsUpdate = true;
        this._transitGeo.attributes.color.needsUpdate = true;
    }

    // ── State & animation ───────────────────────────────────────────────────

    /** Feed the latest model state (detail of ring-current-feed 'state'). */
    setState(state) {
        this._parcels = state?.transit?.parcels?.slice(0, TRANSIT.MAX_PARCELS) ?? [];
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

    setTimeCompression(x) {
        this._timeCompression = Math.max(1, x);
    }

    tick(dt) {
        const dtH = (dt * this._timeCompression) / 3600;   // viewing → model hours
        this._tView += dt;
        this._updatePopulation(this._ions, dtH);
        this._updatePopulation(this._electrons, dtH);
        this._updateTransit();
        this._controls.update();
        this._renderer.render(this._scene, this._camera);
    }

    _updatePopulation(P, dtH) {
        const { pop, pos, col, baseColor } = P;
        const { dstStar, asym } = this._state;
        const intensity = 0.25 + 0.75 * Math.min(1, Math.abs(dstStar) / 150);
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
        this._scene.traverse(o => {
            o.geometry?.dispose?.();
            if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
        });
        this._renderer.dispose();
        this._renderer.domElement.remove();
    }
}
