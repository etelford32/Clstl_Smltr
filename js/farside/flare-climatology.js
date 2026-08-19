/**
 * js/farside/flare-climatology.js — a flare BASE RATE for a far-side region.
 *
 * PURE. No DOM, no fetch, no ambient time. Node gate:
 * tests/flare-climatology.mjs.
 *
 * ── What this is, and firmly is not ────────────────────────────────────
 *
 * It is NOT a forecast that a particular region will erupt. Nobody can make
 * that call from seismic holography: a far-side detection gives a position
 * and an apparent size, and none of the things that actually predict flares
 * — magnetic complexity, δ-spots, shear, flux emergence rate — are
 * observable on the far side at all.
 *
 * What it IS: a climatological base rate — "regions of about this apparent
 * size currently carry an N% daily chance of an M-class flare". That is a
 * statement about a population, offered as context for a region we can only
 * forecast the ROTATION of. Every consumer must present it that way;
 * `caveat` is returned so the disclosure travels with the number.
 *
 * QUOTE THE DAILY NUMBER. `pDaily` is the defensible one: it is SWPC's own
 * 24 h forecast for a same-sized region, used as published. `pTransit`
 * compounds that rate over a whole disc passage and is therefore an UPPER
 * BOUND, not an estimate — it assumes a region's flare rate is constant for
 * thirteen days, when real regions emerge, peak and decay. At any rate above
 * a few percent a day the compounded figure saturates: 35 %/day reaches
 * 99.7 % over a passage, which is arithmetically correct and would read on
 * a page as a certainty nobody is entitled to. It is returned for callers
 * that genuinely want the bound, named `pTransitUpperBound` to make misuse
 * awkward, and the marker captions quote pDaily.
 *
 * It is deliberately kept OUT of the CME arrival forecast. The issue-locked
 * ledger on cme-forecast.html is an observation-driven artifact and nothing
 * here is allowed to move any number in it.
 *
 * ── Why a rank transform, not a unit conversion ────────────────────────
 *
 * The obvious construction — convert the seismic signature's area in deg²
 * to sunspot area in millionths of a hemisphere, then look up a published
 * flare rate — needs a calibration constant nobody has. The phase-shift
 * footprint is not the sunspot area; it is much larger, by a factor that
 * depends on the region and on the holography's point spread. Picking a
 * number there would be inventing the dominant term.
 *
 * So this maps by RANK instead. The detection's area is converted to its
 * percentile within the far-side population observed in the same map, and
 * that percentile is read off the area distribution of the NOAA-numbered
 * regions currently on the disc. The only assumption is that size ORDERING
 * survives the two observing methods — far weaker than assuming a linear
 * scale, and it needs no fitted constant.
 *
 * ── Where the probabilities come from ──────────────────────────────────
 *
 * SWPC's own per-region flare probabilities, as published in
 * solar_regions.json and relayed by /api/noaa/regions. They are an
 * operational forecast product, so this module is not re-deriving flare
 * physics — it is asking "what does SWPC say about the Earth-side region
 * that is the same size rank as this far-side one?".
 *
 * Field-name note: the upstream spellings could not be verified from the
 * build environment (services.swpc.noaa.gov is unreachable behind the
 * egress proxy), so `readProbability` accepts the documented spelling and
 * the obvious variants and returns null rather than guessing when none is
 * present. A null result must render as "unavailable", never as zero.
 */

import { SYNODIC_PERIOD_DAYS } from './carrington.js';

/** Half a rotation: how long an emerging region stays Earth-facing. */
export const DISC_TRANSIT_DAYS = SYNODIC_PERIOD_DAYS / 2;

/**
 * Fewest NOAA regions that make a rank match meaningful. Below this the
 * percentile is dominated by which handful of regions happen to be numbered
 * today, and the honest answer is "not enough to say".
 */
export const MIN_REGIONS = 4;

/** Fewest far-side detections needed to rank one against its own population. */
export const MIN_FARSIDE = 2;

