// flux-rope-forecast.mjs — fixture gate for the SHARED Phase 4 forecast
// provider (js/flux-rope-forecast.js). Drives the REAL committed WASM with
// injected fixture sources (no network): the provider must produce a
// contract-conformant SolarWindDriver, a sane summary, and an assimilated
// fan when overlapping L1 observations exist.
//
//   node tests/flux-rope-forecast.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { computeFluxRopeForecast, forecastDriverSamples, summarizeForecast,
         eventSeed, trainSeed } from '../js/flux-rope-forecast.js';
import { fromArrays, DRIVER_SOURCES } from '../js/solar-wind-driver.js';

const wasm = await readFile(fileURLToPath(new URL('../js/flux-rope-wasm/flux_rope_core.wasm', import.meta.url)));

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

// Fixture: a fast Earth-directed halo launched 30 h before "now" — mid
// transit, so part of the grid is observable past and part is forecast.
const NOW_MS = Date.parse('2026-07-20T12:00:00Z');
const LAUNCH_ISO = '2026-07-19T06:00:00Z';
const FIXTURE_CME = {
    timeIso: LAUNCH_ISO, speedKms: 1250, lonDeg: 4, latDeg: -3,
    halfAngleDeg: 42, earthDirected: true,
};
const FLANK_CME = { ...FIXTURE_CME, earthDirected: false };

// ── Idle path ────────────────────────────────────────────────────────────────
{
    const fc = await computeFluxRopeForecast({ sources: { cmes: [FLANK_CME], rtsw: null, wasm } });
    check('idle when no Earth-directed CME', fc.idle === true && fc.reason === 'no-earth-directed-cme');
}

// ── Full path, no L1 data (pure prior) ───────────────────────────────────────
const prior = await computeFluxRopeForecast({
    sources: { cmes: [FIXTURE_CME], rtsw: null, wasm }, nowMs: NOW_MS,
});
check('forecast produced for the fixture CME', prior.idle === false && prior.launchMs === Date.parse(LAUNCH_ISO));
check('prior fan when no observations', prior.assimNote.startsWith('prior') && prior.fan === prior.prior);

const d = prior.driver;
check('driver speaks the contract with source=forecast',
    d.meta.source === 'forecast' && DRIVER_SOURCES.includes('forecast'),
    d.meta.source);
check('driver grid is complete and monotonic',
    d.length === prior.grid.n && d.samples.every((s, i) => i === 0 || s.t > d.samples[i - 1].t));
check('driver carries pdyn (normalizeSample fills it from n·v²)',
    d.samples.every((s) => Number.isFinite(s.pdyn) && s.pdyn > 0));
const wAmb = prior.preset.rope.wKms;
check('driver V: ambient before arrival, rope-kinematic (≥ ambient) inside',
    d.samples.every((s, i) => (prior.det.inside[i] > 0 ? s.v >= wAmb : s.v === wAmb)));
check('driver V is elevated during the rope crossing',
    d.samples.some((s, i) => prior.det.inside[i] > 0 && s.v > wAmb + 50));

const sm = prior.summary;
check('summary probabilities sane',
    sm.pHit > 0 && sm.pHit <= 1 && sm.p10 >= sm.p20 && sm.p20 >= 0);
check('summary arrival window ordered',
    sm.arrivalP10Ms <= sm.arrivalP50Ms && sm.arrivalP50Ms <= sm.arrivalP90Ms
        && sm.arrivalP10Ms > prior.launchMs);
check('summary min-Bz percentiles ordered (p5 at least as deep as median)',
    sm.minBzP5 <= sm.minBzP50);

// ── Assimilation path: synthetic L1 overlapping the observable past ──────────
{
    // Synthesize "observations" from the deterministic reference itself so
    // the filter has consistent structure to lock onto.
    const t = [], bz = [], v = [], n = [];
    for (let i = 0; i < prior.grid.n; i++) {
        const tMs = prior.launchMs + i * prior.grid.dtS * 1000;
        if (tMs > NOW_MS) break;
        t.push(tMs);
        bz.push(prior.det.bz[i]);
        v.push(450); n.push(6);
    }
    const rtsw = fromArrays({ t, bz, v, n }, { source: 'observed', label: 'synthetic L1' });
    const fc = await computeFluxRopeForecast({
        sources: { cmes: [FIXTURE_CME], rtsw, wasm }, nowMs: NOW_MS,
    });
    check('assimilation engages on overlapping observations',
        fc.nObs >= 4 && /particle filter/.test(fc.assimNote), fc.assimNote);
    check('assimilated fan differs from the prior',
        fc.fan !== fc.prior && fc.fan.ess < fc.prior.members,
        `ESS ${fc.fan.ess.toFixed(0)}/${fc.prior.members}`);
    check('driver median follows the ASSIMILATED fan',
        fc.driver.samples.some((s, i) => s.bz !== prior.driver.samples[i].bz));
    // Background-noise wiring (review F2): measured, disclosed, applied.
    check('background noise measured from the injected L1 record',
        fc.noise.ok === true && Number.isFinite(fc.noise.sigmaNt),
        `bg σ ${fc.noise.sigmaNt?.toFixed(2)} nT over ${fc.noise.n} samples`);
    check('filter σ derived from the measured background and disclosed',
        fc.sigmaNt >= 3 && fc.sigmaNt <= 8 && /σ \d/.test(fc.assimNote), fc.assimNote);
    check('sheath δ seeded from the measured background on every rope',
        fc.sheathDeltaNt >= 1 && fc.sheathDeltaNt <= 6
        && fc.preset.ropes.every((r) => r.sheathDeltaNt === fc.sheathDeltaNt),
        `δ ${fc.sheathDeltaNt.toFixed(1)} nT`);
}

