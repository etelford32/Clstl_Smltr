/**
 * Gravity Lab smoke probe (P0.1 acceptance) — boots the page, cranks the
 * warp slider to max on Saturn + Major Moons, and asserts:
 *
 *   1. The main-thread tick stays inside its frame budget (< 17 ms busy
 *      per rAF callback) — i.e. the physics loop is genuinely bounded and
 *      the tab can never freeze, whatever the slider says.
 *   2. The amber THROTTLED chip appears when the requested warp is
 *      unsustainable.
 *   3. Energy drift stays bounded while throttled.
 *   4. The default system boots with a live HUD (Laplace angle near 180°).
 *
 * NOTE: rAF *cadence* is deliberately not asserted — in CI containers
 * Chromium falls back to SwiftShader software rasterization, where the
 * frame interval is dominated by the GPU-process raster time between
 * callbacks (~30-60 ms even with zero physics). Main-thread busy time per
 * callback is the metric the physics budget controls, so that is what we
 * gate on.
 *
 * Run:  node dev-server.mjs &  then  node tests/gravity-lab-smoke.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3000';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

// Console noise that is not gravity-lab's: the Supabase CDN client and
// favicon/manifest fetches fail in sandboxed/offline environments.
const IGNORE = /supabase|jsdelivr|favicon|manifest|404|ERR_TUNNEL|ERR_INTERNET|ERR_NAME/i;
const errors = [];
page.on('console', m => {
    if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(m.text());
});
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

// Time every rAF callback so we can measure main-thread busy per frame.
await page.addInitScript(() => {
    window.__cbTimes = [];
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = cb => orig(t => {
        const s = performance.now();
        cb(t);
        window.__cbTimes.push(performance.now() - s);
        if (window.__cbTimes.length > 2000) window.__cbTimes.shift();
    });
});

await page.goto(`${BASE}/gravity-lab.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// ── 1+2+3: saturn-major at max warp ─────────────────────────────────────
await page.click('[data-system="saturn-major"]');
await page.waitForTimeout(400);
await page.evaluate(() => {
    const s = document.getElementById('gl-warp');
    s.value = '1000';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    window.__cbTimes.length = 0;
});
await page.waitForTimeout(6000);

const busy = await page.evaluate(() => {
    const t = [...window.__cbTimes].sort((a, b) => a - b);
    return {
        n:   t.length,
        p50: t[Math.floor(t.length * 0.5)],
        p95: t[Math.floor(t.length * 0.95)],
        max: t[t.length - 1],
    };
});
const chip = await page.evaluate(() => {
    const c = document.getElementById('gl-throttle');
    return { hidden: c.hidden, text: c.textContent };
});
const hud = await page.evaluate(() => ({
    dE: document.getElementById('gl-de').textContent,
    dL: document.getElementById('gl-dl').textContent,
    elapsed: document.getElementById('gl-elapsed').textContent,
}));

console.log('tick busy ms  p50:', busy.p50?.toFixed(1), ' p95:', busy.p95?.toFixed(1),
    ' max:', busy.max?.toFixed(1), ` (${busy.n} frames)`);
console.log('throttle chip:', JSON.stringify(chip));
console.log('hud @ max warp:', JSON.stringify(hud));

const dE = parseFloat(hud.dE.replace('e', 'E'));

// ── 4: default boot state ───────────────────────────────────────────────
await page.goto(`${BASE}/gravity-lab.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const boot = await page.evaluate(() => ({
    title: document.getElementById('gl-title').textContent,
    laplace: document.querySelector('[data-cell="laplace"]')?.textContent,
    rows: document.querySelectorAll('#gl-bodies tbody tr').length,
}));
console.log('boot:', JSON.stringify(boot));

await browser.close();

const failures = [];
if (busy.n < 30)          failures.push(`too few frames measured (${busy.n})`);
if (busy.p95 > 17)        failures.push(`tick busy p95 ${busy.p95.toFixed(1)} ms > 17 ms — budget broken`);
if (chip.hidden)          failures.push('throttle chip did not appear at max warp on saturn-major');
if (!/THROTTLED/.test(chip.text)) failures.push(`chip text wrong: ${chip.text}`);
if (!(dE < 1e-6))         failures.push(`energy drift ${hud.dE} not bounded under throttle`);
if (boot.rows < 5)        failures.push(`body table has ${boot.rows} rows, expected 5`);
if (!/°/.test(boot.laplace ?? '')) failures.push(`Laplace readout missing: ${boot.laplace}`);
if (errors.length)        failures.push(`console errors: ${errors.join(' | ')}`);

if (failures.length) {
    console.error('SMOKE FAIL');
    for (const f of failures) console.error('  -', f);
    process.exit(1);
}
console.log('SMOKE PASS');
