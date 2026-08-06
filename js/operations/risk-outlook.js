/**
 * risk-outlook.js — fleet altitude, drag, debris, and collision-screen panel.
 *
 * Uses the existing NRLMSISE-00/surrogate fallback ladder and SGP4 screen.
 * Collision outputs are uncertainty-overlap indicators only: public TLEs do
 * not contain covariance and this module never reports probability of collision.
 */

import { provStore } from './provenance.js';
import { decayWithSigma, deltaAPerDay } from './decision-deck.js';
import { ballisticFromTle, onMsisReady } from './msis-drag.js';
import { tleAgeUncertainty, combinedMissEnvelope } from './uncertainty.js';
import {
    annotate as annotateDebris, hazardEnergyMJ, shortFamilyName,
} from '../debris-catalog.js';
import {
    buildAltitudeForecast, classifyEncounter, localRateFromDecay, summariseRisk,
} from './risk-analysis.js';
import { ballisticCoefficient, getVehicleProfile } from './vehicle-scenarios.js';

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
}

function sigmaShape(tle, atMs, ap) {
    if (!tle || !Number.isFinite(atMs)) return null;
    try {
        const s = tleAgeUncertainty(tle, atMs, ap);
        return { sigmaAlong: s.along, sigmaCross: s.cross, sigmaRadial: s.radial };
    } catch (_) {
        return null;
    }
}

function fmtAltitude(km) {
    if (!Number.isFinite(km)) return '—';
    return km >= 1000 ? `${Math.round(km).toLocaleString()}` : km.toFixed(1);
}

