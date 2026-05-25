/**
 * gannon-superstorm-charts.js — inline-SVG charts for the Gannon page
 * ═══════════════════════════════════════════════════════════════════════
 * Zero-dependency SVG renderer for the page's central panels. The
 * shared scaffolding (phase shading, time axis, SSC marker, hover
 * tooltip, cursor system, placeholder watermark) lives in
 * `_buildPlotFrame`; each chart factory adds trace-specific rendering
 * and provides a `formatHoverRows(idx)` callback to the shared hover.
 *
 * Exports:
 *   createApSaturationChart(container, replay, player, opts) → { setCursor }
 *   createDensityChart      (container, replay, player, opts) → { setCursor }
 *   createResidualsChart    (container, replay, player, opts) → { setCursor }
 */

const SVG_NS = "http://www.w3.org/2000/svg";

const MARGIN   = { top: 14, right: 16, bottom: 36, left: 56 };
const PLOT_W   = 800;
const PLOT_H   = 240;

const COLORS = {
    real:        "#888",
    mhd:         "#f96",
    gnd:         "#6cf",
    truth:       "#fc6",
    truthAlt:    "#fa9",   // Swarm-C, slightly distinct from GRACE-FO amber
    ceiling:     "#aaa",
    ssc:         "#ffb866",
    axis:        "rgba(255,255,255,.22)",
    grid:        "rgba(255,255,255,.07)",
    text:        "#bcd",
    textSubtle:  "#789",
    cursor:      "#fff",
    tooltipBg:   "rgba(8,4,20,0.96)",
    tooltipBd:   "rgba(255,255,255,0.18)",
};

const PHASE_FILL = {
    preroll:  "rgba(160,160,200,0.04)",   // dim violet — "CMEs in transit"
    ramp:     "rgba(255,200,80,0.05)",
    peak:     "rgba(255,80,80,0.07)",
    recovery: "rgba(120,200,255,0.04)",
};

// Storm-phase boundaries are anchor-relative (h=0 = 2024-05-10T12:00:00Z).
// PREROLL is [hoursMin, 0], then RAMP / PEAK / RECOVERY as before.
const PHASE_BOUNDARIES = { rampEndH: 8, peakEndH: 30 };

// SSC arrival, anchor-relative hours (h=0 = 2024-05-10T12:00:00Z).
// NOAA SWPC: the sheath shock hit DSCOVR at ~17:05 UT on May 10.
const SSC_HOURS = 5 + 5 / 60;

// ── tiny SVG helper ─────────────────────────────────────────────────

function svg(tag, attrs = {}, children = []) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) {
        if (attrs[k] === null || attrs[k] === undefined) continue;
        el.setAttribute(k, attrs[k]);
    }
    for (const c of children) {
        if (c == null) continue;
        if (typeof c === "string") el.appendChild(document.createTextNode(c));
        else                       el.appendChild(c);
    }
    return el;
}

// ── formatting ──────────────────────────────────────────────────────

function _fmtClock(t0Ms, hours) {
    const d = new Date(t0Ms + hours * 3600_000);
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mn = String(d.getUTCMinutes()).padStart(2, "0");
    return `${mm}-${dd} ${hh}:${mn}`;
}

// ── shared plot frame ──────────────────────────────────────────────
//
// Builds the SVG, axes, phase shading, SSC marker, plot border, cursor
// system, hover system, optional placeholder watermark. Each chart
// factory then registers trace-specific rendering and the hover-row
// formatter. Returns the API the factory needs to wire interactions.

