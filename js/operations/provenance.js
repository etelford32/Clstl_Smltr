/**
 * provenance.js — Where every number on the page comes from.
 *
 * Producers register records under stable string keys; consumers either
 * call `bind(node, key)` to render a number that shows its provenance on
 * hover (tooltip) and click (side drawer), or call `get(key)` to read
 * the record directly.
 *
 * Why this exists: a satellite-ops console without provenance is a toy.
 * Operators don't act on numbers they can't audit. Every dynamic value
 * either ships with source, age, model, sigma, and an upstream chain —
 * or it doesn't get to be on the page.
 *
 * ── Record shape ───────────────────────────────────────────────────
 *   {
 *     value:      number,          // the rendered number
 *     unit:       string,          // 'mPa', 'km', 'SFU', etc.
 *     source:     string,          // 'NOAA SWPC RTSW', 'CelesTrak GP', 'derived'
 *     fetchedAt:  ISO string,      // when *we* got the upstream
 *     validAt:    ISO string,      // when the value represents
 *     model?:     string,          // 'NRLMSISE-00 v2.1', 'SGP4 r2024.06'
 *     formula?:   string,          // 'q = ½ρv²' for derived values
 *     inputs?:    string[],        // upstream provenance keys
 *     sigma?:     number,          // 1σ band on `value`
 *     cacheState: 'live' | 'hit' | 'stale' | 'synthetic' | 'derived',
 *     description?: string,        // one-line plain-prose explainer
 *   }
 *
 * ── Timings (dialled in for snappy descriptive feel) ───────────────
 *   - hover dwell:        80 ms   tooltip materialises by the time the eye lands
 *   - hover grace:       100 ms   re-enter cancels hide → no flicker pass-through
 *   - tooltip in / out:   80 / 60 ms   asymmetric: confirm intent on in, leave fast
 *   - drawer slide:      180 ms   intentional but non-blocking
 *   - click:             0 ms     no animation gate — drawer opens immediately
 *
 *   These constants are exported as TIMINGS for tuning without rebuild.
 */

import { scenario } from './scenario.js';

export const TIMINGS = Object.freeze({
    hoverDwellMs:    80,
    hoverGraceMs:   100,
    tooltipInMs:     80,
    tooltipOutMs:    60,
    drawerSlideMs:  180,
});

const _records  = new Map();
const _bindings = new Map();      // key → Set<{ node, format }>
const _subs     = new Set();

/* ─── Store ──────────────────────────────────────────────────── */

function notify(key) {
    for (const fn of _subs) {
        try { fn(key); } catch (_) {}
    }
}

function reflect(key) {
    const set = _bindings.get(key);
    if (!set) return;
    const rec = _records.get(key);
    if (!rec) return;
    for (const b of set) {
        b.node.textContent = formatBinding(rec, b.format);
        b.node.dataset.provKey = key;
    }
}

function formatBinding(rec, format) {
    if (typeof format === 'function') return format(rec);
    if (typeof format === 'string') {
        return format
            .replace('{value}', formatNumber(rec.value))
            .replace('{unit}',  rec.unit ?? '')
            .replace('{sigma}', rec.sigma != null ? `±${formatNumber(rec.sigma)}` : '')
            .trim();
    }
    return rec.unit ? `${formatNumber(rec.value)} ${rec.unit}` : formatNumber(rec.value);
}

function formatNumber(v) {
    if (v == null) return '—';
    if (!Number.isFinite(v)) return String(v);
    const abs = Math.abs(v);
    if (abs === 0) return '0';
    if (abs >= 1000) return Math.round(v).toLocaleString();
    if (abs >= 100)  return v.toFixed(0);
    if (abs >= 10)   return v.toFixed(1);
    if (abs >= 1)    return v.toFixed(2);
    if (abs >= 0.01) return v.toFixed(3);
    return v.toExponential(2);
}

function ageString(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const diff = Math.max(0, Date.now() - t);
    if (diff < 5_000)        return 'just now';
    if (diff < 60_000)       return `${Math.round(diff / 1000)}s ago`;
    if (diff < 3_600_000)    return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000)   return `${Math.round(diff / 3_600_000)}h ago`;
    return `${Math.round(diff / 86_400_000)}d ago`;
}

const CACHE_LABELS = Object.freeze({
    live:      { dot: '#0fa', label: 'Live'      },
    hit:       { dot: '#0cc', label: 'Cache hit' },
    stale:     { dot: '#fc6', label: 'Stale'     },
    synthetic: { dot: '#f9a', label: 'Synthetic' },
    derived:   { dot: '#9bd', label: 'Derived'   },
});

/* ─── Tooltip element ────────────────────────────────────────── */

