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
import { SATELLITE_REFERENCES, density, fetchDebrisSample }
    from './upper-atmosphere-engine.js';
import { annotate as annotateDebris, summariseByFamily, DEBRIS_FAMILIES }
    from './debris-catalog.js';
import { CONSTELLATIONS, spawnConstellationPositions }
    from './constellation-catalog.js';
import { buildSatelliteModel, buildSatelliteModelLow }
    from './satellite-models.js';
import { computeShue, computeBowShock } from './magnetosphere-engine.js';
import { ATMOSPHERIC_LAYER_SCHEMA, layerForAltitude }
    from './upper-atmosphere-layers.js';
import { LayerParticleSystem } from './upper-atmosphere-particles.js';
import { layerPhysics, pointPhysics } from './upper-atmosphere-physics.js';
import { LayerVectorField } from './upper-atmosphere-vector-fields.js';
import { MagneticCascade } from './upper-atmosphere-magnetic-cascade.js';
import { SubstormController } from './upper-atmosphere-substorm.js';
import { CameraController } from './upper-atmosphere-camera.js';
import { subSolarPoint } from './sun-altitude.js';

// Map (sub-solar lat, sub-solar lon) → unit Vector3 in the scene's world
// frame. Convention: scene +Y is the geographic north pole; lon=0 (Greenwich)
// faces +X at scene-origin orientation. This keeps the day-side terminator
// on the existing Earth texture aligned with the real sub-solar geographic
// point, so the simulation reads as "real-time Earth–Sun geometry."
function _subSolarToVec3(latDeg, lonDeg) {
    const DEG = Math.PI / 180;
    const phi = latDeg * DEG;
    const lam = lonDeg * DEG;
    const c = Math.cos(phi);
    return new THREE.Vector3(c * Math.cos(lam), Math.sin(phi), c * Math.sin(lam));
}

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

// ── Sun photosphere shader — procedural granulation + limb darkening ──
// fbm-based cell pattern that drifts slowly so the disc reads as a
// roiling, convecting surface rather than a flat sprite. Colour ramps
// from a hot white-yellow core toward orange limb (limb darkening), with
// brighter "active region" highlights that breathe with uTime.
const SUN_VERT = /* glsl */`
    varying vec3 vNormalW;
    varying vec3 vPosW;
    varying vec3 vViewDirW;
    void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPosW    = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDirW = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
    }
`;
const SUN_FRAG = /* glsl */`
    precision highp float;
    uniform float uTime;
    uniform float uIntensity;
    uniform vec3  uHot;
    uniform vec3  uCool;
    varying vec3  vNormalW;
    varying vec3  vViewDirW;
    varying vec3  vPosW;

    // Hash + value-noise — cheap, no texture dependency.
    float hash3(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float vnoise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = hash3(i + vec3(0.0, 0.0, 0.0));
        float n100 = hash3(i + vec3(1.0, 0.0, 0.0));
        float n010 = hash3(i + vec3(0.0, 1.0, 0.0));
        float n110 = hash3(i + vec3(1.0, 1.0, 0.0));
        float n001 = hash3(i + vec3(0.0, 0.0, 1.0));
        float n101 = hash3(i + vec3(1.0, 0.0, 1.0));
        float n011 = hash3(i + vec3(0.0, 1.0, 1.0));
        float n111 = hash3(i + vec3(1.0, 1.0, 1.0));
        return mix(
            mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
            mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
            f.z);
    }
    float fbm(vec3 p) {
        float a = 0.0, w = 0.5;
        for (int i = 0; i < 5; i++) {
            a += w * vnoise(p);
            p *= 2.05;
            w *= 0.5;
        }
        return a;
    }

    void main() {
        // Granulation: scale up the surface position so cells are small
        // relative to the disc, then drift with uTime to roil. A second
        // FBM at half scale picks out broad active-region brightening.
        vec3 p = normalize(vPosW) * 4.5;
        float gran   = fbm(p + vec3(0.0, uTime * 0.04, 0.0));
        float active = fbm(p * 0.6 + vec3(uTime * 0.02, 0.0, uTime * 0.015));
        float surf   = mix(gran, active, 0.45);

        // Limb darkening: the disc edge cools toward orange/red; the
        // centre reads white-hot. Boost the darkening exponent slightly
        // so users get the "convex 3D star" cue rather than a flat disc.
        float NdV  = clamp(dot(normalize(vNormalW), normalize(vViewDirW)), 0.0, 1.0);
        float limb = pow(NdV, 0.55);

        // Active-region hotspots — breathing white-hot peaks. Squared
        // contrast so they punch through the granulation noise.
        float hotspot = smoothstep(0.62, 0.95, surf);
        hotspot = pow(hotspot, 1.6);

        // Colour blend: limb-darkened cool baseline, brightened by the
        // FBM and lifted toward white at the hotspots.
        vec3 base = mix(uCool, uHot, limb);
        base += hotspot * vec3(0.55, 0.42, 0.18);
        base *= 0.78 + 0.42 * surf;

        // Subtle uIntensity scale (tied to F10.7) — quiet sun is a
        // touch dimmer, cycle max is brighter and whiter.
        base *= 0.85 + 0.45 * uIntensity;

        gl_FragColor = vec4(base, 1.0);
    }
`;

