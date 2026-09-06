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

    // ── Classic-script stages (load-order regression) ───────────────────
    // signin.html / signup.html fire first_interaction / submit / succeeded
    // from CLASSIC <script> blocks, which run at parse time — before any
    // module sets window.ppFunnel. A parse-time `window.ppFunnel || stub`
    // capture silently dropped ALL of them (admin funnel: "signin_view →
    // signin_first_interaction: 100% lost"). These two tests observe the
    // stage on the wire; tests/funnel-shim.mjs pins the shim's shape.
    test('signin.html emits signin_first_interaction on first field focus', async ({ page }) => {
        const events = attachFunnelInterceptor(page);
        await page.goto('/signin.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(300);
        // Blur first: the email field is autofocused at parse time (before the
        // module lands) and the queued stage must replay — but make the
        // interaction explicit too so the test proves the live path.
        await page.evaluate(() => document.activeElement?.blur?.());
        await page.focus('#password');
        await page.waitForTimeout(150);
        await flushTelemetry(page);
        const stages = events.map(e => e.metadata?.stage);
        expect(stages, 'signin_first_interaction emitted').toContain('signin_first_interaction');
    });

    test('signup.html emits signup_first_interaction on first field focus', async ({ page }) => {
        const events = attachFunnelInterceptor(page);
        await page.goto('/signup.html?plan=free', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(300);
        await page.focus('#email');
        await page.waitForTimeout(150);
        await flushTelemetry(page);
        const stages = events.map(e => e.metadata?.stage);
        expect(stages, 'signup_first_interaction emitted').toContain('signup_first_interaction');
    });

    test('signin.html ?next= names the destination and threads it into the signup links', async ({ page }) => {
        await page.goto('/signin.html?next=%2Fspace-weather.html', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#signin-context')).toBeVisible();
        await expect(page.locator('#signin-context')).toContainText('Space Weather Dashboard');
        const href = await page.locator('#signin-create-account').getAttribute('href');
        expect(href).toContain('signup.html');
        expect(href).toContain('next=%2Fspace-weather.html');
        // Off-origin next must be ignored (open-redirect guard).
        await page.goto('/signin.html?next=https%3A%2F%2Fevil.example', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#signin-context')).toBeHidden();
        expect(await page.locator('#signin-create-account').getAttribute('href')).not.toContain('evil');
    });

    test('index.html band capture emits aurora_capture_* with source home; the hero has ONE ask', async ({ page }) => {
        // 2026-09-06: the above-the-fold capture (source home-hero) was
        // retired — 0 submits in 60 days — and the hero carries one CTA.
        const events = attachFunnelInterceptor(page);
        await page.route('**/api/subscribe/aurora', (route) =>
            route.fulfill({ status: 202, contentType: 'application/json', body: '{"ok":true}' }));
        await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#hero [data-funnel-cta]')).toHaveCount(1);
        await expect(page.locator('#hero [data-funnel-cta]')).toHaveAttribute('data-funnel-cta', 'hero_magnetosphere');
        await expect(page.locator('form[data-source="home-hero"]')).toHaveCount(0);
        const form = page.locator('form[data-source="home"]');
        await form.scrollIntoViewIfNeeded();
        await form.locator('input[type="email"]').fill('visitor@example.com');
        await form.locator('button[type="submit"]').click();
        await expect(form.locator('.aurora-upsell a[data-funnel-cta="aurora_capture_upsell"]')).toBeVisible();
        await flushTelemetry(page);
        const band = events.filter(e => e.metadata?.source === 'home').map(e => e.metadata?.stage);
        expect(band).toContain('aurora_capture_view');
        expect(band).toContain('aurora_capture_submit');
        expect(band).toContain('aurora_capture_succeeded');
    });

    test('index.html CTA rail appears once the hero scrolls away and dismisses for the tab', async ({ page }) => {
        await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
        const rail = page.locator('#cta-rail');
        await expect(rail).not.toHaveClass(/on/);
        await page.locator('#aurora').scrollIntoViewIfNeeded();
        // The cookie-consent banner owns the bottom edge while open: the rail
        // must yield to it, then appear once the visitor decides.
        const consent = page.locator('.pp-consent-banner');
        // The banner self-mounts on DOMContentLoaded — give it a moment.
        await consent.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
        if (await consent.isVisible().catch(() => false)) {
            await expect(rail).not.toHaveClass(/on/);
            await consent.locator('[data-action="reject"]').click();
        }
        await expect(rail).toHaveClass(/on/);
        await rail.locator('[data-rail-dismiss]').click();
        await expect(rail).toBeHidden();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('#aurora').scrollIntoViewIfNeeded();
        await expect(page.locator('#cta-rail')).toBeHidden();
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

    test('all auth_funnel events carry a top-level visitor_id (cross-tab join key)', async ({ page }) => {
        const events = attachFunnelInterceptor(page);
        await page.goto('/signin.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(300);
        await flushTelemetry(page);

        // visitor_id must ride on EVERY event, not just the once-per-funnel
        // context block. It is the fallback join key that stitches a single
        // visitor's stages across funnel_ids when a tab boundary forks the
        // funnel (e.g. landing → signup.html in a fresh tab). Without the
        // per-event copy, the CTA→signup handoff is un-joinable and reads as
        // abandonment. localStorage is available in the test browser, so
        // getVisitorId() never degrades to null here.
        expect(events.length, 'at least one funnel event captured').toBeGreaterThan(0);
        const missing = events.filter(e => !e.metadata?.visitor_id);
        expect(missing, `events missing visitor_id: ${JSON.stringify(missing.map(e => e.metadata?.stage))}`).toEqual([]);
    });
});
