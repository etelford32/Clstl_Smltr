#!/usr/bin/env node
/**
 * build-snapshots.mjs — Compile heliochronicles submodule data into compact
 * static artifacts the ParkersPhysics browser stack can consume without a
 * runtime database.
 *
 * Inputs (submodule, data/heliochronicles/data/):
 *   hourly/*.csv   NASA OMNI hourly (1963+)
 *   daily/*.csv    SILSO SSN + GFZ Kp/ap + F10.7 + ISGI aa (1818+)
 *   monthly/*.csv  SILSO monthly mean (1749+)
 *   yearly/*.csv   SILSO yearly + GSN (1610+)
 *   cycles/*.json  solar cycles 1-25, grand minima
 *   events/*.json  historical storms, aurora observations
 *   regions/*.json notable active regions
 *
 * Outputs (data/history/):
 *   tier1-recent.json      last 30 d hourly, packed to SolarWeatherHistory shape
 *   tier2-4yr.json         last 4 yr daily means, packed to the same shape
 *   archive-daily.bin      full daily record as Float64 t + Float32 features
 *   archive-hourly/*.bin   per-decade hourly OMNI, Float64 t + Float32 features
 *   index.json             catalog of all artifacts (paths, counts, ranges, hashes)
 *
 * Catalog JSON (cycles, grand minima, events, aurora, regions) is NOT copied —
 * the browser fetches it directly from data/heliochronicles/data/ (in-tree via
 * the submodule). index.json records those paths so history-loader.js has one
 * entry point.
 *
 * When upstream CSVs are empty (heliochronicles ships them empty until
 * `npm run build` runs with network access to SILSO/GFZ/SPDF), this script
 * still emits index.json with `populated: "catalog_only"` and exits 0 so
 * Vercel builds stay green.
 *
 * Usage:
 *   node scripts/heliochronicles/build-snapshots.mjs
 *   node scripts/heliochronicles/build-snapshots.mjs --skip-archive
 *   node scripts/heliochronicles/build-snapshots.mjs --input <dir> --out <dir>
 */

import { readFile, writeFile, readdir, mkdir, stat, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { streamCsv, numOrNull } from './lib/csv-stream.mjs';
import { apToKp } from './lib/ap-to-kp.mjs';

// ── Paths ────────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const DEFAULTS = {
    input: resolve(repoRoot, 'data', 'heliochronicles', 'data'),
    out:   resolve(repoRoot, 'data', 'history'),
};

function parseArgs(argv) {
    const opts = { ...DEFAULTS, skipArchive: false, quiet: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--input')        opts.input = resolve(argv[++i]);
        else if (a === '--out')     opts.out   = resolve(argv[++i]);
        else if (a === '--skip-archive') opts.skipArchive = true;
        else if (a === '--quiet')   opts.quiet = true;
        else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
        else throw new Error(`unknown argument: ${a}`);
    }
    return opts;
}

function printHelp() {
    process.stdout.write(`build-snapshots.mjs — compile heliochronicles → static artifacts

  --input <dir>       source directory (default: data/heliochronicles/data)
  --out   <dir>       output directory (default: data/history)
  --skip-archive      skip decade-scale hourly/daily binaries
  --quiet             suppress progress logs
  --help, -h          this text
`);
}

// ── Constants ────────────────────────────────────────────────────────────────

const TIER1_DAYS  = 30;     // last 30 days at hourly cadence
const TIER2_YEARS = 4;      // last 4 years at daily cadence
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY  = 86_400_000;

const HOURLY_ARCHIVE_FIELDS = ['v_sw', 'n_p', 'bz_gsm', 'b_total', 'pressure', 'dst', 'ap', 'ae'];
const DAILY_ARCHIVE_FIELDS  = ['ssn', 'kp_daily', 'ap', 'f107_obs', 'aa'];

// ── Logging ──────────────────────────────────────────────────────────────────

let quiet = false;
const log  = (...a) => { if (!quiet) console.log('[build-snapshots]', ...a); };
const warn = (...a) => console.warn('[build-snapshots] WARN', ...a);

// ── Utilities ────────────────────────────────────────────────────────────────

async function exists(p) {
    try { await stat(p); return true; } catch { return false; }
}

