#!/usr/bin/env node
/**
 * scripts/make-sdo-synthetic-fixtures.mjs — regenerate tests/fixtures/sdo/*
 *
 * Writes one SYNTHETIC frame per channel sun.html can wrap (white, mag, 171,
 * 193, 211, 131, 304) plus a manifest.json carrying the planted-feature ground
 * truth. See tests/fixtures/sdo/README.md — these are stand-ins with the
 * real browse-frame geometry, not observations. Replace with real frames via
 * scripts/fetch-sdo-fixtures.mjs on a machine that can reach nasa.gov.
 *
 *   node scripts/make-sdo-synthetic-fixtures.mjs [--size 512]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSyntheticDisk, encodePng, FIXTURE_EPOCH_ISO, PLANTED } from './lib/sdo-synth.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = join(ROOT, 'tests', 'fixtures', 'sdo');
const size = Number((process.argv.find(a => a.startsWith('--size=')) || '--size=512').split('=')[1]);
mkdirSync(OUT, { recursive: true });

const manifest = { synthetic: true, generated: new Date().toISOString(), epoch: FIXTURE_EPOCH_ISO, size, planted: PLANTED, frames: {} };
for (const ch of ['white', 'mag', '171', '193', '211', '131', '304']) {
    const frame = renderSyntheticDisk(ch, { size });
    const name  = `synthetic_${ch}.png`;
    writeFileSync(join(OUT, name), encodePng(frame));
    manifest.frames[ch] = { file: name, ...frame.meta };
    console.log(`wrote ${name} (${frame.width}²)`);
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('wrote manifest.json');
