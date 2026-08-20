/**
 * pollution-timeline.js — the Pollution Lab's time-machine chrome: a
 * scrubbable timeline strip and a multi-series city chart, both canvas.
 *
 * Rendering only. Every number it draws arrives already computed from
 * js/pollution-timeseries.js (which is pure and node-tested); this module
 * owns pixels, pointer handling, and the two palettes — and nothing else.
 * If you find yourself computing a statistic in here, it belongs next door.
 *
 * ── COLOR: TWO PALETTES, TWO JOBS, NEVER SWAPPED ──────────────────────────
 *
 * The EPA AQI colors encode MAGNITUDE (how bad the air is). They are the
 * page's scale for the field, the city dots, the cluster readouts, and the
 * category bands behind the timeline. They must never be used to tell one
 * city's line from another's: the moment two series are colored by their
 * value, color stops meaning identity and the reader can no longer follow a
 * line across a crossing.
 *
 * So series identity uses a separate CATEGORICAL palette (`SERIES_COLORS`) —
 * six hues in fixed order, assigned by rank and then frozen to the entity, so
 * removing a city never repaints the survivors. The set is validated against
 * this page's own dark surface (#08101c): OKLCH lightness band, chroma floor,
 * protanopia/deuteranopia ΔE ≥ 8, normal-vision ΔE ≥ 15, and ≥ 3:1 contrast
 * all pass. Six is the cap on purpose — a seventh hue would have to be
 * invented, and invented hues are where categorical palettes go wrong. Past
 * six the page folds to "others" rather than growing the palette.
 *
 * ── GAPS ARE HOLES, NOT ZEROS ─────────────────────────────────────────────
 *
 * `finiteSegments()` decides what may be joined. A missing CAMS hour leaves a
 * visible break in the line and no marker — never a dip to the floor, which
 * would read as clean air at exactly the moment we know nothing.
 *
 * ── FORECAST IS DASHED ────────────────────────────────────────────────────
 *
 * Everything at or before `nowIndex` is CAMS hindcast; everything after is
 * CAMS forecast. The forecast tail is drawn dashed and dimmed, with a labelled
 * "now" rule between them, on every chart in this module. A forecast drawn
 * like an observation is the same lie as a gap drawn like clean air.
 */

import { finiteSegments } from './pollution-timeseries.js';
import { airQualityMetricColor } from './air-quality-frame.js';

// ── Palettes ───────────────────────────────────────────────────────────────

/**
 * Categorical series identity — dark-mode steps, fixed order, never cycled.
 * Validated as a set against surface #08101c (see the header).
 */
export const SERIES_COLORS = Object.freeze([
    '#3987e5',   // 1 blue
    '#d95926',   // 2 orange
    '#199e70',   // 3 aqua
    '#c98500',   // 4 yellow
    '#d55181',   // 5 magenta
    '#008300',   // 6 green
]);
export const MAX_SERIES = SERIES_COLORS.length;

/**
 * EPA PM2.5 sub-index band edges (µg/m³) with their category colors, for the
 * magnitude context bands behind the timeline. Edges are the EPA breakpoints
 * the rest of the site uses; colors come from the shared scale so the bands
 * and the map legend can never drift apart.
 */
export const PM_BANDS = Object.freeze([
    { to: 9.0, label: 'good' },
    { to: 35.4, label: 'moderate' },
    { to: 55.4, label: 'unhealthy (sensitive)' },
    { to: 125.4, label: 'unhealthy' },
    { to: 225.4, label: 'very unhealthy' },
    { to: Infinity, label: 'hazardous' },
]);

const INK = '#c9d8ea';
const INK_DIM = '#5f7597';
const INK_HI = '#f0f6ff';
const ACCENT = '#4ddbff';
const GRID_LINE = 'rgba(77, 219, 255, .10)';
const FONT = "11px ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const FONT_SM = "10px ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

