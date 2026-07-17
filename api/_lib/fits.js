/**
 * api/_lib/fits.js — minimal, dependency-free FITS reader for far-side maps.
 *
 * FITS is a simple format: an ASCII header in 2880-byte blocks (36 × 80-char
 * "cards") terminated by an END card, followed by big-endian binary data padded
 * to the next 2880-byte boundary. GONG / HMI far-side phase-shift maps are 2D
 * float images, which is all we need to decode here. Anything fancier (tables,
 * multiple HDUs, compression) is out of scope — the worker stores the raw bytes
 * in R2 for provenance regardless.
 *
 * Runs in both Node and edge runtimes (ArrayBuffer / DataView / TextDecoder only).
 */

const BLOCK = 2880;
const CARD = 80;

/** Parse the primary-HDU header into a plain object of typed values. */
export function parseHeader(buf) {
    const bytes = new Uint8Array(buf);
    const dec = new TextDecoder('ascii');
    const header = {};
    let offset = 0;
    let ended = false;

    while (offset + CARD <= bytes.length && !ended) {
        const card = dec.decode(bytes.subarray(offset, offset + CARD));
        offset += CARD;
        const key = card.slice(0, 8).trim();
        if (key === 'END') { ended = true; break; }
        if (!key || card[8] !== '=') continue; // comment / blank / HISTORY card

        let rest = card.slice(10);
        const slash = rest.indexOf('/');
        if (slash >= 0) rest = rest.slice(0, slash);
        rest = rest.trim();

        let val;
        if (rest.startsWith("'")) {
            val = rest.slice(1, rest.lastIndexOf("'")).trim();      // string
        } else if (rest === 'T' || rest === 'F') {
            val = rest === 'T';                                     // boolean
        } else if (rest.length) {
            const n = Number(rest);
            val = Number.isNaN(n) ? rest : n;                       // number
        }
        if (val !== undefined) header[key] = val;
    }

    // Header occupies a whole number of 2880-byte blocks.
    const dataOffset = Math.ceil(offset / BLOCK) * BLOCK;
    return { header, dataOffset, ended };
}

/**
 * Read a 2D float image from a FITS buffer. Applies BZERO/BSCALE and maps any
 * BLANK/NaN to 0. Returns physical-unit Float32 data, row-major.
 * @param {ArrayBuffer} buf
 * @returns {{ header:object, nx:number, ny:number, bitpix:number, data:Float32Array }}
 */
export function readFITS(buf) {
    const { header, dataOffset, ended } = parseHeader(buf);
    if (!ended) throw new Error('fits_header_unterminated');

    const bitpix = header.BITPIX;
    const naxis = header.NAXIS;
    const nx = header.NAXIS1;
    const ny = naxis >= 2 ? header.NAXIS2 : 1;
    if (!nx || !ny) throw new Error('fits_no_image_dims');

    const bscale = header.BSCALE ?? 1;
    const bzero = header.BZERO ?? 0;
    const blank = header.BLANK;

    const dv = new DataView(buf, dataOffset);
    const n = nx * ny;
    const out = new Float32Array(n);

    const read = readerFor(bitpix);
    const step = Math.abs(bitpix) / 8;
    if (dataOffset + n * step > buf.byteLength) throw new Error('fits_truncated_data');

    for (let i = 0; i < n; i++) {
        const raw = read(dv, i * step);
        if ((blank !== undefined && raw === blank) || Number.isNaN(raw)) { out[i] = 0; continue; }
        out[i] = bzero + bscale * raw;
    }
    return { header, nx, ny, bitpix, data: out };
}

function readerFor(bitpix) {
    switch (bitpix) {
        case 8:   return (dv, o) => dv.getUint8(o);
        case 16:  return (dv, o) => dv.getInt16(o, false);
        case 32:  return (dv, o) => dv.getInt32(o, false);
        case -32: return (dv, o) => dv.getFloat32(o, false);
        case -64: return (dv, o) => dv.getFloat64(o, false);
        case 64:  return (dv, o) => Number(dv.getBigInt64(o, false));
        default:  throw new Error(`fits_unsupported_bitpix_${bitpix}`);
    }
}

