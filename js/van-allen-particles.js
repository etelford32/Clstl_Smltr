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
        this._buildParticles();
        this._buildMesh();
    }

    // ── Construction ─────────────────────────────────────────────────────────

    _buildParticles() {
        for (let i = 0; i < this._N; i++) {
            const r = Math.random();
            let region, L, energyMeV, charge;

            if (r < 0.22) {
                // Inner belt — high-energy protons (drift west, +1 charge)
                // We deliberately limit the simulated energy to 1–10 MeV so
                // their drift period is visible at the page's compression
                // rate; the *real* high-energy population (~100 MeV) drifts
                // far too fast to render at 3000× even after slowdown.
                region    = 'inner';
                L         = 1.5 + Math.random() * 1.0;
                energyMeV = 1 + Math.random() * 9;
                charge    = +1;
            } else if (r < 0.30) {
                // Slot region — depleted; a few stragglers
                region    = 'slot';
                L         = 2.5 + Math.random() * 0.5;
                energyMeV = 0.4 + Math.random() * 0.8;
                charge    = -1;
            } else {
                // Outer belt — relativistic electrons (drift east, -1 charge)
                region    = 'outer';
                L         = 3.2 + Math.random() * 3.5;
                energyMeV = 0.3 + Math.random() * 4.0;
                charge    = -1;
            }

            // Pitch angle: sample uniformly above the loss cone so all
            // particles are bounce-trapped.  The spawn density goes ∝ sin α₀
            // (more weight at α₀ ≈ 90° → equator-skimmers) which loosely
            // matches a pancake/isotropic equilibrium distribution.
            const alpha_lc = lossConeAlpha(L);
            const u = Math.random();
            const alpha0 = alpha_lc + 0.05 + u * (Math.PI / 2 - alpha_lc - 0.05);
            const lambda_m = mirrorLatitudeFromPitch(alpha0);

            // Drift period (real seconds) and angular rate (rad/real-second)
            const T_d = driftPeriodSec(energyMeV, L, alpha0);
            // Cap the visible drift rate at one orbit / 0.20 viewing-seconds
            // to keep particles from streaking into a ring.  We do this by
            // raising the *effective* T_d for ultra-energetic particles.
            const minVisualPeriodS = 0.20 / (1 / this._timeCompression);
            const T_d_effective = Math.max(T_d, minVisualPeriodS);
            const drift_omega_real = (-2 * Math.PI / T_d_effective) * charge;

            // Bounce: decoupled from physical period (sub-frame) → visualisation
            // rate scales with mirror depth (deeper bounce → slower swing).
            const bounce_T_view  = 1.5 + 1.5 * (lambda_m / (Math.PI / 2));
            const bounce_omega_view = 2 * Math.PI / bounce_T_view;

            this._particles.push({
                L, alpha0, lambda_m, energyMeV, region, charge,
                drift_lon:    Math.random() * Math.PI * 2,
                bounce_phase: Math.random() * Math.PI * 2,
                drift_omega_real,
                bounce_omega_view,
            });
        }
    }

    _buildMesh() {
        const N = this._N;
        const pos = new Float32Array(N * 3);
        const col = new Float32Array(N * 3);

        for (let i = 0; i < N; i++) {
            const p = this._particles[i];
            // Inner belt protons — warm red (matches ring-current convention)
            // Outer belt electrons — cool cyan-blue
            // Slot region — pale yellow
            if (p.region === 'inner') {
                col[i*3]   = 1.00;
                col[i*3+1] = 0.45 + 0.25 * Math.random();
                col[i*3+2] = 0.20;
            } else if (p.region === 'outer') {
                col[i*3]   = 0.40;
                col[i*3+1] = 0.85;
                col[i*3+2] = 1.00;
            } else {
                col[i*3]   = 0.85;
                col[i*3+1] = 0.85;
                col[i*3+2] = 0.55;
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));

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
        const tc = this._timeCompression;
        for (const p of this._particles) {
            p.drift_lon    += p.drift_omega_real  * tc * dt;
            p.bounce_phase += p.bounce_omega_view * dt;
        }
        this._writePositions();
        this._points.geometry.attributes.position.needsUpdate = true;
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
