import { setHeroLookup } from './debris-catalog.js';

/**
 * hero-objects.js — DISCOSweb-derived dimensions table for the small
 * set of objects where we have authoritative numbers and the
 * SATCAT-bucket median would be misleading.
 *
 * SATCAT gives us three RCS buckets (small / medium / large) plus —
 * for a subset of objects — the raw radar cross-section in m².
 * That's adequate for most of the catalog, but for hero assets
 * (Envisat, ISS, Hubble, well-characterised rocket-body classes)
 * we have public-source dimensions that beat any bucket:
 *
 *   - height × width × depth (m)
 *   - tip-to-tip span (m) — solar wings or arrays
 *   - mass (kg)
 *   - measured RCS (m²) when public
 *
 * Override order in debris-catalog.estimateSize:
 *
 *   hero-objects (this file)   ← if listed, wins absolutely
 *   SATCAT                     ← bucket from measured RCS
 *   heuristic                  ← name + family fallback
 *
 * Two lookup paths:
 *
 *   BY_NORAD       — one entry per object (Envisat, ISS, Hubble, …)
 *   BY_NAME_REGEX  — class-wide entries that apply to every
 *                    NORAD whose name matches (e.g. every SL-16 R/B)
 *
 * Sources are mixed: DISCOSweb (where accessible), Wikipedia tables
 * verified against operator/agency datasheets, NASA Space Science
 * Data Coordinated Archive (NSSDCA) catalogs. Values are nominal
 * design dimensions of the *fully-deployed* spacecraft — wings out,
 * antennas extended. Where dimensions vary between blocks/serials
 * we pick the most common variant and call it out in `notes`.
 *
 * If you need to update an entry: prefer the operator's official
 * datasheet over Wikipedia, and prefer DISCOSweb's `cross_section_m2`
 * over a derived face area.
 */

/**
 * Build a per-class entry. Three required, three optional fields:
 *   - kind         payload | rocket-body | station — drives the
 *                  family attribution if SATCAT/heuristic miss.
 *   - dims_m       { h, w, d } in metres. h = nadir-zenith span;
 *                  w = cross-track; d = along-track. Best-effort
 *                  for objects whose principal axes aren't cleanly
 *                  body-fixed.
 *   - mass_kg      design mass, ~5 % uncertainty for active sats
 *                  and ~10 % for old/derived numbers.
 *   - span_m       (optional) full tip-to-tip span including solar
 *                  wings — usually the biggest dimension the
 *                  operator publishes.
 *   - rcs_m2       (optional) public RCS measurement or operator
 *                  estimate. Bucket follows automatically.
 *   - notes        operator-facing comment surfaced in tooltips.
 */
function entry(opts) {
    const { kind, dims_m, mass_kg, span_m = null, rcs_m2 = null, notes = '' } = opts;
    return Object.freeze({ kind, dims_m: Object.freeze(dims_m), mass_kg, span_m, rcs_m2, notes });
}

