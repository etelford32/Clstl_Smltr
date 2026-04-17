/**
 * trip-planner.js — Two-location trip comparison utilities.
 *
 * Pure module. No DOM. Used by the dashboard "Trip Planning" card and
 * the Earth globe's trip-route overlay.
 *
 * Covers:
 *   1. Great-circle math    — distance, bearing, and waypoint sampling
 *                             so the Earth page can draw a route arc and
 *                             the dashboard can pull weather along it.
 *   2. Weather fetching     — Open-Meteo point forecasts (free, no key)
 *                             for both endpoints and optional route samples.
 *   3. URL param encoding   — round-trip of a trip spec through a URL for
 *                             sharing / deep-linking between pages.
 */

const EARTH_R_KM     = 6371.0;
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

// ── Great-circle math ───────────────────────────────────────────────────────

const DEG = Math.PI / 180;

function _toRad(p) {
    return { lat: p.lat * DEG, lon: p.lon * DEG };
}

/** Great-circle distance in km between two {lat, lon} points (haversine). */
export function greatCircleDistanceKm(a, b) {
    const ra = _toRad(a), rb = _toRad(b);
    const dLat = rb.lat - ra.lat;
    const dLon = rb.lon - ra.lon;
    const h = Math.sin(dLat / 2) ** 2
            + Math.cos(ra.lat) * Math.cos(rb.lat) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing (degrees, clockwise from true north) from a → b. */
export function initialBearingDeg(a, b) {
    const ra = _toRad(a), rb = _toRad(b);
    const dLon = rb.lon - ra.lon;
    const y = Math.sin(dLon) * Math.cos(rb.lat);
    const x = Math.cos(ra.lat) * Math.sin(rb.lat)
            - Math.sin(ra.lat) * Math.cos(rb.lat) * Math.cos(dLon);
    const brg = Math.atan2(y, x) / DEG;
    return (brg + 360) % 360;
}

/**
 * Sample `n` equally spaced points along the great-circle arc from a to b.
 * Returns [{ lat, lon, t }] with t ∈ [0, 1] (inclusive). n ≥ 2.
 *
 * Degenerates to a linear interpolation for near-coincident points.
 */
export function greatCirclePath(a, b, n = 64) {
    if (n < 2) n = 2;
    const ra = _toRad(a), rb = _toRad(b);
    const d = Math.acos(
        Math.min(1, Math.max(-1,
            Math.sin(ra.lat) * Math.sin(rb.lat) +
            Math.cos(ra.lat) * Math.cos(rb.lat) * Math.cos(rb.lon - ra.lon)
        ))
    );
    const out = [];
    if (d < 1e-6) {
        // Coincident endpoints — return n copies of a
        for (let i = 0; i < n; i++) out.push({ lat: a.lat, lon: a.lon, t: i / (n - 1) });
        return out;
    }
    const sinD = Math.sin(d);
    for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const A = Math.sin((1 - t) * d) / sinD;
        const B = Math.sin(t * d) / sinD;
        const x = A * Math.cos(ra.lat) * Math.cos(ra.lon) + B * Math.cos(rb.lat) * Math.cos(rb.lon);
        const y = A * Math.cos(ra.lat) * Math.sin(ra.lon) + B * Math.cos(rb.lat) * Math.sin(rb.lon);
        const z = A * Math.sin(ra.lat) + B * Math.sin(rb.lat);
        const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / DEG;
        const lon = Math.atan2(y, x) / DEG;
        out.push({ lat, lon, t });
    }
    return out;
}

// ── Weather fetching ────────────────────────────────────────────────────────

/**
 * Fetch a rich point forecast for one lat/lon from Open-Meteo.
 * Returns null on network / parse failure.
 */
