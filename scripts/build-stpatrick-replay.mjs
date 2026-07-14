#!/usr/bin/env node
/**
 * build-stpatrick-replay.mjs — bake the St. Patrick's 2015 replay bundle
 * ═══════════════════════════════════════════════════════════════════════
 * Combines the committed Event-1 artifacts into the single static bundle
 * the front-end page loads (pp.hindcast.replay.v1 — the generic schema
 * consumed by js/hindcast-replay-engine.js):
 *
 *   model    data/hindcast/st_patrick_mar_2015_hindcast.gm_ie.json  (Φ_PC/HPI @ 5 min)
 *   obs      dsmc/fixtures/hindcast/st_patrick_mar_2015/ground_mag.csv (SYM-H/AE @ 1 min)
 *   driver   swmf/fixtures/hindcast/st_patrick_mar_2015/imf_l1.dat  (Bz/V/N @ 1 min)
 *   index    dsmc/fixtures/hindcast/st_patrick_mar_2015/historical_ap.csv (3-h GFZ ap)
 *
 * → data/hindcast/st_patrick_mar_2015_replay.json   (committed; see .gitignore)
 *
 * Ap* note: the hindcast JSON's own ap_pseudo track was emitted with a
 * v0-placeholder regression and is deliberately NOT copied into the
 * bundle. Instead we apply the JOINT TWO-EVENT fit (Gannon + Feb 2022,
 * MHD_DENSITY_PHASE0_RESULTS.md "joint fit": Ap* = −0.68 + 1.317·Φ_PC +
 * 0.623·HPI, R² = 0.627) out-of-sample and label it as such — this event
 * is the first true out-of-sample test of that mapping.
 *
 * Usage: node scripts/build-stpatrick-replay.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const p = (rel) => resolve(ROOT, rel);

const HINDCAST = p('data/hindcast/st_patrick_mar_2015_hindcast.gm_ie.json');
const GROUND   = p('dsmc/fixtures/hindcast/st_patrick_mar_2015/ground_mag.csv');
const IMF      = p('swmf/fixtures/hindcast/st_patrick_mar_2015/imf_l1.dat');
const AP       = p('dsmc/fixtures/hindcast/st_patrick_mar_2015/historical_ap.csv');
const OUT      = p('data/hindcast/st_patrick_mar_2015_replay.json');

// Joint two-event pseudo-Ap fit (see module docstring). Clamped at 0.
const APSTAR = { c0: -0.68, cPhi: 1.317, cHpi: 0.623, version: 'joint-v1 (Gannon + Feb 2022), out-of-sample' };

const START = Date.parse('2015-03-16T12:00:00Z');
const END   = Date.parse('2015-03-19T12:00:00Z');
const STEP  = 5 * 60_000;
const N     = Math.round((END - START) / STEP) + 1;   // 865

const round = (x, d) => (x == null || Number.isNaN(x) ? null : Number(x.toFixed(d)));

// ── model: Φ_PC / HPI (5-min, samples sit ~5 s before each mark) ─────────
const hc = JSON.parse(readFileSync(HINDCAST, 'utf8'));
const modelAt = new Map(); // grid index → {phi, hpi}
for (const s of hc.samples) {
    const idx = Math.round((Date.parse(s.t) - START) / STEP);
    if (idx >= 0 && idx < N) modelAt.set(idx, { phi: s.phi_pc_kv, hpi: s.hpi_gw });
}

// ── obs: SYM-H / AE (1-min CSV) ──────────────────────────────────────────
const gm = readFileSync(GROUND, 'utf8').trim().split('\n');
const gmHead = gm[0].split(',');
const iT = gmHead.indexOf('t'), iSym = gmHead.indexOf('h_comp_mean_nt'), iAe = gmHead.indexOf('sme_nt');
const obsAt = new Map(); // ms → {sym, ae}
for (let i = 1; i < gm.length; i++) {
    const c = gm[i].split(',');
    obsAt.set(Date.parse(c[iT]), { sym: parseFloat(c[iSym]), ae: parseFloat(c[iAe]) });
}

// ── driver: IMF Bz / V / N (1-min ASCII) ─────────────────────────────────
const imfAt = new Map(); // ms → {bz, v, n}
for (const line of readFileSync(IMF, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const f = line.trim().split(/\s+/).map(Number);
    const ms = Date.UTC(f[0], f[1] - 1, f[2], f[3], f[4], f[5]);
    const v = Math.hypot(f[10], f[11], f[12]);
    imfAt.set(ms, { bz: f[9], v, n: f[13] });
}

// ── index: GFZ 3-h ap staircase ──────────────────────────────────────────
const apRows = readFileSync(AP, 'utf8').trim().split('\n').slice(1).map(l => {
    const c = l.split(',');
    return { ms: Date.parse(c[0]), ap: parseFloat(c[1]) };
}).sort((a, b) => a.ms - b.ms);
function apAt(ms) {
    let cur = null;
    for (const r of apRows) { if (r.ms <= ms) cur = r.ap; else break; }
    return cur;
}

// nearest-minute lookup with a small search radius (fills 1–2 min gaps).
function nearest(map, ms, radiusMin) {
    for (let d = 0; d <= radiusMin; d++) {
        for (const s of d === 0 ? [0] : [-d, d]) {
            const hit = map.get(ms + s * 60_000);
            if (hit) return hit;
        }
    }
    return null;
}

// ── assemble grid ────────────────────────────────────────────────────────
const S = {
    phi_pc_kv: [], hpi_gw: [], ap_star: [],
    sym_h_nt: [], ae_nt: [],
    bz_nt: [], v_kms: [], n_cc: [],
    ap_real: [],
};
let modelHits = 0, obsHits = 0, imfHits = 0;
for (let i = 0; i < N; i++) {
    const ms = START + i * STEP;
    const m = modelAt.get(i) ?? modelAt.get(i + 1) ?? null;  // sample sits just before the NEXT mark for i=0
    if (m) modelHits++;
    S.phi_pc_kv.push(m ? round(m.phi, 1) : null);
    S.hpi_gw.push(m ? round(m.hpi, 1) : null);
    S.ap_star.push(m ? round(Math.max(0, APSTAR.c0 + APSTAR.cPhi * m.phi + APSTAR.cHpi * m.hpi), 1) : null);
    const o = nearest(obsAt, ms, 2);
    if (o) obsHits++;
    S.sym_h_nt.push(o ? round(o.sym, 0) : null);
    S.ae_nt.push(o ? round(o.ae, 0) : null);
    const w = nearest(imfAt, ms, 5);
    if (w) imfHits++;
    S.bz_nt.push(w ? round(w.bz, 2) : null);
    S.v_kms.push(w ? round(w.v, 0) : null);
    S.n_cc.push(w ? round(w.n, 1) : null);
    S.ap_real.push(apAt(ms));
}

const h = (iso) => (Date.parse(iso) - START) / 3600_000;

const bundle = {
    schema_version: 1,
    schema: 'pp.hindcast.replay.v1',
    event_id: 'st_patrick_mar_2015',
    label: "Mar 2015 St. Patrick's Day storm",
    storm_class: 'G4',
    variant: 'gm_ie',
    window: { start: new Date(START).toISOString(), end: new Date(END).toISOString(), step_minutes: 5 },
    series: S,
    series_meta: {
        phi_pc_kv: { label: 'Φ_PC',      units: 'kV',   source: 'BATS-R-US + Ridley (GM+IE), hc-std-v1' },
        hpi_gw:    { label: 'HPI',       units: 'GW',   source: 'BATS-R-US + Ridley (GM+IE), hc-std-v1' },
        ap_star:   { label: 'Ap*',       units: '',     source: `pseudo-Ap ${APSTAR.version}` },
        sym_h_nt:  { label: 'SYM-H',     units: 'nT',   source: 'OMNI HRO 1-min (observed)' },
        ae_nt:     { label: 'AE (SME)',  units: 'nT',   source: 'OMNI HRO 1-min (observed)' },
        bz_nt:     { label: 'Bz GSM',    units: 'nT',   source: 'OMNI HRO 1-min L1 driver (model input)' },
        v_kms:     { label: 'V_SW',      units: 'km/s', source: 'OMNI HRO 1-min L1 driver (model input)' },
        n_cc:      { label: 'N_p',       units: '/cc',  source: 'OMNI HRO 1-min L1 driver (model input)' },
        ap_real:   { label: 'ap (GFZ)',  units: '',     source: 'GFZ definitive 3-h ap' },
    },
    // Storm phases, hours from window start. quiet → sheath at the observed
    // SSC (04:48 UT Mar 17); sheath → main at the observed partial-recovery
    // maximum (12:06 UT); main → recovery at the SYM-H minimum (22:47 UT).
    phases: [
        { until_h: h('2015-03-17T04:48:00Z'), id: 'quiet',    label: 'quiet' },
        { until_h: h('2015-03-17T12:06:00Z'), id: 'sheath',   label: 'sheath · step 1' },
        { until_h: h('2015-03-17T22:47:00Z'), id: 'main',     label: 'main · step 2' },
        { until_h: Infinity,                  id: 'recovery', label: 'recovery' },
    ],
    moments: [
        { h: 0,                              phase: 'quiet',    title: 'Window opens',        body: 'Quiet driven time, 16.8 h before the shock: the model settles onto real solar wind after the relaxation ladder. Φ_PC idles near 27 kV.' },
        { h: h('2015-03-17T04:48:00Z'),      phase: 'sheath',   title: 'SSC — sheath arrives', body: 'The CME sheath slams the magnetopause: SYM-H spikes +67 nT (storm sudden commencement). The model responds within two output frames.' },
        { h: h('2015-03-17T06:19:00Z'),      phase: 'sheath',   title: 'Driving episode 1',    body: 'Sheath fields drive the first intensification: model Φ_PC peaks at 107 kV while observed SYM-H digs to −101 nT by 09:37 UT.' },
        { h: h('2015-03-17T12:06:00Z'),      phase: 'sheath',   title: 'Partial recovery',     body: 'Between sheath and cloud the driving collapses — model Φ_PC bottoms at 42 kV (11:15 UT), observed SYM-H relaxes to −38 nT. The storm looks over. It is not.' },
        { h: h('2015-03-17T13:07:00Z'),      phase: 'main',     title: 'Cloud core: Bz −26 nT', body: 'The magnetic-cloud core field turns hard south (−26 nT) and stays there for hours — near-ideal reconnection geometry at equinox.' },
        { h: h('2015-03-17T13:40:00Z'),      phase: 'main',     title: 'Driving episode 2 — Φ_PC 148 kV', body: 'The global Φ_PC maximum. Out-of-sample Ap* peaks here too; the GFZ 3-h ap reads 179 — strong, but far from its 400 ceiling. This storm is the clean linear-regime benchmark.' },
        { h: h('2015-03-17T17:20:00Z'),      phase: 'main',     title: 'HPI peak — 142 GW',    body: 'Auroral precipitation power peaks as the electrojets max out (observed AE hit 2298 nT at 13:58 UT). Aurora reached the mid-United States this night.' },
        { h: h('2015-03-17T22:47:00Z'),      phase: 'main',     title: 'SYM-H minimum −234 nT', body: 'The ring current bottoms out hours after the driving peak — the integration lag GM+IE alone cannot capture. Reproducing this depth is the RCM-coupled run’s job (run 2).' },
        { h: h('2015-03-18T12:00:00Z'),      phase: 'recovery', title: 'Long recovery',        body: 'A day later SYM-H is still below −80 nT. Fast solar wind (V ~690 km/s late Mar 18) keeps the recovery slow through the end of the window.' },
        { h: 72,                             phase: 'recovery', title: 'Window closes',        body: '72 simulated hours, 864 model samples, every driver real. Next: the ring-current (RCM2) coupled run — the Dst-depth deliverable.' },
    ],
    headline: {
        cpcp_peak_kv: 148.3, cpcp_peak_iso: '2015-03-17T13:40:00Z',
        hpi_peak_gw: 142.3,  hpi_peak_iso:  '2015-03-17T17:20:00Z',
        obs_symh_min_nt: -234, obs_symh_min_iso: '2015-03-17T22:47:00Z',
        obs_ae_max_nt: 2298, ap_real_peak: 179,
        two_step: { episode1_kv: 107.1, lull_kv: 42.1, episode2_kv: 148.3 },
        scorecard: 'data/hindcast/st_patrick_mar_2015_scorecard_gm_ie.json',
    },
    provenance: {
        model: `BATS-R-US + Ridley (SWMF), hc-std-v1 gm_ie baseline — ${hc.generated_utc}`,
        driver: 'OMNI HRO 1-min L1 IMF (swmf/fixtures/hindcast/st_patrick_mar_2015/imf_l1.dat)',
        ground_mag: 'OMNI HRO 1-min SYM-H/AE (dsmc/fixtures/hindcast/st_patrick_mar_2015/ground_mag.csv, fingerprint −234 nT @ 22:47 UT verified)',
        ap: 'GFZ definitive 3-h ap (historical_ap.csv, peak 179)',
        ap_star: APSTAR.version,
        builder: 'scripts/build-stpatrick-replay.mjs',
    },
    generated_utc: new Date().toISOString(),
};

writeFileSync(OUT, JSON.stringify(bundle));
const apStarPeak = Math.max(...S.ap_star.filter(x => x != null));
const apStarIdx = S.ap_star.indexOf(round(apStarPeak, 1));
console.log(`wrote ${OUT}`);
console.log(`grid ${N} pts · model ${modelHits} · obs ${obsHits} · imf ${imfHits}`);
console.log(`Ap* (joint fit, out-of-sample) peak: ${apStarPeak} at ${new Date(START + apStarIdx * STEP).toISOString()} (GFZ ap peak 179)`);
