/**
 * gate-modal-smoke.spec.js — smoke test for the reusable conversion gate.
 * ═══════════════════════════════════════════════════════════════════════════
 * Guards the Phase-1 contract of js/gate-modal.js + its satellite-designer
 * wiring (see HOME_GATING_PLAN.md):
 *
 *   1. GATE_VARIANTS holds all 15 copy variants, each with the required
 *      shell fields (headline/body/primary/secondary/gateType).
 *   2. openGate() mounts a DIMMED modal (scrim present) and builds a
 *      return-to-origin signup URL: signup.html?plan=…&next=<same-origin
 *      path>&resume=<token>.
 *   3. The same-origin allowlist rejects off-origin ?next= smuggling.
 *   4. Esc / ✕ / backdrop all close the modal (quiet-exit contract).
 *   5. Gates are SUPPRESSED inside a preview/embed surface (html[data-preview]).
 *   6. Integration: a signed-out pilot on satellite-designer.html sees the
 *      "Save my craft — free" button, and it opens the save-satellite gate
 *      wired back to /satellite-designer.html with ?resume=draft.
 *
 * Auth: the Supabase CDN import is aborted so js/auth.js deterministically
 * falls to its mock loader (CI runners can otherwise reach jsdelivr).
 *
 * Run: npx playwright test tests/gate-modal-smoke.spec.js
 */

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.route('**://cdn.jsdelivr.net/**', route => route.abort());
});

// ─────────────────────────────────────────────────────────────────────
// Component-level
// ─────────────────────────────────────────────────────────────────────

test.describe('gate-modal component', () => {
    test('registry holds all 15 variants with the required shell fields', async ({ page }) => {
        await page.goto('/');
        const report = await page.evaluate(async () => {
            const m = await import('/js/gate-modal.js');
            const keys = Object.keys(m.GATE_VARIANTS);
            const bad = [];
            for (const k of keys) {
                const v = m.GATE_VARIANTS[k];
                if (!v.headline || !v.body || !v.primary?.label || !v.primary?.plan ||
                    !v.secondary?.label || !v.gateType) bad.push(k);
            }
            const free = keys.filter(k => m.GATE_VARIANTS[k].gateType === 'free').length;
            const paid = keys.filter(k => m.GATE_VARIANTS[k].gateType === 'paid').length;
            return { count: keys.length, bad, free, paid, hasSave: keys.includes('save-satellite') };
        });
        expect(report.count).toBe(15);
        expect(report.bad).toEqual([]);
        expect(report.free).toBe(11);   // copy §1
        expect(report.paid).toBe(4);    // copy §2
        expect(report.hasSave).toBe(true);
    });

    test('openGate mounts a dimmed modal + return-to-origin signup URL', async ({ page }) => {
        await page.goto('/');
        const opened = await page.evaluate(async () => {
            const m = await import('/js/gate-modal.js');
            return m.openGate('save-satellite', { next: '/satellite-designer.html', resume: 'draft' });
        });
        expect(opened).toBe(true);

        const root = page.locator('#pp-gate-root');
        await expect(root).toBeVisible();
        await expect(root.locator('.pp-gate-headline')).toHaveText('Nice build. Keep it.');
        await expect(root.locator('.pp-gate-scrim')).toBeVisible();   // dims, never destroys
        await expect(root.locator('.pp-gate-fineprint')).toContainText(/no credit card/i);

        const href = await root.locator('[data-gate-primary]').getAttribute('href');
        expect(href).toContain('signup.html');
        expect(href).toContain('plan=free');
        expect(href).toContain('next=%2Fsatellite-designer.html');
        expect(href).toContain('resume=draft');

        // save-satellite's secondary is the sign-in exit.
        await expect(root.locator('[data-gate-secondary]')).toContainText(/sign in/i);
    });

    test('paid variant routes to the real plan id (Basic/Advanced, not Forecaster/Researcher)', async ({ page }) => {
        await page.goto('/');
        await page.evaluate(async () =>
            (await import('/js/gate-modal.js')).openGate('advanced-solvers', { next: '/star2d-advanced.html' }));
        const href = await page.locator('#pp-gate-root [data-gate-primary]').getAttribute('href');
        expect(href).toContain('plan=advanced');   // D1: id is 'advanced'
        await expect(page.locator('#pp-gate-root [data-gate-primary]')).toContainText(/advanced/i);
    });

    test('off-origin ?next= is dropped by the same-origin allowlist', async ({ page }) => {
        await page.goto('/');
        await page.evaluate(async () =>
            (await import('/js/gate-modal.js')).openGate('save-satellite', { next: 'https://evil.example/phish' }));
        const href = await page.locator('#pp-gate-root [data-gate-primary]').getAttribute('href');
        expect(href).not.toContain('evil.example');
        // Falls back to the current same-origin path, never an off-origin next.
        expect(href).not.toContain('next=https');
    });

    test('Esc closes the modal and restores the page', async ({ page }) => {
        await page.goto('/');
        await page.evaluate(async () => (await import('/js/gate-modal.js')).openGate('save-satellite'));
        await expect(page.locator('#pp-gate-root')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('#pp-gate-root')).toHaveCount(0);
    });

    test('backdrop click closes the modal', async ({ page }) => {
        await page.goto('/');
        await page.evaluate(async () => (await import('/js/gate-modal.js')).openGate('save-satellite'));
        await page.locator('#pp-gate-root .pp-gate-scrim').click({ position: { x: 5, y: 5 } });
        await expect(page.locator('#pp-gate-root')).toHaveCount(0);
    });

    test('gates are suppressed inside a preview/embed surface', async ({ page }) => {
        await page.goto('/');
        const opened = await page.evaluate(async () => {
            document.documentElement.dataset.preview = '1';   // mimic js/preview-mode.js
            return (await import('/js/gate-modal.js')).openGate('save-satellite');
        });
        expect(opened).toBe(false);
        await expect(page.locator('#pp-gate-root')).toHaveCount(0);
    });
});

// ─────────────────────────────────────────────────────────────────────
// Integration — satellite-designer save loop
// ─────────────────────────────────────────────────────────────────────

test.describe('satellite-designer save gate', () => {
    test('signed-out pilot gets the free-save gate wired back to this page', async ({ page }) => {
        await page.goto('/');
        await page.evaluate(() => localStorage.removeItem('pp_auth'));   // ensure signed-out
        await page.goto('/satellite-designer.html');

        const btn = page.locator('#hangar-auth button', { hasText: /save my craft/i });
        await expect(btn).toBeVisible({ timeout: 20_000 });

        await btn.click();
        const root = page.locator('#pp-gate-root');
        await expect(root).toBeVisible();
        await expect(root.locator('.pp-gate-headline')).toHaveText('Nice build. Keep it.');

        const href = await root.locator('[data-gate-primary]').getAttribute('href');
        expect(href).toContain('plan=free');
        expect(href).toContain('next=%2Fsatellite-designer.html');
        expect(href).toContain('resume=draft');

        // The build was stashed as a local draft before the redirect so it
        // survives the signup round-trip.
        const draft = await page.evaluate(() => localStorage.getItem('pp_sd_draft'));
        expect(draft).toBeTruthy();
    });
});
