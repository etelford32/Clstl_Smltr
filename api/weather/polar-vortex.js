/**
 * Vercel Edge Function: /api/weather/polar-vortex
 *
 * Source: Open-Meteo GFS pressure-level API (free, no key, JSON)
 *   https://api.open-meteo.com/v1/gfs
 *
 * Returns the zonal-mean (over 6 longitudes) of temperature and the
 * eastward zonal wind component at 10/30/50 hPa over the 60°N latitude
 * band. Surfaces a vortex classification (strong / moderate / weakening
 * / disturbed / SSW) computed from current U₁₀ + the 7-day forecast
 * trend, and a 14-day daily timeseries the client uses to plot the
 * vortex evolution.
 *
 *   • U_60N(10 hPa) > 25 m/s  ⇒  strong vortex (cold air locked over Arctic)
 *   • U declines >8 m/s in 7d ⇒  weakening (often presages displacement)
 *   • U < 10 m/s              ⇒  disturbed (vortex displacement likely)
 *   • U < 0  (easterly)        ⇒  Sudden Stratospheric Warming
 *
 * SSW events typically translate to mid-latitude cold-air outbreaks
 * 10-21 days after the reversal — the operational reason this card
 * matters for terrestrial-weather forecasting.
 *
 * Response shape (~3 KB):
 *   {
 *     source, age_min, freshness,
 *     classification: { state, label, risk, detail },
 *     current:   { U_10hPa, U_30hPa, U_50hPa, T_10hPa, T_30hPa, T_50hPa },
 *     forecast_d7: { U_10hPa },
 *     daily: { time:[…14], 10:{T,U}, 30:{T,U}, 50:{T,U} },
 *     sampled_lons: [0,60,120,180,240,300],
 *     units: { T: 'K', U: 'm/s (positive = westerly)' }
 *   }
 */

import {
    jsonOk, jsonError, fetchWithTimeout, isoTag,
} from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const OPEN_METEO_GFS = 'https://api.open-meteo.com/v1/gfs';

// 6 longitudes around 60°N for a zonal-mean estimate. Good balance
// between accuracy and Open-Meteo's per-call quota.
const DEFAULT_LONS = [0, 60, 120, 180, 240, 300];
const LAT          = 60;
const LEVELS       = [10, 30, 50];   // hPa
const FORECAST_DAYS = 14;

const CACHE_TTL = 21_600;  // 6 h — GFS runs at 00/06/12/18 UTC
const CACHE_SWR = 1_800;   // 30 min stale-while-revalidate

const HOURLY_VARS = LEVELS.flatMap(p => [
    `temperature_${p}hPa`,
    `wind_speed_${p}hPa`,
    `wind_direction_${p}hPa`,
]).join(',');

// Convert meteorological wind direction (degrees FROM, 0=N, 90=E)
// + speed → eastward zonal component U. Westerly wind ⇒ U > 0.
function uFromDir(speed, dir_deg) {
    const dr = (dir_deg ?? 0) * Math.PI / 180;
    return -speed * Math.sin(dr);
}

function classifyVortex(u10_now, u10_d7) {
    if (!Number.isFinite(u10_now)) {
        return {
            state: 'unknown',
            label: 'No data',
            risk:  'unknown',
            detail:'Upstream returned no U_10hPa value.',
        };
    }
    const slope = Number.isFinite(u10_d7) ? (u10_d7 - u10_now) : 0;

    if (u10_now < 0) return {
        state: 'ssw',
        label: 'Sudden Stratospheric Warming',
        risk:  'high',
        detail:'Zonal wind at 10 hPa has reversed (easterly). Mid-latitude '
             + 'cold-air outbreak typically follows in 10–21 days.',
    };
    if (u10_now < 10) return {
        state: 'disturbed',
        label: 'Disturbed vortex',
        risk:  'elevated',
        detail:'Weak westerly. Displacement or split likely; stratospheric '
             + 'forcing on the troposphere is strong.',
    };
    if (u10_now < 20 && slope < -8) return {
        state: 'weakening',
        label: 'Weakening vortex',
        risk:  'elevated',
        detail:`Trending ${slope.toFixed(1)} m/s over 7 days — watch for `
             + 'further disruption.',
    };
    if (u10_now < 20) return {
        state: 'moderate',
        label: 'Moderate vortex',
        risk:  'low',
        detail:'Healthy westerly circulation; no near-term tropospheric '
             + 'forcing expected.',
    };
    return {
        state: 'strong',
        label: 'Strong vortex',
        risk:  'low',
        detail:'Robust westerly circulation. Cold-air locked over Arctic; '
             + 'mid-latitudes shielded.',
    };
}

function freshnessStatus(ageMin) {
    if (ageMin == null) return 'missing';
    if (ageMin < 60)    return 'fresh';
    if (ageMin < 360)   return 'stale';
    return 'expired';
}

