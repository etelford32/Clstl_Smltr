/**
 * nbody-worker.js — Web Worker entry: runs the Yoshida-4 N-body
 * integration forward and backward from a chosen epoch and streams the
 * osculating elements of every planet (plus a VSOP87D Earth residual)
 * back to the main thread.
 *
 * Protocol
 * ────────
 *   main → worker  { type:'run', centerJd, startYear, endYear, dtDays,
 *                    sampleYears }
 *   worker → main  { type:'progress', frac, samplesSoFar }
 *                  { type:'sample',   jd, residualAU,
 *                                      bodies:{key:{a,e,i,node,omegaBar}} }
 *                  { type:'done',     samples:[...], maxResidualAU,
 *                                      energyDriftRel, runtimeMs }
 *                  { type:'error',    message }
 *
 * The Earth residual is the heliocentric position difference between the
 * N-body Earth and the VSOP87D reference Earth.  Most of it is mean-
 * longitude phase drift seeded by the finite-difference velocity, not
 * orbital-shape error.  Element evolution is the meaningful comparison.
 */

import {
    yoshida4Step, makeAccelBuffer, totalEnergy, stateToElements, GM_SUN,
} from './yoshida4.js';
import {
    buildInitialState, bodyHelio, bodyHelioVel,
    BODY_KEYS, EARTH_INDEX,
} from './nbody-init.js';
import { earthHeliocentric } from '../horizons.js';

const J2000 = 2451545.0;

// Planets only — asteroids in the model are perturbers, not measured here.
const PLANET_KEYS = BODY_KEYS.filter(k => k !== 'sun' &&
    !['ceres','vesta','pallas','hygiea'].includes(k));

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
    const t0        = performance.now();
    const baseState = buildInitialState(centerJd);
    const E0        = totalEnergy(baseState);

    // Pre-cache μ_eff = GM_sun + GM_body for each measured planet.
    const muMap = {};
    for (const key of PLANET_KEYS) {
        const idx = BODY_KEYS.indexOf(key);
        muMap[key] = GM_SUN + baseState.gm[idx];
    }

    const samples = [];

    // Sample the centre epoch itself.
    samples.push(measure(baseState, centerJd, muMap));

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
            const s = measure(state, jd, muMap);
            samples.push(s);
            totalSamples++;
            postProgress(totalSamples, expectedSamples);
        });

    propagate(back, -dtDays, yearsBackward * 365.25, sampleStepDays, centerJd,
        (state, jd) => {
            const s = measure(state, jd, muMap);
            samples.push(s);
            totalSamples++;
            postProgress(totalSamples, expectedSamples);
        });

    samples.sort((a, b) => a.jd - b.jd);

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
        planetKeys:     PLANET_KEYS,
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

function measure(state, jd, muMap) {
    const bodies = {};
    for (const key of PLANET_KEYS) {
        const idx = BODY_KEYS.indexOf(key);
        const h = bodyHelio   (state, idx);
        const v = bodyHelioVel(state, idx);
        const el = stateToElements(
            h.x, h.y, h.z,
            v.vx, v.vy, v.vz,
            muMap[key],
        );
        bodies[key] = {
            a:        el.a,
            e:        el.e,
            i:        el.i,
            node:     el.node,
            omegaBar: el.omegaBar,
        };
    }

    // Earth-only diagnostic: position residual vs VSOP87D
    const eh  = bodyHelio(state, EARTH_INDEX);
    const ref = earthHeliocentric(jd);
    const dx  = eh.x - ref.x_AU;
    const dy  = eh.y - ref.y_AU;
    const dz  = eh.z - ref.z_AU;
    const residualAU = Math.sqrt(dx*dx + dy*dy + dz*dz);

    const out = { jd, residualAU, bodies };
    self.postMessage({ type:'sample', ...out });
    return out;
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
