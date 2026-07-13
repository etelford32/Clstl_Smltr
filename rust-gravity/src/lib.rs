//! gravity-kernel — the Gravity Lab's WASM physics core (P3.1/P3.2).
//!
//! Design contract:
//!   * This kernel MIRRORS js/gravity-lab/physics.js — same Yoshida-4
//!     coefficients, same pairwise loop order, same J2 and Plummer-
//!     softening formulas. The JS harness (test/run.mjs) is the parity
//!     gate: after 1e4 steps both implementations must agree to 1e-12
//!     relative. Change the physics in BOTH places or not at all.
//!   * No wasm-bindgen, no allocator: plain `extern "C"` exports over
//!     static buffers, loaded by js/gravity-lab/wasm/kernel.js. This keeps
//!     the artifact tiny, the toolchain dependency-free (cargo + the
//!     wasm32-unknown-unknown target only), and Node able to load the same
//!     module for tests.
//!
//! Memory layout (f64 unless noted):
//!   bodies:    [m, x, y, z, vx, vy, vz] × MAX_BODIES
//!   particles: [x, y, z, vx, vy, vz]     × MAX_PARTICLES   (massless)
//!   orbits:    [a_m, e]                  × MAX_PARTICLES   (scratch output)
//!
//! Massless test particles feel gravity from every massive body, exert
//! none, and ignore each other → O(N_particles × N_bodies) per kick. They
//! advance by KDK leapfrog in the time-varying field of the bodies: kick
//! with the field at t, drift, kick with the field at t+dt — 2nd order,
//! symplectic in the extended sense appropriate for a driven system.

const MAX_BODIES: usize = 64;
const MAX_PARTICLES: usize = 65536;

const G_SI: f64 = 6.674_30e-11; // CODATA 2018 — matches physics.js

// Math.cbrt(2) as JavaScript computes it, to the exact bit pattern (the
// 17-digit literal round-trips). Rust's f64::cbrt may differ by 1 ulp,
// which compounds past the 1e-12 parity gate over 1e4 steps. sqrt needs
// no such care: both sides lower to IEEE-754 correctly-rounded sqrt.
const CBRT2: f64 = 1.2599210498948732;

static mut BODIES: [f64; MAX_BODIES * 7] = [0.0; MAX_BODIES * 7];
static mut ACC: [f64; MAX_BODIES * 3] = [0.0; MAX_BODIES * 3];
static mut OLD_POS: [f64; MAX_BODIES * 3] = [0.0; MAX_BODIES * 3];
static mut PARTICLES: [f64; MAX_PARTICLES * 6] = [0.0; MAX_PARTICLES * 6];
static mut ORBITS: [f64; MAX_PARTICLES * 2] = [0.0; MAX_PARTICLES * 2];

// ── Buffer access ────────────────────────────────────────────────────────────

#[no_mangle]
pub extern "C" fn bodies_ptr() -> *mut f64 {
    core::ptr::addr_of_mut!(BODIES) as *mut f64
}

#[no_mangle]
pub extern "C" fn particles_ptr() -> *mut f64 {
    core::ptr::addr_of_mut!(PARTICLES) as *mut f64
}

#[no_mangle]
pub extern "C" fn orbits_ptr() -> *mut f64 {
    core::ptr::addr_of_mut!(ORBITS) as *mut f64
}

#[no_mangle]
pub extern "C" fn max_bodies() -> u32 {
    MAX_BODIES as u32
}

#[no_mangle]
pub extern "C" fn max_particles() -> u32 {
    MAX_PARTICLES as u32
}

// ── Pairwise gravity (mirror of physics.js `_accelerations`) ────────────────

