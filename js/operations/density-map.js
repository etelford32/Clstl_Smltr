/**
 * density-map.js — Debris density heatmap (altitude × inclination).
 *
 * Togglable overlay that bins every loaded debris TLE by altitude
 * (50 km cells, 200–1500 km) and inclination (10° cells, 0–180°)
 * and renders the count per cell as an SVG heatmap. Operators can
 * see at a glance which orbital regimes are crowded — the famous
 * sun-sync band at 800 km × 98°, the polar gap, the 60° belt.
 *
 * Data refreshes when the fleet module's loaded-groups change
 * (provStore.fleet.count.* events). Off by default; the Layers
 * panel exposes the toggle.
 */

import { provStore } from './provenance.js';
import { classifyDebris, shortFamilyName } from '../debris-catalog.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// NORAD → family cache; the catalog doesn't reattribute an object, so
// this survives re-renders (layer toggles, fleet edits) for free.
const _famCache = new Map();

function familyOf(t) {
    const id = t.norad_id;
    let f = _famCache.get(id);
    if (f === undefined) {
        f = classifyDebris({ name: t.name, noradId: id });
        _famCache.set(id, f);
    }
    return f;
}

const ALT_MIN_KM = 200;
const ALT_MAX_KM = 1500;
const ALT_STEP   = 50;
const INC_STEP   = 10;

const W = 360;
const H = 180;
const PAD_L = 36;
const PAD_R = 8;
const PAD_T = 6;
const PAD_B = 22;

let _hostEl   = null;
let _gridEl   = null;
let _legendEl = null;
let _trackerRef = null;

function el(tag, attrs = {}) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
}

function buildBins(debrisTles) {
    const altBins = Math.ceil((ALT_MAX_KM - ALT_MIN_KM) / ALT_STEP);
    const incBins = Math.ceil(180 / INC_STEP);
    const grid = Array.from({ length: incBins }, () => new Int32Array(altBins));
    // Per-cell family tallies (lazy Maps — most cells are empty) plus a
    // global per-family tally for the legend strip. Attribution comes
    // from debris-catalog's NORAD-range / name-pattern classifier, so
    // the crowded 800 km × 98° cell can say "mostly Fengyun-1C ASAT".
    const famGrid   = Array.from({ length: incBins }, () => new Array(altBins).fill(null));
    const famTotals = new Map();     // family.id → { family, count }
    let total = 0;
    for (const t of debrisTles) {
        if (!t) continue;
        const alt = (t.apogee_km != null && t.perigee_km != null)
            ? (t.apogee_km + t.perigee_km) / 2
            : null;
        const inc = t.inclination;
        if (!Number.isFinite(alt) || !Number.isFinite(inc)) continue;
        if (alt < ALT_MIN_KM || alt >= ALT_MAX_KM) continue;
        const ai = Math.min(altBins - 1, Math.floor((alt - ALT_MIN_KM) / ALT_STEP));
        const ii = Math.min(incBins - 1, Math.max(0, Math.floor(inc / INC_STEP)));
        grid[ii][ai]++;
        total++;
        const fam = familyOf(t);
        if (fam) {
            let cell = famGrid[ii][ai];
            if (!cell) { cell = new Map(); famGrid[ii][ai] = cell; }
            cell.set(fam.id, (cell.get(fam.id) ?? 0) + 1);
            const g = famTotals.get(fam.id);
            if (g) g.count++;
            else famTotals.set(fam.id, { family: fam, count: 1 });
        }
    }
    let max = 0;
    for (const row of grid) for (const v of row) if (v > max) max = v;
    return { grid, max, total, famGrid, famTotals };
}

/** Dominant family in a cell's tally Map: { family, count } | null. */
function dominantFamily(cellMap, famTotals) {
    if (!cellMap) return null;
    let bestId = null, bestN = 0;
    for (const [id, n] of cellMap) {
        if (n > bestN) { bestN = n; bestId = id; }
    }
    return bestId ? { family: famTotals.get(bestId)?.family ?? null, count: bestN } : null;
}

function colorFor(count, max) {
    if (count === 0) return null;
    const t = Math.min(1, Math.log10(1 + count) / Math.log10(1 + Math.max(1, max)));
    // Cool → hot ramp via HSL sweep
    const hue = (220 - 220 * t);                 // blue → red
    const sat = 60 + 30 * t;                     // 60% → 90%
    const lit = 40 + 25 * t;                     // 40% → 65%
    return `hsl(${hue.toFixed(0)}, ${sat.toFixed(0)}%, ${lit.toFixed(0)}%)`;
}

function ensureMounted() {
    if (_hostEl) return _hostEl;
    _hostEl = document.createElement('div');
    _hostEl.id = 'op-density';
    _hostEl.className = 'op-density op-density-hidden';
    _hostEl.innerHTML = `
        <div class="op-density-head">
            <span class="op-density-title">Debris density</span>
            <span class="op-density-sub">altitude × inclination · log scale</span>
            <button class="op-density-close" type="button" aria-label="Close">×</button>
        </div>
        <svg id="op-density-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"></svg>
        <div class="op-density-legend" id="op-density-legend"></div>
    `;
    const wrap = document.getElementById('op-globe-wrap') || document.body;
    wrap.appendChild(_hostEl);
    _gridEl   = _hostEl.querySelector('#op-density-svg');
    _legendEl = _hostEl.querySelector('#op-density-legend');

    _hostEl.querySelector('.op-density-close')
        .addEventListener('click', () => setVisible(false));
    return _hostEl;
}

