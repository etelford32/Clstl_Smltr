/**
 * ring-current-globe.js — Three.js digital twin scene for ring-current.html
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Scene (Earth at origin, 1 unit = 1 R_E, equatorial plane = XZ, north = +Y,
 * Sun toward +X):
 *
 *   earth          textured sphere + additive atmosphere shell
 *   fieldLines     dipole cage — r = L·cos²λ at L = 2…6 × 12 meridians
 *   ions           ~3200 drift-animated points, WESTWARD, warm colors
 *   electrons      ~1400 drift-animated points, EASTWARD, cool colors
 *   ringTorus      symmetric glow at the model's peak L (|Dst*|-driven)
 *   partialArc     dusk-centred arc — the partial ring current bulge
 *   plasmapause    thin cyan ring at Carpenter–Anderson Lpp(Kp)
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
} from './ring-current-model.js';

// Keep in sync with js/earth-skin.js EARTH_TEXTURES (version-pinned CDN).
const EARTH_DAY_TEXTURE = 'https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg';

const ION_COLOR      = new THREE.Color(1.00, 0.62, 0.22);
const ELECTRON_COLOR = new THREE.Color(0.35, 0.75, 1.00);

function makePopulation(count, species) {
    const L      = new Float32Array(count);
    const theta  = new Float32Array(count);
    const eKev   = new Float32Array(count);
    const yAmp   = new Float32Array(count);
    const yPhase = new Float32Array(count);
    const rate   = new Float32Array(count);   // rad/h, signed
    for (let i = 0; i < count; i++) {
        L[i]      = 1.9 + Math.random() * 4.6;
        theta[i]  = Math.random() * 2 * Math.PI;
        eKev[i]   = 20 * Math.pow(250 / 20, Math.random());     // log-uniform 20–250 keV
        yAmp[i]   = Math.abs(gauss()) * 0.30 * (L[i] / 4);
        yPhase[i] = Math.random() * 2 * Math.PI;
        rate[i]   = driftRateRadPerHour(eKev[i], L[i], species);
    }
    return { count, species, L, theta, eKev, yAmp, yPhase, rate };
}

function gauss() {
    return (Math.random() + Math.random() + Math.random() + Math.random() - 2) / 2;
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
        this._bouncePhase = 0;
        this._builtPeakL = 0;

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
        this._controls.maxDistance = 60;

        // Lighting: Sun from +X.
        this._scene.add(new THREE.AmbientLight(0x8899bb, 0.55));
        const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
        sun.position.set(1, 0.12, 0);
        this._scene.add(sun);

        this._buildEarth();
        this._buildFieldLines();
        this._buildParticles();
        this._buildRings();

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

    // ── State & animation ───────────────────────────────────────────────────

    /** Feed the latest model state (detail of ring-current-feed 'state'). */
    setState(state) {
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
        this._bouncePhase += dt * 2.4;                     // decorative bounce rate
        this._updatePopulation(this._ions, dtH);
        this._updatePopulation(this._electrons, dtH);
        this._controls.update();
        this._renderer.render(this._scene, this._camera);
    }

    _updatePopulation(P, dtH) {
        const { pop, pos, col, baseColor } = P;
        const { dstStar, asym } = this._state;
        const intensity = 0.25 + 0.75 * Math.min(1, Math.abs(dstStar) / 150);
        for (let i = 0; i < pop.count; i++) {
            let th = pop.theta[i] + pop.rate[i] * dtH;
            if (th > 2 * Math.PI) th -= 2 * Math.PI;
            else if (th < 0) th += 2 * Math.PI;
            pop.theta[i] = th;

            const L = pop.L[i];
            const y = pop.yAmp[i] * Math.sin(this._bouncePhase + pop.yPhase[i]);
            const j = i * 3;
            pos[j]     = L * Math.cos(th);
            pos[j + 1] = y;
            pos[j + 2] = L * Math.sin(th);

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
