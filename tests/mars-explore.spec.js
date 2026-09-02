import { test, expect } from '@playwright/test';

/**
 * Browser gate for EXPLORING mars.html — picking features, the feature index,
 * and the pointer/touch contract.
 *
 * tests/mars-smoke.spec.js already covers that the page boots and that a
 * landmark is hoverable somewhere. This suite covers the part that was
 * broken or missing:
 *
 *   1. A landmark BEHIND the planet must not be pickable. The hit meshes are
 *      never hidden (only labels are LOD-gated) and the globe mesh is not in
 *      the raycast set, so a ray through the middle of the disc used to strike
 *      markers on the far side — measured at 11 of 18 landmarks pickable
 *      through Mars. That reads as the page picking at random.
 *   2. The feature index. The atlas holds 18 features but the LOD only labels
 *      priority-1 at mission-orbit range, so 14 of them could only be found by
 *      sweeping the cursor over the sphere and hoping.
 *   3. The double-tap window is measured off `event.timeStamp`, not off when
 *      the handler happened to run.
 *
 * Feeds are unrouted here and fall back by design; this file is about input.
 */

const IGNORED_CONSOLE_ERRORS = [
    /fonts\.googleapis\.com/,
    /\/api\/telemetry\//,
    /\/api\/mars\//,
    /\/api\/horizons/,
    /trek\.nasa\.gov/,
];

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        if (message.type() !== 'error') return;
        const text = message.text();
        const location = message.location?.()?.url || '';
        if (IGNORED_CONSOLE_ERRORS.some(p => p.test(text) || p.test(location))) return;
        errors.push(text);
    });
    return errors;
}

