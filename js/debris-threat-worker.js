/**
 * debris-threat-worker.js — background SGP4 screening of operational sats
 * ═══════════════════════════════════════════════════════════════════════════
 * Module Worker that runs the expensive all-sats-× -debris conjunction
 * screen off the main thread, so the animation loop stays at 60 fps while
 * the catalog is evaluated. Messages:
 *
 *   in  'init'        → load Rust WASM SGP4 asynchronously.
 *   out 'ready'       → { wasm: boolean } once init resolved.
 *
 *   in  'screen-all'  → { targets: TLE[], debris: TLE[],
 *                         params: { hoursAhead, stepMin, thresholdKm } }
 *                       Legacy shape used by satellites.html. Anchors
 *                       at Date.now() and skips refine/Δv.
 *   out 'progress'    → { done, total } every ~5 % of targets.
 *   out 'complete'    → { results: { [noradId]: Threat[] } }
 *                       where Threat = { name, norad_id, dist_km,
 *                       hours_ahead, tca_jd[, tca_ms, dv_kms,
 *                       miss_unit, group] }.
 *
 *   in  'screen-fleet' → { runId, epochMs, targets: TLE[],
 *                          secondaries: TLE[],
 *                          params: { horizonH, stepMin, thresholdKm,
 *                                    refine, withDv } }
 *                        Predictions-first variant used by the
 *                        Operations console: anchors at `epochMs`
 *                        (sim time, not wall clock), parabolic refine
 *                        through dist²(i-1, i, i+1), |Δv| via 10 s
 *                        central-diff at TCA, and a horizon-aware
 *                        apogee/perigee overlap pre-filter.
 *   out 'progress'    → { runId, done, total }.
 *   out 'complete'    → { runId, results }.
 *   out 'error'       → { error[, runId] }.
 *
 * runId lets the main thread discard stale results when the user
 * re-screens before the previous run finishes (the screen anchor or
 * filters changed mid-run).
 */

const TWOPI       = 2 * Math.PI;
const MIN_PER_DAY = 1440;
const RE_KM       = 6378.135;
const DEG2RAD     = Math.PI / 180;

let _wasmSgp4 = null;

async function _loadWasm() {
    try {
        const mod = await import('./sgp4-wasm/sgp4_wasm.js');
        await mod.default();
        _wasmSgp4 = mod;
    } catch (err) {
        // JS fallback handles everything; not an error.
        _wasmSgp4 = null;
    }
}

// ── JS Kepler fallback (mirrors satellite-tracker.js:jsFallbackPropagate) ──
function jsFallbackPropagate(tle, tsince_min) {
    const n0     = tle.mean_motion * TWOPI / MIN_PER_DAY;
    const e0     = tle.eccentricity;
    const i0     = tle.inclination * DEG2RAD;
    const raan0  = tle.raan * DEG2RAD;
    const argp0  = tle.arg_perigee * DEG2RAD;
    const M0     = tle.mean_anomaly * DEG2RAD;

    const cosI   = Math.cos(i0);
    const J2     = 0.001082616;
    const a      = Math.pow(398600.8 / (n0 * n0 / 3600), 1 / 3);
    const p      = a * (1 - e0 * e0);

    const n0_corr = n0 * (1 + 1.5 * J2 * (RE_KM / p) ** 2 * (1 - 1.5 * (1 - cosI * cosI)));
    const raanDot = -1.5 * J2 * (RE_KM / p) ** 2 * n0 * cosI;
    const argpDot =  0.75 * J2 * (RE_KM / p) ** 2 * n0 * (5 * cosI * cosI - 1);

    const M    = M0    + n0_corr * tsince_min;
    const raan = raan0 + raanDot * tsince_min;
    const argp = argp0 + argpDot * tsince_min;

    let E = M;
    for (let k = 0; k < 10; k++) {
        const dE = (E - e0 * Math.sin(E) - M) / (1 - e0 * Math.cos(E));
        E -= dE;
        if (Math.abs(dE) < 1e-12) break;
    }

    const cosE = Math.cos(E);
    const sinE = Math.sin(E);
    const nu   = Math.atan2(Math.sqrt(1 - e0 * e0) * sinE, cosE - e0);
    const r    = a * (1 - e0 * cosE);

    const u     = argp + nu;
    const cosU  = Math.cos(u),    sinU  = Math.sin(u);
    const cosR  = Math.cos(raan), sinR  = Math.sin(raan);
    const cosI2 = Math.cos(i0),   sinI2 = Math.sin(i0);

    return {
        x: r * (cosR * cosU - sinR * sinU * cosI2),
        y: r * (sinR * cosU + cosR * sinU * cosI2),
        z: r * sinU * sinI2,
    };
}

