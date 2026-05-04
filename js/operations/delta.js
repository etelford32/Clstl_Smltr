/**
 * delta.js — "Why did this change?" engine.
 *
 * Subscribes to provStore and accumulates a per-key ring buffer of
 * (value, timestamp). A small Δ icon attaches as a sibling to any
 * bound number; when the value moves, the icon flips to ▲ / ▼,
 * pulses briefly, then settles to a subtle coloured state for the
 * next ~5 minutes before fading to neutral.
 *
 * Hovering the Δ icon (same 80 ms dwell as provenance for a unified
 * snappy feel) pops a tooltip with:
 *   - the magnitude + percent change
 *   - the prior → current values with timestamps
 *   - the upstream driver: among the record's `inputs[]`, whichever
 *     moved the most in relative terms since this record's prior
 *     snapshot wins. For raw measurements (no inputs), we say
 *     "fetch refresh — no upstream attribution."
 *
 * Δ icons are quiet by default — invisible until there's a prior
 * snapshot AND the value has moved. So the page paints clean on
 * first load; subsequent refreshes light up just the things that
 * actually moved.
 */

import { provStore } from './provenance.js';

const TIMINGS = provStore.TIMINGS ?? {
    hoverDwellMs: 80,
    hoverGraceMs: 100,
};

const RING_DEPTH = 16;
const FRESH_MS   = 10_000;
const RECENT_MS  = 5 * 60 * 1000;
const REFRESH_MS = 30_000;       // periodic state-decay check

const _history = new Map();      // key -> [{ value, unit, _setAt, ...rec }, …] newest first
const _icons   = new Map();      // key -> Set<HTMLElement>

/* ─── Number / time formatting ──────────────────────────────── */

function fmt(v) {
    if (v == null) return '—';
    if (!Number.isFinite(v)) return String(v);
    const abs = Math.abs(v);
    if (abs === 0)    return '0';
    if (abs >= 1000)  return Math.round(v).toLocaleString();
    if (abs >= 100)   return v.toFixed(0);
    if (abs >= 10)    return v.toFixed(1);
    if (abs >= 1)     return v.toFixed(2);
    if (abs >= 0.01)  return v.toFixed(3);
    return v.toExponential(2);
}

function ago(ms) {
    const diff = Math.max(0, Date.now() - ms);
    if (diff < 5_000)        return 'just now';
    if (diff < 60_000)       return `${Math.round(diff / 1000)}s ago`;
    if (diff < 3_600_000)    return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000)   return `${Math.round(diff / 3_600_000)}h ago`;
    return `${Math.round(diff / 86_400_000)}d ago`;
}

