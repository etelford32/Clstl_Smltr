/**
 * satellite-designer-engine.js — orbital flight model for the Satellite Designer
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A compact, dependency-light 2-D orbital dynamics core built for *physical
 * realism* in the upper-atmosphere regime (≈ 100–1000 km). It models:
 *
 *   • Newtonian point-mass gravity              a = −μ r / |r|³
 *   • Atmospheric drag against a co-rotating    F = ½ ρ |v_rel|² C_d A
 *     thermosphere (real NRLMSISE/Jacchia ρ
 *     reused from upper-atmosphere-engine.js)
 *   • Finite-thrust propulsion with the         dm/dt = −F / (Isp · g₀)
 *     Tsiolkovsky mass-flow relation            Δv   =  Isp · g₀ · ln(m₀/m_f)
 *
 * The integrator is fixed-step RK4 over the state (x, y, vx, vy, fuel) with
 * an altitude-adaptive sub-step so the deep-drag / re-entry regime stays
 * stable without paying for tiny steps up at apogee.
 *
 * Everything here is pure (no DOM, no globals) so it can be unit-tested —
 * see selfTest() at the bottom, mirroring upper-atmosphere-engine.js.
 *
 * Frame: inertial 2-D plane (ECI-like), Earth centred at origin, prograde =
 * counter-clockwise. Two dimensions is enough — drag-driven decay and the
 * maneuver set we expose all live in the orbit plane — and it keeps the
 * visualisation honest and the math auditable.
 */

import { density as thermosphereDensity } from './upper-atmosphere-engine.js';

// ── Physical constants ──────────────────────────────────────────────────────
export const MU = 3.986004418e14;     // Earth GM            [m³/s²]
export const R_EARTH = 6_371_000;     // mean Earth radius   [m]
export const OMEGA_EARTH = 7.2921159e-5; // sidereal rotation [rad/s]
export const G0 = 9.80665;            // standard gravity    [m/s²]

// Mission-ending floor: below this the vehicle is deep enough into the
// mesosphere that aerodynamic heating destroys it within seconds.
export const REENTRY_ALT_M = 80_000;

// ── Engine technology presets ───────────────────────────────────────────────
// thrust [N], isp [s] — representative real hardware classes. The huge
// thrust/Isp spread is the whole game: an ion thruster sips propellant but
// can barely out-push drag in a single pass, a bipropellant kick stage can
// re-boost in one burn but empties the tank fast.
export const ENGINE_PRESETS = {
    cold_gas:      { label: 'Cold-gas (N₂)',          thrust: 1.0,    isp: 65   },
    monoprop:      { label: 'Monoprop hydrazine',     thrust: 22.0,   isp: 225  },
    biprop:        { label: 'Bipropellant (MMH/NTO)', thrust: 445.0,  isp: 321  },
    hall_ion:      { label: 'Hall-effect ion',        thrust: 0.25,   isp: 1800 },
    gridded_ion:   { label: 'Gridded ion (Xe)',       thrust: 0.092,  isp: 3300 },
};

/**
 * Build a validated spacecraft design from raw UI numbers.
 * @returns {{name,dryMass,fuelMass,area,cd,thrust,isp,engine}}
 */
export function makeDesign(raw = {}) {
    const d = {
        name:     String(raw.name ?? 'Untitled Craft').slice(0, 60),
        engine:   raw.engine ?? 'monoprop',
        dryMass:  clampNum(raw.dryMass,  1,    100_000, 120),    // kg
        fuelMass: clampNum(raw.fuelMass, 0,    500_000, 60),     // kg
        area:     clampNum(raw.area,     0.01, 5_000,   1.2),    // m² ref. area
        cd:       clampNum(raw.cd,       1.0,  4.0,     2.2),    // free-molecular ≈ 2.2
        thrust:   clampNum(raw.thrust,   0,    50_000,  22),     // N
        isp:      clampNum(raw.isp,      10,   5_000,   225),    // s
    };
    return d;
}

