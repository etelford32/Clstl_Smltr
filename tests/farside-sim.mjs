// farside-sim.mjs — the physics contract the Far-Side Watch simulation rests
// on: what the clock is allowed to move, and what it is not.
//
// The failure this exists to catch is silent. If the synthetic field's anchor
// ever gets re-derived from the OBSERVED instant instead of the session
// anchor — a one-word edit in farside-feed.js — the planted regions travel
// with the observer. Central-meridian distance then never changes, lead times
// never count down, nothing ever crosses the limb, and the page still renders
// perfectly: a rotation simulation in which nothing rotates.

import assert from 'node:assert/strict';
import { simulateMap, getLatestMap } from '../js/farside/farside-feed.js';
import { detectSignatures } from '../js/farside/farside-detect.js';
import { buildTracks, projectTrack, projectTracks } from '../js/farside/farside-track.js';
import { carringtonL0, emergenceETA, wrap180 } from '../js/farside/carrington.js';

const DAY = 86400000;
const ANCHOR = Date.parse('2026-08-19T12:00:00Z');
const close = (a, b, tol, what) =>
    assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);

/** Planted-truth longitudes the generator baked into a simulated map. */
const plantedAt = (whenMs, anchorMs) =>
    simulateMap('gong', whenMs, anchorMs).regions.map((r) => r.lon).sort((a, b) => a - b);

/** Detected blob longitudes for one simulated instant. */
const detectedAt = (whenMs, anchorMs) =>
    detectSignatures(simulateMap('gong', whenMs, anchorMs)).map((d) => d.lon);

/** Nearest detection to a longitude, in degrees of separation. */
const nearest = (dets, lon) =>
    Math.min(...dets.map((d) => Math.abs(wrap180(d - lon))));

// ── Regions are PINNED; the observer moves ───────────────────────────────
{
    const base = plantedAt(ANCHOR, ANCHOR);
    assert.ok(base.length >= 3, 'the generator plants regions');

    // Same anchor, observer marched across the whole scrub window: the planted
    // truth is bit-identical every time. This is the invariant — tested on the
    // generator's own record rather than on detections, so detector noise
    // cannot mask a real drift or fake one.
    for (const offsetDays of [-7, -3, -0.5, 1, 5, 12, 27]) {
        assert.deepEqual(plantedAt(ANCHOR + offsetDays * DAY, ANCHOR), base,
            `planted regions pinned at ${offsetDays} d`);
    }

    // ...while L0 sweeps a full circle over that same window.
    const l0Start = carringtonL0(new Date(ANCHOR)).L0;
    const l0End = carringtonL0(new Date(ANCHOR + 27.2753 * DAY)).L0;
    close(Math.abs(wrap180(l0End - l0Start)), 0, 1.5, 'one rotation returns L0');
    const l0Mid = carringtonL0(new Date(ANCHOR + 13.6 * DAY)).L0;
    assert.ok(Math.abs(wrap180(l0Mid - l0Start)) > 170, 'half a rotation is ~180 deg away');
}

// ── The detector actually finds them, at every epoch ─────────────────────
{
    const planted = plantedAt(ANCHOR, ANCHOR);

    // One planted region sits within a few degrees of Carrington 0. That is
    // deliberate: it makes this gate exercise the detector's 0/360 seam
    // handling on a realistic noisy field (see tests/farside-detect.mjs).
    assert.ok(planted.some((lon) => Math.abs(wrap180(lon)) < 15),
        'a planted region straddles the 0/360 seam');

    // 2 deg tolerance: the background noise is re-seeded per 12 h slot, which
    // nudges each blob's threshold footprint and its centroid by about a
    // degree. Extra detections are expected too — the generator plants 0-3
    // random transient specks per slot as honest false-alarm fodder — so this
    // asks "is each planted region found?", not "are the counts equal?".
    for (const offsetDays of [-7, 0, 5, 12, 27]) {
        const dets = detectedAt(ANCHOR + offsetDays * DAY, ANCHOR);
        for (const lon of planted) {
            assert.ok(nearest(dets, lon) <= 2,
                `region at ${lon.toFixed(1)} deg found at ${offsetDays} d ` +
                `(nearest detection ${nearest(dets, lon).toFixed(2)} deg away)`);
        }
    }
}

