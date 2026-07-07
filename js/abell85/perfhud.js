// perfhud.js — on-screen frame-time HUD for the observatory (?hud=1).
//
// Instrumentation-first rule of the 3D upgrade (docs/observatory-3d/):
// every renderer change is judged against this readout, so it exists
// before any pipeline work. Pure DOM overlay, created only when the flag
// is on — zero cost otherwise (the system is simply never added).

export class PerfHudSystem {
    init(world) {
        const res = world.res;
        this.ema = null;                 // exponential moving average, ms
        this.win = new Float32Array(120);
        this.i = 0;
        this.el = document.createElement('div');
        this.el.style.cssText =
            'position:absolute;left:10px;bottom:44px;z-index:40;pointer-events:none;' +
            'font:10.5px/1.5 "Courier New",monospace;color:#9fe8b0;' +
            'background:rgba(4,6,10,.78);border:1px solid rgba(120,220,150,.35);' +
            'border-radius:6px;padding:6px 9px;white-space:pre;text-shadow:0 0 4px #000';
        this.el.textContent = 'perf…';
        res.els.canvas.parentElement.appendChild(this.el);
    }

    update(world, dt, wall) {
        const res = world.res;
        const ms = dt * 1000;
        this.ema = this.ema === null ? ms : this.ema + (ms - this.ema) * 0.05;
        this.win[this.i++ % this.win.length] = ms;
        if (wall - (this._last ?? 0) < 250) return;      // repaint at 4 Hz
        this._last = wall;
        let worst = 0;
        const n = Math.min(this.i, this.win.length);
        for (let k = 0; k < n; k++) worst = Math.max(worst, this.win[k]);
        const nStars = res.lanes().reduce((s, l) => s + (l.visible ? l.n : 0), 0);
        const eng = res.workerActive
            ? (res.engineType === 'wasm' ? 'wasm·worker' : 'js·worker')
            : (res.physicsReady ? 'js·main' : 'starting');
        const near = res.renderer.nearCount
            ? ` +geodesic×${res.renderer.nearCount}` : '';
        this.el.textContent =
            `${(1000 / this.ema).toFixed(0).padStart(3)} fps · ${this.ema.toFixed(1)} ms` +
            ` (worst ${worst.toFixed(0)})\n` +
            `stars ${nStars.toLocaleString('en-US')} · ${eng}\n` +
            `pipeline ${res.renderer.pipeline ?? 'classic'}${near} · cam ${res.cam.mode} ` +
            `d=${res.cam.dist.toPrecision(3)} pc`;
    }
}
