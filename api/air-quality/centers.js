/**
 * api/air-quality/centers.js — Vercel edge function: live AQI for the world's
 * major population centers, in ONE upstream call.
 *
 * GET /api/air-quality/centers
 *
 * Samples the current CAMS hour (Open-Meteo `current=` variables, keyless,
 * free) at the top-populated cities from js/data/major-cities.js — the same
 * dataset the EarthView city dots render, so the pollution-centers layer and
 * the city layer can never disagree about where a city is. Batching the
 * whole list into one multi-coordinate request means the Vercel CDN serves
 * every visitor from a single upstream fetch per cache window instead of
 * each browser hitting Open-Meteo ~100 times.
 *
 * This is MODELED CAMS data (same provenance contract as /api/air-quality/
 * grid) — never a station observation; consumers keep the distinction.
 *
 * Response shape:
 *   {
 *     updated, count, freshness: 'live'|'stale',
 *     provenance: CAMS_PROVENANCE,
 *     cities: [{ name, country, lat, lon, pop,
 *                aqi, pm25, pm10, ozone, no2, aod, time }],
 *     worst:  [ up to 10 city names ranked by AQI desc ]
 *   }
 *
 * Failure mode: 200 + freshness:'stale' + empty list (CLAUDE.md §8) so the
 * layer reads "no data" and status.html scores amber, not green.
 *
 * CDN cache: 15 minutes (CAMS is interpolated hourly; 15 min matches the
 * page-side AirQualityFeed refresh cadence).
 */

import { jsonOk, fetchWithTimeout } from '../_lib/responses.js';
import { CAMS_PROVENANCE } from '../../js/air-quality-frame.js';
import { MAJOR_CITIES } from '../../js/data/major-cities.js';

export const config = { runtime: 'edge' };

const CAMS_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
// Variable ladder. Open-Meteo errors the WHOLE multi-coordinate request on
// one unknown variable name, so the greenhouse-gas fields (carbon_dioxide,
// methane — CAMS additions whose availability has shifted between upstream
// releases) are requested through a RETRY LADDER: full set → minus methane
// → the known-good base. Each rung only drops the vars that could have
// caused the failure, so a bad methane name can never cost us CO₂, and
// nothing exotic can ever take the whole city feed down. The response's
// `speciesAvailability` says which rung served.
const BASE_VARS = 'us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide,dust,aerosol_optical_depth';
const VAR_LADDER = [
    { vars: `${BASE_VARS},carbon_dioxide,methane`, co2: true, ch4: true },
    { vars: `${BASE_VARS},carbon_dioxide`, co2: true, ch4: false },
    { vars: BASE_VARS, co2: false, ch4: false },
];

// One batched request stays well under URL limits at 100 coordinates
// (~2.5 kB of query string) while covering every metro ≥ ~1.5 M plus the
// dataset's deliberate coverage cities that make the population cut.
const MAX_CITIES = 100;

export function selectCenterCities(cities = MAJOR_CITIES, max = MAX_CITIES) {
    return [...cities]
        .filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lon) && Number.isFinite(c.p))
        .sort((a, b) => b.p - a.p)
        .slice(0, max);
}

function num(v) { return Number.isFinite(v) ? v : null; }

export function normalizeCenters(payload, cities) {
    const locations = Array.isArray(payload) ? payload : payload ? [payload] : [];
    const out = [];
    for (let i = 0; i < cities.length && i < locations.length; i++) {
        const cur = locations[i]?.current ?? {};
        const row = {
            name: cities[i].n,
            country: cities[i].c,
            lat: cities[i].lat,
            lon: cities[i].lon,
            pop: cities[i].p,
            aqi: num(cur.us_aqi),
            pm25: num(cur.pm2_5),
            pm10: num(cur.pm10),
            ozone: num(cur.ozone),
            no2: num(cur.nitrogen_dioxide),
            so2: num(cur.sulphur_dioxide),
            co: num(cur.carbon_monoxide),
            co2: num(cur.carbon_dioxide),
            ch4: num(cur.methane),
            dust: num(cur.dust),
            aod: num(cur.aerosol_optical_depth),
            time: Number.isFinite(cur.time) ? new Date(cur.time * 1000).toISOString() : null,
        };
        if (row.aqi != null || row.pm25 != null) out.push(row);
    }
    return out;
}

async function fetchCams(cities, currentVars) {
    const params = new URLSearchParams({
        latitude: cities.map(c => c.lat).join(','),
        longitude: cities.map(c => c.lon).join(','),
        current: currentVars,
        domains: 'cams_global',
        cell_selection: 'nearest',
        timeformat: 'unixtime',
        timezone: 'GMT',
    });
    const res = await fetchWithTimeout(`${CAMS_URL}?${params}`, {
        timeoutMs: 15_000,
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`CAMS HTTP ${res.status}`);
    const payload = await res.json();
    if (payload?.error) throw new Error(payload.reason || 'CAMS returned an error');
    return payload;
}

export default async function handler() {
    const nowMs = Date.now();
    const cities = selectCenterCities();

    try {
        // Walk the ladder; a variable-name rejection and a transient outage
        // are not distinguishable from the error string across Open-Meteo
        // versions, so each failure simply steps down one rung. Only the
        // final rung's failure degrades the route to stale.
        let payload = null;
        let rung = VAR_LADDER[VAR_LADDER.length - 1];
        let lastError = null;
        for (const candidate of VAR_LADDER) {
            try {
                payload = await fetchCams(cities, candidate.vars);
                rung = candidate;
                break;
            } catch (e) {
                lastError = e;
            }
        }
        if (!payload) throw lastError ?? new Error('CAMS unavailable');
        const co2Available = rung.co2;
        const rows = normalizeCenters(payload, cities);
        if (!rows.length) throw new Error('CAMS returned no numeric city samples');
        const worst = [...rows]
            .filter(r => r.aqi != null)
            .sort((a, b) => b.aqi - a.aqi)
            .slice(0, 10)
            .map(r => r.name);
        return jsonOk({
            updated: new Date(nowMs).toISOString(),
            count: rows.length,
            freshness: 'live',
            provenance: CAMS_PROVENANCE,
            co2Available,                                  // back-compat alias
            speciesAvailability: { co2: rung.co2, ch4: rung.ch4 },
            cities: rows,
            worst,
        }, { maxAge: 900, swr: 300 });
    } catch (e) {
        return jsonOk({
            updated: new Date(nowMs).toISOString(),
            count: 0,
            freshness: 'stale',
            provenance: CAMS_PROVENANCE,
            cities: [],
            worst: [],
            error: e?.message ?? 'unknown',
        }, { maxAge: 120, swr: 60 });
    }
}