const cssRgb = ([r, g, b]) =>
    `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;

/** Mid-band color for a PM2.5 band, from the ONE shared AQI scale. */
function bandColor(i) {
    const lo = i === 0 ? 0 : PM_BANDS[i - 1].to;
    const hi = Number.isFinite(PM_BANDS[i].to) ? PM_BANDS[i].to : lo * 1.4;
    return cssRgb(airQualityMetricColor('pm25', (lo + hi) / 2));
}

// ── Shared canvas helpers ──────────────────────────────────────────────────

/**
 * Size a canvas to its CSS box at device pixel ratio and return the 2D
 * context already scaled, so every draw call below works in CSS pixels.
 * Returns null when the element has no layout yet (display:none, pre-mount) —
 * callers skip the frame rather than drawing into a 0×0 buffer.
 */
function prepare(canvas, { minHeight = 40 } = {}) {
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(minHeight, Math.round(rect.height));
    if (cssW < 8) return null;
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    const wantW = Math.round(cssW * dpr), wantH = Math.round(cssH * dpr);
    if (canvas.width !== wantW || canvas.height !== wantH) {
        canvas.width = wantW; canvas.height = wantH;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return { ctx, w: cssW, h: cssH };
}

function fmtHour(ms) {
    const d = new Date(ms);
    return `${String(d.getUTCHours()).padStart(2, '0')}:00Z`;
}
function fmtDay(ms) {
    return new Date(ms).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', timeZone: 'UTC',
    });
}
export function fmtStamp(ms) {
    return `${fmtDay(ms)} ${fmtHour(ms)}`;
}

/**
 * Draw the UTC-midnight gridlines and label the ones that fit.
 *
 * Six days across a 230 px panel is six labels in ~38 px each: without the
 * measured skip they print as "Aug 16Aug 17Aug 18…" — one unreadable word.
 * The LINES are always drawn (they carry the day boundary); only the text is
 * thinned, so the grid never loses information the label was carrying.
 */
function drawDayTicks(ctx, { times, count }, xAt, top, plotH, baselineY, right) {
    ctx.font = FONT_SM;
    let lastLabelEnd = -Infinity;
    for (let i = 0; i < count; i++) {
        const d = new Date(times[i]);
        if (d.getUTCHours() !== 0) continue;
        const x = xAt(i);
        ctx.strokeStyle = GRID_LINE;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + plotH); ctx.stroke();
        const label = fmtDay(times[i]);
        const tw = ctx.measureText(label).width;
        if (x + 3 < lastLabelEnd + 6 || x + 3 + tw > right) continue;
        ctx.fillStyle = INK_DIM;
        ctx.fillText(label, x + 3, baselineY);
        lastLabelEnd = x + 3 + tw;
    }
}

/** "nice" axis maximum so the y-scale doesn't jitter on every scrub. */
function niceMax(v) {
    if (!Number.isFinite(v) || v <= 0) return 10;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
        if (v <= m * mag) return m * mag;
    }
    return 10 * mag;
}

// ── 1. Timeline strip ──────────────────────────────────────────────────────

/**
 * The scrubber: TWO PM2.5 curves across the whole window, EPA category bands
 * behind them, a labelled "now" rule, day ticks, and a draggable playhead.
 *
 * The filled curve is population-weighted metro EXPOSURE — the one that moves,
 * and therefore the one a reader can navigate by (see exposureSeries). The thin
 * dim curve is the area-weighted GLOBAL mean, the climate panel's quantity.
 * Same unit, same quantity, ONE axis — never a second y-scale. The distance
 * between them is the point: the planetary average is nothing like what a city
 * dweller breathes.
 *
 * It is the page's PRIMARY time control — clicking anywhere on it seeks, and
 * it is focusable so ←/→ step an hour (shift = a day) and Home/End jump to the
 * ends. A scrubber that only responds to a separate slider makes the chart
 * look decorative; this one IS the slider.
 */
export class TimelineStrip {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {{ onSeek?: (index:number) => void }} [opts]
     */
    constructor(canvas, { onSeek = null } = {}) {
        this.canvas = canvas;
        this.onSeek = onSeek;
        this.history = null;
        this.mean = null;         // primary: population-weighted exposure
        this.secondary = null;    // area-weighted global mean, drawn thin
        this.index = 0;
        this.hoverIndex = -1;
        this._dragging = false;
        this._pad = { l: 40, r: 10, t: 14, b: 30 };

        const seekFromEvent = (e, force = false) => {
            if (!this.history?.count) return;
            const rect = canvas.getBoundingClientRect();
            const { l, r } = this._pad;
            const plotW = Math.max(1, rect.width - l - r);
            const t = (e.clientX - rect.left - l) / plotW;
            const i = Math.round(t * (this.history.count - 1));
            this._emit(Math.max(0, Math.min(this.history.count - 1, i)), { force });
        };

        canvas.addEventListener('pointerdown', e => {
            this._dragging = true;
            canvas.setPointerCapture?.(e.pointerId);
            canvas.focus?.({ preventScroll: true });
            seekFromEvent(e, true);
        });
        canvas.addEventListener('pointermove', e => {
            if (this._dragging) { seekFromEvent(e); return; }
            const rect = canvas.getBoundingClientRect();
            const { l, r } = this._pad;
            const plotW = Math.max(1, rect.width - l - r);
            const t = (e.clientX - rect.left - l) / plotW;
            const i = Math.round(t * ((this.history?.count ?? 1) - 1));
            const next = (t >= -0.02 && t <= 1.02 && this.history?.count)
                ? Math.max(0, Math.min(this.history.count - 1, i)) : -1;
            if (next !== this.hoverIndex) { this.hoverIndex = next; this.draw(); }
        });
        const end = e => {
            if (!this._dragging) return;
            this._dragging = false;
            canvas.releasePointerCapture?.(e.pointerId);
        };
        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointercancel', end);
        canvas.addEventListener('pointerleave', () => {
            if (this.hoverIndex !== -1) { this.hoverIndex = -1; this.draw(); }
        });
        canvas.addEventListener('keydown', e => {
            if (!this.history?.count) return;
            const last = this.history.count - 1;
            const jump = e.shiftKey ? Math.max(1, Math.round(24 / this.history.stepHours)) : 1;
            let next = null;
            if (e.key === 'ArrowLeft') next = this.index - jump;
            else if (e.key === 'ArrowRight') next = this.index + jump;
            else if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = last;
            else if (e.key === 'n' || e.key === 'N') next = this.history.nowIndex;
            if (next == null) return;
            e.preventDefault();
            this._emit(Math.max(0, Math.min(last, next)));
        });
    }

    /**
     * `force` distinguishes a fresh press from a drag that has not left its
     * frame. A press on the frame the playhead already sits on must still
     * seek — that is how a reader takes control of a map that is showing the
     * live sample — but a drag holding still would otherwise re-seek every
     * pointermove, and each seek rebuilds a field and re-runs k-means.
     */
    _emit(index, { force = false } = {}) {
        if (index === this.index && !force) { this.draw(); return; }
        this.index = index;
        this.draw();
        this.onSeek?.(index);
    }

    /**
     * @param {object} history
     * @param {ArrayLike<number>} primary   population-weighted exposure
     * @param {ArrayLike<number>} [secondary] area-weighted global mean
     */
    setData(history, primary, secondary = null) {
        this.history = history;
        this.mean = primary;
        this.secondary = secondary;
        this.index = Math.max(0, Math.min((history?.count ?? 1) - 1, history?.nowIndex ?? 0));
        this.draw();
    }

    setIndex(index) {
        if (!this.history?.count) return;
        this.index = Math.max(0, Math.min(this.history.count - 1, Math.round(index)));
        this.draw();
    }

    draw() {
        const prep = prepare(this.canvas, { minHeight: 84 });
        if (!prep) return;
        const { ctx, w, h } = prep;
        const { l, r, t: top, b } = this._pad;
        const plotW = Math.max(1, w - l - r);
        const plotH = Math.max(1, h - top - b);
        const hist = this.history;

        if (!hist?.count || !this.mean) {
            ctx.fillStyle = INK_DIM;
            ctx.font = FONT;
            ctx.fillText('history unavailable — the live field is still on the map', l, top + plotH / 2);
            return;
        }

        const n = hist.count;
        const xAt = i => l + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
        let peak = 0;
        for (const series of [this.mean, this.secondary]) {
            if (!series) continue;
            for (let i = 0; i < n; i++) if (Number.isFinite(series[i])) peak = Math.max(peak, series[i]);
        }
        const yMax = niceMax(peak * 1.12);
        const yAt = v => top + plotH - Math.max(0, Math.min(1, v / yMax)) * plotH;

        // ── EPA magnitude bands behind the curve. Faint: they are context for
        // the curve's height, not marks of their own.
        let lo = 0;
        for (let i = 0; i < PM_BANDS.length && lo < yMax; i++) {
            const hi = Math.min(yMax, PM_BANDS[i].to);
            ctx.globalAlpha = 0.10;
            ctx.fillStyle = bandColor(i);
            ctx.fillRect(l, yAt(hi), plotW, yAt(lo) - yAt(hi));
            ctx.globalAlpha = 1;
            lo = PM_BANDS[i].to;
        }

        // ── Day gridlines + labels on UTC midnights.
        ctx.textBaseline = 'alphabetic';
        drawDayTicks(ctx, hist, xAt, top, plotH, top + plotH + 12, w - r);

        // ── The area-weighted global mean, thin and dim, on the SAME axis.
        if (this.secondary) {
            ctx.strokeStyle = 'rgba(201, 216, 234, .5)';
            ctx.lineWidth = 1;
            for (const [s2, e2] of finiteSegments(this.secondary)) {
                ctx.beginPath();
                for (let i = s2; i <= e2; i++) {
                    const x = xAt(i), y = yAt(this.secondary[i]);
                    i === s2 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
        }

        // ── The global-mean curve, split at `now`: solid area for hindcast,
        // dashed line for forecast. Gaps break both.
        const segs = finiteSegments(this.mean);
        for (const [s, e] of segs) {
            // Hindcast portion — filled area.
            const pastEnd = Math.min(e, hist.nowIndex);
            if (pastEnd >= s) {
                ctx.beginPath();
                ctx.moveTo(xAt(s), top + plotH);
                for (let i = s; i <= pastEnd; i++) ctx.lineTo(xAt(i), yAt(this.mean[i]));
                ctx.lineTo(xAt(pastEnd), top + plotH);
                ctx.closePath();
                ctx.fillStyle = 'rgba(77, 219, 255, .16)';
                ctx.fill();
                ctx.beginPath();
                for (let i = s; i <= pastEnd; i++) {
                    const x = xAt(i), y = yAt(this.mean[i]);
                    i === s ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                }
                ctx.strokeStyle = ACCENT;
                ctx.lineWidth = 2;
                ctx.stroke();
            }
            // Forecast portion — dashed, no fill, so it cannot be mistaken
            // for the observed record beside it.
            const fcStart = Math.max(s, hist.nowIndex);
            if (e > fcStart) {
                ctx.setLineDash([4, 3]);
                ctx.beginPath();
                for (let i = fcStart; i <= e; i++) {
                    const x = xAt(i), y = yAt(this.mean[i]);
                    i === fcStart ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                }
                ctx.strokeStyle = 'rgba(77, 219, 255, .62)';
                ctx.lineWidth = 1.6;
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        // ── "now" rule.
        if (hist.nowIndex > 0 && hist.nowIndex < n - 1) {
            const x = xAt(hist.nowIndex);
            ctx.setLineDash([2, 3]);
            ctx.strokeStyle = 'rgba(255, 179, 71, .75)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x, top - 3); ctx.lineTo(x, top + plotH); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#ffb347';
            ctx.font = FONT_SM;
            ctx.fillText('now', x + 3, top + 8);
        }

        // ── y axis: two labels only. The strip is 74 px tall; a full axis
        // would cost more ink than the curve.
        ctx.fillStyle = INK_DIM;
        ctx.font = FONT_SM;
        ctx.textAlign = 'right';
        ctx.fillText(`${yMax.toFixed(yMax < 10 ? 1 : 0)}`, l - 5, top + 8);
        ctx.fillText('0', l - 5, top + plotH);
        ctx.textAlign = 'left';
        ctx.save();
        ctx.translate(11, top + plotH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillText('µg/m³', 0, 0);
        ctx.restore();
        ctx.textAlign = 'left';

        // ── Legend. Two series on one axis need one, and it must name the
        // WEIGHTING, because that is the only difference between them.
        ctx.font = FONT_SM;
        ctx.textBaseline = 'alphabetic';
        const legendY = h - 5;
        let lx0 = l;
        ctx.fillStyle = ACCENT;
        ctx.fillRect(lx0, legendY - 4, 10, 2);
        ctx.fillStyle = INK_DIM;
        ctx.fillText('metro exposure (pop-weighted)', lx0 + 14, legendY);
        lx0 += 14 + ctx.measureText('metro exposure (pop-weighted)').width + 14;
        if (this.secondary && lx0 + 130 < w - r) {
            ctx.fillStyle = 'rgba(201, 216, 234, .5)';
            ctx.fillRect(lx0, legendY - 4, 10, 2);
            ctx.fillStyle = INK_DIM;
            ctx.fillText('global mean (area-weighted)', lx0 + 14, legendY);
        }

        // ── Hover ghost, then the playhead on top.
        if (this.hoverIndex >= 0 && this.hoverIndex !== this.index) {
            const x = xAt(this.hoverIndex);
            ctx.strokeStyle = 'rgba(201, 216, 234, .35)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + plotH); ctx.stroke();
        }
        const px = xAt(this.index);
        ctx.strokeStyle = INK_HI;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(px, top - 5); ctx.lineTo(px, top + plotH + 2); ctx.stroke();
        const pv = this.mean[this.index];
        if (Number.isFinite(pv)) {
            ctx.fillStyle = INK_HI;
            ctx.beginPath(); ctx.arc(px, yAt(pv), 3.2, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#04070d';
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(px, yAt(pv), 3.2, 0, Math.PI * 2); ctx.stroke();
        }

        // ── Playhead caption, flipped to the left near the right edge so it
        // never runs off the strip.
        const label = `${fmtStamp(hist.times[this.index])}${Number.isFinite(pv) ? ` · ${pv.toFixed(1)} µg/m³` : ' · no data'}`;
        ctx.font = FONT;
        const tw = ctx.measureText(label).width;
        const lx = px + 6 + tw > w - r ? px - 6 - tw : px + 6;
        ctx.fillStyle = this.index > hist.nowIndex ? '#ffb347' : INK;
        ctx.fillText(label, lx, top - 4);
    }
}

// ── 2. Multi-series city chart ─────────────────────────────────────────────

/**
 * Up to six city PM2.5 series over the window, plus a crosshair tied to the
 * scrubber's frame and a hover tooltip.
 *
 * Series colors come from SERIES_COLORS by the caller's assignment, NOT by
 * value — see the header. Each line also carries a direct end-label, so
 * identity survives a colorblind reader, a grayscale print, and a crossing.
 */
export class SeriesChart {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {{ onHover?: (index:number|null) => void, onSeek?: (index:number)=>void }} [opts]
     */
    constructor(canvas, { onHover = null, onSeek = null } = {}) {
        this.canvas = canvas;
        this.onHover = onHover;
        this.onSeek = onSeek;
        this.history = null;
        this.series = [];       // [{ label, values, color, siteIndex }]
        this.index = 0;
        this.hoverIndex = -1;
        this._pad = { l: 34, r: 62, t: 10, b: 18 };

        const toIndex = e => {
            if (!this.history?.count) return -1;
            const rect = canvas.getBoundingClientRect();
            const { l, r } = this._pad;
            const plotW = Math.max(1, rect.width - l - r);
            const t = (e.clientX - rect.left - l) / plotW;
            if (t < -0.03 || t > 1.03) return -1;
            return Math.max(0, Math.min(this.history.count - 1,
                Math.round(t * (this.history.count - 1))));
        };
        canvas.addEventListener('pointermove', e => {
            const i = toIndex(e);
            if (i !== this.hoverIndex) { this.hoverIndex = i; this.draw(); this.onHover?.(i < 0 ? null : i); }
        });
        canvas.addEventListener('pointerleave', () => {
            if (this.hoverIndex !== -1) { this.hoverIndex = -1; this.draw(); this.onHover?.(null); }
        });
        canvas.addEventListener('pointerdown', e => {
            const i = toIndex(e);
            if (i >= 0) this.onSeek?.(i);
        });
    }

    /** @param {{label, values, color, siteIndex}[]} series */
    setData(history, series) {
        this.history = history;
        this.series = series.slice(0, MAX_SERIES);
        this.draw();
    }

    setIndex(index) {
        this.index = Math.max(0, Math.min((this.history?.count ?? 1) - 1, Math.round(index)));
        this.draw();
    }

    draw() {
        const prep = prepare(this.canvas, { minHeight: 120 });
        if (!prep) return;
        const { ctx, w, h } = prep;
        const { l, r, t: top, b } = this._pad;
        const plotW = Math.max(1, w - l - r);
        const plotH = Math.max(1, h - top - b);
        const hist = this.history;

        if (!hist?.count || !this.series.length) {
            ctx.fillStyle = INK_DIM;
            ctx.font = FONT;
            ctx.fillText('no city series in this window', l, top + plotH / 2);
            return;
        }

        const n = hist.count;
        const xAt = i => l + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
        let peak = 0;
        for (const s of this.series) {
            for (let i = 0; i < n; i++) if (Number.isFinite(s.values[i])) peak = Math.max(peak, s.values[i]);
        }
        const yMax = niceMax(peak * 1.08);
        const yAt = v => top + plotH - Math.max(0, Math.min(1, v / yMax)) * plotH;

        // Recessive gridlines at the EPA breakpoints that fall inside the
        // range — the reader gets "moderate starts here" for free instead of
        // a decorative decimal grid.
        ctx.font = FONT_SM;
        // Breakpoint LINES always draw; the numbers beside them are skipped
        // when two breakpoints land within a line-height of each other (9 /
        // 35.4 / 55.4 collide on a 130 px plot and print as one smear).
        let lastLabelY = Infinity;
        for (const band of PM_BANDS) {
            if (!Number.isFinite(band.to) || band.to > yMax) continue;
            const y = yAt(band.to);
            ctx.strokeStyle = GRID_LINE;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(l + plotW, y); ctx.stroke();
            if (lastLabelY - y < 13) continue;
            lastLabelY = y;
            ctx.fillStyle = INK_DIM;
            ctx.textAlign = 'right';
            ctx.fillText(String(band.to), l - 4, y + 3);
            ctx.textAlign = 'left';
        }

        // Day ticks.
        drawDayTicks(ctx, hist, xAt, top, plotH, h - 6, l + plotW);

        // "now" rule.
        if (hist.nowIndex > 0 && hist.nowIndex < n - 1) {
            const x = xAt(hist.nowIndex);
            ctx.setLineDash([2, 3]);
            ctx.strokeStyle = 'rgba(255, 179, 71, .55)';
            ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + plotH); ctx.stroke();
            ctx.setLineDash([]);
        }

        // Series: hindcast solid, forecast dashed, gaps unpainted.
        for (const s of this.series) {
            const segs = finiteSegments(s.values, { to: n });
            ctx.strokeStyle = s.color;
            ctx.lineJoin = 'round';
            for (const [a, e] of segs) {
                const pastEnd = Math.min(e, hist.nowIndex);
                if (pastEnd >= a) {
                    ctx.setLineDash([]);
                    ctx.lineWidth = 2;
                    ctx.globalAlpha = 1;
                    ctx.beginPath();
                    for (let i = a; i <= pastEnd; i++) {
                        const x = xAt(i), y = yAt(s.values[i]);
                        i === a ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                    }
                    ctx.stroke();
                }
                const fcStart = Math.max(a, hist.nowIndex);
                if (e > fcStart) {
                    ctx.setLineDash([4, 3]);
                    ctx.lineWidth = 1.6;
                    ctx.globalAlpha = 0.75;
                    ctx.beginPath();
                    for (let i = fcStart; i <= e; i++) {
                        const x = xAt(i), y = yAt(s.values[i]);
                        i === fcStart ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                    }
                    ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.globalAlpha = 1;
                }
            }
        }

        // Direct end-labels in the right gutter, nudged apart so two close
        // cities don't overprint each other.
        const labels = this.series.map(s => {
            let last = null;
            for (let i = n - 1; i >= 0; i--) if (Number.isFinite(s.values[i])) { last = i; break; }
            return last == null ? null : { s, y: yAt(s.values[last]) };
        }).filter(Boolean).sort((a, b) => a.y - b.y);
        for (let i = 1; i < labels.length; i++) {
            if (labels[i].y - labels[i - 1].y < 10) labels[i].y = labels[i - 1].y + 10;
        }
        ctx.font = FONT_SM;
        for (const { s, y } of labels) {
            ctx.fillStyle = s.color;
            ctx.fillRect(l + plotW + 3, Math.min(top + plotH, y) - 4, 6, 2);
            ctx.fillStyle = INK;
            ctx.fillText(s.label.slice(0, 8), l + plotW + 12, Math.min(top + plotH, y) + 0.5);
        }

        // Crosshair: the scrubber's frame always; the pointer's frame while
        // hovering. Both, when they differ — the reader is comparing them.
        const marks = [{ i: this.index, strong: true }];
        if (this.hoverIndex >= 0 && this.hoverIndex !== this.index) {
            marks.push({ i: this.hoverIndex, strong: false });
        }
        for (const { i, strong } of marks) {
            const x = xAt(i);
            ctx.strokeStyle = strong ? 'rgba(240, 246, 255, .8)' : 'rgba(201, 216, 234, .3)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + plotH); ctx.stroke();
            if (!strong) continue;
            for (const s of this.series) {
                const v = s.values[i];
                if (!Number.isFinite(v)) continue;
                ctx.fillStyle = s.color;
                ctx.beginPath(); ctx.arc(x, yAt(v), 3, 0, Math.PI * 2); ctx.fill();
                // 2 px surface ring so overlapping dots stay countable.
                ctx.strokeStyle = '#04070d';
                ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(x, yAt(v), 3, 0, Math.PI * 2); ctx.stroke();
            }
        }
    }

    /**
     * Rows for the caller's HTML tooltip / legend at a frame: label, color,
     * value (null for a gap), and whether the frame is forecast. Returned as
     * data rather than drawn, so the page can render real text that a screen
     * reader and a text search can both reach — a canvas tooltip is invisible
     * to both.
     */
    readout(index) {
        const i = Math.max(0, Math.min((this.history?.count ?? 1) - 1, Math.round(index)));
        return {
            index: i,
            timeMs: this.history?.times?.[i] ?? null,
            forecast: !!this.history && i > this.history.nowIndex,
            rows: this.series.map(s => ({
                label: s.label,
                color: s.color,
                siteIndex: s.siteIndex,
                value: Number.isFinite(s.values[i]) ? s.values[i] : null,
            })),
        };
    }
}

// ── 3. Sparkline ───────────────────────────────────────────────────────────

/**
 * One-series sparkline into a small canvas — used per pollution center so the
 * cluster list carries shape, not just a current number. No axes by design:
 * a sparkline is a word in a sentence, and its scale is stated in the text
 * beside it.
 */
export function drawSparkline(canvas, values, {
    color = ACCENT, nowIndex = Infinity, markIndex = -1, max = null,
} = {}) {
    const prep = prepare(canvas, { minHeight: 18 });
    if (!prep) return;
    const { ctx, w, h } = prep;
    const n = values?.length ?? 0;
    if (!n) return;
    let peak = Number.isFinite(max) ? max : 0;
    if (!Number.isFinite(max)) {
        for (let i = 0; i < n; i++) if (Number.isFinite(values[i])) peak = Math.max(peak, values[i]);
    }
    if (peak <= 0) return;
    const xAt = i => (n === 1 ? w / 2 : (i / (n - 1)) * (w - 2) + 1);
    const yAt = v => h - 1 - Math.max(0, Math.min(1, v / peak)) * (h - 2);

    for (const [a, e] of finiteSegments(values)) {
        const pastEnd = Math.min(e, nowIndex);
        if (pastEnd >= a) {
            ctx.beginPath();
            for (let i = a; i <= pastEnd; i++) {
                const x = xAt(i), y = yAt(values[i]);
                i === a ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.strokeStyle = color; ctx.lineWidth = 1.25; ctx.stroke();
        }
        const fc = Math.max(a, nowIndex);
        if (e > fc) {
            ctx.setLineDash([3, 2]);
            ctx.beginPath();
            for (let i = fc; i <= e; i++) {
                const x = xAt(i), y = yAt(values[i]);
                i === fc ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.strokeStyle = color; ctx.globalAlpha = 0.6; ctx.lineWidth = 1;
            ctx.stroke();
            ctx.globalAlpha = 1; ctx.setLineDash([]);
        }
    }
    if (markIndex >= 0 && markIndex < n && Number.isFinite(values[markIndex])) {
        ctx.fillStyle = INK_HI;
        ctx.beginPath(); ctx.arc(xAt(markIndex), yAt(values[markIndex]), 1.8, 0, Math.PI * 2);
        ctx.fill();
    }
}

// ── 4. Diurnal composite ───────────────────────────────────────────────────

function roundedTopRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h));
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, w, h, [rr, rr, 0, 0]);
        return;
    }
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
}

/**
 * 24 bars: mean PM2.5 by local solar hour.
 *
 * ONE series, and the bars encode MAGNITUDE — so here the EPA scale is the
 * correct palette (identity is carried by position on the hour axis, not by
 * color). This is the same reasoning that forbids the EPA scale on the
 * multi-city chart, applied in the other direction.
 *
 * Empty bins draw nothing at all rather than a zero-height bar at the
 * baseline, which would be indistinguishable from clean air.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{hours:number[], mean:(number|null)[], count:number[]}} profile
 */
export function drawDiurnal(canvas, profile, { markHour = -1 } = {}) {
    const prep = prepare(canvas, { minHeight: 46 });
    if (!prep) return;
    const { ctx, w, h } = prep;
    if (!profile?.mean?.length) {
        ctx.fillStyle = INK_DIM; ctx.font = FONT_SM;
        ctx.fillText('not enough hours for a diurnal composite', 2, h / 2);
        return;
    }
    const base = h - 12;
    let peak = 0;
    for (const v of profile.mean) if (Number.isFinite(v)) peak = Math.max(peak, v);
    if (peak <= 0) {
        ctx.fillStyle = INK_DIM; ctx.font = FONT_SM;
        ctx.fillText('no finite hours in this window', 2, h / 2);
        return;
    }
    const yMax = niceMax(peak * 1.05);
    // 2 px surface gap between neighbouring bars so 24 of them stay countable.
    const slot = w / 24;
    const barW = Math.max(2, slot - 2);

    ctx.font = FONT_SM;
    for (let b = 0; b < 24; b++) {
        const v = profile.mean[b];
        const x = b * slot + (slot - barW) / 2;
        if (!Number.isFinite(v)) continue;                    // empty bin: nothing
        const bh = Math.max(1, (v / yMax) * (base - 2));
        ctx.fillStyle = cssRgb(airQualityMetricColor('pm25', v));
        ctx.globalAlpha = b === markHour ? 1 : 0.82;
        roundedTopRect(ctx, x, base - bh, barW, bh, 4);
        ctx.fill();
        ctx.globalAlpha = 1;
    }
    // Hour ticks at 00 / 06 / 12 / 18 only — 24 labels would out-ink the bars.
    ctx.fillStyle = INK_DIM;
    for (const b of [0, 6, 12, 18]) {
        ctx.fillText(String(b).padStart(2, '0'), b * slot + 1, h - 2);
    }
    ctx.textAlign = 'right';
    ctx.fillText(`${yMax.toFixed(yMax < 10 ? 1 : 0)} µg/m³`, w - 1, 9);
    ctx.textAlign = 'left';
}

export default {
    TimelineStrip, SeriesChart, drawSparkline, drawDiurnal,
    SERIES_COLORS, MAX_SERIES, PM_BANDS, fmtStamp,
};
