/**
 * upper-atmosphere-fleet-panel.js — Asset list + drag-forecast cards
 * ═══════════════════════════════════════════════════════════════════════════
 * The operator-facing UI. Wraps:
 *
 *   • UpperAtmosphereFleet  — the asset store (25 cap, localStorage)
 *   • FleetAnalyzer         — per-asset SGP4 + RK4 dual-scenario compute
 *
 * and renders a virtualized card list into a host DOM element. Each card
 * shows live state, a 72-h decay envelope (nowcast + AR(1) forecast), risk
 * badges, and per-asset alert thresholds.
 *
 * Composer surface — built so upper-atmosphere-ui.js can wire it in one
 * call without learning the internals:
 *
 *   const panel = new FleetPanel({
 *       host:    document.getElementById('ua-fleet-panel'),
 *       getLiveState: () => ({ f107: ..., ap: ... }),
 *       onAlert: (alert) => alertEngine.push(alert),
 *       onSeverityChange: (results) => globe.setFleetRibbons(results),
 *   });
 *   panel.start();
 *
 * The panel listens to:
 *   • its own UpperAtmosphereFleet store (asset list mutations)
 *   • `ua-realtime-tick`        (re-analyze when forcing changes)
 *   • `ua-drag-forecast-tick`   (re-analyze when nowcast ρ changes)
 *
 * Re-analysis is debounced — typing-fast slider drags don't trigger
 * back-to-back recomputes.
 */

import { UpperAtmosphereFleet, MAX_ASSETS, parseTleBlock } from './upper-atmosphere-fleet.js';
import {
    FleetAnalyzer, rankBySeverity,
    setDensityModel, getDensityModel,
    REENTRY_KM, DECAY_SPIKE_KM_DAY, DRAG_HIGH_PA, DRAG_HIGH_HOURS,
} from './upper-atmosphere-fleet-analyzer.js';
import { isMsisReady } from './nrlmsise00-bridge.js';

// Debounce window for full-fleet re-analysis on incoming ticks. Compute
// is cheap (~50 µs/asset) but we don't want to thrash mid-slider-drag.
const RECOMPUTE_DEBOUNCE_MS = 250;
// Per-asset, per-alert-type cooldown.
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

// CelesTrak groups exposed in the bulk-add menu. Curated to keep the
// dropdown short — operators paste TLEs for one-off asset adds; the
// bulk option is for "show me my whole constellation, fast".
export const BULK_GROUPS = [
    { value: 'stations',    label: 'Stations (ISS, Tiangong, …)' },
    { value: 'starlink',    label: 'Starlink' },
    { value: 'oneweb',      label: 'OneWeb' },
    { value: 'gps-ops',     label: 'GPS' },
    { value: 'galileo',     label: 'Galileo' },
    { value: 'weather',     label: 'Weather (GOES, JPSS, …)' },
    { value: 'science',     label: 'Science (Hubble, JWST, …)' },
    { value: 'last-30-days', label: 'Recently launched (30 d)' },
];

export class FleetPanel {
    /**
     * @param {object} opts
     * @param {HTMLElement} opts.host          mount point
     * @param {function():object} opts.getLiveState  () → { f107, ap }
     * @param {function(object)} [opts.onAlert]      called when a threshold trips
     * @param {function(Array)} [opts.onSeverityChange]  called with severity-ranked results (for ribbon picker)
     * @param {number} [opts.projHorizonHr=12] AR(1) projection horizon for "what could happen"
     */
    constructor({ host, getLiveState, onAlert, onSeverityChange, projHorizonHr = 12 }) {
        this.host = host;
        this.getLiveState = getLiveState || (() => ({ f107: 150, ap: 15 }));
        this.onAlert = onAlert || (() => {});
        this.onSeverityChange = onSeverityChange || (() => {});
        this._projHorizonHr = projHorizonHr;

        this.fleet    = new UpperAtmosphereFleet();
        this.analyzer = new FleetAnalyzer();
        this.analyzer.setHorizonHrForProjection(this._projHorizonHr);

        this._results = [];                  // last analyzer pass
        this._alertCooldowns = new Map();    // assetId|kind → fireWallMs
        this._recomputeTimer = null;
        this._tickHandler = null;
        this._dragTickHandler = null;
        this._unsubscribeFleet = null;
        this._busy = false;
        this._destroyed = false;

        // First paint: chrome only, no cards yet.
        this._mountChrome();
    }

