#!/usr/bin/env node
/**
 * build-gannon-model-artifact.mjs — assemble + publish the Gannon MHD model artifact
 * ═══════════════════════════════════════════════════════════════════════════════
 * Bridges the offline BATS-R-US / SWMF pipeline outputs into the single
 * artifact the live page lifts:
 *
 *     hindcast/gannon/model-v1.json      (R2 object key)
 *         │
 *         ▼  GET /api/hindcast/gannon-model
 *     gannon-superstorm.html  →  splice ap_mhd/ap_gnd + msis_apmhd/apgnd
 *                                → flip pill to ✓ VALIDATED HINDCAST
 *
 * The contract is defined in GANNON_LIVE_DATA.md ("Lift 4 / Artifact
 * contract") and consumed by api/hindcast/gannon-model.js. Every track
 * array MUST match the bundle grid length (`drivers_compact.ap_real.length`)
 * or the page's `fits()` guard drops it.
 *
 * What it consumes (all but --bundle/--hindcast are optional; tracks are
 * added only when their inputs are present):
 *
 *   --bundle          data/hindcast/gannon_may_2024_replay.json
 *                       → the grid: window + ap_real.length + f107_daily
 *   --hindcast        data/hindcast/gannon_may_2024_hindcast.json
 *                       → phi_pc_kv / hpi_gw (+ ap_pseudo) at 5-min cadence,
 *                         written by swmf/pipeline/hindcast_runner.py
 *   --mhd-fit         data/hindcast/gannon_may_2024_pseudo_ap_fit.json
 *                       → a + b·Φ_PC + c·HPI  →  ap_mhd  (else falls back to
 *                         the hindcast's ap_pseudo column)
 *   --ground-fit      data/hindcast/gannon_may_2024_pseudo_ap_fit_ground.json
 *   --ground-features <csv with a `t` column + the fit's feature columns>
 *                       → ap_gnd (and sme_nt, if that column is present)
 *   --residuals       data/hindcast/gannon_may_2024_residuals.json
 *                       → skill { rmse_base, rmse_mhd, skill_mhd } from
 *                         validate_density.py (storm-time numbers)
 *
 * Density tracks (msis_apmhd / msis_apgnd) are NOT taken from any input —
 * they are recomputed at 400 km from ap_mhd / ap_gnd + the bundle's real
 * f107_daily via js/upper-atmosphere-engine.js `density()`, the exact same
 * Jacchia-style surrogate that produced the bundle's msis_apreal. This
 * keeps all three density traces on one backend (so residuals are honest).
 *
 * ── Integrity contract ──────────────────────────────────────────────────
 * The hindcast / fit JSONs carry placeholder sentinels (`is_placeholder`,
 * `is_placeholder_input`) when they were produced by the plumbing
 * generators rather than a real BATS-R-US run. This tool:
 *   • refuses to even ASSEMBLE from placeholder inputs unless
 *     --allow-placeholder is passed (mirrors fit_pseudo_ap.py's contract);
 *   • NEVER uploads a placeholder-derived artifact to R2 — --upload is hard
 *     -blocked if any input is flagged placeholder, regardless of
 *     --allow-placeholder. You can write + inspect a placeholder artifact
 *     locally to exercise the plumbing; you can never publish one and make
 *     the page lie "VALIDATED".
 *
 * Usage
 * -----
 *   # assemble locally (real inputs)
 *   node scripts/build-gannon-model-artifact.mjs
 *
 *   # assemble + publish to R2 (needs R2_* env vars; see api/_lib/r2-client.js)
 *   node scripts/build-gannon-model-artifact.mjs --upload
 *
 *   # exercise the plumbing against the placeholder generator output
 *   python3 scripts/gen_gannon_placeholder_mhd.py
 *   node scripts/build-gannon-model-artifact.mjs --allow-placeholder
 *
 *   # prove the density backend matches the bundle (no inputs needed)
 *   node scripts/build-gannon-model-artifact.mjs --self-test
 *
 * Idempotent: same inputs → byte-identical artifact (generated_at excepted).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { density } from "../js/upper-atmosphere-engine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

// ── Defaults (all overridable) ──────────────────────────────────────────
const DEFAULTS = {
    bundle:         "data/hindcast/gannon_may_2024_replay.json",
    hindcast:       "data/hindcast/gannon_may_2024_hindcast.json",
    "mhd-fit":      "data/hindcast/gannon_may_2024_pseudo_ap_fit.json",
    "ground-fit":   "data/hindcast/gannon_may_2024_pseudo_ap_fit_ground.json",
    "ground-features": "",   // no canonical default — pipeline-specific
    residuals:      "data/hindcast/gannon_may_2024_residuals.json",
    out:            "data/hindcast/gannon_may_2024_model_v1.json",
    key:            "hindcast/gannon/model-v1.json",
    "alt-km":       "400",
};

const ARTIFACT_SOURCE = "BATS-R-US / SWMF (Gannon May 2024 model run)";
const ALT_KM_DEFAULT  = 400;

// ── tiny arg parser (--flag value | --bool) ─────────────────────────────
function parseArgs(argv) {
    const out = { ...DEFAULTS, upload: false, "allow-placeholder": false,
                  "self-test": false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) continue;
        const key = a.slice(2);
        if (["upload", "allow-placeholder", "self-test", "help"].includes(key)) {
            out[key] = true;
        } else if (key in DEFAULTS) {
            out[key] = argv[++i];
        } else {
            throw new Error(`unknown flag: ${a}`);
        }
    }
    return out;
}

function abs(p) {
    return p.startsWith("/") ? p : resolve(REPO, p);
}
function loadJson(p) {
    return JSON.parse(readFileSync(abs(p), "utf8"));
}

// ── grid + resampling ───────────────────────────────────────────────────

/** Build the hourly grid times (ms) from the bundle window + ap_real length. */
function buildGrid(bundle) {
    const win = bundle.window;
    const n = bundle.drivers_compact?.ap_real?.length;
    if (!Number.isInteger(n) || n <= 0) {
        throw new Error("bundle.drivers_compact.ap_real is missing or empty — " +
            "cannot determine the grid length the page checks against.");
    }
    const startMs = Date.parse(win.start);
    const stepMs  = (win.step_minutes || 60) * 60_000;
    if (!Number.isFinite(startMs)) throw new Error(`bad window.start: ${win.start}`);
    const timesMs = Array.from({ length: n }, (_, i) => startMs + i * stepMs);
    return { n, startMs, stepMs, timesMs, window: win };
}

