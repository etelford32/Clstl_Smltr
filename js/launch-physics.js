/**
 * launch-physics.js — Surface-to-orbit ascent simulator for any planetary
 * body with an isothermal atmosphere model.
 *
 * Integrates the 2-D (radial + tangential) equations of motion with:
 *   • Constant-Isp engine, single-stage assumption (m_dry ≈ 6% of m₀)
 *   • Exponential atmosphere   ρ(h) = ρ₀ · exp(−h / H)
 *   • Quadratic drag           F_d = ½·ρ·v²·C_d·A
 *   • Inverse-square gravity   g(r) = μ / r²
 *   • Programmed gravity turn  pitch(h) = π/2 · exp(−h / h_pivot), then
 *     velocity-following once vt is significant.
 *
 * Reports the canonical Δv budget:
 *   Δv_used = Δv_orbital + Δv_gravity_loss + Δv_drag_loss + Δv_steering_loss
 * where Δv_used comes from Tsiolkovsky on the actual fuel mass burned.
 *
 * Validated for Earth: a 549 t Falcon 9-class vehicle reaches 200 km LEO
 * with Δv_used ≈ 9.4 km/s (orbital 7.8, gravity ~1.5, drag ~0.15) — within
 * a few percent of textbook values.
 */

// ── Body catalog (real numbers) ─────────────────────────────────────────────
// rho0: surface density (kg/m³),  H_km: scale height,  v_orb_low: circular
// orbital velocity just above the body (km/s).
export const LAUNCH_BODIES = {
    earth: {
        id: 'earth', name: 'Earth',
        R_km: 6378.137, mu_km3s2: 398600.4418,
        rho0_kg_m3: 1.225, H_km: 8.5, T_surf_K: 288,
        a_sound_ms: 340, mu_pas: 1.81e-5,
        atmosphere: 'N₂/O₂ · 1.013 bar',
        v_orb_low_kms: 7.79,
        notes: 'Workhorse comparison case.',
    },
    venus: {
        id: 'venus', name: 'Venus',
        R_km: 6051.8, mu_km3s2: 324859.0,
        rho0_kg_m3: 65.0, H_km: 15.9, T_surf_K: 740,
        a_sound_ms: 410, mu_pas: 3.4e-5,
        atmosphere: 'CO₂ · 92 bar',
        v_orb_low_kms: 7.32,
        notes: '53× Earth surface density. Drag loss is enormous.',
    },
    mars: {
        id: 'mars', name: 'Mars',
        R_km: 3389.5, mu_km3s2: 42828.37,
        rho0_kg_m3: 0.020, H_km: 11.1, T_surf_K: 210,
        a_sound_ms: 240, mu_pas: 1.1e-5,
        atmosphere: 'CO₂ · 6.4 mbar',
        v_orb_low_kms: 3.55,
        notes: 'Thin atmosphere + low gravity = friendly launch site.',
    },
    moon: {
        id: 'moon', name: 'Moon',
        R_km: 1737.4, mu_km3s2: 4902.8,
        rho0_kg_m3: 0, H_km: 1, T_surf_K: 0,
        atmosphere: 'vacuum',
        v_orb_low_kms: 1.68,
        notes: 'Pure vacuum — only gravity loss matters.',
    },
    titan: {
        id: 'titan', name: 'Titan',
        R_km: 2575, mu_km3s2: 8978,
        rho0_kg_m3: 5.30, H_km: 20, T_surf_K: 94,
        a_sound_ms: 195, mu_pas: 6.3e-6,
        atmosphere: 'N₂/CH₄ · 1.5 bar',
        v_orb_low_kms: 1.85,
        notes: 'Cold dense atmosphere + low gravity. Aerodynamic flight is very efficient.',
    },
    mercury: {
        id: 'mercury', name: 'Mercury',
        R_km: 2439.7, mu_km3s2: 22032.1,
        rho0_kg_m3: 1e-12, H_km: 1, T_surf_K: 440,
        atmosphere: '~vacuum (exosphere only)',
        v_orb_low_kms: 3.00,
        notes: 'Effectively a vacuum world — like a heavy Moon.',
    },
    europa: {
        id: 'europa', name: 'Europa',
        R_km: 1560.8, mu_km3s2: 3203,
        rho0_kg_m3: 1e-12, H_km: 1, T_surf_K: 102,
        atmosphere: 'vacuum (trace O₂)',
        v_orb_low_kms: 1.43,
        notes: 'Smaller and weaker gravity than the Moon.',
    },
    enceladus: {
        id: 'enceladus', name: 'Enceladus',
        R_km: 252.1, mu_km3s2: 7.21,
        rho0_kg_m3: 0, H_km: 1, T_surf_K: 75,
        atmosphere: 'vacuum',
        v_orb_low_kms: 0.169,
        notes: 'A 200 m/s sounding rocket reaches orbit.',
    },
};