const CLASS_KEYS = {
    c: ['c_flare_probability', 'cFlareProbability', 'c_flare_prob', 'c_prob', 'c'],
    m: ['m_flare_probability', 'mFlareProbability', 'm_flare_prob', 'm_prob', 'm'],
    x: ['x_flare_probability', 'xFlareProbability', 'x_flare_prob', 'x_prob', 'x'],
};

/** Raw probability field off a row, before any percent/fraction decision. */
function rawProbability(row, klass) {
    for (const key of CLASS_KEYS[klass] ?? []) {
        const raw = row?.[key];
        const v = typeof raw === 'string' ? parseFloat(raw) : raw;
        if (Number.isFinite(v) && v >= 0) return v;
    }
    return null;
}

/**
 * Decide whether a set of probability values is in percent or fraction.
 *
 * Decided over the WHOLE SET, never per value, because the single most
 * common real value is ambiguous on its own: SWPC publishes whole percents,
 * so `1` means one percent — but read in isolation it is also a legal
 * fraction meaning certainty. Judging each row separately turned the
 * quietest region on the disc into the most flare-prone one and inverted the
 * entire size ordering.
 *
 * Rules, most decisive first:
 *   · anything above 1 can only be a percent;
 *   · otherwise, all-integer values are SWPC's percent format (a genuine
 *     fraction set that happens to be exactly 0s and 1s is not a real
 *     probability set);
 *   · otherwise, fractions.
 */
export function detectProbabilityScale(rows, klass = 'm') {
    const vals = (rows || []).map((r) => rawProbability(r, klass)).filter((v) => v !== null);
    if (!vals.length) return 'percent';
    if (vals.some((v) => v > 1)) return 'percent';
    if (vals.every((v) => Number.isInteger(v))) return 'percent';
    return 'fraction';
}

/**
 * Read a flare probability off a NOAA region row as a fraction in [0,1].
 *
 * Pass `scale` from detectProbabilityScale() over the whole feed. Omitting it
 * falls back to the per-value guess, which is only safe for a value that is
 * unambiguously a percent (> 1) — see the note above.
 */
export function readProbability(row, klass = 'm', scale = null) {
    const v = rawProbability(row, klass);
    if (v === null) return null;
    const asPercent = scale ? scale === 'percent' : v > 1;
    return asPercent ? Math.min(v / 100, 1) : Math.min(v, 1);
}

