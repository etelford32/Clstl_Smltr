/**
 * heliosphere3d.js — 3D inner solar system for the Space Weather page
 *
 * Three.js scene (ecliptic plane = XZ, +Y ecliptic north):
 *   • Sun at origin with corona glow + PointLight
 *   • Mercury, Venus, Earth+Moon, Mars at real ephemeris positions
 *   • Earth's full magnetosphere via MagnetosphereEngine, parented to Earth's
 *     orbital group — works because Group.add() mirrors Scene.add()
 *   • 3D Parker spiral solar wind particles (3 000 CPU-advected Points)
 *   • CME expanding shell (triggered by earth_directed_cme in swpc-update)
 *   • Solar flare burst ring on sun surface (triggered by M/X class events)
 *   • Starfield backdrop
 *   • OrbitControls — zoom from full system view (all 4 planets) down to the
 *     Earth–L1 gap, exposing the magnetopause and bow shock detail
 *
 * Scale: AU = 100 Three.js units  (1 unit ≈ 1.496 × 10⁶ km ≈ 234 R⊕)
 *   Body radii are visually exaggerated for system-level readability:
 *     Sun 4.5 u · Mercury 0.32 u · Venus 0.58 u · Earth 0.78 u · Mars 0.48 u
 *   MagnetosphereEngine runs at Earth-local R⊕ = 1 u, so its geometry
 *   (magnetopause ~10 u, bow shock ~12 u) is naturally visible at system scale.
 *
 * Events consumed (window):
 *   'swpc-update'     — { solar_wind, kp, xray_class, earth_directed_cme, … }
 *   'ephemeris-ready' — { mercury, venus, earth, moon, mars }
 *                       each body has { lon_rad, lat_rad, dist_AU }
 *
 * Usage:
 *   import { Heliosphere3D } from './js/heliosphere3d.js';
 *   new Heliosphere3D(canvas).start();
 */

import * as THREE from 'three';
import { OrbitControls }       from 'three/addons/controls/OrbitControls.js';
import { MagnetosphereEngine } from './magnetosphere-engine.js';
import { FlareRing3D }         from './flare-ring.js';
import { EARTH_VERT, EARTH_FRAG, createEarthUniforms, loadEarthTextures } from './earth-skin.js';
import {
    jdNow,
    earthHeliocentric, moonGeocentric,
    mercuryHeliocentric, venusHeliocentric, marsHeliocentric,
    jupiterHeliocentric, saturnHeliocentric, uranusHeliocentric, neptuneHeliocentric,
} from './horizons.js';
import { earthOrbitFull } from './earth-orbit.js';
import { EphemerisService } from './horizons.js';
import { OrbitTrails } from './orbit-trails.js';
import {
    MoonSystem, JUPITER_MOONS, SATURN_MOONS, URANUS_MOONS, NEPTUNE_MOONS,
    createUranusRings, applyPlanetSpin, PLANET_SPIN,
} from './planet-moons.js';
import { JupiterSkin } from './jupiter-skin.js';
import {
    buildParkerLUT,
    parkerSpeedRatio,
    alfvenSpeed,
    plasmaTemp,
    tempToRGB,
    petschekRate,
    plasmaBeta,
    cglAnisotropy,
} from './helio-physics.js';
import { SUN_VERT, SUN_FRAG, createSunUniforms } from './sun-shader.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Three.js units per AU */
const AU = 100;

/** Visual body radii (Three.js units, exaggerated for readability) */
const R = {
    sun:     4.5,
    mercury: 0.32,
    venus:   0.58,
    earth:   0.78,
    mars:    0.48,
    moon:    0.22,
    phobos:  0.11,
    deimos:  0.09,
    // Outer planets — still exaggerated but proportionally larger
    jupiter: 1.80,
    saturn:  1.50,
    uranus:  1.10,
    neptune: 1.00,
};

/** Orbital semi-major axes (AU) — mean values for orbit ring geometry */
const ORBIT_AU = {
    mercury: 0.387, venus: 0.723, earth: 1.000, mars:    1.524,
    jupiter: 5.203, saturn: 9.537, uranus: 19.191, neptune: 30.069,
};

/** Planet colours */
const COL = {
    mercury: 0x9a8875,
    venus:   0xe8c97a,
    earth:   0x1a6ad8,
    mars:    0xcc4422,
    moon:    0x888888,
    jupiter: 0xc88b3a,
    saturn:  0xe4d191,
    uranus:  0x7de8e8,
    neptune: 0x4b70dd,
};

const D2R = Math.PI / 180;

/** Orbital inclination (i) and ascending node (Ω) for inclined orbit rings — Meeus Table 31.a */
const ORBIT_INCL = {
    mercury: { i: 7.005  * D2R, node:  48.331 * D2R },
    venus:   { i: 3.394  * D2R, node:  76.680 * D2R },
    earth:   { i: 0.000,        node:   0.000        },
    mars:    { i: 1.850  * D2R, node:  49.558 * D2R },
    jupiter: { i: 1.303  * D2R, node: 100.464 * D2R },
    saturn:  { i: 2.489  * D2R, node: 113.666 * D2R },
    uranus:  { i: 0.773  * D2R, node:  74.006 * D2R },
    neptune: { i: 1.770  * D2R, node: 131.784 * D2R },
};

/**
 * Visual Moon orbit radius (scene units).
 * Real Moon orbit is 0.00257 AU = 0.257 scene units, which is INSIDE Earth's
 * sphere (R.earth = 0.78).  Scale up ~12× for visibility.
 */
const MOON_VIS_AU = 0.032;

/**
 * Mars moon orbital data (J2000 epoch, simplified synodic elements).
 * Orbits are prograde, nearly equatorial.  Mars' equatorial pole points to
 * RA=317.68° Dec=52.89° (J2000) — tilt ~25.2° from Mars orbital normal.
 * We approximate both moons in the Mars orbital plane, tilted 26° from ecliptic.
 *
 *                  a_km    period_d   L0_deg    n_deg_per_day   color
 */
const MARS_MOONS = {
    phobos: { a_scene: R.mars * 3.2,  period_d: 0.31891, L0_deg: 92.47,  color: 0xb0a898 },
    deimos: { a_scene: R.mars * 6.8,  period_d: 1.26244, L0_deg: 296.23, color: 0x9a9080 },
};
// Mars equatorial tilt relative to ecliptic plane (approximate, scene Y-axis tilt)
const MARS_MOON_TILT = 26 * D2R;

const N_WIND    = 8000;   // solar wind particles
const MAX_R_AU  = 1.65;   // kill particles beyond this
const N_LINE    = 90;     // points per spiral field-line sample
const N_SPIRAL  = 8;      // field lines sampled (uniformly around the solar disk)
const HCS_NR    = 48;     // HCS mesh — radial segments
const HCS_NPHI  = 80;     // HCS mesh — azimuthal segments

// ── Solar wind GLSL shaders ───────────────────────────────────────────────────
//
// Vertex shader: per-particle size from corona fall-off, full thermal colour
// pipeline (Parker-CGL temperature → RGB, IMF polarity, storm, flare pulses,
// CGL anisotropy, shimmer) moved entirely to GPU — eliminates ~40 CPU ops/particle.
//
// Fragment shader: soft glowing disc  (core pow(1−r,2.2) + halo pow(1−r,0.8))
// with discard outside unit circle → clean alpha-edge, no hard square sprites.

const _WIND_VERT = /* glsl */`
#define MAX_PULSES 6

attribute float a_r;       // heliocentric distance (AU)
attribute float a_lat;     // sin(heliographic latitude)
attribute float a_src_lon; // source longitude on solar surface (rad)
attribute float a_age;     // particle age (seconds)
attribute float a_speed;   // 0 = slow stream, 1 = fast stream

uniform float u_bz;        // measured IMF Bz (nT, south negative)
uniform float u_by;        // measured IMF By (nT)
uniform float u_bt;        // |B| total (nT)
uniform float u_density;   // solar wind density (cm⁻³)
uniform float u_time;      // cumulative simulation time (s)
uniform float u_scale;     // perspective scale = 0.5 * renderer.height (px)
uniform float u_rot;       // solar rotation phase (rad)
uniform int   u_awayFirst; // By >= 0 → 1, else 0
uniform vec4  u_pulses[MAX_PULSES]; // .x=r_AU .y=srcLon .z=intensity .w=unused
uniform int   u_pulse_n;   // active pulse count
uniform float u_maxR;      // MAX_R_AU kill radius

varying vec3  vColor;
varying float vFade;

// log₁₀ (GLSL 100 has no built-in)
float log10v(float x) { return log(max(x, 1e-30)) * 0.4342944819; }

// Parker-CGL plasma temperature (K) at heliocentric r (AU)
float plasmaTemp(float r) {
    float rr = max(r, 0.046);
    float r0 = 0.046;
    // fast stream (coronal holes): T_corona ≈ 2 MK; slow: ≈ 1.3 MK
    float T_c = mix(1.3e6, 2.0e6, a_speed);
    float T_p = T_c * pow(r0 / rr, 0.74);
    float T_w = T_c * 0.28 * pow(r0 / rr, 0.35) * exp(-rr / 0.40);
    return max(5000.0, T_p + T_w);
}

// Blackbody-inspired thermal RGB (matches CPU tempToRGB in helio-physics.js)
vec3 tempToRGB(float T_K) {
    float logT = log10v(clamp(T_K, 3000.0, 3.0e6));
    float t    = (logT - 3.70) / 2.48;   // 0 = 5 kK, 1 = 1.5 MK
    vec3  col;
    if (t < 0.25) {
        float s = t / 0.25;
        col = vec3(0.30 + 0.52*s, 0.0,           0.0);
    } else if (t < 0.50) {
        float s = (t - 0.25) / 0.25;
        col = vec3(0.82 + 0.12*s, 0.06 + 0.14*s, 0.0);
    } else if (t < 0.75) {
        float s = (t - 0.50) / 0.25;
        col = vec3(0.94 + 0.04*s, 0.20 + 0.52*s, 0.16*s);
    } else {
        float s = (t - 0.75) / 0.25;
        col = vec3(0.98,          0.72 + 0.26*s,  0.16 + 0.82*s);
    }
    return clamp(col, 0.0, 1.0);
}

// CGL anisotropy T_perp/T_parallel (Helios observations fit)
float cglAnisotropy(float r) {
    float rr = max(0.01, r);
    if (rr < 0.3) return max(1.0, 20.0 * pow(0.046 / rr, 1.6));
    return max(0.15, pow(0.3 / rr, 0.7));
}

void main() {
    vec4  mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPos;

    float r = a_r;

    // ── Magnetosheath detection ───────────────────────────────────────────────
    // CPU _tickWind() sets a_speed = 0.3 when a particle is inside the Earth's
    // bow shock.  We render these as compressed, shock-heated plasma.
    bool inMagsheath = (a_speed > 0.15 && a_speed < 0.45);

    // ── Perspective-correct size with corona brightness fall-off ────────────
    // Particles glow large near the corona (r~0.008 AU) and shrink to subtle
    // points at MAX_R_AU.  Clamp prevents GPU point-size overflow on some drivers.
    // Magnetosheath particles are ~50% larger (compressed, denser plasma).
    float baseSize  = inMagsheath
        ? 3.5 + 6.0 / (1.0 + r * 3.5)
        : 2.0 + 5.0 / (1.0 + r * 3.5);
    gl_PointSize = clamp(baseSize * u_scale / max(0.001, -mvPos.z), 1.0, 96.0);

    // ── Thermal colour (Parker-CGL) ─────────────────────────────────────────
    float T_K = plasmaTemp(r);
    vec3  col = tempToRGB(T_K);

    // ── Magnetosheath colour override ─────────────────────────────────────────
    // Post-bow-shock compression heats the plasma ~4-8× (Rankine-Hugoniot).
    // Render as orange-yellow compressed plasma distinct from ambient wind.
    if (inMagsheath) {
        float T_ms = T_K * 5.0;
        col = mix(tempToRGB(T_ms), vec3(1.0, 0.58, 0.08), 0.50);
    }

    // ── IMF sector polarity tint (By-based) ─────────────────────────────────
    const float TWO_PI = 6.28318530718;
    float bzSouth   = clamp(-u_bz / 30.0, 0.0, 1.0);
    float btNorm    = clamp(u_bt  / 20.0, 0.0, 1.0);
    float heliogLon = mod(mod(a_src_lon - u_rot, TWO_PI) + TWO_PI, TWO_PI);
    bool  inAway    = (heliogLon < 3.14159265) == (u_awayFirst != 0);
    float polShift  = inAway ? 0.12 : -0.12;
    col.r = clamp(col.r + polShift * (1.0 - col.r), 0.0, 1.0);
    col.b = clamp(col.b - polShift * 0.4,            0.0, 1.0);

    // ── CGL anisotropy tint ──────────────────────────────────────────────────
    float aniso     = cglAnisotropy(r);
    float anisoTint = clamp((aniso - 1.0) * 0.015, -0.08, 0.08);
    col.r = clamp(col.r - anisoTint * 0.5, 0.0, 1.0);
    col.g = clamp(col.g + anisoTint * 0.3, 0.0, 1.0);
    col.b = clamp(col.b + anisoTint,        0.0, 1.0);

    // ── Geomagnetic storm modifier (south Bz reddens the wind) ──────────────
    col.r = clamp(col.r + bzSouth * 0.22, 0.0, 1.0);
    col.g = clamp(col.g - bzSouth * 0.18, 0.0, 1.0);
    col.b = clamp(col.b - bzSouth * 0.25, 0.0, 1.0);

    // ── Flare / CME pulse front (shock heating → blue-white flash) ───────────
    // Up to MAX_PULSES active pulses, each encoded as vec4(r_AU, srcLon, intensity, 0).
    // Particles at the shock radius flash white-blue; driver gas behind glows orange.
    float pulseGlow = 0.0;
    float pulseBlue = 0.0;
    for (int p = 0; p < MAX_PULSES; p++) {
        if (p >= u_pulse_n) break;
        float pR      = u_pulses[p].x;
        float pLon    = u_pulses[p].y;
        float pInt    = u_pulses[p].z;
        float lonDelta = abs(mod(abs(a_src_lon - pLon) + 3.14159265, TWO_PI) - 3.14159265);
        if (lonDelta < 0.55) {
            float rDiff = r - pR;
            float pf    = exp(-rDiff * rDiff / 0.003)
                        * pInt * max(0.0, 1.0 - lonDelta / 0.55);
            pulseGlow = max(pulseGlow, pf);
            pulseBlue = max(pulseBlue, pf * max(0.0, sign(rDiff)));
        }
    }
    col.r = clamp(col.r + pulseGlow * 0.9  - pulseBlue * 0.4, 0.0, 1.0);
    col.g = clamp(col.g + pulseGlow * 0.85 + pulseBlue * 0.1, 0.0, 1.0);
    col.b = clamp(col.b + pulseGlow * 0.5  + pulseBlue * 0.9, 0.0, 1.0);

    // ── Coronal shimmer — subtle time-varying brightness turbulence ──────────
    // Driven by distinct per-particle frequencies so no two particles pulse together.
    float shimmer = 0.018 * sin(u_time * 8.7  + a_src_lon * 31.4 + r * 45.0)
                  + 0.012 * sin(u_time * 13.1 + a_src_lon * 17.2 + r * 29.0);
    col = clamp(col + shimmer, 0.0, 1.0);

    // ── Density-modulated fade envelope ─────────────────────────────────────
    float dFactor    = clamp(u_density / 5.0, 0.4, 2.5);
    float streamDens = inMagsheath ? 2.0 * dFactor : mix(1.15, 0.75, a_speed) * dFactor;
    float fadeIn     = clamp(a_age / 1.5, 0.0, 1.0);
    float rNorm      = r / u_maxR;
    float fadeOut    = pow(max(0.0, 1.0 - rNorm), 0.5);
    float fade       = clamp(fadeIn * fadeOut * streamDens + pulseGlow * 1.2, 0.0, 1.0);
    // Magnetosheath particles are always fully visible (no radial fade beyond bow shock)
    if (inMagsheath) fade = clamp(fade * 1.6 + 0.25, 0.0, 1.0);

    vColor = col;
    vFade  = fade;
}
`;