// ── Per-NORAD entries ────────────────────────────────────────────
// One-of-a-kind hero assets. Numbers from NSSDCA / agency datasheets.
export const BY_NORAD = Object.freeze({
    // Envisat — ESA Polar Platform. NSSDCA 2002-009A.
    27386: entry({
        kind:    'payload',
        dims_m:  { h: 5.0,  w: 10.0, d: 26.0 },  // d is the long axis (bus + ASAR + wing)
        mass_kg: 8211,
        span_m:  26.0,
        rcs_m2:  130,
        notes:   'Defunct since April 2012; tumbling at ~2.7°/s. Largest single intact debris in LEO.',
    }),

    // Hubble Space Telescope — NSSDCA 1990-037B.
    20580: entry({
        kind:    'payload',
        dims_m:  { h: 4.2, w: 4.2, d: 13.2 },
        mass_kg: 11110,
        span_m:  13.2,
        rcs_m2:  null,
        notes:   'NASA Great Observatory. Servicing-completed 2009; passive de-orbit pending.',
    }),

    // International Space Station — NSSDCA 1998-067A.
    25544: entry({
        kind:    'station',
        dims_m:  { h: 27.4, w: 73.0, d: 109.0 },  // full truss × pressurized × array span
        mass_kg: 419725,
        span_m:  109.0,
        rcs_m2:  401,
        notes:   'Pressurized volume 916 m³. Plan-of-record de-orbit ~2031.',
    }),

    // Tiangong space station core complex — NSSDCA 2021-035A (Tianhe).
    48274: entry({
        kind:    'station',
        dims_m:  { h: 17.0, w: 39.0, d: 55.0 },   // T-config with two lab modules
        mass_kg: 100000,
        span_m:  55.0,
        rcs_m2:  null,
        notes:   'CMSA Tianhe core + Wentian + Mengtian. Three-module T-configuration since Nov 2022.',
    }),

    // James Webb Space Telescope — NSSDCA 2021-130A. Not LEO (L2) but
    // tracked. Included so a curious operator sees real numbers.
    50463: entry({
        kind:    'payload',
        dims_m:  { h: 14.6, w: 21.2, d: 8.0 },    // sunshield × primary mirror × bus
        mass_kg: 6500,
        span_m:  21.2,
        rcs_m2:  null,
        notes:   'NASA/ESA/CSA observatory at Sun-Earth L2. Outside the catalog\'s default propagation range.',
    }),
});

// ── Per-name-pattern entries ─────────────────────────────────────
// Class-wide dimensions that apply to every NORAD whose name matches.
// Useful for upper-stage families where every R/B has the same body
// (SL-16, SL-8, Centaur, etc.) and we'd otherwise need to list ~290
// individual NORADs.
//
// Matched in declaration order; first hit wins. Patterns are
// case-sensitive against the upper-cased name (we upper-case
// the input before testing) — TLE names are already upper-case but
// being explicit avoids surprises if a downstream module mixes
// cases.
export const BY_NAME_REGEX = Object.freeze([
    {
        // SL-16 / Zenit-2 second stage — RD-120 main engine. Includes
        // the small subset of SL-16 PAYLOAD records (USA series); the
        // dimensions still describe the stage body since payloads
        // were mostly small radar / SIGINT comparable in cross-section.
        pattern: /^SL-16\b/,
        info:    entry({
            kind:    'rocket-body',
            dims_m:  { h: 3.9, w: 3.9, d: 10.4 },
            mass_kg: 9000,        // dry mass of the spent stage
            span_m:  10.4,
            rcs_m2:  null,        // varies stage-to-stage; SATCAT carries it
            notes:   'Zenit-2 second stage. ~18 intact units in LEO between 800–900 km.',
        }),
    },
    {
        // SL-8 / Cosmos-3M second stage. RD-216 with four vernier
        // nozzles. ~290 catalogued, dominates the "objects per shell"
        // count between 700–1000 km.
        pattern: /^SL-8\b/,
        info:    entry({
            kind:    'rocket-body',
            dims_m:  { h: 2.4, w: 2.4, d: 6.0 },
            mass_kg: 1435,
            span_m:  6.0,
            rcs_m2:  null,
            notes:   'Cosmos-3M second stage. Many tumble; broad altitude distribution.',
        }),
    },
    {
        // Centaur upper stage — RL10, hydrolox. Used on Atlas V and
        // Vulcan. Single tank, 3 m diameter, 12.7 m long (variant
        // dependent).
        pattern: /\bCENTAUR\b/,
        info:    entry({
            kind:    'rocket-body',
            dims_m:  { h: 3.05, w: 3.05, d: 12.7 },
            mass_kg: 2247,        // dry mass
            span_m:  12.7,
            rcs_m2:  null,
            notes:   'ULA Centaur upper stage. Some retain residual H₂/O₂ — fragmentation risk.',
        }),
    },
    {
        // Delta II second stage — AJ10-118K. 2.4 m diameter, 6 m long.
        pattern: /^DELTA 2\b/,
        info:    entry({
            kind:    'rocket-body',
            dims_m:  { h: 2.44, w: 2.44, d: 6.0 },
            mass_kg: 940,
            span_m:  6.0,
            rcs_m2:  null,
            notes:   'McDonnell Douglas Delta II second stage. Retired 2018; ~50 stages still on orbit.',
        }),
    },
    {
        // Ariane upper stages — EPS / ESC-A. Spec varies by variant;
        // numbers below are Ariane 5 ESC-A (most numerous).
        pattern: /^ARIANE 5\b/,
        info:    entry({
            kind:    'rocket-body',
            dims_m:  { h: 5.4, w: 5.4, d: 4.9 },
            mass_kg: 4540,
            span_m:  5.4,
            rcs_m2:  null,
            notes:   'Arianespace ESC-A cryogenic upper stage.',
        }),
    },
    {
        // Long March CZ-3B/E third stage — most common modern Chinese
        // upper stage. 3 m diameter, 12.4 m long.
        pattern: /^CZ-3B?\b/,
        info:    entry({
            kind:    'rocket-body',
            dims_m:  { h: 3.0, w: 3.0, d: 12.4 },
            mass_kg: 2740,
            span_m:  12.4,
            rcs_m2:  null,
            notes:   'CALT Long March 3B/E third stage. Several have fragmented in GTO.',
        }),
    },
]);

