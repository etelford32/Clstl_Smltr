/**
 * gannon-superstorm-atmosphere.js — "the atmosphere thickening" panel
 * ═══════════════════════════════════════════════════════════════════════
 * A density-vs-altitude cross-section for the Gannon replay that makes
 * the thermospheric puff-up — the thing that actually drags satellites
 * down — visible as a *shape*, not just a line on a time chart.
 *
 *   • Vertical axis: altitude, 120 → 700 km.
 *   • Horizontal axis: neutral mass density ρ (log₁₀, kg/m³).
 *   • The filled "wedge" is the current density profile from the same
 *     MSIS-class surrogate (upper-atmosphere-engine.js) that powers the
 *     ρ(400 km) chart, driven by the Ap* MHD track at the cursor.
 *   • A dashed ghost outline shows the quiet-day profile (Ap 15) — the
 *     gap between wedge and ghost IS the storm.
 *   • A gold iso-density line marks the altitude where the air is as
 *     dense as 400 km on a quiet day. Watch it climb ~100 km at peak:
 *     "the atmosphere reaches up and grabs the constellation."
 *   • A satellite pip rides the fixed 400 km reference; its drag streak
 *     scales with ρ(400 km) relative to quiet.
 *
 * Strip colours warm from cool cyan → amber with the local Bates
 * temperature, so the Joule-heating story reads at a glance.
 *
 * Inline SVG only (same primitives as the sibling modules) — no THREE,
 * no bundler.
 *
 * Exports:
 *   createAtmospherePanel(container, replay, player, opts) → { setCursor }
 *   computeProfile(ap, opts?)   — pure, node-testable
 *   isoAltitudeFor(profile, rhoTarget) — pure, node-testable
 */

import { density, GANNON_F107_SFU } from "./gannon-superstorm-engine.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// ── layout (viewBox) ───────────────────────────────────────────────
const PLOT_W = 800;
const PLOT_H = 300;
const MARGIN = { top: 30, right: 56, bottom: 40, left: 56 };

// ── physical ranges ────────────────────────────────────────────────
const ALT_MIN_KM  = 120;    // homopause — surrogate is diffusive above this
const ALT_MAX_KM  = 700;    // above GRACE-FO / Starlink territory
const N_STRIPS    = 58;     // 10 km strips
const AP_QUIET    = 15;     // engine's canonical quiet-time Ap
const SAT_ALT_KM  = 400;    // the page's reference drag altitude

// Temperature range for the heat colouring (K). Quiet T∞ ≈ 975 K at
// F10.7 = 165; the Gannon Ap*-MHD peak pushes past 2000 K.
const T_COOL_K = 700;
const T_HOT_K  = 2200;

const COLORS = {
    text:       "#bcd",
    textSubtle: "#789",
    grid:       "rgba(255,255,255,0.06)",
    axis:       "rgba(255,255,255,0.25)",
    stripCool:  "#3fa8d8",     // quiet thermosphere
    stripHot:   "#ff9a3d",     // Joule-heated
    outline:    "#7fd4ff",     // current-profile edge
    ghost:      "rgba(255,255,255,0.45)",
    iso:        "#ffd24d",     // quiet-400km iso-density line
    satBody:    "#cfd8ff",
    satPanel:   "#7fa8ff",
    drag:       "#ff6a3d",
};

// ── pure math (node-testable, no DOM) ──────────────────────────────

/**
 * Density profile on the panel's fixed altitude grid at a given Ap.
 * Returns [{ altKm, rho, logRho, T }] from ALT_MIN_KM up, ascending.
 */
export function computeProfile(ap, { f107Sfu = GANNON_F107_SFU, nStrips = N_STRIPS } = {}) {
    const out = [];
    for (let i = 0; i <= nStrips; i++) {
        const altKm = ALT_MIN_KM + (ALT_MAX_KM - ALT_MIN_KM) * (i / nStrips);
        const d = density({ altitudeKm: altKm, f107Sfu, ap });
        out.push({ altKm, rho: d.rho, logRho: Math.log10(d.rho), T: d.T });
    }
    return out;
}

