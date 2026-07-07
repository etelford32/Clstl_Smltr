// observatory.js — the unified Black Hole Observatory (blackhole-observatory.html).
//
// One canvas, three simulations STACKED in the same world space and tinted by
// system identity; physics off-thread in a module Worker (simworker.js →
// laneengine.js) with transferable star buffers ping-ponged so steady state
// allocates nothing; a small explicit ECS (ecs.js) wiring the systems:
//
//   TimelineSystem  — master τ clock over the merged adaptive axis; lanes
//                     with a coalescence sync on τ = t − t_merge, the stalled
//                     lane (B2 0402+379) runs on A402's absolute clock — the
//                     point being that while the others complete the story,
//                     B2 stays stuck. Reconfigure a lane out of its stall and
//                     the axis rebuilds to include its new merger.
//   PhysicsSystem   — worker proxy (synchronous LaneEngine fallback if the
//                     Worker cannot start), one in-flight frame, ping-ponged
//                     transferables.
//   ChoreoSystem    — merger acts (plunge/ringdown) + GW-burst shells, main-
//                     side because they are wall-clock presentations.
//   TrailSystem / CameraSystem / RenderSystem / HudSystem / AnalyticsSystem /
//   UISystem        — trails, god camera, stacked composite render, chips,
//                     charts + comparison grid, and the opened-up constraint
//                     panel where every slider carries its observational
//                     provenance (measured / inferred / free).

import { World } from './ecs.js';
import { makeScenario, buildHistory, sampleAt } from './physics.js';
import { LaneEngine } from './laneengine.js';
import { orbitalBasis } from './geometry.js';
import { MergerChoreo } from './merger.js';
import { GwAudio } from './gwaudio.js';
import { ptaSensitivity } from './observables.js';
import { Renderer, Trail } from './render.js';
import { GodCamera } from './camera.js';
import { tAt, buildTauAxis, eventsTau, indexOfTau } from './twinsync.js';
import { fmtLen, fmtTime, fmtMass, fmtFreq, rSchw, rGrav, keplerPeriodMyr } from './units.js';
import { RENDER_3D, PERF_HUD } from './flags.js';
import { PerfHudSystem } from './perfhud.js';

const LOOP_SECONDS = 260;

// zOrder places each system along the shared axis in the depth-separated
// layout (?renderer=3d): past → present → forever-stuck reads back-to-front
// as WAS → IS → STUCK. Multiplied by LANE_SEP; classic layout ignores it.
export const LANE_DEFS = {
    a402: {
        name: 'Abell 402-BCG', tag: 'the pair that IS', css: '#a99bff',
        tint: [0.80, 0.75, 1.0], orient: { incl: 0.42, node: -0.5 },
        obsRGamma: 2200, zOrder: 0,
    },
    holm15a: {
        name: 'Holm 15A · Abell 85', tag: 'the pair that WAS', css: '#f0bd55',
        tint: [1.0, 0.86, 0.55], orient: { incl: 0.50, node: 0.7 },
        obsRGamma: 4110, zOrder: -1,
    },
    b20402: {
        name: 'B2 0402+379', tag: 'the pair that is STUCK', css: '#4fd1b8',
        tint: [0.55, 1.0, 0.88], orient: { incl: 0.36, node: 1.6 },
        obsRGamma: NaN, zOrder: 1,
    },
};

// Separation between system centers along the shared axis (pc). Bound stars
// live within ~3 r_infl ≈ 18 kpc of each center; 24 kpc keeps the three
// volumes legible as distinct clusters while their ejecta halos may mingle.
const LANE_SEP = 24000;

// ── constraint catalogue: every dial carries its provenance ─────────────────
const CONSTRAINTS = {
    a402: [
        { key: 'mTot', label: 'M₁+M₂ (10⁹ M☉)', min: 40e9, max: 80e9, step: 2e9, scale: 1e9, tag: 'measured', tip: '60 ± 20 ×10⁹ M☉ — McDonald+ 2026 (binary interpretation)' },
        { key: 'q', label: 'mass ratio q', min: 0.1, max: 1, step: 0.05, tag: 'free', tip: 'unconstrained by the data; both AGN detected → not extreme' },
        { key: 'sigma', label: 'σ (km/s)', min: 250, max: 430, step: 10, tag: 'assumed', tip: 'not yet published for A402-BCG; Holm 15A-like value adopted' },
        { key: 'refill', label: 'loss-cone refill', min: 0.02, max: 1, step: 0.01, tag: 'free', tip: 'triaxiality dial: ≪1 spherical (stalls) → 1 triaxial (Vasiliev+ 2015)' },
        { key: 'eccH', label: 'eccentricity', min: 0, max: 0.9, step: 0.05, tag: 'free', tip: 'unconstrained; OJ 287 shows e ≈ 0.66 is possible' },
    ],
    holm15a: [
        { key: 'massModel', label: 'mass model', type: 'select', options: [['liepold2025', '2.2×10¹⁰ · Liepold+25 (triaxial)'], ['mehrgan2019', '4.0×10¹⁰ · Mehrgan+19 (axisym.)']], tag: 'measured', tip: 'both are direct Schwarzschild measurements; triaxial preferred (verified 3-0)' },
        { key: 'q', label: 'mass ratio q', min: 0.1, max: 1, step: 0.05, tag: 'free', tip: 'progenitor split unconstrained — the remnant is what is measured' },
        { key: 'refill', label: 'loss-cone refill', min: 0.02, max: 1, step: 0.01, tag: 'free', tip: 'must be high enough that the binary merged before today — try breaking it' },
        { key: 'eccH', label: 'eccentricity', min: 0, max: 0.9, step: 0.05, tag: 'free', tip: 'e = 0.9 coalesces ~1000× faster (Peters 1964)' },
    ],
    b20402: [
        { key: 'refill', label: 'loss-cone refill', min: 0.02, max: 1, step: 0.01, tag: 'inferred', tip: 'observed stall for ≳3 Gyr ⇒ depleted, near-spherical loss cone (Surti+ 2024). Raise it and watch B2 un-stick.' },
        { key: 'q', label: 'mass ratio q', min: 0.1, max: 1, step: 0.05, tag: 'free', tip: 'VLBI resolves two cores; mass split uncertain' },
        { key: 'eccH', label: 'eccentricity', min: 0, max: 0.9, step: 0.05, tag: 'free', tip: 'high e is one proposed escape from the stall' },
    ],
};