async function listCsv(dir) {
    if (!await exists(dir)) return [];
    return (await readdir(dir)).filter(f => f.endsWith('.csv')).sort().map(f => join(dir, f));
}

function tsHourly(row) {
    const [y, m, d] = row.date.split('-').map(Number);
    return Date.UTC(y, m - 1, d, Number(row.hour));
}

function tsDailyNoon(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return Date.UTC(y, m - 1, d, 12);
}

function decadeLabel(year) {
    const start = Math.floor(year / 10) * 10;
    return `${start}s`;
}

/** Akasofu epsilon (GW-scale proxy) using b_total and bz only when by is unavailable. */
function epsilonProxy(v_sw, b_total, bz_gsm) {
    if (v_sw == null || b_total == null || bz_gsm == null) return 0;
    const by2 = Math.max(0, b_total * b_total - bz_gsm * bz_gsm);
    const theta = Math.atan2(Math.sqrt(by2), bz_gsm);
    const sinHalf4 = Math.pow(Math.sin(theta / 2), 4);
    return 1e-3 * v_sw * b_total * b_total * sinHalf4;
}

function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

// ── Hourly → tier1 packed record ─────────────────────────────────────────────

function packTier1(row) {
    const v_sw = numOrNull(row.v_sw);
    const n_p  = numOrNull(row.n_p);
    const bz   = numOrNull(row.bz_gsm);
    const bt   = numOrNull(row.b_total);
    const pressure = numOrNull(row.pressure);
    const dst  = numOrNull(row.dst);
    const ap   = numOrNull(row.ap);
    const ae   = numOrNull(row.ae);

    const kp = ap == null ? null : apToKp(ap);
    const pdyn = pressure != null ? pressure
        : (v_sw != null && n_p != null
            ? +(0.5 * 1.673e-27 * (n_p * 1e6) * (v_sw * 1e3) * (v_sw * 1e3) * 1e9).toFixed(3)
            : null);
    const epsilon  = epsilonProxy(v_sw, bt, bz);
    const substorm = ae != null ? Math.min(1, ae / 1000) : 0;

    return {
        t: tsHourly(row),
        v: v_sw,
        bz,
        by: 0,
        n: n_p,
        pdyn,
        kp,
        dst,
        epsilon: +epsilon.toFixed(1),
        substorm: +substorm.toFixed(3),
    };
}

// ── Hourly → daily aggregate for tier2 ───────────────────────────────────────

function emptyDayAgg(dateStr) {
    return {
        dateStr,
        count: 0,
        v_sum: 0, v_n: 0,
        bz_sum: 0, bz_n: 0,
        n_sum: 0, n_n: 0,
        pdyn_sum: 0, pdyn_n: 0,
        dst_min: null,
        ap_sum: 0, ap_n: 0,
        ae_sum: 0, ae_n: 0,
        bt_sum: 0, bt_n: 0,
    };
}

function accumulateDay(agg, row) {
    agg.count++;
    const v = numOrNull(row.v_sw);       if (v != null)  { agg.v_sum += v;   agg.v_n++; }
    const bz = numOrNull(row.bz_gsm);    if (bz != null) { agg.bz_sum += bz; agg.bz_n++; }
    const n = numOrNull(row.n_p);        if (n != null)  { agg.n_sum += n;   agg.n_n++; }
    const p = numOrNull(row.pressure);   if (p != null)  { agg.pdyn_sum += p; agg.pdyn_n++; }
    const dst = numOrNull(row.dst);      if (dst != null) agg.dst_min = agg.dst_min == null ? dst : Math.min(agg.dst_min, dst);
    const ap = numOrNull(row.ap);        if (ap != null) { agg.ap_sum += ap; agg.ap_n++; }
    const ae = numOrNull(row.ae);        if (ae != null) { agg.ae_sum += ae; agg.ae_n++; }
    const bt = numOrNull(row.b_total);   if (bt != null) { agg.bt_sum += bt; agg.bt_n++; }
}