/**
 * Linear-interpolate a sorted [{tMs, v}] series onto target times.
 * Clamps at the ends. Returns null for a target only if the series is empty.
 */
function resampleLinear(series, targetMs) {
    const pts = series.filter(p => Number.isFinite(p.tMs) && Number.isFinite(p.v))
                      .sort((a, b) => a.tMs - b.tMs);
    if (pts.length === 0) return targetMs.map(() => null);
    return targetMs.map(t => {
        if (t <= pts[0].tMs) return pts[0].v;
        if (t >= pts[pts.length - 1].tMs) return pts[pts.length - 1].v;
        // binary search for the bracketing pair
        let lo = 0, hi = pts.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (pts[mid].tMs <= t) lo = mid; else hi = mid;
        }
        const a = pts[lo], b = pts[hi];
        const f = (t - a.tMs) / (b.tMs - a.tMs);
        return a.v + f * (b.v - a.v);
    });
}

// ── inputs ──────────────────────────────────────────────────────────────

/** hindcast JSON → { phi, hpi, apPseudo } resampled to grid; + placeholder flag. */
function loadHindcastTracks(path, grid) {
    const hc = loadJson(path);
    const samples = hc.samples;
    if (!Array.isArray(samples) || samples.length === 0) {
        throw new Error(`${path}: no samples[] — not a hindcast_runner.py emission`);
    }
    const toSeries = field => samples.map(s => ({
        tMs: Date.parse(s.t), v: Number(s[field]),
    }));
    const hasAp = samples.some(s => s.ap_pseudo != null);
    return {
        placeholder: !!hc.is_placeholder,
        source: hc.source,
        phi: resampleLinear(toSeries("phi_pc_kv"), grid.timesMs),
        hpi: resampleLinear(toSeries("hpi_gw"),   grid.timesMs),
        apPseudo: hasAp ? resampleLinear(toSeries("ap_pseudo"), grid.timesMs) : null,
    };
}