function _buildPlotFrame(container, replay, opts) {
    const win      = replay.window;
    const t0Ms     = Date.parse(win.start);
    const t1Ms     = Date.parse(win.end);
    const anchorMs = Date.parse(win.anchor_iso || win.start);
    // Anchor-relative hours. hoursMin is negative for any bundle whose
    // start precedes the anchor (i.e. has CME-in-transit preroll).
    const hoursMin = (t0Ms - anchorMs) / 3600_000;
    const hoursMax = (t1Ms - anchorMs) / 3600_000;
    const dur_h    = hoursMax - hoursMin;
    const stepMin  = win.step_minutes || 60;
    const n        = (replay.drivers_compact?.ap_real || []).length;
    const isPlaceholder = !!(opts?.placeholder ?? replay._is_placeholder);

    const plotW = PLOT_W - MARGIN.left - MARGIN.right;
    const plotH = PLOT_H - MARGIN.top  - MARGIN.bottom;
    // xScale maps anchor-relative h to plot pixels.
    const xScale = h => MARGIN.left + ((h - hoursMin) / dur_h) * plotW;
    // idxAt maps anchor-relative h to the corresponding sample index in the
    // (window-start-aligned) data arrays.
    const idxAt  = h => Math.max(0, Math.min(n - 1,
        Math.round((h - hoursMin) * 60 / stepMin)));

    container.innerHTML = "";
    container.classList.remove("gn-pulse");

    const root = svg("svg", {
        viewBox: `0 0 ${PLOT_W} ${PLOT_H}`,
        preserveAspectRatio: "none",
        width:  "100%",
        height: "100%",
        role:   "img",
        "aria-label": opts?.ariaLabel || "Gannon storm timeseries chart",
        style:  "display:block;",
    });

    // ── phase shading + labels ──────────────────────────────────────
    // Preroll shading only renders if the window includes negative h
    // (i.e. CME-launch coverage). For pre-extension bundles where the
    // window starts at h=0, the preroll band has zero width and is a no-op.
    const phases = [
        { name: "preroll",  start: hoursMin,                   end: 0,                          fill: PHASE_FILL.preroll  },
        { name: "ramp",     start: 0,                          end: PHASE_BOUNDARIES.rampEndH,  fill: PHASE_FILL.ramp     },
        { name: "peak",     start: PHASE_BOUNDARIES.rampEndH,  end: PHASE_BOUNDARIES.peakEndH,  fill: PHASE_FILL.peak     },
        { name: "recovery", start: PHASE_BOUNDARIES.peakEndH,  end: hoursMax,                   fill: PHASE_FILL.recovery },
    ];
    for (const p of phases) {
        const x0 = xScale(p.start);
        const x1 = xScale(p.end);
        if (x1 - x0 < 1) continue;   // skip zero-width bands (no preroll case)
        root.appendChild(svg("rect", {
            x: x0, y: MARGIN.top, width: x1 - x0, height: plotH, fill: p.fill,
        }));
        // Don't draw the label if the band is narrower than the label
        // would need (~7 chars * 5px). Keeps short bands tidy.
        if (x1 - x0 >= 36) {
            root.appendChild(svg("text", {
                x: (x0 + x1) / 2, y: MARGIN.top + 11,
                "text-anchor": "middle",
                fill: COLORS.textSubtle,
                "font-size": 9,
                "font-family": "ui-monospace, monospace",
                "letter-spacing": "0.12em",
                opacity: 0.65,
            }, [p.name.toUpperCase()]));
        }
    }

    // ── X axis ──────────────────────────────────────────────────────
    // Ticks span [hoursMin, hoursMax]; tick step adapts to total range.
    const xTickEveryH = dur_h >= 96 ? 24 : (dur_h >= 60 ? 12 : 6);
    // Start at the smallest multiple of xTickEveryH that's ≥ hoursMin
    // (works correctly for negative hoursMin).
    const tickStart = Math.ceil(hoursMin / xTickEveryH) * xTickEveryH;
    for (let h = tickStart; h <= hoursMax; h += xTickEveryH) {
        const x = xScale(h);
        root.appendChild(svg("line", {
            x1: x, x2: x, y1: MARGIN.top, y2: PLOT_H - MARGIN.bottom,
            stroke: COLORS.grid,
        }));
        root.appendChild(svg("text", {
            x, y: PLOT_H - MARGIN.bottom + 14,
            "text-anchor": "middle",
            fill: COLORS.text,
            "font-size": 10,
            "font-family": "ui-monospace, monospace",
        }, [_fmtClock(anchorMs, h)]));
    }
    // Highlight the anchor (h=0 = storm onset / window-open) when the
    // window includes preroll — gives the eye a visual reference for
    // "this is where Earth-side ground truth starts".
    if (hoursMin < 0) {
        const x = xScale(0);
        root.appendChild(svg("line", {
            x1: x, x2: x, y1: MARGIN.top, y2: PLOT_H - MARGIN.bottom,
            stroke: "rgba(255,255,255,0.18)",
            "stroke-width": 1.2,
        }));
    }
    root.appendChild(svg("text", {
        x: PLOT_W - MARGIN.right, y: PLOT_H - 4,
        "text-anchor": "end",
        fill: COLORS.textSubtle,
        "font-size": 9,
        "font-family": "ui-monospace, monospace",
        "letter-spacing": "0.08em",
    }, ["UT  (mm-dd hh:mm)"]));

    // ── SSC marker ──────────────────────────────────────────────────
    const sscX = xScale(SSC_HOURS);
    root.appendChild(svg("line", {
        x1: sscX, x2: sscX,
        y1: MARGIN.top + 18, y2: PLOT_H - MARGIN.bottom,
        stroke: COLORS.ssc,
        "stroke-dasharray": "3 3",
        "stroke-width": 1,
        opacity: 0.7,
    }));
    root.appendChild(svg("text", {
        x: sscX + 4, y: MARGIN.top + 24,
        fill: COLORS.ssc,
        "font-size": 10,
        "font-family": "ui-monospace, monospace",
        opacity: 0.88,
    }, ["SSC  17:05 UT"]));

    // ── trace layer placeholder ─────────────────────────────────────
    // Each chart factory appends its traces into this group so they
    // sit beneath the cursor + hover overlay.
    const traceLayer = svg("g", { class: "gn-traces" });
    root.appendChild(traceLayer);

    // ── plot border ─────────────────────────────────────────────────
    root.appendChild(svg("rect", {
        x: MARGIN.left, y: MARGIN.top, width: plotW, height: plotH,
        fill: "none", stroke: COLORS.axis, "stroke-width": 1,
    }));

    // ── cursor system ───────────────────────────────────────────────
    const cursorLine = svg("line", {
        x1: MARGIN.left, x2: MARGIN.left,
        y1: MARGIN.top,  y2: PLOT_H - MARGIN.bottom,
        stroke: COLORS.cursor, "stroke-width": 1.2, opacity: 0.55,
    });
    root.appendChild(cursorLine);
    const cursorDots = [];
    function addCursorDot(color, opts = {}) {
        const d = svg("circle", {
            r: opts.r ?? 4,
            fill: color,
            stroke: "#000",
            "stroke-width": 1.5,
            "pointer-events": "none",   // events fall through to capture rect
        });
        root.appendChild(d);
        cursorDots.push({ el: d });
        return d;
    }

    // ── hover system ────────────────────────────────────────────────
    const hoverG = svg("g", { style: "pointer-events:none; opacity:0;" });
    const hoverLine = svg("line", {
        y1: MARGIN.top, y2: PLOT_H - MARGIN.bottom,
        stroke: "rgba(255,255,255,0.4)",
        "stroke-dasharray": "2 3",
    });
    const ttBg   = svg("rect", { rx: 4, ry: 4, fill: COLORS.tooltipBg, stroke: COLORS.tooltipBd });
    const ttText = svg("text", { "font-family": "ui-monospace, monospace", "font-size": 10, fill: "#fff" });
    hoverG.appendChild(hoverLine);
    hoverG.appendChild(ttBg);
    hoverG.appendChild(ttText);
    root.appendChild(hoverG);

    // Chart-specific formatter — set by the factory after frame build.
    let formatHoverRows = (_idx, _hours) => [];

    function paintTooltip(hours) {
        const x   = xScale(hours);
        const idx = idxAt(hours);
        hoverLine.setAttribute("x1", x);
        hoverLine.setAttribute("x2", x);

        const rows = formatHoverRows(idx, hours);
        // Compute box size from row count (each row ~13 px tall).
        const ttW = 168;
        const ttH = 14 + rows.length * 13;
        const pad = 7;
        const onRight = hours < dur_h / 2;
        const ttX = onRight
            ? Math.min(x + 10, PLOT_W - MARGIN.right - ttW - 2)
            : Math.max(x - ttW - 10, MARGIN.left + 2);
        const ttY = MARGIN.top + 6;
        ttBg.setAttribute("x", ttX);
        ttBg.setAttribute("y", ttY);
        ttBg.setAttribute("width", ttW);
        ttBg.setAttribute("height", ttH);
        ttText.setAttribute("x", ttX + pad);
        ttText.setAttribute("y", ttY + pad + 9);

        ttText.innerHTML = "";
        rows.forEach((r, i) => {
            const tspan = document.createElementNS(SVG_NS, "tspan");
            tspan.setAttribute("x", ttX + pad);
            tspan.setAttribute("dy", i === 0 ? 0 : 13);
            if (r.color) tspan.setAttribute("fill", r.color);
            tspan.textContent = r.text;
            ttText.appendChild(tspan);
        });
        hoverG.style.opacity = 1;
    }

    function clearTooltip() { hoverG.style.opacity = 0; }

    // ── capture rect (must be last child for event capture) ────────
    const capture = svg("rect", {
        x: MARGIN.left, y: MARGIN.top, width: plotW, height: plotH,
        fill: "transparent",
        style: "cursor:crosshair;",
    });
    function mouseHours(evt) {
        // Returns anchor-relative h (negative for preroll). Matches the
        // domain xScale and setCursor expect.
        const rect = root.getBoundingClientRect();
        const px = ((evt.clientX - rect.left) / rect.width) * PLOT_W;
        const hFrac = Math.max(0, Math.min(1, (px - MARGIN.left) / plotW));
        return hoursMin + hFrac * dur_h;
    }
    capture.addEventListener("mousemove", evt => paintTooltip(mouseHours(evt)));
    capture.addEventListener("mouseleave", clearTooltip);
    capture.addEventListener("click", evt => {
        if (typeof opts?.onClickSeekHours === "function") {
            opts.onClickSeekHours(mouseHours(evt));
        }
    });
    // Tooltip + cursor must render above the capture rect; but we still
    // want the capture rect inside the SVG so coords are in viewBox
    // space. The hover/cursor groups already appended are visually on
    // top because SVG paints in document order — the capture rect is
    // transparent, so hovering above tooltips still works.
    root.appendChild(capture);

    // ── placeholder watermark ───────────────────────────────────────
    if (isPlaceholder) {
        root.appendChild(svg("text", {
            x: PLOT_W / 2, y: PLOT_H / 2 + 6,
            "text-anchor": "middle",
            fill: "rgba(255,200,80,0.16)",
            "font-size": 56,
            "font-weight": 800,
            "font-family": "ui-monospace, monospace",
            "letter-spacing": "0.18em",
            transform: `rotate(-12 ${PLOT_W / 2} ${PLOT_H / 2})`,
            "pointer-events": "none",
        }, ["PLACEHOLDER"]));
    }

    container.appendChild(root);

    function setCursor(hours, yPerDot) {
        const h = Math.max(0, Math.min(dur_h, hours));
        const x = xScale(h);
        cursorLine.setAttribute("x1", x);
        cursorLine.setAttribute("x2", x);
        for (let i = 0; i < cursorDots.length; i++) {
            cursorDots[i].el.setAttribute("cx", x);
            cursorDots[i].el.setAttribute("cy", yPerDot[i]);
        }
    }

    return {
        root, traceLayer,
        t0Ms, anchorMs, hoursMin, hoursMax, dur_h, stepMin, n, plotW, plotH,
        xScale, idxAt,
        addCursorDot,
        setCursor,
        setHoverFormatter(fn) { formatHoverRows = fn; },
    };
}

