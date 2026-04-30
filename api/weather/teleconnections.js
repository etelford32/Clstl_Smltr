/**
 * Vercel Edge Function: /api/weather/teleconnections
 *
 * Source: NOAA Climate Prediction Center daily AO + NAO indices
 *   AO  https://ftp.cpc.ncep.noaa.gov/cwlinks/norm.daily.ao.index.b500101.current.ascii
 *   NAO https://ftp.cpc.ncep.noaa.gov/cwlinks/norm.daily.nao.index.b500101.current.ascii
 *
 * Format: one row per day, "YYYY MM DD value" (whitespace-separated).
 * The "norm" files are normalised so values typically sit in [-3, +3]
 * with 0 = neutral.
 *
 * AO  (Arctic Oscillation) — surface-pressure anomaly between Arctic
 *     and mid-latitudes. Negative = blocked pattern, polar air leaks
 *     equatorward. Positive = zonal flow, mild mid-latitude winters.
 *
 * NAO (North Atlantic Oscillation) — Atlantic regional analog. Drives
 *     European + Eastern-US winter pattern.
 *
 * Returns the last 60 days of each index plus a regime classification,
 * sized for embedding in a card next to the polar-vortex card.
 *
 * Why this matters: AO/NAO are the surface-resolved consequences of
 * stratospheric vortex state. SSW events drive AO into strong
 * negative within 7-14 days (the "downward propagation"); that
 * negative phase persists 30-60 days. Combining live vortex state
 * with current AO + AO trend is the highest-leverage way to forecast
 * mid-latitude cold-air outbreaks 10-21 days out.
 */

import {
    jsonOk, jsonError, fetchWithTimeout, isoTag,
} from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const AO_URL  = 'https://ftp.cpc.ncep.noaa.gov/cwlinks/norm.daily.ao.index.b500101.current.ascii';
const NAO_URL = 'https://ftp.cpc.ncep.noaa.gov/cwlinks/norm.daily.nao.index.b500101.current.ascii';

const HISTORY_DAYS = 60;
const TREND_DAYS   = 7;

const CACHE_TTL = 21_600;   // 6 h — CPC publishes daily, ~24 h cadence
const CACHE_SWR = 1_800;

export default async function handler() {
    let aoText, naoText;
    try {
        const [aoRes, naoRes] = await Promise.all([
            fetchWithTimeout(AO_URL,  { timeoutMs: 10_000 }),
            fetchWithTimeout(NAO_URL, { timeoutMs: 10_000 }),
        ]);
        if (!aoRes.ok)  throw new Error(`AO HTTP ${aoRes.status}`);
        if (!naoRes.ok) throw new Error(`NAO HTTP ${naoRes.status}`);
        aoText  = await aoRes.text();
        naoText = await naoRes.text();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message,
            { source: 'NOAA CPC' });
    }

    const ao  = _parseDailyIndex(aoText);
    const nao = _parseDailyIndex(naoText);
    if (ao.history.length === 0 || nao.history.length === 0) {
        return jsonError('parse_error',
            'NOAA CPC returned no parseable rows',
            { source: 'NOAA CPC' });
    }

    const aoState  = _classifyIndex(ao.current,  ao.trend);
    const naoState = _classifyIndex(nao.current, nao.trend);
    const regime   = _classifyRegime(ao, nao);

    const updatedISO = ao.lastDate;
    const updatedMs  = updatedISO ? new Date(updatedISO + 'T12:00:00Z').getTime() : NaN;
    const ageMin     = isNaN(updatedMs) ? null : (Date.now() - updatedMs) / 60_000;

    return jsonOk({
        source:    'NOAA CPC daily AO + NAO indices',
        as_of:     updatedISO,
        age_min:   ageMin != null ? Math.round(ageMin) : null,
        freshness: _freshness(ageMin),
        ao: {
            current:  round(ao.current),
            trend_7d: round(ao.trend),
            state:    aoState.state,
            label:    aoState.label,
            history:  ao.history,
        },
        nao: {
            current:  round(nao.current),
            trend_7d: round(nao.trend),
            state:    naoState.state,
            label:    naoState.label,
            history:  nao.history,
        },
        regime,
        units: { ao: 'normalised σ', nao: 'normalised σ' },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}

// ── Parsing ────────────────────────────────────────────────────────────────

function _parseDailyIndex(text) {
    const rows = [];
    for (const line of text.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) continue;
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        const d = parseInt(parts[2], 10);
        const v = parseFloat(parts[3]);
        if (!Number.isFinite(y) || !Number.isFinite(m) ||
            !Number.isFinite(d) || !Number.isFinite(v)) continue;
        rows.push({
            date:  `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`,
            value: v,
        });
    }
    if (rows.length === 0) return { current: NaN, trend: NaN, history: [], lastDate: null };
    const tail = rows.slice(-HISTORY_DAYS);
    const current = tail[tail.length - 1].value;
    const trendStart = tail[tail.length - 1 - TREND_DAYS]?.value ?? current;
    return {
        current,
        trend:    current - trendStart,
        history:  tail.map(r => ({ date: r.date, value: round(r.value) })),
        lastDate: tail[tail.length - 1].date,
    };
}

