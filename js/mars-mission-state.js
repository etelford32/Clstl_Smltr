/**
 * Canonical Mars 2020 mission state shared by the edge adapter and clients.
 *
 * This module deliberately separates three clocks:
 *   - operational status: newest human-reviewed NASA mission source;
 *   - drive progress: newest public NASA location-map snapshot;
 *   - plotted coordinate: newest reproducible released PDS position product.
 *
 * Keeping them separate prevents a visually "live" globe from representing
 * an archived PDS coordinate as real-time rover telemetry.
 */

export const MARS_RADIUS_M = 3_396_190;
export const MARS_SOL_MS = 88_775_244;
export const MARS_OBLIQUITY_DEG = 25.19;

const MARS_YEAR_DAYS = 686.971;
const MARS_LS0_JD = 2_460_565.5; // 2024-09-12 northern spring equinox

export const PERSEVERANCE_MISSION = Object.freeze({
    status: 'operational',
    status_checked_at: '2026-07-14',
    status_source: 'https://www.jpl.nasa.gov/images/pia26754-perseverances-trip-to-broom-point/',
    landed_at: '2021-02-18T20:55:00Z',
    latest_drive: Object.freeze({
        sol: 1940,
        distance_km: 44.14,
        checked_at: '2026-08-05',
        source: 'https://mars.nasa.gov/maps/location/?mission=M20&site=NOW',
        position: Object.freeze({
            lat_deg: 18.42638931,
            lon_deg: 77.22455732,
            elevation_m: -1963.64,
            source: 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json',
        }),
    }),
    landing_site: Object.freeze({
        lat_deg: 18.444677,
        lon_deg: 77.450812,
        label: 'Octavia E. Butler Landing',
        source: 'https://science.nasa.gov/mission/mars-2020-perseverance/location-map/',
    }),
    position: Object.freeze({
        kind: 'archived-pds-fix',
        sol: 1726,
        observed_at: '2025-12-28T06:48:41.313Z',
        lat_deg: 18.427755,
        lon_deg: 77.235291,
        local_offset_m: Object.freeze({ north: -1003.07, west: 12118.66, up: 575.32 }),
        method: 'M2020_TOPO local tangent-plane offset converted on a 3396190 m Mars sphere',
        source: 'https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/data_derived_env/sol_1620_1739/sol_1726/WE__1726___________DER_ANCILLARY___________P01.xml',
    }),
    meda_archive: Object.freeze({
        latest_verified_sol: 1726,
        release_checked_at: '2026-08-05',
        source: 'https://pds-atmospheres.nmsu.edu/data_and_services/atmospheres_data/PERSEVERANCE/meda.html',
    }),
});

export function derivePositionFromLocalOffset({
    landingLatDeg,
    landingLonDeg,
    northM,
    westM,
    radiusM = MARS_RADIUS_M,
}) {
    const radians = Math.PI / 180;
    const latDeg = landingLatDeg + northM / radiusM / radians;
    const lonDeg = landingLonDeg - westM / (radiusM * Math.cos(landingLatDeg * radians)) / radians;
    return { lat_deg: latDeg, lon_deg: lonDeg };
}

export function estimatedMissionSol(date = new Date()) {
    const elapsed = date.getTime() - Date.parse(PERSEVERANCE_MISSION.landed_at);
    return Math.max(0, Math.floor(elapsed / MARS_SOL_MS));
}

export function marsCoordinatedTimeHours(date = new Date()) {
    const jdUtc = date.getTime() / 86_400_000 + 2_440_587.5;
    const marsSolDate = (jdUtc - 2_405_522.0028779) / 1.0274912517;
    return ((marsSolDate % 1) + 1) % 1 * 24;
}

export function marsSolarLongitudeFromJulianDate(julianDate) {
    const phase = ((julianDate - MARS_LS0_JD) / MARS_YEAR_DAYS) % 1;
    return ((phase < 0 ? phase + 1 : phase) * 360);
}

export function marsSolarLongitude(date = new Date()) {
    const julianDate = date.getTime() / 86_400_000 + 2_440_587.5;
    return marsSolarLongitudeFromJulianDate(julianDate);
}

/** Approximate areocentric subsolar point for illumination/terminator display. */
export function marsSubsolarPoint(date = new Date()) {
    const lsDeg = marsSolarLongitude(date);
    const declinationRad = Math.asin(
        Math.sin(MARS_OBLIQUITY_DEG * Math.PI / 180) * Math.sin(lsDeg * Math.PI / 180),
    );
    const mtcHours = marsCoordinatedTimeHours(date);
    const rawLongitude = 15 * (12 - mtcHours);
    const lonDeg = ((rawLongitude + 180) % 360 + 360) % 360 - 180;
    return {
        lat_deg: declinationRad * 180 / Math.PI,
        lon_deg: lonDeg,
        ls_deg: lsDeg,
    };
}

export function localMeanSolarTimeHours(lonDeg, date = new Date()) {
    return (marsCoordinatedTimeHours(date) + lonDeg / 15 + 24) % 24;
}

export function formatMarsClock(hours) {
    const totalSeconds = Math.floor((((hours % 24) + 24) % 24) * 3600);
    const hh = Math.floor(totalSeconds / 3600);
    const mm = Math.floor((totalSeconds % 3600) / 60);
    const ss = totalSeconds % 60;
    return [hh, mm, ss].map(value => String(value).padStart(2, '0')).join(':');
}

export function observationFreshness(record, now = new Date()) {
    if (!record?.terrestrial_date) return { status: 'unavailable', age_days: null };
    const observed = Date.parse(`${record.terrestrial_date}T12:00:00Z`);
    if (!Number.isFinite(observed)) return { status: 'unknown', age_days: null };
    const ageDays = Math.max(0, Math.floor((now.getTime() - observed) / 86_400_000));
    return { status: ageDays <= 3 ? 'recent' : 'historical', age_days: ageDays };
}
