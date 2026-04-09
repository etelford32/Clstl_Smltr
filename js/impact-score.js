/**
 * impact-score.js — Composite Space Weather Impact Score
 *
 * Synthesises multiple data streams into a single 0–100 score personalised
 * to the user's location, plus time-windowed storm probabilities with
 * confidence intervals.
 *
 * ── Data sources ─────────────────────────────────────────────────────────────
 *  1. Live SWPC state (Kp, Bz, solar wind speed, X-ray flux, SEP level)
 *  2. AR(p) Kp forecast from SolarWeatherForecaster (24h/72h/168h horizons)
 *  3. CME propagation events from CmePropagator (DBM physics-based ETA)
 *  4. 27-day Carrington recurrence signal
 *  5. Solar Cycle 25 phase (activity envelope)
 *  6. User location (aurora oval, GPS vulnerability, power grid risk)
 *
 * ── Score components ─────────────────────────────────────────────────────────
 *  Geomagnetic:  G-scale derived from Kp (0–30 pts)
 *  Solar:        X-ray flux + SEP (0–25 pts)
 *  CME:          Active earth-directed CME with ETA (0–25 pts)
 *  Location:     Aurora visibility + latitude-specific risks (0–20 pts)
 *
 * ── Time windows ─────────────────────────────────────────────────────────────
 *  Now:   current conditions → deterministic score
 *  24h:   AR forecast + CME ETA → P(G1+), P(G2+), P(G3+)
 *  3d:    AR forecast + CME ETA + recurrence → probability bands
 *  7d:    AR forecast + recurrence + cycle phase → probability bands
 *
 * ── Exported API ─────────────────────────────────────────────────────────────
 *  ImpactScoreEngine   class — compute(), getScore(), start()/stop()
 *  computeImpactNow    fn   — pure function for current-conditions score
 */

import { auth } from './auth.js';
import { loadUserLocation } from './user-location.js';
import {
    fitAR, forecastAR, stormProbability,
    solarCyclePhase, recurrence27Day,
} from './solar-weather-forecast.js';

// ── Score component weights (user-customisable in future) ────────────────────

const DEFAULT_WEIGHTS = {
    geomagnetic: 0.30,   // G-scale from Kp
    solar:       0.25,   // X-ray + SEP
    cme:         0.25,   // Active CME threat
    location:    0.20,   // Personal location risk
};

// ── Pure scoring functions ───────────────────────────────────────────────────

/**
 * Score the current geomagnetic conditions (0–100 raw, scaled by weight).
 */
function scoreGeomagnetic(kp) {
    // Kp 0→0, Kp 5→50, Kp 7→75, Kp 9→100
    return Math.min(100, (kp / 9) * 100);
}

/**
 * Score solar radiation conditions (0–100).
 */
function scoreSolar(xrayFlux, sepLevel) {
    // X-ray: log scale. A=0, B=12, C=25, M=50, X=80, X10+=100
    let xScore = 0;
    if (xrayFlux > 0) {
        const logF = Math.log10(Math.max(xrayFlux, 1e-9));
        xScore = Math.min(100, Math.max(0, (logF + 9) * 12.5));  // -9→0, -4→62.5, -3→75
    }
    // SEP: S0=0, S1=20, S2=40, S3=60, S4=80, S5=100
    const sepScore = Math.min(100, (sepLevel ?? 0) * 20);
    return Math.max(xScore, sepScore);
}

/**
 * Score active CME threat (0–100).
 * Factors: earth-directed flag, ETA, predicted severity, shock Mach.
 */
function scoreCme(cmeEvents) {
    if (!cmeEvents?.length) return 0;

    // Find the most threatening earth-directed CME
    let maxScore = 0;
    const now = Date.now();

    for (const ev of cmeEvents) {
        if (!ev.earthDirected) continue;
        const etaH = ev.hoursUntilArrival?.(now) ?? 999;
        if (etaH < -24) continue;  // already passed

        let s = 30;  // base: earth-directed CME exists

        // Speed contribution: 400→+0, 800→+15, 1200→+30, 2000→+40
        s += Math.min(40, Math.max(0, (ev.v0 - 400) / 40));

        // Proximity: closer = more urgent
        if (etaH <= 6)       s += 25;
        else if (etaH <= 24) s += 20;
        else if (etaH <= 48) s += 12;
        else if (etaH <= 72) s += 5;

        // Shock: Mach > 1 adds threat
        if (ev.sheath?.isShock) s += 5 + Math.min(10, ev.sheath.mach * 2);

        maxScore = Math.max(maxScore, Math.min(100, s));
    }

    return maxScore;
}

/**
 * Score location-specific risk (0–100).
 * Aurora visibility + latitude-specific GPS/power risk.
 */