let _tip = null;
let _tipOpen = false;
let _dwellTimer = null;
let _hideTimer = null;
let _activeKey = null;

function ensureTooltip() {
    if (_tip) return _tip;
    _tip = document.createElement('div');
    _tip.id = 'op-prov-tooltip';
    _tip.setAttribute('role', 'tooltip');
    document.body.appendChild(_tip);
    return _tip;
}

function buildTooltipHTML(rec) {
    const cache = CACHE_LABELS[rec.cacheState] ?? CACHE_LABELS.derived;
    const valueStr = rec.unit ? `${formatNumber(rec.value)} ${rec.unit}` : formatNumber(rec.value);
    const sigmaStr = rec.sigma != null ? ` ±${formatNumber(rec.sigma)}` : '';
    return `
        <div class="op-tip-head">
            <span class="op-tip-value">${valueStr}<span class="op-tip-sigma">${sigmaStr}</span></span>
            <span class="op-tip-cache" style="color:${cache.dot}">●&nbsp;${cache.label}</span>
        </div>
        <div class="op-tip-source">${escapeHtml(rec.source || '—')}</div>
        ${rec.model ? `<div class="op-tip-meta">model · ${escapeHtml(rec.model)}</div>` : ''}
        ${rec.formula ? `<div class="op-tip-meta">formula · <code>${escapeHtml(rec.formula)}</code></div>` : ''}
        ${rec.validAt ? `<div class="op-tip-meta">valid · ${ageString(rec.validAt)}</div>` : ''}
        ${rec.description ? `<div class="op-tip-desc">${escapeHtml(rec.description)}</div>` : ''}
        <div class="op-tip-hint">click for full chain →</div>
    `;
}

function showTooltip(node) {
    const key = node.dataset.provKey;
    if (!key) return;
    const rec = _records.get(key);
    if (!rec) return;

    const tip = ensureTooltip();
    tip.innerHTML = buildTooltipHTML(rec);
    tip.classList.add('op-prov-tooltip-prepaint');
    // Force layout so getBoundingClientRect is fresh.
    void tip.offsetHeight;
    positionTooltip(node, tip);
    tip.classList.remove('op-prov-tooltip-prepaint');
    tip.classList.add('open');
    _tipOpen = true;
    _activeKey = key;
}

function hideTooltip() {
    if (!_tip) return;
    _tip.classList.remove('open');
    _tipOpen = false;
    _activeKey = null;
}

function positionTooltip(node, tip) {
    const r  = node.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(8, Math.min(window.innerWidth - tr.width - 8, left));
    let top = r.bottom + 8;
    if (top + tr.height + 8 > window.innerHeight) {
        top = r.top - tr.height - 8;
    }
    tip.style.left = `${left}px`;
    tip.style.top  = `${top}px`;
}

/* ─── Drawer element ─────────────────────────────────────────── */

let _drawer    = null;
let _drawerKey = null;
const _drawerHistory = [];

function ensureDrawer() {
    if (_drawer) return _drawer;
    _drawer = document.createElement('aside');
    _drawer.id = 'op-prov-drawer';
    _drawer.setAttribute('role', 'dialog');
    _drawer.setAttribute('aria-label', 'Provenance');
    _drawer.innerHTML = '';
    document.body.appendChild(_drawer);

    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && _drawer?.classList.contains('open')) {
            closeDrawer();
        }
    });
    return _drawer;
}

function openDrawer(key, opts = {}) {
    const rec = _records.get(key);
    if (!rec) return;
    const drawer = ensureDrawer();

    if (!opts.fromHistory && _drawerKey && _drawerKey !== key) {
        _drawerHistory.push(_drawerKey);
    }
    _drawerKey = key;

    drawer.innerHTML = renderDrawer(key, rec);
    drawer.classList.add('open');
    hideTooltip();

    drawer.querySelector('[data-prov-close]')?.addEventListener('click', closeDrawer);
    drawer.querySelector('[data-prov-back]') ?.addEventListener('click', () => {
        const prev = _drawerHistory.pop();
        if (prev) openDrawer(prev, { fromHistory: true });
    });
    drawer.querySelector('[data-prov-cite]')?.addEventListener('click', () => {
        copyCitation(key, rec, drawer.querySelector('[data-prov-cite]'));
    });
    drawer.querySelectorAll('[data-prov-input]').forEach(el => {
        el.addEventListener('click', () => openDrawer(el.dataset.provInput));
    });
}

function closeDrawer() {
    if (!_drawer) return;
    _drawer.classList.remove('open');
    _drawerKey = null;
    _drawerHistory.length = 0;
}

