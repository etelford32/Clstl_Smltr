// observatory.js — the Storm Observatory page controller (storm-observatory.html).
//
// The black-hole observatory chassis, re-aimed at the thermosphere: one
// shared Earth, three storm lanes τ-synced on time-to-peak (τ = t − t_peak),
// the same 20,000-object LEO catalog flown through each lane's density
// history in a module Worker (js/storm/simworker.js, WASM kernel), an
// explicit ECS (js/abell85/ecs.js — it is generic), the abell85 renderer
// (points + flag grammar carry over: nominal/tinted · orange decaying ·
// cyan high-drag · marker ring), the god camera, and a provenance-tagged
// dial rail. Deterministic replay: scrubbing back re-integrates bit-exactly.

import { World } from '../abell85/ecs.js';
import { Renderer, Trail } from '../abell85/render.js';
import { GodCamera } from '../abell85/camera.js';
import { hydrateBundle, makeScenario } from './bundle.js';
import { StormLane } from './laneengine.js';
import { loadStormWasm } from './wasmswarm.js';
import { STRIDE, CLS } from './catalog.js';
import { R_EARTH_KM, fmtAlt, fmtRho, fmtHours } from './units.js';

const LOOP_SECONDS = 150;
const DATA = 'data/storm/';

export const LANE_DEFS = {
    feb2022: {
        name: 'Starlink Feb 2022', tag: 'the minor storm that killed 38 satellites',
        css: '#a99bff', tint: [0.80, 0.75, 1.0],
        bundleUrl: DATA + 'feb2022_starlink.json',
        opts: { cohortBc: 0.015, raiseRate: 0 },
    },
    gannon: {
        name: 'Gannon May 2024', tag: 'the G5 extreme', css: '#f0bd55',
        tint: [1.0, 0.86, 0.55],
        bundleUrl: DATA + 'gannon_may_2024.json',
        opts: {},
    },
    scenario: {
        name: 'Scenario', tag: 'quiet counterfactual → what-if machine',
        css: '#4fd1b8', tint: [0.55, 1.0, 0.88],
        scenario: {
            quietUrl: DATA + 'solar_min_dec_2019.json',
            baseUrls: {
                halloween03: DATA + 'halloween_oct_2003.json',
                carrington: DATA + 'carrington_class.json',
            },
            baseId: 'quiet', dials: {},
        },
        opts: {},
    },
};

// ── dial catalogue: every control carries its provenance ────────────────────
const CONSTRAINTS = {
    feb2022: [
        { key: 'cohortBc', label: 'cohort attitude (bc m²/kg)', type: 'select', tag: 'assumed', tip: 'passive tumbling ~0.015 vs SpaceX edge-on "shark-fin" ~0.004 — the attitude call that decided survival', options: [['0.015', 'passive tumble · 0.015'], ['0.004', 'edge-on safe mode · 0.004']] },
        { key: 'raiseRate', label: 'ion raise (m/s per day)', min: 0, max: 6, step: 0.5, tag: 'inferred', tip: 'continuous krypton-Hall orbit raise; the race between thrust and storm drag', },
    ],
    gannon: [],
    scenario: [
        { key: 'baseId', label: 'storm preset', type: 'select', tag: 'free', tip: 'quiet Dec-2019 counterfactual, real Halloween-2003 ap, or the Carrington-class synthesis', options: [['quiet', 'quiet (Dec 2019)'], ['halloween03', 'Halloween 2003 (real ap)'], ['carrington', 'Carrington-class (synthetic)']] },
        { key: 'alpha', label: 'intensity α', min: 0, max: 1.5, step: 0.05, tag: 'free', tip: 'log-space interpolation quiet→event; α>1 extrapolates beyond the observed storm' },
        { key: 'onsetShiftHours', label: 'onset shift (h)', min: -48, max: 48, step: 6, tag: 'free', tip: 'slide the storm in τ' },
        { key: 'durationScale', label: 'duration ×', min: 0.5, max: 2, step: 0.25, tag: 'free', tip: 'stretch the storm about its peak' },
    ],
};

const PRESETS = [
    { id: 'asflown', label: 'Feb 2022 as flown', tip: 'edge-on + 3 m/s/day raise: the survival attempt', lane: 'feb2022', opts: { cohortBc: 0.004, raiseRate: 3 } },
    { id: 'passive', label: 'passive fleet', tip: 'no thrust, tumbling — what drag alone does', lane: 'feb2022', opts: { cohortBc: 0.015, raiseRate: 0 } },
    { id: 'carrington', label: 'Carrington tomorrow', tip: 'scenario lane → Carrington-class at full strength', lane: 'scenario', scenario: { baseId: 'carrington', dials: { alpha: 1 } } },
    { id: 'quiet', label: 'quiet counterfactual', tip: 'scenario lane back to solar-min baseline', lane: 'scenario', scenario: { baseId: 'quiet', dials: {} } },
];

