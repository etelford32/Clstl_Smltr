#!/usr/bin/env node
/**
 * Structural gate for js/site-sections.js — the site's top-level architecture.
 *
 * Run: node tests/site-sections.mjs
 *
 * WHAT THIS CATCHES
 * ─────────────────
 * The top level is now shared by four things: the nav bar, the five generated
 * hub pages, simulations.html's sections, and the catalog's own category list.
 * They agree because they all read js/site-sections.js — but "they all read it"
 * only holds while every section actually HAS the parts each consumer needs. A
 * section with no hub page on disk, a group nothing files under, or a menu
 * that nav.js never defined all fail silently: the bar renders, the build
 * succeeds, and one route into the site is quietly dead.
 *
 * So this asserts, in six directions:
 *
 *   1. every section is well-formed and its hub page exists on disk
 *   2. every group is well-formed, and every simulation's `group` is really
 *      declared on the section its `category` names
 *   3. nav.js defines a menu for every section and no menus for anything else
 *   4. THE MENU CAP. Panels are absolutely positioned under a 50px bar with
 *      nothing to scroll them, so a menu taller than the viewport loses its
 *      tail — see the header of js/site-sections.js for the measurements from
 *      when this was live. A cheap link count here fails in milliseconds;
 *      tests/nav-responsive.spec.js measures the real rendered height.
 *   5. every hub page is in sync with scripts/build-section-pages.mjs
 *   6. nav.js links every hub, so no section is orphaned from the bar
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { GLYPH_IDS } from '../js/glyphs.js';
import { SITE_SECTIONS, SECTION_IDS, allGroups, sectionById } from '../js/site-sections.js';
import { SIMULATIONS, NON_SIMULATION_PAGES } from '../js/simulations-catalog.js';
import { renderSectionPage } from '../scripts/build-section-pages.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const glyphIds = new Set(GLYPH_IDS);
const navSource = readFileSync(join(ROOT, 'js', 'nav.js'), 'utf8');

let checks = 0;
const ok = (label, fn) => { fn(); checks++; void label; };

// Menus are capped so the panel fits a 768px-tall laptop. ~10 links and ~3
// headers lands under ~700px against a 50px bar. These are the numbers the
// editorial cap in js/site-sections.js states; keep them in step with it.
const MAX_LINKS_PER_MENU = 10;
const MAX_HEADERS_PER_MENU = 3;

// ── 1. Sections are well-formed ─────────────────────────────────────────────
{
    const seenIds = new Set();
    const seenHrefs = new Set();
    for (const section of SITE_SECTIONS) {
        const where = `section "${section.id}"`;
        ok(where, () => {
            assert.match(section.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${where}: id is kebab-case`);
            assert.ok(!seenIds.has(section.id), `${where}: duplicate id`);
            seenIds.add(section.id);

            assert.ok(section.label?.length, `${where}: needs a label`);
            assert.ok(section.label.length <= 16,
                `${where}: label "${section.label}" is ${section.label.length} chars — top-level labels are bar width, `
                + `and the ladder had +16px of headroom at 1281px`);

            assert.match(section.href, /^[a-z0-9-]+\.html$/, `${where}: href is a flat root page`);
            assert.ok(!seenHrefs.has(section.href), `${where}: duplicate href ${section.href}`);
            seenHrefs.add(section.href);
            assert.ok(existsSync(join(ROOT, section.href)),
                `${where}: hub page ${section.href} does not exist — run \`node scripts/build-section-pages.mjs\``);

            // A hub page is not a simulation, so the catalog's "every root
            // page is classified" gate needs it declared. Without this the
            // failure surfaces over in tests/simulations-catalog.mjs as a
            // mystery unclassified page.
            assert.ok(NON_SIMULATION_PAGES.has(section.href),
                `${where}: ${section.href} is missing from NON_SIMULATION_PAGES in js/simulations-catalog.js`);

            assert.ok(glyphIds.has(section.icon),
                `${where}: icon "${section.icon}" is not a glyph id`);
            for (const field of ['tagline', 'headline', 'intro', 'note']) {
                assert.ok(section[field]?.length, `${where}: needs ${field} (it is hub hero copy)`);
            }
            assert.ok(Array.isArray(section.groups) && section.groups.length > 0,
                `${where}: needs at least one group`);
        });
    }
}

// ── 2. Groups are well-formed, and every simulation names a real one ────────
{
    for (const { sectionId, group } of allGroups()) {
        const where = `group "${sectionId}/${group.id}"`;
        ok(where, () => {
            assert.match(group.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${where}: id is kebab-case`);
            assert.ok(group.label?.length, `${where}: needs a label`);
            assert.ok(group.note?.length, `${where}: needs a note (it is the hub sub-heading blurb)`);
        });
    }

    for (const section of SITE_SECTIONS) {
        const ids = [...section.groups, ...(section.extras || [])].map(group => group.id);
        ok(`${section.id} group ids unique`, () =>
            assert.equal(new Set(ids).size, ids.length,
                `section "${section.id}" has duplicate group/extra ids — they share an id space, `
                + `and both render as a section on the hub page`));
    }

    // `extras` are inline, hand-written entries the catalog's drift gate
    // cannot see. That is fine for essays and dangerous for anything else, so
    // every one of them has to be a page the catalog has explicitly classified
    // as NOT a simulation. Without this, `extras` becomes a way to put a
    // simulation on a hub while leaving it out of the index — the exact
    // failure js/simulations-catalog.js exists to prevent.
    for (const section of SITE_SECTIONS) {
        for (const extra of section.extras || []) {
            const where = `extra "${section.id}/${extra.id}"`;
            ok(where, () => {
                assert.match(extra.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${where}: id is kebab-case`);
                assert.ok(extra.label?.length, `${where}: needs a label`);
                assert.ok(extra.note?.length, `${where}: needs a note`);
                assert.ok(extra.links?.length, `${where}: has no links — drop it or fill it`);
                for (const link of extra.links) {
                    const at = `${where} → ${link.href}`;
                    assert.match(link.href, /^[a-z0-9-]+\.html$/, `${at}: href is a flat root page`);
                    assert.ok(existsSync(join(ROOT, link.href)), `${at}: does not exist on disk`);
                    assert.ok(NON_SIMULATION_PAGES.has(link.href),
                        `${at}: is not in NON_SIMULATION_PAGES. \`extras\` is for pages that are not `
                        + `simulations; if this one is, put it in SIMULATIONS so the catalog can see it.`);
                    assert.ok(link.title?.length, `${at}: needs a title`);
                    assert.ok(link.blurb?.length >= 24, `${at}: blurb is too short to describe anything`);
                    assert.ok(link.blurb.length <= 110, `${at}: blurb is ${link.blurb.length} chars — cards clip past ~110`);
                    assert.ok(glyphIds.has(link.icon), `${at}: icon "${link.icon}" is not a glyph id`);
                }
            });
        }
    }

    // The pair (category, group) has to resolve. A simulation whose group is
    // not declared on its section renders into no sub-section on the hub page
    // and simply vanishes from it — the card still exists on simulations.html,
    // so nothing looks broken.
    for (const sim of SIMULATIONS) {
        const where = `sim "${sim.id}"`;
        ok(where, () => {
            const section = sectionById(sim.category);
            assert.ok(section, `${where}: category "${sim.category}" is not a section id`);
            assert.ok(sim.group, `${where}: needs a group`);
            assert.ok(section.groups.some(group => group.id === sim.group),
                `${where}: group "${sim.group}" is not declared on section "${sim.category}" `
                + `(has: ${section.groups.map(g => g.id).join(', ')})`);
        });
    }
}

// ── 3+4. nav.js defines exactly one capped menu per section ─────────────────
{
    // NAV_ITEMS is a plain object literal keyed by section id. Parsing it
    // textually keeps this test in node — js/nav.js cannot be imported here,
    // it boots telemetry and touches document on import.
    const block = navSource.match(/const NAV_ITEMS = \{([\s\S]*?)\n\};/);
    ok('NAV_ITEMS found', () => assert.ok(block,
        'js/nav.js no longer declares `const NAV_ITEMS = { … };` — this gate cannot read the menus'));

    // Split on top-level keys: `'space-weather': [` or `research: [`.
    const body = block[1];
    const keyRe = /^ {4}'?([a-z0-9-]+)'?:\s*\[$/gm;
    const starts = [...body.matchAll(keyRe)].map(match => ({ id: match[1], at: match.index }));

    ok('menu per section', () => assert.deepEqual(
        starts.map(entry => entry.id).sort(), [...SECTION_IDS].sort(),
        'js/nav.js NAV_ITEMS keys do not match the section ids in js/site-sections.js'));

    for (let i = 0; i < starts.length; i++) {
        const slice = body.slice(starts[i].at, i + 1 < starts.length ? starts[i + 1].at : undefined);
        const links = (slice.match(/\{\s*href:/g) || []).length;
        const headers = (slice.match(/\{\s*section:/g) || []).length;
        const where = `menu "${starts[i].id}"`;

        ok(`${where} not empty`, () => assert.ok(links > 0, `${where}: has no links`));
        ok(`${where} within cap`, () => {
            assert.ok(links <= MAX_LINKS_PER_MENU,
                `${where}: ${links} links, cap is ${MAX_LINKS_PER_MENU}. A panel is absolutely positioned `
                + `under a 50px bar with nothing to scroll it, so a menu taller than the viewport loses its `
                + `tail — that shipped, and cost 7 links on a 1366×768 screen. Move the overflow onto the `
                + `section hub page (${sectionById(starts[i].id)?.href}) instead of lengthening the menu.`);
            assert.ok(headers <= MAX_HEADERS_PER_MENU,
                `${where}: ${headers} section headers, cap is ${MAX_HEADERS_PER_MENU}`);
        });
    }
}

// ── 4b. Nav badges match the catalog's ──────────────────────────────────────
// The same page is badged in two places: `js/nav.js` for the menu and
// `js/simulations-catalog.js` for the card on the hub page and the catalog.
// When they disagree the menu says a page is NEW and the hub it links to does
// not (or the reverse), which is the kind of half-truth nobody files a bug
// about. The catalog is the source of truth; the nav is checked against it.
{
    const navBadges = new Map();
    for (const line of navSource.split('\n')) {
        const href = line.match(/\{\s*href:\s*'([a-z0-9-]+\.html)'/)?.[1];
        if (!href) continue;
        navBadges.set(href, line.match(/badge:\s*'([^']+)'/)?.[1] ?? null);
    }
    const catalogBadges = new Map(SIMULATIONS.map(sim => [sim.href, sim.badge ?? null]));

    const mismatched = [...navBadges]
        .filter(([href]) => catalogBadges.has(href))
        .filter(([href, badge]) => badge !== catalogBadges.get(href))
        .map(([href, badge]) => `${href}: nav=${badge ?? 'none'} catalog=${catalogBadges.get(href) ?? 'none'}`);

    ok('nav badges match catalog', () => assert.deepEqual(mismatched, [],
        `js/nav.js and js/simulations-catalog.js disagree about these badges:\n`
        + mismatched.map(line => `  - ${line}`).join('\n')
        + `\nThe catalog is the source of truth — update the nav entry to match.`));
}

// ── 5. Hub pages are in sync with the builder ───────────────────────────────
{
    for (const section of SITE_SECTIONS) {
        const path = join(ROOT, section.href);
        if (!existsSync(path)) continue;   // already reported by check 1
        ok(`${section.href} fresh`, () => assert.equal(
            readFileSync(path, 'utf8'), renderSectionPage(section.id),
            `${section.href} is stale or hand-edited — run \`node scripts/build-section-pages.mjs\`. `
            + `That file is fully generated; edits to it do not survive.`));
    }
}

// ── 6. The nav reaches every hub ────────────────────────────────────────────
// A section whose label links nowhere is the state this whole restructure
// replaced. The bar builds its href from SITE_SECTIONS, so this pins the
// mechanism rather than each URL: break the template and every hub orphans.
{
    ok('nav links hubs', () => assert.ok(
        /href="\/\$\{dd\.href\}"/.test(navSource),
        'js/nav.js no longer renders the section hub href on the top-level label — '
        + 'the top-level items are back to being menu-only and every hub page is orphaned'));
}

console.log(`✅ site-sections: ${checks} checks passed — ${SITE_SECTIONS.length} sections, `
    + `${allGroups().length} groups, ${SIMULATIONS.length} simulations filed.`);
