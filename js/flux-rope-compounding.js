/**
 * flux-rope-compounding.js — the ONE §16 compounding COUNTERFACTUAL
 * measurement, shared by every consumer (sun.html's Forecast tab via
 * js/sun-flux-rope.js re-exports, and the daily validation cron
 * api/cron/validation-rerun.js, which locks the result into the
 * flux-rope-v1 ledger so it gets SCORED against L1 outcomes).
 *
 * measureCompounding(fc) — how much does CME–CME interaction (spec §16 —
 * wake kinematics, dynamic rear compression, wake-conditioned sheaths)
 * change this exact forecast? Method: a strict counterfactual — a SECOND
 * kernel instance seeded with the identical ropes, priors, ensemble seed
 * and grid, §16 interaction OFF (the kernel documents disabled as
 * bit-identical to the non-interacting train), so every delta is
 * attributable to the interaction physics alone. Both sides are PRIOR
 * ensembles (unassimilated) — the honest apples-to-apples, since the
 * counterfactual cannot be conditioned on observations produced by the
 * interacting sun. Scalar probabilities are computed from the COPIED
 * per-member arrays, never the result's live pMinBzBelow closure (which
 * reads current WASM state and is stale the moment the provider's
 * assimilation reweights it). Per-rope rows carry the deterministic
 * L1-crossing shift plus the kernel's own §16 analyzer probes (leader
 * index, wake Δv, drag ratio, rear compression). Trains only — a single
 * rope has nothing to compound (null).
 *
 * `quantileLevels` (the validation ledger passes ARRIVAL_Q_LEVELS) makes
 * both sides also emit train-onset arrival quantiles — the OFF side's is
 * what the ledger freezes as `arrival_q_off`, so at resolution the SAME
 * CRPS that scores the interacting forecast scores the independent one,
 * and their difference is the compounding skill on a real event.
 *
 * observedMinBz(rtsw, t0, t1) — PURE: the deepest observed L1 Bz inside a
 * window — the live ground-truth hook (full per-event scoring lives in
 * js/flux-rope-validation.js, not here).
 *
 * Pure logic node-gated by tests/sun-flux-rope.mjs (through the
 * re-exports, against the REAL committed WASM) and consumed by
 * tests/flux-rope-validation.mjs fixtures.
 */

import { trainSeed, FORECAST_DEFAULTS } from './flux-rope-forecast.js';
import { loadFluxRopeKernel, L1_OBSERVER } from './flux-rope-kernel.js';

const AU_KM = 1.495978707e8;

/** Fraction of ensemble members whose min Bz dips below `thr` [nT], from the
 *  COPIED per-member array (misses carry non-finite/shallow values and count
 *  in the denominator — same convention as the kernel's own estimator). */
export function pBelowFromMinBz(minBz, thr) {
    if (!minBz?.length) return null;
    let below = 0;
    for (const v of minBz) if (Number.isFinite(v) && v < thr) below++;
    return below / minBz.length;
}

/** Median of the finite entries; null when none. */
export function medianFinite(arr) {
    const f = Array.from(arr ?? []).filter(Number.isFinite).sort((a, b) => a - b);
    return f.length ? f[Math.floor(f.length / 2)] : null;
}

/** Empirical quantiles at `levels` over the finite entries — the SAME
 *  order-statistic convention as flux-rope-validation.js arrivalQuantilesH
 *  (floor(n·p)), so ON- and OFF-side quantiles stay CRPS-comparable.
 *  Null below 10 finite members (a thin ensemble is not a distribution). */
export function arrivalQuantiles(arr, levels) {
    const a = Array.from(arr ?? []).filter(Number.isFinite).sort((x, y) => x - y);
    if (a.length < 10 || !levels?.length) return null;
    return levels.map((p) => a[Math.min(a.length - 1, Math.floor(a.length * p))]);
}

function minOver(arr) {
    let m = Infinity;
    for (const v of arr) if (Number.isFinite(v) && v < m) m = v;
    return Number.isFinite(m) ? m : null;
}

/**
 * Deterministic L1-crossing time of rope `i` [hours after the train epoch]
 * on `kernel`'s CURRENT configuration — coarse 1 h march then bisection on
 * the kernel's own apexKmAt (the oracle; no re-derived kinematics). Returns
 * null when the rope never reaches L1 inside the horizon.
 */
export function ropeCrossingH(kernel, i, launchOffsetS = 0, { horizonH = 400 } = {}) {
    const l1Km = L1_OBSERVER.rAu * AU_KM;
    const t0 = launchOffsetS;
    let lo = t0, hi = null;
    for (let h = 1; h <= horizonH; h++) {
        const tS = t0 + h * 3600;
        if (kernel.apexKmAt(i, tS) >= l1Km) { hi = tS; break; }
        lo = tS;
    }
    if (hi == null) return null;
    for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2;
        if (kernel.apexKmAt(i, mid) >= l1Km) hi = mid; else lo = mid;
    }
    return hi / 3600;
}

