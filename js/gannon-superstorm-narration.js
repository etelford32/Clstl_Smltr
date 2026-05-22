/**
 * gannon-superstorm-narration.js — story-band tied to the scrubber
 * ═══════════════════════════════════════════════════════════════════════
 * Lightweight DOM (not SVG) module that renders a horizontal narrative
 * track above the charts. Each "moment" is a clickable button placed
 * at its time on the track; the active moment (latest one passed by
 * the scrubber) is highlighted and its body text appears in the
 * caption pane below the track.
 *
 * Why DOM instead of SVG: the moment labels and body need to flow
 * with normal text wrapping, and the click-to-seek + active-state
 * styling is easier in CSS than in SVG. Horizontal positioning uses
 * percentages chosen to match the chart plot area's left/right
 * inset (see CSS variables in the page).
 *
 * Exports:
 *   createNarrationBand(container, replay, opts) → { setCursor }
 *
 * opts:
 *   onSeekHours(h)  — required, called when the user clicks a moment.
 *                     Page wires this through to scrubber + player.
 */

// The Gannon-storm script. Times are hours-from-window-start with the
// 2024-05-10T12:00:00Z origin used throughout the page. These are
// editorial choices — the canonical events are SSC, southward turn,
// saturation, peak ρ, low-latitude aurora, and recovery onset.
//
// `clock` strings are typed for the page rather than computed so we
// can use natural-language month names ("May 10 17:05 UT") instead
// of YYYY-MM-DD.
const MOMENTS = [
    {
        h:     0,
        clock: "May 10 · 12:00 UT",
        title: "Pre-storm baseline",
        body:
            "The thermosphere is quiet. Real Ap sits near 30, " +
            "ρ at 400 km is ~3×10⁻¹² kg/m³, and the three model " +
            "tracks agree to within a few percent. The window opens.",
        phase: "ramp",
    },
    {
        h:     5.08,
        clock: "May 10 · 17:05 UT",
        title: "Sheath shock arrives at DSCOVR",
        body:
            "The leading edge of a coronal-mass-ejection cluster " +
            "hits L1. Solar-wind ram pressure jumps ~5×, the IMF " +
            "rotates, and the magnetosphere starts compressing. " +
            "Earth's atmosphere doesn't notice for ~30 minutes.",
        phase: "ramp",
    },
    {
        h:     6.0,
        clock: "May 10 · 18:00 UT",
        title: "Bz turns sharply southward",
        body:
            "The interplanetary magnetic field tilts to roughly " +
            "−30 nT and stays there. Dayside reconnection switches " +
            "on; solar-wind energy now couples efficiently into the " +
            "magnetosphere. Φ_PC begins to surge past 100 kV.",
        phase: "ramp",
    },
    {
        h:     8.0,
        clock: "May 10 · 20:00 UT",
        title: "Ap saturates at 400",
        body:
            "Kp reaches its 9-ceiling; GFZ's definitive Ap pegs " +
            "at 400 and stops scaling with the storm. Any thermosphere " +
            "model driven by official Ap is now blind to the next " +
            "24 h — but the MHD- and ground-mag-derived Ap* surrogates " +
            "keep climbing, into the 600s.",
        phase: "peak",
    },
    {
        h:     15.0,
        clock: "May 11 · 03:00 UT",
        title: "Thermospheric density doubles",
        body:
            "Joule heating in the auroral oval peaks. Density at " +
            "400 km surges from ~7 to ~75 ×10⁻¹² kg/m³ — a 10× jump. " +
            "LEO objects in this altitude band experience the highest " +
            "drag rates seen since the November 2003 Halloween storms.",
        phase: "peak",
    },
    {
        h:     18.0,
        clock: "May 11 · 06:00 UT",
        title: "Aurora visible to low latitudes",
        body:
            "The auroral oval expands equatorward past 30° magnetic " +
            "latitude. Naked-eye aurora is reported as far south as " +
            "central Mexico, the Bahamas, and northern India — the " +
            "broadest equatorward extent in two decades.",
        phase: "peak",
    },
    {
        h:     30.0,
        clock: "May 11 · 18:00 UT",
        title: "Recovery begins",
        body:
            "Bz oscillates back toward zero; Φ_PC drops below 100 kV. " +
            "Heating subsides, but density doesn't immediately follow — " +
            "the storm has shifted thermospheric composition (more N₂, " +
            "less O at 400 km), so drag stays elevated for another ~24 h.",
        phase: "recovery",
    },
];