function scoreLocation(kp, lat) {
    if (lat == null) return 0;
    const absLat = Math.abs(lat);

    let s = 0;

    // Aurora oval check
    const boundary = 72 - kp * (17 / 9);
    const magLat = absLat + 3;  // rough geomagnetic offset
    if (magLat >= boundary) {
        s += 40 + Math.min(30, (magLat - boundary) * 5);  // deeper in oval = higher
    }

    // GPS vulnerability (polar > 60° or equatorial < 25°)
    if (absLat > 60 && kp >= 5) s += 15;
    else if (absLat < 25 && kp >= 6) s += 10;

    // Power grid vulnerability (high latitude)
    if (absLat > 45 && kp >= 7) s += 15;

    return Math.min(100, s);
}

/**
 * Compute composite impact score for current conditions.
 *
 * @param {object} state     Live SWPC state
 * @param {Array}  cmeEvents Active CmeEvent objects from CmePropagator
 * @param {object} [weights] Custom weight overrides
 * @returns {{ score: number, components: object, label: string, color: string }}
 */
export function computeImpactNow(state, cmeEvents = [], weights = DEFAULT_WEIGHTS) {
    const kp       = state.kp ?? 0;
    const xrayFlux = state.xray_flux ?? 0;
    const sepLevel = state.sep_storm_level ?? 0;

    const loc = loadUserLocation() ?? auth.getUser()?.location;
    const lat = loc?.lat;

    const components = {
        geomagnetic: scoreGeomagnetic(kp),
        solar:       scoreSolar(xrayFlux, sepLevel),
        cme:         scoreCme(cmeEvents),
        location:    scoreLocation(kp, lat),
    };

    // Weighted sum
    const score = Math.round(Math.min(100, Math.max(0,
        components.geomagnetic * weights.geomagnetic +
        components.solar       * weights.solar +
        components.cme         * weights.cme +
        components.location    * weights.location
    )));

    // Label + colour
    let label, color;
    if (score >= 80)      { label = 'Extreme';  color = '#ff2255'; }
    else if (score >= 60) { label = 'Severe';   color = '#ff4444'; }
    else if (score >= 40) { label = 'Elevated'; color = '#ff9900'; }
    else if (score >= 20) { label = 'Moderate'; color = '#ffcc00'; }
    else                  { label = 'Quiet';    color = '#44cc88'; }

    return { score, components, label, color };
}

// ── Time-windowed probability forecasts ──────────────────────────────────────

/**
 * Compute storm probabilities at multiple time horizons from an AR model.
 *
 * @param {number[]} kpHistory   Recent hourly Kp values (oldest first)
 * @param {Array}    cmeEvents   Active CmeEvent objects
 * @param {Array}    [dailyKp]   Daily Kp records for recurrence detection
 * @returns {{
 *   now:  { score, label, color, components },
 *   h24:  { pG1, pG2, pG3, kpMean, kpHi95, confidence },
 *   d3:   { pG1, pG2, pG3, kpMean, kpHi95, confidence, cmeArrival },
 *   d7:   { pG1, pG2, pG3, kpMean, kpHi95, confidence, recurrence, cycle },
 * }}
 */
export function computeTimeWindows(state, kpHistory, cmeEvents = [], dailyKp = []) {
    // ── NOW ──────────────────────────────────────────────────────────────────
    const now = computeImpactNow(state, cmeEvents);

    // ── AR(6) model fit ──────────────────────────────────────────────────────
    const kpFit = kpHistory.slice(-168);  // last 7 days
    const model = fitAR(kpFit, 6);

    // ── 24-hour forecast ─────────────────────────────────────────────────────
    const fc24 = forecastAR(model, kpFit, 24);
    const h24 = {
        pG1:        stormProbability(fc24.mean, fc24.sigma, 5),
        pG2:        stormProbability(fc24.mean, fc24.sigma, 6),
        pG3:        stormProbability(fc24.mean, fc24.sigma, 7),
        kpMean:     +(fc24.mean[23] ?? 0).toFixed(1),
        kpHi95:     +(fc24.hi95[23] ?? 0).toFixed(1),
        confidence: _forecastConfidence(24, fc24.sigma),
    };

    // Boost probabilities if a CME arrives within 24h
    const cme24 = cmeEvents.find(e => e.earthDirected && e.hoursUntilArrival?.() > 0 && e.hoursUntilArrival() <= 24);
    if (cme24) {
        const g = cme24.impact?.g_scale ?? 1;
        h24.pG1 = Math.min(1, h24.pG1 + 0.3);
        if (g >= 2) h24.pG2 = Math.min(1, h24.pG2 + 0.25);
        if (g >= 3) h24.pG3 = Math.min(1, h24.pG3 + 0.2);
        h24.cmeArrival = true;
    }

    // ── 3-day forecast ───────────────────────────────────────────────────────
    const fc72 = forecastAR(model, kpFit, 72);
    const d3 = {
        pG1:        stormProbability(fc72.mean, fc72.sigma, 5),
        pG2:        stormProbability(fc72.mean, fc72.sigma, 6),
        pG3:        stormProbability(fc72.mean, fc72.sigma, 7),
        kpMean:     +(fc72.mean[71] ?? 0).toFixed(1),
        kpHi95:     +(fc72.hi95[71] ?? 0).toFixed(1),
        confidence: _forecastConfidence(72, fc72.sigma),
        cmeArrival: false,
    };

    // CME arriving within 3 days
    const cme72 = cmeEvents.find(e => e.earthDirected && e.hoursUntilArrival?.() > 0 && e.hoursUntilArrival() <= 72);
    if (cme72) {
        const g = cme72.impact?.g_scale ?? 1;
        d3.pG1 = Math.min(1, d3.pG1 + 0.2);
        if (g >= 2) d3.pG2 = Math.min(1, d3.pG2 + 0.15);
        if (g >= 3) d3.pG3 = Math.min(1, d3.pG3 + 0.12);
        d3.cmeArrival = true;
    }

    // ── 7-day forecast ───────────────────────────────────────────────────────
    const fc168 = forecastAR(model, kpFit, 168);
    const d7 = {
        pG1:        stormProbability(fc168.mean, fc168.sigma, 5),
        pG2:        stormProbability(fc168.mean, fc168.sigma, 6),
        pG3:        stormProbability(fc168.mean, fc168.sigma, 7),
        kpMean:     +(fc168.mean[167] ?? 0).toFixed(1),
        kpHi95:     +(fc168.hi95[167] ?? 0).toFixed(1),
        confidence: _forecastConfidence(168, fc168.sigma),
    };

    // 27-day recurrence boost
    const recurrence = recurrence27Day(dailyKp.length ? dailyKp : []);
    d7.recurrence = recurrence;
    if (recurrence.signal === 'strong') {
        d7.pG1 = Math.min(1, d7.pG1 + 0.15);
        d7.pG2 = Math.min(1, d7.pG2 + 0.08);
    } else if (recurrence.signal === 'moderate') {
        d7.pG1 = Math.min(1, d7.pG1 + 0.08);
    }

    // Solar cycle context
    d7.cycle = solarCyclePhase();

    return { now, h24, d3, d7 };
}

