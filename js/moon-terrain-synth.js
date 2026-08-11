/**
 * moon-terrain-synth.js — WFC regional terrain synthesis for the Moon page.
 * ═══════════════════════════════════════════════════════════════════════════
 * Sits between the generic WFC kernel (js/terrain-wfc.js, node-gated) and
 * moon.html. Everything above drawSynthMap() is PURE — no DOM, no three.js —
 * and is gated by tests/moon-terrain-synth.mjs. drawSynthMap() takes a canvas
 * the page owns and only paints numbers the pure layer produced.
 *
 * What it synthesizes, honestly: a geologic CLASS map of the region around a
 * named landmark — mare basalt vs highlands vs rims/ejecta/rilles/swirls —
 * with per-cell priors MEASURED from the page's loaded LRO base map (albedo
 * sampled at each cell's IAU coordinates). When the texture cannot be read
 * back (CORS taint, load failure) the fallback classifier derives albedo from
 * the landmark catalog itself: inside a mare's true-extent circle is dark,
 * outside is highland-bright. Both paths are DISCLOSED via `provenance` and
 * the page prints it under the map. The output is a synthesis, labelled as
 * such — never a photograph of anything.
 *
 * Geologic context feeding the priors (all from moon-landmarks-data.js, the
 * IAU-pinned catalog):
 *   • craterDistNorm — distance to the nearest cataloged crater in units of
 *     that crater's radius → rim class peaks ON the rim, ejecta just outside.
 *   • swirlBoost — proximity to a cataloged swirl (Reiner Gamma) → the swirl
 *     class is allowed to exist, and ONLY over dark maria (kernel rule).
 */

import {
    MOON_TILESET, collapse, moonClassPriors, expandClassPriors, regionSeed,
    regionGrid, localOffsetKm, sampleClassInto, classShares,
} from './terrain-wfc.js';
import { LANDMARKS } from './moon-landmarks-data.js';
import { R_MOON_KM } from './moon-interior-model.js';

export const MOON_SYNTH_CELLS = 48;

const DEG = Math.PI / 180;

/** Great-circle central angle between two IAU (lat, lon) points, in degrees. */
export function angularSeparationDeg(lat1, lon1, lat2, lon2) {
    const cosDelta = Math.sin(lat1 * DEG) * Math.sin(lat2 * DEG)
        + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon2 - lon1) * DEG);
    return Math.acos(Math.min(1, Math.max(-1, cosDelta))) / DEG;
}

const smooth = (a, b, v) => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

const MARIA = LANDMARKS.filter(l => l.category === 'mare');
const CRATERS = LANDMARKS.filter(l => l.category === 'crater');
const SWIRLS = LANDMARKS.filter(l => l.category === 'swirl');
const SPA = LANDMARKS.find(l => l.name === 'South Pole–Aitken basin');

/**
 * Fallback albedo (0..1) from the landmark catalog alone: highlands-bright
 * everywhere except inside the maria's true-extent circles (feathered edges),
 * with South Pole–Aitken's floor set mid-dark. Circles are a crude stand-in
 * for real mare outlines — which is exactly why `provenance` says which
 * albedo source fed the synth.
 */
export function fallbackAlbedoAt(latDeg, lonDeg) {
    let albedo = 0.62;                                    // feldspathic highlands
    if (SPA) {
        const radiusDeg = (SPA.diameterKm / 2) / R_MOON_KM / DEG;
        const d = angularSeparationDeg(latDeg, lonDeg, SPA.latDeg, SPA.lonDeg);
        albedo -= 0.12 * smooth(radiusDeg, radiusDeg * 0.75, d);
    }
    for (const mare of MARIA) {
        const radiusDeg = (mare.diameterKm / 2) / R_MOON_KM / DEG;
        const d = angularSeparationDeg(latDeg, lonDeg, mare.latDeg, mare.lonDeg);
        const inside = smooth(radiusDeg * 1.04, radiusDeg * 0.86, d);   // ~15% feather
        albedo = albedo * (1 - inside) + 0.27 * inside;
    }
    return albedo;
}

/**
 * Albedo sampler from the page's loaded equirectangular base-map image.
 * Returns an `albedoAt(latDeg, lonDeg)` or null when the pixels cannot be
 * read (cross-origin taint, decode failure) — the caller then falls back to
 * fallbackAlbedoAt and says so. Sampling convention matches the sphere UV:
 * u = (lon+180)/360 (east-positive), v = 0 at the NORTH pole of the image.
 */
