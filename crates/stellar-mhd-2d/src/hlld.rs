//! HLLD Riemann solver (Miyoshi & Kusano 2005, JCP 208, 315).
//!
//! Five-wave approximation for ideal MHD: two outer fast waves, two Alfvén
//! waves, and a contact (entropy) wave. Resolves rotational discontinuities
//! and the contact, which HLL collapses into a single diffusive jump — that
//! difference matters at current sheets where reconnection happens.
//!
//! Conventions:
//!   * The "normal" direction is the face normal (`n`); the two tangential
//!     directions are `t1` and `t2`. Our state stores 3-vectors as (x,y,z);
//!     this module is axis-agnostic — the caller rotates the input into
//!     "normal/tangential" order.
//!   * The normal magnetic component `Bn` is *shared* between left and right
//!     (GLM gives us a single upwind-corrected value). All other tangential
//!     components can jump.
//!   * mu_0 = 1, gamma = 5/3 (set in `state.rs`).
//!
//! GLM (Dedner et al. 2002) splits B_n and psi off the eight-wave system and
//! advects them with their own speed `c_h`. Inside HLLD we treat `Bn` as a
//! constant parameter; outside, the caller adds the (psi, Bn) flux pair from
//! the GLM upwind formulas.

use crate::state::{fast_speed, var, Prim, N_VARS, GAMMA};

/// Axis-aligned primitive view used inside HLLD: components in (n, t1, t2)
/// order rather than (x, y, z). The caller is responsible for the rotation.
#[derive(Clone, Copy)]
struct PrimN {
    rho: f64,
    vn: f64,
    vt1: f64,
    vt2: f64,
    p: f64,
    bn: f64,
    bt1: f64,
    bt2: f64,
    psi: f64,
}

#[derive(Clone, Copy)]
enum Axis {
    X,
    Y,
}

#[inline]
fn rotate_in(p: Prim, axis: Axis) -> PrimN {
    match axis {
        Axis::X => PrimN {
            rho: p.rho, vn: p.vx, vt1: p.vy, vt2: p.vz, p: p.p,
            bn: p.bx, bt1: p.by, bt2: p.bz, psi: p.psi,
        },
        Axis::Y => PrimN {
            rho: p.rho, vn: p.vy, vt1: p.vx, vt2: p.vz, p: p.p,
            bn: p.by, bt1: p.bx, bt2: p.bz, psi: p.psi,
        },
    }
}

/// Pack an (n, t1, t2) conserved-flux tuple back into (x, y, z) order.
#[inline]
fn rotate_out(
    f_rho: f64, f_mn: f64, f_mt1: f64, f_mt2: f64,
    f_bn: f64, f_bt1: f64, f_bt2: f64,
    f_e: f64, f_psi: f64,
    axis: Axis,
) -> [f64; N_VARS] {
    let mut f = [0.0; N_VARS];
    f[var::RHO] = f_rho;
    f[var::E] = f_e;
    f[var::PSI] = f_psi;
    match axis {
        Axis::X => {
            f[var::MX] = f_mn;  f[var::MY] = f_mt1; f[var::MZ] = f_mt2;
            f[var::BX] = f_bn;  f[var::BY] = f_bt1; f[var::BZ] = f_bt2;
        }
        Axis::Y => {
            f[var::MY] = f_mn;  f[var::MX] = f_mt1; f[var::MZ] = f_mt2;
            f[var::BY] = f_bn;  f[var::BX] = f_bt1; f[var::BZ] = f_bt2;
        }
    }
    f
}

/// Conserved state in (n, t1, t2) order.
#[derive(Clone, Copy)]
struct ConsN {
    rho: f64,
    mn: f64,
    mt1: f64,
    mt2: f64,
    bn: f64,
    bt1: f64,
    bt2: f64,
    e: f64,
}

#[inline]
fn prim_n_to_cons(p: PrimN) -> ConsN {
    let kin = 0.5 * p.rho * (p.vn * p.vn + p.vt1 * p.vt1 + p.vt2 * p.vt2);
    let mag = 0.5 * (p.bn * p.bn + p.bt1 * p.bt1 + p.bt2 * p.bt2);
    let e = p.p / (GAMMA - 1.0) + kin + mag;
    ConsN { rho: p.rho, mn: p.rho * p.vn, mt1: p.rho * p.vt1, mt2: p.rho * p.vt2,
            bn: p.bn, bt1: p.bt1, bt2: p.bt2, e }
}

