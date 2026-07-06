// laneengine.js — one simulation lane, physics only. No DOM, no WebGL, no
// wall-clock: everything a lane computes per frame lives here so the SAME
// class runs inside the module Worker (simworker.js) and, as a fallback,
// synchronously on the main thread. Rendering, camera, trails, and the
// wall-clock merger choreography stay main-side.
//
// A lane = scenario + history + live star cluster + live PN endgame +
// throttled mock observables. setTime(t, tick) advances the lane to an
// absolute epoch on its own clock and returns a compact state record whose
// big arrays (star positions/flags) are transferable Float32/Uint8 views.

import { makeScenario, buildHistory, sampleAt } from './physics.js';
import { StarCluster } from './nbody.js';
import { WasmCluster } from './wasmcluster.js';
import { PNBinary } from './pn.js';
import { orbitalBasis, bodiesAt } from './geometry.js';
import { surfaceDensity, cuspRadius } from './observables.js';
import { rGrav } from './units.js';

const PN_WINDOW_RG = 300;

export class LaneEngine {
    /**
     * @param id        scenario id ('holm15a' | 'a402' | 'b20402')
     * @param opts      { overrides, nStars, seed, incl, node, pnSubsteps }
     */
    constructor(id, opts = {}) {
        this.id = id;
        this.overrides = opts.overrides ?? {};
        this.sc = makeScenario(id, this.overrides);
        this.history = buildHistory(this.sc);
        this.wasm = opts.wasm ?? null;      // instantiated abell85_nbody module
        this.cluster = this.wasm
            ? new WasmCluster(this.sc, opts.nStars ?? 32768, opts.seed ?? 85, this.wasm)
            : new StarCluster(this.sc, opts.nStars ?? 3072, opts.seed ?? 85);
        this.incl = opts.incl ?? 0.45;
        this.node = opts.node ?? 0.5;
        this.basis = orbitalBasis(this.incl, this.node);
        this.pnSubsteps = opts.pnSubsteps ?? 8000;
        this.livePN = null;
        this.livePhase = 0;
        this.tNow = NaN; this.clusterT = NaN;
        this.lc = { nCone: 0, lLc: 0 };
        this.rGamma = NaN;
        this._photoCountdown = 0;
        this.rosette = [];            // [{buf: Float32Array, count}]
        this._rosetteCountdown = 0;
        this.mergedNow = false;
    }

    /** Rebuild with new physics overrides (constraint sliders). */
    reconfigure(overrides) {
        const keep = { nStars: this.cluster.n, seed: this.cluster.seed };
        this.overrides = { ...this.overrides, ...overrides };
        this.sc = makeScenario(this.id, this.overrides);
        this.history = buildHistory(this.sc);
        if (this.wasm) {
            this.cluster.rebind(this.sc);   // reuse WASM buffers (bump allocator)
        } else {
            this.cluster = new StarCluster(this.sc, keep.nStars, keep.seed);
        }
        this.livePN = null; this.rosette = [];
        this.tNow = NaN; this.clusterT = NaN;
    }

    _resync(now) {
        this.cluster.reset(now.mej, true);
        this.clusterT = this.tNow;
        this.livePhase = now.phase;
        this.livePN = null;
        this.rosette = [];
    }

    /**
     * Advance to absolute epoch t. `tick` is an arbitrary monotonic counter
     * used only for throttling expensive observables (no wall-clock here).
     */
    setTime(t, tick = 0) {
        const first = !Number.isFinite(this.tNow);
        const dtSim = first ? 0 : Math.max(t - this.tNow, 0);
        const jumped = first || t < this.tNow - 1e-9;
        this.tNow = t;
        const now = sampleAt(this.history, t);
        if (jumped) this._resync(now);

        // binary: live PN in-window (spin precession when spins present)
        let bhs = null;
        const inWin = now.a > 0 && now.a < PN_WINDOW_RG * rGrav(this.sc.mTot);
        if (inWin && dtSim > 0) {
            if (!this.livePN) {
                this.livePN = new PNBinary(this.sc, {
                    a: now.a, e: now.e, phase: this.livePhase, peri: now.peri,
                    incl: this.incl, node: this.node,
                }, this.sc.kick === 'superkick' ? { precess: {} } : {});
            }
            const adv = this.livePN.step(dtSim, this.pnSubsteps);
            if (adv >= dtSim * 0.999) {
                bhs = this.livePN.positions();
                if (--this._rosetteCountdown <= 0) {
                    const pts = this.livePN.ellipsePoints(96);
                    if (pts) {
                        this.rosette.push({ buf: pts, count: 97 });
                        if (this.rosette.length > 7) this.rosette.shift();
                    }
                    this._rosetteCountdown = 40;      // ~every 40 frames
                }
            } else { this.livePN = null; }
        } else if (!inWin) {
            this.livePN = null;
            if (now.a <= 0) this.rosette = [];
        }
        if (!bhs) {
            if (now.a > 0 && now.fgw > 0 && dtSim > 0) {
                const pMyr = 2 / now.fgw / 3.15576e13;
                this.livePhase = (this.livePhase + 2 * Math.PI * dtSim / pMyr) % (2 * Math.PI);
            }
            bhs = bodiesAt(this.sc, this.history, now, this.livePhase, this.basis);
        }

        // star cluster catch-up
        const gap = this.tNow - this.clusterT;
        if (gap > 200 || gap < 0) {
            this._resync(now);
        } else if (gap > 0) {
            const dt = Math.min(gap, 1.0);
            this.cluster.step(dt, bhs[0].p, bhs[0].m, bhs[1]?.p ?? [0, 0, 0], bhs[1]?.m ?? 0);
            this.clusterT += dt;
        }
        this.lc = this.cluster.classify(now.a > 0 ? this.sc.mTot : 0, now.a);

        // throttled mock photometry
        if (--this._photoCountdown <= 0) {
            this.rGamma = cuspRadius(surfaceDensity(this.cluster));
            this._photoCountdown = 55;
        }

        this.mergedNow = !first && now.a <= 0 && this._prevA > 0;
        this._prevA = now.a;

        return {
            id: this.id,
            t, now: {
                t: now.t, a: now.a, e: now.e, stage: now.stage,
                fgw: now.fgw, h: now.h, mej: now.mej, peri: now.peri,
                remnantOffset: now.remnantOffset ?? 0,
            },
            bhs: bhs.map(b => ({ p: b.p, m: b.m })),
            phase: this.livePhase,
            lc: this.lc,
            rGamma: this.rGamma,
            merged: this.mergedNow,
        };
    }
}
