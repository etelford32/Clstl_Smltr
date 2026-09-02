import { test, expect } from '@playwright/test';

/**
 * atmo-stack-smoke.spec.js — volumetric clouds + the vertical exaggeration ramp.
 *
 * Companion to cloud-shells-smoke.spec.js, which pins the DECAL paths. This
 * one pins the layer above them and the geometry underneath both.
 *
 *   1. Routing. Four cloud paths now exist (volumetric / split / composite /
 *      off) and only one may be live at a time. Research mode must never
 *      reach the volumetric path — measured-only means alpha = data, and a
 *      march distributes that data through a column it did not measure.
 *
 *   2. Shader compilation. A GLSL error in VOLUME_FRAG surfaces as a
 *      THREE.WebGLProgram console error and an invisible layer, which is
 *      indistinguishable from "the clouds are just thin today" by eye.
 *
 *   3. The ramp actually reaches the instances. atmo-scale's own numbers are
 *      unit-tested (tests/atmo-scale.mjs); what THIS can prove and that
 *      cannot is that the computed radii are applied to the live wind
 *      levels and cloud volume. The two are separate failures — the ramp
 *      shipped once with a deadband that swallowed its own first call, so
 *      every uniform kept its factory default while the maths was perfect.
 *
 *   4. Disclosure. The stack is stretched and the page must say by how much.
 *      A silent exaggeration is a lie about altitude on a page people read
 *      altitude off.
 *
 * Uses waitUntil:'domcontentloaded' rather than 'load' on purpose: earth.html
 * pulls textures from a CDN, and in a network-restricted runner 'load' never
 * fires even though the scene boots fine. The explicit wait for the render
 * hooks below is the real readiness signal.
 */

test.use({
    launchOptions: {
        args: ['--ignore-certificate-errors', '--allow-insecure-localhost'],
    },
    ignoreHTTPSErrors: true,
});

/** Wait until the page's debug hooks exist — i.e. the module finished booting. */
async function waitForScene(page) {
    await page.waitForFunction(
        () => typeof window.__evCloudMode === 'function'
           && typeof window.__evCamera === 'function'
           && typeof window.__evWindStack === 'function'
           && typeof window.__evSetCamDist === 'function',
        null,
        { timeout: 60_000 },
    );
    // A few frames so _applyAtmoScale has run and the shaders have linked.
    await page.waitForTimeout(2500);
}

