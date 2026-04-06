//! ECS World — owns all component stores and drives system execution.
//!
//! The world is exposed to JavaScript via wasm-bindgen. JS calls methods on
//! the world to push new data (weather buffers, solar wind parameters) and
//! pull computed results (isobar vertices, magnetosphere geometry, spatial
//! query results).
//!
//! System execution order (each `tick`):
//!   1. AtmosphereSystem  — pressure decode → marching squares → gradient stats
//!   2. MagnetosphereSystem — Shue model → plasmapause → ring current → ionosphere
//!   3. SpatialSystem — spatial index rebuild (only when entities change)

use wasm_bindgen::prelude::*;
use js_sys::{Float32Array, Uint32Array};

use crate::atmosphere::{AtmosphereState, AtmosphereSystem};
use crate::magnetosphere::{MagnetosphereState, MagnetosphereSystem};
use crate::spatial::{SpatialIndex, GeoEntity};

// ─────────────────────────────────────────────────────────────────────────────
//  ECS World
// ─────────────────────────────────────────────────────────────────────────────

/// The top-level ECS world exposed to JavaScript.
///
/// Holds all component stores and system state.  Each analytic domain
/// (atmosphere, magnetosphere, spatial) can be updated independently — JS
/// only pays for what it uses.
#[wasm_bindgen]
pub struct EarthAnalyticsWorld {
    atmo: AtmosphereState,
    mag: MagnetosphereState,
    spatial: SpatialIndex,
    tick_count: u32,
}

#[wasm_bindgen]
impl EarthAnalyticsWorld {
    /// Create a new analytics world with default (quiet) initial conditions.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            atmo: AtmosphereState::new(),
            mag: MagnetosphereState::new(),
            spatial: SpatialIndex::new(),
            tick_count: 0,
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Atmosphere System — pressure grid analytics
    // ═════════════════════════════════════════════════════════════════════════

    /// Ingest a weather buffer (360 × 180 × 4 RGBA Float32) and compute all
    /// atmosphere analytics: pressure grid decode, isobar marching squares,
    /// chain assembly, Catmull-Rom smoothing, gradient statistics, and
    /// pressure-centre detection.
    ///
    /// Returns computation time in milliseconds.
    #[wasm_bindgen(js_name = "updateAtmosphere")]
    pub fn update_atmosphere(&mut self, weather_buf: &[f32]) -> f32 {
        let start = js_sys::Date::now();
        AtmosphereSystem::update(&mut self.atmo, weather_buf);
        (js_sys::Date::now() - start) as f32
    }

    /// Get the isobar line segment vertices as a flat Float32Array.
    /// Layout: [x0,y0,z0, x1,y1,z1, x2,y2,z2, x3,y3,z3, ...]
    /// Every 6 floats = one line segment (two endpoints on the unit sphere).
    #[wasm_bindgen(js_name = "getIsobarPositions")]
    pub fn get_isobar_positions(&self) -> Float32Array {
        let data = &self.atmo.isobar_positions;
        // SAFETY: we create a view into WASM linear memory — zero-copy
        unsafe { Float32Array::view(data) }
    }

    /// Get per-vertex RGB colours for the isobar segments.
    /// Same length as positions (3 floats per vertex, 2 vertices per segment).
    #[wasm_bindgen(js_name = "getIsobarColors")]
    pub fn get_isobar_colors(&self) -> Float32Array {
        let data = &self.atmo.isobar_colors;
        unsafe { Float32Array::view(data) }
    }

    /// Number of isobar line segments (positions.length / 6).
    #[wasm_bindgen(js_name = "getIsobarSegmentCount")]
    pub fn get_isobar_segment_count(&self) -> u32 {
        (self.atmo.isobar_positions.len() / 6) as u32
    }

    /// Get pressure-centre extrema as a flat array:
    /// [type, lat, lon, hPa, type, lat, lon, hPa, ...]
    /// where type: 1.0 = High, -1.0 = Low
    #[wasm_bindgen(js_name = "getPressureCentres")]
    pub fn get_pressure_centres(&self) -> Float32Array {
        let data = &self.atmo.pressure_centres;
        unsafe { Float32Array::view(data) }
    }

