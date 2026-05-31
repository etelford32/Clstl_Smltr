/**
 * weather-orography.js — terrain-gradient field for orographic uplift
 *
 * Companion to the convergence-growth microphysics in weather-flow.js. Air
 * blowing UPSLOPE against terrain is forced to rise (orographic lift) → it
 * cools, condenses, and rains on the windward side; on the lee side it
 * descends and dries (the rain shadow). The forecaster models that as an
 * additive uplift term U·∇h, so it needs the terrain GRADIENT on the same
 * coarse grid as the forecast frames.
 *
 * buildTerrainGradient() turns a height sampler (any (lat,lon)→[0,1] elevation
 * function — in the app, the Blue-Marble topology heightmap read back to a
 * canvas) into { gridW, gridH, dhdx, dhdy }, the field WindAdvectionRK2-
 * Forecaster.setTerrain() consumes. dhdx/dhdy are normalised-height per metre
 * so U·∇h comes out in s⁻¹, directly commensurate with wind convergence.
 *
 * Ocean is masked to zero slope: the topology ramp encodes bathymetry too, and
 * sea-floor relief must not fabricate "orographic" rain over open water.
 *
 * Coordinate convention is lockstep with weather-flow.js: row 0 = 90°S, lat
 * ascending; lon in [-180, 180). Both helpers are pure and side-effect free.
 */

import { latOfRow, lonOfColumn } from './weather-flow.js';

const M_PER_DEG_LAT = 111_320;

/**
 * Build a per-cell terrain-gradient field for orographic uplift.
 *
 * @param {object} opts
 * @param {(lat:number, lon:number)=>number} opts.heightSampler  Normalised
 *        elevation [0,1] at a geographic point. Must tolerate any lon (it is
 *        pre-wrapped to [-180,180) here) and lat in [-90,90].
 * @param {number} opts.gridW
 * @param {number} opts.gridH
 * @param {number} [opts.seaLevel=0.18]  Normalised-height threshold below which
 *        a cell is treated as ocean (zero slope). Tunable to the heightmap.
 * @returns {{ gridW:number, gridH:number, dhdx:Float32Array, dhdy:Float32Array }}
 */
export function buildTerrainGradient({ heightSampler, gridW, gridH, seaLevel = 0.18 }) {
    const dhdx = new Float32Array(gridW * gridH);
    const dhdy = new Float32Array(gridW * gridH);
    if (typeof heightSampler !== 'function') return { gridW, gridH, dhdx, dhdy };

    const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
    const clampLat = (lat) => Math.max(-90, Math.min(90, lat));

    const dLonDeg = (360 / gridW) * 0.5;   // half-cell finite-difference step
    const dLatDeg = (180 / gridH) * 0.5;
    const dyM     = (2 * dLatDeg) * M_PER_DEG_LAT;

    for (let j = 0; j < gridH; j++) {
        const lat    = latOfRow(j, gridH);
        const cosLat = Math.max(0.05, Math.abs(Math.cos(lat * Math.PI / 180)));
        const dxM    = (2 * dLonDeg) * M_PER_DEG_LAT * cosLat;
        for (let i = 0; i < gridW; i++) {
            const lon = lonOfColumn(i, gridW);
            const hC  = heightSampler(clampLat(lat), wrapLon(lon));
            const k   = j * gridW + i;
            if (hC <= seaLevel) continue;     // ocean: leave slope at 0

            const hE = heightSampler(clampLat(lat), wrapLon(lon + dLonDeg));
            const hW = heightSampler(clampLat(lat), wrapLon(lon - dLonDeg));
            const hN = heightSampler(clampLat(lat + dLatDeg), wrapLon(lon));
            const hS = heightSampler(clampLat(lat - dLatDeg), wrapLon(lon));

            dhdx[k] = (hE - hW) / dxM;        // normalised height per metre
            dhdy[k] = (hN - hS) / dyM;
        }
    }
    return { gridW, gridH, dhdx, dhdy };
}

/**
 * Wrap a canvas ImageData (equirectangular elevation map, top row = 90°N,
 * left edge = 180°W) as a (lat,lon)→[0,1] height sampler. Reads the given
 * channel (default R) with nearest-pixel lookup — plenty for a coarse grid.
 *
 * @param {Uint8ClampedArray|Uint8Array} data  RGBA pixel bytes, length imgW·imgH·4.
 * @param {number} imgW
 * @param {number} imgH
 * @param {object} [opts]
 * @param {number} [opts.channel=0]  Byte offset within each RGBA pixel (0=R).
 * @returns {(lat:number, lon:number)=>number}
 */
export function makeHeightSamplerFromImageData(data, imgW, imgH, { channel = 0 } = {}) {
    return function heightSampler(lat, lon) {
        // Equirect: longitude → column (west→east), latitude → row (north→south).
        let x = Math.round((lon + 180) / 360 * (imgW - 1));
        let y = Math.round((90 - lat) / 180 * (imgH - 1));
        x = Math.max(0, Math.min(imgW - 1, x));
        y = Math.max(0, Math.min(imgH - 1, y));
        return data[(y * imgW + x) * 4 + channel] / 255;
    };
}

export default buildTerrainGradient;
