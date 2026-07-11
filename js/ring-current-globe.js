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
 *   plasmapause    thin cyan ring at Carpenter–Anderson Lpp(Kp)
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
    sunDepartureMs,
} from './ring-current-model.js';
import {
    buildPopulation, POPULATIONS, particlePose, hash1, DEATH_WINDOW,
} from './ring-current-particles.js';
import { SimClock, SCALE, apparentUnitsPerSec } from './sim-clock.js';
import { EarthSkin } from './earth-skin.js';

const ION_COLOR      = new THREE.Color(1.00, 0.62, 0.22);   // H⁺ (solar wind)
const ION_O_COLOR    = new THREE.Color(0.58, 1.00, 0.34);   // O⁺ (ionospheric outflow)
const ELECTRON_COLOR = new THREE.Color(0.35, 0.75, 1.00);

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
        uniforms: { uSize: { value: size } },
        vertexShader: `uniform float uSize; varying vec3 vC;
            void main() {
                vC = color;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = uSize * 320.0 / -mv.z;
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: `varying vec3 vC;
            void main() {
                float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
                float a = exp(-4.5 * r * r) - 0.011;
                if (a <= 0.0) discard;
                gl_FragColor = vec4(vC * (1.0 + 0.7 * (1.0 - r)), a * ${opacity.toFixed(2)});
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
        },
        vertexShader: `
            uniform float uSize, uDriftHours, uBounceSec, uDstStar,
                          uAsymAmp, uAsymMlt, uMix, uInjection, uVisFrac;
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
                gl_PointSize = uSize * 320.0 / -mv.z;
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
                // Energy tint within the species color: 20 keV = deeper and
                // dimmer, 250 keV = paler, pushed toward white. Subtle — the
                // species hue still dominates.
                vec3 c = mix(uColor * 0.78,
                             min(vec3(1.0), uColor * 1.18 + vec3(0.22, 0.18, 0.12)),
                             vE);
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
        side: THREE.DoubleSide,
        uniforms: {
            uData: { value: dataTex },
            uXmp:  { value: SCALE.CORRIDOR.X_MP },
            uSpan: { value: SCALE.CORRIDOR.SPAN },
            uFlow: { value: 0 },     // wave phase — advanced at τ-scaled speed
            uTime: { value: 0 },     // wall seconds (crackle flicker)
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
            uniform float uXmp, uSpan, uFlow, uTime;
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
                float b = (0.12 + 1.25 * n) * wave * body * d.a;
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

        this._controls = new OrbitControls(this._camera, this._renderer.domElement);
        this._controls.enableDamping = true;
        this._controls.dampingFactor = 0.06;
        this._controls.minDistance = 2.5;
        this._controls.maxDistance = 140;   // far enough to frame the Sun corridor

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

        this._buildEarth();
        this._buildFieldLines();
        this._buildParticles();
        this._buildRings();
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
        this._pendingMix = 0.06; // quiet-time O⁺ energy mix until first state
        const styles = {
            ionsH:     { color: ION_COLOR,      size: 0.085 },
            ionsO:     { color: ION_O_COLOR,    size: 0.095 },
            electrons: { color: ELECTRON_COLOR, size: 0.060 },
        };
        const addPop = (key, pop) => {
            if (this._disposed) return;
            this._popPoints[key] = this._makePoints(pop, styles[key].color, styles[key].size);
            this._setCompositionMix(this._pendingMix);
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
            echoes.push({ mat: em, k, points: ep });
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

        this._ppMat = new THREE.MeshBasicMaterial({
            color: 0x59e0d8, transparent: true, opacity: 0.35, depthWrite: false,
        });
        this._plasmapause = new THREE.Mesh(new THREE.TorusGeometry(4.7, 0.018, 8, 160), this._ppMat);
        this._plasmapause.rotation.x = Math.PI / 2;
        this._magGroup.add(this._plasmapause);

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
        const waveSamples = [];   // {x, nNorm, R, G, B} — x-sorted below
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
                    const fade = (1 - 0.62 * tFrac) * this._transitEnv[slot * stride + k];
                    pos[j]     = x + off[j] * 0.5 + tFrac * trail;
                    pos[j + 1] = off[j + 1];
                    pos[j + 2] = off[j + 2];
                    col[j]     = R * bright * fade;
                    col[j + 1] = G * bright * fade;
                    col[j + 2] = B * bright * fade;
                } else {
                    pos[j] = pos[j + 1] = pos[j + 2] = 0;
                    col[j] = col[j + 1] = col[j + 2] = 0;
                }
            }
            this._slotParcel[slot] = p;   // hover tooltip lookup
            waveSamples.push({
                x, nNorm, R, G, B,
                // Wind-sheet profile channels: Bz southness (−15 nT → 1,
                // +15 → 0) and speed norm for local wave advection.
                south: Math.max(0, Math.min(1, 0.5 - (Number.isFinite(p.bz) ? p.bz : 0) / 30)),
                vNorm: Math.max(0, Math.min(1, ((Number.isFinite(p.v) ? p.v : 400) - 250) / 650)),
            });
            slot++;
        }
        // ── Wind-sheet profile: splat the parcels into the 128-bin texture
        //    (max-blend, ±2-bin tent) — the shader turns this into the
        //    glowing medium with waves, fronts, and Bz coloring. ────────────
        const bins = this._windBins, wd = this._windData;
        wd.fill(0);
        let vSum = 0;
        for (const s of waveSamples) {
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
        const meanV = waveSamples.length ? 250 + 650 * (vSum / waveSamples.length) : 400;
        this._windMat.uniforms.uFlow.value =
            (this._windMat.uniforms.uFlow.value +
             (this._lastDt ?? 0.016) * apparentUnitsPerSec(meanV, SCALE.CORRIDOR.kmPerUnit, tau) * 2.4)
            % (Math.PI * 2000);
        this._windMat.uniforms.uTime.value = wallNow / 1000 % 3600;
        // Barometric trace + envelope, x-sorted (overtaking can reorder
        // parcels relative to arrival order — the trace is n(x), not n(t)).
        waveSamples.sort((a, b) => a.x - b.x);
        let wi = 0;
        for (const s of waveSamples) {
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
        };
        this._injCursor = 0;
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
        for (let c = 0; c < count; c++) {
            // Ring cursor; skip slots still alive (pool full ⇒ drop, not grow).
            let i = -1;
            for (let probe = 0; probe < INJECT.CAP; probe++) {
                const j = (this._injCursor + probe) % INJECT.CAP;
                if (inj.mode[j] === 0) { i = j; this._injCursor = j + 1; break; }
            }
            if (i < 0) return;
            inj.mode[i]    = 1;
            // The burst FORKS by charge: the ENTRY surge is E×B convection
            // (charge-independent — both species pour in together), then
            // gradient–curvature drift takes over at the trapping point and
            // splits it: ions curve WEST toward dusk, electrons EAST toward
            // dawn — the classic dispersionless-injection signature seen at
            // geosynchronous satellites.
            const electron = Math.random() < 0.35;
            inj.species[i] = electron ? 1 : 0;
            inj.theta[i]   = Math.PI + (Math.random() - 0.5) * 1.4;   // ~21–03 MLT
            inj.r[i]       = 7.8 + Math.random() * 1.6;
            inj.targetL[i] = Math.max(2.2, lpp - 0.4 - Math.random() * 1.6);
            const eKev     = 30 + 220 * Math.random() ** 2;
            // Scene-θ sign: westward = θ increasing in the GSM frame (#917
            // was written for the pre-fix mirrored frame — sign re-derived).
            inj.rate[i]    = -driftRateRadPerHour(eKev, inj.targetL[i], electron ? 'electron' : 'ion');
            inj.age[i]     = 0;
            inj.yAmp[i]    = (Math.random() - 0.5) * 0.7;
            inj.bPh[i]     = Math.random() * 2 * Math.PI;
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
        this._onPointerDown = () => { this._dragging = true; this._tipEl.style.display = 'none'; };
        this._onPointerUp = () => { this._dragging = false; };
        dom.addEventListener('pointermove', this._onPointerMove);
        dom.addEventListener('pointerleave', this._onPointerLeave);
        dom.addEventListener('pointerdown', this._onPointerDown);
        window.addEventListener('pointerup', this._onPointerUp);
    }

    _updateTooltip(wallNow) {
        if (!this._pointerDirty || !this._pointerPx || this._dragging) return;
        // Pose-projection picking is ~4700 trig evals + allocs — cap it at
        // ~14 Hz (pointerDirty stays set, so the pick lands a frame later;
        // imperceptible against a 12 px hit radius).
        if (wallNow - (this._lastPickMs ?? 0) < 70) return;
        this._lastPickMs = wallNow;
        this._pointerDirty = false;
        const rect = this._renderer.domElement.getBoundingClientRect();

        // Ring populations: pose-project every particle (a few thousand
        // trig evals, pointer-move-throttled), nearest within 12 px wins.
        let best = null;
        for (const [key, P] of Object.entries(this._popPoints ?? {})) {
            const pop = P.pop;
            const visFrac = P.mat.uniforms.uVisFrac.value;
            for (let i = 0; i < pop.count; i++) {
                if (hash1(pop.life[i * 4 + 3] * 0.517) >= visFrac) continue;  // hidden (Dst gate)
                const q = particlePose(pop, i, this._simHours, this._tView);
                this._tmpV.set(q.x, q.y, q.z)
                    .applyMatrix4(this._magGroup.matrixWorld)
                    .project(this._camera);
                const px = (this._tmpV.x + 1) / 2 * rect.width;
                const py = (1 - this._tmpV.y) / 2 * rect.height;
                const d2 = (px - this._pointerPx.x) ** 2 + (py - this._pointerPx.y) ** 2;
                if (d2 < 144 && (!best || d2 < best.d2)) best = { kind: 'ring', key, P, i, q, d2 };
            }
        }
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

        if (!best) { this._tipEl.style.display = 'none'; return; }
        const fmt = (x, d, u) => Number.isFinite(x) ? `${x.toFixed(d)}${u}` : '—';
        let html;
        if (best.kind === 'ring') {
            const { pop } = best.P, i = best.i, q = best.q;
            const names = { ionsH: ['H⁺ ion', '#ffa040'], ionsO: ['O⁺ ion', '#94ff57'],
                            electrons: ['Electron', '#59baff'] };
            const [name, color] = names[best.key];
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
                `light does the trip in ${sl.lightMin.toFixed(1)} min`,
                `Sun rotated ${Number.isFinite(sl.sourceRotDeg) ? Math.round(sl.sourceRotDeg) : '—'}° during transit`,
            ], '#9ecbff');
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
        this._setCompositionMix(now.oxygenFraction);
        for (const p of Object.values(this._popPoints ?? {})) {
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

    /** Legacy spelling kept for probes/back-compat: sets the SimClock τ. */
    setTimeCompression(x) {
        this._clock.setTau(x);
    }

    tick(dt) {
        const wallNow = Date.now();
        const simNow = this._clock.now(wallNow);
        if (this._clock.wraps !== this._seenWraps) {
            // Sweep restarted (wrap or τ change) — don't fire the whole
            // window's arrivals as one burst.
            this._seenWraps = this._clock.wraps;
            this._lastSimNow = simNow;
        }
        const dSimH = this._clock.dSim(dt * 1000) / 3.6e6;   // wall s → sim hours
        this._tView += dt;
        this._simHours += dSimH;
        this._lastDt = dt;
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
        for (const p of Object.values(this._popPoints ?? {})) {
            p.mat.uniforms.uDriftHours.value = this._simHours;
            p.mat.uniforms.uBounceSec.value  = this._tView;
            for (const e of p.echoes) {
                e.mat.uniforms.uDriftHours.value = this._simHours - e.k * lagH;
                e.mat.uniforms.uBounceSec.value  = this._tView - e.k * TRAIL_VIEW_S;
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
        this._updateCinematics(dt);
        tNow = performance.now();
        blend('pools', tMark, tNow); tMark = tNow;
        this._updateTooltip(wallNow);
        tNow = performance.now();
        blend('tooltip', tMark, tNow); tMark = tNow;
        this._controls.update();
        this._renderer.render(this._scene, this._camera);
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
        this._renderer.domElement.removeEventListener('pointermove', this._onPointerMove);
        this._renderer.domElement.removeEventListener('pointerleave', this._onPointerLeave);
        this._renderer.domElement.removeEventListener('pointerdown', this._onPointerDown);
        window.removeEventListener('pointerup', this._onPointerUp);
        this._tipEl?.remove();
        this._scene.traverse(o => {
            o.geometry?.dispose?.();
            if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
        });
        this._renderer.dispose();
        this._renderer.domElement.remove();
    }
}
