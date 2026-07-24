/**
 * gate-modal-smoke.spec.js — smoke test for the reusable conversion gate.
 * ═══════════════════════════════════════════════════════════════════════════
 * Guards the contract of js/gate-modal.js + its integrations (see
 * HOME_GATING_PLAN.md). The gate captures a free-account signup INLINE:
 * the visitor submits an email, we POST to /api/auth/gate-signup (mocked
 * here), the page unlocks optimistically, and the modal shows "check your
 * inbox". Paid gates instead route to signup.html for Stripe checkout.
 *
 *   1. GATE_VARIANTS holds all 15 copy variants with the required fields.
 *   2. A FREE gate renders a dimmed modal with an inline email form (no
 *      redirect); submitting posts to the endpoint, sets the provisional
 *      member flag, and swaps to the success state.
 *   3. Invalid email → inline error, no request. Endpoint error → retry copy.
 *   4. A PAID gate routes to signup.html?plan=<real id> (Basic/Advanced).
 *   5. Esc / backdrop close; gates suppressed in preview/embed surfaces.
 *   6. Integrations: satellite-designer + spaceship-designer save loops open
 *      the gate; auroracle's 7-night gate unlocks the week LIVE on submit,
 *      and its 30-day gate is the paid Basic upsell.
 *
 * Auth: the Supabase CDN import is aborted so js/auth.js falls to its mock
 * loader. The signup endpoint is mocked per-test.
 *
 * Run: npx playwright test tests/gate-modal-smoke.spec.js
 */

import { test, expect } from '@playwright/test';

const GATE_API = '**/api/auth/gate-signup';

test.beforeEach(async ({ page }) => {
    await page.route('**://cdn.jsdelivr.net/**', route => route.abort());
});

/** Mock the gate-signup endpoint with a given status/body. */
async function mockGateApi(page, status = 202, body = { ok: true }) {
    await page.route(GATE_API, route => route.fulfill({
        status, contentType: 'application/json', body: JSON.stringify(body),
    }));
}

function mockAuth(plan, role) {
    return { signedIn: true, email: `${role}-${plan}@pw.test`, name: 'T', plan, role, provider: 'mock', ts: Date.now() };
}

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
            return { count: keys.length, bad, free, paid };
        });
        expect(report.count).toBe(15);
        expect(report.bad).toEqual([]);
        expect(report.free).toBe(11);
        expect(report.paid).toBe(4);
    });

    test('free gate mounts a dimmed modal with an inline email form (no redirect)', async ({ page }) => {
        await page.goto('/');
        const opened = await page.evaluate(async () =>
            (await import('/js/gate-modal.js')).openGate('save-satellite', { resume: 'draft' }));
        expect(opened).toBe(true);

        const root = page.locator('#pp-gate-root');
        await expect(root).toBeVisible();
        await expect(root.locator('.pp-gate-headline')).toHaveText('Nice build. Keep it.');
        await expect(root.locator('.pp-gate-scrim')).toBeVisible();          // dims, never destroys
        await expect(root.locator('[data-gate-form]')).toBeVisible();
        await expect(root.locator('[data-gate-email]')).toBeVisible();       // email capture
        await expect(root.locator('[data-gate-primary]')).toHaveCount(0);    // no signup anchor
        await expect(root.locator('.pp-gate-fineprint')).toContainText(/no credit card/i);
    });

    test('free gate: valid email submit → posts, sets provisional flag, shows success', async ({ page }) => {
        await mockGateApi(page, 202, { ok: true });
        await page.goto('/');
        await page.evaluate(async () => (await import('/js/gate-modal.js')).openGate('outlook-7night'));

        const root = page.locator('#pp-gate-root');
        const [req] = await Promise.all([
            page.waitForRequest(r => r.url().includes('/api/auth/gate-signup')),
            (async () => {
                await root.locator('[data-gate-email]').fill('pilot@example.com');
                await root.locator('[data-gate-submit]').click();
            })(),
        ]);
        // Email leaves the page only in the POST body (never in telemetry/URL).
        expect(JSON.parse(req.postData() || '{}').email).toBe('pilot@example.com');

        // Success / check-your-inbox state.
        await expect(root.locator('.pp-gate-card.pp-gate-success')).toBeVisible();
        await expect(root.locator('.pp-gate-headline')).toHaveText(/here's your week/i);
        await expect(root.locator('.pp-gate-body')).toContainText(/check your inbox/i);

        // Provisional member flag set for optimistic unlock on reload.
        const flag = await page.evaluate(() => localStorage.getItem('pp_gate_member'));
        expect(flag).toBeTruthy();
    });

    test('free gate: invalid email shows an inline error and sends no request', async ({ page }) => {
        let hit = false;
        await page.route(GATE_API, route => { hit = true; route.fulfill({ status: 202, body: '{}' }); });
        await page.goto('/');
        await page.evaluate(async () => (await import('/js/gate-modal.js')).openGate('save-satellite'));

        const root = page.locator('#pp-gate-root');
        await root.locator('[data-gate-email]').fill('not-an-email');
        await root.locator('[data-gate-submit]').click();
        await expect(root.locator('[data-gate-error]')).toBeVisible();
        await expect(root.locator('[data-gate-error]')).toContainText(/valid email/i);
        expect(hit).toBe(false);
    });

    test('free gate: endpoint error surfaces the retry copy', async ({ page }) => {
        await mockGateApi(page, 502, { error: 'otp_failed' });
        await page.goto('/');
        await page.evaluate(async () => (await import('/js/gate-modal.js')).openGate('save-satellite'));

        const root = page.locator('#pp-gate-root');
        await root.locator('[data-gate-email]').fill('pilot@example.com');
        await root.locator('[data-gate-submit]').click();
        await expect(root.locator('[data-gate-error]')).toContainText(/didn.t go through/i);
        // Still on the form (no success swap).
        await expect(root.locator('[data-gate-form]')).toBeVisible();
    });

    test('paid gate routes to signup.html with the real plan id + return-to-origin', async ({ page }) => {
        await page.goto('/');
        await page.evaluate(async () =>
            (await import('/js/gate-modal.js')).openGate('advanced-solvers', { next: '/star2d-advanced.html' }));
        const root = page.locator('#pp-gate-root');
        await expect(root.locator('[data-gate-form]')).toHaveCount(0);        // no email form on paid
        const href = await root.locator('[data-gate-primary]').getAttribute('href');
        expect(href).toContain('signup.html');
        expect(href).toContain('plan=advanced');                             // D1: id is 'advanced'
        expect(href).toContain('next=%2Fstar2d-advanced.html');
    });

    test('paid gate drops an off-origin ?next=', async ({ page }) => {
        await page.goto('/');
        await page.evaluate(async () =>
            (await import('/js/gate-modal.js')).openGate('outlook-30day', { next: 'https://evil.example/phish' }));
        const href = await page.locator('#pp-gate-root [data-gate-primary]').getAttribute('href');
        expect(href).not.toContain('evil.example');
        expect(href).not.toContain('next=https');
    });

    test('Esc closes the modal', async ({ page }) => {
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
            document.documentElement.dataset.preview = '1';
            return (await import('/js/gate-modal.js')).openGate('save-satellite');
        });
        expect(opened).toBe(false);
        await expect(page.locator('#pp-gate-root')).toHaveCount(0);
    });
});

