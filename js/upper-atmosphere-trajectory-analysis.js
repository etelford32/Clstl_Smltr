/**
 * upper-atmosphere-trajectory-analysis.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Per-satellite deterministic trajectory analysis for the upper-atmosphere
 * page. Couples the Rust SGP4 propagator (truth) with an analytic RK4
 * drag-decay overlay (model) so users can compare the two and read off the
 * physics directly.
 *
 * Physics it answers, per satellite:
 *
 *   1. Where is it now?            osculating Keplerian elements
 *                                  (a, e, i, Ω, ω, ν, h_p, h_a, T)
 *   2. How fast is it going?       |v| from SGP4 (TEME, km/s)
 *   3. What drag does it feel?     q = ½·ρ(h)·v²  with ρ from the active
 *                                  upper-atmosphere profile
 *   4. Where will it be in N hours?  SGP4 truth time-series
 *      Where will it decay to?     RK4 da/dt = −BC·ρ(h)·v·a integration
 *
 * The "fun integration math" — RK4 of the Kozai circular-drag ODE, fed by a
 * piecewise-log-linear ρ(h) sampler — runs in Rust (rust-sgp4/src/lib.rs:
 * drag_decay_rk4). This module just orchestrates it and renders inline
 * SVG plots so the analysis panel stays self-contained.
 *
 * Usage:
 *   import { TrajectoryAnalyzer } from './upper-atmosphere-trajectory-analysis.js';
 *   const t = new TrajectoryAnalyzer();
 *   await t.ready;                      // resolves once WASM is loaded
 *   const result = await t.analyze({
 *       line1, line2,                   // TLE
 *       horizonHr:  24,                 // forward analysis window
 *       sampleMin:  5,                  // SGP4 sample stride
 *       bcM2PerKg:  0.022,              // typical LEO sat (CdA/m)
 *       profileSamples,                 // upper-atmosphere ρ profile
 *   });
 *   // result.sgp4    : Float64Array stride 13 — see Rust trajectory_stride()
 *   // result.drag    : Float64Array stride 5  — RK4 decay overlay
 *   // result.osc     : { sma_km, ecc, inc_deg, ... }
 */

const SGP4_STRIDE = 13;     // mirrors Rust trajectory_stride()
const DRAG_STRIDE = 5;      // mirrors Rust drag_stride()

// SGP4-trajectory column indices — keep aligned with the Rust comment block.
export const SGP4_COL = Object.freeze({
    T_MIN: 0, X_KM: 1, Y_KM: 2, Z_KM: 3,
    VX: 4,    VY: 5,   VZ: 6,
    R_KM: 7,  ALT_KM: 8, SPEED: 9,
    SMA: 10,  ECC: 11, INC_DEG: 12,
});

export const DRAG_COL = Object.freeze({
    T_MIN: 0, SMA_KM: 1, ALT_KM: 2, SPEED_KMS: 3, DA_DT_KM_DAY: 4,
});

// ── Default ballistic coefficients (CdA/m, m²/kg) ────────────────────────
// Public-domain rough numbers; the panel exposes a slider so users can
// dial these in. These map to "typical" mass + cross-section for each
// platform type. Higher BC = more deceleration per ρv.
//
//   sphere-of-coke-can       ≈ 0.05  (debris fragment, tumbling)
//   3U cubesat broadside     ≈ 0.025
//   ISS truss (always-on)    ≈ 0.018
//   Starlink v1 broadside    ≈ 0.020
//   GPS dish (high orbit)    ≈ 0.010 (drag negligible up there anyway)
export const DEFAULT_BC_BY_NORAD = Object.freeze({
    25544: 0.018,    // ISS — large-area but heavy
    20580: 0.011,    // Hubble — drag-stable design
    44713: 0.020,    // Starlink rep
    48274: 0.018,    // Tiangong
});

