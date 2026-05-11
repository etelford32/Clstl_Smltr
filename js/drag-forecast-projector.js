/**
 * drag-forecast-projector.js — short-horizon F10.7 / Ap projector
 * ═══════════════════════════════════════════════════════════════════════════
 * Pure-JS port of the AR(1) member from `rust-forecast/src/members/ar1.rs`,
 * applied to the realtime driver's 72-h ring buffer of (t, f107, ap)
 * samples. The realtime driver already produces the inputs we need (1Hz
 * Burton-fused state, 30 s ring resolution); we just need to project the
 * scalars forward at horizons {1, 3, 6, 12, 24} h.
 *
 * The actual AR(1) recursion is identical to the Rust crate — same μ,
 * same Yule-Walker φ estimator, same φ_max clamp — so swapping in the
 * compiled WASM build later is a drop-in replacement; the surrounding
 * code doesn't change. We do this in JS now to ship without a new build
 * step (rust-forecast is currently wired for weather observations and
 * would need a parallel crate for raw scalar projection).
 *
 *   y_t  ≈  μ + φ · (y_{t-1} - μ) + ε_t
 *
 * φ is the lag-1 sample autocorrelation, clipped to ±0.95 so a flat
 * recent series doesn't latch the recursion onto the last value.
 *
 * For F10.7 + Ap we resample the 30-second ring buffer to hourly bins
 * before fitting (otherwise the Yule-Walker estimator produces a near-1
 * φ from the over-sampled, near-constant inter-sample noise — that
 * makes the recursion drift instead of settling toward μ).
 *
 * Returns:
 *   { f107, ap, skill }
 *
 * `skill` ∈ (0, 1] decays roughly geometrically with horizon: 1.0 at
 * 0 h → 0.4 at 24 h. Used by the UI to dim the readout / show
 * uncertainty bars without claiming false precision.
 */

const PHI_MAX = 0.95;
const RESAMPLE_BIN_MS = 60 * 60 * 1000;   // 1 h
const MIN_SAMPLES_FOR_AR1 = 6;             // matches rust-forecast/ar1.rs:28

/**
 * Resample a (sorted-ascending) array of {t, ...values} samples into
 * uniformly-spaced hourly bins by mean. Skips bins with no samples by
 * carrying the previous bin's value forward — necessary for AR(1) fit
 * stability when the ring buffer has gaps (e.g. the page was idle).
 *
 * @param {Array<{t:number}>} hist
 * @param {function} valueFn  history sample → number (or NaN)
 * @returns {{ts:number[], ys:number[]}} parallel arrays
 */
function _resampleHourly(hist, valueFn) {
    if (!hist?.length) return { ts: [], ys: [] };
    const t0 = hist[0].t;
    const tN = hist[hist.length - 1].t;
    const nBins = Math.max(1, Math.ceil((tN - t0) / RESAMPLE_BIN_MS) + 1);
    const sums   = new Float64Array(nBins);
    const counts = new Int32Array(nBins);
    for (const h of hist) {
        const v = valueFn(h);
        if (!Number.isFinite(v)) continue;
        const k = Math.min(nBins - 1, Math.max(0, Math.floor((h.t - t0) / RESAMPLE_BIN_MS)));
        sums[k]   += v;
        counts[k] += 1;
    }
    const ts = new Array(nBins);
    const ys = new Array(nBins);
    let prev = NaN;
    for (let k = 0; k < nBins; k++) {
        ts[k] = t0 + k * RESAMPLE_BIN_MS;
        if (counts[k] > 0) {
            ys[k] = sums[k] / counts[k];
            prev  = ys[k];
        } else {
            ys[k] = prev;   // carry-forward; NaN if no prior sample yet
        }
    }
    return { ts, ys };
}

