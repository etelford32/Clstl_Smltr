// flux-rope-validation.mjs — fixture gate for the per-flare daily
// validation logic (js/flux-rope-validation.js). Pure node, no network:
//
//   node tests/flux-rope-validation.mjs

import {
    parseDonkiFlares, associateFlare, ropeArrivalWindow, fluxRopeForecastRows,
    arrivalQuantilesH, resolveBzTruth, scoreFluxRopeEvent, aggregateFluxRopeScores,
    freezeCompounding, FLUX_ROPE_MODEL_ID, ARRIVAL_Q_LEVELS,
} from '../js/flux-rope-validation.js';
import { dbmApexKm, dbmSpeedKms, AU_KM, RSUN_KM } from '../js/flux-rope-inversion.js';

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ── Flare association ────────────────────────────────────────────────────────
const LAUNCH = Date.parse('2026-07-27T06:00:00Z');
const flares = parseDonkiFlares([
    { flrID: 'FLR-X12', classType: 'X1.2', peakTime: '2026-07-27T05:20Z',
      beginTime: '2026-07-27T05:05Z', sourceLocation: 'S17W27', activeRegionNum: 13999 },
    { flrID: 'FLR-M3', classType: 'M3.0', peakTime: '2026-07-27T01:00Z' },
    { flrID: 'FLR-LATE', classType: 'C5.0', peakTime: '2026-07-27T09:00Z' },
    { flrID: 'FLR-BAD', classType: 'B1.0' },   // no time → dropped
]);
check('flares: parsed + timeless rows dropped', flares.length === 3);
{
    const f = associateFlare(flares, LAUNCH);
    check('flare↔CME: nearest peak inside [−2.5 h, +0.5 h] wins',
        f?.flrID === 'FLR-X12' && Math.abs(f.dtH - 0.667) < 0.01,
        `${f?.flrID} dt ${f?.dtH?.toFixed(2)} h`);
    check('flare↔CME: nothing plausible → null (never forced)',
        associateFlare(flares, LAUNCH + 12 * 3.6e6) === null);
    check('flare↔CME: window is directional (a later flare cannot source it)',
        associateFlare([flares[2]], LAUNCH) === null);
}

// ── Arrival windows (parametric ±σ_v0, §5 mirror) ────────────────────────────
{
    const w = ropeArrivalWindow({ v0Kms: 1100, wEffKms: 400, gammaEffPerKm: 0.2e-7 });
    check('arrival window: St-Patrick-class transit ≈ 50 h',
        Math.abs(w.arrivalS / 3600 - 50) < 2, `${(w.arrivalS / 3600).toFixed(1)} h`);
    check('arrival window: ordered early < point < late',
        w.earlyS < w.arrivalS && w.arrivalS < w.lateS);
    check('arrival window: arrival speed decelerated toward ambient',
        w.vArrKms < 1100 && w.vArrKms > 400, `${w.vArrKms.toFixed(0)} km/s`);
    check('arrival window: wake offset shifts absolute time',
        ropeArrivalWindow({ launchOffsetS: 36000, v0Kms: 1100, wEffKms: 400,
            gammaEffPerKm: 0.2e-7 }).arrivalS - w.arrivalS === 36000);
    check('arrival window: unreachable observer → null (never forced)',
        ropeArrivalWindow({ v0Kms: 150, wEffKms: 150, gammaEffPerKm: 0,
            rObsKm: 3 * AU_KM }) === null);
}

// ── Locked rows (one per flare/CME) ──────────────────────────────────────────
const EPOCH = LAUNCH;
const CMES = [
    { id: 'CME-A', halfAngleDeg: 38 },
    { id: 'CME-B', halfAngleDeg: 45 },
];
// Rope A (epoch, fast) arrives FIRST — it carries the train-onset
// quantiles; rope B rides its wake 18 h later.
const ROPES = [
    { launchOffsetS: 0, v0Kms: 1500, lonDeg: -3, latDeg: 2 },
    { launchOffsetS: 18 * 3600, v0Kms: 900, lonDeg: 5, latDeg: -1 },
];
const EFF = [
    { wEffKms: 420, gammaEffPerKm: 0.2e-7 },
    { wEffKms: 700, gammaEffPerKm: 0.1e-7 },
];
const SUMMARY = { pHit: 0.82, p10: 0.6, p20: 0.35, minBzP50: -14, minBzP5: -28, nRopes: 2 };
const rows = fluxRopeForecastRows({
    eventIdFor: (id) => `PP-RT-${id}`,
    cmes: CMES, ropes: ROPES, eff: EFF, sigV0Kms: 120,
    launchMs: EPOCH, seed: 12345, summary: SUMMARY,
    arrivalQH: [40, 44, 48, 52, 58],
    sigmaNt: 3.6, sheathDeltaNt: 2.1, noiseSigmaNt: 2.4,
    flares,
});
check('rows: one locked row per flare/CME', rows.length === 2
    && rows.every((r) => r.model_id === FLUX_ROPE_MODEL_ID));
