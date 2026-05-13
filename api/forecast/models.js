/**
 * Vercel Edge Function: GET /api/forecast/models
 *
 * Lightweight read-only view of forecaster_registry. The UI's "Forecast
 * Models" panel calls this once on page load to render the lineup of
 * statistical models powering the weather forecast layer.
 *
 * Returns only active models (retired_at IS NULL). The browser doesn't
 * need to know about retired forecasters; replay/skill endpoints that
 * read historical forecast_log rows can still resolve them via the
 * registry's primary key.
 *
 * Response (~600 bytes for the seeded 6 models):
 *   {
 *     source: 'forecaster_registry',
 *     models: [
 *       { model_id, name, version, family, notes, deployed_at },
 *       ...
 *     ]
 *   }
 *
 * Edge-cached 1 hour: the registry changes only when we deploy a new
 * model, which is much less often than once per visitor session.
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
// We can use either the publishable (anon) key or the service-role key
// here — the registry has a public-read RLS policy. Anon key is
// preferred so a misconfigured deploy doesn't accidentally use
// service_role for read traffic.
const SUPABASE_ANON_KEY =
       process.env.SUPABASE_ANON_KEY
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    || process.env.SUPABASE_PUBLISHABLE_KEY
    || '';

const CACHE_TTL = 3600;     // 1 hour
const CACHE_SWR = 600;      // 10 min

export default async function handler(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204 });
    }
    if (request.method !== 'GET') {
        return jsonError('method_not_allowed', null, { status: 405 });
    }
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        return jsonError('supabase_not_configured', null, { status: 503 });
    }

    const url = new URL(`${SUPABASE_URL}/rest/v1/forecaster_registry`);
    url.searchParams.set('select',
        'model_id,name,version,family,notes,deployed_at');
    url.searchParams.set('retired_at', 'is.null');
    url.searchParams.set('order', 'family.asc,model_id.asc');

    let rows;
    try {
        const res = await fetchWithTimeout(url, {
            timeoutMs: 6_000,
            headers: {
                apikey:        SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                Accept:        'application/json',
            },
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return jsonError('upstream_unavailable',
                `supabase ${res.status}: ${text.slice(0, 200)}`,
                { status: 502, source: 'supabase' });
        }
        rows = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message,
            { status: 502, source: 'supabase' });
    }

    return jsonOk({
        source: 'forecaster_registry',
        models: rows,
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
