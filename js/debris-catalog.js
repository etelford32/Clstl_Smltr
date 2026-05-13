/**
 * debris-catalog.js — taxonomy of tracked LEO debris families
 * ═══════════════════════════════════════════════════════════════════════════
 * Classifies each CelesTrak debris record into a known fragmentation
 * event family + assigns a size class, an estimated cross-section, and
 * a kinetic-hazard tier. Used by the upper-atmosphere globe to color
 * debris by source and surface the dominant catastrophic events in the
 * UI.
 *
 * Family attribution is by NORAD-ID range first (the catalog allocates
 * IDs sequentially at object-on-orbit registration, so a fragmentation
 * event produces a contiguous block of IDs), with a name-pattern
 * fallback for objects whose IDs we don't know about. The ranges below
 * are derived from public 18 SDS catalog summaries (CelesTrak's
 * SATCAT) and the Orbital Debris Quarterly News.
 *
 * Numbers are TRACKED-fragment counts (≥10 cm RCS — what 18 SDS can
 * keep custody of). The actual debris cloud from each event is much
 * larger; small fragments below the tracking threshold are estimated
 * with NASA's Standard Breakup Model (Johnson et al. 2001) and exceed
 * the tracked count by 10–100×.
 */

// ── Family registry ────────────────────────────────────────────────────────
// Each family has:
//   id         — short stable key
//   name       — display label
//   year       — event year (or null for cumulative/baseline groups)
//   color      — hex for the cloud point + UI swatch
//   hazardTier — 'critical' | 'high' | 'medium' | 'low' (kinetic + persistence)
//   noradMin/Max — fragment NORAD-ID range (inclusive). null = no range
//                  (use name pattern only).
//   namePattern — regex matched against the object name as a fallback
//   tracked    — current tracked fragment count (rounded; updates over
//                time as objects decay)
//   summary    — one-line operator-facing description

