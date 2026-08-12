/**
 * air-quality-feed.js — per-location Open-Meteo snapshot for the EarthView
 * verdict card: US AQI plus pollutant/aerosol fields (recent + forecast), UV
 * (now + today's peak), hourly temperature / precip-probability / cloud cover
 * / UV, and a 7-day daily outlook. Keyless, CORS-enabled, same upstream family
 * the page's global weather grid already uses.
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
 *
 * TEMPORAL PROVENANCE — read before rendering any of these numbers:
 *   - `aqi` is Open-Meteo's composite `us_aqi`, which EPA defines on a
 *     24-HOUR RUNNING MEAN of PM (8 h for O₃/CO). The `pollutants` beside it
 *     are INSTANTANEOUS values for one model hour. They are different time
 *     bases and will not reconcile against the EPA table by hand; anything
 *     showing them together must say so.
 *   - `aqiValidAt` / `pollutantsValidAt` are the model hours actually used.
 *     They can differ (see the note in normalizeAirQuality) — `aligned` says
 *     whether they did.
 *   - `stale` is set once either is AQI_STALE_AFTER_MS behind. Values older
 *     than AQI_MAX_AGE_MS are dropped, not served as current.
 */

import { CAMS_PROVENANCE } from './air-quality-frame.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const REFRESH_MS = 15 * 60 * 1000;
const HOUR_MS = 3_600_000;

/**
 * Staleness bounds for the "newest usable past hour" fallbacks below.
 *
 * These used to be UNBOUNDED: if the current model hour was missing, the
 * search walked back through the whole `past_days=1` window and could return
 * a value up to ~30 h old, which the card then labelled "current model hour".
 * Nothing in the returned state said how old it was, so neither the UI nor a
 * consumer could tell.
 *
 * STALE_AFTER_MS is one CAMS native cycle (CAMS_PROVENANCE.nativeCadenceHours
 * = 3): past that, the value is still worth showing but must be disclosed as
 * aged. MAX_AGE_MS is the refusal point — beyond it the number is not "air
 * quality now" under any reading, so it is dropped rather than dressed up.
 */
export const AQI_STALE_AFTER_MS = 3 * HOUR_MS;
export const AQI_MAX_AGE_MS = 12 * HOUR_MS;

const HOURLY_VARS = 'temperature_2m,precipitation_probability,cloud_cover,uv_index';
const DAILY_VARS = 'temperature_2m_max,temperature_2m_min,weather_code,cloud_cover_mean,precipitation_probability_max';
const AIR_HOURLY_VARS = [
    'us_aqi',
    'pm2_5',
    'pm10',
    'ozone',
    'nitrogen_dioxide',
    'sulphur_dioxide',
    'carbon_monoxide',
    'aerosol_optical_depth',
    'dust',
].join(',');

// Stable app-facing names. Keep upstream spelling and units at this boundary
// so consumers never need to understand Open-Meteo's field grammar.
const POLLUTANT_FIELDS = Object.freeze({
    pm25: 'pm2_5',
    pm10: 'pm10',
    ozone: 'ozone',
    nitrogenDioxide: 'nitrogen_dioxide',
    sulphurDioxide: 'sulphur_dioxide',
    carbonMonoxide: 'carbon_monoxide',
    aerosolOpticalDepth: 'aerosol_optical_depth',
    dust: 'dust',
});

// Backward-compatible name used by the verdict card. The numeric map layer
// imports the same object, so point and grid consumers cannot drift on whether
// CAMS is modeled or ground-observed data.
export const AIR_QUALITY_SOURCE = CAMS_PROVENANCE;

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
            aqiHourly: [],           // [{time(ms), aqi}] — compatibility view for chip graph
            pollutants: emptyPollutants(),
            pollutionHourly: [],     // 24 h recent + 72 h forecast; AQI + pollutant fields
            pollutionUnits: {},      // app-facing field name → upstream unit
            airSource: AIR_QUALITY_SOURCE,
            aqiValidAt: null,        // ms — the model hour the AQI came from
            aqiAgeMs: null,          // ms behind now
            pollutantsValidAt: null, // ms — may differ from aqiValidAt
            pollutantsAgeMs: null,
            stale: false,            // either exceeds AQI_STALE_AFTER_MS
            aligned: null,           // AQI and pollutants share an hour?
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
        // `past_days=1` supplies a small aligned comparison window without a
        // second archive request. These are CAMS model fields, not station
        // observations; airSource preserves that distinction for every
        // downstream consumer and future training export.
        const aqUrl = `${AIR_URL}?${common}&hourly=${AIR_HOURLY_VARS}`
            + `&past_days=1&forecast_days=3`;

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
            const normalized = normalizeAirQuality(aqRes.value, nowMs);
            next.aqi = normalized.aqi;
            next.aqiHourly = normalized.aqiHourly;
            next.pollutants = normalized.pollutants;
            next.pollutionHourly = normalized.pollutionHourly;
            next.pollutionUnits = normalized.pollutionUnits;
            next.airSource = AIR_QUALITY_SOURCE;
            next.aqiValidAt = normalized.aqiValidAt;
            next.aqiAgeMs = normalized.aqiAgeMs;
            next.pollutantsValidAt = normalized.pollutantsValidAt;
            next.pollutantsAgeMs = normalized.pollutantsAgeMs;
            next.stale = normalized.stale;
            next.aligned = normalized.aligned;
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

