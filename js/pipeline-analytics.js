/**
 * pipeline-analytics.js — Superadmin-only live health check of every
 * external data pipeline the app consumes.
 *
 * On demand (panel open / manual refresh / auto-refresh), probe each Edge
 * proxy once and record:
 *   - HTTP status
 *   - upstream latency (client-side round-trip ms; includes CDN cache hits)
 *   - payload freshness (age_seconds / fetched_at when present)
 *   - error detail on failure (with one auto-retry on 5xx / timeout)
 *
 * Triage features (matter when something is on fire):
 *   - Rows sort by severity (down → timeout → stale → warn → ok) so the
 *     worst is always at the top.
 *   - Per-row ↻ retry button so a single flaky pipeline can be re-probed
 *     without re-hammering the other 18.
 *   - Filter chips for group ("Space Weather" / "NASA DONKI" / …) and a
 *     "down/stale only" toggle for triage.
 *   - Optional 60 s auto-refresh while the System tab is open.
 *
 * Fully client-side. No Supabase writes; readings reflect what a real
 * visitor would see from this POP.
 *
 * Usage (from admin.html):
 *   import { renderPipelineAnalytics } from './js/pipeline-analytics.js';
 *   renderPipelineAnalytics(document.getElementById('pipeline-health'));
 *
 * Caller is responsible for gating on role — non-superadmins should never
 * load this module.
 */

// Every external pipeline we want to watch. `freshKey` names the field on
// the JSON response (if any) that reports age_seconds; pipelines without one
// fall back to "request completed" as the freshness proxy.
const PIPELINES = [
    // Targets are warn-at-1×, stale-at-2× (see probeOnce). They must absorb
    // the full publication chain — NOAA's own 2-5 min lag + edge cache —
    // not just the nominal product cadence. target:2 on the 1-min feeds
    // pinned these rows "stale" at their healthy steady state (5-8 min);
    // Dst is an HOURLY product, so target:15 flagged it around the clock.
    { key: 'noaa-kp',      label: 'NOAA Kp (1-min)',      group: 'Space Weather', url: '/api/noaa/kp-1m',                  freshKey: 'age_min',     freshUnit: 'min', target: 10 },
    { key: 'noaa-dst',     label: 'NOAA Dst',             group: 'Space Weather', url: '/api/noaa/dst',                    freshKey: 'age_min',     freshUnit: 'min', target: 90 },
    { key: 'noaa-xray',    label: 'GOES X-ray',           group: 'Space Weather', url: '/api/noaa/xray',                   freshKey: null,          target: 10 },
    { key: 'noaa-aurora',  label: 'OVATION Aurora',       group: 'Space Weather', url: '/api/noaa/aurora',                 freshKey: null,          target: 15 },
    { key: 'noaa-flares',  label: 'X-ray Flares (7d)',    group: 'Space Weather', url: '/api/noaa/flares',                 freshKey: null,          target: 60 },
    { key: 'noaa-regions', label: 'Solar Regions',        group: 'Space Weather', url: '/api/noaa/regions',                freshKey: null,          target: 1440 },
    { key: 'noaa-alerts',  label: 'SWPC Alerts',          group: 'Space Weather', url: '/api/noaa/alerts',                 freshKey: null,          target: 15 },
    { key: 'noaa-protons', label: 'GOES Protons (SEP)',   group: 'Space Weather', url: '/api/noaa/protons',                freshKey: null,          target: 10 },
    { key: 'noaa-electrons', label: 'GOES Electrons',     group: 'Space Weather', url: '/api/noaa/electrons',              freshKey: null,          target: 10 },
    { key: 'noaa-radio',   label: 'F10.7 Radio Flux',     group: 'Space Weather', url: '/api/noaa/radio-flux',             freshKey: null,          target: 1440 },

    // timeoutMs 16000 on DONKI: api.nasa.gov takes 8-15 s on a cold cache —
    // the global 8 s probe abort reported healthy-but-slow rows as timeouts.
    { key: 'donki-cme',    label: 'DONKI CME',            group: 'NASA DONKI',    url: '/api/donki/cme',                   freshKey: null,          target: 60, timeoutMs: 16_000 },
    { key: 'donki-flares', label: 'DONKI Flares',         group: 'NASA DONKI',    url: '/api/donki/flares',                freshKey: null,          target: 60, timeoutMs: 16_000 },
    { key: 'donki-gst',    label: 'DONKI Geo Storms',     group: 'NASA DONKI',    url: '/api/donki/gst',                   freshKey: null,          target: 60, timeoutMs: 16_000 },
    { key: 'donki-sep',    label: 'DONKI SEP',            group: 'NASA DONKI',    url: '/api/donki/sep',                   freshKey: null,          target: 60, timeoutMs: 16_000 },
    { key: 'donki-notif',  label: 'DONKI Notifications',  group: 'NASA DONKI',    url: '/api/donki/notifications',         freshKey: null,          target: 60, timeoutMs: 16_000 },

    { key: 'celestrak',    label: 'CelesTrak TLE',        group: 'Orbital',       url: '/api/celestrak/tle?group=stations', freshKey: null,         target: 240 },
    { key: 'solar-wind',   label: 'DSCOVR Solar Wind',    group: 'Space Weather', url: '/api/solar-wind/latest',           freshKey: 'age_min',     freshUnit: 'min', target: 10 },
    { key: 'launches',     label: 'Launch Library 2',     group: 'Launches',      url: '/api/launches/upcoming?limit=10',  freshKey: null,          target: 120 },
    { key: 'weather-grid', label: 'Open-Meteo Grid',      group: 'Weather',       url: '/api/weather/grid',                freshKey: 'age_seconds', freshUnit: 's', target: 3600 },
];

