/**
 * sun-flux-rope.js — sun.html's consumer of the ONE shared flux-rope
 * forecast provider (js/flux-rope-forecast.js).
 *
 * This module computes NO physics of its own. The live pipeline —
 * DONKI catalog → compounding-train selection → seeded joint WASM
 * ensemble (§16 interaction ON) → particle-filter conditioning on live
 * DSCOVR/ACE Bz — lives entirely in the shared provider; re-implementing
 * any part of it per consumer is forbidden (CLAUDE.md flux-rope row).
 *
 * What this module adds for sun.html:
 *
 *   startFluxRopeProvider()  — the page's ONE provider run loop. Publishes
 *       every result (live, idle, or {failed}) as window.__fluxRopeForecast
 *       plus a 'flux-rope-forecast' CustomEvent — the exact convention
 *       js/flux-rope-dashboard.js established, so the Sun Watch dock's
 *       Forecast tab, the scrubber event track, and any future consumer on
 *       this page all follow the ONE published result. Fail-quiet is the
 *       caller's posture: a failed run publishes {failed, reason} (a broken
 *       feed must LOOK broken, never like a quiet sun) and retries on a
 *       short leash; a live run refreshes on the 15-min DONKI cadence.
 *       First run is DEFERRED a few seconds so the WASM fetch + 500-member
 *       ensemble never competes with the 3D sun's boot.
 *
 *   trainStateAt(fc, tMs)    — PURE probe: where is each modeled rope at
 *       instant tMs? Uses the provider's own kernel probes (apexKmAt on the
 *       live kernel instance — the oracle, never a re-derived kinematic),
 *       so the scrubber's "N CMEs in transit" readout states exactly what
 *       the ensemble engine models, not a second ballistic estimate.
 *
 *   scrubMarks({timeline, summary}) — PURE assembly of the scrubber event
 *       track's draw list: Sun Watch ledger events (flares / CMEs / SEP /
 *       GST — rows the dock already fetched; this module fetches nothing)
 *       plus the modeled arrival window (P10–P90 + median) from the
 *       provider summary. Marks carry epoch-ms only — the DOM side owns
 *       the time→x mapping because the scrub axis is index-spaced.
 *
 *   measureCompounding(fc) — the COMPOUNDING MEASUREMENT: how much does
 *       CME–CME interaction (spec §16 — wake kinematics, dynamic rear
 *       compression, wake-conditioned sheaths) change this exact forecast?
 *       Method: a strict counterfactual — a SECOND kernel instance seeded
 *       with the identical ropes, priors, ensemble seed and grid, §16
 *       interaction OFF (the kernel documents disabled as bit-identical to
 *       the non-interacting train), so every delta is attributable to the
 *       interaction physics alone. Both sides are PRIOR ensembles
 *       (unassimilated) — the honest apples-to-apples, since the
 *       counterfactual cannot be conditioned on observations produced by
 *       the interacting sun. Scalar probabilities are computed from the
 *       COPIED per-member arrays, never the result's live pMinBzBelow
 *       closure (which reads current WASM state and is stale the moment
 *       the provider's assimilation reweights it). Per-rope rows carry the
 *       deterministic L1-crossing shift plus the kernel's own §16 analyzer
 *       probes (leader index, wake Δv, drag ratio, rear compression).
 *       Trains only — a single rope has nothing to compound (null).
 *
 *   observedMinBz(rtsw, t0, t1) — PURE: the deepest observed L1 Bz inside
 *       a window — the ground-truth hook the compounding readout is
 *       eventually scored against (the full per-event scoring lives in the
 *       validation loop, js/flux-rope-validation.js — not here).
 *
 * The pure helpers are node-gated by tests/sun-flux-rope.mjs against the
 * REAL committed WASM (no network), following tests/flux-rope-forecast.mjs.
 */

import { computeFluxRopeForecast, trainSeed, FORECAST_DEFAULTS }
    from './flux-rope-forecast.js';
import { loadFluxRopeKernel, L1_OBSERVER } from './flux-rope-kernel.js';

const AU_KM = 1.495978707e8;

export const REFRESH_MS = 15 * 60e3;   // live cadence (CDN-cached, cheap)
export const RETRY_MS = 2 * 60e3;      // failed-run leash
export const FIRST_RUN_DELAY_MS = 3000;

/**
 * Per-rope transit state at epoch-ms `tMs`, from the provider's live kernel
 * instance. Returns null for anything that is not a live forecast (null,
 * idle, failed, or a forecast without kernel/preset). "Arrived" means the
 * modeled apex has reached the L1 observer radius — the same surface every
 * other consumer probes.
 */
