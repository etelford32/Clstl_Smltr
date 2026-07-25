#!/usr/bin/env node
/**
 * build-sitemap.mjs — generate sitemap.xml from the pages themselves.
 *
 * WHY THIS EXISTS
 * ---------------
 * sitemap.xml was hand-maintained and had drifted badly by 2026-07:
 *   - 38 of 78 root pages were missing entirely, including gannon-superstorm,
 *     st-patrick-storm, flux-rope, shielding-lab, auroracle, far-side-watch,
 *     solar-system and every planetary-system page
 *   - 2 entries (/star3d.html, /threejs.html) were 301 redirect SOURCES,
 *     which Search Console reports as soft errors
 *   - URL form was mixed (24 with .html, 19 without) with no relationship to
 *     what the pages themselves declared as canonical
 *
 * The fix is to stop hand-writing it. Each page already declares its own
 * preferred URL in <link rel="canonical">; this script reads that and emits
 * exactly those URLs. A page is in the sitemap iff it has a canonical and is
 * not on the EXCLUDE list — there is no third source of truth.
 *
 * GUARDS (these are the point — each one caught a real live bug)
 *   1. canonical → extensionless URL with no matching vercel.json rewrite.
 *      This repo does NOT have clean-URL resolution; /foo only works if
 *      something rewrites it to /foo.html. Seven pages (request-access,
 *      gannon-superstorm, st-patrick-storm, far-side-watch, satellite-designer,
 *      spaceship-designer, satellite-game) were self-reporting a 404 as their
 *      preferred URL, which tells Google to drop the page.
 *   2. canonical is a redirect source in vercel.json.
 *   3. canonical path is Disallow-ed for User-agent:* in robots.txt —
 *      submitting a blocked URL is a Search Console error.
 *   4. page has no canonical and is not excluded.
 *   5. page lives in a subdirectory that .github/workflows/deploy.yml does
 *      not copy into build/web — it would 404 in production (warning only,
 *      since the deploy list is edited separately).
 *
 * <changefreq> and <priority> are deliberately NOT emitted. Google has
 * stated publicly it ignores both, and Bing says the same; the old file's
 * hand-tuned values were decoration. <lastmod> IS emitted (Google does use
 * it when it's honest) and comes from git, so it cannot drift from reality.
 *
 * Usage:
 *   node scripts/build-sitemap.mjs           # rewrite sitemap.xml
 *   node scripts/build-sitemap.mjs --check   # CI: exit 1 if stale
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://parkersphysics.com';
const OUT = join(ROOT, 'sitemap.xml');

/* ── Pages deliberately kept OUT of the sitemap ─────────────────────────
 * Signed-in surfaces, auth plumbing, internal tooling, and A/B variants.
 * A page here needs no canonical tag. Adding an entry is a decision —
 * write down why. */
const EXCLUDE = new Map([
  ['404.html',            'error page'],
  ['account.html',        'signed-in only'],
  ['admin.html',          'admin only — also robots-blocked'],
  ['superadmin.html',     'admin only'],
  ['dashboard.html',      'signed-in only — also robots-blocked'],
  ['settings.html',       'signed-in only'],
  ['welcome.html',        'post-signup interstitial'],
  ['auth-callback.html',  'OAuth plumbing'],
  ['reset-password.html', 'auth plumbing — also robots-blocked'],
  ['home-v2.html',        'A/B variant of index.html — duplicate content'],
  ['design-tokens.html',  'internal design-system reference'],
  ['status.html',         'ops surface, no search intent'],
  ['feedback.html',       'thin form page'],
  ['hydro-demo.html',     'WASM proving ground — dev harness'],
  ['satellite-operator/landing.html',
   'superseded draft. for-operators.html is the live operator page (linked from index, ' +
   'simulations, request-access); this one is linked from nowhere and deploy.yml never ' +
   'copied satellite-operator/ into build/web, so it has never existed in production. ' +
   'The /satellite-operator, /satellite-operators and /for-operators rewrites now point ' +
   'at for-operators.html. Kept on disk, out of the index.'],
]);

/* Directories deploy.yml copies into build/web. Anything else is not in
 * production. Keep in sync with the "Copy all static HTML/JS/CSS" step. */
const DEPLOYED_DIRS = new Set(['js', 'data', 'api', 'icons', 'static']);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'rust', 'swmf', 'dsmc', 'docs',
  'tests', 'scripts', 'tools', 'pipelines', 'supabase', 'crates', 'pi', 'js', 'data', 'api']);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = relative(ROOT, abs).split(sep).join('/');
    if (SKIP_DIRS.has(rel.split('/')[0])) continue;
    if (statSync(abs).isDirectory()) walk(abs, acc);
    else if (name.endsWith('.html')) acc.push(rel);
  }
  return acc;
}

/* ── vercel.json routing tables ─────────────────────────────────────── */
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
const REWRITES = new Map((vercel.rewrites || []).map((r) => [r.source, r.destination]));
const REDIRECTS = new Set((vercel.redirects || []).map((r) => r.source));

/* ── robots.txt User-agent:* Disallow prefixes ──────────────────────── */
function robotsDisallows() {
  const out = [];
  let inStar = false;
  for (const raw of readFileSync(join(ROOT, 'robots.txt'), 'utf8').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [k, ...rest] = line.split(':');
    const key = k.trim().toLowerCase();
    const val = rest.join(':').trim();
    if (key === 'user-agent') inStar = val === '*';
    else if (key === 'disallow' && inStar && val) out.push(val);
  }
  return out;
}
const DISALLOW = robotsDisallows();