function propagate(tle, tsince_min) {
    if (_wasmSgp4 && tle.line1 && tle.line2) {
        try {
            const result = _wasmSgp4.propagate_tle(tle.line1, tle.line2, tsince_min);
            if (result && result.length >= 3 && isFinite(result[0])) {
                return { x: result[0], y: result[1], z: result[2] };
            }
        } catch (_) {}
    }
    return jsFallbackPropagate(tle, tsince_min);
}

// TLE epoch fractional year → Julian Date. Same arithmetic as the main
// tracker's tleEpochToJd so worker results line up with animate-loop
// propagation to the same jd.
function tleEpochToJd(tle) {
    const epochYr = tle.epoch_yr ?? 2026;
    const yr      = Math.floor(epochYr);
    const dayFrac = (epochYr - yr) * (yr % 4 === 0 ? 366 : 365);
    const jdJan1  = 367 * yr - Math.floor(7 * (yr + Math.floor(10 / 12)) / 4) + Math.floor(275 / 9) + 1721013.5;
    return jdJan1 + dayFrac;
}

// ── Single-target screen against the debris catalog ─────────────────────
function screenOne(target, debris, params) {
    const hoursAhead  = params.hoursAhead  ?? 24;
    const stepMin     = params.stepMin     ?? 10;
    const thresholdKm = params.thresholdKm ?? 50;
    const nSteps      = Math.ceil(hoursAhead * 60 / stepMin);

    const jd         = Date.now() / 86400000 + 2440587.5;
    const tsinceBase = (jd - target.epochJd) * MIN_PER_DAY;

    // Times array feeds the WASM batch call; the JS fallback uses it via
    // propagate() per step.
    const times = new Float64Array(nSteps);
    for (let i = 0; i < nSteps; i++) times[i] = tsinceBase + i * stepMin;

    // Propagate target across all steps.
    let targetPos = null;
    if (_wasmSgp4 && target.tle.line1 && target.tle.line2) {
        try {
            const result = _wasmSgp4.propagate_batch(target.tle.line1, target.tle.line2, times);
            targetPos = new Array(nSteps);
            for (let i = 0; i < nSteps; i++) {
                const off = i * 6;
                targetPos[i] = { x: result[off], y: result[off + 1], z: result[off + 2] };
            }
        } catch (_) { targetPos = null; }
    }
    if (!targetPos) {
        targetPos = new Array(nSteps);
        for (let i = 0; i < nSteps; i++) {
            targetPos[i] = propagate(target.tle, times[i]);
        }
    }

    const targetAlt = (target.tle.perigee_km + target.tle.apogee_km) / 2;
    const threats   = [];

    for (const cat of debris) {
        const catAlt = (cat.tle.perigee_km + cat.tle.apogee_km) / 2;
        if (Math.abs(catAlt - targetAlt) > 200) continue;

        const catTsinceBase = (jd - cat.epochJd) * MIN_PER_DAY;
        let closest = null;

        for (let i = 0; i < nSteps; i++) {
            const tgt = targetPos[i];
            if (!isFinite(tgt.x)) continue;
            const catPos = propagate(cat.tle, catTsinceBase + i * stepMin);
            if (!isFinite(catPos.x)) continue;
            const dx = tgt.x - catPos.x;
            const dy = tgt.y - catPos.y;
            const dz = tgt.z - catPos.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist < thresholdKm && (!closest || dist < closest.dist_km)) {
                closest = {
                    name:        cat.tle.name,
                    norad_id:    cat.tle.norad_id,
                    dist_km:     Math.round(dist * 10) / 10,
                    hours_ahead: Math.round(i * stepMin / 60 * 10) / 10,
                    // Absolute TCA as Julian Date — lets the main thread
                    // compute "minutes until/since TCA" against sim time
                    // (which can scrub, so relative offsets aren't enough).
                    tca_jd:      jd + (i * stepMin) / MIN_PER_DAY,
                };
            }
        }
        if (closest) threats.push(closest);
    }

    threats.sort((a, b) => a.dist_km - b.dist_km);
    return threats;
}

