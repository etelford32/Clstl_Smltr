/**
 * NOAA NDBC latest marine observations.
 *
 *   ?mode=stations                         global live marker collection
 *   ?lat=37.8&lon=-122.5&limit=3           nearest marine stations
 */

import { jsonError, jsonOk, fetchWithTimeout } from '../_lib/responses.js';
import { finiteOrNull, haversineKm, roundTo, validCoordinates } from '../_lib/ocean.js';

export const config = { runtime: 'edge' };

const NDBC_LATEST = 'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt';
const SOURCE = 'NOAA NDBC';

function utcTimestamp(parts) {
    const [year, month, day, hour, minute] = parts.map(Number);
    if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
    const timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute));
    return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

export function parseNdbcLatest(text) {
    const stations = [];
    for (const rawLine of String(text ?? '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const col = line.split(/\s+/);
        if (col.length < 22) continue;
        const lat = finiteOrNull(col[1]);
        const lon = finiteOrNull(col[2]);
        if (!validCoordinates(lat, lon)) continue;
        const station = {
            id: col[0], lat, lon,
            observed_at: utcTimestamp(col.slice(3, 8)),
            wind_direction_deg: finiteOrNull(col[8]),
            wind_speed_ms: finiteOrNull(col[9]),
            gust_ms: finiteOrNull(col[10]),
            wave_height_m: finiteOrNull(col[11]),
            dominant_period_s: finiteOrNull(col[12]),
            average_period_s: finiteOrNull(col[13]),
            mean_wave_direction_deg: finiteOrNull(col[14]),
            pressure_hpa: finiteOrNull(col[15]),
            pressure_tendency_hpa: finiteOrNull(col[16]),
            air_temp_c: finiteOrNull(col[17]),
            water_temp_c: finiteOrNull(col[18]),
            dewpoint_c: finiteOrNull(col[19]),
            visibility_nm: finiteOrNull(col[20]),
            tide_ft: finiteOrNull(col[21]),
        };
        const hasMarineData = [station.wave_height_m, station.water_temp_c, station.tide_ft].some(Number.isFinite);
        if (station.observed_at && hasMarineData) stations.push(station);
    }
    return stations;
}

export function nearestNdbcStations(stations, lat, lon, { limit = 3, radiusKm = 600 } = {}) {
    return (stations ?? [])
        .map(station => ({
            ...station,
            distance_km: roundTo(haversineKm(lat, lon, station.lat, station.lon), 1),
            station_url: `https://www.ndbc.noaa.gov/station_page.php?station=${encodeURIComponent(station.id.toLowerCase())}`,
        }))
        .filter(station => station.distance_km <= radiusKm)
        .sort((a, b) => a.distance_km - b.distance_km)
        .slice(0, limit);
}

export default async function handler(request) {
    const url = new URL(request.url);
    try {
        const response = await fetchWithTimeout(NDBC_LATEST, {
            timeoutMs: 9000,
            headers: { Accept: 'text/plain' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const parsed = parseNdbcLatest(await response.text());

        if (url.searchParams.get('mode') === 'stations') {
            return jsonOk({
                source: SOURCE,
                source_url: 'https://www.ndbc.noaa.gov/',
                count: parsed.length,
                stations: parsed,
                disclaimer: 'Not for navigation.',
            }, { maxAge: 300, swr: 120 });
        }

        const latRaw = url.searchParams.get('lat');
        const lonRaw = url.searchParams.get('lon');
        const lat = latRaw == null || latRaw === '' ? NaN : Number(latRaw);
        const lon = lonRaw == null || lonRaw === '' ? NaN : Number(lonRaw);
        if (!validCoordinates(lat, lon)) {
            return jsonError('invalid_coordinates', 'lat and lon are required and must be valid degrees', {
                status: 400, source: SOURCE,
            });
        }
        const limit = Math.max(1, Math.min(5, Math.round(Number(url.searchParams.get('limit')) || 3)));
        const radiusKm = Math.max(50, Math.min(3000, Math.round(Number(url.searchParams.get('radius_km')) || 600)));
        const stations = nearestNdbcStations(parsed, lat, lon, { limit, radiusKm });
        return jsonOk({
            source: SOURCE,
            source_url: 'https://www.ndbc.noaa.gov/',
            available: stations.length > 0,
            radius_km: radiusKm,
            stations,
            units: {
                distance: 'km', wave_height: 'm', period: 's', wind_speed: 'm/s',
                temperature: '°C', pressure: 'hPa', tide: 'ft',
            },
            disclaimer: 'Not for navigation.',
        }, { maxAge: 300, swr: 120 });
    } catch (error) {
        return jsonError('upstream_unavailable', error.message, { source: SOURCE });
    }
}
