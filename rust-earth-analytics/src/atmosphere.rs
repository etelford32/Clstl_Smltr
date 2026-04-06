//! Atmosphere analytics system — pressure grid processing, isobar extraction,
//! gradient statistics, and pressure-centre detection.
//!
//! This is the heaviest compute workload in the Earth view:
//!   - 360×180 grid decode + box blur (3 passes)
//!   - Marching squares for 25 isobar levels × 359×179 cells = ~1.6M cell checks
//!   - Chain assembly via hash-map adjacency
//!   - Catmull-Rom smoothing on all chains
//!   - Pressure gradient with latitude-correct km scaling
//!   - Pressure-centre extrema detection with NMS
//!
//! In JS this takes 15–40ms.  In Rust/WASM we target <3ms.

use std::collections::HashMap;
use std::f32::consts::PI;

// ── Grid constants ──────────────────────────────────────────────────────────

const W: usize = 360;
const H: usize = 180;
const GRID_SIZE: usize = W * H;
const DEG: f32 = PI / 180.0;

/// Sphere radius for 3D projection (matches Three.js earthMesh radius).
const R: f32 = 1.0;
/// Slight offset above surface for isobar lines.
const R_OFFSET: f32 = 1.0025;

// ── Isobar levels ───────────────────────────────────────────────────────────

/// 4 hPa spacing, standard synoptic meteorology: 960, 964, ..., 1056 (25 levels)
const ISOBAR_MIN: f32 = 960.0;
const ISOBAR_MAX: f32 = 1056.0;
const ISOBAR_STEP: f32 = 4.0;

fn isobar_levels() -> Vec<f32> {
    let mut levels = Vec::with_capacity(25);
    let mut p = ISOBAR_MIN;
    while p <= ISOBAR_MAX + 0.001 {
        levels.push(p);
        p += ISOBAR_STEP;
    }
    levels
}

// ── Geophysical constants ───────────────────────────────────────────────────

const OMEGA: f32 = 7.2921e-5;   // rad/s Earth angular velocity
const RHO: f32 = 1.225;         // kg/m³ ISA sea-level air density
const KM_PER_DEG_LAT: f32 = 111.0;

// ── Colour ramp ─────────────────────────────────────────────────────────────

/// Meteorological pressure colour stops: (hPa, r, g, b)
const COLOR_STOPS: [(f32, f32, f32, f32); 9] = [
    (940.0,  0.50, 0.00, 0.75),
    (960.0,  0.15, 0.10, 0.90),
    (976.0,  0.05, 0.38, 0.92),
    (992.0,  0.00, 0.68, 0.88),
    (1004.0, 0.30, 0.84, 0.92),
    (1013.0, 0.95, 0.95, 0.95),
    (1020.0, 1.00, 0.92, 0.10),
    (1030.0, 1.00, 0.52, 0.05),
    (1044.0, 0.85, 0.08, 0.08),
];

fn pressure_to_rgb(hpa: f32) -> (f32, f32, f32) {
    let first = COLOR_STOPS[0];
    let last = COLOR_STOPS[COLOR_STOPS.len() - 1];
    if hpa <= first.0 { return (first.1, first.2, first.3); }
    if hpa >= last.0 { return (last.1, last.2, last.3); }
    for i in 0..COLOR_STOPS.len() - 1 {
        let (p0, r0, g0, b0) = COLOR_STOPS[i];
        let (p1, r1, g1, b1) = COLOR_STOPS[i + 1];
        if hpa >= p0 && hpa <= p1 {
            let t = (hpa - p0) / (p1 - p0);
            return (
                r0 + (r1 - r0) * t,
                g0 + (g1 - g0) * t,
                b0 + (b1 - b0) * t,
            );
        }
    }
    (1.0, 1.0, 1.0)
}

fn level_opacity(hpa: f32) -> f32 {
    let h = hpa as i32;
    if h % 20 == 0 { 1.0 }
    else if h % 8 == 0 { 0.72 }
    else { 0.40 }
}

// ── Marching squares table ──────────────────────────────────────────────────

