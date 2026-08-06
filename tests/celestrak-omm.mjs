#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    normalizeOmmPayload,
    normalizeOmmRecord,
    summarizeOrbitRecords,
} from '../api/_lib/omm.js';
import celestrakHandler from '../api/celestrak/tle.js';
import { buildCatalogHealth } from '../js/operations/catalog-health.js';

const EPOCH = '2026-08-05T12:00:00.000';
const raw = {
    OBJECT_NAME: 'CATALOG TEST 100147',
    OBJECT_ID: '2026-100A',
    EPOCH,
    MEAN_MOTION: 15.5,
    ECCENTRICITY: 0.001,
    INCLINATION: 51.64,
    RA_OF_ASC_NODE: 123.4,
    ARG_OF_PERICENTER: 45.6,
    MEAN_ANOMALY: 78.9,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: '100147',
    ELEMENT_SET_NO: 42,
    REV_AT_EPOCH: 123,
    BSTAR: 0.00012,
    MEAN_MOTION_DOT: 0.00001,
    MEAN_MOTION_DDOT: 0,
    REF_FRAME: 'TEME',
    TIME_SYSTEM: 'UTC',
    MEAN_ELEMENT_THEORY: 'SGP4',
};

const normalized = normalizeOmmRecord(raw);
assert.ok(normalized, 'valid OMM record normalizes');
assert.equal(normalized.norad_id, 100147, 'six-digit catalogue ID is retained');
assert.equal(normalized.source_format, 'omm-json');
assert.equal(normalized.epoch, '2026-08-05T12:00:00.000Z', 'zone-less OMM epoch is UTC');
assert.equal(normalized.line1, null);
assert.equal(normalized.bstar, 0.00012);
assert.ok(normalized.epoch_jd > 2460000);
assert.ok(normalized.period_min > 90 && normalized.period_min < 100);
assert.ok(normalized.perigee_km > 300 && normalized.apogee_km < 600);

const ordinalEpoch = normalizeOmmRecord({ ...raw, EPOCH: '2026-217T12:00:00.000Z' });
assert.equal(ordinalEpoch.epoch, '2026-08-05T12:00:00.000Z', 'CCSDS ordinal epoch parses');

const payload = normalizeOmmPayload([raw, { OBJECT_NAME: 'missing fields' }]);
assert.equal(payload.received, 2);
assert.equal(payload.records.length, 1);
assert.equal(payload.rejected, 1);

const nowMs = Date.parse('2026-08-06T12:00:00.000Z');
const twoDayOld = { ...normalized, norad_id: 99999, epoch_ms: nowMs - 2 * 86400000 };
const fourDayOld = { ...normalized, norad_id: 100148, epoch_ms: nowMs - 4 * 86400000 };
const summary = summarizeOrbitRecords([normalized, twoDayOld, fourDayOld], nowMs);
assert.equal(summary.count, 3);
assert.equal(summary.maxCatalogId, 100148);
assert.equal(summary.sixPlusDigitCount, 2);
assert.equal(summary.freshUnder24h, 0);
assert.equal(summary.aging1To3d, 2);
assert.equal(summary.staleOver3d, 1);

const healthy = buildCatalogHealth({
    records: [normalized, normalized],
    groups: [{
        id: 'stations', label: 'Space Stations', status: 'ready',
        fetched: '2026-08-06T11:50:00.000Z', rejectedCount: 0, subgroupFailures: 0,
    }],
    capacity: 50000,
    nowMs,
});
assert.equal(healthy.state, 'healthy');
assert.equal(healthy.loadedCount, 1, 'health deduplicates records by catalogue ID');
assert.equal(healthy.sixPlusDigitCount, 1);
assert.equal(healthy.formats['omm-json'], 1);
assert.equal(healthy.activeLayerCount, 1);

const partial = buildCatalogHealth({
    records: [normalized],
    groups: [{
        id: 'debris', label: 'Debris', status: 'partial',
        fetched: '2026-08-06T11:50:00.000Z', rejectedCount: 2, subgroupFailures: 1,
    }],
    nowMs,
});
assert.equal(partial.state, 'partial');
assert.equal(partial.rejectedCount, 2);
assert.equal(partial.subgroupFailures, 1);

// The public proxy keeps its historical route but defaults upstream to OMM.
const originalFetch = globalThis.fetch;
let fetchedUrl = null;
try {
    globalThis.fetch = async url => {
        fetchedUrl = String(url);
        return new Response(JSON.stringify([raw]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };
    const response = await celestrakHandler(new Request('https://example.test/api/celestrak/tle?group=stations'));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.match(fetchedUrl, /FORMAT=JSON/);
    assert.equal(body.source_format, 'omm-json');
    assert.equal(body.satellites[0].norad_id, 100147);
    assert.equal(body.update_cadence_hours, 2);
} finally {
    globalThis.fetch = originalFetch;
}

// Exercise the committed browser bundle, not just Rust unit internals.
const wasm = await import('../js/sgp4-wasm/sgp4_wasm.js');
const wasmBytes = await readFile(new URL('../js/sgp4-wasm/sgp4_wasm_bg.wasm', import.meta.url));
await wasm.default({ module_or_path: wasmBytes });
const ommArgs = [
    normalized.norad_id, normalized.epoch_jd, normalized.bstar,
    normalized.inclination, normalized.raan, normalized.eccentricity,
    normalized.arg_perigee, normalized.mean_anomaly, normalized.mean_motion,
    normalized.rev_at_epoch,
];
const state = wasm.propagate_omm(...ommArgs, 0);
assert.equal(state.length, 6);
assert.ok([...state].every(Number.isFinite), 'OMM state is finite');
const batch = wasm.propagate_batch_omm(...ommArgs, new Float64Array([0, 10]));
assert.equal(batch.length, 12);
assert.ok([...batch].every(Number.isFinite), 'OMM batch states are finite');
wasm.registry_clear();
assert.equal(wasm.registry_add_omm(...ommArgs), 0);
assert.equal(wasm.registry_len(), 1);

console.log('OMM normalization, coverage health, and WASM propagation checks passed.');
