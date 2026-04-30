/**
 * debug-overlay.js — runtime telemetry panel, flipped on by ?debug=1
 * ═══════════════════════════════════════════════════════════════════════════
 * Single-module, single-import ops panel. When the URL carries `?debug=1`
 * (any truthy value, really), mounts a floating card that surfaces:
 *
 *   FPS & frame-time      rolling median + p95 of the last ~2 s
 *   Renderer info          draw calls, triangles, programs, texture count
 *   Feed rollup            per-feed state / source / freshness / error
 *                          observed from whatever CustomEvents the feeds
 *                          already fire — no feed-side refactor needed.
 *   Layer integrity        list of checkboxes whose state disagrees with
 *                          the corresponding mesh.visible.  Would have
 *                          caught the "NASA overlays visible while
 *                          checkboxes off" regression in one second.
 *
 * No-op when the flag is absent — zero runtime cost on user-facing loads.
 *
 *   import { initDebugOverlay } from './js/debug-overlay.js';
 *   initDebugOverlay({ renderer, layerRegistry });
 *
 * layerRegistry — plain object mapping checkbox id → () => boolean that
 * returns the paired mesh's effective visibility. The caller owns this
 * map because the coupling between DOM id and scene object lives in the
 * page, not in this module.
 */

const ENABLED = (() => {
    try {
        const p = new URLSearchParams(location.search);
        const v = p.get('debug');
        return v === '1' || v === 'true' || v === 'yes';
    } catch { return false; }
})();

export function initDebugOverlay({ renderer, layerRegistry } = {}) {
    if (!ENABLED) return null;

    _injectStyles();
    const panel = _buildPanel();
    document.body.appendChild(panel);

    const state = {
        renderer,
        layerRegistry: layerRegistry ?? {},
        feeds:       new Map(),          // name → { state, source, updated, count, error }
        frameTimes:  [],                 // rolling window (ms)
        lastFrame:   performance.now(),
    };

    _subscribeFeeds(state);
    _startFrameLoop(state);
    _startRenderLoop(state, panel);

    panel.querySelector('.dbg-close').addEventListener('click', () => panel.remove());

    console.info('[DebugOverlay] enabled (?debug=1). Remove the flag to hide.');
    return { state, panel, dispose: () => panel.remove() };
}

// ── Overlay DOM ────────────────────────────────────────────────────────────

function _buildPanel() {
    const el = document.createElement('div');
    el.id = 'debug-overlay';
    el.innerHTML = `
        <div class="dbg-hdr">
            <strong>telemetry</strong>
            <span class="dbg-close" title="close (reload without ?debug=1 to remove permanently)">×</span>
        </div>

        <div class="dbg-h2">render</div>
        <div class="dbg-row"><span class="dbg-k">fps</span>      <span class="dbg-v" id="dbg-fps">—</span></div>
        <div class="dbg-row"><span class="dbg-k">p95 fps</span>  <span class="dbg-v" id="dbg-p95">—</span></div>
        <div class="dbg-row"><span class="dbg-k">frame</span>    <span class="dbg-v" id="dbg-frame">—</span></div>
        <div class="dbg-row"><span class="dbg-k">draw calls</span><span class="dbg-v" id="dbg-draws">—</span></div>
        <div class="dbg-row"><span class="dbg-k">triangles</span><span class="dbg-v" id="dbg-tris">—</span></div>
        <div class="dbg-row"><span class="dbg-k">programs</span> <span class="dbg-v" id="dbg-programs">—</span></div>
        <div class="dbg-row"><span class="dbg-k">textures</span> <span class="dbg-v" id="dbg-textures">—</span></div>

        <div class="dbg-h2">feeds</div>
        <div id="dbg-feeds" class="dbg-block"></div>

        <div class="dbg-h2">layer integrity</div>
        <div id="dbg-integrity" class="dbg-block"></div>

        <div class="dbg-foot">Refreshes every 1 s · <a href="?" style="color:#667">clear flag</a></div>
    `;
    return el;
}