// ── WASM loader (shared with satellite-tracker) ──────────────────────────
let _wasm = null;
let _wasmPromise = null;

async function _loadWasm() {
    if (_wasm) return _wasm;
    if (_wasmPromise) return _wasmPromise;
    _wasmPromise = (async () => {
        const mod = await import('./sgp4-wasm/sgp4_wasm.js');
        await mod.default();
        _wasm = mod;
        return mod;
    })();
    return _wasmPromise;
}

/**
 * Convert an upper-atmosphere `sampleProfile()` result to the parallel
 * (alt_grid, rho_grid) Float64Arrays the Rust RK4 expects. Skips out-of-
 * domain samples (negative ρ, NaN). The Rust side log-linearly interpolates
 * between them, so even a 50-point grid handles a 30-day decay well.
 */
export function profileToRhoGrid(samples) {
    if (!samples || samples.length === 0) {
        return { alt: new Float64Array(0), rho: new Float64Array(0) };
    }
    const valid = samples
        .filter(s => Number.isFinite(s.altitudeKm)
                  && Number.isFinite(s.rho)
                  && s.rho > 0)
        .sort((a, b) => a.altitudeKm - b.altitudeKm);
    const alt = new Float64Array(valid.length);
    const rho = new Float64Array(valid.length);
    for (let i = 0; i < valid.length; i++) {
        alt[i] = valid[i].altitudeKm;
        rho[i] = valid[i].rho;
    }
    return { alt, rho };
}

/**
 * Generate the sampling grid (minutes since epoch) for the SGP4 truth
 * sweep. We start at "now" relative to the TLE epoch and walk forward
 * `horizonHr` hours at `sampleMin`-minute steps, plus optionally a small
 * pre-roll (negative tsince) so plots show a few past samples and the
 * "now" line lands cleanly inside the chart.
 */
export function buildTimeGrid({
    nowTsinceMin,
    horizonHr = 24,
    sampleMin = 5,
    preRollMin = 0,
}) {
    const horizonMin = horizonHr * 60;
    const total = horizonMin + preRollMin;
    const n = Math.max(2, Math.floor(total / sampleMin) + 1);
    const arr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        arr[i] = nowTsinceMin - preRollMin + i * sampleMin;
    }
    return arr;
}

export class TrajectoryAnalyzer {
    constructor() {
        this.ready = _loadWasm();
        this._wasm = null;
        this.ready.then((m) => { this._wasm = m; });
    }

