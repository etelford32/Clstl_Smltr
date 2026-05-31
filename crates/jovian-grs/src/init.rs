//! Background-state construction: a zonally-uniform jet in discrete
//! gradient-wind balance, plus a geostrophically-balanced seed vortex.

use crate::grid::Grid;
use crate::model::Params;

/// Periodic signed separation `x - x0` wrapped into `(-lx/2, lx/2]`.
#[inline]
pub fn wrap_dx(mut d: f64, lx: f64) -> f64 {
    while d >  0.5 * lx { d -= lx; }
    while d <= -0.5 * lx { d += lx; }
    d
}

/// Solve for the per-row layer thickness `h_ref[j]` that puts the prescribed
/// zonal jet `u_ref` into *discrete* gradient-wind balance with `v = 0`, so
/// the background is a genuine steady state of the C-grid scheme (not just
/// the continuous geostrophic approximation, which would radiate gravity
/// waves on the first step). Fixed-point iteration; the mean is anchored to
/// `h0`.
pub fn balanced_h(g: &Grid, p: &Params, u_ref: &[f64]) -> Vec<f64> {
    let ny = g.ny;
    let dy = g.dy;
    let mut h = vec![p.h0; ny];
    for _ in 0..300 {
        let mut nh = h.clone();
        for jf in 1..ny {
            let (u_n, u_s) = (u_ref[jf], u_ref[jf - 1]);
            let zeta = -(u_n - u_s) / dy;                 // dv/dx = 0 for the mean
            let hc = 0.5 * (h[jf - 1] + h[jf]);
            let q = (g.f_f[jf] + zeta) / hc;
            let cor = q * 0.5 * (h[jf] * u_n + h[jf - 1] * u_s);
            let dke = 0.5 * (u_n * u_n - u_s * u_s);        // d(½u²)
            // gp·(h_n - h_s)/dy = -cor - dke/dy
            nh[jf] = nh[jf - 1] - (dy / p.gp) * cor - dke / p.gp;
        }
        let mean = nh.iter().sum::<f64>() / ny as f64;
        for x in nh.iter_mut() { *x += p.h0 - mean; }
        h = nh;
    }
    h
}

/// Parameters of a seed vortex (a Gaussian thickness anomaly + the matching
/// geostrophic circulation). `amp > 0` is a high (anticyclone); `amp < 0` a
/// low (cyclone). `x0`,`y0` are domain coordinates (metres, y from the
/// channel centre); `rx`,`ry` the e-folding radii.
#[derive(Clone, Copy)]
pub struct Vortex {
    pub x0: f64,
    pub y0: f64,
    pub amp: f64,
    pub rx: f64,
    pub ry: f64,
}

impl Vortex {
    /// Thickness anomaly at a domain point.
    #[inline]
    pub fn dh(&self, x: f64, y: f64, lx: f64) -> f64 {
        let dx = wrap_dx(x - self.x0, lx);
        let dy = y - self.y0;
        self.amp * (-(dx * dx / (2.0 * self.rx * self.rx)
                    + dy * dy / (2.0 * self.ry * self.ry))).exp()
    }
}

/// Stamp the vortex onto `(h,u,v)` in geostrophic balance with the local
/// Coriolis parameter. The velocity perturbation is `u' = -(g'/f)∂h'/∂y`,
/// `v' = +(g'/f)∂h'/∂x`, evaluated analytically at each staggered point.
pub fn seed_vortex(
    g: &Grid, p: &Params, vx: &Vortex,
    h: &mut [f64], u: &mut [f64], v: &mut [f64],
) {
    let (nx, ny) = (g.nx, g.ny);
    let lx = g.lx;
    let xc = |i: usize| (i as f64 + 0.5) * g.dx;          // centre x
    let xu = |i: usize| (i as f64 + 1.0) * g.dx;          // east-face x

    // thickness
    for j in 0..ny {
        let y = g.yc(j);
        for i in 0..nx {
            h[g.c(i, j)] += vx.dh(xc(i), y, lx);
        }
    }
    // u' on east faces (centre rows)
    for j in 0..ny {
        let y = g.yc(j);
        let f = g.f_c[j];
        for i in 0..nx {
            let x = xu(i);
            let dh = vx.dh(x, y, lx);
            // ∂h'/∂y = dh · (-(y-y0)/ry²)  →  u' = -(gp/f)∂h'/∂y
            let dhdy = dh * (-(y - vx.y0) / (vx.ry * vx.ry));
            u[g.c(i, j)] += -(p.gp / f) * dhdy;
        }
    }
    // v' on north faces (interior only; walls stay zero)
    for jf in 1..ny {
        let y = jf as f64 * g.dy - 0.5 * g.ly;
        let f = g.f_f[jf];
        for i in 0..nx {
            let x = xc(i);
            let dh = vx.dh(x, y, lx);
            let dxw = wrap_dx(x - vx.x0, lx);
            // ∂h'/∂x = dh · (-(x-x0)/rx²)  →  v' = +(gp/f)∂h'/∂x
            let dhdx = dh * (-dxw / (vx.rx * vx.rx));
            v[g.f(i, jf)] += (p.gp / f) * dhdx;
        }
    }
}
