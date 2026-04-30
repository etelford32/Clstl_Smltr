/**
 * Vercel Edge Function: /api/weather/ssw-verify
 *
 * Backtests a logged SSW event from data/ssw-events.json against
 * Open-Meteo ERA5 archive surface temperatures to confirm whether
 * the cold-air outbreak our combiner would have predicted actually
 * materialised. The verifier is the operational answer to "do our
 * 7-21 day forecasts verify?" — it builds a track record that scales
 * with the number of events we log.
 *
 * Algorithm
 * ---------
 *   1. Look up the event from ssw-events.json by ?id=<event_id>.
 *   2. For each predicted region, sample ERA5 daily mean temperature
 *      at the region's reference cities for two windows:
 *
 *        baseline:    -14 to  -1 days before the event
 *        verification: +lead-1 to +lead+14 days after the event
 *
 *      where `lead` = predicted_lead_days (0 for "in progress",
 *      7-14 for emerging-cold).
 *   3. Compute the mean temperature of each window per city, average
 *      across cities to get a regional mean.
 *   4. anomaly_C = verification_mean - baseline_mean.
 *      anomaly_C ≤ -3 °C  → strong verification
 *      anomaly_C ≤ -1 °C  → partial verification
 *      anomaly_C  >   1 °C → falsified
 *      otherwise          → ambiguous
 *   5. Roll up to a single event-level score.
 *
 * Why this baseline (rather than long-term climatology): we want to
 * detect the *change* the SSW caused, not absolute cold. Comparing
 * the 14 days right before vs the 14 days during the predicted window
 * isolates the SSW signal cleanly. Long-term climatology comparisons
 * are noisier when the season itself is anomalously warm/cold.
 *
 * Cost: 4–10 ERA5 calls per event (one per city, all cities for a
 * given region returned in one Open-Meteo multi-location call).
 * Cached 24 h since historical events never change.
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const OPEN_METEO_ARCHIVE = 'https://archive-api.open-meteo.com/v1/era5';
const CACHE_TTL = 86_400;       // 24 h — historical, immutable
const CACHE_SWR = 6_000;

const VERIFY_THRESHOLD_C  = -3.0;
const PARTIAL_THRESHOLD_C = -1.0;
const FALSIFIED_THRESHOLD_C = +1.0;

const BASELINE_DAYS_BEFORE = 14;
const VERIFY_WINDOW_DAYS   = 14;

export default async function handler(req) {
    const url = new URL(req.url);
    const eventId = url.searchParams.get('id');
    if (!eventId) {
        return jsonError('bad_request', 'id query parameter required',
            { source: 'ssw-verify' });
    }

    // Load the event log from the same origin so we keep one source of
    // truth for the fixture file.
    let log;
    try {
        const res = await fetchWithTimeout(
            `${url.origin}/data/ssw-events.json`,
            { timeoutMs: 5_000 },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        log = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable',
            `Could not load ssw-events.json: ${e.message}`,
            { source: 'ssw-verify' });
    }

    const event = (log.events || []).find(e => e.id === eventId);
    if (!event) {
        return jsonError('not_found', `event '${eventId}' not in log`,
            { source: 'ssw-verify' });
    }

    const regionsMap = log.regions || {};
    const predictedRegions = event.predicted_regions || [];
    if (predictedRegions.length === 0) {
        // Decoupled / neutral events with no predicted regions —
        // there's nothing to verify, by design.
        return jsonOk({
            event_id:    eventId,
            event_date:  event.date,
            verdict:     'no_prediction',
            verdict_note:'Event was classified decoupled / neutral — no '
                       + 'specific cold-air-outbreak forecast to verify.',
            regions:     [],
        }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
    }

    const eventDate = new Date(event.date + 'T00:00:00Z');
    const lead = Number(event.predicted_lead_days) || 0;
    const baselineStart = _shift(eventDate, -BASELINE_DAYS_BEFORE);
    const baselineEnd   = _shift(eventDate,  -1);
    const verifyStart   = _shift(eventDate,  Math.max(1, lead - 1));
    const verifyEnd     = _shift(eventDate,  lead + VERIFY_WINDOW_DAYS);

    const regionResults = [];
    for (const region of predictedRegions) {
        const cities = regionsMap[region];
        if (!Array.isArray(cities) || cities.length === 0) {
            regionResults.push({
                region, status: 'no_cities',
                note: `region '${region}' has no city map in ssw-events.json`,
            });
            continue;
        }
        try {
            const baseline = await _meanTemp(cities, baselineStart, baselineEnd);
            const verify   = await _meanTemp(cities, verifyStart, verifyEnd);
            const anomaly  = verify.mean_C - baseline.mean_C;
            regionResults.push({
                region,
                cities:           cities.map(c => c.name),
                baseline_C:       round1(baseline.mean_C),
                baseline_window:  `${_iso(baselineStart)} … ${_iso(baselineEnd)}`,
                verify_C:         round1(verify.mean_C),
                verify_window:    `${_iso(verifyStart)} … ${_iso(verifyEnd)}`,
                anomaly_C:        round1(anomaly),
                status:           _classifyAnomaly(anomaly),
            });
        } catch (e) {
            regionResults.push({
                region, status: 'error', note: e.message,
            });
        }
    }

    // Roll up to a single verdict for the event.
    const verdict = _rollupVerdict(regionResults);

    return jsonOk({
        event_id:    eventId,
        event_date:  event.date,
        type:        event.type,
        outcome_label: event.outcome_label,
        notes:       event.notes,
        predicted_regime:   event.predicted_regime,
        predicted_lead_days: lead,
        baseline_window:    `${_iso(baselineStart)} … ${_iso(baselineEnd)}`,
        verify_window:      `${_iso(verifyStart)}   … ${_iso(verifyEnd)}`,
        regions:     regionResults,
        verdict:     verdict.status,
        verdict_label: verdict.label,
        verdict_note:  verdict.note,
        score_pct:   verdict.score,
        source: 'Open-Meteo ERA5 reanalysis · daily temperature_2m_mean',
        as_of:  new Date().toISOString(),
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function _meanTemp(cities, start, end) {
    // Open-Meteo ERA5 multi-location call. Each returned object
    // contains one daily array; we average across days first, then
    // across cities.
    const params = new URLSearchParams({
        latitude:         cities.map(c => String(c.lat)).join(','),
        longitude:        cities.map(c => String(c.lon)).join(','),
        start_date:       _iso(start),
        end_date:         _iso(end),
        daily:            'temperature_2m_mean',
        timezone:         'UTC',
        temperature_unit: 'celsius',
    });
    const res = await fetchWithTimeout(
        `${OPEN_METEO_ARCHIVE}?${params}`,
        { timeoutMs: 12_000 },
    );
    if (!res.ok) throw new Error(`ERA5 HTTP ${res.status}`);
    const body = await res.json();
    const samples = Array.isArray(body) ? body : [body];

    const cityMeans = [];
    for (const s of samples) {
        const arr = s.daily?.temperature_2m_mean || [];
        const finite = arr.filter(Number.isFinite);
        if (finite.length === 0) continue;
        cityMeans.push(finite.reduce((a, b) => a + b, 0) / finite.length);
    }
    if (cityMeans.length === 0) {
        throw new Error('ERA5 returned no temperature data for window');
    }
    const mean_C = cityMeans.reduce((a, b) => a + b, 0) / cityMeans.length;
    return { mean_C, n_cities: cityMeans.length };
}

function _classifyAnomaly(anomaly_C) {
    if (!Number.isFinite(anomaly_C)) return 'unknown';
    if (anomaly_C <= VERIFY_THRESHOLD_C)    return 'verified';
    if (anomaly_C <= PARTIAL_THRESHOLD_C)   return 'partial';
    if (anomaly_C >= FALSIFIED_THRESHOLD_C) return 'falsified';
    return 'ambiguous';
}

function _rollupVerdict(regions) {
    const valid = regions.filter(r =>
        ['verified', 'partial', 'ambiguous', 'falsified'].includes(r.status));
    if (valid.length === 0) {
        return {
            status: 'no_data', label: 'No data',
            note: 'ERA5 did not return temperature data for any region.',
            score: null,
        };
    }
    const counts = { verified: 0, partial: 0, ambiguous: 0, falsified: 0 };
    let anomalySum = 0;
    for (const r of valid) {
        counts[r.status] = (counts[r.status] || 0) + 1;
        if (Number.isFinite(r.anomaly_C)) anomalySum += r.anomaly_C;
    }
    const meanAnom = anomalySum / valid.length;
    const score = Math.round(100 *
        (counts.verified + 0.5 * counts.partial) / valid.length);

    if (counts.verified >= valid.length / 2) return {
        status: 'verified', label: 'Verified',
        note: `Mean anomaly ${round1(meanAnom)} °C across ${valid.length} regions; `
            + `${counts.verified} of ${valid.length} regions saw ≥3 °C cold-air outbreak.`,
        score,
    };
    if (counts.verified + counts.partial >= valid.length / 2) return {
        status: 'partial', label: 'Partial',
        note: `Some regions cooled (mean ${round1(meanAnom)} °C); pattern emerged but did not reach the −3 °C threshold everywhere.`,
        score,
    };
    if (counts.falsified > counts.verified + counts.partial) return {
        status: 'falsified', label: 'Falsified',
        note: `Most regions warmed instead of cooling (mean ${round1(meanAnom)} °C). `
            + 'Forecast did not verify.',
        score,
    };
    return {
        status: 'ambiguous', label: 'Ambiguous',
        note: `Mean anomaly ${round1(meanAnom)} °C — within climatological noise.`,
        score,
    };
}

function _shift(date, days) {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
}
function _iso(d) { return d.toISOString().slice(0, 10); }
function round1(v) { return Number.isFinite(v) ? Math.round(v * 10) / 10 : null; }