/// Each entry: list of (edge_a, edge_b) segment pairs.
/// Edges: 0=S, 1=E, 2=N, 3=W
const MS_TABLE: [&[(u8, u8)]; 16] = [
    &[],                    // 0000
    &[(3, 0)],              // 0001 BL
    &[(0, 1)],              // 0010 BR
    &[(3, 1)],              // 0011 BL+BR
    &[(1, 2)],              // 0100 TR
    &[(3, 2), (0, 1)],     // 0101 BL+TR saddle
    &[(0, 2)],              // 0110 BR+TR
    &[(3, 2)],              // 0111 BL+BR+TR
    &[(2, 3)],              // 1000 TL
    &[(2, 0)],              // 1001 TL+BL
    &[(2, 1), (3, 0)],     // 1010 TL+BR saddle
    &[(2, 1)],              // 1011 TL+BL+BR
    &[(1, 3)],              // 1100 TL+TR
    &[(0, 1)],              // 1101 complement of 0010
    &[(3, 0)],              // 1110 complement of 0001
    &[],                    // 1111
];

// ── Component: AtmosphereState ──────────────────────────────────────────────

pub struct GradientStats {
    pub max_grad: f32,
    pub max_lat: f32,
    pub max_lon: f32,
    pub geo_wind_ms: f32,
}

impl Default for GradientStats {
    fn default() -> Self {
        Self { max_grad: 0.0, max_lat: 0.0, max_lon: 0.0, geo_wind_ms: 0.0 }
    }
}

/// Component store for atmosphere analytics.
pub struct AtmosphereState {
    /// Decoded pressure grid (hPa), 360×180.
    pressure_grid: Vec<f32>,
    /// Isobar line segment positions (flat: x,y,z,x,y,z,...).
    pub isobar_positions: Vec<f32>,
    /// Per-vertex RGB colours (flat: r,g,b,r,g,b,...).
    pub isobar_colors: Vec<f32>,
    /// Pressure centres: [type(+1/-1), lat, lon, hPa, ...].
    pub pressure_centres: Vec<f32>,
    /// Gradient statistics.
    pub gradient_stats: GradientStats,
}

impl AtmosphereState {
    pub fn new() -> Self {
        Self {
            pressure_grid: vec![1013.0; GRID_SIZE],
            isobar_positions: Vec::new(),
            isobar_colors: Vec::new(),
            pressure_centres: Vec::new(),
            gradient_stats: GradientStats::default(),
        }
    }
}

// ── System: AtmosphereSystem ────────────────────────────────────────────────

pub struct AtmosphereSystem;

impl AtmosphereSystem {
    /// Full atmosphere analytics pipeline.
    pub fn update(state: &mut AtmosphereState, weather_buf: &[f32]) {
        // 1. Decode pressure from RGBA G-channel
        Self::decode_pressure(state, weather_buf);

        // 2. Gradient statistics (on raw grid)
        Self::compute_gradient_stats(state);

        // 3. Isobar extraction: marching squares + chains + smoothing
        Self::extract_isobars(state);

        // 4. Pressure-centre detection
        Self::find_pressure_centres(state);
    }

    // ── Step 1: Decode ──────────────────────────────────────────────────────

    fn decode_pressure(state: &mut AtmosphereState, buf: &[f32]) {
        let grid = &mut state.pressure_grid;
        // G-channel at index 1 of each RGBA quad: pressure = G * 210 + 850
        let len = GRID_SIZE.min(buf.len() / 4);
        for k in 0..len {
            grid[k] = buf[k * 4 + 1] * 210.0 + 850.0;
        }
    }

    // ── Step 2: Gradient statistics ─────────────────────────────────────────

    fn compute_gradient_stats(state: &mut AtmosphereState) {
        let grid = &state.pressure_grid;
        let mut max_grad: f32 = 0.0;
        let mut max_lat: f32 = 0.0;
        let mut max_lon: f32 = 0.0;

        for y in 1..H - 1 {
            let lat = (y as f32 / H as f32) * 180.0 - 90.0;
            let cos_lat = (lat * DEG).cos().max(0.01);
            let dx_km = cos_lat * 111.32;
            let dy_km = KM_PER_DEG_LAT;

            let row = y * W;
            let row_above = (y + 1) * W;
            let row_below = (y - 1) * W;

            for x in 1..W - 1 {
                let xm = if x == 0 { W - 1 } else { x - 1 };
                let xp = if x == W - 1 { 0 } else { x + 1 };

                let dp_dx = (grid[row + xp] - grid[row + xm]) / (2.0 * dx_km / 100.0);
                let dp_dy = (grid[row_above + x] - grid[row_below + x]) / (2.0 * dy_km / 100.0);
                let grad = (dp_dx * dp_dx + dp_dy * dp_dy).sqrt();

                if grad > max_grad {
                    max_grad = grad;
                    max_lat = lat;
                    max_lon = (x as f32 / W as f32) * 360.0 - 180.0;
                }
            }
        }

        // Geostrophic wind estimate
        let f = 2.0 * OMEGA * (max_lat * DEG).sin().abs();
        let geo_wind = if f > 1.4e-5 {
            let grad_pa_m = max_grad * 1e-3; // hPa/100km → Pa/m
            grad_pa_m / (f * RHO)
        } else {
            0.0 // near equator, geostrophy breaks down
        };

        state.gradient_stats = GradientStats {
            max_grad,
            max_lat,
            max_lon,
            geo_wind_ms: geo_wind,
        };
    }

