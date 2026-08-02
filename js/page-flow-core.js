/**
 * page-flow-core.js — PURE logic for the site-wide visitor-flow pipeline.
 *
 * No DOM, no imports, no ambient time — every function takes its inputs
 * explicitly so `node tests/page-flow.mjs` can exercise all of it. The
 * DOM shell that wires this to real pages is js/page-flow.js; keep any
 * new browser-API touch there, not here.
 *
 * The pipeline this feeds (client_telemetry.kind = 'page_flow') exists
 * because the consent-gated analytics_events pipeline sees only the
 * ~2 % of visitors who interact with the cookie banner — measured in
 * July 2026: 1,722 consent prompts shown, 29 decisions. Full-population
 * flow/bounce/engagement therefore rides the consent-exempt operational
 * stream, under the same privacy floor as the auth funnel (see
 * ANALYTICS.md §5): no PII, no fingerprinting, pathname-only pages,
 * origin-only external referrers, first-party only.
 */

/** Gap between input events that still counts as continuous activity. */
export const ACTIVE_WINDOW_MS = 10_000;

/** Seconds below which a single-page session counts as a hard bounce. */
export const HARD_BOUNCE_DWELL_S = 15;

/** An internal link click within this window before exit = navigation. */
export const EXIT_CLICK_WINDOW_MS = 5_000;

/** Extra active seconds after a sent exit that justify a refreshed one. */
export const EXIT_REFRESH_MIN_ACTIVE_S = 5;

/**
 * Random per-pageview id. Joins an enter event to its exit event(s)
 * server-side. Not a tracking surface: scoped to one page load, never
 * persisted.
 */
export function makePvId(rand = Math.random) {
    return rand().toString(36).slice(2, 10).padEnd(8, '0');
}

/**
 * Classify document.referrer against the page's own origin.
 *
 * Internal referrers keep their pathname (that IS the from→to edge the
 * transitions RPC reconstructs — it survives tab boundaries, unlike
 * session ordering). External referrers collapse to origin, same as the
 * auth funnel. A landing is any enter that did NOT come from an
 * internal page: external referrer, direct/typed, or unparseable.
 *
 * @param {string} referrer   document.referrer ('' when absent)
 * @param {string} origin     window.location.origin
 * @returns {{ref: string|null, landing: 0|1}}
 */
export function classifyRef(referrer, origin) {
    if (!referrer) return { ref: null, landing: 1 };
    try {
        const u = new URL(referrer);
        if (u.origin === origin) {
            return { ref: (u.pathname || '/').slice(0, 200), landing: 0 };
        }
        return { ref: u.origin.slice(0, 200), landing: 1 };
    } catch {
        return { ref: null, landing: 1 };
    }
}

/**
 * Coarse device class from viewport width. Mirrors the auth funnel's
 * 720 px cut (auth-funnel.js captureContext) rather than analytics.js's
 * three-way split so the two consent-exempt pipelines agree.
 */
export function deviceClass(viewportW) {
    return (viewportW || 0) < 720 ? 'mobile' : 'desktop';
}

/**
 * Engagement accumulator with an injected clock.
 *
 * Tracks three distinct times:
 *   dwell   — wall-clock since construction (t - t0)
 *   visible — time the page was actually foregrounded
 *   active  — input-derived engaged time: the sum of inter-activity
 *             gaps shorter than ACTIVE_WINDOW_MS. Watching passively
 *             counts toward visible but not active; a background tab
 *             counts toward neither.
 *
 * All times in ms internally; snapshot() rounds to whole seconds.
 */
export class EngagementTracker {
    /**
     * @param {number} t0  Construction timestamp (ms).
     * @param {{visible?: boolean, activeWindowMs?: number}} [opts]
     */
    constructor(t0, opts = {}) {
        this._t0           = t0;
        this._windowMs     = opts.activeWindowMs ?? ACTIVE_WINDOW_MS;
        this._visibleSince = (opts.visible ?? true) ? t0 : null;
        this._visibleMs    = 0;
        this._activeMs     = 0;
        this._lastActivity = null;
        this._clicks       = 0;
    }

