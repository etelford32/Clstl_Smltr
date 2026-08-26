/**
 * nav-responsive.spec.js — the shared nav must work at every width, on touch.
 *
 * Every assertion here corresponds to a bug that was live in production on
 * 2026-08 and was found by measuring rather than by looking:
 *
 *  1. OVERFLOW. `.nav-menu` is `flex-wrap: nowrap` and every child except
 *     `.nav-utility-links` is `flex-shrink: 0`, over a `nav` that is
 *     `overflow: visible` on a body that does not scroll horizontally. So when
 *     the row exceeds the viewport the tail is not clipped, it is UNREACHABLE.
 *     Measured overflow ran from +12px at 1400 to +413px at 1025 — i.e. "Sign
 *     Up Free" did not exist for anyone on a 1366 or 1440 laptop.
 *
 *  2. TAP CANNOT OPEN A DROPDOWN. The hover handlers were gated on a
 *     `ppLastWasTouch` flag that the browser's own compatibility `mousemove`
 *     reset between touchstart and click, so every tap opened a dropdown via
 *     mouseenter and then the click toggled it shut. Nobody on a phone could
 *     open a submenu at all.
 *
 *  3. CLIPPED ACCORDION. `max-height: 600px`, commented "large enough for any
 *     dropdown content", against a Space Weather menu carrying 1015px — its
 *     bottom 415px were unreachable.
 *
 *  4. ORPHANED SCROLL LOCK. initNav() re-renders on `auth-changed` (~2-3s
 *     after load). That replaced the menu, dropping `.open` while
 *     `document.body.style.overflow` stayed 'hidden' — only _closeAll() clears
 *     it, and nothing called it. Tap the burger early on a slow connection and
 *     the page was left permanently unscrollable.
 *
 *  5. SUB-44px TOUCH TARGETS in the mobile panel.
 *
 *  6. THE SAME CLIP, ON THE VERTICAL AXIS, ON DESKTOP. Bug 3 was fixed for the
 *     mobile accordion and nobody checked the desktop panel, which is
 *     `position: absolute` under the bar with nothing to scroll it. The Space
 *     Weather menu reached 18 links / 1110px and lost its bottom 7 links on a
 *     1366x768 laptop, 4 on a 1440x900. Every check here before 2026-08-25
 *     measured width; not one measured height.
 *
 * These run against simulations.html rather than index.html on purpose: the
 * home page runs a live 3D magnetosphere that starves the main thread, and a
 * CSS transition read mid-animation produces flaky heights. The nav is
 * identical on every page.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = '/simulations.html';
const BURGER_MAX = 1280;          // must match both files — asserted below

/**
 * Wait until the nav has stopped re-rendering.
 *
 * initNav() rebuilds `nav.innerHTML` on `auth-changed`, which lands somewhere
 * around 2-3s depending on how fast the Supabase session resolves — i.e. right
 * where a fixed sleep wants to be. Interacting across that boundary reads a
 * box from a node that is about to be replaced, and the tap lands on nothing.
 *
 * Waiting for a quiet period on the nav's own childList is deterministic and
 * does not care how slow the environment is.
 */
async function waitForNavStable(page, quietMs = 700) {
    await page.waitForSelector('#nav-burger', { state: 'attached' });
    await page.evaluate(quiet => new Promise(resolve => {
        const nav = document.querySelector('nav');
        let timer;
        const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(finish, quiet);
        });
        const finish = () => { observer.disconnect(); resolve(); };
        observer.observe(nav, { childList: true });
        timer = setTimeout(finish, quiet);
    }), quietMs);
}

/** Right-most edge of the bar's last visible element. */
const lastEdge = (page) => page.evaluate(() => {
    const menu = document.querySelector('nav .nav-menu');
    const kids = [...menu.children].filter(el => getComputedStyle(el).display !== 'none');
    return kids[kids.length - 1].getBoundingClientRect().right;
});

