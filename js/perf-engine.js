/**
 * perf-engine.js — Adaptive performance engine for Celestial Simulator
 * ═══════════════════════════════════════════════════════════════════════
 * Monitors frame timing, dynamically adjusts quality (pixel ratio,
 * particle counts, LOD levels), and provides a real-time stats overlay.
 *
 * Usage:
 *   const perf = new PerfEngine(renderer, { targetFPS: 55 });
 *   // In animate loop:
 *   perf.begin();
 *   // ... render ...
 *   perf.end();
 *   perf.quality  →  0 (potato) | 1 (low) | 2 (medium) | 3 (high) | 4 (ultra)
 */

export class PerfEngine {
    /**
     * @param {THREE.WebGLRenderer} renderer
     * @param {Object} opts
     * @param {number} [opts.targetFPS=55]    — target frame rate
     * @param {number} [opts.sampleWindow=90] — frames to average over
     * @param {number} [opts.hysteresis=3000] — ms before downgrade/upgrade
     */
    constructor(renderer, opts = {}) {
        this.renderer  = renderer;
        this.targetFPS = opts.targetFPS ?? 55;
        this._window   = opts.sampleWindow ?? 90;
        this._hysteresis = opts.hysteresis ?? 3000;

        // Stats
        this.fps           = 60;
        this.frameMs       = 16.7;
        this.drawCalls     = 0;
        this.triangles     = 0;
        this.points        = 0;
        this.textures      = 0;
        this.geometries    = 0;
        this.programs      = 0;

        // Quality tier: 0–4
        this._quality       = 3;  // start at high
        this._lastChange    = 0;
        this._frameTimes    = [];
        this._t0            = 0;

        // Pixel ratio limits per quality tier
        this._prLimits = [1.0, 1.0, 1.5, Math.min(devicePixelRatio, 2), Math.min(devicePixelRatio, 2)];

        // Detect mobile
        this._isMobile = /Mobi|Android/i.test(navigator.userAgent);
        if (this._isMobile) {
            this._quality = 2;
            this._prLimits = [0.75, 1.0, 1.0, 1.25, 1.5];
        }

        // Overlay element (created on first show)
        this._overlayEl = null;
        this._overlayVisible = false;

        // Apply initial quality
        this._applyPixelRatio();
    }

    get quality() { return this._quality; }

    /** Quality tier names for display */
    get qualityName() {
        return ['Potato', 'Low', 'Medium', 'High', 'Ultra'][this._quality];
    }

    /** Sphere segment counts per quality tier [earth, clouds, atm] */
    get segments() {
        const tiers = [
            [48,  36, 28],   // potato
            [80,  56, 36],   // low
            [128, 96, 56],   // medium
            [192, 144, 80],  // high
            [256, 192, 112], // ultra
        ];
        return tiers[this._quality];
    }

    /** Particle count multiplier (0.3 – 1.5) */
    get particleScale() {
        return [0.3, 0.5, 0.8, 1.0, 1.5][this._quality];
    }

    /** Whether to enable expensive effects */
    get enableExpensiveEffects() {
        return this._quality >= 2;
    }

    /** Call at start of frame */
    begin() {
        this._t0 = performance.now();
    }

    /** Call at end of frame (after renderer.render) */
    end() {
        const now = performance.now();
        const dt = now - this._t0;
        this._frameTimes.push(dt);
        if (this._frameTimes.length > this._window) {
            this._frameTimes.shift();
        }

        // Compute stats
        const avg = this._frameTimes.reduce((a, b) => a + b, 0) / this._frameTimes.length;
        this.frameMs = avg;
        this.fps = Math.round(1000 / Math.max(avg, 1));

        // Read renderer info
        const info = this.renderer.info;
        this.drawCalls  = info.render.calls;
        this.triangles  = info.render.triangles;
        this.points     = info.render.points;
        this.textures   = info.memory.textures;
        this.geometries = info.memory.geometries;
        this.programs   = info.programs?.length ?? 0;

        // Adaptive quality adjustment
        if (this._frameTimes.length >= 30) {
            this._adaptQuality(now);
        }

        // Update overlay if visible
        if (this._overlayVisible && this._overlayEl) {
            this._updateOverlay();
        }
    }