export default async function handler(req) {
    const url = new URL(req.url);
    const sample = url.searchParams.get('sample');
    let lons = DEFAULT_LONS;
    if (sample) {
        const parsed = sample.split(',').map(Number).filter(Number.isFinite);
        if (parsed.length >= 2 && parsed.length <= 12) lons = parsed;
    }

    // Open-Meteo accepts comma-separated lat/lon for multi-location calls.
    const params = new URLSearchParams({
        latitude:          lons.map(() => String(LAT)).join(','),
        longitude:         lons.map(String).join(','),
        hourly:            HOURLY_VARS,
        forecast_days:     String(FORECAST_DAYS),
        timezone:          'UTC',
        wind_speed_unit:   'ms',
        temperature_unit:  'celsius',
    });

    let raw;
    try {
        const res = await fetchWithTimeout(`${OPEN_METEO_GFS}?${params}`, {
            headers:   { Accept: 'application/json' },
            timeoutMs: 10_000,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message,
            { source: 'Open-Meteo (GFS)' });
    }

    const samples = Array.isArray(raw) ? raw : [raw];
    if (samples.length === 0) {
        return jsonError('parse_error', 'Empty Open-Meteo response',
            { source: 'Open-Meteo (GFS)' });
    }

    const time = samples[0].hourly?.time ?? [];
    if (!time.length) {
        return jsonError('parse_error', 'No hourly data',
            { source: 'Open-Meteo (GFS)' });
    }
    const N = time.length;

    // Per-level zonal-mean T (in K) and U (m/s).
    const meanByLevel = {};
    for (const p of LEVELS) {
        const T_acc = new Array(N).fill(0), T_n = new Array(N).fill(0);
        const U_acc = new Array(N).fill(0), U_n = new Array(N).fill(0);
        for (const s of samples) {
            const T = s.hourly?.[`temperature_${p}hPa`]    ?? [];
            const W = s.hourly?.[`wind_speed_${p}hPa`]     ?? [];
            const D = s.hourly?.[`wind_direction_${p}hPa`] ?? [];
            for (let i = 0; i < N; i++) {
                if (Number.isFinite(T[i])) {
                    T_acc[i] += T[i] + 273.15;   // °C → K
                    T_n[i]++;
                }
                if (Number.isFinite(W[i]) && Number.isFinite(D[i])) {
                    U_acc[i] += uFromDir(W[i], D[i]);
                    U_n[i]++;
                }
            }
        }
        meanByLevel[p] = {
            T: T_acc.map((v, i) => T_n[i] ? v / T_n[i] : null),
            U: U_acc.map((v, i) => U_n[i] ? v / U_n[i] : null),
        };
    }

    // Hourly → daily means.
    const dailyAvg = (arr) => {
        const out = [];
        for (let i = 0; i + 24 <= arr.length; i += 24) {
            const slice = arr.slice(i, i + 24).filter(Number.isFinite);
            out.push(slice.length ? slice.reduce((a,b) => a+b, 0) / slice.length : null);
        }
        return out;
    };
    const dailyDates = (() => {
        const out = [];
        for (let i = 0; i + 24 <= time.length; i += 24) {
            out.push(String(time[i]).slice(0, 10));
        }
        return out;
    })();

    const daily = { time: dailyDates };
    for (const p of LEVELS) {
        daily[String(p)] = {
            T: dailyAvg(meanByLevel[p].T).map(round1),
            U: dailyAvg(meanByLevel[p].U).map(round1),
        };
    }

    // Today + 7-day forecast classification.
    const u10_today = daily['10'].U[0];
    const u10_d7    = daily['10'].U[7] ?? daily['10'].U.at(-1);
    const cls = classifyVortex(u10_today, u10_d7);

    const updatedISO = isoTag(time[0]);
    const updatedMs  = updatedISO ? new Date(updatedISO).getTime() : NaN;
    const ageMin     = isNaN(updatedMs) ? null : (Date.now() - updatedMs) / 60_000;

    return jsonOk({
        source:   'Open-Meteo GFS · stratosphere @ 60°N (zonal-mean)',
        age_min:  ageMin != null ? Math.round(ageMin) : null,
        freshness: freshnessStatus(ageMin),
        classification: cls,
        current: {
            U_10hPa: daily['10'].U[0],
            U_30hPa: daily['30'].U[0],
            U_50hPa: daily['50'].U[0],
            T_10hPa: daily['10'].T[0],
            T_30hPa: daily['30'].T[0],
            T_50hPa: daily['50'].T[0],
        },
        forecast_d7: { U_10hPa: u10_d7 },
        daily,
        sampled_lons: lons,
        units: { T: 'K', U: 'm/s (positive = westerly)' },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}

function round1(v) {
    return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}
