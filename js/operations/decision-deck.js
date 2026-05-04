/**
 * decision-deck.js — Sat Ops decision panels for the Operations console.
 *
 * Three panels, all driven by the MyFleet store and the live SWPC
 * indices in provStore:
 *
 *   - My Fleet     : add by NORAD ID, preset chips, list with name + alt.
 *                    Anonymous fleets soft-save to localStorage (max 10).
 *
 *   - Decay Watch  : per-asset orbit lifetime estimate using King-Hele
 *                    via orbital-analytics.estimateOrbitLifetime, with a
 *                    composite confidence band (F10.7 forecast spread +
 *                    ±25% B* uncertainty in quadrature). Each row
 *                    carries a Δ icon so storm-driven shifts surface
 *                    naturally as F10.7 / Ap update.
 *
 *   - Conjunctions : on-demand 7-day SGP4 screen against the loaded
 *                    debris catalog. Shows count + closest approach for
 *                    each fleet asset.
 *
 *   - Prop Budget  : aggregate storm-overhead percentage versus
 *                    Ap=15 / F10.7=150 climatology — the headline
 *                    "extra propellant for current conditions" number.
 *
 * Provenance, bands, and Δ icons cascade in from the existing
 * primitives — this module just composes them on real values.
 */

import { provStore }          from './provenance.js';
import { bindBand }           from './bands.js';
import { attachDelta }        from './delta.js';
import { timeBus }            from './time-bus.js';
import { ConjunctionScreener } from './conjunction-screener.js';

/* ─── Decay heuristic ─────────────────────────────────────────
 * The existing js/orbital-analytics.js estimateOrbitLifetime() ships
 * a King-Hele-style derivation that has known unit-conversion issues
 * — it returns 0 days for every LEO target tested. Fixing that
 * function would change satellites.html numbers under everyone, so
 * we pin the Decay Watch surrogate inline here and label it clearly:
 *
 *   • baseMonths is a piecewise function of perigee altitude
 *     calibrated to NASA / ESA published decay reference values
 *     (ISS ~18 mo at calm, HST ~30 yr at calm, 800 km ~150 yr).
 *   • F10.7 modifier: lifetime ∝ (150 / F10.7)^1.5 — captures the
 *     dominant solar-driven thermospheric expansion sensitivity.
 *   • Ap modifier: lifetime ∝ (15 / Ap)^0.4 — secondary
 *     storm-driven density bump.
 *
 * Operators wanting decision-grade lifetime numbers want a real
 * SP propagator (STELA, HEAVENS) — this surrogate is for triage.
 * The provenance record makes that explicit, and Enterprise
 * customers can wire their own propagator output into the same
 * provStore key without touching the deck.
 */
function altPerigeeKmFromTle(tle) {
    if (Number.isFinite(tle?.perigee_km)) return tle.perigee_km;
    if (Number.isFinite(tle?.apogee_km) && Number.isFinite(tle?.perigee_km)) return tle.perigee_km;
    return null;
}

function baseLifetimeMonths(perigeeKm) {
    // Calibrated against NASA / ESA reference points: ISS at 415 km ≈ 2-3 yr
    // without reboost, HST at 540 km ≈ ~30 yr, ~800 km LEO ≈ 200+ yr.
    if (perigeeKm < 200) return 0.5;
    if (perigeeKm < 250) return 1.5;
    if (perigeeKm < 300) return 4;
    if (perigeeKm < 350) return 9;
    if (perigeeKm < 400) return 18;
    if (perigeeKm < 450) return 36;
    if (perigeeKm < 500) return 96;
    if (perigeeKm < 600) return 360;
    if (perigeeKm < 700) return 1200;
    if (perigeeKm < 800) return 3000;
    if (perigeeKm < 1000) return 8400;
    return Infinity;
}

function decayLifetimeDays(tle, f107, ap) {
    const perigee = altPerigeeKmFromTle(tle);
    if (perigee == null) return null;
    const base = baseLifetimeMonths(perigee);
    if (!Number.isFinite(base)) return Infinity;

    const f107Factor = Math.pow(150 / Math.max(60, f107),  1.5);
    const apFactor   = Math.pow(15  / Math.max(5,  ap),    0.4);
    const months = base * f107Factor * apFactor;
    return months * 30;
}

function decayWithSigma(tle, f107Mid, sigF107, apMid, sigAp) {
    const mid = decayLifetimeDays(tle, f107Mid, apMid);
    if (mid == null || !Number.isFinite(mid)) return { lifetime_days: mid, sigma_days: 0, perigee_km: altPerigeeKmFromTle(tle) };

    const hi = decayLifetimeDays(tle, f107Mid + sigF107, apMid + sigAp);
    const lo = decayLifetimeDays(tle, Math.max(60, f107Mid - sigF107), Math.max(5, apMid - sigAp));

    const sigDaysIdx = (Number.isFinite(hi) && Number.isFinite(lo))
        ? Math.abs(lo - hi) / 2
        : mid * 0.4;
    const sigDaysBC = mid * 0.25;
    const sigma = Math.sqrt(sigDaysIdx * sigDaysIdx + sigDaysBC * sigDaysBC);

    return {
        lifetime_days: mid,
        sigma_days:    sigma,
        perigee_km:    altPerigeeKmFromTle(tle),
    };
}

