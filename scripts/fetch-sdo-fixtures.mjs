#!/usr/bin/env node
/**
 * scripts/fetch-sdo-fixtures.mjs — replace the synthetic SDO fixtures with
 * REAL browse frames (run on a machine that can reach sdo.gsfc.nasa.gov —
 * the build sandbox cannot).
 *
 *   node scripts/fetch-sdo-fixtures.mjs [--res 1024]
 *
 * Writes tests/fixtures/sdo/real_<channel>.jpg + real-manifest.json (fetch
 * time, upstream URL, Last-Modified). tests/sun-visual.spec.js prefers the
 * real set when present; tests/sun-observed.mjs keeps using the synthetic
 * set because only the generator knows where it planted its features.
 * Nothing here is imported by the site.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = join(ROOT, 'tests', 'fixtures', 'sdo');
const res  = Number((process.argv.find(a => a.startsWith('--res=')) || '--res=1024').split('=')[1]);
const CODE = { white: 'HMIIC', mag: 'HMIB', 94: '0094', 131: '0131', 171: '0171', 193: '0193', 211: '0211', 304: '0304' };
mkdirSync(OUT, { recursive: true });

const manifest = { synthetic: false, fetched: new Date().toISOString(), res, frames: {} };
for (const [ch, code] of Object.entries(CODE)) {
    const url = `https://sdo.gsfc.nasa.gov/assets/img/latest/latest_${res}_${code}.jpg`;
    const r = await fetch(url);
    if (!r.ok) { console.error(`${ch}: HTTP ${r.status}`); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    const name = `real_${ch}.jpg`;
    writeFileSync(join(OUT, name), buf);
    manifest.frames[ch] = { file: name, url, lastModified: r.headers.get('last-modified'), bytes: buf.length };
    console.log(`wrote ${name} (${buf.length} B)`);
}
writeFileSync(join(OUT, 'real-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
