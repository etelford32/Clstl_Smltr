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

// Landing capture: two placements, distinct sources, both wired by the ONE
// initAuroraCapture() (which must iterate every form, not just the first).
const index = read('index.html');
const sources = [...index.matchAll(/data-aurora-capture data-source="([^"]+)"/g)].map((x) => x[1]);
assert.deepEqual(sources.sort(), ['home', 'home-hero'], 'index.html must carry the hero + band capture forms');
const capture = read('js/aurora-capture.js');
assert.ok(/querySelectorAll\('\[data-aurora-capture\]'\)/.test(capture), 'aurora-capture.js must wire every [data-aurora-capture] form');
assert.ok(/aurora_capture_upsell/.test(capture), 'aurora-capture.js success state must carry the free-account upsell');
assert.ok(/data-funnel-cta="hero_signup"/.test(index), 'index.html hero must carry the free-account primary CTA');
assert.ok(/id="cta-rail"/.test(index), 'index.html must carry the CTA rail');

console.log('funnel-shim: ok');