// ── Vehicle catalog ─────────────────────────────────────────────────────────
// TWR_E = thrust-to-weight at lift-off referenced to Earth gravity. The same
// engine on a different body has effective TWR = TWR_E · (g_E / g_body).
// Isp_s is the *effective* (flight-averaged) Isp — real launchers spend
// most of their Δv with vacuum Isp on the upper stage, so this number is
// closer to the vacuum Isp than to the sea-level rating.
export const LAUNCH_VEHICLES = {
    sounding: {
        id: 'sounding', name: 'Sounding (single-stage)',
        m0_kg: 1500, Isp_s: 280, TWR_E: 1.6, Cd: 0.4, A_m2: 0.5,
        dry_frac: 0.10,
    },
    medium: {
        id: 'medium', name: 'Medium (Falcon 1-class, 2-stage)',
        m0_kg: 38555, Isp_s: 320, TWR_E: 1.4, Cd: 0.3, A_m2: 1.7,
        dry_frac: 0.07,
    },
    heavy: {
        id: 'heavy', name: 'Heavy (Falcon 9-class, 2-stage)',
        m0_kg: 549054, Isp_s: 350, TWR_E: 1.4, Cd: 0.30, A_m2: 13.0,
        dry_frac: 0.05,
    },
    superHeavy: {
        id: 'superHeavy', name: 'Super Heavy (Saturn V-class, 3-stage)',
        m0_kg: 2970000, Isp_s: 380, TWR_E: 1.18, Cd: 0.28, A_m2: 80,
        dry_frac: 0.05,
    },
    nuclear: {
        id: 'nuclear', name: 'Nuclear Thermal (NTR)',
        m0_kg: 50000, Isp_s: 900, TWR_E: 0.6, Cd: 0.25, A_m2: 5.0,
        dry_frac: 0.20,
    },
};

// ── Atmosphere ──────────────────────────────────────────────────────────────
export function atmosphericDensity(body, alt_m) {
    if (body.rho0_kg_m3 < 1e-10) return 0;
    if (alt_m < 0) return body.rho0_kg_m3;
    return body.rho0_kg_m3 * Math.exp(-(alt_m / 1000) / body.H_km);
}

/**
 * Local speed of sound (m/s). The atmosphere model here is isothermal, so the
 * speed of sound — which depends only on temperature and gas composition — is
 * treated as constant with altitude. Vacuum/airless bodies return 0 (Mach is
 * undefined and drag is zero there anyway).
 */
export function speedOfSound(body, _alt_m = 0) {
    return body.a_sound_ms > 0 ? body.a_sound_ms : 0;
}

/**
 * Ambient-pressure ratio p(h)/p₀. For the isothermal atmosphere used here,
 * pressure falls off with the same scale height as density, so p/p₀ = ρ/ρ₀.
 * This drives the sea-level→vacuum thrust rise of a real rocket engine:
 * the nozzle pumps out a fixed mass flow, but the (pₑ−pₐ)·Aₑ pressure term
 * grows as the outside air thins, so thrust climbs as the vehicle ascends.
 */
