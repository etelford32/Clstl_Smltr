/**
 * api/air-quality/nowcast-validation.js — is our EPA NowCast the same number
 * AirNow publishes?
 *
 * GET /api/air-quality/nowcast-validation?hours=12
 *
 * THE POINT: js/aqi-scale.js implements NowCast from the published EPA
 * definition and tests/aqi-scale.mjs proves the arithmetic against hand-worked
 * values. That proves the code matches our READING of the spec. This route
 * checks that reading against the authority, using the one source that carries
 * both the input and the answer: AirNow's HourlyAQObs files publish, per
 * monitor and per hour, the raw PM2.5 concentration AND AirNow's own
 * NowCast-based PM25_AQI.
 *
 * We pull `hours` consecutive files, rebuild each monitor's series, recompute
 * NowCast, and diff against their published value across every US monitor.
 * No API key — same keyless upstream /api/air-quality/stations already uses.
 *
 * Failure mode: 200 + freshness:'stale' + empty rows (CLAUDE.md §8), so
 * status.html scores it amber rather than green. A validation route that 500s
 * is indistinguishable from one that passes, which is the worst outcome.
 *
 * Cost: `hours` upstream GETs of ~2 MB each, so this is CDN-cached for an
 * hour and is a COLD-tier pre-warm target, never a per-visitor fetch. Files
 * older than the newest are immutable, so repeat runs mostly hit cache.
 *
 * CAVEAT worth keeping in the response: AirNow monitors are preliminary, and
 * AirNow may apply QA our raw-series recomputation cannot see. A small
 * residual disagreement is expected and is not automatically our bug — the
 * stats are shaped to tell a systematic offset from scatter.
 */

import { jsonOk, fetchWithTimeout } from '../_lib/responses.js';
import { AIR_HOUR_MS, AIRNOW_PROVENANCE, normalizeAirNowFrame } from '../../js/air-quality-frame.js';
import {
    NOWCAST_WINDOW_HOURS,
    buildStationSeries,
    validateNowcast,
    verdict,
} from '../../js/aqi-validation.js';
import { airNowHourlyUrl } from './stations.js';

export const config = { runtime: 'edge' };

const MAX_HOURS = 24;
/** Files trail wall time by ~1 h; start far enough back to find a complete set. */
const PUBLICATION_LAG_HOURS = 2;

export default async function handler(request) {
    const nowMs = Date.now();
    const url = new URL(request.url);
    const requested = Number(url.searchParams.get('hours'));
    const hours = Number.isFinite(requested)
        ? Math.max(3, Math.min(MAX_HOURS, Math.round(requested)))
        : NOWCAST_WINDOW_HOURS;

    const base = {
        updated: new Date(nowMs).toISOString(),
        method: 'EPA NowCast (12-h weighted) recomputed from AirNow PM2.5 series',
        reference: 'AirNow published PM25_AQI (NowCast-based)',
        provenance: AIRNOW_PROVENANCE,
        note: 'Preliminary monitor data. AirNow may apply QA this recomputation '
            + 'cannot see, so a small residual disagreement is expected. This '
            + 'validates INDEX MATH only — model-vs-reality is /api/air-quality/residuals.',
    };

    // Anchor on the newest hour that is plausibly published, then walk back.
    const anchorMs = Math.floor((nowMs - PUBLICATION_LAG_HOURS * AIR_HOUR_MS) / AIR_HOUR_MS) * AIR_HOUR_MS;

    try {
        const results = await Promise.allSettled(
            Array.from({ length: hours }, (_, i) => {
                const validMs = anchorMs - i * AIR_HOUR_MS;
                return fetchWithTimeout(airNowHourlyUrl(validMs), {
                    timeoutMs: 20_000, headers: { Accept: 'text/plain' },
                }).then(async (r) => {
                    if (!r.ok) throw new Error(`hour -${i} HTTP ${r.status}`);
                    return normalizeAirNowFrame(await r.text(), {
                        requestedMs: validMs,
                        retrievedMs: nowMs,
                        // Global scope: this is a nationwide check, not a viewport.
                        scope: { key: 'validation-global', kind: 'global' },
                    });
                });
            }),
        );

        const frames = results.filter(r => r.status === 'fulfilled').map(r => r.value);
        const missing = results.length - frames.length;
        if (frames.length < 3) {
            throw new Error(`only ${frames.length} of ${hours} hourly files resolved`);
        }

        const stations = buildStationSeries(frames);
        const { rows, skipped, stats } = validateNowcast(stations, { nowMs: anchorMs });
        if (!rows.length) throw new Error('no monitor had both a series and a published AQI');

        // The per-station rows are the evidence; cap what ships so the payload
        // stays reasonable, and say how many were dropped rather than implying
        // the list is complete (CLAUDE.md: no silent caps).
        const SAMPLE_CAP = 200;
        const worstFirst = [...rows].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

        return jsonOk({
            ...base,
            freshness: 'live',
            hoursRequested: hours,
            hoursResolved: frames.length,
            hoursMissing: missing,
            anchorHour: new Date(anchorMs).toISOString(),
            stats,
            verdict: verdict(stats),
            comparedStations: rows.length,
            skippedStations: skipped.length,
            skippedReasons: countReasons(skipped),
            sampleTruncatedFrom: rows.length > SAMPLE_CAP ? rows.length : undefined,
            // Worst disagreements first — the useful end of the list.
            stations: worstFirst.slice(0, SAMPLE_CAP),
        }, { maxAge: 3600, swr: 1800 });
    } catch (e) {
        return jsonOk({
            ...base,
            freshness: 'stale',
            reason: e?.message ?? 'unknown',
            stats: null,
            verdict: verdict(null),
            comparedStations: 0,
            skippedStations: 0,
            stations: [],
        }, { maxAge: 300, swr: 120 });
    }
}

function countReasons(skipped) {
    const out = {};
    for (const s of skipped) out[s.reason] = (out[s.reason] ?? 0) + 1;
    return out;
}
