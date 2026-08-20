// flare-climatology.mjs — contract tests for the far-side flare BASE RATE.
//
// The thing most worth protecting here is what the module REFUSES to say.
// A flare base rate that silently degrades to 0 %, or that invents a number
// from two regions, would read on the page as "this region is quiet" — a
// claim nobody can make from seismic holography. Every thin-input path below
// asserts null, not a small number.

import assert from 'node:assert/strict';
import {
    DISC_TRANSIT_DAYS, MIN_REGIONS, MIN_FARSIDE,
    readProbability, readArea, areaPercentile, quantileOf,
    detectProbabilityScale, rateFromDailyProbability, probabilityOver,
    flareClimatology, attachFlareClimatology,
} from '../js/farside/flare-climatology.js';
import { SYNODIC_PERIOD_DAYS } from '../js/farside/carrington.js';

const close = (a, b, tol, what) =>
    assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);

// A plausible NOAA disc: five regions, area ascending with flare probability.
const NOAA = [
    { region: 14101, area: 20, m_flare_probability: 1 },
    { region: 14102, area: 80, m_flare_probability: 5 },
    { region: 14103, area: 240, m_flare_probability: 15 },
    { region: 14104, area: 600, m_flare_probability: 35 },
    { region: 14105, area: 1400, m_flare_probability: 60 },
];

// ── Reading upstream rows ────────────────────────────────────────────────
{
    // SWPC publishes whole percents; some mirrors use fractions. Both parse,
    // and the split is unambiguous because a probability cannot exceed 1.
    close(readProbability({ m_flare_probability: 35 }), 0.35, 1e-12, 'percent');
    close(readProbability({ m_flare_probability: 0.35 }), 0.35, 1e-12, 'fraction');
    close(readProbability({ m_flare_probability: '35' }), 0.35, 1e-12, 'string percent');
    close(readProbability({ mFlareProbability: 12 }), 0.12, 1e-12, 'camelCase variant');
    close(readProbability({ c_flare_probability: 70 }, 'c'), 0.70, 1e-12, 'C class');
    close(readProbability({ x_flare_probability: 5 }, 'x'), 0.05, 1e-12, 'X class');
    // 100 % clamps to 1, not 100.
    close(readProbability({ m_flare_probability: 100 }), 1, 1e-12, 'certainty clamps');

    // THE AMBIGUOUS VALUE. SWPC publishes whole percents, so 1 means 1 % —
    // but in isolation it is also a legal fraction meaning certainty. The
    // scale is therefore a property of the FEED, not of a row: read per-row,
    // a 1 % region became the most flare-prone on the disc and inverted the
    // whole size ordering.
    assert.equal(detectProbabilityScale(NOAA), 'percent', 'integers are SWPC percents');
    close(readProbability({ m_flare_probability: 1 }, 'm', 'percent'), 0.01, 1e-12, '1 means 1 %');
    close(readProbability({ m_flare_probability: 1 }, 'm', 'fraction'), 1, 1e-12, 'or certainty, told so');
    // A set containing anything above 1 is unambiguously percent...
    assert.equal(detectProbabilityScale([{ m_flare_probability: 0 }, { m_flare_probability: 45 }]), 'percent');
    // ...and a set of genuine non-integer fractions is read as fractions.
    assert.equal(detectProbabilityScale([{ m_flare_probability: 0.05 }, { m_flare_probability: 0.4 }]), 'fraction');
    // An empty / probability-free feed does not throw.
    assert.equal(detectProbabilityScale([]), 'percent');
    assert.equal(detectProbabilityScale(null), 'percent');

    // Absent or unusable → null. NEVER 0: "no data" and "no chance" are
    // different claims and the page renders them differently.
    assert.equal(readProbability({}), null);
    assert.equal(readProbability(null), null);
    assert.equal(readProbability({ m_flare_probability: null }), null);
    assert.equal(readProbability({ m_flare_probability: 'n/a' }), null);
    assert.equal(readProbability({ m_flare_probability: -3 }), null);

    close(readArea({ area: 240 }), 240, 1e-12, 'area');
    close(readArea({ Area: '240' }), 240, 1e-12, 'area variant');
    assert.equal(readArea({}), null);
    assert.equal(readArea({ area: 'none' }), null);
}

