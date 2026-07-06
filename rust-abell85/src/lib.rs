//! abell85_nbody — the O(N) inner loops of the Black Hole Observatory's star
//! cluster, ported 1:1 from js/abell85/nbody.js so the JS and WASM paths are
//! algorithmically identical (float32 storage, float64 arithmetic, same
//! operation order; parity is asserted in tests/abell85-physics.mjs).
//!
//! Units: pc, km/s, Msun, Myr (see js/abell85/units.js).
//! Star flags: 0 bound · 1 ejected · 2 frozen ejecta · 3 loss-cone.

const G: f64 = 4.30091e-3; // pc (km/s)^2 / Msun
const KMS_MYR: f64 = 1.022712; // pc per (km/s * Myr)
const SOFT2: f64 = 1.0; // pc^2 Plummer softening^2 (BH-star)
const R_FREEZE: f64 = 30000.0; // pc: ejected stars past this just drift
const R_EJECT_FLAG: f64 = 3.0; // x r_infl before an unbound star counts as ejected

/// Bump allocator for caller-owned buffers (never freed — lanes live for the
/// worker's lifetime; reconfigure reuses the same allocations).
#[no_mangle]
pub extern "C" fn alloc(bytes: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(bytes);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

#[inline]
fn dehnen_menc(m_star: f64, a_scale: f64, gamma: f64, r: f64) -> f64 {
    let rr = if r > 0.0 { r } else { 0.0 };
    m_star * (rr / (rr + a_scale)).powf(3.0 - gamma)
}

#[inline]
fn dehnen_phi(m_star: f64, a_scale: f64, gamma: f64, r: f64) -> f64 {
    let rr = r.max(1e-6);
    let x = rr / (rr + a_scale);
    -(G * m_star / a_scale) * (1.0 / (2.0 - gamma)) * (1.0 - x.powf(2.0 - gamma))
}

/// One frame of cluster time: per-star adaptively substepped KDK leapfrog
/// identical to StarCluster.step/_kdkStar in js/abell85/nbody.js. Full
/// 0.05 Myr resolution goes only to stars near the holes / the cusp (tiers
/// scale with r_infl, chosen from frame-start geometry); the outer majority
/// take one step per frame. The float32 store/reload sequence and the tier
/// rule mirror the JS engine EXACTLY — the two must stay bit-identical
/// (asserted in tests/abell85-physics.mjs). Change one, change both.
/// Returns the number of NEWLY ejected stars.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn step_cluster(
    pos: *mut f32, vel: *mut f32, flags: *mut u8, n: usize,
    dt_myr: f64,
    b1x: f64, b1y: f64, b1z: f64, m1: f64,
    b2x: f64, b2y: f64, b2z: f64, m2: f64,
    m_star: f64, a_scale: f64, gamma: f64, r_infl: f64,
) -> u32 {
    let pos = unsafe { core::slice::from_raw_parts_mut(pos, n * 3) };
    let vel = unsafe { core::slice::from_raw_parts_mut(vel, n * 3) };
    let flags = unsafe { core::slice::from_raw_parts_mut(flags, n) };

    let n_full = ((dt_myr / 0.05).ceil() as i64).clamp(1, 12) as usize;
    let n_mid = (n_full + 1) / 2; // == JS Math.ceil(nFull / 2)
    let r_fast2 = (0.15 * r_infl) * (0.15 * r_infl);
    let r_mid2 = (0.5 * r_infl) * (0.5 * r_infl);
    let gamma = gamma.clamp(0.0, 1.99);
    let mut newly_ejected: u32 = 0;

    let accel = |x: f64, y: f64, z: f64| -> (f64, f64, f64) {
        let r = (x * x + y * y + z * z).sqrt().max(1e-6);
        let a_h = -G * dehnen_menc(m_star, a_scale, gamma, r) / (r * r) * KMS_MYR;
        let mut ax = a_h * x / r;
        let mut ay = a_h * y / r;
        let mut az = a_h * z / r;
        for (bx, by, bz, m) in [(b1x, b1y, b1z, m1), (b2x, b2y, b2z, m2)] {
            if m == 0.0 { continue; }
            let dx = bx - x; let dy = by - y; let dz = bz - z;
            let d2 = dx * dx + dy * dy + dz * dz + SOFT2;
            let inv = 1.0 / d2.sqrt();
            let a_b = G * m * inv * inv * inv * KMS_MYR;
            ax += a_b * dx; ay += a_b * dy; az += a_b * dz;
        }
        (ax, ay, az)
    };

    for i in 0..n {
        let j = i * 3;
        if flags[i] == 2 {
            // frozen ejecta: one pure drift for the whole frame
            pos[j] = (pos[j] as f64 + vel[j] as f64 * dt_myr * KMS_MYR) as f32;
            pos[j + 1] = (pos[j + 1] as f64 + vel[j + 1] as f64 * dt_myr * KMS_MYR) as f32;
            pos[j + 2] = (pos[j + 2] as f64 + vel[j + 2] as f64 * dt_myr * KMS_MYR) as f32;
            continue;
        }
        // substep tier from frame-start geometry (origin cusp + each hole)
        let (x0, y0, z0) = (pos[j] as f64, pos[j + 1] as f64, pos[j + 2] as f64);
        let mut d2 = x0 * x0 + y0 * y0 + z0 * z0;
        if m1 != 0.0 {
            let dx = b1x - x0; let dy = b1y - y0; let dz = b1z - z0;
            d2 = d2.min(dx * dx + dy * dy + dz * dz);
        }
        if m2 != 0.0 {
            let dx = b2x - x0; let dy = b2y - y0; let dz = b2z - z0;
            d2 = d2.min(dx * dx + dy * dy + dz * dz);
        }
        let n_sub = if d2 < r_fast2 { n_full } else if d2 < r_mid2 { n_mid } else { 1 };
        let h = dt_myr / n_sub as f64;

        for _s in 0..n_sub {
            // kick–drift–kick — the float32 store/reload sequence mirrors
            // js/abell85/nbody.js EXACTLY (JS typed-array writes round to f32
            // after each mutation; matching the rounding points is what makes
            // the engines track each other in the smooth regime).
            let (ax, ay, az) = accel(pos[j] as f64, pos[j + 1] as f64, pos[j + 2] as f64);
            vel[j] = (vel[j] as f64 + 0.5 * h * ax) as f32;
            vel[j + 1] = (vel[j + 1] as f64 + 0.5 * h * ay) as f32;
            vel[j + 2] = (vel[j + 2] as f64 + 0.5 * h * az) as f32;
            pos[j] = (pos[j] as f64 + vel[j] as f64 * h * KMS_MYR) as f32;
            pos[j + 1] = (pos[j + 1] as f64 + vel[j + 1] as f64 * h * KMS_MYR) as f32;
            pos[j + 2] = (pos[j + 2] as f64 + vel[j + 2] as f64 * h * KMS_MYR) as f32;
            let (ax2, ay2, az2) = accel(pos[j] as f64, pos[j + 1] as f64, pos[j + 2] as f64);
            vel[j] = (vel[j] as f64 + 0.5 * h * ax2) as f32;
            vel[j + 1] = (vel[j + 1] as f64 + 0.5 * h * ay2) as f32;
            vel[j + 2] = (vel[j + 2] as f64 + 0.5 * h * az2) as f32;

            // ejection bookkeeping (flags 0 and 3 are both "bound")
            let (px, py, pz) = (pos[j] as f64, pos[j + 1] as f64, pos[j + 2] as f64);
            let (vx, vy, vz) = (vel[j] as f64, vel[j + 1] as f64, vel[j + 2] as f64);
            if flags[i] == 0 || flags[i] == 3 {
                let r = (px * px + py * py + pz * pz).sqrt();
                if r > R_EJECT_FLAG * r_infl {
                    let v2 = vx * vx + vy * vy + vz * vz;
                    let e_spec = 0.5 * v2 + dehnen_phi(m_star, a_scale, gamma, r)
                        - G * (m1 + m2) / r;
                    if e_spec > 0.0 {
                        flags[i] = 1;
                        newly_ejected += 1;
                    }
                }
            } else if flags[i] == 1 {
                let r2 = px * px + py * py + pz * pz;
                if r2 > R_FREEZE * R_FREEZE {
                    flags[i] = 2;
                    break;
                }
            }
        }
    }
    newly_ejected
}

