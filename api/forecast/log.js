/**
 * Vercel Edge Function: POST /api/forecast/log
 *
 * Append-only writer for the forecast accumulator (Phase 0 from
 * EARTH_ML_FIRST_PRINCIPLES.md, scoped to the minimum unblocking set).
 * Browsers POST batches of (prediction, model, cell, lead) tuples here
 * after each weather-forecast-validation cycle; we forward them to the
 * Supabase RPC `record_forecast_batch`, which validates + privacy-rounds
 * + bulk-inserts under service_role.
 *
 * Request:
 *   POST /api/forecast/log
 *   Content-Type: application/json
 *   { records: [
 *       {
 *         made_at:   "2026-05-12T17:23:00.000Z",
 *         valid_at:  "2026-05-12T18:23:00.000Z",
 *         lat:       40.0,
 *         lon:       -105.3,
 *         field:     "temperature_2m",
 *         model_id:  "AR1",
 *         value:     12.4,          // optional
 *         p10:       11.0,
 *         p50:       12.4,
 *         p90:       13.8,
 *         sim_time_ms: 1747000000000  // optional
 *       },
 *       ...
 *     ] }
 *
 * Response:
 *   { ingested: N, rejected: M, reasons?: [...] }
 *
 * Auth: anonymous-allowed. Anyone can write predictions — that's the
 * point of "record before predict" from the first-principles doc. Abuse
 * is bounded by:
 *   - 100 records/batch hard cap (enforced by the RPC)
 *   - In-edge sliding window: 6 requests/IP/minute (this file)
 *   - Body size limit: 64 KB (this file)
 *   - Privacy rounding to 0.5° at insert (the RPC)
 *
 * Rate-limit implementation: a per-instance LRU keyed by remote IP.
 * Vercel's edge replicates this across many isolates, so the effective
 * cap is per-isolate, not per-IP-globally. Good enough for now — true
 * global enforcement would need a Supabase round-trip per request,
 * which costs more than the abuse it prevents at this scale.
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

const MAX_BODY_BYTES        = 64 * 1024;      // 64 KB hard ceiling
const MAX_RECORDS_PER_BATCH = 100;            // matches RPC's hard cap
const RATE_LIMIT_WINDOW_MS  = 60_000;          // 1 minute sliding window
const RATE_LIMIT_MAX        = 6;              // 6 req/min/IP/isolate
const RATE_LIMIT_LRU_MAX    = 4096;           // distinct IPs tracked per isolate

// ── Rate limiter ──────────────────────────────────────────────────
// In-memory; per-isolate. The fall-off here is: if a single attacker
// hits one IP from many isolates, they can exceed 6 req/min globally.
// That's fine — they still can't exceed MAX_RECORDS_PER_BATCH per call,
// and the RPC rejects anything outside the time/coord windows.

const rateBuckets = new Map();   // ip -> number[] of timestamps (ms)

function checkRate(ip) {
    const now = Date.now();
    let bucket = rateBuckets.get(ip);
    if (!bucket) {
        bucket = [];
        rateBuckets.set(ip, bucket);
    }
    // Drop timestamps older than the window.
    while (bucket.length && bucket[0] < now - RATE_LIMIT_WINDOW_MS) bucket.shift();

    if (bucket.length >= RATE_LIMIT_MAX) {
        return { allowed: false, retry_after: Math.ceil(
            (bucket[0] + RATE_LIMIT_WINDOW_MS - now) / 1000) };
    }
    bucket.push(now);

    // Tiny LRU trim: if we're tracking too many distinct IPs, drop the
    // oldest-seen ones. Iteration order of Map is insertion order, so the
    // first entries are the stalest.
    if (rateBuckets.size > RATE_LIMIT_LRU_MAX) {
        const overflow = rateBuckets.size - RATE_LIMIT_LRU_MAX;
        let i = 0;
        for (const key of rateBuckets.keys()) {
            if (i++ >= overflow) break;
            rateBuckets.delete(key);
        }
    }
    return { allowed: true };
}

function clientIp(request) {
    // Vercel edge sets x-real-ip and x-forwarded-for; either is fine.
    // CF-Connecting-IP is set when traffic is proxied through Cloudflare
    // (which it is for parkersphysics.com).
    return request.headers.get('cf-connecting-ip')
        || request.headers.get('x-real-ip')
        || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
        || 'unknown';
}

// ── Supabase RPC wrapper ──────────────────────────────────────────

async function callRecordBatch(records) {
    const res = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/rpc/record_forecast_batch`,
        {
            method:    'POST',
            timeoutMs: 8000,
            headers: {
                apikey:         SUPABASE_KEY,
                Authorization:  `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ payload: records }),
        },
    );
    const text = await res.text();
    if (!res.ok) {
        // Surface the Supabase error message to the caller (it's our own
        // RPC; no risk of leaking unrelated infrastructure detail).
        throw new Error(`rpc_${res.status}: ${text.slice(0, 300)}`);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`rpc_parse: ${text.slice(0, 200)}`);
    }
}

// ── Handler ───────────────────────────────────────────────────────

export default async function handler(request) {
    if (request.method === 'OPTIONS') {
        // CORS preflight. The Access-Control-Allow-* headers come from
        // vercel.json's /api/forecast/(.*) entry; just ack here.
        return new Response(null, { status: 204 });
    }
    if (request.method !== 'POST') {
        return jsonError('method_not_allowed', `expected POST, got ${request.method}`,
            { status: 405 });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return jsonError('supabase_not_configured', null, { status: 500 });
    }

    const ip   = clientIp(request);
    const rate = checkRate(ip);
    if (!rate.allowed) {
        return new Response(JSON.stringify({
            error:       'rate_limited',
            retry_after: rate.retry_after,
        }), {
            status: 429,
            headers: {
                'Content-Type':  'application/json',
                'Retry-After':   String(rate.retry_after),
                'Cache-Control': 'no-store',
            },
        });
    }

    // Body size guard — read as text so we can reject oversize before
    // JSON.parse spends CPU.
    let bodyText;
    try {
        bodyText = await request.text();
    } catch (e) {
        return jsonError('body_read', e.message, { status: 400 });
    }
    if (bodyText.length > MAX_BODY_BYTES) {
        return jsonError('body_too_large',
            `max ${MAX_BODY_BYTES} bytes, got ${bodyText.length}`,
            { status: 413 });
    }

    let body;
    try {
        body = JSON.parse(bodyText);
    } catch (e) {
        return jsonError('json_parse', e.message, { status: 400 });
    }

    const records = body && Array.isArray(body.records) ? body.records : null;
    if (!records) {
        return jsonError('bad_request', 'expected { records: [...] }', { status: 400 });
    }
    if (records.length === 0) {
        return jsonOk({ ingested: 0, rejected: 0 }, { maxAge: 0, swr: 0 });
    }
    if (records.length > MAX_RECORDS_PER_BATCH) {
        return jsonError('batch_too_large',
            `max ${MAX_RECORDS_PER_BATCH} records, got ${records.length}`,
            { status: 400 });
    }

    let rpcResult;
    try {
        rpcResult = await callRecordBatch(records);
    } catch (e) {
        return jsonError('rpc_failed', e.message, { status: 502 });
    }

    // Normalize: the RPC returns { ingested, rejected, reasons }; we drop
    // `reasons` from the public response unless the caller asked for them,
    // since some of them include the full record (would round-trip the
    // caller's coords back to themselves — not a security issue, but
    // wasteful in the success-only path).
    const wantReasons = new URL(request.url).searchParams.get('debug') === '1';
    const out = {
        ingested: rpcResult.ingested ?? 0,
        rejected: rpcResult.rejected ?? 0,
    };
    if (wantReasons) out.reasons = rpcResult.reasons || [];

    return jsonOk(out, { maxAge: 0, swr: 0 });
}
