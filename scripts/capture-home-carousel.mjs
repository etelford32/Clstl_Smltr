#!/usr/bin/env node
/**
 * capture-home-carousel.mjs — record the homepage background carousel media
 * ═══════════════════════════════════════════════════════════════════════════
 * For every entry in js/home-carousel-slides.js CAPTURED_SLIDES: open the
 * real page, hide its chrome, let the scene settle, shoot a poster (JPEG)
 * and record a short muted loop (WebM), crop both to the sim's canvas, and
 * write assets/home/carousel/manifest.json — the join table
 * js/home-carousel.js reads at runtime.
 *
 *   node scripts/capture-home-carousel.mjs                # all seven, against
 *                                                         # a dev server it starts
 *   node scripts/capture-home-carousel.mjs --only mars,moon
 *   node scripts/capture-home-carousel.mjs --base http://localhost:3000
 *   node scripts/capture-home-carousel.mjs --gpu           # real GPU (see below)
 *   node scripts/capture-home-carousel.mjs --no-clip       # posters only
 *
 * WHERE TO RUN IT
 * ───────────────
 * Anywhere Playwright's Chromium runs, but the output quality follows the
 * rasteriser. CI / cloud sessions have no GPU: Chromium falls back to
 * SwiftShader, the sims run at a few fps, bloom and volumetrics never arm,
 * and the loops look like time-lapse. That is why the manifest records
 * `renderer` per slide — re-run on a machine with a GPU (`--gpu` drops the
 * software-GL flags) and the captured date + renderer update honestly. The
 * runtime never cares which; it only reads poster/clip/capturedAt.
 *
 * FFMPEG
 * ──────
 * Uses Playwright's bundled ffmpeg by default (VP8 only). Set FFMPEG=/path
 * to a full build to get VP9 (`-c:v libvpx-vp9`, ~40% smaller at the same
 * quality); the script probes the encoder and picks the best available.
 *
 * MEDIA BUDGET
 * ────────────
 * Posters 1600×900 JPEG q80 (~150–300 kB), clips 1280×720 VP8 ~900 kbps ×
 * 6–7 s (~700–800 kB). Only the current slide's clip is ever fetched, so
 * the page cost is one poster + one clip at a time, not the whole set.
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { CAPTURED_SLIDES, MEDIA_DIR } = await import(pathToFileURL(path.join(ROOT, 'js/home-carousel-slides.js')).href);

// ── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt  = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY   = opt('--only', '').split(',').map(s => s.trim()).filter(Boolean);
const GPU    = flag('--gpu');
const NOCLIP = flag('--no-clip');
const PORT   = Number(opt('--port', '8765'));
let   BASE   = opt('--base', '');
const VIEW   = { width: 1600, height: 900 };
const CLIP_W = 1280;

// ── ffmpeg ─────────────────────────────────────────────────────────────────
function findFfmpeg() {
    if (process.env.FFMPEG && existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
    try {
        const require = createRequire(import.meta.url);
        const reg = require('playwright-core/lib/server/registry/index.js');
        const exe = reg.registry?.findExecutable?.('ffmpeg')?.executablePath?.();
        if (exe && existsSync(exe)) return exe;
    } catch {}
    const which = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache/ms-playwright');
    try {
        const { readdirSync } = await_import_fs();
        for (const d of readdirSync(base)) {
            if (!d.startsWith('ffmpeg')) continue;
            for (const f of ['ffmpeg-linux', 'ffmpeg-mac', 'ffmpeg-win64.exe', 'ffmpeg-mac-arm64']) {
                const p = path.join(base, d, f);
                if (existsSync(p)) return p;
            }
        }
    } catch {}
    return null;
}
function await_import_fs() { return createRequire(import.meta.url)('node:fs'); }

function pickEncoder(ffmpeg) {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    if (/libvpx-vp9/.test(out)) return { codec: 'libvpx-vp9', args: ['-b:v', '700k', '-crf', '34', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2'] };
    if (/\blibvpx\b/.test(out))  return { codec: 'libvpx',     args: ['-b:v', '900k', '-crf', '12', '-qmin', '4', '-qmax', '48', '-auto-alt-ref', '0', '-deadline', 'good', '-cpu-used', '1'] };
    return null;
}

// ── dev server (only when --base is not given) ─────────────────────────────
let server = null;
async function ensureServer() {
    if (BASE) return;
    BASE = `http://localhost:${PORT}`;
    server = spawn(process.execPath, ['dev-server.mjs'], {
        cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'inherit'],
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000) {
        try { const r = await fetch(BASE + '/index.html', { method: 'HEAD' }); if (r.ok) return; } catch {}
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('dev server did not come up on ' + BASE);
}

// ── capture one slide ──────────────────────────────────────────────────────
async function captureSlide(browser, slide, ffmpeg, enc, outDir, tmpDir) {
    const c = slide.capture;
    const ctx = await browser.newContext({
        viewport: VIEW,
        deviceScaleFactor: 1,
        recordVideo: NOCLIP ? undefined : { dir: tmpDir, size: VIEW },
        reducedMotion: 'no-preference',
        colorScheme: 'dark',
    });
    const tCtx = Date.now();
    const page = await ctx.newPage();
    page.on('pageerror', e => console.warn(`   [${slide.id}] page error: ${e.message.slice(0, 120)}`));
    await page.addInitScript(() => {
        // js/cookie-consent.js STORAGE_KEY / BANNER_VERSION — a stored decision
        // keeps the banner out of every shot.
        try { localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: false, analytics: false, ts: Date.now(), version: 1 })); } catch {}
        window.addEventListener('message', (e) => { if (e.data?.type === 'preview-ready') window.__previewReady = true; });
    });
    await page.goto(BASE + c.url, { waitUntil: 'load', timeout: 90_000 });
    const hide = ['nav', '.pp-consent-banner', '.skip-link', ...(c.hide || [])];
    await page.addStyleTag({ content: `${hide.join(',')}{display:none!important;visibility:hidden!important}` +
        `html,body{overflow:hidden!important}*{cursor:none!important}` });
    try {
        await page.waitForFunction(new Function('return (' + c.ready + ')'), null, { timeout: 60_000 });
    } catch {
        console.warn(`   [${slide.id}] ready condition timed out — capturing whatever rendered`);
    }
    // Generic chrome stripper: every fixed/absolute/sticky element that is
    // not a canvas, does not contain one, and is not an ancestor of the crop
    // target is page UI (panels, tickers, tips, scrubbers) — hide it. The
    // per-slide `hide` list still handles in-flow chrome.
    if (c.stripOverlays !== false) {
        await page.evaluate((cropSel) => {
            const crop = document.querySelector(cropSel);
            let n = 0;
            for (const el of document.body.querySelectorAll('*')) {
                if (el.tagName === 'CANVAS' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
                if (crop && (el === crop || el.contains(crop))) continue;
                const pos = getComputedStyle(el).position;
                if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') continue;
                if (el.querySelector('canvas')) continue;
                el.style.setProperty('display', 'none', 'important');
                n++;
            }
            return n;
        }, c.crop).then(n => { if (n) console.log(`   stripped ${n} overlay element(s)`); });
    }
    if (c.prep) {
        try { await page.evaluate(new Function(c.prep)); }
        catch (err) { console.warn(`   [${slide.id}] prep failed: ${err.message.slice(0, 120)}`); }
    }
    await page.waitForTimeout(c.settleMs ?? 8000);

    // Crop box: the sim's own element, else the viewport. Even-sized, clamped.
    let box = null;
    try { box = await page.locator(c.crop).first().boundingBox(); } catch {}
    if (!box || box.width < 200 || box.height < 120) box = { x: 0, y: 0, width: VIEW.width, height: VIEW.height };
    const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
    const w = Math.min(VIEW.width  - x, Math.floor(box.width  / 2) * 2);
    const h = Math.min(VIEW.height - y, Math.floor(box.height / 2) * 2);

    const poster = `${slide.id}.jpg`;
    await page.screenshot({ path: path.join(outDir, poster), type: 'jpeg', quality: 80, clip: { x, y, width: w, height: h } });
    const tPoster = Date.now() - tCtx;

    let clip = null;
    if (!NOCLIP && enc) {
        await page.waitForTimeout(c.clipMs ?? 6000);
        const video = page.video();
        await ctx.close();                                  // flushes the recording
        const src = await video.path();
        clip = `${slide.id}.webm`;
        const out = path.join(outDir, clip);
        const scaleW = Math.min(CLIP_W, w);
        const args = ['-y', '-hide_banner', '-loglevel', 'error',
            '-ss', (tPoster / 1000).toFixed(2), '-t', ((c.clipMs ?? 6000) / 1000).toFixed(2), '-i', src,
            '-vf', `crop=${w}:${h}:${x}:${y},scale=${scaleW}:-2`,
            '-an', '-c:v', enc.codec, ...enc.args, '-pix_fmt', 'yuv420p', out];
        const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
        if (r.status !== 0) { console.warn(`   [${slide.id}] ffmpeg failed: ${r.stderr.slice(0, 300)}`); clip = null; }
        await rm(src, { force: true });
    } else {
        await ctx.close();
    }
    const sizes = { poster: (await stat(path.join(outDir, poster))).size, clip: clip ? (await stat(path.join(outDir, clip))).size : 0 };
    return {
        id: slide.id,
        poster: MEDIA_DIR + poster,
        clip: clip ? MEDIA_DIR + clip : null,
        width: w, height: h,
        source: c.url,
        capturedAt: new Date().toISOString(),
        renderer: GPU ? 'gpu' : 'swiftshader',
        bytes: sizes,
    };
}

// ── main ───────────────────────────────────────────────────────────────────
const outDir = path.join(ROOT, MEDIA_DIR);
await mkdir(outDir, { recursive: true });
const tmpDir = path.join(os.tmpdir(), 'pp-carousel-' + process.pid);
await mkdir(tmpDir, { recursive: true });

const ffmpeg = NOCLIP ? null : findFfmpeg();
const enc = ffmpeg ? pickEncoder(ffmpeg) : null;
if (!NOCLIP && !enc) console.warn('ffmpeg with libvpx not found — posters only (set FFMPEG=/path/to/ffmpeg)');
else if (enc) console.log(`ffmpeg: ${ffmpeg} (${enc.codec})`);

const manifestPath = path.join(outDir, 'manifest.json');
let manifest = { version: 1, generatedAt: null, slides: [] };
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch {}

await ensureServer();
const args = GPU ? ['--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ headless: true, args });
const todo = CAPTURED_SLIDES.filter(s => !ONLY.length || ONLY.includes(s.id));
const results = [];
try {
    for (const slide of todo) {
        console.log(`▶ ${slide.id}  ${slide.capture.url}`);
        try {
            const entry = await captureSlide(browser, slide, ffmpeg, enc, outDir, tmpDir);
            results.push(entry);
            console.log(`   ✓ ${entry.width}×${entry.height}  poster ${(entry.bytes.poster / 1024).toFixed(0)} kB` +
                        (entry.clip ? `  clip ${(entry.bytes.clip / 1024).toFixed(0)} kB` : '  (no clip)'));
        } catch (err) {
            console.warn(`   ✗ ${slide.id}: ${err.message}`);
        }
    }
} finally {
    await browser.close();
    server?.kill();
    await rm(tmpDir, { recursive: true, force: true });
}

// Merge: re-captured ids replace, untouched ids stay, order follows the registry.
const byId = new Map((manifest.slides || []).map(s => [s.id, s]));
for (const r of results) byId.set(r.id, r);
manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    slides: CAPTURED_SLIDES.map(s => byId.get(s.id)).filter(Boolean),
};
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest: ${manifest.slides.length} slide(s) → ${path.relative(ROOT, manifestPath)}`);
if (!results.length) process.exitCode = 1;
