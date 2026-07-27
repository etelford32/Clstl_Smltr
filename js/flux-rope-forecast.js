/**
 * flux-rope-forecast.js — the SHARED flux-rope forecast provider (Phase 4;
 * compounding-train upgrade 2026-07-27, FLUX_ROPE_SIMULATOR_REVIEW.md).
 *
 * ONE compute path, many consumers. This module owns the live pipeline —
 * DONKI catalog → COMPOUNDING-TRAIN selection (spec §12 train
 * conventions) → seeded joint ensemble on the committed flux-rope-core
 * WASM with §16 CME–CME interaction ON → particle-filter conditioning on
 * live DSCOVR/ACE Bz (spec §11) — and hands every consumer the same
 * products:
 *
 *   1. `fan`      — the (assimilated when possible) ensemble result:
 *                   percentile Bz fans, arrival distribution, P(hit),
 *                   P(min Bz < thr).
 *   2. `driver`   — a SolarWindDriver (source 'forecast'): median Bz(t)
 *                   with rope-kinematic V (the fastest ARRIVED rope's
 *                   apex speed during containment) and CLIMATOLOGICAL N
 *                   (stated, not hidden).
 *   3. `summary`  — scalar outlook facts (arrival window, min-Bz
 *                   percentiles, storm probabilities, train size).
 *
 * Train semantics (review findings F1/F3): the modeled system is EVERY
 * Earth-relevant CME that is recent (launched inside `trainWindowH`) or
 * still plausibly at/inside 1 AU — not just the newest cone fit — seeded
 * as one §16-interacting train (rope 0 = earliest launch = the epoch
 * every consumer's probes assume). A storm that fully passed returns
 * `{ idle: true, reason: 'cme-train-passed' }` instead of "forecasting"
 * the past; `relevanceFilter: false` opts out for replay runs, which
 * model exactly the injected catalog.
 *
 * Background noise (review finding F2): the trailing observed L1 record
 * is measured (js/flux-rope-noise.js, robust MAD) and DISCLOSED on the
 * result (`noise`), and it drives two formerly-fixed knobs: the sheath
 * ambient-variability seed δ (spec §14) and the filter observation σ
 * (spec §11) — both still overridable and both reported in `assimNote` /
 * `sheathDeltaNt`.
 *
 * Consumers: js/flux-rope-dashboard.js (+ the Stage, status band and CME
 * calendar via its published event), js/ring-current-outlook.js, the
 * EarthView verdict card, api/cron/aurora-alerts.js, and the real-time
 * compounding page (flux-rope-live.html). Fail-quiet is the CALLER's
 * job — this module throws on hard errors and returns `{ idle: true }`
 * when nothing Earth-relevant is in flight.
 *
 * Testability: `sources` injects fixture CMEs / an RTSW driver / WASM
 * bytes, so tests/flux-rope-forecast.mjs exercises the REAL kernel with
 * zero network.
 */

import { loadFluxRopeKernel, L1_OBSERVER } from './flux-rope-kernel.js';
import {
    fetchDonkiCmes, fetchRtswDriver, donkiToTrainPreset, selectTrainCmes,
    TRAIN_WINDOW_H,
} from './flux-rope-live.js';
import { measureBzNoise, sheathDeltaFromNoise, assimSigmaFromNoise }
    from './flux-rope-noise.js';
import { fromArrays } from './solar-wind-driver.js';

const AU_KM = 1.495978707e8;

/**
 * Deterministic per-event ensemble seed: FNV-1a over the event identity
 * (DONKI activityID or launch ISO) folded into the base seed. PURE —
 * the reproducibility contract for replays lives here. For a TRAIN the
 * seed folds every member identity in launch order (`trainSeed`), so a
 * new CME joining the train is a new forecast system state, while the
 * same train replays bit-identically; a 1-CME train reproduces the
 * historical single-event seed exactly.
 */
