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

// Re-exports for testing.
export { _buildDriverSequence, _integrateForward, _smaAtEpoch };
