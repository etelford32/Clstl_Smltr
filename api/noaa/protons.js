/**
 * Vercel Edge Function: /api/noaa/protons
 *
 * Source: GOES integral proton flux 1-day (>10, >50, >100 MeV channels)
 *   integral-protons-1-day.json  (~4 320+ records across 3 channels)
 *
 * T2 endpoint (5-minute cadence).
 * Returns only the latest reading for each energy channel — the raw file
 * is enormous (multi-channel 1-day history) and we need just one number.
 *
 * SEP storm scale follows NOAA S-scale: S1 ≥ 10 pfu (>10 MeV).
 */
import { jsonOk, jsonError, fetchWithTimeout, isoTag } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const NOAA_PROTONS = 'https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json';
const CACHE_TTL    = 300;

// NOAA S-scale (Solar Radiation Storm) based on >10 MeV integral proton flux
function sepStorm(flux10mev) {
    if (flux10mev == null) return { level: 0, label: 'None' };
    if (flux10mev >= 1e5)  return { level: 5, label: 'S5 — Extreme' };
    if (flux10mev >= 1e4)  return { level: 4, label: 'S4 — Severe' };
    if (flux10mev >= 1e3)  return { level: 3, label: 'S3 — Strong' };
    if (flux10mev >= 1e2)  return { level: 2, label: 'S2 — Moderate' };
    if (flux10mev >= 10)   return { level: 1, label: 'S1 — Minor' };
    return                        { level: 0, label: 'None' };
}

export default async function handler() {
    let raw;
    try {
        const res = await fetchWithTimeout(NOAA_PROTONS, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'NOAA SWPC' });
    }

    // NOAA returns either an array of objects (current) or a 2-D array with a
    // header row (legacy). Handle both.
    if (!Array.isArray(raw) || raw.length === 0) {
        return jsonError('parse_error', 'Unexpected integral-protons format', { source: 'NOAA SWPC' });
    }

    const fill = v => {
        if (v == null || v === '') return null;
        const n = parseFloat(v);
        return isNaN(n) || n < 0 ? null : n;
    };

    // Normalize to a uniform row shape: { time_tag, flux, energy }
    let normalized;
    if (typeof raw[0] === 'object' && !Array.isArray(raw[0])) {
        normalized = raw.map(r => ({
            time_tag: r?.time_tag ?? null,
            flux:     r?.flux,
            energy:   r?.energy ?? r?.channel ?? null,
        }));
    } else {
        const headers   = raw[0].map(String);
        const timeCol   = headers.indexOf('time_tag');
        const fluxCol   = headers.indexOf('flux');
        const energyCol = headers.indexOf('energy');
        normalized = raw.slice(1).map(r => ({
            time_tag: r[timeCol],
            flux:     r[fluxCol],
            energy:   r[energyCol],
        }));
    }

    // Group latest reading per energy channel (walk backwards — newest last).
    const channels = {};
    for (let i = normalized.length - 1; i >= 0; i--) {
        const r      = normalized[i];
        const energy = r.energy;
        if (!energy || channels[energy]) continue;
        const flux = fill(r.flux);
        if (flux == null) continue;
        channels[energy] = { flux, time_tag: r.time_tag };
        if (Object.keys(channels).length >= 3) break;
    }

    // Canonical key names (NOAA labels: '>=10 MeV', '>=50 MeV', '>=100 MeV')
    const find = mev => {
        const key = Object.keys(channels).find(k => k.includes(mev));
        return key ? channels[key] : null;
    };

    const ch10  = find('10');
    const ch50  = find('50');
    const ch100 = find('100');

    const flux10  = ch10?.flux  ?? null;
    const updatedISO = isoTag(ch10?.time_tag ?? ch50?.time_tag ?? null);
    const ageMin     = updatedISO
        ? (Date.now() - new Date(updatedISO).getTime()) / 60_000
        : null;

    const sep = sepStorm(flux10);

    return jsonOk({
        source:    'NOAA SWPC GOES primary integral-protons-1-day via Vercel Edge',
        age_min:   ageMin != null ? Math.round(ageMin * 10) / 10 : null,
        data: {
            updated: updatedISO,
            current: {
                flux_10mev_pfu:  flux10,
                flux_50mev_pfu:  ch50?.flux  ?? null,
                flux_100mev_pfu: ch100?.flux ?? null,
                sep_storm_level: sep.level,
                sep_storm_label: sep.label,
            },
        },
        units: { flux_pfu: 'pfu = particles/cm²/s/sr' },
    }, { maxAge: CACHE_TTL });
}
