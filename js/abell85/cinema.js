// cinema.js — chromeless auto-playing presentation of the Holm 15A merger
// history for holm15a.html. Same physics engine as the abell85.html lab
// (physics/nbody/pn/render/camera), no panels: just the canvas, the
// simulation, and a self-directing camera.
//
// Master clock: the timeline advances at constant *sample index* rate. The
// history's samples are adaptively dense exactly where the dynamics are fast
// (buildHistory steps at ≤1.5% change in a), so uniform index speed plays the
// whole ~9 Gyr story at constant "interest rate" — cruising through the
// quiet Gyr and automatically decelerating into the final orbits, the
// merger, and the recoil, then looping.
//
// The camera choreographs itself by stage (wide approach → tightening chase
// → merger hold → slow pull-back) but yields to the user: dragging or
// scrolling pauses the director for a while, then it eases back in.

import { makeScenario, buildHistory, sampleAt, STAGE } from './physics.js';
import { StarCluster } from './nbody.js';
import { PNBinary } from './pn.js';
import { Renderer, Trail } from './render.js';
import { GodCamera } from './camera.js';
import { rSchw, rGrav } from './units.js';

const LOOP_SECONDS = 200;        // one full history pass ≈ 3⅓ minutes
const PN_WINDOW_RG = 300;
const DT_LIVE_MAX = 1.0;         // Myr of cluster time integrated per frame
const RESYNC_GAP = 200;          // Myr timeline lead before statistical resync
const USER_CAM_HOLD_S = 15;      // director pause after user input
const INCL = 25 * Math.PI / 180;

