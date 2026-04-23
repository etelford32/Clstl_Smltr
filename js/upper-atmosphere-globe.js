/**
 * upper-atmosphere-globe.js — 3D Earth + atmosphere-shell visualisation
 * ═══════════════════════════════════════════════════════════════════════════
 * A lightweight Three.js scene tailored for the upper-atmosphere page:
 *
 *   • Textured Earth sphere with phong lighting (day-side + ambient fill)
 *   • Star-field background
 *   • Six concentric translucent atmosphere shells at canonical altitudes
 *     (150, 250, 400, 600, 900, 1500 km), each coloured by local log(ρ)
 *     at the current F10.7/Ap state
 *   • A highlighted ring at the user-selected altitude
 *   • OrbitControls (rotate, zoom), auto-resize via ResizeObserver
 *
 * The exosphere shell radii are specified in Earth-radius units so the
 * visual scale stays constant as the user sweeps altitude. Each shell
 * opacity tracks log₁₀(ρ_shell / ρ_max), clamped to [0.04, 0.55] so the
 * densest layer never blocks the lower shells and the thinnest layer
 * still shows its presence.
 *
 * Export:
 *   AtmosphereGlobe              class
 *     new AtmosphereGlobe(canvas, opts)
 *     setProfile(profile)        feed a sampleProfile() result
 *     setAltitude(altitudeKm)    move the highlighted ring
 *     setCameraAltitude(km)      optional external camera control
 *     dispose()
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const R_EARTH_KM = 6371;
const SHELL_ALTS_KM = [150, 250, 400, 600, 900, 1500];

// Textures sourced from the same CDN earth-skin.js uses — we only want
// the blue-marble day texture, nothing storm-/aurora-related.
const EARTH_DAY_TEXTURE =
    'https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg';

export class AtmosphereGlobe {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} [opts]
     * @param {number} [opts.cameraDistance=3.5]  initial camera distance (Earth radii)
     * @param {boolean}[opts.showLabels=true]     render altitude labels beside shells
     */
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.opts = {
            cameraDistance: 3.5,
            showLabels: true,
            ...opts,
        };

        this._initRenderer();
        this._initScene();
        this._buildEarth();
        this._buildShells();
        this._buildRing();
        this._initStars();
        this._initControls();
        this._initResize();

        this._animate = this._animate.bind(this);
        this._raf = requestAnimationFrame(this._animate);
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Feed in a full profile (from engine.sampleProfile). Shell colour and
     * opacity recompute; ring position is left alone (use setAltitude).
     */
    setProfile(profile) {
        if (!profile || !profile.samples || profile.samples.length === 0) return;
        this._profile = profile;

        // Find ρ(alt) for each shell by nearest-lookup; profile is dense
        // enough (~200 points) that nearest is fine.
        const rhoByShell = SHELL_ALTS_KM.map(alt => _nearestRho(profile.samples, alt));

        // Colour scale from log(ρ): tropopause-ish reds → cold black.
        const logRhos = rhoByShell.map(r => Math.log10(Math.max(r, 1e-30)));
        const maxLR = Math.max(...logRhos);
        const minLR = Math.min(...logRhos);
        const span = Math.max(maxLR - minLR, 1.0);

        for (let i = 0; i < this._shells.length; i++) {
            const t = (logRhos[i] - minLR) / span;       // 0 (thin) … 1 (dense)
            const color = _densityColor(t);
            const opacity = 0.04 + t * 0.51;             // [0.04, 0.55]
            this._shells[i].material.color.copy(color);
            this._shells[i].material.opacity = opacity;
            this._shells[i].userData.rho = rhoByShell[i];
        }

        // Ring colour follows the closest shell to the current altitude.
        if (this._currentAltKm != null) this.setAltitude(this._currentAltKm);
    }

    /**
     * Move the highlighted ring to a new altitude (km). Also drives the
     * ring's colour from the local ρ.
     */
    setAltitude(altitudeKm) {
        this._currentAltKm = altitudeKm;
        const r = 1 + altitudeKm / R_EARTH_KM;
        this._ring.scale.set(r, r, r);

        let rho = 0;
        if (this._profile) rho = _nearestRho(this._profile.samples, altitudeKm);
        const logR = Math.log10(Math.max(rho, 1e-30));
        // Warm cyan when dense, cool violet when thin.
        const t = Math.max(0, Math.min(1, (logR + 20) / 16));
        this._ring.material.color.copy(_densityColor(t));
        this._ring.material.opacity = 0.55 + t * 0.35;
    }

    /**
     * Clean up GPU + event-listener resources when the page unmounts.
     */
    dispose() {
        cancelAnimationFrame(this._raf);
        this._resizeObs?.disconnect();
        this._controls?.dispose();
        this._scene.traverse(o => {
            if (o.geometry) o.geometry.dispose?.();
            if (o.material) {
                if (Array.isArray(o.material)) o.material.forEach(m => m.dispose?.());
                else o.material.dispose?.();
            }
        });
        this._renderer.dispose();
    }

    // ── Construction ────────────────────────────────────────────────────────

    _initRenderer() {
        this._renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            alpha: false,
        });
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this._renderer.setClearColor(0x020016, 1);
    }

    _initScene() {
        this._scene = new THREE.Scene();
        const { clientWidth: w, clientHeight: h } = this.canvas;
        const aspect = Math.max(w / Math.max(h, 1), 1);
        this._camera = new THREE.PerspectiveCamera(42, aspect, 0.01, 1000);
        this._camera.position.set(0, 0.4, this.opts.cameraDistance);

        // Sun — directional light. Ambient fill keeps the night side
        // visible at low opacity so the shells are readable all around.
        const sun = new THREE.DirectionalLight(0xfff6e8, 1.35);
        sun.position.set(5, 2, 3);
        this._scene.add(sun);
        this._scene.add(new THREE.AmbientLight(0x334455, 0.8));
    }

    _buildEarth() {
        const geom = new THREE.SphereGeometry(1, 64, 64);
        const mat = new THREE.MeshPhongMaterial({
            shininess: 12,
            specular: new THREE.Color(0x111930),
            color: new THREE.Color(0x3c5c8c),        // fallback tint before texture
        });
        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
        loader.load(
            EARTH_DAY_TEXTURE,
            tex => {
                mat.map = tex;
                mat.color.setHex(0xffffff);
                mat.needsUpdate = true;
            },
            undefined,
            () => { /* keep the fallback tint if CDN is unreachable */ }
        );
        this._earth = new THREE.Mesh(geom, mat);
        this._scene.add(this._earth);
    }

    _buildShells() {
        this._shells = [];
        const group = new THREE.Group();
        for (const altKm of SHELL_ALTS_KM) {
            const r = 1 + altKm / R_EARTH_KM;
            const geom = new THREE.SphereGeometry(r, 48, 48);
            const mat = new THREE.MeshBasicMaterial({
                color: 0x3399cc,
                transparent: true,
                opacity: 0.15,
                side: THREE.BackSide,          // render interior so it reads as a shell
                depthWrite: false,
            });
            const mesh = new THREE.Mesh(geom, mat);
            mesh.userData = { altKm, rho: 0 };
            group.add(mesh);
            this._shells.push(mesh);
        }
        this._scene.add(group);
        this._shellGroup = group;
    }

    _buildRing() {
        // A torus at r=1 that we scale to the selected altitude.
        // Inclined ~23° so it doesn't collide with the equator visually.
        const torus = new THREE.TorusGeometry(1, 0.003, 16, 128);
        const mat = new THREE.MeshBasicMaterial({
            color: 0x00ffe6,
            transparent: true,
            opacity: 0.8,
            depthWrite: false,
        });
        this._ring = new THREE.Mesh(torus, mat);
        this._ring.rotation.x = Math.PI / 2;
        this._ring.rotation.y = 0.4;
        this._scene.add(this._ring);
    }

    _initStars() {
        // Cheap star backdrop — BufferGeometry of random points on a big sphere.
        const n = 2000;
        const positions = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            // Uniform on sphere
            const theta = 2 * Math.PI * Math.random();
            const phi   = Math.acos(1 - 2 * Math.random());
            const R = 200 + 100 * Math.random();
            positions[i * 3 + 0] = R * Math.sin(phi) * Math.cos(theta);
            positions[i * 3 + 1] = R * Math.cos(phi);
            positions[i * 3 + 2] = R * Math.sin(phi) * Math.sin(theta);
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.PointsMaterial({
            color: 0xb8c8ff,
            size: 0.9,
            sizeAttenuation: false,
            transparent: true,
            opacity: 0.85,
        });
        this._scene.add(new THREE.Points(geom, mat));
    }

    _initControls() {
        this._controls = new OrbitControls(this._camera, this.canvas);
        this._controls.enableDamping = true;
        this._controls.dampingFactor = 0.08;
        this._controls.minDistance = 1.3;
        this._controls.maxDistance = 12;
        this._controls.enablePan = false;
        this._controls.rotateSpeed = 0.6;
    }

    _initResize() {
        const resize = () => {
            const { clientWidth: w, clientHeight: h } = this.canvas;
            if (w === 0 || h === 0) return;
            this._renderer.setSize(w, h, false);
            this._camera.aspect = w / h;
            this._camera.updateProjectionMatrix();
        };
        resize();
        this._resizeObs = new ResizeObserver(resize);
        this._resizeObs.observe(this.canvas);
    }

    _animate(t) {
        this._raf = requestAnimationFrame(this._animate);
        // Gentle autorotation if the user hasn't touched OrbitControls
        // in the last second. Cuts the "dead frame" feel on initial load.
        if (this._controls && !this._controls.enabled) {
            // disabled — skip
        } else {
            this._earth.rotation.y += 0.0012;
            if (this._shellGroup) this._shellGroup.rotation.y += 0.0005;
        }
        this._controls.update();
        this._renderer.render(this._scene, this._camera);
    }
}