/**
 * Measure the modeled compounding effect of `fc`'s train — see the header.
 * `wasm`/`wasmUrl` are injectable for node/cron callers; browser callers
 * take the committed-WASM default. `quantileLevels` adds per-side
 * train-onset arrival quantiles (levels echoed back as `levels`). Returns
 * null for anything that isn't a live multi-rope forecast.
 */
export async function measureCompounding(fc, { wasm, wasmUrl, quantileLevels = null } = {}) {
    if (!fc || fc.idle || fc.failed || !fc.kernel
        || !(fc.preset?.ropes?.length >= 2) || !fc.prior || !fc.grid) return null;

    const kOff = await loadFluxRopeKernel(wasm ?? wasmUrl ?? FORECAST_DEFAULTS.wasmUrl);
    kOff.setRopes(fc.preset.ropes);
    kOff.setSpreads(fc.preset.spreads);
    kOff.setInteraction({ enabled: false });
    const seed = trainSeed(fc.cmes, FORECAST_DEFAULTS.seed);
    const off = kOff.ensembleRun(seed, fc.prior.members, fc.grid.t0S, fc.grid.dtS, fc.grid.n);

    const side = (ens) => ({
        pHit: ens.pHit,
        minBzP50: minOver(ens.bzPct.p50),
        p10: pBelowFromMinBz(ens.minBz, -10),
        p20: pBelowFromMinBz(ens.minBz, -20),
        arrivalP50H: medianFinite(ens.arrivalH),
        ...(quantileLevels?.length
            ? { arrivalQH: arrivalQuantiles(ens.arrivalH, quantileLevels) }
            : {}),
    });
    const on = side(fc.prior);
    const offSide = side(off);
    const d = (a, b) => (a != null && b != null) ? a - b : null;

    // Per-rope: deterministic crossing shift + the kernel's §16 analyzer
    // probes on the INTERACTING side (a follower's wake Δv / drag ratio,
    // a leader's rear compression at its own crossing).
    const ropes = fc.preset.ropes.map((r, i) => {
        const arrivalOnH = ropeCrossingH(fc.kernel, i, r.launchOffsetS);
        const arrivalOffH = ropeCrossingH(kOff, i, r.launchOffsetS);
        const leaderRaw = fc.kernel.ropeLeader(i);
        const wEff = fc.kernel.ropeWEffKms(i);
        const gEff = fc.kernel.ropeGammaEff(i);
        return {
            i,
            leader: Number.isFinite(leaderRaw) && leaderRaw >= 0 ? leaderRaw : null,
            arrivalOnH, arrivalOffH,
            deltaH: d(arrivalOnH, arrivalOffH),
            wakeDvKms: Number.isFinite(wEff) ? wEff - r.wKms : null,
            gammaRatio: Number.isFinite(gEff) && r.gammaPerKm > 0 ? gEff / r.gammaPerKm : null,
            rearC: arrivalOnH != null ? fc.kernel.rearCAt(i, arrivalOnH * 3600) : null,
        };
    });

    return {
        seed,
        members: fc.prior.members,
        disclosure: 'modeled counterfactual — identical ropes, priors and ensemble '
            + 'seeds; §16 interaction off; prior ensembles on both sides (unassimilated)',
        ...(quantileLevels?.length ? { levels: [...quantileLevels] } : {}),
        on,
        off: offSide,
        delta: {
            minBzP50: d(on.minBzP50, offSide.minBzP50),
            p10: d(on.p10, offSide.p10),
            p20: d(on.p20, offSide.p20),
            pHit: d(on.pHit, offSide.pHit),
            arrivalP50H: d(on.arrivalP50H, offSide.arrivalP50H),
        },
        ropes,
    };
}

/**
 * Deepest observed L1 Bz inside [t0Ms, t1Ms] (pure). Returns null below 4
 * usable samples — a couple of points is noise, not a measurement.
 */
export function observedMinBz(rtsw, t0Ms, t1Ms) {
    const samples = rtsw?.samples;
    if (!Array.isArray(samples) || !samples.length) return null;
    let min = Infinity, tAt = null, n = 0;
    for (const s of samples) {
        if (!Number.isFinite(s?.bz) || s.t < t0Ms || s.t > t1Ms) continue;
        n++;
        if (s.bz < min) { min = s.bz; tAt = s.t; }
    }
    return n >= 4 ? { minBz: min, tMs: tAt, n } : null;
}