    /** Force a specific quality tier (0–4) */
    setQuality(tier) {
        this._quality = Math.max(0, Math.min(4, tier));
        this._lastChange = performance.now();
        this._applyPixelRatio();
    }

    /** Toggle performance overlay */
    toggleOverlay() {
        this._overlayVisible = !this._overlayVisible;
        if (this._overlayVisible) {
            this._createOverlay();
            this._overlayEl.style.display = 'block';
        } else if (this._overlayEl) {
            this._overlayEl.style.display = 'none';
        }
    }

    showOverlay() {
        this._overlayVisible = true;
        this._createOverlay();
        this._overlayEl.style.display = 'block';
    }

    hideOverlay() {
        this._overlayVisible = false;
        if (this._overlayEl) this._overlayEl.style.display = 'none';
    }

    // ── Internal ──────────────────────────────────────────────────

    _adaptQuality(now) {
        if (now - this._lastChange < this._hysteresis) return;

        const targetMs = 1000 / this.targetFPS;

        if (this.frameMs > targetMs * 1.3 && this._quality > 0) {
            // Too slow — downgrade
            this._quality--;
            this._lastChange = now;
            this._applyPixelRatio();
        } else if (this.frameMs < targetMs * 0.7 && this._quality < 4) {
            // Headroom — upgrade (slower hysteresis)
            if (now - this._lastChange > this._hysteresis * 2) {
                this._quality++;
                this._lastChange = now;
                this._applyPixelRatio();
            }
        }
    }

    _applyPixelRatio() {
        const pr = this._prLimits[this._quality];
        if (Math.abs(this.renderer.getPixelRatio() - pr) > 0.01) {
            this.renderer.setPixelRatio(pr);
        }
    }

    _createOverlay() {
        if (this._overlayEl) return;

        const el = document.createElement('div');
        el.id = 'perf-overlay';
        el.style.cssText = `
            position:absolute; bottom:52px; left:50%; transform:translateX(-50%);
            z-index:100; background:rgba(0,0,0,.85); backdrop-filter:blur(8px);
            border:1px solid rgba(0,255,136,.2); border-radius:8px;
            padding:8px 14px; font:10px/1.6 'SF Mono',monospace;
            color:#8fc; pointer-events:none; white-space:nowrap;
            display:flex; gap:16px; align-items:center;
        `;
        el.innerHTML = `
            <span id="pf-fps" style="font-size:14px;font-weight:700;color:#0f8;min-width:45px">-- fps</span>
            <span id="pf-ms">--ms</span>
            <span id="pf-dc">-- draws</span>
            <span id="pf-tri">-- tris</span>
            <span id="pf-pts">-- pts</span>
            <span id="pf-mem">-- tex</span>
            <span id="pf-q" style="color:#ffa;font-weight:600">Q:--</span>
        `;

        // Find the app container to append into
        const app = document.getElementById('app') || document.body;
        app.appendChild(el);
        this._overlayEl = el;
    }

    _updateOverlay() {
        const fpsEl = document.getElementById('pf-fps');
        if (!fpsEl) return;

        const fpsCol = this.fps >= 55 ? '#0f8' : this.fps >= 40 ? '#ff0' : this.fps >= 25 ? '#f80' : '#f44';
        fpsEl.textContent = `${this.fps} fps`;
        fpsEl.style.color = fpsCol;

        document.getElementById('pf-ms').textContent  = `${this.frameMs.toFixed(1)}ms`;
        document.getElementById('pf-dc').textContent   = `${this.drawCalls} draws`;
        document.getElementById('pf-tri').textContent  = this.triangles > 1e6
            ? `${(this.triangles / 1e6).toFixed(1)}M tri`
            : `${(this.triangles / 1e3).toFixed(0)}K tri`;
        document.getElementById('pf-pts').textContent  = `${(this.points / 1e3).toFixed(0)}K pts`;
        document.getElementById('pf-mem').textContent  = `${this.textures}tex ${this.geometries}geo`;
        document.getElementById('pf-q').textContent    = `Q:${this.qualityName}`;
    }
}
