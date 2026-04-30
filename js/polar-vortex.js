/**
 * polar-vortex.js — Stratospheric polar vortex card for space-weather.html
 * ═══════════════════════════════════════════════════════════════════════════
 * Fetches /api/weather/polar-vortex (GFS-backed proxy) and paints the
 * card it powers in space-weather.html. Single class, zero dependencies.
 *
 * The vortex card is the strongest available terrestrial-weather signal
 * the dashboard surfaces:
 *
 *   strong vortex     → cold air locked over Arctic, mid-latitudes shielded
 *   weakening / disturbed → 10-21 day lead on US/EU cold-air outbreaks
 *   SSW (zonal-wind reversal at 10 hPa) → high-confidence cold-snap precursor
 *
 * The 14-day canvas plot shows U_60N at 10 hPa over today→+13d so users
 * can see the forecast trend at a glance.
 *
 * Usage (called from space-weather.html boot script):
 *   import { PolarVortexCard } from './js/polar-vortex.js';
 *   const card = new PolarVortexCard({ apiPath: '/api/weather/polar-vortex' });
 *   card.start();
 */

const STATE_COLORS = {
    strong:     '#5cd9ff',
    moderate:   '#88e08c',
    weakening:  '#ffcc66',
    disturbed:  '#ff9060',
    ssw:        '#ff5577',
    unknown:    '#778',
};

const RISK_BADGE_CLASS = {
    low:      'badge-minor',
    elevated: 'badge-moderate',
    high:     'badge-severe',
    unknown:  'badge-minor',
};

const REFRESH_MS = 60 * 60 * 1000;   // 1 h client-side; proxy caches 6 h

export class PolarVortexCard {
    /**
     * @param {object} opts
     * @param {string} [opts.apiPath='/api/weather/polar-vortex']
     * @param {string} [opts.cardId='vortex-card']  — host element id
     * @param {boolean}[opts.autoRefresh=true]
     */
    constructor(opts = {}) {
        this.apiPath     = opts.apiPath ?? '/api/weather/polar-vortex';
        this.cardId      = opts.cardId  ?? 'vortex-card';
        this.autoRefresh = opts.autoRefresh ?? true;
        this._timer      = null;
        this._abort      = null;
    }

    start() {
        this.refresh();
        if (this.autoRefresh) {
            this._timer = setInterval(() => this.refresh(), REFRESH_MS);
        }
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
        this._abort?.abort();
    }

