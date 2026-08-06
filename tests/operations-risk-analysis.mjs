import assert from 'node:assert/strict';
import {
    buildAltitudeForecast, classifyEncounter, localRateFromDecay, summariseRisk,
} from '../js/operations/risk-analysis.js';

assert.equal(localRateFromDecay({ dadt_km_day: -0.4 }), -0.4);
assert.equal(localRateFromDecay({ perigee_km: 420, lifetime_days: 300 }), -1);

const forecast = buildAltitudeForecast({
    perigeeKm: 420,
    rateKmDay: -1,
    rateSigmaFrac: 0.25,
    quietRateKmDay: -0.25,
});
assert.equal(forecast.dragVsQuiet, 4);
assert.equal(forecast.horizons.find(h => h.hours === 24).perigeeKm, 419);
assert.equal(forecast.horizons.find(h => h.hours === 72).lossM, 3000);
assert.equal(forecast.horizons.find(h => h.hours === 24).lowKm, 418.75);

const overlap = classifyEncounter({
    missKm: 4,
    combinedEnvelope: { sigmaAlong: 5, sigmaCross: 2, sigmaRadial: 1 },
});
assert.equal(overlap.tier, 'overlap');
assert.equal(overlap.missOverSigma, 0.8);

const inside3 = classifyEncounter({
    missKm: 12,
    combinedEnvelope: { sigmaAlong: 5, sigmaCross: 2, sigmaRadial: 1 },
});
assert.equal(inside3.tier, 'inside-3sigma');

const monitor = classifyEncounter({
    missKm: 40,
    combinedEnvelope: { sigmaAlong: 2, sigmaCross: 1, sigmaRadial: 0.5 },
});
assert.equal(monitor.tier, 'monitor');

const family = { id: 'fengyun-1c', name: 'Fengyun-1C' };
const summary = summariseRisk({
    assetForecasts: [forecast],
    encounters: [
        { screen: overlap, family },
        { screen: inside3, family },
        { screen: monitor, family: { id: 'unknown' } },
    ],
});
assert.equal(summary.assetCount, 1);
assert.equal(summary.envelopeOverlapCount, 1);
assert.equal(summary.inside3SigmaCount, 2);
assert.equal(summary.dominantFamily.id, 'fengyun-1c');
assert.equal(summary.worstLoss72hM, 3000);

console.log('operations risk analysis: ok');
