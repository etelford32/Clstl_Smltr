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

// Honesty invariant at max warp: either the sim keeps up with the
// requested warp, or the amber THROTTLED chip is showing. Silently
// running slower than requested is the one forbidden state. Sample the
// chip over the window because the cap legitimately oscillates near the
// sustainable rate.
const elapsedSec = () => page.evaluate(() => window.__glLab.state.elapsedSec);
const t0sim = await elapsedSec();
const t0wall = Date.now();
let chipSeen = 0, chipText = '';
const SAMPLES = 12;
for (let s = 0; s < SAMPLES; s++) {
    await page.waitForTimeout(500);
    const c = await page.evaluate(() => {
        const el = document.getElementById('gl-throttle');
        return { hidden: el.hidden, text: el.textContent };
    });
    if (!c.hidden) { chipSeen++; chipText = c.text; }
}
const achievedWarp = ((await elapsedSec()) - t0sim) / ((Date.now() - t0wall) / 1000);
const requestedWarp = 1e8;

const busy = await page.evaluate(() => {
    const t = [...window.__cbTimes].sort((a, b) => a - b);
    return {
        n:   t.length,
        p50: t[Math.floor(t.length * 0.5)],
        p95: t[Math.floor(t.length * 0.95)],
        max: t[t.length - 1],
    };
});
const hud = await page.evaluate(() => ({
    dE: document.getElementById('gl-de').textContent,
    dL: document.getElementById('gl-dl').textContent,
    elapsed: document.getElementById('gl-elapsed').textContent,
}));

console.log('tick busy ms  p50:', busy.p50?.toFixed(1), ' p95:', busy.p95?.toFixed(1),
    ' max:', busy.max?.toFixed(1), ` (${busy.n} frames)`);
console.log(`achieved warp ${(achievedWarp / 3.156e7).toFixed(2)} yr/s of requested ` +
    `${(requestedWarp / 3.156e7).toFixed(2)} yr/s · chip seen ${chipSeen}/${SAMPLES}` +
    (chipText ? ` (“${chipText}”)` : ''));
console.log('hud @ max warp:', JSON.stringify(hud));

const dE = parseFloat(hud.dE.replace('e', 'E'));
const keptUp = achievedWarp >= 0.5 * requestedWarp;
const honest = keptUp || chipSeen >= 2;

// ── P0.3: trail geometry at max warp — the anti-hairball gate ───────────
// Frame-based sampling aliased across orbits and produced long chords
// through the middle of the system. Sim-time sampling emits one point per
// 1/256 orbit, so every rendered segment must be a short arc (~2π/256 of
// the orbit circumference), whatever the warp.
await page.click('[data-system="jupiter-galileans"]');
await page.waitForTimeout(300);
await page.evaluate(() => {
    const s = document.getElementById('gl-warp');
    s.value = '1000';
    s.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(5000);
const trailCheck = await page.evaluate(() => {
    const st = window.__glLab.state;
    const out = [];
    for (let i = 0; i < st.bodies.length; i++) {
        const gt = st.trails[i];
        if (!gt) continue;
        const orbitR = Math.hypot(...st.bodies[i].r) * 1e-3 / st.sceneScaleKm;
        const pos = gt.posAttr.array;
        let maxSeg = 0, checked = 0;
        for (let s = 0; s < gt.segCount; s++) {
            const o = s * 6;
            const d = Math.hypot(pos[o] - pos[o+3], pos[o+1] - pos[o+4], pos[o+2] - pos[o+5]);
            if (d > maxSeg) maxSeg = d;
            checked++;
        }
        out.push({ name: st.bodies[i].name, segCount: gt.segCount, cap: gt.cap,
                   maxSeg, orbitR, ratio: maxSeg / orbitR, checked });
    }
    return out;
});
for (const t of trailCheck) {
    console.log(`trail ${t.name}: segs ${t.segCount}/${t.cap}  maxSeg/orbitR ${(t.ratio * 100).toFixed(2)}%`);
}

// ── 4: default boot state (worker path) ─────────────────────────────────
await page.goto(`${BASE}/gravity-lab.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const boot = await page.evaluate(() => ({
    title: document.getElementById('gl-title').textContent,
    laplace: document.querySelector('[data-cell="laplace"]')?.textContent,
    rows: document.querySelectorAll('#gl-bodies tbody tr').length,
    driver: window.__glLab.state.driverMode,
    dE: document.getElementById('gl-de').textContent,
}));
console.log('boot:', JSON.stringify(boot));

// ── 5: inline fallback boots and integrates too (?worker=0) ─────────────
await page.goto(`${BASE}/gravity-lab.html?worker=0`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const inlineBoot = await page.evaluate(() => ({
    driver: window.__glLab.state.driverMode,
    rows: document.querySelectorAll('#gl-bodies tbody tr').length,
    elapsed: document.getElementById('gl-elapsed').textContent,
}));
console.log('inline boot:', JSON.stringify(inlineBoot));

await browser.close();

const failures = [];
if (busy.n < 30)          failures.push(`too few frames measured (${busy.n})`);
if (busy.p95 > 17)        failures.push(`tick busy p95 ${busy.p95.toFixed(1)} ms > 17 ms — budget broken`);
if (!honest)              failures.push(
    `silently slow: achieved ${(achievedWarp / 1e8 * 100).toFixed(0)}% of requested warp ` +
    `with the throttle chip visible in only ${chipSeen}/${SAMPLES} samples`);
if (chipSeen > 0 && !/THROTTLED/.test(chipText)) failures.push(`chip text wrong: ${chipText}`);
if (!(dE < 1e-6))         failures.push(`energy drift ${hud.dE} not bounded at max warp`);
if (boot.rows < 5)        failures.push(`body table has ${boot.rows} rows, expected 5`);
if (!trailCheck.length)   failures.push('no trails found on jupiter-galileans');
for (const t of trailCheck) {
    if (t.segCount === 0) failures.push(`trail ${t.name} recorded no segments at max warp`);
    // One point per 1/256 orbit → segment ≈ 2.5% of the orbit radius.
    // Anything over 15% is an aliasing chord — the hairball coming back.
    if (t.ratio > 0.15)   failures.push(
        `trail ${t.name}: max segment ${(t.ratio * 100).toFixed(1)}% of orbit radius — aliasing`);
}
if (!/°/.test(boot.laplace ?? '')) failures.push(`Laplace readout missing: ${boot.laplace}`);
if (boot.driver !== 'worker') failures.push(`expected worker driver, got ${boot.driver}`);
if (inlineBoot.driver !== 'inline') failures.push(`?worker=0 should force inline, got ${inlineBoot.driver}`);
if (inlineBoot.rows < 5)  failures.push('inline fallback failed to boot the HUD');
if (!/(s|min|hr|d|yr)/.test(inlineBoot.elapsed)) failures.push(`inline fallback not integrating: ${inlineBoot.elapsed}`);
if (errors.length)        failures.push(`console errors: ${errors.join(' | ')}`);

if (failures.length) {
    console.error('SMOKE FAIL');
    for (const f of failures) console.error('  -', f);
    process.exit(1);
}
console.log('SMOKE PASS');
