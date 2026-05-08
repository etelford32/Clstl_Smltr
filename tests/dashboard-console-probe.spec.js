/**
 * dashboard-console-probe.spec.js — guards dashboard.html against Tier-1 regressions
 * ═══════════════════════════════════════════════════════════════════════════
 * The dashboard is a 2,100-line single ES module with no global try/catch
 * around init. A single uncaught exception anywhere in that script kills
 * every IIFE that follows it (event listeners, IIFEs, engines, history
 * panel — see AUTH_FLOW_REVIEW.md and the Tier-1 analysis on branch
 * claude/analyze-dashboard-issues-XSZYj).
 *
 * This spec runs the dashboard in a headless browser and fails CI if:
 *   1. Any uncaught exception (`pageerror`) fires.
 *   2. The diagnostic auth-gate console line never appears (which means
 *      the script died before line 1167 — i.e., a top-level throw).
 *
 * It does NOT yet assert on console.error / console.warn counts because
 * the dashboard intentionally logs warnings on auth restore, telemetry
 * pipe failures, etc. Tightening that comes after the Tier-1 + Tier-2
 * cleanup in the same branch.
 */

import { test, expect } from '@playwright/test';

const URL = '/dashboard.html';
const SETTLE_MS = 12_000;

test.describe('dashboard.html console probe', () => {
    test('loads without uncaught exceptions', async ({ page }) => {
        const pageErrors = [];
        const consoleErrors = [];
        let diagnosticLogSeen = false;

        page.on('pageerror', (err) => {
            pageErrors.push({ name: err.name, message: err.message, stack: err.stack });
        });
        page.on('console', (msg) => {
            const text = msg.text();
            if (msg.type() === 'error') consoleErrors.push(text);
            if (text.startsWith('[Dashboard] auth gate:')) diagnosticLogSeen = true;
        });

        await page.goto(URL, { waitUntil: 'domcontentloaded' });
        // Wait past the 8-second auth.ready() race + IIFE chain.
        await page.waitForTimeout(SETTLE_MS);

        if (pageErrors.length) {
            const first = pageErrors[0];
            const msg = `Tier-1 regression: ${first.name}: ${first.message}\n` +
                        `Stack:\n${first.stack || '(none)'}\n` +
                        `Total uncaught exceptions: ${pageErrors.length}`;
            expect(pageErrors, msg).toEqual([]);
        }

        // If the diagnostic log never fired, the script died before reaching
        // line 1167 — a silent Tier-1 failure that pageerror would also have
        // surfaced, but we assert it explicitly so a regression that hangs
        // the top-level await also fails the test.
        expect(
            diagnosticLogSeen,
            'auth-gate diagnostic log never fired — module likely hung on top-level await\n' +
            `Console errors observed: ${consoleErrors.slice(0, 5).join(' | ')}`,
        ).toBe(true);
    });
});