check('rows: event ids + frozen train identity',
    rows[0].event_id === 'PP-RT-CME-A'
    && rows[1].inputs.train.join(',') === 'CME-A,CME-B'
    && rows[1].inputs.seed === 12345);
check('rows: rope A carries the flare association, rope B (+18 h) does not',
    rows[0].inputs.flare?.id === 'FLR-X12' && rows[1].inputs.flare === null);
check('rows: arrival ordered within the window',
    Date.parse(rows[0].arrival_window_early) < Date.parse(rows[0].predicted_arrival_utc)
    && Date.parse(rows[0].predicted_arrival_utc) < Date.parse(rows[0].arrival_window_late));
check('rows: train-onset arrival quantiles ride the FIRST-arriving row only',
    !!rows[0].inputs.arrivalQ && !rows[1].inputs.arrivalQ
    && rows[0].inputs.arrivalQ.levels === ARRIVAL_Q_LEVELS);
check('rows: probabilistic + noise facts frozen',
    rows[0].inputs.p20 === 0.35 && rows[0].inputs.min_bz_p50 === -14
    && rows[0].inputs.noise_sigma_nt === 2.4 && rows[0].predicted_hit === true);
{
    const q = arrivalQuantilesH(Float32Array.from(
        Array.from({ length: 100 }, (_, i) => 40 + i * 0.2)));
    check('arrival quantiles: order statistics at the locked levels',
        q.length === 5 && q[0] < q[2] && q[2] < q[4] && Math.abs(q[2] - 50) < 0.5);
    check('arrival quantiles: refuse a thin ensemble', arrivalQuantilesH([41, 42]) === null);
}

// ── Bz truth resolution (coverage-honest) ────────────────────────────────────
{
    const SHOCK = Date.parse('2026-07-29T03:00:00Z');
    const mk = (coverageFrac) => {
        const rows = [];
        for (let i = 0; i < 48 * 60; i++) {
            if ((i % 100) / 100 >= coverageFrac) continue;
            const t = SHOCK + i * 60e3;
            rows.push({
                tMs: t,
                bz: -5 - 20 * Math.exp(-((i - 600) ** 2) / (2 * 200 ** 2)),
                v: i < 60 ? 640 + (i % 7) : 500,
            });
        }
        return rows;
    };
    const truth = resolveBzTruth({ rows: mk(1), shockMs: SHOCK });
    check('bz truth: minimum + timing resolved',
        truth.status === 'resolved' && Math.abs(truth.minBzNt - -25) < 0.2
        && Math.abs((truth.minBzAtMs - SHOCK) / 3.6e6 - 10) < 0.3,
        `${truth.minBzNt?.toFixed(1)} nT @ +${((truth.minBzAtMs - SHOCK) / 3.6e6).toFixed(1)} h`);
    check('bz truth: arrival speed = first-hour median',
        Math.abs(truth.vAtShockKms - 643) < 4, `${truth.vAtShockKms} km/s`);
    check('bz truth: a data gap resolves PENDING, never a fake minimum',
        resolveBzTruth({ rows: mk(0.3), shockMs: SHOCK }).status === 'pending');
    check('bz truth: no shock → pending', resolveBzTruth({ rows: [], shockMs: NaN }).status === 'pending');
}