    /** Wire event listeners + run first compute. Idempotent. */
    start() {
        if (this._tickHandler) return this;
        this._tickHandler = () => this._scheduleRecompute();
        this._dragTickHandler = () => this._scheduleRecompute();
        window.addEventListener('ua-realtime-tick',  this._tickHandler);
        window.addEventListener('ua-drag-forecast-tick', this._dragTickHandler);
        this._unsubscribeFleet = this.fleet.onChange(() => this._scheduleRecompute(0));
        return this;
    }

    stop() {
        if (this._tickHandler) {
            window.removeEventListener('ua-realtime-tick', this._tickHandler);
            window.removeEventListener('ua-drag-forecast-tick', this._dragTickHandler);
            this._tickHandler = null;
            this._dragTickHandler = null;
        }
        this._unsubscribeFleet?.();
        clearTimeout(this._recomputeTimer);
        this._recomputeTimer = null;
        this._destroyed = true;
    }

    setProjHorizonHr(h) {
        this._projHorizonHr = Math.max(1, Math.min(24, h | 0 || 12));
        this.analyzer.setHorizonHrForProjection(this._projHorizonHr);
        this._scheduleRecompute(0);
    }

    /** Snapshot of the most recent analyzer pass. */
    getResults() { return this._results.slice(); }

    // ── Recompute pipeline ──────────────────────────────────────────────────

    _scheduleRecompute(delayMs = RECOMPUTE_DEBOUNCE_MS) {
        clearTimeout(this._recomputeTimer);
        this._recomputeTimer = setTimeout(() => this._recompute(), delayMs);
    }

    async _recompute() {
        if (this._destroyed || this._busy) return;
        this._busy = true;
        try {
            const list = this.fleet.list();
            if (list.length === 0) {
                this._results = [];
                this._renderList();
                this.onSeverityChange([]);
                return;
            }
            const live = this.getLiveState() || { f107: 150, ap: 15 };
            const ready = list.filter(a => a.status === 'ready');
            const pending = list.filter(a => a.status !== 'ready');

            const readyResults = await this.analyzer.analyzeMany(
                ready, live, this._projHorizonHr,
            );

            // Stitch in placeholder rows for pending/error assets so the UI
            // shows them immediately rather than blanking until the TLE
            // resolves.
            const phResults = pending.map(a => ({
                id: a.id, name: a.name, noradId: a.noradId,
                bcM2PerKg: a.bcM2PerKg, status: a.status, err: a.err,
                live: null, decay: null, risk: null, forecastSkill: 1.0,
            }));
            this._results = [...readyResults, ...phResults];

            // Fire alerts for any newly-tripped thresholds.
            for (const r of readyResults) this._maybeFireAlerts(r);

            this._renderList();
            // Hand the severity-ranked list to whoever cares about ribbons.
            this.onSeverityChange(rankBySeverity(readyResults).slice(0, 3));
        } finally {
            this._busy = false;
        }
    }

    _maybeFireAlerts(r) {
        if (!r?.risk?.fired) return;
        const now = Date.now();
        const fire = (kind, severity, title, body) => {
            const key = `${r.id}|${kind}`;
            const last = this._alertCooldowns.get(key) ?? 0;
            if (now - last < ALERT_COOLDOWN_MS) return;
            this._alertCooldowns.set(key, now);
            this.onAlert({
                kind, severity, title, body,
                assetId: r.id, name: r.name, noradId: r.noradId,
                ts: now,
            });
        };
        const f = r.risk.fired;
        if (f.reentryRisk) {
            const hr = r.risk.reentryHr;
            fire('reentry-risk', 'high',
                `Reentry risk: ${r.name}`,
                `Projected altitude < ${REENTRY_KM} km within ${hr.toFixed(1)} h `
              + `under +${this._projHorizonHr}h forecast forcing.`);
        }
        if (f.decaySpike) {
            fire('decay-spike', 'medium',
                `Decay spike: ${r.name}`,
                `Worst projected da/dt ≈ ${r.risk.maxDecayKmDay.toFixed(1)} km/day `
              + `(threshold ${DECAY_SPIKE_KM_DAY}).`);
        }
        if (f.dragStress) {
            fire('drag-stress', 'low',
                `Drag stress: ${r.name}`,
                `≥ ${DRAG_HIGH_HOURS} h above ${(DRAG_HIGH_PA * 1e6).toFixed(0)} µPa equivalent `
              + `under projected forcing.`);
        }
    }

    // ── DOM scaffolding ─────────────────────────────────────────────────────

