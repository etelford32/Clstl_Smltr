import { test, expect } from '@playwright/test';

/**
 * cloud-shells-smoke.spec.js — Phase-2 split cloud shells.
 *
 * Pins the cloud quality via ?cloud_quality=1 so the perf governor (which
 * legitimately collapses the shells on struggling GPUs — headless software
 * GL very much included) can't race the assertions. Checks:
 *   1. All four CLOUD_FRAG variants (composite + 3 SHELL_SPLIT layers)
 *      compile — a GLSL error would surface as a THREE.WebGLProgram console
 *      error and a black shell.
 *   2. Mode routing: full quality → split; below the tier → composite;
 *      research mode → composite (measured-only never implies vertical
 *      structure); clouds off → off.
 *   3. No page errors through the whole dance.
 */

test.use({
    launchOptions: {
        args: ['--ignore-certificate-errors', '--allow-insecure-localhost'],
    },
    ignoreHTTPSErrors: true,
});

test('split cloud shells compile, route by tier + research mode', async ({ page }) => {
    const pageErrors = [];
    const shaderErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
        const t = msg.text();
        if (/THREE\.WebGLProgram|Shader Error|VALIDATE_STATUS/i.test(t)) shaderErrors.push(t);
    });

    // Governor pinned at full quality → split mode is the boot state.
    await page.goto('/earth.html?cloud_quality=1', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.__evCloudMode === 'function');
    // Let a few frames render so all shell programs actually compile/link.
    await page.waitForTimeout(4000);

    expect(await page.evaluate(() => window.__evCloudMode())).toBe('split');

    // Dropping below the full tier collapses to the classic composite shell.
    await page.evaluate(() => window.setCloudQuality(0.33));
    expect(await page.evaluate(() => window.__evCloudMode())).toBe('composite');

    await page.evaluate(() => window.setCloudQuality(1));
    expect(await page.evaluate(() => window.__evCloudMode())).toBe('split');

    // Research (measured-only) mode always renders the single composite.
    await page.evaluate(() => {
        const el = document.getElementById('lyr-research-mode');
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(await page.evaluate(() => window.__evCloudMode())).toBe('composite');
    await page.evaluate(() => {
        const el = document.getElementById('lyr-research-mode');
        el.checked = false;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(await page.evaluate(() => window.__evCloudMode())).toBe('split');

    // Clouds off hides both paths.
    await page.evaluate(() => {
        const el = document.getElementById('lyr-clouds');
        el.checked = false;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(await page.evaluate(() => window.__evCloudMode())).toBe('off');
    await page.evaluate(() => {
        const el = document.getElementById('lyr-clouds');
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(await page.evaluate(() => window.__evCloudMode())).toBe('split');

    // One more render window after all the mode flips, then assert clean.
    await page.waitForTimeout(1500);
    expect(shaderErrors, shaderErrors.join('\n')).toHaveLength(0);
    expect(pageErrors, pageErrors.join('\n')).toHaveLength(0);
});
