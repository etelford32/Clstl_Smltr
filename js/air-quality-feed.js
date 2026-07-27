/**
 * air-quality-feed.js — per-location Open-Meteo snapshot for the EarthView
 * verdict card: US AQI (now + the hourly series), UV (now + today's peak),
 * hourly temperature / precip-probability / cloud cover / UV for the next
 * ~48 h, and a 7-day daily outlook. Keyless, CORS-enabled, same upstream
 * family the page's global weather grid already uses.
 *
 * Why this module fetches weather at all (not just AQI/UV): the page's
 * existing WeatherFeed / WeatherForecastFeed singletons operate on a global
 * 72×36 (5°) grid for the globe shaders — ~350 mi cells, no per-location
 * hourly series, and no UV/AQI channels. The verdict card needs point
 * accuracy ("90° now"), and Open-Meteo returns all of it in ONE request per
 * location, so extending this feed costs zero extra round-trips vs. a pure
 * AQI fetch. It does NOT duplicate any fetch the page already performs.
 *
 * Events (window):
 *   'ev-air-update'  detail = state (see get state below). Fires on every
 *                    successful refresh AND on failure (status:'error',
 *                    previous data retained) so consumers can degrade chips
 *                    instead of blanking the card.
 *
 * Cache: 15 min per ~1 km location bucket. setLocation() to a new spot
 * bypasses the timer and refetches immediately.
 */

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const REFRESH_MS = 15 * 60 * 1000;
const HOUR_MS = 3_600_000;

const HOURLY_VARS = 'temperature_2m,precipitation_probability,cloud_cover,uv_index';
const DAILY_VARS = 'temperature_2m_max,temperature_2m_min,weather_code,cloud_cover_mean,precipitation_probability_max';

/** ~1 km location bucket — same-neighbourhood moves don't refetch. */
const locKey = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

export class AirQualityFeed {
    constructor() {
        this._timer = null;
        this._loc = null;            // {lat, lon}
        this._fetchedKey = null;
        this._fetchedAt = 0;
        this._inflight = null;
        this._state = {
            status: 'idle',          // idle | loading | live | error
            aqi: null,
            aqiHourly: [],           // [{time(ms), aqi}] ~48 h — chip detail graph
            uvNow: null,
            uvPeak: null,
            uvPeakHour: null,        // ms
            hourly: [],              // [{time(ms), tempF, precipProb, cloudPct, uv}]
            daily: [],               // [{date(ms), hiF, loF, code, cloudPct, precipProbMax}]
            tz: null,                // IANA tz resolved by Open-Meteo (timezone=auto)
            fetchedAt: null,
        };
    }

    get state() { return this._state; }

    /** Begin polling for a location. Safe to call again with a new loc. */
    start(loc) {
        this.setLocation(loc);
        clearInterval(this._timer);
        this._timer = setInterval(() => this._refresh(), REFRESH_MS);
        return this;
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
    }

    /** Point the feed at a (possibly new) location; refetches when it moved. */
    setLocation(loc) {
        if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return;
        this._loc = { lat: +loc.lat, lon: +loc.lon };
        this._refresh();
    }

    async _refresh() {
        const loc = this._loc;
        if (!loc) return;
        const key = locKey(loc.lat, loc.lon);
        const fresh = key === this._fetchedKey && Date.now() - this._fetchedAt < REFRESH_MS;
        if (fresh || this._inflight) return;

        this._state.status = this._state.status === 'idle' ? 'loading' : this._state.status;
        this._inflight = this._fetch(loc, key)
            .catch(err => {
                // Keep the previous snapshot; a degraded chip beats a blank card.
                console.warn('[AirQualityFeed] refresh failed:', err?.message || err);
                this._state = { ...this._state, status: 'error' };
                this._dispatch();
            })
            .finally(() => { this._inflight = null; });
        await this._inflight;
    }

