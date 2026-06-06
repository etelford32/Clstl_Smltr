/**
 * upper-atmosphere-zone-dashboard.js — live per-zone drag + turbulence panel
 * ═══════════════════════════════════════════════════════════════════════════
 * The operator-facing answer to "what is the drag environment of each
 * atmospheric zone right now, and how turbulent (variable) is it?". One
 * row per zone (Mesosphere → Outer Exosphere), each showing:
 *
 *   ρ          live mass density            (kg/m³)
 *   q          dynamic / ram pressure       (Pa)
 *   decay      circular-orbit altitude rate (km/day) for the reference body
 *   regime     rarefied-flow class badge
 *   turbulence index bar + state badge      (storm-driven + gravity-wave)
 *   sparkline  ρ over the last 72 h from the realtime ring
 *
 * It owns two small controls: the reference ballistic term Cd·A/m (so the
 * decay column maps onto the operator's own asset) and a master toggle
 * for the globe's turbulence wave-field overlay.
 *
 * Data flow:
 *   • getLiveState()  → { f107, ap }   current fused forcing (from the UI)
 *   • getHistory()    → realtime 72-h ring (for sparklines + Ap volatility)
 *   • onTurbulence(zi) → pushed every refresh so the globe's ZoneWaveField
 *                        ripple amplitudes track the live index
 *   • onWaveFieldToggle(bool) → master switch for the overlay
 *
 * Subscribes to the realtime driver's events so it stays live without its
 * own timer:
 *   'ua-realtime-tick'    → recompute drag + turbulence text (throttled 1 Hz)
 *   'ua-realtime-history' → redraw sparklines
 *
 * Hand-rolled canvas 2-D sparklines (matches the density/composition
 * plots); no charting library, consistent with the rest of the page.
 */

import { ATMOSPHERIC_LAYER_SCHEMA } from './upper-atmosphere-layers.js';
import { density } from './upper-atmosphere-engine.js';
import { computeZoneDrag, DEFAULT_BC_M2_PER_KG } from './upper-atmosphere-zone-drag.js';
import { computeZoneTurbulence } from './upper-atmosphere-turbulence.js';

// Don't recompute the (cheap but not free) per-zone drag + turbulence on
// every 10 Hz realtime tick — once a second is plenty for a readout.
const LIVE_THROTTLE_MS = 900;

// Sparkline resolution: downsample the (up to ~8640-sample) 72-h ring to
// this many points before re-evaluating density per zone.
const SPARK_POINTS = 64;