export function albedoSamplerFromImage(image, makeCanvas = () => document.createElement('canvas')) {
    try {
        const w = Math.min(1024, image.width || 0);
        const h = Math.max(1, Math.round(w / 2));
        if (!w) return null;
        const cv = makeCanvas();
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0, w, h);
        const pixels = ctx.getImageData(0, 0, w, h).data;   // throws if tainted
        return (latDeg, lonDeg) => {
            const u = ((((lonDeg + 180) / 360) % 1) + 1) % 1;
            const v = Math.min(1, Math.max(0, (90 - latDeg) / 180));
            const x = Math.min(w - 1, Math.round(u * (w - 1)));
            const y = Math.min(h - 1, Math.round(v * (h - 1)));
            const i = (y * w + x) * 4;
            return (pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722) / 255;
        };
    } catch {
        return null;
    }
}

/** Map extent for a feature: room around it, clamped to honest map sizes. */
export function extentForLandmark(landmark) {
    return Math.min(1200, Math.max(240, landmark.diameterKm * 2.4));
}

/**
 * Synthesize the region around a cataloged landmark.
 * @param {object} landmark   entry from moon-landmarks-data.js
 * @param {object} [opts]     { albedoAt = fallbackAlbedoAt, saltSeed = 0 }
 * @returns {{ result, region, shares, extentKm, provenance, landmark }}
 */
export function synthesizeLandmarkRegion(landmark, { albedoAt = null, saltSeed = 0 } = {}) {
    const measured = typeof albedoAt === 'function';
    const sampleAlbedo = measured ? albedoAt : fallbackAlbedoAt;
    const extentKm = extentForLandmark(landmark);
    const cells = MOON_SYNTH_CELLS;
    const region = regionGrid({
        centerLatDeg: landmark.latDeg, centerLonDeg: landmark.lonDeg,
        extentKm, cells, radiusKm: R_MOON_KM,
    });
    const tileCount = MOON_TILESET.tiles.length;
    const priors = new Float32Array(cells * cells * tileCount);
    for (let i = 0; i < cells * cells; i += 1) {
        const lat = region.latDeg[i];
        const lon = region.lonDeg[i];
        let craterDistNorm = Infinity;
        for (const crater of CRATERS) {
            const radiusDeg = (crater.diameterKm / 2) / R_MOON_KM / DEG;
            const norm = angularSeparationDeg(lat, lon, crater.latDeg, crater.lonDeg) / radiusDeg;
            if (norm < craterDistNorm) craterDistNorm = norm;
        }
        let swirlBoost = 0;
        for (const swirl of SWIRLS) {
            const radiusDeg = (swirl.diameterKm / 2) / R_MOON_KM / DEG;
            const norm = angularSeparationDeg(lat, lon, swirl.latDeg, swirl.lonDeg) / radiusDeg;
            swirlBoost = Math.max(swirlBoost, smooth(2.2, 0.9, norm));
        }
        // Class-ordered priors expand onto the tile variants (the rille and
        // wrinkle families' segments/bends/ends inherit their class priors).
        expandClassPriors(
            MOON_TILESET,
            moonClassPriors({ albedo: sampleAlbedo(lat, lon), latDeg: lat, craterDistNorm, swirlBoost }),
            priors,
            i,
        );
    }
    const result = collapse({
        tileset: MOON_TILESET, width: cells, height: cells,
        seed: regionSeed('moon', landmark.latDeg, landmark.lonDeg, saltSeed), priors,
    });
    return {
        result,
        region,
        extentKm,
        shares: classShares(result),
        provenance: measured
            ? 'albedo: LRO base map, sampled at IAU coordinates'
            : 'albedo: landmark-catalog fallback (base map unreadable)',
        landmark,
    };
}

