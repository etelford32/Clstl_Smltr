/**
 * auth-funnel.js — intro / sign-in / sign-up funnel instrumentation
 *
 * One singleton that bridges the auth pages to client_telemetry's
 * auth_funnel kind. Two responsibilities:
 *
 *   1. Manage a per-tab funnel_id (sessionStorage UUID) so a user's
 *      stages stitch together server-side via the funnel_id metadata key.
 *   2. Capture the once-per-funnel context (referrer origin, UTM tags,
 *      viewport, locale, page URL) on the first step() call and emit it
 *      with that step. Subsequent steps carry only their own props.
 *
 * Privacy posture: no PII, no email, no full UA, no IP. UTM values are
 * truncated to 80 chars. Referrer collapses to its origin.
 *
 * Usage:
 *   import { funnel } from './js/auth-funnel.js';
 *   funnel.step('signin_view');
 *   funnel.step('signin_method_selected', { method: 'magic_link' });
 *   funnel.step('signin_succeeded', { method: 'password', retry_count: 1 });
 *
 * Stage names: see supabase-auth-funnel-migration.sql, the stages CTE.
 */

import { telemetry } from './telemetry.js';

const FUNNEL_ID_KEY    = 'pp_funnel_id';
const FUNNEL_START_KEY = 'pp_funnel_start';
const FUNNEL_META_KEY  = 'pp_funnel_meta_sent';

function makeFunnelId() {
    try {
        if (crypto?.randomUUID) return crypto.randomUUID();
    } catch {}
    return 'f_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getOrCreateFunnelId() {
    try {
        let id = sessionStorage.getItem(FUNNEL_ID_KEY);
        if (id) return id;
        id = makeFunnelId();
        sessionStorage.setItem(FUNNEL_ID_KEY, id);
        sessionStorage.setItem(FUNNEL_START_KEY, String(Date.now()));
        return id;
    } catch {
        return makeFunnelId();
    }
}

function getFunnelStartMs() {
    try {
        const v = +sessionStorage.getItem(FUNNEL_START_KEY) || Date.now();
        return v;
    } catch { return Date.now(); }
}

function safeReferrerOrigin() {
    try {
        if (!document.referrer) return null;
        return new URL(document.referrer).origin;
    } catch { return null; }
}

function captureUtm() {
    try {
        const p = new URLSearchParams(window.location.search);
        const out = {};
        for (const k of ['utm_source','utm_medium','utm_campaign','utm_term','utm_content']) {
            const v = p.get(k);
            if (v) out[k] = v.slice(0, 80);
        }
        return Object.keys(out).length ? out : null;
    } catch { return null; }
}

function captureContext() {
    return {
        // Pathname only — query strings can carry tokens we never want
        // in operational telemetry. Hash is irrelevant here.
        page:        (window.location.pathname || '/').slice(0, 200),
        referrer:    safeReferrerOrigin(),
        utm:         captureUtm(),
        viewport:    { w: window.innerWidth || 0, h: window.innerHeight || 0 },
        locale:      (navigator.language || '').slice(0, 16),
        // Coarse device class — not a fingerprint, just a "mobile vs
        // desktop" signal for the conversion-rate breakdown.
        device:      (window.innerWidth || 0) < 720 ? 'mobile' : 'desktop',
        // Whether the user has agreed to the analytics cookie category
        // at funnel-start time. Helpful for explaining gaps between
        // client_telemetry funnel volume and analytics_events volume.
        consent:     (() => {
            try { return window.ppConsent?.has?.('analytics') === true ? 'on' : 'off'; }
            catch { return 'unknown'; }
        })(),
    };
}

function isFirstCall() {
    try {
        if (sessionStorage.getItem(FUNNEL_META_KEY) === '1') return false;
        sessionStorage.setItem(FUNNEL_META_KEY, '1');
        return true;
    } catch {
        // Without sessionStorage we can't guarantee single-fire; default
        // to including context so we don't lose attribution data on
        // private-mode browsers. Volume cost is negligible (1 KB/call).
        return true;
    }
}

class AuthFunnel {
    constructor() {
        this._funnelId = null;
    }

    /** Force a fresh funnel_id — used when a user explicitly signs out so
     *  the next sign-in is counted as a separate journey rather than a
     *  continuation of the previous one. */
    reset() {
        try {
            sessionStorage.removeItem(FUNNEL_ID_KEY);
            sessionStorage.removeItem(FUNNEL_START_KEY);
            sessionStorage.removeItem(FUNNEL_META_KEY);
        } catch {}
        this._funnelId = null;
    }

    /** Current funnel id (lazy-initialised). */
    id() {
        if (!this._funnelId) this._funnelId = getOrCreateFunnelId();
        return this._funnelId;
    }

    /**
     * Record a funnel stage. Fire-and-forget — never throws.
     *
     * @param {string} stage     Canonical stage name.
     * @param {object} [props]   Stage-specific metadata.
     */
    step(stage, props = {}) {
        try {
            const fid     = this.id();
            const startMs = getFunnelStartMs();
            const baseMeta = {
                funnel_id:           fid,
                t_since_landing_ms:  Math.max(0, Date.now() - startMs),
                ...props,
            };
            if (isFirstCall()) {
                baseMeta.context = captureContext();
            }
            telemetry.recordFunnel(stage, baseMeta);
        } catch {
            // Funnel logging must never disrupt the actual auth flow.
        }
    }

    /**
     * Record a funnel stage on the next idle frame so the call never
     * blocks the UI thread. Use this from event handlers that fire
     * mid-render (e.g. button click that also triggers a redirect).
     */
    stepDeferred(stage, props = {}) {
        const fire = () => this.step(stage, props);
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(fire, { timeout: 1000 });
        } else {
            setTimeout(fire, 0);
        }
    }
}

export const funnel = new AuthFunnel();

// Expose on window for non-module classic <script> blocks (signin.html
// and signup.html have post-module classic scripts that can't `import`).
try {
    if (typeof window !== 'undefined') window.ppFunnel = funnel;
} catch {}
