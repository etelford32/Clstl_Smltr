/**
 * auth-funnel.spec.js — verifies the intro / sign-in / sign-up funnel
 * fires the expected stages on each page entry.
 * ═══════════════════════════════════════════════════════════════════════════
 * The funnel is the primary signal for "are users converting?" — and the
 * value of every downstream RPC (telemetry_auth_funnel_summary,
 * telemetry_auth_funnel_top_drops) depends on the client wiring being
 * intact. Regressions where a refactor drops a `funnel.step()` call would
 * silently delete a stage from the conversion math.
 *
 * This spec intercepts /api/telemetry/log, captures the JSON batches the
 * client sends, and asserts that each entry page emits the funnel event we
 * expect. It does NOT exercise auth state itself — that's covered by
 * tests/auth-flows.spec.js.
 */

import { test, expect } from '@playwright/test';

function attachFunnelInterceptor(page) {
    const events = [];
    // Tests run against the dev-server (no real edge function), so the
    // /api/telemetry/log POST will 404. We fulfill it with a 202 so
    // sendBeacon doesn't fall back to fetch; either way we observe the
    // request body.
    page.route('**/api/telemetry/log', async (route) => {
        try {
            const body = route.request().postDataJSON();
            for (const ev of (body?.events || [])) {
                if (ev.kind === 'auth_funnel') events.push(ev);
            }
        } catch { /* ignore */ }
        await route.fulfill({ status: 202, contentType: 'application/json', body: '{"ok":true}' });
    });

    // Force a deterministic flush by triggering pagehide before assertion.
    return events;
}

async function flushTelemetry(page) {
    // js/telemetry.js flushes on pagehide + visibilitychange. Easiest way
    // to deterministically push the in-memory queue is to call flush()
    // directly via the page context.
    await page.evaluate(async () => {
        try {
            const mod = await import('./js/telemetry.js');
            mod.telemetry.flush();
        } catch {}
    });
    // sendBeacon may be async-deferred; wait briefly.
    await page.waitForTimeout(500);
}

test.describe('auth funnel', () => {

    test('signin.html emits signin_view', async ({ page }) => {
        const events = attachFunnelInterceptor(page);
        await page.goto('/signin.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(300);
        await flushTelemetry(page);

        const stages = events.map(e => e.metadata?.stage);
        expect(stages, 'signin_view emitted').toContain('signin_view');
    });

    test('signin.html records magic-link toggle and validation error', async ({ page }) => {
        const events = attachFunnelInterceptor(page);
        await page.goto('/signin.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(300);

        // Toggle to magic-link mode.
        await page.click('#magic-toggle');
        await page.waitForTimeout(100);

        // Submit blank email — should trigger signin_validation_error.
        await page.click('#btn-submit');
        await page.waitForTimeout(150);

        await flushTelemetry(page);

        const stages = events.map(e => e.metadata?.stage);
        expect(stages, 'method selection emitted').toContain('signin_method_selected');
        expect(stages, 'validation error emitted').toContain('signin_validation_error');
    });

    test('signup.html emits signup_view + plan_selected on pill click', async ({ page }) => {
        const events = attachFunnelInterceptor(page);
        await page.goto('/signup.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(300);

        // Click the basic plan pill — exact id from selectPlan map.
        await page.click('#pill-basic').catch(() => {});
        await page.waitForTimeout(100);

        await flushTelemetry(page);

        const stages = events.map(e => e.metadata?.stage);
        expect(stages, 'signup_view emitted').toContain('signup_view');
        expect(stages, 'plan_selected emitted').toContain('signup_plan_selected');
    });

    test('index.html emits landing_view + landing_cta_click on CTA', async ({ page }) => {
        const events = attachFunnelInterceptor(page);
        await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(300);

        // Click any data-funnel-cta link. Stop default navigation so the
        // page doesn't unload before flush — we only care about the click
        // recording, not the destination.
        await page.evaluate(() => {
            const a = document.querySelector('[data-funnel-cta]');
            if (!a) return;
            a.addEventListener('click', e => e.preventDefault(), { once: true });
            a.click();
        });
        await page.waitForTimeout(150);

        await flushTelemetry(page);

        const stages = events.map(e => e.metadata?.stage);
        expect(stages, 'landing_view emitted').toContain('landing_view');
        expect(stages, 'landing_cta_click emitted').toContain('landing_cta_click');
    });

    test('all auth_funnel events carry a funnel_id', async ({ page }) => {
        const events = attachFunnelInterceptor(page);
        await page.goto('/signin.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(300);
        await flushTelemetry(page);

        // Every event should have a funnel_id so server-side stitching works.
        const missing = events.filter(e => !e.metadata?.funnel_id);
        expect(missing, `events missing funnel_id: ${JSON.stringify(missing)}`).toEqual([]);
    });
});