    /// Get gradient statistics: [maxGrad_hPa_100km, maxLat, maxLon, geoWindMs]
    #[wasm_bindgen(js_name = "getGradientStats")]
    pub fn get_gradient_stats(&self) -> Float32Array {
        let stats = &self.atmo.gradient_stats;
        let arr = [stats.max_grad, stats.max_lat, stats.max_lon, stats.geo_wind_ms];
        unsafe { Float32Array::view(&arr) }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Magnetosphere System — space weather physics
    // ═════════════════════════════════════════════════════════════════════════

    /// Update magnetosphere physics with current solar wind conditions.
    ///
    /// Parameters:
    ///   n   — solar wind proton density (n/cm³, typical 5)
    ///   v   — solar wind speed (km/s, typical 400)
    ///   bz  — IMF Bz GSM (nT, negative = southward)
    ///   kp  — planetary K-index (0–9)
    ///   f107 — F10.7 solar radio flux (sfu, 65–300)
    ///   xray — GOES X-ray flux (W/m², 1e-9 to 1e-2)
    ///   sza_deg — representative solar zenith angle (degrees)
    #[wasm_bindgen(js_name = "updateMagnetosphere")]
    pub fn update_magnetosphere(
        &mut self,
        n: f32, v: f32, bz: f32, kp: f32,
        f107: f32, xray: f32, sza_deg: f32,
    ) -> f32 {
        let start = js_sys::Date::now();
        MagnetosphereSystem::update(&mut self.mag, n, v, bz, kp, f107, xray, sza_deg);
        (js_sys::Date::now() - start) as f32
    }

    /// Get magnetosphere results as a flat array:
    /// [r0, alpha, pdyn, r0_bs, alpha_bs, lpp, dst, joule_gw,
    ///  d_layer_abs, fo_e, fo_f2, hm_f2, tec, e_layer_norm, f2_active, blackout]
    #[wasm_bindgen(js_name = "getMagnetosphereState")]
    pub fn get_magnetosphere_state(&self) -> Float32Array {
        let m = &self.mag;
        let arr = [
            m.r0, m.alpha, m.pdyn,
            m.r0_bs, m.alpha_bs,
            m.lpp, m.dst, m.joule_gw,
            m.iono.d_layer_abs, m.iono.fo_e, m.iono.fo_f2, m.iono.hm_f2,
            m.iono.tec, m.iono.e_layer_norm,
            if m.iono.f2_active { 1.0 } else { 0.0 },
            if m.iono.blackout { 1.0 } else { 0.0 },
        ];
        unsafe { Float32Array::view(&arr) }
    }

    /// Generate magnetopause surface vertices for a given number of angular samples.
    /// Returns [x,y,z, x,y,z, ...] on the Shue-model surface.
    #[wasm_bindgen(js_name = "getMagnetopauseSurface")]
    pub fn get_magnetopause_surface(&self, n_theta: u32, n_phi: u32) -> Float32Array {
        let verts = MagnetosphereSystem::generate_surface(
            self.mag.r0, self.mag.alpha, n_theta, n_phi,
        );
        unsafe { Float32Array::view(&verts) }
    }

    /// Generate bow shock surface vertices.
    #[wasm_bindgen(js_name = "getBowShockSurface")]
    pub fn get_bow_shock_surface(&self, n_theta: u32, n_phi: u32) -> Float32Array {
        let verts = MagnetosphereSystem::generate_surface(
            self.mag.r0_bs, self.mag.alpha_bs, n_theta, n_phi,
        );
        unsafe { Float32Array::view(&verts) }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Spatial System — fast geospatial queries
    // ═════════════════════════════════════════════════════════════════════════

    /// Clear and rebuild the spatial index with new earthquake data.
    /// Input: flat array [lat, lon, depth_km, magnitude, significance, ...]
    /// (5 floats per earthquake)
    #[wasm_bindgen(js_name = "loadEarthquakes")]
    pub fn load_earthquakes(&mut self, data: &[f32]) {
        self.spatial.clear();
        let chunk_size = 5;
        let mut id = 0u32;
        for chunk in data.chunks_exact(chunk_size) {
            self.spatial.insert(GeoEntity {
                id,
                lat: chunk[0],
                lon: chunk[1],
                depth: chunk[2],
                magnitude: chunk[3],
                significance: chunk[4],
                kind: 0, // earthquake
            });
            id += 1;
        }
    }

    /// Load satellite positions into the spatial index.
    /// Input: flat array [lat, lon, alt_km, norad_id, 0.0, ...]
    /// (5 floats per satellite — significance slot unused, set 0)
    #[wasm_bindgen(js_name = "loadSatellites")]
    pub fn load_satellites(&mut self, data: &[f32]) {
        // Don't clear — satellites are added alongside earthquakes
        let chunk_size = 5;
        for chunk in data.chunks_exact(chunk_size) {
            self.spatial.insert(GeoEntity {
                id: chunk[3] as u32,
                lat: chunk[0],
                lon: chunk[1],
                depth: chunk[2], // altitude for sats
                magnitude: 0.0,
                significance: 0.0,
                kind: 1, // satellite
            });
        }
    }

    /// Query all entities within `radius_deg` of (lat, lon).
    /// Returns flat array of matching entity IDs.
    #[wasm_bindgen(js_name = "queryRadius")]
    pub fn query_radius(&self, lat: f32, lon: f32, radius_deg: f32) -> Uint32Array {
        let ids = self.spatial.query_radius(lat, lon, radius_deg);
        unsafe { Uint32Array::view(&ids) }
    }

    /// Query the K nearest entities to (lat, lon).
    /// Returns flat array [id, dist_deg, id, dist_deg, ...] (2 floats per result).
    #[wasm_bindgen(js_name = "queryKNearest")]
    pub fn query_k_nearest(&self, lat: f32, lon: f32, k: u32) -> Float32Array {
        let results = self.spatial.query_k_nearest(lat, lon, k as usize);
        unsafe { Float32Array::view(&results) }
    }

    /// Batch distance computation: for each entity, compute great-circle
    /// distance to (lat, lon).  Returns distances in degrees, same order as loaded.
    #[wasm_bindgen(js_name = "batchDistances")]
    pub fn batch_distances(&self, lat: f32, lon: f32) -> Float32Array {
        let dists = self.spatial.batch_distances(lat, lon);
        unsafe { Float32Array::view(&dists) }
    }

    /// Get total entity count in spatial index.
    #[wasm_bindgen(js_name = "getSpatialCount")]
    pub fn get_spatial_count(&self) -> u32 {
        self.spatial.len() as u32
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Full tick — run all systems in order
    // ═════════════════════════════════════════════════════════════════════════

    /// Run a full analytics tick.  Call after pushing new data via the
    /// update_* methods.  Currently increments the tick counter; future
    /// expansion: time-dependent decay models, prediction stepping.
    #[wasm_bindgen]
    pub fn tick(&mut self) -> u32 {
        self.tick_count += 1;
        self.tick_count
    }
}