// CSS percentages matching the chart's plot area inset:
//   left:  MARGIN.left / PLOT_W   = 56 / 800 = 7.00%
//   right: MARGIN.right / PLOT_W  = 16 / 800 = 2.00%
// A moment at h=H lands at left = 7.00% + (H/dur_h) * 91.00%.
const TRACK_INSET_LEFT_PCT  = 7.00;
const TRACK_INSET_RIGHT_PCT = 2.00;

function _phaseClass(phase) {
    return `gn-narration-moment--${phase}`;
}

export function createNarrationBand(container, replay, opts = {}) {
    const win   = replay.window;
    const t0Ms  = Date.parse(win.start);
    const t1Ms  = Date.parse(win.end);
    const dur_h = (t1Ms - t0Ms) / 3600_000;

    // Reset the container and reuse the page's pulse class for the
    // skeleton-loading look until we render.
    container.innerHTML = "";
    container.classList.remove("gn-pulse");
    container.classList.add("gn-narration");

    // Track wrapper.
    const track = document.createElement("div");
    track.className = "gn-narration-track";
    track.style.left  = TRACK_INSET_LEFT_PCT  + "%";
    track.style.right = TRACK_INSET_RIGHT_PCT + "%";

    const usablePct = 100 - TRACK_INSET_LEFT_PCT - TRACK_INSET_RIGHT_PCT;

    // Filter moments to within the window (defensive — if the window
    // ever changes, moments outside get dropped).
    const moments = MOMENTS.filter(m => m.h >= 0 && m.h <= dur_h);

    const momentEls = [];
    for (const m of moments) {
        // Position relative to the track (not the container) so layouts
        // stay simple at any container width.
        const pctWithinTrack = (m.h / dur_h) * 100;

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `gn-narration-moment ${_phaseClass(m.phase)}`;
        btn.style.left = pctWithinTrack + "%";
        btn.setAttribute("data-h", String(m.h));
        btn.setAttribute("aria-label", `${m.clock} — ${m.title}`);
        btn.title = `${m.clock}\n${m.title}`;

        const tick = document.createElement("span");
        tick.className = "gn-narration-tick";
        btn.appendChild(tick);

        const dot = document.createElement("span");
        dot.className = "gn-narration-dot";
        btn.appendChild(dot);

        const lbl = document.createElement("span");
        lbl.className = "gn-narration-label";
        // Title-cased shorthand for the on-track label — full text
        // shows in tooltip + caption.
        lbl.textContent = _shorthand(m);
        btn.appendChild(lbl);

        btn.addEventListener("click", () => {
            if (typeof opts.onSeekHours === "function") {
                opts.onSeekHours(m.h);
            }
        });

        track.appendChild(btn);
        momentEls.push({ moment: m, el: btn });
    }

    // Caption pane below the track.
    const caption = document.createElement("div");
    caption.className = "gn-narration-caption";
    const capClock = document.createElement("div");
    capClock.className = "gn-narration-clock";
    const capTitle = document.createElement("div");
    capTitle.className = "gn-narration-title";
    const capBody  = document.createElement("div");
    capBody.className = "gn-narration-body";
    caption.appendChild(capClock);
    caption.appendChild(capTitle);
    caption.appendChild(capBody);

    container.appendChild(track);
    container.appendChild(caption);

    function paintCaption(m) {
        capClock.textContent = m.clock;
        capTitle.textContent = m.title;
        capBody.textContent  = m.body;
    }

    function setCursor(hours) {
        // Active moment = the latest moment whose h is <= cursor.
        // If cursor is before the first moment, fall back to moments[0]
        // (the "window opens" baseline) so the caption is never blank.
        let active = momentEls[0];
        for (const mEl of momentEls) {
            if (mEl.moment.h <= hours) active = mEl;
            else break;
        }
        for (const mEl of momentEls) {
            mEl.el.classList.toggle("is-active", mEl === active);
        }
        if (active) paintCaption(active.moment);
    }

    setCursor(0);

    return { setCursor };
}

// Short on-track label. Full title lives in the caption + tooltip.
function _shorthand(m) {
    // Map full titles to ~12-character on-track labels.
    const map = {
        "Pre-storm baseline":              "baseline",
        "Sheath shock arrives at DSCOVR":  "SSC",
        "Bz turns sharply southward":      "Bz southward",
        "Ap saturates at 400":             "Ap = 400",
        "Thermospheric density doubles":   "peak ρ",
        "Aurora visible to low latitudes": "low-lat aurora",
        "Recovery begins":                 "recovery",
    };
    return map[m.title] || m.title;
}
