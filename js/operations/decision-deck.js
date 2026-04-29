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

import { provStore }   from './provenance.js';
import { bindBand }    from './bands.js';
import { attachDelta } from './delta.js';
import { timeBus }     from './time-bus.js';

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

/* ─── Conjunctions 7d panel ───────────────────────────────── */

export function mountConjunctions(fleet, tracker, opts = {}) {
    const root = document.getElementById('op-conj-body');
    if (!root) return;
    const onSelect = opts.onSelect ?? (() => {});

    let runId = 0;
    let busy = false;

    async function screen() {
        if (busy) return;
        const list = fleet.list().filter(a => a.status === 'ready');
        if (list.length === 0) {
            root.innerHTML = `<div class="op-deck-empty">Add fleet assets to screen.</div>`;
            return;
        }
        if (!tracker.hasGroup('debris')) {
            root.innerHTML = `<div class="op-deck-empty">Toggle the <b>Tracked Debris</b> layer to enable screening.</div>`;
            return;
        }

        busy = true;
        const myRun = ++runId;
        root.innerHTML = `<div class="op-deck-empty">Screening ${list.length} asset${list.length===1?'':'s'} × debris…</div>`;

        const rows = [];
        for (const a of list) {
            try {
                const conjs = await tracker.screenConjunctions(a.noradId, 7 * 24, 30, 50, 'debris');
                if (myRun !== runId) return;       // superseded
                rows.push({ asset: a, conjs: conjs || [] });
            } catch (e) {
                rows.push({ asset: a, conjs: [], error: e.message });
            }
        }
        if (myRun !== runId) return;

        renderRows(rows);
        busy = false;
    }

    function renderRows(rows) {
        let html = '';
        for (const { asset, conjs, error } of rows) {
            if (error) {
                html += `<li class="op-conj-row op-conj-row-err">${escapeHtml(asset.name)} — ${escapeHtml(error)}</li>`;
                continue;
            }
            if (conjs.length === 0) {
                html += `<li class="op-conj-row op-conj-row-clear" data-norad="${asset.noradId}" tabindex="0" role="button">
                    <span class="op-conj-name">${escapeHtml(asset.name)}</span>
                    <span class="op-conj-status">clear · 7 d</span>
                </li>`;
                continue;
            }
            const closest = conjs.reduce((a, b) => (a.dist_km <= b.dist_km ? a : b));
            const sev = closest.dist_km < 5 ? 'high' : closest.dist_km < 15 ? 'med' : 'low';
            const tcaMs = Date.now() + closest.hours_ahead * 3600 * 1000;
            html += `<li class="op-conj-row op-conj-row-${sev}" data-norad="${asset.noradId}" data-tca-ms="${tcaMs}" tabindex="0" role="button"
                title="Click to scrub time to TCA and select ${escapeHtml(asset.name)}">
                <span class="op-conj-name">${escapeHtml(asset.name)}</span>
                <span class="op-conj-count">${conjs.length}</span>
                <span class="op-conj-closest">closest ${closest.dist_km.toFixed(1)} km @ +${closest.hours_ahead.toFixed(1)} h</span>
            </li>`;
        }
        root.innerHTML = `<ul class="op-conj-list">${html}</ul>`;

        // Click → select + scrub to TCA. Skip rows that don't carry a
        // TCA (the "clear · 7 d" path still selects the asset for
        // Δv coloring without moving time).
        root.querySelectorAll('.op-conj-row[data-norad]').forEach(row => {
            const id = parseInt(row.dataset.norad, 10);
            const tcaMs = parseInt(row.dataset.tcaMs, 10);
            const fire = () => {
                onSelect(id);
                if (Number.isFinite(tcaMs)) {
                    timeBus.setSimTime(tcaMs, { mode: 'scrub' });
                }
            };
            row.addEventListener('click', fire);
            row.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fire();
                }
            });
        });
    }

    document.getElementById('op-conj-btn')?.addEventListener('click', screen);

    fleet.onChange(() => {
        // Stay quiet until user clicks; render the resting state only.
        if (!busy) {
            const list = fleet.list();
            if (list.length === 0) {
                root.innerHTML = `<div class="op-deck-empty">Add assets and click <b>Screen 7 d</b>.</div>`;
            } else {
                root.innerHTML = `<div class="op-deck-empty">${list.length} asset${list.length===1?'':'s'} ready · click <b>Screen 7 d</b>.</div>`;
            }
        }
    });
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
