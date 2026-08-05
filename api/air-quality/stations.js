/**
 * Timestamped EPA AirNow hourly monitor observations for EarthView.
 *
 * GET /api/air-quality/stations?at=<ISO>&lat=&lon=&span=20
 *
 * AirNow's public HourlyAQObs files require no API key. The newest completed
 * file normally trails wall time by roughly one hour, so live requests try
 * the requested UTC hour and then the preceding three hours. Historical
 * requests resolve directly to their documented YYYY/YYYYMMDD object.
 */

import { jsonError, jsonOk, fetchWithTimeout } from '../_lib/responses.js';
import {
    AIR_HOUR_MS,
    normalizeAirNowFrame,
    resolveAirQualityTime,
} from '../../js/air-quality-frame.js';

export const config = { runtime: 'edge' };

const AIRNOW_ROOT = 'https://files.airnowtech.org/airnow';

function pad(value) { return String(value).padStart(2, '0'); }

export function airNowHourlyUrl(ms) {
    const date = new Date(ms);
    const year = date.getUTCFullYear();
    const stamp = `${year}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
    const hour = pad(date.getUTCHours());
    return `${AIRNOW_ROOT}/${year}/${stamp}/HourlyAQObs_${stamp}${hour}.dat`;
}
function bounded(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function wrapLon(lon) { return ((lon + 540) % 360) - 180; }

export default async function handler(request) {
    const url = new URL(request.url);
    const parsedAt = Date.parse(url.searchParams.get('at') || '');
    const requestedMs = Number.isFinite(parsedAt) ? parsedAt : Date.now();
    const timing = resolveAirQualityTime({ simTimeMs: requestedMs });
    if (!timing.observationsAvailable) {
        return jsonOk({
            available: false,
            reason: timing.mode === 'forecast' ? 'observations_not_forecasts' : 'history_window_exceeded',
            requestedAt: new Date(timing.targetMs).toISOString(),
            source: 'EPA AirNow Hourly AQ Obs',
        }, { maxAge: 300, swr: 60 });
    }

    const centerLat = Math.round(bounded(url.searchParams.get('lat'), -80, 80, 39) / 5) * 5;
    const centerLon = wrapLon(Math.round(bounded(url.searchParams.get('lon'), -180, 180, -98) / 5) * 5);
    const spanDeg = bounded(url.searchParams.get('span'), 5, 40, 20);
    const scope = {
        key: `stations-${centerLat.toFixed(0)}-${centerLon.toFixed(0)}-${spanDeg.toFixed(0)}`,
        kind: 'stations', centerLat, centerLon, spanDeg,
    };

    let lastError = null;
    for (let lag = 0; lag <= 3; lag++) {
        const candidateMs = timing.targetMs - lag * AIR_HOUR_MS;
        const upstream = airNowHourlyUrl(candidateMs);
        try {
            const response = await fetchWithTimeout(upstream, {
                timeoutMs: 15000,
                headers: { Accept: 'text/plain' },
            });
            if (response.status === 404) { lastError = new Error(`hour -${lag} not published`); continue; }
            if (!response.ok) throw new Error(`AirNow HTTP ${response.status}`);
            const frame = normalizeAirNowFrame(await response.text(), {
                requestedMs: timing.targetMs,
                retrievedMs: Date.now(),
                scope,
            });
            // Preserve the request key even when the live adapter selected a
            // one-hour-older completed file. That lets the scrub cache answer
            // the same user request without another edge round trip.
            return jsonOk({
                available: true,
                frame,
                count: frame.points.length,
                source_url: upstream,
                selectedLagHours: lag,
                note: 'Preliminary monitor observations; regulatory data belong to EPA AQS.',
            }, {
                maxAge: timing.mode === 'replay' ? 86400 : 300,
                swr: timing.mode === 'replay' ? 43200 : 120,
            });
        } catch (error) {
            lastError = error;
        }
    }

    return jsonError('upstream_unavailable', lastError?.message || 'No AirNow hourly file available', {
        source: 'EPA AirNow Hourly AQ Obs',
    });
}
