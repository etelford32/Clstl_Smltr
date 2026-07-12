/**
 * Vercel Cron: /api/cron/sync-dataset — every 10 minutes (vercel.json)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Builds the SYNCHRONIZED solar-wind ↔ geomagnetic minute dataset
 * (public.sw_geomag_dataset): one row per UTC minute — L1 plasma/IMF
 * alongside Kp, ap (derived, labeled), Kyoto Dst and the GOES ≥2 MeV
 * electron flux, each with native timestamp, source tag and an explicit
 * ok/held/gap flag. Absence is recorded, never implied: minutes with no
 * data still get rows, flagged 'gap'. All semantics live in
 * api/_lib/sync-dataset-core.js (node-tested) — this file only fetches,
 * windows, upserts, and heartbeats.
 *
 * ── Self-healing window ────────────────────────────────────────────────────
 * Each run rebuilds the trailing 3 h of minutes idempotently (PK upsert),
 * so missed ticks ≤3 h leave no scar. The first run of each UTC day (or
 * ?deep=1) rebuilds 24 h — the depth limit of the source feeds — and rings
 * the archive via trim_sw_geomag_dataset() (180-day retention; deeper
 * history lives in omni_hourly).
 *
 * ── Raw-side archive ───────────────────────────────────────────────────────
 * Native-cadence ≥2 MeV electron rows also land in geomag_indices
 * (kind 'e2_mev') — NOAA's 1-day file rolls off; the archive doesn't.
 * Dst/Kp raw archiving already happens in refresh-solar-wind.
 *
 * ── Failure posture ────────────────────────────────────────────────────────
 * Individual feed failures degrade to gap flags (that IS the dataset's
 * honesty mechanism). Only all-feeds-down or a write failure marks the
 * sync_dataset heartbeat as failed (pipeline-watchdog picks streaks up).
 *
 * ── Auth / env / query ─────────────────────────────────────────────────────
 *   x-vercel-cron header, or Authorization: Bearer CRON_SECRET
 *   SUPABASE_URL(+NEXT_PUBLIC_), SUPABASE_SERVICE_KEY(+SECRET), CRON_SECRET
 *   ?dry=1   compute + report, write nothing
 *   ?deep=1  force the 24-h window
 */

import { fetchWithTimeout } from '../_lib/responses.js';
import { mergeMinuteSeries, parseKyotoHourly } from './refresh-solar-wind.js';
import {
    MINUTE_MS, minuteKey,
    parseKp1m, parseKp3h, parseGoesElectrons,
    buildMinuteRows, gapSummary,
} from '../_lib/sync-dataset-core.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';

const URLS = Object.freeze({
    wind: 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json',
    mag:  'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json',
    dst:  'https://services.swpc.noaa.gov/products/kyoto-dst.json',
    kp1m: 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',
    kp3h: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
    e2:   'https://services.swpc.noaa.gov/json/goes/primary/integral-electrons-1-day.json',
});

const PIPELINE        = 'sync_dataset';
const WINDOW_MIN      = 180;
const DEEP_WINDOW_MIN = 24 * 60;
const KEEP_DAYS       = 180;
const UPSERT_CHUNK    = 500;

function isAuthorized(req) {
    const hdr = req.headers.get('authorization') || '';
    if (CRON_SECRET && hdr === `Bearer ${CRON_SECRET}`) return true;
    if (req.headers.get('x-vercel-cron')) return true;
    return false;
}

function jsonResp(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}

async function rpc(name, args) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
        method: 'POST',
        timeoutMs: 8_000,
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(args || {}),
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`rpc ${name} HTTP ${res.status}: ${t.slice(0, 240)}`);
    }
    return res.json().catch(() => null);
}