export async function fetchPointForecast(lat, lon) {
    const params = new URLSearchParams({
        latitude:  (+lat).toFixed(4),
        longitude: (+lon).toFixed(4),
        current:   [
            'temperature_2m', 'apparent_temperature',
            'relative_humidity_2m', 'cloud_cover', 'is_day', 'weather_code',
            'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
            'precipitation', 'pressure_msl',
        ].join(','),
        daily: [
            'temperature_2m_max', 'temperature_2m_min',
            'precipitation_sum', 'precipitation_probability_max',
            'sunrise', 'sunset', 'uv_index_max',
        ].join(','),
        temperature_unit: 'fahrenheit',
        wind_speed_unit:  'mph',
        timezone:         'auto',
        forecast_days:    '3',
    });
    try {
        const res = await fetch(`${OPEN_METEO_URL}?${params}`, { signal: AbortSignal.timeout(12000) });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.error) return null;
        return {
            lat, lon,
            timezone:         data.timezone,
            utc_offset_s:     data.utc_offset_seconds,
            temp_f:           data.current?.temperature_2m,
            feels_f:          data.current?.apparent_temperature,
            humidity:         data.current?.relative_humidity_2m,
            cloud_cover:      data.current?.cloud_cover,
            is_day:           data.current?.is_day,
            weather_code:     data.current?.weather_code,
            wind_mph:         data.current?.wind_speed_10m,
            wind_gust_mph:    data.current?.wind_gusts_10m,
            wind_dir_deg:     data.current?.wind_direction_10m,
            precip_in:        data.current?.precipitation,
            pressure_hpa:     data.current?.pressure_msl,
            daily: {
                dates:            data.daily?.time ?? [],
                high_f:           data.daily?.temperature_2m_max ?? [],
                low_f:            data.daily?.temperature_2m_min ?? [],
                precip_sum_in:    data.daily?.precipitation_sum ?? [],
                precip_prob_pct:  data.daily?.precipitation_probability_max ?? [],
                sunrise:          data.daily?.sunrise ?? [],
                sunset:           data.daily?.sunset ?? [],
                uv_index_max:     data.daily?.uv_index_max ?? [],
            },
            fetched_at: Date.now(),
        };
    } catch (e) {
        console.warn('[TripPlanner] fetch failed:', e.message);
        return null;
    }
}

/**
 * Pull weather for both endpoints plus N interior route waypoints.
 * @param {{lat:number,lon:number,label?:string,city?:string}} a
 * @param {{lat:number,lon:number,label?:string,city?:string}} b
 * @param {number} routeSamples — interior waypoint count (excludes endpoints)
 * @returns {Promise<{ from, to, route, distance_km, bearing_deg }>}
 */
export async function fetchTripWeather(a, b, { routeSamples = 0 } = {}) {
    const [ wa, wb ] = await Promise.all([
        fetchPointForecast(a.lat, a.lon),
        fetchPointForecast(b.lat, b.lon),
    ]);

    let route = [];
    if (routeSamples > 0) {
        // Sample at t = 1/(N+1), 2/(N+1), ..., N/(N+1)
        const path = greatCirclePath(a, b, routeSamples + 2).slice(1, -1);
        route = await Promise.all(path.map(p => fetchPointForecast(p.lat, p.lon)));
    }

    return {
        from:        { location: a, weather: wa },
        to:          { location: b, weather: wb },
        route,
        distance_km: greatCircleDistanceKm(a, b),
        bearing_deg: initialBearingDeg(a, b),
    };
}

// ── URL param round-trip ────────────────────────────────────────────────────

/** Encode two trip endpoints into a compact URL parameter string. */
export function encodeTripParam(a, b) {
    const part = p => [
        p.lat.toFixed(4),
        p.lon.toFixed(4),
        encodeURIComponent((p.label ?? p.city ?? '').slice(0, 40)),
    ].join(',');
    return `${part(a)};${part(b)}`;
}

/** Parse `?trip=lat,lon,label;lat,lon,label` → { from, to } or null. */
export function parseTripParam(raw) {
    if (!raw) return null;
    const [p1, p2] = String(raw).split(';');
    if (!p1 || !p2) return null;
    const read = (s) => {
        const parts = s.split(',');
        const lat = parseFloat(parts[0]);
        const lon = parseFloat(parts[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        const label = decodeURIComponent(parts.slice(2).join(',') || '');
        return { lat, lon, label, city: label };
    };
    const from = read(p1);
    const to   = read(p2);
    if (!from || !to) return null;
    return { from, to };
}

// ── Convenience formatters (used by the dashboard card) ────────────────────

const WMO_CODES = {
    0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Freezing fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    56: 'Freezing drizzle', 57: 'Freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
    66: 'Freezing rain', 67: 'Freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Rain showers', 81: 'Rain showers', 82: 'Heavy rain showers',
    85: 'Snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Severe thunderstorm',
};

export function weatherCodeLabel(code) {
    return WMO_CODES[code] ?? 'Unknown';
}

/** Compass label for a wind direction in degrees (0 = from N). */
export function compassLabel(deg) {
    if (deg == null || !Number.isFinite(deg)) return '—';
    const names = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return names[Math.round(((deg % 360) / 22.5)) % 16];
}

/** Format a local-time ISO string into HH:MM short form. */
export function localTimeShort(iso, utcOffsetS) {
    if (!iso) return '—';
    const d = new Date(iso);
    // Open-Meteo already returns local time when timezone=auto, so just slice
    return d.toISOString().slice(11, 16);
}
