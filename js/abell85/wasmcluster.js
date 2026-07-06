// wasmcluster.js — drop-in replacement for StarCluster backed by the
// rust-abell85 WASM kernel (js/abell85-wasm/abell85_nbody.wasm). The kernel
// is an exact port of nbody.js's KDK/classify loops (parity asserted in
// tests/abell85-physics.mjs), so the two engines are interchangeable; WASM
// simply makes 10⁵ stars per lane affordable.
//
// Star arrays live in WASM linear memory; `pos`, `vel`, `flags` are typed-
// array VIEWS into it, so observables (surfaceDensity, losKinematics,
// starStateOf) run on them unchanged. Initial conditions are sampled by the
// SAME JS code (sampleClusterInto) writing through the views — one sampler,
// two engines, identical determinism.

import { sampleClusterInto, starStateOf } from './nbody.js';
import { G } from './units.js';

/** Fetch + instantiate the kernel. Returns null if unavailable. */
export async function loadNbodyWasm(url = new URL('../abell85-wasm/abell85_nbody.wasm', import.meta.url)) {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const { instance } = await WebAssembly.instantiate(
            await resp.arrayBuffer(), {});
        return instance;
    } catch {
        return null;
    }
}

export class WasmCluster {
    /**
     * @param sc       scenario from physics.makeScenario
     * @param n        particle count (10⁵ is fine here)
     * @param seed     PRNG seed (same sampler as the JS engine)
     * @param wasm     instantiated abell85_nbody module
     * @param rMax     sampling radius (pc)
     */
    constructor(sc, n, seed, wasm, rMax = 0) {
        this.sc = sc;
        this.n = n;
        this.seed = seed;
        this.wasm = wasm;
        this.rMax = rMax || Math.max(3 * sc.rInfl, 6000);
        this.mParticle = sc.host.menc(this.rMax) / n;
        const ex = wasm.exports;
        this._pPos = ex.alloc(n * 12);
        this._pVel = ex.alloc(n * 12);
        this._pFlags = ex.alloc(n);
        this._bindViews();
        this.ejectedCount = 0;
        this.coreRadius = 0;
        this.lLc = 0;
        this.reset(0);
    }

    /** (Re)create the typed-array views (memory may grow during alloc). */
    _bindViews() {
        const buf = this.wasm.exports.memory.buffer;
        this.pos = new Float32Array(buf, this._pPos, this.n * 3);
        this.vel = new Float32Array(buf, this._pVel, this.n * 3);
        this.flags = new Uint8Array(buf, this._pFlags, this.n);
    }

    get mEjected() { return this.ejectedCount * this.mParticle; }

    /** Point at a new scenario, REUSING the WASM allocations (the kernel's
     *  bump allocator never frees — reconfigure must not allocate again). */
    rebind(sc, rMax = 0) {
        this.sc = sc;
        this.rMax = rMax || Math.max(3 * sc.rInfl, 6000);
        this.mParticle = sc.host.menc(this.rMax) / this.n;
        this.reset(0);
    }

    reset(mDeficit = 0, tangentialBias = true) {
        if (this.pos.buffer !== this.wasm.exports.memory.buffer) this._bindViews();
        this.ejectedCount = Math.round(Math.min(mDeficit / this.mParticle, this.n * 0.5));
        this.coreRadius = sampleClusterInto(
            this.sc, this.rMax, this.n, this.seed, mDeficit, tangentialBias,
            this.pos, this.vel, this.flags);
    }

    step(dtMyr, bh1, m1, bh2, m2) {
        if (this.pos.buffer !== this.wasm.exports.memory.buffer) this._bindViews();
        const host = this.sc.host;
        this.ejectedCount += this.wasm.exports.step_cluster(
            this._pPos, this._pVel, this._pFlags, this.n, dtMyr,
            bh1[0], bh1[1], bh1[2], m1,
            bh2?.[0] ?? 0, bh2?.[1] ?? 0, bh2?.[2] ?? 0, m2 ?? 0,
            host.mStar, host.aScale, host.gamma, this.sc.rInfl);
    }

    classify(mBin, aBin) {
        if (this.pos.buffer !== this.wasm.exports.memory.buffer) this._bindViews();
        const nCone = this.wasm.exports.classify(
            this._pPos, this._pVel, this._pFlags, this.n,
            mBin > 0 ? mBin : 0, aBin > 0 ? aBin : 0);
        this.lLc = (mBin > 0 && aBin > 0) ? Math.sqrt(2 * G * mBin * aBin) : 0;
        return { nCone, lLc: this.lLc };
    }

    starState(i, mBh = 0) {
        return starStateOf(this, i, mBh);
    }
}
