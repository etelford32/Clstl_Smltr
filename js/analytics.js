/**
 * analytics.js — Lightweight event tracking with GA4 prep + Supabase first-party analytics
 *
 * ── Architecture ─────────────────────────────────────────────────────────────
 *   1. Google Analytics 4 (GA4):
 *      Set GA_MEASUREMENT_ID below to enable. Loads gtag.js from CDN.
 *      Until configured, all gtag calls are no-ops.
 *
 *   2. Supabase first-party analytics:
 *      - analytics_events table: page views, custom events
 *      - user_sessions table: heartbeat-based session tracking
 *      Provides admin dashboard metrics immune to ad blockers.
 *
 *   3. In-memory session buffer:
 *      Events are buffered and flushed in batches for performance.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   import { analytics } from './js/analytics.js';
 *
 *   analytics.page('earth');
 *   analytics.event('simulation_start', { sim: 'earth', mode: '3d' });
 *   analytics.identify(userId, { email, plan });
 *
 * ── GA4 Setup ────────────────────────────────────────────────────────────────
 *   1. Create GA4 property at https://analytics.google.com
 *   2. Get Measurement ID (G-XXXXXXXXXX)
 *   3. Set GA_MEASUREMENT_ID below
 *   4. Deploy — gtag.js loads automatically
 */

// ── Configuration ────────────────────────────────────────────────────────────

/** Set this to your GA4 Measurement ID to enable Google Analytics. */
export const GA_MEASUREMENT_ID = 'G-W8WFYFDDGC';

/** Flush interval (ms) — sends buffered events to Supabase. */
const FLUSH_INTERVAL = 30_000;

/** Session heartbeat interval (ms) — keeps user_sessions.last_seen fresh. */
const HEARTBEAT_INTERVAL = 60_000;

// ── State ────────────────────────────────────────────────────────────────────

const _sessionId = _makeSessionId();
const _sessionStart = Date.now();
const _buffer = [];
const _sessionEvents = [];
let _userId = null;
let _userProps = {};
let _supabase = null;
let _supabaseReady = false;
let _gtagReady = false;
let _heartbeatTimer = null;

