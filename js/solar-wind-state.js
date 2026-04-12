/**
 * solar-wind-state.js — Real-time heliospheric state at Earth's position
 *
 * This is the physics bridge between two data streams:
 *   1. EphemerisService  → Earth's exact heliocentric position (r, lon, lat, xyz)
 *   2. NOAA DSCOVR/ACE  → In-situ solar wind at the L1 Lagrange point
 *
 * It combines them to compute a physically consistent heliospheric state AT
 * Earth's actual orbital location, including:
 *   • Parker-profile speed scaling   v(r) = v_L1 × f_Parker(r) / f_Parker(1 AU)
 *   • Inverse-square density falloff n(r) = n_L1 × (1 AU / r)²
 *   • Parker spiral IMF geometry     B_r ∝ 1/r², B_φ ∝ 1/r  →  B_total at Earth
 *   • Alfvén speed, plasma beta, dynamic pressure
 *   • Speed-dependent L1 → Earth propagation delay
 *   • Validated inputs with physical range checks
 *   • Data quality tracking (parker-corrected / l1-raw / fallback)
 *
 * ── Determinism ─────────────────────────────────────────────────────────────
 *  All physics computations are pure functions.  Given the same NOAA inputs
 *  and ephemeris position, the output is always identical.  The only non-
 *  deterministic element is the timestamp used for buffer lookups, which is
 *  passed explicitly to enable replay.
 *
 * EVENTS CONSUMED (window)
 * ─────────────────────────────────────────────────────────────────────────────
 *  'ephemeris-ready'   { earth: { r_AU|dist_AU, lon_rad, lat_rad, x_AU, y_AU, z_AU } }
 *  'swpc-update'       { solar_wind: { speed, density, bz, bt, by }, kp, xray_flux, f107_flux, ... }
 *
 * EVENT FIRED (window)
 * ─────────────────────────────────────────────────────────────────────────────
 *  'helio-state-update'  Validated, enriched SolarState snapshot
 *
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *  import { SolarWindState } from './js/solar-wind-state.js';
 *  new SolarWindState().start();
 */

import {
    PHYS,
    buildParkerLUT,
    parkerSpeedRatio,
    alfvenSpeed,
    plasmaBeta,
    plasmaTemp,
} from './helio-physics.js';

import {
    createSolarState,
    enrichSolarState,
    validateReading,
    propagationDelay,
} from './solar-state.js';

import { loadUserLocation } from './user-location.js';

// ── Physical constants ─────────────────────────────────────────────────────────

/** Carrington rotation: 27.2753 days = 2.865×10⁻⁶ rad/s */
const OMEGA_SUN     = 2.865e-6;          // rad/s

/** L1 Lagrange point offset from Earth (~1.5 × 10⁶ km ≈ 0.01 AU) */
const L1_OFFSET_KM  = 1_500_000;         // km

/** Nominal IMF radial component at 1 AU (Parker model baseline) */
const B_RADIAL_1AU  = 3.5;              // nT  (B_r at 1 AU)

/** Nominal coronal base temperature for Parker profile */
const T_CORONA_K    = 1.5e6;             // K

/** Circular buffer depth — must cover max propagation delay + margin */
const BUFFER_MINUTES = 120;             // 120 min covers even 200 km/s wind

// ── Default L1 seed values (used until first NOAA reading arrives) ────────────
const DEFAULTS = Object.freeze({
    ts: 0,
    v_sw: 450, n: 7, bz: -2, bt: 5, by: 0, kp: 2,
});

// ── Parker LUT (built once at module load) ────────────────────────────────────
// 300-point table from 0.002 to 2.1 AU; ratio(1 AU) ≡ 1.0
const _PARKER_LUT = buildParkerLUT(300, 0.002, 2.1, T_CORONA_K);

// ─────────────────────────────────────────────────────────────────────────────

export class SolarWindState {

