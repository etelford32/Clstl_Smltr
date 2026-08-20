// corridor-model.mjs — pure contract tests for the 3D corridor's scene model.
//
// The headline assertion is the frame identity: a far-side region's
// central-meridian distance IS Stonyhurst longitude, so ropeFrame() places a
// surface region and a rope launched from it in the same frame. If that ever
// drifts, a region and its own CME appear on opposite limbs — which looks
// plausible and is completely wrong.

import assert from 'node:assert/strict';
import {
    SUN_R_AU, sourceDirection, isEarthFacing, placeSourceRegions,
    ropeFlightSeconds, ropeGeometryAt, trainAt, leadingApexAu, arrivalWindowState,
} from '../js/corridor/corridor-model.js';
import { ropeFrame } from '../js/flux-rope/view.js';
import { carringtonL0, wrap180 } from '../js/farside/carrington.js';
import { projectTracks } from '../js/farside/farside-track.js';

const DAY = 86400000;
const ANCHOR = Date.parse('2026-08-19T12:00:00Z');
const close = (a, b, tol, what) =>
    assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);
const vecClose = (a, b, tol, what) => {
    for (let i = 0; i < 3; i++) close(a[i], b[i], tol, `${what}[${i}]`);
};

// ── CMD is Stonyhurst longitude ──────────────────────────────────────────
{
    // Sub-Earth region points straight at Earth (+x).
    vecClose(sourceDirection(0, 0), [1, 0, 0], 1e-12, 'sub-Earth');
    // North pole is +z regardless of longitude.
    vecClose(sourceDirection(0, 90), [0, 0, 1], 1e-12, 'north pole');
    vecClose(sourceDirection(137, 90), [0, 0, 1], 1e-12, 'north pole, any lon');
    // Behind the Sun.
    vecClose(sourceDirection(180, 0), [-1, 0, 0], 1e-12, 'anti-Earth');

    // The east and west limbs are opposite in y, and both perpendicular to
    // the Sun-Earth line. Which sign is which is ropeFrame's convention —
    // the point under test is that we adopt it rather than inventing one.
    const east = sourceDirection(-90, 0), west = sourceDirection(90, 0);
    close(east[0], 0, 1e-12, 'east limb has no Earthward component');
    close(west[0], 0, 1e-12, 'west limb has no Earthward component');
    close(east[1], -west[1], 1e-12, 'limbs are opposite');
    assert.ok(Math.abs(east[1]) > 0.99, 'east limb is fully transverse');

    // THE IDENTITY: a region placed by CMD and a rope launched at that same
    // Stonyhurst longitude occupy the same direction. Same function, so this
    // is a statement about how we CALL it.
    for (const cmd of [-170, -90, -33, 0, 12, 90, 179]) {
        for (const lat of [-30, -7, 0, 15, 42]) {
            vecClose(sourceDirection(cmd, lat), ropeFrame(cmd, lat, 0).eDir, 1e-12,
                `identity @ ${cmd},${lat}`);
        }
    }
    // Tilt must not move the launch direction — only the rope's plane.
    vecClose(ropeFrame(30, 10, 0).eDir, ropeFrame(30, 10, 75).eDir, 1e-12, 'tilt-invariant');
}

// ── Earth-facing test ────────────────────────────────────────────────────
{
    assert.equal(isEarthFacing(0), true);
    assert.equal(isEarthFacing(-89.9), true);
    assert.equal(isEarthFacing(90), true);
    assert.equal(isEarthFacing(-90.1), false);
    assert.equal(isEarthFacing(180), false);
    // Wrapping: 270 is the same place as -90.
    assert.equal(isEarthFacing(270), true);
}

