/**
 * Vercel Cron: /api/cron/refresh-solar-wind
 *
 * Pulls NOAA SWPC RTSW (real-time solar wind) plasma + mag samples,
 * picks the most-recent matching pair, and writes a row into the
 * Supabase `solar_wind_samples` ring buffer via the SECURITY DEFINER
 * RPC `record_solar_wind_sample`.
 *
 * Why this exists
 * ──────────────
 * The browser-direct write-through path
 * (`js/wind-pipeline-feed.js` → `POST /api/solar-wind/ingest`) only
 * fires when a user is actively visiting a wind-enabled page. The
 * status panel on /status surfaced the consequence:
 *
 *   Solar Wind heartbeat:   1m ago     ← someone was just on the page
 *   solar_wind_samples:     1d ago     ← but reads are 1 day stale
 *
 * That gap is the period nobody had the page open. An hourly visitor
 * spike then sees a blank ring buffer, which manifests as Earth's
 * Solar Wind card going dark on first paint.
 *
 * This cron closes the loop: every ~2 minutes (NOAA RTSW publish
 * cadence is 1 min; 2 min smooths out the publish jitter while
 * staying cheap) we fetch upstream, write a single row, and update
 * `pipeline_heartbeat`. Browser ingests still run when users are
 * online — they harmlessly deduplicate via the table's
 * UNIQUE (observed_at, source) constraint.
 *
 * Auth (mirrors api/cron/refresh-weather-grid.js)
 *   - Vercel cron always sends `x-vercel-cron: 1`
 *   - When CRON_SECRET is set, we additionally accept `Bearer
 *     ${CRON_SECRET}` and prefer it over the header
 *
 * Env vars
 *   SUPABASE_URL            (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_KEY    (or SUPABASE_SECRET_KEY) — service_role
 *   CRON_SECRET             (optional but recommended)
 */

import { fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

// NOAA SWPC RTSW (DSCOVR primary; ACE fallback when DSCOVR is in
// safehold). Both endpoints return CSV-as-JSON: first row is the
// header, remaining rows are samples in chronological order. 7-day
// window keeps the response under ~150 KB and gives us tail recovery
// if NOAA momentarily stops appending.
const PLASMA_URL = 'https://services.swpc.noaa.gov/products/solar-wind/plasma-7-day.json';
const MAG_URL    = 'https://services.swpc.noaa.gov/products/solar-wind/mag-7-day.json';

// How loose can plasma + mag timestamps be while still considered "the
// same observation"? RTSW publishes both at the same minute; allow up
// to 2 minutes of skew before we drop the mag fields and write
// plasma-only.
const PLASMA_MAG_PAIRING_TOL_MS = 2 * 60 * 1000;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';

const PIPELINE_NAME = 'solar_wind';
const SAMPLE_SOURCE = 'noaa-rtsw-cron';

// ── Auth ────────────────────────────────────────────────────────────────────

function isAuthorized(request) {
    const hdr = request.headers.get('authorization') ?? '';
    if (CRON_SECRET && hdr === `Bearer ${CRON_SECRET}`) return true;
    if (request.headers.get('x-vercel-cron')) return true;
    return false;
}

// ── NOAA RTSW parsing ───────────────────────────────────────────────────────

/**
 * Convert NOAA's "CSV-as-JSON" tabular response (`[[header...],
 * [row1...], ...]`) into an array of objects keyed by header name.
 * Returns the parsed rows + the header order so callers can also
 * index by column position if they prefer.
 */
function _parseTabular(raw) {
    if (!Array.isArray(raw) || raw.length < 2) return { rows: [], headers: [] };
    const headers = raw[0].map(h => String(h));
    const rows = raw.slice(1).map(r => {
        const o = {};
        for (let i = 0; i < headers.length; i++) o[headers[i]] = r[i];
        return o;
    });
    return { rows, headers };
}

/** Accept "2026-04-25 22:30:00.000" / "2026-04-25T22:30Z" / Date instances. */
function _parseTime(raw) {
    if (raw instanceof Date) return raw;
    if (typeof raw !== 'string' || !raw) return null;
    const cleaned = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const withTZ  = /Z|[+-]\d{2}:?\d{2}$/.test(cleaned) ? cleaned : `${cleaned}Z`;
    const t = Date.parse(withTZ);
    return Number.isFinite(t) ? new Date(t) : null;
}

function _toFloat(v) {
    if (v == null || v === '') return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
}

/** Walk plasma rows from newest backward; return the last row whose
 *  speed + density are both numeric. Skips trailing nulls that NOAA
 *  emits when a sample is dropped. */
function _latestPlasma(rows) {
    for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        const t = _parseTime(r.time_tag);
        const speed = _toFloat(r.speed);
        const density = _toFloat(r.density);
        if (t && speed != null && density != null) {
            return {
                observed_at:   t,
                speed_km_s:    speed,
                density_cc:    density,
                temperature_k: _toFloat(r.temperature),
            };
        }
    }
    return null;
}

