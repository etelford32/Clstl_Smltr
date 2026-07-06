// wasmswarm.js — drop-in replacement for SatSwarm backed by the rust-storm
// WASM kernel (js/storm-wasm/storm_drag.wasm). The kernel is a line-for-line
// port of orbits.js whose DECAY STATE stays bit-exact with the JS engine
// (asserted in tests/storm-physics.mjs), so the two are interchangeable —
// WASM makes the 20k-object population cheap enough to run three lanes.
//
// State arrays live in WASM linear memory; `a`, `e`, `flags`, … are typed-
// array VIEWS into it, so the shared helpers (initStateInto, countsOf,
// objectStateOf) run on them unchanged. Density grids are uploaded once per
// grid object and re-uploaded only when the lane's grid identity changes
// (scenario dial changes rebake → re-upload into the same slot).

import { initStateInto, countsOf, objectStateOf } from './orbits.js';
import { STRIDE } from './catalog.js';

/** Fetch + instantiate the kernel. Returns null if unavailable. */
export async function loadStormWasm(url = new URL('../storm-wasm/storm_drag.wasm', import.meta.url)) {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const { instance } = await WebAssembly.instantiate(await resp.arrayBuffer(), {});
        return instance;
    } catch {
        return null;
    }
}

export class WasmSwarm {
    /**
     * @param els   Float32Array packed catalog (catalog.js layout)
     * @param meta  catalog meta ({ n, cohorts, named })
     * @param wasm  instantiated storm_drag module
     */
    constructor(els, meta, wasm) {
        const n = this.n = meta.n;
        this.meta = meta;
        this.els0 = els;
        this.wasm = wasm;
        const ex = wasm.exports;
        this._p = {
            a: ex.alloc(n * 8), e: ex.alloc(n * 8),
            cosI: ex.alloc(n * 8), sinI: ex.alloc(n * 8),
            raan: ex.alloc(n * 8), argp: ex.alloc(n * 8), M: ex.alloc(n * 8),
            bc: ex.alloc(n * 8), raiseRate: ex.alloc(n * 8),
            flags: ex.alloc(n), tReentry: ex.alloc(n * 4),
            pos: ex.alloc(n * 12),
        };
        // JS-side (reporting-only) state initStateInto also fills
        this.incl = new Float64Array(n);
        this.cls = new Uint8Array(n);
        this._grid = null;
        this._gridPtr = 0; this._gridCap = 0;
        this._altPtr = 0; this._altCap = 0;
        this._bindViews();
        this.reset();
    }

    /** (Re)create views (memory may grow on any alloc). */
    _bindViews() {
        const buf = this.wasm.exports.memory.buffer;
        if (this._buf === buf) return;
        this._buf = buf;
        const n = this.n, p = this._p;
        this.a = new Float64Array(buf, p.a, n);
        this.e = new Float64Array(buf, p.e, n);
        this.cosI = new Float64Array(buf, p.cosI, n);
        this.sinI = new Float64Array(buf, p.sinI, n);
        this.raan = new Float64Array(buf, p.raan, n);
        this.argp = new Float64Array(buf, p.argp, n);
        this.M = new Float64Array(buf, p.M, n);
        this.bc = new Float64Array(buf, p.bc, n);
        this.raiseRate = new Float64Array(buf, p.raiseRate, n);
        this.flags = new Uint8Array(buf, p.flags, n);
        this.tReentry = new Float32Array(buf, p.tReentry, n);
        this.posView = new Float32Array(buf, p.pos, n * 3);
        if (this._gridPtr) {
            this._gridView = new Float64Array(buf, this._gridPtr, this._gridCap / 8);
            this._altView = new Float64Array(buf, this._altPtr, this._altCap / 8);
        }
    }

    reset() {
        this._bindViews();
        initStateInto(this.els0, this.n, this);
        this.tNow = 0;
    }

    setRaiseRate(cls, mPerSecPerDay) {
        this._bindViews();
        for (let i = 0; i < this.n; i++) {
            if (this.cls[i] === cls) this.raiseRate[i] = mPerSecPerDay;
        }
    }

    /** Upload a DensityGrid (or baked scenario grid) into the shared slot;
     *  cached by object identity so steady state uploads nothing. */
    _ensureGrid(grid) {
        if (this._grid === grid) return;
        const ex = this.wasm.exports;
        const flatBytes = grid.nT * grid.nA * 8;
        if (flatBytes > this._gridCap) {
            this._gridPtr = ex.alloc(flatBytes);
            this._gridCap = flatBytes;
            this._buf = null;                        // realloc may grow memory
        }
        if (grid.nA * 8 > this._altCap) {
            this._altPtr = ex.alloc(grid.nA * 8);
            this._altCap = grid.nA * 8;
            this._buf = null;
        }
        this._bindViews();
        this._gridView = new Float64Array(this.wasm.exports.memory.buffer,
            this._gridPtr, grid.nT * grid.nA);
        this._altView = new Float64Array(this.wasm.exports.memory.buffer,
            this._altPtr, grid.nA);
        for (let t = 0; t < grid.nT; t++) this._gridView.set(grid.logRho[t], t * grid.nA);
        this._altView.set(grid.altKm);
        this._grid = grid;
    }

    step(grid, tHours, dtHours) {
        this._ensureGrid(grid);
        const p = this._p;
        const newly = this.wasm.exports.step_swarm(
            p.a, p.e, p.cosI, p.raan, p.argp, p.M, p.bc, p.raiseRate,
            p.flags, p.tReentry, this.n,
            this._gridPtr, this._altPtr, grid.nT, grid.nA, grid.stepHours,
            tHours, dtHours);
        this.tNow = tHours + dtHours;
        return newly;
    }

    classify(grid, tHours, qThresholdPa = 3e-4) {
        this._ensureGrid(grid);
        const p = this._p;
        return this.wasm.exports.classify_swarm(
            p.a, p.e, p.flags, this.n,
            this._gridPtr, this._altPtr, grid.nT, grid.nA, grid.stepHours,
            tHours, qThresholdPa);
    }

    positionsInto(out) {
        const p = this._p;
        this.wasm.exports.positions_into(
            p.a, p.e, p.cosI, p.sinI, p.raan, p.argp, p.M, p.flags,
            this.n, p.pos);
        this._bindViews();
        out.set(this.posView.subarray(0, out.length));
    }

    counts() { this._bindViews(); return countsOf(this); }

    objectState(i, grid, tHours) {
        this._bindViews();
        return objectStateOf(this, i, grid, tHours);
    }
}
