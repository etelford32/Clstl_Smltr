#!/usr/bin/env node
/**
 * build-gannon-l1-replay.mjs — bake the Gannon May 2024 L1 DRIVER bundle.
 *
 * Reads the OMNI 1-min GSM fixture the SWMF hindcast runs drive from
 * (swmf/fixtures/hindcast/gannon_may_2024/imf_l1.dat) and emits
 * data/hindcast/gannon_may_2024_l1_replay.json in the pp.hindcast.replay.v1 shape,
 * so js/solar-wind-driver.js `fromReplayBundle` and the Flux Rope Simulator
 * page consume it exactly like the St. Patrick's bundle.
 *
 * This is a DRIVER-ONLY bundle (series: bz_nt, v_kms, n_cc) — the full
 * Gannon replay with model outputs stays in gannon_may_2024_replay.json
 * (different, older schema, density-focused). 5-minute bins, mean over the
 * 1-min samples in each bin, `null` where OMNI has a gap (fromReplayBundle
 * maps null → NaN, and consumers skip non-finite samples honestly rather
 * than interpolating through data that does not exist).
 *
 *   node scripts/build-gannon-l1-replay.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const SRC = fileURLToPath(new URL('swmf/fixtures/hindcast/gannon_may_2024/imf_l1.dat', ROOT));
const OUT = fileURLToPath(new URL('data/hindcast/gannon_may_2024_l1_replay.json', ROOT));

const STEP_MIN = 5;

const lines = readFileSync(SRC, 'utf8').split('\n');
const samples = [];
for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) continue;
    const f = line.trim().split(/\s+/).map(Number);
    if (f.length < 15 || f.some((x, i) => i < 7 && !Number.isFinite(x))) continue;
    const [yr, mo, dy, hr, mn] = f;
    const t = Date.UTC(yr, mo - 1, dy, hr, mn, 0);
    // Columns: 7 Bx, 8 By, 9 Bz [nT, GSM]; 10-12 Vx,Vy,Vz [km/s]; 13 N [/cc].
    const bz = f[9];
    const v = Math.hypot(f[10], f[11], f[12]);
    const n = f[13];
    samples.push({ t, bz, v, n });
}
if (!samples.length) throw new Error('no samples parsed from imf_l1.dat');
samples.sort((a, b) => a.t - b.t);

const t0 = samples[0].t;
const tEnd = samples[samples.length - 1].t;
const stepMs = STEP_MIN * 60_000;
const nBins = Math.floor((tEnd - t0) / stepMs) + 1;

const bz = new Array(nBins).fill(null);
const v = new Array(nBins).fill(null);
const n = new Array(nBins).fill(null);
{
    const acc = Array.from({ length: nBins }, () => ({ bz: 0, v: 0, n: 0, c: 0 }));
    for (const s of samples) {
        const i = Math.floor((s.t - t0) / stepMs);
        const a = acc[i];
        a.bz += s.bz; a.v += s.v; a.n += s.n; a.c++;
    }
    const r2 = (x) => Math.round(x * 100) / 100;
    for (let i = 0; i < nBins; i++) {
        if (acc[i].c) {
            bz[i] = r2(acc[i].bz / acc[i].c);
            v[i] = r2(acc[i].v / acc[i].c);
            n[i] = r2(acc[i].n / acc[i].c);
        }
    }
}

const covered = bz.filter((x) => x !== null).length;
const minBz = Math.min(...bz.filter((x) => x !== null));
const iMin = bz.indexOf(minBz);

const bundle = {
    schema_version: 1,
    schema: 'pp.hindcast.replay.v1',
    event_id: 'gannon_may_2024_l1',
    label: 'Gannon Superstorm (May 2024, G5) — L1 driver',
    storm_class: 'G5',
    variant: 'l1_driver',
    window: {
        start: new Date(t0).toISOString(),
        end: new Date(t0 + (nBins - 1) * stepMs).toISOString(),
        step_minutes: STEP_MIN,
    },
    series: { bz_nt: bz, v_kms: v, n_cc: n },
    series_meta: {
        bz_nt: { label: 'Bz GSM', units: 'nT', source: 'OMNI HRO 1-min (observed), 5-min bin means, null = gap' },
        v_kms: { label: 'V_SW', units: 'km/s', source: 'OMNI HRO 1-min |V|, 5-min bin means' },
        n_cc: { label: 'N_p', units: '/cc', source: 'OMNI HRO 1-min, 5-min bin means' },
    },
    headline: {
        obs_bz_min_nt: minBz,
        obs_bz_min_iso: new Date(t0 + iMin * stepMs).toISOString(),
        coverage: Math.round(covered / nBins * 1000) / 1000,
    },
    provenance: {
        driver: 'swmf/fixtures/hindcast/gannon_may_2024/imf_l1.dat (OMNI 1-min GSM, bow-shock-nose shifted)',
        builder: 'scripts/build-gannon-l1-replay.mjs',
        note: 'Driver-only bundle for the Flux Rope Simulator Gannon hindcast; model-output replay lives in gannon_may_2024_replay.json (legacy schema).',
    },
    generated_utc: new Date().toISOString(),
};

writeFileSync(OUT, JSON.stringify(bundle) + '\n');
console.log(`wrote ${OUT}`);
console.log(`  window ${bundle.window.start} → ${bundle.window.end} @ ${STEP_MIN} min (${nBins} bins, ${(covered / nBins * 100).toFixed(1)}% covered)`);
console.log(`  obs min Bz ${minBz} nT at ${bundle.headline.obs_bz_min_iso}`);
