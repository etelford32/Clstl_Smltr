/**
 * extremes-watch.js — global extreme-weather watch (feed + panel section)
 * ════════════════════════════════════════════════════════════════════════
 * Two cooperating pieces, one file (they ship together or not at all):
 *
 *   ExtremesFeed
 *     Polls two keyless sources and re-dispatches window CustomEvents:
 *       /api/weather/extremes      →  'extremes-update'   (30 min)
 *         Percentile analysis vs the 30-day weather_grid_cache archive,
 *         computed hourly inside Postgres (see supabase-weather-extremes-
 *         migration.sql). Categories: heat / cold / wind / precip, each
 *         entry a clustered event with a region label and severity
 *         (1 ≥p95 · 2 ≥p99 · 3 = beyond the 30-day record).
 *       NASA EONET v3 wildfires    →  'wildfires-update'  (30 min)
 *         Open wildfire events (browser-direct — EONET is CORS-open and
 *         keyless, same access pattern as the NOAA feeds). Mid-summer
 *         fire season is exactly when this list earns its pixels.
 *
 *   attachExtremesSection(panelEl, opts)
 *     Renders a compact "Global extremes" section INSIDE the existing
 *     storm-watch panel, inserted before its footer. Deliberately does
 *     not touch StormWatchPanel internals — the storm list re-renders
 *     by rewriting its own #storm-watch-panel-list, so a sibling section
 *     is safe from its innerHTML rewrites (and vice versa). Click a row
 *     → fly the camera there via the same flyToLatLon hook storm cards
 *     use.
 *
 * All CSS is namespaced .swx-* and injected once.
 */

const EXTREMES_ENDPOINT = '/api/weather/extremes';
// days=14 keeps the payload sane in peak season; recency-ranked below.
const EONET_WILDFIRES   = 'https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires&status=open&days=14';

const POLL_MS = 30 * 60 * 1000;   // both sources refresh at ~hourly cadence

// ── Feed ────────────────────────────────────────────────────────────────────

export class ExtremesFeed {
    constructor({ pollInterval = POLL_MS } = {}) {
        this.pollInterval = pollInterval;
        this._timers = [];
        this.extremes  = null;    // last /api/weather/extremes body
        this.wildfires = [];      // normalised EONET events
    }

    start() {
        this._pollExtremes();
        this._pollWildfires();
        this._timers.push(setInterval(() => this._pollExtremes(),  this.pollInterval));
        this._timers.push(setInterval(() => this._pollWildfires(), this.pollInterval));
        return this;
    }

    stop() {
        this._timers.forEach(clearInterval);
        this._timers = [];
    }

