/**
 * home-conditions.js — per-location Earth conditions for the landing page's
 * sky console: air quality, temperature dynamics, and major-event
 * predictions (terrestrial severe weather + inbound space weather).
 *
 * DATA — Open-Meteo (keyless, CORS-enabled, already a credited source):
 *   fetchConditions(loc)  — ONE forecast request + ONE air-quality request
 *                           per location: current weather, 7-day hourly
 *                           (temp / precip-prob / CAPE), 7-day daily
 *                           (hi/lo/precip/gusts), current pollutants,
 *                           7-day hourly AQI.
 *   fetchClimate(loc)     — ONE archive request (lazy, ~3 years of daily
 *                           mean temperature + shortwave radiation) for the
 *                           solar-input-vs-temperature year arc.
 *
 * This module deliberately does NOT reuse js/air-quality-feed.js — that
 * class is the EarthView verdict card's feed with its own cadence, cache
 * and field set (no CAPE, no gusts, no pollutant breakdown, 48 h horizon).
 * The two run on different pages, so nothing is fetched twice at runtime.
 *
 * MODELS — buildAirModel / buildEventsModel / buildTempModel are PURE
 * (no DOM, no fetch, no ambient time) and node-gated by
 * tests/home-conditions.mjs. Space-weather inputs to buildEventsModel come
 * from the page's single SpaceWeatherFeed state — no second feed, and the
 * NOAA scale mapping stays in js/home-sky-console.js (imported here), not
 * re-derived.
 *
 * tzGuessLocation() gives a privacy-friendly default place (major city
 * matching the browser's IANA timezone — no geolocation prompt, no IP
 * lookup) so the console shows *something local-ish* on first visit. It is
 * always labeled approximate in the UI; a real location replaces it via
 * js/user-location.js.
 */

import { gFromKp } from './home-sky-console.js';

const isNum = (v) => Number.isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ─────────────────────────────────────────────────────────────────────────────
// Timezone → default city (approximate on purpose; ~1 city per major zone)
// ─────────────────────────────────────────────────────────────────────────────