    _mountChrome() {
        if (!this.host) return;
        this.host.classList.add('ua-fleet-panel');
        this.host.innerHTML = `
            <div class="ua-fleet-add">
                <div class="ua-fleet-add-row">
                    <input id="ua-fleet-add-norad" type="number" min="1"
                           placeholder="NORAD id (e.g. 25544)"
                           class="ua-fleet-input">
                    <button type="button" id="ua-fleet-add-norad-btn"
                            class="ua-fleet-btn ua-fleet-btn--primary">Add</button>
                </div>
                <div class="ua-fleet-add-row">
                    <select id="ua-fleet-add-group" class="ua-fleet-input">
                        ${BULK_GROUPS.map(g =>
                            `<option value="${g.value}">${g.label}</option>`).join('')}
                    </select>
                    <input id="ua-fleet-add-group-n" type="number" min="1" max="${MAX_ASSETS}"
                           value="5" class="ua-fleet-input ua-fleet-input--n"
                           title="How many to import">
                    <button type="button" id="ua-fleet-add-group-btn"
                            class="ua-fleet-btn">Bulk add</button>
                </div>
                <details class="ua-fleet-paste">
                    <summary>Paste TLE block</summary>
                    <textarea id="ua-fleet-tle-text"
                              placeholder="Paste 2- or 3-line TLE blocks (one or many)"></textarea>
                    <div class="ua-fleet-add-row">
                        <button type="button" id="ua-fleet-tle-btn"
                                class="ua-fleet-btn">Add pasted TLE(s)</button>
                    </div>
                </details>
                <div id="ua-fleet-add-status" class="ua-fleet-status"></div>
            </div>
            <div class="ua-fleet-toolbar">
                <span id="ua-fleet-count" class="ua-dim">0 / ${MAX_ASSETS}</span>
                <span class="ua-fleet-model-toggle"
                      title="Atmosphere model used for density and decay forecasts">
                    <label class="ua-fleet-model-opt">
                        <input type="radio" name="ua-fleet-model" value="nrlmsise00" checked>
                        <span>NRLMSISE-00</span>
                    </label>
                    <label class="ua-fleet-model-opt">
                        <input type="radio" name="ua-fleet-model" value="msis-lite">
                        <span>MSIS-lite</span>
                    </label>
                    <span id="ua-fleet-model-state" class="ua-fleet-model-state"></span>
                </span>
                <button type="button" id="ua-fleet-clear-btn"
                        class="ua-fleet-btn ua-fleet-btn--danger">Clear all</button>
            </div>
            <div id="ua-fleet-cards" class="ua-fleet-cards"></div>
        `;

        // Bind controls.
        this.host.querySelector('#ua-fleet-add-norad-btn')
            .addEventListener('click', () => this._uiAddNorad());
        this.host.querySelector('#ua-fleet-add-norad')
            .addEventListener('keydown', (e) => { if (e.key === 'Enter') this._uiAddNorad(); });
        this.host.querySelector('#ua-fleet-add-group-btn')
            .addEventListener('click', () => this._uiBulkAdd());
        this.host.querySelector('#ua-fleet-tle-btn')
            .addEventListener('click', () => this._uiAddPaste());
        this.host.querySelector('#ua-fleet-clear-btn')
            .addEventListener('click', () => {
                if (this.fleet.count() === 0) return;
                if (!window.confirm('Remove all tracked assets?')) return;
                this.fleet.clear();
            });

        // Cache references for the render loop.
        this._cardsHost = this.host.querySelector('#ua-fleet-cards');
        this._countEl   = this.host.querySelector('#ua-fleet-count');
        this._statusEl  = this.host.querySelector('#ua-fleet-add-status');
        this._modelStateEl = this.host.querySelector('#ua-fleet-model-state');

        // Model toggle: NRLMSISE-00 (vendored Brodowski C port via WASM)
        // ↔ MSIS-lite (the original Jacchia-style JS surrogate). Resets
        // the analyzer cache so the next paint re-runs against the new
        // model without waiting for the next realtime tick.
        for (const r of this.host.querySelectorAll('input[name="ua-fleet-model"]')) {
            r.addEventListener('change', (e) => {
                if (!e.target.checked) return;
                setDensityModel(e.target.value);
                this.analyzer.invalidate();
                this._refreshModelState();
                this._scheduleRecompute(0);
            });
        }
        this._refreshModelState();
        // The MSIS WASM may be loading — re-check shortly so the badge
        // shows the right state without forcing a full poll loop.
        setTimeout(() => this._refreshModelState(), 1500);

        // Card-host event delegation: remove buttons + asset clicks.
        this._cardsHost.addEventListener('click', (e) => {
            const removeBtn = e.target.closest?.('button[data-remove-id]');
            if (removeBtn) { this.fleet.remove(removeBtn.dataset.removeId); return; }
            const refreshBtn = e.target.closest?.('button[data-refresh-id]');
            if (refreshBtn) { this.fleet.refresh(refreshBtn.dataset.refreshId); return; }
        });
    }

