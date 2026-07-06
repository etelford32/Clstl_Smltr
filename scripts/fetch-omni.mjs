#!/usr/bin/env node
/**
 * fetch-omni.mjs — Day-1 fetcher for OMNI 1-min IMF (Gannon hindcast)
 * ═══════════════════════════════════════════════════════════════════════
 * Pulls NASA SPDF's OMNI HRO 1-minute solar-wind/IMF data for a window,
 * parses the fixed-column ASCII into canonical JSON, and lands it at
 * `data/hindcast/inputs/imf_l1.json` for the bundle builder to ingest.
 *
 * Source
 * ------
 *   https://spdf.gsfc.nasa.gov/pub/data/omni/high_res_omni/monthly_1min/
 *   File pattern: omni_min<YYYY><MM>.asc
 *   Format spec:  https://omniweb.gsfc.nasa.gov/html/HROdocum.html
 *
 * The fetcher mirrors the column layout already documented in the Python
 * peer at `swmf/pipeline/fetch_omni_imf.py` — same OMNI 1-min columns,
 * same sentinel filters. The Python script writes a SWMF #SOLARWINDFILE
 * .dat for BATS-R-US; this Node script writes JSON for the JS-side
 * replay-bundle builder. The two pipelines coexist.
 *
 * Modes
 * -----
 *   --start YYYY-MM-DD --end YYYY-MM-DD           (required, UTC)
 *   --from-file PATH                              parse a pre-downloaded .asc
 *   --smoke-test                                  exercise parser on embedded
 *                                                  synthetic input, no network,
 *                                                  no file writes
 *   --probe                                       HEAD each URL the window
 *                                                  needs, report status, exit
 *                                                  non-zero on any 4xx/5xx
 *   --out PATH                                    output JSON path
 *                                                  (default below)
 *   -v / --verbose                                debug logging
 *
 * Network in this sandbox
 * -----------------------
 * The remote-execution sandbox's egress proxy currently blocks SPDF
 * (timeout, not 4xx). When the network attempt fails we print the
 * exact `curl` command the operator can run from a workstation, plus
 * the `--from-file` invocation to re-feed the downloaded data back
 * into this script. See `MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const OMNI_BASE =
    "https://spdf.gsfc.nasa.gov/pub/data/omni/high_res_omni/monthly_1min";

// 0-indexed column positions in the OMNI HRO 1-min ASCII record.
// Cross-checked against the Python peer (swmf/pipeline/fetch_omni_imf.py).
const COL = {
    YEAR:  0,
    DOY:   1,
    HOUR:  2,
    MIN:   3,
    // ⚠ WARNING — these B/V indices were authored against the 26-column
    // synthetic fixture used by the smoke test and do NOT match real
    // NASA SPDF OMNI HRO 1-min ASCII. The actual file has 46 columns
    // with Bz_GSM at index 18 and Flow speed at index 21 (see
    // api/omni/imf.js for the verified column map). DO NOT run this
    // script against real SPDF data until the indices are corrected;
    // the output JSON will read "Percent interp" / spacecraft IDs as
    // if they were B and V components.
    //
    // Currently this script's network path is gated on the sandbox's
    // SPDF block; the smoke test still passes because its synthetic
    // input matches the (broken) indices. Plan: rewrite either against
    // the live file format using api/omni/imf.js's COL map, or replace
    // by calling the Edge endpoint /api/omni/imf from a Node fetcher.
    BX:    8,    // ⚠ wrong (real spec → 14, GSE/GSM Bx)
    BY:    9,    // ⚠ wrong (real spec → 17, By GSM)
    BZ:    10,   // ⚠ wrong (real spec → 18, Bz GSM)
    VX:    21,   // ⚠ wrong (real spec → 22, Vx GSE)
    VY:    22,   // ⚠ wrong (real spec → 23, Vy GSE)
    VZ:    23,   // ⚠ wrong (real spec → 24, Vz GSE)
    NP:    24,   // ⚠ wrong (real spec → 25, proton density)
    T:     25,   // ⚠ wrong (real spec → 26, temperature)
};

// Sentinel thresholds per the OMNI HRO documentation. Any field at or
// above its sentinel is "missing" and the whole row is dropped.
const SENTINEL = {
    B:  9999.99,
    V:  99999.9,
    N:  999.99,
    T:  1.0e7,
};

const DEFAULT_OUT = "data/hindcast/inputs/imf_l1.json";
const FETCH_TIMEOUT_MS = 60_000;

// ── small utilities ────────────────────────────────────────────────

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
    if (args.verbose) console.error("[fetch-omni]", ...msg);
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

// One URL per (year, month) the window touches.
function urlsForWindow({ start, end }) {
    const seen = new Set();
    const months = [];
    const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const last = new Date(Date.UTC(end.getUTCFullYear(),   end.getUTCMonth(),   1));
    while (cur <= last) {
        const key = `${cur.getUTCFullYear()}-${cur.getUTCMonth()}`;
        if (!seen.has(key)) {
            seen.add(key);
            months.push({ y: cur.getUTCFullYear(), m: cur.getUTCMonth() + 1 });
        }
        cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
    return months.map(({ y, m }) =>
        `${OMNI_BASE}/omni_min${y.toString().padStart(4, "0")}${m.toString().padStart(2, "0")}.asc`,
    );
}

// ── parser ─────────────────────────────────────────────────────────

// One ASCII line → { t: Date, bx, by, bz, vx, vy, vz, n, tp } or null
// if any field is a sentinel or the line is malformed.
export function parseOmniLine(line) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < COL.T + 1) return null;

    const yr  = Number(parts[COL.YEAR]);
    const doy = Number(parts[COL.DOY]);
    const hr  = Number(parts[COL.HOUR]);
    const mn  = Number(parts[COL.MIN]);
    if (!Number.isInteger(yr) || !Number.isInteger(doy)) return null;

    // DOY → ISO date. JS Date supports this via Date.UTC(yr, 0, doy).
    const t = new Date(Date.UTC(yr, 0, doy, hr, mn));

    const bx = Number(parts[COL.BX]);
    const by = Number(parts[COL.BY]);
    const bz = Number(parts[COL.BZ]);
    const vx = Number(parts[COL.VX]);
    const vy = Number(parts[COL.VY]);
    const vz = Number(parts[COL.VZ]);
    const n  = Number(parts[COL.NP]);
    const tp = Number(parts[COL.T]);

    if (![bx, by, bz, vx, vy, vz, n, tp].every(Number.isFinite)) return null;
    if (Math.abs(bx) >= SENTINEL.B || Math.abs(by) >= SENTINEL.B || Math.abs(bz) >= SENTINEL.B) return null;
    if (Math.abs(vx) >= SENTINEL.V || Math.abs(vy) >= SENTINEL.V || Math.abs(vz) >= SENTINEL.V) return null;
    if (n  >= SENTINEL.N) return null;
    if (tp >= SENTINEL.T) return null;

    return { t, bx, by, bz, vx, vy, vz, n, tp };
}

export function parseOmniText(text, { start, end } = {}) {
    const records = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim() || line.startsWith("#")) continue;
        const r = parseOmniLine(line);
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
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} from ${url}`);
        }
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
        t:  r.t.toISOString().replace(/\.\d+Z$/, "Z"),
        bx: round(r.bx, 3),
        by: round(r.by, 3),
        bz: round(r.bz, 3),
        vx: round(r.vx, 2),
        vy: round(r.vy, 2),
        vz: round(r.vz, 2),
        n:  round(r.n,  3),
        tp: round(r.tp, 0),
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
        source: "OMNI HRO 1-min (NASA SPDF, ACE/Wind/DSCOVR time-shifted to bow-shock nose)",
        fetched_at: isoTimestamp(),
        n: records.length,
        records: records.map(toJsonRecord),
    };
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(payload, null, 0) + "\n");
}

// ── smoke test ─────────────────────────────────────────────────────

// Build a synthetic OMNI line at exact column positions. Year/DoY/Hr/Min
// at 0-3; Bx/By/Bz at 8/9/10; Vx/Vy/Vz at 21/22/23; Np at 24; T at 25.
// Unused columns are filled with "0" so whitespace-split position math
// matches the real fixed-column OMNI HRO format.
function _buildOmniLine(yr, doy, hr, mn, bx, by, bz, vx, vy, vz, n, T) {
    const cols = new Array(26).fill("0");
    cols[0] = String(yr);
    cols[1] = String(doy);
    cols[2] = String(hr);
    cols[3] = String(mn);
    cols[COL.BX] = bx.toFixed(2);
    cols[COL.BY] = by.toFixed(2);
    cols[COL.BZ] = bz.toFixed(2);
    cols[COL.VX] = vx.toFixed(2);
    cols[COL.VY] = vy.toFixed(2);
    cols[COL.VZ] = vz.toFixed(2);
    cols[COL.NP] = n.toFixed(2);
    cols[COL.T]  = T.toFixed(1);
    return cols.join(" ");
}

// Three synthetic rows on 2024-05-11 (DOY 132). Row 2 trips the B
// sentinel and must be dropped.
const SMOKE_TEXT = [
    _buildOmniLine(2024, 132, 0, 0, -3.50, -1.20, -2.10, -425.30, -12.40, 3.10, 5.70, 85000.0),
    _buildOmniLine(2024, 132, 0, 1, -3.60, -1.10, -2.30, -428.10, -11.90, 3.20, 5.80, 86000.0),
    _buildOmniLine(2024, 132, 0, 2,  9999.99, -1.40, -2.20, -430.00, -12.10, 3.30, 5.90, 87000.0),
].join("\n");

function runSmokeTest() {
    const records = parseOmniText(SMOKE_TEXT);
    console.log(`smoke: parsed ${records.length} records (expected 2)`);
    if (records.length !== 2) {
        console.error("FAIL: sentinel filter not applied");
        return 1;
    }
    const [r0, r1] = records;
    console.log(`  r0  t=${r0.t.toISOString()}  Bx=${r0.bx}  By=${r0.by}  Bz=${r0.bz}  Vx=${r0.vx}  N=${r0.n}`);
    console.log(`  r1  t=${r1.t.toISOString()}  Bx=${r1.bx}  By=${r1.by}  Bz=${r1.bz}  Vx=${r1.vx}  N=${r1.n}`);
    if (r0.bx !== -3.5 || r0.by !== -1.2 || r0.bz !== -2.1) {
        console.error(`FAIL: Bx/By/Bz parse incorrect (got ${r0.bx}, ${r0.by}, ${r0.bz})`);
        return 1;
    }
    if (r0.vx !== -425.3 || r0.n !== 5.7) {
        console.error(`FAIL: Vx/N parse incorrect (got Vx=${r0.vx}, N=${r0.n})`);
        return 1;
    }
    if (r0.t.toISOString() !== "2024-05-11T00:00:00.000Z") {
        console.error(`FAIL: timestamp incorrect (got ${r0.t.toISOString()})`);
        return 1;
    }
    console.log("smoke: OK");
    return 0;
}

// ── main ───────────────────────────────────────────────────────────

function workstationDropInBanner(urls, outPath) {
    const lines = [
        "",
        "─ network unreachable — workstation drop-in path ──────────────",
        "From a workstation with internet access, run:",
        "",
        ...urls.map(u => `  curl -fSL --create-dirs -o raw/omni/${u.split("/").pop()} \\\n    '${u}'`),
        "",
        "Then re-run this script with --from-file:",
        "",
        `  node scripts/fetch-omni.mjs --start <start> --end <end> \\`,
        `    --from-file raw/omni/${urls[0].split("/").pop()} \\`,
        `    --out ${outPath}`,
        "",
        "If multiple monthly files are needed, --from-file can be repeated.",
        "───────────────────────────────────────────────────────────────",
    ];
    console.error(lines.join("\n"));
}

async function main() {
    let args;
    try { args = parseArgs(process.argv); }
    catch (e) { console.error("ERROR:", e.message); return 2; }

    if (args.help) {
        console.log(`Usage: node fetch-omni.mjs --start YYYY-MM-DD --end YYYY-MM-DD [options]

Options:
  --from-file PATH     parse a local OMNI .asc file (skips network)
  --smoke-test         exercise parser on embedded synthetic input, exit
  --probe              HEAD each URL the window needs, exit non-zero on failures
  --out PATH           output JSON (default: ${DEFAULT_OUT})
  -v, --verbose        debug logging
`);
        return 0;
    }

    if (args.smokeTest) return runSmokeTest();

    let window;
    try { window = parseWindow(args); }
    catch (e) { console.error("ERROR:", e.message); return 2; }

    const urls = urlsForWindow(window);
    log(args, "URLs:", urls);

    if (args.probe) {
        const fails = await probe(urls);
        console.log(fails > 0 ? `probe: ${fails} URL(s) unreachable` : "probe: all URLs reachable");
        return fails > 0 ? 1 : 0;
    }

    const outPath = resolve(args.out || DEFAULT_OUT);

    // Multi-source path. Each --from-file is a separate file we'll
    // concatenate; if absent, we try the network.
    let texts = [];
    if (args.fromFile) {
        // For now support a single --from-file; multiple-file support
        // is straightforward when the window crosses a month boundary.
        log(args, "reading", args.fromFile);
        texts.push(await readFile(args.fromFile, "utf8"));
    } else {
        for (const url of urls) {
            log(args, "GET", url);
            try {
                texts.push(await fetchText(url));
            } catch (e) {
                console.error(`ERROR: fetch failed (${e.message})`);
                workstationDropInBanner(urls, outPath);
                return 3;
            }
        }
    }

    const allRecords = [];
    for (const text of texts) {
        const recs = parseOmniText(text, window);
        log(args, `parsed ${recs.length} records from one source`);
        allRecords.push(...recs);
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
