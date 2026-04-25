/**
 * gravity-wave.js — Atmospheric gravity-wave activity card
 * ═══════════════════════════════════════════════════════════════════════════
 * Surfaces the gravity-wave (GW) activity proxy that
 * dsmc/pipeline/profile.py emits with every /v1/atmosphere/profile
 * response — RMS amplitude of the residual between the SPARTA-refined
 * density profile and a smooth log-ρ exponential fit.
 *
 * Why this matters: gravity waves originate in the troposphere
 * (jets, fronts, convection, terrain), propagate upward, and break in
 * the mesosphere/lower thermosphere — depositing momentum and heat
 * that feeds back into the stratospheric residual circulation. They
 * change ionospheric scintillation (GPS/HF), drive episodic LEO drag
 * variability that empirical models miss, and modulate the SSW /
 * polar-vortex coupling we already surface with the vortex card.
 *
 * The proxy is the residual amplitude:
 *
 *   resid(z) = (ρ(z) − ρ_fit(z)) / ρ_fit(z)
 *   RMS over z ≥ 150 km    →    activity index in %
 *
 * Until SPARTA tables populate, the client surrogate IS the smooth
 * fit by construction — the card sits on "quiet · climatology" and
 * only lights up when SPARTA-refined rows replace MSIS-bootstrap
 * rows in the backend table directory. That is the intended bootstrap
 * behaviour: the card is wired now so the upgrade is plug-and-play.
 */

import {
    fetchProfile,
    gravityWaveActivity,
} from './upper-atmosphere-engine.js';

const STATE_COLORS = {
    quiet:    '#88e08c',
    active:   '#ffcc66',
    strong:   '#ff9060',
    extreme:  '#ff5577',
    unknown:  '#778',
};

const STATE_LABELS = {
    quiet:   'Quiet',
    active:  'Active',
    strong:  'Strong',
    extreme: 'Extreme',
    unknown: 'No data',
};

const STATE_RISK_BADGE = {
    quiet:   'badge-minor',
    active:  'badge-moderate',
    strong:  'badge-strong',
    extreme: 'badge-severe',
    unknown: 'badge-minor',
};

const REFRESH_MS = 30 * 60 * 1000;   // 30 min — backend caches 60 s itself

// State threshold descriptions — surfaced in the explanatory text.
const STATE_DETAIL = {
    quiet: 'Density profile follows the empirical scale-height fit. '
         + 'No measurable wave activity above the model floor.',
    active: 'Departures from the smooth fit are 0.5–2 % RMS — typical of '
         + 'background gravity-wave activity from tropospheric sources.',
    strong: 'Significant wave forcing (2–6 % RMS). Often follows '
         + 'major frontal passages or storm-driven convection.',
    extreme:'Wave amplitudes >6 % RMS. Episodic LEO drag spikes likely; '
         + 'mesospheric / ionospheric variability elevated.',
    unknown:'No vertical profile available.',
};

export class GravityWaveCard {
    constructor(opts = {}) {
        this.cardId = opts.cardId ?? 'gw-card';
        this._timer = null;
        this._abort = null;
        this._lastGW = null;
    }

    start() {
        this.refresh();
        this._timer = setInterval(() => this.refresh(), REFRESH_MS);

        // Re-run when Kp / F10.7 update, since the surrogate's profile
        // shape (and therefore residuals) depends on activity state.
        // We don't extract values from the event — fetchProfile pulls
        // the latest indices from the backend itself when called with
        // no f107/ap.
        this._onSwpc = () => this.refresh();
        window.addEventListener('swpc-update', this._onSwpc);
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
        this._abort?.abort();
        if (this._onSwpc) {
            window.removeEventListener('swpc-update', this._onSwpc);
            this._onSwpc = null;
        }
    }

    async refresh() {
        this._abort?.abort();
        const ctl = new AbortController();
        this._abort = ctl;

        try {
            // Pull the current Kp from the page and convert to F10.7/Ap if
            // available; otherwise let fetchProfile use defaults.
            const kpText = document.getElementById('kp-val')?.textContent?.trim();
            const kp = parseFloat(kpText);
            const ap = Number.isFinite(kp) ? _kpToAp(kp) : undefined;

            const profile = await fetchProfile({
                f107Sfu:  150,
                ap:       ap,
                minKm:    80,
                maxKm:    1500,
                nPoints:  60,
                signal:   ctl.signal,
            });
            if (this._abort !== ctl) return;

            // Backend may already include the GW block. If not (legacy
            // server, or client-fallback), compute it from samples.
            const gw = profile.gravityWave
                    ?? gravityWaveActivity(profile.samples);

            this._lastGW = gw;
            this._render(gw, profile.model);
        } catch (err) {
            if (err.name === 'AbortError') return;
            this._renderError(err);
        }
    }