const PROBE_TIMEOUT_MS = 8000;
const AUTO_REFRESH_MS  = 60_000;   // 60 s when the toggle is on
const RETRY_BACKOFF_MS = 500;      // one auto-retry on 5xx / timeout

// Severity rank — lower is worse; used both for row sort and the down-only
// filter. Keeping this in one place so the table order and the "down only"
// toggle stay consistent.
const SEVERITY = { error: 0, timeout: 1, stale: 2, warn: 3, loading: 4, ok: 5 };

/**
 * Coerce an error-ish value into a short human string. Never returns
 * "[object Object]" — Vercel's runtime occasionally replies to a crashed
 * Edge function with a JSON body whose `error` field is itself an object
 * ({ code, message, …}), and raw template concatenation rendered that as
 * "[object Object]" in the panel, leaving the operator with no clue what
 * actually broke.
 */
function stringifyErr(v) {
    if (v == null)            return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    // Prefer known error-shape fields, in order of specificity.
    const cand = v.message ?? v.detail ?? v.error ?? v.code ?? v.reason ?? null;
    if (typeof cand === 'string') return cand;
    try { return JSON.stringify(v).slice(0, 200); } catch { return String(v); }
}

/**
 * One probe attempt. Returns a partial row; caller decides whether to retry.
 * Status will be 'ok' / 'warn' / 'stale' / 'error' / 'timeout'.
 */
async function probeOnce(pipe) {
    const started = performance.now();
    const row = {
        ...pipe,
        status:      'loading',
        http_status: null,
        latency_ms:  null,
        age_sec:     null,
        error:       null,
        probed_at:   Date.now(),
    };

    try {
        const res = await fetch(pipe.url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(pipe.timeoutMs ?? PROBE_TIMEOUT_MS),
            cache: 'no-store',   // bypass SW / browser cache so we see the CDN's view
        });
        row.latency_ms  = Math.round(performance.now() - started);
        row.http_status = res.status;

        if (!res.ok) {
            row.status = 'error';
            row.error  = `HTTP ${res.status}`;
            try {
                const body = await res.json();
                const detail = stringifyErr(body?.detail) || stringifyErr(body?.error) || stringifyErr(body);
                if (detail) row.error = `HTTP ${res.status}: ${detail}`;
            } catch (_) {}
            return row;
        }

        const body = await res.json();
        if (body.error) {
            row.status = 'error';
            row.error  = stringifyErr(body.error) || stringifyErr(body);
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
        row.error      = stringifyErr(e) || 'unknown error';
        return row;
    }
}

