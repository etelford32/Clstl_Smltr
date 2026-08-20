/**
 * api/air-quality/history.js — the Pollution Lab's time machine feed.
 *
 * GET /api/air-quality/history?past=<hours>&future=<hours>&step=<hours>
 *
 * ONE batched CAMS request returns an hourly PM2.5 series for every metro the
 * pollution-centers layer draws PLUS the sparse global background grid the
 * EarthView air-quality layer samples — the same two coordinate sets already
 * used elsewhere, so the history frames and the live frame can never disagree
 * about where a city is or where the background is measured.
 *
 * WHY ONE ROUTE AND NOT N CALLS TO /grid?at=…: the lab scrubs ~145 frames.
 * Asking /grid once per hour is 145 upstream round-trips per visitor and gives
 * the city layer nothing. Open-Meteo bills a multi-coordinate multi-hour
 * request as one call, so the CDN serves every visitor from a single upstream
 * fetch per cache window — the same economics argument that shaped centers.js.
 *
 * PM2.5 ONLY, and deliberately: the lab's field, cluster weights, colors and
 * radiative-forcing numbers are all PM2.5 (see the cityPm() comment in
 * pollution.html for what happened when they were not). Requesting us_aqi too
 * would double the payload to ship a composite index the page does not draw.
 * AQI is derived where needed through js/aqi-scale.js — one EPA table, ours.
 *
 * This is MODELED CAMS data — reanalysis-grade for past hours, forecast for
 * future ones, never a station observation. `provenance` says so and the page
 * repeats it; the response also splits the axis at `nowIndex` so a consumer
 * can draw the forecast tail differently, which the Pollution Lab does.
 *
 * Failure mode: 200 + freshness:'stale' + empty rows (CLAUDE.md §8) so the
 * page reads "history unavailable" and status.html scores amber, not green.
 * A partial upstream (some sites returned, some not) stays 'live' but reports
 * `coverage` < 1, and drops below 0.5 to 'degraded' — a half-empty history
 * that scrubs to blank frames is not a healthy feed.
 *
 * CDN cache: 30 minutes. CAMS publishes hourly; a scrub window is stable for
 * far longer than a live sample, and the payload is ~100 kB.
 *
 * UPSTREAM SHAPE: the multi-coordinate `hourly` response is parsed exactly the
 * way api/air-quality/grid.js + normalizeCamsFrame already parse it in
 * production (array of locations, each with `latitude`/`longitude` and an
 * `hourly.{time,pm2_5}` pair of parallel arrays, `time` in unix seconds) —
 * the only difference here is asking for a RANGE of hours rather than one.
 * Egress to Open-Meteo is blocked from the build environment, so the
 * multi-hour response was not observed directly; the normalizer is therefore
 * written to tolerate short, long, shifted and gappy arrays, and it reports
 * `coverage` so a shape surprise shows up as a partial window on status.html
 * instead of as silence.
 */

import { jsonOk, fetchWithTimeout } from '../_lib/responses.js';
import { CAMS_PROVENANCE, buildCamsGrid } from '../../js/air-quality-frame.js';
import {
    planWindow, normalizeHistory,
    DEFAULT_PAST_HOURS, DEFAULT_FUTURE_HOURS,
} from '../_lib/air-quality-history.js';
import { selectCenterCities } from './centers.js';

export const config = { runtime: 'edge' };

const CAMS_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const VARIABLE = 'pm2_5';

/**
 * Metros carried through history. Lower than centers.js's 100 because every
 * city here costs `count` numbers, not one: 60 metros × 145 frames is already
 * 8,700 values before the background grid. The cut is by population, so the
 * cities that drop are the ones the map draws smallest.
 */
const MAX_HISTORY_CITIES = 60;

function isoHour(ms) {
    return new Date(ms).toISOString().slice(0, 13) + ':00';
}

/**
 * The two coordinate sets, in ONE list, cities first. Position is the join
 * key for the upstream response, so the order here is part of the contract
 * between the request and normalizeHistory().
 */
