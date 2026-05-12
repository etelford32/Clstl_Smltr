/**
 * cme-propagation.js — CME Drag-Based Propagation Model (DBM)
 *
 * Physics-based engine for propagating coronal mass ejections from the Sun to
 * Earth, producing position/velocity/density trajectories over time.
 *
 * ── Physics references ──────────────────────────────────────────────────────
 *  Vršnak et al. (2013) A&A 557, A141 — drag-based model for CME propagation
 *    dv/dt = −γ (v − w) |v − w|     where γ = drag parameter, w = v_sw
 *    Analytical solution:  v(t), r(t) in closed form
 *  Vršnak & Žic (2007) A&A — original drag-based transit time formulation
 *  Cargill (2004) Solar Phys. — CME deceleration in structured solar wind
 *  Gopalswamy et al. (2001) JGR — empirical CME speed → transit time relation
 *  Yashiro et al. (2006) ApJ — X-ray class → CME speed statistical relation
 *  Rankine–Hugoniot relations — jump conditions at CME-driven shock front
 *
 * ── Exported API ─────────────────────────────────────────────────────────────
 *  CmeEvent          class  — represents one CME with DONKI source data
 *  CmePropagator     class  — manages active CME events + propagation state
 *  dbmAnalytical     fn     — analytical DBM solution: v(t), r(t)
 *  dbmTrajectory     fn     — generate full trajectory array (Sun → 1.2 AU)
 *  sheathCompression fn     — Rankine–Hugoniot sheath conditions at CME front
 *  xrayToCmeSpeed    fn     — statistical flare class → CME speed estimate
 *  predictImpact     fn     — predict Kp/Dst/aurora from CME arrival params
 */

import { PHYS } from './helio-physics.js';

// ── Constants ────────────────────────────────────────────────────────────────

const AU_KM  = 1.495_979e8;           // 1 AU in km
const R_SUN_KM = 6.957e5;             // solar radius in km
const R_21_5 = 21.5 * R_SUN_KM;       // LASCO C3 field of view (~21.5 Rs)

/**
 * Default drag parameter γ (km⁻¹).
 * Typical range: 0.2–2.0 × 10⁻⁷ km⁻¹
 * Lower γ = less drag → faster CMEs penetrate more easily
 * Higher γ = more drag → stronger deceleration
 *
 * Vršnak et al. (2013) found γ ≈ 0.2–2.0 × 10⁻⁷ km⁻¹ with a
 * best-fit median around 1.0 × 10⁻⁷ for Earth-directed halo CMEs.
 */
const GAMMA_DEFAULT = 1.0e-7;         // km⁻¹

/** Default ambient solar wind speed (km/s). */
const V_SW_DEFAULT = 400;

/**
 * Adaptive drag parameter γ based on CME initial speed.
 *
 * Vršnak et al. (2013) found γ is roughly anti-correlated with CME speed
 * because faster CMEs tend to be more massive (higher inertia, lower drag).
 *   γ ≈ 2.0 × 10⁻⁷  for slow (v < 400 km/s)
 *   γ ≈ 1.0 × 10⁻⁷  for typical (v ~ 500 km/s)
 *   γ ≈ 0.3 × 10⁻⁷  for fast (v > 1000 km/s)
 *
 * @param {number} v0  CME initial speed (km/s)
 * @returns {number} γ in km⁻¹
 */
export function adaptiveGamma(v0) {
    // Inverse-speed scaling: faster CMEs are more massive → less drag
    // Anchored at v₀ = 500 km/s → γ = 1.0 × 10⁻⁷ km⁻¹
    const gamma = 5e-5 / Math.max(v0, 200);
    return Math.max(0.1e-7, Math.min(2.5e-7, gamma));
}

// ── Analytical DBM solution ──────────────────────────────────────────────────

/**
 * Analytical solution to the drag-based model ODE:
 *   dv/dt = −γ (v − w) |v − w|
 *
 * Two regimes:
 *   v₀ > w  (fast CME decelerating):
 *     v(t) = w + (v₀ − w) / (1 + γ (v₀ − w) t)
 *     r(t) = r₀ + w t + ln(1 + γ (v₀ − w) t) / γ
 *
 *   v₀ < w  (slow CME accelerating):
 *     v(t) = w − (w − v₀) / (1 + γ (w − v₀) t)
 *     r(t) = r₀ + w t − ln(1 + γ (w − v₀) t) / γ
 *
 * @param {number} t_s    time since departure (seconds)
 * @param {number} v0     initial CME speed at r₀ (km/s)
 * @param {number} r0     initial heliocentric distance (km), default 21.5 Rs
 * @param {number} w      ambient solar wind speed (km/s)
 * @param {number} gamma  drag parameter (km⁻¹)
 * @returns {{ r_km: number, v_kms: number }}
 */
