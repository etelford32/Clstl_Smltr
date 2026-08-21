#!/usr/bin/env node
/**
 * Structural gate for js/simulations-catalog.js — the single source of truth
 * for "every simulation we ship".
 *
 * WHAT THIS CATCHES
 * ─────────────────
 * A simulation that ships without a catalog entry fails SILENTLY. The page
 * builds, the nav links to it, and the only symptom is that the site's index
 * quietly stops being an index. That is exactly what happened by 2026-08:
 * simulations.html advertised "46 simulations" while the repo shipped 55 —
 * Pollution Lab, Lunar Colony, Ring Current, Shielding Lab, Flux Rope,
 * Compounding Watch, CME Forecast and St. Patrick's Storm had all launched
 * and none of them were listed.
 *
 * So this gate makes the omission loud, in four directions:
 *
 *   1. every catalog entry is well-formed and its page exists on disk
 *   2. every root *.html is classified — a simulation, or explicitly listed
 *      in NON_SIMULATION_PAGES. A new page cannot be neither.
 *   3. every simulation js/nav.js links to is in the catalog (the nav is a
 *      curated subset; the catalog is the complete index, so nav ⊆ catalog)
 *   4. the committed simulations.html matches what the builder produces —
 *      i.e. somebody ran `node scripts/build-simulations-page.mjs`
 *
 * Root-only scan: per CLAUDE.md §8 every site page is a flat `*.html` at the
 * repo root. The handful of nested pages (rust/www origin artifacts, the
 * satellite-operator landing, dev harnesses under docs/ and js/geo/) are not
 * simulations and are out of scope here — scripts/lint-nav.mjs is what covers
 * nested pages.
 *
 * Run: node tests/simulations-catalog.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { GLYPH_IDS } from '../js/glyphs.js';
import {
    NON_SIMULATION_PAGES,
    SIMULATIONS,
    SIM_CATEGORIES,
    SIM_COUNT,
    catalogSections,
    simulationsByCategory,
} from '../js/simulations-catalog.js';
import { applyRegions } from '../scripts/build-simulations-page.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'simulations.html');
const glyphIds = new Set(GLYPH_IDS);
const categoryIds = new Set(SIM_CATEGORIES.map(category => category.id));
const VALID_TIERS = new Set(['public', 'free']);
const VALID_BADGES = new Set(['NEW', 'PRO PREVIEW', 'IN DEV']);

let checks = 0;
const ok = (label, fn) => { fn(); checks++; void label; };

// ── 1. Categories are well-formed ───────────────────────────────────────────
{
    const seen = new Set();
    for (const category of SIM_CATEGORIES) {
        const where = `category "${category.id}"`;
        ok(where, () => {
            assert.match(category.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${where}: id is kebab-case`);
            assert.ok(!seen.has(category.id), `${where}: duplicate id`);
            seen.add(category.id);
            assert.ok(category.label?.length, `${where}: needs a label`);
            assert.ok(category.note?.length, `${where}: needs a note`);
        });
    }
    // An empty category renders a heading over nothing. catalogSections()
    // drops those, so the drop would be silent — assert instead.
    for (const category of SIM_CATEGORIES) {
        ok(`${category.id} non-empty`, () => {
            assert.ok(simulationsByCategory(category.id).length > 0,
                `category "${category.id}" has no simulations — remove it or file one under it`);
        });
    }
}

// ── 2. Every entry is well-formed, and its page exists ──────────────────────
{
    const seenIds = new Set();
    const seenHrefs = new Set();
    for (const sim of SIMULATIONS) {
        const where = `sim "${sim.id ?? JSON.stringify(sim).slice(0, 50)}"`;
        ok(where, () => {
            assert.match(sim.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${where}: id is kebab-case`);
            assert.ok(!seenIds.has(sim.id), `${where}: duplicate id`);
            seenIds.add(sim.id);

            assert.match(sim.href, /^[a-z0-9-]+\.html$/, `${where}: href is a flat root page`);
            assert.ok(!seenHrefs.has(sim.href), `${where}: duplicate href ${sim.href}`);
            seenHrefs.add(sim.href);
            assert.ok(existsSync(join(ROOT, sim.href)), `${where}: ${sim.href} does not exist on disk`);
            assert.equal(sim.href, `${sim.id}.html`,
                `${where}: id must match the page basename (keeps nav ids, telemetry and the catalog on one key)`);

            assert.ok(sim.title?.length, `${where}: needs a title`);
            assert.ok(sim.blurb?.length, `${where}: needs a blurb`);
            // The blurb is the ONLY body copy on a card. A truncated or
            // placeholder line is the failure mode worth catching.
            assert.ok(sim.blurb.length >= 24, `${where}: blurb is too short to describe anything`);
            assert.ok(sim.blurb.length <= 110, `${where}: blurb is ${sim.blurb.length} chars — cards clip past ~110`);
            assert.match(sim.blurb, /[.?!]$/, `${where}: blurb should end in a period`);

            assert.ok(categoryIds.has(sim.category),
                `${where}: category "${sim.category}" is not in SIM_CATEGORIES — the card would render nowhere`);
            assert.ok(VALID_TIERS.has(sim.tier), `${where}: tier must be 'public' or 'free'`);
            assert.ok(glyphIds.has(sim.icon),
                `${where}: icon "${sim.icon}" is not a glyph id — it would render as raw text`);
            if (sim.badge !== undefined) {
                assert.ok(VALID_BADGES.has(sim.badge), `${where}: unknown badge "${sim.badge}"`);
            }
        });
    }
    ok('count', () => assert.equal(SIM_COUNT, SIMULATIONS.length));
}

// ── 3. Every root *.html is classified ──────────────────────────────────────
{
    const rootPages = readdirSync(ROOT).filter(name => name.endsWith('.html'));
    const catalogued = new Set(SIMULATIONS.map(sim => sim.href));

    const unclassified = rootPages
        .filter(page => !catalogued.has(page) && !NON_SIMULATION_PAGES.has(page));
    ok('classified', () => assert.deepEqual(unclassified, [],
        `these root pages are neither in the catalog nor in NON_SIMULATION_PAGES:\n`
        + unclassified.map(p => `  - ${p}`).join('\n')
        + `\nAdd each to js/simulations-catalog.js — as a SIMULATIONS entry if it is a`
        + `\nsimulation, or to NON_SIMULATION_PAGES if it is not.`));

    // A page listed as "not a simulation" that no longer exists is dead
    // weight that hides the next real omission behind stale noise.
    const stalePages = [...NON_SIMULATION_PAGES].filter(page => !existsSync(join(ROOT, page)));
    ok('no stale exclusions', () => assert.deepEqual(stalePages, [],
        `NON_SIMULATION_PAGES lists pages that no longer exist: ${stalePages.join(', ')}`));

    const doubleListed = [...NON_SIMULATION_PAGES].filter(page => catalogued.has(page));
    ok('no double listing', () => assert.deepEqual(doubleListed, [],
        `these pages are in BOTH the catalog and NON_SIMULATION_PAGES: ${doubleListed.join(', ')}`));
}

// ── 4. nav ⊆ catalog ────────────────────────────────────────────────────────
// The nav is a curated menu and the catalog is the complete index, so the
// catalog may hold pages the nav omits (the arcade game, the older black-hole
// labs, the WASM proving ground) but never the reverse. A page promoted into
// the nav and forgotten here is the exact drift this file exists to stop.
{
    const navSource = readFileSync(join(ROOT, 'js', 'nav.js'), 'utf8');
    const navHrefs = new Set(
        [...navSource.matchAll(/href:\s*'([a-z0-9-]+\.html)'/g)].map(match => match[1]));
    const catalogued = new Set(SIMULATIONS.map(sim => sim.href));

    const missing = [...navHrefs]
        .filter(href => !catalogued.has(href) && !NON_SIMULATION_PAGES.has(href))
        .sort();
    ok('nav subset', () => assert.deepEqual(missing, [],
        `js/nav.js links to pages that the catalog does not list: ${missing.join(', ')}`));
}

// ── 5. simulations.html is in sync with the builder ─────────────────────────
{
    const committed = readFileSync(PAGE, 'utf8');
    ok('page fresh', () => assert.equal(applyRegions(committed), committed,
        'simulations.html is stale — run `node scripts/build-simulations-page.mjs`'));

    // Belt and braces: assert the rendered page actually links every entry.
    // applyRegions() comparing equal only proves the file matches the
    // generator; this proves the generator emitted what we think it did.
    const missingLinks = SIMULATIONS
        .filter(sim => !committed.includes(`href="${sim.href}"`))
        .map(sim => sim.href);
    ok('all links present', () => assert.deepEqual(missingLinks, [],
        `simulations.html does not link: ${missingLinks.join(', ')}`));

    const cardCount = (committed.match(/class="sim-card"/g) || []).length;
    ok('card count', () => assert.equal(cardCount, SIM_COUNT,
        `simulations.html renders ${cardCount} cards for ${SIM_COUNT} simulations`));

    // The headline quotes the count. It has been wrong before.
    ok('headline count', () => assert.ok(
        committed.includes(`<h1>${SIM_COUNT} simulations. One engine.</h1>`),
        `simulations.html headline does not say "${SIM_COUNT} simulations"`));

    // Sentinels must survive; without them the builder cannot splice and the
    // page silently freezes at whatever it last contained.
    for (const sentinel of ['SIM-CATALOG:HEAD:BEGIN', 'SIM-CATALOG:HEAD:END',
        'SIM-CATALOG:MAIN:BEGIN', 'SIM-CATALOG:MAIN:END']) {
        ok(sentinel, () => assert.ok(committed.includes(`<!-- ${sentinel} -->`),
            `simulations.html lost the ${sentinel} sentinel`));
    }
}

// ── 6. The nav reaches the catalog ──────────────────────────────────────────
// The catalog is only useful if it is reachable from the menu. This pins the
// top-level "Simulations" nav item so a nav refactor cannot orphan the page.
{
    const navSource = readFileSync(join(ROOT, 'js', 'nav.js'), 'utf8');
    ok('nav links catalog', () => assert.ok(
        /href="\/simulations\.html"/.test(navSource),
        'js/nav.js no longer links to /simulations.html — the catalog is orphaned from the menu'));
}

console.log(`✅ simulations-catalog: ${checks} checks passed `
    + `— ${SIM_COUNT} simulations across ${catalogSections().length} categories.`);