/// j2_center < 0 disables the oblateness term.
#[allow(clippy::too_many_arguments)]
unsafe fn accelerations(
    n: usize,
    soft2: f64,
    j2_center: i32,
    j2: f64,
    j2_req: f64,
    j2_mu: f64,
) {
    let b = &*core::ptr::addr_of!(BODIES);
    let acc = &mut *core::ptr::addr_of_mut!(ACC);
    acc[..n * 3].fill(0.0);

    for i in 0..n {
        let bi = i * 7;
        for j in (i + 1)..n {
            let bj = j * 7;
            let dx = b[bj + 1] - b[bi + 1];
            let dy = b[bj + 2] - b[bi + 2];
            let dz = b[bj + 3] - b[bi + 3];
            let r2 = dx * dx + dy * dy + dz * dz + soft2;
            let r = r2.sqrt();
            let inv_r3 = 1.0 / (r2 * r);
            let gi = G_SI * inv_r3;
            let aij = gi * b[bj]; // m_j
            let aji = gi * b[bi]; // m_i
            acc[i * 3] += aij * dx;
            acc[i * 3 + 1] += aij * dy;
            acc[i * 3 + 2] += aij * dz;
            acc[j * 3] -= aji * dx;
            acc[j * 3 + 1] -= aji * dy;
            acc[j * 3 + 2] -= aji * dz;
        }
    }

    if j2_center >= 0 {
        let c = j2_center as usize;
        let bc = c * 7;
        let m_c = b[bc];
        for i in 0..n {
            if i == c {
                continue;
            }
            let bi = i * 7;
            let dx = b[bi + 1] - b[bc + 1];
            let dy = b[bi + 2] - b[bc + 2];
            let dz = b[bi + 3] - b[bc + 3];
            let r2 = dx * dx + dy * dy + dz * dz;
            let r = r2.sqrt();
            let r5 = r2 * r2 * r;
            let zr = dz / r;
            let k = -1.5 * j2 * j2_mu * j2_req * j2_req / r5;
            let kx = k * (1.0 - 5.0 * zr * zr);
            let kz = k * (3.0 - 5.0 * zr * zr);
            acc[i * 3] += kx * dx;
            acc[i * 3 + 1] += kx * dy;
            acc[i * 3 + 2] += kz * dz;
            let wt = b[bi] / m_c;
            acc[c * 3] -= kx * dx * wt;
            acc[c * 3 + 1] -= kx * dy * wt;
            acc[c * 3 + 2] -= kz * dz * wt;
        }
    }
}

unsafe fn drift(n: usize, dt: f64) {
    let b = &mut *core::ptr::addr_of_mut!(BODIES);
    for i in 0..n {
        let o = i * 7;
        b[o + 1] += b[o + 4] * dt;
        b[o + 2] += b[o + 5] * dt;
        b[o + 3] += b[o + 6] * dt;
    }
}

unsafe fn kick(n: usize, dt: f64, soft2: f64, j2_center: i32, j2: f64, j2_req: f64, j2_mu: f64) {
    accelerations(n, soft2, j2_center, j2, j2_req, j2_mu);
    let b = &mut *core::ptr::addr_of_mut!(BODIES);
    let acc = &*core::ptr::addr_of!(ACC);
    for i in 0..n {
        let o = i * 7;
        b[o + 4] += acc[i * 3] * dt;
        b[o + 5] += acc[i * 3 + 1] * dt;
        b[o + 6] += acc[i * 3 + 2] * dt;
    }
}

// ── Yoshida-4 (identical coefficients to physics.js) ─────────────────────────

#[inline]
fn yoshida_coefs() -> ([f64; 4], [f64; 3]) {
    let w1 = 1.0 / (2.0 - CBRT2);
    let w0 = -CBRT2 * w1;
    ([w1 / 2.0, (w0 + w1) / 2.0, (w0 + w1) / 2.0, w1 / 2.0], [w1, w0, w1])
}