    /** Input activity (pointer, key, wheel, scroll) at time t. */
    activity(t) {
        if (this._visibleSince === null) return;   // background input = noise
        if (this._lastActivity !== null) {
            const gap = t - this._lastActivity;
            if (gap > 0 && gap < this._windowMs) this._activeMs += gap;
        }
        this._lastActivity = t;
    }

    /** A discrete interaction (pointerdown / keydown) at time t. */
    interact(t) {
        this._clicks += 1;
        this.activity(t);
    }

    /** Visibility transition at time t. */
    setVisible(visible, t) {
        if (visible && this._visibleSince === null) {
            this._visibleSince = t;
            this._lastActivity = null;   // don't bridge activity across a hide
        } else if (!visible && this._visibleSince !== null) {
            this._visibleMs   += Math.max(0, t - this._visibleSince);
            this._visibleSince = null;
            this._lastActivity = null;
        }
    }

    /** Current totals at time t. Does not mutate accrual state. */
    snapshot(t) {
        let visibleMs = this._visibleMs;
        if (this._visibleSince !== null) visibleMs += Math.max(0, t - this._visibleSince);
        return {
            dwell_s:   Math.max(0, Math.round((t - this._t0) / 1000)),
            visible_s: Math.max(0, Math.round(visibleMs / 1000)),
            active_s:  Math.max(0, Math.round(this._activeMs / 1000)),
            clicks:    this._clicks,
        };
    }
}

/**
 * Build the enter-event metadata payload.
 *
 * @param {{pv: string, referrer: string, origin: string, viewportW: number,
 *          visitorId: string|null}} p
 */
export function buildEnter(p) {
    const { ref, landing } = classifyRef(p.referrer, p.origin);
    return {
        phase:   'enter',
        pv:      p.pv,
        ref,
        landing,
        device:  deviceClass(p.viewportW),
        ...(p.visitorId ? { visitor_id: p.visitorId } : {}),
    };
}

/**
 * Build the exit-event metadata payload.
 *
 * exitTo is included only when the last same-origin link click happened
 * within EXIT_CLICK_WINDOW_MS of the exit — an old click followed by
 * minutes of reading is not the navigation that ended this pageview.
 *
 * @param {{pv: string, snapshot: {dwell_s:number, visible_s:number,
 *          active_s:number, clicks:number}, maxScrollPct: number,
 *          lastLinkClick: {path: string, t: number}|null, t: number,
 *          visitorId: string|null}} p
 */
export function buildExit(p) {
    const linkFresh = p.lastLinkClick
        && (p.t - p.lastLinkClick.t) >= 0
        && (p.t - p.lastLinkClick.t) < EXIT_CLICK_WINDOW_MS;
    return {
        phase:      'exit',
        pv:         p.pv,
        dwell_s:    p.snapshot.dwell_s,
        visible_s:  p.snapshot.visible_s,
        active_s:   p.snapshot.active_s,
        clicks:     p.snapshot.clicks,
        scroll_pct: Math.max(0, Math.min(100, Math.round(p.maxScrollPct || 0))),
        exit_to:    linkFresh ? p.lastLinkClick.path.slice(0, 200) : null,
        ...(p.visitorId ? { visitor_id: p.visitorId } : {}),
    };
}

/**
 * Should a refreshed exit be sent? True when the page came back from a
 * hidden state and accrued materially more engagement than the exit we
 * already shipped. The server keeps the max-dwell exit per pv, so a
 * refresh strictly improves accuracy and never double-counts.
 *
 * @param {{active_s: number}} sentSnapshot   snapshot at the sent exit
 * @param {{active_s: number}} nowSnapshot    snapshot now
 */
export function shouldRefreshExit(sentSnapshot, nowSnapshot) {
    if (!sentSnapshot) return false;
    return (nowSnapshot.active_s - sentSnapshot.active_s) >= EXIT_REFRESH_MIN_ACTIVE_S;
}
