#!/usr/bin/env node
/**
 * build-og-cards.mjs — render a per-page Open Graph card for every public page.
 *
 * WHY
 * ---
 * Until now all 61 pages that declared og:image pointed at the same file:
 * ParkersPhysics_logo2.jpg, a 266 KB square logo. Shared into Slack, X,
 * LinkedIn or iMessage, every link off this site looked identical — no title,
 * no distinction between the Gannon hindcast and the pricing page. Five pages
 * were worse: they pointed at static/og/*.jpg, which does not exist in the
 * repo at all, so those previews rendered blank.
 *
 * Each page now gets a 1200x630 card carrying its own title, its own
 * description, its section, and its own glyph from js/glyphs.js — the same
 * icon the nav shows for that page — over the vector brand mark.
 *
 * WHERE THE CONTENT COMES FROM (no new source of truth)
 *   - which pages   → sitemap.xml. That file is already the generated,
 *                     reviewed list of public URLs; deriving from it means
 *                     there is no second EXCLUDE list to drift out of sync.
 *                     Run scripts/build-sitemap.mjs first if pages moved.
 *   - title / blurb → the page's own <title> and <meta name="description">
 *   - section       → the dropdown the page sits in, parsed out of js/nav.js
 *   - glyph         → that page's `icon:` in js/nav.js, rendered via glyph()
 *   - the mark      → icons/logo-mark.svg, inlined
 *
 * FONTS ARE BAKED IN — THIS MATTERS
 * The cards are raster output committed to the repo, so whatever font this
 * machine has at generation time is permanent until someone regenerates. The
 * stack below is pinned to Liberation Sans, which is present on this
 * environment and on the CI image. Regenerating on a machine WITHOUT it will
 * silently reflow every card (DejaVu Sans has wider metrics), producing a
 * 64-file diff that looks like noise. If that happens, install Liberation
 * fonts rather than accepting the diff. The site's real font (Space Grotesk /
 * Inter) is not available offline here, which is why the cards do not match
 * the site's headings exactly.
 *
 * Usage:
 *   node scripts/build-og-cards.mjs           # render cards + rewrite meta tags
 *   node scripts/build-og-cards.mjs --check   # CI: fail if any card is missing
 *   node scripts/build-og-cards.mjs --only=blog,gannon-superstorm
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';
import { glyph } from '../js/glyphs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://parkersphysics.com';
const OUT_DIR = join(ROOT, 'static/og');
const FONT_STACK = `'Liberation Sans', 'DejaVu Sans', system-ui, sans-serif`;

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').replace('--only=', '')
    .split(',').filter(Boolean);

/* ── page inventory, keyed by canonical ─────────────────────────────────── */
function trackedPages() {
    try {
        return execFileSync('git', ['ls-files', '-z', '*.html'], { cwd: ROOT, encoding: 'utf8' })
            .split('\0').filter(Boolean);
    } catch {
        return readdirSync(ROOT).filter((f) => f.endsWith('.html'));
    }
}