/**
 * Forecast confidence: degrades with horizon as AR uncertainty grows.
 * Returns 'high' | 'medium' | 'low'.
 */
function _forecastConfidence(horizon_h, sigmaArr) {
    const avgSigma = sigmaArr.reduce((s, x) => s + x, 0) / sigmaArr.length;
    if (horizon_h <= 24 && avgSigma < 1.5) return 'high';
    if (horizon_h <= 72 && avgSigma < 2.5) return 'medium';
    return 'low';
}

// ── ImpactScoreEngine ────────────────────────────────────────────────────────

/**
 * Reactive engine that listens to live data events and maintains
 * an up-to-date impact score + time-windowed forecasts.
 *
 * Dispatches 'impact-score-update' CustomEvent on each recalculation.
 */
export class ImpactScoreEngine {
    constructor() {
        this._lastState    = null;
        this._cmeEvents    = [];
        this._kpHistory    = [];
        this._dailyKp      = [];
        this._result       = null;
        this._onSwpc       = this._onSwpc.bind(this);
        this._onCme        = this._onCme.bind(this);
    }

    /** Start listening to live data events. */
    start() {
        window.addEventListener('swpc-update', this._onSwpc);
        window.addEventListener('cme-propagation-update', this._onCme);
        return this;
    }

    stop() {
        window.removeEventListener('swpc-update', this._onSwpc);
        window.removeEventListener('cme-propagation-update', this._onCme);
    }

    /** Get the latest computed result (or null). */
    getResult() {
        return this._result;
    }

    /** Inject a SolarWeatherHistory instance for richer forecasts. */
    setHistory(history) {
        if (!history) return;
        try {
            const tier1 = history.getTier(1);  // hourly
            const tier2 = history.getTier(2);  // daily
            this._kpHistory = tier1.map(r => r.kp);
            this._dailyKp   = tier2;
        } catch (_) {}
    }

    // ── Private ──────────────────────────────────────────────────────────────

    _onCme(ev) {
        this._cmeEvents = ev.detail?.events ?? [];
    }

    _onSwpc(ev) {
        this._lastState = ev.detail;

        // Accumulate Kp into history buffer (if not using SolarWeatherHistory)
        const kp = ev.detail?.kp;
        if (kp != null) {
            this._kpHistory.push(kp);
            // Keep max 168 hourly readings (7 days)
            if (this._kpHistory.length > 168) this._kpHistory.shift();
        }

        // Recompute score
        this._recompute();
    }

    _recompute() {
        if (!this._lastState) return;

        // Need at least 12 hours of history for meaningful AR forecast
        if (this._kpHistory.length < 12) {
            this._result = {
                now: computeImpactNow(this._lastState, this._cmeEvents),
                h24: null, d3: null, d7: null,
                insufficient_data: true,
            };
        } else {
            this._result = computeTimeWindows(
                this._lastState,
                this._kpHistory,
                this._cmeEvents,
                this._dailyKp,
            );
        }

        this._result.updated_at = Date.now();

        window.dispatchEvent(new CustomEvent('impact-score-update', {
            detail: this._result,
        }));
    }
}
