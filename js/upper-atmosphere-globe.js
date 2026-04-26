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
 *   • gradient shells × 5 (mesosphere → outer exosphere)
 *                                                  fresnel halo, inner→outer
 *                                                  colour gradient, opacity
 *                                                  driven by local log(ρ)
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
import { computeShue, computeBowShock } from './magnetosphere-engine.js';

// NOAA SWPC Kp→Ap table, used to invert Ap back to Kp for the aurora
// shader. The shader's own oval-geometry code wants Kp, not Ap.
const _KP_TO_AP = [0, 3, 7, 15, 27, 48, 80, 140, 240, 400];

function apToKp(ap) {
    if (!Number.isFinite(ap) || ap <= 0) return 0;
    for (let i = 0; i < _KP_TO_AP.length - 1; i++) {
        const a = _KP_TO_AP[i], b = _KP_TO_AP[i + 1];
        if (ap < b) return i + (ap - a) / (b - a);
    }
    return 9;
}

const R_EARTH_KM = 6371;

// ── Gradient layer shells ──────────────────────────────────────────────────
// Five concentric translucent shells, one per physical regime the page
// distinguishes within the 80–2000 km band. Each shell is a back-side
// sphere at the layer's outer altitude, rendered with a custom GLSL
// shader that paints a fresnel-driven limb glow whose colour gradients
// from `colorLow` (layer floor) to `colorHigh` (layer top). Per-shell
// opacity is driven by local log(ρ) so the visual reads as data, not
// decoration: dense regimes glow brighter; the rarefied outer exosphere
// fades to a faint halo.
//
// `peakKm` is the altitude where we sample the profile to scale
// brightness; usually the layer's mid-point on a log-altitude scale so
// the thermosphere's wide vertical range still has a stable peak.
const LAYER_SHELLS = [
    {
        id:         "mesosphere",
        name:       "Mesosphere",
        minKm:       50, maxKm:   85,  peakKm:   80,
        colorLow:   0x6e9bff, colorHigh: 0x9cc3ff,
        baseAlpha:  0.22, rimPower: 2.4,
    },
    {
        id:         "lower-thermosphere",
        name:       "Lower Thermosphere",
        minKm:       85, maxKm:  250,  peakKm:  170,
        colorLow:   0xff7a3d, colorHigh: 0xffb060,
        baseAlpha:  0.30, rimPower: 2.8,
    },
    {
        id:         "upper-thermosphere",
        name:       "Upper Thermosphere",
        minKm:      250, maxKm:  600,  peakKm:  420,
        colorLow:   0xffa050, colorHigh: 0xffe0a0,
        baseAlpha:  0.22, rimPower: 3.0,
    },
    {
        id:         "inner-exosphere",
        name:       "Inner Exosphere",
        minKm:      600, maxKm: 1200,  peakKm:  900,
        colorLow:   0xb672ff, colorHigh: 0xe2a8ff,
        baseAlpha:  0.16, rimPower: 3.2,
    },
    {
        id:         "outer-exosphere",
        name:       "Outer Exosphere",
        minKm:     1200, maxKm: 2000,  peakKm: 1600,
        colorLow:   0x7a3dff, colorHigh: 0xb47cff,
        baseAlpha:  0.10, rimPower: 3.6,
    },
];

// ── Layer-shell GLSL ───────────────────────────────────────────────────────
// Vert: pass world-space position + normal so the fragment shader can
// compute view-direction fresnel against the camera.
const LAYER_VERT = /* glsl */`
    varying vec3 vWorldPos;
    varying vec3 vWorldNormal;
    void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos    = wp.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position  = projectionMatrix * viewMatrix * wp;
    }
`;