function packDayAgg(agg) {
    const mean = (s, n) => n > 0 ? s / n : null;
    const v = mean(agg.v_sum, agg.v_n);
    const bz = mean(agg.bz_sum, agg.bz_n);
    const n = mean(agg.n_sum, agg.n_n);
    const pdyn = mean(agg.pdyn_sum, agg.pdyn_n);
    const ap = mean(agg.ap_sum, agg.ap_n);
    const ae = mean(agg.ae_sum, agg.ae_n);
    const bt = mean(agg.bt_sum, agg.bt_n);
    const kp = ap == null ? null : apToKp(ap);
    const epsilon  = v != null && bt != null && bz != null ? epsilonProxy(v, bt, bz) : 0;
    const substorm = ae != null ? Math.min(1, ae / 1000) : 0;

    return {
        t: tsDailyNoon(agg.dateStr),
        v,
        bz,
        by: 0,
        n,
        pdyn: pdyn == null ? null : +pdyn.toFixed(3),
        kp,
        dst: agg.dst_min,
        epsilon: +epsilon.toFixed(1),
        substorm: +substorm.toFixed(3),
    };
}

// ── Tier builders ────────────────────────────────────────────────────────────

async function buildTiersFromHourly(hourlyFiles, nowMs) {
    const tier1Cutoff = nowMs - TIER1_DAYS * MS_PER_DAY;
    const tier2Cutoff = nowMs - TIER2_YEARS * 365.25 * MS_PER_DAY;

    const tier1 = [];
    const dayAggs = new Map();    // dateStr → agg
    let hourlyRows = 0;
    let latestTs = 0;

    for (const file of hourlyFiles) {
        for await (const row of streamCsv(file)) {
            hourlyRows++;
            const t = tsHourly(row);
            if (t > latestTs) latestTs = t;

            if (t >= tier1Cutoff) tier1.push(packTier1(row));

            if (t >= tier2Cutoff) {
                let agg = dayAggs.get(row.date);
                if (!agg) { agg = emptyDayAgg(row.date); dayAggs.set(row.date, agg); }
                accumulateDay(agg, row);
            }
        }
    }

    const tier2 = [...dayAggs.values()]
        .sort((a, b) => a.dateStr < b.dateStr ? -1 : 1)
        .map(packDayAgg);

    return { tier1, tier2, hourlyRows, latestTs };
}

// ── Daily archive (entire range, Float64 t + Float32 features) ──────────────

async function buildDailyArchive(dailyFiles, outPath) {
    // Pass 1: count rows so we can allocate.
    let n = 0;
    for (const f of dailyFiles) for await (const _ of streamCsv(f)) n++;
    if (n === 0) return null;

    const fieldCount = DAILY_ARCHIVE_FIELDS.length;
    const stride = 8 + fieldCount * 4;
    const buf = Buffer.alloc(n * stride);

    let i = 0;
    for (const f of dailyFiles) {
        for await (const row of streamCsv(f)) {
            const t = tsDailyNoon(row.date);
            const ssn = numOrNull(row.ssn);
            const kp_sum = numOrNull(row.kp_sum);
            const kp_daily = kp_sum == null ? NaN : kp_sum / 8;  // 8 three-hour Kp per day
            const ap = numOrNull(row.ap);
            const f107 = numOrNull(row.f107_obs);
            const aa  = numOrNull(row.aa);

            const off = i * stride;
            buf.writeDoubleLE(t, off);
            buf.writeFloatLE(ssn ?? NaN, off + 8);
            buf.writeFloatLE(kp_daily,     off + 12);
            buf.writeFloatLE(ap  ?? NaN,   off + 16);
            buf.writeFloatLE(f107 ?? NaN,  off + 20);
            buf.writeFloatLE(aa  ?? NaN,   off + 24);
            i++;
        }
    }
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, buf);
    return {
        rows: n,
        stride,
        fields: ['t_ms', ...DAILY_ARCHIVE_FIELDS],
        t_layout: 'Float64LE',
        value_layout: 'Float32LE',
        bytes: buf.length,
        sha256: sha256Hex(buf),
    };
}

// ── Hourly archive by decade ─────────────────────────────────────────────────