/// Advance n massive bodies by `steps` Yoshida-4 steps of size dt, and
/// (when n_particles > 0) advance the massless particles alongside by
/// KDK leapfrog in the bodies' time-varying field.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn step_system(
    n_bodies: u32,
    n_particles: u32,
    steps: u32,
    dt: f64,
    soft2: f64,
    j2_center: i32,
    j2: f64,
    j2_req: f64,
    j2_mu: f64,
) {
    let n = (n_bodies as usize).min(MAX_BODIES);
    let np = (n_particles as usize).min(MAX_PARTICLES);
    let (c, d) = yoshida_coefs();
    unsafe {
        for _ in 0..steps {
            if np > 0 {
                save_positions_internal(n);
                particles_kick(np, n, dt * 0.5, soft2, false);
            }
            drift(n, c[0] * dt);
            kick(n, d[0] * dt, soft2, j2_center, j2, j2_req, j2_mu);
            drift(n, c[1] * dt);
            kick(n, d[1] * dt, soft2, j2_center, j2, j2_req, j2_mu);
            drift(n, c[2] * dt);
            kick(n, d[2] * dt, soft2, j2_center, j2, j2_req, j2_mu);
            drift(n, c[3] * dt);
            if np > 0 {
                particles_drift(np, dt);
                particles_kick(np, n, dt * 0.5, soft2, true);
            }
        }
    }
}

/// Bodies-only stepping (used by the parity gate and by MEGNO runs where
/// the JS tangent map owns the bodies but particles still ride the wasm).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn step_bodies(
    n_bodies: u32,
    steps: u32,
    dt: f64,
    soft2: f64,
    j2_center: i32,
    j2: f64,
    j2_req: f64,
    j2_mu: f64,
) {
    step_system(n_bodies, 0, steps, dt, soft2, j2_center, j2, j2_req, j2_mu);
}

// ── Massless test particles (P3.2) ───────────────────────────────────────────

unsafe fn save_positions_internal(n: usize) {
    let b = &*core::ptr::addr_of!(BODIES);
    let old = &mut *core::ptr::addr_of_mut!(OLD_POS);
    for i in 0..n {
        old[i * 3] = b[i * 7 + 1];
        old[i * 3 + 1] = b[i * 7 + 2];
        old[i * 3 + 2] = b[i * 7 + 3];
    }
}

/// Snapshot current body positions into OLD_POS. For callers that step the
/// bodies in JS (MEGNO) but keep particles in the kernel.
#[no_mangle]
pub extern "C" fn save_positions(n_bodies: u32) {
    unsafe { save_positions_internal((n_bodies as usize).min(MAX_BODIES)) }
}

/// Kick every particle from the massive bodies. `at_new` selects the
/// current body positions; false uses the OLD_POS snapshot (field at t).
unsafe fn particles_kick(np: usize, n: usize, dt: f64, soft2: f64, at_new: bool) {
    let b = &*core::ptr::addr_of!(BODIES);
    let old = &*core::ptr::addr_of!(OLD_POS);
    let p = &mut *core::ptr::addr_of_mut!(PARTICLES);
    for k in 0..np {
        let o = k * 6;
        let px = p[o];
        let py = p[o + 1];
        let pz = p[o + 2];
        let mut ax = 0.0;
        let mut ay = 0.0;
        let mut az = 0.0;
        for i in 0..n {
            let (bx, by, bz) = if at_new {
                (b[i * 7 + 1], b[i * 7 + 2], b[i * 7 + 3])
            } else {
                (old[i * 3], old[i * 3 + 1], old[i * 3 + 2])
            };
            let dx = bx - px;
            let dy = by - py;
            let dz = bz - pz;
            let r2 = dx * dx + dy * dy + dz * dz + soft2;
            let r = r2.sqrt();
            let gm = G_SI * b[i * 7] / (r2 * r);
            ax += gm * dx;
            ay += gm * dy;
            az += gm * dz;
        }
        p[o + 3] += ax * dt;
        p[o + 4] += ay * dt;
        p[o + 5] += az * dt;
    }
}

unsafe fn particles_drift(np: usize, dt: f64) {
    let p = &mut *core::ptr::addr_of_mut!(PARTICLES);
    for k in 0..np {
        let o = k * 6;
        p[o] += p[o + 3] * dt;
        p[o + 1] += p[o + 4] * dt;
        p[o + 2] += p[o + 5] * dt;
    }
}

/// Particles-only step (KDK) for MEGNO frames: call save_positions BEFORE
/// stepping the bodies in JS, then this AFTER writing the new body state.
#[no_mangle]
pub extern "C" fn step_particles(n_bodies: u32, n_particles: u32, dt: f64, soft2: f64) {
    let n = (n_bodies as usize).min(MAX_BODIES);
    let np = (n_particles as usize).min(MAX_PARTICLES);
    unsafe {
        particles_kick(np, n, dt * 0.5, soft2, false);
        particles_drift(np, dt);
        particles_kick(np, n, dt * 0.5, soft2, true);
    }
}

