/**
 * activation.js — Activation event logging
 *
 * Thin wrapper around the `log_activation_event` Postgres RPC. The RPC
 * is idempotent for "first_*" events (unique partial index in the
 * migration), so this module fires-and-forgets without any client-side
 * dedupe.
 *
 * Usage:
 *   import { logActivation } from './activation.js';
 *   logActivation('first_sim_opened', { sim: 'sun' });
 *
 * Allow-list of event names lives in the SQL CHECK constraint. If you
 * add a new event, update both this file and the migration.
 */

import { getSupabase } from './supabase-config.js';

// Mirror of the SQL CHECK constraint. Keep in lockstep with
// supabase-class-seats-migration.sql.
export const EVENTS = Object.freeze({
    SIGNUP:                  'signup',
    PROFILE_COMPLETED:       'profile_completed',
    LOCATION_SAVED:          'location_saved',
    FIRST_SIM_OPENED:        'first_sim_opened',
    FIRST_ALERT_CONFIGURED:  'first_alert_configured',
    FIRST_EMAIL_ALERT_SENT:  'first_email_alert_sent',
    INVITE_SENT:             'invite_sent',
    STUDENT_JOINED:          'student_joined',
    SUBSCRIPTION_STARTED:    'subscription_started',
    SUBSCRIPTION_CANCELED:   'subscription_canceled',
});

const VALID = new Set(Object.values(EVENTS));

// In-flight + already-logged dedupe within the page session. The DB
// also dedupes via unique index, but skipping a known-fired event
// avoids a round-trip per dashboard render.
const _firedThisSession = new Set();

/**
 * Log an activation event. Returns a Promise<boolean> — true if a new
 * row was inserted, false if it was a duplicate or the call failed.
 * Never throws — activation logging is non-essential telemetry.
 */
export async function logActivation(event, metadata = {}) {
    if (!VALID.has(event)) {
        console.warn('[activation] unknown event:', event);
        return false;
    }
    if (_firedThisSession.has(event)) return false;

    let plan = null;
    try {
        // Soft-import to avoid a hard cycle (activation ← auth ← activation).
        const { auth } = await import('./auth.js');
        if (auth?.isLoggedIn?.()) plan = auth.getPlan();
        else                      return false;          // no anon events
    } catch { return false; }

    try {
        const sb = await getSupabase();
        const { data, error } = await sb.rpc('log_activation_event', {
            p_event:    event,
            p_plan:     plan,
            p_metadata: metadata || {},
        });
        if (error) {
            console.warn('[activation] RPC error:', error.message);
            return false;
        }
        _firedThisSession.add(event);
        return data === true;
    } catch (e) {
        console.warn('[activation] failed:', e.message);
        return false;
    }
}

/**
 * Convenience: log on the next idle frame so the call never blocks the
 * UI thread. Use this for "user just clicked X" hooks.
 */
export function logActivationDeferred(event, metadata = {}) {
    const fire = () => logActivation(event, metadata);
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(fire, { timeout: 2000 });
    } else {
        setTimeout(fire, 0);
    }
}
