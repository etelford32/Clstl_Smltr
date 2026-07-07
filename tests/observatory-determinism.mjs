// observatory-determinism.mjs — the binary's rendered configuration must be
// a pure function of the timeline epoch t, independent of how the playback
// loop walked there (frame cadence, playback speed, fps). This is the
// contract behind "scrub anywhere, replay anything, see the same thing".
//
// History: the lane engine used to ACCUMULATE the orbital phase from the
// per-frame dt, so fast playback aliased the phase into a wall-clock-
// dependent spirograph (different every run). Now sampleAt() extends the
// deterministic build-time phase accumulation within a history segment,
// and the engine reads it as a function of t.
//
// Scope: outside the PN window (a > 300 r_g). Inside the window the binary
// is a live post-Newtonian integration whose per-frame stepping is the
// feature itself; jumps there re-anchor deterministically via _resync.
//
// Run: node tests/observatory-determinism.mjs

import { LaneEngine } from '../js/abell85/laneengine.js';
import { sampleAt } from '../js/abell85/physics.js';

let failed = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failed++;
}

// deterministic pseudo-random cadence generator (mulberry-ish)
function cadence(seed, from, to, n) {
    let s = seed >>> 0;
    const rnd = () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let z = s;
        z = Math.imul(z ^ (z >>> 15), z | 1);
        z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
        return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
    };
    const cuts = Array.from({ length: n - 1 }, rnd).sort((x, y) => x - y);
    return [...cuts.map(c => from + c * (to - from)), to];
}

/** Walk one fresh engine through the given epochs; return the final state. */
function walk(times) {
    const eng = new LaneEngine('a402', { nStars: 96, seed: 85 });
    let st = null;
    for (const t of times) st = eng.setTime(t, 0);
    return { st, eng };
}

// ── hardening stage (the regime of the reported bug: a ~ 5 pc, P ~ kyr) ─────
{
    const probe = new LaneEngine('a402', { nStars: 8, seed: 85 });
    const t0 = probe.history.events.binaryForms + 300;
    const t1 = t0 + 800;                       // deep in the hardening stage

    const A = walk(cadence(11, t0, t1, 9));    // 9 coarse uneven frames
    const B = walk(cadence(77, t0, t1, 233));  // 233 fine uneven frames

    const dPos = Math.max(...[0, 1].flatMap(i =>
        [0, 1, 2].map(k => Math.abs(A.st.bhs[i].p[k] - B.st.bhs[i].p[k]))));
    check('hardening: 9-frame and 233-frame walks land on identical binary positions',
        dPos === 0, `max |Δp| = ${dPos.toExponential(1)} pc`);

    check('hardening: rendered phase equals the history phase (pure function of t)',
        A.st.phase === sampleAt(A.eng.history, t1).phase,
        `φ = ${A.st.phase.toFixed(6)}`);

    const C = walk(cadence(42, t0, t1, 61));   // third cadence, different seed
    const dPhase = Math.abs(A.st.phase - C.st.phase);
    check('hardening: a third cadence agrees too', dPhase === 0,
        `|Δφ| = ${dPhase.toExponential(1)}`);
}

// ── approach stage (sinking nuclei circle deterministically as well) ─────────
{
    const probe = new LaneEngine('a402', { nStars: 8, seed: 85 });
    const tF = probe.history.events.firstEncounter ?? probe.history.samples[0].t;
    const tB = probe.history.events.binaryForms;
    const t0 = tF + 0.1 * (tB - tF), t1 = tF + 0.7 * (tB - tF);

    const A = walk(cadence(5, t0, t1, 7));
    const B = walk(cadence(99, t0, t1, 145));
    const dPos = Math.max(...[0, 1].flatMap(i =>
        [0, 1, 2].map(k => Math.abs(A.st.bhs[i].p[k] - B.st.bhs[i].p[k]))));
    check('approach: sinking-nuclei configuration is cadence-independent',
        dPos === 0, `max |Δp| = ${dPos.toExponential(1)} pc`);
    check('approach: nuclei actually circle while sinking (phase varies along t)',
        Math.abs(sampleAt(A.eng.history, t0).phase -
                 sampleAt(A.eng.history, t1).phase) > 1e-3);
}

// ── scrub-back: jumping to an earlier epoch reproduces it exactly ────────────
{
    const probe = new LaneEngine('a402', { nStars: 8, seed: 85 });
    const t0 = probe.history.events.binaryForms + 300;
    const A = walk([t0 + 100, t0 + 500]);                     // forward only
    const B = walk([t0 + 100, t0 + 900, t0 + 500]);           // overshoot, scrub back
    const dPos = Math.max(...[0, 1].flatMap(i =>
        [0, 1, 2].map(k => Math.abs(A.st.bhs[i].p[k] - B.st.bhs[i].p[k]))));
    check('scrub-back to the same epoch reproduces the binary exactly',
        dPos === 0, `max |Δp| = ${dPos.toExponential(1)} pc`);
}

console.log(failed
    ? `observatory-determinism: ${failed} CHECK(S) FAILED`
    : 'observatory-determinism: all checks passed');
process.exit(failed ? 1 : 0);
