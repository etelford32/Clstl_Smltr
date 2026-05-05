//! Minimal 3D vector type. f32 throughout — visual fidelity, not science.

#[derive(Clone, Copy, Debug)]
pub struct V3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl V3 {
    pub const ZERO: V3 = V3 { x: 0.0, y: 0.0, z: 0.0 };

    #[inline] pub fn new(x: f32, y: f32, z: f32) -> V3 { V3 { x, y, z } }
    #[inline] pub fn add(a: V3, b: V3) -> V3 { V3::new(a.x + b.x, a.y + b.y, a.z + b.z) }
    #[inline] pub fn sub(a: V3, b: V3) -> V3 { V3::new(a.x - b.x, a.y - b.y, a.z - b.z) }
    #[inline] pub fn mul(a: V3, s: f32) -> V3 { V3::new(a.x * s, a.y * s, a.z * s) }
    #[inline] pub fn dot(a: V3, b: V3) -> f32 { a.x * b.x + a.y * b.y + a.z * b.z }
    #[inline] pub fn len(self) -> f32 { V3::dot(self, self).sqrt() }
    #[inline] pub fn norm(self) -> V3 {
        let l = self.len();
        if l > 1e-20 { V3::mul(self, 1.0 / l) } else { V3::ZERO }
    }

    /// Heliographic (lat, lon) on a sphere of radius `r` → Cartesian.
    /// Convention matches the consuming Three.js scene (sun.html):
    ///   • +y axis is the solar rotation axis (polar)
    ///   • lat=0, lon=0 lies on +z (the sub-Earth point at the central meridian)
    ///   • +lon increases westward in heliographic convention but here we use
    ///     a right-handed frame where +lon rotates from +z toward +x.
    #[inline]
    pub fn from_lat_lon(lat: f32, lon: f32, r: f32) -> V3 {
        let cl = lat.cos();
        V3::new(r * cl * lon.sin(), r * lat.sin(), r * cl * lon.cos())
    }
}
