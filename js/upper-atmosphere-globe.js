/**
 * upper-atmosphere-globe.js — 3D Earth + atmosphere-shell visualisation
 * ═══════════════════════════════════════════════════════════════════════════
 * Three.js scene for the upper-atmosphere page. Uses the shared EarthSkin
 * class from earth-skin.js so the planet matches earth.html / space-
 * weather.html exactly — day/night mask, ocean specular, topology,
 * atmosphere rim glow, aurora shader.
 *
 * Layers (Earth radius = 1.0):
 *   • EarthSkin.earthMesh                         surface, clouds off
 *   • EarthSkin atmosphere rim                    1.026 R⊕ (provided by skin)
 *   • density shells  at 100, 600, 1500 km        log-ρ-shaded
 *   • satellite rings at ISS/HST/Starlink/…       colored tori
 *   • altitude ring   at the user's current alt   cyan, tracks slider
 *   • star backdrop
 *
 * Aurora intensity follows the current Ap — stronger geomagnetic
 * forcing lights up the auroral oval via the EARTH_FRAG shader.
 *
 * Export:
 *   AtmosphereGlobe
 *     new AtmosphereGlobe(canvas, opts)
 *     setProfile(profile)                         per-shell ρ
 *     setAltitude(altitudeKm)                     move the cyan ring
 *     setState({ f107, ap })                      drive aurora + rim
 *     setVisibility({ satellites, shells })       toggle overlays
 *     dispose()
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EarthSkin } from './earth-skin.js';
import { SATELLITE_REFERENCES } from './upper-atmosphere-engine.js';

const R_EARTH_KM = 6371;

// Three visual density shells — one per atmospheric regime the page
// actually distinguishes (Kármán edge · thermopause · outer exosphere).
// Kept distinct from EarthSkin's atmosphere-rim shader so each shell
// can be lit by local log(ρ) rather than the fresnel glow.
const DENSITY_SHELLS = [
    { id: "karman-shell",     altKm:  100, baseColor: 0xff9090 },
    { id: "thermopause",      altKm:  600, baseColor: 0xffb060 },
    { id: "outer-exosphere",  altKm: 1500, baseColor: 0xc080ff },
];

// Formal atmospheric-layer boundary rings — visually subtle, labelled in
// the UI legend rather than the 3D scene.
const LAYER_BOUNDARY_RINGS = [
    { id: "mesopause",  altKm:  85, color: 0x7aa8ff, opacity: 0.45 },
    { id: "thermopause",altKm: 600, color: 0xff8a4c, opacity: 0.55 },
];

export class AtmosphereGlobe {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} [opts]
     * @param {number} [opts.cameraDistance=3.2]  initial camera distance (Earth radii)
     * @param {boolean}[opts.stars=true]
     * @param {boolean}[opts.autoRotate=true]
     */
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.opts = { cameraDistance: 3.2, stars: true, autoRotate: true, ...opts };

        this._initRenderer();
        this._initScene();
        this._buildEarth();
        this._buildShells();
        this._buildLayerRings();
        this._buildSatelliteRings();
        this._buildAltitudeRing();
        if (this.opts.stars) this._initStars();
        this._initControls();
        this._initResize();

        this._clock = new THREE.Clock();
        this._animate = this._animate.bind(this);
        this._raf = requestAnimationFrame(this._animate);
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Feed a sampled/fetched profile. Each density shell picks its local
     * ρ via nearest-neighbour in altitude and re-opacities.
     */
    setProfile(profile) {
        if (!profile?.samples?.length) return;
        this._profile = profile;

        const logRhos = this._shells.map(sh => {
            const rho = _nearestRho(profile.samples, sh.userData.altKm);
            sh.userData.rho = rho;
            return Math.log10(Math.max(rho, 1e-30));
        });
        const maxLR = Math.max(...logRhos);
        const minLR = Math.min(...logRhos);
        const span = Math.max(maxLR - minLR, 1.0);

        for (let i = 0; i < this._shells.length; i++) {
            const t = (logRhos[i] - minLR) / span;       // 0 (thin) … 1 (dense)
            const base = new THREE.Color(this._shells[i].userData.baseColor);
            base.lerp(new THREE.Color(0xffffff), 0.25 + 0.35 * t);
            this._shells[i].material.color.copy(base);
            this._shells[i].material.opacity = 0.05 + t * 0.25;
        }

        if (this._currentAltKm != null) this.setAltitude(this._currentAltKm);
    }

    /**
     * Move the highlighted cyan ring to a new altitude (km) and
     * recolour it by local ρ.
     */
    setAltitude(altitudeKm) {
        this._currentAltKm = altitudeKm;
        const r = 1 + altitudeKm / R_EARTH_KM;
        this._ring.scale.set(r, r, r);

        let rho = 0;
        if (this._profile) rho = _nearestRho(this._profile.samples, altitudeKm);
        const logR = Math.log10(Math.max(rho, 1e-30));
        const t = Math.max(0, Math.min(1, (logR + 20) / 16));
        const cold = new THREE.Color(0x8040ff);
        const warm = new THREE.Color(0x00ffd8);
        this._ring.material.color.copy(cold.lerp(warm, t));
        this._ring.material.opacity = 0.55 + t * 0.40;
    }

    /**
     * Drive the aurora shader from current space-weather state. Aurora
     * only visible when Ap > ~20 (roughly Kp≥4); below that it fades to
     * nothing.
     */
    setState({ f107 = 150, ap = 15 } = {}) {
        this._state = { f107, ap };
        if (!this._skin) return;

        // Map Ap to a Kp-ish value (approximate — Ap = 15 ≈ Kp 3).
        // Full scale: Ap 400 ≈ Kp 9 (extreme storm).
        const kp = Math.min(9, Math.max(0, Math.log2(Math.max(ap, 1) / 2) + 2));
        const auroraAW = Math.max(0, Math.min(1, (ap - 15) / 200));

        this._skin.setSpaceWeather({
            kp,
            auroraOn: auroraAW > 0.02,
            auroraAW,
            bzSouth: 0,
            xray: 0,
            dstNorm: 0,
        });
    }

    /**
     * Toggle overlay groups.
     */
    setVisibility({ satellites = true, shells = true, rings = true } = {}) {
        if (this._satGroup)   this._satGroup.visible   = satellites;
        if (this._shellGroup) this._shellGroup.visible = shells;
        if (this._layerGroup) this._layerGroup.visible = rings;
    }

    dispose() {
        cancelAnimationFrame(this._raf);
        this._resizeObs?.disconnect();
        this._controls?.dispose();
        this._scene.traverse(o => {
            if (o.geometry) o.geometry.dispose?.();
            if (o.material) {
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                for (const m of mats) {
                    for (const k of Object.keys(m.uniforms || {})) {
                        const v = m.uniforms[k]?.value;
                        if (v && typeof v.dispose === "function") v.dispose();
                    }
                    m.dispose?.();
                }
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
        this._renderer.setClearColor(0x030012, 1);
    }

    _initScene() {
        this._scene = new THREE.Scene();
        const { clientWidth: w, clientHeight: h } = this.canvas;
        const aspect = Math.max(w / Math.max(h, 1), 1);
        this._camera = new THREE.PerspectiveCamera(40, aspect, 0.01, 1000);
        this._camera.position.set(0, 0.6, this.opts.cameraDistance);

        // Sun direction — mostly from +X with a slight northern tilt.
        // Used by EarthSkin and by subsequent setState() recomputations.
        this._sunDir = new THREE.Vector3(1, 0.35, 0.2).normalize();
    }

    _buildEarth() {
        // Reuse the shared EarthSkin stack so the globe looks identical
        // to earth.html: day/night, ocean specular, topology, atmosphere
        // rim glow, aurora. Clouds intentionally off — the upper-
        // atmosphere page is about what's *above* the troposphere.
        this._skin = new EarthSkin(this._scene, this._sunDir, {
            radius: 1.0,
            icoLevel: 5,
            clouds: false,
            atmosphere: true,
            aurora: true,
        });
        // Fire-and-forget texture load. Scene renders with the safe
        // gray fallback until the CDN responds.
        this._skin.loadTextures().catch(() => {});

        // EarthSkin shader handles its own lighting (sun_dir uniform) so
        // we don't add a DirectionalLight. Still add a faint ambient so
        // the tori look right on the dark side.
        this._scene.add(new THREE.AmbientLight(0x334466, 0.3));
    }

    _buildShells() {
        this._shells = [];
        this._shellGroup = new THREE.Group();
        for (const def of DENSITY_SHELLS) {
            const r = 1 + def.altKm / R_EARTH_KM;
            const mat = new THREE.MeshBasicMaterial({
                color: def.baseColor,
                transparent: true,
                opacity: 0.10,
                side: THREE.BackSide,
                depthWrite: false,
            });
            const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 48, 48), mat);
            mesh.userData = { altKm: def.altKm, baseColor: def.baseColor };
            this._shells.push(mesh);
            this._shellGroup.add(mesh);
        }
        this._scene.add(this._shellGroup);
    }

    _buildLayerRings() {
        // Thin tori at key atmospheric-regime boundaries. They read as
        // equatorial discs rather than full shells so they don't compete
        // visually with the density shells.
        this._layerGroup = new THREE.Group();
        for (const def of LAYER_BOUNDARY_RINGS) {
            const r = 1 + def.altKm / R_EARTH_KM;
            const ring = _ringMesh(r, 0.003, def.color, def.opacity);
            ring.userData = { altKm: def.altKm, id: def.id };
            this._layerGroup.add(ring);
        }
        this._scene.add(this._layerGroup);
    }

    _buildSatelliteRings() {
        this._satGroup = new THREE.Group();
        this._satRings = [];
        for (const sat of SATELLITE_REFERENCES) {
            const r = 1 + sat.altitudeKm / R_EARTH_KM;
            // Slight tilt per ring so they don't all overlap on one plane.
            const tilt = (sat.altitudeKm % 31) * Math.PI / 180;
            const ring = _ringMesh(r, 0.004, _hex(sat.color), 0.75);
            ring.rotation.x = Math.PI / 2 + tilt * 0.05;
            ring.rotation.y = tilt * 0.8;
            ring.userData = { altKm: sat.altitudeKm, id: sat.id, name: sat.name };
            this._satRings.push(ring);
            this._satGroup.add(ring);
        }
        this._scene.add(this._satGroup);
    }

    _buildAltitudeRing() {
        this._ring = _ringMesh(1, 0.0045, 0x00ffe6, 0.85);
        this._ring.rotation.x = Math.PI / 2;
        this._ring.rotation.y = 0.4;
        this._scene.add(this._ring);
    }

    _initStars() {
        const n = 2500;
        const positions = new Float32Array(n * 3);
        const colors = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            const theta = 2 * Math.PI * Math.random();
            const phi   = Math.acos(1 - 2 * Math.random());
            const R = 220 + 120 * Math.random();
            positions[i * 3 + 0] = R * Math.sin(phi) * Math.cos(theta);
            positions[i * 3 + 1] = R * Math.cos(phi);
            positions[i * 3 + 2] = R * Math.sin(phi) * Math.sin(theta);
            // Slight warm/cool variation.
            const shade = 0.75 + 0.25 * Math.random();
            colors[i * 3 + 0] = shade;
            colors[i * 3 + 1] = shade * (0.85 + 0.15 * Math.random());
            colors[i * 3 + 2] = shade * (0.95 + 0.08 * Math.random());
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geom.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
        const mat = new THREE.PointsMaterial({
            size: 1.2,
            sizeAttenuation: false,
            vertexColors: true,
            transparent: true,
            opacity: 0.9,
        });
        this._scene.add(new THREE.Points(geom, mat));
    }

    _initControls() {
        this._controls = new OrbitControls(this._camera, this.canvas);
        this._controls.enableDamping = true;
        this._controls.dampingFactor = 0.08;
        this._controls.minDistance = 1.25;
        this._controls.maxDistance = 14;
        this._controls.enablePan = false;
        this._controls.rotateSpeed = 0.55;
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

    _animate() {
        this._raf = requestAnimationFrame(this._animate);
        const t = this._clock.getElapsedTime();

        if (this._skin) this._skin.update(t);

        // Slow auto-rotation when user isn't actively dragging.
        if (this.opts.autoRotate && this._skin && !this._controls.dragging) {
            this._skin.earthMesh.rotation.y += 0.0010;
            if (this._shellGroup) this._shellGroup.rotation.y += 0.00045;
            if (this._layerGroup) this._layerGroup.rotation.y += 0.00045;
            if (this._satGroup)   this._satGroup.rotation.y   += 0.00060;
        }

        this._controls.update();
        this._renderer.render(this._scene, this._camera);
    }
}

// ── Utilities ──────────────────────────────────────────────────────────────

function _nearestRho(samples, altitudeKm) {
    let lo = 0, hi = samples.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (samples[mid].altitudeKm < altitudeKm) lo = mid + 1;
        else hi = mid;
    }
    const a = samples[Math.max(0, lo - 1)];
    const b = samples[lo];
    return Math.abs(a.altitudeKm - altitudeKm) < Math.abs(b.altitudeKm - altitudeKm)
        ? a.rho
        : b.rho;
}

function _ringMesh(radius, tubeRadius, colorHex, opacity = 0.75) {
    const geom = new THREE.TorusGeometry(radius, tubeRadius, 12, 160);
    const mat = new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity,
        depthWrite: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.rotation.x = Math.PI / 2;
    return mesh;
}

function _hex(colorStr) {
    if (typeof colorStr === "number") return colorStr;
    if (!colorStr) return 0xffffff;
    return parseInt(colorStr.replace("#", ""), 16);
}
