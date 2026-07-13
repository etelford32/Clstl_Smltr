/**
 * sim-driver.js — one interface over two physics-loop homes (P0.5).
 *
 * WorkerDriver runs sim-core in a Web Worker: control messages out,
 * transferable binary snapshots back (snapshot-codec.js). InlineDriver is
 * the fallback (Worker construction failed, or ?worker=0) and runs the
 * SAME sim-core synchronously on the main thread — exactly the pre-worker
 * behavior. Both deliver results through one onSnapshot(view) callback so
 * lab.js has a single consumption path.
 *
 * Snapshot views from the worker alias the transferred buffer — lab.js
 * must consume them synchronously inside onSnapshot (it does: bodies are
 * copied in place, trails go straight into GPU attributes). The driver
 * recycles the buffer immediately after onSnapshot returns.
 *
 * Budget note: the inline path keeps the tight 6/4 ms main-thread budget
 * (physics competes with rendering there). The worker gets a bigger slice
 * — its thread has nothing else to do — which raises the max sustainable
 * warp for free. TODO(P3.1): SharedArrayBuffer + COOP/COEP headers would
 * drop even the snapshot copy; deferred so the static host needs no
 * header changes yet.
 */

import {
    createSim,
    advanceFrame,
    rewind,
    clearDebt,
    clearTrailBuffers,
    configureTrails,
    currentEnergy,
    rebaselineEnergy,
    PHYSICS_BUDGET_MS_DESKTOP,
    PHYSICS_BUDGET_MS_MOBILE,
} from './sim-core.js';
import { totalAngularMomentum } from './physics.js';
import { parseSnapshot } from './snapshot-codec.js';

const WORKER_BUDGET_MS_DESKTOP = 12;
const WORKER_BUDGET_MS_MOBILE  = 8;
const MAX_TICK_GULP_SEC = 0.1;   // matches the main loop's 100 ms frame cap

