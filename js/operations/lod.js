/**
 * lod.js — Level-of-detail controller for the Operations globe.
 *
 * Workstream C: a camera-driven driver that keeps the catalogue legible and
 * cheap to draw. The full catalogue + debris clouds (tens of thousands of
 * objects) would otherwise feed the GPU a vertex per fragment every frame —
 * most of them overdrawn into the same pixels, or hidden behind the globe.
 *
 * Two coupled mechanisms, both via the tracker's index buffer:
 *   - Frustum + Earth-occlusion cull — only points on screen and in front
 *     of the globe are candidates, so the draw budget is spent on what the
 *     operator can actually see (the win when zoomed in).
 *   - Budget decimation — the visible candidates are thinned with a
 *     uniform stride to a hard cap, so the field keeps its shape without
 *     paying for every fragment (the win when zoomed out).
 *
 * Tiers, distance-driven (Earth radius = 1 scene unit, camera 1.2–20 out):
 *   - L0 owned fleet  — hero meshes + selection sprite + trails, rendered
 *     separately. Always legible; untouched here.
 *   - L1 near catalogue — zoomed in, the budget rises toward the cap and
 *     the frustum keeps the visible region dense and pickable.
 *   - L2 far catalogue — zoomed out, the budget drops to the floor and the
 *     visible (front-hemisphere) cloud is decimated to its shape.
 *
 * The cull loop only re-runs when the camera moves, the catalogue changes,
 * or a staleness timer fires (so orbital motion still refreshes), keeping
 * the per-frame cost near zero while the camera is still.
 */

const DEFAULTS = Object.freeze({
    cap:    8000,    // hard ceiling on individually-drawn points (plan: ~5–8k)
    floor:  2500,    // most-decimated budget when fully zoomed out
    near:   2.2,     // camera distance treated as "zoomed in"
    far:    9.0,     // camera distance treated as "zoomed out"
    moveEps: 0.01,   // camera-motion threshold (scene units / quat) to recull
    staleMs: 400,    // recull at least this often so orbital motion shows
});

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function startLodController(globe, tracker, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    const cam = globe.camera;

    let lastBudget = -1;
    let lastTotal  = -1;
    let lastStatusKey = '';
    let lastCullAt = 0;
    const lastPos = { x: NaN, y: NaN, z: NaN };
    let lastQuatW = NaN;

    const off = globe.onTick(() => {
        const total = tracker.getCatalogSize();

        // Budget from camera distance (Earth at the scene origin).
        const dist = cam.position.length();
        const t = clamp((dist - cfg.near) / (cfg.far - cfg.near), 0, 1);
        const budget = Math.round(cfg.cap + (cfg.floor - cfg.cap) * t);

        // Has the view changed enough to justify re-running the cull?
        const moved =
            Math.abs(cam.position.x - lastPos.x) > cfg.moveEps ||
            Math.abs(cam.position.y - lastPos.y) > cfg.moveEps ||
            Math.abs(cam.position.z - lastPos.z) > cfg.moveEps ||
            Math.abs(cam.quaternion.w - lastQuatW) > cfg.moveEps;
        const budgetMoved = Math.abs(budget - lastBudget) >= 150;
        const catalogChanged = total !== lastTotal;
        const stale = (performance.now() - lastCullAt) >= cfg.staleMs;

        if (total > 0 && (moved || budgetMoved || catalogChanged || stale)) {
            tracker.updateLodView(cam, { budget, cull: true });
            lastBudget = budget;
            lastTotal  = total;
            lastCullAt = performance.now();
            lastPos.x = cam.position.x; lastPos.y = cam.position.y; lastPos.z = cam.position.z;
            lastQuatW = cam.quaternion.w;
        }

        if (cfg.onStatus && total !== 0) {
            const drawn = tracker.getDrawnCount();
            const decimating = drawn < total;
            const key = `${decimating ? Math.round(drawn / 100) * 100 : total}/${total}`;
            if (key !== lastStatusKey) {
                lastStatusKey = key;
                cfg.onStatus({ drawn, total, decimating });
            }
        } else if (cfg.onStatus && total === 0 && lastStatusKey !== '0') {
            lastStatusKey = '0';
            cfg.onStatus({ drawn: 0, total: 0, decimating: false });
        }
    });

    return off;
}
