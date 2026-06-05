/**
 * lod.js — Level-of-detail controller for the Operations globe.
 *
 * Workstream C, first slice: a camera-distance driver that caps how many
 * catalogue points are drawn individually and decimates the overflow. The
 * full catalogue + debris clouds (tens of thousands of objects) would
 * otherwise feed the GPU a vertex per fragment every frame — most of them
 * overdrawn into the same pixels when zoomed out, where you can't tell one
 * fragment from the next anyway.
 *
 * Tiers, distance-driven (Earth radius = 1 scene unit, camera 1.2–20 out):
 *   - L0 owned fleet  — rendered separately (hero meshes + selection
 *     sprite + trails). Always legible; untouched by this controller.
 *   - L1 near catalogue — zoomed in, the budget rises toward the cap so
 *     individual dots resolve for picking and inspection.
 *   - L2 far catalogue — zoomed out, the budget drops to the floor; the
 *     tracker thins the cloud with a uniform-stride index buffer, so the
 *     debris field keeps its *shape* without paying for every fragment.
 *
 * The whole thing is a no-op until the catalogue exceeds the budget, so a
 * small default layer set is unaffected. Propagation is unchanged — the
 * SGP4 worker still advances every object; we only change what's drawn.
 */

const DEFAULTS = Object.freeze({
    cap:   8000,   // hard ceiling on individually-drawn points (plan: ~5–8k)
    floor: 2500,   // most-decimated budget when fully zoomed out
    near:  2.2,    // camera distance treated as "zoomed in"
    far:   9.0,    // camera distance treated as "zoomed out"
    hysteresis: 200, // ignore budget deltas smaller than this (avoid churn)
});

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Start the LOD controller. Returns a stop function.
 *
 * @param {OperationsGlobe} globe
 * @param {SatelliteTracker} tracker
 * @param {object} [opts]
 * @param {(status:{drawn:number,total:number,decimating:boolean})=>void} [opts.onStatus]
 */
export function startLodController(globe, tracker, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    let lastBudget = -1;
    let lastStatusKey = '';

    const off = globe.onTick(() => {
        // Camera distance from Earth centre (Earth is at the scene origin).
        const d = globe.camera.position.length();
        const t = clamp((d - cfg.near) / (cfg.far - cfg.near), 0, 1);
        const budget = Math.round(cfg.cap + (cfg.floor - cfg.cap) * t);

        if (lastBudget < 0 || Math.abs(budget - lastBudget) >= cfg.hysteresis) {
            lastBudget = budget;
            tracker.setDrawBudget(budget);
        }

        if (cfg.onStatus) {
            const drawn = tracker.getDrawnCount();
            const total = tracker.getCatalogSize();
            const decimating = drawn < total;
            // Round drawn to the nearest 100 for a stable readout.
            const key = `${decimating ? Math.round(drawn / 100) * 100 : total}/${total}`;
            if (key !== lastStatusKey) {
                lastStatusKey = key;
                cfg.onStatus({ drawn, total, decimating });
            }
        }
    });

    return off;
}
