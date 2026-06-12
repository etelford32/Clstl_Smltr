// One-off: measure earth.html rAF cadence at cloud quality tiers under
// software GL. Not a CI test — a measurement harness for the adaptive
// cloud-quality change. Usage: node scripts/measure-cloud-quality.mjs
import { chromium } from 'playwright';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:8000';

async function measure(browser, quality) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => console.error('PAGE_ERROR', e.message));
    await page.goto(`${BASE}/earth.html?debug=1&cloud_quality=${quality}`, { waitUntil: 'load' });
    await page.waitForTimeout(9000);   // let boot + first paints settle
    const fps = await page.evaluate(() => new Promise((res) => {
        let n = 0;
        const t0 = performance.now();
        const loop = () => {
            n++;
            if (performance.now() - t0 < 6000) requestAnimationFrame(loop);
            else res(n / ((performance.now() - t0) / 1000));
        };
        requestAnimationFrame(loop);
    }));
    await page.close();
    return fps;
}

const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--ignore-certificate-errors'],
});
for (const q of [1, 0.66, 0.33]) {
    const fps = await measure(browser, q);
    console.log(`cloud_quality=${q}  →  ${fps.toFixed(2)} fps (software GL)`);
}
await browser.close();
