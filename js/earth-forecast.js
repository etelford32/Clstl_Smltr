/**
 * earth-forecast.js — Earth-Side Space Weather Consequence Forecast
 *
 * Synthesises live SWPC data, AR(p) Kp forecasts, CME propagation, and
 * ionospheric physics into an actionable "what does today's solar event
 * mean for Earth?" forecast panel.
 *
 * ── Forecast categories ─────────────────────────────────────────────────────
 *  1. Radio blackout risk       — D-layer HF absorption from X-ray flux
 *  2. Aurora likelihood         — Kp-based equatorward boundary estimate
 *  3. GNSS/GPS degradation risk — TEC disturbance + scintillation proxy
 *  4. Geomagnetic storm timing  — Kp forecast + CME ETA window
 *  5. Satellite & power-grid    — Radiation dose, GIC risk by latitude
 *  6. Ionospheric disturbance   — D/E/F2 layer perturbation windows
 *
 * ── Data sources consumed ───────────────────────────────────────────────────
 *  • swpc-update           — live Kp, Bz, X-ray, wind, protons, F10.7
 *  • cme-propagation-update — CmeEvent objects with ETA + impact
 *  • impact-score-update    — time-windowed storm probabilities
 *
 * ── Exported API ────────────────────────────────────────────────────────────
 *  EarthForecastEngine   class — start(), stop(), getResult()
 *  Dispatches 'earth-forecast-update' CustomEvent on each refresh.
 */

import { computeIonoLayers } from './magnetosphere-engine.js';
import { loadUserLocation }  from './user-location.js';

// ── NOAA R-scale (Radio Blackout) from X-ray flux ───────────────────────────

/**
 * Map GOES 0.1–0.8 nm X-ray peak flux to NOAA R-scale.
 *   R0  (none)     < C1        (< 1e-6)
 *   R1  (minor)    M1–M4.9     (1e-5 – 4.9e-5)
 *   R2  (moderate) M5–M9.9     (5e-5 – 9.9e-5)
 *   R3  (strong)   X1–X9.9     (1e-4 – 9.9e-4)
 *   R4  (severe)   X10–X19.9   (1e-3 – 1.9e-3)
 *   R5  (extreme)  ≥ X20       (≥ 2e-3)
 */
function rScale(flux) {
    if (flux >= 2e-3)  return 5;
    if (flux >= 1e-3)  return 4;
    if (flux >= 1e-4)  return 3;
    if (flux >= 5e-5)  return 2;
    if (flux >= 1e-5)  return 1;
    return 0;
}

const R_LABELS = ['None', 'Minor', 'Moderate', 'Strong', 'Severe', 'Extreme'];
const R_COLORS = ['#44cc88', '#ffcc00', '#ff9900', '#ff5500', '#ff2255', '#ff00aa'];
const R_DESCS = [
    'No HF radio impact expected.',
    'Weak HF radio degradation on sunlit side. Low-frequency navigation signals degraded for brief intervals.',
    'Limited HF radio blackout on sunlit side. Degraded low-frequency navigation for tens of minutes.',
    'Wide-area HF blackout for ~1 hour on sunlit side. Low-frequency navigation disrupted for ~1 hour.',
    'HF radio blackout on entire sunlit side for 1–2 hours. Minor GPS errors at low latitudes.',
    'Complete HF radio blackout on sunlit side lasting hours. Significant GPS single-frequency errors.',
];

// ── NOAA G-scale (Geomagnetic Storm) from Kp ───────────────────────────────

function gScale(kp) {
    if (kp >= 9) return 5;
    if (kp >= 8) return 4;
    if (kp >= 7) return 3;
    if (kp >= 6) return 2;
    if (kp >= 5) return 1;
    return 0;
}

const G_LABELS = ['None', 'Minor', 'Moderate', 'Strong', 'Severe', 'Extreme'];
const G_COLORS = ['#44cc88', '#ffcc00', '#ff9900', '#ff5500', '#ff2255', '#ff00aa'];

// ── Aurora equatorward boundary ─────────────────────────────────────────────