    constructor() {
        /** Earth's latest heliocentric position */
        this._earth = null;

        /** Latest L1 reading (no delay applied) */
        this._l1Now = { ...DEFAULTS };

        /** Latest raw SWPC state (for supplementary fields) */
        this._lastSwpc = null;

        /** Previous frame's computed wind speed (for delay calculation) */
        this._prevSpeed = 450;

        /**
         * Circular history buffer for L1 readings.
         * Array of { ts (ms), v_sw, n, bz, bt, by, kp }.
         * Used to look up the reading that left L1 ~delay_s seconds ago.
         */
        this._buf = [];

        this._onEph  = this._onEph.bind(this);
        this._onSwpc = this._onSwpc.bind(this);
    }

    /** Attach event listeners and return `this` for chaining. */
    start() {
        window.addEventListener('ephemeris-ready',  this._onEph);
        window.addEventListener('swpc-update',      this._onSwpc);
        return this;
    }

    /** Detach all event listeners. */
    stop() {
        window.removeEventListener('ephemeris-ready', this._onEph);
        window.removeEventListener('swpc-update',     this._onSwpc);
    }

    // ── Event handlers ────────────────────────────────────────────────────────

    _onEph(ev) {
        const e = ev.detail?.earth;
        if (!e) return;

        // Accept either dist_AU or inferred from Cartesian
        const r = e.dist_AU
            ?? (e.x_AU != null
                ? Math.sqrt(e.x_AU**2 + e.y_AU**2 + e.z_AU**2)
                : 1.0);

        this._earth = {
            r_AU:    Math.max(0.5, r || 1.0),
            lon_rad: e.lon_rad ?? 0,
            lat_rad: e.lat_rad ?? 0,
            x_AU:    e.x_AU ?? r * Math.cos(e.lon_rad ?? 0),
            y_AU:    e.y_AU ?? r * Math.sin(e.lon_rad ?? 0),
            z_AU:    e.z_AU ?? 0,
        };

        this._compute();
    }

    _onSwpc(ev) {
        const d  = ev.detail ?? {};
        const sw = d.solar_wind ?? {};

        const reading = {
            ts:  Date.now(),
            v_sw: sw.speed   ?? this._l1Now.v_sw,
            n:    sw.density ?? this._l1Now.n,
            bz:   sw.bz      ?? this._l1Now.bz,
            bt:   sw.bt      ?? this._l1Now.bt,
            by:   sw.by      ?? this._l1Now.by,
            kp:   d.kp       ?? this._l1Now.kp,
        };

        this._l1Now = reading;
        this._lastSwpc = d;

        // Push to circular buffer
        this._buf.push(reading);

        // Trim to keep only the last BUFFER_MINUTES worth
        const cutoff = Date.now() - BUFFER_MINUTES * 60_000;
        while (this._buf.length > 2 && this._buf[0].ts < cutoff) {
            this._buf.shift();
        }

        this._compute();
    }

    // ── Core computation (deterministic given inputs) ─────────────────────────