const TZ_CITIES = {
    'America/New_York': [40.71, -74.01, 'New York'],
    'America/Detroit': [42.33, -83.05, 'Detroit'],
    'America/Toronto': [43.65, -79.38, 'Toronto'],
    'America/Chicago': [41.88, -87.63, 'Chicago'],
    'America/Winnipeg': [49.90, -97.14, 'Winnipeg'],
    'America/Denver': [39.74, -104.99, 'Denver'],
    'America/Edmonton': [53.55, -113.49, 'Edmonton'],
    'America/Phoenix': [33.45, -112.07, 'Phoenix'],
    'America/Los_Angeles': [34.05, -118.24, 'Los Angeles'],
    'America/Vancouver': [49.28, -123.12, 'Vancouver'],
    'America/Anchorage': [61.22, -149.90, 'Anchorage'],
    'Pacific/Honolulu': [21.31, -157.86, 'Honolulu'],
    'America/Halifax': [44.65, -63.57, 'Halifax'],
    'America/Mexico_City': [19.43, -99.13, 'Mexico City'],
    'America/Bogota': [4.71, -74.07, 'Bogotá'],
    'America/Lima': [-12.05, -77.04, 'Lima'],
    'America/Santiago': [-33.45, -70.67, 'Santiago'],
    'America/Sao_Paulo': [-23.55, -46.63, 'São Paulo'],
    'America/Argentina/Buenos_Aires': [-34.60, -58.38, 'Buenos Aires'],
    'Europe/London': [51.51, -0.13, 'London'],
    'Europe/Dublin': [53.35, -6.26, 'Dublin'],
    'Europe/Lisbon': [38.72, -9.14, 'Lisbon'],
    'Europe/Madrid': [40.42, -3.70, 'Madrid'],
    'Europe/Paris': [48.86, 2.35, 'Paris'],
    'Europe/Amsterdam': [52.37, 4.90, 'Amsterdam'],
    'Europe/Berlin': [52.52, 13.40, 'Berlin'],
    'Europe/Zurich': [47.38, 8.54, 'Zurich'],
    'Europe/Rome': [41.90, 12.50, 'Rome'],
    'Europe/Vienna': [48.21, 16.37, 'Vienna'],
    'Europe/Prague': [50.08, 14.44, 'Prague'],
    'Europe/Warsaw': [52.23, 21.01, 'Warsaw'],
    'Europe/Stockholm': [59.33, 18.07, 'Stockholm'],
    'Europe/Oslo': [59.91, 10.75, 'Oslo'],
    'Europe/Helsinki': [60.17, 24.94, 'Helsinki'],
    'Europe/Athens': [37.98, 23.73, 'Athens'],
    'Europe/Istanbul': [41.01, 28.98, 'Istanbul'],
    'Europe/Kyiv': [50.45, 30.52, 'Kyiv'],
    'Europe/Moscow': [55.76, 37.62, 'Moscow'],
    'Africa/Cairo': [30.04, 31.24, 'Cairo'],
    'Africa/Lagos': [6.52, 3.38, 'Lagos'],
    'Africa/Nairobi': [-1.29, 36.82, 'Nairobi'],
    'Africa/Johannesburg': [-26.20, 28.05, 'Johannesburg'],
    'Asia/Jerusalem': [31.77, 35.21, 'Jerusalem'],
    'Asia/Dubai': [25.20, 55.27, 'Dubai'],
    'Asia/Karachi': [24.86, 67.01, 'Karachi'],
    'Asia/Kolkata': [28.61, 77.21, 'New Delhi'],
    'Asia/Dhaka': [23.81, 90.41, 'Dhaka'],
    'Asia/Bangkok': [13.76, 100.50, 'Bangkok'],
    'Asia/Jakarta': [-6.21, 106.85, 'Jakarta'],
    'Asia/Singapore': [1.35, 103.82, 'Singapore'],
    'Asia/Manila': [14.60, 120.98, 'Manila'],
    'Asia/Hong_Kong': [22.32, 114.17, 'Hong Kong'],
    'Asia/Taipei': [25.03, 121.57, 'Taipei'],
    'Asia/Shanghai': [31.23, 121.47, 'Shanghai'],
    'Asia/Seoul': [37.57, 126.98, 'Seoul'],
    'Asia/Tokyo': [35.68, 139.69, 'Tokyo'],
    'Australia/Perth': [-31.95, 115.86, 'Perth'],
    'Australia/Brisbane': [-27.47, 153.03, 'Brisbane'],
    'Australia/Sydney': [-33.87, 151.21, 'Sydney'],
    'Australia/Melbourne': [-37.81, 144.96, 'Melbourne'],
    'Pacific/Auckland': [-36.85, 174.76, 'Auckland'],
};

/**
 * Default place from an IANA timezone string. Returns
 * {lat, lon, city, approx: true} or null when the zone isn't mapped.
 */
