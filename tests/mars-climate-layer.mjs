#!/usr/bin/env node
/**
 * mars-climate-layer.mjs — gate for js/mars-climate-layer.js.
 *
 * Run: node tests/mars-climate-layer.mjs
 *
 * This module is a RENDERER, and renderers in this repo normally get a browser
 * smoke test rather than a unit test. It gets both, because it was written
 * three.js-free specifically so it could be run here — and the first thing
 * that found was a corrupted colour literal in a ramp, which would have
 * shipped as a wrong-coloured band on the air-temperature map with nothing
 * failing.
 *
 * The load-bearing pins:
 *   • Every ramp stop parses to a real colour, is ordered, and spans [0,1].
 *     A typo'd hex literal is the silent failure this exists for.
 *   • The prepare/paint split is REAL: paint must be an order of magnitude
 *     cheaper than prepare, or the sol scrubber is janky again.
 *   • paint() must not allocate per call — it runs on every scrubber tick.
 *   • Row 0 of the buffer is latitude −90, matching js/mars-view.js's
 *     latLonUv. Getting this backwards renders a plausible-looking map with
 *     the seasons inverted.
 *   • The painted field must actually track the kernel: a pixel's colour has
 *     to move when the sol clock moves, and the day side has to read hotter
 *     than the night side.
 *   • The layer computes NO physics of its own — it must not re-derive
 *     anything the kernel exports.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    CLIMATE_FIELDS, CLIMATE_FIELD_ORDER, legendFor, createClimateField,
    formatK, formatPa, formatDensity,
} from '../js/mars-climate-layer.js';
import { surfaceClimate, equationOfTimeHours } from '../js/mars-atmosphere-model.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

/** A synthetic but Mars-shaped terrain, so the gate needs no image decoding. */
const elevationAt = (lat, lon) =>
    -2000 + 9000 * Math.sin(lon * Math.PI / 180) * Math.cos(lat * Math.PI / 180)
    + 3000 * Math.cos(lat * Math.PI / 90);
const brightnessAt = (lat, lon) => 0.5 + 0.35 * Math.sin((lon + lat) * Math.PI / 120);

// ── 1. Every ramp stop is a real, ordered colour ────────────────────────────
{
    assert.equal(CLIMATE_FIELD_ORDER.length, Object.keys(CLIMATE_FIELDS).length,
        'every defined field must appear in the presentation order');
    for (const id of CLIMATE_FIELD_ORDER) {
        const field = CLIMATE_FIELDS[id];
        assert.ok(field, `CLIMATE_FIELD_ORDER names a field that does not exist: ${id}`);
        assert.equal(field.id, id, `field ${id} must carry its own key as .id`);
        assert.ok(field.label && field.unit && field.note,
            `field ${id} must carry a label, a unit and an explanatory note`);
        assert.ok(Array.isArray(field.range) && field.range.length === 2
            && field.range[0] < field.range[1],
            `field ${id} must declare an ordered [min, max] ramp domain`);

        // THE TYPO GATE. A malformed hex literal in a ramp is a syntax error
        // only if you are lucky; `0xdcc druck` was not, and would have shipped.
        assert.ok(field.stops.length >= 2, `field ${id} needs at least two ramp stops`);
        let previousPosition = -Infinity;
        for (const [position, colour] of field.stops) {
            assert.ok(Number.isFinite(position) && position >= 0 && position <= 1,
                `field ${id} has a ramp stop outside [0,1]: ${position}`);
            assert.ok(position > previousPosition,
                `field ${id} ramp stops must strictly increase (${position} after ${previousPosition})`);
            previousPosition = position;
            assert.ok(Number.isInteger(colour) && colour >= 0 && colour <= 0xffffff,
                `field ${id} has a ramp colour that is not a 24-bit integer: ${colour}`);
        }
        near(field.stops[0][0], 0, 1e-9, `field ${id} ramp must start at 0`);
        near(field.stops[field.stops.length - 1][0], 1, 1e-9, `field ${id} ramp must end at 1`);
    }
    ok('every ramp stop is a valid 24-bit colour at a strictly increasing position');
}