/// Analytic conservative flux of the ideal-MHD system along the normal,
/// expressed in (n, t1, t2) coords. (Excludes the GLM psi piece.)
#[inline]
fn flux_n(p: PrimN) -> ConsN {
    let bsq = p.bn * p.bn + p.bt1 * p.bt1 + p.bt2 * p.bt2;
    let ptot = p.p + 0.5 * bsq;
    let vdotb = p.vn * p.bn + p.vt1 * p.bt1 + p.vt2 * p.bt2;
    let e = p.p / (GAMMA - 1.0)
        + 0.5 * p.rho * (p.vn * p.vn + p.vt1 * p.vt1 + p.vt2 * p.vt2)
        + 0.5 * bsq;
    ConsN {
        rho: p.rho * p.vn,
        mn: p.rho * p.vn * p.vn + ptot - p.bn * p.bn,
        mt1: p.rho * p.vn * p.vt1 - p.bn * p.bt1,
        mt2: p.rho * p.vn * p.vt2 - p.bn * p.bt2,
        bn: 0.0, // handled by GLM
        bt1: p.vn * p.bt1 - p.vt1 * p.bn,
        bt2: p.vn * p.bt2 - p.vt2 * p.bn,
        e: (e + ptot) * p.vn - p.bn * vdotb,
    }
}

