/**
 * weather-forecast-engine.js — Client-side weather forecast fetcher & display helpers
 *
 * Fetches from /api/forecast/weather and provides:
 *   - Location-aware forecast (uses user-location.js)
 *   - Formatted display data for each horizon
 *   - Confidence interval visualization helpers
 *   - Auto-refresh every 10 minutes
 *   - localStorage cache (30 min TTL)
 */

const CACHE_KEY = 'pp_weather_forecast';
const CACHE_TTL = 30 * 60 * 1000; // 30 min
const REFRESH_INTERVAL = 10 * 60 * 1000; // 10 min

export class WeatherForecast {
    constructor({ onUpdate, units = 'metric' } = {}) {
        this.onUpdate = onUpdate;
        this.units = units;
        this.data = null;
        this.loading = false;
        this.error = null;
        this._timer = null;
    }

    async fetchForLocation(lat, lon) {
        if (this.loading) return this.data;
        this.loading = true;
        this.error = null;

        // Check cache
        try {
            const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
            if (cached && Date.now() - cached._ts < CACHE_TTL
                && Math.abs(cached.location.lat - lat) < 0.05
                && Math.abs(cached.location.lon - lon) < 0.05) {
                this.data = cached;
                this.loading = false;
                this.onUpdate?.(this.data);
                return this.data;
            }
        } catch (_) {}

        try {
            const res = await fetch(
                `/api/forecast/weather?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&units=${this.units}`
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this.data = await res.json();
            this.data._ts = Date.now();

            // Cache
            try { localStorage.setItem(CACHE_KEY, JSON.stringify(this.data)); } catch (_) {}

            this.onUpdate?.(this.data);
        } catch (e) {
            this.error = e.message;
        } finally {
            this.loading = false;
        }
        return this.data;
    }

    startAutoRefresh(lat, lon) {
        this.stopAutoRefresh();
        this.fetchForLocation(lat, lon);
        this._timer = setInterval(() => this.fetchForLocation(lat, lon), REFRESH_INTERVAL);
    }

    stopAutoRefresh() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    // ── Display helpers ──────────────────────────────────────────────────

    /** Get a formatted summary for one horizon. */
    static formatHorizon(forecast) {
        if (!forecast) return null;
        const temp = forecast.temperature_2m;
        const wind = forecast.wind_speed_10m;
        const precip = forecast.precipitation;

        return {
            time: forecast.time,
            hours: forecast.horizon_hours,
            confidence: forecast.confidence_pct,
            weather: forecast.weather_description,
            weatherCode: forecast.weather_code,
            temp: temp ? `${temp.mean}${temp.unit}` : '—',
            tempRange80: temp ? `${temp.lo80}–${temp.hi80}` : '—',
            tempRange95: temp ? `${temp.lo95}–${temp.hi95}` : '—',
            feelsLike: forecast.apparent_temperature?.mean != null
                ? `${forecast.apparent_temperature.mean}${forecast.apparent_temperature.unit}` : '—',
            humidity: forecast.relative_humidity_2m?.mean != null
                ? `${Math.round(forecast.relative_humidity_2m.mean)}%` : '—',
            windSpeed: wind ? `${wind.mean} ${wind.unit}` : '—',
            windDir: forecast.wind_direction_10m?.value != null
                ? WeatherForecast.degToCompass(forecast.wind_direction_10m.value) : '—',
            windGust: forecast.wind_gusts_10m?.mean != null
                ? `${forecast.wind_gusts_10m.mean} ${forecast.wind_gusts_10m.unit}` : '—',
            precipProb: forecast.precipitation_probability?.mean != null
                ? `${Math.round(forecast.precipitation_probability.mean)}%` : '—',
            precipAmount: precip ? `${precip.mean} ${precip.unit}` : '—',
            cloudCover: forecast.cloud_cover?.mean != null
                ? `${Math.round(forecast.cloud_cover.mean)}%` : '—',
            visibility: forecast.visibility?.mean != null
                ? `${(forecast.visibility.mean / 1000).toFixed(1)} km` : '—',
            uvIndex: forecast.uv_index?.mean != null
                ? forecast.uv_index.mean.toFixed(1) : '—',
            pressure: forecast.surface_pressure?.mean != null
                ? `${forecast.surface_pressure.mean.toFixed(0)} hPa` : '—',
        };
    }

    /** Compass direction from degrees. */
    static degToCompass(deg) {
        const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
        return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
    }

    /** Weather code to emoji icon. */
    static weatherIcon(code) {
        if (code == null) return '—';
        if (code === 0) return '\u2600'; // sun
        if (code <= 2) return '\u26C5'; // partly cloudy
        if (code === 3) return '\u2601'; // overcast
        if (code <= 48) return '\uD83C\uDF2B'; // fog
        if (code <= 55) return '\uD83C\uDF27'; // drizzle
        if (code <= 67) return '\uD83C\uDF27'; // rain
        if (code <= 77) return '\u2744'; // snow
        if (code <= 82) return '\uD83C\uDF26'; // rain showers
        if (code <= 86) return '\uD83C\uDF28'; // snow showers
        return '\u26A1'; // thunderstorm
    }

    /** Confidence bar color (green → yellow → red). */
    static confidenceColor(pct) {
        if (pct >= 85) return '#4eff91';
        if (pct >= 70) return '#ffd700';
        if (pct >= 55) return '#ff8c00';
        return '#ff4444';
    }
}