/** Format days into the most legible coarse unit. */
function fmtLifetime(days) {
    if (!Number.isFinite(days)) return '∞';
    if (days > 36500) return '>100 yr';
    if (days > 365)   return `${(days / 365.25).toFixed(1)} yr`;
    if (days > 60)    return `${Math.round(days / 30)} mo`;
    return `${Math.round(days)} d`;
}

/* ─── Storm overhead (prop budget) ────────────────────────── */

/**
 * Storm overhead percentage vs Ap=15 / F10.7=150 climatology.
 * Linearised approximation calibrated to match thermospheric density
 * sensitivity in the 200-600 km LEO band:
 *   +2.5% drag per Ap unit above 15
 *   +0.5% drag per SFU above 150
 * Composed multiplicatively. Real density is non-linear and altitude-
 * dependent; this is a sat-ops triage number, not a propulsion plan.
 */
export function stormOverheadPct(ap, f107) {
    if (!Number.isFinite(ap) || !Number.isFinite(f107)) return null;
    const apFactor   = 1 + (ap   - 15)  * 0.025;
    const f107Factor = 1 + (f107 - 150) * 0.005;
    const ratio = Math.max(0.1, apFactor) * Math.max(0.1, f107Factor);
    return (ratio - 1) * 100;
}

/* ─── My Fleet panel ──────────────────────────────────────── */

const PRESETS = Object.freeze([
    { norad: 25544, label: 'ISS' },
    { norad: 48274, label: 'CSS' },
    { norad: 20580, label: 'HST' },
    { norad: 43013, label: 'NOAA-20' },
]);