const _WIND_FRAG = /* glsl */`
varying vec3  vColor;
varying float vFade;

void main() {
    // Soft glowing disc: discard outside unit circle, blend a bright core with
    // a wide halo for the characteristic solar wind particle glow.
    vec2  uv = gl_PointCoord * 2.0 - 1.0;
    float d  = dot(uv, uv);
    if (d > 1.0) discard;
    float rr   = sqrt(d);
    // Core: tight bright centre (pow 2.2 for perceptually linear fade)
    // Halo: wide soft bloom (pow 0.8 = broad shoulder)
    float core = pow(1.0 - rr, 2.2);
    float halo = pow(1.0 - rr, 0.8) * 0.45;
    float disc = core + halo;
    gl_FragColor = vec4(vColor * disc, vFade * disc);
}
`;

// ── Heliosphere3D ─────────────────────────────────────────────────────────────

export class Heliosphere3D {

    constructor(canvas, opts = {}) {
        this._canvas = canvas;
        this._opts   = {
            showMagnetosphere: true,
            showWind:          true,
            showCME:           true,
            ...opts,
        };

        // ── Space-weather state (seeded with sane defaults) ───────────────────
        this._sw = {
            speed:     450,
            density:   5,
            bz:        -2,
            bt:        5,
            kp:        2,
            xrayClass: 'C1.0',
            xrayFlux:  1e-8,
            cmeActive: false,
            cmeSpeed:  800,
            regions:   [],
        };

        // ── Ephemeris state ───────────────────────────────────────────────────
        this._eph = {
            mercury: null, venus: null, earth: null, moon: null, mars: null,
            jupiter: null, saturn: null, uranus: null, neptune: null,
        };
        this._simJD       = jdNow(); // current simulation Julian Day (advances with time warp)
        this._timeScale   = 1;       // simulation speed multiplier (1 = real-time)
        this._lastMeeusMs = null;    // performance.now() of last Meeus 1-Hz tick

        /** Latest heliospheric state from SolarWindState (Parker-corrected) */
        this._helioState = null;

        // ── Internal bookkeeping ──────────────────────────────────────────────
        this._t        = 0;       // elapsed seconds
        this._rot      = 0;       // Parker spiral slow rotation (rad)
        this._rafId    = null;
        this._prevNow  = null;

        // CME animation (two-layer: shockMesh + driverMesh)
        this._cme      = null;    // null | { shockMesh, driverMesh, r_AU, auPerFrame }

        // Sun bloom level (0.3–3.0; 1.0 default)
        this._bloomLevel = 1.0;

        // Post-flare UV arcade state (null | { lat, lon, t })
        this._flareArcade  = null;
        this._flareArcLat  = 0;
        this._flareArcLon  = 0;
        this._flareArcT    = 0;    // 0–1 decay

        // Flare SEP ray (thin line along field direction)
        this._flareSEP     = null; // null | { line, age, maxAge }

        // Flare ribbon pair (two bright arcs at footpoints)
        this._flareRibbons = [];   // [{ line, age, maxAge }]

        // Flare animation (FlareRing3D — lazily constructed after scene is built)
        this._flare3d  = null;
        this._lastXray = '';

        // Sun shader uniforms + flare flash decay
        this._sunUniforms  = null;
        this._sunFlareT    = 0;    // 0–1 flash intensity, decays each frame

        // Solar prominences (animated arc loops at the limb)
        this._prominences  = [];   // [{ line, pts, lat, lon, maxH, age, maxAge, phase }]

        // Three.js objects (set by _build*)
        this._renderer    = null;
        this._scene       = null;
        this._camera      = null;
        this._controls    = null;
        this._earthGroup  = null;
        this._moonMesh    = null;
        this._moonOrbit   = 0;    // current moon angle (rad), animated
        this._magnetosphere = null;
        this._windPoints     = null;
        this._windPos        = null;
        this._windAge        = null;
        this._windMaxAge     = null;
        this._windArm        = null;
        this._windR          = null;  // r_AU for each particle
        this._windVY         = null;  // (unused — kept for shape compat)
        this._windPY         = null;  // sin(latitude) for constant-lat trajectory
        this._windJitter     = null;  // per-particle angular offset from field line (rad)
        this._windArmIdx     = null;  // Int16Array — source arm index per particle
        this._windSpeedAttr  = null;  // Float32Array — 0=slow / 1=fast for GPU shader
        this._windUniforms   = null;  // ShaderMaterial uniform object
        // Alfvén surface (translucent sphere at ~0.075 AU)
        this._alfvenMesh     = null;
        this._alfvenRing     = null;
        this._alfvenPhase    = 0;
        // Parker spiral field-line samples (backbone)
        this._spiralLines    = null;
        this._spiralLinePts  = null;
        this._spiralLineCols = null;
        // Heliospheric current sheet (HCS / "ballerina skirt")
        this._hcsMesh    = null;
        this._hcsPosArr  = null;
        this._hcsTilt    = 0;      // current warp amplitude (rad)
        // Parker transonic speed profile (precomputed LUT)
        this._parkerLUT  = null;
        // Per-arm stream speeds (bimodal: fast coronal-hole / slow streamer-belt)
        this._armBaseSpeeds = null;  // Float32Array[N_SPIRAL]
        this._armTypes      = null;  // Uint8Array[N_SPIRAL] — 0=slow, 1=fast
        // Flare-driven speed pulses propagating along the spiral
        this._flarePulses = [];      // [{ srcLon, r_AU, shockSpeed, intensity, age }]
        // Sweet-Parker / Petschek reconnection events at HCS
        this._reconnEvents = [];
        this._planetMeshes = {};

        // Bound handlers
        this._onSwpc      = this._onSwpc.bind(this);
        this._onEph       = this._onEph.bind(this);
        this._onHelioState = this._onHelioState.bind(this);
        this._loop        = this._loop.bind(this);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    start() {
        this._build();
        window.addEventListener('swpc-update',        this._onSwpc);
        window.addEventListener('ephemeris-ready',    this._onEph);
        window.addEventListener('helio-state-update', this._onHelioState);
        this._loop();
        return this;
    }

    stop() {
        window.removeEventListener('swpc-update',        this._onSwpc);
        window.removeEventListener('ephemeris-ready',    this._onEph);
        window.removeEventListener('helio-state-update', this._onHelioState);
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        if (this._spiralLines) {
            for (const line of this._spiralLines) {
                line.geometry.dispose();
                line.material.dispose();
            }
        }
        if (this._hcsMesh) {
            this._hcsMesh.geometry.dispose();
            this._hcsMesh.material.dispose();
        }
        for (const ev of this._reconnEvents) {
            this._scene?.remove(ev.mesh);
            ev.mesh.geometry.dispose();
            ev.mesh.material.dispose();
        }
        this._reconnEvents = [];
        for (const p of this._prominences) {
            for (const l of (p.strands ?? [p.line])) {
                this._scene?.remove(l);
                l.geometry.dispose();
                l.material.dispose();
            }
        }
        this._prominences = [];
        for (const r of this._flareRibbons) {
            this._scene?.remove(r.line);
            r.line.geometry.dispose();
            r.line.material.dispose();
        }
        this._flareRibbons = [];
        if (this._flareSEP) {
            this._scene?.remove(this._flareSEP.line);
            this._flareSEP.line.geometry.dispose();
            this._flareSEP.line.material.dispose();
            this._flareSEP = null;
        }
        this._renderer?.dispose();
    }

    /**
     * Set the simulation time multiplier.
     * @param {number} x  1 = real-time, 1000 = 1000× (planets visibly orbit)
     */
    setTimeScale(x) {
        this._timeScale = x;
        // Snap simJD back to real time when returning to 1×
        if (x === 1) this._simJD = jdNow();
    }

    /**
     * Jump to a specific date/time and freeze (timeScale=0).
     * @param {Date} date
     */
    setSimDate(date) {
        this._simJD    = date.getTime() / 86400000 + 2440587.5;
        this._timeScale = 0;
        this._meeusUpdate(this._simJD, true);
    }

    /**
     * Jump to a specific Julian Day and freeze (timeScale=0).
     * @param {number} jd
     */
    setSimJD(jd) {
        this._simJD    = jd;
        this._timeScale = 0;
        this._meeusUpdate(this._simJD, true);
    }

    /**
     * Return current simulation Julian Day.
     * @returns {number}
     */
    getSimJD() { return this._simJD; }

    /**
     * Snap back to real-time at 1× speed.
     */
    goLive() {
        this._simJD    = jdNow();
        this._timeScale = 1;
    }

    /**
     * Fetch high-accuracy Horizons ephemeris at a specific Julian Day.
     * Falls back to Meeus if Horizons is unavailable.
     * Use this when the user jumps to a distant date where cached
     * Horizons data (which is always for "today") would be stale.
     * @param {number} jd  Julian Day to query
     */
    async fetchEphemerisAtJD(jd) {
        this._simJD = jd;
        this._timeScale = 0;  // freeze while fetching
        try {
            const svc = new EphemerisService();
            const data = await svc.load(jd);
            // Feed the result through the same handler as live data
            if (data) {
                this._onEph({ detail: data });
                console.info(`[Heliosphere] Horizons ephemeris loaded for JD ${jd.toFixed(1)}`);
            }
        } catch (err) {
            console.warn(`[Heliosphere] Horizons unavailable for JD ${jd}:`, err.message);
            this._meeusUpdate(jd, true);  // Meeus fallback
        }
    }

    // ── Event handlers ────────────────────────────────────────────────────────

    _onSwpc(ev) {
        const d   = ev.detail ?? {};
        const sw  = d.solar_wind ?? {};
        if (sw.speed   > 0)     this._sw.speed    = sw.speed;
        if (sw.density != null) this._sw.density  = sw.density;
        if (sw.bz      != null) this._sw.bz       = sw.bz;
        if (sw.bt      != null) this._sw.bt       = sw.bt;
        if (d.kp       != null) this._sw.kp       = d.kp;
        if (d.xray_class)       this._sw.xrayClass = d.xray_class;
        if (d.xray_flux)        this._sw.xrayFlux  = d.xray_flux;
        if (d.active_regions)   this._sw.regions   = d.active_regions;

        const prevCme = this._sw.cmeActive;
        this._sw.cmeActive = !!(d.earth_directed_cme || d.cme_active);
        this._sw.cmeSpeed  = d.earth_directed_cme?.speed ?? this._sw.cmeSpeed;
        if (!prevCme && this._sw.cmeActive) this._triggerCME();

        // Update magnetosphere
        if (this._magnetosphere) this._magnetosphere.update(d);

        // Trigger flare on fresh M/X class event
        const cls = this._sw.xrayClass?.[0]?.toUpperCase() ?? '';
        if ((cls === 'M' || cls === 'X') && this._sw.xrayClass !== this._lastXray) {
            this._triggerFlare(cls === 'X');
        }
        this._lastXray = this._sw.xrayClass;
    }

    _onEph(ev) {
        const d = ev.detail ?? {};
        this._eph.mercury = d.mercury ?? null;
        this._eph.venus   = d.venus   ?? null;
        this._eph.earth   = d.earth   ?? null;
        this._eph.moon    = d.moon    ?? null;
        this._eph.mars    = d.mars    ?? null;
        this._eph.jupiter = d.jupiter ?? null;
        this._eph.saturn  = d.saturn  ?? null;
        this._eph.uranus  = d.uranus  ?? null;
        this._eph.neptune = d.neptune ?? null;
        this._updateEphemerisPositions();

        // Compute full Earth orbital state and fire event for the orbit panel
        try {
            const orb = earthOrbitFull(d.jd ?? jdNow());
            this._updateOrbitalMarkers(orb);
            window.dispatchEvent(new CustomEvent('earth-orbit-update', { detail: orb }));
        } catch (err) {
            console.debug('[Heliosphere3D] earth-orbit-update skipped:', err.message);
        }
    }

    /** Receive Parker-corrected heliospheric state from SolarWindState. */
    _onHelioState(ev) {
        this._helioState = ev.detail ?? null;
    }

    // ── Build ─────────────────────────────────────────────────────────────────

    _build() {
        this._buildRenderer();
        this._buildScene();
        this._buildStarfield();
        this._buildSun();
        this._buildOrbitTrails();
        this._buildPlanets();
        this._buildHCS();          // heliospheric current sheet — below field lines
        this._buildSolarWind();    // field lines + particles on top
        this._seedMeeusPositions(); // set correct positions before first ephemeris-ready
    }

    /**
     * Synchronously seed all planet/moon positions from Meeus at startup.
     * Runs immediately after scene objects are built so planets appear at the
     * correct real-time location before any network data arrives.
     */
    _seedMeeusPositions() {
        this._simJD = jdNow();
        this._meeusUpdate(this._simJD, true);
        // Seed orbital markers and dispatch initial orbit event
        try {
            const orb = earthOrbitFull(this._simJD);
            this._updateOrbitalMarkers(orb);
            window.dispatchEvent(new CustomEvent('earth-orbit-update', { detail: orb }));
        } catch (_e) { /* no-op */ }

        // Log real-time planet positions for verification
        const _deg = r => ((r * 180 / Math.PI) % 360 + 360) % 360;
        const _au  = v => v?.toFixed(3) ?? '?';
        const date = new Date((this._simJD - 2440587.5) * 86400000);
        console.group(`%c[Heliosphere] Planet positions at ${date.toISOString().slice(0, 16)} UTC`, 'color:#4fc3f7;font-weight:bold');
        for (const name of ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']) {
            const e = this._eph[name];
            if (e) {
                console.log(`  ${name.padEnd(8)} lon=${_deg(e.lon_rad).toFixed(1).padStart(6)}°  r=${_au(e.dist_AU)} AU  (${e.source})`);
            }
        }
        console.log(`  ${'moon'.padEnd(8)} lon=${_deg(this._eph.moon?.lon_rad).toFixed(1).padStart(6)}°  r=${_au(this._eph.moon?.dist_AU)} AU`);
        console.groupEnd();
    }

    /**
     * Core Meeus position update.
     * @param {number}  jd        Julian Day to compute for
     * @param {boolean} forceAll  When true, compute all 8 planets (used during time warp)
     */
    _meeusUpdate(jd, forceAll = false) {
        const mk = fn => ({ ...fn(jd), source: 'meeus' });
        const m  = moonGeocentric(jd);

        // Inner planets + Earth + Moon: always Meeus
        this._eph.mercury = mk(mercuryHeliocentric);
        this._eph.venus   = mk(venusHeliocentric);
        this._eph.earth   = mk(earthHeliocentric);
        this._eph.mars    = mk(marsHeliocentric);
        this._eph.moon    = { lon_rad: m.lon_rad, lat_rad: m.lat_rad,
                               dist_km: m.dist_km,  dist_AU: m.dist_AU, source: 'meeus' };

        // Outer planets: always compute from VSOP87D unless we have live Horizons data.
        // (Horizons data has source='horizons'; VSOP87D has source='vsop87'.)
        const noHorizons = name => this._eph[name]?.source !== 'horizons';
        if (forceAll || noHorizons('jupiter')) this._eph.jupiter = mk(jupiterHeliocentric);
        if (forceAll || noHorizons('saturn'))  this._eph.saturn  = mk(saturnHeliocentric);
        if (forceAll || noHorizons('uranus'))  this._eph.uranus  = mk(uranusHeliocentric);
        if (forceAll || noHorizons('neptune')) this._eph.neptune = mk(neptuneHeliocentric);

        this._updateEphemerisPositions();
        this._tickMarsSystem();

        // Tick all moon systems at the current simulation JD
        this._jupiterMoons?.tick(jd);
        this._saturnMoons?.tick(jd);
        this._uranusMoons?.tick(jd);
        this._neptuneMoons?.tick(jd);

        // Apply axial tilt + rotation to all planets
        for (const name of ['mercury', 'venus', 'mars']) {
            applyPlanetSpin(this._planetMeshes[name], name, jd);
        }
        // For grouped planets, apply spin to the sphere child (not the group).
        // Skip Jupiter — JupiterSkin handles its own rotation via shader uniforms.
        for (const [name, group] of [
            ['saturn',  this._planetMeshes.saturn],
            ['uranus',  this._planetMeshes.uranus],
            ['neptune', this._planetMeshes.neptune],
        ]) {
            const sphere = group?.children?.find(c => c.name === name);
            if (sphere) applyPlanetSpin(sphere, name, jd);
        }

        // Update orbit trail precession (only rebuilds if epoch changed >1 day)
        if (this._orbitTrails) this._orbitTrails.update(jd);

        // Update orbital markers (perihelion, aphelion, L1, L2) during time warp
        if (forceAll) {
            try {
                const orb = earthOrbitFull(jd);
                this._updateOrbitalMarkers(orb);
                this._earthOrbitEllipse = {
                    a_au: orb.a, e: orb.e,
                    b_au: orb.a * Math.sqrt(1 - orb.e * orb.e),
                    omega_bar_rad: orb.omega_bar_rad,
                };
                window.dispatchEvent(new CustomEvent('earth-orbit-update', { detail: orb }));
            } catch (_e) { /* orb panel unavailable */ }
        }
    }

    /**
     * Per-frame planet tick.  Throttled to 1 Hz at real-time speed; runs every
     * frame during time warp.  Uses this._simJD which advances at
     * (timeScale × real-time) rate.
     */
    _tickLivePlanets() {
        const warp = this._timeScale > 1;
        if (!warp) {
            const now = performance.now();
            if (this._lastMeeusMs != null && now - this._lastMeeusMs < 1000) return;
            this._lastMeeusMs = now;
        }
        this._meeusUpdate(this._simJD, warp);
    }

    _buildRenderer() {
        this._renderer = new THREE.WebGLRenderer({
            canvas:    this._canvas,
            antialias: true,
            alpha:     false,
        });
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this._renderer.outputColorSpace = THREE.SRGBColorSpace;
        this._renderer.setClearColor(0x02010a);

        const rect = this._canvas.getBoundingClientRect();
        this._renderer.setSize(rect.width, rect.height, false);

        // Far plane 4500 units covers Neptune at ~30 AU = 3000 units with margin
        this._camera = new THREE.PerspectiveCamera(45, rect.width / rect.height, 0.05, 4500);
        // Start at 35° elevation above ecliptic — shows 3D inclinations clearly
        this._camera.position.set(0, 200, 420);
        this._camera.lookAt(0, 0, 0);

        this._controls = new OrbitControls(this._camera, this._canvas);
        this._controls.enableDamping  = true;
        this._controls.dampingFactor  = 0.07;
        this._controls.minDistance    = 2;
        this._controls.maxDistance    = 3500;
        this._controls.autoRotate     = false;
        this._controls.zoomSpeed      = 1.2;
    }

    _buildScene() {
        this._scene = new THREE.Scene();
        // Sun light — illuminates planets
        const sun = new THREE.PointLight(0xfff5e0, 2.5, 0, 1.4);
        this._scene.add(sun);
        // Ambient fill so night sides aren't pure black
        this._scene.add(new THREE.AmbientLight(0x101828, 1.0));
    }

    _buildStarfield() {
        const N   = 4000;
        const pos = new Float32Array(N * 3);
        const col = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            // Fibonacci sphere distribution for uniform coverage
            const theta = Math.acos(1 - 2 * (i + 0.5) / N);
            const phi   = Math.PI * (1 + Math.sqrt(5)) * i;
            const r     = 900 + Math.random() * 100;
            pos[i*3]   = r * Math.sin(theta) * Math.cos(phi);
            pos[i*3+1] = r * Math.sin(theta) * Math.sin(phi);
            pos[i*3+2] = r * Math.cos(theta);
            const br   = 0.5 + Math.random() * 0.5;
            const tint = Math.random();
            col[i*3]   = br * (tint > 0.7 ? 1.0 : tint > 0.4 ? 0.85 : 0.8);
            col[i*3+1] = br * (tint > 0.7 ? 0.9 : tint > 0.4 ? 0.9  : 0.8);
            col[i*3+2] = br * (tint > 0.7 ? 0.8 : tint > 0.4 ? 1.0  : 1.0);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
        const mat = new THREE.PointsMaterial({
            size:         0.8,
            vertexColors: true,
            sizeAttenuation: false,
            depthWrite:   false,
        });
        this._scene.add(new THREE.Points(geo, mat));
    }

    _buildSun() {
        // ── Photosphere — custom GLSL shader ─────────────────────────────────────
        // Two-tier convection (supergranulation + granulation), limb darkening,
        // chromospheric spicules, active-region sunspots, flare UV arc glow.
        this._sunUniforms = createSunUniforms(THREE);
        const core = new THREE.Mesh(
            new THREE.SphereGeometry(R.sun, 48, 48),
            new THREE.ShaderMaterial({
                vertexShader:   SUN_VERT,
                fragmentShader: SUN_FRAG,
                uniforms:       this._sunUniforms,
            })
        );
        core.name = 'sun_core';
        this._scene.add(core);
        this._sunCore = core;

        // ── Corona glow layers — 4 nested additive halos ─────────────────────────
        // Layout:
        //   [0] Chromosphere / transition region (1.25×) — always present
        //   [1] Inner K-corona                  (1.65×) — bloom-scaled
        //   [2] K-corona                        (2.30×) — bloom-scaled
        //   [3] Outer F-corona                  (3.40×) — bloom-scaled, dimmer
        //
        // The baseScale and baseOpacity are stored so setBloom() can rescale
        // them without rebuilding geometry.
        this._coronaDef = [
            { baseScale: 1.25, baseOpacity: 0.28, color: 0xff8800 },
            { baseScale: 1.65, baseOpacity: 0.11, color: 0xff6600 },
            { baseScale: 2.30, baseOpacity: 0.055, color: 0xff4400 },
            { baseScale: 3.40, baseOpacity: 0.022, color: 0xff2200 },
        ];
        this._coronaMeshes = [];
        for (const def of this._coronaDef) {
            const glow = new THREE.Mesh(
                new THREE.SphereGeometry(R.sun * def.baseScale, 24, 24),
                new THREE.MeshBasicMaterial({
                    color:       def.color,
                    transparent: true,
                    opacity:     def.baseOpacity,
                    blending:    THREE.AdditiveBlending,
                    depthWrite:  false,
                    side:        THREE.BackSide,
                })
            );
            glow.renderOrder = 2;
            this._scene.add(glow);
            this._coronaMeshes.push({ mesh: glow, baseOpacity: def.baseOpacity, baseScale: def.baseScale });
        }
    }

    /**
     * Set the corona bloom level (0.3 = minimal, 1.0 = default, 3.0 = max).
     * Scales all four corona halo layers proportionally and updates the sun
     * shader's u_bloom uniform so granulation/spicule brightness tracks too.
     * Exposed to space-weather.html via window._helio3d.setBloom(v).
     * @param {number} v  Bloom level clamped to [0.3, 3.0]
     */
    /**
     * Forward a substorm onset index [0,1] to the MagnetosphereEngine so the
     * aurora curtains flash and the plasma sheet brightens.
     * Call this from 'sw-magnet-coupling' event handler in space-weather.html.
     * @param {number} idx  substorm index [0,1]
     */
    setSubstormIndex(idx) {
        this._magnetosphere?.setSubstorm(idx);
    }

    setBloom(v) {
        this._bloomLevel = Math.max(0.3, Math.min(3.0, v));
        if (this._sunUniforms?.u_bloom) {
            this._sunUniforms.u_bloom.value = this._bloomLevel;
        }
        // Outer F-corona (index 3) only becomes visible above bloom ~0.7
        if (this._coronaMeshes) {
            this._coronaMeshes.forEach((c, i) => {
                c.mesh.material.opacity = c.baseOpacity * this._bloomLevel;
            });
        }
    }

    _buildOrbitTrails() {
        // 3D precessing orbital ellipses for all 8 planets.
        // Uses orbit-trails.js which computes true Keplerian ellipses with
        // secular correction rates — orbits precess during time warp.
        this._orbitTrails = new OrbitTrails(this._scene, AU, { samples: 256 });
        this._orbitTrails.update(this._simJD);

        // Store Earth ellipse params for orbital markers (backward compat)
        const orb = earthOrbitFull(jdNow());
        this._earthOrbitEllipse = {
            a_au: orb.a, e: orb.e,
            b_au: orb.a * Math.sqrt(1 - orb.e * orb.e),
            omega_bar_rad: orb.omega_bar_rad,
        };

        // ── Orbital markers (perihelion, aphelion, L1, L2, velocity arrow) ──
        this._buildOrbitalMarkers();
    }

    /** Build/update perihelion, aphelion, L1, L2 markers and velocity arrow. */
    _buildOrbitalMarkers() {
        // Lazily create marker group
        if (!this._orbitMarkers) {
            this._orbitMarkers = new THREE.Group();
            this._orbitMarkers.name = 'orbit_markers';
            this._scene.add(this._orbitMarkers);
        }
        // Will be populated/updated on first ephemeris-ready via _updateOrbitalMarkers()
    }

    /** Update orbital markers from full Earth orbit state. */
    _updateOrbitalMarkers(orb) {
        if (!this._orbitMarkers) return;

        // Remove old children
        while (this._orbitMarkers.children.length) {
            const c = this._orbitMarkers.children[0];
            c.geometry?.dispose();
            c.material?.dispose();
            this._orbitMarkers.remove(c);
        }

        const { a_au, e, omega_bar_rad: omR } = this._earthOrbitEllipse
            ?? { a_au: orb.a, e: orb.e, omega_bar_rad: orb.omega_bar_rad };

        const cosOm = Math.cos(omR), sinOm = Math.sin(omR);

        // ── Perihelion marker (ν = 0, E = 0) ─────────────────────────────────
        const peri_x = (a_au * (1 - e) * cosOm) * AU;
        const peri_z = (a_au * (1 - e) * sinOm) * AU;
        this._orbitMarkers.add(this._makeOrbitDot(
            new THREE.Vector3(peri_x, 0, peri_z),
            0xffcc44, 0.9, 'perihelion'
        ));

        // ── Aphelion marker (ν = π, E = π) ───────────────────────────────────
        const aph_x = (-a_au * (1 + e) * cosOm) * AU;
        const aph_z = (-a_au * (1 + e) * sinOm) * AU;
        this._orbitMarkers.add(this._makeOrbitDot(
            new THREE.Vector3(aph_x, 0, aph_z),
            0x6699ff, 0.9, 'aphelion'
        ));

        // ── L1 marker (between Sun and Earth, ~0.99 AU) ───────────────────────
        const L1 = orb.lagrange.L1;
        this._orbitMarkers.add(this._makeOrbitDot(
            new THREE.Vector3(L1.x_AU * AU, L1.z_AU * AU, L1.y_AU * AU),
            0x00ffcc, 0.7, 'L1'
        ));

        // ── L2 marker (anti-Sun, ~1.01 AU) ────────────────────────────────────
        const L2 = orb.lagrange.L2;
        this._orbitMarkers.add(this._makeOrbitDot(
            new THREE.Vector3(L2.x_AU * AU, L2.z_AU * AU, L2.y_AU * AU),
            0xff88ff, 0.7, 'L2'
        ));

        // ── Velocity arrow at Earth's current position ─────────────────────────
        const ep = this._earthGroup.position;
        if (ep && orb.speed_km_s > 0) {
            // Velocity direction in ecliptic → Three.js space
            const vmag = Math.sqrt(orb.vx_km_s ** 2 + orb.vy_km_s ** 2 + orb.vz_km_s ** 2);
            const vDir = new THREE.Vector3(
                orb.vx_km_s / vmag,
                orb.vz_km_s / vmag,   // ecl.Z → scene.Y
                orb.vy_km_s / vmag,   // ecl.Y → scene.Z
            );
            const arrowLen = R.earth * 6;
            const arrow = new THREE.ArrowHelper(
                vDir, ep.clone(), arrowLen,
                0x44ff88, arrowLen * 0.25, arrowLen * 0.12
            );
            arrow.name = 'velocity_arrow';
            this._orbitMarkers.add(arrow);
        }
    }

    /** Small labelled dot sprite for orbit markers. */
    _makeOrbitDot(pos, color, opacity, label) {
        const geo  = new THREE.SphereGeometry(0.45, 8, 8);
        const mat  = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(pos);
        mesh.name = label;
        return mesh;
    }

    /** Create a canvas-texture Sprite label for a planet. */
    _makeLabelSprite(name) {
        const W = 160, H = 40;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);
        ctx.font = 'bold 20px sans-serif';
        ctx.fillStyle = '#dddddd';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(name.charAt(0).toUpperCase() + name.slice(1), W / 2, H / 2);
        const tex = new THREE.CanvasTexture(canvas);
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.75, depthWrite: false });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.set(W * 0.04, H * 0.04, 1);
        return sprite;
    }

    _buildPlanets() {
        // Simple helper for non-Earth planets
        const mkPlanet = (name, radius, color) => {
            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(radius, 20, 20),
                new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 })
            );
            mesh.name = name;
            this._scene.add(mesh);
            return mesh;
        };

        this._planetMeshes.mercury = mkPlanet('mercury', R.mercury, COL.mercury);
        this._planetMeshes.venus   = mkPlanet('venus',   R.venus,   COL.venus);

        // ── Mars system — group holds Mars + Phobos + Deimos ─────────────────
        this._marsGroup = new THREE.Group();
        this._marsGroup.name = 'mars_group';
        this._scene.add(this._marsGroup);

        const marsSphere = new THREE.Mesh(
            new THREE.SphereGeometry(R.mars, 20, 20),
            new THREE.MeshStandardMaterial({ color: COL.mars, roughness: 0.9, metalness: 0 })
        );
        marsSphere.name = 'mars';
        this._marsGroup.add(marsSphere);
        // Keep the reference for position updates (marsGroup is the positionable object)
        this._planetMeshes.mars = this._marsGroup;

        // Phobos and Deimos — tiny moons in tilted equatorial orbital plane
        // Their local orbit plane is rotated MARS_MOON_TILT around local X
        const moonPlane = new THREE.Group();
        moonPlane.name  = 'mars_moon_plane';
        moonPlane.rotation.x = MARS_MOON_TILT;
        this._marsGroup.add(moonPlane);

        this._phobos = new THREE.Mesh(
            new THREE.SphereGeometry(R.phobos, 8, 8),
            new THREE.MeshStandardMaterial({ color: MARS_MOONS.phobos.color, roughness: 0.95 })
        );
        this._phobos.name = 'phobos';
        moonPlane.add(this._phobos);

        this._deimos = new THREE.Mesh(
            new THREE.SphereGeometry(R.deimos, 8, 8),
            new THREE.MeshStandardMaterial({ color: MARS_MOONS.deimos.color, roughness: 0.95 })
        );
        this._deimos.name = 'deimos';
        moonPlane.add(this._deimos);

        // Planet labels (canvas Sprite above each body)
        this._planetLabels = {};
        for (const name of ['mercury', 'venus', 'mars']) {
            const lbl = this._makeLabelSprite(name);
            this._scene.add(lbl);
            this._planetLabels[name] = lbl;
        }

        // NOTE: default positions are no longer needed here — _seedMeeusPositions()
        // (called at the end of _build()) computes real-time positions for all
        // planets synchronously before the first frame renders.

        // ── Earth ─────────────────────────────────────────────────────────────
        this._earthGroup = new THREE.Group();
        this._earthGroup.name = 'earth_group';
        this._scene.add(this._earthGroup);

        // Earth sphere — shared Blue Marble skin (aurora + city lights off at this scale)
        this._earthSkinU = createEarthUniforms(new THREE.Vector3(1, 0, 0));
        this._earthSkinU.u_aurora_on.value   = 0;
        this._earthSkinU.u_city_lights.value = 1;
        const earthMesh = new THREE.Mesh(
            new THREE.SphereGeometry(R.earth, 28, 28),
            new THREE.ShaderMaterial({
                vertexShader: EARTH_VERT, fragmentShader: EARTH_FRAG,
                uniforms: this._earthSkinU,
            })
        );
        earthMesh.name = 'earth';
        this._earthGroup.add(earthMesh);
        // Load textures asynchronously — shows blue fallback until ready
        loadEarthTextures(this._earthSkinU, null);

        // Thin atmosphere rim (additive glow)
        const atmo = new THREE.Mesh(
            new THREE.SphereGeometry(R.earth * 1.12, 24, 24),
            new THREE.MeshBasicMaterial({
                color:       0x4488ff,
                transparent: true,
                opacity:     0.14,
                blending:    THREE.AdditiveBlending,
                depthWrite:  false,
                side:        THREE.BackSide,
            })
        );
        atmo.renderOrder = 2;
        this._earthGroup.add(atmo);

        // Moon
        this._moonMesh = new THREE.Mesh(
            new THREE.SphereGeometry(R.moon, 12, 12),
            new THREE.MeshStandardMaterial({ color: COL.moon, roughness: 0.9 })
        );
        this._moonMesh.name = 'moon';
        this._earthGroup.add(this._moonMesh);

        // ── Magnetosphere — parented to earthGroup ───────────────────────────
        // MagnetosphereEngine calls parent.add() so passing earthGroup works:
        // all magnetosphere geometry lives in Earth-local space.
        if (this._opts.showMagnetosphere) {
            this._magnetosphere = new MagnetosphereEngine(this._earthGroup);
        }

        // Earth label
        const earthLabel = this._makeLabelSprite('earth');
        this._scene.add(earthLabel);
        this._planetLabels.earth = earthLabel;

        // Default earth position (overwritten by ephemeris)
        this._earthGroup.position.set(AU, 0, 0);

        // ── Jupiter — full cloud band shader + GRS + atmosphere + faint rings ──
        const jupiterGroup = new THREE.Group();
        jupiterGroup.name = 'jupiter_group';
        this._scene.add(jupiterGroup);
        this._jupiterSkin = new JupiterSkin(jupiterGroup, {
            radius:   R.jupiter,
            quality:  'medium',
            rings:    true,
            atmosphere: true,
            segments: 32,
        });
        this._planetMeshes.jupiter = jupiterGroup;
        this._jupiterMoons = new MoonSystem(
            jupiterGroup, JUPITER_MOONS, AU, R.jupiter,
            PLANET_SPIN.jupiter.obliquity * D2R
        );

        // ── Saturn — group with rings + Titan/Rhea/Dione ────────────────────
        const saturnGroup = new THREE.Group();
        saturnGroup.name = 'saturn_group';
        this._scene.add(saturnGroup);
        const saturnSphere = new THREE.Mesh(
            new THREE.SphereGeometry(R.saturn, 24, 24),
            new THREE.MeshStandardMaterial({ color: COL.saturn, roughness: 0.75, metalness: 0.05 })
        );
        saturnSphere.name = 'saturn';
        saturnGroup.add(saturnSphere);

        // Saturn's ring system
        const ringTilt = 27 * Math.PI / 180;
        for (const [inner, outer, opacity] of [
            [R.saturn * 1.55, R.saturn * 2.05, 0.55],
            [R.saturn * 2.10, R.saturn * 2.40, 0.35],
        ]) {
            const ringGeo = new THREE.RingGeometry(inner, outer, 80);
            const ringMat = new THREE.MeshBasicMaterial({
                color:       0xd4c88a,
                side:        THREE.DoubleSide,
                transparent: true,
                opacity,
                depthWrite:  false,
            });
            const ring = new THREE.Mesh(ringGeo, ringMat);
            ring.rotation.x = Math.PI / 2 - ringTilt;
            saturnGroup.add(ring);
        }
        this._planetMeshes.saturn = saturnGroup;
        this._saturnMoons = new MoonSystem(
            saturnGroup, SATURN_MOONS, AU, R.saturn, ringTilt
        );

        // ── Uranus — group with faint rings + Titania/Oberon ────────────────
        const uranusGroup = new THREE.Group();
        uranusGroup.name = 'uranus_group';
        this._scene.add(uranusGroup);
        const uranusSphere = new THREE.Mesh(
            new THREE.SphereGeometry(R.uranus, 20, 20),
            new THREE.MeshStandardMaterial({ color: COL.uranus, roughness: 0.85, metalness: 0 })
        );
        uranusSphere.name = 'uranus';
        uranusGroup.add(uranusSphere);
        createUranusRings(uranusGroup, R.uranus);
        this._planetMeshes.uranus = uranusGroup;
        this._uranusMoons = new MoonSystem(
            uranusGroup, URANUS_MOONS, AU, R.uranus,
            PLANET_SPIN.uranus.obliquity * D2R
        );

        // ── Neptune — group with Triton ──────────────────────────────────────
        const neptuneGroup = new THREE.Group();
        neptuneGroup.name = 'neptune_group';
        this._scene.add(neptuneGroup);
        const neptuneSphere = new THREE.Mesh(
            new THREE.SphereGeometry(R.neptune, 20, 20),
            new THREE.MeshStandardMaterial({ color: COL.neptune, roughness: 0.85, metalness: 0 })
        );
        neptuneSphere.name = 'neptune';
        neptuneGroup.add(neptuneSphere);
        this._planetMeshes.neptune = neptuneGroup;
        this._neptuneMoons = new MoonSystem(
            neptuneGroup, NEPTUNE_MOONS, AU, R.neptune,
            PLANET_SPIN.neptune.obliquity * D2R
        );

        // Labels for all outer planets
        for (const name of ['jupiter', 'saturn', 'uranus', 'neptune']) {
            const lbl = this._makeLabelSprite(name);
            this._scene.add(lbl);
            this._planetLabels[name] = lbl;
        }
    }

    _setDefaultPlanetPositions() {
        for (const [name, dist] of Object.entries(ORBIT_AU)) {
            if (name === 'earth') continue;
            const obj = this._planetMeshes[name];
            if (obj) obj.position.set(dist * AU, 0, 0);
        }
    }

    // ── Heliospheric Current Sheet ("ballerina skirt") ────────────────────────
    //
    // The HCS is the 3D surface separating IMF "away" (By>0) and "toward" (By<0)
    // polarity sectors.  It lies roughly in the solar equatorial plane but warps
    // sinusoidally above/below by an amplitude (tilt) that grows with solar
    // activity (Kp proxy).  The surface co-rotates with the Sun.
    //
    // Geometry: a disc from r≈0 to MAX_R_AU, with Y displacement
    //   Y(r, φ) = r_px × tilt × r_AU^0.4 × sin(φ)
    // The mesh is rotated each frame by this._rot so it co-rotates with the field
    // lines without needing per-frame vertex updates.

    _buildHCS() {
        const N_R   = HCS_NR;
        const N_PHI = HCS_NPHI;
        const positions = new Float32Array(N_R * N_PHI * 3);

        // Build index buffer (quad triangles — topology is fixed forever)
        const indices = [];
        for (let ir = 0; ir < N_R - 1; ir++) {
            for (let ip = 0; ip < N_PHI; ip++) {
                const a = ir * N_PHI + ip;
                const b = ir * N_PHI + (ip + 1) % N_PHI;
                const c = (ir + 1) * N_PHI + ip;
                const d = (ir + 1) * N_PHI + (ip + 1) % N_PHI;
                indices.push(a, b, d,  a, d, c);
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setIndex(indices);

        const mat = new THREE.MeshBasicMaterial({
            color:       0x1e3a5f,   // dark blue — shows magnetic neutral layer
            transparent: true,
            opacity:     0.13,
            side:        THREE.DoubleSide,
            depthWrite:  false,
            blending:    THREE.NormalBlending,
        });

        this._hcsMesh   = new THREE.Mesh(geo, mat);
        this._hcsMesh.renderOrder = 1;
        this._scene.add(this._hcsMesh);
        this._hcsPosArr = positions;

        // Compute initial warp from current Kp
        const kp        = this._sw.kp || 2;
        this._hcsTilt   = 0.07 + 0.25 * Math.min(1, kp / 9);
        this._updateHCSPositions();
    }

    // Recompute all vertex Y positions from the current tilt amplitude.
    // Called at build time and whenever Kp changes enough to update tilt.
    _updateHCSPositions() {
        const N_R   = HCS_NR;
        const N_PHI = HCS_NPHI;
        const pos   = this._hcsPosArr;
        const tilt  = this._hcsTilt;

        for (let ir = 0; ir < N_R; ir++) {
            const r_AU = 0.04 + (MAX_R_AU - 0.04) * ir / (N_R - 1);
            const r_px = r_AU * AU;
            // Amplitude grows slowly with r (power 0.4) matching observational HCS models
            const amp  = tilt * Math.pow(r_AU, 0.4);
            for (let ip = 0; ip < N_PHI; ip++) {
                const phi  = ip / N_PHI * Math.PI * 2;
                const idx  = (ir * N_PHI + ip) * 3;
                pos[idx]     = r_px * Math.cos(phi);
                pos[idx + 1] = r_px * amp * Math.sin(phi);   // latitude warp
                pos[idx + 2] = r_px * Math.sin(phi);
            }
        }
        this._hcsMesh.geometry.attributes.position.needsUpdate = true;
    }

    // Tick: just co-rotate the HCS with the solar rotation, and lazily update
    // tilt when Kp has shifted enough.
    _tickHCS() {
        if (!this._hcsMesh) return;
        // Co-rotate with the same slow solar rotation driving the field lines
        this._hcsMesh.rotation.y = this._rot;

        const kp      = this._sw.kp || 2;
        const newTilt = 0.07 + 0.25 * Math.min(1, kp / 9);
        if (Math.abs(newTilt - this._hcsTilt) > 0.008) {
            this._hcsTilt = newTilt;
            this._updateHCSPositions();
        }
    }

    // ── Solar wind particles ──────────────────────────────────────────────────

    _buildSolarWind() {
        if (!this._opts.showWind) return;

        // Precompute Parker speed-ratio LUT (200 pts, 0.002–2.1 AU, T_corona = 1.5 MK)
        // The LUT encodes V(r)/V(1 AU) from the Parker (1958) transcendental equation.
        // Particles closer to the sun advect much more slowly (factor ~15–20 near corona),
        // creating a physically-correct dense coronal glow that thins into the outer wind.
        this._parkerLUT = buildParkerLUT(200, 0.002, 2.1, 1.5e6);

        // ── Per-arm bimodal stream-speed distribution ─────────────────────────
        // Solar wind is bimodal:  fast wind from coronal holes (500–750 km/s,
        // hotter corona, thinner Parker spiral)  vs  slow wind from the streamer
        // belt (300–450 km/s, denser, wider spiral).  Boundaries between fast and
        // slow arms create Corotating Interaction Regions (CIRs) — the dominant
        // ambient structure between solar minimum storms.
        this._armBaseSpeeds = new Float32Array(N_SPIRAL);
        this._armTypes      = new Uint8Array(N_SPIRAL);
        for (let a = 0; a < N_SPIRAL; a++) {
            const isFast = Math.random() < 0.40;
            this._armTypes[a]      = isFast ? 1 : 0;
            this._armBaseSpeeds[a] = isFast
                ? 500 + Math.random() * 250   // fast:  500–750 km/s
                : 300 + Math.random() * 150;  // slow:  300–450 km/s
        }

        const N = N_WIND;
        this._windPos       = new Float32Array(N * 3);
        this._windR         = new Float32Array(N);   // r_AU along spiral
        this._windPY        = new Float32Array(N);   // sin(latitude) — constant per particle
        this._windVY        = new Float32Array(N);   // unused; retained for shape compat
        this._windArm       = new Float32Array(N);   // source longitude (rad, 0–2π)
        this._windJitter    = new Float32Array(N);   // fixed angular jitter
        this._windArmIdx    = new Int16Array(N);     // index into _armBaseSpeeds
        this._windAge       = new Float32Array(N);   // age (s)
        this._windMaxAge    = new Float32Array(N);   // max age (s)
        this._windSpeedAttr = new Float32Array(N);   // 0=slow stream, 1=fast stream (GPU)

        for (let i = 0; i < N; i++) this._spawnWind(i, true);

        // ── GPU buffer geometry ───────────────────────────────────────────────
        // Shader attributes reuse the same typed arrays that the CPU tick updates,
        // so no extra copying — just mark needsUpdate each frame.
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position',  new THREE.BufferAttribute(this._windPos,       3));
        geo.setAttribute('a_r',       new THREE.BufferAttribute(this._windR,         1));
        geo.setAttribute('a_lat',     new THREE.BufferAttribute(this._windPY,        1));
        geo.setAttribute('a_src_lon', new THREE.BufferAttribute(this._windArm,       1));
        geo.setAttribute('a_age',     new THREE.BufferAttribute(this._windAge,       1));
        geo.setAttribute('a_speed',   new THREE.BufferAttribute(this._windSpeedAttr, 1));

        // ── Initial u_scale (updated every _resize()) ────────────────────────
        const initScale = 0.5 * this._renderer.domElement.height;

        this._windUniforms = {
            u_bz:       { value: 0 },
            u_by:       { value: 5 },
            u_bt:       { value: 5 },
            u_density:  { value: 5 },
            u_time:     { value: 0 },
            u_scale:    { value: initScale },
            u_rot:      { value: 0 },
            u_awayFirst:{ value: 1 },
            u_pulses:   { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, 0, 0)) },
            u_pulse_n:  { value: 0 },
            u_maxR:     { value: MAX_R_AU },
        };

        const mat = new THREE.ShaderMaterial({
            vertexShader:   _WIND_VERT,
            fragmentShader: _WIND_FRAG,
            uniforms:       this._windUniforms,
            blending:       THREE.AdditiveBlending,
            depthWrite:     false,
            transparent:    true,
        });

        this._windPoints = new THREE.Points(geo, mat);
        this._windPoints.renderOrder = 3;
        this._scene.add(this._windPoints);

        // Build the Parker spiral arm backbone lines + Alfvén surface
        this._buildSpiralLines();
        this._buildAlvenSurface();
    }

    _buildSpiralLines() {
        // Sample N_SPIRAL field lines evenly around the full solar disk.
        // This is the standard way textbook "Parker spiral" images are drawn:
        // they show a handful of representative field lines, not discrete "arms".
        // The first N_SPIRAL/2 lines form the "away" sector (By>0 = field pointing
        // away from Sun), the second half form the "toward" sector.  Colors and
        // tint are updated live in _tickWind() from the measured By component.
        this._spiralLines    = [];
        this._spiralLinePts  = [];
        this._spiralLineCols = [];

        for (let arm = 0; arm < N_SPIRAL; arm++) {
            const pts  = new Float32Array(N_LINE * 3);
            const cols = new Float32Array(N_LINE * 3);
            const geo  = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(pts,  3));
            geo.setAttribute('color',    new THREE.BufferAttribute(cols, 3));
            const mat  = new THREE.LineBasicMaterial({
                vertexColors: true,
                transparent:  true,
                opacity:      0.9,
                blending:     THREE.AdditiveBlending,
                depthWrite:   false,
            });
            const line = new THREE.Line(geo, mat);
            line.renderOrder = 2;
            this._scene.add(line);
            this._spiralLines.push(line);
            this._spiralLinePts.push(pts);
            this._spiralLineCols.push(cols);
        }
    }

    // ── Alfvén surface ────────────────────────────────────────────────────────
    //
    // The Alfvén surface is where the solar wind speed equals the Alfvén wave
    // speed V_A = B/√(μ₀ρ).  Inside this surface the solar corona is
    // magnetically coupled to the Sun — it's where the Sun loses its angular
    // momentum.  Parker Solar Probe (2021) measured it at 13–20 R☉ ≈ 0.06–0.09 AU.
    // We render it as a translucent cyan sphere that gently pulsates with solar
    // activity, providing a reference boundary for the inner corona region.

    _buildAlvenSurface() {
        const r = 0.075 * AU;   // 0.075 AU ≈ 16 R☉ — median PSP measurement
        const geo = new THREE.SphereGeometry(r, 48, 32);
        const mat = new THREE.MeshBasicMaterial({
            color:       0x00e8ff,
            transparent: true,
            opacity:     0.045,
            blending:    THREE.AdditiveBlending,
            depthWrite:  false,
            side:        THREE.DoubleSide,
        });
        this._alfvenMesh     = new THREE.Mesh(geo, mat);
        this._alfvenMesh.renderOrder = 1;
        this._alfvenMesh.scale.setScalar(1.0);
        this._scene.add(this._alfvenMesh);

        // Ring wireframe at the equatorial crossing — highlights the HCS boundary
        const ringGeo = new THREE.TorusGeometry(r, r * 0.012, 8, 80);
        const ringMat = new THREE.MeshBasicMaterial({
            color:       0x44ffff,
            transparent: true,
            opacity:     0.18,
            blending:    THREE.AdditiveBlending,
            depthWrite:  false,
        });
        this._alfvenRing = new THREE.Mesh(ringGeo, ringMat);
        this._alfvenRing.renderOrder = 2;
        this._scene.add(this._alfvenRing);

        this._alfvenPhase = 0;
        this._alfvenBaseR = r;
    }

    // Gently oscillate the Alfvén surface — radius and opacity track solar activity
    _tickAlvenSurface(dt) {
        if (!this._alfvenMesh) return;
        this._alfvenPhase += dt * 0.35;

        // Activity-driven radius: solar wind speed pushes the Alfvén surface inward
        const speed   = this._helioState?.v_sw ?? this._sw.speed ?? 450;
        const density = this._helioState?.n    ?? this._sw.density ?? 5;
        // Higher speed / lower density → larger Alfvén radius (closer to Sun)
        const actFrac = Math.min(1, (speed / 750) * Math.sqrt(5 / Math.max(1, density)));
        // Oscillate ±8% around activity-modulated radius
        const pulse   = 1.0 + 0.08 * Math.sin(this._alfvenPhase) - actFrac * 0.12;
        this._alfvenMesh.scale.setScalar(pulse);

        // Opacity: brighter during storms, dim during quiet sun
        const bzSouth = Math.max(0, -(this._helioState?.bz ?? this._sw.bz ?? 0) / 20);
        this._alfvenMesh.material.opacity = 0.035 + bzSouth * 0.06 + 0.015 * Math.sin(this._alfvenPhase * 1.7);
        this._alfvenRing.material.opacity = 0.12  + bzSouth * 0.10 + 0.04  * Math.sin(this._alfvenPhase * 2.3);
        this._alfvenRing.scale.setScalar(pulse);
    }

    _spawnWind(i, scatter = false) {
        // Every particle originates from a unique, randomly-chosen heliographic
        // longitude on the solar surface.  There are no discrete "arms" for
        // emission — the Parker spiral equation applies equally to every longitude.
        // The N_SPIRAL backbone lines are purely a visual guide overlay.
        this._windArm[i]    = Math.random() * Math.PI * 2;   // source longitude (rad)
        // Snap to nearest backbone arm to inherit its stream speed class
        if (this._armBaseSpeeds) {
            this._windArmIdx[i] = Math.round(
                this._windArm[i] / (Math.PI * 2 / N_SPIRAL)
            ) % N_SPIRAL;
        }
        // Start at the coronal base (~0.008–0.02 AU ≈ 1.7–4 R☉).
        // Scatter=true seeds the initial cloud spread across the full disc.
        this._windR[i]      = scatter
            ? 0.008 + Math.random() * (MAX_R_AU - 0.008)
            : 0.008 + Math.random() * 0.015;
        // Narrow stream jitter (±4°) — models the finite angular width of a
        // coronal hole / streamer stream without creating visible discrete blobs.
        this._windJitter[i] = (Math.random() - 0.5) * 0.14;
        // Heliographic latitude: sin(lat) stored; Y = sinLat × r_px each frame.
        // Distribution mimics real solar wind: most particles near equatorial
        // (|lat|<15°, slow wind) with a minority at higher latitudes (fast polar wind).
        const u = Math.random();
        if (u < 0.72) {
            // Slow equatorial wind belt (±15°) — streamer belt / HCS region
            this._windPY[i] = (Math.random() - 0.5) * 0.52;   // sin(±15°) ≈ ±0.26
        } else {
            // Fast polar wind (15–45°) — coronal hole streams
            const sign = Math.random() < 0.5 ? 1 : -1;
            this._windPY[i] = sign * (0.26 + Math.random() * 0.45);  // sin(15–45°)
        }
        this._windVY[i]     = 0;
        this._windAge[i]    = scatter ? 2.0 : 0;
        this._windMaxAge[i] = 9999;  // position-based kill only

        // GPU speed attribute: fast-stream (1.0) vs slow-stream (0.0)
        // Used in vertex shader to choose coronal temperature (2 MK vs 1.3 MK)
        // and stream density weight (sparser vs denser).
        if (this._windSpeedAttr) {
            const armIdx = this._windArmIdx[i];
            this._windSpeedAttr[i] = (this._armTypes && this._armTypes[armIdx] === 1) ? 1.0 : 0.0;
        }
    }

    _tickWind(dt) {
        if (!this._windPoints) return;

        // Prefer Parker-corrected values from SolarWindState when available
        const hs      = this._helioState;
        const speed   = hs?.v_sw  ?? this._sw.speed   ?? 450;
        const bz      = hs?.bz    ?? this._sw.bz      ?? 0;
        const by      = hs?.by    ?? this._sw.by      ?? 5;
        const density = hs?.n     ?? this._sw.density ?? 5;
        const bt      = Math.max(1, hs?.bt ?? this._sw.bt ?? 5);

        // Base advection step — scaled by measured speed
        const dr_base  = (speed / 450) * 0.0028 * dt * 60;

        // Derived scalars
        const bzSouth  = Math.max(0, Math.min(1, -bz / 30));
        const btNorm   = Math.min(1, bt / 20);
        const dFactor  = Math.max(0.4, Math.min(2.5, density / 5));

        // ── Advance flare pulses ───────────────────────────────────────────────
        // Each pulse propagates at its shock speed (ratio to nominal 450 km/s).
        // Pulses older than 25 min or beyond MAX_R_AU are discarded.
        for (let p = this._flarePulses.length - 1; p >= 0; p--) {
            const fp = this._flarePulses[p];
            fp.r_AU += (fp.shockSpeed / 450) * dr_base * 2.5;
            fp.age  += dt;
            if (fp.r_AU > MAX_R_AU || fp.age > 1500) {
                this._flarePulses.splice(p, 1);
            }
        }

        // ── IMF sector polarity colours (By-based) ────────────────────────────
        const awayR  = (0.95 + bzSouth * 0.05) * btNorm;
        const awayG  = (0.68 - bzSouth * 0.55) * btNorm;
        const awayB  = (0.08 - bzSouth * 0.06) * btNorm;
        const towdR  = (0.10 + bzSouth * 0.55) * btNorm;
        const towdG  = (0.50 - bzSouth * 0.35) * btNorm;
        const towdB  = (0.95 - bzSouth * 0.60) * btNorm;
        const awayFirst = by >= 0;

        // ── N_SPIRAL field-line backbone (magnetic + stream-speed structure) ──
        //
        // Each arm now carries its own characteristic speed (fast coronal-hole
        // or slow streamer-belt wind).  The Parker winding angle φ = Ω r / v
        // differs per arm — fast arms wind less tightly, slow arms more tightly.
        // At the boundary between a fast arm and the next (slower) arm, a
        // Corotating Interaction Region (CIR) compression zone is visible as
        // a brighter interface line.
        if (this._spiralLines) {
            for (let arm = 0; arm < N_SPIRAL; arm++) {
                const pts  = this._spiralLinePts[arm];
                const cols = this._spiralLineCols[arm];

                // Per-arm speed: measured speed scales the arm's characteristic
                const armV  = this._armBaseSpeeds
                    ? this._armBaseSpeeds[arm] * (speed / 450)
                    : speed;
                const isFast = this._armTypes ? this._armTypes[arm] === 1 : false;

                // Base polarity colour tinted by stream type
                const inAwayHalf = (arm < N_SPIRAL / 2) === awayFirst;
                let sR = inAwayHalf ? awayR : towdR;
                let sG = inAwayHalf ? awayG : towdG;
                let sB = inAwayHalf ? awayB : towdB;

                // Fast-stream tint: hotter (more gold/white), slow-stream: cooler (orange-red)
                if (isFast) {
                    sR = Math.min(1, sR * 1.25);
                    sG = Math.min(1, sG * 1.18);
                    sB = Math.min(1, sB * 1.30);
                } else {
                    sR = Math.min(1, sR * 1.10);
                    sG = Math.max(0, sG * 0.80);
                    sB = Math.max(0, sB * 0.50);
                }

                // CIR check: is the NEXT arm slow while this arm is fast?
                // If so, the trailing edge of this fast arm is a CIR forward shock.
                const nextArm  = (arm + 1) % N_SPIRAL;
                const nextFast = this._armTypes ? this._armTypes[nextArm] === 1 : false;
                const isCIR    = isFast && !nextFast;

                const srcLon = arm * (Math.PI * 2 / N_SPIRAL);

                for (let j = 0; j < N_LINE; j++) {
                    const r_AU = (j / (N_LINE - 1)) * MAX_R_AU;
                    const ang  = srcLon + this._rot - (428.6 / armV) * r_AU;
                    const rp   = r_AU * AU;
                    // Heliospheric current sheet warp: the solar magnetic dipole
                    // is tilted ~7-15 deg from the rotation axis, creating a wavy
                    // "ballerina skirt" pattern.  Field lines undulate above/below
                    // the ecliptic as they spiral outward.
                    const hcsTilt = 0.18;   // ~10 deg dipole tilt
                    const hcsWarp = Math.sin(ang * 2.0 + arm * 0.8) * hcsTilt * rp * 0.12;
                    // Additional latitude spread: arms fan out slightly in 3D
                    const latSpread = Math.sin(srcLon * 3.0 + r_AU * 1.5) * rp * 0.04;
                    pts[j * 3]     = rp * Math.cos(ang);
                    pts[j * 3 + 1] = hcsWarp + latSpread;
                    pts[j * 3 + 2] = rp * Math.sin(ang);

                    const tIn  = Math.min(j / 10, 1.0);
                    const tOut = 1.0 - Math.pow(j / N_LINE, 1.6);
                    let   brt  = tIn * tOut * 0.78;

                    // CIR compression brightening: a dense, bright band grows with r
                    // (compression ratio peaks around 2–4 AU but we cap at MAX_R_AU)
                    if (isCIR) {
                        const cirGrow = Math.min(1, r_AU / 0.6);  // grows beyond 0.6 AU
                        brt = Math.min(1.8, brt + cirGrow * 0.55);
                    }

                    // Flare pulse brightening on this arm's field line
                    let pulseBoost = 0;
                    for (const fp of this._flarePulses) {
                        const lonDelta = Math.abs(((srcLon - fp.srcLon + Math.PI) % (Math.PI * 2)) - Math.PI);
                        if (lonDelta < 0.6) {
                            const rDiff = r_AU - fp.r_AU;
                            // Gaussian envelope around the pulse front (half-width ~0.05 AU)
                            const pf = Math.exp(-rDiff * rDiff / 0.004) * fp.intensity
                                     * Math.max(0, 1 - lonDelta / 0.6);
                            pulseBoost = Math.max(pulseBoost, pf);
                        }
                    }

                    const b = brt + pulseBoost * 1.2;
                    // Pulse front: hot shock → white-blue flash
                    cols[j * 3]     = Math.max(0, Math.min(1, sR * b + pulseBoost * 0.6));
                    cols[j * 3 + 1] = Math.max(0, Math.min(1, sG * b + pulseBoost * 0.7));
                    cols[j * 3 + 2] = Math.max(0, Math.min(1, sB * b + pulseBoost * 1.0));
                }
                this._spiralLines[arm].geometry.attributes.position.needsUpdate = true;
                this._spiralLines[arm].geometry.attributes.color.needsUpdate    = true;
            }
        }

        // ── Solar wind particles — position advection only ────────────────────
        //
        // All colour, fade, and brightness computation has moved to the vertex
        // shader (_WIND_VERT).  The CPU loop only advances the Parker spiral
        // position each frame and respawns particles that have exited MAX_R_AU.
        // Per-particle GPU attributes (a_r, a_lat, a_src_lon, a_age, a_speed)
        // are updated by writing into the same Float32Arrays the BufferAttributes
        // wrap — needsUpdate flags sync them to the GPU.

        for (let i = 0; i < N_WIND; i++) {
            this._windAge[i] += dt;

            const armIdx       = this._windArmIdx ? this._windArmIdx[i] : 0;
            const armV         = this._armBaseSpeeds
                ? this._armBaseSpeeds[armIdx] * (speed / 450)
                : speed;
            const parker       = this._parkerLUT
                ? parkerSpeedRatio(this._windR[i], this._parkerLUT)
                : 1.0;
            const latFrac      = Math.min(1, Math.abs(this._windPY[i]) / 0.5);
            const V_local_frac = 1 + latFrac * 0.65;

            this._windR[i] += (armV / 450) * 0.0028 * dt * 60 * parker * V_local_frac;
            if (this._windR[i] > MAX_R_AU) this._spawnWind(i, false);

            const r_new  = this._windR[i];
            const srcLon = this._windArm[i];
            const sinLat = this._windPY[i];
            const cosLat = Math.sqrt(Math.max(0, 1 - sinLat * sinLat));

            const V_lat = armV * V_local_frac;
            const ang   = srcLon + this._rot - (428.6 / V_lat) * r_new + this._windJitter[i];
            const rPx   = r_new * AU;

            this._windPos[i * 3]     = rPx * cosLat * Math.cos(ang);
            this._windPos[i * 3 + 1] = rPx * sinLat;
            this._windPos[i * 3 + 2] = rPx * cosLat * Math.sin(ang);
        }

        // ── Earth bow shock — magnetosheath particle marking ─────────────────
        //
        // Particles whose Parker-spiral position lands inside the bow shock are
        // compressed and shock-heated at the magnetosheath.  We flag them with
        // a_speed = 0.3 so the vertex shader renders them as hot orange plasma.
        // The physical bow shock radius (Farris-Russell) comes from the live
        // MagnetosphereEngine analysis; fallback is 13 Re (scene units).
        //
        // Implementation note: we do NOT override _windPos — particles continue
        // along their natural Parker spiral.  Only the shader colour/size changes
        // to visualise the interaction zone.  This avoids discontinuities.
        if (this._earthGroup && this._windSpeedAttr) {
            const ep  = this._earthGroup.position;
            const bsR = (this._magnetosphere?.analysis?.bowShockR0 ?? 13) * 1.1; // slight padding
            const bsR2 = bsR * bsR;

            for (let i = 0; i < N_WIND; i++) {
                const px = this._windPos[i * 3]     - ep.x;
                const py = this._windPos[i * 3 + 1] - ep.y;
                const pz = this._windPos[i * 3 + 2] - ep.z;
                const d2 = px * px + py * py + pz * pz;

                if (d2 < bsR2) {
                    // Inside bow shock — mark as magnetosheath plasma
                    this._windSpeedAttr[i] = 0.3;
                } else if (this._windSpeedAttr[i] > 0.15 && this._windSpeedAttr[i] < 0.45) {
                    // Exited bow shock — restore normal fast/slow stream type
                    const armIdx = this._windArmIdx ? this._windArmIdx[i] : 0;
                    this._windSpeedAttr[i] =
                        (this._armTypes && this._armTypes[armIdx] === 1) ? 1.0 : 0.0;
                }
            }
        }

        // ── Update shader uniforms ────────────────────────────────────────────
        if (this._windUniforms) {
            const U = this._windUniforms;
            U.u_bz.value       = bz;
            U.u_by.value       = by;
            U.u_bt.value       = bt;
            U.u_density.value  = density;
            U.u_time.value     = this._t;
            U.u_rot.value      = this._rot;
            U.u_awayFirst.value = (by >= 0) ? 1 : 0;

            // Pack up to 6 active flare pulses into vec4 uniforms
            const np = Math.min(6, this._flarePulses.length);
            U.u_pulse_n.value = np;
            for (let p = 0; p < 6; p++) {
                const fp = this._flarePulses[p];
                U.u_pulses.value[p].set(
                    fp ? fp.r_AU      : 0,
                    fp ? fp.srcLon    : 0,
                    fp ? fp.intensity : 0,
                    0
                );
            }
        }

        const geo = this._windPoints.geometry;
        geo.attributes.position.needsUpdate  = true;
        geo.attributes.a_r.needsUpdate       = true;
        geo.attributes.a_lat.needsUpdate     = true;
        geo.attributes.a_src_lon.needsUpdate = true;
        geo.attributes.a_age.needsUpdate     = true;
        geo.attributes.a_speed.needsUpdate   = true;
    }

    // ── CME ───────────────────────────────────────────────────────────────────

    _triggerCME() {
        // Remove previous CME layers if still present
        if (this._cme) {
            this._scene.remove(this._cme.shockMesh);
            this._scene.remove(this._cme.driverMesh);
            this._cme.shockMesh.geometry.dispose();  this._cme.shockMesh.material.dispose();
            this._cme.driverMesh.geometry.dispose(); this._cme.driverMesh.material.dispose();
        }

        // ── Outer shock sheath (fast magnetosonic shock, ~1.2× ahead of driver) ──
        // The shock compresses the ambient solar wind: hot, bright orange-white.
        const shockGeo  = new THREE.SphereGeometry(0.3, 40, 24);
        const shockMat  = new THREE.MeshBasicMaterial({
            color:       0xff9922,
            transparent: true,
            opacity:     0.55,
            blending:    THREE.AdditiveBlending,
            depthWrite:  false,
            wireframe:   true,
        });
        const shockMesh = new THREE.Mesh(shockGeo, shockMat);
        shockMesh.renderOrder = 4;
        this._scene.add(shockMesh);

        // ── Inner driver gas (magnetic flux rope / ejecta core, ~0.85× shock radius) ──
        // Hot magnetised ejecta with a distinct red-orange colour.
        const driverGeo  = new THREE.SphereGeometry(0.24, 32, 20);
        const driverMat  = new THREE.MeshBasicMaterial({
            color:       0xff3300,
            transparent: true,
            opacity:     0.22,
            blending:    THREE.AdditiveBlending,
            depthWrite:  false,
        });
        const driverMesh = new THREE.Mesh(driverGeo, driverMat);
        driverMesh.renderOrder = 4;
        this._scene.add(driverMesh);

        this._cme = {
            shockMesh,
            driverMesh,
            r_AU:       0.003,
            auPerFrame: (this._sw.cmeSpeed / 450) * 0.004,
        };
    }

    // ── Sweet-Parker / Petschek reconnection events at the HCS ───────────────
    //
    // The HCS is a current sheet separating antiparallel IMF sectors.
    // When southward Bz tilts the IMF antiparallel to Earth's magnetopause field,
    // Petschek fast reconnection is triggered.  At the HCS itself, ongoing
    // Sweet–Parker reconnection creates "plasmoids" — magnetic islands ejected
    // along the current sheet at ~V_A.
    //
    // Spawn probability per frame:  petschekRate() × |Bz_south| × V_A
    // Visual: an expanding ring in the HCS plane, colour-transitioning from
    // hot white (10 MK reconnection exhaust) to blue-teal (cooling exhaust).
    //
    // Maximum concurrent events: 6 (prevents GPU overload on fast machines)

    _tickReconnection(dt) {
        const bz      = this._sw.bz      ?? 0;
        const bt      = Math.max(1, this._sw.bt      || 5);
        const density = this._sw.density || 5;

        // Only fire when Bz is clearly southward
        const bzSouth = Math.max(0, -bz / 15);
        if (bzSouth < 0.05) {
            // Quiet — age out existing events but don't spawn new ones
        } else {
            // Alfvén speed and Petschek rate from measured quantities
            const V_A    = alfvenSpeed(bt, density);   // km/s
            // Anomalous (turbulent) magnetic diffusivity η_anomalous ≈ 10⁶ m²/s
            // (much larger than classical ~10 m²/s → enables fast Petschek reconnection)
            const rate   = petschekRate(0.08, V_A, 1e6);

            // Spawn probability — scales with both Bz southward and reconnection rate
            const prob = rate * bzSouth * dt * 1.8;
            if (Math.random() < prob && this._reconnEvents.length < 6) {
                // Random position along the HCS surface
                const r_AU   = 0.15 + Math.random() * 0.90;   // 0.15–1.05 AU
                const phi_w  = Math.random() * Math.PI * 2;    // world longitude
                const r_px   = r_AU * AU;

                // Y follows HCS warp: y = r_px × tilt × sin(phi_world − rot)
                const amp    = (this._hcsTilt || 0.12) * Math.pow(r_AU, 0.4);
                const y_hcs  = r_px * amp * Math.sin(phi_w - this._rot);

                const ring = new THREE.Mesh(
                    new THREE.RingGeometry(0.4, 1.0, 32),
                    new THREE.MeshBasicMaterial({
                        color:       0xbbddff,
                        transparent: true,
                        opacity:     0.85,
                        blending:    THREE.AdditiveBlending,
                        depthWrite:  false,
                        side:        THREE.DoubleSide,
                    })
                );
                ring.position.set(r_px * Math.cos(phi_w), y_hcs, r_px * Math.sin(phi_w));
                // Orient ring parallel to the HCS (face approximately radially outward)
                ring.lookAt(0, 0, 0);
                ring.renderOrder = 8;
                this._scene.add(ring);

                this._reconnEvents.push({
                    mesh:   ring,
                    age:    0,
                    maxAge: 2.0 + Math.random() * 1.5,
                    V_A,
                });
            }
        }

        // Age and update all active events
        for (let i = this._reconnEvents.length - 1; i >= 0; i--) {
            const ev = this._reconnEvents[i];
            ev.age  += dt;

            if (ev.age >= ev.maxAge) {
                this._scene.remove(ev.mesh);
                ev.mesh.geometry.dispose();
                ev.mesh.material.dispose();
                this._reconnEvents.splice(i, 1);
                continue;
            }

            const t = ev.age / ev.maxAge;   // 0 → 1 over event lifetime

            // Expand ring outward (moves at ~V_A exhaust speed from reconnection site)
            ev.mesh.scale.setScalar(1.0 + t * 5.0);

            // Colour transition: hot white (T ~ 10 MK) → blue-teal (cooling exhaust)
            // t=0: bright white/cyan  t=1: dim blue
            const hue = 0.58 - t * 0.12;   // blue-teal range
            const sat = 0.3  + t * 0.6;
            const lit = 0.9  - t * 0.55;
            ev.mesh.material.color.setHSL(hue, sat, lit);

            // Fast flash-in, slow fade-out (like real reconnection exhaust)
            const fadeIn  = Math.min(1, t / 0.12);
            const fadeOut = 1 - Math.pow(t, 1.8);
            ev.mesh.material.opacity = Math.max(0, fadeIn * fadeOut * 0.85);
        }
    }

    _tickCME(dt) {
        if (!this._cme) return;
        const c = this._cme;
        c.r_AU += c.auPerFrame * dt * 60;
        const shockR  = c.r_AU * AU;
        const driverR = shockR * 0.82;   // driver gas ~82% of shock radius
        const fade    = Math.max(0, 1 - c.r_AU / MAX_R_AU);

        c.shockMesh.scale.setScalar(shockR / 0.3);
        c.driverMesh.scale.setScalar(driverR / 0.24);

        // Shock: stays visible across the full journey
        c.shockMesh.material.opacity  = Math.max(0, 0.55 * fade);
        // Driver: fades faster — ejecta disperses into the ambient wind by ~0.8 AU
        c.driverMesh.material.opacity = Math.max(0, 0.22 * Math.pow(Math.max(0, 1 - c.r_AU / 0.9), 1.5));

        if (c.r_AU > MAX_R_AU) {
            this._scene.remove(c.shockMesh);
            this._scene.remove(c.driverMesh);
            c.shockMesh.geometry.dispose();  c.shockMesh.material.dispose();
            c.driverMesh.geometry.dispose(); c.driverMesh.material.dispose();
            this._cme = null;
        }
    }

    // ── Flare ─────────────────────────────────────────────────────────────────

    _triggerFlare(extreme = false) {
        if (!this._flare3d)
            this._flare3d = new FlareRing3D(this._scene, THREE, R.sun);
        this._flare3d.trigger(extreme);

        // ── Sun surface flash ─────────────────────────────────────────────────
        this._sunFlareT = extreme ? 1.0 : 0.65;

        // ── Post-flare UV arcade on photosphere ───────────────────────────────
        // Random active-region latitude; longitude is the Earth-facing hemisphere
        // (opposite of _rot — most visible on the near side).
        this._flareArcLat = (Math.random() - 0.5) * 0.70;   // ±20° latitude
        this._flareArcLon = (-this._rot + Math.PI * 2) % (Math.PI * 2) + (Math.random() - 0.5) * 0.5;
        this._flareArcT   = extreme ? 1.0 : 0.70;

        // ── Post-flare prominence arcade (low bright UV loops) ────────────────
        this._spawnProminence('arcade', {
            lat: this._flareArcLat,
            lon: this._flareArcLon,
        });

        // ── Flare ribbons (two parallel arcs at footpoints) ───────────────────
        this._spawnFlareRibbons(this._flareArcLat, this._flareArcLon, extreme);

        // ── SEP ray (Solar Energetic Particle stream along field line) ─────────
        this._spawnFlareSEP(this._flareArcLon, extreme);

        // ── Wind pulse along Parker spiral ────────────────────────────────────
        this._flarePulses.push({
            srcLon:     this._flareArcLon,
            r_AU:       0.008,
            shockSpeed: extreme ? 2000 : 1200,
            intensity:  extreme ? 1.0 : 0.65,
            age:        0,
        });
    }

    // ── Flare ribbon pair (two bright parallel arcs at active-region footpoints) ──
    // Observed as two bright Hα/UV strips flanking the magnetic neutral line that
    // brighten during the impulsive phase and separate slowly as the arcade grows.

    _spawnFlareRibbons(lat, lon, extreme) {
        const N     = 14;
        const col   = extreme ? 0xffffff : 0xffcc44;
        const halfW = 0.055;   // half-separation in latitude (scene rad)

        for (const side of [-1, 1]) {
            const ribbonLat = lat + side * halfW;
            const pts = [];
            for (let i = 0; i <= N; i++) {
                const dl  = ((i / N) - 0.5) * 0.40;   // span ±0.2 rad in longitude
                const rl  = lon + dl;
                const rlt = ribbonLat;
                pts.push(new THREE.Vector3(
                    R.sun * 1.01 * Math.cos(rlt) * Math.cos(rl),
                    R.sun * 1.01 * Math.sin(rlt),
                    R.sun * 1.01 * Math.cos(rlt) * Math.sin(rl),
                ));
            }
            const geo = new THREE.BufferGeometry().setFromPoints(pts);
            const mat = new THREE.LineBasicMaterial({
                color: col, transparent: true, opacity: 0.95,
                blending: THREE.AdditiveBlending, depthWrite: false,
            });
            const line = new THREE.Line(geo, mat);
            line.renderOrder = 6;
            this._scene.add(line);
            this._flareRibbons.push({ line, age: 0, maxAge: extreme ? 12.0 : 7.0 });
        }
    }

    _tickFlareRibbons(dt) {
        for (let i = this._flareRibbons.length - 1; i >= 0; i--) {
            const r  = this._flareRibbons[i];
            r.age   += dt;
            const t  = r.age / r.maxAge;
            if (t >= 1.0) {
                this._scene.remove(r.line);
                r.line.geometry.dispose();
                r.line.material.dispose();
                this._flareRibbons.splice(i, 1);
                continue;
            }
            // Co-rotate with sun
            r.line.rotation.y = this._rot;
            // Fade: fast bright peak → slow decay (thermal bremsstrahlung cooling)
            const fade = t < 0.15
                ? t / 0.15             // fast ramp-in
                : Math.pow(1 - (t - 0.15) / 0.85, 1.8);
            r.line.material.opacity = Math.max(0, fade * 0.95);
            // Colour: bright white → cooling orange-red
            r.line.material.color.setHSL(
                0.07 - t * 0.04,   // white → gold → orange
                t < 0.15 ? 0.0 : Math.min(1, (t - 0.15) * 2.5),
                0.9 - t * 0.35
            );
        }
    }

    // ── SEP ray — bright line from flare site along Parker spiral field line ──
    // Solar Energetic Particles accelerated at the flare shock stream outward
    // preferentially along the IMF field line connecting to Earth.
    // Visual: thin bright blue-white ray, fades over ~20 s.

    _spawnFlareSEP(srcLon, extreme) {
        // Remove previous SEP ray if still present
        if (this._flareSEP) {
            this._scene.remove(this._flareSEP.line);
            this._flareSEP.line.geometry.dispose();
            this._flareSEP.line.material.dispose();
            this._flareSEP = null;
        }

        const M   = 40;   // points along ray
        const pts = [];
        const speed = 450;   // nominal wind speed for winding
        for (let j = 0; j <= M; j++) {
            const r_AU = (j / M) * MAX_R_AU;
            const ang  = srcLon + this._rot - (428.6 / speed) * r_AU;
            const rPx  = r_AU * AU;
            pts.push(new THREE.Vector3(rPx * Math.cos(ang), 0, rPx * Math.sin(ang)));
        }
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({
            color: extreme ? 0xaaccff : 0x88aaff,
            transparent: true, opacity: 0.80,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const line = new THREE.Line(geo, mat);
        line.renderOrder = 4;
        this._scene.add(line);
        this._flareSEP = { line, age: 0, maxAge: extreme ? 22.0 : 14.0 };
    }

    _tickFlareSEP(dt) {
        if (!this._flareSEP) return;
        this._flareSEP.age += dt;
        const t = this._flareSEP.age / this._flareSEP.maxAge;
        if (t >= 1.0) {
            this._scene.remove(this._flareSEP.line);
            this._flareSEP.line.geometry.dispose();
            this._flareSEP.line.material.dispose();
            this._flareSEP = null;
            return;
        }
        // Fade: ramp-in over first 15%, slow decay
        const fade = t < 0.15 ? t / 0.15 : Math.pow(1 - (t - 0.15) / 0.85, 1.5);
        this._flareSEP.line.material.opacity = Math.max(0, fade * 0.80);
        // Colour shifts from blue-white (accelerated electrons) → teal (protons)
        this._flareSEP.line.material.color.setHSL(0.58 + t * 0.08, 0.9, 0.72 - t * 0.15);
    }

    _tickFlare(dt) {
        this._flare3d?.tick(dt);
    }

    // ── Ephemeris positions ───────────────────────────────────────────────────

    /**
     * Convert ephemeris body → Three.js position in ecliptic XZ scene.
     *
     * Preferred: use x_AU/y_AU/z_AU (ECLIPJ2000 Cartesian) when present.
     * Mapping: ecliptic-X → Three.x, ecliptic-Y → Three.z, ecliptic-Z → Three.y
     * (Three.js scene has ecliptic plane = XZ, +Y = ecliptic north.)
     *
     * Fallback: spherical (lon_rad, lat_rad, dist_AU).
     */
    _ephToPos(body) {
        if (!body) return null;
        if (body.x_AU != null) {
            return new THREE.Vector3(
                body.x_AU * AU,
                body.z_AU * AU,   // ecliptic north (Z_ecl) → Three.js +Y
                body.y_AU * AU,   // ecliptic Y → Three.js Z
            );
        }
        const { lon_rad, lat_rad = 0, dist_AU } = body;
        const d = dist_AU * AU;
        return new THREE.Vector3(
            d * Math.cos(lat_rad) * Math.cos(lon_rad),
            d * Math.sin(lat_rad),
            d * Math.cos(lat_rad) * Math.sin(lon_rad),
        );
    }

    _updateEphemerisPositions() {
        const eph = this._eph;

        // All non-Earth, non-Moon planets (inner + outer)
        for (const name of ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']) {
            const pos = this._ephToPos(eph[name]);
            if (pos && this._planetMeshes[name]) {
                this._planetMeshes[name].position.copy(pos);
                const lbl = this._planetLabels?.[name];
                if (lbl) lbl.position.set(pos.x, pos.y + R[name] * 2.2, pos.z);
            }
        }

        // Earth group
        const earthPos = this._ephToPos(eph.earth);
        if (earthPos) {
            this._earthGroup.position.copy(earthPos);
            const earthLbl = this._planetLabels?.earth;
            if (earthLbl) earthLbl.position.set(earthPos.x, earthPos.y + R.earth * 2.5, earthPos.z);
        }

        // Moon — geocentric direction scaled to MOON_VIS_AU for visibility.
        // Real orbit (0.00257 AU = 0.257 scene units) is smaller than Earth's sphere.
        if (eph.moon) {
            const moonDir = this._ephToPos(eph.moon);
            if (moonDir && this._moonMesh) {
                moonDir.normalize().multiplyScalar(MOON_VIS_AU * AU);
                this._moonMesh.position.copy(moonDir);
                this._moonOrbit = eph.moon.lon_rad;
            }
        }

        // ── Update HUD elements ──────────────────────────────────────────────
        if (eph.earth) {
            const rEl = document.getElementById('h3d-rau');
            if (rEl) rEl.textContent = eph.earth.dist_AU.toFixed(4);

            const dEl = document.getElementById('h3d-delay');
            if (dEl) {
                const L1_km    = 1500000;   // L1 is ~1.5 Mkm from Earth toward Sun
                const delayMin = L1_km / (this._sw.speed || 450) / 60;
                dEl.textContent = delayMin.toFixed(0);
            }
        }

        // ── Dispatch time event for date display ─────────────────────────────
        const simDate = new Date((this._simJD - 2440587.5) * 86400000);
        window.dispatchEvent(new CustomEvent('helio-time-update', {
            detail: {
                jd:     this._simJD,
                date:   simDate,
                source: eph.earth?.source ?? 'meeus',
            }
        }));
    }

    // ── Moon animation (when no live ephemeris) ───────────────────────────────

    _tickMoon(dt) {
        if (this._eph.moon) return;   // live ephemeris drives position; skip animation
        // 27.3 day orbit, sped up by 2000× for visual interest
        const MOON_ORBIT_AU = 0.00257;
        this._moonOrbit = (this._moonOrbit + dt * (2 * Math.PI / (27.3 * 86400)) * 2000) % (2 * Math.PI);
        const r = MOON_ORBIT_AU * AU;
        if (this._moonMesh) {
            this._moonMesh.position.set(
                r * Math.cos(this._moonOrbit),
                0,
                r * Math.sin(this._moonOrbit),
            );
        }
    }

    // ── Mars moon animation ───────────────────────────────────────────────────

    /**
     * Position Phobos and Deimos using current simulated JD.
     * Mean longitude L = L0 + n*(JD - J2000) where n = 360/period °/day.
     * Positions are in the mars_moon_plane group (tilted MARS_MOON_TILT from
     * Mars orbital plane), so local X/Z = within-plane, Y = out of plane.
     */
    _tickMarsSystem() {
        if (!this._phobos || !this._deimos) return;
        const jd   = this._simJD;
        const dt_d = jd - 2451545.0;   // days since J2000

        for (const [mesh, cfg] of [
            [this._phobos, MARS_MOONS.phobos],
            [this._deimos, MARS_MOONS.deimos],
        ]) {
            const L_deg = ((cfg.L0_deg + (360 / cfg.period_d) * dt_d) % 360 + 360) % 360;
            const L_rad = L_deg * D2R;
            mesh.position.set(
                cfg.a_scene * Math.cos(L_rad),
                0,
                cfg.a_scene * Math.sin(L_rad),
            );
        }
    }

    // ── Sun animation ─────────────────────────────────────────────────────────

    _tickSun(dt) {
        if (!this._sunCore || !this._sunUniforms) return;

        // ── Solar rotation ────────────────────────────────────────────────────
        // Co-rotate with the Parker spiral arms (this._rot) so the surface
        // texture, active regions, and field lines all share the same phase.
        this._sunCore.rotation.y = this._rot;

        // ── Flare flash decay ─────────────────────────────────────────────────
        if (this._sunFlareT > 0) {
            this._sunFlareT = Math.max(0, this._sunFlareT - dt * 0.8);
        }

        // ── X-ray flux normalisation (log scale: C1→0.25, M1→0.50, X1→0.75) ─
        const flux   = Math.max(1e-9, this._sw.xrayFlux ?? 1e-9);
        const xNorm  = Math.min(1, Math.log10(flux / 1e-9) / 4);

        // ── Update shader uniforms ────────────────────────────────────────────
        const u = this._sunUniforms;
        u.u_time.value      = this._t;
        u.u_xray_norm.value = xNorm;
        u.u_flare_t.value   = this._sunFlareT;
        u.u_kp_norm.value   = Math.min(1, (this._sw.kp ?? 2) / 9);
        u.u_bloom.value     = this._bloomLevel;
        // New uniforms from upgraded sun-shader.js:
        u.u_f107_norm.value = Math.min(1, ((this._sw.f107 ?? 150) - 65) / 235);
        u.u_activity.value  = Math.min(1, xNorm * 0.6 + u.u_kp_norm.value * 0.4);
        u.u_rot_phase.value = this._rot;

        // Post-flare UV arcade glow on sun surface — decays after trigger
        if (this._flareArcT > 0) {
            this._flareArcT = Math.max(0, this._flareArcT - dt * 0.25);
        }
        u.u_flare_arc.value    = this._flareArcT;
        u.u_flare_lon.value.x  = this._flareArcLat;
        u.u_flare_lon.value.y  = this._flareArcLon;

        // ── Active region positions ───────────────────────────────────────────
        // Convert heliographic lat/lon (Carrington frame) to local unit-sphere
        // vectors.  The sphere mesh rotates at this._rot so we subtract the
        // current rotation to keep regions locked to the solar surface.
        const regions = this._sw.regions ?? [];
        const nReg    = Math.min(8, regions.length);
        for (let k = 0; k < nReg; k++) {
            const reg    = regions[k];
            const lat    = reg.lat_rad ?? 0;
            // Carrington lon is heliocentric; subtract current rotation phase so
            // regions appear fixed on the rotating sphere.
            const lon    = (reg.lon_rad ?? 0) - this._rot;
            const cosLat = Math.cos(lat);
            u.u_regions.value[k].set(
                cosLat * Math.cos(lon),   // x
                Math.sin(lat),            // y (ecliptic north = sphere up)
                cosLat * Math.sin(lon),   // z
                // Intensity: complex regions (gamma/delta class) pulse brighter
                (reg.area_norm ?? 0.3) * (reg.is_complex ? 1.0 : 0.55),
            );
        }
        u.u_nRegions.value = nReg;

        // ── Corona glow opacity — bloom × activity pulse ─────────────────────
        if (this._coronaMeshes) {
            const coronaBoost = 1.0 + xNorm * 0.55 + this._sunFlareT * 0.8;
            for (const c of this._coronaMeshes) {
                c.mesh.material.opacity = Math.min(1, c.baseOpacity * this._bloomLevel * coronaBoost);
            }
        }

        // ── Flare SEP ray tick ────────────────────────────────────────────────
        this._tickFlareSEP(dt);

        // ── Flare ribbon tick ─────────────────────────────────────────────────
        this._tickFlareRibbons(dt);
    }

    // ── Solar prominences ─────────────────────────────────────────────────────
    //
    // Three biophysically-distinct prominence types:
    //
    //   'quiescent'  — Stable Hα loop hanging above the polarity inversion
    //     line.  Slow-growing, lasts 60–120 s.  Deep red-rose (656 nm).
    //     Multi-strand: 3 offset lines form a tube-like structure.
    //
    //   'eruptive'   — Unstable filament that rises rapidly and erupts.
    //     Starts rose-red, turns UV blue-white as it heats during eruption.
    //     Triggers an extra wind pulse on eruption.  Lasts 20–40 s.
    //     Max height up to 1.8 R_sun — visually dramatic.
    //
    //   'arcade'     — Post-flare cusp arcade: a row of short bright loops at
    //     a flare site.  Spawned explicitly by _triggerFlare().  UV blue,
    //     lasts 30–60 s, sits low above the surface.
    //
    // Each prominence stores N arc points that are rebuilt each frame for
    // eruptive types (height grows); quiescent geometry is static.

    _buildPromArc(lat, lon, maxH, footSpread, N = 22) {
        // Returns array of THREE.Vector3 along the arch in world-space.
        // footSpread: angular separation of footpoints (radians)
        const pts = [];
        for (let i = 0; i <= N; i++) {
            const a     = (i / N) * Math.PI;
            const rSurf = R.sun + maxH * Math.sin(a);
            const dLat  = (a - Math.PI * 0.5) * footSpread * 0.55;
            const dLon  = 0;
            const lt    = lat  + dLat;
            const ln    = lon  + dLon;
            pts.push(new THREE.Vector3(
                rSurf * Math.cos(lt) * Math.cos(ln),
                rSurf * Math.sin(lt),
                rSurf * Math.cos(lt) * Math.sin(ln),
            ));
        }
        return pts;
    }

    _spawnProminence(type = null, options = {}) {
        // Weighted random type selection
        if (!type) {
            const r = Math.random();
            type = r < 0.65 ? 'quiescent' : r < 0.90 ? 'eruptive' : 'arcade';
        }

        const lat = options.lat ?? (Math.random() - 0.5) * 1.2;   // ±34° heliographic
        const lon = options.lon ?? Math.random() * Math.PI * 2;
        const N   = 22;

        let maxH, maxAge, color0, footSpread;
        if (type === 'quiescent') {
            maxH       = R.sun * (0.22 + Math.random() * 0.45);
            maxAge     = 60 + Math.random() * 60;
            color0     = new THREE.Color(1.0, 0.08, 0.28);   // deep rose Hα
            footSpread = 0.22 + Math.random() * 0.18;
        } else if (type === 'eruptive') {
            maxH       = R.sun * (0.45 + Math.random() * 1.35);  // can reach 1.8 R_sun
            maxAge     = 20 + Math.random() * 20;
            color0     = new THREE.Color(1.0, 0.12, 0.35);
            footSpread = 0.14 + Math.random() * 0.12;
        } else {   // arcade
            maxH       = R.sun * (0.10 + Math.random() * 0.15);  // low flat loops
            maxAge     = 30 + Math.random() * 30;
            color0     = new THREE.Color(0.30, 0.65, 1.00);      // UV blue
            footSpread = 0.08 + Math.random() * 0.10;
        }

        // ── Main strand ───────────────────────────────────────────────────────
        const pts  = this._buildPromArc(lat, lon, maxH, footSpread, N);
        const geo  = new THREE.BufferGeometry().setFromPoints(pts);
        const mat  = new THREE.LineBasicMaterial({
            color: color0.clone(), transparent: true, opacity: 0.0,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const line = new THREE.Line(geo, mat);
        line.renderOrder = 5;
        this._scene.add(line);

        // ── Secondary strands (quiescent and eruptive only) ───────────────────
        // Offset slightly in lon/lat to mimic the multi-strand flux-tube structure
        // seen in Hα coronagraphs.
        const strands = [line];
        if (type !== 'arcade') {
            for (const [dLat, dLon, opFrac] of [
                [ 0.022, -0.016, 0.55],
                [-0.018,  0.020, 0.45],
            ]) {
                const spts = this._buildPromArc(lat + dLat, lon + dLon,
                                                maxH * (0.88 + Math.random() * 0.12),
                                                footSpread, N);
                const sgeo = new THREE.BufferGeometry().setFromPoints(spts);
                const smat = new THREE.LineBasicMaterial({
                    color: color0.clone(), transparent: true, opacity: 0.0,
                    blending: THREE.AdditiveBlending, depthWrite: false,
                });
                const sl = new THREE.Line(sgeo, smat);
                sl.renderOrder = 5;
                this._scene.add(sl);
                strands.push(sl);
                strands[strands.length - 1]._opFrac = opFrac;
            }
        }

        this._prominences.push({
            strands, type, lat, lon, maxH, footSpread, N,
            color0: color0.clone(),
            phase:  Math.random() * Math.PI * 2,
            age:    0,
            maxAge,
            erupted: false,   // for 'eruptive' type — marks when eruption fired
        });
    }

    _tickProminences(dt) {
        // Activity-scaled max population: more solar activity → more prominences
        const xNorm   = this._sunUniforms?.u_xray_norm.value ?? 0;
        const maxProm = 3 + Math.round(xNorm * 3);   // 3 quiet → 6 active

        if (this._prominences.length < Math.max(2, Math.floor(maxProm * 0.5)) && Math.random() < dt * 0.12) {
            this._spawnProminence();
        } else if (this._prominences.length < maxProm && Math.random() < dt * 0.035) {
            this._spawnProminence();
        }

        for (let i = this._prominences.length - 1; i >= 0; i--) {
            const p = this._prominences[i];
            p.age += dt;

            if (p.age >= p.maxAge) {
                for (const l of p.strands) {
                    this._scene.remove(l);
                    l.geometry.dispose();
                    l.material.dispose();
                }
                this._prominences.splice(i, 1);
                continue;
            }

            const t = p.age / p.maxAge;   // 0 → 1

            // ── Rotation ─────────────────────────────────────────────────────
            for (const l of p.strands) l.rotation.y = this._rot;

            // ── Fade envelope ─────────────────────────────────────────────────
            const fadeIn  = Math.min(1, p.age / 6.0);
            const fadeOut = (t > 0.75) ? (1 - (t - 0.75) / 0.25) : 1.0;
            const pulse   = 0.75 + 0.25 * Math.sin(this._t * 0.9 + p.phase);
            const baseOp  = fadeIn * fadeOut * pulse;

            // ── Type-specific behaviour ───────────────────────────────────────
            if (p.type === 'quiescent') {
                const hue = 0.94 - xNorm * 0.06;
                const lit = 0.52 + xNorm * 0.18;
                for (let si = 0; si < p.strands.length; si++) {
                    p.strands[si].material.color.setHSL(hue, 1.0, lit);
                    const frac = si === 0 ? 1.0 : (p.strands[si]._opFrac ?? 0.5);
                    p.strands[si].material.opacity = Math.max(0, baseOp * 0.75 * frac);
                }

            } else if (p.type === 'eruptive') {
                // Rising: height increases with age using sigmoid acceleration
                const riseT   = Math.pow(t, 0.55);
                const curH    = p.maxH * Math.min(1, riseT * 1.5);

                // Colour: starts rose-red → heats to UV blue-white during eruption
                const heatFrac = Math.min(1, t * 2.2);
                const hue     = 0.94 - heatFrac * 0.56;   // rose(0.94) → blue(0.38)
                const sat     = 1.0;
                const lit     = 0.45 + heatFrac * 0.45;

                for (let si = 0; si < p.strands.length; si++) {
                    p.strands[si].material.color.setHSL(hue, sat, lit);
                    const frac = si === 0 ? 1.0 : (p.strands[si]._opFrac ?? 0.5);
                    p.strands[si].material.opacity = Math.max(0, baseOp * 0.85 * frac);

                    // Rebuild geometry to reflect current height
                    const offset = si === 0 ? [0, 0] : [(si === 1 ? 0.022 : -0.018), (si === 1 ? -0.016 : 0.020)];
                    const npts = this._buildPromArc(
                        p.lat + offset[0], p.lon + offset[1],
                        curH * (si === 0 ? 1.0 : (0.88 + (si - 1) * 0.06)),
                        p.footSpread, p.N
                    );
                    p.strands[si].geometry.setFromPoints(npts);
                }

                // Fire eruption wind pulse once when height passes 70% max
                if (!p.erupted && curH > p.maxH * 0.70) {
                    p.erupted = true;
                    this._flarePulses.push({
                        srcLon:     p.lon,
                        r_AU:       0.008,
                        shockSpeed: 600 + Math.random() * 400,   // slower than big CME
                        intensity:  0.25 + Math.random() * 0.25,
                        age:        0,
                    });
                }

            } else {   // arcade
                // Bright UV arcade: slight brightness pulsation as loops cool
                const hue = 0.60 - t * 0.08;   // blue → blue-teal
                for (const l of p.strands) {
                    l.material.color.setHSL(hue, 0.9, 0.60 + 0.20 * Math.sin(this._t * 1.8 + p.phase));
                    l.material.opacity = Math.max(0, baseOp * 0.90);
                }
            }
        }
    }

    // ── Magnetosphere ─────────────────────────────────────────────────────────

    _tickMagnetosphere(dt) {
        if (!this._magnetosphere) return;
        const earthPos = this._earthGroup.position;
        // Sun direction from Earth (world space): toward the origin
        const sunDir = earthPos.clone().negate().normalize();
        this._magnetosphere.tick(this._t, sunDir, {
            solar_wind: { bz: this._sw.bz, speed: this._sw.speed, density: this._sw.density },
            kp:         this._sw.kp,
        }, dt);
    }

    // ── Resize ────────────────────────────────────────────────────────────────

    _resize() {
        const c    = this._canvas;
        const rect = c.getBoundingClientRect();
        const W    = Math.max(1, Math.round(rect.width));
        const H    = Math.max(1, Math.round(rect.height));
        if (this._renderer.domElement.width  === Math.round(W * this._renderer.getPixelRatio()) &&
            this._renderer.domElement.height === Math.round(H * this._renderer.getPixelRatio())) return;
        this._renderer.setSize(W, H, false);
        this._camera.aspect = W / H;
        this._camera.updateProjectionMatrix();

        // Refresh perspective scale for the solar wind particle shader.
        // u_scale = 0.5 * physical-pixel-height so that gl_PointSize = size * u_scale / -z
        // matches Three.js PointsMaterial's built-in sizeAttenuation formula.
        if (this._windUniforms?.u_scale) {
            this._windUniforms.u_scale.value = 0.5 * this._renderer.domElement.height;
        }
    }

    // ── Main loop ─────────────────────────────────────────────────────────────

    _loop(now) {
        this._rafId = requestAnimationFrame(this._loop);
        // now is undefined on the first manual call; guard so _prevNow stays null
        // until RAF starts supplying timestamps, avoiding NaN dt on frame 2.
        const dt = Math.min(0.1, (this._prevNow == null || now == null)
            ? 0.016
            : (now - this._prevNow) / 1000);
        if (now != null) this._prevNow = now;

        this._resize();
        this._t    += dt;
        this._rot  += 0.0003 * dt * 60;   // Parker spiral rotation

        // Advance simulation clock (real-time at 1×, faster during time warp)
        this._simJD += dt / 86400 * this._timeScale;

        this._tickLivePlanets();
        this._tickSun(dt);
        if (this._jupiterSkin) this._jupiterSkin.update(this._t);
        this._tickProminences(dt);
        this._tickMoon(dt);
        // Fire time-update every frame for HUD / date picker / epoch badge
        // (the listener in space-weather.html throttles DOM writes to 4×/sec)
        if (now != null) {
            window.dispatchEvent(new CustomEvent('helio-time-update', {
                detail: {
                    jd:     this._simJD,
                    date:   new Date((this._simJD - 2440587.5) * 86400000),
                    source: this._eph.earth?.source ?? 'vsop87',
                }
            }));
        }
        this._tickHCS();
        this._tickWind(dt);
        this._tickAlvenSurface(dt);
        this._tickReconnection(dt);
        this._tickCME(dt);
        this._tickFlare(dt);
        this._tickMagnetosphere(dt);

        // Update shared Earth skin uniforms (time for aurora animation, sun dir for day/night)
        if (this._earthSkinU) {
            this._earthSkinU.u_time.value = this._t;
            const ep = this._earthGroup.position;
            if (ep.length() > 0) {
                this._earthSkinU.u_sun_dir.value.copy(ep).negate().normalize();
            }
        }

        this._controls.update();
        this._renderer.render(this._scene, this._camera);
    }
}
