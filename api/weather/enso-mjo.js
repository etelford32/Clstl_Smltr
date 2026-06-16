/**
 * Vercel Edge Function: /api/weather/enso-mjo
 *
 * The two slowly-varying drivers the platform was missing for a month-ahead
 * outlook (AO/NAO already live at /api/weather/teleconnections):
 *
 *   ENSO — NOAA CPC Oceanic Niño Index (ONI), 3-month running Niño-3.4 SST
 *          anomaly. The dominant SEASONAL driver. ≥ +0.5 °C = El Niño,
 *          ≤ −0.5 °C = La Niña.
 *          https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt
 *
 *   MJO  — Bureau of Meteorology Real-time Multivariate MJO (RMM) index.
 *          The dominant WEEK 3–4 driver. Phase 1–8 = location of the tropical
 *          convective envelope; amplitude ≳ 1 = coherent/active.
 *          https://www.bom.gov.au/clim_data/IDCKGEM000/rmm.74toRealtime.txt
 *
 * Both are global scalars — there is no lat/lon in the request, so the edge
 * caches ONE response that serves every user on Earth. That is the whole
 * lightweight story: a few numbers a day drive every location's outlook.
 *
 * Degrades gracefully: if one source is down the other still returns, with
 * `partial: true` and a per-source status. Only a both-down case is a 503.
 *
 * Parsers (parseONI / parseRMM) are exported for unit testing against captured
 * feed samples; the live fetch is the only untested-here part and is wrapped
 * defensively.
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const ONI_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt';
const RMM_URL = 'https://www.bom.gov.au/clim_data/IDCKGEM000/rmm.74toRealtime.txt';

// ENSO updates monthly, MJO daily. A 6 h edge cache (one global entry) is far
// more often than either source changes, while keeping the page snappy.
const CACHE_TTL = 21_600;  // 6 h
const CACHE_SWR = 3_600;   // 1 h

const r2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

// ── Parsers ─────────────────────────────────────────────────────────────────

/**
 * CPC ONI ascii: header "SEAS YR TOTAL ANOM" then rows "DJF 1950 24.72 -1.53".
 * The ANOM column (index 3) of the last data row is the current ONI.
 */
export function parseONI(text) {
    let last = null;
    for (const line of String(text).split('\n')) {
        const p = line.trim().split(/\s+/);
        if (p.length < 4) continue;
        const yr = parseInt(p[1], 10);
        const anom = parseFloat(p[3]);
        if (!Number.isFinite(yr) || yr < 1900 || yr > 2100) continue; // skips the header row
        if (!Number.isFinite(anom)) continue;
        last = { seas: p[0], yr, oni: anom };
    }
    if (!last) return null;
    const oni = r2(last.oni);
    return {
        oni,
        state: oni >= 0.5 ? 'el-nino' : oni <= -0.5 ? 'la-nina' : 'neutral',
        season_label: `${last.seas} ${last.yr}`,
    };
}

/**
 * BoM RMM: a couple of header lines then whitespace rows
 *   "YYYY MM DD RMM1 RMM2 phase amplitude <flag...>"
 * Missing values are sentinels like 1.0E36, so we require a sane amplitude
 * and a phase in 1..8 and take the last valid row.
 */
export function parseRMM(text) {
    let last = null;
    for (const line of String(text).split('\n')) {
        const p = line.trim().split(/\s+/);
        if (p.length < 7) continue;
        const yr = parseInt(p[0], 10);
        const mo = parseInt(p[1], 10);
        const dy = parseInt(p[2], 10);
        const rmm1 = parseFloat(p[3]);
        const rmm2 = parseFloat(p[4]);
        const phase = parseInt(p[5], 10);
        const amp = parseFloat(p[6]);
        if (!Number.isFinite(yr) || yr < 1970 || yr > 2100) continue;
        if (!Number.isFinite(mo) || mo < 1 || mo > 12) continue;
        if (!Number.isFinite(dy) || dy < 1 || dy > 31) continue;
        if (!Number.isInteger(phase) || phase < 1 || phase > 8) continue;
        if (!Number.isFinite(amp) || amp < 0 || amp > 50) continue;   // 1.0E36 → skip
        last = { yr, mo, dy, rmm1, rmm2, phase, amp };
    }
    if (!last) return null;
    return {
        phase: last.phase,
        amplitude: r2(last.amp),
        rmm1: r2(last.rmm1),
        rmm2: r2(last.rmm2),
        date: `${last.yr}-${String(last.mo).padStart(2, '0')}-${String(last.dy).padStart(2, '0')}`,
        active: last.amp >= 1,
    };
}

// ── Handler ───────────────────────────────────────────────────────────────

export default async function handler() {
    const out = {
        source: 'NOAA CPC ONI + BoM RMM',
        as_of: null,
        enso: null,
        mjo: null,
        partial: false,
        sources: { enso: 'unavailable', mjo: 'unavailable' },
    };

    const [oniR, rmmR] = await Promise.allSettled([
        fetchWithTimeout(ONI_URL, { timeoutMs: 10_000 }),
        fetchWithTimeout(RMM_URL, { timeoutMs: 10_000 }),
    ]);

    if (oniR.status === 'fulfilled' && oniR.value.ok) {
        try {
            const enso = parseONI(await oniR.value.text());
            if (enso) { out.enso = enso; out.sources.enso = 'ok'; out.as_of = enso.season_label; }
        } catch { /* leave unavailable */ }
    }

    if (rmmR.status === 'fulfilled' && rmmR.value.ok) {
        try {
            const mjo = parseRMM(await rmmR.value.text());
            if (mjo) { out.mjo = mjo; out.sources.mjo = 'ok'; }
        } catch { /* leave unavailable */ }
    }

    out.partial = out.sources.enso !== 'ok' || out.sources.mjo !== 'ok';

    if (out.sources.enso !== 'ok' && out.sources.mjo !== 'ok') {
        return jsonError('upstream_unavailable',
            'ENSO (CPC) and MJO (BoM) sources both failed or returned no parseable rows',
            { source: 'NOAA CPC / BoM' });
    }

    return jsonOk(out, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
