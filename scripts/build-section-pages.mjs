#!/usr/bin/env node
/**
 * build-section-pages.mjs — bake one static hub page per top-level nav section
 *
 *   node scripts/build-section-pages.mjs           # write every hub page
 *   node scripts/build-section-pages.mjs --check   # exit 1 if any is stale (CI)
 *   node scripts/build-section-pages.mjs --only=local-space
 *
 * WHY THESE PAGES EXIST
 * ─────────────────────
 * Until 2026-08 the nav's top-level items were pure dropdown toggles: clicking
 * "Space Weather" did nothing but open a menu, and the menu was the only way
 * into the section. That forced every menu to try to be complete, and one of
 * them succeeded — "Space Weather" reached 18 links and 1110px, which is
 * taller than a laptop screen, so its bottom third was unreachable on every
 * common display (the measurements are in js/site-sections.js).
 *
 * A hub page breaks that bind. The menu can be a curated ten links because
 * the hub is the complete list, and the top-level button now goes somewhere.
 *
 * WHOLE-FILE GENERATION, ON PURPOSE
 * ─────────────────────────────────
 * simulations.html is sentinel-spliced because it predates its builder and
 * carries hand-written chrome. These five pages have no hand-written half at
 * all: every byte comes from js/site-sections.js plus the catalog, so the
 * builder owns the whole file. That means there is nothing to hand-edit and
 * therefore nothing to drift — `--check` compares the entire file.
 *
 * If you want to change how a hub page LOOKS, change this file or
 * js/catalog-styles.css and re-run. Editing the .html directly will be
 * reverted by the next run and fails CI in the meantime.
 *
 * SEO
 * ───
 * Cards are real markup, so a hub renders complete with JavaScript disabled —
 * these are the section landing pages crawlers will see. The og:image tags are
 * emitted in exactly the shape scripts/build-og-cards.mjs writes, so that
 * script only has to render the images and never has to rewrite the markup
 * (which would make every page instantly "stale" against this builder).
 *
 * After adding a section: run this, then scripts/build-sitemap.mjs, then
 * scripts/build-og-cards.mjs.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SITE_SECTIONS } from '../js/site-sections.js';
import { SIM_COUNT, sectionPage } from '../js/simulations-catalog.js';
import { esc, renderCard } from './catalog-render.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://parkersphysics.com';

// Cache-buster on the nav import, matching the other pages. Bumping it is a
// deploy concern, not a build one — it is copied, not generated.
const NAV_VERSION = 'v=20260424';

// ── Page template ───────────────────────────────────────────────────────────

/** `12 simulations` / `1 simulation`. */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The section-switcher strip: every hub links every other hub. */
function renderSwitch(current) {
    const links = SITE_SECTIONS.map(section => {
        const isHere = section.id === current.id;
        const attrs = isHere ? ' aria-current="page"' : '';
        return `  <a href="${esc(section.href)}"${attrs}>${esc(section.label)}</a>`;
    });
    links.push(`  <a href="simulations.html">All ${SIM_COUNT}</a>`);
    return [
        `<nav class="hub-switch" aria-label="Site sections">`,
        ...links,
        `</nav>`,
    ].join('\n');
}

/**
 * One sub-group: heading, note, and its cards.
 *
 * `countNoun` exists because a group's entries are not always simulations —
 * the Field Notes block under Research is essays, and "4 simulations" over a
 * list of papers is a small lie the page does not need to tell.
 */
function renderGroup({ group, sims }) {
    return [
        `<section class="sim-section" data-section="${esc(group.id)}" aria-labelledby="grp-${esc(group.id)}">`,
        `  <div class="sim-inner">`,
        `    <div class="sim-section-head">`,
        `      <h2 class="hub-group-title" id="grp-${esc(group.id)}">${esc(group.label)}</h2>`,
        `      <p class="sim-section-note">${esc(group.note)}</p>`,
        `      <p class="sim-section-count">${esc(plural(sims.length, group.countNoun || 'simulation'))}</p>`,
        `    </div>`,
        `    <div class="sim-grid">`,
        sims.map(sim => renderCard(sim)).join('\n'),
        `    </div>`,
        `  </div>`,
        `</section>`,
    ].join('\n');
}

/**
 * Prev/next across the five sections.
 *
 * Wraps around, so every hub has both cards and the strip is never
 * half-empty. With five sections nothing is ever its own neighbour.
 */
function renderNeighbours(current) {
    const index = SITE_SECTIONS.findIndex(section => section.id === current.id);
    const prev = SITE_SECTIONS[(index - 1 + SITE_SECTIONS.length) % SITE_SECTIONS.length];
    const next = SITE_SECTIONS[(index + 1) % SITE_SECTIONS.length];
    const card = (section, dir, cls) => [
        `  <a class="hub-next-card${cls}" href="${esc(section.href)}">`,
        `    <span class="hub-next-dir">${dir}</span>`,
        `    <span class="hub-next-name">${esc(section.label)}</span>`,
        `    <span class="hub-next-note">${esc(section.note)}</span>`,
        `  </a>`,
    ].join('\n');
    return [
        `<aside class="hub-next" aria-label="Other sections">`,
        card(prev, '&larr; Previous', ''),
        card(next, 'Next &rarr;', ' is-next'),
        `</aside>`,
    ].join('\n');
}

