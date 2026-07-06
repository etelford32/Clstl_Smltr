//! storm_drag — the O(N) inner loops of the Storm Observatory's orbital
//! population, ported 1:1 from js/storm/orbits.js. The decay state (a, e,
//! flags, tReentry) must stay BIT-EXACT with the JS engine — parity is
//! asserted in tests/storm-physics.mjs. The discipline (from the black-hole
//! observatory kernel): the hot path is pure +,−,×,÷,√ in f64; the two
//! transcendental sources are quarantined — pow10 output is f32-quantized
//! (mirroring DensityGrid.sample's Math.fround) and cos i / sin i arrive
//! PRE-COMPUTED per object (f32-quantized at init by initStateInto).
//! Change one engine, change both.
//!
//! Units: km, m²/kg, hours, kg/m³ (see js/storm/units.js).
//! Flags: 0 nominal · 1 decaying · 2 reentered · 3 high-drag.

const MU_EARTH: f64 = 3.986004418e14; // m³/s²
const R_EARTH_KM: f64 = 6378.137;
const J2: f64 = 1.08262668e-3;
const TAU: f64 = core::f64::consts::TAU;
const H_REENTRY_KM: f64 = 135.0;
const H_DECAY_KM: f64 = 180.0;

/// Bump allocator for caller-owned buffers (never freed — swarms live for
/// the worker's lifetime; a population change restarts the worker).
#[no_mangle]
pub extern "C" fn alloc(bytes: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(bytes);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

/// DensityGrid._logAt — bilinear in (t, alt) on log10 ρ, extrapolating on
/// the local slope beyond the altitude table, clamped in t. Same ops, same
/// order as js/storm/bundle.js.
#[inline]
fn log_at(grid: &[f64], alt_km: &[f64], n_t: usize, n_a: usize,
          step_hours: f64, h_km: f64, t_hours: f64) -> f64 {
    let ft = (t_hours / step_hours).max(0.0).min((n_t - 1) as f64);
    let i0 = ft.floor() as usize;
    let i1 = (i0 + 1).min(n_t - 1);
    let wt = ft - i0 as f64;

    let mut j = 0usize;
    while j < n_a - 2 && alt_km[j + 1] < h_km { j += 1; }
    let a0 = alt_km[j];
    let a1 = alt_km[j + 1];
    let fa = (h_km - a0) / (a1 - a0);

    let r0 = grid[i0 * n_a + j] + (grid[i0 * n_a + j + 1] - grid[i0 * n_a + j]) * fa;
    let r1 = grid[i1 * n_a + j] + (grid[i1 * n_a + j + 1] - grid[i1 * n_a + j]) * fa;
    r0 * (1.0 - wt) + r1 * wt
}

/// DensityGrid.sample — pow10 f32-quantized (the parity quarantine).
#[inline]
fn grid_sample(grid: &[f64], alt_km: &[f64], n_t: usize, n_a: usize,
               step_hours: f64, h_km: f64, t_hours: f64) -> f64 {
    let l = log_at(grid, alt_km, n_t, n_a, step_hours, h_km.max(80.0), t_hours);
    (10f64.powf(l) as f32) as f64
}

/// SatSwarm.step — one frame of storm time for the whole population.
/// Returns the number of NEWLY reentered objects.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn step_swarm(
    a: *mut f64, e: *mut f64, cos_i: *const f64,
    raan: *mut f64, argp: *mut f64, m: *mut f64,
    bc: *const f64, raise: *const f64,
    flags: *mut u8, t_reentry: *mut f32, n: usize,
    grid: *const f64, alt_km: *const f64, n_t: usize, n_a: usize,
    step_hours: f64, t_hours: f64, dt_hours: f64,
) -> u32 {
    let a = unsafe { core::slice::from_raw_parts_mut(a, n) };
    let e = unsafe { core::slice::from_raw_parts_mut(e, n) };
    let cos_i = unsafe { core::slice::from_raw_parts(cos_i, n) };
    let raan = unsafe { core::slice::from_raw_parts_mut(raan, n) };
    let argp = unsafe { core::slice::from_raw_parts_mut(argp, n) };
    let m = unsafe { core::slice::from_raw_parts_mut(m, n) };
    let bc = unsafe { core::slice::from_raw_parts(bc, n) };
    let raise = unsafe { core::slice::from_raw_parts(raise, n) };
    let flags = unsafe { core::slice::from_raw_parts_mut(flags, n) };
    let t_reentry = unsafe { core::slice::from_raw_parts_mut(t_reentry, n) };
    let grid = unsafe { core::slice::from_raw_parts(grid, n_t * n_a) };
    let alt_km = unsafe { core::slice::from_raw_parts(alt_km, n_a) };

    let n_full = ((dt_hours / 0.25).ceil() as i64).clamp(1, 8) as usize;
    let n_mid = (n_full + 1) / 2; // == JS Math.ceil(nFull / 2)
    let mut newly: u32 = 0;

    for i in 0..n {
        if flags[i] == 2 { continue; }                       // reentered
        let mut hp = a[i] * (1.0 - e[i]) - R_EARTH_KM;
        let n_sub = if hp < 250.0 { n_full } else if hp < 400.0 { n_mid } else { 1 };
        let h = dt_hours / n_sub as f64;
        for s in 0..n_sub {
            hp = a[i] * (1.0 - e[i]) - R_EARTH_KM;
            if hp < H_REENTRY_KM {
                flags[i] = 2;
                t_reentry[i] = (t_hours + s as f64 * h) as f32;
                newly += 1;
                break;
            }
            let rho = grid_sample(grid, alt_km, n_t, n_a, step_hours,
                hp, t_hours + s as f64 * h);
            let a_m = a[i] * 1e3;
            let mut d_a = -(MU_EARTH * a_m).sqrt() * rho * bc[i] * (h * 3600.0) / 1e3; // km
            if raise[i] > 0.0 {
                let dv = raise[i] * (h / 24.0);                        // m/s this substep
                d_a += 2.0 * dv / (MU_EARTH / a_m).sqrt() * a[i];      // km
            }
            if e[i] > 0.005 {
                // apogee-first decay: perigee holds, apogee absorbs 2×dA
                let rp = a[i] * (1.0 - e[i]);
                let mut ra = a[i] * (1.0 + e[i]) + 2.0 * d_a;
                if ra < rp { ra = rp; }
                a[i] = (ra + rp) / 2.0;
                e[i] = (ra - rp) / (ra + rp);
            } else {
                a[i] += d_a;
                e[i] = (e[i] * (1.0 + d_a / a[i] * 5.0)).max(0.0);     // gentle circularization
            }
            if a[i] * (1.0 - e[i]) - R_EARTH_KM < H_DECAY_KM && flags[i] == 0 {
                flags[i] = 1;
            }
        }
        if flags[i] == 2 { continue; }
        // J2 secular rates over the full frame (cos i cached f32-quantized —
        // pure arithmetic + sqrt from here, hence bit-exact)
        let dt_sec = dt_hours * 3600.0;
        let am = a[i] * 1e3;
        let n_mean = (MU_EARTH / (am * am * am)).sqrt();               // rad/s
        let p = a[i] * (1.0 - e[i] * e[i]);
        let f = R_EARTH_KM / p;
        raan[i] = (raan[i] + (-1.5 * n_mean * J2 * f * f * cos_i[i]) * dt_sec) % TAU;
        argp[i] = (argp[i] + (0.75 * n_mean * J2 * f * f * (5.0 * cos_i[i] * cos_i[i] - 1.0)) * dt_sec) % TAU;
        m[i] = (m[i] + n_mean * dt_sec) % TAU;
    }
    newly
}

