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

    // ── background: subtle radial gradient toward the sun ──────────
    // Two faint Parker-spiral suggestion lines.
    for (let i = 0; i < 14; i++) {
        const yOff = (i / 13) * (PLOT_H - MARGIN.top - MARGIN.bottom) - (PLOT_H - MARGIN.top - MARGIN.bottom) / 2;
        const yStart = TRACK_Y + yOff;
        // Quadratic curve that fans out away from sun.
        const cx = SUN_EDGE_X + 240;
        const cy = TRACK_Y + yOff * 0.4;
        root.appendChild(svg("path", {
            d: `M ${SUN_X} ${TRACK_Y} Q ${cx} ${cy} ${EARTH_EDGE_X + 20} ${yStart}`,
            stroke: COLORS.parker, fill: "none", "stroke-width": 0.7,
        }));
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

    // ── Title strip (top-left) ─────────────────────────────────────
    root.appendChild(svg("text", {
        x: MARGIN.left, y: readoutY,
        fill: COLORS.text,
        "font-size": 11,
        "font-family": "ui-monospace, monospace",
        "letter-spacing": "0.08em",
    }, ["SUN → EARTH  ·  drag-based-model CME transit"]));

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

        // Magnetosphere compression: bowshock pulls in when CMEs are
        // either arrived or within ~5% AU of Earth.
        const compr = computeCompression(cmeNodes, cursorH);
        bowshock.setAttribute("d", bowshockPath(EARTH_X, TRACK_Y, EARTH_R, compr));
        bowshock.setAttribute("opacity", 0.35 + 0.4 * (1 - compr));
        bowshock.setAttribute("stroke-width", 1.0 + 1.5 * (1 - compr));

        // Status line
        const parts = [];
        if (queued > 0)    parts.push(`${queued} queued`);
        if (inTransit > 0) parts.push(`${inTransit} in transit`);
        if (arrivedNow > 0)parts.push(`${arrivedNow} at Earth`);
        if (past > 0)      parts.push(`${past} past`);
        tCmeStatus.textContent = parts.join(" · ");
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

// SVG path for a stylised bowshock around Earth. `compress` ∈ [0.5, 1].
function bowshockPath(cx, cy, R, compress) {
    const upstream = R * 4.0 * compress;   // distance sunward
    const flank    = R * 5.0;              // perpendicular extent
    const tail     = R * 7.0;              // anti-sunward extent
    // Open arc from tail-top → upstream nose → tail-bottom.
    return `M ${cx - tail} ${cy - flank}
            Q ${cx + upstream} ${cy - flank * 1.0}, ${cx + upstream} ${cy}
            Q ${cx + upstream} ${cy + flank * 1.0}, ${cx - tail} ${cy + flank}`;
}