export function buildHistorySites(maxCities = MAX_HISTORY_CITIES) {
    const cities = selectCenterCities(undefined, maxCities).map(c => ({
        lat: c.lat,
        lon: c.lon,
        meta: { kind: 'city', name: c.n, country: c.c, pop: c.p },
    }));
    const background = buildCamsGrid('global').coordinates.map((p, i) => ({
        lat: p.lat,
        lon: p.lon,
        meta: { kind: 'background', id: `cams-bg-${i}` },
    }));
    return { sites: [...cities, ...background], cityCount: cities.length };
}

async function fetchCamsHistory(sites, window) {
    const params = new URLSearchParams({
        latitude: sites.map(s => s.lat).join(','),
        longitude: sites.map(s => s.lon).join(','),
        hourly: VARIABLE,
        domains: 'cams_global',
        cell_selection: 'nearest',
        timeformat: 'unixtime',
        timezone: 'GMT',
        start_hour: isoHour(window.startMs),
        end_hour: isoHour(window.endMs),
    });
    const res = await fetchWithTimeout(`${CAMS_URL}?${params}`, {
        timeoutMs: 20_000,
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`CAMS HTTP ${res.status}`);
    const payload = await res.json();
    if (payload?.error) throw new Error(payload.reason || 'CAMS returned an error');
    return payload;
}

export default async function handler(request) {
    const nowMs = Date.now();
    const url = new URL(request.url);
    const window = planWindow({
        pastHours: url.searchParams.get('past') ?? DEFAULT_PAST_HOURS,
        futureHours: url.searchParams.get('future') ?? DEFAULT_FUTURE_HOURS,
        stepHours: url.searchParams.get('step') ?? 1,
        nowMs,
    });

    const base = {
        updated: new Date(nowMs).toISOString(),
        provenance: CAMS_PROVENANCE,
        variable: 'pm25',
        units: { pm25: 'µg/m³' },
        window: {
            startMs: window.startMs,
            endMs: window.endMs,
            stepHours: window.stepHours,
            count: window.count,
            nowIndex: window.nowIndex,
            pastHours: window.pastHours,
            futureHours: window.futureHours,
            clamped: window.clamped,
        },
        times: window.times,
    };

    try {
        const { sites, cityCount } = buildHistorySites();
        const payload = await fetchCamsHistory(sites, window);
        const cities = normalizeHistory(payload, sites.slice(0, cityCount), window.times);
        const bgSites = sites.slice(cityCount);
        const bgPayload = Array.isArray(payload) ? payload.slice(cityCount) : [];
        const background = normalizeHistory(bgPayload, bgSites, window.times);

        if (!cities.rows.length && !background.rows.length) {
            throw new Error('CAMS returned no numeric series for any site');
        }
        // ONE figure over the true (site × hour) slot count, not an average of
        // two ratios: a full city set with a dead background grid must not read
        // as fully healthy — the field would have no support outside the metros
        // and the scrub would look flat over every ocean.
        const slots = cities.slots + background.slots;
        const coverage = slots
            ? Math.round(((cities.filled + background.filled) / slots) * 100) / 100
            : 0;

        return jsonOk({
            ...base,
            freshness: coverage < 0.5 ? 'degraded' : 'live',
            coverage,
            cities: cities.rows,
            background: background.rows,
            counts: {
                cities: cities.rows.length,
                cityRequested: cityCount,
                background: background.rows.length,
                backgroundRequested: bgSites.length,
            },
            ...(coverage < 0.5
                ? { note: `only ${Math.round(coverage * 100)}% of the requested hours came back` }
                : {}),
        }, { maxAge: 1800, swr: 600 });
    } catch (e) {
        return jsonOk({
            ...base,
            freshness: 'stale',
            coverage: 0,
            cities: [],
            background: [],
            counts: { cities: 0, background: 0 },
            error: e?.message ?? 'unknown',
        }, { maxAge: 120, swr: 60 });
    }
}
