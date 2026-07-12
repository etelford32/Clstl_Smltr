/**
 * cloud-mosaic-core.js — pure pixel math for the GIBS cloud mosaic.
 *
 * THREE-free and DOM-free on purpose (same pattern as js/temp-ramp.js):
 * js/cloud-imagery.js wraps these functions in canvas/texture glue, and
 * tests/cloud-mosaic-core.mjs exercises them byte-for-byte under Node.
 *
 * WHY THIS MODULE EXISTS — the "line of clouds" post-mortem
 * ─────────────────────────────────────────────────────────
 * The original mosaic drew four RAW GIBS products (GeoColor RGB, three
 * different IR brightness-temperature palettes, MODIS Cloud Optical
 * Thickness) onto one canvas with source-over and let the shader read
 * `.r` as "cloudiness". That coagulated several unrelated encodings into
 * one channel:
 *
 *   • GeoColor daytime deserts (Sahara tan, r≈0.82) read as ~full cloud,
 *     while the SAME ground 20° east — inside the Meteosat IR disc —
 *     read as clear. The product boundary rendered as a sharp
 *     cloud/no-cloud line following the disc edge: the visible seam.
 *   • Disc edges were hard cut (alpha 1 → 0 in one pixel), so wherever
 *     coverage ended, the shader snapped from measured data to
 *     procedural fill (base density 0.72) in a single fragment — a
 *     drawn-on line, widest at high latitude where discs diverge.
 *   • MODIS Cloud Optical Thickness is transparent where NO CLOUD was
 *     retrieved, so "clear sky" and "not observed" were both alpha=0.
 *     The shader treats alpha=0 as unobserved → dense procedural fill.
 *     Net effect: the CLEARER the real sky, the CLOUDIER the render —
 *     any disc gap or COT-clear lune rendered as a wedge of fake cloud
 *     with hard edges.
 *
 * The fix implemented here: normalize every product to one physical
 * quantity — cloudiness in [0,1] plus an observation confidence — BEFORE
 * compositing, feather geostationary disc edges by view angle, and blend
 * overlaps by weight instead of paint order. The output texture's red
 * channel IS cloud fraction (linear, no sRGB) and alpha IS confidence.
 *
 * Exports:
 *   productKind(layerId)                  → 'ir' | 'geocolor' | 'cot' | 'truecolor'
 *   cloudinessFromPixel(r,g,b,a,kind,out) → writes [cloudiness, confidence] into out
 *   discWeight(cosLat, dLonDeg)           → feathered geostationary view weight
 *   MosaicAccumulator                     → two-tier (primary/fill) weighted compositor
 *   gibsTimeCandidates(nowMs, opts)       → freshest-first TIME values for sub-daily layers
 *   toUtcDate(ms|Date)                    → 'YYYY-MM-DD'
 */

// ── Product classification ───────────────────────────────────────────────────
// Layer IDs are the only reliable signal for how to decode a snapshot's
// pixels. Anything unrecognized decodes with the conservative truecolor
// rules (low confidence) rather than being trusted as cloudiness.
export function productKind(layerId) {
    const id = String(layerId || '');
    if (/GeoColor/i.test(id))                     return 'geocolor';
    if (/Brightness_Temperature|Infrared/i.test(id)) return 'ir';
    if (/Cloud_Optical_Thickness/i.test(id))      return 'cot';
    return 'truecolor';
}

// Decode calibration, per product family. Grouped here so a recalibration
// (e.g. GIBS changes an IR palette) is a one-line diff verified by tests.
export const PRODUCT_PARAMS = {
    // IR brightness temperature, classic display convention: cold = bright.
    // Surface (280–320 K) sits in the dark half of the ramp, opaque deep
    // convection near the top. Works identically day and night — which is
    // why IR is preferred over GeoColor for every region (no baked-in
    // day/night terminator edge inside the imagery).
    ir:        { lumClear: 0.30, lumOvercast: 0.82, confScale: 1.00 },
    // GeoColor: true-colour by day, blue-tinted IR + city lights by night.
    // Clouds are bright AND unsaturated; deserts/snowfields are bright but
    // saturated, so saturation gates the luminance signal. This is an
    // inference, not a measurement → confidence discount.
    geocolor:  { lumClear: 0.35, lumOvercast: 0.80, satZero: 0.45, satRange: 0.30, confScale: 0.90 },
    // MODIS Cloud Optical Thickness: transparent = NO RETRIEVAL, which for
    // a daily global composite mostly means "clear sky", not "unseen".
    // Treat transparent as clear at reduced confidence (clearConf) so clear
    // regions stop being handed to the procedural cloud generator — that
    // inversion (clear sky → dense fake cloud) was a root cause of the
    // wedge artifact. Retrieval pixels decode by palette luminance.
    cot:       { lumClear: 0.05, lumOvercast: 0.65, confScale: 0.80, clearConf: 0.45 },
    // Corrected-reflectance true colour: last-ditch fallback. Bright
    // deserts/snow partially gate via saturation but polar snow is
    // achromatic like cloud — hence the lowest confidence of the family.
    truecolor: { lumClear: 0.35, lumOvercast: 0.80, satZero: 0.45, satRange: 0.30, confScale: 0.70 },
};

const clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x;

/**
 * Decode one RGBA pixel (0–255 channels) of a GIBS product into
 * [cloudiness 0–1, confidence 0–1], written into `out` (length-2 array;
 * caller reuses it — this runs per pixel on 2M-pixel images, so no
 * allocation per call).
 */
export function cloudinessFromPixel(r, g, b, a, kind, out) {
    const p = PRODUCT_PARAMS[kind] || PRODUCT_PARAMS.truecolor;
    const alpha = a / 255;

    if (kind === 'cot' && alpha < 0.03) {
        // No retrieval in a daily composite ≈ observed clear (see header).
        out[0] = 0;
        out[1] = p.clearConf;
        return out;
    }
    if (alpha < 0.03) {
        // Genuinely unobserved (outside disc, swath gap in non-COT product).
        out[0] = 0;
        out[1] = 0;
        return out;
    }

    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    let c = clamp01((lum - p.lumClear) / (p.lumOvercast - p.lumClear));

    if (p.satZero !== undefined) {
        // RGB products: clouds are achromatic. Colour saturation gates the
        // luminance signal linearly — full weight at satZero−satRange and
        // below, zero at satZero and above — so bright-but-tinted ground
        // (Sahara tan, snow-melt sediment) stops reading as overcast.
        const mx = Math.max(r, g, b) / 255;
        const mn = Math.min(r, g, b) / 255;
        const sat = mx > 1e-3 ? (mx - mn) / mx : 0;
        c = clamp01(c * clamp01((p.satZero - sat) / p.satRange));
    }

    out[0] = c;
    out[1] = alpha * p.confScale;
    return out;
}

// ── Geostationary disc feather ───────────────────────────────────────────────
// View angle θ from the sub-satellite point: cosθ = cos(lat)·cos(Δlon).
// Full weight inside 60°, eased to zero by 76° — past ~70° the pixels are
// limb-smeared parallax junk that GIBS reprojection stretches into exactly
// the kind of bright arc the old hard-cut compositor showed as a seam.
const FEATHER_FULL_DEG = 60;
const FEATHER_ZERO_DEG = 76;
const COS_FULL = Math.cos(FEATHER_FULL_DEG * Math.PI / 180);
const COS_ZERO = Math.cos(FEATHER_ZERO_DEG * Math.PI / 180);

/**
 * @param {number} cosLat  cos(latitude) — precomputed per row by the caller
 * @param {number} dLonDeg longitude offset from sub-satellite point, degrees
 *                         (caller wraps into [-180, 180])
 * @returns weight in [0,1], smooth (C¹) across the feather band
 */
export function discWeight(cosLat, dLonDeg) {
    const cosTheta = cosLat * Math.cos(dLonDeg * Math.PI / 180);
    if (cosTheta >= COS_FULL) return 1;
    if (cosTheta <= COS_ZERO) return 0;
    const t = (cosTheta - COS_ZERO) / (COS_FULL - COS_ZERO);
    return t * t * (3 - 2 * t);   // smoothstep
}

// ── Two-tier weighted compositor ─────────────────────────────────────────────
// Primary tier: geostationary discs — fresh (~10-min), radiometrically
// trustworthy, feather-weighted. Fill tier: polar-orbiter daily composites —
// stale but global. Fill only shows through where primary weight runs out,
// with a smooth crossfade, so a stale daily pixel can never dilute a fresh
// disc pixel (a straight weighted mean would have pulled every disc value
// toward yesterday's MODIS by ~30%).
const PRIMARY_SATURATION = 0.6;   // primary weight at which fill is fully masked

