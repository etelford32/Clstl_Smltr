/**
 * observatories.js — the station roster, and where every coordinate came from.
 * ═══════════════════════════════════════════════════════════════════════════
 * DATA + provenance. The rule this file exists to enforce:
 *
 *     NO STATION COORDINATE IS EVER TYPED FROM MEMORY.
 *
 * That rule is not pedantry. The worst bug in the research programme behind
 * this page was a CORRECT coordinate transform fed a WRONG column — a
 * reference-value error that presented as a model error and survived a while
 * because the code it accused was exact to 10⁻¹⁵. Everything here therefore
 * carries a `source` field, and anything provisional says so loudly.
 *
 * ── TWO ROSTERS, TWO PURPOSES ─────────────────────────────────────────────
 *
 * 1. `KYOTO_TABLE1` — the eleven-station SYM-H pool, transcribed from the
 *    PRIMARY source: WDC Kyoto, "On the ASY/SYM indices", Table 1. It carries
 *    BOTH the `gmLatDeg` (centred dipole — what SYM-H's cos-λ weighting uses)
 *    and `invariantLatDeg` (real-field L-shell mapping) columns, deliberately,
 *    side by side. They are DIFFERENT PHYSICAL QUANTITIES and they differ by
 *    up to 9.5°. Keeping both in view is how you notice you grabbed the wrong
 *    one. Recomputing gmLat from the geographic coordinates via
 *    dipole.js `toDipole` agrees to 0.83° max / −0.02° mean — pure secular
 *    drift since Kyoto's epoch. `tests/geomag-dipole.mjs` pins that.
 *
 * 2. `USGS_STATION_IDS` — IAGA codes ONLY. No coordinates. The live ingest
 *    path reads each station's geodetic latitude and longitude out of the same
 *    USGS response that carries its data, so the live path has no hand-typed
 *    coordinate in it at all. An IAGA code is an identifier, not a datum.
 *
 * USGS is the roster the live path uses because it is effectively public
 * domain. INTERMAGNET is CC BY-NC 4.0, which is fine for a free research index
 * and a licensing problem for anything else; SuperMAG prohibits
 * redistribution. See `TIGA_PLAN.md` §Licensing. A USGS-only fit is a HARDER
 * problem — worse longitude coverage — which makes the dropout result more
 * impressive, not less.
 */

/**
 * Geomagnetic latitude cut for a ring-current station.
 *
 * Equatorward of ~50° dipole latitude the horizontal field is dominated by the
 * ring current; poleward of it the auroral electrojets take over and the
 * station stops measuring the quantity we are estimating. Dst and SYM-H both
 * apply a cut of this kind. It is applied to a COMPUTED dipole latitude, never
 * to a stored one.
 */
export const RING_CURRENT_MAX_DIPOLE_LAT = 50;

/**
 * WDC Kyoto, "On the ASY/SYM indices", Table 1. Transcribed from the primary
 * PDF, not from any secondary list.
 *
 * `gmLonDeg` uses KYOTO's dipole-longitude origin, which is 180° from the
 * convention in dipole.js. That offset is a constant rotation: it changes the
 * UT PHASE of any local-time-organised quantity and changes no amplitude. It
 * is kept as Kyoto publishes it so numbers here are directly comparable to the
 * source — convert before mixing with `toDipole` output.
 */
export const KYOTO_TABLE1 = Object.freeze({
    SJG: { name: 'San Juan',           latDeg:  18.110, lonDeg: 293.850, gmLatDeg:  28.04, invariantLatDeg: 32.5, gmLonDeg:   6.54 },
    FRD: { name: 'Fredericksburg',     latDeg:  38.200, lonDeg: 282.630, gmLatDeg:  48.14, invariantLatDeg: 50.4, gmLonDeg: 353.93 },
    BOU: { name: 'Boulder',            latDeg:  40.130, lonDeg: 254.760, gmLatDeg:  48.24, invariantLatDeg: 49.1, gmLonDeg: 321.28 },
    TUC: { name: 'Tucson',             latDeg:  32.170, lonDeg: 249.270, gmLatDeg:  39.73, invariantLatDeg: 39.7, gmLonDeg: 316.74 },
    HON: { name: 'Honolulu',           latDeg:  21.320, lonDeg: 202.000, gmLatDeg:  21.71, invariantLatDeg: 20.2, gmLonDeg: 270.27 },
    MMB: { name: 'Memambetsu',         latDeg:  43.910, lonDeg: 144.189, gmLatDeg:  35.63, invariantLatDeg: 34.9, gmLonDeg: 211.74 },
    WMQ: { name: 'Urumqi',             latDeg:  43.800, lonDeg:  87.700, gmLatDeg:  34.34, invariantLatDeg: 36.5, gmLonDeg: 162.53 },
    ABG: { name: 'Alibag',             latDeg:  18.638, lonDeg:  72.872, gmLatDeg:  10.37, invariantLatDeg: null, gmLonDeg: 146.55 },
    AMS: { name: 'Martin de Viviès',   latDeg: -37.796, lonDeg:  77.574, gmLatDeg: -46.22, invariantLatDeg: 48.6, gmLonDeg: 144.93 },
    HER: { name: 'Hermanus',           latDeg: -34.425, lonDeg:  19.225, gmLatDeg: -34.08, invariantLatDeg: 43.6, gmLonDeg:  84.63 },
    CLF: { name: 'Chambon-la-Forêt',   latDeg:  48.025, lonDeg:   2.261, gmLatDeg:  49.75, invariantLatDeg: 45.7, gmLonDeg:  85.80 },
});

