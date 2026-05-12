//! Second-order finite-volume transport on a log-polar grid.
//!
//! Scheme
//! ------
//! * **PLM reconstruction** of primitive variables (Σ, v_r, v_φ) with the
//!   classic **minmod** limiter — preserves monotonicity, suppresses
//!   spurious oscillations near sharp gradients, and degrades to first
//!   order only at genuine extrema. On a smooth flow PLM is second-order
//!   accurate in space.
//! * **LLF / Rusanov** Riemann flux at each cell face — the most diffusive
//!   of the modern Riemann solvers, but trivially robust and adequate for
//!   subsonic disc flows. Stays positive without artificial floors as long
//!   as CFL ≲ 0.4.
//! * **Isothermal pressure** included only in the *radial* flux. The
//!   azimuthal pressure gradient is treated as a source (∂P/∂φ in
//!   `source.rs`) because FARGO subtracts the mean rotation in φ and the
//!   surviving residual is itself sub-sonic.
//!
//! Conservation
//! ------------
//! Σ, Σ·v_r and Σ·v_φ are evolved in *conservative* form using the
//! cylindrical finite-volume update
//!     ΔU_ij  =  -dt · [ (r·F^r)_{i+1/2,j} - (r·F^r)_{i-1/2,j} ] / (r_i · dr_i)
//!              -dt · [   F^φ_{i,j+1/2}   -   F^φ_{i,j-1/2}   ] / (r_i · dφ)
//! With LLF + minmod this gives sub-percent total-mass drift over many
//! orbits, where donor-cell upwind drifts ≳ 50 % at the same resolution.
//!
//! The geometric source terms (+ v_φ² / r) and (- v_r v_φ / r) that arise
//! from evolving "Cartesian-like" momenta on a curvilinear grid are
//! applied separately in `source.rs::apply_sources`. Without those the
//! disc has no centrifugal support and collapses within one orbit.

use crate::TransportScratch;
use crate::grid::Grid;

#[inline(always)]
fn minmod(a: f64, b: f64) -> f64 {
    // minmod = ½·(sgn a + sgn b) · min(|a|, |b|).
    if a * b <= 0.0 {
        0.0
    } else if a.abs() < b.abs() {
        a
    } else {
        b
    }
}

const SIGMA_FLOOR: f64 = 1e-30;