export const DEBRIS_FAMILIES = [
    {
        id: 'fengyun-1c',
        name: 'Fengyun-1C ASAT (2007)',
        year: 2007,
        color: '#ff3060',
        hazardTier: 'critical',
        noradMin: 29644, noradMax: 35941,
        namePattern: /^FENGYUN 1C DEB/i,
        tracked: 2700,
        peakAltKm: 850,
        summary: 'Chinese SC-19 ASAT test against the FY-1C weather sat at 865 km. '
               + 'Largest single debris-generating event in history. >40% of '
               + 'fragments still on orbit; cloud will persist for centuries.',
    },
    {
        id: 'cosmos-iridium-2009',
        name: 'Iridium-33 / Cosmos-2251 (2009)',
        year: 2009,
        color: '#ff7040',
        hazardTier: 'critical',
        noradMin: 33759, noradMax: 35946,
        namePattern: /^(IRIDIUM 33 DEB|COSMOS 2251 DEB)/i,
        tracked: 1800,
        peakAltKm: 790,
        summary: 'First confirmed accidental hypervelocity collision between '
               + 'two intact satellites at 789 km. Two clouds straddling the '
               + 'Iridium NEXT shell; primary conjunction concern for that '
               + 'constellation.',
    },
    {
        id: 'cosmos-1408',
        name: 'Cosmos 1408 ASAT (2021)',
        year: 2021,
        color: '#ff5070',
        hazardTier: 'critical',
        noradMin: 49231, noradMax: 51241,
        namePattern: /^COSMOS 1408 DEB/i,
        tracked: 1500,
        peakAltKm: 480,
        summary: 'Russian PL-19 Nudol ASAT test. Forced ISS evasive maneuvers '
               + 'and crew shelter-in-place. Lower altitude → faster decay '
               + 'than FY-1C, but heavily seeds the ISS and Starlink shells.',
    },
    {
        id: 'mission-shakti',
        name: 'Mission Shakti ASAT (2019)',
        year: 2019,
        color: '#ff9050',
        hazardTier: 'high',
        noradMin: 44116, noradMax: 44306,
        namePattern: /^MICROSAT-R DEB/i,
        tracked: 130,
        peakAltKm: 280,
        summary: 'Indian DRDO ASAT test against Microsat-R. Low intercept '
               + 'altitude (282 km) meant most fragments decayed within '
               + '1 year, but apogee-raised shrapnel reached the ISS shell.',
    },
    {
        id: 'long-march-6a',
        name: 'Long March 6A (Aug 2022 / Aug 2024)',
        year: 2022,
        color: '#ffaa30',
        hazardTier: 'high',
        noradMin: 53239, noradMax: 60500,
        namePattern: /^CZ-6A (DEB|R\/?B)/i,
        tracked: 700,
        peakAltKm: 800,
        summary: 'CZ-6A upper-stage breakups in Aug-2022 and Aug-2024 created '
               + 'two large clouds at 800 km. Second event (G60 launch) was '
               + 'the largest fragmentation since Cosmos 1408.',
    },
    {
        id: 'noaa-breakups',
        name: 'NOAA-class breakups',
        year: null,
        color: '#a070ff',
        hazardTier: 'medium',
        noradMin: null, noradMax: null,
        namePattern: /^(NOAA \d+ DEB|DMSP \d+ DEB)/i,
        tracked: 800,
        peakAltKm: 850,
        summary: 'Battery-thermal-runaway breakups of NOAA-16 (2015), '
               + 'NOAA-17 (2021), DMSP F11/F13. Produces persistent debris '
               + 'in the sun-synchronous belt at 800–870 km.',
    },
    {
        id: 'rocket-bodies',
        name: 'Spent rocket stages',
        year: null,
        color: '#60d8a0',
        hazardTier: 'medium',
        noradMin: null, noradMax: null,
        namePattern: /\b(R\/?B|SL-\d+|DELTA \d+|CENTAUR|ARIANE|H-2A|PSLV|LM-\d+|CZ-\d+)\b/i,
        tracked: 2400,
        peakAltKm: null,
        summary: 'Abandoned upper stages — large hard bodies that propagate '
               + 'cleanly and represent the highest energy-per-object class '
               + 'in the catalog. Several are ticking bombs (residual fuel).',
    },
    {
        id: 'generic-debris',
        name: 'Other tracked debris',
        year: null,
        color: '#ff7099',
        hazardTier: 'medium',
        noradMin: null, noradMax: null,
        namePattern: /\bDEB\b/i,
        tracked: 12000,
        peakAltKm: null,
        summary: 'All remaining tracked fragments — shroud separations, '
               + 'paint flecks, MLI shedding, micro-breakups, and '
               + 'unattributed debris. Heterogeneous in size and orbit.',
    },
    {
        id: 'unknown',
        name: 'Unclassified',
        year: null,
        color: '#9aa6c0',
        hazardTier: 'low',
        noradMin: null, noradMax: null,
        namePattern: null,
        tracked: 0,
        peakAltKm: null,
        summary: 'Object did not match a known family. Treated as generic '
               + 'tracked-object hazard.',
    },
];

const _BY_ID = Object.fromEntries(DEBRIS_FAMILIES.map(f => [f.id, f]));

/** Look up a family by id (e.g. 'fengyun-1c'). */
export function getFamily(id) { return _BY_ID[id] || null; }

// ── Optional SATCAT enrichment ─────────────────────────────────────────────
// `satcat-catalog.js` pushes a lookup here once the bulk CelesTrak
// SATCAT response has been parsed. When present:
//   - classifyDebris consults SATCAT OBJECT_TYPE as a last-resort
//     family hint (after NORAD-range + name-pattern), so anything the
//     heuristic falls through to 'unknown' on can still pick up
//     'rocket-bodies' or 'generic-debris' when SATCAT knows better.
//   - estimateSize consults SATCAT RCS bucket FIRST. Upstream data
//     trumps the heuristic where it disagrees, which is non-trivial
//     for active payloads (lots of comsats are "large" by RCS but the
//     name regex doesn't fire) and for old DEB fragments without a
//     known parent event.
//
// The shape is whatever `satcat-catalog.buildLookup()` returns; we
// only call `.get(noradId)` here, so any object with that method
// works for testing.
let _satcatLookup = null;