/// HLLD numerical flux at a face.
///
/// `bn_face` and `psi_face` are the GLM-corrected normal-B and psi at the
/// interface — both are *single-valued* (continuous) by construction. They
/// are substituted into both the left and right primitive states before
/// solving for the star and double-star regions, and supplied as the
/// (bn, psi) flux pair on output.
pub fn hlld_flux(
    pl_xyz: Prim, pr_xyz: Prim, axis_idx: usize,
    bn_face: f64, psi_face: f64,
) -> [f64; N_VARS] {
    let axis = if axis_idx == 0 { Axis::X } else { Axis::Y };
    let mut pl = rotate_in(pl_xyz, axis);
    let mut pr = rotate_in(pr_xyz, axis);
    // Substitute GLM-corrected interface Bn so both sides agree.
    pl.bn = bn_face;
    pr.bn = bn_face;
    pl.psi = psi_face;
    pr.psi = psi_face;

    // --- Outer fast speeds (Davis estimate, Janhunen-style) ---
    let cfl = fast_speed(
        Prim { rho: pl.rho, vx: pl.vn, vy: pl.vt1, vz: pl.vt2, p: pl.p,
               bx: pl.bn, by: pl.bt1, bz: pl.bt2, psi: 0.0 },
        0,
    );
    let cfr = fast_speed(
        Prim { rho: pr.rho, vx: pr.vn, vy: pr.vt1, vz: pr.vt2, p: pr.p,
               bx: pr.bn, by: pr.bt1, bz: pr.bt2, psi: 0.0 },
        0,
    );
    let sl = (pl.vn - cfl).min(pr.vn - cfr);
    let sr = (pl.vn + cfl).max(pr.vn + cfr);

    let ul = prim_n_to_cons(pl);
    let ur = prim_n_to_cons(pr);
    let fl = flux_n(pl);
    let fr = flux_n(pr);

    // Early exits for supersonic boundaries.
    if sl >= 0.0 {
        return pack(fl, bn_face, psi_face, axis);
    }
    if sr <= 0.0 {
        return pack(fr, bn_face, psi_face, axis);
    }

    // --- Total pressure, contact speed SM (Miyoshi & Kusano eq. 38) ---
    let pt_l = pl.p + 0.5 * (pl.bn * pl.bn + pl.bt1 * pl.bt1 + pl.bt2 * pl.bt2);
    let pt_r = pr.p + 0.5 * (pr.bn * pr.bn + pr.bt1 * pr.bt1 + pr.bt2 * pr.bt2);

    let num = (sr - pr.vn) * pr.rho * pr.vn - (sl - pl.vn) * pl.rho * pl.vn
              - pt_r + pt_l;
    let den = (sr - pr.vn) * pr.rho - (sl - pl.vn) * pl.rho;
    let sm = num / den;

    // --- Star-state total pressure (continuous across SM) ---
    let pt_star = pl.rho * (sl - pl.vn) * (sm - pl.vn) + pt_l;
    // (Identical to: pr.rho * (sr - pr.vn) * (sm - pr.vn) + pt_r.)

    let bn = bn_face;
    let bn_abs = bn.abs();

    // --- Star-state densities ---
    let rho_sl = pl.rho * (sl - pl.vn) / (sl - sm);
    let rho_sr = pr.rho * (sr - pr.vn) / (sr - sm);
    let sqrt_rsl = rho_sl.sqrt();
    let sqrt_rsr = rho_sr.sqrt();

    // --- Star-state tangential velocity & B (Miyoshi & Kusano eqs. 42-47) ---
    // Degeneracy guard: when the rotational denominator is tiny, the Alfvén
    // wave coincides with the contact and we fall back to the HLL averages
    // for tangential components.
    const DEG_EPS: f64 = 1.0e-12;

    let (vt1_sl, vt2_sl, bt1_sl, bt2_sl) = {
        let denom = pl.rho * (sl - pl.vn) * (sl - sm) - bn * bn;
        if denom.abs() < DEG_EPS * pt_star.max(1.0) {
            (pl.vt1, pl.vt2, pl.bt1 * (sl - pl.vn) / (sl - sm),
                                pl.bt2 * (sl - pl.vn) / (sl - sm))
        } else {
            let factor = bn * (sm - pl.vn) / denom;
            let bfactor = (pl.rho * (sl - pl.vn) * (sl - pl.vn) - bn * bn) / denom;
            (pl.vt1 - pl.bt1 * factor,
             pl.vt2 - pl.bt2 * factor,
             pl.bt1 * bfactor,
             pl.bt2 * bfactor)
        }
    };
    let (vt1_sr, vt2_sr, bt1_sr, bt2_sr) = {
        let denom = pr.rho * (sr - pr.vn) * (sr - sm) - bn * bn;
        if denom.abs() < DEG_EPS * pt_star.max(1.0) {
            (pr.vt1, pr.vt2, pr.bt1 * (sr - pr.vn) / (sr - sm),
                                pr.bt2 * (sr - pr.vn) / (sr - sm))
        } else {
            let factor = bn * (sm - pr.vn) / denom;
            let bfactor = (pr.rho * (sr - pr.vn) * (sr - pr.vn) - bn * bn) / denom;
            (pr.vt1 - pr.bt1 * factor,
             pr.vt2 - pr.bt2 * factor,
             pr.bt1 * bfactor,
             pr.bt2 * bfactor)
        }
    };

    // --- Star-state energies (Miyoshi & Kusano eq. 48) ---
    let vdotb_l = pl.vn * pl.bn + pl.vt1 * pl.bt1 + pl.vt2 * pl.bt2;
    let vdotb_sl = sm * bn + vt1_sl * bt1_sl + vt2_sl * bt2_sl;
    let e_sl = ((sl - pl.vn) * ul.e - pt_l * pl.vn + pt_star * sm
                + bn * (vdotb_l - vdotb_sl)) / (sl - sm);

    let vdotb_r = pr.vn * pr.bn + pr.vt1 * pr.bt1 + pr.vt2 * pr.bt2;
    let vdotb_sr = sm * bn + vt1_sr * bt1_sr + vt2_sr * bt2_sr;
    let e_sr = ((sr - pr.vn) * ur.e - pt_r * pr.vn + pt_star * sm
                + bn * (vdotb_r - vdotb_sr)) / (sr - sm);

    let u_sl = ConsN { rho: rho_sl, mn: rho_sl * sm,
                       mt1: rho_sl * vt1_sl, mt2: rho_sl * vt2_sl,
                       bn, bt1: bt1_sl, bt2: bt2_sl, e: e_sl };
    let u_sr = ConsN { rho: rho_sr, mn: rho_sr * sm,
                       mt1: rho_sr * vt1_sr, mt2: rho_sr * vt2_sr,
                       bn, bt1: bt1_sr, bt2: bt2_sr, e: e_sr };

    // --- Alfvén wave speeds (Miyoshi & Kusano eq. 51) ---
    let s_sl = sm - bn_abs / sqrt_rsl;
    let s_sr = sm + bn_abs / sqrt_rsr;

    // --- Double-star region (between the two Alfvén waves) ---
    let sign_bn = if bn >= 0.0 { 1.0 } else { -1.0 };
    let inv_sum = 1.0 / (sqrt_rsl + sqrt_rsr);

    let vt1_ss = (sqrt_rsl * vt1_sl + sqrt_rsr * vt1_sr
                  + (bt1_sr - bt1_sl) * sign_bn) * inv_sum;
    let vt2_ss = (sqrt_rsl * vt2_sl + sqrt_rsr * vt2_sr
                  + (bt2_sr - bt2_sl) * sign_bn) * inv_sum;
    let bt1_ss = (sqrt_rsl * bt1_sr + sqrt_rsr * bt1_sl
                  + sqrt_rsl * sqrt_rsr * (vt1_sr - vt1_sl) * sign_bn) * inv_sum;
    let bt2_ss = (sqrt_rsl * bt2_sr + sqrt_rsr * bt2_sl
                  + sqrt_rsl * sqrt_rsr * (vt2_sr - vt2_sl) * sign_bn) * inv_sum;

    let vdotb_ss = sm * bn + vt1_ss * bt1_ss + vt2_ss * bt2_ss;
    let e_ssl = e_sl - sqrt_rsl * (vdotb_sl - vdotb_ss) * sign_bn;
    let e_ssr = e_sr + sqrt_rsr * (vdotb_sr - vdotb_ss) * sign_bn;

    let u_ssl = ConsN { rho: rho_sl, mn: rho_sl * sm,
                        mt1: rho_sl * vt1_ss, mt2: rho_sl * vt2_ss,
                        bn, bt1: bt1_ss, bt2: bt2_ss, e: e_ssl };
    let u_ssr = ConsN { rho: rho_sr, mn: rho_sr * sm,
                        mt1: rho_sr * vt1_ss, mt2: rho_sr * vt2_ss,
                        bn, bt1: bt1_ss, bt2: bt2_ss, e: e_ssr };

    // --- Region selection ---
    let f_out = if s_sl >= 0.0 {
        // F*L = FL + SL (U*L - UL)
        flux_plus(fl, sl, u_sl, ul)
    } else if sm >= 0.0 {
        // F**L = FL + SL (U*L - UL) + SL* (U**L - U*L)
        let f_sl = flux_plus(fl, sl, u_sl, ul);
        flux_plus(f_sl, s_sl, u_ssl, u_sl)
    } else if s_sr >= 0.0 {
        let f_sr = flux_plus(fr, sr, u_sr, ur);
        flux_plus(f_sr, s_sr, u_ssr, u_sr)
    } else {
        flux_plus(fr, sr, u_sr, ur)
    };

    pack(f_out, bn_face, psi_face, axis)
}