const PRESETS = [
    { id: 'measured', label: 'reset to measured', tip: 'observationally preferred values', apply: () => ({}) },
    { id: 'stall', label: 'final-parsec stall', tip: 'spherical loss cone: the binary never merges', apply: () => ({ refill: 0.03 }) },
    { id: 'superkick', label: 'superkick escape', tip: 'in-plane spins: remnant ejected along L̂', apply: () => ({ kick: 'superkick', superkickKms: 3000 }) },
    { id: 'oj287', label: 'OJ 287-like eccentric', tip: 'e ≈ 0.65 hard binary — fast, precessing endgame', apply: () => ({ eccH: 0.65 }) },
];

// ═════════════════════════════════════════════════════════════════════════════

export function boot(els) {
    const world = new World();
    const res = world.res;
    res.els = els;
    res.renderer = new Renderer(els.canvas, { hdr: RENDER_3D });
    res.cam = new GodCamera();
    res.renderer.camera = res.cam;
    // depth-separated layout opens on an establishing shot of all three
    // volumes; classic keeps the original core-scale framing
    res.cam.dist = RENDER_3D ? 34000 : 14000;
    res.wall = performance.now();

    // ── lane entities ────────────────────────────────────────────────────────
    for (const id of ['a402', 'holm15a', 'b20402']) {
        const e = world.entity();
        const def = LANE_DEFS[id];
        const sc = makeScenario(id);
        world.add(e, 'lane', {
            id, def, overrides: {},
            sc, history: buildHistory(sc),
            offset: RENDER_3D ? [0, 0, def.zOrder * LANE_SEP] : [0, 0, 0],
            visible: true,
            state: null,                 // latest physics state from the worker
            starPos: null, starFlags: null, n: 0,
            trails: [new Trail(400), new Trail(400)],
            rosette: [],
            shells: [],
            choreo: null,
            basis: orbitalBasis(def.orient.incl, def.orient.node),
            events: [],                  // recent event captions
        });
    }
    const laneOf = (id) => {
        for (const e of world.query('lane')) {
            if (world.get(e, 'lane').id === id) return world.get(e, 'lane');
        }
        return null;
    };
    res.laneOf = laneOf;
    res.lanes = () => world.query('lane').map(e => world.get(e, 'lane'));

    world.system(new TimelineSystem());
    world.system(new PhysicsSystem());
    world.system(new ChoreoSystem());
    world.system(new TrailSystem());
    world.system(new InspectSystem());
    world.system(new CameraSystem());
    world.system(new RenderSystem());
    world.system(new HudSystem());
    world.system(new AnalyticsSystem());
    world.system(new UISystem());
    world.system(new AudioSystem());
    if (PERF_HUD) world.system(new PerfHudSystem());

    let last = performance.now();
    function frame(wall) {
        res.wall = wall;
        const dt = Math.min((wall - last) / 1000, 0.1);
        last = wall;
        world.tick(dt, wall);
        window.__obs = {
            ready: true,
            tau: res.tau,
            workerActive: !!res.workerActive,
            engine: res.engineType ?? null,
            nStars: res.lanes()[0]?.n || res.laneN || 0,
            sel: res.sel
                ? { lane: res.sel.laneId, index: res.sel.index, hasState: !!res.sel.star }
                : null,
            stages: res.lanes().map(l => l.state?.now?.stage ?? '—'),
        };
        requestAnimationFrame(frame);
    }
    requestAnimationFrame((w) => { last = w; requestAnimationFrame(frame); });
    window.__obsWorld = world;          // debug/probe handle
    return world;
}

// ═══ TimelineSystem ══════════════════════════════════════════════════════════
class TimelineSystem {
    init(world) {
        const res = world.res;
        res.playing = true;
        res.speedMult = 1;
        this.rebuildAxis(world);
        // open on A402's present day
        res.idx = 0;
        const a402 = res.laneOf('a402');
        if (a402.history.events.merger !== undefined) {
            res.idx = indexOfTau(res.tauAxis, 0 - a402.history.events.merger);
        }
        res.rebuildTauAxis = () => this.rebuildAxis(world);

        res.els.timeline.addEventListener('input', () => {
            res.idx = parseFloat(res.els.timeline.value) * (res.tauAxis.length - 1);
            res.playing = false; this.syncPlay(res);
            for (const l of res.lanes()) l.trails.forEach(t => t.clear());
        });
        res.els.playBtn.addEventListener('click', () => {
            if (!res.playing && res.idx >= res.tauAxis.length - 1.01) res.idx = 0;
            res.playing = !res.playing; this.syncPlay(res);
        });
        res.els.speed?.addEventListener('change', () => {
            res.speedMult = parseFloat(res.els.speed.value);
        });
        this.syncPlay(res);
    }

    rebuildAxis(world) {
        const res = world.res;
        const merging = res.lanes().filter(l => l.history.events.merger !== undefined);
        res.tauAxis = buildTauAxis(merging.map(l => l.history));
        if (!res.tauAxis.length) res.tauAxis = [0, 1];
        res.laneEventsTau = new Map(
            merging.map(l => [l.id, eventsTau(l.history)]));
        res.idx = Math.min(res.idx ?? 0, res.tauAxis.length - 1);
    }

    syncPlay(res) { res.els.playBtn.textContent = res.playing ? '⏸' : '▶'; }

    update(world, dt) {
        const res = world.res;
        const axis = res.tauAxis;
        if (res.playing) {
            res.idx += (axis.length - 1) / LOOP_SECONDS * res.speedMult * dt;
            if (res.idx >= axis.length - 1) {
                res.idx = axis.length - 1;
                res.playing = false; this.syncPlay(res);
            }
            res.els.timeline.value = String(res.idx / (axis.length - 1));
        }
        const i0 = Math.floor(res.idx), f = res.idx - i0;
        const i1 = Math.min(i0 + 1, axis.length - 1);
        res.tau = axis[i0] + (axis[i1] - axis[i0]) * f;

        // per-lane absolute epochs: τ-sync for merging lanes; the stalled lane
        // runs on the A402 absolute clock (same universe, same "today")
        const refMerger = res.laneOf('a402').history.events.merger ?? 0;
        res.laneT = new Map();
        for (const l of res.lanes()) {
            if (l.history.events.merger !== undefined) {
                res.laneT.set(l.id, tAt(l.history, res.tau));
            } else {
                const S = l.history.samples;
                const t = Math.min(Math.max(res.tau + refMerger, S[0].t), S[S.length - 1].t);
                res.laneT.set(l.id, t);
            }
        }
    }
}

// ═══ PhysicsSystem — worker proxy with synchronous fallback ═════════════════
class PhysicsSystem {
    init(world) {
        const res = world.res;
        this.pending = false;
        this.pools = {};
        this.tick = 0;
        res.nStars = null;      // null → engine default (WASM 32768 / JS 3072)
        res.reconfigureLane = (id, overrides) => this.reconfigure(world, id, overrides);
        res.setStarCount = (n) => this.setStarCount(world, n);
        res.requestInspect = (id, index, mBh) => this.requestInspect(world, id, index, mBh);
        this.startWorker(world);
    }

