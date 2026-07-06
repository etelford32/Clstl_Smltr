// simworker.js — module Web Worker hosting the Storm Observatory's physics:
// one shared 20k-object catalog, one StormLane per storm, WASM kernel when
// available. Same protocol shape as the black-hole observatory's worker
// (transferable position/flag buffers ping-ponged; main thread copies out
// on receive — the detached-buffer lesson is baked in there).
//
//   → { type:'init', catalogUrl, catalogMetaUrl, lanes:[{id, bundleUrl, opts,
//       scenario?:{quietUrl, baseUrls:{...}, baseId, dials}}] }
//   ← { type:'ready', engine, lanes:[{id, n, durationHours, tPeakHours,
//       label, placeholder}] }
//   → { type:'frame', seq, ts:[{id, t}], pools }
//   ← { type:'state', seq, lanes:[{…state, pos, flags}] }        (transferred)
//   → { type:'reconfigure', id, opts? , scenario?:{baseId, dials} }
//   ← { type:'reconfigured', id, durationHours, tPeakHours, label }
//   → { type:'inspect', id, index }  ← { type:'inspect', id, index, obj }

import { hydrateBundle } from './bundle.js';
import { StormLane } from './laneengine.js';
import { loadStormWasm } from './wasmswarm.js';
import { STRIDE } from './catalog.js';

const lanes = new Map();
let els = null, meta = null, wasm = null;
let scenarioBank = null;    // { quiet, bases: {id: bundle} } for the scenario lane

async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    return r.json();
}

self.onmessage = async (ev) => {
    const msg = ev.data;

    if (msg.type === 'init') {
        lanes.clear();
        const [bin, metaJson] = await Promise.all([
            fetch(msg.catalogUrl).then(r => r.arrayBuffer()),
            fetchJson(msg.catalogMetaUrl),
        ]);
        meta = metaJson;
        els = new Float32Array(bin, 0, meta.n * STRIDE);
        wasm = await loadStormWasm();
        const out = [];
        for (const l of msg.lanes) {
            let lane;
            if (l.scenario) {
                const quiet = hydrateBundle(await fetchJson(l.scenario.quietUrl));
                const bases = {};
                for (const [id, url] of Object.entries(l.scenario.baseUrls)) {
                    bases[id] = hydrateBundle(await fetchJson(url));
                }
                scenarioBank = { quiet, bases };
                lane = new StormLane(l.id, quiet, els, meta, wasm, l.opts);
                if (l.scenario.baseId !== 'quiet') {
                    lane.setScenario(quiet, bases[l.scenario.baseId], l.scenario.dials ?? {});
                }
            } else {
                const bundle = hydrateBundle(await fetchJson(l.bundleUrl));
                // one shared wasm instance hosts every lane's swarm — each
                // WasmSwarm allocates its own arrays from the bump allocator
                lane = new StormLane(l.id, bundle, els, meta, wasm, l.opts);
            }
            lanes.set(l.id, lane);
            out.push({
                id: l.id, n: lane.swarm.n,
                durationHours: lane.bundle.durationHours,
                tPeakHours: lane.bundle.tPeakHours,
                label: lane.bundle.label,
                placeholder: !!lane.bundle.placeholder,
            });
        }
        self.postMessage({ type: 'ready', engine: wasm ? 'wasm' : 'js', lanes: out });
        return;
    }

    if (msg.type === 'frame') {
        const out = [], transfer = [];
        for (const { id, t } of msg.ts) {
            const lane = lanes.get(id);
            if (!lane) continue;
            lane.setTime(t);
            const n = lane.swarm.n;
            const pool = msg.pools?.[id];
            const pos = pool?.pos && pool.pos.byteLength >= n * 12
                ? new Float32Array(pool.pos, 0, n * 3) : new Float32Array(n * 3);
            const flags = pool?.flags && pool.flags.byteLength >= n
                ? new Uint8Array(pool.flags, 0, n) : new Uint8Array(n);
            lane.swarm.positionsInto(pos);
            flags.set(lane.swarm.flags.subarray(0, n));
            transfer.push(pos.buffer, flags.buffer);
            out.push({ ...lane.state(), n, pos: pos.buffer, flags: flags.buffer });
        }
        self.postMessage({ type: 'state', seq: msg.seq, lanes: out }, transfer);
        return;
    }

    if (msg.type === 'reconfigure') {
        const lane = lanes.get(msg.id);
        if (!lane) return;
        if (msg.scenario && scenarioBank) {
            const base = msg.scenario.baseId === 'quiet'
                ? null : scenarioBank.bases[msg.scenario.baseId];
            if (base) lane.setScenario(scenarioBank.quiet, base, msg.scenario.dials ?? {});
            else {
                lane.bundle = scenarioBank.quiet;
                lane.grid = scenarioBank.quiet.grid;
                const t = lane.tNow; lane.reset(); lane.setTime(t, Infinity);
            }
        }
        if (msg.opts) lane.reconfigure(msg.opts);
        self.postMessage({
            type: 'reconfigured', id: msg.id,
            durationHours: lane.bundle.durationHours,
            tPeakHours: lane.bundle.tPeakHours,
            label: lane.bundle.label,
        });
        return;
    }

    if (msg.type === 'inspect') {
        const lane = lanes.get(msg.id);
        if (lane && msg.index >= 0 && msg.index < lane.swarm.n) {
            self.postMessage({
                type: 'inspect', id: msg.id, index: msg.index,
                obj: lane.swarm.objectState(msg.index, lane.grid, lane.tNow),
            });
        }
    }
};
