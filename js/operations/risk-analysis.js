/**
 * risk-analysis.js — pure altitude-horizon and encounter-screening helpers.
 *
 * These functions deliberately stop short of probability of collision (Pc).
 * Public GP/TLE data has no operator covariance, so the encounter indicator is
 * only a conservative comparison between miss distance and the largest axis of
 * the synthetic combined 1σ envelope supplied by the caller.
 */

export const ALTITUDE_HORIZONS_H = Object.freeze([6, 24, 72]);

function finite(value, fallback = null) {
    return Number.isFinite(value) ? value : fallback;
}

/** Resolve a local perigee-loss rate from a decay result. */
export function localRateFromDecay(decay, { reentryInterfaceKm = 120 } = {}) {
    if (Number.isFinite(decay?.dadt_km_day)) return Math.min(0, decay.dadt_km_day);
    const perigee = finite(decay?.perigee_km);
    const lifetime = finite(decay?.lifetime_days);
    if (perigee == null || lifetime == null || lifetime <= 0 || perigee <= reentryInterfaceKm) return 0;
    return -(perigee - reentryInterfaceKm) / lifetime;
}

/**
 * Linear local-rate projection at 6/24/72 h (or caller-provided horizons).
 * This is intentionally a short-horizon sensitivity view, not a replacement
 * for re-propagating an orbit as density and orbital elements evolve.
 */
export function buildAltitudeForecast({
    perigeeKm,
    rateKmDay,
    rateSigmaFrac = 0,
    quietRateKmDay = null,
    horizonsH = ALTITUDE_HORIZONS_H,
    reentryInterfaceKm = 120,
} = {}) {
    if (!Number.isFinite(perigeeKm)) return null;
    const rate = Number.isFinite(rateKmDay) ? Math.min(0, rateKmDay) : 0;
    const sigmaFrac = Math.max(0, Math.min(2, finite(rateSigmaFrac, 0)));
    const fasterRate = rate * (1 + sigmaFrac);
    const slowerRate = rate * Math.max(0, 1 - sigmaFrac);

    const horizons = horizonsH
        .filter(h => Number.isFinite(h) && h > 0)
        .map(hours => {
            const days = hours / 24;
            const nominalKm = perigeeKm + rate * days;
            const lowKm = perigeeKm + fasterRate * days;
            const highKm = perigeeKm + slowerRate * days;
            return {
                hours,
                perigeeKm: nominalKm,
                lowKm,
                highKm,
                lossM: Math.max(0, (perigeeKm - nominalKm) * 1000),
                reachesReentryInterface: lowKm <= reentryInterfaceKm,
            };
        });

    const quiet = Number.isFinite(quietRateKmDay) ? Math.min(0, quietRateKmDay) : null;
    const dragVsQuiet = quiet != null && Math.abs(quiet) > 1e-12
        ? Math.abs(rate) / Math.abs(quiet)
        : (Math.abs(rate) <= 1e-12 ? 1 : null);

    return {
        perigeeKm,
        rateKmDay: rate,
        rateSigmaFrac: sigmaFrac,
        quietRateKmDay: quiet,
        dragVsQuiet,
        horizons,
    };
}

function sigmaAxis(envelope, key, legacyKey) {
    return finite(envelope?.[key], finite(envelope?.[legacyKey], 0));
}

/**
 * Classify a screened encounter without inventing Pc. `combinedEnvelope`
 * accepts { sigmaAlong, sigmaCross, sigmaRadial } in kilometres.
 */
export function classifyEncounter({ missKm, combinedEnvelope = null } = {}) {
    if (!Number.isFinite(missKm) || missKm < 0) return null;
    const sigmaKm = Math.max(
        sigmaAxis(combinedEnvelope, 'sigmaAlong', 'along'),
        sigmaAxis(combinedEnvelope, 'sigmaCross', 'cross'),
        sigmaAxis(combinedEnvelope, 'sigmaRadial', 'radial'),
    );
    const missOverSigma = sigmaKm > 0 ? missKm / sigmaKm : null;

    let tier;
    let label;
    let rank;
    if (missOverSigma != null && missOverSigma <= 1) {
        tier = 'overlap'; label = 'inside 1σ envelope'; rank = 4;
    } else if (missOverSigma != null && missOverSigma <= 3) {
        tier = 'inside-3sigma'; label = 'inside 3σ envelope'; rank = 3;
    } else if (missKm < 5 || (missOverSigma != null && missOverSigma <= 10)) {
        tier = 'watch'; label = missKm < 5 ? 'close pass' : 'uncertainty watch'; rank = 2;
    } else {
        tier = 'monitor'; label = 'screened separation'; rank = 1;
    }

    return {
        missKm,
        combinedSigmaKm: sigmaKm || null,
        missOverSigma,
        tier,
        label,
        rank,
        syntheticEnvelope: sigmaKm > 0,
    };
}

/** Fleet-level roll-up for the risk-outlook headline and export. */
export function summariseRisk({ assetForecasts = [], encounters = [] } = {}) {
    const validForecasts = assetForecasts.filter(Boolean);
    const losses72 = validForecasts
        .map(f => f.horizons?.find(h => h.hours === 72)?.lossM)
        .filter(Number.isFinite);
    const familyCounts = new Map();
    for (const e of encounters) {
        const id = e?.family?.id;
        if (!id || id === 'unknown') continue;
        const prior = familyCounts.get(id) ?? { family: e.family, count: 0 };
        prior.count++;
        familyCounts.set(id, prior);
    }
    const families = [...familyCounts.values()].sort((a, b) => b.count - a.count);
    const ranked = encounters.slice().sort((a, b) =>
        (b?.screen?.rank ?? 0) - (a?.screen?.rank ?? 0) ||
        (a?.screen?.missKm ?? Infinity) - (b?.screen?.missKm ?? Infinity));

    return {
        assetCount: validForecasts.length,
        encounterCount: encounters.length,
        envelopeOverlapCount: encounters.filter(e => e?.screen?.tier === 'overlap').length,
        inside3SigmaCount: encounters.filter(e => e?.screen?.rank >= 3).length,
        worstLoss72hM: losses72.length ? Math.max(...losses72) : null,
        dominantFamily: families[0]?.family ?? null,
        dominantFamilyCount: families[0]?.count ?? 0,
        families,
        highestPriority: ranked[0] ?? null,
    };
}