async function bootMars(page) {
    await page.goto('/mars.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__marsLab, null, { timeout: 90_000 });
    // The facing map is refreshed by MarsLandmarks.update() on the render loop,
    // so picking state is only meaningful once frames have run.
    await expect.poll(
        async () => (await page.evaluate(() => window.__marsLab.landmarkIndex()))
            .features.filter(f => f.frontFacing).length,
        { timeout: 60_000 },
    ).toBeGreaterThan(0);
}

const index = (page) => page.evaluate(() => window.__marsLab.landmarkIndex());

test('A landmark behind the planet cannot be picked through it', async ({ page }) => {
    const errors = collectPageErrors(page);
    await bootMars(page);

    const { features } = await index(page);
    expect(features.length).toBe(18);

    const behind = features.filter(f => !f.frontFacing);
    const inFront = features.filter(f => f.frontFacing);
    // Any single view of a sphere hides roughly half the atlas; if this is ever
    // zero the test has stopped testing anything.
    expect(behind.length, 'some of the atlas is on the far side').toBeGreaterThan(0);
    expect(inFront.length, 'and some of it faces the camera').toBeGreaterThan(0);

    // THE FIX. Picking used to go on category visibility alone.
    expect(behind.filter(f => f.pickable).map(f => f.name),
        'nothing behind Mars is pickable').toEqual([]);
    // And the fix must not have made everything unpickable, which would pass
    // the assertion above while breaking the page.
    expect(inFront.some(f => f.pickable), 'near-side landmarks stay pickable').toBe(true);
    expect(errors).toEqual([]);
});

test('The feature index reaches every landmark, including the far side', async ({ page }) => {
    test.slow();
    const errors = collectPageErrors(page);
    await bootMars(page);

    const rows = page.locator('#feature-list .feature-item');
    await expect(rows).toHaveCount(18);

    // Pick something the globe is currently hiding — the case the index exists
    // for. Flying there is what brings it onto the near hemisphere and inside
    // the LOD, so it becomes clickable on the globe too.
    const hidden = (await index(page)).features.find(f => !f.frontFacing);
    expect(hidden, 'a far-side feature to fly to').toBeTruthy();

    await page.locator(`#feature-list .feature-item:has-text("${hidden.name}")`).first().click();
    await expect.poll(
        async () => (await index(page)).features.find(f => f.name === hidden.name)?.frontFacing,
        { timeout: 40_000 },
    ).toBe(true);

    const after = (await index(page)).features.find(f => f.name === hidden.name);
    expect(after.pickable, `${hidden.name} is reachable on the globe after flying`).toBe(true);
    await expect(page.locator('#landmark-card')).toBeVisible();
    await expect(page.locator('#landmark-card-name')).toHaveText(hidden.name);
    // The card's own "Fly here" must target what the card describes, not the
    // previous focus — showLandmark sets cardFocusAction and focusSurfacePoint
    // overwrites lastSurfaceFocus, so the order of those two calls matters.
    await expect(page.locator('#landmark-card-focus')).toHaveText(/fly here/i);
    expect(errors).toEqual([]);
});

test('The feature filter narrows the list and explains an empty result', async ({ page }) => {
    await bootMars(page);
    const rows = page.locator('#feature-list .feature-item');

    await page.fill('#feature-filter', 'olymp');
    // Substring match across the whole atlas: Olympus Mons AND Olympica Fossae.
    await expect.poll(async () => rows.evaluateAll(
        els => els.filter(e => !e.hidden).map(e => e.querySelector('.feature-name').textContent),
    )).toEqual(['Olympus Mons', 'Olympica Fossae']);

    // A hidden row must actually be gone. `.feature-item` sets `display:grid`,
    // and an AUTHOR display beats the UA sheet's `[hidden]{display:none}` — so
    // without the explicit `.feature-item[hidden]` rule the filter set `hidden`
    // on every non-matching row and all 18 stayed on screen. Measured.
    await expect(rows.filter({ hasText: 'Hellas Planitia' })).toBeHidden();

    await page.fill('#feature-filter', 'zzzzz');
    await expect(page.locator('#feature-empty')).toBeVisible();

    await page.fill('#feature-filter', '');
    await expect.poll(async () => rows.evaluateAll(els => els.filter(e => !e.hidden).length)).toBe(18);
});

test('Hovering shows the affordance, clicking opens the card, clicking away dismisses it',
    async ({ page }) => {
        // Flies the camera and then sweeps for a hover — minutes under suite
        // load on software GL.
        test.slow();
        const errors = collectPageErrors(page);
        await bootMars(page);
        const box = await page.locator('#mars-canvas').boundingBox();

        // Fly to a known feature so there is something under a known point,
        // rather than sweeping the sphere hoping to land on a marker.
        await page.evaluate(() => window.__marsLab.selectFeature('Olympus Mons'));
        await page.waitForTimeout(6000);
        await page.locator('#landmark-card-close').click();
        await expect(page.locator('#landmark-card')).toBeHidden();

        // The feature is now centred, so the middle of the canvas is over it.
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        let hovered = null;
        for (const [dx, dy] of [[0, 0], [0, -18], [18, 0], [-18, 0], [0, 18], [26, 26], [-26, -26]]) {
            await page.mouse.move(cx + dx, cy + dy);
            await page.waitForTimeout(90);
            await page.mouse.move(cx + dx + 1, cy + dy);   // beat the hover throttle
            await page.waitForTimeout(120);
            const state = await page.evaluate(() => window.__marsLab.hoverState());
            if (state.cursor === 'pick') { hovered = { ...state, x: cx + dx, y: cy + dy }; break; }
        }
        expect(hovered, 'the centred feature is hoverable').toBeTruthy();
        await expect(page.locator('#mars-canvas')).toHaveAttribute('data-hover', 'pick');
        await expect(page.locator('#camera-help')).toContainText(hovered.label);

        await page.mouse.move(hovered.x, hovered.y);
        await page.mouse.down();
        await page.mouse.up();
        await expect(page.locator('#landmark-card')).toBeVisible();

        // A bare click is a SELECTION, not a camera gesture — beginManualCamera
        // fires on a confirmed drag only, so the camera mode must not change.
        const mode = await page.evaluate(() => window.__marsLab.cameraState().mode);
        expect(mode).not.toBe('custom');

        // Clicking bare ground dismisses. Every card-like UI treats click-away
        // as dismissal, and the × used to be the only way to close this one.
        let dismissed = false;
        for (const [gx, gy] of [[0.30, 0.62], [0.70, 0.62], [0.32, 0.35], [0.68, 0.34]]) {
            const x = box.x + box.width * gx;
            const y = box.y + box.height * gy;
            const overCanvas = await page.evaluate(([px, py]) =>
                document.elementFromPoint(px, py)?.id === 'mars-canvas', [x, y]);
            if (!overCanvas) continue;
            await page.mouse.move(x, y);
            await page.waitForTimeout(140);
            if ((await page.evaluate(() => window.__marsLab.hoverState())).cursor === 'pick') continue;
            await page.mouse.down();
            await page.mouse.up();
            await page.waitForTimeout(500);
            if (await page.locator('#landmark-card').isHidden()) { dismissed = true; break; }
        }
        expect(dismissed, 'clicking bare ground closes the card').toBe(true);
        expect(errors).toEqual([]);
    });

test('Double-tap uses the event clock, not the handler clock', async ({ page }) => {
    test.slow();
    const errors = collectPageErrors(page);
    await bootMars(page);
    const box = await page.locator('#mars-canvas').boundingBox();
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height * 0.45);

    // Synthetic PointerEvents rather than CDP touch injection, deliberately.
    // Input.dispatchTouchEvent blocks on the renderer, and this page drives a
    // 66k-vertex terrain rebuild — two taps dispatched back-to-back arrived
    // ~900 ms apart, so CDP cannot express a fast double-tap here at all.
    // Constructed events timestamp at construction, so dispatching two pairs
    // in one task is a genuinely fast double-tap and exercises the real
    // handler path.
    const landed = await page.evaluate(([px, py]) => {
        const canvas = document.querySelector('#mars-canvas');
        // OrbitControls captures the pointer on pointerdown, and a SYNTHETIC
        // pointer id is not in the browser's pointer table, so the real
        // setPointerCapture throws NotFoundError. That is an artifact of
        // dispatching events by hand, not a page fault — stub it for the
        // dispatch and put it back, so the test's page-error assertion stays
        // strict instead of being widened to swallow a whole error class.
        const realCapture = canvas.setPointerCapture;
        const realRelease = canvas.releasePointerCapture;
        canvas.setPointerCapture = () => {};
        canvas.releasePointerCapture = () => {};
        const fire = (type, pointerId) => canvas.dispatchEvent(new PointerEvent(type, {
            pointerId, pointerType: 'touch', isPrimary: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0,
            clientX: px, clientY: py, bubbles: true, cancelable: true,
        }));
        try {
            fire('pointerdown', 11); fire('pointerup', 11);
            fire('pointerdown', 12); fire('pointerup', 12);
        } finally {
            canvas.setPointerCapture = realCapture;
            canvas.releasePointerCapture = realRelease;
        }
        return true;
    }, [x, y]);
    expect(landed).toBe(true);

    await expect.poll(async () => page.evaluate(() => window.__marsLab.cameraState().mode),
        { timeout: 45_000 }).toBe('surface');
    const surface = await page.evaluate(() => window.__marsLab.surfaceState());
    expect(surface.active).toBe(true);
    expect(Number.isFinite(surface.location.latDeg)).toBe(true);
    expect(errors).toEqual([]);
});