/** Install (or clear) the SATCAT lookup. Pass `null` to detach. */
export function setSatcatLookup(lookup) {
    _satcatLookup = lookup || null;
}

/** True iff SATCAT enrichment is active. */
export function hasSatcat() { return _satcatLookup !== null; }

// ── Classification ─────────────────────────────────────────────────────────

/**
 * Classify one debris record into a family.
 * Match priority: NORAD range → name pattern → fallback to 'generic-debris'
 * (for anything with "DEB" in the name) or 'unknown'.
 *
 * @param {object} rec   { noradId, name, ... } — accepts the shape from
 *                       fetchDebrisSample() OR a raw CelesTrak record
 *                       ({ norad_id, name }).
 * @returns {object}     The matched family entry.
 */
export function classifyDebris(rec) {
    const id   = Number(rec.noradId ?? rec.norad_id);
    const name = String(rec.name ?? '');

    // First pass: NORAD-range match (most specific).
    if (Number.isFinite(id)) {
        for (const f of DEBRIS_FAMILIES) {
            if (f.noradMin == null || f.noradMax == null) continue;
            if (id >= f.noradMin && id <= f.noradMax) {
                // Range hit — but cross-check name pattern when present
                // to avoid sweeping unrelated objects from the same epoch.
                if (!f.namePattern || f.namePattern.test(name)) return f;
            }
        }
    }

    // Second pass: name pattern.
    for (const f of DEBRIS_FAMILIES) {
        if (f.namePattern && f.namePattern.test(name)) return f;
    }

    // Third pass: SATCAT OBJECT_TYPE. Only consulted when the
    // previous passes fall through — name pattern + NORAD range are
    // more specific (they can pick a particular fragmentation event),
    // SATCAT just says "rocket body" or "debris" at the taxonomic
    // level. Promotes records the heuristic would otherwise drop
    // into 'unknown'.
    if (_satcatLookup && Number.isFinite(id)) {
        const sc = _satcatLookup.get(id);
        if (sc?.objectCategory === 'rocket-body')  return _BY_ID['rocket-bodies'];
        if (sc?.objectCategory === 'debris')       return _BY_ID['generic-debris'];
    }

    return _BY_ID['unknown'];
}

// ── Size & hazard estimation ───────────────────────────────────────────────
//
// CelesTrak's GP catalog doesn't carry RCS or mass, so we proxy from
// the object name (which encodes the source — DEB / R/B / payload) and
// the family hazard tier. Class boundaries follow the conventional
// space-debris size classes (Liou & Johnson 2006):
//
//   small   — 1 mm … 10 cm  (lethal but not tracked individually)
//   medium  — 10 cm … 1 m   (tracked; mission-killing on impact)
//   large   — > 1 m         (catastrophic; usually rocket bodies + intact)
//
// `massKg` is a rough median for the size class — used only for the Δv-
// required calculation in collision-avoidance and for hazard-energy
// scoring. Don't lean on these for orbit propagation.

const SIZE_CLASSES = {
    small:  { rangeM: '1 cm – 10 cm',  rcsM2: 0.005, massKg: 0.5,  pointPx: 0.010 },
    medium: { rangeM: '10 cm – 1 m',   rcsM2: 0.10,  massKg: 25,   pointPx: 0.014 },
    large:  { rangeM: '> 1 m',          rcsM2: 1.5,   massKg: 800,  pointPx: 0.020 },
};

export { SIZE_CLASSES };

/**
 * Estimate size class for a record. SATCAT first when available (the
 * upstream catalog carries an RCS measurement bucketed against the
 * Liou & Johnson 2006 thresholds); name + family heuristic otherwise.
 *
 * Returned shape always carries a `source` tag so the UI can be
 * honest about where the bucket came from:
 *   'satcat'    — RCS bucket from CelesTrak SATCAT (preferred)
 *   'heuristic' — derived from name pattern + family attribution
 *
 * @returns {{
 *   class:string, rangeM:string, rcsM2:number, massKg:number,
 *   pointPx:number, source:string, rcsRawM2?:number
 * }}
 */