// ── small helpers used by trace rendering ───────────────────────────

function _pathSmooth(arr, xScale, yScale, stepMin, hoursMin = 0) {
    // arr[i] is at window-relative offset i*stepMin/60, which equals
    // anchor-relative hoursMin + i*stepMin/60. xScale takes anchor-relative h.
    let d = "";
    for (let i = 0; i < arr.length; i++) {
        const x = xScale(hoursMin + i * stepMin / 60).toFixed(2);
        const y = yScale(arr[i]).toFixed(2);
        d += (i ? "L" : "M") + x + " " + y + " ";
    }
    return d;
}

function _pathStep(arr, xScale, yScale, stepMin, hoursMin = 0) {
    // step-after: constant from xs(i) to xs(i+1) at arr[i].
    let d = "";
    for (let i = 0; i < arr.length; i++) {
        const x = xScale(hoursMin + i * stepMin / 60).toFixed(2);
        const y = yScale(arr[i]).toFixed(2);
        if (i === 0) {
            d += `M${x} ${y} `;
        } else {
            const prevY = yScale(arr[i - 1]).toFixed(2);
            d += `L${x} ${prevY} L${x} ${y} `;
        }
    }
    return d;
}

function _yTickLadder(root, yMax, yScale, formatter, highlightAt = null, highlightLabel = null) {
    // Choose a tick step that yields ~5–8 ticks across the range.
    const targetTicks = 7;
    const raw = yMax / targetTicks;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const nice = [1, 2, 5, 10].find(m => m * pow >= raw) * pow;
    for (let v = 0; v <= yMax + 1e-9; v += nice) {
        const yPx = yScale(v);
        const isHi = highlightAt !== null && Math.abs(v - highlightAt) < nice / 2;
        root.appendChild(svg("line", {
            x1: MARGIN.left, x2: PLOT_W - MARGIN.right,
            y1: yPx, y2: yPx,
            stroke: isHi ? COLORS.ceiling : COLORS.grid,
            "stroke-dasharray": isHi ? "4 4" : null,
            "stroke-width": isHi ? 1.2 : 1,
            opacity: isHi ? 0.8 : 1,
        }));
        root.appendChild(svg("text", {
            x: MARGIN.left - 7, y: yPx + 3,
            "text-anchor": "end",
            fill: COLORS.text,
            "font-size": 10,
            "font-family": "ui-monospace, monospace",
        }, [formatter(v)]));
    }
    if (highlightAt !== null && highlightLabel) {
        root.appendChild(svg("text", {
            x: PLOT_W - MARGIN.right - 4, y: yScale(highlightAt) - 4,
            "text-anchor": "end",
            fill: COLORS.ceiling,
            "font-size": 10,
            "font-family": "ui-monospace, monospace",
            opacity: 0.9,
        }, [highlightLabel]));
    }
}