async function buildHourlyArchiveByDecade(hourlyFiles, outDir) {
    const fieldCount = HOURLY_ARCHIVE_FIELDS.length;
    const stride = 8 + fieldCount * 4;

    // Route each row into a decade bucket written as a streaming binary.
    const writers = new Map();   // decadeLabel → { stream, count }
    await mkdir(outDir, { recursive: true });

    for (const f of hourlyFiles) {
        for await (const row of streamCsv(f)) {
            const [yStr] = row.date.split('-');
            const label = decadeLabel(Number(yStr));
            let w = writers.get(label);
            if (!w) {
                const path = join(outDir, `hourly_${label}.bin`);
                const stream = createWriteStream(path);
                w = { label, path, stream, count: 0, earliest: Infinity, latest: 0 };
                writers.set(label, w);
            }
            const t = tsHourly(row);
            const rec = Buffer.alloc(stride);
            rec.writeDoubleLE(t, 0);
            rec.writeFloatLE(numOrNull(row.v_sw)     ?? NaN, 8);
            rec.writeFloatLE(numOrNull(row.n_p)      ?? NaN, 12);
            rec.writeFloatLE(numOrNull(row.bz_gsm)   ?? NaN, 16);
            rec.writeFloatLE(numOrNull(row.b_total)  ?? NaN, 20);
            rec.writeFloatLE(numOrNull(row.pressure) ?? NaN, 24);
            rec.writeFloatLE(numOrNull(row.dst)      ?? NaN, 28);
            rec.writeFloatLE(numOrNull(row.ap)       ?? NaN, 32);
            rec.writeFloatLE(numOrNull(row.ae)       ?? NaN, 36);
            w.stream.write(rec);
            w.count++;
            if (t < w.earliest) w.earliest = t;
            if (t > w.latest)   w.latest   = t;
        }
    }

    const artifacts = [];
    for (const w of writers.values()) {
        await new Promise((resolve, reject) => {
            w.stream.end(err => err ? reject(err) : resolve());
        });
        const buf = await readFile(w.path);
        artifacts.push({
            path: relative(outDir, w.path).split('\\').join('/'),
            decade: Number(w.label.replace('s', '')),
            rows: w.count,
            stride,
            fields: ['t_ms', ...HOURLY_ARCHIVE_FIELDS],
            t_layout: 'Float64LE',
            value_layout: 'Float32LE',
            bytes: buf.length,
            earliest_ms: w.earliest === Infinity ? null : w.earliest,
            latest_ms:   w.latest   === 0        ? null : w.latest,
            sha256: sha256Hex(buf),
        });
    }
    return artifacts.sort((a, b) => a.decade - b.decade);
}

// ── Catalog references (no copy — point at submodule) ───────────────────────

async function catalogRefs(srcRoot, outRoot) {
    const rel = p => relative(outRoot, p).split('\\').join('/');
    const abs = (...parts) => resolve(srcRoot, ...parts);
    const items = [
        { id: 'solar_cycles',        path: abs('cycles',  'solar_cycles.json') },
        { id: 'grand_minima',        path: abs('cycles',  'grand_minima.json') },
        { id: 'historical_storms',   path: abs('events',  'historical_storms.json') },
        { id: 'aurora_observations', path: abs('events',  'aurora_observations.json') },
        { id: 'notable_regions',     path: abs('regions', 'notable_regions.json') },
    ];
    const out = [];
    for (const it of items) {
        if (!await exists(it.path)) { warn(`catalog missing: ${it.path}`); continue; }
        const buf = await readFile(it.path);
        let parsed = null;
        try { parsed = JSON.parse(buf.toString('utf8')); } catch { /* not parseable JSON */ }
        out.push({
            id: it.id,
            path: rel(it.path),
            bytes: buf.length,
            sha256: sha256Hex(buf),
            count: countCatalogEntries(it.id, parsed),
        });
    }
    return out;
}

