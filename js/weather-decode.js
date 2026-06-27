/**
 * weather-decode.js — pure CHW-coarse → full-res render-trio decoder.
 *
 * This is the single source of truth for turning a packed 9-channel coarse
 * grid (e.g. 72×36) into the three normalised TEX_W×TEX_H×4 Float32 buffers
 * the globe renders (weather / wind / cloud). It was lifted verbatim out of
 * WeatherFeen._decodeCoarse so it can be imported BOTH by:
 *   - js/weather-feed.js (the live + replay path; delegates to decodeCoarse)
 *   - js/weather-forecast-worker.js (off-thread forecast decode pre-warm)
 *
 * The module is a dependency-free leaf — no DOM, no three.js, no bare
 * specifiers — so a module Web Worker (which does not inherit the page's
 * importmap) can import it directly.
 *
 * INVARIANT: decodeCoarse() must stay byte-identical to whatever the live
 * renderer expects. tests/weather-decode-identity.mjs asserts the feed's
 * _decodeCoarse and this function produce identical buffers; keep them in
 * lockstep.
 */

export const TEX_W = 360;          // output texture width  (1°/pixel)
export const TEX_H = 180;          // output texture height (1°/pixel)
export const MAX_WIND_MS = 60;     // m/s — wind-speed normalisation ceiling

// ── Bilinear interpolation: inW×inH → outW×outH ─────────────────────────────
// wrapX: when true, longitude (x axis) wraps so column 0 is adjacent to
//        column inW-1 (periodic boundary). Eliminates the seam at the
//        antimeridian where -175° meets +175°.
export function bilinear(src, inW, inH, outW, outH, wrapX = false) {
    const dst = new Float32Array(outW * outH);
    for (let j = 0; j < outH; j++) {
        const fy = (j / (outH - 1)) * (inH - 1);
        const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, inH - 1);
        const ty = fy - y0;
        for (let i = 0; i < outW; i++) {
            const fx = (i / (outW - 1)) * (inW - 1);
            const x0 = Math.floor(fx);
            const x1 = wrapX ? (x0 + 1) % inW : Math.min(x0 + 1, inW - 1);
            const tx = fx - x0;
            dst[j * outW + i] =
                (1 - tx) * (1 - ty) * src[y0 * inW + x0] + tx * (1 - ty) * src[y0 * inW + x1] +
                (1 - tx) *      ty  * src[y1 * inW + x0] + tx *      ty  * src[y1 * inW + x1];
        }
    }
    return dst;
}

// ── Separable box blur (radius R → kernel width 2R+1) ───────────────────────
// Wraps longitude (x axis); clamps latitude (y axis).
export function boxBlur(src, W, H, R) {
    const tmp  = new Float32Array(W * H);
    const dst  = new Float32Array(W * H);
    const diam = 2 * R + 1;

    // Horizontal pass (wrap longitude)
    for (let j = 0; j < H; j++) {
        let sum = 0;
        for (let dx = -R; dx <= R; dx++) {
            sum += src[j * W + ((dx % W) + W) % W];
        }
        tmp[j * W + 0] = sum / diam;
        for (let i = 1; i < W; i++) {
            sum += src[j * W + ((i + R) % W)] - src[j * W + (((i - R - 1) % W) + W) % W];
            tmp[j * W + i] = sum / diam;
        }
    }

    // Vertical pass (clamp latitude)
    for (let i = 0; i < W; i++) {
        let sum = 0;
        for (let dy = -R; dy <= R; dy++) {
            sum += tmp[Math.max(0, Math.min(H - 1, dy)) * W + i];
        }
        dst[0 * W + i] = sum / diam;
        for (let j = 1; j < H; j++) {
            sum += tmp[Math.min(H - 1, j + R) * W + i] - tmp[Math.max(0, j - R - 1) * W + i];
            dst[j * W + i] = sum / diam;
        }
    }

    return dst;
}

/**
 * Decode a packed CHW coarse grid into { weatherBuf, windBuf, cloudBuf },
 * each a TEX_W×TEX_H×4 Float32Array. Channel order:
 *   0=T 1=P 2=RH 3=U 4=V 5=cloud_low 6=cloud_mid 7=cloud_high 8=precip
 */
