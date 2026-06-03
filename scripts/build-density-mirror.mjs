#!/usr/bin/env node
/**
 * build-density-mirror.mjs — mirror TU Delft density into R2 for Lift 3
 * ═══════════════════════════════════════════════════════════════════════
 * TU Delft retired the open HTTP tree for the Doornbos v02 accelerometer
 * density products in favour of FTP-only distribution. Vercel's Edge
 * runtime can't fetch ftp://, so /api/density/tudelft can no longer pull
 * the data live. This tool closes the gap:
 *
 *   workstation: pull the daily files off TU Delft FTP   (you, manually)
 *        │   e.g. lftp/wget the grcfo_density_2024_05_*.txt files
 *        ▼
 *   node scripts/build-density-mirror.mjs --mission grace_fo \
 *        --local-dir ./tudelft_dl --upload
 *        │   parse → dedupe → canonical JSON → R2
 *        ▼
 *   R2: hindcast/gannon/density-<mission>-v1.json
 *        │
 *        ▼
 *   GET /api/density/tudelft?mission=…  ── serves the mirror (no upstream)
 *        │
 *        ▼
 *   gannon-superstorm.html  →  real GRACE-FO / Swarm-C truth scatter
 *
 * Parsing uses the SAME api/_lib/tudelft-parse.js the Edge endpoint uses,
 * so the bytes written here and the bytes the live fallback would parse
 * can never drift.
 *
 * Inputs (one of):
 *   --local-dir DIR     ingest every file in DIR matching the mission's
 *                       filename pattern (grcfo_density_*.txt / sw[r|ar]mc_…)
 *   --from-file A,B,C   ingest an explicit comma-separated list of files
 *
 * Flags:
 *   --mission M         grace_fo | swarm_c | all   (default: all)
 *   --base-subsample N  keep every N-th raw record before upload (default 1,
 *                       i.e. full ~10 s cadence; the endpoint subsamples
 *                       further per request). Use e.g. 6 (~60 s) to shrink.
 *   --out PATH          local JSON output (default
 *                       data/hindcast/inputs/density-<mission>-mirror.json)
 *   --key KEY           R2 object key override (default per-mission)
 *   --upload            publish to R2 (needs R2_* env; see api/_lib/r2-client.js)
 *   --self-test         exercise the parser on synthetic lines; no I/O
 *   -v / --verbose
 *
 * Usage
 * -----
 *   # both missions from a download dir, write locally (inspect first)
 *   node scripts/build-density-mirror.mjs --local-dir ./tudelft_dl
 *
 *   # one mission, publish to R2
 *   node scripts/build-density-mirror.mjs --mission grace_fo \
 *        --local-dir ./tudelft_dl --upload
 *
 *   # prove the parser is wired up (no files needed)
 *   node scripts/build-density-mirror.mjs --self-test
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { MISSIONS, parseTudelftLine, PARSER_VERSION } from "../api/_lib/tudelft-parse.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const SCHEMA = "tudelft-density-mirror/v1";

function abs(p) { return p.startsWith("/") ? p : resolve(REPO, p); }

function parseArgs(argv) {
    const out = { mission: "all", "base-subsample": "1", upload: false,
                  "self-test": false, verbose: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--upload")    { out.upload = true; continue; }
        if (a === "--self-test") { out["self-test"] = true; continue; }
        if (a === "-v" || a === "--verbose") { out.verbose = true; continue; }
        if (a === "-h" || a === "--help") { out.help = true; continue; }
        if (a.startsWith("--")) { out[a.slice(2)] = argv[++i]; continue; }
        throw new Error(`unrecognised arg: ${a}`);
    }
    return out;
}

function log(args, ...m) { if (args.verbose) console.error("[mirror]", ...m); }

/** Collect input file paths for a mission from --local-dir / --from-file. */
function collectFiles(args, mDef) {
    const files = [];
    if (args["from-file"]) {
        for (const f of args["from-file"].split(",").map(s => s.trim()).filter(Boolean)) {
            if (!existsSync(abs(f))) throw new Error(`--from-file path not found: ${f}`);
            files.push(abs(f));
        }
    }
    if (args["local-dir"]) {
        const dir = abs(args["local-dir"]);
        if (!existsSync(dir)) throw new Error(`--local-dir not found: ${args["local-dir"]}`);
        for (const name of readdirSync(dir)) {
            if (mDef.file_glob.test(name)) files.push(join(dir, name));
        }
    }
    return files.sort();
}

/** Parse all files for a mission → deduped, time-sorted record array. */
function ingest(args, mission, mDef) {
    const files = collectFiles(args, mDef);
    if (files.length === 0) {
        throw new Error(`no input files for ${mission}. Pass --local-dir DIR (with ` +
            `${mDef.file_glob.source} files) or --from-file a,b,c.`);
    }
    const byTime = new Map();   // t_ms → record (dedupe across overlapping files)
    let totalLines = 0, parsed = 0;
    for (const file of files) {
        const text = readFileSync(file, "utf8");
        for (const line of text.split(/\r?\n/)) {
            totalLines++;
            const r = parseTudelftLine(line, mDef.alt_min, mDef.alt_max);
            if (!r) continue;
            parsed++;
            byTime.set(r.t_ms, r);
        }
        log(args, `  ${basename(file)}: cumulative ${byTime.size} unique records`);
    }
    let records = [...byTime.values()].sort((a, b) => a.t_ms - b.t_ms);

    const baseSub = Math.max(1, parseInt(args["base-subsample"], 10) || 1);
    if (baseSub > 1) {
        records = records.filter((_, i) => i % baseSub === 0);
    }
    // Strip the internal t_ms before persisting.
    const clean = records.map(r => ({
        t: r.t, alt_km: r.alt_km, lat_deg: r.lat_deg,
        lon_deg: r.lon_deg, rho_kg_m3: r.rho_kg_m3,
    }));
    return { files, clean, totalLines, parsed, baseSub };
}

