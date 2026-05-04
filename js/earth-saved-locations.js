/**
 * earth-saved-locations.js — client-side multi-location storage for the
 * earth.html simulation page.
 *
 * This is intentionally separate from js/saved-locations.js (which is
 * Supabase-backed and tied to authenticated multi-location alert routing).
 * Here we just want a lightweight, no-account-required list that lives in
 * localStorage so a visitor can pin a few places ("Home", "Cabin", "Work")
 * and see local time + sunrise/sunset summaries below the globe.
 *
 * Storage shape (localStorage key "pp-earth-saved-locations"):
 *   [
 *     { id, city, displayName, lat, lon, addedAt },
 *     …
 *   ]
 *
 * Dedup rule: locations within ~2 km of each other (≈ same neighbourhood)
 * are treated as the same pin and the existing record is refreshed in place
 * rather than duplicated.
 *
 * Cap: SAVED_LIMIT entries — older entries fall off when the cap is hit.
 *
 * Events dispatched on window:
 *   'pp-saved-locations-changed' — fired on add/remove/clear, detail = list.
 */

const LS_KEY = 'pp-earth-saved-locations';
const SAVED_LIMIT = 12;
const DEDUP_DEG = 0.02;   // ≈ 2 km at the equator

const EVT = 'pp-saved-locations-changed';

function _read() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

function _write(list) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch {}
    window.dispatchEvent(new CustomEvent(EVT, { detail: list }));
}

function _id() {
    return 'l_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

/** Get all saved locations (newest first). */
export function listSavedLocations() {
    return _read();
}

/**
 * Add (or refresh, if a near-duplicate exists) a location. Returns the
 * stored row.
 *
 * @param {{city?:string, displayName?:string, lat:number, lon:number}} loc
 */
export function addSavedLocation(loc) {
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return null;

    const list = _read();
    const dupeIdx = list.findIndex(r =>
        Math.abs(r.lat - loc.lat) < DEDUP_DEG &&
        Math.abs(r.lon - loc.lon) < DEDUP_DEG
    );

    const row = {
        id:          dupeIdx >= 0 ? list[dupeIdx].id : _id(),
        city:        loc.city || loc.displayName || `${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)}`,
        displayName: loc.displayName || loc.city || '',
        lat:         +loc.lat,
        lon:         +loc.lon,
        addedAt:     Date.now(),
    };

    let next;
    if (dupeIdx >= 0) {
        next = list.slice();
        next[dupeIdx] = row;
    } else {
        next = [row, ...list].slice(0, SAVED_LIMIT);
    }
    _write(next);
    return row;
}

/** Remove a saved location by id. */
export function removeSavedLocation(id) {
    const next = _read().filter(r => r.id !== id);
    _write(next);
}

/** Wipe everything. */
export function clearSavedLocations() {
    _write([]);
}

/** Subscribe to changes; returns an unsubscribe fn. */
export function onSavedLocationsChanged(handler) {
    window.addEventListener(EVT, handler);
    return () => window.removeEventListener(EVT, handler);
}

/**
 * Approximate the IANA timezone for a given lon. Avoids a network round-trip
 * to a tz database — accurate to ±1 hour, which is fine for a glance card.
 * Returned as a numeric UTC offset in hours; the formatter applies it.
 */
function _approxOffsetHours(lon) {
    return Math.round(lon / 15);
}

/** Format local clock for a given location using the lon-based UTC offset. */
export function formatLocalClock(lat, lon, now = new Date()) {
    const offH = _approxOffsetHours(lon);
    const local = new Date(now.getTime() + offH * 3600 * 1000 + now.getTimezoneOffset() * 60 * 1000);
    const hh = String(local.getHours()).padStart(2, '0');
    const mm = String(local.getMinutes()).padStart(2, '0');
    const sign = offH >= 0 ? '+' : '−';
    return `${hh}:${mm} (UTC${sign}${Math.abs(offH)})`;
}

/**
 * Naive solar elevation: 90° − |lat − sub-solar lat|; treats noon as the
 * moment the sub-solar lon equals the location lon. Good enough for a
 * "day / night / dusk" badge under each saved location.
 */
export function dayNightBadge(lat, lon, now = new Date()) {
    // Sub-solar longitude moves 15°/h westward; at solar noon UTC it sits
    // at lon = -15 * (UTC hour - 12).
    const utcHrs = now.getUTCHours() + now.getUTCMinutes() / 60;
    const subSolarLon = -15 * (utcHrs - 12);
    // Approximate sub-solar lat from day-of-year (axial tilt ≈ 23.44°).
    const dayOfYear = Math.floor((now - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86400000);
    const subSolarLat = 23.44 * Math.sin(2 * Math.PI * (dayOfYear - 81) / 365);

    // Spherical-law-of-cosines for the solar zenith angle.
    const toRad = d => d * Math.PI / 180;
    const cosZ = Math.sin(toRad(lat)) * Math.sin(toRad(subSolarLat))
               + Math.cos(toRad(lat)) * Math.cos(toRad(subSolarLat))
               * Math.cos(toRad(lon - subSolarLon));
    const elev = 90 - Math.acos(Math.max(-1, Math.min(1, cosZ))) * 180 / Math.PI;

    if (elev > 6)   return { label: 'Day',   icon: '☀️', color: '#ffd54a' };
    if (elev > -6)  return { label: 'Dusk',  icon: '🌅', color: '#ff9d3a' };
    if (elev > -12) return { label: 'Civil', icon: '🌆', color: '#a098ff' };
    return                  { label: 'Night', icon: '🌙', color: '#7ab0ff' };
}