/** Default space-weather environment (drag driver). */
export function defaultEnv() {
    // F10.7 ≈ 150 sfu / Ap ≈ 12 ≈ a moderately active Sun — the regime
    // where solar-cycle thermosphere swelling is clearly felt in LEO.
    return { f107Sfu: 150, ap: 12 };
}

// ── State construction ──────────────────────────────────────────────────────
/**
 * Place the vehicle on an orbit defined by perigee/apogee altitude (km).
 * Starts at perigee on the +x axis, moving prograde (+y).
 */
export function initState(design, { periKm = 400, apoKm = null } = {}) {
    const rp = R_EARTH + Math.max(periKm, 5) * 1000;
    const ra = R_EARTH + Math.max(apoKm ?? periKm, periKm) * 1000;
    const a  = 0.5 * (rp + ra);
    // vis-viva at perigee
    const vp = Math.sqrt(MU * (2 / rp - 1 / a));
    return {
        x: rp, y: 0,
        vx: 0, vy: vp,
        fuel: design.fuelMass,
        t: 0,             // mission elapsed sim-seconds
        alive: true,
        reason: '',       // why the mission ended, if it did
    };
}

// ── Atmosphere ──────────────────────────────────────────────────────────────
/**
 * Mass density [kg/m³] at geometric altitude. Above 80 km we defer to the
 * app's validated thermosphere model (species-resolved diffusive
 * equilibrium, F10.7/Ap responsive). Below that we only need a monotone
 * "drag explodes on re-entry" continuation — physical fidelity in the
 * stratosphere is irrelevant because the vehicle is already destroyed.
 */
export function airDensity(altM, env) {
    const hKm = altM / 1000;
    if (hKm >= 80) {
        const r = thermosphereDensity({ altitudeKm: hKm, f107Sfu: env.f107Sfu, ap: env.ap });
        return r.rho;
    }
    // Continuation below the model floor: anchor on ρ(80 km) and grow with a
    // ~7 km scale height down toward sea level.
    const rho80 = thermosphereDensity({ altitudeKm: 80, f107Sfu: env.f107Sfu, ap: env.ap }).rho;
    return rho80 * Math.exp((80 - hKm) / 7.0);
}

/** Local gravitational acceleration magnitude [m/s²]. */
export function gravityAt(altM) {
    const r = R_EARTH + altM;
    return MU / (r * r);
}

// ── Equations of motion ─────────────────────────────────────────────────────
/**
 * Acceleration + fuel-rate at a state, given the pilot's control.
 * control = { throttle ∈ [0,1], mode ∈ prograde|retrograde|radial-out|
 *             radial-in|off }
 * Returns { ax, ay, dfuel, diag:{ rho, vrel, qdyn, aDrag } }.
 */
function derivatives(s, design, env, control) {
    const r = Math.hypot(s.x, s.y);
    const alt = r - R_EARTH;

    // Gravity (inverse-square, central).
    const gOverR = -MU / (r * r * r);
    let ax = gOverR * s.x;
    let ay = gOverR * s.y;

    const mass = design.dryMass + Math.max(s.fuel, 0);

    // Drag against the co-rotating atmosphere: v_atm = ω × r (about +z).
    const vAtmX = -OMEGA_EARTH * s.y;
    const vAtmY =  OMEGA_EARTH * s.x;
    const wx = s.vx - vAtmX;
    const wy = s.vy - vAtmY;
    const vrel = Math.hypot(wx, wy);
    const rho = airDensity(alt, env);
    // a_drag = −½ ρ |v_rel| (Cd A / m) v_rel
    const k = 0.5 * rho * vrel * design.cd * design.area / mass;
    const aDragX = -k * wx;
    const aDragY = -k * wy;
    ax += aDragX;
    ay += aDragY;
    const aDragMag = Math.hypot(aDragX, aDragY);
    const qdyn = 0.5 * rho * vrel * vrel;

    // Thrust. Direction is defined relative to the *inertial* velocity /
    // radius, the way real burns are planned.
    let dfuel = 0;
    const thr = (control?.throttle ?? 0) * design.thrust;
    if (thr > 0 && s.fuel > 0 && control.mode && control.mode !== 'off') {
        let dirX = 0, dirY = 0;
        const vmag = Math.hypot(s.vx, s.vy) || 1;
        if (control.mode === 'prograde')       { dirX =  s.vx / vmag; dirY =  s.vy / vmag; }
        else if (control.mode === 'retrograde'){ dirX = -s.vx / vmag; dirY = -s.vy / vmag; }
        else if (control.mode === 'radial-out'){ dirX =  s.x / r;     dirY =  s.y / r;     }
        else if (control.mode === 'radial-in') { dirX = -s.x / r;     dirY = -s.y / r;     }
        const aThr = thr / mass;
        ax += aThr * dirX;
        ay += aThr * dirY;
        dfuel = -thr / (design.isp * G0);   // Tsiolkovsky mass flow
    }

    return { ax, ay, dfuel, diag: { rho, vrel, qdyn, aDrag: aDragMag, alt } };
}