// ═════════════════════════════════════════════════════════════════════════════

export function boot(els) {
    const world = new World();
    const res = world.res;
    res.els = els;
    res.renderer = new Renderer(els.canvas);
    res.cam = new GodCamera();
    res.renderer.camera = res.cam;
    res.cam.dist = 28000;                       // km scene
    res.cam.distClamp = [7000, 3e5];

    for (const id of ['feb2022', 'gannon', 'scenario']) {
        const e = world.entity();
        world.add(e, 'lane', {
            id, def: LANE_DEFS[id],
            visible: true,
            meta: null,                         // from worker 'ready'
            state: null, pos: null, flags: null, n: 0,
            curve: null,                        // ρ400(τ) for the chart
            decayHist: [],                      // [{tau, reentered}]
        });
    }
    res.laneOf = (id) => {
        for (const e of world.query('lane')) {
            if (world.get(e, 'lane').id === id) return world.get(e, 'lane');
        }
        return null;
    };
    res.lanes = () => world.query('lane').map(e => world.get(e, 'lane'));

    world.system(new DataSystem());             // main-side bundles for charts/axis
    world.system(new TimelineSystem());
    world.system(new PhysicsSystem());
    world.system(new InspectSystem());
    world.system(new CameraSystem());
    world.system(new RenderSystem());
    world.system(new HudSystem());
    world.system(new AnalyticsSystem());
    world.system(new UISystem());

    let last = performance.now();
    function frame(wall) {
        res.wall = wall;
        const dt = Math.min((wall - last) / 1000, 0.1);
        last = wall;
        world.tick(dt, wall);
        window.__storm = {
            ready: !!res.physicsReady,
            engine: res.engineType ?? null,
            workerActive: !!res.workerActive,
            tau: res.tau,
            n: res.lanes()[0]?.n || 0,
            sel: res.sel ? { lane: res.sel.laneId, index: res.sel.index, hasState: !!res.sel.obj } : null,
            reentered: res.lanes().map(l => l.state?.counts?.reentered ?? 0),
        };
        requestAnimationFrame(frame);
    }
    requestAnimationFrame((w) => { last = w; requestAnimationFrame(frame); });
    window.__stormWorld = world;                // debug/probe handle
    return world;
}

// ═══ DataSystem — main-side bundles (charts, τ axis, quiet reference) ════════
class DataSystem {
    init(world) {
        const res = world.res;
        res.bundles = {};
        this.load(world);
        res.reloadScenarioCurve = () => this.scenarioCurve(world);
    }

    async load(world) {
        const res = world.res;
        const urls = {
            feb2022: LANE_DEFS.feb2022.bundleUrl,
            gannon: LANE_DEFS.gannon.bundleUrl,
            quiet: LANE_DEFS.scenario.scenario.quietUrl,
            halloween03: LANE_DEFS.scenario.scenario.baseUrls.halloween03,
            carrington: LANE_DEFS.scenario.scenario.baseUrls.carrington,
        };
        await Promise.all(Object.entries(urls).map(async ([id, url]) => {
            res.bundles[id] = hydrateBundle(await (await fetch(url)).json());
        }));
        res.laneOf('feb2022').bundle = res.bundles.feb2022;
        res.laneOf('gannon').bundle = res.bundles.gannon;
        res.laneOf('scenario').bundle = res.bundles.quiet;
        res.quietRho400 = (t) => res.bundles.quiet.grid.sample(400,
            Math.min(t, res.bundles.quiet.durationHours));
        for (const l of res.lanes()) this.curve(l);
        this.scenarioCurve(world);
        res.dataReady = true;
        res.rebuildTauAxis?.();
    }

    curve(l) {
        if (!l.bundle) return;
        const b = l.bundle;
        const pts = [];
        for (let t = 0; t <= b.durationHours; t += b.stepHours) {
            pts.push({ tau: t - b.tPeakHours, rho: b.grid.sample(400, t) });
        }
        l.curve = pts;
    }

    scenarioCurve(world) {
        const res = world.res;
        const l = res.laneOf('scenario');
        const cfg = res.scenarioCfg ?? { baseId: 'quiet', dials: {} };
        if (cfg.baseId === 'quiet') l.bundle = res.bundles.quiet;
        else {
            l.bundle = makeScenario(res.bundles.quiet, res.bundles[cfg.baseId], cfg.dials);
        }
        this.curve(l);
        res.rebuildTauAxis?.();
    }

    update() { }
}