// ─────────────────────────────────────────────────────────────────────
// Integration — designer save loops
// ─────────────────────────────────────────────────────────────────────

test.describe('satellite-designer save gate', () => {
    test('signed-out pilot gets the free-save email gate; build kept as a draft', async ({ page }) => {
        await page.goto('/');
        await page.evaluate(() => localStorage.removeItem('pp_auth'));
        await page.goto('/satellite-designer.html');

        const btn = page.locator('#hangar-auth button', { hasText: /save my craft/i });
        await expect(btn).toBeVisible({ timeout: 20_000 });
        await btn.click();

        const root = page.locator('#pp-gate-root');
        await expect(root).toBeVisible();
        await expect(root.locator('.pp-gate-headline')).toHaveText('Nice build. Keep it.');
        await expect(root.locator('[data-gate-email]')).toBeVisible();

        const draft = await page.evaluate(() => localStorage.getItem('pp_sd_draft'));
        expect(draft).toBeTruthy();
    });
});

test.describe('spaceship-designer save gate', () => {
    test('signed-out pilot clicking Save opens the save-rocket email gate', async ({ page }) => {
        await page.goto('/');
        await page.evaluate(() => localStorage.removeItem('pp_auth'));
        await page.goto('/spaceship-designer.html');

        const saveBtn = page.locator('#ssd-save');
        await expect(saveBtn).toBeVisible({ timeout: 20_000 });
        await saveBtn.click();

        const root = page.locator('#pp-gate-root');
        await expect(root).toBeVisible();
        await expect(root.locator('.pp-gate-headline')).toHaveText("Don't lose this rocket.");
        await expect(root.locator('[data-gate-email]')).toBeVisible();

        const draft = await page.evaluate(() => localStorage.getItem('pp_ssd_draft_v1'));
        expect(draft).toBeTruthy();
    });
});

// ─────────────────────────────────────────────────────────────────────
// Integration — auroracle outlook ladder
// ─────────────────────────────────────────────────────────────────────

test.describe('auroracle outlook gates', () => {
    test('signed-out visitor: 7-night gate unlocks the week LIVE on email submit', async ({ page }) => {
        await mockGateApi(page, 202, { ok: true });
        await page.goto('/');
        await page.evaluate(() => { localStorage.removeItem('pp_auth'); localStorage.removeItem('pp_gate_member'); });
        await page.goto('/auroracle.html');

        await expect(page.locator('body')).toHaveClass(/au-locked/, { timeout: 20_000 });
        await page.locator('.au-acc-cta').first().click();

        const root = page.locator('#pp-gate-root');
        await expect(root).toBeVisible();
        await expect(root.locator('.pp-gate-headline')).toHaveText('See the next seven nights.');

        // Submit the email → the page unlocks the week without a reload.
        await root.locator('[data-gate-email]').fill('sky@example.com');
        await root.locator('[data-gate-submit]').click();
        await expect(page.locator('body')).toHaveClass(/au-week/, { timeout: 10_000 });
        await expect(root.locator('.pp-gate-body')).toContainText(/check your inbox/i);
    });

    test('free account reaching for the month gets the PAID 30-day gate', async ({ page }) => {
        await page.goto('/');
        await page.evaluate((a) => localStorage.setItem('pp_auth', JSON.stringify(a)), mockAuth('free', 'user'));
        await page.goto('/auroracle.html');

        await expect(page.locator('body')).toHaveClass(/au-week/, { timeout: 20_000 });
        await page.locator('.au-premium > .au-gate .au-gate-go').first().click();

        const root = page.locator('#pp-gate-root');
        await expect(root).toBeVisible();
        await expect(root.locator('.pp-gate-headline')).toHaveText("You've got the week. Want the month?");
        const href = await root.locator('[data-gate-primary]').getAttribute('href');
        expect(href).toContain('plan=basic');   // D1: 30-day → Basic id
    });
});
