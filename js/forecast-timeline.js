/**
 * forecast-timeline.js
 *
 * Renders the Forecast Timeline panel: AR(p) Kp trajectory with 80% PI
 * ribbon, persistence-baseline overlay, NOAA SWPC 3-day reference points,
 * per-horizon impact table, and a model-validation mini-card.
 *
 * Custom canvas rendering (no chart library) to match the site's vanilla-
 * canvas aesthetic and avoid a new dependency.
 *
 * Consumes:
 *   - 'earth-forecast-update'       (for forecast_timeline payload)
 *   - 'forecast-validation-update'  (for skill metrics)
 *
 * Expected DOM IDs (present in space-weather.html):
 *   #forecast-timeline-canvas       <canvas>
 *   #ft-horizons-grid               container for per-horizon impact table
 *   #ft-legend                      <div> for chart legend
 *   #ft-swpc-status                 <span> for SWPC freshness
 *   #ft-validation-arp-mae          <span>
 *   #ft-validation-persist-mae      <span>
 *   #ft-validation-skill            <span>
 *   #ft-validation-n                <span>
 */

const HORIZON_LABELS = [12, 24, 48, 72];

// Kp → G-scale threshold lines on the chart
const G_THRESHOLDS = [
    { kp: 5, g: 1, color: 'rgba(255,204,0,.18)',  label: 'G1' },
    { kp: 6, g: 2, color: 'rgba(255,153,0,.22)',  label: 'G2' },
    { kp: 7, g: 3, color: 'rgba(255,85,0,.22)',   label: 'G3' },
    { kp: 8, g: 4, color: 'rgba(255,34,85,.22)',  label: 'G4' },
    { kp: 9, g: 5, color: 'rgba(255,0,170,.22)',  label: 'G5' },
];

const C_ARP_LINE    = '#00c6ff';
const C_ARP_BAND    = 'rgba(0,198,255,.18)';
const C_PERSIST     = 'rgba(170,180,200,.85)';
const C_PERSIST_FILL= 'rgba(170,180,200,.10)';
const C_SWPC        = '#ffcc00';
const C_AXIS        = '#556';
const C_TEXT        = '#99b';
const C_GRID        = 'rgba(255,255,255,.05)';

// ── Helpers ─────────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function fmtKp(v) {
    if (!Number.isFinite(v)) return '–';
    return v.toFixed(1);
}

function fmtBand(mean, lo, hi) {
    if (!Number.isFinite(mean)) return '–';
    return `${mean.toFixed(1)} [${lo.toFixed(1)}–${hi.toFixed(1)}]`;
}

function gColor(g) {
    return ['#44cc88','#ffcc00','#ff9900','#ff5500','#ff2255','#ff00aa'][g] ?? '#667';
}

function gnssColor(level) {
    return ['#44cc88','#ffcc00','#ff9900','#ff2255'][level] ?? '#667';
}

function gnssLabel(level) {
    return ['Low','Moderate','High','Severe'][level] ?? '?';
}

// ── Canvas renderer ─────────────────────────────────────────────────────────

class TimelineChart {
    constructor(canvas) {
        this._canvas = canvas;
        this._ctx    = canvas.getContext('2d');
        this._dpr    = Math.max(1, window.devicePixelRatio || 1);

        // Padding for axis labels (in CSS pixels)
        this._pad = { l: 36, r: 14, t: 10, b: 22 };

        // Last payload for resize redraws
        this._last = null;

        window.addEventListener('resize', () => this._fitDpr());
        this._fitDpr();
    }

    _fitDpr() {
        const c = this._canvas;
        const rect = c.getBoundingClientRect();
        const w = Math.max(300, Math.floor(rect.width));
        const h = Math.max(160, Math.floor(rect.height || 200));
        c.width  = Math.floor(w * this._dpr);
        c.height = Math.floor(h * this._dpr);
        c.style.width  = w + 'px';
        c.style.height = h + 'px';
        this._cssW = w;
        this._cssH = h;
        this._ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
        if (this._last) this.draw(this._last);
    }

