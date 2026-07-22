/**
 * space-weather-status-band.js — the glance-first status band pinned above
 * the space-weather dashboard (SPACE_WEATHER_DASHBOARD_PLAN.md §10, D1).
 *
 * Four cells, one status grammar: storm outlook · CME arrival countdown ·
 * Kp now · tonight at your pin. The grammar is the plan's five-step scale
 * (quiet / elevated / watch / warning / severe), colorblind-safe because
 * every cell carries its state as TEXT — color only reinforces.
 *
 * Oracle discipline: the band COMPUTES NOTHING of its own —
 *   · storm outlook + tier → verdict-engine stormOutlook() (the same
 *     function behind the EarthView verdict card's outlook row),
 *   · tonight-at-pin → verdict-engine auroraVerdict() + magneticLatitude()
 *     (the margin ≤ 5° GO decision lives THERE; see CLAUDE.md §4.4),
 *   · the CME summary → the ONE shared provider result, published by
 *     js/flux-rope-dashboard.js on this page ('flux-rope-forecast' event +
 *     window.__fluxRopeForecast) — never a second ensemble run,
 *   · Kp → the page's existing #kp-val element via MutationObserver (the
 *     UA-card pattern) — never a duplicate fetch.
 *
 * statusBandModel() is PURE (no DOM, no fetch, explicit nowMs) and
 * node-tested by tests/space-weather-status-band.mjs. The mount is
 * fail-quiet: any error leaves the host empty, never a broken page.
 */

import { stormOutlook, magneticLatitude, auroraVerdict, sunAltitudeDeg }
    from './verdict-engine.js';

export const STATUS_RANK = ['quiet', 'elevated', 'watch', 'warning', 'severe'];

const HOUR = 3.6e6;
const isNum = (v) => Number.isFinite(v);

/** Kp → status grammar. Steps at the NOAA G-scale boundaries. */
export function kpStatus(kp) {
    if (!isNum(kp)) return { cls: 'quiet', word: '—' };
    if (kp >= 7) return { cls: 'severe', word: 'G3+ storm' };
    if (kp >= 6) return { cls: 'warning', word: 'G2 storm' };
    if (kp >= 5) return { cls: 'watch', word: 'G1 storm' };
    if (kp >= 4) return { cls: 'elevated', word: 'active' };
    return { cls: 'quiet', word: 'quiet' };
}

/** Deepest sun altitude (°) over the next 24 h at (lat, lon) — the "is
 *  there a dark window tonight" input to auroraVerdict. Half-hour scan. */
export function deepestSunAltitude(lat, lon, nowMs) {
    let min = 90;
    for (let i = 0; i <= 48; i++) {
        const alt = sunAltitudeDeg(lat, lon, new Date(nowMs + i * 30 * 60e3));
        if (alt < min) min = alt;
    }
    return min;
}

const fmtWin = (v) => (isNum(v)
    ? new Date(v).toISOString().slice(5, 16).replace('T', ' ') + 'Z' : '—');

/**
 * Build the four band cells.
 * @param {object} opts
 * @param {object|null|undefined} opts.summary  flux-rope provider summary;
 *        undefined = still computing, null = provider idle (no CME)
 * @param {number|null} opts.kp     current Kp
 * @param {object|null} opts.loc    { lat, lon, city } or null
 * @param {number} opts.nowMs
 * @returns {{cells: Array<{id,label,value,detail,cls}>}}
 */
export function statusBandModel({ summary, kp, loc, nowMs }) {
    const cells = [];

    // 1 ── Storm outlook (tier via the ONE stormOutlook oracle)
    const outlook = summary ? stormOutlook(summary, nowMs) : null;
    if (summary === undefined) {
        cells.push({ id: 'outlook', label: 'Storm outlook', value: '…',
            detail: 'ensemble forecast loading', cls: 'quiet' });
    } else if (!outlook) {
        cells.push({ id: 'outlook', label: 'Storm outlook', value: 'Quiet',
            detail: summary ? 'no storm signal from the ensemble'
                            : 'no Earth-directed CME in the DONKI catalog',
            cls: 'quiet' });
    } else {
        const cls = outlook.tier === 'arriving'
            ? (outlook.state === 'go' ? 'severe' : 'warning')
            : outlook.tier;                       // 'watch' | 'warning'
        const value = outlook.tier === 'arriving' ? 'Arriving'
            : outlook.tier === 'warning' ? 'Warning' : 'Watch';
        cells.push({ id: 'outlook', label: 'Storm outlook', value,
            detail: outlook.desc, cls });
    }

    // 2 ── Arrival countdown
    const p50 = summary?.arrivalP50Ms;
    if (!isNum(p50)) {
        cells.push({ id: 'arrival', label: 'CME arrival', value: '—',
            detail: 'no inbound event', cls: 'quiet' });
    } else {
        const h = (p50 - nowMs) / HOUR;
        const value = h <= 0 ? 'now' : h < 1 ? `T−${Math.max(1, Math.round(h * 60))} min`
            : `T−${Math.round(h)} h`;
        cells.push({ id: 'arrival', label: 'CME arrival (P50)', value,
            detail: `window ${fmtWin(summary.arrivalP10Ms)} – ${fmtWin(summary.arrivalP90Ms)}`,
            cls: cells[0].cls });                 // urgency follows the outlook tier
    }

    // 3 ── Kp now
    const ks = kpStatus(kp);
    cells.push({ id: 'kp', label: 'Kp now', value: isNum(kp) ? String(kp) : '—',
        detail: ks.word, cls: ks.cls });

    // 4 ── Tonight at your pin
    if (!loc || !isNum(loc.lat) || !isNum(loc.lon)) {
        cells.push({ id: 'tonight', label: 'Tonight at your pin', value: '—',
            detail: 'set a location to get an aurora call', cls: 'quiet' });
    } else {
        const mlat = magneticLatitude(loc.lat, loc.lon);
        const v = auroraVerdict(isNum(kp) ? kp : 0, mlat, null,
            deepestSunAltitude(loc.lat, loc.lon, nowMs));
        const value = v.state === 'go' ? 'GO' : v.state === 'maybe' ? 'Maybe' : 'No';
        const cls = v.state === 'go' ? 'warning' : v.state === 'maybe' ? 'elevated' : 'quiet';
        const where = loc.city ? ` · ${loc.city}` : '';
        const oval = v.margin <= 0 ? 'oval overhead'
            : `oval ${Math.round(v.margin)}° poleward`;
        cells.push({ id: 'tonight', label: 'Tonight at your pin', value,
            detail: `${oval}${where}`, cls });
    }

    return { cells };
}

