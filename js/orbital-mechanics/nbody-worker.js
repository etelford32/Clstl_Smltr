/**
 * nbody-worker.js — Web Worker entry: runs the Yoshida-4 N-body
 * integration forward and backward from J2000 and streams Earth's
 * osculating elements + VSOP87D residual back to the main thread.
 *
 * Protocol
 * ────────
 *   main → worker  { type:'run', startYear, endYear, dtDays, sampleYears }
 *   worker → main  { type:'progress', frac, samplesSoFar }
 *                  { type:'sample',   jd, e, omegaBar, residualAU }
 *                  { type:'done',     samples:[...], maxResidualAU,
 *                                     energyDriftRel, runtimeMs }
 *                  { type:'error',    message }
 *
 * The residual is the heliocentric position difference between the N-body
 * Earth and the VSOP87D reference Earth at the same JD.  Inside the
 * ±2 kyr validated window this should stay below ~1e-3 AU (roughly a
 * lunar distance) for Earth — most of which is Earth's intra-orbital
 * phase angle drift, not a real orbital error.
 */

import {
    yoshida4Step, makeAccelBuffer, totalEnergy, stateToElements, GM_SUN,
} from './yoshida4.js';
import {
    buildInitialState, bodyHelio, bodyHelioVel, EARTH_INDEX,
} from './nbody-init.js';
import { earthHeliocentric } from '../horizons.js';

const J2000 = 2451545.0;

self.onmessage = ev => {
    const m = ev.data;
    if (m.type !== 'run') return;
    try {
        runIntegration(m);
    } catch (err) {
        self.postMessage({ type:'error', message: err && err.message || String(err) });
    }
};

function runIntegration({
    centerJd    = J2000,
    startYear   = -2000,
    endYear     =  2000,
    dtDays      = 1,
    sampleYears = 25,
}) {
    const t0       = performance.now();
    const baseState = buildInitialState(centerJd);
    const muEarth  = GM_SUN + baseState.gm[EARTH_INDEX];
    const E0       = totalEnergy(baseState);

    const samples = [];

    // Sample the centre epoch itself.
    samples.push(measure(baseState, centerJd, muEarth));

    // ── Forward + backward legs ────────────────────────────────────
    const fwd  = cloneState(baseState);
    const back = cloneState(baseState);

    const sampleStepDays = sampleYears * 365.25;
    const yearsForward   = Math.max(0,  endYear);
    const yearsBackward  = Math.max(0, -startYear);

    let totalSamples = 0;
    const expectedSamples =
        Math.floor(yearsForward  / sampleYears) +
        Math.floor(yearsBackward / sampleYears) + 1;

    propagate(fwd, +dtDays, yearsForward * 365.25, sampleStepDays, centerJd,
        (state, jd) => {
            const s = measure(state, jd, muEarth);
            samples.push(s);
            totalSamples++;
            postProgress(totalSamples, expectedSamples);
        });

    propagate(back, -dtDays, yearsBackward * 365.25, sampleStepDays, centerJd,
        (state, jd) => {
            const s = measure(state, jd, muEarth);
            samples.push(s);
            totalSamples++;
            postProgress(totalSamples, expectedSamples);
        });

    // Sort by JD ascending so the plot can stream them in order.
    samples.sort((a, b) => a.jd - b.jd);

    // Energy diagnostics — compare the two endpoint states.
    const Eend1 = totalEnergy(fwd);
    const Eend2 = totalEnergy(back);
    const driftRel = Math.max(
        Math.abs((Eend1 - E0) / E0),
        Math.abs((Eend2 - E0) / E0),
    );

    let maxRes = 0;
    for (const s of samples) if (s.residualAU > maxRes) maxRes = s.residualAU;

    self.postMessage({
        type:           'done',
        samples,
        maxResidualAU:  maxRes,
        energyDriftRel: driftRel,
        runtimeMs:      performance.now() - t0,
        nBodies:        baseState.gm.length,
        dtDays,
    });
}

function propagate(state, dt, totalDuration, sampleStep, jdStart, onSample) {
    if (totalDuration <= 0) return;
    const stepsPerSample = Math.max(1, Math.round(sampleStep / Math.abs(dt)));
    const totalSteps     = Math.ceil(totalDuration / Math.abs(dt));
    const accel = makeAccelBuffer(state.gm.length);
    let stepCount = 0;
    while (stepCount < totalSteps) {
        const remaining = Math.min(stepsPerSample, totalSteps - stepCount);
        for (let k = 0; k < remaining; k++) {
            yoshida4Step(state, dt, accel);
            stepCount++;
        }
        const jd = jdStart + stepCount * dt;
        onSample(state, jd);
    }
}

function measure(state, jd, muEarth) {
    const helio  = bodyHelio(state, EARTH_INDEX);
    const helioV = bodyHelioVel(state, EARTH_INDEX);
    const el = stateToElements(
        helio.x, helio.y, helio.z,
        helioV.vx, helioV.vy, helioV.vz,
        muEarth,
    );

    // Residual against VSOP87D — heliocentric position difference (AU).
    const ref = earthHeliocentric(jd);
    const dx  = helio.x - ref.x_AU;
    const dy  = helio.y - ref.y_AU;
    const dz  = helio.z - ref.z_AU;
    const residualAU = Math.sqrt(dx*dx + dy*dy + dz*dz);

    self.postMessage({ type:'sample', jd, e: el.e, omegaBar: el.omegaBar, residualAU });
    return { jd, e: el.e, omegaBar: el.omegaBar, residualAU };
}

function postProgress(samplesSoFar, total) {
    const frac = total > 0 ? Math.min(1, samplesSoFar / total) : 1;
    self.postMessage({ type:'progress', frac, samplesSoFar });
}

function cloneState(s) {
    return {
        r:  s.r.slice(),
        v:  s.v.slice(),
        gm: s.gm.slice(),
        jd: s.jd,
    };
}
