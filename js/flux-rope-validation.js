/**
 * flux-rope-validation.js — PURE decision/scoring logic for the daily
 * flux-rope validation + trajectory-analysis loop ("for each flare": one
 * ledger entry per flare-associated CME, locked before arrival, resolved
 * against L1 truth, scored probabilistically).
 *
 * The cron (api/cron/validation-rerun.js) stays thin: it fetches (DONKI
 * CMEAnalysis + FLR, NOAA RTSW, sw_geomag_dataset rows), runs the SHARED
 * provider (js/flux-rope-forecast.js) on the committed WASM, and calls the
 * functions here — which are node-gated by tests/flux-rope-validation.mjs
 * with zero network. Storage contract: cme_events / cme_arrival_forecasts
 * (INSERT-only, model_id 'flux-rope-v1') / cme_l1_observations (enriched
 * with Bz-structure truth) — CME_FORECAST_VALIDATION_PLAN.md.
 *
 * Scoring: arrival error + CRPS (quantile form, comparable with the point
 * models' MAE on the same ledger), Brier for the locked storm
 * probabilities, and the §5 DBM inversion — the retrieved (Γ, w) per event
 * is the trajectory-analysis product that becomes population priors.
 */

import { crpsFromQuantiles, brierScore } from './forecast-verification.js';
import { dbmApexKm, dbmSpeedKms, invertGammaW, invertGamma, AU_KM, RSUN_KM }
    from './flux-rope-inversion.js';

export const FLUX_ROPE_MODEL_ID = 'flux-rope-v1';
/** Arrival-quantile levels locked in `inputs.arrivalQ` (CRPS-scorable). */
export const ARRIVAL_Q_LEVELS = [0.1, 0.25, 0.5, 0.75, 0.9];

// ── Flare association ("for each flare") ─────────────────────────────────────

/** Normalize raw NASA DONKI FLR rows (direct API shape). Pure. */
export function parseDonkiFlares(raw) {
    return (Array.isArray(raw) ? raw : [])
        .filter((f) => f?.flrID && (f.peakTime || f.beginTime))
        .map((f) => ({
            flrID: f.flrID,
            classType: f.classType ?? null,
            peakMs: Date.parse(f.peakTime ?? f.beginTime),
            beginMs: f.beginTime ? Date.parse(f.beginTime) : null,
            sourceLocation: f.sourceLocation ?? null,
            activeRegionNum: f.activeRegionNum ?? null,
        }))
        .filter((f) => Number.isFinite(f.peakMs));
}

/**
 * Associate a CME launch (time21_5, ms) with its source flare: the flare
 * whose PEAK sits in [launch − maxBeforeH, launch + maxAfterH] (a flare
 * peaks before or around the 21.5 R☉ crossing), nearest in time. Null =
 * no plausible association — recorded honestly, never forced.
 */
export function associateFlare(flares, launchMs, { maxBeforeH = 2.5, maxAfterH = 0.5 } = {}) {
    let best = null;
    for (const f of flares ?? []) {
        const dtH = (launchMs - f.peakMs) / 3.6e6;   // + = flare before launch
        if (dtH < -maxAfterH || dtH > maxBeforeH) continue;
        if (!best || Math.abs(dtH) < Math.abs(best.dtH)) best = { ...f, dtH };
    }
    return best;
}

// ── Per-flare forecast rows (issue-time lock) ────────────────────────────────

/**
 * Per-rope deterministic arrival [s after epoch] + a parametric ±σ_v0
 * window, from the EFFECTIVE (wake-modified) kinematics via the §5 mirror
 * (exact vs the kernel while §20/§19 are off — the provider default).
 * Null when the rope never reaches the observer inside 15 days.
 */
