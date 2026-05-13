//! Conserved-variable layout for 2.5-D ideal/resistive MHD.
//!
//! We store 9 fields per cell in a structure-of-arrays layout (one Vec<f64>
//! per field), which lets the Riemann solver iterate over a single flat
//! index without strided gathers, and keeps WASM linear memory cache-friendly
//! for column-wise sweeps.
//!
//! Conserved vector U = (rho, mx, my, mz, bx, by, bz, e, psi):
//!   rho       mass density
//!   mx,my,mz  momentum density (rho * v)
//!   bx,by,bz  magnetic field (in code units; mu_0 = 1)
//!   e         total energy density = e_int + 0.5 rho v^2 + 0.5 B^2
//!   psi       GLM divergence-cleaning scalar (carried even in pure-hydro
//!             phase; cheap and avoids reshuffling the SoA later)
//!
//! Equation of state is ideal gas: p = (gamma - 1) * e_int, with e_int the
//! thermal part of `e` after subtracting kinetic and magnetic contributions.

use crate::grid::Grid;

pub const N_VARS: usize = 9;

pub mod var {
    pub const RHO: usize = 0;
    pub const MX: usize = 1;
    pub const MY: usize = 2;
    pub const MZ: usize = 3;
    pub const BX: usize = 4;
    pub const BY: usize = 5;
    pub const BZ: usize = 6;
    pub const E: usize = 7;
    pub const PSI: usize = 8;
}

/// Conserved state on the padded grid. Each field is a Vec<f64> of length
/// `grid.padded_len()`.
#[derive(Clone)]
pub struct State {
    pub u: [Vec<f64>; N_VARS],
}

impl State {
    pub fn zeros(grid: &Grid) -> Self {
        let n = grid.padded_len();
        Self {
            u: core::array::from_fn(|_| vec![0.0; n]),
        }
    }

    #[inline]
    pub fn get(&self, var: usize, idx: usize) -> f64 {
        self.u[var][idx]
    }

    #[inline]
    pub fn set(&mut self, var: usize, idx: usize, value: f64) {
        self.u[var][idx] = value;
    }
}

/// Primitive variables at a single cell. Built on demand from the conserved
/// state — we don't store them, to keep memory traffic down on WASM.
#[derive(Clone, Copy, Debug)]
pub struct Prim {
    pub rho: f64,
    pub vx: f64,
    pub vy: f64,
    pub vz: f64,
    pub p: f64,
    pub bx: f64,
    pub by: f64,
    pub bz: f64,
    pub psi: f64,
}

/// Adiabatic index. 5/3 for a fully ionised monatomic coronal plasma.
pub const GAMMA: f64 = 5.0 / 3.0;

/// Minimum density / pressure floor. Resistive reconnection runs can hit
/// near-zero pressure transiently; the floor keeps the solver stable without
/// masking real physics (set well below the IC values).
pub const RHO_FLOOR: f64 = 1.0e-6;
pub const P_FLOOR: f64 = 1.0e-8;

/// Convert one cell's conserved variables to primitive form.
#[inline]
pub fn cons_to_prim(u: [f64; N_VARS]) -> Prim {
    let rho = u[var::RHO].max(RHO_FLOOR);
    let inv_rho = 1.0 / rho;
    let vx = u[var::MX] * inv_rho;
    let vy = u[var::MY] * inv_rho;
    let vz = u[var::MZ] * inv_rho;
    let bx = u[var::BX];
    let by = u[var::BY];
    let bz = u[var::BZ];
    let kin = 0.5 * rho * (vx * vx + vy * vy + vz * vz);
    let mag = 0.5 * (bx * bx + by * by + bz * bz);
    let p = ((GAMMA - 1.0) * (u[var::E] - kin - mag)).max(P_FLOOR);
    Prim {
        rho,
        vx,
        vy,
        vz,
        p,
        bx,
        by,
        bz,
        psi: u[var::PSI],
    }
}

/// Convert primitives to conserved.
#[inline]
pub fn prim_to_cons(p: Prim) -> [f64; N_VARS] {
    let kin = 0.5 * p.rho * (p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
    let mag = 0.5 * (p.bx * p.bx + p.by * p.by + p.bz * p.bz);
    let e = p.p / (GAMMA - 1.0) + kin + mag;
    let mut u = [0.0; N_VARS];
    u[var::RHO] = p.rho;
    u[var::MX] = p.rho * p.vx;
    u[var::MY] = p.rho * p.vy;
    u[var::MZ] = p.rho * p.vz;
    u[var::BX] = p.bx;
    u[var::BY] = p.by;
    u[var::BZ] = p.bz;
    u[var::E] = e;
    u[var::PSI] = p.psi;
    u
}

/// Fast magnetosonic wave speed along axis `n` (0 = x, 1 = y).
/// Used by the HLL/HLLD solvers and by the CFL estimator.
#[inline]
pub fn fast_speed(p: Prim, axis: usize) -> f64 {
    let bsq = p.bx * p.bx + p.by * p.by + p.bz * p.bz;
    let a2 = GAMMA * p.p / p.rho;
    let ca2 = bsq / p.rho;
    let bn2 = match axis {
        0 => p.bx * p.bx / p.rho,
        _ => p.by * p.by / p.rho,
    };
    let term = a2 + ca2;
    let disc = (term * term - 4.0 * a2 * bn2).max(0.0);
    (0.5 * (term + disc.sqrt())).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cons_prim_round_trip() {
        let p = Prim {
            rho: 1.25,
            vx: 0.3,
            vy: -0.1,
            vz: 0.05,
            p: 0.7,
            bx: 0.4,
            by: -0.2,
            bz: 0.1,
            psi: 0.0,
        };
        let u = prim_to_cons(p);
        let q = cons_to_prim(u);
        assert!((q.rho - p.rho).abs() < 1e-12);
        assert!((q.vx - p.vx).abs() < 1e-12);
        assert!((q.p - p.p).abs() < 1e-10);
        assert!((q.bx - p.bx).abs() < 1e-12);
    }

    #[test]
    fn hydro_fast_speed_reduces_to_sound_speed() {
        let p = Prim {
            rho: 1.0,
            vx: 0.0,
            vy: 0.0,
            vz: 0.0,
            p: 1.0,
            bx: 0.0,
            by: 0.0,
            bz: 0.0,
            psi: 0.0,
        };
        let cs = (GAMMA * p.p / p.rho).sqrt();
        assert!((fast_speed(p, 0) - cs).abs() < 1e-12);
        assert!((fast_speed(p, 1) - cs).abs() < 1e-12);
    }
}
