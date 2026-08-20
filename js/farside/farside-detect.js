/**
 * js/farside/farside-detect.js — classical far-side signature detector.
 *
 * Phase 2 baseline: threshold + connected-component blob detection on the
 * phase-shift map. Deliberately NOT ML — this is the fast, transparent,
 * always-explainable baseline that the ML detector (Felipe & Asensio Ramos
 * style, trained on Earth-side regions) layers on top of later. The public
 * `detectSignatures()` signature is stable so the ML scorer can be slotted in
 * behind the same contract without touching callers.
 *
 * Input is a normalized z-score map (negative = signature, see farside-feed).
 * Output is a list of detections in Carrington coordinates with a strength
 * and a confidence score in [0,1].
 *
 * LONGITUDE IS AN ANGLE, and every reduction over it here has to treat it as
 * one. The flood fill has always wrapped across the 0deg/360deg seam, but the
 * centroid used to be a plain weighted mean of column indices: a region
 * straddling the seam has columns near 355 AND near 5, whose arithmetic mean
 * is ~180 -- the far side of the Sun from where the region actually is. That
 * produced a real detection at a longitude up to 180deg wrong, and therefore
 * an east-limb emergence forecast wrong by up to half a rotation (~13.6 d),
 * silently, for any region near Carrington longitude 0. Centroid and bbox are
 * both computed circularly now. tests/farside-detect.mjs pins it.
 */

import { DETECT } from './farside-config.js';
import { wrap180, wrap360 } from './carrington.js';

const DEG = Math.PI / 180;

/**
 * @typedef {Object} Detection
 * @property {number} lon   Carrington longitude of centroid (deg, [0,360))
 * @property {number} lat   Heliographic latitude of centroid (deg)
 * @property {number} areaDeg2     blob area (deg²)
 * @property {number} peak         peak |z| within the blob
 * @property {number} strength     integrated |z| over area, /100 (callout scale)
 * @property {number} confidence   [0,1] heuristic detector confidence
 * @property {{lon0:number,lon1:number,lat0:number,lat1:number}} bbox
 */

/**
 * Detect negative-phase signatures in a FarSideMap.
 * @param {object} map  FarSideMap from farside-feed
 * @param {object} [opts] override DETECT thresholds
 * @returns {Detection[]} sorted strongest-first
 */
export function detectSignatures(map, opts = {}) {
    const o = { ...DETECT, ...opts };
    const { nLon, nLat, latMin } = map.grid;
    const data = map.data;

    // Pixels darker than -sigma and within the active-region latitude belt.
    const flagged = new Uint8Array(nLon * nLat);
    for (let row = 0; row < nLat; row++) {
        const lat = latMin + row;
        if (Math.abs(lat) > o.maxLatDeg) continue;
        const base = row * nLon;
        for (let col = 0; col < nLon; col++) {
            if (data[base + col] <= -o.sigma) flagged[base + col] = 1;
        }
    }

    // Connected components (4-connectivity), wrapping in longitude.
    const visited = new Uint8Array(nLon * nLat);
    const stack = [];
    const blobs = [];
    const idx = (c, r) => r * nLon + c;

    for (let row = 0; row < nLat; row++) {
        for (let col = 0; col < nLon; col++) {
            const start = idx(col, row);
            if (!flagged[start] || visited[start]) continue;

            // BFS/DFS flood fill.
            stack.length = 0;
            stack.push([col, row]);
            visited[start] = 1;
            let area = 0, peak = 0, sum = 0;
            // Strength-weighted centroid. Longitude accumulates as a unit
            // vector (cos, sin) so the mean is circular; latitude is linear
            // because it genuinely is (no seam at the poles for a belt-limited
            // detector).
            let sCos = 0, sSin = 0, sy = 0, sw = 0;
            let firstCol = col, lat0 = 90, lat1 = -90;
            let dLonMin = 0, dLonMax = 0;   // bbox as an offset from firstCol

            while (stack.length) {
                const [c, r] = stack.pop();
                const here = idx(c, r);
                const z = -data[here]; // positive magnitude
                area += 1;
                sum += z;
                if (z > peak) peak = z;
                const lat = latMin + r;
                const a = c * DEG;
                sCos += Math.cos(a) * z; sSin += Math.sin(a) * z;
                sy += lat * z; sw += z;
                // bbox: track the signed offset from the blob's first column,
                // so a seam-crossing blob reports [355, 5] rather than [0, 359].
                const d = wrap180(c - firstCol);
                if (d < dLonMin) dLonMin = d; if (d > dLonMax) dLonMax = d;
                if (lat < lat0) lat0 = lat; if (lat > lat1) lat1 = lat;

                // 4-neighbours, wrapping longitude.
                const nb = [
                    [(c + 1) % nLon, r],
                    [(c - 1 + nLon) % nLon, r],
                    [c, r + 1],
                    [c, r - 1],
                ];
                for (const [nc, nr] of nb) {
                    if (nr < 0 || nr >= nLat) continue;
                    const ni = idx(nc, nr);
                    if (flagged[ni] && !visited[ni]) { visited[ni] = 1; stack.push([nc, nr]); }
                }
            }

            if (area < o.minAreaDeg2) continue; // reject specks

            blobs.push({
                lon: wrap360(Math.atan2(sSin, sCos) / DEG),
                lat: sy / sw,
                areaDeg2: area,
                peak,
                strength: sum / 100,
                bbox: {
                    lon0: wrap360(firstCol + dLonMin),
                    lon1: wrap360(firstCol + dLonMax),
                    lat0, lat1,
                },
            });
        }
    }

    // Confidence: larger + deeper signatures are more trustworthy. Squashed to
    // [0,1] with a soft logistic on (peak·√area). Tunable; the ML scorer will
    // replace this term with a learned probability.
    for (const b of blobs) {
        const x = b.peak * Math.sqrt(b.areaDeg2) / 12;
        b.confidence = 1 / (1 + Math.exp(-(x - 2.2)));
    }

    return blobs.sort((a, b) => b.strength - a.strength);
}

/** True if a detection clears the "strong, flare-watch-worthy" bar. */
export function isStrong(detection) {
    return detection.strength >= DETECT.strongStrength && detection.confidence >= 0.5;
}
