/**
 * maneuver.js — "What-if" maneuver planner for the Operations console.
 *
 * Lets an operator type an RTN Δv at a chosen burn time and see the
 * predicted shift in miss distance for every existing conjunction
 * involving the selected asset. The model is the Clohessy-Wiltshire
 * (Hill-frame) state transition matrix in the rotating RTN frame
 * attached to a circular chief:
 *
 *   Δr_R(τ) =  (sin(nτ)/n) Δv_R + (2(1 − cos(nτ))/n) Δv_T
 *   Δr_T(τ) = −(2(1 − cos(nτ))/n) Δv_R + ((4 sin(nτ) − 3nτ)/n) Δv_T
 *   Δr_N(τ) =  (sin(nτ)/n) Δv_N
 *
 * Δr is then rotated from the RTN basis at TCA into TEME and added
 * to the conjunction's miss vector; |miss + Δr| is the predicted
 * new miss distance.
 *
 * Why CW over free-flight: for a coast time approaching one orbital
 * period (~90 min in LEO), free-flight (Δr = Δv·τ) misses two
 * dominant gravity-driven effects — the along-track secular drift
 * from a tangential burn (energy change → period change → phase
 * walk) and the cross-track sinusoid that returns to zero each
 * orbit. CW captures both in closed form. Reduces to free-flight
 * for small nτ, so short-coast intuition is preserved.
 *
 * Caveats:
 *   - CW assumes a *circular* chief. Operational LEO sats are
 *     typically e < 0.005, well within tolerance. For e > 0.05 the
 *     along-track / radial coupling drifts off the closed-form
 *     prediction — the panel degrades the caveat copy in that case.
 *   - Does NOT model the chief-secondary relative dynamics; the
 *     secondary's path is held fixed (it didn't burn, after all).
 *   - The new orbit's actual TCA may shift in time vs. the original
 *     screen's TCA. CW evaluates Δr at the original t_tca, which is
 *     close enough for advisory work but not a maneuver plan.
 *   - For production planning use a dedicated FDS / numerical
 *     integrator with full force model.
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
     * Clohessy-Wiltshire (Hill) state transition matrix — position
     * perturbation at time τ from an impulsive Δv at τ = 0, expressed
     * in the rotating RTN frame attached to a circular chief orbit
     * with mean motion `n` (rad/s).
     *
     *   Δr_R(τ) =  (sin(nτ)/n) Δv_R + (2(1 − cos(nτ))/n) Δv_T
     *   Δr_T(τ) = −(2(1 − cos(nτ))/n) Δv_R + ((4 sin(nτ) − 3nτ)/n) Δv_T
     *   Δr_N(τ) =  (sin(nτ)/n) Δv_N
     *
     * Reduces to the free-flight Δr ≈ Δv·τ for small nτ, but
     * captures the secular along-track drift after a along-track
     * burn (energy change → period change → phase walk) and the
     * cross-track sinusoid that returns to zero each orbit. Both
     * effects are dominant over τ approaching one orbital period
     * (~90 min in LEO), where free-flight is wildly wrong.
     *
     * Assumes a *circular* chief; for elliptical orbits use the
     * Yamanaka-Ankersen STM (not yet wired). LEO operational sats
     * are typically e < 0.005, well within CW accuracy.
     *
     * Inputs are RTN at burn time, in km/s. Output is in km, in the
     * RTN basis at TCA (the rotating frame, evaluated at τ).
     */
    function applyCwStm(dvR_kms, dvT_kms, dvN_kms, nRadSec, tauSec) {
        const nt    = nRadSec * tauSec;
        const sNT   = Math.sin(nt);
        const cNT   = Math.cos(nt);
        const invN  = 1 / nRadSec;
        const oneMC = 1 - cNT;

        return {
            r: ( sNT * invN)             * dvR_kms + (2 * oneMC * invN)        * dvT_kms,
            t: -(2 * oneMC * invN)       * dvR_kms + ((4 * sNT - 3 * nt) * invN) * dvT_kms,
            n: ( sNT * invN)             * dvN_kms,
        };
    }

    /**
     * Evaluate the CW model: for each conjunction of the selected
     * asset, return { conj, oldMissKm, newMissKm, dtSec,
     *                 sense: 'safer'|'closer'|'flat' }.
     *
     * Δv at burn time → CW STM → Δr in RTN_τ → rotate to TEME via
     * the RTN basis at TCA → add to miss_vec → take magnitude.
     */
    function projectShifts() {
        if (!selectedAsset?.tle || !selectedAsset.conjs?.length) return [];
        const tle = selectedAsset.tle;
        const epochJd = tleEpochToJd(tle);

        // Burn time → tsBurn min past epoch (used only to confirm
        // the asset is propagable; CW doesn't need the burn-time
        // basis because Δv is already in RTN coordinates input by
        // the operator).
        const jdBurn = burnMs / 86400000 + 2440587.5;
        const tsBurnMin = (jdBurn - epochJd) * MIN_PER_DAY;
        const burnBasis = rtnBasisAt(tle, tsBurnMin);
        if (!burnBasis) return [];

        // Mean motion in rad/s. tle.mean_motion is in revs/day.
        const nRadSec = (tle.mean_motion * 2 * Math.PI) / 86400;
        if (!Number.isFinite(nRadSec) || nRadSec <= 0) return [];

        // Δv in km/s (input is m/s).
        const dvR_kms = (dvR || 0) / 1000;
        const dvT_kms = (dvT || 0) / 1000;
        const dvN_kms = (dvN || 0) / 1000;

        const out = [];
        for (const c of selectedAsset.conjs) {
            if (!Number.isFinite(c.tca_ms) || !c.miss_vec) continue;

            const dtSec  = (c.tca_ms - burnMs) / 1000;
            const drRtn  = applyCwStm(dvR_kms, dvT_kms, dvN_kms, nRadSec, dtSec);

            // RTN basis at TCA — Δr_RTN(τ) is expressed in the
            // *rotating* frame's axes at time τ, which are the same
            // as the unperturbed chief's RTN axes at TCA in TEME.
            const jdTca   = c.tca_ms / 86400000 + 2440587.5;
            const tsTca   = (jdTca - epochJd) * MIN_PER_DAY;
            const tcaBasis = rtnBasisAt(tle, tsTca);
            if (!tcaBasis) continue;

            const drTeme = {
                x: drRtn.r * tcaBasis.Rhat.x + drRtn.t * tcaBasis.That.x + drRtn.n * tcaBasis.Nhat.x,
                y: drRtn.r * tcaBasis.Rhat.y + drRtn.t * tcaBasis.That.y + drRtn.n * tcaBasis.Nhat.y,
                z: drRtn.r * tcaBasis.Rhat.z + drRtn.t * tcaBasis.That.z + drRtn.n * tcaBasis.Nhat.z,
            };

            const mx = c.miss_vec.x + drTeme.x;
            const my = c.miss_vec.y + drTeme.y;
            const mz = c.miss_vec.z + drTeme.z;
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

        // Caveat text depends on the asset's eccentricity. CW assumes
        // a circular chief; for e ≳ 0.05 the along-track / radial
        // coupling drifts off the closed-form prediction. LEO ops
        // sats typically e < 0.005, well within CW accuracy.
        const ecc = selectedAsset?.tle?.eccentricity ?? 0;
        const periodMin = selectedAsset?.tle?.period_min ?? null;
        const periodHint = Number.isFinite(periodMin)
            ? ` Orbital period ${periodMin.toFixed(0)} min — CW captures one full revolution.`
            : '';
        const eccCaveat = ecc > 0.05
            ? `Clohessy-Wiltshire STM (RTN, circular chief) — eccentricity ${ecc.toFixed(3)} is high; CW degrades. Treat as advisory.`
            : `Clohessy-Wiltshire STM (RTN, circular chief).${periodHint} Advisory only — for production planning use a dedicated FDS.`;

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
                ${eccCaveat}
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
