/**
 * sun-watch.js — the Sun Watch analysis dock (DOM + feeds) for sun.html
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The 3D sun stays the hero; this dock is the ANALYSIS surface that fuses
 * the site's solar pipelines into one place:
 *
 *   Timeline  — DONKI flares/CMEs/SEP/GST + SWPC GOES events, one ledger
 *   Regions   — /api/noaa/regions with per-AR C/M/X flare probabilities
 *   CMEs      — DONKI CME analysis + Enlil modeled arrivals
 *   Forecast  — the flux-rope compounding-train ensemble (Bz fan, P(hit),
 *               arrival window). This tab computes NOTHING: it renders the
 *               ONE published provider result ('flux-rope-forecast' event /
 *               window.__fluxRopeForecast, run by js/sun-flux-rope.js) —
 *               never a second DONKI→ensemble→assimilation pipeline.
 *   Holes     — HEK coronal holes (list + optional 3D markers on the sun)
 *   Cycle     — F10.7 solar-cycle context from js/f107-history.js
 *
 * ARCHITECTURE RULES (match the corridor-panel pattern — see
 * js/corridor/corridor-panel.js header):
 *   · every feed is independently awaited and independently allowed to
 *     fail; a dead feed shows a "down" chip and an empty section, never a
 *     fabricated row and never a dock-killing throw.
 *   · all analysis math lives in the PURE js/sun-watch-model.js (node-
 *     gated); this file is DOM, fetch, and three.js marker glue only.
 *   · probabilities go through the far-side package's scale detection via
 *     the model — no second implementation.
 *   · coronal-hole polling reuses js/hek-feed.js (the ONE HEK client).
 *   · F10.7 goes through the js/f107-history.js singleton.
 *
 * INTEGRATION CONTRACT with sun.html:
 *   initSunWatch({ THREE, scene, flyToRegion, onFlareSelect,
 *                  getLiveFlares, registerRotatingGroup })
 *   — registerRotatingGroup(group) parents the coronal-hole marker group
 *     into the scene and rotates it with the photosphere (same
 *     solarRotAngle the AR regionGroup uses), so hole markers and AR
 *     markers never drift apart.
 *   — window.__sunWatch = { ready, state, setTab, refresh, probIndex,
 *     collapsed } is the test/debug handle (mirrors window.__sun style)
 *     and is how showRegionAnalysis() looks up per-AR probabilities.
 *
 * All CSS is namespaced .snw-* and injected at mount time so it wins
 * cascade ties against sun.html's static styles.
 */

import {
    buildTimeline, enrichRegions, regionProbIndex, cmeSummary,
    cycleSummary, holeMarkers, fmtAge, freshnessLabel, EVENT_COLORS,
} from './sun-watch-model.js';
import { HekFeed } from './hek-feed.js';
import * as f107 from './f107-history.js';
import { INTERVALS } from './config.js';
import { drawBzChart } from './flux-rope/charts.js';

const REFRESH_MS = INTERVALS?.T3 ?? 900_000;   // DONKI + regions cadence
const FETCH_TIMEOUT = 15_000;
const LS_COLLAPSED = 'snw_collapsed';

const TABS = [
    { id: 'timeline', label: 'Timeline' },
    { id: 'regions',  label: 'Regions'  },
    { id: 'cme',      label: 'CMEs'     },
    { id: 'forecast', label: 'Forecast' },
    { id: 'holes',    label: 'Holes'    },
    { id: 'cycle',    label: 'Cycle'    },
];