    async _fetch(loc, key) {
        const common = `latitude=${loc.lat.toFixed(4)}&longitude=${loc.lon.toFixed(4)}&timezone=auto&timeformat=unixtime`;
        const wxUrl = `${FORECAST_URL}?${common}&hourly=${HOURLY_VARS}&daily=${DAILY_VARS}`
            + `&temperature_unit=fahrenheit&forecast_days=8`;
        const aqUrl = `${AIR_URL}?${common}&hourly=us_aqi&forecast_days=2`;

        // Both fetches in parallel; either may fail independently.
        const [wxRes, aqRes] = await Promise.allSettled([
            fetch(wxUrl, { signal: AbortSignal.timeout(12_000) }).then(r => r.ok ? r.json() : Promise.reject(new Error(`wx HTTP ${r.status}`))),
            fetch(aqUrl, { signal: AbortSignal.timeout(12_000) }).then(r => r.ok ? r.json() : Promise.reject(new Error(`aq HTTP ${r.status}`))),
        ]);
        if (wxRes.status === 'rejected' && aqRes.status === 'rejected') {
            throw wxRes.reason;
        }

        const next = { ...this._state };
        const nowMs = Date.now();

        if (wxRes.status === 'fulfilled') {
            const wx = wxRes.value;
            next.tz = wx.timezone || next.tz;

            const h = wx.hourly || {};
            const times = h.time || [];
            next.hourly = times.map((t, i) => ({
                time: t * 1000,
                tempF: numOrNull(h.temperature_2m?.[i]),
                precipProb: numOrNull(h.precipitation_probability?.[i]),
                cloudPct: numOrNull(h.cloud_cover?.[i]),
                uv: numOrNull(h.uv_index?.[i]),
            }));

            const d = wx.daily || {};
            next.daily = (d.time || []).map((t, i) => ({
                date: t * 1000,
                hiF: numOrNull(d.temperature_2m_max?.[i]),
                loF: numOrNull(d.temperature_2m_min?.[i]),
                code: numOrNull(d.weather_code?.[i]),
                cloudPct: numOrNull(d.cloud_cover_mean?.[i]),
                precipProbMax: numOrNull(d.precipitation_probability_max?.[i]),
            }));

            // UV now + today's peak. "Today" = the first daily bucket's local
            // day; daily[0].date is local midnight thanks to timezone=auto.
            const dayStart = next.daily[0]?.date ?? nowMs - 12 * HOUR_MS;
            const dayEnd = dayStart + 24 * HOUR_MS;
            let uvNow = null, uvPeak = null, uvPeakHour = null;
            for (const row of next.hourly) {
                if (row.uv == null) continue;
                if (row.time <= nowMs && nowMs - row.time < HOUR_MS) uvNow = row.uv;
                if (row.time >= dayStart && row.time < dayEnd && (uvPeak == null || row.uv > uvPeak)) {
                    uvPeak = row.uv;
                    uvPeakHour = row.time;
                }
            }
            next.uvNow = uvNow;
            next.uvPeak = uvPeak;
            next.uvPeakHour = uvPeakHour;
        }

        if (aqRes.status === 'fulfilled') {
            const aq = aqRes.value.hourly || {};
            const times = aq.time || [];
            let aqi = null;
            for (let i = 0; i < times.length; i++) {
                const t = times[i] * 1000;
                if (t <= nowMs && nowMs - t < HOUR_MS && Number.isFinite(aq.us_aqi?.[i])) {
                    aqi = aq.us_aqi[i];
                    break;
                }
            }
            // Fallback: newest non-null value at or before now (upstream
            // occasionally lags the current hour).
            if (aqi == null) {
                for (let i = times.length - 1; i >= 0; i--) {
                    if (times[i] * 1000 <= nowMs && Number.isFinite(aq.us_aqi?.[i])) {
                        aqi = aq.us_aqi[i];
                        break;
                    }
                }
            }
            next.aqi = aqi;
            // Keep the whole hourly series — the response already carries
            // ~48 h and the verdict card's AQI detail graph consumes it, so
            // retaining it costs zero extra network.
            next.aqiHourly = times
                .map((t, i) => ({ time: t * 1000, aqi: numOrNull(aq.us_aqi?.[i]) }))
                .filter(r => r.aqi != null);
        }

        next.status = 'live';
        next.fetchedAt = nowMs;
        this._state = next;
        this._fetchedKey = key;
        this._fetchedAt = nowMs;
        this._dispatch();
    }

    _dispatch() {
        try {
            window.dispatchEvent(new CustomEvent('ev-air-update', { detail: this._state }));
        } catch { /* consumers are optional */ }
    }
}

function numOrNull(v) {
    return Number.isFinite(v) ? v : null;
}

export default AirQualityFeed;
