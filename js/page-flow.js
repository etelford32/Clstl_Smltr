/**
 * page-flow.js — site-wide visitor-flow instrumentation (DOM shell).
 *
 * Emits exactly two client_telemetry events per pageview through the
 * consent-exempt operational pipeline (kind 'page_flow', 100% sampled):
 *
 *   enter — on load: { phase:'enter', pv, ref, landing, device, visitor_id }
 *   exit  — on pagehide / first hide: { phase:'exit', pv, dwell_s,
 *           visible_s, active_s, clicks, scroll_pct, exit_to, visitor_id }
 *
 * Why consent-exempt: the cookie-consent banner converts at ~2 %
 * (1,722 prompts → 29 decisions, July 2026), so the consent-gated
 * analytics_events pipeline structurally cannot answer "where do
 * visitors bounce". This stream carries no PII, no fingerprint, no IP,
 * pathname-only pages, origin-only external referrers — the same
 * first-party operational-telemetry posture as the auth funnel
 * (ANALYTICS.md §5 documents the justification and the rollback lever).
 *
 * Loaded by nav.js on every page that mounts the nav (all ~72 pages).
 * All logic lives in js/page-flow-core.js (pure, node-tested by
 * tests/page-flow.mjs); this file only wires browser events.
 *
 * Server side: supabase-page-flow-migration.sql adds the kind to the
 * CHECK + RPC whitelist and ships the reporting RPCs the admin
 * Visitor Flow card reads. Events sent before that migration runs are
 * silently skipped by the RPC (same roll-forward story as recordFeature).
 */

import { telemetry } from './telemetry.js';
import {
    makePvId, buildEnter, buildExit, shouldRefreshExit, EngagementTracker,
} from './page-flow-core.js';

// Same persistent anonymous id the funnel / experiments / analytics use
// (localStorage 'pp_vid'). Read-or-create so whichever module runs first
// mints it; degrade to null when localStorage is blocked.
function visitorId() {
    try {
        const KEY = 'pp_vid';
        let id = localStorage.getItem(KEY);
        if (id) return id;
        id = (crypto?.randomUUID) ? crypto.randomUUID()
            : ('f_' + Math.random().toString(36).slice(2) + Date.now().toString(36));
        localStorage.setItem(KEY, id);
        return id;
    } catch { return null; }
}

let _booted = false;

function boot() {
    if (_booted) return;
    _booted = true;

    const now = () => Date.now();
    const pv  = makePvId();
    const vid = visitorId();

    const tracker = new EngagementTracker(now(), {
        visible: document.visibilityState !== 'hidden',
    });

    // ── enter ────────────────────────────────────────────────────────
    telemetry.recordFlow('enter', buildEnter({
        pv,
        referrer:  document.referrer || '',
        origin:    window.location.origin,
        viewportW: window.innerWidth || 0,
        visitorId: vid,
    }));

    // ── engagement listeners (all passive) ───────────────────────────
    let maxScrollPct = 0;
    let scrollTimer  = null;
    window.addEventListener('scroll', () => {
        tracker.activity(now());
        if (scrollTimer) return;
        scrollTimer = setTimeout(() => {
            scrollTimer = null;
            try {
                const doc = document.documentElement;
                const scrollable = (doc.scrollHeight - window.innerHeight) || 1;
                const pct = Math.round((window.scrollY / scrollable) * 100);
                if (pct > maxScrollPct) maxScrollPct = Math.min(100, Math.max(0, pct));
            } catch { /* ignore */ }
        }, 200);
    }, { passive: true });

    ['pointermove', 'wheel', 'touchmove'].forEach(t =>
        window.addEventListener(t, () => tracker.activity(now()), { passive: true, capture: true }));
    ['pointerdown', 'keydown'].forEach(t =>
        window.addEventListener(t, () => tracker.interact(now()), { passive: true, capture: true }));

    document.addEventListener('visibilitychange', () => {
        tracker.setVisible(document.visibilityState !== 'hidden', now());
    });

    // Last same-origin link clicked — becomes exit_to when the page
    // unloads shortly after (the completed edge is re-derived from the
    // NEXT page's enter.ref; exit_to additionally catches clicks whose
    // destination never finished loading).
    let lastLinkClick = null;
    document.addEventListener('click', (e) => {
        try {
            const a = e.target?.closest?.('a[href]');
            if (!a) return;
            const u = new URL(a.getAttribute('href'), window.location.href);
            if (u.origin === window.location.origin) {
                lastLinkClick = { path: u.pathname || '/', t: now() };
            }
        } catch { /* ignore */ }
    }, { passive: true, capture: true });

    // ── exit ─────────────────────────────────────────────────────────
    // Sent on pagehide AND on first tab-hide (mobile Safari can kill a
    // backgrounded tab without pagehide). If the user comes back and
    // meaningfully re-engages, a refreshed exit ships with the same pv;
    // the reporting RPCs keep the max-dwell exit per pv, so refreshes
    // only improve accuracy.
    let sentSnapshot = null;
    const sendExit = () => {
        const t = now();
        const snap = tracker.snapshot(t);
        if (sentSnapshot && !shouldRefreshExit(sentSnapshot, snap)) return;
        sentSnapshot = snap;
        telemetry.recordFlow('exit', buildExit({
            pv, snapshot: snap, maxScrollPct, lastLinkClick, t, visitorId: vid,
        }));
        telemetry.flush();   // beacon out now — the page may be gone next tick
    };

    window.addEventListener('pagehide', sendExit);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') sendExit();
    });
}

try { boot(); } catch { /* flow instrumentation must never break a page */ }
