#!/usr/bin/env node
/**
 * weather-decode-identity.mjs
 *
 * Guards the invariant that the shared js/weather-decode.js decodeCoarse()
 * (used by the forecast Web Worker) stays byte-identical to what the live
 * renderer path produces via WeatherFeed._decodeCoarse(). If anyone re-inlines
 * or tweaks one without the other, this fails loudly.
 */
import assert from 'node:assert/strict';

const ROOT = '/home/user/ParkersPhysics';
const { WeatherFeed }  = await import(ROOT + '/js/weather-feed.js');
const { decodeCoarse, TEX_W, TEX_H } = await import(ROOT + '/js/weather-decode.js');

const G_W = 72, G_H = 36, N = G_W * G_H, NUM = 9;
let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); } };

// A structured coarse frame exercising every channel + the antimeridian wrap.
const coarse = new Float32Array(N * NUM);
for (let ch = 0; ch < NUM; ch++) {
    for (let k = 0; k < N; k++) {
        const i = k % G_W, j = (k / G_W) | 0;
        coarse[ch * N + k] = Math.sin(i * 0.21 + ch) * 20 + Math.cos(j * 0.33 - ch) * 15 + ch * 3;
    }
}

const feed = new WeatherFeed();

console.log('weather-decode-identity.mjs');
console.log('───────────────────────────');

check('feed._decodeCoarse == shared decodeCoarse (byte-identical)', () => {
    const a = feed._decodeCoarse(coarse, G_W, G_H);
    const b = decodeCoarse(coarse, G_W, G_H);
    for (const key of ['weatherBuf', 'windBuf', 'cloudBuf']) {
        assert.equal(a[key].length, b[key].length, `${key} length`);
        let mx = 0;
        for (let i = 0; i < a[key].length; i++) mx = Math.max(mx, Math.abs(a[key][i] - b[key][i]));
        assert.equal(mx, 0, `${key} identical (maxΔ=${mx})`);
    }
});

check('decode output is finite, correctly shaped, normalised', () => {
    const t = decodeCoarse(coarse, G_W, G_H);
    assert.equal(t.weatherBuf.length, TEX_W * TEX_H * 4, 'trio sized to TEX grid');
    let min = Infinity, max = -Infinity;
    for (let k = 0; k < t.weatherBuf.length; k++) {
        const v = t.weatherBuf[k];
        assert.ok(Number.isFinite(v), 'finite');
        if (v < min) min = v; if (v > max) max = v;
    }
    assert.ok(min >= 0 && max <= 1, `weather channels in [0,1] (got ${min}..${max})`);
    assert.ok(max - min > 0.01, 'field has spatial variation');
});

console.log('───────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