export class MosaicAccumulator {
    constructor(width, height) {
        this.width  = width;
        this.height = height;
        const n = width * height;
        this._pcw = new Float32Array(n);   // primary Σ(cloudiness·w)
        this._pw  = new Float32Array(n);   // primary Σw
        this._fcw = new Float32Array(n);   // fill Σ(cloudiness·w)
        this._fw  = new Float32Array(n);   // fill Σw
        // Row/col geometry caches shared by every addRegionRows call.
        this._cosLat = new Float32Array(height);
        for (let j = 0; j < height; j++) {
            const lat = 90 - ((j + 0.5) * 180) / height;   // row 0 = north
            this._cosLat[j] = Math.cos(lat * Math.PI / 180);
        }
        this._lon = new Float32Array(width);
        for (let i = 0; i < width; i++) {
            this._lon[i] = -180 + ((i + 0.5) * 360) / width;
        }
    }

    /**
     * Fold rows [rowStart, rowEnd) of an equirectangular RGBA image into the
     * accumulator. Row-ranged so the browser glue can chunk the work across
     * idle slices instead of blocking the main thread for the full image.
     *
     * @param {Uint8ClampedArray} rgba   width×height×4, row 0 = 90°N
     * @param {string} kind              productKind() result
     * @param {number|null} subLonDeg    sub-satellite longitude for disc
     *                                   feathering; null = no feather (polar
     *                                   orbiter composites are already global)
     * @param {'primary'|'fill'} tier
     */
    addRegionRows(rgba, kind, subLonDeg, tier, rowStart, rowEnd) {
        const { width } = this;
        const cw = tier === 'primary' ? this._pcw : this._fcw;
        const w  = tier === 'primary' ? this._pw  : this._fw;
        const px = [0, 0];
        for (let j = rowStart; j < rowEnd; j++) {
            const cosLat = this._cosLat[j];
            let idx = j * width;
            let o = idx * 4;
            for (let i = 0; i < width; i++, idx++, o += 4) {
                cloudinessFromPixel(rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3], kind, px);
                let weight = px[1];
                if (weight <= 0) continue;
                if (subLonDeg !== null && subLonDeg !== undefined) {
                    let dLon = this._lon[i] - subLonDeg;
                    dLon = ((dLon + 540) % 360) - 180;    // wrap: Himawari disc crosses ±180°
                    weight *= discWeight(cosLat, dLon);
                    if (weight <= 0) continue;
                }
                cw[idx] += px[0] * weight;
                w[idx]  += weight;
            }
        }
    }

    /** Convenience for tests / single-shot callers. */
    addRegion(rgba, kind, subLonDeg, tier) {
        this.addRegionRows(rgba, kind, subLonDeg, tier, 0, this.height);
    }

    /**
     * Resolve the two tiers into an RGBA texture buffer:
     *   R = G = B = cloudiness·255  (LINEAR — the texture must be sampled
     *                                with no sRGB decode; see makeTexture)
     *   A         = observation confidence·255 (the shader's satData mask)
     *
     * Returns { data, stats } where stats feeds the telemetry event:
     *   coverage      fraction of pixels with confidence > 0.15
     *   meanCloudiness confidence-weighted mean cloud fraction
     *   bandCoverage  72×5° longitude bands, mean confidence within ±60° lat
     *   gapMaxDeg     widest contiguous low-coverage arc (the "wedge finder" —
     *                 names the exact lon span the user sees as fake cloud)
     *   gapCenterLon  centre longitude of that arc
     */
    finalize(existing) {
        const { width, height } = this;
        const n = width * height;
        const data = existing || new Uint8ClampedArray(n * 4);

        const BANDS = 72;
        const bandW = new Float64Array(BANDS);
        const bandN = new Float64Array(BANDS);
        const latLo = Math.ceil(height * (1 / 6));    // ±60° lat window:
        const latHi = Math.floor(height * (5 / 6));   // rows h/6 .. 5h/6

        let covered = 0, cwSum = 0, wSum = 0;
        for (let idx = 0, o = 0; idx < n; idx++, o += 4) {
            const pw = this._pw[idx];
            const fw = this._fw[idx];
            let c = 0, conf = 0;
            if (pw > 0 || fw > 0) {
                const t  = pw >= PRIMARY_SATURATION ? 1 : pw / PRIMARY_SATURATION;
                const cp = pw > 0 ? this._pcw[idx] / pw : 0;
                const cf = fw > 0 ? this._fcw[idx] / fw : 0;
                c    = t * cp + (1 - t) * (fw > 0 ? cf : cp);
                conf = Math.min(1, pw + fw * (1 - t));
            }
            const v = Math.round(c * 255);
            data[o] = v; data[o + 1] = v; data[o + 2] = v;
            data[o + 3] = Math.round(conf * 255);

            if (conf > 0.15) covered++;
            cwSum += c * conf;
            wSum  += conf;

            const j = (idx / width) | 0;
            if (j >= latLo && j < latHi) {
                const band = Math.min(BANDS - 1, (((idx % width) * BANDS) / width) | 0);
                bandW[band] += conf;
                bandN[band]++;
            }
        }

        const bandCoverage = new Array(BANDS);
        for (let b = 0; b < BANDS; b++) {
            bandCoverage[b] = bandN[b] > 0 ? bandW[b] / bandN[b] : 0;
        }
        const gap = widestLowArc(bandCoverage, 0.3);

        return {
            data,
            stats: {
                coverage:       covered / n,
                meanCloudiness: wSum > 0 ? cwSum / wSum : 0,
                bandCoverage,
                gapMaxDeg:      gap.lenBands * (360 / BANDS),
                gapCenterLon:   gap.lenBands > 0
                    ? -180 + (gap.center + 0.5) * (360 / BANDS)
                    : null,
            },
        };
    }
}