function _yAxisLabel(root, text, atPx) {
    root.appendChild(svg("text", {
        x: 14, y: MARGIN.top + atPx,
        fill: COLORS.textSubtle,
        "font-size": 10,
        "font-family": "ui-monospace, monospace",
        "letter-spacing": "0.08em",
        transform: `rotate(-90 14 ${MARGIN.top + atPx})`,
        "text-anchor": "middle",
    }, [text]));
}

// ── Chart 1: Ap saturation ─────────────────────────────────────────

export function createApSaturationChart(container, replay, _player, opts = {}) {
    const frame = _buildPlotFrame(container, replay, {
        ...opts,
        ariaLabel:
            "Ap index timeseries during the May 2024 Gannon superstorm: " +
            "official Ap pinned at the 400 ceiling, MHD- and ground-magnetometer-" +
            "derived surrogates climbing past it.",
    });
    const drivers = replay.drivers_compact;
    const { traceLayer, root, xScale, plotH, stepMin, hoursMin } = frame;

    const yMaxData = Math.max(
        ...drivers.ap_real, ...drivers.ap_mhd, ...drivers.ap_gnd
    );
    const yPlotMax = Math.ceil((yMaxData + 50) / 100) * 100;
    const yScale = v => MARGIN.top + (1 - v / yPlotMax) * plotH;

    _yTickLadder(root, yPlotMax, yScale, v => String(v), 400, "Ap = 400  (empirical ceiling)");
    _yAxisLabel(root, "Ap", plotH / 2);

    // Traces — order matters: real underneath, surrogates above.
    traceLayer.appendChild(svg("path", {
        d: _pathStep(drivers.ap_real, xScale, yScale, stepMin, hoursMin),
        stroke: COLORS.real, fill: "none", "stroke-width": 1.6, opacity: 0.85,
    }));
    traceLayer.appendChild(svg("path", {
        d: _pathSmooth(drivers.ap_mhd, xScale, yScale, stepMin, hoursMin),
        stroke: COLORS.mhd, fill: "none", "stroke-width": 2.4,
    }));
    traceLayer.appendChild(svg("path", {
        d: _pathSmooth(drivers.ap_gnd, xScale, yScale, stepMin, hoursMin),
        stroke: COLORS.gnd, fill: "none", "stroke-width": 2.4,
    }));

    const dotR = frame.addCursorDot(COLORS.real, { r: 3.6 });
    const dotM = frame.addCursorDot(COLORS.mhd);
    const dotG = frame.addCursorDot(COLORS.gnd);

    frame.setHoverFormatter((idx, hours) => [
        { text: `${_fmtClock(frame.anchorMs, hours)} UT` },
        { text: `Ap real  ${String(Math.round(drivers.ap_real[idx])).padStart(4)}`, color: COLORS.real },
        { text: `Ap* MHD  ${String(Math.round(drivers.ap_mhd[idx])).padStart(4)}`,  color: COLORS.mhd  },
        { text: `Ap* mag  ${String(Math.round(drivers.ap_gnd[idx])).padStart(4)}`,  color: COLORS.gnd  },
    ]);

    function setCursor(hours) {
        const idx = frame.idxAt(hours);
        frame.setCursor(hours, [
            yScale(drivers.ap_real[idx]),
            yScale(drivers.ap_mhd[idx]),
            yScale(drivers.ap_gnd[idx]),
        ]);
    }
    setCursor(0);
    return { setCursor };
}

