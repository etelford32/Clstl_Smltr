/**
 * js/probability-picker.js
 *
 * "What's the chance ___ at ___ this ___?" — structured-input probability
 * picker. Free to use; anonymous sessions get a 5-minute soft trial via
 * AnonymousSessionTimer (results stay visible after expiry, only new
 * queries are blocked).
 *
 * Inputs (all dropdowns / number entry — no free-text):
 *   field      → temperature_2m | apparent_temperature | ... (9 options)
 *   op         → < | ≤ | ≥ | >
 *   threshold  → numeric entry; unit chip follows field
 *   window     → preset chips (Next 6h / Next 24h / This weekend /
 *                Next 3 days / Next 7 days) + custom start/end hours
 *   location   → reads window.__probPickerLatLon, or falls back to
 *                user-pin coords (lat/lon globals on earth.html). The
 *                caller writes coords on cursor-pin events.
 *
 * Outputs:
 *   - Big P(event) headline number
 *   - Sparkline of per-hour probability across the window
 *   - Per-member breakdown (4 rows: GFS / ECMWF / ICON / GEM)
 *   - Confidence chip from ensemble_iqr (real, not lead-time-derived)
 *   - "Why?" expander listing crossed hours per member
 *
 * State machine
 *   idle            → run button enabled, no result shown
 *   loading         → run button shows spinner
 *   shown           → result card painted; run button enabled
 *   shown_frozen    → result card painted; run button disabled with
 *                     "Sign in to run new queries" banner
 */

import { AnonymousSessionTimer, formatTimerMMSS } from './anonymous-session-timer.js';

// ── Static config (must match api/weather/probability.js) ──────────

const FIELD_OPTIONS = Object.freeze([
    { key: 'temperature_2m',        label: 'Temperature',        unit: 'F',   defaults: { op: 'lt', threshold: 32  } },
    { key: 'apparent_temperature',  label: 'Feels-like temp',    unit: 'F',   defaults: { op: 'lt', threshold: 0   } },
    { key: 'wind_speed_10m',        label: 'Wind speed',         unit: 'mph', defaults: { op: 'gt', threshold: 25  } },
    { key: 'wind_gusts_10m',        label: 'Wind gusts',         unit: 'mph', defaults: { op: 'gt', threshold: 40  } },
    { key: 'precipitation',         label: 'Precipitation',      unit: 'mm',  defaults: { op: 'gt', threshold: 1   } },
    { key: 'relative_humidity_2m',  label: 'Relative humidity',  unit: '%',   defaults: { op: 'gt', threshold: 90  } },
    { key: 'dew_point_2m',          label: 'Dew point',          unit: 'F',   defaults: { op: 'gt', threshold: 70  } },
    { key: 'pressure_msl',          label: 'Sea-level pressure', unit: 'hPa', defaults: { op: 'lt', threshold: 1000} },
    { key: 'cloud_cover',           label: 'Cloud cover',        unit: '%',   defaults: { op: 'gt', threshold: 80  } },
]);

const OP_OPTIONS = Object.freeze([
    { key: 'lt',  label: '<',  word: 'below' },
    { key: 'lte', label: '≤',  word: 'at or below' },
    { key: 'gte', label: '≥',  word: 'at or above' },
    { key: 'gt',  label: '>',  word: 'above' },
]);

const WINDOW_PRESETS = Object.freeze([
    { key: '6h',  label: 'Next 6h',     start: 0,  end: 6   },
    { key: '24h', label: 'Next 24h',    start: 0,  end: 24  },
    { key: '72h', label: 'Next 3 days', start: 0,  end: 72  },
    { key: '7d',  label: 'Next 7 days', start: 0,  end: 168 },
]);

const MAX_TRIAL_SECONDS = 300;   // 5 minutes for anonymous sessions

// ── Tiny DOM helper ────────────────────────────────────────────────

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

function escapeHTML(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    })[ch]);
}

// ── Sparkline (inline SVG, ~100 LOC) ───────────────────────────────