test('Two slow taps are two selections, not a landing', async ({ page }) => {
    await bootMars(page);
    const box = await page.locator('#mars-canvas').boundingBox();
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height * 0.45);

    // Same two taps, separated by more than the window. The page must NOT land:
    // widening the window until any two taps count would make single taps
    // unusable for selection.
    await page.evaluate(([px, py]) => {
        const canvas = document.querySelector('#mars-canvas');
        // Same synthetic-pointer stub as the test above.
        canvas.setPointerCapture = () => {};
        canvas.releasePointerCapture = () => {};
        window.__fire = (id) => {
            for (const type of ['pointerdown', 'pointerup']) {
                canvas.dispatchEvent(new PointerEvent(type, {
                    pointerId: id, pointerType: 'touch', isPrimary: true, button: 0,
                    buttons: type === 'pointerdown' ? 1 : 0,
                    clientX: px, clientY: py, bubbles: true, cancelable: true,
                }));
            }
        };
        window.__fire(21);
    }, [x, y]);
    await page.waitForTimeout(900);
    await page.evaluate(() => window.__fire(22));
    await page.waitForTimeout(3000);

    expect(await page.evaluate(() => window.__marsLab.cameraState().mode)).not.toBe('surface');
});

test('Pointer and touch gestures are wired and reported', async ({ page }) => {
    await bootMars(page);
    const box = await page.locator('#mars-canvas').boundingBox();

    const bindings = await page.evaluate(() => window.__marsLab.inputState());
    expect(bindings.mouse.primary).toBe('rotate');
    expect(bindings.touch.oneFinger).toBe('rotate');
    expect(bindings.touch.twoFinger).toBe('dolly-rotate');
    expect(bindings.touch.doubleTap).toBe('surface-target');

    // Mouse drag orbits, and a drag past the threshold DOES take the camera.
    const before = await page.evaluate(() => window.__marsLab.camera.position.toArray());
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i += 1) {
        await page.mouse.move(box.x + box.width / 2 + i * 14, box.y + box.height / 2 + i * 3);
        await page.waitForTimeout(20);
    }
    await page.mouse.up();
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => window.__marsLab.camera.position.toArray());
    const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
    expect(moved, 'drag orbits the camera').toBeGreaterThan(0.02);

    // Wheel zooms.
    const r0 = await page.evaluate(() => window.__marsLab.cameraState().rangeKm);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -700);
    await expect.poll(async () => page.evaluate(() => window.__marsLab.cameraState().rangeKm),
        { timeout: 15_000 }).toBeLessThan(r0 - 50);
});