export function ropeArrivalWindow({
    launchOffsetS = 0, v0Kms, wEffKms, gammaEffPerKm,
    sigV0Kms = 100, d0Km = 21.5 * RSUN_KM, rObsKm = 0.99 * AU_KM,
}) {
    const cross = (v0) => {
        if (dbmApexKm(d0Km, v0, wEffKms, gammaEffPerKm, 15 * 86400) < rObsKm) return NaN;
        let lo = 0, hi = 15 * 86400;
        for (let i = 0; i < 100; i++) {
            const mid = 0.5 * (lo + hi);
            if (dbmApexKm(d0Km, v0, wEffKms, gammaEffPerKm, mid) < rObsKm) lo = mid;
            else hi = mid;
        }
        return launchOffsetS + 0.5 * (lo + hi);
    };
    const point = cross(v0Kms);
    if (!Number.isFinite(point)) return null;
    const early = cross(v0Kms + sigV0Kms);
    const late = cross(Math.max(150, v0Kms - sigV0Kms));
    return {
        arrivalS: point,
        earlyS: Number.isFinite(early) ? early : point,
        lateS: Number.isFinite(late) ? late : point + 24 * 3600,
        vArrKms: dbmSpeedKms(v0Kms, wEffKms, gammaEffPerKm, point - launchOffsetS),
    };
}

/**
 * Build the issue-time-locked flux-rope-v1 rows — ONE PER FLARE/CME of the
 * modeled train (trajectory ledger), each carrying the frozen inputs that
 * replay it bit-exactly (train ids + seed) plus the train-level
 * probabilistic quantities. The earliest-arriving row carries the
 * CRPS-scorable train-onset arrival quantiles (`inputs.arrivalQ`) — the
 * train's first shock is what the onset distribution predicts.
 *
 * All inputs are plain data (the cron extracts kernel/effective params);
 * pure and node-gated.
 */
export function fluxRopeForecastRows({
    eventIdFor,           // (cmeId) → cme_events event_id
    cmes,                 // the train members, launch-ascending (provider fc.cmes)
    ropes,                // preset ropes, index-aligned with cmes
    eff,                  // [{ wEffKms, gammaEffPerKm }] per rope (kernel getters)
    sigV0Kms = 100,       // the prior's speed spread (parametric window)
    launchMs,             // train epoch (rope 0 launch)
    seed,
    summary,              // provider summary (pHit, p10, p20, minBzP50/P5, nRopes)
    arrivalQH = null,     // train-onset arrival quantiles [h], ARRIVAL_Q_LEVELS
    sigmaNt, sheathDeltaNt, noiseSigmaNt = null,
    flares = [],          // parsed flares for association
}) {
    const rows = [];
    let firstArrival = Infinity, firstIdx = -1;
    const windows = cmes.map((c, i) => {
        const w = ropeArrivalWindow({
            launchOffsetS: ropes[i].launchOffsetS ?? 0,
            v0Kms: ropes[i].v0Kms,
            wEffKms: eff[i].wEffKms,
            gammaEffPerKm: eff[i].gammaEffPerKm,
            sigV0Kms,
        });
        if (w && w.arrivalS < firstArrival) { firstArrival = w.arrivalS; firstIdx = i; }
        return w;
    });
    for (let i = 0; i < cmes.length; i++) {
        const w = windows[i];
        if (!w) continue;   // a never-arriving member gets no arrival row
        const c = cmes[i];
        const cmeLaunchMs = launchMs + (ropes[i].launchOffsetS ?? 0) * 1000;
        const flare = associateFlare(flares, cmeLaunchMs);
        const iso = (ms) => new Date(ms).toISOString();
        rows.push({
            event_id: eventIdFor(c.id),
            model_id: FLUX_ROPE_MODEL_ID,
            predicted_arrival_utc: iso(launchMs + w.arrivalS * 1000),
            arrival_window_early: iso(launchMs + w.earlyS * 1000),
            arrival_window_late: iso(launchMs + w.lateS * 1000),
            predicted_hit: summary.pHit >= 0.5,
            predicted_speed_at_l1: Math.round(w.vArrKms),
            inputs: {
                method: 'flux-rope v1.6 compounding train (spec §12.1/§16)',
                train: cmes.map((m) => m.id),
                ropeIndex: i,
                seed,
                launch: iso(cmeLaunchMs),
                epoch: iso(launchMs),
                v0_kms: ropes[i].v0Kms,
                lon_deg: ropes[i].lonDeg,
                lat_deg: ropes[i].latDeg,
                half_deg: c.halfAngleDeg ?? null,
                w_eff_kms: Math.round(eff[i].wEffKms),
                gamma_eff_per_km: eff[i].gammaEffPerKm,
                sig_v0_kms: sigV0Kms,
                p_hit: summary.pHit,
                p10: summary.p10,
                p20: summary.p20,
                min_bz_p50: summary.minBzP50,
                min_bz_p5: summary.minBzP5,
                sigma_nt: sigmaNt,
                sheath_delta_nt: sheathDeltaNt,
                noise_sigma_nt: noiseSigmaNt,
                flare: flare ? {
                    id: flare.flrID, class: flare.classType,
                    peak: iso(flare.peakMs), region: flare.activeRegionNum,
                    location: flare.sourceLocation, dt_h: Math.round(flare.dtH * 10) / 10,
                } : null,
                ...(i === firstIdx && Array.isArray(arrivalQH)
                    ? { arrivalQ: { levels: ARRIVAL_Q_LEVELS, hours: arrivalQH } }
                    : {}),
            },
        });
    }
    return rows;
}

