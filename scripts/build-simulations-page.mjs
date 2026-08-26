#!/usr/bin/env node
/**
 * build-simulations-page.mjs — bake js/simulations-catalog.js into simulations.html
 *
 * The catalog page is STATIC HTML on purpose. It is the site's index of every
 * simulation we ship, so it has to be crawlable and it has to render with
 * JavaScript disabled — a client-rendered grid would hand search engines an
 * empty <main>. But hand-writing 55 cards is exactly what let the page drift
 * eight simulations behind the nav (see the js/simulations-catalog.js header).
 *
 * So: one source of truth, one generator, and a test that fails when the
 * committed HTML no longer matches what this script would produce.
 *
 *   node scripts/build-simulations-page.mjs          # rewrite simulations.html
 *   node scripts/build-simulations-page.mjs --check  # exit 1 if stale (CI)
 *
 * The script owns exactly two sentinel-delimited regions and touches nothing
 * else in the file, so the page's CSS, nav mount and footer stay hand-edited:
 *
 *   <!-- SIM-CATALOG:HEAD:BEGIN -->  the count-bearing meta descriptions
 *   <!-- SIM-CATALOG:MAIN:BEGIN -->  hero headline, filter toolbar, the grid
 *
 * `renderCatalogHtml()` is exported so tests/simulations-catalog.mjs can
 * compare against it without shelling out.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SIM_CATEGORIES, SIM_COUNT, catalogSections } from '../js/simulations-catalog.js';
// Card markup is shared with scripts/build-section-pages.mjs — the hubs and
// the index must render the same card. See scripts/catalog-render.mjs.
import { esc, renderCard } from './catalog-render.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'simulations.html');

// ── Sentinels ───────────────────────────────────────────────────────────────
const REGIONS = [
    { name: 'HEAD', begin: '<!-- SIM-CATALOG:HEAD:BEGIN -->', end: '<!-- SIM-CATALOG:HEAD:END -->' },
    { name: 'MAIN', begin: '<!-- SIM-CATALOG:MAIN:BEGIN -->', end: '<!-- SIM-CATALOG:MAIN:END -->' },
];

function renderSection({ category, sims }) {
    const plural = sims.length === 1 ? 'simulation' : 'simulations';
    return [
        `<section class="sim-section" data-section="${esc(category.id)}" aria-labelledby="cat-${esc(category.id)}">`,
        `  <div class="sim-inner">`,
        `    <div class="sim-section-head">`,
        `      <h2 class="sim-section-title" id="cat-${esc(category.id)}">${esc(category.label)}</h2>`,
        `      <p class="sim-section-note">${esc(category.note)}</p>`,
        `      <p class="sim-section-count">${sims.length} ${plural}</p>`,
        `    </div>`,
        `    <div class="sim-grid">`,
        sims.map(renderCard).join('\n'),
        `    </div>`,
        `  </div>`,
        `</section>`,
    ].join('\n');
}

function renderChips() {
    const chips = [
        `      <button type="button" class="sim-chip is-on" data-chip="all" aria-pressed="true">All ${SIM_COUNT}</button>`,
        ...SIM_CATEGORIES.map(category =>
            `      <button type="button" class="sim-chip" data-chip="${esc(category.id)}" aria-pressed="false">${esc(category.label)}</button>`),
    ];
    return chips.join('\n');
}

/** The HEAD region: the three descriptions that quote the catalog size. */
export function renderHeadHtml() {
    const summary = `The complete Parkers Physics catalog — ${SIM_COUNT} real-time physics simulations: `
        + `magnetosphere MHD, satellite drag, CME forecasting, planetary systems, stars and black holes, `
        + `driven by live NASA and NOAA data.`;
    const short = `${SIM_COUNT} real-time physics simulations, one engine — driven by live NASA and NOAA data.`;
    return [
        `<meta name="description" content="${esc(summary)}">`,
        `<meta property="og:description" content="${esc(short)}">`,
        `<meta name="twitter:description" content="${esc(short)}">`,
    ].join('\n');
}

/** The MAIN region: hero, filter toolbar, and every category section. */
export function renderCatalogHtml() {
    const sections = catalogSections();
    return [
        `<header class="sim-hero">`,
        `  <p class="sim-hero-label">The Full Catalog</p>`,
        `  <h1>${SIM_COUNT} simulations. One engine.</h1>`,
        `  <p class="sim-hero-sub">Every page below runs published physics in your browser — most of them driven by the same live NASA and NOAA feeds that power the <a href="index.html">home page's magnetosphere</a>. Free means free: open it and it runs.</p>`,
        `</header>`,
        ``,
        `<div class="sim-toolbar" role="search">`,
        `  <label class="sim-search">`,
        `    <span class="sim-search-label">Filter simulations</span>`,
        `    <input type="search" id="sim-search" placeholder="Search ${SIM_COUNT} simulations…" autocomplete="off" spellcheck="false">`,
        `  </label>`,
        `  <div class="sim-chips" id="sim-chips">`,
        renderChips(),
        `  </div>`,
        `</div>`,
        `<p class="sim-empty" id="sim-empty" hidden>No simulation matches that. <button type="button" id="sim-reset">Clear the filter</button></p>`,
        ``,
        sections.map(renderSection).join('\n\n'),
    ].join('\n');
}

// ── Region splice ───────────────────────────────────────────────────────────

function splice(html, region, body) {
    const start = html.indexOf(region.begin);
    const stop = html.indexOf(region.end);
    if (start === -1 || stop === -1) {
        throw new Error(`simulations.html is missing the ${region.name} sentinels `
            + `(${region.begin} … ${region.end}) — restore them before running the builder.`);
    }
    if (stop < start) {
        throw new Error(`simulations.html has the ${region.name} sentinels in the wrong order.`);
    }
    return html.slice(0, start + region.begin.length)
        + '\n' + body + '\n'
        + html.slice(stop);
}

/** Apply every generated region to `html` and return the result. */
export function applyRegions(html) {
    let out = splice(html, REGIONS[0], renderHeadHtml());
    out = splice(out, REGIONS[1], renderCatalogHtml());
    return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
    const current = readFileSync(PAGE, 'utf8');
    const next = applyRegions(current);

    if (process.argv.includes('--check')) {
        if (current !== next) {
            console.error('❌ simulations.html is stale — run `node scripts/build-simulations-page.mjs`.');
            process.exit(1);
        }
        console.log(`✅ simulations.html is in sync with the catalog (${SIM_COUNT} simulations).`);
    } else if (current === next) {
        console.log(`simulations.html already up to date (${SIM_COUNT} simulations).`);
    } else {
        writeFileSync(PAGE, next);
        console.log(`✅ simulations.html rebuilt — ${SIM_COUNT} simulations in ${catalogSections().length} categories.`);
    }
}