function renderDrawer(key, rec) {
    const cache = CACHE_LABELS[rec.cacheState] ?? CACHE_LABELS.derived;
    const valueStr = rec.unit ? `${formatNumber(rec.value)} ${rec.unit}` : formatNumber(rec.value);
    const sigmaStr = rec.sigma != null ? `± ${formatNumber(rec.sigma)} ${rec.unit ?? ''}` : '';
    const back = _drawerHistory.length ? `<button class="op-drawer-back" data-prov-back>← back</button>` : '';

    const inputsHtml = (rec.inputs || []).map(k => {
        const sub = _records.get(k);
        if (!sub) return `<li class="op-drawer-input op-drawer-input-missing">${escapeHtml(k)} — not registered</li>`;
        const v = sub.unit ? `${formatNumber(sub.value)} ${sub.unit}` : formatNumber(sub.value);
        return `<li class="op-drawer-input" data-prov-input="${escapeHtml(k)}">
            <span class="op-drawer-input-key">${escapeHtml(k)}</span>
            <span class="op-drawer-input-val">${v}</span>
            <span class="op-drawer-input-src">${escapeHtml(sub.source || '—')}</span>
        </li>`;
    }).join('');

    return `
        <div class="op-drawer-head">
            ${back}
            <button class="op-drawer-close" data-prov-close aria-label="Close">×</button>
        </div>
        <div class="op-drawer-key">${escapeHtml(key)}</div>
        <div class="op-drawer-value">${valueStr}</div>
        ${sigmaStr ? `<div class="op-drawer-sigma">${sigmaStr}</div>` : ''}
        <div class="op-drawer-cache" style="color:${cache.dot}">● ${cache.label}</div>

        <dl class="op-drawer-meta">
            <dt>source</dt>      <dd>${escapeHtml(rec.source || '—')}</dd>
            ${rec.model    ? `<dt>model</dt>      <dd>${escapeHtml(rec.model)}</dd>`             : ''}
            ${rec.formula  ? `<dt>formula</dt>    <dd><code>${escapeHtml(rec.formula)}</code></dd>` : ''}
            ${rec.validAt  ? `<dt>valid at</dt>   <dd>${escapeHtml(rec.validAt)} <span class="op-drawer-rel">(${ageString(rec.validAt)})</span></dd>` : ''}
            ${rec.fetchedAt? `<dt>fetched at</dt> <dd>${escapeHtml(rec.fetchedAt)} <span class="op-drawer-rel">(${ageString(rec.fetchedAt)})</span></dd>` : ''}
        </dl>

        ${rec.description ? `<p class="op-drawer-desc">${escapeHtml(rec.description)}</p>` : ''}

        ${(rec.inputs && rec.inputs.length) ? `
            <h3 class="op-drawer-h">Upstream inputs</h3>
            <ul class="op-drawer-inputs">${inputsHtml}</ul>
        ` : ''}

        <div class="op-drawer-actions">
            <button class="op-drawer-cite" data-prov-cite>Copy as citation</button>
        </div>
    `;
}

function copyCitation(key, rec, btn) {
    const lines = [];
    const v = rec.unit ? `${formatNumber(rec.value)} ${rec.unit}` : formatNumber(rec.value);
    const s = rec.sigma != null ? ` ± ${formatNumber(rec.sigma)} ${rec.unit ?? ''}` : '';
    lines.push(`${key} = ${v}${s}`);
    if (rec.validAt)  lines.push(`  valid at: ${rec.validAt}`);
    if (rec.fetchedAt)lines.push(`  fetched:  ${rec.fetchedAt}`);
    if (rec.source)   lines.push(`  source:   ${rec.source}`);
    if (rec.model)    lines.push(`  model:    ${rec.model}`);
    if (rec.formula)  lines.push(`  formula:  ${rec.formula}`);
    if (rec.inputs?.length) {
        lines.push(`  inputs:`);
        for (const k of rec.inputs) lines.push(`    - ${k}`);
    }
    lines.push(`  scenario: ${scenario.getHash?.() ?? ''}`);
    lines.push(`  source:   Parker Physics Operations`);
    const text = lines.join('\n');

    navigator.clipboard?.writeText(text).then(() => {
        if (!btn) return;
        const prev = btn.textContent;
        btn.textContent = 'copied ✓';
        btn.classList.add('op-drawer-cite-ok');
        setTimeout(() => {
            btn.textContent = prev;
            btn.classList.remove('op-drawer-cite-ok');
        }, 1100);
    }).catch(() => {});
}

/* ─── Event delegation ──────────────────────────────────────── */

