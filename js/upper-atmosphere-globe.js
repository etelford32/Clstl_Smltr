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
 *   • volumetric shells × 5 (mesosphere → outer exosphere)
 *                                                  ray-march shader: each
 *                                                  shell mesh is a sphere at
 *                                                  the layer's outer radius;
 *                                                  fragment shader integrates
 *                                                  the view ray's segment
 *                                                  *inside* the shell volume
 *                                                  (between inner & outer
 *                                                  radii, capped by planet)
 *                                                  and shades by path length
 *                                                  → real sphere sheets with
 *                                                  visible depth, not 2-D
 *                                                  limb rings
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
import { EarthSkin } from './earth-skin.js';
import { SATELLITE_REFERENCES, density } from './upper-atmosphere-engine.js';
import { computeShue, computeBowShock } from './magnetosphere-engine.js';
import { ATMOSPHERIC_LAYER_SCHEMA, layerForAltitude }
    from './upper-atmosphere-layers.js';
import { LayerParticleSystem } from './upper-atmosphere-particles.js';
import { layerPhysics, pointPhysics } from './upper-atmosphere-physics.js';
import { LayerVectorField } from './upper-atmosphere-vector-fields.js';
import { CameraController } from './upper-atmosphere-camera.js';

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

// ── Layer-shell GLSL — volumetric ray-march ──────────────────────────────
// The shell isn't a 2D ring around the limb — it's a 3D spherical *sheet*
// with a real inner/outer radius. The fragment shader treats the mesh
// surface as a "front door" into a volume bounded by uInnerR and uOuterR
// and computes how much of that volume the view ray traverses.
//
// For each fragment:
//   1. Cast a ray from the camera through the world-space fragment.
//   2. Intersect with the outer & inner spheres (analytic, cheap).
//   3. The visible shell-segment is everything the ray spends inside
//      the (inner < r < outer) annulus *in front* of the planet.
//   4. Color comes from the radial position of the segment's mid-point
//      (low → high altitude inside the layer) with a storm warming term.
//   5. Alpha is proportional to path length × layer base opacity ×
//      density-driven uIntensity. Long limb chords accumulate more
//      "atmosphere", short on-axis chords accumulate less — gives the
//      shell a real sense of *depth*.
//
// This replaces the old fresnel-only shader where the shell was only
// visible at the limb (which is exactly what made it look like a ring).
const LAYER_VERT = /* glsl */`
    varying vec3 vWorldPos;
    void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
    }
`;

