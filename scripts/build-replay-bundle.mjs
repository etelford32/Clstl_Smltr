#!/usr/bin/env node
/**
 * build-replay-bundle.mjs — compose the Gannon page's replay JSON
 * ═══════════════════════════════════════════════════════════════════════
 * Reads every input the Day-1/Day-2 runbook produces and emits the
 * canonical bundle the front-end (`gannon-superstorm.html`) reads at
 * boot. Where an input is real, that input's contribution carries
 * real numbers in the output; where an input is missing or carries
 * `is_placeholder: true`, the bundle falls back to the synthetic
 * placeholder values and the output's `_is_placeholder` stays true.
 *
 * Inputs (auto-detected if at default paths; flags below override):
 *   --imf            data/hindcast/inputs/imf_l1.json
 *                      OMNI 1-min IMF → bz_nt, v_kms traces
 *   --grace          data/hindcast/inputs/grace_fo_density.json
 *                      → truth_400km.grace_fo scatter
 *   --hindcast       data/hindcast/gannon_may_2024_hindcast.json
 *                      BATS-R-US Φ_PC + HPI → drivers + MHD-track input
 *   --historical-ap  (optional) GFZ definitive Ap CSV (3-h cadence,
 *                      `t,ap` header)
 *   --ground-mag     (optional) ground-mag CSV (t,sme_nt,jh_proxy_gw …)
 *   --swarm-c        (optional) Swarm-C density CSV (t,alt_km,…,rho_kg_m3)
 *   --fit            (optional) pseudo-Ap fit JSON; if absent we use
 *                      stub coefficients that survive smoke tests but
 *                      tag the bundle as placeholder-input
 *
 * Output:
 *   --out            data/hindcast/gannon_may_2024_replay.json
 *
 * Modeling
 * --------
 * For every sample on the grid we compute three MSIS densities at
 * 400 km, lat=0, lon=0 (the conventional equatorial-noon reference
 * point used for Gannon comparisons), driven by three distinct Ap
 * series:
 *   • ap_real  : the saturated-at-400 official series
 *   • ap_mhd   : a + b·Φ_PC + c·HPI         (MHD-driven Ap*)
 *   • ap_gnd   : a' + b'·SME + c'·jh_proxy  (ground-mag-driven Ap*)
 *
 * MSIS is the vendored NRLMSISE-00 Rust→WASM at
 * `js/sgp4-wasm/sgp4_wasm_bg.wasm`. We call `nrlmsise00_density_point`
 * directly (the page-side `js/nrlmsise00-bridge.js` adds TimeBus +
 * F10.7-history fetch which we don't need in a build script).
 * Each call returns 11 outputs; we read index [5] (total mass density,
 * kg/m³). Performance: 73 samples × 3 tracks ≈ 220 calls per bundle,
 * < 300 ms wall-clock.
 *
 * The Ap-history input to MSIS is 7 elements: [daily, t, t-3h, t-6h,
 * t-9h, mean(t-12..t-33), mean(t-36..t-59)]. For the page's narrative
 * trace (a single representative scalar per time-step, not a
 * spacecraft track) we use the current Ap value across all 7 slots —
 * "if Ap has been steady at this level, what does MSIS predict?".
 * That's the right framing for the page; spacecraft drag forecasts
 * use the real history.
 *
 * Provenance discipline
 * ---------------------
 * Every contributing input gets a `provenance.<key>` string in the
 * output recording either "<source> — <path> @ <fetched_at>" or
 * "PLACEHOLDER (target: …)". `_is_placeholder` is true iff any
 * provenance entry says PLACEHOLDER. The page's existing
 * watermark + provenance pill key off that flag.
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ── arg parser (same shape as the fetchers) ────────────────────────

function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === "-v" || a === "--verbose") { out.verbose = true; continue; }
        if (a === "-h" || a === "--help")    { out.help = true; continue; }
        if (a === "--allow-missing")          { out.allowMissing = true; continue; }
        if (a === "--force")                  { out.force = true; continue; }
        if (a.startsWith("--")) {
            const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            out[key] = argv[i + 1];
            i++;
            continue;
        }
        throw new Error(`Unrecognised arg: ${a}`);
    }
    return out;
}
function log(args, ...m) { if (args.verbose) console.error("[build-replay]", ...m); }

// ── defaults ───────────────────────────────────────────────────────

const DEFAULTS = {
    imf:           "data/hindcast/inputs/imf_l1.json",
    grace:         "data/hindcast/inputs/grace_fo_density.json",
    hindcast:      "data/hindcast/gannon_may_2024_hindcast.json",
    historicalAp:  "dsmc/fixtures/hindcast/gannon_may_2024/historical_ap.csv",
    groundMag:     "dsmc/fixtures/hindcast/gannon_may_2024/ground_mag.csv",
    swarmC:        "dsmc/fixtures/hindcast/gannon_may_2024/swarm_c_density.csv",
    fit:           "data/hindcast/gannon_may_2024_pseudo_ap_fit.json",
    out:           "data/hindcast/gannon_may_2024_replay.json",
};
const WINDOW_DEFAULT = {
    start: "2024-05-10T12:00:00Z",
    end:   "2024-05-13T12:00:00Z",
    step_minutes: 60,
};

// ── time helpers ───────────────────────────────────────────────────

function parseIso(s) {
    if (s.length === 10) s = s + "T00:00:00Z";
    return new Date(s);
}
function iso(d) { return d.toISOString().replace(/\.\d+Z$/, "Z"); }
function doy(d) {
    const start = Date.UTC(d.getUTCFullYear(), 0, 1);
    return Math.floor((d - start) / 86400_000) + 1;
}
function utSec(d) {
    return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
}
function lstHr(d, lonDeg = 0) {
    return ((utSec(d) / 3600) + lonDeg / 15 + 24) % 24;
}

// Build the sample grid: N timestamps at step_minutes cadence,
// inclusive of both window.start and window.end.
function buildGrid({ start, end, step_minutes }) {
    const t0 = parseIso(start).getTime();
    const t1 = parseIso(end).getTime();
    const dt = step_minutes * 60_000;
    const grid = [];
    for (let t = t0; t <= t1 + 1; t += dt) grid.push(new Date(t));
    return grid;
}

// ── tiny file helpers ──────────────────────────────────────────────

async function tryReadJson(path, args) {
    try {
        await stat(path);
        log(args, "read", path);
        return JSON.parse(await readFile(path, "utf8"));
    } catch {
        return null;
    }
}
async function tryReadCsv(path, args) {
    try {
        await stat(path);
        log(args, "read", path);
        return await readFile(path, "utf8");
    } catch {
        return null;
    }
}

// Parse a simple CSV with header row. Returns array of objects keyed
// by header names. Empty lines and lines beginning with `#` skipped.
export function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter(L => L.trim() && !L.startsWith("#"));
    if (lines.length === 0) return [];
    const headers = lines[0].split(",").map(s => s.trim());
    return lines.slice(1).map(L => {
        const fields = L.split(",").map(s => s.trim());
        const obj = {};
        headers.forEach((h, i) => { obj[h] = fields[i]; });
        return obj;
    });
}

// ── resamplers ─────────────────────────────────────────────────────

// Linear interpolation onto the sample grid from a series of
// (Date, number) pairs. Returns a Float64Array of length grid.length.
export function resampleLinear(series, grid) {
    const out = new Float64Array(grid.length);
    if (series.length === 0) return out.fill(NaN);
    // Series must be sorted by t.
    let j = 0;
    for (let i = 0; i < grid.length; i++) {
        const t = grid[i].getTime();
        while (j + 1 < series.length && series[j + 1][0].getTime() < t) j++;
        const [t0, v0] = series[j];
        if (j + 1 >= series.length) { out[i] = v0; continue; }
        const [t1, v1] = series[j + 1];
        if (t <= t0.getTime()) { out[i] = v0; continue; }
        if (t >= t1.getTime()) { out[i] = v1; continue; }
        const f = (t - t0.getTime()) / (t1.getTime() - t0.getTime());
        out[i] = v0 + f * (v1 - v0);
    }
    return out;
}

// Step-after resample for series that hold each value until the next
// observation (e.g., 3-h Ap bins). Returns Float64Array.
export function resampleStep(series, grid) {
    const out = new Float64Array(grid.length);
    if (series.length === 0) return out.fill(NaN);
    let j = 0;
    for (let i = 0; i < grid.length; i++) {
        const t = grid[i].getTime();
        while (j + 1 < series.length && series[j + 1][0].getTime() <= t) j++;
        out[i] = series[j][1];
    }
    return out;
}

// ── input loaders ──────────────────────────────────────────────────

function loadImf(json) {
    // imf_l1.json from fetch-omni.mjs: { records: [{t, bx, by, bz, vx, vy, vz, n, tp}, ...] }
    return json.records.map(r => ({
        t:  new Date(r.t),
        bz: r.bz,
        // Total speed magnitude from GSM components. For the page-side
        // V_SW we want |V|, not Vx alone (which can be negative in
        // GSM and would confuse the narrative).
        vsw: Math.sqrt(r.vx * r.vx + r.vy * r.vy + r.vz * r.vz),
    })).sort((a, b) => a.t - b.t);
}

function loadHindcast(json) {
    // gannon_may_2024_hindcast.json: { samples: [{t, phi_pc_kv, hpi_gw}], is_placeholder }
    const samples = (json.samples || []).map(s => ({
        t: new Date(s.t),
        phi_pc_kv: s.phi_pc_kv,
        hpi_gw:    s.hpi_gw,
    })).sort((a, b) => a.t - b.t);
    return { samples, isPlaceholder: !!json.is_placeholder };
}

function loadHistoricalAp(csvText) {
    // Header: t,ap   (with 3-h cadence; UTC ISO timestamps)
    const rows = parseCsv(csvText);
    return rows.map(r => ({ t: new Date(r.t), ap: Number(r.ap) }))
               .filter(r => Number.isFinite(r.ap))
               .sort((a, b) => a.t - b.t);
}

function loadGroundMag(csvText) {
    // Header: t,sme_nt,smu_nt,sml_nt,h_comp_mean_nt,jh_proxy_gw[,_is_placeholder]
    // If any row carries _is_placeholder=1, the whole fixture is synthetic.
    const rows = parseCsv(csvText);
    const isPlaceholder = rows.some(r => Number(r._is_placeholder) === 1);
    const series = rows.map(r => ({
        t:           new Date(r.t),
        sme_nt:      Number(r.sme_nt),
        jh_proxy_gw: Number(r.jh_proxy_gw),
    })).filter(r => Number.isFinite(r.sme_nt))
       .sort((a, b) => a.t - b.t);
    return { series, isPlaceholder };
}

function loadGrace(json) {
    // grace_fo_density.json from fetch-grace.mjs: {records: [{t, alt_km, lat_deg, lon_deg, rho_kg_m3}]}
    return json.records.map(r => ({
        t:   new Date(r.t),
        rho: r.rho_kg_m3,
    })).sort((a, b) => a.t - b.t);
}

function loadSwarmCsv(csvText) {
    // Header: t,alt_km,lat_deg,lon_deg,density_kg_m3
    const rows = parseCsv(csvText);
    return rows.map(r => ({
        t:   new Date(r.t),
        rho: Number(r.density_kg_m3 ?? r.rho_kg_m3),
    })).filter(r => Number.isFinite(r.rho))
       .sort((a, b) => a.t - b.t);
}

function loadFit(json) {
    // fit JSON schema from fit_pseudo_ap.py:
    //   v1 keys (MHD only): { a, b, c, r2 }
    //   v2 keys (general):  { coefficients: { intercept, <feature_name>: coef, ... }, features: [...], r2 }
    if (!json) return null;
    if ("coefficients" in json) {
        const c = json.coefficients;
        return {
            intercept: c.intercept ?? 0,
            byFeature: Object.fromEntries(
                Object.entries(c).filter(([k]) => k !== "intercept")
            ),
            r2: json.r2 ?? null,
        };
    }
    // Legacy MHD format
    return {
        intercept: json.a,
        byFeature: { phi_pc_kv: json.b, hpi_gw: json.c },
        r2: json.r2 ?? null,
    };
}

// ── MSIS via WASM ──────────────────────────────────────────────────

const MSIS_WASM_PATH = "js/sgp4-wasm/sgp4_wasm_bg.wasm";
const MSIS_GLUE_PATH = "./js/sgp4-wasm/sgp4_wasm.js";

let _msis = null;
async function initMsis() {
    if (_msis) return _msis;
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, "..");
    const wasmBytes = await readFile(resolve(repoRoot, MSIS_WASM_PATH));
    const glue = await import(resolve(repoRoot, MSIS_GLUE_PATH.replace("./", "")));
    await glue.default({ module_or_path: wasmBytes });
    _msis = { density: glue.nrlmsise00_density_point };
    return _msis;
}

// 7-element Ap history filled with current value. See module docstring
// for why this is the right framing for the page's representative trace.
function _apHist7(ap) {
    return new Float64Array([ap, ap, ap, ap, ap, ap, ap]);
}

// Returns mass density [kg/m³] at altitude=400 km, lat=0, lon=0,
// driven by the given Ap value. F10.7 defaults are Gannon-week values
// from NOAA SWPC (May 10-13, 2024).
const F107_DEFAULT  = 220;   // daily sfu, Gannon week running ~210-225
const F107A_DEFAULT = 195;   // 81-day centered avg, May 2024
function msisAt400(msis, d, ap, f107 = F107_DEFAULT, f107a = F107A_DEFAULT) {
    const out = msis.density(
        d.getUTCFullYear(), doy(d), utSec(d),
        400, 0, 0, lstHr(d, 0),
        f107a, f107,
        _apHist7(ap),
    );
    return out[5];   // total mass density, kg/m³
}

// ── Ap-surrogate computations ──────────────────────────────────────

// MHD track: ap_mhd = intercept + b_phi·Φ_PC + c_hpi·HPI (+ any extras)
// Ground track: ap_gnd = intercept + b_sme·SME + c_jh·jh_proxy
// Either track returns null if the fit lacks the features we need.
function applyFit(fit, featureValues) {
    if (!fit) return null;
    let sum = fit.intercept;
    for (const [feat, coef] of Object.entries(fit.byFeature)) {
        const v = featureValues[feat];
        if (!Number.isFinite(v)) return null;
        sum += coef * v;
    }
    // Ap is non-negative by physical definition.
    return Math.max(0, sum);
}

// Two stub fits used when the real ones aren't on disk yet. These are
// the values from the placeholder smoke run in the runbook — they
// produce a numerically plausible (but synthetic) surrogate trace.
// Bundles built from these get tagged placeholder.
const STUB_MHD_FIT = {
    intercept: 6.92, byFeature: { phi_pc_kv: 4.616, hpi_gw: -2.725 }, r2: 0.79,
};
const STUB_GND_FIT = {
    intercept: 67.11, byFeature: { sme_nt: -0.045, jh_proxy_gw: 0.561 }, r2: 0.48,
};

// ── bundle composer ────────────────────────────────────────────────

async function compose(args) {
    const out = {};
    const provenance = {};
    let bundleIsPlaceholder = false;

    // ── window ─────────────────────────────────────────────────────
    const start = args.start || WINDOW_DEFAULT.start;
    const end   = args.end   || WINDOW_DEFAULT.end;
    const stepMin = Number(args.stepMinutes || WINDOW_DEFAULT.step_minutes);
    const grid = buildGrid({ start, end, step_minutes: stepMin });
    log(args, `grid: ${grid.length} samples × ${stepMin}-min cadence`);

    // ── inputs (each optional; missing → placeholder for that field) ─

    const imfJson      = await tryReadJson(args.imf      || DEFAULTS.imf,      args);
    const graceJson    = await tryReadJson(args.grace    || DEFAULTS.grace,    args);
    const hindcastJson = await tryReadJson(args.hindcast || DEFAULTS.hindcast, args);
    const fitJson      = await tryReadJson(args.fit      || DEFAULTS.fit,      args);
    const apCsv        = await tryReadCsv(args.historicalAp || DEFAULTS.historicalAp, args);
    const gmCsv        = await tryReadCsv(args.groundMag    || DEFAULTS.groundMag,    args);
    const swarmCsv     = await tryReadCsv(args.swarmC       || DEFAULTS.swarmC,       args);

    // ── drivers: Bz, V_SW from IMF ─────────────────────────────────
    let bz_nt, v_kms;
    if (imfJson) {
        const recs = loadImf(imfJson);
        const series_bz  = recs.map(r => [r.t, r.bz]);
        const series_v   = recs.map(r => [r.t, r.vsw]);
        bz_nt = Array.from(resampleLinear(series_bz, grid)).map(r1);
        v_kms = Array.from(resampleLinear(series_v,  grid)).map(r0);
        provenance.imf = `OMNI HRO 1-min (real) — ${args.imf || DEFAULTS.imf} @ ${imfJson.fetched_at || "unknown"}`;
    } else {
        bz_nt = placeholderArray(grid.length, "bz_nt");
        v_kms = placeholderArray(grid.length, "v_kms");
        provenance.imf = "PLACEHOLDER (target: OMNI HRO 1-min via SPDF)";
        bundleIsPlaceholder = true;
    }

    // ── drivers: Φ_PC, HPI from BATS-R-US hindcast ─────────────────
    let phi_pc_kv, hpi_gw;
    let mhdIsPlaceholder = false;
    if (hindcastJson) {
        const { samples, isPlaceholder } = loadHindcast(hindcastJson);
        const series_phi = samples.map(s => [s.t, s.phi_pc_kv]);
        const series_hpi = samples.map(s => [s.t, s.hpi_gw]);
        phi_pc_kv = Array.from(resampleLinear(series_phi, grid)).map(r1);
        hpi_gw    = Array.from(resampleLinear(series_hpi, grid)).map(r1);
        mhdIsPlaceholder = isPlaceholder;
        provenance.mhd = isPlaceholder
            ? "PLACEHOLDER (target: BATS-R-US replay, MPI_NPROC=4)"
            : `BATS-R-US (real) — ${args.hindcast || DEFAULTS.hindcast}`;
        if (isPlaceholder) bundleIsPlaceholder = true;
    } else {
        phi_pc_kv = placeholderArray(grid.length, "phi_pc_kv");
        hpi_gw    = placeholderArray(grid.length, "hpi_gw");
        provenance.mhd = "PLACEHOLDER (target: BATS-R-US replay, MPI_NPROC=4)";
        bundleIsPlaceholder = true;
    }

    // ── drivers: Ap real (3-h step) ────────────────────────────────
    let ap_real;
    if (apCsv) {
        const apRows = loadHistoricalAp(apCsv);
        const series_ap = apRows.map(r => [r.t, r.ap]);
        ap_real = Array.from(resampleStep(series_ap, grid)).map(r0);
        provenance.ap = `GFZ definitive (real) — ${args.historicalAp || DEFAULTS.historicalAp}`;
    } else {
        ap_real = placeholderArray(grid.length, "ap_real");
        provenance.ap = "PLACEHOLDER (target: GFZ Kp_ap_Ap_SN_F107)";
        bundleIsPlaceholder = true;
    }

    // ── drivers: SME from ground-mag ───────────────────────────────
    let sme_nt;
    let gmSeries = null;
    if (gmCsv) {
        const loaded = loadGroundMag(gmCsv);
        gmSeries = loaded.series;
        const series_sme = gmSeries.map(r => [r.t, r.sme_nt]);
        sme_nt = Array.from(resampleLinear(series_sme, grid)).map(r0);
        provenance.ground_mag = loaded.isPlaceholder
            ? `PLACEHOLDER (target: SuperMAG / INTERMAGNET) — input ${args.groundMag || DEFAULTS.groundMag} carries _is_placeholder=1`
            : `Ground-mag (real) — ${args.groundMag || DEFAULTS.groundMag}`;
        if (loaded.isPlaceholder) bundleIsPlaceholder = true;
    } else {
        sme_nt = placeholderArray(grid.length, "sme_nt");
        provenance.ground_mag = "PLACEHOLDER (target: SuperMAG / INTERMAGNET reconstruction)";
        bundleIsPlaceholder = true;
    }

    // ── pseudo-Ap fits (MHD + ground tracks) ───────────────────────
    let mhdFit = loadFit(fitJson?.mhd ?? fitJson);
    let gndFit = loadFit(fitJson?.ground);
    let fitIsPlaceholder = false;
    if (!mhdFit) { mhdFit = STUB_MHD_FIT; fitIsPlaceholder = true; }
    if (!gndFit) { gndFit = STUB_GND_FIT; fitIsPlaceholder = true; }
    provenance.regression = fitIsPlaceholder
        ? "PLACEHOLDER (stub coefficients; run fit_pseudo_ap.py against real inputs)"
        : `fit_pseudo_ap (real) — ${args.fit || DEFAULTS.fit}`;
    if (fitIsPlaceholder) bundleIsPlaceholder = true;

    // jh_proxy_gw needs to be on the grid too for the ground fit.
    let jh_proxy_gw;
    if (gmSeries) {
        const series_jh = gmSeries.map(r => [r.t, r.jh_proxy_gw]);
        jh_proxy_gw = Array.from(resampleLinear(series_jh, grid)).map(r1);
    } else {
        // Without ground-mag, surrogate jh_proxy from HPI (close enough
        // for the page's representative trace; documented in provenance).
        jh_proxy_gw = hpi_gw.slice();
    }

    // Now apply the fits sample-by-sample to produce ap_mhd, ap_gnd.
    const ap_mhd = grid.map((_, i) => r1(applyFit(mhdFit, {
        phi_pc_kv: phi_pc_kv[i], hpi_gw: hpi_gw[i],
    }) ?? ap_real[i]));
    const ap_gnd = grid.map((_, i) => r1(applyFit(gndFit, {
        sme_nt: sme_nt[i], jh_proxy_gw: jh_proxy_gw[i],
    }) ?? ap_real[i]));

    // ── MSIS for the three driver tracks ───────────────────────────
    log(args, "initialising NRLMSISE-00 WASM");
    const msis = await initMsis();
    log(args, "computing MSIS densities × 3 tracks × " + grid.length + " samples");
    const msis_apreal = grid.map((d, i) => msisAt400(msis, d, ap_real[i]));
    const msis_apmhd  = grid.map((d, i) => msisAt400(msis, d, ap_mhd[i]));
    const msis_apgnd  = grid.map((d, i) => msisAt400(msis, d, ap_gnd[i]));

    // ── truth scatter ──────────────────────────────────────────────
    const truth_grace = [];
    if (graceJson) {
        const recs = loadGrace(graceJson);
        const tStart = grid[0].getTime();
        const dur_h = (grid.at(-1) - grid[0]) / 3600_000;
        for (const r of recs) {
            const h = (r.t.getTime() - tStart) / 3600_000;
            if (h >= 0 && h <= dur_h) {
                truth_grace.push({ h: r3(h), rho: r.rho });
            }
        }
        provenance.grace_fo = `TU Delft v02 (real) — ${args.grace || DEFAULTS.grace} @ ${graceJson.fetched_at || "unknown"}`;
    } else {
        // Fall back to the placeholder bundle's scatter.
        for (const p of PLACEHOLDER_BUNDLE.truth_400km.grace_fo) truth_grace.push(p);
        provenance.grace_fo = "PLACEHOLDER (target: TU Delft v02)";
        bundleIsPlaceholder = true;
    }
    const truth_swarm = [];
    if (swarmCsv) {
        const recs = loadSwarmCsv(swarmCsv);
        const tStart = grid[0].getTime();
        const dur_h = (grid.at(-1) - grid[0]) / 3600_000;
        for (const r of recs) {
            const h = (r.t.getTime() - tStart) / 3600_000;
            if (h >= 0 && h <= dur_h) {
                truth_swarm.push({ h: r3(h), rho: r.rho });
            }
        }
        provenance.swarm_c = `Swarm-C (real) — ${args.swarmC || DEFAULTS.swarmC}`;
    } else {
        for (const p of PLACEHOLDER_BUNDLE.truth_400km.swarm_c) truth_swarm.push(p);
        provenance.swarm_c = "PLACEHOLDER (target: ESA / TU Delft Swarm-C)";
        bundleIsPlaceholder = true;
    }

    // ── skill numbers (lazy: only fill if a fit JSON had them) ─────
    const skill = (fitJson && (fitJson.skill || fitJson.mhd?.skill)) ?? {
        rmse_base: null, rmse_mhd: null, rmse_gnd: null,
        skill_mhd: null, skill_gnd: null,
        _note: "Populated by validate_density on day 3 of the runbook.",
    };

    // ── assemble ───────────────────────────────────────────────────
    provenance.validator_git = provenance.validator_git || "PLACEHOLDER";

    out._is_placeholder = bundleIsPlaceholder;
    out._warning = bundleIsPlaceholder
        ? "Bundle composed from a mix of real and placeholder inputs. See `provenance` for the breakdown. The page's PLACEHOLDER watermark stays on while this flag is true."
        : "Bundle composed from real inputs. The page's PLACEHOLDER watermark is off.";
    out.event = "gannon_may_2024";
    out.label = "Gannon Superstorm (May 2024, G5)";
    out.schema_version = 1;
    out.window = { start, end, step_minutes: stepMin };
    out.generated_utc = iso(new Date());
    out.drivers_compact = {
        _format: `Each array is sampled at window.start + i * step_minutes, length ${grid.length}.`,
        ap_real, ap_mhd, ap_gnd,
        phi_pc_kv, hpi_gw, sme_nt, bz_nt, v_kms,
    };
    out.density_400km = {
        _units: "kg/m^3",
        _note: "NRLMSISE-00 at altitude=400 km, lat=0, lon=0, F10.7=220, F10.7a=195. Ap input differs across the three tracks; everything else is identical.",
        msis_apreal,
        msis_apmhd,
        msis_apgnd,
    };
    out.truth_400km = {
        _note: "h is hours-from-window-start; rho in kg/m^3.",
        grace_fo: truth_grace,
        swarm_c:  truth_swarm,
    };
    out.fit = {
        mhd:    { ...mhdFit, _stub: fitIsPlaceholder || undefined },
        ground: { ...gndFit, _stub: fitIsPlaceholder || undefined },
    };
    out.skill = skill;
    out.provenance = provenance;

    return out;
}

// ── helpers: rounding so the JSON stays small ──────────────────────

function r0(x) { return Number.isFinite(x) ? Math.round(x) : null; }
function r1(x) { return Number.isFinite(x) ? Math.round(x * 10) / 10 : null; }
function r3(x) { return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null; }

// ── placeholder fallback ───────────────────────────────────────────
//
// When an input is missing, we want the corresponding output array to
// still match the shape the page expects. Easiest: reuse the existing
// placeholder bundle's arrays, sliced to grid length.

let PLACEHOLDER_BUNDLE = null;
async function loadPlaceholderBundle() {
    if (PLACEHOLDER_BUNDLE) return;
    // The committed replay JSON IS the placeholder. Read it from the
    // repo so we don't have to duplicate ~80 lines of synthetic data
    // here. If for some reason it isn't there, fall back to a constant
    // array so the script still runs.
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, "..");
    try {
        const text = await readFile(resolve(repoRoot, "data/hindcast/gannon_may_2024_replay.json"), "utf8");
        PLACEHOLDER_BUNDLE = JSON.parse(text);
    } catch {
        PLACEHOLDER_BUNDLE = { drivers_compact: {}, truth_400km: { grace_fo: [], swarm_c: [] } };
    }
}
function placeholderArray(n, key) {
    const src = PLACEHOLDER_BUNDLE?.drivers_compact?.[key];
    if (!Array.isArray(src)) return new Array(n).fill(0);
    if (src.length === n) return src.slice();
    if (src.length > n)   return src.slice(0, n);
    // pad short by repeating last value
    const out = src.slice();
    while (out.length < n) out.push(src.at(-1) ?? 0);
    return out;
}

// ── main ───────────────────────────────────────────────────────────

async function main() {
    let args;
    try { args = parseArgs(process.argv); }
    catch (e) { console.error("ERROR:", e.message); return 2; }

    if (args.help) {
        console.log(`Usage: node build-replay-bundle.mjs [options]

Options:
  --start YYYY-MM-DD                window start (default ${WINDOW_DEFAULT.start})
  --end   YYYY-MM-DD                window end   (default ${WINDOW_DEFAULT.end})
  --step-minutes N                  grid cadence (default ${WINDOW_DEFAULT.step_minutes})
  --imf            PATH             OMNI canonical JSON
  --grace          PATH             GRACE-FO canonical JSON
  --hindcast       PATH             BATS-R-US output JSON
  --historical-ap  PATH             GFZ Ap CSV
  --ground-mag     PATH             ground-mag CSV
  --swarm-c        PATH             Swarm-C density CSV
  --fit            PATH             pseudo-Ap fit JSON
  --out            PATH             output (default ${DEFAULTS.out})
  --allow-missing                   tolerate any missing input by falling back
                                    to placeholder values (default)
  --force                           overwrite an existing placeholder bundle
                                    with another placeholder bundle. Without
                                    --force we refuse this case to protect
                                    hand-authored placeholder narratives.
  -v, --verbose
`);
        return 0;
    }

    await loadPlaceholderBundle();
    const bundle = await compose(args);

    const outPath = resolve(args.out || DEFAULTS.out);

    // Don't-clobber guard: if we're about to write a placeholder bundle
    // over an existing placeholder bundle, the existing one might be
    // hand-authored (with deliberately dramatic peak values), and our
    // fit-derived numbers will be honest-but-less-dramatic. Refuse
    // unless --force.
    if (bundle._is_placeholder && !args.force) {
        try {
            const existing = JSON.parse(await readFile(outPath, "utf8"));
            if (existing._is_placeholder && existing.event === bundle.event) {
                console.error(
                    `\nrefusing to overwrite ${outPath}\n` +
                    `  the existing file is a placeholder bundle (possibly hand-authored\n` +
                    `  with a deliberately dramatic narrative); the bundle we just\n` +
                    `  computed from the current inputs is also placeholder, with the\n` +
                    `  peak Ap_mhd at ${Math.max(...bundle.drivers_compact.ap_mhd).toFixed(0)}\n` +
                    `  vs the existing ${Math.max(...existing.drivers_compact.ap_mhd).toFixed(0)}.\n` +
                    `  Re-run with --force to overwrite, or land real inputs first\n` +
                    `  (BATS-R-US output, fit_pseudo_ap, etc.) so the result is real.\n`,
                );
                return 1;
            }
        } catch {
            // No existing file or unreadable — fall through and write.
        }
    }

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(bundle, null, 0) + "\n");

    console.log(`wrote ${outPath}`);
    console.log(`  schema_version=${bundle.schema_version}  is_placeholder=${bundle._is_placeholder}`);
    console.log(`  grid: ${bundle.drivers_compact.ap_real.length} samples`);
    console.log(`  truth: ${bundle.truth_400km.grace_fo.length} GRACE-FO + ${bundle.truth_400km.swarm_c.length} Swarm-C`);
    console.log("  provenance:");
    for (const [k, v] of Object.entries(bundle.provenance)) {
        console.log(`    ${k.padEnd(14)} ${v.startsWith("PLACEHOLDER") ? "✗" : "✓"}  ${v}`);
    }
    return 0;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    main().then(code => process.exit(code)).catch(e => {
        console.error("FATAL:", e);
        process.exit(99);
    });
}
