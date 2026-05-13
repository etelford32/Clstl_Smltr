/**
 * js/renewables-panel.js
 *
 * Solar + wind energy gauges for a single location. Pairs with
 * /api/weather/renewables, which computes POA irradiance, panel
 * AC output (per m²), hub-height wind, and capacity factors.
 *
 * Same UX idiom as the other Layers-panel cards: lazy-mount on first
 * expand, single fetch on mount, sparkline of the 24-hour curves with
 * a headline number per side (peak + capacity factor).
 *
 * Inputs come from window-globals just like the probability picker —
 * we read _userLat / _userLon by calling a getter passed in at mount.
 * No coupling to the rest of earth.html beyond that.
 */

const FIELD_OPTIONS = Object.freeze({
    // Reasonable tilt/azimuth defaults are computed server-side from lat.
    // Hub height of 80 m matches mid-size onshore turbines.
    DEFAULT_HUB_M: 80,
});

// ── Small DOM helper (duplicated from models-panel for self-containment).
function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class')      n.className = v;
        else if (k === 'text')  n.textContent = v;
        else if (k === 'html')  n.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') {
            n.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v != null && v !== false) {
            n.setAttribute(k, v);
        }
    }
    for (const c of kids) {
        if (c == null) continue;
        n.appendChild(typeof c === 'string'
            ? document.createTextNode(c) : c);
    }
    return n;
}

// ── Inline-SVG sparkline for one numeric series. ───────────────────
// Series may include zeros (overnight solar); we still want the y-axis
// to extend up to the max so the daytime peak is legible.