const CSS = `
.snw-dock {
    position:absolute; left:12px; bottom:14px; z-index:58;
    width:344px; max-height:54vh; display:flex; flex-direction:column;
    background:rgba(5,3,0,.86); backdrop-filter:blur(10px);
    border:1px solid rgba(255,160,0,.28); border-radius:11px;
    font-size:11px; color:#d8c9a8; overflow:hidden;
    box-shadow:0 6px 28px rgba(0,0,0,.55);
}
.snw-dock.snw-hidden { display:none; }
.snw-hd {
    display:flex; align-items:center; gap:8px; padding:8px 12px 7px;
    border-bottom:1px solid rgba(255,160,0,.18); flex:0 0 auto;
    background:linear-gradient(180deg, rgba(255,140,0,.08), transparent);
}
.snw-wordmark { font-weight:700; letter-spacing:.14em; font-size:12px; color:#ffb830; }
.snw-live-dot {
    width:7px; height:7px; border-radius:50%; background:#5c5;
    box-shadow:0 0 6px #5c5; animation:snw-pulse 2.2s ease-in-out infinite;
}
.snw-live-dot.snw-down { background:#c55; box-shadow:0 0 6px #c55; animation:none; }
@keyframes snw-pulse { 0%,100%{opacity:.55} 50%{opacity:1} }
.snw-hd-xray { margin-left:auto; font-size:10px; color:#ffd080; font-weight:600; }
.snw-btn {
    background:none; border:1px solid rgba(255,160,0,.3); border-radius:5px;
    color:#ffb830; cursor:pointer; font-size:11px; line-height:1;
    padding:3px 7px; font-family:inherit;
}
.snw-btn:hover { background:rgba(255,140,0,.18); }
.snw-tabs { display:flex; flex:0 0 auto; border-bottom:1px solid rgba(255,160,0,.15); }
.snw-tab {
    flex:1; background:none; border:none; border-bottom:2px solid transparent;
    color:#8a7a5c; cursor:pointer; font-size:10.5px; font-family:inherit;
    padding:6px 2px 5px; letter-spacing:.03em;
}
.snw-tab:hover { color:#d8b878; }
.snw-tab.snw-on { color:#ffcc66; border-bottom-color:#ff9922; }
.snw-body { overflow-y:auto; flex:1 1 auto; padding:7px 10px 9px; scrollbar-width:thin; }
.snw-body::-webkit-scrollbar { width:7px; }
.snw-body::-webkit-scrollbar-thumb { background:rgba(255,160,0,.25); border-radius:4px; }
.snw-empty { color:#776a52; padding:14px 4px; text-align:center; }
.snw-row {
    display:flex; align-items:baseline; gap:7px; padding:5px 4px;
    border-bottom:1px solid rgba(255,180,60,.08); border-radius:4px;
}
.snw-row.snw-click { cursor:pointer; }
.snw-row.snw-click:hover { background:rgba(255,150,30,.10); }
.snw-badge {
    flex:0 0 auto; min-width:30px; text-align:center; padding:1px 5px;
    border-radius:4px; font-weight:700; font-size:10px;
    background:rgba(255,255,255,.06); border:1px solid currentColor;
}
.snw-title { color:#e8dcc0; }
.snw-detail { color:#8f8168; font-size:10px; }
.snw-age { margin-left:auto; flex:0 0 auto; color:#77694e; font-size:10px; }
.snw-earth { color:#7fd4ff; font-size:10px; }
.snw-bar { height:4px; border-radius:2px; background:rgba(255,255,255,.07); overflow:hidden; margin-top:2px; }
.snw-bar > div { height:100%; border-radius:2px; }
.snw-reg-grid { display:grid; grid-template-columns:auto 1fr auto; gap:3px 9px; align-items:center; }
.snw-kv { display:flex; justify-content:space-between; padding:3px 4px; border-bottom:1px solid rgba(255,180,60,.08); }
.snw-kv .k { color:#8f8168; }
.snw-kv .v { color:#ffd080; font-weight:600; }
.snw-ft {
    flex:0 0 auto; display:flex; align-items:center; gap:6px; flex-wrap:wrap;
    padding:5px 10px 6px; border-top:1px solid rgba(255,160,0,.15);
    font-size:9.5px; color:#77694e;
}
.snw-chip { padding:1px 6px; border-radius:8px; border:1px solid rgba(255,255,255,.14); }
.snw-chip.snw-live   { color:#8d8; border-color:rgba(120,220,120,.4); }
.snw-chip.snw-recent { color:#dc6; border-color:rgba(220,200,100,.4); }
.snw-chip.snw-stale  { color:#e96; border-color:rgba(230,150,100,.45); }
.snw-chip.snw-down   { color:#e77; border-color:rgba(230,110,110,.5); }
.snw-pill {
    position:absolute; left:12px; bottom:14px; z-index:58;
    background:rgba(5,3,0,.84); backdrop-filter:blur(8px);
    border:1px solid rgba(255,160,0,.35); border-radius:18px;
    color:#ffb830; cursor:pointer; font-family:inherit; font-size:12px;
    padding:7px 14px; display:none; touch-action:manipulation;
}
.snw-pill:hover { background:rgba(255,140,0,.2); }
.snw-pill.snw-show { display:block; }
.snw-toggle-row { display:flex; align-items:center; gap:7px; padding:4px; color:#a89678; }
.snw-note { color:#77694e; font-size:9.5px; padding:5px 4px 1px; line-height:1.5; }
.snw-note a { color:#ffb830; }
canvas.snw-spark { width:100%; height:64px; display:block; margin-top:4px; }
canvas.snw-rope-chart { width:100%; height:132px; display:block; margin:6px 0 2px; }
.snw-fc-warn { color:#ffb454; padding:10px 4px; line-height:1.5; }
.snw-fc-stats { display:grid; grid-template-columns:1fr 1fr; gap:5px; margin-top:5px; }
.snw-fc-stat { background:rgba(255,160,0,.06); border:1px solid rgba(255,160,0,.18);
    border-radius:7px; padding:5px 8px; }
.snw-fc-stat .v { font-size:12px; font-weight:700; color:#ffd080; }
.snw-fc-stat .v.warn { color:#ff8866; }
.snw-fc-stat .k { font-size:8.5px; color:#8f8168; letter-spacing:.04em; text-transform:uppercase; margin-top:1px; }
@media (max-width:768px) {
    .snw-dock { left:8px; right:8px; width:auto; max-height:44svh; bottom:8px; }
    .snw-pill { bottom:8px; left:8px; }
}
`;

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function fetchJson(url) {
    const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
    return res.json();
}

