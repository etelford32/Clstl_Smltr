/**
 * gannon-superstorm-sun-earth.js — Sun → L1 → Earth 3D-ish side view
 * ═══════════════════════════════════════════════════════════════════════
 * The case-study panel that makes "storm moves from sun into Earth's
 * upper atmosphere" visible at a glance. Renders an SVG side-on
 * schematic with:
 *
 *   • Sun on the left (with active region pip for AR 13664)
 *   • Earth on the right (with magnetosphere bowshock)
 *   • L1 marker at ~0.99 AU
 *   • Distance axis along the bottom (0 → 1 AU)
 *   • Each Gannon CME drawn at its current position, computed from
 *     the drag-based-model trajectory in js/cme-propagation.js
 *     (dbmAnalytical) — real physics, not arbitrary timing
 *   • Ambient Parker-spiral solar wind shown as subtle radial streaks
 *
 * As the scrubber moves through h ∈ [-60, +72], CMEs that haven't
 * launched yet stay tucked on the sun's surface. Once launched (h
 * crosses their `launch_h`), they appear and traverse the AU gap at
 * the speed dbmAnalytical reports — slowing as they accumulate drag.
 * When the cursor crosses each CME's arrival time, the CME impacts
 * Earth's magnetosphere (visible compression). Recovery shows the
 * post-storm relaxation.
 *
 * Uses inline SVG (same primitives as the existing charts), not
 * THREE.js — keeps the page bundle dependency-free and the visual
 * consistent with the rest of gannon-superstorm.html.
 *
 * Exports:
 *   createSunEarthScene(container, replay, player, opts) → { setCursor }
 */

import { dbmAnalytical } from "./cme-propagation.js?v=1";

const SVG_NS = "http://www.w3.org/2000/svg";

// ── layout (viewBox) ───────────────────────────────────────────────
const PLOT_W = 800;
const PLOT_H = 280;
// Plot area inset matches the charts (7%/2% via the same MARGIN.left/right)
// so the panel's distance axis aligns vertically with the time axes below.
const MARGIN = { top: 28, right: 56, bottom: 44, left: 56 };

const SUN_X      = MARGIN.left + 8;                  // sun centre x
const SUN_R      = 34;                                // sun radius (visual)
const EARTH_X    = PLOT_W - MARGIN.right - 14;       // earth centre x
const EARTH_R    = 9;                                 // earth radius (visual)
const TRACK_Y    = MARGIN.top + 110;                  // CME travel line y

// ── physical → screen mapping ──────────────────────────────────────
// CME r_AU ∈ [0, 1+ε] maps linearly to x ∈ [sunEdgeX, earthEdgeX].
const SUN_EDGE_X   = SUN_X + SUN_R;
const EARTH_EDGE_X = EARTH_X - EARTH_R;
function rAUtoX(r_AU) {
    const r = Math.max(0, Math.min(1.08, r_AU));
    return SUN_EDGE_X + (r / 1.0) * (EARTH_EDGE_X - SUN_EDGE_X);
}

// ── colour scheme ──────────────────────────────────────────────────
const COLORS = {
    bg:          "rgba(8,4,20,0.05)",
    sun:         "#ffb347",
    sunGlow:     "rgba(255,200,80,0.35)",
    sunSpot:     "#7a3a14",       // AR 13664 pip
    earth:       "#3e6ab0",
    earthAtmos:  "rgba(120,180,255,0.30)",
    earthCompr:  "rgba(255,140,80,0.45)",   // bowshock glow when CMEs near
    L1:          "rgba(255,255,255,0.22)",
    track:       "rgba(255,255,255,0.06)",
    parker:      "rgba(255,200,140,0.10)",
    text:        "#bcd",
    textSubtle:  "#789",
    cme:         "#f96",         // base CME colour, modulated by X-class
    cmeHi:       "#f44",         // highest X-class
    cmeQuiet:    "rgba(255,160,80,0.15)",   // not-yet-launched pip on sun

    // Bz "river" — northward (quiet) → southward (geoeffective).
    riverNorth:  "#6ca6e0",
    riverSouth:  "#ff2e1e",
    // Detailed magnetosphere boundaries.
    magnetopause:"rgba(130,205,255,0.65)",  // inner boundary (paraboloid)
    cusp:        "rgba(160,215,255,0.55)",  // polar cusps (open field)
    tail:        "rgba(150,180,225,0.45)",  // magnetotail lobes
    aurora:      "#39d98a",                  // auroral oval (Joule heating)
    auroraHi:    "#c86bff",
    shock:       "rgba(255,130,90,0.95)",    // compression front on impact
    // Differentiated atmosphere shells (schematic, not to scale).
    atmExo:      "rgba(120,160,255,0.55)",   // exosphere
    atmThermo:   "rgba(120,210,255,0.75)",   // thermosphere
    atmDrag:     "#ffd24d",                  // ~400 km satellite-drag band
};

// X-class flare-magnitude → visual scale + colour intensity.
function flareIntensity(flareClass) {
    // e.g. "X1.0" → 1.0; "X5.8" → 5.8; "M3" → 0.3 (downscaled).
    const m = (flareClass || "").match(/^([XMC])(\d+(?:\.\d+)?)/i);
    if (!m) return 1;
    const tier = m[1].toUpperCase();
    const mag = Number(m[2]);
    if (tier === "X") return mag;
    if (tier === "M") return mag * 0.1;
    return mag * 0.01;
}

function cmeRadius(flareClass) {
    const x = flareIntensity(flareClass);
    return 5 + Math.min(10, x * 1.6);
}