/** Sunspot area off a NOAA region row (millionths of a hemisphere). */
export function readArea(row) {
    const raw = row?.area ?? row?.Area ?? row?.area_msh;
    const v = typeof raw === 'string' ? parseFloat(raw) : raw;
    return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Percentile of `value` within `population`, in [0,1].
 *
 * Midrank: ties share the average of the ranks they span, so a population of
 * identical areas returns 0.5 for all of them rather than 0 or 1. An empty
 * population has no percentile — null, not 0.5.
 */
export function areaPercentile(value, population) {
    const pop = (population || []).filter(Number.isFinite);
    if (!pop.length || !Number.isFinite(value)) return null;
    let below = 0, equal = 0;
    for (const p of pop) {
        if (p < value) below++;
        else if (p === value) equal++;
    }
    return (below + equal / 2) / pop.length;
}

/** Value at percentile `p` of a sorted ascending array (linear interpolation). */
export function quantileOf(sortedAsc, p) {
    const n = sortedAsc.length;
    if (!n) return null;
    if (n === 1) return sortedAsc[0];
    const idx = Math.min(Math.max(p, 0), 1) * (n - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sortedAsc[lo];
    return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

/**
 * Poisson daily rate implied by a probability of at least one event in 24 h.
 * p = 1 − e^(−λ)  ⇒  λ = −ln(1 − p).
 */
export function rateFromDailyProbability(p) {
    if (!Number.isFinite(p) || p < 0) return null;
    if (p >= 1) return Infinity;
    return -Math.log(1 - p);
}

/**
 * P(at least one event in `days`) for a Poisson rate per day.
 *
 * An infinite rate is the legitimate limit of a 100 % daily probability, not
 * bad input: certainty over one day is certainty over any positive span. It
 * has to be handled explicitly because Number.isFinite(Infinity) is false and
 * a blanket finiteness guard would turn "certain" into "unknown".
 */
export function probabilityOver(lambdaPerDay, days) {
    if (typeof lambdaPerDay !== 'number' || Number.isNaN(lambdaPerDay) || lambdaPerDay < 0) return null;
    if (!Number.isFinite(days) || days < 0) return null;
    if (lambdaPerDay === Infinity) return days > 0 ? 1 : 0;
    return 1 - Math.exp(-lambdaPerDay * days);
}

/**
 * Base rate for one far-side detection.
 *
 * @param {object} opts
 * @param {number} opts.areaDeg2       the detection's apparent area
 * @param {number[]} opts.farSideAreas apparent areas of the whole far-side
 *   population in the same map (including this one) — the rank reference
 * @param {object[]} opts.noaaRegions  rows from /api/noaa/regions
 * @param {string} [opts.klass='m']    flare class
 * @param {number} [opts.transitDays]  Earth-facing dwell (default: half a rotation)
 * @returns {null|{
 *   klass:string, percentile:number, matchedAreaMsh:number,
 *   pDaily:number, lambdaPerDay:number, pTransit:number,
 *   transitDays:number, nRegions:number, nFarSide:number,
 *   source:string, caveat:string
 * }}  null when the inputs cannot support a statement.
 */
export function flareClimatology({
    areaDeg2, farSideAreas, noaaRegions, klass = 'm', transitDays = DISC_TRANSIT_DAYS,
} = {}) {
    if (!Number.isFinite(areaDeg2)) return null;

    const farSide = (farSideAreas || []).filter(Number.isFinite);
    if (farSide.length < MIN_FARSIDE) return null;

    // NOAA rows that carry BOTH an area and a probability — a row missing
    // either cannot take part in the rank match.
    const scale = detectProbabilityScale(noaaRegions, klass);
    const usable = (noaaRegions || [])
        .map((r) => ({ area: readArea(r), p: readProbability(r, klass, scale) }))
        .filter((r) => r.area !== null && r.p !== null);
    if (usable.length < MIN_REGIONS) return null;

    const percentile = areaPercentile(areaDeg2, farSide);
    if (percentile === null) return null;

    // Rank-match into the NOAA population: same percentile of area, and the
    // probability SWPC assigns at that rank. Sorted jointly so the pairing
    // survives (area, probability) — matching them independently would quote
    // a probability that belongs to a different region.
    const byArea = usable.slice().sort((a, b) => a.area - b.area);
    const areas = byArea.map((r) => r.area);
    const probs = byArea.map((r) => r.p);
    const matchedAreaMsh = quantileOf(areas, percentile);
    const pDaily = quantileOf(probs, percentile);
    if (pDaily === null || matchedAreaMsh === null) return null;

    const lambdaPerDay = rateFromDailyProbability(pDaily);
    const pTransitUpperBound = probabilityOver(lambdaPerDay, transitDays);
    if (pTransitUpperBound === null) return null;

    return {
        klass,
        percentile,
        matchedAreaMsh,
        pDaily,
        lambdaPerDay,
        // Constant-rate compounding over a full passage — a bound, not an
        // estimate. See the header before putting this on a screen.
        pTransitUpperBound,
        transitDays,
        nRegions: usable.length,
        nFarSide: farSide.length,
        source: 'NOAA SWPC per-region flare probabilities, size-rank matched',
        caveat: 'Base rate for regions of this apparent size — not a forecast '
            + 'that this region will erupt. Far-side holography cannot see magnetic '
            + 'complexity, which is what actually predicts flares.',
    };
}

/**
 * Attach a base rate to each track, in one pass over a shared population.
 * Tracks whose climatology cannot be supported get `flare: null` — the
 * caller renders that as "unavailable", never as a low probability.
 */
export function attachFlareClimatology(tracks, noaaRegions, opts = {}) {
    const areas = (tracks || []).map((t) => t?.areaDeg2).filter(Number.isFinite);
    return (tracks || []).map((t) => ({
        ...t,
        flare: flareClimatology({
            areaDeg2: t?.areaDeg2,
            farSideAreas: areas,
            noaaRegions,
            ...opts,
        }),
    }));
}
