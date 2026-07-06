// storm-physics.mjs — validation contract for the Storm Observatory engine
// (js/storm/*). Style mirrors tests/abell85-physics.mjs: every check states
// what physical claim it guards. Run: node tests/storm-physics.mjs
//
// The contract tests RELATIONS (storm > quiet, thrust-wins vs thrust-loses)
// with published-band magnitudes printed for the log — absolute thermosphere
// truth belongs to the GRACE-FO skill readout, which is reported, not gamed.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hydrateBundle, makeScenario } from '../js/storm/bundle.js';
import {
    STRIDE, CLS, CATALOG_N_DEFAULT, synthCatalogInto, mulberry32,
} from '../js/storm/catalog.js';
import { SatSwarm, H_REENTRY_KM } from '../js/storm/orbits.js';
import { R_EARTH_KM, raanDot, periodMin, keplerE } from '../js/storm/units.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (msg) => { n++; console.log(`  ✓ ${msg}`); };

async function loadLane(id) {
    return hydrateBundle(JSON.parse(
        await readFile(resolve(ROOT, `data/storm/${id}.json`), 'utf8')));
}

const feb = await loadLane('feb2022_starlink');
const gannon = await loadLane('gannon_may_2024');
const quiet = await loadLane('solar_min_dec_2019');
const halloween = await loadLane('halloween_oct_2003');
const carrington = await loadLane('carrington_class');
const lanes = { feb, gannon, quiet, halloween, carrington };

// ── 1 · bundle sanity: density falls with altitude, everywhere ──────────────
for (const [id, l] of Object.entries(lanes)) {
    for (let t = 0; t < l.grid.nT; t += 7) {
        for (let j = 1; j < l.grid.nA; j++) {
            assert.ok(l.grid.logRho[t][j] < l.grid.logRho[t][j - 1],
                `${id}: ρ must fall with altitude (t=${t}, j=${j})`);
        }
    }
    const r400 = l.grid.sample(400, l.tPeakHours);
    assert.ok(r400 > 1e-14 && r400 < 1e-10, `${id}: ρ(400, peak) sane: ${r400}`);
}
ok('all 5 lane grids: ρ monotonically falls with altitude; ρ(400 km) in physical range');

// ── 2 · storm ordering at 400 km peak: quiet < feb < gannon ≤ carrington ────
const p400 = Object.fromEntries(Object.entries(lanes).map(
    ([id, l]) => [id, l.grid.sample(400, l.tPeakHours)]));
assert.ok(p400.feb > 1.15 * p400.quiet, 'feb peak > quiet');
assert.ok(p400.gannon > 2 * p400.quiet, 'gannon peak ≫ quiet');
assert.ok(p400.carrington >= 0.9 * p400.gannon, 'carrington ≳ gannon');
ok(`storm ordering at 400 km: quiet ${p400.quiet.toExponential(2)} < feb ` +
    `${p400.feb.toExponential(2)} < gannon ${p400.gannon.toExponential(2)} ≤ ` +
    `carrington ${p400.carrington.toExponential(2)}`);

// ── 3 · Feb-2022 in-lane enhancement (diurnal-controlled) ───────────────────
// Reference = same-local-time minimum over the post-storm tail, so day/night
// structure doesn't alias into the storm signal. OBSERVED enhancement at
// ~200–250 km was ~1.35–1.6× (Dang+ 2022 et al.); NRLMSISE-00 with real ap
// reproduces only part of that — the KNOWN MSIS storm underprediction that
// killed the Starlink batch's margins and is this platform's founding
// argument. The contract asserts what MSIS does and REPORTS the gap.
const enhAt = (alt) => {
    const pv = feb.grid.sample(alt, feb.tPeakHours);
    let ref = Infinity;
    for (let k = 1; k <= 7; k++) {
        const t = feb.tPeakHours + 24 * k;
        if (t < feb.durationHours) ref = Math.min(ref, feb.grid.sample(alt, t));
    }
    return pv / ref;
};
const enh210 = enhAt(210), enh400 = enhAt(400);
assert.ok(enh210 > 1.05 && enh210 < 1.4, `MSIS 210 km enhancement ${enh210.toFixed(2)}×`);
assert.ok(enh400 > enh210, 'storm response grows with altitude');
ok(`feb2022 MSIS enhancement: ${enh210.toFixed(2)}× @210 km, ${enh400.toFixed(2)}× @400 km ` +
    `— observed was ~1.35–1.6× @210 km (Dang+ 2022): the MSIS underprediction gap, on display`);