    startWorker(world) {
        try {
            this.worker = new Worker(new URL('./simworker.js', import.meta.url), { type: 'module' });
            this.worker.onerror = () => this.fallback(world);
            this.worker.onmessage = (ev) => this.onmsg(world, ev.data);
            this.postInit(world);
        } catch {
            this.fallback(world);
        }
    }

    /** (Re)build every worker-side engine at the current star count. */
    postInit(world) {
        const res = world.res;
        res.physicsReady = false;
        this.pending = false;
        this.pools = {};
        this.worker.postMessage({
            type: 'init',
            lanes: res.lanes().map(l => ({
                id: l.id,
                opts: {
                    overrides: l.overrides, seed: 85,
                    ...(res.nStars ? { nStars: res.nStars } : {}),
                    incl: l.def.orient.incl, node: l.def.orient.node,
                },
            })),
        });
    }

    fallback(world) {
        if (this.local) return;
        this.worker?.terminate?.();
        this.worker = null;
        this.buildLocal(world);
        world.res.workerActive = false;
        world.res.engineType = 'js';
        world.res.physicsReady = true;
    }

    buildLocal(world) {
        const res = world.res;
        this.local = new Map();
        for (const l of res.lanes()) {
            this.local.set(l.id, new LaneEngine(l.id, {
                overrides: l.overrides, nStars: res.nStars ?? 2048, seed: 85,
                incl: l.def.orient.incl, node: l.def.orient.node,
            }));
        }
    }

    /** Star-count changes tear the worker down and start fresh: the WASM
     *  kernel's bump allocator never frees, so a new worker (new linear
     *  memory) is the leak-free path for a different allocation size. */
    setStarCount(world, n) {
        const res = world.res;
        res.nStars = n;
        res.clearSel?.();
        for (const l of res.lanes()) { l.trails.forEach(t => t.clear()); l.rosette = []; }
        if (this.worker) {
            this.worker.terminate();
            this.startWorker(world);
        } else if (this.local) {
            this.buildLocal(world);
        }
    }

    requestInspect(world, id, index, mBh) {
        const sel = world.res.sel;
        if (this.worker) {
            if (this._inspectPending || !world.res.physicsReady) return;
            this._inspectPending = true;
            this.worker.postMessage({ type: 'inspect', id, index, mBh });
        } else if (this.local) {
            const eng = this.local.get(id);
            if (eng && sel && index < eng.cluster.n) {
                sel.star = eng.cluster.starState(index, mBh);
            }
        }
    }

    onmsg(world, msg) {
        const res = world.res;
        if (msg.type === 'ready') {
            res.workerActive = true;
            res.physicsReady = true;
            res.engineType = msg.engine ?? 'js';
            res.laneN = msg.lanes?.[0]?.n ?? 0;
            return;
        }
        if (msg.type === 'inspect') {
            this._inspectPending = false;
            const sel = res.sel;
            if (sel && sel.laneId === msg.id && sel.index === msg.index) sel.star = msg.star;
            return;
        }
        if (msg.type === 'state') {
            this.pending = false;
            for (const st of msg.lanes) {
                const l = res.laneOf(st.id);
                if (!l) continue;
                l.state = st;
                l.n = st.n;
                // COPY into lane-owned arrays rather than viewing the
                // transferable: the transferred buffer detaches the moment it
                // is ping-ponged back, and at high star counts the worker
                // holds it for several main-thread frames — render/pick/trail
                // reads on a detached view are silently NaN/empty.
                if (!l.starPos || l.starPos.length !== st.n * 3) {
                    l.starPos = new Float32Array(st.n * 3);
                    l.starFlags = new Uint8Array(st.n);
                    l.starVel = new Float32Array(st.n * 3);
                }
                l.starPos.set(new Float32Array(st.pos, 0, st.n * 3));
                l.starFlags.set(new Uint8Array(st.flags, 0, st.n));
                if (st.vel) l.starVel.set(new Float32Array(st.vel, 0, st.n * 3));
                l.rosette = (st.rosette ?? []).map(r => ({
                    buf: Float32Array.from(r.pts), count: r.count,
                }));
                // hand buffers back next frame (ping-pong)
                this.pools[st.id] = { pos: st.pos, flags: st.flags, vel: st.vel };
            }
            return;
        }
        if (msg.type === 'reconfigured') {
            // keep main-side history in sync is done in reconfigure(); nothing here
        }
    }

    reconfigure(world, id, overrides) {
        const res = world.res;
        const l = res.laneOf(id);
        l.overrides = { ...l.overrides, ...overrides };
        l.sc = makeScenario(id, l.overrides);
        l.history = buildHistory(l.sc);
        l.choreo = null; l.shells = []; l.rosette = [];
        l.trails.forEach(t => t.clear());
        if (res.sel?.laneId === id) res.clearSel?.();   // star identities resample
        res.rebuildTauAxis();
        if (this.worker) {
            this.worker.postMessage({ type: 'reconfigure', id, overrides: l.overrides });
            delete this.pools[id];      // engine may have a new star count
        } else if (this.local) {
            this.local.get(id).reconfigure(l.overrides);
        }
    }

    update(world) {
        const res = world.res;
        if (!res.physicsReady || !res.laneT) return;
        this.tick++;
        const ts = res.lanes().filter(l => l.visible)
            .map(l => ({ id: l.id, t: res.laneT.get(l.id) }));
        if (!ts.length) return;

        if (this.worker) {
            if (this.pending) return;          // one frame in flight
            this.pending = true;
            const pools = this.pools; this.pools = {};
            const transfer = [];
            for (const k of Object.keys(pools)) {
                transfer.push(pools[k].pos, pools[k].flags);
                if (pools[k].vel) transfer.push(pools[k].vel);
            }
            this.worker.postMessage(
                { type: 'frame', seq: this.tick, ts, tick: this.tick, pools }, transfer);
        } else {
            for (const { id, t } of ts) {
                const eng = this.local.get(id);
                const st = eng.setTime(t, this.tick);
                const l = res.laneOf(id);
                l.state = st;
                l.n = eng.cluster.n;
                l.starPos = eng.cluster.pos;
                l.starFlags = eng.cluster.flags;
                l.starVel = eng.cluster.vel;
                l.rosette = eng.rosette;
            }
        }
    }
}