#[inline]
fn flux_plus(f: ConsN, s: f64, u_new: ConsN, u_old: ConsN) -> ConsN {
    ConsN {
        rho: f.rho + s * (u_new.rho - u_old.rho),
        mn: f.mn + s * (u_new.mn - u_old.mn),
        mt1: f.mt1 + s * (u_new.mt1 - u_old.mt1),
        mt2: f.mt2 + s * (u_new.mt2 - u_old.mt2),
        bn: f.bn + s * (u_new.bn - u_old.bn),
        bt1: f.bt1 + s * (u_new.bt1 - u_old.bt1),
        bt2: f.bt2 + s * (u_new.bt2 - u_old.bt2),
        e: f.e + s * (u_new.e - u_old.e),
    }
}

#[inline]
fn pack(f: ConsN, _bn_face: f64, psi_face: f64, axis: Axis) -> [f64; N_VARS] {
    // GLM split: F_Bn = psi at the interface (Dedner 2002 eq. 24). The
    // F_psi = c_h^2 * Bn_face piece is filled in by the caller, because
    // c_h is a solver-level constant updated each step.
    rotate_out(
        f.rho, f.mn, f.mt1, f.mt2,
        psi_face, f.bt1, f.bt2,
        f.e,
        0.0,
        axis,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hlld_reduces_to_hll_for_pure_hydro_along_x() {
        // With B = 0 and equal states, HLLD must return the analytic flux.
        let p = Prim { rho: 1.0, vx: 0.5, vy: 0.0, vz: 0.0, p: 1.0,
                       bx: 0.0, by: 0.0, bz: 0.0, psi: 0.0 };
        let f = hlld_flux(p, p, 0, 0.0, 0.0);
        // F_rho = rho * vx = 0.5
        assert!((f[var::RHO] - 0.5).abs() < 1e-12);
        // F_mx = rho*vx*vx + p = 0.25 + 1.0 = 1.25
        assert!((f[var::MX] - 1.25).abs() < 1e-12);
    }

    #[test]
    fn hlld_static_uniform_state_has_pressure_flux_only() {
        // Stationary uniform state: F_mx should equal total pressure.
        let p = Prim { rho: 1.0, vx: 0.0, vy: 0.0, vz: 0.0, p: 1.0,
                       bx: 0.3, by: 0.2, bz: 0.1, psi: 0.0 };
        let f = hlld_flux(p, p, 0, 0.3, 0.0);
        assert!(f[var::RHO].abs() < 1e-10);
        let ptot = p.p + 0.5 * (0.3 * 0.3 + 0.2 * 0.2 + 0.1 * 0.1);
        let expected_mx = ptot - 0.3 * 0.3;
        assert!((f[var::MX] - expected_mx).abs() < 1e-10,
                "f[MX] = {}, expected {}", f[var::MX], expected_mx);
    }
}
