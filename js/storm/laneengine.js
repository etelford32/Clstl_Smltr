// laneengine.js — one Storm Observatory lane: a density history (bundle or
// baked scenario) + the shared 20k-object swarm integrated against it.
// Physics only — no DOM, no WebGL — so the SAME class runs inside the module
// Worker (simworker.js) and, as a fallback, synchronously on the main thread
// (the abell85 pattern).
//
// Time is deterministic replay: scrubbing backward RESETS and re-integrates
// (bit-exact engines make this reproducible), chunked so a long fast-forward
// never freezes a frame — the lane reports `behind` and keeps sweeping.

import { makeScenario } from './bundle.js';
import { SatSwarm } from './orbits.js';
import { WasmSwarm } from './wasmswarm.js';
import { CLS } from './catalog.js';

const MAX_CHUNK_H = 3;            // integration chunk (substeps refine low perigees)
const MAX_CHUNKS_PER_CALL = 24;   // cap per frame message — stay responsive

export class StormLane {
    /**
     * @param id      lane id ('feb2022' | 'gannon' | 'scenario')
     * @param bundle  hydrated lane bundle (bundle.js)
     * @param els     packed catalog Float32Array (shared, read-only)
     * @param meta    catalog meta
     * @param wasm    storm_drag instance or null (JS engine)
     * @param opts    { raiseRate m/s/day on the cohort, cohortBc m²/kg }
     */
    constructor(id, bundle, els, meta, wasm, opts = {}) {
        this.id = id;
        this.bundle = bundle;
        this.grid = bundle.grid;
        this.swarm = wasm
            ? new WasmSwarm(els, meta, wasm)
            : new SatSwarm(els, meta);
        this.opts = { raiseRate: 0, cohortBc: null, ...opts };
        this.tNow = 0;
        this.behind = false;
        this._applyOpts();
    }

    _applyOpts() {
        const { raiseRate, cohortBc } = this.opts;
        if (cohortBc != null) {
            for (let i = 0; i < this.swarm.n; i++) {
                if (this.swarm.cls[i] === CLS.COHORT) this.swarm.bc[i] = cohortBc;
            }
        }
        this.swarm.setRaiseRate(CLS.COHORT, raiseRate);
    }

    reset() {
        this.swarm.reset();
        this._applyOpts();
        this.tNow = 0;
    }

    /** Change cohort thrust/attitude dials — deterministic, so re-run. */
    reconfigure(opts) {
        this.opts = { ...this.opts, ...opts };
        const target = this.tNow;
        this.reset();
        this.setTime(target, Infinity);
    }

    /** Swap this lane's density history for a composed scenario. */
    setScenario(quietBundle, baseBundle, dials) {
        const lane = makeScenario(quietBundle, baseBundle, dials);
        const durScale = dials.durationScale ?? 1;
        const nT = Math.ceil(baseBundle.grid.nT * Math.max(durScale, 1)) +
            Math.ceil(Math.max(dials.onsetShiftHours ?? 0, 0) / baseBundle.stepHours);
        this.grid = lane.grid.bake(nT);
        this.bundle = { ...lane, grid: this.grid, durationHours: (nT - 1) * lane.stepHours };
        const target = Math.min(this.tNow, this.bundle.durationHours);
        this.reset();
        this.setTime(target, Infinity);
    }

    /** Integrate toward absolute lane-hours `target` (chunked). */
    setTime(target, maxChunks = MAX_CHUNKS_PER_CALL) {
        target = Math.min(Math.max(target, 0), this.bundle.durationHours);
        if (target < this.tNow - 1e-9) this.reset();
        let chunks = 0;
        while (this.tNow < target - 1e-9 && chunks < maxChunks) {
            const dt = Math.min(MAX_CHUNK_H, target - this.tNow);
            this.swarm.step(this.grid, this.tNow, dt);
            this.tNow += dt;
            chunks++;
        }
        this.behind = target - this.tNow > 1e-6;
        this.swarm.classify(this.grid, this.tNow);
    }

    /** Compact per-frame record (positions written into `pos` by caller). */
    state() {
        const c = this.swarm.counts();
        const idx = Math.min(Math.round(this.tNow / this.bundle.stepHours),
            this.bundle.drivers.ap.length - 1);
        let cohortLeft = 0;
        for (let i = 0; i < this.swarm.n; i++) {
            if (this.swarm.cls[i] === CLS.COHORT && this.swarm.flags[i] !== 2) cohortLeft++;
        }
        return {
            id: this.id, t: this.tNow, behind: this.behind,
            tau: this.tNow - this.bundle.tPeakHours,
            counts: c, cohortLeft,
            rho400: this.grid.sample(400, this.tNow),
            apNow: this.bundle.drivers.ap[idx],
            f107Now: this.bundle.drivers.f107[idx],
        };
    }
}
