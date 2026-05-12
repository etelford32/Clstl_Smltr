//! Pressure-gradient, centrifugal/Coriolis, and gravity source terms, plus
//! wave-killing boundary damping (de Val-Borro et al. 2006).

use crate::grid::Grid;

pub struct Planet {
    pub x: f64,
    pub y: f64,
    pub gm: f64,
    /// Plummer softening length, ~0.6·H is the FARGO-default.
    pub eps: f64,
}

/// Apply pressure gradient + centrifugal/Coriolis-like terms + star gravity
/// + (optional) planet gravity for a sub-step `dt`.
pub fn apply_sources(g: &Grid,
                     sigma: &mut [f64], vr: &mut [f64], vphi: &mut [f64],
                     gm_star: f64,
                     planets: &[Planet],
                     dt: f64)
{
    for i in 0..g.nr {
        let r   = g.r[i];
        let inv_r = 1.0 / r;
        // Centred pressure derivative ∂P/∂r with P = c_s²·Σ; one-sided at edges.
        let im = if i == 0       { i } else { i - 1 };
        let ip = if i == g.nr-1  { i } else { i + 1 };
        let cs2_p = g.cs[ip] * g.cs[ip];
        let cs2_m = g.cs[im] * g.cs[im];
        let dr2   = (g.r[ip] - g.r[im]).max(1e-30);

        for j in 0..g.nphi {
            let k  = g.idx(i, j);
            let phi = (j as f64 + 0.5) * g.dphi;

            // Cell-centred Cartesian position for planet gravity.
            let cx = r * phi.cos();
            let cy = r * phi.sin();

            // Pressure-gradient acceleration in r.
            let dpdr = (cs2_p * sigma[g.idx(ip, j)] - cs2_m * sigma[g.idx(im, j)]) / dr2;
            let a_r_press = -dpdr / sigma[k].max(1e-30);

            // Pressure-gradient acceleration in φ (centred difference in j,
            // periodic).
            let jm = (j + g.nphi - 1) % g.nphi;
            let jp = (j + 1)            % g.nphi;
            let cs2 = g.cs[i] * g.cs[i];
            let dpdphi = (cs2 * sigma[g.idx(i, jp)] - cs2 * sigma[g.idx(i, jm)])
                        / (2.0 * g.dphi);
            let a_phi_press = -inv_r * dpdphi / sigma[k].max(1e-30);

            // Geometric (centrifugal & curvilinear) sources.
            // We evolve Σ·v_r and Σ·v_φ as Cartesian-like fluxed momenta on
            // a polar grid, which drops the curvature terms from the true
            // polar Navier-Stokes equations. They must be added explicitly:
            //   dv_r / dt   += +v_φ² / r       (centrifugal support)
            //   dv_φ / dt   += -v_r·v_φ / r    (radial-azimuthal coupling)
            // Without these, a Keplerian disc has no centrifugal support
            // and the gas free-falls toward the star within an orbit.
            let a_r_geom   =  vphi[k] * vphi[k] * inv_r;
            let a_phi_geom = -vr[k]   * vphi[k] * inv_r;

            // Star gravity.
            let a_r_grav = -gm_star * inv_r * inv_r;
            let mut a_x = 0.0;
            let mut a_y = 0.0;

            // Planet gravity (direct + indirect on the star ignored for now).
            for p in planets {
                let dx = p.x - cx;
                let dy = p.y - cy;
                let r2 = dx*dx + dy*dy + p.eps*p.eps;
                let inv_r3 = 1.0 / (r2 * r2.sqrt());
                a_x += p.gm * dx * inv_r3;
                a_y += p.gm * dy * inv_r3;
            }
            // Project planet Cartesian acceleration onto (r̂, φ̂).
            let cp = phi.cos();
            let sp = phi.sin();
            let a_r_pl   =  a_x * cp + a_y * sp;
            let a_phi_pl = -a_x * sp + a_y * cp;

            vr[k]   += dt * (a_r_press   + a_r_grav   + a_r_pl   + a_r_geom);
            vphi[k] += dt * (a_phi_press                + a_phi_pl + a_phi_geom);
        }
    }
}

/// Wave-killing zones near r_in and r_out: linearly damp ρ, v_r, (v_φ - v_φ,Kep)
/// back to the azimuthally averaged reference, with a damping rate that
/// scales like the local orbital frequency. Removes spurious reflections
/// from the radial boundaries without artificially "freezing" the disc.
pub fn damp_boundaries(g: &Grid,
                       sigma: &mut [f64], vr: &mut [f64], vphi: &mut [f64],
                       sigma_ref: &[f64], dt: f64)
{
    // Damping zones: inner 5% and outer 5% of the radial extent.
    let frac = 0.05;
    let n_in  = ((g.nr as f64) * frac).max(1.0) as usize;
    let n_out = n_in;

    for i in 0..g.nr {
        let from_in  = i;
        let from_out = g.nr - 1 - i;
        // Damping weight: 1 at the boundary cell, 0 just outside the zone.
        let w_in  = if from_in  < n_in  {
            let t = 1.0 - (from_in  as f64) / (n_in as f64);
            t * t
        } else { 0.0 };
        let w_out = if from_out < n_out {
            let t = 1.0 - (from_out as f64) / (n_out as f64);
            t * t
        } else { 0.0 };
        let w = (w_in + w_out).min(1.0);
        if w <= 0.0 { continue; }

        // Damp toward the initial radial profile (constant in φ).
        let s_ref = sigma_ref[i];
        let vphi_ref = g.omega_k[i] * g.r[i];
        let rate = w * g.omega_k[i];          // s⁻¹
        let factor = (-rate * dt).exp();      // implicit-ish update
        let blend  = 1.0 - factor;

        for j in 0..g.nphi {
            let k = g.idx(i, j);
            sigma[k] = factor * sigma[k] + blend * s_ref;
            vr[k]    = factor * vr[k];                       // → 0
            vphi[k]  = factor * vphi[k] + blend * vphi_ref;
        }
    }
}
