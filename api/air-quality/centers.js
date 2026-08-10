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
// carbon_dioxide (ppm) rides CAMS' greenhouse-gas fields. It is requested
// with a RETRY-WITHOUT fallback below: if the upstream ever rejects the
// variable name (Open-Meteo errors the WHOLE multi-coordinate request on an
// unknown variable), the second attempt drops it rather than taking the
// city feed down. `co2Available` in the response says which path served.
const CURRENT_VARS = 'us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,aerosol_optical_depth,carbon_dioxide';
const CURRENT_VARS_NO_CO2 = 'us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,aerosol_optical_depth';

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
            co2: num(cur.carbon_dioxide),
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
        let payload;
        let co2Available = true;
        try {
            payload = await fetchCams(cities, CURRENT_VARS);
        } catch (e) {
            // A variable-name rejection and a transient outage are not
            // distinguishable from the error string across Open-Meteo
            // versions, so any first-attempt failure gets one retry on the
            // known-good variable set before the route degrades to stale.
            payload = await fetchCams(cities, CURRENT_VARS_NO_CO2);
            co2Available = false;
        }
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
            co2Available,
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
