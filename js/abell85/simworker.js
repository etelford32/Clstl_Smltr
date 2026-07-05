// simworker.js — module Web Worker hosting every simulation lane's physics.
// The main thread owns rendering, camera, trails, charts, and merger
// choreography; this worker owns the O(N) work: star-cluster integration,
// loss-cone classification, live PN stepping, mock photometry.
//
// Protocol (structured clone + transferables):
//   → { type:'init',  lanes:[{id, opts}] }
//   → { type:'reconfigure', id, overrides }
//   → { type:'frame', seq, ts:[{id, t}], tick,
//       pools:{ [id]: {pos:ArrayBuffer, flags:ArrayBuffer} } }   // returned buffers
//   ← { type:'ready', lanes:[{id, n, meta}] }
//   ← { type:'state', seq, lanes:[{id, n, pos, flags, bhs, now, phase, lc,
//                                  rGamma, merged, rosette}] }   // pos/flags transferred
//
// Star positions/flags travel as transferables and are ping-ponged back on
// the next frame message, so steady-state allocates nothing.

import { LaneEngine } from './laneengine.js';

const engines = new Map();

self.onmessage = (ev) => {
    const msg = ev.data;

    if (msg.type === 'init') {
        engines.clear();
        const meta = [];
        for (const l of msg.lanes) {
            const eng = new LaneEngine(l.id, l.opts);
            engines.set(l.id, eng);
            meta.push({
                id: l.id, n: eng.cluster.n,
                sc: publicScenario(eng.sc),
                events: publicEvents(eng.history.events),
            });
        }
        self.postMessage({ type: 'ready', lanes: meta });
        return;
    }

    if (msg.type === 'reconfigure') {
        const eng = engines.get(msg.id);
        if (!eng) return;
        eng.reconfigure(msg.overrides);
        self.postMessage({
            type: 'reconfigured', id: msg.id,
            sc: publicScenario(eng.sc),
            events: publicEvents(eng.history.events),
            samples: packSamples(eng.history.samples),
        });
        return;
    }

    if (msg.type === 'frame') {
        const out = [];
        const transfer = [];
        for (const { id, t } of msg.ts) {
            const eng = engines.get(id);
            if (!eng) continue;
            const st = eng.setTime(t, msg.tick);
            // fill (or allocate) the transferable star buffers
            const n = eng.cluster.n;
            const pool = msg.pools?.[id];
            const pos = pool?.pos && pool.pos.byteLength >= n * 12
                ? new Float32Array(pool.pos, 0, n * 3) : new Float32Array(n * 3);
            const flags = pool?.flags && pool.flags.byteLength >= n
                ? new Uint8Array(pool.flags, 0, n) : new Uint8Array(n);
            pos.set(eng.cluster.pos.subarray(0, n * 3));
            flags.set(eng.cluster.flags.subarray(0, n));
            transfer.push(pos.buffer, flags.buffer);
            out.push({
                ...st, n,
                pos: pos.buffer, flags: flags.buffer,
                rosette: eng.rosette.map(r => ({ pts: Array.from(r.buf), count: r.count })),
            });
        }
        self.postMessage({ type: 'state', seq: msg.seq, lanes: out }, transfer);
        return;
    }

    if (msg.type === 'samples') {
        const eng = engines.get(msg.id);
        if (eng) {
            self.postMessage({
                type: 'samples', id: msg.id,
                samples: packSamples(eng.history.samples),
            });
        }
    }
};

/** Scenario fields the UI needs (functions like host() stay worker-side). */
function publicScenario(sc) {
    return {
        id: sc.id, name: sc.name, mTot: sc.mTot, m1: sc.m1, m2: sc.m2,
        q: sc.q, sigma: sc.sigma, mStar: sc.mStar, dMpc: sc.dMpc,
        rInfl: sc.rInfl, aHard: sc.aHard, aPlunge: sc.aPlunge,
        vEsc: sc.vEsc, kick: sc.kick, refill: sc.refill, eccH: sc.eccH,
    };
}

function publicEvents(ev) {
    return {
        firstEncounter: ev.firstEncounter, binaryForms: ev.binaryForms,
        gwTakeover: ev.gwTakeover, merger: ev.merger, stalled: ev.stalled,
        stalledAt: ev.stalledAt, tEnd: ev.tEnd,
        remnant: ev.remnant, recoil: ev.recoil,
    };
}

/** Compact history samples for charts: [t, a, e, fgw, h, mej] × N. */
function packSamples(S) {
    const out = new Float64Array(S.length * 6);
    for (let i = 0; i < S.length; i++) {
        const s = S[i];
        out[i * 6] = s.t; out[i * 6 + 1] = s.a; out[i * 6 + 2] = s.e;
        out[i * 6 + 3] = s.fgw; out[i * 6 + 4] = s.h; out[i * 6 + 5] = s.mej;
    }
    return out.buffer;
}
