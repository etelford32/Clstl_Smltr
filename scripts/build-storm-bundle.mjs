#!/usr/bin/env node
/**
 * build-storm-bundle.mjs — compose Storm Observatory lane bundles.
 * ═══════════════════════════════════════════════════════════════════════
 * Sibling of build-replay-bundle.mjs (same provenance discipline, same
 * vendored NRLMSISE-00 WASM), but emits the observatory's lane schema:
 * a full density GRID ρ(alt, t) per event, not just the 400 km narrative
 * trace — the orbital-decay hot loop is table lookups only.
 *
 * Inputs: the dsmc/fixtures/hindcast/<event>/historical_ap.csv fixtures
 * (3-hourly `t,ap,f107_sfu`), plus grace_fo_density.csv where present.
 *
 * For each hourly sample we build the REAL 7-element Ap history
 * ([daily, t, t-3h, t-6h, t-9h, mean 12–33h, mean 36–59h]) from the
 * fixture series (persistence-backfilled before the window start) —
 * unlike the Gannon page's steady-state narrative trace, spacecraft
 * drag integration wants the true history (see build-replay-bundle.mjs
 * docstring for the distinction).
 *
 * Known approximations (all recorded in provenance; any PLACEHOLDER
 * entry keeps `_is_placeholder` true and the page watermarked):
 *   • f107a (81-day centred mean) ≈ fixture-window mean — the 81-day
 *     archive is not baked into fixtures yet.
 *   • feb2022 window is extended past the fixture end by quiet
 *     persistence so the decay tail is integrable.
 *
 * Usage:
 *   node scripts/build-storm-bundle.mjs [--event <id>] [--out-dir data/storm]
 *   (no --event → builds all five lanes)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// ── event registry ─────────────────────────────────────────────────
const EVENTS = {
    feb2022_starlink: {
        label: 'Starlink Feb 2022 (G1–G2)',
        fixture: 'dsmc/fixtures/hindcast/feb_2022_starlink/historical_ap.csv',
        truth: 'dsmc/fixtures/hindcast/feb_2022_starlink/grace_fo_density.csv',
        extendHours: 7 * 24,       // decay tail: quiet persistence past fixture end
    },
    gannon_may_2024: {
        label: 'Gannon Superstorm (May 2024, G5)',
        fixture: 'dsmc/fixtures/hindcast/gannon_may_2024/historical_ap.csv',
        truth: 'dsmc/fixtures/hindcast/gannon_may_2024/grace_fo_density.csv',
        extendHours: 0,
    },
    halloween_oct_2003: {
        label: 'Halloween Storms (Oct 2003, G5)',
        fixture: 'dsmc/fixtures/hindcast/halloween_oct_2003/historical_ap.csv',
        extendHours: 0,
    },
    solar_min_dec_2019: {
        label: 'Quiet Sun (Dec 2019, solar minimum)',
        fixture: 'dsmc/fixtures/hindcast/solar_min_dec_2019/historical_ap.csv',
        extendHours: 0,
    },
    carrington_class: {
        label: 'Carrington-class (synthetic, from Halloween 2003)',
        fixture: 'dsmc/fixtures/hindcast/synth_carrington_class_from_halloween/historical_ap.csv',
        synthetic: true,
        extendHours: 0,
    },
};

const ALT_KM = Array.from({ length: 35 }, (_, k) => 150 + k * 25);   // 150…1000

// NRLMSISE-00 validity clamps. The Carrington synthesis pushes F10.7 to
// ~840 SFU, far outside the model's calibration; its polynomial expansions
// produce garbage there (non-monotonic ρ(h), log10ρ ≈ −24 at 225 km). We
// clamp the MSIS INPUTS and record it in provenance — the displayed driver
// series keeps the fixture's unclamped values so the synthetic intent shows.
const F107_MSIS_MAX = 380;
const AP_MSIS_MAX = 400;

// ── fixture CSV → { t:[ms], ap:[], f107:[] } (3-hourly) ────────────
async function readApCsv(path) {
    const txt = await readFile(resolve(ROOT, path), 'utf8');
    const rows = txt.trim().split('\n').slice(1).map(l => l.split(','));
    return {
        t: rows.map(r => Date.parse(r[0])),
        ap: rows.map(r => parseFloat(r[1])),
        f107: rows.map(r => parseFloat(r[2])),
    };
}

/** Step-lookup with persistence at both ends. */
function seriesAt(s, tMs) {
    if (tMs <= s.t[0]) return 0;
    for (let i = s.t.length - 1; i >= 0; i--) if (tMs >= s.t[i]) return i;
    return 0;
}
const apAt = (s, tMs) => s.ap[seriesAt(s, tMs)];
const f107At = (s, tMs) => s.f107[seriesAt(s, tMs)];

/** True 7-element Ap history at tMs from the 3-hourly series. */
function apHist7(s, tMs) {
    const h = 3600_000;
    const at = (hoursAgo) => apAt(s, tMs - hoursAgo * h);
    const mean = (from, to) => {           // inclusive 3-hourly samples
        let sum = 0, n = 0;
        for (let hh = from; hh <= to; hh += 3) { sum += at(hh); n++; }
        return sum / n;
    };
    return new Float64Array([mean(0, 21), at(0), at(3), at(6), at(9),
        mean(12, 33), mean(36, 59)]);
}

// ── NRLMSISE-00 (vendored WASM, same loader as build-replay-bundle) ─
let _msis = null;
async function initMsis() {
    if (_msis) return _msis;
    const wasmBytes = await readFile(resolve(ROOT, 'js/sgp4-wasm/sgp4_wasm_bg.wasm'));
    const glue = await import(resolve(ROOT, 'js/sgp4-wasm/sgp4_wasm.js'));
    await glue.default({ module_or_path: wasmBytes });
    _msis = glue.nrlmsise00_density_point;
    return _msis;
}

