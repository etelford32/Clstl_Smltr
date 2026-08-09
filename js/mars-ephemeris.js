/**
 * mars-ephemeris.js — PURE parsing + summarizing for the live Mars geometry feed.
 *
 * No DOM, no fetch, no ambient time. `api/mars/ephemeris.js` does the network
 * call; this module owns the query shape, the table parsing, and the derived
 * quantities, so both the edge route and `node tests/mars-ephemeris.mjs` see
 * exactly the same code path.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The page previously derived Mars' season from a linear mean-motion model
 * (`marsSolarLongitudeFromJulianDate` in mars-mission-state.js): Ls advanced at
 * a constant rate through a 686.971-day year. Mars' orbit has e ≈ 0.0934, so the
 * true areocentric Ls runs up to ~11° away from that mean near the solstices —
 * enough to put the terminator and the "dust season" call in the wrong place.
 * This module reads Ls, the sub-solar point, and Earth-Mars geometry straight
 * from JPL Horizons instead.
 *
 * The analytic model is NOT deleted: it remains the offline fallback, and the
 * route labels which one produced a given payload. Never silently swap them —
 * the client prints the source.
 *
 * ── Horizons observer quantities requested ───────────────────────────────
 *   13  target angular diameter          21  one-way down-leg light-time
 *   14  observer sub-lon & sub-lat       23  Sun-Observer-Target elongation
 *   15  Sun sub-lon & sub-lat            24  Sun-Target-Observer phase angle
 *   20  observer range & range-rate      44  apparent longitude of Sun (L_s)
 *
 * ── Two conventions that WILL bite you ───────────────────────────────────
 *   1. Horizons sub-longitudes are positive WEST for prograde rotators (Mars
 *      is one). Everything in this repo is east-positive. `parseMarsEphemeris`
 *      converts on the way out and records that it did.
 *   2. Horizons sub-latitudes are planetoDETIC. MMGIS rover coordinates and the
 *      globe's latLonVector() are planetoCENTRIC. Up to ~0.32° apart on Mars —
 *      small, but it is a real offset on a terminator drawn at 4 px/degree, so
 *      it is converted, not ignored.
 *
 *   `marsGeodeticToPlanetocentric` here is the exact inverse of
 *   `marsPlanetocentricToGeodetic` in js/horizons.js. It is duplicated rather
 *   than imported ONLY because importing horizons.js would drag the VSOP87
 *   tables into the edge bundle. tests/mars-ephemeris.mjs imports BOTH and
 *   asserts they round-trip to 1e-12 — that gate is what keeps them honest.
 */

const MARS_EQUATORIAL_RADIUS_KM = 3396.19;
const MARS_POLAR_RADIUS_KM = 3376.2;
const AU_KM = 149_597_870.7;
const AU_LIGHT_SECONDS = 499.004783836;

/** Planetodetic → planetocentric latitude on the IAU_MARS reference ellipsoid. */
export function marsGeodeticToPlanetocentric(latDeg) {
    if (!Number.isFinite(latDeg) || Math.abs(latDeg) > 90) {
        throw new RangeError('Mars latitude must be finite and within ±90°');
    }
    if (Math.abs(latDeg) === 90) return latDeg;
    const radians = Math.PI / 180;
    return Math.atan(
        Math.tan(latDeg * radians)
        * MARS_POLAR_RADIUS_KM ** 2 / MARS_EQUATORIAL_RADIUS_KM ** 2,
    ) / radians;
}

/**
 * Wrap any longitude into (−180, 180].
 *
 * Written as a conditional rather than the usual `((x % 360) + 540) % 360 - 180`
 * so a value already in range comes back bit-identical. The modulo form drifts
 * by ~5e-14 on ordinary inputs, which is invisible in a readout but shows up as
 * churn when a coordinate is round-tripped through this on every frame.
 */
export function wrapLongitude(lonDeg) {
    if (!Number.isFinite(lonDeg)) return lonDeg;
    let wrapped = lonDeg % 360;
    if (wrapped > 180) wrapped -= 360;
    else if (wrapped <= -180) wrapped += 360;
    return wrapped;
}