/**
 * Estimate the equatorward boundary of the aurora oval from Kp.
 * Empirical relation: ~67° at Kp=0 → ~45° at Kp=9 (geomagnetic latitude).
 *
 * Returns { boundary_deg, cities, visible_at_lat }.
 */
function auroraForecast(kp, userLat) {
    // Equatorward boundary of visible aurora (degrees geomagnetic latitude)
    const boundary = 67 - kp * (22 / 9);
    const absLat = userLat != null ? Math.abs(userLat) : null;

    // Map to city references
    const cities = [];
    if (boundary <= 65) cities.push('Tromsø, Fairbanks');
    if (boundary <= 60) cities.push('Anchorage, Reykjavik');
    if (boundary <= 57) cities.push('Helsinki, Juneau');
    if (boundary <= 55) cities.push('Edinburgh, Moscow');
    if (boundary <= 52) cities.push('Manchester, Hamburg');
    if (boundary <= 50) cities.push('Brussels, Calgary');
    if (boundary <= 48) cities.push('Paris, Seattle');
    if (boundary <= 45) cities.push('Milan, Portland OR');

    let visibleForUser = null;
    if (absLat != null) {
        // Rough geomagnetic offset (~3° for geographic → geomagnetic at mid-lats)
        const magLat = absLat + 3;
        visibleForUser = magLat >= boundary;
    }

    return {
        boundary_deg: Math.round(boundary),
        cities,
        visible_for_user: visibleForUser,
    };
}

// ── GNSS / GPS degradation risk ─────────────────────────────────────────────

/**
 * Assess GNSS degradation risk from ionospheric conditions.
 *
 * Key factors:
 *  - TEC (Total Electron Content): range delay ∝ TEC / f²
 *  - Scintillation: phase/amplitude fluctuations from TEC gradients
 *  - Storm-enhanced density (SED): mid-lat plume during storms
 *
 * @param {number} tec    — TECU (typical 5–100)
 * @param {number} kp     — geomagnetic index
 * @param {number} absLat — user's |latitude| (optional)
 * @returns {{ level: 0-3, label, color, desc, range_delay_m }}
 */
function gnssRisk(tec, kp, absLat) {
    // Single-frequency GPS range delay: Δr ≈ 0.163 × TEC (metres) at L1
    const rangeDelay = 0.163 * tec;

    // Scintillation risk proxy: high Kp + high TEC + polar/equatorial latitudes
    let risk = 0;
    if (tec > 60 || kp >= 7) risk = 3;
    else if (tec > 40 || kp >= 5) risk = 2;
    else if (tec > 25 || kp >= 4) risk = 1;

    // Amplify risk at vulnerable latitudes
    if (absLat != null) {
        if (absLat > 60 && kp >= 4) risk = Math.min(3, risk + 1);  // polar cap
        if (absLat < 25 && tec > 30) risk = Math.min(3, risk + 1);  // equatorial
    }

    const labels = ['Low', 'Moderate', 'High', 'Severe'];
    const colors = ['#44cc88', '#ffcc00', '#ff9900', '#ff2255'];
    const descs = [
        'Normal GNSS accuracy. Single-frequency error < 5 m.',
        'Elevated TEC causing 5–15 m single-frequency error. Dual-frequency users unaffected.',
        'High TEC or storm-enhanced density. Possible lock loss on single-frequency receivers. Dual-frequency degraded.',
        'Severe scintillation or extreme TEC. Widespread GPS accuracy degradation. Aviation WAAS may be unavailable.',
    ];

    return {
        level: risk,
        label: labels[risk],
        color: colors[risk],
        desc: descs[risk],
        range_delay_m: +rangeDelay.toFixed(1),
    };
}

// ── Satellite & power-grid risk ─────────────────────────────────────────────

/**
 * Assess satellite and power-grid impacts from current conditions.
 *
 * Satellite: SEP flux, radiation belts, surface charging from Kp
 * Power-grid: GIC (geomagnetically induced currents) from dB/dt ∝ Kp²
 *
 * @param {number} kp
 * @param {number} sepLevel  — NOAA S-scale (0-5)
 * @param {number} absLat    — user's |latitude|
 * @returns {{ satellite: {level, label, desc}, powerGrid: {level, label, desc} }}
 */