// ── Sun corona shader — multi-layer additive halo ─────────────────────
// A fresnel-bright shell with FBM "streamer" filaments rotating slowly
// around the disc. Used at three radii (chromosphere → mid corona →
// outer corona) with different colours so the layered glow reads as
// real depth rather than a single flat halo.
const CORONA_VERT = /* glsl */`
    varying vec3 vNormalW;
    varying vec3 vViewDirW;
    varying vec2 vUv;
    void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vNormalW  = normalize(mat3(modelMatrix) * normal);
        vViewDirW = normalize(cameraPosition - wp.xyz);
        vUv       = uv;
        gl_Position = projectionMatrix * viewMatrix * wp;
    }
`;
const CORONA_FRAG = /* glsl */`
    precision highp float;
    uniform vec3  uColor;
    uniform vec3  uRimColor;
    uniform float uTime;
    uniform float uIntensity;
    uniform float uRimPower;
    uniform float uBaseAlpha;
    varying vec3  vNormalW;
    varying vec3  vViewDirW;
    varying vec2  vUv;

    float hash3(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float vnoise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
            mix(mix(hash3(i+vec3(0,0,0)), hash3(i+vec3(1,0,0)), f.x),
                mix(hash3(i+vec3(0,1,0)), hash3(i+vec3(1,1,0)), f.x), f.y),
            mix(mix(hash3(i+vec3(0,0,1)), hash3(i+vec3(1,0,1)), f.x),
                mix(hash3(i+vec3(0,1,1)), hash3(i+vec3(1,1,1)), f.x), f.y),
            f.z);
    }
    float fbm(vec3 p) {
        float a = 0.0, w = 0.5;
        for (int i = 0; i < 4; i++) {
            a += w * vnoise(p);
            p *= 2.1;
            w *= 0.5;
        }
        return a;
    }

    void main() {
        // Limb-bright fresnel — corona reads brightest at the silhouette.
        float NdV  = abs(dot(normalize(vNormalW), normalize(vViewDirW)));
        float fres = pow(1.0 - NdV, uRimPower);

        // Rotating filament noise: creates the suggestion of corona
        // streamers without modelling each one geometrically. The radial
        // sample uses the surface normal so the filaments stay attached
        // to the disc as it rotates.
        vec3 p = normalize(vNormalW) * 3.2 + vec3(uTime * 0.03, 0.0, uTime * 0.05);
        float fil = fbm(p);
        // Sharpen the FBM into "ribbons" — power curve picks out brighter
        // ridges and lets the rest fall away.
        fil = pow(smoothstep(0.40, 0.95, fil), 1.4);

        vec3 col = mix(uColor, uRimColor, fres);
        col += fil * uRimColor * 0.55;

        // Slow breathing pulse — overall corona modulation.
        float pulse = 0.92 + 0.16 * sin(uTime * 0.5);

        float alpha = (uBaseAlpha + fres * 0.55 + fil * 0.18) * pulse * uIntensity;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.95));
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
        // Pairwise conjunction screener — depends on the probe lookup
        // tables built inside _buildSatelliteRings, so we set up after.
        this._setupConjunctionScreener();
        // Hover-highlight reticle for the debris cloud. Built up-front
        // (cheap; one mesh) so _updateDebrisHighlight has a target to
        // poke at the moment a hover lands on a dot.
        this._buildDebrisHighlight();
        // Fire-and-forget live-TLE upgrade. Each probe starts on its
        // hardcoded mean elements; the fetch resolves a few hundred ms
        // later and patches the probe in place. Failures fall back
        // silently to the hardcoded values.
        this._fetchLiveTLEs().catch(err => {
            console.debug('[upper-atmosphere] live TLE upgrade skipped:', err?.message || err);
        });
        // Background debris sample — 50 LEO debris pieces in the same
        // altitude band as our assets, fetched from CelesTrak's debris
        // SPECIAL list. Failures are silent; the page stays usable
        // without debris context.
        this._loadDebrisSample().catch(err => {
            console.debug('[upper-atmosphere] debris load skipped:', err?.message || err);
        });
        this._buildAltitudeRing();
        this._buildSolarWind();
        this._buildMagneticCascade();
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

        // Drive the magnetic-field cascade — solar EUV + precipitation
        // packets flowing down dipole L-shells into the auroral oval.
        // Pass the live solar-wind state too so the cascade can:
        //   • compress dayside / stretch nightside lines from Pdyn
        //   • compute Φ_PC, FAC magnitude, HPI
        //   • dispatch a 'ua-magnetic-state' event with operator-grade
        //     headlines (HPI, Φ_PC, Lpp, FAC, oval edges, implications)
        // Uses live IMF Bz when available; falls back to an Ap-derived
        // proxy so storm presets still light up the reconnection cue.
        if (this._cascade) {
            this._cascade.setState({
                f107, ap, bz,
                speed:   this._swState?.speed,
                density: this._swState?.density,
                by:      this._swState?.by,
            });
        }

        // Feed a substorm-index proxy into the controller's auto-
        // trigger. We synthesise the index from the same drivers
        // solar-wind-magnetosphere.js uses: an Ap-driven storm-norm
        // plus a southward-Bz integrand. Climbing across 0.6 fires
        // an auto-substorm if the controller is idle + past the
        // refractory period.
        if (this._substorm) {
            const stormNorm = Math.max(0, Math.min(1, (ap - 12) / 200));
            // Bz drive integrand — accumulates while Bz is southward,
            // decays exponentially otherwise. Half-life ~30 sec wall-
            // clock so a state push of southward Bz primes the next
            // few sets of pushes (mirrors the real magnetosphere's
            // memory of recent driving).
            const bzS = Number.isFinite(bz)
                ? Math.max(0, -bz / 20)        // 0 at +Bz, 1 at -20 nT
                : stormNorm * 0.7;
            this._bzDriveAccum = Math.max(0, Math.min(1,
                0.85 * (this._bzDriveAccum || 0) + 0.45 * bzS));
            const idx = Math.min(1, 0.55 * stormNorm + 0.65 * this._bzDriveAccum);
            this._substorm.setSubstormIndex(idx);
        }
    }

    /**
     * Toggle overlay groups.
     */
    setVisibility({ satellites = true, shells = true, solarWind = true,
                    particles = true, vectorFields, cascade = true } = {}) {
        if (this._satGroup)      this._satGroup.visible      = satellites;
        if (this._shellGroup)    this._shellGroup.visible    = shells;
        if (this._swGroup)       this._swGroup.visible       = solarWind;
        if (this._particleGroup) this._particleGroup.visible = particles;
        if (this._cascade)       this._cascade.setVisible(cascade);
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
        const by      = Number.isFinite(sw.by)      ? sw.by      : 0;
        this._swState = { speed, density, bz, by };

        // Cascade geometry compresses dayside / stretches nightside
        // lines under Pdyn — push the live state so the visual tracks
        // the boundary motion the magnetopause is showing in parallel.
        if (this._cascade) {
            this._cascade.setSolarWindState({ speed, density, bz, by });
        }

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

        // Sun direction — derived from the actual sub-solar point at
        // the current wall-clock time. The day-side terminator on the
        // EarthSkin texture and the position of the Sun graphic in the
        // solar-wind group both fall out of this vector, so the scene
        // reflects the real Earth–Sun geometry at page-load. _animate()
        // refreshes it every frame; that motion is genuinely glacial
        // (≈15°/hour, the Earth's actual rotation rate relative to the
        // Sun) so the camera reads as static while the geometry remains
        // physically correct.
        const ssp = subSolarPoint(new Date());
        this._sunDir = _subSolarToVec3(ssp.lat, ssp.lon);
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
        // Two-tier overlay:
        //  • _satGroup     — flat reference rings at each altitude. The
        //                    Kármán line (non-orbital) gets only this.
        //  • _satProbeGrp  — moving sprites + inclined orbital paths for
        //                    every entry that has an `orbital` block.
        //
        // The rings are kept around as zoomed-out "altitude shell"
        // indicators; the sprites + paths render the actual inclined
        // orbit at one period worth of points so users see the real
        // geometry instead of a fictitious flat circle.
        this._satGroup     = new THREE.Group();
        this._satProbeGrp  = new THREE.Group();
        this._satProbeGrp.name = 'satellite-probes';
        this._satRings     = [];
        this._satProbes    = {};      // id → { mesh, path, spec, _phase0 }

        for (const sat of SATELLITE_REFERENCES) {
            const r = 1 + sat.altitudeKm / R_EARTH_KM;
            // Slight tilt per ring so they don't all overlap on one plane.
            const tilt = (sat.altitudeKm % 31) * Math.PI / 180;
            const ring = _ringMesh(r, 0.004, _hex(sat.color), sat.orbital ? 0.45 : 0.75);
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

            // For orbital objects, also build a moving probe + an
            // inclined orbital-path polyline.
            if (sat.orbital) this._buildSatelliteProbe(sat);
        }
        this._scene.add(this._satGroup);
        this._scene.add(this._satProbeGrp);
    }

    /**
     * Build a moving satellite probe + an inclined orbital-path
     * polyline for one SATELLITE_REFERENCES entry. The probe is
     * tagged kind='sat-probe' (identical handling for every satellite)
     * with `id` carrying the satellite key so click/tooltip can resolve
     * the right spec.
     *
     * Orbital propagation uses the entry's mean elements directly —
     * good enough for a "visualisation-grade" ground track. A live TLE
     * fetch from /api/celestrak/tle can upgrade the elements after boot.
     */
    _buildSatelliteProbe(spec) {
        const colorHex = _hex(spec.color);
        const altKm    = spec.altitudeKm;
        const r        = 1 + altKm / R_EARTH_KM;

        // ── Probe LOD ────────────────────────────────────────────────
        // Three tiers, swapped automatically by THREE.LOD based on
        // camera distance to the probe (in scene units, where 1 = R⊕):
        //
        //   far   (≥ 0.9)  sphere + halo only — the original "dot" look
        //                   from any zoomed-out camera position.
        //   mid   (≥ 0.06) low-poly recognisable shape — solar panels,
        //                   bus, antennas — readable from a few hundred
        //                   km out (artistic scale).
        //   near  (≥ 0)    the same shape (kept as a separate level so
        //                   we can plug a higher-poly variant later).
        //
        // The LOD is the picker target — userData is set on it so a
        // raycast against any of its children resolves up via the
        // .parent chain in _initTooltip.
        const lod = new THREE.LOD();
        lod.userData = {
            kind:    'sat-probe',
            id:      spec.id,
            name:    spec.name,
            altKm,
            color:   spec.color,
            spec,
            tooltip: spec.description ||
                     'Click to fly the camera here. Drag pressure '
                   + '≈ ½ρv² uses live ρ at the probe\'s current altitude.',
        };

        // Far tier: sphere + halo (original look). Wrapped in a Group
        // so the halo stays a child and follows orientation cleanly.
        const farGrp = new THREE.Group();
        const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.012, 14, 10),
            new THREE.MeshBasicMaterial({
                color: colorHex, transparent: true, opacity: 1.0,
            }),
        );
        const halo = new THREE.Mesh(
            new THREE.SphereGeometry(0.026, 14, 10),
            new THREE.MeshBasicMaterial({
                color: colorHex, transparent: true, opacity: 0.25,
                depthWrite: false, blending: THREE.AdditiveBlending,
            }),
        );
        farGrp.add(sphere);
        farGrp.add(halo);

        // Mid + near tiers: recognisable model from satellite-models.js.
        // The high-detail tier is currently identical to mid — kept
        // separate so future poly-count work plugs in cleanly.
        const midGrp = buildSatelliteModel(spec);
        const nearGrp = buildSatelliteModelLow(spec);

        // LOD distance thresholds. Three.js picks the highest-index
        // level whose distance ≤ camera-to-LOD distance; smaller
        // numbers = closer. With camera at ~3.2 R⊕ and probes at
        // ~1.07 R⊕, the default view sees distance ≈ 2.1 → far tier.
        // When the user flies to within ~0.3 R⊕ (≈ 2000 km artistic)
        // we promote to mid; closer than 0.06 R⊕ (≈ 380 km) we render
        // near. Tuned empirically — bump if the swap reads as a pop.
        lod.addLevel(nearGrp, 0);
        lod.addLevel(midGrp,  0.06);
        lod.addLevel(farGrp,  0.30);

        // Seed the probe's position on first paint at one orbital point
        // so it's not stuck at origin until the first animate() tick.
        lod.position.set(r, 0, 0);
        this._satProbeGrp.add(lod);

        // Keep `mesh` as the LOD object — _stepSatellites and the
        // public APIs that read probe.mesh.position keep working.
        const mesh = lod;

        // ── Orbital-path polyline ─────────────────────────────────────
        // 96 points around a full period — closed loop. Drawn in the
        // same satellite-probe group so visibility stays in sync.
        const N = 96;
        const pathPts = new Float32Array(N * 3);
        for (let k = 0; k < N; k++) {
            const tFrac = k / N;
            const p = _propagateKeplerian(spec.orbital, tFrac, r);
            pathPts[k * 3 + 0] = p.x;
            pathPts[k * 3 + 1] = p.y;
            pathPts[k * 3 + 2] = p.z;
        }
        const pathGeo = new THREE.BufferGeometry();
        pathGeo.setAttribute('position', new THREE.BufferAttribute(pathPts, 3));
        const pathMat = new THREE.LineBasicMaterial({
            color: colorHex,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
        });
        const pathLine = new THREE.LineLoop(pathGeo, pathMat);
        pathLine.userData = {
            kind: 'sat-orbit-path', id: spec.id, name: `${spec.name} orbit`,
            color: spec.color, altKm,
            tooltip: `Real-period inclined orbit · i = ${spec.orbital.inclinationDeg}° · `
                   + `period ≈ ${spec.orbital.periodMin.toFixed(1)} min · NORAD ${spec.orbital.noradId}`,
        };
        this._satProbeGrp.add(pathLine);

        // Cache for per-frame propagation. _phase0 randomises the
        // satellite's starting mean-anomaly so all four don't all start
        // at M=0 simultaneously.
        const probe = {
            mesh, pathLine, spec,
            _phase0: spec.orbital.meanAnomalyDeg0 * Math.PI / 180,
            _propTable: null,        // populated immediately below
        };
        this._satProbes[spec.id] = probe;
        // Pre-bake a phase-indexed position lookup so the conjunction
        // screener can do O(1) lookups instead of trig calls per step.
        // 256 samples = 1.4° angular resolution = ~22 s for an ~92-min
        // orbit; fine enough for 30-s-step TCA finding.
        this._buildProbeLookup(probe);
    }

    /**
     * Pre-bake a 256-entry (x, y, z) Float32Array of probe positions
     * sampled evenly around the orbital phase. Used by the conjunction
     * screener — _lookupProbePosition turns simulated-time into a
     * position via a single integer division + array read.
     *
     * Re-run after TLE upgrades (orbital elements change) so the
     * lookup table stays consistent with the live mean elements.
     */
    _buildProbeLookup(probe) {
        const N = 256;
        if (!probe._propTable) probe._propTable = new Float32Array(N * 3);
        const r = 1 + probe.spec.altitudeKm / R_EARTH_KM;
        for (let k = 0; k < N; k++) {
            const tFrac = k / N;
            const p = _propagateKeplerian(probe.spec.orbital, tFrac, r);
            probe._propTable[k * 3 + 0] = p.x;
            probe._propTable[k * 3 + 1] = p.y;
            probe._propTable[k * 3 + 2] = p.z;
        }
        probe._propTableN = N;
    }

    /**
     * Fly the camera to one satellite probe by id. Falls through to
     * the ISS probe if id is omitted (preserves the original
     * .flyToISS() entry point).
     */
    flyToSatellite(id = 'iss', durationSec = 1.6) {
        const probe = this._satProbes?.[id];
        if (!probe) return;
        const pos = probe.mesh.position.clone();
        // Offset behind the velocity-side of the probe so the camera
        // sees it move forward through the layer.
        const radial = pos.clone().normalize();
        const offset = radial.multiplyScalar(0.18);
        const target = pos.clone().add(offset);
        this.flyTo(target, pos, durationSec);
    }

    /** Backwards-compatible wrapper retained for the existing UI button. */
    flyToISS(durationSec = 1.6) {
        return this.flyToSatellite('iss', durationSec);
    }

    /**
     * Fly the camera to a specific debris piece by index. Position
     * comes from the cloud's flat position buffer (not a per-piece
     * mesh) since debris are rendered as a single THREE.Points draw
     * call. Also auto-switches into fly mode so the camera anim
     * doesn't get clamped back to the planet centre by OrbitControls.
     */
    flyToDebris(idx, durationSec = 1.6) {
        if (!this._debrisPositions || !this._debris?.[idx]) return;
        const p = this._debrisPositions;
        const o = idx * 3;
        const debrisPos = new THREE.Vector3(p[o], p[o + 1], p[o + 2]);
        const radial = debrisPos.clone().normalize();
        const offset = radial.multiplyScalar(0.18);
        const target = debrisPos.clone().add(offset);
        if (this._controls.getMode?.() === 'orbit') {
            this._controls.setMode('fly');
        }
        this.flyTo(target, debrisPos, durationSec);
    }

    /**
     * Upgrade every orbital probe from hardcoded mean elements to the
     * live TLE for that NORAD ID. Hits the same /api/celestrak/tle
     * Edge proxy that the rest of the repo uses; the proxy parses the
     * raw TLE into { inclination, raan, arg_perigee, mean_anomaly,
     * mean_motion, eccentricity, epoch, period_min, ... } so we don't
     * need to parse anything ourselves.
     *
     * Per satellite:
     *   1. Fetch /api/celestrak/tle?norad=<id>
     *   2. Compute the *current* mean anomaly:
     *        M_now = M_epoch + n · (now − epoch)
     *      where n is the mean motion in rad/s. This pins the probe
     *      to its real orbital position at page-boot time; subsequent
     *      per-frame propagation continues from there.
     *   3. Replace the spec.orbital block in place + rebuild the
     *      orbital-path polyline geometry from the new elements so
     *      visual track + sprite stay coherent.
     *
     * Doesn't apply J2 secular drift to RAAN/argP between epoch and
     * now — for typical TLEs <1 day old this is sub-degree on RAAN
     * for ISS, fine for visual-grade fidelity. A future round can
     * add the Brouwer-Lyddane secular terms if the precision matters.
     *
     * Concurrent fetches via Promise.allSettled — one slow satellite
     * doesn't block the others. Returns the count of upgraded probes
     * for the UI's freshness indicator.
     */
    async _fetchLiveTLEs() {
        if (!this._satProbes) return 0;
        const probes = Object.values(this._satProbes)
            .filter(p => p.spec?.orbital?.noradId);

        const fetchOne = async (probe) => {
            const id = probe.spec.orbital.noradId;
            const ctl = new AbortController();
            const t = setTimeout(() => ctl.abort(), 4000);
            try {
                const r = await fetch(`/api/celestrak/tle?norad=${id}`, {
                    signal: ctl.signal,
                    headers: { Accept: 'application/json' },
                });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const data = await r.json();
                const sat = data?.satellites?.[0];
                if (!sat) throw new Error('no satellites in response');
                this._upgradeProbeFromTLE(probe, sat);
                return { id: probe.spec.id, ok: true };
            } catch (err) {
                return { id: probe.spec.id, ok: false, err };
            } finally {
                clearTimeout(t);
            }
        };

        const results = await Promise.allSettled(probes.map(fetchOne));
        const ok = results.filter(r => r.value?.ok).length;
        // Stash a manifest so the UI's freshness pill knows what's live
        // vs fallback. window event so the UI module doesn't need an
        // explicit hook into globe internals.
        this._tleSummary = {
            total:    probes.length,
            live:     ok,
            fetchedAt: Date.now(),
        };
        try {
            window.dispatchEvent(new CustomEvent('ua-tle-update',
                { detail: this._tleSummary }));
        } catch (_) { /* SSR / no-window — ignore */ }
        return ok;
    }

    /**
     * Apply one parsed TLE to one probe in place. Splits out from the
     * fetch loop so unit tests / future scheduled-refresh paths can
     * call it directly with a mock element set.
     *
     * @param {object} probe   from this._satProbes[id]
     * @param {object} sat     parsed CelesTrak entry — see
     *                         api/celestrak/tle.js parseSingleTle()
     */
    _upgradeProbeFromTLE(probe, sat) {
        const orb = probe.spec.orbital;
        const epochMs = Date.parse(sat.epoch);
        if (!Number.isFinite(epochMs)) return;

        // Mean motion: rev/day → rad/s.
        const n_rad_s = (sat.mean_motion * 2 * Math.PI) / 86400;
        const dtSec = (Date.now() - epochMs) / 1000;
        // Wrap to [0, 2π) so the propagator's tFrac stays clean.
        let M_now_rad = (sat.mean_anomaly * Math.PI / 180) + n_rad_s * dtSec;
        const TAU = 2 * Math.PI;
        M_now_rad = ((M_now_rad % TAU) + TAU) % TAU;

        // Patch the orbital element block. Keep noradId; replace the
        // mean elements + period from the live TLE.
        orb.inclinationDeg   = sat.inclination;
        orb.raanDeg          = sat.raan;
        orb.argPerigeeDeg    = sat.arg_perigee;
        orb.eccentricity     = sat.eccentricity;
        orb.meanAnomalyDeg0  = M_now_rad * 180 / Math.PI;
        orb.periodMin        = sat.period_min;

        // Update the average altitude from apogee/perigee — used by
        // the orbital-path polyline radius and the static ring. For
        // near-circular orbits this is essentially unchanged; for
        // eccentric orbits this is a sensible "shell" altitude.
        const meanAltKm = (sat.apogee_km + sat.perigee_km) / 2;
        if (Number.isFinite(meanAltKm) && meanAltKm > 0) {
            probe.spec.altitudeKm = Math.round(meanAltKm);
        }

        // Reset the per-frame phase to "now" — propagation in
        // _stepSatellites uses _phase0 as the M at elapsedSec=0.
        probe._phase0 = M_now_rad;

        // Carry the source + epoch into the probe's userData so the
        // tooltip + drag panel can show TLE freshness.
        if (probe.mesh?.userData) {
            probe.mesh.userData.tleSource = 'live';
            probe.mesh.userData.tleEpoch  = sat.epoch;
        }

        // Rebuild the orbital-path polyline from the new elements.
        this._refreshOrbitalPath(probe);
        // And the conjunction-screener lookup table — its sampling is
        // tied to the orbital elements, so a TLE update means stale
        // entries until we regenerate.
        this._buildProbeLookup(probe);
    }

    /**
     * Re-sample the orbital-path polyline for one probe using its
     * current spec.orbital. Cheap (96 points, no allocations) so
     * we can call it any time elements change.
     */
    _refreshOrbitalPath(probe) {
        const path = probe.pathLine;
        if (!path) return;
        const positions = path.geometry.attributes.position.array;
        const N = positions.length / 3;
        const r = 1 + probe.spec.altitudeKm / R_EARTH_KM;
        for (let k = 0; k < N; k++) {
            const tFrac = k / N;
            const p = _propagateKeplerian(probe.spec.orbital, tFrac, r);
            positions[k * 3 + 0] = p.x;
            positions[k * 3 + 1] = p.y;
            positions[k * 3 + 2] = p.z;
        }
        path.geometry.attributes.position.needsUpdate = true;
        path.geometry.computeBoundingSphere();
    }

    /**
     * Read the live-TLE summary set by _fetchLiveTLEs. Returns
     * { total, live, fetchedAt } or null if no fetch has resolved yet.
     * UI uses this to paint the "Live TLE · 2h ago" freshness pill.
     */
    getTleSummary() {
        return this._tleSummary || null;
    }

    // ── LEO debris cloud ──────────────────────────────────────────────────
    //
    // Background hazards drawn as a single THREE.Points cloud (one
    // draw call regardless of count). Each piece is propagated with
    // the same phase-indexed lookup-table machinery the named probes
    // use. They feed the conjunction screener so the asset-vs-debris
    // risk surfaces in the panel.
    //
    // Visualization-grade only — operational risk modelling needs the
    // full ~30k-object catalog (see js/satellite-tracker.js). 50 dots
    // gives users visible LEO context without the Kessler-syndrome
    // cost of a quadratic 4-asset × 30k debris screen.

    async _loadDebrisSample({ count = 200 } = {}) {
        let records;
        try {
            // Widened to 250–1500 km so the sample spans the major
            // debris-rich shells: ISS (400 km), Cosmos 1408 cloud
            // (480 km), Starlink (550 km), Iridium-33/Cosmos-2251
            // (790 km), Fengyun-1C (850 km), and OneWeb (1200 km).
            // Sample size bumped from 50 → 200 so each family gets
            // a visible footprint without flooding the screener.
            records = await fetchDebrisSample({ count, altMinKm: 250, altMaxKm: 1500 });
        } catch (err) {
            console.debug('[upper-atmosphere] debris fetch failed:', err?.message || err);
            return;
        }
        if (!records?.length) return;

        // Build one probe entry per debris record. Each gets:
        //   • Spec block with orbital + epoch
        //   • _phase0 set to *current* M (M_epoch + n·dt) so the dot
        //     starts where it should be in real-world right now.
        //   • _propTable for O(1) screener lookup.
        // They live in this._debris (parallel to _satProbes) so they
        // don't pollute satellite drag analysis or the named-probe
        // tooltip pipeline.
        const debris = [];
        for (const rec of records) {
            const probe = this._buildDebrisProbe(rec);
            if (probe) debris.push(probe);
        }
        this._debris = debris;
        if (!debris.length) return;

        this._buildDebrisCloud(debris);
        // Re-screen now that we have debris in scope.
        this._screenConjunctions();
        try {
            window.dispatchEvent(new CustomEvent('ua-debris-update', {
                detail: { count: debris.length },
            }));
        } catch (_) { /* SSR / no-window — ignore */ }
    }

    /**
     * Build one debris probe from a parsed CelesTrak record. Computes
     * M_now from epoch + mean motion (same convention as
     * _upgradeProbeFromTLE), bakes the lookup table, and returns the
     * probe entry. Returns null when the record has bogus elements.
     */
    _buildDebrisProbe(rec) {
        const orb = rec.orbital;
        const epochMs = orb.epoch ? Date.parse(orb.epoch) : NaN;
        if (!Number.isFinite(epochMs) || !Number.isFinite(orb.meanMotionRevPerDay)) {
            return null;
        }
        const n_rad_s = (orb.meanMotionRevPerDay * 2 * Math.PI) / 86400;
        const dtSec   = (Date.now() - epochMs) / 1000;
        const TAU = 2 * Math.PI;
        let M_now = (orb.meanAnomalyDeg0 * Math.PI / 180) + n_rad_s * dtSec;
        M_now = ((M_now % TAU) + TAU) % TAU;

        // Family + size attribution. The catalog assigns:
        //   _family   — known fragmentation event or generic-debris
        //   _size     — small / medium / large (mass + RCS estimate)
        //   _hazardMJ — kinetic energy at typical LEO closing speed
        // Used downstream by the debris cloud (per-vertex color),
        // tooltips, and the family roll-up panel.
        const annot = annotateDebris(rec);

        const probe = {
            spec: {
                id: rec.id,
                name: rec.name,
                // Override the engine's generic pink with the family
                // color so the cloud reads as "debris by source event".
                color: annot.family.color,
                altitudeKm: rec.altitudeKm,
                orbital: { ...orb, meanAnomalyDeg0: M_now * 180 / Math.PI },
            },
            _phase0: M_now,
            _propTable: null,
            _propTableN: 0,
            _kind: 'debris',
            _family: annot.family,
            _size:   annot.size,
            _hazardMJ: annot.hazardMJ,
            mesh: null,           // debris are points in a shared cloud, not individual meshes
        };
        this._buildProbeLookup(probe);
        return probe;
    }

    /**
     * Build a single THREE.Points cloud for the debris. One draw call
     * regardless of count; per-frame _stepDebris updates positions
     * from the cached lookup tables.
     */
    _buildDebrisCloud(debris) {
        const N = debris.length;
        const positions = new Float32Array(N * 3);
        // Per-vertex color: each debris point inherits its family's
        // signature color from debris-catalog.js. The PointsMaterial
        // is set to vertexColors so the cloud reads as a heatmap of
        // source events instead of a uniform pink swarm.
        const colors    = new Float32Array(N * 3);
        // Per-vertex point size — large rocket bodies render bigger
        // than small ASAT shrapnel, giving a visual hazard hierarchy.
        const sizes     = new Float32Array(N);

        // Seed with current positions so first paint isn't at origin.
        const ts = this.opts.satTimeScale ?? this.opts.issTimeScale ?? 60;
        const tNowSim = (this._clock?.getElapsedTime?.() ?? 0) * ts;
        const _tmpColor = new THREE.Color();
        for (let i = 0; i < N; i++) {
            const p = _lookupProbePosition(debris[i], tNowSim);
            positions[i * 3]     = p.x;
            positions[i * 3 + 1] = p.y;
            positions[i * 3 + 2] = p.z;

            const fam = debris[i]._family;
            _tmpColor.set(fam?.color || '#ff7099');
            colors[i * 3]     = _tmpColor.r;
            colors[i * 3 + 1] = _tmpColor.g;
            colors[i * 3 + 2] = _tmpColor.b;

            sizes[i] = debris[i]._size?.pointPx ?? 0.014;
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geom.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
        const mat = new THREE.PointsMaterial({
            vertexColors: true,
            size:         0.014,             // base size; per-vertex via sizes via shader is overkill
            sizeAttenuation: true,
            transparent: true,
            opacity:     0.85,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });
        if (this._debrisCloud) {
            // Re-load: dispose the old.
            this._satProbeGrp?.remove(this._debrisCloud);
            this._debrisCloud.geometry.dispose();
            this._debrisCloud.material.dispose();
        }
        this._debrisCloud = new THREE.Points(geom, mat);
        this._debrisCloud.frustumCulled = false;
        this._debrisCloud.userData = {
            kind: 'debris-cloud',
            id:   'debris',
            name: `LEO debris sample (n=${N})`,
            tooltip: 'Random sample of CelesTrak debris in the 350–900 km '
                   + 'altitude band. Visualization context only — full '
                   + 'risk modelling needs the complete catalog.',
        };
        this._debrisPositions = positions;
        this._satProbeGrp.add(this._debrisCloud);
    }

    /**
     * Per-frame debris position update. Uses the same simulated-time
     * axis as _stepSatellites so debris and assets stay coherent.
     */
    _stepDebris(t) {
        if (!this._debris?.length || !this._debrisPositions) return;
        const ts = this.opts.satTimeScale ?? this.opts.issTimeScale ?? 60;
        const tNowSim = t * ts;
        const pos = this._debrisPositions;
        for (let i = 0; i < this._debris.length; i++) {
            const p = _lookupProbePosition(this._debris[i], tNowSim);
            const o = i * 3;
            pos[o]     = p.x;
            pos[o + 1] = p.y;
            pos[o + 2] = p.z;
        }
        this._debrisCloud.geometry.attributes.position.needsUpdate = true;
    }

    /** Count of currently-tracked debris pieces. UI uses this for the
     *  panel header. Returns 0 if the fetch hasn't resolved yet. */
    getDebrisCount() { return this._debris?.length ?? 0; }

    /**
     * Roll-up of the loaded debris sample by source-event family.
     * Each entry is { family, count, mediumEnergyMJ }, sorted by count
     * desc. Used by the Debris Families UI panel.
     */
    getDebrisFamilyBreakdown() {
        return summariseByFamily(this._debris || []);
    }

    /**
     * Returns metadata for the i-th debris piece — used by the tooltip
     * pipeline (which has the index from the picked vertex). The
     * shape mirrors what the conjunction-watch row needs:
     *   { name, noradId, altKm, family:{id,name,color,year},
     *     size:{class,rangeM,massKg}, hazardMJ }
     */
    getDebrisMetaByIndex(idx) {
        const d = this._debris?.[idx];
        if (!d) return null;
        return {
            name:      d.spec.name,
            noradId:   d.spec.orbital?.noradId,
            altKm:     d.spec.altitudeKm,
            family:    d._family
                ? { id: d._family.id, name: d._family.name,
                    color: d._family.color, year: d._family.year }
                : null,
            size:      d._size
                ? { class: d._size.class, rangeM: d._size.rangeM,
                    massKg: d._size.massKg }
                : null,
            hazardMJ:  d._hazardMJ ?? 0,
        };
    }

    // ── Constellation overlays ───────────────────────────────────────────
    //
    // Render one or more major constellations as faint distinct point
    // clouds. Each constellation gets its own THREE.Points so toggling
    // is a single mesh.visible flip. Positions come from
    // constellation-catalog.js's spawnConstellationPositions(), which
    // synthesises Walker-Delta element sets — no live TLE fetch.
    //
    // Operational modelling needs the live catalog (see
    // js/satellite-tracker.js); these overlays exist purely to give
    // the user spatial intuition for "where do the big constellations
    // live, relative to my orbit + the debris clouds."

    /**
     * Toggle a constellation overlay on/off. Lazily builds the cloud
     * on first enable and caches it; subsequent toggles are O(1). When
     * the constellation has a `.meo: true` flag (GPS / Galileo /
     * GLONASS / BeiDou), the cloud is built but the camera distance
     * may need expanding to see it — we don't move the camera here.
     *
     * @param {string} id          constellation id (see CONSTELLATIONS)
     * @param {boolean} visible
     * @returns {boolean}          whether the call succeeded
     */
    setConstellationVisible(id, visible) {
        const c = CONSTELLATIONS.find(c => c.id === id);
        if (!c) return false;
        this._constellationClouds = this._constellationClouds || {};
        let cloud = this._constellationClouds[id];
        if (!cloud && visible) {
            cloud = this._buildConstellationCloud(c);
            this._constellationClouds[id] = cloud;
        }
        if (cloud) cloud.cloud.visible = visible;
        return true;
    }

    /** Returns a list of constellation ids currently visible. */
    getConstellationsVisible() {
        const out = [];
        const all = this._constellationClouds || {};
        for (const id in all) if (all[id].cloud.visible) out.push(id);
        return out;
    }

    /**
     * Build a {cloud, probes} entry for one constellation. Each probe
     * has the same shape as a debris probe (with _kind = 'sat'), so
     * the per-frame _stepConstellations loop can drive it through the
     * standard _lookupProbePosition pathway.
     */
    _buildConstellationCloud(c) {
        const recs = spawnConstellationPositions(c);
        const probes = recs.map(rec => {
            const orb = rec.orbital;
            const TAU = 2 * Math.PI;
            const M_now = ((orb.meanAnomalyDeg0 * Math.PI / 180) % TAU + TAU) % TAU;
            const probe = {
                spec: {
                    id: rec.id,
                    name: c.name,
                    color: rec.color,
                    altitudeKm: rec.altitudeKm,
                    orbital: { ...orb, meanAnomalyDeg0: M_now * 180 / Math.PI },
                },
                _phase0: M_now,
                _propTable: null,
                _propTableN: 0,
                _kind: 'constellation',
                _constellationId: c.id,
                mesh: null,
            };
            this._buildProbeLookup(probe);
            return probe;
        });

        const N = probes.length;
        const positions = new Float32Array(N * 3);
        const ts = this.opts.satTimeScale ?? this.opts.issTimeScale ?? 60;
        const tNowSim = (this._clock?.getElapsedTime?.() ?? 0) * ts;
        for (let i = 0; i < N; i++) {
            const p = _lookupProbePosition(probes[i], tNowSim);
            positions[i * 3]     = p.x;
            positions[i * 3 + 1] = p.y;
            positions[i * 3 + 2] = p.z;
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.PointsMaterial({
            color:       new THREE.Color(c.color),
            size:        0.012,
            sizeAttenuation: true,
            transparent: true,
            opacity:     0.55,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });
        const cloud = new THREE.Points(geom, mat);
        cloud.frustumCulled = false;
        cloud.userData = {
            kind: 'constellation',
            id:   c.id,
            name: `${c.name} (${c.operator}) — ${c.countActive} active`,
            tooltip: `${c.name}: ${c.summary}`,
        };
        // Mount on the same group as debris so it inherits any
        // global toggling we add later.
        this._satProbeGrp.add(cloud);

        return { cloud, probes, positions };
    }

    /** Per-frame: advance every visible constellation cloud's points. */
    _stepConstellations(t) {
        const all = this._constellationClouds;
        if (!all) return;
        const ts = this.opts.satTimeScale ?? this.opts.issTimeScale ?? 60;
        const tNowSim = t * ts;
        for (const id in all) {
            const entry = all[id];
            if (!entry.cloud.visible) continue;
            const probes = entry.probes;
            const pos = entry.positions;
            for (let i = 0; i < probes.length; i++) {
                const p = _lookupProbePosition(probes[i], tNowSim);
                const o = i * 3;
                pos[o]     = p.x;
                pos[o + 1] = p.y;
                pos[o + 2] = p.z;
            }
            entry.cloud.geometry.attributes.position.needsUpdate = true;
        }
    }

    /**
     * Build the hover-highlight ring used to disambiguate which dot
     * the tooltip is describing. 50 pink dots all look the same; the
     * cyan reticle gives the user a clear visual anchor. Ring orients
     * perpendicular to the view direction each frame (always face-on)
     * + pulses subtly so the eye lands on it immediately.
     */
    _buildDebrisHighlight() {
        const geom = new THREE.TorusGeometry(0.025, 0.0028, 8, 32);
        const mat  = new THREE.MeshBasicMaterial({
            color:       0x00ffe6,
            transparent: true,
            opacity:     0.0,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });
        this._debrisHighlight = new THREE.Mesh(geom, mat);
        this._debrisHighlight.visible = false;
        this._debrisHighlight.frustumCulled = false;
        this._debrisHighlight.userData = {
            kind:    'debris-highlight',
            tooltip: 'Currently-hovered debris piece.',
        };
        this._scene.add(this._debrisHighlight);
    }

    /**
     * Per-frame: keep the highlight ring stuck to the hovered debris
     * piece's live position + face-on to the camera. Reads
     * _hoveredDebrisIdx (set by the tooltip pipeline) and pulses the
     * ring scale slightly to draw the eye.
     */
    _updateDebrisHighlight(elapsedSec) {
        if (!this._debrisHighlight) return;
        const idx = this._hoveredDebrisIdx;
        if (!Number.isFinite(idx) || !this._debrisPositions
            || !this._debris?.[idx]) {
            // Smoothly fade out instead of hard-hide so the ring
            // doesn't pop when the cursor leaves the dot.
            const m = this._debrisHighlight.material;
            m.opacity = Math.max(0, m.opacity - 0.12);
            this._debrisHighlight.visible = m.opacity > 0.01;
            return;
        }
        const o = idx * 3;
        const p = this._debrisPositions;
        this._debrisHighlight.position.set(p[o], p[o + 1], p[o + 2]);
        // Face-on to the camera: ring plane perpendicular to view ray.
        this._debrisHighlight.lookAt(this._camera.position);
        // Subtle pulse — sin(2π · 1.4 Hz · t) at ±10 % scale.
        const s = 1 + 0.10 * Math.sin(elapsedSec * 8.8);
        this._debrisHighlight.scale.setScalar(s);
        const m = this._debrisHighlight.material;
        m.opacity = Math.min(0.9, m.opacity + 0.18);
        this._debrisHighlight.visible = true;
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
        // Bumped from 8 → 64 streamers for a denser, more textured
        // sunward flow. Each streamer is a multi-segment polyline with
        // a subtle Parker-spiral curl + per-strand jitter so the
        // cluster doesn't read as a wheel of straight spokes.
        const N_FLUX = 64;
        const SEG    = 16;          // segments per streamer
        const streamerStarts = _streamerStartPoints(N_FLUX, bs0.r0 + 4);
        const tooltipText = 'Bulk plasma flow from the Sun. Brightness ∝ dynamic pressure ρv²; flow rate ∝ speed.';
        for (let si = 0; si < streamerStarts.length; si++) {
            const s = streamerStarts[si];
            // Bow-shock approach point — converge slightly toward the
            // sun-Earth axis but never to zero so streamers don't
            // bunch into a single line at the nose.
            const yEnd = bs0.r0 * 0.95;
            const xEnd = s.x * 0.20;
            const zEnd = s.z * 0.20;

            // Parker-spiral hint — small azimuthal twist proportional
            // to streamer arrival distance. Sign jittered so adjacent
            // strands curl opposite ways and visually braid.
            const sign = (si % 2 === 0) ? 1 : -1;
            const twistAmp = 0.22 * sign * (0.7 + 0.6 * Math.random());

            const positions = new Float32Array(SEG * 3);
            const progress  = new Float32Array(SEG);
            for (let i = 0; i < SEG; i++) {
                const t = i / (SEG - 1);
                // Linear interpolate sunward → Earth, then add the
                // twist as an azimuthal offset around the sun-Earth
                // axis (+Y in solar-group frame).
                const x0 = s.x + (xEnd - s.x) * t;
                const y0 = s.y + (yEnd - s.y) * t;
                const z0 = s.z + (zEnd - s.z) * t;
                // Twist grows from 0 at the source to a peak around
                // mid-flight then relaxes near the bow shock — the
                // shape Parker-spiral streamers actually take in the
                // inner heliosphere.
                const tw = twistAmp * Math.sin(Math.PI * t);
                const c = Math.cos(tw), sn = Math.sin(tw);
                const x1 = x0 * c - z0 * sn;
                const z1 = x0 * sn + z0 * c;
                positions[i * 3 + 0] = x1;
                positions[i * 3 + 1] = y0;
                positions[i * 3 + 2] = z1;
                progress[i] = t;
            }
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position',  new THREE.BufferAttribute(positions, 3));
            geom.setAttribute('aProgress', new THREE.BufferAttribute(progress, 1));
            const line = new THREE.Line(geom, this._streamMat);
            line.userData = {
                kind:    'flux-stream',
                id:      'flux-stream',
                name:    'Solar-wind flux',
                tooltip: tooltipText,
            };
            this._streamGroup.add(line);
        }
        this._swGroup.add(this._streamGroup);

        // ── Heliospheric current sheet (faint disc) ─────────────────────
        // Thin equatorial sheet along the solar-wind flow plane. Reads
        // as a soft pink-orange wash that traces the wavy ballerina-
        // skirt geometry. Cheap — one ring mesh; fragment shader does
        // the radial fade.
        const sheetGeo = new THREE.RingGeometry(2.5, bs0.r0 + 2, 96, 1);
        const sheetMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: new THREE.Color(0xff9c66) },
                uTime:  { value: 0 },
            },
            vertexShader: /* glsl */`
                varying vec2 vUv;
                varying vec3 vPosL;
                void main() {
                    vUv = uv;
                    vPosL = position;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: /* glsl */`
                precision highp float;
                uniform vec3  uColor;
                uniform float uTime;
                varying vec2  vUv;
                varying vec3  vPosL;
                void main() {
                    // Distance from the sun-Earth axis (+Y) → ring radius.
                    float r = length(vPosL.xz);
                    // Ballerina-skirt waviness — gentle azimuthal warp.
                    float az = atan(vPosL.z, vPosL.x);
                    float warp = sin(az * 4.0 + uTime * 0.4) * 0.5 + 0.5;
                    // Radial taper: brighter near the disc, falling to
                    // zero at both inner & outer edges.
                    float radial = smoothstep(2.5, 4.0, r) * (1.0 - smoothstep(8.0, 14.0, r));
                    float a = 0.10 * radial * (0.5 + 0.5 * warp);
                    gl_FragColor = vec4(uColor, a);
                }
            `,
            transparent: true,
            side:        THREE.DoubleSide,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });
        const sheet = new THREE.Mesh(sheetGeo, sheetMat);
        // RingGeometry is in the XY plane — rotate so it lies in the
        // XZ plane (the sun-aligned group's equatorial plane).
        sheet.rotation.x = Math.PI / 2;
        sheet.userData = {
            kind:    'current-sheet',
            id:      'helio-current-sheet',
            name:    'Heliospheric current sheet',
            tooltip: 'Wavy equatorial boundary in the interplanetary magnetic field; the "ballerina skirt".',
        };
        this._currentSheetMat = sheetMat;
        this._swGroup.add(sheet);

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
     * Build the dipole magnetic-field cascade — a set of L-shell field
     * lines carrying an animated EUV/precipitation packet train from
     * the magnetopause down to the auroral oval and the polar cusps.
     * Drives intensity from the live (F10.7, Ap, Bz) state via
     * setState(), which is called from setState() on the globe.
     */
    _buildMagneticCascade() {
        this._cascade = new MagneticCascade({
            parent:    this._scene,
            intensity: 0.45,
            sunDir:    this._sunDir,
        });
        // Apply the climatology so first paint shows a baseline cascade
        // even before setState() arrives.
        this._cascade.setState({ f107: 150, ap: 15 });

        // Substorm state machine — drives the growth → expansion →
        // recovery animation. 'demo' mode walks through a substorm
        // in ~30 s wall-clock; auto-triggered when the cumulative
        // southward-Bz drive (substorm-index proxy) crosses 0.6.
        this._substorm = new SubstormController({ mode: 'demo' });

        // Local accumulator of southward-Bz drive — fed into the
        // controller as a substorm-index proxy. Re-evaluated whenever
        // setState() pushes a fresh (Ap, Bz) tuple.
        this._bzDriveAccum = 0;
    }

    /**
     * Manually trigger a substorm. Returns true on success (controller
     * was IDLE), false if a substorm is already in progress.
     */
    triggerSubstorm(opts) {
        return this._substorm?.trigger(opts) ?? false;
    }
    /** Force-end any in-progress substorm. */
    resetSubstorm() { this._substorm?.reset(); }
    /** 'demo' (compressed ~30 s) or 'realtime' (literal-minutes timing). */
    setSubstormMode(mode) { this._substorm?.setMode(mode); }
    /** Toggle the auto-trigger from substorm-index threshold. */
    setSubstormAuto(v) { this._substorm?.setAutoEnabled(v); }

    /**
     * Build the sun: a hot inner core + a soft halo + 24 outgoing
     * radial streamers that read as photon emission. F10.7 modulates
     * the corona brightness + streamer length so users see "active
     * sun" vs "quiet sun" at a glance. Mounted in the solar group so
     * "+Y == sunward" alignment is automatic.
     */
    _buildSun(bs0) {
        const sunDistance = bs0.r0 + 8;
        // Multi-layer Sun: photosphere → chromosphere → corona →
        // outer corona. Each layer is a separate sphere mesh with its
        // own material so the layered fresnel additive blend reads as
        // real depth rather than a single flat halo. Sized in scene
        // units (Earth radii); not to true scale — the real Sun is
        // ~109 R⊕ wide but we keep it visually marker-sized so it
        // fits in frame next to Earth's magnetosphere.
        const photoR    = 0.55;   // visible "surface"
        const chromoR   = 0.72;   // tight reddish ring
        const coronaR   = 1.50;   // mid-corona glow
        const outerR    = 2.80;   // wide blue-white halo

        const sunUserData = {
            kind:    'sun-marker',
            id:      'sun',
            name:    'Sun',
            tooltip: 'Solar emission source. Photosphere granulation, '
                   + 'chromosphere ring, and multi-layer corona. '
                   + 'Brightness + streamer length scale with F10.7 '
                   + '(10.7-cm radio flux, an EUV proxy used by NRL-MSIS).',
        };

        // ── Photosphere — granulated, limb-darkened disc ────────────
        const photoMat = new THREE.ShaderMaterial({
            uniforms: {
                uTime:      { value: 0 },
                uIntensity: { value: 1.0 },
                uHot:       { value: new THREE.Color(0xfff5d8) },
                uCool:      { value: new THREE.Color(0xff8a30) },
            },
            vertexShader:   SUN_VERT,
            fragmentShader: SUN_FRAG,
            depthWrite:     true,
        });
        const photo = new THREE.Mesh(
            new THREE.SphereGeometry(photoR, 64, 48),
            photoMat,
        );
        photo.userData = sunUserData;

        // ── Chromosphere — thin reddish-pink shell hugging the disc ─
        const chromoMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor:     { value: new THREE.Color(0xff5530) },
                uRimColor:  { value: new THREE.Color(0xff9870) },
                uBaseAlpha: { value: 0.22 },
                uRimPower:  { value: 2.4 },
                uIntensity: { value: 1.0 },
                uTime:      { value: 0 },
            },
            vertexShader:   CORONA_VERT,
            fragmentShader: CORONA_FRAG,
            transparent:    true,
            side:           THREE.DoubleSide,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });
        const chromo = new THREE.Mesh(
            new THREE.SphereGeometry(chromoR, 48, 32),
            chromoMat,
        );
        chromo.userData = sunUserData;

        // ── Mid corona — yellow-white, fbm filaments ────────────────
        const coronaMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor:     { value: new THREE.Color(0xffd070) },
                uRimColor:  { value: new THREE.Color(0xffeec0) },
                uBaseAlpha: { value: 0.16 },
                uRimPower:  { value: 1.7 },
                uIntensity: { value: 1.0 },
                uTime:      { value: 0 },
            },
            vertexShader:   CORONA_VERT,
            fragmentShader: CORONA_FRAG,
            transparent:    true,
            side:           THREE.DoubleSide,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });
        const corona = new THREE.Mesh(
            new THREE.SphereGeometry(coronaR, 48, 32),
            coronaMat,
        );
        corona.userData = sunUserData;

        // ── Outer corona — wide cool halo, near-transparent ─────────
        const outerMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor:     { value: new THREE.Color(0xffe8c8) },
                uRimColor:  { value: new THREE.Color(0xb0d8ff) },
                uBaseAlpha: { value: 0.05 },
                uRimPower:  { value: 2.6 },
                uIntensity: { value: 1.0 },
                uTime:      { value: 0 },
            },
            vertexShader:   CORONA_VERT,
            fragmentShader: CORONA_FRAG,
            transparent:    true,
            side:           THREE.DoubleSide,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });
        const outer = new THREE.Mesh(
            new THREE.SphereGeometry(outerR, 36, 24),
            outerMat,
        );
        outer.userData = sunUserData;

        // ── Outgoing radial streamers — Fibonacci sphere ────────────
        // Bumped from 24 → 56 strands and each carries a slight curl
        // off-axis so the cluster reads as a textured photon flow
        // rather than a regular wheel of spokes.
        const N_STREAMS = 56;
        const streamMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor:     { value: new THREE.Color(0xffe4a0) },
                uTime:      { value: 0 },
                uIntensity: { value: 0.7 },
                uSpeed:     { value: -0.28 },     // negative → flow outward
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
            // Curl factor — small per-strand offset so the tip drifts
            // off the radial line. Amount alternates ± so neighbours
            // visually braid rather than radiate uniformly.
            const sign = (i % 2 === 0) ? 1 : -1;
            const curl = 0.18 * sign;
            const tx = -dz * curl;
            const tz =  dx * curl;
            const tipLen = 2.0 + 1.4 * Math.random();   // jittered length
            const positions = new Float32Array([
                dx * photoR, dy * photoR, dz * photoR,
                (dx + tx) * (photoR + tipLen), dy * (photoR + tipLen), (dz + tz) * (photoR + tipLen),
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

        // ── Sun group — bundle photosphere + halos + streamers ──────
        const sunGroup = new THREE.Group();
        sunGroup.add(photo);
        sunGroup.add(chromo);
        sunGroup.add(corona);
        sunGroup.add(outer);
        sunGroup.add(streamGroup);
        sunGroup.position.set(0, sunDistance, 0);

        // Cache references for setF107 + animate.
        this._sunMarker      = sunGroup;
        this._sunPhotoMat    = photoMat;
        this._sunChromoMat   = chromoMat;
        this._sunCoreMat     = photoMat;       // legacy alias for setF107
        this._sunHaloMat     = coronaMat;
        this._sunOuterMat    = outerMat;
        this._sunStreamMat   = streamMat;
        this._sunStreamGroup = streamGroup;
        this._swGroup.add(sunGroup);
    }

    /**
     * Drive the sun's emission visuals from the solar-flux index
     * (F10.7 in SFU). Quiet-sun ≈ 70 SFU; cycle-max ≈ 250–300. Maps
     * to streamer brightness, halo glow, and core size.
     */
    setF107(f107Sfu) {
        const f = Number.isFinite(f107Sfu) ? f107Sfu : 150;
        const q = Math.max(0, Math.min(1, (f - 65) / (300 - 65)));   // 0..1
        if (this._sunChromoMat) this._sunChromoMat.uniforms.uIntensity.value = 0.65 + 0.70 * q;
        if (this._sunHaloMat)   this._sunHaloMat.uniforms.uIntensity.value   = 0.55 + 0.95 * q;
        if (this._sunOuterMat)  this._sunOuterMat.uniforms.uIntensity.value  = 0.40 + 0.90 * q;
        if (this._sunStreamMat) this._sunStreamMat.uniforms.uIntensity.value = 0.35 + 1.10 * q;
        // Photosphere intensity ramp — the granulation stays the same
        // but the overall brightness rises with activity.
        if (this._sunPhotoMat) {
            this._sunPhotoMat.uniforms.uIntensity.value = 0.85 + 0.45 * q;
        }
        // Stream group scales radially so high F10.7 = longer EUV reach.
        if (this._sunStreamGroup) {
            const s = 0.85 + 0.65 * q;
            this._sunStreamGroup.scale.setScalar(s);
        }
    }

    /**
     * Refresh the world-frame sun direction from the current sub-solar
     * point so the day/night terminator on Earth and the Sun graphic in
     * the solar-wind group track real time. Cheap (one trig call + a
     * quaternion + a few uniform copies) so we run it every frame.
     */
    _updateSunRealTime() {
        const ssp = subSolarPoint(new Date());
        // Skin: only push uniform updates when the angle has actually
        // moved meaningfully (>0.01° ≈ 1.7e-4 rad). Sub-solar drift is
        // ≈15°/hour so this still fires several times a minute.
        const next = _subSolarToVec3(ssp.lat, ssp.lon);
        if (!this._sunDir) this._sunDir = next;
        else {
            // copy in place so consumers that captured the reference
            // (EarthSkin uniform, layer shells, particle systems, etc.)
            // see the new value without us having to re-push.
            this._sunDir.copy(next);
        }
        // EarthSkin holds its own clone — push the update so the
        // shader's u_sun_dir matches.
        this._skin?.setSunDir?.(this._sunDir);
        // Layer shells: each material owns its own uSunDir clone.
        if (this._shells) {
            for (const sh of this._shells) {
                sh.material.uniforms.uSunDir?.value.copy(this._sunDir);
            }
        }
        // Particle systems & vector fields use the sun direction for
        // the subsolar→antisolar wind tangent.
        if (this._particles) {
            for (const id in this._particles) {
                this._particles[id].setSunDir?.(this._sunDir);
            }
        }
        if (this._fields) {
            for (const id in this._fields) {
                this._fields[id].setSunDir?.(this._sunDir);
            }
        }
        // Magnetic-field cascade: sun direction biases the dayside-vs-
        // nightside packet weighting (cusp packets brighten on the
        // dayside where reconnection is active).
        this._cascade?.setSunDir?.(this._sunDir);
        // Solar-wind group is oriented so its local +Y points at the
        // Sun; update the quaternion so the Shue magnetopause + bow
        // shock + Sun marker all rotate to the new sub-solar direction.
        if (this._swGroup) {
            const yAxis = new THREE.Vector3(0, 1, 0);
            const q = new THREE.Quaternion().setFromUnitVectors(yAxis, this._sunDir);
            this._swGroup.quaternion.copy(q);
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
        this._raycaster.params.Line   = { threshold: 0.02 };
        // Per-point picking on the debris cloud. Threshold is in world
        // units (R⊕); 0.02 ≈ 127 km, generous enough to catch a 0.014-
        // size sprite without overlap between dots in the typical
        // viewing range.
        this._raycaster.params.Points = { threshold: 0.02 };
        this._mouse = new THREE.Vector2(-9, -9);

        const hittable = () => [
            ...(this._satRings   || []),
            ...(this._shells     || []),
            ...(this._mpMesh     ? [this._mpMesh]     : []),
            ...(this._bsMesh     ? [this._bsMesh]     : []),
            ...(this._sheathMesh ? [this._sheathMesh] : []),
            ...(this._sunMarker  ? [this._sunMarker]  : []),
            // Each satellite probe (moving sprite) is independently
            // hittable so the tooltip + click-to-fly resolves to the
            // right satellite.
            ...Object.values(this._satProbes || {}).map(p => p.mesh),
            // Debris cloud — single Points object, but Three's Points
            // raycaster returns a per-point .index we use to resolve
            // which dot was hovered. See _findTaggedUserData below.
            ...(this._debrisCloud ? [this._debrisCloud] : []),
            // Magnetic-cascade artefacts — every line, oval band,
            // cusp dot, MLT marker, and FAC ring carries a tagged
            // userData; the recursive=true raycast finds them via
            // their parent groups.
            ...(this._cascade ? [this._cascade.group] : []),
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

        /**
         * Per-debris userData resolver. The cloud-level userData has
         * kind='debris-cloud' (good for the legend) but we want the
         * tooltip + click-to-fly to talk about the *specific* piece
         * the user is pointing at. Three's points raycaster returns
         * an .index field on the intersection; we map it back into
         * the parallel this._debris array.
         */
        const _userDataForHit = (hit) => {
            if (!hit) return {};
            // Debris cloud hit → resolve to a specific piece.
            if (hit.object === this._debrisCloud
                && Number.isFinite(hit.index)
                && this._debris?.[hit.index]) {
                const d = this._debris[hit.index];
                return {
                    kind:     'debris-piece',
                    id:       d.spec.id,
                    name:     d.spec.name,
                    altKm:    d.spec.altitudeKm,
                    color:    d.spec.color,
                    noradId:  d.spec.orbital?.noradId,
                    inclinationDeg: d.spec.orbital?.inclinationDeg,
                    periodMin:      d.spec.orbital?.periodMin,
                    debrisIdx:      hit.index,
                    tooltip:  'Click to fly the camera to this debris piece. '
                            + 'Drag pressure uses the live ρ at its current altitude.',
                };
            }
            return _findTaggedUserData(hit.object);
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
                const ud = _userDataForHit(hits[0]);
                tip.innerHTML = _tipHTML(ud, this._profile, this._swState);
                tip.style.left = `${x}px`;
                tip.style.top  = `${y}px`;
                tip.style.opacity = '1';
                this._hoveredUserData = ud;
                // Drive the debris-cloud highlight reticle. Stays in
                // sync with whichever dot the tooltip is describing —
                // if the hover moves off a debris hit, the index is
                // cleared and the reticle fades out.
                this._hoveredDebrisIdx = ud?.kind === 'debris-piece'
                    ? ud.debrisIdx
                    : null;
                this.canvas.style.cursor = 'pointer';
            } else {
                tip.style.opacity = '0';
                this._hoveredUserData = null;
                this._hoveredDebrisIdx = null;
                if (this._controls.getMode() === 'fly') {
                    this.canvas.style.cursor = 'crosshair';
                } else {
                    this.canvas.style.cursor = 'grab';
                }
            }
        };
        const onLeave = () => {
            tip.style.opacity = '0';
            this._hoveredDebrisIdx = null;
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
            // Click on any satellite probe → fly there.
            if (ud?.kind === 'sat-probe' && ud.id) {
                this.flyToSatellite(ud.id);
            } else if (ud?.kind === 'iss-probe') {
                // Legacy: keep the kind='iss-probe' path working in
                // case anything still emits that tag.
                this.flyToISS();
            } else if (ud?.kind === 'debris-piece' && Number.isFinite(ud.debrisIdx)) {
                this.flyToDebris(ud.debrisIdx);
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

        // Real-time Earth–Sun geometry. We don't rotate the Earth mesh or
        // the camera here — instead the sub-solar point is recomputed from
        // the wall clock every frame so the day-side terminator tracks
        // reality at the actual sidereal rate (≈15°/hour). The user reads
        // this as a stationary, physically-correct scene rather than the
        // old fast spin-and-circle.
        this._updateSunRealTime();

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
        if (this._currentSheetMat) this._currentSheetMat.uniforms.uTime.value = t;
        // Sun shaders: photosphere granulation drift, multi-layer
        // corona breathing pulse, outgoing-streamer dash.
        if (this._sunPhotoMat)  this._sunPhotoMat.uniforms.uTime.value  = t;
        if (this._sunChromoMat) this._sunChromoMat.uniforms.uTime.value = t;
        if (this._sunHaloMat)   this._sunHaloMat.uniforms.uTime.value   = t;
        if (this._sunOuterMat)  this._sunOuterMat.uniforms.uTime.value  = t;
        if (this._sunStreamMat) this._sunStreamMat.uniforms.uTime.value = t;

        // Magnetic-field cascade: advance the packet-dash phase. One
        // uniform write feeds every L-shell field line.
        if (this._cascade) this._cascade.update(t);

        // Substorm state machine: tick → push to cascade → broadcast
        // for the UI panel. Skip the heavy refresh path while idle so
        // we don't spend cycles re-rebuilding the oval every frame
        // when nothing is happening.
        if (this._substorm && this._cascade) {
            const prevPhase = this._substorm.getTick().phase;
            const tick = this._substorm.update(dt);
            const isActive   = tick.phase !== 'idle';
            const wasActive  = prevPhase   !== 'idle';
            // Only push to cascade when the substorm is doing
            // something — every frame during active phases (so the
            // bulge / WTS / AE proxy update smoothly), plus a one-
            // shot zero-state push on the active→idle transition so
            // the oval snaps back to its quiet position.
            if (isActive || wasActive) {
                this._cascade.setSubstormState(
                    tick,
                    this._cascade._lastKpCached,
                );
                // Broadcast for the UI panel.
                try {
                    window.dispatchEvent(new CustomEvent('ua-substorm-tick', {
                        detail: tick,
                    }));
                } catch (_) { /* SSR / no-window — ignore */ }
            }
        }

        this._controls.update(dt);

        // Per-frame satellite orbit propagation. Visual time is sped
        // up via opts.satTimeScale (default 60×) so a user sees a full
        // pass in seconds. Each probe has its own period, inclination,
        // and starting mean anomaly so paths don't all overlap.
        if (this._satProbes) this._stepSatellites(t);
        if (this._debris)    this._stepDebris(t);
        if (this._constellationClouds) this._stepConstellations(t);
        // Track the hovered debris with a face-on cyan reticle so
        // users can tell which of 50 identical-looking pink dots the
        // tooltip is describing. Cheap; just position + scale + lookAt.
        this._updateDebrisHighlight(t);

        // Conjunction screener: re-scan every 2 simulated seconds so
        // TCA times stay current as orbits evolve. Per-frame chord
        // line updates use whatever the cache holds — cheap.
        if (this._satProbes && (t - (this._lastConjScanTime ?? -Infinity)) > 2.0) {
            this._screenConjunctions();
            this._lastConjScanTime = t;
        }
        if (this._conjunctionLines) this._updateConjunctionLines();

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
     * Advance every cached satellite probe along its mean-element
     * orbit. Each probe carries its own (i, RAAN, M₀, period); the
     * helper _propagateKeplerian computes a position on the inclined
     * orbital plane in world frame.
     *
     * The probe's userData.altKm is updated each frame from the
     * computed |position| so the tooltip drag-pressure readout uses
     * the *current* altitude (not the spec's nominal value) — this
     * matters when we eventually upgrade to elliptical orbits with
     * non-zero eccentricity.
     */
    _stepSatellites(elapsedSec) {
        const ts = this.opts.satTimeScale ?? this.opts.issTimeScale ?? 60;
        for (const id in this._satProbes) {
            const probe = this._satProbes[id];
            const periodSec = probe.spec.orbital.periodMin * 60;
            // Total mean anomaly traveled at compressed time.
            const M = probe._phase0 + (elapsedSec * ts / periodSec) * 2 * Math.PI;
            // Convert M back into an orbit fraction for the helper.
            const tFrac = (M / (2 * Math.PI)) % 1;
            const altShellR = 1 + probe.spec.altitudeKm / R_EARTH_KM;
            const p = _propagateKeplerian(probe.spec.orbital, tFrac, altShellR);

            probe.mesh.position.set(p.x, p.y, p.z);
            // Update altitude from current radial distance — keeps the
            // tooltip honest if eccentricity is non-zero (apogee/perigee
            // sweep). For circular orbits the value is constant.
            const rNow = Math.hypot(p.x, p.y, p.z);
            probe.mesh.userData.altKm = (rNow - 1) * R_EARTH_KM;

            // Orient the sprite along the velocity tangent so users
            // can see direction-of-travel when zoomed in.
            const v = _propagateKeplerianVelocity(probe.spec.orbital, tFrac, altShellR);
            const radial = probe.mesh.position.clone().normalize();
            const m = new THREE.Matrix4().lookAt(
                probe.mesh.position,
                probe.mesh.position.clone().add(v),
                radial,
            );
            probe.mesh.quaternion.setFromRotationMatrix(m);
        }
    }

    /**
     * Snapshot of every satellite probe's *current* state, used by the
     * UI's drag-analysis side panel. Cheap — just reads cached probe
     * positions; no engine sampling here. Returns one entry per
     * orbital satellite; non-orbital references (Kármán) are skipped.
     */
    getSatelliteStates() {
        const out = [];
        if (!this._satProbes) return out;
        for (const id in this._satProbes) {
            const probe = this._satProbes[id];
            const rNow  = probe.mesh.position.length();
            const altKm = (rNow - 1) * R_EARTH_KM;
            out.push({
                id,
                name:    probe.spec.name,
                color:   probe.spec.color,
                altKm,
                noradId: probe.spec.orbital.noradId,
                periodMin: probe.spec.orbital.periodMin,
                inclinationDeg: probe.spec.orbital.inclinationDeg,
            });
        }
        return out;
    }

    /**
     * Full drag-analysis snapshot for every orbital satellite at the
     * current state. Returns altitude, ρ (sampled from the active
     * profile), circular orbital speed, drag pressure q = ½ρv², and a
     * Knudsen-derived regime label. Sorted descending by drag — the UI
     * panel shows "ISS feels the most drag" most-prominently.
     *
     * This couples globe state (probe altitude) with engine state
     * (profile from setProfile) so the panel reads off the same source
     * of truth as the rest of the page.
     */
    getSatelliteDragAnalysis() {
        const states = this.getSatelliteStates();
        if (!this._profile?.samples?.length) return states.map(s => ({ ...s, rho: null, q: null }));
        const out = states.map(s => {
            const rho = _nearestRho(this._profile.samples, s.altKm);
            const vKmS = _circularOrbitalSpeedKmS(s.altKm);
            const v = vKmS * 1000;                          // m/s
            const q = 0.5 * rho * v * v;                    // Pa
            // Carry the live/fallback flag + epoch into the panel so
            // users can see which probes are running on real CelesTrak
            // elements vs the hardcoded backstop.
            const probe = this._satProbes?.[s.id];
            const tleSource = probe?.mesh?.userData?.tleSource ?? 'fallback';
            const tleEpoch  = probe?.mesh?.userData?.tleEpoch  ?? null;
            return {
                ...s,
                rho,
                vKmS,
                qPa: q,
                qmPa: q * 1000,
                tleSource, tleEpoch,
            };
        });
        // Highest drag first — useful ranking for the panel.
        out.sort((a, b) => (b.qPa ?? 0) - (a.qPa ?? 0));
        return out;
    }

    // ── Conjunction screening ──────────────────────────────────────────────
    //
    // For each pair of orbital probes we sweep simulated-time from
    // "now" out to `horizonMin` minutes in `stepSec`-second
    // increments, find the time of closest approach (TCA) and the
    // miss distance there, plus the current separation. Results are
    // cached on this._conjunctions; the UI repaints from the cache.
    //
    // Cost: 6 pairs × 180 steps × 2 lookups + cheap math = ~10 k ops
    // per scan. We rerun every 2 s. Imperceptible.
    //
    // Time axis is *simulated* seconds (real orbital time), not page-
    // clock seconds. With opts.satTimeScale = 60×, "TCA in 47 min"
    // means 47 minutes of physical orbital evolution; the user will
    // see it occur after ~47 page-seconds.

    _setupConjunctionScreener() {
        this._conjunctions = [];
        // Lines connecting predicted-close pairs, drawn with additive
        // blending so they read against the dark backdrop.
        this._conjunctionGroup = new THREE.Group();
        this._conjunctionGroup.name = 'conjunction-chords';
        this._scene.add(this._conjunctionGroup);
        this._conjunctionLines = {};        // pairKey → THREE.Line — asset-asset, fixed
        this._debrisChordPool  = [];        // reusable pool for top-N asset-debris threats

        // Build one line per asset-asset pair right away so endpoint
        // updates don't pay for geometry creation in the hot path.
        const probes = Object.values(this._satProbes || {});
        for (let i = 0; i < probes.length; i++) {
            for (let j = i + 1; j < probes.length; j++) {
                const a = probes[i], b = probes[j];
                const key = _pairKey(a.spec.id, b.spec.id);
                const line = _buildChordLine({
                    aId:   a.spec.id, bId: b.spec.id,
                    aName: a.spec.name, bName: b.spec.name,
                });
                this._conjunctionLines[key] = line;
                this._conjunctionGroup.add(line);
            }
        }

        // Pre-allocate a small pool of chord lines for asset↔debris
        // threats so the per-frame logic doesn't allocate. Three is
        // enough — beyond that the scene gets cluttered and the panel
        // already lists more in detail.
        const POOL_SIZE = 3;
        for (let i = 0; i < POOL_SIZE; i++) {
            const line = _buildChordLine({});       // anonymous; reassigned per scan
            this._debrisChordPool.push(line);
            this._conjunctionGroup.add(line);
        }

        this._lastConjScanTime = -Infinity;
    }

    /**
     * Sweep every probe pair over the next `horizonMin` simulated
     * minutes and update this._conjunctions in place. Cheap; fed by
     * the per-probe phase-indexed lookup tables built at probe spawn.
     */
    _screenConjunctions({ horizonMin = 90, stepSec = 30, altPreFilterKm = 250 } = {}) {
        const assets = Object.values(this._satProbes || {});
        const debris = this._debris || [];
        if (assets.length < 1) {
            this._conjunctions = [];
            return;
        }

        const ts = this.opts.satTimeScale ?? this.opts.issTimeScale ?? 60;
        // Simulated-orbital seconds since page boot.
        const tNowSim = this._clock.getElapsedTime() * ts;

        const horizonSec = horizonMin * 60;
        const nSteps = Math.max(2, Math.floor(horizonSec / stepSec) + 1);

        const out = [];

        // Inner helper to scan one pair across the horizon.
        const scan = (a, b) => {
            let minDist = Infinity, minStep = 0;
            let firstDist = 0;
            for (let k = 0; k < nSteps; k++) {
                const tSim = tNowSim + k * stepSec;
                const pa = _lookupProbePosition(a, tSim);
                const pb = _lookupProbePosition(b, tSim);
                const dx = pa.x - pb.x;
                const dy = pa.y - pb.y;
                const dz = pa.z - pb.z;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (k === 0) firstDist = Math.sqrt(d2);
                if (d2 < minDist) { minDist = d2; minStep = k; }
            }
            return {
                currDistKm: firstDist * R_EARTH_KM,
                tcaDistKm:  Math.sqrt(minDist) * R_EARTH_KM,
                tcaTimeSec: minStep * stepSec,
            };
        };

        // ── Asset ↔ asset (always screened; the small N=4 case) ───────
        for (let i = 0; i < assets.length; i++) {
            for (let j = i + 1; j < assets.length; j++) {
                const a = assets[i], b = assets[j];
                // Altitude pre-filter — paired LEO assets pass easily,
                // but it costs nothing here and keeps GEO/MEO additions
                // robust against quadratic blow-ups in future rounds.
                if (Math.abs(a.spec.altitudeKm - b.spec.altitudeKm) > altPreFilterKm) continue;
                const r = scan(a, b);
                out.push({
                    kind: 'asset-asset',
                    aId: a.spec.id, bId: b.spec.id,
                    aName: a.spec.name, bName: b.spec.name,
                    aColor: a.spec.color, bColor: b.spec.color,
                    aNorad: a.spec.orbital?.noradId,
                    bNorad: b.spec.orbital?.noradId,
                    ...r,
                });
            }
        }

        // ── Asset ↔ debris ────────────────────────────────────────────
        // Pre-filter cuts the propagation cost for orbits that can
        // never come within altPreFilterKm anyway. For 4 assets × 50
        // debris, typical post-filter pair count is 30–80 — a small
        // fraction of the worst-case 200. Each surviving pair still
        // runs nSteps=180 lookups so the screener stays bounded.
        for (const a of assets) {
            for (const b of debris) {
                if (Math.abs(a.spec.altitudeKm - b.spec.altitudeKm) > altPreFilterKm) continue;
                const r = scan(a, b);
                out.push({
                    kind: 'asset-debris',
                    aId: a.spec.id, bId: b.spec.id,
                    aName: a.spec.name, bName: b.spec.name,
                    aColor: a.spec.color, bColor: b.spec.color,
                    aNorad: a.spec.orbital?.noradId,
                    bNorad: b.spec.orbital?.noradId,
                    ...r,
                });
            }
        }

        out.sort((p, q) => p.tcaDistKm - q.tcaDistKm);
        this._conjunctions = out;
    }

    /**
     * Update each per-pair chord line's endpoints to the live probe
     * positions and set color/opacity from the cached TCA prediction.
     * Drawn faint by default; intensifies for pairs with a tight TCA.
     */
    _updateConjunctionLines() {
        if (!this._conjunctionLines || !this._conjunctions) return;
        const watchKm = 200;

        // Build a quick id-pair → cached entry map for O(1) lookup
        // when refreshing the fixed asset-asset chord lines.
        const byKey = {};
        for (const c of this._conjunctions) byKey[_pairKey(c.aId, c.bId)] = c;

        // ── Asset ↔ asset: fixed lines, keyed by pair ─────────────────
        for (const key in this._conjunctionLines) {
            const line = this._conjunctionLines[key];
            const c = byKey[key];
            const pa = this._satProbes?.[line.userData.aId]?.mesh.position;
            const pb = this._satProbes?.[line.userData.bId]?.mesh.position;
            if (!c || !pa || !pb || c.tcaDistKm > watchKm) {
                line.material.opacity = 0;
                continue;
            }
            _paintChordLine(line, pa, pb, c, watchKm);
        }

        // ── Asset ↔ debris: top-N threats, painted into a small pool ──
        // The pool is a fixed-size set of THREE.Lines that we
        // repurpose each scan. Lines beyond the live threat count are
        // hidden by setting opacity to 0.
        const pool = this._debrisChordPool || [];
        const debrisThreats = this._conjunctions
            .filter(c => c.kind === 'asset-debris' && c.tcaDistKm <= watchKm)
            .slice(0, pool.length);

        for (let i = 0; i < pool.length; i++) {
            const line = pool[i];
            const c = debrisThreats[i];
            if (!c) {
                line.material.opacity = 0;
                continue;
            }
            const pa = this._satProbes?.[c.aId]?.mesh.position;
            // Debris position from the cloud's flat position buffer —
            // O(1) lookup via the debris index.
            const debrisIdx = (this._debris || []).findIndex(d => d.spec.id === c.bId);
            if (!pa || debrisIdx < 0) {
                line.material.opacity = 0;
                continue;
            }
            const pos = this._debrisPositions;
            const pb = {
                x: pos[debrisIdx * 3],
                y: pos[debrisIdx * 3 + 1],
                z: pos[debrisIdx * 3 + 2],
            };
            // Update the line's userData with the live pair so the
            // tooltip pipeline (raycaster) can describe the threat
            // even though the pool slot was repurposed.
            line.userData.aId  = c.aId;
            line.userData.bId  = c.bId;
            line.userData.aName = c.aName;
            line.userData.bName = c.bName;
            line.userData.tooltip = `Predicted close approach: ${c.aName} ↔ ${c.bName} (debris).`;
            _paintChordLine(line, pa, pb, c, watchKm);
        }
    }

    /**
     * Public snapshot for the UI conjunction-watch panel. Triggers
     * a screen if cache is stale (> 2 s old). Returns the cached
     * pair list sorted by TCA-distance ascending.
     */
    getConjunctionAnalysis() {
        const now = performance.now() / 1000;
        if (!this._conjunctions || (now - (this._lastConjScanTime ?? -Infinity)) > 2.0) {
            this._screenConjunctions();
            this._lastConjScanTime = now;
        }
        return this._conjunctions || [];
    }
}

// ── Keplerian orbit helper ─────────────────────────────────────────────────
// Visualisation-grade propagator. Inputs are mean elements; output is a
// position on the inclined orbital plane in world frame, scaled to a
// `radius` representative altitude so the math stays in R⊕ units the rest
// of the page works in.
//
// Convention: orbital plane is rotated from the equatorial plane by the
// inclination around X, then around Y by RAAN. Argument of perigee is
// folded into the in-plane angle so we can keep argP non-zero for users
// who want to play with apsides later.
//
// For circular orbits (eccentricity ≈ 0) we skip Kepler's-equation
// solving entirely — eccentric anomaly equals mean anomaly, and the
// in-plane radius is constant. tFrac is in [0, 1) along one orbit; the
// caller advances it deterministically each frame.
function _propagateKeplerian(orb, tFrac, radius) {
    const i = orb.inclinationDeg * Math.PI / 180;
    const Ω = orb.raanDeg         * Math.PI / 180;
    const ω = orb.argPerigeeDeg   * Math.PI / 180;
    const M = tFrac * 2 * Math.PI;
    const e = orb.eccentricity ?? 0;

    // True anomaly = mean anomaly for circular orbit; otherwise solve
    // Kepler's equation by Newton-Raphson and convert.
    let nu;
    if (e < 1e-4) {
        nu = M;
    } else {
        let E = M;
        for (let k = 0; k < 6; k++) {
            E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
        }
        nu = 2 * Math.atan2(
            Math.sqrt(1 + e) * Math.sin(E / 2),
            Math.sqrt(1 - e) * Math.cos(E / 2),
        );
    }
    const θ = ω + nu;
    const r = radius * (e < 1e-4 ? 1 : (1 - e * e) / (1 + e * Math.cos(nu)));

    // In-plane (perifocal) coordinates with x along ascending node.
    const xp = r * Math.cos(θ);
    const yp = r * Math.sin(θ);

    // Rotate to ECI using the standard 3-1-3 sequence (RAAN, incl,
    // argP); since argP was folded into θ above, we only need the
    // incl + RAAN rotations here. ECI is the canonical Z-up,
    // equatorial-XY frame used by SGP4 and pretty much every
    // satellite catalog.
    const cosI = Math.cos(i), sinI = Math.sin(i);
    const cosΩ = Math.cos(Ω), sinΩ = Math.sin(Ω);
    // Rotation around X by inclination: (xp, yp, 0) → (xp, yp·cosI, yp·sinI).
    const xa = xp;
    const ya = yp * cosI;
    const za = yp * sinI;
    // Rotation around Z by RAAN.
    const xEci = xa * cosΩ - ya * sinΩ;
    const yEci = xa * sinΩ + ya * cosΩ;
    const zEci = za;

    // Map ECI Z-up → Three.js world Y-up by swapping y and z.
    // (Three.js convention used throughout the page: +Y is north pole.)
    return { x: xEci, y: zEci, z: yEci };
}

/**
 * Velocity tangent at the same orbital position. Used for sprite
 * orientation; returned as a unit vector in world frame.
 */
function _propagateKeplerianVelocity(orb, tFrac, radius) {
    // Forward-difference: sample a hair ahead and subtract. Cheap and
    // mode-agnostic (works for circular and elliptical alike) without
    // re-deriving the analytic dr/dν.
    const dt = 1e-4;
    const a = _propagateKeplerian(orb, tFrac,             radius);
    const b = _propagateKeplerian(orb, (tFrac + dt) % 1,  radius);
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    return new THREE.Vector3(dx / len, dy / len, dz / len);
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

/**
 * Circular orbital speed at altitude `altKm`. Uses Earth's standard
 * gravitational parameter μ = 398 600.4418 km³/s² and the WGS-72 mean
 * radius (matches the SGP4 propagator's RE_KM upstream so we stay on
 * one consistent reference). Returns km/s.
 *
 *   v = √(μ / (Rₑ + h))
 *
 * For ISS @ 420 km this gives 7.66 km/s, the canonical value.
 */
function _circularOrbitalSpeedKmS(altKm) {
    const MU = 398600.4418;     // km³/s²
    const RE = 6378.135;        // km, WGS-72
    const r = RE + altKm;
    return Math.sqrt(MU / r);
}

/**
 * Stable key for an unordered probe pair. Sorted-string concat so
 * (iss, hubble) and (hubble, iss) hash to the same chord line.
 */
function _pairKey(idA, idB) {
    return idA < idB ? `${idA}__${idB}` : `${idB}__${idA}`;
}

/**
 * Build one chord-line scaffold (2-vertex BufferGeometry +
 * additive-blended LineBasicMaterial). Used both for the fixed
 * asset-asset pairs and for the recyclable debris-threat pool;
 * userData is filled in by the caller / per-frame update.
 */
/**
 * Paint one chord line from `pa` to `pb` and color/opacity-modulate
 * by the TCA prediction `c`. Shared by the asset-asset branch and
 * the debris-pool branch of _updateConjunctionLines.
 */
function _paintChordLine(line, pa, pb, c, watchKm) {
    const pos = line.geometry.attributes.position.array;
    pos[0] = pa.x; pos[1] = pa.y; pos[2] = pa.z;
    pos[3] = pb.x; pos[4] = pb.y; pos[5] = pb.z;
    line.geometry.attributes.position.needsUpdate = true;
    // Color by predicted TCA distance — red <10 km, orange <50 km,
    // yellow <200 km. Opacity ramps up as the *current* separation
    // approaches the predicted TCA distance, so the line literally
    // lights up at the moment of closest approach.
    const col = c.tcaDistKm < 10  ? 0xff3060
              : c.tcaDistKm < 50  ? 0xff8a3a
              : 0xffd060;
    line.material.color.setHex(col);
    const ratio = Math.max(0, 1 - (c.currDistKm / Math.max(watchKm, c.tcaDistKm * 4)));
    line.material.opacity = 0.20 + 0.55 * ratio;
}

function _buildChordLine(userData) {
    const positions = new Float32Array(6);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
        color:       0x888888,
        transparent: true,
        opacity:     0.0,
        depthWrite:  false,
        blending:    THREE.AdditiveBlending,
    });
    const line = new THREE.Line(geom, mat);
    line.frustumCulled = false;
    line.userData = { kind: 'conjunction-chord', ...userData };
    return line;
}

/**
 * O(1) probe-position lookup via the precomputed phase-indexed
 * table. simSec is the current simulated-orbital-time in seconds;
 * we resolve it to a fractional phase index, then linearly
 * interpolate between adjacent table entries for sub-sample
 * smoothness (matters at TCA where the curve is flattest).
 *
 * Falls back to a fresh trig-based propagate if the lookup table
 * isn't built yet — happens only on the very first frame post-spawn.
 */
function _lookupProbePosition(probe, simSec) {
    const periodSec = probe.spec.orbital.periodMin * 60;
    if (!probe._propTable || !periodSec) {
        const M = probe._phase0 + 2 * Math.PI * simSec / Math.max(periodSec, 1);
        const TAU = 2 * Math.PI;
        const tFrac = ((M / TAU) % 1 + 1) % 1;
        const r = 1 + probe.spec.altitudeKm / R_EARTH_KM;
        return _propagateKeplerian(probe.spec.orbital, tFrac, r);
    }
    const N = probe._propTableN;
    const M = probe._phase0 + 2 * Math.PI * simSec / periodSec;
    const TAU = 2 * Math.PI;
    const phaseFrac = ((M / TAU) % 1 + 1) % 1;
    const fIdx = phaseFrac * N;
    const k0 = Math.floor(fIdx) % N;
    const k1 = (k0 + 1) % N;
    const t  = fIdx - Math.floor(fIdx);
    const tbl = probe._propTable;
    const a0 = k0 * 3, a1 = k1 * 3;
    return {
        x: tbl[a0]     * (1 - t) + tbl[a1]     * t,
        y: tbl[a0 + 1] * (1 - t) + tbl[a1 + 1] * t,
        z: tbl[a0 + 2] * (1 - t) + tbl[a1 + 2] * t,
    };
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
        case 'sat-probe': {
            // Live satellite probe. Drag pressure q = ½ρv² uses the
            // *current* probe altitude (so eccentric-orbit apogee/
            // perigee swings show up) and the circular orbital speed
            // at that altitude: v = √(μ/(R+h)).
            const incl = userData.spec?.orbital?.inclinationDeg;
            const period = userData.spec?.orbital?.periodMin;
            detail = `${userData.altKm.toFixed(0)} km`
                + (incl ? ` · ${incl}°` : '')
                + (period ? ` · ${period.toFixed(1)} min` : '')
                + ` · click to fly here`;
            if (profile?.samples?.length) {
                const rho = _nearestRho(profile.samples, userData.altKm);
                const v = _circularOrbitalSpeedKmS(userData.altKm) * 1000;   // m/s
                const q = 0.5 * rho * v * v;                                  // Pa
                dataLines = `
                    <div style="color:#9cf">ρ = ${rho.toExponential(2)} kg/m³ · v ≈ ${(v / 1000).toFixed(2)} km/s</div>
                    <div style="color:#0fc">drag q ≈ ${(q * 1000).toFixed(2)} mPa</div>
                    <div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            } else {
                dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            }
            break;
        }
        case 'sat-orbit-path':
            detail = `${userData.altKm} km · orbital track`;
            dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            break;
        case 'debris-piece': {
            // Per-piece debris readout. Live ρ at the piece's altitude
            // + drag pressure q = ½ρv² at the circular orbital speed.
            const incl = userData.inclinationDeg;
            const period = userData.periodMin;
            const norad = userData.noradId;
            detail = `${userData.altKm} km · debris`
                + (incl  ? ` · ${incl.toFixed(1)}°` : '')
                + (period ? ` · ${period.toFixed(1)} min` : '')
                + ` · click to fly here`;
            const lines = [];
            if (norad) lines.push(`<div style="color:#9ab">NORAD ${norad}</div>`);
            if (profile?.samples?.length) {
                const rho = _nearestRho(profile.samples, userData.altKm);
                const v = _circularOrbitalSpeedKmS(userData.altKm) * 1000;
                const q = 0.5 * rho * v * v;
                lines.push(
                    `<div style="color:#9cf">ρ = ${rho.toExponential(2)} kg/m³ · v ≈ ${(v / 1000).toFixed(2)} km/s</div>`,
                    `<div style="color:#0fc">drag q ≈ ${(q * 1000).toFixed(2)} mPa</div>`,
                );
            }
            lines.push(`<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`);
            dataLines = lines.join('');
            break;
        }
        case 'magnetic-cascade-line': {
            const L = userData.L?.toFixed(1) ?? '—';
            const labelColor = userData.color || '#9cf';
            detail = `L = ${L} · <span style="color:${labelColor}">${userData.label || ''}</span>`;
            dataLines = `
                <div style="color:#9ab;font-size:10px;margin-top:2px">${userData.population || ''}</div>
                <div style="color:#666;font-size:10px;margin-top:1px">family: ${userData.family || ''}</div>`;
            break;
        }
        case 'auroral-oval': {
            detail = `${userData.band === 'equatorward' ? 'Equatorward' : 'Poleward'} edge · ${userData.hemisphere} · ~${userData.altKm} km`;
            dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip || ''}</div>`;
            break;
        }
        case 'polar-cusp': {
            detail = `Polar cusp · ${userData.hemisphere} · ~${userData.altKm} km`;
            dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip || ''}</div>`;
            break;
        }
        case 'mlt-marker': {
            detail = `MLT ${userData.mlt.toString().padStart(2, '0')} · ${userData.label}`;
            dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip || ''}</div>`;
            break;
        }
        case 'fac-region-1':
        case 'fac-region-2': {
            const region = userData.region;
            detail = `Region ${region} Birkeland · ${userData.hemisphere} · ~${userData.altKm} km`;
            dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip || ''}</div>`;
            break;
        }
        default:
            detail = userData.altKm != null ? `${userData.altKm} km` : '';
    }
    return `
        <div style="color:${colour};font-weight:600">${userData.name || userData.id}</div>
        <div>${detail}</div>
        ${dataLines}
    `;
}
