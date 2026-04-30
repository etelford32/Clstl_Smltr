/**
 * solar-weather-forecast.js
 *
 * Statistical forecasting engine for solar weather time-series.
 * No external dependencies — pure ES module JavaScript.
 *
 * Models:
 *  1. Levinson-Durbin AR(p) — multi-step Kp / Dst forecast with prediction intervals
 *  2. Holt-Winters double exponential smoothing — level + trend
 *  3. 27-day Carrington recurrence detection — ACF at lag 27 on daily Kp
 *  4. Solar Cycle 25 phase model — sinusoidal amplitude driven by known cycle dates
 *  5. Storm probability — Monte Carlo threshold exceedance on AR forecast ensemble
 */

// ── Statistical utilities ────────────────────────────────────────────────────

function mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function variance(arr) {
    if (arr.length < 2) return 0;
    const mu = mean(arr);
    return arr.reduce((s, x) => s + (x - mu) ** 2, 0) / (arr.length - 1);
}

/**
 * Sample autocorrelation at a single lag.
 * @param {number[]} x       zero-mean or raw series
 * @param {number}   lag
 * @returns {number} autocorrelation in [-1, 1]
 */
function autocorr(x, lag) {
    if (lag >= x.length) return 0;
    const mu  = mean(x);
    let num = 0, denom = 0;
    for (let i = 0; i < x.length; i++) denom += (x[i] - mu) ** 2;
    for (let i = lag; i < x.length; i++) num += (x[i] - mu) * (x[i - lag] - mu);
    return denom === 0 ? 0 : num / denom;
}

/**
 * Full ACF vector: r[0]=1, r[1..maxLag].
 */
function acf(x, maxLag) {
    const r = new Array(maxLag + 1);
    for (let k = 0; k <= maxLag; k++) r[k] = autocorr(x, k);
    return r;
}

// ── Levinson-Durbin AR coefficient solver ────────────────────────────────────

/**
 * Solve AR(p) coefficients via the Levinson-Durbin recursion.
 * @param {number[]} r  – autocorrelation sequence r[0..p]
 * @param {number}   p  – model order
 * @returns {{ phi: number[], sigma2: number }}
 *    phi[0..p-1] = AR coefficients φ₁..φₚ
 *    sigma2      = residual variance estimate
 */
function levinsonDurbin(r, p) {
    if (p < 1) return { phi: [], sigma2: r[0] };
    if (r[0] === 0) return { phi: new Array(p).fill(0), sigma2: 0 };

    const f1 = r[1] / r[0];
    let phi = [f1];
    let E   = r[0] * (1 - f1 * f1);

    for (let m = 2; m <= p; m++) {
        // Partial correlation (reflection) coefficient
        let num = r[m];
        for (let j = 0; j < m - 1; j++) num -= phi[j] * r[m - 1 - j];
        const fm = E === 0 ? 0 : num / E;

        // Update AR vector
        const phiNew = new Array(m);
        for (let j = 0; j < m - 1; j++) {
            phiNew[j] = phi[j] - fm * phi[m - 2 - j];
        }
        phiNew[m - 1] = fm;
        phi = phiNew;
        E   = Math.max(0, E * (1 - fm * fm));
    }

    return { phi, sigma2: E };
}

// ── AR(p) model fit ──────────────────────────────────────────────────────────

/**
 * Fit AR(p) to a time series of values.
 * @param {number[]} series  – observed values (oldest first)
 * @param {number}   p       – model order (default 6)
 * @returns {{ phi, sigma2, mu }} fitted model
 */
function fitAR(series, p = 6) {
    if (series.length < p + 2) {
        // Insufficient data — return flat model
        const mu = mean(series);
        return { phi: new Array(p).fill(0), sigma2: variance(series), mu };
    }
    const mu = mean(series);
    const z  = series.map(x => x - mu);   // demean
    const r  = acf(z, p);
    const { phi, sigma2 } = levinsonDurbin(r, p);
    return { phi, sigma2, mu };
}

// ── AR multi-step forecast ───────────────────────────────────────────────────

/**
 * Compute MA(∞) ψ-coefficients of the AR process (for forecast variance).
 * ψ₀ = 1,  ψⱼ = Σᵢ φᵢ ψⱼ₋ᵢ  (i=1..min(j,p))
 */
function psiCoeffs(phi, h) {
    const psi = new Array(h).fill(0);
    psi[0] = 1;
    for (let j = 1; j < h; j++) {
        for (let i = 0; i < Math.min(j, phi.length); i++) {
            psi[j] += phi[i] * psi[j - 1 - i];
        }
    }
    return psi;
}