const doy = (d) => Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400_000) + 1;
const utSec = (d) => d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();

// ── truth CSV (t,alt_km,lat,lon,density) → bundle samples ──────────
async function readTruth(path, t0Ms) {
    const txt = await readFile(resolve(ROOT, path), 'utf8');
    return txt.trim().split('\n').slice(1).map(l => {
        const r = l.split(',');
        return {
            t_hours: +(((Date.parse(r[0]) - t0Ms) / 3600_000).toFixed(2)),
            alt_km: parseFloat(r[1]),
            rho: parseFloat(r[4]),
        };
    });
}

async function buildEvent(id, outDir) {
    const ev = EVENTS[id];
    const msis = await initMsis();
    const s = await readApCsv(ev.fixture);
    const t0 = s.t[0];
    const tEnd = s.t[s.t.length - 1] + ev.extendHours * 3600_000;
    const nT = Math.floor((tEnd - t0) / 3600_000) + 1;

    const f107Mean = Math.min(
        s.f107.reduce((a, b) => a + b, 0) / s.f107.length, F107_MSIS_MAX);
    const ap = [], f107 = [], grid = [];
    let peakI = 0, nClamped = 0;
    for (let i = 0; i < nT; i++) {
        const tMs = t0 + i * 3600_000;
        const d = new Date(tMs);
        const apNow = apAt(s, tMs), f1 = f107At(s, tMs);
        ap.push(+apNow.toFixed(1));
        f107.push(+f1.toFixed(1));
        if (apNow > ap[peakI]) peakI = i;
        if (f1 > F107_MSIS_MAX || apNow > AP_MSIS_MAX) nClamped++;
        const hist = apHist7(s, tMs).map(v => Math.min(v, AP_MSIS_MAX));
        const lst = (utSec(d) / 3600) % 24;   // lon = 0 convention (Gannon reference point)
        const row = ALT_KM.map(alt => {
            const out = msis(d.getUTCFullYear(), doy(d), utSec(d),
                alt, 0, 0, lst, f107Mean, Math.min(f1, F107_MSIS_MAX),
                new Float64Array(hist));
            return +Math.log10(out[5]).toFixed(4);
        });
        for (let j = 1; j < row.length; j++) {
            if (row[j] >= row[j - 1]) {
                throw new Error(`${id}: non-monotonic ρ(h) at t=${i} alt=${ALT_KM[j]} — ` +
                    `MSIS outside validity? ap=${apNow} f107=${f1}`);
            }
        }
        grid.push(row);
    }

    const provenance = {
        ap: ev.synthetic
            ? `SYNTHETIC — ${ev.fixture} (Carrington-class scaling of Halloween 2003; see fixture provenance.json)`
            : `GFZ definitive (real) — ${ev.fixture}`,
        f107: `fixture series — ${ev.fixture}`,
        f107a: 'PLACEHOLDER (approximated by fixture-window mean; target: 81-day centred GFZ archive)',
        density_model: 'NRLMSISE-00 (vendored Rust→WASM, js/sgp4-wasm) · real 7-element ap history per sample · lat 0, lon 0 reference column',
        ...(ev.extendHours ? {
            window_extension: `PLACEHOLDER (last ${ev.extendHours} h are quiet persistence past the fixture end; target: full-window GFZ bake via fetch-omni.mjs)`,
        } : {}),
        ...(nClamped ? {
            msis_input_clamp: `f107 ≤ ${F107_MSIS_MAX} SFU, ap ≤ ${AP_MSIS_MAX} enforced on ` +
                `${nClamped} samples (NRLMSISE-00 validity envelope; displayed drivers keep ` +
                `the fixture's unclamped values)`,
        } : {}),
        ...(ev.truth ? { truth: `GRACE-FO derived density (TU Delft) — ${ev.truth}` } : {}),
    };
    const isPlaceholder = Object.values(provenance).some(v => v.includes('PLACEHOLDER'));

    const bundle = {
        _is_placeholder: isPlaceholder,
        kind: 'storm-observatory-lane',
        schema_version: 1,
        event: id,
        label: ev.label,
        generated_utc: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        window: {
            start: new Date(t0).toISOString().replace(/\.\d+Z$/, 'Z'),
            end: new Date(t0 + (nT - 1) * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z'),
            step_minutes: 60,
        },
        t_peak_hours: peakI,
        drivers: { ap, f107 },
        density_grid: { alt_km: ALT_KM, log10_rho: grid },
        ...(ev.truth ? { truth: { source: 'GRACE-FO (TU Delft v02c)', samples: await readTruth(ev.truth, t0) } } : {}),
        provenance,
    };

    await mkdir(resolve(ROOT, outDir), { recursive: true });
    const out = resolve(ROOT, outDir, `${id}.json`);
    await writeFile(out, JSON.stringify(bundle));
    console.log(`✓ ${id}: ${nT} h × ${ALT_KM.length} alts, peak @ +${peakI} h, ` +
        `placeholder=${isPlaceholder} → ${out.replace(ROOT + '/', '')}`);
}

const args = process.argv.slice(2);
const evArg = args.includes('--event') ? args[args.indexOf('--event') + 1] : null;
const outDir = args.includes('--out-dir') ? args[args.indexOf('--out-dir') + 1] : 'data/storm';
for (const id of evArg ? [evArg] : Object.keys(EVENTS)) {
    await buildEvent(id, outDir);
}