/**
 * AR(1) projection of one scalar series. Returns BOTH the point forecast
 * and its analytic forecast-error standard deviation at horizon h:
 *
 *   y_{t+h}  ≈  μ + φ^h · (y_t − μ)
 *   Var(y_{t+h})  =  σ²_ε · (1 + φ² + φ⁴ + … + φ^(2(h−1)))
 *                 =  σ²_ε · (1 − φ^(2h)) / (1 − φ²)
 *                 =  Var(y) · (1 − φ^(2h))         (under stationarity)
 *
 * So the forecast σ grows from 0 at h=0 toward `sd(y)` (climatology) as
 * h → ∞ — which is exactly the AR(1) uncertainty story: short-horizon
 * forecasts are sharp; long-horizon forecasts fan out to the historical
 * spread. We use this directly to feed ±σ envelopes around the
 * drag-decay curves.
 *
 * Mirrors `rust-forecast/src/members/ar1.rs::predict_24h` line-for-line
 * for the point forecast; the σ derivation is canonical AR(1) and lives
 * here in JS for now (no Rust crate change required).
 *
 * @returns {{ point:number, sigma:number, sdY:number, phi:number }}
 */
function _projectScalar(hist, valueFn, horizonHours) {
    const { ys } = _resampleHourly(hist, valueFn);
    const yClean = ys.filter(v => Number.isFinite(v));
    if (yClean.length < MIN_SAMPLES_FOR_AR1) {
        // Not enough samples → fall back to last-known value (persistence).
        // σ = 0 here is honest: we have no statistical basis to claim a
        // spread. The skill score (separately) tells the UI not to trust
        // this number too hard.
        const last = yClean.length ? yClean[yClean.length - 1] : NaN;
        return { point: last, sigma: 0, sdY: 0, phi: 0 };
    }

    const n  = yClean.length;
    const mu = yClean.reduce((a, b) => a + b, 0) / n;

    let num = 0, den = 0;
    for (let i = 1; i < n; i++) num += (yClean[i] - mu) * (yClean[i - 1] - mu);
    for (let i = 0; i < n; i++) den += (yClean[i] - mu) ** 2;
    if (den < 1e-9) return { point: mu, sigma: 0, sdY: 0, phi: 0 };

    const phiRaw = num / den;
    const phi    = Math.max(-PHI_MAX, Math.min(PHI_MAX, phiRaw));
    const sdY    = Math.sqrt(den / n);    // sample sd of the resampled series

    // Roll the AR(1) recursion forward `horizonHours` steps.
    let state = yClean[n - 1];
    let steps = Math.max(0, Math.round(horizonHours));
    while (steps > 0) {
        state = mu + phi * (state - mu);
        steps--;
    }

    // Forecast-error σ at horizon h. The (1 − φ^(2h)) factor grows
    // monotonically from 0 (h=0) toward 1 (h→∞), so σ ramps from 0 to
    // sd(y) — exactly the right "fans out toward climatology" behaviour.
    const h = Math.max(0, horizonHours);
    const phi2h = Math.pow(phi * phi, h);
    const sigma = sdY * Math.sqrt(Math.max(0, 1 - phi2h));

    return { point: state, sigma, sdY, phi };
}

/**
 * Per-horizon "skill" coefficient. Produces a 0–1 number we can paint
 * as an uncertainty cue. The exponential decay constant ≈18 h was
 * picked so the readout ages out gracefully but never collapses to
 * zero — the AR(1) projection is most accurate inside ~6 h, still
 * usable to ~24 h, and starts to look like climatology beyond that.
 */
function _skillForHorizon(horizonHours) {
    const h = Math.max(0, horizonHours);
    return Math.max(0.4, Math.exp(-h / 18));
}