/** Train-onset arrival quantiles [h] from the prior's per-member arrivals. */
export function arrivalQuantilesH(arrivalH, levels = ARRIVAL_Q_LEVELS) {
    const a = Array.from(arrivalH ?? []).filter(Number.isFinite).sort((x, y) => x - y);
    if (a.length < 10) return null;
    return levels.map((p) => a[Math.min(a.length - 1, Math.floor(a.length * p))]);
}

// ── Bz-structure truth (sw_geomag_dataset) ───────────────────────────────────

/**
 * Resolve the storm's Bz-structure truth over [shock, shock + windowH]
 * from minute rows {tMs, bz, v, flag}. Coverage honesty: below
 * `minCoverage` of usable minutes the answer is 'pending', never a fake
 * minimum. Also returns the arrival speed (median v over the first hour
 * after shock) — the §5 inversion's second observable.
 */
export function resolveBzTruth({ rows, shockMs, windowH = 48, minCoverage = 0.6 }) {
    if (!Number.isFinite(shockMs)) return { status: 'pending', reason: 'no-shock' };
    const endMs = shockMs + windowH * 3.6e6;
    let n = 0, usable = 0;
    let minBz = Infinity, minAt = NaN;
    const vFirstHour = [];
    for (const r of rows ?? []) {
        if (!(r.tMs >= shockMs && r.tMs <= endMs)) continue;
        n++;
        if (!Number.isFinite(r.bz)) continue;
        usable++;
        if (r.bz < minBz) { minBz = r.bz; minAt = r.tMs; }
        if (r.tMs <= shockMs + 3.6e6 && Number.isFinite(r.v)) vFirstHour.push(r.v);
    }
    const expected = (windowH * 60);
    const coverage = Math.min(1, usable / expected);
    if (coverage < minCoverage) {
        return { status: 'pending', reason: 'insufficient-coverage', coverage };
    }
    vFirstHour.sort((a, b) => a - b);
    return {
        status: 'resolved',
        minBzNt: minBz,
        minBzAtMs: minAt,
        vAtShockKms: vFirstHour.length
            ? vFirstHour[vFirstHour.length >> 1]
            : NaN,
        coverage,
    };
}

// ── Per-event scoring (arrival + probabilistic + inversion) ──────────────────

/**
 * Score one resolved flare/CME event against its locked flux-rope-v1 row.
 * `forecast`: the locked row (with `inputs`); `truth`: { arrived,
 * shockMs, minBzNt?, vAtShockKms? }; `launchIso`: the EVENT's launch.
 * Every score that cannot be computed honestly is null, with the pieces
 * that exist still reported.
 */
