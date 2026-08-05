/**
 * NOAA NDBC DART tsunameters and time-addressable water-column history.
 *
 *   ?mode=stations                         active DART marker catalogue
 *   ?station=46407&at=2026-08-05T00:00Z   observations around scrub time
 *   ?station=46407&at=...&hours=24         1–120 h window (default 24)
 *
 * This route deliberately joins the existing /api/ocean family. Marker
 * geometry and historical samples therefore share the same response/cache
 * conventions as CO-OPS tides and NDBC marine buoys.
 */

import { jsonError, jsonOk, fetchWithTimeout } from '../_lib/responses.js';
import { finiteOrNull, validCoordinates } from '../_lib/ocean.js';

export const config = { runtime: 'edge' };

const ACTIVE_STATIONS = 'https://www.ndbc.noaa.gov/activestations.xml';
const DART_DATA = 'https://www.ndbc.noaa.gov/dart_data.php';
const SOURCE = 'NOAA NDBC DART';
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

function decodeXml(value) {
    return String(value ?? '')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');
}

function xmlAttrs(tag) {
    const out = {};
    for (const match of String(tag).matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) {
        out[match[1]] = decodeXml(match[3]);
    }
    return out;
}

export function parseDartStations(xml) {
    const stations = [];
    for (const match of String(xml ?? '').matchAll(/<station\b[^>]*\/?\s*>/gi)) {
        const attrs = xmlAttrs(match[0]);
        if (String(attrs.dart ?? '').toLowerCase() !== 'y') continue;
        const lat = finiteOrNull(attrs.lat);
        const lon = finiteOrNull(attrs.lon);
        if (!attrs.id || !validCoordinates(lat, lon)) continue;
        stations.push({
            id: String(attrs.id),
            name: String(attrs.name || `DART ${attrs.id}`),
            owner: attrs.owner ? String(attrs.owner) : null,
            lat,
            lon,
            reporting: true,
            station_url: `https://www.ndbc.noaa.gov/station_page.php?station=${encodeURIComponent(String(attrs.id).toLowerCase())}`,
        });
    }
    return stations.sort((a, b) => a.id.localeCompare(b.id));
}

export function parseDartReadings(text, { startMs = -Infinity, endMs = Infinity } = {}) {
    const readings = [];
    for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || !/^\d{4}\s/.test(line)) continue;
        const col = line.split(/\s+/);
        if (col.length < 8) continue;
        const [year, month, day, hour, minute, second, type] = col.slice(0, 7).map(Number);
        const height = finiteOrNull(col[7]);
        if (![year, month, day, hour, minute, second, type].every(Number.isFinite) || height === null) continue;
        const t = Date.UTC(year, month - 1, day, hour, minute, second);
        if (!Number.isFinite(t) || t < startMs || t > endMs) continue;
        readings.push({
            time: new Date(t).toISOString(),
            measurement_type: type,
            cadence: type === 3 ? '15-second' : type === 2 ? '1-minute' : type === 1 ? '15-minute' : 'unknown',
            water_column_height_m: height,
        });
    }
    readings.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    return readings;
}

async function fetchText(url, accept) {
    const response = await fetchWithTimeout(url, {
        timeoutMs: 12_000,
        headers: { Accept: accept },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
}

function utcDateParts(ms) {
    const date = new Date(ms);
    return {
        month: String(date.getUTCMonth() + 1),
        day: String(date.getUTCDate()),
        year: String(date.getUTCFullYear()),
    };
}

export default async function handler(request) {
    const url = new URL(request.url);

    if (url.searchParams.get('mode') === 'stations') {
        try {
            const stations = parseDartStations(await fetchText(ACTIVE_STATIONS, 'application/xml,text/xml'));
            return jsonOk({
                source: SOURCE,
                source_url: 'https://www.ndbc.noaa.gov/dart/',
                count: stations.length,
                stations,
                disclaimer: 'Observations only. A DART trigger is not an official tsunami warning. Not for navigation.',
            }, { maxAge: 3600, swr: 900 });
        } catch (error) {
            return jsonError('upstream_unavailable', error.message, { source: SOURCE });
        }
    }

    const station = String(url.searchParams.get('station') ?? '').trim();
    if (!/^[A-Za-z0-9_-]{3,12}$/.test(station)) {
        return jsonError('invalid_station', 'station is required and must be an NDBC station identifier', {
            status: 400, source: SOURCE,
        });
    }

    const requestedAt = url.searchParams.get('at');
    const atMs = requestedAt ? Date.parse(requestedAt) : Date.now();
    if (!Number.isFinite(atMs)) {
        return jsonError('invalid_time', 'at must be a valid ISO-8601 timestamp', {
            status: 400, source: SOURCE,
        });
    }
    if (atMs > Date.now() + MAX_FUTURE_SKEW_MS) {
        return jsonOk({
            source: SOURCE,
            available: false,
            reason: 'observations_not_forecasts',
            station: { id: station },
            requested_at: new Date(atMs).toISOString(),
            readings: [],
            disclaimer: 'DART provides observations, not future forecasts.',
        }, { maxAge: 60 });
    }

    const hours = Math.max(1, Math.min(120, Math.round(Number(url.searchParams.get('hours')) || 24)));
    const halfWindowMs = hours * 3_600_000 / 2;
    const startMs = atMs - halfWindowMs;
    const endMs = Math.min(Date.now(), atMs + halfWindowMs);
    const start = utcDateParts(startMs);
    // NDBC's end date is the 00:00 boundary at the beginning of that day.
    // Request the following UTC day, then trim precisely to endMs below.
    const endBoundary = new Date(endMs);
    const endQueryMs = Date.UTC(
        endBoundary.getUTCFullYear(), endBoundary.getUTCMonth(), endBoundary.getUTCDate() + 1,
    );
    const end = utcDateParts(endQueryMs);
    const upstream = `${DART_DATA}?${new URLSearchParams({
        station,
        startmonth: start.month,
        startday: start.day,
        startyear: start.year,
        endmonth: end.month,
        endday: end.day,
        endyear: end.year,
    })}`;

    try {
        const readings = parseDartReadings(await fetchText(upstream, 'text/plain,text/html'), { startMs, endMs });
        const heights = readings.map(row => row.water_column_height_m);
        const latest = readings.at(-1) ?? null;
        return jsonOk({
            source: SOURCE,
            source_url: `https://www.ndbc.noaa.gov/station_page.php?station=${encodeURIComponent(station.toLowerCase())}`,
            available: readings.length > 0,
            reason: readings.length ? null : 'no_samples_in_window',
            station: { id: station },
            requested_at: new Date(atMs).toISOString(),
            window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), hours },
            latest,
            range_m: readings.length ? { min: Math.min(...heights), max: Math.max(...heights) } : null,
            readings,
            units: { water_column_height: 'm', time: 'UTC' },
            disclaimer: 'Observations only. A DART trigger is not an official tsunami warning. Not for navigation.',
        }, { maxAge: Date.now() - atMs > 48 * 3_600_000 ? 86400 : 300, swr: 120 });
    } catch (error) {
        return jsonError('upstream_unavailable', error.message, { source: SOURCE });
    }
}
