import assert from 'node:assert/strict';
import {
    parseNoradText, buildFleetReport, fleetReportToCsv,
} from '../js/operations/fleet-io.js';

assert.deepEqual(
    parseNoradText('25544\n20580\n25544').ids,
    [25544, 20580],
    'one-per-line IDs dedupe',
);

assert.deepEqual(
    parseNoradText('norad_id,name,altitude_km\n25544,ISS,420\n20580,HST,540').ids,
    [25544, 20580],
    'header-aware CSV ignores other numeric fields',
);

assert.deepEqual(
    parseNoradText('[{"noradId":48274},{"catalog_number":"43013"}]').ids,
    [48274, 43013],
    'JSON object arrays accept common catalog keys',
);

assert.deepEqual(
    parseNoradText('100147\n123456789').ids,
    [100147, 123456789],
    'OMM-era six- and nine-digit catalogue IDs are retained',
);

assert.deepEqual(
    parseNoradText('ISS (ZARYA)\n1 25544U 98067A   24200.50000000\n2 25544 51.6400 1.0000').ids,
    [25544],
    'two-line elements recover and dedupe the catalog ID',
);

const capped = parseNoradText('25544,20580,48274', { max: 2 });
assert.deepEqual(capped.ids, [25544, 20580]);
assert.equal(capped.truncated, 1);

const report = buildFleetReport({
    assets: [{
        noradId: 25544,
        name: 'ISS, ZARYA',
        status: 'ready',
        tle: { perigee_km: 410, apogee_km: 420 },
    }],
    simTimeMs: Date.parse('2026-08-05T12:00:00Z'),
    scenarioHash: 'abc12345',
    scenarioLabel: 'Gannon G5',
    provenance: {
        records: {
            'decay.lifetime.25544': { value: 125, sigma: 20 },
            'decay.rate.25544': { value: -0.25 },
        },
    },
    conjunctionRows: [{
        asset: { noradId: 25544 },
        conjs: [{ dist_km: 4.2, tca_ms: Date.parse('2026-08-06T12:00:00Z') }],
    }],
    riskSnapshot: {
        summary: {
            assetCount: 1, encounterCount: 1, inside3SigmaCount: 1,
            envelopeOverlapCount: 0, worstLoss72hM: 750,
            dominantFamily: { name: 'Fengyun-1C ASAT (2007)' },
        },
        assetForecasts: [{
            asset: { noradId: 25544 },
            vehicleConfig: {
                profileId: 'small-eo', attitude: 'low-drag', massKg: 150,
                cd: 2.25, areaNominalM2: 1.2, areaLowDragM2: 0.42,
                areaSunM2: 4.8, thrustN: 5, ispS: 230, propellantKg: 18,
                activeAction: 'low-drag',
            },
            forecast: {
                dragVsQuiet: 2.5,
                horizons: [
                    { hours: 6, perigeeKm: 409.94, lossM: 62.5 },
                    { hours: 24, perigeeKm: 409.75, lossM: 250 },
                    { hours: 72, perigeeKm: 409.25, lossM: 750 },
                ],
            },
        }],
        encounters: [{
            primary: { noradId: 25544 },
            screen: { rank: 3, tier: 'inside-3sigma', missKm: 4.2, missOverSigma: 2.1, combinedSigmaKm: 2 },
            family: { name: 'Fengyun-1C ASAT (2007)' },
            energyMJ: 6125,
        }],
    },
    vehicleSnapshot: {
        validAt: '2026-08-05T12:00:00.000Z', selectedNoradId: 25544,
        assetName: 'ISS, ZARYA',
        config: { profileId: 'small-eo', massKg: 150 },
        activeBranch: { id: 'low-drag', endPerigeeKm: 409.8 },
        branches: [{ id: 'do-nothing' }, { id: 'low-drag' }],
    },
});

assert.equal(report.schema, 'parkersphysics.orbit-margin.fleet.v3');
assert.equal(report.assets[0].conjunctionCount, 1);
assert.equal(report.assets[0].closestMissKm, 4.2);
assert.equal(report.assets[0].perigeeForecast72hKm, 409.25);
assert.equal(report.assets[0].highestScreeningTier, 'inside-3sigma');
assert.equal(report.assets[0].vehicleProfileId, 'small-eo');
assert.equal(report.assets[0].activeAction, 'low-drag');
assert.equal(report.riskSummary.dominantDebrisFamily, 'Fengyun-1C ASAT (2007)');
assert.equal(report.vehicleComparison.activeBranch.id, 'low-drag');
assert.equal(report.limitations.length, 5);

const csv = fleetReportToCsv(report);
assert.match(csv, /"ISS, ZARYA"/);
assert.match(csv, /Gannon G5/);
assert.match(csv, /abc12345/);
assert.match(csv, /perigee_72h_km/);
assert.match(csv, /inside-3sigma/);
assert.match(csv, /vehicle_profile/);
assert.match(csv, /small-eo/);

console.log('operations fleet I/O: ok');
