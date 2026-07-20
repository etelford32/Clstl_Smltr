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
 * ONE CLOCK (SimClock, js/sim-clock.js — #917's design, unified here with
 * this branch's GPU pipeline): drift, particle LIFECYCLE, transit advection,
 * arrival detection, injections, and Earth spin/tilt all evaluate on the
 * same simTime at compression τ. Apparent speed = physical velocity × τ ÷
 * the region's disclosed spatial scale (SCALE registry). At τ=1 the entire
 * scene is the real magnetosphere at true rate; at τ>1 the SAME data
 * fast-forwards through the genuine forecast window and wraps to the live
 * present (see RING_CURRENT_VISUAL_PLAN.md).
 *   · Earth: subsolar longitude faces +X, axis tilted by the live solar
 *     declination — both from subsolarPoint(simTime), so the terminator and
 *     night hemisphere are the actual ones (τ>1 sweeps ≤75 min ahead: the
 *     phase stays near-real while advancing legibly).
 *   · Magnetosphere group tilts about scene Z by −ψ (dipoleTiltRad at
 *     simTime) — the ±11° diurnal wobble riding the ±23° seasonal tilt.
 *   · DISCLOSED ×1 exception: bounce runs at its TRUE physical rate in wall
 *     seconds at every τ (ions seconds-to-a-minute, O⁺ ~4× slower,
 *     electrons sub-second). At τ ≥ 60 real bounce would alias far above
 *     the frame rate and read as shimmer; period and amplitude stay
 *     physical, and at Real ×1 the whole scene — bounce included — is
 *     true rate.
 *
 * PARTICLE LIFECYCLE (the Sun→surface journey, on the sim clock):
 *   birth    nightside injection sector (~21–03 MLT, the plasma-sheet edge),
 *            entry flash scaled by the live O'Brien–McPherron |Q|
 *   life     drift + true-rate bounce; every particle carries its TRUE
 *            lifetime — charge exchange vs the geocoronal H halo for ions
 *            (energy/species/L-dependent: O⁺ ~10× shorter than H⁺ at
 *            100 keV = the observed two-phase recovery) or nominal
 *            scattering hours for electrons. The dusk asymmetry partly
 *            EMERGES from birth-at-midnight + westward drift + finite
 *            lifetime — the real mechanism.
 *   death    ENA channel: neutralised, escapes outward while fading (how
 *            ENA imagers photograph the ring current); precipitation
 *            channel (deep mirrors, all electrons): slides down its field
 *            line and impacts the atmosphere at auroral latitude — the
 *            journey's last stop. Then rebirth, hash-jittered.
 *   The vertex shader is a line-for-line transcription of particlePose()
 *   in js/ring-current-particles.js — node-tested, and it drives tooltip
 *   picking so hover agrees with the GPU. CHANGE THEM TOGETHER.
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
 *   plasmapause    teardrop = last closed equipotential of the SHIELDED
 *                  convection + corotation field (ring-current-efield.js —
 *                  dusk bulge through the stagnation point); faint circle =
 *                  Carpenter–Anderson Lpp(Kp) kept as a validation overlay
 *   ionosphere     630 nm airglow shell (Appleton crest bands snaking the
 *                  dip equator, plasma-bubble bite-outs) + fountain
 *                  streamlines — js/ring-current-ionosphere.js rendering
 *                  the js/ionosphere-fountain.js kernel, penetration-coupled
 *                  to the shielding ODE (the M-I story on screen)
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
 * PIPELINE (2026-07-11 rework):
 *   · Population attributes are built OFF-THREAD by js/ring-current-worker.js
 *     (transferred ArrayBuffers; synchronous buildPopulation fallback when
 *     Workers are unavailable).
 *   · Per-frame particle KINEMATICS run on the GPU: trappedPointsMaterial's
 *     vertex shader integrates drift (θ₀ + rate·uDriftHours) and bounce
 *     (λ_m·sin(rate·uBounceSec + φ)) from static attributes, and evaluates
 *     the radial profile, dusk asymmetry, and a nightside injection pulse
 *     per vertex. The attribute buffers upload ONCE; each frame costs the
 *     CPU a handful of uniform writes instead of 4700 position/color writes.
 *     The GLSL is a port of radialProfile/azimuthalWeight/ringPeakL — KEEP
 *     IN SYNC with js/ring-current-model.js (node tests pin the JS side;
 *     the shader mirrors it line for line).
 *   · Earth renders through the SHARED EarthSkin stack (js/earth-skin.js —
 *     same renderer as earth.html / space-weather-globe): Blue Marble, city
 *     lights, ocean specular, topographic bump, Rayleigh–Mie atmosphere,
 *     magnetic-latitude aurora oval (cloud shell deliberately OFF — see
 *     _buildEarth) — all driven by
 *     this page's live state (Kp, Bz, ap, and the model's own Dst feeding
 *     the skin's ring-current heating glow). The accurate spin phase is
 *     visible as the actual night hemisphere, live.
 *
 * Ported from #917 onto this architecture: per-parcel transit advection
 * (fast parcels overtake slow ones), magnetopause arrival flashes ∝ VBs,
 * VBs-gated nightside injection bursts with physical entry deceleration,
 * |Dst*|-coupled visible particle count, and hover tooltips (data behind
 * any particle). #917's drift signs were written for the pre-fix mirrored
 * frame — re-derived here for true GSM (westward = θ increasing).
 *
 * TAIL TRANSPORT (the journey's last rendered leg, 2026-07-11): sheath
 * tracers reaching the end of the rendered flank (θ > 2.05) fork on a
 * VBs gate — southward IMF drives flank/tail reconnection that feeds a
 * fraction of the sheath plasma into the plasma sheet (stage 2). Captured
 * tracers converge onto the flapping equatorial sheet, E×B-convect
 * EARTHWARD at the cross-tail-field return speed (~tens of km/s, VBs-
 * scaled, τ-honest through the same one-clock invariant), and HAND OFF at
 * the midnight injection region as a mini injection burst — the same
 * matter, traced Sun → L1 → sheath → tail → injection → drift → loss.
 * See _updateSheath.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    ringPeakL, dynamicPressure, subsolarPoint, dipoleTiltRad,
    couplingVBs, driftRateRadPerHour, driftPeriodHours, shueRadiusRe,
    sunDepartureMs, SOLAR, PHYS,
} from './ring-current-model.js';
import {
    buildPopulation, POPULATIONS, particlePose, hash1, DEATH_WINDOW,
} from './ring-current-particles.js';
import { SimClock, SCALE, apparentUnitsPerSec } from './sim-clock.js';
import { EarthSkin } from './earth-skin.js';
import { RingCurrentTransport } from './ring-current-transport.js';
import { ConvectionEField, boundaryL } from './ring-current-efield.js';
import { IonosphereFountain, N_CELLS as IONO_LON_CELLS } from './ionosphere-fountain.js';
import { IonosphereCells, STATES as CELL_STATES, magLatDeg } from './ionosphere-cells.js';
import { IonosphereLayer } from './ring-current-ionosphere.js';
import {
    exaggeration, engagement, realAltitudeKm, groundSpeedKmS, columnProfile,
    FL_BLEND_LO, FL_BLEND_HI, FL_LIFT_CAP, EXAG_MAX,
} from './ionosphere-descent.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';

// One canonical palette shared with the legend + analytics dots in
// ring-current.html and the population toggles — H⁺ #ffa040, O⁺ #94ff57,
// e⁻ #59baff — so a species reads the same colour everywhere.
const ION_COLOR      = new THREE.Color(1.000, 0.627, 0.251);   // H⁺ (#ffa040, solar wind)
const ION_O_COLOR    = new THREE.Color(0.580, 1.000, 0.341);   // O⁺ (#94ff57, ionospheric outflow)
const ION_HE_COLOR   = new THREE.Color(0.706, 0.549, 1.000);   // He⁺ (#b48cff, minor ion)
const ELECTRON_COLOR = new THREE.Color(0.349, 0.729, 1.000);   // e⁻ (#59baff)

// Fraction of ion PARTICLES built as O⁺ (POPULATIONS in
// js/ring-current-particles.js). Fixed at build time (species can't flip
// mid-flight without a bounce-phase jump); the on-screen ENERGY mix is
// steered per frame by a brightness uniform, normalised to this ratio.
const O_BUILD_FRACTION =
    POPULATIONS.ionsO.count / (POPULATIONS.ionsH.count + POPULATIONS.ionsO.count);

// Soft-glow point shader: every particle renders as a gaussian orb with a
// hot core instead of a hard square — used by the transit stream and the
// pressure envelope (per-vertex colors). Trapped populations use
// trappedPointsMaterial below, which computes kinematics on the GPU.
function glowPointsMaterial(size, opacity) {
    return new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexColors: true,
        uniforms: { uSize: { value: size }, uFade: { value: 1 } },
        vertexShader: `uniform float uSize; varying vec3 vC;
            void main() {
                vC = color;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                // 1.5 px LOD floor: stream/sheath/injection points stay
                // visible from the wide corridor view instead of vanishing.
                gl_PointSize = max(uSize * 320.0 / -mv.z, 1.5);
                gl_Position = projectionMatrix * mv;
            }`,
        // uFade: whole-pool dip used by the sweep-wrap transition (the
        // transit stream fades for ~0.8 s instead of teleporting).
        fragmentShader: `varying vec3 vC; uniform float uFade;
            void main() {
                float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
                float a = exp(-4.5 * r * r) - 0.011;
                if (a <= 0.0) discard;
                gl_FragColor = vec4(vC * (1.0 + 0.7 * (1.0 - r)) * uFade, a * ${opacity.toFixed(2)} * uFade);
            }`,
    });
}


/**
 * GPU trapped-particle material: the vertex shader IS the kinematics AND the
 * lifecycle — a line-for-line transcription of particlePose() in
 * js/ring-current-particles.js (node-tested reference; CHANGE TOGETHER).
 * Attributes (built off-thread):
 *   position = (L, θ_birth, λ_m)
 *   kin      = (driftRate rad/h scene-signed, bounceRate rad/s, φ)
 *   life     = (birthOffsetH, lifetimeH, lossChannel 0|±1, hashSeed)
 * Per-frame uniforms: uDriftHours (SIM hours — drift + lifecycle),
 * uBounceSec (wall — the disclosed ×1 bounce exception). Per-state:
 * uDstStar, uAsymAmp, uMix, uInjection, uVisFrac (|Dst*|-coupled visible
 * count: hidden particles keep evolving, so a deepening storm reveals a
 * coherent ring, not a fresh scatter — #917's nVis, hash-gated on GPU).
 * Brightness weight ports radialProfile · azimuthalWeight · ringPeakL from
 * js/ring-current-model.js — KEEP THE GLSL IN SYNC.
 */
function trappedPointsMaterial(size, opacity, color) {
    return new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: {
            uSize:       { value: size },
            uOpacity:    { value: opacity },
            uColor:      { value: new THREE.Color(color) },
            uDriftHours: { value: 0 },      // SIM hours (SimClock domain)
            uBounceSec:  { value: 0 },      // wall seconds (×1 exception)
            uDstStar:    { value: -10 },
            uAsymAmp:    { value: 0 },
            uAsymMlt:    { value: 19 },
            uMix:        { value: 1 },      // composition brightness steer
            uInjection:  { value: 0 },      // |Q| / 12 nT/h, clamped 0..1
            uVisFrac:    { value: 0.45 },   // visible-count fraction (Dst-coupled)
            uMinPx:      { value: 1.4 },    // LOD floor — raised as camera recedes
            uFarBoost:   { value: 0 },      // LOD brightness lift for clamped points
        },
        vertexShader: `
            uniform float uSize, uDriftHours, uBounceSec, uDstStar,
                          uAsymAmp, uAsymMlt, uMix, uInjection, uVisFrac,
                          uMinPx, uFarBoost;
            attribute vec3 kin;
            attribute vec4 life;
            varying float vW;
            varying float vE;   // energy-dispersion tint, 0 = 20 keV … 1 = 250 keV
            const float PI = 3.14159265358979;
            const float DW = ${DEATH_WINDOW.toFixed(3)};   // death-window fraction

            // Trig-free hash — IDENTICAL to hash1() in ring-current-particles.js.
            float hash1(float p) {
                p = fract(p * 0.1031);
                p *= p + 33.33;
                p *= p + p;
                return fract(p);
            }

            void main() {
                float L    = position.x;
                float lamM = position.z;
                float lt   = life.y;

                // Energy-dispersion tint: no extra attribute needed — the
                // drift rate already ENCODES energy. Inverting the model's
                // exact driftPeriodHours (2π·q·B₀·R_E²/(3·L·E) ⇒
                // T_h = 734.4/(L·E_keV) at the equator):
                //   E_keV = 734.4·|rate|/(2π·L)
                // Log-normalised over the built 20–250 keV range. Fast pale
                // particles visibly LAP deep slow ones: the dispersion that
                // smears injections into a ring, now watchable.
                vE = clamp(log(734.4 * abs(kin.x) / (6.28318531 * L) / 20.0) / 2.5257,
                           0.0, 1.0);

                // ── Lifecycle clock (sim hours) — mirrors particlePose() ──
                float age   = uDriftHours + life.x;
                float cycle = floor(age / lt);
                float ph    = age / lt - cycle;                 // 0 birth … 1 death
                float jit   = hash1(life.w * 61.7 + cycle);     // per-rebirth jitter

                float thetaB = position.y + (jit - 0.5) * 0.7;  // nightside birth θ
                float tKin   = min(ph, 1.0 - DW) * lt;          // kinematics freeze at death
                float theta  = thetaB + kin.x * tKin;

                float lam = lamM * sin(kin.y * uBounceSec + kin.z + cycle * 2.399);
                float dying = smoothstep(1.0 - DW, 1.0, ph);
                if (life.z != 0.0 && dying > 0.0) {
                    // Precipitation: down the field line to the footpoint
                    // (r → 1) — impacts the atmosphere at auroral latitude.
                    float lamFoot = acos(inversesqrt(L)) * sign(life.z);
                    lam = mix(lam, lamFoot, dying);
                }
                float cl = cos(lam);
                float r  = L * cl * cl;
                vec3 p = vec3(r * cl * cos(theta), r * sin(lam), r * cl * sin(theta));
                if (life.z == 0.0 && dying > 0.0) {
                    // Charge exchange: neutral now — field can't hold it;
                    // the ENA escapes outward while fading.
                    p *= 1.0 + dying * 2.2;
                }

                // radialProfile(L, Dst*) — GLSL port (sync with model JS).
                float d     = min(0.0, uDstStar);
                float peak  = 2.4 + 1.6 * exp(d / 120.0);          // ringPeakL
                float sigma = L < peak ? 0.55 : 1.15;
                float g     = exp(-(L - peak) * (L - peak) / (2.0 * sigma * sigma))
                            / (1.0 + exp(-(L - 1.8) / 0.12))       // inner truncation
                            / (1.0 + exp((L - 6.8) / 0.35));       // outer skirt
                // azimuthalWeight — MLT = (12 − θ·12/π) mod 24 (GSM frame).
                float mlt = mod(12.0 - theta * 12.0 / PI, 24.0);
                float azw = 1.0 + uAsymAmp * cos((mlt - uAsymMlt) / 24.0 * 2.0 * PI);
                // Nightside injection glow near ~1 MLT, live-scaled by |Q|.
                float dmlt = mod(mlt - 1.0 + 12.0, 24.0) - 12.0;
                float inj  = uInjection * exp(-dmlt * dmlt / 12.5);

                float intensity = (0.25 + 0.75 * min(1.0, abs(uDstStar) / 150.0)) * uMix;
                vW = (0.06 + 0.94 * min(1.3, g * azw * intensity)) * (1.0 + 1.4 * inj * g);

                // Life envelope: fade in at birth (flash ∝ live |Q|), death
                // by channel — ENA fades out as it escapes; precipitation
                // flares approaching impact, then cuts at the surface.
                float birth = smoothstep(0.0, 0.03, ph)
                            * (1.0 + (0.6 + 2.4 * uInjection) * exp(-ph * 45.0));
                float death = life.z == 0.0
                    ? 1.0 - dying
                    : (1.0 + 1.6 * smoothstep(0.55, 0.95, dying))
                      * (1.0 - smoothstep(0.97, 1.0, dying));
                // |Dst*|-coupled visible count (stable hash gate — hidden
                // particles keep evolving off-screen).
                float vis = step(hash1(life.w * 0.517), uVisFrac);
                vW *= birth * death * vis;

                vec4 mv = modelViewMatrix * vec4(p, 1.0);
                // LOD: per-particle size variance (the ring reads as a
                // DISCRETE medium, not uniform grain), a minimum pixel
                // floor so particles survive zoom-out instead of dropping
                // sub-pixel, and a brightness lift that grows only for
                // points the floor actually clamped — near views unchanged.
                float sz = 0.75 + 0.7 * hash1(life.w * 3.71);
                float px = uSize * sz * 320.0 / -mv.z;
                gl_PointSize = max(px, uMinPx);
                vW *= 1.0 + uFarBoost * (1.0 - min(1.0, px / 3.0));
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: `
            uniform vec3 uColor; uniform float uOpacity;
            varying float vW;
            varying float vE;
            void main() {
                float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
                float a = exp(-4.5 * r * r) - 0.011;
                if (a <= 0.0) discard;
                // Energy tint, expressed IDENTICALLY across species so 20 keV
                // reads equally deep and 250 keV equally pale for H⁺/O⁺/e⁻:
                // cold = the species hue, dimmed; hot = brightened and
                // desaturated toward NEUTRAL white (not a warm bias, which used
                // to pull blue electrons and orange ions to different whites).
                vec3 hot = min(vec3(1.0), mix(uColor, vec3(1.0), 0.42) * 1.55);
                vec3 c = mix(uColor * 0.75, hot, vE);
                gl_FragColor = vec4(c * (1.0 + 0.7 * (1.0 - r)) * vW, a * uOpacity);
            }`,
    });
}


const smoothstepJs = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

/** Thin polar axis line through the origin, length ±halfLen. */
function axisLine(halfLen, color, opacity) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
        new Float32Array([0, -halfLen, 0, 0, halfLen, 0]), 3));
    return new THREE.Line(geo, new THREE.LineBasicMaterial({
        color, transparent: true, opacity, depthWrite: false,
        blending: THREE.AdditiveBlending,
    }));
}

// ── Incoming solar wind stream (the Sun→Earth twin bridge) ──────────────────
// Each parcel = one not-yet-arrived L1 sample from feed state.transit.
// Position = fraction of its OWN L1→Earth transit elapsed at simTime
// (per-parcel measured speed ⇒ fast parcels overtake slow ones), evaluated
// every frame from the SimClock — never only at data-fetch time. Corridor
// geometry lives in the SCALE registry (js/sim-clock.js) so the leg's
// spatial compression is explicit, not smuggled in as an animation speed.
const TRANSIT = Object.freeze({
    MAX_PARCELS: 120,
    PTS_PER:     14,     // per-slot BASE budget; VISIBLE count scales with density
    DENS_MAX:    4,      // buffers sized for the ×4 stream-density setting
                         // (a VISUAL multiplier on rendered points per 1-min
                         // sample — never more data than was measured)
    X_MP:        SCALE.CORRIDOR.X_MP,    // ≈ subsolar magnetopause (R_E)
    X_SUN:       SCALE.CORRIDOR.X_SUN,   // corridor start, toward the Sun
    WAVE_Y:      4.2,    // baseline height of the barometric density trace
    WAVE_AMP:    3.2,    // trace amplitude at n = N_REF
    N_REF:       20,     // density (cm⁻³) that saturates count/trace scaling
});

// ── Default camera views ─────────────────────────────────────────────────────
// Three framings of the ONE scene (nothing re-renders differently — a view
// is just a camera pose, so the physics can never fork per view):
//   earth — the original near-Earth framing: ring, aurora, boundaries.
//   sun   — close on the solar disk: coronal holes, the back-mapped source
//           ring, emission puffs and the Parker-spiral streamline into the
//           L1 gate. minDistance still applies — users can push right into
//           the disk to read the emission activity.
//   river — the full corridor side-on (Sun left, Earth right), far enough
//           that the LOD boost thickens the stream into the "river" read
//           and every in-scene stat label is legible in one frame.
// Positions are hand-framed against the TRANSIT/SCALE geometry above;
// verified by the view-switcher browser probe (tests/ + scratchpad).
const CAM_VIEWS = Object.freeze({
    earth: { pos: [8.5, 6.0, 9.5],  target: [0, 0, 0] },
    sun:   { pos: [38, 6.5, 15.5],  target: [56, 3.6, 0] },
    river: { pos: [74, 23, -46],    target: [19, -2, 0] },
});

// ── Trails are INTEGRATED PATHS, not decorations ─────────────────────────────
// Every trail spans exactly the trajectory covered in the last TRAIL_VIEW_S
// seconds of VIEWING: length = apparent speed × TRAIL_VIEW_S for the straight
// corridor stream, and for ring particles the trail is the SAME kinematics
// re-evaluated at lagged clocks — a true curved drift+bounce arc. Because the
// window is viewing time, trails scale honestly with τ and collapse to
// sub-pixel at Real ×1 (real motion IS near-stillness; no fake streaks).
const TRAIL_VIEW_S = 0.45;
const RING_TRAIL_ECHOES = 2;   // lagged re-draws of each population

// Nightside injection bursts (#917 Phase 4): triggered when an arriving
// parcel carries VBs above the O'Brien–McPherron coupling cutoff. Entry
// speed and deceleration are physical (exponential approach, initial
// ~(r₀−L)/T_IN R_E per sim-second ≈ 100–350 km/s); the FADE is a rendering
// cue in wall time.
const INJECT = Object.freeze({
    CAP:        900,     // particle pool
    T_IN_S:     90,      // inflow time constant (sim seconds)
    LIFE_S:     26,      // wall-clock fade after settling into drift
    VBS_MIN:    0.5,     // ≈ OBM Ec — northward/weak parcels don't inject
});

/**
 * L1 measurement plane — the "3D sheet" where every parcel is BORN. L1 is
 * not rendered as a point because it isn't one in practice: DSCOVR/ACE fly
 * halo orbits AROUND the libration point and deliver one plasma/field
 * sample per minute through this aperture. The disc spans the volumetric
 * stream's full cross-section, carries a faint instrument graticule
 * (concentric range rings), and PULSES an expanding ring each time a new
 * 1-minute sample lands from the feed — wall-clock, because the gate is
 * live instrumentation, not physics (same rule as the parcel heartbeat).
 */
function l1GateMaterial(radius) {
    return new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
            uPulse: { value: 0 },     // 1 on sample arrival → decays in tick
            uTime:  { value: 0 },
        },
        vertexShader: `varying vec2 vXY;
            void main() {
                vXY = position.xy;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: `
            uniform float uPulse, uTime;
            varying vec2 vXY;
            void main() {
                float r = length(vXY) / ${radius.toFixed(1)};
                if (r > 1.0) discard;
                // Instrument graticule: faint concentric range rings.
                float rings = pow(abs(sin(r * 12.566)), 32.0) * 0.35;   // 4 rings
                // Sample-crossing pulse: a ring expanding outward while the
                // trigger decays (1 → 0), like a sonar return.
                float pr = 1.0 - uPulse;
                float pulse = uPulse * exp(-pow((r - pr) * 9.0, 2.0));
                // Near-subliminal rotating sweep so the plane reads "live".
                float sweep = 0.04 * pow(0.5 + 0.5 * sin(atan(vXY.y, vXY.x) - uTime * 0.35), 6.0);
                float edge = smoothstep(1.0, 0.82, r);
                float b = (0.05 + 0.08 * (1.0 - r) + rings * 0.2 + sweep * 1.6 + pulse * 0.85) * edge;
                gl_FragColor = vec4(vec3(0.55, 0.78, 1.0) * b, b);
            }`,
    });
}

/**
 * Solar-wind sheet: the wind rendered as a continuous MEDIUM, not just dots.
 * An open flux tube spans the corridor; the fragment shader reads a 128-bin
 * 1-D profile texture rebuilt every frame from the REAL parcel series —
 *   R = density norm   → glow brightness (compression fronts = bright bands)
 *   G = Bz southness   → color (cool blue north → hot orange south) + a
 *                        fast crackle on strongly-southward sections
 *   B = speed norm     → local wave advection rate
 *   A = presence       → discard where no data
 * Longitudinal waves sweep Earthward at the τ-scaled apparent speed (uFlow
 * advanced per frame by the invariant), and the shader brightens where the
 * density GRADIENT is steep — interplanetary compression fronts highlight
 * themselves. Cinematic, but every pixel traces to a measured L1 sample.
 */
