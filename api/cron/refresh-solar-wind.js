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

const NOAA_WIND_URL = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json';
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

// ── Handler ───────────────────────────────────────────────────────────
export default async function handler(req) {
    if (!isAuthorized(req)) return jsonResp({ error: 'unauthorized' }, 401);
    if (!SUPABASE_URL || !SUPABASE_KEY) return jsonResp({ error: 'supabase_not_configured' }, 500);

    const dryRun = new URL(req.url).searchParams.get('dry') === '1';

    // 1) Fetch the NOAA feed.
    let rows;
    try {
        const res = await fetchWithTimeout(NOAA_WIND_URL, {
            timeoutMs: 10_000,
            headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`NOAA HTTP ${res.status}`);
        rows = await res.json();
    } catch (e) {
        if (!dryRun) await recordFailure(`NOAA fetch failed: ${e.message}`);
        return jsonResp({ error: 'noaa_fetch_failed', detail: e.message }, 502);
    }

    if (!Array.isArray(rows) || rows.length === 0) {
        if (!dryRun) await recordFailure('NOAA payload not a non-empty array');
        return jsonResp({ error: 'noaa_bad_payload' }, 502);
    }

    // 2) Latest valid sample.
    const picked = pickLatestValid(rows);
    if (!picked) {
        if (!dryRun) await recordFailure('no valid speed in NOAA payload');
        return jsonResp({ error: 'noaa_all_fill' }, 502);
    }

    // NOAA time_tag is "YYYY-MM-DD HH:MM:SS.ms" (space separator, no tz).
    const observedAt = String(picked.row.time_tag || '').replace(' ', 'T').replace(/Z?$/, 'Z');
    const observedMs = Date.parse(observedAt);
    if (!Number.isFinite(observedMs)) {
        if (!dryRun) await recordFailure(`unparseable time_tag: ${picked.row.time_tag}`);
        return jsonResp({ error: 'noaa_bad_time_tag' }, 502);
    }
    if (Date.now() - observedMs > MAX_SAMPLE_AGE_MS) {
        if (!dryRun) await recordFailure(`stale feed: latest valid sample ${observedAt}`);
        return jsonResp({ error: 'noaa_stale', observed_at: observedAt }, 502);
    }

    const sample = {
        p_observed_at:   observedAt,
        p_source:        SOURCE_TAG,
        p_speed_km_s:    picked.speed,
        p_density_cc:    cleanField(picked.row, 'proton_density', 'density'),
        p_temperature_k: cleanField(picked.row, 'proton_temperature', 'temperature'),
        p_bt_nt:         cleanField(picked.row, 'bt'),
        p_bz_nt:         cleanField(picked.row, 'bz_gsm', 'bz'),
        p_bx_nt:         cleanField(picked.row, 'bx_gsm', 'bx'),
        p_by_nt:         cleanField(picked.row, 'by_gsm', 'by'),
    };

    if (dryRun) return jsonResp({ ok: true, dryRun: true, sample });

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

    return jsonResp({ ok: true, id: insertedId, observed_at: observedAt, deduped: insertedId == null, trimmed });
}