// ═══ TimelineSystem — shared τ = t − t_peak axis ═════════════════════════════
class TimelineSystem {
    init(world) {
        const res = world.res;
        res.playing = true;
        res.speedMult = 1;
        res.idx = 0.02;
        res.tauRange = [-24, 120];
        res.rebuildTauAxis = () => {
            let lo = Infinity, hi = -Infinity;
            for (const l of res.lanes()) {
                if (!l.bundle) continue;
                lo = Math.min(lo, -l.bundle.tPeakHours);
                hi = Math.max(hi, l.bundle.durationHours - l.bundle.tPeakHours);
            }
            if (Number.isFinite(lo)) res.tauRange = [lo, hi];
        };
        res.els.timeline.addEventListener('input', () => {
            res.idx = parseFloat(res.els.timeline.value);
            res.playing = false; this.syncPlay(res);
        });
        res.els.playBtn.addEventListener('click', () => {
            if (!res.playing && res.idx >= 0.999) res.idx = 0;
            res.playing = !res.playing; this.syncPlay(res);
        });
        res.els.speed?.addEventListener('change', () => {
            res.speedMult = parseFloat(res.els.speed.value);
        });
        this.syncPlay(res);
    }

    syncPlay(res) { res.els.playBtn.textContent = res.playing ? '⏸' : '▶'; }