/**
 * Widest circular run of bands below `threshold`. Exported for tests.
 * Returns { lenBands, center } with center as a (possibly fractional)
 * band index in [0, bands.length).
 */
export function widestLowArc(bands, threshold) {
    const n = bands.length;
    let best = { lenBands: 0, center: 0 };
    let runStart = -1, runLen = 0;
    // Walk 2n so a run wrapping the array end is seen contiguously.
    for (let k = 0; k < 2 * n; k++) {
        if (bands[k % n] < threshold) {
            if (runLen === 0) runStart = k;
            runLen++;
            if (runLen >= n) { runLen = n; break; }   // fully uncovered
        } else {
            runLen = 0;
        }
        if (runLen > best.lenBands) {
            best = { lenBands: runLen, center: (runStart + (runLen - 1) / 2) % n };
        }
    }
    if (runLen === n) best = { lenBands: n, center: n / 2 };
    return best;
}

// ── Snapshot TIME candidates ─────────────────────────────────────────────────

/** Format a Date (or epoch ms) as YYYY-MM-DD in UTC. */
export function toUtcDate(d) {
    const dt = typeof d === 'number' ? new Date(d) : d;
    const y  = dt.getUTCFullYear();
    const m  = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

function toUtcStamp(ms) {
    const d = new Date(ms);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${toUtcDate(d)}T${hh}:${mm}:00Z`;
}

/**
 * TIME values to try for a sub-daily (geostationary) layer, freshest first.
 *
 * The legacy pipeline sent date-only TIME values, which GIBS resolves to a
 * fixed reference granule for the day — so "live" clouds were up to a day
 * stale and carried whatever terminator the reference time baked in. Real
 * timestamps (floored to the imaging cadence, lagged for GIBS ingest) fix
 * that; the date-only values stay at the tail as a compatibility net, so
 * the worst case equals the old behaviour, never worse.
 *
 * @returns [{ time, timestampMs|null }]  timestampMs null ⇒ date-only
 */
export function gibsTimeCandidates(nowMs, { cadenceMin = 10, lagMin = 20, backMin = [0, 30, 90] } = {}) {
    const cadMs = cadenceMin * 60000;
    const base  = Math.floor((nowMs - lagMin * 60000) / cadMs) * cadMs;
    const out = [];
    const seen = new Set();
    for (const back of backMin) {
        const t = base - back * 60000;
        const s = toUtcStamp(t);
        if (!seen.has(s)) { seen.add(s); out.push({ time: s, timestampMs: t }); }
    }
    for (const dayBack of [0, 1]) {
        const s = toUtcDate(nowMs - dayBack * 86400000);
        if (!seen.has(s)) { seen.add(s); out.push({ time: s, timestampMs: null }); }
    }
    return out;
}
