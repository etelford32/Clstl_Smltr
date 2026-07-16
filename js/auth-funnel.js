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

// Persistent, cross-tab anonymous visitor id. Reuses `pp_vid` — the SAME
// localStorage key js/experiments.js and js/analytics.js already use, so a
// visitor has ONE stable id everywhere rather than a per-surface fork.
// Read-or-create (matches experiments.js visitorId()): whichever module runs
// first mints it, the rest reuse the same value.
//
// Privacy note: unlike funnel_id (per-tab, sessionStorage, un-joinable across
// sessions), this id DOES persist across sessions/tabs — it is what lets the
// funnel answer "has this anonymous visitor bounced before". It is a random
// UUID with no PII. As of the identity-fragmentation fix it is attached to
// EVERY event (top-level `visitor_id` in step()), not just the once-per-funnel
// context block — the context block still carries it too for the Phase-3 RPCs
// that read context->>'visitor_id'. The per-event copy is the join key that
// stitches a visitor's stages across funnel_ids when a tab boundary forks the
// funnel (see step()); the footprint cost is one UUID string per event, and
// funnel volume is small (100% sampled but bounded by the auth flow). If the
// threat model tightens, gate getVisitorId() behind analytics consent in BOTH
// captureContext() and step() — see ANALYTICS.md "Privacy posture".
const VISITOR_ID_KEY = 'pp_vid';
function getVisitorId() {
    try {
        let id = localStorage.getItem(VISITOR_ID_KEY);
        if (id) return id;
        id = makeFunnelId();   // same UUID generator as the funnel id
        localStorage.setItem(VISITOR_ID_KEY, id);
        return id;
    } catch {
        // localStorage blocked (private mode / cookie wall) — degrade to
        // null rather than minting a volatile id that can't persist anyway.
        return null;
    }
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
        // Persistent anonymous id — lets the admin distinguish a first-time
        // visitor from one returning for another attempt (repeat bouncers).
        visitor_id:  getVisitorId(),
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

/**
 * Map a free-text auth error into a small, STABLE category code.
 *
 * Why: the funnel already records the raw `reason` string, but those
 * strings come straight from Supabase / Resend / the browser and their
 * wording drifts over time (and varies by locale). A future "top failure
 * reasons" histogram (flagged in AUTH_FLOW_REVIEW.md) needs a stable key
 * to group by. This is that key. `reason` stays alongside for the human-
 * readable detail; `code` is the machine-groupable bucket.
 *
 * The vocabulary is intentionally tiny and closed. Add a bucket only when
 * a genuinely new failure class appears — resist splitting hairs, or the
 * histogram fragments back into free-text noise. Unmatched errors fall to
 * 'unknown' (still useful: a spike in 'unknown' means a new failure class
 * to name).
 *
 * @param {string|Error|{message?:string}} err
 * @returns {string} snake_case category code
 */
export function classifyAuthError(err) {
    let msg = '';
    try {
        msg = (typeof err === 'string' ? err : (err?.message ?? String(err ?? ''))) || '';
    } catch { msg = ''; }
    const m = msg.toLowerCase();
    if (!m) return 'unknown';
    // Order matters — earlier, more-specific matches win.
    if (/confirm|verify your email|not confirmed|email.*not.*verif/.test(m)) return 'email_not_confirmed';
    if (/already (registered|exists|in use)|user already|email.*taken/.test(m)) return 'email_exists';
    if (/rate limit|too many|429|try again later|temporarily/.test(m)) return 'rate_limited';
    if (/invalid login|invalid email or password|incorrect|bad cred|wrong password|invalid credentials/.test(m)) return 'bad_credentials';
    if (/password/.test(m) && /(short|weak|at least|minimum|6 char|8 char|characters)/.test(m)) return 'weak_password';
    if (/valid email|email.*invalid|invalid.*email|malformed/.test(m)) return 'invalid_email';
    if (/oauth|provider|popup|redirect uri|id token|access token/.test(m)) return 'oauth_error';
    if (/magic|otp|link expired|token expired|expired/.test(m)) return 'link_expired';
    if (/network|failed to fetch|timeout|timed out|offline|connection/.test(m)) return 'network';
    if (/captcha|hcaptcha|recaptcha/.test(m)) return 'captcha';
    if (/disabled|not allowed|forbidden|signups not/.test(m)) return 'not_allowed';
    return 'unknown';
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
            const vid     = getVisitorId();
            const baseMeta = {
                funnel_id:           fid,
                t_since_landing_ms:  Math.max(0, Date.now() - startMs),
                // Persistent visitor_id on EVERY event, not only the
                // once-per-funnel context block. This is the fallback join
                // key: funnel_id is per-tab (sessionStorage), so a tab
                // boundary — landing → signup.html opening in a fresh tab —
                // mints a NEW funnel_id and the CTA→signup handoff can never
                // be stitched by funnel_id alone. visitor_id (localStorage,
                // cross-tab) survives that boundary and lets the RPCs rejoin
                // the two funnels as one visitor. Placed BEFORE ...props so an
                // explicit per-call override still wins; omitted entirely when
                // null (localStorage blocked) so we never write an empty key.
                ...(vid ? { visitor_id: vid } : {}),
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
    if (typeof window !== 'undefined') {
        window.ppFunnel = funnel;
        // Exposed for the post-module classic <script> blocks in
        // signin.html / signup.html that pass a `code` alongside `reason`
        // on *_failed steps but can't `import`.
        window.ppClassifyAuthError = classifyAuthError;
    }
} catch {}