export function trainStateAt(fc, tMs) {
    if (!fc || fc.idle || fc.failed || !fc.kernel || !fc.preset?.ropes?.length
        || !Number.isFinite(fc.launchMs) || !Number.isFinite(tMs)) return null;
    const l1Km = L1_OBSERVER.rAu * AU_KM;
    const tS = (tMs - fc.launchMs) / 1000;
    const ropes = fc.preset.ropes.map((r, i) => {
        const launched = tS > (r.launchOffsetS ?? 0);
        const apexKm = launched ? fc.kernel.apexKmAt(i, tS) : 0;
        return {
            i,
            launched,
            apexAu: launched ? apexKm / AU_KM : 0,
            arrived: launched && apexKm >= l1Km,
        };
    });
    let launched = 0, arrived = 0;
    for (const r of ropes) { if (r.launched) launched++; if (r.arrived) arrived++; }
    return { ropes, launched, arrived, inTransit: launched - arrived };
}

/** Ledger kinds that earn a tick on the scrubber's event track. */
const MARK_KINDS = new Set(['flare', 'cme', 'sep', 'gst']);

/**
 * Assemble the event-track draw list (pure). `timeline` is the Sun Watch
 * ledger (js/sun-watch-model.js buildTimeline rows: {t, kind, color, badge,
 * title, earth}); `summary` is a provider summary ({arrivalP10Ms/P50Ms/
 * P90Ms}) or null/absent. Marks come back time-ascending; rows without a
 * finite epoch or outside MARK_KINDS are dropped, never guessed at.
 */
export function scrubMarks({ timeline = [], summary = null } = {}) {
    const marks = (Array.isArray(timeline) ? timeline : [])
        .filter((ev) => Number.isFinite(ev?.t) && MARK_KINDS.has(ev.kind))
        .map((ev) => ({
            t: ev.t,
            kind: ev.kind,
            color: ev.color || '#ffaa44',
            label: ev.title || ev.kind,
            earth: ev.earth === true,
        }))
        .sort((a, b) => a.t - b.t);
    const band = Number.isFinite(summary?.arrivalP10Ms) && Number.isFinite(summary?.arrivalP90Ms)
        ? { t0: summary.arrivalP10Ms, t1: summary.arrivalP90Ms, t50: summary.arrivalP50Ms ?? null }
        : null;
    return { marks, band };
}

// ── Compounding measurement (§16 counterfactual) ────────────────────────────

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
 * `wasm`/`wasmUrl` are injectable for node tests; browser callers take the
 * committed-WASM default. Returns null for anything that isn't a live
 * multi-rope forecast.
 */
export async function measureCompounding(fc, { wasm, wasmUrl } = {}) {
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

/**
 * Start the page's provider loop. Every outcome is published (live / idle /
 * {failed, reason}) so consumers can render honest states. Returns a
 * disposer handle. Options exist for tests (delayMs) — production callers
 * take the defaults.
 */
export function startFluxRopeProvider({ delayMs = FIRST_RUN_DELAY_MS } = {}) {
    let timer = 0;
    let running = false;
    let disposed = false;

    async function run() {
        if (running || disposed) return;
        running = true;
        let fc;
        let failed = false;
        try {
            fc = await computeFluxRopeForecast({});
            if (!fc.idle) {
                // The compounding measurement rides every live train run —
                // its failure degrades to "no measurement", never a failed
                // forecast. Single ropes honestly carry null.
                try {
                    fc.compounding = fc.train ? await measureCompounding(fc) : null;
                } catch (e) {
                    fc.compounding = null;
                    console.info('[sun] compounding counterfactual failed:', e?.message ?? e);
                }
                // Ground-truth hook: deepest L1 Bz observed inside the
                // forecast window so far (null until coverage exists).
                fc.observedL1 = observedMinBz(fc.rtsw, fc.launchMs,
                    Math.min(Date.now(), fc.launchMs + fc.grid.n * fc.grid.dtS * 1000));
            }
        } catch (e) {
            failed = true;
            fc = { idle: true, failed: true, reason: e?.message ?? String(e) };
            console.info('[sun] flux-rope provider run failed:', fc.reason);
        }
        try {
            window.__fluxRopeForecast = fc;
            window.dispatchEvent(new CustomEvent('flux-rope-forecast', { detail: fc }));
        } catch { /* consumers absent — publishing is best-effort */ }
        running = false;
        if (!disposed) timer = setTimeout(run, failed ? RETRY_MS : REFRESH_MS);
    }

    timer = setTimeout(run, delayMs);
    return {
        refresh: run,
        dispose() { disposed = true; clearTimeout(timer); },
    };
}