/**
 * Query parameters for the single Horizons observer call this feed makes.
 * Mars (499) seen from the Earth geocenter (500@399) at one instant.
 */
export function marsEphemerisParams(julianDate) {
    if (!Number.isFinite(julianDate)) throw new TypeError('marsEphemerisParams needs a finite Julian date');
    return new URLSearchParams({
        format: 'json',
        COMMAND: "'499'",
        OBJ_DATA: "'NO'",
        MAKE_EPHEM: "'YES'",
        EPHEM_TYPE: "'OBSERVER'",
        CENTER: "'500@399'",
        TLIST: `'${julianDate.toFixed(8)}'`,
        QUANTITIES: "'13,14,15,20,21,23,24,44'",
        CSV_FORMAT: "'YES'",
        ANG_FORMAT: "'DEG'",
        EXTRA_PREC: "'YES'",
    });
}

/**
 * Locate the CSV column header Horizons prints just above `$$SOE`.
 * Returns an array of trimmed column names; the two unnamed flag columns that
 * follow the date come back as empty strings, which keeps index alignment with
 * the data rows.
 */
export function parseHorizonsCsvHeader(text) {
    const start = text.indexOf('$$SOE');
    if (start < 0) throw new Error('Horizons: missing $$SOE marker');
    const preamble = text.slice(0, start).split('\n');
    for (let index = preamble.length - 1; index >= 0; index -= 1) {
        const line = preamble[index].trim();
        if (/^Date_/.test(line) && line.includes(',')) {
            const names = line.split(',').map(name => name.trim());
            while (names.at(-1) === '') names.pop();
            return names;
        }
    }
    throw new Error('Horizons: no CSV column header found above $$SOE');
}

/** First data row of a Horizons CSV observer table, keyed by column name. */
export function parseHorizonsCsvRow(text) {
    const names = parseHorizonsCsvHeader(text);
    const start = text.indexOf('$$SOE');
    const stop = text.indexOf('$$EOE');
    if (stop < 0 || stop <= start) throw new Error('Horizons: missing $$EOE marker');
    const rows = text.slice(start + 5, stop).split('\n').map(line => line.trim()).filter(Boolean);
    if (!rows.length) throw new Error('Horizons: observer table is empty');
    const fields = rows[0].split(',').map(field => field.trim());
    const record = {};
    names.forEach((name, index) => {
        if (name) record[name] = fields[index] ?? '';
    });
    record.__date = fields[0] ?? '';
    return record;
}

function numberOrNull(value) {
    if (value == null || value === '' || value === 'n.a.') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/** Mars season label for an areocentric solar longitude, northern-hemisphere framed. */
export function marsSeasonLabel(lsDeg) {
    if (!Number.isFinite(lsDeg)) return null;
    const ls = ((lsDeg % 360) + 360) % 360;
    if (ls < 90) return 'northern spring · southern autumn';
    if (ls < 180) return 'northern summer · southern winter';
    if (ls < 270) return 'northern autumn · southern spring';
    return 'northern winter · southern summer';
}

/**
 * Dust-season context. Mars' perihelion sits near Ls 251°, and the historical
 * global dust-storm season runs roughly Ls 180°–360° with the regional peak
 * around Ls 210°–300°. This is CLIMATOLOGY, not an opacity measurement — the
 * label says so, and no τ number is invented here.
 */
export function marsDustSeason(lsDeg) {
    if (!Number.isFinite(lsDeg)) return null;
    const ls = ((lsDeg % 360) + 360) % 360;
    if (ls >= 210 && ls < 300) return { phase: 'peak', note: 'climatological dust-storm season peak' };
    if (ls >= 180 && ls < 210) return { phase: 'onset', note: 'climatological dust-storm season onset' };
    if (ls >= 300) return { phase: 'declining', note: 'climatological dust-storm season declining' };
    return { phase: 'clear', note: 'climatologically clear season' };
}

/** Seconds → "13 m 09 s", the number people recognise as "how far away Mars is". */
export function formatLightTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    const whole = Math.round(seconds);
    return `${Math.floor(whole / 60)} m ${String(whole % 60).padStart(2, '0')} s`;
}

