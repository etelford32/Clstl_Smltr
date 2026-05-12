/**
 * upper-atmosphere-backtest.js — Historical-TLE skill check (operator transparency)
 * ═══════════════════════════════════════════════════════════════════════════
 * Closes the operator's "do I trust this thing?" question. Given a TLE
 * issued N days ago for one of their assets, propagate the SAME drag-
 * decay model forward through the observed (F10.7, Ap) drivers that
 * existed at the time, and compare the model's prediction at the
 * current TLE's epoch with reality.
 *
 *   T0 = historical TLE epoch                (what the operator HAD)
 *   T1 = current   TLE epoch                 (what really happened)
 *   Δt = T1 − T0                              (typically 1–30 days)
 *
 *   a_pred(T1) = sequential RK4 integration from a_hist(T0) using the
 *                observed daily (F10.7, Ap) at every step
 *   a_real(T1) = osculating SMA of the current TLE at its own epoch
 *
 *   residual    = a_pred(T1) − a_real(T1)
 *   relativeErr = residual / a_real
 *   altErr      = residual    (SMA error ≈ altitude error for circular orbits)
 *
 * ── Why sequential? ──────────────────────────────────────────────────────
 * `drag_decay_rk4` takes ONE atmosphere profile and integrates Kozai drag
 * against it. Fine for 72-h forecasts; for a 30-day backtest, F10.7 swings
 * 30 SFU and Ap storms a few times. Honest physics requires walking the
 * window in 1-day chunks, re-sampling NRLMSISE-00 with that day's observed
 * forcing, and using the previous chunk's final SMA as the next chunk's
 * initial SMA. ~30 atmosphere samples + 30 RK4 calls ≈ 150 ms per backtest.
 *
 * ── MC calibration ───────────────────────────────────────────────────────
 * The point residual answers "how far off was the model?". The calibration
 * test answers "was the model HONEST about its uncertainty?":
 *
 *   1. Re-run the sequential integration with N draws on (F10.7, Ap, BC)
 *      *per day* — small Gaussian jitter on the daily drivers, drawn from
 *      the same σ_BC the asset carries.
 *   2. Collect N predicted final SMAs.
 *   3. Compute p5, p50, p95 across draws.
 *   4. Verdict:
 *        a_real ∈ [p5, p95]                  → 'calibrated'
 *        a_real < p5 (model over-shot)       → 'over-predicting alt'
 *        a_real > p95 (model under-shot)     → 'under-predicting alt'
 *      with the same 90% band Phase 9 uses for forward forecasts. This
 *      is the operator's "trust me, but how much" answer.
 *
 *      If the model is consistently 'over-predicting alt' on the operator's
 *      fleet, they should widen σ_BC or doubt the drag coefficient. If it
 *      is consistently 'under-predicting alt', their BC is too low.
 */

import {
    osculating_elements_at, parse_tle_info, drag_decay_rk4,
} from './sgp4-wasm/sgp4_wasm.js';
import { sampleProfileMSIS, isMsisReady } from './nrlmsise00-bridge.js';
import { getF107At, isLoaded as isF107Loaded } from './f107-history.js';
import { getApDailyMeanAt, isLoaded as isApLoaded } from './ap-history.js';
import { profileToRhoGrid } from './upper-atmosphere-trajectory-analysis.js';

const R_EARTH_KM = 6378.135;          // WGS-72, same as SGP4

// MC defaults — kept tight relative to the forecast MC because backtests
// only need to characterise the *calibration*, not produce a forecast band.
// N=32 hits stable percentile bands with ~2 ms compute on top of the
// nominal sequential integration.
const MC_DEFAULT_N    = 32;
const MC_F107_JITTER  = 0.0;    // intra-day jitter on top of observed daily — observed F10.7 IS the observation
const MC_AP_JITTER    = 0.0;    // same — Ap was observed, not predicted, so no driver uncertainty

// ── TLE epoch helper ────────────────────────────────────────────────────────

/** Parse a TLE's epoch_jd → Unix ms. */
function _tleEpochMs(line1, line2) {
    const info = parse_tle_info(line1, line2);
    if (!info?.epoch_jd) return NaN;
    return (info.epoch_jd - 2440587.5) * 86400 * 1000;
}

/** SGP4 SMA at a TLE's own epoch. The Kozai mean-motion approximation
 *  is used as a fallback when the WASM osculating-elements call fails
 *  (rare; only for TLEs that fail SGP4 init). */