// ═══ ChoreoSystem — merger acts + burst shells (wall-clock, main-side) ═══════
class ChoreoSystem {
    update(world, dt, wall) {
        for (const l of world.res.lanes()) {
            const st = l.state;
            if (!st) continue;
            if (st.merged && world.res.playing) {
                l.choreo = l.choreo ?? new MergerChoreo(l.sc, l.history);
                l.choreo.trigger(wall);
                l.shells.push({ born: wall });
                l.flashUntil = wall + 2200;      // core beacon flares through ringdown
                l.events.unshift({ label: 'coalescence — ' + (l.choreo.bookkeeping()), wall });
                l.events.length = Math.min(l.events.length, 3);
            }
            for (let i = l.shells.length - 1; i >= 0; i--) {
                if (wall - l.shells[i].born > 2800) l.shells.splice(i, 1);
            }
            // choreography overrides the rendered bodies while active
            l.renderBhs = st.bhs;
            if (l.choreo) {
                const cs = l.choreo.state(wall, l.basis, st.phase);
                if (cs) l.renderBhs = cs.bhs;
            }
        }
    }
}

// ═══ TrailSystem ═════════════════════════════════════════════════════════════
// Trails are drawn ONLY when the orbit is temporally resolved: if the
// simulation time advanced per frame exceeds ~1/6 of the orbital period,
// consecutive samples land at effectively unrelated phases and the
// polyline aliases into a spirograph web (the "speed looks wrong" bug).
// Unresolved regimes clear the trail instead — the binary dots still show
// the (deterministic) sampled configuration.
class TrailSystem {
    update(world) {
        const res = world.res;
        if (!res.playing) return;
        this._t = this._t ?? new Map();
        for (const l of res.lanes()) {
            if (!l.visible || !l.renderBhs?.length) continue;
            const t = res.laneT.get(l.id);
            const dt = t - (this._t.get(l.id) ?? t);
            this._t.set(l.id, t);
            const a = l.state?.now?.a;
            if (a > 0 && dt > keplerPeriodMyr(a, l.sc.mTot) / 6) {
                if (l.trails[0].count) l.trails.forEach(tr => tr.clear());
                continue;
            }
            l.trails[0].push(...l.renderBhs[0].p);
            if (l.renderBhs[1]) l.trails[1].push(...l.renderBhs[1].p);
        }
    }
}

// ═══ InspectSystem — tap a star, get its live physics from the engine ════════
// Tap detection rides alongside CameraSystem's pointer handling (a clean tap
// never trips the >5 px drag threshold). The marker and trail are read straight
// off the transferred position buffers every frame; the derived quantities
// (r, |v|, L/L_lc, specific energy) come from the worker's engine at ~4 Hz via
// the 'inspect' round-trip — the fallback engine answers synchronously.
class InspectSystem {
    init(world) {
        const res = world.res;
        res.sel = null;
        this.trail = new Trail(240);
        res.clearSel = () => { res.sel = null; this.trail.clear(); this.render(res); };
        const canvas = res.els.canvas;
        let tap = null;
        canvas.addEventListener('pointerdown', (e) => {
            tap = e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
        });
        canvas.addEventListener('pointermove', (e) => {
            if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 5) tap = null;
        });
        canvas.addEventListener('pointerup', (e) => {
            if (tap && e.isPrimary && performance.now() - tap.t < 500) this.pick(world, e);
            tap = null;
        });
        canvas.addEventListener('pointercancel', () => { tap = null; });
    }

    /** Nearest pickable star within ~16 px of the tap, across visible lanes. */
    pick(world, e) {
        const res = world.res;
        const rect = res.els.canvas.getBoundingClientRect();
        const dpr = (res.renderer._fboSize?.[0] || 1) / Math.max(rect.width, 1);
        const px = (e.clientX - rect.left) * dpr, py = (e.clientY - rect.top) * dpr;
        let best = null, bestD = 16 * dpr;
        for (const l of res.lanes()) {
            if (!l.visible || !l.starPos) continue;
            const off = l.offset ?? [0, 0, 0];
            for (let i = 0; i < l.n; i++) {
                const f = l.starFlags[i];
                if (f === 1 || f === 2) continue;    // ejected/frozen: not studyable
                const j = i * 3;
                const s = res.renderer.worldToScreen(
                    [l.starPos[j] + off[0], l.starPos[j + 1] + off[1], l.starPos[j + 2] + off[2]]);
                if (!s) continue;
                const d = Math.hypot(s[0] - px, s[1] - py);
                if (d < bestD) { bestD = d; best = { laneId: l.id, index: i }; }
            }
        }
        this.trail.clear();
        res.sel = best ? { ...best, star: null, marker: null, trailBuf: null } : null;
        this._lastReq = 0;
        this.render(res);
    }

    update(world, dt, wall) {
        const res = world.res;
        const sel = res.sel;
        if (!sel) return;
        const l = res.laneOf(sel.laneId);
        if (!l?.starPos || sel.index >= l.n || !l.visible) { res.clearSel(); return; }
        const j = sel.index * 3;
        sel.marker = [l.starPos[j], l.starPos[j + 1], l.starPos[j + 2]];
        if (res.playing) this.trail.push(sel.marker[0], sel.marker[1], sel.marker[2]);
        sel.trailBuf = this.trail.count > 1
            ? { buf: this.trail.ordered(), count: this.trail.count } : null;
        if (wall - (this._lastReq ?? 0) > 250) {
            this._lastReq = wall;
            const n = l.state?.now;
            const mBh = n && n.a > 0 ? l.sc.mTot : (l.history.events.remnant?.mass ?? 0);
            res.requestInspect(sel.laneId, sel.index, mBh);
            this.render(res);
        }
    }

    render(res) {
        const el = res.els.inspector; if (!el) return;
        const sel = res.sel;
        if (!sel) { el.hidden = true; el.innerHTML = ''; this._key = null; return; }
        const l = res.laneOf(sel.laneId);
        // head + close button are built once per selection (a stable DOM node,
        // not rewritten on the refresh tick); only the value rows update
        const key = sel.laneId + '#' + sel.index;
        if (this._key !== key) {
            this._key = key;
            el.innerHTML =
                `<div class="head" style="color:${l.def.css}">★ star #${sel.index} · ${l.def.name}` +
                `<button type="button" aria-label="close inspector">✕</button></div>` +
                `<div class="rows"></div>`;
            el.querySelector('button').addEventListener('click', () => res.clearSel());
        }
        const st = sel.star;
        const rows = [
            ['status', st ? (['bound', 'EJECTED', 'escaped (frozen)', 'LOSS CONE'][st.flag] ?? '?') : '…'],
            ['r · |v|', st ? `${fmtLen(st.r)} · ${st.v.toFixed(0)} km/s` : '—'],
            ['L / L_lc', st && Number.isFinite(st.lRatio) ? st.lRatio.toFixed(2) : '—'],
            ['E specific', st ? `${st.eSpec > 0 ? '+' : ''}${st.eSpec.toExponential(2)} (km/s)²` : '—'],
        ];
        el.querySelector('.rows').innerHTML =
            rows.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('');
        el.hidden = false;
    }
}