/// Osculating a (meters) and e for every particle about the body at
/// `center_idx`, written to the orbits buffer as [a, e] pairs. Unbound
/// particles get a = -1. Feeds the Kirkwood histogram.
#[no_mangle]
pub extern "C" fn compute_orbits(n_particles: u32, center_idx: u32) {
    let np = (n_particles as usize).min(MAX_PARTICLES);
    unsafe {
        let b = &*core::ptr::addr_of!(BODIES);
        let p = &*core::ptr::addr_of!(PARTICLES);
        let out = &mut *core::ptr::addr_of_mut!(ORBITS);
        let c = (center_idx as usize).min(MAX_BODIES - 1) * 7;
        let mu = G_SI * b[c];
        for k in 0..np {
            let o = k * 6;
            let x = p[o] - b[c + 1];
            let y = p[o + 1] - b[c + 2];
            let z = p[o + 2] - b[c + 3];
            let vx = p[o + 3] - b[c + 4];
            let vy = p[o + 4] - b[c + 5];
            let vz = p[o + 5] - b[c + 6];
            let r = (x * x + y * y + z * z).sqrt();
            let v2 = vx * vx + vy * vy + vz * vz;
            let energy = 0.5 * v2 - mu / r;
            if energy >= 0.0 || r == 0.0 {
                out[k * 2] = -1.0;
                out[k * 2 + 1] = 0.0;
                continue;
            }
            let a = -mu / (2.0 * energy);
            let hx = y * vz - z * vy;
            let hy = z * vx - x * vz;
            let hz = x * vy - y * vx;
            let h2 = hx * hx + hy * hy + hz * hz;
            let e2 = 1.0 - h2 / (mu * a);
            out[k * 2] = a;
            out[k * 2 + 1] = if e2 > 0.0 { e2.sqrt() } else { 0.0 };
        }
    }
}

// ── Diagnostics (mirror of physics.js totalEnergy / totalAngularMomentum) ───

#[no_mangle]
pub extern "C" fn total_energy(n_bodies: u32, soft2: f64) -> f64 {
    let n = (n_bodies as usize).min(MAX_BODIES);
    unsafe {
        let b = &*core::ptr::addr_of!(BODIES);
        let mut ke = 0.0;
        for i in 0..n {
            let o = i * 7;
            let v2 = b[o + 4] * b[o + 4] + b[o + 5] * b[o + 5] + b[o + 6] * b[o + 6];
            ke += 0.5 * b[o] * v2;
        }
        let mut pe = 0.0;
        for i in 0..n {
            for j in (i + 1)..n {
                let bi = i * 7;
                let bj = j * 7;
                let dx = b[bj + 1] - b[bi + 1];
                let dy = b[bj + 2] - b[bi + 2];
                let dz = b[bj + 3] - b[bi + 3];
                let r = (dx * dx + dy * dy + dz * dz + soft2).sqrt();
                pe -= G_SI * b[bi] * b[bj] / r;
            }
        }
        ke + pe
    }
}

/// |L| of the massive bodies (magnitude only — the HUD's scalar).
#[no_mangle]
pub extern "C" fn angular_momentum_mag(n_bodies: u32) -> f64 {
    let n = (n_bodies as usize).min(MAX_BODIES);
    unsafe {
        let b = &*core::ptr::addr_of!(BODIES);
        let (mut lx, mut ly, mut lz) = (0.0, 0.0, 0.0);
        for i in 0..n {
            let o = i * 7;
            let m = b[o];
            lx += m * (b[o + 2] * b[o + 6] - b[o + 3] * b[o + 5]);
            ly += m * (b[o + 3] * b[o + 4] - b[o + 1] * b[o + 6]);
            lz += m * (b[o + 1] * b[o + 5] - b[o + 2] * b[o + 4]);
        }
        (lx * lx + ly * ly + lz * lz).sqrt()
    }
}
