/**
 * Drift-path tracer + Alfvén-layer finder for the ring-current simulation.
 *
 * WHY the ring builds the way it does, made visible: guiding-centre drift
 * paths in the equatorial plane under the SAME potential the transport core
 * advects with — corotation + shielded Volland–Stern convection (γ=2) +
 * energy-dependent gradient–curvature drift. Closed paths circle Earth
 * (trapped: the ring current); open paths sweep sunward to the magnetopause
 * (convection outflow). The separatrix between them is the ALFVÉN LAYER, and
 * its energy/charge dependence is the textbook explanation for nose
 * injections and for ions penetrating deeper than electrons at dusk. The
 * zero-energy layer is the plasmapause-forming flow boundary (pure E×B),
 * which is why it hugs the Carpenter–Anderson ring the scene already draws.
 *
 * READ-ONLY CONSUMER of the transport's exported physics (driftAt,
 * convectionAmplitude): no transport-core edits, so the Rust/WASM kernel
 * parity (tests/ring-current-kernel-smoke.mjs) is untouched by this module.
 * Electrons reuse driftAt's E×B terms and swap the grad–curv sign via
 * driftRateRadPerHour(species) — same magnitude, eastward.
 *
 * Conventions (pinned by tests/ring-current-drift-paths.mjs):
 *   az = 2π·MLT/24, eastward-increasing: 0 midnight, π/2 dawn, π noon,
 *   3π/2 dusk. Scene mapping (ENA/heat shaders): θ_world = π − az.
 */

import { driftAt, convectionAmplitude } from './ring-current-transport.js';
import { PHYS, driftRateRadPerHour } from './ring-current-model.js';

export { convectionAmplitude };

const OMEGA_E = 7.2921159e-5;                          // Earth rotation (rad/s)
const B0_RE2  = PHYS.B0_T * PHYS.R_E_M * PHYS.R_E_M;   // drift denominator base
const COROT_C = OMEGA_E * B0_RE2;                      // corotation amplitude (V·R_E)

/** Guiding-centre drift (R_E/s, rad/s) for either charge sign. Ions come
 *  straight from the transport's driftAt; electrons swap the grad–curv term
 *  for its eastward twin (identical E×B — the potential is charge-blind). */
export function driftVelocity(L, az, eKev, convA, species = 'ion') {
    const d = driftAt(L, az, eKev, convA);
    if (species !== 'electron' || !(eKev > 0)) return d;
    const gcIon = driftRateRadPerHour(eKev, L, 'ion') / 3600;       // rad/s, <0
    const gcEle = driftRateRadPerHour(eKev, L, 'electron') / 3600;  // rad/s, >0
    return { dLdt: d.dLdt, dAzdt: d.dAzdt - gcIon + gcEle };
}

/**
 * Drift stagnation point — where the total azimuthal drift vanishes on a
 * flow meridian (the radial drift is identically 0 on dawn/dusk: ∂Φ/∂az ∝
 * cos az). Two regimes, both physical:
 *   • DUSK (az 3π/2): eastward corotation (Ω_E) + an eastward/weak grad–curv
 *     term loses to the westward convection return flow (∝ L³) going out —
 *     the classic low-energy / electron stagnation.
 *   • DAWN (az π/2): westward grad–curv (∝ E·L, energetic ions) loses to the
 *     eastward corotation+convection (∝ L³) going out — the energetic-ion
 *     stagnation sits on the dawnside.
 * The angular rate is monotonic in L on each meridian, so bisection. The
 * Alfvén layer passes through whichever point exists. Returns
 * { L, az } or null (e.g. convA = 0: corotation never loses).
 */
export function stagnationL(eKev, convA, species = 'ion') {
    const lo0 = 1.1, hi0 = 14;
    const solve = (az, sLo) => {
        const w = (L) => driftVelocity(L, az, eKev, convA, species).dAzdt;
        // sLo = expected sign at the inner end (+1 dusk regime, −1 dawn).
        if (!(Math.sign(w(lo0)) === sLo) || !(Math.sign(w(hi0)) === -sLo)) return null;
        let lo = lo0, hi = hi0;
        for (let i = 0; i < 48; i++) {
            const mid = 0.5 * (lo + hi);
            if (Math.sign(w(mid)) === sLo) lo = mid; else hi = mid;
        }
        return 0.5 * (lo + hi);
    };
    const dusk = solve(1.5 * Math.PI, +1);
    if (dusk != null) return { L: dusk, az: 1.5 * Math.PI };
    const dawn = solve(0.5 * Math.PI, -1);
    if (dawn != null) return { L: dawn, az: 0.5 * Math.PI };
    return null;
}

/** Analytic zero-energy stagnation (pure E×B): L³ = COROT_C / (2·convA).
 *  The test anchor for stagnationL(0, …). */
export function stagnationLZeroEnergy(convA) {
    return convA > 0 ? Math.cbrt(COROT_C / (2 * convA)) : null;
}

