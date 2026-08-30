// sun-flux-rope.mjs — fixture gate for js/sun-flux-rope.js, the sun.html
// consumer of the SHARED flux-rope provider. Drives the REAL committed WASM
// through computeFluxRopeForecast with injected sources (no network) and
// pins the two pure helpers:
//   · trainStateAt — per-rope transit state must come from the provider's
//     own kernel probes and respect launch offsets (an unlaunched follower
//     is neither "in transit" nor "arrived").
//   · scrubMarks — event-track assembly keeps only ledger kinds with a
//     finite epoch, sorts ascending, and carries the arrival band only
//     when the summary actually has one.
//
//   node tests/sun-flux-rope.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { computeFluxRopeForecast } from '../js/flux-rope-forecast.js';
import { trainStateAt, scrubMarks } from '../js/sun-flux-rope.js';

const wasm = await readFile(fileURLToPath(new URL('../js/flux-rope-wasm/flux_rope_core.wasm', import.meta.url)));

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

// Fixture: a fast Earth-directed halo + a slower follower 8 h later, both
// mid-transit at "now" — the compounding-train shape the sun page watches.
const NOW_MS = Date.parse('2026-07-20T12:00:00Z');
const LEAD = {
    id: 'lead', timeIso: '2026-07-19T06:00:00Z', speedKms: 1250,
    lonDeg: 4, latDeg: -3, halfAngleDeg: 42, earthDirected: true,
};
const FOLLOWER = {
    id: 'follower', timeIso: '2026-07-19T14:00:00Z', speedKms: 900,
    lonDeg: -6, latDeg: 2, halfAngleDeg: 35, earthDirected: true,
};

const fc = await computeFluxRopeForecast({
    sources: { cmes: [LEAD, FOLLOWER], rtsw: null, wasm }, nowMs: NOW_MS,
});
check('fixture train produces a live 2-rope forecast',
    fc.idle === false && fc.preset.ropes.length === 2);

// ── trainStateAt ─────────────────────────────────────────────────────────────
{
    const launchMs = fc.launchMs;

    // 1 h in: only the lead rope is away; follower not yet launched.
    const early = trainStateAt(fc, launchMs + 1 * 3600e3);
    check('t+1h: lead launched, follower not',
        early.launched === 1 && early.inTransit === 1 && early.arrived === 0,
        JSON.stringify({ launched: early.launched, inTransit: early.inTransit }));
    check('t+1h: unlaunched follower reports zero apex',
        early.ropes[1].launched === false && early.ropes[1].apexAu === 0);

    // 12 h in: both launched, both still inside 1 AU.
    const mid = trainStateAt(fc, launchMs + 12 * 3600e3);
    check('t+12h: both ropes in transit',
        mid.launched === 2 && mid.inTransit === 2 && mid.arrived === 0);
    check('t+12h: lead apex is ahead of the follower and inside L1',
        mid.ropes[0].apexAu > mid.ropes[1].apexAu && mid.ropes[0].apexAu < 0.99,
        `apex ${mid.ropes[0].apexAu.toFixed(3)} / ${mid.ropes[1].apexAu.toFixed(3)} AU`);

    // Deep post-storm: everything arrived, nothing left in transit.
    const late = trainStateAt(fc, launchMs + 200 * 3600e3);
    check('t+200h: whole train arrived',
        late.arrived === 2 && late.inTransit === 0);

    // Apex distances must be the KERNEL's own numbers, not a re-derivation.
    const probe = fc.kernel.apexKmAt(0, 12 * 3600) / 1.495978707e8;
    check('apex fractions are kernel-probe verbatim',
        Math.abs(mid.ropes[0].apexAu - probe) < 1e-12);

    // Non-live inputs return null, never a fabricated state.
    check('null / idle / failed forecasts probe to null',
        trainStateAt(null, NOW_MS) === null
        && trainStateAt({ idle: true, reason: 'no-earth-directed-cme' }, NOW_MS) === null
        && trainStateAt({ idle: true, failed: true, reason: 'donki down' }, NOW_MS) === null
        && trainStateAt(fc, NaN) === null);
}

// ── scrubMarks ───────────────────────────────────────────────────────────────
{
    const T0 = Date.parse('2026-07-19T00:00:00Z');
    const timeline = [
        { t: T0 + 5 * 3600e3, kind: 'cme', color: '#ff6644', title: 'Earth-directed CME · 1250 km/s', earth: true },
        { t: T0 + 2 * 3600e3, kind: 'flare', color: '#ff4444', title: 'X1.2 flare · AR 4321' },
        { t: T0 + 9 * 3600e3, kind: 'sep', color: '#cc88ff', title: 'Solar energetic particle event' },
        { t: T0 + 11 * 3600e3, kind: 'note', color: '#888888', title: 'forecaster note' },  // dropped
        { t: NaN, kind: 'flare', color: '#ff4444', title: 'bad row' },                       // dropped
    ];
    const { marks, band } = scrubMarks({ timeline, summary: fc.summary });
    check('marks keep only ledger kinds with finite epochs, sorted ascending',
        marks.length === 3 && marks[0].kind === 'flare' && marks[1].kind === 'cme'
        && marks.every((m, i) => i === 0 || m.t >= marks[i - 1].t));
    check('earth flag survives onto the CME mark',
        marks[1].earth === true && marks[0].earth === false);
    check('arrival band carried from the provider summary, ordered',
        band && band.t0 <= band.t50 && band.t50 <= band.t1);

    const none = scrubMarks({ timeline, summary: null });
    check('no summary → no band (never a fabricated window)', none.band === null);
    const empty = scrubMarks({});
    check('empty inputs → empty track', empty.marks.length === 0 && empty.band === null);
}

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('\n✅ sun-flux-rope: all checks passed');