    async _uiAddNorad() {
        const inp = this.host.querySelector('#ua-fleet-add-norad');
        const id = parseInt(inp.value, 10);
        if (!Number.isInteger(id) || id <= 0) {
            this._setStatus('Enter a NORAD ID.', 'error'); return;
        }
        this._setStatus(`Fetching #${id}…`);
        const r = await this.fleet.addNorad(id);
        if (r.ok) {
            this._setStatus(`Added #${id}.`, 'ok');
            inp.value = '';
        } else {
            this._setStatus(`Add failed: ${r.reason}`, 'error');
        }
    }

    async _uiBulkAdd() {
        const sel = this.host.querySelector('#ua-fleet-add-group');
        const n   = parseInt(this.host.querySelector('#ua-fleet-add-group-n').value, 10);
        const group = sel.value;
        const headroom = MAX_ASSETS - this.fleet.count();
        if (headroom <= 0) { this._setStatus('Fleet full.', 'error'); return; }
        const want = Math.min(headroom, Number.isFinite(n) && n > 0 ? n : headroom);
        this._setStatus(`Pulling ${want} from “${group}”…`);
        const r = await this.fleet.bulkAddGroup(group, want);
        if (r.added > 0) {
            this._setStatus(`Added ${r.added}; skipped ${r.skipped}.`, 'ok');
        } else {
            this._setStatus(`Bulk add failed (${Object.keys(r.reasons).join(', ')}).`, 'error');
        }
    }

    _uiAddPaste() {
        const ta = this.host.querySelector('#ua-fleet-tle-text');
        const txt = ta.value || '';
        const r = this.fleet.addTleBlock(txt);
        if (r.added > 0) {
            this._setStatus(`Pasted ${r.added}; skipped ${r.skipped}.`, 'ok');
            ta.value = '';
        } else {
            this._setStatus('Nothing parsed.', 'error');
        }
    }

    _setStatus(text, kind = 'info') {
        if (!this._statusEl) return;
        this._statusEl.textContent = text;
        this._statusEl.dataset.kind = kind;
    }

    _refreshModelState() {
        if (!this._modelStateEl) return;
        const sel = getDensityModel();
        if (sel === 'nrlmsise00') {
            this._modelStateEl.textContent = isMsisReady() ? '✓ live' : 'loading…';
            this._modelStateEl.dataset.kind = isMsisReady() ? 'ok' : 'pending';
        } else {
            this._modelStateEl.textContent = 'surrogate';
            this._modelStateEl.dataset.kind = 'info';
        }
    }

    _renderList() {
        if (!this._cardsHost) return;
        const results = this._results;
        this._countEl.textContent = `${this.fleet.count()} / ${MAX_ASSETS}`;
        if (results.length === 0) {
            this._cardsHost.innerHTML = `
                <div class="ua-fleet-empty">
                    No tracked assets. Add a NORAD ID, paste a TLE, or
                    bulk-import a constellation above.
                </div>`;
            return;
        }
        // Sort by severity DESC for ops-grade triage.
        const sorted = rankBySeverity(results);
        this._cardsHost.innerHTML = sorted.map(r => this._renderCard(r)).join('');
    }

