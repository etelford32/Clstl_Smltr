#!/usr/bin/env node
/**
 * lint-nav.mjs — canonical-navigation structural gate.
 *
 * Invariant (the standardization end-state):
 *   Every *site* HTML page must
 *     1. load the shared nav   (references js/nav.js)
 *     2. load the shared nav CSS (references nav-styles.css)
 *     3. carry ZERO inline nav CSS (no <style> rule selecting
 *        `nav`, `.nav-*`, or `.burger-line` — that ghost CSS fights
 *        js/nav-styles.css and is why the bar looks different per page)
 *
 * RATCHET, not a bulk failure: a JSON baseline records the pages that
 * are knowingly non-compliant *today* (the Phase 1–4 worklist). CI is
 * green while violations stay within that baseline, and RED the moment
 *   - a new page is added that isn't compliant, or
 *   - an existing page regresses to a violation type it didn't have.
 * As each standardization phase lands, the fixed pages are removed from
 * the baseline (`--write-baseline` regenerates it), so the file is the
 * live, mechanically-enforced worklist that can only shrink.
 *
 * Usage:
 *   node scripts/lint-nav.mjs                 # check (CI). exit 1 on regression
 *   node scripts/lint-nav.mjs --write-baseline# regenerate baseline from current tree
 *   NAVLINT_BASELINE=/path override baseline location (testing)
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = process.env.NAVLINT_BASELINE || join(ROOT, 'scripts', 'nav-lint-baseline.json');

// Directories that never contain canonical site pages.
// The swmf/dsmc entries are gitignored workstation artifacts (simulation run
// dirs, venvs, raw data pulls) — they can contain dangling container-path
// symlinks that crash statSync, and never hold site pages.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'rust/target', 'rust/www',
    'swmf/runs', 'swmf/runs_docker', 'swmf/raw', 'swmf/.venv', 'dsmc/raw']);
// Individual non-site pages (dev/test/engine) — intentionally chromeless.
const EXCLUDE_FILES = new Set([
    'js/geo/selftest.html',
    'docs/observatory-3d/schwarzschild-proto.html',   // ray-tracer dev harness
]);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = relative(ROOT, abs).split(sep).join('/');
    if (SKIP_DIRS.has(rel)) continue;
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, acc);
    else if (name.endsWith('.html') && !EXCLUDE_FILES.has(rel)) acc.push(rel);
  }
  return acc;
}

// Selectors that mean "this page is styling the nav itself".
const NAV_SELECTOR = /(^|[\s>+~])(nav|\.nav-[\w-]+|\.burger-line)([\s.:#\[]|$)/;

function hasGhostNavCss(html) {
  const styles = html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) || [];
  for (const block of styles) {
    const css = block
      .replace(/<\/?style\b[^>]*>/gi, '')
      .replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments
    let m;
    const re = /([^{}]+)\{/g;
    while ((m = re.exec(css)) !== null) {
      const prelude = m[1];
      if (prelude.includes('@')) continue;            // @media/@supports prelude
      for (const sel of prelude.split(',')) {
        if (NAV_SELECTOR.test(sel.trim())) return true;
      }
    }
  }
  return false;
}

function violationsFor(html) {
  const v = [];
  if (!/[\/.]js\/nav\.js/.test(html)) v.push('noNavJs');
  if (!/nav-styles/.test(html)) v.push('noNavStyles');
  if (hasGhostNavCss(html)) v.push('ghostCss');
  // initNav() does `document.querySelector('nav')` and RETURNS EARLY when
  // there is none — it populates a shell, it does not create one. So a page
  // can import nav.js, load nav-styles.css, pass every other check here, and
  // still render no navigation at all. That is a silent failure with no
  // console error and nothing in a diff to notice, and it has now shipped
  // twice. Importing the module is not the invariant; having a nav is.
  //
  // Only checked for pages that DO import nav.js. A deliberately chromeless
  // page (auth-callback, reset-password, the token gallery) has no shell
  // because it wants no nav, and it is already described by noNavJs — adding
  // a second finding for the same intent would just be baseline noise.
  if (!v.includes('noNavJs') && !/<nav[\s>]/i.test(html)) v.push('noNavShell');
  return v;
}

function loadBaseline() {
  try {
    const raw = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const out = {};
    for (const [k, val] of Object.entries(raw)) {
      if (k.startsWith('_') || k.startsWith('//')) continue; // doc keys
      out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The burger breakpoint is defined TWICE and both copies matter.
 *
 * js/nav-styles.css decides what the visitor sees; js/nav.js's MOBILE_NAV_MAX
 * decides whether hover logic may run and whether tapping a link dismisses the
 * panel. When they disagreed (CSS at 1280, JS still reading a hardcoded 1024)
 * the panel stayed open over the page a visitor had just navigated to, on
 * every width in between — no error, nothing in a diff.
 *
 * Cheap textual check, run in CI, so the pair cannot drift apart again.
 * tests/nav-responsive.spec.js proves the behaviour; this proves the constant.
 */