/** Latest mag row with a valid Bt + Bz. */
function _latestMag(rows) {
    for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        const t = _parseTime(r.time_tag);
        const bt = _toFloat(r.bt);
        const bz = _toFloat(r.bz_gsm);
        if (t && bt != null && bz != null) {
            return {
                observed_at: t,
                bt_nt:       bt,
                bz_nt:       bz,
                bx_nt:       _toFloat(r.bx_gsm),
                by_nt:       _toFloat(r.by_gsm),
            };
        }
    }
    return null;
}

// ── Supabase writes ─────────────────────────────────────────────────────────

async function _supabaseRpc(fnName, args) {
    const res = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/rpc/${fnName}`,
        {
            method:    'POST',
            timeoutMs: 5000,
            headers: {
                apikey:        SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(args),
        },
    );
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`rpc ${fnName} ${res.status}: ${text.slice(0, 300)}`);
    }
}

/** Best-effort heartbeat upsert. Failure here is non-fatal — the
 *  ring-buffer write succeeded, so degrading the heartbeat to silent
 *  is preferable to surfacing a partial failure to callers. */
async function _heartbeat(success, sourceOrReason) {
    try {
        if (success) {
            await _supabaseRpc('record_pipeline_success',
                { p_name: PIPELINE_NAME, p_source: sourceOrReason });
        } else {
            await _supabaseRpc('record_pipeline_failure',
                { p_name: PIPELINE_NAME, p_reason: sourceOrReason });
        }
    } catch (_) { /* swallow — heartbeat is observability, not control */ }
}

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(request) {
    if (!isAuthorized(request)) {
        return _json({ error: 'unauthorized' }, 401);
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return _json({
            error:   'supabase_not_configured',
            missing: [
                !SUPABASE_URL ? 'SUPABASE_URL'         : null,
                !SUPABASE_KEY ? 'SUPABASE_SERVICE_KEY' : null,
            ].filter(Boolean),
        }, 500);
    }

    // 1. Fetch plasma + mag in parallel — they're independent uploads
    //    on NOAA's side. Mag failure is non-fatal; we'll write a
    //    plasma-only row.
    let plasmaRaw, magRaw, plasmaErr = null, magErr = null;
    await Promise.all([
        fetchWithTimeout(PLASMA_URL, { timeoutMs: 8000 })
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`plasma HTTP ${r.status}`)))
            .then(d => { plasmaRaw = d; })
            .catch(e => { plasmaErr = e.message; }),
        fetchWithTimeout(MAG_URL,    { timeoutMs: 8000 })
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`mag HTTP ${r.status}`)))
            .then(d => { magRaw = d; })
            .catch(e => { magErr = e.message; }),
    ]);

    if (!plasmaRaw) {
        const reason = `plasma fetch failed: ${plasmaErr || 'unknown'}`;
        await _heartbeat(false, reason);
        return _json({ ok: false, reason }, 502);
    }

    // 2. Parse + extract latest valid samples.
    const { rows: plasmaRows } = _parseTabular(plasmaRaw);
    const plasma = _latestPlasma(plasmaRows);
    if (!plasma) {
        const reason = 'plasma parse: no usable rows';
        await _heartbeat(false, reason);
        return _json({ ok: false, reason }, 502);
    }

    let mag = null;
    if (magRaw) {
        const { rows: magRows } = _parseTabular(magRaw);
        mag = _latestMag(magRows);
        // Drop mag if it's too far out of sync with plasma — better to
        // store plasma-only than to mix samples taken minutes apart.
        if (mag && Math.abs(mag.observed_at - plasma.observed_at) > PLASMA_MAG_PAIRING_TOL_MS) {
            mag = null;
        }
    }

    // 3. Build the RPC payload. observed_at takes plasma's time;
    //    plasma is the canonical observation we always have.
    const payload = {
        p_observed_at:   plasma.observed_at.toISOString(),
        p_source:        SAMPLE_SOURCE,
        p_speed_km_s:    plasma.speed_km_s,
        p_density_cc:    plasma.density_cc,
        p_temperature_k: plasma.temperature_k,
        p_bt_nt:         mag?.bt_nt   ?? null,
        p_bz_nt:         mag?.bz_nt   ?? null,
        p_bx_nt:         mag?.bx_nt   ?? null,
        p_by_nt:         mag?.by_nt   ?? null,
    };

    // 4. Insert via SECURITY DEFINER RPC. The RPC enforces bounds
    //    (speed 100..3000, observed_at within ±10 min of now). On
    //    bounds violation it RAISEs and we record the failure.
    try {
        await _supabaseRpc('record_solar_wind_sample', payload);
    } catch (e) {
        await _heartbeat(false, e.message);
        return _json({ ok: false, reason: e.message }, 502);
    }

    // 5. Heartbeat. Source label distinguishes cron writes from browser
    //    writes in pipeline_heartbeat.last_source so the status page
    //    shows which path is keeping the table warm.
    await _heartbeat(true, SAMPLE_SOURCE);

    return _json({
        ok:           true,
        observed_at:  payload.p_observed_at,
        speed_km_s:   payload.p_speed_km_s,
        density_cc:   payload.p_density_cc,
        bt_nt:        payload.p_bt_nt,
        bz_nt:        payload.p_bz_nt,
        mag_paired:   mag !== null,
        mag_warning:  magErr,
    }, 200);
}

function _json(body, status) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type':  'application/json',
            'Cache-Control': 'no-store',
        },
    });
}
