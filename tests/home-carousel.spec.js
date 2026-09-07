// home-carousel.spec.js — browser gate for the homepage background carousel
// (js/home-carousel.js, experiment home_bg_carousel). Offline-safe: the
// space-weather feed and the console's Open-Meteo calls are aborted; the
// carousel itself only needs the committed manifest + media.
//
// Pins: (1) the carousel variant mounts behind the copy with every
// registered slide that has media; (2) the caption chip is a funnel CTA
// that links at the sim; (3) control mounts nothing; (4) reduced motion
// shows a still, never cycles, and never attaches a clip; (5) the hero's
// CTAs stay clickable above the layer.

import { test, expect } from '@playwright/test';

async function offline(page) {
    await page.route('**/services.swpc.noaa.gov/**', (r) => r.abort());
    await page.route('**/api.open-meteo.com/**', (r) => r.abort());
    await page.route('**/air-quality-api.open-meteo.com/**', (r) => r.abort());
    await page.route('**/api/**', (r) => r.abort());
}

test.describe('home background carousel', () => {

    test('carousel variant mounts, cycles, and its caption is a funnel CTA', async ({ page }) => {
        test.slow();
        await offline(page);
        await page.goto('/index.html?exp_home_bg_carousel=carousel&debug=1', { waitUntil: 'domcontentloaded' });
        // The carousel mounts after the hero's import resolves; under software
        // GL that import compiles the bloom + magnetosphere shaders on the
        // main thread and can hold the page for 30–60 s (measured 30 s+ on
        // a cold CI run). Real hardware does it in ~1 s.
        await page.waitForFunction(() => !!window.__ppCarousel, null, { timeout: 90_000 });

        const slides = await page.evaluate(() => window.__ppCarousel.slides);
        expect(slides.length).toBeGreaterThanOrEqual(2);
        // The live slide leads whenever the canvas is up (software GL still
        // creates a context); every registered capture with media follows.
        for (const id of ['flux-rope', 'ring-current', 'mars', 'moon', 'earth', 'tiga', 'pollution']) {
            expect(slides, `slide ${id} present`).toContain(id);
        }

        const layer = page.locator('#hero .hc-layer');
        await expect(layer).toBeAttached();
        // Background contract: the layer never takes pointer events.
        expect(await layer.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

        // Drive to the first captured slide and check the chip.
        const firstCaptured = slides.findIndex((id) => id !== 'live-magnetosphere');
        await page.evaluate((i) => window.__ppCarousel.goTo(i), firstCaptured);
        await expect(layer).toHaveClass(/hc-covering/);
        const caption = page.locator('#hero .hc-caption');
        await expect(caption).toHaveAttribute('data-funnel-cta', `hero_carousel_${slides[firstCaptured]}`);
        await expect(caption).toHaveAttribute('href', /\.html/);
        await expect(caption).toContainText(/Captured/);
        const img = layer.locator('.hc-slide.hc-current img');
        await expect(img).toHaveAttribute('src', /assets\/home\/carousel\/.+\.jpg/);
        await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth > 0), { timeout: 15_000 }).toBe(true);

        // Dots reflect the current slide; a dot click moves it.
        await expect(page.locator('#hero .hc-dot[aria-selected="true"]')).toHaveCount(1);
        await page.locator('#hero .hc-dot').nth((firstCaptured + 1) % slides.length).click();
        await expect.poll(() => page.evaluate(() => window.__ppCarousel.index)).toBe((firstCaptured + 1) % slides.length);

        // The primary CTA is still the top hit under the pointer.
        const cta = page.locator('#hero a[data-funnel-cta="hero_magnetosphere"]');
        const box = await cta.boundingBox();
        const top = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('a')?.getAttribute('data-funnel-cta'),
            { x: box.x + box.width / 2, y: box.y + box.height / 2 });
        expect(top).toBe('hero_magnetosphere');
    });

    test('control variant mounts nothing', async ({ page }) => {
        test.slow();
        await offline(page);
        // domcontentloaded, NOT 'load'. index.html carries two lazy iframes of
        // full WebGL apps (earth.html and space-weather.html?preview=1), so the
        // load event can be minutes away on a software rasteriser — measured
        // here as a hard 60 s timeout, i.e. this gate could not fail honestly,
        // it could only time out. Wait instead for the point in the page's
        // trailing module where the mount decision has certainly been taken:
        // the hero either booted (__ppHero, set at the end of start() under
        // debug=1) or hid its canvas (the WebGL-failure and import-failure
        // paths both do). The carousel branch is the next statement after that
        // block, so a short settle past it is enough to assert the negative.
        await page.goto('/index.html?exp_home_bg_carousel=control&debug=1', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
            const c = document.getElementById('hero-canvas');
            return !!window.__ppHero || (c && c.style.display === 'none');
        }, null, { timeout: 60_000 });
        await page.waitForTimeout(2500);
        await expect(page.locator('#hero .hc-layer')).toHaveCount(0);
        expect(await page.evaluate(() => !!window.__ppCarousel)).toBe(false);
    });

    test('reduced motion: a still poster, no clip, no cycling', async ({ page }) => {
        test.slow();
        await offline(page);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto('/index.html?exp_home_bg_carousel=carousel&debug=1', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !!window.__ppCarousel, null, { timeout: 60_000 });
        const slides = await page.evaluate(() => window.__ppCarousel.slides);
        expect(slides).not.toContain('live-magnetosphere');      // no canvas → no live slide
        expect(await page.evaluate(() => window.__ppCarousel.stillsOnly)).toBe(true);
        await expect(page.locator('#hero .hc-slide.hc-current video')).toHaveCount(0);
        const before = await page.evaluate(() => window.__ppCarousel.index);
        await page.waitForTimeout(8000);
        expect(await page.evaluate(() => window.__ppCarousel.index)).toBe(before);
    });
});