function _injectStyles() {
    if (document.getElementById('debug-overlay-styles')) return;
    const s = document.createElement('style');
    s.id = 'debug-overlay-styles';
    s.textContent = `
        #debug-overlay {
            position: fixed; top: 58px; right: 10px; z-index: 9999;
            width: 280px; max-height: calc(100vh - 130px); overflow-y: auto;
            background: rgba(0,0,0,.92); backdrop-filter: blur(8px);
            border: 1px solid rgba(0,255,136,.22); border-radius: 6px;
            padding: 8px 10px 10px;
            font-family: ui-monospace, Menlo, monospace;
            font-size: 10px; line-height: 1.45; color: #cde;
            box-shadow: 0 4px 20px rgba(0,0,0,.5);
            pointer-events: auto;
        }
        #debug-overlay::-webkit-scrollbar { width: 3px; }
        #debug-overlay::-webkit-scrollbar-thumb { background: rgba(0,255,136,.22); border-radius: 2px; }
        #debug-overlay .dbg-hdr {
            display: flex; justify-content: space-between; align-items: baseline;
            margin-bottom: 4px; font-size: 11px; color: #4fc97f;
            text-transform: uppercase; letter-spacing: .08em;
        }
        #debug-overlay .dbg-close {
            cursor: pointer; color: #667; font-size: 14px; line-height: 1;
            padding: 0 4px;
        }
        #debug-overlay .dbg-close:hover { color: #fff; }
        #debug-overlay .dbg-h2 {
            margin: 8px 0 3px; font-size: 9px; color: #558;
            text-transform: uppercase; letter-spacing: .08em;
            padding-top: 4px; border-top: 1px solid rgba(255,255,255,.06);
        }
        #debug-overlay .dbg-h2:first-of-type { border-top: none; padding-top: 0; }
        #debug-overlay .dbg-row {
            display: flex; justify-content: space-between; align-items: baseline;
            padding: 1px 0; gap: 8px;
        }
        #debug-overlay .dbg-k { color: #557; flex-shrink: 0; }
        #debug-overlay .dbg-v {
            color: #cde; text-align: right;
            font-variant-numeric: tabular-nums;
            word-break: break-all;
        }
        #debug-overlay .dbg-block { min-height: 14px; }
        #debug-overlay .dbg-foot {
            margin-top: 8px; padding-top: 4px;
            border-top: 1px solid rgba(255,255,255,.06);
            font-size: 9px; color: #445;
        }
        #debug-overlay .dbg-foot a { color: #667; text-decoration: underline; }
        #debug-overlay .dbg-ok    { color: #4fc97f; }
        #debug-overlay .dbg-warn  { color: #ffaa22; }
        #debug-overlay .dbg-err   { color: #ff4422; }
        #debug-overlay .dbg-dim   { color: #557; }
    `;
    document.head.appendChild(s);
}

// ── Feed subscription ──────────────────────────────────────────────────────
// Listens to the existing domain events each feed already emits; does NOT
// require any feed-side refactor.  Every entry ends up in state.feeds as
// { state, source?, updated?, count?, error? }.

function _subscribeFeeds(state) {
    const set = (name, patch) => {
        const prev = state.feeds.get(name) ?? {};
        state.feeds.set(name, { ...prev, ...patch, ts: Date.now() });
    };

    document.addEventListener('weather-status', e => {
        if (e.detail?.status === 'fetching') set('weather', { state: 'fetching' });
    });
    document.addEventListener('weather-update', e => {
        const m = e.detail?.meta ?? {};
        set('weather', {
            state:   m.loaded ? 'loaded' : 'error',
            source:  m.source,
            updated: m.fetchTime,
            error:   m.loaded ? null : 'upstream 500 — fallback active',
        });
    });
    document.addEventListener('nws-status', e => {
        if (e.detail?.status === 'fetching') set('nws', { state: 'fetching' });
    });
    document.addEventListener('nws-alerts-update', e => {
        const d = e.detail ?? {};
        set('nws', {
            state:   d.error ? 'error' : 'loaded',
            count:   d.meta?.count,
            updated: d.meta?.fetchTime,
            error:   d.error,
        });
    });
    window.addEventListener('storm-update', e => {
        const d = e.detail ?? {};
        set('storm', {
            state:   d.status === 'offline' ? 'error' : 'loaded',
            count:   (d.storms ?? []).length,
            updated: Date.now(),
        });
    });
    window.addEventListener('feeds-status', e => {
        const d = e.detail ?? {};
        if (d.source === 'USGS') {
            set('usgs-quakes', {
                state: d.status === 'ok' ? 'loaded' : d.status === 'fetching' ? 'fetching' : 'error',
                count: d.count,
                error: d.error,
            });
        }
    });
    window.addEventListener('satellites-loaded', e => {
        const d = e.detail ?? {};
        set(`sat:${d.group}`, {
            state: d.count === 0 ? 'error' : 'loaded',
            count: d.count,
        });
    });
    window.addEventListener('swpc-update', e => {
        const sw = e.detail ?? {};
        set('swpc', {
            state:   'loaded',
            updated: sw.updated ?? Date.now(),
            source:  sw.source,
        });
    });
    window.addEventListener('earth-obs-status', e => {
        const d = e.detail ?? {};
        set(`nasa:${d.layerId}`, {
            state:   d.state,
            source:  d.source,
            updated: d.updated,
            error:   d.error,
        });
    });
}