export function initSunWatch(deps = {}) {
    const { THREE, flyToRegion, onFlareSelect, getLiveFlares, registerRotatingGroup } = deps;

    // ── State ────────────────────────────────────────────────────────────
    const state = {
        tab: 'timeline',
        timeline: [],
        regions: { rows: [], scale: 'percent', note: null },
        cmes: [],
        cmeSum: { count: 0, earthCount: 0, fastest: null, nextArrival: null },
        holes: [],
        cycle: null,
        forecast: (typeof window !== 'undefined' && window.__fluxRopeForecast) || null,
        feeds: {   // per-feed health: { atMs:number|null, error:string|null }
            donki:   { atMs: null, error: null },
            regions: { atMs: null, error: null },
            hek:     { atMs: null, error: null },
            f107:    { atMs: null, error: null },
        },
        showHoleMarkers: true,
        xrayChip: '',
    };
    let probIdx = new Map();
    let holeGroup = null;

    // ── DOM ──────────────────────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const dock = document.createElement('div');
    dock.className = 'snw-dock';
    dock.id = 'sun-watch-dock';
    dock.innerHTML = `
        <div class="snw-hd">
            <span class="snw-live-dot" id="snw-dot"></span>
            <span class="snw-wordmark">SUN WATCH</span>
            <span class="snw-hd-xray" id="snw-xray"></span>
            <button class="snw-btn" id="snw-refresh" title="Refresh feeds">↻</button>
            <button class="snw-btn" id="snw-min" title="Minimize">–</button>
        </div>
        <div class="snw-tabs" id="snw-tabs">${TABS.map(t =>
            `<button class="snw-tab" data-tab="${t.id}">${t.label}</button>`).join('')}
        </div>
        <div class="snw-body" id="snw-body"></div>
        <div class="snw-ft" id="snw-ft"></div>
    `;
    const pill = document.createElement('button');
    pill.className = 'snw-pill';
    pill.id = 'snw-pill';
    pill.textContent = '☀ Sun Watch';

    const host = document.getElementById('canvas-wrap')?.parentElement ?? document.body;
    host.appendChild(dock);
    host.appendChild(pill);

    const $body = dock.querySelector('#snw-body');
    const $ft = dock.querySelector('#snw-ft');
    const $dot = dock.querySelector('#snw-dot');

    // Collapse / expand — sticky, and default-collapsed on small screens
    // (the dock would otherwise cover most of a phone canvas).
    let collapsed = localStorage.getItem(LS_COLLAPSED) === '1'
        || (localStorage.getItem(LS_COLLAPSED) === null && matchMedia('(max-width:768px)').matches);
    function applyCollapsed() {
        dock.classList.toggle('snw-hidden', collapsed);
        pill.classList.toggle('snw-show', collapsed);
    }
    dock.querySelector('#snw-min').addEventListener('click', () => {
        collapsed = true; localStorage.setItem(LS_COLLAPSED, '1'); applyCollapsed();
    });
    pill.addEventListener('click', () => {
        collapsed = false; localStorage.setItem(LS_COLLAPSED, '0'); applyCollapsed();
    });
    applyCollapsed();

    dock.querySelector('#snw-tabs').addEventListener('click', (e) => {
        const b = e.target.closest('.snw-tab');
        if (b) setTab(b.dataset.tab);
    });
    dock.querySelector('#snw-refresh').addEventListener('click', () => refresh(true));

    // Row interactions (delegated so re-renders keep working)
    $body.addEventListener('click', (e) => {
        const row = e.target.closest('.snw-row[data-lat]');
        if (!row) return;
        const lat = Number(row.dataset.lat), lon = Number(row.dataset.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        if (row.dataset.kind === 'flare' && typeof onFlareSelect === 'function') {
            onFlareSelect(lat, lon, row.dataset.cls || 'C');
        } else if (typeof flyToRegion === 'function') {
            flyToRegion(lat, lon);
        }
    });
    $body.addEventListener('change', (e) => {
        if (e.target?.id === 'snw-hole-toggle') {
            state.showHoleMarkers = !!e.target.checked;
            if (holeGroup) holeGroup.visible = state.showHoleMarkers;
        }
    });

    // ── Renderers ────────────────────────────────────────────────────────
    function setTab(id) {
        state.tab = TABS.some(t => t.id === id) ? id : 'timeline';
        dock.querySelectorAll('.snw-tab').forEach(b =>
            b.classList.toggle('snw-on', b.dataset.tab === state.tab));
        render();
    }

    function render() {
        const now = Date.now();
        if (state.tab === 'timeline') renderTimeline(now);
        else if (state.tab === 'regions') renderRegions();
        else if (state.tab === 'cme') renderCmes(now);
        else if (state.tab === 'forecast') renderForecast(now);
        else if (state.tab === 'holes') renderHoles(now);
        else renderCycle();
        renderFooter(now);
    }

    function renderTimeline(now) {
        if (!state.timeline.length) {
            $body.innerHTML = `<div class="snw-empty">No solar events in the last 7 days —<br>or the DONKI feed is still loading.</div>`;
            return;
        }
        $body.innerHTML = state.timeline.slice(0, 40).map(ev => {
            const clickable = Number.isFinite(ev.lat) && Number.isFinite(ev.lon) && ev.kind === 'flare';
            return `<div class="snw-row${clickable ? ' snw-click' : ''}"
                ${clickable ? `data-lat="${ev.lat}" data-lon="${ev.lon}" data-kind="flare" data-cls="${esc((ev.cls || 'C')[0])}"` : ''}
                title="${esc(new Date(ev.t).toUTCString())}">
                <span class="snw-badge" style="color:${ev.color}">${esc(ev.badge)}</span>
                <span>
                    <span class="snw-title">${esc(ev.title)}</span>
                    ${ev.earth ? '<span class="snw-earth" title="Earth-relevant">⊕</span>' : ''}
                    ${ev.detail ? `<div class="snw-detail">${esc(ev.detail)}</div>` : ''}
                </span>
                <span class="snw-age">${fmtAge(ev.t, now)}</span>
            </div>`;
        }).join('');
    }

    function renderRegions() {
        const { rows, note } = state.regions;
        if (!rows.length) {
            $body.innerHTML = `<div class="snw-empty">No numbered active regions reported${state.feeds.regions.error ? ' — regions feed down' : ''}.</div>`;
            return;
        }
        const pct = (p) => p == null ? '—' : Math.round(p * 100) + '%';
        $body.innerHTML = rows.map(r => {
            const clickable = Number.isFinite(r.lat) && Number.isFinite(r.lon);
            const mBar = Math.round((r.pM ?? 0) * 100);
            const xBar = Math.round((r.pX ?? 0) * 100);
            return `<div class="snw-row${clickable ? ' snw-click' : ''}" style="display:block"
                ${clickable ? `data-lat="${r.lat}" data-lon="${r.lon}" data-kind="region"` : ''}>
                <div style="display:flex;gap:7px;align-items:baseline">
                    <span class="snw-badge" style="color:#ffcc66">AR ${esc(r.region)}</span>
                    <span class="snw-title">${esc(r.location ?? '—')} · ${esc(r.mag_class || r.spot_class || '—')}</span>
                    <span class="snw-age">${r.area} µhem · ${r.num_spots} spots</span>
                </div>
                <div class="snw-detail" style="margin-top:3px">
                    24 h flare odds — C ${pct(r.pC)} · M ${pct(r.pM)} · X ${pct(r.pX)}
                </div>
                <div class="snw-bar"><div style="width:${mBar}%;background:${EVENT_COLORS.M}"></div></div>
                <div class="snw-bar"><div style="width:${xBar}%;background:${EVENT_COLORS.X}"></div></div>
            </div>`;
        }).join('')
        + `<div class="snw-note">Probabilities are SWPC's own published 24 h forecasts, per region.${note ? ' ' + esc(note) : ''}</div>`;
    }

    function renderCmes(now) {
        const s = state.cmeSum;
        const head = `
            <div class="snw-kv"><span class="k">CMEs · 7 days</span><span class="v">${s.count}</span></div>
            <div class="snw-kv"><span class="k">Earth-directed</span><span class="v">${s.earthCount}</span></div>
            <div class="snw-kv"><span class="k">Fastest</span><span class="v">${s.fastest ? Math.round(s.fastest) + ' km/s' : '—'}</span></div>
            <div class="snw-kv"><span class="k">Next modeled arrival</span><span class="v">${s.nextArrival ? 'in ' + fmtAge(2 * now - s.nextArrival, now) : '—'}</span></div>`;
        if (!state.cmes.length) {
            $body.innerHTML = head + `<div class="snw-empty">No CME analyses published${state.feeds.donki.error ? ' — DONKI feed down' : ''}.</div>`;
            return;
        }
        $body.innerHTML = head + state.cmes.slice(0, 15).map(c => {
            const spd = Number(c.speed_km_s);
            const arr = c.enlil?.shock_arrival;
            return `<div class="snw-row" style="display:block">
                <div style="display:flex;gap:7px;align-items:baseline">
                    <span class="snw-badge" style="color:${EVENT_COLORS.cme}">CME</span>
                    <span class="snw-title">${Number.isFinite(spd) ? Math.round(spd) + ' km/s' : '?'}
                        ${c.earth_directed ? '<span class="snw-earth">⊕ Earth-directed</span>' : ''}</span>
                    <span class="snw-age">${fmtAge(Date.parse(c.time), now)}</span>
                </div>
                <div class="snw-detail">
                    ${Number.isFinite(Number(c.half_angle_deg)) ? 'half-angle ' + Math.round(c.half_angle_deg) + '°' : ''}
                    ${Number.isFinite(Number(c.latitude_deg)) ? ' · λ ' + Math.round(c.latitude_deg) + '° φ ' + Math.round(c.longitude_deg ?? 0) + '°' : ''}
                    ${arr ? ' · Enlil arrival ' + esc(String(arr).slice(5, 16).replace('T', ' ')) + 'Z' : ''}
                    ${c.enlil && c.enlil.kp_90 != null ? ' · Kp≈' + c.enlil.kp_90 + '–' + (c.enlil.kp_180 ?? c.enlil.kp_90) : ''}
                </div>
            </div>`;
        }).join('')
        + `<div class="snw-note">DONKI CME analyses (NASA CCMC). Modeled arrivals are WSA-Enlil runs, not observations. For the full ensemble forecast see <a href="cme-forecast.html" style="color:#ffb830">CME Forecast</a>.</div>`;
    }

    // Forecast tab — a pure VIEW of the shared provider's published result.
    // The four states mirror js/flux-rope-dashboard.js: starting, failed
    // (a broken feed must LOOK broken, never like a quiet sun), honestly
    // idle (empty catalog vs a storm that already passed L1), and live.
    function renderForecast(now) {
        const fc = state.forecast;
        if (!fc) {
            $body.innerHTML = `<div class="snw-empty">Ensemble engine starting —<br>first run a few seconds after page load.</div>`;
            return;
        }
        if (fc.failed) {
            $body.innerHTML = `<div class="snw-fc-warn">⚠ Forecast feed unavailable —
                ${esc(String(fc.reason).slice(0, 160))} · retrying automatically</div>`;
            return;
        }
        if (fc.idle) {
            const quietLine = fc.reason === 'cme-train-passed'
                ? 'the last Earth-directed CME has already passed L1 — the corridor is currently clear.'
                : 'no Earth-directed CME analyses in the last 7 days.';
            $body.innerHTML = `<div class="snw-note" style="padding-top:10px">☀ DONKI catalog reachable · ${quietLine}
                The ensemble engine is idle — watch the live compounding view on
                <a href="flux-rope-live.html">Compounding Watch</a> or replay events in the
                <a href="flux-rope.html">Flux Rope Simulator</a>.</div>`;
            return;
        }
        const s = fc.summary;
        const pctTxt = (v) => `${Math.round((v ?? 0) * 100)}%`;
        const fmtUtc = (msVal) => new Date(msVal).toISOString().slice(5, 16).replace('T', ' ');
        const arrTxt = s.arrivalP10Ms != null
            ? `${fmtUtc(s.arrivalP10Ms)}–${fmtUtc(s.arrivalP90Ms)}Z`
            : 'likely miss';
        const members = fc.cmes.map((c, i) => `
            <div class="snw-row">
                <span class="snw-badge" style="color:${EVENT_COLORS.cme}">R${i}</span>
                <span>
                    <span class="snw-title">${esc(c.timeIso.slice(5, 16).replace('T', ' '))}Z ·
                        ${Math.round(c.speedKms)} km/s</span>
                    ${c.earthDirected ? '<span class="snw-earth" title="Earth-directed">⊕</span>' : ''}
                </span>
                <span class="snw-age">${fmtAge(Date.parse(c.timeIso), now)}</span>
            </div>`).join('');

        // Compounding measurement (js/sun-flux-rope.js measureCompounding —
        // the §16 counterfactual). Rendered verbatim; computed nowhere here.
        const cp = fc.compounding;
        let cpBlock = '';
        if (cp) {
            const num = (v, f) => (v == null || !Number.isFinite(v)) ? '—' : f(v);
            const sgn = (v, unit, dp = 1) =>
                num(v, (x) => `${x > 0 ? '+' : ''}${x.toFixed(dp)} ${unit}`);
            const pcts = (a, b, dv) =>
                `${num(a, (x) => Math.round(x * 100) + '%')} vs ${num(b, (x) => Math.round(x * 100) + '%')}`
                + ` (${num(dv, (x) => `${x > 0 ? '+' : ''}${Math.round(x * 100)} pts`)})`;
            const wakeRows = cp.ropes.filter((r) => r.leader != null).map((r) => `
                <div class="snw-detail">R${r.i} in R${r.leader}'s wake —
                    ambient ${num(r.wakeDvKms, (x) => (x > 0 ? '+' : '') + Math.round(x))} km/s ·
                    drag ×${num(r.gammaRatio, (x) => x.toFixed(2))} ·
                    arrives ${num(r.deltaH, (x) => Math.abs(x).toFixed(1))} h
                    ${r.deltaH != null && r.deltaH < 0 ? 'earlier' : 'later'}</div>`).join('');
            cpBlock = `
                <div class="snw-detail" style="margin-top:8px;color:#9fc0ff;letter-spacing:.06em">
                    COMPOUNDING EFFECT · vs the same ropes run independently</div>
                <div class="snw-kv"><span class="k">min Bz (p50)</span><span class="v">
                    ${num(cp.on.minBzP50, (x) => x.toFixed(1))} vs ${num(cp.off.minBzP50, (x) => x.toFixed(1))} nT
                    (${sgn(cp.delta.minBzP50, 'nT')})</span></div>
                <div class="snw-kv"><span class="k">P(min Bz &lt; −20 nT)</span><span class="v">
                    ${pcts(cp.on.p20, cp.off.p20, cp.delta.p20)}</span></div>
                <div class="snw-kv"><span class="k">P(min Bz &lt; −10 nT)</span><span class="v">
                    ${pcts(cp.on.p10, cp.off.p10, cp.delta.p10)}</span></div>
                <div class="snw-kv"><span class="k">ensemble arrival (p50)</span><span class="v">
                    ${sgn(cp.delta.arrivalP50H, 'h')}</span></div>
                ${wakeRows}
                <div class="snw-note">${esc(cp.disclosure)}.</div>`;
        } else if (fc.train) {
            cpBlock = `<div class="snw-note">Compounding counterfactual unavailable
                for this run — retried on the next refresh.</div>`;
        } else {
            cpBlock = `<div class="snw-note">Single rope in flight — nothing to
                compound. The §16 interaction measurement appears when ≥ 2 CMEs
                form a train.</div>`;
        }
        const obsRow = fc.observedL1 ? `
            <div class="snw-kv"><span class="k">observed min Bz so far (L1)</span>
                <span class="v">${fc.observedL1.minBz.toFixed(1)} nT</span></div>` : '';
        $body.innerHTML = `
            <div class="snw-detail" style="padding:2px 0 1px">
                ${fc.train
                    ? `⚡ Compounding train · ${fc.cmes.length} CMEs · §16 interaction on`
                    : 'Single Earth-directed CME'}
                · ${fc.prior.members}-member ensemble</div>
            <canvas class="snw-rope-chart" id="snw-rope-chart"></canvas>
            <div class="snw-fc-stats">
                <div class="snw-fc-stat"><div class="v">${pctTxt(fc.fan.pHit)}</div><div class="k">P(Earth hit)</div></div>
                <div class="snw-fc-stat"><div class="v" style="font-size:10.5px">${arrTxt}</div><div class="k">arrival P10–P90 (UTC)</div></div>
                <div class="snw-fc-stat"><div class="v${s.p10 > 0.3 ? ' warn' : ''}">${pctTxt(s.p10)}</div><div class="k">P(min Bz &lt; −10 nT)</div></div>
                <div class="snw-fc-stat"><div class="v${s.p20 > 0.3 ? ' warn' : ''}">${pctTxt(s.p20)}</div><div class="k">P(min Bz &lt; −20 nT)</div></div>
            </div>
            ${members}
            ${obsRow}
            ${cpBlock}
            <div class="snw-note">${esc(fc.assimNote)} · fan = ensemble 5–95% / 25–75% Bz at L1 ·
                amber = observed DSCOVR/ACE · magnetic config is a wide prior (cone fits don't constrain it).
                Live view: <a href="flux-rope-live.html">Compounding Watch</a> ·
                sandbox: <a href="flux-rope.html">Flux Rope Simulator</a></div>`;
        drawRopeChart(fc, now);
    }

    function drawRopeChart(fc, now) {
        const cv = document.getElementById('snw-rope-chart');
        if (!cv) return;
        drawBzChart(cv, {
            tH: Array.from({ length: fc.grid.n }, (_, i) => i * fc.grid.dtS / 3600),
            det: null,
            fan: { ...fc.fan.bzPct, hitFrac: fc.fan.hitFrac },
            obs: fc.rtsw?.length
                ? { tH: fc.rtsw.samples.map((p) => (p.t - fc.launchMs) / 3600_000),
                    bz: fc.rtsw.samples.map((p) => p.bz) }
                : null,
            launchMs: fc.launchMs,
            cursorH: (now - fc.launchMs) / 3600_000,
            noise: fc.noise?.ok ? fc.noise : null,
        });
    }

    function renderHoles(now) {
        const toggle = `<label class="snw-toggle-row"><input type="checkbox" id="snw-hole-toggle" ${state.showHoleMarkers ? 'checked' : ''}> Mark holes on the Sun</label>`;
        if (!state.holes.length) {
            $body.innerHTML = toggle + `<div class="snw-empty">No coronal holes on the visible disc${state.feeds.hek.error ? ' — HEK feed down' : ''}.</div>`;
            return;
        }
        $body.innerHTML = toggle + state.holes.map(h => `
            <div class="snw-row">
                <span class="snw-badge" style="color:#44ddcc">CH</span>
                <span>
                    <span class="snw-title">${h.lat >= 0 ? 'N' : 'S'}${Math.abs(Math.round(h.lat))} ${h.lon >= 0 ? 'W' : 'E'}${Math.abs(Math.round(h.lon))}</span>
                    <div class="snw-detail">${esc(h.source)}</div>
                </span>
                <span class="snw-age">${h.time ? fmtAge(Date.parse(h.time), now) : ''}</span>
            </div>`).join('')
        + `<div class="snw-note">Detections from the LMSAL HEK catalog (SPoCA/CHIMERA). Coronal holes are open-field regions — the sources of high-speed wind streams that arrive at Earth ~2–4 days after crossing central meridian.</div>`;
    }

    function renderCycle() {
        const c = state.cycle;
        if (!c) {
            $body.innerHTML = `<div class="snw-empty">F10.7 history not loaded${state.feeds.f107.error ? ' — feed down' : ''}.</div>`;
            return;
        }
        $body.innerHTML = `
            <div class="snw-kv"><span class="k">F10.7 today</span><span class="v">${Math.round(c.current)} sfu</span></div>
            <div class="snw-kv"><span class="k">27-day mean</span><span class="v">${c.mean27 ? Math.round(c.mean27) + ' sfu' : '—'}</span></div>
            <div class="snw-kv"><span class="k">81-day mean</span><span class="v">${c.mean81 ? Math.round(c.mean81) + ' sfu' : '—'}</span></div>
            <div class="snw-kv"><span class="k">Trend</span><span class="v">${c.trend}</span></div>
            <div class="snw-kv"><span class="k">Activity level</span><span class="v">${esc(c.label)}</span></div>
            <canvas class="snw-spark" id="snw-cycle-spark" width="640" height="128"></canvas>
            <div class="snw-note">10.7 cm radio flux — the standard solar-activity index. Solid: observed · dashed: SWPC 45-day prediction.</div>`;
        drawCycleSpark(c.series);
    }

    function drawCycleSpark(series) {
        const cv = document.getElementById('snw-cycle-spark');
        if (!cv || !series?.length) return;
        const ctx = cv.getContext('2d');
        const W = cv.width, H = cv.height;
        ctx.clearRect(0, 0, W, H);
        const t0 = series[0].t, t1 = series[series.length - 1].t;
        let vMin = Infinity, vMax = -Infinity;
        for (const p of series) { if (p.v < vMin) vMin = p.v; if (p.v > vMax) vMax = p.v; }
        if (!(t1 > t0) || !(vMax > vMin)) return;
        const X = t => 4 + (W - 8) * (t - t0) / (t1 - t0);
        const Y = v => H - 6 - (H - 14) * (v - vMin) / (vMax - vMin);
        for (const kind of ['observed', 'predicted']) {
            ctx.beginPath();
            ctx.setLineDash(kind === 'predicted' ? [5, 4] : []);
            ctx.strokeStyle = kind === 'predicted' ? 'rgba(255,200,120,.55)' : '#ffb830';
            ctx.lineWidth = 2;
            let pen = false;
            for (const p of series) {
                if (p.kind !== kind) { pen = false; continue; }
                if (!pen) { ctx.moveTo(X(p.t), Y(p.v)); pen = true; }
                else ctx.lineTo(X(p.t), Y(p.v));
            }
            ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(216,201,168,.7)';
        ctx.font = '11px system-ui';
        ctx.fillText(Math.round(vMax) + ' sfu', 6, 12);
        ctx.fillText(Math.round(vMin) + ' sfu', 6, H - 10);
    }

    function renderFooter(now) {
        const chips = Object.entries(state.feeds).map(([name, f]) => {
            const cls = f.error ? 'down' : freshnessLabel(f.atMs == null ? NaN : now - f.atMs);
            const label = { donki: 'DONKI', regions: 'SWPC regions', hek: 'HEK', f107: 'F10.7' }[name];
            return `<span class="snw-chip snw-${cls}" title="${esc(f.error ?? '')}">${label}</span>`;
        }).join('');
        const anyLive = Object.values(state.feeds).some(f => f.atMs != null && !f.error);
        $dot.classList.toggle('snw-down', !anyLive);
        $ft.innerHTML = chips + `<span style="margin-left:auto">NASA DONKI · NOAA SWPC · LMSAL HEK</span>`;
        const $x = dock.querySelector('#snw-xray');
        if ($x) $x.textContent = state.xrayChip;
    }

    // ── Coronal-hole 3D markers ──────────────────────────────────────────
    function rebuildHoleGroup() {
        if (!THREE || typeof registerRotatingGroup !== 'function') return;
        // ONE registered group, children rebuilt per HEK update — a fresh
        // group per update would pile registrations up in the page's
        // rotation list.
        if (!holeGroup) {
            holeGroup = new THREE.Group();
            registerRotatingGroup(holeGroup);
        }
        for (const child of [...holeGroup.children]) {
            holeGroup.remove(child);
            child.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
        }
        for (const h of state.holes) {
            const lat = h.lat * Math.PI / 180, lon = h.lon * Math.PI / 180;
            // Same frame as buildRegionMarkers(): Stonyhurst, W-positive lon.
            const pos = new THREE.Vector3(
                Math.cos(lat) * Math.sin(lon),
                Math.sin(lat),
                Math.cos(lat) * Math.cos(lon),
            );
            const g = new THREE.Group();
            g.position.copy(pos);
            g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), pos.clone().normalize());
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(0.055, 0.0028, 6, 40),
                new THREE.MeshBasicMaterial({
                    color: 0x44ddcc, transparent: true, opacity: 0.5,
                    depthWrite: false, blending: THREE.AdditiveBlending,
                }),
            );
            g.add(ring);
            holeGroup.add(g);
        }
        holeGroup.visible = state.showHoleMarkers && state.holes.length > 0;
    }

    // ── Feeds ────────────────────────────────────────────────────────────
    function rebuildDerived() {
        state.timeline = buildTimeline({
            donkiFlares: state._donki?.flares,
            swpcFlares: typeof getLiveFlares === 'function' ? getLiveFlares() : [],
            cmes: state.cmes,
            seps: state._donki?.seps,
            gsts: state._donki?.gsts,
            notes: state._donki?.notes,
            nowMs: Date.now(),
        });
        state.cmeSum = cmeSummary(state.cmes, Date.now());
        // Announce the rebuilt ledger — sun.html's scrubber event track
        // consumes it (one fetch, two views; the track never re-polls DONKI).
        try {
            window.dispatchEvent(new CustomEvent('sun-watch-update',
                { detail: { timeline: state.timeline } }));
        } catch { /* no listeners — best-effort */ }
    }

    async function refreshDonki() {
        const f = state.feeds.donki;
        try {
            const [fl, cm, se, gs, no] = await Promise.allSettled([
                fetchJson('/api/donki/flares?days=7'),
                fetchJson('/api/donki/cme?days=7'),
                fetchJson('/api/donki/sep?days=14'),
                fetchJson('/api/donki/gst?days=14'),
                fetchJson('/api/donki/notifications'),
            ]);
            const val = r => r.status === 'fulfilled' ? r.value : null;
            state._donki = {
                flares: val(fl)?.data?.flares ?? null,
                seps:   val(se)?.data?.events ?? null,
                gsts:   val(gs)?.data?.events ?? null,
                notes:  val(no)?.data?.notifications ?? null,
            };
            state.cmes = val(cm)?.data?.cmes ?? [];
            const anyOk = [fl, cm, se, gs, no].some(r => r.status === 'fulfilled');
            if (anyOk) { f.atMs = Date.now(); f.error = null; }
            else { f.error = 'all DONKI routes failed'; }
        } catch (err) {
            f.error = String(err?.message ?? err);
        }
        rebuildDerived();
    }

    async function refreshRegions() {
        const f = state.feeds.regions;
        try {
            const payload = await fetchJson('/api/noaa/regions');
            const enriched = enrichRegions(payload?.data?.regions);
            state.regions = { ...enriched, note: payload?.data?.note ?? null };
            probIdx = regionProbIndex(enriched.rows);
            f.atMs = Date.now(); f.error = null;
            // Schema self-report — separates "our field map is wrong" from
            // "SWPC is down" (corridor-panel lesson).
            if (payload?.data?.unmapped_keys?.length) {
                console.info('[sun-watch] regions unmapped keys:', payload.data.unmapped_keys);
            }
        } catch (err) {
            f.error = String(err?.message ?? err);
        }
    }

    function refreshF107() {
        f107.ensureLoaded().then(() => {
            const snap = f107.snapshot();
            if (snap.fetchedOk) {
                state.feeds.f107.atMs = snap.fetchedAtMs;
                state.feeds.f107.error = null;
                state.cycle = cycleSummary(snap.rows, Date.now());
            } else {
                state.feeds.f107.error = 'f107 history unavailable';
            }
            if (state.tab === 'cycle') render(); else renderFooter(Date.now());
        }).catch(err => {
            state.feeds.f107.error = String(err?.message ?? err);
            renderFooter(Date.now());
        });
    }

    async function refresh(manual = false) {
        if (manual) hek.refresh();
        await Promise.allSettled([refreshDonki(), refreshRegions()]);
        refreshF107();
        render();
    }

    // HEK coronal holes — the ONE shared client, own cadence (30 min).
    const hek = new HekFeed();
    window.addEventListener('hek-update', (ev) => {
        state.holes = holeMarkers(ev.detail?.holes);
        state.feeds.hek.atMs = Date.now();
        state.feeds.hek.error = null;
        rebuildHoleGroup();
        if (state.tab === 'holes') render(); else renderFooter(Date.now());
    }, { passive: true });
    hek.start();
    // HekFeed retries silently; mark the chip down until the first payload.
    state.feeds.hek.error = 'awaiting first HEK payload';

    // The shared flux-rope provider's published result (js/sun-flux-rope.js
    // runs the loop; this dock only renders). Consume, never re-compute.
    window.addEventListener('flux-rope-forecast', (ev) => {
        state.forecast = ev.detail ?? null;
        if (state.tab === 'forecast') render();
    }, { passive: true });

    // Live X-ray chip from the page's existing feed — consume, never re-poll.
    window.addEventListener('swpc-update', (ev) => {
        const d = ev.detail;
        const cls = d?.solar_activity?.xray_class ?? d?.xray_class;
        if (cls) { state.xrayChip = 'GOES ' + cls; renderFooter(Date.now()); }
    }, { passive: true });

    setTab('timeline');
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);

    // ── Test / debug handle + popup-enrichment lookup ────────────────────
    const handle = {
        ready: true,
        state,
        setTab,
        refresh,
        get probIndex() { return probIdx; },
        get collapsed() { return collapsed; },
        dispose: () => { clearInterval(timer); hek.stop(); },
    };
    window.__sunWatch = handle;
    return handle;
}