/**
 * Probe with one automatic retry on transient failure (5xx / timeout).
 * DONKI in particular is observed to 503 intermittently and recover on the
 * very next request; a single retry catches that case without doubling the
 * load on healthy endpoints. 4xx is treated as a real failure (no retry).
 */
async function probe(pipe) {
    const first = await probeOnce(pipe);
    const transient =
        first.status === 'timeout' ||
        (first.status === 'error' && (first.http_status == null || first.http_status >= 500));
    if (!transient) return first;

    await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS));
    const second = await probeOnce(pipe);
    // Annotate so the UI can show that we already auto-retried (helps the
    // operator understand "why is this row taking ~1.5s longer than peers").
    second.retried = true;
    if (second.status !== 'ok' && first.error && !second.error) {
        second.error = first.error;
    }
    return second;
}

function ageLabel(sec) {
    if (sec == null || !Number.isFinite(sec)) return '—';
    if (sec < 60)    return `${Math.round(sec)}s`;
    if (sec < 3600)  return `${Math.round(sec / 60)}m`;
    if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
    return `${(sec / 86400).toFixed(1)}d`;
}

function probedAtLabel(ts) {
    if (!ts) return '—';
    const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (sec < 5)     return 'just now';
    if (sec < 60)    return `${sec}s ago`;
    if (sec < 3600)  return `${Math.round(sec / 60)}m ago`;
    return `${(sec / 3600).toFixed(1)}h ago`;
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

function escHtml(s) {
    return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderRow(r) {
    const c = statusColor(r.status);
    const latency = r.latency_ms != null ? `${r.latency_ms} ms` : '—';
    const age     = ageLabel(r.age_sec);
    const probed  = probedAtLabel(r.probed_at);
    const detail  = r.error ? `<span class="pipe-err" title="${escHtml(r.error)}">${escHtml(r.error)}</span>`
                            : `<span class="pipe-dim">${escHtml(r.url)}</span>`;
    // ↻ button data-attr lets the host handle clicks via event delegation,
    // so we don't have to wire up N listeners on every redraw.
    const retried = r.retried
        ? `<span class="pipe-retried" title="auto-retried after transient failure">↺</span>`
        : '';
    const busy = r.status === 'loading' ? 'disabled' : '';
    return `
        <div class="pipe-row" data-key="${escHtml(r.key)}" data-status="${escHtml(r.status)}" data-group="${escHtml(r.group)}">
            <span class="pipe-dot" style="background:${c}"></span>
            <span class="pipe-name">${escHtml(r.label)}${retried}</span>
            <span class="pipe-group">${escHtml(r.group)}</span>
            <span class="pipe-status" style="color:${c}">${escHtml(statusLabel(r.status))}</span>
            <span class="pipe-latency">${latency}</span>
            <span class="pipe-age">${age}</span>
            <span class="pipe-probed">${probed}</span>
            <span class="pipe-detail">${detail}</span>
            <button class="pipe-retry" data-retry="${escHtml(r.key)}" ${busy} title="Re-probe this endpoint">↻</button>
        </div>
    `;
}

function summaryBar(rows) {
    const total = rows.length;
    const ok    = rows.filter(r => r.status === 'ok').length;
    const warn  = rows.filter(r => r.status === 'warn' || r.status === 'stale').length;
    const down  = rows.filter(r => r.status === 'error' || r.status === 'timeout').length;
    const p95   = rows.map(r => r.latency_ms).filter(Number.isFinite).sort((a, b) => a - b);
    const p95v  = p95.length ? p95[Math.floor(p95.length * 0.95) - 1] ?? p95[p95.length - 1] : null;
    return `
        <div class="pipe-summary" data-severity="${down > 0 ? 'down' : (warn > 0 ? 'warn' : 'ok')}">
            <div class="pipe-sum-cell"><div class="pipe-sum-k">Pipelines</div><div class="pipe-sum-v">${total}</div></div>
            <div class="pipe-sum-cell"><div class="pipe-sum-k">Healthy</div><div class="pipe-sum-v" style="color:#44cc88">${ok}</div></div>
            <div class="pipe-sum-cell"><div class="pipe-sum-k">Warning</div><div class="pipe-sum-v" style="color:#ffaa00">${warn}</div></div>
            <div class="pipe-sum-cell"><div class="pipe-sum-k">Down</div><div class="pipe-sum-v" style="color:${down > 0 ? '#ff4444' : '#556'}">${down}</div></div>
            <div class="pipe-sum-cell"><div class="pipe-sum-k">Latency p95</div><div class="pipe-sum-v">${p95v != null ? p95v + ' ms' : '—'}</div></div>
        </div>
    `;
}

function filterChips(rows, state) {
    const groups = Array.from(new Set(PIPELINES.map(p => p.group)));
    const groupChips = groups.map(g => {
        const count = rows.filter(r => r.group === g).length;
        const active = state.group === g ? ' pipe-chip-active' : '';
        return `<button class="pipe-chip${active}" data-group-filter="${escHtml(g)}">${escHtml(g)} <span class="pipe-chip-count">${count}</span></button>`;
    }).join('');
    const allActive = state.group == null ? ' pipe-chip-active' : '';
    const downActive = state.downOnly ? ' pipe-chip-active pipe-chip-warn' : '';
    return `
        <div class="pipe-filters">
            <button class="pipe-chip${allActive}" data-group-filter="">All</button>
            ${groupChips}
            <span class="pipe-filter-spacer"></span>
            <button class="pipe-chip${downActive}" data-down-only>Down/stale only</button>
        </div>
    `;
}

function applyFilterAndSort(rows, state) {
    let out = rows.slice();
    if (state.group) {
        out = out.filter(r => r.group === state.group);
    }
    if (state.downOnly) {
        out = out.filter(r => r.status === 'error' || r.status === 'timeout' || r.status === 'stale');
    }
    // Severity sort, ties broken by group then label for stable visual order.
    out.sort((a, b) => {
        const sa = SEVERITY[a.status] ?? 99;
        const sb = SEVERITY[b.status] ?? 99;
        if (sa !== sb) return sa - sb;
        if (a.group !== b.group) return a.group.localeCompare(b.group);
        return a.label.localeCompare(b.label);
    });
    return out;
}

// Style (injected once; only loaded when a superadmin opens the dashboard).
let _stylesInjected = false;
function injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    const css = `
        .pipe-wrap { font-size:.78rem; }
        .pipe-summary { display:grid; grid-template-columns:repeat(5, 1fr); gap:10px; margin-bottom:14px; border-radius:8px; padding:2px; transition:box-shadow .2s ease; }
        .pipe-summary[data-severity="down"] { box-shadow:0 0 0 1px rgba(255,80,80,.35), 0 0 18px rgba(255,80,80,.15); }
        .pipe-summary[data-severity="warn"] { box-shadow:0 0 0 1px rgba(255,170,0,.25); }
        .pipe-sum-cell { background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.06); border-radius:6px; padding:8px 10px; }
        .pipe-sum-k { font-size:.62rem; color:#778; text-transform:uppercase; letter-spacing:.06em; font-weight:700; margin-bottom:2px; }
        .pipe-sum-v { font-size:.9rem; font-weight:700; font-family:monospace; color:#ccd; }
        .pipe-actions { display:flex; gap:8px; margin-bottom:10px; align-items:center; flex-wrap:wrap; }
        .pipe-btn { background:rgba(0,200,200,.12); border:1px solid rgba(0,200,200,.3); color:#0cc; border-radius:5px; padding:5px 12px; font-size:.72rem; font-weight:600; font-family:inherit; cursor:pointer; }
        .pipe-btn:hover { background:rgba(0,200,200,.22); color:#0ff; }
        .pipe-btn[disabled] { opacity:.5; cursor:wait; }
        .pipe-auto { display:inline-flex; align-items:center; gap:6px; color:#9ab; font-size:.7rem; cursor:pointer; user-select:none; }
        .pipe-auto input { accent-color:#0cc; }
        .pipe-stamp { margin-left:auto; font-size:.68rem; color:#778; font-family:monospace; }
        .pipe-filters { display:flex; gap:6px; margin-bottom:10px; flex-wrap:wrap; align-items:center; }
        .pipe-chip { background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08); color:#9ab; border-radius:999px; padding:3px 10px; font-size:.68rem; font-weight:600; font-family:inherit; cursor:pointer; display:inline-flex; align-items:center; gap:6px; }
        .pipe-chip:hover { background:rgba(255,255,255,.07); color:#cde; }
        .pipe-chip-active { background:rgba(0,200,200,.18); border-color:rgba(0,200,200,.4); color:#0ee; }
        .pipe-chip-warn.pipe-chip-active { background:rgba(255,80,80,.18); border-color:rgba(255,80,80,.45); color:#fbb; }
        .pipe-chip-count { color:#667; font-family:monospace; font-size:.62rem; }
        .pipe-chip-active .pipe-chip-count { color:inherit; opacity:.7; }
        .pipe-filter-spacer { flex:1; }
        .pipe-head, .pipe-row {
            display:grid;
            grid-template-columns:14px 1.4fr .9fr .7fr .7fr .6fr .7fr 1.6fr 28px;
            gap:10px; align-items:center;
            padding:6px 8px; font-family:monospace; font-size:.72rem;
        }
        .pipe-head { background:rgba(255,255,255,.03); border-radius:4px; color:#778; text-transform:uppercase; letter-spacing:.05em; font-weight:700; font-size:.62rem; margin-bottom:4px; }
        .pipe-row { border-bottom:1px solid rgba(255,255,255,.04); color:#bbd; }
        .pipe-row:last-child { border-bottom:none; }
        .pipe-row[data-status="error"], .pipe-row[data-status="timeout"] { background:rgba(255,80,80,.04); }
        .pipe-row[data-status="stale"] { background:rgba(255,136,0,.04); }
        .pipe-dot { width:8px; height:8px; border-radius:50%; }
        .pipe-name { font-weight:600; color:#ddf; }
        .pipe-group { color:#889; }
        .pipe-status { font-weight:700; font-size:.7rem; }
        .pipe-latency, .pipe-age, .pipe-probed { color:#ace; text-align:right; }
        .pipe-probed { color:#778; font-size:.66rem; }
        .pipe-detail { color:#667; font-size:.66rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .pipe-err { color:#f88; }
        .pipe-dim { color:#556; }
        .pipe-retried { color:#ffaa44; margin-left:6px; font-size:.66rem; }
        .pipe-retry { background:transparent; border:1px solid rgba(255,255,255,.1); color:#9ab; border-radius:4px; width:24px; height:22px; line-height:1; font-size:.78rem; cursor:pointer; padding:0; }
        .pipe-retry:hover { background:rgba(0,200,200,.12); color:#0cc; border-color:rgba(0,200,200,.3); }
        .pipe-retry[disabled] { opacity:.4; cursor:wait; }
        .pipe-empty { color:#667; padding:12px 8px; font-style:italic; }
        @media (max-width:760px) {
            .pipe-summary { grid-template-columns:repeat(2, 1fr); }
            .pipe-head { display:none; }
            .pipe-row { grid-template-columns:14px 1fr 1fr 28px; grid-auto-rows:min-content; padding:8px; }
            .pipe-group, .pipe-detail, .pipe-probed { display:none; }
        }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
}

/**
 * Mount the pipeline analytics panel into `host`. Kicks off a probe of every
 * pipeline in parallel, then renders rows as they complete.
 * Returns a disposer that cancels in-flight UI updates and the auto-refresh
 * timer (caller MUST invoke it when the host is unmounted to avoid a leak).
 */
export function renderPipelineAnalytics(host) {
    if (!host) return () => {};
    injectStyles();

    let disposed   = false;
    let probingAll = false;
    let autoTimer  = null;

    // UI state — survives across redraws within this mount.
    const state = {
        group:    null,    // group filter ('Space Weather', …) or null for all
        downOnly: false,
        auto:     false,
    };

    // Current row data; mutated in place so per-row retries can update one cell.
    let rows = PIPELINES.map(p => ({ ...p, status: 'loading', latency_ms: null, age_sec: null, error: null, probed_at: null }));

    function draw() {
        if (disposed) return;
        const filtered = applyFilterAndSort(rows, state);
        const rowsHtml = filtered.length
            ? filtered.map(renderRow).join('')
            : `<div class="pipe-empty">No pipelines match the current filter.</div>`;
        host.innerHTML = `
            <div class="pipe-wrap">
                ${summaryBar(rows)}
                <div class="pipe-actions">
                    <button class="pipe-btn" id="pipe-refresh" ${probingAll ? 'disabled' : ''}>${probingAll ? 'Probing…' : 'Refresh all'}</button>
                    <label class="pipe-auto" title="Re-probe every 60s while the System tab is open">
                        <input type="checkbox" id="pipe-auto" ${state.auto ? 'checked' : ''}>
                        Auto-refresh
                    </label>
                    <span class="pipe-stamp">Last probe: ${new Date().toLocaleTimeString()}</span>
                </div>
                ${filterChips(rows, state)}
                <div class="pipe-head">
                    <span></span>
                    <span>Pipeline</span>
                    <span>Group</span>
                    <span>Status</span>
                    <span style="text-align:right">Latency</span>
                    <span style="text-align:right">Age</span>
                    <span style="text-align:right">Probed</span>
                    <span>Detail</span>
                    <span></span>
                </div>
                ${rowsHtml}
            </div>
        `;
        // Wire controls (re-bound on every redraw — cheap and avoids leaks).
        host.querySelector('#pipe-refresh')?.addEventListener('click', () => runAll());
        host.querySelector('#pipe-auto')?.addEventListener('change', e => {
            state.auto = !!e.target.checked;
            scheduleAuto();
        });
        host.querySelectorAll('[data-group-filter]').forEach(b => {
            b.addEventListener('click', () => {
                const v = b.getAttribute('data-group-filter') || null;
                state.group = v || null;
                draw();
            });
        });
        host.querySelector('[data-down-only]')?.addEventListener('click', () => {
            state.downOnly = !state.downOnly;
            draw();
        });
        host.querySelectorAll('[data-retry]').forEach(b => {
            b.addEventListener('click', () => {
                const key = b.getAttribute('data-retry');
                if (key) retryOne(key);
            });
        });
    }

    async function runAll() {
        if (probingAll) return;
        probingAll = true;
        // Seed with "loading" rows so the table doesn't flash empty.
        rows = PIPELINES.map(p => ({ ...p, status: 'loading', latency_ms: null, age_sec: null, error: null, probed_at: null }));
        draw();

        // Fire all probes in parallel; redraw as each resolves so partial
        // results are visible immediately.
        await Promise.all(PIPELINES.map(async (p, i) => {
            const r = await probe(p);
            if (disposed) return;
            rows[i] = r;
            draw();
        }));
        probingAll = false;
        draw();
    }

    async function retryOne(key) {
        const idx = rows.findIndex(r => r.key === key);
        if (idx < 0) return;
        const spec = PIPELINES.find(p => p.key === key);
        if (!spec) return;
        rows[idx] = { ...rows[idx], status: 'loading', error: null };
        draw();
        const r = await probe(spec);
        if (disposed) return;
        rows[idx] = r;
        draw();
    }

    function scheduleAuto() {
        if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
        if (!state.auto || disposed) return;
        autoTimer = setInterval(() => { if (!disposed && !probingAll) runAll(); }, AUTO_REFRESH_MS);
    }

    runAll();

    return () => {
        disposed = true;
        if (autoTimer) clearInterval(autoTimer);
    };
}
