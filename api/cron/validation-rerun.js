/**
 * Vercel Node Cron: /api/cron/validation-rerun
 *
 * DAILY re-run of both Sun→Earth validation studies over the rolling
 * solar_wind_samples window, appending one row per study to
 * public.validation_runs (service-role-only table — see
 * supabase-validation-runs-migration.sql):
 *
 *   backmap     — attribution scoring: how often fast-wind arrivals
 *                 back-map to a catalogued coronal hole vs chance
 *                 (RING_CURRENT_BACKMAP_VALIDATION.md)
 *   recurrence  — out-of-sample hindcast: predicted vs actual stream
 *                 arrival day/speed per hole
 *                 (RING_CURRENT_RECURRENCE_VALIDATION.md)
 *
 * The scoring engine is js/validation-scoring.js — the same code the CLI
 * scripts run, so a cron row and a hand run are always comparable. As the
 * archive grows past one Carrington rotation the daily rows become a
 * genuine skill time-series (the quotable numbers).
 *
 * Wind: validation_wind_buckets RPC (6-h medians, service-role).
 * Holes: HEK her API, SPoCA only, chunked 3-day windows over the last
 * 21 days, deduped per day on a 5° Carrington grid (same rules as
 * api/hek/coronal-holes.js). Individual chunk failures are tolerated —
 * a partial catalog is reported, never silently treated as complete.
 *
 * Auth: x-vercel-cron header, or Authorization: Bearer ${CRON_SECRET}.
 * Schedule: vercel.json → 06:30 UT daily (after HEK's overnight backlog).
 *
 * Response: 200 { ok, window, buckets, holes, hekChunksFailed,
 *                 backmap: {...}, recurrence: {...}, dur_ms }
 */

import { fetchWithTimeout } from '../_lib/responses.js';
import {
    backmapRows, backmapScore, runHindcast, BACKMAP,
} from '../../js/validation-scoring.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const WATCHDOG_MS = 57_000;
const HEK_BASE = 'https://www.lmsal.com/hek/her';
const HEK_DAYS = 21;
const HEK_CHUNK_DAYS = 3;
const DAY = 86.4e6;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';

function isAuthorized(request) {
    const hdr = request.headers.get('authorization') ?? '';
    if (CRON_SECRET && hdr === `Bearer ${CRON_SECRET}`) return true;
    if (request.headers.get('x-vercel-cron')) return true;
    return false;
}

const sbHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
};

async function fetchBuckets() {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/validation_wind_buckets`, {
        method: 'POST', timeoutMs: 10_000, headers: sbHeaders,
        body: JSON.stringify({ p_days: 16 }),
    });
    if (!res.ok) throw new Error(`wind_buckets ${res.status}`);
    const rows = await res.json();
    return rows
        .map(r => ({ t: Date.parse(r.bucket), v: r.v_med, vMed: r.v_med }))
        .filter(r => Number.isFinite(r.t) && Number.isFinite(r.v))
        .sort((a, b) => a.t - b.t);
}

/** HEK SPoCA detections, chunked + deduped per day on a 5° grid. */
async function fetchHoles(endMs) {
    const holes = [];
    let failed = 0;
    const seen = new Map();   // day_lat5_lon5 → true
    for (let k = 0; k < Math.ceil(HEK_DAYS / HEK_CHUNK_DAYS); k++) {
        const c1 = new Date(endMs - (k + 1) * HEK_CHUNK_DAYS * DAY).toISOString().replace(/\.\d{3}Z$/, '');
        const c2 = new Date(endMs - k * HEK_CHUNK_DAYS * DAY).toISOString().replace(/\.\d{3}Z$/, '');
        const params = new URLSearchParams({
            cmd: 'search', type: 'column', event_type: 'ch',
            event_coordsys: 'helioprojective', x1: '-3000', x2: '3000', y1: '-3000', y2: '3000',
            event_starttime: c1, event_endtime: c2,
            result_limit: '200', cosec: '2',
            return: 'frm_name,hgs_y,hgc_x,event_starttime',
        });
        try {
            const res = await fetchWithTimeout(`${HEK_BASE}?${params}`, {
                timeoutMs: 12_000, headers: { Accept: 'application/json' },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const raw = await res.json();
            for (const r of raw?.result ?? []) {
                if (!/spoca/i.test(r.frm_name ?? '')) continue;
                const lat = parseFloat(r.hgs_y);
                const lonCar = ((parseFloat(r.hgc_x) % 360) + 360) % 360;
                const day = String(r.event_starttime ?? '').slice(0, 10);
                if (!isFinite(lat) || !isFinite(lonCar) || day.length !== 10) continue;
                const key = `${day}_${Math.round(lat / 5) * 5}_${Math.round(lonCar / 5) * 5}`;
                if (seen.has(key)) continue;
                seen.set(key, true);
                holes.push({ day, lat, lonCar });
            }
        } catch {
            failed++;
        }
    }
    return { holes, failed };
}

async function insertRun(row) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/validation_runs`, {
        method: 'POST', timeoutMs: 8_000,
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify(row),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`insert_run ${res.status}: ${text.slice(0, 200)}`);
    }
}

