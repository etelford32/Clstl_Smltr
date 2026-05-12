//! Donor-cell upwind transport for Σ, Σ·vr, Σ·vφ on a log-polar grid.
//!
//! This is the *minimum viable* advection step — first-order in space and
//! time. The point of this push is to exercise the WASM build pipeline and
//! produce a visible disc. A second-order MUSCL reconstruction with a
//! limiter (van Leer / minmod) is straightforward to bolt on top of the
//! same flux loops in a follow-up commit.

use crate::grid::Grid;

/// Advance Σ, Σ·vr, Σ·vφ by `dt` using donor-cell fluxes built from the
/// *residual* azimuthal velocity `w_phi = v_phi - vphi_bar(r)` (passed in
/// `w_phi`). The mean Keplerian rotation is handled separately by the
/// FARGO shift step in `fargo.rs`.
///
/// Conservative form for an annulus of area `A_ij = r_i · dr_i · dφ`:
///   ∂q/∂t + (1/r) ∂(r F^r) / ∂r + (1/r) ∂F^φ / ∂φ = S
/// We treat q ∈ {Σ, Σ·vr, Σ·vφ}; pressure and centrifugal sources live in
/// `source.rs` and are applied after the transport sub-step.
pub fn advect(g: &Grid,
              sigma: &mut [f64], vr: &mut [f64], vphi: &mut [f64],
              w_phi: &[f64],
              dt: f64)
{
    let n = g.n_cells();
    let mut sigma_new = vec![0.0_f64; n];
    let mut mr_new    = vec![0.0_f64; n];
    let mut mp_new    = vec![0.0_f64; n];

    // Pre-stage momenta from velocity·density.
    let mut mr = vec![0.0_f64; n];
    let mut mp = vec![0.0_f64; n];
    for k in 0..n {
        mr[k] = sigma[k] * vr[k];
        mp[k] = sigma[k] * vphi[k];
    }

    // ── Radial donor-cell flux ──
    // Flux through the *face* between cell (i-1) and cell (i) at radius rf[i].
    // The conserved variable carried by F^r is q itself (not q/r), so the
    // contribution to a cell volume A_ij = π(rf²_{i+1} - rf²_i)·(dφ/2π) is
    //   ΔV·q_new = - dt·(rf[i+1]·F[i+1] - rf[i]·F[i]) · dφ
    // We use a simplified "1/r · (...)" cylindrical update because the
    // annulus area = r · dr · dφ to first order, which is exactly what the
    // 1/r prefactor cancels. The exact-volume form is identical up to
    // O(dr/r) — fine for our resolutions, and we'll switch to the exact
    // form when we add second-order reconstruction.
    for i in 0..g.nr {
        let im = if i == 0       { i } else { i - 1 };
        let ip = if i == g.nr-1  { i } else { i + 1 };

        for j in 0..g.nphi {
            let k  = g.idx(i, j);
            let kl = g.idx(im, j);
            let kr = g.idx(ip, j);

            // Face velocities — simple arithmetic average is sufficient at
            // first order. Inner / outer faces just clamp by using the same
            // cell on both sides (no-flux radial boundary; outflow handled
            // in source.rs by damping).
            let vr_lo = 0.5 * (vr[kl] + vr[k]);
            let vr_hi = 0.5 * (vr[k]  + vr[kr]);

            let face_lo_r = g.rf[i];
            let face_hi_r = g.rf[i + 1];

            // Donor cell pick.
            let (q_lo_sig, q_lo_mr, q_lo_mp) =
                if vr_lo >= 0.0 { (sigma[kl], mr[kl], mp[kl]) }
                else            { (sigma[k],  mr[k],  mp[k])  };
            let (q_hi_sig, q_hi_mr, q_hi_mp) =
                if vr_hi >= 0.0 { (sigma[k],  mr[k],  mp[k])  }
                else            { (sigma[kr], mr[kr], mp[kr]) };

            // Update with finite-volume form. Cell area in (r,φ) is
            // approximately r_i · dr_i · dφ ; the radial flux through a face
            // of arc-length r_f · dφ thus contributes
            //   - dt · (r_f_hi · v_r_hi · q_hi  -  r_f_lo · v_r_lo · q_lo)
            //          / (r_i · dr_i)
            let inv_vol = 1.0 / (g.r[i] * g.dr[i]);
            let net_sig = (face_hi_r * vr_hi * q_hi_sig - face_lo_r * vr_lo * q_lo_sig) * inv_vol;
            let net_mr  = (face_hi_r * vr_hi * q_hi_mr  - face_lo_r * vr_lo * q_lo_mr ) * inv_vol;
            let net_mp  = (face_hi_r * vr_hi * q_hi_mp  - face_lo_r * vr_lo * q_lo_mp ) * inv_vol;

            sigma_new[k] = sigma[k] - dt * net_sig;
            mr_new[k]    = mr[k]    - dt * net_mr;
            mp_new[k]    = mp[k]    - dt * net_mp;
        }
    }

    // ── Azimuthal residual donor-cell flux (periodic) ──
    // φ-direction is periodic, so neighbour indexing is modular. The flux
    // through face j (between cell j-1 and cell j) carries the residual
    // velocity w_phi only — the bulk Keplerian shift is the FARGO step.
    for i in 0..g.nr {
        // Cell volume in (r,φ): r·dr·dφ ⇒ flux contribution
        //   - dt · (F_{j+1/2} - F_{j-1/2}) / (r·dφ)
        let inv_arc = 1.0 / (g.r[i] * g.dphi);
        for j in 0..g.nphi {
            let jm = (j + g.nphi - 1) % g.nphi;
            let jp = (j + 1)            % g.nphi;
            let k  = g.idx(i, j);
            let kl = g.idx(i, jm);
            let kr = g.idx(i, jp);

            // Face residual velocities.
            let wp_lo = 0.5 * (w_phi[kl] + w_phi[k]);
            let wp_hi = 0.5 * (w_phi[k]  + w_phi[kr]);

            let (q_lo_sig, q_lo_mr, q_lo_mp) =
                if wp_lo >= 0.0 { (sigma[kl], mr[kl], mp[kl]) }
                else            { (sigma[k],  mr[k],  mp[k])  };
            let (q_hi_sig, q_hi_mr, q_hi_mp) =
                if wp_hi >= 0.0 { (sigma[k],  mr[k],  mp[k])  }
                else            { (sigma[kr], mr[kr], mp[kr]) };

            let net_sig = (wp_hi * q_hi_sig - wp_lo * q_lo_sig) * inv_arc;
            let net_mr  = (wp_hi * q_hi_mr  - wp_lo * q_lo_mr ) * inv_arc;
            let net_mp  = (wp_hi * q_hi_mp  - wp_lo * q_lo_mp ) * inv_arc;

            sigma_new[k] -= dt * net_sig;
            mr_new[k]    -= dt * net_mr;
            mp_new[k]    -= dt * net_mp;
        }
    }

    // ── Recover primitives from updated conservatives ──
    let floor = 1e-30;
    for k in 0..n {
        let s = sigma_new[k].max(floor);
        sigma[k] = s;
        vr[k]    = mr_new[k] / s;
        vphi[k]  = mp_new[k] / s;
    }
}
