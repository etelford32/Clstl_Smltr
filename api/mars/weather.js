/**
 * Vercel Edge Function: /api/mars/weather
 *
 * Aggregator for Mars surface conditions used by the mission-planner pad
 * weather UI. Combines two sources, cached at the edge so neither
 * upstream gets hammered when many simulator users hit the page:
 *
 *   1. SYNTHETIC (always available)
 *      • Mars solar longitude (Ls) computed from the Mars-year cadence
 *        anchored to 2024-Sep-12 (northern-spring equinox, Ls = 0°).
 *      • Translated into a status (go / caution) with a τ-opacity
 *        flavour message via the same dust-season heuristic the client
 *        used to run locally — moved server-side so the math is shared
 *        and the answer caches.
 *
 *   2. REAL (best-effort, optional)
 *      • NASA InSight Mars Weather API (api.nasa.gov/insight_weather).
 *        InSight ended its mission Dec 2022, but the endpoint still
 *        returns the last 7 sols of historical data. We surface the
 *        most recent reading as flavour + reference even when the
 *        synthetic season is the gating signal.
 *
 *      • If the real source 404s, times out, or returns an empty
 *        sol_keys array, the response just omits the `insight` field —
 *        callers handle null gracefully (they're surfacing it as
 *        nice-to-have context, not driving the launch gate with it).
 *
 *      Future: swap or add Mars 2020 / Curiosity REMS feeds if NASA
 *      exposes them in JSON form. Slot here without changing the
 *      response shape.
 *
 * ── Query params ────────────────────────────────────────────────────────────
 *   ?jd=<julian-date>   Optional. Override the timestamp Ls is computed at,
 *                       so the client can ask "what does Mars look like at
 *                       scenario JD 2462000?" while scrub-time-warping.
 *                       Defaults to Date.now() if absent or non-finite.
 *   ?lat=<deg>&?lon=<deg>  Optional. Reserved for future per-site weather
 *                          (e.g., dust-storm hemispheric asymmetry); the
 *                          synthetic model is currently global, but accepting
 *                          the params now means the client can stay on the
 *                          same URL shape when site-specific data arrives.
 *
 * ── Response ───────────────────────────────────────────────────────────────
 *   {
 *     ls_deg:    314.5,
 *     status:    'caution',
 *     message:   'Ls 314° · late dust season · τ ≈ 0.5',
 *     jd:        2461166.123,
 *     insight:   {                    // null if upstream unavailable
 *       sol:            1308,
 *       season:         'Late Winter',
 *       min_temp_C:     -101.7,
 *       max_temp_C:     -22.8,
 *       wind_speed_mps: 6.3,
 *       pressure_pa:    734.3,
 *       location:       'Elysium Planitia (4.5°N, 135.6°E)',
 *       note:           'InSight mission ended Dec 2022; data is historical reference',
 *     },
 *   }
 *
 *   Cache-Control: s-maxage=3600 (1 hr fresh) / swr=1800 (30 min stale).
 *   Ls drifts ~0.5° per Earth-day, so an hour of staleness is invisible
 *   to users. InSight historical data is by definition immutable.
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const MARS_YEAR_DAYS = 686.971;
const MARS_LS0_JD    = 2460565.5;     // 2024-Sep-12 northern-spring equinox

// Cache: Ls + InSight historical both change slowly (Ls: 0.5°/day; InSight:
// historical so never changes). 1 hr fresh covers all reasonable use, and
// the long SWR window means upstream blips never reach the client.
const CACHE_TTL = 3600;
const CACHE_SWR = 1800;

// NASA's public InSight weather API. DEMO_KEY is rate-limited but works;
// a real NASA_API_KEY env var unlocks the higher quota when configured.
const NASA_INSIGHT_BASE = 'https://api.nasa.gov/insight_weather/';
const UPSTREAM_TIMEOUT_MS = 6000;

function jdNowUtc() {
    return Date.now() / 86_400_000 + 2440587.5;
}

function marsLs(jd) {
    const t = ((jd - MARS_LS0_JD) / MARS_YEAR_DAYS) % 1;
    return ((t < 0 ? t + 1 : t) * 360);
}

// Same dust-season ladder the client used pre-proxy. Centralising here so
// the rule logic lives next to the data; client just renders.
function evaluateMarsLs(Ls) {
    const lsTxt = `Ls ${Ls.toFixed(0)}°`;
    if (Ls >= 250 && Ls < 310) {
        return { status: 'caution', message: `${lsTxt} · regional dust season · τ ≈ 0.8` };
    }
    if (Ls >= 220 && Ls < 250) {
        return { status: 'caution', message: `${lsTxt} · entering dust season · τ ≈ 0.5` };
    }
    if (Ls >= 310 && Ls < 340) {
        return { status: 'caution', message: `${lsTxt} · late dust season · τ ≈ 0.5` };
    }
    return { status: 'go', message: `${lsTxt} · clear skies · τ < 0.4` };
}

async function tryFetchInsight() {
    const apiKey = (typeof process !== 'undefined' && process.env?.NASA_API_KEY) || 'DEMO_KEY';
    const url = `${NASA_INSIGHT_BASE}?api_key=${encodeURIComponent(apiKey)}&feedtype=json&ver=1.0`;
    try {
        const r = await fetchWithTimeout(url, { timeoutMs: UPSTREAM_TIMEOUT_MS });
        if (!r.ok) return null;
        const json = await r.json();
        const sols = json.sol_keys || [];
        if (!sols.length) return null;
        // sol_keys is ascending; take the most-recent one.
        const latestSol = sols[sols.length - 1];
        const data = json[latestSol];
        if (!data) return null;
        return {
            sol:            Number(latestSol),
            season:         data.Season || null,
            // NASA returns Celsius for AT (atmospheric temperature),
            // m/s for HWS (horizontal wind speed), and Pa for PRE
            // (atmospheric pressure). Pass through as-is; client formats.
            min_temp_C:     numOrNull(data.AT?.mn),
            max_temp_C:     numOrNull(data.AT?.mx),
            avg_temp_C:     numOrNull(data.AT?.av),
            wind_speed_mps: numOrNull(data.HWS?.av),
            pressure_pa:    numOrNull(data.PRE?.av),
            // InSight reports its own Ls — useful for a sanity-check
            // against our synthetic computation (should agree within ~1°).
            insight_ls_deg: numOrNull(data.Ls),
            location:       'Elysium Planitia (4.5°N, 135.6°E)',
            note:           'InSight mission ended Dec 2022; reading is historical reference',
        };
    } catch {
        return null;
    }
}

function numOrNull(v) {
    return Number.isFinite(v) ? v : null;
}

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
    const insight = await tryFetchInsight();

    return jsonOk({
        ls_deg:    Number(Ls.toFixed(2)),
        status:    baseStatus.status,
        message:   baseStatus.message,
        jd,
        insight,
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