// ── Chart 2: ρ @ 400 km ────────────────────────────────────────────

export function createDensityChart(container, replay, _player, opts = {}) {
    const frame = _buildPlotFrame(container, replay, {
        ...opts,
        ariaLabel:
            "Thermospheric mass density at 400 km altitude during the May 2024 " +
            "Gannon storm: three model traces (MSIS driven by real Ap, MHD-derived " +
            "pseudo-Ap, ground-magnetometer pseudo-Ap) overlaid with GRACE-FO and " +
            "Swarm-C accelerometer-derived truth scatter.",
    });

    const dens = replay.density_400km;
    const truth = replay.truth_400km || { grace_fo: [], swarm_c: [] };
    const { traceLayer, root, xScale, plotH, stepMin, hoursMin } = frame;

    // Y axis: ρ × 10¹² (so ticks read "10, 20, ..., 80" instead of e-notation).
    const SCALE = 1e12;
    const allRho = [
        ...dens.msis_apreal, ...dens.msis_apmhd, ...dens.msis_apgnd,
        ...(truth.grace_fo || []).map(p => p.rho),
        ...(truth.swarm_c || []).map(p => p.rho),
    ];
    const yMaxRho   = Math.max(...allRho);
    const yMaxData  = yMaxRho * SCALE;
    const yPlotMax  = Math.ceil((yMaxData + 5) / 10) * 10;
    const yScale = rho => MARGIN.top + (1 - (rho * SCALE) / yPlotMax) * plotH;

    _yTickLadder(root, yPlotMax,
        v => MARGIN.top + (1 - v / yPlotMax) * plotH,   // tick scale takes raw v
        v => String(Math.round(v)));
    _yAxisLabel(root, "ρ × 10¹²  (kg/m³)", plotH / 2);

    // Three model traces, smooth.
    traceLayer.appendChild(svg("path", {
        d: _pathSmooth(dens.msis_apreal, xScale, yScale, stepMin, hoursMin),
        stroke: COLORS.real, fill: "none", "stroke-width": 1.8, opacity: 0.9,
    }));
    traceLayer.appendChild(svg("path", {
        d: _pathSmooth(dens.msis_apmhd, xScale, yScale, stepMin, hoursMin),
        stroke: COLORS.mhd, fill: "none", "stroke-width": 2.4,
    }));
    traceLayer.appendChild(svg("path", {
        d: _pathSmooth(dens.msis_apgnd, xScale, yScale, stepMin, hoursMin),
        stroke: COLORS.gnd, fill: "none", "stroke-width": 2.4,
    }));

    // Truth scatter on top — GRACE-FO as filled circles, Swarm-C as crosses
    // so the two sources stay distinguishable in print and at small sizes.
    // Re-buildable so /api/density/tudelft can swap real observations in at
    // runtime — updateTruth(grace_fo, swarm_c) calls _drawTruth again.
    const truthLayer = svg("g", { class: "gn-truth" });
    traceLayer.appendChild(truthLayer);

    function _drawTruth(grace_fo, swarm_c) {
        while (truthLayer.firstChild) truthLayer.removeChild(truthLayer.firstChild);
        for (const p of grace_fo || []) {
            truthLayer.appendChild(svg("circle", {
                cx: xScale(p.h), cy: yScale(p.rho),
                r: 4,
                fill: COLORS.truth,
                stroke: "rgba(0,0,0,0.55)",
                "stroke-width": 1,
            }));
        }
        for (const p of swarm_c || []) {
            const cx = xScale(p.h);
            const cy = yScale(p.rho);
            const s  = 4.2;
            // Cross/X glyph rendered as a small group of two lines.
            truthLayer.appendChild(svg("line", {
                x1: cx - s, y1: cy - s, x2: cx + s, y2: cy + s,
                stroke: COLORS.truthAlt, "stroke-width": 1.6, "stroke-linecap": "round",
            }));
            truthLayer.appendChild(svg("line", {
                x1: cx - s, y1: cy + s, x2: cx + s, y2: cy - s,
                stroke: COLORS.truthAlt, "stroke-width": 1.6, "stroke-linecap": "round",
            }));
        }
    }
    _drawTruth(truth.grace_fo, truth.swarm_c);

    // Inline source legend for the truth markers — the page legend
    // already calls out the model colors, but the GRACE/Swarm shape
    // distinction needs an in-plot key.
    const legendX = MARGIN.left + 8;
    const legendY = MARGIN.top + 40;
    const lg = svg("g", { class: "gn-truth-key", "pointer-events": "none" });
    lg.appendChild(svg("circle", { cx: legendX, cy: legendY, r: 4,
        fill: COLORS.truth, stroke: "rgba(0,0,0,0.55)", "stroke-width": 1 }));
    lg.appendChild(svg("text", {
        x: legendX + 10, y: legendY + 3,
        fill: COLORS.text, "font-size": 10, "font-family": "ui-monospace, monospace",
    }, ["GRACE-FO  (≈ 490 km)"]));
    lg.appendChild(svg("line", {
        x1: legendX - 4, y1: legendY + 14 - 4, x2: legendX + 4, y2: legendY + 14 + 4,
        stroke: COLORS.truthAlt, "stroke-width": 1.6, "stroke-linecap": "round",
    }));
    lg.appendChild(svg("line", {
        x1: legendX - 4, y1: legendY + 14 + 4, x2: legendX + 4, y2: legendY + 14 - 4,
        stroke: COLORS.truthAlt, "stroke-width": 1.6, "stroke-linecap": "round",
    }));
    lg.appendChild(svg("text", {
        x: legendX + 10, y: legendY + 14 + 3,
        fill: COLORS.text, "font-size": 10, "font-family": "ui-monospace, monospace",
    }, ["Swarm-C  (≈ 450 km)"]));
    root.appendChild(lg);

    // Cursor dots — three, one per model trace.
    frame.addCursorDot(COLORS.real, { r: 3.6 });
    frame.addCursorDot(COLORS.mhd);
    frame.addCursorDot(COLORS.gnd);

    function fmtRho(rho) {
        // Print as "12.4" meaning 12.4 × 10⁻¹² kg/m³.
        return (rho * SCALE).toFixed(1).padStart(5);
    }

    frame.setHoverFormatter((idx, hours) => [
        { text: `${_fmtClock(frame.anchorMs, hours)} UT  (×10⁻¹² kg/m³)` },
        { text: `MSIS+Ap   ${fmtRho(dens.msis_apreal[idx])}`, color: COLORS.real },
        { text: `MSIS+MHD  ${fmtRho(dens.msis_apmhd[idx])}`,  color: COLORS.mhd  },
        { text: `MSIS+mag  ${fmtRho(dens.msis_apgnd[idx])}`,  color: COLORS.gnd  },
    ]);

    function setCursor(hours) {
        const idx = frame.idxAt(hours);
        frame.setCursor(hours, [
            yScale(dens.msis_apreal[idx]),
            yScale(dens.msis_apmhd[idx]),
            yScale(dens.msis_apgnd[idx]),
        ]);
    }
    // Swap truth scatter at runtime — used by the page bootstrap when
    // /api/density/tudelft returns real TU Delft observations.
    function updateTruth(grace_fo, swarm_c) {
        _drawTruth(grace_fo, swarm_c);
    }
    setCursor(0);
    return { setCursor, updateTruth };
}