    /**
     * Draw the chart.
     * @param {object} payload  forecast_timeline from EarthForecastEngine
     */
    draw(payload) {
        this._last = payload;
        const ctx = this._ctx;
        const W = this._cssW;
        const H = this._cssH;
        const { l, r, t, b } = this._pad;
        const plotW = W - l - r;
        const plotH = H - t - b;

        const traj = payload?.trajectory;
        if (!traj || !Array.isArray(traj.arp?.mean)) {
            ctx.clearRect(0, 0, W, H);
            ctx.fillStyle = C_TEXT;
            ctx.font = '11px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Awaiting forecast data…', W / 2, H / 2);
            return;
        }

        const nSteps = traj.h_steps;    // 72
        // Time axis: t=0 (now) at left, t=72h at right
        const xForHour = (th) => l + (th / nSteps) * plotW;
        // Kp axis: 0 at bottom, 9 at top
        const yForKp   = (k)  => t + plotH * (1 - k / 9);

        // ── Background ─────────────────────────────────────────────────────
        ctx.clearRect(0, 0, W, H);

        // G-scale threshold bands (fill)
        for (const g of G_THRESHOLDS) {
            const yBottom = yForKp(g.kp);
            const yTop    = yForKp(Math.min(9, g.kp + 1));
            ctx.fillStyle = g.color;
            ctx.fillRect(l, yTop, plotW, yBottom - yTop);
        }

        // Gridlines: horizontal every Kp=2, vertical at 12/24/48/72
        ctx.strokeStyle = C_GRID;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let k = 2; k <= 8; k += 2) {
            const y = yForKp(k);
            ctx.moveTo(l, y); ctx.lineTo(l + plotW, y);
        }
        for (const hh of HORIZON_LABELS) {
            const x = xForHour(hh);
            ctx.moveTo(x, t); ctx.lineTo(x, t + plotH);
        }
        ctx.stroke();

        // ── Persistence band (drawn first, behind AR(p)) ───────────────────
        ctx.fillStyle = C_PERSIST_FILL;
        ctx.beginPath();
        const persLo = traj.persistence.lo80;
        const persHi = traj.persistence.hi80;
        for (let j = 0; j < nSteps; j++) {
            const x = xForHour(j + 1);
            const y = yForKp(persHi[j]);
            j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        for (let j = nSteps - 1; j >= 0; j--) {
            ctx.lineTo(xForHour(j + 1), yForKp(persLo[j]));
        }
        ctx.closePath();
        ctx.fill();

        // Persistence median (dashed)
        ctx.strokeStyle = C_PERSIST;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        for (let j = 0; j < nSteps; j++) {
            const x = xForHour(j + 1);
            const y = yForKp(traj.persistence.mean[j]);
            j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // ── AR(p) 80% band ──────────────────────────────────────────────────
        ctx.fillStyle = C_ARP_BAND;
        ctx.beginPath();
        const arpLo = traj.arp.lo80;
        const arpHi = traj.arp.hi80;
        for (let j = 0; j < nSteps; j++) {
            const x = xForHour(j + 1);
            const y = yForKp(arpHi[j]);
            j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        for (let j = nSteps - 1; j >= 0; j--) {
            ctx.lineTo(xForHour(j + 1), yForKp(arpLo[j]));
        }
        ctx.closePath();
        ctx.fill();

        // AR(p) median
        ctx.strokeStyle = C_ARP_LINE;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let j = 0; j < nSteps; j++) {
            const x = xForHour(j + 1);
            const y = yForKp(traj.arp.mean[j]);
            j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();

        // ── SWPC points ─────────────────────────────────────────────────────
        const swpc = traj.swpc?.points ?? [];
        ctx.fillStyle = C_SWPC;
        ctx.strokeStyle = '#332900';
        ctx.lineWidth = 1;
        for (const p of swpc) {
            if (p.t_hours > nSteps) continue;
            const x = xForHour(p.t_hours);
            const y = yForKp(p.kp);
            // Diamond marker
            ctx.beginPath();
            ctx.moveTo(x, y - 4);
            ctx.lineTo(x + 4, y);
            ctx.lineTo(x, y + 4);
            ctx.lineTo(x - 4, y);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }

        // ── Axes ────────────────────────────────────────────────────────────
        ctx.strokeStyle = C_AXIS;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(l, t); ctx.lineTo(l, t + plotH);
        ctx.moveTo(l, t + plotH); ctx.lineTo(l + plotW, t + plotH);
        ctx.stroke();

        // Y-axis labels (Kp values)
        ctx.fillStyle = C_TEXT;
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const k of [0, 2, 4, 6, 8]) {
            ctx.fillText(`Kp ${k}`, l - 4, yForKp(k));
        }

        // X-axis labels (horizons)
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('now', l, t + plotH + 3);
        for (const hh of HORIZON_LABELS) {
            ctx.fillText(`+${hh}h`, xForHour(hh), t + plotH + 3);
        }

        // G-scale right-edge labels
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = '9px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(170,170,180,.55)';
        for (const g of G_THRESHOLDS) {
            if (g.kp > 8.5) continue;
            ctx.fillText(g.label, l + plotW + 2, yForKp(g.kp + 0.5));
        }
    }
}