// ── 4 · GRACE-FO skill is REPORTED, not gamed ───────────────────────────────
// Day-averaged comparison (the literature-standard framing — the raw scatter
// mixes GRACE's lat/LST sweep into our single reference column). The bound is
// a decade-slip guard (a unit error is 3 dex), NOT a quality claim: the
// feb-2022 truth fixture in particular shows storm-flat density and is
// treated as indicative until re-verified against the TU Delft archive —
// exactly what the bundle watermark is for.
for (const [id, l] of [['feb2022', feb], ['gannon', gannon]]) {
    const byDay = new Map();
    for (const s of l.truth.samples) {
        if (s.t_hours < 0 || s.t_hours > l.durationHours) continue;
        const d = Math.floor(s.t_hours / 24);
        const b = byDay.get(d) ?? { t: 0, m: 0, n: 0 };
        b.t += Math.log10(s.rho);
        b.m += Math.log10(l.grid.sample(s.alt_km, s.t_hours));
        b.n++;
        byDay.set(d, b);
    }
    const diffs = [...byDay.values()].map(b => (b.m - b.t) / b.n);
    const bias = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const rms = Math.sqrt(diffs.reduce((a, b) => a + b * b, 0) / diffs.length);
    assert.ok(rms < 0.8, `${id}: day-avg |log10 model/truth| rms ${rms.toFixed(2)} < 0.8 (decade-slip guard)`);
    ok(`${id} vs truth fixture (day-averaged): bias ${bias >= 0 ? '+' : ''}${bias.toFixed(2)} dex, ` +
        `rms ${rms.toFixed(2)} dex over ${diffs.length} days — REPORTED for the skill panel, ` +
        `truth fixture unverified (watermark applies)`);
}

// ── 5 · scenario lane: α=0 IS quiet; α=1 IS the base; α>1 extrapolates ──────
{
    const s0 = makeScenario(quiet, halloween, { alpha: 0 });
    const s1 = makeScenario(quiet, halloween, { alpha: 1 });
    const s15 = makeScenario(quiet, halloween, { alpha: 1.5 });
    const t = halloween.tPeakHours;
    assert.ok(Math.abs(Math.log10(s0.grid.sample(400, t) / quiet.grid.sample(400, t))) < 1e-9);
    assert.ok(Math.abs(Math.log10(s1.grid.sample(400, t) / halloween.grid.sample(400, t))) < 1e-9);
    assert.ok(s15.grid.sample(400, t) > 1.2 * s1.grid.sample(400, t));
    const sShift = makeScenario(quiet, halloween, { alpha: 1, onsetShiftHours: 24 });
    assert.ok(Math.abs(Math.log10(
        sShift.grid.sample(400, t + 24) / halloween.grid.sample(400, t))) < 1e-9);
    ok('scenario lane: α=0 ≡ quiet, α=1 ≡ base, α=1.5 extrapolates up, onset shift exact');
}

// ── 6 · catalog: deterministic, structured, cohort intact ───────────────────
const els = new Float32Array(CATALOG_N_DEFAULT * STRIDE);
const meta = synthCatalogInto(els, CATALOG_N_DEFAULT, 2022);
{
    const els2 = new Float32Array(CATALOG_N_DEFAULT * STRIDE);
    synthCatalogInto(els2, CATALOG_N_DEFAULT, 2022);
    assert.deepEqual(Buffer.from(els.buffer), Buffer.from(els2.buffer),
        'same seed → identical catalog bytes');
    const cohort = meta.cohorts.find(c => c.cls === CLS.COHORT);
    assert.equal(cohort.count, 49);
    for (let k = 0; k < 49; k++) {
        const j = (cohort.start + k) * STRIDE;
        const hp = els[j] * (1 - els[j + 1]) - R_EARTH_KM;
        assert.ok(hp > 195 && hp < 225, `cohort perigee ~210 km (got ${hp.toFixed(0)})`);
    }
    const disk = await readFile(resolve(ROOT, 'data/storm/catalog_leo20k.bin'));
    assert.deepEqual(disk, Buffer.from(els.buffer), 'committed asset matches generator');
    ok(`catalog: 20,000 objects deterministic; 49-sat cohort at 210 km perigee; ` +
        `committed asset bit-identical; ${meta.cohorts.length} documented cohorts`);
}

