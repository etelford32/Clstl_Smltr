import { test, expect } from '@playwright/test';

/**
 * moon-interior-smoke.spec.js — the Moon page's Surface ⇄ Interior cutaway.
 *
 * Wikimedia texture routes are ABORTED so the run is deterministic and
 * offline-safe — MoonSkin falls back to its gray texture and the loading
 * veil still clears (that fallback path is itself worth pinning). Checks:
 *   1. Page boots with no pageerrors and no THREE.WebGLProgram shader
 *      errors — this is what catches a GLSL typo in ANY of the cutaway
 *      shaders (faces, cores, crust, ripples) or the distant-Earth shader.
 *   2. The Interior toggle swaps the panel (interior-mode class), shows the
 *      layer legend with one row per kernel layer, and flips back.
 *   3. The dynamo scrubber reports the high-field epoch at 4 Ga and
 *      exactly-dead at today — the same numbers the kernel gate pins.
 */

test.use({
    launchOptions: {
        args: ['--ignore-certificate-errors', '--allow-insecure-localhost'],
    },
    ignoreHTTPSErrors: true,
});

test('moon interior cutaway boots, toggles, and scrubs the dead dynamo', async ({ page }) => {
    const pageErrors = [];
    const shaderErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
        const t = msg.text();
        if (t.includes('THREE.WebGLProgram') || t.includes('THREE.WebGLShader')) shaderErrors.push(t);
    });

    // Deterministic offline run: no live texture fetches
    await page.route('**://upload.wikimedia.org/**', (route) => route.abort());

    await page.goto('/moon.html');
    await expect(page.locator('#loading')).toHaveClass(/done/, { timeout: 30_000 });

    // Let a few frames render so every material actually compiles
    await page.waitForTimeout(1500);
    expect(pageErrors, `page errors: ${pageErrors.join('\n')}`).toHaveLength(0);
    expect(shaderErrors, `shader errors: ${shaderErrors.join('\n')}`).toHaveLength(0);

    // Surface mode: interior section hidden, dose card visible
    await expect(page.locator('#ip-sec-interior')).toBeHidden();

    // → Interior
    await page.click('#vt-interior');
    await expect(page.locator('#info-panel')).toHaveClass(/interior-mode/);
    await expect(page.locator('#ip-sec-interior')).toBeVisible();
    // One legend row per kernel layer (5), swatches from INTERIOR_PALETTE
    await expect(page.locator('#ip-layer-legend .legend-row')).toHaveCount(5);
    // Static readouts populated from the kernel
    await expect(page.locator('#ip-p0')).toContainText('GPa');
    await expect(page.locator('#ip-g')).toContainText('1.62');

    // Dynamo scrubber: today = dead, 4 Ga = high-field epoch
    await expect(page.locator('#ip-dyn-field')).toContainText('dead');
    await page.locator('#dyn-age').fill('-4');
    await expect(page.locator('#ip-dyn-field')).toContainText('50');
    await expect(page.locator('#ip-dyn-epoch')).toContainText('High-field');
    await page.locator('#dyn-age').fill('0');
    await expect(page.locator('#ip-dyn-field')).toContainText('dead');

    // Tidal clock panel is live
    await expect(page.locator('#ip-quake-rate')).toContainText('× quiet');

    // → back to Surface
    await page.click('#vt-surface');
    await expect(page.locator('#info-panel')).not.toHaveClass(/interior-mode/);
    await expect(page.locator('#ip-sec-interior')).toBeHidden();

    // Still no errors after the whole dance
    expect(pageErrors, `late page errors: ${pageErrors.join('\n')}`).toHaveLength(0);
    expect(shaderErrors, `late shader errors: ${shaderErrors.join('\n')}`).toHaveLength(0);
});
