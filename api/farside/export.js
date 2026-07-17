/**
 * Vercel Edge Function: /api/farside/export?format=csv|json[&source=gong]
 *
 * Operator export of the Far-Side Watch emergence forecast (Tier 5). The same
 * watch list the page shows — far-side regions tracked in Carrington longitude
 * with a predicted east-limb emergence date — as CSV (default) or JSON, for
 * programmatic/REST consumers.
 *
 * Gated to the Advanced/operator tier. The caller authenticates with their
 * Supabase JWT (`Authorization: Bearer <access_token>`); we verify it, look up
 * the plan/role, and require planToTier() === PRO. Reads come from the
 * service-role-only farside_maps archive server-side, and the watch list is
 * computed with the same modules the browser runs.
 *
 *   curl -H "Authorization: Bearer $JWT" \
 *        https://parkersphysics.com/api/farside/export?format=csv
 */
import { farSideWatchListFromFrames } from '../../js/farside/index.js';
import { planToTier, TIER } from '../../js/config.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://aijsboodkivnhzfstvdq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
    || 'https://parkerphysics.com,https://parkersphysics.com,https://parkerphysics.app')
    .split(',').map(s => s.trim()).filter(Boolean);

function corsHeaders(origin) {
    const ok = origin && ALLOWED_ORIGINS.includes(origin);
    return {
        'Access-Control-Allow-Origin':  ok ? origin : ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Vary':                         'Origin',
        'Cache-Control':                'no-store',
    };
}

const json = (body, status, origin) =>
    new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });

async function verifyUser(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    try {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY || token },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        const u = await res.json();
        return u?.id ? { id: u.id, email: u.email } : null;
    } catch { return null; }
}

async function fetchProfile(userId) {
    try {
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}&select=plan,role`,
            { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
              signal: AbortSignal.timeout(8000) });
        if (!res.ok) return null;
        const rows = await res.json();
        return Array.isArray(rows) ? rows[0] : null;
    } catch { return null; }
}

async function fetchFrames(source) {
    const res = await fetch(
        `${SUPABASE_URL}/rest/v1/farside_maps?source=eq.${source}&order=observed_at.desc&limit=12`
        + `&select=observed_at,carrington_l0,carrington_b0,detections`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
          signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return [];
    return rows.reverse().map(r => ({
        timestamp: r.observed_at, L0: r.carrington_l0, B0: r.carrington_b0,
        dets: Array.isArray(r.detections) ? r.detections : [],
    }));
}

function toCSV(watch) {
    const head = 'lon_carrington,lat,eta_days,eta_band_days,emergence_utc,strength,trend,confidence,frames,strong';
    const rows = watch.map(t => [
        t.lon.toFixed(2), t.lat.toFixed(2), t.etaDays.toFixed(3), t.etaBandDays.toFixed(3),
        t.emergenceUTC, t.latestStrength.toFixed(3), t.trend.toFixed(3),
        t.confidence.toFixed(3), t.frames, t.strong ? 1 : 0,
    ].join(','));
    return [head, ...rows].join('\n') + '\n';
}

export default async function handler(req) {
    const origin = req.headers.get('origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, origin);

    const url = new URL(req.url);
    const format = (url.searchParams.get('format') || 'csv').toLowerCase();
    const source = (url.searchParams.get('source') || 'gong').toLowerCase();

    // ── Auth + Advanced-tier gate ──────────────────────────────────
    const user = await verifyUser(req.headers.get('authorization'));
    if (!user) return json({ error: 'unauthorized', detail: 'Supabase access token required.' }, 401, origin);
    const profile = await fetchProfile(user.id);
    if (planToTier(profile?.plan, profile?.role) !== TIER.PRO) {
        return json({ error: 'upgrade_required',
            detail: 'Far-Side Watch export is an Advanced/operator feature.' }, 402, origin);
    }

    // ── Build the watch list from the stored archive ───────────────
    const frames = await fetchFrames(source);
    if (!frames.length) {
        return json({ error: 'no_data',
            detail: 'No far-side maps ingested yet for this source.' }, 503, origin);
    }
    const watch = farSideWatchListFromFrames(frames);

    if (format === 'json') {
        return json({
            source, generated_at: new Date().toISOString(),
            observed_at: frames[frames.length - 1].timestamp,
            count: watch.length, watch,
        }, 200, origin);
    }

    const stamp = frames[frames.length - 1].timestamp.slice(0, 10);
    return new Response(toCSV(watch), {
        status: 200,
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="far-side-watch_${stamp}.csv"`,
            ...corsHeaders(origin),
        },
    });
}
