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

/**
 * Session continuity across page loads.
 *
 * This is a multi-page app — every full-page navigation re-runs analytics.js.
 * If we mint a fresh session ID on each load, every analytics_events row sits
 * in its own "session", which inflates session counts, pins pages-per-session
 * at 1 and bounce rate at 100%. We persist the ID in sessionStorage with a
 * sliding idle timeout (GA4-style, 30 min) so navigations within the same
 * tab share a session. The anon → signed-in transition keeps the same ID,
 * which is what the visitor-flow `anonConverted` metric needs.
 */
const SESSION_STORAGE_KEY = 'pp_analytics_session';
const SESSION_IDLE_MS = 30 * 60 * 1000;

function _makeSessionId() {
    return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ── First-touch attribution ──────────────────────────────────────────────────
// Captured ONCE at session creation and stored next to the session_id. Every
// downstream metric (retention, A/B, funnels) can be sliced by these fields
// by joining on session_id against the `session_start` event emitted below.

const _UTM_KEYS  = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'];
const _AD_KEYS   = ['gclid','fbclid','msclkid','ttclid','li_fat_id'];
const _SEARCH_HOSTS = /(^|\.)(google|bing|yahoo|duckduckgo|baidu|yandex|ecosia|brave|kagi)\./i;
const _SOCIAL_HOSTS = /(^|\.)(facebook|twitter|x|t\.co|linkedin|reddit|youtube|tiktok|instagram|pinterest|threads|bsky|mastodon)\./i;

function _classifyReferrer(host, hasAdClick) {
    if (hasAdClick) return 'paid';
    if (!host) return 'direct';
    if (_SEARCH_HOSTS.test(host)) return 'search';
    if (_SOCIAL_HOSTS.test(host)) return 'social';
    return 'referral';
}

function _deviceClass(w) {
    if (w < 640)  return 'mobile';
    if (w < 1024) return 'tablet';
    return 'desktop';
}

function _captureFirstTouch() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return null;
    let utm = null, ad = null, referrerOrigin = null, referrerHost = null;
    try {
        const p = new URLSearchParams(window.location.search);
        for (const k of _UTM_KEYS) {
            const v = p.get(k);
            if (v) { utm = utm || {}; utm[k] = v.slice(0, 80); }
        }
        for (const k of _AD_KEYS) {
            const v = p.get(k);
            if (v) { ad = ad || {}; ad[k] = v.slice(0, 120); }
        }
    } catch (_) {}
    try {
        if (document.referrer) {
            const u = new URL(document.referrer);
            referrerOrigin = u.origin;
            referrerHost   = u.hostname;
        }
    } catch (_) {}

    // Same-origin referrers are intra-site navigations, not acquisition signal.
    try {
        if (referrerOrigin && referrerOrigin === window.location.origin) {
            referrerOrigin = null;
            referrerHost   = null;
        }
    } catch (_) {}

    const vw = window.innerWidth  || 0;
    const vh = window.innerHeight || 0;
    const channel = _classifyReferrer(referrerHost, !!ad);

    // Best-effort connection info — Safari/iOS lacks navigator.connection.
    let connection = null;
    try {
        const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (c?.effectiveType) connection = String(c.effectiveType).slice(0, 12);
    } catch (_) {}

    return {
        landing_page:    (window.location.pathname || '/').slice(0, 200),
        landing_title:   (document.title || '').slice(0, 200),
        // utm_source / medium / campaign / term / content if present
        ...(utm || {}),
        // Click IDs flattened so they're queryable directly.
        ...(ad  || {}),
        referrer_origin: referrerOrigin,
        referrer_host:   referrerHost,
        channel,                          // direct | search | social | referral | paid
        device:          _deviceClass(vw),
        viewport_w:      vw,
        viewport_h:      vh,
        screen_w:        (screen && screen.width)  || 0,
        screen_h:        (screen && screen.height) || 0,
        dpr:             window.devicePixelRatio || 1,
        language:        (navigator.language || '').slice(0, 16),
        tz_offset_min:   new Date().getTimezoneOffset(),
        connection,                       // 4g | 3g | 2g | slow-2g | null
        reduced_motion:  !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
        color_scheme:    (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light',
    };
}

function _readStoredSession() {
    try {
        const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj.id !== 'string') return null;
        return obj;
    } catch (_) { return null; }
}

