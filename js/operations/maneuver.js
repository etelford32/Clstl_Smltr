/**
 * maneuver.js — "What-if" maneuver planner for the Operations console.
 *
 * Lets an operator type an RTN Δv at a chosen burn time and see the
 * predicted shift in miss distance for every existing conjunction
 * involving the selected asset. The model is a deliberately simple
 * free-flight linearisation:
 *
 *   Δv_eci = Δv_R · R̂ + Δv_T · T̂ + Δv_N · N̂   (RTN at burn time)
 *   Δr(TCA) ≈ Δv_eci · (t_tca − t_burn)         (no orbit dynamics)
 *   miss_new ≈ |miss_old + Δr|
 *
 * Pros: instantaneous, intuitive, reveals direction-of-motion
 *   intuition (+T extends along-track miss, +R lifts radial gap, +N
 *   shifts cross-track plane). No worker round-trip needed.
 *
 * Cons: ignores Earth gravity over the coast → off by 5–15 % for
 *   sub-day horizons, more for multi-day. Does NOT account for the
 *   possibility that the new orbit's actual TCA shifts in time.
 *   Treat as an advisory mental model, not a flight-dynamics tool.
 *
 * The panel re-renders on:
 *   - selection change      (which asset's conjunctions to use)
 *   - deck.subscribeRows    (new screen → new conjunctions)
 *   - input change          (Δv R/T/N or burn-time UTC)
 *   - timeBus tick          (so "use sim time" stays synced)
 *
 * Mounted into a panel in the operations right column.
 */

import { propagate, tleEpochToJd } from '../satellite-tracker.js';
import { timeBus }                  from './time-bus.js';