export function dbmAnalytical(t_s, v0, r0 = R_21_5, w = V_SW_DEFAULT, gamma = GAMMA_DEFAULT) {
    const dv = v0 - w;

    if (Math.abs(dv) < 1) {
        // CME already at ambient speed — trivial ballistic propagation
        return { r_km: r0 + w * t_s, v_kms: w };
    }

    const sign = dv > 0 ? 1 : -1;
    const absDv = Math.abs(dv);

    // Denominator: 1 + γ |dv| t
    const denom = 1 + gamma * absDv * t_s;

    // Guard against numerical issues for very large t
    if (denom < 1e-6) {
        return { r_km: r0 + w * t_s, v_kms: w };
    }

    const v_kms = w + sign * absDv / denom;
    const r_km  = r0 + w * t_s + sign * Math.log(denom) / gamma;

    return { r_km, v_kms };
}

// ── Full trajectory generation ───────────────────────────────────────────────

/**
 * Generate a sampled trajectory from departure to r_max.
 *
 * @param {object} opts
 * @param {number} opts.v0       initial CME speed (km/s)
 * @param {number} [opts.r0]     start distance (km), default 21.5 Rs
 * @param {number} [opts.w]      ambient solar wind (km/s)
 * @param {number} [opts.gamma]  drag parameter (km⁻¹)
 * @param {number} [opts.r_max]  propagation limit (km), default 1.2 AU
 * @param {number} [opts.dt_s]   time step (s), default 120
 * @returns {Array<{ t_s: number, r_km: number, r_AU: number, v_kms: number }>}
 */
export function dbmTrajectory(opts) {
    const v0    = opts.v0;
    const r0    = opts.r0    ?? R_21_5;
    const w     = opts.w     ?? V_SW_DEFAULT;
    const gamma = opts.gamma ?? GAMMA_DEFAULT;
    const r_max = opts.r_max ?? AU_KM * 1.2;
    const dt_s  = opts.dt_s  ?? 120;

    const pts = [];
    let t = 0;
    let maxIter = 2_000_000;  // safety limit (~2.7 days at 120s steps)

    while (maxIter-- > 0) {
        const { r_km, v_kms } = dbmAnalytical(t, v0, r0, w, gamma);

        pts.push({
            t_s:   t,
            r_km,
            r_AU:  r_km / AU_KM,
            v_kms,
        });

        if (r_km >= r_max) break;
        t += dt_s;
    }

    return pts;
}

/**
 * Find the transit time (seconds) from r0 to r_target.
 * Uses bisection on the analytical solution for robustness.
 *
 * @param {number} v0       CME initial speed (km/s)
 * @param {number} r_target target distance (km), default 1 AU
 * @param {number} [r0]     start distance, default 21.5 Rs
 * @param {number} [w]      ambient wind (km/s)
 * @param {number} [gamma]  drag parameter (km⁻¹)
 * @returns {number} transit time in seconds
 */
export function dbmTransitTime(v0, r_target = AU_KM, r0 = R_21_5, w = V_SW_DEFAULT, gamma = GAMMA_DEFAULT) {
    // Bracket: upper bound from slowest plausible speed
    const v_min = Math.min(v0, w, 200);
    let t_hi = (r_target - r0) / v_min * 1.5;
    let t_lo = 0;

    for (let i = 0; i < 60; i++) {
        const t_mid = (t_lo + t_hi) / 2;
        const { r_km } = dbmAnalytical(t_mid, v0, r0, w, gamma);
        if (r_km < r_target) {
            t_lo = t_mid;
        } else {
            t_hi = t_mid;
        }
        if (t_hi - t_lo < 1) break;  // converge to 1 second
    }

    return (t_lo + t_hi) / 2;
}

// ── Sheath compression (Rankine–Hugoniot) ────────────────────────────────────