    async refresh() {
        // Cancel any in-flight refresh — only the latest matters.
        this._abort?.abort();
        const ctl = new AbortController();
        this._abort = ctl;

        try {
            const res = await fetch(this.apiPath, {
                signal: ctl.signal,
                headers: { Accept: 'application/json' },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            if (this._abort !== ctl) return;       // superseded
            this._render(body);
        } catch (err) {
            if (err.name === 'AbortError') return;
            this._renderError(err);
        }
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    _render(d) {
        const cls    = d.classification ?? {};
        const cur    = d.current ?? {};
        const fcst7  = d.forecast_d7 ?? {};
        const daily  = d.daily ?? {};
        const colour = STATE_COLORS[cls.state] || STATE_COLORS.unknown;

        this._setText('vortex-state', cls.label || '—', colour);
        this._setText('vortex-u10',  fmtUnit(cur.U_10hPa, 'm/s'));
        this._setText('vortex-u30',  fmtUnit(cur.U_30hPa, 'm/s'));
        this._setText('vortex-t10',  fmtTemp(cur.T_10hPa));
        this._setText('vortex-d7',   fmtUnit(fcst7.U_10hPa, 'm/s'));

        // Risk badge.
        const riskEl = document.getElementById('vortex-risk');
        if (riskEl) {
            const badge = RISK_BADGE_CLASS[cls.risk] || 'badge-minor';
            riskEl.className = `cme-card-badge ${badge}`;
            riskEl.textContent = (cls.risk || '—').toUpperCase();
        }

        const summaryEl = document.getElementById('vortex-summary');
        if (summaryEl) summaryEl.textContent = cls.detail || '';

        const srcEl = document.getElementById('src-vortex');
        if (srcEl && d.age_min != null) {
            srcEl.title = `${d.source} · age ${d.age_min} min`;
        }

        this._drawTimeseries(daily);
    }

    _renderError(err) {
        const stateEl = document.getElementById('vortex-state');
        if (stateEl) {
            stateEl.textContent = 'Unavailable';
            stateEl.style.color = STATE_COLORS.unknown;
        }
        const sumEl = document.getElementById('vortex-summary');
        if (sumEl) sumEl.textContent = `Vortex feed unavailable (${err.message}). Retrying in 1 h.`;
    }

    // ── 14-day timeseries on a canvas ───────────────────────────────────────

    _drawTimeseries(daily) {
        const canvas = document.getElementById('vortex-mini-plot');
        if (!canvas) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
            canvas.width  = Math.floor(w * dpr);
            canvas.height = Math.floor(h * dpr);
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const u10 = (daily?.['10']?.U) || [];
        const time = (daily?.time) || [];
        if (u10.length < 2) return;

        // Canonical reference bands: SSW (U<0), disturbed (0..10),
        // moderate (10..20), strong (>20).
        const minU = Math.min(-5, ...u10.filter(Number.isFinite));
        const maxU = Math.max(40, ...u10.filter(Number.isFinite));
        const span = maxU - minU || 1;

        const padL = 6, padR = 6, padT = 12, padB = 14;
        const plotW = w - padL - padR;
        const plotH = h - padT - padB;

        const xOf = (i) => padL + (i / (u10.length - 1)) * plotW;
        const yOf = (u) => padT + (1 - (u - minU) / span) * plotH;

        // Background reference bands.
        const bands = [
            { lo: -200, hi: 0,    fill: 'rgba(255,85,119,.10)'  },  // SSW
            { lo: 0,    hi: 10,   fill: 'rgba(255,144,96,.08)'  },  // disturbed
            { lo: 10,   hi: 20,   fill: 'rgba(255,204,102,.05)' },  // moderate
            { lo: 20,   hi: 200,  fill: 'rgba(92,217,255,.05)'  },  // strong
        ];
        for (const b of bands) {
            const yHi = yOf(Math.min(b.hi, maxU));
            const yLo = yOf(Math.max(b.lo, minU));
            if (yLo <= yHi) continue;
            ctx.fillStyle = b.fill;
            ctx.fillRect(padL, yHi, plotW, yLo - yHi);
        }

        // Zero-line — the SSW threshold.
        const y0 = yOf(0);
        ctx.strokeStyle = 'rgba(255,85,119,.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(padL, y0);
        ctx.lineTo(w - padR, y0);
        ctx.stroke();
        ctx.setLineDash([]);

        // U_10 curve.
        ctx.strokeStyle = '#5cd9ff';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < u10.length; i++) {
            if (!Number.isFinite(u10[i])) continue;
            const x = xOf(i), y = yOf(u10[i]);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // "Today" tick.
        const xToday = xOf(0);
        ctx.strokeStyle = 'rgba(255,255,255,.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xToday, padT);
        ctx.lineTo(xToday, h - padB);
        ctx.stroke();

        // Title + axis labels.
        ctx.fillStyle = '#cdf';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('U₆₀ⁿ @ 10 hPa  (m/s, 14d forecast)', padL, 1);

        ctx.fillStyle = '#556';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText('today', padL + 2, h - 1);
        if (time.length) {
            ctx.textAlign = 'right';
            ctx.fillText(time[time.length - 1].slice(5), w - padR, h - 1);
        }

        // Y-axis ticks.
        ctx.fillStyle = '#778';
        ctx.font = '9px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const u of [0, 20, 40]) {
            if (u < minU || u > maxU) continue;
            const y = yOf(u);
            ctx.fillText(`${u}`, padL + plotW - 1, y);
        }
    }

    _setText(id, text, color) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = text;
        if (color) el.style.color = color;
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtUnit(v, unit) {
    if (!Number.isFinite(v)) return '–';
    return `${v >= 0 ? '+' : ''}${v.toFixed(1)} ${unit}`;
}

function fmtTemp(K) {
    if (!Number.isFinite(K)) return '–';
    const C = K - 273.15;
    return `${K.toFixed(1)} K (${C.toFixed(1)} °C)`;
}