/**
 * Normalize one Open-Meteo/CAMS response into the feed's stable schema.
 * Exported for a small contract test; it is deliberately pure so later
 * AirNow/OpenAQ station adapters can be tested against the same field names.
 */
export function normalizeAirQuality(payload = {}, nowMs = Date.now()) {
    const aq = payload.hourly || {};
    const times = Array.isArray(aq.time) ? aq.time : [];
    const units = payload.hourly_units || {};

    // Current model hour; if the upstream run lags, use the newest available
    // hour at or before now. Never substitute a future forecast for "now",
    // and never reach further back than AQI_MAX_AGE_MS — see the constant.
    const usable = (i) => {
        const t = times[i] * 1000;
        return t <= nowMs && nowMs - t <= AQI_MAX_AGE_MS;
    };
    let currentIdx = -1;
    for (let i = 0; i < times.length; i++) {
        const t = times[i] * 1000;
        if (t <= nowMs && nowMs - t < HOUR_MS && hasAirValue(aq, i)) {
            currentIdx = i;
            break;
        }
    }
    if (currentIdx < 0) {
        for (let i = times.length - 1; i >= 0; i--) {
            if (usable(i) && hasAirValue(aq, i)) {
                currentIdx = i;
                break;
            }
        }
    }

    // Preserve the feed's pre-pollution behavior when the composite AQI is
    // published later than the component concentrations: the chip may use
    // the newest past AQI while the pollutant grid stays on one aligned
    // current model hour. Provenance remains modeled for both.
    //
    // That split is deliberate, but it means the AQI and the pollutant grid
    // rendered beside it can be from DIFFERENT hours. Both valid times ride
    // the result now, plus `aligned`, so a consumer showing them together can
    // say so instead of implying one consistent snapshot.
    let aqiIdx = currentIdx >= 0 && Number.isFinite(aq.us_aqi?.[currentIdx])
        ? currentIdx : -1;
    if (aqiIdx < 0) {
        for (let i = times.length - 1; i >= 0; i--) {
            if (usable(i) && Number.isFinite(aq.us_aqi?.[i])) {
                aqiIdx = i;
                break;
            }
        }
    }

    const rowAt = (i) => {
        const row = { time: times[i] * 1000, aqi: numOrNull(aq.us_aqi?.[i]) };
        for (const [appName, upstreamName] of Object.entries(POLLUTANT_FIELDS)) {
            row[appName] = numOrNull(aq[upstreamName]?.[i]);
        }
        return row;
    };
    const pollutionHourly = times
        .map((_, i) => rowAt(i))
        .filter(row => row.aqi != null || Object.keys(POLLUTANT_FIELDS).some(k => row[k] != null));
    const current = currentIdx >= 0 ? rowAt(currentIdx) : null;
    const pollutants = emptyPollutants();
    for (const appName of Object.keys(POLLUTANT_FIELDS)) {
        pollutants[appName] = current?.[appName] ?? null;
    }
    const pollutionUnits = {};
    for (const [appName, upstreamName] of Object.entries(POLLUTANT_FIELDS)) {
        pollutionUnits[appName] = units[upstreamName] || defaultUnit(appName);
    }

    const aqiValidAt = aqiIdx >= 0 ? times[aqiIdx] * 1000 : null;
    const pollutantsValidAt = currentIdx >= 0 ? times[currentIdx] * 1000 : null;
    const ageOf = (t) => (t == null ? null : Math.max(0, nowMs - t));
    const aqiAgeMs = ageOf(aqiValidAt);
    const pollutantsAgeMs = ageOf(pollutantsValidAt);

    return {
        aqi: aqiIdx >= 0 ? numOrNull(aq.us_aqi?.[aqiIdx]) : null,
        aqiHourly: pollutionHourly
            .filter(row => row.aqi != null)
            .map(row => ({ time: row.time, aqi: row.aqi })),
        pollutants,
        pollutionHourly,
        pollutionUnits,
        // Temporal provenance. Without these the card could render a value
        // hours old under a "current model hour" label with nothing to
        // contradict it — see AQI_STALE_AFTER_MS.
        aqiValidAt,
        aqiAgeMs,
        pollutantsValidAt,
        pollutantsAgeMs,
        stale: [aqiAgeMs, pollutantsAgeMs]
            .some(age => age != null && age >= AQI_STALE_AFTER_MS),
        aligned: aqiIdx >= 0 && currentIdx >= 0 ? aqiIdx === currentIdx : null,
    };
}

function hasAirValue(aq, i) {
    if (Number.isFinite(aq.us_aqi?.[i])) return true;
    return Object.values(POLLUTANT_FIELDS).some(name => Number.isFinite(aq[name]?.[i]));
}

function emptyPollutants() {
    return Object.fromEntries(Object.keys(POLLUTANT_FIELDS).map(name => [name, null]));
}

function defaultUnit(name) {
    return name === 'aerosolOpticalDepth' ? '' : 'µg/m³';
}

function numOrNull(v) {
    return Number.isFinite(v) ? v : null;
}

export default AirQualityFeed;