function infrastructureRisk(kp, sepLevel, absLat) {
    // ── Satellite risk ──
    let satLevel = 0;
    if (sepLevel >= 4 || kp >= 8) satLevel = 3;
    else if (sepLevel >= 2 || kp >= 7) satLevel = 2;
    else if (sepLevel >= 1 || kp >= 5) satLevel = 1;

    const satLabels = ['Low', 'Elevated', 'High', 'Severe'];
    const satColors = ['#44cc88', '#ffcc00', '#ff9900', '#ff2255'];
    const satDescs = [
        'Normal radiation environment. No impact to satellite operations.',
        'Elevated single-event upset (SEU) risk for LEO satellites. ISS crew may shelter.',
        'High radiation dose at GEO/MEO. Solar panel degradation possible. Star tracker blinding.',
        'Severe radiation — satellite anomalies likely. Spacecraft charging at GEO. Possible loss of control.',
    ];

    // ── Power grid risk ──
    // GIC risk: primarily high-latitude grids (> 45°), scales with Kp
    let gridLevel = 0;
    const latFactor = absLat != null && absLat > 45 ? 1 : 0;
    if (kp >= 8 || (kp >= 7 && latFactor)) gridLevel = 3;
    else if (kp >= 7 || (kp >= 5 && latFactor)) gridLevel = 2;
    else if (kp >= 5) gridLevel = 1;

    const gridLabels = ['Low', 'Elevated', 'High', 'Severe'];
    const gridColors = ['#44cc88', '#ffcc00', '#ff9900', '#ff2255'];
    const gridDescs = [
        'No power grid impact expected.',
        'Weak GIC possible in high-latitude grids. Transformer monitoring recommended.',
        'Moderate GIC in high-latitude and long-line grids. Voltage irregularities possible.',
        'Severe GIC. Transformer damage risk in high-latitude grids. Wide-area blackout possible.',
    ];

    return {
        satellite: {
            level: satLevel,
            label: satLabels[satLevel],
            color: satColors[satLevel],
            desc: satDescs[satLevel],
        },
        powerGrid: {
            level: gridLevel,
            label: gridLabels[gridLevel],
            color: gridColors[gridLevel],
            desc: gridDescs[gridLevel],
        },
    };
}

// ── Storm timing window ─────────────────────────────────────────────────────

/**
 * Build a geomagnetic storm timing forecast.
 *
 * Combines:
 *  - Current Kp + G-scale
 *  - CME ETA from CmePropagator
 *  - Storm probability from impact-score engine (24h/3d windows)
 *
 * @param {number}  kp
 * @param {Array}   cmeEvents
 * @param {object}  impactResult  — from ImpactScoreEngine
 * @returns {{ current_g, onset_window, peak_window, recovery_window, cme_eta, probs }}
 */
function stormTiming(kp, cmeEvents, impactResult) {
    const g = gScale(kp);
    const now = Date.now();

    // Find closest earth-directed CME
    let cmeEta = null;
    let cmeSeverity = null;
    let cmeArrivalDate = null;
    for (const ev of (cmeEvents ?? [])) {
        if (!ev.earthDirected) continue;
        const h = ev.hoursUntilArrival?.(now);
        if (h == null || h < -6) continue; // skip old arrivals
        if (cmeEta == null || h < cmeEta) {
            cmeEta = h;
            cmeSeverity = ev.impact?.severity ?? null;
            cmeArrivalDate = ev.arrival_ms ? new Date(ev.arrival_ms) : null;
        }
    }

    // Storm windows
    let onset = null, peak = null, recovery = null;
    if (cmeEta != null && cmeEta > 0) {
        const arrMs = now + cmeEta * 3.6e6;
        onset = new Date(arrMs);
        // Kp peaks ~6-12 hours after CME arrival (sheath + magnetic cloud)
        peak = new Date(arrMs + 9 * 3.6e6);
        // Recovery: typically 24-48h after peak
        recovery = new Date(arrMs + 36 * 3.6e6);
    } else if (g >= 1) {
        // Storm already in progress
        onset = new Date(now);
        peak = new Date(now + 6 * 3.6e6);
        recovery = new Date(now + 24 * 3.6e6);
    }

    // Probabilities from impact score engine
    const probs = impactResult?.h24 ? {
        g1_24h: impactResult.h24.pG1,
        g2_24h: impactResult.h24.pG2,
        g3_24h: impactResult.h24.pG3,
    } : null;

    return {
        current_g: g,
        current_g_label: G_LABELS[g],
        current_g_color: G_COLORS[g],
        onset_window: onset,
        peak_window: peak,
        recovery_window: recovery,
        cme_eta_hours: cmeEta != null ? +cmeEta.toFixed(1) : null,
        cme_severity: cmeSeverity,
        cme_arrival_date: cmeArrivalDate,
        probs,
    };
}