/**
 * One RK4 step of duration dt. Pure: returns a fresh state.
 */
export function step(s, design, env, control, dt) {
    if (!s.alive) return s;

    const add = (st, k, h) => ({
        x:  st.x  + k.dx  * h,
        y:  st.y  + k.dy  * h,
        vx: st.vx + k.dvx * h,
        vy: st.vy + k.dvy * h,
        fuel: Math.max(0, st.fuel + k.df * h),
    });
    const deriv = (st) => {
        const d = derivatives(st, design, env, control);
        return { dx: st.vx, dy: st.vy, dvx: d.ax, dvy: d.ay, df: d.dfuel, diag: d.diag };
    };

    const k1 = deriv(s);
    const k2 = deriv(add(s, k1, dt / 2));
    const k3 = deriv(add(s, k2, dt / 2));
    const k4 = deriv(add(s, k3, dt));

    const out = {
        x:  s.x  + (dt / 6) * (k1.dx  + 2 * k2.dx  + 2 * k3.dx  + k4.dx),
        y:  s.y  + (dt / 6) * (k1.dy  + 2 * k2.dy  + 2 * k3.dy  + k4.dy),
        vx: s.vx + (dt / 6) * (k1.dvx + 2 * k2.dvx + 2 * k3.dvx + k4.dvx),
        vy: s.vy + (dt / 6) * (k1.dvy + 2 * k2.dvy + 2 * k3.dvy + k4.dvy),
        fuel: Math.max(0, s.fuel + (dt / 6) * (k1.df + 2 * k2.df + 2 * k3.df + k4.df)),
        t: s.t + dt,
        alive: true,
        reason: '',
    };

    const alt = Math.hypot(out.x, out.y) - R_EARTH;
    if (alt <= REENTRY_ALT_M) {
        out.alive = false;
        out.reason = 'reentry';
    }
    return out;
}

/**
 * Advance `seconds` of sim time with an altitude-adaptive sub-step. Returns
 * { state, ended } and never overshoots a destroyed vehicle.
 */
export function advance(s, design, env, control, seconds) {
    let st = s;
    let remaining = seconds;
    let guard = 0;
    while (remaining > 1e-6 && st.alive && guard < 200_000) {
        const alt = Math.hypot(st.x, st.y) - R_EARTH;
        // Deeper in the atmosphere → stiffer drag → shorter step.
        let dt;
        if (alt > 300_000)      dt = 4;
        else if (alt > 180_000) dt = 1;
        else if (alt > 120_000) dt = 0.25;
        else                    dt = 0.05;
        dt = Math.min(dt, remaining);
        st = step(st, design, env, control, dt);
        remaining -= dt;
        guard++;
    }
    return { state: st, ended: !st.alive };
}

