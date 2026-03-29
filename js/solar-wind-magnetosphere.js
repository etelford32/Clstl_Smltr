/**
 * solar-wind-magnetosphere.js
 * Sun → Earth magnetospheric coupling engine
 *
 * Bridges the NOAA/SWPC live data stream with the MagnetosphereEngine by:
 *   1. Maintaining a rolling 90-minute L1 solar wind history buffer
 *   2. Applying the correct L1 → Earth propagation delay (~45–75 minutes)
 *   3. Computing Sun→Earth energy coupling analytics
 *   4. Feeding the lag-corrected state to MagnetosphereEngine.update()
 *   5. Dispatching 'sw-magnet-coupling' CustomEvents for the analytics panel
 *
 * ── Physics references ──────────────────────────────────────────────────────
 *  Akasofu (1981) Planet. Space Sci. 29: solar wind–magnetosphere energy
 *    coupling parameter ε = l₀² v B² sin⁴(θ/2)   [W]
 *  Newell et al. (2007) JGR: dayside merging rate
 *    Φ_D ∝ v^(4/3) Bt^(2/3) sin^(8/3)(θ/2)   [strongest Dst predictor]
 *  Iijima & Potemra (1976) JGR: Birkeland (field-aligned) current scaling
 *    |I_FAC| ∝ v^0.72 |Bz_south|^0.95 n^0.23   [MA]
 *  McPherron (1995): substorm onset trigger — near-Earth neutral line model
 *  Borovsky & Funsten (2003) JGR: coupling function survey
 *  Vršnak & Žic (2007) A&A: CME drag-based transit time model
 *  Petschek (1964): fast magnetic reconnection at dayside X-line
 *    V_rec / V_A ≈ π / (8 ln S)   for anomalous-resistivity regime
 *
 * ── Exported API ─────────────────────────────────────────────────────────────
 *  SunEarthCoupling    class   — instantiate once, call .start() / .stop()
 *  akasofuEpsilon      function — energy coupling parameter (W)
 *  newellMergingRate   function — dayside reconnection flux rate
 *  fieldAlignedCurrent function — Region 1+2 Birkeland current (MA)
 *  substormIndex       function — onset likelihood 0–1
 *  cmeTransitTime      function — ballistic CME arrival estimate (hours)
 */

import { alfvenSpeed, petschekRate } from './helio-physics.js';

// L1 Lagrange point offset from Earth (km)
const L1_OFFSET_KM = 1_500_000;

// ─────────────────────────────────────────────────────────────────────────────
//  Physics functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Akasofu (1981) solar wind–magnetosphere energy coupling parameter.
 *
 *   ε = l₀² × v × B² × sin⁴(θ/2)   [Watts]
 *
 * where θ is the IMF clock angle in the GSM Y-Z plane
 *   (θ = 0 = northward Bz → no coupling; θ = π = southward Bz → full coupling)
 * and l₀ ≈ 7 R_E is the effective coupling length.
 *
 * Typical range:
 *   Quiet:        ε < 5×10¹⁰ W   (< 50 GW)
 *   Active/storm: ε ~ 10¹¹–10¹² W  (100 GW – 1 TW)
 *   Extreme:      ε > 10¹² W      (> 1 TW)
 *
 * @param {number} v    solar wind speed (km/s)
 * @param {number} bt   total IMF magnitude (nT)
 * @param {number} bz   IMF Bz in GSM (nT, northward positive)
 * @param {number} by   IMF By in GSM (nT, dawn-dusk)
 * @returns {number} ε in Watts
 */
export function akasofuEpsilon(v, bt, bz, by = 0) {
    const L0_M   = 7 * 6.371e6;                    // 7 R_E in metres
    const B_T    = Math.max(0.1, bt) * 1e-9;        // nT → T
    const V_MS   = Math.max(200, v)  * 1e3;         // km/s → m/s
    const MU0    = 1.256_637e-6;                    // H m⁻¹
    // Clock angle: 0 = +Bz (northward), π = −Bz (southward)
    const theta  = Math.atan2(-by, -bz);
    const s      = Math.sin(theta / 2);
    const coupling = s * s * s * s;                 // sin⁴(θ/2)
    return (L0_M * L0_M * V_MS * B_T * B_T * coupling) / MU0;
}

/**
 * Newell et al. (2007) dayside merging (reconnection flux) rate.
 *
 *   Φ_D = v^(4/3) × Bt^(2/3) × sin^(8/3)(θ/2)
 *
 * Shown to be the best single-parameter predictor of both ring-current Dst
 * injection and auroral power (Newell et al. 2007, JGR 112, A01206).
 * Return value is a dimensionless proxy (normalise to 1 at typical active conditions).
 *
 * @param {number} v    solar wind speed (km/s)
 * @param {number} bt   total IMF (nT)
 * @param {number} bz   IMF Bz (nT)
 * @param {number} by   IMF By (nT)
 * @returns {number} merging rate proxy
 */