/// SatSwarm.classify — high-drag flagging by perigee dynamic pressure.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn classify_swarm(
    a: *const f64, e: *const f64, flags: *mut u8, n: usize,
    grid: *const f64, alt_km: *const f64, n_t: usize, n_a: usize,
    step_hours: f64, t_hours: f64, q_threshold_pa: f64,
) -> u32 {
    let a = unsafe { core::slice::from_raw_parts(a, n) };
    let e = unsafe { core::slice::from_raw_parts(e, n) };
    let flags = unsafe { core::slice::from_raw_parts_mut(flags, n) };
    let grid = unsafe { core::slice::from_raw_parts(grid, n_t * n_a) };
    let alt_km = unsafe { core::slice::from_raw_parts(alt_km, n_a) };

    let mut n_high: u32 = 0;
    for i in 0..n {
        if flags[i] == 1 || flags[i] == 2 { continue; }
        let rp = a[i] * (1.0 - e[i]);
        let rho = grid_sample(grid, alt_km, n_t, n_a, step_hours,
            rp - R_EARTH_KM, t_hours);
        let v = (MU_EARTH * (2.0 / (rp * 1e3) - 1.0 / (a[i] * 1e3))).sqrt();
        if 0.5 * rho * v * v > q_threshold_pa {
            flags[i] = 3;
            n_high += 1;
        } else {
            flags[i] = 0;
        }
    }
    n_high
}

/// SatSwarm.positionsInto — Kepler solve + perifocal rotation, f32 output
/// (which absorbs last-ULP sin/cos differences between the engines).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn positions_into(
    a: *const f64, e: *const f64, cos_i: *const f64, sin_i: *const f64,
    raan: *const f64, argp: *const f64, m: *const f64, flags: *const u8,
    n: usize, out: *mut f32,
) {
    let a = unsafe { core::slice::from_raw_parts(a, n) };
    let e = unsafe { core::slice::from_raw_parts(e, n) };
    let cos_i = unsafe { core::slice::from_raw_parts(cos_i, n) };
    let sin_i = unsafe { core::slice::from_raw_parts(sin_i, n) };
    let raan = unsafe { core::slice::from_raw_parts(raan, n) };
    let argp = unsafe { core::slice::from_raw_parts(argp, n) };
    let m = unsafe { core::slice::from_raw_parts(m, n) };
    let flags = unsafe { core::slice::from_raw_parts(flags, n) };
    let out = unsafe { core::slice::from_raw_parts_mut(out, n * 3) };

    for i in 0..n {
        let j = i * 3;
        if flags[i] == 2 {
            out[j] = 0.0; out[j + 1] = 0.0; out[j + 2] = 0.0;
            continue;
        }
        // keplerE: Newton, 6 iterations (mirrors js/storm/units.js)
        let mut ec = if e[i] < 0.8 { m[i] } else { core::f64::consts::PI };
        for _ in 0..6 {
            ec -= (ec - e[i] * ec.sin() - m[i]) / (1.0 - e[i] * ec.cos());
        }
        let (c_e, s_e) = (ec.cos(), ec.sin());
        let x_p = a[i] * (c_e - e[i]);
        let y_p = a[i] * (1.0 - e[i] * e[i]).sqrt() * s_e;
        let (c_o, s_o) = (raan[i].cos(), raan[i].sin());
        let (c_w, s_w) = (argp[i].cos(), argp[i].sin());
        let x1 = c_w * x_p - s_w * y_p;
        let y1 = s_w * x_p + c_w * y_p;
        out[j] = (c_o * x1 - s_o * cos_i[i] * y1) as f32;
        out[j + 1] = (s_o * x1 + c_o * cos_i[i] * y1) as f32;
        out[j + 2] = (sin_i[i] * y1) as f32;
    }
}
