/**
 * surface-weather.js — Vortex-to-surface coupled forecast card
 * ═══════════════════════════════════════════════════════════════════════════
 * Consumes /api/weather/surface-outlook (which itself fans out to the
 * polar-vortex + teleconnections endpoints) and paints the Surface
 * Outlook card in space-weather.html. The card answers:
 *
 *   "Given today's stratospheric vortex state and the AO/NAO indices,
 *    is a surface cold-air outbreak likely, where, and how confident
 *    are we?"
 *
 * Surface response lags vortex disturbance by 7-21 days (the
 * "downward propagation" of stratosphere-troposphere coupling). This
 * card is the actionable end of that pipeline — vortex card on its
 * own answers "what's happening upstairs"; this one answers "what
 * does it mean for surface weather in the next two weeks?"
 *
 * Plot: 60-day AO + NAO timeseries (twin lines) with the ±1 σ
 * reference bands shaded. Negative AO/NAO regions filled red.
 */

const REGIME_COLORS = {
    'coupled-cold':  '#ff5577',
    'emerging-cold': '#ff9060',
    'decoupled':     '#ffcc66',
    'mild-zonal':    '#88e08c',
    'neutral':       '#778',
    'unknown':       '#445',
};

const RISK_BADGE = {
    high:     'badge-severe',
    elevated: 'badge-strong',
    moderate: 'badge-moderate',
    low:      'badge-minor',
    unknown:  'badge-minor',
};

const REFRESH_MS = 60 * 60 * 1000;   // 1 h — backend caches 6 h itself

export class SurfaceOutlookCard {
    constructor(opts = {}) {
        this.endpoint = opts.endpoint ?? '/v1/weather/surface-outlook';
        this._timer   = null;
        this._abort   = null;
    }

    start() {
        this.refresh();
        this._timer = setInterval(() => this.refresh(), REFRESH_MS);
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
        this._abort?.abort();
    }

