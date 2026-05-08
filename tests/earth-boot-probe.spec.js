import { test, expect } from '@playwright/test';

test.use({
    launchOptions: {
        args: ['--ignore-certificate-errors', '--allow-insecure-localhost'],
    },
    ignoreHTTPSErrors: true,
});

test('earth.html boot probe — dump console errors', async ({ page }) => {
    const errors = [];
    const warnings = [];
    page.on('console', (msg) => {
        const t = msg.type();
        if (t === 'error') errors.push(msg.text());
        else if (t === 'warning') warnings.push(msg.text());
    });
    page.on('pageerror', (err) => {
        errors.push('PAGE_ERROR: ' + err.message + '\n' + (err.stack ?? ''));
    });
    await page.goto('/earth.html?debug=1', { waitUntil: 'load' });
    await page.waitForTimeout(8000);

    const overlayPresent = await page.evaluate(
        () => document.getElementById('debug-overlay') != null
    );
    const fps = await page.evaluate(
        () => document.getElementById('dbg-fps')?.textContent ?? 'NA'
    );
    const simTime = await page.evaluate(
        () => document.getElementById('tc-time-utc')?.textContent ?? 'NA'
    );

    console.log('---');
    console.log('overlayPresent:', overlayPresent);
    console.log('fps:', fps);
    console.log('simTime:', simTime);
    console.log('errors count:', errors.length);
    console.log('warnings count:', warnings.length);
    if (errors.length) {
        console.log('=== ERRORS ===');
        for (const e of errors.slice(0, 20)) console.log(e);
    }
    if (warnings.length) {
        console.log('=== WARNINGS (first 10) ===');
        for (const w of warnings.slice(0, 10)) console.log(w);
    }
    expect(overlayPresent).toBe(true);
});
