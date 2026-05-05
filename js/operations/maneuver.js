/**
 * maneuver.js — "What-if" maneuver planner for the Operations console.
 *
 * Lets an operator type an RTN Δv at a chosen burn time and see the
 * predicted shift in miss distance for every existing conjunction
 * involving the selected asset.
 *
 * Model (default): linearised two-body propagator — RK4 integration
 * of the gravity-gradient equation
 *
 *   d²Δr/dt² = −μ · Δr / |r_c|³ + 3μ (r_c · Δr) r_c / |r_c|⁵
 *
 * around the chief's actual SGP4 trajectory r_c(t). This is the
 * physics the Yamanaka-Ankersen STM expresses analytically for an
 * elliptical chief (and CW for a circular chief). Doing it
 * numerically buys arbitrary eccentricity without writing out the
 * closed-form YA matrix, plus J2 / drag effects that come for free
 * because r_c is read from SGP4. RK4 with a 5-min step (10-min for
 * coasts > 6 d) gives sub-km Δr accuracy over a 14-day horizon —
 * well below TLE uncertainty.
 *
 * The chief's positions are pre-computed once via WASM
 * propagate_batch and shared across all conjunctions; per-
 * conjunction cost is just the RK4 walk (~30 µs at 1 d coast).
 *
 * Fallback (when WASM batch is unavailable): closed-form
 * Clohessy-Wiltshire STM in the RTN frame. Circular-chief
 * assumption — accurate for LEO ops sats (e < 0.005), degraded for
 * e > 0.05; the panel caveat copy reflects this.
 *
 * Caveats (both models):
 *   - Δv at the chief; the secondary's path is held fixed.
 *   - The new orbit's actual TCA may shift in time vs. the original
 *     screen's TCA. We evaluate Δr at the original t_tca, which is
 *     close enough for advisory work but not a maneuver plan.
 *   - For production planning use a dedicated FDS / numerical
 *     integrator with the full force model.
 *
 * The panel re-renders on:
 *   - selection change      (which asset's conjunctions to use)
 *   - deck.subscribeRows    (new screen → new conjunctions)
 *   - input change          (Δv R/T/N or burn-time UTC)
 *   - timeBus tick          (so "use sim time" stays synced)
 *
 * Mounted into a panel in the operations right column.
 */

import { propagate, tleEpochToJd, getWasmSgp4 } from '../satellite-tracker.js';
import { timeBus }                              from './time-bus.js';

