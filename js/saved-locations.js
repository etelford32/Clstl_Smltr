/**
 * saved-locations.js — Multi-location storage for alert routing.
 *
 * Each authenticated user can save multiple labeled locations
 * ("Home", "Cabin", "Office", …) with per-location alert config
 * (which alert types fire + per-type thresholds).
 *
 * Plan caps (enforced both client-side and by a DB trigger).
 * Mirrors public.plan_location_limit() in Supabase migrations:
 *   free         → 0 saved locations
 *   basic        → 5 saved locations
 *   educator     → 5 saved locations
 *   advanced     → 25 saved locations
 *   institution  → 25 saved locations
 *   enterprise   → 100 saved locations
 *
 * Alert config stored on each row as JSONB. Any field left null
 * falls back to the account-level default on user_profiles.
 *
 * Dispatches 'saved-locations-changed' on window after every
 * mutation (add/update/remove/set-primary) so the alert engine
 * and dashboard UI can re-render.
 */

import { auth } from './auth.js';
import { getSupabase, isConfigured } from './supabase-config.js';
import { TIERS, locationLimit as _cfgLocationLimit } from './tier-config.js';

const EVT = 'saved-locations-changed';

// Built from js/tier-config.js so the cap table is defined in exactly one
// place. Kept as a frozen { plan: limit } map for backward compatibility
// with the dashboard's existing PLAN_LIMITS import.
export const PLAN_LIMITS = Object.freeze(
    Object.fromEntries(TIERS.map(t => [t.id, t.locationLimit]))
);

/** Columns fetched from user_locations. */
const COLS = 'id, label, lat, lon, city, is_primary, notify_enabled, email_alerts_enabled, daily_digest_enabled, alert_config, timezone, created_at, updated_at';

/** Cache keyed by user id so repeat calls in the same tick are cheap. */
let _cache = null;
let _cacheUserId = null;

function _notify() {
    window.dispatchEvent(new CustomEvent(EVT));
}

function _invalidate() {
    _cache = null;
    _cacheUserId = null;
}

/** Return the numeric cap for the signed-in user's plan (admins/testers: Infinity). */
export function locationLimit() {
    if (auth.isAdmin?.() || auth.isTester?.()) return Infinity;
    return _cfgLocationLimit(auth.getPlan?.() || 'free');
}

/** True if the user has room for another saved location. */
export function canAddLocation(count) {
    return count < locationLimit();
}

/**
 * Fetch the signed-in user's saved locations from Supabase,
 * ordered by is_primary DESC, created_at ASC.
 * Returns [] if not signed in / not configured.
 */
export async function listLocations({ force = false } = {}) {
    const userId = auth.getUser?.()?.id;
    if (!userId || !isConfigured()) return [];

    if (!force && _cache && _cacheUserId === userId) return _cache;

    try {
        const sb = await getSupabase();
        const { data, error } = await sb
            .from('user_locations')
            .select(COLS)
            .eq('user_id', userId)
            .order('is_primary', { ascending: false })
            .order('created_at', { ascending: true });
        if (error) {
            console.warn('[SavedLocations] list failed:', error.message);
            return [];
        }
        _cache = data ?? [];
        _cacheUserId = userId;
        return _cache;
    } catch (e) {
        console.warn('[SavedLocations] list error:', e.message);
        return [];
    }
}

/**
 * Insert a new saved location.
 * @param {object} loc — { label, lat, lon, city, is_primary?, alert_config? }
 * @returns {Promise<{ok:boolean, id?:string, error?:string, limitReached?:boolean}>}
 */
export async function addLocation(loc) {
    const userId = auth.getUser?.()?.id;
    if (!userId) return { ok: false, error: 'not_signed_in' };
    if (!isConfigured()) return { ok: false, error: 'backend_unconfigured' };

    // Pre-check client-side (the DB trigger is the source of truth,
    // but checking here lets us produce a clean upgrade prompt).
    const existing = await listLocations({ force: true });
    if (existing.length >= locationLimit()) {
        return { ok: false, error: 'location_limit_exceeded', limitReached: true };
    }

    const row = {
        user_id:              userId,
        label:                loc.label?.trim() || 'New Location',
        lat:                  +loc.lat,
        lon:                  +loc.lon,
        city:                 loc.city ?? null,
        is_primary:           !!loc.is_primary,
        notify_enabled:       loc.notify_enabled ?? true,
        email_alerts_enabled: loc.email_alerts_enabled ?? true,
        daily_digest_enabled: loc.daily_digest_enabled ?? false,
        alert_config:         loc.alert_config ?? {},
        timezone:             loc.timezone ?? null,
    };

    try {
        const sb = await getSupabase();
        const { data, error } = await sb
            .from('user_locations')
            .insert(row)
            .select(COLS)
            .single();
        if (error) {
            if (error.message?.includes('location_limit_exceeded')) {
                return { ok: false, error: 'location_limit_exceeded', limitReached: true };
            }
            return { ok: false, error: error.message };
        }
        _invalidate();
        _notify();
        return { ok: true, id: data.id, row: data };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * Update fields on an existing location.
 * @param {string} id
 * @param {object} patch — any subset of columns.
 */
export async function updateLocation(id, patch) {
    if (!isConfigured()) return { ok: false, error: 'backend_unconfigured' };
    const userId = auth.getUser?.()?.id;
    if (!userId) return { ok: false, error: 'not_signed_in' };

    const allowed = [
        'label', 'lat', 'lon', 'city',
        'is_primary', 'notify_enabled', 'email_alerts_enabled',
        'daily_digest_enabled',
        'alert_config', 'timezone',
    ];
    const row = {};
    for (const k of allowed) if (patch[k] !== undefined) row[k] = patch[k];
    row.updated_at = new Date().toISOString();

    try {
        const sb = await getSupabase();
        const { error } = await sb
            .from('user_locations')
            .update(row)
            .eq('id', id)
            .eq('user_id', userId);
        if (error) return { ok: false, error: error.message };
        _invalidate();
        _notify();
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/** Flip which saved location is the primary one. */
export async function setPrimaryLocation(id) {
    return updateLocation(id, { is_primary: true });
}

/** Delete a saved location. */
export async function removeLocation(id) {
    if (!isConfigured()) return { ok: false, error: 'backend_unconfigured' };
    const userId = auth.getUser?.()?.id;
    if (!userId) return { ok: false, error: 'not_signed_in' };

    try {
        const sb = await getSupabase();
        const { error } = await sb
            .from('user_locations')
            .delete()
            .eq('id', id)
            .eq('user_id', userId);
        if (error) return { ok: false, error: error.message };
        _invalidate();
        _notify();
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * Merge per-location alert_config over the account-level defaults.
 * Any field present on the location's alert_config wins.
 *
 * @param {object} location       — a row from listLocations()
 * @param {object} profilePrefs   — auth.getAlertPrefs()
 * @returns {object}              — effective prefs used by the engine
 */
export function effectivePrefs(location, profilePrefs) {
    const base = { ...(profilePrefs ?? {}) };
    const over = location?.alert_config ?? {};
    for (const k of Object.keys(over)) {
        if (over[k] !== null && over[k] !== undefined) base[k] = over[k];
    }
    return base;
}

/** Subscribe to mutation events. Returns an unsubscribe fn. */
export function onLocationsChanged(handler) {
    window.addEventListener(EVT, handler);
    return () => window.removeEventListener(EVT, handler);
}
