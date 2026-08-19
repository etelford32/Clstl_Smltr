/**
 * mars-climate-layer.js — renders js/mars-atmosphere-model.js onto the globe.
 * ═══════════════════════════════════════════════════════════════════════════
 * This module OWNS no physics. Every number it paints comes from the kernel;
 * its whole job is turning that field into pixels fast enough to scrub.
 *
 * ── WHY IT IS SPLIT IN TWO ───────────────────────────────────────────────
 * A full evaluation of the kernel over a 512×256 grid costs ~250 ms (measured,
 * with the per-latitude harmonics cache already in play). That is fine once
 * and hopeless on a time scrubber, which is exactly the control the field
 * needs to be legible — Mars' diurnal swing is ~100 K, far larger than its
 * equator-to-pole gradient, so a static heat map hides most of the story.
 * The season scrubber is additionally DEBOUNCED in js/mars-view.js, because
 * even 70 ms cannot keep up with a drag; the sol clock is not, because it
 * does not need to be.
 *
 * So the work is split along what actually changes:
 *
 *   prepare(lsDeg, opacity)   SEASON changes. Caches per pixel the quantities
 *                             that do not depend on time of day: pressure,
 *                             frost point, diurnal mean, diurnal amplitude,
 *                             conduction phase lag, column temperature — via
 *                             the kernel's lean columnProfile entry point.
 *                             ~230 ms on the FIRST call (which also does the
 *                             131 k bilinear MOLA + albedo raster samples,
 *                             once) and ~70 ms on every season change after.
 *                             Measured in Chromium, not just node.
 *
 *   paint(field, mtcHours)    TIME changes. Per pixel this is two multiplies,
 *                             an add, a clamp and a ramp lookup — the hour
 *                             angle's sin/cos depend only on LONGITUDE, so
 *                             they are cached per COLUMN (width values, not
 *                             width×height). ~5 ms median in Chromium at full
 *                             resolution, including the texture upload.
 *
 * Changing the field selector only re-runs paint. Changing the sol clock only
 * re-runs paint. Only moving the season pays for prepare. If you add a control
 * that feeds the kernel, decide which side of that line it belongs on before
 * wiring it — putting a scrubbable input into prepare is what would make this
 * layer janky again.
 *
 * ── WHAT THE COLOURS MEAN ────────────────────────────────────────────────
 * The ramps are sequential and perceptually ordered, and every field carries
 * its own legend with real units. The terminator is NOT drawn onto this layer:
 * it emerges, because the night side genuinely is ~100 K colder. Under the
 * field sits a faint shading from the Viking basemap's own brightness so
 * terrain stays legible — the same trick as shaded relief under a choropleth,
 * at low enough strength that it cannot be mistaken for data.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────
 * The regional surface patch does NOT get a climate tint. Across 520 km the
 * instantaneous temperature field is nearly flat — a wash that would fight the
 * hypsometric and geology-synth colours the patch already carries for real
 * reasons. Surface mode gets the kernel's NUMBERS in the pilot cluster
 * instead, which is what a reader at that altitude actually needs (pressure,
 * density, air temperature, margin to CO₂ frost).
 */

// NO three.js import, deliberately. The only thing this module would have
// wanted three for is wrapping its output in a DataTexture, and three is
// resolved through mars.html's importmap — importing it here would make the
// whole layer unloadable in node and cost it its unit test. It owns the pixel
// buffer; js/mars-view.js owns the texture around it. That is also why a ramp
// typo is caught by tests/mars-climate-layer.mjs rather than by eye.
import {
    surfaceClimate, columnProfile, insolationHarmonics, dustOpacity,
    equationOfTimeHours,
    thermalInertiaFromAlbedo, albedoFromRelativeBrightness,
    AIR_COUPLING_DAY, AIR_COUPLING_NIGHT,
} from './mars-atmosphere-model.js';

const DEG = Math.PI / 180;

/**
 * Field definitions. `range` is the ramp domain in the field's own units;
 * `stops` are the colour ramp; `legend` is what the UI prints.
 */