export function tzGuessLocation(tz) {
    const hit = TZ_CITIES[tz];
    if (!hit) return null;
    return { lat: hit[0], lon: hit[1], city: hit[2], approx: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch layer (browser only — models below never fetch)
// ─────────────────────────────────────────────────────────────────────────────

async function jget(url, ms = 10000) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
        const r = await fetch(url, { signal: c.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
    } finally { clearTimeout(t); }
}

/**
 * Fetch current + 7-day conditions for a location. Either half may fail
 * independently — the return is {wx, aq} with null for a failed half.
 */
export async function fetchConditions(loc) {
    const base = `latitude=${loc.lat}&longitude=${loc.lon}&timezone=auto`;
    const [wxR, aqR] = await Promise.allSettled([
        jget(`https://api.open-meteo.com/v1/forecast?${base}`
            + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch'
            + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,weather_code,pressure_msl,cloud_cover,precipitation,uv_index,is_day'
            + '&hourly=temperature_2m,precipitation_probability,cape'
            + '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_gusts_10m_max,weather_code,sunrise,sunset,uv_index_max'
            + '&forecast_days=7'),
        jget(`https://air-quality-api.open-meteo.com/v1/air-quality?${base}`
            + '&current=us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide&hourly=us_aqi&forecast_days=7'),
    ]);
    return {
        wx: wxR.status === 'fulfilled' ? normalizeWeather(wxR.value) : null,
        aq: aqR.status === 'fulfilled' ? normalizeAir(aqR.value) : null,
    };
}

/** ~3 years of daily mean temp + shortwave radiation for the year arc. */
export async function fetchClimate(loc) {
    const end = new Date(Date.now() - 2 * 86400e3);
    const start = new Date(end.getTime() - 3 * 365 * 86400e3);
    const iso = (d) => d.toISOString().slice(0, 10);
    const j = await jget(
        `https://archive-api.open-meteo.com/v1/archive?latitude=${loc.lat}&longitude=${loc.lon}`
        + `&temperature_unit=fahrenheit&start_date=${iso(start)}&end_date=${iso(end)}`
        + '&daily=temperature_2m_mean,shortwave_radiation_sum', 25000);
    const D = j?.daily;
    if (!D?.time) return null;
    const pts = D.time.map((t, i) => ({
        t: Date.parse(`${t}T12:00`),
        tempF: D.temperature_2m_mean?.[i],
        radMJ: D.shortwave_radiation_sum?.[i],
    })).filter((p) => isNum(p.t) && isNum(p.tempF) && isNum(p.radMJ));
    return pts.length > 300 ? { pts } : null;
}

export function normalizeWeather(j) {
    if (!j?.current) return null;
    const C = j.current;
    const wx = {
        tz: j.timezone ?? null,
        current: {
            tempF: C.temperature_2m, feelsF: C.apparent_temperature,
            rh: C.relative_humidity_2m, windMph: C.wind_speed_10m,
            gustMph: C.wind_gusts_10m, code: C.weather_code,
            pressure: C.pressure_msl, cloud: C.cloud_cover,
            precip: C.precipitation, uv: C.uv_index, isDay: !!C.is_day,
        },
        hourly: [], daily: [],
    };
    const H = j.hourly;
    if (H?.time) {
        wx.hourly = H.time.map((t, i) => ({
            t: Date.parse(t),
            tempF: H.temperature_2m?.[i],
            pp: H.precipitation_probability?.[i] ?? 0,
            cape: H.cape?.[i] ?? 0,
        })).filter((p) => isNum(p.t) && isNum(p.tempF));
    }
    const D = j.daily;
    if (D?.time) {
        wx.daily = D.time.map((t, i) => ({
            t: Date.parse(`${t}T12:00`),
            hiF: D.temperature_2m_max?.[i], loF: D.temperature_2m_min?.[i],
            precipIn: D.precipitation_sum?.[i] ?? 0,
            gustMph: D.wind_gusts_10m_max?.[i] ?? null,
            code: D.weather_code?.[i] ?? null,
            sunrise: D.sunrise?.[i] ? Date.parse(D.sunrise[i]) : null,
            sunset: D.sunset?.[i] ? Date.parse(D.sunset[i]) : null,
            uvMax: D.uv_index_max?.[i] ?? null,
        })).filter((p) => isNum(p.t) && isNum(p.hiF));
    }
    return wx;
}

export function normalizeAir(j) {
    if (!j?.current) return null;
    const C = j.current;
    const aq = {
        current: {
            aqi: isNum(C.us_aqi) ? Math.round(C.us_aqi) : null,
            pm25: C.pm2_5 ?? null, pm10: C.pm10 ?? null,
            o3: C.ozone ?? null, no2: C.nitrogen_dioxide ?? null,
        },
        hourly: [],
    };
    const H = j.hourly;
    if (H?.time && H.us_aqi) {
        aq.hourly = H.time.map((t, i) => ({ t: Date.parse(t), aqi: H.us_aqi[i] }))
            .filter((p) => isNum(p.t) && isNum(p.aqi));
    }
    return aq;
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE MODELS
// ─────────────────────────────────────────────────────────────────────────────

/** US EPA AQI categories with the console's status colors. */
export function aqiCat(aqi) {
    if (!isNum(aqi)) return { label: '—', color: '#9d92c8', level: 0 };
    if (aqi <= 50) return { label: 'Good', color: '#2eff9e', level: 0 };
    if (aqi <= 100) return { label: 'Moderate', color: '#ffd23f', level: 1 };
    if (aqi <= 150) return { label: 'Unhealthy for sensitive groups', color: '#ff8c5a', level: 2 };
    if (aqi <= 200) return { label: 'Unhealthy', color: '#ff3050', level: 3 };
    if (aqi <= 300) return { label: 'Very unhealthy', color: '#ff3050', level: 3 };
    return { label: 'Hazardous', color: '#b48cff', level: 3 };
}

/**
 * Air-quality view model. `aq`/`wx` are the normalized shapes above (either
 * may be null). Factors are signed −1…+1 (+ pushes AQI up) — illustrative
 * physics in the spirit of the prototype, disclosed as such in the UI.
 */
export function buildAirModel(aq, wx, now = Date.now()) {
    const aqi = aq?.current?.aqi ?? null;
    const cat = aqiCat(aqi);

    const pollutants = [];
    if (aq?.current) {
        const p = aq.current;
        if (isNum(p.pm25)) pollutants.push({ name: 'PM2.5 — fine particles', value: p.pm25, unit: 'µg/m³', norm: clamp(p.pm25 / 35, 0, 1) });
        if (isNum(p.pm10)) pollutants.push({ name: 'PM10 — coarse dust', value: p.pm10, unit: 'µg/m³', norm: clamp(p.pm10 / 150, 0, 1) });
        if (isNum(p.o3)) pollutants.push({ name: 'Ozone', value: p.o3, unit: 'µg/m³', norm: clamp(p.o3 / 180, 0, 1) });
        if (isNum(p.no2)) pollutants.push({ name: 'NO₂ — traffic', value: p.no2, unit: 'µg/m³', norm: clamp(p.no2 / 100, 0, 1) });
    }

    let factors = [];
    if (wx?.current) {
        const C = wx.current;
        const wind = C.windMph ?? 0, uv = C.uv ?? 0, rh = C.rh ?? 50;
        const tF = C.tempF ?? 60, pres = C.pressure ?? 1013, precip = C.precip ?? 0;
        factors = [
            ['Wind dispersal', -clamp(wind / 28, 0, 1), `${Math.round(wind)} mph`],
            ['Stagnation', clamp((6 - wind) / 6, 0, 1) * clamp((pres - 1014) / 12, 0, 1), `${Math.round(pres)} hPa`],
            ['Ozone forcing', clamp(uv / 10, 0, 1) * clamp((tF - 60) / 40, 0, 1), `UV ${Math.round(uv * 10) / 10}`],
            ['Rain washout', -clamp(precip / 0.1, 0, 1) * 0.8, precip > 0 ? 'raining now' : 'dry'],
            ['Humidity capture', clamp((rh - 70) / 30, 0, 1) * 0.6, `${Math.round(rh)}%`],
        ].map(([name, v, label]) => ({ name, v, label }));
    }
    const push = factors.reduce((s, f) => s + f.v, 0);

    // Week ahead: forecast daily AQI peaks from the hourly series.
    let week = [];
    if (aq?.hourly?.length) {
        const byDay = new Map();
        for (const p of aq.hourly) {
            if (p.t < now - 86400e3) continue;
            const d = new Date(p.t); d.setHours(12, 0, 0, 0);
            const k = d.getTime();
            if (!byDay.has(k) || p.aqi > byDay.get(k)) byDay.set(k, p.aqi);
        }
        week = [...byDay.entries()].sort((a, b) => a[0] - b[0]).slice(0, 7)
            .map(([t, v]) => ({ t, v: Math.round(v) }));
    }
    const peak = week.length ? week.reduce((a, p) => (p.v > a.v ? p : a)) : null;

    let verdict;
    if (aqi == null) verdict = { tone: 'na', text: 'Air-quality feed unavailable for this location.' };
    else if (cat.level >= 2) {
        const worst = pollutants.slice().sort((a, b) => b.norm - a.norm)[0];
        verdict = {
            tone: 'bad',
            text: `${cat.label} air right now${worst ? ` — ${worst.name.split(' — ')[0]} is the driver` : ''}. Limit hard outdoor exercise until it clears.`,
        };
    } else if (push > 0.4) {
        verdict = { tone: 'watch', text: 'The stack is loading the air — weak dispersal is letting sources accumulate. Expect AQI to drift up through the day.' };
    } else if (wx?.current?.windMph != null && wx.current.windMph >= 8) {
        verdict = { tone: 'good', text: `The atmosphere is cleaning itself — ${Math.round(wx.current.windMph)} mph of ventilation is beating every source term.` };
    } else {
        verdict = { tone: 'good', text: 'Clean and stable — nothing in the stack is loading the air right now.' };
    }
    let weekText = '';
    if (peak) {
        const day = new Date(peak.t).toLocaleDateString(undefined, { weekday: 'long' });
        weekText = peak.v > 100 ? `Week ahead: peaks at ${peak.v} (${aqiCat(peak.v).label.toLowerCase()}) on ${day} — plan outdoor time before then.`
            : `Week ahead: holding ${aqiCat(peak.v).label.toLowerCase()} — peak ${peak.v} on ${day}.`;
    }

    return { aqi, cat, uvNow: wx?.current?.uv ?? null, pollutants, factors, push, week, peak, verdict, weekText };
}

/**
 * Major-event predictions: upcoming terrestrial severe weather (from the
 * 7-day forecast) merged with inbound/ongoing space weather (from the
 * page's swpc-update state). Returns events with level ≥ 1 sorted by
 * severity then time, each carrying a when-timestamp (null = ongoing now).
 *
 * @returns {{events: Array, quiet: boolean, topLine: string}}
 */
export function buildEventsModel(swState = {}, wx = null, now = Date.now()) {
    const events = [];
    const fmtDay = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short' });
    const fmtWhen = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric' });

    // ── Space weather ──────────────────────────────────────────────────────
    if (swState.earth_directed_cme) {
        const eta = isNum(swState.cme_eta_hours) ? swState.cme_eta_hours : null;
        const when = eta != null ? now + eta * 3600e3 : null;
        events.push({
            id: 'cme', kind: 'space', name: 'CME impact', level: 2,
            when, magnitude: 'geomagnetic storm potential',
            note: `An Earth-directed CME is in transit${when ? ` — modeled arrival ${fmtWhen(when)}` : ''}. `
                + 'How hard it hits depends on the Bz it carries; the Compounding Watch tracks the forecast.',
        });
    }
    {
        // Strongest predicted Kp in the next 72 h, with its timing.
        let best = null;
        for (const e of swState.kp_forecast ?? []) {
            if (!e || e.kind === 'observed' || !isNum(e.kp)) continue;
            const t = e.time instanceof Date ? e.time.getTime() : Date.parse(e.time);
            if (!isNum(t) || t < now - 3600e3 || t > now + 72 * 3600e3) continue;
            if (!best || e.kp > best.kp) best = { kp: e.kp, t };
        }
        if (best && best.kp >= 5) {
            const g = gFromKp(best.kp);
            events.push({
                id: 'gstorm', kind: 'space', name: `G${g} geomagnetic storm`, level: Math.min(g, 3),
                when: best.t, magnitude: `Kp ${Math.round(best.kp * 10) / 10} forecast`,
                note: `NOAA's outlook peaks at Kp ${Math.round(best.kp * 10) / 10} around ${fmtWhen(best.t)} — `
                    + 'aurora pushes equatorward; GPS and HF degrade at the peak.',
            });
        }
    }
    if ((swState.sep_storm_level ?? 0) >= 1) {
        events.push({
            id: 'sep', kind: 'space', name: 'Solar radiation storm', level: Math.min(swState.sep_storm_level, 3),
            when: null, magnitude: `S${swState.sep_storm_level} in progress`,
            note: 'Energetic protons are arriving now — polar flights, EVA and satellite electronics are exposed.',
        });
    }

    // ── Terrestrial (7-day forecast) ───────────────────────────────────────
    if (wx?.hourly?.length) {
        let best = null;
        for (const h of wx.hourly) {
            if (h.t < now || h.t > now + 48 * 3600e3 || !isNum(h.cape)) continue;
            if (!best || h.cape > best.cape) best = h;
        }
        if (best && best.cape >= 800) {
            const level = best.cape >= 2500 ? 3 : best.cape >= 1500 ? 2 : 1;
            events.push({
                id: 'tstorm', kind: 'weather', name: 'Thunderstorm potential', level,
                when: best.t, magnitude: `CAPE ${Math.round(best.cape)} J/kg`,
                note: `${level >= 2 ? 'Serious storm fuel' : 'Storm fuel'} builds toward ${fmtWhen(best.t)}`
                    + `${best.pp >= 30 ? ` with ${Math.round(best.pp)}% precipitation odds` : ''} — watch for warnings.`,
            });
        }
    }
    if (wx?.daily?.length) {
        const days = wx.daily.filter((d) => d.t > now - 12 * 3600e3);
        const rain = days.slice().sort((a, b) => b.precipIn - a.precipIn)[0];
        if (rain && rain.precipIn >= 1) {
            const level = rain.precipIn >= 4 ? 3 : rain.precipIn >= 2 ? 2 : 1;
            events.push({
                id: 'rain', kind: 'weather', name: 'Heavy precipitation', level,
                when: rain.t, magnitude: `${Math.round(rain.precipIn * 10) / 10} in / day`,
                note: `${fmtDay(rain.t)} carries ${Math.round(rain.precipIn * 10) / 10} in of precipitation`
                    + `${level >= 2 ? ' — saturation and flood risk' : ''}.`,
            });
        }
        const windy = days.filter((d) => isNum(d.gustMph)).sort((a, b) => b.gustMph - a.gustMph)[0];
        if (windy && windy.gustMph >= 30) {
            const level = windy.gustMph >= 58 ? 3 : windy.gustMph >= 45 ? 2 : 1;
            events.push({
                id: 'wind', kind: 'weather', name: 'Wind event', level,
                when: windy.t, magnitude: `gusts to ${Math.round(windy.gustMph)} mph`,
                note: `Gusts reach ${Math.round(windy.gustMph)} mph on ${fmtDay(windy.t)}`
                    + `${level >= 3 ? ' — damaging-wind territory' : ''}.`,
            });
        }
        const hot = days.slice().sort((a, b) => b.hiF - a.hiF)[0];
        if (hot && hot.hiF >= 95) {
            const level = hot.hiF >= 105 ? 3 : hot.hiF >= 100 ? 2 : 1;
            events.push({
                id: 'heat', kind: 'weather', name: 'Heat spike', level,
                when: hot.t, magnitude: `${Math.round(hot.hiF)}°F high`,
                note: `${fmtDay(hot.t)} peaks at ${Math.round(hot.hiF)}°F — hydration and load-shifting weather.`,
            });
        }
        const cold = days.filter((d) => isNum(d.loF)).sort((a, b) => a.loF - b.loF)[0];
        if (cold && cold.loF <= 10) {
            const level = cold.loF <= -15 ? 3 : cold.loF <= 0 ? 2 : 1;
            events.push({
                id: 'cold', kind: 'weather', name: 'Hard freeze', level,
                when: cold.t, magnitude: `${Math.round(cold.loF)}°F low`,
                note: `${fmtDay(cold.t)} bottoms at ${Math.round(cold.loF)}°F — pipes, batteries and pets weather.`,
            });
        }
    }

    events.sort((a, b) => (b.level - a.level) || ((a.when ?? 0) - (b.when ?? 0)));
    const top = events[0] ?? null;
    const topLine = !top ? 'No major events on the board — the next 7 days look quiet.'
        : top.when == null ? `${top.name} — in progress`
            : `Next: ${top.name.toLowerCase()} ${fmtWhen(top.when)}`;
    return { events, quiet: !events.length, topLine };
}

/**
 * Temperature-dynamics view model: now / today, 24 h sparkline data, 7-day
 * hi-lo band, and (when the archive is loaded) the solar-input vs
 * temperature year arc with the thermal-lag annotation — the planet's
 * thermal memory, per the prototype.
 */
export function buildTempModel(wx, climate = null, now = Date.now()) {
    if (!wx?.current) return { available: false };
    const today = wx.daily?.[0] ?? null;
    const spark = (wx.hourly ?? []).filter((h) => h.t >= now - 3600e3).slice(0, 25);
    const week = (wx.daily ?? []).slice(0, 7);

    let arc = null;
    if (climate?.pts?.length > 300) {
        const pts = climate.pts;
        // 7-day smooth, then normalize each channel to its own 0–1 range.
        const sm = (arr, k) => arr.map((_, i) => {
            let s = 0, n = 0;
            for (let j = Math.max(0, i - k); j <= Math.min(arr.length - 1, i + k); j++) { s += arr[j]; n++; }
            return s / n;
        });
        const tS = sm(pts.map((p) => p.tempF), 3), rS = sm(pts.map((p) => p.radMJ), 3);
        const tMin = Math.min(...tS), tMax = Math.max(...tS);
        const rMin = Math.min(...rS), rMax = Math.max(...rS);
        // Mean by day-of-year across the years.
        const acc = new Map();
        pts.forEach((p, i) => {
            const d = new Date(p.t);
            const doy = Math.floor((p.t - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400e3);
            const a = acc.get(doy) ?? { n: 0, temp: 0, solar: 0, tempF: 0, radMJ: 0 };
            a.n++;
            a.temp += (tS[i] - tMin) / ((tMax - tMin) || 1);
            a.solar += (rS[i] - rMin) / ((rMax - rMin) || 1);
            a.tempF += tS[i]; a.radMJ += rS[i];
            acc.set(doy, a);
        });
        const mean = [...acc.entries()].sort((a, b) => a[0] - b[0])
            .map(([doy, a]) => ({ doy, temp: a.temp / a.n, solar: a.solar / a.n, tempF: a.tempF / a.n, radMJ: a.radMJ / a.n }));
        if (mean.length > 200) {
            const sPeak = mean.reduce((a, p) => (p.solar > a.solar ? p : a));
            const tPeak = mean.reduce((a, p) => (p.temp > a.temp ? p : a));
            const lagDays = ((tPeak.doy - sPeak.doy) + 365) % 365;
            arc = {
                mean, sPeakDoy: sPeak.doy, tPeakDoy: tPeak.doy,
                lagDays: lagDays > 0 && lagDays < 150 ? lagDays : null,
                years: [new Date(pts[0].t).getFullYear(), new Date(pts[pts.length - 1].t).getFullYear()],
            };
        }
    }

    return {
        available: true,
        tempF: wx.current.tempF, feelsF: wx.current.feelsF,
        rh: wx.current.rh, windMph: wx.current.windMph,
        code: wx.current.code, isDay: wx.current.isDay,
        hiF: today?.hiF ?? null, loF: today?.loF ?? null,
        spark, week, arc,
    };
}
