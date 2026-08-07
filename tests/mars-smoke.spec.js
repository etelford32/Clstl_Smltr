import { test, expect } from '@playwright/test';

const weatherPayload = {
    ls_deg: 168.4,
    message: 'Ls 168° · clear skies · τ < 0.4',
    mission: {
        perseverance: {
            status: 'operational',
            latest_drive: { sol: 1940, distance_km: 44.14, checked_at: '2026-08-05' },
            position: { sol: 1726, lat_deg: 18.427755, lon_deg: 77.235291 },
            meda_archive: { latest_verified_sol: 1726 },
        },
    },
    rovers: {
        perseverance: {
            active: true,
            sol: 1133,
            terrestrial_date: '2024-04-27',
            min_temp_C: -79.3,
            max_temp_C: -24.7,
            pressure_pa: 778.9,
            wind_speed_mps: null,
            ls_deg: 249,
            season: 'Month 9',
            observation_status: 'historical',
            observation_age_days: 830,
            source: 'NASA Mars 2020 MEDA via mars.nasa.gov',
        },
    },
};

const skyRows = {
    '10':  [100.8, -5.2, 1.486, 2.0],
    '399': [78.9, -26.7, 1.978, -7.6],
    '301': [78.8, -26.8, 1.980, -7.5],
    '1;':  [212.4, 31.2, 2.214, 8.1],
    '4;':  [301.7, 12.8, 3.441, -3.4],
};

function horizonsObserverResult(command) {
    const [azimuth, elevation, range, rate] = skyRows[command];
    return `$$SOE
 2026-Aug-05 20:00:00.000, , , ${azimuth}, ${elevation}, ${range}, ${rate},
 2026-Aug-05 21:00:00.000, , , ${azimuth + 10}, ${elevation + 5}, ${range + 0.001}, ${rate + 0.1},
$$EOE`;
}