function sparkline({ values, color, fill, width = 240, height = 40, max }) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('class', 'rp-spark');
    svg.setAttribute('preserveAspectRatio', 'none');
    if (!values || values.length === 0) return svg;

    const n = values.length;
    const peak = max ?? Math.max(...values.map(v => Number.isFinite(v) ? v : 0), 1e-6);
    const padX = 1, padY = 3;
    const w = width  - padX * 2;
    const h = height - padY * 2;

    const pts = values.map((v, i) => {
        const x = padX + (n > 1 ? (i / (n - 1)) * w : w / 2);
        const f = Number.isFinite(v) && peak > 0 ? Math.max(0, v) / peak : 0;
        const y = padY + (1 - f) * h;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    const area = document.createElementNS(ns, 'polygon');
    area.setAttribute('fill', fill);
    area.setAttribute('points',
        `${padX},${padY + h} ${pts.join(' ')} ${padX + w},${padY + h}`);
    svg.appendChild(area);

    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('points', pts.join(' '));
    svg.appendChild(line);

    return svg;
}

// ── Controller ────────────────────────────────────────────────────

export class RenewablesPanel {
    constructor(opts) {
        const { host, getLatLon } = opts || {};
        if (!host) throw new Error('RenewablesPanel: host required');
        this.host = host;
        this.getLatLon = getLatLon || (() => null);
        this.state = {
            loading: false,
            error:   null,
            data:    null,
            lastLatLon: null,
        };
        this._render();
    }

    /** Trigger a fetch using the current getter. */
    async refresh() {
        const ll = this.getLatLon();
        if (!ll) {
            this.state.error = 'Pin a location on the globe to see local renewable potential.';
            this.state.data  = null;
            this._render();
            return;
        }
        this.state.loading = true;
        this.state.error   = null;
        this._render();

        try {
            const params = new URLSearchParams({
                lat:  String(ll.lat),
                lon:  String(ll.lon),
                days: '2',
                hub:  String(FIELD_OPTIONS.DEFAULT_HUB_M),
            });
            const res = await fetch('/api/weather/renewables?' + params.toString(), {
                method:      'GET',
                credentials: 'omit',
                headers:     { Accept: 'application/json' },
            });
            if (res.status === 429) {
                const body = await res.json().catch(() => ({}));
                this.state.error = `Rate-limited (${body.retry_after ?? '?'}s). ${body.hint || ''}`;
            } else if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                this.state.error = `HTTP ${res.status}: ${body.detail || body.error || 'unknown'}`;
            } else {
                this.state.data       = await res.json();
                this.state.lastLatLon = ll;
                this.state.error      = null;
            }
        } catch (e) {
            this.state.error = String(e?.message || e);
        } finally {
            this.state.loading = false;
            this._render();
        }
    }

    // ── Render ────────────────────────────────────────────────────

    _render() {
        const ll = this.getLatLon();
        const refreshBtn = el('button', {
            type: 'button', class: 'rp-refresh',
            onClick: () => this.refresh(),
        }, this.state.loading ? 'Loading…' : 'Refresh');
        if (this.state.loading) refreshBtn.setAttribute('disabled', '');

        const headHint = el('div', { class: 'rp-head-hint' },
            ll ? `at ${ll.lat.toFixed(2)}°, ${ll.lon.toFixed(2)}°`
               : 'no location pinned');

        const head = el('div', { class: 'rp-head' },
            el('span', { class: 'rp-head-title', text: 'Renewable Potential' }),
            headHint,
            refreshBtn,
        );

        let body;
        if (this.state.error) {
            body = el('div', { class: 'rp-error', text: this.state.error });
        } else if (!this.state.data) {
            body = el('div', { class: 'rp-empty',
                text: 'Hit Refresh to see local solar + wind potential for the next 48 hours.' });
        } else {
            body = this._renderGauges(this.state.data);
        }

        const basisLine = this.state.data
            ? el('div', { class: 'rp-basis',
                text: `${this.state.data.basis.method} · panel ${(this.state.data.basis.panel_efficiency * 100).toFixed(0)}% efficient · hub ${this.state.data.wind.hub_height_m} m`,
              })
            : null;

        this.host.replaceChildren(el('div', { class: 'rp-root' },
            head, body, basisLine,
        ));
    }

    _renderGauges(data) {
        const solarSeries = data.hourly.slice(0, 24).map(h => h.solar_ac_w_m2 || 0);
        const windSeries  = data.hourly.slice(0, 24).map(h => h.wind_power_norm || 0);

        const solar_cf = data.summary.solar_capacity_factor_24h;
        const wind_cf  = data.summary.wind_capacity_factor_24h;
        const peak_poa = data.summary.solar_peak_w_m2;
        const peak_hub = data.summary.wind_peak_hub_ms;

        const fmtPct = (v) => `${Math.round(v * 100)}%`;

        const solarCard = el('div', { class: 'rp-card rp-card-solar' },
            el('div', { class: 'rp-card-head' },
                el('span', { class: 'rp-card-icon', text: '☀' }),
                el('span', { class: 'rp-card-name', text: 'Solar PV' }),
                el('span', { class: 'rp-card-cf',   text: fmtPct(solar_cf) }),
            ),
            sparkline({
                values: solarSeries,
                color:  '#ffd24c',
                fill:   'rgba(255, 210, 76, 0.18)',
            }),
            el('div', { class: 'rp-card-foot' },
                el('span', {}, `peak ${peak_poa} W/m²`),
                el('span', {}, `${(solar_cf * 24).toFixed(1)} kWh/m² · 24h`),
            ),
        );

        const windCard = el('div', { class: 'rp-card rp-card-wind' },
            el('div', { class: 'rp-card-head' },
                el('span', { class: 'rp-card-icon', text: '🌬' }),
                el('span', { class: 'rp-card-name', text: 'Wind' }),
                el('span', { class: 'rp-card-cf',   text: fmtPct(wind_cf) }),
            ),
            sparkline({
                values: windSeries,
                color:  '#7fd2ff',
                fill:   'rgba(127, 210, 255, 0.18)',
                max:    1,
            }),
            el('div', { class: 'rp-card-foot' },
                el('span', {}, `peak ${peak_hub} m/s @ hub`),
                el('span', {}, this._windRangeLabel(peak_hub, data.wind)),
            ),
        );

        return el('div', { class: 'rp-gauges' }, solarCard, windCard);
    }

    _windRangeLabel(peak_ms, wind) {
        if (peak_ms < wind.cut_in_ms)   return `below cut-in (${wind.cut_in_ms} m/s)`;
        if (peak_ms < wind.rated_ms)    return `partial-power zone`;
        if (peak_ms < wind.cut_out_ms)  return `at rated power ≥ ${wind.rated_ms} m/s`;
        return `above cut-out (${wind.cut_out_ms} m/s) — turbine parks`;
    }
}

/**
 * Mount helper for the lazy-init pattern used by earth.html. Returns
 * the controller so the caller can wire pin-change events to refresh.
 */
export function mountRenewablesPanel(host, getLatLon) {
    const panel = new RenewablesPanel({ host, getLatLon });
    return panel;
}
