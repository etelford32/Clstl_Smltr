/**
 * api/air-quality/residuals.js — model-vs-observation PM2.5 residuals:
 * CAMS (model) sampled at OpenAQ reference monitors (observation).
 *
 * GET /api/air-quality/residuals
 *
 * THE POINT: every other air-quality surface shows either the model or the
 * monitors. This route shows where they DISAGREE — residual = obs − model
 * per station, so positive means CAMS underestimates real pollution at that
 * monitor and negative means it overestimates. Showing where the model is
 * wrong is the site's physics-first differentiator; nothing here may ever
 * blend or reconcile the two sources, and both values ride every row so the
 * frame contract's "displayed together, never substituted" holds by
 * construction.
 *
 * PIPELINE (two upstreams, one response):
 *   1. OpenAQ latest PM2.5 (shared fetchOpenAqLatest — same normalizer and
 *      parameter-id validation as /api/air-quality/stations-intl, so the
 *      two surfaces cannot disagree about what an observation is).
 *   2. Stations thinned to ≤ MAX_STATIONS via per-cell dedup (newest
 *      observation wins; the cell size coarsens 0.5°→1°→2° until the cap
 *      fits — deterministic and spatially fair, never a "first 300" slice
 *      that would favor whichever region reports fastest).
 *   3. ONE batched Open-Meteo/CAMS request at exactly those station
 *      coordinates → model PM2.5 for the same instant class.
 *
 * Stats are STATION-weighted (bias = mean(obs − model), rmse), not
 * area-weighted — monitors cluster in cities, and the response says so via
 * `statsWeighting`. PM2.5 only for now: it is the one species where the
 * CAMS field and the OpenAQ µg/m³ parameter align without unit gymnastics.
 *
 * Degradation: 200 + freshness:'stale' + empty list, with configured:false
 * distinguishing the missing-OPENAQ_API_KEY setup state from real failures.
 *
 * CDN cache: 15 min.
 */

import { jsonOk, fetchWithTimeout } from '../_lib/responses.js';
import { CAMS_PROVENANCE } from '../../js/air-quality-frame.js';
import { fetchOpenAqLatest, OPENAQ_ATTRIBUTION } from './stations-intl.js';

export const config = { runtime: 'edge' };

const CAMS_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const MAX_STATIONS = 300;
const THIN_LADDER_DEG = [0.5, 1, 2];

/**
 * One station per cellDeg×cellDeg cell; the newest observation wins, ties
 * break on id so the result is deterministic on its input.
 */
export function thinStations(stations, cellDeg) {
    const byCell = new Map();
    for (const s of stations) {
        const key = `${Math.floor(s.lat / cellDeg)}:${Math.floor(s.lon / cellDeg)}`;
        const held = byCell.get(key);
        if (!held || s.utc > held.utc || (s.utc === held.utc && s.id < held.id)) {
            byCell.set(key, s);
        }
    }
    return [...byCell.values()];
}

/** Coarsen the thinning cell until the station count fits the cap. */
export function thinToCap(stations, cap = MAX_STATIONS, ladder = THIN_LADDER_DEG) {
    let thinned = stations;
    for (const cellDeg of ladder) {
        thinned = thinStations(stations, cellDeg);
        if (thinned.length <= cap) return thinned;
    }
    // Coarsest rung still over the cap — keep the newest observations.
    return [...thinned].sort((a, b) => b.utc.localeCompare(a.utc) || a.id.localeCompare(b.id))
        .slice(0, cap);
}

/**
 * Pair thinned stations with the CAMS batch response (location i ↔ station
 * i) into residual rows + station-weighted stats. Rows where CAMS returns
 * no finite model value are dropped, not zero-filled.
 */
export function buildResiduals(stations, camsPayload) {
    const locations = Array.isArray(camsPayload) ? camsPayload
        : camsPayload ? [camsPayload] : [];
    const rows = [];
    for (let i = 0; i < stations.length && i < locations.length; i++) {
        const model = locations[i]?.current?.pm2_5;
        if (!Number.isFinite(model)) continue;
        const s = stations[i];
        rows.push({
            id: s.id,
            lat: s.lat,
            lon: s.lon,
            obs: s.value,
            model,
            residual: s.value - model,      // + ⇒ model underestimates
            utc: s.utc,
        });
    }
    let sum = 0, sq = 0, obsSum = 0, modelSum = 0;
    for (const r of rows) {
        sum += r.residual;
        sq += r.residual * r.residual;
        obsSum += r.obs;
        modelSum += r.model;
    }
    const n = rows.length;
    return {
        rows,
        stats: n ? {
            bias: sum / n,
            rmse: Math.sqrt(sq / n),
            meanObs: obsSum / n,
            meanModel: modelSum / n,
            count: n,
        } : null,
    };
}

export default async function handler() {
    const nowMs = Date.now();
    const base = {
        species: 'pm25',
        unit: 'µg/m³',
        statsWeighting: 'station',
        provenance: {
            observation: {
                id: 'openaq-latest', provider: 'OpenAQ', kind: 'observation',
                label: 'OpenAQ reference monitors', attribution: OPENAQ_ATTRIBUTION,
            },
            model: CAMS_PROVENANCE,
        },
        attribution: OPENAQ_ATTRIBUTION,
    };
    try {
        const { stations } = await fetchOpenAqLatest('pm25', process.env.OPENAQ_API_KEY, nowMs);
        const thinned = thinToCap(stations);
        const params = new URLSearchParams({
            latitude: thinned.map(s => s.lat.toFixed(3)).join(','),
            longitude: thinned.map(s => s.lon.toFixed(3)).join(','),
            current: 'pm2_5',
            domains: 'cams_global',
            cell_selection: 'nearest',
            timeformat: 'unixtime',
            timezone: 'GMT',
        });
        const camsRes = await fetchWithTimeout(`${CAMS_URL}?${params}`, {
            timeoutMs: 15_000, headers: { Accept: 'application/json' },
        });
        if (!camsRes.ok) throw new Error(`CAMS HTTP ${camsRes.status}`);
        const camsPayload = await camsRes.json();
        if (camsPayload?.error) throw new Error(camsPayload.reason || 'CAMS returned an error');
        const { rows, stats } = buildResiduals(thinned, camsPayload);
        if (!rows.length) throw new Error('no station↔model pairs resolved');
        return jsonOk({
            updated: new Date(nowMs).toISOString(),
            count: rows.length,
            freshness: 'live',
            configured: true,
            ...base,
            stats,
            residuals: rows,
        }, { maxAge: 900, swr: 300 });
    } catch (e) {
        return jsonOk({
            updated: new Date(nowMs).toISOString(),
            count: 0,
            freshness: 'stale',
            configured: e?.configured !== false,
            reason: e?.message ?? 'unknown',
            ...base,
            stats: null,
            residuals: [],
        }, { maxAge: e?.configured === false ? 300 : 120, swr: 60 });
    }
}
