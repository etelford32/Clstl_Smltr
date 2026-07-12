/**
 * Vercel Edge Function: /api/ring-current/dataset
 *
 * Read access to the synchronized solar-wind ↔ geomagnetic minute dataset
 * (public.sw_geomag_dataset — service-role-only; this endpoint is the
 * public window onto it). One row per UTC minute: L1 plasma/IMF alongside
 * Kp, ap (derived, labeled), Kyoto Dst and GOES ≥2 MeV electron flux, each
 * with native timestamp, source and explicit ok/held/gap flag.
 *
 *   GET /api/ring-current/dataset                     → last 6 h, JSON
 *   GET /api/ring-current/dataset?hours=24            → trailing window
 *   GET /api/ring-current/dataset?start=ISO&end=ISO   → explicit range
 *   GET /api/ring-current/dataset?…&format=csv        → text/csv download
 *
 * Span cap: 7 days per request (10 080 rows — page through longer ranges).
 * JSON responses carry the provenance/flag legend and a per-signal gap
 * summary; the CSV carries the same per-row provenance columns.
 *
 * Cache: s-maxage=300 (the writer runs every 10 min), SWR 60.
 *
 * ── Env vars ────────────────────────────────────────────────────────────────
 *   SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_KEY / SUPABASE_SECRET_KEY   — service_role (bypasses RLS)
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import {
    DATASET_COLUMNS, FRESH_WINDOWS_MIN, HOLD_LIMITS_MIN, SOURCES,
    gapSummary, toCsv,
} from '../_lib/sync-dataset-core.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

const MAX_SPAN_MS = 7 * 24 * 3.6e6;
const PAGE_ROWS   = 1000;               // PostgREST response cap per request
const CACHE = { successMaxAge: 300, successSwr: 60 };

/** Resolve the requested [start, end) range — pure, node-testable. */
export function resolveRange(params, nowMs) {
    const end = params.get('end') ? Date.parse(params.get('end')) : nowMs;
    let start;
    if (params.get('start')) {
        start = Date.parse(params.get('start'));
    } else {
        const hours = Math.max(0.1, Number(params.get('hours')) || 6);
        start = end - hours * 3.6e6;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { error: 'invalid start/end timestamp' };
    if (end <= start) return { error: 'end must be after start' };
    if (end - start > MAX_SPAN_MS) return { error: 'span exceeds 7 days — page through longer ranges' };
    return { start, end };
}

async function fetchPage(startIso, endIso, offset) {
    const q = `${SUPABASE_URL}/rest/v1/sw_geomag_dataset` +
        `?t=gte.${encodeURIComponent(startIso)}&t=lt.${encodeURIComponent(endIso)}` +
        `&order=t.asc&limit=${PAGE_ROWS}&offset=${offset}`;
    const res = await fetchWithTimeout(q, {
        timeoutMs: 10_000,
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) throw new Error(`dataset query HTTP ${res.status}`);
    return res.json();
}

export default async function handler(req) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return jsonError(500, 'dataset endpoint not configured');
    }
    const url = new URL(req.url);
    const range = resolveRange(url.searchParams, Date.now());
    if (range.error) return jsonError(400, range.error);
    const startIso = new Date(range.start).toISOString();
    const endIso   = new Date(range.end).toISOString();

    let rows = [];
    try {
        for (let offset = 0; ; offset += PAGE_ROWS) {
            const page = await fetchPage(startIso, endIso, offset);
            rows = rows.concat(page);
            if (page.length < PAGE_ROWS) break;
        }
    } catch (e) {
        return jsonError(502, String(e?.message ?? e).slice(0, 200));
    }

    if (url.searchParams.get('format') === 'csv') {
        return new Response(toCsv(rows), {
            status: 200,
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition':
                    `attachment; filename="sw_geomag_${startIso.slice(0, 16)}_${endIso.slice(0, 16)}.csv"`,
                'Cache-Control': `public, s-maxage=${CACHE.successMaxAge}, stale-while-revalidate=${CACHE.successSwr}`,
                'Access-Control-Allow-Origin': '*',
            },
        });
    }

    return jsonOk({
        source: 'parkersphysics sw_geomag_dataset',
        generated: new Date().toISOString(),
        window: { start: startIso, end: endIso, minutes: rows.length },
        meta: {
            columns: DATASET_COLUMNS,
            cadence: 'one row per UTC minute; *_t = native sample time of each signal',
            flags: {
                sw: 'ok (plasma) | mag_only (IMF only) | gap',
                indices: 'ok (within native cadence) | held (carried, see *_t) | gap (null)',
                fresh_windows_min: FRESH_WINDOWS_MIN,
                hold_limits_min: HOLD_LIMITS_MIN,
            },
            sources: SOURCES,
            note: 'ap is derived (kpToAp over 3-h planetary Kp) — never a direct measurement. Gap minutes are rows: absence is recorded, not implied.',
        },
        gaps: gapSummary(rows),
        rows,
    }, CACHE);
}