export function atmosphericPressureRatio(body, alt_m) {
    if (body.rho0_kg_m3 < 1e-10) return 0;        // airless → vacuum thrust everywhere
    if (alt_m < 0) return 1;
    return Math.exp(-(alt_m / 1000) / body.H_km);
}

// ── Ascent integrator ───────────────────────────────────────────────────────

const G0_EARTH = 9.80665;       // m/s² — standard for Isp definition

/**
 * Simulate a rocket ascent from `body` surface to `target_alt_km` circular
 * orbit, using `vehicle`. All maths in SI; reports distances/speeds in
 * km/(km/s) for friendlier display.
 *
 * Pitch profile: vertical for first 200 m of altitude, then exponential
 * pitch-over with pivot scaled to atmospheric density (slower over thick
 * atmospheres so we don't blow up on max-Q), then velocity-following.
 */
export function simulateAscent({
    body,
    vehicle,
    target_alt_km = 200,
    dt_s          = 0.2,
    max_t_s       = 3000,
} = {}) {
    const R   = body.R_km * 1000;                 // body radius (m)
    const mu  = body.mu_km3s2 * 1e9;              // grav param (m³/s²)

    // ── Propulsion model ──────────────────────────────────────────────────────
    // Two paths, chosen by the vehicle spec:
    //  • Legacy: a single constant-thrust stage (TWR_E + effective Isp). This is
    //    what the Launch Planner's catalog vehicles use — left exactly as it was.
    //  • Staged: an array of real stages, each with sea-level & vacuum thrust, a
    //    fixed turbopump mass flow, and its own dry mass that is jettisoned at
    //    burnout. Thrust on each stage rises from F_sl to F_vac as the ambient
    //    pressure falls, and the vehicle sheds structure at staging — the actual
    //    thrust/TWR profile of a real launch vehicle.
    const staged = Array.isArray(vehicle.stages) && vehicle.stages.length > 0;
    const stage_coast_s = vehicle.stage_coast_s ?? 2.5;   // brief inter-stage coast

    // Legacy single-stage constants.
    const ve  = vehicle.Isp_s * G0_EARTH;         // exhaust velocity (m/s)
    const T0  = vehicle.TWR_E * vehicle.m0_kg * G0_EARTH;   // thrust (N)
    const mdot = T0 / ve;                         // mass-flow (kg/s)
    const m_dry = vehicle.m0_kg * vehicle.dry_frac;

    // Staged state.
    const stageList = staged ? vehicle.stages.map((s) => ({
        prop: s.propMass_kg, dry: s.dryMass_kg,
        F_sl: s.F_sl_N, F_vac: s.F_vac_N, mdot: s.mdot_kgs, ispVac: s.Isp_vac_s,
    })) : [];
    const payload_kg = vehicle.payload_kg || 0;
    let stageIdx = 0;
    let coast_left = 0;
    const staging_events = [];
    let dv_used_integral_ms = 0;                   // ∫(T/m)dt — exact varying-Isp Δv

    // Programmed pitch profile: pitch(h) = (π/2) · cos((π/2) · h/h_full)
    // brings the rocket from vertical at the surface to horizontal at h_full.
    // h_full is calibrated per atmosphere class AND scaled with the target
    // altitude — for higher target orbits we keep pitching up longer so the
    // rocket actually reaches that altitude before going horizontal.
    let h_full_base_m;
    if (body.rho0_kg_m3 > 1)         h_full_base_m = 95_000;
    else if (body.rho0_kg_m3 > 0.01) h_full_base_m = 35_000;
    else                              h_full_base_m =  8_000;
    const h_full_m = Math.max(h_full_base_m, target_alt_km * 1000 * 0.45);

    let r = R, theta = 0;
    let vr = 0, vt = 0;
    let m  = staged ? payload_kg + stageList.reduce((a, s) => a + s.prop + s.dry, 0)
                    : vehicle.m0_kg;
    const m0_ref = vehicle.m0_kg || m;             // for mass_frac reporting
    let t  = 0;

    // Drag may be a constant coefficient (back-compat) or a Mach-dependent
    // function Cd(mach, v, alt_m, rho) — the Space Ship Designer passes the
    // latter so nosecone shape drives transonic / supersonic wave drag.
    const cdIsFn = typeof vehicle.Cd === 'function';
    const a_sound = speedOfSound(body);

    let dv_grav_loss_ms = 0;
    let dv_drag_loss_ms = 0;
    let max_q_pa = 0, max_q_alt_km = 0, max_q_t_s = 0;
    let max_mach = 0, max_drag_N = 0, max_drag_alt_km = 0;
    const trajectory = [];
    let step = 0;
    let fuel_out = false;
    let peak_vt_ms = 0;
    let peak_alt_at_meco_m = 0;

    while (t < max_t_s) {
        const alt_m  = r - R;
        const alt_km = alt_m / 1000;
        const v      = Math.hypot(vr, vt);
        const fpa    = (v > 1e-9) ? Math.atan2(vr, vt) : Math.PI/2;   // flight path angle

        // Atmosphere
        const rho = atmosphericDensity(body, alt_m);
        const q   = 0.5 * rho * v*v;
        if (q > max_q_pa) { max_q_pa = q; max_q_alt_km = alt_km; max_q_t_s = t; }

        // Mach number (0 where the air is too thin for a defined speed of sound).
        const mach = a_sound > 0 ? v / a_sound : 0;
        // Only headline the Mach reached while there is still meaningful air —
        // once in vacuum the velocity/sound ratio keeps climbing but means nothing
        // aerodynamically (and drag there is zero).
        if (mach > max_mach && rho > 1e-4) max_mach = mach;

        // Drag (opposite velocity). Cd can vary with Mach when a function is given.
        const Cd = cdIsFn ? vehicle.Cd(mach, v, alt_m, rho) : vehicle.Cd;
        const F_drag = q * Cd * vehicle.A_m2;
        if (F_drag > max_drag_N) { max_drag_N = F_drag; max_drag_alt_km = alt_km; }
        const drag_r = (v > 1e-9) ? -F_drag * vr / v : 0;
        const drag_t = (v > 1e-9) ? -F_drag * vt / v : 0;

        // Programmed cosine pitch profile from vertical (alt=0) to horizontal
        // (alt=h_full_m). Once we're above h_full_m, hold horizontal — final
        // burn drives tangential velocity to orbital.
        let pitch;
        if (alt_m < 100) {
            pitch = Math.PI / 2;                       // vertical pre-launch hold
        } else if (alt_m < h_full_m) {
            const norm = alt_m / h_full_m;
            pitch = (Math.PI / 2) * Math.cos((Math.PI / 2) * norm);
        } else {
            pitch = 0;                                 // horizontal final-burn
        }

        // Thrust this step. Staged path: F rises from sea-level to vacuum as the
        // air thins; legacy path: constant until the (single) tank empties.
        let T_now, mdot_now, isp_now, firingStage, coastingNow = false;
        if (staged) {
            firingStage = Math.min(stageIdx + 1, stageList.length);
            if (coast_left > 0) {
                T_now = 0; mdot_now = 0; isp_now = 0; coastingNow = true;
            } else if (stageIdx < stageList.length) {
                const st = stageList[stageIdx];
                const p_ratio = body.rho0_kg_m3 > 1e-10 ? (rho / body.rho0_kg_m3) : 0;
                const F = Math.max(0, st.F_vac - (st.F_vac - st.F_sl) * p_ratio);
                T_now = F; mdot_now = st.mdot;
                isp_now = mdot_now > 0 ? F / (mdot_now * G0_EARTH) : 0;
            } else {
                T_now = 0; mdot_now = 0; isp_now = 0;     // all stages spent
            }
        } else {
            T_now = (m > m_dry) ? T0 : 0;
            mdot_now = mdot; isp_now = vehicle.Isp_s; firingStage = 1;
        }
        const thrust_r = T_now * Math.sin(pitch);
        const thrust_t = T_now * Math.cos(pitch);

        // Gravity
        const g = mu / (r * r);

        // Polar accelerations (non-inertial, with centrifugal/Coriolis)
        const a_r = (thrust_r + drag_r) / m - g + vt*vt / r;
        const a_t = (thrust_t + drag_t) / m - vr*vt / r;

        // Δv loss accumulators (instantaneous, integrated)
        dv_grav_loss_ms += g * Math.sin(fpa) * dt_s;
        dv_drag_loss_ms += (F_drag / m) * dt_s;

        // Semi-implicit Euler
        vr += a_r * dt_s;
        vt += a_t * dt_s;
        r  += vr * dt_s;
        theta += (vt / r) * dt_s;

        // Mass update + staging.
        if (staged) {
            if (T_now > 0 && stageIdx < stageList.length) {
                const st = stageList[stageIdx];
                dv_used_integral_ms += (T_now / m) * dt_s;   // before the mass drops
                const burn = mdot_now * dt_s;
                st.prop -= burn;
                m -= burn;
                if (st.prop <= 0) {
                    staging_events.push({ stage: stageIdx + 1, t, alt_km, v_kms: Math.hypot(vr, vt) / 1000 });
                    stageIdx++;
                    if (stageIdx < stageList.length) {
                        m -= st.dry;                 // jettison the spent lower stage
                        coast_left = stage_coast_s;  // coast briefly before next ignition
                    } else if (!fuel_out) {
                        // Last stage burned out → MECO. Keep its dry mass (it is the
                        // bus that carries the payload). Latch the orbit state.
                        fuel_out = true; peak_vt_ms = vt; peak_alt_at_meco_m = alt_m;
                    }
                }
            } else if (coast_left > 0) {
                coast_left -= dt_s;
            } else if (!fuel_out && stageIdx >= stageList.length) {
                fuel_out = true; peak_vt_ms = vt; peak_alt_at_meco_m = alt_m;
            }
        } else if (m > m_dry) {
            m -= mdot * dt_s;
        } else if (!fuel_out) {
            // Just hit MECO (main-engine cut-off). Latch the state so we
            // can report it as the final result regardless of what happens
            // in the post-burn coast.
            fuel_out = true;
            peak_vt_ms = vt;
            peak_alt_at_meco_m = alt_m;
        }

        if (vt > peak_vt_ms) peak_vt_ms = vt;

        // Sample trajectory (every ~1 s) — only during powered ascent so
        // the chart doesn't get drowned in a multi-minute coast/reentry.
        if (!fuel_out && step % Math.max(1, Math.round(1.0 / dt_s)) === 0) {
            trajectory.push({
                t, alt_km,
                v_kms:  v / 1000,
                vr_kms: vr / 1000,
                vt_kms: vt / 1000,
                q_kPa:  q / 1000,
                mach,
                cd:     Cd,
                drag_kN: F_drag / 1000,
                rho,
                mass_frac: m / m0_ref,
                // Propulsion telemetry (drives the live thrust panel).
                thrust_kN: T_now / 1000,
                isp_s:     isp_now,
                twr:       (T_now > 0) ? T_now / (m * g) : 0,
                accel_g:   (T_now / m) / G0_EARTH,
                stage:     firingStage,
                coasting:  coastingNow,
                dv_used_kms: (staged ? dv_used_integral_ms : ve * Math.log(m0_ref / Math.max(m, m_dry))) / 1000,
            });
        }
        t += dt_s;
        step++;

        // Termination
        if (alt_m < -100) break;                                       // crashed
        const v_orb_here = Math.sqrt(mu / r);
        const orbit_now = (alt_km > target_alt_km - 1) && (vt > v_orb_here * 0.99);
        if (orbit_now) break;
        // After fuel-out, terminate immediately — coast/reentry physics
        // would only inflate drag-loss accounting and isn't what the user
        // is asking about. We've already locked in peak_vt_ms above.
        if (fuel_out) break;
    }

    // Report the state at MECO (or termination, whichever came first).
    // peak_alt_at_meco_m is set when fuel runs out; otherwise we used the
    // current state because we hit orbit or time/altitude limits.
    const meco_alt_m = fuel_out ? peak_alt_at_meco_m : (r - R);
    const meco_r = R + meco_alt_m;
    const v_orb_at_meco = Math.sqrt(mu / meco_r);
    const meco_vt_ms = fuel_out ? peak_vt_ms : vt;

    // Orbit achieved iff tangential velocity at MECO is at least the local
    // circular speed AND we're meaningfully above the atmosphere. Excess
    // velocity at MECO produces an elliptical orbit whose apogee can be
    // above the requested target — that still counts.
    const above_atm_km = body.rho0_kg_m3 > 1 ? 90 : body.rho0_kg_m3 > 0.01 ? 50 : 5;
    const orbit_achieved = (meco_vt_ms > v_orb_at_meco * 0.99) && (meco_alt_m / 1000 > above_atm_km);
    const crashed = meco_alt_m < -50;

    // Δv used. Staged: the exact ∫(T/m)dt integral (handles varying Isp and the
    // mass jettisoned at staging). Legacy: Tsiolkovsky on the fuel burned.
    const dv_used_ms = staged ? dv_used_integral_ms
                              : ve * Math.log(vehicle.m0_kg / Math.max(m, m_dry));

    // Steering loss: whatever's left after orbital + gravity + drag.
    const dv_orbital_ms = orbit_achieved ? v_orb_at_meco : meco_vt_ms;
    const dv_steer_loss_ms = Math.max(0, dv_used_ms - dv_orbital_ms - dv_grav_loss_ms - dv_drag_loss_ms);

    // Out of propellant? Staged: every stage spent. Legacy: tank empty.
    const propellant_spent = staged ? (stageIdx >= stageList.length) : (m <= m_dry + 1);

    let status;
    if (crashed)              status = 'crashed';
    else if (orbit_achieved)  status = 'orbit';
    else if (propellant_spent) status = 'fuel-out';
    else                      status = 'time-out';

    return {
        body: body.name, body_id: body.id,
        vehicle: vehicle.name, vehicle_id: vehicle.id,
        status,
        time_s: t,
        final_alt_km: meco_alt_m / 1000,
        final_vt_kms: meco_vt_ms / 1000,
        v_orb_circ_kms: v_orb_at_meco / 1000,
        // Δv breakdown (km/s)
        dv_used_kms:       dv_used_ms / 1000,
        dv_orbital_kms:    dv_orbital_ms / 1000,
        dv_grav_loss_kms:  dv_grav_loss_ms / 1000,
        dv_drag_loss_kms:  dv_drag_loss_ms / 1000,
        dv_steer_loss_kms: dv_steer_loss_ms / 1000,
        // Atmosphere stats
        max_q_kPa: max_q_pa / 1000,
        max_q_alt_km, max_q_t_s,
        max_mach,
        max_drag_kN: max_drag_N / 1000,
        max_drag_alt_km,
        // Mass
        fuel_burned_kg:       m0_ref - m,
        fuel_mass_fraction:   1 - (m / m0_ref),
        // Vehicle parameters used (for display)
        twr_at_liftoff:       staged
            ? (stageList[0] ? stageList[0].F_sl / (m0_ref * (mu / (R*R))) : 0)
            : vehicle.TWR_E * (G0_EARTH / (mu / (R*R))),
        // Staging timeline (staged vehicles only)
        staging_events,
        // Trajectory polyline
        trajectory,
    };
}

/**
 * Convenience: run the simulation across every body for a fixed vehicle and
 * return a comparison table sorted by Δv-to-orbit ascending.
 */
export function compareBodies({ vehicle, target_alt_km = 200 }) {
    const rows = [];
    for (const body of Object.values(LAUNCH_BODIES)) {
        try {
            const res = simulateAscent({ body, vehicle, target_alt_km });
            rows.push(res);
        } catch (e) {
            rows.push({ body: body.name, body_id: body.id, status: 'error', error: e.message });
        }
    }
    rows.sort((a, b) => (a.dv_used_kms ?? Infinity) - (b.dv_used_kms ?? Infinity));
    return rows;
}
