/**
 * flux-rope-forecast.js — the SHARED flux-rope forecast provider (Phase 4).
 *
 * ONE compute path, many consumers. This module owns the live pipeline the
 * space-weather dashboard panel pioneered — latest Earth-directed DONKI
 * cone analysis → seeded prior ensemble on the committed flux-rope-core
 * WASM → particle-filter conditioning on live DSCOVR/ACE Bz (spec §11) —
 * and hands every consumer the same three products:
 *
 *   1. `fan`      — the (assimilated when possible) ensemble result:
 *                   percentile Bz fans, arrival distribution, P(hit),
 *                   P(min Bz < thr).
 *   2. `driver`   — a SolarWindDriver (js/solar-wind-driver.js, source
 *                   'forecast'): the median-forecast Bz(t) with
 *                   rope-kinematic V and CLIMATOLOGICAL N (honesty: the
 *                   rope model forecasts the FIELD; V comes from the DBM
 *                   apex speed during the crossing, N is a 5 /cc ambient
 *                   fill — stated, not hidden). Any sim that speaks the
 *                   driver contract gets forecast mode for free — this is
 *                   the Phase 0 architectural bet paying out.
 *   3. `summary`  — scalar outlook facts (arrival window, min-Bz
 *                   percentiles, storm probabilities) for cards/alerts.
 *
 * Consumers (Phase 4): js/flux-rope-dashboard.js (space-weather panel),
 * the ring-current Dst outlook, the EarthView verdict-card 3-day outlook,
 * and the AurOracle tiered alerts. Fail-quiet is the CALLER's job — this
 * module throws on hard errors and returns `{ idle: true }` when the
 * DONKI catalog simply has no Earth-directed CME.
 *
 * Testability: `sources` lets tests inject fixture CMEs / an RTSW driver
 * and a WASM byte buffer, so tests/flux-rope-forecast.mjs exercises the
 * REAL kernel with zero network.
 */

import { loadFluxRopeKernel, L1_OBSERVER } from './flux-rope-kernel.js';
import { fetchDonkiCmes, donkiToPreset, fetchRtswDriver } from './flux-rope-live.js';
import { fromArrays } from './solar-wind-driver.js';

/**
 * Deterministic per-event ensemble seed: FNV-1a over the event identity
 * (DONKI activityID or launch ISO) folded into the base seed. PURE —
 * the reproducibility contract for replays lives here.
 */
export function eventSeed(id, base = FORECAST_DEFAULTS.seed) {
    let h = 0x811c9dc5;
    for (const ch of String(id ?? '')) {
        h ^= ch.codePointAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ((base ^ h) >>> 0) || base;
}

export const FORECAST_DEFAULTS = Object.freeze({
    days: 7,            // DONKI lookback window
    members: 500,
    seed: 6180,         // fixed → deterministic per event (dashboard convention)
    gridDtS: 900,       // 15-min forecast grid
    gridHours: 120,
    wasmUrl: './js/flux-rope-wasm/flux_rope_core.wasm',
    ambientNCc: 5,      // climatological density fill for the driver [cm⁻³]
    sigmaNt: 4,         // L1 observation sigma for the particle filter [nT]
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
export function summarizeForecast(fan, prior, launchMs) {
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
    };
}

/**
 * The shared live pipeline. Returns `{ idle: true, reason }` when there is
 * no Earth-directed CME in the window; otherwise the full forecast object.
 * Throws on hard failures (WASM missing, DONKI proxy down) — callers own
 * their fail-quiet posture.
 */
export async function computeFluxRopeForecast(opts = {}) {
    const cfg = { ...FORECAST_DEFAULTS, ...opts };
    const src = cfg.sources ?? {};
    const cmes = src.cmes ?? await fetchDonkiCmes({ days: cfg.days });
    const target = cmes.find((c) => c.earthDirected) ?? null;
    if (!target) return { idle: true, reason: 'no-earth-directed-cme' };
    // Diagonalized determinism (2026-07-23): every catalogued event gets
    // its OWN reproducible ensemble — seed = base ⊕ hash(event identity).
    // Same event → bit-identical fan on every load and every replay;
    // different events → distinguishable fans. Never wall-clock random.
    const evSeed = eventSeed(target.id ?? target.timeIso, cfg.seed);

    // Live L1 for ambient wind + assimilation (best-effort).
    let rtsw = src.rtsw;
    if (rtsw === undefined) {
        try { rtsw = await fetchRtswDriver(); } catch { rtsw = null; }
    }
    let wSum = 0, wN = 0;
    for (const s of rtsw?.samples ?? []) if (Number.isFinite(s.v)) { wSum += s.v; wN++; }
    const wKms = wN ? Math.round(wSum / wN) : 400;
    const preset = donkiToPreset(target, { ambientWKms: wKms });

    const kernel = await loadFluxRopeKernel(src.wasm ?? cfg.wasmUrl);
    kernel.setRope(preset.rope);
    kernel.setSpreads(preset.spreads);
    const n = Math.round(cfg.gridHours * 3600 / cfg.gridDtS);
    const launchMs = Date.parse(preset.launchIso);
    const det = kernel.series(0, cfg.gridDtS, n, L1_OBSERVER);
    const prior = kernel.ensembleRun(evSeed, cfg.members, 0, cfg.gridDtS, n);

    // Condition on live observed Bz where coverage overlaps the past grid.
    const nowMs = cfg.nowMs ?? Date.now();
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
            fan = kernel.assimilate({ obsBz: obs, i0: 0, i1: nowIdx, sigmaNt: cfg.sigmaNt });
            assimNote = `particle filter · ${nObs} obs · ESS ${fan.ess.toFixed(0)}/${cfg.members}`
                + (fan.temperature < 1 ? ` · λ ${fan.temperature.toFixed(2)}` : '');
        }
    }

    const samples = forecastDriverSamples({
        bzP50: fan.bzPct.p50, det, apexV: (tS) => kernel.apexVKms(tS),
        launchMs, t0S: 0, dtS: cfg.gridDtS, wKms, nCc: cfg.ambientNCc,
    });
    const driver = fromArrays(samples, {
        source: 'forecast',
        label: `flux-rope ensemble median · CME ${preset.launchIso}`,
    });

    return {
        idle: false,
        cme: target,
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
        driver,
        summary: summarizeForecast(fan, prior, launchMs),
    };
}