    /**
     * Run the full analysis for one satellite.
     *
     * @param {object} opts
     * @param {string} opts.line1, opts.line2         TLE
     * @param {number} [opts.horizonHr=24]            hours forward
     * @param {number} [opts.sampleMin=5]             SGP4 stride (min)
     * @param {number} [opts.preRollMin=0]            hours of past samples
     * @param {number} [opts.bcM2PerKg=0.020]         BC for the RK4 overlay
     * @param {number} [opts.dragSubSec=60]           RK4 substep
     * @param {number} [opts.dragOutMin]              RK4 output stride; defaults to sampleMin
     * @param {number} [opts.rhoScale=1.0]            multiplier on ρ (storm)
     * @param {object} opts.profileSamples            from sampleProfile().samples
     * @param {Date}   [opts.nowDate]                 wall-clock "now"; default Date.now
     */
    async analyze({
        line1, line2,
        horizonHr = 24,
        sampleMin = 5,
        preRollMin = 0,
        bcM2PerKg = 0.020,
        dragSubSec = 60,
        dragOutMin,
        rhoScale = 1.0,
        profileSamples,
        nowDate = new Date(),
    }) {
        const wasm = await this.ready;
        if (!wasm) throw new Error('WASM SGP4 unavailable');

        // Parse the TLE once via WASM for the canonical orbital elements.
        const info = wasm.parse_tle_info(line1, line2);
        const epochMs = _jdToUnixMs(info.epoch_jd);
        const nowTsinceMin = (nowDate.getTime() - epochMs) / 60000;

        // ── SGP4 truth time-series ───────────────────────────────────────
        const times = buildTimeGrid({ nowTsinceMin, horizonHr, sampleMin, preRollMin });
        const sgp4Flat = wasm.propagate_trajectory_full(line1, line2, times);

        // ── Osculating elements at "now" ────────────────────────────────
        let osc = null;
        try {
            osc = wasm.osculating_elements_at(line1, line2, nowTsinceMin);
        } catch (_) { osc = null; }

        // ── RK4 drag-decay overlay ──────────────────────────────────────
        // Seed from the "now" osculating SMA (preferred) or from the TLE
        // mean motion (fallback). Mean motion is rev/day; convert to a via
        // Kepler's third law.
        let a0_km;
        if (osc?.sma_km && Number.isFinite(osc.sma_km) && osc.sma_km > 0) {
            a0_km = osc.sma_km;
        } else {
            const n_rad_s = info.mean_motion_rev_day * (2 * Math.PI) / 86400;
            const MU = 398600.8;
            a0_km = Math.cbrt(MU / (n_rad_s * n_rad_s));
        }

        const { alt, rho } = profileToRhoGrid(profileSamples || []);
        let dragFlat = null;
        if (alt.length >= 2) {
            try {
                dragFlat = wasm.drag_decay_rk4(
                    a0_km,
                    bcM2PerKg,
                    horizonHr * 60,
                    dragSubSec,
                    dragOutMin ?? sampleMin,
                    alt,
                    rho,
                    rhoScale,
                );
            } catch (err) {
                console.warn('[TrajectoryAnalyzer] drag_decay_rk4 failed:', err);
            }
        }

        return {
            tle:  { line1, line2, info, epochMs },
            now:  { tsinceMin: nowTsinceMin, dateMs: nowDate.getTime() },
            sgp4: { stride: SGP4_STRIDE, data: sgp4Flat, n: times.length },
            drag: dragFlat
                ? { stride: DRAG_STRIDE, data: dragFlat, n: dragFlat.length / DRAG_STRIDE,
                    bcM2PerKg, rhoScale, a0_km }
                : null,
            osc,
        };
    }
}

// ── JD → Unix ms ─────────────────────────────────────────────────────────
// Rust returns epoch_jd as Julian Day at the TLE epoch. JS uses Unix ms.
// 2440587.5 = JD at Unix epoch (1970-01-01 00:00 UTC).
function _jdToUnixMs(jd) {
    return (jd - 2440587.5) * 86400 * 1000;
}

// ── Inline SVG plot helpers ──────────────────────────────────────────────
//
// Build a multi-trace SVG line chart from a flat strided array. No
// dependencies — fits in <pre>1 kB rendered. Used by the analysis panel
// for altitude / speed / q / decay curves. Caller passes one or more
// `series` definitions, each picking a column out of the strided buffer.

/**
 * @param {object} cfg
 * @param {{x:Float64Array, y:Float64Array, color:string, label:string,
 *          dashed?:boolean}[]} cfg.series
 * @param {number} cfg.width, cfg.height
 * @param {string} cfg.title, cfg.yLabel
 * @param {number} [cfg.nowX]   x-value to draw a vertical "now" marker
 * @returns {string} SVG markup
 */