// Frag: limb-darkened fresnel halo with a colour gradient from
// uColorLow (centre / layer floor) to uColorHigh (limb / layer top).
// uIntensity couples the brightness to local log(rho) and uStorm adds
// a warm tint when geomagnetic forcing rises (the thermosphere literally
// inflates and heats during storms — colouring it conveys that).
const LAYER_FRAG = /* glsl */`
    uniform vec3  uCameraPos;
    uniform vec3  uColorLow;
    uniform vec3  uColorHigh;
    uniform float uOpacity;
    uniform float uIntensity;
    uniform float uRimPower;
    uniform float uStorm;
    varying vec3  vWorldPos;
    varying vec3  vWorldNormal;
    void main() {
        vec3 V = normalize(uCameraPos - vWorldPos);
        // BackSide rendering: flip the normal so fresnel peaks at the
        // limb when seen from outside the planet.
        vec3 N = -normalize(vWorldNormal);
        float NV = clamp(dot(N, V), 0.0, 1.0);
        float rim = pow(1.0 - NV, uRimPower);

        // Inner -> outer colour blend follows the rim term: centre of
        // the visible shell shows uColorLow (layer floor), the limb
        // shows uColorHigh (layer top). A gentle latitude darkening
        // mimics density falloff toward the polar cusps.
        float lat = abs(normalize(vWorldPos).y);
        vec3 col = mix(uColorLow, uColorHigh, rim);
        col = mix(col, col * 0.78, lat * 0.35);

        // Storm warming: push hue toward orange-red as Ap rises.
        col = mix(col, vec3(1.0, 0.55, 0.25), uStorm * 0.45 * (0.4 + 0.6 * rim));

        float alpha = uOpacity * uIntensity * (0.10 + 0.90 * rim);
        gl_FragColor = vec4(col, alpha);
    }
`;

// ── Solar wind & magnetosphere boundaries ─────────────────────────────────
// Climatological defaults — used when no live data is available so the
// page still shows a meaningful magnetosphere from first paint.
const SW_DEFAULTS = Object.freeze({
    speed:   400,   // km/s
    density:   5,   // cm^-3
    bz:        0,   // nT (GSM, +north)
});

// Shue-1998 profile builder — re-implemented locally rather than imported
// (kept as a private helper inside magnetosphere-engine.js). Returns an
// array of THREE.Vector2 in the (transverse-radius, sun-axis) plane;
// LatheGeometry revolves around Y so we orient the parent group so local
// +Y aligns with the sun direction.
function _shueProfile(r0, alpha, nPts = 80) {
    const thetaMax = Math.PI * 0.87;
    const pts = [];
    for (let i = 0; i <= nPts; i++) {
        const theta = (i / nPts) * thetaMax;
        const r = r0 * Math.pow(2 / (1 + Math.cos(theta)), alpha);
        pts.push(new THREE.Vector2(
            r * Math.sin(theta),   // X = transverse radius from sun axis
            r * Math.cos(theta),   // Y = distance along sun axis
        ));
    }
    return pts;
}

// Fresnel shader for magnetopause / bow shock. Limb-bright, additive,
// double-sided so users see the surface from any angle.
const SW_VERT = /* glsl */`
    varying vec3 vNormal;
    varying vec3 vViewDir;
    void main() {
        vec4 mvp = modelViewMatrix * vec4(position, 1.0);
        vNormal  = normalize(normalMatrix * normal);
        vViewDir = normalize(-mvp.xyz);
        gl_Position = projectionMatrix * mvp;
    }
`;
const SW_FRAG = /* glsl */`
    precision highp float;
    uniform vec3  uColor;
    uniform vec3  uRimColor;
    uniform float uBaseAlpha;
    uniform float uRimPower;
    uniform float uIntensity;
    uniform float uTime;
    varying vec3  vNormal;
    varying vec3  vViewDir;
    void main() {
        float NdV = abs(dot(normalize(vNormal), normalize(vViewDir)));
        float fres = pow(1.0 - NdV, uRimPower);
        vec3 col = mix(uColor, uRimColor, fres);
        // Slow breathing pulse — magnetopause "flutter" hint.
        float pulse = 1.0 + 0.08 * sin(uTime * 0.6);
        float alpha = (uBaseAlpha + fres * 0.35) * pulse * uIntensity;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.85));
    }
`;

// Solar-wind flux streamer: animated dashed strip flowing along -Y in
// the solar group's local frame (i.e., from sun toward Earth). The
// stripe's brightness modulates with dynamic pressure via uIntensity.
const SW_STREAM_VERT = /* glsl */`
    attribute float aProgress;     // 0..1 along the streamer
    varying float vProgress;
    void main() {
        vProgress = aProgress;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;
const SW_STREAM_FRAG = /* glsl */`
    precision highp float;
    uniform vec3  uColor;
    uniform float uTime;
    uniform float uIntensity;
    uniform float uSpeed;
    varying float vProgress;
    void main() {
        // Travelling dash pattern — brighter "particle" packets sweep
        // toward Earth at a rate scaled by the solar-wind speed.
        float t = vProgress + uTime * uSpeed;
        float dash = pow(0.5 + 0.5 * sin(t * 18.0), 4.0);
        // Fade in as we approach Earth (head of the streamer).
        float headFade = pow(vProgress, 0.6);
        float alpha = uIntensity * dash * headFade;
        gl_FragColor = vec4(uColor, alpha);
    }
