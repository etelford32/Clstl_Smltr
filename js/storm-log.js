/**
 * storm-log.js — the personal storm log (SPACE_WEATHER_DASHBOARD_PLAN.md
 * §9a, phase D3): a client-side record of every time Kp crossed YOUR
 * threshold line (js/threshold-profile.js) — honesty as a feature: the
 * console remembers what it told you and when.
 *
 * Pure core up top (node-tested by tests/storm-log.mjs): rising-edge
 * crossing detection with hysteresis (a new entry only after Kp has
 * dropped back below the line — one storm episode, one entry, not one
 * entry per sample). Ring buffer, newest first, capped.
 *
 * Storage: localStorage 'sw-storm-log' { below: bool, entries: [...] }.
 * Kp source: the page's #kp-val observer + the swpc-update bus — the
 * same two channels every other consumer uses.
 */

import { loadProfile, CHANGE_EVENT } from './threshold-profile.js';

export const LOG_KEY = 'sw-storm-log';
export const LOG_MAX = 50;

/**
 * Feed one Kp sample into the log. PURE — returns a NEW state.
 * @param {object} state  { below: boolean, entries: [{t, kp, thr}] }
 * @param {number} kp     current Kp
 * @param {number} thr    the user's Kp line
 * @param {number} tMs    sample time
 * @returns {{state: object, crossed: boolean}}
 */
export function feedSample(state, kp, thr, tMs) {
    const s = {
        below: state?.below ?? true,
        entries: Array.isArray(state?.entries) ? state.entries : [],
    };
    if (!Number.isFinite(kp) || !Number.isFinite(thr)) return { state: s, crossed: false };
    if (kp >= thr) {
        if (!s.below) return { state: s, crossed: false };   // still in-episode
        return {
            state: {
                below: false,
                entries: [{ t: tMs, kp: +kp.toFixed(1), thr }, ...s.entries].slice(0, LOG_MAX),
            },
            crossed: true,
        };
    }
    return { state: { ...s, below: true }, crossed: false };
}

/* ── Browser mount (fail-quiet) ───────────────────────────────────────── */

const fmt = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z';

export function mountStormLog(hostId = 'storm-log-body') {
    if (typeof document === 'undefined') return;
    try {
        const host = document.getElementById(hostId);
        if (!host) return;
        let profile = loadProfile();
        let state;
        try { state = JSON.parse(localStorage.getItem(LOG_KEY) || 'null'); } catch {}

        const persist = () => {
            try { localStorage.setItem(LOG_KEY, JSON.stringify(state)); } catch {}
        };
        const render = () => {
            const entries = state?.entries ?? [];
            host.innerHTML = entries.length
                ? entries.slice(0, 12).map((e) => `
                    <div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;
                                border-bottom:1px solid var(--sw-border,rgba(255,255,255,.09));
                                font-size:.72rem">
                        <span style="color:var(--sw-text-muted,#8b94ad)">${fmt(e.t)}</span>
                        <span style="color:var(--sw-status-warning,#ff7847);font-weight:700">
                            Kp ${e.kp} crossed your Kp ${e.thr} line</span>
                    </div>`).join('')
                : `<div style="font-size:.72rem;color:var(--sw-text-dim,#68718a)">
                       No crossings of your Kp ${profile.kp} line yet — quiet sky.
                       Crossings are recorded while this dashboard is open.</div>`;
        };

        const feed = (kp) => {
            const r = feedSample(state, kp, profile.kp, Date.now());
            state = r.state;
            if (r.crossed) { persist(); render(); }
            else persist();
        };

        const kpEl = document.getElementById('kp-val');
        const readKp = () => {
            const v = parseFloat(kpEl?.textContent);
            if (Number.isFinite(v)) feed(v);
        };
        if (kpEl) {
            new MutationObserver(readKp)
                .observe(kpEl, { childList: true, characterData: true, subtree: true });
            readKp();
        }
        window.addEventListener('swpc-update', (e) => {
            const k = e?.detail?.geomagnetic?.kp ?? e?.detail?.kp;
            if (Number.isFinite(k)) feed(k);
        });
        window.addEventListener(CHANGE_EVENT, (e) => {
            profile = e.detail || loadProfile();
            render();
        });
        render();
    } catch (e) {
        console.warn('[storm-log] disabled:', e);
    }
}