// ── Rank transform ───────────────────────────────────────────────────────
{
    const pop = [10, 20, 30, 40];
    close(areaPercentile(5, pop), 0, 1e-12, 'below everything');
    close(areaPercentile(50, pop), 1, 1e-12, 'above everything');
    // Midrank: a value equal to one member sits at its own midpoint.
    close(areaPercentile(10, pop), 0.125, 1e-12, 'midrank of the smallest');
    close(areaPercentile(30, pop), 0.625, 1e-12, 'midrank of the third');
    // All-identical population is not 0 or 1 for its own members.
    close(areaPercentile(7, [7, 7, 7]), 0.5, 1e-12, 'ties share the rank');
    // Monotone in the value — the whole point of the transform.
    let prev = -1;
    for (const v of [1, 12, 25, 33, 41, 99]) {
        const q = areaPercentile(v, pop);
        assert.ok(q >= prev, 'percentile is monotone');
        prev = q;
    }
    assert.equal(areaPercentile(10, []), null);
    assert.equal(areaPercentile(NaN, pop), null);
    assert.equal(areaPercentile(10, null), null);
}

{
    const s = [0, 10, 20, 30, 40];
    close(quantileOf(s, 0), 0, 1e-12, 'q0');
    close(quantileOf(s, 1), 40, 1e-12, 'q1');
    close(quantileOf(s, 0.5), 20, 1e-12, 'median');
    close(quantileOf(s, 0.625), 25, 1e-12, 'interpolated');
    close(quantileOf([7], 0.3), 7, 1e-12, 'single member');
    assert.equal(quantileOf([], 0.5), null);
    // Out-of-range percentiles clamp rather than index off the end.
    close(quantileOf(s, -2), 0, 1e-12, 'clamp low');
    close(quantileOf(s, 9), 40, 1e-12, 'clamp high');
}

// ── Poisson ──────────────────────────────────────────────────────────────
{
    close(rateFromDailyProbability(0), 0, 1e-12, 'no rate');
    close(rateFromDailyProbability(1 - Math.exp(-1)), 1, 1e-12, 'unit rate round trip');
    close(probabilityOver(1, 1), 1 - Math.exp(-1), 1e-12, 'one day at unit rate');
    // The round trip that matters: p24 → λ → p over one day is p24 again.
    for (const p of [0.01, 0.15, 0.5, 0.87]) {
        close(probabilityOver(rateFromDailyProbability(p), 1), p, 1e-12, `round trip ${p}`);
    }
    // Longer exposure never lowers the probability, and never exceeds 1.
    const lam = rateFromDailyProbability(0.2);
    let last = 0;
    for (const d of [0.5, 1, 5, 13.6, 40]) {
        const p = probabilityOver(lam, d);
        assert.ok(p >= last && p <= 1, `monotone and bounded at ${d} d`);
        last = p;
    }
    assert.equal(rateFromDailyProbability(1), Infinity, 'certainty is an infinite rate');
    assert.equal(probabilityOver(Infinity, 1), 1, 'and stays certain');
    assert.equal(rateFromDailyProbability(NaN), null);
    assert.equal(probabilityOver(1, -1), null);
}

// ── The base rate itself ─────────────────────────────────────────────────
{
    // Transit is half a rotation — the Earth-facing dwell, not a whole one.
    close(DISC_TRANSIT_DAYS, SYNODIC_PERIOD_DAYS / 2, 1e-12, 'disc transit');
    close(DISC_TRANSIT_DAYS, 13.64, 0.02, 'about 13.6 days');

    const farSide = [50, 120, 300, 700];

    const small = flareClimatology({ areaDeg2: 50, farSideAreas: farSide, noaaRegions: NOAA });
    const big = flareClimatology({ areaDeg2: 700, farSideAreas: farSide, noaaRegions: NOAA });
    assert.ok(small && big, 'a full disc supports a base rate');

    // Bigger regions rank higher and get a higher rate. This is the only
    // physical claim the module makes, and it must hold.
    assert.ok(big.percentile > small.percentile, 'bigger ranks higher');
    assert.ok(big.pDaily > small.pDaily, 'and matches a more flare-prone region');
    assert.ok(big.pTransitUpperBound > small.pTransitUpperBound, 'and a higher passage probability');
    assert.ok(big.matchedAreaMsh > small.matchedAreaMsh, 'matched area tracks the rank');

    // Exposure over a passage always exceeds the 24 h number — which is
    // exactly why it is a BOUND and not the number the page quotes: a rate
    // of a few percent a day compounds to near-certainty over thirteen days.
    for (const r of [small, big]) {
        assert.ok(r.pTransitUpperBound > r.pDaily, 'a passage is longer than a day');
        assert.ok(r.pTransitUpperBound <= 1 && r.pDaily <= 1, 'probabilities stay probabilities');
        close(probabilityOver(r.lambdaPerDay, r.transitDays), r.pTransitUpperBound, 1e-12, 'internally consistent');
        assert.equal(r.nRegions, NOAA.length);
        assert.equal(r.nFarSide, farSide.length);
        assert.equal(r.klass, 'm');
        assert.match(r.caveat, /not a forecast/, 'the disclosure travels with the number');
        assert.match(r.source, /SWPC/, 'provenance is stated');
    }

    // Rank matching is scale-free: multiply every far-side area by 10 and the
    // answer is unchanged. That is the property that lets us skip a
    // seismic-area-to-sunspot-area calibration constant nobody has.
    const scaled = flareClimatology({
        areaDeg2: 700 * 10,
        farSideAreas: farSide.map((a) => a * 10),
        noaaRegions: NOAA,
    });
    close(scaled.pTransitUpperBound, big.pTransitUpperBound, 1e-12, 'scale-free in far-side units');
    close(scaled.percentile, big.percentile, 1e-12, 'same rank');

    // X-class is rarer than M-class for the same region.
    const withX = NOAA.map((r) => ({ ...r, x_flare_probability: r.m_flare_probability / 6 }));
    const mm = flareClimatology({ areaDeg2: 700, farSideAreas: farSide, noaaRegions: withX });
    const xx = flareClimatology({ areaDeg2: 700, farSideAreas: farSide, noaaRegions: withX, klass: 'x' });
    assert.ok(xx.pTransitUpperBound < mm.pTransitUpperBound, 'X is rarer than M');
    assert.ok(xx.pDaily < mm.pDaily, 'and rarer per day, which is the quoted number');

    // The saturation the rename exists to guard against: a healthy daily rate
    // compounds to a near-certainty over a passage. Both numbers are correct;
    // only one of them belongs on a marker.
    assert.ok(big.pTransitUpperBound > 0.95, 'the bound saturates');
    assert.ok(big.pDaily < 0.6, 'while the daily rate stays a real forecast');
}

