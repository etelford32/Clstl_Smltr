#!/usr/bin/env node
/**
 * bootes-void-page.mjs — the DOM contract between bootes-void.html and
 * js/bootes/page.js.
 *
 * Run: node tests/bootes-void-page.mjs
 *
 * WHY THIS EXISTS. The page's readouts are wired by `data-bv="<key>"`, which is
 * a string contract with no compiler behind it. Two things go wrong with that,
 * both SILENTLY:
 *
 *   1. A key in the markup that nothing writes stays on its placeholder em-dash
 *      forever, and an em-dash looks exactly like "this quantity is not
 *      available right now" rather than "this is broken".
 *   2. A key written by the module with no element to receive it is a number
 *      that was computed, formatted and thrown away.
 *
 * Neither throws. Neither shows up in a console. So this gate diffs the two key
 * sets in both directions, statically — no browser needed, which means it runs
 * in the same `node tests/*.mjs` sweep as the kernels.
 *
 * It also pins the structural things a browser test would be a heavy way to
 * check: that every control declared in the markup is one the module handles,
 * that every chart canvas has a drawing call behind it, and — the one that
 * actually bit — that any element toggled with `hidden` AND given an explicit
 * `display` carries its own `[hidden]` rule. An author `display` beats the UA
 * sheet's `[hidden]{display:none}`, so the WebGL fallback message rendered
 * straight through a working canvas. That is the same failure the Mars feature
 * list hit (CLAUDE.md §Exploring Mars); it is apparently easy to make twice.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const html = read('../bootes-void.html');
const page = read('../js/bootes/page.js');
const charts = read('../js/bootes/charts.js');

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const uniq = (a) => [...new Set(a)];
const matchAll = (src, re) => uniq([...src.matchAll(re)].map(m => m[1]));

// ── 1. Readout keys, both directions ────────────────────────────────────────
{
    const inMarkup = matchAll(html, /data-bv="([a-zA-Z0-9_]+)"/g);
    const written = matchAll(page, /\bset\('([a-zA-Z0-9_]+)'/g);

    const orphanMarkup = inMarkup.filter(k => !written.includes(k));
    assert.deepEqual(orphanMarkup, [],
        `markup declares data-bv keys that js/bootes/page.js never writes — these `
        + `would sit on their placeholder em-dash forever: ${orphanMarkup.join(', ')}`);

    const orphanWrites = written.filter(k => !inMarkup.includes(k));
    assert.deepEqual(orphanWrites, [],
        `js/bootes/page.js writes keys that appear nowhere in the markup — these `
        + `numbers are computed and discarded: ${orphanWrites.join(', ')}`);

    assert.ok(inMarkup.length > 40,
        `the page should surface a substantial set of readouts (found ${inMarkup.length})`);
    ok(`readout keys agree in both directions (${inMarkup.length} keys)`);
}

// ── 2. Keys used more than once must still update everywhere ────────────────
{
    // Several quantities appear twice on purpose — the mass deficit in the
    // headline strip and again in the compensation card, the velocity threshold
    // three times. `outputs` therefore has to be key → LIST. A Map of
    // key → element keeps only the last, which is precisely what shipped first
    // and left three headline figures frozen on their em-dash.
    const counts = new Map();
    for (const m of html.matchAll(/data-bv="([a-zA-Z0-9_]+)"/g)) {
        counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
    const duplicated = [...counts].filter(([, n]) => n > 1).map(([k]) => k);
    assert.ok(duplicated.length > 0,
        'this page deliberately repeats some readouts; if none are repeated the '
        + 'check below has stopped testing anything');
    assert.ok(/outputs\.get\(key\)\.push\(el\)/.test(page),
        'page.js must collect data-bv elements into a LIST per key — a Map of '
        + `key→element silently drops the duplicates (${duplicated.join(', ')})`);
    assert.ok(/for \(const el of els\) el\.textContent = value/.test(page),
        'and must write every element for a key, not just the first');
    ok(`duplicated readouts are handled (${duplicated.length} keys appear more than once)`);
}

// ── 3. Controls ─────────────────────────────────────────────────────────────
{
    const declared = matchAll(html, /data-bv-control="([a-zA-Z0-9_:]+)"/g);
    assert.ok(declared.length >= 8, `expected a real control set (found ${declared.length})`);
    for (const key of declared) {
        if (key.startsWith('layer:')) {
            assert.ok(/key\.startsWith\('layer:'\)/.test(page),
                'layer toggles need the layer: branch in page.js');
            continue;
        }
        assert.ok(new RegExp(`key === '${key}'`).test(page),
            `control "${key}" is declared in the markup but page.js has no branch for it`);
    }
    // And every branch in page.js corresponds to a control that exists.
    const handled = matchAll(page, /key === '([a-zA-Z0-9_]+)'/g);
    for (const key of handled) {
        assert.ok(declared.includes(key),
            `page.js handles a control "${key}" that the markup never declares`);
    }
    ok(`controls agree in both directions (${declared.length} controls)`);
}

// ── 4. Charts ───────────────────────────────────────────────────────────────
{
    const canvases = matchAll(html, /data-bv-chart="([a-zA-Z0-9_]+)"/g);
    assert.ok(canvases.length >= 7, `expected the full figure set (found ${canvases.length})`);
    for (const key of canvases) {
        assert.ok(new RegExp(`c\\('${key}'\\)`).test(page),
            `canvas "${key}" is in the markup but page.js never draws into it`);
    }
    const drawn = matchAll(page, /if \(c\('([a-zA-Z0-9_]+)'\)\)/g);
    for (const key of drawn) {
        assert.ok(canvases.includes(key),
            `page.js draws chart "${key}" but no canvas declares it`);
    }
    // Every exported draw function is actually used.
    for (const fn of matchAll(charts, /^export function (draw[A-Za-z]+)/gm)) {
        assert.ok(page.includes(fn), `charts.js exports ${fn} but page.js never calls it`);
    }
    ok(`charts agree in both directions (${canvases.length} figures)`);
}

// ── 5. The [hidden] specificity trap ────────────────────────────────────────
{
    const toggled = uniq([...html.matchAll(/id="(bv-[a-z-]+)"[^>]*\shidden/g)].map(m => m[1]));
    assert.ok(toggled.length > 0, 'the page has elements that boot hidden');
    for (const id of toggled) {
        // Only ids that are GIVEN a display need the guard; check anyway, since
        // adding a display later is exactly how the bug comes back.
        assert.ok(new RegExp(`#${id}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`).test(html),
            `#${id} is toggled with the hidden attribute but has no `
            + `#${id}[hidden]{display:none} rule. An author display: beats the UA `
            + `sheet's [hidden]{display:none} and the element stays visible — the `
            + `WebGL fallback shipped that way, over a working canvas.`);
    }
    ok(`every hidden-toggled element carries its own [hidden] rule (${toggled.length})`);
}

// ── 6. The provenance disclosure is not optional ────────────────────────────
{
    // These modules are synthetic and the page's whole standing depends on
    // saying so where the render is, not only in a footnote. This is the one
    // assertion here about CONTENT rather than wiring, and it is deliberate.
    // Whitespace-collapsed: the banner's sentences wrap across source lines,
    // and a regex that assumes single spaces fails on the indentation rather
    // than on the content — which would make this gate look like a real
    // disclosure failure every time somebody reflowed a paragraph.
    const flat = html.replace(/\s+/g, ' ');
    assert.ok(/class="bv-provenance"/.test(html), 'the provenance banner must exist');
    assert.ok(/Everything else on this page is a model/i.test(flat),
        'the provenance banner must state that everything past the measured '
        + 'inputs is a model');
    assert.ok(/seeded synthetic realisation/i.test(flat),
        'and must name the web as a seeded synthetic realisation');
    assert.ok(/No number here is a detection/i.test(flat),
        'and must state that nothing on the page is a detection');
    assert.ok(!/dismiss|data-dismiss|bv-close/i.test(flat.split('class="bv-provenance"')[1]?.slice(0, 1200) || ''),
        'the provenance banner must not be dismissible');
    ok('the provenance disclosure is present, specific and permanent');
}

// ── 7. No stray physics in the view layer ───────────────────────────────────
{
    const scene = read('../js/bootes/scene.js');
    // Match IMPORT STATEMENTS, not mentions. Both files name the kernels in
    // their headers to say what they deliberately do not do, and a naive
    // substring search fails on the very comment that documents the rule.
    const imports = (src) => [...src.matchAll(/^\s*import[\s\S]*?from\s+['"]([^'"]+)['"]/gm)]
        .map(m => m[1]);
    for (const [file, src] of [['scene.js', scene], ['charts.js', charts]]) {
        for (const spec of imports(src)) {
            assert.ok(!/bootes-(void|web)-model/.test(spec),
                `js/bootes/${file} must not import a physics kernel (found "${spec}") — `
                + 'it renders already-computed arrays, so a wrong curve is a wrong call '
                + 'and never a second implementation quietly disagreeing with the first');
        }
    }
    assert.ok(imports(charts).length === 0, 'charts.js should import nothing at all');
    ok('the view layer imports no physics and charts.js imports no three.js');
}

console.log(`\n${passed} checks passed — bootes-void.html ↔ js/bootes/page.js`);