/**
 * Generate h-step-ahead forecasts with 80 % and 95 % prediction intervals.
 *
 * @param {{ phi, sigma2, mu }} model
 * @param {number[]} history   – last observations (oldest first), length >= p
 * @param {number}   h         – forecast horizon (steps)
 * @returns {{
 *   mean:   number[],   // point forecast  [h]
 *   lo80:   number[],   // lower 80 % PI   [h]
 *   hi80:   number[],   // upper 80 % PI   [h]
 *   lo95:   number[],   // lower 95 % PI   [h]
 *   hi95:   number[],   // upper 95 % PI   [h]
 *   sigma:  number[],   // forecast std dev [h]
 * }}
 */
function forecastAR(model, history, h) {
    const { phi, sigma2, mu } = model;
    const p   = phi.length;
    const psi = psiCoeffs(phi, h);

    // Extend history with point forecasts
    const ext = history.map(x => x - mu);   // demean
    const fhat = new Array(h);

    for (let j = 0; j < h; j++) {
        let pred = 0;
        for (let i = 0; i < p; i++) {
            const idx = ext.length - 1 - i;
            pred += phi[i] * (idx >= 0 ? ext[idx] : 0);
        }
        fhat[j] = pred;
        ext.push(pred);   // use forecast for subsequent steps
    }

    // Cumulative forecast variance: σ²ₕ = σ²ₑ × Σⱼ₌₀^{h-1} ψⱼ²
    const result = { mean: [], lo80: [], hi80: [], lo95: [], hi95: [], sigma: [] };
    let cumVar = 0;
    for (let j = 0; j < h; j++) {
        cumVar    += sigma2 * psi[j] * psi[j];
        const std  = Math.sqrt(cumVar);
        const fc   = Math.max(0, Math.min(9, fhat[j] + mu));
        result.mean.push(fc);
        result.lo80.push(Math.max(0, fc - 1.28 * std));
        result.hi80.push(Math.min(9, fc + 1.28 * std));
        result.lo95.push(Math.max(0, fc - 1.96 * std));
        result.hi95.push(Math.min(9, fc + 1.96 * std));
        result.sigma.push(std);
    }
    return result;
}

// ── Holt-Winters double exponential smoothing ─────────────────────────────────

/**
 * Double exponential smoothing (Holt's method): level + trend.
 * @param {number[]} series
 * @param {number}   alpha  – level smoothing [0,1]
 * @param {number}   beta   – trend smoothing [0,1]
 * @returns {{ level, trend, forecast(h) }}
 */
function holtSmooth(series, alpha = 0.3, beta = 0.1) {
    if (series.length < 2) {
        return { level: series[0] ?? 0, trend: 0, forecast: () => series[0] ?? 0 };
    }
    let L = series[0];
    let T = series[1] - series[0];

    for (let i = 1; i < series.length; i++) {
        const L_prev = L;
        L = alpha * series[i] + (1 - alpha) * (L + T);
        T = beta  * (L - L_prev) + (1 - beta) * T;
    }

    return {
        level: L,
        trend: T,
        forecast: (h) => Math.max(0, Math.min(9, L + h * T)),
    };
}

// ── 27-day Carrington recurrence ─────────────────────────────────────────────

/**
 * Measure the strength of the 27-day solar rotation recurrence in daily Kp.
 * Uses ACF at lag 27 days and a secondary confirmation at lag 54 days.
 *
 * @param {Array<{kp: number}>} tier2Records  – daily records (oldest first)
 * @returns {{ corr27: number, corr54: number, signal: 'strong'|'moderate'|'weak'|'none' }}
 */
function recurrence27Day(tier2Records) {
    if (tier2Records.length < 30) {
        return { corr27: 0, corr54: 0, signal: 'none' };
    }
    const kpSeries = tier2Records.map(r => r.kp);
    const r27 = autocorr(kpSeries, Math.min(27, kpSeries.length - 1));
    const r54 = kpSeries.length > 54
        ? autocorr(kpSeries, 54)
        : 0;

    let signal = 'none';
    if      (r27 > 0.55)                signal = 'strong';
    else if (r27 > 0.35)                signal = 'moderate';
    else if (r27 > 0.18 || r54 > 0.20) signal = 'weak';

    return { corr27: +r27.toFixed(3), corr54: +r54.toFixed(3), signal };
}

