/**
 * upper-atmosphere-ui.js — Controls, plots, and state for upper-atmosphere.html
 * ═══════════════════════════════════════════════════════════════════════════
 * Wires three HTML range inputs (altitude / F10.7 / Ap) + a storm-preset
 * chip row to the physics surrogate (upper-atmosphere-engine.js) and the
 * 3D scene (upper-atmosphere-globe.js), and paints two raw-canvas plots:
 *
 *   • Density profile  — log₁₀(ρ) vs altitude, with a horizontal
 *     crosshair at the currently selected altitude.
 *   • Composition stack — per-species number-density fraction vs altitude,
 *     stacked areas in the canonical species order.
 *
 * No chart library — all drawing is plain CanvasRenderingContext2D, same
 * convention as solar-live-canvas.js / forecast-timeline-canvas. Plots
 * are DPI-aware and resize with the panel.
 */

import { SPECIES, stormPresets, exosphereTempK, dominantSpecies } from './upper-atmosphere-engine.js';

// ── Palette (matches the globe's density ramp in spirit) ────────────────────
const SPECIES_COLORS = {
    N2: '#3b7fff',
    O2: '#4cc7ff',
    NO: '#7fe0a0',
    O:  '#ffb347',
    N:  '#c078ff',
    He: '#ff6d87',
    H:  '#ffe06b',
};

const SPECIES_LABELS = {
    N2: 'N₂', O2: 'O₂', NO: 'NO', O: 'O', N: 'N', He: 'He', H: 'H',
};

// Same altitude band as the globe shells + profile.
const ALT_MIN = 80;
const ALT_MAX = 2000;

export class UpperAtmosphereUI {
    /**
     * @param {object} opts
     * @param {object} opts.engine     the engine module namespace
     * @param {object} opts.globe      AtmosphereGlobe instance
     * @param {object} opts.elements   { altInput, f107Input, apInput,
     *                                   altVal, f107Val, apVal,
     *                                   presetRow, densityCanvas,
     *                                   compCanvas, stats, summary }
     */
    constructor({ engine, globe, elements }) {
        this.engine = engine;
        this.globe = globe;
        this.el = elements;

        this.state = { f107: 150, ap: 15, altitude: 400 };

        this._bindInputs();
        this._renderPresets();
        this._bindResize();
        this.refresh();
    }

    // ── Public ──────────────────────────────────────────────────────────────

    setState(partial) {
        Object.assign(this.state, partial);
        // Reflect back to DOM sliders.
        if ('f107' in partial && this.el.f107Input)
            this.el.f107Input.value = String(this.state.f107);
        if ('ap' in partial && this.el.apInput)
            this.el.apInput.value = String(this.state.ap);
        if ('altitude' in partial && this.el.altInput)
            this.el.altInput.value = String(this.state.altitude);
        this.refresh();
    }

    /**
     * Recompute profile + redraw everything. Safe to call any time.
     */
    refresh() {
        const { f107, ap, altitude } = this.state;

        this.profile = this.engine.sampleProfile({
            f107Sfu: f107, ap,
            minKm: ALT_MIN, maxKm: ALT_MAX, nPoints: 220,
        });

        // Update labels.
        if (this.el.altVal)  this.el.altVal.textContent  = `${Math.round(altitude)} km`;
        if (this.el.f107Val) this.el.f107Val.textContent = `${Math.round(f107)} SFU`;
        if (this.el.apVal)   this.el.apVal.textContent   = String(Math.round(ap));

        // Push to globe.
        this.globe.setProfile(this.profile);
        this.globe.setAltitude(altitude);

        // Redraw.
        this._drawDensityProfile();
        this._drawComposition();
        this._paintStats();
    }

    // ── Input wiring ────────────────────────────────────────────────────────

    _bindInputs() {
        const wire = (el, key, cast) => {
            if (!el) return;
            el.value = String(this.state[key]);
            el.addEventListener('input', () => {
                this.state[key] = cast(el.value);
                this.refresh();
            });
        };
        wire(this.el.altInput,  'altitude', Number);
        wire(this.el.f107Input, 'f107',     Number);
        wire(this.el.apInput,   'ap',       Number);
    }