function _smaAtEpoch(line1, line2) {
    try {
        const osc = osculating_elements_at(line1, line2, 0);
        if (osc?.sma_km && Number.isFinite(osc.sma_km) && osc.sma_km > R_EARTH_KM) {
            return osc.sma_km;
        }
    } catch (_) { /* fall through */ }
    // Fallback via Kepler's third law on mean motion.
    const info = parse_tle_info(line1, line2);
    const n_rad_s = info.mean_motion_rev_day * (2 * Math.PI) / 86400;
    const MU = 398600.8;
    return Math.cbrt(MU / (n_rad_s * n_rad_s));
}

// ── Driver sequence assembly ────────────────────────────────────────────────

/**
 * Build a day-by-day [t, f107, ap] sequence covering [T0, T1] using
 * ONLY observed drivers. Returns null when any day in the window is
 * unavailable — backtests with missing observations are nonsense, so
 * the caller should surface "drivers unavailable" to the operator
 * rather than silently fall back to climatology.
 *
 * `T0` and `T1` are Unix ms.
 */
function _buildDriverSequence(t0Ms, t1Ms) {
    if (!isF107Loaded() || !isApLoaded()) return null;
    const days = Math.max(1, Math.round((t1Ms - t0Ms) / 86400000));
    const seq = [];
    for (let i = 0; i < days; i++) {
        // Anchor each step at noon UTC of the historical day — same as
        // the f107 file's noon-anchor convention. The first step covers
        // [T0, T0+1d), the second [T0+1d, T0+2d), etc.
        const t = t0Ms + i * 86400000 + 12 * 3600000;
        const f107 = getF107At(t);
        const ap   = getApDailyMeanAt(t);
        if (!Number.isFinite(f107) || !Number.isFinite(ap)) {
            return { error: 'drivers-unavailable', dayIndex: i, dayMs: t };
        }
        seq.push({ tMs: t, f107, ap });
    }
    return { seq, days };
}

// ── Single-trajectory backtest (point estimate) ─────────────────────────────

/**
 * Run the deterministic sequential integration. Returns the final SMA
 * after walking from a0 forward through the driver sequence's days.
 */
function _integrateForward({ seq, a0Km, bcM2PerKg, scalarF107Mult = 1, scalarApMult = 1 }) {
    if (!isMsisReady()) return null;
    let a = a0Km;
    const dailyMin = 24 * 60;
    const altGridForDay = (f107, ap) => {
        const f = Math.max(50, f107 * scalarF107Mult);
        const A = Math.max(0,  ap   * scalarApMult);
        const profile = sampleProfileMSIS({
            f107Sfu: f, ap: A,
            minKm: 80, maxKm: 2000, nPoints: 120,
        });
        if (!profile) return null;
        return profileToRhoGrid(profile.samples);
    };
    for (const day of seq) {
        const { alt, rho } = altGridForDay(day.f107, day.ap) || {};
        if (!alt || alt.length < 2) return null;
        try {
            const flat = drag_decay_rk4(
                a, bcM2PerKg, dailyMin,
                60,              // 60-s RK4 sub-step (matches forecast analyzer)
                dailyMin,        // single output sample at end of day
                alt, rho,
                1.0,
            );
            if (!flat || flat.length < 5) return null;
            // flat is stride-5; last row's SMA is the day's end state.
            const stride = 5;
            const nOut = flat.length / stride;
            a = flat[(nOut - 1) * stride + 1];   // DRAG_COL.SMA_KM = 1
            if (!Number.isFinite(a) || a < R_EARTH_KM) return null;
        } catch (_) { return null; }
    }
    return a;
}

// ── Tiny RNG (xorshift32, same family as upper-atmosphere-mc) ───────────────