    _renderCard(r) {
        const isReady = r.status === 'ready' && r.live && r.decay;
        const statusPill = r.status === 'ready' ? 'ua-fleet-pill--ok'
                         : r.status === 'pending' ? 'ua-fleet-pill--pending'
                         : 'ua-fleet-pill--err';
        const statusText = r.status === 'ready' ? 'LIVE'
                         : r.status === 'pending' ? 'LOADING'
                         : 'ERROR';

        if (!isReady) {
            const errLine = r.err ? `<div class="ua-fleet-card-err">${_esc(r.err)}</div>` : '';
            return `
                <div class="ua-fleet-card ua-fleet-card--unready" data-asset-id="${r.id}">
                    <div class="ua-fleet-card-head">
                        <span class="ua-fleet-name">${_esc(r.name)}</span>
                        <span class="ua-fleet-pill ${statusPill}">${statusText}</span>
                        <button class="ua-fleet-iconbtn" title="Remove"
                                data-remove-id="${r.id}">×</button>
                    </div>
                    ${errLine}
                </div>`;
        }

        const live = r.live;
        const risk = r.risk;
        const decay = r.decay;

        // Severity bucket → card border accent.
        const sev = risk?.severity ?? 0;
        const sevClass = sev >= 0.7 ? 'ua-fleet-card--sev-high'
                       : sev >= 0.4 ? 'ua-fleet-card--sev-med'
                       : 'ua-fleet-card--sev-low';

        const badges = [];
        if (risk?.fired?.reentryRisk) badges.push(`<span class="ua-fleet-badge ua-fleet-badge--high"
            title="Projected altitude < ${REENTRY_KM} km within horizon">REENTRY ≤ ${risk.reentryHr.toFixed(1)}h</span>`);
        if (risk?.fired?.decaySpike)  badges.push(`<span class="ua-fleet-badge ua-fleet-badge--med"
            title="Worst projected da/dt over horizon">↓ ${risk.maxDecayKmDay.toFixed(1)} km/day</span>`);
        if (risk?.fired?.dragStress)  badges.push(`<span class="ua-fleet-badge ua-fleet-badge--low"
            title="Sustained drag-stress hours over horizon">DRAG ${risk.sustainedDragHrs.toFixed(0)}h</span>`);

        // SVG mini-chart: nowcast vs forecast altitude over the horizon.
        const chart = _miniDecayChart(decay);

        // Live readouts.
        const altLine = `${live.altKm.toFixed(0)} km · ${live.speedKms.toFixed(2)} km/s`
                       + (live.q_pa ? ` · q ${(live.q_pa * 1e6).toFixed(2)} µPa` : '');
        const ssp = `lat ${live.latDeg.toFixed(1)}° / lon ${live.lonDeg.toFixed(1)}°`;
        const orbit = (live.period_min != null ? `T ${live.period_min.toFixed(1)} min · ` : '')
                    + (live.inclinationDeg != null ? `i ${live.inclinationDeg.toFixed(1)}°` : '');

        const noradTag = r.noradId
            ? `<span class="ua-fleet-norad">#${r.noradId}</span>` : '';

        return `
            <div class="ua-fleet-card ${sevClass}" data-asset-id="${r.id}">
                <div class="ua-fleet-card-head">
                    <span class="ua-fleet-name">${_esc(r.name)}</span>
                    ${noradTag}
                    <span class="ua-fleet-pill ${statusPill}">${statusText}</span>
                    ${r.noradId ? `<button class="ua-fleet-iconbtn" title="Re-fetch TLE"
                        data-refresh-id="${r.id}">⟳</button>` : ''}
                    <button class="ua-fleet-iconbtn" title="Remove"
                            data-remove-id="${r.id}">×</button>
                </div>
                <div class="ua-fleet-stats">
                    <div class="ua-fleet-stat-row">${altLine}</div>
                    <div class="ua-fleet-stat-row ua-dim">${ssp}</div>
                    <div class="ua-fleet-stat-row ua-dim">${orbit}</div>
                </div>
                ${badges.length ? `<div class="ua-fleet-badges">${badges.join('')}</div>` : ''}
                <div class="ua-fleet-chart">${chart}</div>
                <div class="ua-fleet-chart-key">
                    <span class="ua-fleet-key-now">— nowcast</span>
                    <span class="ua-fleet-key-fwd">— forecast (+${this._projHorizonHr}h)</span>
                    <span class="ua-fleet-key-band">▬ ±σ envelope</span>
                    ${_renderForecastChip(r.forecast)}
                </div>
            </div>`;
    }
}

// ── Forecast / skill chip ───────────────────────────────────────────────────
//
// Surfaces the AR(1) projector's confidence (the same `skill` score that
// dimmed the horizon pill in Phase 3) plus the projector-derived spread
// (±σ on F10.7, ±σ on Ap). Skill comes out of the projector already; the
// σ values are new in Phase 6. We render them tightly so the per-card
// chart key stays one line wide.