// ── Predictions-first single-target screen (Operations console) ────────
// Same skeleton as screenOne, but:
//   - anchors at caller-supplied `epochMs` instead of Date.now();
//   - apogee/perigee overlap pre-filter that widens with horizon;
//   - tracks the global minimum across the window (not first-under-thr);
//   - parabolic refine of dist²(i-1, i, i+1) for sub-step TCA + miss;
//   - optional |Δv| via 10 s central-difference on both TLEs at TCA,
//     plus the relative-velocity vector and unit miss vector — those
//     two are everything a downstream B-plane needs to place the dot
//     on real (B·R, B·T) axes;
//   - optional dist sample window around TCA (fed to the deck for
//     inline sparklines).

// How many samples (each side) to capture around the closest-approach
// index for the sparkline. 5 + center + 5 = 11 samples; at 10 min step
// that's ±50 min, which covers the encounter geometry around TCA.
const SPARK_HALF_WINDOW = 5;

function screenOneFleet(target, secondaries, params, epochMs) {
    const horizonH    = params.horizonH    ?? 24;
    const stepMin     = params.stepMin     ?? 10;
    const thresholdKm = params.thresholdKm ?? 50;
    const refine      = params.refine      !== false;
    const withDv      = params.withDv      !== false;
    const withSpark   = params.withSpark   !== false;
    const nSteps      = Math.ceil(horizonH * 60 / stepMin);

    const jd         = epochMs / 86400000 + 2440587.5;
    const tsinceBase = (jd - target.epochJd) * MIN_PER_DAY;

    const times = new Float64Array(nSteps);
    for (let i = 0; i < nSteps; i++) times[i] = tsinceBase + i * stepMin;

    let targetPos = null;
    if (_wasmSgp4 && target.tle.line1 && target.tle.line2) {
        try {
            const result = _wasmSgp4.propagate_batch(target.tle.line1, target.tle.line2, times);
            targetPos = new Array(nSteps);
            for (let i = 0; i < nSteps; i++) {
                const off = i * 6;
                targetPos[i] = { x: result[off], y: result[off + 1], z: result[off + 2] };
            }
        } catch (_) { targetPos = null; }
    }
    if (!targetPos) {
        targetPos = new Array(nSteps);
        for (let i = 0; i < nSteps; i++) targetPos[i] = propagate(target.tle, times[i]);
    }

    const targetAlt = (target.tle.perigee_km + target.tle.apogee_km) / 2;
    const altMargin = Math.min(50 * (horizonH / 24) + 200, 1500);
    const threats   = [];

    for (const cat of secondaries) {
        if (cat.tle.norad_id === target.tle.norad_id) continue;

        const catPerigee = cat.tle.perigee_km;
        const catApogee  = cat.tle.apogee_km;
        if (catApogee  + altMargin < targetAlt - 200) continue;
        if (catPerigee - altMargin > targetAlt + 200) continue;

        const catTsinceBase = (jd - cat.epochJd) * MIN_PER_DAY;
        const catPos = new Array(nSteps);
        // Sample-distance buffer (km) — kept so we can crop a window
        // around bestI for the sparkline without re-propagating.
        const dists  = new Float32Array(nSteps);
        let bestI    = -1;
        let bestD2   = Infinity;

        for (let i = 0; i < nSteps; i++) {
            const tgt = targetPos[i];
            if (!isFinite(tgt.x)) { dists[i] = NaN; continue; }

            const cp = propagate(cat.tle, catTsinceBase + i * stepMin);
            catPos[i] = cp;
            if (!isFinite(cp.x)) { dists[i] = NaN; continue; }

            const dx = tgt.x - cp.x;
            const dy = tgt.y - cp.y;
            const dz = tgt.z - cp.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            dists[i] = Math.sqrt(d2);
            if (d2 < bestD2) { bestD2 = d2; bestI = i; }
        }
        if (bestI < 0) continue;

        let missKm    = Math.sqrt(bestD2);
        let tcaOffMin = bestI * stepMin;

        if (refine && bestI > 0 && bestI < nSteps - 1) {
            const tgtL = targetPos[bestI - 1];
            const tgtR = targetPos[bestI + 1];
            const cpL  = catPos[bestI - 1];
            const cpR  = catPos[bestI + 1];
            if (isFinite(tgtL?.x) && isFinite(tgtR?.x) && isFinite(cpL?.x) && isFinite(cpR?.x)) {
                const dL = (tgtL.x - cpL.x) ** 2 + (tgtL.y - cpL.y) ** 2 + (tgtL.z - cpL.z) ** 2;
                const dC = bestD2;
                const dR = (tgtR.x - cpR.x) ** 2 + (tgtR.y - cpR.y) ** 2 + (tgtR.z - cpR.z) ** 2;
                const denom = dL - 2 * dC + dR;
                if (Math.abs(denom) > 1e-9) {
                    const delta = 0.5 * (dL - dR) / denom;
                    if (delta > -1 && delta < 1) {
                        tcaOffMin = (bestI + delta) * stepMin;
                        const d2Min = dC - 0.25 * (dL - dR) * delta;
                        if (d2Min > 0 && isFinite(d2Min)) missKm = Math.sqrt(d2Min);
                    }
                }
            }
        }

        if (missKm > thresholdKm) continue;

        let dvKms    = null;
        let missUnit = null;
        let vRel     = null;
        let missVec  = null;
        if (withDv) {
            const tcaT  = tsinceBase + tcaOffMin;
            const halfH = 10 / 60;
            const pA = propagate(target.tle, tcaT - halfH);
            const pB = propagate(target.tle, tcaT + halfH);
            const sA = propagate(cat.tle,    catTsinceBase + tcaOffMin - halfH);
            const sB = propagate(cat.tle,    catTsinceBase + tcaOffMin + halfH);
            if (isFinite(pA.x) && isFinite(pB.x) && isFinite(sA.x) && isFinite(sB.x)) {
                const dt = 20;
                const vRelX = ((pB.x - pA.x) - (sB.x - sA.x)) / dt;
                const vRelY = ((pB.y - pA.y) - (sB.y - sA.y)) / dt;
                const vRelZ = ((pB.z - pA.z) - (sB.z - sA.z)) / dt;
                dvKms = Math.sqrt(vRelX * vRelX + vRelY * vRelY + vRelZ * vRelZ);
                vRel  = { x: vRelX, y: vRelY, z: vRelZ };

                const tcaP = propagate(target.tle, tcaT);
                const tcaS = propagate(cat.tle,    catTsinceBase + tcaOffMin);
                if (isFinite(tcaP.x) && isFinite(tcaS.x)) {
                    const mx = tcaP.x - tcaS.x;
                    const my = tcaP.y - tcaS.y;
                    const mz = tcaP.z - tcaS.z;
                    const m  = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
                    missVec  = { x: mx, y: my, z: mz };
                    missUnit = { x: mx / m, y: my / m, z: mz / m };
                }
            }
        }

        // Sparkline window: ±SPARK_HALF_WINDOW samples around bestI,
        // clipped to [0, nSteps-1]. NaN samples are dropped at the
        // renderer; we keep them in the array so the time axis stays
        // consistent.
        let spark = null;
        if (withSpark) {
            const lo  = Math.max(0, bestI - SPARK_HALF_WINDOW);
            const hi  = Math.min(nSteps - 1, bestI + SPARK_HALF_WINDOW);
            const km  = new Array(hi - lo + 1);
            for (let i = lo; i <= hi; i++) km[i - lo] = dists[i];
            spark = {
                km,
                step_min:     stepMin,
                center_index: bestI - lo,        // index of TCA-coarse in the cropped array
            };
        }

        const tcaMs = epochMs + tcaOffMin * 60 * 1000;

        threats.push({
            name:        cat.tle.name,
            norad_id:    cat.tle.norad_id,
            group:       cat.group ?? null,
            dist_km:     Math.round(missKm * 100) / 100,
            hours_ahead: Math.round(tcaOffMin / 60 * 100) / 100,
            tca_jd:      jd + tcaOffMin / MIN_PER_DAY,
            tca_ms:      tcaMs,
            dv_kms:      dvKms != null ? Math.round(dvKms * 1000) / 1000 : null,
            v_rel:       vRel,
            miss_unit:   missUnit,
            miss_vec:    missVec,
            spark,
        });
    }

    threats.sort((a, b) => a.dist_km - b.dist_km);
    return threats;
}