// ── Per-horizon impact table renderer ───────────────────────────────────────

function renderHorizonGrid(container, payload) {
    if (!container || !payload?.horizons) return;

    const rows = [
        {
            key: 'kp',
            label: 'Kp (AR-p, 80% PI)',
            cell: h => `<span class="ft-val">${h.kp_mean.toFixed(1)}</span>`
                    + `<span class="ft-band">[${h.kp_lo80.toFixed(1)}–${h.kp_hi80.toFixed(1)}]</span>`,
        },
        {
            key: 'g',
            label: 'G-scale',
            cell: h => {
                const range = h.g_lo === h.g_hi
                    ? `G${h.g_mean}`
                    : `G${h.g_lo}–G${h.g_hi}`;
                return `<span class="ft-chip" style="color:${gColor(h.g_mean)};border-color:${gColor(h.g_mean)}40;background:${gColor(h.g_mean)}14">${range}</span>`;
            },
        },
        {
            key: 'aurora',
            label: 'Aurora boundary',
            cell: h => `<span class="ft-val">${h.aurora_boundary_deg}°</span> geomag`,
        },
        {
            key: 'gnss',
            label: 'GNSS risk',
            cell: h => `<span class="ft-chip" style="color:${gnssColor(h.gnss_level)};border-color:${gnssColor(h.gnss_level)}40;background:${gnssColor(h.gnss_level)}14">${gnssLabel(h.gnss_level)}</span>`,
        },
        {
            key: 'persist',
            label: 'Persistence (null)',
            cell: h => `<span class="ft-muted">${fmtBand(h.persistence_kp, h.persistence_lo80, h.persistence_hi80)}</span>`,
        },
        {
            key: 'swpc',
            label: 'NOAA SWPC 3-day',
            cell: h => {
                if (h.swpc_kp == null) return '<span class="ft-muted">–</span>';
                const sign = h.agreement === 'agree'
                    ? '<span style="color:#44cc88" title="Within AR(p) 80% PI">✓</span>'
                    : h.agreement === 'diverge'
                        ? '<span style="color:#ff9900" title="Outside AR(p) 80% PI">⚠</span>'
                        : '';
                return `<span class="ft-val" style="color:${C_SWPC}">Kp ${h.swpc_kp.toFixed(1)}</span> ${sign}`;
            },
        },
    ];

    // Build an HTML table: one column per horizon + one leading label column.
    const headerCells = ['<th></th>']
        .concat(payload.horizons.map(h => `<th>t+${h.horizon_h}h</th>`))
        .join('');

    const bodyRows = rows.map(row => {
        const cells = payload.horizons.map(h => `<td>${row.cell(h)}</td>`).join('');
        return `<tr><th>${row.label}</th>${cells}</tr>`;
    }).join('');

    container.innerHTML = `
        <table class="ft-grid-table">
            <thead><tr>${headerCells}</tr></thead>
            <tbody>${bodyRows}</tbody>
        </table>
    `;
}