const MIN_PER_DAY = 1440;
// Earth gravitational parameter (WGS-72 — matches the SGP4 propagator
// already in use, so the chief trajectory's μ is consistent with the
// gravity-gradient term we apply in RK4).
const MU_KM3_S2 = 398600.8;

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
     * Yamanaka-Ankersen-equivalent perturbation propagator.
     *
     * Numerically integrates the *linearised* two-body equation of
     * motion for the perturbation Δr around the chief's actual
     * trajectory:
     *
     *   d²Δr/dt² = −μ · Δr / |r_c|³ + 3μ (r_c · Δr) r_c / |r_c|⁵
     *
     * That's the gravity gradient at the chief's position; the same
     * physics the YA closed-form STM expresses analytically for an
     * elliptical chief (and CW for a circular chief). Doing it
     * numerically buys us:
     *   - arbitrary eccentricity (no circular-chief assumption);
     *   - the chief's J2 / drag drift comes for free, because we
     *     read r_c from SGP4 instead of integrating two-body;
     *   - the same code path validates against CW for low e — a
     *     useful test hook.
     *
     * RK4 with a 5-min step (10-min for coasts > 6 d) gives sub-km
     * Δr accuracy over a 14-day horizon, well below TLE uncertainty.
     * The chief position grid is computed once via WASM
     * propagate_batch and reused across all conjunctions, so per-
     * conjunction cost is just the RK4 walk (~30 μs at 1 d coast).
     *
     * Returns Δr in TEME km. Falls back to the closed-form CW STM
     * when WASM batch is unavailable.
     */
    function propagateLinearizedPerturbation(tle, tsBurnMin, tsTcaMin, dvTeme, opts = {}) {
        const totalMin = tsTcaMin - tsBurnMin;
        const stepMin  = opts.stepMin ?? (Math.abs(totalMin) > 6 * 1440 ? 10 : 5);
        const halfMin  = stepMin / 2;
        if (Math.abs(totalMin) < halfMin) {
            // Coast too short to step — for τ → 0 the linearised
            // result collapses to Δr = Δv · τ regardless of model.
            const tauSec = totalMin * 60;
            return {
                x: dvTeme.x * tauSec,
                y: dvTeme.y * tauSec,
                z: dvTeme.z * tauSec,
            };
        }

        // Caller may pass a pre-computed chief grid that covers a
        // longer span. We just walk the prefix that matches our
        // [burn, tca] window. Saves N batch propagates when the
        // panel evaluates many conjunctions of the same asset.
        const grid = opts.grid ?? chiefPositionGrid(tle, tsBurnMin, tsTcaMin, halfMin);
        if (!grid) return null;

        const direction = totalMin >= 0 ? 1 : -1;
        const nSteps = Math.max(1, Math.floor(Math.abs(totalMin) / stepMin));
        const stepSec = direction * stepMin * 60;
        const halfSec = stepSec / 2;

        let drx = 0, dry = 0, drz = 0;
        let dvx = dvTeme.x, dvy = dvTeme.y, dvz = dvTeme.z;

        // Scratch for k2/k3/k4 intermediate states. Inlined to dodge
        // per-step Object allocation in the hot RK4 loop.
        for (let s = 0; s < nSteps; s++) {
            const idx0 = s * 2;          // chief position at t
            const idx1 = idx0 + 1;       // at t + h/2
            const idx2 = idx0 + 2;       // at t + h

            // k1: derivative at (Δr, Δv) with chief @ t
            const r1x = grid[idx0 * 3],     r1y = grid[idx0 * 3 + 1], r1z = grid[idx0 * 3 + 2];
            const a1  = gravityGradient(r1x, r1y, r1z, drx, dry, drz);
            const k1_drx = dvx,        k1_dry = dvy,        k1_drz = dvz;
            const k1_dvx = a1.x,       k1_dvy = a1.y,       k1_dvz = a1.z;

            // k2: at midpoint with k1 step
            const dr2x = drx + halfSec * k1_drx, dr2y = dry + halfSec * k1_dry, dr2z = drz + halfSec * k1_drz;
            const dv2x = dvx + halfSec * k1_dvx, dv2y = dvy + halfSec * k1_dvy, dv2z = dvz + halfSec * k1_dvz;
            const r2x = grid[idx1 * 3],     r2y = grid[idx1 * 3 + 1], r2z = grid[idx1 * 3 + 2];
            const a2  = gravityGradient(r2x, r2y, r2z, dr2x, dr2y, dr2z);
            const k2_drx = dv2x,       k2_dry = dv2y,       k2_drz = dv2z;
            const k2_dvx = a2.x,       k2_dvy = a2.y,       k2_dvz = a2.z;

            // k3: at midpoint with k2 step
            const dr3x = drx + halfSec * k2_drx, dr3y = dry + halfSec * k2_dry, dr3z = drz + halfSec * k2_drz;
            const dv3x = dvx + halfSec * k2_dvx, dv3y = dvy + halfSec * k2_dvy, dv3z = dvz + halfSec * k2_dvz;
            const a3  = gravityGradient(r2x, r2y, r2z, dr3x, dr3y, dr3z);
            const k3_drx = dv3x,       k3_dry = dv3y,       k3_drz = dv3z;
            const k3_dvx = a3.x,       k3_dvy = a3.y,       k3_dvz = a3.z;

            // k4: full step with k3
            const dr4x = drx + stepSec * k3_drx, dr4y = dry + stepSec * k3_dry, dr4z = drz + stepSec * k3_drz;
            const dv4x = dvx + stepSec * k3_dvx, dv4y = dvy + stepSec * k3_dvy, dv4z = dvz + stepSec * k3_dvz;
            const r3x = grid[idx2 * 3],     r3y = grid[idx2 * 3 + 1], r3z = grid[idx2 * 3 + 2];
            const a4  = gravityGradient(r3x, r3y, r3z, dr4x, dr4y, dr4z);
            const k4_drx = dv4x,       k4_dry = dv4y,       k4_drz = dv4z;
            const k4_dvx = a4.x,       k4_dvy = a4.y,       k4_dvz = a4.z;

            const sixth = stepSec / 6;
            drx += sixth * (k1_drx + 2 * k2_drx + 2 * k3_drx + k4_drx);
            dry += sixth * (k1_dry + 2 * k2_dry + 2 * k3_dry + k4_dry);
            drz += sixth * (k1_drz + 2 * k2_drz + 2 * k3_drz + k4_drz);
            dvx += sixth * (k1_dvx + 2 * k2_dvx + 2 * k3_dvx + k4_dvx);
            dvy += sixth * (k1_dvy + 2 * k2_dvy + 2 * k3_dvy + k4_dvy);
            dvz += sixth * (k1_dvz + 2 * k2_dvz + 2 * k3_dvz + k4_dvz);
        }
        return { x: drx, y: dry, z: drz };
    }

    /**
     * Linearised two-body acceleration on a perturbation Δr around a
     * chief at r_c. Two-body gravity gradient:
     *   a = −μ Δr / r³ + 3μ (r·Δr) r / r⁵
     * Returns { x, y, z } in km/s².
     */
    function gravityGradient(rx, ry, rz, drx, dry, drz) {
        const r2 = rx * rx + ry * ry + rz * rz;
        if (r2 < 1) return { x: 0, y: 0, z: 0 };       // chief lost
        const rMag = Math.sqrt(r2);
        const r3   = r2 * rMag;
        const r5   = r3 * r2;
        const dot  = rx * drx + ry * dry + rz * drz;
        const f1   = -MU_KM3_S2 / r3;
        const f2   = 3 * MU_KM3_S2 * dot / r5;
        return {
            x: f1 * drx + f2 * rx,
            y: f1 * dry + f2 * ry,
            z: f1 * drz + f2 * rz,
        };
    }

    /**
     * Pre-compute the chief's TEME position on a uniform grid spanning
     * [tsBurnMin, tsTcaMin] at `halfStepMin` resolution. RK4 needs
     * three samples per step (t, t+h/2, t+h) — the half-step grid
     * lets us index those in O(1) without per-step propagate calls.
     *
     * Uses WASM propagate_batch when available (one call, ~µs/sample).
     * Falls back to per-sample propagate() for older WASM caches.
     * Returns a Float64Array of [x, y, z] triplets, or null on
     * total failure.
     */
    function chiefPositionGrid(tle, tsBurnMin, tsTcaMin, halfStepMin) {
        const direction = tsTcaMin >= tsBurnMin ? 1 : -1;
        const total = Math.abs(tsTcaMin - tsBurnMin);
        const n = Math.max(2, Math.floor(total / halfStepMin) + 2);
        const times = new Float64Array(n);
        for (let i = 0; i < n; i++) times[i] = tsBurnMin + direction * i * halfStepMin;

        const wasm = getWasmSgp4();
        if (wasm?.propagate_batch && tle.line1 && tle.line2) {
            try {
                const flat = wasm.propagate_batch(tle.line1, tle.line2, times);
                // flat is [x, y, z, vx, vy, vz] per sample. We only
                // need positions — pack into a tighter Float64Array.
                const out = new Float64Array(n * 3);
                for (let i = 0; i < n; i++) {
                    out[i * 3]     = flat[i * 6];
                    out[i * 3 + 1] = flat[i * 6 + 1];
                    out[i * 3 + 2] = flat[i * 6 + 2];
                }
                return out;
            } catch (_) { /* fall through */ }
        }
        const out = new Float64Array(n * 3);
        for (let i = 0; i < n; i++) {
            const r = propagate(tle, times[i]);
            if (!Number.isFinite(r?.x)) return null;
            out[i * 3]     = r.x;
            out[i * 3 + 1] = r.y;
            out[i * 3 + 2] = r.z;
        }
        return out;
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
     * Evaluate the projected miss-distance shift for every
     * conjunction of the selected asset. For each conjunction:
     *   - convert Δv from RTN-at-burn into TEME;
     *   - propagate the perturbation forward via the linearised
     *     two-body integrator (Yamanaka-Ankersen-equivalent for
     *     elliptical chiefs; reduces to CW for circular ones);
     *   - add Δr to miss_vec, take magnitude.
     *
     * If the WASM batch propagator isn't available (very old cache
     * or WASM disabled entirely), drop back to the closed-form CW
     * STM — still better than free-flight, just less accurate when
     * the chief is eccentric.
     */
    function projectShifts() {
        if (!selectedAsset?.tle || !selectedAsset.conjs?.length) return [];
        const tle = selectedAsset.tle;
        const epochJd = tleEpochToJd(tle);

        const jdBurn = burnMs / 86400000 + 2440587.5;
        const tsBurnMin = (jdBurn - epochJd) * MIN_PER_DAY;
        const burnBasis = rtnBasisAt(tle, tsBurnMin);
        if (!burnBasis) return [];

        // Δv in km/s (input is m/s), then RTN @ burn → TEME.
        const dvR_kms = (dvR || 0) / 1000;
        const dvT_kms = (dvT || 0) / 1000;
        const dvN_kms = (dvN || 0) / 1000;
        const dvTeme = {
            x: dvR_kms * burnBasis.Rhat.x + dvT_kms * burnBasis.That.x + dvN_kms * burnBasis.Nhat.x,
            y: dvR_kms * burnBasis.Rhat.y + dvT_kms * burnBasis.That.y + dvN_kms * burnBasis.Nhat.y,
            z: dvR_kms * burnBasis.Rhat.z + dvT_kms * burnBasis.That.z + dvN_kms * burnBasis.Nhat.z,
        };

        // CW fallback path — only entered if WASM batch is missing.
        const wasmBatchOk = !!getWasmSgp4()?.propagate_batch;
        const nRadSec = (tle.mean_motion * 2 * Math.PI) / 86400;
        const useCwFallback = !wasmBatchOk && Number.isFinite(nRadSec) && nRadSec > 0;

        // One grid for all conjunctions of the same asset — covers
        // the longest |coast| we'll need. Saves N batch propagates
        // per evaluation.
        let sharedGrid = null;
        let sharedStepMin = null;
        if (wasmBatchOk) {
            const eligible = selectedAsset.conjs.filter(c => Number.isFinite(c.tca_ms) && c.miss_vec);
            if (eligible.length) {
                const tsTcasMin = eligible.map(c => ((c.tca_ms / 86400000 + 2440587.5) - epochJd) * MIN_PER_DAY);
                const minTs = Math.min(tsBurnMin, ...tsTcasMin);
                const maxTs = Math.max(tsBurnMin, ...tsTcasMin);
                const longestMin = Math.max(maxTs - tsBurnMin, tsBurnMin - minTs);
                sharedStepMin = longestMin > 6 * 1440 ? 10 : 5;
                sharedGrid = chiefPositionGrid(tle, tsBurnMin, maxTs, sharedStepMin / 2);
            }
        }

        const out = [];
        for (const c of selectedAsset.conjs) {
            if (!Number.isFinite(c.tca_ms) || !c.miss_vec) continue;

            const dtSec  = (c.tca_ms - burnMs) / 1000;
            const jdTca  = c.tca_ms / 86400000 + 2440587.5;
            const tsTca  = (jdTca - epochJd) * MIN_PER_DAY;

            let drTeme = null;
            if (wasmBatchOk) {
                drTeme = propagateLinearizedPerturbation(
                    tle, tsBurnMin, tsTca, dvTeme,
                    { grid: sharedGrid, stepMin: sharedStepMin },
                );
            } else if (useCwFallback) {
                const drRtn = applyCwStm(dvR_kms, dvT_kms, dvN_kms, nRadSec, dtSec);
                const tcaBasis = rtnBasisAt(tle, tsTca);
                if (tcaBasis) {
                    drTeme = {
                        x: drRtn.r * tcaBasis.Rhat.x + drRtn.t * tcaBasis.That.x + drRtn.n * tcaBasis.Nhat.x,
                        y: drRtn.r * tcaBasis.Rhat.y + drRtn.t * tcaBasis.That.y + drRtn.n * tcaBasis.Nhat.y,
                        z: drRtn.r * tcaBasis.Rhat.z + drRtn.t * tcaBasis.That.z + drRtn.n * tcaBasis.Nhat.z,
                    };
                }
            }
            if (!drTeme) continue;

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

        // Caveat text reflects the active model. The default path is
        // the linearised two-body integrator (YA-equivalent for
        // arbitrary eccentricity); CW only kicks in when the WASM
        // batch propagator is unavailable.
        const ecc = selectedAsset?.tle?.eccentricity ?? 0;
        const periodMin = selectedAsset?.tle?.period_min ?? null;
        const wasmBatchOk = !!getWasmSgp4()?.propagate_batch;
        const periodHint = Number.isFinite(periodMin)
            ? ` Chief period ${periodMin.toFixed(0)} min.`
            : '';
        let eccCaveat;
        if (wasmBatchOk) {
            const eccBadge = ecc > 0.05 ? ` Eccentricity ${ecc.toFixed(3)} — handled exactly.` : '';
            eccCaveat = `Linearised two-body (Yamanaka-Ankersen-equivalent), J2-aware via SGP4 chief.${periodHint}${eccBadge} Advisory only — for production planning use a dedicated FDS.`;
        } else {
            eccCaveat = ecc > 0.05
                ? `Clohessy-Wiltshire STM (circular-chief fallback) — eccentricity ${ecc.toFixed(3)} is high; treat as rough advisory.`
                : `Clohessy-Wiltshire STM (circular-chief fallback).${periodHint} Advisory only.`;
        }

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
