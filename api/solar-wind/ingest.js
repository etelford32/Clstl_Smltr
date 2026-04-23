/**
 * Vercel Edge Function: /api/solar-wind/ingest   (POST)
 *
 * Browser write-through endpoint. When a visitor's browser-direct NOAA
 * fetch succeeds, js/wind-pipeline-feed.js POSTs the latest sample
 * here so the pg_cron ring buffer stays warm even if pg_cron itself
 * gets WAF-blocked or is paused. Belt-and-suspenders to the pg_cron
 * primary writer — if both sources are healthy they harmlessly
 * deduplicate via the UNIQUE (observed_at, source) constraint.
 *
 * The endpoint holds the service_role key; the browser never does.
 * Validation happens in the SECURITY DEFINER RPC
 * (record_solar_wind_sample), so even if this endpoint is misused
 * the database rejects out-of-range / stale samples.
 *
 * Rate limiting: Vercel Edge runs this per-request; for true abuse
 * protection add a rate-limit middleware later (deferred — the RPC's
 * strict validation already caps the attack surface).
 *
 * Request body (JSON):
 *   {
 *     observed_at:   "2026-04-22T18:30:00Z",   // required, within ±10 min of now
 *     speed_km_s:    412.5,                    // required, 100–3000
 *     density_cc:    6.1,                      // optional
 *     temperature_k: 89000,                    // optional
 *     bt_nt:         4.2,                      // optional
 *     bz_nt:        -1.8,                      // optional
 *     bx_nt:         2.1,                      // optional
 *     by_nt:        -0.9,                      // optional
 *     source:        "noaa-swpc-browser"       // optional; defaults to "unknown"
 *   }
 *
 * Response: { ok: true, id: <bigint|null> }   — id null == dedup (fine)
 *
 * ── Env vars ────────────────────────────────────────────────────────
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

import { jsonError, fetchWithTimeout, CORS_HEADERS } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

// Dual-name env vars — see api/weather/grid.js for rationale.
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

// Finite-number coercion. Returns null if value is missing / NaN / Inf.
function num(v) {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

export default async function handler(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                ...CORS_HEADERS,
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Max-Age':       '86400',
            },
        });
    }

    if (request.method !== 'POST') {
        return jsonError('method_not_allowed', 'POST only', { status: 405, maxAge: 0 });
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return jsonError('supabase_not_configured', 'missing env', { status: 500, maxAge: 30 });
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonError('bad_json', 'invalid JSON body', { status: 400, maxAge: 0 });
    }

    // Shape the RPC payload. The RPC enforces bounds server-side —
    // this function is deliberately a thin passthrough so validation
    // logic lives in one place (the migration).
    const rpcBody = {
        p_observed_at:   body?.observed_at ?? null,
        p_source:        typeof body?.source === 'string' ? body.source.slice(0, 32) : 'noaa-swpc-browser',
        p_speed_km_s:    num(body?.speed_km_s),
        p_density_cc:    num(body?.density_cc),
        p_temperature_k: num(body?.temperature_k),
        p_bt_nt:         num(body?.bt_nt),
        p_bz_nt:         num(body?.bz_nt),
        p_bx_nt:         num(body?.bx_nt),
        p_by_nt:         num(body?.by_nt),
    };

    if (!rpcBody.p_observed_at || rpcBody.p_speed_km_s == null) {
        return jsonError('missing_fields',
            'observed_at and speed_km_s are required', { status: 400, maxAge: 0 });
    }

    let res;
    try {
        res = await fetchWithTimeout(
            `${SUPABASE_URL}/rest/v1/rpc/record_solar_wind_sample`,
            {
                method:  'POST',
                headers: {
                    apikey:        SUPABASE_KEY,
                    Authorization: `Bearer ${SUPABASE_KEY}`,
                    'Content-Type': 'application/json',
                    Accept:        'application/json',
                },
                body:    JSON.stringify(rpcBody),
                timeoutMs: 5000,
            },
        );
    } catch (e) {
        return jsonError('supabase_unreachable', e.message, {
            status: 503,
            source: 'supabase/rpc/record_solar_wind_sample',
        });
    }

    if (!res.ok) {
        // RPC RAISEs on bounds violations — surface the Postgres message
        // for callers (helpful when debugging; harmless leakage since
        // the RPC messages don't expose secrets).
        const text = await res.text().catch(() => '');
        return jsonError('rpc_failed', text || `HTTP ${res.status}`, {
            status: res.status === 400 ? 400 : 503,
            source: 'supabase/rpc/record_solar_wind_sample',
        });
    }

    const resultText = await res.text().catch(() => '');
    // PostgREST returns the raw scalar for scalar-returning RPCs.
    const id = resultText ? JSON.parse(resultText) : null;

    return new Response(JSON.stringify({ ok: true, id }), {
        status: 200,
        headers: {
            'Content-Type':  'application/json',
            'Cache-Control': 'private, no-store',
            ...CORS_HEADERS,
        },
    });
}