// ── Solar Cycle 25 phase model ───────────────────────────────────────────────

/**
 * Compute the current SC25 cycle phase and predicted activity.
 *
 * SC25 minimum:        2019-12-01
 * Predicted maximum:   2025-07-01  (NOAA/ISN consensus, ~5.5-yr half-period)
 * Cycle period:        ~11 years
 *
 * @param {number} now_ms  – current timestamp (ms), defaults to Date.now()
 * @returns {{
 *   cycleNumber:    number,   // 25
 *   phase_rad:      number,   // radians [0, 2π) from minimum
 *   phase_frac:     number,   // fraction of full cycle [0, 1)
 *   activityNorm:   number,   // normalised solar activity [0, 1]
 *   smoothedSSN:    number,   // approximate smoothed sunspot number
 *   phaseName:      string,   // 'rising'|'maximum'|'declining'|'minimum'
 *   yearsToMax:     number,   // signed — negative means past max
 *   yearsToMin:     number,   // years until next minimum
 * }}
 */
function solarCyclePhase(now_ms = Date.now()) {
    const SC25_MIN_MS  = Date.UTC(2019, 11, 1);   // 2019-12-01
    const SC25_MAX_MS  = Date.UTC(2025,  6, 1);   // 2025-07-01
    const T_CYCLE_MS   = 11 * 365.25 * 86400e3;   // 11-year period
    const T_HALF       = T_CYCLE_MS / 2;

    const elapsed     = now_ms - SC25_MIN_MS;
    const phase_rad   = (2 * Math.PI * elapsed) / T_CYCLE_MS;
    const phase_frac  = (elapsed % T_CYCLE_MS) / T_CYCLE_MS;

    // Activity: 0 at minimum, 1 at maximum (smooth sinusoid)
    const activityNorm = Math.max(0,
        0.5 + 0.5 * Math.sin(phase_rad - Math.PI / 2));

    // Approximate SSN (SC25 predicted max SSN ≈ 137)
    const smoothedSSN = Math.round(activityNorm * 137);

    // Phase name
    const yearsFromMin = elapsed / (365.25 * 86400e3);
    const yearsToMax   = (SC25_MAX_MS - now_ms) / (365.25 * 86400e3);
    const SC25_NEXT_MIN_MS = SC25_MIN_MS + T_CYCLE_MS;
    const yearsToMin   = (SC25_NEXT_MIN_MS - now_ms) / (365.25 * 86400e3);

    let phaseName;
    if      (yearsFromMin < 2.5) phaseName = 'rising';
    else if (Math.abs(yearsToMax) < 1.5) phaseName = 'maximum';
    else if (yearsToMin < 2.5)  phaseName = 'minimum';
    else                         phaseName = 'declining';

    return {
        cycleNumber: 25,
        phase_rad:   +phase_rad.toFixed(4),
        phase_frac:  +phase_frac.toFixed(4),
        activityNorm: +activityNorm.toFixed(3),
        smoothedSSN,
        phaseName,
        yearsToMax:  +yearsToMax.toFixed(2),
        yearsToMin:  +yearsToMin.toFixed(2),
    };
}

// ── Persistence baseline ─────────────────────────────────────────────────────

/**
 * Dumbest-model-that-works Kp forecast: "Kp(t) = Kp_now", with prediction
 * intervals that grow with horizon. This is the null model any skilled
 * forecast must beat; shipping it on the dashboard keeps us honest about
 * whether the AR(p) bands are doing real work or just decoration.
 *
 * Uncertainty grows as σ(t) = σ_climo · √(t / τ), approaching climatological
 * spread by ~τ hours. τ=24h is an empirical match to Owens et al. (2013)
 * persistence-skill-decay analyses for Kp at mid-latitudes.
 *
 * @param {number}   kpNow       — current Kp value
 * @param {number[]} history     — recent hourly Kp (for σ_climo fallback)
 * @param {number}   horizon_h   — forecast horizon (hours)
 * @param {object}   opts
 * @param {number}   [opts.tau]         — e-folding time for uncertainty (default 24h)
 * @param {number}   [opts.sigmaClimo]  — long-run Kp std dev (default 1.6, ~7-day σ of estimated Kp)
 * @returns {{ mean, lo80, hi80, lo95, hi95, sigma: number[] }}
 */
