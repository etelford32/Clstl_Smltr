/**
 * user-location.js — User location: geocoding, storage, local time, aurora visibility
 *
 * Geocodes city / zip / address via Nominatim (free, CORS-enabled, no API key needed).
 * Persists result in localStorage across page loads.
 * Dispatches 'user-location-changed' on window when location changes.
 *
 * Usage:
 *   import { geocodeQuery, saveUserLocation, loadUserLocation,
 *            clearUserLocation, auroraVisibility, formatLocalTime } from './js/user-location.js';
 */

const LS_KEY      = 'ppx_user_location';
const LS_LIST_KEY = 'ppx_user_locations';   // multi-location watch list (AurOracle)
const MAX_SAVED   = 8;                        // keep the list (and globe pins) sane

/**
 * Geocode a free-text query (city name, zip code, or street address) via Nominatim.
 * @param {string} query
 * @returns {Promise<{lat:number, lon:number, city:string, displayName:string}>}
 * @throws {Error} on network failure or no result
 */
export async function geocodeQuery(query) {
    const params = new URLSearchParams({
        q: query, format: 'json', limit: '1', addressdetails: '1',
    });
    const res = await fetch(
        `https://nominatim.openstreetmap.org/search?${params}`,
        { headers: { 'Accept-Language': 'en' } }
    );
    if (!res.ok) throw new Error(`Geocoder HTTP ${res.status}`);
    const data = await res.json();
    if (!data.length) throw new Error('Location not found — try a city name or zip code');
    const r   = data[0];
    const adr = r.address ?? {};
    const city = adr.city || adr.town || adr.village || adr.hamlet
               || adr.county || adr.state || adr.country || query;
    return {
        lat:         parseFloat(r.lat),
        lon:         parseFloat(r.lon),
        city,
        displayName: r.display_name,
    };
}

/** Persist a location object to localStorage and dispatch 'user-location-changed'. */
export function saveUserLocation(loc) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(loc)); } catch {}
    window.dispatchEvent(new CustomEvent('user-location-changed', { detail: loc }));
}

/** Load the last saved location (or null if none). */
export function loadUserLocation() {
    try {
        const s = localStorage.getItem(LS_KEY);
        return s ? JSON.parse(s) : null;
    } catch { return null; }
}

/** Remove saved location and dispatch 'user-location-changed' with null. */
export function clearUserLocation() {
    try { localStorage.removeItem(LS_KEY); } catch {}
    window.dispatchEvent(new CustomEvent('user-location-changed', { detail: null }));
}

/* ──────────────────────────────────────────────────────────────────────────
 * Multi-location watch list
 *
 * A small, device-local list of places a signed-in user wants to track at
 * once (AurOracle: chips + globe pins). Deliberately localStorage, not a
 * user_profiles column — see CLAUDE.md (no schema change without a migration
 * plan; this mirrors the existing single-location + auroracle_alert pattern).
 * Each entry carries a stable `id` so callers can mark a "current" selection
 * and remove by identity. Changes dispatch 'user-locations-changed' with the
 * full list as detail.
 * ────────────────────────────────────────────────────────────────────────── */

/** Stable id for a place — rounded lat/lon so the same spot dedupes. */
export function locationId(loc) {
    if (loc && loc.id) return loc.id;
    const lat = Number(loc?.lat ?? 0).toFixed(2);
    const lon = Number(loc?.lon ?? 0).toFixed(2);
    return `loc_${lat}_${lon}`;
}

/** Load the saved watch list (always an array; never throws). */
export function loadLocationList() {
    try {
        const s = localStorage.getItem(LS_LIST_KEY);
        const arr = s ? JSON.parse(s) : [];
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

/** Persist a watch list and dispatch 'user-locations-changed'. */
export function saveLocationList(list) {
    const arr = Array.isArray(list) ? list.slice(0, MAX_SAVED) : [];
    try { localStorage.setItem(LS_LIST_KEY, JSON.stringify(arr)); } catch {}
    window.dispatchEvent(new CustomEvent('user-locations-changed', { detail: arr }));
    return arr;
}

/**
 * Add a place to the watch list (deduped by id, capped at MAX_SAVED).
 * Returns the updated list. A re-add moves the entry to the front.
 * @param {{name?:string, city?:string, lat:number, lon:number}} loc
 */
export function addLocationToList(loc) {
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return loadLocationList();
    const id = locationId(loc);
    const entry = {
        id,
        name: loc.name || loc.city || loc.displayName || 'Saved location',
        lat:  loc.lat,
        lon:  loc.lon,
    };
    const next = [entry, ...loadLocationList().filter(l => locationId(l) !== id)];
    return saveLocationList(next);
}

/** Remove a place from the watch list by id. Returns the updated list. */
export function removeLocationFromList(id) {
    return saveLocationList(loadLocationList().filter(l => locationId(l) !== id));
}

/**
 * Estimate aurora visibility for a geographic latitude at a given Kp index.
 *
 * Uses the empirical formula:
 *   equatorward auroral oval boundary ≈ 72° − Kp × (17/9)  geographic latitude
 *
 * @param {number} lat  Geographic latitude in degrees (−90 to +90)
 * @param {number} kp   Current Kp index (0–9)
 * @returns {{ visible:boolean, label:string, color:string, boundaryDeg:number, neededKp:number }}
 */
export function auroraVisibility(lat, kp) {
    const absLat      = Math.abs(lat);
    const boundaryDeg = Math.max(30, 72 - kp * (17 / 9));
    if (absLat >= boundaryDeg) {
        return {
            visible:     true,
            label:       'Likely visible now',
            color:       '#00ff88',
            boundaryDeg,
            neededKp:    kp,
        };
    }
    const neededKp = Math.min(9, Math.ceil((72 - absLat) * 9 / 17));
    const close    = neededKp <= kp + 2;
    return {
        visible:     false,
        label:       `Needs Kp ≥ ${neededKp}`,
        color:       close ? '#ffaa22' : '#445566',
        boundaryDeg,
        neededKp,
    };
}

/** Returns the browser's IANA timezone string (e.g. "America/New_York"). */
export function browserTimezone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Format a Date in the browser's local timezone.
 * @param {Date}    d            Date to format (defaults to now)
 * @param {boolean} includeDate  If true, include YYYY-MM-DD prefix
 * @returns {string}  e.g. "02:32 PM EDT" or "03/26/2026, 02:32 PM EDT"
 */
export function formatLocalTime(d = new Date(), includeDate = false) {
    const opts = {
        hour:         '2-digit',
        minute:       '2-digit',
        timeZoneName: 'short',
    };
    if (includeDate) {
        opts.year  = 'numeric';
        opts.month = '2-digit';
        opts.day   = '2-digit';
    }
    return d.toLocaleString([], opts);
}
