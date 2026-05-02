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

// Mirror of the SQL CHECK constraint. Keep in lockstep with:
//   - supabase-class-seats-migration.sql       (original event set)
//   - supabase-onboarding-events-migration.sql (wizard / tour / demo /
//                                                auth-flow events)
//   - supabase-welcome-email-migration.sql     (welcome_email_sent)
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
    // Welcome wizard
    WIZARD_SHOWN:            'wizard_shown',
    WIZARD_STEP_COMPLETED:   'wizard_step_completed',
    WIZARD_SKIPPED:          'wizard_skipped',
    WIZARD_COMPLETED:        'wizard_completed',
    // Guided tour
    TOUR_STARTED:            'tour_started',
    TOUR_COMPLETED:          'tour_completed',
    TOUR_SKIPPED:             'tour_skipped',
    // Anonymous demo
    DEMO_ENTERED:            'demo_entered',
    DEMO_SIGNUP_CLICKED:     'demo_signup_clicked',
    // Auth flow telemetry
    SIGNIN_SUCCEEDED:        'signin_succeeded',
    SIGNIN_FAILED:           'signin_failed',
    RETURNING_USER_SESSION:  'returning_user_session',
    // Lifecycle email automation
    WELCOME_EMAIL_SENT:      'welcome_email_sent',
});

const VALID = new Set(Object.values(EVENTS));

// Events that have a UNIQUE-per-user constraint in the DB and therefore
// only ever produce one row per user. Dedupe-by-name within a page
// session is correct (and saves a round-trip) for these, but for events
// we expect to fire multiple times per session — wizard_step_completed,
// signin_failed, demo_signup_clicked, etc. — we MUST let every call
// through so the funnel and conversion math are accurate.
const SINGLE_FIRE = new Set([
    EVENTS.SIGNUP,
    EVENTS.PROFILE_COMPLETED,
    EVENTS.LOCATION_SAVED,
    EVENTS.FIRST_SIM_OPENED,
    EVENTS.FIRST_ALERT_CONFIGURED,
    EVENTS.FIRST_EMAIL_ALERT_SENT,
    EVENTS.WIZARD_SHOWN,
    EVENTS.WIZARD_COMPLETED,
    EVENTS.TOUR_STARTED,
    EVENTS.TOUR_COMPLETED,
    EVENTS.DEMO_ENTERED,
    EVENTS.RETURNING_USER_SESSION,
    EVENTS.WELCOME_EMAIL_SENT,
]);
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
    if (SINGLE_FIRE.has(event) && _firedThisSession.has(event)) return false;

    let plan = null;
    try {
        // Soft-import to avoid a hard cycle (activation ← auth ← activation).
        const { auth } = await import('./auth.js');
        // The auth module's method is isSignedIn() — earlier code checked
        // isLoggedIn() which always returned undefined, silently dropping
        // every event. The bug masked the activation funnel for the entire
        // history of the table; rerun the funnel after applying the
        // onboarding-events migration to start collecting clean data.
        if (auth?.isSignedIn?.()) plan = auth.getPlan();
        else                       return false;         // no anon events
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
        // Only memo "single-fire" events. Multi-fire ones (step counters,
        // failed signins, etc.) need every call to reach the DB.
        if (SINGLE_FIRE.has(event)) _firedThisSession.add(event);
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