export function newellMergingRate(v, bt, bz, by = 0) {
    const theta   = Math.atan2(-by, -bz);
    const sinHalf = Math.abs(Math.sin(theta / 2));
    return Math.pow(Math.max(200, v), 4 / 3)
         * Math.pow(Math.max(0.1, bt), 2 / 3)
         * Math.pow(sinHalf, 8 / 3);
}

/**
 * Iijima & Potemra (1976) total Region 1 + Region 2 Birkeland
 * (field-aligned) current strength.
 *
 *   |I_FAC| ≈ 0.046 × (v/400)^0.72 × |Bz_south|^0.95 × n^0.23   [MA]
 *
 * Valid for Kp 1–9 and southward IMF.  Returns small quiet-time value for
 * northward IMF (viscous R2 FAC persists even when Bz > 0).
 *
 * @param {number} v   solar wind speed (km/s)
 * @param {number} bz  IMF Bz (nT, northward positive)
 * @param {number} n   solar wind density (cm⁻³)
 * @returns {number} total FAC in megaamperes
 */
export function fieldAlignedCurrent(v, bz, n) {
    const vNorm = Math.pow(Math.max(200, v) / 400, 0.72);
    const nNorm = Math.pow(Math.max(0.5, n), 0.23);
    if (bz >= 0) {
        // Northward IMF: quiet-time viscous FAC only (~0.1–0.4 MA)
        return 0.10 * vNorm * nNorm;
    }
    const bzPow = Math.pow(Math.abs(bz), 0.95);
    return 0.046 * vNorm * bzPow * nNorm;
}

/**
 * Substorm onset likelihood index [0, 1].
 * Based on the McPherron (1995) near-Earth neutral-line trigger:
 *   - Accumulation of southward-Bz-driven lobe flux (bzCumul)
 *   - Cross-tail current exceeds threshold (Akasofu ε > ~2×10¹¹ W)
 *   - Storm main phase suppresses isolated substorms (Kp > 6 → ring current)
 *
 * This is a heuristic index, not a quantitative prediction.
 *
 * @param {number} epsilonW    Akasofu ε (W)
 * @param {number} bzCumulNorm Cumulative southward Bz drive [0,1], normalised
 * @param {number} kp          Kp index
 * @returns {number} substorm index [0,1]
 */
export function substormIndex(epsilonW, bzCumulNorm, kp) {
    const epsNorm  = Math.min(1, epsilonW / 5e11);
    const bzDrive  = Math.min(1, bzCumulNorm);
    const stormSup = kp > 6 ? 0.45 : 1.0;   // main-phase suppression
    return Math.min(1, (epsNorm * 0.60 + bzDrive * 0.40) * stormSup);
}

/**
 * CME Sun→Earth transit time (hours).
 * Uses Vršnak & Žic (2007) drag-based model:
 *   t ≈ L / v_eff   where v_eff = 0.8×v_CME + 0.2×v_sw (drag deceleration)
 *
 * @param {number} v_cme  CME initial speed at Sun (km/s)
 * @param {number} v_sw   Ambient solar wind speed (km/s)
 * @returns {number} transit time in hours
 */