// ── Per-event scoring + aggregation ──────────────────────────────────────────
{
    // Truth GENERATED by the §5 forward model at a known (Γ*, w*) so every
    // score — and the inversion — has an exact reference.
    const G_TRUE = 0.3e-7, W_TRUE = 430;
    let lo = 0, hi = 15 * 86400;
    for (let i = 0; i < 200; i++) {
        const mid = 0.5 * (lo + hi);
        if (dbmApexKm(21.5 * RSUN_KM, 1500, W_TRUE, G_TRUE, mid) < 0.99 * AU_KM) lo = mid;
        else hi = mid;
    }
    const transitTrueS = 0.5 * (lo + hi);
    const shockMs = EPOCH + transitTrueS * 1000;
    const vArrTrue = dbmSpeedKms(1500, W_TRUE, G_TRUE, transitTrueS);
    const fc = {
        ...rows[0],
        predicted_arrival_utc: new Date(shockMs - 3 * 3.6e6).toISOString(),
    };
    const score = scoreFluxRopeEvent({
        forecast: fc,
        truth: { arrived: true, shockMs, minBzNt: -22.5, vAtShockKms: vArrTrue },
        launchIso: new Date(EPOCH).toISOString(),
    });
    check('score: arrival error + 12 h hit', Math.abs(score.arrivalErrH - -3) < 1e-6
        && score.hit12 === true, `${score.arrivalErrH?.toFixed(1)} h`);
    check('score: CRPS from the locked train-onset quantiles',
        Number.isFinite(score.crpsArrivalH),
        `${score.crpsArrivalH?.toFixed(2)} h vs transit ${(transitTrueS / 3600).toFixed(1)} h`);
    check('score: Brier trio (hit + thresholds) from frozen probabilities',
        Math.abs(score.brierHit - (0.82 - 1) ** 2) < 1e-9
        && Math.abs(score.brier10 - (0.6 - 1) ** 2) < 1e-9
        && Math.abs(score.brier20 - (0.35 - 1) ** 2) < 1e-9);
    check('score: min-Bz error vs locked median',
        Math.abs(score.minBzErrNt - (-14 - -22.5)) < 1e-9, `${score.minBzErrNt} nT`);
    check('score: trajectory inversion recovers the generating (Γ, w)',
        score.inversion?.ok === true
        && Math.abs(score.inversion.gammaPerKm - G_TRUE) / G_TRUE < 0.01
        && Math.abs(score.inversion.wKms - W_TRUE) < 3,
        score.inversion?.ok ? `Γ ${score.inversion.gammaPerKm.toExponential(2)} w ${score.inversion.wKms.toFixed(0)}` : score.inversion?.reason);
    const falseAlarm = scoreFluxRopeEvent({
        forecast: fc, truth: { arrived: false }, launchIso: new Date(EPOCH).toISOString(),
    });
    check('score: false alarm keeps the Brier-hit accountability',
        falseAlarm.hit12 === false && Math.abs(falseAlarm.brierHit - 0.82 ** 2) < 1e-9);

    const agg = aggregateFluxRopeScores([score, falseAlarm]);
    check('aggregate: run-row shape (n, hits, MAE, CRPS, Briers, inversions)',
        agg.n_forecasts === 2 && agg.hits === 1
        && Math.abs(agg.maeHours - 3) < 1e-6
        && Number.isFinite(agg.crpsArrivalH) && Number.isFinite(agg.brierHit)
        && agg.inversions.length === 1);
}