// ── Lookup ────────────────────────────────────────────────────────

/**
 * Look up dimensions for `rec`. Returns the entry shape augmented
 * with `{ source: 'hero', match, heroClass }`, or null if no match.
 *
 * `heroClass` is the Liou & Johnson bucket (small/medium/large)
 * derived from rcs_m2 if known, else estimated from the bounding-box
 * face area — exposed so debris-catalog.estimateSize can skip the
 * default-large fallback when the hero entry has a real RCS.
 */
export function lookupHero(rec) {
    if (!rec) return null;
    const id = Number(rec.noradId ?? rec.norad_id);

    if (Number.isFinite(id) && BY_NORAD[id]) {
        const info = BY_NORAD[id];
        return {
            ...info,
            source:    'hero',
            match:     'norad',
            heroClass: heroRcsClass(info),
        };
    }

    const nameUpper = String(rec.name ?? '').toUpperCase();
    if (!nameUpper) return null;
    for (const { pattern, info } of BY_NAME_REGEX) {
        if (pattern.test(nameUpper)) {
            return {
                ...info,
                source:    'hero',
                match:     'name',
                heroClass: heroRcsClass(info),
            };
        }
    }
    return null;
}

/**
 * Derive an RCS class bucket (small/medium/large) from a hero
 * entry. If a measured rcs_m2 is present we use it; otherwise we
 * estimate from face area (max two-dim projection of the bounding
 * box) — the operational "largest plausible silhouette". That
 * over-estimates for spindly objects (Hubble, Centaur) but the
 * bucket is coarse enough that it lands in the right bin.
 */
export function heroRcsClass(info) {
    if (!info) return null;
    let rcs = info.rcs_m2 ?? null;
    if (rcs == null && info.dims_m) {
        const { h, w, d } = info.dims_m;
        const faceArea = Math.max(h * w, w * d, h * d);
        // RCS for a flat conducting plate is roughly the geometric
        // face area for objects much larger than the wavelength.
        // SSN tracks at ~70 cm — every hero asset is well above the
        // optical/geometric regime.
        rcs = faceArea;
    }
    if (!Number.isFinite(rcs) || rcs <= 0) return null;
    if (rcs < 0.1) return 'small';
    if (rcs < 1.0) return 'medium';
    return 'large';
}

// Self-register with debris-catalog so estimateSize() picks up the
// hero override at the top of its priority chain. Just importing
// this module from anywhere (operations.html boot, the upper-
// atmosphere globe) wires the dimensions in.
setHeroLookup(lookupHero);