/** Apply a fit_pseudo_ap MHD fit (a,b,c) over the grid → ap_mhd. */
function applyMhdFit(fit, phi, hpi) {
    const a = fit.a ?? fit.coefficients?.intercept;
    const b = fit.b ?? fit.coefficients?.phi_pc_kv;
    const c = fit.c ?? fit.coefficients?.hpi_gw;
    if (![a, b, c].every(Number.isFinite)) {
        throw new Error("mhd-fit: could not read a/b/c (or coefficients.*)");
    }
    return phi.map((p, i) => clampAp(a + b * p + c * hpi[i]));
}

/**
 * Parse a ground-features CSV (header row + `t` column + numeric feature
 * columns) into { col -> sorted series }. Tolerant of the _is_placeholder
 * sentinel column the ground-mag importer can add.
 */
function loadFeaturesCsv(path) {
    const text = readFileSync(abs(path), "utf8");
    const lines = text.split(/\r?\n/).filter(L => L.trim() && !L.startsWith("#"));
    const header = lines[0].split(",").map(s => s.trim());
    const tIdx = header.indexOf("t");
    if (tIdx < 0) throw new Error(`${path}: no 't' column in header`);
    const placeholder = header.includes("_is_placeholder");
    const series = {};
    for (const col of header) if (col !== "t") series[col] = [];
    for (const line of lines.slice(1)) {
        const f = line.split(",").map(s => s.trim());
        const tMs = Date.parse(f[tIdx]);
        if (!Number.isFinite(tMs)) continue;
        for (let i = 0; i < header.length; i++) {
            const col = header[i];
            if (col === "t") continue;
            const v = Number(f[i]);
            series[col].push({ tMs, v });
        }
    }
    return { series, columns: header.filter(c => c !== "t"), placeholder };
}

/** Apply a features-CSV ground fit over the grid → ap_gnd. */
function applyGroundFit(fit, featuresByCol, grid) {
    const coeffs = fit.coefficients;
    const feats  = fit.features;
    if (!coeffs || !Array.isArray(feats)) {
        throw new Error("ground-fit: missing coefficients/features (need v2 fit JSON)");
    }
    const intercept = Number(coeffs.intercept) || 0;
    // Resample each feature column the fit needs onto the grid.
    const resampled = {};
    for (const f of feats) {
        if (!featuresByCol[f]) {
            throw new Error(`ground-features CSV has no '${f}' column required by the fit`);
        }
        resampled[f] = resampleLinear(featuresByCol[f], grid.timesMs);
    }
    return grid.timesMs.map((_, i) => {
        let ap = intercept;
        for (const f of feats) ap += Number(coeffs[f]) * resampled[f][i];
        return clampAp(ap);
    });
}

function clampAp(v) {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.round(v * 100) / 100);
}

// ── density via the shared surrogate ────────────────────────────────────
function densityTrack(apArr, f107Arr, altKm) {
    return apArr.map((ap, i) => {
        const f107 = Number.isFinite(f107Arr?.[i]) ? f107Arr[i] : 150;
        // density() returns a full state object; we want the scalar rho (kg/m³).
        const rho = density({ altitudeKm: altKm, f107Sfu: f107, ap })?.rho;
        return Number.isFinite(rho) ? rho : null;
    });
}

// ── skill mapping (validate_density residuals → artifact skill) ─────────
function mapSkill(residuals) {
    // validate_density emits storm-time + full-window RMSE for the MHD
    // candidate vs the MSIS(ap_real) baseline. The Phase-0 gate is the
    // storm-time number, so we surface those. rmse_gnd / skill_gnd require
    // a SECOND validate run driven by ap_gnd; left null until that lands.
    const r = residuals || {};
    const pct = v => (Number.isFinite(v) ? v / 100 : null);
    return {
        rmse_base: r.rmse_storm_baseline  ?? r.rmse_baseline  ?? null,
        rmse_mhd:  r.rmse_storm_candidate ?? r.rmse_candidate ?? null,
        rmse_gnd:  null,
        skill_mhd: pct(r.skill_storm_pct ?? r.skill_pct),
        skill_gnd: null,
    };
}

