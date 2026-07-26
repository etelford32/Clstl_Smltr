/**
 * glyphs.js — the Parkers Physics icon set.
 *
 * WHY THIS EXISTS
 * ---------------
 * The nav used 47 emoji as its icons. Emoji are not an icon set: they are
 * font-dependent, so the nav literally looked like a different product on
 * macOS, Windows, Android and Linux; several (🛰️ 🕳️ 🌡️ 🛡️) are
 * variation-selector sequences that fall back to tofu or to a flat monochrome
 * form on older Windows; and none of them can take the accent colour, so the
 * hover ramp in .ndl-icon was fading a fixed-palette bitmap. For a product
 * pitching satellite operators and agencies, that is the wrong first
 * impression.
 *
 * THE SYSTEM
 * ----------
 * Every glyph is drawn on a 24×24 grid from the same three primitives as the
 * brand mark (icons/logo-mark.svg): a TILTED RING (ellipse at -20°), an AXIS
 * (straight line), and a NODE (small filled dot). That is what makes the set
 * read as one family instead of 35 unrelated drawings — the mark's geometry is
 * the vocabulary.
 *
 * Rules, all load-bearing:
 *   - stroke: currentColor, width 1.6, round cap + join, fill none.
 *     currentColor is the point — .ndl-icon's opacity ramp and any accent
 *     colour now apply to the icon for free. Do NOT hard-code a colour in a
 *     glyph; it will stop responding to theme and hover.
 *   - A glyph is INNER markup only. glyph() supplies <svg>, viewBox and the
 *     stroke defaults, so a glyph that sets its own is fighting the system.
 *   - Filled parts (a node, a black hole's shadow) set fill="currentColor"
 *     AND stroke="none" explicitly, because the group default is the reverse.
 *
 * ADDING ONE
 * ----------
 * Add an entry here, then use its id as `icon:` in js/nav.js. tests/glyphs.mjs
 * fails if nav.js references an id that does not exist here — that gate is the
 * whole reason a missing icon can't ship silently.
 *
 * UNKNOWN IDS FALL BACK TO TEXT ON PURPOSE. glyph() returns null rather than
 * throwing, and nav.js renders the raw value instead. That keeps any emoji or
 * literal character still in the tree working, so this migration could not
 * half-break the nav. Do not "tidy" that branch away.
 */

/* Shared fragments — reuse keeps the family visually consistent AND keeps the
 * file small enough to stay readable. */
const RING = (cx, cy, rx, ry, rot) =>
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(${rot} ${cx} ${cy})"/>`;
const NODE = (cx, cy, r = 1.5) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;