export function eventSeed(id, base = FORECAST_DEFAULTS.seed) {
    let h = 0x811c9dc5;
    for (const ch of String(id ?? '')) {
        h ^= ch.codePointAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ((base ^ h) >>> 0) || base;
}

/** Fold a whole train's identities (launch-ascending) into one seed. */
export function trainSeed(cmes, base = FORECAST_DEFAULTS.seed) {
    return cmes.reduce((s, c) => eventSeed(c.id ?? c.timeIso, s), base);
}

export const FORECAST_DEFAULTS = Object.freeze({
    days: 7,            // DONKI lookback window
    members: 500,
    seed: 6180,         // fixed → deterministic per event (dashboard convention)
    gridDtS: 900,       // 15-min forecast grid
    gridHours: 120,     // forecast horizon BEYOND the last launch
    trainWindowH: TRAIN_WINDOW_H,  // "recent" launch window for train membership
    maxRopes: 6,        // kernel MAX_ROPES — selection cap
    relevanceFilter: true,  // false = replay: model the injected catalog as-is
    wasmUrl: './js/flux-rope-wasm/flux_rope_core.wasm',
    ambientNCc: 5,      // climatological density fill for the driver [cm⁻³]
    sigmaNt: null,      // L1 obs σ for the filter; null → derived from noise
});

/**
 * Build the forecast driver samples (pure — node-testable): median Bz from
 * the fan, V from the deterministic rope kinematics while the reference
 * rope is at L1 (ambient w otherwise), N = climatological fill. `det` is
 * the kernel's deterministic series ({ inside }), `apexV(tS)` the kernel
 * speed probe.
 */
export function forecastDriverSamples({ bzP50, det, apexV, launchMs, t0S, dtS, wKms, nCc }) {
    const n = bzP50.length;
    const t = new Array(n);
    const bz = new Array(n);
    const v = new Array(n);
    const nArr = new Array(n);
    for (let i = 0; i < n; i++) {
        const tS = t0S + i * dtS;
        t[i] = launchMs + tS * 1000;
        bz[i] = bzP50[i];
        v[i] = det && det.inside[i] > 0 ? Math.max(wKms, apexV(tS)) : wKms;
        nArr[i] = nCc;
    }
    return { t, bz, v, n: nArr };
}

/** Scalar outlook facts every consumer card/alert needs (pure). */
export function summarizeForecast(fan, prior, launchMs, extras = {}) {
    const arr = Array.from(prior.arrivalH).filter(Number.isFinite).sort((a, b) => a - b);
    const q = (p) => (arr.length ? launchMs + arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] * 3600_000 : null);
    let minP50 = Infinity;
    for (const vBz of fan.bzPct.p50) if (vBz < minP50) minP50 = vBz;
    let minP5 = Infinity;
    for (const vBz of fan.bzPct.p5) if (vBz < minP5) minP5 = vBz;
    return {
        pHit: fan.pHit,
        p10: fan.pMinBzBelow(-10),
        p20: fan.pMinBzBelow(-20),
        arrivalP10Ms: q(0.1),
        arrivalP50Ms: q(0.5),
        arrivalP90Ms: q(0.9),
        minBzP50: Number.isFinite(minP50) ? minP50 : null,
        minBzP5: Number.isFinite(minP5) ? minP5 : null,
        ...extras,
    };
}

/**
 * The shared live pipeline. Returns `{ idle: true, reason }` when nothing
 * Earth-relevant is in flight — reason 'no-earth-directed-cme' (catalog
 * has no anchor at all) or 'cme-train-passed' (anchors exist but every
 * one already passed L1). Otherwise the full forecast object. Throws on
 * hard failures (WASM missing, DONKI proxy down) — callers own their
 * fail-quiet posture.
 */
