/**
 * debris-threat-worker.js — background SGP4 screening of operational sats
 * ═══════════════════════════════════════════════════════════════════════════
 * Module Worker that runs the expensive all-sats-× -debris conjunction
 * screen off the main thread, so the animation loop stays at 60 fps while
 * the catalog is evaluated. Messages:
 *
 *   in  'init'       → load Rust WASM SGP4 asynchronously.
 *   out 'ready'      → { wasm: boolean } once init resolved.
 *
 *   in  'screen-all' → { targets: TLE[], debris: TLE[],
 *                         params: { hoursAhead, stepMin, thresholdKm } }
 *   out 'progress'   → { done, total } every ~50 targets.
 *   out 'complete'   → { results: { [noradId]: Threat[] } }
 *                      where Threat = { name, norad_id, dist_km, hours_ahead }.
 *   out 'error'      → { error: string } if anything throws.
 *
 * The algorithm mirrors SatelliteTracker.screenConjunctions with
 * groupFilter='debris': WASM propagate_batch for the target, WASM
 * propagate_tle (or JS Kepler fallback) for each debris entry, altitude
 * pre-filter (|Δalt| > 200 km → skip). Only the *closest* approach per
 * debris object is kept to bound result size.
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
                };
            }
        }
        if (closest) threats.push(closest);
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
    } catch (err) {
        self.postMessage({ type: 'error', error: String(err?.message ?? err) });
    }
};
