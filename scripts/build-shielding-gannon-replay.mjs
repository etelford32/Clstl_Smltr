#!/usr/bin/env node
/**
 * build-shielding-gannon-replay.mjs — bake the Gannon May-2024 replay
 * bundle for the Shielding Lab (pp.hindcast.replay.v1).
 *
 * NEEDS NETWORK to NASA SPDF (directly or via a deployed /api/omni/imf).
 * The Claude Code sandbox usually can't reach SPDF — run this on a
 * networked machine and commit the output; the Shielding Lab's Gannon
 * replay button lights up automatically once the file exists.
 *
 *   node scripts/build-shielding-gannon-replay.mjs
 *   node scripts/build-shielding-gannon-replay.mjs --base http://localhost:3000
 *
 * Sources (all real, provenance recorded in the bundle):
 *   - OMNI HRO 1-min via <base>/api/omni/imf — Bz/By GSM, v, n, SYM-H, AE.
 *     The endpoint owns the verified 46-column map (api/omni/imf.js);
 *     this script deliberately does NOT reparse SPDF ASCII itself.
 *   - Φ_PC reference (hourly) from the committed BATS-R-US Gannon bundle
 *     (data/hindcast/gannon_may_2024_replay.json → drivers_compact).
 *   - SME/SML ground-mag context from
 *     dsmc/fixtures/hindcast/gannon_may_2024/ground_mag.csv.
 *
 * Window: 2024-05-10T12 → 05-13T12 (hc-std-v1 event window), 5-min cadence.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'hindcast', 'gannon_shielding_replay.json');

const args = process.argv.slice(2);
const baseIx = args.indexOf('--base');
const BASE = baseIx >= 0 ? args[baseIx + 1] : 'https://parkersphysics.com';

const WINDOW = { start: '2024-05-10T12:00:00Z', end: '2024-05-13T12:00:00Z', step_minutes: 5 };
const STEP_MS = WINDOW.step_minutes * 60_000;
const T0 = Date.parse(WINDOW.start);
const N = Math.floor((Date.parse(WINDOW.end) - T0) / STEP_MS) + 1;

function gridIndex(iso) {
    const i = Math.round((Date.parse(iso) - T0) / STEP_MS);
    return i >= 0 && i < N ? i : null;
}

// ── 1. OMNI drivers via the endpoint ────────────────────────────────────
console.error(`Fetching OMNI HRO via ${BASE}/api/omni/imf …`);
const url = `${BASE}/api/omni/imf?start=2024-05-10&end=2024-05-13&step_min=5` +
    `&fields=t,bz_gsm,by_gsm,v,np,ae,sym_h`;
const resp = await fetch(url);
if (!resp.ok) {
    console.error(`FATAL: OMNI fetch failed (HTTP ${resp.status}). Run on a networked machine,`);
    console.error(`or point --base at a dev server (node dev-server.mjs) with SPDF access.`);
    process.exit(1);
}
const omni = (await resp.json()).data;

const series = {
    bz_nt: new Array(N).fill(null),
    by_nt: new Array(N).fill(null),
    v_kms: new Array(N).fill(null),
    n_cc: new Array(N).fill(null),
    sym_h_nt: new Array(N).fill(null),
    ae_nt: new Array(N).fill(null),
    sml_nt: new Array(N).fill(null),
    phi_pc_kv: new Array(N).fill(null),
};

let placed = 0;
for (let k = 0; k < omni.t.length; k++) {
    const i = gridIndex(omni.t[k]);
    if (i == null) continue;
    series.bz_nt[i] = omni.bz_gsm?.[k] ?? null;
    series.by_nt[i] = omni.by_gsm?.[k] ?? null;
    series.v_kms[i] = omni.v?.[k] ?? null;
    series.n_cc[i] = omni.np?.[k] ?? null;
    series.sym_h_nt[i] = omni.sym_h?.[k] ?? null;
    series.ae_nt[i] = omni.ae?.[k] ?? null;
    placed++;
}
console.error(`  placed ${placed}/${N} OMNI samples`);

// ── 2. Φ_PC reference from the committed BATS-R-US bundle (hourly) ──────
const gannon = JSON.parse(readFileSync(join(ROOT, 'data/hindcast/gannon_may_2024_replay.json'), 'utf8'));
const dc = gannon.drivers_compact || {};
if (Array.isArray(dc.phi_pc_kv)) {
    const gw = gannon.window;
    const g0 = Date.parse(gw.start);
    const gStepMs = (gw.step_minutes || 60) * 60_000;
    for (let k = 0; k < dc.phi_pc_kv.length; k++) {
        const i = gridIndex(new Date(g0 + k * gStepMs).toISOString());
        if (i != null) series.phi_pc_kv[i] = dc.phi_pc_kv[k];
    }
    console.error(`  placed ${dc.phi_pc_kv.length} hourly Φ_PC reference points`);
}

// ── 3. SML from the committed ground-mag fixture (1-min → step-sampled) ─
try {
    const csv = readFileSync(join(ROOT, 'dsmc/fixtures/hindcast/gannon_may_2024/ground_mag.csv'), 'utf8');
    const lines = csv.trim().split('\n');
    const head = lines[0].split(',');
    const tCol = head.indexOf('t');
    const smlCol = head.indexOf('sml_nt');
    let got = 0;
    for (let r = 1; r < lines.length; r++) {
        const parts = lines[r].split(',');
        const i = gridIndex(parts[tCol]);
        if (i == null) continue;
        const v = Number(parts[smlCol]);
        if (Number.isFinite(v)) {
            series.sml_nt[i] = v;
            got++;
        }
    }
    console.error(`  placed ${got} SML samples`);
} catch (e) {
    console.error(`  WARN: ground_mag.csv unavailable (${e.message}) — sml_nt stays null`);
}

// ── 4. Assemble + write ─────────────────────────────────────────────────
const bundle = {
    schema_version: 1,
    schema: 'pp.hindcast.replay.v1',
    event_id: 'may_2024_gannon_shielding',
    label: 'Gannon G5 — Shielding Lab drivers',
    storm_class: 'G5',
    variant: 'shielding_lab_drivers',
    window: WINDOW,
    series,
    series_meta: {
        bz_nt: { label: 'Bz GSM', units: 'nT', source: 'OMNI HRO 1-min via /api/omni/imf' },
        by_nt: { label: 'By GSM', units: 'nT', source: 'OMNI HRO 1-min via /api/omni/imf' },
        v_kms: { label: 'v_sw', units: 'km/s', source: 'OMNI HRO 1-min via /api/omni/imf' },
        n_cc: { label: 'n_p', units: 'cm^-3', source: 'OMNI HRO 1-min via /api/omni/imf' },
        sym_h_nt: { label: 'SYM-H', units: 'nT', source: 'OMNI HRO 1-min (observed)' },
        ae_nt: { label: 'AE', units: 'nT', source: 'OMNI HRO 1-min (observed)' },
        sml_nt: { label: 'SML', units: 'nT', source: 'SuperMAG-style ground mag (dsmc fixture)' },
        phi_pc_kv: { label: 'Φ_PC (SWMF IE)', units: 'kV', source: 'BATS-R-US + Ridley, hourly, from gannon_may_2024_replay.json' },
    },
    phases: [
        { until_h: 4.7, id: 'quiet', label: 'quiet' },
        { until_h: 10.0, id: 'shock', label: 'shock + sheath' },
        { until_h: 24.0, id: 'main', label: 'main phase' },
        { until_h: null, id: 'recovery', label: 'recovery' },
    ],
    provenance: {
        driver: `OMNI HRO 1-min via ${BASE}/api/omni/imf (verified 46-col map)`,
        phi_pc: 'BATS-R-US + Ridley (SWMF) Gannon hindcast, hourly',
        ground_mag: 'dsmc/fixtures/hindcast/gannon_may_2024/ground_mag.csv',
        f107_note: 'engine uses F10.7 = 230 (≈GFZ definitive for 2024-05-10/11)',
        baker: 'scripts/build-shielding-gannon-replay.mjs',
    },
    generated_utc: new Date().toISOString(),
};

writeFileSync(OUT, JSON.stringify(bundle));
console.error(`Wrote ${OUT} (${(JSON.stringify(bundle).length / 1024).toFixed(0)} KB, ${N} samples)`);