function sparkline(byHour, width = 240, height = 36) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('class', 'pp-spark');
    svg.setAttribute('preserveAspectRatio', 'none');

    if (!byHour || byHour.length === 0) return svg;

    const padX = 1, padY = 3;
    const w = width  - padX * 2;
    const h = height - padY * 2;
    const n = byHour.length;

    // Polyline points.
    const pts = byHour.map((b, i) => {
        const x = padX + (n > 1 ? (i / (n - 1)) * w : w / 2);
        const p = Number.isFinite(b.p) ? b.p : 0;
        const y = padY + (1 - p) * h;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    // Filled area below the line.
    const area = document.createElementNS(ns, 'polygon');
    area.setAttribute('class', 'pp-spark-area');
    area.setAttribute('points',
        `${padX},${padY + h} ${pts.join(' ')} ${padX + w},${padY + h}`);
    svg.appendChild(area);

    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('class', 'pp-spark-line');
    line.setAttribute('points', pts.join(' '));
    svg.appendChild(line);

    return svg;
}

// ── Confidence-chip label from ensemble_iqr ────────────────────────

function confidenceFromIqr(iqr) {
    if (iqr == null) return { tier: 'unknown', label: 'unknown' };
    if (iqr < 0.15)  return { tier: 'high',     label: 'high agreement' };
    if (iqr < 0.4)   return { tier: 'moderate', label: 'moderate spread' };
    return                  { tier: 'low',      label: 'low agreement'  };
}

// ── Picker controller ──────────────────────────────────────────────

export class ProbabilityPicker {
    constructor(opts) {
        const {
            host,
            getLatLon,
            isSignedIn = () => false,
            onSignInPrompt,
        } = opts || {};
        if (!host) throw new Error('ProbabilityPicker: host element is required');

        this.host        = host;
        this.getLatLon   = getLatLon   || (() => null);
        this.isSignedIn  = isSignedIn;
        this.onSignInPrompt = onSignInPrompt || (() => {
            // Default: send the user to the signup page with a returnTo
            window.location.href = '/signin?next=' +
                encodeURIComponent(window.location.pathname);
        });

        this.state = {
            field:     'temperature_2m',
            op:        'lt',
            threshold: 32,
            window:    { start: 0, end: 24, key: '24h' },
            loading:   false,
            result:    null,
            error:     null,
        };

        this._timer = new AnonymousSessionTimer({
            feature:      'probability-picker',
            maxSeconds:   MAX_TRIAL_SECONDS,
            isSignedIn:   () => this.isSignedIn(),
            onTick:       (s) => this._onTimerTick(s),
            onSoftExpire: ()  => this._onSoftExpire(),
        });

        this._render();
    }

    // ── External API ───────────────────────────────────────────────

    mount() { this._timer.start(); }
    unmount() { this._timer.stop(); }
    refreshSignIn() { this._timer.refresh(); this._render(); }

    // ── Render ─────────────────────────────────────────────────────

    _render() {
        const field = FIELD_OPTIONS.find(f => f.key === this.state.field) || FIELD_OPTIONS[0];
        const timer = this._timer.snapshot();

        // Title strip with anonymous timer chip
        const titleEl = el('div', { class: 'pp-title' },
            el('span', { class: 'pp-title-h', text: 'Probability Picker' }),
            this._renderTimerChip(timer),
        );

        // Inputs row
        const fieldSel = el('select', { class: 'pp-input pp-input-field',
            onChange: (e) => {
                const next = FIELD_OPTIONS.find(f => f.key === e.target.value);
                if (next) {
                    this.state.field     = next.key;
                    this.state.op        = next.defaults.op;
                    this.state.threshold = next.defaults.threshold;
                    this._render();
                }
            }
        }, ...FIELD_OPTIONS.map(f => {
            const o = el('option', { value: f.key, text: f.label });
            if (f.key === this.state.field) o.setAttribute('selected', '');
            return o;
        }));

        const opSel = el('select', { class: 'pp-input pp-input-op',
            onChange: (e) => { this.state.op = e.target.value; this._render(); }
        }, ...OP_OPTIONS.map(o => {
            const opt = el('option', { value: o.key, text: o.label });
            if (o.key === this.state.op) opt.setAttribute('selected', '');
            return opt;
        }));

        const thresholdInput = el('input', {
            type: 'number',
            class: 'pp-input pp-input-threshold',
            value: String(this.state.threshold),
            step:  'any',
            onInput: (e) => {
                const n = parseFloat(e.target.value);
                if (Number.isFinite(n)) this.state.threshold = n;
            },
        });

        const unitChip = el('span', { class: 'pp-unit', text: field.unit });

        const inputsRow = el('div', { class: 'pp-row pp-row-inputs' },
            el('div', { class: 'pp-row-line', text: 'What\'s the chance' }),
            fieldSel,
            el('span', { class: 'pp-glue', text: 'goes' }),
            opSel,
            thresholdInput,
            unitChip,
        );

        // Window chips
        const windowRow = el('div', { class: 'pp-row pp-row-window' },
            el('span', { class: 'pp-glue', text: 'in the' }),
            ...WINDOW_PRESETS.map(p => el('button', {
                type:  'button',
                class: 'pp-chip' + (this.state.window.key === p.key ? ' active' : ''),
                onClick: () => {
                    this.state.window = { start: p.start, end: p.end, key: p.key };
                    this._render();
                },
            }, p.label)),
            el('span', { class: 'pp-glue', text: '?' }),
        );

        // Run row
        const runBtn = el('button', {
            type:  'button',
            class: 'pp-run-btn',
            onClick: () => this._run(),
        }, this.state.loading ? 'Running…' : 'Run query');
        if (this.state.loading || (timer.expired && !timer.bypassed)) {
            runBtn.setAttribute('disabled', '');
        }

        const locInfo = (() => {
            const ll = this.getLatLon();
            return ll
                ? `at ${ll.lat.toFixed(2)}°, ${ll.lon.toFixed(2)}°`
                : 'Pin a location on the globe first.';
        })();
        const runRow = el('div', { class: 'pp-row pp-row-run' },
            runBtn,
            el('span', { class: 'pp-loc', text: locInfo }),
        );

        // Soft-expire banner
        let banner = null;
        if (timer.expired && !timer.bypassed) {
            banner = el('div', { class: 'pp-banner pp-banner-frozen' },
                el('span', {},
                    el('strong', { text: 'Free trial ended.' }),
                    ' Last result still visible. ',
                ),
                el('a', {
                    href: '#',
                    class: 'pp-banner-link',
                    onClick: (e) => {
                        e.preventDefault();
                        this.onSignInPrompt();
                    },
                }, 'Sign in for unlimited queries'),
            );
        }

        // Result card
        const resultCard = this.state.result
            ? this._renderResult(this.state.result)
            : this.state.error
                ? this._renderError(this.state.error)
                : this._renderEmpty();

        // Compose
        const root = el('div', { class: 'pp-root' },
            titleEl,
            inputsRow,
            windowRow,
            runRow,
            banner,
            resultCard,
        );
        this.host.replaceChildren(root);
    }

    _renderTimerChip(timer) {
        if (timer.bypassed) {
            return el('span', { class: 'pp-timer-chip pp-signed' },
                'Signed in · unlimited');
        }
        if (timer.expired) {
            return el('span', { class: 'pp-timer-chip pp-expired' },
                'Free trial ended');
        }
        return el('span', { class: 'pp-timer-chip' },
            `${formatTimerMMSS(timer.remainingSec)} left · sign in for unlimited`);
    }

    _renderEmpty() {
        return el('div', { class: 'pp-result pp-result-empty' },
            el('div', { class: 'pp-empty-line',
                text: 'Pick a question, hit Run. We\'ll ask GFS, ECMWF, ICON and GEM what they think.' }),
        );
    }

    _renderError(error) {
        return el('div', { class: 'pp-result pp-result-error' },
            el('div', { class: 'pp-err-head', text: 'Couldn\'t compute' }),
            el('div', { class: 'pp-err-detail', text: error }),
        );
    }

    _renderResult(r) {
        const pct        = r.probability != null
                           ? Math.round(r.probability * 100)
                           : null;
        const conf       = confidenceFromIqr(r.ensemble_iqr);
        const fieldLabel = (r.basis?.field_label || r.basis?.field || '').toLowerCase();
        const opWord     = OP_OPTIONS.find(o => o.key === r.basis?.op)?.word || r.basis?.op;
        const summary    = `${fieldLabel} ${opWord} ${r.basis.threshold} ${r.basis.units}`;

        // Per-member rows
        const memberRows = (r.by_member || []).map(m => {
            const crossed = m.crossed_hours || [];
            return el('div', { class: 'pp-member' },
                el('span', { class: 'pp-member-id',  text: m.model_id }),
                el('span', { class: 'pp-member-verdict',
                    text: m.probability >= 1 ? 'yes' : 'no' }),
                el('span', { class: 'pp-member-detail',
                    text: crossed.length > 0
                        ? `crosses at ${crossed.length} hour${crossed.length === 1 ? '' : 's'}: ${crossed.slice(0,6).map(h => `+${h}h`).join(', ')}${crossed.length > 6 ? '…' : ''}`
                        : 'never crosses in window' }),
            );
        });

        return el('div', { class: 'pp-result' },
            el('div', { class: 'pp-result-head' },
                pct == null
                    ? el('span', { class: 'pp-pct-na', text: '—' })
                    : el('span', { class: 'pp-pct',    text: `${pct}%` }),
                el('span', { class: 'pp-result-summary',
                    text: `chance ${summary}` }),
                el('span', {
                    class: `pp-conf pp-conf-${conf.tier}`,
                    text: conf.label,
                }),
            ),
            sparkline(r.by_hour),
            el('details', { class: 'pp-why' },
                el('summary', { text: `4-model breakdown · ${r.window?.hours_evaluated || 0} hours scored` }),
                el('div', { class: 'pp-members' }, ...memberRows),
            ),
        );
    }

    // ── Actions ────────────────────────────────────────────────────

    async _run() {
        const ll = this.getLatLon();
        if (!ll) {
            this.state.error = 'No location selected. Pin somewhere on the globe first.';
            this.state.result = null;
            this._render();
            return;
        }

        const t = this._timer.snapshot();
        if (t.expired && !t.bypassed) return;   // soft-freeze

        this.state.loading = true;
        this.state.error   = null;
        this._render();

        try {
            const params = new URLSearchParams({
                lat:            String(ll.lat),
                lon:            String(ll.lon),
                field:          this.state.field,
                op:             this.state.op,
                threshold:      String(this.state.threshold),
                window_start_h: String(this.state.window.start),
                window_end_h:   String(this.state.window.end),
            });
            const res = await fetch('/api/weather/probability?' + params.toString(), {
                method:      'GET',
                credentials: 'omit',
                headers:     { Accept: 'application/json' },
            });
            if (res.status === 429) {
                const body = await res.json().catch(() => ({}));
                this.state.error = `Rate-limited (${body.retry_after || '?'}s). ${body.hint || ''}`;
            } else if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                this.state.error = `HTTP ${res.status}: ${body.detail || body.error || 'unknown'}`;
            } else {
                this.state.result = await res.json();
                this.state.error  = null;
            }
        } catch (e) {
            this.state.error = String(e?.message || e);
        } finally {
            this.state.loading = false;
            this._render();
        }
    }

    _onTimerTick(_snap) {
        // Cheap re-render of just the chip to keep MM:SS fresh without
        // re-creating the whole DOM every second. The chip is the only
        // bit of UI that changes on a 1-Hz cadence.
        const chip = this.host.querySelector('.pp-timer-chip');
        if (!chip) return;
        chip.replaceWith(this._renderTimerChip(this._timer.snapshot()));
    }

    _onSoftExpire() {
        // Full re-render so the banner appears + Run button disables.
        this._render();
    }
}