self.onmessage = async (e) => {
    const msg = e.data;
    try {
        if (msg.type === 'init') {
            await _loadWasm();
            self.postMessage({ type: 'ready', wasm: !!_wasmSgp4 });
            return;
        }

        if (msg.type === 'screen-all') {
            const params = msg.params ?? {};
            // Enrich input TLEs with their precomputed epoch JD.  Cheaper
            // to do once here than inside the per-step propagate() calls.
            const targets = msg.targets.map(t => ({ tle: t, epochJd: tleEpochToJd(t) }));
            const debris  = msg.debris.map(d  => ({ tle: d, epochJd: tleEpochToJd(d) }));

            const results = Object.create(null);
            const total   = targets.length;
            const progressStep = Math.max(1, Math.floor(total / 20));   // ~5 % chunks

            for (let i = 0; i < total; i++) {
                const threats = screenOne(targets[i], debris, params);
                if (threats.length > 0) {
                    results[targets[i].tle.norad_id] = threats;
                }
                if ((i + 1) % progressStep === 0 || i === total - 1) {
                    self.postMessage({ type: 'progress', done: i + 1, total });
                }
            }

            self.postMessage({ type: 'complete', results });
            return;
        }

        if (msg.type === 'screen-fleet') {
            const runId   = msg.runId;
            const epochMs = Number.isFinite(msg.epochMs) ? msg.epochMs : Date.now();
            const params  = msg.params ?? {};

            // Targets are { tle, group } shaped on the wire so the
            // worker can echo group back per-secondary; epochJd is
            // computed once per object here.
            const targets = msg.targets.map(t => ({
                tle: t.tle ?? t, group: t.group ?? null,
                epochJd: tleEpochToJd(t.tle ?? t),
            }));
            const secondaries = msg.secondaries.map(s => ({
                tle: s.tle ?? s, group: s.group ?? null,
                epochJd: tleEpochToJd(s.tle ?? s),
            }));

            const results      = Object.create(null);
            const total        = targets.length;
            const progressStep = Math.max(1, Math.floor(total / 20));

            for (let i = 0; i < total; i++) {
                const threats = screenOneFleet(targets[i], secondaries, params, epochMs);
                if (threats.length > 0) {
                    results[targets[i].tle.norad_id] = threats;
                }
                if ((i + 1) % progressStep === 0 || i === total - 1) {
                    self.postMessage({ type: 'progress', runId, done: i + 1, total });
                }
            }

            self.postMessage({ type: 'complete', runId, results });
            return;
        }
    } catch (err) {
        self.postMessage({ type: 'error', runId: e?.data?.runId ?? null, error: String(err?.message ?? err) });
    }
};