// ── Frame-time sampler ─────────────────────────────────────────────────────
// Runs its own rAF loop to measure real wall-clock dt independent of the
// page's animate(). This means the overlay still ticks when the page's
// animate() is paused, which is exactly what you want for diagnostics.

function _startFrameLoop(state) {
    function tick(now) {
        const dt = now - state.lastFrame;
        state.lastFrame = now;
        // Reject pathological deltas (tab-background wake, debugger pause).
        if (dt > 0 && dt < 1000) {
            state.frameTimes.push(dt);
            if (state.frameTimes.length > 120) state.frameTimes.shift();
        }
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}

// ── 1-Hz render pass ───────────────────────────────────────────────────────

function _startRenderLoop(state, panel) {
    const q = (id) => panel.querySelector(id);
    setInterval(() => {
        // Frame stats
        if (state.frameTimes.length >= 10) {
            const sorted = [...state.frameTimes].sort((a, b) => a - b);
            const med    = sorted[Math.floor(sorted.length / 2)];
            const p95    = sorted[Math.floor(sorted.length * 0.95)];
            q('#dbg-fps').textContent    = (1000 / med).toFixed(0);
            q('#dbg-p95').textContent    = (1000 / p95).toFixed(0);
            q('#dbg-frame').textContent  = `${med.toFixed(1)}ms`;
        }

        // Renderer info
        const info = state.renderer?.info;
        if (info) {
            q('#dbg-draws').textContent    = info.render?.calls ?? '—';
            q('#dbg-tris').textContent     = (info.render?.triangles ?? 0).toLocaleString();
            q('#dbg-programs').textContent = info.programs?.length ?? '—';
            q('#dbg-textures').textContent = info.memory?.textures ?? '—';
        }

        // Feeds — sorted, grouped visually by prefix
        q('#dbg-feeds').innerHTML = _renderFeedsHtml(state);

        // Layer integrity
        q('#dbg-integrity').innerHTML = _renderIntegrityHtml(state);
    }, 1000);
}

function _renderFeedsHtml(state) {
    if (state.feeds.size === 0) {
        return `<div class="dbg-dim">no feed events yet</div>`;
    }
    const rows = [...state.feeds.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, info]) => {
            const cls   = info.state === 'loaded'   ? 'dbg-ok'
                       :  info.state === 'fetching' ? 'dbg-warn'
                       :  info.state === 'error'    ? 'dbg-err'
                       :                              'dbg-dim';
            const extras = [];
            if (info.count != null) extras.push(`${info.count}`);
            if (info.updated)       extras.push(_agoStr(info.updated));
            if (info.error)         extras.push(_trunc(info.error, 40));
            const tail = extras.length ? ` · ${extras.join(' · ')}` : '';
            return `<div class="dbg-row"><span class="dbg-k">${_esc(name)}</span><span class="${cls}">${info.state}${_esc(tail)}</span></div>`;
        });
    return rows.join('');
}

function _renderIntegrityHtml(state) {
    const reg = state.layerRegistry;
    const ids = Object.keys(reg);
    if (ids.length === 0) {
        return `<div class="dbg-dim">no registry — page didn't pass layerRegistry</div>`;
    }
    const mismatches = [];
    let checked = 0;
    for (const id of ids) {
        const cb = document.getElementById(id);
        if (!cb) continue;
        let meshVisible;
        try { meshVisible = Boolean(reg[id]()); } catch { meshVisible = '?'; }
        checked++;
        if (meshVisible !== '?' && cb.checked !== meshVisible) {
            mismatches.push({ id, checkbox: cb.checked, mesh: meshVisible });
        }
    }
    if (mismatches.length === 0) {
        return `<div class="dbg-ok">✓ ${checked} layers in sync</div>`;
    }
    return mismatches.map(m =>
        `<div class="dbg-err">${_esc(m.id)}: cb=${m.checkbox} mesh=${m.mesh}</div>`
    ).join('');
}

// ── tiny utils ─────────────────────────────────────────────────────────────

function _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function _trunc(s, n) {
    const str = String(s ?? '');
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
}
function _agoStr(t) {
    const ms = Date.now() - new Date(t).getTime();
    if (!isFinite(ms) || ms < 0) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60)    return `${s}s`;
    if (s < 3600)  return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
}

export { ENABLED as debugOverlayEnabled };
