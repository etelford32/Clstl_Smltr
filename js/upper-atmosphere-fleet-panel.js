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
import { isMsisReady, f107AProvenance, apArrayProvenance } from './nrlmsise00-bridge.js';
import { isLoaded as isF107HistoryLoaded, ensureLoaded as ensureF107History, onUpdate as onF107Update }
    from './f107-history.js';
import { isLoaded as isApHistoryLoaded,   ensureLoaded as ensureApHistory,   onUpdate as onApUpdate }
    from './ap-history.js';
import {
    runBacktest, runFleetSkill, pickHistoricalForBacktest,
    detectAnomaly, detectFleetAnomalies,
    correlateAnomalyWithConjunctions, tallyAnomalyConjunctionCorrelations,
} from './upper-atmosphere-backtest.js';

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
        // Backtest state — survives re-renders so the operator's just-
        // computed validation doesn't blink away on the next realtime
        // tick. Keyed by asset.id; value is { running, result, pastedTle }.
        this._backtests = new Map();
        // Fleet-wide skill dashboard cache. Hashing on (asset.id, line1
        // epoch, historical-pick epoch, bcM2PerKg, bcSigmaRel) tuples
        // means realtime ticks don't re-run the (expensive) fleet-wide
        // backtest sweep; only TLE refreshes / membership changes /
        // BC edits do. `_fleetSkill` holds the last completed summary.
        this._fleetSkill = null;
        this._fleetSkillKey = '';
        this._fleetSkillRunning = false;
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
        this._unsubscribeF107?.();
        this._unsubscribeAp?.();
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

            // Phase 17: archive the live conjunction events the analyzer
            // just produced. Same-pair + TCA-window dedup happens inside
            // recordConjunctions, so re-running the same sweep doesn't
            // double-count — sightings just increments. Run BEFORE
            // _renderList so the panel's archive section reflects the
            // freshly-merged data on this paint.
            this.fleet.recordConjunctions(this.analyzer.lastConjunctions || []);

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
            <!-- Fleet-wide skill dashboard (Phase 14). Runs an auto-
                 backtest on every asset with archived TLE history and
                 surfaces the calibration aggregate. Sits ABOVE the
                 conjunction panel because "is the model honest about
                 my whole fleet?" is the top-level trust question. -->
            <div id="ua-fleet-skill" class="ua-fleet-skill"></div>
            <!-- Fleet-wide conjunction screen. Sits between the toolbar and
                 the per-asset card list so the operator sees pair-level
                 risk first, then drills into individual assets. -->
            <div id="ua-fleet-conj" class="ua-fleet-conj"></div>
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
        this._skillHost = this.host.querySelector('#ua-fleet-skill');
        this._conjHost  = this.host.querySelector('#ua-fleet-conj');
        this._countEl   = this.host.querySelector('#ua-fleet-count');
        this._statusEl  = this.host.querySelector('#ua-fleet-add-status');
        this._modelStateEl = this.host.querySelector('#ua-fleet-model-state');

        // Skill-dashboard event delegation:
        //   • [data-skill-refresh] — force a fresh sweep (operator can
        //     hit this after editing BCs / refreshing TLEs to get a
        //     fast skill update without waiting for the cache invalidation
        //     heuristic to notice).
        //   • [data-conj-jump-to] — the "worst" chip reuses the same
        //     selector pattern as the conjunction panel so we get
        //     scroll-and-flash for free.
        this._skillHost.addEventListener('click', (e) => {
            const refresh = e.target.closest?.('[data-skill-refresh]');
            if (refresh) {
                this._fleetSkillKey = ''; this._fleetSkill = null;
                this._maybeRunFleetSkill();
                return;
            }
            const jump = e.target.closest?.('[data-conj-jump-to]');
            if (jump) {
                this._jumpAndFlash(jump.dataset.conjJumpTo);
                return;
            }
        });
        // Conjunction-panel event delegation:
        //   • [data-conj-jump-to] on a row → scroll-and-flash that asset's card
        //   • [data-conj-threshold] on a chip → switch screening threshold
        // Both invalidate the analyzer cache so the next paint reflects
        // the new config; the threshold change also triggers a recompute
        // immediately rather than waiting for the next realtime tick.
        this._conjHost.addEventListener('click', (e) => {
            const jump = e.target.closest?.('[data-conj-jump-to]');
            if (jump) {
                this._jumpAndFlash(jump.dataset.conjJumpTo, jump.dataset.conjJumpPair);
                return;
            }
            const thresh = e.target.closest?.('[data-conj-threshold]');
            if (thresh) {
                const km = parseFloat(thresh.dataset.conjThreshold);
                if (Number.isFinite(km) && km > 0) {
                    this.analyzer.setConjunctionThreshold(km);
                    // Screening sphere always ≥ threshold; lift it
                    // proportionally so the candidate set stays sane.
                    this.analyzer.setConjunctionScreening(Math.max(km * 2, 50));
                    this.analyzer.invalidate();
                    this._scheduleRecompute(0);
                }
            }
        });

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
        // The MSIS WASM and the F10.7-history fetch are both async at
        // boot — re-check shortly so the badge shows the right state
        // without forcing a full poll loop.
        setTimeout(() => this._refreshModelState(), 1500);
        // Keep the badge in sync with the F10.7 series: when /api/noaa/
        // f107-history finally lands (or refreshes), refresh the chip
        // AND invalidate the analyzer cache so the next paint computes
        // against the real centred-81-day average instead of the
        // ring-buffer fallback that was used while the fetch was
        // in flight.
        ensureF107History().catch(() => {});
        this._unsubscribeF107 = onF107Update(() => {
            this.analyzer.invalidate();
            this._refreshModelState();
            this._scheduleRecompute(0);
        });
        // Same wiring for the Ap history — when /api/noaa/ap-history
        // lands, drop the cache so the next paint runs against the real
        // 7-slot ap_array instead of the ring-buffer fallback.
        ensureApHistory().catch(() => {});
        this._unsubscribeAp = onApUpdate(() => {
            this.analyzer.invalidate();
            this._refreshModelState();
            this._scheduleRecompute(0);
        });

        // Card-host event delegation: remove buttons + asset clicks.
        this._cardsHost.addEventListener('click', (e) => {
            const removeBtn = e.target.closest?.('button[data-remove-id]');
            if (removeBtn) { this.fleet.remove(removeBtn.dataset.removeId); return; }
            const refreshBtn = e.target.closest?.('button[data-refresh-id]');
            if (refreshBtn) { this.fleet.refresh(refreshBtn.dataset.refreshId); return; }
            const btRun = e.target.closest?.('button[data-bt-run]');
            if (btRun) { this._runBacktest(btRun.dataset.btRun); return; }
            // Track <details> open/close so re-renders preserve operator
            // state. The summary click fires before the open attribute
            // toggles, so we read the OPPOSITE of what's currently there.
            const sum = e.target.closest?.('.ua-fleet-backtest > summary');
            if (sum) {
                const det = sum.parentElement;
                const id  = det?.dataset.btAsset;
                if (id) {
                    const st = this._backtests.get(id) || {};
                    st.expanded = !det.open;
                    this._backtests.set(id, st);
                }
                return;
            }
        });
        // BC + BC σ editors are inputs (number / range), not buttons —
        // wire 'change' on the cards host so we don't bind per card.
        this._cardsHost.addEventListener('change', (e) => {
            const bcInput = e.target.closest?.('input[data-bc-id]');
            if (bcInput) {
                const id = bcInput.dataset.bcId;
                const v  = parseFloat(bcInput.value);
                if (this.fleet.setBc(id, v)) this.analyzer.invalidate(id);
                return;
            }
            const sigInput = e.target.closest?.('input[data-bc-sigma-id]');
            if (sigInput) {
                const id = sigInput.dataset.bcSigmaId;
                // UI value is a percentage (0..50). Convert to relative.
                const v  = parseFloat(sigInput.value) / 100;
                if (this.fleet.setBcSigma(id, v)) this.analyzer.invalidate(id);
                return;
            }
        });
        // Live-preview slider drags by updating the readout label without
        // committing; `change` (on release) does the actual store write.
        this._cardsHost.addEventListener('input', (e) => {
            const sigInput = e.target.closest?.('input[data-bc-sigma-id]');
            if (sigInput) {
                const lbl = sigInput.parentElement?.querySelector('.ua-fleet-bc-sigma-val');
                if (lbl) lbl.textContent = `${parseFloat(sigInput.value).toFixed(0)}%`;
                return;
            }
            // Persist backtest textarea content per-keystroke so a
            // realtime-tick repaint doesn't clobber the operator's
            // paste-in-progress. We only TOUCH state here; no re-render.
            const btTle = e.target.closest?.('textarea[data-bt-tle-id]');
            if (btTle) {
                const id = btTle.dataset.btTleId;
                const st = this._backtests.get(id) || {};
                st.pastedTle = btTle.value;
                this._backtests.set(id, st);
            }
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
        if (sel !== 'nrlmsise00') {
            this._modelStateEl.textContent = 'surrogate';
            this._modelStateEl.dataset.kind = 'info';
            this._modelStateEl.title = 'JS density surrogate (Jacchia-style)';
            return;
        }
        const msisReady = isMsisReady();
        if (!msisReady) {
            this._modelStateEl.textContent = 'loading…';
            this._modelStateEl.dataset.kind = 'pending';
            this._modelStateEl.title = '';
            return;
        }
        // Compact "f107A · ap" status pair. Each side reports its own
        // provenance source independently. Tooltip carries the long story.
        const fpv = isF107HistoryLoaded() ? f107AProvenance([]) : null;
        const apv = isApHistoryLoaded()   ? apArrayProvenance([]) : null;
        const fLabel = !fpv ? 'rb' : (
            fpv.kind === 'centred'      ? `cen(${fpv.observedSamples}o+${fpv.predictedSamples}p)` :
            fpv.kind === 'trailing'     ? `tr(${fpv.observedSamples}o)` :
            fpv.kind === 'out-of-range' ? 'oor' : 'rb'
        );
        const apLabel = !apv ? 'rb' : (
            apv.kind === 'observed'                  ? `obs(${apv.slotsObserved})`
          : apv.kind === 'mixed-observed-predicted'  ? `mix(${apv.slotsObserved}o+${apv.slotsPredicted}p)`
          : apv.kind === 'partial'                   ? `partial(${apv.slotsFallback}fb)`
          : 'rb'
        );
        this._modelStateEl.textContent = `✓ live · f107A ${fLabel} · ap ${apLabel}`;
        this._modelStateEl.dataset.kind = 'ok';
        this._modelStateEl.title =
            `f107A: ${this._provLong(fpv)}\n`
          + `ap_array: ${this._provLongAp(apv)}`;
    }

    _provLong(fpv) {
        if (!fpv) return 'F10.7 history not loaded — in-page ring-buffer proxy';
        if (fpv.kind === 'centred')
            return `centred 81-day F10.7 from real SWPC observed (${fpv.observedSamples}) + 45-day forecast (${fpv.predictedSamples})`;
        if (fpv.kind === 'trailing')
            return `trailing 81-day F10.7 — predicted feed unavailable, biased on fast solar climbs`;
        if (fpv.kind === 'out-of-range')
            return 'requested date outside cached F10.7 window';
        return 'F10.7 history loaded but no value';
    }
    _provLongAp(apv) {
        if (!apv) return 'Ap history not loaded — in-page ring-buffer proxy';
        if (apv.kind === 'observed')
            return `all 7 NRLMSISE-00 slots filled from real SWPC Kp→Ap (${apv.slotsObserved} observed)`;
        if (apv.kind === 'mixed-observed-predicted')
            return `mixed observed/predicted ap_array (${apv.slotsObserved}o + ${apv.slotsPredicted}p)`;
        if (apv.kind === 'partial')
            return `partial ap_array: ${apv.slotsFallback} slots fell back to Ap=4 climatology`;
        if (apv.kind === 'out-of-range')
            return 'requested date outside cached Ap window';
        return 'Ap history loaded but no value';
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
            // Conjunction + skill panels only make sense with assets
            // in play; hide when the fleet is empty.
            this._renderConjunctionPanel([]);
            this._fleetSkill = null; this._fleetSkillKey = '';
            this._renderSkillDashboard();
            return;
        }
        // Sort by severity DESC for ops-grade triage.
        const sorted = rankBySeverity(results);
        this._cardsHost.innerHTML = sorted.map(r => this._renderCard(r)).join('');
        // Render the fleet-wide conjunction summary from the analyzer's
        // last screening pass. Per-asset CONJ badges in each card still
        // show that asset's worst partner; this panel surfaces the
        // GLOBAL top-K so a high-P pair between two off-screen assets
        // doesn't get buried.
        this._renderConjunctionPanel(this.analyzer.lastConjunctions || []);
        // Render whatever skill data we have (or the empty hint) on
        // every paint — _maybeRunFleetSkill is the one that decides
        // whether to actually re-run the (expensive) sweep, gated on
        // its own cache key. Render is cheap; sweep is not.
        this._renderSkillDashboard();
        this._maybeRunFleetSkill();
    }

    // ── Fleet-wide conjunction panel ───────────────────────────────────────
    //
    // Renders top-K (default 5) conjunction events globally sorted by
    // P(conj) DESC, then by TCA ASC. Each row shows both partners, the
    // probability badge, time to closest approach, nominal min distance,
    // and (when MC bands were available) the relative along-track σ at
    // TCA that drove the probability.
    //
    // The header surfaces the current screening configuration so the
    // operator knows what they're reading; the threshold chips
    // (5/25/50 km) let them retune without leaving the panel.

    _renderConjunctionPanel(events) {
        if (!this._conjHost) return;
        const nAssets = this._results.length;
        if (nAssets < 2) {
            this._conjHost.innerHTML = '';
            return;
        }
        const threshold = this.analyzer.getConjunctionThreshold?.() ?? 25;
        const rho       = this.analyzer.getConjunctionCorrelation?.() ?? 0.8;
        const topK = events.slice(0, 5);
        const presets = [5, 25, 50];

        const header = `
            <div class="ua-fleet-conj-head">
                <span class="ua-fleet-conj-title">Pairwise conjunction screen</span>
                <span class="ua-fleet-conj-sub">
                    ${events.length} event${events.length === 1 ? '' : 's'}
                    within ${threshold} km · ρ=${rho.toFixed(1)}
                </span>
                <span class="ua-fleet-conj-thresh">
                    ${presets.map(km => `
                        <button type="button" data-conj-threshold="${km}"
                                class="ua-fleet-conj-chip${km === threshold ? ' is-active' : ''}"
                                title="Set screening threshold to ${km} km${km === 5 ? ' (CARA hard-alert volume)' : km === 25 ? ' (CARA screening volume)' : ' (loose screening)'}">
                            ${km} km
                        </button>`).join('')}
                </span>
            </div>`;

        if (topK.length === 0) {
            this._conjHost.innerHTML = `
                ${header}
                <div class="ua-fleet-conj-empty">
                    No close approaches within ${threshold} km over the next
                    ${this.analyzer._opts?.horizonHr ?? 72} h.
                </div>`;
            return;
        }

        const rows = topK.map(e => {
            const pct = Math.round((e.pConj ?? 0) * 100);
            const sevClass = pct >= 50 ? 'is-high' : pct >= 10 ? 'is-med' : 'is-low';
            const sigmaTxt = Number.isFinite(e.sigmaKm)
                ? `σ ${e.sigmaKm.toFixed(1)} km`
                : 'σ —';
            const hrs = e.tcaMin / 60;
            const hrsTxt = hrs < 1 ? `${(hrs * 60).toFixed(0)} min`
                         : hrs < 24 ? `${hrs.toFixed(1)} h`
                         : `${(hrs / 24).toFixed(1)} d`;
            // Each row is clickable on both ends — clicking either name
            // jumps to that asset's card. The pair is also passed so the
            // flash animation can highlight both at once.
            const tooltip = `Nominal min ${e.dMinKm.toFixed(1)} km at +${hrsTxt}.\n`
                + (Number.isFinite(e.sigmaKm)
                    ? `MC σ_rel = ${e.sigmaKm.toFixed(1)} km along-track at TCA\n`
                      + `(σ_A=${e.sigmaA?.toFixed(1) ?? '—'} km, σ_B=${e.sigmaB?.toFixed(1) ?? '—'} km, ρ=${e.correlation.toFixed(1)}).\n`
                      + `P(d ≤ ${e.thresholdKm} km) = ${pct}%`
                    : 'MC bands unavailable — probability from nominal distance only.');
            return `
                <div class="ua-fleet-conj-row ${sevClass}" title="${tooltip}">
                    <span class="ua-fleet-conj-prob">${pct}%</span>
                    <span class="ua-fleet-conj-pair">
                        <button type="button" class="ua-fleet-conj-name"
                                data-conj-jump-to="${e.idA}" data-conj-jump-pair="${e.idB}">
                            ${_esc(e.nameA)}
                        </button>
                        <span class="ua-fleet-conj-sep">↔</span>
                        <button type="button" class="ua-fleet-conj-name"
                                data-conj-jump-to="${e.idB}" data-conj-jump-pair="${e.idA}">
                            ${_esc(e.nameB)}
                        </button>
                    </span>
                    <span class="ua-fleet-conj-tca">+${hrsTxt}</span>
                    <span class="ua-fleet-conj-d">${e.dMinKm.toFixed(1)} km</span>
                    <span class="ua-fleet-conj-sig">${sigmaTxt}</span>
                </div>`;
        }).join('');

        this._conjHost.innerHTML = `${header}<div class="ua-fleet-conj-rows">${rows}</div>`
            + this._renderConjunctionArchiveSection();
    }

    /**
     * Recent close-approaches section (Phase 17). Shows the top
     * historical pairs from the archive — entries whose tcaAbsMs is
     * already in the past — so operators see "Starlink-2944 has been
     * a frequent partner over the last 14 days, 4 separate encounters,
     * worst miss was 5 km".
     *
     * Live (pending) events are NOT shown here — they're already in
     * the top-5 above and we don't want to duplicate. The archive
     * surface answers a different question: "what has been happening
     * historically?" not "what's about to happen?".
     */
    _renderConjunctionArchiveSection() {
        const archive = this.fleet.getConjunctionArchive?.() || [];
        const now = Date.now();
        const HISTORICAL_WINDOW_DAYS = 14;
        const cutoff = now - HISTORICAL_WINDOW_DAYS * 86400000;
        // Only show events whose TCA has already passed (truly historical)
        // AND whose tcaAbsMs is within the operator-relevant window.
        const past = archive.filter(e =>
            Number.isFinite(e.tcaAbsMs)
            && e.tcaAbsMs < now
            && e.tcaAbsMs >= cutoff
        );
        if (past.length === 0) return '';

        // Group by pair, aggregate stats — same idea as the per-asset
        // tally but fleet-wide.
        const byPair = new Map();
        for (const e of past) {
            const stat = byPair.get(e.pairKey) || {
                pairKey: e.pairKey,
                idA: e.idA, idB: e.idB,
                nameA: e.nameA, nameB: e.nameB,
                encounters: 0,
                worstDMinKm: Infinity,
                lastTcaMs: 0,
                sightings: 0,
            };
            stat.encounters++;
            stat.sightings += e.sightings ?? 1;
            if (Number.isFinite(e.dMinKm) && e.dMinKm < stat.worstDMinKm) stat.worstDMinKm = e.dMinKm;
            if (e.tcaAbsMs > stat.lastTcaMs) stat.lastTcaMs = e.tcaAbsMs;
            byPair.set(e.pairKey, stat);
        }
        const pairs = [...byPair.values()]
            .sort((a, b) => b.encounters - a.encounters || a.worstDMinKm - b.worstDMinKm)
            .slice(0, 5);

        const rows = pairs.map(p => {
            const ageMs = now - p.lastTcaMs;
            const ageStr = ageMs < 3600000      ? `${Math.round(ageMs / 60000)} min ago`
                         : ageMs < 86400000     ? `${Math.round(ageMs / 3600000)} h ago`
                         :                         `${Math.round(ageMs / 86400000)} d ago`;
            const worstTxt = Number.isFinite(p.worstDMinKm) ? `${p.worstDMinKm.toFixed(1)} km` : '—';
            const tooltip = `${p.encounters} encounter${p.encounters === 1 ? '' : 's'}`
                + ` over the last ${HISTORICAL_WINDOW_DAYS} days`
                + `\nworst miss: ${worstTxt}, most recent ${ageStr}`
                + `\n${p.sightings} sweep observation${p.sightings === 1 ? '' : 's'}`
                + (p.encounters > p.sightings ? '' : ` (each event seen across ${(p.sightings / p.encounters).toFixed(1)} sweeps)`);
            return `
                <div class="ua-fleet-conj-arch-row" title="${tooltip}">
                    <span class="ua-fleet-conj-arch-cnt">×${p.encounters}</span>
                    <span class="ua-fleet-conj-pair">
                        <button type="button" class="ua-fleet-conj-name"
                                data-conj-jump-to="${p.idA}" data-conj-jump-pair="${p.idB}">
                            ${_esc(p.nameA)}
                        </button>
                        <span class="ua-fleet-conj-sep">↔</span>
                        <button type="button" class="ua-fleet-conj-name"
                                data-conj-jump-to="${p.idB}" data-conj-jump-pair="${p.idA}">
                            ${_esc(p.nameB)}
                        </button>
                    </span>
                    <span class="ua-fleet-conj-arch-d">worst ${worstTxt}</span>
                    <span class="ua-fleet-conj-arch-age">${ageStr}</span>
                </div>`;
        }).join('');

        return `
            <div class="ua-fleet-conj-arch">
                <div class="ua-fleet-conj-arch-head">
                    Recent close approaches
                    <span class="ua-fleet-conj-arch-sub">
                        last ${HISTORICAL_WINDOW_DAYS} d · ${past.length} event${past.length === 1 ? '' : 's'}
                        across ${byPair.size} pair${byPair.size === 1 ? '' : 's'}
                    </span>
                </div>
                <div class="ua-fleet-conj-arch-rows">${rows}</div>
            </div>`;
    }

    /**
     * Scroll the target asset's card into view and briefly flash it (and
     * its partner if given) so the operator can spot the conjunction
     * geometry on the per-card chart. The flash class is removed after
     * the CSS animation completes — no JS animation loop needed.
     */
    _jumpAndFlash(idA, idB) {
        if (!this._cardsHost) return;
        const cardA = this._cardsHost.querySelector(`[data-asset-id="${CSS.escape(idA)}"]`);
        const cardB = idB ? this._cardsHost.querySelector(`[data-asset-id="${CSS.escape(idB)}"]`) : null;
        if (cardA) {
            cardA.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        for (const el of [cardA, cardB]) {
            if (!el) continue;
            el.classList.remove('ua-fleet-card--flash');
            // Force a reflow so the same flash can re-trigger on rapid
            // back-and-forth clicks. Reading offsetHeight commits the
            // class removal before we re-add it.
            // eslint-disable-next-line no-unused-expressions
            void el.offsetHeight;
            el.classList.add('ua-fleet-card--flash');
            setTimeout(() => el.classList.remove('ua-fleet-card--flash'), 1500);
        }
    }

    // ── Fleet-wide skill dashboard ──────────────────────────────────────────
    //
    // Runs a 7-day backtest on every asset with eligible TLE history,
    // aggregates the calibration verdicts, surfaces a one-line summary
    // at the top of the panel. Compute is gated on a cache key derived
    // from the assets' current+historical TLE epochs + BC params, so
    // realtime ticks don't trigger redundant sweeps — only TLE refreshes
    // or fleet-membership changes do.

    _fleetSkillCacheKey() {
        const fleet = this.fleet.list();
        return fleet.map(a => {
            const pick = pickHistoricalForBacktest(a) || {};
            return `${a.id}|${a.line1?.slice(18, 32) ?? ''}|${pick.line1?.slice(18, 32) ?? ''}`
                 + `|${Math.round((a.bcM2PerKg ?? 0) * 1e6)}|${Math.round((a.bcSigmaRel ?? 0) * 1000)}`;
        }).join(';');
    }

    /**
     * Kick the fleet-skill backtest if (a) we don't have a result yet,
     * or (b) the cache key has changed (TLE refresh / fleet edit). Runs
     * the actual sweep async so the realtime tick stays responsive.
     */
    async _maybeRunFleetSkill() {
        if (this._fleetSkillRunning) return;
        if (!isMsisReady()) return;            // analyzer can't backtest without MSIS
        const fleet = this.fleet.list();
        if (fleet.length < 1) {
            this._fleetSkill = null; this._fleetSkillKey = '';
            this._renderSkillDashboard();
            return;
        }
        const key = this._fleetSkillCacheKey();
        if (key === this._fleetSkillKey && this._fleetSkill) return;
        this._fleetSkillRunning = true;
        // Repaint with a "running" placeholder so the operator knows
        // a sweep is in flight (skill backtests take a few seconds at
        // 25 assets × 24-MC × 7-day sequential).
        this._renderSkillDashboard({ running: true });
        try {
            const out = await runFleetSkill(fleet, { targetDays: 7, monteCarloN: 24 });
            this._fleetSkill = out;
            this._fleetSkillKey = key;
            // Phase 15: persist each asset's residual into its rolling
            // history so the anomaly detector has a time series. Same-pair
            // dedup is handled inside recordResidual — re-running on the
            // same TLE pair won't pollute the series.
            for (const id of Object.keys(out.results || {})) {
                const r = out.results[id];
                if (r.status !== 'ok' || !Number.isFinite(r.residual_km)) continue;
                const a = this.fleet.findById(id);
                if (!a) continue;
                this.fleet.recordResidual(id, {
                    ranAt:             out.summary.ranAt,
                    residual_km:       r.residual_km,
                    relativeError:     r.relativeError,
                    deltaDays:         r.deltaDays,
                    historicalEpochMs: r.historicalEpochMs ?? null,
                    currentEpochMs:    r.currentEpochMs ?? null,
                    bcM2PerKg:         a.bcM2PerKg,
                    bcSigmaRel:        a.bcSigmaRel,
                });
            }
        } catch (err) {
            console.warn('[FleetPanel] fleet-skill sweep failed:', err?.message || err);
            this._fleetSkill = null;
        } finally {
            this._fleetSkillRunning = false;
            this._renderSkillDashboard();
        }
    }

    _renderSkillDashboard(opts = {}) {
        if (!this._skillHost) return;
        const fleet = this.fleet.list();
        if (fleet.length === 0) { this._skillHost.innerHTML = ''; return; }

        if (opts.running) {
            this._skillHost.innerHTML = `
                <div class="ua-fleet-skill-head">
                    <span class="ua-fleet-skill-title">Fleet-wide skill</span>
                    <span class="ua-fleet-skill-sub">running 7-day backtest sweep…</span>
                </div>`;
            return;
        }

        if (!this._fleetSkill?.summary) {
            // First mount, no data yet — show the empty hint so the
            // operator knows the dashboard exists and what's needed
            // for it to populate.
            this._skillHost.innerHTML = `
                <div class="ua-fleet-skill-head">
                    <span class="ua-fleet-skill-title">Fleet-wide skill</span>
                    <span class="ua-fleet-skill-sub">
                        no historical TLEs yet — use the ⟳ button on each card
                        over a few days to accumulate skill data
                    </span>
                </div>`;
            return;
        }

        const s = this._fleetSkill.summary;
        const has = s.eligible > 0;
        const calPct = has ? Math.round(s.calibratedFrac * 100) : null;
        const calClass = !has ? 'is-empty'
                       : calPct >= 75 ? 'is-high'
                       : calPct >= 50 ? 'is-med'
                       : 'is-low';
        // Phase 15 anomaly tally — runs locally over the asset histories,
        // independent of the runFleetSkill output. Always cheap (no
        // backtest re-run; just per-asset median+MAD on the stored series).
        const anomSweep = detectFleetAnomalies(fleet);
        const anomCnt = anomSweep.summary.anomalous;
        // Phase 18: cross-check anomalies against the conjunction archive
        // for likely "maneuver after high-P conjunction" pattern. Re-uses
        // the per-asset detector outputs we just computed; archive lookup
        // is O(events) per asset. Bounded by anomaly count.
        const conjArchive = this.fleet.getConjunctionArchive?.() || [];
        const corrTally = tallyAnomalyConjunctionCorrelations(
            fleet, anomSweep.byId, conjArchive);
        const anomLabel = anomCnt === 0 ? ''
            : corrTally.related > 0
                ? `⚠ ${anomCnt} anomaly${anomCnt === 1 ? '' : 'ies'}`
                  + ` (${corrTally.related} likely conj)`
                : `⚠ ${anomCnt} anomaly${anomCnt === 1 ? '' : 'ies'}`;
        const anomTitle = corrTally.related > 0
            ? `Assets whose latest residual is >3σ off their own historical`
              + ` median AND >0.5 km in magnitude. `
              + `${corrTally.related} of the ${anomCnt} anomalies coincide`
              + ` with a recent high-P conjunction — most likely caused by`
              + ` avoidance maneuvers. Click each card's ANOMALY badge`
              + ` for the breakdown.`
            : `Assets whose latest residual is >3σ off their own historical`
              + ` median AND >0.5 km in magnitude. Click each card's`
              + ` ANOMALY badge for the breakdown.`;

        const counts = `
            <span class="ua-fleet-skill-cnt ua-fleet-skill-cnt--cal">✓ ${s.calibrated} calibrated</span>
            ${s.over  ? `<span class="ua-fleet-skill-cnt ua-fleet-skill-cnt--over">↑ ${s.over} over</span>`   : ''}
            ${s.under ? `<span class="ua-fleet-skill-cnt ua-fleet-skill-cnt--under">↓ ${s.under} under</span>` : ''}
            ${anomCnt ? `<span class="ua-fleet-skill-cnt ua-fleet-skill-cnt--anom"
                              title="${anomTitle}">
                              ${anomLabel}</span>` : ''}
            ${s.noHistory ? `<span class="ua-fleet-skill-cnt ua-fleet-skill-cnt--gap">∅ ${s.noHistory} no-hist</span>` : ''}
            ${s.driverGap ? `<span class="ua-fleet-skill-cnt ua-fleet-skill-cnt--gap">⚠ ${s.driverGap} driver-gap</span>` : ''}
            ${s.tooRecent ? `<span class="ua-fleet-skill-cnt ua-fleet-skill-cnt--gap">⏳ ${s.tooRecent} too-recent</span>` : ''}
            ${s.failed    ? `<span class="ua-fleet-skill-cnt ua-fleet-skill-cnt--gap">✗ ${s.failed} failed</span>`         : ''}`;
        const ageSec = Math.round((Date.now() - s.ranAt) / 1000);
        const ageStr = ageSec < 60 ? `${ageSec}s ago`
                     : ageSec < 3600 ? `${Math.round(ageSec / 60)}m ago`
                     : `${Math.round(ageSec / 3600)}h ago`;
        const headLine = has
            ? `<span class="ua-fleet-skill-frac">${calPct}%</span> calibrated · n=${s.eligible}/${s.total}`
            : `<span class="ua-fleet-skill-frac is-empty">—</span> calibrated (none eligible)`;
        const medianTxt = (Number.isFinite(s.medianAbsResidualKm))
            ? `median |Δ| ${s.medianAbsResidualKm.toFixed(2)} km · p95 ${s.p95AbsResidualKm?.toFixed(2)} km`
            : '';
        // Worst-offender shout-out — clicking it jumps to that card.
        let worstChip = '';
        const results = this._fleetSkill.results || {};
        let worst = null;
        for (const id of Object.keys(results)) {
            const r = results[id];
            if (r.status !== 'ok' || r.inBand) continue;
            if (!worst || Math.abs(r.residual_km) > Math.abs(worst.residual_km)) worst = r;
        }
        if (worst) {
            const sign = worst.residual_km >= 0 ? '+' : '−';
            worstChip = `
                <button type="button" class="ua-fleet-skill-worst"
                        data-conj-jump-to="${worst.assetId}"
                        title="${_esc(worst.name)}: model ${sign}${Math.abs(worst.residual_km).toFixed(2)} km off reality at +${worst.deltaDays?.toFixed(1) ?? '—'} d backtest">
                    worst: ${_esc(worst.name)} ${sign}${Math.abs(worst.residual_km).toFixed(1)} km
                </button>`;
        }
        this._skillHost.innerHTML = `
            <div class="ua-fleet-skill-head ${calClass}">
                <span class="ua-fleet-skill-title">Fleet-wide skill</span>
                <span class="ua-fleet-skill-line">${headLine}</span>
                <span class="ua-fleet-skill-meta">
                    ${s.targetDays}-day backtest · ${ageStr}
                </span>
                <button type="button" class="ua-fleet-conj-chip" data-skill-refresh="1"
                        title="Re-run the fleet-skill backtest sweep">↻</button>
            </div>
            <div class="ua-fleet-skill-row">${counts}</div>
            ${medianTxt ? `<div class="ua-fleet-skill-stat">${medianTxt}</div>` : ''}
            ${worstChip}`;
    }

    // ── Per-asset backtest UI ───────────────────────────────────────────────
    //
    // Operator pastes a historical TLE for the same asset; we forward-
    // propagate the model from that TLE's epoch through the observed
    // (F10.7, Ap) drivers to the current TLE's epoch and compare to
    // reality. The point error is the headline number; the MC verdict
    // tells the operator whether their assumed σ_BC was honest.
    //
    // Result lives in this._backtests so successive analyzer paints
    // don't blow it away. The form rebuilds on every paint but the
    // ── Phase 16: residual sparkline ─────────────────────────────────────
    //
    // Tiny inline chart of the asset's `residualHistory`, so the operator
    // sees the TRAJECTORY into anomaly rather than just the verdict. Same
    // BC-filter logic as detectAnomaly() — entries from before a BC edit
    // get trimmed because they're not comparable to the current config.
    //
    // Layered SVG (back→front):
    //   1. ±3σ band rectangle (faint amber) — only when σ > 0 (need ≥
    //      5 prior samples for a meaningful sigma; gated by the detector)
    //   2. median line (dashed cyan)
    //   3. connecting polyline (subtle grey)
    //   4. per-sample dots, latest one bigger + coloured by anomaly:
    //        red if isAnomaly, green if in-band, amber otherwise.
    //
    // Visible from 3 samples onward — gives the operator the trajectory
    // even before the detector has enough samples to fire (so they can
    // already see a drift coming).
    _renderResidualSparkline(asset, det) {
        if (!asset?.residualHistory?.length) return '';
        // Mirror the detector's filter: same BC params only. Edits to
        // σ_BC create a discontinuity we shouldn't smooth over.
        const bc  = asset.bcM2PerKg ?? null;
        const bcS = asset.bcSigmaRel ?? null;
        const tol = 1e-6;
        const filtered = asset.residualHistory.filter(e =>
            Math.abs((e.bcM2PerKg  ?? bc)  - bc)  < tol &&
            Math.abs((e.bcSigmaRel ?? bcS) - bcS) < tol);
        if (filtered.length < 3) return '';
        const sorted = filtered.slice().sort((a, b) => a.ranAt - b.ranAt);
        const values = sorted.map(e => e.residual_km);

        const W = 160, H = 28, PAD_X = 3, PAD_Y = 4;

        // Use the detector's median / σ when we have them — they're the
        // canonical baseline + spread the badge fires against. When the
        // detector hasn't enough samples to compute them, fall back to
        // raw sample median (no band drawn).
        const median = Number.isFinite(det?.median) ? det.median
            : (() => {
                const s = values.slice().sort((a, b) => a - b);
                const n = s.length;
                return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
            })();
        const sigma  = Number.isFinite(det?.sigma) ? det.sigma : 0;

        // Y range: data + ±3σ band, padded by 5%.
        let yLo = Math.min(...values, median - 3 * sigma);
        let yHi = Math.max(...values, median + 3 * sigma);
        const yRange = Math.max(yHi - yLo, 0.01);
        yLo -= yRange * 0.05;
        yHi += yRange * 0.05;

        const sx = i => PAD_X + (W - 2 * PAD_X) * (i / Math.max(1, sorted.length - 1));
        const sy = v => H - PAD_Y - (H - 2 * PAD_Y) * ((v - yLo) / (yHi - yLo));

        const band = sigma > 0 ? (() => {
            const y1 = sy(median + 3 * sigma);
            const y2 = sy(median - 3 * sigma);
            return `<rect x="${PAD_X}" y="${y1.toFixed(1)}"
                          width="${(W - 2 * PAD_X).toFixed(1)}"
                          height="${(y2 - y1).toFixed(1)}"
                          fill="rgba(255,170,32,.10)"/>`;
        })() : '';
        const medY = sy(median);
        const medLine = `<line x1="${PAD_X}" x2="${W - PAD_X}"
                                y1="${medY.toFixed(1)}" y2="${medY.toFixed(1)}"
                                stroke="rgba(0,200,200,.40)"
                                stroke-dasharray="2 2" stroke-width="1"/>`;
        const path = sorted.map((p, i) =>
            `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(p.residual_km).toFixed(1)}`
        ).join(' ');

        const dots = sorted.map((p, i) => {
            const isLast = i === sorted.length - 1;
            const z = sigma > 0 ? Math.abs(p.residual_km - median) / sigma : 0;
            const colour = isLast && det?.isAnomaly  ? '#ff5060'
                         : isLast                    ? '#40e090'
                         : z >= 3                    ? '#ffaa20'
                                                     : '#9ab';
            const r = isLast ? 2.4 : 1.6;
            return `<circle cx="${sx(i).toFixed(1)}" cy="${sy(p.residual_km).toFixed(1)}"
                            r="${r}" fill="${colour}"/>`;
        }).join('');

        const latest = sorted[sorted.length - 1];
        const titleParts = [
            `Residual history (${sorted.length} samples after BC filter)`,
            `Latest: ${latest.residual_km.toFixed(2)} km`,
        ];
        if (Number.isFinite(median)) titleParts.push(`Median: ${median.toFixed(2)} km`);
        if (sigma > 0) titleParts.push(`σ (MAD): ${sigma.toFixed(2)} km`);
        if (Number.isFinite(det?.z)) titleParts.push(`z: ${det.z.toFixed(2)}`);
        return `
            <div class="ua-fleet-spark" title="${titleParts.join('\n')}">
                <span class="ua-fleet-spark-label">skill</span>
                <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
                     class="ua-fleet-spark-svg"
                     aria-label="Residual history sparkline">
                    ${band}${medLine}
                    <path d="${path}" stroke="rgba(150,170,200,.65)"
                          stroke-width="0.9" fill="none"/>
                    ${dots}
                </svg>
                <span class="ua-fleet-spark-n">n=${sorted.length}</span>
            </div>`;
    }

    // textarea value is preserved by reading from the stored state.

    _renderBacktestBlock(r) {
        const state = this._backtests.get(r.id) || {};
        const res   = state.result;
        const status = state.running ? 'running' : state.error ? 'error' : res?.ok ? 'ok' : 'idle';
        const summary = (() => {
            if (state.running) return 'Backtest running…';
            if (state.error)   return `Backtest failed: ${state.error}`;
            if (!res?.ok)      return 'Validate against historical TLE';
            const dT = res.deltaDays.toFixed(1);
            const sign = res.residual_km >= 0 ? '+' : '−';
            const rel = (Math.abs(res.relativeError) * 100).toFixed(2);
            const verdict = res.mc?.verdict ? ` · ${res.mc.verdict}` : '';
            return `${dT}-day backtest: ${sign}${Math.abs(res.residual_km).toFixed(2)} km (${rel}%)${verdict}`;
        })();
        const summaryClass = res?.ok
            ? (res.mc?.inBand ? 'is-ok' : 'is-warn')
            : (state.error ? 'is-warn' : '');

        const pasted = state.pastedTle ?? '';
        // Result panel — only rendered when we have one to show.
        let resultPanel = '';
        if (res?.ok) {
            const sign = res.residual_km >= 0 ? '+' : '−';
            const dT = res.deltaDays.toFixed(2);
            const f107M = res.drivers.meanF107.toFixed(0);
            const apM = res.drivers.meanAp.toFixed(0);
            const noradWarn = !res.noradMatch
                ? `<div class="ua-fleet-backtest-warn">⚠ NORAD ID mismatch — historical TLE may be a different asset</div>`
                : '';
            const mcRow = res.mc ? `
                <div class="ua-fleet-backtest-mcrow">
                    <span>MC band (n=${res.mc.n}): ${res.mc.p5_km.toFixed(1)} – ${res.mc.p95_km.toFixed(1)} km</span>
                    <span class="ua-fleet-backtest-verdict ua-fleet-backtest-verdict--${res.mc.inBand ? 'ok' : 'warn'}">
                        ${res.mc.verdict}
                    </span>
                </div>` : '';
            resultPanel = `
                <div class="ua-fleet-backtest-result">
                    ${noradWarn}
                    <div class="ua-fleet-backtest-numbers">
                        <span>predicted SMA <b>${res.a_pred_km.toFixed(2)} km</b></span>
                        <span>actual SMA <b>${res.a_real_km.toFixed(2)} km</b></span>
                        <span class="ua-fleet-backtest-resid">Δ ${sign}${Math.abs(res.residual_km).toFixed(2)} km</span>
                    </div>
                    ${mcRow}
                    <div class="ua-fleet-backtest-meta">
                        ${dT} days · mean F10.7=${f107M} SFU · mean Ap=${apM}
                        · ${res.drivers.days} day-step${res.drivers.days === 1 ? '' : 's'}
                    </div>
                </div>`;
        }
        return `
            <details class="ua-fleet-backtest ${summaryClass}" data-bt-asset="${r.id}"
                     ${state.expanded ? 'open' : ''}>
                <summary>↺ ${summary}</summary>
                <div class="ua-fleet-backtest-body">
                    <textarea class="ua-fleet-backtest-tle"
                              data-bt-tle-id="${r.id}"
                              placeholder="Paste a historical TLE for this asset (the 2-line or 3-line block you had ≤ 30 days ago)"
                    >${_esc(pasted)}</textarea>
                    <div class="ua-fleet-backtest-actions">
                        <button type="button" class="ua-fleet-btn ua-fleet-btn--primary"
                                data-bt-run="${r.id}" ${state.running ? 'disabled' : ''}>
                            ${state.running ? 'Running…' : 'Run backtest'}
                        </button>
                        <span class="ua-fleet-backtest-hint">
                            Needs observed F10.7 (~50 d) + Ap (~30 d) — older
                            TLEs will fail with drivers-unavailable.
                        </span>
                    </div>
                    ${resultPanel}
                </div>
            </details>`;
    }

    /** Triggered by the [data-bt-run] button click. Parses the pasted
     *  TLE, runs the backtest, stores the result, re-renders. */
    async _runBacktest(assetId) {
        const r = this._results.find(x => x.id === assetId);
        if (!r) return;
        const taEl = this._cardsHost.querySelector(`textarea[data-bt-tle-id="${CSS.escape(assetId)}"]`);
        const pasted = taEl?.value?.trim() ?? '';
        const state = this._backtests.get(assetId) || {};
        state.pastedTle = pasted;
        state.expanded  = true;
        if (!pasted) {
            state.error  = 'paste a historical TLE first';
            state.result = null;
            this._backtests.set(assetId, state);
            this._renderList();
            return;
        }
        const parsed = parseTleBlock(pasted);
        if (parsed.length === 0) {
            state.error  = 'TLE parse failed — check the block format';
            state.result = null;
            this._backtests.set(assetId, state);
            this._renderList();
            return;
        }
        // Find the current TLE on the asset from the fleet store.
        const asset = this.fleet.findById(assetId);
        if (!asset?.line1 || !asset?.line2) {
            state.error = 'current TLE missing — refresh the asset first';
            state.result = null;
            this._backtests.set(assetId, state);
            this._renderList();
            return;
        }
        state.running = true; state.error = null; state.result = null;
        this._backtests.set(assetId, state);
        this._renderList();
        try {
            const result = await runBacktest({
                historicalLine1: parsed[0].line1,
                historicalLine2: parsed[0].line2,
                currentLine1:    asset.line1,
                currentLine2:    asset.line2,
                bcM2PerKg:       asset.bcM2PerKg,
                bcSigmaRel:      asset.bcSigmaRel,
                monteCarloN:     32,
            });
            state.running = false;
            if (!result?.ok) {
                state.error  = result?.reason || 'backtest failed';
                state.result = null;
            } else {
                state.result = result;
                state.error  = null;
            }
        } catch (err) {
            state.running = false;
            state.error   = err?.message || 'backtest threw';
            state.result  = null;
        }
        this._backtests.set(assetId, state);
        this._renderList();
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
        // Monte Carlo probabilities. Only show non-zero probabilities so
        // the row doesn't shout at the operator for assets where the MC
        // never crossed the threshold — those badges represent the band
        // "tail risk" the binary threshold misses.
        if (Number.isFinite(risk?.pReentry) && risk.pReentry > 0.01) {
            const pct = (risk.pReentry * 100).toFixed(0);
            const cls = risk.pReentry >= 0.5 ? 'ua-fleet-badge--high'
                      : risk.pReentry >= 0.2 ? 'ua-fleet-badge--med'
                      : 'ua-fleet-badge--low';
            badges.push(`<span class="ua-fleet-badge ${cls}"
                title="Monte Carlo: P(altitude < ${REENTRY_KM} km within horizon) across ${decay?.mc?.n_used ?? 0} samples">P(reentry) ${pct}%</span>`);
        }
        if (Number.isFinite(risk?.pDecaySpike) && risk.pDecaySpike > 0.05) {
            const pct = (risk.pDecaySpike * 100).toFixed(0);
            badges.push(`<span class="ua-fleet-badge ua-fleet-badge--low"
                title="Monte Carlo: P(|da/dt| ≥ ${DECAY_SPIKE_KM_DAY} km/day at some point within horizon)">P(spike) ${pct}%</span>`);
        }

        // Conjunction badge — pick the asset's highest-P(conj) partner.
        // Only shown when P > 1% OR nominal min distance < threshold,
        // matching the operator's "worth a look" threshold from the
        // catalog screening conventions (CARA uses 1 km hard alert and
        // 25 km screening volume; we use 25 km as the badge trigger).
        const conj = Array.isArray(r.conjunctions) && r.conjunctions.length
            ? r.conjunctions[0] : null;
        if (conj && ((conj.pConj ?? 0) > 0.01 || conj.dMinKm <= conj.thresholdKm * 1.5)) {
            const partner = conj.idA === r.id ? conj.nameB : conj.nameA;
            const partnerId = conj.idA === r.id ? conj.idB : conj.idA;
            const pct = (conj.pConj * 100).toFixed(0);
            const hrs = (conj.tcaMin / 60).toFixed(1);
            const cls = conj.pConj >= 0.5 ? 'ua-fleet-badge--high'
                      : conj.pConj >= 0.1 ? 'ua-fleet-badge--med'
                      : 'ua-fleet-badge--low';
            const sigmaTxt = Number.isFinite(conj.sigmaKm)
                ? `\nMC σ_rel = ${conj.sigmaKm.toFixed(1)} km along-track at TCA (ρ=${conj.correlation.toFixed(1)} atmospheric correlation)`
                : '\nMC bands unavailable — probability from nominal min distance only';
            const title = `Closest approach with ${_esc(partner)}:`
                + `\nNominal min ${conj.dMinKm.toFixed(1)} km at +${hrs}h`
                + `\nP(d ≤ ${conj.thresholdKm} km) ≈ ${pct}%${sigmaTxt}`;
            badges.push(`<span class="ua-fleet-badge ${cls}" data-conj-partner="${partnerId}"
                              title="${title}">CONJ ${_esc(partner)} ${pct}%</span>`);
        }

        // Phase 15: anomaly badge. Reads from the asset's persisted
        // residual history; only fires when both the z-score AND the
        // magnitude floor (default 0.5 km) trip, so we don't spam the
        // operator about statistically-significant-but-trivial drift.
        const asset = this.fleet.findById(r.id);
        const anomDet = asset ? detectAnomaly(asset) : null;
        if (anomDet?.isAnomaly) {
            const dir = anomDet.direction === 'high'
                ? 'higher residual than baseline'
                : 'lower residual than baseline';
            const deltaKm = (anomDet.latestResidual - anomDet.median);
            const sign = deltaKm >= 0 ? '+' : '−';
            // Phase 18: try to attribute the anomaly to a recent
            // high-P conjunction. The archive lookup is O(events) and
            // cheap; we only run it when an anomaly already fired so
            // the cost is bounded by the anomaly count.
            const conjCorr = correlateAnomalyWithConjunctions(
                asset, anomDet, this.fleet.getConjunctionArchive?.() || []);

            const causeLines = conjCorr
                ? [
                    `\nPossible cause: avoidance maneuver after `
                    + `${conjCorr.partnerName} conjunction`
                    + (conjCorr.daysGap > 0
                        ? ` (TCA ${conjCorr.daysGap.toFixed(1)} d ago, P(conj) ${(conjCorr.pConj*100).toFixed(0)}%)`
                        : ` (TCA ${(-conjCorr.daysGap).toFixed(1)} d ahead — pre-emptive burn?, P(conj) ${(conjCorr.pConj*100).toFixed(0)}%)`),
                    `Other plausible causes: attitude change, geometry change, debris event.`,
                  ]
                : [
                    `\nPossible causes: recent maneuver, attitude change, geometry change, debris event.`,
                  ];
            const aTitle = `Anomaly detected — latest residual ${sign}${Math.abs(deltaKm).toFixed(2)} km off median.\n`
                + `Sample: ${anomDet.sampleCount} prior obs · median ${anomDet.median.toFixed(2)} km · σ ${anomDet.sigma.toFixed(2)} km\n`
                + `z = ${anomDet.z.toFixed(1)} (${dir})`
                + causeLines.join('\n') + '\n'
                + `Refresh TLE history with ⟳ over a few days to confirm or clear.`;
            // Augment the badge label with a one-word hint when we have
            // a likely conjunction-related cause. Operators see the
            // suspect inline; the tooltip carries the full attribution.
            const conjHint = conjCorr ? ' · likely conj' : '';
            badges.push(`<span class="ua-fleet-badge ua-fleet-badge--high ua-fleet-badge-anom"
                              title="${aTitle}">⚠ ANOMALY z=${anomDet.z.toFixed(1)}σ${conjHint}</span>`);
        }
        // Phase 17: frequent-partner chip — surfaces "this asset has
        // been a frequent conjunction partner over the last 14 days,
        // pattern of concern". Computed from the persistent archive,
        // so the chip survives across page reloads. Only fires when
        // the asset has at least one historical encounter (i.e. a TCA
        // that has already passed). Live encounters (still pending)
        // are already in the conjunction panel above.
        if (asset) {
            const stats = this.fleet.getConjunctionStats?.(asset.id, 14);
            if (stats && stats.encounters >= 1) {
                const top = stats.partnerTallies[0];
                const worst = Number.isFinite(stats.worstDMinKm)
                    ? `${stats.worstDMinKm.toFixed(1)} km` : '—';
                const cls = stats.encounters >= 4 ? 'ua-fleet-badge--high'
                          : stats.encounters >= 2 ? 'ua-fleet-badge--med'
                                                  : 'ua-fleet-badge--low';
                const partnerListTxt = stats.partnerTallies.slice(0, 4).map(p =>
                    `  • ${p.partnerName} ×${p.encounters}`
                    + (Number.isFinite(p.worstDMinKm) ? ` (worst ${p.worstDMinKm.toFixed(1)} km)` : '')
                ).join('\n');
                const tooltip = `${stats.encounters} historical close approach`
                    + (stats.encounters === 1 ? '' : 'es')
                    + ` over the last ${stats.windowDays} days`
                    + ` across ${stats.uniquePartners} unique partner`
                    + (stats.uniquePartners === 1 ? '' : 's')
                    + `\nWorst miss: ${worst}`
                    + (top ? `\n\nPartners:\n${partnerListTxt}` : '')
                    + `\n\nClick a name in the Recent close approaches`
                    + ` panel to jump to that asset.`;
                badges.push(`<span class="ua-fleet-badge ${cls}" title="${tooltip}">
                    PARTNERS ×${stats.encounters} · worst ${worst}</span>`);
            }
        }
        // Phase 16: residual sparkline — shown whenever ≥3 same-BC
        // entries exist, regardless of whether the detector has enough
        // for a full anomaly verdict. Lets operators see drift
        // BEFORE it crosses the 3σ threshold.
        const sparkline = asset ? this._renderResidualSparkline(asset, anomDet) : '';

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

        // Per-asset BC + BC σ editor. Collapsed by default — operators
        // configure once per asset and then forget. The σ slider is
        // capped at 50% because anything beyond that is "we don't know
        // the asset" rather than a meaningful uncertainty band.
        const bcSigPct = ((r.forecast?.bcSigmaRel ?? 0.15) * 100).toFixed(0);
        const bcEditor = `
            <details class="ua-fleet-bc-editor">
                <summary>BC = ${r.bcM2PerKg.toFixed(4)} m²/kg · σ ${bcSigPct}%</summary>
                <div class="ua-fleet-bc-row">
                    <label>BC (m²/kg)
                        <input type="number" min="0.001" max="0.5" step="0.001"
                               value="${r.bcM2PerKg.toFixed(4)}"
                               data-bc-id="${r.id}"
                               class="ua-fleet-input ua-fleet-bc-num">
                    </label>
                    <label>σ
                        <input type="range" min="0" max="50" step="1"
                               value="${bcSigPct}"
                               data-bc-sigma-id="${r.id}"
                               class="ua-fleet-bc-sigma">
                        <span class="ua-fleet-bc-sigma-val">${bcSigPct}%</span>
                    </label>
                </div>
            </details>`;

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
                ${sparkline}
                ${bcEditor}
                ${this._renderBacktestBlock(r)}
                <div class="ua-fleet-chart">${chart}</div>
                <div class="ua-fleet-chart-key">
                    <span class="ua-fleet-key-now">— nowcast</span>
                    <span class="ua-fleet-key-fwd">— ${r.decay?.mc ? `MC p50 (n=${r.decay.mc.n_used})` : 'forecast'} (+${this._projHorizonHr}h)</span>
                    <span class="ua-fleet-key-band">▬ ${r.decay?.mc ? 'p5–p95 band' : '±σ envelope'}</span>
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
    const bcPct = Number.isFinite(fc.bcSigmaRel) ? (fc.bcSigmaRel * 100).toFixed(0) : null;
    const jointPct = Number.isFinite(fc.jointSigmaRel)
        ? (fc.jointSigmaRel * 100).toFixed(0) : null;
    // Tooltip carries the full breakdown: AR(1) forecast σ on F10.7/Ap,
    // ballistic-coefficient σ, and the joint operator-grade envelope σ
    // (worst-case correlated stack — see analyzer for rationale).
    const title = `AR(1) forecast confidence at +${fc.horizonHr}h.`
                + ` σ_F10.7 = ${sf} SFU, σ_Ap = ${sa}`
                + (bcPct !== null   ? `, σ_BC = ${bcPct}%`     : '')
                + (jointPct !== null ? `\nJoint drag σ = ${jointPct}%` : '')
                + ' (envelope width).';
    const jointSuffix = jointPct !== null ? ` · drag ±${jointPct}%` : '';
    return `<span class="ua-fleet-skill ${sklClass}" title="${title}">
        ${skillPct}% · ±${sf} SFU / ±${sa} Ap${jointSuffix}
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
    const a = decay.nowcast;
    // MC bands take priority over the Phase 6/8 worst-case stack — they're
    // the proper independent-quadrature combination of forcing + BC σ and
    // are ~30% tighter than the stack. When MC didn't run (WASM still
    // loading, or sweep failed) we drop back to envelopeBenign/Adverse
    // so the band never disappears.
    //
    // Polygon-edge convention (kept from Phase 6 for renderer symmetry):
    //   `lo` = UPPER edge of the polygon = HIGH altitude trajectory
    //          (= benign forcing / p95 altitude under MC)
    //   `hi` = LOWER edge of the polygon = LOW altitude trajectory
    //          (= adverse forcing / p5 altitude under MC)
    const mc = decay.mc;
    const useMc = mc && mc.pLow?.length > 0 && mc.pHigh?.length > 0;
    const lo = useMc ? mc.pHigh : (decay.envelopeBenign  || decay.forecast);
    const hi = useMc ? mc.pLow  : (decay.envelopeAdverse || decay.forecast);
    // Centre line: MC median when available, otherwise the AR(1) point
    // forecast (which sits inside the band by construction in both modes).
    const b = (useMc && mc.pMed?.length > 0) ? mc.pMed : decay.forecast;
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