function _xorshift32Factory(seed) {
    let s = (seed | 0) || 0x9e3779b9;
    return function next() {
        s ^= s << 13; s |= 0;
        s ^= s >>> 17;
        s ^= s << 5;  s |= 0;
        return ((s >>> 0) / 0x100000000) || 0.5;
    };
}
function _stdNormalPair(u) {
    let u1 = u(); const u2 = u();
    if (u1 < 1e-12) u1 = 1e-12;
    const r = Math.sqrt(-2 * Math.log(u1));
    const θ = 2 * Math.PI * u2;
    return [r * Math.cos(θ), r * Math.sin(θ)];
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run a backtest. Returns:
 *
 *   {
 *     ok: true,
 *     deltaDays:         number,
 *     a0_km, a_pred_km, a_real_km,
 *     residual_km:       a_pred − a_real (positive = model over-predicted alt)
 *     relativeError:     fraction of a_real
 *     mc: {
 *       n: number,
 *       p5_km, p50_km, p95_km,
 *       inBand:          a_real_km within [p5, p95]
 *       verdict:         'calibrated' | 'over-predicting alt' | 'under-predicting alt'
 *     } | null,
 *     drivers: {
 *       days: number,
 *       meanF107: number,
 *       meanAp:  number,
 *     },
 *   }
 *
 * Or { ok:false, reason } on error. Common reasons:
 *   'wasm-not-ready'        — MSIS WASM hasn't initialised
 *   'tle-parse-failed'      — either TLE didn't validate
 *   'norad-mismatch'        — historical and current TLEs are for
 *                             different assets (caller's responsibility
 *                             to confirm; we report mismatch as soft warning)
 *   'reverse-time'          — historical TLE epoch is later than current
 *   'drivers-unavailable'   — F10.7 or Ap missing for some day in the window
 *   'integration-failed'    — Kozai integration produced a non-finite SMA
 */
export async function runBacktest({
    historicalLine1, historicalLine2,
    currentLine1,    currentLine2,
    bcM2PerKg,
    bcSigmaRel = 0.15,
    monteCarloN = MC_DEFAULT_N,
    seed,
} = {}) {
    if (!isMsisReady()) return { ok: false, reason: 'wasm-not-ready' };

    // Parse both TLEs + compute epochs.
    let infoH, infoC, t0Ms, t1Ms, noradH, noradC, a0Km, a1Km;
    try {
        infoH = parse_tle_info(historicalLine1, historicalLine2);
        infoC = parse_tle_info(currentLine1,    currentLine2);
        t0Ms  = _tleEpochMs(historicalLine1, historicalLine2);
        t1Ms  = _tleEpochMs(currentLine1,    currentLine2);
        noradH = parseInt(historicalLine1.slice(2, 7).trim(), 10);
        noradC = parseInt(currentLine1.slice(2, 7).trim(),    10);
        a0Km  = _smaAtEpoch(historicalLine1, historicalLine2);
        a1Km  = _smaAtEpoch(currentLine1,    currentLine2);
    } catch (_) {
        return { ok: false, reason: 'tle-parse-failed' };
    }
    if (!Number.isFinite(t0Ms) || !Number.isFinite(t1Ms))
        return { ok: false, reason: 'tle-parse-failed' };
    if (t1Ms <= t0Ms)  return { ok: false, reason: 'reverse-time' };
    if (!Number.isFinite(a0Km) || !Number.isFinite(a1Km))
        return { ok: false, reason: 'tle-parse-failed' };
    const noradMatch = (Number.isInteger(noradH) && Number.isInteger(noradC) && noradH === noradC);

    // Build the daily driver sequence.
    const driverResult = _buildDriverSequence(t0Ms, t1Ms);
    if (!driverResult?.seq) {
        return {
            ok: false, reason: driverResult?.error || 'drivers-unavailable',
            dayIndex: driverResult?.dayIndex ?? null,
        };
    }
    const seq = driverResult.seq;

    // Deterministic point integration.
    const aPredKm = _integrateForward({ seq, a0Km, bcM2PerKg });
    if (!Number.isFinite(aPredKm)) {
        return { ok: false, reason: 'integration-failed' };
    }

    const residual    = aPredKm - a1Km;
    const relativeErr = residual / a1Km;

    // Driver summary for the UI tooltip.
    let sumF107 = 0, sumAp = 0;
    for (const d of seq) { sumF107 += d.f107; sumAp += d.ap; }
    const drivers = {
        days:       seq.length,
        meanF107:   sumF107 / seq.length,
        meanAp:     sumAp   / seq.length,
    };

    // ── MC calibration ─────────────────────────────────────────────────
    // We jitter ONLY BC across draws — F10.7 and Ap are observations, not
    // predictions, so they shouldn't carry forecast σ here. The point of
    // this MC is "given the asset's modelling uncertainty (BC σ), did the
    // observed outcome fall in the band the model would have produced?".
    let mc = null;
    if (monteCarloN > 0) {
        const uniform = seed != null ? _xorshift32Factory(seed) : Math.random;
        const finals = [];
        for (let i = 0; i < monteCarloN; i += 2) {
            const [z1, z2] = _stdNormalPair(uniform);
            for (const z of [z1, z2]) {
                if (finals.length >= monteCarloN) break;
                const bcDraw = bcM2PerKg * Math.max(0.1, 1 + bcSigmaRel * z);
                const aDraw  = _integrateForward({ seq, a0Km, bcM2PerKg: bcDraw });
                if (Number.isFinite(aDraw)) finals.push(aDraw);
            }
        }
        if (finals.length >= 4) {
            finals.sort((a, b) => a - b);
            const pick = (p) => finals[Math.min(finals.length - 1,
                Math.max(0, Math.floor((p / 100) * (finals.length - 1))))];
            const p5  = pick(5), p50 = pick(50), p95 = pick(95);
            const inBand = a1Km >= p5 && a1Km <= p95;
            // Sign convention for verdict: 'over-predicting alt' = model's
            // p5..p95 sits ABOVE the actual (we predicted more altitude
            // than reality delivered = under-estimated drag).
            const verdict = inBand            ? 'calibrated'
                          : a1Km < p5         ? 'over-predicting alt'
                                              : 'under-predicting alt';
            mc = {
                n:       finals.length,
                p5_km:   p5,
                p50_km:  p50,
                p95_km:  p95,
                inBand,
                verdict,
            };
        }
    }

    return {
        ok:           true,
        deltaDays:    (t1Ms - t0Ms) / 86400000,
        a0_km:        a0Km,
        a_pred_km:    aPredKm,
        a_real_km:    a1Km,
        residual_km:  residual,
        relativeError: relativeErr,
        mc,
        drivers,
        noradMatch,
        t0Ms, t1Ms,
    };
}

// ── Fleet-wide skill aggregation ────────────────────────────────────────────
//
// Phase 14: run a backtest on every asset that has an archived TLE in the
// target age window, then summarise the calibration verdicts across the
// fleet. The aggregate answers "is the WHOLE fleet being modelled well,
// not just a single asset?"

/**
 * Pick the archived TLE closest to `targetDays` ago, among entries within
 * [minDays, maxDays]. Returns null when the asset has no eligible history.
 *
 *   minDays  — too-recent TLEs don't carry useful skill signal
 *              (the asset hasn't drifted enough vs the model)
 *   maxDays  — older than what observed drivers cover (~30 days for Ap,
 *              ~50 for F10.7); backtest would fail with drivers-unavailable
 */
export function pickHistoricalForBacktest(asset, {
    targetDays = 7, minDays = 2, maxDays = 28,
} = {}) {
    if (!asset?.line1 || !Array.isArray(asset.tleHistory) || asset.tleHistory.length === 0) {
        return null;
    }
    const nowEpochMs = (() => {
        const yy = parseInt(asset.line1.slice(18, 20), 10);
        const doyf = parseFloat(asset.line1.slice(20, 32));
        if (!Number.isInteger(yy) || !Number.isFinite(doyf)) return Date.now();
        const year = yy < 57 ? 2000 + yy : 1900 + yy;
        return Date.UTC(year, 0, 1) + (doyf - 1) * 86400000;
    })();
    let best = null, bestScore = Infinity;
    for (const h of asset.tleHistory) {
        if (!h?.line1 || !h?.line2 || !Number.isFinite(h.epochMs)) continue;
        const ageDays = (nowEpochMs - h.epochMs) / 86400000;
        if (ageDays < minDays || ageDays > maxDays) continue;
        // Score by distance from the target age — closer to target wins.
        const score = Math.abs(ageDays - targetDays);
        if (score < bestScore) { bestScore = score; best = h; }
    }
    return best;
}

/**
 * Run a backtest for every asset in the fleet that has an eligible
 * historical TLE, then aggregate the calibration verdicts.
 *
 * @param {Array} assets     fleet store entries (line1/line2 + tleHistory)
 * @param {object} [opts]
 * @param {number} [opts.targetDays=7]
 * @param {number} [opts.monteCarloN=24]   smaller default than per-card
 *                                          backtest — fleet runs 25 in series
 * @param {number} [opts.seed=12345]       deterministic seed for repeatable
 *                                          fleet-skill outputs across reloads
 * @returns {Promise<{ summary, results }>}
 *
 *   results: per-asset record of the backtest outcome, keyed by asset.id:
 *     {
 *       assetId, name, noradId,
 *       status: 'ok' | 'no-history' | 'driver-gap' | 'too-recent' | 'failed',
 *       reason, deltaDays, residual_km, relativeError, verdict, inBand,
 *     }
 *   summary: aggregate over results
 *     {
 *       total, eligible,
 *       calibrated, over, under,
 *       noHistory, driverGap, failed,
 *       calibratedFrac: calibrated / eligible (NaN when eligible=0),
 *       medianAbsResidualKm, p95AbsResidualKm,
 *     }
 */
export async function runFleetSkill(assets, {
    targetDays = 7, monteCarloN = 24, seed = 12345,
} = {}) {
    const results = {};
    const residuals = [];
    let calibrated = 0, over = 0, under = 0;
    let noHistory = 0, driverGap = 0, failed = 0, tooRecent = 0;

    for (let i = 0; i < assets.length; i++) {
        const a = assets[i];
        if (a.status !== 'ready' || !a.line1 || !a.line2) {
            results[a.id] = { assetId: a.id, name: a.name, noradId: a.noradId,
                              status: 'failed', reason: 'asset-not-ready' };
            failed++;
            continue;
        }
        const hist = pickHistoricalForBacktest(a, { targetDays });
        if (!hist) {
            const why = (Array.isArray(a.tleHistory) && a.tleHistory.length > 0)
                ? 'too-recent' : 'no-history';
            results[a.id] = {
                assetId: a.id, name: a.name, noradId: a.noradId,
                status: why,
                reason: why === 'no-history'
                    ? 'refresh asset over a few days to build history'
                    : 'all archived TLEs are within the min-age window',
            };
            if (why === 'no-history') noHistory++; else tooRecent++;
            continue;
        }
        // Stagger draws by asset index so seeded MC across the fleet doesn't
        // reuse the same Box-Muller pairs everywhere.
        const r = await runBacktest({
            historicalLine1: hist.line1, historicalLine2: hist.line2,
            currentLine1:    a.line1,    currentLine2:    a.line2,
            bcM2PerKg:       a.bcM2PerKg,
            bcSigmaRel:      a.bcSigmaRel,
            monteCarloN,
            seed:            seed + i * 7919,    // any large prime offset
        });
        if (!r?.ok) {
            const status = r?.reason === 'drivers-unavailable' ? 'driver-gap' : 'failed';
            results[a.id] = {
                assetId: a.id, name: a.name, noradId: a.noradId,
                status, reason: r?.reason || 'backtest failed',
            };
            if (status === 'driver-gap') driverGap++; else failed++;
            continue;
        }
        const verdict = r.mc?.verdict || (Math.abs(r.relativeError) < 5e-4 ? 'calibrated'
            : r.residual_km > 0 ? 'under-predicting alt' : 'over-predicting alt');
        if (verdict === 'calibrated')              calibrated++;
        else if (verdict === 'over-predicting alt') over++;
        else if (verdict === 'under-predicting alt') under++;
        results[a.id] = {
            assetId: a.id, name: a.name, noradId: a.noradId,
            status: 'ok',
            deltaDays:     r.deltaDays,
            residual_km:   r.residual_km,
            relativeError: r.relativeError,
            verdict,
            inBand:        r.mc?.inBand ?? null,
            mcBand:        r.mc ? { p5: r.mc.p5_km, p50: r.mc.p50_km, p95: r.mc.p95_km, n: r.mc.n } : null,
            historicalEpochMs: hist.epochMs,
            currentEpochMs:    r.t1Ms,
            drivers:           r.drivers,
        };
        residuals.push(Math.abs(r.residual_km));
    }

    residuals.sort((a, b) => a - b);
    const pickResid = (p) => residuals.length === 0 ? null :
        residuals[Math.min(residuals.length - 1, Math.max(0, Math.floor((p / 100) * (residuals.length - 1))))];
    const eligible = calibrated + over + under;
    return {
        summary: {
            total:       assets.length,
            eligible,
            calibrated, over, under,
            noHistory, driverGap, failed, tooRecent,
            calibratedFrac: eligible > 0 ? calibrated / eligible : NaN,
            medianAbsResidualKm: pickResid(50),
            p95AbsResidualKm:    pickResid(95),
            targetDays,
            ranAt: Date.now(),
        },
        results,
    };
}

// ── Anomaly detection (Phase 15) ────────────────────────────────────────────
//
// The operator's question: "Has something CHANGED about this asset?" —
// new attitude regime, recent maneuver, debris event, geometry change.
// Operationally we answer it by looking at the residual time series
// the fleet-skill sweeps produce: when the LATEST residual sits >3σ
// away from the asset's OWN historical median, the model's assumptions
// no longer fit the asset.
//
// We use robust statistics (median + median-absolute-deviation) rather
// than mean + standard deviation:
//   - one storm-driven outlier shouldn't trash the baseline
//   - MAD is the established robust σ for unimodal distributions
//   - 1.4826 makes MAD numerically equivalent to σ under a normal
//     distribution, so "3σ" thresholds still mean what operators expect
//
// Pre-filtering: we drop history entries whose (bcM2PerKg, bcSigmaRel)
// don't match the current asset state. Changing σ_BC shifts the
// residual systematically, so older entries aren't comparable.

const MAD_TO_SIGMA  = 1.4826;
const Z_THRESHOLD   = 3.0;
const MIN_SAMPLES   = 5;        // need at least 5 prior points for a stable MAD
// Practical-significance floor: an asset whose model fits the last week
// to within 0.5 km isn't telling the operator anything actionable even
// if a 0.05 km blip is technically 3σ off a 0.015 km baseline. Z-threshold
// gates "is this statistically a change?"; this gates "is the magnitude
// operationally interesting?". BOTH must trip to flag an anomaly.
const MIN_DEVIATION_KM = 0.5;

/**
 * Detect whether the latest residual on an asset's history is an
 * anomaly relative to its own past.
 *
 * @param {object} asset                fleet-store entry with residualHistory
 * @param {object} [opts]
 * @param {number} [opts.zThreshold=3]
 * @param {number} [opts.minSamples=5]
 * @returns {{
 *   isAnomaly: boolean,
 *   reason?: string,           // when isAnomaly=false and we know why
 *   latestResidual: number|null,
 *   latestRanAt:    number|null,
 *   median: number|null,
 *   sigma:  number|null,       // = MAD × 1.4826 (normal-equivalent σ)
 *   z:      number|null,       // |latest − median| / sigma
 *   sampleCount: number,       // entries used in stats (after BC filter)
 *   totalCount:  number,
 *   trimmedForBcChange: number,
 *   direction: 'high' | 'low' | null,  // sign of (latest − median)
 * }}
 */
export function detectAnomaly(asset, {
    zThreshold      = Z_THRESHOLD,
    minSamples      = MIN_SAMPLES,
    minDeviationKm  = MIN_DEVIATION_KM,
} = {}) {
    const totalCount = Array.isArray(asset?.residualHistory)
        ? asset.residualHistory.length : 0;
    const baseRet = {
        isAnomaly: false, reason: 'no-history',
        latestResidual: null, latestRanAt: null,
        median: null, sigma: null, z: null,
        sampleCount: 0, totalCount,
        trimmedForBcChange: 0,
        direction: null,
    };
    if (totalCount === 0) return baseRet;

    // Filter entries that match the asset's CURRENT BC params — residual
    // is sensitive to BC, so old-config entries aren't comparable.
    const bc  = asset.bcM2PerKg ?? null;
    const bcS = asset.bcSigmaRel ?? null;
    const tol = 1e-6;
    const filtered = asset.residualHistory.filter(e =>
        Math.abs((e.bcM2PerKg  ?? bc)  - bc)  < tol &&
        Math.abs((e.bcSigmaRel ?? bcS) - bcS) < tol);
    const trimmed  = totalCount - filtered.length;

    // The latest entry IS the candidate; we need ≥ minSamples PRIOR
    // entries to score it against. So total filtered count needs
    // minSamples + 1.
    if (filtered.length < minSamples + 1) {
        return {
            ...baseRet,
            reason: 'too-few-samples',
            sampleCount: filtered.length,
            trimmedForBcChange: trimmed,
            latestResidual: filtered[filtered.length - 1]?.residual_km ?? null,
            latestRanAt:    filtered[filtered.length - 1]?.ranAt        ?? null,
        };
    }

    // Sort by ranAt, take the LAST entry as the candidate, evaluate
    // it against the median + MAD of all earlier filtered entries.
    const sorted = filtered.slice().sort((a, b) => a.ranAt - b.ranAt);
    const latest = sorted[sorted.length - 1];
    const prior  = sorted.slice(0, -1).map(e => e.residual_km);

    // Robust stats: median, then median absolute deviation.
    const sortedPrior = prior.slice().sort((a, b) => a - b);
    const median = _median(sortedPrior);
    const deviations = sortedPrior.map(v => Math.abs(v - median)).sort((a, b) => a - b);
    const mad = _median(deviations);
    // Sigma equivalent (normal-distribution interpretation). A flat
    // series with MAD=0 implies the prior was perfectly consistent;
    // any deviation now is "infinitely many σ" — we floor sigma to
    // a small epsilon to keep z finite for the operator.
    const sigma = Math.max(mad * MAD_TO_SIGMA, 1e-6);
    const delta = latest.residual_km - median;
    const z = Math.abs(delta) / sigma;
    // Composite gate: both statistical AND practical significance.
    const tripsZ      = z >= zThreshold;
    const tripsMag    = Math.abs(delta) >= minDeviationKm;
    const isAnomaly   = tripsZ && tripsMag;

    return {
        isAnomaly,
        reason: isAnomaly ? null
                          : tripsZ      ? 'sub-magnitude'  // z fired but Δ too small
                          : tripsMag    ? 'sub-sigma'      // Δ big but not statistically significant
                                        : 'within-band',
        latestResidual: latest.residual_km,
        latestRanAt:    latest.ranAt,
        median, sigma, z,
        sampleCount: prior.length,
        totalCount,
        trimmedForBcChange: trimmed,
        direction: delta > 0 ? 'high' : delta < 0 ? 'low' : null,
    };
}

function _median(sortedArr) {
    if (!sortedArr.length) return 0;
    const n = sortedArr.length;
    return n % 2 === 1
        ? sortedArr[(n - 1) / 2]
        : 0.5 * (sortedArr[n / 2 - 1] + sortedArr[n / 2]);
}

/**
 * Sweep `detectAnomaly` across the fleet. Returns the per-asset detector
 * outputs keyed by id, plus a summary count.
 */
export function detectFleetAnomalies(assets, opts) {
    const byId = {};
    let anomalous = 0, eligible = 0;
    for (const a of assets) {
        const det = detectAnomaly(a, opts);
        byId[a.id] = det;
        if (det.reason !== 'no-history' && det.reason !== 'too-few-samples') {
            eligible++;
            if (det.isAnomaly) anomalous++;
        }
    }
    return {
        summary: { total: assets.length, eligible, anomalous },
        byId,
    };
}

// ── Phase 18: anomaly ↔ conjunction correlation ─────────────────────────────
//
// When an asset gets flagged as anomalous AND it recently appeared in a
// high-P conjunction event, the operator most-likely cause is an
// avoidance maneuver (operator burned a small Δv to dodge, the model
// doesn't know about the burn, so the new TLE diverges from the
// pre-burn predicted trajectory → anomaly).
//
// Causal-window operational reasoning:
//   - Conjunction predicted at TCA = T₀
//   - Operator schedules avoidance ~12-48h before T₀ (faster for late
//     warnings; slower for fragile assets like Hubble)
//   - New post-burn TLE published a few hours to a day later
//   - Our backtest comparing pre-burn TLE (in tleHistory) to post-burn
//     TLE (current) shows altitude drift → anomaly fires
//   - So the anomaly's `latestRanAt` lands AFTER the maneuver, which is
//     AT/BEFORE TCA. The "best" causal match has TCA roughly 1–3 days
//     before the anomaly observation.
//
// We don't claim certainty — we just surface "possible cause" with a
// score. Operator decides.

const CORR_TCA_MIN_DAYS_BACK   = -1;   // TCA still pending → maneuver in flight
const CORR_TCA_MAX_DAYS_BACK   = 14;   // older than 2 weeks unlikely to be the cause
const CORR_PCONJ_FLOOR         = 0.05; // <5% prob isn't worth blaming
const CORR_RECENCY_PEAK_DAYS   = 2;    // most-likely-causal lag
const CORR_RECENCY_DECAY_DAYS  = 5;    // Gaussian σ around the peak
const CORR_SCORE_THRESHOLD     = 0.05; // composite score required to surface

/**
 * Find the most likely conjunction event responsible for an anomaly,
 * if any. Scoring: pConj × Gaussian(daysGap centered at causal peak).
 *
 * Phase 19: also infers a maneuver-type hint from the residual direction.
 * Sign convention: residual_km = a_pred − a_real, anomDet.direction is
 * the sign of (latest − median):
 *
 *   direction='high'  latest residual UP   →  model over-predicts alt
 *                                              MORE than usual → sat is
 *                                              LOWER than expected → likely
 *                                              a brake burn (rare for
 *                                              conjunction avoidance, more
 *                                              common for end-of-life or
 *                                              an unmodelled drag spike)
 *   direction='low'   latest residual DOWN →  sat HIGHER than expected →
 *                                              likely a boost burn (the
 *                                              canonical avoidance burn:
 *                                              raise orbit, phase shift,
 *                                              drift away from approach)
 *
 * The hint is operator-grade ambiguous — we can't tell a boost burn from
 * a benign drag-coefficient surprise without telemetry, so the tooltip
 * always carries a question mark.
 *
 * @param {object} asset                fleet entry (must have `id`)
 * @param {object} anomDet              output of detectAnomaly()
 * @param {Array}  archive              output of getConjunctionArchive()
 * @returns {{
 *   topMatch: object,                  // the conjunction-archive entry
 *   partnerName: string,
 *   pConj: number,
 *   daysGap: number,                   // anomaly observation − TCA, days
 *   score: number,                     // composite score [0..1]
 *   maneuverHint: 'boost' | 'brake' | null,   // direction inference
 * }|null}
 */
export function correlateAnomalyWithConjunctions(asset, anomDet, archive) {
    if (!anomDet?.isAnomaly || !Number.isFinite(anomDet.latestRanAt)) return null;
    if (!Array.isArray(archive) || archive.length === 0) return null;
    const tAnom = anomDet.latestRanAt;
    const involved = archive.filter(e =>
        (e.idA === asset.id || e.idB === asset.id)
        && Number.isFinite(e.tcaAbsMs)
        && Number.isFinite(e.pConj)
        && e.pConj >= CORR_PCONJ_FLOOR);
    if (involved.length === 0) return null;

    let best = null;
    for (const e of involved) {
        const daysGap = (tAnom - e.tcaAbsMs) / 86400000;
        if (daysGap < CORR_TCA_MIN_DAYS_BACK || daysGap > CORR_TCA_MAX_DAYS_BACK) continue;
        // Gaussian recency weight, peaking at CORR_RECENCY_PEAK_DAYS.
        // For TCA STILL PENDING (negative daysGap), use 0 distance from
        // peak — operator may already be maneuvering pre-burn.
        const distFromPeak = daysGap < 0
            ? Math.abs(CORR_RECENCY_PEAK_DAYS)            // crude, fine for the operator hint
            : Math.abs(daysGap - CORR_RECENCY_PEAK_DAYS);
        const recency = Math.exp(-((distFromPeak / CORR_RECENCY_DECAY_DAYS) ** 2));
        const score = e.pConj * recency;
        if (!best || score > best.score) {
            best = {
                topMatch: e,
                partnerName: e.idA === asset.id ? e.nameB : e.nameA,
                pConj:   e.pConj,
                daysGap,
                score,
            };
        }
    }
    if (!best || best.score < CORR_SCORE_THRESHOLD) return null;
    // Phase 19: maneuver-type hint from anomaly direction.
    //   direction='low'   sat HIGHER than expected → boost (raise orbit)
    //   direction='high'  sat LOWER than expected  → brake (rare for
    //                                                  conj avoidance)
    best.maneuverHint = anomDet.direction === 'low'  ? 'boost'
                      : anomDet.direction === 'high' ? 'brake'
                                                     : null;
    return best;
}

/**
 * Fleet-wide tally of anomaly↔conjunction correlations. Counts how
 * many anomalous assets have a likely conjunction-related cause —
 * useful for the dashboard chip "⚠ 3 anomalies (2 likely conj-related)".
 *
 * Cheap: re-uses already-computed detector + archive. No re-sweeping.
 */
export function tallyAnomalyConjunctionCorrelations(assets, anomalyByIdOrFn, archive) {
    const getDet = typeof anomalyByIdOrFn === 'function'
        ? anomalyByIdOrFn
        : (a) => anomalyByIdOrFn?.[a.id] || null;
    let related = 0, anomalous = 0;
    for (const a of assets) {
        const det = getDet(a);
        if (!det?.isAnomaly) continue;
        anomalous++;
        if (correlateAnomalyWithConjunctions(a, det, archive)) related++;
    }
    return { anomalous, related };
}

// Re-exports for testing.
export { _buildDriverSequence, _integrateForward, _smaAtEpoch, _median };
