/**
 * tests/glyphs.mjs — drift gate for the Parkers Physics icon set.
 *
 * Run: node tests/glyphs.mjs
 *
 * The gate that matters is #1. navIcon() in js/nav.js deliberately falls back
 * to rendering the raw value when an icon id is not a known glyph, so a typo
 * ('sattelite') does not throw — it quietly prints the literal string into the
 * menu. That fallback is worth having (it made the emoji migration
 * non-breaking) but it is exactly the kind of soft failure nobody notices in
 * review. This test is what makes it hard.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GLYPHS, GLYPH_IDS, glyph } from '../js/glyphs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = [];
const check = (cond, msg) => { if (!cond) fail.push(msg); };

/* ── 1. Every icon id referenced by nav.js must exist ─────────────────── */
const navSrc = readFileSync(join(ROOT, 'js/nav.js'), 'utf8');
const referenced = [...navSrc.matchAll(/icon:\s*'([^']+)'/g)].map((m) => m[1]);

check(referenced.length > 0, 'nav.js: no icon: entries found — did the key get renamed?');
for (const id of new Set(referenced)) {
    check(id in GLYPHS,
        `nav.js references icon '${id}' which is not in GLYPHS — it would render as the literal text '${id}' in the menu`);
}

/* ── 2. No emoji left behind ──────────────────────────────────────────────
 * The whole point of the set is that the nav renders identically on every
 * platform. One stray emoji re-introduces the font dependency. */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️]/u;
for (const id of new Set(referenced)) {
    check(!EMOJI.test(id), `nav.js still uses an emoji icon (${id}) — add a glyph for it in js/glyphs.js`);
}

/* ── 3. Every glyph is structurally sound ─────────────────────────────── */
for (const id of GLYPH_IDS) {
    const markup = GLYPHS[id];
    check(typeof markup === 'string' && markup.length > 0, `glyph '${id}' is empty`);
    // Inner markup only — glyph() owns the <svg> wrapper, viewBox and stroke
    // defaults. A glyph that supplies its own fights the system.
    check(!/<svg/i.test(markup), `glyph '${id}' contains its own <svg>; glyph() supplies the wrapper`);
    check(!/viewBox/i.test(markup), `glyph '${id}' sets viewBox; glyph() owns the 24x24 grid`);
    // Colour must come from currentColor so the hover ramp and theming work.
    const hard = markup.match(/(?:stroke|fill)="(#[0-9a-f]{3,8}|rgb[^"]*)"/i);
    check(!hard, `glyph '${id}' hard-codes a colour (${hard?.[1]}) — use currentColor`);
    // Balanced tags: every element opened is self-closed. Catches a truncated
    // path string, which otherwise renders as nothing at all.
    const opens = (markup.match(/<[a-z]/g) || []).length;
    const closes = (markup.match(/\/>/g) || []).length;
    check(opens === closes, `glyph '${id}' has ${opens} elements but ${closes} self-closing tags`);
}

/* ── 4. glyph() contract ──────────────────────────────────────────────── */
check(glyph('earth') !== null, 'glyph() returned null for a known id');
check(glyph('definitely-not-a-glyph') === null,
    'glyph() must return null (not throw, not a broken <svg>) for an unknown id — nav.js relies on that to fall back to text');
check(/width="34"/.test(glyph('earth', { size: 34 }) || ''), 'glyph() ignored the size option');
check(/class="pp-glyph extra"/.test(glyph('earth', { cls: 'extra' }) || ''), 'glyph() ignored the cls option');
check(/aria-hidden="true"/.test(glyph('earth') || ''),
    'glyphs must be aria-hidden — the link text is the accessible name, and an unlabelled icon would double-announce it');

/* ── 5. The brand SVGs must be well-formed XML and have intrinsic size ────
 * Both of these failed silently during authoring and are invisible in review:
 *
 *  - An XML comment may not contain a double hyphen. Documenting the CSS
 *    custom properties by their real names (two hyphens, then c-accent) makes
 *    the entire file unparseable, and the browser shows a broken <img> — with
 *    its alt text, so the nav read "Parkers Physics Parkers Physics".
 *  - An SVG with only a viewBox and no width/height reports naturalWidth 0
 *    when loaded as an <img>, so CSS `width:auto` collapses to the
 *    replaced-element default and the 30px logo lays out as a 150px box.
 *
 * Neither throws, neither shows up in a diff, and both break every page that
 * mounts the nav. */
for (const rel of ['icons/logo-mark.svg', 'icons/logo-wordmark.svg']) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    for (const c of src.match(/<!--[\s\S]*?-->/g) || []) {
        check(!c.slice(4, -3).includes('--'),
            `${rel}: an XML comment contains a double hyphen — the file will not parse and the image renders broken`);
    }
    check(/<svg[^>]*\swidth="[\d.]+"/.test(src) && /<svg[^>]*\sheight="[\d.]+"/.test(src),
        `${rel}: root <svg> needs explicit width and height, not just viewBox, or it has no intrinsic size as an <img>`);
    check(/<svg[^>]*\sviewBox="/.test(src), `${rel}: root <svg> is missing viewBox`);
}

/* ── 6. Unused glyphs are worth knowing about (warning, not failure) ───── */
const unused = GLYPH_IDS.filter((id) => !referenced.includes(id));
if (unused.length) console.warn(`  note: ${unused.length} glyph(s) defined but unused by nav.js: ${unused.join(', ')}`);

if (fail.length) {
    console.error(`\n❌ glyphs: ${fail.length} problem(s)`);
    for (const f of fail) console.error(`  ✗ ${f}`);
    process.exit(1);
}
console.log(`✅ glyphs — ${GLYPH_IDS.length} glyphs, ${new Set(referenced).size} referenced by nav.js, no emoji left`);