/**
 * Compute CME-driven shock sheath conditions using Rankine–Hugoniot relations.
 *
 * The CME front drives a forward shock into the ambient solar wind.
 * Behind the shock, the plasma is compressed, heated, and the magnetic field
 * is amplified — this "sheath" region causes the initial geomagnetic response.
 *
 * @param {number} v_cme   CME speed (km/s)
 * @param {number} v_sw    ambient solar wind speed (km/s)
 * @param {number} n_sw    ambient proton density (cm⁻³), default 5
 * @param {number} B_sw    ambient IMF magnitude (nT), default 5
 * @param {number} T_sw    ambient temperature (K), default 1e5
 * @returns {{ mach: number, compression: number, n_sheath: number, B_sheath: number, T_sheath: number, isShock: boolean }}
 */
export function sheathCompression(v_cme, v_sw, n_sw = 5, B_sw = 5, T_sw = 1e5) {
    const { K_B, M_P, MU_0 } = PHYS;

    // Relative speed in m/s
    const dv = Math.max(0, (v_cme - v_sw)) * 1e3;

    // Ambient sound speed: c_s² = (5/3) k_B T / m_p  (adiabatic, γ=5/3)
    const cs2 = (5 / 3) * K_B * T_sw / M_P;
    const cs  = Math.sqrt(cs2);

    // Ambient Alfvén speed: V_A = B / √(μ₀ ρ)
    const rho = n_sw * 1e6 * M_P;         // cm⁻³ → m⁻³ → kg/m³
    const B   = B_sw * 1e-9;               // nT → T
    const vA  = B / Math.sqrt(MU_0 * rho);

    // Fast magnetosonic speed
    const vf = Math.sqrt(cs2 + vA * vA);

    // Magnetosonic Mach number
    const mach = dv / Math.max(vf, 1e3);

    if (mach <= 1.0) {
        // Sub-magnetosonic: no shock formed
        return {
            mach,
            compression: 1.0,
            n_sheath:    n_sw,
            B_sheath:    B_sw,
            T_sheath:    T_sw,
            isShock:     false,
        };
    }

    // Strong-shock limit for γ=5/3: compression ratio → 4
    // Full RH: X = ((γ+1) M²) / ((γ-1) M² + 2)  with γ = 5/3
    const M2 = mach * mach;
    const X  = Math.min(4.0, (8 * M2) / (M2 + 3));   // (5/3+1)=8/3, simplified

    return {
        mach,
        compression: X,
        n_sheath:    n_sw * X,
        B_sheath:    B_sw * X,                          // perpendicular B enhancement
        T_sheath:    T_sw * (2 * (5/3) * M2 - (5/3 - 1)) * ((5/3 - 1) * M2 + 2) / ((5/3 + 1) * (5/3 + 1) * M2),
        isShock:     true,
    };
}

// ── X-ray class → CME speed statistical model ───────────────────────────────

/**
 * Estimate probable CME speed from GOES X-ray flare class.
 *
 * Based on Yashiro et al. (2006) statistical correlation between
 * flare peak flux and associated CME speed:
 *   log(v_CME) ≈ 2.62 + 0.15 × log₁₀(flux / 1e-4)
 *
 * Returns { v_mean, v_lo, v_hi } — the mean and ±1σ range.
 *
 * @param {string|number} flareClass  e.g. 'X2.3', 'M5.0', or flux in W/m²
 * @returns {{ v_mean: number, v_lo: number, v_hi: number, cme_prob: number }}
 */
export function xrayToCmeSpeed(flareClass) {
    let flux;
    if (typeof flareClass === 'number') {
        flux = flareClass;
    } else {
        flux = _parseFlareFlux(String(flareClass));
    }

    // Yashiro relation: log₁₀(v) = a + b × log₁₀(flux)
    // Calibrated on LASCO CME catalog 1996–2005
    const logFlux = Math.log10(Math.max(flux, 1e-8));
    const logV    = 2.62 + 0.15 * (logFlux + 4);    // +4 shifts to W/m² × 10⁴ scale
    const v_mean  = Math.pow(10, logV);

    // 1σ scatter ≈ 0.25 dex (Yashiro 2006, Fig. 7)
    const sigma = 0.25;
    const v_lo  = Math.pow(10, logV - sigma);
    const v_hi  = Math.pow(10, logV + sigma);

    // CME association probability by class (Yashiro et al. 2006 Table 1)
    let cme_prob;
    if (flux >= 1e-4)      cme_prob = 0.90;  // X-class
    else if (flux >= 1e-5) cme_prob = 0.50;  // M-class
    else if (flux >= 1e-6) cme_prob = 0.25;  // C-class
    else                   cme_prob = 0.05;  // B/A-class

    return {
        v_mean: Math.round(v_mean),
        v_lo:   Math.round(v_lo),
        v_hi:   Math.round(v_hi),
        cme_prob,
    };
}