export async function computeFluxRopeForecast(opts = {}) {
    const cfg = { ...FORECAST_DEFAULTS, ...opts };
    const src = cfg.sources ?? {};
    const cmes = src.cmes ?? await fetchDonkiCmes({ days: cfg.days });
    const nowMs = cfg.nowMs ?? Date.now();

    // Train membership (spec §12 conventions; review F1/F3). Replay mode
    // (`relevanceFilter: false`) models the injected catalog verbatim —
    // its Earth-directed rows, launch-ascending, capped at the newest.
    let picked;
    if (cfg.relevanceFilter === false) {
        picked = cmes.filter((c) => c.earthDirected === true)
            .sort((a, b) => Date.parse(a.timeIso) - Date.parse(b.timeIso))
            .slice(-cfg.maxRopes);
    } else {
        picked = selectTrainCmes(cmes, {
            nowMs, windowH: cfg.trainWindowH, maxRopes: cfg.maxRopes,
        });
    }
    if (!picked.length) {
        const hadAnchor = cmes.some((c) => c?.earthDirected === true);
        return { idle: true, reason: hadAnchor ? 'cme-train-passed' : 'no-earth-directed-cme' };
    }
    // Diagonalized determinism (2026-07-23): every catalogued system state
    // gets its OWN reproducible ensemble — seed = base ⊕ hash(identities).
    // Same train → bit-identical fan on every load and every replay;
    // different trains → distinguishable fans. Never wall-clock random.
    const evSeed = trainSeed(picked, cfg.seed);

    // Live L1 for ambient wind + background noise + assimilation.
    let rtsw = src.rtsw;
    if (rtsw === undefined) {
        try { rtsw = await fetchRtswDriver(); } catch { rtsw = null; }
    }
    let wSum = 0, wN = 0;
    for (const s of rtsw?.samples ?? []) if (Number.isFinite(s.v)) { wSum += s.v; wN++; }
    const wKms = wN ? Math.round(wSum / wN) : 400;

    // Measured background (review F2): drives the sheath δ seed and the
    // filter σ — both disclosed on the result, both overridable.
    const noise = measureBzNoise(rtsw?.samples ?? [], { nowMs });
    const sheathDeltaNt = sheathDeltaFromNoise(noise);
    const sigmaNt = cfg.sigmaNt ?? assimSigmaFromNoise(noise);

    const preset = donkiToTrainPreset(picked, { ambientWKms: wKms });
    preset.ropes = preset.ropes.map((r) => ({ ...r, sheathDeltaNt }));
    preset.rope = preset.ropes[0];

    const kernel = await loadFluxRopeKernel(src.wasm ?? cfg.wasmUrl);
    kernel.setRopes(preset.ropes);
    kernel.setInteraction(preset.interaction);
    kernel.setSpreads(preset.spreads);
    const launchMs = Date.parse(preset.launchIso);
    // Grid: the forecast horizon extends BEYOND the last launch so every
    // train member gets full coverage (capped at the kernel buffer).
    const lastOffsetH = preset.ropes[preset.ropes.length - 1].launchOffsetS / 3600;
    const n = Math.min(kernel.maxSteps,
        Math.round((cfg.gridHours + lastOffsetH) * 3600 / cfg.gridDtS));
    const det = kernel.series(0, cfg.gridDtS, n, L1_OBSERVER);
    const prior = kernel.ensembleRun(evSeed, cfg.members, 0, cfg.gridDtS, n);

    // Condition on live observed Bz where coverage overlaps the past grid.
    let fan = prior;
    let assimNote = 'prior (no L1 overlap yet)';
    let nObs = 0;
    if (rtsw?.length) {
        const obs = new Float32Array(n).fill(NaN);
        const nowIdx = Math.min(n, Math.max(0, Math.floor((nowMs - launchMs) / 1000 / cfg.gridDtS)));
        for (let i = 0; i < nowIdx; i++) {
            const t = launchMs + i * cfg.gridDtS * 1000;
            if (t < rtsw.tStart || t > rtsw.tEnd) continue;
            const s = rtsw.at(t);
            if (s && Number.isFinite(s.bz)) { obs[i] = s.bz; nObs++; }
        }
        if (nObs >= 4) {
            fan = kernel.assimilate({ obsBz: obs, i0: 0, i1: nowIdx, sigmaNt });
            assimNote = `particle filter · ${nObs} obs · ESS ${fan.ess.toFixed(0)}/${cfg.members}`
                + (fan.temperature < 1 ? ` · λ ${fan.temperature.toFixed(2)}` : '')
                + ` · σ ${sigmaNt.toFixed(1)} nT${noise.ok ? ` (bg ${noise.sigmaNt.toFixed(1)})` : ''}`;
        }
    }

    // Driver V: the fastest rope that has actually REACHED the observer —
    // an unlaunched or still-inbound follower must not lend its speed to
    // an earlier rope's crossing (review §4 minor observation, fixed).
    const nRopes = preset.ropes.length;
    const reachKm = 0.9 * L1_OBSERVER.rAu * AU_KM;
    const apexV = (tS) => {
        let v = 0;
        for (let r = 0; r < nRopes; r++) {
            if (tS <= preset.ropes[r].launchOffsetS) continue;
            if (kernel.apexKmAt(r, tS) >= reachKm) v = Math.max(v, kernel.apexVKmsAt(r, tS));
        }
        return v;
    };
    const samples = forecastDriverSamples({
        bzP50: fan.bzPct.p50, det, apexV,
        launchMs, t0S: 0, dtS: cfg.gridDtS, wKms, nCc: cfg.ambientNCc,
    });
    const target = [...picked].reverse().find((c) => c.earthDirected === true)
        ?? picked[picked.length - 1];
    const driver = fromArrays(samples, {
        source: 'forecast',
        label: nRopes > 1
            ? `flux-rope ensemble median · ${nRopes}-CME compounding train from ${preset.launchIso}`
            : `flux-rope ensemble median · CME ${preset.launchIso}`,
    });

    return {
        idle: false,
        cme: target,                 // headline: the newest Earth-directed anchor
        cmes: picked,                // the whole modeled train, launch-ascending
        train: nRopes > 1,
        preset,
        launchMs,
        grid: { t0S: 0, dtS: cfg.gridDtS, n },
        kernel,
        det,
        prior,
        fan,
        assimNote,
        nObs,
        rtsw,
        noise,                       // measured background (review F2), or ok:false
        sheathDeltaNt,               // the δ actually seeded (measured or fallback)
        sigmaNt,                     // the filter σ actually used
        driver,
        summary: summarizeForecast(fan, prior, launchMs, { nRopes }),
    };
}
