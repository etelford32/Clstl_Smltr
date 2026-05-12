/**
 * Vercel Edge Function: /api/mars/weather
 *
 * Aggregator for Mars surface conditions used by the mission-planner pad
 * weather UI. Combines a server-side synthetic dust-season model with a
 * fan-out across every public NASA in-situ feed we can reach, so each
 * Mars pad in the simulator can be paired with the rover whose location
 * is closest:
 *
 *   ╭──────────────────────────┬───────────────────────────────────────╮
 *   │ Mars pad (sim)           │ Closest active feed                   │
 *   ├──────────────────────────┼───────────────────────────────────────┤
 *   │ Jezero Outpost           │ Mars 2020 / Perseverance MEDA         │
 *   │ Gale Crater Base         │ Curiosity / MSL REMS                  │
 *   │ Utopia Planitia          │ InSight (historical, mission ended)   │
 *   │ Olympia Base             │ — (Olympus Mons; synthetic only)      │
 *   ╰──────────────────────────┴───────────────────────────────────────╯
 *
 * ── Sources & status ──────────────────────────────────────────────────
 *
 *   InSight (Elysium Planitia, 4.5°N 135.6°E)
 *     api.nasa.gov/insight_weather — DEMO_KEY-friendly. Mission ended
 *     Dec 2022 but the endpoint still serves the last 7 sols of
 *     historical data, useful as a "what real Martian weather looks
 *     like" reference next to the synthetic Ls status.
 *
 *   Curiosity / MSL REMS (Gale Crater, 4.6°S 137.4°E)
 *     mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json
 *     Public feed serving REMS soles — daily min/max temperature,
 *     pressure, opacity, season label. Status fluctuates (NASA's
 *     mars.nasa.gov RSS feeds have been intermittent through 2024–25);
 *     we fetch with a 6 s timeout and treat any non-2xx / parse error
 *     / empty-soles response as "feed offline" so the rest of the
 *     payload is unaffected.
 *
 *   Mars 2020 / Perseverance MEDA (Jezero Crater, 18.4°N 77.5°E)
 *     mars.nasa.gov/rss/api/?feed=weather&category=mars2020&feedtype=json
 *     Same pattern. MEDA samples atmospheric T/p/relative humidity/wind
 *     down to sub-sol cadence; the daily-summary feed is what the public
 *     endpoint exposes.
 *
 * ── Response shape ────────────────────────────────────────────────────
 *
 *   {
 *     ls_deg:  314.69,
 *     status:  'caution',
 *     message: 'Ls 315° · late dust season · τ ≈ 0.5',
 *     jd:      2461166.12,
 *     rovers: {
 *       insight: {                        // null if upstream unavailable
 *         active:         false,
 *         location:       'Elysium Planitia (4.5°N, 135.6°E)',
 *         sol:            1308,
 *         min_temp_C:     -101.7,
 *         max_temp_C:     -22.8,
 *         wind_speed_mps: 6.3,
 *         pressure_pa:    734.3,
 *         note:           'InSight mission ended Dec 2022 — historical reference',
 *         source:         'NASA InSight Weather Service',
 *       },
 *       curiosity: {                      // null if mars.nasa.gov RSS feed is offline
 *         active:         true,
 *         location:       'Gale Crater (4.6°S, 137.4°E)',
 *         sol:            4400,
 *         terrestrial_date: '2024-12-12',
 *         min_temp_C:     -87,
 *         max_temp_C:     -3,
 *         pressure_pa:    905,
 *         atmo_opacity:   'Sunny',
 *         season:         'Northern Spring',
 *         ls_deg:         303,
 *         source:         'NASA MSL REMS via mars.nasa.gov',
 *       },
 *       perseverance: { ... }             // same shape as curiosity, MEDA-sourced
 *     },
 *   }
 *
 * Inactive rovers are returned as `{ active: false, reason: 'feed-offline' }`
 * (still an object, not null) so the client doesn't have to distinguish
 * "rover never existed" from "feed temporarily down".
 *
 * Cache-Control: s-maxage=3600 / swr=1800. Each rover updates ~once per
 * sol (24h 39m); 1 hr fresh + 30 min stale tolerance is plenty.
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const MARS_YEAR_DAYS = 686.971;
const MARS_LS0_JD    = 2460565.5;     // 2024-Sep-12 northern-spring equinox

const CACHE_TTL = 3600;
const CACHE_SWR = 1800;

const UPSTREAM_TIMEOUT_MS = 6000;

// Endpoints. mars.nasa.gov RSS feeds historically gate on User-Agent for
// some product types; we send a contactable UA via fetchWithTimeout's
// shared default, which already identifies the service.
const NASA_INSIGHT_BASE = 'https://api.nasa.gov/insight_weather/';
const MARS_RSS_BASE     = 'https://mars.nasa.gov/rss/api/';

// ── Helpers ─────────────────────────────────────────────────────────────
function numOrNull(v) {
    if (v == null) return null;
    if (typeof v === 'string') {
        // mars.nasa.gov RSS payloads use '--' for missing values and
        // sometimes wrap numbers in strings.
        const t = v.trim();
        if (!t || t === '--') return null;
        const n = parseFloat(t);
        return Number.isFinite(n) ? n : null;
    }
    return Number.isFinite(v) ? v : null;
}

function jdNowUtc() {
    return Date.now() / 86_400_000 + 2440587.5;
}

function marsLs(jd) {
    const t = ((jd - MARS_LS0_JD) / MARS_YEAR_DAYS) % 1;
    return ((t < 0 ? t + 1 : t) * 360);
}

function evaluateMarsLs(Ls) {
    const lsTxt = `Ls ${Ls.toFixed(0)}°`;
    if (Ls >= 250 && Ls < 310) return { status: 'caution', message: `${lsTxt} · regional dust season · τ ≈ 0.8` };
    if (Ls >= 220 && Ls < 250) return { status: 'caution', message: `${lsTxt} · entering dust season · τ ≈ 0.5` };
    if (Ls >= 310 && Ls < 340) return { status: 'caution', message: `${lsTxt} · late dust season · τ ≈ 0.5` };
    return { status: 'go', message: `${lsTxt} · clear skies · τ < 0.4` };
}

// ── Per-rover fetchers ──────────────────────────────────────────────────
// Each fetcher returns a record with `active: boolean`. On any failure
// (timeout, non-2xx, parse error, empty soles), returns
// `{ active: false, reason: '<short>' }` rather than throwing — that way
// `Promise.allSettled` will always have a useful value to surface and one
// rover going offline doesn't impact the others.

async function tryFetchInsight() {
    const apiKey = (typeof process !== 'undefined' && process.env?.NASA_API_KEY) || 'DEMO_KEY';
    const url = `${NASA_INSIGHT_BASE}?api_key=${encodeURIComponent(apiKey)}&feedtype=json&ver=1.0`;
    try {
        const r = await fetchWithTimeout(url, { timeoutMs: UPSTREAM_TIMEOUT_MS });
        if (!r.ok) return inactiveRover('insight', `HTTP ${r.status}`);
        const json = await r.json();
        const sols = json.sol_keys || [];
        if (!sols.length) return inactiveRover('insight', 'no sol_keys in response');
        const latestSol = sols[sols.length - 1];
        const data = json[latestSol];
        if (!data) return inactiveRover('insight', `sol ${latestSol} has no data block`);
        return {
            active:         true,
            location:       'Elysium Planitia (4.5°N, 135.6°E)',
            sol:            Number(latestSol),
            season:         data.Season || null,
            min_temp_C:     numOrNull(data.AT?.mn),
            max_temp_C:     numOrNull(data.AT?.mx),
            avg_temp_C:     numOrNull(data.AT?.av),
            wind_speed_mps: numOrNull(data.HWS?.av),
            pressure_pa:    numOrNull(data.PRE?.av),
            ls_deg:         numOrNull(data.Ls),
            note:           'InSight mission ended Dec 2022 — historical reference',
            source:         'NASA InSight Weather Service',
        };
    } catch (e) {
        return inactiveRover('insight', e.message || 'fetch failed');
    }
}

/**
 * Common fetcher for the mars.nasa.gov RSS-style rover weather feed.
 * Both Curiosity (msl) and Perseverance (mars2020) use the same query
 * and JSON shape; only `category` and the location label differ.
 */