function _writeStoredSession(id, start, lastActivity, firstTouch) {
    try {
        sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ id, start, lastActivity, firstTouch }));
    } catch (_) { /* private mode / quota — fall back to in-memory only */ }
}

function _resolveSession() {
    const now = Date.now();
    const stored = _readStoredSession();
    if (stored && (now - (stored.lastActivity || 0)) < SESSION_IDLE_MS) {
        _writeStoredSession(stored.id, stored.start || now, now, stored.firstTouch || null);
        return { id: stored.id, start: stored.start || now, firstTouch: stored.firstTouch || null, isNew: false };
    }
    const id = _makeSessionId();
    const firstTouch = _captureFirstTouch();
    _writeStoredSession(id, now, now, firstTouch);
    return { id, start: now, firstTouch, isNew: true };
}

const _resolved = _resolveSession();
let _sessionId    = _resolved.id;
let _sessionStart = _resolved.start;
let _firstTouch   = _resolved.firstTouch;
let _isNewSession = _resolved.isNew;

function _touchSession() {
    _writeStoredSession(_sessionId, _sessionStart, Date.now(), _firstTouch);
}

const _buffer = [];
const _sessionEvents = [];
let _userId = null;
let _userProps = {};
let _supabase = null;
let _supabaseReady = false;
let _gtagReady = false;   // gtag.js <script> finished loading (status only)
let _gaActive  = false;   // GA initialized + gtag queue installed — safe to send
let _heartbeatTimer = null;

// Stable visitor id (matches js/experiments.js — same localStorage key).
// Read here lazily so we don't import experiments.js (cycle) and so admin
// pages that never load experiments.js still get a non-null value when
// available. Returns null if localStorage is blocked.
function _visitorId() {
    try { return localStorage.getItem('pp_vid') || null; } catch (_) { return null; }
}

// Lazy import of telemetry to forward analytics failures upstream.
// Cached so we never re-import on retry storms. Loading telemetry has
// no side effects beyond its own auto-init, which is idempotent.
let _telemetryPromise = null;
function _getTelemetry() {
    if (!_telemetryPromise) {
        _telemetryPromise = import('./telemetry.js')
            .then(m => m.telemetry)
            .catch(() => null);
    }
    return _telemetryPromise;
}
async function _reportAnalyticsFailure(source, err) {
    try {
        const t = await _getTelemetry();
        if (t) t.recordError(err, { source: `analytics.${source}` });
    } catch { /* never throw from a reporter */ }
}

// ── GA4 Loader ───────────────────────────────────────────────────────────────

function _initGA() {
    if (!GA_MEASUREMENT_ID || _gaActive) return;

    window.dataLayer = window.dataLayer || [];
    window.gtag = function() { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_MEASUREMENT_ID, {
        send_page_view: false,
    });
    // The gtag() shim queues into dataLayer; gtag.js replays the queue on
    // load. So sends are safe the moment the queue + config exist — gating
    // on script.onload instead would silently drop every event fired
    // before the async script arrives (page_view, experiment_exposure,
    // landing_view all fire on load, well before that).
    _gaActive = true;

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
        _reportAnalyticsFailure('flush', err);
    }
}

// ── Session heartbeat ────────────────────────────────────────────────────────

async function _heartbeat() {
    if (!_supabase) return;
    _touchSession();
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
        _reportAnalyticsFailure('heartbeat', err);
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
    _touchSession();

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
            visitor_id: _visitorId(),
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
            _touchSession();
            _buffer.push({
                event_type: 'event',
                event_name: 'scroll_depth',
                page_path: window.location.pathname.slice(0, 200),
                page_title: (document.title || '').slice(0, 300),
                session_id: _sessionId,
                user_id: _userId,
                properties: { visitor_id: _visitorId(), milestone: m },
                created_at: new Date().toISOString(),
            });
        }
    }
}

// ── Consent gate ─────────────────────────────────────────────────────────────
// GA4 + Supabase analytics only initialize after the user opts in via the
// cookie-consent banner (window.ppConsent). Until then, _initGA / _initSupabase
// are not called and any events buffered in memory are dropped on consent
// withdrawal. See js/cookie-consent.js.

