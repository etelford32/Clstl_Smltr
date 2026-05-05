/**
 * daily-summary.js — Daily solar activity summary + temperature prediction
 *
 * Generates a personalized daily briefing combining:
 *  1. Solar activity summary (flares, CMEs, Kp, cycle phase)
 *  2. Space weather outlook (storm probabilities, aurora forecast)
 *  3. ML-powered 7-day temperature forecast for user's location
 *  4. Plain-text shareable summary
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *  import { DailySummaryEngine } from './js/daily-summary.js';
 *  const engine = new DailySummaryEngine();
 *  const summary = await engine.generate();
 *  // summary = { solar, weather, forecast, text, generated_at }
 */

import { loadUserLocation } from './user-location.js';
import { TempForecaster }   from './temp-forecast.js';
import { solarCyclePhase }  from './solar-weather-forecast.js';

// ── Weather code descriptions (WMO standard, used by Open-Meteo) ─────────────
const WMO_CODES = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Foggy', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle',
    55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Rain showers', 81: 'Moderate showers', 82: 'Heavy showers',
    85: 'Snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'T-storm + hail', 99: 'Severe T-storm + hail',
};

// ── Flare class from flux ────────────────────────────────────────────────────
function flareClass(flux) {
    if (flux >= 1e-4) return 'X';
    if (flux >= 1e-5) return 'M';
    if (flux >= 1e-6) return 'C';
    if (flux >= 1e-7) return 'B';
    return 'A';
}

function gScale(kp) {
    if (kp >= 9) return 5;
    if (kp >= 8) return 4;
    if (kp >= 7) return 3;
    if (kp >= 6) return 2;
    if (kp >= 5) return 1;
    return 0;
}

// ── DailySummaryEngine ───────────────────────────────────────────────────────

export class DailySummaryEngine {
    constructor() {
        this._lastSwpc     = null;
        this._lastImpact   = null;
        this._tempForecaster = new TempForecaster();
        this._result       = null;
        this._generating   = false;
    }

    /** Listen for live data and cache it. */
    start() {
        window.addEventListener('swpc-update', (e) => { this._lastSwpc = e.detail; });
        window.addEventListener('impact-score-update', (e) => { this._lastImpact = e.detail; });
        return this;
    }

    /**
     * Generate the full daily summary.
     * Fetches weather data, runs ML model, combines with cached solar data.
     * @returns {Promise<object>}
     */
    async generate() {
        if (this._generating) return this._result;
        this._generating = true;

        const loc = loadUserLocation();
        const swpc = this._lastSwpc ?? {};
        const impact = this._lastImpact;

        // ── Solar activity summary ───────────────────────────────────────────
        const solar = this._buildSolarSummary(swpc, impact);

        // ── Temperature forecast (ML + GFS ensemble) ─────────────────────────
        let forecast = null;
        if (loc?.lat && loc?.lon) {
            try {
                forecast = await this._tempForecaster.fetch(loc.lat, loc.lon);
            } catch (e) {
                console.warn('[DailySummary] Temp forecast failed:', e.message);
            }
        }

        // ── Build weather section ────────────────────────────────────────────
        const weather = this._buildWeatherSection(loc, forecast);

        // ── Plain-text summary ───────────────────────────────────────────────
        const text = this._buildText(solar, weather, forecast, loc);

        this._result = {
            solar,
            weather,
            forecast: forecast?.predictions ?? [],
            model:    forecast?.model ?? null,
            text,
            location: loc?.city ?? null,
            generated_at: new Date().toISOString(),
        };

        this._generating = false;

        window.dispatchEvent(new CustomEvent('daily-summary-update', {
            detail: this._result,
        }));

        return this._result;
    }

    getResult() { return this._result; }

    // ── Private builders ─────────────────────────────────────────────────────

