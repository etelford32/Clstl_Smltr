/**
 * sim-worker.js — Web Worker entry for the Gravity Lab physics loop
 * (P0.5, fixes D5). Owns the sim-core state; the main thread sends small
 * control messages and receives transferable binary snapshots
 * (snapshot-codec.js), ping-ponged so steady state allocates nothing.
 *
 * Protocol (main → worker):
 *   {type:'load', systemId, targetStep, j2Opts, j2Enabled, trailSpecs, trailCap}
 *   {type:'tick', dtRealSec, warp, direction, budgetMs}
 *   {type:'set', j2Enabled}
 *   {type:'clearDebt'} · {type:'clearTrails'} · {type:'rewind'}
 *   {type:'recycle', buffer}          — returns a consumed snapshot buffer
 *
 * Worker → main:
 *   {type:'snap', buffer, meta:{tick?, loaded?, rewound?, fault?, encounter?}}
 *   (buffer transferable; meta is a tiny structured-clone object)
 *
 * The worker never free-runs: it steps only on 'tick' requests, so the
 * frame-time debt / throttle semantics are identical to the inline path —
 * both drive the exact same sim-core advanceFrame.
 */

import { SYSTEMS } from './systems.js';
import {
    createSim,
    advanceFrame,
    rewind,
    clearDebt,
    clearTrailBuffers,
    configureTrails,
    currentEnergy,
    rebaselineEnergy,
} from './sim-core.js';
import { totalAngularMomentum } from './physics.js';
import { packSnapshot, snapshotBytes } from './snapshot-codec.js';

let sim = null;
let bufBytes = 0;
let gen = 0;      // echoed in every snapshot so the driver can drop stale ones
const pool = [];

function _snapshot(meta, res) {
    if (!sim) return;
    const buffer = pool.pop() ?? new ArrayBuffer(bufBytes);
    const E = currentEnergy(sim);
    const L = totalAngularMomentum(sim.bodies);
    packSnapshot(buffer, sim, {
        E,
        Lmag: Math.hypot(L[0], L[1], L[2]),
        stepsDone:   res?.stepsDone ?? 0,
        advancedSec: res?.advancedSec ?? 0,
    });
    meta.gen = gen;
    meta.encounter = sim.encounter ? { ...sim.encounter } : null;
    meta.fault = res?.fault ?? null;
    postMessage({ type: 'snap', buffer, meta }, [buffer]);
}

function _load(m) {
    const src = SYSTEMS[m.systemId];
    if (!src) return;
    gen = m.gen ?? gen + 1;
    const bodies = src.bodies.map(b => ({
        name: b.name,
        m:    b.m,
        r:    [b.r[0], b.r[1], b.r[2]],
        v:    [b.v[0], b.v[1], b.v[2]],
    }));
    sim = createSim({
        bodies,
        targetStep: m.targetStep,
        j2Opts:     m.j2Opts ?? null,
        j2Enabled:  !!m.j2Enabled,
    });
    configureTrails(sim, m.trailSpecs, m.trailCap);
    const nTrails = m.trailSpecs.filter(Boolean).length;
    bufBytes = snapshotBytes(bodies.length, nTrails, m.trailCap);
    pool.length = 0;
    _snapshot({ loaded: true });
}

onmessage = ev => {
    const m = ev.data;
    switch (m.type) {
        case 'load':
            _load(m);
            break;
        case 'tick':
            if (sim) {
                const res = advanceFrame(sim, {
                    dtRealSec: m.dtRealSec,
                    warp:      m.warp,
                    direction: m.direction,
                    budgetMs:  m.budgetMs,
                });
                _snapshot({ tick: true }, res);
            }
            break;
        case 'set':
            if (sim && 'j2Enabled' in m) {
                sim.j2Enabled = !!m.j2Enabled;
                rebaselineEnergy(sim);
                _snapshot({});
            }
            break;
        case 'clearDebt':
            if (sim) clearDebt(sim);
            break;
        case 'clearTrails':
            if (sim) {
                clearTrailBuffers(sim);
                _snapshot({});
            }
            break;
        case 'rewind':
            if (sim) {
                rewind(sim);   // restore also wipes the sim-side trail rings
                _snapshot({ rewound: true });
            }
            break;
        case 'recycle':
            if (m.buffer && m.buffer.byteLength === bufBytes && pool.length < 3) {
                pool.push(m.buffer);
            }
            break;
    }
};