function _hex(int) {
    return `#${(int >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
}

export class ZoneDashboard {
    /**
     * @param {object} opts
     * @param {HTMLElement} opts.host
     * @param {function} opts.getLiveState        () => ({ f107, ap })
     * @param {function} [opts.getHistory]        () => Array (realtime ring)
     * @param {function} [opts.onTurbulence]      (ziArray) => void
     * @param {function} [opts.onWaveFieldToggle] (bool) => void
     */
    constructor({ host, getLiveState, getHistory, onTurbulence, onWaveFieldToggle }) {
        this.host = host;
        this.getLiveState = getLiveState || (() => ({ f107: 150, ap: 15 }));
        this.getHistory = getHistory || (() => []);
        this.onTurbulence = onTurbulence || (() => {});
        this.onWaveFieldToggle = onWaveFieldToggle || (() => {});

        this._bc = DEFAULT_BC_M2_PER_KG;
        this._lastLiveMs = 0;
        this._running = false;
        this._rowEls = {};      // zoneId → { row, fields, sparkCanvas }

        this._onTick = this._onTick.bind(this);
        this._onHistory = this._onHistory.bind(this);

        this._build();
    }

    // ── DOM ──────────────────────────────────────────────────────────────
    _build() {
        this.host.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'ua-zd';

        // Controls: reference ballistic term + wave-field master toggle.
        const controls = document.createElement('div');
        controls.className = 'ua-zd-controls';
        controls.innerHTML = `
            <label class="ua-zd-ctl" title="Reference ballistic term Cd·A/m used for the decay column. Default ≈ a 3U-CubeSat tumbler.">
                <span>Drag body Cd·A/m</span>
                <input class="ua-zd-bc" type="number" min="0.001" max="2" step="0.001"
                       value="${this._bc}"> m²/kg
            </label>
            <label class="ua-zd-ctl ua-zd-ctl--wave" title="Render the per-zone turbulence as an animated ripple on the globe's shells.">
                <input class="ua-zd-wave" type="checkbox">
                <span>Turbulence wave field</span>
            </label>
        `;
        root.appendChild(controls);

        const rows = document.createElement('div');
        rows.className = 'ua-zd-rows';
        for (const L of ATMOSPHERIC_LAYER_SCHEMA) {
            const low  = _hex(L.colorLow);
            const high = _hex(L.colorHigh);
            const row = document.createElement('div');
            row.className = 'ua-zd-row';
            row.dataset.zoneId = L.id;
            row.title = L.description;
            row.innerHTML = `
                <div class="ua-zd-head">
                    <span class="ua-zd-swatch"
                          style="background:linear-gradient(45deg,${low},${high});
                                 box-shadow:0 0 8px ${high}88"></span>
                    <span class="ua-zd-title">
                        <span class="ua-zd-name">${L.name}</span>
                        <span class="ua-zd-band">${L.minKm}–${L.maxKm} km</span>
                    </span>
                    <span class="ua-zd-regime" data-f="regime">–</span>
                </div>
                <div class="ua-zd-metrics">
                    <span class="ua-zd-metric">
                        <b class="ua-zd-v" data-f="rho">–</b><i>ρ kg/m³</i>
                    </span>
                    <span class="ua-zd-metric">
                        <b class="ua-zd-v" data-f="q">–</b><i>q Pa</i>
                    </span>
                    <span class="ua-zd-metric">
                        <b class="ua-zd-v" data-f="decay">–</b><i>decay km/day</i>
                    </span>
                </div>
                <div class="ua-zd-ti">
                    <div class="ua-zd-ti-bar">
                        <div class="ua-zd-ti-fill" data-f="tifill"
                             style="background:${high}"></div>
                    </div>
                    <span class="ua-zd-ti-badge" data-f="tibadge">–</span>
                    <span class="ua-zd-ti-pct" data-f="tipct">–</span>
                </div>
                <canvas class="ua-zd-spark" data-f="spark"></canvas>
            `;
            rows.appendChild(row);

            const fields = {};
            row.querySelectorAll('[data-f]').forEach(el => { fields[el.dataset.f] = el; });
            this._rowEls[L.id] = { row, fields, sparkCanvas: fields.spark };
        }
        root.appendChild(rows);

        const foot = document.createElement('div');
        foot.className = 'ua-zd-foot';
        foot.innerHTML = `
            Turbulence = storm-driven density variability (δρ/ρ) + gravity-wave residual.
            Decay shown for the reference body above; ρ &amp; q are intrinsic to the zone.
        `;
        root.appendChild(foot);

        this.host.appendChild(root);

        // Wire controls.
        const bcInput = controls.querySelector('.ua-zd-bc');
        bcInput?.addEventListener('change', () => {
            const v = parseFloat(bcInput.value);
            if (Number.isFinite(v) && v > 0) {
                this._bc = v;
                this._refreshLive(true);
            }
        });
        const waveCb = controls.querySelector('.ua-zd-wave');
        waveCb?.addEventListener('change', () => {
            this.onWaveFieldToggle(!!waveCb.checked);
        });

        // Redraw sparklines on container resize (tab switches change width).
        this._resizeObs = new ResizeObserver(() => this._refreshSparklines());
        this._resizeObs.observe(rows);
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────
    start() {
        if (this._running) return;
        this._running = true;
        window.addEventListener('ua-realtime-tick', this._onTick);
        window.addEventListener('ua-realtime-history', this._onHistory);
        // First paint immediately so the panel isn't blank pre-first-tick.
        this._refreshLive(true);
        this._refreshSparklines();
    }

    stop() {
        if (!this._running) return;
        this._running = false;
        window.removeEventListener('ua-realtime-tick', this._onTick);
        window.removeEventListener('ua-realtime-history', this._onHistory);
        this._resizeObs?.disconnect();
    }

    // ── Event handlers ──────────────────────────────────────────────────────
    _onTick() {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (now - this._lastLiveMs < LIVE_THROTTLE_MS) return;
        this._lastLiveMs = now;
        this._refreshLive(false);
    }

    _onHistory() {
        this._refreshSparklines();
    }

    // ── Live readout ─────────────────────────────────────────────────────────
    _refreshLive() {
        const st = this.getLiveState() || {};
        const f107 = Number.isFinite(st.f107) ? st.f107 : 150;
        const ap   = Number.isFinite(st.ap)   ? st.ap   : 15;
        const history = this.getHistory() || [];

        const drag = computeZoneDrag({ f107, ap, bc: this._bc });
        const turb = computeZoneTurbulence({ f107, ap, history, nowMs: Date.now() });
        const turbById = Object.fromEntries(turb.map(t => [t.zoneId, t]));

        for (const d of drag) {
            const r = this._rowEls[d.zoneId];
            if (!r) continue;
            const t = turbById[d.zoneId];
            const set = (k, v) => { if (r.fields[k]) r.fields[k].textContent = v; };

            set('rho',   d.rho.toExponential(2));
            set('q',     d.q.toExponential(2));
            set('decay', _fmtDecay(d.decayKmPerDay));
            set('regime', d.regime);
            const regimeEl = r.fields.regime;
            if (regimeEl) regimeEl.className = `ua-zd-regime ua-zd-regime--${d.regime}`;

            if (t) {
                const fill = r.fields.tifill;
                if (fill) fill.style.width = `${Math.round(t.ti * 100)}%`;
                const badge = r.fields.tibadge;
                if (badge) {
                    badge.textContent = t.state;
                    badge.className = `ua-zd-ti-badge ua-zd-ti-badge--${t.state}`;
                }
                set('tipct', `${t.deltaRhoFracPct < 0.05 ? '0' : t.deltaRhoFracPct.toFixed(1)}% δρ`);
            }
        }

        // Feed the globe's wave-field overlay.
        this.onTurbulence(turb);
    }

    // ── Sparklines ───────────────────────────────────────────────────────────
    _refreshSparklines() {
        const history = this.getHistory() || [];
        if (!history.length) return;

        // Downsample the ring to SPARK_POINTS evenly-spaced samples.
        const step = Math.max(1, Math.floor(history.length / SPARK_POINTS));
        const picks = [];
        for (let i = 0; i < history.length; i += step) picks.push(history[i]);
        if (picks[picks.length - 1] !== history[history.length - 1]) {
            picks.push(history[history.length - 1]);
        }

        for (const L of ATMOSPHERIC_LAYER_SCHEMA) {
            const r = this._rowEls[L.id];
            if (!r?.sparkCanvas) continue;
            const peakKm = Number.isFinite(L.peakKm)
                ? L.peakKm : (L.minKm + L.maxKm) / 2;
            const series = [];
            for (const h of picks) {
                const f107 = Number.isFinite(h.f107) ? h.f107 : 150;
                const ap   = Number.isFinite(h.ap) ? h.ap : (h.apProxy ?? 15);
                let rho = NaN;
                try { rho = density({ altitudeKm: peakKm, f107Sfu: f107, ap }).rho; }
                catch (_) { /* skip */ }
                series.push(rho > 0 ? Math.log10(rho) : NaN);
            }
            _drawSparkline(r.sparkCanvas, series, _hex(L.colorHigh));
        }
    }
}

// ── helpers ──────────────────────────────────────────────────────────────

function _fmtDecay(kmPerDay) {
    if (!Number.isFinite(kmPerDay)) return '–';
    const v = Math.abs(kmPerDay);
    if (v < 1e-4) return v.toExponential(1);
    if (v < 1)    return v.toFixed(3);
    if (v < 100)  return v.toFixed(2);
    return Math.round(v).toString();
}

function _drawSparkline(canvas, series, color) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 160;
    const h = canvas.clientHeight || 28;
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.max(1, Math.floor(w * dpr));
        canvas.height = Math.max(1, Math.floor(h * dpr));
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const clean = series.filter(Number.isFinite);
    if (clean.length < 2) return;
    let min = Infinity, max = -Infinity;
    for (const v of clean) { if (v < min) min = v; if (v > max) max = v; }
    const span = Math.max(max - min, 1e-9);

    const pad = 2;
    const x = (i) => pad + (w - 2 * pad) * (i / (series.length - 1));
    const y = (v) => (h - pad) - (h - 2 * pad) * ((v - min) / span);

    // Filled area under the curve for a denser read.
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < series.length; i++) {
        const v = series[i];
        if (!Number.isFinite(v)) { started = false; continue; }
        if (!started) { ctx.moveTo(x(i), y(v)); started = true; }
        else ctx.lineTo(x(i), y(v));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Latest-value dot.
    for (let i = series.length - 1; i >= 0; i--) {
        if (Number.isFinite(series[i])) {
            ctx.beginPath();
            ctx.arc(x(i), y(series[i]), 1.8, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            break;
        }
    }
}
