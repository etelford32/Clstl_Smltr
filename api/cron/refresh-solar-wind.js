/**
 * Vercel Edge Cron: /api/cron/refresh-solar-wind   (every minute)
 *
 * Serverless replacement for the in-database pg_cron job
 * ('refresh-solar-wind' → public.refresh_solar_wind()). That function
 * ran http_get() on NOAA's full-day rtsw_wind_1m.json (~1–2 MB) INSIDE
 * a Postgres backend every minute and parsed the whole thing into
 * jsonb just to insert one row. At the time of this handoff it was the
 * dominant load on the (1 GB) Supabase instance — pg_stat_statements
 * showed 73,889 calls, 12,358 s of execution and ~72.7M shared-block
 * accesses, far beyond everything else combined — and the primary
 * driver of the dashboard's memory warnings. The fetch + parse now
 * happens here; the database only sees one record_solar_wind_sample()
 * RPC carrying a single row.
 *
 * Pipeline contract preserved (do not change casually):
 *   - source tag stays 'noaa-swpc' so rows written here dedupe against
 *     any remaining pg_cron writes during cutover via the
 *     UNIQUE (observed_at, source) constraint,
 *   - record_pipeline_success/_failure('solar_wind', ...) heartbeats
 *     keep api/cron/pipeline-watchdog.js semantics (3 consecutive
 *     failures ≈ 3 minutes → alert email),
 *   - trim_solar_wind_samples() (7-day ring buffer) runs once an hour
 *     here instead of every minute — the lag is bounded (~60 extra
 *     rows) and saves 59 DELETE round-trips an hour.
 *
 * Sample-selection logic is a 1:1 port of the SQL function: walk the
 * NOAA array backwards past trailing fill rows to the newest entry
 * with a valid positive speed, with proton-prefixed / plain field-name
 * fallbacks and the -9990 / 1e20 fill-sentinel filter.
 *
 * Decommission of the pg_cron job: see
 * supabase-solar-wind-cron-handoff.sql — Step 2 (cron.unschedule) was
 * executed 2026-07-10; public.refresh_solar_wind() remains as a manual
 * fallback only.
 *
 * ── Enrichment duties (2026-07, zero added fetch cost) ───────────────
 * The full-day wind/mag files fetched every minute carry ~1440 rows we
 * previously discarded. This cron now also (see
 * supabase-solar-wind-enrichment-migration.sql):
 *   - minute 0:      batch-backfills the merged 24 h series via
 *                    record_solar_wind_backfill() — outage holes
 *                    self-heal; existing non-null values never change.
 *   - any minute:    if plasma is stale everywhere but the magnetometer
 *                    is fresh, writes a MAG-ONLY row (speed null) so Bz
 *                    — the ring-current driver — keeps flowing
 *                    (2026-07-09/10: plasma fill-only for 24 h while
 *                    mag stayed live; that Bz hole was avoidable).
 *   - minute %15==5: upserts observed Kyoto Dst (hourly) + Kp into
 *                    geomag_indices, and logs the O'Brien–McPherron
 *                    model nowcast into ring_current_log using the SAME
 *                    js/ring-current-model.js the page runs — the
 *                    persistent skill ledger.
 *
 * ── Auth ─────────────────────────────────────────────────────────────
 *   Vercel Cron sends `x-vercel-cron: 1`; when CRON_SECRET is set it
 *   also sends `Authorization: Bearer <secret>`. We accept either.
 *   Manual runs must carry the Bearer secret.
 *
 * ── Env ──────────────────────────────────────────────────────────────
 *   SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_KEY (or SUPABASE_SECRET_KEY) — service_role
 *   CRON_SECRET (optional but recommended)
 *
 * ── Manual / dry-run ─────────────────────────────────────────────────
 *   GET /api/cron/refresh-solar-wind?dry=1   → fetch + parse, no writes
 */

import { fetchWithTimeout } from '../_lib/responses.js';
// Physics shared with the Ring Current Simulation page — the SAME module the
// browser runs (dependency-free ESM, bundled into this function at build).
import { integrateDst, propagateToEarth, dpsEnergyJ } from '../../js/ring-current-model.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';