/* ── lastmod: last commit that touched the file ─────────────────────── */
function lastmod(relPath) {
  try {
    const d = execFileSync('git', ['log', '-1', '--format=%cs', '--', relPath],
      { cwd: ROOT, encoding: 'utf8' }).trim();
    if (d) return d;
  } catch { /* not a git checkout, or file untracked */ }
  return new Date(statSync(join(ROOT, relPath)).mtime).toISOString().slice(0, 10);
}

/* ── collect ────────────────────────────────────────────────────────── */
const errors = [];
const warnings = [];
const entries = [];
const linkedAssets = new Set();

for (const page of walk(ROOT).sort()) {
  if (EXCLUDE.has(page)) continue;

  const html = readFileSync(join(ROOT, page), 'utf8');
  const m = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i);
  if (!m) {
    errors.push(`${page}: no <link rel="canonical"> — add one, or add the page to EXCLUDE in this script`);
    continue;
  }

  const url = m[1].trim();
  if (!url.startsWith(ORIGIN)) {
    errors.push(`${page}: canonical points off-origin (${url})`);
    continue;
  }
  const path = url.slice(ORIGIN.length) || '/';

  // Guard 1 — extensionless canonical needs a rewrite to resolve...
  if (path !== '/' && !path.endsWith('.html') && !REWRITES.has(path)) {
    errors.push(`${page}: canonical ${path} has no vercel.json rewrite — that URL 404s, so the page tells Google its preferred URL does not exist`);
    continue;
  }
  // ...and that rewrite must land back on THIS page. A canonical whose
  // rewrite serves a different file is worse than a missing one: it tells
  // Google two distinct pages are the same page, and the losing one is
  // dropped from the index.
  const dest = REWRITES.get(path);
  if (dest && dest.replace(/^\//, '') !== page) {
    errors.push(`${page}: canonical ${path} rewrites to ${dest}, a different page — one of the two is wrong`);
    continue;
  }
  // Guard 2 — canonical must not be a redirect source.
  if (REDIRECTS.has(path)) {
    errors.push(`${page}: canonical ${path} is a 301 redirect source — sitemap URLs must be the destination`);
    continue;
  }
  // Guard 3 — must not be robots-blocked.
  const blocked = DISALLOW.find((d) => path.startsWith(d));
  if (blocked) {
    errors.push(`${page}: canonical ${path} is Disallow-ed (${blocked}) in robots.txt — exclude the page instead`);
    continue;
  }
  // Guard 5 — subdirectory pages must be in the deploy copy list.
  const dir = page.includes('/') ? page.split('/')[0] : null;
  if (dir && !DEPLOYED_DIRS.has(dir)) {
    warnings.push(`${page}: ${dir}/ is not copied by .github/workflows/deploy.yml — this page 404s in production`);
  }

  entries.push({ page, url, lastmod: lastmod(page) });
  for (const a of html.matchAll(/(?:href|src)="\/([A-Za-z0-9._-]+)"/g)) linkedAssets.add(a[1]);
}

/* ── Guard 6 — root-relative assets pages link must actually ship ──────
 * The gh-pages build copies an explicit set of globs and filenames; a page
 * can link /manifest.json or /icons/foo.png and have it resolve perfectly
 * in local dev (which serves the repo root) while 404ing in production.
 * That gap hid broken favicons, a missing PWA manifest and dead runbook
 * links for months. Warn, don't fail: deploy.yml is edited separately. */
// Strip comment lines first: the workflow's comments name the very files
// they explain, so matching raw text would let a comment satisfy the guard
// while the actual cp never runs.
const deployText = (existsSync(join(ROOT, '.github/workflows/deploy.yml'))
  ? readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8') : '')
  .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
const COPY_GLOBS = [/\.html$/, /\.css$/, /\.js$/, /\.png$/, /\.jpg$/, /\.svg$/, /\.ico$/, /\.webp$/];
for (const asset of [...linkedAssets].sort()) {
  if (asset.endsWith('.html')) continue;                 // pages, handled above
  if (!existsSync(join(ROOT, asset))) continue;           // not a repo file
  if (COPY_GLOBS.some((re) => re.test(asset))) continue;  // matched by a glob
  if (deployText.includes(asset)) continue;               // explicitly listed
  warnings.push(`/${asset} is linked by a page but is not copied by .github/workflows/deploy.yml — it 404s in production (works locally)`);
}

// Home first, then alphabetical by URL — purely for human readability.
entries.sort((a, b) => (a.url === `${ORIGIN}/` ? -1 : b.url === `${ORIGIN}/` ? 1 : a.url.localeCompare(b.url)));

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  GENERATED by scripts/build-sitemap.mjs — do not hand-edit.

  Every URL below is the value of that page's own <link rel="canonical">.
  To add a page: give it a canonical tag (plus a vercel.json rewrite if the
  canonical is extensionless) and re-run the script. To keep a page out:
  add it to EXCLUDE in the script with a reason.

  <changefreq>/<priority> are omitted on purpose — Google and Bing both
  ignore them. <lastmod> comes from git, so it cannot lie.
-->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9
          http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">

${entries.map((e) => `  <url>
    <loc>${e.url}</loc>
    <lastmod>${e.lastmod}</lastmod>
  </url>`).join('\n\n')}

</urlset>
`;

for (const w of warnings) console.warn(`  ⚠ ${w}`);

if (errors.length) {
  console.error(`\n❌ build-sitemap FAILED — ${errors.length} page(s) cannot be listed:`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error('');
  process.exit(1);
}

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== xml) {
    console.error('\n❌ sitemap.xml is stale — run: node scripts/build-sitemap.mjs');
    process.exit(1);
  }
  console.log(`✅ sitemap.xml up to date — ${entries.length} URLs`);
  process.exit(0);
}

writeFileSync(OUT, xml);
console.log(`✅ wrote sitemap.xml — ${entries.length} URLs, ${EXCLUDE.size} pages excluded by policy`);
