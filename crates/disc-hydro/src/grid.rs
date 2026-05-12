//! Log-polar 2-D grid for the FARGO kernel.
//!
//! Cells are stored row-major in the order `idx = i * nphi + j`, where `i`
//! indexes the radial direction (outer = larger `i`) and `j` the azimuthal
//! direction (counter-clockwise). The grid is periodic in φ and has fixed
//! outer / outflow inner boundaries — those are applied in `source.rs`.

pub struct Grid {
    pub nr:    usize,
    pub nphi:  usize,
    pub r_min: f64,
    pub r_max: f64,
    /// Cell-centre radii, length `nr`.
    pub r:     Vec<f64>,
    /// Outer face radii, length `nr + 1` (face `i` separates cell `i-1` and `i`).
    pub rf:    Vec<f64>,
    /// Radial cell width `rf[i+1] - rf[i]`, length `nr`.
    pub dr:    Vec<f64>,
    /// Azimuthal step, uniform.
    pub dphi:  f64,
    /// Sound speed at each radius (locally isothermal EOS).
    pub cs:    Vec<f64>,
    /// Keplerian angular speed at each radius (used for the FARGO shift seed).
    pub omega_k: Vec<f64>,
}

impl Grid {
    pub fn new_log(nr: usize, nphi: usize, r_min: f64, r_max: f64,
                   gm_star: f64, cs_at_r0: f64, cs_slope: f64) -> Self
    {
        // Geometric (log) spacing in r so that cell aspect ratio r·dφ / dr is
        // roughly constant — this is what FARGO codes use because it keeps
        // numerical viscosity uniform with radius.
        let ln_lo = r_min.ln();
        let ln_hi = r_max.ln();
        let mut rf = Vec::with_capacity(nr + 1);
        for k in 0..=nr {
            let t = (k as f64) / (nr as f64);
            rf.push((ln_lo + t * (ln_hi - ln_lo)).exp());
        }
        let mut r  = Vec::with_capacity(nr);
        let mut dr = Vec::with_capacity(nr);
        for i in 0..nr {
            // Geometric centre keeps annulus mass = Σ * π (rf[i+1]² - rf[i]²)
            // evenly sampled.
            r.push((rf[i] * rf[i+1]).sqrt());
            dr.push(rf[i+1] - rf[i]);
        }
        let dphi = (2.0 * core::f64::consts::PI) / (nphi as f64);

        // Locally isothermal: c_s(r) = c_s,0 · (r / r_min)^cs_slope.
        // Default slope -0.25 reproduces H/r ∝ r^{1/4} (passive irradiated disc).
        let mut cs = Vec::with_capacity(nr);
        let mut omega_k = Vec::with_capacity(nr);
        for i in 0..nr {
            let ratio = r[i] / r_min;
            cs.push(cs_at_r0 * ratio.powf(cs_slope));
            omega_k.push((gm_star / (r[i] * r[i] * r[i])).sqrt());
        }

        Self { nr, nphi, r_min, r_max, r, rf, dr, dphi, cs, omega_k }
    }

    #[inline]
    pub fn n_cells(&self) -> usize { self.nr * self.nphi }

    #[inline]
    pub fn idx(&self, i: usize, j: usize) -> usize { i * self.nphi + j }
}