/**
 * Sun-Earth-Mars angle classification. Below ~2° NASA suspends commanding of
 * Mars assets (solar conjunction moratorium); the surrounding weeks degrade
 * the link. Reported so the page can say WHY a feed has gone quiet instead of
 * showing a silent stale value.
 */
export function solarConjunctionState(elongationDeg) {
    if (!Number.isFinite(elongationDeg)) return null;
    if (elongationDeg < 2) return { state: 'conjunction', note: 'Sun–Earth–Mars angle under 2° · NASA commanding moratorium' };
    if (elongationDeg < 10) return { state: 'near-conjunction', note: 'Sun–Earth–Mars angle under 10° · degraded deep-space link' };
    return { state: 'clear', note: 'clear Earth–Mars line of sight' };
}

/**
 * Parse one Horizons CSV observer row into the feed's normalized geometry.
 *
 * Every field degrades to `null` independently: a Horizons column rename costs
 * one number, never the whole payload. `fields_present` reports what survived
 * so the client can label partial data rather than print a confident blank.
 */
export function parseMarsEphemeris(text) {
    const row = parseHorizonsCsvRow(text);
    const rangeAu = numberOrNull(row.delta);
    const lightTimeMinutes = numberOrNull(row['1-way_down_LT']);
    const lightTimeSeconds = lightTimeMinutes == null
        ? (rangeAu == null ? null : rangeAu * AU_LIGHT_SECONDS)
        : lightTimeMinutes * 60;
    const subSolarLatGeodetic = numberOrNull(row['SunSub-LAT']);
    const subSolarLonWest = numberOrNull(row['SunSub-LON']);
    const subEarthLatGeodetic = numberOrNull(row['ObsSub-LAT']);
    const subEarthLonWest = numberOrNull(row['ObsSub-LON']);
    const lsDeg = numberOrNull(row.L_s);
    const elongationDeg = numberOrNull(row['S-O-T']);

    const present = [];
    const track = (name, value) => { if (value != null) present.push(name); return value; };

    return {
        horizons_utc: row.__date || null,
        ls_deg: track('ls_deg', lsDeg),
        season: marsSeasonLabel(lsDeg),
        dust_season: marsDustSeason(lsDeg),
        sub_solar: {
            // Horizons: planetodetic, west-positive. Repo: planetocentric,
            // east-positive. Both conversions happen here, once.
            lat_deg: track('sub_solar_lat', subSolarLatGeodetic == null ? null : marsGeodeticToPlanetocentric(subSolarLatGeodetic)),
            lon_deg: track('sub_solar_lon', subSolarLonWest == null ? null : wrapLongitude(-subSolarLonWest)),
            frame: 'planetocentric · east-positive',
        },
        sub_earth: {
            lat_deg: track('sub_earth_lat', subEarthLatGeodetic == null ? null : marsGeodeticToPlanetocentric(subEarthLatGeodetic)),
            lon_deg: track('sub_earth_lon', subEarthLonWest == null ? null : wrapLongitude(-subEarthLonWest)),
            frame: 'planetocentric · east-positive',
        },
        earth_range_au: track('earth_range_au', rangeAu),
        earth_range_km: rangeAu == null ? null : rangeAu * AU_KM,
        range_rate_km_s: numberOrNull(row.deldot),
        light_time_s: track('light_time_s', lightTimeSeconds),
        light_time_text: formatLightTime(lightTimeSeconds),
        solar_elongation_deg: track('solar_elongation_deg', elongationDeg),
        solar_conjunction: solarConjunctionState(elongationDeg),
        phase_angle_deg: numberOrNull(row['S-T-O']),
        angular_diameter_arcsec: numberOrNull(row['Ang-diam']),
        fields_present: present,
    };
}

export default parseMarsEphemeris;