// ── Regions co-rotate; the clock sweeps them ─────────────────────────────
{
    // A region pinned in Carrington longitude, observed at two instants.
    const lonCarr = 210, lat = -12;
    const track = { id: 'r1', lon: lonCarr, lat, etaBandDays: 0.6 };

    const at = (ms) => placeSourceRegions(
        projectTracks([track], carringtonL0(new Date(ms)).L0, ms))[0];

    const now = at(ANCHOR);
    const later = at(ANCHOR + 4 * DAY);

    // Carrington longitude unchanged; CMD advanced by 4 days of rotation.
    close(later.lon, now.lon, 1e-9, 'Carrington longitude is pinned');
    close(wrap180(later.cmd - now.cmd), 4 * 13.199, 0.15, 'CMD advances at the synodic rate');
    // ...so the drawn direction genuinely moved.
    assert.ok(Math.hypot(
        later.dir[0] - now.dir[0], later.dir[1] - now.dir[1], later.dir[2] - now.dir[2],
    ) > 0.5, 'the region swept across the Sun');

    // Direction is a unit vector at every instant.
    for (const p of [now, later]) close(Math.hypot(...p.dir), 1, 1e-12, 'unit direction');

    // Scrub to the region's own emergence and it lands on the limb.
    const crossing = ANCHOR + now.etaDays * DAY;
    close(Math.abs(at(crossing).cmd), 90, 1.5, 'at its own ETA the region is at the limb');

    assert.deepEqual(placeSourceRegions([]), []);
    assert.deepEqual(placeSourceRegions(null), []);
    // Junk rows are dropped, not drawn at NaN.
    assert.deepEqual(placeSourceRegions([{ id: 'x' }, { id: 'y', cmd: 10 }]), []);
}

// ── Rope flight time + geometry ──────────────────────────────────────────
const ROPE = {
    lonDeg: -12, latDeg: 4, tiltDeg: 20,
    v0Kms: 1100, gammaPerKm: 2e-7, sigma1AuAu: 0.14, nSigma: 1.14, wKms: 420,
};
{
    const epoch = ANCHOR;
    close(ropeFlightSeconds(ROPE, epoch, epoch + 3600e3), 3600, 1e-6, 'one hour of flight');
    close(ropeFlightSeconds({ ...ROPE, launchOffsetS: 7200 }, epoch, epoch + 3600e3),
        -3600, 1e-6, 'a later member has not launched yet');

    // Not launched / degenerate → no geometry, rather than a rope at the Sun.
    assert.equal(ropeGeometryAt(ROPE, 0, -10), null);
    assert.equal(ropeGeometryAt(ROPE, 0, 0), null);
    assert.equal(ropeGeometryAt(null, 0, 1000), null);

    // Mirror path (no kernel).
    const g = ropeGeometryAt(ROPE, 0, 20 * 3600);
    assert.equal(g.oracle, 'mirror');
    assert.ok(g.dAu > 0 && g.dAu < 1.5, `apex in range (${g.dAu})`);
    assert.ok(g.sigApexAu > 0 && g.sigApexAu < g.dAu, 'cross-section smaller than the throw');
    vecClose(g.frame.eDir, ropeFrame(ROPE.lonDeg, ROPE.latDeg, ROPE.tiltDeg).eDir, 1e-12,
        'frame from the rope fit');

    // Monotone outward.
    const later = ropeGeometryAt(ROPE, 0, 40 * 3600);
    assert.ok(later.dAu > g.dAu, 'the rope moves outward');
    assert.ok(later.sigApexAu > g.sigApexAu, 'and expands');
}

// ── Kernel is preferred, and is really consulted ─────────────────────────
{
    let asked = null;
    const kernel = {
        apexKmAt: (i, tS) => { asked = { i, tS }; return 0.42 * 1.495978707e8; },
        sigmaApexKmAt: () => 0.05 * 1.495978707e8,
    };
    const g = ropeGeometryAt(ROPE, 2, 30 * 3600, kernel);
    assert.equal(g.oracle, 'kernel');
    close(g.dAu, 0.42, 1e-9, 'apex straight from the probe');
    close(g.sigApexAu, 0.05, 1e-9, 'sigma straight from the probe');
    assert.deepEqual(asked, { i: 2, tS: 30 * 3600 }, 'probed for THIS rope at THIS time');

    // A kernel returning nonsense must not poison the scene — fall back.
    const bad = ropeGeometryAt(ROPE, 0, 30 * 3600,
        { apexKmAt: () => NaN, sigmaApexKmAt: () => NaN });
    assert.equal(bad.oracle, 'mirror', 'a bad probe degrades to the pinned mirror');
}