// ── Ionospheric disturbance windows ─────────────────────────────────────────

/**
 * Compute ionospheric disturbance status and timing for each layer.
 *
 * @param {number} f107
 * @param {number} kp
 * @param {number} xray
 * @returns {{ layers, summary, disturbed }}
 */
function ionoDisturbance(f107, kp, xray) {
    const iono = computeIonoLayers(f107, kp, xray, 50);

    // D-layer: blackout window exists when X-ray flux is elevated
    const dLayerStatus = iono.blackout
        ? { status: 'BLACKOUT', color: '#ff2255', desc: `D-layer absorption ${iono.dLayerAbs.toFixed(1)} dB — HF radio blackout on sunlit hemisphere` }
        : iono.dLayerAbs > 3
        ? { status: 'DEGRADED', color: '#ff9900', desc: `D-layer absorption ${iono.dLayerAbs.toFixed(1)} dB — HF radio degraded at lower frequencies` }
        : { status: 'NORMAL', color: '#44cc88', desc: `D-layer absorption ${iono.dLayerAbs.toFixed(1)} dB — normal conditions` };

    // E-layer: sporadic E and enhanced ionization during storms
    const eStatus = kp >= 5
        ? { status: 'ENHANCED', color: '#ffcc00', desc: `E-layer enhanced by auroral precipitation — possible sporadic E propagation` }
        : { status: 'NORMAL', color: '#44cc88', desc: `E-layer normal — foE ${iono.foE.toFixed(1)} MHz` };

    // F2-layer: negative storm phase → reduced foF2 → GPS errors
    const f2Status = iono.foF2 < 4
        ? { status: 'DEPLETED', color: '#ff9900', desc: `F2-layer depleted (foF2 ${iono.foF2.toFixed(1)} MHz) — negative storm phase, GPS vulnerable` }
        : iono.f2Active
        ? { status: 'ACTIVE', color: '#00c6ff', desc: `F2-layer active (foF2 ${iono.foF2.toFixed(1)} MHz) — strong ionization, peak at ${Math.round(iono.hmF2)} km` }
        : { status: 'NORMAL', color: '#44cc88', desc: `F2-layer normal (foF2 ${iono.foF2.toFixed(1)} MHz) — peak at ${Math.round(iono.hmF2)} km` };

    // TEC
    const tecStatus = iono.tec > 50
        ? { status: 'HIGH', color: '#ff9900', desc: `TEC ${iono.tec.toFixed(0)} TECU — elevated single-frequency GPS error` }
        : { status: 'NORMAL', color: '#44cc88', desc: `TEC ${iono.tec.toFixed(0)} TECU — normal conditions` };

    const disturbed = iono.blackout || kp >= 5 || iono.foF2 < 4 || iono.tec > 50;

    return {
        layers: {
            dLayer: { ...dLayerStatus, abs_dB: iono.dLayerAbs },
            eLayer: eStatus,
            f2Layer: { ...f2Status, foF2: iono.foF2, hmF2: iono.hmF2 },
            tec: { ...tecStatus, value: iono.tec },
        },
        summary: disturbed
            ? 'Ionospheric disturbance detected — monitor HF radio and GPS performance'
            : 'Ionosphere quiet — no significant disturbances expected',
        disturbed,
    };
}

// ── Overall severity ────────────────────────────────────────────────────────