/**
 * Parse GOES flare class string to peak flux in W/m².
 *   A1.0 = 1e-8,  B1.0 = 1e-7,  C1.0 = 1e-6,  M1.0 = 1e-5,  X1.0 = 1e-4
 */
function _parseFlareFlux(cls) {
    const letter = cls.charAt(0).toUpperCase();
    const num    = parseFloat(cls.slice(1)) || 1.0;
    const base = { A: 1e-8, B: 1e-7, C: 1e-6, M: 1e-5, X: 1e-4 }[letter] ?? 1e-7;
    return base * num;
}

// ── Geomagnetic impact prediction ────────────────────────────────────────────

/**
 * Predict geomagnetic impact from CME arrival parameters.
 *
 * Uses:
 *   - O'Brien & McPherron (2002) Dst injection model
 *   - Newell coupling → Kp estimate
 *   - Kp → aurora latitude mapping
 *
 * @param {number} v_arr    arrival speed (km/s)
 * @param {number} n_arr    arrival density (cm⁻³)
 * @param {number} B_arr    arrival IMF total (nT)
 * @param {number} [Bz]     IMF Bz (nT). If unknown, estimates worst-case = −B_arr/2
 * @returns {{ kp_max: number, dst_min: number, g_scale: number, aurora_lat: number, severity: string }}
 */
export function predictImpact(v_arr, n_arr, B_arr, Bz = null) {
    // If Bz unknown, assume worst-case: half the total field is southward
    const bz = Bz ?? -B_arr * 0.5;

    // Dynamic pressure: Pdyn = ½ ρ v²  in nPa
    // Pdyn [nPa] = 1.67e-6 × n [cm⁻³] × v² [km/s]
    const Pdyn = 1.67e-6 * n_arr * v_arr * v_arr;

    // Burton/O'Brien Dst injection:
    // Q = −4.4 (VBs − 0.49) when VBs > 0.49 mV/m, else 0
    // VBs = v [km/s] × |Bz_south| [nT] × 1e-3 → mV/m
    const Bs   = Math.max(0, -bz);
    const VBs  = v_arr * Bs * 1e-3;
    const Q    = VBs > 0.49 ? -4.4 * (VBs - 0.49) : 0;

    // Steady-state Dst ≈ Q × τ where τ ~ 7.7 hr (decay time)
    // This gives the asymptotic minimum Dst during sustained injection
    const dst_min = Math.round(Math.max(-600, Q * 7.7));

    // Kp estimate from Newell coupling: simplified empirical mapping
    // Newell Φ_D ∝ v^(4/3) Bt^(2/3) sin^(8/3)(θ/2)
    // Clock angle: θ = atan2(By, Bz) — 0 = northward, π = southward
    const theta = Math.atan2(0, bz);        // By ≈ 0; southward Bz → θ = π
    const sinHalf = Math.abs(Math.sin(theta / 2));
    const phi = Math.pow(v_arr, 4/3) * Math.pow(B_arr, 2/3) * Math.pow(sinHalf, 8/3);

    // Empirical Φ → Kp mapping (calibrated to Newell 2007 Fig. 9)
    // Φ for a strong storm (Kp=7): v=700, Bt=20, sinHalf=1 → Φ ≈ 700^(4/3)×20^(2/3)×1 ≈ 52000
    // log₁₀(52000) ≈ 4.72;  target Kp ≈ 7 → 1.6 × 4.72 − 0.5 ≈ 7.05  ✓
    const kp_max = Math.min(9, Math.max(0, 1.6 * Math.log10(Math.max(phi, 1)) - 0.5));

    // NOAA G-scale from Kp
    const g_scale = kp_max >= 9 ? 5 : kp_max >= 8 ? 4 : kp_max >= 7 ? 3 : kp_max >= 6 ? 2 : kp_max >= 5 ? 1 : 0;

    // Aurora equatorward boundary: ~75° at Kp=0 → ~40° at Kp=9
    const aurora_lat = Math.round(75 - (kp_max / 9) * 35);

    // Severity label
    const severity = g_scale >= 4 ? 'EXTREME' : g_scale >= 3 ? 'SEVERE' : g_scale >= 2 ? 'STRONG' : g_scale >= 1 ? 'MODERATE' : 'MINOR';

    return { kp_max: Math.round(kp_max * 10) / 10, dst_min, g_scale, aurora_lat, severity };
}