export const CLIMATE_FIELDS = Object.freeze({
    'surface-temp': {
        id: 'surface-temp',
        label: 'Ground temperature',
        unit: 'K',
        short: 'T ground',
        // 140 K is below the coldest CO₂ frost point anywhere; 300 K is above
        // the hottest ground Mars reaches at perihelion.
        range: [140, 300],
        note: 'Regolith skin temperature. Swings ~100 K per sol — the atmosphere is too thin to buffer it.',
        stops: [
            [0.00, 0x2b1a4d], [0.18, 0x28407e], [0.36, 0x2f7fa6],
            [0.54, 0x7fb48a], [0.70, 0xd8c46a], [0.85, 0xe8894a], [1.00, 0xfbe9d2],
        ],
    },
    'air-temp': {
        id: 'air-temp',
        label: 'Air temperature (1.5 m)',
        unit: 'K',
        short: 'T air',
        range: [145, 265],
        note: 'At MEDA / REMS sensor height. Swings roughly half as hard as the ground beneath it.',
        stops: [
            [0.00, 0x241a44], [0.20, 0x2b4a86], [0.42, 0x3a86a8],
            [0.62, 0x84b590], [0.80, 0xd8c47e], [1.00, 0xf2d9b0],
        ],
    },
    pressure: {
        id: 'pressure',
        label: 'Surface pressure',
        unit: 'Pa',
        short: 'p',
        range: [50, 1300],
        note: 'Topography dominates: a ~16× range from the Olympus Mons summit to the Hellas floor.',
        stops: [
            [0.00, 0x1d1338], [0.15, 0x3b2a6b], [0.35, 0x6b3f7a],
            [0.55, 0xa85570], [0.75, 0xd9825a], [1.00, 0xf6d9a8],
        ],
    },
    frost: {
        id: 'frost',
        label: 'CO₂ frost margin',
        unit: 'K above frost point',
        short: 'ΔT frost',
        // 140 K, not 60: the margin genuinely reaches ~140 K on a summer
        // equatorial afternoon, and a 60 K ceiling clamped two thirds of the
        // planet to one flat brown. The frost transition keeps its resolution
        // anyway because the stops are bunched at the bottom — the first 12 %
        // of the ramp covers the first ~17 K, which is the band that matters.
        range: [0, 140],
        note: 'How far the ground sits above the CO₂ condensation point. Zero means the seasonal cap is on the ground here.',
        stops: [
            [0.00, 0xdff0fb], [0.02, 0x9fd0ee], [0.12, 0x4d7fb5],
            [0.35, 0x3c5a6e], [0.70, 0x6b4a3c], [1.00, 0xc08a52],
        ],
    },
});

/** Order the UI presents them in. */
export const CLIMATE_FIELD_ORDER = Object.freeze([
    'surface-temp', 'air-temp', 'pressure', 'frost',
]);

/** Interpolate a ramp at t ∈ [0,1], returning packed 0xRRGGBB. */
function rampAt(stops, t) {
    const clamped = Math.min(1, Math.max(0, t));
    let lower = stops[0];
    let upper = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i += 1) {
        if (clamped >= stops[i][0] && clamped <= stops[i + 1][0]) {
            lower = stops[i];
            upper = stops[i + 1];
            break;
        }
    }
    const span = upper[0] - lower[0] || 1;
    const f = (clamped - lower[0]) / span;
    const a = lower[1];
    const b = upper[1];
    const r = Math.round((a >> 16 & 255) + ((b >> 16 & 255) - (a >> 16 & 255)) * f);
    const g = Math.round((a >> 8 & 255) + ((b >> 8 & 255) - (a >> 8 & 255)) * f);
    const bl = Math.round((a & 255) + ((b & 255) - (a & 255)) * f);
    return (r << 16) | (g << 8) | bl;
}

/** Legend swatches + tick labels for a field. */
export function legendFor(fieldId, { steps = 6 } = {}) {
    const field = CLIMATE_FIELDS[fieldId];
    if (!field) return null;
    const [lo, hi] = field.range;
    const swatches = [];
    for (let i = 0; i < steps; i += 1) {
        const t = i / (steps - 1);
        swatches.push({
            t,
            css: `#${rampAt(field.stops, t).toString(16).padStart(6, '0')}`,
            value: lo + (hi - lo) * t,
        });
    }
    return { field, swatches, min: lo, max: hi, unit: field.unit, note: field.note };
}

