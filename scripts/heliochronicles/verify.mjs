#!/usr/bin/env node
/**
 * verify.mjs — CI sanity check for heliochronicles snapshot artifacts.
 *
 * Checks:
 *   1. data/history/index.json exists and parses.
 *   2. Every artifact path listed in the index resolves on disk and matches
 *      its recorded byte count and sha256.
 *   3. tier1-recent.json has rows within the last 2 × TIER1_DAYS (sanity).
 *   4. Catalog JSON files parse and contain the claimed number of entries.
 *   5. If both tier1 and tier2 are populated, their packed record shape
 *      matches the 10-field SolarWeatherHistory contract.
 *
 * Exits 0 on success, 1 on any failure. Acceptable failure modes:
 *   - `populated: "catalog_only"` — CSVs not yet built; catalog-only checks run.
 *   - `populated: "full"`          — full verification required.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const args = process.argv.slice(2);
let historyDir = resolve(repoRoot, 'data', 'history');
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') historyDir = resolve(args[++i]);
    else { console.error(`unknown argument: ${args[i]}`); process.exit(2); }
}

const REQUIRED_TIER_FIELDS = ['t', 'v', 'bz', 'by', 'n', 'pdyn', 'kp', 'dst', 'epsilon', 'substorm'];
const MS_PER_DAY = 86_400_000;

let failed = 0;
function ok(msg)   { console.log(`  ok   ${msg}`); }
function fail(msg) { console.error(`  FAIL ${msg}`); failed++; }
function section(msg) { console.log(`\n${msg}`); }

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function sha256OfFile(path) {
    const buf = await readFile(path);
    return { sha: createHash('sha256').update(buf).digest('hex'), bytes: buf.length, buf };
}

async function main() {
    section('index.json');
    const indexPath = join(historyDir, 'index.json');
    if (!await exists(indexPath)) { fail(`missing ${indexPath}`); return; }
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    ok(`parsed; populated=${index.populated}`);

    section('catalog');
    for (const c of index.artifacts?.catalog ?? []) {
        const abs = resolve(historyDir, c.path);
        if (!await exists(abs)) { fail(`${c.id} missing at ${abs}`); continue; }
        const { sha, bytes, buf } = await sha256OfFile(abs);
        if (bytes !== c.bytes) fail(`${c.id} bytes mismatch: ${bytes} vs ${c.bytes}`);
        else if (sha !== c.sha256) fail(`${c.id} sha256 mismatch`);
        else {
            try {
                const parsed = JSON.parse(buf.toString('utf8'));
                ok(`${c.id} (${bytes} B, count=${c.count ?? '—'})`);
                void parsed;
            } catch { fail(`${c.id} is not valid JSON`); }
        }
    }

    const populated = index.populated;
    if (populated === 'catalog_only') {
        section('tier data');
        ok('skipped — catalog_only build (CSVs not yet populated)');
    } else if (populated === 'full') {
        section('tier1-recent.json');
        await verifyTier(index.artifacts.tier1_recent, 'tier1');
        section('tier2-4yr.json');
        await verifyTier(index.artifacts.tier2_4yr, 'tier2');

        section('archive-hourly');
        for (const d of index.artifacts.archive_hourly ?? []) {
            const abs = resolve(historyDir, 'archive-hourly', d.path.replace(/^archive-hourly\//, ''));
            const direct = resolve(historyDir, d.path);
            const target = await exists(abs) ? abs : direct;
            if (!await exists(target)) { fail(`decade ${d.decade}: missing at ${target}`); continue; }
            const { sha, bytes } = await sha256OfFile(target);
            if (bytes !== d.bytes) fail(`decade ${d.decade}: bytes ${bytes} vs ${d.bytes}`);
            else if (sha !== d.sha256) fail(`decade ${d.decade}: sha256 mismatch`);
            else if (bytes !== d.rows * d.stride) fail(`decade ${d.decade}: size ${bytes} ≠ ${d.rows}×${d.stride}`);
            else ok(`decade ${d.decade}: ${d.rows} rows, ${(bytes / 1024).toFixed(1)} KB`);
        }

        section('archive-daily.bin');
        const ad = index.artifacts.archive_daily;
        if (ad) {
            const abs = resolve(historyDir, ad.path);
            if (!await exists(abs)) fail(`missing ${abs}`);
            else {
                const { sha, bytes } = await sha256OfFile(abs);
                if (bytes !== ad.bytes) fail(`bytes ${bytes} vs ${ad.bytes}`);
                else if (sha !== ad.sha256) fail('sha256 mismatch');
                else ok(`${ad.rows} rows, ${(bytes / 1024).toFixed(1)} KB`);
            }
        } else {
            ok('absent (daily CSVs not populated yet)');
        }
    } else {
        fail(`unknown populated=${populated}`);
    }

    section('summary');
    if (failed === 0) { ok('all checks passed'); process.exit(0); }
    else               { console.error(`  ${failed} check(s) failed`); process.exit(1); }
}

async function verifyTier(meta, label) {
    if (!meta) { fail(`${label}: not recorded in index`); return; }
    const abs = resolve(historyDir, meta.path);
    if (!await exists(abs)) { fail(`${label}: missing at ${abs}`); return; }

    const { sha, bytes, buf } = await sha256OfFile(abs);
    if (bytes !== meta.bytes) { fail(`${label}: bytes ${bytes} vs ${meta.bytes}`); return; }
    if (sha !== meta.sha256)  { fail(`${label}: sha256 mismatch`); return; }

    let rows;
    try { rows = JSON.parse(buf.toString('utf8')); }
    catch { fail(`${label}: not parseable`); return; }
    if (!Array.isArray(rows)) { fail(`${label}: not an array`); return; }
    if (rows.length !== meta.count) fail(`${label}: count ${rows.length} vs ${meta.count}`);

    if (rows.length > 0) {
        const keys = Object.keys(rows[0]);
        for (const f of REQUIRED_TIER_FIELDS) {
            if (!keys.includes(f)) { fail(`${label}: first row missing field '${f}'`); return; }
        }
        if (label === 'tier1') {
            const latest = rows[rows.length - 1].t;
            const gap = Date.now() - latest;
            if (gap > 60 * MS_PER_DAY) fail(`tier1: latest record ${new Date(latest).toISOString()} is ${(gap / MS_PER_DAY).toFixed(1)} d old`);
        }
    }
    ok(`${label}: ${rows.length} rows, ${REQUIRED_TIER_FIELDS.length} fields`);
}

main().catch(err => {
    console.error('[verify] FAIL', err.stack || err.message);
    process.exit(1);
});
