/**
 * Timestamped numeric CAMS air-quality sample grid for EarthView.
 *
 * GET /api/air-quality/grid?at=<ISO>&detail=global|regional|local&lat=&lon=
 *
 * One bounded multi-coordinate Open-Meteo request returns AQI, PM2.5, PM10,
 * and 550 nm AOD for the exact shared-timeline hour. This is modeled CAMS
 * data; the response provenance never describes it as a station observation.
 */

import { jsonError, jsonOk, fetchWithTimeout } from '../_lib/responses.js';
import {
    buildCamsGrid,
    normalizeCamsFrame,
    resolveAirQualityTime,
} from '../../js/air-quality-frame.js';

export const config = { runtime: 'edge' };

const CAMS_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const VARIABLES = 'us_aqi,pm2_5,pm10,aerosol_optical_depth';

function finiteCoordinate(value, min, max, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}
function isoHour(ms) {
    return new Date(ms).toISOString().slice(0, 13) + ':00';
}

export default async function handler(request) {
    const url = new URL(request.url);
    const parsedAt = Date.parse(url.searchParams.get('at') || '');
    const requestedMs = Number.isFinite(parsedAt) ? parsedAt : Date.now();
    const timing = resolveAirQualityTime({ simTimeMs: requestedMs });
    if (!timing.modelAvailable) {
        return jsonOk({
            available: false,
            reason: timing.mode === 'forecast' ? 'forecast_horizon_exceeded' : 'history_window_exceeded',
            requestedAt: new Date(timing.targetMs).toISOString(),
            source: 'Open-Meteo / CAMS Global',
        }, { maxAge: 300, swr: 60 });
    }

    const detailParam = url.searchParams.get('detail');
    const detail = detailParam === 'local' || detailParam === 'regional'
        ? detailParam : 'global';
    const focusLat = finiteCoordinate(url.searchParams.get('lat'), -90, 90);
    const focusLon = finiteCoordinate(url.searchParams.get('lon'), -180, 180);
    const { scope, coordinates } = buildCamsGrid(detail, focusLat, focusLon);
    const params = new URLSearchParams({
        latitude: coordinates.map(point => point.lat).join(','),
        longitude: coordinates.map(point => point.lon).join(','),
        hourly: VARIABLES,
        timeformat: 'unixtime',
        timezone: 'GMT',
        domains: 'cams_global',
        cell_selection: 'nearest',
        start_hour: isoHour(timing.targetMs),
        end_hour: isoHour(timing.targetMs),
    });

    try {
        const response = await fetchWithTimeout(`${CAMS_URL}?${params}`, {
            timeoutMs: 15000,
            headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`CAMS HTTP ${response.status}`);
        const payload = await response.json();
        if (payload?.error) throw new Error(payload.reason || 'CAMS returned an error');
        const retrievedMs = Date.now();
        const frame = normalizeCamsFrame(payload, {
            requestedMs: timing.targetMs,
            retrievedMs,
            scope,
        });
        if (!frame.points.length) throw new Error('CAMS returned no numeric cells');
        return jsonOk({
            available: true,
            frame,
            count: frame.points.length,
            source_url: 'https://open-meteo.com/en/docs/air-quality-api',
            note: 'Modeled CAMS grid samples; not ground monitor observations.',
        }, {
            maxAge: timing.mode === 'replay' ? 86400 : 900,
            swr: timing.mode === 'replay' ? 43200 : 120,
        });
    } catch (error) {
        return jsonError('upstream_unavailable', error.message, {
            source: 'Open-Meteo / CAMS Global',
        });
    }
}
