#!/usr/bin/env node
/**
 * Structural gate for the homepage background carousel
 * (js/home-carousel-slides.js + assets/home/carousel/manifest.json).
 *
 * WHAT THIS CATCHES
 * ─────────────────
 * The carousel joins a JS registry to a generated manifest at runtime and
 * SKIPS anything that doesn't line up — a slide whose page was renamed, a
 * manifest entry whose file was deleted, a capture recipe pointing at a
 * page that no longer exists. Every one of those fails silently in the
 * browser (the slide just isn't there), so the gate makes them loud:
 *
 *   1. registry entries are well-formed, ids unique, hrefs + capture urls
 *      exist on disk
 *   2. the manifest (when present) references only registered ids and
 *      only files that exist; every captured slide has a poster and a date
 *   3. media stays inside the budget the module header promises — one
 *      slide's poster + clip must never exceed 1.5 MB, so a "quick" re-capture
 *      at 4K cannot quietly triple the hero's weight
 *   4. the experiment the page assigns is registered and RUNNING with the
 *      variant index.html branches on
 *
 * Run: node tests/home-carousel.mjs
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SLIDES, LIVE_SLIDE, CAPTURED_SLIDES, MANIFEST_URL, MEDIA_DIR } =
    await import(pathToFileURL(path.join(ROOT, 'js/home-carousel-slides.js')).href);
// experiments.js boots telemetry (window) on import, so read it as text.
const expSrc = readFileSync(path.join(ROOT, 'js/experiments.js'), 'utf8');

let failures = 0;
const fail = (msg) => { failures++; console.error('  ✗ ' + msg); };
const ok   = (msg) => console.log('  ✓ ' + msg);

// 1. registry
console.log('registry');
const ids = new Set();
for (const s of SLIDES) {
    if (!s.id || !/^[a-z0-9-]+$/.test(s.id)) fail(`bad id ${JSON.stringify(s.id)}`);
    if (ids.has(s.id)) fail(`duplicate id ${s.id}`); ids.add(s.id);
    for (const k of ['title', 'caption', 'href', 'accent']) if (!s[k]) fail(`${s.id}: missing ${k}`);
    if (s.href && !existsSync(path.join(ROOT, s.href.split('#')[0]))) fail(`${s.id}: href ${s.href} not on disk`);
    if (s.caption && !/[.!?]$/.test(s.caption.trim())) fail(`${s.id}: caption should end with a period`);
    if (s.live) continue;
    const c = s.capture;
    if (!c) { fail(`${s.id}: no capture recipe`); continue; }
    const page = c.url.replace(/^\//, '').split('?')[0];
    if (!existsSync(path.join(ROOT, page))) fail(`${s.id}: capture url ${c.url} not on disk`);
    if (!c.crop || !c.ready) fail(`${s.id}: capture needs crop + ready`);
    if (!Array.isArray(c.hide)) fail(`${s.id}: capture.hide must be an array`);
}
if (SLIDES[0] !== LIVE_SLIDE) fail('the live slide must come first');
if (CAPTURED_SLIDES.length !== 7) fail(`expected 7 captured slides, got ${CAPTURED_SLIDES.length}`);
if (!failures) ok(`${SLIDES.length} slides, hrefs and capture urls exist`);

// 2 + 3. manifest
console.log('manifest');
const mPath = path.join(ROOT, MANIFEST_URL);
if (!existsSync(mPath)) {
    console.log('  – no manifest (carousel will not mount; run scripts/capture-home-carousel.mjs)');
} else {
    const m = JSON.parse(readFileSync(mPath, 'utf8'));
    if (!Array.isArray(m.slides)) fail('manifest.slides is not an array');
    const BUDGET = 1.5 * 1024 * 1024;
    for (const e of m.slides || []) {
        if (!ids.has(e.id)) { fail(`manifest id ${e.id} is not registered`); continue; }
        if (!e.poster || !e.poster.startsWith(MEDIA_DIR)) fail(`${e.id}: poster must live under ${MEDIA_DIR}`);
        if (!e.capturedAt || Number.isNaN(Date.parse(e.capturedAt))) fail(`${e.id}: capturedAt missing/invalid`);
        let bytes = 0;
        for (const k of ['poster', 'clip']) {
            if (!e[k]) continue;
            const p = path.join(ROOT, e[k]);
            if (!existsSync(p)) { fail(`${e.id}: ${k} ${e[k]} not on disk`); continue; }
            bytes += statSync(p).size;
        }
        if (bytes > BUDGET) fail(`${e.id}: poster+clip is ${(bytes / 1048576).toFixed(2)} MB (> 1.5 MB budget)`);
    }
    const missing = CAPTURED_SLIDES.filter(s => !(m.slides || []).some(e => e.id === s.id)).map(s => s.id);
    if (missing.length) console.log(`  – not yet captured: ${missing.join(', ')}`);
    if (!failures) ok(`${(m.slides || []).length} manifest entries resolve to files within budget`);
}

// 4. experiment
console.log('experiment');
const expBlock = expSrc.match(/home_bg_carousel:\s*\{[\s\S]*?\n\s{4}\},/);
if (!expBlock) fail('EXPERIMENTS.home_bg_carousel is missing');
else {
    if (!/status:\s*'running'/.test(expBlock[0])) fail('home_bg_carousel is not running');
    if (!/id:\s*'carousel'/.test(expBlock[0])) fail('home_bg_carousel has no "carousel" variant');
}
const goalsBlock = expSrc.match(/EXPERIMENT_GOALS[\s\S]*?home_bg_carousel:\s*\[[\s\S]*?\]/);
if (!goalsBlock || !/landing_cta_click/.test(goalsBlock[0])) fail('no goals registered for home_bg_carousel');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
if (!/assign\('home_bg_carousel'\)\s*===\s*'carousel'/.test(html)) fail("index.html does not branch on assign('home_bg_carousel') === 'carousel'");
if (!/home-carousel\.js/.test(html)) fail('index.html does not import js/home-carousel.js');
if (!failures) ok('home_bg_carousel registered, running, wired in index.html');

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