const MIN_PER_DAY = 1440;

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtUtc(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
           `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}Z`;
}
function fmtAhead(simMs, tcaMs) {
    const diff = tcaMs - simMs;
    const sign = diff < 0 ? '−' : '+';
    const abs  = Math.abs(diff);
    if (abs < 3_600_000)         return `${sign}${Math.round(abs / 60_000)}m`;
    if (abs < 24 * 3_600_000)    return `${sign}${(abs / 3_600_000).toFixed(1)}h`;
    return `${sign}${(abs / (24 * 3_600_000)).toFixed(1)}d`;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

/**
 * Compute the RTN basis (R̂, T̂, N̂) in TEME for a TLE at `tsMin`
 * minutes past epoch. Returns three unit vectors plus the position
 * and velocity. Velocity is via 10 s central difference on
 * propagate() — same approximation the Δv coloring uses.
 */
function rtnBasisAt(tle, tsMin) {
    const dt = 10 / 60; // 10 s in minutes
    const rA = propagate(tle, tsMin - dt);
    const rB = propagate(tle, tsMin + dt);
    const r  = propagate(tle, tsMin);

    const v = {
        x: (rB.x - rA.x) / 20,
        y: (rB.y - rA.y) / 20,
        z: (rB.z - rA.z) / 20,
    };

    const rMag = Math.hypot(r.x, r.y, r.z);
    if (rMag < 1e-6) return null;
    const Rhat = { x: r.x / rMag, y: r.y / rMag, z: r.z / rMag };

    // N̂ = (r × v) / |r × v|  — orbit normal
    const nx0 = r.y * v.z - r.z * v.y;
    const ny0 = r.z * v.x - r.x * v.z;
    const nz0 = r.x * v.y - r.y * v.x;
    const nMag = Math.hypot(nx0, ny0, nz0);
    if (nMag < 1e-9) return null;
    const Nhat = { x: nx0 / nMag, y: ny0 / nMag, z: nz0 / nMag };

    // T̂ = N̂ × R̂   (in-plane, along-track when orbit is roughly circular)
    const That = {
        x: Nhat.y * Rhat.z - Nhat.z * Rhat.y,
        y: Nhat.z * Rhat.x - Nhat.x * Rhat.z,
        z: Nhat.x * Rhat.y - Nhat.y * Rhat.x,
    };
    return { r, v, Rhat, That, Nhat };
}

export function mountManeuverPanel(opts = {}) {
    const {
        host,
        deck,
        tracker,
        getSelectedId  = () => null,
        onSelectChange = () => () => {},
    } = opts;

    if (!host || !deck?.subscribeRows) {
        console.warn('[maneuver] missing host / deck.subscribeRows; aborting mount');
        return { dispose() {} };
    }

    let selectedId = null;
    let selectedAsset = null;       // { name, tle, conjs: [] }
    let lastRows = [];
    let burnMs   = timeBus.getState().simTimeMs;
    let burnLockedToSim = true;     // burn auto-tracks the time-bus cursor
    let dvR = 0, dvT = 0, dvN = 0;  // m/s

    function findSelectedRow() {
        if (selectedId == null) return null;
        return lastRows.find(r => r.asset.noradId === selectedId) ?? null;
    }

    function setSelectedFromState() {
        selectedId = getSelectedId();
        const row  = findSelectedRow();
        selectedAsset = row ? { name: row.asset.name, tle: row.asset.tle, conjs: row.conjs } : null;
        // If the selected asset isn't in the fleet (e.g. user picked
        // a debris dot), we can still preview the maneuver but
        // there are no conjunctions to project.
        if (!selectedAsset && selectedId != null) {
            const sat = tracker?.getSatellite?.(selectedId);
            if (sat?.tle) selectedAsset = { name: sat.name || `#${selectedId}`, tle: sat.tle, conjs: [] };
        }
    }

    function dvMagMs() {
        return Math.hypot(dvR, dvT, dvN);
    }

    /**
     * Evaluate the linearised model: for each conjunction of the
     * selected asset, return { conj, oldMissKm, newMissKm,
     *                          dtSec, sense: 'safer'|'closer'|'flat' }.
     */
    function projectShifts() {
        if (!selectedAsset?.tle || !selectedAsset.conjs?.length) return [];
        const tle = selectedAsset.tle;
        const epochJd = tleEpochToJd(tle);

        // Burn time → tsBurn min past epoch.
        const jdBurn = burnMs / 86400000 + 2440587.5;
        const tsBurn = (jdBurn - epochJd) * MIN_PER_DAY;

        const basis = rtnBasisAt(tle, tsBurn);
        if (!basis) return [];

        // Δv in km/s (input is m/s). RTN → ECI/TEME.
        const dvR_kms = (dvR || 0) / 1000;
        const dvT_kms = (dvT || 0) / 1000;
        const dvN_kms = (dvN || 0) / 1000;
        const dvECI = {
            x: dvR_kms * basis.Rhat.x + dvT_kms * basis.That.x + dvN_kms * basis.Nhat.x,
            y: dvR_kms * basis.Rhat.y + dvT_kms * basis.That.y + dvN_kms * basis.Nhat.y,
            z: dvR_kms * basis.Rhat.z + dvT_kms * basis.That.z + dvN_kms * basis.Nhat.z,
        };

        const out = [];
        for (const c of selectedAsset.conjs) {
            if (!Number.isFinite(c.tca_ms) || !c.miss_vec) {
                // Need the full miss vector for the projection. Skip
                // rows that pre-date the v_rel/miss_vec additions.
                continue;
            }
            const dtSec = (c.tca_ms - burnMs) / 1000;
            // Free-flight position perturbation.
            const drx = dvECI.x * dtSec;
            const dry = dvECI.y * dtSec;
            const drz = dvECI.z * dtSec;
            // miss_new = miss_old + Δr (vector add), then magnitude.
            const mx = c.miss_vec.x + drx;
            const my = c.miss_vec.y + dry;
            const mz = c.miss_vec.z + drz;
            const newMissKm = Math.hypot(mx, my, mz);
            const oldMissKm = c.dist_km;
            const delta = newMissKm - oldMissKm;
            const sense = delta >  0.5 ? 'safer'
                        : delta < -0.5 ? 'closer'
                        :                'flat';
            out.push({ conj: c, oldMissKm, newMissKm, dtSec, delta, sense });
        }
        // Worst case first.
        out.sort((a, b) => a.newMissKm - b.newMissKm);
        return out;
    }

    function severityFor(km) {
        if (km < 5)  return 'high';
        if (km < 15) return 'med';
        return 'low';
    }

    function render() {
        if (!selectedAsset) {
            host.innerHTML = `
                <div class="op-mvr-empty">
                    Select a fleet asset to preview a maneuver.
                </div>`;
            return;
        }

        const shifts = projectShifts();
        const total  = dvMagMs();
        const burnLine = burnLockedToSim
            ? `${fmtUtc(burnMs)} <span class="op-mvr-burn-tag">⟂ sim</span>`
            : `${fmtUtc(burnMs)}`;

        const list = shifts.length === 0
            ? `<li class="op-mvr-empty">${selectedAsset.conjs?.length
                ? 'Older screen lacks miss vectors — re-screen to enable projection.'
                : 'No conjunctions on this asset in the current screen.'}</li>`
            : shifts.map(s => {
                const ahead = fmtAhead(burnMs, s.conj.tca_ms);
                const sevOld = severityFor(s.oldMissKm);
                const sevNew = severityFor(s.newMissKm);
                const arrow = s.sense === 'safer' ? '↑'
                            : s.sense === 'closer' ? '↓'
                            : '→';
                const name = s.conj.name || `#${s.conj.norad_id}`;
                return `
                    <li class="op-mvr-row op-mvr-row-${s.sense}">
                        <span class="op-mvr-name">${escapeHtml(name)}</span>
                        <span class="op-mvr-old op-mvr-miss-${sevOld}">${s.oldMissKm.toFixed(1)} km</span>
                        <span class="op-mvr-arrow">${arrow}</span>
                        <span class="op-mvr-new op-mvr-miss-${sevNew}">${s.newMissKm.toFixed(1)} km</span>
                        <span class="op-mvr-ahead">${ahead}</span>
                    </li>`;
            }).join('');

        host.innerHTML = `
            <div class="op-mvr-meta">
                <div class="op-mvr-asset">
                    <span class="op-mvr-asset-tag">Asset</span>
                    <span class="op-mvr-asset-name" title="${escapeHtml(selectedAsset.name)}">${escapeHtml(selectedAsset.name)}</span>
                    <span class="op-mvr-asset-id">#${selectedId}</span>
                </div>
                <div class="op-mvr-burn">
                    <span class="op-mvr-asset-tag">Burn</span>
                    <span class="op-mvr-burn-time">${burnLine}</span>
                    <button type="button" id="op-mvr-burn-now" class="op-mvr-mini">Use sim time</button>
                </div>
            </div>
            <div class="op-mvr-dv">
                <label class="op-mvr-dv-row">
                    <span class="op-mvr-dv-label" title="Prograde / along-track (T̂)">T (m/s)</span>
                    <input type="number" step="0.5" value="${dvT}" id="op-mvr-dvT">
                </label>
                <label class="op-mvr-dv-row">
                    <span class="op-mvr-dv-label" title="Radial (R̂)">R (m/s)</span>
                    <input type="number" step="0.5" value="${dvR}" id="op-mvr-dvR">
                </label>
                <label class="op-mvr-dv-row">
                    <span class="op-mvr-dv-label" title="Cross-track (N̂)">N (m/s)</span>
                    <input type="number" step="0.5" value="${dvN}" id="op-mvr-dvN">
                </label>
                <div class="op-mvr-dv-total">
                    <span class="op-mvr-asset-tag">|Δv|</span>
                    <span class="op-mvr-dv-mag">${total.toFixed(2)} m/s</span>
                    <button type="button" id="op-mvr-reset" class="op-mvr-mini" title="Zero out the maneuver">reset</button>
                </div>
            </div>
            <ul class="op-mvr-list">${list}</ul>
            <div class="op-mvr-caveat">
                Linearised free-flight (Δr ≈ Δv·Δt). Advisory only — coast-time gravity unmodelled.
            </div>
        `;

        // Wire inputs.
        const onNum = (id, set) => {
            const el = host.querySelector(`#${id}`);
            if (!el) return;
            el.addEventListener('input', () => {
                const v = parseFloat(el.value);
                set(Number.isFinite(v) ? v : 0);
                // Re-render so the projection updates AND the input
                // value stays consistent if the user typed a non-number.
                render();
            });
        };
        onNum('op-mvr-dvT', v => { dvT = v; });
        onNum('op-mvr-dvR', v => { dvR = v; });
        onNum('op-mvr-dvN', v => { dvN = v; });

        host.querySelector('#op-mvr-burn-now')?.addEventListener('click', () => {
            burnMs = timeBus.getState().simTimeMs;
            burnLockedToSim = true;
            render();
        });
        host.querySelector('#op-mvr-reset')?.addEventListener('click', () => {
            dvR = dvT = dvN = 0;
            render();
        });
    }

    // Subscriptions.
    const offSel = onSelectChange((id) => {
        const prev = selectedId;
        selectedId = id;
        // When the asset changes, default the burn back to sim time
        // so cycling through fleet members is friction-free.
        if (id !== prev) burnLockedToSim = true;
        setSelectedFromState();
        if (burnLockedToSim) burnMs = timeBus.getState().simTimeMs;
        render();
    });

    const offRows = deck.subscribeRows((snap) => {
        lastRows = snap.rows ?? [];
        setSelectedFromState();
        render();
    });

    let busyFrame = 0;
    const offBus = timeBus.subscribe(({ simTimeMs }) => {
        if (!burnLockedToSim) return;
        // Throttle to ~2 Hz; the burn timestamp is just a string
        // readout, no need to repaint at 10 Hz.
        if (++busyFrame % 5 !== 0) return;
        burnMs = simTimeMs;
        render();
    });

    // Initial paint.
    setSelectedFromState();
    render();

    return {
        dispose() {
            offSel?.();
            offRows?.();
            offBus?.();
        },
    };
}
