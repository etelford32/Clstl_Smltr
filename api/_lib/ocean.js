/** Dependency-free helpers shared by the ocean data routes. */

const EARTH_RADIUS_KM = 6371.0088;
const DEG_TO_RAD = Math.PI / 180;

export function haversineKm(latA, lonA, latB, lonB) {
    const phi1 = latA * DEG_TO_RAD;
    const phi2 = latB * DEG_TO_RAD;
    const dPhi = (latB - latA) * DEG_TO_RAD;
    const dLam = (lonB - lonA) * DEG_TO_RAD;
    const a = Math.sin(dPhi / 2) ** 2
        + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
    return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function finiteOrNull(value) {
    if (value == null || value === '' || value === 'MM') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

export function roundTo(value, decimals = 3) {
    if (!Number.isFinite(value)) return null;
    const scale = 10 ** decimals;
    return Math.round(value * scale) / scale;
}

export function validCoordinates(lat, lon) {
    return Number.isFinite(lat) && lat >= -90 && lat <= 90
        && Number.isFinite(lon) && lon >= -180 && lon <= 180;
}
