/**
 * hero-space-weather.js  —  Three.js 3D space-weather scene for the hero canvas
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders Earth + live magnetosphere driven by real NOAA SWPC data.
 *
 *   • Earth sphere (ocean + atmosphere limb glow)
 *   • MagnetosphereEngine — magnetopause, bow shock, Van Allen belts, plasmasphere
 *   • Solar-wind particle stream, Bz-coloured
 *   • Auroral ovals at magnetic poles (Kp-driven)
 *   • Slow camera orbit around the scene
 *   • Graceful fallback: if WebGL unavailable the hero photo background shows
 *
 * Usage:
 *   import { HeroSpaceWeather } from './js/hero-space-weather.js';
 *   new HeroSpaceWeather(canvas).start();
 */
import * as THREE from 'three';
import { MagnetosphereEngine } from './magnetosphere-engine.js';

const DEG = Math.PI / 180;

// Sun direction in world space — slightly tilted off the equatorial plane.
// _solarGroup's +Y axis tracks this each tick via MagnetosphereEngine.tick().
const SUN_DIR = new THREE.Vector3(1, 0.12, -0.08).normalize();

export class HeroSpaceWeather {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object}            opts
     */
    constructor(canvas, opts = {}) {
        this._canvas = canvas;
        this._opts = {
            particleCount: window.innerWidth < 700 ? 360 : 700,
            rotateSpeed:   0.022,   // degrees/s camera orbit
            ...opts,
        };
        this._state  = { solar_wind: { speed: 420, density: 5, bz: 0 }, kp: 2 };
        this._t      = 0;
        this._animId = null;
        this._aurora = null;   // { north, south } Mesh references
    }

    start() {
        try {
            this._initRenderer();
            this._initScene();
            this._initCamera();
            this._initLighting();
            this._initEarth();
            this._initStars();
            this._initSunGlow();
            this._initParticles();
            this._engine = new MagnetosphereEngine(this._scene);
            this._engine.update(this._state);

            window.addEventListener('resize', this._onResize.bind(this), { passive: true });
            window.addEventListener('swpc-update', e => {
                this._state = e.detail;
                this._engine.update(e.detail);
                this._updateFromState(e.detail);
            }, { passive: true });

            this._animate();
        } catch (err) {
            // WebGL unavailable — canvas stays hidden, hero photo shows instead
            console.warn('[HeroSpaceWeather] WebGL error:', err.message);
            if (this._canvas) this._canvas.style.display = 'none';
        }
    }

    stop() {
        if (this._animId) { cancelAnimationFrame(this._animId); this._animId = null; }
    }

    // ── Renderer ──────────────────────────────────────────────────────────────
    _initRenderer() {
        const r = new THREE.WebGLRenderer({
            canvas:    this._canvas,
            antialias: window.devicePixelRatio < 2,
            alpha:     false,   // opaque — scene provides its own background
            powerPreference: 'high-performance',
        });
        r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        r.setSize(this._w(), this._h(), false);
        r.setClearColor(0x010209, 1);
        r.sortObjects = true;
        this._renderer = r;
    }

    // ── Scene ─────────────────────────────────────────────────────────────────
    _initScene() {
        this._scene = new THREE.Scene();
        // Very subtle exponential fog fades distant tail geometry
        this._scene.fog = new THREE.FogExp2(0x010209, 0.0055);
    }

    // ── Camera ────────────────────────────────────────────────────────────────
    _initCamera() {
        const cam = new THREE.PerspectiveCamera(50, this._w() / this._h(), 0.1, 600);
        // Positioned from the dusk/flank side, elevated ~15° above equatorial plane.
        // This view shows: compressed dayside magnetopause (right), tail (left),
        // Van Allen belts as glowing tori, Earth at centre.
        cam.position.set(-9, 6, 21);
        cam.lookAt(0, 0, 0);
        this._camera = cam;

        // Spherical coords for orbit animation
        this._camR   = cam.position.length();
        this._camPhi = Math.asin(cam.position.y / this._camR);
        this._camTh  = Math.atan2(cam.position.z, cam.position.x);
    }

    // ── Lighting ─────────────────────────────────────────────────────────────
    _initLighting() {
        // Sun — directional, warm white, casts the day/night terminator on Earth
        const sun = new THREE.DirectionalLight(0xfff0d8, 2.8);
        sun.position.copy(SUN_DIR).multiplyScalar(80);
        this._scene.add(sun);
        // Night-side fill — deep blue ambient so the dark hemisphere stays visible
        const ambient = new THREE.AmbientLight(0x0c1630, 1.8);
        this._scene.add(ambient);
    }

    // ── Earth ─────────────────────────────────────────────────────────────────
    _initEarth() {
        const scene = this._scene;

        // Core sphere — rich ocean blue with a bit of emissive so it never goes black
        const earthMat = new THREE.MeshPhongMaterial({
            color:     0x1a4ea8,
            emissive:  0x060c1e,
            specular:  0x5599dd,
            shininess: 40,
        });
        this._earth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 64), earthMat);
        scene.add(this._earth);

        // Atmosphere — inner haze (BackSide so it appears as a rim glow)
        scene.add(_additiveSphere(1.10, 0x2266dd, 0.10));
        // Outer limb glow
        scene.add(_additiveSphere(1.20, 0x1144bb, 0.045));

        // Auroral ovals — north & south polar caps, visible when Kp ≥ 2
        // Ring geometry: inner radius ~0.65 Re from pole axis, outer ~0.90 Re
        // Mounted at magnetic poles (tilted ~11° from geo north toward ~70°W lon)
        const TILT   = 11.5 * DEG;
        const aGeo   = new THREE.RingGeometry(0.55, 0.85, 48);
        const aMat   = new THREE.MeshBasicMaterial({
            color:       0x00ff88,
            transparent: true,
            opacity:     0.0,
            side:        THREE.DoubleSide,
            blending:    THREE.AdditiveBlending,
            depthWrite:  false,
        });
        const aN = new THREE.Mesh(aGeo, aMat.clone());
        aN.position.set(0, 1.0, 0);
        aN.rotation.x = Math.PI / 2;
        const aS = new THREE.Mesh(aGeo, aMat.clone());
        aS.position.set(0, -1.0, 0);
        aS.rotation.x = -Math.PI / 2;
        // Tilt to geomagnetic pole (~11° toward -Z from +Y)
        const poleQ = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 0, 1), TILT
        );
        aN.quaternion.premultiply(poleQ);
        aS.quaternion.premultiply(poleQ);
        scene.add(aN);
        scene.add(aS);
        this._aurora = { north: aN, south: aS };
    }

    // ── Background stars ──────────────────────────────────────────────────────
    _initStars() {
        const N   = 2200;
        const pos = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const phi   = Math.acos(2 * Math.random() - 1);
            const theta = Math.random() * Math.PI * 2;
            const r     = 280 + Math.random() * 60;
            pos[i*3]   = r * Math.sin(phi) * Math.cos(theta);
            pos[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
            pos[i*3+2] = r * Math.cos(phi);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        this._scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
            color: 0xffffff, size: 0.55, sizeAttenuation: true,
            transparent: true, opacity: 0.75,
        })));
    }

    // ── Sun glow (off-screen source) ──────────────────────────────────────────
    _initSunGlow() {
        const sunPt = SUN_DIR.clone().multiplyScalar(65);
        this._scene.add(_additiveSphere(4.5, 0xffe080, 0.18).translateX(sunPt.x).translateY(sunPt.y).translateZ(sunPt.z));
        this._scene.add(_additiveSphere(8.5, 0xff9900, 0.06).translateX(sunPt.x).translateY(sunPt.y).translateZ(sunPt.z));
    }

    // ── Solar-wind particles ──────────────────────────────────────────────────
    _initParticles() {
        const N   = this._opts.particleCount;
        const pos = new Float32Array(N * 3);
        const vel = new Float32Array(N);
        this._pPhase = new Float32Array(N);

        for (let i = 0; i < N; i++) {
            this._spawnParticle(pos, vel, i, /*scatter=*/true);
            this._pPhase[i] = Math.random() * Math.PI * 2;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        this._pPos = pos;
        this._pVel = vel;

        this._pMat = new THREE.PointsMaterial({
            color:       0xaaccff,
            size:        0.22,
            transparent: true,
            opacity:     0.50,
            blending:    THREE.AdditiveBlending,
            depthWrite:  false,
        });
        this._particles = new THREE.Points(geo, this._pMat);
        this._scene.add(this._particles);
    }

    // Spawn one particle on the sun-side spawn plane, optionally randomise Z
    _spawnParticle(pos, vel, i, scatter = false) {
        // Plane perpendicular to SUN_DIR, offset 26 Re toward the sun
        const right = new THREE.Vector3(0, 1, 0).cross(SUN_DIR).normalize();
        const up    = SUN_DIR.clone().cross(right).normalize();
        const spread = 22;
        const y = (Math.random() - 0.5) * spread;
        const z = (Math.random() - 0.5) * spread;
        const pt = SUN_DIR.clone().multiplyScalar(26)
            .addScaledVector(right, y)
            .addScaledVector(up,    z);
        pos[i*3]   = pt.x + (scatter ? (Math.random() - 0.5) * 55 : 0);
        pos[i*3+1] = pt.y;
        pos[i*3+2] = pt.z + (scatter ? (Math.random() - 0.5) * 55 : 0);
        vel[i] = 0.5 + Math.random() * 0.9;
    }

    // ── React to live SWPC data ───────────────────────────────────────────────
    _updateFromState(state) {
        const bz = state.solar_wind?.bz ?? 0;
        // Particle colour: southward Bz → red/pink; northward → blue; quiet → ice
        if      (bz < -8) this._pMat.color.setHex(0xff6644);
        else if (bz < -3) this._pMat.color.setHex(0xff99bb);
        else if (bz >  5) this._pMat.color.setHex(0x55aaff);
        else              this._pMat.color.setHex(0xaaccff);

        // Aurora opacity proportional to Kp (fades in at Kp 2, max at Kp 7)
        const kp    = state.kp ?? 0;
        const aOp   = Math.min(0.55, Math.max(0, (kp - 1.5) / 6.5) * 0.55);
        const aCol  = kp >= 5 ? 0x88ff44 : 0x00ff88;
        [this._aurora.north, this._aurora.south].forEach(m => {
            m.material.opacity     = aOp;
            m.material.color.setHex(aCol);
        });
    }

    // ── Animation loop ────────────────────────────────────────────────────────
    _animate() {
        this._animId = requestAnimationFrame(this._animate.bind(this));
        const dt = Math.min(1 / 30, 1 / 60);   // clamp: handles tab-hidden catch-up
        this._t += dt;

        // ── Slow camera orbit around origin ───────────────────────────────
        this._camTh += this._opts.rotateSpeed * DEG * dt * 60;
        const cx = this._camR * Math.cos(this._camPhi) * Math.cos(this._camTh);
        const cy = this._camR * Math.sin(this._camPhi);
        const cz = this._camR * Math.cos(this._camPhi) * Math.sin(this._camTh);
        this._camera.position.set(cx, cy, cz);
        this._camera.lookAt(0, 0, 0);

        // ── Earth sidereal rotation (~24° per sim-hour; visually ~0.001 rad/frame) ──
        this._earth.rotation.y += 0.0008 * dt * 60;

        // ── Magnetosphere per-frame update ────────────────────────────────
        this._engine.tick(this._t, SUN_DIR);

        // ── Solar-wind particle motion ────────────────────────────────────
        this._advanceParticles(dt);

        // ── Aurora gentle shimmer ─────────────────────────────────────────
        if (this._aurora) {
            const flicker = 0.04 * Math.sin(this._t * 3.1);
            [this._aurora.north, this._aurora.south].forEach(m => {
                m.material.opacity = Math.max(0, m.material.opacity + flicker * 0.01);
            });
        }

        this._renderer.render(this._scene, this._camera);
    }

    _advanceParticles(dt) {
        const sw    = this._state?.solar_wind ?? {};
        const spd   = Math.max(200, sw.speed ?? 400);
        // Convert: 1 unit = 1 Re (6371 km).  Real wind 400 km/s → 0.063 Re/s.
        // Visual scale ×3.5 so motion reads clearly without being distracting.
        const speed = (spd / 6371) * 3.5;
        const anti  = SUN_DIR.clone().negate(); // particles travel anti-sunward
        const pos   = this._pPos;
        const vel   = this._pVel;
        const N     = this._opts.particleCount;

        for (let i = 0; i < N; i++) {
            pos[i*3]   += anti.x * speed * vel[i] * dt * 60;
            pos[i*3+1] += anti.y * speed * vel[i] * dt * 60;
            pos[i*3+2] += anti.z * speed * vel[i] * dt * 60;
            // Slight transverse oscillation (plasma Alfvén waves)
            pos[i*3+1] += Math.sin(this._pPhase[i] + this._t * 1.2) * 0.003;
            // Respawn once particle crosses the anti-solar boundary (~30 Re)
            if (pos[i*3]*anti.x + pos[i*3+1]*anti.y + pos[i*3+2]*anti.z > 28) {
                this._spawnParticle(pos, vel, i);
            }
        }
        this._particles.geometry.attributes.position.needsUpdate = true;
    }

    // ── Resize ────────────────────────────────────────────────────────────────
    _onResize() {
        const w = this._w(), h = this._h();
        this._camera.aspect = w / h;
        this._camera.updateProjectionMatrix();
        this._renderer.setSize(w, h, false);
    }

    _w() { return this._canvas.clientWidth  || 900; }
    _h() { return this._canvas.clientHeight || 520; }
}

// ── Helper: simple additive glow sphere ───────────────────────────────────────
function _additiveSphere(r, color, opacity) {
    return new THREE.Mesh(
        new THREE.SphereGeometry(r, 24, 24),
        new THREE.MeshBasicMaterial({
            color, transparent: true, opacity,
            side: THREE.BackSide,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        })
    );
}