// ── 7 · J2 secular rates against textbook values ────────────────────────────
{
    const issRate = raanDot(R_EARTH_KM + 418, 0.0007, 51.64 * Math.PI / 180) * 86400 * 180 / Math.PI;
    assert.ok(Math.abs(issRate - -5.0) < 0.1, `ISS nodal regression ${issRate.toFixed(2)} °/day`);
    const ssoRate = raanDot(R_EARTH_KM + 700, 0.001, 98.19 * Math.PI / 180) * 86400 * 180 / Math.PI;
    assert.ok(Math.abs(ssoRate - 0.9856) < 0.03, `SSO design point ${ssoRate.toFixed(3)} °/day`);
    ok(`J2: ISS node −5.0 °/day (got ${issRate.toFixed(2)}), 700 km SSO +0.986 °/day ` +
        `(got ${ssoRate.toFixed(3)})`);
}

// ── 8 · Kepler geometry: r ∈ [perigee, apogee] around the full orbit ────────
{
    const a = R_EARTH_KM + 275, e = 0.0098;
    for (let k = 0; k <= 24; k++) {
        const E = keplerE((k / 24) * 2 * Math.PI, e);
        const r = a * (1 - e * Math.cos(E));
        assert.ok(r >= a * (1 - e) - 1e-6 && r <= a * (1 + e) + 1e-6);
    }
    ok(`Kepler solve: radius bounded by apsides; period(550 km) ` +
        `${periodMin(R_EARTH_KM + 550).toFixed(1)} min (expect ~95.6)`);
    assert.ok(Math.abs(periodMin(R_EARTH_KM + 550) - 95.6) < 0.5);
}

// ── 9 · full-swarm integration through Feb 2022 (the headline numbers) ──────
{
    const swarm = new SatSwarm(els, meta);
    const swarmQ = new SatSwarm(els, meta);
    const launch = 18;      // cohort deploys Feb 3 ≈18 UTC; fixture starts Feb 3 00
    for (let t = launch; t < feb.durationHours; t += 1) {
        swarm.step(feb.grid, t, 1);
        swarmQ.step(quiet.grid, t - launch, 1);   // quiet lane runs its own clock
    }
    const cohortIdx = meta.cohorts.find(c => c.cls === CLS.COHORT);
    const reIn = (sw) => {
        let m = 0;
        for (let k = 0; k < 49; k++) if (sw.flags[cohortIdx.start + k] === 2) m++;
        return m;
    };
    const lost = reIn(swarm), lostQ = reIn(swarmQ);
    // passive tumbling at 210 km dies in BOTH lanes (that's why Starlink flies
    // edge-on and thrusts); the STORM must make it happen distinctly faster.
    assert.ok(lost >= 45, `storm lane: nearly all passive cohort reenter (${lost}/49)`);
    const medianRe = (sw) => {
        const ts = [];
        for (let k = 0; k < 49; k++) {
            const v = sw.tReentry[cohortIdx.start + k];
            if (Number.isFinite(v)) ts.push(v);
        }
        ts.sort((x, y) => x - y);
        return ts.length ? ts[(ts.length / 2) | 0] : Infinity;
    };
    const mStorm = medianRe(swarm) - launch, mQuiet = medianRe(swarmQ);
    assert.ok(mStorm < mQuiet * 0.9,
        `storm decays cohort ≥10% faster (storm ${mStorm.toFixed(0)} h vs quiet ${mQuiet.toFixed(0)} h)`);
    ok(`Feb-2022 cohort (passive, bc=0.015): ${lost}/49 reenter in-window; median ` +
        `${(mStorm / 24).toFixed(1)} d after deploy vs ${(mQuiet / 24).toFixed(1)} d quiet — ` +
        `storm accelerates decay ${((mQuiet / mStorm - 1) * 100).toFixed(0)}%`);

    // nothing above 400 km reenters in a week — sanity against runaway drag
    let highRe = 0;
    for (let i = 0; i < swarm.n; i++) {
        if (swarm.flags[i] === 2 && els[i * STRIDE] * (1 - els[i * STRIDE + 1]) - R_EARTH_KM > 400) highRe++;
    }
    assert.equal(highRe, 0, 'no reentries from above 400 km within one week');
    ok('no false reentries above 400 km through the full Feb-2022 window');

    // ISS decay magnitude printed for the log (quiet-lane, m/day)
    const issI = meta.named.find(nm => nm.name === 'ISS').i;
    const dA = (els[issI * STRIDE] - swarmQ.a[issI]) * 1000 / ((feb.durationHours - launch) / 24);
    assert.ok(dA > 5 && dA < 500, `ISS quiet decay ${dA.toFixed(0)} m/day in physical band`);
    ok(`ISS decay under solar-min grid: ${dA.toFixed(0)} m/day (published solar-min ~30–80 m/day)`);
}