    // ── Step 3: Isobar extraction ───────────────────────────────────────────

    fn extract_isobars(state: &mut AtmosphereState) {
        let grid = &state.pressure_grid;
        let levels = isobar_levels();

        // Pre-allocate with typical capacity to avoid reallocation
        let mut positions = Vec::with_capacity(100_000);
        let mut colors = Vec::with_capacity(100_000);

        for &level in &levels {
            let (r, g, b) = pressure_to_rgb(level);
            let alpha = level_opacity(level);
            let cr = r * alpha;
            let cg = g * alpha;
            let cb = b * alpha;

            let smooth_steps = if (level as i32) % 20 == 0 { 3u8 }
                else if (level as i32) % 8 == 0 { 2 }
                else { 1 };

            // Marching squares
            let segs = Self::marching_squares(grid, level);

            // Chain assembly
            let chains = Self::assemble_chains(&segs);

            // Smooth and project each chain
            for chain in &chains {
                if chain.len() < 3 { continue; }
                let smooth = Self::catmull_rom(chain, smooth_steps);

                for i in 0..smooth.len() - 1 {
                    let (x0, y0, z0) = Self::grid_to_sphere(smooth[i].0, smooth[i].1);
                    let (x1, y1, z1) = Self::grid_to_sphere(smooth[i + 1].0, smooth[i + 1].1);

                    // Skip antimeridian artefacts
                    let dx = x1 - x0;
                    let dy = y1 - y0;
                    let dz = z1 - z0;
                    if dx * dx + dy * dy + dz * dz > 0.09 { continue; } // 0.30²

                    positions.extend_from_slice(&[x0, y0, z0, x1, y1, z1]);
                    colors.extend_from_slice(&[cr, cg, cb, cr, cg, cb]);
                }
            }
        }

        state.isobar_positions = positions;
        state.isobar_colors = colors;
    }

    /// Marching squares on the 359×179 cell grid.
    fn marching_squares(grid: &[f32], level: f32) -> Vec<((f32, f32), (f32, f32))> {
        let mut segs = Vec::with_capacity(2000);

        for cy in 0..H - 1 {
            let row0 = cy * W;
            let row1 = (cy + 1) * W;
            for cx in 0..W - 1 {
                let v_bl = grid[row0 + cx];
                let v_br = grid[row0 + cx + 1];
                let v_tr = grid[row1 + cx + 1];
                let v_tl = grid[row1 + cx];

                let cas = ((v_bl > level) as usize)
                    | (((v_br > level) as usize) << 1)
                    | (((v_tr > level) as usize) << 2)
                    | (((v_tl > level) as usize) << 3);

                for &(ea, eb) in MS_TABLE[cas] {
                    let pa = Self::edge_point(ea, cx, cy, v_bl, v_br, v_tr, v_tl, level);
                    let pb = Self::edge_point(eb, cx, cy, v_bl, v_br, v_tr, v_tl, level);
                    segs.push((pa, pb));
                }
            }
        }

        segs
    }

    #[inline(always)]
    fn lerp01(level: f32, v0: f32, v1: f32) -> f32 {
        let dv = v1 - v0;
        if dv.abs() < 1e-4 { return 0.5; }
        ((level - v0) / dv).clamp(0.0, 1.0)
    }

    #[inline(always)]
    fn edge_point(e: u8, cx: usize, cy: usize, v_bl: f32, v_br: f32, v_tr: f32, v_tl: f32, level: f32) -> (f32, f32) {
        let cx = cx as f32;
        let cy = cy as f32;
        match e {
            0 => { let t = Self::lerp01(level, v_bl, v_br); (cx + t, cy) }
            1 => { let t = Self::lerp01(level, v_br, v_tr); (cx + 1.0, cy + t) }
            2 => { let t = Self::lerp01(level, v_tr, v_tl); (cx + 1.0 - t, cy + 1.0) }
            3 => { let t = Self::lerp01(level, v_tl, v_bl); (cx, cy + 1.0 - t) }
            _ => (cx, cy),
        }
    }