function handleEnter(node) {
    if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
    if (_dwellTimer) clearTimeout(_dwellTimer);
    _dwellTimer = setTimeout(() => {
        _dwellTimer = null;
        showTooltip(node);
    }, TIMINGS.hoverDwellMs);
}

function handleLeave(node) {
    if (_dwellTimer) { clearTimeout(_dwellTimer); _dwellTimer = null; }
    if (!_tipOpen) return;
    if (_hideTimer) clearTimeout(_hideTimer);
    _hideTimer = setTimeout(() => {
        _hideTimer = null;
        hideTooltip();
    }, TIMINGS.hoverGraceMs);
}

function handleClick(node, ev) {
    const key = node.dataset.provKey;
    if (!key || !_records.has(key)) return;
    ev.preventDefault();
    openDrawer(key);
}

let _delegationMounted = false;
function mountDelegation() {
    if (_delegationMounted) return;
    _delegationMounted = true;

    document.addEventListener('pointerover', e => {
        const node = e.target.closest?.('[data-prov-key]');
        if (node) handleEnter(node);
    });
    document.addEventListener('pointerout', e => {
        const node = e.target.closest?.('[data-prov-key]');
        if (!node) return;
        const next = e.relatedTarget?.closest?.('[data-prov-key]');
        if (next === node) return;
        handleLeave(node);
    });
    document.addEventListener('click', e => {
        const node = e.target.closest?.('[data-prov-key]');
        if (node) handleClick(node, e);
    });

    // Touch: tap = open drawer (no hover semantics on touch).
    // pointerdown fires before click on touchscreens so the drawer
    // opens snappily.
    document.addEventListener('pointerdown', e => {
        if (e.pointerType !== 'touch') return;
        const node = e.target.closest?.('[data-prov-key]');
        if (node) handleClick(node, e);
    });
}

/* ─── HTML escape (records can contain user-controlled strings) ─ */

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* ─── Public API ─────────────────────────────────────────────── */

export const provStore = {
    /** Register or replace a provenance record. */
    set(key, record) {
        if (!key) return;
        const now = new Date().toISOString();
        const rec = {
            value:      record.value,
            unit:       record.unit ?? '',
            source:     record.source ?? 'unknown',
            fetchedAt:  record.fetchedAt ?? now,
            validAt:    record.validAt ?? record.fetchedAt ?? now,
            model:      record.model,
            formula:    record.formula,
            inputs:     record.inputs ? [...record.inputs] : undefined,
            sigma:      record.sigma,
            cacheState: record.cacheState ?? (record.formula ? 'derived' : 'live'),
            description:record.description,
        };
        _records.set(key, rec);
        reflect(key);
        notify(key);
    },

    /** Read a record (or undefined). */
    get(key) { return _records.get(key); },

    /** All registered keys. */
    keys() { return [..._records.keys()]; },

    /**
     * Render `key` into `node` and bind it for hover/click. `format` is
     * a string template ('{value} {unit}', '{value} {sigma}') or a
     * function (rec) → string. Re-binds replace prior bindings on the
     * same node.
     */
    bind(node, key, opts = {}) {
        if (!node) return () => {};
        node.dataset.provKey = key;
        if (!_bindings.has(key)) _bindings.set(key, new Set());
        const entry = { node, format: opts.format };
        _bindings.get(key).add(entry);
        if (_records.has(key)) reflect(key);
        return () => {
            _bindings.get(key)?.delete(entry);
            if (node.dataset.provKey === key) delete node.dataset.provKey;
        };
    },

    /** Subscribe to record changes (fn(key) on each set()). */
    subscribe(fn) {
        _subs.add(fn);
        return () => _subs.delete(fn);
    },

    /** Build the data-dictionary snapshot for the current scenario. */
    exportJson() {
        const out = {
            scenarioHash: scenario.getHash?.() ?? null,
            modelVersions: scenario.MODEL_VERSIONS ?? null,
            exportedAt: new Date().toISOString(),
            recordCount: _records.size,
            records: Object.fromEntries([..._records.entries()].sort(([a], [b]) => a.localeCompare(b))),
        };
        return out;
    },

    /** Trigger a JSON download of the current snapshot. */
    download(filename) {
        const data = this.exportJson();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || `operations-data-dictionary-${data.scenarioHash || 'snapshot'}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    },

    /** Programmatic open/close of the drawer (e.g. from a "details" button). */
    openDrawer,
    closeDrawer,

    /** Mount the global event delegation. Idempotent; called once at boot. */
    mount: mountDelegation,

    TIMINGS,
};

// Re-emit reflect() on scenario hash change so any value that should
// re-render (e.g. when a layer load completes) gets a fresh paint.
scenario.subscribe?.(() => {
    for (const key of _records.keys()) reflect(key);
});
