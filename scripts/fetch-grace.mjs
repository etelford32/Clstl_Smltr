#!/usr/bin/env node
/**
 * fetch-grace.mjs — Day-1 fetcher for GRACE-FO accelerometer density
 * ═══════════════════════════════════════════════════════════════════════
 * Pulls TU Delft's (Doornbos) v02 GRACE-FO neutral-density product for a
 * window, parses the per-day ASCII tables, and writes canonical JSON at
 * `data/hindcast/inputs/grace_fo_density.json` for the bundle builder.
 *
 * Source
 * ------
 *   http://thermosphere.tudelft.nl/acceldata/GraceFO/v02/density/{YYYY}/
 *   File pattern: grcfo_density_{YYYY}_{MM}_{DD}.txt
 *   Format (default): whitespace-separated, one record per line:
 *
 *     YYYY-MM-DDThh:mm:ss   alt_km   lat_deg   lon_deg   density_kg_m3
 *
 * The path occasionally moves across re-processings; if you find the
 * current host serves a different column layout, override with
 * `--columns t,alt,lat,lon,rho` or similar (see _parseColumns below).
 *
 * Mirrors the Python peer at `dsmc/pipeline/fetch_grace_density.py`.
 * That writes the validator's CSV; this writes JSON for the JS-side
 * replay-bundle builder.
 *
 * Modes
 * -----
 *   --start YYYY-MM-DD --end YYYY-MM-DD           (required, UTC)
 *   --from-file PATH                              parse one local file
 *                                                  (may repeat with comma)
 *   --local-dir DIR                               find all grcfo_density_*.txt
 *                                                  files in DIR; ingest those
 *                                                  whose date falls in window
 *   --smoke-test                                  exercise parser on synthetic
 *                                                  input, no network or write
 *   --probe                                       HEAD each daily URL the
 *                                                  window needs
 *   --columns CSV                                 column-name list override
 *                                                  (default: t,alt,lat,lon,rho)
 *   --out PATH                                    output JSON path
 *   -v / --verbose
 *
 * Network in this sandbox
 * -----------------------
 * The TU Delft host returns 403 to the sandbox egress proxy. When the
 * fetch fails we print the exact `curl` loop the operator can run from
 * a workstation, plus the `--local-dir` invocation to re-feed the
 * downloaded files. See `MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md`.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve, basename, join } from "node:path";
import process from "node:process";

const GRACE_BASE = "http://thermosphere.tudelft.nl/acceldata/GraceFO/v02/density";

const DEFAULT_OUT     = "data/hindcast/inputs/grace_fo_density.json";
const DEFAULT_COLUMNS = ["t", "alt", "lat", "lon", "rho"];
const FETCH_TIMEOUT_MS = 60_000;

// ── small utilities (shared shape with fetch-omni.mjs) ─────────────

function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--smoke-test")  { out.smokeTest = true; continue; }
        if (a === "--probe")       { out.probe = true; continue; }
        if (a === "-v" || a === "--verbose") { out.verbose = true; continue; }
        if (a === "-h" || a === "--help")    { out.help = true; continue; }
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

function log(args, ...msg) {
    if (args.verbose) console.error("[fetch-grace]", ...msg);
}

function isoTimestamp() {
    return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function parseWindow(args) {
    if (!args.start || !args.end) {
        throw new Error("--start and --end are required (YYYY-MM-DD, UTC)");
    }
    const fix = s => (s.length === 10 ? s + "T00:00:00Z" : s);
    const start = new Date(fix(args.start));
    const end   = new Date(fix(args.end));
    if (isNaN(start) || isNaN(end) || end <= start) {
        throw new Error(`Bad window: ${args.start} → ${args.end}`);
    }
    return { start, end };
}

// One URL per UTC day the window touches (inclusive of any day that
// overlaps even a single second).
function daysInWindow({ start, end }) {
    const days = [];
    const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    while (cur < end) {
        days.push({
            y: cur.getUTCFullYear(),
            m: cur.getUTCMonth() + 1,
            d: cur.getUTCDate(),
        });
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return days;
}

function urlForDay({ y, m, d }) {
    const Y = String(y).padStart(4, "0");
    const M = String(m).padStart(2, "0");
    const D = String(d).padStart(2, "0");
    return `${GRACE_BASE}/${Y}/grcfo_density_${Y}_${M}_${D}.txt`;
}

// ── parser ─────────────────────────────────────────────────────────

function _parseColumns(csv) {
    const cols = (csv || "").split(",").map(s => s.trim()).filter(Boolean);
    return cols.length ? cols : DEFAULT_COLUMNS.slice();
}

// One ASCII line → record object keyed by column names, or null if the
// line is a header / malformed / missing a required field.
// Required columns: t, alt, lat, lon, rho (any order, configurable).
export function parseGraceLine(line, columns = DEFAULT_COLUMNS) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("%")) return null;
    const parts = trimmed.split(/\s+/);
    if (parts.length < columns.length) return null;

    const obj = {};
    for (let i = 0; i < columns.length; i++) {
        obj[columns[i]] = parts[i];
    }

    // Parse the timestamp (TU Delft v02 uses ISO-like w/o trailing Z).
    let t;
    try {
        const ts = obj.t.endsWith("Z") ? obj.t : obj.t + "Z";
        t = new Date(ts);
        if (isNaN(t)) return null;
    } catch { return null; }

    const alt = Number(obj.alt);
    const lat = Number(obj.lat);
    const lon = Number(obj.lon);
    const rho = Number(obj.rho);
    if (![alt, lat, lon, rho].every(Number.isFinite)) return null;
    if (rho <= 0) return null;        // density is strictly positive
    if (alt < 200 || alt > 700) return null;  // GRACE-FO orbit ~490 km
    return { t, alt_km: alt, lat_deg: lat, lon_deg: lon, rho_kg_m3: rho };
}

export function parseGraceText(text, { columns = DEFAULT_COLUMNS, start, end } = {}) {
    const records = [];
    for (const line of text.split(/\r?\n/)) {
        const r = parseGraceLine(line, columns);
        if (!r) continue;
        if (start && r.t < start) continue;
        if (end   && r.t >= end)  continue;
        records.push(r);
    }
    return records;
}

// ── network ────────────────────────────────────────────────────────

async function fetchText(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const resp = await fetch(url, { signal: ac.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
        return await resp.text();
    } finally {
        clearTimeout(timer);
    }
}

async function probe(urls) {
    let failures = 0;
    for (const url of urls) {
        const t0 = Date.now();
        let status;
        try {
            const resp = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(12_000) });
            status = String(resp.status);
            if (resp.status >= 400 && resp.status !== 405) failures++;
        } catch (e) {
            status = `ERR(${e.name})`;
            failures++;
        }
        const dur = ((Date.now() - t0) / 1000).toFixed(2);
        console.log(`  ${status.padStart(16)}  ${dur}s  ${url}`);
    }
    return failures;
}

// ── output ─────────────────────────────────────────────────────────

function toJsonRecord(r) {
    return {
        t:      r.t.toISOString().replace(/\.\d+Z$/, "Z"),
        alt_km: round(r.alt_km, 3),
        lat_deg: round(r.lat_deg, 4),
        lon_deg: round(r.lon_deg, 4),
        // Density is tiny; keep 4 sig figs via exponential.
        rho_kg_m3: Number(r.rho_kg_m3.toExponential(4)),
    };
}

function round(x, n) {
    const f = 10 ** n;
    return Math.round(x * f) / f;
}

async function writeOutput(outPath, window, records) {
    const payload = {
        window: {
            start: window.start.toISOString().replace(/\.\d+Z$/, "Z"),
            end:   window.end.toISOString().replace(/\.\d+Z$/, "Z"),
        },
        source: "TU Delft GRACE-FO v02 (Doornbos accelerometer-derived neutral density)",
        fetched_at: isoTimestamp(),
        n: records.length,
        records: records.map(toJsonRecord),
    };
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(payload, null, 0) + "\n");
}

// ── smoke test ─────────────────────────────────────────────────────

// Three synthetic records on 2024-05-11. Last row has rho<=0 to verify
// the positivity filter rejects it.
const SMOKE_TEXT = [
    "# header line with a hash",
    "2024-05-11T00:00:00   492.34   12.45   -56.10   3.450e-12",
    "2024-05-11T00:01:30   492.12   13.91   -56.05   3.910e-12",
    "2024-05-11T00:03:00   491.98   15.40   -55.97  -1.000e-12",
].join("\n");

function runSmokeTest() {
    const records = parseGraceText(SMOKE_TEXT);
    console.log(`smoke: parsed ${records.length} records (expected 2)`);
    if (records.length !== 2) {
        console.error("FAIL: header / positivity filters didn't drop expected rows");
        return 1;
    }
    const [r0, r1] = records;
    console.log(`  r0  t=${r0.t.toISOString()}  alt=${r0.alt_km}  rho=${r0.rho_kg_m3}`);
    console.log(`  r1  t=${r1.t.toISOString()}  alt=${r1.alt_km}  rho=${r1.rho_kg_m3}`);
    if (r0.rho_kg_m3 !== 3.45e-12 || r1.rho_kg_m3 !== 3.91e-12) {
        console.error(`FAIL: rho parse incorrect (got ${r0.rho_kg_m3}, ${r1.rho_kg_m3})`);
        return 1;
    }
    if (r0.t.toISOString() !== "2024-05-11T00:00:00.000Z") {
        console.error(`FAIL: timestamp parse incorrect (got ${r0.t.toISOString()})`);
        return 1;
    }
    console.log("smoke: OK");
    return 0;
}

// ── main ───────────────────────────────────────────────────────────

function workstationDropInBanner(urls, outPath) {
    const dayLines = urls.map(u => {
        const fn = u.split("/").pop();
        return `  curl -fSL --create-dirs -o raw/grace_fo/${fn} \\\n    '${u}'`;
    });
    const lines = [
        "",
        "─ network unreachable — workstation drop-in path ──────────────",
        "From a workstation with internet access, run:",
        "",
        ...dayLines,
        "",
        "Then re-run this script with --local-dir:",
        "",
        `  node scripts/fetch-grace.mjs --start <start> --end <end> \\`,
        `    --local-dir raw/grace_fo \\`,
        `    --out ${outPath}`,
        "",
        "───────────────────────────────────────────────────────────────",
    ];
    console.error(lines.join("\n"));
}

async function loadFromLocalDir(dirPath, window, columns, args) {
    const entries = await readdir(dirPath);
    const matches = entries.filter(n => /^grcfo_density_\d{4}_\d{2}_\d{2}\.txt$/.test(n));
    const days = daysInWindow(window);
    const wantedNames = new Set(days.map(d => basename(urlForDay(d))));
    const usable = matches.filter(n => wantedNames.has(n));
    log(args, `local-dir: ${matches.length} candidates, ${usable.length} in window`);

    const out = [];
    for (const name of usable.sort()) {
        const full = join(dirPath, name);
        log(args, "reading", full);
        const text = await readFile(full, "utf8");
        out.push(...parseGraceText(text, { columns, ...window }));
    }
    return out;
}

async function main() {
    let args;
    try { args = parseArgs(process.argv); }
    catch (e) { console.error("ERROR:", e.message); return 2; }

    if (args.help) {
        console.log(`Usage: node fetch-grace.mjs --start YYYY-MM-DD --end YYYY-MM-DD [options]

Options:
  --from-file PATH     parse one local daily file (may comma-separate multiple)
  --local-dir DIR      ingest all matching files in DIR whose date is in window
  --smoke-test         exercise parser on embedded synthetic input
  --probe              HEAD each daily URL the window needs
  --columns CSV        column-name list override (default: t,alt,lat,lon,rho)
  --out PATH           output JSON (default: ${DEFAULT_OUT})
  -v, --verbose        debug logging
`);
        return 0;
    }

    if (args.smokeTest) return runSmokeTest();

    let window;
    try { window = parseWindow(args); }
    catch (e) { console.error("ERROR:", e.message); return 2; }

    const columns = _parseColumns(args.columns);
    const days = daysInWindow(window);
    const urls = days.map(urlForDay);
    log(args, "URLs:", urls);
    log(args, "columns:", columns);

    if (args.probe) {
        const fails = await probe(urls);
        console.log(fails > 0 ? `probe: ${fails} URL(s) unreachable` : "probe: all URLs reachable");
        return fails > 0 ? 1 : 0;
    }

    const outPath = resolve(args.out || DEFAULT_OUT);

    let allRecords = [];

    if (args.localDir) {
        try {
            allRecords = await loadFromLocalDir(args.localDir, window, columns, args);
        } catch (e) {
            console.error(`ERROR: local-dir read failed (${e.message})`);
            return 5;
        }
    } else if (args.fromFile) {
        for (const path of args.fromFile.split(",").map(s => s.trim())) {
            log(args, "reading", path);
            const text = await readFile(path, "utf8");
            allRecords.push(...parseGraceText(text, { columns, ...window }));
        }
    } else {
        for (const url of urls) {
            log(args, "GET", url);
            try {
                const text = await fetchText(url);
                allRecords.push(...parseGraceText(text, { columns, ...window }));
            } catch (e) {
                console.error(`ERROR: fetch failed for ${url} (${e.message})`);
                workstationDropInBanner(urls, outPath);
                return 3;
            }
        }
    }

    allRecords.sort((a, b) => a.t - b.t);

    if (allRecords.length === 0) {
        console.error("ERROR: no records inside the window after parsing.");
        return 4;
    }

    await writeOutput(outPath, window, allRecords);
    console.log(`wrote ${allRecords.length} records → ${outPath}`);
    return 0;
}

// Only run main when invoked as a CLI (not when imported for unit tests).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    main().then(code => process.exit(code)).catch(e => {
        console.error("FATAL:", e);
        process.exit(99);
    });
}
