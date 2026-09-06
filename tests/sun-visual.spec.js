/**
 * tests/sun-visual.spec.js — GPU screenshot baseline for sun.html
 * ═══════════════════════════════════════════════════════════════════════════
 * SUN_VISUALS_WORLD_CLASS_PLAN.md Phase 0. Software WebGL cannot judge visual
 * work, so this spec is OPT-IN and meant for a machine with a real GPU:
 *
 *   SUN_GPU=1 npx playwright test tests/sun-visual.spec.js --update-snapshots   # first run: write the baseline
 *   SUN_GPU=1 npx playwright test tests/sun-visual.spec.js                      # later: diff against it
 *
 * Without SUN_GPU=1 every test is skipped, so CI (software GL) is untouched.
 * Baselines live under tests/__visual__/sun-visual.spec.js/ (the
 * snapshotPathTemplate in playwright.config.js) — commit them with the PR and
 * note the GPU + `__sun.perf` in the plan's progress log.
 *
 * Determinism: /api/solar/aia is served from tests/fixtures/sdo (the real
 * set `real_<channel>.jpg` when scripts/fetch-sdo-fixtures.mjs has run, else
 * the synthetic set), every other network host is blocked so the page takes
 * its procedural fallbacks, and the sim clock is frozen via `__sun.freeze`.
 * The AR list therefore comes from whatever SWPC cache the page carries —
 * none, offline — so screenshots pin the OBSERVED disk, post chain and
 * layers, not a particular day's active regions.
 */
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GPU = process.env.SUN_GPU === '1';
const PAGE = '/sun.html';
const BOOT_TIMEOUT_MS = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures', 'sdo');
const SIZES = [
    { name: '720p',  width: 1280, height: 720 },
    { name: '1440p', width: 2560, height: 1440 },
];

function fixtureFor(channel) {
    const realManifest = join(FIXTURE_DIR, 'real-manifest.json');
    if (existsSync(realManifest)) {
        const m = JSON.parse(readFileSync(realManifest, 'utf8'));
        const f = m.frames[channel];
        if (f && existsSync(join(FIXTURE_DIR, f.file))) return { file: f.file, type: 'image/jpeg', observedAt: f.lastModified || m.fetched, real: true };
    }
    const m = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'));
    const f = m.frames[channel] || m.frames.white;
    return { file: f.file, type: 'image/png', observedAt: m.epoch, real: false };
}

async function prepare(page) {
    await page.addInitScript(() => {
        try { localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 })); } catch (e) {}
    });
    // Fixtures for the observed disk; everything else off-origin is blocked.
    await page.route('**/api/solar/aia*', (route) => {
        const ch = new URL(route.request().url()).searchParams.get('channel') || 'white';
        const fx = fixtureFor(ch);
        route.fulfill({ status: 200, headers: { 'Content-Type': fx.type, 'X-SDO-Observed-At': fx.observedAt, 'X-AIA-Channel': ch }, body: readFileSync(join(FIXTURE_DIR, fx.file)) });
    });
    await page.route((u) => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(u.href), (route) => route.abort());
}

async function settle(page, { view = '0', cutaway = false, doppler = false, observed = true } = {}) {
    await page.goto(PAGE);
    await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
    await page.evaluate((o) => window.__sun.setObserved(o), observed);
    if (observed) await page.waitForFunction(() => window.__sun.observed?.mode === 'observed', { timeout: BOOT_TIMEOUT_MS });
    await page.evaluate((v) => { const el = document.getElementById('view-mode'); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, view);
    if (view !== '0' && observed) await page.waitForFunction(() => window.__sun.observed?.mode === 'observed' && window.__sun.uniforms.u_viewMode.value > 0, { timeout: BOOT_TIMEOUT_MS });
    for (const [id, on] of [['tog-cutaway', cutaway], ['tog-doppler', doppler]]) {
        await page.evaluate(({ id, on }) => { const el = document.getElementById(id); if (el && el.checked !== on) { el.checked = on; el.dispatchEvent(new Event('change', { bubbles: true })); } }, { id, on });
    }
    // Freeze the sim clock, let the cross-fade finish and the composer settle.
    await page.evaluate(() => window.__sun.freeze(120));
    await page.waitForTimeout(2000);
}

test.describe('sun.html visual baseline (@gpu)', () => {
    test.skip(!GPU, 'set SUN_GPU=1 on a machine with a real GPU');
    test.describe.configure({ mode: 'serial' });

    const SCENES = [
        { name: 'white-observed', opts: { view: '0' } },
        { name: 'aia171-observed', opts: { view: '2' } },
        { name: 'aia304-observed', opts: { view: '1' } },
        { name: 'white-model', opts: { view: '0', observed: false } },
        { name: 'cutaway', opts: { view: '0', cutaway: true } },
        { name: 'doppler', opts: { view: '0', doppler: true } },
    ];

    for (const size of SIZES) {
        for (const scene of SCENES) {
            test(`${scene.name} @ ${size.name}`, async ({ page }, testInfo) => {
                await page.setViewportSize({ width: size.width, height: size.height });
                await prepare(page);
                await settle(page, scene.opts);
                const perf = await page.evaluate(() => window.__sun.perf);
                testInfo.annotations.push({ type: 'perf', description: `p50 ${perf.p50?.toFixed(1)} ms · p95 ${perf.p95?.toFixed(1)} ms over ${perf.n} frames` });
                const canvas = page.locator('#canvas-wrap canvas');
                await expect(canvas).toHaveScreenshot(`${scene.name}-${size.name}.png`, {
                    maxDiffPixelRatio: 0.005,
                    animations: 'disabled',
                });
            });
        }
    }
});
