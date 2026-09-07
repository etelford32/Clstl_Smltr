#!/usr/bin/env node
/**
 * fetch-bootes-anchors.mjs — refresh the Boötes cluster anchors from VizieR.
 *
 *   node scripts/fetch-bootes-anchors.mjs            # print the refreshed block
 *   node scripts/fetch-bootes-anchors.mjs --write    # rewrite js/bootes-void-data.js
 *   node scripts/fetch-bootes-anchors.mjs --json     # machine-readable dump
 *
 * WHY THIS EXISTS AND WHY IT IS NOT RUN IN CI
 * ───────────────────────────────────────────
 * `NEIGHBOUR_ANCHORS` in js/bootes-void-data.js is TRANSCRIBED from the
 * literature, not fetched, because VizieR and every other astronomy archive is
 * egress-blocked in this repo's build environment — the same situation
 * scripts/fetch-sdo-fixtures.mjs documents for NASA. Transcribed coordinates
 * are good to about ±0.2° and ±0.002 in redshift, which is fine for placing
 * structures tens of Mpc apart and NOT fine for anything that needs an
 * identification.
 *
 * This script is the escape hatch: run it on a machine that has the network,
 * read the diff, commit it, and then update `ANCHOR_ACCURACY` in the data file
 * to say the coordinates are catalogue-sourced rather than transcribed. That
 * last step is the point — the page prints the accuracy statement, so it has to
 * change when the accuracy changes.
 *
 * IT IS NOT WIRED INTO ANY BUILD OR TEST. A gate that silently depends on an
 * external archive is a gate that fails for reasons unrelated to the change
 * being tested; this repo has been bitten by that with NASA's rover endpoints
 * (data/mars/SOURCES.md) and does not repeat it.
 *
 * WHAT IT DOES NOT DO. It refreshes POSITIONS AND REDSHIFTS ONLY. It does not
 * touch `massHintMsun`, because those are order-of-magnitude weights that exist
 * to set the RELATIVE prominence of anchors and are explicitly not measurements
 * (js/bootes-web-model.js constrains the web's total mass to the void profile's
 * own compensating wall, so no cluster mass enters the physics at all). If a
 * future version fetches masses, that changes the model's provenance story and
 * belongs in data/bootes/SOURCES.md before it belongs in code.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = join(ROOT, 'js', 'bootes-void-data.js');

// VizieR's TSV endpoint. Catalogue VII/110A is Abell's cluster catalogue;
// `-out` names the columns we want and `-c` does a cone search per target.
//
// The URL is built from a FIXED template with only the cluster name
// interpolated, and the name is checked against /^A\d{1,4}$/ first. That is the
// whole SSRF story here, and it is the same shape as api/mars/tiles.js: the
// caller never supplies a URL, only a key that the script rebuilds one from.
const VIZIER = 'https://vizier.cds.unistra.fr/viz-bin/asu-tsv';
const CATALOGUE = 'VII/110A';

/** Cluster ids to refresh, in the order they appear in the data file. */
const TARGETS = [
    'A1656', 'A1367', 'A2199', 'A2151', 'A1795', 'A2065', 'A2061', 'A2142', 'A2255',
];

const isSafeName = (name) => /^A\d{1,4}$/.test(name);

async function fetchOne(name) {
    if (!isSafeName(name)) throw new Error(`refusing to query a malformed name: ${name}`);
    const url = `${VIZIER}?-source=${encodeURIComponent(CATALOGUE)}`
        + `&-out=ACO,RAJ2000,DEJ2000,z&-out.max=1`
        + `&ACO=${encodeURIComponent(name.slice(1))}`;
    const res = await fetch(url, { headers: { Accept: 'text/plain' } });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const text = await res.text();
    // VizieR TSV: comment lines start with '#', then a header, a units row, a
    // dashes row, then data. Take the first line that has three tab fields and
    // does not start with '#' or '-'.
    for (const line of text.split('\n')) {
        if (!line || line.startsWith('#') || line.startsWith('-')) continue;
        const cols = line.split('\t').map(s => s.trim());
        if (cols.length < 4) continue;
        const ra = Number(cols[1]);
        const dec = Number(cols[2]);
        const z = Number(cols[3]);
        if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;
        return { id: name.toLowerCase(), raDeg: ra, decDeg: dec, z: Number.isFinite(z) ? z : null };
    }
    throw new Error(`${name}: no usable row in the VizieR response`);
}

async function main() {
    const args = new Set(process.argv.slice(2));
    const results = [];
    const failures = [];

    for (const name of TARGETS) {
        try {
            results.push(await fetchOne(name));
            process.stderr.write(`  ✓ ${name}\n`);
        } catch (err) {
            failures.push({ name, error: String(err.message || err) });
            process.stderr.write(`  ✗ ${name} — ${err.message}\n`);
        }
    }

    if (args.has('--json')) {
        console.log(JSON.stringify({ results, failures }, null, 2));
        return;
    }

    if (!results.length) {
        // A TOTAL FAILURE IS REPORTED, NOT SWALLOWED. If this runs in an
        // environment without egress it must say so loudly rather than writing
        // an empty anchor list over good transcribed data.
        console.error('\nNo anchors resolved. If this machine has no route to '
            + 'vizier.cds.unistra.fr, the transcribed values in '
            + 'js/bootes-void-data.js remain the best available and nothing '
            + 'should be written. See data/bootes/SOURCES.md.');
        process.exitCode = 1;
        return;
    }

    console.log('\n// Refreshed from VizieR ' + CATALOGUE + ' on '
        + new Date().toISOString().slice(0, 10));
    for (const r of results) {
        console.log(`//   ${r.id}: RA ${r.raDeg.toFixed(3)}  Dec ${r.decDeg.toFixed(3)}`
            + (r.z === null ? '  (no z in catalogue — keep the transcribed value)'
                : `  z ${r.z.toFixed(4)}`));
    }

    if (!args.has('--write')) {
        console.log('\nRun again with --write to patch js/bootes-void-data.js in place.');
        return;
    }

    let src = readFileSync(DATA_FILE, 'utf8');
    let patched = 0;
    for (const r of results) {
        // Patch only the numeric fields of the matching entry, leaving the
        // note, source and mass hint alone.
        const block = new RegExp(
            `(id: '${r.id}',[\\s\\S]{0,400}?raDeg: )[-\\d.]+(, decDeg: )[-\\d.]+(, z: )[-\\d.]+`);
        if (!block.test(src)) {
            process.stderr.write(`  ! ${r.id}: no matching entry to patch\n`);
            continue;
        }
        src = src.replace(block, (m, a, b, c) =>
            `${a}${r.raDeg.toFixed(3)}${b}${r.decDeg.toFixed(3)}${c}`
            + `${(r.z === null ? m.match(/z: ([-\d.]+)/)[1] : r.z.toFixed(4))}`);
        patched++;
    }
    writeFileSync(DATA_FILE, src);
    console.log(`\n✅ patched ${patched} anchor(s) in js/bootes-void-data.js`);
    console.log('NOW UPDATE `ANCHOR_ACCURACY` in that file: the coordinates are '
        + 'catalogue-sourced, not transcribed, and the page prints that statement.');
    console.log('Then run: node tests/bootes-web-model.mjs');
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