function pctChange(prev, cur) {
    if (prev === 0) return cur === 0 ? 0 : null;
    return ((cur - prev) / Math.abs(prev)) * 100;
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* ─── Ring buffer ──────────────────────────────────────────── */

provStore.subscribe(key => {
    const rec = provStore.get(key);
    if (!rec) return;
    if (typeof rec.value !== 'number' && typeof rec.value !== 'bigint') return;

    const arr = _history.get(key) ?? [];
    arr.unshift({ ...rec, _setAt: Date.now() });
    if (arr.length > RING_DEPTH) arr.length = RING_DEPTH;
    _history.set(key, arr);

    refreshIcons(key);
});

/* ─── Driver finder ────────────────────────────────────────── */

function findDriver(rec) {
    if (!rec?.inputs?.length) return null;
    let best = null;
    for (const inputKey of rec.inputs) {
        const ihist = _history.get(inputKey);
        if (!ihist || ihist.length < 2) continue;
        const ic = ihist[0], ip = ihist[1];
        if (ic.value === ip.value) continue;
        const pct = pctChange(ip.value, ic.value);
        if (pct == null) continue;
        const absPct = Math.abs(pct);
        if (!best || absPct > best.absPct) {
            best = {
                key: inputKey,
                prev: ip.value,
                cur:  ic.value,
                unit: ic.unit ?? '',
                pct,
                absPct,
                source: ic.source,
                setAt: ic._setAt,
            };
        }
    }
    return best;
}

/* ─── Icon attach + state refresh ─────────────────────────── */

export function attachDelta(node, key, opts = {}) {
    if (!node || !node.parentNode) return () => {};

    const icon = document.createElement('span');
    icon.className = 'op-delta';
    icon.dataset.deltaKey = key;
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', `Recent change in ${key}`);
    icon.textContent = '·';   // quiet glyph until there's a delta to show

    node.parentNode.insertBefore(icon, node.nextSibling);

    if (!_icons.has(key)) _icons.set(key, new Set());
    _icons.get(key).add(icon);

    refreshIcons(key);

    return () => {
        icon.remove();
        _icons.get(key)?.delete(icon);
    };
}

function refreshIcons(key) {
    const set = _icons.get(key);
    if (!set || set.size === 0) return;
    const hist = _history.get(key);

    // Default: hidden (no prior snapshot, or values identical).
    let direction = null;
    let fresh = false;
    let recent = false;

    if (hist && hist.length >= 2) {
        const cur  = hist[0];
        const prev = hist[1];
        if (cur.value !== prev.value) {
            direction = cur.value > prev.value ? 'up' : 'down';
            const ageMs = Date.now() - cur._setAt;
            fresh  = ageMs < FRESH_MS;
            recent = ageMs < RECENT_MS;
        }
    }

    for (const icon of set) {
        icon.classList.remove(
            'op-delta-up', 'op-delta-down',
            'op-delta-recent', 'op-delta-fresh',
        );
        if (!direction) {
            icon.textContent = '·';
            continue;
        }
        icon.textContent = direction === 'up' ? '▲' : '▼';
        icon.classList.add(`op-delta-${direction}`);
        if (recent) icon.classList.add('op-delta-recent');
        if (fresh) {
            // Restart pulse animation on every fresh transition.
            icon.classList.add('op-delta-fresh');
            void icon.offsetWidth;
        }
    }
}

/* ─── Periodic decay so the colour fades after 5 min ──────── */

setInterval(() => {
    for (const key of _icons.keys()) refreshIcons(key);
}, REFRESH_MS);

/* ─── Tooltip ──────────────────────────────────────────────── */

let _tip = null;
let _tipOpen = false;
let _dwellTimer = null;
let _hideTimer  = null;

function ensureTooltip() {
    if (_tip) return _tip;
    _tip = document.createElement('div');
    _tip.id = 'op-delta-tooltip';
    _tip.setAttribute('role', 'tooltip');
    document.body.appendChild(_tip);
    return _tip;
}

function buildTooltipHtml(key) {
    const hist = _history.get(key);
    const rec  = provStore.get(key);
    if (!hist || hist.length < 2) {
        return `
            <div class="op-delta-tip-head">${escapeHtml(key)}</div>
            <div class="op-delta-tip-body">No prior snapshot — first observation${rec?.fetchedAt ? ' ' + ago(Date.parse(rec.fetchedAt)) : ''}.</div>
        `;
    }

    const cur  = hist[0];
    const prev = hist[1];
    const delta = cur.value - prev.value;
    const pct   = pctChange(prev.value, cur.value);
    const sign  = delta > 0 ? '+' : '−';
    const dirCls = delta > 0 ? 'op-delta-tip-up' : 'op-delta-tip-down';
    const unit  = cur.unit ? ` ${escapeHtml(cur.unit)}` : '';
    const pctStr = pct != null ? ` (${sign}${Math.abs(pct).toFixed(1)}%)` : '';

    const driver = findDriver(rec);

    let driverLine = '';
    if (driver) {
        const dSign = driver.pct > 0 ? '+' : '−';
        const dPct  = `${dSign}${Math.abs(driver.pct).toFixed(1)}%`;
        driverLine = `
            <div class="op-delta-tip-driver">
                <span class="op-delta-tip-label">Driver</span>
                <span><code>${escapeHtml(driver.key)}</code> ${fmt(driver.prev)} → ${fmt(driver.cur)}${driver.unit ? ' ' + escapeHtml(driver.unit) : ''} <em>(${dPct})</em></span>
            </div>`;
    } else if (rec?.inputs?.length) {
        driverLine = `<div class="op-delta-tip-driver"><span class="op-delta-tip-label">Driver</span><span>Inputs steady — change is intrinsic.</span></div>`;
    } else {
        driverLine = `<div class="op-delta-tip-driver"><span class="op-delta-tip-label">Driver</span><span>Fetch refresh — no upstream attribution.</span></div>`;
    }

    return `
        <div class="op-delta-tip-head ${dirCls}">
            ${escapeHtml(key)}
            <span class="op-delta-tip-mag">${sign}${fmt(Math.abs(delta))}${unit}${pctStr}</span>
        </div>
        <div class="op-delta-tip-was">
            was <strong>${fmt(prev.value)}${unit}</strong> ${ago(prev._setAt)}
            → now <strong>${fmt(cur.value)}${unit}</strong>
        </div>
        ${driverLine}
        ${rec?.source ? `<div class="op-delta-tip-source">${escapeHtml(rec.source)}</div>` : ''}
    `;
}

function showTooltip(icon) {
    const key = icon.dataset.deltaKey;
    if (!key) return;
    const tip = ensureTooltip();
    tip.innerHTML = buildTooltipHtml(key);
    tip.classList.add('op-delta-tooltip-prepaint');
    void tip.offsetHeight;
    positionTooltip(icon, tip);
    tip.classList.remove('op-delta-tooltip-prepaint');
    tip.classList.add('open');
    _tipOpen = true;
}

function hideTooltip() {
    if (!_tip) return;
    _tip.classList.remove('open');
    _tipOpen = false;
}

function positionTooltip(node, tip) {
    const r  = node.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(8, Math.min(window.innerWidth - tr.width - 8, left));
    let top  = r.bottom + 8;
    if (top + tr.height + 8 > window.innerHeight) {
        top = r.top - tr.height - 8;
    }
    tip.style.left = `${left}px`;
    tip.style.top  = `${top}px`;
}

/* ─── Event delegation ─────────────────────────────────────── */

let _delegationMounted = false;

function mountDelegation() {
    if (_delegationMounted) return;
    _delegationMounted = true;

    document.addEventListener('pointerover', e => {
        const icon = e.target.closest?.('[data-delta-key]');
        if (!icon) return;
        if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
        if (_dwellTimer) clearTimeout(_dwellTimer);
        _dwellTimer = setTimeout(() => {
            _dwellTimer = null;
            showTooltip(icon);
        }, TIMINGS.hoverDwellMs);
    });
    document.addEventListener('pointerout', e => {
        const icon = e.target.closest?.('[data-delta-key]');
        if (!icon) return;
        const next = e.relatedTarget?.closest?.('[data-delta-key]');
        if (next === icon) return;
        if (_dwellTimer) { clearTimeout(_dwellTimer); _dwellTimer = null; }
        if (!_tipOpen) return;
        if (_hideTimer) clearTimeout(_hideTimer);
        _hideTimer = setTimeout(() => {
            _hideTimer = null;
            hideTooltip();
        }, TIMINGS.hoverGraceMs);
    });
    document.addEventListener('pointerdown', e => {
        if (e.pointerType !== 'touch') return;
        const icon = e.target.closest?.('[data-delta-key]');
        if (icon) showTooltip(icon);
    });
}

/* ─── Public API ──────────────────────────────────────────── */

export const delta = {
    attach: attachDelta,
    mount: mountDelegation,

    /** Direct read of a key's snapshot ring (newest first). */
    history(key) { return (_history.get(key) ?? []).slice(); },

    /** Computed driver (or null) for the latest change. */
    driver(key)  { return findDriver(provStore.get(key)); },

    RING_DEPTH,
    FRESH_MS,
    RECENT_MS,
};
