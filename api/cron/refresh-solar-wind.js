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
 * supabase-solar-wind-cron-handoff.sql (cadence reduced at handoff,
 * unschedule once this cron's heartbeats are visible in
 * pipeline_heartbeat).
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

    try {
        const [wind, mag] = await Promise.all([
            getJson(NOAA_WIND_URL),
            getJson(NOAA_MAG_URL).catch((e) => { notes.push(`rtsw-mag:${e.message}`); return []; }),
        ]);
        if (Array.isArray(wind) && wind.length) {
            data = extractRTSW(wind, Array.isArray(mag) ? mag : []);
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

    // 2) Validate the chosen sample.
    if (!data) {
        if (!dryRun) await recordFailure(`no valid sample (${notes.join('; ').slice(0, 400)})`);
        return jsonResp({ error: 'no_valid_sample', notes }, 502);
    }
    if (!Number.isFinite(Date.parse(data.observedAt))) {
        if (!dryRun) await recordFailure(`unparseable time_tag: ${data.observedAt}`);
        return jsonResp({ error: 'bad_time_tag', observed_at: data.observedAt }, 502);
    }
    if (isStale(data)) {
        if (!dryRun) await recordFailure(`stale feed: latest valid sample ${data.observedAt} (${feed})`);
        return jsonResp({ error: 'stale', observed_at: data.observedAt, feed, notes }, 502);
    }

    const sample = {
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

    if (dryRun) return jsonResp({ ok: true, dryRun: true, feed, notes, sample });

    // 3) One-row write. Validation (±10 min window, 100–3000 km/s) lives
    //    in the SECURITY DEFINER RPC; id is null on same-minute dedup.
    let insertedId;
    try {
        insertedId = await rpc('record_solar_wind_sample', sample);
    } catch (e) {
        await recordFailure(`record_solar_wind_sample failed: ${e.message}`);
        return jsonResp({ error: 'rpc_failed', detail: e.message }, 502);
    }

    // 4) Hourly ring-buffer trim (was every minute under pg_cron).
    let trimmed = false;
    if (new Date().getUTCMinutes() === 0) {
        try { await rpc('trim_solar_wind_samples', {}); trimmed = true; }
        catch { /* next hour catches up; the 7-day window makes lag harmless */ }
    }

    // 5) Heartbeat (best-effort — the sample is already committed).
    try { await rpc('record_pipeline_success', { p_name: PIPELINE, p_source: SOURCE_TAG }); }
    catch { /* swallow */ }

    return jsonResp({ ok: true, id: insertedId, observed_at: data.observedAt, feed, deduped: insertedId == null, trimmed });
}
