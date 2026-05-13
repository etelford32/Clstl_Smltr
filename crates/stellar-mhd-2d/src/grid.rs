//! Uniform 2D Cartesian grid with ghost zones.
//!
//! Coordinates: `x` horizontal (along the photospheric base), `y` vertical
//! (radially outward from the star's surface). This matches the standard
//! "flare in a box" setup (e.g. Yokoyama & Shibata 1998).
//!
//! Layout is row-major over the *padded* grid (real + ghosts):
//!     index(i, j) = (j + NG) * stride_x + (i + NG)
//! where `i in 0..nx`, `j in 0..ny` index the real cells.

/// Number of ghost cells on each side. PLM reconstruction needs 2.
pub const NG: usize = 2;

#[derive(Clone, Copy, Debug)]
pub struct Grid {
    pub nx: usize,
    pub ny: usize,
    pub dx: f64,
    pub dy: f64,
    pub x0: f64,
    pub y0: f64,
}

impl Grid {
    pub fn new(nx: usize, ny: usize, lx: f64, ly: f64) -> Self {
        Self {
            nx,
            ny,
            dx: lx / nx as f64,
            dy: ly / ny as f64,
            x0: 0.0,
            y0: 0.0,
        }
    }

    /// Width of one padded row (real + 2*NG cells).
    #[inline]
    pub fn stride_x(&self) -> usize {
        self.nx + 2 * NG
    }

    /// Total padded cell count.
    #[inline]
    pub fn padded_len(&self) -> usize {
        (self.nx + 2 * NG) * (self.ny + 2 * NG)
    }

    /// Flat index for real cell `(i, j)`. `i in 0..nx`, `j in 0..ny`.
    #[inline]
    pub fn idx(&self, i: usize, j: usize) -> usize {
        (j + NG) * self.stride_x() + (i + NG)
    }

    /// Flat index for cell `(i, j)` in *padded* coordinates,
    /// `i in 0..nx+2*NG`, `j in 0..ny+2*NG`.
    #[inline]
    pub fn idx_padded(&self, i: usize, j: usize) -> usize {
        j * self.stride_x() + i
    }

    /// Cell-centre x for real cell `i`.
    #[inline]
    pub fn xc(&self, i: usize) -> f64 {
        self.x0 + (i as f64 + 0.5) * self.dx
    }

    /// Cell-centre y for real cell `j`.
    #[inline]
    pub fn yc(&self, j: usize) -> f64 {
        self.y0 + (j as f64 + 0.5) * self.dy
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idx_round_trips() {
        let g = Grid::new(8, 4, 1.0, 0.5);
        assert_eq!(g.idx(0, 0), NG * g.stride_x() + NG);
        assert_eq!(g.idx(7, 3), (3 + NG) * g.stride_x() + (7 + NG));
        assert_eq!(g.padded_len(), (8 + 2 * NG) * (4 + 2 * NG));
    }

    #[test]
    fn cell_centres() {
        let g = Grid::new(4, 4, 1.0, 1.0);
        assert!((g.xc(0) - 0.125).abs() < 1e-12);
        assert!((g.xc(3) - 0.875).abs() < 1e-12);
    }
}
