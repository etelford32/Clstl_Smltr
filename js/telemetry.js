/**
 * telemetry.js — Client telemetry: errors, auth failures, 404s,
 * redirects, Web Vitals, and app-specific perf marks.
 *
 * One singleton instance per page load, batches events, ships them to
 * /api/telemetry/log via navigator.sendBeacon (fire-and-forget across
 * page navigations) or fetch with keepalive as a fallback.
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ telemetry.recordError(err)         → kind: 'error'      │
 *   │ telemetry.recordAuthFailure(...)   → kind: 'auth_failure'│
 *   │ telemetry.record404(path)          → kind: 'not_found'  │
 *   │ telemetry.recordRedirect(from,to)  → kind: 'redirect'   │
 *   │ telemetry.recordVital(name, val)   → kind: 'web_vital'  │
 *   │ telemetry.recordPerf(name, ms)     → kind: 'app_perf'   │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Autocapture (no caller required):
 *   * window.onerror                   → recordError
 *   * unhandledrejection               → recordError
 *   * PerformanceObserver (LCP/FCP/CLS/INP) → recordVital
 *
 * Privacy:
 *   * URLs are pathname-only (?query stripped)
 *   * Stack traces redact email-like + JWT-like substrings
 *   * No cookies, no IP (the edge function logs IP separately if needed)
 *
 * Sampling:
 *   * Errors / auth_failure / not_found / redirect: 100%
 *   * web_vital / app_perf: 25% (controlled by VITAL_SAMPLE_RATE)
 *
 * Usage from any page:
 *   <script type="module">
 *     import { telemetry } from './js/telemetry.js';
 *     telemetry.init();   // safe to call multiple times
 *   </script>
 */

const ENDPOINT          = '/api/telemetry/log';
const BATCH_MAX         = 20;            // events per flush
const FLUSH_INTERVAL_MS = 5000;          // periodic flush
const VITAL_SAMPLE_RATE = 0.25;          // 25% of page loads send vitals
const SESSION_KEY       = 'pp_telemetry_session';