export function scoreFluxRopeEvent({ forecast, truth, launchIso }) {
    const inp = forecast?.inputs ?? {};
    const launchMs = Date.parse(inp.launch ?? launchIso);
    const out = {
        event_id: forecast?.event_id ?? null,
        flare: inp.flare ?? null,
        arrived: truth?.arrived === true,
        predicted_hit: forecast?.predicted_hit ?? null,
        brierHit: Number.isFinite(inp.p_hit)
            ? brierScore(inp.p_hit, truth?.arrived === true) : null,
        arrivalErrH: null, hit12: null, crpsArrivalH: null,
        brier10: null, brier20: null,
        minBzErrNt: null,
        inversion: null,
    };
    if (truth?.arrived && Number.isFinite(truth.shockMs)) {
        const predMs = Date.parse(forecast.predicted_arrival_utc);
        out.arrivalErrH = (predMs - truth.shockMs) / 3.6e6;
        out.hit12 = Math.abs(out.arrivalErrH) <= 12;
        const epochMs = Date.parse(inp.epoch ?? inp.launch ?? launchIso);
        if (inp.arrivalQ?.hours?.length && Number.isFinite(epochMs)) {
            out.crpsArrivalH = crpsFromQuantiles(
                inp.arrivalQ.hours, inp.arrivalQ.levels ?? ARRIVAL_Q_LEVELS,
                (truth.shockMs - epochMs) / 3.6e6);
        }
        if (Number.isFinite(truth.minBzNt)) {
            if (Number.isFinite(inp.p10)) out.brier10 = brierScore(inp.p10, truth.minBzNt < -10);
            if (Number.isFinite(inp.p20)) out.brier20 = brierScore(inp.p20, truth.minBzNt < -20);
            if (Number.isFinite(inp.min_bz_p50)) out.minBzErrNt = inp.min_bz_p50 - truth.minBzNt;
        }
        // Trajectory inversion: what drag environment did this CME feel?
        if (Number.isFinite(launchMs) && Number.isFinite(inp.v0_kms)) {
            const transitS = (truth.shockMs - launchMs) / 1000;
            if (transitS > 3600) {
                const r = Number.isFinite(truth.vAtShockKms)
                    ? invertGammaW({ v0Kms: inp.v0_kms, transitS, vArrKms: truth.vAtShockKms })
                    : invertGamma({ v0Kms: inp.v0_kms, wKms: inp.w_eff_kms ?? 400, transitS });
                out.inversion = r.ok
                    ? { ok: true, gammaPerKm: r.gammaPerKm, wKms: r.wKms ?? inp.w_eff_kms ?? null }
                    : { ok: false, reason: r.reason };
            }
        }
    } else if (truth && truth.arrived === false) {
        // False alarm (or correct negative): Brier on the hit call stands.
        out.hit12 = false;
    }
    return out;
}

/** Aggregate a day's scored events into the validation_runs row shape. */
export function aggregateFluxRopeScores(events) {
    const scored = (events ?? []).filter((e) => e && e.arrived && Number.isFinite(e.arrivalErrH));
    const n = scored.length;
    const mean = (vals) => {
        const v = vals.filter(Number.isFinite);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    return {
        n_forecasts: (events ?? []).length,
        hits: scored.filter((e) => e.hit12).length,
        maeHours: mean(scored.map((e) => Math.abs(e.arrivalErrH))),
        biasHours: mean(scored.map((e) => e.arrivalErrH)),
        crpsArrivalH: mean(scored.map((e) => e.crpsArrivalH)),
        brierHit: mean((events ?? []).map((e) => e?.brierHit)),
        brier10: mean(scored.map((e) => e.brier10)),
        brier20: mean(scored.map((e) => e.brier20)),
        minBzMaeNt: mean(scored.map((e) => Math.abs(e.minBzErrNt))),
        inversions: scored.map((e) => e.inversion).filter((r) => r?.ok),
    };
}
