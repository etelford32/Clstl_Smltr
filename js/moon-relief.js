/**
 * moon-relief.js — real displaced relief for the Moon page.
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE module (node-gated by tests/moon-relief.mjs): no three.js import — the
 * geometry displacement below duck-types BufferGeometry so the whole file
 * runs under node. The only DOM entry point is reliefSamplerFromImage's
 * canvas readback, and it takes an injectable canvas factory like
 * moon-terrain-synth's albedo sampler does.
 *
 * What this is, honestly: the Moon page's sphere was geometrically SMOOTH —
 * every visible mountain was shader fakery that collapses at close range and
 * never parallaxes. This module reads the page's LRO-derived bump map back
 * into an elevation field and displaces the real vertices with it. The gray
 * levels of that raster are UNCALIBRATED, so they are mapped onto the Moon's
 * true hypsometric span (−9.1 km Antoniadi floor → +10.8 km Selenean summit)
 * as a NOMINAL scale — good enough to draw honest-shaped terrain, never
 * quoted as a per-site elevation readout. The drawn exaggeration is separate
 * and disclosed in the UI. If the raster cannot be read back (CORS taint,
 * aborted load, fallback texture), the page keeps the smooth sphere — the
 * relief layer refuses to invent terrain with nothing measured to seed it.
 *
 * Every ground-anchored layer (landmark rings/dots, landing-site markers,
 * the lat/lon graticule) re-seats through the SAME radiusAt this module
 * produces — the Mars page's anchorRadiusAtLatLon lesson: one radius
 * function, shared by everything, or markers float again.
 */

export const MOON_RADIUS_KM = 1737.4;
export const MOON_RELIEF_MIN_M = -9100;    // Antoniadi crater floor
export const MOON_RELIEF_MAX_M = 10800;    // Selenean summit
export const MOON_RELIEF_EXAGGERATION = 4; // drawn scale, disclosed in the UI

const DEG = Math.PI / 180;

/**
 * Elevation sampler over a grayscale equirectangular raster.
 * @param {Uint8ClampedArray|Uint8Array} pixels  RGBA, length w*h*4
 * @param {number} width
 * @param {number} height
 * @returns {{ elevationAt(latDeg, lonDeg): number, width, height }} metres
 *          (nominal — see header), bilinear, longitude wraps, latitude clamps.
 */
export function reliefSamplerFromPixels(pixels, width, height) {
    if (!width || !height || pixels.length < width * height * 4) {
        throw new Error('reliefSamplerFromPixels: bad raster');
    }
    const grayAt = (x, y) => {
        const i = (y * width + x) * 4;
        return pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
    };
    const span = MOON_RELIEF_MAX_M - MOON_RELIEF_MIN_M;
    return {
        width,
        height,
        elevationAt(latDeg, lonDeg) {
            const u = ((((lonDeg + 180) / 360) % 1) + 1) % 1;
            const v = Math.min(1, Math.max(0, (90 - latDeg) / 180));
            const x = u * (width - 1);
            const y = v * (height - 1);
            const x0 = Math.floor(x);
            const y0 = Math.floor(y);
            const x1 = (x0 + 1) % width;                     // lon wraps
            const y1 = Math.min(y0 + 1, height - 1);         // lat clamps
            const tx = x - x0;
            const ty = y - y0;
            const top = grayAt(x0, y0) * (1 - tx) + grayAt(x1, y0) * tx;
            const bottom = grayAt(x0, y1) * (1 - tx) + grayAt(x1, y1) * tx;
            const gray = top * (1 - ty) + bottom * ty;
            return MOON_RELIEF_MIN_M + (gray / 255) * span;
        },
    };
}

/**
 * Canvas readback wrapper. Returns null when the image cannot be read
 * (cross-origin taint, decode failure, 1×1 fallback texture) — callers keep
 * the smooth sphere and say nothing untrue.
 */
export function reliefSamplerFromImage(image, makeCanvas = () => document.createElement('canvas')) {
    try {
        const w = Math.min(1024, image.width || 0);
        const h = Math.max(1, Math.round(w * (image.height / image.width)));
        if (!w || w < 4) return null;
        const cv = makeCanvas();
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);       // throws if tainted
        return reliefSamplerFromPixels(data, w, h);
    } catch {
        return null;
    }
}

/**
 * The ONE radius function every anchored layer shares:
 * unit-sphere radius at (lat, lon) with the drawn exaggeration applied.
 */
export function radiusAtFactory(sampler, exaggeration = MOON_RELIEF_EXAGGERATION) {
    const scale = exaggeration / (MOON_RADIUS_KM * 1000);
    return (latDeg, lonDeg) => 1 + sampler.elevationAt(latDeg, lonDeg) * scale;
}

/**
 * Displace a unit-sphere BufferGeometry's vertices to radiusAt(lat, lon).
 * Duck-typed (attributes.position + computeVertexNormals) so the node gate
 * can drive it without three.js. The ORIGINAL positions are stashed on the
 * geometry's userData the first time, so displacement is idempotent and
 * restoreSphereGeometry can put the smooth sphere back exactly.
 * @returns {{ minRadius, maxRadius }}
 */
export function displaceSphereGeometry(geometry, radiusAt) {
    const position = geometry.attributes.position;
    geometry.userData = geometry.userData || {};
    if (!geometry.userData.moonReliefBase) {
        geometry.userData.moonReliefBase = position.array.slice();
    }
    const base = geometry.userData.moonReliefBase;
    let minRadius = Infinity;
    let maxRadius = -Infinity;
    for (let i = 0; i < position.count; i += 1) {
        const x = base[i * 3];
        const y = base[i * 3 + 1];
        const z = base[i * 3 + 2];
        const len = Math.hypot(x, y, z) || 1;
        const latDeg = Math.asin(Math.min(1, Math.max(-1, y / len))) / DEG;
        const lonDeg = Math.atan2(-z, x) / DEG;
        const r = radiusAt(latDeg, lonDeg);
        if (r < minRadius) minRadius = r;
        if (r > maxRadius) maxRadius = r;
        const s = r / len;
        position.array[i * 3] = x * s;
        position.array[i * 3 + 1] = y * s;
        position.array[i * 3 + 2] = z * s;
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals?.();
    geometry.computeBoundingSphere?.();
    return { minRadius, maxRadius };
}

/** Put the smooth sphere back exactly (no-op if never displaced). */
export function restoreSphereGeometry(geometry) {
    const base = geometry.userData?.moonReliefBase;
    if (!base) return false;
    geometry.attributes.position.array.set(base);
    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals?.();
    geometry.computeBoundingSphere?.();
    return true;
}