// ── Utilities ──────────────────────────────────────────────────────────────

/**
 * Nearest-neighbour ρ lookup on a sorted-by-altitude sample array.
 */
function _nearestRho(samples, altitudeKm) {
    // Binary search — samples are monotonic in altitude.
    let lo = 0, hi = samples.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (samples[mid].altitudeKm < altitudeKm) lo = mid + 1;
        else hi = mid;
    }
    // Pick whichever of [lo-1, lo] is closer.
    const a = samples[Math.max(0, lo - 1)];
    const b = samples[lo];
    return Math.abs(a.altitudeKm - altitudeKm) < Math.abs(b.altitudeKm - altitudeKm)
        ? a.rho
        : b.rho;
}

/**
 * Density→colour map. 0 = thin (cool violet), 1 = dense (warm cyan-white).
 * Tuned for the dark-navy site background so both ends stay visible.
 */
function _densityColor(t) {
    t = Math.max(0, Math.min(1, t));
    // Three-stop gradient: violet → teal → warm cyan.
    const stops = [
        { t: 0.0, c: [0.40, 0.15, 0.85] },   // violet
        { t: 0.5, c: [0.05, 0.72, 0.90] },   // teal
        { t: 1.0, c: [0.90, 0.95, 1.00] },   // warm cyan-white
    ];
    let i = 0;
    while (i + 1 < stops.length && stops[i + 1].t < t) i++;
    const a = stops[i];
    const b = stops[i + 1] || a;
    const u = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
    const c = new THREE.Color(
        a.c[0] + (b.c[0] - a.c[0]) * u,
        a.c[1] + (b.c[1] - a.c[1]) * u,
        a.c[2] + (b.c[2] - a.c[2]) * u,
    );
    return c;
}