// ── Compounding lock + score vs outcome (§16 counterfactual) ─────────────────
{
    // measureCompounding-shaped fixture (the real measurement is WASM-gated
    // by tests/sun-flux-rope.mjs; this gate pins the freeze/score contract).
    const CP = {
        seed: 12345, members: 500,
        disclosure: 'modeled counterfactual — identical ropes, priors and ensemble '
            + 'seeds; §16 interaction off; prior ensembles on both sides (unassimilated)',
        levels: ARRIVAL_Q_LEVELS,
        on: { pHit: 0.82, p10: 0.60, p20: 0.35, minBzP50: -14, arrivalP50H: 48,
              arrivalQH: [40, 44, 48, 52, 58] },
        off: { pHit: 0.80, p10: 0.55, p20: 0.28, minBzP50: -11, arrivalP50H: 52,
               arrivalQH: [44, 48, 52, 56, 62] },
        delta: { minBzP50: -3, p10: 0.05, p20: 0.07, pHit: 0.02, arrivalP50H: -4 },
        ropes: [
            { i: 0, leader: null, arrivalOnH: 47.9, arrivalOffH: 47.9, deltaH: 0,
              wakeDvKms: 0, gammaRatio: 1, rearC: 0.4 },
            { i: 1, leader: 0, arrivalOnH: 66.3, arrivalOffH: 80, deltaH: -13.7,
              wakeDvKms: 571, gammaRatio: 0.5, rearC: 0 },
        ],
    };
    const cRows = fluxRopeForecastRows({
        eventIdFor: (id) => `PP-RT-${id}`,
        cmes: CMES, ropes: ROPES, eff: EFF, sigV0Kms: 120,
        launchMs: EPOCH, seed: 12345, summary: SUMMARY,
        arrivalQH: [40, 44, 48, 52, 58],
        sigmaNt: 3.6, sheathDeltaNt: 2.1, noiseSigmaNt: 2.4,
        flares, compounding: CP,
    });
    check('lock: every rope freezes its wake diagnostics',
        cRows[0].inputs.wake?.leader === null && cRows[0].inputs.wake.delta_arrival_h === 0
        && cRows[1].inputs.wake?.leader === 0 && cRows[1].inputs.wake.dv_kms === 571
        && cRows[1].inputs.wake.gamma_ratio === 0.5
        && cRows[1].inputs.wake.delta_arrival_h === -13.7);
    check('lock: independent-run arrivals frozen as UTC',
        Date.parse(cRows[1].inputs.wake.arrival_indep_utc) === EPOCH + 80 * 3.6e6);
    check('lock: train-level compounding block on the FIRST-arriving row only',
        !!cRows[0].inputs.compounding && !cRows[1].inputs.compounding);
    const cz = cRows[0].inputs.compounding;
    check('lock: ON/OFF scalars + deltas frozen snake_case',
        cz.on.min_bz_p50 === -14 && cz.off.min_bz_p50 === -11
        && cz.delta.min_bz_p50 === -3 && cz.off.p20 === 0.28
        && /counterfactual/.test(cz.method));
    check('lock: predicted amplification = |on|/|off| min-Bz p50',
        Math.abs(cz.amp_pred - 14 / 11) < 1e-9);
    check('lock: OFF-side arrival quantiles frozen for CRPS',
        cz.arrival_q_off.hours.join(',') === '44,48,52,56,62'
        && cz.arrival_q_off.levels.length === ARRIVAL_Q_LEVELS.length);
    check('lock: no measurement → no wake/compounding keys (rows above), null freeze',
        rows[0].inputs.wake === undefined && rows[0].inputs.compounding === undefined
        && freezeCompounding(null) === null);

    // Score the LEAD row: shock 3 h after the ON prediction would be exact.
    const shockMs = EPOCH + 50.9 * 3.6e6;   // ON det arrival 47.9 h → err −3 h
    const lead = scoreFluxRopeEvent({
        forecast: { ...cRows[0],
            predicted_arrival_utc: new Date(EPOCH + 47.9 * 3.6e6).toISOString() },
        truth: { arrived: true, shockMs, minBzNt: -22.5 },
        launchIso: new Date(EPOCH).toISOString(),
    });
    const lc = lead.compounding;
    check('score: ON and OFF arrival errors vs the SAME shock',
        Math.abs(lc.arrivalErrOnH - -3) < 1e-9 && Math.abs(lc.arrivalErrOffH - -3) < 1e-9
        && Math.abs(lc.arrivalGainH) < 1e-9 && lc.follower === false);
    check('score: CRPS scored on both quantile sets, gain = OFF − ON',
        Number.isFinite(lc.crpsArrivalOffH)
        && Math.abs(lc.crpsGainH - (lc.crpsArrivalOffH - lead.crpsArrivalH)) < 1e-9);
    check('score: min-Bz errors both sides, gain rewards the closer side',
        Math.abs(lc.minBzErrOnNt - 8.5) < 1e-9 && Math.abs(lc.minBzErrOffNt - 11.5) < 1e-9
        && Math.abs(lc.minBzGainNt - 3) < 1e-9);
    check('score: observed vs predicted amplification over the SAME baseline',
        Math.abs(lc.ampObs - 22.5 / 11) < 1e-9 && Math.abs(lc.ampPred - 14 / 11) < 1e-9);
    check('score: Brier(−20 nT) on both sides',
        Math.abs(lc.brier20On - (0.35 - 1) ** 2) < 1e-9
        && Math.abs(lc.brier20Off - (0.28 - 1) ** 2) < 1e-9);

    // Score the FOLLOWER row: ON predicted 66.3 h, OFF 80 h, shock at 70 h —
    // the interacting model was 3.7 h early, the independent one 10 h late.
    const shock2 = EPOCH + 70 * 3.6e6;
    const follower = scoreFluxRopeEvent({
        forecast: { ...cRows[1],
            predicted_arrival_utc: new Date(EPOCH + 66.3 * 3.6e6).toISOString() },
        truth: { arrived: true, shockMs: shock2, minBzNt: -22.5 },
        launchIso: new Date(EPOCH).toISOString(),
    });
    const fcp = follower.compounding;
    check('score: follower gain positive when §16 beats independence',
        fcp.follower === true
        && Math.abs(fcp.arrivalErrOnH - -3.7) < 1e-9
        && Math.abs(fcp.arrivalErrOffH - 10) < 1e-9
        && Math.abs(fcp.arrivalGainH - 6.3) < 1e-9);

    const agg = aggregateFluxRopeScores([lead, follower]);
    const cagg = agg.compounding;
    check('aggregate: compounding block with the §19–§21 fitting signals',
        cagg.n === 2 && cagg.nFollowers === 1
        && Math.abs(cagg.followerBiasOnH - -3.7) < 1e-9
        && Math.abs(cagg.followerBiasOffH - 10) < 1e-9
        && Math.abs(cagg.arrivalGainH - (0 + 6.3) / 2) < 1e-9
        && cagg.preferOnFrac === 0.5
        && Math.abs(cagg.ampObs - 22.5 / 11) < 1e-9);
    check('aggregate: no compounding events → null block (never zeros)',
        aggregateFluxRopeScores([{ ...lead, compounding: null }]).compounding === null);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall flux-rope validation checks passed');
process.exit(failures ? 1 : 0);
