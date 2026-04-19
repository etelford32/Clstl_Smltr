/**
 * Vercel Edge Function: /api/weather/refresh
 *
 * Writer endpoint. Fetches the 648-point Open-Meteo grid and persists the
 * raw per-location array into Supabase's weather_grid_cache table. Every
 * user-facing request reads from that row via /api/weather/grid, so upstream
 * Open-Meteo traffic is decoupled from visitor traffic.
 *
 * Invocation:
 *   - Vercel Cron — daily safety net (vercel.json schedule: '0 6 * * *').
 *     Hobby plan allows exactly one cron per day; this is it.
 *   - Manual / debug — `curl -H "Authorization: Bearer $CRON_SECRET" …`.
 *
 * The primary hourly refresh lives in Supabase (pg_cron calling
 * public.refresh_weather_grid() — see supabase-weather-pgcron-migration.sql).
 * That path doesn't go through this endpoint at all, which is intentional:
 * it means the hourly cadence has zero Vercel dependency.
 *
 * Authenticated callers send `Authorization: Bearer ${CRON_SECRET}`.
 *
 * ── Env vars ────────────────────────────────────────────────────────
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY   — service_role (bypasses RLS)
 *   CRON_SECRET            — shared secret Vercel Cron sends
 */

export const config = { runtime: 'edge' };

const OPEN_METEO    = 'https://api.open-meteo.com/v1/forecast';
const SUPABASE_URL  = process.env.SUPABASE_URL || '';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || '';
const CRON_SECRET   = process.env.CRON_SECRET || '';

// Grid geometry must match js/weather-feed.js (GRID_W × GRID_H = 36 × 18)
// AND the pg_cron function in supabase-weather-pgcron-migration.sql.
const GRID_W = 36;
const GRID_H = 18;

function buildGrid() {
    const lats = [], lons = [];
    for (let j = 0; j < GRID_H; j++) {
        for (let i = 0; i < GRID_W; i++) {
            lats.push(-85 + j * 10);
            lons.push(-175 + i * 10);
        }
    }
    return { lats, lons };
}

function json(body, status = 200) {
    return Response.json(body, {
        status,
        headers: { 'Cache-Control': 'no-store' },
    });
}

async function fetchOpenMeteo() {
    const { lats, lons } = buildGrid();
    const params = new URLSearchParams();
    params.set('latitude',  lats.join(','));
    params.set('longitude', lons.join(','));
    params.set('current', [
        'temperature_2m',
        'relative_humidity_2m',
        'surface_pressure',
        'wind_speed_10m',
        'wind_direction_10m',
        'cloud_cover_low',
        'cloud_cover_mid',
        'cloud_cover_high',
        'precipitation',
        'cape',
    ].join(','));
    params.set('wind_speed_unit', 'ms');
    params.set('timezone', 'UTC');

    const res = await fetch(`${OPEN_METEO}?${params}`, {
        signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);

    const body = await res.json();
    if (body && !Array.isArray(body) && body.error) {
        throw new Error(`Open-Meteo: ${body.reason ?? body.error}`);
    }
    return Array.isArray(body) ? body : [body];
}

async function insertRow(payload) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/weather_grid_cache`, {
        method: 'POST',
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            Prefer:        'return=minimal',
        },
        body: JSON.stringify({ source: 'open-meteo', payload }),
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Supabase insert ${res.status}: ${txt}`);
    }
}

async function trimHistory() {
    // Retention helper from the cache migration. Non-fatal on failure —
    // a stale row just means a few extra KB of storage.
    try {
        await fetch(`${SUPABASE_URL}/rest/v1/rpc/trim_weather_grid_cache`, {
            method: 'POST',
            headers: {
                apikey:        SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: '{}',
        });
    } catch { /* noop */ }
}

export default async function handler(req) {
    if (CRON_SECRET) {
        const auth = req.headers.get('authorization') || '';
        if (auth !== `Bearer ${CRON_SECRET}`) {
            return json({ error: 'unauthorized' }, 401);
        }
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return json({ error: 'supabase_not_configured' }, 500);
    }

    try {
        const rows = await fetchOpenMeteo();
        if (!Array.isArray(rows) || rows.length === 0) {
            throw new Error('Empty Open-Meteo response');
        }
        await insertRow(rows);
        await trimHistory();
        return json({
            ok: true,
            source: 'open-meteo',
            locations: rows.length,
            refreshed_at: new Date().toISOString(),
        });
    } catch (e) {
        return json({ error: 'refresh_failed', detail: e.message }, 502);
    }
}