// Patterns scrubbed from any string field before sending.
// Order matters — apply tighter patterns (email) before looser ones (long base64).
const SCRUB_PATTERNS = [
    [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[email]'],
    [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '[jwt]'],
    [/sk_(live|test)_[A-Za-z0-9]{20,}/g, '[stripe-secret]'],
    [/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]'],
];

function scrub(s) {
    if (typeof s !== 'string') return s;
    let out = s;
    for (const [re, repl] of SCRUB_PATTERNS) out = out.replace(re, repl);
    return out;
}

/**
 * Pathname only — never include query string or hash. Both can carry
 * tokens (?token=xxx) or PII (?email=xxx) and we don't want them in
 * telemetry rows the superadmin will browse.
 */
function safeRoute(href = window.location.href) {
    try {
        const u = new URL(href, window.location.origin);
        return u.pathname || '/';
    } catch {
        return '/';
    }
}

/**
 * Stable hash for grouping similar errors. Combines the message
 * (without dynamic parts), top stack frame's function name, and the
 * error type. Two identical errors from different page loads should
 * collapse to the same fingerprint.
 */
function fingerprintError(message, stack, kind = 'E') {
    const msg = String(message || '')
        .replace(/0x[a-f0-9]+/gi, '0x*')   // memory addresses
        .replace(/\d{4,}/g, '*')           // timestamps, UUIDs (partial)
        .slice(0, 80);
    let frame = '';
    if (stack) {
        // Match the first non-anonymous frame: "at functionName ("
        const m = String(stack).match(/at\s+([A-Za-z_$][A-Za-z0-9_$.]+)\s*\(/);
        frame = m ? m[1].slice(0, 40) : '';
    }
    return `${kind}:${msg}:${frame}`;
}

function getOrCreateSessionId() {
    try {
        let id = sessionStorage.getItem(SESSION_KEY);
        if (id) return id;
        id = crypto.randomUUID
            ? crypto.randomUUID()
            : ('s_' + Math.random().toString(36).slice(2) + Date.now().toString(36));
        sessionStorage.setItem(SESSION_KEY, id);
        return id;
    } catch {
        return null;
    }
}

class Telemetry {
    constructor() {
        this._initted    = false;
        this._queue      = [];
        this._flushTimer = null;
        this._sessionId  = null;
        this._sendVitals = false;
        this._jwt        = null;     // set lazily; keeps us off the auth.js critical path
    }

    /**
     * Idempotent — safe to call from every page entry point. Auth
     * pages call it before any auth machinery so pre-signin errors are
     * captured.
     */
    init() {
        if (this._initted) return;
        this._initted    = true;
        this._sessionId  = getOrCreateSessionId();
        this._sendVitals = Math.random() < VITAL_SAMPLE_RATE;

        this._installAutocapture();
        this._installFlushTriggers();
        if (this._sendVitals) {
            // Navigation timing has no PerformanceObserver dependency
            // (just reads the navigation entry from `performance`), so
            // it stays separate from the vitals observer wiring. Both
            // are gated by the same 25% sample so they share volume.
            this._installNavigationObserver();
            this._installVitalsObserver();
        }
    }

    /** Set the JWT once available so server-side rows attach to a user_id. */
    setUserToken(jwt) {
        this._jwt = jwt || null;
    }

    // ── Public recording API ─────────────────────────────────────────

    recordError(err, ctx = {}) {
        const message = err?.message || String(err || 'Unknown error');
        const stack   = scrub(err?.stack || '');
        const fingerprint = fingerprintError(message, stack, ctx.fingerprintKind || 'E');
        this._enqueue({
            kind:     'error',
            severity: 'error',
            metadata: {
                fingerprint,
                message:  scrub(message).slice(0, 256),
                stack:    stack.slice(0, 2000),
                source:   ctx.source || 'window',
                ...(ctx.extra || {}),
            },
        });
    }

    recordAuthFailure(reason, opts = {}) {
        this._enqueue({
            kind:     'auth_failure',
            severity: 'warning',
            metadata: {
                reason:   scrub(String(reason || 'unknown')).slice(0, 200),
                source:   opts.source || 'unknown',
                provider: opts.provider || null,
                code:     opts.code || null,
            },
        });
    }

    record404(path = window.location.pathname, ctx = {}) {
        this._enqueue({
            kind:     'not_found',
            severity: 'info',
            route:    safeRoute(path),
            metadata: {
                referrer: ctx.referrer || (document.referrer ? safeRoute(document.referrer) : null),
            },
        });
    }

    recordRedirect(from, to, reason = 'unauthenticated') {
        this._enqueue({
            kind:     'redirect',
            severity: 'info',
            metadata: {
                from:   safeRoute(from),
                to:     safeRoute(to),
                reason,
            },
        });
    }

    recordVital(name, value, rating = null) {
        if (!this._sendVitals) return;
        this._enqueue({
            kind:     'web_vital',
            severity: 'info',
            metadata: {
                name,
                value:  Number(value.toFixed ? value.toFixed(2) : value),
                rating: rating || ratingFor(name, value),
            },
        });
    }

    recordPerf(name, ms) {
        // App perf is sampled at the same rate as vitals — same volume profile.
        if (!this._sendVitals) return;
        this._enqueue({
            kind:     'app_perf',
            severity: 'info',
            metadata: {
                name:  String(name).slice(0, 80),
                value: Number(ms.toFixed ? ms.toFixed(2) : ms),
            },
        });
    }

    // ── Internals ───────────────────────────────────────────────────

    _enqueue(event) {
        try {
            event.route      = event.route || safeRoute();
            event.session_id = this._sessionId;
            this._queue.push(event);
            if (this._queue.length >= BATCH_MAX) this.flush();
        } catch {
            // Telemetry must never throw into the calling code.
        }
    }

    flush() {
        if (!this._queue.length) return;
        const batch = this._queue.splice(0, this._queue.length);
        const body = JSON.stringify({ events: batch });
        // Prefer sendBeacon — survives page navigation, returns immediately.
        // Fallback to fetch with keepalive when beacon unavailable or
        // body exceeds 64 KB (the spec floor; browsers vary).
        try {
            if (navigator.sendBeacon && body.length < 60_000) {
                const blob = new Blob([body], { type: 'application/json' });
                const ok = navigator.sendBeacon(ENDPOINT, blob);
                if (ok) return;
            }
        } catch { /* fall through to fetch */ }
        try {
            fetch(ENDPOINT, {
                method:  'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(this._jwt ? { Authorization: `Bearer ${this._jwt}` } : {}),
                },
                body,
                keepalive: true,
            }).catch(() => { /* fire-and-forget */ });
        } catch { /* swallow */ }
    }

    _installAutocapture() {
        window.addEventListener('error', (ev) => {
            // Filter cross-origin script errors (no useful info we can act on).
            if (ev.message === 'Script error.' && !ev.error) return;
            this.recordError(ev.error || ev.message, {
                source: 'window.onerror',
                extra: {
                    line: ev.lineno || null,
                    col:  ev.colno  || null,
                    file: ev.filename ? safeRoute(ev.filename) : null,
                },
            });
        });

        window.addEventListener('unhandledrejection', (ev) => {
            this.recordError(ev.reason, {
                source: 'unhandledrejection',
                fingerprintKind: 'P',
            });
        });
    }

    _installFlushTriggers() {
        // Periodic flush.
        this._flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);

        // Page-hide is the right hook for "user is leaving" — fires for
        // both bfcache and full unload, unlike unload which is unreliable
        // on mobile. visibilitychange is a backup for mobile Safari.
        const onLeave = () => this.flush();
        window.addEventListener('pagehide', onLeave);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.flush();
        });
    }

    /**
     * Per-route page-load timing from PerformanceNavigationTiming.
     * Captures the breakdown of where each page-load second went:
     *   * TTFB         — request → first byte (server + network)
     *   * DOM_READY    — first byte → DOMContentLoaded fire
     *   * PAGE_LOAD    — request → load event (full doc + subresources)
     *
     * The navigation entry is available immediately after the load
     * event fires (it's buffered, so we read it on the next tick to
     * avoid racing the entry list). One-shot per page load.
     */
    _installNavigationObserver() {
        const capture = () => {
            try {
                const nav = performance.getEntriesByType('navigation')[0];
                if (!nav) return;
                const ttfb = nav.responseStart - nav.requestStart;
                const dom  = nav.domContentLoadedEventEnd - nav.responseEnd;
                const load = nav.loadEventEnd - nav.startTime;
                if (ttfb > 0)  this.recordVital('TTFB',      ttfb);
                if (dom  > 0)  this.recordVital('DOM_READY', dom);
                if (load > 0)  this.recordVital('PAGE_LOAD', load);
            } catch { /* not supported / partial entry */ }
        };
        if (document.readyState === 'complete') {
            // Page already loaded by the time we got here (rare; happens on
            // bfcache restore or very fast modules). Defer one tick so the
            // entry's loadEventEnd is settled.
            setTimeout(capture, 0);
        } else {
            window.addEventListener('load', () => setTimeout(capture, 0), { once: true });
        }
    }

    _installVitalsObserver() {
        if (typeof PerformanceObserver !== 'function') return;

        // LCP — Largest Contentful Paint. Only the LAST entry counts;
        // earlier ones are superseded as larger elements paint. Disconnect
        // observer at first user input or pagehide to lock in the value.
        try {
            let lastLcp = 0;
            const lcpObs = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    lastLcp = entry.renderTime || entry.loadTime || entry.startTime;
                }
            });
            lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
            const lockLcp = () => {
                if (lastLcp > 0) this.recordVital('LCP', lastLcp);
                try { lcpObs.disconnect(); } catch {}
            };
            ['pointerdown','keydown','pagehide'].forEach(t =>
                window.addEventListener(t, lockLcp, { once: true, capture: true }));
        } catch { /* not supported */ }

        // FCP — First Contentful Paint. Single entry, fires once.
        try {
            const fcpObs = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (entry.name === 'first-contentful-paint') {
                        this.recordVital('FCP', entry.startTime);
                        try { fcpObs.disconnect(); } catch {}
                    }
                }
            });
            fcpObs.observe({ type: 'paint', buffered: true });
        } catch { /* not supported */ }

        // CLS — Cumulative Layout Shift. Sum across the page lifetime,
        // excluding shifts within 500 ms of user input.
        try {
            let cls = 0;
            const clsObs = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (!entry.hadRecentInput) cls += entry.value;
                }
            });
            clsObs.observe({ type: 'layout-shift', buffered: true });
            window.addEventListener('pagehide', () => {
                this.recordVital('CLS', cls);
                try { clsObs.disconnect(); } catch {}
            }, { once: true });
        } catch { /* not supported */ }

        // INP — Interaction to Next Paint. Approximate via event-timing
        // duration; report worst observed value at pagehide.
        try {
            let worstInp = 0;
            const inpObs = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (entry.duration > worstInp) worstInp = entry.duration;
                }
            });
            inpObs.observe({ type: 'event', buffered: true, durationThreshold: 16 });
            window.addEventListener('pagehide', () => {
                if (worstInp > 0) this.recordVital('INP', worstInp);
                try { inpObs.disconnect(); } catch {}
            }, { once: true });
        } catch { /* not supported */ }
    }
}

// Web-Vitals canonical thresholds (https://web.dev/vitals/).
function ratingFor(name, value) {
    switch (name) {
        case 'LCP': return value <= 2500 ? 'good' : value <= 4000 ? 'ni' : 'poor';
        case 'FCP': return value <= 1800 ? 'good' : value <= 3000 ? 'ni' : 'poor';
        case 'INP': return value <= 200  ? 'good' : value <= 500  ? 'ni' : 'poor';
        case 'CLS': return value <= 0.1  ? 'good' : value <= 0.25 ? 'ni' : 'poor';
        default:    return null;
    }
}

export const telemetry = new Telemetry();

// Auto-init on first import. Pages that need to install the JWT
// (auth.js) call telemetry.setUserToken(jwt) explicitly afterward.
telemetry.init();