export function mountMyFleet(fleet, opts = {}) {
    const root = document.getElementById('op-fleet-panel-body');
    if (!root) return;
    const onSelect       = opts.onSelect       ?? (() => {});
    const getSelectedFn  = opts.getSelectedId  ?? (() => null);
    const onSelectChange = opts.onSelectChange ?? ((fn) => () => {});

    root.innerHTML = `
        <div class="op-fleet-add">
            <input type="text" id="op-fleet-input" placeholder="NORAD ID…" inputmode="numeric" maxlength="6">
            <button id="op-fleet-add-btn" type="button">Add</button>
        </div>
        <div class="op-fleet-presets">
            ${PRESETS.map(p => `<button class="op-fleet-preset" type="button" data-norad="${p.norad}">${p.label}</button>`).join('')}
        </div>
        <div class="op-fleet-msg" id="op-fleet-msg" aria-live="polite"></div>
        <ul class="op-fleet-list" id="op-fleet-list"></ul>
        <div class="op-fleet-empty" id="op-fleet-empty">
            Add up to ${fleet.constructor.MAX_ASSETS} assets — soft-saved locally.
        </div>
    `;

    const input  = root.querySelector('#op-fleet-input');
    const addBtn = root.querySelector('#op-fleet-add-btn');
    const msg    = root.querySelector('#op-fleet-msg');

    async function tryAdd(idRaw) {
        msg.textContent = '';
        msg.className   = 'op-fleet-msg';
        const r = await fleet.add(idRaw);
        if (!r.ok) {
            const reasons = {
                'invalid-id':    'Not a valid NORAD ID.',
                'already-added': 'Already in your fleet.',
                'fleet-full':    `Fleet full (max ${fleet.constructor.MAX_ASSETS}).`,
                'fetch-failed':  `Couldn't resolve TLE for #${r.id}.`,
            };
            msg.textContent = reasons[r.reason] ?? 'Add failed.';
            msg.classList.add('op-fleet-msg-err');
        }
    }

    addBtn.addEventListener('click', () => {
        const v = input.value.trim();
        if (v) tryAdd(v).then(() => { input.value = ''; });
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addBtn.click();
    });
    root.querySelectorAll('.op-fleet-preset').forEach(btn => {
        btn.addEventListener('click', () => tryAdd(btn.dataset.norad));
    });

    fleet.onChange((list) => {
        const ul = root.querySelector('#op-fleet-list');
        const empty = root.querySelector('#op-fleet-empty');
        empty.style.display = list.length === 0 ? '' : 'none';

        const selected = getSelectedFn();

        ul.innerHTML = list.map(a => {
            const stateCls = a.status === 'ready' ? '' : `op-fleet-row-${a.status}`;
            const selCls   = a.noradId === selected ? ' op-fleet-row-selected' : '';
            const altSpan = a.tle?.apogee_km != null
                ? `<span class="op-fleet-alt" id="op-alt-${a.noradId}">${Math.round((a.tle.apogee_km + a.tle.perigee_km) / 2)} km</span>`
                : `<span class="op-fleet-alt op-fleet-alt-pending">${a.status === 'error' ? 'unresolved' : 'loading…'}</span>`;
            return `
                <li class="op-fleet-row ${stateCls}${selCls}" data-norad="${a.noradId}" tabindex="0" role="button" aria-pressed="${a.noradId === selected ? 'true' : 'false'}">
                    <span class="op-fleet-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
                    <span class="op-fleet-norad">${a.noradId}</span>
                    ${altSpan}
                    <button class="op-fleet-remove" type="button" aria-label="Remove" data-remove="${a.noradId}">×</button>
                </li>
            `;
        }).join('');

        ul.querySelectorAll('[data-remove]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                fleet.remove(parseInt(btn.dataset.remove, 10));
            });
        });
        ul.querySelectorAll('.op-fleet-row').forEach(row => {
            const id = parseInt(row.dataset.norad, 10);
            const select = () => onSelect(getSelectedFn() === id ? null : id);
            row.addEventListener('click', select);
            row.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    select();
                }
            });
        });
    });

    // Re-paint selection state when visuals announces a change from
    // elsewhere (e.g. globe pick, conjunction-row click).
    onSelectChange(() => {
        const ul = root.querySelector('#op-fleet-list');
        if (!ul) return;
        const selected = getSelectedFn();
        ul.querySelectorAll('.op-fleet-row').forEach(row => {
            const on = parseInt(row.dataset.norad, 10) === selected;
            row.classList.toggle('op-fleet-row-selected', on);
            row.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    });
}

/* ─── Decay Watch panel ───────────────────────────────────── */

export function mountDecayWatch(fleet) {
    const root = document.getElementById('op-decay-list');
    if (!root) return;

    function recompute() {
        const list = fleet.list();
        const f107 = provStore.get('idx.f107')?.value ?? 150;
        const sigF107 = provStore.get('idx.f107')?.sigma ?? 12;
        const ap   = provStore.get('idx.ap')?.value   ?? 15;
        const sigAp = provStore.get('idx.ap')?.sigma  ?? 6;

        if (list.length === 0) {
            root.innerHTML = `<div class="op-deck-empty">Add assets to see decay estimates.</div>`;
            return;
        }

        let html = '';
        for (const a of list) {
            const rowId = `op-decay-life-${a.noradId}`;
            const trendId = `op-decay-trend-${a.noradId}`;
            html += `
                <li class="op-decay-row" data-norad="${a.noradId}">
                    <span class="op-decay-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
                    <span class="op-decay-life-cell"><span class="op-decay-life" id="${rowId}">—</span><span id="${trendId}"></span></span>
                </li>
            `;
        }
        root.innerHTML = `<ul class="op-decay-list-ul">${html}</ul>`;

        for (const a of list) {
            if (!a.tle) continue;
            const provKey = `decay.lifetime.${a.noradId}`;
            const r = decayWithSigma(a.tle, f107, sigF107, ap, sigAp);
            provStore.set(provKey, {
                value: r.lifetime_days,
                unit:  'days',
                sigma: r.sigma_days,
                source: 'derived (Operations decay heuristic v1)',
                model:  'Calibrated piecewise altitude × F10.7 × Ap surrogate',
                formula: 'months(perigee) · (150/F10.7)^1.5 · (15/Ap)^0.4',
                inputs: ['idx.f107', 'idx.ap'],
                cacheState: 'derived',
                fetchedAt: new Date().toISOString(),
                description:
                    `Triage estimate of orbit lifetime for ${a.name} (NORAD ` +
                    `${a.noradId}) at perigee ${r.perigee_km ?? '?'} km. ` +
                    `Calibrated to NASA / ESA published decay reference values; ` +
                    `NOT a King-Hele integration. Decision-grade lifetime forecasts ` +
                    `require an SP propagator (STELA / HEAVENS) — Enterprise can ` +
                    `wire their propagator output into this same provStore key. ` +
                    `Uncertainty band combines F10.7 + Ap forecast spreads with a ` +
                    `±25 % ballistic-coefficient assumption.`,
            });

            const node = document.getElementById(`op-decay-life-${a.noradId}`);
            if (!node) continue;

            // Custom render: lifetime_days → human-readable string with ± range.
            const renderLife = () => {
                const rec = provStore.get(provKey);
                if (!rec) return;
                const v   = fmtLifetime(rec.value);
                const lo  = fmtLifetime(rec.value - 1.2816 * rec.sigma);
                const hi  = fmtLifetime(rec.value + 1.2816 * rec.sigma);
                node.innerHTML = `
                    <span class="op-band-v">${v}</span>
                    <span class="op-band-range"> (${lo} / ${hi})</span>
                `;
            };
            renderLife();
            node.dataset.provKey = provKey;
            // Re-render on prov change.
            const off = provStore.subscribe(k => { if (k === provKey) renderLife(); });
            // Park the unsubscribe on the node so a future re-render can clean it.
            node._opDecayOff = off;

            const trendNode = document.getElementById(`op-decay-trend-${a.noradId}`);
            if (trendNode) attachDelta(trendNode, provKey);
        }
    }

    fleet.onChange(recompute);
    provStore.subscribe(key => {
        if (key === 'idx.f107' || key === 'idx.ap') recompute();
    });
}

/* ─── Conjunctions panel ──────────────────────────────────── */

const CONJ_HORIZONS = Object.freeze([
    { id: '1d',   label: '24 h',   hours: 24       },
    { id: '7d',   label: '7 d',    hours: 7  * 24  },
    { id: '14d',  label: '14 d',   hours: 14 * 24, default: true },
]);

const SEVERITY_THRESHOLDS = Object.freeze({
    high: 5,    // < 5 km miss
    med:  15,
    low:  50,
});

function severityFor(distKm) {
    if (distKm < SEVERITY_THRESHOLDS.high) return 'high';
    if (distKm < SEVERITY_THRESHOLDS.med)  return 'med';
    return 'low';
}

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtUtc(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
           `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}Z`;
}
function fmtAhead(simMs, tcaMs) {
    const diff = Math.max(0, tcaMs - simMs);
    if (diff < 3_600_000)         return `+${Math.round(diff / 60_000)} min`;
    if (diff < 24 * 3_600_000)    return `+${(diff / 3_600_000).toFixed(1)} h`;
    return `+${(diff / (24 * 3_600_000)).toFixed(1)} d`;
}

// Inline SVG sparkline of dist(t) around closest approach. Width is
// fixed; height tight enough to slot into a sub-row without expanding
// it. The TCA marker is drawn at center_index. Returns '' when the
// input is missing or has fewer than 3 valid samples — the row just
// drops the column rather than rendering a degenerate plot.
const SPARK_W = 64;
const SPARK_H = 18;
function renderSparkSvg(spark, missKm) {
    if (!spark || !Array.isArray(spark.km)) return '';
    const km = spark.km;
    const valid = km.filter(v => Number.isFinite(v));
    if (valid.length < 3) return '';

    const lo = Math.min(...valid);
    const hi = Math.max(...valid, missKm ?? 0, 1);
    const range = Math.max(hi - lo, 1e-3);

    const dx = SPARK_W / Math.max(km.length - 1, 1);
    const yOf = (v) => SPARK_H - 2 - ((v - lo) / range) * (SPARK_H - 4);

    let d = '';
    let prevValid = false;
    for (let i = 0; i < km.length; i++) {
        const v = km[i];
        if (!Number.isFinite(v)) { prevValid = false; continue; }
        const x = i * dx;
        const y = yOf(v);
        d += (prevValid ? `L${x.toFixed(1)},${y.toFixed(1)}` : `M${x.toFixed(1)},${y.toFixed(1)}`);
        prevValid = true;
    }

    const ci = Number.isFinite(spark.center_index)
        ? Math.max(0, Math.min(km.length - 1, spark.center_index))
        : Math.floor(km.length / 2);
    const cx = ci * dx;
    const cy = Number.isFinite(km[ci]) ? yOf(km[ci]) : SPARK_H / 2;

    const minutes = (km.length - 1) * (spark.step_min ?? 0);
    const titleAttr = `dist(t) over ±${Math.round(minutes / 2)} min around TCA · ${valid[0].toFixed(1)} – ${valid[valid.length - 1].toFixed(1)} km`;

    return `<svg class="op-conj-spark" viewBox="0 0 ${SPARK_W} ${SPARK_H}" width="${SPARK_W}" height="${SPARK_H}" aria-hidden="true">
        <title>${escapeHtml(titleAttr)}</title>
        <line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="0" y2="${SPARK_H}" class="op-conj-spark-tca"/>
        <path d="${d}" class="op-conj-spark-line"/>
        <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="2" class="op-conj-spark-min"/>
    </svg>`;
}

export function mountConjunctions(fleet, tracker, opts = {}) {
    const root = document.getElementById('op-conj-body');
    const btn  = document.getElementById('op-conj-btn');
    if (!root) return;
    const onSelect      = opts.onSelect      ?? (() => {});
    const onConjunction = opts.onConjunction ?? (() => {});

    const screener = new ConjunctionScreener();

    // UI state.
    const horizonDefault = CONJ_HORIZONS.find(h => h.default) ?? CONJ_HORIZONS[2];
    let horizonId = horizonDefault.id;
    let busy   = false;
    let stale  = true;
    let lastRows = [];     // cached so re-renders are cheap (e.g. expand/collapse)
    let lastEpochMs = null;
    let autoRescreen = true;             // anchor follows the time cursor
    let autoTimer    = null;             // debounce handle
    const expanded   = new Set();        // primary norad IDs that are expanded

    // How far the cursor can drift from the anchor before the panel
    // is considered "stale". The auto-rescreen path triggers a fresh
    // run after the cursor has been quiet for AUTO_DEBOUNCE_MS past
    // the threshold; this keeps a casual scrub from spamming the
    // worker.
    const AUTO_THRESHOLD_MS = 5 * 60 * 1000;
    const AUTO_DEBOUNCE_MS  = 750;

    function horizonHours() {
        const h = CONJ_HORIZONS.find(x => x.id === horizonId);
        return (h ?? horizonDefault).hours;
    }

    function activeSecondaryGroups() {
        // Every loaded group present in the catalog. Drops the
        // hard `'debris'` requirement — if the user has Starlink on,
        // they want to see Starlink-on-fleet conjunctions too.
        const sats = tracker.getSatellites?.() ?? [];
        const groups = new Set();
        for (const s of sats) {
            if (s.group) groups.add(s.group);
        }
        return [...groups];
    }

    function buildGroupMap() {
        // O(N) noradId → group lookup so the secondaries can carry
        // their group through to the worker without quadratic work.
        const map = new Map();
        for (const s of (tracker.getSatellites?.() ?? [])) {
            map.set(s.norad_id, s.group ?? null);
        }
        return map;
    }

    function renderShell() {
        const horizonChips = CONJ_HORIZONS.map(h => `
            <button type="button" class="op-conj-chip${h.id === horizonId ? ' op-conj-chip--on' : ''}"
                    data-horizon="${h.id}" title="Screen ahead ${h.label}">${h.label}</button>
        `).join('');

        return `
            <div class="op-conj-toolbar">
                <span class="op-conj-toolbar-label">Horizon</span>
                ${horizonChips}
                <button type="button" id="op-conj-auto" class="op-conj-chip${autoRescreen ? ' op-conj-chip--on' : ''}"
                    title="Auto-rescreen when the time cursor moves more than ${Math.round(AUTO_THRESHOLD_MS / 60_000)} min from the screen anchor">Auto</button>
                <span id="op-conj-status" class="op-conj-toolbar-status">—</span>
            </div>
            <div id="op-conj-rows" class="op-conj-rows"></div>
        `;
    }

    function paintShell() {
        if (root.dataset.shell === 'on') return;
        root.dataset.shell = 'on';
        root.innerHTML = renderShell();

        root.querySelectorAll('[data-horizon]').forEach(el => {
            el.addEventListener('click', () => {
                if (busy || el.dataset.horizon === horizonId) return;
                horizonId = el.dataset.horizon;
                root.querySelectorAll('[data-horizon]').forEach(b => {
                    b.classList.toggle('op-conj-chip--on', b.dataset.horizon === horizonId);
                });
                stale = true;
                screen();
            });
        });

        const autoBtn = root.querySelector('#op-conj-auto');
        autoBtn?.addEventListener('click', () => {
            autoRescreen = !autoRescreen;
            autoBtn.classList.toggle('op-conj-chip--on', autoRescreen);
            // If the user enables auto AND the panel is already
            // stale, rescreen immediately rather than waiting for the
            // next time-bus tick.
            if (autoRescreen && lastEpochMs != null) {
                const drift = Math.abs(timeBus.getState().simTimeMs - lastEpochMs);
                if (drift > AUTO_THRESHOLD_MS) screen();
            }
        });
    }

    function setStatus(text, kind = '') {
        const el = root.querySelector('#op-conj-status');
        if (!el) return;
        el.textContent = text;
        el.dataset.kind = kind;
    }

    async function screen() {
        if (busy) return;
        paintShell();

        const list = fleet.list().filter(a => a.status === 'ready' && a.tle);
        if (list.length === 0) {
            setStatus('Add fleet assets to screen.', 'empty');
            renderRows([]);
            return;
        }

        const groups = activeSecondaryGroups();
        const secondaryTles = (tracker.getTlesByGroup?.(groups) ?? []);
        if (secondaryTles.length === 0) {
            setStatus('Toggle a layer (debris, Starlink…) to enable screening.', 'empty');
            renderRows([]);
            return;
        }

        const simTimeMs = timeBus.getState().simTimeMs;
        lastEpochMs = simTimeMs;

        // Wire targets and secondaries with their group so the worker
        // can echo group back per-row (used for severity coloring +
        // future filter chips).
        const fleetIds = new Set(list.map(a => a.noradId));
        const groupMap = buildGroupMap();
        const targets  = list.map(a => ({ tle: a.tle, group: 'fleet' }));
        const secondaries = [];
        for (const t of secondaryTles) {
            if (fleetIds.has(t.norad_id)) continue;   // primary excludes itself
            secondaries.push({ tle: t, group: groupMap.get(t.norad_id) ?? null });
        }

        busy = true;
        stale = false;
        setStatus(`Screening ${list.length} asset${list.length === 1 ? '' : 's'} × ${secondaries.length} secondaries…`, 'busy');
        if (btn) btn.disabled = true;

        try {
            const results = await screener.run({
                targets, secondaries,
                epochMs: simTimeMs,
                params:  {
                    horizonH:    horizonHours(),
                    stepMin:     10,
                    thresholdKm: 50,
                    refine:      true,
                    withDv:      true,
                },
            });

            const rows = list.map(a => ({
                asset: a,
                conjs: results[a.noradId] ?? [],
            }));
            lastRows = rows;
            renderRows(rows);

            const totalConj = rows.reduce((s, r) => s + r.conjs.length, 0);
            setStatus(
                `Screened anchor ${fmtUtc(simTimeMs)} · +${horizonHours()} h · ` +
                `${totalConj} conjunction${totalConj === 1 ? '' : 's'} ≤ 50 km.`,
                totalConj === 0 ? 'clear' : 'done',
            );
        } catch (err) {
            if (err?.code === 'superseded' || err?.code === 'disposed') return;
            setStatus(`Screen failed: ${err.message ?? err}`, 'error');
            renderRows([]);
        } finally {
            busy = false;
            if (btn) btn.disabled = false;
        }
    }

    function renderRow(r, simNow) {
        const { asset, conjs } = r;
        if (conjs.length === 0) {
            return `<li class="op-conj-row op-conj-row-clear" data-norad="${asset.noradId}" tabindex="0" role="button">
                <span class="op-conj-name">${escapeHtml(asset.name)}</span>
                <span class="op-conj-status">clear · ${horizonHours() / 24 >= 1 ? `${horizonHours()/24} d` : `${horizonHours()} h`}</span>
            </li>`;
        }
        const closest = conjs[0];
        const sev = severityFor(closest.dist_km);
        const isOpen = expanded.has(asset.noradId);
        const ahead = fmtAhead(simNow, closest.tca_ms ?? Date.now());
        const dvBit = closest.dv_kms != null
            ? `<span class="op-conj-dv" title="Relative velocity at TCA">${closest.dv_kms.toFixed(2)} km/s</span>`
            : '';

        let html = `<li class="op-conj-row op-conj-row-${sev}${isOpen ? ' op-conj-row--open' : ''}"
            data-norad="${asset.noradId}" data-tca-ms="${closest.tca_ms}" tabindex="0" role="button"
            title="Closest approach for ${escapeHtml(asset.name)}. Click to expand; Shift-click to scrub to TCA.">
            <span class="op-conj-name">${escapeHtml(asset.name)}</span>
            <span class="op-conj-count" title="${conjs.length} secondaries within 50 km over the horizon">${conjs.length}</span>
            <span class="op-conj-closest">${closest.dist_km.toFixed(2)} km · ${ahead}</span>
            ${dvBit}
            <span class="op-conj-caret" aria-hidden="true">${isOpen ? '▾' : '▸'}</span>
        </li>`;

        if (isOpen) {
            const top = conjs.slice(0, 6);
            html += `<ul class="op-conj-sublist" data-parent="${asset.noradId}">`;
            for (const c of top) {
                const sub = severityFor(c.dist_km);
                const subAhead = fmtAhead(simNow, c.tca_ms);
                const subDv = c.dv_kms != null ? ` · ${c.dv_kms.toFixed(2)} km/s` : '';
                const groupBit = c.group ? `<span class="op-conj-sub-group">${escapeHtml(c.group)}</span>` : '';
                const sparkSvg = renderSparkSvg(c.spark, c.dist_km);
                html += `<li class="op-conj-sub op-conj-sub-${sub}" data-norad="${asset.noradId}" data-secondary="${c.norad_id}" data-tca-ms="${c.tca_ms}" tabindex="0" role="button"
                    title="${escapeHtml(c.name)} · click to scrub to TCA and load encounter">
                    <span class="op-conj-sub-name">${escapeHtml(c.name)} <span class="op-conj-sub-id">#${c.norad_id}</span></span>
                    ${groupBit}
                    <span class="op-conj-sub-miss">${c.dist_km.toFixed(2)} km</span>
                    ${sparkSvg}
                    <span class="op-conj-sub-tca">${fmtUtc(c.tca_ms)} (${subAhead})${subDv}</span>
                </li>`;
            }
            if (conjs.length > top.length) {
                html += `<li class="op-conj-sub op-conj-sub-more">+${conjs.length - top.length} more below 50 km</li>`;
            }
            html += `</ul>`;
        }

        return html;
    }

    function renderRows(rows) {
        const host = root.querySelector('#op-conj-rows');
        if (!host) return;
        if (rows.length === 0) { host.innerHTML = ''; return; }
        const simNow = lastEpochMs ?? timeBus.getState().simTimeMs;
        host.innerHTML = `<ul class="op-conj-list">${rows.map(r => renderRow(r, simNow)).join('')}</ul>`;
        wireRows(host, rows);
    }

    function wireRows(host, rows) {
        const fireConj = (asset, conj, scrub = true) => {
            onSelect(asset.noradId);
            if (scrub && Number.isFinite(conj.tca_ms)) {
                timeBus.setSimTime(conj.tca_ms, { mode: 'scrub' });
            }
            const secondary = tracker.getSatellite?.(conj.norad_id);
            onConjunction({
                assetName:     asset.name,
                assetTle:      asset.tle,
                secondaryName: conj.name || `#${conj.norad_id}`,
                secondaryTle:  secondary?.tle ?? null,
                tcaMs:         conj.tca_ms,
                missKm:        conj.dist_km,
                dvKms:         conj.dv_kms,
                missUnit:      conj.miss_unit,
                missVec:       conj.miss_vec,
                vRel:          conj.v_rel,
            });
        };

        // Primary row: tap = scrub to closest-approach + select +
        // toggle the secondaries panel. Sub-rows let the user pick a
        // different secondary without re-screening.
        host.querySelectorAll('.op-conj-row[data-norad]').forEach(row => {
            const id      = parseInt(row.dataset.norad, 10);
            const rowData = rows.find(r => r.asset.noradId === id);
            const fire    = () => {
                if (!rowData) return;
                if (rowData.conjs.length === 0) {
                    onSelect(id);
                    onConjunction(null);
                    return;
                }
                fireConj(rowData.asset, rowData.conjs[0], true);
                if (expanded.has(id)) expanded.delete(id);
                else                  expanded.add(id);
                renderRows(rows);
            };
            row.addEventListener('click', fire);
            row.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fire();
                }
            });
        });

        // Sub rows: tap = scrub + show on globe + b-plane.
        host.querySelectorAll('.op-conj-sub[data-secondary]').forEach(sub => {
            const primaryId   = parseInt(sub.dataset.norad, 10);
            const secondaryId = parseInt(sub.dataset.secondary, 10);
            const rowData     = rows.find(r => r.asset.noradId === primaryId);
            const conj        = rowData?.conjs.find(c => c.norad_id === secondaryId);
            if (!rowData || !conj) return;

            const fire = () => fireConj(rowData.asset, conj, true);
            sub.addEventListener('click', (ev) => { ev.stopPropagation(); fire(); });
            sub.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    fire();
                }
            });
        });
    }

    btn?.addEventListener('click', () => screen());

    // Time-bus integration. Two modes:
    //   - autoRescreen on  → debounce, then re-run when the cursor
    //     drifts > AUTO_THRESHOLD_MS from the last anchor. The worker
    //     supersedes any in-flight run so spamming the cursor is
    //     safe.
    //   - autoRescreen off → just mark the panel stale and tell the
    //     user a manual click is needed.
    timeBus.subscribe(({ simTimeMs }) => {
        if (lastEpochMs == null) return;
        const drift = Math.abs(simTimeMs - lastEpochMs);
        if (drift < 60_000) return;

        const status = root.querySelector('#op-conj-status');

        if (autoRescreen) {
            if (drift < AUTO_THRESHOLD_MS) return;
            if (status && status.dataset.kind !== 'busy') {
                status.dataset.kind = 'stale';
                status.textContent = `Cursor drifted · auto-rescreen pending`;
            }
            if (autoTimer != null) clearTimeout(autoTimer);
            autoTimer = setTimeout(() => {
                autoTimer = null;
                if (busy) return;     // wait for the previous run; subscriber will fire again on the next tick
                screen();
            }, AUTO_DEBOUNCE_MS);
        } else if (status && status.dataset.kind !== 'busy') {
            status.dataset.kind = 'stale';
            status.textContent = `Anchor moved · click Screen to refresh from ${fmtUtc(simTimeMs)}`;
        }
    });

    // Progress callback — surfaces "12 / 30 assets screened" so long
    // runs don't look hung.
    screener.subscribe(evt => {
        if (evt.phase === 'progress') {
            setStatus(`Screening… ${evt.done} / ${evt.total} primaries`, 'busy');
        }
    });

    // Initial paint: show the toolbar plus a hint, regardless of fleet.
    paintShell();
    setStatus(
        fleet.list().length === 0
            ? 'Add assets and click Screen.'
            : `${fleet.list().length} asset${fleet.list().length === 1 ? '' : 's'} ready · click Screen.`,
        'idle',
    );

    fleet.onChange(() => {
        if (busy) return;
        const n = fleet.list().length;
        if (n === 0) {
            lastRows = [];
            renderRows([]);
        }
        const status = root.querySelector('#op-conj-status');
        if (status && (status.dataset.kind === 'idle' || status.dataset.kind === 'empty' || status.dataset.kind === 'clear')) {
            setStatus(
                n === 0 ? 'Add assets and click Screen.' : `${n} asset${n === 1 ? '' : 's'} ready · click Screen.`,
                'idle',
            );
        }
        // Auto-rescreen on fleet edits when auto is on AND we already
        // have a baseline screen — adding a new asset means the user
        // wants its conjunctions populated. Debounced through the
        // same timer the cursor-drift path uses so back-to-back edits
        // (e.g. paste-then-paste) collapse into one run.
        if (autoRescreen && lastEpochMs != null && n > 0) {
            if (autoTimer != null) clearTimeout(autoTimer);
            autoTimer = setTimeout(() => {
                autoTimer = null;
                if (!busy) screen();
            }, AUTO_DEBOUNCE_MS);
        }
    });

    return {
        rescreen: screen,
        dispose() {
            if (autoTimer != null) {
                clearTimeout(autoTimer);
                autoTimer = null;
            }
            screener.dispose();
        },
    };
}