test.describe('atmosphere stack', () => {
    test('cloud render paths route correctly and compile', async ({ page }) => {
        // Four route changes, each needing a settled frame on a software
        // rasteriser. The default 60 s is tight even at the minimum budget.
        test.setTimeout(150_000);
        const pageErrors = [];
        const shaderErrors = [];
        page.on('pageerror', (err) => pageErrors.push(err.message));
        page.on('console', (msg) => {
            const t = msg.text();
            if (msg.type() === 'error' && /WebGLProgram|Shader Error|not compiled/i.test(t)) {
                shaderErrors.push(t.slice(0, 400));
            }
        });

        // Three URL flags, each load-bearing for a runner without a GPU:
        //   cloud_quality=1  pins the tier — the governor legitimately demotes
        //                    on a struggling GPU and would race every
        //                    assertion about the top-tier path.
        //   volumetric=1     skips the arming delay. The path arms only after
        //                    a sustained good stretch of frames, which CI's
        //                    software rasteriser never delivers — so without
        //                    this the test would never reach the code it
        //                    exists to check, and would pass by never looking.
        //   cloud_steps=6    the cheapest march. This test is about ROUTING,
        //                    not fidelity, and a 48-step march on a software
        //                    rasteriser takes long enough per frame that
        //                    page.evaluate never gets a turn on the main
        //                    thread — the assertions time out on a perfectly
        //                    correct build. Routing is identical at any budget.
        await page.goto('/earth.html?verdict=0&cloud_quality=1&volumetric=1&cloud_steps=6',
                        { waitUntil: 'domcontentloaded' });
        await waitForScene(page);

        // Full tier + research off → the volumetric march.
        expect(await page.evaluate(() => window.__evCloudMode())).toBe('volumetric');

        // The explicit opt-out drops to the decal shells without touching the
        // governor, so the fallback stays reachable for A/B and for support.
        await page.evaluate(() => window.setVolumetricClouds(false));
        expect(await page.evaluate(() => window.__evCloudMode())).toBe('split');
        await page.evaluate(() => window.setVolumetricClouds(true));
        expect(await page.evaluate(() => window.__evCloudMode())).toBe('volumetric');

        // Toggles are driven programmatically, not clicked. These live inside
        // collapsible panel sections, so a real click is a test of the panel's
        // disclosure behaviour — which is nav-responsive.spec.js's job, not
        // this one's. Here the question is only what the routing does once the
        // flag flips.
        const setLayer = (id, on) => page.evaluate(([i, v]) => {
            const el = document.getElementById(i);
            if (!el) return false;
            el.checked = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }, [id, on]);

        // Research / measured-only must collapse all the way to the composite:
        // no split shells, and above all no march.
        if (await setLayer('lyr-research-mode', true)) {
            await page.waitForTimeout(400);
            expect(await page.evaluate(() => window.__evCloudMode())).toBe('composite');
            await setLayer('lyr-research-mode', false);
            await page.waitForTimeout(400);
            expect(await page.evaluate(() => window.__evCloudMode())).toBe('volumetric');
        }

        // Clouds off → nothing draws on any path.
        await setLayer('lyr-clouds', false);
        await page.waitForTimeout(400);
        expect(await page.evaluate(() => window.__evCloudMode())).toBe('off');

        expect(shaderErrors, 'VOLUME_FRAG / CLOUD_FRAG must compile').toEqual([]);
        expect(pageErrors).toEqual([]);
    });

    test('the exaggeration ramp fans the stack on approach', async ({ page }) => {
        const pageErrors = [];
        page.on('pageerror', (err) => pageErrors.push(err.message));

        // volumetric=0: this test is about GEOMETRY, and the march would only
        // starve the frame budget the camera moves need.
        await page.goto('/earth.html?verdict=0&cloud_quality=1&volumetric=0',
                        { waitUntil: 'domcontentloaded' });
        await waitForScene(page);

        // Bring every level into existence so the ramp has something to seat.
        await page.evaluate(() => {
            for (const id of ['lyr-wind', 'lyr-wind-850', 'lyr-wind-500', 'lyr-jet']) {
                const el = document.getElementById(id);
                if (el && !el.checked) {
                    el.checked = true;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        });
        await page.waitForTimeout(1200);

        const sample = async (dist) => {
            await page.evaluate((d) => window.__evSetCamDist(d), dist);
            await page.waitForTimeout(700);
            return page.evaluate(() => {
                const s = window.__evWindStack();
                const byKey = Object.fromEntries(s.levels.map((l) => [l.key, l.radius]));
                return { exag: s.exag, ...byKey };
            });
        };

        const far  = await sample(3.0);
        const near = await sample(1.05);

        // The ramp moved.
        expect(far.exag).toBeLessThan(near.exag);

        // …and the movement REACHED the instances. This is the assertion the
        // unit test cannot make: these are the radii the meshes are drawing at.
        expect(near.w850).toBeGreaterThan(far.w850 + 0.005);
        expect(near.w500).toBeGreaterThan(far.w500 + 0.02);
        expect(near.jet).toBeGreaterThan(far.jet + 0.04);

        // The surface layer is PINNED — that contrast is what makes the
        // fan-out legible, so it is a property worth failing over.
        expect(Math.abs(near.sfc - far.sfc)).toBeLessThan(0.001);

        // Ordering holds at both ends: the stack may never invert.
        for (const r of [far, near]) {
            expect(r.sfc).toBeLessThan(r.w850);
            expect(r.w850).toBeLessThan(r.w500);
            expect(r.w500).toBeLessThan(r.jet);
        }

        expect(pageErrors).toEqual([]);
    });

    test('vertical exaggeration is disclosed and tracks the ramp', async ({ page }) => {
        await page.goto('/earth.html?verdict=0&cloud_quality=1&volumetric=0',
                        { waitUntil: 'domcontentloaded' });
        await waitForScene(page);

        const note = page.locator('#wind-exag-note');
        await expect(note).toHaveCount(1);

        await page.evaluate(() => window.__evSetCamDist(3.0));
        await page.waitForTimeout(600);
        const farText = (await note.textContent()) ?? '';
        expect(farText).toMatch(/exaggerat/i);

        await page.evaluate(() => window.__evSetCamDist(1.05));
        await page.waitForTimeout(600);
        const nearText = (await note.textContent()) ?? '';

        // The disclosed number must be the LIVE one, not a constant baked in
        // at boot — a stale disclosure is worse than none.
        expect(nearText).not.toBe(farText);
        const nearFactor = Number(nearText.match(/×(\d+)/)?.[1]);
        const liveFactor = await page.evaluate(() => window.getVerticalExaggeration());
        expect(nearFactor).toBe(Math.round(liveFactor));
    });
});
