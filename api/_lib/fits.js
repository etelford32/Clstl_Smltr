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