`;

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
        this._buildLayerShells();
        this._buildSatelliteRings();
        this._buildAltitudeRing();
        this._buildSolarWind();
        if (this.opts.stars) this._initStars();
        this._initControls();
        this._initResize();
        this._initTooltip();

        this._clock = new THREE.Clock();
        this._animate = this._animate.bind(this);
        this._raf = requestAnimationFrame(this._animate);
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Feed a sampled/fetched profile. Each gradient shell normalises its
     * intensity uniform against the in-band density range so the visual
     * tracks the data without dynamic-range collapse.
     */
    setProfile(profile) {
        if (!profile?.samples?.length) return;
        this._profile = profile;

        // Sample log(ρ) at each shell's reference altitude. The min/max
        // of the *current* profile defines the dynamic range — this way
        // a quiet preset and a G5-storm preset both light up the shells
        // proportionally without saturating one or going invisible in the
        // other.
        const logRhos = this._shells.map(sh => {
            const rho = _nearestRho(profile.samples, sh.userData.peakKm);
            sh.userData.rho = rho;
            return Math.log10(Math.max(rho, 1e-30));
        });
        const maxLR = Math.max(...logRhos);
        const minLR = Math.min(...logRhos);
        const span = Math.max(maxLR - minLR, 1.0);

        for (let i = 0; i < this._shells.length; i++) {
            const t = (logRhos[i] - minLR) / span;   // 0 (thin) … 1 (dense)
            // Compress so even the rarefied outer exosphere keeps a
            // visible halo, but dense regimes still pop.
            const intensity = 0.35 + 0.85 * t;
            this._shells[i].material.uniforms.uIntensity.value = intensity;
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
     * Drive the aurora shader from current space-weather state. The
     * EarthSkin shader takes raw Kp + bzSouth and does its own oval-
     * geometry math (equatorward shift + width growth with Kp); the
     * caller only has to pass faithful values.
     *
     * `bzSouth` is optional — when omitted we synthesise a proxy from
     * Ap so the storm presets still widen the oval realistically.
     * `dstNorm` is likewise synthesised when not provided (Dst correlates
     * strongly with Ap during substorms).
     */
    setState({ f107 = 150, ap = 15, bz = null } = {}) {
        this._state = { f107, ap, bz };
        if (!this._skin) return;

        // Canonical SWPC Kp↔Ap inversion (not the old log2 approximation).
        const kp = apToKp(ap);

        // bzSouth is a [0..1] normalised "southward-ness" indicator used
        // by the shader to boost storm effects. When we don't have live
        // IMF data, approximate from Ap — values of 1 at Ap ≈ 80 (G3),
        // saturating at Ap ≥ 140 (G4+).
        let bzSouth;
        if (Number.isFinite(bz)) {
            // +bz = northward (suppresses aurora); -bz = southward
            // (enhances). Clamp magnitude to [0..1] at |Bz| = 30 nT.
            bzSouth = Math.max(0, Math.min(1, -bz / 30));
        } else {
            bzSouth = Math.max(0, Math.min(1, (ap - 15) / 100));
        }

        // Overall auroral power envelope. Off at quiet time, fully on
        // by Ap ~80 (G3). Shader multiplies by this; oval width also
        // scales with Kp so the two work together.
        const auroraAW = Math.max(0, Math.min(1, (ap - 12) / 110));

        // Dst proxy: linearly negative with Ap; normalised to
        // [-1..0] where -1 ≈ Ap 300 (G4-G5). Shader uses it for
        // ring-current effects not modelled here.
        const dstNorm = -Math.max(0, Math.min(1, ap / 300));

        this._skin.setSpaceWeather({
            kp,
            auroraOn: auroraAW > 0.02 ? 1 : 0,
            auroraAW,
            bzSouth,
            xray: 0,
            dstNorm,
        });

        // Storm warming for the gradient layer shells. Same envelope as
        // auroraAW so the colour shift stays in lock-step with the oval.
        if (this._shells) {
            for (const sh of this._shells) {
                sh.material.uniforms.uStorm.value = auroraAW;
            }
        }
    }

    /**
     * Toggle overlay groups.
     */
    setVisibility({ satellites = true, shells = true, solarWind = true } = {}) {
        if (this._satGroup)   this._satGroup.visible   = satellites;
        if (this._shellGroup) this._shellGroup.visible = shells;
        if (this._swGroup)    this._swGroup.visible    = solarWind;
    }

    /**
     * Drive the solar-wind / magnetospheric boundaries from upstream
     * plasma state. Recomputes the Shue-1998 magnetopause and Farris-
     * Russell bow shock standoff distances and rebuilds the lathe
     * geometries in place; updates streamer brightness from dynamic
     * pressure.
     *
     * @param {object} sw
     * @param {number} [sw.speed=400]    solar wind bulk speed (km/s)
     * @param {number} [sw.density=5]    proton density (cm^-3)
     * @param {number} [sw.bz=0]         IMF Bz GSM (nT, +north)
     */
    setSolarWind(sw = {}) {
        const speed   = Number.isFinite(sw.speed)   ? sw.speed   : SW_DEFAULTS.speed;
        const density = Number.isFinite(sw.density) ? sw.density : SW_DEFAULTS.density;
        const bz      = Number.isFinite(sw.bz)      ? sw.bz      : SW_DEFAULTS.bz;
        this._swState = { speed, density, bz };

        const mp = computeShue(density, speed, bz);
        const bs = computeBowShock(mp.r0, mp.alpha);
        this._swGeometry = { mp, bs };

        // Rebuild the magnetopause + bow-shock lathe geometries in place
        // (cheap — ~80 segments) so the standoff tracks live data.
        if (this._mpMesh) {
            const profile = _shueProfile(mp.r0, mp.alpha, 64);
            this._mpMesh.geometry.dispose();
            this._mpMesh.geometry = new THREE.LatheGeometry(profile, 56);
            this._mpMesh.userData.r0    = mp.r0;
            this._mpMesh.userData.alpha = mp.alpha;
        }
        if (this._bsMesh) {
            const profile = _shueProfile(bs.r0, bs.alpha, 64);
            this._bsMesh.geometry.dispose();
            this._bsMesh.geometry = new THREE.LatheGeometry(profile, 56);
            this._bsMesh.userData.r0    = bs.r0;
            this._bsMesh.userData.alpha = bs.alpha;
        }
        if (this._sheathMesh) {
            const profile = _shueProfile(bs.r0, bs.alpha, 48);
            this._sheathMesh.geometry.dispose();
            this._sheathMesh.geometry = new THREE.LatheGeometry(profile, 36);
        }

        // Streamer + magnetopause brightness scales with dynamic pressure;
        // a southward IMF (Bz < 0) brightens reconnection cues by warming
        // the magnetopause toward red.
        const pdyn = mp.pdyn;                              // nPa
        const pdynNorm = Math.max(0, Math.min(1, (pdyn - 0.5) / 8));
        const bzWarm = Math.max(0, Math.min(1, -bz / 12)); // 0..1 as Bz goes negative

        if (this._streamMat) {
            this._streamMat.uniforms.uIntensity.value = 0.35 + 0.85 * pdynNorm;
            this._streamMat.uniforms.uSpeed.value     = 0.05 + (speed / 800) * 0.30;
            const cool = new THREE.Color(0x6cc8ff);
            const hot  = new THREE.Color(0xff7a3a);
            const c = cool.clone().lerp(hot, pdynNorm);
            this._streamMat.uniforms.uColor.value.copy(c);
        }
        if (this._mpMat) {
            this._mpMat.uniforms.uIntensity.value = 0.7 + 0.5 * pdynNorm;
            const calm  = new THREE.Color(0x60d8ff);
            const storm = new THREE.Color(0xff7a90);
            this._mpMat.uniforms.uColor.value.copy(calm.clone().lerp(storm, bzWarm));
        }
        if (this._bsMat) {
            this._bsMat.uniforms.uIntensity.value = 0.7 + 0.5 * pdynNorm;
        }
        if (this._sheathMat) {
            this._sheathMat.opacity = 0.05 + 0.10 * pdynNorm;
        }
    }

    dispose() {
        cancelAnimationFrame(this._raf);
        this._resizeObs?.disconnect();
        this._controls?.dispose();
        this._disposeHover?.();
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

    _buildLayerShells() {
        // Build the five gradient layer shells back-to-front (outermost
        // first) and assign explicit `renderOrder` so the additive
        // compositing stacks correctly even when transparent-sort
        // disagrees with our intent.
        this._shells = [];
        this._shellGroup = new THREE.Group();

        const ordered = [...LAYER_SHELLS].sort((a, b) => b.maxKm - a.maxKm);
        let renderOrder = 0;
        for (const def of ordered) {
            // Outer radius of the shell (in Earth radii).
            const r = 1 + def.maxKm / R_EARTH_KM;
            const mat = new THREE.ShaderMaterial({
                vertexShader:   LAYER_VERT,
                fragmentShader: LAYER_FRAG,
                uniforms: {
                    uCameraPos: { value: this._camera.position.clone() },
                    uColorLow:  { value: new THREE.Color(def.colorLow) },
                    uColorHigh: { value: new THREE.Color(def.colorHigh) },
                    uOpacity:   { value: def.baseAlpha },
                    uIntensity: { value: 0.7 },
                    uRimPower:  { value: def.rimPower },
                    uStorm:     { value: 0 },
                },
                transparent: true,
                side: THREE.BackSide,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
            });
            const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 64, 48), mat);
            mesh.renderOrder = renderOrder++;
            mesh.userData = {
                kind:    'layer-shell',
                id:      def.id,
                name:    def.name,
                minKm:   def.minKm,
                maxKm:   def.maxKm,
                peakKm:  def.peakKm,
                altKm:   def.peakKm,                  // for tooltip ρ readout
                color:   `#${def.colorHigh.toString(16).padStart(6, '0')}`,
            };
            this._shells.push(mesh);
            this._shellGroup.add(mesh);
        }
        this._scene.add(this._shellGroup);
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
            ring.userData = {
                kind: 'satellite',
                altKm: sat.altitudeKm,
                id: sat.id,
                name: sat.name,
                color: sat.color,
            };
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

    _buildSolarWind() {
        // Sun-aligned group — local +Y points along the sun direction so
        // LatheGeometry's axis of revolution matches the sun-Earth line.
        // We orient with a quaternion that maps (0,1,0) → _sunDir.
        this._swGroup = new THREE.Group();
        this._swGroup.name = 'solarWind';
        const yAxis = new THREE.Vector3(0, 1, 0);
        const q = new THREE.Quaternion().setFromUnitVectors(yAxis, this._sunDir);
        this._swGroup.quaternion.copy(q);

        // Initial standoff distances (climatology — refined when
        // setSolarWind() lands).
        const mp0 = computeShue(SW_DEFAULTS.density, SW_DEFAULTS.speed, SW_DEFAULTS.bz);
        const bs0 = computeBowShock(mp0.r0, mp0.alpha);
        this._swGeometry = { mp: mp0, bs: bs0 };

        // ── Magnetosheath fill (between bow shock and magnetopause) ─────
        const sheathProfile = _shueProfile(bs0.r0, bs0.alpha, 48);
        const sheathGeo = new THREE.LatheGeometry(sheathProfile, 36);
        this._sheathMat = new THREE.MeshBasicMaterial({
            color:       0xff9944,
            transparent: true,
            opacity:     0.07,
            side:        THREE.BackSide,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });
        this._sheathMesh = new THREE.Mesh(sheathGeo, this._sheathMat);
        this._sheathMesh.renderOrder = 2;
        this._sheathMesh.userData = {
            kind:    'magnetosheath',
            id:      'magnetosheath',
            name:    'Magnetosheath',
            tooltip: 'Compressed, heated solar-wind plasma between the bow shock and the magnetopause.',
        };
        this._swGroup.add(this._sheathMesh);

        // ── Bow shock surface (Farris-Russell) ──────────────────────────
        const bsProfile = _shueProfile(bs0.r0, bs0.alpha, 64);
        const bsGeo = new THREE.LatheGeometry(bsProfile, 56);
        this._bsMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor:     { value: new THREE.Color(0xffc070) },
                uRimColor:  { value: new THREE.Color(0xfff0a8) },
                uBaseAlpha: { value: 0.04 },
                uRimPower:  { value: 2.6 },
                uIntensity: { value: 1.0 },
                uTime:      { value: 0 },
            },
            vertexShader:   SW_VERT,
            fragmentShader: SW_FRAG,
            transparent:    true,
            side:           THREE.DoubleSide,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });
        this._bsMesh = new THREE.Mesh(bsGeo, this._bsMat);
        this._bsMesh.renderOrder = 3;
        this._bsMesh.userData = {
            kind:    'bow-shock',
            id:      'bow-shock',
            name:    'Bow Shock',
            r0:      bs0.r0,
            alpha:   bs0.alpha,
            tooltip: 'Where supersonic solar wind decelerates to subsonic on impact with the magnetosphere (Farris–Russell).',
        };
        this._swGroup.add(this._bsMesh);

        // ── Magnetopause surface (Shue-1998) ────────────────────────────
        const mpProfile = _shueProfile(mp0.r0, mp0.alpha, 64);
        const mpGeo = new THREE.LatheGeometry(mpProfile, 56);
        this._mpMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor:     { value: new THREE.Color(0x60d8ff) },
                uRimColor:  { value: new THREE.Color(0xc8f0ff) },
                uBaseAlpha: { value: 0.06 },
                uRimPower:  { value: 3.0 },
                uIntensity: { value: 1.0 },
                uTime:      { value: 0 },
            },
            vertexShader:   SW_VERT,
            fragmentShader: SW_FRAG,
            transparent:    true,
            side:           THREE.DoubleSide,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });
        this._mpMesh = new THREE.Mesh(mpGeo, this._mpMat);
        this._mpMesh.renderOrder = 4;
        this._mpMesh.userData = {
            kind:    'magnetopause',
            id:      'magnetopause',
            name:    'Magnetopause',
            r0:      mp0.r0,
            alpha:   mp0.alpha,
            tooltip: 'Boundary where Earth\'s magnetic pressure balances solar-wind dynamic pressure (Shue-1998).',
        };
        this._swGroup.add(this._mpMesh);

        // ── Flux streamers — incoming solar wind ────────────────────────
        // A small cluster of dashed line strips converging from the
        // sunward hemisphere toward Earth. They sit "in front of" the
        // bow shock so they're visible at moderate zoom levels.
        this._streamMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor:     { value: new THREE.Color(0x6cc8ff) },
                uTime:      { value: 0 },
                uIntensity: { value: 0.6 },
                uSpeed:     { value: 0.18 },
            },
            vertexShader:   SW_STREAM_VERT,
            fragmentShader: SW_STREAM_FRAG,
            transparent:    true,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });
        this._streamGroup = new THREE.Group();
        this._streamGroup.name = 'fluxStreamers';
        const streamerStarts = _streamerStartPoints(8, bs0.r0 + 4);
        for (const s of streamerStarts) {
            const positions = new Float32Array(2 * 3);
            const progress  = new Float32Array(2);
            // Streamer goes from far-sunward (y = s.y) toward Earth
            // (y ~ bs.r0). Both points are in the solar group's local
            // frame; we'll +Y == sunward by group orientation.
            const yEnd = bs0.r0 * 0.95;
            positions[0] = s.x; positions[1] = s.y; positions[2] = s.z;
            positions[3] = s.x * 0.20; positions[4] = yEnd; positions[5] = s.z * 0.20;
            progress[0] = 0;
            progress[1] = 1;
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position',  new THREE.BufferAttribute(positions, 3));
            geom.setAttribute('aProgress', new THREE.BufferAttribute(progress, 1));
            const line = new THREE.Line(geom, this._streamMat);
            line.userData = {
                kind:    'flux-stream',
                id:      'flux-stream',
                name:    'Solar-wind flux',
                tooltip: 'Bulk plasma flow from the Sun. Brightness ∝ dynamic pressure ρv²; flow rate ∝ speed.',
            };
            this._streamGroup.add(line);
        }
        this._swGroup.add(this._streamGroup);

        // ── Sun marker — small disc far up the sun line so users have ──
        // ── a visual reference for "this way is sunward". ──────────────
        const sunGeo = new THREE.SphereGeometry(0.6, 18, 14);
        const sunMat = new THREE.MeshBasicMaterial({
            color:       0xffe080,
            transparent: true,
            opacity:     0.85,
            blending:    THREE.AdditiveBlending,
            depthWrite:  false,
        });
        this._sunMarker = new THREE.Mesh(sunGeo, sunMat);
        this._sunMarker.position.set(0, bs0.r0 + 8, 0);
        this._sunMarker.userData = {
            kind:    'sun-marker',
            id:      'sun',
            name:    'Sun (direction)',
            tooltip: 'Direction toward the Sun. Solar wind streams from here.',
        };
        this._swGroup.add(this._sunMarker);

        this._scene.add(this._swGroup);

        // Apply climatology so first paint shows non-default state if
        // the engine already has a feel for this. setSolarWind() is also
        // called externally once SwpcFeed pushes real data.
        this.setSolarWind(SW_DEFAULTS);
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
        // Bumped from 14 → 28 so users can pull back far enough to see
        // the bow shock + magnetopause in full. Atmosphere-shell visuals
        // remain sized to Earth radii so they don't grow with zoom.
        this._controls.maxDistance = 28;
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

    _initTooltip() {
        // Build the tooltip DOM once. Positioned absolutely inside the
        // canvas's parent so it follows the mouse; hidden by default.
        const parent = this.canvas.parentElement;
        if (!parent) return;
        // Ensure the parent is a positioning context.
        if (getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }
        const tip = document.createElement('div');
        tip.className = 'ua-tooltip';
        tip.style.cssText = `
            position:absolute; pointer-events:none;
            background:rgba(8,4,22,.92);
            border:1px solid rgba(0,200,200,.35);
            border-radius:6px;
            padding:6px 9px;
            font: 11px system-ui, sans-serif;
            color:#cde;
            box-shadow: 0 2px 14px rgba(0,0,0,.6);
            transform: translate(-50%, -110%);
            white-space: nowrap;
            opacity: 0; transition: opacity 90ms;
            z-index: 10;
        `;
        parent.appendChild(tip);
        this._tip = tip;

        this._raycaster = new THREE.Raycaster();
        // Thicker hit area than the visual torus — makes these thin rings
        // actually catchable with the mouse.
        this._raycaster.params.Line = { threshold: 0.02 };
        this._mouse = new THREE.Vector2(-9, -9);

        const hittable = () => [
            ...(this._satRings   || []),
            ...(this._shells     || []),
            ...(this._mpMesh     ? [this._mpMesh]     : []),
            ...(this._bsMesh     ? [this._bsMesh]     : []),
            ...(this._sheathMesh ? [this._sheathMesh] : []),
            ...(this._sunMarker  ? [this._sunMarker]  : []),
        ];

        const onMove = (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            this._mouse.x = (x / rect.width)  *  2 - 1;
            this._mouse.y = (y / rect.height) * -2 + 1;
            this._raycaster.setFromCamera(this._mouse, this._camera);
            const hits = this._raycaster.intersectObjects(hittable(), false);
            if (hits.length > 0) {
                const ud = hits[0].object.userData || {};
                tip.innerHTML = _tipHTML(ud, this._profile, this._swState);
                tip.style.left = `${x}px`;
                tip.style.top  = `${y}px`;
                tip.style.opacity = '1';
                this.canvas.style.cursor = 'pointer';
            } else {
                tip.style.opacity = '0';
                this.canvas.style.cursor = 'grab';
            }
        };
        const onLeave = () => {
            tip.style.opacity = '0';
            this.canvas.style.cursor = 'grab';
        };
        this.canvas.addEventListener('mousemove', onMove);
        this.canvas.addEventListener('mouseleave', onLeave);
        this._disposeHover = () => {
            this.canvas.removeEventListener('mousemove', onMove);
            this.canvas.removeEventListener('mouseleave', onLeave);
            tip.remove();
        };
    }

    _animate() {
        this._raf = requestAnimationFrame(this._animate);
        const t = this._clock.getElapsedTime();

        if (this._skin) this._skin.update(t);

        // Slow auto-rotation when user isn't actively dragging.
        if (this.opts.autoRotate && this._skin && !this._controls.dragging) {
            this._skin.earthMesh.rotation.y += 0.0010;
            if (this._shellGroup) this._shellGroup.rotation.y += 0.00045;
            if (this._satGroup)   this._satGroup.rotation.y   += 0.00060;
        }

        // Push the live camera position into the shell shaders so their
        // limb fresnel tracks the current viewpoint.
        if (this._shells) {
            for (const sh of this._shells) {
                sh.material.uniforms.uCameraPos.value.copy(this._camera.position);
            }
        }

        // Solar-wind shaders: advance time for fresnel pulse + streamer
        // dash animation.
        if (this._mpMat)     this._mpMat.uniforms.uTime.value     = t;
        if (this._bsMat)     this._bsMat.uniforms.uTime.value     = t;
        if (this._streamMat) this._streamMat.uniforms.uTime.value = t;

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

// Distribute streamer launch points across the sunward hemisphere — a
// jittered fibonacci-style spiral on a half-sphere of radius `r`. Used
// to draw flux streamers with reasonable angular coverage without
// looking gridded.
function _streamerStartPoints(n, r) {
    const out = [];
    const phi = Math.PI * (3 - Math.sqrt(5));   // golden angle
    for (let i = 0; i < n; i++) {
        // Map i to [0..1] biased toward the sub-solar nose.
        const t = (i + 0.5) / n;
        const cosTheta = 1 - 0.55 * t;          // cap at ~56° from sun-axis
        const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
        const lon = i * phi;
        out.push({
            x: r * sinTheta * Math.cos(lon),
            y: r * cosTheta,                    // +Y == sunward in solar group
            z: r * sinTheta * Math.sin(lon),
        });
    }
    return out;
}

// Build the tooltip HTML for a hovered scene object. Picks the right
// data block (atmospheric ρ, solar-wind plasma state, satellite altitude,
// …) for the hovered kind so the tooltip is genuinely informative
// instead of just labelling the surface.
function _tipHTML(userData, profile, swState) {
    const colour = userData.color || '#0cc';

    let detail = '';
    let dataLines = '';
    switch (userData.kind) {
        case 'satellite':
            detail = `${userData.altKm} km · satellite shell`;
            if (profile?.samples?.length) {
                const rho = _nearestRho(profile.samples, userData.altKm);
                dataLines = `<div style="color:#889">ρ ≈ ${rho.toExponential(2)} kg/m³</div>`;
            }
            break;
        case 'layer-shell':
            detail = `${userData.minKm}–${userData.maxKm} km · atmospheric layer`;
            if (profile?.samples?.length) {
                const rho = _nearestRho(profile.samples, userData.altKm);
                dataLines = `<div style="color:#889">ρ ≈ ${rho.toExponential(2)} kg/m³ @ ${userData.peakKm} km</div>`;
            }
            break;
        case 'magnetopause':
            detail = `r₀ ≈ ${userData.r0?.toFixed(1) ?? '—'} R⊕ · α = ${userData.alpha?.toFixed(2) ?? '—'}`;
            if (swState) {
                const pdyn = (1.67e-6 * swState.density * swState.speed * swState.speed).toFixed(2);
                dataLines = `
                    <div style="color:#889">Pdyn ≈ ${pdyn} nPa · Bz ${swState.bz >= 0 ? '+' : ''}${swState.bz.toFixed(1)} nT</div>
                    <div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            } else {
                dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            }
            break;
        case 'bow-shock':
            detail = `r₀ ≈ ${userData.r0?.toFixed(1) ?? '—'} R⊕ · α = ${userData.alpha?.toFixed(2) ?? '—'}`;
            if (swState) {
                dataLines = `
                    <div style="color:#889">v_sw ${swState.speed.toFixed(0)} km/s · n ${swState.density.toFixed(1)}/cm³</div>
                    <div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            } else {
                dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            }
            break;
        case 'magnetosheath':
            detail = `compressed solar-wind plasma`;
            dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            break;
        case 'flux-stream':
            detail = `incoming plasma flow`;
            if (swState) {
                const pdyn = (1.67e-6 * swState.density * swState.speed * swState.speed).toFixed(2);
                dataLines = `
                    <div style="color:#889">v ${swState.speed.toFixed(0)} km/s · n ${swState.density.toFixed(1)}/cm³ · Pdyn ${pdyn} nPa</div>
                    <div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            } else {
                dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            }
            break;
        case 'sun-marker':
            detail = `sunward direction`;
            dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            break;
        default:
            detail = userData.altKm != null ? `${userData.altKm} km` : '';
    }
    return `
        <div style="color:${colour};font-weight:600">${userData.name || userData.id}</div>
        <div>${detail}</div>
        ${dataLines}
    `;
}