    /// Assemble disconnected segments into continuous polyline chains.
    fn assemble_chains(segs: &[((f32, f32), (f32, f32))]) -> Vec<Vec<(f32, f32)>> {
        if segs.is_empty() { return Vec::new(); }

        // Build adjacency: quantized endpoint → segment indices
        let mut adj: HashMap<(i32, i32), Vec<usize>> = HashMap::with_capacity(segs.len() * 2);
        for (i, &(a, b)) in segs.iter().enumerate() {
            let ka = Self::pt_key(a);
            let kb = Self::pt_key(b);
            adj.entry(ka).or_default().push(i);
            adj.entry(kb).or_default().push(i);
        }

        let mut used = vec![false; segs.len()];
        let mut chains = Vec::new();

        for start in 0..segs.len() {
            if used[start] { continue; }
            used[start] = true;

            let mut chain = vec![segs[start].0, segs[start].1];

            // Walk forward from tail
            for _ in 0..segs.len() {
                let tail = *chain.last().unwrap();
                let k = Self::pt_key(tail);
                let mut moved = false;
                if let Some(neighbours) = adj.get(&k) {
                    for &si in neighbours {
                        if used[si] { continue; }
                        used[si] = true;
                        let (a, b) = segs[si];
                        chain.push(if Self::pt_key(a) == k { b } else { a });
                        moved = true;
                        break;
                    }
                }
                if !moved { break; }
            }

            // Walk backward from head
            for _ in 0..segs.len() {
                let head = chain[0];
                let k = Self::pt_key(head);
                let mut moved = false;
                if let Some(neighbours) = adj.get(&k) {
                    for &si in neighbours {
                        if used[si] { continue; }
                        used[si] = true;
                        let (a, b) = segs[si];
                        chain.insert(0, if Self::pt_key(b) == k { a } else { b });
                        moved = true;
                        break;
                    }
                }
                if !moved { break; }
            }

            if chain.len() >= 3 {
                chains.push(chain);
            }
        }

        chains
    }

    /// Quantize point to integer key (3 decimal places).
    #[inline(always)]
    fn pt_key(p: (f32, f32)) -> (i32, i32) {
        ((p.0 * 1000.0).round() as i32, (p.1 * 1000.0).round() as i32)
    }

    /// Catmull-Rom spline smoothing.
    fn catmull_rom(pts: &[(f32, f32)], steps: u8) -> Vec<(f32, f32)> {
        if steps == 0 || pts.len() < 2 { return pts.to_vec(); }
        let n = pts.len();
        let mut out = Vec::with_capacity(n * (steps as usize + 1));
        out.push(pts[0]);

        for i in 0..n - 1 {
            let p0 = pts[if i == 0 { 0 } else { i - 1 }];
            let p1 = pts[i];
            let p2 = pts[i + 1];
            let p3 = pts[if i + 2 >= n { n - 1 } else { i + 2 }];

            for s in 1..=steps {
                let t = s as f32 / steps as f32;
                let t2 = t * t;
                let t3 = t2 * t;

                let lx = 0.5 * (2.0 * p1.0
                    + (-p0.0 + p2.0) * t
                    + (2.0 * p0.0 - 5.0 * p1.0 + 4.0 * p2.0 - p3.0) * t2
                    + (-p0.0 + 3.0 * p1.0 - 3.0 * p2.0 + p3.0) * t3);

                let ly = 0.5 * (2.0 * p1.1
                    + (-p0.1 + p2.1) * t
                    + (2.0 * p0.1 - 5.0 * p1.1 + 4.0 * p2.1 - p3.1) * t2
                    + (-p0.1 + 3.0 * p1.1 - 3.0 * p2.1 + p3.1) * t3);

                out.push((lx, ly));
            }
        }

        out
    }

    /// Convert grid coordinates to 3D sphere point.
    #[inline(always)]
    fn grid_to_sphere(lx: f32, ly: f32) -> (f32, f32, f32) {
        let lat = (ly / H as f32) * 180.0 - 90.0;
        let lon = (lx / W as f32) * 360.0 - 180.0;
        let phi = lat * DEG;
        let lam = lon * DEG;
        let r = R * R_OFFSET;
        (
            r * phi.cos() * lam.sin(),
            r * phi.sin(),
            r * phi.cos() * lam.cos(),
        )
    }

