/**
 * pipeline-analytics.js — Superadmin-only live health check of every
 * external data pipeline the app consumes.
 *
 * On demand (panel open / manual refresh), probe each Edge proxy once and
 * record:
 *   - HTTP status
 *   - upstream latency (client-side round-trip ms; includes CDN cache hits)
 *   - payload freshness (age_seconds / fetched_at when present)
 *   - error detail on failure
 *
 * The module is fully client-side. It does not write any Supabase rows; it
 * just hits the same Edge proxies end users hit, which means the readings
 * reflect what a visitor would actually experience from this browser's
 * POP. That's the right signal for production triage.
 *
 * Usage (from dashboard.html):
 *   import { renderPipelineAnalytics } from './js/pipeline-analytics.js';
 *   renderPipelineAnalytics(document.getElementById('pipeline-health'));
 *
 * The panel is keyed off a role check in dashboard.html before this module
 * is imported — non-superadmins should never load it.
 */

// Every external pipeline we want to watch. `freshKey` names the field on
// the JSON response (if any) that reports age_seconds; pipelines without one
// fall back to "request completed" as the freshness proxy.
const PIPELINES = [
    { key: 'noaa-kp',      label: 'NOAA Kp (1-min)',      group: 'Space Weather', url: '/api/noaa/kp-1m',                  freshKey: 'age_min',     freshUnit: 'min', target: 2 },
    { key: 'noaa-dst',     label: 'NOAA Dst',             group: 'Space Weather', url: '/api/noaa/dst',                    freshKey: 'age_min',     freshUnit: 'min', target: 15 },
    { key: 'noaa-xray',    label: 'GOES X-ray',           group: 'Space Weather', url: '/api/noaa/xray',                   freshKey: null,          target: 10 },
    { key: 'noaa-aurora',  label: 'OVATION Aurora',       group: 'Space Weather', url: '/api/noaa/aurora',                 freshKey: null,          target: 15 },
    { key: 'noaa-flares',  label: 'X-ray Flares (7d)',    group: 'Space Weather', url: '/api/noaa/flares',                 freshKey: null,          target: 60 },
    { key: 'noaa-regions', label: 'Solar Regions',        group: 'Space Weather', url: '/api/noaa/regions',                freshKey: null,          target: 1440 },
    { key: 'noaa-alerts',  label: 'SWPC Alerts',          group: 'Space Weather', url: '/api/noaa/alerts',                 freshKey: null,          target: 15 },
    { key: 'noaa-protons', label: 'GOES Protons (SEP)',   group: 'Space Weather', url: '/api/noaa/protons',                freshKey: null,          target: 10 },
    { key: 'noaa-electrons', label: 'GOES Electrons',     group: 'Space Weather', url: '/api/noaa/electrons',              freshKey: null,          target: 10 },
    { key: 'noaa-radio',   label: 'F10.7 Radio Flux',     group: 'Space Weather', url: '/api/noaa/radio-flux',             freshKey: null,          target: 1440 },

    { key: 'donki-cme',    label: 'DONKI CME',            group: 'NASA DONKI',    url: '/api/donki/cme',                   freshKey: null,          target: 60 },
    { key: 'donki-flares', label: 'DONKI Flares',         group: 'NASA DONKI',    url: '/api/donki/flares',                freshKey: null,          target: 60 },
    { key: 'donki-gst',    label: 'DONKI Geo Storms',     group: 'NASA DONKI',    url: '/api/donki/gst',                   freshKey: null,          target: 60 },
    { key: 'donki-sep',    label: 'DONKI SEP',            group: 'NASA DONKI',    url: '/api/donki/sep',                   freshKey: null,          target: 60 },
    { key: 'donki-notif',  label: 'DONKI Notifications',  group: 'NASA DONKI',    url: '/api/donki/notifications',         freshKey: null,          target: 60 },

    { key: 'celestrak',    label: 'CelesTrak TLE',        group: 'Orbital',       url: '/api/celestrak/tle?group=stations', freshKey: null,         target: 240 },
    { key: 'solar-wind',   label: 'ACE Solar Wind',       group: 'Space Weather', url: '/api/solar-wind/wind-speed',       freshKey: null,          target: 10 },
    { key: 'launches',     label: 'Launch Library 2',     group: 'Launches',      url: '/api/launches/upcoming?limit=10',  freshKey: null,          target: 120 },
    { key: 'weather-grid', label: 'Open-Meteo Grid',      group: 'Weather',       url: '/api/weather/grid',                freshKey: 'age_seconds', freshUnit: 's', target: 3600 },
];

const PROBE_TIMEOUT_MS = 8000;

/**
 * Probe a single pipeline. Returns a result row with status, latency, and
 * whichever freshness signal the upstream exposes (age_seconds / fetched_at).
 */
