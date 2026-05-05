//! Solar field-line tracer (PFSS-lite) → WebAssembly.
//!
//! Pipeline (one call per AR-list update from sun.html):
//!   1. Build a magnetic field model from active regions and coronal holes.
//!      Each AR contributes 1 buried dipole (β-class default), with an
//!      additional opposite-polarity dipole for complexity ≥ 2 (β-γ-δ
//!      "delta-spot" proxy). Joy's-law tilt orients each moment in the
//!      local tangent plane. Holes contribute monopole sources, and the
//!      net global flux is balanced to zero.
//!   2. Generate seeds: arcade seeds around each AR, a global Fibonacci
//!      grid for quiet-sun coverage, and PIL (Br = 0) seeds along each
//!      AR's polarity-inversion line — these become the prominence anchors.
//!   3. Trace each seed bidirectionally with RK4 until it hits the
//!      photosphere (closed loop) or the source surface (open field).
//!   4. Resample every line to a fixed sample count (uniform arclength)
//!      and pack the result into Float32Array buffers ready for direct
//!      upload as Three.js DataTextures.
//!
//! Source-surface radius is exposed as a parameter so sun.html can wire
//! it to a UI knob (1.5..3.5 R☉ is a sensible range; standard PFSS = 2.5).

mod vec3;
mod field;
mod trace;
mod seed;
mod pil;

use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::field::{build_field, Ar, Hole};
use crate::seed::{build_seeds, SeedBudget, SeedKind};
use crate::trace::{trace_line, TraceParams, Topology};
use crate::vec3::V3;

// ───────────────────────────────────────────────────────────────────
// JS-facing input shapes (camelCase via serde rename_all)
// ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArIn {
    lat_deg: f32,
    lon_deg: f32,
    #[serde(default = "one")] area: f32,
    #[serde(default = "one")] polarity: f32,
    #[serde(default)]         tilt_deg: f32,
    #[serde(default)]         complexity: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HoleIn {
    lat_deg: f32,
    lon_deg: f32,
    #[serde(default = "one")] area: f32,
    #[serde(default = "one")] sign: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParamsIn {
    #[serde(default = "default_ss")]    source_surface: f32,
    #[serde(default = "default_step")]  step: f32,
    #[serde(default = "default_msteps")] max_steps: u32,
    #[serde(default = "default_samples")] samples_per_line: u32,
    #[serde(default = "default_per_ar")]  seeds_per_ar: u32,
    #[serde(default = "default_global")]  seeds_global: u32,
    #[serde(default = "default_max")]     max_lines: u32,
}

fn one() -> f32 { 1.0 }
fn default_ss() -> f32 { 2.5 }
fn default_step() -> f32 { 0.01 }
fn default_msteps() -> u32 { 1200 }
fn default_samples() -> u32 { 64 }
fn default_per_ar() -> u32 { 36 }
fn default_global() -> u32 { 256 }
fn default_max() -> u32 { 2048 }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputJson {
    #[serde(default)] active_regions: Vec<ArIn>,
    #[serde(default)] coronal_holes: Vec<HoleIn>,
    #[serde(default)] params: Option<ParamsIn>,
}

// ───────────────────────────────────────────────────────────────────
// JS-facing output: a single struct holding flat Float32Array buffers
// ───────────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub struct FieldAtlas {
    line_count: u32,
    samples_per_line: u32,
    positions: Vec<f32>, // line_count × samples × 3
    tangents: Vec<f32>,  // line_count × samples × 3
    meta: Vec<f32>,      // line_count × META_STRIDE
}

const META_STRIDE: usize = 8;
// meta layout per line:
//   [0] topology   (0 closed, 1 open+, 2 open-, 3 stray)
//   [1] seed kind  (0 arcade, 1 global, 2 pil)
//   [2] ar_index   (-1 if none)
//   [3] apex height (R☉)
//   [4] total length (R☉)
//   [5] foot_a_lat (rad, photospheric end A; NaN if open at A)
//   [6] foot_a_lon (rad)
//   [7] twist      (rad — accumulated tangent rotation about spine axis;
//                    > ~2π → one full turn → tornado-class candidate)

#[wasm_bindgen]
impl FieldAtlas {
    #[wasm_bindgen(getter)] pub fn line_count(&self) -> u32 { self.line_count }
    #[wasm_bindgen(getter)] pub fn samples_per_line(&self) -> u32 { self.samples_per_line }
    #[wasm_bindgen(getter)] pub fn meta_stride(&self) -> u32 { META_STRIDE as u32 }

    /// Returns Float32Array(positions). Layout: line × sample × {x,y,z}.
    pub fn positions(&self) -> Vec<f32> { self.positions.clone() }
    pub fn tangents(&self)  -> Vec<f32> { self.tangents.clone() }
    pub fn meta(&self)      -> Vec<f32> { self.meta.clone() }
}

// ───────────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────────

