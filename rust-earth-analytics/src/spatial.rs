//! Spatial index — grid-based hash for fast geospatial queries on Earth.
//!
//! Uses a simple lat/lon grid hash (10° cells → 36×18 = 648 buckets) for O(1)
//! spatial lookups.  This is far faster than the O(n) linear scans the JS code
//! currently uses for earthquake proximity queries and satellite visibility.
//!
//! ## Performance
//!   - Insert: O(1) per entity
//!   - Radius query: O(k) where k = entities in nearby cells
//!   - K-nearest: O(n log k) worst case, but grid pruning makes it fast
//!   - Batch distances: O(n) with SIMD-friendly inner loop

use std::f32::consts::PI;

const DEG: f32 = PI / 180.0;

/// Grid cell size in degrees.  10° gives 36×18 = 648 cells.
const CELL_SIZE: f32 = 10.0;
const GRID_W: usize = 36;   // 360 / 10
const GRID_H: usize = 18;   // 180 / 10

// ── Entity ──────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct GeoEntity {
    pub id: u32,
    pub lat: f32,
    pub lon: f32,
    pub depth: f32,       // km (depth for EQ, altitude for SAT)
    pub magnitude: f32,
    pub significance: f32,
    pub kind: u8,         // 0 = earthquake, 1 = satellite
}

// ── Spatial Index ───────────────────────────────────────────────────────────

pub struct SpatialIndex {
    /// Grid cells — each cell holds indices into `entities`.
    cells: Vec<Vec<usize>>,
    /// All entities, insertion-ordered.
    entities: Vec<GeoEntity>,
}

impl SpatialIndex {
    pub fn new() -> Self {
        Self {
            cells: vec![Vec::new(); GRID_W * GRID_H],
            entities: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.entities.len()
    }

    pub fn clear(&mut self) {
        for cell in &mut self.cells {
            cell.clear();
        }
        self.entities.clear();
    }

    pub fn insert(&mut self, entity: GeoEntity) {
        let idx = self.entities.len();
        let cell = Self::cell_index(entity.lat, entity.lon);
        self.cells[cell].push(idx);
        self.entities.push(entity);
    }

    /// Query all entities within `radius_deg` great-circle distance.
    pub fn query_radius(&self, lat: f32, lon: f32, radius_deg: f32) -> Vec<u32> {
        let mut results = Vec::new();

        // Determine which grid cells could contain matches
        let cell_margin = (radius_deg / CELL_SIZE).ceil() as i32 + 1;
        let cy = Self::lat_to_row(lat) as i32;
        let cx = Self::lon_to_col(lon) as i32;

        for dy in -cell_margin..=cell_margin {
            let row = cy + dy;
            if row < 0 || row >= GRID_H as i32 { continue; }
            for dx in -cell_margin..=cell_margin {
                let col = ((cx + dx) % GRID_W as i32 + GRID_W as i32) as usize % GRID_W;
                let cell_idx = row as usize * GRID_W + col;

                for &eidx in &self.cells[cell_idx] {
                    let e = &self.entities[eidx];
                    let dist = Self::haversine_deg(lat, lon, e.lat, e.lon);
                    if dist <= radius_deg {
                        results.push(e.id);
                    }
                }
            }
        }

        results
    }

    /// K-nearest neighbours query.  Returns flat [id, dist_deg, id, dist_deg, ...].
    pub fn query_k_nearest(&self, lat: f32, lon: f32, k: usize) -> Vec<f32> {
        // For K-NN we do expanding ring search through grid cells
        let mut heap: Vec<(f32, u32)> = Vec::with_capacity(k + 1);

        // Start with nearby cells, expand if needed
        let max_radius = 180.0_f32; // worst case: entire globe
        let mut search_radius = CELL_SIZE * 2.0;

        while search_radius <= max_radius {
            heap.clear();
            let cell_margin = (search_radius / CELL_SIZE).ceil() as i32 + 1;
            let cy = Self::lat_to_row(lat) as i32;
            let cx = Self::lon_to_col(lon) as i32;

            for dy in -cell_margin..=cell_margin {
                let row = cy + dy;
                if row < 0 || row >= GRID_H as i32 { continue; }
                for dx in -cell_margin..=cell_margin {
                    let col = ((cx + dx) % GRID_W as i32 + GRID_W as i32) as usize % GRID_W;
                    let cell_idx = row as usize * GRID_W + col;

                    for &eidx in &self.cells[cell_idx] {
                        let e = &self.entities[eidx];
                        let dist = Self::haversine_deg(lat, lon, e.lat, e.lon);

                        if heap.len() < k {
                            heap.push((dist, e.id));
                            if heap.len() == k {
                                heap.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
                            }
                        } else if dist < heap[k - 1].0 {
                            heap[k - 1] = (dist, e.id);
                            heap.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
                        }
                    }
                }
            }

            if heap.len() >= k { break; }
            search_radius *= 2.0;
        }

        heap.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let mut result = Vec::with_capacity(heap.len() * 2);
        for (dist, id) in &heap {
            result.push(*id as f32);
            result.push(*dist);
        }
        result
    }

    /// Compute great-circle distance from (lat, lon) to every entity.
    /// Returns distances in degrees, same order as insertion.
    pub fn batch_distances(&self, lat: f32, lon: f32) -> Vec<f32> {
        self.entities.iter()
            .map(|e| Self::haversine_deg(lat, lon, e.lat, e.lon))
            .collect()
    }

    // ── Internal helpers ────────────────────────────────────────────────────

    fn cell_index(lat: f32, lon: f32) -> usize {
        let row = Self::lat_to_row(lat);
        let col = Self::lon_to_col(lon);
        row * GRID_W + col
    }

    fn lat_to_row(lat: f32) -> usize {
        let row = ((lat + 90.0) / CELL_SIZE) as usize;
        row.min(GRID_H - 1)
    }

    fn lon_to_col(lon: f32) -> usize {
        let col = ((lon + 180.0) / CELL_SIZE) as usize;
        col.min(GRID_W - 1)
    }

    /// Haversine great-circle distance in degrees.
    #[inline]
    fn haversine_deg(lat1: f32, lon1: f32, lat2: f32, lon2: f32) -> f32 {
        let dlat = (lat2 - lat1) * DEG;
        let dlon = (lon2 - lon1) * DEG;
        let lat1_r = lat1 * DEG;
        let lat2_r = lat2 * DEG;

        let a = (dlat * 0.5).sin().powi(2)
            + lat1_r.cos() * lat2_r.cos() * (dlon * 0.5).sin().powi(2);
        let c = 2.0 * a.sqrt().asin();

        c / DEG // convert back to degrees
    }
}