function windSheetMaterial(dataTex) {
    return new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        // BackSide, deliberately: since the volumetric flare the default
        // camera sits INSIDE the tube — DoubleSide was rasterizing every
        // screen pixel twice (near wall + far wall), a measurable stutter
        // source on integrated GPUs. BackSide keeps the look-through-the-
        // volume reading from outside and the surrounding-walls reading
        // from inside at HALF the fill cost.
        side: THREE.BackSide,
        uniforms: {
            uData: { value: dataTex },
            uXmp:  { value: SCALE.CORRIDOR.X_MP },
            uSpan: { value: SCALE.CORRIDOR.SPAN },
            uFlow: { value: 0 },     // wave phase — advanced at τ-scaled speed
            uTime: { value: 0 },     // wall seconds (crackle flicker)
            uFade: { value: 1 },     // sweep-wrap dip (see glowPointsMaterial)
        },
        vertexShader: `
            varying vec3 vW; varying vec3 vN;
            void main() {
                vW = (modelMatrix * vec4(position, 1.0)).xyz;
                vN = normalize(mat3(modelMatrix) * normal);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: `
            uniform sampler2D uData;
            uniform float uXmp, uSpan, uFlow, uTime, uFade;
            varying vec3 vW; varying vec3 vN;
            void main() {
                float u = clamp((vW.x - uXmp) / uSpan, 0.0, 1.0);
                vec4 d = texture2D(uData, vec2(u, 0.5));
                if (d.a < 0.02) discard;
                float n = d.r;
                float south = smoothstep(0.5, 0.95, d.g);
                float vLoc = 0.45 + 0.85 * d.b;
                // Waves sweeping Earthward (−x) at the local τ-scaled speed.
                float ph = vW.x * 2.4 + uFlow * vLoc;
                float wave = 0.55 + 0.45 * sin(ph) * (0.6 + 0.4 * sin(ph * 0.37 + 1.7));
                // Compression fronts: steep density gradient → bright band.
                float front = smoothstep(0.08, 0.30,
                    abs(texture2D(uData, vec2(u + 0.02, 0.5)).r -
                        texture2D(uData, vec2(u - 0.02, 0.5)).r));
                // Volume feel: brightest looking through the tube's middle.
                float rim = abs(dot(normalize(vN), normalize(cameraPosition - vW)));
                float body = pow(rim, 1.5);
                vec3 col = mix(vec3(0.28, 0.58, 1.0), vec3(1.0, 0.42, 0.16), south);
                // Strong southward sections crackle — the dangerous stuff flickers.
                float crackle = south * 0.22 * (0.5 + 0.5 * sin(uTime * 21.0 + vW.x * 6.3));
                float b = (0.12 + 1.25 * n) * wave * body * d.a * uFade;
                b *= 1.0 + 1.7 * front + crackle;
                gl_FragColor = vec4(col * b, min(1.0, b) * 0.5);
            }`,
    });
}

/**
 * Plasma-sheet return-flow sheet: the tail-transport leg rendered as a
 * MEDIUM, the same pattern as the solar-wind sheet — a thin equatorial
 * sheet spanning the near tail whose waves march EARTHWARD at the live
 * VBs-scaled E×B return speed (uFlow advanced per frame through the
 * one-clock invariant: near-frozen at Real ×1, streaming at ×300), with
 * brightness following the eased tail-feeding level — the SAME VBs gate
 * the stage-2 tracers take, so the sheet lights up exactly when matter is
 * actually entering the tail. Color ramps cool blue (fresh captured
 * plasma, tailward) → gold at the inner edge, matching the tracer tint.
 * Flapping is a wall-time rendering cue (sheet thickness oscillation);
 * bulk wave motion is τ-honest. Subtle: peak additive alpha ≈ 0.15.
 */
function tailSheetMaterial() {
    return new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
            uFeed: { value: 0 },    // eased tail-feeding level 0..1 (VBs gate)
            uFlow: { value: 0 },    // Earthward wave phase (τ-honest advance)
            uTime: { value: 0 },    // wall seconds — flapping only
        },
        vertexShader: `
            uniform float uTime;
            varying vec3 vLoc;
            void main() {
                vec3 p = position;
                // Plasma-sheet flapping: gentle travelling warp, growing
                // tailward (the near-Earth sheet is anchored by the dipole).
                float amp = 0.55 * smoothstep(-7.0, -20.0, p.x);
                p.y += amp * sin(p.x * 0.45 + uTime * 0.5 + p.z * 0.25);
                vLoc = p;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
            }`,
        fragmentShader: `
            uniform float uFeed, uFlow, uTime;
            varying vec3 vLoc;
            void main() {
                // Envelope: fade at the flanks, the far tail, and toward the
                // injection region (the burst pool takes the story over).
                float ez = 1.0 - smoothstep(5.5, 8.5, abs(vLoc.z));
                float ex = smoothstep(-26.0, -22.0, vLoc.x)
                         * (1.0 - smoothstep(-9.5, -6.5, vLoc.x));
                // Earthward-marching waves: sin(k·x − uFlow), uFlow advanced
                // at k × the live E×B return speed — the flow itself.
                float wave = 0.55 + 0.45 * sin(vLoc.x * 1.7 - uFlow)
                           * (0.6 + 0.4 * sin(vLoc.x * 0.63 - uFlow * 0.37 + vLoc.z * 0.8));
                // Heat ramp matching the stage-2 tracer tint: cool captured
                // plasma tailward → gold approaching the handoff.
                float heat = smoothstep(-22.0, -8.0, vLoc.x);
                vec3 col = mix(vec3(0.30, 0.45, 0.85), vec3(1.0, 0.82, 0.45), heat);
                float b = uFeed * ez * ex * wave * 1.5;
                gl_FragColor = vec4(col * b, min(1.0, b) * 0.22);
            }`,
    });
}

/**
 * Boundary-surface material (magnetopause / bow shock). The GEOMETRY is a
 * static (θ, φ) parameter grid — the vertex shader evaluates the live Shue
 * (1998) surface r(θ) = uRScale·uR0·(2/(1+cosθ))^uAlpha every frame, so a
 * pressure pulse deforms the whole shell with two uniform writes. Fragment:
 * screen-space-derivative normals → fresnel rim (the boundary reads as a
 * translucent membrane), a faint tailward shimmer so it reads as a surface
 * IN a flow, and a warm tint + brightening as compression (uCompress) rises.
 */
function boundaryMaterial(tint, opacity, rScale) {
    return new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
            uR0:       { value: 10.2 },
            uAlpha:    { value: 0.6 },
            uRScale:   { value: rScale },
            uTint:     { value: new THREE.Color(tint) },
            uOpacity:  { value: opacity },
            uCompress: { value: 0 },
            uTime:     { value: 0 },
            uShockTh:  { value: -9 },    // shock-front band center (solar-zenith θ)
            uShockAmp: { value: 0 },     // band amplitude — decays as it sweeps
        },
        vertexShader: `
            uniform float uR0, uAlpha, uRScale;
            varying vec3 vPos;
            void main() {
                float th = position.x, ph = position.y;
                float r = uRScale * uR0 * pow(2.0 / (1.0 + cos(th)), uAlpha);
                vec3 p = vec3(r * cos(th), r * sin(th) * sin(ph), r * sin(th) * cos(ph));
                vPos = p;
                gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
            }`,
        fragmentShader: `
            uniform vec3 uTint;
            uniform float uOpacity, uCompress, uTime, uShockTh, uShockAmp;
            varying vec3 vPos;
            void main() {
                vec3 N = normalize(cross(dFdx(vPos), dFdy(vPos)));
                vec3 V = normalize(cameraPosition - vPos);
                float rim = pow(1.0 - abs(dot(N, V)), 2.0);
                float shim = 0.85 + 0.15 * sin(vPos.x * 1.3 - uTime * 1.1
                                               + atan(vPos.y, vPos.z) * 2.0);
                vec3 col = mix(uTint, vec3(1.0, 0.62, 0.35), uCompress);
                float a = uOpacity * (rim * 0.85 + 0.05) * shim * (1.0 + 0.9 * uCompress);
                // Shock front: a gaussian band (σ ≈ 0.11 rad) at the live
                // front position, sweeping nose→tail as _updateCinematics
                // advances uShockTh at the shock's own τ-scaled speed — the
                // interplanetary shock visibly WASHES OVER the boundary.
                float thF = atan(length(vPos.yz), vPos.x);
                float band = uShockAmp
                    * exp(-(thF - uShockTh) * (thF - uShockTh) / 0.024);
                col = mix(col, vec3(1.0, 0.85, 0.6), min(0.7, band));
                a *= 1.0 + 2.6 * band;
                gl_FragColor = vec4(col * a, a);
            }`,
    });
}

/** Static (θ, φ) parameter grid the boundary vertex shader deforms. */
function boundaryGrid(thetaMax, rows, cols) {
    const pos = [], idx = [];
    for (let i = 0; i <= rows; i++) {
        const th = (i / rows) * thetaMax;
        for (let j = 0; j <= cols; j++) {
            pos.push(th, (j / cols) * 2 * Math.PI, 0);
        }
    }
    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
            const a = i * (cols + 1) + j, b = a + cols + 1;
            idx.push(a, b, a + 1, b, b + 1, a + 1);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    return geo;
}

/**
 * ENA glow halo — how the ring current is actually PHOTOGRAPHED. Charge
 * exchange turns trapped ions into energetic neutral atoms that stream off
 * in straight lines; imagers (IMAGE/HENA, TWINS) integrate that emission
 * into a diffuse glow. Emission ∝ ion flux × geocoronal density, so the
 * shader multiplies the same radialProfile the populations use by the
 * n_H ∝ L⁻³·⁵ halo — brightest just inside the ring's inner edge. VERY
 * subtle by design: peak additive alpha ≈ 0.05, and the amplitude EASES
 * toward its |Dst*|-driven target over ~8 s in tick(), like a real
 * integrating imager accumulating counts.
 */
function enaHaloMaterial() {
    return new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
            uEna:     { value: 0 },      // eased accumulation amplitude 0..1
            uDstStar: { value: -10 },
            uAsymAmp: { value: 0 },
            uAsymMlt: { value: 19 },
            uTime:    { value: 0 },
        },
        vertexShader: `
            varying vec2 vXY;
            void main() {
                vXY = position.xy;   // RingGeometry local plane (pre-tilt)
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: `
            uniform float uEna, uDstStar, uAsymAmp, uAsymMlt, uTime;
            varying vec2 vXY;
            const float PI = 3.14159265358979;
            void main() {
                float L = length(vXY);
                // radialProfile — same GLSL port as the populations.
                float d     = min(0.0, uDstStar);
                float peak  = 2.4 + 1.6 * exp(d / 120.0);
                float sigma = L < peak ? 0.55 : 1.15;
                float flux  = exp(-(L - peak) * (L - peak) / (2.0 * sigma * sigma))
                            / (1.0 + exp(-(L - 1.8) / 0.12))
                            / (1.0 + exp((L - 6.8) / 0.35));
                // Geocorona n_H ∝ L^-3.5, normalised at L=2 — ENA emission
                // is flux × n_H, so the glow hugs the ring's inner edge.
                float nH = pow(max(1.05, L) / 2.0, -3.5);
                // Mild MLT weighting: the emission follows the (asymmetric)
                // ion distribution — mesh rotation.x maps local +y → scene z,
                // so θ = atan2(y, x) directly.
                float mlt = mod(12.0 - atan(vXY.y, vXY.x) * 12.0 / PI, 24.0);
                float azw = 1.0 + 0.5 * uAsymAmp * cos((mlt - uAsymMlt) / 24.0 * 2.0 * PI);
                // Slow imager-noise shimmer, near-subliminal.
                float shim = 0.92 + 0.08 * sin(uTime * 0.7 + L * 3.1 + mlt);
                float b = uEna * flux * nH * azw * shim;
                gl_FragColor = vec4(vec3(0.95, 0.86, 0.70) * b, 0.12);
            }`,
    });
}

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
        // THE clock. Page passes a shared SimClock so UI and scene agree;
        // standalone use gets its own. `timeCompression` opt kept as the
        // legacy spelling of the initial τ.
        this._clock = opts.clock ?? new SimClock({ tau: opts.timeCompression ?? undefined });
        this._seenWraps = this._clock.wraps;
        this._lastSimNow = this._clock.now();
        this._state = {       // safe quiet defaults until the first feed state
            dstStar: -10, peakL: ringPeakL(-10),
            asym: { amplitude: 0, mltPeakHours: 19 },
            plasmapauseL: 4.7,
            injection: 0,     // |Q|/12, clamped 0..1 — drives the nightside pulse
        };
        this._disposed = false;
        this._raf = 0;
        this._lastT = 0;
        this._tView = 0;          // wall-clock seconds — TRUE bounce time (×1 exception)
        this._wrapT = 1;          // sweep-wrap dip timer (1 = no dip pending)
        this._simHours = 0;       // SIM hours — drift + lifecycle clock (SimClock)
        this._builtPeakL = 0;
        this._parcels = [];       // in-transit L1 samples (state.transit)
        // Performance instrumentation: per-section CPU EMAs, a frame-time
        // ring buffer (p95), and an adaptive quality tier — see _perfCheck.
        this._perf = {
            frameMs: 16.7, buf: new Float32Array(240), bi: 0, bn: 0,
            sections: { state: 0, transit: 0, pools: 0, tooltip: 0, render: 0 },
            tier: 0, slow: 0, lastCheck: 0,
        };

        const w = container.clientWidth || 800;
        const h = container.clientHeight || 600;

        this._scene = new THREE.Scene();
        this._camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 300);
        this._camera.position.set(8.5, 6.0, 9.5);

        this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this._renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        this._renderer.setSize(w, h);
        container.appendChild(this._renderer.domElement);

        // Additive bloom overlay (see _renderFrame). Sized to the drawing
        // buffer (CSS px × pixelRatio), not CSS px, so the glow registers 1:1.
        this._initBloom(this._renderer.domElement.width, this._renderer.domElement.height);

        this._controls = new OrbitControls(this._camera, this._renderer.domElement);
        this._controls.enableDamping = true;
        this._controls.dampingFactor = 0.06;
        // 1.28 (was 2.5 pre-Track-C): zooming in IS the descent — below
        // ~3 Rᴇ the disclosed vertical exaggeration engages and the floor
        // becomes the low-orbit altitude band (~100 km real at full ×18).
        this._controls.minDistance = 1.28;
        this._controls.maxDistance = 140;   // far enough to frame the Sun corridor
        // Named default views (CAM_VIEWS / setView). Any user grab cancels an
        // in-progress flight — the presets are starting points, not a cage.
        this._flight = null;
        this._activeView = 'earth';
        this._controls.addEventListener('start', () => { this._flight = null; });

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

        // Physics transport core — a bounce-averaged (L, MLT, energy, species)
        // model, stepped on THIS scene's SimClock from the SAME live driver
        // (Kp/VBs) the empirical model uses, so its emergent Dst* and the twin's
        // stay coherent. Defaults to the JS reference (js/ring-current-transport
        // .js); the page may inject the byte-identical Rust/WASM kernel instead
        // (opts.transport = loadRingCurrentKernel(...)) — same interface, both
        // pinned equal by tests/ring-current-kernel-smoke.mjs.
        this._transport = opts.transport ?? new RingCurrentTransport();

        // M-I coupling field core (Track 0) + equatorial fountain kernel
        // (Track A) — both pure, node-tested, stepped on THIS SimClock from
        // the same live Kp/VBs driver as the transport core. The efield's
        // penetration ΔA is the fountain's storm input: the HUD bars, the
        // plasmapause teardrop, and the airglow all move together.
        this._efield = opts.efield ?? new ConvectionEField();
        this._iono = opts.ionosphere ?? new IonosphereFountain();
        if (!opts.ionosphere) {
            // Spin-up: pre-run the diurnal state (crests, hF, this evening's
            // hash-seeded bubbles) through the last 30 sim-h so the airglow
            // arrives already reflecting "now" — a ×1 visitor would otherwise
            // stare at a cold dark shell for hours (same reason as the
            // transport's _heatSpinup). Quiet-driver history (dA = 0, default
            // Kp) — the live feed takes over from the first state event.
            const nowMs = this._clock.now();
            const STEP = 300;
            for (let t = nowMs - 30 * 3600e3 + STEP * 1e3; t <= nowMs; t += STEP * 1e3) {
                this._iono.tick(t, STEP, { dA: 0 });
            }
        }

        this._buildEarth();
        this._buildFieldLines();
        this._buildParticles();
        this._buildRings();
        this._buildIonosphere();
        this._buildRcHeatmap();
        this._buildEnaImager();
        this._buildSunAndTransit();
        this._buildBoundaries();
        this._buildFlashes();
        this._buildInjections();
        this._buildCinematics();
        this._initTooltip();

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
        // Shared Earth renderer (js/earth-skin.js — the same skin earth.html
        // and the space-weather globe use): Blue Marble + city lights + ocean
        // specular glint + topographic bump, Rayleigh–Mie atmosphere rim,
        // procedural cloud shell with relief lighting, magnetic-latitude
        // aurora oval, and a ring-current nightside heating glow (u_dst_norm)
        // that THIS page feeds from its own live O'Brien–McPherron model —
        // the Earth's appearance and the 3D ring around it share one physics
        // state (see setState).
        //
        // Frame: js/geo/coords.js maps lon 0 → +X and EAST → −Z — identical
        // to this scene's GSM mapping (dusk at −Z), so the spin phase stays
        // rotation.y = −λ_subsolar with the Sun fixed on world +X (that is
        // what GSM means). Tilt group carries rotation.z = −declination; the
        // spin group inside rotates about the tilted axis. Both update every
        // frame from the wall clock in _updateGeometry() — the terminator,
        // city-light hemisphere, and season are the actual ones right now.
        this._earthTilt = new THREE.Group();   // rotation.z = −declination
        this._earthSpin = new THREE.Group();   // rotation.y = −subsolar lon
        this._earthTilt.add(this._earthSpin);
        this._scene.add(this._earthTilt);

        // NO cloud shell, deliberately (clouds: false): this is a
        // magnetosphere page — the procedural cloud deck read as noise here
        // and was removed on request. Do not re-enable it.
        this._skin = new EarthSkin(this._earthSpin, new THREE.Vector3(1, 0, 0), {
            radius: 1, segments: 48, clouds: false, atmosphere: true,
        });
        this._skin.loadTextures({
            anisotropy: this._renderer.capabilities.getMaxAnisotropy(),
        });   // resolves even on CDN failure — safe per-slot fallbacks

        // Geographic spin axis — with the dipole axis in _magGroup this makes
        // the daily wobble between the two visibly legible.
        this._earthTilt.add(axisLine(1.38, 0xdfe8ff, 0.5));
    }

    _buildFieldLines() {
        const group = new THREE.Group();
        // Line shader = the field-line branch of the Track C descent remap
        // (js/ionosphere-descent.js remapFieldLineRadius, constants INJECTED
        // from the kernel so GLSL can't drift from the node-tested JS):
        // saturating tanh lift at the footpoints so the cage meets the
        // exaggerated atmosphere — and the aurora curtains, which use the
        // same remap — released across the blend band, identity above.
        const mat = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false,
            blending: THREE.AdditiveBlending,
            uniforms: { uExag: { value: 1 } },
            vertexShader: `
                uniform float uExag;
                void main() {
                    float r = length(position);
                    float w = 1.0 - smoothstep(${FL_BLEND_LO.toFixed(4)},
                        ${FL_BLEND_HI.toFixed(4)}, r);
                    // tanh via exp, argument CLAMPED: cage radii reach
                    // r ≈ 6.5 → x ≈ 117 → exp(234) overflows float and the
                    // Inf/NaN positions send software rasterizers into
                    // pathological clipping. tanh saturates ≈ 1 by x = 10.
                    float x = clamp((r - 1.0) / ${FL_LIFT_CAP.toFixed(6)}, 0.0, 10.0);
                    float e2 = exp(2.0 * x);
                    float lift = (uExag - 1.0) * ${FL_LIFT_CAP.toFixed(6)}
                        * (e2 - 1.0) / (e2 + 1.0);
                    float rNew = r + lift * w;
                    gl_Position = projectionMatrix * modelViewMatrix
                        * vec4(position * (rNew / max(r, 1e-6)), 1.0);
                }`,
            fragmentShader: `
                void main() { gl_FragColor = vec4(0.373, 0.475, 0.722, 0.20); }`,
        });
        this._cageMat = mat;
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

    /**
     * Populations are BUILT off-thread (js/ring-current-worker.js) and
     * rendered from static GPU attributes — see header. The worker path is
     * fire-and-forget at construction; until buffers arrive the ring simply
     * hasn't populated yet (~a frame or two). Any worker failure falls back
     * to building inline with the same buildPopulation the worker runs.
     */
    _buildParticles() {
        this._popPoints = {};    // key → { points, mat }
        this._popList = [];      // same records, cached (tick runs per frame —
                                 // Object.values() there was per-frame garbage)
        this._pendingMix = 0.06; // quiet-time O⁺ energy mix until first state
        const styles = {
            ionsH:     { color: ION_COLOR,      size: 0.085 },
            ionsO:     { color: ION_O_COLOR,    size: 0.095 },
            ionsHe:    { color: ION_HE_COLOR,   size: 0.088 },
            electrons: { color: ELECTRON_COLOR, size: 0.060 },
        };
        const addPop = (key, pop) => {
            if (this._disposed) return;
            this._popPoints[key] = this._makePoints(pop, styles[key].color, styles[key].size);
            this._popList.push(this._popPoints[key]);
            this._setCompositionMix(this._pendingMix);
            // Honor a visibility choice made before this population finished
            // building on the worker (toggles set via the interactive legend).
            if (this._popVisible && this._popVisible[key] === false) {
                this.setPopulationVisible(key, false);
            }
        };
        const buildInline = () => {
            for (const [key, spec] of Object.entries(POPULATIONS)) {
                if (!this._popPoints[key]) addPop(key, buildPopulation(spec.count, spec.species));
            }
        };
        try {
            if (typeof Worker === 'undefined') throw new Error('no Worker API');
            const w = new Worker(new URL('./ring-current-worker.js', import.meta.url), { type: 'module' });
            let got = 0;
            const bail = (e) => { console.warn('[ring-current] population worker failed:', e); w.terminate(); buildInline(); };
            const timer = setTimeout(() => bail(new Error('timeout')), 8000);
            w.onerror = (e) => { clearTimeout(timer); bail(e.error ?? e.message ?? e); };
            w.onmessage = (ev) => {
                const m = ev.data;
                if (!m?.ok) { clearTimeout(timer); bail(m?.error); return; }
                addPop(m.id, m);
                if (++got === Object.keys(POPULATIONS).length) { clearTimeout(timer); w.terminate(); }
            };
            for (const [key, spec] of Object.entries(POPULATIONS)) {
                w.postMessage({ id: key, type: 'population', count: spec.count, species: spec.species });
            }
        } catch (e) {
            console.warn('[ring-current] Workers unavailable, building populations inline:', e);
            buildInline();
        }
    }

    /** Brightness-steer the two ion populations to an O⁺ energy fraction
     *  (writes the uMix uniforms; safe before the buffers have arrived). */
    _setCompositionMix(fO) {
        const f = Math.max(0, Math.min(0.8, Number.isFinite(fO) ? fO : 0.06));
        this._pendingMix = f;
        const setMix = (P, v) => {
            if (!P) return;
            P.mat.uniforms.uMix.value = v;
            for (const e of P.echoes) e.mat.uniforms.uMix.value = v;
        };
        setMix(this._popPoints?.ionsO, Math.min(1.8, f / O_BUILD_FRACTION));
        setMix(this._popPoints?.ionsH, Math.min(1.3, (1 - f) / (1 - O_BUILD_FRACTION)));
        // He⁺ is a minor fixed-fraction accent — not composition-steered.
        setMix(this._popPoints?.ionsHe, 0.85);
    }

    /**
     * Show/hide one trapped population (ionsH / ionsO / electrons) — its main
     * points and its drift-trail echoes (echoes still respect the quality
     * tier). The choice is recorded in `_popVisible` so it survives the async
     * worker build (a toggle set before the buffers arrive is applied on
     * arrival — see addPop).
     */
    setPopulationVisible(key, on) {
        if (!this._popVisible) this._popVisible = {};
        this._popVisible[key] = !!on;
        const P = this._popPoints?.[key];
        if (!P) return;
        P.points.visible = !!on;
        const echoOn = !!on && (this._perf?.tier ?? 0) < 2;
        for (const e of P.echoes) e.points.visible = echoOn;
    }

    /** Static-attribute Points: position=(L, θ_birth, λ_m), kin, life.
     *  Uploaded once; all motion + lifecycle happens in the vertex shader.
     *  `pop` (incl. eKev metadata) is retained for tooltip picking via the
     *  particlePose reference implementation. */
    _makePoints(pop, color, size) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pop.seed, 3));
        geo.setAttribute('kin',      new THREE.BufferAttribute(pop.kin, 3));
        geo.setAttribute('life',     new THREE.BufferAttribute(pop.life, 4));
        const mat = trappedPointsMaterial(size, 0.9, color);
        this._syncStateUniforms(mat);
        const points = new THREE.Points(geo, mat);
        points.frustumCulled = false;   // position attr holds (L,θ,λ_m), not xyz
        this._magGroup.add(points);
        // Integrated drift trails: re-draw the SAME geometry with lagged
        // clocks (tick() sets uDriftHours/uBounceSec back by k·TRAIL_VIEW_S
        // of viewing) — each echo is where every particle truly WAS, so the
        // trail follows its curved drift+bounce path, honors the lifecycle,
        // and collapses at Real ×1. Geometry is shared; cost = 2 extra draws.
        const echoes = [];
        for (let k = 1; k <= RING_TRAIL_ECHOES; k++) {
            const em = trappedPointsMaterial(size * (1 - 0.22 * k), 0.9 * (k === 1 ? 0.38 : 0.16), color);
            this._syncStateUniforms(em);
            const ep = new THREE.Points(geo, em);
            ep.frustumCulled = false;
            ep.visible = (this._perf?.tier ?? 0) < 2;   // quality tier 2 sheds echoes
            this._magGroup.add(ep);
            // baseOp: LOD raises echo opacity with camera distance so the
            // zoomed-out ring reads as a FLOWING river (comet-tail texture).
            echoes.push({ mat: em, k, points: ep, baseOp: 0.9 * (k === 1 ? 0.38 : 0.16) });
        }
        return { points, mat, pop, echoes };
    }

    /** Push the current model state into one material's uniforms. */
    _syncStateUniforms(mat) {
        const u = mat.uniforms;
        u.uDriftHours.value = this._simHours;
        u.uBounceSec.value  = this._tView;
        u.uDstStar.value    = this._state.dstStar;
        u.uAsymAmp.value    = this._state.asym.amplitude;
        u.uAsymMlt.value    = this._state.asym.mltPeakHours;
        u.uInjection.value  = this._state.injection;
        // #917's Dst-coupled visible count: quiet ⇒ thin dim torus, storm ⇒
        // dense. Hidden particles keep evolving (the shader always computes),
        // so a deepening storm reveals a coherent ring, not a fresh scatter.
        const depth = Math.min(1, Math.abs(this._state.dstStar) / 150);
        u.uVisFrac.value = 0.40 + 0.60 * depth;
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

        // Plasmapause, two curves (IONOSPHERE_EXPLORATION_PLAN.md Track 0):
        //   · the GEOMETRY is the last closed equipotential of the SHIELDED
        //     convection + corotation potential — a teardrop with the dusk
        //     bulge, from ring-current-efield.js, rebuilt as A_sh evolves
        //   · the old circular Carpenter–Anderson Lpp(Kp) ring stays as a
        //     faint VALIDATION overlay (the two hugging each other is the
        //     model check, live) — do not delete it in favor of the teardrop.
        this._ppMat = new THREE.MeshBasicMaterial({
            color: 0x59e0d8, transparent: true, opacity: 0.12, depthWrite: false,
        });
        this._plasmapause = new THREE.Mesh(new THREE.TorusGeometry(4.7, 0.018, 8, 160), this._ppMat);
        this._plasmapause.rotation.x = Math.PI / 2;
        this._magGroup.add(this._plasmapause);

        const TEAR_N = 180;
        this._tearPos = new Float32Array(TEAR_N * 3);
        const tearGeo = new THREE.BufferGeometry();
        tearGeo.setAttribute('position', new THREE.BufferAttribute(this._tearPos, 3));
        this._ppTear = new THREE.LineLoop(tearGeo, new THREE.LineBasicMaterial({
            color: 0x59e0d8, transparent: true, opacity: 0.75,
            blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        this._magGroup.add(this._ppTear);
        this._builtAsh = -1;
        this._updateTeardrop(this._efield.state().A_sh);

        // Dipole axis — tilts with the magnetosphere; compare against the
        // white geographic axis to watch the real daily wobble between them.
        this._magGroup.add(axisLine(1.75, 0xff9a3d, 0.45));

        // ENA glow halo — in the dipole group so the emission tilts with
        // the ring it images. Amplitude eases toward its |Dst*| target in
        // tick() (~8 s time constant — an integrating imager, not a lamp).
        this._enaMat = enaHaloMaterial();
        this._enaHalo = new THREE.Mesh(new THREE.RingGeometry(1.3, 5.4, 96, 24), this._enaMat);
        this._enaHalo.rotation.x = Math.PI / 2;
        this._magGroup.add(this._enaHalo);
        this._enaTarget = 0;
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

    /** Refill the teardrop polyline from the efield boundary at amplitude
     *  aSh. Scene mapping: efield φ (0 = noon, +π/2 = dusk) → θ = −φ, so
     *  (x, z) = (L·cosφ, −L·sinφ) — dusk bulge lands on −Z. */
    _updateTeardrop(aSh) {
        if (!(aSh > 0) || Math.abs(aSh - this._builtAsh) < 0.02 * Math.max(0.05, this._builtAsh)) return;
        this._builtAsh = aSh;
        const n = this._tearPos.length / 3;
        for (let i = 0; i < n; i++) {
            const phi = (i / n) * 2 * Math.PI;
            const L = boundaryL(phi, aSh);
            const j = i * 3;
            this._tearPos[j]     = L * Math.cos(phi);
            this._tearPos[j + 1] = 0;
            this._tearPos[j + 2] = -L * Math.sin(phi);
        }
        const attr = this._ppTear.geometry.getAttribute('position');
        attr.needsUpdate = true;
        this._ppTear.geometry.computeBoundingSphere();
    }

    /** Track A render layer (airglow shell + fountain streamlines) plus the
     *  Track B regional-state map — all Earth-fixed (children of the spin
     *  group so the bands snake with the real dip equator under the
     *  terminator, and the WFC map's texels stay geographic). */
    _buildIonosphere() {
        this._cells = new IonosphereCells();
        this._cellsKp = 1;
        this._cellsEpochN = -1;
        this._cellsCrest = new Float32Array(IONO_LON_CELLS);
        this._cellsBubExt = new Float32Array(IONO_LON_CELLS);
        this._ionoLayer = new IonosphereLayer(this._iono, this._cells);
        this._earthSpin.add(this._ionoLayer.group);
    }

    /** Step the field core + fountain kernel on the sim clock and refresh
     *  their visuals. dSimH = 0 while paused, so the shielding ODE, the
     *  fountain, and every pulse cue hold with the rest of the scene. The
     *  WFC cell engine runs on 10-sim-min epochs whose number derives from
     *  ABSOLUTE sim time — a scrub or sweep wrap that revisits an epoch
     *  re-collapses it identically (deterministic RNG per (cell, epoch)). */
    _stepIonosphere(dt, dSimH, simNow) {
        const dSimSec = dSimH * 3600;
        if (dSimSec > 0) {
            this._efield.step(dSimSec);
            this._iono.tick(simNow, dSimSec, { dA: this._efield.state().dA });
        }
        this._updateTeardrop(this._efield.state().A_sh);
        // Track C: the disclosed vertical exaggeration follows the camera
        // (rendering-only — nothing above this line ever sees it).
        const E = exaggeration(this._camera.position.length());
        this._lastExag = E;
        this._ionoLayer.setExaggeration(E);
        this._cageMat.uniforms.uExag.value = E;
        const utH = (simNow / 3.6e6) % 24;
        const epochN = Math.floor(simNow / 600e3);
        if (epochN !== this._cellsEpochN) {
            this._cellsEpochN = epochN;
            // Live fields snapshot: fountain crests per lon; live bubbles
            // binned to their lon cell as a max field-aligned extent.
            for (let i = 0; i < IONO_LON_CELLS; i++) {
                this._cellsCrest[i] = this._iono.cells[i].crest;
                this._cellsBubExt[i] = 0;
            }
            for (const b of this._iono.allBubbles()) {
                const i = Math.max(0, Math.min(IONO_LON_CELLS - 1,
                    Math.floor((b.lonDeg + 180) / (360 / IONO_LON_CELLS))));
                if (b.latExtentDeg > this._cellsBubExt[i]) this._cellsBubExt[i] = b.latExtentDeg;
            }
            this._cells.epoch({
                kp: this._cellsKp, utH,
                crest: this._cellsCrest, bubbleExtent: this._cellsBubExt,
            }, epochN);
            this._ionoLayer.markMapDirty();
        }
        this._ionoLayer.update(dt, dSimSec, this._tView, subsolarPoint(simNow), utH,
            this._camera.position);
    }

    /** Live descent readout for the page HUD — the DISCLOSURE surface:
     *  the exaggeration factor, the TRUE altitude it corresponds to, and
     *  the ground-track speed (×τ gives the apparent rate on screen). */
    descentState() {
        const d = this._camera.position.length();
        const E = this._lastExag ?? 1;
        this._tmpV.copy(this._camera.position);
        this._ionoLayer.group.worldToLocal(this._tmpV);
        const latDeg = Math.asin(Math.max(-1,
            Math.min(1, this._tmpV.y / (this._tmpV.length() || 1)))) * 180 / Math.PI;
        return {
            exag: E,
            engaged: E > 1.05,
            altKmReal: realAltitudeKm(d, E),
            groundKmS: groundSpeedKmS(latDeg),
            tau: this._clock.tau,
            view: this._activeView,
            details: this._ionoLayer.detailActive,
        };
    }

    /**
     * Regional-state inspector: WFC cell under a world-space point on the
     * map shell → { state, maglat, mlt, why } (null off-shell). Exposed for
     * the hover tooltip AND the smoke test — the conversion math is the
     * part worth pinning.
     */
    cellInfoAt(worldPoint) {
        const shell = this._ionoLayer?.mapShell;
        if (!shell || !this._cells) return null;
        const p = shell.worldToLocal(this._tmpV.copy(worldPoint));
        const r = p.length();
        if (r < 1e-6) return null;
        const latDeg = Math.asin(Math.max(-1, Math.min(1, p.y / r))) * 180 / Math.PI;
        const lonDeg = Math.atan2(-p.z, p.x) * 180 / Math.PI;   // coords.js frame
        const maglat = magLatDeg(latDeg, lonDeg);
        const utH = (this._clock.now() / 3.6e6) % 24;
        const mlt = ((utH + lonDeg / 15) % 24 + 24) % 24;
        const i = Math.max(0, Math.min(35, Math.floor((maglat + 90) / 5)));
        const j = Math.max(0, Math.min(23, Math.floor(mlt)));
        const c = i * 24 + j;
        return {
            state: CELL_STATES[this._cells.state[c]],
            maglat, mlt, latDeg, lonDeg,
            why: this._cells.why[c] ?? [],
        };
    }

    _buildSunAndTransit() {
        // Sun: a live solar DISK, not just a glow. The sprite billboards
        // toward the camera, and in this Earth-anchored scene that IS the
        // Earth-facing hemisphere — so Stonyhurst coordinates map straight
        // onto it (disk center = central meridian, west limb right, north
        // up). _drawSunDisk repaints it from each feed state: limb-darkened
        // photosphere, HEK coronal holes rotated to their CURRENT disk
        // positions, and a teal marker at the back-mapped source of the
        // wind arriving now — real imagery timing on the Sun end.
        this._sunCv = document.createElement('canvas');
        this._sunCv.width = this._sunCv.height = 256;
        this._sunTex = new THREE.CanvasTexture(this._sunCv);
        this._drawSunDisk(null);
        this._sunMat = new THREE.SpriteMaterial({
            map: this._sunTex, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.95,
        });
        this._sun = new THREE.Sprite(this._sunMat);
        this._sun.position.set(TRANSIT.X_SUN + 8, 0, 0);
        this._sun.scale.setScalar(11);
        this._scene.add(this._sun);

        // Transit parcel points (positions/colors filled per frame).
        this._streamDensity = 1;   // ×1 | ×2 | ×4 — page control
        const N = TRANSIT.MAX_PARCELS * TRANSIT.PTS_PER * TRANSIT.DENS_MAX;
        this._transitGeo = new THREE.BufferGeometry();
        this._transitPos = new Float32Array(N * 3);
        this._transitCol = new Float32Array(N * 3);
        this._transitGeo.setAttribute('position', new THREE.BufferAttribute(this._transitPos, 3).setUsage(THREE.DynamicDrawUsage));
        this._transitGeo.setAttribute('color',    new THREE.BufferAttribute(this._transitCol, 3).setUsage(THREE.DynamicDrawUsage));
        // Fixed per-slot cluster offsets so parcels keep a stable shape as
        // they advance. FULLY 3D cross-section: a dense core (the corridor
        // axis the labels and barometric trace describe) plus an envelope
        // filling a 15 R_E-radius cylinder — wider than the quiet-time
        // dayside magnetopause flank (~15.5 R_E at the terminator), so each
        // arriving front visibly ENGULFS the magnetosphere the way the real
        // wind does: Earth sits inside the stream, not beside a beam. A
        // 1-min L1 sample IS a plane front — spreading its render across
        // the full cross-section is more faithful than the old narrow jet.
        // Envelope points fade with radius (per-point factor) so the medium
        // reads airy and the core stays hot.
        this._transitOff = new Float32Array(N * 3);
        this._transitEnv = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            const a = Math.random() * 2 * Math.PI;
            const core = Math.random() < 0.55;
            const r = core ? Math.sqrt(Math.random()) * 1.6
                           : 1.6 + 13.4 * Math.random() ** 1.5;
            this._transitOff[i * 3]     = (Math.random() - 0.5) * (core ? 0.9 : 2.6);
            this._transitOff[i * 3 + 1] = Math.sin(a) * r;
            this._transitOff[i * 3 + 2] = Math.cos(a) * r;
            this._transitEnv[i] = core ? 1 : 0.55 - 0.25 * (r / 15);
        }
        // Reusable wind-profile sample pool: _updateTransit fills these IN
        // PLACE every frame. The old per-frame object literals were a
        // steady GC source (≈120 allocations × 60 fps) — collector pauses
        // read as stutter. Pool + in-place insertion sort = zero per-frame
        // allocation on this path.
        this._wsPool = Array.from({ length: TRANSIT.MAX_PARCELS },
            () => ({ x: 0, nNorm: 0, R: 0, G: 0, B: 0, south: 0, vNorm: 0 }));
        const mat = glowPointsMaterial(0.22, 0.95);   // brighter, fatter parcels
        this._transit = new THREE.Points(this._transitGeo, mat);
        this._transit.frustumCulled = false;
        this._scene.add(this._transit);
        this._streamMode = 'bz';

        // Solar-wind sheet: an open flux tube spanning the corridor, shaded
        // per-fragment from the live 128-bin parcel profile (see
        // windSheetMaterial). FLARED toward Earth (3.4 → 15.5 R_E) to match
        // the volumetric stream cross-section: the medium widens around the
        // obstacle like flow past a blunt body, and the magnetosphere ends
        // up INSIDE the wind's silhouette — encompassed, as it really is.
        this._windBins = 128;
        this._windData = new Uint8Array(this._windBins * 4);
        this._windTex = new THREE.DataTexture(this._windData, this._windBins, 1, THREE.RGBAFormat);
        this._windTex.magFilter = THREE.LinearFilter;
        this._windTex.minFilter = THREE.LinearFilter;
        this._windMat = windSheetMaterial(this._windTex);
        const tube = new THREE.CylinderGeometry(3.4, 15.5, SCALE.CORRIDOR.SPAN, 40, 64, true);
        tube.rotateZ(-Math.PI / 2);   // cylinder +Y axis → +X (sunward)
        tube.translate((TRANSIT.X_MP + TRANSIT.X_SUN) / 2, 0, 0);
        this._windSheet = new THREE.Mesh(tube, this._windMat);
        this._windSheet.frustumCulled = false;
        this._scene.add(this._windSheet);
        this._sunVbsNorm = 0;   // strongest incoming VBs (0..1) — Sun breathing

        // ── L1 measurement plane + spacecraft (see l1GateMaterial) ──────────
        // The gate disc sits exactly at the corridor start: x = X_SUN IS L1
        // under the corridor's disclosed compression (SCALE.CORRIDOR maps
        // L1→magnetopause onto X_SUN→X_MP). Radius spans the volumetric
        // stream envelope. Pulse trigger lives in setState (new sample).
        const GATE_R = 16.5;
        this._gateMat = l1GateMaterial(GATE_R);
        const gate = new THREE.Mesh(new THREE.CircleGeometry(GATE_R, 72), this._gateMat);
        gate.rotateY(Math.PI / 2);              // disc normal down the corridor
        gate.position.set(TRANSIT.X_SUN, 0, 0);
        gate.frustumCulled = false;
        this._scene.add(gate);
        // Spacecraft marker: real L1 monitors fly Lissajous/halo orbits of
        // ~150 000 km semi-axis (≈ 4 corridor units — drawn at that scale)
        // with ~6-month periods; the period here is compressed to stay
        // perceptible (a labeled rendering cue, like the parcel heartbeat).
        const cCv = document.createElement('canvas');
        cCv.width = cCv.height = 32;
        const cg = cCv.getContext('2d');
        const cGrad = cg.createRadialGradient(16, 16, 0, 16, 16, 16);
        cGrad.addColorStop(0, 'rgba(230,242,255,1)');
        cGrad.addColorStop(0.35, 'rgba(160,200,255,0.8)');
        cGrad.addColorStop(1, 'rgba(120,170,255,0)');
        cg.fillStyle = cGrad;
        cg.fillRect(0, 0, 32, 32);
        this._l1Craft = new THREE.Sprite(new THREE.SpriteMaterial({
            map: new THREE.CanvasTexture(cCv), blending: THREE.AdditiveBlending,
            depthWrite: false, opacity: 0.95,
        }));
        this._l1Craft.scale.setScalar(0.9);
        this._l1Craft.position.set(TRANSIT.X_SUN, 2.5, 2.5);
        this._scene.add(this._l1Craft);
        this._lastSampleTL1 = 0;

        // ── Solar-origin emission — the journey's TRUE start ────────────────
        // The Sun→L1 leg is UNMEASURED (plasma is only sampled at the gate)
        // and drawn ≈2 900× more compressed than near-Earth (1.47×10⁸ km in
        // 8 scene units), so honest motion here is near-stillness: the leg
        // takes days at any τ. What CAN be shown honestly is the source's
        // emission ACTIVITY: puffs born at the back-mapped source region
        // (and the visible coronal holes) at a cadence tied to the LIVE
        // measured flux — n·v of the wind arriving now is what this source
        // was emitting when that plasma left, per the ledger. Bulk drift is
        // the honest crawl; the swell-and-fade is a rendering cue (same
        // rule as arrival flashes). The gap label discloses all of it.
        const EMIT_N = 240;
        this._emGeo = new THREE.BufferGeometry();
        this._emPos = new Float32Array(EMIT_N * 3);
        this._emCol = new Float32Array(EMIT_N * 3);
        this._emGeo.setAttribute('position', new THREE.BufferAttribute(this._emPos, 3).setUsage(THREE.DynamicDrawUsage));
        this._emGeo.setAttribute('color',    new THREE.BufferAttribute(this._emCol, 3).setUsage(THREE.DynamicDrawUsage));
        this._emPts = new THREE.Points(this._emGeo, glowPointsMaterial(0.14, 0.85));
        this._emPts.frustumCulled = false;
        this._scene.add(this._emPts);
        this._em = {
            mode: new Uint8Array(EMIT_N),
            x: new Float32Array(EMIT_N), y: new Float32Array(EMIT_N), z: new Float32Array(EMIT_N),
            age: new Float32Array(EMIT_N), life: new Float32Array(EMIT_N),
            warm: new Float32Array(EMIT_N),
            vKm:  new Float32Array(EMIT_N),   // per-puff speed = its hole's record
        };
        this._diskHoleW = 0;
        this._emCursor = 0;
        this._emAccum = 0;
        this._srcDisk = null;      // back-mapped source on the disk (setState)
        this._diskHoles = [];      // visible CHs in disk coords (setState)
        this._driverV = 400;
        this._driverN = 3;

        // Parker-spiral streamline: the garden-hose connection from the
        // source region to the L1 gate. SCHEMATIC at this compression (the
        // real spiral wraps 40–60° of longitude); curvature direction and
        // magnitude from the live spiral angle. Rebuilt each feed state.
        this._spiralPos = new Float32Array(25 * 3);
        this._spiralGeo = new THREE.BufferGeometry();
        this._spiralGeo.setAttribute('position', new THREE.BufferAttribute(this._spiralPos, 3).setUsage(THREE.DynamicDrawUsage));
        this._spiral = new THREE.Line(this._spiralGeo, new THREE.LineBasicMaterial({
            color: 0x7fe6c3, transparent: true, opacity: 0.28,
            blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        this._spiral.frustumCulled = false;
        this._spiral.visible = false;   // until the first source fix
        this._scene.add(this._spiral);

        // ── In-flight CME fronts (DONKI cone analyses) ──────────────────────
        // Matter genuinely between the Sun and Earth RIGHT NOW: each
        // Earth-relevant cone renders as an expanding annular front
        // crossing the helio gap at its ballistic fraction (evaluated at
        // simNow — honest, hence near-motionless: transits take days).
        // Flank-directed cones slide off-axis; the label carries the
        // ballistic ETA ± band. Pool of 4 (Earth-directed CMEs in flight
        // at once are rare above that).
        this._cmePool = [];
        for (let i = 0; i < 4; i++) {
            const mat = new THREE.MeshBasicMaterial({
                color: 0xffc890, transparent: true, opacity: 0,
                blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(new THREE.RingGeometry(0.78, 1.0, 56), mat);
            mesh.rotation.y = Math.PI / 2;       // face down the corridor axis
            mesh.visible = false;
            mesh.frustumCulled = false;
            this._scene.add(mesh);
            const lab = this._makeLabel(0, 0, 0, 6.5);
            lab.sp.visible = false;
            this._cmePool.push({ mesh, mat, lab, cme: null });
        }
        this._cmesLive = [];

        // Barometric trace: n(x) as a polyline riding above the corridor —
        // the pressure-wave shape of the incoming wind, sliding Earthward in
        // real time as the plasma it describes actually approaches.
        this._waveN = TRANSIT.MAX_PARCELS;
        this._wavePos = new Float32Array(this._waveN * 3);
        this._waveGeo = new THREE.BufferGeometry();
        this._waveGeo.setAttribute('position', new THREE.BufferAttribute(this._wavePos, 3).setUsage(THREE.DynamicDrawUsage));
        this._wave = new THREE.Line(this._waveGeo, new THREE.LineBasicMaterial({
            color: 0x7fe6c3, transparent: true, opacity: 0.9,
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
        this._env = new THREE.Points(this._envGeo, glowPointsMaterial(0.13, 0.75));
        this._env.frustumCulled = false;
        this._scene.add(this._env);
        const base = new Float32Array([TRANSIT.X_MP, TRANSIT.WAVE_Y, 0, TRANSIT.X_SUN, TRANSIT.WAVE_Y, 0]);
        const baseGeo = new THREE.BufferGeometry();
        baseGeo.setAttribute('position', new THREE.BufferAttribute(base, 3));
        this._scene.add(new THREE.Line(baseGeo, new THREE.LineBasicMaterial({
            color: 0x5f79b8, transparent: true, opacity: 0.25, depthWrite: false,
        })));
    }

    /**
     * Repaint the Sun sprite from the feed's sunLag ledger: corona glow,
     * limb-darkened photosphere, HEK coronal holes at TODAY's Stonyhurst
     * positions (catalog Carrington lon − live L0; dark, as they appear in
     * EUV), and the back-mapped source marker of the wind arriving now —
     * a teal ring that has rotated stonyhurstNowDeg toward the west limb
     * since the plasma left (dashed once it passes behind the limb). A few
     * dozen 2D calls per feed state (~30 s) — negligible.
     */
    _drawSunDisk(sl) {
        const g = this._sunCv.getContext('2d');
        const C = 128, R = 46;                       // center, disk radius (px)
        const d2r = Math.PI / 180;
        g.clearRect(0, 0, 256, 256);
        // Corona glow out to the sprite edge.
        let grad = g.createRadialGradient(C, C, R * 0.75, C, C, 128);
        grad.addColorStop(0.00, 'rgba(255,214,120,0.85)');
        grad.addColorStop(0.35, 'rgba(255,150,60,0.25)');
        grad.addColorStop(1.00, 'rgba(255,120,40,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 256, 256);
        // Photosphere with limb darkening.
        grad = g.createRadialGradient(C, C, 0, C, C, R);
        grad.addColorStop(0.00, 'rgba(255,248,226,1)');
        grad.addColorStop(0.72, 'rgba(255,226,150,0.98)');
        grad.addColorStop(1.00, 'rgba(255,170,80,0.9)');
        g.fillStyle = grad;
        g.beginPath();
        g.arc(C, C, R, 0, 2 * Math.PI);
        g.fill();
        // Coronal holes on today's visible disk (clipped to the limb).
        // Holes whose recurrence forecast puts a stream at Earth within
        // 5 days get an amber ring — the disk shows tomorrow's weather.
        const l0 = sl?.l0NowDeg;
        if (Number.isFinite(l0)) {
            const soon = new Set((sl.recurrence ?? [])
                .filter(f => f.forecast?.daysToArrival < 5)
                .map(f => Math.round(f.lon_carrington_deg)));
            g.save();
            g.beginPath();
            g.arc(C, C, R, 0, 2 * Math.PI);
            g.clip();
            for (const h of sl.holes ?? []) {
                if (!Number.isFinite(h?.lon_carrington_deg)) continue;
                const lon = ((h.lon_carrington_deg - l0) % 360 + 540) % 360 - 180;
                const lat = h.lat_deg ?? 0;
                if (Math.abs(lon) > 85 || Math.abs(lat) > 80) continue;   // far side
                const x = C + R * Math.sin(lon * d2r) * Math.cos(lat * d2r);
                const y = C - R * Math.sin(lat * d2r);
                const rx = Math.max(3, 9 * Math.abs(Math.cos(lon * d2r)));
                const ry = Math.max(3, 9 * Math.abs(Math.cos(lat * d2r)));
                g.fillStyle = 'rgba(30,18,52,0.72)';
                g.beginPath();
                g.ellipse(x, y, rx, ry, 0, 0, 2 * Math.PI);
                g.fill();
                if (soon.has(Math.round(h.lon_carrington_deg))) {
                    g.strokeStyle = 'rgba(255,210,122,0.6)';
                    g.lineWidth = 1.5;
                    g.beginPath();
                    g.ellipse(x, y, rx + 3, ry + 3, 0, 0, 2 * Math.PI);
                    g.stroke();
                }
            }
            g.restore();
        }
        // Back-mapped source of the wind arriving NOW.
        const west = sl?.stonyhurstNowDeg;
        if (Number.isFinite(west)) {
            const lat = sl?.source?.hole?.lat_deg ?? 0;
            const lon = Math.min(west, 88);
            const x = C + R * Math.sin(lon * d2r) * Math.cos(lat * d2r);
            const y = C - R * Math.sin(lat * d2r);
            g.strokeStyle = '#7fe6c3';
            g.lineWidth = 2;
            if (west > 88) g.setLineDash([3, 3]);    // already behind the limb
            g.beginPath();
            g.arc(x, y, 7, 0, 2 * Math.PI);
            g.stroke();
            g.setLineDash([]);
            g.beginPath();
            for (const [dx, dy] of [[10, 0], [-10, 0], [0, 10], [0, -10]]) {
                g.moveTo(x + dx * 0.5, y + dy * 0.5);
                g.lineTo(x + dx, y + dy);
            }
            g.stroke();
        }
        this._sunTex.needsUpdate = true;
    }

    /** The named view last selected via setView ('earth'|'sun'|'river').
     *  Free orbiting after a preset does NOT clear this — it names the
     *  starting point, not the live pose (the page dims its buttons on
     *  user grab instead). */
    get view() { return this._activeView; }

    /** Preset names, for UIs that want to enumerate them. */
    static get VIEWS() { return Object.keys(CAM_VIEWS); }

    /**
     * Fly the camera to a named default view ('earth' | 'sun' | 'river').
     * Eased flight of position + orbit target over ~1.6 s; instant under
     * prefers-reduced-motion or {instant:true}. Returns false on an
     * unknown name so callers can validate persisted values.
     */
    setView(name, { instant = false, anchorWorldDir = null } = {}) {
        // 'surface' (Track C) is DYNAMIC, not a CAM_VIEWS pose: glide
        // straight down over the current sub-point — or a tapped WFC
        // cell's direction — to drawn r = 1.42, which at full ×18
        // exaggeration is ~150 km TRUE altitude, between the E and F
        // shells. The orbit target stays the ORIGIN: navigation at the
        // bottom is a low orbit (controls.minDistance is the altitude
        // floor), and zooming back out ascends the same continuous path.
        if (name === 'surface') {
            const cur = this._camera.position.clone().normalize();
            const dir = (anchorWorldDir ? anchorWorldDir.clone() : cur.clone()).normalize();
            // Arrive ~20° off the anchor, tilted back toward the approach
            // side: the tapped region then stands mid-frame against the
            // horizon (curtains in profile, limb flattening visible)
            // instead of a featureless nadir patch.
            let axis = new THREE.Vector3().crossVectors(dir, cur);
            if (axis.lengthSq() < 1e-6) {
                axis.set(0, 1, 0).cross(dir);
                if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
            }
            dir.applyQuaternion(new THREE.Quaternion()
                .setFromAxisAngle(axis.normalize(), 0.35));
            this._activeView = 'surface';
            const p1 = dir.multiplyScalar(1.42);
            const t1 = new THREE.Vector3(0, 0, 0);
            if (instant || this._reducedMotion) {
                this._flight = null;
                this._camera.position.copy(p1);
                this._controls.target.copy(t1);
                this._controls.update();
                return true;
            }
            this._flight = {
                t: 0, dur: 2.0,
                p0: this._camera.position.clone(), p1,
                t0: this._controls.target.clone(), t1,
            };
            return true;
        }
        const v = CAM_VIEWS[name];
        if (!v) return false;
        this._activeView = name;
        const p1 = new THREE.Vector3(...v.pos);
        const t1 = new THREE.Vector3(...v.target);
        if (instant || this._reducedMotion) {
            this._flight = null;
            this._camera.position.copy(p1);
            this._controls.target.copy(t1);
            this._controls.update();
            return true;
        }
        this._flight = {
            t: 0, dur: 1.6,
            p0: this._camera.position.clone(), p1,
            t0: this._controls.target.clone(), t1,
        };
        return true;
    }

    /** Stream coloring: 'bz' (driver) | 'temp' (heat map) | 'density'. */
    setStreamMode(mode) {
        this._streamMode = mode === 'temp' || mode === 'density' ? mode : 'bz';
    }

    /** Stream density ×1/×2/×4 — a VISUAL multiplier on rendered points per
     *  1-min L1 sample (and on injection-burst counts). More pixels, never
     *  more data: parcel count, positions, and physics are untouched. */
    setStreamDensity(x) {
        this._streamDensity = [1, 2, 4].includes(x) ? x : 1;
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

    /** Corridor rendering, all on the SimClock (#917): each parcel sits at
     *  the fraction of its OWN L1→Earth transit elapsed at simTime, so its
     *  apparent speed = measured km/s × τ ÷ SCALE.CORRIDOR.kmPerUnit —
     *  faster parcels visibly overtake slower ones (real stream
     *  interaction). Evaluated every frame; at τ=1 this is true real time
     *  and parcels vanish exactly when their plasma reaches Earth. */
    _updateTransit(simNow, wallNow) {
        const tau = this._clock.tau;
        // The corridor's Earth-end is the LIVE Shue nose — under a pressure
        // pulse the whole stream visibly reaches deeper before coupling.
        const xmp = this._mpR0 + 0.4;
        const spanX = TRANSIT.X_SUN - xmp;
        const pos = this._transitPos, col = this._transitCol, off = this._transitOff;
        // Heartbeat: parcels pulse on their 1-min sample cadence (wall time —
        // it's live instrumentation, not physics). Prominent in Real mode.
        const hbAmp = tau === 1 ? 0.22 : 0.07;
        let slot = 0;
        const ws = this._wsPool;   // pooled samples, filled in place; wsN live
        let wsN = 0;
        this._slotParcel = this._slotParcel || [];
        this._slotParcel.length = 0;
        for (const p of this._parcels) {
            if (slot >= TRANSIT.MAX_PARCELS) break;
            const dur = p.tArrive - p.tL1;              // real transit ms at measured v
            if (!(dur > 0) || dur > 3 * 3.6e6) continue;
            const remain = p.tArrive - simNow;
            if (remain <= 0) continue;                   // arrived (in sim) — see flashes
            const f = Math.min(1, remain / dur);         // 1 = just left L1, 0 = arriving
            const x = xmp + f * spanX;
            const nNorm = Math.max(0, Math.min(1, (Number.isFinite(p.n) ? p.n : 3) / TRANSIT.N_REF));
            const [R, G, B] = streamColor(this._streamMode, p);
            const pdyn = dynamicPressure(p.n, p.v);
            let bright = 0.45 + 0.75 * Math.min(1, (pdyn ?? 1.5) / 8);
            bright *= 1 + hbAmp * Math.cos(2 * Math.PI * ((wallNow - (p.tL1 ?? 0)) % 60_000) / 60_000);
            if (tau === 1) {
                // Flow-field pulse (Real mode only): a brightness wave sliding
                // Earthward at an INDICATOR speed — positions stay true, the
                // pulse only conveys direction while honest motion is sub-pixel.
                bright *= 1 + 0.30 * Math.sin(2 * Math.PI * (x / 9 + wallNow / 3000));
            }
            // Trail = the path integrated over the last TRAIL_VIEW_S seconds
            // of viewing (apparent speed × window; invariant km/s × τ ÷
            // km/unit) — fast parcels streak further because they truly
            // covered more corridor; sub-pixel at τ=1.
            const trail = Math.min(9, Math.max(0.1,
                TRAIL_VIEW_S * apparentUnitsPerSec(Number.isFinite(p.v) ? p.v : 400, SCALE.CORRIDOR.kmPerUnit, tau)));
            // BAROMETRIC compression: visible particle count per 1-min sample
            // scales with density — compression fronts read as dense bright
            // bands, exactly like a longitudinal pressure wave.
            const stride = TRANSIT.PTS_PER * TRANSIT.DENS_MAX;
            const visible = Math.min(stride,
                (3 + Math.round((TRANSIT.PTS_PER - 3) * nNorm)) * this._streamDensity);
            for (let k = 0; k < stride; k++) {
                const j = (slot * stride + k) * 3;
                if (k < visible) {
                    // Motion is toward −x, so the trail extends sunward (+x),
                    // fading toward its tip. Envelope points (wide cross-
                    // section) carry their radial fade.
                    const tFrac = visible > 1 ? k / (visible - 1) : 0;
                    // Comet-filament taper: the sunward trail draws IN toward
                    // the flow axis as it recedes, so each parcel reads as a
                    // streak pointing Earthward instead of a static fuzzy
                    // cylinder. The Earthward head (tFrac→0) keeps the full
                    // engulfing cross-section — Earth still sits inside the
                    // front, only the receding tail narrows.
                    const taper = 1 - 0.5 * tFrac;
                    // Head glow: the leading (Earthward) edge runs a touch
                    // hotter than the tail, reinforcing the flow direction.
                    const fade = (1 - 0.62 * tFrac) * this._transitEnv[slot * stride + k]
                                 * (1 + 0.22 * (1 - tFrac));
                    pos[j]     = x + off[j] * 0.5 + tFrac * trail;
                    pos[j + 1] = off[j + 1] * taper;
                    pos[j + 2] = off[j + 2] * taper;
                    col[j]     = R * bright * fade;
                    col[j + 1] = G * bright * fade;
                    col[j + 2] = B * bright * fade;
                } else {
                    pos[j] = pos[j + 1] = pos[j + 2] = 0;
                    col[j] = col[j + 1] = col[j + 2] = 0;
                }
            }
            this._slotParcel[slot] = p;   // hover tooltip lookup
            const s = ws[wsN++];
            s.x = x; s.nNorm = nNorm; s.R = R; s.G = G; s.B = B;
            // Wind-sheet profile channels: Bz southness (−15 nT → 1,
            // +15 → 0) and speed norm for local wave advection.
            s.south = Math.max(0, Math.min(1, 0.5 - (Number.isFinite(p.bz) ? p.bz : 0) / 30));
            s.vNorm = Math.max(0, Math.min(1, ((Number.isFinite(p.v) ? p.v : 400) - 250) / 650));
            slot++;
        }
        // ── Wind-sheet profile: splat the parcels into the 128-bin texture
        //    (max-blend, ±2-bin tent) — the shader turns this into the
        //    glowing medium with waves, fronts, and Bz coloring. ────────────
        const bins = this._windBins, wd = this._windData;
        wd.fill(0);
        let vSum = 0;
        for (let si = 0; si < wsN; si++) {
            const s = ws[si];
            vSum += s.vNorm;
            const c = Math.round(((s.x - xmp) / spanX) * (bins - 1));
            for (let b = Math.max(0, c - 2); b <= Math.min(bins - 1, c + 2); b++) {
                const w = 1 - Math.abs(b - c) / 3;
                const o = b * 4;
                wd[o]     = Math.max(wd[o],     Math.round(255 * s.nNorm * w));
                wd[o + 1] = Math.max(wd[o + 1], Math.round(255 * s.south * w));
                wd[o + 2] = Math.max(wd[o + 2], Math.round(255 * s.vNorm * w));
                wd[o + 3] = Math.max(wd[o + 3], Math.round(235 * w));
            }
        }
        this._windTex.needsUpdate = true;
        // Advance the wave phase at the mean τ-scaled apparent speed (the
        // same invariant the trails use) so the sheet's waves sweep
        // Earthward at an honest rate — near-frozen at ×1, rolling at ×300.
        const meanV = wsN ? 250 + 650 * (vSum / wsN) : 400;
        this._windMat.uniforms.uFlow.value =
            (this._windMat.uniforms.uFlow.value +
             (this._lastDt ?? 0.016) * apparentUnitsPerSec(meanV, SCALE.CORRIDOR.kmPerUnit, tau) * 2.4)
            % (Math.PI * 2000);
        this._windMat.uniforms.uTime.value = wallNow / 1000 % 3600;
        // Barometric trace + envelope, x-sorted (overtaking can reorder
        // parcels relative to arrival order — the trace is n(x), not n(t)).
        // In-place insertion sort of the first wsN pool entries: near-sorted
        // input each frame, zero allocation (Array.sort allocates).
        for (let si = 1; si < wsN; si++) {
            const s = ws[si];
            let k2 = si - 1;
            while (k2 >= 0 && ws[k2].x > s.x) { ws[k2 + 1] = ws[k2]; k2--; }
            ws[k2 + 1] = s;
        }
        let wi = 0;
        for (let si = 0; si < wsN; si++) {
            const s = ws[si];
            const w = wi * 3;
            this._wavePos[w]     = s.x;
            this._wavePos[w + 1] = TRANSIT.WAVE_Y + TRANSIT.WAVE_AMP * s.nNorm;
            this._wavePos[w + 2] = 0;
            // 3D envelope ring at this sample — the wave revolved around the
            // corridor axis (radius ∝ density), slowly rotating for depth.
            const rad = 1.0 + 2.6 * s.nNorm;
            const spin = wallNow / 9000;
            for (let k = 0; k < this._envSeg; k++) {
                const a = spin + (k / this._envSeg) * 2 * Math.PI;
                const e = (wi * this._envSeg + k) * 3;
                this._envPos[e]     = s.x;
                this._envPos[e + 1] = Math.sin(a) * rad;
                this._envPos[e + 2] = Math.cos(a) * rad;
                this._envCol[e]     = s.R * 0.5;
                this._envCol[e + 1] = s.G * 0.5;
                this._envCol[e + 2] = s.B * 0.5;
            }
            wi++;
        }
        // Park unused envelope rings.
        for (let s = wi * this._envSeg; s < TRANSIT.MAX_PARCELS * this._envSeg; s++) {
            this._envPos[s * 3] = this._envPos[s * 3 + 1] = this._envPos[s * 3 + 2] = 0;
            this._envCol[s * 3] = this._envCol[s * 3 + 1] = this._envCol[s * 3 + 2] = 0;
        }
        this._envGeo.attributes.position.needsUpdate = true;
        this._envGeo.attributes.color.needsUpdate = true;
        // Park unused point slots (black under additive = invisible).
        const strideAll = TRANSIT.PTS_PER * TRANSIT.DENS_MAX;
        for (let s = slot * strideAll; s < TRANSIT.MAX_PARCELS * strideAll; s++) {
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

    // ── Boundaries (Shue 1998) + the magnetosheath river ────────────────────

    /** Magnetopause + bow shock as live-deforming Shue surfaces, and the
     *  sheath-tracer pool: arriving parcels DEFLECT and stream around the
     *  boundary like a river around a boulder — slow at the nose,
     *  accelerating along the flanks, fading tailward. Axisymmetric about
     *  GSM X by construction, so they live at scene root (no dipole tilt). */
    _buildBoundaries() {
        this._mpR0 = 10.2;      // eased live values (Shue standoff, flaring)
        this._mpAlpha = 0.6;
        this._mpTarget = { r0: 10.2, alpha: 0.6 };
        this._mpMat = boundaryMaterial(0x7fb4ff, 0.10, 1.0);
        this._mpMesh = new THREE.Mesh(boundaryGrid(2.0, 30, 44), this._mpMat);
        this._mpMesh.frustumCulled = false;
        this._scene.add(this._mpMesh);
        // Bow shock: upstream, wider flaring, fainter, teal. Dayside only —
        // its tail is off-story here.
        this._bsMat = boundaryMaterial(0x59e0d8, 0.055, 1.29);
        this._bsMesh = new THREE.Mesh(boundaryGrid(1.35, 20, 44), this._bsMat);
        this._bsMesh.frustumCulled = false;
        this._scene.add(this._bsMesh);

        // Sheath river tracers.
        const N = 700;
        this._shGeo = new THREE.BufferGeometry();
        this._shPos = new Float32Array(N * 3);
        this._shCol = new Float32Array(N * 3);
        this._shGeo.setAttribute('position', new THREE.BufferAttribute(this._shPos, 3).setUsage(THREE.DynamicDrawUsage));
        this._shGeo.setAttribute('color',    new THREE.BufferAttribute(this._shCol, 3).setUsage(THREE.DynamicDrawUsage));
        this._shPts = new THREE.Points(this._shGeo, glowPointsMaterial(0.13, 0.9));
        this._shPts.frustumCulled = false;
        this._scene.add(this._shPts);
        this._sh = {
            mode:  new Uint8Array(N),      // 0 free · 1 sheath flank flow · 2 tail return
            th:    new Float32Array(N),    // solar-zenith angle along the surface
            ph:    new Float32Array(N),    // azimuth around the Sun–Earth axis
            jit:   new Float32Array(N),    // standoff offset (sheath thickness)
            vKm:   new Float32Array(N),    // parcel's measured speed
            south: new Uint8Array(N),
            nN:    new Float32Array(N),
            age:   new Float32Array(N),
            vbs:   new Float32Array(N),    // parcel's VBs — tail-entry gate + return speed
            px:    new Float32Array(N),    // stage-2 cartesian state (scene units)
            py:    new Float32Array(N),
            pz:    new Float32Array(N),
        };
        this._shCursor = 0;
        this._tailHandoffs = 0;   // journey closures: tail tracers reaching midnight

        // Plasma-sheet return-flow sheet (the tail leg as a medium — see
        // tailSheetMaterial). Scene root, like the stage-2 tracers riding it:
        // both approximate the sheet as the GSM equatorial plane, so they
        // stay coplanar under dipole tilt.
        this._tailMat = tailSheetMaterial();
        const sheetGeo = new THREE.PlaneGeometry(19.5, 17, 48, 20);
        sheetGeo.rotateX(-Math.PI / 2);       // XY plane → XZ (equatorial)
        sheetGeo.translate(-16.25, 0, 0);     // spans x ∈ [−26, −6.5], |z| ≤ 8.5
        this._tailSheet = new THREE.Mesh(sheetGeo, this._tailMat);
        this._tailSheet.frustumCulled = false;
        this._scene.add(this._tailSheet);
        this._driverVbs = 0;   // live upstream VBs (setState) — feeds the gate
    }

    /** Most of an arriving parcel becomes sheath flow — spawn its tracers.
     *  No τ down-scaling (unlike injections): tracer flight time is honest
     *  (~4 real minutes of sheath transit ⇒ ~0.8 s at ×300), so the pool
     *  self-limits and the river stays visibly fed at high compression. */
    _spawnSheath(p, vbs) {
        const sh = this._sh;
        const count = 3 + 3 * (this._streamDensity ?? 1);
        for (let c = 0; c < count; c++) {
            let i = -1;
            for (let probe = 0; probe < sh.mode.length; probe++) {
                const j = (this._shCursor + probe) % sh.mode.length;
                if (sh.mode[j] === 0) { i = j; this._shCursor = j + 1; break; }
            }
            if (i < 0) return;
            sh.mode[i]  = 1;
            sh.th[i]    = 0.10 + Math.random() * 0.30;
            sh.ph[i]    = Math.random() * 2 * Math.PI;
            sh.jit[i]   = 1.06 + Math.random() * 0.10;   // just OUTSIDE the boundary
            sh.vKm[i]   = Number.isFinite(p.v) ? p.v : 400;
            sh.south[i] = Number.isFinite(p.bz) && p.bz < 0 ? 1 : 0;
            sh.nN[i]    = Math.max(0.15, Math.min(1, (Number.isFinite(p.n) ? p.n : 3) / TRANSIT.N_REF));
            sh.age[i]   = 0;
            sh.vbs[i]   = Number.isFinite(vbs) ? vbs : 0;
        }
    }

    /** Advance the river and its tail-return leg — the journey's last
     *  rendered gap, closed.
     *
     *  Stage 1 (sheath flank flow): dθ/dt = v_apparent·flowFactor / r(θ),
     *  Spreiter-like — stagnant at the nose, ~90% of wind speed by the
     *  flanks. At the end of the rendered flank (θ > 2.05) the plasma
     *  FORKS on a VBs gate: southward IMF drives flank/distant-neutral-
     *  line reconnection that feeds a fraction into the tail (→ stage 2);
     *  the rest streams past downstream and leaves the story.
     *
     *  Stage 2 (tail return convection): the tracer keeps streaming
     *  antisunward while the entry inflow (~60 km/s) reels it toward the
     *  tail axis; once inside the tail (lateral < 8.5 Rᴇ) it is captured
     *  into the flapping plasma sheet and E×B-convects EARTHWARD at
     *  v = E/B ≈ 25·(VBs/2) km/s (cross-tail field ~0.2–2 mV/m over
     *  B ~10–20 nT ⇒ tens of km/s; ~½–3 h from −20 Rᴇ — the substorm
     *  growth-phase timescale). Reaching the injection region near
     *  midnight it HANDS OFF as a mini injection burst: the same matter,
     *  Sun → L1 → sheath → tail → injection. Tracers that pass x < −26 Rᴇ
     *  are lost downtail (plasmoid release). Bulk motion is τ-honest via
     *  the one-clock invariant (crawls at ×1, courses at ×300); only the
     *  sheet-capture fine structure (flapping, midnight funneling) is a
     *  wall-time rendering cue.
     */
    _updateSheath(dt) {
        const sh = this._sh;
        const pos = this._shPos, col = this._shCol;
        const vScale = this._clock.tau / SCALE.NEAR_EARTH.kmPerUnit;   // km/s → units/s
        const rHand  = Math.max(6.8, this._state.plasmapauseL + 2.2);  // injection inner edge
        const kSheet = 1 - Math.exp(-dt / 2.8);   // sheet-capture ease (rendering cue)
        const kMid   = 1 - Math.exp(-dt / 4.0);   // midnight funneling (rendering cue)
        for (let i = 0; i < sh.mode.length; i++) {
            const j = i * 3;
            if (sh.mode[i] === 1) {
                sh.age[i] += dt;
                const th = sh.th[i];
                const r = shueRadiusRe(th, this._mpR0, this._mpAlpha) * sh.jit[i];
                const flow = 0.22 + 0.68 * Math.min(1, th / 1.5);   // nose-stagnant → flank-fast
                sh.th[i] += (sh.vKm[i] * vScale * flow / Math.max(2, r)) * dt;
                if (sh.th[i] > 2.05 || sh.age[i] > 40) {
                    const pEnter = sh.south[i]
                        ? Math.min(0.9, 0.35 + 0.12 * sh.vbs[i]) : 0.06;
                    if (sh.th[i] > 2.05 && Math.random() < pEnter) {
                        // Fork taken: hand the surface point to stage 2.
                        const r2 = shueRadiusRe(sh.th[i], this._mpR0, this._mpAlpha) * sh.jit[i];
                        const st2 = Math.sin(sh.th[i]);
                        sh.mode[i] = 2;
                        sh.px[i] = r2 * Math.cos(sh.th[i]);
                        sh.py[i] = r2 * st2 * Math.sin(sh.ph[i]);
                        sh.pz[i] = r2 * st2 * Math.cos(sh.ph[i]);
                        sh.age[i] = 0;
                    } else {
                        sh.mode[i] = 0;
                    }
                }
            }
            if (sh.mode[i] === 2) {
                sh.age[i] += dt;
                const lat = Math.hypot(sh.py[i], sh.pz[i]);
                if (lat > 8.5) {
                    // Entry: still antisunward with the sheath while the
                    // reconnection inflow (~60 km/s) reels it tailward-in.
                    sh.px[i] -= sh.vKm[i] * 0.15 * vScale * dt;
                    const shrink = Math.max(0, lat - 60 * vScale * dt) / Math.max(1e-6, lat);
                    sh.py[i] *= shrink;
                    sh.pz[i] *= shrink;
                } else {
                    // Captured: Earthward E×B return flow, VBs-scaled.
                    const vE = 25 * Math.max(0.3, Math.min(3, sh.vbs[i] / 2));   // km/s
                    sh.px[i] += vE * vScale * dt;
                    const flap = Math.sin(this._tView * 0.4 + sh.ph[i] * 3.0) * 0.7;
                    sh.py[i] += (flap - sh.py[i]) * kSheet;
                    sh.pz[i] -= sh.pz[i] * kMid;
                    const rNow = Math.hypot(sh.px[i], sh.py[i], sh.pz[i]);
                    if (rNow < rHand && sh.px[i] < 0) {
                        // ── HANDOFF: the tail leg closes at midnight — the
                        // same matter becomes a (mini) injection burst.
                        this._tailHandoffs++;
                        if (sh.vbs[i] >= INJECT.VBS_MIN) {
                            this._spawnInjection(sh.vbs[i], this._state.plasmapauseL, 0.25);
                        }
                        sh.mode[i] = 0;
                    }
                }
                if (sh.mode[i] === 2 &&
                    (sh.px[i] < -26 || sh.px[i] > -1.5 || sh.age[i] > 90)) {
                    sh.mode[i] = 0;   // lost downtail / slipped past / timed out
                }
            }
            if (sh.mode[i] === 0) { col[j] = col[j + 1] = col[j + 2] = 0; continue; }
            if (sh.mode[i] === 1) {
                const th = sh.th[i];
                const r = shueRadiusRe(th, this._mpR0, this._mpAlpha) * sh.jit[i];
                const st = Math.sin(th), ct = Math.cos(th);
                pos[j]     = r * ct;
                pos[j + 1] = r * st * Math.sin(sh.ph[i]);
                pos[j + 2] = r * st * Math.cos(sh.ph[i]);
                // Fades toward the flank END but keeps a floor — the strands
                // that fork into the tail continue seamlessly at stage-2's
                // entry brightness instead of vanishing and reappearing.
                const fade = (1 - 0.7 * smoothstepJs(1.45, 2.05, th)) * (0.35 + 0.65 * sh.nN[i]);
                if (sh.south[i]) {
                    col[j] = 1.0 * fade; col[j + 1] = 0.42 * fade; col[j + 2] = 0.2 * fade;
                } else {
                    col[j] = 0.32 * fade; col[j + 1] = 0.68 * fade; col[j + 2] = 1.0 * fade;
                }
            } else {
                pos[j]     = sh.px[i];
                pos[j + 1] = sh.py[i];
                pos[j + 2] = sh.pz[i];
                // Sheath tint warming to plasma-sheet gold as it approaches
                // the handoff — cool captured plasma re-energising inward.
                const rNow = Math.hypot(sh.px[i], sh.py[i], sh.pz[i]);
                const heat = 1 - smoothstepJs(rHand, 18, rNow);
                const bright = (0.30 + 0.55 * heat) * (0.4 + 0.6 * sh.nN[i]);
                const R0 = sh.south[i] ? 1.0 : 0.32;
                const G0 = sh.south[i] ? 0.42 : 0.68;
                const B0 = sh.south[i] ? 0.20 : 1.00;
                col[j]     = (R0 + (1.00 - R0) * heat) * bright;
                col[j + 1] = (G0 + (0.82 - G0) * heat) * bright;
                col[j + 2] = (B0 + (0.45 - B0) * heat) * bright;
            }
        }
        this._shGeo.attributes.position.needsUpdate = true;
        this._shGeo.attributes.color.needsUpdate = true;
        // Tail sheet: waves march Earthward at the LIVE E×B return speed
        // (identical formula to the tracers — one physics, two renderings);
        // feeding level eases toward the live VBs gate over ~3 s.
        const vbsD = this._driverVbs ?? 0;
        const vE0 = 25 * Math.max(0.3, Math.min(3, vbsD / 2));   // km/s
        const tu = this._tailMat.uniforms;
        tu.uFlow.value = (tu.uFlow.value + 1.7 * vE0 * vScale * dt) % (Math.PI * 2000);
        tu.uTime.value = this._tView;
        tu.uFeed.value += (Math.min(1, vbsD / 4) - tu.uFeed.value) * (1 - Math.exp(-dt / 3));
    }

    /** Solar-origin emission: spawn puffs at the live-flux cadence, drift
     *  them Earthward at the leg's HONEST apparent speed (a crawl — this
     *  leg is ~2 900× more compressed than near-Earth), swell-and-fade as
     *  a rendering cue. See the build comment in _buildSunAndTransit. */
    _updateEmission(dt) {
        const em = this._em;
        const d2r = Math.PI / 180;
        const SUN_X = TRANSIT.X_SUN + 8;     // sun sprite center
        const R_DISK = 1.98;                 // photosphere radius (scene units)
        // Live-flux cadence: quiet ≈2 puffs/s → dense fast wind ≈8/s.
        const flux = Math.min(3, (this._driverN / 6) * (this._driverV / 450));
        this._emAccum += dt * (2 + 2.2 * flux) * (this._streamDensity ?? 1);
        while (this._emAccum >= 1) {
            this._emAccum -= 1;
            let i = -1;
            for (let probe = 0; probe < em.mode.length; probe++) {
                const j2 = (this._emCursor + probe) % em.mode.length;
                if (em.mode[j2] === 0) { i = j2; this._emCursor = j2 + 1; break; }
            }
            if (i < 0) break;
            // Weighted by each hole's OWN arrival record (setState). The
            // back-mapped source region keeps a floor share so the marker
            // always visibly smokes; without any record data the source
            // region is the only honest spawn site.
            let latDeg = 0, lonW = 0, vPuff = this._driverV;
            const pickSrc = this._srcDisk &&
                (Math.random() < 0.35 || !this._diskHoleW);
            if (pickSrc) {
                latDeg = this._srcDisk.latDeg;
                lonW = Math.min(this._srcDisk.lonWDeg, 80);
            } else if (this._diskHoleW) {
                let rw = Math.random() * this._diskHoleW;
                let h = this._diskHoles[this._diskHoles.length - 1];
                for (const hh of this._diskHoles) { rw -= hh.w; if (rw <= 0) { h = hh; break; } }
                latDeg = h.lat; lonW = h.lonW;
                if (Number.isFinite(h.vAssoc)) vPuff = h.vAssoc;
            } else {
                continue;   // no source fix yet — don't invent one
            }
            em.mode[i] = 1;
            em.x[i] = SUN_X - 0.3 - Math.random() * 0.3;
            em.y[i] = R_DISK * Math.sin(latDeg * d2r) + (Math.random() - 0.5) * 0.55;
            em.z[i] = -R_DISK * Math.sin(lonW * d2r) * Math.cos(latDeg * d2r) + (Math.random() - 0.5) * 0.55;
            em.age[i] = 0;
            em.life[i] = 5 + Math.random() * 5;
            // Fast-record holes read hotter (toward white) — the same
            // energy cue the trapped populations use.
            em.warm[i] = (0.6 + 0.4 * Math.min(1, vPuff / 620)) * (0.85 + Math.random() * 0.15);
            em.vKm[i] = vPuff;
        }
        // Honest Earthward drift, PER PUFF: each hole's plasma crawls at
        // its own recorded speed × τ ÷ the leg's km-per-unit.
        const kmPerUnit = (SOLAR.AU_KM - PHYS.L1_KM) / 8;
        const drift = this._clock.tau / kmPerUnit;
        const pos = this._emPos, col = this._emCol;
        for (let i = 0; i < em.mode.length; i++) {
            const j = i * 3;
            if (em.mode[i] === 0) { col[j] = col[j + 1] = col[j + 2] = 0; continue; }
            em.age[i] += dt;
            if (em.age[i] > em.life[i]) {
                em.mode[i] = 0;
                col[j] = col[j + 1] = col[j + 2] = 0;
                continue;
            }
            em.x[i] -= em.vKm[i] * drift * dt;
            const k = em.age[i] / em.life[i];
            const b = Math.sin(Math.min(1, k * 1.15) * Math.PI) * 0.55 * em.warm[i];
            pos[j]     = em.x[i];
            pos[j + 1] = em.y[i];
            pos[j + 2] = em.z[i];
            col[j] = 1.0 * b; col[j + 1] = 0.86 * b; col[j + 2] = 0.62 * b;
        }
        this._emGeo.attributes.position.needsUpdate = true;
        this._emGeo.attributes.color.needsUpdate = true;
    }

    /** Position the in-flight CME fronts at their ballistic fraction of
     *  the (compressed) Sun→Earth gap. Evaluated at simNow — honest, so
     *  near-motionless between feed states; the expansion + off-axis slide
     *  encode the cone geometry, the label carries the ETA. */
    _updateCmes(simNow) {
        const SUN_X = TRANSIT.X_SUN + 8;
        for (const slot of this._cmePool ?? []) {
            const c = slot.cme;
            if (!c) continue;
            const f = Math.max(0, Math.min(1,
                (simNow - c.launchMs) / Math.max(1, c.transit.etaMs - c.launchMs)));
            // The front lives in the Sun→L1 gap (same disclosed compression
            // as the emission puffs): it is UNMEASURED until it reaches the
            // gate, where the corridor's real parcels take the story over.
            // f ≥ 1 holds at the gate until the feed retires it.
            const gateX = TRANSIT.X_SUN + 0.2;
            const x = SUN_X - 0.4 - (SUN_X - 0.4 - gateX) * f;
            const zOff = -((c.longitude_deg ?? 0) / 90) * 3 * f;   // flank slide (west = −z)
            const yOff = ((c.latitude_deg ?? 0) / 90) * 2.5 * f;
            slot.mesh.position.set(x, yOff, zOff);
            const r = 1.2 + 7 * Math.min(1, f * (0.35 + (c.half_angle_deg ?? 35) / 45));
            slot.mesh.scale.setScalar(r);
            slot.mat.opacity = (0.10 + 0.22 * Math.min(1, (c.speed_km_s ?? 400) / 1200))
                * (1 - 0.35 * f);
            // Label BELOW the corridor axis — the band above is owned by the
            // emission-state (y≈10) and gate (y≈20) labels; riding r+2.4 on
            // top used to collide with both as the front grew near the gate.
            // Shallow enough to stay inside the Sun view's bottom edge.
            slot.lab.sp.position.set(x, -(3.2 + 0.3 * r) + yOff * 0.3, zOff);
        }
    }

    /** Ease the boundary toward the live Shue target (the real response is
     *  minutes; ~1.5 s of viewing keeps it legible without popping) and
     *  propagate the nose to everything anchored on it. */
    _updateBoundaries(dt) {
        const k = 1 - Math.exp(-dt / 1.5);
        this._mpR0    += (this._mpTarget.r0 - this._mpR0) * k;
        this._mpAlpha += (this._mpTarget.alpha - this._mpAlpha) * k;
        const compress = Math.max(0, Math.min(1, (10.2 - this._mpR0) / 4.5));
        for (const m of [this._mpMat, this._bsMat]) {
            m.uniforms.uR0.value = this._mpR0;
            m.uniforms.uAlpha.value = this._mpAlpha;
            m.uniforms.uCompress.value = compress;
            m.uniforms.uTime.value = this._tView;
        }
        // The corridor's Earth-end IS the live nose: the wind sheet clips
        // there and the parcel positions in _updateTransit use it.
        this._windMat.uniforms.uXmp.value = this._mpR0 + 0.4;
    }

    // ── Arrival flashes + injection triggers (#917) ─────────────────────────

    /** Fire the parcels whose tArrive fell inside (lastSimNow, simNow] this
     *  frame: a magnetopause flash scaled by the parcel's VBs, and — for
     *  southward parcels above the coupling cutoff — a nightside injection
     *  burst. Interval crossing (not a seen-set) so each parcel fires once
     *  per sweep and replays honestly after a wrap. */
    _detectArrivals(simNow) {
        let flashes = 0;
        for (const p of this._parcels) {
            if (!(p.tArrive > this._lastSimNow && p.tArrive <= simNow)) continue;
            const vbs = couplingVBs(p.v, p.bz) ?? 0;
            if (flashes < 3) {
                this._spawnFlash(vbs, p.bz);
                flashes++;
            }
            if (vbs >= INJECT.VBS_MIN) {
                this._spawnInjection(vbs, this._state.plasmapauseL);
            }
            // The river: most of every arriving parcel DEFLECTS into the
            // magnetosheath and streams around the boundary (VBs rides along
            // as the stage-2 tail-entry gate + return-flow speed).
            this._spawnSheath(p, vbs);
            // Shock-arrival moment: a ≥2× dynamic-pressure step between
            // consecutive arrivals IS an interplanetary shock/compression
            // front hitting the magnetopause. Cooldown-limited so high τ
            // can't strobe; the effect itself is near-subliminal (tick()).
            const pd = dynamicPressure(p.n, p.v);
            if (Number.isFinite(pd)) {
                if (this._prevArrivalPdyn != null && pd >= 2 * this._prevArrivalPdyn &&
                    pd > 2.5 && (this._lastT - this._lastShockMs) > 20_000) {
                    this._shockT = 0;
                    this._lastShockMs = this._lastT;
                    // Physical front: sweeps the boundary surfaces nose→tail
                    // at the shock's own measured speed (τ-scaled). Amplitude
                    // grows with the pressure ratio, capped.
                    this._front = {
                        th: 0.05,
                        vKm: Number.isFinite(p.v) ? p.v : 500,
                        amp: Math.min(1, 0.5 + 0.25 * (pd / this._prevArrivalPdyn - 2)),
                    };
                }
                this._prevArrivalPdyn = pd;
            }
        }
    }

    /** Subtle cinematic layer: a fullscreen additive veil (peak alpha 0.05)
     *  + a 0.45° FOV breath, fired only on real shock arrivals. Both are
     *  suppressed entirely under prefers-reduced-motion. */
    _buildCinematics() {
        this._veilMat = new THREE.ShaderMaterial({
            transparent: true, depthTest: false, depthWrite: false,
            blending: THREE.AdditiveBlending,
            uniforms: { uA: { value: 0 } },
            vertexShader: `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
            fragmentShader: `uniform float uA;
                void main() { gl_FragColor = vec4(1.0, 0.97, 0.9, uA); }`,
        });
        this._veil = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._veilMat);
        this._veil.renderOrder = 999;
        this._veil.frustumCulled = false;
        this._scene.add(this._veil);
        this._shockT = 1e9;             // seconds since the last shock fired
        this._lastShockMs = -1e9;
        this._prevArrivalPdyn = null;
        this._front = null;             // sweeping shock band (boundary shaders)
        this._baseFov = this._camera.fov;
        this._reducedMotion = typeof matchMedia === 'function' &&
            matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    _updateCinematics(dt) {
        // Shock veil + FOV breath: sine-in, exponential-out over ~1.2 s.
        if (this._shockT < 1.2) {
            this._shockT += dt;
            const k = Math.min(1, this._shockT / 1.2);
            const env = this._reducedMotion ? 0
                : Math.sin(k * Math.PI) * Math.exp(-1.8 * k);
            this._veilMat.uniforms.uA.value = 0.05 * env;
            const fov = this._baseFov - 0.45 * env;
            if (Math.abs(fov - this._camera.fov) > 1e-4) {
                this._camera.fov = fov;
                this._camera.updateProjectionMatrix();
            }
        } else if (this._veilMat.uniforms.uA.value !== 0) {
            this._veilMat.uniforms.uA.value = 0;
            this._camera.fov = this._baseFov;
            this._camera.updateProjectionMatrix();
        }
        // Shock front sweep: advance the band along the boundary at the
        // shock's τ-scaled apparent speed, dθ/dt = v_app / r(θ) — honest
        // under the one clock (minutes across the dayside at Real ×1,
        // ~a second at ×300). The band lives on the SURFACES (in-scene
        // physics, not a camera effect), so prefers-reduced-motion keeps
        // it while the veil + FOV breath above stay suppressed.
        if (this._front) {
            const f = this._front;
            const vApp = f.vKm * this._clock.tau / SCALE.NEAR_EARTH.kmPerUnit;
            const rBs = shueRadiusRe(Math.min(f.th, 1.3), this._mpR0, this._mpAlpha) * 1.29;
            f.th += (vApp / Math.max(6, rBs)) * dt;
            f.amp *= Math.exp(-dt / 2.5);
            // Bow shock leads; the magnetopause band trails by the sheath
            // transit (the compression takes time to cross the sheath).
            this._bsMat.uniforms.uShockTh.value = f.th;
            this._bsMat.uniforms.uShockAmp.value = f.amp;
            this._mpMat.uniforms.uShockTh.value = f.th - 0.12;
            this._mpMat.uniforms.uShockAmp.value = f.amp * 0.85;
            if (f.th > 2.6 || f.amp < 0.02) {
                this._front = null;
                this._bsMat.uniforms.uShockAmp.value = 0;
                this._mpMat.uniforms.uShockAmp.value = 0;
            }
        }
        // ENA halo: ease toward the |Dst*| target like an integrating imager.
        const u = this._enaMat.uniforms;
        u.uEna.value += (this._enaTarget - u.uEna.value) * (1 - Math.exp(-dt / 8));
        u.uTime.value = this._tView;
        u.uDstStar.value = this._state.dstStar;
        u.uAsymAmp.value = this._state.asym.amplitude;
        u.uAsymMlt.value = this._state.asym.mltPeakHours;
    }

    _buildFlashes() {
        // Shared soft radial texture; per-flash tint via material color.
        const cv = document.createElement('canvas');
        cv.width = cv.height = 64;
        const g = cv.getContext('2d');
        const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0.0, 'rgba(255,255,255,1)');
        grad.addColorStop(0.4, 'rgba(255,255,255,0.5)');
        grad.addColorStop(1.0, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 64, 64);
        const tex = new THREE.CanvasTexture(cv);
        this._flashes = [];
        for (let i = 0; i < 8; i++) {
            const mat = new THREE.SpriteMaterial({
                map: tex, blending: THREE.AdditiveBlending, depthWrite: false,
                transparent: true, opacity: 0,
            });
            const sp = new THREE.Sprite(mat);
            sp.visible = false;
            this._scene.add(sp);
            this._flashes.push({ sp, mat, age: 0, life: 0.9, base: 1, o0: 0.5 });
        }
    }

    /** Interaction flash at the magnetopause — the visible handoff from
     *  "in transit" to "coupled". Intensity ∝ VBs; southward reads hot. */
    _spawnFlash(vbs, bz) {
        const f = this._flashes?.find(f => !f.sp.visible) ?? null;
        if (!f) return;
        const south = Number.isFinite(bz) && bz < 0;
        f.mat.color.setRGB(...(south ? [1.0, 0.55, 0.3] : [0.45, 0.7, 1.0]));
        f.sp.position.set(
            this._mpR0 + 0.3,   // ON the live Shue nose
            (Math.random() - 0.5) * 2.2,
            (Math.random() - 0.5) * 2.2,
        );
        f.base = 1.4 + 2.4 * Math.min(1, vbs / 6);
        f.age = 0;
        f.o0 = south ? 0.85 : 0.4;
        f.sp.scale.setScalar(f.base);
        f.mat.opacity = f.o0;
        f.sp.visible = true;
    }

    _updateFlashes(dt) {
        for (const f of this._flashes) {
            if (!f.sp.visible) continue;
            f.age += dt;
            const k = f.age / f.life;
            if (k >= 1) { f.sp.visible = false; f.mat.opacity = 0; continue; }
            f.sp.scale.setScalar(f.base * (1 + 1.8 * k));
            f.mat.opacity = f.o0 * (1 - k) ** 1.4;
        }
    }

    // ── Injection dynamics (#917 Phase 4 — why storms pump the ring) ────────
    // These are the ENTRY leg of the journey: hot plasma-sheet ions surging
    // in from the tail and decelerating into drift. The trapped GPU
    // populations then carry the story onward (drift → charge exchange /
    // precipitation). Lives in _magGroup so bursts tilt with the dipole.

    _buildInjections() {
        const N = INJECT.CAP;
        this._injGeo = new THREE.BufferGeometry();
        this._injPos = new Float32Array(N * 3);
        this._injCol = new Float32Array(N * 3);
        this._injGeo.setAttribute('position', new THREE.BufferAttribute(this._injPos, 3).setUsage(THREE.DynamicDrawUsage));
        this._injGeo.setAttribute('color',    new THREE.BufferAttribute(this._injCol, 3).setUsage(THREE.DynamicDrawUsage));
        this._injPts = new THREE.Points(this._injGeo, glowPointsMaterial(0.11, 0.95));
        this._injPts.frustumCulled = false;
        this._magGroup.add(this._injPts);
        this._inj = {
            mode:    new Uint8Array(N),      // 0 free · 1 inflow · 2 drift
            species: new Uint8Array(N),      // 0 ion · 1 electron — the burst FORKS
            theta:   new Float32Array(N),
            r:       new Float32Array(N),
            targetL: new Float32Array(N),
            rate:    new Float32Array(N),    // drift rad/h, SCENE-signed (+ = westward)
            age:     new Float32Array(N),    // wall-s since spawn (fade cue)
            yAmp:    new Float32Array(N),
            bPh:     new Float32Array(N),
            mate:    new Int16Array(N).fill(-1),   // paired ion↔electron slot
        };
        this._injCursor = 0;

        // Pair tethers: injections are QUASI-NEUTRAL — every burst delivers
        // ions and electrons together, and only gradient–curvature drift
        // splits them (ions west, electrons east). Each tether connects a
        // pair born on the same flux tube and fades as they separate: the
        // stretching itself IS the charge separation that constitutes the
        // westward ring current. One LineSegments draw, pool-capped.
        const LINKS = 220;
        this._linkCap = LINKS;
        this._linkPos = new Float32Array(LINKS * 6);
        this._linkCol = new Float32Array(LINKS * 6);
        this._linkGeo = new THREE.BufferGeometry();
        this._linkGeo.setAttribute('position', new THREE.BufferAttribute(this._linkPos, 3).setUsage(THREE.DynamicDrawUsage));
        this._linkGeo.setAttribute('color',    new THREE.BufferAttribute(this._linkCol, 3).setUsage(THREE.DynamicDrawUsage));
        this._links = new THREE.LineSegments(this._linkGeo, new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true, opacity: 0.6,
            blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        this._links.frustumCulled = false;
        this._magGroup.add(this._links);
    }

    /** Burst of hot ions entering from the nightside tail. Count scales with
     *  the arriving parcel's VBs and inversely with τ (at high compression
     *  parcels arrive many per second — the stream of bursts is continuous,
     *  which is exactly the storm-time picture). Injections penetrate deeper
     *  when the plasmapause contracts. `scale` < 1 gives the mini bursts a
     *  tail-transport handoff fires (the traced matter arriving). */
    _spawnInjection(vbs, lpp, scale = 1) {
        const inj = this._inj;
        const tauScale = Math.min(1, 60 / this._clock.tau);
        const count = Math.max(2, Math.round((6 + 11 * Math.min(6, vbs)) * tauScale * scale))
            * (this._streamDensity ?? 1);   // pool-capped; drops, never grows
        // Ring cursor; skip slots still alive (pool full ⇒ drop, not grow).
        const alloc = () => {
            for (let probe = 0; probe < INJECT.CAP; probe++) {
                const j = (this._injCursor + probe) % INJECT.CAP;
                if (inj.mode[j] === 0) { this._injCursor = j + 1; return j; }
            }
            return -1;
        };
        // The plasma sheet is QUASI-NEUTRAL: the burst spawns ion–electron
        // PAIRS born on the same flux tube. The ENTRY surge is E×B
        // convection (charge-independent — the pair rides in together);
        // gradient–curvature drift takes over at the trapping point and
        // splits it — ions WEST toward dusk, electrons EAST toward dawn,
        // the classic dispersionless-injection signature seen at GEO. The
        // mate index drives the fading tether in _updateInjections.
        const fill = (i, electron, theta, r, targetL, yAmp, bPh) => {
            inj.mode[i]    = 1;
            inj.species[i] = electron ? 1 : 0;
            inj.theta[i]   = theta;
            inj.r[i]       = r;
            inj.targetL[i] = targetL;
            const eKev     = electron ? 20 + 120 * Math.random() ** 2
                                      : 30 + 220 * Math.random() ** 2;
            // Scene-θ sign: westward = θ increasing in the GSM frame (#917
            // was written for the pre-fix mirrored frame — sign re-derived).
            inj.rate[i]    = -driftRateRadPerHour(eKev, targetL, electron ? 'electron' : 'ion');
            inj.age[i]     = 0;
            inj.yAmp[i]    = yAmp;
            inj.bPh[i]     = bPh;
            inj.mate[i]    = -1;
        };
        const pairs = Math.max(1, Math.round(count / 2));
        for (let c = 0; c < pairs; c++) {
            const theta   = Math.PI + (Math.random() - 0.5) * 1.4;   // ~21–03 MLT
            const r       = 7.8 + Math.random() * 1.6;
            const targetL = Math.max(2.2, lpp - 0.4 - Math.random() * 1.6);
            const yAmp    = (Math.random() - 0.5) * 0.7;
            const bPh     = Math.random() * 2 * Math.PI;
            const iIon = alloc();
            if (iIon < 0) return;
            fill(iIon, false, theta, r, targetL, yAmp, bPh);
            const iEl = alloc();
            if (iEl < 0) return;              // pool pressure: lone ion, no tether
            fill(iEl, true, theta, r, targetL, yAmp, bPh);
            inj.mate[iIon] = iEl;
            inj.mate[iEl]  = iIon;
        }
    }

    /** Inflow: exponential approach to the target L on the SIM clock —
     *  initial speed ≈ (r₀−L)/T_IN R_E per sim-second (~100–350 km/s), with
     *  the deceleration that makes the fast-arrival → slow-drift transition
     *  legible. Drift: the particle's own energy-dependent westward rate.
     *  Fade is wall-clock (a rendering cue, not physics). */
    _updateInjections(dt, dSimH) {
        const inj = this._inj;
        const pos = this._injPos, col = this._injCol;
        const dSimS = dSimH * 3600;
        const ease = 1 - Math.exp(-dSimS / INJECT.T_IN_S);
        for (let i = 0; i < INJECT.CAP; i++) {
            const j = i * 3;
            if (inj.mode[i] === 0) {
                col[j] = col[j + 1] = col[j + 2] = 0;
                continue;
            }
            inj.age[i] += dt;
            if (inj.age[i] > INJECT.LIFE_S) {
                inj.mode[i] = 0;
                // Unlink the tether — slots recycle, stale mates would
                // draw lines between unrelated particles.
                if (inj.mate[i] >= 0) { inj.mate[inj.mate[i]] = -1; inj.mate[i] = -1; }
                col[j] = col[j + 1] = col[j + 2] = 0;
                continue;
            }
            if (inj.mode[i] === 1) {
                inj.r[i] += (inj.targetL[i] - inj.r[i]) * ease;
                inj.theta[i] += inj.rate[i] * dSimH * 0.6;   // partial drift while entering
                if (inj.r[i] - inj.targetL[i] < 0.1) inj.mode[i] = 2;
            } else {
                inj.theta[i] += inj.rate[i] * dSimH;
            }
            const th = inj.theta[i];
            const y = inj.yAmp[i] * Math.sin(inj.bPh[i] + this._tView * 1.4);
            pos[j]     = inj.r[i] * Math.cos(th);
            pos[j + 1] = y;
            pos[j + 2] = inj.r[i] * Math.sin(th);
            // Hot white at entry (species indistinguishable in the E×B
            // surge), cooling to the species color as the fork develops:
            // ion orange sweeping duskward, electron blue dawnward.
            const heat = Math.max(0, 1 - inj.age[i] / 8);
            const fade = 1 - inj.age[i] / INJECT.LIFE_S;
            const b = (0.55 + 0.65 * heat) * fade;
            const base = inj.species[i] === 1 ? ELECTRON_COLOR : ION_COLOR;
            col[j]     = (base.r + (1.00 - base.r) * heat) * b;
            col[j + 1] = (base.g + (0.95 - base.g) * heat) * b;
            col[j + 2] = (base.b + (0.80 - base.b) * heat) * b;
        }
        this._injGeo.attributes.position.needsUpdate = true;
        this._injGeo.attributes.color.needsUpdate = true;
        // ── Pair tethers: ion→electron chords, warm→blue gradient, fading
        //    with age and stretch. The visible stretching is the drift
        //    separation — charge separation = the westward current. ────────
        const lp = this._linkPos, lc = this._linkCol;
        let li = 0;
        for (let i = 0; i < INJECT.CAP && li < this._linkCap; i++) {
            const m = inj.mate[i];
            if (m <= i || inj.mode[i] === 0 || inj.mode[m] === 0) continue;
            const age = Math.max(inj.age[i], inj.age[m]);
            if (age > 9) continue;
            const a = i * 3, b = m * 3;
            const d = Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]);
            if (d > 5.5) continue;
            const o = li * 6;
            // Quadratic stretch fade: long chords vanish quickly, so the
            // tethers read as delicate filaments, not a thicket.
            const fade = (1 - age / 9) * (1 - d / 5.5) ** 2 * 0.34;
            lp[o]     = pos[a]; lp[o + 1] = pos[a + 1]; lp[o + 2] = pos[a + 2];
            lp[o + 3] = pos[b]; lp[o + 4] = pos[b + 1]; lp[o + 5] = pos[b + 2];
            lc[o]     = 1.00 * fade; lc[o + 1] = 0.62 * fade; lc[o + 2] = 0.30 * fade;
            lc[o + 3] = 0.35 * fade; lc[o + 4] = 0.62 * fade; lc[o + 5] = 1.00 * fade;
            li++;
        }
        for (let s = li * 6; s < this._linkCap * 6; s++) { lp[s] = 0; lc[s] = 0; }
        this._linkGeo.attributes.position.needsUpdate = true;
        this._linkGeo.attributes.color.needsUpdate = true;
    }

    // ── Hover tooltips (#917) — the data behind any particle ────────────────
    // Ring picking CANNOT raycast the GPU populations (their position
    // attribute holds (L, θ_birth, λ_m) seeds — the true positions exist
    // only in the vertex shader). Instead the picker evaluates the SAME
    // particlePose() reference the shader transcribes, projects to screen
    // space, and picks the nearest — so hover agrees with the drawn pixel,
    // lifecycle and all.

    _initTooltip() {
        const el = document.createElement('div');
        el.style.cssText =
            'position:absolute;display:none;pointer-events:none;z-index:5;' +
            'background:rgba(3,1,14,.88);border:1px solid rgba(255,255,255,.2);' +
            'border-radius:6px;padding:6px 9px;font:600 11px system-ui;' +
            'color:#e8edf7;line-height:1.5;max-width:270px;white-space:nowrap;';
        this._container.appendChild(el);
        this._tipEl = el;
        this._ray = new THREE.Raycaster();
        this._ndc = new THREE.Vector2();
        this._pointerPx = null;
        this._pointerDirty = false;
        this._tmpV = new THREE.Vector3();
        this._poseScratch = {};   // reused by the pick loop (thousands of
        this._pickPose = {};      // poses per pick — no per-particle allocs)
        const dom = this._renderer.domElement;
        this._onPointerMove = (e) => {
            const rect = dom.getBoundingClientRect();
            this._ndc.set(
                ((e.clientX - rect.left) / rect.width) * 2 - 1,
                -((e.clientY - rect.top) / rect.height) * 2 + 1,
            );
            this._pointerPx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            this._pointerDirty = true;
        };
        this._onPointerLeave = () => {
            this._pointerPx = null;
            this._tipEl.style.display = 'none';
        };
        this._onPointerDown = (e) => {
            this._dragging = true;
            this._tipEl.style.display = 'none';
            this._downPx = { x: e.clientX, y: e.clientY, t: performance.now() };
        };
        this._onPointerUp = (e) => {
            this._dragging = false;
            const d = this._downPx;
            this._downPx = null;
            // Click-to-pin (inspector): a short press that didn't orbit.
            // pointerup is bound on window — the target check keeps clicks
            // on overlay panels from unpinning through them.
            if (!d || performance.now() - d.t > 450) return;
            if ((e.clientX - d.x) ** 2 + (e.clientY - d.y) ** 2 > 36) return;
            if (e.target !== this._renderer.domElement) return;
            const rect = this._renderer.domElement.getBoundingClientRect();
            const hit = this._pickRingAt(e.clientX - rect.left, e.clientY - rect.top);
            if (hit) this.pinParticle(hit.key, hit.i);
            else if (this._pinned) this.unpinParticle();
            else {
                // Tapped WFC cell → descend over that region (plan §C.3's
                // "Go see"). Only when the map layer is shown; the flight
                // is the same eased glide as the view presets.
                const shell = this._ionoLayer?.mapShell;
                if (shell && shell.visible && this._ionoLayer.group.visible) {
                    this._ndc.set(
                        ((e.clientX - rect.left) / rect.width) * 2 - 1,
                        -((e.clientY - rect.top) / rect.height) * 2 + 1);
                    this._ray.setFromCamera(this._ndc, this._camera);
                    const mHit = this._ray.intersectObject(shell)[0];
                    if (mHit) {
                        this.setView('surface',
                            { anchorWorldDir: mHit.point.clone().normalize() });
                    }
                }
            }
        };
        this._pinned = null;
        this.onSelect = null;   // page hook: fires with getPinnedInfo() | null
        dom.addEventListener('pointermove', this._onPointerMove);
        dom.addEventListener('pointerleave', this._onPointerLeave);
        dom.addEventListener('pointerdown', this._onPointerDown);
        window.addEventListener('pointerup', this._onPointerUp);
    }

    /** Nearest visible ring particle within 12 px of (px, py) — the same
     *  pose-projection pick the hover tooltip uses (GPU positions exist
     *  only in the vertex shader; particlePose is its CPU reference). */
    _pickRingAt(px, py) {
        const rect = this._renderer.domElement.getBoundingClientRect();
        let best = null;
        for (const [key, P] of Object.entries(this._popPoints ?? {})) {
            const pop = P.pop;
            const visFrac = P.mat.uniforms.uVisFrac.value;
            for (let i = 0; i < pop.count; i++) {
                if (hash1(pop.life[i * 4 + 3] * 0.517) >= visFrac) continue;  // hidden (Dst gate)
                const q = particlePose(pop, i, this._simHours, this._tView, this._poseScratch);
                this._tmpV.set(q.x, q.y, q.z)
                    .applyMatrix4(this._magGroup.matrixWorld)
                    .project(this._camera);
                const sx = (this._tmpV.x + 1) / 2 * rect.width;
                const sy = (1 - this._tmpV.y) / 2 * rect.height;
                const d2 = (sx - px) ** 2 + (sy - py) ** 2;
                if (d2 < 144 && (!best || d2 < best.d2)) {
                    // Copy out of the scratch — later iterations overwrite it.
                    this._pickPose.ph = q.ph;
                    this._pickPose.dying = q.dying;
                    this._pickPose.mode = q.mode;
                    best = { kind: 'ring', key, P, i, q: this._pickPose, d2 };
                }
            }
        }
        return best;
    }

    // ── Particle inspector (Phase 1 — RING_CURRENT_ANALYTICS_PLAN.md) ───────
    // The globe owns only the 3D side: pin/ghost markers in magGroup-local
    // coordinates (the group's dipole tilt applies to them for free) and a
    // minimal data API; all physics + card DOM live in
    // js/ring-current-inspector.js so they stay node-testable.

    _ensurePinSprites() {
        if (this._pinSprite) return;
        const mk = (color, dashed) => {
            const cv = document.createElement('canvas');
            cv.width = cv.height = 64;
            const g = cv.getContext('2d');
            g.strokeStyle = color;
            g.lineWidth = 5;
            if (dashed) g.setLineDash([7, 6]);
            g.beginPath(); g.arc(32, 32, 24, 0, 2 * Math.PI); g.stroke();
            const sp = new THREE.Sprite(new THREE.SpriteMaterial({
                map: new THREE.CanvasTexture(cv), transparent: true,
                depthWrite: false, depthTest: false, opacity: 0.9,
            }));
            sp.scale.setScalar(0.55);
            sp.visible = false;
            this._magGroup.add(sp);
            return sp;
        };
        this._pinSprite = mk('#ffffff', false);
        this._ghostSprite = mk('#ffd700', true);   // dashed = a prediction
    }

    /** Pin particle i of population key; fires onSelect. Returns success. */
    pinParticle(key, i) {
        const P = this._popPoints?.[key];
        if (!P || !(i >= 0 && i < P.pop.count)) return false;
        this._ensurePinSprites();
        this._pinned = { key, i, pop: P.pop };
        this._pinSprite.visible = true;
        this.clearGhost();
        this.onSelect?.(this.getPinnedInfo());
        return true;
    }

    unpinParticle() {
        this._pinned = null;
        if (this._pinSprite) this._pinSprite.visible = false;
        this.clearGhost();
        this.onSelect?.(null);
    }

    /** Live handle for the inspector card (null when nothing pinned).
     *  simHours/bounceSec are the two clocks particlePose runs on. */
    getPinnedInfo() {
        if (!this._pinned) return null;
        return {
            key: this._pinned.key,
            i: this._pinned.i,
            pop: this._pinned.pop,
            simHours: this._simHours,
            bounceSec: this._tView,
        };
    }

    /** Live handles for the population analytics dock (Phase 2 —
     *  RING_CURRENT_ANALYTICS_PLAN.md). Populations arrive async from the
     *  worker, so `populations` is empty until the buffers land — the dock
     *  shows "warming up" rather than inventing rows. oxygenModelFrac is
     *  the model share that STEERS BRIGHTNESS (build counts are fixed);
     *  the dock discloses both numbers side by side. */
    getAnalyticsSnapshot() {
        return {
            simHours: this._simHours,
            dstStar: this._state.dstStar,
            oxygenModelFrac: this._pendingMix ?? null,
            populations: Object.entries(this._popPoints ?? {}).map(([key, P]) => ({
                key, pop: P.pop, visFrac: P.mat.uniforms.uVisFrac.value,
            })),
        };
    }

    /** Dashed ghost marker at a predicted pose (magGroup-local coords). */
    setGhostLocal(x, y, z) {
        this._ensurePinSprites();
        this._ghostSprite.position.set(x, y, z);
        this._ghostSprite.visible = true;
    }

    clearGhost() {
        if (this._ghostSprite) this._ghostSprite.visible = false;
    }

    _updateTooltip(wallNow) {
        if (!this._pointerDirty || !this._pointerPx || this._dragging) return;
        // Pose-projection picking is ~4700 trig evals + allocs — cap it at
        // ~14 Hz (pointerDirty stays set, so the pick lands a frame later;
        // imperceptible against a 12 px hit radius).
        if (wallNow - (this._lastPickMs ?? 0) < 70) return;
        this._lastPickMs = wallNow;
        this._pointerDirty = false;

        // Ring populations: the shared pose-projection pick (~4700 trig
        // evals, pointer-move-throttled) — same helper the click-to-pin uses.
        let best = this._pickRingAt(this._pointerPx.x, this._pointerPx.y);
        // Transit parcels: their geometry holds REAL positions — raycast.
        this._ray.setFromCamera(this._ndc, this._camera);
        this._ray.params.Points.threshold = 1.0;
        for (const hit of this._ray.intersectObject(this._transit)) {
            if (hit.point.length() < 1.6) continue;
            const p = this._slotParcel?.[Math.floor(hit.index / (TRANSIT.PTS_PER * TRANSIT.DENS_MAX))];
            if (!p) continue;
            if (!best) best = { kind: 'parcel', p };
            break;
        }
        // WFC regional-state map: last-priority pick (particles and parcels
        // win), only while the map layer is shown. The `why` array IS the
        // M2 inspector — every region explains itself on hover.
        const mapShell = this._ionoLayer?.mapShell;
        if (!best && mapShell && mapShell.visible && this._ionoLayer.group.visible) {
            const hit = this._ray.intersectObject(mapShell)[0];
            if (hit) {
                const info = this.cellInfoAt(hit.point);
                if (info) best = { kind: 'cell', info };
            }
        }

        if (!best) { this._tipEl.style.display = 'none'; return; }
        const fmt = (x, d, u) => Number.isFinite(x) ? `${x.toFixed(d)}${u}` : '—';
        let html;
        if (best.kind === 'ring') {
            const { pop } = best.P, i = best.i, q = best.q;
            const names = { ionsH: ['H⁺ ion', '#ffa040'], ionsO: ['O⁺ ion', '#94ff57'],
                            ionsHe: ['He⁺ ion', '#b48cff'], electrons: ['Electron', '#59baff'] };
            // Defensive default: a population added to the sim without a tooltip
            // entry (as He⁺ once was) must not throw inside the animation loop.
            const [name, color] = names[best.key] ?? ['Ion', '#c8d0e0'];
            const L = pop.seed[i * 3], lt = pop.life[i * 4 + 1];
            const T = driftPeriodHours(pop.eKev[i], L);
            const fate = pop.life[i * 4 + 2] === 0
                ? 'charge exchange → ENA'
                : `precipitates (${pop.life[i * 4 + 2] > 0 ? 'N' : 'S'} atmosphere)`;
            const status = q.dying > 0
                ? (q.mode === 0 ? '<br><b style="color:#ffd9b0">neutralised — escaping as an ENA</b>'
                                : '<br><b style="color:#ff7d66">precipitating into the atmosphere</b>')
                : `<br>lifetime ${lt > 48 ? `${(lt / 24).toFixed(1)} d` : `${lt.toFixed(1)} h`}` +
                  ` · ${((1 - q.ph) * lt).toFixed(1)} h left · fate: ${fate}`;
            html = `<b style="color:${color}">${name}</b> · ${pop.eKev[i].toFixed(0)} keV` +
                `<br>L ${L.toFixed(2)} Rᴇ · drift ${fmt(T, 1, ' h')}/lap ` +
                `${best.key === 'electrons' ? 'eastward' : 'westward'}${status}`;
        } else if (best.kind === 'cell') {
            // The M2 inspector: state + the priors that argued for it.
            const info = best.info;
            const COL = { quiet: '#8b94ad', crest: '#ff5c47', bubble: '#ff8894',
                          arc: '#40ff80', diffuse: '#37e0a0', trough: '#5d8cff' };
            const why = info.why.length
                ? info.why.map(w => `${w.state} ${w.w}`).join(' · ')
                : '—';
            html = `<b style="color:${COL[info.state] ?? '#e8edf7'}">` +
                `${info.state.toUpperCase()}</b> — ionospheric regime` +
                `<br>${Math.abs(info.maglat).toFixed(0)}°${info.maglat >= 0 ? 'N' : 'S'} maglat` +
                ` · ${info.mlt.toFixed(1)} MLT` +
                `<br><span style="color:#8b94ad">why: ${why}</span>`;
            // Descended: the inspector gains COLUMN MODE (plan §C.3e) — the
            // local vertical D/E/F stack at this spot, live. lt ≈ MLT (the
            // same mean-sun map both kernels use at these latitudes).
            if ((this._lastExag ?? 1) > 4) {
                const blocks = '▁▂▃▄▅▆▇█';
                const prof = columnProfile(info.mlt, this._cellsKp).reverse();
                const line = prof.map(l => l.density <= 0.01
                    ? `${l.key} —`
                    : `${l.key} ${l.altKm} km ${blocks[Math.min(7, Math.round(l.density * 7))]}`)
                    .join(' · ');
                html += `<br><span style="color:#b9c2d9">column: ${line}</span>`;
            }
            html += `<br><span style="color:#5d6684">WFC regional map · 5°×1h` +
                ` · epoch 10 sim-min · click to descend</span>`;
        } else {
            const p = best.p;
            const etaMin = Math.max(0, Math.round((p.tArrive - wallNow) / 60_000));
            // Per-parcel emission→reception ledger: THIS parcel's own speed
            // dates its solar departure (ballistic back-mapping) — hovering
            // across the stream shows the dispersion directly.
            const dep = sunDepartureMs(p.tL1 ?? null, p.v);
            const sunLine = dep != null
                ? `<br>left the Sun ≈ ${((wallNow - dep) / 86.4e6).toFixed(1)} d ago (ballistic)`
                : '';
            html = `<b style="color:#ffd9b0">L1 parcel</b> · v ${fmt(p.v, 0, ' km/s')}` +
                `<br>Bz ${fmt(p.bz, 1, ' nT')} · n ${fmt(p.n, 1, ' /cm³')}` +
                `<br>arrives in ${etaMin} min (real)${sunLine}`;
        }
        this._tipEl.innerHTML = html;
        this._tipEl.style.left = `${this._pointerPx.x + 14}px`;
        this._tipEl.style.top = `${this._pointerPx.y + 12}px`;
        this._tipEl.style.display = 'block';
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
            this._gateLab = this._makeLabel(TRANSIT.X_SUN, 20.5, 0, 10);
            // Below the CME label band (nearest-front label sits at y≈−5..−8).
            this._helioLab = this._makeLabel(TRANSIT.X_SUN + 4, -12, 0, 8.5);
            // Above the corona (sprite half-height ≈6.1 at max), nudged
            // Earthward off the disk axis so the foreshortened River view
            // keeps it in frame (dead-center-above leans out of shot there),
            // and low enough that the Sun view's top edge (where the DOM
            // view pills float) stays clear of the title.
            this._sunLab = this._makeLabel(TRANSIT.X_SUN + 3.5, 9.6, 0, 9.5);
        }
        // Gate pulse: a genuinely NEW 1-min sample landed (newest tL1 moved).
        // Wall-clock instrumentation, deliberately independent of τ.
        const newestTL1 = this._parcels.reduce((m, p) => Math.max(m, p.tL1 ?? 0), 0);
        if (newestTL1 > this._lastSampleTL1 && this._gateMat) {
            this._lastSampleTL1 = newestTL1;
            this._gateMat.uniforms.uPulse.value = 1;
        }
        // L1 gate label: the emission→reception ledger at the plane itself.
        const sl = state?.now?.sunLag;
        if (sl && this._gateLab) {
            this._drawLabel(this._gateLab, 'L1 — MEASUREMENT PLANE', [
                'DSCOVR/ACE sample here every 60 s',
                `wind left Sun ${Number.isFinite(sl.days) ? sl.days.toFixed(1) : '—'} d ago (ballistic)`,
                `source Carrington ${Number.isFinite(sl.carringtonLon) ? Math.round(sl.carringtonLon) + '°' : '—'}` +
                    `${Number.isFinite(sl.stonyhurstNowDeg) ? ` · now W${Math.round(Math.min(sl.stonyhurstNowDeg, 99))}` : ''}`,
                `light does the trip in ${sl.lightMin.toFixed(1)} min`,
            ], '#9ecbff');
        }
        // Live solar disk: coronal holes + the back-mapped source marker.
        if (sl) this._drawSunDisk(sl);
        // Solar-origin emission wiring: where on the disk the puffs are
        // born, the live drivers that set their cadence, and the schematic
        // Parker-spiral streamline source → gate.
        this._driverV = Number.isFinite(state?.drivers?.v) ? state.drivers.v : 400;
        this._driverN = Number.isFinite(state?.drivers?.n) ? state.drivers.n : 3;
        this._srcDisk = Number.isFinite(sl?.stonyhurstNowDeg)
            ? { latDeg: sl.source?.hole?.lat_deg ?? 0, lonWDeg: sl.stonyhurstNowDeg }
            : null;
        // Spawn weights from each hole's OWN measured arrival record
        // (feed: holeWindAssociation) — a hole whose longitude fed the
        // last 24 h of arrivals puffs harder and its puffs crawl at ITS
        // median speed; holes with no record yet (east of the meridian)
        // idle at a floor rate rather than being invented.
        this._diskHoles = (sl?.holes ?? []).map(h => {
            const lonW = ((h.lon_carrington_deg - sl.l0NowDeg) % 360 + 540) % 360 - 180;
            const w = h.assoc
                ? (0.5 + 1.5 * Math.min(1, h.assoc.n / 90)) * Math.min(2, h.assoc.vMed / 450)
                : 0.35;
            return { lat: h.lat_deg ?? 0, lonW, w, vAssoc: h.assoc?.vMed ?? null };
        }).filter(h => Math.abs(h.lonW) < 80 && Math.abs(h.lat) < 70);
        this._diskHoleW = this._diskHoles.reduce((s, h) => s + h.w, 0);
        if (this._srcDisk && this._spiralPos) {
            const d2r = Math.PI / 180;
            const lonW = Math.min(this._srcDisk.lonWDeg, 80) * d2r;
            const lat = this._srcDisk.latDeg * d2r;
            // Quadratic Bézier from the source point on the disk to the gate
            // rim, bowing westward by the live garden-hose angle.
            const p0 = [TRANSIT.X_SUN + 7.6, 1.98 * Math.sin(lat), -1.98 * Math.sin(lonW) * Math.cos(lat)];
            const p2 = [TRANSIT.X_SUN + 0.2, 0, 0];
            const bow = Math.tan(Math.min(70, sl.spiralDeg ?? 45) * d2r) * 1.6;
            const p1 = [TRANSIT.X_SUN + 4, p0[1] * 0.45, p0[2] * 0.45 - bow];
            for (let s = 0; s <= 24; s++) {
                const t = s / 24, u2 = 1 - t;
                for (let c = 0; c < 3; c++) {
                    this._spiralPos[s * 3 + c] =
                        u2 * u2 * p0[c] + 2 * t * u2 * p1[c] + t * t * p2[c];
                }
            }
            this._spiralGeo.attributes.position.needsUpdate = true;
            this._spiral.visible = true;
        }
        // In-flight CME fronts: assign pool slots (feed sorts by ETA).
        // Several fronts share the ≈7-unit compressed Sun→L1 leg, so
        // per-cone labels pile into an unreadable stack (seen live with 4
        // CMEs in flight). Only the NEAREST front carries a label — titled
        // "1 of N" so the others are disclosed, with per-CME detail in the
        // Situation panel. Every cone is still drawn.
        this._cmesLive = state?.cmes ?? [];
        const nCmes = this._cmesLive.length;
        for (let ci = 0; ci < this._cmePool.length; ci++) {
            const slot = this._cmePool[ci];
            const c = this._cmesLive[ci] ?? null;
            slot.cme = c;
            slot.mesh.visible = !!c;
            slot.lab.sp.visible = !!c && ci === 0;
            if (!c || ci !== 0) continue;
            const etaH = ((c.etaMs ?? c.transit.etaMs) - Date.now()) / 3.6e6;
            const enlil = c.basis === 'enlil';
            const band = enlil ? 10 : Math.round((c.transit.etaLateMs - c.transit.etaMs) / 3.6e6);
            const xchk = Number.isFinite(c.crossCheckHours)
                ? `ballistic says ${Math.abs(c.crossCheckHours).toFixed(0)} h ${c.crossCheckHours >= 0 ? 'later' : 'earlier'} (cross-check)`
                : `${Math.min(100, Math.round(c.transit.fraction * 100))}% of Sun→Earth covered`;
            const title = nCmes > 1
                ? `CMEs IN FLIGHT — 1 of ${nCmes}${c.glancing ? ' (FLANK)' : ''}`
                : `CME — IN FLIGHT${c.glancing ? ' (FLANK)' : ''}`;
            this._drawLabel(slot.lab, title, [
                `v ${Math.round(c.speed_km_s)} km/s · launched ${c.transit.hoursInFlight.toFixed(0)} h ago`,
                etaH > 0
                    ? `arrives in ≈ ${etaH < 48 ? `${Math.round(etaH)} h` : `${(etaH / 24).toFixed(1)} d`} ±${band} h`
                    : 'arriving NOW',
                xchk,
                enlil ? 'NOAA WSA-ENLIL modeled arrival' : 'ballistic estimate (constant speed)',
            ], '#ffc890');
        }
        if (sl && this._helioLab) {
            this._drawLabel(this._helioLab, 'SUN → L1 — THE UNMEASURED LEG', [
                `${Number.isFinite(sl.days) ? sl.days.toFixed(1) : '—'} d in flight · light: 8.3 min`,
                'plasma is only measured when it crosses the gate',
                'puff rate & speed ∝ each hole’s own arrival record',
                'leg drawn ≈2 900× more compressed than near-Earth',
            ], '#ffd27a');
        }
        // Sun emission-state readout — the Sun-side twin of the ring label:
        // WHAT the disk is releasing right now and where the wind arriving
        // at Earth traces back to. Pinned above the corona so the Sun and
        // River views carry a legible solar readout without opening panels.
        if (this._sunLab) {
            // Lines stay ≤ ~33 chars — the 512-px label canvas clips longer.
            const src = sl?.source;
            const srcLine = !sl ? 'wind now: source pending'
                : src?.matched
                    ? `wind now: CH ${(src.hole.lat_deg ?? 0) >= 0 ? 'N' : 'S'}${Math.round(Math.abs(src.hole.lat_deg ?? 0))}` +
                      `${Number.isFinite(sl.carringtonLon) ? ` · Car ${Math.round(sl.carringtonLon)}°` : ''}`
                : src?.kind === 'streamer-belt'
                    ? 'wind now: streamer belt (slow wind)'
                : src ? 'wind now: fast wind — no CH match'
                : `wind now: Car ${Number.isFinite(sl.carringtonLon) ? Math.round(sl.carringtonLon) + '°' : '—'}`;
            const holesVis = (sl?.holes ?? []).filter(h => {
                if (!Number.isFinite(h?.lon_carrington_deg) || !Number.isFinite(sl?.l0NowDeg)) return false;
                const lonW = ((h.lon_carrington_deg - sl.l0NowDeg) % 360 + 540) % 360 - 180;
                return Math.abs(lonW) <= 85 && Math.abs(h.lat_deg ?? 0) <= 80;
            }).length;
            const due = (sl?.recurrence ?? []).filter(f => f.forecast?.daysToArrival < 5).length;
            const flux = Math.min(3, (this._driverN / 6) * (this._driverV / 450));
            const cmeN = (state?.cmes ?? []).length;
            this._drawLabel(this._sunLab, 'SUN — EMISSION STATE', [
                srcLine,
                `${holesVis} CH on disk · ${due} stream${due === 1 ? '' : 's'} due ≤5 d`,
                `puffs ${(2 + 2.2 * flux).toFixed(1)}/s ∝ live n·v at L1`,
                cmeN === 0 ? 'no Earth-directed CMEs in flight'
                    : cmeN === 1 ? '1 CME in flight — see cone label'
                    : `${cmeN} CMEs in flight · nearest shown`,
            ], '#ffd27a');
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
        // Live upstream VBs — the tail sheet's feeding gate (same coupling
        // function that gates injections and the stage-2 tail fork).
        this._driverVbs = Number.isFinite(state?.drivers?.vbs) ? state.drivers.vbs : 0;
        // Sun glow tracks the strongest incoming driver — a storm you can
        // see coming before it arrives (opacity + a breathing pulse in tick).
        const sv = state?.transit?.strongest?.vbs ?? 0;
        this._sunVbsNorm = Math.min(1, sv / 6);
        if (this._sunMat) this._sunMat.opacity = 0.75 + 0.25 * this._sunVbsNorm;
        const now = state?.now;
        if (!now) return;
        this._state = {
            dstStar:      Number.isFinite(now.dstStarModel) ? now.dstStarModel : -10,
            peakL:        Number.isFinite(now.peakL) ? now.peakL : ringPeakL(-10),
            asym:         now.asymmetry || { amplitude: 0, mltPeakHours: 19 },
            plasmapauseL: Number.isFinite(now.plasmapauseL) ? now.plasmapauseL : 4.7,
            // Live injection strength: |Q| ≈ 12 nT/h is already a strong
            // storm main phase — saturate the nightside pulse there.
            injection:    Math.min(1, Math.abs(now.injectionQ ?? 0) / 12),
        };
        // Drive the transport core from the SAME live inputs (Kp, VBs). On the
        // first real sample, schedule a spread spin-up (a few sim-hours run
        // over the next frames) so the pressure layer arrives already reflecting
        // current conditions instead of an empty ring.
        if (this._transport) {
            this._transport.setDriver({
                kp: Number.isFinite(now.kp) ? now.kp : 1,
                vbs: this._driverVbs,
            });
            if (!this._heatSpunUp) { this._heatSpunUp = true; this._heatSpinup = 3 * 3600; }
        }
        // Same live driver into the M-I field core and the fountain — one
        // input, three coupled readouts (HUD bars, teardrop, airglow).
        this._efield.setDriver({
            kp: Number.isFinite(now.kp) ? now.kp : undefined,
            vbs: this._driverVbs,
        });
        this._iono.setDriver({ kp: Number.isFinite(now.kp) ? now.kp : undefined });
        this._setCompositionMix(now.oxygenFraction);
        for (const p of this._popList ?? []) {
            this._syncStateUniforms(p.mat);
            for (const e of p.echoes) this._syncStateUniforms(e.mat);
        }
        // ENA imaging target: emission tracks the trapped-ion content.
        this._enaTarget = Math.min(1, Math.abs(this._state.dstStar) / 120);
        // Live Shue boundary target (eased in _updateBoundaries).
        const mp = state?.now?.magnetopause;
        if (mp && Number.isFinite(mp.r0)) {
            this._mpTarget = {
                r0: Math.max(4.5, Math.min(13, mp.r0)),
                alpha: Math.max(0.4, Math.min(0.85, mp.alpha)),
            };
        }
        // Drive the EarthSkin from the SAME live state as the ring: aurora
        // oval from Kp + southward Bz + ap-proxied hemispheric power, and the
        // skin's ring-current nightside heating glow from this page's own
        // model Dst. Normalisations match earth.html / space-weather-globe
        // (−Bz/30, −Dst/200, (ap−12)/110).
        const bz = state?.drivers?.bz;
        this._skin.setSpaceWeather({
            kp:       Number.isFinite(now.kp) ? now.kp : 0,
            bzSouth:  Number.isFinite(bz) ? Math.max(0, Math.min(1, -bz / 30)) : 0,
            auroraOn: true,
            auroraAW: Number.isFinite(now.apNow) ? Math.max(0, Math.min(1, (now.apNow - 12) / 110)) : 0,
            dstNorm:  Number.isFinite(now.dstModel) ? Math.max(0, Math.min(1, -now.dstModel / 200)) : 0,
        });
        if (Math.abs(this._state.peakL - this._builtPeakL) > 0.12) {
            this._rebuildTorus(this._state.peakL);
        }
        const intensity = Math.min(1, Math.abs(this._state.dstStar) / 150);
        this._torusMat.opacity = 0.06 + 0.22 * intensity;
        this._arcMat.opacity   = 0.30 * intensity * this._state.asym.amplitude;
        const pp = this._state.plasmapauseL;
        this._plasmapause.scale.setScalar(pp / 4.7);
    }

    /** The shared SimClock — the page's τ UI drives this same instance. */
    get clock() { return this._clock; }

    /** Live M-I shielding state { A_drv, A_sh, dA, stagnationL } — the
     *  page's driver-panel bars read this every UI tick. */
    efieldState() { return this._efield.state(); }

    /** The fountain kernel (read-only use: bubble counts, situation text). */
    get ionosphere() { return this._iono; }

    /** The WFC cell engine (read-only: stats, states, why — smoke probes). */
    get cells() { return this._cells; }

    /** Show/hide the Track A ionosphere visuals (airglow + streamlines) —
     *  the teardrop plasmapause is magnetosphere furniture and stays. */
    setIonosphereVisible(on) { this._ionoLayer.setVisible(on); }

    /** Show/hide the Track B regional-state map shell (its hover inspector
     *  gates on the same flag). Independent of the airglow toggle. */
    setCellsMapVisible(on) { this._ionoLayer.setMapVisible(on); }

    /** Legacy spelling kept for probes/back-compat: sets the SimClock τ. */
    setTimeCompression(x) {
        this._clock.setTau(x);
    }

    tick(dt) {
        const wallNow = Date.now();
        const simNow = this._clock.now(wallNow);
        if (this._clock.wraps !== this._seenWraps) {
            // Sweep restarted (wrap or τ change) — don't fire the whole
            // window's arrivals as one burst, and start the wrap dip so the
            // stream fades through the restart instead of teleporting (the
            // "simulation reset" read — it is a REPLAY of the same real
            // window; the page badge flashes the same message).
            this._seenWraps = this._clock.wraps;
            this._lastSimNow = simNow;
            this._wrapT = 0;
        }
        // Sweep-wrap dip: transit-side visuals fade to 15 % and ease back
        // over ~0.8 s. Only rendering opacity — physics is untouched.
        if (this._wrapT < 0.8) {
            this._wrapT += dt;
            const fade = 0.15 + 0.85 * Math.min(1, this._wrapT / 0.8);
            this._transit.material.uniforms.uFade.value = fade;
            this._env.material.uniforms.uFade.value = fade;
            this._windMat.uniforms.uFade.value = fade;
            this._wave.material.opacity = 0.9 * fade;
        }
        const dSimH = this._clock.dSim(dt * 1000) / 3.6e6;   // wall s → sim hours
        this._tView += dt;
        this._simHours += dSimH;
        this._lastDt = dt;
        this._stepTransportLayers(dt, dSimH);
        this._stepIonosphere(dt, dSimH, simNow);
        if (this._enaEnabled && this._enaSweep) {
            this._enaPhase = (this._enaPhase + dt * this._enaSweepRate) % (2 * Math.PI);
            if (this._enaSliderEl) this._enaSliderEl.value = String(Math.round(this._enaPhase / (2 * Math.PI) * 1000));
            this._updateEnaPose();
        }
        // Sun corona breathes with the strongest incoming VBs — a storm you
        // can FEEL approaching before it arrives (cinematic, data-driven).
        this._sun.scale.setScalar(11 * (1 + (0.02 + 0.09 * (this._sunVbsNorm ?? 0))
            * Math.sin(wallNow / 600)));
        // L1 gate: decay the sample pulse (~1.2 s), advance the sweep, and
        // drift the spacecraft along its (period-compressed) Lissajous.
        this._gateMat.uniforms.uPulse.value =
            Math.max(0, this._gateMat.uniforms.uPulse.value - dt / 1.2);
        this._gateMat.uniforms.uTime.value = this._tView;
        this._l1Craft.position.set(
            TRANSIT.X_SUN + 0.3,
            3.4 * Math.sin(this._tView / 41),
            4.2 * Math.cos(this._tView / 53));
        // Section timing (EMA α=0.05): where each frame's CPU goes. ~6
        // performance.now() calls/frame — negligible against what they map.
        const S = this._perf.sections, blend = (k, t0, t1) => { S[k] += (t1 - t0 - S[k]) * 0.05; };
        let tMark = performance.now();
        this._updateGeometry(simNow);
        this._skin.update(this._tView);   // aurora animation clock
        // All trapped-particle motion + lifecycle is in the vertex shader —
        // the per-frame CPU cost of 4 700 particles is two uniform writes
        // per material (drift/lifecycle on SIM hours; bounce on wall — the
        // disclosed ×1 exception, see header). Trail echoes re-draw the same
        // geometry at clocks lagged by k·TRAIL_VIEW_S of VIEWING time — the
        // integrated path, τ-honest (sub-pixel at ×1).
        const lagH = TRAIL_VIEW_S * this._clock.tau / 3600;
        // LOD driver: 0 at ≤26 units (near orbits — unchanged), 1 by ~80
        // (the full Sun-corridor view). Raises the point-size floor and
        // clamped-point brightness, and thickens the trail echoes so the
        // distant ring reads as a discrete flowing river, not dust.
        const lodT = Math.min(1, Math.max(0, (this._camera.position.length() - 26) / 55));
        for (const p of this._popList ?? []) {
            p.mat.uniforms.uDriftHours.value = this._simHours;
            p.mat.uniforms.uBounceSec.value  = this._tView;
            p.mat.uniforms.uMinPx.value      = 1.4 + 1.8 * lodT;
            p.mat.uniforms.uFarBoost.value   = 1.1 * lodT;
            for (const e of p.echoes) {
                e.mat.uniforms.uDriftHours.value = this._simHours - e.k * lagH;
                e.mat.uniforms.uBounceSec.value  = this._tView - e.k * TRAIL_VIEW_S;
                e.mat.uniforms.uMinPx.value      = 1.2 + 1.5 * lodT;
                e.mat.uniforms.uFarBoost.value   = 1.1 * lodT;
                e.mat.uniforms.uOpacity.value    = e.baseOp * (1 + 1.6 * lodT);
            }
        }
        let tNow = performance.now();
        blend('state', tMark, tNow); tMark = tNow;
        this._updateBoundaries(dt);
        this._updateTransit(simNow, wallNow);
        this._detectArrivals(simNow);
        this._lastSimNow = simNow;
        tNow = performance.now();
        blend('transit', tMark, tNow); tMark = tNow;
        this._updateFlashes(dt);
        this._updateInjections(dt, dSimH);
        this._updateSheath(dt);
        this._updateEmission(dt);
        this._updateCmes(simNow);
        this._updateCinematics(dt);
        tNow = performance.now();
        blend('pools', tMark, tNow); tMark = tNow;
        this._updateTooltip(wallNow);
        // Pinned-particle marker rides the SAME reference pose the shader
        // draws (magGroup-local — the group applies the dipole tilt).
        if (this._pinned) {
            const q = particlePose(this._pinned.pop, this._pinned.i,
                this._simHours, this._tView, this._poseScratch);
            this._pinSprite.position.set(q.x, q.y, q.z);
            this._pinSprite.scale.setScalar(0.55 * (1 + 0.15 * Math.sin(this._tView * 4)));
        }
        tNow = performance.now();
        blend('tooltip', tMark, tNow); tMark = tNow;
        // View-preset flight: eased camera + target glide (setView). The
        // 'start' listener nulls this the instant the user grabs the scene.
        if (this._flight) {
            const f = this._flight;
            f.t += dt;
            const k = Math.min(1, f.t / f.dur);
            const e = k * k * (3 - 2 * k);          // smoothstep — gentle both ends
            this._camera.position.lerpVectors(f.p0, f.p1, e);
            this._controls.target.lerpVectors(f.t0, f.t1, e);
            if (k >= 1) this._flight = null;
        }
        this._controls.update();
        this._renderFrame();
        blend('render', tMark, performance.now());
        this._perfCheck(wallNow, dt);
    }

    /** Frame accounting + adaptive quality. Frame-time EMA and a 240-frame
     *  ring buffer (p95); once per second, sustained slowness (EMA > 26 ms
     *  for 4 consecutive checks) steps the quality tier DOWN — never back
     *  up (no flip-flopping):
     *    1 — pixel ratio capped at 1.25
     *    2 — pixel ratio 1.0 + trail echoes off (6 fewer point draws)
     *    3 — wind sheet, ENA halo + pressure envelope off (overdraw)
     *  Physics is NEVER degraded — only rendering cost. Live numbers via
     *  the perf getter feed the page's HUD chip and one-shot telemetry. */
    _perfCheck(wallNow, dt) {
        const p = this._perf;
        const ms = dt * 1000;
        p.frameMs += (ms - p.frameMs) * 0.05;
        p.buf[p.bi] = ms;
        p.bi = (p.bi + 1) % p.buf.length;
        p.bn++;
        if (wallNow - p.lastCheck < 1000) return;
        p.lastCheck = wallNow;
        if (p.frameMs > 26) p.slow++; else p.slow = Math.max(0, p.slow - 1);
        if (p.slow >= 4 && p.tier < 3) {
            p.tier++;
            p.slow = 0;
            if (p.tier === 1) {
                this._renderer.setPixelRatio(Math.min(1.25, window.devicePixelRatio || 1));
                this._resize();
            } else if (p.tier === 2) {
                this._renderer.setPixelRatio(1);
                this._resize();
                for (const P of Object.values(this._popPoints ?? {})) {
                    for (const e of P.echoes) e.points.visible = false;
                }
            } else {
                this._windSheet.visible = false;
                this._enaHalo.visible = false;
                this._env.visible = false;
            }
            console.info(`[ring-current] frame ${p.frameMs.toFixed(1)} ms sustained — quality tier ${p.tier}`);
        }
    }

    /** Live performance snapshot (page HUD + telemetry + probes). */
    get perf() {
        const p = this._perf;
        const n = Math.min(p.bn, p.buf.length);
        let p95 = 0;
        if (n > 10) {
            const arr = Array.from(p.buf.subarray(0, n)).sort((a, b) => a - b);
            p95 = arr[Math.floor(n * 0.95)];
        }
        const r = this._renderer.info.render;
        return {
            fps: p.frameMs > 0 ? 1000 / p.frameMs : 0,
            frameMs: p.frameMs, p95Ms: p95,
            sections: { ...p.sections },
            tier: p.tier,
            pixelRatio: this._renderer.getPixelRatio(),
            drawCalls: r.calls, triangles: r.triangles, points: r.points,
            cells: this._ionoLayer?.detailActive ?? 0,   // active LOD details (§C.4)
        };
    }

    /** Earth spin/tilt + magnetosphere dipole tilt at SIM time — the one
     *  clock. At τ=1 simNow ≡ wall: everything exactly real. At τ>1 the
     *  phase sweeps ≤75 min ahead and wraps with the forecast window, so it
     *  stays near-real while advancing legibly. ~40 flops; fine every frame. */
    _updateGeometry(simNow) {
        const sp = subsolarPoint(simNow);
        this._earthTilt.rotation.z = -sp.latDeg * Math.PI / 180;   // axis by declination
        this._earthSpin.rotation.y = -sp.lonDeg * Math.PI / 180;   // subsolar lon → +X
        this._magGroup.rotation.z  = -dipoleTiltRad(simNow);       // GSM dipole tilt ψ
        this._magGroup.updateMatrixWorld();                        // tooltip picking reads it
    }

    /**
     * Build the additive bloom overlay. Opt out with ?bloom=0 (a cheap safety
     * valve, no UI surface — mirrors the verdict card's ?verdict=0). Failure
     * is non-fatal: the scene simply renders without glow.
     */
    _initBloom(w, h) {
        const params = new URLSearchParams(location.search);
        this._bloomEnabled = params.get('bloom') !== '0';
        if (!this._bloomEnabled || !(w > 0 && h > 0)) { this._bloomEnabled = false; return; }
        try {
            // Tuned for this additive-glow scene: a low luminosity threshold
            // isolates the bright cores (ring torus, plasmapause, aurora oval,
            // injection flashes, hot ion cores) and a soft wide radius blooms
            // them into luminous plasma without washing out the dark backdrop.
            this._bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 1.05, 0.72, 0.2);
            // Offscreen HDR copy of the scene for bloom extraction. HalfFloat
            // so stacked additive particles push past 1.0 and the threshold
            // can pick out genuine cores rather than clipping everything.
            this._rtScene = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
            // Fullscreen additive blit of the pure glow over the untouched
            // base frame (CopyShader = passthrough; AdditiveBlending adds it).
            const blit = new THREE.ShaderMaterial({
                uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
                vertexShader: CopyShader.vertexShader,
                fragmentShader: CopyShader.fragmentShader,
                blending: THREE.AdditiveBlending,
                transparent: true, depthTest: false, depthWrite: false,
            });
            blit.uniforms.opacity.value = 1.0;
            this._bloomBlit = new FullScreenQuad(blit);
        } catch (e) {
            console.warn('[ring-current] bloom overlay unavailable — rendering without glow:', e);
            this._bloomEnabled = false;
            this._bloom = null;
        }
    }

    /**
     * Draw the frame: the untouched transparent base render FIRST (so the
     * .rc-stage CSS gradient still shows through exactly as before), then —
     * on the full-quality tier only — an ADDITIVE bloom overlay so the
     * additive-glow populations read as luminous plasma.
     *
     * We composite the glow ourselves instead of using EffectComposer because
     * UnrealBloomPass's own to-screen path clears the canvas and blits through
     * an OPAQUE material (alpha → 1), which would paint the backdrop black and
     * erase the gradient. Here the base frame is never cleared or recolored;
     * only the blurred bright cores are added on top.
     */
    _renderFrame() {
        const r = this._renderer;
        // Base frame — byte-for-byte the pre-bloom behavior.
        r.render(this._scene, this._camera);
        // Bloom is extra scene-render cost; skip it the moment the adaptive
        // quality system steps down (tier > 0), and when disabled/unavailable.
        if (this._bloomEnabled && this._bloom && this._perf.tier === 0) {
            const prevTarget = r.getRenderTarget();
            const prevAutoClear = r.autoClear;
            // 1) Scene → offscreen HDR target (transparent clear; only luminance
            //    matters for extraction).
            r.setRenderTarget(this._rtScene);
            r.setClearColor(0x000000, 0);
            r.clear();
            r.render(this._scene, this._camera);
            // 2) Highpass + mip blur + composite. With renderToScreen=false the
            //    pure glow lands in renderTargetsHorizontal[0].
            r.autoClear = false;
            this._bloom.renderToScreen = false;
            this._bloom.render(r, this._rtScene, this._rtScene, 0, false);
            // 3) Lay the glow additively over the untouched base frame.
            r.setRenderTarget(null);
            this._bloomBlit.material.uniforms.tDiffuse.value =
                this._bloom.renderTargetsHorizontal[0].texture;
            this._bloomBlit.render(r);
            // Restore renderer state for the next base frame.
            r.autoClear = prevAutoClear;
            r.setRenderTarget(prevTarget);
        }

        // ENA imager overlay — a crisp screen-space instrument panel drawn on
        // top of the finished frame (kept out of the bloom so it stays legible).
        if (this._enaEnabled && this._enaScene) {
            const prevAC = r.autoClear;
            r.autoClear = false;
            r.setRenderTarget(null);
            r.clearDepth();
            r.render(this._enaScene, this._enaCam);
            r.autoClear = prevAC;
        }
    }

    _resize() {
        const w = this._container.clientWidth, h = this._container.clientHeight;
        if (!w || !h) return;
        this._camera.aspect = w / h;
        this._camera.updateProjectionMatrix();
        this._renderer.setSize(w, h);
        if (this._bloom) {
            const dw = this._renderer.domElement.width, dh = this._renderer.domElement.height;
            this._bloom.setSize(dw, dh);
            this._rtScene.setSize(dw, dh);
        }
        this._layoutEna();
    }

    // ── Ring pressure/flux heatmap layer (Stage 2) ───────────────────────────
    //
    // An ADDITIVE, toggleable equatorial sheet coloured by the transport core's
    // (L, MLT) field — perpendicular pressure (nPa) by default, or ion flux —
    // per species. It lives in the magGroup so it tilts with the dipole and
    // shares the scene's GSM frame and MLT convention exactly, and it steps on
    // the shared SimClock from the same live driver as everything else. This is
    // the "planetary magnetospheric ring environment" made visible: the same
    // physics that draws the particles paints the pressure it produces.

    /** Rainbow colour ramp (blue→cyan→green→yellow→red→magenta) matching the
     *  GEMSIS-style P⊥ scale. t∈[0,1] → [r,g,b] 0–255. */
    _heatColormap(t) {
        const S = this._HEAT_STOPS || (this._HEAT_STOPS = [
            [0.00, 8, 16, 120], [0.18, 0, 120, 255], [0.38, 0, 220, 190],
            [0.55, 120, 240, 70], [0.70, 250, 225, 30], [0.85, 255, 110, 20],
            [1.00, 225, 20, 150],
        ]);
        const x = Math.max(0, Math.min(1, t));
        for (let i = 1; i < S.length; i++) {
            if (x <= S[i][0]) {
                const a = S[i - 1], b = S[i];
                const f = (x - a[0]) / (b[0] - a[0] || 1);
                return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
            }
        }
        return [S[S.length - 1][1], S[S.length - 1][2], S[S.length - 1][3]];
    }

    _buildRcHeatmap() {
        const t = this._transport;
        this._heatEnabled = new URLSearchParams(location.search).get('heat') !== '0';
        this._heatSpecies = 'all';
        this._heatQuantity = 'pressure';
        this._heatMax = 0;
        const nL = t.nL, nMlt = t.nMlt;

        // Baked-colour data texture (width=MLT, height=L; row-major i*nMlt+j).
        this._heatData = new Uint8Array(nL * nMlt * 4);
        this._heatTex = new THREE.DataTexture(this._heatData, nMlt, nL, THREE.RGBAFormat);
        this._heatTex.wrapS = THREE.RepeatWrapping;      // MLT is periodic
        this._heatTex.wrapT = THREE.ClampToEdgeWrapping;
        this._heatTex.minFilter = THREE.LinearFilter;
        this._heatTex.magFilter = THREE.LinearFilter;
        this._heatTex.needsUpdate = true;

        const geo = new THREE.RingGeometry(t.cfg.lMin, t.cfg.lMax, 192, 1);
        const mat = new THREE.ShaderMaterial({
            uniforms: {
                uMap: { value: this._heatTex },
                uOpacity: { value: 0.52 },
                uLMin: { value: t.cfg.lMin },
                uLMax: { value: t.cfg.lMax },
            },
            // A translucent contour sheet (like the GEMSIS P⊥ plot), NOT an
            // additive glow — additive + the bloom pass blows the disc out.
            transparent: true, depthWrite: false, depthTest: true,
            side: THREE.DoubleSide, blending: THREE.NormalBlending,
            vertexShader: `
                varying vec2 vXY;
                void main() { vXY = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                precision highp float;
                uniform sampler2D uMap; uniform float uOpacity, uLMin, uLMax;
                varying vec2 vXY;
                const float PI = 3.141592653589793;
                void main() {
                    float L = length(vXY);
                    float lf = (L - uLMin) / (uLMax - uLMin);
                    if (lf < 0.0 || lf > 1.0) discard;
                    // World θ = atan2(z,x); this disc's local +Y → world −Z, so z = −vXY.y.
                    float mlt = 12.0 - atan(-vXY.y, vXY.x) * 12.0 / PI;
                    vec4 c = texture2D(uMap, vec2(fract(mlt / 24.0), lf));
                    float edge = smoothstep(0.0, 0.05, lf) * (1.0 - smoothstep(0.93, 1.0, lf));
                    gl_FragColor = vec4(c.rgb, c.a * uOpacity * edge);
                }`,
        });
        this._heatMesh = new THREE.Mesh(geo, mat);
        this._heatMesh.rotation.x = -Math.PI / 2;   // XY ring → equatorial (XZ) plane
        this._heatMesh.renderOrder = -1;            // under the particles/rings
        this._heatMesh.visible = this._heatEnabled;
        this._magGroup.add(this._heatMesh);

        // Companion MERIDIAN slice (noon–midnight plane) — the GEMSIS P⊥
        // cross-section. Shares the equatorial colour texture: each point maps
        // to its dipole (L, MLT=noon|midnight) and a latitude falloff fades it
        // off the equatorial plane, so it reads as the ring's cross-section.
        this._meridEnabled = new URLSearchParams(location.search).get('merid') !== '0';
        const mmat = new THREE.ShaderMaterial({
            uniforms: {
                uMap: { value: this._heatTex }, uOpacity: { value: 0.5 },
                uLMin: { value: t.cfg.lMin }, uLMax: { value: t.cfg.lMax },
            },
            transparent: true, depthWrite: false, depthTest: true,
            side: THREE.DoubleSide, blending: THREE.NormalBlending,
            vertexShader: 'varying vec2 vXY; void main(){ vXY = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
            fragmentShader: `
                precision highp float;
                uniform sampler2D uMap; uniform float uOpacity, uLMin, uLMax;
                varying vec2 vXY;
                void main() {
                    float r = length(vXY);
                    float lat = atan(vXY.y, abs(vXY.x));         // magnetic latitude
                    float cl = cos(lat);
                    float L = r / (cl * cl);
                    float lf = (L - uLMin) / (uLMax - uLMin);
                    if (lf < 0.0 || lf > 1.0) discard;
                    float mlt = vXY.x >= 0.0 ? 12.0 : 0.0;       // noon (+X) / midnight (−X)
                    vec4 c = texture2D(uMap, vec2(mlt / 24.0, lf));
                    float latF = exp(-(lat * lat) / 0.12);       // fade off the equator
                    float edge = smoothstep(0.0, 0.05, lf) * (1.0 - smoothstep(0.93, 1.0, lf));
                    gl_FragColor = vec4(c.rgb, c.a * uOpacity * latF * edge);
                }`,
        });
        this._meridMesh = new THREE.Mesh(new THREE.PlaneGeometry(2 * t.cfg.lMax, 2 * t.cfg.lMax, 1, 1), mmat);
        this._meridMesh.renderOrder = -1;           // XY plane already = noon-midnight meridian
        this._meridMesh.visible = this._heatEnabled && this._meridEnabled;
        this._magGroup.add(this._meridMesh);

        this._buildHeatPanel();
        this._updateRcHeatmap();
    }

    _buildHeatPanel() {
        if (!document.getElementById('rc-heat-style')) {
            const st = document.createElement('style');
            st.id = 'rc-heat-style';
            st.textContent = `
              .rc-heat-panel{position:absolute;left:12px;bottom:12px;z-index:40;font:11px/1.3 system-ui,sans-serif;
                color:#cdd5e4;background:rgba(3,1,14,.72);border:1px solid rgba(255,255,255,.1);border-radius:8px;
                padding:6px 8px;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);user-select:none;width:172px}
              .rc-heat-panel.rc-off .rc-heat-body{display:none}
              .rc-heat-toggle{font:600 11px system-ui;color:#cdd5e4;background:rgba(255,255,255,.06);
                border:1px solid rgba(255,255,255,.14);border-radius:5px;padding:3px 8px;cursor:pointer;width:100%;margin-bottom:5px}
              .rc-heat-toggle.rc-on{color:#7fe6c3;border-color:rgba(127,230,195,.4);background:rgba(127,230,195,.1)}
              .rc-heat-seg{display:flex;gap:3px;margin-bottom:4px}
              .rc-heat-seg button{flex:1;font:10px system-ui;color:#aeb6c8;background:rgba(255,255,255,.05);
                border:1px solid rgba(255,255,255,.1);border-radius:4px;padding:2px 0;cursor:pointer}
              .rc-heat-seg button.rc-on{color:#fff;background:rgba(120,160,255,.22);border-color:rgba(120,160,255,.5)}
              .rc-heat-canvas{width:100%;height:9px;border-radius:2px;display:block;margin-top:2px}
              .rc-heat-scale{display:flex;justify-content:space-between;font:9px system-ui;color:#8b93a7;margin-top:1px}
              .rc-merid-toggle{font:10px system-ui;color:#aeb6c8;background:rgba(255,255,255,.05);
                border:1px solid rgba(255,255,255,.1);border-radius:4px;padding:3px 0;cursor:pointer;width:100%;margin-top:5px}
              .rc-merid-toggle.rc-on{color:#fff;background:rgba(120,160,255,.22);border-color:rgba(120,160,255,.5)}
              .rc-ena-toggle{font:600 11px system-ui;color:#cdd5e4;background:rgba(255,255,255,.06);
                border:1px solid rgba(255,255,255,.14);border-radius:5px;padding:3px 8px;cursor:pointer;width:100%;margin-bottom:5px}
              .rc-ena-toggle.rc-on{color:#9ecbff;border-color:rgba(158,203,255,.4);background:rgba(158,203,255,.1)}
              .rc-ena-cap{position:absolute;z-index:40;font:10px/1.35 system-ui,sans-serif;text-align:right;
                pointer-events:none;text-shadow:0 1px 3px #000}
              .rc-ena-title{font-weight:700;letter-spacing:.04em;color:#bcd6ff}
              .rc-ena-sub{color:#8b93a7;font-size:9px}
              .rc-ena-ctl{display:flex;gap:6px;align-items:center;justify-content:flex-end;margin-top:3px;pointer-events:auto}
              .rc-ena-play{font:10px system-ui;color:#cdd5e4;background:rgba(255,255,255,.08);
                border:1px solid rgba(255,255,255,.16);border-radius:4px;padding:2px 6px;cursor:pointer;white-space:nowrap}
              .rc-ena-play.rc-on{color:#9ecbff;border-color:rgba(158,203,255,.5);background:rgba(158,203,255,.14)}
              .rc-ena-slider{flex:1;max-width:118px;height:12px;cursor:pointer;accent-color:#9ecbff}`;
            document.head.appendChild(st);
        }
        const params = new URLSearchParams(location.search);
        const enaOn = params.get('ena') !== '0';
        const meridOn = params.get('merid') !== '0';
        const panel = document.createElement('div');
        panel.className = 'rc-heat-panel' + (this._heatEnabled ? '' : ' rc-off');
        panel.innerHTML =
            '<button class="rc-heat-toggle' + (this._heatEnabled ? ' rc-on' : '') +
                '" title="Ring plasma pressure layer (transport model)">◧ Ring plasma</button>' +
            '<button class="rc-ena-toggle' + (enaOn ? ' rc-on' : '') +
                '" title="ENA imager — Roelof-style line-of-sight (dusk, 8 Rᴇ)">◉ ENA imager</button>' +
            '<div class="rc-heat-body">' +
              '<div class="rc-heat-seg rc-heat-sp">' +
                '<button data-sp="all" class="rc-on">All</button><button data-sp="hydrogen">H⁺</button>' +
                '<button data-sp="oxygen">O⁺</button><button data-sp="helium">He⁺</button></div>' +
              '<div class="rc-heat-seg rc-heat-q">' +
                '<button data-q="pressure" class="rc-on">P⊥</button><button data-q="flux">Flux</button></div>' +
              '<canvas class="rc-heat-canvas" width="150" height="9"></canvas>' +
              '<div class="rc-heat-scale"><span>0</span><span class="rc-heat-max">— nPa</span></div>' +
              '<button class="rc-merid-toggle' + (meridOn ? ' rc-on' : '') +
                '" title="Noon–midnight meridian cross-section (GEMSIS-style)">◨ Meridian slice</button>' +
            '</div>';
        this._container.appendChild(panel);
        this._heatPanel = panel;
        this._heatMaxEl = panel.querySelector('.rc-heat-max');
        // Colour-bar swatch.
        const cv = panel.querySelector('.rc-heat-canvas');
        const cx = cv.getContext('2d');
        for (let x = 0; x < cv.width; x++) {
            const [r, g, b] = this._heatColormap(x / (cv.width - 1));
            cx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
            cx.fillRect(x, 0, 1, cv.height);
        }
        // Wiring.
        panel.querySelector('.rc-heat-toggle').addEventListener('click', (e) => {
            this.setHeatmapEnabled(!this._heatEnabled);
            e.currentTarget.classList.toggle('rc-on', this._heatEnabled);
        });
        panel.querySelectorAll('.rc-heat-sp button').forEach(b =>
            b.addEventListener('click', () => this.setHeatmapSpecies(b.dataset.sp)));
        panel.querySelectorAll('.rc-heat-q button').forEach(b =>
            b.addEventListener('click', () => this.setHeatmapQuantity(b.dataset.q)));
        this._enaTogEl = panel.querySelector('.rc-ena-toggle');
        this._enaTogEl.addEventListener('click', () => this.setEnaEnabled(!this._enaEnabled));
        this._meridTogEl = panel.querySelector('.rc-merid-toggle');
        this._meridTogEl.addEventListener('click', () => this.setMeridianEnabled(!this._meridEnabled));
    }

    /** Highlight the active button in a panel segment (keeps UI ↔ state synced
     *  whether the change came from a click or a programmatic call). */
    _heatMark(cls, attr, val) {
        this._heatPanel?.querySelectorAll(`.${cls} button`).forEach(b =>
            b.classList.toggle('rc-on', b.dataset[attr] === val));
    }

    /** Re-bake the data texture from the transport's current (L,MLT) field. */
    _updateRcHeatmap() {
        if (!this._heatMesh) return;
        const field = this._heatQuantity === 'flux'
            ? this._transport.equatorialMap(this._heatSpecies, 'content')
            : this._transport.pressureMap(this._heatSpecies);
        let mx = 0;
        for (let n = 0; n < field.length; n++) if (field[n] > mx) mx = field[n];
        const floor = this._heatQuantity === 'flux' ? 1e-30 : 0.05;   // nPa / rel floor
        mx = Math.max(mx, floor);
        // Eased colour-bar top so it tracks the storm without flickering.
        this._heatMax = this._heatMax ? this._heatMax + (mx - this._heatMax) * 0.1 : mx;
        const inv = 1 / this._heatMax;
        const data = this._heatData;
        for (let n = 0; n < field.length; n++) {
            let v = field[n] * inv; if (v < 0) v = 0; else if (v > 1) v = 1;
            const c = this._heatColormap(v);
            const o = n * 4;
            data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2];
            data[o + 3] = Math.round(255 * Math.pow(v, 0.85));   // faint low → opaque high
        }
        this._heatTex.needsUpdate = true;
        if (this._heatMaxEl) {
            this._heatMaxEl.textContent = this._heatQuantity === 'flux'
                ? 'rel. flux' : `${this._heatMax.toFixed(1)} nPa`;
        }
    }

    /** Step the transport on the SimClock (throttled ~15 Hz) and refresh every
     *  ENABLED transport-driven layer (pressure heatmap, ENA imager). The
     *  one-time spin-up spreads a few sim-hours over the first frames so the
     *  ring arrives populated. Sheds load below quality tier 2. */
    _stepTransportLayers(dt, dSimH) {
        if (!this._transport) return;
        if (!this._heatEnabled && !this._enaEnabled) return;
        if (this._perf.tier >= 2) return;
        this._heatSimAcc = (this._heatSimAcc || 0) + dSimH * 3600;
        this._heatWallAcc = (this._heatWallAcc || 0) + dt;
        if (this._heatWallAcc < 1 / 15) return;
        let simStep = this._heatSimAcc;
        if (this._heatSpinup > 0) {
            const chunk = Math.min(this._heatSpinup, 900);
            simStep += chunk; this._heatSpinup -= chunk;
        }
        if (simStep > 0) this._transport.step(simStep);
        this._heatWallAcc = 0; this._heatSimAcc = 0;
        if (this._heatEnabled && this._heatMesh) this._updateRcHeatmap();
        if (this._enaEnabled && this._enaPanel) this._updateEnaImager();
    }

    setHeatmapEnabled(on) {
        this._heatEnabled = !!on;
        if (this._heatMesh) this._heatMesh.visible = this._heatEnabled;
        if (this._meridMesh) this._meridMesh.visible = this._heatEnabled && this._meridEnabled;
        this._heatPanel?.classList.toggle('rc-off', !this._heatEnabled);
    }

    setMeridianEnabled(on) {
        this._meridEnabled = !!on;
        if (this._meridMesh) this._meridMesh.visible = this._heatEnabled && this._meridEnabled;
        this._meridTogEl?.classList.toggle('rc-on', this._meridEnabled);
    }

    setHeatmapSpecies(key) {
        this._heatSpecies = key; this._heatMax = 0;
        this._heatMark('rc-heat-sp', 'sp', key);
        this._updateRcHeatmap();
    }

    setHeatmapQuantity(q) {
        this._heatQuantity = q; this._heatMax = 0;
        this._heatMark('rc-heat-q', 'q', q);
        this._updateRcHeatmap();
    }

    // ── ENA imager (Stage 3 — Roelof & Williams 1988) ────────────────────────
    //
    // A virtual Energetic-Neutral-Atom camera on a MOVABLE vantage — an
    // eccentric polar orbit (Roelof's Fig 17) the user can sweep, watching the
    // ENA morphology change with viewing geometry (Fig 18's latitude series).
    // Each output pixel casts a ray through the ring current and integrates the
    // ENA line-of-sight emission in a SHADER:
    //     j_ENA(dir) = ∫ Σ_species j_ion·σ_cx·n_H(r) ds
    // The equatorial ion×σ_cx factor comes from the transport core
    // (enaEmissivityMap → a data texture); the ray-march applies the
    // geocoronal density n_H(r), an equatorial (mirroring) latitude falloff,
    // and the path integral, then log-scales over ×100 (2 decades below the
    // peak) exactly as the paper's colour bar. Shown as a screen-space
    // instrument panel, with the vantage + view frustum marked in 3D.

    _buildEnaImager() {
        const t = this._transport;
        this._enaEnabled = new URLSearchParams(location.search).get('ena') !== '0';
        const nL = t.nL, nMlt = t.nMlt;

        // Equatorial emissivity source texture (normalised 0..1 in R).
        this._enaData = new Uint8Array(nL * nMlt * 4);
        this._enaTex = new THREE.DataTexture(this._enaData, nMlt, nL, THREE.RGBAFormat);
        this._enaTex.wrapS = THREE.RepeatWrapping;
        this._enaTex.wrapT = THREE.ClampToEdgeWrapping;
        this._enaTex.minFilter = THREE.LinearFilter;
        this._enaTex.magFilter = THREE.LinearFilter;
        this._enaTex.needsUpdate = true;
        this._enaAbsMax = 0;

        // Movable vantage on an eccentric polar orbit (Roelof Fig 17). The pose
        // is a function of the orbit phase, recomputed every frame by
        // _updateEnaPose; here we just set the defaults.
        this._enaTan = Math.tan(46 * Math.PI / 180);
        this._enaPhase = 2.15;                     // ~dusk-north — an interesting default
        this._enaSweep = false;
        this._enaSweepRate = 2 * Math.PI / 24;     // full orbit ≈ 24 s

        const ENA_FRAG = `
            precision highp float;
            varying vec2 vUv;
            uniform sampler2D uEmiss;
            uniform vec3 uImgPos, uRight, uUp, uFwd;
            uniform float uTan, uLMin, uLMax, uEnaMax, uActive;
            const float PI = 3.141592653589793;
            vec3 cmap(float t){
                t = clamp(t, 0.0, 1.0);
                vec3 c = mix(vec3(0.02,0.02,0.16), vec3(0.0,0.42,0.95), smoothstep(0.0,0.25,t));
                c = mix(c, vec3(0.0,0.85,0.72), smoothstep(0.20,0.45,t));
                c = mix(c, vec3(0.55,0.95,0.20), smoothstep(0.40,0.60,t));
                c = mix(c, vec3(1.0,0.85,0.12), smoothstep(0.56,0.75,t));
                c = mix(c, vec3(1.0,0.36,0.10), smoothstep(0.72,0.90,t));
                c = mix(c, vec3(1.0,0.92,0.88), smoothstep(0.88,1.00,t));
                return c;
            }
            void main(){
                vec3 bg = vec3(0.03, 0.02, 0.09);
                float b = min(min(vUv.x, 1.0-vUv.x), min(vUv.y, 1.0-vUv.y));
                if (b < 0.010) { gl_FragColor = vec4(0.30,0.45,0.72,0.92); return; }   // frame
                if (vUv.y < 0.085) {                                                   // colour bar
                    float c = clamp((vUv.x-0.06)/0.88, 0.0, 1.0);
                    gl_FragColor = vec4(cmap(c), 0.96); return;
                }
                vec2 iuv = vec2((vUv.x-0.04)/0.92, (vUv.y-0.10)/0.87);
                if (iuv.x<0.0||iuv.x>1.0||iuv.y<0.0||iuv.y>1.0 || uActive<0.5) { gl_FragColor=vec4(bg,0.9); return; }
                vec2 sc = iuv*2.0 - 1.0;
                vec3 dir = normalize(uFwd + sc.x*uTan*uRight + sc.y*uTan*uUp);
                float acc = 0.0;
                const int N = 88; float s0=2.0, s1=20.0, ds=(s1-s0)/float(N);
                for (int i=0;i<N;i++){
                    float s = s0 + (float(i)+0.5)*ds;
                    vec3 p = uImgPos + dir*s;
                    float r = length(p);
                    if (r<1.25 || r>12.0) continue;
                    float rho = length(p.xz);
                    float lat = atan(p.y, rho);
                    float cl = cos(lat);
                    float L = r/(cl*cl);
                    if (L<uLMin || L>uLMax) continue;
                    float mlt = 12.0 - atan(p.z, p.x)*12.0/PI;
                    float eps = texture2D(uEmiss, vec2(fract(mlt/24.0), (L-uLMin)/(uLMax-uLMin))).r;
                    float latF = exp(-(lat*lat)/0.10);          // equatorial concentration
                    float nH = pow(max(1.05, r), -3.5);         // geocorona
                    acc += eps * latF * nH * ds;
                }
                float t = 0.0;
                if (acc > 1e-9) { float lo=log(uEnaMax/100.0), hi=log(uEnaMax); t=clamp((log(acc)-lo)/(hi-lo),0.0,1.0); }
                gl_FragColor = vec4(t<=0.002 ? bg : cmap(t), 0.92);
            }`;

        this._enaCam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
        this._enaScene = new THREE.Scene();
        const mat = new THREE.ShaderMaterial({
            uniforms: {
                uEmiss: { value: this._enaTex },
                uImgPos: { value: new THREE.Vector3() }, uRight: { value: new THREE.Vector3() },
                uUp: { value: new THREE.Vector3() }, uFwd: { value: new THREE.Vector3() },
                uTan: { value: this._enaTan }, uLMin: { value: t.cfg.lMin }, uLMax: { value: t.cfg.lMax },
                uEnaMax: { value: 0.03 }, uActive: { value: 1 },
            },
            transparent: true, depthTest: false, depthWrite: false,
            vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
            fragmentShader: ENA_FRAG,
        });
        this._enaPanel = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        this._enaPanel.frustumCulled = false;
        this._enaScene.add(this._enaPanel);

        // 3D vantage marker + view frustum + the orbit path (dipole frame, so
        // they tilt with the dipole). Marker/frustum move with the phase.
        const grp = new THREE.Group();
        this._enaMarkerMesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.26),
            new THREE.MeshBasicMaterial({ color: 0x9ecbff }));
        grp.add(this._enaMarkerMesh);
        this._enaFrustumGeo = new THREE.BufferGeometry();
        this._enaFrustumGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(16 * 3), 3));
        grp.add(new THREE.LineSegments(this._enaFrustumGeo,
            new THREE.LineBasicMaterial({ color: 0x5fb8ff, transparent: true, opacity: 0.32 })));
        const opos = [];
        for (let i = 0; i <= 96; i++) { const p = this._enaOrbit((i / 96) * 2 * Math.PI).pos; opos.push(p.x, p.y, p.z); }
        const og = new THREE.BufferGeometry();
        og.setAttribute('position', new THREE.Float32BufferAttribute(opos, 3));
        grp.add(new THREE.Line(og, new THREE.LineBasicMaterial({ color: 0x3f6f9f, transparent: true, opacity: 0.4 })));
        grp.visible = this._enaEnabled;
        this._enaMarker = grp;
        this._magGroup.add(grp);

        this._buildEnaCaption();
        this._layoutEna();
        this._updateEnaPose();
        this._updateEnaImager();
    }

    /**
     * Imager position on the eccentric polar orbit (Roelof Fig 17) at true
     * anomaly `phase`. Apogee ≈9.5 R_E (north), perigee ≈2.4 R_E (south), in
     * the dusk–north meridian plane (x≈0): perigee toward −Y (south), quadrature
     * toward −Z (dusk). Sweeping phase runs south→dusk→north→dawn, so the ENA
     * viewing geometry runs through the full Fig-18 latitude/distance series.
     */
    _enaOrbit(phase) {
        const a = 5.95, e = 0.6;                    // apogee a(1+e)=9.5, perigee a(1−e)=2.38
        const r = a * (1 - e * e) / (1 + e * Math.cos(phase));
        const pos = new THREE.Vector3(0, -r * Math.cos(phase), -r * Math.sin(phase));
        const mlatDeg = Math.atan2(pos.y, Math.hypot(pos.x, pos.z)) * 180 / Math.PI;
        return { pos, r, mlatDeg };
    }

    /** Place the imager (shader uniforms + 3D marker/frustum + readout) from the
     *  current orbit phase. Cheap — safe to call every frame while sweeping. */
    _updateEnaPose() {
        if (!this._enaPanel) return;
        const { pos, r, mlatDeg } = this._enaOrbit(this._enaPhase);
        const fwd = pos.clone().negate().normalize();
        // Avoid the degenerate up-reference when looking along ±Y (over a pole).
        const refUp = Math.abs(fwd.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3().crossVectors(refUp, fwd).normalize();
        const up = new THREE.Vector3().crossVectors(fwd, right).normalize();
        const u = this._enaPanel.material.uniforms;
        u.uImgPos.value.copy(pos); u.uFwd.value.copy(fwd);
        u.uRight.value.copy(right); u.uUp.value.copy(up);
        if (this._enaMarkerMesh) this._enaMarkerMesh.position.copy(pos);
        this._updateEnaFrustum(pos, fwd, right, up);
        if (this._enaVantEl) {
            const hemi = mlatDeg >= 0 ? 'N' : 'S';
            this._enaVantEl.textContent = `${Math.abs(mlatDeg).toFixed(0)}°${hemi} · ${r.toFixed(1)} Rᴇ`;
        }
    }

    _updateEnaFrustum(pos, fwd, right, up) {
        if (!this._enaFrustumGeo) return;
        const far = 13, tan = this._enaTan;
        const fp = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => fwd.clone()
            .add(right.clone().multiplyScalar(a * tan))
            .add(up.clone().multiplyScalar(c * tan)).normalize().multiplyScalar(far).add(pos));
        const arr = this._enaFrustumGeo.attributes.position.array;
        let k = 0; const put = (v) => { arr[k++] = v.x; arr[k++] = v.y; arr[k++] = v.z; };
        for (let i = 0; i < 4; i++) { put(pos); put(fp[i]); }
        for (let i = 0; i < 4; i++) { put(fp[i]); put(fp[(i + 1) % 4]); }
        this._enaFrustumGeo.attributes.position.needsUpdate = true;
    }

    _buildEnaCaption() {
        const cap = document.createElement('div');
        cap.className = 'rc-ena-cap';
        cap.style.display = this._enaEnabled ? 'block' : 'none';
        cap.innerHTML =
            '<div class="rc-ena-title">ENA IMAGER · <span class="rc-ena-vant">—</span></div>' +
            '<div class="rc-ena-sub">charge-exchange · log ×100 · <span class="rc-ena-max">—</span></div>' +
            '<div class="rc-ena-ctl">' +
              '<button class="rc-ena-play" title="Sweep the orbit (Roelof Fig 17)">▶ sweep</button>' +
              '<input class="rc-ena-slider" type="range" min="0" max="1000" value="0" aria-label="orbit phase">' +
            '</div>';
        this._container.appendChild(cap);
        this._enaCap = cap;
        this._enaMaxEl = cap.querySelector('.rc-ena-max');
        this._enaVantEl = cap.querySelector('.rc-ena-vant');
        this._enaSliderEl = cap.querySelector('.rc-ena-slider');
        this._enaPlayEl = cap.querySelector('.rc-ena-play');
        this._enaSliderEl.value = String(Math.round(this._enaPhase / (2 * Math.PI) * 1000));
        this._enaPlayEl.addEventListener('click', () => {
            this._enaSweep = !this._enaSweep;
            this._enaPlayEl.textContent = this._enaSweep ? '❚❚ sweep' : '▶ sweep';
            this._enaPlayEl.classList.toggle('rc-on', this._enaSweep);
        });
        this._enaSliderEl.addEventListener('input', () => {
            this._enaSweep = false;
            this._enaPlayEl.textContent = '▶ sweep'; this._enaPlayEl.classList.remove('rc-on');
            this._enaPhase = (Number(this._enaSliderEl.value) / 1000) * 2 * Math.PI;
            this._updateEnaPose();
        });
    }

    /** Position the screen-space ENA panel (kept square) + its caption. Sits
     *  bottom-CENTRE of the stage: the WebGL overlay draws under the HTML docks
     *  (legend top-right, analytics right, heat panel bottom-left), so it must
     *  live in the clear strip between them. */
    _layoutEna() {
        if (!this._enaPanel) return;
        const w = this._container.clientWidth || 1280, h = this._container.clientHeight || 800;
        const px = Math.max(140, Math.min(230, Math.min(w, h) * 0.30));
        const sx = px / w, sy = px / h;
        const cx = 0.45;                 // centre fraction, clear of both docks
        this._enaPanel.scale.set(sx, sy, 1);
        this._enaPanel.position.set(cx, 12 / h + sy / 2, 0);
        if (this._enaCap) {
            this._enaCap.style.right = ((1 - (cx + sx / 2)) * w) + 'px';
            this._enaCap.style.bottom = (px + 16) + 'px';
            this._enaCap.style.width = px + 'px';
        }
    }

    /** Re-bake the emissivity texture and refresh the imager readout. */
    _updateEnaImager() {
        if (!this._enaPanel) return;
        const emap = this._transport.enaEmissivityMap();
        let mx = 0;
        for (let n = 0; n < emap.length; n++) if (emap[n] > mx) mx = emap[n];
        const active = mx > 1e-30;
        this._enaAbsMax = this._enaAbsMax ? this._enaAbsMax + (mx - this._enaAbsMax) * 0.1 : mx;
        const inv = this._enaAbsMax > 0 ? 1 / this._enaAbsMax : 0;
        const d = this._enaData;
        for (let n = 0; n < emap.length; n++) {
            let v = emap[n] * inv; if (v < 0) v = 0; else if (v > 1) v = 1;
            const bb = (v * 255) | 0; const o = n * 4;
            d[o] = bb; d[o + 1] = bb; d[o + 2] = bb; d[o + 3] = 255;
        }
        this._enaTex.needsUpdate = true;
        this._enaPanel.material.uniforms.uActive.value = active ? 1 : 0;
        if (this._enaMaxEl) {
            const dst = this._transport.dstStar();
            this._enaMaxEl.textContent = active ? `MAX @ Dst* ${dst.toFixed(0)} nT` : 'quiet';
        }
    }

    setEnaEnabled(on) {
        this._enaEnabled = !!on;
        if (this._enaMarker) this._enaMarker.visible = this._enaEnabled;
        if (this._enaCap) this._enaCap.style.display = this._enaEnabled ? 'block' : 'none';
        this._enaTogEl?.classList.toggle('rc-on', this._enaEnabled);
    }

    dispose() {
        this._disposed = true;
        cancelAnimationFrame(this._raf);
        window.removeEventListener('resize', this._onResize);
        this._renderer.domElement.removeEventListener('pointermove', this._onPointerMove);
        this._renderer.domElement.removeEventListener('pointerleave', this._onPointerLeave);
        this._renderer.domElement.removeEventListener('pointerdown', this._onPointerDown);
        window.removeEventListener('pointerup', this._onPointerUp);
        this._tipEl?.remove();
        this._scene.traverse(o => {
            o.geometry?.dispose?.();
            if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
        });
        this._bloom?.dispose?.();
        this._rtScene?.dispose?.();
        this._bloomBlit?.dispose?.();
        this._heatTex?.dispose?.();
        this._heatPanel?.remove();
        this._ionoLayer?.dispose?.();
        this._enaTex?.dispose?.();
        this._enaPanel?.geometry?.dispose?.();
        this._enaPanel?.material?.dispose?.();
        this._enaCap?.remove();
        this._renderer.dispose();
        this._renderer.domElement.remove();
    }
}
