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
    configureParticles,
    currentEnergy,
    rebaselineEnergy,
    setBodyState,
    setSoftening,
    enableMegno,
} from './sim-core.js';
import { totalAngularMomentum } from './physics.js';
import { packSnapshot, snapshotBytes } from './snapshot-codec.js';
import { loadKernel } from './wasm/kernel.js';
import { generateParticles, binHistogram, computeOrbitsJS } from './particles.js';

// WASM kernel (P3.1): loaded once, lazily; failure means the JS path in
// sim-core carries on — same physics, parity-gated by the harness.
let _kernelPromise = null;
function _kernel() {
    if (!_kernelPromise) {
        _kernelPromise = loadKernel(new URL('./wasm/gravity_kernel.wasm', import.meta.url))
            .catch(err => {
                console.warn('[gravity-lab worker] WASM kernel unavailable — JS stepping:',
                    err?.message ?? err);
                return null;
            });
    }
    return _kernelPromise;
}

let sim = null;
let bufBytes = 0;
let gen = 0;      // echoed in every snapshot so the driver can drop stale ones
const pool = [];

// Test-particle bookkeeping (P3.2). The cloud itself lives in the sim
// (kernel memory or a JS Float64Array); the worker owns the histogram
// cadence and the JS-fallback orbits scratch buffer.
const HIST_INTERVAL_MS = 600;
let particleCfg = null;   // { scale, hist: {a_min_m, a_max_m, bins} }
let orbitsScratch = null; // JS fallback for kernel.orbitsView
let lastHistMs = 0;

function _histogram() {
    const P = sim.particles;
    const h = particleCfg.hist;
    let orbits;
    if (P.kernelBacked) {
        sim.kernel.computeOrbits(P.n, sim._primaryIdx);
        orbits = sim.kernel.orbitsView;
    } else {
        if (!orbitsScratch || orbitsScratch.length < P.n * 2) {
            orbitsScratch = new Float64Array(P.n * 2);
        }
        orbits = computeOrbitsJS(P.buf, P.n, sim.bodies[sim._primaryIdx], orbitsScratch);
    }
    return binHistogram(orbits, P.n, h.a_min_m, h.a_max_m, h.bins ?? 96);
}

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
        particleScale: particleCfg?.scale ?? 1,
    });
    if (sim.particles && particleCfg?.hist) {
        const t = performance.now();
        if (t - lastHistMs >= HIST_INTERVAL_MS) {
            lastHistMs = t;
            meta.hist = _histogram();
        }
    }
    meta.gen = gen;
    meta.kernel = !!sim.kernel;
    meta.encounter = sim.encounter ? { ...sim.encounter } : null;
    meta.fault = res?.fault ?? null;
    postMessage({ type: 'snap', buffer, meta }, [buffer]);
}

async function _load(m) {
    // Raw bodies (sandbox / baked epochs / share URLs — P2) take priority;
    // otherwise rebuild from the curated systems table.
    const srcBodies = m.rawBodies ?? SYSTEMS[m.systemId]?.bodies;
    if (!srcBodies) return;
    const kernel = await _kernel();   // ticks before readiness are guarded by `if (sim)`
    gen = m.gen ?? gen + 1;
    const bodies = srcBodies.map(b => ({
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
        softening:  m.softening ?? 0,
        kernel:     bodies.length <= (kernel?.maxBodies ?? 0) ? kernel : null,
    });
    configureTrails(sim, m.trailSpecs, m.trailCap);
    // Test particles (P3.2): generated HERE, deterministically, from the
    // spec — 20k×6 doubles never cross the thread boundary.
    particleCfg = null;
    let bins = null;
    if (m.particles?.n > 0) {
        const cloud = generateParticles(m.particles.spec, bodies, sim._primaryIdx, m.particles.n);
        configureParticles(sim, m.particles.n, cloud.buf);
        if (sim.particles) {
            bins = cloud.bins.length === sim.particles.n
                ? cloud.bins : cloud.bins.subarray(0, sim.particles.n);
            particleCfg = { scale: m.particles.scale, hist: m.particles.hist ?? null };
            lastHistMs = 0;
        }
    }
    const nTrails = m.trailSpecs.filter(Boolean).length;
    bufBytes = snapshotBytes(bodies.length, nTrails, m.trailCap, sim.particles?.n ?? 0);
    pool.length = 0;
    _snapshot(bins ? { loaded: true, particleBins: bins } : { loaded: true });
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
            } else {
                // Load still initializing (async WASM kernel fetch) — ack so
                // the driver's in-flight flag doesn't jam the tick pipeline.
                postMessage({ type: 'ack' });
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
        case 'setBody':
            if (sim) {
                setBodyState(sim, m.idx, m.r, m.v, m.pre);
                _snapshot({ edited: true });
            }
            break;
        case 'setSoftening':
            if (sim) {
                setSoftening(sim, m.eps);
                _snapshot({});
            }
            break;
        case 'setMegno':
            if (sim) {
                enableMegno(sim, !!m.on);
                _snapshot({});
            }
            break;
        case 'ping':
            if (sim) _snapshot({});
            break;
        case 'recycle':
            if (m.buffer && m.buffer.byteLength === bufBytes && pool.length < 3) {
                pool.push(m.buffer);
            }
            break;
    }
};