// ═══ CameraSystem ════════════════════════════════════════════════════════════
class CameraSystem {
    init(world) {
        const res = world.res;
        const cam = res.cam;
        this.userUntil = 0;
        res.follow = false;
        const canvas = res.els.canvas;
        const pointers = new Map();
        canvas.addEventListener('pointerdown', (e) => {
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            canvas.setPointerCapture(e.pointerId);
            if (pointers.size === 1) cam.onDragStart();
        });
        canvas.addEventListener('pointermove', (e) => {
            const prev = pointers.get(e.pointerId);
            if (!prev) return;
            if (pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                const dOld = Math.hypot(a.x - b.x, a.y - b.y);
                pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
                const [a2, b2] = [...pointers.values()];
                cam.onWheel((dOld - Math.hypot(a2.x - b2.x, a2.y - b2.y)) * 4);
            } else {
                cam.onDrag(e.clientX - prev.x, e.clientY - prev.y);
                pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            }
            this.userUntil = performance.now() / 1000 + 14;
        });
        const clear = (e) => {
            pointers.delete(e.pointerId);
            if (pointers.size === 0) cam.onDragEnd();
        };
        canvas.addEventListener('pointerup', clear);
        canvas.addEventListener('pointercancel', clear);
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            cam.onWheel(e.deltaY);
            res.follow = false; res.els.follow && (res.els.follow.checked = false);
            this.userUntil = performance.now() / 1000 + 14;
        }, { passive: false });

        const userSteer = () => { this.userUntil = performance.now() / 1000 + 20; };
        res.els.follow?.addEventListener('change', () => { res.follow = res.els.follow.checked; userSteer(); });
        res.els.viewCore?.addEventListener('click', () => { res.follow = false; cam.transitionTo(14000); userSteer(); });
        res.els.viewInfl?.addEventListener('click', () => { res.follow = false; cam.transitionTo(2600); userSteer(); });
        cam.distClamp = [1e-3, 6e4];

        // idle cinematography (3D layout only): when nobody is steering,
        // ride the focused system's inspiral down to its coalescence and
        // pull back out afterwards. Any interaction suspends it (userUntil).
        res.cinema = RENDER_3D && (res.els.cinema?.checked ?? true);
        res.els.cinema?.addEventListener('change', () => { res.cinema = res.els.cinema.checked; });
        if (!RENDER_3D && res.els.cinema) {
            res.els.cinema.parentElement.style.display = 'none';
        }

        // focus mode: smooth dolly to one system's current scale — its binary
        // separation while a pair exists, its horizon scale once merged. In
        // the depth-separated layout this is the fly-between: the orbit rig's
        // target eases to that system's volume center.
        res.focusedLane = 'a402';
        res.focusLane = (id) => {
            const l = res.laneOf(id);
            if (!l) return;
            res.focusedLane = id;
            const a = l.state?.now?.a;
            const dist = a > 0
                ? Math.min(Math.max(a * 7, 0.02), 30000)
                : Math.min(Math.max(
                    rSchw(l.history.events.remnant?.mass ?? l.sc.mTot) * 30, 0.02), 30000);
            res.follow = false;
            res.els.follow && (res.els.follow.checked = false);
            cam.transitionTo(dist, RENDER_3D ? l.offset : null);
            this.userUntil = performance.now() / 1000 + 20;
        };
    }

    update(world, dt, wall) {
        const res = world.res;
        const cam = res.cam;
        if (wall / 1000 > this.userUntil) cam.yaw += 0.02 * dt;

        // idle cinema: approach → ride the shrinking separation into the
        // near-field finale → hold through ringdown → ease back out. The
        // whole story is sub-pixel from the establishing shot, so an
        // unattended page would otherwise show three static fuzzballs.
        if (res.cinema && res.playing && !res.follow && cam.mode === 'orbit'
            && res.laneT && wall / 1000 > this.userUntil) {
            const CIN_IN = 400;      // Myr before coalescence: begin the ride
            const CIN_OUT = 60;      // Myr after: pull back to the wide shot
            let lane = res.laneOf(res.focusedLane ?? 'a402');
            if (lane?.history.events.merger === undefined) {
                let best = Infinity;    // focused lane never merges: next story
                for (const l of res.lanes()) {
                    const m = l.history.events.merger;
                    if (m === undefined || !l.visible) continue;
                    const d = m - res.laneT.get(l.id);
                    if (d > 0 && d < best) { best = d; lane = l; }
                }
            }
            const merger = lane?.history.events.merger;
            if (merger !== undefined) {
                const dtM = merger - res.laneT.get(lane.id);
                const a = lane.state?.now?.a;
                if (dtM > 0 && dtM < CIN_IN && a > 0) {
                    cam.goalTarget = [...lane.offset];
                    cam.goalDist = Math.min(Math.max(a * 9, 0.05), 34000);
                    this._cinActive = true;
                } else if (this._cinActive && dtM <= -CIN_OUT) {
                    cam.goalTarget = [0, 0, 0];
                    cam.goalDist = 34000;
                    this._cinActive = false;
                }
                // between 0 and −CIN_OUT: hold on the remnant (flare + shells)
            }
        }

        if (res.follow) {
            // separated layout: chase the focused system only (following the
            // global-min separation would yank the rig between volumes)
            const followed = RENDER_3D
                ? [res.laneOf(res.focusedLane)].filter(Boolean) : res.lanes();
            let aMin = Infinity;
            for (const l of followed) {
                if (l.visible && l.state?.now?.a > 0) aMin = Math.min(aMin, l.state.now.a);
            }
            if (Number.isFinite(aMin)) {
                cam.goalDist = Math.min(Math.max(aMin * 7, 0.02), 30000);
            }
        }
        // distance-adaptive speed reference for fly-mode parity
        let dNear = cam.dist;
        const eye = cam.eye();
        for (const l of res.lanes()) {
            const off = l.offset ?? [0, 0, 0];
            for (const b of (l.renderBhs ?? [])) {
                dNear = Math.min(dNear, Math.hypot(
                    b.p[0] + off[0] - eye[0],
                    b.p[1] + off[1] - eye[1],
                    b.p[2] + off[2] - eye[2]));
            }
        }
        cam.update(dt, dNear);
    }
}

// ═══ RenderSystem — the composite (stacked, or depth-separated in 3d) ════════
class RenderSystem {
    init(world) {
        const res = world.res;
        if (!RENDER_3D) return;
        // the shared-τ axis as a physical ruler through the three volumes:
        // one faint spine + an identity-tinted tick cross at each system
        const S = LANE_SEP, T = S * 0.035;
        const line = (pts, color) => ({ buf: Float32Array.from(pts), count: pts.length / 3, color });
        res.ruler = [
            line([0, 0, -1.3 * S, 0, 0, 1.3 * S], [0.55, 0.6, 0.95, 0.10]),
        ];
        for (const l of res.lanes()) {
            const [t0, t1, t2] = l.def.tint;
            const z = l.offset[2];
            res.ruler.push(
                line([-T, 0, z, T, 0, z], [t0, t1, t2, 0.30]),
                line([0, -T, z, 0, T, z], [t0, t1, t2, 0.30]));
        }
    }

