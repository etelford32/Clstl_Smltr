/**
 * OMM normalization shared by the CelesTrak edge proxy and node tests.
 *
 * CelesTrak's OMM JSON uses CCSDS field names. The browser historically
 * consumed a compact TLE-derived shape, so this module keeps that internal
 * contract while retaining the OMM metadata needed for coverage reporting.
 */

const RE_KM = 6378.135;
const MU_KM3_S2 = 398600.8;
const SEC_PER_DAY = 86400;

function finite(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function daysInYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 366 : 365;
}

function parseCcsdsEpoch(epoch) {
    const text = String(epoch ?? '').trim();
    if (!text) return NaN;

    // CCSDS permits ordinal dates (YYYY-DDD) as well as calendar dates.
    // CelesTrak commonly omits an explicit zone; OMM TIME_SYSTEM is UTC, so
    // never let Date.parse reinterpret a zone-less epoch in the edge region's
    // or browser's local timezone.
    const ordinal = text.match(/^(\d{4})-(\d{3})T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(?:Z)?$/i);
    if (ordinal) {
        const [, year, day, hour, minute, second] = ordinal;
        const seconds = Number(second);
        return Date.UTC(Number(year), 0, Number(day), Number(hour), Number(minute),
            Math.floor(seconds), Math.round((seconds % 1) * 1000));
    }
    const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
    return Date.parse(zoned);
}

function epochParts(epoch) {
    const epochMs = parseCcsdsEpoch(epoch);
    if (!Number.isFinite(epochMs)) return null;
    const date = new Date(epochMs);
    const year = date.getUTCFullYear();
    const jan1Ms = Date.UTC(year, 0, 1);
    const dayOfYear = (epochMs - jan1Ms) / 86400000 + 1;
    return {
        epochMs,
        epochIso: date.toISOString(),
        epochJd: epochMs / 86400000 + 2440587.5,
        epochYr: year + dayOfYear / daysInYear(year),
    };
}

function orbitShape(meanMotionRevDay, eccentricity) {
    const nRadS = meanMotionRevDay * 2 * Math.PI / SEC_PER_DAY;
    const smaKm = Math.cbrt(MU_KM3_S2 / (nRadS * nRadS));
    return {
        periodMin: 1440 / meanMotionRevDay,
        smaKm,
        apogeeKm: smaKm * (1 + eccentricity) - RE_KM,
        perigeeKm: smaKm * (1 - eccentricity) - RE_KM,
    };
}

/** Convert one CCSDS OMM JSON record to the site's normalized orbit shape. */
export function normalizeOmmRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const noradId = finite(raw.NORAD_CAT_ID);
    const epoch = epochParts(raw.EPOCH);
    const meanMotion = finite(raw.MEAN_MOTION);
    const eccentricity = finite(raw.ECCENTRICITY);
    const inclination = finite(raw.INCLINATION);
    const raan = finite(raw.RA_OF_ASC_NODE);
    const argPerigee = finite(raw.ARG_OF_PERICENTER);
    const meanAnomaly = finite(raw.MEAN_ANOMALY);

    if (!Number.isInteger(noradId) || noradId <= 0 || !epoch || !(meanMotion > 0) ||
        !(eccentricity >= 0 && eccentricity < 1) || inclination == null || raan == null ||
        argPerigee == null || meanAnomaly == null) return null;

    const orbit = orbitShape(meanMotion, eccentricity);
    return {
        name: String(raw.OBJECT_NAME || `NORAD ${noradId}`).trim(),
        norad_id: noradId,
        object_id: raw.OBJECT_ID ? String(raw.OBJECT_ID).trim() : null,
        classification_type: raw.CLASSIFICATION_TYPE ? String(raw.CLASSIFICATION_TYPE) : null,
        ephemeris_type: finite(raw.EPHEMERIS_TYPE),
        element_set_no: finite(raw.ELEMENT_SET_NO),
        rev_at_epoch: finite(raw.REV_AT_EPOCH),
        epoch: epoch.epochIso,
        epoch_ms: epoch.epochMs,
        epoch_jd: epoch.epochJd,
        epoch_yr: epoch.epochYr,
        inclination,
        raan,
        eccentricity,
        arg_perigee: argPerigee,
        mean_anomaly: meanAnomaly,
        mean_motion: meanMotion,
        mean_motion_dot: finite(raw.MEAN_MOTION_DOT),
        mean_motion_ddot: finite(raw.MEAN_MOTION_DDOT),
        bstar: finite(raw.BSTAR),
        period_min: Math.round(orbit.periodMin * 100) / 100,
        apogee_km: Math.round(orbit.apogeeKm),
        perigee_km: Math.round(orbit.perigeeKm),
        sma_km: Math.round(orbit.smaKm),
        source_format: 'omm-json',
        mean_element_theory: raw.MEAN_ELEMENT_THEORY || 'SGP4',
        ref_frame: raw.REF_FRAME || 'TEME',
        time_system: raw.TIME_SYSTEM || 'UTC',
        line1: null,
        line2: null,
    };
}

/** Normalize an OMM response and retain rejection counts for health telemetry. */
export function normalizeOmmPayload(payload) {
    if (!Array.isArray(payload)) return { records: [], received: 0, rejected: 0 };
    const records = [];
    let rejected = 0;
    for (const raw of payload) {
        const record = normalizeOmmRecord(raw);
        if (record) records.push(record);
        else rejected++;
    }
    return { records, received: payload.length, rejected };
}

export function summarizeOrbitRecords(records, nowMs = Date.now()) {
    const ages = [];
    let sixPlusDigitCount = 0;
    let maxCatalogId = null;
    for (const record of records ?? []) {
        if (record.norad_id >= 100000) sixPlusDigitCount++;
        if (maxCatalogId == null || record.norad_id > maxCatalogId) maxCatalogId = record.norad_id;
        const epochMs = Number.isFinite(record.epoch_ms) ? record.epoch_ms : Date.parse(record.epoch);
        if (Number.isFinite(epochMs)) ages.push(Math.max(0, (nowMs - epochMs) / 86400000));
    }
    ages.sort((a, b) => a - b);
    const medianAgeDays = ages.length
        ? ages.length % 2
            ? ages[(ages.length - 1) / 2]
            : (ages[ages.length / 2 - 1] + ages[ages.length / 2]) / 2
        : null;
    return {
        count: records?.length ?? 0,
        maxCatalogId,
        sixPlusDigitCount,
        freshUnder24h: ages.filter(age => age < 1).length,
        aging1To3d: ages.filter(age => age >= 1 && age <= 3).length,
        staleOver3d: ages.filter(age => age > 3).length,
        medianAgeDays,
        oldestAgeDays: ages.at(-1) ?? null,
    };
}