    async refresh() {
        this._abort?.abort();
        const ctl = new AbortController();
        this._abort = ctl;

        try {
            const res = await fetch(this.endpoint, {
                signal:  ctl.signal,
                headers: { Accept: 'application/json' },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            if (this._abort !== ctl) return;
            this._render(body);
            // Pull AO/NAO history straight from the teleconnections
            // endpoint for the timeseries plot (the surface-outlook
            // composer doesn't echo the histories to keep payload small).
            this._fetchHistory(ctl.signal).catch(() => {});
        } catch (err) {
            if (err.name === 'AbortError') return;
            this._renderError(err);
        }
    }

    async _fetchHistory(signal) {
        const res = await fetch('/v1/weather/teleconnections', {
            signal, headers: { Accept: 'application/json' },
        });
        if (!res.ok) return;
        const body = await res.json();
        this._drawHistory(body.ao?.history || [], body.nao?.history || []);
    }

    _render(d) {
        const colour = REGIME_COLORS[d.regime] || REGIME_COLORS.unknown;
        const setText = (id, txt, c) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = txt;
            if (c) el.style.color = c;
        };

        setText('surf-regime', d.label || '—', colour);

        // Risk badge
        const riskEl = document.getElementById('surf-risk');
        if (riskEl) {
            riskEl.className = `cme-card-badge ${RISK_BADGE[d.risk] || 'badge-minor'}`;
            riskEl.textContent = (d.risk || '—').toUpperCase();
        }

        const fmtIdx = (v) => Number.isFinite(v)
            ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}`
            : '–';
        setText('surf-ao',
            `${fmtIdx(d.drivers?.ao?.current)}  (7d ${fmtIdx(d.drivers?.ao?.trend_7d)})`);
        setText('surf-nao',
            `${fmtIdx(d.drivers?.nao?.current)}  (7d ${fmtIdx(d.drivers?.nao?.trend_7d)})`);

        const lt = d.lead_time_days;
        setText('surf-lead',
            !lt ? 'in progress' : `+${lt} days`);

        const conf = d.confidence;
        setText('surf-conf',
            Number.isFinite(conf) ? `${(conf * 100).toFixed(0)}%` : '–');

        const aff = (d.affected_regions || []).filter(Boolean);
        setText('surf-affected', aff.length ? aff.join(' · ') : '—');

        setText('surf-summary', d.summary || '');
    }

    _renderError(err) {
        const el = document.getElementById('surf-regime');
        if (el) {
            el.textContent = 'Unavailable';
            el.style.color = REGIME_COLORS.unknown;
        }
        const sumEl = document.getElementById('surf-summary');
        if (sumEl) sumEl.textContent =
            `Surface outlook feed unavailable (${err.message}). Retrying in 1 h.`;
    }

    // ── 60-day AO + NAO timeseries on a canvas ──────────────────────────────

    _drawHistory(aoHist, naoHist) {
        const canvas = document.getElementById('surf-mini-plot');
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

        if (!aoHist.length && !naoHist.length) return;

        const allVals = [...aoHist, ...naoHist].map(r => r.value).filter(Number.isFinite);
        const maxAbs = Math.max(2.5, ...allVals.map(Math.abs));
        const padL = 28, padR = 6, padT = 14, padB = 16;
        const plotW = w - padL - padR;
        const plotH = h - padT - padB;

        const N = Math.max(aoHist.length, naoHist.length);
        const xOf = (i) => padL + (i / (N - 1)) * plotW;
        const yOf = (v) => padT + (1 - (v + maxAbs) / (2 * maxAbs)) * plotH;

        // Reference bands: ±1 σ neutral, beyond = anomaly.
        ctx.fillStyle = 'rgba(255,85,119,.06)';   // negative band
        ctx.fillRect(padL, yOf(-1), plotW, yOf(-maxAbs) - yOf(-1));
        ctx.fillStyle = 'rgba(92,217,255,.06)';   // positive band
        ctx.fillRect(padL, yOf(maxAbs), plotW, yOf(1) - yOf(maxAbs));

        // Zero line.
        ctx.strokeStyle = 'rgba(255,255,255,.18)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, yOf(0));
        ctx.lineTo(w - padR, yOf(0));
        ctx.stroke();

        // ±1 σ guide lines.
        ctx.strokeStyle = 'rgba(255,255,255,.08)';
        ctx.setLineDash([2, 3]);
        for (const ref of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(padL, yOf(ref));
            ctx.lineTo(w - padR, yOf(ref));
            ctx.stroke();
        }
        ctx.setLineDash([]);

        // AO line (cyan).
        const drawLine = (hist, colour, lineWidth = 1.6) => {
            ctx.strokeStyle = colour;
            ctx.lineWidth = lineWidth;
            ctx.beginPath();
            for (let i = 0; i < hist.length; i++) {
                if (!Number.isFinite(hist[i].value)) continue;
                const x = xOf(i), y = yOf(hist[i].value);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        };
        drawLine(aoHist,  '#5cd9ff', 1.8);
        drawLine(naoHist, '#ff9060', 1.4);

        // Y-axis labels.
        ctx.fillStyle = '#778';
        ctx.font = '9px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const v of [-2, -1, 0, 1, 2]) {
            if (Math.abs(v) > maxAbs) continue;
            ctx.fillText(`${v > 0 ? '+' : ''}${v}`, padL - 3, yOf(v));
        }

        // X-axis: today + 60d ago labels.
        ctx.fillStyle = '#556';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        if (aoHist.length) ctx.fillText(aoHist[0].date.slice(5), padL + 1, h - 1);
        ctx.textAlign = 'right';
        if (aoHist.length) ctx.fillText(aoHist[aoHist.length - 1].date.slice(5), w - padR - 1, h - 1);

        // Title + legend.
        ctx.fillStyle = '#cdf';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('AO', padL + 1, 1);
        ctx.fillStyle = '#5cd9ff';
        ctx.fillRect(padL + 16, 4, 8, 2);
        ctx.fillStyle = '#cdf';
        ctx.fillText('NAO', padL + 30, 1);
        ctx.fillStyle = '#ff9060';
        ctx.fillRect(padL + 50, 4, 8, 2);
    }
}