function cmeColor(flareClass) {
    const x = flareIntensity(flareClass);
    // Lerp warm-orange → red as X-class climbs.
    const t = Math.min(1, x / 6);
    return lerpColor(COLORS.cme, COLORS.cmeHi, t);
}

function lerpColor(a, b, t) {
    const pa = hexToRgb(a), pb = hexToRgb(b);
    const r = Math.round(pa.r + (pb.r - pa.r) * t);
    const g = Math.round(pa.g + (pb.g - pa.g) * t);
    const bl = Math.round(pa.b + (pb.b - pa.b) * t);
    return `rgb(${r},${g},${bl})`;
}
function hexToRgb(hex) {
    const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    if (!m) return { r: 200, g: 150, b: 100 };
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

// ── physics-driven visual helpers ───────────────────────────────────

// IMF Bz polarity → colour. Northward (Bz ≥ 0) reads cool/quiet;
// southward (Bz < 0) ramps warm → hot-red, because southward IMF is the
// reconnection switch that lets solar-wind energy into the magnetosphere
// — the single most geoeffective driver of the storm.
function bzColor(bz) {
    if (bz >= 0) return lerpColor("#5a7a9a", COLORS.riverNorth, Math.min(1, bz / 15));
    return lerpColor("#f0a85a", COLORS.riverSouth, Math.min(1, -bz / 30));
}

// Auroral / Joule-heating intensity 0..1 from hemispheric power (GW),
// normalised against the storm's own peak so it reads on any bundle.
function auroraAlpha(hpi, hpiMax) {
    if (!hpi || hpi <= 0) return 0;
    return Math.max(0, Math.min(1, hpi / Math.max(40, hpiMax || 0)));
}

// Magnetopause (inner boundary). Sun is to the LEFT (−x), so the
// sub-solar nose points sunward (−x) and the tail streams anti-sunward
// (+x). `compress` ∈ [~0.42, 1]: smaller = more squeezed sunward.
function magnetopausePath(cx, cy, R, compress) {
    const nose  = R * 3.4 * compress;   // sunward standoff
    const flank = R * 3.8;
    const tail  = R * 6.0;              // anti-sunward
    return `M ${cx + tail} ${cy - flank}
            Q ${cx - nose} ${cy - flank}, ${cx - nose} ${cy}
            Q ${cx - nose} ${cy + flank}, ${cx + tail} ${cy + flank}`;
}

// Magnetotail lobes — two near-parallel field boundaries streaming
// anti-sunward (+x). They lengthen with `load` (southward-Bz energy
// loading) to suggest stretching toward substorm onset.
function magnetotailPath(cx, cy, R, compress, load) {
    const flank = R * 3.8;
    const x0 = cx - R * 1.2;
    const len = R * (6.5 + 4.0 * load);
    const flare = flank * (0.7 + 0.25 * load);
    return `M ${x0} ${cy - flank} L ${cx + len} ${cy - flare}
            M ${x0} ${cy + flank} L ${cx + len} ${cy + flare}`;
}

// Polar cusp — short open-field funnel where the boundary dimples in at
// the pole. `side` = -1 (north) / +1 (south).
function cuspPath(cx, cy, R, compress, side) {
    const nose = R * 3.4 * compress;
    const fy   = cy + side * R * 2.6;
    return `M ${cx - nose * 0.55} ${fy}
            L ${cx - R * 0.4} ${cy + side * R * 0.9}`;
}

// Magnetopause standoff scale from real solar-wind dynamic pressure
// (Shue-like: R_mp ∝ Pdyn^(−1/6)). Returns a compression factor in
// [~0.42, 1] relative to a ~2 nPa nominal — smaller = boundary pushed
// sunward. Used when the OMNI lift has supplied real Pdyn.
function comprFromPdyn(pdyn) {
    if (!pdyn || pdyn <= 0) return 1;
    return Math.max(0.42, Math.min(1, Math.pow(2.0 / pdyn, 1 / 6)));
}

// Auroral intensity 0..1 from the real AE (auroral-electrojet) index in
// nT — a direct measure of auroral-zone current. ~2000 nT is an
// extreme-storm reference (Gannon ran well above this).
function auroraFromAE(ae) {
    if (!ae || ae <= 0) return 0;
    return Math.max(0, Math.min(1, ae / 2000));
}

// Sunward-facing compression arc that sweeps into the magnetosphere as a
// CME crosses Earth. Opens toward the incoming wind (the −x / left side).
function shockArcPath(cx, cy, r) {
    const a0 = Math.PI * 0.70, a1 = Math.PI * 1.30;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`;
}

// ── tiny SVG helper (same as charts module) ────────────────────────

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

function _fmtClock(anchorMs, h) {
    const d = new Date(anchorMs + h * 3600_000);
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mn = String(d.getUTCMinutes()).padStart(2, "0");
    return `${mm}-${dd}  ${hh}:${mn}`;
}

// ── CME state from cme_events + cursor ─────────────────────────────

// Gannon-tuned DBM parameters
// ----------------------------------------------------------------
// The default γ in cme-propagation.js (1e-7 km⁻¹) gives ~70h transit
// for an X2.2 at 1900 km/s, but the real Gannon shock made the trip
// in ~24h. The compound-CME "train" cleared the interplanetary
// medium for the followers — every CME after the first sees a
// pre-accelerated background and much lower drag. Tuning γ down by
// ~25× recovers the observed transit times: cme3 arrives near
// h=5 (matching the 17:05 UT SSC at h=5.08), cme4 arrives near
// h=14 (Joule-heating peak), cme5 arrives in the recovery phase.
// Background w is also elevated from the 400 km/s nominal because
// the May 8-9 CMEs had already accelerated the ambient flow.
const GANNON_GAMMA = 4.0e-9;    // km⁻¹
const GANNON_W_SW  = 500;       // km/s

/**
 * For a single CME event, return its current state at anchor-relative
 * hours `cursorH`. `state` describes which segment of its lifecycle:
 *   - 'queued'   : flare hasn't fired yet (cursor < launch_h)
 *   - 'in_transit': moving from Sun to Earth
 *   - 'arrived'  : at Earth (r_AU ≈ 1, within ±2.5% AU)
 *   - 'past'     : moved beyond Earth (r_AU > 1.05) — fades out
 */
export function cmeStateAt(event, cursorH) {
    const elapsed_h = cursorH - event.launch_h;
    if (elapsed_h < 0) {
        return { state: "queued", r_AU: 0, v_kms: event.v0_kms, elapsed_h };
    }
    // Per-event drag override (defaults to GANNON_GAMMA / GANNON_W_SW).
    // Future bundles can carry event.gamma_km_inv and event.w_sw_kms
    // when real DBM-inversion results from BATS-R-US land.
    const gamma = event.gamma_km_inv ?? GANNON_GAMMA;
    const w     = event.w_sw_kms     ?? GANNON_W_SW;
    const { r_km, v_kms } = dbmAnalytical(elapsed_h * 3600, event.v0_kms, undefined, w, gamma);
    const r_AU = r_km / 1.495_979e8;
    let state;
    if (r_AU > 1.05) state = "past";
    else if (Math.abs(r_AU - 1.0) < 0.025) state = "arrived";
    else state = "in_transit";
    return { state, r_AU, v_kms, elapsed_h };
}

// Pre-compute each CME's launch_h relative to the anchor.
function _annotateCmes(replay) {
    const anchorMs = Date.parse(replay.window.anchor_iso || replay.window.start);
    const evts = (replay.cme_events || []).map(c => ({
        ...c,
        launch_h: (Date.parse(c.launch_iso) - anchorMs) / 3600_000,
    }));
    return { anchorMs, events: evts };
}

// ── scene factory ──────────────────────────────────────────────────

export function createSunEarthScene(container, replay, player, opts = {}) {
    const { anchorMs, events } = _annotateCmes(replay);

    // Normalisation ranges for the data-driven visuals (computed once
    // from the bundle so amplitudes read on placeholder OR real data).
    const _drv  = replay.drivers_compact || {};
    const _dens = replay.density_400km || {};
    const _max  = arr => (Array.isArray(arr) && arr.length)
        ? arr.reduce((m, v) => Math.max(m, v || 0), 0) : 0;
    const _min  = arr => (Array.isArray(arr) && arr.length)
        ? arr.reduce((m, v) => Math.min(m, v ?? Infinity), Infinity) : 0;
    const hpiMax   = _max(_drv.hpi_gw) || 100;
    const densArr  = _dens.msis_apreal || [];
    const densMax  = _max(densArr) || 1;
    const densMin  = densArr.length ? _min(densArr) : 0;
    const reduceMotion = !!(typeof window !== "undefined" && window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches);

    container.innerHTML = "";
    container.classList.remove("gn-pulse");

    const root = svg("svg", {
        viewBox: `0 0 ${PLOT_W} ${PLOT_H}`,
        preserveAspectRatio: "none",
        width:  "100%",
        height: "100%",
        role:   "img",
        "aria-label":
            "Sun-to-Earth schematic. The Sun is at left, Earth at right; CMEs traverse the gap " +
            "at speeds set by their actual launch velocity, with drag from the ambient solar wind. " +
            "Each Gannon-event CME appears at its UT launch moment and arrives at Earth at the " +
            "real DBM-model transit time.",
        style:  "display:block; background: rgba(8,4,20,0.55); border-radius: 6px;",
    });

    // ── Bz "river": the IMF / solar-wind flow from Sun toward L1 ────
    // Replaces the old static Parker streaks. Each lane is a dashed flow
    // line whose COLOUR encodes IMF Bz polarity (cool = northward/quiet,
    // hot-red = southward/geoeffective) and whose dash motion tracks the
    // solar-wind speed. Recoloured + advanced every setCursor().
    const riverLanes = [];
    const RIVER_N = 11;
    const _span = PLOT_H - MARGIN.top - MARGIN.bottom;
    for (let i = 0; i < RIVER_N; i++) {
        const yOff = (i / (RIVER_N - 1)) * _span - _span / 2;
        const yStart = TRACK_Y + yOff;
        // Quadratic curve fanning out from the sun (Parker-spiral hint).
        const cx = SUN_EDGE_X + 240;
        const cy = TRACK_Y + yOff * 0.4;
        // Central lanes carry the ecliptic flow; outer lanes fade — gives
        // the band a soft cross-section.
        const central = 1 - Math.min(1, Math.abs(yOff) / 110);
        const lane = svg("path", {
            d: `M ${SUN_EDGE_X} ${TRACK_Y} Q ${cx} ${cy} ${rAUtoX(0.99)} ${yStart}`,
            stroke: COLORS.parker, fill: "none",
            "stroke-width": 0.7 + central * 0.8,
            "stroke-dasharray": "6 11",
            "stroke-linecap": "round",
            "pointer-events": "none",
        });
        lane._central = central;
        root.appendChild(lane);
        riverLanes.push(lane);
    }

    // Distance axis at the bottom.
    const tickAUs = [0, 0.25, 0.5, 0.75, 0.99, 1.0];
    for (const au of tickAUs) {
        const x = rAUtoX(au);
        root.appendChild(svg("line", {
            x1: x, x2: x, y1: PLOT_H - MARGIN.bottom + 3, y2: PLOT_H - MARGIN.bottom + 8,
            stroke: COLORS.textSubtle, "stroke-width": 0.8,
        }));
        const label = au === 0.99 ? "L1" : `${au.toFixed(2)} AU`;
        root.appendChild(svg("text", {
            x, y: PLOT_H - MARGIN.bottom + 22,
            "text-anchor": "middle",
            fill: COLORS.text,
            "font-size": 10,
            "font-family": "ui-monospace, monospace",
        }, [label]));
    }
    root.appendChild(svg("line", {
        x1: rAUtoX(0), x2: rAUtoX(1),
        y1: PLOT_H - MARGIN.bottom + 3, y2: PLOT_H - MARGIN.bottom + 3,
        stroke: "rgba(255,255,255,0.25)",
    }));

    // L1 vertical reference line (faint).
    const l1x = rAUtoX(0.99);
    root.appendChild(svg("line", {
        x1: l1x, x2: l1x,
        y1: TRACK_Y - 64, y2: TRACK_Y + 64,
        stroke: COLORS.L1,
        "stroke-dasharray": "2 3",
        "stroke-width": 1,
    }));
    root.appendChild(svg("text", {
        x: l1x, y: TRACK_Y - 70,
        "text-anchor": "middle",
        fill: COLORS.textSubtle,
        "font-size": 9,
        "font-family": "ui-monospace, monospace",
        "letter-spacing": "0.08em",
    }, ["DSCOVR · ACE"]));

    // ── Sun ────────────────────────────────────────────────────────
    // Soft glow ring, then disk, then AR pip.
    root.appendChild(svg("circle", {
        cx: SUN_X, cy: TRACK_Y, r: SUN_R + 16,
        fill: COLORS.sunGlow, "pointer-events": "none",
    }));
    root.appendChild(svg("circle", {
        cx: SUN_X, cy: TRACK_Y, r: SUN_R + 5,
        fill: "rgba(255,180,90,0.25)", "pointer-events": "none",
    }));
    root.appendChild(svg("circle", {
        cx: SUN_X, cy: TRACK_Y, r: SUN_R,
        fill: COLORS.sun, "pointer-events": "none",
    }));
    // AR 13664 pip (rotates very slowly across the disk as a hint of
    // solar rotation; for the Gannon window, AR 13664 was central
    // around May 9-10 so we anchor that at h=-24 and rotate ±60° over
    // the 132h window).
    const arPip = svg("ellipse", {
        cx: SUN_X, cy: TRACK_Y - SUN_R * 0.45,
        rx: 5.5, ry: 3.5,
        fill: COLORS.sunSpot,
        "pointer-events": "none",
    });
    root.appendChild(arPip);
    // Flare-flash ring — a quick expanding pulse from AR 13664 when the
    // cursor crosses a CME's launch hour (driven in setCursor).
    const flashRing = svg("circle", {
        cx: SUN_X, cy: TRACK_Y, r: SUN_R + 6,
        fill: "none", stroke: COLORS.cmeHi, "stroke-width": 2,
        opacity: 0, "pointer-events": "none",
    });
    root.appendChild(flashRing);
    // AR label
    root.appendChild(svg("text", {
        x: SUN_X, y: TRACK_Y + SUN_R + 18,
        "text-anchor": "middle",
        fill: COLORS.textSubtle,
        "font-size": 10,
        "font-family": "ui-monospace, monospace",
    }, ["AR 13664"]));
    // Sun label
    root.appendChild(svg("text", {
        x: SUN_X, y: TRACK_Y - SUN_R - 12,
        "text-anchor": "middle",
        fill: COLORS.text,
        "font-size": 11,
        "font-family": "ui-monospace, monospace",
        "letter-spacing": "0.06em",
    }, ["SUN"]));

    // ── Earth + magnetosphere ──────────────────────────────────────
    // Bowshock (compresses when CMEs near impact — animated in setCursor).
    const bowshock = svg("path", {
        d: bowshockPath(EARTH_X, TRACK_Y, EARTH_R, 1.0),
        fill: "none",
        stroke: COLORS.earthCompr,
        "stroke-width": 1.0,
        opacity: 0.4,
        "pointer-events": "none",
    });
    root.appendChild(bowshock);
    // Magnetotail lobes (behind Earth) — stream anti-sunward, lengthen
    // under southward-Bz energy loading.
    const magnetotail = svg("path", {
        d: magnetotailPath(EARTH_X, TRACK_Y, EARTH_R, 1.0, 0),
        fill: "none", stroke: COLORS.tail, "stroke-width": 1,
        "stroke-dasharray": "1 4", opacity: 0.5, "pointer-events": "none",
    });
    root.appendChild(magnetotail);
    // Magnetopause — the inner boundary that CMEs press sunward.
    const magnetopause = svg("path", {
        d: magnetopausePath(EARTH_X, TRACK_Y, EARTH_R, 1.0),
        fill: "none", stroke: COLORS.magnetopause, "stroke-width": 1.1,
        opacity: 0.6, "pointer-events": "none",
    });
    root.appendChild(magnetopause);
    // Polar cusps — open-field funnels at each pole.
    const cuspN = svg("path", { d: cuspPath(EARTH_X, TRACK_Y, EARTH_R, 1.0, -1),
        fill: "none", stroke: COLORS.cusp, "stroke-width": 1,
        "stroke-dasharray": "2 2", opacity: 0.55, "pointer-events": "none" });
    const cuspS = svg("path", { d: cuspPath(EARTH_X, TRACK_Y, EARTH_R, 1.0, +1),
        fill: "none", stroke: COLORS.cusp, "stroke-width": 1,
        "stroke-dasharray": "2 2", opacity: 0.55, "pointer-events": "none" });
    root.appendChild(cuspN);
    root.appendChild(cuspS);
    // Boundary labels (subtle, scientific).
    root.appendChild(svg("text", {
        x: EARTH_X - EARTH_R * 4.8, y: TRACK_Y - EARTH_R * 5.4,
        "text-anchor": "middle", fill: COLORS.textSubtle, "font-size": 8,
        "font-family": "ui-monospace, monospace", "pointer-events": "none",
    }, ["bow shock"]));
    root.appendChild(svg("text", {
        x: EARTH_X - EARTH_R * 3.2, y: TRACK_Y + EARTH_R * 4.6,
        "text-anchor": "middle", fill: COLORS.textSubtle, "font-size": 8,
        "font-family": "ui-monospace, monospace", "pointer-events": "none",
    }, ["magnetopause"]));
    root.appendChild(svg("text", {
        x: EARTH_X + EARTH_R * 5.2, y: TRACK_Y - EARTH_R * 4.4,
        "text-anchor": "middle", fill: COLORS.textSubtle, "font-size": 8,
        "font-family": "ui-monospace, monospace", "pointer-events": "none",
    }, ["magnetotail"]));
    // Atmosphere glow
    root.appendChild(svg("circle", {
        cx: EARTH_X, cy: TRACK_Y, r: EARTH_R + 4,
        fill: COLORS.earthAtmos, "pointer-events": "none",
    }));
    root.appendChild(svg("circle", {
        cx: EARTH_X, cy: TRACK_Y, r: EARTH_R,
        fill: COLORS.earth, "pointer-events": "none",
    }));
    // Earth label
    root.appendChild(svg("text", {
        x: EARTH_X, y: TRACK_Y - EARTH_R - 12,
        "text-anchor": "middle",
        fill: COLORS.text,
        "font-size": 11,
        "font-family": "ui-monospace, monospace",
        "letter-spacing": "0.06em",
    }, ["EARTH"]));

    // ── Differentiated atmosphere shells (schematic) ───────────────
    // Concentric shells make the "where satellites fly / where drag
    // bites" story legible. The drag band (~400 km thermosphere) swells
    // and brightens with the modelled density (puff-up) in setCursor.
    const atmExo = svg("circle", { cx: EARTH_X, cy: TRACK_Y, r: EARTH_R + 13,
        fill: "none", stroke: COLORS.atmExo, "stroke-width": 2.5, opacity: 0.22,
        "pointer-events": "none" });
    const atmThermo = svg("circle", { cx: EARTH_X, cy: TRACK_Y, r: EARTH_R + 7,
        fill: "none", stroke: COLORS.atmThermo, "stroke-width": 3.5, opacity: 0.4,
        "pointer-events": "none" });
    const atmDrag = svg("circle", { cx: EARTH_X, cy: TRACK_Y, r: EARTH_R + 4.5,
        fill: "none", stroke: COLORS.atmDrag, "stroke-width": 2, opacity: 0.6,
        "pointer-events": "none" });
    root.appendChild(atmExo);
    root.appendChild(atmThermo);
    root.appendChild(atmDrag);

    // Auroral ovals at the poles — brightness ∝ hemispheric power (the
    // visible signature of Joule heating that puffs the thermosphere).
    const auroraN = svg("path", {
        d: `M ${EARTH_X - 8} ${TRACK_Y - 4} Q ${EARTH_X} ${TRACK_Y - 14} ${EARTH_X + 8} ${TRACK_Y - 4}`,
        fill: "none", stroke: COLORS.aurora, "stroke-width": 1.4, opacity: 0.2,
        "stroke-linecap": "round", "pointer-events": "none" });
    const auroraS = svg("path", {
        d: `M ${EARTH_X - 8} ${TRACK_Y + 4} Q ${EARTH_X} ${TRACK_Y + 14} ${EARTH_X + 8} ${TRACK_Y + 4}`,
        fill: "none", stroke: COLORS.aurora, "stroke-width": 1.4, opacity: 0.2,
        "stroke-linecap": "round", "pointer-events": "none" });
    root.appendChild(auroraN);
    root.appendChild(auroraS);

    // Shock-compression front — expands through Earth as a CME arrives.
    const shockArc = svg("path", {
        d: "", fill: "none", stroke: COLORS.shock, "stroke-width": 1.5,
        opacity: 0, "stroke-linecap": "round", "pointer-events": "none" });
    root.appendChild(shockArc);

    // ── CME layer ──────────────────────────────────────────────────
    // One <g> per CME — repositioned on every setCursor call. We keep
    // the array mutable so setCmeEvents() can rebuild the glyphs in
    // place when real-data DONKI events land from the hindcast API.
    let cmeNodes = [];
    // Common parent for all CME glyphs so we can remove them as a unit
    // when the catalog gets swapped.
    const cmeLayer = svg("g", { class: "gn-cme-layer" });
    root.appendChild(cmeLayer);

    function _buildGlyph(evt) {
        const g = svg("g", { class: "gn-cme", opacity: 0 });
        const radius = cmeRadius(evt.flare_class);
        const color = cmeColor(evt.flare_class);
        const glow = svg("circle", { r: radius * 2.4, fill: color, opacity: 0.18,
            "pointer-events": "none" });
        const body = svg("circle", { r: radius, fill: color, stroke: "rgba(0,0,0,0.4)",
            "stroke-width": 0.8 });
        const trail = svg("path", { d: "", stroke: color, "stroke-width": 1.5,
            opacity: 0.6, fill: "none", "stroke-linecap": "round" });
        const title = svg("title");
        title.textContent = `${evt.label}\n${evt.launch_iso} UT · v₀ = ${evt.v0_kms} km/s`;
        g.appendChild(glow);
        g.appendChild(trail);
        g.appendChild(body);
        g.appendChild(title);
        cmeLayer.appendChild(g);
        return { evt, g, glow, body, trail };
    }

    function _buildAllGlyphs(eventList) {
        for (const node of cmeNodes) cmeLayer.removeChild(node.g);
        cmeNodes = eventList.map(_buildGlyph);
    }
    _buildAllGlyphs(events);

    // ── Time + CME status readout (top-right) ──────────────────────
    const readoutY = MARGIN.top + 4;
    const tClock = svg("text", {
        x: PLOT_W - MARGIN.right + 4, y: readoutY,
        "text-anchor": "end",
        fill: COLORS.text,
        "font-size": 11,
        "font-family": "ui-monospace, monospace",
        "letter-spacing": "0.04em",
    }, ["—"]);
    const tCmeStatus = svg("text", {
        x: PLOT_W - MARGIN.right + 4, y: readoutY + 14,
        "text-anchor": "end",
        fill: COLORS.textSubtle,
        "font-size": 10,
        "font-family": "ui-monospace, monospace",
    }, [""]);
    root.appendChild(tClock);
    root.appendChild(tCmeStatus);
    // Live IMF Bz + solar-wind speed (the two coupling drivers).
    const bzReadout = svg("text", {
        x: PLOT_W - MARGIN.right + 4, y: readoutY + 28,
        "text-anchor": "end", fill: COLORS.textSubtle,
        "font-size": 10, "font-family": "ui-monospace, monospace",
    }, [""]);
    const vReadout = svg("text", {
        x: PLOT_W - MARGIN.right + 4, y: readoutY + 42,
        "text-anchor": "end", fill: COLORS.textSubtle,
        "font-size": 10, "font-family": "ui-monospace, monospace",
    }, [""]);
    // Dst / SYM-H — the ring-current storm-severity index. Blank until the
    // OMNI lift supplies real SYM-H (the static bundle has no Dst track).
    const dstReadout = svg("text", {
        x: PLOT_W - MARGIN.right + 4, y: readoutY + 56,
        "text-anchor": "end", fill: COLORS.textSubtle,
        "font-size": 10, "font-family": "ui-monospace, monospace",
    }, [""]);
    root.appendChild(bzReadout);
    root.appendChild(vReadout);
    root.appendChild(dstReadout);

    // ── Title strip (top-left) ─────────────────────────────────────
    root.appendChild(svg("text", {
        x: MARGIN.left, y: readoutY,
        fill: COLORS.text,
        "font-size": 11,
        "font-family": "ui-monospace, monospace",
        "letter-spacing": "0.08em",
    }, ["SUN → EARTH  ·  drag-based-model CME transit"]));

    // ── Atmosphere-shell legend (colour-matched to the Earth shells) ─
    const atmLegend = svg("g", { "pointer-events": "none" });
    const _legendItems = [
        [COLORS.atmExo,    "exosphere"],
        [COLORS.atmThermo, "thermosphere"],
        [COLORS.atmDrag,   "~400 km drag band"],
    ];
    let lx = MARGIN.left;
    const ly = readoutY + 14;
    atmLegend.appendChild(svg("text", {
        x: lx, y: ly, fill: COLORS.textSubtle, "font-size": 8,
        "font-family": "ui-monospace, monospace", "letter-spacing": "0.04em",
    }, ["ATMOSPHERE"]));
    lx += 64;
    for (const [col, label] of _legendItems) {
        atmLegend.appendChild(svg("circle", { cx: lx, cy: ly - 3, r: 3,
            fill: "none", stroke: col, "stroke-width": 1.6 }));
        atmLegend.appendChild(svg("text", {
            x: lx + 7, y: ly, fill: COLORS.textSubtle, "font-size": 8,
            "font-family": "ui-monospace, monospace",
        }, [label]));
        lx += 13 + label.length * 4.6;
    }
    root.appendChild(atmLegend);

    // ── Placeholder watermark if bundle is synthetic ───────────────
    if (replay._is_placeholder) {
        root.appendChild(svg("text", {
            x: PLOT_W / 2, y: PLOT_H / 2 + 4,
            "text-anchor": "middle",
            fill: "rgba(255,200,80,0.12)",
            "font-size": 56,
            "font-weight": 800,
            "font-family": "ui-monospace, monospace",
            "letter-spacing": "0.18em",
            transform: `rotate(-12 ${PLOT_W / 2} ${PLOT_H / 2})`,
            "pointer-events": "none",
        }, ["PLACEHOLDER"]));
    }

    container.appendChild(root);

    // ── setCursor: reposition every CME at this cursor's elapsed time ─
    function setCursor(cursorH) {
        // Update the clock
        tClock.textContent = `${_fmtClock(anchorMs, cursorH)} UT`;

        // Live storm drivers at this cursor. seekHours is a pure array
        // index here — the player cursor is already at cursorH during
        // scrub/play, so this just reads the sample (no intent mutation).
        const samp = (player && player.seekHours) ? player.seekHours(cursorH) : null;
        const d = samp ? samp.drivers : null;

        // Reposition each CME according to its DBM state.
        let arrivedNow = 0;
        let inTransit = 0;
        let queued = 0;
        let past = 0;
        let nearestArrivalH = null;

        for (const { evt, g, glow, body, trail } of cmeNodes) {
            const st = cmeStateAt(evt, cursorH);

            if (st.state === "queued") {
                // Park the glyph at the sun limb as a quiet pip; faded.
                g.setAttribute("opacity", 0.15);
                body.setAttribute("cx", SUN_EDGE_X - 4);
                body.setAttribute("cy", TRACK_Y);
                glow.setAttribute("cx", SUN_EDGE_X - 4);
                glow.setAttribute("cy", TRACK_Y);
                trail.setAttribute("d", "");
                queued++;
                // Track which queued CME is next.
                if (nearestArrivalH === null || evt.launch_h < nearestArrivalH) {
                    nearestArrivalH = evt.launch_h;
                }
                continue;
            }

            const cx = rAUtoX(st.r_AU);
            // Slight vertical offset so colocated CMEs don't overlap exactly.
            // Use the launch hour as a deterministic offset spread.
            const yOff = ((evt.launch_h % 13) * 4) - 8;
            const cy = TRACK_Y + yOff * 0.6;

            body.setAttribute("cx", cx);
            body.setAttribute("cy", cy);
            glow.setAttribute("cx", cx);
            glow.setAttribute("cy", cy);

            // Trail: 30 px line behind the CME pointing back toward Sun.
            const trailLen = Math.min(34, (st.r_AU * (EARTH_EDGE_X - SUN_EDGE_X)) - 8);
            if (trailLen > 4) {
                trail.setAttribute("d", `M ${cx - trailLen} ${cy} L ${cx - 6} ${cy}`);
            } else {
                trail.setAttribute("d", "");
            }

            if (st.state === "in_transit") {
                g.setAttribute("opacity", 1);
                inTransit++;
            } else if (st.state === "arrived") {
                g.setAttribute("opacity", 1);
                arrivedNow++;
            } else if (st.state === "past") {
                // Fade with distance past Earth.
                const fade = Math.max(0, 1 - (st.r_AU - 1.05) / 0.05);
                g.setAttribute("opacity", fade * 0.5);
                past++;
            }
        }

        // Magnetosphere compression: boundaries pull in when CMEs are
        // arrived/near Earth, AND — folded in below — when IMF Bz turns
        // southward and dynamic pressure (∝ v) climbs, so the boundary
        // stays compressed through the main phase, not only at impact.
        let compr = computeCompression(cmeNodes, cursorH);
        let load = 0;
        if (d) {
            const bzSquash = d.bz_nt < 0 ? Math.min(0.18, (-d.bz_nt / 40) * 0.18) : 0;
            // Prefer REAL dynamic pressure (OMNI) for the standoff — the
            // physical driver of magnetopause position; fall back to a
            // speed proxy only until Pdyn is lifted.
            const pdynCompr = (d.pdyn_npa != null)
                ? comprFromPdyn(d.pdyn_npa)
                : 1 - Math.min(0.10, Math.max(0, (d.v_kms - 450) / 550) * 0.10);
            // Boundary sits at the more-compressed of the CME-impact and the
            // ambient pressure term, then eroded further by southward Bz.
            compr = Math.max(0.42, Math.min(compr, pdynCompr) - bzSquash);
            // Tail loading grows with southward Bz (toward substorm onset).
            load = d.bz_nt < 0 ? Math.min(1, -d.bz_nt / 35) : 0;
        }
        bowshock.setAttribute("d", bowshockPath(EARTH_X, TRACK_Y, EARTH_R, compr));
        bowshock.setAttribute("opacity", 0.35 + 0.4 * (1 - compr));
        bowshock.setAttribute("stroke-width", 1.0 + 1.5 * (1 - compr));
        magnetopause.setAttribute("d", magnetopausePath(EARTH_X, TRACK_Y, EARTH_R, compr));
        magnetopause.setAttribute("opacity", 0.5 + 0.35 * (1 - compr));
        magnetotail.setAttribute("d", magnetotailPath(EARTH_X, TRACK_Y, EARTH_R, compr, load));
        magnetotail.setAttribute("opacity", 0.4 + 0.35 * load);
        cuspN.setAttribute("d", cuspPath(EARTH_X, TRACK_Y, EARTH_R, compr, -1));
        cuspS.setAttribute("d", cuspPath(EARTH_X, TRACK_Y, EARTH_R, compr, +1));

        // Status line
        const parts = [];
        if (queued > 0)    parts.push(`${queued} queued`);
        if (inTransit > 0) parts.push(`${inTransit} in transit`);
        if (arrivedNow > 0)parts.push(`${arrivedNow} at Earth`);
        if (past > 0)      parts.push(`${past} past`);
        tCmeStatus.textContent = parts.join(" · ");

        // ── Bz river: recolour + advance the IMF/solar-wind flow ───
        if (d) {
            const col   = bzColor(d.bz_nt);
            const south = d.bz_nt < 0 ? Math.min(1, -d.bz_nt / 30) : 0;
            const vNorm = Math.max(0, Math.min(1, (d.v_kms - 300) / 700));
            const baseOp = 0.10 + 0.30 * south + 0.12 * vNorm;
            // Dash flow advances with storm-time × wind speed; frozen for
            // reduced-motion (colour still shows the southward turn).
            const off = reduceMotion ? 0 : -(cursorH * (6 + vNorm * 30));
            for (const lane of riverLanes) {
                lane.setAttribute("stroke", col);
                lane.setAttribute("opacity", baseOp * (0.35 + 0.65 * lane._central));
                lane.setAttribute("stroke-dashoffset", off);
            }
        }

        // ── Auroral ovals: brightness ∝ auroral activity ───────────
        // Prefer the REAL AE index (OMNI) when lifted; else the bundle's
        // hemispheric-power proxy.
        if (d) {
            const a = (d.ae_nt != null) ? auroraFromAE(d.ae_nt)
                                        : auroraAlpha(d.hpi_gw, hpiMax);
            const auroraCol = lerpColor(COLORS.aurora, COLORS.auroraHi, a);
            for (const arc of [auroraN, auroraS]) {
                arc.setAttribute("stroke", auroraCol);
                arc.setAttribute("opacity", 0.15 + 0.7 * a);
                arc.setAttribute("stroke-width", 1.2 + 3.0 * a);
            }
        }

        // ── Thermospheric drag band: swell + brighten on puff-up ───
        if (samp && densArr.length && densMax > densMin) {
            const dn = Math.max(0, Math.min(1,
                (samp.density400.msis_apreal - densMin) / (densMax - densMin)));
            atmDrag.setAttribute("opacity", 0.45 + 0.5 * dn);
            atmDrag.setAttribute("stroke-width", 1.5 + 2.5 * dn);
            atmDrag.setAttribute("r", (EARTH_R + 4.5) + 2.0 * dn);
        }

        // ── Live driver readouts ───────────────────────────────────
        if (d) {
            bzReadout.textContent = `Bz ${d.bz_nt >= 0 ? "+" : ""}${d.bz_nt.toFixed(1)} nT`;
            bzReadout.setAttribute("fill", d.bz_nt < 0 ? COLORS.riverSouth : COLORS.textSubtle);
            vReadout.textContent = `V ${Math.round(d.v_kms)} km/s`;
            // Dst (ring current) — the canonical storm-severity number; only
            // shown once real SYM-H has been lifted from OMNI.
            if (d.sym_h_nt != null) {
                dstReadout.textContent = `Dst ${Math.round(d.sym_h_nt)} nT`;
                dstReadout.setAttribute("fill",
                    d.sym_h_nt <= -250 ? COLORS.riverSouth :
                    d.sym_h_nt <= -50  ? COLORS.atmDrag : COLORS.textSubtle);
            } else {
                dstReadout.textContent = "";
            }
        }

        // ── Flare flash at AR 13664 on each CME launch ─────────────
        let flash = 0, flashCol = COLORS.cmeHi;
        for (const { evt } of cmeNodes) {
            const dh = cursorH - evt.launch_h;
            if (dh >= 0 && dh < 1.5) {
                const f = 1 - dh / 1.5;
                if (f > flash) { flash = f; flashCol = cmeColor(evt.flare_class); }
            }
        }
        if (reduceMotion) flash = flash > 0 ? 0.5 : 0;
        flashRing.setAttribute("opacity", 0.6 * flash);
        flashRing.setAttribute("r", SUN_R + 6 + 26 * (1 - flash));
        flashRing.setAttribute("stroke", flashCol);
        arPip.setAttribute("fill", flash > 0 ? flashCol : COLORS.sunSpot);
        arPip.setAttribute("rx", 5.5 + 3 * flash);
        arPip.setAttribute("ry", 3.5 + 2 * flash);

        // ── Shock-compression front sweeping through Earth ─────────
        let shockP = 0;
        for (const { evt } of cmeNodes) {
            const st = cmeStateAt(evt, cursorH);
            if (st.r_AU > 0.96 && st.r_AU < 1.06) {
                const p = 1 - Math.abs(st.r_AU - 1.0) / 0.06;
                if (p > shockP) shockP = p;
            }
        }
        if (shockP > 0.02) {
            const arcR = EARTH_R * (1.2 + 5.0 * (1 - shockP));
            shockArc.setAttribute("d", shockArcPath(EARTH_X, TRACK_Y, arcR));
            shockArc.setAttribute("opacity", (reduceMotion ? 0.4 : 0.7) * shockP);
            shockArc.setAttribute("stroke-width", 1 + 2.5 * shockP);
        } else {
            shockArc.setAttribute("opacity", 0);
        }
    }

    // Swap the CME catalog at runtime (e.g. when the hindcast API
    // returns real DONKI data after the static bundle has rendered).
    // Re-annotates each event with launch_h then rebuilds the glyphs;
    // a follow-up setCursor() repaints positions in place.
    function setCmeEvents(newEvents) {
        const annotated = (newEvents || []).map(c => ({
            ...c,
            launch_h: (Date.parse(c.launch_iso) - anchorMs) / 3600_000,
        }));
        events.length = 0;
        Array.prototype.push.apply(events, annotated);
        _buildAllGlyphs(events);
    }

    setCursor(0);

    return { setCursor, setCmeEvents };
}

// Magnetosphere compression metric: 1.0 = nominal (10 R_E sunward),
// 0.5 = highly compressed (~5 R_E) when CMEs are impacting.
function computeCompression(cmeNodes, cursorH) {
    let factor = 1.0;
    for (const { evt } of cmeNodes) {
        const st = cmeStateAt(evt, cursorH);
        if (st.state === "queued" || st.state === "past") continue;
        // Closer-to-Earth CMEs compress more.
        const proximity = Math.max(0, 1 - Math.abs(1 - st.r_AU) / 0.20);
        factor -= proximity * 0.18 * Math.min(1, flareIntensity(evt.flare_class) / 4);
    }
    return Math.max(0.5, factor);
}

// SVG path for a stylised bow shock around Earth. `compress` ∈ [~0.42, 1].
// The Sun is to the LEFT (−x), so the sub-solar nose points sunward (−x)
// and the shock flanks open anti-sunward (+x) — i.e. the CME front from
// the left strikes the dayside nose, which is physically correct.
function bowshockPath(cx, cy, R, compress) {
    const upstream = R * 4.6 * compress;   // sunward standoff (toward −x)
    const flank    = R * 5.2;              // perpendicular extent
    const tail     = R * 7.0;              // anti-sunward extent (toward +x)
    // Open arc from tail-top → sunward nose → tail-bottom.
    return `M ${cx + tail} ${cy - flank}
            Q ${cx - upstream} ${cy - flank * 1.0}, ${cx - upstream} ${cy}
            Q ${cx - upstream} ${cy + flank * 1.0}, ${cx + tail} ${cy + flank}`;
}