/* ─── Prop Budget panel ───────────────────────────────────── */

export function mountPropBudget(fleet) {
    const root = document.getElementById('op-prop-body');
    if (!root) return;

    root.innerHTML = `
        <div class="op-prop-headline">
            <span class="op-prop-pct" id="op-prop-pct">—</span>
            <span class="op-prop-label">storm overhead</span>
        </div>
        <div class="op-prop-detail" id="op-prop-detail">
            Extra drag-driven Δv versus Ap=15 / F10.7=150 climatology.
        </div>
    `;

    function recompute() {
        const f107 = provStore.get('idx.f107')?.value ?? null;
        const ap   = provStore.get('idx.ap')?.value   ?? null;
        const sigF107 = provStore.get('idx.f107')?.sigma ?? 12;
        const sigAp   = provStore.get('idx.ap')?.sigma   ?? 6;
        if (f107 == null || ap == null) return;

        const pct  = stormOverheadPct(ap, f107);
        const hi   = stormOverheadPct(ap + sigAp, f107 + sigF107);
        const lo   = stormOverheadPct(ap - sigAp, f107 - sigF107);
        const sig  = (hi != null && lo != null) ? Math.abs(hi - lo) / 2 : null;

        provStore.set('prop.storm_overhead_pct', {
            value: pct, unit: '%',
            sigma: sig,
            source: 'derived (Operations storm-overhead surrogate)',
            model:  'Linearised LEO drag sensitivity vs Ap/F10.7 climatology',
            formula: '(1 + 0.025·(Ap−15)) · (1 + 0.005·(F10.7−150)) − 1',
            inputs: ['idx.ap', 'idx.f107'],
            cacheState: 'derived',
            fetchedAt: new Date().toISOString(),
            description:
                'Triage number: percent extra drag (and so propellant) versus the ' +
                'climatological calm baseline (Ap=15, F10.7=150). Useful for fleet-wide ' +
                'planning; not a maneuver budget — true budgeting requires per-asset ' +
                'B* and per-altitude density curves.',
        });

        const pctNode = document.getElementById('op-prop-pct');
        if (pctNode) {
            const sign = pct >= 0 ? '+' : '−';
            const sigStr = sig != null ? ` ±${Math.round(sig)}%` : '';
            pctNode.innerHTML = `<span class="op-band-v">${sign}${Math.round(Math.abs(pct))}%</span><span class="op-band-sigma">${sigStr}</span>`;
            pctNode.dataset.provKey = 'prop.storm_overhead_pct';
        }

        const detail = document.getElementById('op-prop-detail');
        if (detail) {
            const fleetSize = fleet.list().length;
            const tag = pct >  50 ? 'severe' : pct > 20 ? 'elevated' : pct > 5 ? 'mild' : 'quiet';
            detail.textContent = fleetSize
                ? `${tag} · F10.7=${Math.round(f107)} · Ap=${Math.round(ap)} · ${fleetSize} asset${fleetSize===1?'':'s'} affected`
                : `${tag} · F10.7=${Math.round(f107)} · Ap=${Math.round(ap)} · add fleet assets to scope`;
        }
    }

    provStore.subscribe(key => {
        if (key === 'idx.f107' || key === 'idx.ap') recompute();
    });
    fleet.onChange(recompute);
    recompute();

    // Δ icon next to the headline %.
    setTimeout(() => {
        const node = document.getElementById('op-prop-pct');
        if (node && node.parentNode) attachDelta(node, 'prop.storm_overhead_pct');
    }, 0);
}

/* ─── HTML escape ─────────────────────────────────────────── */

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