// ── The train ────────────────────────────────────────────────────────────
{
    const preset = {
        ropes: [
            { ...ROPE, launchOffsetS: 0 },
            { ...ROPE, lonDeg: 20, v0Kms: 800, launchOffsetS: 6 * 3600 },
            { ...ROPE, lonDeg: -40, v0Kms: 600, launchOffsetS: 40 * 3600 },
        ],
    };
    const epoch = ANCHOR;

    // 20 h in: two members launched, the third has not.
    const mid = trainAt(preset, epoch, epoch + 20 * 3600e3);
    assert.equal(mid.length, 2, 'unlaunched members are absent, not drawn at the Sun');
    assert.deepEqual(mid.map((m) => m.index), [0, 1]);
    assert.ok(mid[0].geometry.dAu > mid[1].geometry.dAu, 'the earlier, faster rope leads');
    close(mid[1].launchMs, epoch + 6 * 3600e3, 1, 'member launch time');

    // 60 h in: all three.
    assert.equal(trainAt(preset, epoch, epoch + 60 * 3600e3).length, 3);
    // Before the epoch: nothing.
    assert.equal(trainAt(preset, epoch, epoch - 3600e3).length, 0);

    close(leadingApexAu(mid), mid[0].geometry.dAu, 1e-12, 'leading apex');
    assert.equal(leadingApexAu([]), null);
    assert.equal(leadingApexAu(null), null);

    // Single-rope presets still work.
    assert.equal(trainAt({ rope: ROPE }, epoch, epoch + 20 * 3600e3).length, 1);
    assert.equal(trainAt(null, epoch, epoch).length, 0);
}

// ── Arrival window state ─────────────────────────────────────────────────
{
    const ev = {
        id: 'PP-1',
        earlyMs: ANCHOR + 24 * 3600e3,
        predictedMs: ANCHOR + 31 * 3600e3,
        lateMs: ANCHOR + 39 * 3600e3,
    };
    const before = arrivalWindowState(ev, ANCHOR);
    assert.equal(before.open, false);
    assert.equal(before.past, false);
    assert.ok(before.fraction < 0, 'before the window opens');
    close(before.hoursToMedian, 31, 1e-6, 'countdown to median');

    const inside = arrivalWindowState(ev, ANCHOR + 30 * 3600e3);
    assert.equal(inside.open, true);
    assert.ok(inside.fraction > 0 && inside.fraction < 1);

    const after = arrivalWindowState(ev, ANCHOR + 50 * 3600e3);
    assert.equal(after.open, false);
    assert.equal(after.past, true);
    assert.ok(after.fraction > 1);
    assert.ok(after.hoursToMedian < 0, 'the median is behind us');

    // A zero-width window must not divide by zero.
    const pin = arrivalWindowState({ id: 'z', earlyMs: ANCHOR, lateMs: ANCHOR }, ANCHOR);
    assert.ok(Number.isFinite(pin.fraction));
    assert.equal(arrivalWindowState(null, ANCHOR), null);
    assert.equal(arrivalWindowState({ id: 'q' }, ANCHOR), null);
}

// ── Sun radius sanity ────────────────────────────────────────────────────
{
    close(SUN_R_AU, 0.00465, 1e-4, 'solar radius in AU');
    assert.ok(SUN_R_AU < 0.01, 'the Sun is small next to the corridor');
}

console.log('✓ 3D corridor scene model');
