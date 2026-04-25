/**
 * Vercel Edge Function: /api/weather/surface-outlook
 *
 * The "vortex-to-surface-weather" combiner. Calls
 *   /v1/weather/polar-vortex   (Open-Meteo GFS stratosphere)
 *   /v1/weather/teleconnections (NOAA CPC AO + NAO)
 * and emits a single regime forecast that bridges the stratosphere to
 * the surface response 7-21 days out.
 *
 * Why this exists: the polar-vortex card and the AO/NAO card each
 * answer half the question. The actionable signal — "is a cold-air
 * outbreak coming, where, and with what confidence" — comes from
 * combining them. Three regimes:
 *
 *   • coupled-cold     SSW or weak vortex AND AO already negative.
 *                      Surface cold pattern in progress; expect
 *                      persistence 30-60 days.
 *
 *   • emerging-cold    Vortex weakening / SSW AND AO neutral or
 *                      trending negative. Surface response in
 *                      7-21 days; high-confidence cold outbreak
 *                      forecast.
 *
 *   • mild-zonal       Strong vortex AND AO positive. Tight jet,
 *                      cold air locked over Arctic.
 *
 *   • decoupled        Vortex strong/disturbed but AO disagrees.
 *                      Stratosphere-troposphere coupling weak;
 *                      defer to synoptic-scale forecast.
 *
 *   • neutral          Both signals near-climatological.
 *
 * Confidence scales with the strength of the coupling (vortex risk +
 * |AO|).
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const CACHE_TTL = 21_600;   // 6 h
const CACHE_SWR = 1_800;

export default async function handler(req) {
    const url = new URL(req.url);
    // Pass through to the proxies on the same origin so this composes
    // cleanly behind a single deploy. Both endpoints are themselves
    // long-cached, so the doubled fan-out is cheap.
    const origin = url.origin;

    let vortex, teleco;
    try {
        const [vRes, tRes] = await Promise.all([
            fetchWithTimeout(`${origin}/v1/weather/polar-vortex`,    { timeoutMs: 12_000 }),
            fetchWithTimeout(`${origin}/v1/weather/teleconnections`, { timeoutMs: 12_000 }),
        ]);
        if (!vRes.ok)  throw new Error(`polar-vortex HTTP ${vRes.status}`);
        if (!tRes.ok)  throw new Error(`teleconnections HTTP ${tRes.status}`);
        vortex = await vRes.json();
        teleco = await tRes.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message,
            { source: 'surface-outlook composer' });
    }

    const out = _combine(vortex, teleco);
    return jsonOk({
        source: 'Parker Physics surface-outlook · vortex × AO/NAO combiner',
        as_of:  new Date().toISOString(),
        ...out,
        drivers: {
            vortex: {
                state:    vortex.classification?.state,
                u10_now:  vortex.current?.U_10hPa,
                u10_d7:   vortex.forecast_d7?.U_10hPa,
            },
            ao: {
                current:  teleco.ao?.current,
                trend_7d: teleco.ao?.trend_7d,
                state:    teleco.ao?.state,
            },
            nao: {
                current:  teleco.nao?.current,
                trend_7d: teleco.nao?.trend_7d,
                state:    teleco.nao?.state,
            },
        },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}

function _combine(vortex, teleco) {
    const vState = vortex?.classification?.state ?? 'unknown';
    const ao  = teleco?.ao?.current  ?? null;
    const nao = teleco?.nao?.current ?? null;
    const aoTrend = teleco?.ao?.trend_7d ?? 0;

    const stratoCold = (vState === 'ssw' || vState === 'disturbed' ||
                        vState === 'weakening');
    const stratoMild = (vState === 'strong');
    const aoNegative = Number.isFinite(ao)  && ao  <= -1;
    const aoPositive = Number.isFinite(ao)  && ao  >=  1;
    const aoTrendNeg = Number.isFinite(aoTrend) && aoTrend <= -0.5;

    // Confidence: scaled by the magnitude of agreement between the
    // two systems. Coupled-cold or emerging-cold with a strong AO
    // anomaly → high confidence. Decoupled or neutral → low.
    let confidence = 0.4;

    let regime, label, risk, leadTimeDays, affected, summary;

    if (stratoCold && aoNegative) {
        regime = 'coupled-cold';
        label  = 'Stratosphere-troposphere coupling — cold pattern in progress';
        risk   = 'high';
        leadTimeDays = 0;
        affected = _affectedRegions(nao);
        confidence = 0.8 + Math.min(0.15, Math.abs(ao) * 0.05);
        summary =
            `${vortex.classification.label} aligned with AO ${ao.toFixed(1)} `
          + `(${teleco.ao.label.toLowerCase()}). Cold pattern is locked in; `
          + `expect persistence 30-60 days. Affected: ${affected.join(', ') || 'mid-latitudes broadly'}.`;
    } else if (stratoCold && (Number.isFinite(ao) && (ao < 0 || aoTrendNeg))) {
        regime = 'emerging-cold';
        label  = 'Cold-air outbreak emerging';
        risk   = 'elevated';
        leadTimeDays = vState === 'ssw' ? 14 : 10;
        affected = _affectedRegions(nao);
        confidence = 0.65 + (vState === 'ssw' ? 0.1 : 0);
        summary =
            `Stratospheric vortex ${vortex.classification.label.toLowerCase()} `
          + `with AO ${ao.toFixed(1)} (trend ${aoTrend > 0 ? '+' : ''}${aoTrend.toFixed(1)}). `
          + `Surface cold-air outbreak expected in ${leadTimeDays} days. `
          + `Watch ${affected.join(' / ') || 'mid-latitudes'}.`;
    } else if (stratoMild && aoPositive) {
        regime = 'mild-zonal';
        label  = 'Zonal · mild winter pattern';
        risk   = 'low';
        leadTimeDays = 0;
        affected = [];
        confidence = 0.75;
        summary =
            `Strong polar vortex (U₁₀ = ${vortex.current.U_10hPa.toFixed(1)} m/s) `
          + `aligned with AO ${ao.toFixed(1)}. Cold air locked over the Arctic; `
          + 'mid-latitudes shielded. Tight jet stream, fast-moving systems.';
    } else if (stratoCold && aoPositive) {
        regime = 'decoupled';
        label  = 'Decoupled — surface flow disagrees with vortex';
        risk   = 'low';
        leadTimeDays = 0;
        affected = [];
        confidence = 0.4;
        summary =
            'Vortex disturbed but AO still positive — stratosphere-'
          + 'troposphere coupling has not propagated downward yet. '
          + 'Watch for AO reversal in the coming 5-10 days.';
    } else if (stratoMild && aoNegative) {
        regime = 'decoupled';
        label  = 'Decoupled — surface blocking despite strong vortex';
        risk   = 'moderate';
        leadTimeDays = 0;
        affected = _affectedRegions(nao);
        confidence = 0.55;
        summary =
            'Strong vortex aloft but blocked surface pattern below. '
          + 'Cold-air outbreaks driven by tropospheric blocking, not '
          + 'stratospheric forcing. Less persistent than coupled events.';
    } else {
        regime = 'neutral';
        label  = 'Near-climatological — defer to synoptic forecast';
        risk   = 'low';
        leadTimeDays = 0;
        affected = [];
        confidence = 0.35;
        summary =
            'No strong stratosphere-troposphere coupling signal. '
          + 'Surface pattern driven by week-to-week synoptic '
          + 'variability rather than annular-mode forcing.';
    }

    return {
        regime, label, risk,
        lead_time_days: leadTimeDays,
        affected_regions: affected,
        confidence: round(confidence),
        summary,
    };
}

function _affectedRegions(nao) {
    // NAO modulates which sector of the mid-latitudes feels the
    // cold-air outbreak most strongly. NAO- → Atlantic/European
    // signature; NAO neutral/+ → continental US / Asian.
    if (Number.isFinite(nao) && nao <= -1) {
        return ['Western Europe', 'Scandinavia', 'US Northeast'];
    }
    if (Number.isFinite(nao) && nao >= 1) {
        return ['US Midwest', 'Central Asia'];
    }
    return ['US Northeast', 'US Midwest', 'Northern Europe'];
}

function round(v) {
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}
