/**
 * Vercel Edge Function: /api/health
 *
 * Sprint-0 diagnostic aid. Pings every upstream the space-weather data plane
 * depends on and returns a flat JSON summary so the next outage can be
 * triaged from one request instead of an archaeology session.
 *
 *   GET /api/health
 *   { ok, checked_at, summary:{up,down,total}, upstreams:[
 *       { source:'swpc-plasma', ok:true, latency_ms:142, http_status:200 }, … ] }
 *
 * Caveat baked into the payload: services.swpc.noaa.gov is fetched
 * BROWSER-side on the live page (NOAA's WAF 403s server-side calls), so a
 * `down` here for an `swpc-*` row means "unreachable from the Vercel edge",
 * NOT necessarily "down for users". DONKI / JPL rows are authoritative
 * because the page proxies those through the edge.
 */
import { jsonOk, fetchWithTimeout, DEFAULT_USER_AGENT } from './_lib/responses.js';

export const config = { runtime: 'edge' };

const NASA_KEY = (typeof process !== 'undefined' && process.env && process.env.NASA_API_KEY) || 'DEMO_KEY';

// source → url. Kept tiny on purpose; HEAD-ish GETs with a short timeout.
const UPSTREAMS = [
    { source: 'swpc-plasma',  url: 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json',          edge_authoritative: false },
    { source: 'swpc-mag',     url: 'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json',           edge_authoritative: false },
    { source: 'swpc-kp',      url: 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',       edge_authoritative: false },
    { source: 'swpc-xray',    url: 'https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json',   edge_authoritative: false },
    { source: 'swpc-alerts',  url: 'https://services.swpc.noaa.gov/products/alerts.json',                 edge_authoritative: false },
    // Story 4.2 operator-readout feeds (browser-direct on the page; an edge
    // 403 here is expected, like the other swpc-* rows — ρ@400 is on-device
    // so it has no upstream to ping and is intentionally not listed).
    { source: 'swpc-dst-kyoto', url: 'https://services.swpc.noaa.gov/products/kyoto-dst.json',                  edge_authoritative: false },
    { source: 'swpc-f107',      url: 'https://services.swpc.noaa.gov/json/f107_cm_flux.json',                   edge_authoritative: false },
    { source: 'swpc-ap-daily',  url: 'https://services.swpc.noaa.gov/text/daily-geomagnetic-indices.txt',       edge_authoritative: false },
    { source: 'donki-cme',    url: `https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/CME?api_key=${NASA_KEY}`, edge_authoritative: true },
    { source: 'jpl-horizons', url: 'https://ssd.jpl.nasa.gov/api/horizons.api?format=json&COMMAND=%27399%27&EPHEM_TYPE=VECTORS&CENTER=%27500@10%27&START_TIME=%272026-01-01%27&STOP_TIME=%272026-01-02%27&STEP_SIZE=%271%20d%27', edge_authoritative: true },
];

async function ping({ source, url, edge_authoritative }) {
    const t0 = Date.now();
    try {
        const res = await fetchWithTimeout(url, { timeoutMs: 8000, headers: { Accept: 'application/json' } });
        return {
            source,
            ok: res.ok,
            http_status: res.status,
            latency_ms: Date.now() - t0,
            edge_authoritative,
        };
    } catch (e) {
        return {
            source,
            ok: false,
            http_status: null,
            latency_ms: Date.now() - t0,
            error: e?.name === 'TimeoutError' ? 'timeout' : (e?.message ?? 'fetch_failed'),
            edge_authoritative,
        };
    }
}

export default async function handler() {
    const upstreams = await Promise.all(UPSTREAMS.map(ping));
    const up   = upstreams.filter(u => u.ok).length;
    const down = upstreams.length - up;
    // "ok" reflects only edge-authoritative upstreams — an swpc-* edge 403 is
    // expected (browser fetches those) and must not flip the overall health.
    const authoritativeDown = upstreams.filter(u => u.edge_authoritative && !u.ok).length;
    return jsonOk({
        ok: authoritativeDown === 0,
        checked_at: new Date().toISOString(),
        note: 'swpc-* rows are fetched browser-side on the live page; an edge 403 there is expected and does not affect users.',
        summary: { up, down, total: upstreams.length },
        upstreams,
    }, { maxAge: 30, swr: 15 });
}