    update(world, dt) {
        const res = world.res;
        if (res.playing) {
            res.idx += dt * res.speedMult / LOOP_SECONDS;
            if (res.idx >= 1) { res.idx = 1; res.playing = false; this.syncPlay(res); }
            res.els.timeline.value = String(res.idx);
        }
        const [lo, hi] = res.tauRange;
        res.tau = lo + (hi - lo) * res.idx;
        res.laneT = new Map();
        for (const l of res.lanes()) {
            if (!l.bundle) continue;
            res.laneT.set(l.id, Math.min(Math.max(res.tau + l.bundle.tPeakHours, 0),
                l.bundle.durationHours));
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
        res.reconfigureLane = (id, payload) => this.reconfigure(world, id, payload);
        res.requestInspect = (id, index) => this.requestInspect(world, id, index);
        try {
            this.worker = new Worker(new URL('./simworker.js', import.meta.url), { type: 'module' });
            this.worker.onerror = () => this.fallback(world);
            this.worker.onmessage = (ev) => this.onmsg(world, ev.data);
            this.worker.postMessage({
                type: 'init',
                catalogUrl: new URL(DATA + 'catalog_leo20k.bin', document.baseURI).href,
                catalogMetaUrl: new URL(DATA + 'catalog_leo20k.meta.json', document.baseURI).href,
                lanes: res.lanes().map(l => ({
                    id: l.id,
                    bundleUrl: l.def.bundleUrl && new URL(l.def.bundleUrl, document.baseURI).href,
                    opts: l.def.opts,
                    scenario: l.def.scenario && {
                        ...l.def.scenario,
                        quietUrl: new URL(l.def.scenario.quietUrl, document.baseURI).href,
                        baseUrls: Object.fromEntries(Object.entries(l.def.scenario.baseUrls)
                            .map(([k, v]) => [k, new URL(v, document.baseURI).href])),
                    },
                })),
            });
        } catch {
            this.fallback(world);
        }
    }

    async fallback(world) {
        if (this.local || this._fallingBack) return;
        this._fallingBack = true;
        this.worker?.terminate?.();
        this.worker = null;
        const res = world.res;
        const [bin, meta] = await Promise.all([
            fetch(DATA + 'catalog_leo20k.bin').then(r => r.arrayBuffer()),
            fetch(DATA + 'catalog_leo20k.meta.json').then(r => r.json()),
        ]);
        const els = new Float32Array(bin, 0, meta.n * STRIDE);
        while (!res.dataReady) await new Promise(r => setTimeout(r, 60));
        const wasm = await loadStormWasm();
        this.local = new Map();
        for (const l of res.lanes()) {
            this.local.set(l.id, new StormLane(l.id,
                l.id === 'scenario' ? res.bundles.quiet : res.bundles[l.id],
                els, meta, wasm, l.def.opts));
            l.meta = { n: meta.n };
            l.n = meta.n;
        }
        res.catalogMeta = meta;
        res.workerActive = false;
        res.engineType = wasm ? 'wasm' : 'js';
        res.physicsReady = true;
    }

    onmsg(world, msg) {
        const res = world.res;
        if (msg.type === 'ready') {
            res.workerActive = true;
            res.physicsReady = true;
            res.engineType = msg.engine;
            for (const m of msg.lanes) {
                const l = res.laneOf(m.id);
                l.meta = m; l.n = m.n;
                l.placeholder = m.placeholder;
            }
            return;
        }
        if (msg.type === 'state') {
            this.pending = false;
            for (const st of msg.lanes) {
                const l = res.laneOf(st.id);
                if (!l) continue;
                l.state = st;
                l.n = st.n;
                // copy out of the transferables (they detach on ping-pong)
                if (!l.pos || l.pos.length !== st.n * 3) {
                    l.pos = new Float32Array(st.n * 3);
                    l.flags = new Uint8Array(st.n);
                }
                l.pos.set(new Float32Array(st.pos, 0, st.n * 3));
                l.flags.set(new Uint8Array(st.flags, 0, st.n));
                this.pools[st.id] = { pos: st.pos, flags: st.flags };
                // decay-history sample for the chart
                const tau = st.tau;
                const h = l.decayHist;
                if (!h.length || tau > h[h.length - 1].tau + 0.5) {
                    h.push({ tau, reentered: st.counts.reentered });
                    if (h.length > 2000) h.shift();
                } else if (tau < h[h.length - 1].tau - 0.5) {
                    l.decayHist = h.filter(p => p.tau < tau);
                }
            }
            return;
        }
        if (msg.type === 'reconfigured') {
            const l = res.laneOf(msg.id);
            if (l.id === 'scenario') res.reloadScenarioCurve();
            l.decayHist = [];
            return;
        }
        if (msg.type === 'inspect') {
            if (res.sel && res.sel.laneId === msg.id && res.sel.index === msg.index) {
                res.sel.obj = msg.obj;
            }
            this._inspectPending = false;
        }
    }

    reconfigure(world, id, payload) {
        const res = world.res;
        const l = res.laneOf(id);
        l.decayHist = [];
        if (payload.scenario) {
            res.scenarioCfg = payload.scenario;
            res.reloadScenarioCurve();
        }
        if (res.sel?.laneId === id) res.clearSel?.();
        if (this.worker) {
            this.worker.postMessage({ type: 'reconfigure', id, ...payload });
        } else if (this.local) {
            const lane = this.local.get(id);
            if (payload.scenario) {
                const s = payload.scenario;
                if (s.baseId === 'quiet') {
                    lane.bundle = res.bundles.quiet; lane.grid = res.bundles.quiet.grid;
                    const t = lane.tNow; lane.reset(); lane.setTime(t, Infinity);
                } else lane.setScenario(res.bundles.quiet, res.bundles[s.baseId], s.dials ?? {});
            }
            if (payload.opts) lane.reconfigure(payload.opts);
        }
    }

    requestInspect(world, id, index) {
        const res = world.res;
        if (this.worker) {
            if (this._inspectPending || !res.physicsReady) return;
            this._inspectPending = true;
            this.worker.postMessage({ type: 'inspect', id, index });
        } else if (this.local) {
            const lane = this.local.get(id);
            if (lane && res.sel) res.sel.obj = lane.swarm.objectState(index, lane.grid, lane.tNow);
        }
    }

    update(world) {
        const res = world.res;
        if (!res.physicsReady || !res.laneT) return;
        this.tick++;
        const ts = res.lanes().filter(l => l.visible && res.laneT.has(l.id))
            .map(l => ({ id: l.id, t: res.laneT.get(l.id) }));
        if (!ts.length) return;
        if (this.worker) {
            if (this.pending) return;
            this.pending = true;
            const pools = this.pools; this.pools = {};
            const transfer = [];
            for (const k of Object.keys(pools)) transfer.push(pools[k].pos, pools[k].flags);
            this.worker.postMessage({ type: 'frame', seq: this.tick, ts, pools }, transfer);
        } else if (this.local) {
            for (const { id, t } of ts) {
                const lane = this.local.get(id);
                lane.setTime(t);
                const l = res.laneOf(id);
                if (!l.pos || l.pos.length !== lane.swarm.n * 3) {
                    l.pos = new Float32Array(lane.swarm.n * 3);
                    l.flags = new Uint8Array(lane.swarm.n);
                }
                lane.swarm.positionsInto(l.pos);
                l.flags.set(lane.swarm.flags);
                l.state = { ...lane.state(), n: lane.swarm.n };
            }
        }
    }
}

// ═══ InspectSystem — tap a satellite (the abell85 pattern, km scene) ═════════
class InspectSystem {
    init(world) {
        const res = world.res;
        res.sel = null;
        this.trail = new Trail(300);
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

    pick(world, e) {
        const res = world.res;
        const rect = res.els.canvas.getBoundingClientRect();
        const dpr = (res.renderer._fboSize?.[0] || 1) / Math.max(rect.width, 1);
        const px = (e.clientX - rect.left) * dpr, py = (e.clientY - rect.top) * dpr;
        let best = null, bestD = 14 * dpr;
        for (const l of res.lanes()) {
            if (!l.visible || !l.pos) continue;
            for (let i = 0; i < l.n; i++) {
                if (l.flags[i] === 2) continue;              // reentered
                const j = i * 3;
                const s = res.renderer.worldToScreen([l.pos[j], l.pos[j + 1], l.pos[j + 2]]);
                if (!s) continue;
                const d = Math.hypot(s[0] - px, s[1] - py);
                if (d < bestD) { bestD = d; best = { laneId: l.id, index: i }; }
            }
        }
        this.trail.clear();
        res.sel = best ? { ...best, obj: null, marker: null, trailBuf: null } : null;
        this._lastReq = 0;
        this.render(res);
    }

    update(world, dt, wall) {
        const res = world.res;
        const sel = res.sel;
        if (!sel) return;
        const l = res.laneOf(sel.laneId);
        if (!l?.pos || sel.index >= l.n || !l.visible) { res.clearSel(); return; }
        const j = sel.index * 3;
        sel.marker = [l.pos[j], l.pos[j + 1], l.pos[j + 2]];
        if (res.playing) this.trail.push(sel.marker[0], sel.marker[1], sel.marker[2]);
        sel.trailBuf = this.trail.count > 1
            ? { buf: this.trail.ordered(), count: this.trail.count } : null;
        if (wall - (this._lastReq ?? 0) > 300) {
            this._lastReq = wall;
            res.requestInspect(sel.laneId, sel.index);
            this.render(res);
        }
    }

    render(res) {
        const el = res.els.inspector; if (!el) return;
        const sel = res.sel;
        if (!sel) { el.hidden = true; el.innerHTML = ''; this._key = null; return; }
        const l = res.laneOf(sel.laneId);
        const key = sel.laneId + '#' + sel.index;
        if (this._key !== key) {
            this._key = key;
            const name = sel.obj?.name ?? `object #${sel.index}`;
            el.innerHTML =
                `<div class="head" style="color:${l.def.css}">🛰 <span class="nm">${name}</span>` +
                `<button type="button" aria-label="close inspector">✕</button></div>` +
                `<div class="rows"></div>`;
            el.querySelector('button').addEventListener('click', () => res.clearSel());
        }
        const o = sel.obj;
        if (o?.name) el.querySelector('.nm').textContent = o.name;
        const status = o
            ? (o.flag === 2 ? 'REENTERED' : o.flag === 1 ? 'DECAYING' : o.flag === 3 ? 'HIGH DRAG' : 'nominal')
            : '…';
        const rows = [
            ['status', status],
            ['orbit', o ? `${fmtAlt(o.hpKm)} × ${fmtAlt(o.haKm)} · ${o.inclDeg.toFixed(1)}°` : '—'],
            ['ρ · q', o ? `${fmtRho(o.rho)} · ${(o.qPa * 1e3).toFixed(2)} mPa` : '—'],
            ['decay ȧ', o ? `${(o.adotKmDay * 1000).toFixed(0)} m/day` : '—'],
            ['est. lifetime', o ? (Number.isFinite(o.lifeDays) ? `${o.lifeDays > 365 ? (o.lifeDays / 365).toFixed(1) + ' yr' : o.lifeDays.toFixed(1) + ' d'}` : '∞') : '—'],
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
        const canvas = res.els.canvas;
        const pointers = new Map();
        canvas.addEventListener('pointerdown', (e) => {
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            canvas.setPointerCapture(e.pointerId);
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
        const clear = (e) => pointers.delete(e.pointerId);
        canvas.addEventListener('pointerup', clear);
        canvas.addEventListener('pointercancel', clear);
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            cam.onWheel(e.deltaY);
            this.userUntil = performance.now() / 1000 + 14;
        }, { passive: false });
        res.els.viewLeo?.addEventListener('click', () => cam.transitionTo(28000));
        res.els.viewCohort?.addEventListener('click', () => cam.transitionTo(9500));
    }

    update(world, dt, wall) {
        const res = world.res;
        if (wall / 1000 > this.userUntil) res.cam.yaw += 0.015 * dt;
        res.cam.update(dt, res.cam.dist);
    }
}

// ═══ RenderSystem — shared Earth + three tinted populations ══════════════════
class RenderSystem {
    init(world) {
        // wireframe Earth: 12 meridians + 5 parallels as line strips (km)
        this.earth = [];
        const R = R_EARTH_KM, N = 72;
        for (let m = 0; m < 12; m++) {
            const lon = m * Math.PI / 12;
            const buf = new Float32Array((N + 1) * 3);
            for (let k = 0; k <= N; k++) {
                const th = k / N * 2 * Math.PI;
                buf[k * 3] = R * Math.cos(th) * Math.cos(lon);
                buf[k * 3 + 1] = R * Math.cos(th) * Math.sin(lon);
                buf[k * 3 + 2] = R * Math.sin(th);
            }
            this.earth.push({ buf, count: N + 1, color: [0.35, 0.45, 0.7, 0.35] });
        }
        for (const latDeg of [-60, -30, 0, 30, 60]) {
            const lat = latDeg * Math.PI / 180;
            const r = R * Math.cos(lat), z = R * Math.sin(lat);
            const buf = new Float32Array((N + 1) * 3);
            for (let k = 0; k <= N; k++) {
                const th = k / N * 2 * Math.PI;
                buf[k * 3] = r * Math.cos(th);
                buf[k * 3 + 1] = r * Math.sin(th);
                buf[k * 3 + 2] = z;
            }
            this.earth.push({
                buf, count: N + 1,
                color: latDeg === 0 ? [0.5, 0.6, 0.85, 0.5] : [0.35, 0.45, 0.7, 0.3],
            });
        }
    }

    update(world) {
        const res = world.res;
        const lanes = [];
        let first = true;
        for (const l of res.lanes()) {
            if (!l.visible || !l.pos || !l.state) continue;
            const extraLines = first ? [...this.earth] : [];
            first = false;
            if (res.sel?.laneId === l.id && res.sel.trailBuf) {
                extraLines.push({
                    buf: res.sel.trailBuf.buf, count: res.sel.trailBuf.count,
                    color: [0.45, 1.0, 0.9, 0.6],
                });
            }
            // drag shell: brightness = this lane's ρ(450) enhancement vs quiet
            const shells = [];
            if (res.quietRho400 && l.state.rho400) {
                const enh = l.state.rho400 / res.quietRho400(l.state.t);
                if (enh > 1.15) {
                    shells.push({
                        center: [0, 0, 0], radius: R_EARTH_KM + 450,
                        alpha: Math.min(Math.log10(enh) * 0.8, 0.5),
                    });
                }
            }
            lanes.push({
                pos: l.pos, flags: l.flags, n: l.n,
                bhs: [], trails: [], tint: l.def.tint, extraLines, shells,
            });
        }
        res.renderer.renderComposite({
            lanes,
            rings: [R_EARTH_KM + 400, R_EARTH_KM + 1000],
            lensOn: false,
            marker: res.sel?.marker ?? null,
        });
    }
}

// ═══ HudSystem — chips, τ label, engine chip, watermark ══════════════════════
class HudSystem {
    update(world) {
        const res = world.res;
        if (res.els.tauLabel) {
            res.els.tauLabel.textContent = Number.isFinite(res.tau)
                ? `τ ${fmtHours(res.tau)} ${res.tau >= 0 ? 'after' : 'to'} storm peak` : '—';
        }
        let html = '';
        for (const l of res.lanes()) {
            const st = l.state;
            if (!st) continue;
            const dot = `<i style="background:${l.def.css}"></i>`;
            const enh = res.quietRho400 ? st.rho400 / res.quietRho400(st.t) : NaN;
            const body = l.visible
                ? `ap ${st.apNow.toFixed(0)} · ρ₄₀₀ ${st.rho400.toExponential(1)}` +
                  (Number.isFinite(enh) ? ` (${enh.toFixed(1)}×)` : '') +
                  ` · ↓${st.counts.reentered}` +
                  (l.id === 'feb2022' ? ` · cohort ${st.cohortLeft}/49` : '') +
                  (st.behind ? ' · integrating…' : '')
                : 'hidden';
            html += `<div class="obs-chip" style="border-color:${l.def.css}">${dot}` +
                `<b>${l.def.name}</b> · ${body}</div>`;
        }
        if (res.els.chips && html !== this._last) { res.els.chips.innerHTML = html; this._last = html; }
        if (res.els.engineChip) {
            const eng = !res.physicsReady ? 'starting…'
                : `${res.engineType === 'wasm' ? 'Rust→WASM' : 'JS'} · ` +
                  `${res.workerActive ? 'worker thread' : 'main thread'} · ` +
                  `${(res.lanes()[0]?.n || 0).toLocaleString('en-US')} objects × 3`;
            if (eng !== this._eng) { res.els.engineChip.textContent = eng; this._eng = eng; }
        }
        if (res.els.watermark) {
            const anyPlaceholder = res.lanes().some(l => l.placeholder) ||
                res.catalogMeta?._is_placeholder;
            res.els.watermark.hidden = !anyPlaceholder;
        }
    }
}

// ═══ AnalyticsSystem — ρ400(τ) chart + decay chart + comparison grid ═════════
class AnalyticsSystem {
    init(world) {
        const res = world.res;
        res.els.chartRho?.addEventListener('click', (e) => {
            const r = res.els.chartRho.getBoundingClientRect();
            res.idx = Math.min(Math.max((e.clientX - r.left - 4) / (r.width - 8), 0), 1);
            res.playing = false;
            res.els.playBtn.textContent = '▶';
        });
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
        if (!res.dataReady || wall - (this._lastDraw ?? 0) < 150) return;
        this._lastDraw = wall;
        this.drawRho(res);
        this.drawDecay(res);
        this.drawGrid(res);
    }

    drawRho(res) {
        const cv = res.els.chartRho; if (!cv) return;
        const { ctx, w, h } = this.chart(cv);
        ctx.fillStyle = '#9fb4d8';
        ctx.fillText('ρ(400 km) vs τ · click to scrub', 6, 12);
        const [lo, hi] = res.tauRange;
        const X = (tau) => 4 + (w - 8) * (tau - lo) / (hi - lo);
        let rMin = Infinity, rMax = 0;
        for (const l of res.lanes()) for (const p of (l.curve ?? [])) {
            rMin = Math.min(rMin, p.rho); rMax = Math.max(rMax, p.rho);
        }
        if (!(rMax > 0)) return;
        const lg0 = Math.log10(rMin), lg1 = Math.log10(rMax);
        const Y = (r) => 16 + (h - 30) * (1 - (Math.log10(r) - lg0) / Math.max(lg1 - lg0, 0.1));
        for (const l of res.lanes()) {
            if (!l.curve) continue;
            ctx.strokeStyle = l.def.css;
            ctx.globalAlpha = l.visible ? 1 : 0.25;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            l.curve.forEach((p, i) => {
                const px = X(p.tau), py = Y(p.rho);
                i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
            });
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
        ctx.lineWidth = 1;
        const x0 = X(0);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath(); ctx.moveTo(x0, 14); ctx.lineTo(x0, h - 6); ctx.stroke();
        ctx.fillStyle = '#bbc'; ctx.fillText('peak', Math.min(x0 + 4, w - 30), 24);
        const xp = 4 + (w - 8) * res.idx;
        ctx.strokeStyle = '#fff'; ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.moveTo(xp, 14); ctx.lineTo(xp, h - 6); ctx.stroke();
        ctx.globalAlpha = 1;
    }

    drawDecay(res) {
        const cv = res.els.chartDecay; if (!cv) return;
        const { ctx, w, h } = this.chart(cv);
        ctx.fillStyle = '#9fb4d8';
        ctx.fillText('reentries vs τ (cumulative)', 6, 12);
        const [lo, hi] = res.tauRange;
        const X = (tau) => 4 + (w - 8) * (tau - lo) / (hi - lo);
        let m = 5;
        for (const l of res.lanes()) for (const p of l.decayHist) m = Math.max(m, p.reentered);
        const Y = (c) => 14 + (h - 26) * (1 - c / m);
        for (const l of res.lanes()) {
            if (!l.decayHist.length) continue;
            ctx.strokeStyle = l.def.css;
            ctx.globalAlpha = l.visible ? 1 : 0.25;
            ctx.beginPath();
            l.decayHist.forEach((p, i) => {
                const px = X(p.tau), py = Y(p.reentered);
                i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
            });
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
        ctx.fillStyle = '#889';
        ctx.fillText(String(m), w - 26, 20);
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
        html += row('lane epoch', get(l => fmtHours(l.state.t - l.bundle.tPeakHours)));
        html += row('ap', get(l => l.state.apNow.toFixed(0)));
        html += row('F10.7', get(l => l.state.f107Now.toFixed(0)));
        html += row('ρ(400 km)', get(l => l.state.rho400.toExponential(2)));
        html += row('× quiet', get(l => res.quietRho400
            ? (l.state.rho400 / res.quietRho400(l.state.t)).toFixed(2) : '—'));
        html += row('high-drag ★', get(l => String(l.state.counts.highDrag)));
        html += row('decaying', get(l => String(l.state.counts.decaying)));
        html += row('reentered', get(l => String(l.state.counts.reentered)));
        html += row('cohort left', get(l => l.id === 'feb2022' ? `${l.state.cohortLeft}/49` : '—'));
        if (html !== this._lastGrid) { el.innerHTML = html; this._lastGrid = html; }
    }
}

// ═══ UISystem — intro gate, lane toggles, provenance-tagged dials ════════════
class UISystem {
    init(world) {
        const res = world.res;
        this.selected = 'feb2022';
        this.dials = { scenario: { baseId: 'quiet', dials: {} } };
        this.renderLaneToggles(world);
        this.renderConstraints(world);

        // intro gate: signed-in visitors (pp_auth mirror — see CLAUDE.md §6)
        // may enter; signed-out get the briefing + sign-in CTA. The sim runs
        // dimmed behind the overlay either way — the intro IS a teaser.
        const gate = res.els.intro;
        if (gate) {
            const signedIn = (() => {
                try {
                    return !!(localStorage.getItem('pp_auth') || sessionStorage.getItem('pp_auth'));
                } catch { return false; }
            })();
            if (sessionStorage.getItem('pp-storm-entered') === '1') {
                gate.hidden = true;
            } else {
                res.els.introEnter.hidden = !signedIn;
                res.els.introSignin.hidden = signedIn;
                res.els.introEnter?.addEventListener('click', () => {
                    gate.hidden = true;
                    sessionStorage.setItem('pp-storm-entered', '1');
                });
            }
        }
        res.els.methodsBtn?.addEventListener('click', () =>
            res.els.methods?.classList.add('open'));
        res.els.methodsClose?.addEventListener('click', () =>
            res.els.methods?.classList.remove('open'));
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
                `<button type="button" class="sel">dials</button>`;
            div.querySelector('input').addEventListener('change', (e) => {
                l.visible = e.target.checked;
            });
            div.querySelector('.sel').addEventListener('click', (e) => {
                e.preventDefault();
                this.selected = l.id;
                this.renderConstraints(world);
            });
            box.appendChild(div);
        }
    }

    _apply(world, laneId) {
        const res = world.res;
        if (laneId === 'scenario') {
            res.reconfigureLane('scenario', { scenario: this.dials.scenario });
        } else {
            res.reconfigureLane(laneId, { opts: this.dials[laneId] ?? {} });
        }
    }

    renderConstraints(world) {
        const res = world.res;
        const box = res.els.constraints; if (!box) return;
        const l = res.laneOf(this.selected);
        const defs = CONSTRAINTS[this.selected] ?? [];
        box.innerHTML = `<h2 style="color:${l.def.css}">dials · ${l.def.name}</h2>`;
        if (!defs.length) {
            box.innerHTML += `<p class="obs-note">drivers are measured (GFZ definitive ap, ` +
                `fixture F10.7) — nothing to dial. The MHD-corrected driver A/B ` +
                `(ap_real / ap_mhd / ap_gnd) lands here next.</p>`;
        }
        const cur = (c) => {
            if (this.selected === 'scenario') {
                return c.key === 'baseId' ? this.dials.scenario.baseId
                    : (this.dials.scenario.dials[c.key] ?? (c.key === 'alpha' ? 1 : c.key === 'durationScale' ? 1 : 0));
            }
            return (this.dials[this.selected] ?? l.def.opts ?? {})[c.key] ?? l.def.opts?.[c.key] ?? 0;
        };
        for (const c of defs) {
            const wrap = document.createElement('div');
            wrap.className = 'obs-ctl';
            if (c.type === 'select') {
                wrap.innerHTML = `<label title="${c.tip}">${c.label}` +
                    `<em class="tag tag-${c.tag}">${c.tag}</em></label>` +
                    `<select>${c.options.map(([v, txt]) =>
                        `<option value="${v}" ${String(cur(c)) === v ? 'selected' : ''}>${txt}</option>`).join('')}</select>`;
                wrap.querySelector('select').addEventListener('change', (e) => {
                    this.set(c.key, this.selected === 'scenario' && c.key === 'baseId'
                        ? e.target.value : parseFloat(e.target.value));
                    this._apply(world, this.selected);
                });
            } else {
                wrap.innerHTML = `<label title="${c.tip}">${c.label}` +
                    `<em class="tag tag-${c.tag}">${c.tag}</em>` +
                    `<b class="val">${(+cur(c)).toFixed(2)}</b></label>` +
                    `<input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${cur(c)}">`;
                const inp = wrap.querySelector('input');
                const val = wrap.querySelector('.val');
                inp.addEventListener('input', () => { val.textContent = (+inp.value).toFixed(2); });
                inp.addEventListener('change', () => {
                    this.set(c.key, parseFloat(inp.value));
                    this._apply(world, this.selected);
                });
            }
            box.appendChild(wrap);
        }
        const pr = document.createElement('div');
        pr.className = 'obs-presets';
        pr.innerHTML = `<h2>experiments</h2>` + PRESETS.map(p =>
            `<button type="button" data-id="${p.id}" title="${p.tip}">${p.label}</button>`).join('');
        pr.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                const p = PRESETS.find(x => x.id === btn.dataset.id);
                if (p.opts) { this.dials[p.lane] = { ...this.dials[p.lane], ...p.opts }; }
                if (p.scenario) { this.dials.scenario = { ...p.scenario, dials: { ...p.scenario.dials } }; }
                this._apply(world, p.lane);
                this.selected = p.lane;
                this.renderConstraints(world);
            });
        });
        box.appendChild(pr);
    }

    set(key, value) {
        if (this.selected === 'scenario') {
            if (key === 'baseId') this.dials.scenario.baseId = value;
            else this.dials.scenario.dials[key] = value;
        } else {
            this.dials[this.selected] = { ...(this.dials[this.selected] ?? {}), [key]: value };
        }
    }

    update() { }
}