/**
 * Project F10.7 and Ap forward by `horizonHours` using the realtime
 * driver's history ring. Returns the point forecast for each scalar,
 * its forecast-error σ (analytic AR(1) — see `_projectScalar`), and a
 * horizon-decay skill cue.
 *
 * The σ fields are what downstream callers feed into ±σ uncertainty
 * envelopes around the drag-decay curves. They asymptote to the
 * historical sd as the horizon grows — exactly the "fans out toward
 * climatology" behaviour an operator wants from a short-horizon AR(1).
 *
 * @param {Array<{t:number, f107?:number, ap?:number, apProxy?:number}>} history
 * @param {number} horizonHours
 * @param {object} [opts]
 * @param {boolean} [opts.useApProxy=true]
 * @returns {{
 *   f107:number, ap:number,
 *   sigmaF107:number, sigmaAp:number,
 *   sdF107:number, sdAp:number,           // historical sd (climatology spread)
 *   phiF107:number, phiAp:number,         // AR(1) persistence per scalar
 *   skill:number, horizonHours:number
 * }}
 */
export function projectDragState(history, horizonHours, opts = {}) {
    const useApProxy = opts.useApProxy !== false;
    const apFn = useApProxy
        ? (h) => Number.isFinite(h.ap) ? h.ap : h.apProxy
        : (h) => Number.isFinite(h.apSwpc) ? h.apSwpc : h.ap;

    const f = _projectScalar(history, h => h.f107, horizonHours);
    const a = _projectScalar(history, apFn,        horizonHours);

    // Ap is bounded ≥ 0 physically; clamp both the point and the σ-down
    // edge in projectDragEnvelope. F10.7 is also ≥0 in nature (~60 SFU
    // solar minimum floor); we clamp at 50 to keep the envelope from
    // implying a non-physical sub-solar-minimum atmosphere.
    return {
        f107:      Number.isFinite(f.point) ? f.point : NaN,
        ap:        Number.isFinite(a.point) ? Math.max(0, a.point) : NaN,
        sigmaF107: Number.isFinite(f.sigma) ? f.sigma : 0,
        sigmaAp:   Number.isFinite(a.sigma) ? a.sigma : 0,
        sdF107:    f.sdY,
        sdAp:      a.sdY,
        phiF107:   f.phi,
        phiAp:     a.phi,
        skill:     _skillForHorizon(horizonHours),
        horizonHours,
    };
}

/**
 * Three-scenario envelope for downstream uncertainty bands.
 *
 * Returns the same fields as `projectDragState` plus three explicit
 * forcing tuples:
 *
 *   nominal:  (f107,        ap)
 *   benign:   (f107 - σ,    ap - σ)   → less drag → higher altitude curve
 *   adverse:  (f107 + σ,    ap + σ)   → more drag → lower altitude curve
 *
 * `benign` / `adverse` are physically clamped: F10.7 ≥ 50 SFU (solar-
 * minimum floor) and Ap ≥ 0. Naming intentionally avoids "low/high"
 * because the *altitude* envelope flips relative to forcing.
 */
export function projectDragEnvelope(history, horizonHours, opts = {}) {
    const base = projectDragState(history, horizonHours, opts);
    const f107 = base.f107, ap = base.ap;
    const sf = base.sigmaF107, sa = base.sigmaAp;
    const clampF = (x) => Math.max(50,  Number.isFinite(x) ? x : f107);
    const clampA = (x) => Math.max(0,   Number.isFinite(x) ? x : ap);
    return {
        ...base,
        forcing: {
            nominal: { f107, ap },
            benign:  { f107: clampF(f107 - sf), ap: clampA(ap - sa) },
            adverse: { f107: clampF(f107 + sf), ap: clampA(ap + sa) },
        },
    };
}

/**
 * Convenience: project the full horizon set at once.
 * @returns {Array<{ horizonHours, f107, ap, skill }>}
 */
export const DEFAULT_DRAG_HORIZONS = [1, 3, 6, 12, 24];

export function projectDragHorizons(history, horizons = DEFAULT_DRAG_HORIZONS, opts = {}) {
    return horizons.map(h => projectDragState(history, h, opts));
}
