/**
 * Vercel Edge Function: /api/ring-current/skill
 *
 * The published skill ledger of the ring-current model — the join the
 * enrichment migration was built for (RING_CURRENT_SIMULATION_PLAN.md
 * Phase 2b; "skill must be shown, not claimed" in
 * RING_CURRENT_USER_RESEARCH.md).
 *
 * api/cron/refresh-solar-wind.js logs the O'Brien–McPherron nowcast into
 * `ring_current_log` every 15 min and upserts hourly Kyoto Dst into
 * `geomag_indices` — server-side, whether or not anyone has the page open.
 * This endpoint joins the two (both are RLS-zero-policy service-role tables,
 * unreachable from the browser by design) and returns aggregated skill:
 *
 *   {
 *     source, generated,
 *     ledger:  { model_rows, dst_rows, latest_model, latest_dst, cadence_min },
 *     windows: { h24: {rmse, bias, n}, d7: {rmse, bias, n} },
 *     daily:   [ { day: "2026-07-11", rmse, bias, n }, … ]   // ≤ 7 UTC days, ascending
 *   }
 *
 * Pairing reuses skill() from js/ring-current-model.js — the EXACT code the
 * page and the cron run, so the published numbers cannot drift from the
 * in-browser ones. Aggregates only ever leave this endpoint (no raw rows).
 *
 * Row volume stays under PostgREST's 1000-row response cap by construction:
 * 7 d of 15-min model rows = 672, 7 d of hourly Dst = 168.
 *
 * Cache: s-maxage=600 (the ledger advances every 15 min), SWR 300.
 *
 * ── Env vars ────────────────────────────────────────────────────────────────
 *   SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_KEY / SUPABASE_SECRET_KEY   — service_role (bypasses RLS)
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { skill } from '../../js/ring-current-model.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

const WINDOW_DAYS  = 7;
const CACHE_MAX_AGE = 600;
const CACHE_SWR     = 300;

// ── Pure aggregation (node-tested in tests/ring-current-skill-endpoint.mjs) ──

/**
 * Join raw ledger rows into the published skill summary.
 *
 * @param {Array<{t:string, dst_model:number}>} modelRows  ring_current_log
 * @param {Array<{t:string, value:number}>}     dstRows    geomag_indices kind=dst
 * @param {number} nowMs
 */
export function ledgerSkillSummary(modelRows, dstRows, nowMs) {
    const model = (Array.isArray(modelRows) ? modelRows : [])
        .map(r => ({ t: Date.parse(r.t), dst: r.dst_model }))
        .filter(r => Number.isFinite(r.t) && Number.isFinite(r.dst))
        .sort((a, b) => a.t - b.t);
    const observed = (Array.isArray(dstRows) ? dstRows : [])
        .map(r => ({ t: Date.parse(r.t), dst: r.value }))
        .filter(r => Number.isFinite(r.t) && Number.isFinite(r.dst))
        .sort((a, b) => a.t - b.t);

    const round = (s) => ({
        rmse: Number.isFinite(s.rmse) ? Math.round(s.rmse * 10) / 10 : null,
        bias: Number.isFinite(s.bias) ? Math.round(s.bias * 10) / 10 : null,
        n:    s.n,
    });

    const windows = {};
    for (const [key, hours] of [['h24', 24], ['d7', WINDOW_DAYS * 24]]) {
        const cut = nowMs - hours * 3.6e6;
        windows[key] = round(skill(model, observed.filter(o => o.t >= cut)));
    }

    // Per-UTC-day buckets, oldest → newest, today included. Days with no
    // pairs are kept (nulls) so the panel's bar row has a stable x-axis.
    const daily = [];
    const dayMs = 24 * 3.6e6;
    const today0 = Math.floor(nowMs / dayMs) * dayMs;
    for (let d = WINDOW_DAYS - 1; d >= 0; d--) {
        const start = today0 - d * dayMs;
        const obs = observed.filter(o => o.t >= start && o.t < start + dayMs);
        daily.push({
            day: new Date(start).toISOString().slice(0, 10),
            ...round(skill(model, obs)),
        });
    }

    return {
        ledger: {
            model_rows:   model.length,
            dst_rows:     observed.length,
            latest_model: model.length ? new Date(model[model.length - 1].t).toISOString() : null,
            latest_dst:   observed.length ? new Date(observed[observed.length - 1].t).toISOString() : null,
            cadence_min:  15,
        },
        windows,
        daily,
    };
}

// ── Supabase reads (service role — the tables have zero RLS policies) ────────

async function readTable(path) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, {
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
        },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler() {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return jsonError('supabase_not_configured',
            'SUPABASE_URL / SUPABASE_SERVICE_KEY missing', { status: 500 });
    }

    const nowMs = Date.now();
    const sinceIso = new Date(nowMs - WINDOW_DAYS * 24 * 3.6e6).toISOString();

    let modelRows, dstRows;
    try {
        [modelRows, dstRows] = await Promise.all([
            readTable(`ring_current_log?select=t,dst_model&t=gte.${sinceIso}&order=t.asc&limit=1000`),
            readTable(`geomag_indices?select=t,value&kind=eq.dst&t=gte.${sinceIso}&order=t.asc&limit=1000`),
        ]);
    } catch (e) {
        return jsonError('ledger_unavailable', e.message, {
            source: 'supabase/ring_current_log',
        });
    }

    return jsonOk({
        source:    'supabase/ring_current_log ⨝ geomag_indices (kind=dst, Kyoto WDC)',
        generated: new Date(nowMs).toISOString(),
        ...ledgerSkillSummary(modelRows, dstRows, nowMs),
    }, { maxAge: CACHE_MAX_AGE, swr: CACHE_SWR });
}
