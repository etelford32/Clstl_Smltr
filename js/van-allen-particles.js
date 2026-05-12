/**
 * van-allen-particles.js — Magnetic-moment-conserving Van Allen tracers
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * A population of N point particles drifting through Earth's dipole-trapped
 * radiation belts under the three adiabatic invariants of motion.  The first
 * invariant (magnetic moment μ) is *exactly* conserved per particle — the
 * second (bounce action J) is approximated by a sinusoidal latitude swing
 * between mirror points; the third (drift shell L) is held fixed (no radial
 * diffusion).
 *
 * ── Physics ──────────────────────────────────────────────────────────────────
 *   First invariant:   μ  = m v_⊥² / (2 B)         [conserved]
 *   Second invariant:  J  = ∮ p_‖ ds                 [bounce-averaged]
 *   Third invariant:   Φ  = surface-integrated B    [drift shell L]
 *
 *   Dipole field on a field line at L-shell, magnetic latitude λ:
 *     r(λ)   = L · R_E · cos²λ
 *     B(λ)/B_eq = √(1 + 3 sin²λ) / cos⁶λ
 *
 *   Mirror equation (μ-conservation):
 *     sin²α₀ = B_eq / B(λ_m)        →  λ_m = λ where v_‖ → 0
 *
 *   Loss-cone half-angle (particles below this precipitate):
 *     sin²α_lc ≈ 1 / √(4 L⁶ − 3 L⁵)
 *
 *   Schulz–Lanzerotti drift period:
 *     T_d (hours) = 1.557 / [ E(MeV) · L · (1 − 0.333 sin^0.62 α₀) ]
 *   with a sign from charge — electrons drift *east*, protons *west*, around
 *   Earth.  This is the visible azimuthal motion of the belts.
 *
 * ── Visualisation ────────────────────────────────────────────────────────────
 *   Bounce timescales (~0.1–1 s real for MeV electrons) are far below the
 *   page's 60 Hz frame rate even without _timeCompression, so we *decouple*
 *   the bounce from real time and animate it at a viewing-friendly rate
 *   (1.5–3 viewing seconds per bounce, depending on mirror depth).  This is
 *   pedagogical, not strictly physical, but lets the user see the bounce.
 *
 *   Drift, on the other hand, *is* run at compressed real time (one drift
 *   period in ~ T_d / _timeCompression viewing-seconds), so a 1 MeV electron
 *   at L=4 sweeps around Earth in ~ 0.7 s of viewing — visible motion.
 *
 *   The two opposite drift directions emerge naturally from the charge sign,
 *   demonstrating the gradient/curvature drift charge separation that drives
 *   the ring current.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   import { VanAllenParticles } from './van-allen-particles.js';
 *   const belts = new VanAllenParticles(scene, { count: 700, timeCompression });
 *   // each frame:
 *   belts.update(dt);
 *   // on swpc-update:
 *   belts.setKp(kp);
 *   // on time-compression change:
 *   belts.setTimeCompression(c);
 */

import * as THREE from 'three';

// 1 scene unit = 1 Earth radius (matches the rest of space-weather-globe.js).
const R_E_SCENE = 1.0;

/**
 * Loss-cone equatorial pitch angle at L-shell L (radians).
 *
 * Particles with |α₀| < α_lc mirror below 100 km altitude on the next bounce
 * and are lost to the atmosphere.  Below ~L = 1.3 the loss cone fills most
 * of the pitch-angle space; we cap at 80° so a degenerate L=1 still works.
 */
function lossConeAlpha(L) {
    const denom = 4 * Math.pow(L, 6) - 3 * Math.pow(L, 5);
    if (denom <= 1) return 80 * Math.PI / 180;
    return Math.asin(Math.min(1, 1 / Math.sqrt(denom)));
}

/**
 * Mirror-point magnetic latitude (radians) for an equatorial pitch angle α₀.
 *
 * Solves  sin²α₀ = cos⁶λ / √(1 + 3 sin²λ)   by bisection.
 * The right-hand side decreases monotonically from 1 (λ=0) toward 0 (λ→π/2)
 * so 30 iterations converge to ≪ 1° in λ.
 */