    update(world, dt, wall) {
        const res = world.res;
        const lanes = [];
        for (const l of res.lanes()) {
            if (!l.visible || !l.state) continue;
            const extraLines = l.rosette.map((r, i) => ({
                buf: r.buf, count: r.count,
                color: [l.def.tint[0], l.def.tint[1], l.def.tint[2], 0.05 + 0.06 * (i + 1)],
            }));
            if (res.sel?.laneId === l.id && res.sel.trailBuf) {
                extraLines.push({
                    buf: res.sel.trailBuf.buf, count: res.sel.trailBuf.count,
                    color: [0.45, 1.0, 0.9, 0.55],
                });
            }
            lanes.push({
                pos: l.starPos, flags: l.starFlags, vel: l.starVel, n: l.n,
                offset: l.offset,
                bhs: l.renderBhs ?? l.state.bhs,
                coreFlash: l.flashUntil > wall,
                trails: l.trails,
                tint: l.def.tint,
                extraLines,
                shells: l.shells.map(sh => {
                    const age = (wall - sh.born) / 2800;
                    return {
                        center: [0, 0, 0],
                        radius: Math.pow(age, 0.6) * res.cam.dist * 1.6,
                        alpha: 0.55 * (1 - age),
                    };
                }),
            });
        }
        const d = res.cam.dist;
        const rings = [];
        for (const R of [0.1, 1, 10, 100, 1000, 10000]) {
            if (R > d * 0.02 && R < d * 2.5) rings.push(R);
        }
        // the selection marker is lane-local; lift it to world space
        let marker = res.sel?.marker ?? null;
        if (marker && RENDER_3D) {
            const off = res.laneOf(res.sel.laneId)?.offset ?? [0, 0, 0];
            marker = [marker[0] + off[0], marker[1] + off[1], marker[2] + off[2]];
        }
        res.renderer.renderComposite({
            lanes, rings, lensOn: true, marker,
            ringCenter: res.cam.target,
            worldLines: res.ruler,
        });
    }
}

// ═══ HudSystem — chips, τ label, scale bar, event captions ═══════════════════
class HudSystem {
    update(world, dt, wall) {
        const res = world.res;
        if (res.els.tauLabel) {
            res.els.tauLabel.textContent =
                `τ ${res.tau >= 0 ? '+' : '−'}${fmtTime(Math.abs(res.tau))} ` +
                (res.tau >= 0 ? 'after coalescence' : 'to coalescence');
        }
        // per-lane chips
        let html = '';
        for (const l of res.lanes()) {
            const st = l.state;
            if (!st) continue;
            const n = st.now;
            const dot = `<i style="background:${l.def.css}"></i>`;
            const body = l.visible
                ? `${n.t >= 0 ? '+' : '−'}${fmtTime(Math.abs(n.t))}${n.t < 0 ? ' ago' : ''} · ${n.stage} · ` +
                  (n.a > 0 ? 'a ' + fmtLen(n.a) : fmtMass(l.history.events.remnant?.mass ?? l.sc.mTot))
                : 'hidden';
            html += `<div class="obs-chip" style="border-color:${l.def.css}">${dot}<b>${l.def.name}</b> · ${body}</div>`;
        }
        if (res.els.chips && html !== this._last) { res.els.chips.innerHTML = html; this._last = html; }
        // scale bar
        if (res.els.scaleBar && res.els.scaleLabel) {
            const wpp = 2 * res.cam.dist * Math.tan(res.cam.fov / 2) /
                Math.max(res.els.canvas.clientHeight, 1);
            const raw = wpp * 140;
            const pow = Math.pow(10, Math.floor(Math.log10(raw)));
            const mant = raw / pow;
            const nice = (mant >= 5 ? 5 : mant >= 2 ? 2 : 1) * pow;
            res.els.scaleBar.style.width = Math.max(nice / wpp, 8) + 'px';
            res.els.scaleLabel.textContent = fmtLen(nice);
        }
        // engine chip: which physics backend, where, at what scale
        if (res.els.engineChip) {
            const eng = !res.physicsReady ? 'starting…'
                : res.workerActive
                    ? (res.engineType === 'wasm' ? 'Rust→WASM · worker thread' : 'JS · worker thread')
                    : 'JS · main thread fallback';
            const n = res.lanes()[0]?.n || res.laneN || 0;
            const txt = n ? `${eng} · ${n.toLocaleString('en-US')} ★ / lane` : eng;
            if (txt !== this._engine) { res.els.engineChip.textContent = txt; this._engine = txt; }
        }
        // event caption (latest, fading)
        if (res.els.eventCap) {
            let cap = '', color = '';
            for (const l of res.lanes()) {
                const ev = l.events[0];
                if (ev && wall - ev.wall < 4200) { cap = ev.label; color = l.def.css; break; }
            }
            res.els.eventCap.textContent = cap;
            res.els.eventCap.style.color = color || 'inherit';
            res.els.eventCap.style.opacity = cap ? '1' : '0';
        }
    }
}

// ═══ AnalyticsSystem — a(τ) overlay, GW tracks, comparison grid ══════════════
class AnalyticsSystem {
    init(world) {
        this.rebuildCurves(world);
        world.res.rebuildCurves = () => this.rebuildCurves(world);
        const res = world.res;
        res.els.chartTau?.addEventListener('click', (e) => {
            const r = res.els.chartTau.getBoundingClientRect();
            res.idx = Math.min(Math.max((e.clientX - r.left - 4) / (r.width - 8), 0), 1) *
                (res.tauAxis.length - 1);
            res.playing = false;
            res.els.playBtn.textContent = '▶';
        });
    }

    rebuildCurves(world) {
        const res = world.res;
        this.curves = new Map();
        for (const l of res.lanes()) {
            const m = l.history.events.merger;
            if (m === undefined) {
                // stalled lane: place on the axis via the A402 absolute clock
                const ref = res.laneOf('a402').history.events.merger ?? 0;
                this.curves.set(l.id, l.history.samples
                    .filter(s => s.a > 0)
                    .map(s => ({ tau: s.t - ref, a: s.a })));
            } else {
                this.curves.set(l.id, l.history.samples
                    .filter(s => s.a > 0)
                    .map(s => ({ tau: s.t - m, a: s.a })));
            }
        }
    }

