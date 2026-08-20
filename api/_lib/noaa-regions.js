/**
 * api/_lib/noaa-regions.js — normalize NOAA SWPC solar_regions rows.
 *
 * PURE. No fetch, no edge APIs, no ambient time — so /api/noaa/regions and
 * tests/noaa-regions.mjs run the same code.
 *
 * ── Why this is candidate-based rather than a fixed mapping ────────────
 *
 * SWPC's solar_regions.json carries each numbered region's operational C/M/X
 * flare probabilities — the numbers on the Solar Region Summary — and those
 * are what js/farside/flare-climatology.js rank-matches a far-side detection
 * against. The route used to drop them.
 *
 * services.swpc.noaa.gov is unreachable from this repo's build environment
 * (blocked by the network egress proxy), so the exact key spellings could not
 * be confirmed against the live feed. Guessing one name and shipping it would
 * fail SILENTLY: every probability would be null, the corridor's chip would
 * read "flare base rate · down", and it would look exactly like an upstream
 * outage rather than a typo on our side.
 *
 * So each output field resolves from a LIST of plausible upstream keys, and
 * the result reports which key actually matched (`field_map`) plus the
 * upstream keys nothing claimed (`unmapped_keys`). One request against
 * production then settles the schema for good:
 *
 *     curl -s https://parkersphysics.com/api/noaa/regions | jq '.data.field_map, .data.unmapped_keys'
 *
 * If a probability entry in field_map is null while unmapped_keys shows the
 * real name, add it to the head of the candidate list below and delete the
 * ones that never hit. Until then this degrades honestly: absent means null,
 * and null renders as "unavailable", never as a 0 % chance of flaring.
 *
 * ── Values are relayed AS PUBLISHED ───────────────────────────────────
 *
 * SWPC publishes whole percents. This module does not convert to fractions:
 * the percent-vs-fraction decision has to be made over the whole feed at once
 * (a lone `1` is both a legal 1 % and a legal fraction meaning certainty), and
 * that decision already lives — tested — in flare-climatology's
 * detectProbabilityScale. Two places deciding it is how they come to disagree.
 */

/**
 * Candidate upstream keys per output field, most-expected first.
 * `region` and `area` are the two the rank match cannot work without.
 */
export const FIELD_CANDIDATES = Object.freeze({
    region: ['region', 'Region', 'region_number'],
    observed_date: ['observed_date', 'observedDate', 'time_tag'],
    location: ['location', 'Location'],
    latitude_deg: ['latitude', 'Latitude', 'latitude_deg'],
    carrington_lon_deg: ['carrington_longitude', 'carringtonLongitude', 'carrington_lon'],
    stonyhurst_lon_deg: ['longitude', 'Longitude', 'longitude_deg'],
    area: ['area', 'Area', 'area_msh'],
    // SWPC's own naming for the McIntosh class has appeared as both
    // `spot_class` and `z_class` across products; try both rather than
    // silently reporting null for whichever this feed uses.
    spot_class: ['spot_class', 'z_class', 'Z', 'spotClass', 'mcintosh_class'],
    mag_class: ['mag_class', 'Mag', 'magClass', 'magnetic_class'],
    num_spots: ['number_spots', 'num_spots', 'numberSpots', 'Spots', 'spot_count'],
    extent_deg: ['extent', 'Extent', 'extent_deg'],
    c_flare_probability: ['c_flare_probability', 'cFlareProbability', 'c_flare_prob', 'c_prob'],
    m_flare_probability: ['m_flare_probability', 'mFlareProbability', 'm_flare_prob', 'm_prob'],
    x_flare_probability: ['x_flare_probability', 'xFlareProbability', 'x_flare_prob', 'x_prob'],
    proton_probability: ['proton_probability', 'protonProbability', 'proton_prob'],
});

/** Fields the flare base rate cannot function without. */
export const PROBABILITY_FIELDS = Object.freeze([
    'c_flare_probability', 'm_flare_probability', 'x_flare_probability',
]);

const NUMERIC_FIELDS = new Set([
    'region', 'latitude_deg', 'carrington_lon_deg', 'stonyhurst_lon_deg', 'area',
    'num_spots', 'extent_deg', ...PROBABILITY_FIELDS, 'proton_probability',
]);

/** First candidate key actually present (not null/undefined/'') on a row. */
function resolveKey(row, candidates) {
    for (const key of candidates) {
        const v = row?.[key];
        if (v !== undefined && v !== null && v !== '') return key;
    }
    return null;
}

/** Coerce to a finite number, or null. Handles SWPC's numeric-strings. */
function toNumber(v) {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return Number.isFinite(n) ? n : null;
}

/**
 * Normalize the upstream array.
 *
 * @param {any} raw the parsed solar_regions.json payload
 * @returns {{
 *   regions: object[], field_map: Record<string,string|null>,
 *   unmapped_keys: string[], probability_coverage: number, region_count: number
 * }}
 * @throws {TypeError} when `raw` is not an array — the caller turns that into
 *   a parse_error rather than serving an empty list that looks like a quiet Sun.
 */
export function normalizeSolarRegions(raw) {
    if (!Array.isArray(raw)) throw new TypeError('solar_regions payload is not an array');

    const rows = raw.filter((r) => r && (r.region ?? r.Region ?? r.region_number) != null);

    // Resolve each output field ONCE, against the first row that offers a
    // candidate. Per-row resolution would let a feed with ragged rows report a
    // different schema per region, which is exactly the confusion this is
    // meant to remove.
    const fieldMap = {};
    for (const [out, candidates] of Object.entries(FIELD_CANDIDATES)) {
        fieldMap[out] = null;
        for (const row of rows) {
            const key = resolveKey(row, candidates);
            if (key) { fieldMap[out] = key; break; }
        }
    }

    const claimed = new Set(Object.values(fieldMap).filter(Boolean));
    const unmapped = new Set();
    for (const row of rows) {
        for (const key of Object.keys(row)) if (!claimed.has(key)) unmapped.add(key);
    }

    const regions = rows.map((row) => {
        const out = {};
        for (const [name, key] of Object.entries(fieldMap)) {
            const v = key ? row[key] : undefined;
            out[name] = v === undefined || v === null || v === ''
                ? null
                : (NUMERIC_FIELDS.has(name) ? toNumber(v) : v);
        }
        // Back-compat alias: the pre-existing shape called this z_class and
        // rust/www/index.html still reads it.
        out.z_class = out.spot_class;
        return out;
    });

    // What fraction of regions carry BOTH an area and an M-class probability —
    // the pair the rank match needs. This is the number to watch: it is 0 both
    // when SWPC stops publishing probabilities and when our candidate list is
    // wrong, and the field_map above distinguishes the two.
    const usable = regions.filter((r) =>
        r.area !== null && r.m_flare_probability !== null).length;

    return {
        regions,
        field_map: fieldMap,
        // Capped: this is a diagnostic, not a data channel.
        unmapped_keys: [...unmapped].sort().slice(0, 40),
        probability_coverage: regions.length ? usable / regions.length : 0,
        region_count: regions.length,
    };
}