// ── Chart 3: per-observation residuals ─────────────────────────────
//
// At each truth observation (GRACE-FO ∪ Swarm-C), compute three
// residuals (truth − model) — one per model track — and scatter them
// against time, with thin connecting lines so the eye can follow each
// model. The y-axis is symmetric around zero with a bold `model = truth`
// reference line. Saturated-Ap baseline residuals climb above zero
// during PEAK; surrogate residuals stay near zero. That divergence
// is the page's quantitative argument and what the prose claim
// "MHD-corrected density beats MSIS at storm peak" rests on.
//
// Note: we deliberately do NOT show interpolated cursor dots here —
// residuals only exist at the sparse truth times, so following the
// scrubber continuously with dots would imply between-observation
// knowledge we don't have. The cursor line still moves; the hover
// snaps to the nearest truth obs.

export function createResidualsChart(container, replay, _player, opts = {}) {
    const frame = _buildPlotFrame(container, replay, {
        ...opts,
        ariaLabel:
            "Per-observation residuals (truth minus model) for the three " +
            "model tracks at every GRACE-FO and Swarm-C accelerometer-derived " +
            "density observation in the 72-hour Gannon window. Y-axis " +
            "is symmetric around zero; positive residuals mean the model " +
            "underestimated.",
    });
    const dens  = replay.density_400km;
    const truth = replay.truth_400km || { grace_fo: [], swarm_c: [] };
    const { traceLayer, root, xScale, plotH, stepMin } = frame;

    // Combine truth into one time-sorted list, preserving the source
    // label for the tooltip.
    const obs = [
        ...(truth.grace_fo || []).map(p => ({ h: p.h, rho: p.rho, src: "GRACE-FO" })),
        ...(truth.swarm_c  || []).map(p => ({ h: p.h, rho: p.rho, src: "Swarm-C"  })),
    ].sort((a, b) => a.h - b.h);

    // Degenerate case: no truth yet (real-data day 1 before either feed
    // is populated). Render a stub and bail — the page should still
    // load and the cursor binding shouldn't throw.
    if (obs.length === 0) {
        traceLayer.appendChild(svg("text", {
            x: PLOT_W / 2, y: MARGIN.top + plotH / 2,
            "text-anchor": "middle",
            fill: COLORS.textSubtle,
            "font-size": 11,
            "font-family": "ui-monospace, monospace",
        }, ["No truth observations in this bundle — load GRACE-FO / Swarm-C density to populate."]));
        return { setCursor() { /* no-op */ } };
    }

    // Sample each model trace at each observation's time via linear
    // interp over the bundle's step_minutes cadence.
    function modelAt(arr, h) {
        const stepH = stepMin / 60;
        const f = h / stepH;
        const lo = Math.max(0, Math.min(arr.length - 1, Math.floor(f)));
        const hi = Math.max(0, Math.min(arr.length - 1, lo + 1));
        if (lo === hi) return arr[lo];
        const t = f - lo;
        return arr[lo] * (1 - t) + arr[hi] * t;
    }

    const residuals = obs.map(p => ({
        h:    p.h,
        src:  p.src,
        real: p.rho - modelAt(dens.msis_apreal, p.h),
        mhd:  p.rho - modelAt(dens.msis_apmhd,  p.h),
        gnd:  p.rho - modelAt(dens.msis_apgnd,  p.h),
    }));

    // Y axis: symmetric around zero, in display units of Δρ × 10¹².
    const SCALE = 1e12;
    const allRes = residuals.flatMap(r => [r.real, r.mhd, r.gnd]).map(x => x * SCALE);
    const yAbs   = Math.max(1, ...allRes.map(Math.abs));
    const yPlotMax = Math.ceil((yAbs + 5) / 10) * 10;
    const yScale = res =>
        MARGIN.top + (1 - (res * SCALE + yPlotMax) / (2 * yPlotMax)) * plotH;

    // Symmetric tick ladder with the zero line emphasised.
    {
        const targetTicks = 7;
        const raw = (2 * yPlotMax) / targetTicks;
        const pow = 10 ** Math.floor(Math.log10(raw));
        const nice = [1, 2, 5, 10].find(m => m * pow >= raw) * pow;
        for (let v = -yPlotMax; v <= yPlotMax + 1e-9; v += nice) {
            const isZero = Math.abs(v) < nice / 2;
            // yScale takes a *raw* residual, but our tick values are in
            // display units (×10¹²). Reconstruct pixel position directly.
            const yPx = MARGIN.top + (1 - (v + yPlotMax) / (2 * yPlotMax)) * plotH;
            root.appendChild(svg("line", {
                x1: MARGIN.left, x2: PLOT_W - MARGIN.right,
                y1: yPx, y2: yPx,
                stroke: isZero ? COLORS.ceiling : COLORS.grid,
                "stroke-dasharray": isZero ? "4 4" : null,
                "stroke-width": isZero ? 1.4 : 1,
                opacity: isZero ? 0.95 : 1,
            }));
            const label = isZero ? "0" : (v > 0 ? "+" + v : String(v));
            root.appendChild(svg("text", {
                x: MARGIN.left - 7, y: yPx + 3,
                "text-anchor": "end",
                fill: COLORS.text,
                "font-size": 10,
                "font-family": "ui-monospace, monospace",
            }, [label]));
        }
        // Reference-line label for the zero crossing.
        const zeroPx = MARGIN.top + (1 - yPlotMax / (2 * yPlotMax)) * plotH;
        root.appendChild(svg("text", {
            x: PLOT_W - MARGIN.right - 4, y: zeroPx - 4,
            "text-anchor": "end",
            fill: COLORS.ceiling,
            "font-size": 10,
            "font-family": "ui-monospace, monospace",
            opacity: 0.9,
        }, ["model = truth"]));
    }
    _yAxisLabel(root, "(truth − model) × 10¹²  (kg/m³)", plotH / 2);

    // Connecting lines, low opacity — they're a visual aid, not a
    // claim about between-observation behaviour.
    function lineThrough(values) {
        let d = "";
        for (let i = 0; i < residuals.length; i++) {
            const x = xScale(residuals[i].h).toFixed(2);
            const y = yScale(values[i]).toFixed(2);
            d += (i ? "L" : "M") + x + " " + y + " ";
        }
        return d;
    }
    traceLayer.appendChild(svg("path", {
        d: lineThrough(residuals.map(r => r.real)),
        stroke: COLORS.real, fill: "none", "stroke-width": 1.4, opacity: 0.35,
    }));
    traceLayer.appendChild(svg("path", {
        d: lineThrough(residuals.map(r => r.mhd)),
        stroke: COLORS.mhd, fill: "none", "stroke-width": 1.4, opacity: 0.35,
    }));
    traceLayer.appendChild(svg("path", {
        d: lineThrough(residuals.map(r => r.gnd)),
        stroke: COLORS.gnd, fill: "none", "stroke-width": 1.4, opacity: 0.35,
    }));

    // Dots — three per observation, slight X-offset so colocated points
    // don't overlap. Order left-to-right matches the legend.
    const DOT_DX = 2.5;
    for (const r of residuals) {
        const x = xScale(r.h);
        traceLayer.appendChild(svg("circle", {
            cx: x - DOT_DX, cy: yScale(r.real),
            r: 3.4, fill: COLORS.real,
            stroke: "rgba(0,0,0,0.55)", "stroke-width": 1,
        }));
        traceLayer.appendChild(svg("circle", {
            cx: x,           cy: yScale(r.mhd),
            r: 3.4, fill: COLORS.mhd,
            stroke: "rgba(0,0,0,0.55)", "stroke-width": 1,
        }));
        traceLayer.appendChild(svg("circle", {
            cx: x + DOT_DX,  cy: yScale(r.gnd),
            r: 3.4, fill: COLORS.gnd,
            stroke: "rgba(0,0,0,0.55)", "stroke-width": 1,
        }));
    }

    // Hover: snap to the truth observation nearest the cursor's hour
    // and report all three residuals + the source label.
    function nearestObs(hours) {
        let best = residuals[0], bestDist = Math.abs(residuals[0].h - hours);
        for (const r of residuals) {
            const d = Math.abs(r.h - hours);
            if (d < bestDist) { best = r; bestDist = d; }
        }
        return best;
    }
    function fmtRes(rho) {
        const v = rho * SCALE;
        const s = (v >= 0 ? "+" : "") + v.toFixed(1);
        return s.padStart(7);
    }
    frame.setHoverFormatter((_idx, hours) => {
        const r = nearestObs(hours);
        return [
            { text: `${_fmtClock(frame.anchorMs, r.h)} UT  (${r.src})` },
            { text: `Δρ real  ${fmtRes(r.real)}`, color: COLORS.real },
            { text: `Δρ MHD   ${fmtRes(r.mhd)}`,  color: COLORS.mhd  },
            { text: `Δρ mag   ${fmtRes(r.gnd)}`,  color: COLORS.gnd  },
        ];
    });

    // Cursor: line only — no per-observation dots, intentionally.
    function setCursor(hours) { frame.setCursor(hours, []); }
    setCursor(0);
    return { setCursor };
}
