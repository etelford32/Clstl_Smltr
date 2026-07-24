// shielding-live-context.mjs — unit gate for the Shielding Lab's Phase-2
// observed-context layer (js/shielding-lab/live-context.js). Pure node,
// fixture payloads only:
//
//   node tests/shielding-live-context.mjs
//
// Covers: Kp-1m parsing (newest valid wins, fills skipped), Kyoto Dst in
// both payload shapes (object rows and header-row products) with fill
// rejection and sorting, the G-scale ladder, the Dst storm-phase words,
// the Boyle 1997 empirical CPCP, and the poller's independent
// best-effort behavior (one dead feed must not blank the other).

import {
    parseKp1m, parseKyotoDst, gScale, stormPhaseFromDst, boyleCpcpKv,
    LiveContext, KP_PATH, DST_PATH,
} from '../js/shielding-lab/live-context.js';

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── Kp 1-min ───────────────────────────────────────────────────────────
const KP_FIXTURE = [
    { time_tag: '2026-07-24T11:58:00Z', estimated_kp: 3.67, kp_index: 4, kp: '4M' },
    { time_tag: '2026-07-24T11:59:00Z', estimated_kp: 5.33, kp_index: 5, kp: '5M' },
    { time_tag: '2026-07-24T12:00:00Z', estimated_kp: null, kp_index: null, kp: null }, // trailing fill
];
const kp = parseKp1m(KP_FIXTURE);
check('newest valid Kp wins (trailing fill skipped)', close(kp.kp, 5.33), `${kp.kp}`);
check('Kp timestamp parsed', kp.t === Date.parse('2026-07-24T11:59:00Z'));
check('empty/garbage Kp → null', parseKp1m([]) === null && parseKp1m({ nope: 1 }) === null);

// ── Kyoto Dst — both shapes ────────────────────────────────────────────
const DST_OBJECTS = [
    { time_tag: '2026-07-24 10:00:00', dst: -42 },
    { time_tag: '2026-07-24 09:00:00', dst: -38 },      // out of order on purpose
    { time_tag: '2026-07-24 11:00:00', dst: -9999 },    // fill
];
const dstA = parseKyotoDst(DST_OBJECTS);
check('object rows: fills dropped, sorted ascending',
    dstA.length === 2 && dstA[0].dst === -38 && dstA[1].dst === -42);

const DST_PRODUCT = [
    ['time_tag', 'dst'],
    ['2026-07-24 10:00:00', '-55'],
    ['2026-07-24 11:00:00', '-61'],
];
const dstB = parseKyotoDst(DST_PRODUCT);
check('header-row product parsed by column name', dstB.length === 2 && dstB[1].dst === -61);
check('missing dst column → empty, never a guess', parseKyotoDst([['time_tag', 'foo'], ['x', '1']]).length === 0);

// ── G scale + storm phase ──────────────────────────────────────────────
check('G scale ladder', gScale(4.9) === '' && gScale(5) === 'G1' && gScale(7.2) === 'G3' && gScale(9) === 'G5');
check('storm phase words', stormPhaseFromDst(-10) === 'quiet' && stormPhaseFromDst(-35) === 'unsettled'
    && stormPhaseFromDst(-70) === 'storm' && stormPhaseFromDst(-180) === 'intense storm');
check('storm phase null-safe', stormPhaseFromDst(null) === null);

// ── Boyle 1997 ─────────────────────────────────────────────────────────
// Quiet: v 400, Bz −2, By 0 → 1e-4·400² + 11.7·2·1 = 16 + 23.4 = 39.4 kV.
check('Boyle quiet southward ≈ 39.4 kV', close(boyleCpcpKv(-2, 0, 400), 39.4, 1e-6),
    boyleCpcpKv(-2, 0, 400).toFixed(1));
// Pure northward: merging term dies, viscous 1e-4 v² remains.
check('Boyle northward = viscous only', close(boyleCpcpKv(5, 0, 400), 16));
check('Boyle zero field = viscous only', close(boyleCpcpKv(0, 0, 400), 16));
// Storm: v 700, Bz −15 → 49 + 175.5 = 224.5 kV (no saturation — expected).
check('Boyle storm ≈ 224.5 kV (unsaturated by design)', close(boyleCpcpKv(-15, 0, 700), 224.5, 1e-6));
// By rotates the clock angle: sin²(θc/2) = 0.5 at pure By.
check('Boyle pure-By clock angle', close(boyleCpcpKv(0, 10, 400), 16 + 11.7 * 10 * Math.pow(0.5, 1.5), 1e-9));

// ── Poller: independent best-effort ────────────────────────────────────
const mkRes = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
{
    const timers = [];
    const ctx = new LiveContext({
        fetchFn: async (url) => {
            const u = String(url);
            if (u.includes(KP_PATH) || u.includes('planetary_k_index')) return mkRes(KP_FIXTURE);
            return mkRes(null, false);   // Dst dead — both direct and mirror
        },
        nowFn: () => Date.parse('2026-07-24T12:00:00Z'),
        schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        cancel: () => {},
    });
    ctx.start();
    await new Promise((r) => setTimeout(r, 5));
    check('Kp lands even with Dst dead', close(ctx.kp?.kp, 5.33) && ctx.dst === null);
    check('poller rescheduled at T2 cadence', timers.length === 1 && Math.abs(timers[0].ms - 300_000) <= 10_000,
        `${timers[0]?.ms} ms`);
}
{
    const ctx = new LiveContext({
        fetchFn: async (url) => {
            const u = String(url);
            if (u.includes(DST_PATH) || u.includes('kyoto-dst')) return mkRes(DST_OBJECTS);
            return mkRes(null, false);
        },
        nowFn: () => Date.parse('2026-07-24T12:00:00Z'),
        schedule: () => 0,
        cancel: () => {},
    });
    ctx.start();
    await new Promise((r) => setTimeout(r, 5));
    check('Dst lands even with Kp dead', ctx.dst?.dst === -42 && ctx.kp === null);
    check('Dst series windowed to 24 h and exposed newest-last',
        ctx.dstSeries.length === 2 && ctx.dstSeries[1].t > ctx.dstSeries[0].t);
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('\nshielding-live-context: all checks passed');