export function buildSvgChart({
    series, width = 380, height = 130,
    title, yLabel, xLabel = 't (hours)',
    nowX = null,
    yLog = false,
}) {
    const padL = 46, padR = 8, padT = 16, padB = 22;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    // Filter NaNs to bound the y-axis. If everything is NaN we still want
    // to render the frame so the panel doesn't collapse.
    let xMin = Infinity, xMax = -Infinity;
    let yMin = Infinity, yMax = -Infinity;
    for (const s of series) {
        for (let i = 0; i < s.x.length; i++) {
            const xv = s.x[i], yv = s.y[i];
            if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
            if (yLog && yv <= 0) continue;
            const yt = yLog ? Math.log10(yv) : yv;
            if (xv < xMin) xMin = xv;
            if (xv > xMax) xMax = xv;
            if (yt < yMin) yMin = yt;
            if (yt > yMax) yMax = yt;
        }
    }
    if (!Number.isFinite(xMin)) { xMin = 0; xMax = 1; }
    if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1; }
    if (yMin === yMax) { yMax = yMin + 1; }
    if (xMin === xMax) { xMax = xMin + 1; }

    const xToPx = (x) => padL + ((x - xMin) / (xMax - xMin)) * plotW;
    const yToPx = (y) => {
        const yt = yLog ? Math.log10(Math.max(y, Number.MIN_VALUE)) : y;
        return padT + plotH - ((yt - yMin) / (yMax - yMin)) * plotH;
    };

    // ── Axis ticks (5 each) ──
    const xTicks = [], yTicks = [];
    for (let i = 0; i <= 4; i++) {
        const fr = i / 4;
        xTicks.push(xMin + fr * (xMax - xMin));
        yTicks.push(yMin + fr * (yMax - yMin));
    }

    const fmtX = (v) => v.toFixed(v >= 10 ? 0 : 1);
    const fmtY = (v) => {
        if (yLog) {
            const av = Math.pow(10, v);
            return av.toExponential(0);
        }
        if (Math.abs(v) >= 1000) return v.toFixed(0);
        if (Math.abs(v) >= 10)   return v.toFixed(1);
        return v.toFixed(2);
    };

    let svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"
        preserveAspectRatio="xMidYMid meet"
        style="font-family:monospace;font-size:9px;">`;
    svg += `<rect x="0" y="0" width="${width}" height="${height}" fill="rgba(8,4,28,0.5)" />`;

    // Frame
    svg += `<rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}"
        fill="rgba(0,0,0,0.25)" stroke="rgba(140,160,200,0.3)" />`;

    // Grid + tick labels
    for (const xt of xTicks) {
        const x = xToPx(xt);
        svg += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}"
            stroke="rgba(140,160,200,0.12)" />`;
        svg += `<text x="${x}" y="${height - 6}" text-anchor="middle" fill="#8ab">${fmtX(xt)}</text>`;
    }
    for (const yt of yTicks) {
        const y = yToPx(yLog ? Math.pow(10, yt) : yt);
        svg += `<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}"
            stroke="rgba(140,160,200,0.12)" />`;
        svg += `<text x="${padL - 4}" y="${y + 3}" text-anchor="end" fill="#8ab">${fmtY(yt)}</text>`;
    }

    // Title + y-label
    if (title) {
        svg += `<text x="${padL}" y="${padT - 4}" fill="#bcd" font-weight="700">${_xmlEsc(title)}</text>`;
    }
    if (yLabel) {
        svg += `<text x="${padL - 38}" y="${padT + plotH / 2}"
            fill="#9ab" transform="rotate(-90, ${padL - 38}, ${padT + plotH / 2})"
            text-anchor="middle">${_xmlEsc(yLabel)}</text>`;
    }
    if (xLabel) {
        svg += `<text x="${padL + plotW / 2}" y="${height - 1}" fill="#9ab"
            text-anchor="middle">${_xmlEsc(xLabel)}</text>`;
    }

    // "Now" marker
    if (Number.isFinite(nowX) && nowX >= xMin && nowX <= xMax) {
        const x = xToPx(nowX);
        svg += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}"
            stroke="#0cc" stroke-dasharray="2,2" stroke-width="1" />`;
        svg += `<text x="${x + 3}" y="${padT + 9}" fill="#0cc">now</text>`;
    }

    // Series — one polyline per series, with NaN gaps split into segments.
    let legendX = padL + 4, legendY = padT + 11;
    for (const s of series) {
        const path = [];
        let inSeg = false;
        for (let i = 0; i < s.x.length; i++) {
            const xv = s.x[i], yv = s.y[i];
            const ok = Number.isFinite(xv) && Number.isFinite(yv) && (!yLog || yv > 0);
            if (!ok) { inSeg = false; continue; }
            const px = xToPx(xv), py = yToPx(yv);
            path.push(`${inSeg ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`);
            inSeg = true;
        }
        const dash = s.dashed ? `stroke-dasharray="3,3"` : '';
        svg += `<path d="${path.join(' ')}" fill="none" stroke="${s.color}"
            stroke-width="1.4" ${dash} />`;
        // Legend
        svg += `<rect x="${legendX}" y="${legendY - 6}" width="10" height="2"
            fill="${s.color}" />`;
        svg += `<text x="${legendX + 14}" y="${legendY - 1}" fill="${s.color}">${_xmlEsc(s.label)}</text>`;
        legendY += 11;
    }

    svg += `</svg>`;
    return svg;
}

function _xmlEsc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Slice one column out of a strided Float64Array into a fresh Float64Array.
 * Used to build chart series without copying the whole frame buffer.
 */
export function sliceColumn(flat, stride, col, n) {
    const len = n ?? Math.floor(flat.length / stride);
    const out = new Float64Array(len);
    for (let i = 0; i < len; i++) out[i] = flat[i * stride + col];
    return out;
}

/**
 * Compute drag pressure q = ½·ρ(h)·v² along an SGP4 trajectory by sampling
 * the ρ profile at each step's altitude. Returns a Float64Array of q in Pa.
 *
 * The integration math elsewhere uses BC·ρ·v (a per-mass deceleration); q
 * is the force/area felt by the surface, which is the more intuitive
 * "drag pressure" number the existing panel already shows for the named
 * refs at `_circularOrbitalSpeedKmS`. By using the *real* SGP4 speed we
 * pick up eccentric-orbit variation: q changes by ~10% perigee→apogee for
 * an e=0.05 orbit, which the circular surrogate misses entirely.
 */
export function dragPressureSeries(sgp4Flat, profileSamples) {
    const stride = SGP4_STRIDE;
    const n = Math.floor(sgp4Flat.length / stride);
    const out = new Float64Array(n);
    if (!profileSamples || profileSamples.length === 0) return out;
    // Sort once.
    const sorted = profileSamples
        .filter(s => Number.isFinite(s.altitudeKm) && Number.isFinite(s.rho) && s.rho > 0)
        .sort((a, b) => a.altitudeKm - b.altitudeKm);
    if (sorted.length === 0) return out;
    for (let i = 0; i < n; i++) {
        const off = i * stride;
        const altKm = sgp4Flat[off + SGP4_COL.ALT_KM];
        const speed = sgp4Flat[off + SGP4_COL.SPEED];
        if (!Number.isFinite(altKm) || !Number.isFinite(speed)) {
            out[i] = NaN;
            continue;
        }
        const rho = _logLerpRho(altKm, sorted);
        const v_ms = speed * 1000;
        out[i] = 0.5 * rho * v_ms * v_ms;
    }
    return out;
}

function _logLerpRho(altKm, sorted) {
    const n = sorted.length;
    if (altKm <= sorted[0].altitudeKm) return sorted[0].rho;
    if (altKm >= sorted[n - 1].altitudeKm) return sorted[n - 1].rho;
    let i = 0;
    while (i + 1 < n && sorted[i + 1].altitudeKm < altKm) i++;
    const t = (altKm - sorted[i].altitudeKm)
            / (sorted[i + 1].altitudeKm - sorted[i].altitudeKm);
    const r0 = Math.max(sorted[i].rho, 1e-30);
    const r1 = Math.max(sorted[i + 1].rho, 1e-30);
    return Math.exp(Math.log(r0) * (1 - t) + Math.log(r1) * t);
}