function persistenceForecast(kpNow, history, horizon_h, opts = {}) {
    const tau = opts.tau ?? 24;
    // Prefer observed σ of the recent window, floor at climatological value,
    // cap at a physically implausible ceiling to avoid blow-up on tiny samples.
    const sigmaSample = Math.sqrt(variance(history ?? []));
    const sigmaClimo = opts.sigmaClimo ?? Math.max(1.2, Math.min(2.2, sigmaSample || 1.6));

    const mean  = new Array(horizon_h);
    const sigma = new Array(horizon_h);
    const lo80  = new Array(horizon_h);
    const hi80  = new Array(horizon_h);
    const lo95  = new Array(horizon_h);
    const hi95  = new Array(horizon_h);

    const kpClamped = Math.max(0, Math.min(9, kpNow ?? 0));
    for (let h = 0; h < horizon_h; h++) {
        const tHours = h + 1;   // forecast for end of hour (1..horizon_h)
        const s = sigmaClimo * Math.sqrt(tHours / tau);
        mean[h]  = kpClamped;
        sigma[h] = s;
        lo80[h]  = Math.max(0, kpClamped - 1.28 * s);
        hi80[h]  = Math.min(9, kpClamped + 1.28 * s);
        lo95[h]  = Math.max(0, kpClamped - 1.96 * s);
        hi95[h]  = Math.min(9, kpClamped + 1.96 * s);
    }
    return { mean, lo80, hi80, lo95, hi95, sigma };
}

// ── Storm probability ────────────────────────────────────────────────────────

/**
 * Estimate probability of at least one Kp exceedance above threshold
 * within the forecast horizon, using forecast mean + sigma.
 *
 * Uses a normal approximation and the complement of the joint non-exceedance.
 *
 * @param {number[]} fcMean   – AR point forecast [h]
 * @param {number[]} fcSigma  – forecast std dev [h]
 * @param {number}   threshold – Kp threshold (G1=5, G2=6, G3=7)
 * @returns {number} probability in [0, 1]
 */
function stormProbability(fcMean, fcSigma, threshold) {
    if (!fcMean.length) return 0;
    // Complement of probability that ALL hourly Kp stay below threshold
    let pNone = 1;
    for (let i = 0; i < fcMean.length; i++) {
        const s = fcSigma[i] || 1e-6;
        const z = (threshold - fcMean[i]) / s;
        // Φ(z) ≈ normal CDF via logistic approximation
        const pBelow = 1 / (1 + Math.exp(-1.7 * z));
        pNone *= pBelow;
    }
    return Math.max(0, Math.min(1, 1 - pNone));
}

// ── SolarWeatherForecaster ────────────────────────────────────────────────────

/**
 * Main forecasting class. Call `update(history)` periodically to refresh.
 *
 * @example
 *   const forecaster = new SolarWeatherForecaster();
 *   setInterval(() => {
 *     const result = forecaster.update(history);
 *     renderForecastPanel(result);
 *   }, 5 * 60_000);
 */
export class SolarWeatherForecaster {
    constructor() {
        this.latestResult = null;
    }