export const KYOTO_TABLE1_SOURCE =
    'WDC Kyoto — "On the ASY/SYM indices", Table 1 (asy.pdf), G.M. LAT. column';

/**
 * A typical monthly SYM-H six-station draw. Kyoto reselects six of the eleven
 * each month and does not publish which six — that reselection changes both
 * the amplitude AND the UT phase of the order-1 aliasing (see
 * `tiga.js aliasAmplitude`), which is a concrete mechanism for the ~8 nT
 * month-interface residual reported in the literature.
 *
 * This particular draw is ALL-NORTHERN, which is the worst case: the aliasing
 * numerator is mean(sin λ · e^{iφ}), so southern stations enter with opposite
 * sign and cancel northern ones. Hemispheric balance, not station count, is
 * the driver.
 */
export const SYMH6_TYPICAL = Object.freeze(['SJG', 'FRD', 'BOU', 'TUC', 'HON', 'MMB']);

/** A hemispherically balanced six — same size, roughly 40% less aliasing. */
export const SYMH6_BALANCED = Object.freeze(['SJG', 'HON', 'HER', 'AMS', 'ABG', 'MMB']);

/** The classical four-station Dst pool (CLF standing in for KAK, absent from Table 1). */
export const DST4 = Object.freeze(['HER', 'HON', 'SJG', 'CLF']);

/**
 * USGS Geomagnetism Program IAGA codes. Identifiers only — coordinates arrive
 * with the data. The high-latitude stations are listed because the roster is
 * the roster; `ingest.js` drops them on a COMPUTED dipole latitude rather than
 * on this annotation, so the cut stays honest if a pole moves.
 */
export const USGS_STATION_IDS = Object.freeze([
    'BOU', 'BRW', 'BSL', 'CMO', 'DED', 'FRD', 'FRN',
    'GUA', 'HON', 'NEW', 'SHU', 'SIT', 'SJG', 'TUC',
]);

/** Human-readable names, for labelling only. Never used in any computation. */
export const USGS_NAMES = Object.freeze({
    BOU: 'Boulder, CO',        BRW: 'Barrow, AK',      BSL: 'Stennis, MS',
    CMO: 'College, AK',        DED: 'Deadhorse, AK',   FRD: 'Fredericksburg, VA',
    FRN: 'Fresno, CA',         GUA: 'Guam',            HON: 'Honolulu, HI',
    NEW: 'Newport, WA',        SHU: 'Shumagin, AK',    SIT: 'Sitka, AK',
    SJG: 'San Juan, PR',       TUC: 'Tucson, AZ',
});

/**
 * Longitudinal spread of a station set, as the mean-resultant-length of the
 * dipole longitudes: 0 = perfectly spread, 1 = all at one longitude.
 *
 * This is the variable that actually matters, and finding that out was an
 * unplanned result: removing 23 clustered Europe/Africa stations IMPROVED the
 * order-1 estimate, while removing 9 well-placed American stations made it
 * much worse. Station COUNT is the wrong variable; longitudinal spread is the
 * right one, and it gives operators an actionable criterion.
 *
 * @param {number[]} lonDeg dipole (or SM) longitudes in degrees
 */
export function longitudeClustering(lonDeg) {
    if (!lonDeg.length) return 1;
    let cx = 0, cy = 0;
    for (const L of lonDeg) { cx += Math.cos(L * Math.PI / 180); cy += Math.sin(L * Math.PI / 180); }
    return Math.hypot(cx, cy) / lonDeg.length;
}