export function estimateSize(rec, family) {
    const id   = Number(rec.noradId ?? rec.norad_id);
    const name = String(rec.name ?? '').toUpperCase();

    // ── SATCAT path ───────────────────────────────────────────────
    // When the loader has primed `_satcatLookup`, the upstream bucket
    // wins. We still attach the bucket-median massKg/rcsM2 from
    // SIZE_CLASSES so downstream KE / Δv calculations keep their
    // accustomed shape, but layer `rcsRawM2` (the actual RCS in m²)
    // alongside for code that wants the precise number.
    if (_satcatLookup && Number.isFinite(id)) {
        const sc = _satcatLookup.get(id);
        if (sc?.rcsClass && SIZE_CLASSES[sc.rcsClass]) {
            const base = SIZE_CLASSES[sc.rcsClass];
            return {
                class:    sc.rcsClass,
                ...base,
                source:   'satcat',
                rcsRawM2: sc.rcsRawM2,
            };
        }
    }

    // ── Heuristic path ────────────────────────────────────────────
    if (/\bR\/?B\b|ROCKET BODY|UPPER STAGE|CENTAUR|DELTA|ARIANE/.test(name)) {
        return { class: 'large', ...SIZE_CLASSES.large, source: 'heuristic' };
    }
    if (family && family.id === 'rocket-bodies') {
        return { class: 'large', ...SIZE_CLASSES.large, source: 'heuristic' };
    }
    // ASAT clouds: heavy fragmentation skews small.
    if (family && (family.id === 'cosmos-1408' || family.id === 'fengyun-1c'
                || family.id === 'mission-shakti')) {
        // 30% of ASAT fragments end up in the small-tracked tail.
        const r = (Number.isFinite(id) ? id : 0) % 100;
        return r < 30
            ? { class: 'small',  ...SIZE_CLASSES.small,  source: 'heuristic' }
            : { class: 'medium', ...SIZE_CLASSES.medium, source: 'heuristic' };
    }
    if (/\bDEB\b/.test(name)) {
        return { class: 'medium', ...SIZE_CLASSES.medium, source: 'heuristic' };
    }
    return { class: 'medium', ...SIZE_CLASSES.medium, source: 'heuristic' };
}

/**
 * Kinetic-energy hazard score (joules) at typical LEO closing speed.
 * Hypervelocity rule of thumb: 14 km/s relative for retrograde-prograde
 * crossing; aluminum's specific energy of fragmentation is ~40 J/g, so
 * any object > 100 g effectively destroys an unshielded satellite.
 *
 * Returns the energy in megajoules, easier to read than raw J.
 */
export function hazardEnergyMJ(massKg, vRelKmS = 14) {
    const v = vRelKmS * 1000;
    const E = 0.5 * massKg * v * v;
    return E / 1e6;
}

// ── Roll-ups for the UI ────────────────────────────────────────────────────

/**
 * Aggregate a debris sample into per-family counts + total hazard
 * energy. Returns an array sorted by count desc, ready to render as
 * a stacked bar / table.
 *
 * @param {object[]} probes  list of debris probes (each carries `_family`
 *                           + `_size` after passing through annotate()).
 */
export function summariseByFamily(probes) {
    const buckets = new Map();
    for (const p of probes) {
        const f = p._family || _BY_ID['unknown'];
        if (!buckets.has(f.id)) {
            buckets.set(f.id, { family: f, count: 0, mediumEnergyMJ: 0 });
        }
        const b = buckets.get(f.id);
        b.count += 1;
        if (p._size) b.mediumEnergyMJ += hazardEnergyMJ(p._size.massKg);
    }
    return Array.from(buckets.values()).sort((a, b) => b.count - a.count);
}

/**
 * Convenience: classify + size + hazard a record in one shot. Returns
 * the annotation object that the globe attaches to each debris probe.
 *
 *   probe._family   → family entry
 *   probe._size     → { class, rangeM, rcsM2, massKg, pointPx }
 *   probe._hazardMJ → kinetic-energy hazard score (megajoules)
 */
export function annotate(rec) {
    const family   = classifyDebris(rec);
    const size     = estimateSize(rec, family);
    const hazardMJ = hazardEnergyMJ(size.massKg);
    return { family, size, hazardMJ };
}