async function tryFetchMarsRss({ rover, category, location }) {
    const url = `${MARS_RSS_BASE}?feed=weather&category=${category}&feedtype=json`;
    try {
        const r = await fetchWithTimeout(url, { timeoutMs: UPSTREAM_TIMEOUT_MS });
        if (!r.ok) return inactiveRover(rover, `HTTP ${r.status}`);
        const json = await r.json();
        // Historical shape: { soles: [ {sol, terrestrial_date, ls, season,
        //   min_temp, max_temp, pressure, wind_speed, atmo_opacity, ...}, ... ] }
        // The NASA backend has occasionally renamed `soles` → `sols`; accept
        // either so we don't break on a silent backend rename.
        const arr = Array.isArray(json.soles) ? json.soles
                  : Array.isArray(json.sols)  ? json.sols
                  : [];
        if (!arr.length) return inactiveRover(rover, 'no soles in response');
        // Walk forward looking for a sol with at least one numeric reading;
        // some sols are present but `--`-only when telemetry was lost.
        let latest = null;
        for (let i = arr.length - 1; i >= 0; i--) {
            const s = arr[i];
            if (numOrNull(s.min_temp) != null || numOrNull(s.max_temp) != null
                || numOrNull(s.pressure) != null) {
                latest = s;
                break;
            }
        }
        if (!latest) return inactiveRover(rover, 'all soles have null readings');
        return {
            active:           true,
            location,
            sol:              numOrNull(latest.sol),
            terrestrial_date: latest.terrestrial_date || null,
            season:           latest.season || null,
            ls_deg:           numOrNull(latest.ls),
            min_temp_C:       numOrNull(latest.min_temp),
            max_temp_C:       numOrNull(latest.max_temp),
            pressure_pa:      numOrNull(latest.pressure),
            wind_speed_mps:   numOrNull(latest.wind_speed),
            atmo_opacity:     latest.atmo_opacity || null,
            sunrise:          latest.sunrise || null,
            sunset:           latest.sunset  || null,
            source:           rover === 'curiosity' ? 'NASA MSL REMS via mars.nasa.gov'
                                                    : 'NASA Mars 2020 MEDA via mars.nasa.gov',
        };
    } catch (e) {
        return inactiveRover(rover, e.message || 'fetch failed');
    }
}