// ── Legend + status row ─────────────────────────────────────────────────────

function renderLegend(container, payload) {
    if (!container) return;
    const swpcN = payload?.trajectory?.swpc?.points?.length ?? 0;
    container.innerHTML = `
        <span class="ft-legend-item"><span class="ft-swatch" style="background:${C_ARP_LINE}"></span>AR(p) median</span>
        <span class="ft-legend-item"><span class="ft-swatch" style="background:${C_ARP_BAND};border:1px solid ${C_ARP_LINE}"></span>AR(p) 80% PI</span>
        <span class="ft-legend-item"><span class="ft-swatch ft-dashed" style="background:${C_PERSIST}"></span>Persistence</span>
        <span class="ft-legend-item"><span class="ft-swatch ft-diamond" style="background:${C_SWPC}"></span>SWPC 3-day (${swpcN} pts)</span>
    `;
}

function renderSwpcStatus(span, payload) {
    if (!span) return;
    const pts = payload?.trajectory?.swpc?.points ?? [];
    if (pts.length === 0) {
        span.textContent = 'SWPC 3-day: unavailable';
        span.style.color = '#667';
        return;
    }
    span.textContent = `SWPC 3-day: ${pts.length} bins across next 72h`;
    span.style.color = '#99b';
}

// ── Validation mini-card ────────────────────────────────────────────────────

function renderValidation(summary) {
    if (!summary?.by_horizon) return;

    // Surface the t+24h scorecard (most interpretable horizon for users).
    // Fall back to t+12h if 24h has no completed samples yet.
    let h = summary.by_horizon[24];
    if (!h || h.arp.n === 0) h = summary.by_horizon[12];
    if (!h) return;

    const arpMae     = el('ft-validation-arp-mae');
    const persistMae = el('ft-validation-persist-mae');
    const skill      = el('ft-validation-skill');
    const nSpan      = el('ft-validation-n');
    const horizonLbl = el('ft-validation-horizon');

    if (horizonLbl) horizonLbl.textContent = `t+${h.horizon_h}h`;

    if (arpMae) {
        arpMae.textContent = h.arp.n > 0 ? h.arp.mae.toFixed(2) : '–';
    }
    if (persistMae) {
        persistMae.textContent = h.persistence.n > 0 ? h.persistence.mae.toFixed(2) : '–';
    }
    if (skill) {
        if (h.skill_vs_persistence == null) {
            skill.textContent = 'n/a';
            skill.style.color = '#667';
        } else {
            const s = h.skill_vs_persistence;
            skill.textContent = (s > 0 ? '+' : '') + (s * 100).toFixed(0) + '%';
            skill.style.color = s > 0.05 ? '#44cc88' : s < -0.05 ? '#ff5500' : '#ffcc00';
        }
    }
    if (nSpan) nSpan.textContent = h.arp.n;
}

// ── ForecastTimeline (public entry point) ──────────────────────────────────

export class ForecastTimeline {
    constructor() {
        this._chart = null;
        this._onForecast   = this._onForecast.bind(this);
        this._onValidation = this._onValidation.bind(this);
    }

    start() {
        const canvas = el('forecast-timeline-canvas');
        if (canvas) this._chart = new TimelineChart(canvas);

        window.addEventListener('earth-forecast-update', this._onForecast);
        window.addEventListener('forecast-validation-update', this._onValidation);
        return this;
    }

    stop() {
        window.removeEventListener('earth-forecast-update', this._onForecast);
        window.removeEventListener('forecast-validation-update', this._onValidation);
    }

    _onForecast(ev) {
        const payload = ev?.detail?.forecast_timeline;
        if (!payload) return;
        this._chart?.draw(payload);
        renderHorizonGrid(el('ft-horizons-grid'), payload);
        renderLegend(el('ft-legend'), payload);
        renderSwpcStatus(el('ft-swpc-status'), payload);
    }

    _onValidation(ev) {
        renderValidation(ev?.detail);
    }
}