function _coarsePointer() {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

class InlineDriver {
    constructor(onSnapshot) {
        this.mode = 'inline';
        this.onSnapshot = onSnapshot;
        this.budgetMs = _coarsePointer() ? PHYSICS_BUDGET_MS_MOBILE : PHYSICS_BUDGET_MS_DESKTOP;
        this.sim = null;
    }

    load({ bodies, targetStep, j2Opts, j2Enabled, trailSpecs, trailCap }) {
        this.sim = createSim({ bodies, targetStep, j2Opts, j2Enabled });
        configureTrails(this.sim, trailSpecs, trailCap);
        this._emit({ loaded: true }, null);
    }

    tick({ dtRealSec, warp, direction }) {
        if (!this.sim) return;
        const res = advanceFrame(this.sim, {
            dtRealSec, warp, direction, budgetMs: this.budgetMs,
        });
        this._emit({ tick: true }, res);
    }

    setJ2(on) {
        if (!this.sim) return;
        this.sim.j2Enabled = !!on;
        rebaselineEnergy(this.sim);
        this._emit({}, null);
    }

    clearDebt()  { if (this.sim) clearDebt(this.sim); }

    clearTrails() {
        if (!this.sim) return;
        clearTrailBuffers(this.sim);
        this._emit({}, null);
    }

    rewind() {
        if (!this.sim) return;
        rewind(this.sim);   // restore also wipes the sim-side trail rings
        this._emit({ rewound: true }, null);
    }

    _emit(meta, res) {
        const sim = this.sim;
        const L = totalAngularMomentum(sim.bodies);
        this.onSnapshot({
            elapsedSec:  sim.elapsedSec,
            debtSec:     sim.debtSec,
            E:           currentEnergy(sim),
            Lmag:        Math.hypot(L[0], L[1], L[2]),
            energy0:     sim.energy0,
            energyScale: sim.energyScale,
            warpCap:     sim.warpCap,
            throttled:   sim.throttled,
            integrator:  sim.integrator,
            stepsDone:   res?.stepsDone ?? 0,
            advancedSec: res?.advancedSec ?? 0,
            bodies:      sim.bodies,      // live reference — zero copy
            trails:      sim.trails,      // live reference — zero copy
            encounter:   sim.encounter,
            fault:       res?.fault ?? null,
            loaded:      !!meta.loaded,
            rewound:     !!meta.rewound,
        });
    }
}

class WorkerDriver {
    constructor(onSnapshot) {
        this.mode = 'worker';
        this.onSnapshot = onSnapshot;
        this.budgetMs = _coarsePointer() ? WORKER_BUDGET_MS_MOBILE : WORKER_BUDGET_MS_DESKTOP;
        // Throws synchronously where module workers are unsupported —
        // createDriver catches and falls back inline.
        this.worker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = ev => this._onMsg(ev);
        this._bodies = null;       // parse target — set by load()
        this._outstanding = false; // one tick in flight at a time
        this._accumSec = 0;        // real time accrued while busy
        this._gen = 0;             // load generation — stale snapshots dropped
    }

    load(cfg) {
        this._bodies = cfg.bodies;
        this._outstanding = false;
        this._accumSec = 0;
        // Generation guard: a tick posted before this load can still have
        // a snapshot in flight for the PREVIOUS system (different body
        // count, different baselines). The worker echoes gen back and
        // _onMsg drops anything stale.
        this._gen++;
        // The worker rebuilds body state from systems.js itself — only the
        // config scalars cross the boundary.
        this.worker.postMessage({
            type: 'load',
            gen:        this._gen,
            systemId:   cfg.systemId,
            targetStep: cfg.targetStep,
            j2Opts:     cfg.j2Opts,
            j2Enabled:  cfg.j2Enabled,
            trailSpecs: cfg.trailSpecs,
            trailCap:   cfg.trailCap,
        });
    }

    tick({ dtRealSec, warp, direction }) {
        this._accumSec = Math.min(this._accumSec + dtRealSec, MAX_TICK_GULP_SEC);
        if (this._outstanding) return;   // worker still busy — time accrues
        this._outstanding = true;
        this.worker.postMessage({
            type: 'tick',
            dtRealSec: this._accumSec,
            warp, direction,
            budgetMs: this.budgetMs,
        });
        this._accumSec = 0;
    }

    setJ2(on)     { this.worker.postMessage({ type: 'set', j2Enabled: !!on }); }
    clearDebt()   { this.worker.postMessage({ type: 'clearDebt' }); }
    clearTrails() { this.worker.postMessage({ type: 'clearTrails' }); }
    rewind()      { this.worker.postMessage({ type: 'rewind' }); }

    _onMsg(ev) {
        const { type, buffer, meta } = ev.data;
        if (type !== 'snap' || !this._bodies) return;
        if (meta.tick) this._outstanding = false;
        if (meta.gen !== this._gen) {
            // Snapshot of a previous system — body layout may not even
            // match. Recycle the buffer (worker discards it on size
            // mismatch) and move on.
            this.worker.postMessage({ type: 'recycle', buffer }, [buffer]);
            return;
        }
        const view = parseSnapshot(buffer, meta, this._bodies);
        this.onSnapshot(view);
        // View consumed synchronously above — safe to hand the buffer back.
        this.worker.postMessage({ type: 'recycle', buffer }, [buffer]);
    }
}

/**
 * Build the best available driver. `forceInline` (e.g. from ?worker=0)
 * skips the worker for A/B comparisons and debugging.
 */
export function createDriver(onSnapshot, { forceInline = false } = {}) {
    if (!forceInline && typeof Worker === 'function') {
        try {
            return new WorkerDriver(onSnapshot);
        } catch (err) {
            console.warn('[gravity-lab] Worker unavailable, running physics inline:', err);
        }
    }
    return new InlineDriver(onSnapshot);
}
