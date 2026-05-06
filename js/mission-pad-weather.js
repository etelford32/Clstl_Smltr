/**
 * mission-pad-weather.js — Live weather feed for the mission planner's
 * launch pads, with server-side proxies and 24-hour forecast lookahead.
 *
 * ── Data sources ──────────────────────────────────────────────────────
 *
 *   Earth pads → /api/weather/forecast?type=launch
 *     Edge-cached Open-Meteo proxy (15 min s-maxage / 10 min SWR), so
 *     N concurrent simulator users hitting the same pad coords share a
 *     single upstream call. Returns current conditions + a 7-day hourly
 *     strip; we use the hourly arrays to compute the lookahead — when
 *     does the launch gate flip from go → scrub or vice versa within
 *     the next 24 h?
 *
 *   Mars sites → /api/mars/weather
 *     Aggregator that combines a server-side Ls computation (dust-season
 *     status) with NASA's public InSight historical archive. The client
 *     used to compute Ls locally; moving it server-side dedupes math
 *     across users and lets us cache the InSight response.
 *
 *   Moon bases → synthetic, client-side
 *     No atmospheric weather; only constraint is solar incidence at
 *     polar pads. Trivial to compute, not worth a round trip.
 *
 * ── Forecast lookahead ────────────────────────────────────────────────
 *
 *   The Earth proxy returns an `hourly` block with wind, gusts, precip,
 *   cloud, and the WMO weather code for every hour over the next 7 days.
 *   We replay evaluateLaunchRules() on each hourly sample, find the
 *   first hour whose status differs from the current one, and surface
 *   that to the planner via setPadWeather(..., { lookahead }).
 *
 *   The UI then shows hints like "⏰ GO window opens in 3h" near the
 *   Launch button when current is scrub/caution, or "⚠ Scrub by T+5h"
 *   when current is go but a violation is forecast.
 *
 * ── Public API ────────────────────────────────────────────────────────
 *
 *   startWeatherFeed(planner, opts) → { stop(), refreshNow() }
 *
 *   Polls every 15 min by default. On fetch error, the affected pad is
 *   marked 'unknown' with the error string; everything else continues.
 *
 *   Pure helpers re-exported for unit tests:
 *     evaluateLaunchRules, evaluateMoonConditions, marsLs, computeLookahead
 */

import { LAUNCH_SITES, MOON_BASES, MARS_BIOMES } from './mission-planner-3d.js';

const POLL_MS          = 15 * 60 * 1000;     // 15 minutes
const FETCH_TIMEOUT_MS = 8000;
const FORECAST_API     = '/api/weather/forecast';
const MARS_API         = '/api/mars/weather';
const LOOKAHEAD_HOURS  = 24;                 // how far we scan for the next status change

// ── WMO weather-code helpers ────────────────────────────────────────────
const isThunder     = wc => wc >= 95;
const isHeavyPrecip = wc => wc === 65 || wc === 67 || wc === 75 || wc === 77 || wc === 82 || wc === 86;
const isLightPrecip = wc => (wc >= 51 && wc <= 63) || wc === 71 || wc === 73 || (wc >= 80 && wc <= 81) || wc === 85;
const isFog         = wc => wc === 45 || wc === 48;

// ── Fetch helpers ───────────────────────────────────────────────────────
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

// ── Unit conversion ─────────────────────────────────────────────────────
// The /api/weather/forecast?type=launch proxy returns wind in mph (matches
// the existing trip-planner consumers). Aviation/launch weather is canonical
// in knots, so we convert at the boundary. 1 mph = 0.868976 kt.
const MPH_TO_KT = 0.868976;
const F_TO_C    = f => (f - 32) * 5 / 9;