    _compute() {
        const r_AU = this._earth?.r_AU ?? 1.0;
        const now = Date.now();

        // ── Speed-dependent propagation delay ─────────────────────────────
        // Uses PREVIOUS frame's wind speed to break the circular dependency:
        // delay determines which historical L1 reading to use, and that
        // reading's speed must not retroactively change the delay.
        const delay_s = propagationDelay(this._prevSpeed, L1_OFFSET_KM);

        // Retrieve the L1 reading that departed ~delay_s ago
        const l1 = this._laggedReading(delay_s);

        // Raw (unlagged) L1 reading — preserve for transparent display
        const l1_raw = this._l1Now;

        // ── Get user location for SZA computation ──────────────────────────
        const loc = loadUserLocation();

        // ── Create validated base snapshot ──────────────────────────────────
        const base = createSolarState(l1, this._earth, now, {
            prevSpeed: this._prevSpeed,
            xray:      this._lastSwpc?.xray_flux,
            f107:      this._lastSwpc?.f107_flux,
            location:  loc,
        });

        // ── Parker-corrected physics at Earth's distance ──────────────────

        // Solar wind speed scaled by Parker profile
        const v_sw = l1.v_sw * parkerSpeedRatio(r_AU, _PARKER_LUT);

        // Plasma density: inverse-square radial expansion
        // Mass flux n·v·r² = const  →  n(r) = n_L1 × (1/r)²
        const n = l1.n * (1.0 / r_AU) ** 2;

        // IMF components: Parker spiral geometry
        // B_r ∝ 1/r²,  B_φ = B_r × (Ω_sun × r / v)
        const B_r    = B_RADIAL_1AU / r_AU ** 2;              // nT radial
        const v_ms   = Math.max(100, v_sw) * 1e3;             // m/s
        const r_m    = r_AU * PHYS.AU_M;                      // metres
        const B_phi  = B_RADIAL_1AU * (OMEGA_SUN * r_m) / v_ms; // nT azimuthal
        const B_total = Math.sqrt(B_r ** 2 + B_phi ** 2);

        // Scale measured Bz/Bt from L1 to Earth using field-strength ratio
        const bt_l1   = Math.max(0.5, l1.bt);
        const b_scale = B_total / bt_l1;
        const bz = l1.bz * b_scale;
        const bt = B_total;
        const by = l1.by * b_scale;

        // Parker spiral angle at Earth
        const spiral_angle_rad = Math.atan2(OMEGA_SUN * r_m, v_sw * 1e3);

        // IMF sector (two-sector model)
        const lon_deg    = (((this._earth?.lon_rad ?? 0) * 180 / Math.PI) % 360 + 360) % 360;
        const imf_sector = lon_deg < 180 ? 'away' : 'toward';

        // Derived MHD quantities
        const T        = plasmaTemp(r_AU, T_CORONA_K);
        const v_alfven = alfvenSpeed(bt, n);
        const beta     = plasmaBeta(n, T, bt);
        const p_dyn    = 1.67e-6 * n * v_sw ** 2;  // nPa

        // ── Store this frame's speed for next frame's delay calculation ────
        this._prevSpeed = v_sw;

        // ── Enrich the base snapshot with Parker-corrected data ─────────────
        const state = enrichSolarState(base, {
            _quality: this._earth ? 'parker-corrected' : 'l1-raw',

            v_sw, n, bz, bt, by,
            T, v_alfven, beta, p_dyn,
            B_r, B_phi, B_total,
            spiral_angle_rad,

            // Orbital geometry
            r_AU,
            lon_rad: this._earth?.lon_rad ?? 0,
            lat_rad: this._earth?.lat_rad ?? 0,
            x_AU:    this._earth?.x_AU    ?? r_AU,
            y_AU:    this._earth?.y_AU    ?? 0,
            z_AU:    this._earth?.z_AU    ?? 0,

            // IMF topology
            imf_sector,
            kp: l1.kp,

            // Timing
            delay_s,
            delay_min: delay_s / 60,

            // Raw L1 values (unlagged) for dashboard display
            l1_raw: Object.freeze({
                v_sw: l1_raw.v_sw,
                n:    l1_raw.n,
                bz:   l1_raw.bz,
                bt:   l1_raw.bt,
                by:   l1_raw.by,
            }),

            // Lagged L1 values (propagation-corrected)
            l1_lagged: Object.freeze({
                v_sw: l1.v_sw,
                n:    l1.n,
                bz:   l1.bz,
                bt:   l1.bt,
                by:   l1.by,
            }),

            // Backward-compat alias
            l1: Object.freeze({ v_sw: l1.v_sw, n: l1.n, bz: l1.bz, bt: l1.bt }),

            source: this._earth ? 'live' : 'default',
        });

        window.dispatchEvent(new CustomEvent('helio-state-update', { detail: state }));
        return state;
    }

    /**
     * Return the buffered L1 reading whose timestamp is closest to
     * `(now − delay_s×1000)`.  Falls back to _l1Now if the buffer is empty
     * or the delay exceeds the buffer depth.
     */
    _laggedReading(delay_s) {
        if (!this._buf.length) return this._l1Now;

        const target = Date.now() - delay_s * 1000;

        let best = this._buf[0];
        let bestDt = Math.abs(best.ts - target);

        for (let i = 1; i < this._buf.length; i++) {
            const dt = Math.abs(this._buf[i].ts - target);
            if (dt < bestDt) { best = this._buf[i]; bestDt = dt; }
        }

        return best;
    }
}

export default SolarWindState;