/**
 * Altitude (km) at which the profile's density equals `rhoTarget`.
 * ρ decreases monotonically with altitude, so this walks up the grid
 * and interpolates the crossing in log space. Clamps to the grid ends
 * (the caller can compare against ALT_MAX_KM to detect saturation).
 */
export function isoAltitudeFor(profile, rhoTarget) {
    const logT = Math.log10(rhoTarget);
    if (profile[0].logRho <= logT) return profile[0].altKm;
    for (let i = 1; i < profile.length; i++) {
        const a = profile[i - 1], b = profile[i];
        if (b.logRho <= logT) {
            const t = (a.logRho - logT) / (a.logRho - b.logRho);
            return a.altKm + t * (b.altKm - a.altKm);
        }
    }
    return profile[profile.length - 1].altKm;
}

export { ALT_MIN_KM, ALT_MAX_KM, AP_QUIET, SAT_ALT_KM };

// ── small helpers (mirrors the sibling modules) ────────────────────

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

function lerpColor(a, b, t) {
    const pa = _rgb(a), pb = _rgb(b);
    const r  = Math.round(pa.r + (pb.r - pa.r) * t);
    const g  = Math.round(pa.g + (pb.g - pa.g) * t);
    const bl = Math.round(pa.b + (pb.b - pa.b) * t);
    return `rgb(${r},${g},${bl})`;
}
function _rgb(hex) {
    const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    if (!m) return { r: 150, g: 180, b: 220 };
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

// "1e-12" → "10⁻¹²" for axis labels.
const _SUP = { "-": "⁻", 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };
function pow10Label(exp) {
    return "10" + String(exp).split("").map(ch => _SUP[ch] ?? ch).join("");
}

// ── panel factory ──────────────────────────────────────────────────

export function createAtmospherePanel(container, replay, player, opts = {}) {
    container.innerHTML = "";
    container.classList.remove("gn-pulse");

    // Quiet-day reference profile — computed once; everything storm-time
    // is measured against it.
    const quiet = computeProfile(AP_QUIET);
    const rhoQuiet400 = density({
        altitudeKm: SAT_ALT_KM, f107Sfu: GANNON_F107_SFU, ap: AP_QUIET,
    }).rho;

    // Horizontal (log-density) range is fixed from the quiet profile so
    // the wedge's storm-time swell reads against a stable axis. Small
    // headroom on the right absorbs the low-altitude strips creeping up.
    const logMin = quiet[quiet.length - 1].logRho - 0.3;   // ~ρ_quiet(700 km)
    const logMax = quiet[0].logRho + 0.4;                  // ~ρ_quiet(120 km)

    const plotL = MARGIN.left, plotR = PLOT_W - MARGIN.right;
    const plotT = MARGIN.top,  plotB = PLOT_H - MARGIN.bottom;

    function altToY(altKm) {
        const f = (altKm - ALT_MIN_KM) / (ALT_MAX_KM - ALT_MIN_KM);
        return plotB - f * (plotB - plotT);
    }
    function logRhoToX(lr) {
        const f = Math.max(0, Math.min(1, (lr - logMin) / (logMax - logMin)));
        return plotL + f * (plotR - plotL);
    }

    const root = svg("svg", {
        viewBox: `0 0 ${PLOT_W} ${PLOT_H}`,
        preserveAspectRatio: "none",
        width:  "100%",
        height: "100%",
        role:   "img",
        "aria-label":
            "Atmosphere-thickening cross-section. Altitude on the vertical axis, neutral density " +
            "on the horizontal (log) axis. The filled profile swells to the right as storm heating " +
            "expands the thermosphere; a dashed outline marks the quiet-day profile, and a gold line " +
            "marks the rising altitude at which the air is as dense as 400 km on a quiet day.",
        style:  "display:block; background: rgba(8,4,20,0.55); border-radius: 6px;",
    });

    // ── grid + axes ────────────────────────────────────────────────
    for (let alt = 200; alt < ALT_MAX_KM; alt += 100) {
        const y = altToY(alt);
        root.appendChild(svg("line", {
            x1: plotL, x2: plotR, y1: y, y2: y,
            stroke: COLORS.grid, "stroke-width": 1,
        }));
        root.appendChild(svg("text", {
            x: plotL - 6, y: y + 3, "text-anchor": "end",
            fill: COLORS.textSubtle, "font-size": 9,
            "font-family": "ui-monospace, monospace",
        }, [String(alt)]));
    }
    root.appendChild(svg("text", {
        x: plotL - 40, y: (plotT + plotB) / 2,
        transform: `rotate(-90 ${plotL - 40} ${(plotT + plotB) / 2})`,
        "text-anchor": "middle", fill: COLORS.textSubtle, "font-size": 9,
        "font-family": "ui-monospace, monospace", "letter-spacing": "0.08em",
    }, ["ALTITUDE  km"]));

    for (let exp = Math.ceil(logMin); exp <= Math.floor(logMax); exp++) {
        const x = logRhoToX(exp);
        root.appendChild(svg("line", {
            x1: x, x2: x, y1: plotB, y2: plotB + 4,
            stroke: COLORS.axis, "stroke-width": 0.8,
        }));
        root.appendChild(svg("text", {
            x, y: plotB + 15, "text-anchor": "middle",
            fill: COLORS.textSubtle, "font-size": 9,
            "font-family": "ui-monospace, monospace",
        }, [pow10Label(exp)]));
    }
    root.appendChild(svg("line", {
        x1: plotL, x2: plotR, y1: plotB, y2: plotB, stroke: COLORS.axis,
    }));
    root.appendChild(svg("line", {
        x1: plotL, x2: plotL, y1: plotT, y2: plotB, stroke: COLORS.axis,
    }));
    root.appendChild(svg("text", {
        x: (plotL + plotR) / 2, y: plotB + 29, "text-anchor": "middle",
        fill: COLORS.textSubtle, "font-size": 9,
        "font-family": "ui-monospace, monospace", "letter-spacing": "0.06em",
    }, ["NEUTRAL DENSITY  ρ  kg/m³  (log)"]));

    // ── density wedge: one strip per 10 km, resized every cursor ───
    const stripLayer = svg("g", { "pointer-events": "none" });
    root.appendChild(stripLayer);
    const strips = [];
    for (let i = 0; i < N_STRIPS; i++) {
        const altTop = ALT_MIN_KM + (ALT_MAX_KM - ALT_MIN_KM) * ((i + 1) / N_STRIPS);
        const yTop = altToY(altTop);
        const h = altToY(ALT_MIN_KM + (ALT_MAX_KM - ALT_MIN_KM) * (i / N_STRIPS)) - yTop;
        const rect = svg("rect", {
            x: plotL, y: yTop, width: 0, height: h + 0.5,
            fill: COLORS.stripCool, "fill-opacity": 0.3,
        });
        stripLayer.appendChild(rect);
        strips.push(rect);
    }

    // Quiet-day ghost outline — the "before" the wedge is measured against.
    const ghostD = quiet
        .map((p, i) => `${i === 0 ? "M" : "L"} ${logRhoToX(p.logRho).toFixed(1)} ${altToY(p.altKm).toFixed(1)}`)
        .join(" ");
    root.appendChild(svg("path", {
        d: ghostD, fill: "none", stroke: COLORS.ghost, "stroke-width": 1.2,
        "stroke-dasharray": "4 4", "pointer-events": "none",
    }));
    root.appendChild(svg("text", {
        x: logRhoToX(quiet[quiet.length - 6].logRho) + 8,
        y: altToY(quiet[quiet.length - 6].altKm),
        fill: COLORS.ghost, "font-size": 9,
        "font-family": "ui-monospace, monospace", "pointer-events": "none",
    }, [`quiet day (Ap ${AP_QUIET})`]));

    // Current-profile edge (bright), redrawn every cursor.
    const outline = svg("path", {
        d: "", fill: "none", stroke: COLORS.outline, "stroke-width": 1.6,
        opacity: 0.85, "pointer-events": "none",
    });
    root.appendChild(outline);

    // ── quiet-400km iso-density line (THE thickening indicator) ────
    // Fixed baseline tick at 400 km for the eye to measure the climb.
    root.appendChild(svg("line", {
        x1: plotL, x2: plotR, y1: altToY(SAT_ALT_KM), y2: altToY(SAT_ALT_KM),
        stroke: "rgba(255,255,255,0.14)", "stroke-dasharray": "1 5",
        "pointer-events": "none",
    }));
    const isoLine = svg("line", {
        x1: plotL, x2: plotR, y1: altToY(SAT_ALT_KM), y2: altToY(SAT_ALT_KM),
        stroke: COLORS.iso, "stroke-width": 1.4, "stroke-dasharray": "7 4",
        opacity: 0.9, "pointer-events": "none",
    });
    const isoLabel = svg("text", {
        x: plotR - 4, y: altToY(SAT_ALT_KM) - 5, "text-anchor": "end",
        fill: COLORS.iso, "font-size": 10, "font-weight": 700,
        "font-family": "ui-monospace, monospace", "pointer-events": "none",
    }, [""]);
    root.appendChild(isoLine);
    root.appendChild(isoLabel);

    // ── satellite at the fixed 400 km reference ────────────────────
    const satX = plotL + (plotR - plotL) * 0.62;
    const satY = altToY(SAT_ALT_KM);
    const satG = svg("g", { "pointer-events": "none" });
    // Drag streaks trail behind (to the left), sized in setCursor.
    const dragStreaks = [-3, 0, 3].map(dy => {
        const s = svg("line", {
            x1: satX - 10, x2: satX - 10, y1: satY + dy, y2: satY + dy,
            stroke: COLORS.drag, "stroke-width": 1.3, "stroke-linecap": "round",
            opacity: 0,
        });
        satG.appendChild(s);
        return s;
    });
    const satHeat = svg("circle", {
        cx: satX, cy: satY, r: 9, fill: COLORS.drag, opacity: 0,
    });
    satG.appendChild(satHeat);
    // Body + solar panels.
    satG.appendChild(svg("line", {
        x1: satX - 12, x2: satX + 12, y1: satY, y2: satY,
        stroke: COLORS.satPanel, "stroke-width": 3,
    }));
    satG.appendChild(svg("rect", {
        x: satX - 4, y: satY - 4, width: 8, height: 8, rx: 1.5,
        fill: COLORS.satBody, stroke: "rgba(0,0,0,0.5)", "stroke-width": 0.7,
    }));
    // Label sits BELOW the glyph — the iso-density label owns the space
    // above the 400 km line whenever the storm is quiet.
    const satLabel = svg("text", {
        x: satX + 18, y: satY + 16, fill: COLORS.text, "font-size": 9,
        "font-family": "ui-monospace, monospace",
    }, [`${SAT_ALT_KM} km · GRACE-FO band`]);
    satG.appendChild(satLabel);
    root.appendChild(satG);

    // ── title + live readouts ──────────────────────────────────────
    root.appendChild(svg("text", {
        x: MARGIN.left, y: MARGIN.top - 12,
        fill: COLORS.text, "font-size": 11,
        "font-family": "ui-monospace, monospace", "letter-spacing": "0.08em",
    }, ["ATMOSPHERE THICKENING  ·  ρ(z) from the MSIS-class surrogate · Ap* MHD track"]));

    const roTinf = svg("text", {
        x: plotR, y: MARGIN.top + 8, "text-anchor": "end",
        fill: COLORS.textSubtle, "font-size": 10,
        "font-family": "ui-monospace, monospace",
    }, [""]);
    const roAp = svg("text", {
        x: plotR, y: MARGIN.top + 22, "text-anchor": "end",
        fill: COLORS.textSubtle, "font-size": 10,
        "font-family": "ui-monospace, monospace",
    }, [""]);
    const roRatio = svg("text", {
        x: plotR, y: MARGIN.top + 36, "text-anchor": "end",
        fill: COLORS.textSubtle, "font-size": 10, "font-weight": 700,
        "font-family": "ui-monospace, monospace",
    }, [""]);
    root.appendChild(roTinf);
    root.appendChild(roAp);
    root.appendChild(roRatio);

    if (opts.placeholder) {
        root.appendChild(svg("text", {
            x: PLOT_W / 2, y: PLOT_H / 2 + 4, "text-anchor": "middle",
            fill: "rgba(255,200,80,0.12)", "font-size": 56, "font-weight": 800,
            "font-family": "ui-monospace, monospace", "letter-spacing": "0.18em",
            transform: `rotate(-12 ${PLOT_W / 2} ${PLOT_H / 2})`,
            "pointer-events": "none",
        }, ["PLACEHOLDER"]));
    }

    container.appendChild(root);

    // ── setCursor: recompute the profile at this cursor's Ap ───────
    function setCursor(cursorH) {
        // Pure array-index read — the page's scrub handler already moved
        // the player cursor, this just samples it (same pattern as the
        // Sun-Earth scene).
        const samp = (player && player.seekHours) ? player.seekHours(cursorH) : null;
        const drv = samp?.drivers || {};
        // Headline track is Ap* MHD (the page's whole thesis); fall back
        // to real Ap, then quiet, so the panel never renders empty.
        const ap = Number.isFinite(drv.ap_mhd) ? drv.ap_mhd
                 : Number.isFinite(drv.ap_real) ? drv.ap_real
                 : AP_QUIET;

        const prof = computeProfile(ap);

        // Wedge strips: width = density, colour = local temperature.
        const pts = [];
        for (let i = 0; i < N_STRIPS; i++) {
            // Sample at the strip's top edge (profiles are monotone enough
            // at 10 km resolution that edge-sampling is faithful).
            const p = prof[i + 1];
            const x = logRhoToX(p.logRho);
            const frac = (p.logRho - logMin) / (logMax - logMin);
            const heat = Math.max(0, Math.min(1, (p.T - T_COOL_K) / (T_HOT_K - T_COOL_K)));
            strips[i].setAttribute("width", Math.max(0, x - plotL));
            strips[i].setAttribute("fill", lerpColor(COLORS.stripCool, COLORS.stripHot, heat));
            strips[i].setAttribute("fill-opacity", 0.14 + 0.42 * Math.max(0, Math.min(1, frac)));
        }
        for (const p of prof) {
            pts.push(`${logRhoToX(p.logRho).toFixed(1)} ${altToY(p.altKm).toFixed(1)}`);
        }
        outline.setAttribute("d", "M " + pts.join(" L "));

        // Iso-density line: where is quiet-day-400km air NOW?
        const isoAlt = isoAltitudeFor(prof, rhoQuiet400);
        const yIso = altToY(isoAlt);
        isoLine.setAttribute("y1", yIso);
        isoLine.setAttribute("y2", yIso);
        // Flip the label under the line when it climbs into the top-right
        // readout stack, so the two never collide at storm peak.
        isoLabel.setAttribute("y", yIso < plotT + 50 ? yIso + 14 : yIso - 5);
        const lifted = isoAlt - SAT_ALT_KM;
        isoLabel.textContent = lifted > 2
            ? `quiet-day 400 km air now at ${Math.round(isoAlt)} km  (+${Math.round(lifted)})`
            : `quiet-day 400 km air · ${Math.round(isoAlt)} km`;

        // Satellite drag: streaks + heat glow ∝ ρ(400)/ρ_quiet(400).
        const rho400 = density({ altitudeKm: SAT_ALT_KM, f107Sfu: GANNON_F107_SFU, ap }).rho;
        const ratio = rho400 / rhoQuiet400;
        const dragN = Math.max(0, Math.min(1, (ratio - 1) / 7));   // ×8 ≈ full scale
        for (const s of dragStreaks) {
            s.setAttribute("x1", satX - 14 - 30 * dragN);
            s.setAttribute("opacity", 0.15 + 0.75 * dragN);
        }
        satHeat.setAttribute("opacity", 0.25 * dragN);
        satHeat.setAttribute("r", 8 + 5 * dragN);

        // Readouts.
        const Tinf = prof[prof.length - 1].T;   // top of grid ≈ exosphere asymptote
        const heatN = Math.max(0, Math.min(1, (Tinf - T_COOL_K) / (T_HOT_K - T_COOL_K)));
        roTinf.textContent = `T∞ ${Math.round(Tinf)} K`;
        roTinf.setAttribute("fill", lerpColor("#789aab", COLORS.stripHot, heatN));
        roAp.textContent = `Ap* MHD ${Math.round(ap)}`;
        roRatio.textContent = `ρ(400 km) ×${ratio.toFixed(1)} vs quiet`;
        roRatio.setAttribute("fill", ratio >= 2 ? COLORS.iso : COLORS.textSubtle);
    }

    setCursor(0);
    return { setCursor };
}