async function probe(pipe) {
    const started = performance.now();
    const t0 = Date.now();
    const row = {
        ...pipe,
        status:      'loading',
        http_status: null,
        latency_ms:  null,
        age_sec:     null,
        error:       null,
        probed_at:   t0,
    };

    try {
        const res = await fetch(pipe.url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        row.latency_ms  = Math.round(performance.now() - started);
        row.http_status = res.status;

        if (!res.ok) {
            row.status = 'error';
            row.error  = `HTTP ${res.status}`;
            // Try to surface the proxy's structured error detail
            try {
                const body = await res.json();
                if (body.error) row.error = `HTTP ${res.status}: ${body.error}`;
            } catch (_) {}
            return row;
        }

        const body = await res.json();
        if (body.error) {
            row.status = 'error';
            row.error  = String(body.error);
            return row;
        }

        // Freshness: explicit age field wins; otherwise derive from fetched_at.
        if (pipe.freshKey && typeof body[pipe.freshKey] === 'number') {
            row.age_sec = pipe.freshUnit === 'min'
                ? body[pipe.freshKey] * 60
                : body[pipe.freshKey];
        } else if (typeof body.fetched_at === 'string') {
            const t = Date.parse(body.fetched_at);
            if (Number.isFinite(t)) row.age_sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
        }

        // Verdict for the row
        const targetSec = pipe.target * 60;  // pipeline `target` is minutes
        if (row.age_sec != null && row.age_sec > targetSec * 2) {
            row.status = 'stale';
        } else if (row.age_sec != null && row.age_sec > targetSec) {
            row.status = 'warn';
        } else {
            row.status = 'ok';
        }
        return row;
    } catch (e) {
        row.latency_ms = Math.round(performance.now() - started);
        row.status     = e.name === 'TimeoutError' ? 'timeout' : 'error';
        row.error      = e.message || String(e);
        return row;
    }
}

function ageLabel(sec) {
    if (sec == null || !Number.isFinite(sec)) return '—';
    if (sec < 60)    return `${Math.round(sec)}s`;
    if (sec < 3600)  return `${Math.round(sec / 60)}m`;
    if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
    return `${(sec / 86400).toFixed(1)}d`;
}

function statusColor(s) {
    switch (s) {
        case 'ok':      return '#44cc88';
        case 'warn':    return '#ffaa00';
        case 'stale':   return '#ff8800';
        case 'timeout': return '#ff4444';
        case 'error':   return '#ff4444';
        case 'loading': return '#6688aa';
        default:        return '#888';
    }
}

function statusLabel(s) {
    switch (s) {
        case 'ok':      return 'OK';
        case 'warn':    return 'Slow refresh';
        case 'stale':   return 'Stale';
        case 'timeout': return 'Timeout';
        case 'error':   return 'Down';
        case 'loading': return '…';
        default:        return s;
    }
}

function renderRow(r) {
    const c = statusColor(r.status);
    const latency = r.latency_ms != null ? `${r.latency_ms} ms` : '—';
    const age     = ageLabel(r.age_sec);
    const detail  = r.error ? `<span class="pipe-err" title="${escHtml(r.error)}">${escHtml(r.error)}</span>`
                            : `<span class="pipe-dim">${escHtml(r.url)}</span>`;
    return `
        <div class="pipe-row">
            <span class="pipe-dot" style="background:${c}"></span>
            <span class="pipe-name">${escHtml(r.label)}</span>
            <span class="pipe-group">${escHtml(r.group)}</span>
            <span class="pipe-status" style="color:${c}">${escHtml(statusLabel(r.status))}</span>
            <span class="pipe-latency">${latency}</span>
            <span class="pipe-age">${age}</span>
            <span class="pipe-detail">${detail}</span>
        </div>
    `;
}

function escHtml(s) {
    return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function summaryBar(rows) {
    const total = rows.length;
    const ok    = rows.filter(r => r.status === 'ok').length;
    const warn  = rows.filter(r => r.status === 'warn' || r.status === 'stale').length;
    const down  = rows.filter(r => r.status === 'error' || r.status === 'timeout').length;
    const p95   = rows.map(r => r.latency_ms).filter(Number.isFinite).sort((a, b) => a - b);
    const p95v  = p95.length ? p95[Math.floor(p95.length * 0.95) - 1] ?? p95[p95.length - 1] : null;
    return `
        <div class="pipe-summary">
            <div class="pipe-sum-cell"><div class="pipe-sum-k">Pipelines</div><div class="pipe-sum-v">${total}</div></div>
            <div class="pipe-sum-cell"><div class="pipe-sum-k">Healthy</div><div class="pipe-sum-v" style="color:#44cc88">${ok}</div></div>
            <div class="pipe-sum-cell"><div class="pipe-sum-k">Warning</div><div class="pipe-sum-v" style="color:#ffaa00">${warn}</div></div>
            <div class="pipe-sum-cell"><div class="pipe-sum-k">Down</div><div class="pipe-sum-v" style="color:#ff4444">${down}</div></div>
            <div class="pipe-sum-cell"><div class="pipe-sum-k">Latency p95</div><div class="pipe-sum-v">${p95v != null ? p95v + ' ms' : '—'}</div></div>
        </div>
    `;
}

// Style (injected once; only loaded when a superadmin opens the dashboard).
let _stylesInjected = false;
function injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    const css = `
        .pipe-wrap { font-size:.78rem; }
        .pipe-summary { display:grid; grid-template-columns:repeat(5, 1fr); gap:10px; margin-bottom:14px; }
        .pipe-sum-cell { background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.06); border-radius:6px; padding:8px 10px; }
        .pipe-sum-k { font-size:.62rem; color:#778; text-transform:uppercase; letter-spacing:.06em; font-weight:700; margin-bottom:2px; }
        .pipe-sum-v { font-size:.9rem; font-weight:700; font-family:monospace; color:#ccd; }
        .pipe-actions { display:flex; gap:8px; margin-bottom:10px; align-items:center; }
        .pipe-btn { background:rgba(0,200,200,.12); border:1px solid rgba(0,200,200,.3); color:#0cc; border-radius:5px; padding:5px 12px; font-size:.72rem; font-weight:600; font-family:inherit; cursor:pointer; }
        .pipe-btn:hover { background:rgba(0,200,200,.22); color:#0ff; }
        .pipe-btn[disabled] { opacity:.5; cursor:wait; }
        .pipe-stamp { margin-left:auto; font-size:.68rem; color:#778; font-family:monospace; }
        .pipe-head, .pipe-row {
            display:grid;
            grid-template-columns:14px 1.4fr 1fr .8fr .8fr .7fr 2fr;
            gap:10px; align-items:center;
            padding:6px 8px; font-family:monospace; font-size:.72rem;
        }
        .pipe-head { background:rgba(255,255,255,.03); border-radius:4px; color:#778; text-transform:uppercase; letter-spacing:.05em; font-weight:700; font-size:.62rem; margin-bottom:4px; }
        .pipe-row { border-bottom:1px solid rgba(255,255,255,.04); color:#bbd; }
        .pipe-row:last-child { border-bottom:none; }
        .pipe-dot { width:8px; height:8px; border-radius:50%; }
        .pipe-name { font-weight:600; color:#ddf; }
        .pipe-group { color:#889; }
        .pipe-status { font-weight:700; font-size:.7rem; }
        .pipe-latency, .pipe-age { color:#ace; text-align:right; }
        .pipe-detail { color:#667; font-size:.66rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .pipe-err { color:#f88; }
        .pipe-dim { color:#556; }
        @media (max-width:760px) {
            .pipe-summary { grid-template-columns:repeat(2, 1fr); }
            .pipe-head { display:none; }
            .pipe-row { grid-template-columns:14px 1fr 1fr; grid-auto-rows:min-content; padding:8px; }
            .pipe-group, .pipe-detail { display:none; }
        }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
}

/**
 * Mount the pipeline analytics panel into `host`. Kicks off a probe of every
 * pipeline in parallel, then renders rows as they complete.
 * Returns a disposer that cancels in-flight UI updates.
 */
export function renderPipelineAnalytics(host) {
    if (!host) return () => {};
    injectStyles();

    let disposed = false;

    const draw = (rows, probingAll) => {
        if (disposed) return;
        host.innerHTML = `
            <div class="pipe-wrap">
                ${summaryBar(rows)}
                <div class="pipe-actions">
                    <button class="pipe-btn" id="pipe-refresh" ${probingAll ? 'disabled' : ''}>${probingAll ? 'Probing…' : 'Refresh all'}</button>
                    <span class="pipe-stamp">Last probe: ${new Date().toLocaleTimeString()}</span>
                </div>
                <div class="pipe-head">
                    <span></span>
                    <span>Pipeline</span>
                    <span>Group</span>
                    <span>Status</span>
                    <span style="text-align:right">Latency</span>
                    <span style="text-align:right">Age</span>
                    <span>Detail</span>
                </div>
                ${rows.map(renderRow).join('')}
            </div>
        `;
        host.querySelector('#pipe-refresh')?.addEventListener('click', () => run());
    };

    async function run() {
        // Seed with "loading" rows so the table doesn't flash empty.
        const rows = PIPELINES.map(p => ({ ...p, status: 'loading', latency_ms: null, age_sec: null, error: null }));
        draw(rows, true);

        // Fire all probes in parallel; redraw the whole table when each resolves
        // (cheap since the row count is small).
        await Promise.all(PIPELINES.map(async (p, i) => {
            const r = await probe(p);
            rows[i] = r;
            draw(rows, true);
        }));
        draw(rows, false);
    }

    run();

    return () => { disposed = true; };
}
