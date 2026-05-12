#!/usr/bin/env node
/**
 * probe-dashboard.mjs — headless console probe for dashboard.html
 *
 * Loads the dashboard in headless Chromium and captures the first uncaught
 * exception (plus console errors and failed network requests for context).
 * Tier-1 issues in the analysis manifest as a single early throw that
 * cascades into a dead UI — this script surfaces that throw without
 * needing a human to open DevTools.
 *
 * Usage:
 *   node scripts/probe-dashboard.mjs                      # production
 *   node scripts/probe-dashboard.mjs http://localhost:8000/dashboard.html
 *   PROBE_URL=https://… node scripts/probe-dashboard.mjs
 *   PROBE_JSON=1 node scripts/probe-dashboard.mjs         # machine-readable
 *
 * Exit codes:
 *   0  — page loaded, no uncaught exceptions
 *   1  — at least one uncaught exception (pageerror)
 *   2  — page failed to load (navigation error, browser crash, etc.)
 *
 * Requires Playwright's Chromium; install once with:
 *   npx playwright install chromium
 */

import { chromium } from 'playwright';

const DEFAULT_URL = 'https://www.parkersphysics.com/dashboard.html';
const URL_TARGET  = process.argv[2] || process.env.PROBE_URL || DEFAULT_URL;
const SETTLE_MS   = Number(process.env.PROBE_SETTLE_MS || 12_000);
const NAV_TIMEOUT = Number(process.env.PROBE_NAV_TIMEOUT_MS || 30_000);
const JSON_OUT    = process.env.PROBE_JSON === '1';

function nowIso() { return new Date().toISOString(); }

async function probe() {
    const result = {
        url: URL_TARGET,
        startedAt: nowIso(),
        navigationOk: false,
        navigationError: null,
        firstPageError: null,           // uncaught exception (Tier-1 indicator)
        pageErrors: [],
        consoleErrors: [],
        consoleWarnings: [],
        failedRequests: [],
        diagnosticLog: null,            // [Dashboard] auth gate: {...}
    };

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
    } catch (err) {
        const msg = `[probe] Failed to launch Chromium: ${err.message}\n` +
                    `        Run: npx playwright install chromium`;
        if (JSON_OUT) {
            result.navigationError = msg;
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.error(msg);
        }
        process.exit(2);
    }

    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    // Uncaught exceptions in the page — the Tier-1 signal.
    page.on('pageerror', (err) => {
        const entry = {
            t: nowIso(),
            message: err.message,
            stack: err.stack || null,
            name: err.name,
        };
        result.pageErrors.push(entry);
        if (!result.firstPageError) result.firstPageError = entry;
    });

    // Console messages — for context only. We split errors vs warnings; the
    // analysis flagged "[Dashboard] auth gate:" and "[AlertHistory] DB load
    // failed:" as diagnostic markers, so we capture those specifically.
    page.on('console', (msg) => {
        const type = msg.type();
        const text = msg.text();
        if (type === 'error') {
            result.consoleErrors.push({ t: nowIso(), text });
        } else if (type === 'warning') {
            result.consoleWarnings.push({ t: nowIso(), text });
        }
        if (!result.diagnosticLog && text.startsWith('[Dashboard] auth gate:')) {
            result.diagnosticLog = text;
        }
    });

    // 4xx/5xx and abort/timeout failures from the page's perspective.
    page.on('requestfailed', (req) => {
        result.failedRequests.push({
            t: nowIso(),
            url: req.url(),
            method: req.method(),
            failure: req.failure()?.errorText || null,
        });
    });
    page.on('response', (res) => {
        const status = res.status();
        if (status >= 400) {
            result.failedRequests.push({
                t: nowIso(),
                url: res.url(),
                method: res.request().method(),
                status,
            });
        }
    });

    try {
        await page.goto(URL_TARGET, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        result.navigationOk = true;
    } catch (err) {
        result.navigationError = err.message;
        await browser.close().catch(() => {});
        if (JSON_OUT) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            printHumanReport(result);
        }
        process.exit(2);
    }

    // Let the dashboard's top-level await + IIFE chain run. The auth-gate
    // race is bounded at 8 s (dashboard.html line 1148); we wait a bit
    // longer so the post-gate IIFEs get a chance to throw if they will.
    await page.waitForTimeout(SETTLE_MS);

    result.finishedAt = nowIso();
    await browser.close().catch(() => {});

    if (JSON_OUT) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        printHumanReport(result);
    }

    process.exit(result.firstPageError ? 1 : 0);
}

function trunc(s, n = 400) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
}

function printHumanReport(r) {
    const W = '─'.repeat(72);
    console.log(W);
    console.log(`Dashboard console probe`);
    console.log(`URL:       ${r.url}`);
    console.log(`Started:   ${r.startedAt}`);
    console.log(`Finished:  ${r.finishedAt || '(did not finish)'}`);
    console.log(W);

    if (!r.navigationOk) {
        console.log(`✗ Navigation failed: ${r.navigationError}`);
        return;
    }

    if (r.firstPageError) {
        console.log(`✗ FIRST UNCAUGHT EXCEPTION (Tier-1 indicator):`);
        console.log(`    ${r.firstPageError.name}: ${r.firstPageError.message}`);
        if (r.firstPageError.stack) {
            console.log(`    ── stack ───────────────────────────────────────────`);
            console.log(r.firstPageError.stack.split('\n').map(l => '    ' + l).join('\n'));
        }
        console.log('');
        if (r.pageErrors.length > 1) {
            console.log(`  +${r.pageErrors.length - 1} additional uncaught exception(s):`);
            for (const e of r.pageErrors.slice(1, 6)) {
                console.log(`    · ${e.name}: ${trunc(e.message, 200)}`);
            }
        }
    } else {
        console.log(`✓ No uncaught exceptions.`);
    }
    console.log('');

    console.log(`Diagnostic auth-gate log:  ${r.diagnosticLog ? 'seen' : 'NOT SEEN (script may have died before line 1167)'}`);
    if (r.diagnosticLog) console.log(`    ${trunc(r.diagnosticLog, 500)}`);
    console.log('');

    console.log(`Console errors:    ${r.consoleErrors.length}`);
    for (const c of r.consoleErrors.slice(0, 8)) {
        console.log(`    · ${trunc(c.text, 200)}`);
    }
    if (r.consoleErrors.length > 8) console.log(`    … +${r.consoleErrors.length - 8} more`);
    console.log('');

    console.log(`Console warnings:  ${r.consoleWarnings.length}`);
    for (const c of r.consoleWarnings.slice(0, 5)) {
        console.log(`    · ${trunc(c.text, 200)}`);
    }
    if (r.consoleWarnings.length > 5) console.log(`    … +${r.consoleWarnings.length - 5} more`);
    console.log('');

    console.log(`Failed requests:   ${r.failedRequests.length}`);
    for (const f of r.failedRequests.slice(0, 10)) {
        const tag = f.status ? `HTTP ${f.status}` : (f.failure || 'failed');
        console.log(`    · [${tag}] ${f.method} ${trunc(f.url, 140)}`);
    }
    if (r.failedRequests.length > 10) console.log(`    … +${r.failedRequests.length - 10} more`);
    console.log(W);
}

probe().catch((err) => {
    console.error('[probe] Unhandled error:', err);
    process.exit(2);
});