// ── 2. Legends carry real units and span the field ─────────────────────────
{
    for (const id of CLIMATE_FIELD_ORDER) {
        const legend = legendFor(id);
        assert.ok(legend, `legendFor(${id}) must return a legend`);
        assert.equal(legend.min, CLIMATE_FIELDS[id].range[0], `legend min for ${id}`);
        assert.equal(legend.max, CLIMATE_FIELDS[id].range[1], `legend max for ${id}`);
        assert.ok(legend.swatches.length >= 2, `legend for ${id} needs swatches`);
        for (const swatch of legend.swatches) {
            assert.match(swatch.css, /^#[0-9a-f]{6}$/,
                `legend swatch for ${id} must be a full 6-digit hex colour, got ${swatch.css}`);
            assert.ok(swatch.value >= legend.min - 1e-9 && swatch.value <= legend.max + 1e-9,
                `legend swatch value out of range for ${id}`);
        }
        // Ends must differ, or the legend reads as a solid block.
        assert.notEqual(legend.swatches[0].css, legend.swatches[legend.swatches.length - 1].css,
            `legend for ${id} must not begin and end on the same colour`);
    }
    assert.equal(legendFor('not-a-field'), null, 'an unknown field id must return null, not throw');
    ok('legends span their field, in real units, with distinct end colours');
}

// ── 3. The prepare/paint split is real ─────────────────────────────────────
{
    const field = createClimateField({ width: 256, height: 128, elevationAt, brightnessAt });

    // Warm the JIT on both paths before timing either.
    field.prepare(100);
    for (const id of CLIMATE_FIELD_ORDER) field.paint(id, 6);

    const before = process.hrtime.bigint();
    field.prepare(249);
    const prepareMs = Number(process.hrtime.bigint() - before) / 1e6;

    const paintStart = process.hrtime.bigint();
    for (let i = 0; i < 10; i += 1) field.paint('surface-temp', i * 2.4);
    const paintMs = Number(process.hrtime.bigint() - paintStart) / 1e6 / 10;

    assert.ok(paintMs * 8 < prepareMs,
        `paint (${paintMs.toFixed(2)} ms) must be far cheaper than prepare (${prepareMs.toFixed(2)} ms) — `
        + 'if they converge, time-independent work has leaked into paint and the sol scrubber will jank');

    // Re-preparing the same season must be a no-op, not a silent recompute.
    assert.equal(field.prepare(249), false, 'preparing an unchanged season must short-circuit');
    assert.equal(field.prepare(250), true, 'a new season must actually re-prepare');
    ok(`prepare/paint split holds (prepare ${prepareMs.toFixed(0)} ms, paint ${paintMs.toFixed(2)} ms)`);
}

// ── 4. paint() must not allocate, and must reuse its buffer ────────────────
{
    const field = createClimateField({ width: 64, height: 32, elevationAt, brightnessAt });
    field.prepare(180);
    const first = field.paint('surface-temp', 3);
    const second = field.paint('surface-temp', 15);
    assert.equal(first, second,
        'paint must write into ONE stable buffer — a DataTexture built over it must stay valid');
    assert.equal(first, field.pixels, 'paint must return the same buffer the field exposes');
    ok('paint writes in place into a single stable buffer');
}

// ── 5. Row 0 is latitude −90, matching mars-view.js latLonUv ───────────────
{
    // A season with a hard hemispheric asymmetry: at Ls 90 the SOUTH pole is in
    // polar night and frosted, the NORTH pole is in polar day. If the buffer
    // were flipped, this reads as a perfectly plausible map with the seasons
    // inverted — which is why it is pinned rather than eyeballed.
    const field = createClimateField({
        width: 64, height: 32, elevationAt: () => 0, brightnessAt: null,
    });
    field.prepare(90);
    field.paint('frost', 12);
    const pixels = field.pixels;
    const rowMean = (y) => {
        let sum = 0;
        for (let x = 0; x < 64; x += 1) sum += pixels[(y * 64 + x) * 4 + 2]; // blue channel
        return sum / 64;
    };
    // The frost ramp is pale blue at margin 0 and brown at high margin, so the
    // frosted winter pole must be markedly BLUER than the summer pole.
    const southRow = rowMean(0);
    const northRow = rowMean(31);
    assert.ok(southRow > northRow + 40,
        `row 0 must be the SOUTHERN pole: at Ls 90 it is in polar night and frosted, so it must read `
        + `far bluer than row height−1 (got ${southRow.toFixed(0)} vs ${northRow.toFixed(0)})`);
    ok('buffer row 0 is latitude −90, matching js/mars-view.js latLonUv');
}

