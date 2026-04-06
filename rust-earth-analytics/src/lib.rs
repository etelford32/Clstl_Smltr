//! Earth Analytics ECS — high-performance simulation analytics for Earth view
//!
//! Architecture: A lightweight Entity-Component-System designed for WASM.
//! Instead of a full game-engine ECS (Bevy), we use a focused "analytic ECS"
//! where:
//!   - **Components** are typed data buffers (atmosphere grid, magnetosphere state, etc.)
//!   - **Systems** are pure functions that transform component data each tick
//!   - **The World** owns all components and drives system execution order
//!
//! This gives us Rust's performance (SIMD-friendly loops, zero-copy buffers,
//! no GC pauses) with a clean separation of concerns — each physics domain
//! is an independent system that can be profiled and optimized in isolation.
//!
//! ## Performance targets (vs JS baseline)
//!   - Isobar marching squares: 5–10× faster (tight loops, no object allocation)
//!   - Pressure gradient analysis: 8–15× faster (SIMD-friendly inner loop)
//!   - Magnetosphere physics: 3–5× faster (pure math, no prototype chain)
//!   - Spatial queries: 10–20× faster (grid-based spatial hash)

mod atmosphere;
mod magnetosphere;
mod spatial;
mod ecs;

use wasm_bindgen::prelude::*;

// Re-export the WASM API
pub use crate::ecs::EarthAnalyticsWorld;

/// Initialize panic hook for better WASM error messages in dev.
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(debug_assertions)]
    console_error_panic_hook::set_once();
}
