/**
 * mission-pad-weather.js — Live weather feed for the mission planner's
 * launch pads.
 *
 * Wires real meteorology to the planner's pad-weather scaffold by
 * polling sources for each launch site and translating the readings
 * into the planner's vocabulary (go / caution / scrub / unknown):
 *
 *   • Earth pads — open-meteo.com /v1/forecast for the pad's lat/lon.
 *                  Free, no API key, CORS-enabled, ~10k req/day per IP.
 *                  We pull current temperature, surface wind + gusts,
 *                  precipitation, cloud cover, and the WMO weather
 *                  code, then run them through evaluateLaunchRules()
 *                  which encodes a simplified subset of NASA/Falcon
 *                  launch commit criteria.
 *
 *   • Moon bases — synthetic. There's no atmospheric weather in the
 *                  Earth sense; we surface solar incidence + radiation
 *                  flavour text based on pad latitude (polar = low sun)
 *                  so the visual scaffold reads as live data.
 *
 *   • Mars sites — synthetic from Mars solar longitude (Ls). Ls is
 *                  computed as a simple modulo over the Mars year
 *                  anchored to the 2024-Sep-12 northern-spring equinox.
 *                  Ls 220–310 is the dust-storm season (regional),
 *                  which we surface as caution with an opacity τ
 *                  estimate.
 *
 * Public API:
 *
 *   startWeatherFeed(planner, opts) → { stop(), refreshNow() }
 *
 * The feed runs an immediate refresh on call, then polls every 15 min
 * (configurable). On fetch error a pad is marked 'unknown' with the
 * error message — the rest of the system continues unaffected. Drop
 * the entire module to revert to no-feed; the planner's setPadWeather
 * scaffold survives independently.
 */

import { LAUNCH_SITES, MOON_BASES, MARS_BIOMES } from './mission-planner-3d.js';

const POLL_MS          = 15 * 60 * 1000;     // 15 minutes
const FETCH_TIMEOUT_MS = 6000;
const ENDPOINT         = 'https://api.open-meteo.com/v1/forecast';

// ── WMO weather-code helpers ────────────────────────────────────────────
// https://open-meteo.com/en/docs#weathervariables
const isThunder       = wc => wc >= 95;
const isHeavyPrecip   = wc => wc === 65 || wc === 67 || wc === 75 || wc === 77 || wc === 82 || wc === 86;
const isLightPrecip   = wc => (wc >= 51 && wc <= 63) || wc === 71 || wc === 73 || (wc >= 80 && wc <= 81) || wc === 85;
const isFog           = wc => wc === 45 || wc === 48;

// ── Open-Meteo fetch with timeout ───────────────────────────────────────
async function fetchWithTimeout(url, ms) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
    } finally {
        clearTimeout(timer);
    }
}

async function fetchEarthCurrent(pad) {
    const params = new URLSearchParams({
        latitude:         pad.lat,
        longitude:        pad.lon,
        current:          'temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,cloud_cover,weather_code',
        wind_speed_unit:  'kn',
        temperature_unit: 'celsius',
    });
    const json = await fetchWithTimeout(`${ENDPOINT}?${params}`, FETCH_TIMEOUT_MS);
    return json.current;
}

// ── Launch commit criteria (simplified) ─────────────────────────────────
// Inspired by Falcon 9 / NASA rules; scaled for educational use rather
// than legal-ops accuracy. Inputs are Open-Meteo's "current" record.
//
//   SCRUB conditions:
//     • Lightning / thunderstorm at pad           (WMO 95–99)
//     • Heavy precipitation                       (WMO 65/67/75/77/82/86)
//     • Sustained surface wind > 26 kt
//     • Wind gusts > 30 kt
//
//   CAUTION conditions:
//     • Wind 18–26 kt sustained or 22–30 kt gust
//     • Light/moderate precipitation              (WMO 51–63 / 71–73 / 80–81 / 85)
//     • Fog                                       (WMO 45 / 48)
//     • Cloud cover > 90%
//
//   GO is a concise telemetry summary.
function evaluateLaunchRules(wx) {
    if (!wx) return { status: 'unknown', message: 'No weather data' };
    const wind  = wx.wind_speed_10m  ?? 0;
    const gust  = wx.wind_gusts_10m  ?? wind;
    const precip= wx.precipitation   ?? 0;
    const cloud = wx.cloud_cover     ?? 0;
    const wc    = wx.weather_code    ?? 0;
    const temp  = wx.temperature_2m  ?? 0;

    if (isThunder(wc))       return { status: 'scrub',   message: `Thunderstorm at pad · WMO ${wc}` };
    if (isHeavyPrecip(wc))   return { status: 'scrub',   message: `Heavy precipitation · WMO ${wc}` };
    if (gust > 30)           return { status: 'scrub',   message: `Gusts ${gust.toFixed(0)} kt > 30 kt limit` };
    if (wind > 26)           return { status: 'scrub',   message: `Sustained wind ${wind.toFixed(0)} kt > 26 kt limit` };

    if (gust > 22)           return { status: 'caution', message: `Gusts ${gust.toFixed(0)} kt · marginal` };
    if (wind > 18)           return { status: 'caution', message: `Wind ${wind.toFixed(0)} kt · marginal` };
    if (isLightPrecip(wc))   return { status: 'caution', message: `Light precipitation · WMO ${wc}` };
    if (isFog(wc))           return { status: 'caution', message: 'Fog · visibility constraint' };
    if (cloud > 90)          return { status: 'caution', message: `${cloud}% overcast` };

    return {
        status:  'go',
        message: `Wind ${wind.toFixed(0)} kt · ${cloud}% cloud · ${temp.toFixed(0)}°C${precip > 0 ? ` · trace precip` : ''}`,
    };
}

