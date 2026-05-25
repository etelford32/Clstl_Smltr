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
    // ── Cutting-edge electric propulsion ──
    // High Isp, tiny thrust, and (the new lever) a real electrical-power
    // appetite — see js/satellite-builder.js THRUSTER_UNITS .power. Under-
    // power one and it throttles down proportionally.
    hall_shielded: { label: 'Mag-shielded Hall',      thrust: 0.30,   isp: 2000 },
    iodine_ion:    { label: 'Iodine gridded ion',     thrust: 0.010,  isp: 2200 },
    electrospray:  { label: 'Electrospray / FEEP',    thrust: 0.0011, isp: 2800 },
    water_resisto: { label: 'Water electrothermal',   thrust: 0.060,  isp: 165  },
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
    // gravityMul scales the planet's GM in real time — 1.0 = Earth,
    // 0.16 ≈ Moon, 2.0 ≈ super-Earth — for "what if" gameplay.
    return { f107Sfu: 150, ap: 12, gravityMul: 1.0 };
}

/** Effective GM for the current env. Centralised so every consumer
 *  (gravity force, orbital elements, surface g, circular speed) reads
 *  the same scaled value when the pilot moves the gravity slider. */
export function effectiveMU(env) {
    const m = +(env?.gravityMul ?? 1);
    return MU * (isFinite(m) && m > 0 ? m : 1);
}

// ── Space-weather presets ───────────────────────────────────────────────────
// Thermospheric density at a fixed altitude swings by ~an order of magnitude
// across these regimes — the single largest source of real LEO-drag
// variability. F10.7 is the 10.7 cm solar radio flux (solar EUV proxy, sfu);
// Ap is the daily planetary geomagnetic index (Joule heating proxy). The
// Carrington/Gannon extremes saturate Ap near its 400 ceiling.
export const SPACE_WEATHER_PRESETS = {
    solar_min:   { label: 'Solar minimum',     f107Sfu: 68,  ap: 4   },
    nominal:     { label: 'Nominal',           f107Sfu: 150, ap: 12  },
    solar_max:   { label: 'Solar maximum',     f107Sfu: 230, ap: 20  },
    geo_storm:   { label: 'Geomagnetic storm', f107Sfu: 180, ap: 120 },
    carrington:  { label: 'Carrington-class',  f107Sfu: 250, ap: 400 },
};

// ── Drag attitude ───────────────────────────────────────────────────────────
// How the vehicle is pointed multiplies its effective Cd·A relative to the
// "as-designed" broadside reference area. Feathered ≈ knife-edge / sun-
// pointing minimum section (Starlink in safe mode); broadside ≈ panels flat
// to the flow (aerobraking); tumbling ≈ orientation-averaged for a convex
// body (≈¼ of the wetted area vs. the max projected face).
export const ATTITUDE_MODES = {
    feathered: { label: 'Feathered',  mult: 0.30 },
    nominal:   { label: 'Nominal',    mult: 1.00 },
    broadside: { label: 'Broadside',  mult: 1.90 },
    tumbling:  { label: 'Tumbling',   mult: 0.70 },
};

/** Effective drag-area multiplier for a control object (default 1×). */
export function attitudeMult(control) {
    const m = control && Number(control.attitudeMult);
    return Number.isFinite(m) && m > 0 ? m : 1;
}

// ── State construction ──────────────────────────────────────────────────────
/**
 * Place the vehicle on an orbit defined by perigee/apogee altitude (km).
 * Starts at perigee on the +x axis, moving prograde (+y).
 */
export function initState(design, { periKm = 400, apoKm = null, env = null } = {}) {
    const rp = R_EARTH + Math.max(periKm, 5) * 1000;
    const ra = R_EARTH + Math.max(apoKm ?? periKm, periKm) * 1000;
    const a  = 0.5 * (rp + ra);
    // vis-viva at perigee — uses the *effective* GM so the chosen perigee
    // really is the orbit's perigee under the current gravity slider.
    const mu = effectiveMU(env);
    const vp = Math.sqrt(mu * (2 / rp - 1 / a));
    return {
        x: rp, y: 0,
        vx: 0, vy: vp,
        fuel: design.fuelMass,
        t: 0,             // mission elapsed sim-seconds
        alive: true,
        reason: '',       // why the mission ended, if it did
        // Realism extras the new flight model writes to:
        burnSeconds: 0,   // accumulated full-throttle-equivalent burn time
        tumbleRate:  0,   // body angular rate (rad/s) about the orbit normal
        attitudeErr: 0,   // angle off the commanded heading (rad)
    };
}