    async _pollExtremes() {
        try {
            const r = await fetch(EXTREMES_ENDPOINT, { cache: 'no-cache' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            this.extremes = await r.json();
            window.dispatchEvent(new CustomEvent('extremes-update', {
                detail: { status: 'live', data: this.extremes },
            }));
        } catch (err) {
            console.debug('[ExtremesFeed] extremes poll failed:', err.message);
            window.dispatchEvent(new CustomEvent('extremes-update', {
                detail: { status: 'stale', data: this.extremes },
            }));
        }
    }

    async _pollWildfires() {
        try {
            const r = await fetch(EONET_WILDFIRES, { cache: 'no-cache' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const body = await r.json();
            this.wildfires = (body?.events ?? [])
                // Controlled burns are routine land management, not extreme
                // events — EONET labels them "Prescribed Fire …".
                .filter(ev => !/^prescribed fire/i.test(ev?.title ?? ''))
                .map(ev => {
                    const pts = (ev.geometry ?? [])
                        .filter(g => g.type === 'Point' && Array.isArray(g.coordinates));
                    const last = pts[pts.length - 1];
                    if (!last) return null;
                    return {
                        id:    ev.id,
                        title: ev.title ?? 'Wildfire',
                        lat:   last.coordinates[1],
                        lon:   last.coordinates[0],
                        t:     Date.parse(last.date) || 0,
                    };
                })
                .filter(Boolean)
                .sort((a, b) => b.t - a.t);
            window.dispatchEvent(new CustomEvent('wildfires-update', {
                detail: { status: 'live', fires: this.wildfires },
            }));
        } catch (err) {
            console.debug('[ExtremesFeed] wildfire poll failed:', err.message);
            window.dispatchEvent(new CustomEvent('wildfires-update', {
                detail: { status: 'stale', fires: this.wildfires },
            }));
        }
    }
}

// ── Panel section ───────────────────────────────────────────────────────────

const STYLE_ID   = 'extremes-watch-style';
const SECTION_ID = 'extremes-watch-section';

const CATEGORY_META = {
    heat:   { icon: '🌡️', label: 'Heat',  fmt: e => `${e.value}°C`,   sub: e => `p95 ${e.p95}° · 30d max ${e.wmax}°` },
    cold:   { icon: '❄️', label: 'Cold',  fmt: e => `${e.value}°C`,   sub: e => `p05 ${e.p05}° · 30d min ${e.wmin}°` },
    wind:   { icon: '💨', label: 'Wind',  fmt: e => `${e.value} m/s`, sub: e => `p95 ${e.p95} · 30d max ${e.wmax}` },
    precip: { icon: '🌧️', label: 'Rain',  fmt: e => `${e.value} mm`,  sub: e => `p95 ${e.p95} · 30d max ${e.wmax}` },
};

// How many rows each category may contribute (headline events only —
// the full analysis stays one click away in the API response).
const MAX_ROWS = { heat: 4, cold: 3, wind: 3, precip: 3, fires: 5 };

const SEV_BADGE = {
    1: { text: 'p95', cls: 'swx-sev1' },
    2: { text: 'p99', cls: 'swx-sev2' },
    3: { text: 'REC', cls: 'swx-sev3' },   // beyond the 30-day record
};

function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        #${SECTION_ID} {
            border-top: 1px solid rgba(120,140,190,.25);
            margin-top: 6px; padding-top: 5px;
        }
        #${SECTION_ID} .swx-head {
            display: flex; align-items: baseline; gap: 6px;
            font-size: 10.5px; letter-spacing: .06em; color: #9fb0d8;
            text-transform: uppercase; margin-bottom: 3px;
        }
        #${SECTION_ID} .swx-head .swx-sub { text-transform: none; letter-spacing: 0;
            color: #667; font-size: 9px; }
        #${SECTION_ID} .swx-row {
            display: flex; align-items: center; gap: 5px;
            padding: 2px 3px; border-radius: 5px; cursor: pointer;
            font-size: 10.5px; line-height: 1.35; color: #cdd6ee;
        }
        #${SECTION_ID} .swx-row:hover { background: rgba(90,120,200,.14); }
        #${SECTION_ID} .swx-icon { flex: 0 0 14px; text-align: center; font-size: 11px; }
        #${SECTION_ID} .swx-main { flex: 1 1 auto; min-width: 0; overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; }
        #${SECTION_ID} .swx-val  { flex: 0 0 auto; font-variant-numeric: tabular-nums;
            color: #fff; }
        #${SECTION_ID} .swx-badge {
            flex: 0 0 auto; font-size: 8.5px; font-weight: 700;
            border-radius: 3px; padding: 0 4px; line-height: 13px;
        }
        #${SECTION_ID} .swx-sev1 { background: #3a5f8a; color: #cfe4ff; }
        #${SECTION_ID} .swx-sev2 { background: #8a6d2a; color: #ffe9b8; }
        #${SECTION_ID} .swx-sev3 { background: #a03040; color: #ffd7dd; }
        #${SECTION_ID} .swx-sub-line { font-size: 8.5px; color: #778; margin: -2px 0 1px 22px; }
        #${SECTION_ID} .swx-empty { font-size: 10px; color: #667; padding: 2px 3px 4px; }
        #${SECTION_ID} .swx-foot  { font-size: 8.5px; color: #556; margin-top: 3px; }
    `;
    document.head.appendChild(style);
}

/**
 * Mount the section into the storm-watch panel (before its footer) and
 * subscribe to the feed events. Returns { destroy() }.
 *
 * @param {HTMLElement} panelEl   StormWatchPanel root (`panel.element`)
 * @param {object}   [opts]
 * @param {(lat:number, lon:number)=>void} [opts.onFly]  camera hook;
 *        defaults to window.flyToLatLon when available.
 */
export function attachExtremesSection(panelEl, { onFly } = {}) {
    if (!panelEl) return { destroy() {} };
    injectStyle();

    const section = document.createElement('div');
    section.id = SECTION_ID;
    section.innerHTML = `
        <div class="swx-head">Global extremes
            <span class="swx-sub" id="${SECTION_ID}-meta">warming up…</span>
        </div>
        <div id="${SECTION_ID}-list"><div class="swx-empty">Waiting for first analysis…</div></div>
        <div class="swx-foot">Percentiles vs each cell's own 30-day history · fires: NASA EONET</div>
    `;
    // Into the panel's scrollable .panel-body, just before its footer —
    // that keeps the section inside the 60vh scroll region AND inside the
    // minimize-collapse area. (The foot is a child of .panel-body, not of
    // the panel root.) Fall back to appending to the root if the panel
    // markup ever changes.
    const foot = panelEl.querySelector('#storm-watch-panel-foot');
    if (foot?.parentElement) foot.parentElement.insertBefore(section, foot);
    else panelEl.appendChild(section);

    const listEl = section.querySelector(`#${SECTION_ID}-list`);
    const metaEl = section.querySelector(`#${SECTION_ID}-meta`);

    let extremes  = null;
    let wildfires = [];

    const fly = onFly
        ?? ((lat, lon) => { window.flyToLatLon?.(lat, lon); });

    function rowHtml({ icon, main, sub, val, sev, lat, lon }) {
        const badge = sev ? SEV_BADGE[sev] : null;
        return `
            <div class="swx-row" data-lat="${lat}" data-lon="${lon}" title="Click to fly there">
                <span class="swx-icon">${icon}</span>
                <span class="swx-main">${main}</span>
                <span class="swx-val">${val ?? ''}</span>
                ${badge ? `<span class="swx-badge ${badge.cls}">${badge.text}</span>` : ''}
            </div>
            ${sub ? `<div class="swx-sub-line">${sub}</div>` : ''}`;
    }

    function render() {
        const rows = [];

        if (extremes?.categories) {
            for (const [key, meta] of Object.entries(CATEGORY_META)) {
                const events = (extremes.categories[key] ?? []).slice(0, MAX_ROWS[key]);
                for (const e of events) {
                    rows.push(rowHtml({
                        icon: meta.icon,
                        main: e.region ?? `${e.lat}, ${e.lon}`,
                        sub:  meta.sub(e) + (e.cells > 1 ? ` · ${e.cells} cells` : ''),
                        val:  meta.fmt(e),
                        sev:  e.sev,
                        lat:  e.lat, lon: e.lon,
                    }));
                }
            }
        }

        for (const f of wildfires.slice(0, MAX_ROWS.fires)) {
            rows.push(rowHtml({
                icon: '🔥',
                main: f.title,
                val:  '',
                sev:  null,
                lat:  f.lat, lon: f.lon,
            }));
        }

        listEl.innerHTML = rows.length
            ? rows.join('')
            : `<div class="swx-empty">No global extremes flagged in the current frame.</div>`;

        const nFires = wildfires.length;
        const s = extremes?.summary;
        metaEl.textContent = [
            s ? `${s.record_cells ?? 0} record cells` : null,
            nFires ? `${nFires} active fires` : null,
        ].filter(Boolean).join(' · ') || '—';
    }

    function onRowClick(ev) {
        const row = ev.target.closest('.swx-row');
        if (!row) return;
        const lat = parseFloat(row.dataset.lat);
        const lon = parseFloat(row.dataset.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) fly(lat, lon);
    }

    function onExtremes(ev)  { extremes  = ev.detail?.data ?? extremes;  render(); }
    function onWildfires(ev) { wildfires = ev.detail?.fires ?? wildfires; render(); }

    listEl.addEventListener('click', onRowClick);
    window.addEventListener('extremes-update',  onExtremes);
    window.addEventListener('wildfires-update', onWildfires);

    return {
        destroy() {
            window.removeEventListener('extremes-update',  onExtremes);
            window.removeEventListener('wildfires-update', onWildfires);
            section.remove();
        },
    };
}
