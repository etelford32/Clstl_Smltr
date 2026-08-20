// farside-clock.mjs — pure contract tests for the Far-Side Watch simulation
// clock. Browser behaviour is covered by tests/far-side-watch.spec.js; this
// gate is the arithmetic the scrubber, the playback loop, and the emergence
// ticks all sit on.

import assert from 'node:assert/strict';
import {
    SIM_WINDOW, SIM_SPEEDS,
    simSpanDays, simBounds, clampEpoch, epochToFraction, fractionToEpoch,
    advanceEpoch, simStatus, emergenceMarkers,
} from '../js/farside/farside-clock.js';
import {
    carringtonL0, emergenceETA, wrap180, SYNODIC_PERIOD_DAYS, SYNODIC_DEG_PER_DAY,
} from '../js/farside/carrington.js';

const DAY = 86400000;
const ANCHOR = Date.parse('2026-08-19T12:00:00Z');
const close = (a, b, tol, what) =>
    assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);

// ── Window geometry ──────────────────────────────────────────────────────
{
    // The forward half is exactly one synodic rotation. That is what makes the
    // scrubber a COMPLETE index of the watch list: emergenceETA returns a
    // forward distance mod 360, so no region's lead time can exceed it.
    assert.equal(SIM_WINDOW.forwardDays, SYNODIC_PERIOD_DAYS);
    close(simSpanDays(), 7 + 27.2753, 1e-3, 'span');

    const { startMs, endMs } = simBounds(ANCHOR);
    assert.equal(startMs, ANCHOR - 7 * DAY);
    close(endMs, ANCHOR + SYNODIC_PERIOD_DAYS * DAY, 1, 'end');

    // Anchor is NOT the midpoint — the scale label has to be placed from this
    // fraction, not parked at 50%.
    close(epochToFraction(ANCHOR, ANCHOR), 7 / simSpanDays(), 1e-9, 'anchor fraction');
    assert.ok(epochToFraction(ANCHOR, ANCHOR) < 0.25, 'anchor sits in the first quarter');

    assert.equal(epochToFraction(startMs, ANCHOR), 0);
    assert.equal(epochToFraction(endMs, ANCHOR), 1);
}

// ── Clamping + round trip ────────────────────────────────────────────────
{
    const { startMs, endMs } = simBounds(ANCHOR);
    assert.equal(clampEpoch(startMs - 99 * DAY, ANCHOR), startMs);
    assert.equal(clampEpoch(endMs + 99 * DAY, ANCHOR), endMs);
    assert.equal(clampEpoch(ANCHOR, ANCHOR), ANCHOR);

    for (const f of [0, 0.1, 0.2042, 0.5, 0.9, 1]) {
        close(epochToFraction(fractionToEpoch(f, ANCHOR), ANCHOR), f, 1e-9, `round trip ${f}`);
    }
    // Out-of-range and junk scrubber values must not produce NaN epochs.
    assert.equal(fractionToEpoch(-3, ANCHOR), simBounds(ANCHOR).startMs);
    assert.equal(fractionToEpoch(9, ANCHOR), simBounds(ANCHOR).endMs);
    assert.ok(Number.isFinite(fractionToEpoch('nonsense', ANCHOR)));
}

// ── Playback ─────────────────────────────────────────────────────────────
{
    // One second at 2 d/s is two simulated days.
    const step = advanceEpoch(ANCHOR, 1, 2, ANCHOR);
    close(step.epochMs, ANCHOR + 2 * DAY, 1, 'advance');
    assert.equal(step.ended, false);

    // Reaching the end HALTS. It must not wrap: restarting seven days in the
    // past would restate history as a forecast.
    const { endMs } = simBounds(ANCHOR);
    const over = advanceEpoch(endMs - DAY, 10, 8, ANCHOR);
    assert.equal(over.epochMs, endMs);
    assert.equal(over.ended, true);
    assert.ok(advanceEpoch(endMs, 1, 8, ANCHOR).ended);

    // Every advertised speed crosses the window in a sane wall-clock time.
    for (const s of SIM_SPEEDS) {
        const seconds = simSpanDays() / s.daysPerSec;
        assert.ok(seconds > 3 && seconds < 90, `${s.label} sweeps in ${seconds.toFixed(0)} s`);
    }
}

