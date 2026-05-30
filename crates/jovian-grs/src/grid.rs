//! Arakawa C-grid geometry for the beta-plane channel.
//!
//! Staggering (one cell, indices `i` east, `j` north):
//!
//! ```text
//!            v(i,j+1)                 v at north/south CELL FACES
//!     +--------x--------+             h at CELL CENTRES
//!     |                 |             u at east/west CELL FACES
//!  u(i-1,j)   h(i,j)  u(i,j)          q (potential vorticity) at CORNERS
//!     |                 |
//!     +--------x--------+
//!            v(i,j)
//! ```
//!
//! * x (longitude) is **periodic**:  `ip1 = (i+1)%nx`, `im1 = (i+nx-1)%nx`.
//! * y (latitude) is a **walled channel**: `v = 0` on the south face `jf=0`
//!   and the north face `jf=ny` (free-slip for `u`, no normal mass flux).
//!
//! Array layouts (all flat, row-major `idx = j*nx + i`):
//!   * centres / u-points : `nx * ny`        (`u(i,j)` sits on the east face of cell `i`)
//!   * v-points / corners : `nx * (ny+1)`    (face index `jf` in `0..=ny`)

/// Static geometry + the beta-plane Coriolis arrays, precomputed once.
#[derive(Clone)]
pub struct Grid {
    pub nx: usize,
    pub ny: usize,
    pub dx: f64,
    pub dy: f64,
    pub lx: f64,
    pub ly: f64,
    /// Coriolis parameter at centre rows (length `ny`), `f = f0 + beta*y_c`.
    pub f_c: Vec<f64>,
    /// Coriolis parameter at faces/corners (length `ny+1`), `f = f0 + beta*y_f`.
    pub f_f: Vec<f64>,
}

impl Grid {
    /// `lx`,`ly` are the domain extents (metres); the channel is centred on
    /// `y = 0`, so the centre latitude maps to the middle of the domain.
    pub fn new(nx: usize, ny: usize, lx: f64, ly: f64, f0: f64, beta: f64) -> Self {
        let dx = lx / nx as f64;
        let dy = ly / ny as f64;
        let mut f_c = vec![0.0; ny];
        for j in 0..ny {
            let yc = (j as f64 + 0.5) * dy - 0.5 * ly;
            f_c[j] = f0 + beta * yc;
        }
        let mut f_f = vec![0.0; ny + 1];
        for jf in 0..=ny {
            let yf = jf as f64 * dy - 0.5 * ly;
            f_f[jf] = f0 + beta * yf;
        }
        Self { nx, ny, dx, dy, lx, ly, f_c, f_f }
    }

    #[inline] pub fn nc(&self) -> usize { self.nx * self.ny }
    #[inline] pub fn nf(&self) -> usize { self.nx * (self.ny + 1) }

    /// Centre / u-point linear index.
    #[inline] pub fn c(&self, i: usize, j: usize) -> usize { j * self.nx + i }
    /// v-point / corner linear index (face row `jf` in `0..=ny`).
    #[inline] pub fn f(&self, i: usize, jf: usize) -> usize { jf * self.nx + i }

    #[inline] pub fn ip1(&self, i: usize) -> usize { if i + 1 == self.nx { 0 } else { i + 1 } }
    #[inline] pub fn im1(&self, i: usize) -> usize { if i == 0 { self.nx - 1 } else { i - 1 } }

    /// Latitude-direction coordinate (metres) of centre row `j`.
    #[inline] pub fn yc(&self, j: usize) -> f64 { (j as f64 + 0.5) * self.dy - 0.5 * self.ly }
}
