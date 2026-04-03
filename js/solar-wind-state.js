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
 *   • L1 → Earth propagation delay   Δt ≈ L1_offset_km / v_sw  (~45–65 min)
 *   • IMF sector classification (away/toward, two-sector model)
 *
 * EVENTS CONSUMED (window)
 * ─────────────────────────────────────────────────────────────────────────────
 *  'ephemeris-ready'   { earth: { r_AU|dist_AU, lon_rad, lat_rad, x_AU, y_AU, z_AU } }
 *  'swpc-update'       { solar_wind: { speed, density, bz, bt, by }, kp, ... }
 *
 * EVENT FIRED (window)
 * ─────────────────────────────────────────────────────────────────────────────
 *  'helio-state-update'  { r_AU, v_sw, n, bz, bt, T, v_alfven, beta, p_dyn,
 *                          spiral_angle_rad, imf_sector, delay_s, delay_min,
 *                          B_r, B_phi, B_total, x_AU, y_AU, z_AU, lon_rad,
 *                          lat_rad, kp, l1, source }
 *
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *  import { SolarWindState } from './js/solar-wind-state.js';
 *  new SolarWindState().start();
 *
 *  window.addEventListener('helio-state-update', ev => {
 *      const { r_AU, v_sw, n, spiral_angle_rad, delay_min } = ev.detail;
 *  });
 */

