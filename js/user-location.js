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

const LS_KEY = 'ppx_user_location';

/**
 * Geocode a free-text query via Nominatim (OpenStreetMap).
 * Handles: cities, zip/postal codes, states, countries, addresses, landmarks.
 *
 * Examples that work:
 *   "New York"          → New York, NY, USA
 *   "Paris"             → Paris, France
 *   "90210"             → Beverly Hills, CA (US zip)
 *   "SW1A 1AA"          → Westminster, London (UK postcode)
 *   "Tokyo, Japan"      → Tokyo, Japan
 *   "Texas"             → State of Texas, USA
 *   "Mount Everest"     → Sagarmatha, Nepal
 *   "10001"             → Manhattan, NY (US zip)
 *   "France"            → France (country centroid)
 *   "ISS"               → won't work (not a place) — use GPS instead
 *
 * Strategy: free-text search first. If that fails and input looks like
 * a postal code, retry with structured postalcode search.
 *
 * @param {string} query
 * @returns {Promise<{lat:number, lon:number, city:string, displayName:string, country:string, type:string}>}
 * @throws {Error} on network failure or no result
 */
export async function geocodeQuery(query) {
    query = query.trim();
    if (!query) throw new Error('Enter a city, zip code, or address');

    // Try free-text search first (handles most queries)
    let result = await _nominatimSearch({ q: query });

    // If no result and looks like a postal code, try structured search
    if (!result && /^\d{3,10}$/.test(query)) {
        // Pure numeric → likely US/international zip code
        result = await _nominatimSearch({ postalcode: query, country: 'us' });
        if (!result) result = await _nominatimSearch({ postalcode: query });
    }
    // UK-style postcode (e.g. "SW1A 1AA", "EC2R 8AH")
    if (!result && /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(query)) {
        result = await _nominatimSearch({ postalcode: query, country: 'gb' });
    }
    // Canadian postcode (e.g. "K1A 0B1")
    if (!result && /^[A-Z]\d[A-Z]\s*\d[A-Z]\d$/i.test(query)) {
        result = await _nominatimSearch({ postalcode: query, country: 'ca' });
    }

    if (!result) {
        throw new Error(
            'Location not found. Try:\n• City name (e.g. "London")\n• Zip code (e.g. "90210")\n• Country (e.g. "Japan")\n• Address or landmark'
        );
    }

    return result;
}

/** Internal: Nominatim search with given params. Returns result or null. */
async function _nominatimSearch(searchParams) {
    const params = new URLSearchParams({
        ...searchParams,
        format: 'json',
        limit: '1',
        addressdetails: '1',
    });
    try {
        const res = await fetch(
            `https://nominatim.openstreetmap.org/search?${params}`,
            {
                headers: {
                    'Accept-Language': 'en',
                    'User-Agent': 'ParkerPhysics-EarthSim/1.0',
                },
                signal: AbortSignal.timeout(8000),
            }
        );
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.length) return null;

        const r   = data[0];
        const adr = r.address ?? {};

        // Build a human-friendly location name
        const city = adr.city || adr.town || adr.village || adr.hamlet || '';
        const state = adr.state || '';
        const country = adr.country || '';
        const county = adr.county || '';

        // Smart label: "City, State" for US, "City, Country" for others
        let label = city;
        if (!label) label = county || state || country || r.display_name?.split(',')[0] || '';
        if (state && adr.country_code === 'us' && city) label += `, ${state}`;
        else if (country && city) label += `, ${country}`;
        else if (!city && state) label = state + (country ? `, ${country}` : '');
        else if (!city && !state) label = country || r.display_name || '';

        // Determine what type of result this is
        const type = r.type || r.class || 'place';

        return {
            lat:         parseFloat(r.lat),
            lon:         parseFloat(r.lon),
            city:        label,
            displayName: r.display_name,
            country:     adr.country_code?.toUpperCase() || '',
            type,
        };
    } catch {
        return null;
    }
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