export function decodeCoarse(coarse, gridW, gridH) {
    const N = gridW * gridH;

    const T  = coarse.subarray(0 * N, 1 * N);
    const P  = coarse.subarray(1 * N, 2 * N);
    const RH = coarse.subarray(2 * N, 3 * N);
    const U  = coarse.subarray(3 * N, 4 * N);
    const V  = coarse.subarray(4 * N, 5 * N);
    const cL = coarse.subarray(5 * N, 6 * N);
    const cM = coarse.subarray(6 * N, 7 * N);
    const cH = coarse.subarray(7 * N, 8 * N);
    const Pr = coarse.subarray(8 * N, 9 * N);

    // Wind speed derived on the coarse grid — hypot(U,V) == upstream wspd.
    const W = new Float32Array(N);
    for (let k = 0; k < N; k++) W[k] = Math.hypot(U[k], V[k]);

    // Bilinear upsample. wrapX=true so the antimeridian doesn't seam.
    const fT = bilinear(T,  gridW, gridH, TEX_W, TEX_H, true);
    const fP = bilinear(P,  gridW, gridH, TEX_W, TEX_H, true);
    const fH = bilinear(RH, gridW, gridH, TEX_W, TEX_H, true);
    const fU = bilinear(U,  gridW, gridH, TEX_W, TEX_H, true);
    const fV = bilinear(V,  gridW, gridH, TEX_W, TEX_H, true);
    const fW = bilinear(W,  gridW, gridH, TEX_W, TEX_H, true);

    // Cloud + precip: bilinear upsample + a single structure-preserving blur.
    const fCL = bilinear(cL, gridW, gridH, TEX_W, TEX_H, true);
    const fCM = bilinear(cM, gridW, gridH, TEX_W, TEX_H, true);
    const fCH = bilinear(cH, gridW, gridH, TEX_W, TEX_H, true);
    const fPr = bilinear(Pr, gridW, gridH, TEX_W, TEX_H, true);
    const cellPx  = Math.max(1, Math.round(TEX_W / gridW));
    const blurR   = Math.max(1, Math.round(cellPx * 0.40));
    const cirrusR = Math.max(1, Math.round(cellPx * 0.25));
    const precipR = Math.max(1, Math.round(cellPx * 0.35));
    const sLow    = boxBlur(fCL, TEX_W, TEX_H, blurR);
    const sMid    = boxBlur(fCM, TEX_W, TEX_H, blurR);
    const sHigh   = boxBlur(fCH, TEX_W, TEX_H, cirrusR);
    const sPrecip = boxBlur(fPr, TEX_W, TEX_H, precipR);

    const NTEX = TEX_W * TEX_H;
    const weatherBuf = new Float32Array(NTEX * 4);
    const windBuf    = new Float32Array(NTEX * 4);
    const cloudBuf   = new Float32Array(NTEX * 4);

    for (let k = 0; k < NTEX; k++) {
        const t4 = k * 4;

        weatherBuf[t4 + 0] = Math.max(0, Math.min(1, (fT[k] + 60) / 110));   // -60…+50 °C
        weatherBuf[t4 + 1] = Math.max(0, Math.min(1, (fP[k] - 850) / 210));  // 850…1060 hPa
        weatherBuf[t4 + 2] = Math.max(0, Math.min(1,  fH[k] / 100));
        weatherBuf[t4 + 3] = Math.max(0, Math.min(1,  fW[k] / MAX_WIND_MS));

        windBuf[t4 + 0] = fU[k] / MAX_WIND_MS;   // [-1, 1]
        windBuf[t4 + 1] = fV[k] / MAX_WIND_MS;   // [-1, 1]
        windBuf[t4 + 2] = fW[k] / MAX_WIND_MS;   // [0, 1]
        windBuf[t4 + 3] = 1.0;

        cloudBuf[t4 + 0] = Math.max(0, Math.min(1, sLow[k]    / 100));
        cloudBuf[t4 + 1] = Math.max(0, Math.min(1, sMid[k]    / 100));
        cloudBuf[t4 + 2] = Math.max(0, Math.min(1, sHigh[k]   / 100));
        cloudBuf[t4 + 3] = Math.max(0, Math.min(1, sPrecip[k] / 10));   // cap 10 mm/hr
    }

    return { weatherBuf, windBuf, cloudBuf };
}