/**
 * Trace one drift path from (L0, az0). RK2 midpoint, adaptive dt capped so a
 * step never exceeds ~0.5° of azimuth or ~0.02 R_E radially. Terminates when
 * the accumulated |Δaz| wraps 2π (closed → trapped) or L leaves
 * [lMin, lMax] (open → convected out / lost inward).
 *
 * @returns {{ pts: Float32Array, n: number, closed: boolean }} pts = packed
 *   (L, az) pairs, n = points used.
 */
export function traceDriftPath(L0, az0, eKev, convA, species = 'ion', opts = {}) {
    const { lMin = 1.3, lMax = 10, maxSteps = 4000, keepEvery = 4 } = opts;
    const pts = new Float32Array(2 * (Math.floor(maxSteps / keepEvery) + 2));
    let L = L0, az = az0, azAcc = 0, n = 0, closed = false;
    const put = (l, a) => { pts[2 * n] = l; pts[2 * n + 1] = a; n++; };
    put(L, az);
    for (let s = 0; s < maxSteps; s++) {
        const d1 = driftVelocity(L, az, eKev, convA, species);
        // Adaptive dt from the CURRENT rates (guards the stagnation crawl).
        const dt = Math.min(
            240,
            0.0087 / (Math.abs(d1.dAzdt) + 1e-9),
            0.02 / (Math.abs(d1.dLdt) + 1e-9));
        const Lm = L + 0.5 * dt * d1.dLdt, azm = az + 0.5 * dt * d1.dAzdt;
        const d2 = driftVelocity(Math.max(lMin, Lm), azm, eKev, convA, species);
        L += dt * d2.dLdt;
        az += dt * d2.dAzdt;
        azAcc += dt * d2.dAzdt;
        if ((s + 1) % keepEvery === 0) put(L, az);
        if (Math.abs(azAcc) >= 2 * Math.PI) { closed = true; put(L, az); break; }
        if (L < lMin || L > lMax) { put(L, az); break; }
    }
    return { pts, n, closed };
}

/**
 * The trapping boundary (last closed drift path) as a polyline. Two regimes,
 * both real:
 *   • 'xpoint'    — a stagnation point exists in range: the classic Alfvén
 *                   layer through the X-point (low-energy / cold plasma;
 *                   the zero-energy case is the plasmapause-forming layer).
 *   • 'shadowing' — no interior stagnation (ring-current-energy ions drift
 *                   westward everywhere): the boundary is where drift shells
 *                   graze the magnetopause — DRIFT-SHELL SHADOWING, found by
 *                   bisecting the tracer's own closed/open classification at
 *                   midnight.
 * Returns { pts, n, closed, Ls, azS, mode } or null (convA=0 AND nothing
 * open in range).
 */
export function alfvenLayer(eKev, convA, species = 'ion', opts = {}) {
    const s = stagnationL(eKev, convA, species);
    if (s) {
        const path = traceDriftPath(s.L * 0.95, s.az, eKev, convA, species,
            { maxSteps: 24000, keepEvery: 12, ...opts });
        return { ...path, Ls: s.L, azS: s.az, mode: 'xpoint' };
    }
    // Shadowing regime: bisect the closed/open transition at midnight.
    const isClosed = (L0) => traceDriftPath(L0, 0, eKev, convA, species,
        { maxSteps: 8000, keepEvery: 8 }).closed;
    let lo = 2.2, hi = 9.8;
    if (!isClosed(lo) || isClosed(hi)) return null;   // no transition in range
    for (let i = 0; i < 14; i++) {
        const mid = 0.5 * (lo + hi);
        if (isClosed(mid)) lo = mid; else hi = mid;
    }
    const path = traceDriftPath(lo, 0, eKev, convA, species,
        { maxSteps: 24000, keepEvery: 12, ...opts });
    return { ...path, Ls: lo, azS: 0, mode: 'shadowing' };
}

/**
 * A representative bundle of drift paths for one (energy, species, Kp): a
 * MIDNIGHT RADIAL SCAN, each trace classified closed/open by the tracer
 * itself (a wrapped path is a contour — genuinely trapped), plus the Alfvén
 * layer. No seeding heuristics: the scan exposes the actual drift topology.
 * This is the render feed — the globe converts (L, az) → scene xz.
 */
export function driftPathBundle(eKev, kp, species = 'ion') {
    const convA = convectionAmplitude(kp);
    const layer = alfvenLayer(eKev, convA, species);
    const paths = [];
    for (let L0 = 2.4; L0 <= 9.2; L0 += 0.85) {
        const p = traceDriftPath(L0, 0, eKev, convA, species, { maxSteps: 8000, keepEvery: 6 });
        paths.push({ ...p, kind: p.closed ? 'closed' : 'open', L0 });
    }
    return { layer, paths, Ls: layer?.Ls ?? null, convA };
}