export function boot(canvas, scenarioId = 'holm15a') {
    const sc = makeScenario(scenarioId);
    const history = buildHistory(sc);
    const S = history.samples;
    const cluster = new StarCluster(sc, 4096, 85);
    const renderer = new Renderer(canvas);
    const cam = new GodCamera();
    renderer.camera = cam;
    cam.dist = 14000;
    cam.distClamp = [rSchw(sc.mTot) * 20, 4e4];
    const trails = [new Trail(500), new Trail(500)];

    const idxRate = (S.length - 1) / LOOP_SECONDS;
    let idx = 0;
    let tNow = S[0].t, clusterT = tNow, livePhase = 0;
    let livePN = null, pnRosette = [], lastRosette = 0;
    let userCamUntil = 0;

    function resync(clearTrails = true) {
        const now = sampleAt(history, tNow);
        cluster.reset(now.mej, true);
        clusterT = tNow;
        livePhase = now.phase;
        livePN = null; pnRosette = [];
        if (clearTrails) trails.forEach(t => t.clear());
    }
    resync();

    // ── pointer control: hands the camera to the user for a while ───────────
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
        userCamUntil = performance.now() / 1000 + USER_CAM_HOLD_S;
    });
    const clearPtr = (e) => pointers.delete(e.pointerId);
    canvas.addEventListener('pointerup', clearPtr);
    canvas.addEventListener('pointercancel', clearPtr);
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        cam.onWheel(e.deltaY);
        userCamUntil = performance.now() / 1000 + USER_CAM_HOLD_S;
    }, { passive: false });

    // ── binary geometry (Kepler fallback outside the live PN window) ────────
    function keplerSolve(M, e) {
        let E = M;
        for (let i = 0; i < 6; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
        return E;
    }
    function keplerPositions(now) {
        if (now.a <= 0) {
            const rem = history.events.remnant;
            const dtM = now.t - history.events.merger;
            const off = (now.remnantOffset ?? 0) *
                Math.sin(history.events.recoil ? Math.min(dtM * history.events.recoil.omega, 1e6) : 0);
            return [{ p: [off, 0, 0], m: rem ? rem.mass : sc.mTot }];
        }
        const E = keplerSolve(livePhase, now.e);
        const r = now.a * (1 - now.e * Math.cos(E));
        const nu = 2 * Math.atan2(Math.sqrt(1 + now.e) * Math.sin(E / 2),
            Math.sqrt(1 - now.e) * Math.cos(E / 2));
        const ang = nu + now.peri;
        const ux = Math.cos(ang), uz = Math.sin(ang);
        const f1 = sc.m2 / sc.mTot, f2 = sc.m1 / sc.mTot;
        const si = Math.sin(INCL), ci = Math.cos(INCL);
        const tilt = (x, z) => [x, z * si, z * ci];
        return [
            { p: tilt(r * f1 * ux, r * f1 * uz), m: sc.m1 },
            { p: tilt(-r * f2 * ux, -r * f2 * uz), m: sc.m2 },
        ];
    }

    // ── camera director ──────────────────────────────────────────────────────
    function directCamera(now, wallS, dtWall) {
        if (wallS < userCamUntil) return;
        cam.yaw += 0.035 * dtWall;                                   // slow drift
        const pitchGoal = 0.30 + 0.10 * Math.sin(wallS * 0.045);
        cam.pitch += (pitchGoal - cam.pitch) * (1 - Math.exp(-dtWall * 0.4));
        let want;
        if (now.a <= 0) {
            const sinceMerge = now.t - (history.events.merger ?? now.t);
            want = sinceMerge < 1200 ? 900 : 13000;   // hold the aftermath, then pull wide
        } else if (now.a < PN_WINDOW_RG * rGrav(sc.mTot)) {
            want = Math.max(now.a * 7, rSchw(sc.mTot) * 60);        // final-orbit chase
        } else if (now.a < sc.rInfl) {
            want = Math.max(now.a * 5, 2200);                        // hardening: mid zoom
        } else {
            want = 14000;                                             // approach: wide
        }
        cam.goalDist = Math.min(Math.max(want, cam.distClamp[0]), cam.distClamp[1]);
    }

    function ringSet() {
        const e = cam.eye();
        const d = cam.mode === 'orbit' ? cam.dist : Math.max(Math.hypot(e[0], e[1], e[2]), 1e-3);
        const rings = [];
        for (const R of [0.1, 1, 10, 100, 1000, 10000]) {
            if (R > d * 0.02 && R < d * 2.5) rings.push(R);
        }
        return rings;
    }

    // ── main loop ────────────────────────────────────────────────────────────
    let lastWall = performance.now();
    function tick(wall) {
        const dtWall = Math.min((wall - lastWall) / 1000, 0.1);
        lastWall = wall;
        const wallS = wall / 1000;

        // master clock: constant interest-rate index advance, looping.
        // The approach (dynamical-friction sink) is uniformly sampled rather
        // than interest-sampled, so the director fast-forwards it 4×.
        const curStage = S[Math.min(Math.floor(idx), S.length - 1)].stage;
        const pace = curStage === STAGE.APPROACH ? 4 : 1;
        idx += idxRate * pace * dtWall;
        if (idx >= S.length - 1) { idx = 0; tNow = S[0].t; resync(); }
        const i0 = Math.floor(idx), f = idx - i0;
        const i1 = Math.min(i0 + 1, S.length - 1);
        const tPrev = tNow;
        tNow = S[i0].t + (S[i1].t - S[i0].t) * f;
        const dtSim = Math.max(tNow - tPrev, 0);
        const now = sampleAt(history, tNow);

        // binary position: live PN inside the window, Kepler phase outside
        let bhs = null;
        const inWin = now.a > 0 && now.a < PN_WINDOW_RG * rGrav(sc.mTot);
        if (inWin) {
            if (!livePN) {
                livePN = new PNBinary(sc, {
                    a: now.a, e: now.e, phase: livePhase, peri: now.peri, incl: INCL,
                });
            }
            const adv = livePN.step(dtSim, 16000);
            if (adv >= dtSim * 0.999) {
                bhs = livePN.positions();
                if (wall - lastRosette > 600) {
                    const pts = livePN.ellipsePoints(96);
                    if (pts) {
                        pnRosette.push({ buf: pts, count: 97 });
                        if (pnRosette.length > 8) pnRosette.shift();
                        lastRosette = wall;
                    }
                }
            } else { livePN = null; }
        } else {
            livePN = null;
            if (now.a <= 0) pnRosette = [];
        }
        if (!bhs) {
            if (now.a > 0 && now.fgw > 0) {
                const pMyr = 2 / now.fgw / 3.15576e13;
                livePhase = (livePhase + 2 * Math.PI * dtSim / pMyr) % (2 * Math.PI);
            }
            bhs = keplerPositions(now);
        }

        // star cluster: live catch-up or statistical resync (keep trails)
        const gap = tNow - clusterT;
        if (gap > RESYNC_GAP || gap < 0) {
            resync(false);
        } else if (gap > 0) {
            const dt = Math.min(gap, DT_LIVE_MAX);
            cluster.step(dt, bhs[0].p, bhs[0].m, bhs[1]?.p ?? [0, 0, 0], bhs[1]?.m ?? 0);
            clusterT += dt;
        }
        cluster.classify(now.a > 0 ? sc.mTot : 0, now.a);   // cyan loss-cone stars

        if (bhs.length) {
            trails[0].push(...bhs[0].p);
            if (bhs[1]) trails[1].push(...bhs[1].p);
        }

        // camera
        const eyeNow = cam.eye();
        let dNear = Infinity;
        for (const b of bhs) {
            dNear = Math.min(dNear, Math.hypot(
                b.p[0] - eyeNow[0], b.p[1] - eyeNow[1], b.p[2] - eyeNow[2]));
        }
        directCamera(now, wallS, dtWall);
        cam.update(dtWall, Number.isFinite(dNear) ? dNear : cam.dist);

        renderer.render({
            pos: cluster.pos, flags: cluster.flags, n: cluster.n,
            bhs, trails,
            rings: ringSet(),
            lensOn: true,
            extraLines: pnRosette.map((r, i) => ({
                buf: r.buf, count: r.count,
                color: [0.62, 0.58, 1.0, 0.05 + 0.06 * (i + 1)],
            })),
        });

        // probe/smoke-test handle (same pattern as sun.html's window.__sun)
        window.__holm15a = { ready: true, t: tNow, stage: now.stage, idx };

        requestAnimationFrame(tick);
    }

    requestAnimationFrame((w) => { lastWall = w; requestAnimationFrame(tick); });
    return { scenario: sc, history };
}