// ── Compounding-train path (review F1): two CMEs in flight ───────────────────
{
    const CME_A = { id: 'A', timeIso: '2026-07-19T06:00:00Z', speedKms: 900,
        lonDeg: -3, latDeg: 2, halfAngleDeg: 38, earthDirected: true };   // 30 h old, in transit
    const CME_B = { id: 'B', timeIso: '2026-07-20T00:00:00Z', speedKms: 1500,
        lonDeg: 5, latDeg: -1, halfAngleDeg: 45, earthDirected: true };   // 12 h old (24 h window)
    const fc = await computeFluxRopeForecast({
        sources: { cmes: [CME_B, CME_A], rtsw: null, wasm }, nowMs: NOW_MS,
    });
    check('train: both in-flight CMEs modeled as one system',
        fc.train === true && fc.cmes.length === 2 && fc.summary.nRopes === 2);
    check('train: epoch = earliest launch (rope 0), offsets forward',
        fc.launchMs === Date.parse(CME_A.timeIso)
        && fc.preset.rope === fc.preset.ropes[0]
        && fc.preset.ropes[1].launchOffsetS === 18 * 3600);
    check('train: §16 interaction on with joint per-rope sampling',
        fc.prior.ropesPerMember === 2 && fc.preset.interaction.enabled === true);
    check('train: headline cme is the newest Earth-directed anchor', fc.cme.id === 'B');
    check('train: grid extends past the last launch',
        fc.grid.n === Math.round((120 + 18) * 3600 / fc.grid.dtS), `n=${fc.grid.n}`);
    check('train: driver labeled as the compounding train',
        /compounding train/.test(fc.driver.meta.label), fc.driver.meta.label);
    const fc2 = await computeFluxRopeForecast({
        sources: { cmes: [CME_B, CME_A], rtsw: null, wasm }, nowMs: NOW_MS,
    });
    check('train: bit-stable per train identity',
        fc2.fan.bzPct.p50.every((v, i) => Object.is(v, fc.fan.bzPct.p50[i])));
    check('train seed folds every identity (1-CME train = legacy event seed)',
        trainSeed([CME_A, CME_B]) !== eventSeed('A') && trainSeed([CME_A]) === eventSeed('A'));
}

// ── Relevance honesty (review F3): passed storms are not "forecast" ──────────
{
    const OLD = { id: 'old', timeIso: '2026-07-14T00:00:00Z', speedKms: 1200,
        lonDeg: 0, latDeg: 0, halfAngleDeg: 40, earthDirected: true };  // arrived ≈ 07-15, long gone
    const fc = await computeFluxRopeForecast({
        sources: { cmes: [OLD], rtsw: null, wasm }, nowMs: NOW_MS,
    });
    check('passed storm → idle with the honest reason',
        fc.idle === true && fc.reason === 'cme-train-passed', fc.reason);
    const replay = await computeFluxRopeForecast({
        sources: { cmes: [OLD], rtsw: null, wasm }, nowMs: NOW_MS, relevanceFilter: false,
    });
    check('replay opt-out models the injected catalog verbatim',
        replay.idle === false && replay.cme.id === 'old' && replay.summary.nRopes === 1);
}

// ── Pure helpers directly ────────────────────────────────────────────────────
{
    const s = forecastDriverSamples({
        bzP50: [0, -5, -10], det: { inside: [0, 1, 1] },
        apexV: () => 700, launchMs: 0, t0S: 0, dtS: 600, wKms: 400, nCc: 5,
    });
    check('forecastDriverSamples: shapes + kinematic V fill',
        s.t.length === 3 && s.v[0] === 400 && s.v[1] === 700 && s.n[2] === 5);
    const fakeFan = {
        pHit: 0.7,
        pMinBzBelow: (thr) => (thr === -10 ? 0.5 : 0.2),
        bzPct: { p50: [0, -8, -3], p5: [-2, -15, -6] },
    };
    const fakePrior = { arrivalH: [40, 44, 48, NaN] };
    const s2 = summarizeForecast(fakeFan, fakePrior, 1000);
    check('summarizeForecast: quantiles + minima',
        s2.p10 === 0.5 && s2.minBzP50 === -8 && s2.minBzP5 === -15
            && s2.arrivalP10Ms === 1000 + 40 * 3600_000);
}

// Diagonalized determinism (2026-07-23): every catalogued event gets its
// OWN reproducible ensemble seed — replays are bit-stable per event.
{
    const a = eventSeed('2013-06-02T20:24:00-CME-001');
    check('eventSeed is deterministic', a === eventSeed('2013-06-02T20:24:00-CME-001'));
    check('distinct events get distinct seeds',
        a !== eventSeed('2013-06-03T08:12:00-CME-001'));
    check('seed is a positive uint32', Number.isInteger(a) && a > 0 && a < 2 ** 32);
    check('empty identity falls back to the base seed', eventSeed(null, 6180) !== 0);
    check('base folds in', eventSeed('x', 1) !== eventSeed('x', 2));
}

if (failures) {
    console.error(`\n${failures} forecast-provider check(s) failed`);
    process.exit(1);
}
console.log('\nall flux-rope forecast-provider checks passed');