/* ── Mount (fail-quiet, DOM only below this line) ─────────────────────── */

const CSS = `
#sw-status-band { display: grid; grid-template-columns: repeat(4, 1fr);
    gap: var(--sw-gap, 12px); margin: 0 0 14px; }
.swb-cell { background: var(--sw-surface-card, rgba(10,16,34,.66));
    border: 1px solid var(--sw-border, rgba(255,255,255,.09));
    border-left: 3px solid var(--swb-c, var(--sw-status-quiet, #4fc97f));
    border-radius: var(--sw-radius, 10px); padding: 9px 12px; min-width: 0; }
.swb-label { font-size: .6rem; font-weight: 700; letter-spacing: .09em;
    text-transform: uppercase; color: var(--sw-text-muted, #8b94ad); }
.swb-value { font-size: 1.15rem; font-weight: 800; line-height: 1.3;
    color: var(--swb-c, var(--sw-status-quiet, #4fc97f));
    font-variant-numeric: tabular-nums; }
.swb-detail { font-size: .64rem; color: var(--sw-text-dim, #68718a);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.swb-cell.quiet    { --swb-c: var(--sw-status-quiet, #4fc97f); }
.swb-cell.elevated { --swb-c: var(--sw-status-elevated, #ffd75e); }
.swb-cell.watch    { --swb-c: var(--sw-status-watch, #ffaa22); }
.swb-cell.warning  { --swb-c: var(--sw-status-warning, #ff7847); }
.swb-cell.severe   { --swb-c: var(--sw-status-severe, #ff4466); }
@media (max-width: 768px) {
    #sw-status-band { grid-template-columns: repeat(2, 1fr);
        position: sticky; top: 0; z-index: 500; }
    .swb-cell { background: var(--sw-surface-raised, rgba(16,24,48,.9)); }
}
`;

export function mountStatusBand(hostId = 'sw-status-band') {
    if (typeof document === 'undefined') return;
    try {
        const host = document.getElementById(hostId);
        if (!host) return;
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        // State — each source updates independently, every update re-renders.
        let summary;                       // undefined = pending
        let kp = null;
        let loc = null;

        const render = () => {
            const { cells } = statusBandModel({ summary, kp, loc, nowMs: Date.now() });
            host.innerHTML = cells.map((c) => `
                <div class="swb-cell ${c.cls}" data-cell="${c.id}">
                    <div class="swb-label">${c.label}</div>
                    <div class="swb-value">${c.value}</div>
                    <div class="swb-detail" title="${c.detail.replace(/"/g, '&quot;')}">${c.detail}</div>
                </div>`).join('');
        };

        // Kp from the page's #kp-val (UA-card MutationObserver pattern).
        const kpEl = document.getElementById('kp-val');
        const readKp = () => {
            const v = parseFloat(kpEl?.textContent);
            if (Number.isFinite(v)) { kp = v; render(); }
        };
        if (kpEl) {
            new MutationObserver(readKp)
                .observe(kpEl, { childList: true, characterData: true, subtree: true });
            readKp();
        }

        // Forecast summary from the shared provider run (flux-rope-dashboard
        // publishes it). fc.idle → null (definitively quiet).
        const takeForecast = (fc) => {
            if (!fc) return;
            summary = fc.idle ? null : (fc.summary ?? null);
            render();
        };
        takeForecast(window.__fluxRopeForecast);
        window.addEventListener('flux-rope-forecast', (e) => takeForecast(e.detail));

        // Location from the shared store (AurOracle / EarthView write it).
        import('./user-location.js').then((m) => {
            loc = m.loadUserLocation();
            render();
            window.addEventListener('user-location-changed', (e) => {
                loc = e.detail || m.loadUserLocation();
                render();
            });
        }).catch(() => {});

        render();
        setInterval(render, 60_000);       // countdown tick
    } catch (e) {
        console.warn('[status-band] disabled:', e);
    }
}