// ── Launch commit criteria (in knots) ───────────────────────────────────
// SCRUB: lightning (WMO 95-99), heavy precip (65/67/75/77/82/86), wind
//        > 26 kt sustained or > 30 kt gust.
// CAUTION: gusts > 22 kt, sustained > 18 kt, light precip, fog, cloud > 90%.
function evaluateLaunchRules(wx) {
    if (!wx) return { status: 'unknown', message: 'No weather data' };
    // Fields are mph + °F from the proxy; convert at the rule boundary so
    // the rest of this function reads in launch-canonical units.
    const wind  = (wx.wind_speed_10m  ?? 0) * MPH_TO_KT;
    const gust  = (wx.wind_gusts_10m  ?? wx.wind_speed_10m ?? 0) * MPH_TO_KT;
    const precip= wx.precipitation    ?? 0;
    const cloud = wx.cloud_cover      ?? 0;
    const wc    = wx.weather_code     ?? 0;
    const tempF = wx.temperature_2m   ?? 0;
    const tempC = F_TO_C(tempF);

    if (isThunder(wc))     return { status: 'scrub',   message: `Thunderstorm at pad · WMO ${wc}` };
    if (isHeavyPrecip(wc)) return { status: 'scrub',   message: `Heavy precipitation · WMO ${wc}` };
    if (gust > 30)         return { status: 'scrub',   message: `Gusts ${gust.toFixed(0)} kt > 30 kt limit` };
    if (wind > 26)         return { status: 'scrub',   message: `Sustained ${wind.toFixed(0)} kt > 26 kt limit` };

    if (gust > 22)         return { status: 'caution', message: `Gusts ${gust.toFixed(0)} kt · marginal` };
    if (wind > 18)         return { status: 'caution', message: `Wind ${wind.toFixed(0)} kt · marginal` };
    if (isLightPrecip(wc)) return { status: 'caution', message: `Light precipitation · WMO ${wc}` };
    if (isFog(wc))         return { status: 'caution', message: 'Fog · visibility constraint' };
    if (cloud > 90)        return { status: 'caution', message: `${cloud}% overcast` };

    return {
        status:  'go',
        message: `Wind ${wind.toFixed(0)} kt · ${cloud}% cloud · ${tempC.toFixed(0)}°C${precip > 0 ? ` · trace precip` : ''}`,
    };
}

// ── Forecast lookahead ──────────────────────────────────────────────────
// Scans the next LOOKAHEAD_HOURS of hourly data for the first hour whose
// status differs from `currentStatus`. Returns:
//   { next_status, next_message, hours_until, time_iso }
// or null when the next 24 h is uniformly the same status as now.
function computeLookahead(hourly, currentStatus) {
    if (!hourly?.time?.length) return null;
    const now = Date.now();
    const hoursAvail = hourly.time.length;
    // hourly.time entries are local-tz strings like "2026-05-06T15:00".
    // Open-Meteo uses `timezone=auto`, so each entry is in the pad's local
    // tz with no offset suffix. Date.parse() treats them as local time of
    // the runtime, which differs from the pad's tz — close enough for the
    // 1-hour resolution we care about, since we only count discrete steps
    // between samples (each is exactly 1 h apart).
    const startIdx = (() => {
        for (let i = 0; i < hoursAvail; i++) {
            // Find the first hour at-or-after now (samples are ordered).
            const t = Date.parse(hourly.time[i]);
            if (Number.isFinite(t) && t >= now - 30 * 60_000) return i;
        }
        return -1;
    })();
    if (startIdx < 0) return null;

    const stop = Math.min(startIdx + LOOKAHEAD_HOURS, hoursAvail);
    for (let i = startIdx + 1; i < stop; i++) {
        const wx = sampleAt(hourly, i);
        const r  = evaluateLaunchRules(wx);
        if (r.status !== currentStatus) {
            return {
                next_status:  r.status,
                next_message: r.message,
                hours_until:  i - startIdx,
                time_iso:     hourly.time[i],
            };
        }
    }
    return null;
}

function sampleAt(hourly, i) {
    return {
        wind_speed_10m: hourly.wind_speed_10m?.[i],
        wind_gusts_10m: hourly.wind_gusts_10m?.[i],
        precipitation:  hourly.precipitation?.[i],
        cloud_cover:    hourly.cloud_cover?.[i],
        weather_code:   hourly.weather_code?.[i],
        temperature_2m: hourly.temperature_2m?.[i],
    };
}

// ── Earth pad refresh ───────────────────────────────────────────────────
async function fetchEarthLaunchForecast(pad) {
    const url = `${FORECAST_API}?type=launch&lat=${pad.lat.toFixed(3)}&lon=${pad.lon.toFixed(3)}&days=2`;
    return fetchWithTimeout(url, FETCH_TIMEOUT_MS);
}

// ── Moon synthetic ──────────────────────────────────────────────────────
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

// ── Mars Ls (kept client-side for unit tests; server is authoritative) ──
const MARS_YEAR_DAYS = 686.971;
const MARS_LS0_JD    = 2460565.5;
function marsLs(jd) {
    const t = ((jd - MARS_LS0_JD) / MARS_YEAR_DAYS) % 1;
    return ((t < 0 ? t + 1 : t) * 360);
}

// Mars edge-function call returns one global record (Ls + a `rovers` map
// with one record per public NASA in-situ feed). The client maps each
// pad to its closest rover so the Mars site shows real surface data
// (when the feed is online) instead of just synthetic Ls flavour.
async function fetchMarsAggregate(jd) {
    const url = `${MARS_API}?jd=${encodeURIComponent(jd.toFixed(2))}`;
    return fetchWithTimeout(url, FETCH_TIMEOUT_MS);
}

