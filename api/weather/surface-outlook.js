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

async function _fetchJson(url) {
    const res = await fetchWithTimeout(url, { timeoutMs: 12_000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

export default async function handler(req) {
    const url = new URL(req.url);
    // Pass through to the proxies on the same origin so this composes
    // cleanly behind a single deploy. Both endpoints are themselves
    // long-cached, so the doubled fan-out is cheap.
    const origin = url.origin;

    // Independent fetches. Either upstream can fail — we still try to
    // compose a partial outlook from whatever survived. Previously we used
    // Promise.all which made polar-vortex 503s cascade into a full 503
    // here, killing the surface-outlook card every time Open-Meteo's GFS
    // pressure-level endpoint hiccupped. Promise.allSettled lets us
    // degrade gracefully.
    const [vSettled, tSettled] = await Promise.allSettled([
        _fetchJson(`${origin}/v1/weather/polar-vortex`),
        _fetchJson(`${origin}/v1/weather/teleconnections`),
    ]);
    const vortex = vSettled.status === 'fulfilled' ? vSettled.value : null;
    const teleco = tSettled.status === 'fulfilled' ? tSettled.value : null;

    if (!vortex && !teleco) {
        return jsonError('upstream_unavailable',
            `vortex: ${vSettled.reason?.message ?? '—'}; teleco: ${tSettled.reason?.message ?? '—'}`,
            { source: 'surface-outlook composer' });
    }

    const haveBoth   = vortex && teleco;
    const out = haveBoth
        ? _combine(vortex, teleco)
        : _partial(vortex, teleco);

    return jsonOk({
        source: 'Parker Physics surface-outlook · vortex × AO/NAO combiner',
        as_of:  new Date().toISOString(),
        degraded: !haveBoth,
        degraded_reason: haveBoth ? null
            : !vortex ? 'polar-vortex unavailable'
            : 'teleconnections unavailable',
        ...out,
        drivers: {
            vortex: vortex ? {
                state:    vortex.classification?.state,
                u10_now:  vortex.current?.U_10hPa,
                u10_d7:   vortex.forecast_d7?.U_10hPa,
            } : null,
            ao: teleco ? {
                current:  teleco.ao?.current,
                trend_7d: teleco.ao?.trend_7d,
                state:    teleco.ao?.state,
            } : null,
            nao: teleco ? {
                current:  teleco.nao?.current,
                trend_7d: teleco.nao?.trend_7d,
                state:    teleco.nao?.state,
            } : null,
        },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}

// Degraded-mode combiner: emits a coarser outlook from a single driver.
// Confidence is intentionally capped lower than the full coupled product so
// callers/UI can show "partial" badging without sniffing both drivers.
function _partial(vortex, teleco) {
    if (vortex && !teleco) {
        const vState = vortex?.classification?.state ?? 'unknown';
        const stratoCold = vState === 'ssw' || vState === 'disturbed' || vState === 'weakening';
        const stratoMild = vState === 'strong';
        if (stratoCold) {
            return {
                regime: 'emerging-cold',
                label:  'Vortex-only signal · AO/NAO unavailable',
                risk:   vState === 'ssw' ? 'elevated' : 'moderate',
                lead_time_days:   vState === 'ssw' ? 14 : 10,
                affected_regions: ['mid-latitudes (broad)'],
                confidence:       0.45,
                summary:
                    `Stratospheric vortex ${vortex.classification.label.toLowerCase()}; `
                  + 'tropospheric AO/NAO indices unavailable so coupling strength can\'t '
                  + 'be confirmed. Treat as a watch, not a forecast.',
            };
        }
        if (stratoMild) {
            return {
                regime: 'mild-zonal',
                label:  'Strong vortex · AO/NAO unavailable',
                risk:   'low',
                lead_time_days:   0,
                affected_regions: [],
                confidence:       0.5,
                summary: 'Strong polar vortex aloft; surface coupling unconfirmed without AO/NAO.',
            };
        }
        return {
            regime: 'neutral',
            label:  'Vortex-only signal · near-climatological',
            risk:   'low',
            lead_time_days:   0,
            affected_regions: [],
            confidence:       0.3,
            summary: 'No strong stratospheric signal; AO/NAO indices unavailable for confirmation.',
        };
    }

    // teleco-only (vortex unavailable)
    const ao  = teleco?.ao?.current  ?? null;
    const nao = teleco?.nao?.current ?? null;
    const aoNeg = Number.isFinite(ao) && ao <= -1;
    const aoPos = Number.isFinite(ao) && ao >=  1;
    if (aoNeg) {
        return {
            regime: 'emerging-cold',
            label:  'AO/NAO-only signal · stratosphere unavailable',
            risk:   'moderate',
            lead_time_days:   0,
            affected_regions: nao != null && nao <= -1 ? ['Western Europe', 'US Northeast']
                            : nao != null && nao >=  1 ? ['US Midwest', 'Central Asia']
                            : ['mid-latitudes (broad)'],
            confidence:       0.5,
            summary:
                `AO ${ao.toFixed(1)} (negative) — surface cold pattern in progress. `
              + 'Stratospheric vortex state unavailable; persistence horizon uncertain.',
        };
    }
    if (aoPos) {
        return {
            regime: 'mild-zonal',
            label:  'AO/NAO-only signal · zonal pattern',
            risk:   'low',
            lead_time_days:   0,
            affected_regions: [],
            confidence:       0.5,
            summary:
                `AO ${ao.toFixed(1)} (positive) — zonal flow, mid-latitudes shielded. `
              + 'Stratospheric state unavailable.',
        };
    }
    return {
        regime: 'neutral',
        label:  'AO/NAO-only signal · near-climatological',
        risk:   'low',
        lead_time_days:   0,
        affected_regions: [],
        confidence:       0.3,
        summary: 'AO/NAO near climatology; stratospheric vortex unavailable for confirmation.',
    };
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