async function upsertRows(table, rows, onConflict) {
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const res = await fetchWithTimeout(
            `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
            method: 'POST',
            timeoutMs: 10_000,
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                Prefer: 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify(rows.slice(i, i + UPSERT_CHUNK)),
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`upsert ${table} HTTP ${res.status}: ${t.slice(0, 200)}`);
        }
    }
}

async function getJson(url, timeoutMs = 10_000) {
    const res = await fetchWithTimeout(url, { timeoutMs, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

export default async function handler(req) {
    const started = Date.now();
    if (!isAuthorized(req)) return jsonResp({ ok: false, error: 'unauthorized' }, 401);
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return jsonResp({ ok: false, error: 'missing SUPABASE_URL / SUPABASE_SERVICE_KEY' }, 500);
    }
    const url = new URL(req.url);
    const dry = url.searchParams.get('dry') === '1';
    const nowUtc = new Date();
    const deep = url.searchParams.get('deep') === '1' ||
        (nowUtc.getUTCHours() === 0 && nowUtc.getUTCMinutes() < 10);

    // ── Fetch (each feed individually best-effort — a missing feed becomes
    //    gap flags, which is the dataset's honesty mechanism, not an error) ──
    const feedErrors = {};
    const grab = (key) => getJson(URLS[key]).catch((e) => {
        feedErrors[key] = String(e?.message ?? e).slice(0, 120);
        return null;
    });
    const [wind, mag, dstRaw, kp1mRaw, kp3hRaw, e2Raw] = await Promise.all([
        grab('wind'), grab('mag'), grab('dst'), grab('kp1m'), grab('kp3h'), grab('e2'),
    ]);
    if (Object.keys(feedErrors).length === 6) {
        try { await rpc('record_pipeline_failure', { p_name: PIPELINE, p_reason: `all feeds down: ${JSON.stringify(feedErrors).slice(0, 400)}` }); }
        catch { /* heartbeat best-effort */ }
        return jsonResp({ ok: false, error: 'all upstream feeds unreachable', feedErrors }, 502);
    }

    // ── Build the minute rows ───────────────────────────────────────────────
    const windowMin = deep ? DEEP_WINDOW_MIN : WINDOW_MIN;
    const t1 = minuteKey(Date.now());               // current minute may still fill
    const t0 = t1 - windowMin * MINUTE_MS;
    const e2Series = parseGoesElectrons(e2Raw);
    const rows = buildMinuteRows(t0, t1, {
        sw: mergeMinuteSeries(wind ?? [], mag ?? []),
        swSource: 'rtsw',
        dst: parseKyotoHourly(dstRaw),
        kp1m: parseKp1m(kp1mRaw),
        kp3h: parseKp3h(kp3hRaw),
        e2: e2Series,
    });
    const gaps = gapSummary(rows);

    // Raw-side archive: native-cadence e2 rows (NOAA's file rolls off daily).
    const e2ArchiveRows = e2Series
        .filter(r => r.t >= t0 && r.t < t1)
        .map(r => ({
            kind: 'e2_mev',
            t: new Date(r.t).toISOString(),
            value: r.flux,
            source: 'noaa-swpc goes-primary',
        }));

    if (dry) {
        return jsonResp({
            ok: true, dry: true, deep,
            window: { start: new Date(t0).toISOString(), end: new Date(t1).toISOString(), minutes: rows.length },
            gaps, e2_raw_rows: e2ArchiveRows.length, feedErrors,
            dur_ms: Date.now() - started,
        });
    }

    // ── Write ───────────────────────────────────────────────────────────────
    let trimmed = null;
    try {
        await upsertRows('sw_geomag_dataset', rows, 't');
        if (e2ArchiveRows.length) await upsertRows('geomag_indices', e2ArchiveRows, 'kind,t');
        if (deep) {
            try { trimmed = await rpc('trim_sw_geomag_dataset', { p_keep_days: KEEP_DAYS }); }
            catch (e) { feedErrors.trim = String(e?.message ?? e).slice(0, 120); }
        }
    } catch (e) {
        const reason = String(e?.message ?? e).slice(0, 500);
        try { await rpc('record_pipeline_failure', { p_name: PIPELINE, p_reason: reason }); }
        catch { /* heartbeat best-effort */ }
        return jsonResp({ ok: false, error: reason, feedErrors }, 502);
    }
    try { await rpc('record_pipeline_success', { p_name: PIPELINE, p_source: 'noaa-swpc multi-feed' }); }
    catch { /* heartbeat best-effort */ }

    return jsonResp({
        ok: true, deep,
        window: { start: new Date(t0).toISOString(), end: new Date(t1).toISOString(), minutes: rows.length },
        gaps, e2_raw_rows: e2ArchiveRows.length,
        trimmed,
        feedErrors: Object.keys(feedErrors).length ? feedErrors : undefined,
        dur_ms: Date.now() - started,
    });
}