function _makeSessionId() {
    return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ── GA4 Loader ───────────────────────────────────────────────────────────────

function _initGA() {
    if (!GA_MEASUREMENT_ID || _gtagReady) return;

    window.dataLayer = window.dataLayer || [];
    window.gtag = function() { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_MEASUREMENT_ID, {
        send_page_view: false,
    });

    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
    script.onload = () => { _gtagReady = true; console.info('[Analytics] GA4 loaded:', GA_MEASUREMENT_ID); };
    document.head.appendChild(script);
}

// ── Supabase Loader ──────────────────────────────────────────────────────────

async function _initSupabase() {
    try {
        const { getSupabase, isConfigured } = await import('./supabase-config.js');
        if (isConfigured()) {
            _supabase = await getSupabase();
            _supabaseReady = true;
            console.info('[Analytics] Supabase analytics active');
        }
    } catch (_) {}
}

// ── Flush buffer to Supabase ─────────────────────────────────────────────────

async function _flush() {
    if (!_supabase || _buffer.length === 0) return;

    const batch = _buffer.splice(0, _buffer.length);
    try {
        await _supabase.from('analytics_events').insert(batch);
    } catch (err) {
        _buffer.unshift(...batch);
        console.warn('[Analytics] Flush failed:', err.message);
    }
}

// ── Session heartbeat ────────────────────────────────────────────────────────

async function _heartbeat() {
    if (!_supabase) return;
    try {
        await _supabase.rpc('session_heartbeat', {
            p_session_id: _sessionId,
            p_user_id: _userId || null,
            p_page_path: window.location.pathname,
            p_user_agent: navigator.userAgent.slice(0, 200),
        });
    } catch (err) {
        console.warn('[Analytics] Heartbeat failed:', err.message);
    }
}

async function _endSession() {
    if (!_supabase) return;
    try {
        await _supabase.from('user_sessions')
            .update({
                ended: true,
                last_seen: new Date().toISOString(),
                duration_s: Math.round((Date.now() - _sessionStart) / 1000),
            })
            .eq('session_id', _sessionId);
    } catch (_) {}
}

// ── Core API ─────────────────────────────────────────────────────────────────

class Analytics {
    constructor() {
        _initGA();
        const supaInit = _initSupabase();

        setInterval(_flush, FLUSH_INTERVAL);

        // Start heartbeat after Supabase is ready
        supaInit.then(() => {
            if (_supabaseReady) {
                _heartbeat();  // initial heartbeat
                _heartbeatTimer = setInterval(_heartbeat, HEARTBEAT_INTERVAL);
            }
        });

        // Flush + end session on page hide/unload
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') {
                    _flush();
                    _endSession();
                }
            });
        }
    }

    /**
     * Track a page view.
     * @param {string} pageName - Short page identifier (e.g. 'earth', 'dashboard')
     * @param {object} [props] - Additional properties
     */
    page(pageName, props = {}) {
        const path = window.location.pathname;
        const event = {
            event_type: 'page_view',
            event_name: pageName || path,
            page_path: path,
            page_title: document.title,
            referrer: document.referrer || null,
            session_id: _sessionId,
            user_id: _userId,
            properties: { ...props },
            created_at: new Date().toISOString(),
        };

        _sessionEvents.push(event);
        _buffer.push(event);

        if (_gtagReady) {
            window.gtag('event', 'page_view', {
                page_title: document.title,
                page_location: window.location.href,
                page_path: path,
                pp_page: pageName,
                ...props,
            });
        }
    }

    /**
     * Track a custom event.
     * @param {string} name - Event name (e.g. 'simulation_start', 'signup_complete')
     * @param {object} [props] - Event properties
     */
    event(name, props = {}) {
        const event = {
            event_type: 'event',
            event_name: name,
            page_path: window.location.pathname,
            page_title: document.title,
            session_id: _sessionId,
            user_id: _userId,
            properties: { ...props },
            created_at: new Date().toISOString(),
        };

        _sessionEvents.push(event);
        _buffer.push(event);

        if (_gtagReady) {
            window.gtag('event', name, props);
        }
    }

    /**
     * Identify a user (after sign-in).
     * @param {string} userId - Supabase user ID
     * @param {object} [traits] - User properties (email, plan, role)
     */
    identify(userId, traits = {}) {
        _userId = userId;
        _userProps = { ...traits };

        if (_gtagReady) {
            window.gtag('set', 'user_properties', {
                pp_plan: traits.plan,
                pp_role: traits.role,
            });
            window.gtag('set', { user_id: userId });
        }

        this.event('identify', { ...traits });
        // Update heartbeat with userId
        _heartbeat();
    }

    /**
     * Track simulation engagement.
     */
    simulation(simName, action, props = {}) {
        this.event(`sim_${action}`, { simulation: simName, ...props });
    }

    /** Get all events from this session (for admin panel). */
    getSessionEvents() { return [..._sessionEvents]; }

    /** Get session metadata. */
    getSession() {
        return {
            id: _sessionId,
            start: _sessionStart,
            duration: Date.now() - _sessionStart,
            events: _sessionEvents.length,
            userId: _userId,
            userProps: { ..._userProps },
        };
    }

    /** Get GA4 config status. */
    getGAStatus() {
        return {
            configured: !!GA_MEASUREMENT_ID,
            measurementId: GA_MEASUREMENT_ID || null,
            loaded: _gtagReady,
        };
    }

    /** Get pending buffer size. */
    getPendingCount() { return _buffer.length; }

    /** Force flush buffered events to Supabase. */
    async flush() { return _flush(); }
}

/** Singleton analytics instance. */
export const analytics = new Analytics();