    chart(cv) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = cv.clientWidth, h = cv.clientHeight;
        if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
        const ctx = cv.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(10,10,20,0.35)'; ctx.fillRect(0, 0, w, h);
        ctx.font = '10px "Courier New",monospace';
        return { ctx, w, h };
    }

    update(world, dt, wall) {
        const res = world.res;
        if (wall - (this._lastDraw ?? 0) < 120) return;   // charts at ~8 Hz
        this._lastDraw = wall;
        this.drawTau(res);
        this.drawGw(res);
        this.drawGrid(res);
    }

    drawTau(res) {
        const cv = res.els.chartTau; if (!cv) return;
        const { ctx, w, h } = this.chart(cv);
        ctx.fillStyle = '#9fb4d8';
        ctx.fillText('separation a(τ) — all systems · click to scrub', 6, 12);
        const axis = res.tauAxis;
        const X = (tau) => 4 + (w - 8) * indexOfTau(axis, tau) / (axis.length - 1);
        let aMin = Infinity, aMax = 0;
        for (const [, c] of this.curves) for (const p of c) {
            aMin = Math.min(aMin, p.a); aMax = Math.max(aMax, p.a);
        }
        const lg0 = Math.log10(Math.max(aMin, 1e-4)), lg1 = Math.log10(aMax);
        const Y = (a) => 16 + (h - 34) * (1 - (Math.log10(Math.max(a, 1e-4)) - lg0) / (lg1 - lg0));
        for (const l of res.lanes()) {
            const c = this.curves.get(l.id);
            if (!c?.length) continue;
            ctx.strokeStyle = l.def.css;
            ctx.globalAlpha = l.visible ? 1 : 0.25;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            let started = false;
            for (const p of c) {
                const px = X(p.tau), py = Y(p.a);
                if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
            }
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
        ctx.lineWidth = 1;
        const x0 = X(0);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath(); ctx.moveTo(x0, 14); ctx.lineTo(x0, h - 14); ctx.stroke();
        ctx.fillStyle = '#bbc';
        ctx.fillText('coalescence', Math.min(x0 + 4, w - 74), 24);
        // per-lane "today" diamonds + event ticks
        for (const l of res.lanes()) {
            const evs = res.laneEventsTau.get(l.id);
            if (!evs) continue;
            const yT = l.id === 'a402' ? 16 : l.id === 'holm15a' ? h - 16 : h / 2;
            for (const ev of evs) {
                const px = X(ev.tau);
                ctx.strokeStyle = l.def.css;
                ctx.beginPath(); ctx.moveTo(px, yT - 4); ctx.lineTo(px, yT + 4); ctx.stroke();
                if (ev.today) {
                    ctx.fillStyle = l.def.css;
                    ctx.beginPath();
                    ctx.moveTo(px, yT - 6); ctx.lineTo(px + 4, yT); ctx.lineTo(px, yT + 6);
                    ctx.lineTo(px - 4, yT); ctx.closePath(); ctx.fill();
                }
            }
        }
        // playhead
        const xp = 4 + (w - 8) * res.idx / (axis.length - 1);
        ctx.strokeStyle = '#fff'; ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.moveTo(xp, 14); ctx.lineTo(xp, h - 14); ctx.stroke();
        ctx.globalAlpha = 1;
    }

    drawGw(res) {
        const cv = res.els.chartGw; if (!cv) return;
        const { ctx, w, h } = this.chart(cv);
        ctx.fillStyle = '#9fb4d8';
        ctx.fillText('GW tracks · PTA band', 6, 12);
        const fx = (f) => 4 + (w - 8) * (Math.log10(Math.max(f, 1e-13)) + 12) / 6;
        const hy = (hh) => 14 + (h - 24) * (1 - (Math.log10(Math.max(hh, 1e-19)) + 18) / 7);
        ctx.fillStyle = 'rgba(80,140,220,0.10)';
        ctx.fillRect(fx(1e-9), 14, fx(1e-7) - fx(1e-9), h - 24);
        ctx.strokeStyle = 'rgba(216,178,90,0.5)'; ctx.setLineDash([4, 3]);
        ctx.beginPath();
        let st = false;
        for (let i = 0; i <= 50; i++) {
            const f = Math.pow(10, -12 + (i / 50) * 6);
            const Yv = hy(ptaSensitivity(f));
            if (Yv < 14 || Yv > h - 6) { st = false; continue; }
            if (!st) { ctx.moveTo(fx(f), Yv); st = true; } else ctx.lineTo(fx(f), Yv);
        }
        ctx.stroke(); ctx.setLineDash([]);
        for (const l of res.lanes()) {
            ctx.strokeStyle = l.def.css;
            ctx.globalAlpha = l.visible ? 1 : 0.25;
            ctx.beginPath();
            let started = false;
            for (const s of l.history.samples) {
                if (!(s.fgw > 0 && s.h > 0)) continue;
                const Xv = fx(s.fgw), Yv = hy(s.h);
                if (!started) { ctx.moveTo(Xv, Yv); started = true; } else ctx.lineTo(Xv, Yv);
            }
            ctx.stroke();
            ctx.globalAlpha = 1;
            const n = l.state?.now;
            if (n && n.fgw > 0) {
                ctx.fillStyle = l.def.css;
                ctx.beginPath(); ctx.arc(fx(n.fgw), hy(n.h), 3.5, 0, 7); ctx.fill();
            }
        }
    }

    drawGrid(res) {
        const el = res.els.grid; if (!el) return;
        const lanes = res.lanes();
        const head = lanes.map(l =>
            `<b style="color:${l.def.css}">${l.def.name.split(' ')[0]}</b>`).join('');
        const row = (k, vals) =>
            `<div class="obs-gr"><span>${k}</span>${vals.map(v => `<b>${v}</b>`).join('')}</div>`;
        const get = (fn) => lanes.map(l => l.state ? fn(l) : '—');
        let html = `<div class="obs-gr obs-gr-head"><span></span>${head}</div>`;
        html += row('epoch', get(l => {
            const t = l.state.now.t;
            return (t >= 0 ? '+' : '−') + fmtTime(Math.abs(t)) + (t < 0 ? ' ago' : '');
        }));
        html += row('stage', get(l => l.state.now.stage));
        html += row('separation', get(l => l.state.now.a > 0 ? fmtLen(l.state.now.a) : 'merged'));
        html += row('f_GW', get(l => l.state.now.fgw > 0 ? fmtFreq(l.state.now.fgw) : '—'));
        html += row('strain h', get(l => l.state.now.h > 0 ? l.state.now.h.toExponential(1) : '—'));
        html += row('M_ej/M_bin', get(l => (l.state.now.mej / l.sc.mTot).toFixed(2)));
        html += row('loss cone ★', get(l => String(l.state.lc?.nCone ?? 0)));
        html += row('r_γ mock (obs)', get(l => {
            const rg = l.state.rGamma;
            const obs = l.def.obsRGamma;
            return (Number.isFinite(rg) ? fmtLen(rg) : '—') +
                (Number.isFinite(obs) ? ` (${fmtLen(obs)})` : '');
        }));
        html += row('PTA-resolvable', get(l => {
            const n = l.state.now;
            if (!(n.fgw > 0 && n.h > 0)) return '—';
            const s = ptaSensitivity(n.fgw);
            return n.h > s ? `YES ${(n.h / s).toFixed(1)}×` : `${(n.h / s).toFixed(2)}×`;
        }));
        if (html !== this._lastGrid) { el.innerHTML = html; this._lastGrid = html; }
    }
}

