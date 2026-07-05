/**
 * temp-ramp.js — the single source of truth for temperature colour.
 *
 * Diverging meteorological ramp over the texture-encoded domain −60…+50 °C
 * (value = (T°C + 60)/110, lockstep with js/weather-decode.js). The pivot is
 * 0 °C: the cold arm darkens violet→blue away from freezing, the warm arm
 * darkens yellow→red the other way, so equal lightness ≈ equal |T − 0 °C| and
 * the freezing line is the perceptual midpoint — the boundary an analyst
 * actually cares about (rain/snow phase, icing, frost). Lightness is
 * monotonic within each arm and every adjacent stop pair clears CVD ΔE ≥ 20
 * (checked with the dataviz palette validator).
 *
 * Deliberately THREE-free: js/earth-skin.js wraps these pixels in a
 * DataTexture for the surface + volume shaders, while earth.html's wx-panel
 * legend paints the SAME array onto a canvas — one byte source, so the
 * on-globe colours and the °C key can never drift apart. Node tests import
 * this module directly (no bare 'three' specifier to resolve).
 */

export const TEMP_RAMP_STOPS = Object.freeze([
    // [°C, r, g, b]  (sRGB 0-255)
    [-60, 0x2a, 0x0c, 0x5e],   // deep violet — polar night
    [-40, 0x3b, 0x2b, 0xa6],   // indigo
    [-25, 0x2f, 0x6a, 0xc4],   // blue
    [-10, 0x5d, 0xb3, 0xdc],   // ice blue
    [  0, 0xbf, 0xe8, 0xee],   // pale cyan — freezing pivot
    [ 10, 0xf5, 0xe2, 0x9a],   // pale warm yellow
    [ 22, 0xf0, 0xa3, 0x43],   // amber
    [ 36, 0xd4, 0x50, 0x2a],   // hot orange-red
    [ 50, 0x8c, 0x15, 0x26],   // deep red — extreme heat
]);

export const TEMP_LUT_SIZE     = 256;
export const TEMP_ENCODE_MIN_C = -60;
export const TEMP_ENCODE_SPAN_C = 110;

/**
 * Build the 256×1 RGBA pixel array for the ramp — deterministic from
 * TEMP_RAMP_STOPS. Every consumer (shader LUT texture, wx-panel legend
 * canvas) renders these exact bytes.
 * @returns {Uint8Array} TEMP_LUT_SIZE × 4 (RGBA, A = 255)
 */
export function buildTempLUTPixels() {
    const data = new Uint8Array(TEMP_LUT_SIZE * 4);
    for (let i = 0; i < TEMP_LUT_SIZE; i++) {
        const tC = TEMP_ENCODE_MIN_C + (i / (TEMP_LUT_SIZE - 1)) * TEMP_ENCODE_SPAN_C;
        let s = 0;
        while (s < TEMP_RAMP_STOPS.length - 2 && tC > TEMP_RAMP_STOPS[s + 1][0]) s++;
        const [c0, r0, g0, b0] = TEMP_RAMP_STOPS[s];
        const [c1, r1, g1, b1] = TEMP_RAMP_STOPS[s + 1];
        const f = Math.max(0, Math.min(1, (tC - c0) / (c1 - c0)));
        data[i * 4]     = Math.round(r0 + (r1 - r0) * f);
        data[i * 4 + 1] = Math.round(g0 + (g1 - g0) * f);
        data[i * 4 + 2] = Math.round(b0 + (b1 - b0) * f);
        data[i * 4 + 3] = 255;
    }
    return data;
}

/** Fraction [0,1] along the ramp for a given °C — where a tick or the
 *  freezing pivot sits on any legend rendered from these pixels. */
export function tempToRampFrac(tC) {
    return Math.max(0, Math.min(1, (tC - TEMP_ENCODE_MIN_C) / TEMP_ENCODE_SPAN_C));
}

export default buildTempLUTPixels;
