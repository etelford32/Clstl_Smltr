#!/usr/bin/env node
/**
 * Convert NASA PDS MOLA MEGDR topography into an 8-bit PNG height texture.
 *
 * Source product:
 *   MGS-M-MOLA-5-MEGDR-L3-V1.0 / MEGT90N000CB.IMG
 *   1440 x 720, signed 16-bit big-endian metres, 4 pixels/degree.
 *
 * Usage:
 *   node scripts/build-mars-mola-texture.mjs INPUT.IMG OUTPUT.png
 *
 * The PNG stores -8068 m as 0 and +21134 m as 255. The source's 0–360°E
 * longitude domain is rolled by 180° into the -180–180° domain used by the
 * JPL Viking texture and the site's shared globe coordinates. No resampling
 * or smoothing is applied.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 1440;
const HEIGHT = 720;
const MIN_ELEVATION_M = -8068;
const MAX_ELEVATION_M = 21134;
const EXPECTED_BYTES = WIDTH * HEIGHT * 2;

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
    console.error('Usage: node scripts/build-mars-mola-texture.mjs INPUT.IMG OUTPUT.png');
    process.exit(2);
}

const source = readFileSync(inputPath);
if (source.length !== EXPECTED_BYTES) {
    throw new Error(`Expected ${EXPECTED_BYTES} bytes; received ${source.length}`);
}

const scanlines = Buffer.alloc((WIDTH + 1) * HEIGHT);
const elevationSpan = MAX_ELEVATION_M - MIN_ELEVATION_M;

for (let y = 0; y < HEIGHT; y++) {
    const rowOffset = y * (WIDTH + 1);
    scanlines[rowOffset] = 0; // PNG filter: None
    for (let x = 0; x < WIDTH; x++) {
        const sourceX = (x + WIDTH / 2) % WIDTH;
        const sampleOffset = (y * WIDTH + sourceX) * 2;
        const elevation = source.readInt16BE(sampleOffset);
        const normalized = (elevation - MIN_ELEVATION_M) / elevationSpan;
        scanlines[rowOffset + 1 + x] = Math.round(Math.max(0, Math.min(1, normalized)) * 255);
    }
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBytes, data]);
    const length = Buffer.alloc(4);
    const checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 0;  // grayscale
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
]);

writeFileSync(outputPath, png);
console.log(`Wrote ${outputPath} (${WIDTH}x${HEIGHT}, ${png.length} bytes)`);