const LAYER_FRAG = /* glsl */`
    uniform vec3  uCameraPos;
    uniform vec3  uColorLow;
    uniform vec3  uColorHigh;
    uniform float uOuterR;       // outer radius of this shell  (R⊕)
    uniform float uInnerR;       // inner radius of this shell  (R⊕)
    uniform float uPlanetR;      // opaque planet radius        (R⊕)
    uniform float uOpacity;
    uniform float uIntensity;    // density-driven multiplier (0.35..1.2)
    uniform float uStorm;        // 0..1 geomagnetic forcing
    uniform vec3  uSunDir;       // unit vector, world frame
    uniform float uSwForcing;    // 0..1 dynamic-pressure proxy from solar wind
    uniform float uFade;         // 0..1 — drops to ~0.18 when camera is
                                 //        inside this shell's altitude band
                                 //        so free-fly users can see through
                                 //        the layer they're standing in.
    varying vec3  vWorldPos;

    // Ray-sphere intersection. Returns vec2(tNear, tFar). Negative
    // values mean the ray origin is inside / behind that sphere.
    vec2 raySphere(vec3 ro, vec3 rd, float r) {
        float b = dot(ro, rd);
        float c = dot(ro, ro) - r * r;
        float disc = b * b - c;
        if (disc < 0.0) return vec2(1e9, -1e9);
        float sq = sqrt(disc);
        return vec2(-b - sq, -b + sq);
    }

    void main() {
        vec3 ro = uCameraPos;
        vec3 rd = normalize(vWorldPos - uCameraPos);

        vec2 hOut = raySphere(ro, rd, uOuterR);
        vec2 hIn  = raySphere(ro, rd, uInnerR);
        vec2 hPl  = raySphere(ro, rd, uPlanetR);

        if (hOut.y < 0.0) discard;          // outer shell entirely behind us

        // Near boundary of the shell-segment along the ray.
        float t0 = max(0.0, hOut.x);

        // Far boundary — whichever opaque thing the ray hits first:
        //   inner-shell entry, planet entry, or outer-shell exit.
        float t1 = hOut.y;
        if (hIn.x > 0.0) t1 = min(t1, hIn.x);
        else if (hIn.y > 0.0) t0 = max(t0, hIn.y);   // camera is below inner
        if (hPl.x > 0.0) t1 = min(t1, hPl.x);

        float pathLen = max(0.0, t1 - t0);
        if (pathLen <= 0.0) discard;

        // Mid-point sample for colour gradient + dayside lighting.
        vec3 midPos = ro + rd * (t0 + t1) * 0.5;
        float midR  = length(midPos);
        float radT  = clamp((midR - uInnerR) / max(uOuterR - uInnerR, 1e-4),
                            0.0, 1.0);
        vec3 col = mix(uColorLow, uColorHigh, radT);

        // Storm warming — push toward orange when Ap is high.
        col = mix(col, vec3(1.0, 0.55, 0.25), uStorm * 0.55);

        // Solar-wind compression cue: strengthens the dayside hemisphere
        // in proportion to dynamic pressure. The shell physically
        // compresses on the sunward side during storms; we tint that side
        // warmer + brighter to convey "this is where the wind is hitting".
        float sunDot = max(0.0, dot(normalize(midPos), uSunDir));
        float dayside = sunDot * uSwForcing;
        col = mix(col, vec3(1.0, 0.72, 0.40), dayside * 0.45);

        // Alpha from path length, normalised to a chord through the
        // shell's full thickness (the maximum any view ray can spend
        // inside this single layer when looking edge-on).
        float maxPath = max(uOuterR - uInnerR, 1e-3);
        float pn = clamp(pathLen / (maxPath * 1.6), 0.0, 1.0);

        // Mild gamma so thicker chords feel deeper without flattening
        // the on-axis fragments to nothing.
        pn = pow(pn, 0.85);

        float alpha = uOpacity * uIntensity * pn * (1.0 + 0.45 * dayside);
        alpha *= uFade;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
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
        this._buildLayerParticles();
        this._buildLayerVectorFields();
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

    // ── Layer particle systems ──────────────────────────────────────────────
    // Five LayerParticleSystem instances, one per atmospheric regime.
    // Each system is mounted under its own group (this._particleGroup) so
    // we can master-toggle all particles independently of the gradient
    // shells, and each individual system can be hidden via
    // setLayerVisible(id, false).

    _buildLayerParticles() {
        this._particleGroup   = new THREE.Group();
        this._particles       = {};   // id → LayerParticleSystem
        for (const layer of ATMOSPHERIC_LAYER_SCHEMA) {
            const sys = new LayerParticleSystem({
                parent: this._particleGroup,
                layer,
                // Sun direction drives the per-particle thermospheric
                // wind (subsolar→antisolar tangent flow). Stored on
                // each system; setSunDir() can update it later.
                sunDir: this._sunDir,
            });
            this._particles[layer.id] = sys;
        }
        this._scene.add(this._particleGroup);
    }

    // ── Layer vector fields ─────────────────────────────────────────────────
    // One LayerVectorField per atmospheric regime. Mode is a single
    // global toggle ('off' | 'temperature' | 'radiation') applied to all
    // five fields together, since the user-facing question is "which
    // *kind* of field do I want to see across the atmosphere", not
    // "which kind on layer 3 specifically". Per-layer toggle is a
    // straight-line follow-up if it ever matters.

    _buildLayerVectorFields() {
        this._fieldGroup     = new THREE.Group();
        this._fields         = {};
        this._fieldMode      = 'off';
        for (const layer of ATMOSPHERIC_LAYER_SCHEMA) {
            const f = new LayerVectorField({
                parent: this._fieldGroup,
                layer,
                sunDir: this._sunDir,
            });
            this._fields[layer.id] = f;
        }
        this._scene.add(this._fieldGroup);
    }

    /**
     * Set the global vector-field mode. 'off' hides every layer's
     * field; 'temperature' or 'radiation' shows them, recomputing
     * vectors against the current physics + state.
     */
    setVectorFieldMode(mode) {
        const m = mode === 'temperature' || mode === 'radiation' ? mode : 'off';
        this._fieldMode = m;
        if (!this._fields) return;
        for (const id in this._fields) {
            const f = this._fields[id];
            f.setMode(m);
            // On switching ON we want fresh vectors — push the latest
            // physics for the matching layer, if we have it cached.
            if (m !== 'off' && this._lastFieldPhys?.[id]) {
                f.setPhysics(
                    this._lastFieldPhys[id],
                    this._lastFieldState ?? {},
                );
            }
        }
    }

    getVectorFieldMode() { return this._fieldMode ?? 'off'; }

    /**
     * Per-layer visibility toggle — drives the gradient shell AND the
     * matching particle system together. Layer id matches
     * ATMOSPHERIC_LAYER_SCHEMA[].id.
     */
    setLayerVisible(layerId, visible) {
        const v = !!visible;
        // Shell mesh.
        if (this._shells) {
            const shell = this._shells.find(s => s.userData?.id === layerId);
            if (shell) shell.visible = v;
        }
        // Particle system.
        const sys = this._particles?.[layerId];
        if (sys) sys.setVisible(v);
    }

    /**
     * True/false snapshot of every layer's visibility — used by the UI
     * panel to seed checkbox state on first paint.
     */
    getLayerVisibility() {
        const out = {};
        for (const layer of ATMOSPHERIC_LAYER_SCHEMA) {
            const shell = this._shells?.find(s => s.userData?.id === layer.id);
            out[layer.id] = shell ? shell.visible : true;
        }
        return out;
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

        // Push the latest physics into each particle system. layerPhysics
        // samples at peakKm with the layer's vertical thickness as the
        // Knudsen characteristic length, then setPhysics() rescales
        // particle count / colour / step magnitude / storm-drift in one
        // shot — no per-frame recompute, the per-frame update only
        // integrates positions.
        const f107 = profile.f107Sfu ?? this._lastState?.f107 ?? 150;
        const ap   = profile.ap      ?? this._lastState?.ap      ??  15;
        // Cache layerPhysics() once per layer + share it with both the
        // particle system AND the vector-field overlay so we're not
        // sampling the engine twice for the same (layer, F10.7, Ap)
        // tuple. Cheap, but pointless to do twice.
        this._lastFieldPhys  = this._lastFieldPhys || {};
        this._lastFieldState = { f107, ap };
        for (const layer of ATMOSPHERIC_LAYER_SCHEMA) {
            const phys = layerPhysics(layer, { f107Sfu: f107, ap });
            this._lastFieldPhys[layer.id] = phys;

            const sys = this._particles?.[layer.id];
            if (sys) sys.setPhysics(phys, { f107, ap });

            const fld = this._fields?.[layer.id];
            if (fld && this._fieldMode !== 'off') {
                fld.setPhysics(phys, { f107, ap });
            }
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
        this._lastState = { f107, ap };

        // Push the new (F10.7, Ap) to each particle system so the
        // storm-drift kicks in as soon as the user clicks a preset —
        // even before setProfile() runs.
        if (this._particles && this._profile) {
            for (const layer of ATMOSPHERIC_LAYER_SCHEMA) {
                const sys = this._particles[layer.id];
                if (!sys?._phys) continue;
                sys.setPhysics(sys._phys, { f107, ap });
            }
        }

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

        // Drive the sun's emission visuals from F10.7 — corona glow,
        // streamer brightness/length, core temperature.
        this.setF107(f107);
    }

    /**
     * Toggle overlay groups.
     */
    setVisibility({ satellites = true, shells = true, solarWind = true,
                    particles = true, vectorFields } = {}) {
        if (this._satGroup)      this._satGroup.visible      = satellites;
        if (this._shellGroup)    this._shellGroup.visible    = shells;
        if (this._swGroup)       this._swGroup.visible       = solarWind;
        if (this._particleGroup) this._particleGroup.visible = particles;
        // vectorFields visibility is driven by the field MODE — passing
        // false explicitly here forces the whole group off without
        // changing the mode (a user-friendly "hide" without losing
        // their last-selected mode).
        if (this._fieldGroup && vectorFields !== undefined) {
            this._fieldGroup.visible = !!vectorFields;
        }
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
        // CameraController owns OrbitControls + the WASD bindings; its
        // dispose() unwinds both.
        this._controls?.dispose?.();
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
        // Build the five gradient layer shells as *volumetric* sphere
        // sheets — each mesh is the shell's outer sphere; the fragment
        // shader ray-marches the ray segment from there down to the
        // shell's inner radius (or whichever opaque surface intervenes:
        // inner shell, planet, etc.). Because the shader does the volume
        // math we draw the mesh DoubleSide so the shell still renders
        // when the camera is inside it.
        //
        // We render outermost-first so additive blending sums the inner
        // (denser) layers on top, matching the physical optical depth
        // intuition: more density = brighter accumulation at the limb.
        this._shells = [];
        this._shellGroup = new THREE.Group();

        const ordered = [...LAYER_SHELLS].sort((a, b) => b.maxKm - a.maxKm);
        let renderOrder = 0;
        for (const def of ordered) {
            const rOut = 1 + def.maxKm / R_EARTH_KM;
            const rIn  = 1 + def.minKm / R_EARTH_KM;
            const mat = new THREE.ShaderMaterial({
                vertexShader:   LAYER_VERT,
                fragmentShader: LAYER_FRAG,
                uniforms: {
                    uCameraPos: { value: this._camera.position.clone() },
                    uColorLow:  { value: new THREE.Color(def.colorLow) },
                    uColorHigh: { value: new THREE.Color(def.colorHigh) },
                    uOuterR:    { value: rOut },
                    uInnerR:    { value: rIn },
                    uPlanetR:   { value: 1.0 },
                    uOpacity:   { value: def.baseAlpha },
                    uIntensity: { value: 0.7 },
                    uStorm:     { value: 0 },
                    uSunDir:    { value: this._sunDir.clone() },
                    uSwForcing: { value: 0 },
                    uFade:      { value: 1.0 },
                },
                transparent: true,
                // BackSide: draws the far hemisphere when the camera is
                // outside the sphere (giving a fragment for every view
                // ray that passes through the volume) and draws the
                // entire interior when the camera is inside it. Either
                // way the ray-march shader finds the correct shell
                // segment to integrate. FrontSide+BackSide together
                // would render twice and double the additive alpha.
                side: THREE.BackSide,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
            });
            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(rOut, 96, 64),
                mat,
            );
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

        // ── ISS as a moving probe ─────────────────────────────────────
        // The static ring already exists for ISS at 420 km — we add a
        // small sprite *along* it that propagates the orbit so users
        // have a moving marker to click on. The sprite carries the
        // kind='iss-probe' userData so the click handler can fly the
        // camera to it and the tooltip can show local atmosphere
        // physics + drag pressure.
        this._buildISSProbe();
    }

    _buildISSProbe() {
        const issAlt = 420;
        const r = 1 + issAlt / R_EARTH_KM;

        // A small bright sphere reads as "object" against the layer
        // shells without the visual noise of a 3D model. Tagged with
        // kind='iss-probe' so the existing tooltip + click pipeline
        // picks it up.
        const geo = new THREE.SphereGeometry(0.012, 14, 10);
        const mat = new THREE.MeshBasicMaterial({
            color: 0x00ffd0,
            transparent: true,
            opacity: 1.0,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.userData = {
            kind:     'iss-probe',
            id:       'iss',
            name:     'ISS · live probe',
            altKm:    issAlt,
            color:    '#00ffd0',
            tooltip:  'Click to fly the camera here. Drag pressure '
                    + '≈ ½ρv² uses local ρ from the current state and '
                    + 'v ≈ 7.66 km/s circular orbital speed.',
        };
        // Halo: a slightly larger transparent sphere that gives the
        // probe a glow at distance (the inner sphere is too small to
        // see from outside the magnetopause).
        const haloGeo = new THREE.SphereGeometry(0.026, 14, 10);
        const haloMat = new THREE.MeshBasicMaterial({
            color: 0x00ffd0,
            transparent: true,
            opacity: 0.25,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        const halo = new THREE.Mesh(haloGeo, haloMat);
        halo.userData = mesh.userData;       // share so raycaster on halo also resolves to ISS
        mesh.add(halo);

        // Initial position on orbit so first paint isn't at origin.
        mesh.position.set(r, 0, 0);
        this._iss = mesh;
        this._scene.add(mesh);
    }

    /**
     * Fly the camera to the moving ISS probe with a small offset so
     * the probe stays in frame; lookAt the probe. Called by the click
     * handler on the canvas + by an external "Visit ISS" button.
     */
    flyToISS(durationSec = 1.6) {
        if (!this._iss) return;
        const issPos = this._iss.position.clone();
        // Offset behind the velocity vector — gives a chase-cam feel
        // and lets users see the probe move forward through the
        // upper-thermosphere band.
        const radial = issPos.clone().normalize();
        const offset = radial.multiplyScalar(0.18);   // ~1146 km out from probe
        const target = issPos.clone().add(offset);
        this.flyTo(target, issPos, durationSec);
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

        // ── Sun glow + EUV streamers ───────────────────────────────────
        // Replaces the flat sphere marker with a proper "the Sun is
        // emitting" cue: a hot core, a soft corona halo, and a cluster
        // of outgoing radial photon streamers whose count + brightness
        // scale with F10.7. setF107() updates them live.
        this._buildSun(bs0);

        this._scene.add(this._swGroup);

        // Apply climatology so first paint shows non-default state if
        // the engine already has a feel for this. setSolarWind() is also
        // called externally once SwpcFeed pushes real data.
        this.setSolarWind(SW_DEFAULTS);
    }

    /**
     * Build the sun: a hot inner core + a soft halo + 24 outgoing
     * radial streamers that read as photon emission. F10.7 modulates
     * the corona brightness + streamer length so users see "active
     * sun" vs "quiet sun" at a glance. Mounted in the solar group so
     * "+Y == sunward" alignment is automatic.
     */
    _buildSun(bs0) {
        const sunDistance = bs0.r0 + 8;
        const coreR = 0.55;
        const haloR = 1.4;

        // Hot core — solid bright disc.
        const coreGeo = new THREE.SphereGeometry(coreR, 22, 16);
        const coreMat = new THREE.MeshBasicMaterial({
            color: 0xfff4c4,
            transparent: true,
            opacity: 0.95,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        const core = new THREE.Mesh(coreGeo, coreMat);
        core.userData = {
            kind:    'sun-marker',
            id:      'sun',
            name:    'Sun',
            tooltip: 'Solar emission source. Brightness + streamer '
                   + 'length scale with F10.7 (10.7-cm radio flux, an '
                   + 'EUV proxy used by NRL-MSIS / Jacchia models).',
        };

        // Halo — fresnel-bright corona that breathes with the F10.7
        // driver. We re-use the SW_VERT/SW_FRAG shaders since they
        // already implement a viewer-direction limb glow.
        const haloMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor:     { value: new THREE.Color(0xffd060) },
                uRimColor:  { value: new THREE.Color(0xffe5a8) },
                uBaseAlpha: { value: 0.18 },
                uRimPower:  { value: 1.6 },
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
        const halo = new THREE.Mesh(
            new THREE.SphereGeometry(haloR, 32, 22),
            haloMat,
        );
        halo.userData = core.userData;
        core.add(halo);

        // Outgoing photon streamers — radial line strips emanating
        // from the core in 24 directions on a Fibonacci sphere. Each
        // streamer carries an aProgress attribute (0 at core, 1 at
        // tip) so the SW_STREAM shaders can paint the travelling-dash
        // pattern radiating *outward* (negative speed → outward dash).
        const N_STREAMS = 24;
        const streamMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor:     { value: new THREE.Color(0xffe080) },
                uTime:      { value: 0 },
                uIntensity: { value: 0.7 },
                uSpeed:     { value: -0.22 },     // negative → flow outward
            },
            vertexShader:   SW_STREAM_VERT,
            fragmentShader: SW_STREAM_FRAG,
            transparent:    true,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });

        const streamGroup = new THREE.Group();
        const phi = Math.PI * (3 - Math.sqrt(5));
        for (let i = 0; i < N_STREAMS; i++) {
            const y    = 1 - (i / (N_STREAMS - 1)) * 2;
            const r    = Math.sqrt(Math.max(0, 1 - y * y));
            const lon  = i * phi;
            const dx = r * Math.cos(lon);
            const dy = y;
            const dz = r * Math.sin(lon);
            const tipLen = 2.4;     // R⊕ from the core; modulated below
            const positions = new Float32Array([
                dx * coreR, dy * coreR, dz * coreR,
                dx * (coreR + tipLen), dy * (coreR + tipLen), dz * (coreR + tipLen),
            ]);
            const progress = new Float32Array([0, 1]);
            const g = new THREE.BufferGeometry();
            g.setAttribute('position',  new THREE.BufferAttribute(positions, 3));
            g.setAttribute('aProgress', new THREE.BufferAttribute(progress, 1));
            const line = new THREE.Line(g, streamMat);
            line.userData = {
                kind:    'sun-stream',
                id:      'sun-stream',
                name:    'Sun · radial emission',
                tooltip: 'Radial photon flow. Length + brightness scale with F10.7.',
            };
            streamGroup.add(line);
        }
        core.add(streamGroup);

        core.position.set(0, sunDistance, 0);
        this._sunMarker  = core;
        this._sunCoreMat = coreMat;
        this._sunHaloMat = haloMat;
        this._sunStreamMat = streamMat;
        this._sunStreamGroup = streamGroup;
        this._swGroup.add(core);
    }

    /**
     * Drive the sun's emission visuals from the solar-flux index
     * (F10.7 in SFU). Quiet-sun ≈ 70 SFU; cycle-max ≈ 250–300. Maps
     * to streamer brightness, halo glow, and core size.
     */
    setF107(f107Sfu) {
        const f = Number.isFinite(f107Sfu) ? f107Sfu : 150;
        const q = Math.max(0, Math.min(1, (f - 65) / (300 - 65)));   // 0..1
        if (this._sunHaloMat)   this._sunHaloMat.uniforms.uIntensity.value = 0.55 + 0.85 * q;
        if (this._sunStreamMat) this._sunStreamMat.uniforms.uIntensity.value = 0.30 + 0.95 * q;
        // Subtle core warming with activity: cooler yellow at quiet,
        // hotter white at max.
        if (this._sunCoreMat) {
            const cool = new THREE.Color(0xffd06c);
            const hot  = new THREE.Color(0xffffe8);
            this._sunCoreMat.color.copy(cool.clone().lerp(hot, q));
            this._sunCoreMat.opacity = 0.85 + 0.13 * q;
        }
        // Stream group scales radially so high F10.7 = longer EUV reach.
        if (this._sunStreamGroup) {
            const s = 0.85 + 0.55 * q;
            this._sunStreamGroup.scale.setScalar(s);
        }
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
        // CameraController wraps OrbitControls + a hand-rolled fly mode
        // behind a single setMode() switch. Default = orbit so existing
        // behaviour is unchanged on first paint; the UI exposes a toggle
        // to switch into fly mode where users can move *into* the layers.
        this._controls = new CameraController(this._camera, this.canvas);
    }

    /**
     * Toggle the camera between 'orbit' (planet-locked, OrbitControls)
     * and 'fly' (free 6-DOF, WASD + mouse-drag look). Returns the new
     * mode so callers can sync a UI toggle.
     */
    setCameraMode(mode) {
        this._controls.setMode(mode);
        return this._controls.getMode();
    }
    getCameraMode() { return this._controls.getMode(); }

    /**
     * Smoothly fly the camera to a world-space target, optionally aiming
     * at lookAt. Used by satellite click-to-fly and ISS focus.
     */
    flyTo(targetVec3, lookAtVec3 = null, duration = 1.4) {
        this._controls.flyTo(targetVec3, lookAtVec3, duration);
    }

    /**
     * Camera altitude above 1 R⊕ in km. The HUD reads this every frame to
     * paint the local-altitude readout + sample the engine for ρ/T/Kn.
     */
    getCameraAltitudeKm() {
        return this._controls.getAltitudeKm();
    }

    /**
     * Sample local atmospheric physics at the current camera altitude.
     * Returns null if the camera is below the simulator's domain (< 80 km).
     * Cheap; uses the same engine call the side panel uses.
     */
    getCameraSampleAtState({ f107, ap }) {
        const altKm = this.getCameraAltitudeKm();
        if (!Number.isFinite(altKm) || altKm < 80) return { altitudeKm: altKm, outOfDomain: true };
        const layer = layerForAltitude(altKm);
        const phys  = pointPhysics({
            altitudeKm: altKm,
            f107Sfu:    f107,
            ap,
            layerThicknessKm: layer ? Math.max(1, layer.maxKm - layer.minKm) : null,
        });
        return { ...phys, layer };
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
            ...(this._iss        ? [this._iss]        : []),
        ];

        // Recursive: the ISS sprite carries a child halo mesh; if we
        // raycast non-recursively the halo eats hits and the parent's
        // userData isn't found. recursive=true makes the raycaster
        // descend; we look at hits[0].object.userData OR walk up to a
        // tagged ancestor.
        const _findTaggedUserData = (obj) => {
            let o = obj;
            while (o) {
                if (o.userData?.kind) return o.userData;
                o = o.parent;
            }
            return obj.userData || {};
        };

        const onMove = (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            this._mouse.x = (x / rect.width)  *  2 - 1;
            this._mouse.y = (y / rect.height) * -2 + 1;
            this._raycaster.setFromCamera(this._mouse, this._camera);
            const hits = this._raycaster.intersectObjects(hittable(), true);
            if (hits.length > 0) {
                const ud = _findTaggedUserData(hits[0].object);
                tip.innerHTML = _tipHTML(ud, this._profile, this._swState);
                tip.style.left = `${x}px`;
                tip.style.top  = `${y}px`;
                tip.style.opacity = '1';
                this._hoveredUserData = ud;
                this.canvas.style.cursor = 'pointer';
            } else {
                tip.style.opacity = '0';
                this._hoveredUserData = null;
                if (this._controls.getMode() === 'fly') {
                    this.canvas.style.cursor = 'crosshair';
                } else {
                    this.canvas.style.cursor = 'grab';
                }
            }
        };
        const onLeave = () => {
            tip.style.opacity = '0';
            this.canvas.style.cursor = 'grab';
        };
        // Click handler: clicking on the ISS probe flies the camera to it.
        // Designed to ignore drag-clicks (keep OrbitControls / fly-mode
        // mouse-look working) by tracking the down-position and only
        // firing if the mouse hasn't moved more than a few pixels.
        let downX = 0, downY = 0, downT = 0;
        const onDown = (e) => {
            downX = e.clientX; downY = e.clientY; downT = performance.now();
        };
        const onUp = (e) => {
            const dx = Math.abs(e.clientX - downX);
            const dy = Math.abs(e.clientY - downY);
            const dt = performance.now() - downT;
            if (dx > 4 || dy > 4 || dt > 350) return;     // user dragged
            const ud = this._hoveredUserData;
            if (ud?.kind === 'iss-probe') {
                this.flyToISS();
            }
        };
        this.canvas.addEventListener('mousemove', onMove);
        this.canvas.addEventListener('mouseleave', onLeave);
        this.canvas.addEventListener('mousedown',  onDown);
        this.canvas.addEventListener('mouseup',    onUp);
        this._disposeHover = () => {
            this.canvas.removeEventListener('mousemove', onMove);
            this.canvas.removeEventListener('mouseleave', onLeave);
            this.canvas.removeEventListener('mousedown',  onDown);
            this.canvas.removeEventListener('mouseup',    onUp);
            tip.remove();
        };
    }

    _animate() {
        this._raf = requestAnimationFrame(this._animate);
        const t = this._clock.getElapsedTime();
        const dt = this._clock.getDelta();

        if (this._skin) this._skin.update(t);

        // Per-frame particle integration. Each layer system runs its
        // thermal jitter + storm-drift step; cheap (~250 particles ×
        // 5 layers × ~10 ops). Hidden systems early-out via their
        // `this._n === 0` guard so an off-toggled layer costs nothing.
        if (this._particles) {
            for (const id in this._particles) {
                const sys = this._particles[id];
                if (sys.points.visible) sys.update(dt);
            }
        }

        // Slow auto-rotation when in orbit mode + user isn't dragging.
        // In fly mode we keep the world stationary so users can orient
        // themselves against fixed reference frames.
        const orbitMode = this._controls.getMode() === 'orbit';
        if (this.opts.autoRotate && orbitMode && this._skin) {
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
        if (this._mpMat)       this._mpMat.uniforms.uTime.value       = t;
        if (this._bsMat)       this._bsMat.uniforms.uTime.value       = t;
        if (this._streamMat)   this._streamMat.uniforms.uTime.value   = t;
        // Sun shaders: corona breathing pulse + outgoing-streamer dash.
        if (this._sunHaloMat)   this._sunHaloMat.uniforms.uTime.value   = t;
        if (this._sunStreamMat) this._sunStreamMat.uniforms.uTime.value = t;

        this._controls.update(dt);

        // Per-frame ISS orbit propagation. ISS sits at ~420 km on a
        // 51.6° inclined orbit with a ~92.7-min period; that's plenty
        // close enough for a benchmark probe. Visual time can be sped up
        // via opts.issTimeScale so a user sees a full pass in seconds.
        if (this._iss) this._stepISS(t);

        // Shell-fade-when-inside: when the camera enters a layer band,
        // drop the shell's opacity so the user can see through the layer
        // they're standing in. Cheap — five comparisons per frame.
        if (this._shells) this._fadeShellsForCameraAltitude();

        this._renderer.render(this._scene, this._camera);
    }

    /**
     * Drop the gradient shell's opacity when the camera is inside its
     * altitude band; restore otherwise. Without this, free-fly users see
     * the additive blend stack up against the inside of every shell they
     * pass through, which reads as a wall of orange.
     */
    _fadeShellsForCameraAltitude() {
        const altKm = this.getCameraAltitudeKm();
        for (const sh of this._shells) {
            const ud = sh.userData;
            const inside = altKm >= ud.minKm && altKm <= ud.maxKm;
            // Use an explicit fade factor on each shell's intensity
            // uniform — multiplied with the base log-ρ intensity that
            // setProfile() set up.
            const baseFade = inside ? 0.18 : 1.0;
            // Smoothly blend so the transition isn't abrupt.
            const cur = sh.material.uniforms.uFade?.value ?? 1.0;
            const next = cur + (baseFade - cur) * 0.12;
            if (sh.material.uniforms.uFade) {
                sh.material.uniforms.uFade.value = next;
            }
        }
    }

    /**
     * Advance the ISS sprite along a 51.6°-inclined circular orbit at
     * 420 km. Position is in world frame; we expose .userData.altKm so
     * the existing tooltip pipeline keeps working unchanged.
     */
    _stepISS(elapsedSec) {
        const ts = this.opts.issTimeScale ?? 60;   // 60× real time
        // Mean motion: 2π / orbit_period. ISS period ≈ 92.7 min.
        const period = 92.7 * 60;
        const meanAnomaly = (elapsedSec * ts / period) * 2 * Math.PI;

        const r = 1 + 420 / R_EARTH_KM;
        const incl = 51.6 * Math.PI / 180;
        // Argument of right-ascension precesses slowly; not modelling
        // here — keep the ascending node fixed and let users see one
        // representative pass.
        const ω = meanAnomaly;
        // Position in orbital plane, then rotate by inclination around X.
        const x =  r * Math.cos(ω);
        const y0 = r * Math.sin(ω);
        const y =  y0 * Math.cos(incl);
        const z = -y0 * Math.sin(incl);

        this._iss.position.set(x, y, z);

        // Orient the sprite so its long axis lies along the velocity
        // vector — derivative of position in orbit. Velocity gives a
        // consistent visual cue when users zoom in.
        const vx = -r * Math.sin(ω);
        const vy0 =  r * Math.cos(ω);
        const vx_w = vx;
        const vy_w =  vy0 * Math.cos(incl);
        const vz_w = -vy0 * Math.sin(incl);
        const vel = new THREE.Vector3(vx_w, vy_w, vz_w).normalize();
        // Look "ahead" along the velocity, with up = radial-out so the
        // sprite sits flat against the orbit plane.
        const radial = this._iss.position.clone().normalize();
        const m = new THREE.Matrix4().lookAt(
            this._iss.position,
            this._iss.position.clone().add(vel),
            radial,
        );
        this._iss.quaternion.setFromRotationMatrix(m);
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
        case 'sun-stream':
            detail = `solar emission source`;
            dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            break;
        case 'iss-probe':
            // Live benchmark probe — show local atmospheric ρ at ISS
            // altitude + the resulting drag pressure q = ½ρv² at the
            // circular orbital speed for 420 km (~7.66 km/s).
            detail = `${userData.altKm} km · 51.6° · click to fly here`;
            if (profile?.samples?.length) {
                const rho = _nearestRho(profile.samples, userData.altKm);
                const v = 7660;       // m/s, circular @ 420 km
                const q = 0.5 * rho * v * v;       // Pa
                dataLines = `
                    <div style="color:#9cf">ρ = ${rho.toExponential(2)} kg/m³ · v ≈ 7.66 km/s</div>
                    <div style="color:#0fc">drag q ≈ ${(q * 1000).toFixed(2)} mPa</div>
                    <div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            } else {
                dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            }
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