test('Real-Time Mars boots, preserves provenance, and exposes working layers', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/api/mars/weather', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(weatherPayload),
    }));
    await page.route('**/api/horizons?**', route => {
        const command = new URL(route.request().url()).searchParams.get('COMMAND').replaceAll("'", '');
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ result: horizonsObserverResult(command) }),
        });
    });

    await page.goto('/mars.html');
    await expect(page.locator('#loading-screen')).toHaveClass(/done/, { timeout: 20_000 });
    const rejectCookies = page.getByRole('button', { name: 'Reject non-essential' });
    if (await rejectCookies.isVisible()) await rejectCookies.click();
    await expect(page.locator('#mars-canvas')).toBeVisible();
    await expect(page.locator('#drive-sol')).toHaveText('Sol 1940');
    await expect(page.locator('#fix-sol')).toHaveText('Sol 1940');
    await expect(page.locator('#pds-sol')).toHaveText('Sol 1726');
    await expect(page.locator('#route-sol')).toBeEnabled();
    await expect(page.locator('#route-sol-output')).toContainText('Sol 1940');
    await expect(page.locator('#feed-state')).toContainText('Historical MEDA summary');
    await expect(page.locator('#weather-warning')).toContainText('not live telemetry');
    await expect(page.locator('#weather-temp')).toHaveText('-79.3 → -24.7 °C');
    await expect(page.locator('#weather-wind')).toHaveText('—');
    await expect(page.locator('#sky-feed-title')).toContainText('live 5/5');
    await expect(page.locator('#sky-earth-status')).toContainText('Az');
    await expect(page.locator('#terminator-source')).toContainText('JPL Sun direction');
    await expect(page.locator('#camera-mode')).toHaveText('Mission orbit');
    await expect(page.locator('#camera-range')).toHaveAttribute('data-range-km', /\d+/);
    await expect.poll(() => page.evaluate(() => window.__marsLab.inputState())).toMatchObject({
        zoomToCursor: true,
        mouse: { primary: 'rotate', middle: 'dolly', secondary: 'rotate' },
        touch: { oneFinger: 'rotate', twoFinger: 'dolly-rotate', doubleTap: 'surface-target' },
    });
    const desktopControls = await page.evaluate(() => {
        const stage = document.querySelector('#mars-viewport').getBoundingClientRect();
        const dock = document.querySelector('.camera-dock').getBoundingClientRect();
        const missionPanel = document.querySelector('.mission-panel').getBoundingClientRect();
        return {
            stageLeft: stage.left,
            stageWidth: stage.width,
            dockLeft: dock.left,
            dockRight: dock.right,
            dockBottom: dock.bottom,
            missionTop: missionPanel.top,
        };
    });
    expect(desktopControls.dockLeft).toBeGreaterThanOrEqual(desktopControls.stageLeft);
    expect(desktopControls.dockRight).toBeLessThan(desktopControls.stageLeft + desktopControls.stageWidth / 3);
    expect(desktopControls.dockBottom).toBeLessThanOrEqual(desktopControls.missionTop);

    const clearCanvas = page.locator('#ui-panels-toggle');
    await expect(clearCanvas).toBeVisible();
    await clearCanvas.click();
    await expect(page.locator('.mars-app')).toHaveClass(/interface-clean/);
    await expect(clearCanvas).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.mission-panel')).toBeHidden();
    await expect(page.locator('.layers-panel')).toBeHidden();
    await expect(page.locator('.data-dock')).toBeHidden();
    await expect(page.locator('#mars-canvas')).toBeVisible();
    await clearCanvas.click();
    await expect(clearCanvas).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.mission-panel')).toBeVisible();

    const missionCollapse = page.locator('.mission-panel .panel-toggle');
    await missionCollapse.click();
    await expect(page.locator('.mission-panel')).toHaveClass(/collapsed/);
    await expect(missionCollapse).toHaveText('+');
    await missionCollapse.click();
    await expect(page.locator('.mission-panel .panel-body')).toBeVisible();

    const weatherCollapse = page.locator('#weather-collapse');
    await expect(weatherCollapse).toBeVisible();
    await weatherCollapse.click();
    await expect(page.locator('.data-dock')).toHaveClass(/collapsed/);
    await expect(weatherCollapse).toHaveText('+');
    await expect(page.locator('.weather-grid')).toBeHidden();
    await weatherCollapse.click();
    await expect(page.locator('.weather-grid')).toBeVisible();

    await page.locator('#camera-rover').click();
    await expect(page.locator('#camera-mode')).toContainText('Rover · sol 1940');
    await expect(page.locator('#camera-rover')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#camera-spin')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-layer="rotate"]')).not.toBeChecked();
    await expect.poll(async () => Number(await page.locator('#camera-range').getAttribute('data-range-km'))).toBeLessThan(2_000);

    const closeRange = Number(await page.locator('#camera-range').getAttribute('data-range-km'));
    await page.locator('#camera-zoom-in').click();
    await expect.poll(async () => Number(await page.locator('#camera-range').getAttribute('data-range-km'))).toBeLessThan(closeRange);

    await page.locator('#camera-surface').click();
    await expect(page.locator('#camera-mode')).toContainText('Surface · Rover');
    await expect(page.locator('#camera-surface')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#surface-explorer')).toBeVisible();
    await expect(page.locator('#surface-detail')).toContainText('MOLA macro-relief');
    await expect.poll(() => page.evaluate(() => window.__marsLab.surfaceState().active)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__marsLab.surfaceState().terrainVertices)).toBe(66_049);
    await expect.poll(async () => Number(await page.locator('#camera-range').getAttribute('data-range-km'))).toBeLessThan(50);
    await expect(page.locator('#surface-light')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#surface-grid')).toHaveAttribute('aria-pressed', 'true');

    await page.locator('#surface-collapse').click();
    await expect(page.locator('#surface-explorer')).toHaveClass(/collapsed/);
    await expect(page.locator('#surface-collapse')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.surface-nav')).toBeHidden();
    await page.locator('#surface-collapse').click();
    await expect(page.locator('.surface-nav')).toBeVisible();

    const surfaceCameraBeforeDrag = await page.evaluate(() => window.__marsLab.camera.position.toArray());
    const surfaceCanvasBox = await page.locator('#mars-canvas').boundingBox();
    await page.mouse.move(surfaceCanvasBox.x + surfaceCanvasBox.width * 0.56, surfaceCanvasBox.y + surfaceCanvasBox.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(surfaceCanvasBox.x + surfaceCanvasBox.width * 0.65, surfaceCanvasBox.y + surfaceCanvasBox.height * 0.43, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('#camera-mode')).toHaveText('Surface traverse');
    await expect.poll(async () => page.evaluate(before => {
        const current = window.__marsLab.camera.position.toArray();
        return Math.hypot(...current.map((value, index) => value - before[index]));
    }, surfaceCameraBeforeDrag)).toBeGreaterThan(0.0001);

    const surfaceRangeBeforeWheel = Number(await page.locator('#camera-range').getAttribute('data-range-km'));
    await page.mouse.wheel(0, -350);
    await expect.poll(async () => Number(await page.locator('#camera-range').getAttribute('data-range-km'))).toBeLessThan(surfaceRangeBeforeWheel);

    const surfaceCoordinatesBeforeMove = await page.locator('#surface-explorer').evaluate(element => ({
        lat: Number(element.dataset.lat),
        lon: Number(element.dataset.lon),
    }));
    await page.getByRole('button', { name: 'Move forward' }).click();
    await expect.poll(async () => page.locator('#surface-explorer').evaluate((element, before) => Math.hypot(
        Number(element.dataset.lat) - before.lat,
        Number(element.dataset.lon) - before.lon,
    ), surfaceCoordinatesBeforeMove)).toBeGreaterThan(0.01);
    await expect.poll(() => page.evaluate(() => window.__marsLab.surfaceState().trailPoints)).toBe(2);

    await page.locator('#surface-grid').click();
    await expect(page.locator('#surface-grid')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => page.evaluate(() => window.__marsLab.surfaceState().gridVisible)).toBe(false);
    await page.locator('#surface-grid').click();
    await expect(page.locator('#surface-grid')).toHaveAttribute('aria-pressed', 'true');

    await page.locator('#camera-global').click();
    await expect(page.locator('#surface-explorer')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__marsLab.surfaceState().active)).toBe(false);

    await page.locator('#camera-global').click();
    await expect(page.locator('#camera-global')).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(900);

    const positionBeforeDrag = await page.evaluate(() => window.__marsLab.camera.position.toArray());
    const canvasBox = await page.locator('#mars-canvas').boundingBox();
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.52, canvasBox.y + canvasBox.height * 0.52);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.64, canvasBox.y + canvasBox.height * 0.44, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('#camera-mode')).toHaveText('Free orbit');
    await expect.poll(async () => page.evaluate(before => {
        const current = window.__marsLab.camera.position.toArray();
        return Math.hypot(...current.map((value, index) => value - before[index]));
    }, positionBeforeDrag)).toBeGreaterThan(0.05);

    const rangeBeforeWheel = Number(await page.locator('#camera-range').getAttribute('data-range-km'));
    await page.mouse.wheel(0, -500);
    await expect.poll(async () => Number(await page.locator('#camera-range').getAttribute('data-range-km'))).toBeLessThan(rangeBeforeWheel);

    await page.locator('#camera-spin').click();
    await expect(page.locator('#camera-spin')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-layer="rotate"]')).toBeChecked();

    await page.getByRole('button', { name: 'Locate Earth in the Mars sky' }).click();
    await expect(page.locator('#camera-mode')).toHaveText('Earth sky');
    await expect(page.locator('#landmark-card')).toBeVisible();
    await expect(page.locator('#landmark-card-name')).toHaveText('Earth');
    await expect(page.locator('#landmark-card-focus')).toHaveText('Center sky');
    await page.locator('#landmark-card-close').click();
    await expect(page.locator('#landmark-card')).toBeHidden();

    const firstRouteSol = await page.locator('#route-sol').getAttribute('min');
    await page.locator('#route-sol').fill(firstRouteSol);
    await expect(page.locator('#route-sol-output')).toContainText(`Sol ${firstRouteSol}`);

    for (const layer of [
        'imagery', 'grid', 'atmosphere', 'rover', 'landing', 'route', 'waypoints',
        'landmark-volcano', 'landmark-fracture', 'landmark-basins', 'landmark-polar', 'rotate',
    ]) {
        const input = page.locator(`[data-layer="${layer}"]`);
        await input.uncheck({ force: true });
        await expect.poll(() => page.evaluate(name => window.__marsLab.layerIsVisible(name), layer)).toBe(false);
    }

    const relief = page.locator('[data-layer="relief"]');
    await expect(relief).toBeChecked();
    await relief.uncheck({ force: true });
    await expect(relief).not.toBeChecked();

    const terminator = page.locator('[data-layer="terminator"]');
    await expect(terminator).toBeChecked();
    await terminator.uncheck({ force: true });
    await expect(terminator).not.toBeChecked();

    const earthSky = page.locator('[data-layer="sky-earth"]');
    await expect(earthSky).toBeChecked();
    await earthSky.uncheck({ force: true });
    await expect(earthSky).not.toBeChecked();

    const layersPanel = page.locator('.layers-panel');
    await layersPanel.locator('.panel-toggle').click();
    await expect(layersPanel).toHaveClass(/collapsed/);
    await expect(layersPanel.locator('.panel-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(layersPanel.locator('.panel-toggle')).toHaveText('+');
    expect(errors).toEqual([]);
});

test('Real-Time Mars keeps a responsive 3D stage and explicit offline fallbacks', async ({ page, context }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/mars/weather', route => route.abort());
    await page.route('**/api/horizons?**', route => route.abort());
    await page.route('**/assets/mars/**', route => route.abort());
    await page.route('**/data/mars/perseverance-route.json', route => route.abort());

    await page.goto('/mars.html');
    await expect(page.locator('#loading-screen')).toHaveClass(/done/, { timeout: 20_000 });
    await expect(page.locator('#mars-canvas')).toBeVisible();
    await expect(page.locator('#mars-render-fallback')).toBeHidden();
    await expect(page.locator('#surface-toggle')).toBeDisabled();
    await expect(page.locator('#relief-toggle')).toBeDisabled();
    await expect(page.locator('#surface-source')).toContainText('material-color fallback');
    await expect(page.locator('#relief-source')).toContainText('smooth-sphere fallback');
    await expect(page.locator('#route-sol')).toBeDisabled();
    await expect(page.locator('#waypoints-toggle')).toBeDisabled();
    await expect(page.locator('#route-source')).toContainText('markers remain');
    await expect(page.locator('#feed-state')).toContainText('Bundled MEDA snapshot');
    await expect(page.locator('#weather-temp')).toHaveText('-79.3 → -24.7 °C');
    await expect(page.locator('#weather-season')).toHaveText('Ls 249°');
    await expect(page.locator('#weather-warning')).toContainText('Shared adapter unavailable');

    const layout = await page.evaluate(() => {
        const rect = selector => {
            const value = document.querySelector(selector).getBoundingClientRect();
            return { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height };
        };
        return {
            stage: rect('#mars-viewport'),
            canvas: rect('#mars-canvas'),
            cameraDock: rect('.camera-dock'),
            header: rect('.mars-header'),
            mission: rect('.mission-panel'),
            layers: rect('.layers-panel'),
            dock: rect('.data-dock'),
            ready: window.__marsReady,
        };
    });
    expect(layout.ready).toBe(true);
    expect(layout.stage.height).toBeGreaterThanOrEqual(350);
    expect(layout.stage.height).toBeLessThanOrEqual(430);
    expect(layout.canvas.width).toBeCloseTo(layout.stage.width, 0);
    expect(layout.canvas.height).toBeCloseTo(layout.stage.height, 0);
    expect(layout.cameraDock.left).toBeGreaterThanOrEqual(layout.stage.left);
    expect(layout.cameraDock.right).toBeLessThanOrEqual(layout.stage.right);
    expect(layout.cameraDock.bottom).toBeLessThanOrEqual(layout.stage.bottom);
    expect(layout.cameraDock.top).toBeGreaterThan(layout.header.bottom);
    expect(layout.mission.top).toBeGreaterThanOrEqual(layout.stage.bottom);
    expect(layout.layers.top).toBeGreaterThanOrEqual(layout.mission.bottom);
    expect(layout.dock.top).toBeGreaterThanOrEqual(layout.layers.bottom);

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    const mobileCanvas = await page.locator('#mars-canvas').boundingBox();
    const centerX = mobileCanvas.x + mobileCanvas.width * 0.5;
    const centerY = mobileCanvas.y + mobileCanvas.height * 0.5;
    const cameraBeforeTouch = await page.evaluate(() => window.__marsLab.camera.position.toArray());
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: centerX, y: centerY, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: centerX + 52, y: centerY - 38, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.evaluate(before => {
        const current = window.__marsLab.camera.position.toArray();
        return Math.hypot(...current.map((value, index) => value - before[index]));
    }, cameraBeforeTouch)).toBeGreaterThan(0.01);
    await expect.poll(() => page.evaluate(() => window.__marsLab.inputState().pointerType)).toBe('touch');

    const rangeBeforePinch = await page.evaluate(() => window.__marsLab.cameraState().rangeKm);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [
        { x: centerX - 24, y: centerY, id: 2 },
        { x: centerX + 24, y: centerY, id: 3 },
    ] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [
        { x: centerX - 72, y: centerY, id: 2 },
        { x: centerX + 72, y: centerY, id: 3 },
    ] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.evaluate(before => Math.abs(window.__marsLab.cameraState().rangeKm - before), rangeBeforePinch)).toBeGreaterThan(10);

    for (let tap = 0; tap < 2; tap += 1) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: centerX, y: centerY, id: 10 + tap }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await expect(page.locator('#surface-explorer')).toBeVisible();
    await expect(page.locator('#camera-mode')).toContainText('selected terrain');
    await expect(page.locator('#surface-detail')).toContainText('MOLA unavailable');
    await expect.poll(() => page.evaluate(() => window.__marsLab.surfaceState())).toMatchObject({
        active: true,
        terrainVertices: 66_049,
        hasRelief: false,
    });
    const mobileSurfaceLayout = await page.locator('#surface-explorer').evaluate(element => {
        const stage = document.querySelector('#mars-viewport').getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        return { stageLeft: stage.left, stageRight: stage.right, stageBottom: stage.bottom, left: rect.left, right: rect.right, bottom: rect.bottom };
    });
    expect(mobileSurfaceLayout.left).toBeGreaterThanOrEqual(mobileSurfaceLayout.stageLeft);
    expect(mobileSurfaceLayout.right).toBeLessThanOrEqual(mobileSurfaceLayout.stageRight);
    expect(mobileSurfaceLayout.bottom).toBeLessThanOrEqual(mobileSurfaceLayout.stageBottom);
    const fallbackSurfaceStart = await page.locator('#surface-explorer').getAttribute('data-lat');
    await page.getByRole('button', { name: 'Move forward' }).click();
    await expect.poll(() => page.locator('#surface-explorer').getAttribute('data-lat')).not.toBe(fallbackSurfaceStart);
    await page.locator('#camera-global').click();
    await expect(page.locator('#surface-explorer')).toBeHidden();

    const rejectCookies = page.getByRole('button', { name: 'Reject non-essential' });
    if (await rejectCookies.isVisible()) await rejectCookies.click();
    await page.locator('#weather-collapse').click();
    await expect(page.locator('.data-dock')).toHaveClass(/collapsed/);
    await expect(page.locator('#weather-collapse')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.weather-grid')).toBeHidden();
    await page.locator('#weather-collapse').click();
    await expect(page.locator('.weather-grid')).toBeVisible();
    expect(errors).toEqual([]);
});
