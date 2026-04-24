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

import {
    SPECIES,
    stormPresets,
    exosphereTempK,
    dominantSpecies,
    layerAt,
    ATMOSPHERIC_LAYERS,
    SATELLITE_REFERENCES,
    fetchProfile,
    fetchLiveIndices,
} from './upper-atmosphere-engine.js';

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
    constructor({ engine, globe, elements, useBackend = true }) {
        this.engine = engine;
        this.globe = globe;
        this.el = elements;
        this.useBackend = useBackend;

        this.state = { f107: 150, ap: 15, altitude: 400 };
        this._refreshInflight = null;
        this._refreshTimer = null;

        this._bindInputs();
        this._renderPresets();
        this._renderLayerLegend();
        this._bindLiveButton();
        this._bindSourcePill();
        this._bindSwpcEventBus();
        this._bindResize();
        this._paintSourcePill();
        this.refresh();
    }

    // ── Data-source pill ────────────────────────────────────────────────────

    _bindSourcePill() {
        const pill = this.el.sourcePill;
        if (!pill) return;
        // Two states: 'auto' (try backend, client-fallback) and
        // 'client' (force client surrogate, no network). The pill label
        // reflects whichever model actually answered.
        pill.addEventListener('click', () => {
            this.useBackend = !this.useBackend;
            this._paintSourcePill();
            this.refresh();
        });
    }

    _paintSourcePill() {
        const pill = this.el.sourcePill;
        if (!pill) return;
        const model = this.profile?.model || 'client';
        const { cls, label, tip } = _pillFor(model, this.useBackend);
        pill.className = `ua-source-pill ${cls}`
            + (this.useBackend ? '' : ' ua-source--forced');
        pill.querySelector('.ua-source-label').textContent = label;
        pill.title = tip;
    }

    // ── Live-indices wiring ─────────────────────────────────────────────────

    async _bindLiveButton() {
        const btn = this.el.liveBtn;
        const statusEl = this.el.liveStatus;
        if (!btn) return;
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            if (statusEl) statusEl.textContent = 'fetching…';
            try {
                const live = await fetchLiveIndices();
                if (!live) throw new Error('no data');
                this.setState({ f107: live.f107Sfu, ap: live.ap });
                if (statusEl) {
                    const ts = new Date().toLocaleTimeString([], {
                        hour: '2-digit', minute: '2-digit',
                    });
                    statusEl.textContent =
                        `live · ${live.source} · ${ts}`;
                }
                if (this.el.summary) {
                    this.el.summary.innerHTML =
                        `<strong>Live NOAA conditions</strong> <span class="ua-dim">· ${live.source}</span>`
                        + `<br>F10.7 ${live.f107Sfu.toFixed(1)} SFU · Ap ${live.ap.toFixed(0)}`
                        + (Number.isFinite(live.kp) ? ` (from Kp ${live.kp.toFixed(1)})` : '');
                }
            } catch (err) {
                if (statusEl) statusEl.textContent = 'unavailable — CORS or offline';
            } finally {
                btn.disabled = false;
            }
        });
    }

    _bindSwpcEventBus() {
        // If the host page boots SpaceWeatherFeed (e.g. the user also has
        // space-weather.html open in a parent frame), soak up values
        // passively to keep the source-chip honest. Does NOT override user
        // slider positions.
        window.addEventListener('swpc-update', (e) => {
            const d = e?.detail;
            if (!d) return;
            this._liveBusValues = {
                f107: d.solar_activity?.f107_sfu ?? null,
                kp:   d.geomagnetic?.kp ?? d.kp ?? null,
                bz:   d.solar_wind?.bz ?? d.bz ?? null,
            };
        });
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
     * Recompute profile + redraw everything. Safe to call any time;
     * slider-driven calls are debounced (_scheduleRefresh) so we don't
     * spam the backend while dragging.
     */
    refresh() {
        const { f107, ap, altitude } = this.state;

        // Update labels immediately (don't wait for the async fetch).
        if (this.el.altVal)  this.el.altVal.textContent  = `${Math.round(altitude)} km`;
        if (this.el.f107Val) this.el.f107Val.textContent = `${Math.round(f107)} SFU`;
        if (this.el.apVal)   this.el.apVal.textContent   = String(Math.round(ap));

        // Drive the globe state immediately (aurora, ring position).
        // If the host page is broadcasting live Bz via swpc-update, hand
        // it through so the aurora shader uses real southward-IMF forcing
        // instead of the Ap-derived proxy.
        const liveBz = this._liveBusValues?.bz;
        this.globe.setState({
            f107, ap,
            bz: Number.isFinite(liveBz) ? liveBz : null,
        });
        this.globe.setAltitude(altitude);

        // Local sample first — so the plots respond on every frame while
        // dragging. If a backend profile arrives later, we overwrite and
        // redraw once.
        const local = this.engine.sampleProfile({
            f107Sfu: f107, ap,
            minKm: ALT_MIN, maxKm: ALT_MAX, nPoints: 180,
        });
        this.profile = _annotateProfile(local);
        this.globe.setProfile(this.profile);
        this._drawDensityProfile();
        this._drawComposition();
        this._paintStats();
        this._paintSourcePill();

        if (this.useBackend) this._scheduleBackendRefresh();
    }

    _scheduleBackendRefresh() {
        clearTimeout(this._refreshTimer);
        this._refreshTimer = setTimeout(() => this._fetchAndMerge(), 220);
    }

    async _fetchAndMerge() {
        // Cancel an in-flight request if the user has moved on.
        this._refreshInflight?.abort?.();
        const controller = new AbortController();
        this._refreshInflight = controller;
        const { f107, ap } = this.state;
        try {
            const remote = await fetchProfile({
                f107Sfu: f107, ap,
                minKm: ALT_MIN, maxKm: ALT_MAX, nPoints: 160,
                signal: controller.signal,
            });
            // If the user has already changed state again since this
            // request started, drop the stale result.
            if (this.state.f107 !== f107 || this.state.ap !== ap) return;
            if (remote?.samples?.length) {
                this.profile = _annotateProfile(remote);
                this.globe.setProfile(this.profile);
                this._drawDensityProfile();
                this._drawComposition();
                this._paintStats();
                this._paintSourcePill();
            }
        } catch (_) {
            // fetchProfile already handled the fallback internally
        } finally {
            if (this._refreshInflight === controller) this._refreshInflight = null;
        }
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
        const pad = { l: 72, r: 14, t: 24, b: 36 };
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

        // ─── Atmospheric-layer bands (behind everything else) ────────────
        const layers = this.profile.layers || ATMOSPHERIC_LAYERS;
        for (const L of layers) {
            const top = Math.max(L.minKm, altMin);
            const bot = Math.min(L.maxKm, altMax);
            if (bot <= altMin || top >= altMax) continue;
            const yTop = yOf(bot);
            const yBot = yOf(top);
            ctx.fillStyle = _alpha(L.color, 0.10);
            ctx.fillRect(pad.l, yTop, plotW, yBot - yTop);
            // Thin dividing line at each boundary.
            ctx.strokeStyle = _alpha(L.color, 0.35);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(pad.l, yBot); ctx.lineTo(pad.l + plotW, yBot);
            ctx.stroke();

            // Layer label — vertical tick on the far-left gutter.
            const midY = (yTop + yBot) / 2;
            ctx.fillStyle = _alpha(L.color, 0.85);
            ctx.font = '10px system-ui, sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            if (yBot - yTop > 24) {
                ctx.fillText(L.name, pad.l - 8, midY);
            }
        }

        // ─── Altitude axis (grid + labels inside the plot area) ─────────
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.fillStyle = '#889';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let a = 0; a <= 2000; a += 500) {
            const y = yOf(a);
            if (y < pad.t - 1 || y > H - pad.b + 1) continue;
            ctx.beginPath();
            ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y);
            ctx.strokeStyle = 'rgba(255,255,255,0.06)';
            ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.fillText(`${a}`, W - pad.r - 2, y - 6);
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let lr = minLR; lr <= maxLR; lr++) {
            const x = xOf(lr);
            ctx.beginPath();
            ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b);
            ctx.strokeStyle = 'rgba(255,255,255,0.04)';
            ctx.stroke();
            ctx.fillStyle = '#889';
            ctx.fillText(`10^${lr}`, x, H - pad.b + 4);
        }

        // ─── Satellite reference ticks ──────────────────────────────────
        const sats = this.profile.satellites || SATELLITE_REFERENCES;
        ctx.font = '9px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        for (const S of sats) {
            if (S.altitudeKm < altMin || S.altitudeKm > altMax) continue;
            const y = yOf(S.altitudeKm);
            ctx.strokeStyle = S.color;
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.65;
            ctx.beginPath();
            ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + 8, y);
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.fillStyle = S.color;
            ctx.textAlign = 'left';
            ctx.fillText(`${S.name}`, pad.l + 11, y);
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
        const L   = layerAt(this.state.altitude);
        const src = this.profile?.model || "client";

        const domPct = (s.fractions[dom] * 100).toFixed(1);
        const mBarAmu = (s.mBar / 1.66054e-27).toFixed(2);

        box.innerHTML = `
          <div class="ua-stat">
              <span class="ua-stat-k">layer</span>
              <span class="ua-stat-v" style="color:${L?.color || '#cdf'}">${L?.name || '—'}</span>
              <span class="ua-stat-u" title="source model">${_sourceLabel(src)}</span>
          </div>
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

    // ── Layer legend (static, rendered once in constructor) ─────────────────

    _renderLayerLegend() {
        const el = this.el.layerLegend;
        if (!el) return;
        el.innerHTML = '';
        for (const L of ATMOSPHERIC_LAYERS) {
            const row = document.createElement('div');
            row.className = 'ua-layer-row';
            row.title = L.description;
            const range = L.maxKm > 1000 ? `${L.minKm}–${L.maxKm >= 10000 ? '∞' : L.maxKm} km` : `${L.minKm}–${L.maxKm} km`;
            row.innerHTML = `
                <span class="ua-layer-dot" style="background:${L.color}"></span>
                <span class="ua-layer-name">${L.name}</span>
                <span class="ua-layer-range">${range}</span>
            `;
            el.appendChild(row);
        }
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

function _annotateProfile(p) {
    if (!p) return p;
    return {
        ...p,
        layers:     p.layers     || ATMOSPHERIC_LAYERS,
        satellites: p.satellites || SATELLITE_REFERENCES,
    };
}

function _alpha(cssColor, a) {
    // Accepts "#rgb", "#rrggbb", or "rgb(...)" / "rgba(...)".
    if (!cssColor) return `rgba(255,255,255,${a})`;
    if (cssColor.startsWith('#')) {
        let r, g, b;
        if (cssColor.length === 4) {
            r = parseInt(cssColor[1] + cssColor[1], 16);
            g = parseInt(cssColor[2] + cssColor[2], 16);
            b = parseInt(cssColor[3] + cssColor[3], 16);
        } else {
            r = parseInt(cssColor.slice(1, 3), 16);
            g = parseInt(cssColor.slice(3, 5), 16);
            b = parseInt(cssColor.slice(5, 7), 16);
        }
        return `rgba(${r},${g},${b},${a})`;
    }
    return cssColor;   // leave anything else untouched
}

function _sourceLabel(model) {
    if (!model) return 'client';
    if (model === 'SPARTA-lookup')    return 'SPARTA';
    if (model === 'SPARTA-bootstrap') return 'SPARTA·boot';
    if (model === 'NRLMSISE-00')      return 'MSIS';
    if (model === 'exp-fallback')     return 'fallback';
    if (model === 'client-fallback')  return 'client*';
    if (model === 'client')           return 'client';
    return model;
}

/**
 * Map a model string + mode to a pill class / label / tooltip.
 *   cls      CSS class (ua-source--{client,fallback,backend,sparta})
 *   label    short user-visible text
 *   tip      hover tooltip
 */
function _pillFor(model, useBackend) {
    const mode = useBackend ? 'Auto' : 'Client only';
    switch (model) {
        case 'SPARTA-lookup':
            return {
                cls: 'ua-source--sparta',
                label: `SPARTA · ${mode}`,
                tip: 'Backend answered from a precomputed SPARTA DSMC lookup table. Highest-fidelity source. Click to toggle Auto / Client-only.',
            };
        case 'SPARTA-bootstrap':
            return {
                cls: 'ua-source--bootstrap',
                label: `SPARTA·boot · ${mode}`,
                tip: 'Backend served an MSIS-seeded bootstrap table (grid is populated but rows have not yet been refined by a SPARTA run). Click to toggle.',
            };
        case 'NRLMSISE-00':
            return {
                cls: 'ua-source--backend',
                label: `MSIS · ${mode}`,
                tip: 'Backend answered from NRLMSISE-00. SPARTA tables not yet populated. Click to toggle Auto / Client-only.',
            };
        case 'exp-fallback':
            return {
                cls: 'ua-source--fallback',
                label: `Backend fallback · ${mode}`,
                tip: 'Backend is alive but NRLMSISE-00 and SPARTA both unavailable; server is on its exponential fallback. Click to toggle.',
            };
        case 'client-fallback':
            return {
                cls: 'ua-source--fallback',
                label: `Client fallback · ${mode}`,
                tip: 'Backend unreachable; page is running its in-browser surrogate. Click to toggle.',
            };
        default:
            return {
                cls: 'ua-source--client',
                label: `Client · ${mode}`,
                tip: useBackend
                    ? 'In-browser surrogate (no backend reachable or configured yet). Click to toggle.'
                    : 'In-browser surrogate — backend calls disabled. Click to re-enable Auto mode.',
            };
    }
}