// ── Orbital elements & telemetry ────────────────────────────────────────────
/** Classical 2-D elements from the state vector. */
export function elements(s) {
    const r = Math.hypot(s.x, s.y);
    const v2 = s.vx * s.vx + s.vy * s.vy;
    const energy = v2 / 2 - MU / r;            // specific orbital energy
    const a = -MU / (2 * energy);              // semi-major axis (∞ if parabolic)
    const hz = s.x * s.vy - s.y * s.vx;        // specific angular momentum (z)
    const rDotV = s.x * s.vx + s.y * s.vy;
    // Eccentricity vector e = ((v²−μ/r) r − (r·v) v) / μ
    const c = v2 - MU / r;
    const ex = (c * s.x - rDotV * s.vx) / MU;
    const ey = (c * s.y - rDotV * s.vy) / MU;
    const ecc = Math.hypot(ex, ey);
    const bound = energy < 0 && isFinite(a);
    const rp = bound ? a * (1 - ecc) : r;
    const ra = bound ? a * (1 + ecc) : Infinity;
    const period = bound ? 2 * Math.PI * Math.sqrt((a * a * a) / MU) : Infinity;
    return {
        r, speed: Math.sqrt(v2), a, ecc, hz, energy, bound,
        rp, ra,
        periAltKm: (rp - R_EARTH) / 1000,
        apoAltKm:  bound ? (ra - R_EARTH) / 1000 : Infinity,
        altKm: (r - R_EARTH) / 1000,
        period,
    };
}

/**
 * Live mission telemetry — everything the cockpit gauges show.
 */