async function runValidation(request) {
    const started = Date.now();
    if (!isAuthorized(request)) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return Response.json({ ok: false, reason: 'supabase_not_configured' }, { status: 503 });
    }

    const buckets = await fetchBuckets();
    if (buckets.length < 8) {
        return Response.json({
            ok: false, reason: 'insufficient_wind_data', buckets: buckets.length,
        }, { status: 200 });   // 200: not an infra failure, just a thin archive
    }
    const windowStart = buckets[0].t, windowEnd = buckets[buckets.length - 1].t;
    const { holes, failed: hekChunksFailed } = await fetchHoles(windowEnd);
    if (!holes.length) {
        return Response.json({ ok: false, reason: 'hek_unavailable', hekChunksFailed }, { status: 502 });
    }

    // ── Study 1: back-mapping attribution ────────────────────────────
    const bmScore = backmapScore(backmapRows(buckets, holes));
    const bm20 = bmScore.fast?.tol?.[20] ?? {};
    await insertRun({
        kind: 'backmap',
        window_start: new Date(windowStart).toISOString(),
        window_end: new Date(windowEnd).toISOString(),
        n_forecasts: bmScore.fast?.n ?? 0,
        hits: bm20.hits ?? null,
        hit_rate: bm20.hitRate ?? null,
        mae_days: null,
        skill: bm20.skill ?? null,
        metrics: { tols: BACKMAP.TOLS, score: bmScore, holes: holes.length },
    });

    // ── Study 2: recurrence hindcast ─────────────────────────────────
    const rc = runHindcast(buckets, holes);
    await insertRun({
        kind: 'recurrence',
        window_start: new Date(windowStart).toISOString(),
        window_end: new Date(windowEnd).toISOString(),
        n_forecasts: rc.n,
        hits: rc.hits,
        hit_rate: rc.hitRate,
        mae_days: rc.maeDays,
        skill: rc.timingSkill,
        metrics: {
            matched: rc.matched, maeSpeed: rc.maeSpeed,
            independentEvents: rc.independentEvents, missedOnsets: rc.missedOnsets,
            onsets: rc.onsets,
        },
        detail: {
            forecasts: rc.forecasts.map(f => ({
                issue: f.issue, lat: f.lat, lonCar: Math.round(f.lonCar),
                basis: f.basis, vPred: Math.round(f.vPred),
                arriveMs: f.arriveMs, dtDays: f.dtDays, vObs: f.vObs, hit: f.hit,
            })),
        },
    });

    return Response.json({
        ok: true,
        window: { start: new Date(windowStart).toISOString(), end: new Date(windowEnd).toISOString() },
        buckets: buckets.length,
        holes: holes.length,
        hekChunksFailed,
        backmap: { nFast: bmScore.fast?.n, hitRate20: bm20.hitRate, chance20: bm20.chance, skill20: bm20.skill },
        recurrence: {
            n: rc.n, hits: rc.hits, hitRate: rc.hitRate, maeDays: rc.maeDays,
            timingSkill: rc.timingSkill, independentEvents: rc.independentEvents,
        },
        dur_ms: Date.now() - started,
    });
}

export default async function handler(request) {
    let timer;
    const watchdog = new Promise((resolve) => {
        timer = setTimeout(() => resolve(Response.json(
            { ok: false, reason: 'worker_timeout', budget_ms: WATCHDOG_MS }, { status: 504 },
        )), WATCHDOG_MS);
    });
    try {
        return await Promise.race([runValidation(request), watchdog]);
    } catch (e) {
        return Response.json({ ok: false, reason: String(e?.message || e) }, { status: 502 });
    } finally {
        clearTimeout(timer);
    }
}