// ── Status readout ───────────────────────────────────────────────────────
{
    assert.equal(simStatus(ANCHOR, ANCHOR).isNow, true);
    assert.equal(simStatus(ANCHOR + DAY, ANCHOR).isNow, false);
    close(simStatus(ANCHOR + 3.5 * DAY, ANCHOR).offsetDays, 3.5, 1e-6, 'offset');
    close(simStatus(ANCHOR - 2 * DAY, ANCHOR).offsetDays, -2, 1e-6, 'negative offset');
    // L0 must match the geometry module exactly — the readout is not allowed
    // its own ephemeris.
    assert.equal(simStatus(ANCHOR, ANCHOR).L0, carringtonL0(new Date(ANCHOR)).L0);
}

// ── Emergence markers ────────────────────────────────────────────────────
{
    const tracks = [
        { id: 'a', lon: 270, strong: true },
        { id: 'b', lon: 40, strong: false },
        { id: 'c', lon: 155, strong: false },
    ];
    const marks = emergenceMarkers(tracks, ANCHOR);
    assert.equal(marks.length, 3);

    // Sorted soonest-first, and every tick lands inside the scrubber — the
    // guarantee the one-rotation forward window buys.
    for (let i = 1; i < marks.length; i++) assert.ok(marks[i].epochMs >= marks[i - 1].epochMs);
    for (const m of marks) {
        assert.ok(m.fraction >= 0 && m.fraction <= 1, `tick ${m.id} on the bar`);
        assert.ok(m.etaDays >= 0 && m.etaDays <= SYNODIC_PERIOD_DAYS + 1e-6, `${m.id} within a rotation`);
    }

    // THE CONTRACT: scrubbing to a tick puts that region ON the east limb.
    //
    // Not exactly CMD = -90, and the gap is physics rather than slop:
    // emergenceETA projects forward at the CONSTANT synodic rate, while
    // carringtonL0 is the true Meeus ephemeris, whose instantaneous rate
    // breathes with Earth's orbital eccentricity. The residual is bounded —
    // measured below — and is what "±0.6 d" in the watch list already covers.
    for (const m of marks) {
        const { L0 } = carringtonL0(new Date(m.epochMs));
        const lon = tracks.find((t) => t.id === m.id).lon;
        close(wrap180(lon - L0), -90, 1.1, `CMD at ${m.id}'s tick`);
    }

    assert.deepEqual(emergenceMarkers([], ANCHOR), []);
    assert.deepEqual(emergenceMarkers(null, ANCHOR), []);
}

// ── The countdown is real time, not a label ──────────────────────────────
{
    // A pinned region's lead time must shrink by exactly one day per day.
    const lon = 210;
    let prev = emergenceETA(lon, carringtonL0(new Date(ANCHOR)).L0).days;
    for (let d = 1; d <= 6; d++) {
        const eta = emergenceETA(lon, carringtonL0(new Date(ANCHOR + d * DAY)).L0).days;
        close(prev - eta, 1, 0.02, `day ${d} countdown`);
        prev = eta;
    }
    // And the rate is the synodic one, not some display constant.
    close(SYNODIC_DEG_PER_DAY * SYNODIC_PERIOD_DAYS, 360, 1e-9, 'rate closes the circle');
}

// ── How good is the constant-rate projection? ────────────────────────────
// A swept bound, not a spot check: worst case over two years of anchors and
// the full circle of longitudes. The number matters because the page quotes a
// ±0.6 d (≈14 h) confidence band — if the projection's own error ever grew
// comparable to that band, the band would be describing the wrong thing.
{
    let worstDeg = 0;
    for (let d = 0; d < 730; d += 7) {
        const anchor = Date.parse('2026-01-01T00:00:00Z') + d * DAY;
        const { L0 } = carringtonL0(new Date(anchor));
        for (let lon = 0; lon < 360; lon += 15) {
            const { days } = emergenceETA(lon, L0);
            const cmd = wrap180(lon - carringtonL0(new Date(anchor + days * DAY)).L0);
            worstDeg = Math.max(worstDeg, Math.abs(cmd + 90));
        }
    }
    const worstHours = (worstDeg / SYNODIC_DEG_PER_DAY) * 24;
    assert.ok(worstDeg < 1.1, `constant-rate residual ${worstDeg.toFixed(3)}deg`);
    assert.ok(worstHours < 3, `residual ${worstHours.toFixed(2)} h`);
    // Comfortably inside the smallest band the watch list can quote (0.5 d
    // floor from farside-track's `lonScatter / rate + 0.5`).
    assert.ok(worstHours < 0.5 * 24 * 0.25, 'residual well inside the quoted band');
}

console.log('\u2713 Far-Side Watch simulation clock');