// ── validation of the assembled artifact ────────────────────────────────
function validateArtifact(artifact, grid) {
    const errs = [];
    const dc = artifact.drivers_compact, d4 = artifact.density_400km;
    const checkLen = (arr, name) => {
        if (arr == null) return;            // optional track, omitted
        if (!Array.isArray(arr) || arr.length !== grid.n) {
            errs.push(`${name}: length ${arr?.length} != grid ${grid.n}`);
        } else if (!arr.every(v => v === null || Number.isFinite(v))) {
            errs.push(`${name}: contains non-finite, non-null values`);
        }
    };
    for (const k of ["ap_mhd", "ap_gnd", "phi_pc_kv", "hpi_gw", "sme_nt"]) checkLen(dc[k], `drivers_compact.${k}`);
    for (const k of ["msis_apmhd", "msis_apgnd"]) checkLen(d4[k], `density_400km.${k}`);
    // The endpoint's hasModel guard: at least one ap track AND one density track.
    const hasAp = Array.isArray(dc.ap_mhd) || Array.isArray(dc.ap_gnd);
    const hasD  = Array.isArray(d4.msis_apmhd) || Array.isArray(d4.msis_apgnd);
    if (!hasAp) errs.push("no ap_mhd or ap_gnd track — endpoint would reject as artifact_missing_model_tracks");
    if (!hasD)  errs.push("no msis_apmhd or msis_apgnd track — endpoint would reject as artifact_missing_model_tracks");
    return errs;
}

// ── self-test: prove the density backend reproduces the bundle ──────────
function selfTest(bundle, grid, altKm) {
    const dc = bundle.drivers_compact;
    const have = bundle.density_400km?.msis_apreal;
    if (!Array.isArray(have)) {
        console.log("self-test: bundle has no msis_apreal to compare against — skipping");
        return 0;
    }
    const recomputed = densityTrack(dc.ap_real, dc.f107_daily, altKm);
    let maxRel = 0, worst = -1, compared = 0;
    for (let i = 0; i < grid.n; i++) {
        if (!Number.isFinite(have[i]) || !Number.isFinite(recomputed[i])) continue;
        compared++;
        const rel = Math.abs(recomputed[i] - have[i]) / Math.abs(have[i]);
        if (rel > maxRel) { maxRel = rel; worst = i; }
    }
    // Guard against a vacuous pass: if nothing compared (e.g. density() shape
    // changed and every recompute came back null), that's a FAIL, not 0 % error.
    const ok = compared > 0 && maxRel < 0.02;   // surrogate is deterministic; should be ~0
    console.log(`  compared ${compared}/${grid.n} samples`);
    console.log(`self-test: recompute msis_apreal from ap_real+f107 via density() @${altKm}km`);
    console.log(`  max relative error vs bundle: ${(maxRel * 100).toFixed(4)} %` +
        (worst >= 0 ? ` (worst at i=${worst}: ${recomputed[worst].toExponential(3)} vs ${have[worst].toExponential(3)})` : ""));
    console.log(`  ${ok ? "PASS" : "FAIL"} — density backend ${ok ? "matches" : "DIVERGES FROM"} the bundle's msis_apreal`);
    return ok ? 0 : 1;
}