async function tap(page, locator) {
    const box = await locator.boundingBox();
    if (!box) throw new Error('element has no box — is the menu closed?');
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

test.describe('nav — desktop widths', () => {
    test('the burger breakpoint agrees between CSS and JS', () => {
        // js/nav.js gates hover logic on MOBILE_NAV_MAX; js/nav-styles.css
        // decides what is actually shown. If they drift, hover handlers fire
        // on an accordion (or the panel never closes after a link tap — that
        // check read a hardcoded 1024 for exactly this reason).
        const js = readFileSync(join(ROOT, 'js', 'nav.js'), 'utf8');
        const css = readFileSync(join(ROOT, 'js', 'nav-styles.css'), 'utf8');

        const jsMax = js.match(/const MOBILE_NAV_MAX\s*=\s*(\d+)/)?.[1];
        expect(jsMax, 'MOBILE_NAV_MAX not found in js/nav.js').toBeDefined();
        expect(Number(jsMax)).toBe(BURGER_MAX);
        expect(css, `js/nav-styles.css has no @media (max-width: ${BURGER_MAX}px) burger block`)
            .toContain(`@media (max-width: ${BURGER_MAX}px)`);
        // And no stray second breakpoint left behind in the JS.
        expect(js.match(/innerWidth <= 1024/), 'js/nav.js still hardcodes 1024').toBeNull();
    });

    for (const state of ['signed out', 'admin']) {
        test(`the bar fits the viewport at every desktop width — ${state}`, async ({ page }) => {
            // admin is the widest bar there is: utility links + bell + SUPER
            // badge + Sign Out. If it fits, everything fits.
            if (state === 'admin') {
                await page.addInitScript(() => localStorage.setItem('pp_auth', JSON.stringify(
                    { signedIn: true, plan: 'enterprise', role: 'superadmin', id: 'test-admin' })));
            }
            await page.setViewportSize({ width: 1600, height: 900 });
            await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
            await waitForNavStable(page);

            // 1281 = first desktop pixel; 1519/1520 straddle the compact tier.
            for (const width of [1281, 1366, 1440, 1519, 1520, 1600, 1920]) {
                await page.setViewportSize({ width, height: 900 });
                await page.waitForTimeout(120);
                expect(await lastEdge(page),
                    `nav overflows the viewport at ${width}px (${state}) — the tail is unreachable`)
                    .toBeLessThanOrEqual(width);
            }
        });
    }

    /**
     * THE VERTICAL AXIS — bug 6, and it was live in production until
     * 2026-08-25.
     *
     * Every check above measures width. Nobody measured height, and a dropdown
     * panel is `position: absolute` under a 50px bar inside a `nav` that is
     * `overflow: visible`, on a body that does not scroll to reach it. So a
     * panel taller than the viewport is not clipped and not scrollable: its
     * tail does not exist for the user. Exactly the `max-height: 600px`
     * accordion failure (bug 3), rotated 90°.
     *
     * "Space Weather" had grown to 18 links and 1110px. Measured on the day
     * this test was written, against the shipped bar:
     *
     *     1366×768    7 links unreachable  (Jupiter … Galaxy)
     *     1536×864    5 links unreachable
     *     1440×900    4 links unreachable
     *     1920×1080   2 links unreachable
     *
     * 768 is the floor that matters — it is the shortest laptop still in wide
     * use, and it is where the loss was worst.
     */
    for (const height of [768, 864, 900, 1080]) {
        test(`every dropdown fits a ${height}px-tall screen`, async ({ page }) => {
            await page.setViewportSize({ width: 1600, height });
            await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
            await waitForNavStable(page);

            const offScreen = await page.evaluate(() => {
                const bad = [];
                for (const drop of document.querySelectorAll('nav .nav-drop')) {
                    // Open by class rather than by hovering: the reveal is a
                    // 200ms opacity/transform transition, and a height read
                    // mid-animation is the flake this file already documents.
                    drop.classList.add('open');
                    for (const link of drop.querySelectorAll('.nav-drop-link')) {
                        const box = link.getBoundingClientRect();
                        if (box.bottom > window.innerHeight) {
                            bad.push(`${drop.dataset.drop} › ${link.querySelector('.ndl-title')?.textContent.trim()}`);
                        }
                    }
                    drop.classList.remove('open');
                }
                return bad;
            });

            expect(offScreen,
                `these menu links render below the fold at ${height}px and cannot be reached — `
                + `nothing scrolls a dropdown panel. Move them onto the section's hub page `
                + `(js/site-sections.js documents the cap) rather than lengthening the menu`)
                .toEqual([]);
        });
    }

    /**
     * The scroll backstop, verified independently of the cap above.
     *
     * The cap is editorial and can be argued with; this is the mechanism that
     * makes an overrun survivable. `.nav-drop-inner` carries `max-height` +
     * `overflow-y: auto`, so a menu that outgrows the screen degrades to a
     * scroll instead of silently losing links. It is deliberately NOT on
     * `.nav-drop-menu`: that element owns the `::before` hover bridge at
     * `top: -12px`, which a scroll container would clip away.
     */
    test('a dropdown taller than the screen scrolls rather than vanishing', async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 700 });
        await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
        await waitForNavStable(page);

        const result = await page.evaluate(() => {
            const drop = document.querySelector('nav .nav-drop');
            drop.classList.add('open');
            const inner = drop.querySelector('.nav-drop-inner');
            const menu = drop.querySelector('.nav-drop-menu');

            // Force an overrun: 40 clones of the first link is far past any
            // plausible menu, so this tests the mechanism, not today's counts.
            const link = inner.querySelector('.nav-drop-link');
            for (let i = 0; i < 40; i++) inner.appendChild(link.cloneNode(true));

            const innerStyle = getComputedStyle(inner);
            return {
                scrolls: innerStyle.overflowY === 'auto' || innerStyle.overflowY === 'scroll',
                fitsViewport: menu.getBoundingClientRect().bottom <= window.innerHeight + 1,
                hasOverflow: inner.scrollHeight > inner.clientHeight,
                // The bridge must survive: a clipped ::before drops the pointer
                // between the chip and the panel on the way down.
                menuNotClipped: getComputedStyle(menu).overflowY === 'visible',
            };
        });

        expect(result.scrolls, '.nav-drop-inner must be scrollable').toBe(true);
        expect(result.hasOverflow, 'the forced overrun did not actually overflow — check the fixture').toBe(true);
        expect(result.fitsViewport, 'an over-long panel still runs past the bottom of the screen').toBe(true);
        expect(result.menuNotClipped,
            '.nav-drop-menu must stay overflow:visible or it clips the ::before hover bridge').toBe(true);
    });

    test('hover opens and closes a dropdown on a real pointer', async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 900 });
        await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
        await waitForNavStable(page);

        const drop = page.locator('nav .nav-drop').nth(1);
        await page.locator('nav .nav-drop-btn').nth(1).hover();
        await expect(drop).toHaveClass(/open/);
        await expect(drop.locator('.nav-drop-menu')).toBeVisible();

        await page.mouse.move(20, 500);
        await expect(drop).not.toHaveClass(/open/);
    });

    /**
     * The split chip: the label navigates, the caret opens.
     *
     * Both halves have to work, and each is a different failure. A label that
     * does not navigate is the old menu-only bar this restructure replaced; a
     * caret that navigates instead of opening makes every menu unreachable.
     */
    test('the top-level label links to its hub and the caret opens the menu', async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 900 });
        await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
        await waitForNavStable(page);

        const drops = page.locator('nav .nav-drop');
        expect(await drops.count()).toBeGreaterThan(0);

        // Every section label is a real link to a flat root page.
        const hrefs = await page.locator('nav .nav-drop .nav-drop-btn').evaluateAll(
            els => els.map(el => el.getAttribute('href')));
        expect(hrefs.length).toBe(await drops.count());
        for (const href of hrefs) expect(href).toMatch(/^\/[a-z0-9-]+\.html$/);

        const first = drops.first();

        // The caret toggles. dispatchEvent, NOT click(): a real click moves the
        // pointer onto the chip first, and on a hover-capable device that
        // `mouseenter` has already opened the menu — so the click that follows
        // is the one that CLOSES it, and an assertion for `open` fails on
        // behaviour that is actually correct. Dispatching skips the pointer
        // entirely, which is the only way to read the click handler alone.
        await first.locator('.nav-drop-toggle').dispatchEvent('click');
        await expect(first).toHaveClass(/open/);
        await expect(first.locator('.nav-drop-toggle')).toHaveAttribute('aria-expanded', 'true');

        await first.locator('.nav-drop-toggle').dispatchEvent('click');
        await expect(first).not.toHaveClass(/open/);
        await expect(first.locator('.nav-drop-toggle')).toHaveAttribute('aria-expanded', 'false');

        // The caret must not navigate — it is a <button>, and if it ever
        // becomes a link the menus stop being reachable by click at all.
        const url = page.url();
        await first.locator('.nav-drop-toggle').click();
        await page.waitForTimeout(150);
        expect(page.url(), 'the caret navigated — it is a disclosure button, not a link').toBe(url);

        // The label does navigate, to that section's hub.
        await first.locator('.nav-drop-btn').click();
        await page.waitForURL(`**${hrefs[0]}`);
    });
});