// ═══ UISystem — lane toggles + the opened-up constraint panel ════════════════
class UISystem {
    init(world) {
        const res = world.res;
        this.selected = 'a402';
        res.audioLane = this.selected;
        this.renderLaneToggles(world);
        this.renderConstraints(world);

        res.els.methodsBtn?.addEventListener('click', () =>
            res.els.methods?.classList.add('open'));
        res.els.methodsClose?.addEventListener('click', () =>
            res.els.methods?.classList.remove('open'));

        // stars-per-lane dial (engine rebuild; 'auto' → WASM 32768 / JS 3072)
        res.els.nStars?.addEventListener('change', () => {
            const v = res.els.nStars.value;
            res.setStarCount(v === 'auto' ? null : parseInt(v, 10));
        });

        // mobile drawer for the rail
        res.els.railToggle?.addEventListener('click', () =>
            res.els.rail?.classList.toggle('open'));
        res.els.railClose?.addEventListener('click', () =>
            res.els.rail?.classList.remove('open'));
    }

    renderLaneToggles(world) {
        const res = world.res;
        const box = res.els.laneToggles; if (!box) return;
        box.innerHTML = '';
        for (const l of res.lanes()) {
            const div = document.createElement('label');
            div.className = 'obs-lane';
            div.style.borderColor = l.def.css;
            div.innerHTML = `<input type="checkbox" ${l.visible ? 'checked' : ''}>` +
                `<i style="background:${l.def.css}"></i>` +
                `<span><b>${l.def.name}</b><br>${l.def.tag}</span>` +
                `<button type="button" class="foc" title="dolly the camera to this system's scale">focus</button>` +
                `<button type="button" class="sel">constraints</button>`;
            div.querySelector('input').addEventListener('change', (e) => {
                l.visible = e.target.checked;
            });
            div.querySelector('.foc').addEventListener('click', (e) => {
                e.preventDefault();
                res.focusLane(l.id);
            });
            div.querySelector('.sel').addEventListener('click', (e) => {
                e.preventDefault();
                this.selected = l.id;
                res.audioLane = l.id;           // sonification follows the selection
                res.onAudioLaneChange?.();
                this.renderConstraints(world);
            });
            box.appendChild(div);
        }
    }

    renderConstraints(world) {
        const res = world.res;
        const box = res.els.constraints; if (!box) return;
        const l = res.laneOf(this.selected);
        const defs = CONSTRAINTS[this.selected] ?? [];
        box.innerHTML = `<h2 style="color:${l.def.css}">constraints · ${l.def.name}</h2>`;
        for (const c of defs) {
            const cur = l.overrides[c.key] ?? l.sc[c.key];
            const wrap = document.createElement('div');
            wrap.className = 'obs-ctl';
            if (c.type === 'select') {
                wrap.innerHTML = `<label title="${c.tip}">${c.label}` +
                    `<em class="tag tag-${c.tag}">${c.tag}</em></label>` +
                    `<select>${c.options.map(([v, txt]) =>
                        `<option value="${v}" ${v === (l.overrides[c.key] ?? l.sc.massModel) ? 'selected' : ''}>${txt}</option>`).join('')}</select>`;
                wrap.querySelector('select').addEventListener('change', (e) => {
                    res.reconfigureLane(l.id, { [c.key]: e.target.value });
                    res.rebuildCurves();
                });
            } else {
                const scale = c.scale ?? 1;
                wrap.innerHTML = `<label title="${c.tip}">${c.label}` +
                    `<em class="tag tag-${c.tag}">${c.tag}</em>` +
                    `<b class="val">${(cur / scale).toFixed(2)}</b></label>` +
                    `<input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${cur}">`;
                const inp = wrap.querySelector('input');
                const val = wrap.querySelector('.val');
                inp.addEventListener('input', () => {
                    val.textContent = (parseFloat(inp.value) / scale).toFixed(2);
                });
                inp.addEventListener('change', () => {
                    res.reconfigureLane(l.id, { [c.key]: parseFloat(inp.value) });
                    res.rebuildCurves();
                });
            }
            box.appendChild(wrap);
        }
        // experiment presets
        const pr = document.createElement('div');
        pr.className = 'obs-presets';
        pr.innerHTML = `<h2>experiments</h2>` + PRESETS.map(p =>
            `<button type="button" data-id="${p.id}" title="${p.tip}">${p.label}</button>`).join('');
        pr.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                const preset = PRESETS.find(p => p.id === btn.dataset.id);
                const l2 = res.laneOf(this.selected);
                if (preset.id === 'measured') l2.overrides = {};
                res.reconfigureLane(l2.id, preset.apply());
                res.rebuildCurves();
                this.renderConstraints(world);
            });
        });
        box.appendChild(pr);
        // stall tension warning
        if (l.history.events.stalled && this.selected === 'holm15a') {
            const warn = document.createElement('div');
            warn.className = 'obs-warn';
            warn.textContent = '⚠ with these constraints the binary never merges — ' +
                'contradicting the observed single black hole (final-parsec problem)';
            box.appendChild(warn);
        }
    }

    update() { }
}

// ═══ AudioSystem — GW chirp sonification following the selected system ═══════
class AudioSystem {
    init(world) {
        const res = world.res;
        this.audio = new GwAudio();
        res.els.audioBtn?.addEventListener('click', () => this.sync(res, this.audio.toggle()));
        res.onAudioLaneChange = () => this.sync(res, this.audio.on);
    }

    sync(res, on) {
        const btn = res.els.audioBtn; if (!btn) return;
        const l = res.laneOf(res.audioLane ?? 'a402');
        btn.textContent = on ? `🔊 GW · ${l.def.name.split(' ')[0]} · f ×3·10¹⁰` : '🔇 GW audio';
        btn.style.borderColor = on ? l.def.css : '';
    }

    update(world) {
        const res = world.res;
        const n = res.laneOf(res.audioLane ?? 'a402')?.state?.now;
        this.audio.update(n?.fgw ?? 0, n?.h ?? 0);
    }
}