function _hasAnalyticsConsent() {
    try { return window.ppConsent?.has?.('analytics') === true; } catch (_) { return false; }
}

let _consentInitDone = false;

// ── First-touch emission ─────────────────────────────────────────────────────
// Fires exactly once per session, on the page where the session was minted.
// Buffered like any other event — flushes after consent + Supabase init, or
// is dropped if consent is withdrawn before flush.

let _sessionStartEmitted = false;
function _emitSessionStart() {
    if (_sessionStartEmitted || !_isNewSession || !_firstTouch) return;
    _sessionStartEmitted = true;

    // Keep within the 2KB property cap enforced by event(). The first-touch
    // payload is well under that on its own.
    _buffer.push({
        event_type: 'event',
        event_name: 'session_start',
        page_path: (window.location.pathname || '/').slice(0, 200),
        page_title: (document.title || '').slice(0, 300),
        session_id: _sessionId,
        user_id: _userId,
        properties: { visitor_id: _visitorId(), ..._firstTouch },
        created_at: new Date(_sessionStart).toISOString(),
    });
    _sessionEvents.push({ name: 'session_start', at: _sessionStart, props: { ..._firstTouch } });

    if (_gaActive) {
        // GA4 reserves the `session_start` event name — sending it as a
        // custom event would collide. Mirror under a distinct name so the
        // attribution fields surface in the GA4 explorer too.
        window.gtag('event', 'first_touch', { ..._firstTouch });
    }
}

// ── Core API ─────────────────────────────────────────────────────────────────

class Analytics {
    constructor() {
        const _initIfConsented = () => {
            if (_consentInitDone || !_hasAnalyticsConsent()) return;
            _consentInitDone = true;
            _initGA();
            const supaInit = _initSupabase();
            setInterval(_flush, FLUSH_INTERVAL);
            supaInit.then(() => {
                if (_supabaseReady) {
                    _heartbeat();
                    _heartbeatTimer = setInterval(_heartbeat, HEARTBEAT_INTERVAL);
                }
            });
        };

        // If consent is already on file from a prior session, init now;
        // otherwise wait for the banner to grant it.
        _initIfConsented();
        if (typeof window !== 'undefined') {
            window.addEventListener('pp-consent-changed', e => {
                if (e?.detail?.analytics === true) {
                    _initIfConsented();
                } else if (_consentInitDone && !_hasAnalyticsConsent()) {
                    // Consent withdrawn: stop heartbeat, drop buffered events.
                    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
                    _buffer.splice(0, _buffer.length);
                }
            });
        }

        if (typeof document !== 'undefined') {
            // Auto-fire page() exactly once per import. Manually-instrumented
            // pages can still call page() with a custom name; subsequent calls
            // are accepted (and sent) so a manual call after the auto one
            // upgrades the name without losing the auto event.
            const autoFire = () => {
                if (_autoPaged) return;
                _autoPaged = true;
                _pageStart = Date.now();
                _emitSessionStart();
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
                        visitor_id: _visitorId(),
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
        _touchSession();
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
            properties: { visitor_id: _visitorId(), ...props },
            created_at: new Date().toISOString(),
        };

        _sessionEvents.push(event);
        _buffer.push(event);

        if (_gaActive) {
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
        _touchSession();
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
            properties: { visitor_id: _visitorId(), ...safeProps },
            created_at: new Date().toISOString(),
        };

        _sessionEvents.push(event);
        _buffer.push(event);

        if (_gaActive) {
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

        if (_gaActive) {
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

    /**
     * First-touch attribution snapshot captured when this session was minted.
     * Stable for the life of the session (sessionStorage-backed). Returns null
     * if the session predates this instrumentation. Consumers (auth-funnel,
     * experiments) should attach the relevant subset to their own events so
     * we can slice retention / conversion by acquisition source.
     */
    getAttribution() {
        return _firstTouch ? { ..._firstTouch } : null;
    }

    /** Get GA4 config status. */
    getGAStatus() {
        return {
            configured: !!GA_MEASUREMENT_ID,
            measurementId: GA_MEASUREMENT_ID || null,
            active: _gaActive,
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