// ── Atmospheric turbulence ─────────────────────────────────────────────────
// Low-frequency density fluctuation driven by gravity waves & solar
// activity. Two octaves of sinusoid + a slow random walk give a credible
// ±15 % wobble around the model mean that the pilot can feel: drag
// throbs, the spacecraft tumbles more under high q. Amplitude scales
// with Ap (storm-time mesoscale variability is much higher).
function turbulenceFactor(t, env) {
    const apFrac = Math.min(1, (env.ap ?? 12) / 250);
    const baseAmp = 0.05 + 0.18 * apFrac;       // ±5 % quiet, ±23 % storm
    const a = Math.sin(t * 0.011) * 0.6;
    const b = Math.sin(t * 0.043 + 1.7) * 0.4;
    return 1 + baseAmp * (a + b);
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

/** Local gravitational acceleration magnitude [m/s²]. Pass env to honour
 *  the user's gravity-slider override; without env you get base Earth. */
export function gravityAt(altM, env = null) {
    const r = R_EARTH + altM;
    return effectiveMU(env) / (r * r);
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

    // Gravity (inverse-square, central). MU scales with env.gravityMul so
    // the pilot's gravity slider reshapes orbits in real time without
    // requiring a sim reset.
    const mu = effectiveMU(env);
    const gOverR = -mu / (r * r * r);
    let ax = gOverR * s.x;
    let ay = gOverR * s.y;

    const mass = design.dryMass + Math.max(s.fuel, 0);

    // Drag against the co-rotating atmosphere: v_atm = ω × r (about +z).
    const vAtmX = -OMEGA_EARTH * s.y;
    const vAtmY =  OMEGA_EARTH * s.x;
    const wx = s.vx - vAtmX;
    const wy = s.vy - vAtmY;
    const vrel = Math.hypot(wx, wy);
    // Mean-density model multiplied by a turbulence factor — gravity-wave +
    // storm-time mesoscale variability. Pilots feel a throb in drag during
    // storms; the value is also fed into a stochastic tumble term below.
    const rhoMean = airDensity(alt, env);
    const turb = turbulenceFactor(s.t, env);
    const rho = rhoMean * turb;
    // a_drag = −½ ρ |v_rel| (Cd A · attitude / m) v_rel. The attitude
    // multiplier scales the effective frontal area: feathering shrinks it,
    // flying broadside (aerobrake) inflates it. Lost attitude (tumble)
    // bloats effective area toward broadside — costs you energy when the
    // bus is spinning into the wind.
    const aMult = attitudeMult(control);
    const tumblePenalty = 1 + 0.7 * Math.min(1.5, Math.abs(s.tumbleRate || 0));
    const k = 0.5 * rho * vrel * design.cd * design.area * aMult * tumblePenalty / mass;
    const aDragX = -k * wx;
    const aDragY = -k * wy;
    ax += aDragX;
    ay += aDragY;
    const aDragMag = Math.hypot(aDragX, aDragY);
    const qdyn = 0.5 * rho * vrel * vrel;

    // Thrust. Direction is defined relative to the *inertial* velocity /
    // radius, the way real burns are planned. Three realism layers are
    // bolted on:
    //   • throat erosion → Isp & thrust decay with accumulated burn time
    //   • gimbal vectoring → control.gimbal (rad) rotates the thrust
    //     vector by up to ±design.gimbalRad off the burn axis
    //   • turbulence-driven attitude noise → small misalignment penalty
    let dfuel = 0;
    const baseThr = (control?.throttle ?? 0) * design.thrust;
    // Erosion factor: 0 burn → 1.0; ≥ throatLifeS at full power → 0.75
    // (capped 25 % loss; players still get a craft they can fly home).
    const life = Math.max(1, design.throatLifeS ?? 6_000);
    const erosionFrac = Math.min(1, (s.burnSeconds || 0) / life);
    const erosionFactor = 1 - 0.25 * erosionFrac;
    const thr = baseThr * erosionFactor;
    if (thr > 0 && s.fuel > 0 && control.mode && control.mode !== 'off') {
        let dirX = 0, dirY = 0;
        const vmag = Math.hypot(s.vx, s.vy) || 1;
        // 'manual' / 'manual-retro' fire along (or opposite) a pilot-controlled
        // heading in the orbit plane. Heading 0 = +x, π/2 = +y.
        const h = typeof control.heading === 'number' ? control.heading : Math.atan2(s.vy, s.vx);
        if (control.mode === 'prograde')       { dirX =  s.vx / vmag; dirY =  s.vy / vmag; }
        else if (control.mode === 'retrograde'){ dirX = -s.vx / vmag; dirY = -s.vy / vmag; }
        else if (control.mode === 'radial-out'){ dirX =  s.x / r;     dirY =  s.y / r;     }
        else if (control.mode === 'radial-in') { dirX = -s.x / r;     dirY = -s.y / r;     }
        else if (control.mode === 'manual')      { dirX =  Math.cos(h); dirY =  Math.sin(h); }
        else if (control.mode === 'manual-retro'){ dirX = -Math.cos(h); dirY = -Math.sin(h); }
        // Gimbal: rotate (dirX, dirY) by the commanded vector angle, clamped
        // to the engine's mechanical authority. Default zero so legacy
        // callers see no change.
        const gMax = design.gimbalRad ?? 0;
        const gCmd = Math.max(-gMax, Math.min(gMax, control.gimbal ?? 0));
        if (gCmd !== 0) {
            const c = Math.cos(gCmd), si = Math.sin(gCmd);
            const rx = dirX * c - dirY * si;
            const ry = dirX * si + dirY * c;
            dirX = rx; dirY = ry;
        }
        const aThr = thr / mass;
        ax += aThr * dirX;
        ay += aThr * dirY;
        // Isp loses the same fraction as thrust under erosion — both depend
        // on the throat keeping its geometry.
        const effIsp = design.isp * erosionFactor;
        dfuel = -thr / (effIsp * G0);       // Tsiolkovsky mass flow
    }

    return { ax, ay, dfuel,
             diag: { rho, rhoMean, turb, vrel, qdyn,
                     aDrag: aDragMag, alt, erosion: erosionFrac } };
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
        // Advance the clock so time-dependent derivatives (turbulence) sample
        // the right phase at each RK4 stage. Preserve the slow-moving state
        // fields too — derivatives reads `tumbleRate` for the drag penalty.
        t:  st.t + h,
        burnSeconds: st.burnSeconds ?? 0,
        tumbleRate:  st.tumbleRate  ?? 0,
        attitudeErr: st.attitudeErr ?? 0,
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
        // Carry through realism extras.
        burnSeconds: s.burnSeconds ?? 0,
        tumbleRate:  s.tumbleRate  ?? 0,
        attitudeErr: s.attitudeErr ?? 0,
    };

    // ── Burn-time accounting (throat erosion clock) ──────────────────────
    // Equivalent full-throttle seconds — half throttle for 2 s ≈ 1 sec of
    // erosion. Only counts when an active burn mode is selected and fuel
    // remained throughout the step. This is the clock deriveDesign+turn
    // erosionFactor against.
    const burning = control?.mode && control.mode !== 'off'
                 && (control.throttle ?? 0) > 0 && out.fuel > 0;
    if (burning) out.burnSeconds += (control.throttle ?? 0) * dt;

    // ── Disturbance torque & tumble ──────────────────────────────────────
    // The atmospheric drag acts at the centre of pressure (offset from the
    // centre of mass by design.copOffset). That creates a torque whose
    // sign flips with the local turbulence direction. Damping = a constant
    // restoring term proportional to body inertia (mocked as a single τ).
    // Result: high-q + long lever arms (telescope, tug-with-tall-payload)
    // makes the bird wander off heading, bloats drag, costs you altitude.
    const d1 = k1.diag;
    if (d1) {
        const cop = design.copOffset ?? 0.05;
        // Torque ∝ aero force × lever × turbulence sign. Inertia proxy:
        // mass × maxSide² (gives reasonable rad/s² magnitudes).
        const inertia = (design.dryMass + Math.max(out.fuel, 0))
                      * Math.max(0.5, (design.maxSide ?? 1)) ** 2;
        const torque = d1.aDrag * (design.dryMass + Math.max(out.fuel, 0)) * cop
                     * (d1.turb - 1) * 0.6;
        // Reaction wheels & control authority gently damp tumble; chemical
        // bus has weaker authority than an actively-pointed payload bus.
        const damp = 0.18;
        out.tumbleRate += (torque / inertia - out.tumbleRate * damp) * dt;
        out.attitudeErr += out.tumbleRate * dt;
        // Hard clamp so the sim doesn't go to spinning-numerically-unstable.
        if (out.tumbleRate >  3) out.tumbleRate =  3;
        if (out.tumbleRate < -3) out.tumbleRate = -3;
    }

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
/** Classical 2-D elements from the state vector. Accepts an optional env
 *  so a non-default gravity slider feeds through to apo/peri/period; if
 *  omitted, defaults to Earth μ. */
export function elements(s, env = null) {
    const mu = effectiveMU(env);
    const r = Math.hypot(s.x, s.y);
    const v2 = s.vx * s.vx + s.vy * s.vy;
    const energy = v2 / 2 - mu / r;            // specific orbital energy
    const a = -mu / (2 * energy);              // semi-major axis (∞ if parabolic)
    const hz = s.x * s.vy - s.y * s.vx;        // specific angular momentum (z)
    const rDotV = s.x * s.vx + s.y * s.vy;
    // Eccentricity vector e = ((v²−μ/r) r − (r·v) v) / μ
    const c = v2 - mu / r;
    const ex = (c * s.x - rDotV * s.vx) / mu;
    const ey = (c * s.y - rDotV * s.vy) / mu;
    const ecc = Math.hypot(ex, ey);
    const bound = energy < 0 && isFinite(a);
    const rp = bound ? a * (1 - ecc) : r;
    const ra = bound ? a * (1 + ecc) : Infinity;
    const period = bound ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : Infinity;
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
export function telemetry(s, design, env, attMult = 1) {
    const el = elements(s, env);
    const mass = design.dryMass + Math.max(s.fuel, 0);
    const d = derivatives(s, design, { ...env }, { throttle: 0, mode: 'off', attitudeMult: attMult });

    // Δv still in the tank (Tsiolkovsky), and the drag-only decay estimate.
    const dvRemaining = s.fuel > 0
        ? design.isp * G0 * Math.log((design.dryMass + s.fuel) / design.dryMass)
        : 0;
    const ballisticCoeff = mass / (design.cd * design.area * (attMult || 1));   // kg/m²

    // Specific-energy loss rate from drag → semi-major-axis decay rate.
    // ε̇ = a_nongrav · v ;  ȧ = (2 a² / μ) ε̇
    const muEff = effectiveMU(env);
    const dragPower = -(d.diag.aDrag) * el.speed;              // ≤ 0 (J/kg/s)
    let aDot = 0, decayPerOrbitKm = 0, daysToReentry = Infinity;
    if (el.bound) {
        aDot = (2 * el.a * el.a / muEff) * dragPower;          // m/s, ≤ 0
        decayPerOrbitKm = (aDot * el.period) / 1000;
        if (aDot < -1e-9) {
            const aReentry = R_EARTH + 100_000;
            daysToReentry = Math.max(0, (el.a - aReentry) / -aDot) / 86_400;
        }
    }

    // Burn-budget pair: what drag is pulling out per orbit (as an equivalent
    // prograde Δv impulse) and what the throttle would supply if held at its
    // current setting through one full period. Identity used:
    //   a_drag · P  =  ∫ a_drag dt  =  Δv_lost_per_orbit
    // The thrust pair uses the eroded thrust + current mass + the burn mode's
    // tangential-component fraction (1.0 prograde, −1.0 retro, ~0 radial).
    const reqDvPerOrbit = (el.bound && Number.isFinite(el.period))
        ? d.diag.aDrag * el.period
        : 0;
    const ispEff    = design.isp    * (1 - 0.25 * (d.diag.erosion ?? 0));
    const thrustEff = design.thrust * (1 - 0.25 * (d.diag.erosion ?? 0));

    return {
        altKm: el.altKm,
        periAltKm: el.periAltKm,
        apoAltKm: el.apoAltKm,
        a: el.a,
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
        // ── Realism extras (new gauges) ──
        turbulence:  d.diag.turb ?? 1,
        rhoMean:     d.diag.rhoMean ?? d.diag.rho,
        erosion:     d.diag.erosion ?? 0,
        burnSeconds: s.burnSeconds ?? 0,
        tumbleRate:  s.tumbleRate ?? 0,
        attitudeErr: s.attitudeErr ?? 0,
        ispEff,
        thrustEff,
        // ── Burn-budget gauge (the new thrust-vs-drag loop) ──
        requiredDvPerOrbit: reqDvPerOrbit,
    };
}

// ── Burn-budget helpers (forecast-aware) ────────────────────────────────────
/**
 * Per-orbit prograde Δv the player must add to *net out drag* at the current
 * state. Derived directly from the energy identity
 *
 *   ε̇_drag = −a_drag · v   →   Δa_drag/orbit = −2 a²/μ · a_drag · v · P
 *   To cancel:  Δa_player = 2 a²·v / μ · Δv_player  ⇒  Δv_player = a_drag · P
 *
 * So `required Δv per orbit  =  a_drag · period`. Clean, cheap, exact within
 * the linearization. Returns 0 for unbound trajectories.
 *
 * @param {object} tel  — telemetry record (must include dragAccel & period)
 */
export function requiredDvPerOrbit(tel) {
    if (!tel || !tel.bound) return 0;
    const aD = +tel.dragAccel, p = +tel.period;
    if (!Number.isFinite(aD) || !Number.isFinite(p) || p <= 0) return 0;
    return aD * p;
}

/**
 * Equivalent prograde Δv per orbit the player *would* deliver if the current
 * throttle + burn-mode were held for one full period. The mode determines how
 * much of the thrust vector is tangential (= contributes to orbit-raising):
 *
 *   prograde / manual            →  +1.0
 *   retrograde / manual-retro    →  −1.0
 *   radial-in / radial-out / off →   0   (no secular Δa contribution)
 *
 * This is the player-side counterpart to requiredDvPerOrbit — the HUD pairs
 * the two as a "supply vs demand" gauge.
 *
 * @param {object} tel
 * @param {object} design
 * @param {object} control   — { throttle, mode }
 */
export function providedDvPerOrbit(tel, design, control) {
    if (!tel || !tel.bound || !control) return 0;
    const thr = +control.throttle;
    if (!Number.isFinite(thr) || thr <= 0) return 0;
    const mode = control.mode || 'off';
    const sign = (mode === 'prograde' || mode === 'manual')          ?  1
              : (mode === 'retrograde' || mode === 'manual-retro')    ? -1
              : 0;
    if (sign === 0) return 0;
    const mass = +tel.mass, p = +tel.period;
    const thrustEff = Number.isFinite(tel.thrustEff) ? tel.thrustEff : design.thrust;
    if (!Number.isFinite(mass) || mass <= 0 || !Number.isFinite(p) || p <= 0) return 0;
    return sign * thr * thrustEff / mass * p;
}

/**
 * Recompute requiredDvPerOrbit at a forecast horizon. Builds a synthetic env
 * with the projected F10.7/Ap, recomputes drag at the *current* altitude,
 * attitude and mass, and returns the resulting per-orbit Δv requirement.
 * Lets the HUD answer "in 6 h, how hard will I have to be burning?" without
 * running the full integrator forward.
 *
 * @param {object} s
 * @param {object} design
 * @param {object} env       — current env (gravityMul preserved)
 * @param {object} control   — current control (attitudeMult honored)
 * @param {object} forecast  — { f107, ap } from satellite-designer-forecast.js
 * @returns {number}  Δv [m/s/orbit] required to hold orbit under the forecast
 */
export function forecastRequiredDvPerOrbit(s, design, env, control, forecast) {
    if (!forecast || !Number.isFinite(forecast.f107) || !Number.isFinite(forecast.ap)) return 0;
    const projEnv = { ...env, f107Sfu: forecast.f107, ap: forecast.ap };
    const tel = telemetry(s, design, projEnv, attitudeMult(control));
    return requiredDvPerOrbit(tel);
}

/**
 * Linearised perigee projection N orbits ahead. Uses the current per-orbit
 * decay rate as a constant secular drift; adds the player's per-orbit
 * tangential Δv contribution via Δa = 2va²·Δv/μ. Eccentricity is assumed
 * conserved (true for small Δv applied near perigee) so perigee shifts by
 * the same Δa as the semi-major axis.
 *
 * Honest within ~5% over 1–30 orbits at LEO altitudes; not a substitute for
 * the integrator. Designed for the STORM RADAR's "where will perigee be
 * in 10 orbits" readout, where order-of-magnitude is what matters.
 *
 * @param {object} tel
 * @param {number} orbits
 * @param {object} [opts]
 * @param {number} [opts.playerDvPerOrbit=0]  m/s; signed (prograde +)
 * @param {object} [opts.env]                  ignored — for symmetry
 * @returns {{
 *   periAltKmAfter:number, deltaPeriKm:number,
 *   orbitsToFloor:number, hoursToFloor:number
 * }}
 *   `orbitsToFloor` is for an 80-km re-entry floor; -Infinity if the orbit
 *   is rising. Callers can scale against any specific mission floor.
 */
export function projectPerigee(tel, orbits, opts = {}) {
    if (!tel || !tel.bound || !Number.isFinite(tel.period)) {
        return { periAltKmAfter: tel?.periAltKm ?? NaN, deltaPeriKm: 0,
                 orbitsToFloor: Infinity, hoursToFloor: Infinity };
    }
    const N = Math.max(0, +orbits || 0);
    const playerDv = Number.isFinite(opts.playerDvPerOrbit) ? opts.playerDvPerOrbit : 0;

    // Δa contributions per orbit, in metres.
    const dragDeltaA_m_per_orbit = (tel.decayPerOrbitKm || 0) * 1000;   // ≤ 0
    // Tangential Δv → Δa via the vis-viva differential. v ≈ tel.speed.
    const playerDeltaA_m_per_orbit = (tel.a && tel.speed)
        ? 2 * tel.speed * tel.a * tel.a * playerDv / MU
        : 0;
    const netDeltaA_m_per_orbit = playerDeltaA_m_per_orbit + dragDeltaA_m_per_orbit;

    const deltaPeriKm = (netDeltaA_m_per_orbit * N) / 1000;
    const periAltKmAfter = tel.periAltKm + deltaPeriKm;

    let orbitsToFloor = Infinity, hoursToFloor = Infinity;
    if (netDeltaA_m_per_orbit < -1e-3) {
        // Solve currentPeri + n · netΔa = 80 km
        const reentryKm = 80;
        const required_n_orbits = (reentryKm - tel.periAltKm) / (netDeltaA_m_per_orbit / 1000);
        if (required_n_orbits > 0) {
            orbitsToFloor = required_n_orbits;
            hoursToFloor = required_n_orbits * tel.period / 3600;
        }
    } else if (netDeltaA_m_per_orbit > 1e-3) {
        orbitsToFloor = -Infinity;    // orbit rising
        hoursToFloor  = -Infinity;
    }

    return { periAltKmAfter, deltaPeriKm, orbitsToFloor, hoursToFloor };
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

    // 8. Space weather: a geomagnetic storm swells the thermosphere, so ρ at
    //    400 km is far higher than at solar minimum, and decay is faster.
    const eMin = SPACE_WEATHER_PRESETS.solar_min;
    const eStorm = SPACE_WEATHER_PRESETS.geo_storm;
    const rhoMin = airDensity(400_000, eMin);
    const rhoStorm = airDensity(400_000, eStorm);
    T(rhoStorm > rhoMin * 3,
        `storm ρ(400 km) ≫ solar-min (${rhoStorm.toExponential(1)} vs ${rhoMin.toExponential(1)})`);
    const sat = makeDesign({ dryMass: 60, fuelMass: 0, area: 3, cd: 2.2 });
    const dMin = advance(initState(sat, { periKm: 320 }), sat, eMin, { throttle: 0, mode: 'off' }, 12 * 3600);
    const dStorm = advance(initState(sat, { periKm: 320 }), sat, eStorm, { throttle: 0, mode: 'off' }, 12 * 3600);
    T(elements(dStorm.state).a < elements(dMin.state).a,
        `storm decays faster than solar-min over 12 h`);

    // 9. Attitude: flying broadside bleeds the orbit faster than feathered.
    const att = makeDesign({ dryMass: 80, fuelMass: 0, area: 3, cd: 2.2 });
    const feath = advance(initState(att, { periKm: 300 }), att, env,
        { throttle: 0, mode: 'off', attitudeMult: ATTITUDE_MODES.feathered.mult }, 12 * 3600);
    const broad = advance(initState(att, { periKm: 300 }), att, env,
        { throttle: 0, mode: 'off', attitudeMult: ATTITUDE_MODES.broadside.mult }, 12 * 3600);
    T(elements(broad.state).a < elements(feath.state).a,
        `broadside decays faster than feathered (a ${(elements(feath.state).a/1000).toFixed(0)} vs ${(elements(broad.state).a/1000).toFixed(0)} km)`);

    // 10. Burn-budget identity: requiredDvPerOrbit + decayPerOrbitKm should
    //     close the loop. Δv_req = a_drag · period, and over one orbit that
    //     translates back to Δa_drag = decayPerOrbitKm · 1000. Verify by
    //     substituting requiredDvPerOrbit into projectPerigee with
    //     playerDvPerOrbit = +Δv_req and confirming perigee holds.
    const bb = makeDesign({ dryMass: 80, fuelMass: 20, area: 3, cd: 2.2 });
    let sbb = initState(bb, { periKm: 320, apoKm: 320 });
    const telBb = telemetry(sbb, bb, env);
    const reqDv = requiredDvPerOrbit(telBb);
    T(reqDv > 0,
        `Δv-req > 0 at 320 km (got ${reqDv.toExponential(2)} m/s/orbit)`);
    const proj0 = projectPerigee(telBb, 10);                              // no thrust → decay
    const projOk = projectPerigee(telBb, 10, { playerDvPerOrbit: reqDv }); // exactly cancels
    T(proj0.periAltKmAfter < telBb.periAltKm,
        `no-thrust projection decays (Δ = ${(proj0.periAltKmAfter - telBb.periAltKm).toFixed(2)} km)`);
    T(Math.abs(projOk.periAltKmAfter - telBb.periAltKm) < 0.05,
        `Δv-req cancels decay (Δ = ${(projOk.periAltKmAfter - telBb.periAltKm).toExponential(2)} km)`);

    // 11. providedDvPerOrbit pairs with mode: prograde + → throttle, retro →
    //     negative, radial → 0.
    const provProg = providedDvPerOrbit(telBb, bb,
        { throttle: 1, mode: 'prograde' });
    const provRetro = providedDvPerOrbit(telBb, bb,
        { throttle: 1, mode: 'retrograde' });
    const provRad = providedDvPerOrbit(telBb, bb,
        { throttle: 1, mode: 'radial-out' });
    T(provProg > 0 && provRetro < 0 && Math.abs(provRad) < 1e-9,
        `providedDv signs: prog +${provProg.toFixed(2)} retro ${provRetro.toFixed(2)} radial ${provRad.toFixed(2)}`);

    return out;
}