// ── 10 · the RACE: edge-on bc + ion raise wins in quiet, loses in the storm ─
// SpaceX flew the cohort edge-on (bc ≈ 0.004) and thrusted (~3 m/s/day of
// continuous raise ≈ 5 km/day at 210 km). The dial pair must reproduce the
// operational story: survivable quiet, unsurvivable storm.
{
    const race = (grid, t0) => {
        const one = new Float32Array(STRIDE);
        const rp = R_EARTH_KM + 210, ra = R_EARTH_KM + 340;
        one[0] = (rp + ra) / 2; one[1] = (ra - rp) / (ra + rp);
        one[2] = 53.22 * Math.PI / 180; one[6] = 0.004; one[7] = CLS.COHORT;
        const sw = new SatSwarm(one, { n: 1, cohorts: [], named: [] });
        sw.setRaiseRate(CLS.COHORT, 3.0);
        const a0 = sw.a[0];
        for (let t = t0; t < t0 + 72; t += 1) sw.step(grid, t, 1);
        return { da: sw.a[0] - a0, reentered: sw.flags[0] === 2 };
    };
    const qr = race(quiet.grid, 0);
    const sr = race(feb.grid, feb.tPeakHours - 6);
    assert.ok(!qr.reentered && qr.da > 0,
        `quiet race: thrust wins (Δa ${qr.da.toFixed(1)} km over 3 d)`);
    assert.ok(sr.da < qr.da,
        `storm race strictly worse (Δa ${sr.da.toFixed(1)} vs ${qr.da.toFixed(1)} km)`);
    ok(`the race (edge-on bc=0.004 + 3 m/s/day raise): quiet Δa +${qr.da.toFixed(1)} km / 3 d, ` +
        `feb-2022 storm Δa ${sr.da >= 0 ? '+' : ''}${sr.da.toFixed(1)} km — the storm ` +
        `${sr.reentered ? 'KILLS the raise' : 'erodes the margin'}`);
}

// ── 11 · classify(): the storm lights up the high-drag population ───────────
{
    const swarm = new SatSwarm(els, meta);
    const q0 = swarm.classify(feb.grid, 2);
    const swarm2 = new SatSwarm(els, meta);
    const qPeak = swarm2.classify(feb.grid, feb.tPeakHours);
    assert.ok(qPeak > q0, `high-drag count rises into the storm (${q0} → ${qPeak})`);
    assert.ok(swarm2.flags.subarray(
        meta.cohorts.find(c => c.cls === CLS.COHORT).start,
        meta.cohorts.find(c => c.cls === CLS.COHORT).start + 49,
    ).every(f => f === 3), 'entire 210-km cohort is high-drag at peak');
    ok(`classify: high-drag ${q0} → ${qPeak} objects into the peak; cohort fully flagged`);
}

// ── 12 · inspector record is complete and physical ──────────────────────────
{
    const swarm = new SatSwarm(els, meta);
    const issI = meta.named.find(nm => nm.name === 'ISS').i;
    const st = swarm.objectState(issI, feb.grid, feb.tPeakHours);
    assert.equal(st.name, 'ISS');
    assert.ok(st.hpKm > 400 && st.hpKm < 430 && st.qPa > 0 && st.adotKmDay < 0);
    assert.ok(Number.isFinite(st.lifeDays) && st.lifeDays > 100,
        `ISS lifetime estimate ${st.lifeDays.toFixed(0)} d`);
    ok(`inspector: ISS @${st.hpKm.toFixed(0)} km, q ${st.qPa.toExponential(1)} Pa, ` +
        `ȧ ${(st.adotKmDay * 1000).toFixed(0)} m/day, τ_life ~${(st.lifeDays / 365).toFixed(1)} yr`);
}

console.log(`\nstorm-physics: all ${n} checks passed`);