    /**
     * Run all models and return a ForecastResult object.
     *
     * @param {import('./solar-weather-history.js').SolarWeatherHistory} history
     * @param {number} horizon_h   – forecast horizon in hours (default 72)
     * @returns {ForecastResult}
     */
    update(history, horizon_h = 72) {
        const tier1 = history.getTier(1);  // hourly
        const tier2 = history.getTier(2);  // daily

        // ── Extract Kp series ──────────────────────────────────────────────
        const kpHourly = tier1.map(r => r.kp);
        const kpDaily  = tier2.map(r => r.kp);
        // Use last 7 days (168 h) of hourly data for AR fitting
        const kpFit    = kpHourly.slice(-168);

        // ── AR(6) forecast ─────────────────────────────────────────────────
        const arModel  = fitAR(kpFit, 6);
        const arFc     = forecastAR(arModel, kpFit, horizon_h);

        // ── Holt-Winters smoothing on last 72h of hourly Kp ───────────────
        const kpRecent = kpHourly.slice(-72);
        const hw       = holtSmooth(kpRecent, 0.3, 0.08);
        const hwFc24   = hw.forecast(24);
        const hwFc72   = hw.forecast(72);

        // ── Storm probabilities (next 24 h and 72 h) ───────────────────────
        const fc24Mean  = arFc.mean.slice(0, 24);
        const fc24Sigma = arFc.sigma.slice(0, 24);
        const fc72Mean  = arFc.mean;
        const fc72Sigma = arFc.sigma;

        const pG1_24h = stormProbability(fc24Mean, fc24Sigma, 5);
        const pG2_24h = stormProbability(fc24Mean, fc24Sigma, 6);
        const pG3_24h = stormProbability(fc24Mean, fc24Sigma, 7);
        const pG1_72h = stormProbability(fc72Mean, fc72Sigma, 5);
        const pG2_72h = stormProbability(fc72Mean, fc72Sigma, 6);
        const pG3_72h = stormProbability(fc72Mean, fc72Sigma, 7);

        // ── 27-day recurrence ─────────────────────────────────────────────
        const recurrence = recurrence27Day(tier2);

        // ── Solar cycle phase ─────────────────────────────────────────────
        const cycle = solarCyclePhase();

        // ── Recent Kp summary stats ───────────────────────────────────────
        const kpMean24h = mean(kpHourly.slice(-24));
        const kpMax24h  = kpHourly.slice(-24).reduce((m, x) => Math.max(m, x), 0);

        const result = {
            // AR forecast arrays (h = horizon_h steps)
            arForecast: arFc,

            // Holt-Winters trending
            hw: { level: hw.level, trend: hw.trend, fc24: hwFc24, fc72: hwFc72 },

            // Storm probabilities
            storm: {
                g1_24h: pG1_24h, g2_24h: pG2_24h, g3_24h: pG3_24h,
                g1_72h: pG1_72h, g2_72h: pG2_72h, g3_72h: pG3_72h,
            },

            // Recurrence
            recurrence,

            // Solar cycle
            cycle,

            // Recent summary
            summary: {
                kpMean24h: +kpMean24h.toFixed(2),
                kpMax24h:  +kpMax24h.toFixed(1),
                kpFC24h:   +arFc.mean[23]?.toFixed(2),
                kpFC72h:   +arFc.mean[71]?.toFixed(2),
                sigma24h:  +arFc.sigma[23]?.toFixed(2),
            },

            // Historical series for chart rendering
            kpHistory: kpHourly.slice(-72),
            kpForecast: arFc.mean,
            kpFcLo80: arFc.lo80,
            kpFcHi80: arFc.hi80,

            updatedAt: Date.now(),
        };

        this.latestResult = result;
        return result;
    }

    /**
     * Generate a plain-text "Space Weather Bulletin" from the latest result.
     * @returns {string}
     */
    bulletin(result = this.latestResult) {
        if (!result) return 'No forecast data yet.';

        const { summary, storm, recurrence, cycle, hw } = result;

        // Activity level descriptor
        const kp24 = summary.kpFC24h ?? summary.kpMean24h;
        let activity = 'QUIET';
        if      (kp24 >= 7) activity = 'SEVERE STORM';
        else if (kp24 >= 6) activity = 'STRONG STORM';
        else if (kp24 >= 5) activity = 'MODERATE STORM';
        else if (kp24 >= 4) activity = 'ACTIVE';
        else if (kp24 >= 3) activity = 'UNSETTLED';

        // Trend arrow from Holt-Winters
        const trend = hw.trend > 0.05 ? '↑' : hw.trend < -0.05 ? '↓' : '→';

        // Storm probability string
        const pStr = `G1+: ${Math.round(storm.g1_24h * 100)}%  `
                   + `G2+: ${Math.round(storm.g2_24h * 100)}%  `
                   + `G3+: ${Math.round(storm.g3_24h * 100)}%`;

        // 27-day echo
        const echo = recurrence.signal === 'none'
            ? 'No 27-d echo detected'
            : `27-d echo: ${recurrence.signal.toUpperCase()} (r=${recurrence.corr27})`;

        // Solar cycle context
        const cyc = cycle.phaseName === 'maximum'
            ? `SC${cycle.cycleNumber} near maximum (SSN≈${cycle.smoothedSSN})`
            : cycle.yearsToMax < 0
                ? `SC${cycle.cycleNumber} declining — ${Math.abs(cycle.yearsToMax).toFixed(1)} yr past max`
                : `SC${cycle.cycleNumber} rising — ${cycle.yearsToMax.toFixed(1)} yr to max`;

        return [
            `${activity} ${trend} — Kp forecast ${kp24} ± ${summary.sigma24h} (next 24h)`,
            `Storm prob ${pStr}`,
            echo,
            cyc,
        ].join('\n');
    }
}

// Re-export helpers for direct use in tests or other modules
export { fitAR, forecastAR, persistenceForecast, holtSmooth, recurrence27Day, solarCyclePhase, stormProbability, acf };