import {
    PHYS,
    buildParkerLUT,
    parkerSpeedRatio,
    alfvenSpeed,
    plasmaBeta,
    plasmaTemp,
} from './helio-physics.js';

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
const BUFFER_MINUTES = 90;              // 90 min covers all solar-wind speeds

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

        // Push to circular buffer
        this._buf.push(reading);

        // Trim to keep only the last BUFFER_MINUTES worth
        const cutoff = Date.now() - BUFFER_MINUTES * 60_000;
        while (this._buf.length > 2 && this._buf[0].ts < cutoff) {
            this._buf.shift();
        }

        this._compute();
    }

    // ── Core computation ──────────────────────────────────────────────────────

    _compute() {
        const r_AU = this._earth?.r_AU ?? 1.0;

        // ── Propagation delay: L1 → Earth ─────────────────────────────────
        // Fixed 60-minute nominal delay.  Previously this used Δt = L1 / v_now,
        // which created a circular dependency: fast wind shortened the delay,
        // pulling a different (possibly slower) historical reading from the
        // buffer, which should have lengthened the delay.  A fixed 60-min lag
        // matches the median transit time across typical solar wind speeds
        // (300–700 km/s → 36–83 min, median ~55 min) and is consistent with
        // the same fix applied in solar-wind-magnetosphere.js.
        const delay_s = 3600;   // fixed 60-minute nominal delay

        // Retrieve the L1 reading that departed ~delay_s ago
        const l1 = this._laggedReading(delay_s);

        // Raw (unlagged) L1 reading — preserve for transparent display
        const l1_raw = this._l1Now;

        // ── Solar wind speed at Earth's actual distance ────────────────────
        // Parker profile: V(r) = V_L1 × f(r) / f(1 AU)
        // Since the LUT is normalised so f(1 AU) = 1.0:
        //
        // NOTE: L1 sits at ~0.99 AU, so parkerSpeedRatio(0.99) ≈ 0.998 — the
        // correction is <1% for Earth's orbital range (0.983–1.017 AU).
        // For the "Earth-arrival" speed we use the LAGGED reading (what has
        // actually arrived), while for "L1 current" we pass through raw.
        const v_sw = l1.v_sw * parkerSpeedRatio(r_AU, _PARKER_LUT);

        // ── Plasma density (inverse-square radial expansion) ───────────────
        // Mass flux n·v·r² = const  →  n(r) = n_L1 × (1/r)²  (for v≈const)
        const n = l1.n * (1.0 / r_AU) ** 2;

        // ── IMF components at Earth's distance ────────────────────────────
        // Parker spiral: B_r ∝ 1/r²,  B_φ ∝ 1/r (azimuthal/tangential)
        const B_r    = B_RADIAL_1AU / r_AU ** 2;         // nT  radial
        const v_ms   = Math.max(100, v_sw) * 1e3;        // m/s for SI formula
        const r_m    = r_AU * PHYS.AU_M;                 // metres
        const B_phi  = B_RADIAL_1AU * (OMEGA_SUN * r_m) / v_ms; // nT azimuthal
        const B_total = Math.sqrt(B_r ** 2 + B_phi ** 2);       // nT total

        // Scale measured Bz/Bt from L1 to Earth using field-strength ratio
        const bt_l1    = Math.max(0.5, l1.bt);
        const b_scale  = B_total / bt_l1;
        const bz = l1.bz * b_scale;
        const bt = B_total;
        const by = l1.by * b_scale;

        // ── Parker spiral angle at Earth ───────────────────────────────────
        // φ = arctan(Ω_sun × r / v)  — angle between radial and field direction
        const spiral_angle_rad = Math.atan2(OMEGA_SUN * r_m, v_sw * 1e3);

        // ── IMF sector (two-sector Ballerina skirt model) ─────────────────
        // Heuristic: Earth's ecliptic longitude modulo 360° determines sector.
        // Real sector boundaries depend on coronal hole topology (simplified here).
        const lon_deg    = (((this._earth?.lon_rad ?? 0) * 180 / Math.PI) % 360 + 360) % 360;
        const imf_sector = lon_deg < 180 ? 'away' : 'toward';

        // ── Derived plasma state ───────────────────────────────────────────
        const T        = plasmaTemp(r_AU, T_CORONA_K);       // K
        const v_alfven = alfvenSpeed(bt, n);                  // km/s
        const beta     = plasmaBeta(n, T, bt);
        // Dynamic pressure: p_dyn = ½ m_p n v²
        // [nPa] = 1.67e-6 × n[cm⁻³] × v[km/s]²
        const p_dyn    = 1.67e-6 * n * v_sw ** 2;            // nPa

        const state = {
            // Orbital geometry
            r_AU,
            lon_rad:  this._earth?.lon_rad  ?? 0,
            lat_rad:  this._earth?.lat_rad  ?? 0,
            x_AU:     this._earth?.x_AU     ?? r_AU,
            y_AU:     this._earth?.y_AU     ?? 0,
            z_AU:     this._earth?.z_AU     ?? 0,

            // Solar wind at Earth's position (distance-corrected)
            v_sw,       // km/s — Parker-scaled from L1
            n,          // cm⁻³ — inverse-square scaled
            bz,         // nT — IMF southward component (scaled)
            bt,         // nT — total IMF (calculated)
            by,         // nT — IMF dawn-dusk component (scaled)
            T,          // K  — Parker-CGL temperature

            // IMF geometry
            B_r,              // nT — radial component
            B_phi,            // nT — azimuthal (Parker spiral) component
            B_total,          // nT — total field strength
            spiral_angle_rad, // rad — Parker spiral angle at Earth (~45° for 400 km/s)

            // Derived MHD quantities
            v_alfven,  // km/s
            beta,      // dimensionless plasma beta
            p_dyn,     // nPa — solar wind dynamic pressure

            // IMF topology
            imf_sector,  // 'away' | 'toward'
            kp: l1.kp,

            // Timing
            delay_s,
            delay_min: delay_s / 60,

            // Raw L1 values — current (unlagged) DSCOVR/ACE measurement
            // This is what NOAA shows on their dashboard right now.
            l1_raw: {
                v_sw: l1_raw.v_sw,
                n:    l1_raw.n,
                bz:   l1_raw.bz,
                bt:   l1_raw.bt,
                by:   l1_raw.by,
            },

            // Lagged L1 values — the reading from ~60 min ago that has
            // physically arrived at Earth by now (propagation-corrected)
            l1_lagged: {
                v_sw: l1.v_sw,
                n:    l1.n,
                bz:   l1.bz,
                bt:   l1.bt,
                by:   l1.by,
            },

            // Backward-compat alias
            l1: { v_sw: l1.v_sw, n: l1.n, bz: l1.bz, bt: l1.bt },

            source: this._earth ? 'live' : 'default',
        };

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