function fmtLoss(m) {
    if (!Number.isFinite(m)) return '—';
    if (m < 1) return '<1 m';
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(2)} km`;
}

function fmtEnergy(mj) {
    if (!Number.isFinite(mj)) return '—';
    if (mj >= 1000) return `${(mj / 1000).toFixed(mj >= 10000 ? 0 : 1)} GJ`;
    return `${mj >= 100 ? Math.round(mj) : mj.toFixed(1)} MJ`;
}

function forecastFor(asset, f107, sigF107, ap, sigAp, vehicleConfig = null) {
    const tle = asset.tle;
    const lifeRec = provStore.get(`decay.lifetime.${asset.noradId}`);
    const rateRec = provStore.get(`decay.rate.${asset.noradId}`);
    const decay = lifeRec ? {
        lifetime_days: lifeRec.value,
        sigma_days: lifeRec.sigma,
        perigee_km: tle.perigee_km,
        dadt_km_day: rateRec?.value,
        model: /NRLMSISE/i.test(`${lifeRec.source} ${lifeRec.model}`) ? 'msis' : 'surrogate',
    } : decayWithSigma(tle, f107, sigF107, ap, sigAp);
    const bcScale = vehicleConfig
        ? ballisticCoefficient(vehicleConfig, vehicleConfig.attitude) / ballisticFromTle(tle).bc
        : 1;
    const rate = localRateFromDecay(decay) * bcScale;
    let quietRate = deltaAPerDay(tle, 150, 15) * bcScale;
    // The bucketed no-WASM surrogate can return zero inside a plateau.
    // Derive its quiet rate from lifetime in that case; the MSIS path above
    // is already smooth and ordinarily never takes this fallback.
    if (Math.abs(quietRate) <= 1e-12 && Math.abs(rate) > 1e-12) {
        quietRate = localRateFromDecay(decayWithSigma(tle, 150, 0, 15, 0)) * bcScale;
    }
    const sigmaFrac = Number.isFinite(decay?.lifetime_days) && decay.lifetime_days > 0
        ? Math.min(2, Math.abs((decay.sigma_days ?? 0) / decay.lifetime_days))
        : (['tle-bstar', 'omm-bstar'].includes(decay?.bcSource) ? 0.35 : 0.6);
    return {
        decay,
        forecast: buildAltitudeForecast({
            perigeeKm: decay?.perigee_km,
            rateKmDay: rate,
            rateSigmaFrac: sigmaFrac,
            quietRateKmDay: quietRate,
        }),
    };
}

export function mountRiskOutlook({ host, fleet, tracker, deck, vehicleStore, onSelect, onConjunction } = {}) {
    if (!host || !fleet || !tracker || !deck) return null;
    let conjunctionSnapshot = { rows: [], epochMs: null, horizonH: null };
    let snapshot = { assetForecasts: [], encounters: [], summary: summariseRisk() };

    function buildEncounterRows(ap) {
        const out = [];
        for (const row of conjunctionSnapshot.rows ?? []) {
            for (const conj of row.conjs ?? []) {
                const secondary = tracker.getSatellite?.(conj.norad_id);
                const pSigma = sigmaShape(row.asset?.tle, conj.tca_ms, ap);
                const sSigma = sigmaShape(secondary?.tle, conj.tca_ms, ap);
                const envelope = pSigma && sSigma ? combinedMissEnvelope(pSigma, sSigma) : null;
                const screen = classifyEncounter({ missKm: conj.dist_km, combinedEnvelope: envelope });
                let annotation = null;
                try { annotation = annotateDebris({ name: conj.name, noradId: conj.norad_id }); }
                catch (_) {}
                const energyMJ = annotation?.size?.massKg
                    ? hazardEnergyMJ(annotation.size.massKg, conj.dv_kms ?? 14)
                    : null;
                out.push({
                    primary: row.asset,
                    secondary,
                    conjunction: conj,
                    screen,
                    envelope,
                    family: annotation?.family ?? null,
                    size: annotation?.size ?? null,
                    energyMJ,
                });
            }
        }
        return out.sort((a, b) =>
            (b.screen?.rank ?? 0) - (a.screen?.rank ?? 0) ||
            (a.screen?.missKm ?? Infinity) - (b.screen?.missKm ?? Infinity));
    }

    function render() {
        const f107 = provStore.get('idx.f107')?.value ?? 150;
        const sigF107 = provStore.get('idx.f107')?.sigma ?? 12;
        const ap = provStore.get('idx.ap')?.value ?? 15;
        const sigAp = provStore.get('idx.ap')?.sigma ?? 6;
        const assetForecasts = [];

        for (const asset of fleet.list().filter(a => a.status === 'ready' && a.tle)) {
            const vehicleConfig = vehicleStore?.get?.(asset.noradId) ?? null;
            const { decay, forecast } = forecastFor(asset, f107, sigF107, ap, sigAp, vehicleConfig);
            if (!forecast) continue;
            const record = { asset, decay, forecast, vehicleConfig };
            assetForecasts.push(record);
            for (const h of forecast.horizons) {
                provStore.set(`risk.altitude.${asset.noradId}.${h.hours}h`, {
                    value: h.perigeeKm,
                    sigma: Math.abs(h.highKm - h.lowKm) / 2,
                    unit: 'km perigee',
                    source: decay?.model === 'msis'
                        ? 'derived (NRLMSISE-00 local-rate projection)'
                        : 'derived (Operations decay surrogate projection)',
                    model: `${decay?.model ?? 'surrogate'} local ȧ × horizon${vehicleConfig ? ' · configured C_D A/m scaling' : ''}`,
                    formula: vehicleConfig
                        ? 'h_p(t) = h_p(0) + ȧ_TLE · [(C_D A/m)_vehicle/(C_D A/m)_TLE] · t'
                        : 'h_p(t) = h_p(0) + ȧ_local · t',
                    inputs: ['idx.f107', 'idx.ap', `decay.lifetime.${asset.noradId}`,
                        ...(vehicleConfig ? [`vehicle.config.${asset.noradId}.bc`] : [])],
                    cacheState: 'derived',
                    validAt: new Date().toISOString(),
                    description: `${h.hours}-hour perigee projection for ${asset.name}. ` +
                        'The current orbit-averaged drag rate is held constant over the short horizon; ' +
                        'the console recalculates when the time cursor or space-weather state changes.',
                });
            }
        }

        const encounters = buildEncounterRows(ap);
        const summary = summariseRisk({ assetForecasts: assetForecasts.map(x => x.forecast), encounters });
        snapshot = {
            validAt: new Date().toISOString(),
            screenEpochMs: conjunctionSnapshot.epochMs,
            screenHorizonH: conjunctionSnapshot.horizonH,
            assetForecasts,
            encounters,
            summary,
        };

        if (assetForecasts.length === 0) {
            host.innerHTML = `<div class="op-risk-empty">Add ready fleet assets to project altitude margin.</div>`;
            return;
        }

        const loss = fmtLoss(summary.worstLoss72hM);
        const overlapCopy = encounters.length
            ? `${summary.inside3SigmaCount} inside 3σ · ${summary.envelopeOverlapCount} overlap`
            : 'run Screen for encounter overlap';
        const altRows = assetForecasts.map(({ asset, forecast, decay, vehicleConfig }) => {
            const byH = new Map(forecast.horizons.map(h => [h.hours, h]));
            const mult = forecast.dragVsQuiet;
            const multText = Number.isFinite(mult) ? `×${mult >= 10 ? Math.round(mult) : mult.toFixed(1)}` : '—';
            const design = vehicleConfig ? getVehicleProfile(vehicleConfig.profileId).classLabel : 'TLE B*';
            return `<button type="button" class="op-risk-alt-row" data-risk-primary="${asset.noradId}"
                title="${esc(asset.name)} · ${esc(design)} · ${decay?.model === 'msis' ? 'NRLMSISE-00 orbit-averaged local rate' : 'surrogate local rate'} · ${multText} drag vs quiet">
                <span class="op-risk-asset">${esc(asset.name)}</span>
                <span>${fmtAltitude(forecast.perigeeKm)}</span>
                <span>${fmtAltitude(byH.get(6)?.perigeeKm)}</span>
                <span>${fmtAltitude(byH.get(24)?.perigeeKm)}</span>
                <span class="${byH.get(72)?.reachesReentryInterface ? 'op-risk-danger' : ''}">${fmtAltitude(byH.get(72)?.perigeeKm)}</span>
                <span class="op-risk-mult">${multText}</span>
            </button>`;
        }).join('');

        const familyBits = summary.families.slice(0, 3).map(({ family, count }) =>
            `<span class="op-risk-family" style="--risk-family:${family.color}" title="${esc(family.name)}">${esc(shortFamilyName(family))} · ${count}</span>`
        ).join('');

        const encounterRows = encounters.slice(0, 6).map((e, index) => {
            const c = e.conjunction;
            const ratio = Number.isFinite(e.screen?.missOverSigma) ? `${e.screen.missOverSigma.toFixed(1)}σ` : 'σ unavailable';
            const family = e.family?.id && e.family.id !== 'unknown'
                ? shortFamilyName(e.family)
                : (c.group || 'unclassified');
            return `<button type="button" class="op-risk-enc op-risk-enc--${e.screen?.tier ?? 'monitor'}" data-risk-enc="${index}"
                title="Synthetic public-TLE envelope; not probability of collision. ${esc(e.screen?.label)}.">
                <span class="op-risk-enc-route"><strong>${esc(e.primary?.name)}</strong> → ${esc(c.name)}</span>
                <span class="op-risk-enc-family">${esc(family)}</span>
                <span class="op-risk-enc-metrics">${c.dist_km.toFixed(2)} km · ${ratio} · ${fmtEnergy(e.energyMJ)}</span>
                <span class="op-risk-enc-label">${esc(e.screen?.label)}</span>
            </button>`;
        }).join('');

        host.innerHTML = `
            <div class="op-risk-summary">
                <div><strong>${loss}</strong><span>worst projected 72 h loss</span></div>
                <div><strong>${encounters.length}</strong><span>passes ≤50 km</span></div>
                <div><strong>${summary.inside3SigmaCount}</strong><span>inside synthetic 3σ</span></div>
            </div>
            <div class="op-risk-note">${overlapCopy}. Altitude is a local-rate projection; collision screening is not Pc.</div>
            <div class="op-risk-section-title">Perigee outlook · km <span>current / 6 h / 24 h / 72 h / drag</span></div>
            <div class="op-risk-alt-head"><span>asset</span><span>now</span><span>6h</span><span>24h</span><span>72h</span><span>vs q</span></div>
            <div class="op-risk-alt-list">${altRows}</div>
            <div class="op-risk-section-title">Debris &amp; encounter screen <span>${familyBits || 'screen pending'}</span></div>
            <div class="op-risk-enc-list">${encounterRows || '<div class="op-risk-empty">Run the conjunction screen to compare misses with the synthetic TLE uncertainty envelope.</div>'}</div>
        `;

        host.querySelectorAll('[data-risk-primary]').forEach(row => {
            row.addEventListener('click', () => onSelect?.(Number(row.dataset.riskPrimary)));
        });
        host.querySelectorAll('[data-risk-enc]').forEach(row => {
            row.addEventListener('click', () => {
                const e = encounters[Number(row.dataset.riskEnc)];
                if (!e) return;
                onSelect?.(e.primary.noradId);
                const c = e.conjunction;
                onConjunction?.({
                    assetName: e.primary.name,
                    assetTle: e.primary.tle,
                    secondaryName: c.name || `#${c.norad_id}`,
                    secondaryTle: e.secondary?.tle ?? null,
                    tcaMs: c.tca_ms,
                    missKm: c.dist_km,
                    dvKms: c.dv_kms,
                    missUnit: c.miss_unit,
                    missVec: c.miss_vec,
                    vRel: c.v_rel,
                });
            });
        });
    }

    const offFleet = fleet.onChange(render);
    const offProv = provStore.subscribe(key => {
        if (key === 'idx.f107' || key === 'idx.ap') render();
    });
    const offMsis = onMsisReady(render);
    const offVehicle = vehicleStore?.onChange?.(render);
    const offRows = deck.subscribeRows(next => {
        conjunctionSnapshot = next;
        render();
    });

    return {
        getSnapshot: () => snapshot,
        dispose() { offFleet?.(); offProv?.(); offMsis?.(); offVehicle?.(); offRows?.(); },
    };
}