const sitemapUrls = new Set(
    [...readFileSync(join(ROOT, 'sitemap.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]),
);

/* Which file does a canonical URL actually name?
 *
 * More than one page can declare the same canonical — home-v2.html is an A/B
 * variant of the homepage and correctly points at "/" — so "canonical is in
 * the sitemap" is not by itself proof that THIS file is the page in question.
 * A variant must not get its own card: it would compete with the page it
 * defers to. Resolving the canonical back to its owning file lets every
 * variant share the canonical page's card, which is what the canonical tag
 * is already asserting. */
const REWRITES = new Map(
    (JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')).rewrites || [])
        .map((r) => [r.source, r.destination.replace(/^\//, '')]),
);
function ownerOf(canonUrl) {
    const path = canonUrl.slice(ORIGIN.length) || '/';
    if (path === '/') return 'index.html';
    if (path.endsWith('.html')) return path.replace(/^\//, '');
    return REWRITES.get(path) || null;
}

/* ── js/nav.js → href: { section, icon } ────────────────────────────────────
 * Parsed by indentation: a dropdown's own `label:` sits at 8 spaces, its items
 * at 12. Textual parsing (rather than importing nav.js) is deliberate — nav.js
 * has side-effect imports (telemetry, oauth-sentinel, explore-tour) that expect
 * a browser and would blow up under Node. tests/glyphs.mjs reads it the same
 * way. */
function navIndex() {
    const out = new Map();
    let section = null;
    for (const line of readFileSync(join(ROOT, 'js/nav.js'), 'utf8').split('\n')) {
        const dd = line.match(/^ {8}label: '([^']+)',\s*$/);
        if (dd) { section = dd[1]; continue; }
        const href = line.match(/^ {12}\{[^}]*href: '([^']+)'/);
        if (href) {
            const icon = line.match(/icon: '([^']+)'/);
            const file = href[1].replace(/^\//, '');
            if (!out.has(file)) out.set(file, { section, icon: icon ? icon[1] : null });
        }
    }
    return out;
}
const NAV = navIndex();

/* Sections for public pages the nav does not list. Anything unmatched falls
 * back to the wordmark alone, which is a fine card — not an error. */
const EXTRA_SECTION = {
    'index.html': 'Space Weather Forecasting',
    'for-operators.html': 'For Operators',
    'request-access.html': 'Request Access',
    'pricing.html': 'Pricing',
    'for-educators.html': 'For Educators',
    'signin.html': 'Sign In', 'signup.html': 'Get Started',
    'blog.html': 'Field Notes',
    'simulations.html': 'All Simulations',
    'contact-enterprise.html': 'Enterprise',
    'eula.html': 'Terms', 'privacy.html': 'Privacy', 'api-policy.html': 'API Policy',
    'rust.html': 'Rust / WASM', 'grs-lab.html': 'Simulators', 'satellite-game.html': 'Simulators',
    'abell85.html': 'Black Holes', 'holm15a.html': 'Black Holes', 'merger-twins.html': 'Black Holes',
};
/* Glyphs for public pages the nav does not list, so their cards are not bare. */
const EXTRA_ICON = {
    'index.html': 'space-weather', 'for-operators.html': 'satellite',
    'request-access.html': 'target', 'pricing.html': 'chart',
    'for-educators.html': 'notebook', 'blog.html': 'notebook',
    'simulations.html': 'solar-system', 'rust.html': 'engine',
    'grs-lab.html': 'fluid', 'satellite-game.html': 'satellite',
    'contact-enterprise.html': 'target',
    'abell85.html': 'galaxy', 'holm15a.html': 'black-hole-core', 'merger-twins.html': 'black-hole',
};

const decode = (s) => s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&middot;/g, '·');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Strip the site suffix — every variant in use: "· Parkers Physics",
 * "— Parkers Physics App", "| Parkers Physics", "- Parkers Physics". */
const cleanTitle = (t) => decode(t)
    .replace(/\s*[·—–|-]\s*Parkers\s+Physics(\s+App)?\s*$/i, '')
    .replace(/\s+/g, ' ').trim();

const slugFor = (file) => file.replace(/\.html$/, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();

/* ── collect ─────────────────────────────────────────────────────────────── */
const cards = [];
for (const file of trackedPages()) {
    if (file.includes('/')) continue;                       // root pages only
    const html = readFileSync(join(ROOT, file), 'utf8');
    const canon = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i);
    if (!canon || !sitemapUrls.has(canon[1].trim())) continue;   // not public
    const owner = ownerOf(canon[1].trim());
    if (!owner) continue;
    if (ONLY.length && !ONLY.includes(slugFor(owner))) continue;

    const titleM = html.match(/<title>([\s\S]*?)<\/title>/i);
    const descM = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
    const nav = NAV.get(file) || {};

    cards.push({
        file,
        owner,
        slug: slugFor(owner),   // variants share the canonical page's card
        url: canon[1].trim(),
        title: titleM ? cleanTitle(titleM[1]) : cleanTitle(file.replace('.html', '')),
        desc: descM ? decode(descM[1]).replace(/\s+/g, ' ').trim() : '',
        section: '',   // filled below
        icon: nav.icon || EXTRA_ICON[file] || null,
    });
    // An eyebrow that merely repeats the headline ("PRICING" above "Pricing")
    // is noise; drop it and let the title carry the card.
    const c = cards[cards.length - 1];
    const sect = nav.section || EXTRA_SECTION[file] || '';
    c.section = sect.toLowerCase() === c.title.toLowerCase() ? '' : sect;
}

if (!cards.length) {
    console.error('❌ no public pages found — is sitemap.xml stale? run scripts/build-sitemap.mjs');
    process.exit(1);
}

/* ── check mode ──────────────────────────────────────────────────────────── */
if (CHECK) {
    const missing = cards.filter((c) => !existsSync(join(OUT_DIR, `${c.slug}.jpg`)));
    const unwired = cards.filter((c) => {
        const html = readFileSync(join(ROOT, c.file), 'utf8');
        return !html.includes(`/static/og/${c.slug}.jpg`);
    });
    if (missing.length || unwired.length) {
        console.error('\n❌ og-cards out of date — run: node scripts/build-og-cards.mjs');
        for (const c of missing) console.error(`  ✗ missing card: static/og/${c.slug}.jpg`);
        for (const c of unwired) console.error(`  ✗ ${c.file} does not reference its card`);
        process.exit(1);
    }
    console.log(`✅ og-cards — ${cards.length} pages, all cards present and wired`);
    process.exit(0);
}

/* ── card template ───────────────────────────────────────────────────────── */
const MARK = readFileSync(join(ROOT, 'icons/logo-mark.svg'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<\?xml[^>]*\?>/, '').trim();

function cardHtml(c) {
    // Long titles need to shrink or they overflow three lines at 630px tall.
    const n = c.title.length;
    const titleSize = n > 78 ? 46 : n > 52 ? 56 : n > 32 ? 66 : 76;
    const watermark = c.icon ? glyph(c.icon, { size: 300 }) : '';
    return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:1200px;height:630px;background:#070b18;font-family:${FONT_STACK};
       color:#e9eefb;overflow:hidden;position:relative}
  /* brand wash: cyan from the top-left, amber from the bottom-right — the
     mark's own two-tone split, at glow strength */
  .wash{position:absolute;inset:0;
        background:radial-gradient(760px 460px at 6% -8%, rgba(34,184,255,.20), transparent 70%),
                   radial-gradient(680px 420px at 104% 112%, rgba(255,138,31,.16), transparent 70%)}
  .grid{position:absolute;inset:0;opacity:.055;
        background-image:linear-gradient(rgba(255,255,255,.7) 1px,transparent 1px),
                         linear-gradient(90deg,rgba(255,255,255,.7) 1px,transparent 1px);
        background-size:60px 60px}
  .mark{position:absolute;right:74px;top:50%;transform:translateY(-50%);
        color:#7fb2e8;opacity:.13}
  .inner{position:relative;height:100%;padding:64px 72px;display:flex;flex-direction:column}
  .brand{display:flex;align-items:center;gap:14px}
  .brand svg{width:44px;height:44px;display:block}
  .brand .wm{font-size:20px;font-weight:700;letter-spacing:.20em;color:#f2f6ff}
  .section{margin-top:auto;font-size:19px;font-weight:700;letter-spacing:.18em;
           text-transform:uppercase;color:#3fc8ff}
  h1{margin-top:16px;font-size:${titleSize}px;line-height:1.1;font-weight:700;
     letter-spacing:-.015em;max-width:${c.icon ? '830px' : '1010px'};
     display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  p{margin-top:20px;font-size:24px;line-height:1.42;color:#9db0cc;
    max-width:${c.icon ? '790px' : '990px'};
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .foot{margin-top:30px;padding-top:22px;display:flex;align-items:center;
        justify-content:space-between;font-size:19px;color:#7f93b4;
        border-top:1px solid rgba(150,180,220,.18)}
  .rule{position:absolute;left:0;right:0;bottom:0;height:6px;
        background:linear-gradient(90deg,#22b8ff,#7a8cf0 46%,#ff8a1f)}
</style></head><body>
  <div class="wash"></div><div class="grid"></div>
  <div class="mark">${watermark}</div>
  <div class="inner">
    <div class="brand">${MARK}<span class="wm">PARKERS PHYSICS</span></div>
    ${c.section ? `<div class="section">${esc(c.section)}</div>` : '<div class="section"></div>'}
    <h1>${esc(c.title)}</h1>
    ${c.desc ? `<p>${esc(c.desc)}</p>` : ''}
    <div class="foot"><span>parkersphysics.com</span><span>Physics-first space weather</span></div>
  </div>
  <div class="rule"></div>
</body></html>`;
}

/* ── render ──────────────────────────────────────────────────────────────── */
mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
let n = 0;
const seen = new Set();
for (const c of cards) {
    if (seen.has(c.slug)) continue;   // a variant reuses the owner's card
    seen.add(c.slug);
    await page.setContent(cardHtml(c), { waitUntil: 'load' });
    // JPEG q86, not PNG: visually indistinguishable for this flat artwork
    // (checked side by side) at 70 KB vs 147 KB. Across ~64 cards that is
    // ~4.5 MB of repo weight saved, and .jpg is what these pages referenced
    // before the paths went stale.
    await page.screenshot({ path: join(OUT_DIR, `${c.slug}.jpg`), type: 'jpeg', quality: 86 });
    n++;
    if (n % 10 === 0) console.log(`  … ${n}/${cards.length}`);
}
await browser.close();

/* ── rewrite the meta tags ───────────────────────────────────────────────── */
let wired = 0;
for (const c of cards) {
    const p = join(ROOT, c.file);
    let html = readFileSync(p, 'utf8');
    const img = `${ORIGIN}/static/og/${c.slug}.jpg`;
    const before = html;

    if (/property="og:image"/.test(html)) {
        html = html.replace(/(<meta\s+property="og:image"\s+content=")[^"]*(")/i, `$1${img}$2`);
    } else if (/<meta\s+property="og:type"/.test(html)) {
        html = html.replace(/(<meta\s+property="og:type"[^>]*>)/i, `$1\n<meta property="og:image" content="${img}">`);
    } else {
        html = html.replace(/(<\/title>)/i, `$1\n<meta property="og:image" content="${img}">`);
    }
    if (/name="twitter:image"/.test(html)) {
        html = html.replace(/(<meta\s+name="twitter:image"\s+content=")[^"]*(")/i, `$1${img}$2`);
    } else {
        html = html.replace(/(<meta property="og:image" content="[^"]*">)/i,
            `$1\n<meta name="twitter:image" content="${img}">`);
    }
    // Dimensions let a scraper lay the card out before it has fetched the
    // image; without them some clients render a small square thumbnail on
    // first paint instead of the wide card.
    if (!/property="og:image:width"/.test(html)) {
        html = html.replace(/(<meta property="og:image" content="[^"]*">)/i,
            `$1\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">`);
    }
    if (!/name="twitter:card"/.test(html)) {
        html = html.replace(/(<meta property="og:image" content="[^"]*">)/i,
            `$1\n<meta name="twitter:card" content="summary_large_image">`);
    }
    if (html !== before) { writeFileSync(p, html); wired++; }
}

console.log(`✅ og-cards — rendered ${n} cards into static/og/, wired ${wired} page(s)`);
