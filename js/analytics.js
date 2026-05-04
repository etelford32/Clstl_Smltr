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
            p_page_path: window.location.pathname.slice(0, 200),
            // Only send browser family, not full UA string (minimizes fingerprinting)
            p_user_agent: (navigator.userAgent || '').replace(/\(.*?\)/g, '').slice(0, 100),
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

// ── Auto-page + engagement helpers ───────────────────────────────────────────

/** Derive a short page name from the URL pathname (e.g. /earth.html -> "earth"). */
function _autoPageName() {
    try {
        const p = (window.location.pathname || '').replace(/\/+$/, '');
        const last = p.split('/').pop() || 'index';
        return last.replace(/\.html?$/i, '') || 'index';
    } catch (_) { return 'index'; }
}

let _autoPaged = false;
let _pageStart = Date.now();
let _maxScrollPct = 0;
const _scrollMilestones = new Set();
let _pageCloseSent = false;

// ── Click heatmap (opt-in via <body data-clickmap>) ──────────────────────────
// Ultralight: single passive listener, throttled to 10 Hz, batched into the
// existing 30s flush. Stores integer percentages of viewport coords + a tiny
// target descriptor. Typical session: <100 events, <5 KB total.

const _CLICK_THROTTLE_MS = 100;
let _lastClickAt = 0;
let _clickmapEnabled = false;

function _describeTarget(el) {
    if (!el || el.nodeType !== 1) return '';
    const tag = (el.tagName || '').toLowerCase();
    const id  = el.id ? '#' + el.id : '';
    let cls = '';
    if (typeof el.className === 'string' && el.className) {
        cls = '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    }
    return (tag + id + cls).slice(0, 80);
}

function _onClick(e) {
    const now = Date.now();
    if (now - _lastClickAt < _CLICK_THROTTLE_MS) return;
    _lastClickAt = now;

    const w = window.innerWidth  || 1;
    const h = window.innerHeight || 1;
    const xp = Math.max(0, Math.min(100, Math.round((e.clientX / w) * 100)));
    const yp = Math.max(0, Math.min(100, Math.round((e.clientY / h) * 100)));

    _buffer.push({
        event_type: 'click',
        event_name: _autoPageName(),
        page_path: window.location.pathname.slice(0, 200),
        page_title: (document.title || '').slice(0, 300),
        session_id: _sessionId,
        user_id: _userId,
        properties: {
            x_pct: xp,
            y_pct: yp,
            vw: w,
            vh: h,
            t: _describeTarget(e.target),
        },
        created_at: new Date().toISOString(),
    });
}

function _initClickmap() {
    if (_clickmapEnabled) return;
    if (typeof document === 'undefined' || !document.body) return;
    if (!document.body.hasAttribute('data-clickmap')) return;
    _clickmapEnabled = true;
    document.addEventListener('click', _onClick, { passive: true, capture: true });
}

// ── Scroll depth milestones (25/50/75/100%) ─────────────────────────────────

function _onScroll() {
    const doc = document.documentElement;
    const scrollable = (doc.scrollHeight - window.innerHeight) || 1;
    const pct = Math.max(0, Math.min(100, Math.round((window.scrollY / scrollable) * 100)));
    if (pct > _maxScrollPct) _maxScrollPct = pct;
    for (const m of [25, 50, 75, 100]) {
        if (pct >= m && !_scrollMilestones.has(m)) {
            _scrollMilestones.add(m);
            _buffer.push({
                event_type: 'event',
                event_name: 'scroll_depth',
                page_path: window.location.pathname.slice(0, 200),
                page_title: (document.title || '').slice(0, 300),
                session_id: _sessionId,
                user_id: _userId,
                properties: { milestone: m },
                created_at: new Date().toISOString(),
            });
        }
    }
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

        if (typeof document !== 'undefined') {
            // Auto-fire page() exactly once per import. Manually-instrumented
            // pages can still call page() with a custom name; subsequent calls
            // are accepted (and sent) so a manual call after the auto one
            // upgrades the name without losing the auto event.
            const autoFire = () => {
                if (_autoPaged) return;
                _autoPaged = true;
                _pageStart = Date.now();
                this.page(_autoPageName());
                _initClickmap();
            };
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', autoFire, { once: true });
            } else {
                autoFire();
            }

            // Scroll-depth milestones (passive, single coalesced listener).
            let scrollTimer = null;
            window.addEventListener('scroll', () => {
                if (scrollTimer) return;
                scrollTimer = setTimeout(() => { scrollTimer = null; _onScroll(); }, 200);
            }, { passive: true });

            // Time-on-page: emit on hidden + unload. Guarded so we only send
            // once per page load.
            const sendPageClose = () => {
                if (_pageCloseSent) return;
                _pageCloseSent = true;
                const dwell = Math.round((Date.now() - _pageStart) / 1000);
                _buffer.push({
                    event_type: 'event',
                    event_name: 'page_close',
                    page_path: window.location.pathname.slice(0, 200),
                    page_title: (document.title || '').slice(0, 300),
                    session_id: _sessionId,
                    user_id: _userId,
                    properties: {
                        time_on_page_s: dwell,
                        max_scroll_pct: _maxScrollPct,
                    },
                    created_at: new Date().toISOString(),
                });
            };

            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') {
                    sendPageClose();
                    _flush();
                    _endSession();
                }
            });
            window.addEventListener('pagehide', () => {
                sendPageClose();
                _flush();
                _endSession();
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
        // Sanitize: truncate fields to match RLS policy limits, minimize PII
        const safeName = (pageName || path).slice(0, 100);
        const safePath = path.slice(0, 200);
        const safeTitle = (document.title || '').slice(0, 300);
        // Referrer: only keep the origin (not full URL) to avoid leaking query params
        let safeReferrer = null;
        try { safeReferrer = document.referrer ? new URL(document.referrer).origin : null; } catch (_) {}

        const event = {
            event_type: 'page_view',
            event_name: safeName,
            page_path: safePath,
            page_title: safeTitle,
            referrer: safeReferrer,
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
        if (!name || typeof name !== 'string') return;
        const safeName = name.slice(0, 100);
        const safePath = window.location.pathname.slice(0, 200);

        // Limit properties to 2KB to prevent storage abuse
        let safeProps = props;
        try {
            const serialized = JSON.stringify(props);
            if (serialized.length > 2000) {
                console.warn('[Analytics] Event properties exceed 2KB, dropping');
                safeProps = {};
            }
        } catch (_) { safeProps = {}; }

        const event = {
            event_type: 'event',
            event_name: safeName,
            page_path: safePath,
            page_title: (document.title || '').slice(0, 300),
            session_id: _sessionId,
            user_id: _userId,
            properties: { ...safeProps },
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

        // Only log non-PII traits — never send email, name, or other PII to analytics
        this.event('identify', { plan: traits.plan, role: traits.role });
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
