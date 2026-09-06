/**
 * funnel-shim.mjs — static gate for the auth-page funnel load-order fix.
 *
 * signin.html / signup.html record their post-view stages (first
 * interaction, submit, succeeded, failed…) from CLASSIC <script> blocks,
 * which execute at parse time — before any <script type="module">. A
 * classic script that reads window.ppFunnel once while parsing therefore
 * captures `undefined` and falls back to a no-op stub forever. That shipped
 * and the admin funnel read "signin_view → signin_first_interaction: 100%
 * lost" for weeks. The fix resolves window.ppFunnel at CALL time and queues
 * early calls on window.ppFunnelQueue, which js/auth-funnel.js drains.
 *
 * This gate pins the shape so the parse-time capture cannot come back.
 * The browser-level proof is tests/auth-funnel.spec.js (first-interaction
 * stages must be observed on the wire).
 *
 *   node tests/funnel-shim.mjs
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

for (const page of ['signin.html', 'signup.html']) {
    const html = read(page);
    assert.ok(
        !/window\.ppFunnel\)\s*\|\|/.test(html),
        `${page}: parse-time capture of window.ppFunnel is back (\`window.ppFunnel) ||\`) — every classic-script stage would silently no-op`,
    );
    assert.ok(
        !/window\.ppClassifyAuthError\)\s*\|\|/.test(html),
        `${page}: parse-time capture of window.ppClassifyAuthError is back`,
    );
    assert.ok(html.includes('window.ppFunnelQueue'), `${page}: classic shim must queue on window.ppFunnelQueue`);
    assert.ok(/if \(window\.ppFunnel\) window\.ppFunnel\.step\(stage, props\)/.test(html),
        `${page}: _funnel.step must resolve window.ppFunnel at call time`);
}

const mod = read('js/auth-funnel.js');
assert.ok(mod.includes('window.ppFunnelQueue'), 'auth-funnel.js must drain window.ppFunnelQueue');
assert.ok(/queued\.forEach\(\(entry\) => sink\.push\(entry\)\)/.test(mod), 'auth-funnel.js must replay queued entries');
assert.ok(/window\.ppFunnelQueue = sink/.test(mod), 'auth-funnel.js must swap the queue for a live sink');

// signup.html's first-interaction list must name fields that exist.
const signup = read('signup.html');
const m = signup.match(/\[([^\]]+)\]\.forEach\(id => \{\s*const el = document\.getElementById\(id\);\s*if \(el\) el\.addEventListener\('focus'/);
assert.ok(m, 'signup.html: first-interaction focus list not found');
for (const id of m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, ''))) {
    assert.ok(signup.includes(`id="${id}"`), `signup.html: first-interaction field #${id} does not exist in the markup`);
}

// Landing capture: ONE placement, the S5 band. The 2026-09 above-the-fold
// copy (source "home-hero") was removed 2026-09-06 after 60 days of the
// funnel showed 0 submits — the hero carries ONE ask now (see index.html's
// "ONE ASK" note). initAuroraCapture() still iterates every form so a
// second placement elsewhere keeps working.
const index = read('index.html');
const sources = [...index.matchAll(/data-aurora-capture data-source="([^"]+)"/g)].map((x) => x[1]);
assert.deepEqual(sources.sort(), ['home'], 'index.html must carry exactly the S5 band capture form');
const capture = read('js/aurora-capture.js');
assert.ok(/querySelectorAll\('\[data-aurora-capture\]'\)/.test(capture), 'aurora-capture.js must wire every [data-aurora-capture] form');
assert.ok(/aurora_capture_upsell/.test(capture), 'aurora-capture.js success state must carry the free-account upsell');
// ONE ask in the hero: the dashboard button (hero_magnetosphere), nothing else.
const heroHtml = index.slice(index.indexOf('<section id="hero"'), index.indexOf('<!-- ── S2 · LIVE TICKER'));
const heroCtas = [...heroHtml.matchAll(/data-funnel-cta="([^"]+)"/g)].map((x) => x[1]);
assert.deepEqual(heroCtas, ['hero_magnetosphere'], `index.html hero must carry exactly one CTA (got ${heroCtas.join(', ')})`);
assert.ok(!/hero_signup|hero_alerts_submit/.test(index), 'index.html: the retired hero asks must not come back without a funnel read');
assert.ok(/id="cta-rail"/.test(index), 'index.html must carry the CTA rail');

console.log('funnel-shim: ok');
