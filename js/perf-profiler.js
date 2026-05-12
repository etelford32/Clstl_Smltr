/**
 * perf-profiler.js — Frame-section profiler for the space-weather pipeline
 * ═════════════════════════════════════════════════════════════════════════
 *
 * Wraps performance.now() bracket-timing around named sections of the
 * render loop and tracks an exponential-moving-average + slow-decaying
 * peak per section.  Combined with three.js's renderer.info.render
 * (draw calls, triangles, lines, points) this gives us actual data on
 * what dominates frame time — so optimization decisions can be informed
 * rather than guessed.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *   import { PerfProfiler } from './js/perf-profiler.js';
 *
 *   const prof = new PerfProfiler();
 *   //  in the render loop
 *   prof.frameStart();
 *   prof.measure('wind',   () => stepWind(dt));
 *   prof.measure('belts',  () => belts.update(dt));
 *   prof.measure('render', () => composer.render());
 *   prof.frameEnd(renderer.info);
 *
 * ── Snapshot for HUD ─────────────────────────────────────────────────────
 *   const snap = prof.snapshot();
 *   //  → { fps, sections: [{ name, last, ema, peak }, …], renderer: { calls, triangles, … } }
 *
 * The EMA smooths jitter (α ≈ 0.08) so the HUD numbers are readable; the
 * peak decays slowly (×0.995 per frame) so transient spikes show as a
 * separate column for ~3 s before fading.
 */

const EMA_ALPHA       = 0.08;     // exponential smoothing weight on new sample
const PEAK_DECAY      = 0.995;    // per-frame multiplicative decay of the peak
const FPS_WINDOW_SIZE = 60;       // last N frame-end timestamps for FPS calc

export class PerfProfiler {
    constructor() {
        this._sections     = new Map();   // name → { ema, last, peak, count }
        this._fpsWin       = [];
        this._frameStartT  = 0;
        this._lastRenderer = null;
        this._enabled      = true;
    }

    enable(v = true)  { this._enabled = !!v; }
    get enabled()     { return this._enabled; }

    /** Mark the start of a frame.  Call once per requestAnimationFrame. */
    frameStart() {
        if (!this._enabled) return;
        this._frameStartT = performance.now();
    }

    /**
     * Mark the end of a frame.  Records 'frame' total time and rolls the
     * FPS window.  Pass `renderer.info.render` to capture draw stats.
     */
    frameEnd(rendererInfo = null) {
        if (!this._enabled) return;
        const t = performance.now();
        this._record('frame', t - this._frameStartT);
        this._fpsWin.push(t);
        while (this._fpsWin.length > FPS_WINDOW_SIZE) this._fpsWin.shift();
        if (rendererInfo) {
            // three.js exposes both `renderer.info` and `renderer.info.render`.
            // We accept either; downstream snapshot reads `.render` shape.
            this._lastRenderer = rendererInfo.render
                ? { ...rendererInfo.render, memory: rendererInfo.memory }
                : { ...rendererInfo };
        }
        // Decay every section's peak so transient spikes fade naturally.
        for (const s of this._sections.values()) {
            s.peak *= PEAK_DECAY;
        }
    }

    /**
     * Measure a synchronous section.  Returns the function's return value so
     * the call-site doesn't need to restructure (just wrap fn → measure).
     */
    measure(name, fn) {
        if (!this._enabled) return fn();
        const t0 = performance.now();
        try { return fn(); }
        finally { this._record(name, performance.now() - t0); }
    }

    /** Manual record (when bracketing isn't a function). */
    record(name, ms) {
        if (!this._enabled) return;
        this._record(name, ms);
    }

    _record(name, ms) {
        let s = this._sections.get(name);
        if (!s) {
            s = { ema: 0, last: 0, peak: 0, count: 0 };
            this._sections.set(name, s);
        }
        s.last  = ms;
        s.ema   = s.ema === 0 ? ms : s.ema * (1 - EMA_ALPHA) + ms * EMA_ALPHA;
        s.peak  = Math.max(s.peak, ms);
        s.count++;
    }

    /** Frames per second computed from the rolling timestamp window. */
    get fps() {
        const n = this._fpsWin.length;
        if (n < 2) return 0;
        const span = this._fpsWin[n - 1] - this._fpsWin[0];
        if (span <= 0) return 0;
        return ((n - 1) * 1000) / span;
    }

    /** Sections sorted descending by EMA (hottest first). */
    sectionsByCost() {
        return Array.from(this._sections.entries())
            .map(([name, s]) => ({ name, last: s.last, ema: s.ema, peak: s.peak, count: s.count }))
            .sort((a, b) => b.ema - a.ema);
    }

    /** Compact snapshot for HUD consumption. */
    snapshot() {
        return {
            fps:      this.fps,
            sections: this.sectionsByCost(),
            renderer: this._lastRenderer,
        };
    }

    /** Reset all counters (e.g. after a regression test). */
    reset() {
        this._sections.clear();
        this._fpsWin.length = 0;
    }
}
