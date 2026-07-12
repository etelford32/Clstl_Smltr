/**
 * Vercel Edge Function: /api/ring-current/validation
 *
 * Public read of the daily validation re-runs (validation_runs table,
 * written by api/cron/validation-rerun.js): the latest N rows per study
 * kind, newest first — the live skill record for the back-mapping
 * attribution and the 27-day recurrence hindcast. Heavy `detail` jsonb is
 * excluded; metrics carry everything the reports quote.
 *
 * Query params:
 *   ?limit=N   rows per kind (default 14 ≈ two weeks of daily runs, max 60)
 *
 * Cache: 10 min CDN (the table changes once a day).
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

export default async function handler(request) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return jsonError('not_configured', 'supabase env missing', { status: 503 });
    }
    const limit = Math.max(1, Math.min(60,
        parseInt(new URL(request.url).searchParams.get('limit') ?? '14', 10) || 14));

    const url = new URL(`${SUPABASE_URL}/rest/v1/validation_runs`);
    url.searchParams.set('select',
        'id,ran_at,kind,window_start,window_end,n_forecasts,hits,hit_rate,mae_days,skill,metrics');
    url.searchParams.set('order', 'ran_at.desc');
    url.searchParams.set('limit', String(limit * 3));   // three kinds interleaved

    let rows;
    try {
        const res = await fetchWithTimeout(url, {
            timeoutMs: 8000,
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                Accept: 'application/json',
            },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        rows = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'supabase' });
    }

    const byKind = { backmap: [], recurrence: [], cme: [] };
    for (const r of rows) {
        if (byKind[r.kind] && byKind[r.kind].length < limit) byKind[r.kind].push(r);
    }
    return jsonOk({
        source: 'validation_runs (daily cron re-scoring)',
        data: {
            updated: new Date().toISOString(),
            backmap: byKind.backmap,
            recurrence: byKind.recurrence,
            cme: byKind.cme,
        },
    }, { maxAge: 600, swr: 120 });
}