function mirrorLatitudeFromPitch(alpha0_rad) {
    if (alpha0_rad >= Math.PI / 2 - 1e-3) return 0;
    const target = Math.sin(alpha0_rad) ** 2;
    let lo = 0, hi = Math.PI / 2 - 0.01;
    for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        const c = Math.cos(mid), s = Math.sin(mid);
        const ratio = Math.pow(c, 6) / Math.sqrt(1 + 3 * s * s);
        if (ratio > target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

/**
 * Schulz–Lanzerotti drift period (real seconds).
 *
 * @param {number} energyMeV   particle kinetic energy
 * @param {number} L           McIlwain L-shell
 * @param {number} alpha0_rad  equatorial pitch angle
 */
function driftPeriodSec(energyMeV, L, alpha0_rad) {
    const g = Math.max(0.05, 1 - 0.333 * Math.pow(Math.sin(alpha0_rad), 0.62));
    return (1.557 * 3600) / (Math.max(0.05, energyMeV) * L * g);
}

// ── λ_m(α₀) lookup table ────────────────────────────────────────────────────
//
// Mirror latitude is queried every frame for every particle (α₀ random-walks
// under pitch-angle diffusion).  The bisection in mirrorLatitudeFromPitch
// costs ~30 cos+sin+sqrt per call; tabulating once and linear-interpolating
// drops it to one Math.sin² lookup.
const _LAMBDA_M_TABLE_N = 512;
const _LAMBDA_M_TABLE   = new Float32Array(_LAMBDA_M_TABLE_N);
for (let i = 0; i < _LAMBDA_M_TABLE_N; i++) {
    const sin2 = i / (_LAMBDA_M_TABLE_N - 1);
    _LAMBDA_M_TABLE[i] = mirrorLatitudeFromPitch(Math.asin(Math.sqrt(sin2)));
}

/** Fast O(1) λ_m lookup keyed by sin²α₀ ∈ [0,1]. */
function lookupLambdaM(alpha0_rad) {
    let s = Math.sin(alpha0_rad);
    s *= s;
    if (s <= 0) return _LAMBDA_M_TABLE[0];
    if (s >= 1) return 0;
    const f = s * (_LAMBDA_M_TABLE_N - 1);
    const i = f | 0;
    const t = f - i;
    return _LAMBDA_M_TABLE[i] * (1 - t) + _LAMBDA_M_TABLE[i + 1] * t;
}

/**
 * Cheap Gaussian draw via central-limit theorem (12-uniform sum).
 * Mean 0, σ ≈ 1.  Avoids the log/cos cost of Box–Muller.
 */
function gaussian() {
    let s = 0;
    for (let i = 0; i < 12; i++) s += Math.random();
    return s - 6;
}

// ── Radial diffusion coefficient (Brautigam & Albert 2000) ──────────────────
//
// D_LL is the third-invariant-violating transport rate between L-shells,
// driven by ULF Pc5 waves and substorm-injected E-fields.  The empirical
// magnetic-component fit from B&A (calibrated against CRRES at L = 3.5–7):
//
//     log₁₀ D_LL [day⁻¹] = 0.506 · Kp − 9.325 + 10 · log₁₀(L)
//
// The L¹⁰ scaling makes inner-belt protons (L ≈ 2) effectively immune to
// radial diffusion (D_LL ≪ 10⁻⁶ /day) while outer-belt electrons (L ≈ 6)
// at storm-time Kp ≥ 6 see D_LL of order 10–1000 /day — large enough that
// inward transport refills the outer belt within a day after the main
// phase, the canonical "storm recovery" relativistic-electron acceleration.
//
// We return /s for direct use in the random-walk integrator.
const _LN10 = Math.log(10);
function radialDiffusionDLL(L, kp) {
    const logD_day = 0.506 * Math.max(0, Math.min(9, kp)) - 9.325
                   + 10 * Math.log10(Math.max(1.05, L));
    return Math.exp(logD_day * _LN10) / 86400;     // /s
}

// ── EMIC-band ion-cyclotron resonant scattering ──────────────────────────────
//
// Electromagnetic ion-cyclotron (EMIC) waves are generated by anisotropic
// ring-current ion populations (T_⊥ > T_∥) and grow most efficiently in
// regions of overlap between hot ions and cold plasmaspheric / plume plasma.
// They scatter ring-current protons (and to a lesser extent inner-belt
// MeV protons during very intense storms) into the loss cone via the
// resonance condition
//
//     ω − k_∥ v_∥ = − Ω_p / γ
//
// where Ω_p is the proton gyrofrequency.  At storm-time L = 3–6 with cold-
// plasma overlap, this is the dominant ring-current loss channel.
//
// We add EMIC as a *second* pitch-angle-diffusion channel running parallel
// to the existing chorus-driven one.  It is gated on a stormIdx threshold
// (mostly active during main and early-recovery phases) and weighted toward
// ions only.  An additional O+-outflow boost activates above stormIdx 0.85
// — heavy ionospheric oxygen broadens the resonant L-range and amplifies
// EMIC drive into the inner belt during exceptional storms (think 2003
// Halloween, Sept 2017, May 2024).
const EMIC_ACTIVATION_STORM_IDX = 0.50;
const EMIC_D_PEAK               = 0.10;   // /s peak diffusion at stormIdx = 1
const EMIC_OPLUS_THRESHOLD      = 0.85;   // stormIdx above which O+ outflow boosts
const EMIC_OPLUS_MAX_BOOST      = 2.0;    // multiplier at stormIdx = 1

// Anomalous-cyclotron-resonance threshold for EMIC scattering of relativistic
// electrons.  Below ~2 MeV the resonance condition
//
//     ω + |k_∥| v_∥ = Ω_e / γ
//
// can't be satisfied by L-mode EMIC waves at typical magnetospheric k_∥ /
// densities (Summers & Thorne 2003; Usanova et al. 2014 SAMPEX/RBSP).  Above
// the threshold the rate ramps quickly: in storm dropouts the electron
// component scatters faster than the ion one because the resonance favours
// already-near-loss-cone electrons.  We model this with a piecewise-linear
// weight that's 0 below 2 MeV and saturates at 0.6 by 5 MeV.
const EMIC_E_ELECTRON_THRESHOLD = 2.0;    // MeV
const EMIC_E_ELECTRON_SAT       = 5.0;    // MeV at which the weight saturates
const EMIC_E_ELECTRON_W_MAX     = 0.60;

/**
 * Energy-dependent EMIC scatter weight for outer-belt relativistic electrons.
 * @param {number} energyMeV
 * @returns {number} weight ∈ [0, EMIC_E_ELECTRON_W_MAX]
 */
function emicElectronWeight(energyMeV) {
    if (energyMeV < EMIC_E_ELECTRON_THRESHOLD) return 0;
    const t = (energyMeV - EMIC_E_ELECTRON_THRESHOLD)
            / (EMIC_E_ELECTRON_SAT - EMIC_E_ELECTRON_THRESHOLD);
    return EMIC_E_ELECTRON_W_MAX * Math.min(1, t);
}


export class VanAllenParticles {
    /**
     * @param {THREE.Scene} scene
     * @param {object} [opts]
     * @param {number} [opts.count=700]            total particle count
     * @param {number} [opts.timeCompression=3000] same factor as the globe
     * @param {number} [opts.size=0.05]            scene-unit point size
     */
    constructor(scene, opts = {}) {
        this._scene = scene;
        this._N    = opts.count ?? 700;
        this._timeCompression = opts.timeCompression ?? 3000;
        this._size = opts.size ?? 0.05;
        this._kp   = 2;

        this._particles = [];

        // Pre-allocate the buffers so _initParticleSlot can write colour into
        // them during the initial fill, then BufferGeometry attaches them in
        // _buildMesh.  (Building mesh first would also work, but keeping the
        // order explicit matches the dependency order: state → buffers → mesh.)
        const N = this._N;
        this._position       = new Float32Array(N * 3);
        this._color          = new Float32Array(N * 3);
        this._colorOriginal  = new Float32Array(N * 3);

        this._buildParticles();
        this._buildMesh();

        // ── Storm-driven pitch-angle diffusion state ────────────────────────
        // setStorm({bz,kp}) updates these; update() consumes them each frame.
        this._stormIdx = 0;     // 0..1 — combined Bz_south × Kp index
        this._bz       = 0;
        // Rolling counters for diagnostics / HUD
        this._lossEvents = 0;   // total particles precipitated this session
        this._respawnEvents = 0;
        this._emicLossEvents = 0;          // total EMIC-attributed precipitations
        this._emicElectronLossEvents = 0;  // subset of EMIC losses that were >2 MeV electrons
    }

    // ── Construction ─────────────────────────────────────────────────────────

    _buildParticles() {
        for (let i = 0; i < this._N; i++) {
            this._particles.push({});      // empty slot
            this._initParticleSlot(i);     // populate
        }
    }

    /**
     * (Re)initialise particle slot `idx` with a fresh (region, L, energy, α₀,
     * phases) draw from the equilibrium distribution.  Used by both the
     * initial build and post-precipitation respawn.
     *
     * Region weights:
     *   22 % inner belt  — proton, 1–10 MeV (energy capped for viz)
     *    8 % slot region — sparse population
     *   70 % outer belt  — relativistic electron, 0.3–4 MeV
     *
     * The pitch-angle is drawn uniformly above the local loss cone so every
     * spawned particle is bounce-trapped; pitch-angle diffusion (added in
     * `update`) is what knocks them into the loss cone over storm time.
     */
    /**
     * (Re)initialise particle slot `idx`.
     *
     * @param {string} [source='equilibrium']
     *   'equilibrium' — full population draw (used at startup)
     *   'plasmasheet' — outer-edge low-energy seed electron (used during storm
     *                   recovery: high Kp + Bz northward → enhanced injection
     *                   from the plasma sheet that subsequently radially
     *                   diffuses inward and adiabatically energises).
     */
    _initParticleSlot(idx, source = 'equilibrium') {
        let region, L, energyMeV, charge;

        if (source === 'plasmasheet') {
            // Plasma-sheet seed: sub-relativistic electron at the outer trap
            // edge.  Its inward radial diffusion + μ-conserving acceleration
            // is the canonical recovery-phase outer-belt refill mechanism.
            region    = 'outer';
            L         = 6.5 + Math.random() * 1.0;
            energyMeV = 0.05 + Math.random() * 0.20;
            charge    = -1;
        } else {
            const r = Math.random();
            if (r < 0.22) {
                region    = 'inner';
                L         = 1.5 + Math.random() * 1.0;
                energyMeV = 1 + Math.random() * 9;
                charge    = +1;
            } else if (r < 0.30) {
                region    = 'slot';
                L         = 2.5 + Math.random() * 0.5;
                energyMeV = 0.4 + Math.random() * 0.8;
                charge    = -1;
            } else {
                region    = 'outer';
                L         = 3.2 + Math.random() * 3.5;
                energyMeV = 0.3 + Math.random() * 4.0;
                charge    = -1;
            }
        }

        const alpha_lc = lossConeAlpha(L);
        const u = Math.random();
        const alpha0 = alpha_lc + 0.05 + u * (Math.PI / 2 - alpha_lc - 0.05);
        const lambda_m = lookupLambdaM(alpha0);

        const T_d = driftPeriodSec(energyMeV, L, alpha0);
        const minVisualPeriodS = 0.20 * this._timeCompression;
        const T_d_effective = Math.max(T_d, minVisualPeriodS);
        const drift_omega_real = (-2 * Math.PI / T_d_effective) * charge;

        const bounce_T_view  = 1.5 + 1.5 * (lambda_m / (Math.PI / 2));
        const bounce_omega_view = 2 * Math.PI / bounce_T_view;

        // Chorus / hiss pitch-angle-diffusion susceptibility.  Outer-belt
        // electrons are the most strongly scattered (chorus drives them into
        // the loss cone in minutes during storms); inner-belt protons are
        // very stable (decade lifetimes via this channel); slot region sees
        // moderate plasmaspheric-hiss loss.
        const scatterWeight =
            region === 'outer' ? 1.00 :
            region === 'slot'  ? 0.55 :
                                 0.04;

        // EMIC scattering susceptibility.  Two distinct populations resonate:
        //
        //   Ions (charge +1) — primary EMIC target via the standard
        //     proton-cyclotron condition.  Inner-belt protons are harder to
        //     drive into resonance than ring-current protons but become
        //     important during exceptional storms when O⁺ outflow extends
        //     the resonant L-range inward.
        //
        //   Relativistic electrons (charge −1, E ≥ 2 MeV) — secondary but
        //     observed dropout via *anomalous* cyclotron resonance.  Energy
        //     threshold is sharp (~2 MeV); the weight ramps to 0.6 by 5 MeV.
        //     This is the mechanism that selectively wipes out the bright
        //     "killer electron" population during severe storms while
        //     leaving sub-MeV electrons intact.
        const emicWeight =
            charge === +1 && region === 'inner' ? 0.45 :
            charge === +1 && region === 'slot'  ? 1.00 :
            charge === +1 && region === 'outer' ? 0.20 :
            charge === -1 && region === 'outer' ? emicElectronWeight(energyMeV) :
                                                   0.00;

        const p = this._particles[idx];
        p.L              = L;
        p.alpha0         = alpha0;
        p.alpha_lc       = alpha_lc;
        p.lambda_m       = lambda_m;
        p.energyMeV      = energyMeV;
        p.region         = region;
        p.charge         = charge;
        p.drift_lon      = Math.random() * Math.PI * 2;
        p.bounce_phase   = Math.random() * Math.PI * 2;
        p.drift_omega_real  = drift_omega_real;
        p.bounce_omega_view = bounce_omega_view;
        p.scatterWeight  = scatterWeight;
        p.emicWeight     = emicWeight;
        p.state          = 'trapped';     // 'trapped' | 'precipitating'
        p.precipTimer    = 0;             // viewing-seconds remaining in fade
        p.respawnDelay   = 0;             // viewing-seconds until eligible to respawn

        // Write colour into the original-cache so the dimming logic in
        // `update` can restore it on respawn.  Outer-belt colour is derived
        // from energy via _refreshOuterColor (so radial-diffusion-driven
        // acceleration visibly brightens those particles); inner / slot
        // particles get fixed region-tagged colours.
        if (this._color && this._colorOriginal) {
            const o = idx * 3;
            if (region === 'outer') {
                this._refreshOuterColor(idx, energyMeV);
            } else if (region === 'inner') {
                this._colorOriginal[o]   = 1.00;
                this._colorOriginal[o+1] = 0.45 + 0.25 * Math.random();
                this._colorOriginal[o+2] = 0.20;
            } else {
                // Slot
                this._colorOriginal[o]   = 0.85;
                this._colorOriginal[o+1] = 0.85;
                this._colorOriginal[o+2] = 0.55;
            }
            // Mirror into the live buffer so the first frame shows the spawn
            // colour correctly (otherwise it would be (0,0,0) for one tick).
            this._color[o]   = this._colorOriginal[o];
            this._color[o+1] = this._colorOriginal[o+1];
            this._color[o+2] = this._colorOriginal[o+2];
        }
    }

    _buildMesh() {
        // _position / _color / _colorOriginal were allocated in the constructor
        // and the colour array was filled by _initParticleSlot during the
        // initial _buildParticles run.  We just need to wrap them as
        // BufferAttributes and create the Points mesh.

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this._position, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(this._color,    3));

        const mat = new THREE.PointsMaterial({
            size:            this._size,
            sizeAttenuation: true,
            vertexColors:    true,
            transparent:     true,
            opacity:         0.85,
            blending:        THREE.AdditiveBlending,
            depthWrite:      false,
        });
        this._points = new THREE.Points(geo, mat);
        this._points.renderOrder = 6;

        // Wrap the Points in a Group tilted by Earth's magnetic-dipole offset
        // (~11.5°) so the particle orbits stay co-aligned with the existing
        // volumetric belt tori in MagnetosphereEngine, which apply the same
        // tilt to their _eqGroup parent.
        this._dipoleGroup = new THREE.Group();
        this._dipoleGroup.name = 'van_allen_particles';
        this._dipoleGroup.rotation.x = 11.5 * Math.PI / 180;
        this._dipoleGroup.add(this._points);
        this._scene.add(this._dipoleGroup);

        // Initial position fill so the first frame has something to display
        this._writePositions();
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /** Adjust visual response to current Kp (storm-time outer belt brightening). */
    setKp(kp) {
        this._kp = kp;
        if (this._points) {
            // High Kp → outer belt is *energised* (Local acceleration via
            // chorus waves can boost relativistic-electron flux >10×).
            // Visually we just brighten the whole population.
            this._points.material.opacity =
                Math.min(1.0, 0.65 + Math.min(1, kp / 9) * 0.30);
        }
    }

    /** Update the time-compression factor (matches space-weather-globe.js). */
    setTimeCompression(c) {
        const cNew = Math.max(1, Math.min(50000, c));
        // Re-cap drift rates against the new compression so super-fast
        // particles don't suddenly streak through the belt at high comp.
        for (const p of this._particles) {
            const T_d = driftPeriodSec(p.energyMeV, p.L, p.alpha0);
            const minVisualPeriodS = 0.20 / (1 / cNew);
            const T_d_effective = Math.max(T_d, minVisualPeriodS);
            const sign = p.drift_omega_real >= 0 ? +1 : -1;
            p.drift_omega_real = sign * 2 * Math.PI / T_d_effective;
        }
        this._timeCompression = cNew;
    }

    setVisible(v) {
        if (this._dipoleGroup) this._dipoleGroup.visible = !!v;
    }

    dispose() {
        if (!this._points) return;
        this._points.geometry.dispose();
        this._points.material.dispose();
        if (this._dipoleGroup) {
            this._scene.remove(this._dipoleGroup);
            this._dipoleGroup = null;
        }
        this._points = null;
        this._particles = [];
    }

    /** @returns {number} count of currently-rendered particles */
    get count() { return this._N; }

    // ── Per-frame integration ────────────────────────────────────────────────

    /**
     * Advance every trapped particle by `dt` viewing-seconds.
     *
     * - drift_lon advances at compressed real-time rate (azimuthal gradient
     *   drift) — opposite signs for +/- charges.
     * - bounce_phase advances at a viewing-time-decoupled rate (the bounce
     *   period is sub-frame even uncompressed; we slow it for clarity).
     *
     * The instantaneous magnetic latitude follows a sinusoidal swing between
     * ±λ_m, the mirror latitudes set by μ-conservation:
     *
     *   λ(t) = λ_m · sin(bounce_phase)
     *
     * From λ and L we recover the dipole-field-line position:
     *
     *   r(λ)        = L · cos²λ            [in R_E]
     *   r(λ)·cos λ  = L · cos³λ            [equatorial-plane projection]
     *   y           = r(λ) · sin λ         [along dipole axis]
     */
    update(dt) {
        if (!this._points) return;
        const tc        = this._timeCompression;
        const stormIdx  = this._stormIdx ?? 0;
        const kp        = this._kp;

        // ── Pitch-angle diffusion coefficient ──────────────────────────────
        //
        // D_αα has units of 1/(viewing-time) since dt is in viewing-seconds.
        // The diffusion timescale to scatter from α₀ ≈ 90° to α_lc ≈ 5° is
        //   T_diff ≈ (π/2)² / (2 D_αα).
        // Tuned so that during a maxed-out storm (Bz ≪ 0, Kp = 9 → stormIdx=1)
        // outer-belt electrons drain in ~5 viewing seconds, and during quiet
        // intervals (stormIdx ≈ 0) only a trickle is lost over minutes.
        const D_QUIET = 5e-3;
        const D_STORM = 0.50;
        const D_eff   = D_QUIET + D_STORM * stormIdx;
        const sigmaBase = Math.sqrt(2 * D_eff * dt);

        // ── EMIC ion-cyclotron diffusion (parallel channel for ions) ───────
        // Activates above stormIdx 0.50 and ramps with stormIdx − threshold;
        // O+ outflow boosts the rate above stormIdx 0.85 (heavy-ion regime).
        // Per-particle σ is multiplied by √emicWeight downstream so electrons
        // (emicWeight = 0) are unaffected and inner-belt protons see ~0.45×
        // the slot-region rate.
        let emicSigmaBase = 0;
        let emicActive = false;
        if (stormIdx > EMIC_ACTIVATION_STORM_IDX) {
            const emicStrength = (stormIdx - EMIC_ACTIVATION_STORM_IDX)
                               / (1 - EMIC_ACTIVATION_STORM_IDX);
            const oPlusBoost   = stormIdx > EMIC_OPLUS_THRESHOLD
                ? 1 + (EMIC_OPLUS_MAX_BOOST - 1) *
                      ((stormIdx - EMIC_OPLUS_THRESHOLD) / (1 - EMIC_OPLUS_THRESHOLD))
                : 1;
            const D_emic = EMIC_D_PEAK * emicStrength * oPlusBoost;
            emicSigmaBase = Math.sqrt(2 * D_emic * dt);
            emicActive = true;
        }

        // ── Recovery-phase detection ───────────────────────────────────────
        // Recovery = high-ish Kp but Bz no longer strongly southward.  This
        // is when ULF Pc5 power is high (energising radial diffusion) yet
        // pitch-angle scattering losses are subsiding — the canonical
        // outer-belt rebuild interval.  We use it to (a) bias respawns to
        // outer-edge plasma-sheet seeds, and (b) gently boost D_LL above
        // the Brautigam-Albert baseline.
        const recoveryFactor = (kp > 4 && stormIdx < 0.30)
            ? Math.min(1, (kp - 4) / 5)     // 0..1 across Kp 4 → 9
            : 0;

        const respawnDuringStormScale = 1 - 0.85 * stormIdx;
        const respawnFromPlasmaSheet  = 0.70 * recoveryFactor;

        // Real-seconds-per-viewing-second multiplier for *physical* random
        // walks (D_LL is in /real-second; the viewing-time variance ∝ tc).
        const viewSToRealS = tc;

        for (let i = 0, n = this._particles.length; i < n; i++) {
            const p = this._particles[i];

            if (p.state === 'precipitating') {
                p.precipTimer -= dt;
                if (p.precipTimer <= 0) {
                    // Roll for respawn — quiet conditions refill quickly
                    // (plasma-sheet injection on minutes timescale); during
                    // severe storms the respawn rate is suppressed so the
                    // visible population *visibly drains*.
                    const respawnRatePerS = 1.2 * respawnDuringStormScale;
                    if (Math.random() < respawnRatePerS * dt) {
                        // During recovery, a fraction of respawns enter as
                        // low-energy seed electrons at the outer trap edge.
                        const source = (Math.random() < respawnFromPlasmaSheet)
                            ? 'plasmasheet' : 'equilibrium';
                        this._initParticleSlot(i, source);
                        this._respawnEvents++;
                    }
                }
                p.drift_lon    += p.drift_omega_real  * tc * dt;
                p.bounce_phase += p.bounce_omega_view * dt;
                continue;
            }

            // ── Pitch-angle scatter (chorus / hiss channel) ────────────────
            const sigma = sigmaBase * Math.sqrt(p.scatterWeight);
            p.alpha0 += sigma * gaussian();

            if (p.alpha0 > Math.PI / 2) p.alpha0 = Math.PI - p.alpha0;
            if (p.alpha0 < p.alpha_lc) {
                p.state       = 'precipitating';
                p.precipTimer = 1.0 + Math.random() * 0.5;
                this._lossEvents++;
                continue;
            }

            // ── EMIC scatter (ions + relativistic electrons) ───────────────
            // Two resonant populations, both gated on stormIdx > 0.50:
            //   • Protons via the standard ion-cyclotron condition
            //   • Electrons ≥ 2 MeV via anomalous cyclotron resonance
            // p.emicWeight encodes both: 0 for sub-threshold electrons,
            // ramping up for ≥ 2 MeV ones (refreshed when radial diffusion
            // accelerates an electron past the threshold).
            if (emicActive && p.emicWeight > 0) {
                const emicSigma = emicSigmaBase * Math.sqrt(p.emicWeight);
                p.alpha0 += emicSigma * gaussian();
                if (p.alpha0 > Math.PI / 2) p.alpha0 = Math.PI - p.alpha0;
                if (p.alpha0 < p.alpha_lc) {
                    p.state       = 'precipitating';
                    p.precipTimer = 1.0 + Math.random() * 0.5;
                    this._lossEvents++;
                    this._emicLossEvents++;
                    if (p.charge === -1) this._emicElectronLossEvents++;
                    continue;
                }
            }
            p.lambda_m = lookupLambdaM(p.alpha0);

            // ── Radial diffusion (third-invariant violation) ───────────────
            // Random walk in L driven by ULF Pc5 power scaled with Kp.
            // Inner-belt protons see D_LL ≪ 10⁻¹² /s thanks to the L¹⁰
            // scaling, so they're effectively immune.  Outer-belt electrons
            // at storm Kp see D_LL ≫ 10⁻³ /s — meaningful inward transport.
            const dll = radialDiffusionDLL(p.L, kp)
                      * (1 + 1.5 * recoveryFactor);          // recovery boost
            // sigma_L over a viewing-second corresponds to a real-time
            // random walk of √(2 D_LL · dt · tc) since dt is viewing-time
            // and D_LL is /real-s.
            const sigmaL = Math.sqrt(2 * dll * dt * viewSToRealS);
            // Cap any single step to a fraction of an L-shell to prevent
            // teleport at extreme Kp + outer L combinations.
            const dL = Math.max(-0.30, Math.min(0.30, sigmaL * gaussian()));
            const newL = p.L + dL;

            // ── Boundary conditions ────────────────────────────────────────
            // L < 1.3 → particle's mirror points are inside the atmosphere
            //          → loss to upper atmosphere (precipitation)
            // L > 8.0 → outside trapped region → loss to magnetopause /
            //          magnetosheath (effectively the same outcome)
            if (newL < 1.3 || newL > 8.0) {
                p.state       = 'precipitating';
                p.precipTimer = 1.0 + Math.random() * 0.5;
                this._lossEvents++;
                continue;
            }

            // ── μ-conserving energy scaling ────────────────────────────────
            //   B_eq(L) ∝ 1/L³  (dipole)
            //   μ = m v_⊥²/(2B) = const   →   v_⊥² ∝ B ∝ 1/L³
            // For the v_⊥-dominated population (most particles at α₀ near
            // 90°), kinetic energy ∝ v_⊥² ∝ 1/L³.  Inward transport
            // therefore *energises* a seed electron: a 0.1 MeV particle
            // moving from L = 7 to L = 4 gains a factor (7/4)³ ≈ 5.4 in
            // energy → ~0.54 MeV.  Multiple inward steps over storm
            // recovery accumulate to MeV-class "killer electrons".
            if (newL !== p.L) {
                const energyRatio = Math.pow(p.L / newL, 3);
                p.energyMeV = Math.max(0.05, Math.min(50, p.energyMeV * energyRatio));
                p.L = newL;
                p.alpha_lc = lossConeAlpha(newL);

                // Drift period depends on energy and L — recompute
                const T_d = driftPeriodSec(p.energyMeV, p.L, p.alpha0);
                const minVisualPeriodS = 0.20 * tc;
                const T_d_effective = Math.max(T_d, minVisualPeriodS);
                p.drift_omega_real = (-2 * Math.PI / T_d_effective) * p.charge;

                // For outer-belt particles, refresh cached colour from new
                // energy — high-energy electrons render whiter / brighter,
                // visibly demonstrating the radial-diffusion acceleration.
                // Also refresh the EMIC weight: electrons crossing the 2-MeV
                // threshold via inward-diffusion-driven μ-conserving
                // acceleration *become* susceptible to EMIC dropout — the
                // closing of the storm-cycle loop.
                if (p.region === 'outer') {
                    this._refreshOuterColor(i, p.energyMeV);
                    if (p.charge === -1) {
                        p.emicWeight = emicElectronWeight(p.energyMeV);
                    }
                }

                // After diffusion-driven L change the particle may be in the
                // (new) loss cone (loss cone widens as L decreases).
                if (p.alpha0 < p.alpha_lc) {
                    p.state       = 'precipitating';
                    p.precipTimer = 1.0 + Math.random() * 0.5;
                    this._lossEvents++;
                    continue;
                }
            }

            // Drift + bounce phase advance
            p.drift_lon    += p.drift_omega_real  * tc * dt;
            p.bounce_phase += p.bounce_omega_view * dt;
        }

        this._writePositions();
        this._writeColors();
        this._points.geometry.attributes.position.needsUpdate = true;
        this._points.geometry.attributes.color.needsUpdate    = true;
    }

    /**
     * Recompute the cached "rest" colour for an outer-belt particle from its
     * current energy.  Low-energy seeds are dim grey-cyan; relativistic
     * (~MeV) electrons are bright cyan; ≥ 5 MeV "killer electrons" are
     * white-blue.  Inner-belt protons and slot stragglers retain the
     * region-specific colour set at spawn (their energy barely changes).
     */
    _refreshOuterColor(idx, energyMeV) {
        const o = idx * 3;
        // Map E [0.05, 5] MeV → t [0, 1] with a soft log curve (so a
        // factor-10 energy gain produces ~0.5 of the colour shift, matching
        // perceptual brightness scaling).
        const t = Math.max(0, Math.min(1, Math.log10(Math.max(0.05, energyMeV) / 0.05) / Math.log10(5 / 0.05)));
        // Dim seed → bright cyan → white-blue
        this._colorOriginal[o]   = 0.20 + 0.55 * t;
        this._colorOriginal[o+1] = 0.45 + 0.50 * t;
        this._colorOriginal[o+2] = 0.65 + 0.35 * t;
    }

    /**
     * Storm-time pitch-angle-diffusion drive.  Combines southward-Bz reconnection
     * coupling with the Kp activity index into a single 0..1 storm scalar:
     *
     *   stormIdx = clamp( (-Bz_south / 20 nT) · (Kp / 9), 0, 1 )
     *
     * Strong southward Bz drives dayside reconnection → enhanced convection →
     * plasma-sheet injection → seed-electron supply → wave growth → enhanced
     * pitch-angle diffusion of trapped relativistic electrons (chorus) and
     * ring-current ions (EMIC).  Kp factors in the broader magnetospheric
     * activity level.  This is the single coupling knob between solar-wind
     * forcing and Van-Allen-particle loss in the visualisation.
     */
    setStorm({ bz = 0, kp = 0 } = {}) {
        this._bz = bz;
        const bz_south = Math.max(0, -bz);                 // nT, ≥ 0
        const kpNorm   = Math.max(0, Math.min(1, kp / 9));
        this._stormIdx = Math.min(1, (bz_south / 20) * kpNorm);
    }

    /**
     * Write per-particle colour, dimming during precipitation fade-out.
     * Trapped particles get their cached original colour; precipitating
     * particles get linearly-faded colour over their precipTimer window.
     */
    _writeColors() {
        const col   = this._color;
        const orig  = this._colorOriginal;
        for (let i = 0, n = this._particles.length; i < n; i++) {
            const p = this._particles[i];
            const o = i * 3;
            if (p.state === 'precipitating') {
                // 0..1 fade based on remaining precipTimer (init was 1-1.5 s)
                const k = Math.max(0, Math.min(1, p.precipTimer / 1.0));
                col[o]   = orig[o]   * k;
                col[o+1] = orig[o+1] * k;
                col[o+2] = orig[o+2] * k;
            } else {
                col[o]   = orig[o];
                col[o+1] = orig[o+1];
                col[o+2] = orig[o+2];
            }
        }
    }

    /** Diagnostic: storm index ∈ [0, 1] used by the diffusion engine. */
    /** True when stormIdx exceeds the EMIC activation threshold. */
    get emicActive()  { return (this._stormIdx ?? 0) > EMIC_ACTIVATION_STORM_IDX; }
    /** True when stormIdx is high enough that O+ outflow boosts EMIC drive. */
    get emicOplusBoost() { return (this._stormIdx ?? 0) > EMIC_OPLUS_THRESHOLD; }
    /** Cumulative EMIC-attributed precipitations (ions + electrons). */
    get emicLossEvents() { return this._emicLossEvents; }
    /** Subset of emicLossEvents that were ≥ 2 MeV electrons (the dropout signal). */
    get emicElectronLossEvents() { return this._emicElectronLossEvents; }
    /** EMIC-attributed proton losses = total − electrons. */
    get emicIonLossEvents() {
        return this._emicLossEvents - this._emicElectronLossEvents;
    }
    get stormIndex()  { return this._stormIdx ?? 0; }
    /** Diagnostic: total precipitation events since construction. */
    get lossEvents()  { return this._lossEvents; }
    /** Diagnostic: total respawn events since construction. */
    get respawnEvents() { return this._respawnEvents; }
    /** Live count of trapped (visible) particles. */
    get trappedCount() {
        let c = 0;
        for (const p of this._particles) if (p.state === 'trapped') c++;
        return c;
    }

    /**
     * Write particle positions with the magnetic dipole axis = local +Z
     * (the same convention as MagnetosphereEngine's TorusGeometry belts —
     * a parent Group then applies the 11.5° tilt to align with the visual
     * Earth-magnetic dipole).
     *
     *   r(λ)        = L · cos²λ                        [in R_E]
     *   r(λ)·cos λ  = L · cos³λ                         [equatorial-plane projection]
     *   z (dipole)  = L · cos²λ · sin λ                [along dipole axis]
     */
    _writePositions() {
        const pos = this._points.geometry.attributes.position.array;
        for (let i = 0, n = this._particles.length; i < n; i++) {
            const p = this._particles[i];
            const lambda  = p.lambda_m * Math.sin(p.bounce_phase);
            const cosLam  = Math.cos(lambda);
            const sinLam  = Math.sin(lambda);
            const r       = p.L * cosLam * cosLam;        // L · cos²λ
            const rEqProj = r * cosLam;                    // L · cos³λ
            pos[i*3]   = rEqProj * Math.cos(p.drift_lon) * R_E_SCENE;
            pos[i*3+1] = rEqProj * Math.sin(p.drift_lon) * R_E_SCENE;
            pos[i*3+2] = r * sinLam                       * R_E_SCENE;
        }
    }
}