    _renderPresets() {
        const row = this.el.presetRow;
        if (!row) return;
        row.innerHTML = '';
        for (const p of stormPresets) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ua-chip';
            btn.textContent = p.name;
            btn.title = `${p.date} — F10.7 ${p.f107} SFU, Ap ${p.ap}\n\n${p.summary}`;
            btn.dataset.presetId = p.id;
            btn.addEventListener('click', () => {
                this.setState({ f107: p.f107, ap: p.ap });
                row.querySelectorAll('.ua-chip').forEach(c => c.classList.remove('ua-chip--on'));
                btn.classList.add('ua-chip--on');
                if (this.el.summary) {
                    this.el.summary.innerHTML =
                        `<strong>${p.name}</strong> <span class="ua-dim">· ${p.date}</span><br>${p.summary}`;
                }
            });
            row.appendChild(btn);
        }
    }

    _bindResize() {
        const redraw = () => {
            this._drawDensityProfile();
            this._drawComposition();
        };
        new ResizeObserver(redraw).observe(this.el.densityCanvas);
        new ResizeObserver(redraw).observe(this.el.compCanvas);
    }

    // ── Plots ───────────────────────────────────────────────────────────────

    _drawDensityProfile() {
        const c = this.el.densityCanvas;
        if (!c || !this.profile) return;
        const ctx = _prepareCanvas(c);

        const W = c.clientWidth, H = c.clientHeight;
        const pad = { l: 56, r: 14, t: 24, b: 36 };
        const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;

        // Axis extents.
        const samples = this.profile.samples;
        const rhos = samples.map(s => Math.log10(Math.max(s.rho, 1e-25)));
        const maxLR = Math.ceil(Math.max(...rhos));
        const minLR = Math.floor(Math.min(...rhos));
        const altMin = ALT_MIN, altMax = ALT_MAX;

        const xOf = (logRho) => pad.l + ((logRho - minLR) / (maxLR - minLR)) * plotW;
        const yOf = (alt)    => pad.t + (1 - (alt - altMin) / (altMax - altMin)) * plotH;

        // Background.
        ctx.fillStyle = 'rgba(12,7,30,0.85)';
        ctx.fillRect(0, 0, W, H);

        // Grid + axis labels.
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.fillStyle = '#889';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let a = 0; a <= 2000; a += 250) {
            const y = yOf(a);
            if (y < pad.t - 1 || y > H - pad.b + 1) continue;
            ctx.beginPath();
            ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y);
            ctx.stroke();
            ctx.fillText(`${a}`, pad.l - 6, y);
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let lr = minLR; lr <= maxLR; lr++) {
            const x = xOf(lr);
            ctx.beginPath();
            ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b);
            ctx.strokeStyle = 'rgba(255,255,255,0.04)';
            ctx.stroke();
            ctx.fillText(`10^${lr}`, x, H - pad.b + 4);
        }

        // Title.
        ctx.fillStyle = '#cdf';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('mass density ρ  (kg/m³, log₁₀)', pad.l, 4);
        ctx.textAlign = 'right';
        ctx.fillText('altitude (km)', pad.l - 4, 4);

        // Density curve.
        ctx.strokeStyle = '#0cf';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let i = 0; i < samples.length; i++) {
            const x = xOf(rhos[i]);
            const y = yOf(samples[i].altitudeKm);
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Current-altitude crosshair.
        const yCur = yOf(this.state.altitude);
        ctx.strokeStyle = 'rgba(0,255,230,0.75)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.l, yCur); ctx.lineTo(W - pad.r, yCur);
        ctx.stroke();
        ctx.setLineDash([]);

        // Crosshair label.
        const rhoHere = this.engine.density({
            altitudeKm: this.state.altitude,
            f107Sfu: this.state.f107,
            ap: this.state.ap,
        }).rho;
        ctx.fillStyle = '#0ff';
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(
            `ρ = ${rhoHere.toExponential(2)} kg/m³`,
            W - pad.r - 4, yCur - 3,
        );

        // Frame.
        ctx.strokeStyle = 'rgba(0,200,200,0.35)';
        ctx.strokeRect(pad.l, pad.t, plotW, plotH);
    }

    _drawComposition() {
        const c = this.el.compCanvas;
        if (!c || !this.profile) return;
        const ctx = _prepareCanvas(c);

        const W = c.clientWidth, H = c.clientHeight;
        const pad = { l: 56, r: 90, t: 24, b: 36 };
        const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;

        const samples = this.profile.samples;
        const altMin = ALT_MIN, altMax = ALT_MAX;
        const xOf = (frac) => pad.l + frac * plotW;
        const yOf = (alt)  => pad.t + (1 - (alt - altMin) / (altMax - altMin)) * plotH;

        // Background.
        ctx.fillStyle = 'rgba(12,7,30,0.85)';
        ctx.fillRect(0, 0, W, H);

        // Axis labels.
        ctx.fillStyle = '#889';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let a = 0; a <= 2000; a += 250) {
            const y = yOf(a);
            if (y < pad.t - 1 || y > H - pad.b + 1) continue;
            ctx.fillText(`${a}`, pad.l - 6, y);
        }

        // Build stacked cumulative arrays per species.
        const cumulative = samples.map(s => {
            const cum = {};
            let running = 0;
            for (const sp of SPECIES) {
                running += s.fractions[sp];
                cum[sp] = running;
            }
            return { alt: s.altitudeKm, cum };
        });

        // Draw bands back-to-front. We plot [0, f_N2, f_N2+f_O2, …, 1] and
        // fill each band between successive cumulative curves.
        let prevKey = null;
        for (const sp of SPECIES) {
            ctx.fillStyle = SPECIES_COLORS[sp];
            ctx.globalAlpha = 0.88;
            ctx.beginPath();
            // Top edge: current cumulative. Bottom edge: previous cumulative.
            for (let i = 0; i < cumulative.length; i++) {
                const s = cumulative[i];
                const x = xOf(s.cum[sp]);
                const y = yOf(s.alt);
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            for (let i = cumulative.length - 1; i >= 0; i--) {
                const s = cumulative[i];
                const base = prevKey == null ? 0 : s.cum[prevKey];
                ctx.lineTo(xOf(base), yOf(s.alt));
            }
            ctx.closePath();
            ctx.fill();
            prevKey = sp;
        }
        ctx.globalAlpha = 1;

        // Crosshair at current altitude + dominant species tick.
        const yCur = yOf(this.state.altitude);
        ctx.strokeStyle = 'rgba(0,255,230,0.85)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.l, yCur); ctx.lineTo(W - pad.r, yCur);
        ctx.stroke();
        ctx.setLineDash([]);

        // Legend, right of plot.
        let legY = pad.t;
        ctx.font = '11px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        const currentFrac = this.engine.density({
            altitudeKm: this.state.altitude,
            f107Sfu: this.state.f107,
            ap: this.state.ap,
        }).fractions;
        for (const sp of SPECIES) {
            ctx.fillStyle = SPECIES_COLORS[sp];
            ctx.fillRect(W - pad.r + 8, legY - 6, 12, 12);
            ctx.fillStyle = '#cde';
            ctx.fillText(SPECIES_LABELS[sp], W - pad.r + 24, legY);
            ctx.fillStyle = '#8a9';
            const pct = (currentFrac[sp] * 100).toFixed(
                currentFrac[sp] < 0.001 ? 4 : currentFrac[sp] < 0.01 ? 3 : 1
            );
            ctx.fillText(`${pct}%`, W - pad.r + 48, legY);
            legY += 18;
        }

        // Title.
        ctx.fillStyle = '#cdf';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('composition stack  (fraction)', pad.l, 4);

        // X-axis labels (0.0, 0.5, 1.0).
        ctx.fillStyle = '#889';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (const f of [0, 0.25, 0.5, 0.75, 1]) {
            ctx.fillText(f.toFixed(2), xOf(f), H - pad.b + 4);
        }
        ctx.strokeStyle = 'rgba(0,200,200,0.35)';
        ctx.strokeRect(pad.l, pad.t, plotW, plotH);
    }

    _paintStats() {
        const box = this.el.stats;
        if (!box) return;
        const s = this.engine.density({
            altitudeKm: this.state.altitude,
            f107Sfu:    this.state.f107,
            ap:         this.state.ap,
        });
        const T_inf = exosphereTempK(this.state.f107, this.state.ap);
        const dom = dominantSpecies(this.state.altitude);

        const domPct = (s.fractions[dom] * 100).toFixed(1);
        const mBarAmu = (s.mBar / 1.66054e-27).toFixed(2);

        box.innerHTML = `
          <div class="ua-stat">
              <span class="ua-stat-k">ρ</span>
              <span class="ua-stat-v">${s.rho.toExponential(3)}</span>
              <span class="ua-stat-u">kg/m³</span>
          </div>
          <div class="ua-stat">
              <span class="ua-stat-k">n_total</span>
              <span class="ua-stat-v">${s.nTotal.toExponential(3)}</span>
              <span class="ua-stat-u">m⁻³</span>
          </div>
          <div class="ua-stat">
              <span class="ua-stat-k">T∞</span>
              <span class="ua-stat-v">${Math.round(T_inf)}</span>
              <span class="ua-stat-u">K</span>
          </div>
          <div class="ua-stat">
              <span class="ua-stat-k">H</span>
              <span class="ua-stat-v">${Number.isFinite(s.H_km) ? s.H_km.toFixed(1) : '—'}</span>
              <span class="ua-stat-u">km</span>
          </div>
          <div class="ua-stat">
              <span class="ua-stat-k">m̄</span>
              <span class="ua-stat-v">${mBarAmu}</span>
              <span class="ua-stat-u">amu</span>
          </div>
          <div class="ua-stat">
              <span class="ua-stat-k">dominant</span>
              <span class="ua-stat-v" style="color:${SPECIES_COLORS[dom]}">${SPECIES_LABELS[dom]}</span>
              <span class="ua-stat-u">${domPct}%</span>
          </div>
        `;
    }
}

// ── Utility ─────────────────────────────────────────────────────────────────

function _prepareCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width  = Math.max(1, Math.floor(w * dpr));
        canvas.height = Math.max(1, Math.floor(h * dpr));
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
}
