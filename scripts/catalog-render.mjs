/**
 * catalog-render.mjs — the card markup shared by every generated catalog page
 *
 * Two builders emit simulation cards:
 *
 *   scripts/build-simulations-page.mjs   the complete index (simulations.html)
 *   scripts/build-section-pages.mjs      the five section hubs
 *
 * They must emit the SAME card, because a visitor moving between them is
 * looking at the same thing in two places. Keeping `renderCard` here rather
 * than having one builder reach into the other's internals means neither
 * owns the other, and a card change lands on all six pages at once.
 *
 * js/catalog-styles.css is the matching half — the CSS these class names
 * refer to, shared by the same six pages.
 */

import { glyph } from '../js/glyphs.js';

/** Escape for use in HTML text and double-quoted attribute values. */
export function esc(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Icon markup for a card.
 *
 * glyph() returns null for an unknown id (js/glyphs.js documents that as
 * deliberate). Here an unknown id is a typo in the catalog and nothing else,
 * so we throw rather than silently shipping a blank square — the drift gate
 * is the point of the generated pages.
 */
export function iconMarkup(sim, size = 22) {
    const svg = glyph(sim.icon, { size });
    if (!svg) throw new Error(`catalog: "${sim.id}" uses unknown glyph id "${sim.icon}"`);
    return svg;
}

export const TIER_LABEL = { public: 'Free', free: 'Free account' };

// Cards sit at the same depth on every page that renders them (inside
// `.sim-grid` > `.sim-inner` > `section`), so the indent is a constant rather
// than a parameter.
//
// It was briefly a second parameter with a default, and that is a trap worth
// naming: `sims.map(renderCard)` hands map's callback THREE arguments, so the
// array index landed in it and every card was emitted with a literal `0`, `1`,
// `2`… as its leading whitespace. The digits rendered on the page, next to
// every card. Nothing caught it — the drift gate compares the committed HTML
// against this generator, and the generator was producing the same wrong
// bytes, so both sides agreed. A constant cannot be captured by `map`.
const CARD_INDENT = '      ';

/** One simulation card. */
export function renderCard(sim) {
    const indent = CARD_INDENT;
    const badge = sim.badge
        ? `<sup class="sim-badge sim-badge-${sim.badge === 'NEW' ? 'new' : 'note'}">${esc(sim.badge)}</sup>`
        : '';
    // One lowercase haystack per card so the filter never has to walk the DOM
    // reading textContent — it just substring-matches this attribute.
    const haystack = `${sim.title} ${sim.blurb} ${sim.id}`.toLowerCase();
    return [
        `${indent}<a class="sim-card" href="${esc(sim.href)}" data-cat="${esc(sim.category)}" data-find="${esc(haystack)}">`,
        `${indent}  <span class="sim-card-top">`,
        `${indent}    <span class="sim-card-icon">${iconMarkup(sim)}</span>`,
        `${indent}    <span class="sim-tier ${esc(sim.tier)}">${esc(TIER_LABEL[sim.tier])}</span>`,
        `${indent}  </span>`,
        `${indent}  <span class="sim-card-title">${esc(sim.title)}${badge}</span>`,
        `${indent}  <span class="sim-card-blurb">${esc(sim.blurb)}</span>`,
        `${indent}</a>`,
    ].join('\n');
}