export function telemetry(s, design, env) {
    const el = elements(s);
    const mass = design.dryMass + Math.max(s.fuel, 0);
    const d = derivatives(s, design, { ...env }, { throttle: 0, mode: 'off' });

    // Δv still in the tank (Tsiolkovsky), and the drag-only decay estimate.
    const dvRemaining = s.fuel > 0
        ? design.isp * G0 * Math.log((design.dryMass + s.fuel) / design.dryMass)
        : 0;
    const ballisticCoeff = mass / (design.cd * design.area);   // kg/m²

    // Specific-energy loss rate from drag → semi-major-axis decay rate.
    // ε̇ = a_nongrav · v ;  ȧ = (2 a² / μ) ε̇
    const dragPower = -(d.diag.aDrag) * el.speed;              // ≤ 0 (J/kg/s)
    let aDot = 0, decayPerOrbitKm = 0, daysToReentry = Infinity;
    if (el.bound) {
        aDot = (2 * el.a * el.a / MU) * dragPower;             // m/s, ≤ 0
        decayPerOrbitKm = (aDot * el.period) / 1000;
        if (aDot < -1e-9) {
            const aReentry = R_EARTH + 100_000;
            daysToReentry = Math.max(0, (el.a - aReentry) / -aDot) / 86_400;
        }
    }

    return {
        altKm: el.altKm,
        periAltKm: el.periAltKm,
        apoAltKm: el.apoAltKm,
        speed: el.speed,
        vrel: d.diag.vrel,
        period: el.period,
        ecc: el.ecc,
        bound: el.bound,
        rho: d.diag.rho,
        qdyn: d.diag.qdyn,
        dragAccel: d.diag.aDrag,
        dragG: d.diag.aDrag / G0,
        mass,
        fuel: Math.max(0, s.fuel),
        fuelFrac: design.fuelMass > 0 ? Math.max(0, s.fuel) / design.fuelMass : 0,
        dvRemaining,
        ballisticCoeff,
        decayPerOrbitKm,
        daysToReentry,
        missionTime: s.t,
        alive: s.alive,
        reason: s.reason,
    };
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function clampNum(v, lo, hi, dflt) {
    const n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
}

// ── Self-test ───────────────────────────────────────────────────────────────
/**
 * Sanity battery. Returns [{ pass, msg }] — same shape the smoke test
 * expects from upper-atmosphere-engine's selfTest().
 */
export function selfTest() {
    const out = [];
    const T = (cond, msg) => out.push({ pass: !!cond, msg });
    const rel = (x, y) => Math.abs(x - y) / Math.abs(y);

    // 1. Surface gravity ≈ 9.80 m/s².
    T(rel(gravityAt(0), 9.798) < 0.02, `g(0) ≈ 9.8 (got ${gravityAt(0).toFixed(3)})`);

    // 2. Circular speed at 400 km ≈ 7669 m/s.
    const rc = R_EARTH + 400_000;
    const vc = Math.sqrt(MU / rc);
    T(rel(vc, 7669) < 0.01, `v_circ(400 km) ≈ 7669 (got ${vc.toFixed(0)})`);

    // 3. Vacuum circular orbit conserves energy/radius over a quarter period
    //    (drag killed via zero reference area).
    const dragless = makeDesign({ dryMass: 100, fuelMass: 0, area: 0, cd: 2.2 });
    const env = defaultEnv();
    let s = initState(dragless, { periKm: 400 });
    const el0 = elements(s);
    const quarter = el0.period / 4;
    const r1 = advance(s, dragless, env, { throttle: 0, mode: 'off' }, quarter);
    const el1 = elements(r1.state);
    T(rel(el1.r, el0.r) < 1e-3, `vacuum |r| conserved (Δ ${(rel(el1.r, el0.r) * 100).toExponential(2)}%)`);
    T(rel(el1.energy, el0.energy) < 1e-4, `vacuum energy conserved`);

    // 4. Tsiolkovsky: burning all propellant prograde matches Isp·g₀·ln(m0/mf).
    const ship = makeDesign({ dryMass: 100, fuelMass: 50, area: 0, cd: 2.2, thrust: 400, isp: 300 });
    let sb = initState(ship, { periKm: 600 });
    const v0 = Math.hypot(sb.vx, sb.vy);
    let burn = sb;
    for (let i = 0; i < 60_000 && burn.fuel > 1e-6; i++) {
        burn = step(burn, ship, env, { throttle: 1, mode: 'prograde' }, 0.1);
    }
    const dvActual = Math.hypot(burn.vx, burn.vy) - v0;
    const dvIdeal = ship.isp * G0 * Math.log((ship.dryMass + ship.fuelMass) / ship.dryMass);
    // Gravity/drag bleed a little off the ideal; 6% band over a 600 km burn.
    T(rel(dvActual, dvIdeal) < 0.06,
        `Tsiolkovsky Δv: ideal ${dvIdeal.toFixed(0)} vs flown ${dvActual.toFixed(0)} m/s`);

    // 5. Drag at 250 km bleeds the semi-major axis (orbit decays).
    const draggy = makeDesign({ dryMass: 50, fuelMass: 0, area: 4, cd: 2.2 });
    let sd = initState(draggy, { periKm: 250 });
    const a0 = elements(sd).a;
    const rd = advance(sd, draggy, env, { throttle: 0, mode: 'off' }, 6 * 3600);
    const a1 = elements(rd.state).a;
    T(a1 < a0, `drag decays a: ${(a0 / 1000).toFixed(0)} → ${(a1 / 1000).toFixed(0)} km`);

    // 6. Density is monotone decreasing with altitude through the thermosphere.
    const r200 = airDensity(200_000, env);
    const r500 = airDensity(500_000, env);
    T(r200 > r500 && r500 > 0, `ρ(200 km) > ρ(500 km) (${r200.toExponential(1)} > ${r500.toExponential(1)})`);

    // 7. Re-entry floor terminates the mission.
    const plunge = makeDesign({ dryMass: 200, fuelMass: 0, area: 30, cd: 2.4 });
    let sp = initState(plunge, { periKm: 95, apoKm: 95 });
    const rp = advance(sp, plunge, env, { throttle: 0, mode: 'off' }, 6 * 3600);
    T(!rp.state.alive && rp.state.reason === 'reentry', `decaying craft re-enters & ends mission`);

    return out;
}