function breakpointDrift() {
  const js = readFileSync(join(ROOT, 'js', 'nav.js'), 'utf8');
  const css = readFileSync(join(ROOT, 'js', 'nav-styles.css'), 'utf8');
  const jsMax = js.match(/const MOBILE_NAV_MAX\s*=\s*(\d+)/)?.[1];
  if (!jsMax) return 'js/nav.js no longer defines MOBILE_NAV_MAX';
  if (!css.includes(`@media (max-width: ${jsMax}px)`)) {
    return `js/nav.js MOBILE_NAV_MAX is ${jsMax}, but js/nav-styles.css has no `
      + `@media (max-width: ${jsMax}px) burger block`;
  }
  const stray = js.match(/innerWidth\s*<=\s*(\d+)/g)?.filter(m => !m.includes(jsMax));
  if (stray?.length) {
    return `js/nav.js compares innerWidth against a breakpoint that is not `
      + `MOBILE_NAV_MAX (${stray.join(', ')}) — use the constant`;
  }
  return null;
}

const pages = walk(ROOT).sort();
const current = {};
for (const p of pages) {
  const v = violationsFor(readFileSync(join(ROOT, p), 'utf8'));
  if (v.length) current[p] = v.sort();
}

if (process.argv.includes('--write-baseline')) {
  const out = {
    _comment:
      'Known nav non-compliance (Phase 1–4 worklist). CI ratchet: pages ' +
      'here may keep ONLY these violation types until standardized. ' +
      'Remove an entry once fixed, or run --write-baseline. Never add by hand.',
    ...Object.fromEntries(Object.entries(current).sort()),
  };
  writeFileSync(BASELINE, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote baseline: ${Object.keys(current).length} page(s) of known debt`);
  process.exit(0);
}

const baseline = loadBaseline();
const failures = [];
const notices = [];

for (const [p, v] of Object.entries(current)) {
  const allowed = baseline[p] || [];
  const newV = v.filter((x) => !allowed.includes(x));
  if (newV.length) failures.push({ page: p, newV, all: v, baselined: p in baseline });
}
for (const [p, allowed] of Object.entries(baseline)) {
  if (!(p in current)) notices.push(`${p}: now compliant — remove from baseline`);
  else {
    const stillBad = current[p];
    const fixed = allowed.filter((x) => !stillBad.includes(x));
    if (fixed.length) notices.push(`${p}: fixed [${fixed.join(', ')}] — tighten baseline`);
  }
}

const drift = breakpointDrift();

console.log(`nav-lint: scanned ${pages.length} site pages`);
console.log(`  compliant: ${pages.length - Object.keys(current).length}`);
console.log(`  known debt (baseline): ${Object.keys(baseline).length}`);
console.log(`  breakpoint sync: ${drift ? '✗' : 'ok'}`);

if (drift) {
  console.error(`\n❌ nav-lint FAILED — burger breakpoint drift:\n  ✗ ${drift}`);
  process.exit(1);
}

if (notices.length) {
  console.log('\nNotices (non-blocking — baseline can shrink):');
  for (const n of notices) console.log(`  • ${n}`);
}

if (failures.length) {
  console.error('\n❌ nav-lint FAILED — new/regressed non-compliance:');
  for (const f of failures) {
    const why = f.baselined
      ? `regressed: +[${f.newV.join(', ')}] (baseline allowed [${(baseline[f.page] || []).join(', ')}])`
      : `not compliant and not in baseline: [${f.newV.join(', ')}]`;
    console.error(`  ✗ ${f.page} — ${why}`);
  }
  console.error(
    '\nFix the page (use js/nav.js + nav-styles.css, no inline nav CSS), ' +
      'or — only if intentionally chromeless — add it to EXCLUDE_FILES.\n' +
      'Do NOT hand-edit the baseline to silence this.'
  );
  process.exit(1);
}

console.log('\n✅ nav-lint passed — no new nav drift.');
process.exit(0);