export const GLYPHS = {
    // ── Earth / atmosphere ──────────────────────────────────────────────
    earth:
        `<circle cx="12" cy="12" r="8.2"/>` +
        `<path d="M3.8 12h16.4"/>` +
        `<path d="M12 3.8c2.4 2.3 3.6 5.1 3.6 8.2s-1.2 5.9-3.6 8.2c-2.4-2.3-3.6-5.1-3.6-8.2S9.6 6.1 12 3.8z"/>`,
    moon:
        `<path d="M15.6 3.6a8.4 8.4 0 1 0 4.8 9.6 6.6 6.6 0 0 1-4.8-9.6z"/>`,
    atmosphere:
        // stacked shells over a limb — the thermosphere the drag work targets
        `<path d="M2.6 19a9.4 9.4 0 0 1 18.8 0"/>` +
        `<path d="M5.6 19a6.4 6.4 0 0 1 12.8 0"/>` +
        `<path d="M8.8 19a3.2 3.2 0 0 1 6.4 0"/>`,
    'space-weather':
        `<circle cx="8.6" cy="8.4" r="3.6"/>` +
        `<path d="M8.6 2.2v1.4M8.6 13.2v1.4M2.4 8.4h1.4M13.4 8.4h1.4M4.2 4l1 1M12 11.8l1 1M4.2 12.8l1-1M12 5l1-1"/>` +
        `<path d="M10 20.4h9.2M12.4 17.2h7.4"/>`,
    aurora:
        // wavy curtain over a horizon — the wave is what says aurora rather
        // than 'crown'; straight rays read as a claw at 20px
        `<path d="M5.4 19.6c-1.1-4.2-.2-8 2.4-11.4"/>` +
        `<path d="M10 20.2c-1.3-4.6-.5-8.8 1.8-12.8"/>` +
        `<path d="M14.6 19.6c-.9-4.2-.3-7.8 1.8-11.2"/>` +
        `<path d="M18.8 19c-.7-3.6-.2-6.6 1.2-9.2"/>` +
        `<path d="M2.8 21.6h18.4"/>`,

    // ── Magnetosphere / space-weather physics ───────────────────────────
    magnet:
        // ring current = a toroidal current. Torus plus a circulation
        // arrowhead, so it cannot be mistaken for the accretion disc.
        RING(12, 12, 9.4, 4.6, -18) + RING(12, 12, 4.4, 2, -18) +
        `<path d="M17.6 5.8l2.6 1.4-1.4 2.6"/>`,
    shield:
        `<path d="M12 2.8l7.4 3v5.6c0 4.6-3 8.2-7.4 9.8-4.4-1.6-7.4-5.2-7.4-9.8V5.8z"/>` +
        `<path d="M12 8v6"/>`,
    dynamo:
        // the INTERIOR: a surface, the conducting core inside it, and the
        // tilted dipole axis that core sustains — stubs only, so it does not
        // read as a crosshair. Deliberately unlike `magnet`, which is the
        // external toroidal ring current.
        `<circle cx="12" cy="12" r="8.4"/>` +
        `<circle cx="12" cy="12" r="3.7"/>` +
        `<path d="M9.4 2.6l.9 3.1M13.7 18.3l.9 3.1"/>` +
        NODE(12, 12, 1.1),
    'flux-rope':
        // twisted pair with rungs — a rope/helix. The earlier two-strand
        // sine version rendered as a row of X's ('XXI') at nav size.
        `<path d="M7 2.8c0 4.6 10 5.6 10 9.2s-10 4.6-10 9.2"/>` +
        `<path d="M17 2.8c0 4.6-10 5.6-10 9.2s10 4.6 10 9.2"/>` +
        `<path d="M8.8 8h6.4M8.8 16h6.4"/>`,
    'far-side':
        // limb with the hidden hemisphere dashed
        `<circle cx="12" cy="12" r="8.4"/>` +
        `<path d="M12 3.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor" stroke="none" opacity=".55"/>`,
    storm:
        // the mark's node + a hard bolt: a disturbed-state event
        `<path d="M13.4 2.4L5.6 13.2h5.2l-1.2 8.4 8-11h-5.2z"/>`,
    'storm-two-step':
        // two-step main phase — a bolt with a second, smaller re-intensification
        `<path d="M12.6 2.6L6.2 11h4.2l-.9 6.4 6.4-8.8h-4.2z"/>` +
        `<path d="M17.4 15.2l-2.8 3.6h2l-.5 2.8 2.8-3.8h-2z"/>`,

    // ── Sun / stars ─────────────────────────────────────────────────────
    sun:
        `<circle cx="12" cy="12" r="4.8"/>` +
        `<path d="M12 1.8v2.6M12 19.6v2.6M1.8 12h2.6M19.6 12h2.6M4.8 4.8l1.9 1.9M17.3 17.3l1.9 1.9M4.8 19.2l1.9-1.9M17.3 6.7l1.9-1.9"/>`,
    'star-bright':
        `<path d="M12 2.2l2.5 6.6 6.9.4-5.3 4.4 1.7 6.7-5.8-3.8-5.8 3.8 1.7-6.7-5.3-4.4 6.9-.4z"/>`,
    'star-binary':
        // two stars, unequal — no enclosing ring, which made this read as
        // 'planet'
        `<circle cx="8.4" cy="14" r="4.2"/>` + `<circle cx="17" cy="7.8" r="2.5"/>` +
        NODE(12.9, 11.2, 1.1),
    'star-red':
        // evolved giant: big shell + core node
        `<circle cx="12" cy="12" r="8.4"/>` + `<circle cx="12" cy="12" r="3.4"/>`,
    'star-oblate':
        // Achernar — the fastest rotator, visibly flattened
        `<ellipse cx="12" cy="12" rx="9" ry="6"/>` +
        `<path d="M3.2 12h17.6"/>` + NODE(12, 12, 1.3),
    'star-wr':
        // Wolf-Rayet: small stripped core inside broken, expanding shells.
        // Distinct from `sun`, which is core + full radial rays.
        `<circle cx="12" cy="12" r="2.6"/>` +
        `<path d="M6.6 7.2a7.4 7.4 0 0 1 10.8 0M6.6 16.8a7.4 7.4 0 0 0 10.8 0"/>` +
        `<path d="M3.4 12h1.8M18.8 12h1.8"/>`,
    wind:
        `<path d="M2.6 8h11a3 3 0 1 0-3-3"/>` +
        `<path d="M2.6 12.6h14.2a2.8 2.8 0 1 1-2.8 2.8"/>` +
        `<path d="M2.6 17.2h7.8"/>`,
    fluid:
        `<path d="M2.6 8.2c2.4-2.4 4.8-2.4 7.2 0s4.8 2.4 7.2 0 4-2 4.4-1.4"/>` +
        `<path d="M2.6 13.4c2.4-2.4 4.8-2.4 7.2 0s4.8 2.4 7.2 0 4-2 4.4-1.4"/>` +
        `<path d="M2.6 18.6c2.4-2.4 4.8-2.4 7.2 0s4.8 2.4 7.2 0 4-2 4.4-1.4"/>`,

    // ── Planets ─────────────────────────────────────────────────────────
    planet:
        // the mark's own form: disc + tilted ring
        `<circle cx="12" cy="11.4" r="5.6"/>` + RING(12, 11.4, 10, 3.6, -20),
    'planet-ice':
        // ice giant — ring nearly edge-on (Uranus' 98° tilt)
        `<circle cx="12" cy="12" r="5.8"/>` + RING(12, 12, 3.6, 10, -12),
    'solar-system':
        `<circle cx="12" cy="12" r="2.4"/>` +
        RING(12, 12, 5.6, 5.6, 0) + RING(12, 12, 9.6, 9.6, 0) + NODE(12, 2.4, 1.4),
    gravity:
        // a gravity well: rim, funnel walls, mass at the bottom
        `<ellipse cx="12" cy="6.6" rx="9" ry="3.2"/>` +
        `<path d="M3 6.6c0 5.2 3.8 11 9 11s9-5.8 9-11"/>` +
        NODE(12, 15.8, 1.9),

    // ── Black holes ─────────────────────────────────────────────────────
    'black-hole':
        `<circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none"/>` +
        RING(12, 12, 9.6, 4, -20),
    'black-hole-core':
        // galactic centre: shadow + photon ring + surrounding field
        `<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/>` +
        `<circle cx="12" cy="12" r="5.4"/>` + RING(12, 12, 10, 4.4, -20),
    observatory:
        `<path d="M3.4 20.4h17.2"/>` +
        `<path d="M5.6 20.4V13a6.4 6.4 0 0 1 12.8 0v7.4"/>` +
        `<path d="M4.6 10.6l14.8-5"/>` + NODE(12, 13, 1.6),
    accretion:
        // disc plus polar jets — the jets are what separate this from
        // `magnet` and `black-hole` at small sizes
        `<ellipse cx="12" cy="12" rx="10" ry="3.6"/>` +
        `<ellipse cx="12" cy="12" rx="5.4" ry="1.9"/>` +
        `<circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/>` +
        `<path d="M12 8.2V3.6M12 15.8v4.6"/>`,
    galaxy:
        // two interlocking hooks — a spiral swirl. The previous pair of
        // short arcs read as a checkmark.
        `<path d="M4 14.6C4 9.6 8 5.6 13 5.6c3.3 0 5.8 2 5.8 4.5 0 2-1.6 3.4-3.5 3.4"/>` +
        `<path d="M20 9.4c0 5-4 9-9 9-3.3 0-5.8-2-5.8-4.5 0-2 1.6-3.4 3.5-3.4"/>` +
        NODE(12, 12, 1.4),

    // ── Craft / operations ──────────────────────────────────────────────
    satellite:
        `<rect x="9.4" y="9.4" width="5.2" height="5.2" rx="1"/>` +
        `<path d="M9.4 12H4.2M14.6 12h5.2"/>` +
        `<path d="M2.6 9.4h3.2v5.2H2.6zM18.2 9.4h3.2v5.2h-3.2z"/>` +
        `<path d="M12 9.4V6.2"/>`,
    operations:
        // console gauge: arc, tick marks, needle, hub
        `<path d="M3.8 17.8a8.8 8.8 0 0 1 16.4 0"/>` +
        `<path d="M5 13.4l1.5.9M12 9.2v1.7M19 13.4l-1.5.9"/>` +
        `<path d="M12 17.8l4.6-3.9"/>` + NODE(12, 17.8, 1.6),
    rocket:
        `<path d="M12 2.4c3.2 2.6 4.8 6.2 4.8 10.2l-2.4 3.4H9.6l-2.4-3.4C7.2 8.6 8.8 5 12 2.4z"/>` +
        `<circle cx="12" cy="9.4" r="1.8"/>` +
        `<path d="M9.6 16v3.4l-2.6 2M14.4 16v3.4l2.6 2"/>`,
    probe:
        `<circle cx="12" cy="12" r="3.2"/>` +
        `<path d="M12 8.8V4.2M12 15.2v4.6M8.8 12H4.2M15.2 12h4.6"/>` + RING(12, 12, 9.4, 9.4, 0),
    target:
        `<circle cx="12" cy="12" r="8.4"/>` + `<circle cx="12" cy="12" r="4"/>` + NODE(12, 12, 1.5),

    // ── Field notes / instruments ───────────────────────────────────────
    notebook:
        `<path d="M6 3.4h12.4a1 1 0 0 1 1 1v15.2a1 1 0 0 1-1 1H6z"/>` +
        `<path d="M6 3.4a1.6 1.6 0 0 0 0 3.2h1.8M6 20.6a1.6 1.6 0 0 1 0-3.2h1.8"/>` +
        `<path d="M10.4 9h6M10.4 13h6"/>`,
    paper:
        `<path d="M5.6 3.4h8.2l4.6 4.6v12.6H5.6z"/>` +
        `<path d="M13.6 3.4V8h4.6"/>` +
        `<path d="M8.6 12.4h6.8M8.6 16h4.8"/>`,
    'chart-down':
        `<path d="M3.6 4v16.4h16.8"/>` +
        `<path d="M6.8 8.2l4 4.4 3.2-2.6 4.8 5.6"/>` + NODE(18.8, 15.6, 1.4),
    chart:
        `<path d="M3.6 4v16.4h16.8"/>` +
        `<path d="M7.4 16.6V11M11.6 16.6V7.4M15.8 16.6v-4"/>`,
    microscope:
        `<path d="M8.4 18.6h10.2"/>` +
        `<path d="M11 18.6l-2.6-4.4a5 5 0 0 1 1.8-6.8l1.4-.8"/>` +
        `<path d="M10.2 4.8l3.6-2.1 2.4 4.2-3.6 2.1z"/>` +
        `<path d="M4.6 21.4h14.8"/>`,
    hourglass:
        `<path d="M6.6 2.8h10.8M6.6 21.2h10.8"/>` +
        `<path d="M8 2.8v3.6l4 5.6 4-5.6V2.8M8 21.2v-3.6l4-5.6 4 5.6v3.6"/>`,
    engine:
        // a chip, not another sun — Rust/WASM is the compute layer, and the
        // previous circle+rays was indistinguishable from `sun` at 20px
        `<rect x="7" y="7" width="10" height="10" rx="1.4"/>` +
        `<rect x="10.3" y="10.3" width="3.4" height="3.4"/>` +
        `<path d="M10 7V4M14 7V4M10 20v-3M14 20v-3M7 10H4M7 14H4M20 10h-3M20 14h-3"/>`,
};

/**
 * Render a glyph as inline SVG markup.
 *
 * Returns null for an unknown id so callers can fall back to rendering the
 * raw value as text — see the note in the file header; that is deliberate,
 * not an oversight.
 *
 * @param {string} id   key in GLYPHS
 * @param {{size?: number, cls?: string}} [opts]
 * @returns {string|null} SVG markup, or null if `id` is not a known glyph
 */
export function glyph(id, { size = 20, cls = '' } = {}) {
    const inner = GLYPHS[id];
    if (!inner) return null;
    return `<svg class="pp-glyph${cls ? ' ' + cls : ''}" width="${size}" height="${size}" ` +
        `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ` +
        `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
}

export const GLYPH_IDS = Object.keys(GLYPHS);