// ── Solar rotation & Parker spiral ───────────────────────────────────────────

/**
 * Sidereal solar rotation rate at the equator (rad/s).
 *   2π / (25.38 d × 86 400 s)
 * Used to compute the Parker (1958) magnetic-field / streamline spiral.
 */
export const OMEGA_SUN = 2 * Math.PI / (25.38 * 86400);

/**
 * Parker-spiral angle ψ between the local IMF / streamline tangent and the
 * radial direction, at heliocentric distance r_km in a wind of speed v_sw.
 *
 *   tan ψ(r, λ) = Ω_⊙ (r − r₀) cos λ  /  v_sw
 *
 *   r₀ ≈ 21.5 R_⊙ (super-Alfvénic source-surface; the spiral is undefined
 *        below this — the wind is still being accelerated, frozen-in radial).
 *
 * Reference: Parker (1958) ApJ 128, 664 — "Dynamics of the Interplanetary
 * Gas and Magnetic Fields."  At 1 AU, v_sw = 400 km/s, λ = 0 → ψ ≈ 45°.
 *
 * @param {number} r_km     heliocentric distance (km)
 * @param {number} v_sw_kms wind speed at that distance (km/s)
 * @param {number} [lat_rad=0] heliographic latitude (radians)
 * @returns {number} ψ in radians, ≥ 0
 */
export function parkerSpiralAngle(r_km, v_sw_kms, lat_rad = 0) {
    const r = Math.max(0, r_km - R_21_5);
    const v = Math.max(50, v_sw_kms);
    return Math.atan2(OMEGA_SUN * r * Math.cos(lat_rad), v);
}

// ── CmeEvent: single CME instance ────────────────────────────────────────────

/**
 * Represents a single tracked CME event with its propagation state.
 */
export class CmeEvent {
    /**
     * @param {object} donkiData  Parsed DONKI CME object from swpc-feed.js
     * @param {number} [v_sw]     Ambient solar wind speed (km/s)
     * @param {number} [gamma]    Drag parameter (km⁻¹)
     */
    constructor(donkiData, v_sw = V_SW_DEFAULT, gamma = null) {
        this.id            = donkiData.time ?? Date.now().toString();
        this.v0            = donkiData.speed ?? 500;
        this.halfAngle     = donkiData.halfAngle ?? 30;
        this.earthDirected = donkiData.earthDirected ?? false;
        this.latitude      = donkiData.latitude ?? 0;
        this.longitude     = donkiData.longitude ?? 0;
        this.note          = donkiData.note ?? '';

        // Departure time: when the CME was at 21.5 Rs
        this.departure_ms = donkiData.time ? new Date(donkiData.time).getTime() : Date.now();

        // Propagation parameters — use adaptive γ if not explicitly provided
        this.v_sw  = v_sw;
        this.gamma = gamma ?? adaptiveGamma(this.v0);
        this.r0_km = R_21_5;

        // Pre-compute trajectory + transit time to 1 AU
        this.trajectory    = dbmTrajectory({ v0: this.v0, w: this.v_sw, gamma: this.gamma });
        this.transit_s     = dbmTransitTime(this.v0, AU_KM, R_21_5, this.v_sw, this.gamma);
        this.arrival_ms    = this.departure_ms + this.transit_s * 1000;

        // Sheath conditions at 1 AU
        const { v_kms: v_arr } = dbmAnalytical(this.transit_s, this.v0, R_21_5, this.v_sw, this.gamma);
        this.v_arrival = v_arr;
        this.sheath    = sheathCompression(v_arr, this.v_sw);

        // Impact prediction
        this.impact = this.sheath.isShock
            ? predictImpact(v_arr, this.sheath.n_sheath, this.sheath.B_sheath)
            : predictImpact(v_arr, 5, 5);
    }

    /**
     * Get current propagation state at a given real time.
     * @param {number} [now_ms]  current timestamp (ms), default Date.now()
     * @returns {{ elapsed_s: number, r_km: number, r_AU: number, v_kms: number, progress: number, arrived: boolean }}
     */
    stateAt(now_ms = Date.now()) {
        const elapsed_s = Math.max(0, (now_ms - this.departure_ms) / 1000);
        return this.stateAtElapsed(elapsed_s);
    }