// ── Moon synthetic ──────────────────────────────────────────────────────
// No atmosphere, no precipitation. The relevant constraints are solar
// incidence (power generation, surface temperature) and the radiation
// environment (driven by space weather, which we don't pull here).
// Polar pads (Shackleton, Schrödinger) are flagged caution because of
// permanent twilight; everywhere else launches are nominally GO.
function evaluateMoonConditions(pad) {
    const absLat = Math.abs(pad.lat);
    if (absLat > 80) {
        return {
            status:  'caution',
            message: `Polar twilight · solar elevation ≤ ${(90 - absLat).toFixed(1)}° · low power`,
        };
    }
    return {
        status:  'go',
        message: 'Vacuum · radiation nominal · solar incidence good',
    };
}

// ── Mars solar longitude (Ls) approximation ─────────────────────────────
// Mars year is 686.971 Earth days. Reference epoch: 2024-Sep-12 (Mars
// northern-spring equinox, Ls = 0°). The dust-storm season runs from
// southern spring through summer, peaking at Ls 230–310. This is a
// simple modulo — accurate to a few degrees, fine for surfacing
// "are we in dust season" to the pad weather UI.
const MARS_YEAR_DAYS  = 686.971;
const MARS_LS0_JD     = 2460565.5;     // 2024-Sep-12 00:00 UTC

function marsLs(jd) {
    const t = ((jd - MARS_LS0_JD) / MARS_YEAR_DAYS) % 1;
    return ((t < 0 ? t + 1 : t) * 360);
}

function evaluateMarsConditions(pad, jd) {
    const Ls = marsLs(jd);
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

// ── Refresh orchestrator ────────────────────────────────────────────────
async function refreshAll(planner, { log }) {
    // Earth — parallel fetches so the slowest pad doesn't block the rest.
    const earthRefresh = LAUNCH_SITES.map(async (pad) => {
        try {
            const wx = await fetchEarthCurrent(pad);
            const r  = evaluateLaunchRules(wx);
            planner.setPadWeather('earth', pad.id, r.status, r.message);
        } catch (err) {
            planner.setPadWeather('earth', pad.id, 'unknown',
                `Weather data unavailable (${err.message || err.name})`);
            log(`[weather] earth/${pad.id}: ${err.message || err}`);
        }
    });

    // Moon — synthetic.
    for (const pad of MOON_BASES) {
        const r = evaluateMoonConditions(pad);
        planner.setPadWeather('moon', pad.id, r.status, r.message);
    }

    // Mars — synthetic from current scenario JD so dust season tracks
    // the user's time-scrubbing.
    const jd = planner.getScenarioJD();
    for (const pad of MARS_BIOMES) {
        const r = evaluateMarsConditions(pad, jd);
        planner.setPadWeather('mars', pad.id, r.status, r.message);
    }

    await Promise.all(earthRefresh);
}

// ── Public entry point ──────────────────────────────────────────────────
/**
 * Start polling weather for every pad. Calls planner.setPadWeather() for
 * each pad whenever fresh data arrives, which the UI translates into the
 * pad's colored ring + Launch button gating + mission log entry.
 *
 * Returns a handle with stop() and refreshNow() so the UI can pause the
 * feed (e.g., during scenario time-scrub stress) or force-refresh on
 * demand (e.g., when the user picks a different pad).
 */
export function startWeatherFeed(planner, opts = {}) {
    const log = opts.log || (() => {});
    const intervalMs = opts.intervalMs || POLL_MS;
    let timer = null;
    refreshAll(planner, { log });
    timer = setInterval(() => refreshAll(planner, { log }), intervalMs);
    return {
        stop: () => {
            if (timer) { clearInterval(timer); timer = null; }
        },
        refreshNow: () => refreshAll(planner, { log }),
    };
}

// Re-exports for tests / didactic use — pure functions with no side
// effects, useful for unit-testing flight rules without a planner.
export { evaluateLaunchRules, evaluateMoonConditions, evaluateMarsConditions, marsLs };