    _buildSolarSummary(swpc, impact) {
        const kp       = swpc.kp ?? 0;
        const g        = gScale(kp);
        const xray     = swpc.xray_flux ?? 1e-8;
        const cls      = flareClass(xray);
        const speed    = swpc.solar_wind?.speed ?? 400;
        const bz       = swpc.solar_wind?.bz ?? 0;
        const density  = swpc.solar_wind?.density ?? 5;
        const cme      = swpc.earth_directed_cme;
        const cycle    = solarCyclePhase();

        // Activity level
        let level, levelColor;
        if (g >= 4) { level = 'Extreme'; levelColor = '#ff2255'; }
        else if (g >= 3) { level = 'Severe'; levelColor = '#ff4444'; }
        else if (g >= 2) { level = 'Active'; levelColor = '#ff9900'; }
        else if (kp >= 4) { level = 'Unsettled'; levelColor = '#ffcc00'; }
        else { level = 'Quiet'; levelColor = '#44cc88'; }

        // Storm probabilities from impact score
        const probs = impact?.h24 ?? null;

        return {
            level, levelColor, kp, g_scale: g,
            xray_class: cls, xray_flux: xray,
            wind_speed: Math.round(speed), bz: +bz.toFixed(1), density: +density.toFixed(1),
            cme_active: !!cme, cme_speed: cme?.speed,
            cycle_phase: cycle.phaseName, cycle_ssn: cycle.smoothedSSN,
            storm_prob_24h: probs ? {
                g1: Math.round((probs.pG1 ?? 0) * 100),
                g2: Math.round((probs.pG2 ?? 0) * 100),
                g3: Math.round((probs.pG3 ?? 0) * 100),
            } : null,
            impact_score: impact?.now?.score ?? null,
        };
    }

    _buildWeatherSection(loc, forecast) {
        if (!loc || !forecast?.predictions?.length) {
            return { available: false, city: loc?.city ?? null };
        }

        const today    = forecast.predictions[0];
        const tomorrow = forecast.predictions[1];

        return {
            available: true,
            city: loc.city,
            today: {
                high: today.high, low: today.low,
                high_ci: today.high_ci, low_ci: today.low_ci,
                precip: today.precip_mm, cloud: today.cloud, wind: today.wind_max,
            },
            tomorrow: tomorrow ? {
                high: tomorrow.high, low: tomorrow.low,
                high_ci: tomorrow.high_ci, low_ci: tomorrow.low_ci,
                precip: tomorrow.precip_mm, cloud: tomorrow.cloud, wind: tomorrow.wind_max,
            } : null,
            week: forecast.predictions.map(d => ({
                date: d.date, high: d.high, low: d.low,
                high_ci: d.high_ci, low_ci: d.low_ci,
                source: d.source,
            })),
            model_rmse: forecast.model?.high_rmse ?? null,
        };
    }

    _buildText(solar, weather, forecast, loc) {
        const lines = [];
        const now = new Date();
        const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

        lines.push(`DAILY SPACE WEATHER BRIEFING — ${dateStr}`);
        lines.push('');

        // Solar
        lines.push(`SOLAR ACTIVITY: ${solar.level.toUpperCase()}`);
        lines.push(`Kp: ${solar.kp.toFixed(1)} (G${solar.g_scale}) · X-ray: ${solar.xray_class}-class · Wind: ${solar.wind_speed} km/s · Bz: ${solar.bz} nT`);
        if (solar.cme_active) {
            lines.push(`CME ALERT: Earth-directed CME at ${solar.cme_speed} km/s`);
        }
        if (solar.storm_prob_24h) {
            lines.push(`Storm probability (24h): G1+ ${solar.storm_prob_24h.g1}% · G2+ ${solar.storm_prob_24h.g2}% · G3+ ${solar.storm_prob_24h.g3}%`);
        }
        if (solar.impact_score != null) {
            lines.push(`Impact Score: ${solar.impact_score}/100`);
        }
        lines.push(`Solar Cycle 25: ${solar.cycle_phase} phase (SSN ≈ ${solar.cycle_ssn})`);

        // Weather
        if (weather.available) {
            lines.push('');
            lines.push(`WEATHER FORECAST — ${weather.city}`);
            if (weather.today) {
                lines.push(`Today: High ${weather.today.high}°F (±${weather.today.high_ci}°) / Low ${weather.today.low}°F (±${weather.today.low_ci}°) · Cloud ${weather.today.cloud}% · Wind ${weather.today.wind} mph`);
            }
            if (weather.tomorrow) {
                lines.push(`Tomorrow: High ${weather.tomorrow.high}°F (±${weather.tomorrow.high_ci}°) / Low ${weather.tomorrow.low}°F (±${weather.tomorrow.low_ci}°)`);
            }
            if (weather.week?.length > 2) {
                lines.push('7-Day Outlook:');
                for (const d of weather.week) {
                    const dayName = new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
                    lines.push(`  ${dayName}: ${d.high}°F / ${d.low}°F (±${d.high_ci}°)`);
                }
            }
            if (weather.model_rmse) {
                lines.push(`ML model accuracy: ±${weather.model_rmse}°F RMSE (${forecast?.model?.training_days ?? '?'}-day training)`);
            }
        }

        lines.push('');
        lines.push('— Parkers Physics · parkerphysics.com');

        return lines.join('\n');
    }
}