/**
 * Bilinear resample a source grid to (dstNx × dstNy), row-major.
 * Used to land any upstream map on the canonical 360×180 Carrington grid.
 */
export function resample(src, nx, ny, dstNx, dstNy) {
    if (nx === dstNx && ny === dstNy) return src;
    const out = new Float32Array(dstNx * dstNy);
    for (let j = 0; j < dstNy; j++) {
        const sy = (j / (dstNy - 1)) * (ny - 1);
        const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, ny - 1), fy = sy - y0;
        for (let i = 0; i < dstNx; i++) {
            const sx = (i / (dstNx - 1)) * (nx - 1);
            const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, nx - 1), fx = sx - x0;
            const a = src[y0 * nx + x0], b = src[y0 * nx + x1];
            const c = src[y1 * nx + x0], d = src[y1 * nx + x1];
            const top = a + (b - a) * fx;
            const bot = c + (d - c) * fx;
            out[j * dstNx + i] = top + (bot - top) * fy;
        }
    }
    return out;
}

/**
 * Z-score normalize a grid so the classical detector (which thresholds at
 * z ≤ -sigma) sees signatures as the negative tail. `signatureSign` flips the
 * sign for products whose active-region signatures are positive (so the output
 * always has negative = signature). GONG/HMI far-side phase shifts are negative
 * for active regions, so the default is correct.
 * @returns {{ data:Float32Array, mean:number, std:number }}
 */
export function zNormalize(src, signatureSign = -1) {
    let mean = 0;
    for (let i = 0; i < src.length; i++) mean += src[i];
    mean /= src.length;
    let v = 0;
    for (let i = 0; i < src.length; i++) { const d = src[i] - mean; v += d * d; }
    const std = Math.sqrt(v / src.length) || 1;
    const out = new Float32Array(src.length);
    const s = signatureSign < 0 ? 1 : -1; // keep negative = signature
    for (let i = 0; i < src.length; i++) out[i] = s * (src[i] - mean) / std;
    return { data: out, mean, std };
}

// ─────────────────────────────────────────────────────────────────────────────
// WCS-aware remap into the canonical Carrington grid.
//
// Real far-side FITS maps carry a World Coordinate System (FITS WCS) that pins
// each pixel to a (Carrington longitude, latitude). Rather than ASSUME the
// source spans the full 360×180 (which the naive `resample` does), we read the
// WCS and project the source onto our canonical grid. This is what makes the
// parser correct for the real product regardless of its pixel dimensions,
// longitude window, or latitude projection.
//
// Supported axis types:
//   - linear longitude (plate carrée, CTYPE like 'CRLN-CAR' / 'HGLN-CAR')
//   - linear latitude  (plate carrée)
//   - sine latitude    (cylindrical-equal-area synoptic maps; CTYPE ~ 'CEA',
//     or opts.latProjection='sine') — pixels uniform in sin(latitude)
// Falls back to a configurable full-range linear assumption when WCS is absent.
// ─────────────────────────────────────────────────────────────────────────────

const DEG = Math.PI / 180;

/** Extract a minimal WCS for both axes from a FITS header. */
export function parseWCS(header) {
    const num = (k, d) => (Number.isFinite(header[k]) ? header[k] : d);
    const ct1 = String(header.CTYPE1 || '').toUpperCase();
    const ct2 = String(header.CTYPE2 || '').toUpperCase();
    const present = ['CRVAL1', 'CDELT1', 'CRPIX1', 'CRVAL2', 'CDELT2', 'CRPIX2']
        .some((k) => Number.isFinite(header[k]));
    return {
        present,
        crval1: num('CRVAL1', 180), cdelt1: num('CDELT1', 0), crpix1: num('CRPIX1', 1),
        crval2: num('CRVAL2', 0),   cdelt2: num('CDELT2', 0), crpix2: num('CRPIX2', 1),
        ctype1: ct1, ctype2: ct2,
        // Latitude projection: sine if the header says CEA/SIN, else linear.
        latSine: /CEA|SIN/.test(ct2),
    };
}

