/** Contract tests for NASA observation date selection on the shared scrubber. */
import assert from 'node:assert/strict';
import { OBS_DAY_MS, resolveObservationTime, utcDayKey } from '../js/earth-obs-time.js';

const now = Date.UTC(2026, 7, 5, 18); // Aug 5, 2026

const latest = resolveObservationTime({ simTimeMs: now, nowMs: now, timeOffsetDays: 1 });
assert.equal(latest.key, '2026-08-04');
assert.equal(latest.mode, 'latest');

const replay = resolveObservationTime({ simTimeMs: now - 4 * OBS_DAY_MS, nowMs: now, timeOffsetDays: 1 });
assert.equal(replay.key, '2026-08-01');
assert.equal(replay.mode, 'replay');

const future = resolveObservationTime({ simTimeMs: now + 3 * OBS_DAY_MS, nowMs: now, timeOffsetDays: 1 });
assert.equal(future.key, '2026-08-04');
assert.equal(future.mode, 'clamped-future');

const noDelay = resolveObservationTime({ simTimeMs: now - 2 * OBS_DAY_MS, nowMs: now, timeOffsetDays: 0 });
assert.equal(noDelay.key, '2026-08-03');
assert.equal(noDelay.mode, 'replay');

assert.equal(utcDayKey(Date.UTC(2026, 0, 2, 23, 59)), '2026-01-02');
console.log('earth-obs-time: all assertions passed');