// RTSW real-time feeds. Plasma (speed/density/temperature) and the IMF
// (bt/bz/bx/by) live in SEPARATE products — rtsw_wind_1m.json is plasma-ONLY.
// Fetching only the wind feed is why bz_nt/bt_nt were null for every row
// (cleanField(row,'bz_gsm') never matched a key). See js/swpc-feed.js and
// js/auroracle.js, which already fetch the mag product separately.
const NOAA_WIND_URL = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json';
const NOAA_MAG_URL  = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json';

// Fallback, used only when the RTSW feed is stale or unavailable (RTSW
// periodically gaps for tens of minutes to hours; on 2026-07-10 its plasma
// went fill-only for a full day while SWPC's propagated feed stayed live).
//
// WARNING: the whole products/solar-wind/ directory (plasma-2-hour.json,
// mag-*.json, …) is RETIRED at NOAA — every variant 404s (verified live
// 2026-07-10, same retirement wave as the 45-day text product that killed
// the aurora_outlook cron; see api/_lib/ap45.js). Do not "restore" those
// URLs. The geospace propagated feed below is the supported replacement:
// one product carrying plasma AND IMF, source-switched by SWPC between
// DSCOVR/ACE, ~1-min cadence over the trailing hour. Shape is
// [ [header...], [row,row...] ] — normalised to objects before the shared
// cleanField()/pick logic runs. Its time_tag is the L1 observation time
// (propagated_time_tag is Earth arrival), matching RTSW semantics for the
// dedup/staleness contract.
const PROPAGATED_URL = 'https://services.swpc.noaa.gov/products/geospace/propagated-solar-wind-1-hour.json';

// Observed geomagnetic indices, fetched every 15th minute (small files,
// piggybacked on this cron — no new cron entries; see vercel.json note).
// Written to geomag_indices; the Dst record outlives NOAA's rolling 1-day
// window, which is what makes a persistent model-skill ledger possible.
const NOAA_DST_URL = 'https://services.swpc.noaa.gov/products/kyoto-dst.json';
const NOAA_KP_URL  = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';

const SOURCE_TAG    = 'noaa-swpc';
const PIPELINE      = 'solar_wind';

// record_solar_wind_sample() rejects observed_at more than 10 minutes
// old. Catch staleness slightly earlier so the heartbeat failure reason
// says "stale feed" instead of a generic RPC bounds error.
const MAX_SAMPLE_AGE_MS = 9.5 * 60 * 1000;

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

// ── Service-role RPC helper ────────────────────────────────────────────
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

async function recordFailure(reason) {
    try { await rpc('record_pipeline_failure', { p_name: PIPELINE, p_reason: reason.slice(0, 500) }); }
    catch { /* heartbeat is best-effort; the cron response still reports the error */ }
}

// NOAA fill sentinels: -9999-ish for missing, absurdly large for overflow.
function cleanField(row, ...keys) {
    for (const key of keys) {
        const raw = row?.[key];
        if (raw == null || raw === '') continue;
        const n = Number(raw);
        if (!Number.isFinite(n)) continue;
        if (n <= -9990 || n > 1e20) return null;
        return n;
    }
    return null;
}

// Walk backwards from the newest row until we find one with a valid,
// positive speed (NOAA sometimes trails a few fill rows at the end).
function pickLatestValid(rows) {
    for (let i = rows.length - 1; i >= 0; i--) {
        const speed = cleanField(rows[i], 'proton_speed', 'speed');
        if (speed != null && speed > 0) return { row: rows[i], speed };
    }
    return null;
}

// Walk backwards for the newest MAG row carrying a usable field value.
function pickLatestValidMag(rows) {
    if (!Array.isArray(rows)) return null;
    for (let i = rows.length - 1; i >= 0; i--) {
        const bt = cleanField(rows[i], 'bt');
        const bz = cleanField(rows[i], 'bz_gsm', 'bz', 'bz_gse');
        if (bt != null || bz != null) return rows[i];
    }
    return null;
}