// ── The anchor is what pins them ─────────────────────────────────────────
{
    // Anchoring to the observed instant is the bug. Prove it MOVES things, so
    // the guard above is testing something real rather than a tautology.
    const pinned = plantedAt(ANCHOR + 10 * DAY, ANCHOR);
    const dragged = plantedAt(ANCHOR + 10 * DAY, ANCHOR + 10 * DAY);
    const moved = dragged.some((lon, i) => Math.abs(wrap180(lon - pinned[i])) > 2);
    assert.ok(moved,
        'anchoring to the observed instant drags the regions - that is the bug');
}

// ── Field determinism ────────────────────────────────────────────────────
{
    // Same (instant, anchor) must give a byte-identical field: the scrubber
    // revisits epochs constantly and the map must not shimmer.
    const a = simulateMap('gong', ANCHOR + 2 * DAY, ANCHOR);
    const b = simulateMap('gong', ANCHOR + 2 * DAY, ANCHOR);
    assert.equal(a.data.length, b.data.length);
    for (let i = 0; i < a.data.length; i += 997) assert.equal(a.data[i], b.data[i]);
    assert.equal(a.L0, b.L0);

    // A simulated epoch is ALWAYS labelled synthetic — a stored real grid
    // cannot answer for a time that has not happened.
    assert.equal(a.synthetic, true);
}

// ── Emergence: the crossing instant does not depend on when you ask ──────
{
    const series = [];
    for (let i = 5; i >= 0; i--) series.push(simulateMap('gong', ANCHOR - i * 0.5 * DAY, ANCHOR));
    const tracks = buildTracks(series).filter((t) => !t.onDisc);
    assert.ok(tracks.length >= 1, 'tracking links the planted regions');

    for (const t of tracks) {
        const atAnchor = projectTrack(t, carringtonL0(new Date(ANCHOR)).L0, ANCHOR);
        // Re-ask three days later. The COUNTDOWN must shrink by three days and
        // the predicted absolute crossing must stay put — that invariance is
        // the difference between a forecast and a rolling guess.
        const later = ANCHOR + 3 * DAY;
        const atLater = projectTrack(t, carringtonL0(new Date(later)).L0, later);

        close(atAnchor.etaDays - atLater.etaDays, 3, 0.05, `${t.id} countdown`);
        close(
            Date.parse(atLater.emergenceUTC) - Date.parse(atAnchor.emergenceUTC), 0,
            2 * 3600e3, `${t.id} crossing instant is stable`,
        );

        // And at that instant the region really is on the east limb.
        const crossMs = Date.parse(atAnchor.emergenceUTC);
        const cmd = wrap180(t.lon - carringtonL0(new Date(crossMs)).L0);
        close(cmd, -90, 1.1, `${t.id} at the limb`);
    }
}

// ── projectTracks ordering + emerged handling ────────────────────────────
{
    const tracks = [
        { id: 'far', lon: 200, etaBandDays: 0.6 },
        { id: 'soon', lon: 260, etaBandDays: 0.6 },
        { id: 'disc', lon: 0, etaBandDays: 0.6 },
    ];
    // Pick an L0 that puts 'disc' on the Earth-facing hemisphere.
    const L0 = 0;
    const out = projectTracks(tracks, L0, ANCHOR);
    assert.equal(out.length, 3, 'emerged regions are KEPT, not filtered out');
    assert.equal(out[out.length - 1].id, 'disc', 'emerged sorts last');
    assert.equal(out[out.length - 1].onDisc, true);
    // Far-side entries are soonest-first.
    assert.ok(out[0].etaDays <= out[1].etaDays);
    // Every one agrees with the geometry module.
    for (const t of out) {
        assert.equal(t.etaDays, emergenceETA(t.lon, L0).days);
    }
    // Time-invariant fields survive projection untouched.
    assert.equal(out.find((t) => t.id === 'far').etaBandDays, 0.6);

    assert.deepEqual(projectTracks([], 0, ANCHOR), []);
    assert.deepEqual(projectTracks(null, 0, ANCHOR), []);
}

// ── getLatestMap honours allowRemote ─────────────────────────────────────
{
    // With remote reads disabled there must be no fetch at all — the scrub
    // path has to work offline and synchronously enough to animate.
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => { calls++; return Promise.reject(new Error('no network in tests')); };
    try {
        const map = await getLatestMap('gong', { atMs: ANCHOR, anchorMs: ANCHOR, allowRemote: false });
        assert.equal(calls, 0, 'allowRemote:false performs no fetch');
        assert.equal(map.synthetic, true);
        assert.deepEqual(
            map.regions.map((r) => r.lon).sort((a, b) => a - b),
            plantedAt(ANCHOR, ANCHOR), 'same field as simulateMap for the same instants');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

console.log('✓ Far-Side Watch simulation physics');