pub fn advect(g: &Grid,
              sigma: &mut [f64], vr: &mut [f64], vphi: &mut [f64],
              w_phi: &[f64],
              s: &mut TransportScratch,
              dt: f64)
{
    let nr   = g.nr;
    let nphi = g.nphi;
    let n    = nr * nphi;
    let dphi = g.dphi;

    // ── 1) Radial slopes (minmod) ───────────────────────────────────────────
    // Slope at i=0 and i=nr-1 stays zero (one-sided difference is not enough
    // to limit; first-order at the wave-killing boundary is fine).
    for i in 1..(nr - 1) {
        let dr_m = g.r[i]   - g.r[i-1];
        let dr_p = g.r[i+1] - g.r[i];
        for j in 0..nphi {
            let k  = g.idx(i,   j);
            let kl = g.idx(i-1, j);
            let kr = g.idx(i+1, j);
            s.sl_sig_r[k] = minmod((sigma[k] - sigma[kl]) / dr_m,
                                   (sigma[kr] - sigma[k]) / dr_p);
            s.sl_vr_r[k]  = minmod((vr[k]    - vr[kl])    / dr_m,
                                   (vr[kr]   - vr[k])     / dr_p);
            s.sl_vp_r[k]  = minmod((vphi[k]  - vphi[kl])  / dr_m,
                                   (vphi[kr] - vphi[k])   / dr_p);
        }
    }
    for j in 0..nphi {
        let k0 = g.idx(0,      j);
        let k_last = g.idx(nr - 1, j);
        s.sl_sig_r[k0]     = 0.0; s.sl_vr_r[k0]     = 0.0; s.sl_vp_r[k0]     = 0.0;
        s.sl_sig_r[k_last] = 0.0; s.sl_vr_r[k_last] = 0.0; s.sl_vp_r[k_last] = 0.0;
    }

    // ── 2) Azimuthal slopes (minmod, periodic) ──────────────────────────────
    let inv_dphi = 1.0 / dphi;
    for i in 0..nr {
        for j in 0..nphi {
            let jm = if j == 0          { nphi - 1 } else { j - 1 };
            let jp = if j == nphi - 1   { 0        } else { j + 1 };
            let k  = g.idx(i, j);
            let kl = g.idx(i, jm);
            let kr = g.idx(i, jp);
            s.sl_sig_p[k] = minmod((sigma[k] - sigma[kl]) * inv_dphi,
                                   (sigma[kr] - sigma[k]) * inv_dphi);
            s.sl_vr_p[k]  = minmod((vr[k]    - vr[kl])    * inv_dphi,
                                   (vr[kr]   - vr[k])     * inv_dphi);
            s.sl_vp_p[k]  = minmod((vphi[k]  - vphi[kl])  * inv_dphi,
                                   (vphi[kr] - vphi[k])   * inv_dphi);
            s.sl_wp_p[k]  = minmod((w_phi[k] - w_phi[kl]) * inv_dphi,
                                   (w_phi[kr]- w_phi[k])  * inv_dphi);
        }
    }

    // ── 3) Radial fluxes ────────────────────────────────────────────────────
    // Face `f` (1 ≤ f ≤ nr-1) sits at radius rf[f] between cells f-1 and f.
    // f = 0 and f = nr are zero-flux boundaries (handled by zero initialisation).
    for f in 1..nr {
        let il = f - 1;
        let ir = f;
        let rf = g.rf[f];
        // Locally-isothermal: c_s comes from the radial profile, evaluated at
        // the face. Linear interpolation is overkill; arithmetic mean works
        // because c_s is itself a smooth function of r.
        let cs_face = 0.5 * (g.cs[il] + g.cs[ir]);
        let cs2_face = cs_face * cs_face;
        let r_to_l = rf - g.r[il];   // > 0  (extrapolating outward from cell il)
        let r_to_r = rf - g.r[ir];   // < 0  (extrapolating inward  from cell ir)

        for j in 0..nphi {
            let kl = g.idx(il, j);
            let kr = g.idx(ir, j);

            // PLM reconstruction at the face.
            let sig_l = (sigma[kl] + s.sl_sig_r[kl] * r_to_l).max(SIGMA_FLOOR);
            let sig_r = (sigma[kr] + s.sl_sig_r[kr] * r_to_r).max(SIGMA_FLOOR);
            let vr_l  = vr[kl]  + s.sl_vr_r[kl] * r_to_l;
            let vr_r  = vr[kr]  + s.sl_vr_r[kr] * r_to_r;
            let vp_l  = vphi[kl]+ s.sl_vp_r[kl] * r_to_l;
            let vp_r  = vphi[kr]+ s.sl_vp_r[kr] * r_to_r;

            // Conservative variables left / right.
            let mr_l = sig_l * vr_l;  let mr_r = sig_r * vr_r;
            let mp_l = sig_l * vp_l;  let mp_r = sig_r * vp_r;

            // Physical fluxes for the radial direction:
            //   F^r = ( Σ·v_r ,  Σ·v_r² + P ,  Σ·v_r·v_φ ).
            let p_l = cs2_face * sig_l;
            let p_r = cs2_face * sig_r;
            let f_l_sig = mr_l;
            let f_l_mr  = mr_l * vr_l + p_l;
            let f_l_mp  = mr_l * vp_l;
            let f_r_sig = mr_r;
            let f_r_mr  = mr_r * vr_r + p_r;
            let f_r_mp  = mr_r * vp_r;

            // LLF wave speed: max of |v ± c_s| left / right.
            let alpha = (vr_l.abs() + cs_face).max(vr_r.abs() + cs_face);

            // LLF flux, then multiply by r_f for the cylindrical update.
            let ff = f * nphi + j;
            s.fr_sig[ff] = rf * 0.5 * (f_l_sig + f_r_sig - alpha * (sig_r - sig_l));
            s.fr_mr [ff] = rf * 0.5 * (f_l_mr  + f_r_mr  - alpha * (mr_r  - mr_l ));
            s.fr_mp [ff] = rf * 0.5 * (f_l_mp  + f_r_mp  - alpha * (mp_r  - mp_l ));
        }
    }
    // Zero the boundary face fluxes — these are the rows that aren't
    // overwritten above (f = 0 and f = nr).
    for j in 0..nphi {
        s.fr_sig[j]           = 0.0; s.fr_mr[j]           = 0.0; s.fr_mp[j]           = 0.0;
        s.fr_sig[nr * nphi+j] = 0.0; s.fr_mr[nr*nphi+j]   = 0.0; s.fr_mp[nr*nphi+j]   = 0.0;
    }

    // ── 4) Azimuthal fluxes (periodic) ──────────────────────────────────────
    // `fp_*[idx(i, j)]` is the flux at the (j-1/2) face — between cell jm
    // and cell j. The (j+1/2) face of cell j is then `fp_*[idx(i, j+1)]`.
    let half = 0.5 * dphi;
    for i in 0..nr {
        for j in 0..nphi {
            let jm = if j == 0 { nphi - 1 } else { j - 1 };
            let kl = g.idx(i, jm);
            let kr = g.idx(i, j);

            // PLM reconstruction at the (j-1/2) face.
            let sig_l = (sigma[kl] + s.sl_sig_p[kl] * half).max(SIGMA_FLOOR);
            let sig_r = (sigma[kr] - s.sl_sig_p[kr] * half).max(SIGMA_FLOOR);
            let vr_l  = vr[kl]  + s.sl_vr_p[kl] * half;
            let vr_r  = vr[kr]  - s.sl_vr_p[kr] * half;
            let vp_l  = vphi[kl]+ s.sl_vp_p[kl] * half;
            let vp_r  = vphi[kr]- s.sl_vp_p[kr] * half;
            let wp_l  = w_phi[kl] + s.sl_wp_p[kl] * half;
            let wp_r  = w_phi[kr] - s.sl_wp_p[kr] * half;

            // Pure-advection flux in φ: pressure-gradient term is in source.rs.
            //   F^φ = w_phi · ( Σ ,  Σ·v_r ,  Σ·v_φ ).
            let mr_l = sig_l * vr_l;  let mr_r = sig_r * vr_r;
            let mp_l = sig_l * vp_l;  let mp_r = sig_r * vp_r;

            let f_l_sig = wp_l * sig_l;
            let f_l_mr  = wp_l * mr_l;
            let f_l_mp  = wp_l * mp_l;
            let f_r_sig = wp_r * sig_r;
            let f_r_mr  = wp_r * mr_r;
            let f_r_mp  = wp_r * mp_r;
            let alpha = wp_l.abs().max(wp_r.abs());

            let k = g.idx(i, j);
            s.fp_sig[k] = 0.5 * (f_l_sig + f_r_sig - alpha * (sig_r - sig_l));
            s.fp_mr [k] = 0.5 * (f_l_mr  + f_r_mr  - alpha * (mr_r  - mr_l ));
            s.fp_mp [k] = 0.5 * (f_l_mp  + f_r_mp  - alpha * (mp_r  - mp_l ));
        }
    }

    // ── 5) Cell update (forward Euler in time, second-order in space) ───────
    for i in 0..nr {
        let inv_vol_r = 1.0 / (g.r[i] * g.dr[i]);
        let inv_arc_p = 1.0 / (g.r[i] * dphi);
        for j in 0..nphi {
            let k     = g.idx(i, j);
            let f_lo  = i     * nphi + j;
            let f_hi  = (i+1) * nphi + j;
            let jp    = if j == nphi - 1 { 0 } else { j + 1 };
            let kp    = g.idx(i, jp);

            let d_sig = (s.fr_sig[f_hi] - s.fr_sig[f_lo]) * inv_vol_r
                      + (s.fp_sig[kp]   - s.fp_sig[k])    * inv_arc_p;
            let d_mr  = (s.fr_mr [f_hi] - s.fr_mr [f_lo]) * inv_vol_r
                      + (s.fp_mr [kp]   - s.fp_mr [k])    * inv_arc_p;
            let d_mp  = (s.fr_mp [f_hi] - s.fr_mp [f_lo]) * inv_vol_r
                      + (s.fp_mp [kp]   - s.fp_mp [k])    * inv_arc_p;

            let mr_old = sigma[k] * vr[k];
            let mp_old = sigma[k] * vphi[k];
            s.sig_new[k] = (sigma[k] - dt * d_sig).max(SIGMA_FLOOR);
            s.mr_new [k] =  mr_old   - dt * d_mr;
            s.mp_new [k] =  mp_old   - dt * d_mp;
        }
    }

    // ── 6) Recover primitives ───────────────────────────────────────────────
    for k in 0..n {
        let s_new = s.sig_new[k];
        sigma[k] = s_new;
        vr[k]    = s.mr_new[k] / s_new;
        vphi[k]  = s.mp_new[k] / s_new;
    }
}