/** The shared site footer. Identical to simulations.html's. */
function renderFooter() {
    return `<footer id="site-footer" role="contentinfo">
  <div class="footer-inner">
    <div class="footer-grid">

      <div class="footer-brand">
        <img src="ParkersPhysics_logo2.jpg" alt="Parkers Physics logo" class="footer-brand-logo">
        <p class="footer-brand-name">Parkers Physics</p>
        <p class="footer-tagline">Watch space weather happen. Live.</p>
        <p class="footer-attribution">&copy; 2026 Parkers Physics.<br>All rights reserved.</p>
      </div>

      <nav aria-label="Sections">
        <p class="footer-col-title">Sections</p>
        <div class="footer-links">
${SITE_SECTIONS.map(section =>
        `          <a href="${esc(section.href)}">${esc(section.label)}</a>`).join('\n')}
          <a href="simulations.html">All ${SIM_COUNT} Simulations</a>
        </div>
      </nav>

      <nav aria-label="Product">
        <p class="footer-col-title">Product</p>
        <div class="footer-links">
          <a href="pricing.html">Pricing</a>
          <a href="dashboard.html">Dashboard</a>
          <a href="for-operators.html">For Agencies &amp; Operators</a>
          <a href="signin.html">Sign In</a>
          <a href="signup.html">Create Account</a>
          <a href="feedback.html">Feedback &amp; Devlog</a>
        </div>
      </nav>

      <nav aria-label="Legal &amp; Sources">
        <p class="footer-col-title">Legal</p>
        <div class="footer-links">
          <a href="privacy.html">Privacy Policy</a>
          <a href="eula.html">Terms of Service</a>
        </div>
        <p class="footer-col-title" style="margin-top:1.4rem">Data Sources</p>
        <div class="footer-links">
          <a href="https://www.swpc.noaa.gov/" target="_blank" rel="noopener">NOAA SWPC</a>
          <a href="https://ssd.jpl.nasa.gov/horizons/" target="_blank" rel="noopener">NASA JPL Horizons</a>
          <a href="https://api.nasa.gov/" target="_blank" rel="noopener">NASA DONKI</a>
        </div>
      </nav>

    </div>
  </div>
</footer>`;
}

/**
 * The complete HTML for one section hub.
 *
 * Exported so tests/section-pages.mjs can compare against the committed file
 * without shelling out.
 */
export function renderSectionPage(sectionId) {
    const page = sectionPage(sectionId);
    if (!page) throw new Error(`build-section-pages: unknown section "${sectionId}"`);
    const { section, groups, count } = page;

    const title = `${section.label} — Parkers Physics`;
    const url = `${ORIGIN}/${section.href}`;
    const image = `${ORIGIN}/static/og/${section.href.replace(/\.html$/, '')}.jpg`;
    const description = `${section.intro} ${plural(count, 'simulation')}, free to open.`;
    const short = `${section.headline} — ${plural(count, 'simulation')}, free to open.`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">
<link rel="manifest" href="/manifest.json">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${esc(title)}</title>
<link rel="canonical" href="${esc(url)}">
<!--
  GENERATED FILE — do not edit by hand.

    node scripts/build-section-pages.mjs           # rewrite every hub page
    node scripts/build-section-pages.mjs --check   # CI staleness check

  Content comes from js/site-sections.js (the section) and
  js/simulations-catalog.js (the cards). Layout comes from the builder;
  styling from js/catalog-styles.css. Edits here are reverted by the next run.
-->
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#03010e">
<meta property="og:site_name" content="Parkers Physics">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(short)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(short)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;800;900&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="js/nav-styles.css">
<link rel="stylesheet" href="js/catalog-styles.css">
</head>
<body>

<a class="skip-link" href="#main-content">Skip to main content</a>

<nav aria-label="Primary navigation"></nav>
<script type="module">import { initNav } from "./js/nav.js?${NAV_VERSION}"; initNav("${esc(section.id)}");</script>

<main id="main-content">

<header class="sim-hero">
  <p class="sim-hero-label">${esc(section.tagline)}</p>
  <h1>${esc(section.headline)}</h1>
  <p class="sim-hero-sub">${esc(section.intro)}</p>
  <p class="hub-count">${esc(plural(count, 'simulation'))} in this section &middot; <a href="simulations.html">all ${SIM_COUNT} &rarr;</a></p>
</header>

${renderSwitch(section)}

${groups.map(renderGroup).join('\n\n')}

${renderNeighbours(section)}

</main>

<!-- ── FOOTER ─────────────────────────────────────────────────────────────── -->
${renderFooter()}

</body>
</html>
`;
}

/** Every hub page as `{ href, html }`, in nav order. */
export function renderAllSectionPages() {
    return SITE_SECTIONS.map(section => ({
        id: section.id,
        href: section.href,
        html: renderSectionPage(section.id),
    }));
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
    const args = process.argv.slice(2);
    const check = args.includes('--check');
    const only = (args.find(arg => arg.startsWith('--only=')) || '').replace('--only=', '')
        .split(',').filter(Boolean);

    const pages = renderAllSectionPages()
        .filter(page => !only.length || only.includes(page.id));

    if (!pages.length) {
        console.error(`❌ --only matched no section (have: ${SITE_SECTIONS.map(s => s.id).join(', ')})`);
        process.exit(1);
    }

    const stale = [];
    let written = 0;
    for (const page of pages) {
        const path = join(ROOT, page.href);
        const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
        if (current === page.html) continue;
        if (check) { stale.push(page.href); continue; }
        writeFileSync(path, page.html);
        written++;
    }

    if (check) {
        if (stale.length) {
            console.error(`❌ stale section hubs — run \`node scripts/build-section-pages.mjs\`:`);
            for (const href of stale) console.error(`   - ${href}`);
            process.exit(1);
        }
        console.log(`✅ ${pages.length} section hub(s) in sync with js/site-sections.js.`);
    } else if (!written) {
        console.log(`${pages.length} section hub(s) already up to date.`);
    } else {
        console.log(`✅ wrote ${written} of ${pages.length} section hub(s):`);
        for (const page of pages) console.log(`   - ${page.href}  (${sectionPage(page.id).count} simulations)`);
    }
}