/** Precompute a 256-entry lookup per field so paint() never interpolates. */
function buildRampLut(stops) {
    const lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i += 1) {
        const packed = rampAt(stops, i / 255);
        lut[i * 3] = packed >> 16 & 255;
        lut[i * 3 + 1] = packed >> 8 & 255;
        lut[i * 3 + 2] = packed & 255;
    }
    return lut;
}

const RAMP_LUTS = new Map(
    Object.entries(CLIMATE_FIELDS).map(([id, field]) => [id, buildRampLut(field.stops)]),
);

/**
 * Build the climate field renderer.
 *
 * `elevationAt(lat, lon)` and `brightnessAt(lat, lon)` are supplied by the
 * page — the MOLA and Viking samplers it already owns. `brightnessAt` returns
 * a RELATIVE 0–1 basemap brightness, which the kernel stretches onto Mars'
 * real albedo range; it is a proxy for thermal inertia and is disclosed as one.
 * A null brightnessAt falls back to a uniform albedo rather than inventing
 * texture.
 */
export function createClimateField({
    width = 512,
    height = 256,
    elevationAt,
    brightnessAt = null,
    defaultAlbedo = 0.20,
} = {}) {
    const pixels = width * height;

    // Per-pixel caches, filled by prepare().
    const pressurePa = new Float32Array(pixels);
    const frostPointK = new Float32Array(pixels);
    const meanK = new Float32Array(pixels);
    const amplitudeK = new Float32Array(pixels);
    const cosLag = new Float32Array(pixels);
    const sinLag = new Float32Array(pixels);
    const columnK = new Float32Array(pixels);
    const shade = new Float32Array(pixels);       // basemap brightness, for relief legibility
    const elevationM = new Float32Array(pixels);
    const albedoField = new Float32Array(pixels);
    const inertiaField = new Float32Array(pixels);

    // Per-row (latitude) caches.
    const sinProduct = new Float32Array(height);
    const cosProduct = new Float32Array(height);
    const noonCosZenith = new Float32Array(height);

    // Per-column (longitude) scratch, refilled on every paint. Allocated once:
    // paint() runs on every scrubber tick, and a fresh Float32Array per tick is
    // garbage the collector has to chase during the one interaction that has to
    // stay smooth.
    const cosHour = new Float32Array(width);
    const sinHour = new Float32Array(width);

    // RGBA, row 0 at latitude −90. This matches js/mars-view.js's latLonUv,
    // which maps v = (lat+90)/180 and u = (lon+180)/360 — get the row order
    // wrong and the map renders vertically mirrored, which reads as plausible
    // (the poles are cold either way) until you notice the seasons inverted.
    const rgba = new Uint8Array(pixels * 4);

    const latAt = (y) => -90 + (y + 0.5) / height * 180;
    const lonAt = (x) => -180 + (x + 0.5) / width * 360;

    let terrainSampled = false;
    const state = {
        lsDeg: null, opacity: null, eotHours: 0, field: null,
        extremes: null, prepareMs: 0, paintMs: 0,
    };

    /** Sample the rasters once. Elevation and albedo do not move with season. */
    function sampleTerrain() {
        for (let y = 0; y < height; y += 1) {
            const lat = latAt(y);
            for (let x = 0; x < width; x += 1) {
                const index = y * width + x;
                const lon = lonAt(x);
                elevationM[index] = elevationAt ? elevationAt(lat, lon) : 0;
                if (brightnessAt) {
                    const brightness = Math.min(1, Math.max(0, brightnessAt(lat, lon)));
                    shade[index] = brightness;
                    albedoField[index] = albedoFromRelativeBrightness(brightness);
                } else {
                    shade[index] = 0.5;
                    albedoField[index] = defaultAlbedo;
                }
                inertiaField[index] = thermalInertiaFromAlbedo(albedoField[index]);
            }
        }
        terrainSampled = true;
    }

    /**
     * Season pass. Everything cached here is independent of time of day, which
     * is what makes the scrubber cheap. Call on Ls or opacity change only.
     */
    function prepare(lsDeg, opacity = null) {
        const tau = opacity == null ? dustOpacity(lsDeg) : opacity;
        if (state.lsDeg === lsDeg && state.opacity === tau && terrainSampled) return false;
        const started = (typeof performance !== 'undefined' ? performance : Date).now();
        if (!terrainSampled) sampleTerrain();

        state.lsDeg = lsDeg;
        state.opacity = tau;
        state.eotHours = equationOfTimeHours(lsDeg);

        for (let y = 0; y < height; y += 1) {
            const lat = latAt(y);
            const sky = insolationHarmonics(lat, lsDeg);
            sinProduct[y] = sky.sinProduct;
            cosProduct[y] = sky.cosProduct;
            noonCosZenith[y] = sky.noonCosZenith;
            for (let x = 0; x < width; x += 1) {
                const index = y * width + x;
                // columnProfile, not surfaceClimate: every quantity cached here
                // is time-independent, and the full call would additionally
                // compute density, sound speed, insolation and solar elevation
                // — all discarded — for each of 131 k pixels.
                const profile = columnProfile({
                    latDeg: lat,
                    elevationM: elevationM[index],
                    lsDeg,
                    albedo: albedoField[index],
                    thermalInertia: inertiaField[index],
                    opacity: tau,
                    harmonics: sky,
                });
                pressurePa[index] = profile.pressurePa;
                frostPointK[index] = profile.frostPointK;
                meanK[index] = profile.meanSurfaceTempK;
                amplitudeK[index] = profile.diurnalAmplitudeK;
                columnK[index] = profile.columnTempK;
                cosLag[index] = Math.cos(profile.lagRad);
                sinLag[index] = Math.sin(profile.lagRad);
            }
        }
        state.prepareMs = (typeof performance !== 'undefined' ? performance : Date).now() - started;
        return true;
    }

    /**
     * Time pass. `mtcHours` is Mars Coordinated Time — the same clock
     * js/mars-mission-state.js already computes — so local mean solar time is
     * mtc + lon/15 and the equation-of-time correction is a single scalar.
     */
    function paint(fieldId, mtcHours) {
        const field = CLIMATE_FIELDS[fieldId] || CLIMATE_FIELDS['surface-temp'];
        const lut = RAMP_LUTS.get(field.id);
        const started = (typeof performance !== 'undefined' ? performance : Date).now();
        const [lo, hi] = field.range;
        const invSpan = 255 / (hi - lo);
        // Planet-wide extremes of the field as painted. Two comparisons per
        // pixel, and they carry the headline the map exists to make — the
        // Hellas-to-Olympus pressure range, the day/night temperature span.
        let fieldMin = Infinity;
        let fieldMax = -Infinity;
        let minLat = 0;
        let minLon = 0;
        let maxLat = 0;
        let maxLon = 0;

        // Hour angle depends only on longitude, so its sine and cosine are
        // per-COLUMN quantities. Computing them per pixel is the obvious way to
        // write this and costs width×height transcendentals instead of width —
        // a 256× difference on the one path that has to keep up with a drag.
        for (let x = 0; x < width; x += 1) {
            const hour = (mtcHours + lonAt(x) / 15 + state.eotHours - 12) * 15 * DEG;
            cosHour[x] = Math.cos(hour);
            sinHour[x] = Math.sin(hour);
        }

        for (let y = 0; y < height; y += 1) {
            const rowSin = sinProduct[y];
            const rowCos = cosProduct[y];
            const rowNoon = noonCosZenith[y];
            const rowOffset = y * width;
            for (let x = 0; x < width; x += 1) {
                const index = rowOffset + x;
                // cos(h − lag) expanded so the per-pixel lag stays a cached pair.
                const wave = cosHour[x] * cosLag[index] + sinHour[x] * sinLag[index];
                const frost = frostPointK[index];
                let surfaceK = meanK[index] + amplitudeK[index] * wave;
                if (surfaceK < frost) surfaceK = frost;

                let value;
                if (field.id === 'pressure') {
                    value = pressurePa[index];
                } else if (field.id === 'frost') {
                    value = surfaceK - frost;
                } else if (field.id === 'air-temp') {
                    const cosZenith = rowSin + rowCos * cosHour[x];
                    const daylight = rowNoon > 0 ? Math.min(1, Math.max(0, cosZenith / rowNoon)) : 0;
                    const coupling = AIR_COUPLING_NIGHT + (AIR_COUPLING_DAY - AIR_COUPLING_NIGHT) * daylight;
                    const column = columnK[index];
                    value = Math.max(frost, column + coupling * (surfaceK - column));
                } else {
                    value = surfaceK;
                }

                if (value < fieldMin) { fieldMin = value; minLat = latAt(y); minLon = lonAt(x); }
                if (value > fieldMax) { fieldMax = value; maxLat = latAt(y); maxLon = lonAt(x); }

                let bin = (value - lo) * invSpan;
                bin = bin < 0 ? 0 : (bin > 255 ? 255 : bin) | 0;
                // Faint basemap shading under the field so terrain stays
                // legible. Kept weak on purpose — strong enough to read relief,
                // too weak to be mistaken for a second data channel.
                const relief = 0.84 + 0.32 * shade[index];
                const out = index * 4;
                const lutOffset = bin * 3;
                rgba[out] = Math.min(255, lut[lutOffset] * relief);
                rgba[out + 1] = Math.min(255, lut[lutOffset + 1] * relief);
                rgba[out + 2] = Math.min(255, lut[lutOffset + 2] * relief);
                rgba[out + 3] = 255;
            }
        }
        state.paintMs = (typeof performance !== 'undefined' ? performance : Date).now() - started;
        state.field = field.id;
        state.extremes = {
            min: fieldMin, max: fieldMax,
            minAt: { latDeg: minLat, lonDeg: minLon },
            maxAt: { latDeg: maxLat, lonDeg: maxLon },
        };
        return rgba;
    }

    /**
     * One point, full kernel, no caches — for the readouts. The map is a
     * quantized 512×256 grid; a readout must not inherit that quantization,
     * so this goes straight to the raster samplers and the kernel.
     */
    function sampleAt(latDeg, lonDeg, mtcHours, { lsDeg = state.lsDeg, opacity = state.opacity } = {}) {
        const elevation = elevationAt ? elevationAt(latDeg, lonDeg) : 0;
        const brightness = brightnessAt ? Math.min(1, Math.max(0, brightnessAt(latDeg, lonDeg))) : null;
        const albedo = brightness == null ? defaultAlbedo : albedoFromRelativeBrightness(brightness);
        const localMean = (mtcHours + lonDeg / 15 + 24) % 24;
        const point = surfaceClimate({
            latDeg,
            lonDeg,
            elevationM: elevation,
            lsDeg,
            localTrueSolarTime: (localMean + equationOfTimeHours(lsDeg) + 24) % 24,
            albedo,
            thermalInertia: thermalInertiaFromAlbedo(albedo),
            opacity,
        });
        return { ...point, localMeanSolarTime: localMean, albedoIsProxy: brightness != null };
    }

    return {
        width,
        height,
        /** The RGBA buffer the caller wraps in a texture. Stable identity —
         *  paint() writes into it in place, so a DataTexture built over it once
         *  stays valid for the life of the field. */
        pixels: rgba,
        prepare,
        paint,
        sampleAt,
        /** Timing, for the smoke test and for anyone tempted to move work
         *  across the prepare/paint line. */
        timings: () => ({ prepareMs: state.prepareMs, paintMs: state.paintMs }),
        seasonState: () => ({
            lsDeg: state.lsDeg, opacity: state.opacity,
            eotHours: state.eotHours, field: state.field,
        }),
        /** Planet-wide min/max of the last painted field, with where each
         *  landed. Recomputed inside paint, so it always describes the frame
         *  currently on screen rather than a cached earlier one. */
        extremes: () => state.extremes,
    };
}

/** Formatting helpers the page and its tests share. */
export const formatK = (k) => `${(k - 273.15).toFixed(1)} °C`;
export const formatPa = (pa) => (pa >= 1000 ? `${(pa / 1000).toFixed(2)} kPa` : `${pa.toFixed(0)} Pa`);
export const formatDensity = (rho) => `${(rho * 1000).toFixed(1)} g/m³`;