// Pad → rover mapping, by closest geographic proximity:
//   Jezero Outpost     ≡ Mars 2020 / Perseverance   (sits in Jezero Crater)
//   Gale Crater Base   ≡ Curiosity / MSL            (sits in Gale Crater)
//   Utopia Planitia    ≈ InSight                    (closest active feed)
//   Olympia Base       — none; Olympus Mons has no surface assets
const PAD_ROVER_MAP = {
    jezero:  'perseverance',
    gale:    'curiosity',
    utopia:  'insight',
    olympia: null,
};

// Display labels for the rover that filled in a pad's reading. Kept short
// so the badge message stays one line.
const ROVER_LABEL = {
    insight:      'InSight ref',
    curiosity:    'MSL REMS',
    perseverance: 'M2020 MEDA',
};

/**
 * Build a per-pad weather message that combines the global synthetic Ls
 * status with the closest active rover's most recent surface reading.
 * Format:
 *   "Ls 315° · late dust season · τ ≈ 0.5 · MSL REMS sol 4400: -87→-3°C, 905 Pa"
 *
 * If no rover data is available (mapped rover is offline, or pad has no
 * mapping), we fall through to the synthetic-only message so the badge
 * still shows something meaningful.
 */
function buildMarsPadMessage(agg, pad) {
    const base = agg.message || `Ls ${agg.ls_deg?.toFixed(0) ?? '?'}°`;
    const roverKey = PAD_ROVER_MAP[pad.id];
    const rover = roverKey ? agg.rovers?.[roverKey] : null;
    if (!rover || !rover.active) return base;
    const label = ROVER_LABEL[roverKey] || roverKey;
    const parts = [];
    if (Number.isFinite(rover.sol))
        parts.push(`${label} sol ${rover.sol}`);
    else
        parts.push(label);
    if (Number.isFinite(rover.max_temp_C) && Number.isFinite(rover.min_temp_C)) {
        parts.push(`${rover.min_temp_C.toFixed(0)}→${rover.max_temp_C.toFixed(0)}°C`);
    }
    if (Number.isFinite(rover.pressure_pa)) {
        parts.push(`${rover.pressure_pa.toFixed(0)} Pa`);
    }
    if (Number.isFinite(rover.wind_speed_mps)) {
        parts.push(`${rover.wind_speed_mps.toFixed(1)} m/s`);
    }
    return parts.length ? `${base} · ${parts.join(' · ')}` : base;
}

// ── Refresh orchestrator ────────────────────────────────────────────────
async function refreshAll(planner, { log }) {
    // Earth — parallel fetches against the proxy. Each returns current +
    // hourly; we evaluate rules on current and scan hourly for lookahead.
    const earthRefresh = LAUNCH_SITES.map(async (pad) => {
        try {
            const json     = await fetchEarthLaunchForecast(pad);
            const current  = evaluateLaunchRules(json.current);
            const lookahead = computeLookahead(json.hourly, current.status);
            planner.setPadWeather('earth', pad.id, current.status, current.message, { lookahead });
        } catch (err) {
            planner.setPadWeather('earth', pad.id, 'unknown',
                `Weather data unavailable (${err.message || err.name})`);
            log(`[weather] earth/${pad.id}: ${err.message || err}`);
        }
    });

    // Moon — synthetic; no proxy.
    for (const pad of MOON_BASES) {
        const r = evaluateMoonConditions(pad);
        planner.setPadWeather('moon', pad.id, r.status, r.message);
    }

    // Mars — single proxy call shared across all sites. Tracks scenario JD
    // so dust-season flags shift as the user time-scrubs.
    const jd = planner.getScenarioJD();
    try {
        const agg = await fetchMarsAggregate(jd);
        for (const pad of MARS_BIOMES) {
            planner.setPadWeather(
                'mars', pad.id,
                agg.status || 'unknown',
                buildMarsPadMessage(agg, pad),
            );
        }
    } catch (err) {
        // Fallback to client-side Ls if the proxy is down so Mars pads
        // still show meaningful data (Moon analog: no degradation).
        const Ls = marsLs(jd);
        for (const pad of MARS_BIOMES) {
            planner.setPadWeather('mars', pad.id, 'unknown',
                `Mars feed unavailable · synthetic Ls ${Ls.toFixed(0)}°`);
        }
        log(`[weather] mars: ${err.message || err}`);
    }

    await Promise.all(earthRefresh);
}

// ── Public entry point ──────────────────────────────────────────────────
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

// Pure-function exports for unit tests / didactic use. No DOM, no state.
export {
    evaluateLaunchRules,
    evaluateMoonConditions,
    computeLookahead,
    marsLs,
};