    /**
     * Get propagation state at a specific real-elapsed-seconds offset since
     * departure.  Used by the visualisation layer to drive a compressed
     * "playback" of the DBM trajectory at the page's time-compression rate
     * rather than locking onto wall-clock seconds (so a 4-day Sun→Earth
     * transit can be watched in ≈ 2 minutes of viewing).
     *
     * @param {number} elapsed_s real seconds since the CME left r₀ (21.5 Rs)
     */
    stateAtElapsed(elapsed_s) {
        const t = Math.max(0, elapsed_s);
        const { r_km, v_kms } = dbmAnalytical(t, this.v0, this.r0_km, this.v_sw, this.gamma);
        const r_AU = r_km / AU_KM;
        const progress = Math.min(1, Math.max(0, (r_km - this.r0_km) / (AU_KM - this.r0_km)));
        return {
            elapsed_s: t,
            r_km,
            r_AU,
            v_kms,
            progress,
            arrived: r_km >= AU_KM,
        };
    }

    /**
     * Hours until Earth arrival (negative = already passed).
     * @param {number} [now_ms]
     * @returns {number}
     */
    hoursUntilArrival(now_ms = Date.now()) {
        return (this.arrival_ms - now_ms) / 3.6e6;
    }
}

// ── CmePropagator: manages all active CME events ────────────────────────────

/**
 * Central manager that ingests DONKI CME data, creates CmeEvent instances,
 * and exposes the collective propagation state for the visualization layer.
 *
 * Listens to 'swpc-update' events and auto-creates/retires CmeEvent objects.
 */
export class CmePropagator {
    constructor() {
        /** @type {Map<string, CmeEvent>} active events keyed by DONKI time string */
        this.events = new Map();

        /** Current ambient solar wind speed (updated from live feed) */
        this._v_sw = V_SW_DEFAULT;

        /** Callback for state changes */
        this._listeners = [];

        this._onSwpc = this._onSwpc.bind(this);
    }

    /** Start listening for live data. */
    start() {
        window.addEventListener('swpc-update', this._onSwpc);
        return this;
    }

    /** Stop listening. */
    stop() {
        window.removeEventListener('swpc-update', this._onSwpc);
    }

    /** Register a callback: fn(events: CmeEvent[], v_sw: number) */
    onChange(fn) {
        this._listeners.push(fn);
        return this;
    }

    /** Get all active events sorted by departure time (newest first). */
    getActive() {
        const now = Date.now();
        return [...this.events.values()]
            .filter(e => {
                const h = e.hoursUntilArrival(now);
                return h > -24;  // keep for 24h after arrival
            })
            .sort((a, b) => b.departure_ms - a.departure_ms);
    }

    /**
     * Manually inject a CME (useful for testing or flare-based prediction).
     * @param {object} cmeData  DONKI-like object { time, speed, halfAngle, earthDirected, ... }
     */
    inject(cmeData) {
        const key = cmeData.time ?? new Date().toISOString();
        if (this.events.has(key)) return;

        const ev = new CmeEvent(cmeData, this._v_sw);
        this.events.set(key, ev);
        this._notify();
    }

    // ── Private ──────────────────────────────────────────────────────────────

    _onSwpc(ev) {
        const data = ev.detail;

        // Update ambient wind speed
        const sw = data.solar_wind ?? {};
        if (sw.speed) this._v_sw = sw.speed;

        // Ingest DONKI CME list
        const cmes = data.recent_cmes ?? [];
        let changed = false;

        for (const c of cmes) {
            const key = c.time;
            if (!key || this.events.has(key)) continue;

            const ev = new CmeEvent(c, this._v_sw);
            this.events.set(key, ev);
            changed = true;
        }

        // Retire old events (arrived > 48h ago)
        const now = Date.now();
        for (const [key, ev] of this.events) {
            if (ev.hoursUntilArrival(now) < -48) {
                this.events.delete(key);
                changed = true;
            }
        }

        if (changed) this._notify();
    }

    _notify() {
        const active = this.getActive();
        for (const fn of this._listeners) {
            try { fn(active, this._v_sw); } catch (e) { console.warn('[CmePropagator]', e); }
        }

        // Dispatch custom event for other modules
        window.dispatchEvent(new CustomEvent('cme-propagation-update', {
            detail: {
                events: active,
                v_sw:   this._v_sw,
            },
        }));
    }
}