/**
 * Project a source image (from readFITS) onto the canonical Carrington grid.
 * For each destination cell (Carrington lon, lat) we invert the WCS to a source
 * pixel and bilinearly sample. Cells outside the source coverage are left at 0
 * (the far-side product does not cover the full sphere).
 *
 * @param {{nx:number,ny:number,data:Float32Array,header:object}} read
 * @param {{nLon:number,nLat:number,latMin:number}} dst  canonical grid (GRID)
 * @param {object} [opts] { wcs?, latProjection:'linear'|'sine',
 *                          srcLon0,srcLon1,srcLat0,srcLat1 } fallback coverage
 * @returns {Float32Array} dst.nLon*dst.nLat, row-major, lat-ascending from latMin
 */
export function remapToCarrington(read, dst, opts = {}) {
    const { nx, ny, data } = read;
    const wcs = opts.wcs || parseWCS(read.header || {});
    const out = new Float32Array(dst.nLon * dst.nLat);

    const sample = (sx, sy) => {
        if (sx < 0 || sx > nx - 1 || sy < 0 || sy > ny - 1) return null;
        const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, nx - 1), fx = sx - x0;
        const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, ny - 1), fy = sy - y0;
        const a = data[y0 * nx + x0], b = data[y0 * nx + x1];
        const c = data[y1 * nx + x0], d = data[y1 * nx + x1];
        return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
    };

    // Coverage for the fallback (no-WCS) path.
    const fLon0 = opts.srcLon0 ?? 0, fLon1 = opts.srcLon1 ?? 360;
    const fLat0 = opts.srcLat0 ?? -90, fLat1 = opts.srcLat1 ?? 90;
    const latSine = opts.latProjection ? opts.latProjection === 'sine' : wcs.latSine;

    // Map a Carrington (lon,lat) → fractional source pixel (sx, sy), 0-based.
    function toPixel(lon, lat) {
        let sx, sy;
        if (wcs.present && wcs.cdelt1 !== 0 && wcs.cdelt2 !== 0) {
            // Longitude: handle the ±360 wrap so a window like 90..270 maps cleanly.
            let dlon = lon - wcs.crval1;
            dlon = ((dlon + 180) % 360 + 360) % 360 - 180;          // shortest path
            sx = (wcs.crpix1 - 1) + dlon / wcs.cdelt1;              // FITS CRPIX is 1-based
            if (latSine) {
                const s = Math.sin(lat * DEG), s0 = Math.sin(wcs.crval2 * DEG);
                sy = (wcs.crpix2 - 1) + (s - s0) / (wcs.cdelt2 * DEG); // cdelt2 in deg of sine-arg
            } else {
                sy = (wcs.crpix2 - 1) + (lat - wcs.crval2) / wcs.cdelt2;
            }
        } else {
            // Fallback: source spans [fLon0,fLon1] × [fLat0,fLat1] linearly.
            let lonN = lon;
            if (fLon1 > fLon0) { lonN = ((lon - fLon0) % 360 + 360) % 360 + fLon0; }
            sx = ((lonN - fLon0) / (fLon1 - fLon0)) * (nx - 1);
            if (latSine) {
                const s = Math.sin(lat * DEG), a = Math.sin(fLat0 * DEG), b = Math.sin(fLat1 * DEG);
                sy = ((s - a) / (b - a)) * (ny - 1);
            } else {
                sy = ((lat - fLat0) / (fLat1 - fLat0)) * (ny - 1);
            }
        }
        return [sx, sy];
    }

    for (let r = 0; r < dst.nLat; r++) {
        const lat = dst.latMin + r * (opts.latStep ?? 1);
        for (let c = 0; c < dst.nLon; c++) {
            const lon = c * (opts.lonStep ?? 1);
            const [sx, sy] = toPixel(lon, lat);
            const v = sample(sx, sy);
            if (v != null) out[r * dst.nLon + c] = v;
        }
    }
    return out;
}