function countCatalogEntries(id, parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    if (id === 'solar_cycles')        return Array.isArray(parsed.cycles) ? parsed.cycles.length : null;
    if (id === 'grand_minima')        return Array.isArray(parsed.minima) ? parsed.minima.length : null;
    if (id === 'historical_storms')   return Array.isArray(parsed.events) ? parsed.events.length : null;
    if (id === 'aurora_observations') return Array.isArray(parsed.observations) ? parsed.observations.length : null;
    if (id === 'notable_regions')     return Array.isArray(parsed.regions) ? parsed.regions.length : null;
    return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    quiet = opts.quiet;

    log(`input:  ${relative(repoRoot, opts.input) || '.'}`);
    log(`output: ${relative(repoRoot, opts.out) || '.'}`);
    await mkdir(opts.out, { recursive: true });

    const hourlyFiles = await listCsv(join(opts.input, 'hourly'));
    const dailyFiles  = await listCsv(join(opts.input, 'daily'));
    log(`hourly CSVs: ${hourlyFiles.length}`);
    log(`daily  CSVs: ${dailyFiles.length}`);

    const now = Date.now();
    const index = {
        generated_at: new Date(now).toISOString(),
        generator: 'scripts/heliochronicles/build-snapshots.mjs',
        upstream: {
            submodule: 'data/heliochronicles',
            manifest: relative(opts.out, join(opts.input, 'MANIFEST.json')).split('\\').join('/'),
        },
        populated: 'catalog_only',   // overridden below when CSVs present
        artifacts: {},
    };

    // Catalogs are in-tree and always available.
    const catalogs = await catalogRefs(opts.input, opts.out);
    index.artifacts.catalog = catalogs;
    log(`catalog entries: ${catalogs.length}`);

    // Tier 1 / Tier 2 — only if hourly CSVs exist.
    if (hourlyFiles.length > 0) {
        const { tier1, tier2, hourlyRows, latestTs } = await buildTiersFromHourly(hourlyFiles, now);
        const tier1Path = join(opts.out, 'tier1-recent.json');
        const tier2Path = join(opts.out, 'tier2-4yr.json');

        await writeFile(tier1Path, JSON.stringify(tier1));
        await writeFile(tier2Path, JSON.stringify(tier2));

        const tier1Buf = await readFile(tier1Path);
        const tier2Buf = await readFile(tier2Path);

        index.artifacts.tier1_recent = {
            path: 'tier1-recent.json',
            count: tier1.length,
            cadence: '1h',
            window_days: TIER1_DAYS,
            latest_ms: latestTs || null,
            bytes: tier1Buf.length,
            sha256: sha256Hex(tier1Buf),
        };
        index.artifacts.tier2_4yr = {
            path: 'tier2-4yr.json',
            count: tier2.length,
            cadence: '1d',
            window_years: TIER2_YEARS,
            bytes: tier2Buf.length,
            sha256: sha256Hex(tier2Buf),
        };
        index.populated = 'full';
        log(`tier1-recent.json: ${tier1.length} rows`);
        log(`tier2-4yr.json:    ${tier2.length} rows`);
        log(`hourly rows scanned: ${hourlyRows.toLocaleString()}`);

        if (!opts.skipArchive) {
            const decadeDir = join(opts.out, 'archive-hourly');
            await rm(decadeDir, { recursive: true, force: true });
            const decades = await buildHourlyArchiveByDecade(hourlyFiles, decadeDir);
            index.artifacts.archive_hourly = decades;
            log(`archive-hourly: ${decades.length} decade files`);
        } else {
            log('archive-hourly: skipped (--skip-archive)');
        }
    } else {
        warn('hourly CSVs empty — tier1/tier2/hourly archive skipped');
        warn('run `npm run build:hourly` inside data/heliochronicles/ to populate');
    }

    if (!opts.skipArchive && dailyFiles.length > 0) {
        const dailyPath = join(opts.out, 'archive-daily.bin');
        const dailyMeta = await buildDailyArchive(dailyFiles, dailyPath);
        if (dailyMeta) {
            index.artifacts.archive_daily = { path: 'archive-daily.bin', ...dailyMeta };
            log(`archive-daily.bin: ${dailyMeta.rows} rows, ${(dailyMeta.bytes / 1024).toFixed(1)} KB`);
        }
    } else if (dailyFiles.length === 0) {
        warn('daily CSVs empty — daily archive skipped');
    }

    await writeFile(join(opts.out, 'index.json'), JSON.stringify(index, null, 2) + '\n');
    log(`index.json: populated=${index.populated}`);
}

main().catch(err => {
    console.error('[build-snapshots] FAIL', err.stack || err.message);
    process.exit(1);
});