/// Build the field-line atlas. Pass any JSON-shaped object:
///
/// ```js
/// const atlas = compute_field_lines({
///   activeRegions: [{ latDeg: 12, lonDeg: -45, area: 0.7, polarity: 1,
///                     tiltDeg: -8, complexity: 3 }, ...],
///   coronalHoles:  [{ latDeg: 70, lonDeg: 180, area: 0.4, sign: 1 }],
///   params: { sourceSurface: 2.5 }   // UI knob
/// });
/// ```
#[wasm_bindgen]
pub fn compute_field_lines(input: JsValue) -> Result<FieldAtlas, JsValue> {
    let parsed: InputJson = serde_wasm_bindgen::from_value(input)
        .map_err(|e| JsValue::from_str(&format!("input parse error: {}", e)))?;

    let p = parsed.params.unwrap_or(ParamsIn {
        source_surface: default_ss(),
        step: default_step(),
        max_steps: default_msteps(),
        samples_per_line: default_samples(),
        seeds_per_ar: default_per_ar(),
        seeds_global: default_global(),
        max_lines: default_max(),
    });

    let deg2rad = std::f32::consts::PI / 180.0;
    let ars: Vec<Ar> = parsed.active_regions.iter().map(|a| Ar {
        lat_rad: a.lat_deg * deg2rad,
        lon_rad: a.lon_deg * deg2rad,
        area: a.area,
        polarity: a.polarity,
        tilt_rad: a.tilt_deg * deg2rad,
        complexity: a.complexity,
    }).collect();

    let holes: Vec<Hole> = parsed.coronal_holes.iter().map(|h| Hole {
        lat_rad: h.lat_deg * deg2rad,
        lon_rad: h.lon_deg * deg2rad,
        area: h.area,
        sign: h.sign,
    }).collect();

    let field = build_field(&ars, &holes);
    let seeds = build_seeds(&ars, &field, SeedBudget {
        per_ar: p.seeds_per_ar,
        global: p.seeds_global,
        max_total: p.max_lines,
    });

    let trace_params = TraceParams {
        source_surface: p.source_surface.clamp(1.5, 3.5),
        step: p.step.max(1e-3),
        max_steps: p.max_steps.max(50),
        samples_per_line: p.samples_per_line.max(8),
    };

    let n = trace_params.samples_per_line as usize;
    let mut positions: Vec<f32> = Vec::with_capacity(seeds.len() * n * 3);
    let mut tangents: Vec<f32>  = Vec::with_capacity(seeds.len() * n * 3);
    let mut meta: Vec<f32>      = Vec::with_capacity(seeds.len() * META_STRIDE);
    let mut line_count = 0u32;

    for s in &seeds {
        let line = match trace_line(&field, s.pos, &trace_params) {
            Some(l) => l,
            None => continue,
        };
        if line.samples.len() != n { continue; }

        // Drop strays — they're not visually useful and clutter the atlas.
        if line.topology == Topology::Stray && s.kind != SeedKind::Pil { continue; }

        for V3 { x, y, z } in &line.samples { positions.extend_from_slice(&[*x, *y, *z]); }
        for V3 { x, y, z } in &line.tangents { tangents.extend_from_slice(&[*x, *y, *z]); }

        // Foot A: first sample if it sits on the photosphere.
        // Inverse of from_lat_lon (y-up): lat = asin(y), lon = atan2(x, z).
        let foot_a = line.samples[0];
        let r0 = foot_a.len();
        let (lat_a, lon_a) = if (r0 - 1.0).abs() < 0.01 {
            let lat = foot_a.y.clamp(-1.0, 1.0).asin();
            let lon = foot_a.x.atan2(foot_a.z);
            (lat, lon)
        } else {
            (f32::NAN, f32::NAN)
        };

        meta.extend_from_slice(&[
            line.topology as u32 as f32,
            s.kind as u32 as f32,
            s.ar_index as f32,
            line.apex_height,
            line.total_length,
            lat_a,
            lon_a,
            line.twist,
        ]);
        line_count += 1;
    }

    Ok(FieldAtlas { line_count, samples_per_line: n as u32, positions, tangents, meta })
}

/// Diagnostic: returns [seeds, traced, dropped_short, dropped_stray]
#[wasm_bindgen]
pub fn debug_counts(input: JsValue) -> Result<Vec<u32>, JsValue> {
    let parsed: InputJson = serde_wasm_bindgen::from_value(input)
        .map_err(|e| JsValue::from_str(&format!("input: {}", e)))?;
    let p = parsed.params.unwrap_or(ParamsIn {
        source_surface: default_ss(), step: default_step(), max_steps: default_msteps(),
        samples_per_line: default_samples(), seeds_per_ar: default_per_ar(),
        seeds_global: default_global(), max_lines: default_max(),
    });
    let d2r = std::f32::consts::PI / 180.0;
    let ars: Vec<Ar> = parsed.active_regions.iter().map(|a| Ar {
        lat_rad: a.lat_deg * d2r, lon_rad: a.lon_deg * d2r,
        area: a.area, polarity: a.polarity, tilt_rad: a.tilt_deg * d2r, complexity: a.complexity,
    }).collect();
    let holes: Vec<Hole> = parsed.coronal_holes.iter().map(|h| Hole {
        lat_rad: h.lat_deg * d2r, lon_rad: h.lon_deg * d2r, area: h.area, sign: h.sign,
    }).collect();
    let field = build_field(&ars, &holes);
    let seeds = build_seeds(&ars, &field, SeedBudget {
        per_ar: p.seeds_per_ar, global: p.seeds_global, max_total: p.max_lines,
    });
    let tp = TraceParams {
        source_surface: p.source_surface.clamp(1.5, 3.5),
        step: p.step.max(1e-3), max_steps: p.max_steps.max(50),
        samples_per_line: p.samples_per_line.max(8),
    };
    let mut traced = 0u32;
    let mut short = 0u32;
    let mut stray = 0u32;
    for s in &seeds {
        match trace_line(&field, s.pos, &tp) {
            None => short += 1,
            Some(l) => {
                if l.topology == Topology::Stray { stray += 1; }
                else { traced += 1; }
            }
        }
    }
    Ok(vec![seeds.len() as u32, traced, short, stray])
}

/// Cheap version-stamp endpoint — useful for cache-busting in JS.
#[wasm_bindgen]
pub fn version() -> String {
    format!("sunfield_wasm {} (PFSS-lite, dipole-superposition)", env!("CARGO_PKG_VERSION"))
}
