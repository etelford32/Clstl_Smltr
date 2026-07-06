#!/usr/bin/env node
/**
 * build-storm-catalog.mjs — pack the Storm Observatory's LEO population.
 * ═══════════════════════════════════════════════════════════════════════
 * Two modes, one output layout (js/storm/catalog.js STRIDE-8 Float32):
 *
 *   node scripts/build-storm-catalog.mjs
 *     → synthetic 20 k population (deterministic, seed 2022). The
 *       STRUCTURE is real (documented shells / debris clouds / SSO band);
 *       the individual objects are drawn from distributions, so the meta
 *       carries `_is_placeholder: true` and the page watermarks.
 *
 *   node scripts/build-storm-catalog.mjs --gp <celestrak_gp.json>
 *     → packs real CelesTrak GP records (perigee ≤ 1000 km, ≤ 20 k
 *       objects) and clears the watermark. Fetch upstream with e.g.
 *       curl 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json'
 *
 * Outputs: data/storm/catalog_leo20k.bin  (raw Float32 elements)
 *          data/storm/catalog_leo20k.meta.json
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    STRIDE, CATALOG_N_DEFAULT, synthCatalogInto, packGpCatalog,
} from '../js/storm/catalog.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const gpPath = args.includes('--gp') ? args[args.indexOf('--gp') + 1] : null;

let els, meta, placeholder;
if (gpPath) {
    const gp = JSON.parse(await readFile(resolve(gpPath), 'utf8'));
    ({ els, meta } = packGpCatalog(gp));
    placeholder = false;
    meta.source = `CelesTrak GP — ${gpPath}`;
} else {
    els = new Float32Array(CATALOG_N_DEFAULT * STRIDE);
    meta = synthCatalogInto(els, CATALOG_N_DEFAULT, 2022);
    placeholder = true;
    meta.source = 'SYNTHETIC population (real structure, drawn objects) — ' +
        're-bake with --gp <celestrak_gp.json> to clear the watermark';
}
meta._is_placeholder = placeholder;
meta.stride = STRIDE;
meta.generated_utc = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

await mkdir(resolve(ROOT, 'data/storm'), { recursive: true });
await writeFile(resolve(ROOT, 'data/storm/catalog_leo20k.bin'), Buffer.from(els.buffer));
await writeFile(resolve(ROOT, 'data/storm/catalog_leo20k.meta.json'), JSON.stringify(meta));
console.log(`✓ catalog: ${meta.n} objects (${placeholder ? 'SYNTHETIC/placeholder' : 'real GP'}), ` +
    `${(els.byteLength / 1024).toFixed(0)} KiB + meta (${meta.named.length} named)`);