function render() {
    if (!_hostEl) return;
    const debris = _trackerRef?.getTlesByGroup?.('debris') || [];
    const { grid, max, total, famGrid, famTotals } = buildBins(debris);

    const incBins = grid.length;
    const altBins = grid[0]?.length ?? 0;
    const cellW = (W - PAD_L - PAD_R) / altBins;
    const cellH = (H - PAD_T - PAD_B) / incBins;

    const elems = [];

    elems.push(el('rect', {
        x: 0, y: 0, width: W, height: H,
        class: 'op-density-bg',
    }));

    // Cells (one rect per non-zero bin).
    for (let i = 0; i < incBins; i++) {
        for (let a = 0; a < altBins; a++) {
            const c = grid[i][a];
            const fill = colorFor(c, max);
            if (!fill) continue;
            const rect = el('rect', {
                x: (PAD_L + a * cellW).toFixed(2),
                y: (PAD_T + (incBins - 1 - i) * cellH).toFixed(2),
                width: cellW.toFixed(2),
                height: cellH.toFixed(2),
                fill,
                class: 'op-density-cell',
            });
            // Native SVG tooltip: bin bounds, count, and the dominant
            // fragmentation family when one is attributed.
            const altLo = ALT_MIN_KM + a * ALT_STEP;
            const dom = dominantFamily(famGrid[i][a], famTotals);
            const domBit = (dom?.family && dom.family.id !== 'unknown')
                ? ` · mostly ${shortFamilyName(dom.family)} (${Math.round(100 * dom.count / c)}%)`
                : '';
            const tip = el('title');
            tip.textContent =
                `${altLo}–${altLo + ALT_STEP} km × ${i * INC_STEP}–${(i + 1) * INC_STEP}° · ` +
                `${c} object${c === 1 ? '' : 's'}${domBit}`;
            rect.appendChild(tip);
            elems.push(rect);
        }
    }

    // Axis ticks
    for (let a = 0; a <= altBins; a += 4) {
        const x = PAD_L + a * cellW;
        elems.push(el('line', {
            x1: x, y1: H - PAD_B, x2: x, y2: H - PAD_B + 3,
            class: 'op-density-tick',
        }));
        const tx = el('text', {
            x: x.toFixed(2),
            y: (H - PAD_B + 13).toFixed(2),
            class: 'op-density-tick-label',
            'text-anchor': 'middle',
        });
        tx.textContent = `${ALT_MIN_KM + a * ALT_STEP}`;
        elems.push(tx);
    }
    for (let i = 0; i <= incBins; i += 3) {
        const y = PAD_T + (incBins - i) * cellH;
        elems.push(el('line', {
            x1: PAD_L - 3, y1: y, x2: PAD_L, y2: y,
            class: 'op-density-tick',
        }));
        const tx = el('text', {
            x: (PAD_L - 5).toFixed(2),
            y: (y + 3).toFixed(2),
            class: 'op-density-tick-label',
            'text-anchor': 'end',
        });
        tx.textContent = `${i * INC_STEP}°`;
        elems.push(tx);
    }
    // Axis labels
    const axTitleAlt = el('text', {
        x: (PAD_L + (W - PAD_L - PAD_R) / 2).toFixed(2),
        y: (H - 2).toFixed(2),
        class: 'op-density-axis',
        'text-anchor': 'middle',
    });
    axTitleAlt.textContent = 'altitude (km)';
    elems.push(axTitleAlt);

    const axTitleInc = el('text', {
        x: 8, y: (PAD_T + 8).toFixed(2),
        class: 'op-density-axis',
    });
    axTitleInc.textContent = 'incl';
    elems.push(axTitleInc);

    _gridEl.innerHTML = '';
    elems.forEach(e => _gridEl.appendChild(e));

    // Legend: total + "max cell", then the family strip — the top
    // fragmentation events among the loaded debris, colored with the
    // same swatches the upper-atmosphere globe uses for those clouds.
    let famStrip = '';
    if (total > 0 && famTotals.size > 0) {
        const top = [...famTotals.values()]
            .filter(x => x.family && x.family.id !== 'unknown')
            .sort((a, b) => b.count - a.count)
            .slice(0, 4);
        if (top.length > 0) {
            famStrip = `<div class="op-density-fams">` + top.map(x =>
                `<span class="op-density-fam" title="${x.family.name} — ${x.family.summary ?? ''} Hazard tier: ${x.family.hazardTier}.">` +
                `<span class="op-density-fam-dot" style="background:${x.family.color}"></span>` +
                `${shortFamilyName(x.family)} ${x.count.toLocaleString()}</span>`,
            ).join('') + `</div>`;
        }
    }
    _legendEl.innerHTML = total === 0
        ? `<span class="op-density-empty">No debris loaded — toggle the Tracked Debris layer.</span>`
        : `<div class="op-density-legend-row"><span>${total.toLocaleString()} debris in window</span>
           <span class="op-density-max">peak ${max} / cell</span></div>${famStrip}`;
}

let _visible = false;

export function setVisible(on) {
    ensureMounted();
    _visible = !!on;
    _hostEl.classList.toggle('op-density-hidden', !_visible);
    if (_visible) render();
}

export function toggle() {
    setVisible(!_visible);
}

export function isVisible() { return _visible; }

export function mountDensityMap(tracker) {
    _trackerRef = tracker;
    ensureMounted();
    setVisible(false);

    // Recompute when the debris catalog count changes (group toggled,
    // or follow-up CelesTrak refresh).
    provStore.subscribe(key => {
        if (key === 'fleet.count.debris' && _visible) render();
    });
}
