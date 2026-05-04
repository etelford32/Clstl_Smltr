/**
 * bands.js — Visual ±σ treatment for any value in the provenance store.
 *
 * Three render styles, all bound to a provenance key so the hover
 * tooltip and drawer (provenance.js) keep working without extra wiring:
 *
 *   'sigma'    — inline text:  142 ±12 SFU       (compact, default)
 *   'range'    — bracketed P-band:  41 d (28 / 58)
 *   'whiskers' — tiny inline SVG track + dot + range bracket
 *
 * Records without a sigma render plain (no decoration), so the same
 * binder works for "exact" values too — the band quietly absent
 * communicates "no uncertainty published" rather than "we don't know."
 *
 * The math primitive: P10/P90 use ±1.2816σ on the assumption of a
 * normal distribution. For values that aren't normal (e.g. log-normal
 * decay times), callers can override via opts.kSigma. The default
 * matches NOAA SWPC's published forecast bounds convention.
 */

import { provStore } from './provenance.js';

const K_P10_P90 = 1.2816;   // 1σ → 80% interval bracket

/* ─── Number formatting ──────────────────────────────────────── */

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

/* ─── Text formatters ────────────────────────────────────────── */

/** Compact "value ±sigma unit" form. Sigma omitted if not present. */
export function formatBandSigma(rec) {
    if (!rec) return '—';
    const v = fmt(rec.value);
    const u = rec.unit ? ` ${rec.unit}` : '';
    if (rec.sigma == null) return `${v}${u}`;
    return `${v} ±${fmt(rec.sigma)}${u}`;
}

/** Bracketed P-band: "value (low / high)". kSigma defaults to P10/P90. */
export function formatBandRange(rec, kSigma = K_P10_P90) {
    if (!rec) return '—';
    const v = fmt(rec.value);
    const u = rec.unit ? ` ${rec.unit}` : '';
    if (rec.sigma == null) return `${v}${u}`;
    const lo = rec.value - kSigma * rec.sigma;
    const hi = rec.value + kSigma * rec.sigma;
    return `${v}${u} (${fmt(lo)} / ${fmt(hi)})`;
}

/* ─── Whiskers SVG ───────────────────────────────────────────── */

/**
 * Tiny inline SVG showing value as a dot on a track, with a
 * translucent range bar at ±k·σ. opts.range = { min, max } anchors
 * the track; if omitted we infer a sensible window from value ±3σ.
 */
export function buildWhiskersSvg(rec, opts = {}) {
    const W = opts.width  ?? 90;
    const H = opts.height ?? 14;
    const kSigma = opts.kSigma ?? K_P10_P90;

    if (!rec || !Number.isFinite(rec.value)) {
        return `<svg width="${W}" height="${H}" class="op-band-whisker" aria-hidden="true"></svg>`;
    }

    const sigma = Number.isFinite(rec.sigma) ? rec.sigma : 0;
    const inferredMin = rec.value - 3 * (sigma || Math.abs(rec.value) || 1);
    const inferredMax = rec.value + 3 * (sigma || Math.abs(rec.value) || 1);
    const min = opts.range?.min ?? inferredMin;
    const max = opts.range?.max ?? inferredMax;

    const span = (max - min) || 1;
    const norm = (v) => Math.max(0, Math.min(1, (v - min) / span));

    const dotX = norm(rec.value) * W;
    const loX  = norm(rec.value - kSigma * sigma) * W;
    const hiX  = norm(rec.value + kSigma * sigma) * W;
    const rangeW = Math.max(1.5, hiX - loX);
    const trackY = H / 2;

    const rangeRect = sigma > 0
        ? `<rect x="${loX.toFixed(2)}" y="${trackY - 2}" width="${rangeW.toFixed(2)}" height="4" rx="1.5" class="op-band-whisker-range"/>` +
          `<line x1="${loX.toFixed(2)}" y1="${trackY - 4}" x2="${loX.toFixed(2)}" y2="${trackY + 4}" class="op-band-whisker-tick"/>` +
          `<line x1="${hiX.toFixed(2)}" y1="${trackY - 4}" x2="${hiX.toFixed(2)}" y2="${trackY + 4}" class="op-band-whisker-tick"/>`
        : '';

    return `<svg width="${W}" height="${H}" class="op-band-whisker" aria-hidden="true">
        <rect x="0" y="${trackY - 0.75}" width="${W}" height="1.5" rx="0.75" class="op-band-whisker-track"/>
        ${rangeRect}
        <circle cx="${dotX.toFixed(2)}" cy="${trackY}" r="2.5" class="op-band-whisker-dot"/>
    </svg>`;
}

/* ─── Bindings ──────────────────────────────────────────────── */

/**
 * Bind a node to a banded provenance value. Style controls render:
 *   'sigma'    — provStore.bind with { format: formatBandSigma }
 *   'range'    — provStore.bind with { format: rec => formatBandRange }
 *   'whiskers' — innerHTML SVG, refreshed on provStore change
 *
 * Returns an unsubscribe function. The node always carries
 * data-prov-key so hover/click delegation in provenance.js still
 * surfaces the tooltip and drawer.
 */
export function bindBand(node, key, opts = {}) {
    if (!node) return () => {};
    // All three styles render HTML (styled ±sigma spans or SVG), so
    // every binding goes through the custom render path —
    // provStore.bind sets textContent which would print our markup
    // literally.
    const style  = opts.style  || 'sigma';
    const kSigma = opts.kSigma ?? K_P10_P90;
    return _bindCustomRender(node, key, opts, style, kSigma);
}

function _bindCustomRender(node, key, opts, style, kSigma) {
    node.dataset.provKey = key;

    function render() {
        const rec = provStore.get(key);
        if (!rec) return;
        if (style === 'sigma') {
            node.innerHTML = formatBandSigmaHtml(rec);
        } else if (style === 'range') {
            node.innerHTML = formatBandRangeHtml(rec, kSigma);
        } else if (style === 'whiskers') {
            node.innerHTML = buildWhiskersSvg(rec, opts);
        }
    }

    render();
    const off = provStore.subscribe(k => { if (k === key) render(); });
    return () => {
        off();
        if (node.dataset.provKey === key) delete node.dataset.provKey;
    };
}

/* ─── HTML variants (styled spans) ──────────────────────────── */

function formatBandSigmaHtml(rec) {
    if (!rec) return '—';
    const v = fmt(rec.value);
    const u = rec.unit ? ` ${escapeHtml(rec.unit)}` : '';
    if (rec.sigma == null) return `<span class="op-band-v">${v}${u}</span>`;
    return `<span class="op-band-v">${v}</span><span class="op-band-sigma">±${fmt(rec.sigma)}</span><span class="op-band-u">${u}</span>`;
}

function formatBandRangeHtml(rec, kSigma) {
    if (!rec) return '—';
    const v = fmt(rec.value);
    const u = rec.unit ? ` ${escapeHtml(rec.unit)}` : '';
    if (rec.sigma == null) return `<span class="op-band-v">${v}${u}</span>`;
    const lo = rec.value - kSigma * rec.sigma;
    const hi = rec.value + kSigma * rec.sigma;
    return `<span class="op-band-v">${v}${u}</span><span class="op-band-range"> (${fmt(lo)} / ${fmt(hi)})</span>`;
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* ─── Constants exposed for callers ─────────────────────────── */

export const K_SIGMA = Object.freeze({
    P10_P90: K_P10_P90,
    P05_P95: 1.6449,
    P01_P99: 2.3263,
});