// ── Classifiers ────────────────────────────────────────────────────────────

function _classifyIndex(current, trend) {
    if (!Number.isFinite(current)) {
        return { state: 'unknown', label: 'No data' };
    }
    if (current <= -2) return { state: 'extreme_negative',
        label: 'Extreme blocking pattern' };
    if (current <= -1) return { state: 'negative',
        label: 'Blocked pattern · cold-air leakage equatorward' };
    if (current >=  2) return { state: 'extreme_positive',
        label: 'Extreme zonal · tight jet, mild mid-latitudes' };
    if (current >=  1) return { state: 'positive',
        label: 'Zonal pattern · mild mid-latitudes' };
    if (trend  <= -0.5) return { state: 'trending_negative',
        label: 'Neutral but trending toward blocking' };
    if (trend  >=  0.5) return { state: 'trending_positive',
        label: 'Neutral but trending toward zonal' };
    return { state: 'neutral', label: 'Near-climatological neutral' };
}

function _classifyRegime(ao, nao) {
    // Combined regime — primarily driven by AO (hemispheric), NAO
    // refines the Atlantic/European subset.
    const aoNeg  = ao.current  <= -1;
    const aoPos  = ao.current  >=  1;
    const naoNeg = nao.current <= -1;
    const aoTrendNeg = ao.trend  <= -0.5;
    const aoTrendPos = ao.trend  >=  0.5;

    if (aoNeg && naoNeg) return {
        regime: 'blocked',
        label:  'Blocked · cold-air outbreak likely',
        risk:   'high',
        affected: ['US Northeast', 'Western Europe', 'Scandinavia'],
        detail: 'AO and NAO both negative — high-amplitude ridging over '
              + 'the Arctic forces cold air south. Persistent pattern; '
              + 'expect 10-21 day cold spell.',
    };
    if (aoNeg) return {
        regime: 'blocked',
        label:  'Hemispheric blocking',
        risk:   'moderate',
        affected: ['US Midwest', 'US Northeast', 'Central Europe'],
        detail: 'Negative AO but neutral NAO. Cold-air outbreaks more '
              + 'episodic; specific regions hit depend on ridge location.',
    };
    if (ao.current < 0 && aoTrendNeg) return {
        regime: 'transitioning',
        label:  'Trending toward blocked',
        risk:   'elevated',
        affected: ['US East', 'Northern Europe'],
        detail: 'AO trending negative — vortex weakening typically '
              + 'precedes by 1-2 weeks. Watch for surface cold-air '
              + 'outbreak in 7-14 days.',
    };
    if (aoPos) return {
        regime: 'zonal',
        label:  'Zonal flow · mild',
        risk:   'low',
        affected: [],
        detail: 'Positive AO — strong polar vortex contains cold air. '
              + 'Mid-latitude winters mild, jet stream tight.',
    };
    if (aoTrendPos) return {
        regime: 'transitioning',
        label:  'Trending toward zonal',
        risk:   'low',
        affected: [],
        detail: 'AO trending positive — vortex strengthening. Existing '
              + 'cold patterns expected to retreat.',
    };
    return {
        regime: 'neutral',
        label:  'Near-neutral · climatological',
        risk:   'low',
        affected: [],
        detail: 'No strong stratosphere-troposphere coupling signal '
              + 'currently. Surface pattern driven by synoptic '
              + 'variability, not annular-mode forcing.',
    };
}

function _freshness(ageMin) {
    if (ageMin == null) return 'missing';
    if (ageMin < 24 * 60)  return 'fresh';     // < 1 day
    if (ageMin < 72 * 60)  return 'stale';     // 1–3 days (weekend lag possible)
    return 'expired';
}

function round(v) {
    return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
}