/** Legend rows for the page: visible classes, largest share first. */
export function synthLegend(shares) {
    return MOON_TILESET.classes
        .map(cls => ({ id: cls.id, label: cls.label, color: cls.color, share: shares[cls.id] || 0 }))
        .filter(row => row.share > 0.004)
        .sort((a, b) => b.share - a.share);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Canvas painter — DOM below this line only.
// ═══════════════════════════════════════════════════════════════════════════

/** Deterministic per-pixel hash for regolith dither (no Math.random). */
function pixelHash(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (((h ^ (h >>> 16)) >>> 0) % 1000) / 1000;
}

/** Pick a graticule step (degrees) that gives 3–7 lines across the span. */
function graticuleStepDeg(spanDeg) {
    for (const step of [0.5, 1, 2, 5, 10, 15, 30]) {
        if (spanDeg / step <= 7) return step;
    }
    return 45;
}

/**
 * Paint a synthesized region onto a 2D canvas: class map with soft geologic
 * contacts + grain dither, an ACCURATE lat/lon graticule (drawn through the
 * same great-circle mapping that laid out the cells), the feature's own
 * true-extent ring, a scale bar, and a north arrow.
 */
export function drawSynthMap(synth, canvas) {
    const { result, extentKm, landmark } = synth;
    const size = canvas.width;                       // square backing store
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(size, size);
    const px = image.data;
    const sample = { color: [0, 0, 0], reliefAmpM: 0, grain: 0, tileIndex: 0 };
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            sampleClassInto(result, x / (size - 1), y / (size - 1), sample);
            const dither = (pixelHash(x, y) - 0.5) * 0.08 * (0.5 + sample.grain * 0.5);
            const i = (y * size + x) * 4;
            px[i] = Math.max(0, Math.min(255, (sample.color[0] + dither) * 255));
            px[i + 1] = Math.max(0, Math.min(255, (sample.color[1] + dither) * 255));
            px[i + 2] = Math.max(0, Math.min(255, (sample.color[2] + dither) * 255));
            px[i + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);

    const kmToPx = size / extentKm;
    const toPx = (eastKm, northKm) => ({
        x: size / 2 + eastKm * kmToPx,
        y: size / 2 - northKm * kmToPx,
    });

    // Accurate graticule: constant-lat / constant-lon lines pushed through the
    // inverse of the exact great-circle layout the cells used.
    const spanDeg = extentKm / R_MOON_KM / DEG;
    const step = graticuleStepDeg(spanDeg);
    ctx.strokeStyle = 'rgba(150, 180, 220, 0.30)';
    ctx.fillStyle = 'rgba(170, 195, 225, 0.75)';
    ctx.lineWidth = 1;
    ctx.font = '9px system-ui, sans-serif';
    const latMin = landmark.latDeg - spanDeg * 0.62;
    const latMax = landmark.latDeg + spanDeg * 0.62;
    const lonSpan = spanDeg / Math.max(0.15, Math.cos(landmark.latDeg * DEG));
    const drawIsoline = (fixed, isLat) => {
        ctx.beginPath();
        let started = false;
        for (let f = -0.62; f <= 0.62; f += 0.02) {
            const lat = isLat ? fixed : landmark.latDeg + spanDeg * f;
            const lon = isLat ? landmark.lonDeg + lonSpan * f : fixed;
            const { eastKm, northKm } = localOffsetKm(landmark.latDeg, landmark.lonDeg, lat, lon, R_MOON_KM);
            const p = toPx(eastKm, northKm);
            if (p.x < -40 || p.x > size + 40 || p.y < -40 || p.y > size + 40) continue;
            if (started) ctx.lineTo(p.x, p.y); else { ctx.moveTo(p.x, p.y); started = true; }
        }
        ctx.stroke();
    };
    for (let lat = Math.ceil(latMin / step) * step; lat <= latMax; lat += step) {
        drawIsoline(lat, true);
        const at = localOffsetKm(landmark.latDeg, landmark.lonDeg, lat, landmark.lonDeg, R_MOON_KM);
        const p = toPx(at.eastKm, at.northKm);
        if (p.y > 10 && p.y < size - 4) {
            ctx.fillText(`${Math.abs(lat).toFixed(step < 1 ? 1 : 0)}°${lat >= 0 ? 'N' : 'S'}`, 3, p.y - 2);
        }
    }
    const lonMin = landmark.lonDeg - lonSpan * 0.62;
    const lonMax = landmark.lonDeg + lonSpan * 0.62;
    for (let lon = Math.ceil(lonMin / step) * step; lon <= lonMax; lon += step) {
        drawIsoline(lon, false);
        const at = localOffsetKm(landmark.latDeg, landmark.lonDeg, landmark.latDeg, lon, R_MOON_KM);
        const p = toPx(at.eastKm, at.northKm);
        const lonLabel = ((lon + 540) % 360) - 180;
        if (p.x > 14 && p.x < size - 26) {
            ctx.fillText(`${Math.abs(lonLabel).toFixed(step < 1 ? 1 : 0)}°${lonLabel >= 0 ? 'E' : 'W'}`, p.x + 2, size - 4);
        }
    }

    // The feature's own true-extent ring, centred on the map.
    ctx.strokeStyle = 'rgba(255, 230, 160, 0.75)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, (landmark.diameterKm / 2) * kmToPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Scale bar (nice round km) + north arrow.
    const targetKm = extentKm / 4;
    const barKm = [10, 20, 50, 100, 200, 300, 500][
        [10, 20, 50, 100, 200, 300, 500].findIndex(v => v >= targetKm) === -1
            ? 6
            : [10, 20, 50, 100, 200, 300, 500].findIndex(v => v >= targetKm)
    ];
    const barPx = barKm * kmToPx;
    ctx.strokeStyle = 'rgba(235, 240, 250, 0.9)';
    ctx.fillStyle = 'rgba(235, 240, 250, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(size - 12 - barPx, size - 14);
    ctx.lineTo(size - 12, size - 14);
    ctx.stroke();
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText(`${barKm} km`, size - 12 - barPx, size - 19);
    ctx.beginPath();
    ctx.moveTo(size - 14, 22);
    ctx.lineTo(size - 18, 32);
    ctx.lineTo(size - 14, 29);
    ctx.lineTo(size - 10, 32);
    ctx.closePath();
    ctx.fill();
    ctx.fillText('N', size - 17, 16);
}
