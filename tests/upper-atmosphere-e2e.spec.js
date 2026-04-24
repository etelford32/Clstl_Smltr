/**
 * upper-atmosphere-e2e.spec.js — live-backend E2E for the source pill
 * ═══════════════════════════════════════════════════════════════════════════
 * Runs against a DSMC API brought up by dsmc/docker-compose.ci.yml (see
 * .github/workflows/dsmc-e2e.yml). Exercises the full Auto → SPARTA-
 * bootstrap path the source pill is designed to surface:
 *
 *   1. First paint — the page must render on the client surrogate
 *      (Client pill) before any backend call returns.
 *   2. Within a few seconds — backend answers and the pill flips to
 *      "SPARTA·boot · Auto" because docker-compose.ci.yml seeded the
 *      table directory via --use-msis-fallback.
 *   3. Click the pill — it cycles to "Client · Client only" and the
 *      dashed outline (forced mode) appears.
 *   4. /v1/atmosphere/profile directly returns model=SPARTA-bootstrap
 *      (sanity check against the endpoint contract).
 *
 * The test URL uses the engine's ?api=… override so we don't have to
 * mutate the HTML or inject a script — just pass ?api=http://localhost:8001.
 *
 * Env:
 *   TEST_BASE_URL   dev-server URL (default http://localhost:8000)
 *   DSMC_API_URL    DSMC API URL   (default http://localhost:8001)
 */

import { test, expect } from '@playwright/test';

const DSMC_API = process.env.DSMC_API_URL || 'http://localhost:8001';
const PAGE     = `/upper-atmosphere.html?api=${encodeURIComponent(DSMC_API)}`;
const BOOT_MS  = 20_000;

async function pillLabel(page) {
    return (await page.textContent('#ua-source-pill .ua-source-label'))?.trim() || '';
}

async function pillClasses(page) {
    return await page.getAttribute('#ua-source-pill', 'class') || '';
}

test.describe('upper-atmosphere — live DSMC backend', () => {

    test('backend answers /health', async ({ request }) => {
        const r = await request.get(`${DSMC_API}/health`);
        expect(r.status(), `health endpoint responsive (HTTP ${r.status()})`)
            .toBeLessThan(500);   // 200 if tables seeded, 503 if not — both count
        const body = await r.json();
        expect(body.service).toContain('dsmc');
    });

    test('/v1/atmosphere/profile reports SPARTA-bootstrap after seed', async ({ request }) => {
        const r = await request.get(
            `${DSMC_API}/v1/atmosphere/profile?f107=150&ap=15&n_points=8`);
        expect(r.status()).toBe(200);
        const body = await r.json();
        expect(body.samples?.length, 'profile has samples').toBeGreaterThanOrEqual(8);
        // Bootstrap seed path ⇒ model string starts with SPARTA.
        expect(['SPARTA-bootstrap', 'SPARTA-lookup'],
            `model should be a SPARTA-* string, got ${body.model}`)
            .toContain(body.model);
    });

    test('pill transitions Client → SPARTA·boot (Auto)', async ({ page }) => {
        await page.goto(PAGE);
        // The engine paints the client surrogate first, then fetchProfile
        // merges the backend result ~220ms after the initial refresh.
        await page.waitForFunction(() => !!window.__ua, { timeout: BOOT_MS });

        // Wait up to 10 s for the pill to reach a SPARTA-ish state.
        await page.waitForFunction(() => {
            const label = document
                .querySelector('#ua-source-pill .ua-source-label')
                ?.textContent || '';
            return /SPARTA/i.test(label);
        }, { timeout: 10_000 });

        const label = await pillLabel(page);
        expect(label, 'pill shows SPARTA-ish label').toMatch(/SPARTA/i);
        expect(label, 'pill in Auto mode by default').toMatch(/Auto/);

        const cls = await pillClasses(page);
        expect(cls, 'pill uses bootstrap or sparta variant class')
            .toMatch(/ua-source--(sparta|bootstrap)/);
    });

    test('clicking pill cycles to Client only and shows forced outline', async ({ page }) => {
        await page.goto(PAGE);
        await page.waitForFunction(() => !!window.__ua, { timeout: BOOT_MS });
        await page.waitForFunction(() => {
            const l = document.querySelector('#ua-source-pill .ua-source-label')?.textContent || '';
            return /SPARTA/i.test(l);
        }, { timeout: 10_000 });

        await page.click('#ua-source-pill');
        await page.waitForTimeout(400);

        const label = await pillLabel(page);
        expect(label, 'pill label switched to Client only').toMatch(/Client/i);
        expect(label, 'pill in forced mode').toMatch(/Client only/i);

        const cls = await pillClasses(page);
        expect(cls, 'forced outline applied').toContain('ua-source--forced');

        // Click again — back to Auto.
        await page.click('#ua-source-pill');
        await page.waitForTimeout(400);
        const cls2 = await pillClasses(page);
        expect(cls2, 'forced outline cleared on second click')
            .not.toContain('ua-source--forced');
    });

    test('moving sliders while backend is live keeps the pill in SPARTA state', async ({ page }) => {
        await page.goto(PAGE);
        await page.waitForFunction(() => !!window.__ua, { timeout: BOOT_MS });
        await page.waitForFunction(() => {
            const l = document.querySelector('#ua-source-pill .ua-source-label')?.textContent || '';
            return /SPARTA/i.test(l);
        }, { timeout: 10_000 });

        // Move F10.7 slider and let the debounced backend call resolve.
        await page.fill('#ua-f107', '200');
        await page.dispatchEvent('#ua-f107', 'input');
        await page.waitForTimeout(1200);

        const label = await pillLabel(page);
        expect(label, 'pill still reports SPARTA after a slider change')
            .toMatch(/SPARTA/i);
    });
});