    _render(gw, model) {
        const state = gw?.state ?? 'unknown';
        const colour = STATE_COLORS[state] || STATE_COLORS.unknown;

        this._setText('gw-state', STATE_LABELS[state] || state, colour);
        this._setText('gw-rms',  fmtPct(gw?.rmsPct));
        this._setText('gw-peak', fmtSignedPct(gw?.peakPct));
        this._setText('gw-peak-alt',
            Number.isFinite(gw?.peakAltKm) ? `${gw.peakAltKm.toFixed(0)} km` : '–');
        this._setText('gw-h-eff',
            Number.isFinite(gw?.fitScaleHkm) ? `${gw.fitScaleHkm.toFixed(0)} km` : '–');

        const riskEl = document.getElementById('gw-risk');
        if (riskEl) {
            riskEl.className = `cme-card-badge ${STATE_RISK_BADGE[state] || 'badge-minor'}`;
            riskEl.textContent = state.toUpperCase();
        }

        const detailEl = document.getElementById('gw-detail');
        if (detailEl) {
            const note = (model && model.startsWith('SPARTA-')) ? '' :
                ' Until SPARTA tables populate, this proxy stays near zero by construction.';
            detailEl.textContent = (STATE_DETAIL[state] || STATE_DETAIL.unknown) + note;
        }

        const srcEl = document.getElementById('src-gw');
        if (srcEl && model) {
            srcEl.title = `Source model: ${model}`;
        }

        this._drawResiduals(gw);
    }

    _renderError(err) {
        const el = document.getElementById('gw-state');
        if (el) {
            el.textContent = 'Unavailable';
            el.style.color = STATE_COLORS.unknown;
        }
        const detailEl = document.getElementById('gw-detail');
        if (detailEl) detailEl.textContent = `Profile feed unavailable (${err.message}).`;
    }

    _drawResiduals(gw) {
        const canvas = document.getElementById('gw-mini-plot');
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

        const residuals = gw?.residuals || [];
        const padL = 36, padR = 8, padT = 14, padB = 18;
        const plotW = w - padL - padR;
        const plotH = h - padT - padB;

        // Y-axis range — anchor at ±max(|residuals|, 1%) so the quiet
        // surrogate has a visible baseline, but storm-time residuals
        // get full vertical resolution.
        const peakMag = residuals.length
            ? Math.max(1, ...residuals.map(r => Math.abs(r.residualPct)))
            : 1;
        const altMin = 150, altMax = 1500;
        const yOf = (pct) => padT + (1 - (pct + peakMag) / (2 * peakMag)) * plotH;
        const xOf = (alt) => padL + ((alt - altMin) / (altMax - altMin)) * plotW;

        // Reference shading: red above +threshold, green between, etc.
        ctx.fillStyle = 'rgba(255,87,119,.06)';
        ctx.fillRect(padL, padT, plotW, (peakMag - 2) / (2 * peakMag) * plotH);
        ctx.fillStyle = 'rgba(255,87,119,.06)';
        ctx.fillRect(padL, padT + (peakMag + 2) / (2 * peakMag) * plotH,
                     plotW, (peakMag - 2) / (2 * peakMag) * plotH);

        // Zero line.
        const y0 = yOf(0);
        ctx.strokeStyle = 'rgba(255,255,255,.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, y0);
        ctx.lineTo(w - padR, y0);
        ctx.stroke();

        // Y-axis ticks.
        ctx.fillStyle = '#778';
        ctx.font = '9px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const pct of [-peakMag, 0, peakMag]) {
            const y = yOf(pct);
            ctx.fillText(`${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`, padL - 4, y);
        }

        // X-axis labels.
        ctx.fillStyle = '#556';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (const alt of [200, 500, 1000, 1500]) {
            ctx.fillText(`${alt}`, xOf(alt), h - padB + 2);
        }
        ctx.textAlign = 'right';
        ctx.fillText('km', w - padR - 1, h - padB + 2);

        // Residual bars (one per altitude sample).
        if (residuals.length) {
            const barW = Math.max(1, plotW / residuals.length - 0.5);
            for (const r of residuals) {
                if (r.altitudeKm < altMin || r.altitudeKm > altMax) continue;
                const x = xOf(r.altitudeKm);
                const y = yOf(r.residualPct);
                ctx.fillStyle = r.residualPct > 0
                    ? 'rgba(92,217,255,.75)'
                    : 'rgba(255,144,96,.75)';
                ctx.fillRect(x - barW / 2,
                             Math.min(y, y0),
                             barW,
                             Math.abs(y0 - y));
            }
        }

        // Title.
        ctx.fillStyle = '#cdf';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('residual ρ vs scale-height fit', padL, 1);
    }

    _setText(id, txt, colour) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = txt;
        if (colour) el.style.color = colour;
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

const _KP_TO_AP = [0, 3, 7, 15, 27, 48, 80, 140, 240, 400];
function _kpToAp(kp) {
    if (!Number.isFinite(kp) || kp < 0) return 15;
    const lo = Math.floor(Math.min(kp, 9));
    const hi = Math.min(lo + 1, 9);
    const t = Math.max(0, Math.min(1, kp - lo));
    return _KP_TO_AP[lo] * (1 - t) + _KP_TO_AP[hi] * t;
}

function fmtPct(v) {
    if (!Number.isFinite(v)) return '–';
    return `${v.toFixed(2)} %`;
}

function fmtSignedPct(v) {
    if (!Number.isFinite(v)) return '–';
    return `${v > 0 ? '+' : ''}${v.toFixed(2)} %`;
}
