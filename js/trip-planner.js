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

import * as THREE from 'three';
import { geo, RAD } from './geo/coords.js';

const OPEN_METEO_URL        = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';

// ── Great-circle math ───────────────────────────────────────────────────────
// These three exports used to carry their own haversine / bearing / SLERP
// implementations. They now delegate to js/geo/coords.js so the trip module,
// the satellite tracker, the aurora oval, and the (future) alert intersection
// tests all share one definition of "distance between two points on Earth."

/** Great-circle distance in km between two {lat, lon} (degrees) points. */
export function greatCircleDistanceKm(a, b) {
    return geo.deg.distanceKm(a, b);
}

/** Initial bearing in degrees, clockwise from true north, range [0, 360). */
export function initialBearingDeg(a, b) {
    return (geo.deg.bearing(a, b) + 360) % 360;
}

/**
 * Sample `n` equally spaced points along the great-circle arc from a to b.
 * Returns [{ lat, lon, t }] with t ∈ [0, 1] (inclusive) and lat/lon in
 * degrees. n is floored to at least 2. Coincident endpoints degenerate to
 * n copies of a.
 */
const _slerpA = new THREE.Vector3();
const _slerpB = new THREE.Vector3();
const _slerpOut = new THREE.Vector3();
export function greatCirclePath(a, b, n = 64) {
    if (n < 2) n = 2;
    geo.deg.latLonToNormal(a.lat, a.lon, _slerpA);
    geo.deg.latLonToNormal(b.lat, b.lon, _slerpB);
    const d = Math.acos(Math.min(1, Math.max(-1, _slerpA.dot(_slerpB))));
    const out = [];
    if (d < 1e-6) {
        for (let i = 0; i < n; i++) out.push({ lat: a.lat, lon: a.lon, t: i / (n - 1) });
        return out;
    }
    const sinD = Math.sin(d);
    for (let i = 0; i < n; i++) {
        const t  = i / (n - 1);
        const s0 = Math.sin((1 - t) * d) / sinD;
        const s1 = Math.sin(t * d) / sinD;
        _slerpOut.copy(_slerpA).multiplyScalar(s0).addScaledVector(_slerpB, s1);
        const ll = geo.normalToLatLon(_slerpOut);
        out.push({ lat: ll.lat * RAD, lon: ll.lon * RAD, t });
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
 * Fetch a launch-planner forecast: current + 7-day hourly + 7-day daily in
 * one Open-Meteo call, so callers can score weather at any hour within the
 * forecast horizon (T-0, T-6h, window open/close, etc.) rather than only
 * "right now." Additive; does not replace fetchPointForecast.
 *
 * The hourly arrays are parallel — all the same length, indexed by `time`.
 * Returns null on network / parse failure.
 */
export async function fetchLaunchForecast(lat, lon, { forecastDays = 7 } = {}) {
    const params = new URLSearchParams({
        latitude:  (+lat).toFixed(4),
        longitude: (+lon).toFixed(4),
        current: [
            'temperature_2m', 'apparent_temperature',
            'relative_humidity_2m', 'cloud_cover', 'is_day', 'weather_code',
            'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
            'precipitation', 'pressure_msl',
        ].join(','),
        hourly: [
            'temperature_2m',
            'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m',
            'precipitation', 'precipitation_probability',
            'cloud_cover', 'weather_code',
            'relative_humidity_2m', 'visibility',
            // Convective-instability triplet — CAPE + lifted index + CIN
            // together are what a forecaster actually reads to decide
            // "thunderstorms likely today?" CAPE alone flags "fuel present";
            // lifted index < 0 confirms the parcel will actually rise;
            // CIN is the lid that keeps it from firing. All three catch
            // developing convection hours before the WMO weather_code
            // flips to 95/96/99 — the scrub pattern Cape Canaveral sees
            // regularly.
            'cape', 'lifted_index', 'convective_inhibition',
            // Pressure-level winds for upper-level shear analysis near max-Q.
            // 200 hPa ≈ 12 km (the max-Q altitude for most orbital launch
            // vehicles); 300 hPa ≈ 9 km (below max-Q, needed to compute
            // vector shear across the high-stress band); 500 hPa ≈ 5.5 km
            // kept as a mid-layer reference for tall small launchers like
            // Electron that max-Q higher.
            'wind_speed_500hPa', 'wind_direction_500hPa',
            'wind_speed_300hPa', 'wind_direction_300hPa',
            'wind_speed_200hPa', 'wind_direction_200hPa',
        ].join(','),
        daily: [
            'temperature_2m_max', 'temperature_2m_min',
            'precipitation_sum', 'precipitation_probability_max',
            'sunrise', 'sunset', 'uv_index_max',
        ].join(','),
        temperature_unit: 'fahrenheit',
        wind_speed_unit:  'mph',
        timezone:         'auto',
        forecast_days:    String(forecastDays),
    });
    try {
        const res = await fetch(`${OPEN_METEO_URL}?${params}`, { signal: AbortSignal.timeout(12000) });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.error) return null;
        return {
            lat, lon,
            timezone:     data.timezone,
            utc_offset_s: data.utc_offset_seconds,
            current: {
                time:          data.current?.time,
                temp_f:        data.current?.temperature_2m,
                feels_f:       data.current?.apparent_temperature,
                humidity:      data.current?.relative_humidity_2m,
                cloud_cover:   data.current?.cloud_cover,
                is_day:        data.current?.is_day,
                weather_code:  data.current?.weather_code,
                wind_mph:      data.current?.wind_speed_10m,
                wind_gust_mph: data.current?.wind_gusts_10m,
                wind_dir_deg:  data.current?.wind_direction_10m,
                precip_in:     data.current?.precipitation,
                pressure_hpa:  data.current?.pressure_msl,
            },
            hourly: {
                time:              data.hourly?.time ?? [],
                temp_f:            data.hourly?.temperature_2m ?? [],
                wind_mph:          data.hourly?.wind_speed_10m ?? [],
                wind_gust_mph:     data.hourly?.wind_gusts_10m ?? [],
                wind_dir_deg:      data.hourly?.wind_direction_10m ?? [],
                precip_in:         data.hourly?.precipitation ?? [],
                precip_prob_pct:   data.hourly?.precipitation_probability ?? [],
                cloud_cover:       data.hourly?.cloud_cover ?? [],
                weather_code:      data.hourly?.weather_code ?? [],
                humidity:          data.hourly?.relative_humidity_2m ?? [],
                visibility_m:      data.hourly?.visibility ?? [],
                cape_j_per_kg:     data.hourly?.cape ?? [],
                lifted_index:      data.hourly?.lifted_index ?? [],
                cin_j_per_kg:      data.hourly?.convective_inhibition ?? [],
                // Pressure-level wind arrays, aligned to the same `time` index.
                // Units follow wind_speed_unit (mph), direction in degrees.
                wind_500_mph:      data.hourly?.wind_speed_500hPa ?? [],
                wind_500_dir_deg:  data.hourly?.wind_direction_500hPa ?? [],
                wind_300_mph:      data.hourly?.wind_speed_300hPa ?? [],
                wind_300_dir_deg:  data.hourly?.wind_direction_300hPa ?? [],
                wind_200_mph:      data.hourly?.wind_speed_200hPa ?? [],
                wind_200_dir_deg:  data.hourly?.wind_direction_200hPa ?? [],
            },
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
            fetched_at:   Date.now(),
            forecast_days: forecastDays,
            horizon_end_ms: Date.now() + forecastDays * 86_400_000,
        };
    } catch (e) {
        console.warn('[TripPlanner] launch forecast failed:', e.message);
        return null;
    }
}

/**
 * Marine forecast for a recovery zone (ASDS droneship position, splashdown
 * zone, tower-catch area). Uses Open-Meteo's Marine API.
 *
 * Returns null on failure OR if the point is inland / outside the marine
 * model's ocean mask — Open-Meteo silently returns empty arrays for land
 * coordinates, which we detect and surface so the scorer can skip the
 * recovery-wave rules gracefully instead of flagging them as unavailable.
 *
 * Units: meters for heights, seconds for periods, degrees for directions.
 */
export async function fetchMarineForecast(lat, lon, { forecastDays = 5 } = {}) {
    if (!Number.isFinite(+lat) || !Number.isFinite(+lon)) return null;
    const params = new URLSearchParams({
        latitude:  (+lat).toFixed(4),
        longitude: (+lon).toFixed(4),
        current: [
            'wave_height', 'wave_direction', 'wave_period',
            'wind_wave_height', 'wind_wave_period',
            'swell_wave_height', 'swell_wave_period', 'swell_wave_direction',
            'ocean_current_velocity',
        ].join(','),
        hourly: [
            'wave_height', 'wave_direction', 'wave_period',
            'wind_wave_height', 'wind_wave_direction', 'wind_wave_period',
            'swell_wave_height', 'swell_wave_direction', 'swell_wave_period',
        ].join(','),
        timezone:      'auto',
        forecast_days: String(forecastDays),
    });
    try {
        const res = await fetch(`${OPEN_METEO_MARINE_URL}?${params}`, { signal: AbortSignal.timeout(12000) });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.error) return null;

        // Land coords come back as an array of nulls. Detect that so the
        // scorer can degrade the recovery rules to yellow ("no marine data")
        // rather than silently pass.
        const waveArr = data.hourly?.wave_height ?? [];
        const hasAny  = waveArr.some(v => Number.isFinite(v));
        if (!hasAny) return { inland: true, lat, lon };

        return {
            lat, lon,
            inland:   false,
            timezone: data.timezone,
            current: {
                time:              data.current?.time,
                wave_height_m:     data.current?.wave_height,
                wave_period_s:     data.current?.wave_period,
                wave_dir_deg:      data.current?.wave_direction,
                wind_wave_h_m:     data.current?.wind_wave_height,
                wind_wave_period_s:data.current?.wind_wave_period,
                swell_h_m:         data.current?.swell_wave_height,
                swell_period_s:    data.current?.swell_wave_period,
                swell_dir_deg:     data.current?.swell_wave_direction,
                current_vel_ms:    data.current?.ocean_current_velocity,
            },
            hourly: {
                time:                 data.hourly?.time ?? [],
                wave_height_m:        data.hourly?.wave_height ?? [],
                wave_period_s:        data.hourly?.wave_period ?? [],
                wave_dir_deg:         data.hourly?.wave_direction ?? [],
                wind_wave_h_m:        data.hourly?.wind_wave_height ?? [],
                wind_wave_dir_deg:    data.hourly?.wind_wave_direction ?? [],
                wind_wave_period_s:   data.hourly?.wind_wave_period ?? [],
                swell_h_m:            data.hourly?.swell_wave_height ?? [],
                swell_dir_deg:        data.hourly?.swell_wave_direction ?? [],
                swell_period_s:       data.hourly?.swell_wave_period ?? [],
            },
            fetched_at:     Date.now(),
            forecast_days:  forecastDays,
            horizon_end_ms: Date.now() + forecastDays * 86_400_000,
        };
    } catch (e) {
        console.warn('[TripPlanner] marine forecast failed:', e.message);
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