// ── 6. The painted field tracks the kernel ─────────────────────────────────
{
    const field = createClimateField({ width: 128, height: 64, elevationAt, brightnessAt });
    field.prepare(249);

    // Same pixel, opposite sides of the sol: the colour must move.
    field.paint('surface-temp', 0);
    const atMidnight = Array.from(field.pixels.slice(0, 4));
    field.paint('surface-temp', 12);
    const atNoon = Array.from(field.pixels.slice(0, 4));
    assert.notDeepEqual(atMidnight, atNoon,
        'the field must change with the sol clock — otherwise the scrubber is decorative');

    // Day side hotter than night side, read off the same row.
    field.paint('surface-temp', 12);
    const row = 32;
    const brightness = [];
    for (let x = 0; x < 128; x += 1) {
        const o = (row * 128 + x) * 4;
        brightness.push({ x, value: field.pixels[o] + field.pixels[o + 1] + field.pixels[o + 2] });
    }
    const hottest = brightness.reduce((a, b) => (b.value > a.value ? b : a));
    const coldest = brightness.reduce((a, b) => (b.value < a.value ? b : a));
    assert.ok(hottest.value > coldest.value * 1.2,
        'a latitude row must show a strong day/night contrast — the terminator emerges from the data');

    // And the SINGLE-POINT readout must agree with the kernel exactly. This is
    // the pin that stops the readout drifting from the map's own model.
    const lat = 18.4265;
    const lon = 77.2246;
    const mtc = 9.75;
    const sampled = field.sampleAt(lat, lon, mtc);
    const expected = surfaceClimate({
        latDeg: lat,
        lonDeg: lon,
        elevationM: elevationAt(lat, lon),
        lsDeg: 249,
        localTrueSolarTime: ((mtc + lon / 15 + 24) % 24 + equationOfTimeHours(249) + 24) % 24,
        albedo: sampled.albedo,
        thermalInertia: sampled.thermalInertia,
        opacity: sampled.opacity,
    });
    near(sampled.surfaceTempK, expected.surfaceTempK, 1e-9, 'readout surface temperature matches the kernel');
    near(sampled.pressurePa, expected.pressurePa, 1e-9, 'readout pressure matches the kernel');
    near(sampled.airTempK, expected.airTempK, 1e-9, 'readout air temperature matches the kernel');
    // The readout must NOT inherit the map's grid quantization.
    const nudged = field.sampleAt(lat + 0.01, lon + 0.01, mtc);
    assert.notEqual(nudged.pressurePa, sampled.pressurePa,
        'sampleAt must go straight to the rasters, not to the 512×256 grid');
    ok('painted field tracks the sol clock, shows the terminator, and agrees with the kernel');
}

// ── 7. Degradation: no albedo raster must not invent one ───────────────────
{
    const field = createClimateField({
        width: 32, height: 16, elevationAt, brightnessAt: null, defaultAlbedo: 0.22,
    });
    field.prepare(0);
    const buffer = field.paint('air-temp', 12);
    assert.ok(buffer.every(Number.isFinite), 'the no-albedo path must still paint a finite field');
    const sample = field.sampleAt(0, 0, 12);
    assert.equal(sample.albedo, 0.22, 'without a basemap the field must fall back to a stated albedo');
    assert.equal(sample.albedoIsProxy, false,
        'the fallback must NOT claim to be a basemap-derived proxy — that flag drives the disclosure');
    ok('a missing albedo raster falls back to a stated constant, and says so');
}

// ── 8. The layer computes no physics of its own ────────────────────────────
{
    const path = fileURLToPath(new URL('../js/mars-climate-layer.js', import.meta.url));
    const source = readFileSync(path, 'utf8');
    const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // three.js must stay out, or this whole gate stops being runnable.
    assert.ok(!/from ['"]three['"]/.test(body),
        'the layer must not import three — that is what keeps it unit-testable in node');

    // Physical constants belong to the kernel. A number like the Stefan-
    // Boltzmann constant or a frost-point coefficient appearing here means the
    // physics has been forked.
    for (const smell of ['5.670374', '3182.48', '23.3494', '1361', '0.0934']) {
        assert.ok(!body.includes(smell),
            `the layer must not restate the kernel's constants — found ${smell}`);
    }
    ok('the layer imports its physics and restates none of it');
}

// ── 9. Formatters ──────────────────────────────────────────────────────────
{
    assert.equal(formatK(273.15), '0.0 °C', 'formatK converts to Celsius');
    assert.equal(formatK(193.85), '-79.3 °C', 'formatK reproduces the MEDA minimum');
    assert.equal(formatPa(778.9), '779 Pa', 'formatPa reports pascals below 1 kPa');
    assert.equal(formatPa(1240), '1.24 kPa', 'formatPa switches to kPa above 1000');
    assert.equal(formatDensity(0.0161), '16.1 g/m³', 'formatDensity uses g/m³ — Mars air is thin');
    ok('formatters render Celsius, pascals and grams per cubic metre');
}

console.log(`\n${passed} checks passed — js/mars-climate-layer.js`);
