import { test, expect } from '@playwright/test';

/**
 * colony-smoke.spec.js — the Lunar Colony RTS page (colony.html).
 *
 * The physics/economy is gated in Node (tests/colony-engine.mjs); this spec
 * covers the page: boot without errors, the site-survey start flow, the
 * StarCraft verbs at the UI level (box-select → order → event log), the
 * build-menu ghost flow, and save/continue. Quiet mode keeps the run
 * network-independent; NOAA routes are never awaited.
 */

test.use({
    launchOptions: {
        args: ['--ignore-certificate-errors', '--allow-insecure-localhost'],
    },
    ignoreHTTPSErrors: true,
});

test('colony RTS boots, lands crew, selects and orders units, saves', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/colony.html');

    // Start overlay: full Artemis III survey, mode picker, disabled start
    await expect(page.locator('#start-overlay')).toBeVisible();
    expect(await page.locator('.site-card').count()).toBeGreaterThanOrEqual(13);
    await expect(page.locator('#btn-start')).toBeDisabled();

    // Quiet mode (deterministic, offline-safe), top-scored site, land
    await page.click('.mode-btn[data-mode="quiet"]');
    await page.locator('.site-card').first().click();
    await expect(page.locator('#btn-start')).toBeEnabled();
    await page.click('#btn-start');
    await expect(page.locator('#start-overlay')).toBeHidden();

    // HUD populates from the engine
    await expect(page.locator('#r-water')).not.toHaveText('—');
    await expect(page.locator('#r-crew')).toHaveText(/4\/4/);
    await expect(page.locator('#clk-sol')).toContainText('Sol 1');
    // Touchdown log line present
    await expect(page.locator('#ev-log')).toContainText('Touchdown');

    // Build menu: one button per catalog entry; ghost toggles
    expect(await page.locator('.bm-btn').count()).toBe(5);
    await page.locator('.bm-btn[data-b="solar"]').click();
    await expect(page.locator('.bm-btn[data-b="solar"]')).toHaveClass(/on/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.bm-btn[data-b="solar"]')).not.toHaveClass(/on/);

    // Box-select the starting crew near the lander → selection panel appears
    const canvas = page.locator('#world');
    const box = await canvas.boundingBox();
    const cx = box.x + box.width * 0.42, cy = box.y + box.height * 0.55;
    await page.mouse.move(cx - 120, cy - 90);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 90, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator('#sel-panel')).toBeVisible();
    await expect(page.locator('#sel-panel')).toContainText(/astronaut|rover/);

    // Right-click issues a move order without errors
    await page.mouse.click(cx + 160, cy - 60, { button: 'right' });

    // Panic button hits the engine and the log says so
    await page.click('#shelter-all');
    await expect(page.locator('#ev-log')).toContainText('All crew ordered to shelter');

    // Sim actually advances at speed
    await page.click('.spd button[data-spd="16"]');
    const sol0 = await page.locator('#clk-sol').textContent();
    await page.waitForTimeout(1500);
    const sol1 = await page.locator('#clk-sol').textContent();
    expect(sol1).not.toBe(sol0);

    // Save + continue flow survives a reload
    await page.waitForTimeout(500);
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
    await page.reload();
    await expect(page.locator('#start-overlay')).toBeVisible();
    await expect(page.locator('#btn-continue')).toBeVisible();
    await page.click('#btn-continue');
    await expect(page.locator('#start-overlay')).toBeHidden();
    await expect(page.locator('#ev-log')).toContainText('Touchdown');

    expect(pageErrors, `page errors: ${pageErrors.join('\n')}`).toHaveLength(0);
});