// ── What it refuses to say ───────────────────────────────────────────────
{
    const farSide = [50, 120, 300, 700];

    // Too few NOAA regions to rank against.
    assert.equal(flareClimatology({
        areaDeg2: 300, farSideAreas: farSide, noaaRegions: NOAA.slice(0, MIN_REGIONS - 1),
    }), null, 'a thin disc yields no claim');

    // Rows present but carrying no probability — the likely shape of an
    // upstream schema change. Must be null, NOT a 0 % base rate.
    assert.equal(flareClimatology({
        areaDeg2: 300, farSideAreas: farSide,
        noaaRegions: NOAA.map(({ region, area }) => ({ region, area })),
    }), null, 'no probabilities means no claim');

    // Rows with probabilities but no areas — nothing to rank against.
    assert.equal(flareClimatology({
        areaDeg2: 300, farSideAreas: farSide,
        noaaRegions: NOAA.map(({ region, m_flare_probability }) => ({ region, m_flare_probability })),
    }), null, 'no areas means no claim');

    // Too few far-side detections to rank this one within.
    assert.equal(flareClimatology({
        areaDeg2: 300, farSideAreas: [300].slice(0, MIN_FARSIDE - 1), noaaRegions: NOAA,
    }), null, 'a single detection has no population');

    // Missing / junk inputs.
    assert.equal(flareClimatology({ farSideAreas: farSide, noaaRegions: NOAA }), null);
    assert.equal(flareClimatology({ areaDeg2: NaN, farSideAreas: farSide, noaaRegions: NOAA }), null);
    assert.equal(flareClimatology({}), null);
    assert.equal(flareClimatology(), null);
}

// ── Attaching to tracks ──────────────────────────────────────────────────
{
    const tracks = [
        { id: 'a', areaDeg2: 60 },
        { id: 'b', areaDeg2: 420 },
        { id: 'c' },                       // no area — cannot be ranked
    ];
    const out = attachFlareClimatology(tracks, NOAA);
    assert.equal(out.length, 3, 'every track survives');
    assert.ok(out[0].flare && out[1].flare, 'sized tracks get a base rate');
    assert.equal(out[2].flare, null, 'an unsized track gets null, not a guess');
    assert.ok(out[1].flare.pTransitUpperBound > out[0].flare.pTransitUpperBound, 'ordering preserved');
    // The original fields are untouched.
    assert.equal(out[1].id, 'b');

    // A dead NOAA feed nulls every rate rather than zeroing them.
    for (const t of attachFlareClimatology(tracks, [])) assert.equal(t.flare, null);
    for (const t of attachFlareClimatology(tracks, null)) assert.equal(t.flare, null);
    assert.deepEqual(attachFlareClimatology([], NOAA), []);
    assert.deepEqual(attachFlareClimatology(null, NOAA), []);
}

console.log('✓ Far-side flare climatology (base rate, not a forecast)');