    // ── Step 4: Pressure-centre detection ───────────────────────────────────

    fn find_pressure_centres(state: &mut AtmosphereState) {
        // Box blur the grid (3 passes) for extrema detection
        let blurred = Self::box_blur(&state.pressure_grid, 3);

        // Find local extrema
        let raw = Self::find_extrema(&blurred);

        // Non-maximum suppression
        let kept = Self::nms_extrema(&raw, 22.0, 10);

        // Pack into flat array: [type, lat, lon, hPa, ...]
        let mut centres = Vec::with_capacity(kept.len() * 4);
        for e in &kept {
            centres.push(if e.is_high { 1.0 } else { -1.0 });
            centres.push((e.y as f32 / H as f32) * 180.0 - 90.0);
            centres.push((e.x as f32 / W as f32) * 360.0 - 180.0);
            centres.push(e.hpa);
        }
        state.pressure_centres = centres;
    }

    /// 3×3 box blur with longitudinal wrap.
    fn box_blur(grid: &[f32], passes: usize) -> Vec<f32> {
        let mut src = grid.to_vec();
        let mut tmp = vec![0.0f32; GRID_SIZE];

        for _ in 0..passes {
            for y in 0..H {
                for x in 0..W {
                    let mut s = 0.0f32;
                    let mut n = 0u32;
                    for dy in -1i32..=1 {
                        let ny = y as i32 + dy;
                        if ny < 0 || ny >= H as i32 { continue; }
                        for dx in -1i32..=1 {
                            let nx = ((x as i32 + dx) % W as i32 + W as i32) as usize % W;
                            s += src[ny as usize * W + nx];
                            n += 1;
                        }
                    }
                    tmp[y * W + x] = s / n as f32;
                }
            }
            src.copy_from_slice(&tmp);
        }

        src
    }

    fn find_extrema(smooth: &[f32]) -> Vec<Extremum> {
        const WIN: i32 = 5;
        const LOW_THRESH: f32 = 1006.0;
        const HIGH_THRESH: f32 = 1018.0;

        let mut extrema = Vec::new();

        for y in WIN as usize..H - WIN as usize {
            for x in WIN as usize..W - WIN as usize {
                let v = smooth[y * W + x];
                if v > LOW_THRESH && v < HIGH_THRESH { continue; }

                let mut is_max = v >= HIGH_THRESH;
                let mut is_min = v <= LOW_THRESH;

                'outer: for dy in -WIN..=WIN {
                    for dx in -WIN..=WIN {
                        if dx == 0 && dy == 0 { continue; }
                        let ny = (y as i32 + dy) as usize;
                        let nx = ((x as i32 + dx) % W as i32 + W as i32) as usize % W;
                        let n = smooth[ny * W + nx];
                        if n >= v { is_max = false; }
                        if n <= v { is_min = false; }
                        if !is_max && !is_min { break 'outer; }
                    }
                }

                if is_max {
                    extrema.push(Extremum { x, y, is_high: true, hpa: v });
                }
                if is_min {
                    extrema.push(Extremum { x, y, is_high: false, hpa: v });
                }
            }
        }

        extrema
    }

    fn nms_extrema(extrema: &[Extremum], min_dist: f32, max_keep: usize) -> Vec<Extremum> {
        let mut highs: Vec<&Extremum> = extrema.iter().filter(|e| e.is_high).collect();
        let mut lows: Vec<&Extremum> = extrema.iter().filter(|e| !e.is_high).collect();

        highs.sort_by(|a, b| b.hpa.partial_cmp(&a.hpa).unwrap());
        lows.sort_by(|a, b| a.hpa.partial_cmp(&b.hpa).unwrap());

        fn suppress(list: &[&Extremum], min_dist: f32, max_keep: usize) -> Vec<Extremum> {
            let mut kept = Vec::new();
            for e in list {
                let dominated = kept.iter().any(|k: &Extremum| {
                    let dx = k.x as f32 - e.x as f32;
                    let dy = k.y as f32 - e.y as f32;
                    (dx * dx + dy * dy).sqrt() < min_dist
                });
                if !dominated {
                    kept.push((*e).clone());
                    if kept.len() >= max_keep { break; }
                }
            }
            kept
        }

        let mut result = suppress(&highs, min_dist, max_keep);
        result.extend(suppress(&lows, min_dist, max_keep));
        result
    }
}

#[derive(Clone)]
struct Extremum {
    x: usize,
    y: usize,
    is_high: bool,
    hpa: f32,
}
