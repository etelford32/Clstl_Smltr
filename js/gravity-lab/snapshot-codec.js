/**
 * snapshot-codec.js — binary layout shared by sim-worker.js (pack) and
 * sim-driver.js (parse). One ArrayBuffer per snapshot, ping-ponged
 * between threads as a transferable — zero-copy in both directions.
 *
 * Layout (byte offsets are all 8-aligned before the f32 region):
 *   f64[0..HDR)        header — see indices below
 *   f64[HDR .. +6N)    body state: [x,y,z,vx,vy,vz] × N   (SI)
 *   f64[.. +3N)        trail meta: [head, count, total] × N (head = -2 ⇒ no trail)
 *   f32[..]            trail rings: cap×3 floats per trailed body, in body order
 *                      (scene units, matching sim-core's trail buffers)
 */

export const HDR = 16;

// Header indices.
export const H_ELAPSED   = 0;
export const H_DEBT      = 1;
export const H_ENERGY    = 2;
export const H_LMAG      = 3;
export const H_ENERGY0   = 4;
export const H_ESCALE    = 5;
export const H_WARPCAP   = 6;   // Infinity encoded as -1
export const H_FLAGS     = 7;   // bit0 throttled · bit1 adaptive integrator
export const H_STEPS     = 8;
export const H_ADVANCED  = 9;
export const H_NBODIES   = 10;
export const H_TRAILCAP  = 11;

export function snapshotBytes(nBodies, nTrails, trailCap) {
    return 8 * (HDR + nBodies * 6 + nBodies * 3) + 4 * (nTrails * trailCap * 3);
}

/** Worker side: serialize sim state + per-tick results into `buffer`. */
export function packSnapshot(buffer, sim, extra) {
    const bodies = sim.bodies;
    const N = bodies.length;
    const trails = sim.trails || [];
    const trailCap = trails.find(t => t)?.cap ?? 0;

    const f64 = new Float64Array(buffer, 0, HDR + N * 9);
    f64[H_ELAPSED]  = sim.elapsedSec;
    f64[H_DEBT]     = sim.debtSec;
    f64[H_ENERGY]   = extra.E;
    f64[H_LMAG]     = extra.Lmag;
    f64[H_ENERGY0]  = sim.energy0;
    f64[H_ESCALE]   = sim.energyScale;
    f64[H_WARPCAP]  = Number.isFinite(sim.warpCap) ? sim.warpCap : -1;
    f64[H_FLAGS]    = (sim.throttled ? 1 : 0) | (sim.integrator === 'rkf78' ? 2 : 0);
    f64[H_STEPS]    = extra.stepsDone ?? 0;
    f64[H_ADVANCED] = extra.advancedSec ?? 0;
    f64[H_NBODIES]  = N;
    f64[H_TRAILCAP] = trailCap;

    let o = HDR;
    for (let i = 0; i < N; i++) {
        const b = bodies[i];
        f64[o]     = b.r[0]; f64[o + 1] = b.r[1]; f64[o + 2] = b.r[2];
        f64[o + 3] = b.v[0]; f64[o + 4] = b.v[1]; f64[o + 5] = b.v[2];
        o += 6;
    }
    for (let i = 0; i < N; i++) {
        const tr = trails[i];
        f64[o]     = tr ? tr.head  : -2;
        f64[o + 1] = tr ? tr.count : 0;
        f64[o + 2] = tr ? tr.total : 0;
        o += 3;
    }
    if (trailCap > 0) {
        let f32o = 0;
        const f32 = new Float32Array(buffer, 8 * (HDR + N * 9));
        for (let i = 0; i < N; i++) {
            const tr = trails[i];
            if (!tr) continue;
            f32.set(tr.buf, f32o);
            f32o += tr.buf.length;
        }
    }
}

/**
 * Main-thread side: decode `buffer` into a view object shaped like the
 * sim fields the renderer/HUD read, writing body state into `outBodies`
 * in place. The trail views alias the transferred buffer — consume them
 * synchronously BEFORE recycling the buffer back to the worker.
 */
export function parseSnapshot(buffer, meta, outBodies) {
    const head = new Float64Array(buffer, 0, HDR);
    const N = head[H_NBODIES];
    const trailCap = head[H_TRAILCAP];
    const f64 = new Float64Array(buffer, 0, HDR + N * 9);

    let o = HDR;
    for (let i = 0; i < N; i++) {
        const b = outBodies[i];
        b.r[0] = f64[o];     b.r[1] = f64[o + 1]; b.r[2] = f64[o + 2];
        b.v[0] = f64[o + 3]; b.v[1] = f64[o + 4]; b.v[2] = f64[o + 5];
        o += 6;
    }
    const trails = new Array(N);
    const f32 = trailCap > 0 ? new Float32Array(buffer, 8 * (HDR + N * 9)) : null;
    let f32o = 0;
    for (let i = 0; i < N; i++) {
        const h = f64[o];
        if (h === -2) {
            trails[i] = null;
        } else {
            trails[i] = {
                head:  h,
                count: f64[o + 1],
                total: f64[o + 2],
                cap:   trailCap,
                buf:   f32.subarray(f32o, f32o + trailCap * 3),
            };
            f32o += trailCap * 3;
        }
        o += 3;
    }

    return {
        elapsedSec:  head[H_ELAPSED],
        debtSec:     head[H_DEBT],
        E:           head[H_ENERGY],
        Lmag:        head[H_LMAG],
        energy0:     head[H_ENERGY0],
        energyScale: head[H_ESCALE],
        warpCap:     head[H_WARPCAP] < 0 ? Infinity : head[H_WARPCAP],
        throttled:   (head[H_FLAGS] & 1) !== 0,
        integrator:  (head[H_FLAGS] & 2) !== 0 ? 'rkf78' : 'yoshida4',
        stepsDone:   head[H_STEPS],
        advancedSec: head[H_ADVANCED],
        bodies:      outBodies,
        trails,
        encounter:   meta.encounter ?? null,
        fault:       meta.fault ?? null,
        loaded:      !!meta.loaded,
        rewound:     !!meta.rewound,
    };
}