// ── main ────────────────────────────────────────────────────────────────
async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { printHelp(); return 0; }

    const altKm = Number(args["alt-km"]) || ALT_KM_DEFAULT;
    const bundle = loadJson(args.bundle);
    const grid = buildGrid(bundle);

    if (args["self-test"]) return selfTest(bundle, grid, altKm);

    console.log(`grid: ${grid.n} samples, ${new Date(grid.timesMs[0]).toISOString()} ` +
        `→ ${new Date(grid.timesMs[grid.n - 1]).toISOString()} @ ${grid.stepMs / 60000}min`);

    // ── MHD track (required) ────────────────────────────────────────────
    if (!existsSync(abs(args.hindcast))) {
        throw new Error(`--hindcast not found: ${args.hindcast}\n` +
            `Run the BATS-R-US pipeline (or scripts/gen_gannon_placeholder_mhd.py for plumbing).`);
    }
    const hc = loadHindcastTracks(args.hindcast, grid);
    const placeholderInputs = [];
    if (hc.placeholder) placeholderInputs.push("hindcast");

    let ap_mhd;
    let mhdFitMeta = null;
    if (existsSync(abs(args["mhd-fit"]))) {
        const fit = loadJson(args["mhd-fit"]);
        if (fit.is_placeholder_input) placeholderInputs.push("mhd-fit");
        ap_mhd = applyMhdFit(fit, hc.phi, hc.hpi);
        mhdFitMeta = { formula: fit.formula, r2: fit.r2, rmse_ap: fit.rmse_ap };
    } else if (hc.apPseudo) {
        console.log("  (no --mhd-fit; deriving ap_mhd from the hindcast ap_pseudo column)");
        ap_mhd = hc.apPseudo.map(clampAp);
    } else {
        throw new Error("need either --mhd-fit or an ap_pseudo column in the hindcast to build ap_mhd");
    }
    const msis_apmhd = densityTrack(ap_mhd, bundle.drivers_compact.f107_daily, altKm);

    // ── ground track (optional) ─────────────────────────────────────────
    let ap_gnd = null, sme_nt = null, msis_apgnd = null, groundFitMeta = null;
    const haveGroundFit = existsSync(abs(args["ground-fit"]));
    const haveGroundFeat = args["ground-features"] && existsSync(abs(args["ground-features"]));
    if (haveGroundFit && haveGroundFeat) {
        const gfit = loadJson(args["ground-fit"]);
        if (gfit.is_placeholder_input) placeholderInputs.push("ground-fit");
        const feats = loadFeaturesCsv(args["ground-features"]);
        if (feats.placeholder) placeholderInputs.push("ground-features");
        ap_gnd = applyGroundFit(gfit, feats.series, grid);
        msis_apgnd = densityTrack(ap_gnd, bundle.drivers_compact.f107_daily, altKm);
        if (feats.series.sme_nt) sme_nt = resampleLinear(feats.series.sme_nt, grid.timesMs);
        groundFitMeta = { formula: gfit.formula, r2: gfit.r2, features: gfit.features };
    } else if (haveGroundFit) {
        console.log("  (--ground-fit present but no --ground-features CSV; skipping ap_gnd track)");
    }

    // ── skill (optional) ────────────────────────────────────────────────
    let skill = mapSkill(null);
    if (existsSync(abs(args.residuals))) {
        const res = loadJson(args.residuals);
        skill = mapSkill(res);
    } else {
        console.log("  (no --residuals; skill left null — the page recomputes deltas client-side)");
    }

    // ── assemble ────────────────────────────────────────────────────────
    const runId = `gannon-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}Z`;
    const artifact = {
        event: "gannon_may_2024",
        run_id: runId,
        generated_at: new Date().toISOString(),
        source: hc.source && !hc.placeholder ? hc.source : ARTIFACT_SOURCE,
        window: {
            start: grid.window.start,
            end: grid.window.end,
            step_minutes: grid.window.step_minutes || 60,
            anchor_iso: grid.window.anchor_iso,
        },
        drivers_compact: pruneNulls({
            ap_mhd,
            ap_gnd,
            phi_pc_kv: hc.phi.map(v => round(v, 3)),
            hpi_gw: hc.hpi.map(v => round(v, 3)),
            sme_nt,
        }),
        density_400km: pruneNulls({ msis_apmhd, msis_apgnd }),
        skill,
        provenance: {
            altitude_km: altKm,
            density_backend: "js/upper-atmosphere-engine.js density() (Jacchia-style surrogate)",
            mhd_fit: mhdFitMeta,
            ground_fit: groundFitMeta,
            inputs: {
                bundle: args.bundle, hindcast: args.hindcast,
                mhd_fit: existsSync(abs(args["mhd-fit"])) ? args["mhd-fit"] : null,
                ground_fit: haveGroundFit ? args["ground-fit"] : null,
                ground_features: haveGroundFeat ? args["ground-features"] : null,
                residuals: existsSync(abs(args.residuals)) ? args.residuals : null,
            },
        },
    };
    if (placeholderInputs.length) artifact.is_placeholder = true;

    // ── validate ────────────────────────────────────────────────────────
    const errs = validateArtifact(artifact, grid);
    if (errs.length) {
        console.error("✗ artifact failed validation:");
        for (const e of errs) console.error(`    - ${e}`);
        process.exitCode = 1;
        return 1;
    }

    // ── integrity gate ──────────────────────────────────────────────────
    const isPlaceholder = placeholderInputs.length > 0;
    if (isPlaceholder && !args["allow-placeholder"]) {
        console.error(`✗ refusing to assemble: placeholder inputs [${placeholderInputs.join(", ")}].`);
        console.error("    These are synthetic (not a real BATS-R-US run). Pass --allow-placeholder");
        console.error("    to write a local artifact for plumbing tests. It can never be --upload'ed.");
        process.exitCode = 1;
        return 1;
    }

    // ── write ───────────────────────────────────────────────────────────
    const json = JSON.stringify(artifact, null, 2) + "\n";
    writeFileSync(abs(args.out), json);
    const liveTracks = [
        artifact.drivers_compact.ap_mhd && "ap_mhd",
        artifact.drivers_compact.ap_gnd && "ap_gnd",
        artifact.drivers_compact.sme_nt && "sme_nt",
        artifact.density_400km.msis_apmhd && "msis_apmhd",
        artifact.density_400km.msis_apgnd && "msis_apgnd",
    ].filter(Boolean);
    console.log(`✓ wrote ${args.out} (${(json.length / 1024).toFixed(1)} KB)`);
    console.log(`  run_id: ${runId}`);
    console.log(`  tracks: ${liveTracks.join(", ")}`);
    console.log(`  ap_mhd peak: ${Math.max(...ap_mhd)} · msis_apmhd peak: ${Math.max(...msis_apmhd).toExponential(3)} kg/m³`);
    if (artifact.skill.skill_mhd != null) {
        console.log(`  skill_mhd: ${(artifact.skill.skill_mhd * 100).toFixed(1)} % storm-time RMSE reduction vs MSIS(ap_real)`);
    }
    if (isPlaceholder) {
        console.log(`  ⚠ PLACEHOLDER artifact (inputs: ${placeholderInputs.join(", ")}) — stamped is_placeholder:true, upload blocked.`);
    }

    // ── upload ──────────────────────────────────────────────────────────
    if (args.upload) {
        if (isPlaceholder) {
            console.error("✗ --upload BLOCKED: artifact is placeholder-derived. Publishing it would");
            console.error("    make the page show ✓ VALIDATED for synthetic data. Run the real BATS-R-US");
            console.error("    pipeline first. (No override exists by design.)");
            process.exitCode = 1;
            return 1;
        }
        await uploadToR2(args.key, json, runId);
    } else {
        console.log(`  (dry run — pass --upload to publish to R2 key '${args.key}')`);
    }
    return 0;
}