// NOAA "products/solar-wind" arrays are [ [header], [row], ... ]; turn them
// into plain objects so the same cleanField()/pick helpers apply.
function rowsFromProduct(arr) {
    if (!Array.isArray(arr) || arr.length < 2) return [];
    const head = arr[0];
    return arr.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

function normTime(t) {
    return String(t || '').replace(' ', 'T').replace(/Z?$/, 'Z');
}

async function getJson(url, timeoutMs = 10_000) {
    const res = await fetchWithTimeout(url, { timeoutMs, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// Build a normalised sample {observedAt, speed, density, temperature, bt,bz,bx,by}
// from the RTSW plasma + mag feeds. Mag is best-effort: if it is missing the
// plasma sample still writes (Bz simply stays null, i.e. no regression).
function extractRTSW(windRows, magRows) {
    const plasma = pickLatestValid(windRows);
    if (!plasma) return null;
    const mag = pickLatestValidMag(magRows);
    return {
        observedAt:  normTime(plasma.row.time_tag),
        speed:       plasma.speed,
        density:     cleanField(plasma.row, 'proton_density', 'density'),
        temperature: cleanField(plasma.row, 'proton_temperature', 'temperature'),
        bt: mag ? cleanField(mag, 'bt') : null,
        bz: mag ? cleanField(mag, 'bz_gsm', 'bz', 'bz_gse') : null,
        bx: mag ? cleanField(mag, 'bx_gsm', 'bx') : null,
        by: mag ? cleanField(mag, 'by_gsm', 'by') : null,
    };
}

// Same normalised shape from the geospace propagated fallback feed. One
// product carries both plasma and IMF per row; if the newest valid-speed
// row happens to have null mag cells, walk back for the newest valid mag.
function extractPropagated(arr) {
    const rows = rowsFromProduct(arr);
    if (!rows.length) return null;
    let plasma = null;
    for (let i = rows.length - 1; i >= 0; i--) {
        const speed = cleanField(rows[i], 'speed');
        if (speed != null && speed > 0) { plasma = { row: rows[i], speed }; break; }
    }
    if (!plasma) return null;
    const mag = pickLatestValidMag(rows);
    return {
        observedAt:  normTime(plasma.row.time_tag),
        speed:       plasma.speed,
        density:     cleanField(plasma.row, 'density'),
        temperature: cleanField(plasma.row, 'temperature'),
        bt: mag ? cleanField(mag, 'bt') : null,
        bz: mag ? cleanField(mag, 'bz_gsm', 'bz') : null,
        bx: mag ? cleanField(mag, 'bx_gsm', 'bx') : null,
        by: mag ? cleanField(mag, 'by_gsm', 'by') : null,
    };
}

function isStale(sample) {
    const ms = Date.parse(sample.observedAt);
    return !Number.isFinite(ms) || (Date.now() - ms > MAX_SAMPLE_AGE_MS);
}

// ── Enrichment helpers (exported for tests/refresh-solar-wind-helpers.mjs) ──

const minuteKey = (ms) => Math.floor(ms / 60_000) * 60_000;

/**
 * Join the full-day RTSW plasma + mag payloads into one ascending 1-min
 * series [{t, v, n, temp, bt, bz, bx, by}] keyed on the UTC minute. Unlike
 * the current-minute extractors, MAG-ONLY minutes are kept (v null) — during
 * plasma outages the magnetometer keeps flowing and Bz is the ring-current
 * driver we must not lose. Rows carrying nothing are dropped.
 */
export function mergeMinuteSeries(windRows, magRows) {
    const byMin = new Map();
    for (const r of Array.isArray(windRows) ? windRows : []) {
        const t = Date.parse(normTime(r?.time_tag));
        if (!Number.isFinite(t)) continue;
        const v = cleanField(r, 'proton_speed', 'speed');
        if (v == null || v <= 0) continue;
        byMin.set(minuteKey(t), {
            t: minuteKey(t), v,
            n:    cleanField(r, 'proton_density', 'density'),
            temp: cleanField(r, 'proton_temperature', 'temperature'),
            bt: null, bz: null, bx: null, by: null,
        });
    }
    for (const r of Array.isArray(magRows) ? magRows : []) {
        const t = Date.parse(normTime(r?.time_tag));
        if (!Number.isFinite(t)) continue;
        const bz = cleanField(r, 'bz_gsm', 'bz', 'bz_gse');
        const bt = cleanField(r, 'bt');
        if (bz == null && bt == null) continue;
        const key = minuteKey(t);
        const row = byMin.get(key) ??
            { t: key, v: null, n: null, temp: null, bt: null, bz: null, bx: null, by: null };
        row.bz = bz;
        row.bt = bt;
        row.bx = cleanField(r, 'bx_gsm', 'bx');
        row.by = cleanField(r, 'by_gsm', 'by');
        byMin.set(key, row);
    }
    return [...byMin.values()].sort((a, b) => a.t - b.t);
}

/** Newest series row with usable IMF within the freshness window, or null. */
export function pickFreshMagOnly(series, nowMs = Date.now(), maxAgeMs = MAX_SAMPLE_AGE_MS) {
    for (let i = series.length - 1; i >= 0; i--) {
        const r = series[i];
        if (nowMs - r.t > maxAgeMs) return null;
        if (r.bz != null || r.bt != null) return r;
    }
    return null;
}

/**
 * kyoto-dst.json → ascending [{t, dst}], ONE value per UTC hour (the product
 * repeats the provisional hourly value at minute cadence — keep the last per
 * hour). Handles object rows and the 2-D header-row form, |dst| > 1000 fill
 * dropped — mirrors api/noaa/dst.js.
 */
export function parseKyotoHourly(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const fill = (x) => {
        const n = Number(x);
        return !Number.isFinite(n) || Math.abs(n) > 1000 ? null : n;
    };
    let rows;
    if (typeof raw[0] === 'object' && !Array.isArray(raw[0])) {
        rows = raw.map(r => ({ t: Date.parse(normTime(r?.time_tag)), dst: fill(r?.dst ?? r?.dst_index) }));
    } else {
        const head = raw[0].map(String);
        const ti = head.indexOf('time_tag'), di = head.indexOf('dst');
        rows = raw.slice(1).map(r => ({ t: Date.parse(normTime(r?.[ti])), dst: fill(r?.[di]) }));
    }
    const byHour = new Map();
    for (const r of rows) {
        if (!Number.isFinite(r.t) || r.dst == null) continue;
        byHour.set(Math.floor(r.t / 3.6e6) * 3.6e6, r.dst);
    }
    return [...byHour.entries()].map(([t, dst]) => ({ t, dst })).sort((a, b) => a.t - b.t);
}

/** Linear interpolation of [{t, dst}] at time t, clamped at the ends. */
export function interpDstAt(series, t) {
    if (!Array.isArray(series) || !series.length) return null;
    if (t <= series[0].t) return series[0].dst;
    for (let i = 1; i < series.length; i++) {
        if (series[i].t >= t) {
            const a = series[i - 1], b = series[i];
            const f = (t - a.t) / Math.max(1, b.t - a.t);
            return a.dst + f * (b.dst - a.dst);
        }
    }
    return series[series.length - 1].dst;
}

// ── Service-role PostgREST upsert (geomag_indices / ring_current_log are
//    RLS-zero-policy tables — the service key bypasses RLS by design). ──────
async function upsertRows(table, rows, onConflict) {
    if (!rows.length) return;
    const res = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
        method: 'POST',
        timeoutMs: 8_000,
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(rows),
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`upsert ${table} HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
}

// ── Handler ───────────────────────────────────────────────────────────
export default async function handler(req) {
    if (!isAuthorized(req)) return jsonResp({ error: 'unauthorized' }, 401);
    if (!SUPABASE_URL || !SUPABASE_KEY) return jsonResp({ error: 'supabase_not_configured' }, 500);

    const dryRun = new URL(req.url).searchParams.get('dry') === '1';

    // 1) Primary source: RTSW plasma + mag (mag is best-effort — if it fails,
    //    plasma still writes and Bz stays null, i.e. no regression vs. before).
    //    Fall back to the geospace propagated feed when RTSW is missing or stale,
    //    so a NOAA RTSW gap no longer freezes ingestion.
    let data = null;
    let feed = 'rtsw';
    const notes = [];
    let windRows = [], magRows = [];   // retained: the enrichment branches
                                       // reuse these already-paid-for payloads

    try {
        const [wind, mag] = await Promise.all([
            getJson(NOAA_WIND_URL),
            getJson(NOAA_MAG_URL).catch((e) => { notes.push(`rtsw-mag:${e.message}`); return []; }),
        ]);
        windRows = Array.isArray(wind) ? wind : [];
        magRows  = Array.isArray(mag)  ? mag  : [];
        if (windRows.length) {
            data = extractRTSW(windRows, magRows);
        } else {
            notes.push('rtsw-wind payload empty');
        }
    } catch (e) {
        notes.push(`rtsw-wind:${e.message}`);
    }

    if (!data || isStale(data)) {
        try {
            const alt = extractPropagated(await getJson(PROPAGATED_URL));
            if (alt && !isStale(alt)) { data = alt; feed = 'geospace-propagated'; }
            else if (alt) notes.push('geospace-propagated also stale');
        } catch (e) {
            notes.push(`geospace-propagated:${e.message}`);
        }
    }

    // The full-day 1-min series (mag-only minutes included) drives the
    // mag-only last resort, the hourly backfill, and the 15-min model run.
    const series = mergeMinuteSeries(windRows, magRows);

    // 1b) Last resort before failing: plasma is stale everywhere but the
    //     magnetometer is fresh (exactly the 2026-07-09/10 outage shape).
    //     Write a MAG-ONLY row via the backfill RPC (speed null) so Bz —
    //     the ring-current driver — keeps flowing. Counts as pipeline
    //     success: data IS being delivered; `mode` says which kind.
    let magOnly = null;
    if (!data || isStale(data)) {
        magOnly = pickFreshMagOnly(series);
        if (magOnly) {
            if (data) notes.push(`plasma stale since ${data.observedAt}`);
            feed = 'rtsw-mag-only';
        }
    }

    // 2) Validate the chosen sample.
    if (!data && !magOnly) {
        if (!dryRun) await recordFailure(`no valid sample (${notes.join('; ').slice(0, 400)})`);
        return jsonResp({ error: 'no_valid_sample', notes }, 502);
    }
    if (!magOnly) {
        if (!Number.isFinite(Date.parse(data.observedAt))) {
            if (!dryRun) await recordFailure(`unparseable time_tag: ${data.observedAt}`);
            return jsonResp({ error: 'bad_time_tag', observed_at: data.observedAt }, 502);
        }
        if (isStale(data)) {
            if (!dryRun) await recordFailure(`stale feed: latest valid sample ${data.observedAt} (${feed})`);
            return jsonResp({ error: 'stale', observed_at: data.observedAt, feed, notes }, 502);
        }
    }

    const observedAt = magOnly ? new Date(magOnly.t).toISOString() : data.observedAt;
    const sample = magOnly ? null : {
        p_observed_at:   data.observedAt,
        p_source:        SOURCE_TAG,
        p_speed_km_s:    data.speed,
        p_density_cc:    data.density,
        p_temperature_k: data.temperature,
        p_bt_nt:         data.bt,
        p_bz_nt:         data.bz,
        p_bx_nt:         data.bx,
        p_by_nt:         data.by,
    };

    if (dryRun) {
        return jsonResp({
            ok: true, dryRun: true, feed, notes, sample, magOnly,
            seriesRows: series.length,
        });
    }

    // 3) One-row write. Full samples go through record_solar_wind_sample
    //    (pipeline contract: ±10 min window + 100–3000 km/s validation, id
    //    null on same-minute dedup). Mag-only rows go through the backfill
    //    RPC — the ONLY write path that permits speed IS NULL.
    let insertedId = null;
    try {
        if (magOnly) {
            await rpc('record_solar_wind_backfill', {
                p_rows: [{
                    t: observedAt,
                    v: null, n: null, temp: null,
                    bt: magOnly.bt, bz: magOnly.bz, bx: magOnly.bx, by: magOnly.by,
                }],
                p_source: SOURCE_TAG,
            });
        } else {
            insertedId = await rpc('record_solar_wind_sample', sample);
        }
    } catch (e) {
        await recordFailure(`${magOnly ? 'record_solar_wind_backfill' : 'record_solar_wind_sample'} failed: ${e.message}`);
        return jsonResp({ error: 'rpc_failed', detail: e.message }, 502);
    }

    const minute = new Date().getUTCMinutes();

    // 4) Hourly: ring-buffer trims + FULL-DAY BACKFILL. The wind/mag files
    //    fetched above already contain the trailing 24 h — one batched RPC
    //    fills any holes left by outages or missed ticks (idempotent: the
    //    RPC only fills NULLs, never overwrites). Same fetch, more data.
    let trimmed = false, backfilled = null;
    if (minute === 0) {
        try { await rpc('trim_solar_wind_samples', {}); trimmed = true; }
        catch { /* next hour catches up; the 7-day window makes lag harmless */ }
        try { await rpc('trim_solar_wind_enrichment', {}); }
        catch { /* same: retention lag is harmless */ }
        try {
            const batch = series.slice(-1440).map(r => ({
                t: new Date(r.t).toISOString(),
                v: r.v, n: r.n, temp: r.temp, bt: r.bt, bz: r.bz, bx: r.bx, by: r.by,
            }));
            if (batch.length) {
                backfilled = await rpc('record_solar_wind_backfill', { p_rows: batch, p_source: SOURCE_TAG });
            }
        } catch (e) {
            notes.push(`backfill:${e.message}`);
        }
    }

    // 5) Every 15 min (offset from the minute-0 burst): observed indices +
    //    model nowcast ledger — RING_CURRENT_SIMULATION_PLAN.md Phase 2.
    let indices = null, modelLogged = false;
    if (minute % 15 === 5) {
        let dstSeries = [];
        try {
            dstSeries = parseKyotoHourly(await getJson(NOAA_DST_URL));
            const cutoff = Date.now() - 26 * 3.6e6;
            const rows = dstSeries.filter(r => r.t >= cutoff).map(r => ({
                kind: 'dst', t: new Date(r.t).toISOString(), value: r.dst, source: 'kyoto-wdc',
            }));
            await upsertRows('geomag_indices', rows, 'kind,t');
            indices = { dst: rows.length };
        } catch (e) {
            notes.push(`dst:${e.message}`);
        }
        try {
            const kpRaw = await getJson(NOAA_KP_URL);
            let kp = null, kpT = null;
            for (let i = (Array.isArray(kpRaw) ? kpRaw.length : 0) - 1; i >= 0; i--) {
                const v = cleanField(kpRaw[i], 'estimated_kp', 'kp_index', 'kp');
                if (v != null && v >= 0 && v <= 9) {
                    kp = v; kpT = Date.parse(normTime(kpRaw[i].time_tag)); break;
                }
            }
            if (kp != null && Number.isFinite(kpT)) {
                await upsertRows('geomag_indices',
                    [{ kind: 'kp', t: new Date(kpT).toISOString(), value: kp, source: 'noaa-swpc' }], 'kind,t');
                indices = { ...(indices || {}), kp };
            }
        } catch (e) {
            notes.push(`kp:${e.message}`);
        }

        // Model nowcast: ballistically propagate the L1 series to Earth
        // arrival, anchor ONCE on observed Dst at the window start, free-run
        // O'Brien–McPherron to now, log the state. Joined against
        // geomag_indices later, this is the continuously-measured skill
        // record. Pure compute — no extra fetches.
        try {
            if (dstSeries.length && series.length > 10) {
                const drivers = propagateToEarth(series)
                    .map(s => ({ t: s.tArrive, v: s.v, n: s.n, bz: s.bz }));
                const anchorT = drivers[0].t;
                const anchorDst = interpDstAt(dstSeries, anchorT);
                const track = integrateDst(drivers, anchorDst);
                const nowPt = track.filter(p => p.t <= Date.now()).pop();
                if (nowPt) {
                    await upsertRows('ring_current_log', [{
                        t: new Date(minuteKey(Date.now())).toISOString(),
                        dst_model: nowPt.dst, dst_star: nowPt.dstStar,
                        vbs: nowPt.vbs, pdyn: nowPt.pdyn,
                        energy_j: dpsEnergyJ(nowPt.dstStar),
                        anchor_t: new Date(anchorT).toISOString(),
                        anchor_dst: anchorDst, feed,
                    }], 't');
                    modelLogged = true;
                }
            }
        } catch (e) {
            notes.push(`model:${e.message}`);
        }
    }

    // 6) Heartbeat (best-effort — the sample is already committed).
    try { await rpc('record_pipeline_success', { p_name: PIPELINE, p_source: SOURCE_TAG }); }
    catch { /* swallow */ }

    return jsonResp({
        ok: true, id: insertedId, observed_at: observedAt, feed,
        mode: magOnly ? 'mag_only' : 'full',
        deduped: !magOnly && insertedId == null,
        trimmed, backfilled, indices, modelLogged,
        ...(notes.length ? { notes } : {}),
    });
}