function buildArtifact(mission, mDef, ing) {
    const recs = ing.clean;
    if (recs.length === 0) throw new Error(`${mission}: 0 usable records parsed`);
    const start = recs[0].t;
    const end   = recs[recs.length - 1].t;
    const days  = [...new Set(recs.map(r => r.t.slice(0, 10)))].sort();
    return {
        schema: SCHEMA,
        mission,
        label: mDef.label,
        source: `TU Delft thermosphere density (Doornbos v02) — mirrored to R2 ` +
                `on ${new Date().toISOString().slice(0, 10)}`,
        coverage: {
            start, end,
            n_records: recs.length,
            base_subsample: ing.baseSub,
            n_files: ing.files.length,
            days,
        },
        parser_version: PARSER_VERSION,
        generated_at: new Date().toISOString(),
        records: recs,
    };
}

async function uploadToR2(key, json, mission) {
    const { R2_CONFIGURED, putObject } = await import("../api/_lib/r2-client.js");
    if (!R2_CONFIGURED) {
        throw new Error("R2 not configured — set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / " +
            "R2_SECRET_ACCESS_KEY / R2_BUCKET before --upload.");
    }
    console.log(`  uploading → R2 key '${key}' …`);
    const res = await putObject(key, json, {
        contentType: "application/json",
        cacheControl: "public, max-age=86400",
        metadata: { mission, schema: SCHEMA },
    });
    console.log(`  ✓ uploaded: ${res.size} bytes, etag ${res.etag ?? "(none)"} (HTTP ${res.status})`);
}

function selfTest() {
    const lines = [
        "# header line should be skipped",
        "% another header",
        "2024-05-10T12:00:00 490.2 -33.1 100.4 2.13e-11",   // space separator, no Z
        "2024-05-10T12:00:10Z 490.1 -32.9 100.6 2.10e-11",
        "2024-05-10T12:00:20Z 9999.0 0 0 1e-12",            // alt out of range → drop
        "2024-05-10T12:00:30Z 490.0 -32.5 101.0 -1e-12",    // negative rho → drop
        "garbage line",
    ];
    const mDef = MISSIONS.grace_fo;
    const got = lines.map(l => parseTudelftLine(l, mDef.alt_min, mDef.alt_max)).filter(Boolean);
    const ok = got.length === 2 &&
        got[0].t === "2024-05-10T12:00:00.000Z" &&
        Math.abs(got[0].rho_kg_m3 - 2.13e-11) < 1e-25 &&
        got[1].alt_km === 490.1;
    console.log(`self-test: parsed ${got.length}/2 expected records`);
    console.log(`  T-separator+no-Z normalised: ${got[0]?.t}`);
    console.log(`  out-of-range alt + negative rho dropped: ${ok ? "yes" : "NO"}`);
    console.log(`  ${ok ? "PASS" : "FAIL"} — parser shared with the Edge endpoint`);
    return ok ? 0 : 1;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]); return 0; }
    if (args["self-test"]) return selfTest();

    const missions = args.mission === "all"
        ? Object.keys(MISSIONS)
        : [args.mission];
    for (const m of missions) {
        if (!MISSIONS[m]) throw new Error(`unknown --mission '${m}' (want: ${Object.keys(MISSIONS).join(", ")}, all)`);
    }

    let built = 0;
    for (const mission of missions) {
        const mDef = MISSIONS[mission];
        let ing;
        try {
            ing = ingest(args, mission, mDef);
        } catch (e) {
            if (missions.length > 1) { console.log(`• ${mission}: skipped — ${e.message}`); continue; }
            throw e;
        }
        const artifact = buildArtifact(mission, mDef, ing);
        const json = JSON.stringify(artifact) + "\n";

        const outPath = args.out || `data/hindcast/inputs/density-${mission}-mirror.json`;
        mkdirSync(dirname(abs(outPath)), { recursive: true });
        writeFileSync(abs(outPath), json);

        const cov = artifact.coverage;
        console.log(`• ${mission}: ${cov.n_records} records ` +
            `(${(json.length / 1024).toFixed(0)} KB, ${ing.parsed}/${ing.totalLines} lines parsed, ` +
            `base-subsample ${cov.base_subsample}) → ${outPath}`);
        console.log(`    coverage ${cov.start} → ${cov.end} · ${cov.days.length} day(s): ${cov.days.join(", ")}`);

        const key = args.key || mDef.mirror_key;
        if (args.upload) {
            await uploadToR2(key, json, mission);
        } else {
            console.log(`    (dry run — pass --upload to publish to R2 key '${key}')`);
        }
        built++;
    }
    if (built === 0) throw new Error("no missions built — check --local-dir / --from-file inputs");
    return 0;
}

main().then(c => process.exit(c || 0)).catch(e => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
});