function round(v, n) {
    if (!Number.isFinite(v)) return null;
    const p = 10 ** n;
    return Math.round(v * p) / p;
}
/** Drop null-valued (absent) tracks so the JSON only carries real ones. */
function pruneNulls(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (v != null) out[k] = v;
    return out;
}

async function uploadToR2(key, json, runId) {
    const { R2_CONFIGURED, putObject } = await import("../api/_lib/r2-client.js");
    if (!R2_CONFIGURED) {
        throw new Error("R2 not configured — set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / " +
            "R2_SECRET_ACCESS_KEY / R2_BUCKET in the environment before --upload.");
    }
    console.log(`uploading → R2 key '${key}' …`);
    const res = await putObject(key, json, {
        contentType: "application/json",
        cacheControl: "public, max-age=3600",
        metadata: { run_id: runId, event: "gannon_may_2024" },
    });
    console.log(`✓ uploaded: ${res.size} bytes, etag ${res.etag ?? "(none)"} ` +
        `(HTTP ${res.status}). The page lifts to ✓ VALIDATED on next load.`);
}

function printHelp() {
    const doc = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const header = doc.slice(0, doc.indexOf("*/") + 2);
    console.log(header.replace(/^\/\*\*?|\s*\*\/?/gm, "").trim());
}

main().catch(e => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
});