test.describe('nav — touch', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('every dropdown opens on tap and shows all of its links', async ({ page }) => {
        await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
        await waitForNavStable(page);

        await tap(page, page.locator('#nav-burger'));
        await expect(page.locator('#nav-menu')).toHaveClass(/open/);

        const count = await page.locator('nav .nav-drop').count();
        expect(count).toBeGreaterThan(0);

        for (let i = 0; i < count; i++) {
            // Bring the row to the top of the scrolling panel and let it
            // settle before reading a box — the panel moves as menus expand.
            await page.evaluate(i => document.querySelectorAll('.nav-drop')[i]
                .scrollIntoView({ block: 'start' }), i);
            await page.waitForTimeout(220);
            // The CARET, not the label. The label is a link to the section hub
            // now; tapping it navigates away, which would end this test on a
            // different page with the panel closed.
            await tap(page, page.locator('nav .nav-drop-toggle').nth(i));

            // Wait for the accordion to STOP MOVING, rather than for a fixed
            // 650ms. The old sleep was "280ms transition + slack" and it was
            // flaky under load — a height read one frame early looks exactly
            // like the clipping bug this test exists to catch, so the failure
            // it produces is a lie. Polling the height until two reads agree
            // removes the timing dependence entirely.
            await expect.poll(async () => page.evaluate(i => {
                const menu = document.querySelectorAll('.nav-drop')[i].querySelector('.nav-drop-menu');
                const h = Math.round(menu.getBoundingClientRect().height);
                const settled = menu.dataset.lastH === String(h);
                menu.dataset.lastH = String(h);
                return settled && h > 0;
            }, i), { timeout: 5000, intervals: [100, 100, 150, 200, 300] }).toBe(true);

            const result = await page.evaluate(i => {
                const drop = document.querySelectorAll('.nav-drop')[i];
                const menu = drop.querySelector('.nav-drop-menu');
                const inner = menu.querySelector('.nav-drop-inner');
                const rect = menu.getBoundingClientRect();
                const links = [...menu.querySelectorAll('.nav-drop-link')];
                return {
                    label: drop.querySelector('.nav-drop-btn').textContent.replace(/[▾\s]+/g, ' ').trim(),
                    open: drop.classList.contains('open'),
                    total: links.length,
                    reachable: links.filter(l => l.getBoundingClientRect().bottom <= rect.bottom + 1).length,
                    content: inner.scrollHeight,
                    rendered: Math.round(rect.height),
                };
            }, i);

            expect(result.open, `tapping "${result.label}" did not open it`).toBe(true);
            // The accordion must render its full content — this is the
            // max-height:600px clip, and it only ever showed up as "the last
            // few links are missing", never as an error.
            expect(result.rendered,
                `"${result.label}" clips ${result.content - result.rendered}px of its own content`)
                .toBeGreaterThanOrEqual(result.content - 2);
            expect(result.reachable,
                `"${result.label}" hides ${result.total - result.reachable} of ${result.total} links`)
                .toBe(result.total);
        }
    });

    test('no touch target in the menu is under 44px', async ({ page }) => {
        await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
        await waitForNavStable(page);
        await tap(page, page.locator('#nav-burger'));
        await page.waitForTimeout(300);

        const undersized = await page.evaluate(() => {
            const out = [];
            for (const el of document.querySelectorAll('#nav-menu a, #nav-menu button, #nav-burger')) {
                const r = el.getBoundingClientRect();
                if (r.height > 0 && r.height < 44) {
                    out.push(`${(el.textContent || 'burger').trim().slice(0, 24)} = ${Math.round(r.height)}px`);
                }
            }
            return out;
        });
        expect(undersized, 'WCAG 2.5.8 wants 44px minimum').toEqual([]);
    });

    test('a nav re-render cannot orphan the body scroll lock', async ({ page }) => {
        await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
        await waitForNavStable(page);

        await tap(page, page.locator('#nav-burger'));
        await expect(page.locator('#nav-menu')).toHaveClass(/open/);
        expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');

        // Fire the same event the auth module fires once Supabase resolves.
        // This is what used to replace the menu out from under the user.
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('auth-changed')));
        await page.waitForTimeout(400);

        const after = await page.evaluate(() => ({
            open: !!document.querySelector('#nav-menu.open'),
            lock: document.body.style.overflow,
            aria: document.getElementById('nav-burger').getAttribute('aria-expanded'),
        }));
        expect(after.open, 'the menu vanished when the nav re-rendered').toBe(true);
        expect(after.aria).toBe('true');
        // The invariant that actually matters: open state and scroll lock agree.
        expect(after.lock === 'hidden', 'scroll lock left on with the menu closed').toBe(after.open);

        // Closing must release the page.
        await tap(page, page.locator('#nav-burger'));
        await page.waitForTimeout(250);
        expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    });

    /**
     * Both kinds of link in the panel must dismiss it.
     *
     * `.nav-item` is the original case. `.nav-drop-btn` is the newer one and
     * the easier to miss: it used to be the menu's toggle button and is now a
     * LINK to the section hub, so it had to be added to the handler's selector
     * list — without it, tapping "Local Space" navigated away and left the
     * panel open over the page that had just loaded.
     *
     * Both targets are deliberately light static pages: the assertion reads
     * the OLD page's state 250ms after the tap, so a heavy 3D destination
     * would race the check.
     */
    for (const target of [
        { selector: 'nav a.nav-item[href="/signin.html"]', what: 'a top-level nav item' },
        { selector: 'nav .nav-drop .nav-drop-btn', what: 'a section label' },
    ]) {
        test(`tapping ${target.what} closes the panel at every burger width`, async ({ page }) => {
            for (const width of [390, 1100, BURGER_MAX]) {
                await page.setViewportSize({ width, height: 800 });
                await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
                await waitForNavStable(page);

                await tap(page, page.locator('#nav-burger'));
                await expect(page.locator('#nav-menu')).toHaveClass(/open/);
                await tap(page, page.locator(target.selector).first());
                await page.waitForTimeout(250);

                expect(await page.evaluate(() => !!document.querySelector('#nav-menu.open')),
                    `panel stayed open over the page after tapping ${target.what} at ${width}px`).toBe(false);
                expect(await page.evaluate(() => document.body.style.overflow),
                    `scroll lock left on at ${width}px`).toBe('');
            }
        });
    }

    test('no page scrolls horizontally at any phone or tablet width', async ({ page }) => {
        await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
        await waitForNavStable(page);

        for (const [width, height] of [[320, 568], [390, 844], [844, 390], [768, 1024], [1024, 1366], [1280, 800]]) {
            await page.setViewportSize({ width, height });
            await page.waitForTimeout(160);
            const probe = await page.evaluate(() => {
                const brand = document.querySelector('.nav-brand').getBoundingClientRect();
                const burger = document.getElementById('nav-burger').getBoundingClientRect();
                return {
                    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    overlap: brand.right - burger.left,
                    burgerShown: getComputedStyle(document.getElementById('nav-burger')).display !== 'none',
                };
            });
            expect(probe.overflow, `horizontal scroll at ${width}×${height}`).toBe(0);
            expect(probe.overlap, `brand collides with the burger at ${width}px`).toBeLessThan(0);
            expect(probe.burgerShown, `no burger at ${width}px`).toBe(true);
        }
    });
});
