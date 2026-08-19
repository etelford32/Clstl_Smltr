// Pure contract tests for the CME Forecast payload adapter. These stay fast
// and browser-independent; cme-forecast-page.spec.js covers the rendered UI.

import assert from 'node:assert/strict';
import { cmeEventsForUtcDay, normalizeCmePayload } from '../js/cme-forecast-page.js';

const row = (overrides = {}) => ({
    issued_at: '2026-08-19T01:00:00Z',
    predicted: '2026-08-22T12:00:00Z',
    early: '2026-08-22T05:00:00Z',
    late: '2026-08-22T21:00:00Z',
    p_hit: 0.81,
    p10: 0.62,
    p20: 0.34,
    min_bz_p50: -16,
    min_bz_p5: -33,
    ...overrides,
});

{
    const normalized = normalizeCmePayload({ data: {
        updated: '2026-08-19T02:00:00Z',
        models: [{ model_id: 'flux-rope-v1', n_scored: 3 }],
        events: [{
            event_id: 'PP-1', donki_id: 'DONKI-1', launch: '2026-08-18T20:00:00Z', speed_kms: 1100,
            forecasts: {
                'dbm-v1': row({ predicted: '2026-08-21T12:00:00Z' }),
                'flux-rope-v1': row(),
            },
            truth: null,
        }],
    } });
    assert.equal(normalized.events.length, 1);
    assert.equal(normalized.events[0].modelId, 'flux-rope-v1');
    assert.equal(normalized.events[0].pHit, 0.81);
    assert.equal(normalized.events[0].speedKms, 1100);
    assert.equal(normalized.models.length, 1);
}

{
    // A baseline-only event is valid input to /api/cme/skill but is not a
    // Parker forecast. It stays out of the public forecast corridor.
    const normalized = normalizeCmePayload({ data: {
        events: [{ event_id: 'BASELINE-ONLY', forecasts: { 'dbm-v1': row() } }],
    } });
    assert.deepEqual(normalized.events, []);
}

{
    const normalized = normalizeCmePayload({ data: {
        events: [
            { event_id: 'LATE', forecasts: { 'flux-rope-v1': row({ predicted: '2026-08-25T00:00:00Z' }) } },
            { event_id: 'EARLY', forecasts: { 'flux-rope-v1': row({ predicted: '2026-08-21T00:00:00Z', early: null, late: null }) } },
            { event_id: 'INVALID', forecasts: { 'flux-rope-v1': row({ predicted: null }) } },
        ],
    } });
    assert.deepEqual(normalized.events.map((event) => event.id), ['EARLY', 'LATE']);
    assert.equal(normalized.events[0].earlyMs, normalized.events[0].predictedMs - 6 * 3600e3);
    assert.equal(normalized.events[0].lateMs, normalized.events[0].predictedMs + 6 * 3600e3);
}

{
    const normalized = normalizeCmePayload({ data: {
        events: [{
            event_id: 'MIDNIGHT-WINDOW',
            forecasts: { 'flux-rope-v1': row({
                predicted: '2026-08-23T00:30:00Z',
                early: '2026-08-22T22:00:00Z',
                late: '2026-08-23T03:00:00Z',
            }) },
        }],
    } });
    const aug22 = Date.parse('2026-08-22T00:00:00Z');
    const aug23 = Date.parse('2026-08-23T00:00:00Z');
    const aug24 = Date.parse('2026-08-24T00:00:00Z');
    assert.equal(cmeEventsForUtcDay(normalized.events, aug22).length, 1);
    assert.equal(cmeEventsForUtcDay(normalized.events, aug23).length, 1);
    assert.equal(cmeEventsForUtcDay(normalized.events, aug24).length, 0);
}

console.log('✓ CME Forecast payload contract');