// Inactive sentinel — always returned in place of throwing so the client
// gets the same record shape regardless of upstream health. The map key
// in the response (`rovers.curiosity` etc.) already identifies which
// rover this is, so we don't repeat the name in the record itself.
function inactiveRover(_rover, reason) {
    return { active: false, reason };
}

// ── Handler ─────────────────────────────────────────────────────────────
export default async function handler(request) {
    const url = new URL(request.url);
    const jdParam = parseFloat(url.searchParams.get('jd') || '');
    const jd = Number.isFinite(jdParam) ? jdParam : jdNowUtc();
    if (!Number.isFinite(jd) || jd < 0 || jd > 1e7) {
        return jsonError('invalid_jd',
            'jd must be a finite Julian date (e.g., 2461166)',
            { status: 400, maxAge: 300 });
    }

    const Ls = marsLs(jd);
    const baseStatus = evaluateMarsLs(Ls);

    // Fan out to all three rovers in parallel. allSettled guarantees we
    // wait for the slowest rather than racing — the 6 s timeout per
    // fetcher caps total latency at ≤ 6 s in the worst case (all dead).
    const [insightR, curiosityR, perseveranceR] = await Promise.all([
        tryFetchInsight(),
        tryFetchMarsRss({
            rover:    'curiosity',
            category: 'msl',
            location: 'Gale Crater (4.6°S, 137.4°E)',
        }),
        tryFetchMarsRss({
            rover:    'mars2020',
            category: 'mars2020',
            location: 'Jezero Crater (18.4°N, 77.5°E)',
        }),
    ]);

    return jsonOk({
        ls_deg:    Number(Ls.toFixed(2)),
        status:    baseStatus.status,
        message:   baseStatus.message,
        jd,
        rovers: {
            insight:      insightR,
            curiosity:    curiosityR,
            perseverance: perseveranceR,
        },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