function overallSeverity(radioR, geoG, gnssLevel, satLevel, gridLevel, ionoDisturbed) {
    const max = Math.max(radioR, geoG, gnssLevel, satLevel, gridLevel, ionoDisturbed ? 2 : 0);
    if (max >= 4) return { level: 'EXTREME',  color: '#ff00aa', icon: '\u26A0' };
    if (max >= 3) return { level: 'SEVERE',   color: '#ff2255', icon: '\u26A0' };
    if (max >= 2) return { level: 'ELEVATED', color: '#ff9900', icon: '\u26A0' };
    if (max >= 1) return { level: 'MODERATE', color: '#ffcc00', icon: '\u25CB' };
    return { level: 'QUIET', color: '#44cc88', icon: '\u2713' };
}

// ── EarthForecastEngine ─────────────────────────────────────────────────────

/**
 * Reactive engine that listens to live data events and maintains
 * an up-to-date Earth-side space weather consequence forecast.
 *
 * Dispatches 'earth-forecast-update' CustomEvent on each recalculation.
 */
export class EarthForecastEngine {
    constructor() {
        this._lastState  = null;
        this._cmeEvents  = [];
        this._impactResult = null;
        this._result     = null;

        this._onSwpc   = this._onSwpc.bind(this);
        this._onCme    = this._onCme.bind(this);
        this._onImpact = this._onImpact.bind(this);
    }

    /** Start listening to live data events. */
    start() {
        window.addEventListener('swpc-update', this._onSwpc);
        window.addEventListener('cme-propagation-update', this._onCme);
        window.addEventListener('impact-score-update', this._onImpact);
        return this;
    }

    /** Stop listening. */
    stop() {
        window.removeEventListener('swpc-update', this._onSwpc);
        window.removeEventListener('cme-propagation-update', this._onCme);
        window.removeEventListener('impact-score-update', this._onImpact);
    }

    /** Get the latest computed result (or null). */
    getResult() {
        return this._result;
    }

    // ── Private ──────────────────────────────────────────────────────────────

    _onSwpc(ev) {
        this._lastState = ev.detail;
        this._recompute();
    }

    _onCme(ev) {
        this._cmeEvents = ev.detail?.events ?? [];
    }

    _onImpact(ev) {
        this._impactResult = ev.detail;
    }

    _recompute() {
        if (!this._lastState) return;

        const s = this._lastState;
        const loc = loadUserLocation();
        const absLat = loc?.lat != null ? Math.abs(loc.lat) : null;

        const kp      = s.kp ?? 0;
        const xray    = s.xray_flux ?? 1e-8;
        const f107    = s.f107_flux ?? 150;
        const sep     = s.sep_storm_level ?? 0;

        // ── 1. Radio blackout ───────────────────────────────────────────────
        const r = rScale(xray);
        const radio = {
            r_scale: r,
            label: R_LABELS[r],
            color: R_COLORS[r],
            desc: R_DESCS[r],
            xray_class: s.xray_class ?? '–',
        };

        // ── 2. Aurora ───────────────────────────────────────────────────────
        const aurora = auroraForecast(kp, loc?.lat);

        // ── 3. GNSS/GPS ─────────────────────────────────────────────────────
        const iono = computeIonoLayers(f107, kp, xray, 50);
        const gnss = gnssRisk(iono.tec, kp, absLat);

        // ── 4. Storm timing ─────────────────────────────────────────────────
        const timing = stormTiming(kp, this._cmeEvents, this._impactResult);

        // ── 5. Infrastructure ───────────────────────────────────────────────
        const infra = infrastructureRisk(kp, sep, absLat);

        // ── 6. Ionospheric disturbance ──────────────────────────────────────
        const ionoDist = ionoDisturbance(f107, kp, xray);

        // ── Overall ─────────────────────────────────────────────────────────
        const overall = overallSeverity(
            r, timing.current_g, gnss.level,
            infra.satellite.level, infra.powerGrid.level,
            ionoDist.disturbed,
        );

        this._result = {
            overall,
            radio,
            aurora,
            gnss,
            timing,
            infrastructure: infra,
            ionosphere: ionoDist,
            location: loc?.city ?? null,
            updated_at: Date.now(),
        };

        window.dispatchEvent(new CustomEvent('earth-forecast-update', {
            detail: this._result,
        }));
    }
}