/// Loss-cone classification: bound stars with L < L_lc = sqrt(2 G m_bin a_bin)
/// are flagged 3 (bound stars outside go back to 0). m_bin <= 0 clears.
/// Returns the in-cone count.
#[no_mangle]
pub extern "C" fn classify(
    pos: *const f32, vel: *const f32, flags: *mut u8, n: usize,
    m_bin: f64, a_bin: f64,
) -> u32 {
    let pos = unsafe { core::slice::from_raw_parts(pos, n * 3) };
    let vel = unsafe { core::slice::from_raw_parts(vel, n * 3) };
    let flags = unsafe { core::slice::from_raw_parts_mut(flags, n) };

    if !(m_bin > 0.0) || !(a_bin > 0.0) {
        for f in flags.iter_mut() {
            if *f == 3 { *f = 0; }
        }
        return 0;
    }
    let l_lc = (2.0 * G * m_bin * a_bin).sqrt();
    let mut n_cone: u32 = 0;
    for i in 0..n {
        if flags[i] == 1 || flags[i] == 2 { continue; }
        let j = i * 3;
        let (x, y, z) = (pos[j] as f64, pos[j + 1] as f64, pos[j + 2] as f64);
        let (vx, vy, vz) = (vel[j] as f64, vel[j + 1] as f64, vel[j + 2] as f64);
        let lx = y * vz - z * vy;
        let ly = z * vx - x * vz;
        let lz = x * vy - y * vx;
        let l = (lx * lx + ly * ly + lz * lz).sqrt();
        if l < l_lc {
            flags[i] = 3;
            n_cone += 1;
        } else {
            flags[i] = 0;
        }
    }
    n_cone
}