function _renderForecastChip(fc) {
    if (!fc) return '';
    const skillPct = Math.round(((fc.skill ?? 0) * 100));
    const sklClass = skillPct >= 75 ? 'ua-fleet-skill--high'
                   : skillPct >= 50 ? 'ua-fleet-skill--med'
                   : 'ua-fleet-skill--low';
    const sf = Number.isFinite(fc.sigmaF107) ? fc.sigmaF107.toFixed(0) : '—';
    const sa = Number.isFinite(fc.sigmaAp)   ? fc.sigmaAp.toFixed(0)   : '—';
    return `<span class="ua-fleet-skill ${sklClass}"
                  title="AR(1) forecast confidence at +${fc.horizonHr}h. σ_F10.7 = ${sf} SFU, σ_Ap = ${sa}.">
        ${skillPct}% · ±${sf} SFU / ±${sa} Ap
    </span>`;
}

// ── Inline SVG mini-chart ──────────────────────────────────────────────────
//
// Three-layer altitude-vs-time chart:
//
//   • Filled band:  ±σ uncertainty envelope (forcing ± σ_F10.7, ± σ_Ap
//                   driven through the same drag_decay_rk4 integrator,
//                   so the band is a real spread of decay trajectories
//                   — not a heuristic widened by horizon).
//   • Cyan line:    nowcast (drag-decay under current forcing).
//   • Amber dashed: forecast point (drag-decay under AR(1)-projected
//                   forcing). Always sits inside the band by construction.
//
// Fixed 240×56 viewBox; preserveAspectRatio="none" lets the card stretch
// the chart horizontally without distorting the data interpretation.

function _miniDecayChart(decay) {
    const W = 240, H = 56, PAD = 4;
    const a = decay.nowcast, b = decay.forecast;
    const lo = decay.envelopeBenign  || b;   // higher-alt (benign)
    const hi = decay.envelopeAdverse || b;   // lower-alt (adverse)
    if (!a?.length || !b?.length) {
        return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
                     class="ua-fleet-svg"></svg>`;
    }
    let xMin = a[0].t_min, xMax = a[a.length - 1].t_min;
    let yMin = Infinity, yMax = -Infinity;
    const span = (arr) => {
        for (const p of arr) {
            if (p.alt_km < yMin) yMin = p.alt_km;
            if (p.alt_km > yMax) yMax = p.alt_km;
        }
    };
    span(a); span(b); span(lo); span(hi);
    if (yMax - yMin < 0.5) yMax = yMin + 0.5;

    const sx = (t) => PAD + ((t - xMin) / (xMax - xMin)) * (W - 2 * PAD);
    const sy = (y) => H - PAD - ((y - yMin) / (yMax - yMin)) * (H - 2 * PAD);
    const linePath = (arr) => arr.map((p, i) =>
        `${i === 0 ? 'M' : 'L'}${sx(p.t_min).toFixed(1)},${sy(p.alt_km).toFixed(1)}`).join(' ');

    // Band polygon: upper edge (benign, higher alt) drawn left→right,
    // lower edge (adverse, lower alt) drawn right→left, then closed.
    // Both arrays share the same time grid (analyzer's dragOutMin), so
    // we can iterate by index instead of interpolating.
    let bandPath = null;
    if (lo.length === hi.length && lo.length >= 2) {
        const fwd = lo.map(p => `${sx(p.t_min).toFixed(1)},${sy(p.alt_km).toFixed(1)}`);
        const bak = hi.slice().reverse().map(p => `${sx(p.t_min).toFixed(1)},${sy(p.alt_km).toFixed(1)}`);
        bandPath = `M${fwd.join(' L')} L${bak.join(' L')} Z`;
    }

    // Reentry threshold gridline if it falls inside the y-range.
    const reentryLine = (REENTRY_KM > yMin && REENTRY_KM < yMax)
        ? `<line x1="${PAD}" x2="${W - PAD}"
                 y1="${sy(REENTRY_KM).toFixed(1)}" y2="${sy(REENTRY_KM).toFixed(1)}"
                 stroke="rgba(255,80,96,.45)" stroke-dasharray="3 3" stroke-width="1"/>`
        : '';

    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
                 class="ua-fleet-svg" aria-label="Altitude decay forecast with uncertainty envelope">
        ${bandPath ? `<path d="${bandPath}" fill="rgba(255,170,32,.18)" stroke="none"/>` : ''}
        ${reentryLine}
        <path d="${linePath(a)}" stroke="#0ff" stroke-width="1.4" fill="none"/>
        <path d="${linePath(b)}" stroke="#ffaa20" stroke-width="1.4" fill="none"
              stroke-dasharray="3 2"/>
    </svg>`;
}

const REENTRY_KM_LOCAL = REENTRY_KM;   // referenced inside _miniDecayChart

function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