export function cmeTransitTime(v_cme, v_sw = 400) {
    const L_KM  = 1.496e8;   // 1 AU in km
    const v_eff = Math.max(250, 0.80 * v_cme + 0.20 * v_sw);
    return L_KM / v_eff / 3600;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SunEarthCoupling
// ─────────────────────────────────────────────────────────────────────────────

export class SunEarthCoupling {
    /**
     * @param {object} magnetosphereEngine   MagnetosphereEngine instance
     * @param {object} [opts]
     * @param {number} [opts.bufferMinutes=90]  L1 history window for substorm accumulation
     */
    constructor(magnetosphereEngine, opts = {}) {
        this._mag          = magnetosphereEngine;
        this._bufMinutes   = opts.bufferMinutes ?? 90;

        // Circular L1 history buffer: { t_ms, speed, density, bz, bt, by }
        this._l1Buf = [];

        // Rolling southward-Bz integral for substorm trigger
        this._bzCumulNorm = 0;

        this._onSwpc = this._onSwpc.bind(this);
    }

    start() {
        window.addEventListener('swpc-update', this._onSwpc);
    }

    stop() {
        window.removeEventListener('swpc-update', this._onSwpc);
    }

    // ── Private ──────────────────────────────────────────────────────────────

    _onSwpc(ev) {
        const sw   = ev.detail;
        const wind = sw.solar_wind ?? {};

        const speed   = Math.max(200,  wind.speed   ?? 400);
        const density = Math.max(0.5,  wind.density ?? 5);
        const bz      = wind.bz  ?? 0;
        const bt      = Math.max(0.5,  wind.bt   ?? 5);
        const by      = wind.by  ?? 0;
        const kp      = sw.kp    ?? 2;
        const f107    = sw.f107_flux  ?? 150;
        const xray    = sw.xray_flux  ?? 1e-8;
        const now_ms  = Date.now();

        // ── Store raw L1 reading ───────────────────────────────────────────
        this._l1Buf.push({ t_ms: now_ms, speed, density, bz, bt, by });

        // Prune buffer older than 90 minutes
        const cutoff = now_ms - this._bufMinutes * 60_000;
        this._l1Buf  = this._l1Buf.filter(r => r.t_ms >= cutoff);

        // ── Compute propagation delay ──────────────────────────────────────
        // Δt = L1 offset / observed solar wind speed
        const delay_s   = L1_OFFSET_KM / speed;    // seconds
        const delay_min = delay_s / 60;

        // Find the L1 reading that was observed ~delay_s ago
        const target_ms   = now_ms - delay_s * 1000;
        const lagged      = this._laggedReading(target_ms) ?? this._l1Buf[0];

        // ── Synthesise lag-corrected magnetospheric state ─────────────────
        const laggedState = {
            solar_wind: {
                speed:   lagged.speed,
                density: lagged.density,
                bz:      lagged.bz,
                bt:      lagged.bt,
                by:      lagged.by,
            },
            kp,
            f107_flux: f107,
            xray_flux: xray,
        };

        // Feed the propagation-delay-corrected state to MagnetosphereEngine
        this._mag.update(laggedState);

        // ── Analytics computations ─────────────────────────────────────────
        // Use current live state for all coupling metrics (they describe the
        // conditions at L1 that will arrive at Earth in ~delay_min minutes)
        const epsilon   = akasofuEpsilon(speed, bt, bz, by);
        const merging   = newellMergingRate(speed, bt, bz, by);
        const fac       = fieldAlignedCurrent(speed, bz, density);

        // Alfvén speed and Petschek reconnection rate at the dayside X-line
        // Use lagged state (what's actually at the magnetopause now)
        const va        = alfvenSpeed(lagged.bt, lagged.density);  // km/s
        // L = 1 R_E in AU for current-sheet half-length at X-line
        const L_re_AU   = 6.371e6 / 1.496e11;
        const petschek  = petschekRate(L_re_AU, va);   // dimensionless V_rec/V_A
        const vReconn   = petschek * va;               // km/s

        // Clock angle of current live IMF
        const clockRad     = Math.atan2(-by, -bz);
        const clockDeg     = clockRad * (180 / Math.PI);

        // Plasma beta (using lagged density + field at magnetopause)
        // T ≈ 1.5×10⁵ K at 1 AU (typical proton temperature)
        const T_1AU  = 1.5e5;
        const beta   = (2 * 1.256_637e-6 * lagged.density * 1e6 * 1.380_649e-23 * T_1AU)
                     / Math.max(1e-20, (lagged.bt * 1e-9) ** 2);

        // Rolling southward-Bz integral for substorm onset trigger
        // Accumulate normalised Bz drive from buffer
        if (this._l1Buf.length > 1) {
            const bzDrives = this._l1Buf.map(r => Math.max(0, -r.bz) / 20);
            this._bzCumulNorm = bzDrives.reduce((s, v) => s + v, 0) / bzDrives.length;
        }

        const substorm = substormIndex(epsilon, this._bzCumulNorm, kp);

        // Dynamic pressure (nPa) from lagged state
        const pdyn = 1.67e-6 * lagged.density * lagged.speed ** 2;

        // CME transit time for any active CME
        let cme_eta_h = null;
        if (sw.new_cme_detected && sw.cme_speed) {
            cme_eta_h = cmeTransitTime(sw.cme_speed, speed);
        }

        // ── Dispatch analytics event ───────────────────────────────────────
        const coupling = {
            // Energy coupling
            epsilon_GW:       epsilon / 1e9,             // GW (10⁹ W)
            merging_norm:     Math.min(1, merging / 8e7), // [0,1]

            // IMF geometry
            clock_angle_deg:  clockDeg,                  // °, 0=north, ±180=south
            spiral_angle_deg: 45,                        // nominal Parker spiral at 1 AU

            // Magnetospheric response
            fac_MA:           fac,                       // MA, Region 1+2 total
            substorm_index:   substorm,                  // [0,1] onset likelihood
            reconnection_kms: vReconn,                   // km/s at dayside X-line

            // Plasma state at magnetopause (lagged)
            v_alfven:   va,                              // km/s
            beta:       beta,                            // plasma β
            pdyn:       pdyn,                            // nPa
            lag_min:    delay_min,                       // minutes L1→Earth delay

            // Magnetosphere geometry (from engine)
            r0:    this._mag.analysis?.r0        ?? 10.9,
            alpha: this._mag.analysis?.alpha     ?? 0.58,
            dst:   this._mag.analysis?.dst       ?? 0,

            // CME
            cme_eta_h,
        };

        window.dispatchEvent(new CustomEvent('sw-magnet-coupling', { detail: coupling }));
    }

    /** Binary-search the buffer for the reading closest to target_ms. */
    _laggedReading(target_ms) {
        const buf = this._l1Buf;
        if (!buf.length) return null;
        let lo = 0, hi = buf.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (buf[mid].t_ms <= target_ms) lo = mid; else hi = mid - 1;
        }
        return buf[lo];
    }
}
