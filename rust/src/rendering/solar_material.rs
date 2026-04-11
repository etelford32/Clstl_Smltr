//! Custom Bevy materials for solar surface, corona, and flare effects.
//!
//! These materials use GPU fragment shaders (WGSL) for physically-motivated
//! solar visualisation that goes far beyond what `StandardMaterial` can
//! produce.  Each material is updated every frame from simulation state.
//!
//! # Materials
//!
//! | Material              | Shader                      | Applied to              |
//! |-----------------------|-----------------------------|-------------------------|
//! | [`SolarSurfaceMat`]   | `solar_surface.wgsl`        | Star sphere mesh        |
//! | [`CoronaGlowMat`]     | `corona_glow.wgsl`          | Larger transparent shell|
//! | [`FlareFlashMat`]     | `flare_flash.wgsl`          | Eruption effect sphere  |

use bevy::prelude::*;
use bevy::render::render_resource::{AsBindGroup, ShaderType};
use bevy::shader::ShaderRef;

// ── Solar Surface Material ──────────────────────────────────────────────────

/// Procedural photosphere material with granulation, limb darkening,
/// sunspots, and flare ribbon brightening.
#[derive(Asset, TypePath, AsBindGroup, Clone)]
pub struct SolarSurfaceMat {
    #[uniform(0)]
    pub uniforms: SolarSurfaceUniforms,
}

/// GPU-side uniform block for the solar surface shader.
/// Layout must exactly match `SolarSurfaceUniforms` in `solar_surface.wgsl`.
#[derive(Clone, Copy, ShaderType)]
pub struct SolarSurfaceUniforms {
    pub time: f32,
    pub star_radius: f32,
    /// Active region 1: (lat, lon, intensity, flare_brightness).
    pub ar1: Vec4,
    /// Active region 2: (lat, lon, intensity, flare_brightness).
    pub ar2: Vec4,
    pub activity_scale: f32,
    pub granulation_scale: f32,
    pub _pad0: f32,
    pub _pad1: f32,
}

impl Default for SolarSurfaceUniforms {
    fn default() -> Self {
        Self {
            time: 0.0,
            star_radius: 2.0,
            ar1: Vec4::new(
                25_f32.to_radians(),
                60_f32.to_radians(),
                1.0,
                0.0,
            ),
            ar2: Vec4::new(
                -18_f32.to_radians(),
                200_f32.to_radians(),
                0.8,
                0.0,
            ),
            activity_scale: 1.0,
            granulation_scale: 12.0,
            _pad0: 0.0,
            _pad1: 0.0,
        }
    }
}

impl Material for SolarSurfaceMat {
    fn fragment_shader() -> ShaderRef {
        "shaders/solar_surface.wgsl".into()
    }
}

// ── Corona Glow Material ────────────────────────────────────────────────────

/// Volumetric corona atmosphere material with helmet streamers,
/// polar coronal holes, and eruption-triggered brightness.
#[derive(Asset, TypePath, AsBindGroup, Clone)]
pub struct CoronaGlowMat {
    #[uniform(0)]
    pub uniforms: CoronaUniforms,
}

/// GPU-side uniform block for the corona glow shader.
#[derive(Clone, Copy, ShaderType)]
pub struct CoronaUniforms {
    pub time: f32,
    pub star_radius: f32,
    pub corona_radius: f32,
    pub activity_scale: f32,
    /// Eruption flash: (intensity, lat, lon, age_seconds).
    pub eruption: Vec4,
    pub wind_scale: f32,
    pub _pad0: f32,
    pub _pad1: f32,
    pub _pad2: f32,
}

impl Default for CoronaUniforms {
    fn default() -> Self {
        Self {
            time: 0.0,
            star_radius: 2.0,
            corona_radius: 5.6,
            activity_scale: 1.0,
            eruption: Vec4::ZERO,
            wind_scale: 1.0,
            _pad0: 0.0,
            _pad1: 0.0,
            _pad2: 0.0,
        }
    }
}

impl Material for CoronaGlowMat {
    fn fragment_shader() -> ShaderRef {
        "shaders/corona_glow.wgsl".into()
    }

    fn alpha_mode(&self) -> AlphaMode {
        AlphaMode::Add
    }
}

// ── Flare Flash Material ────────────────────────────────────────────────────

/// CME shockwave / flare flash effect material.
#[derive(Asset, TypePath, AsBindGroup, Clone)]
pub struct FlareFlashMat {
    #[uniform(0)]
    pub uniforms: FlareUniforms,
}

/// GPU-side uniform block for the flare flash shader.
#[derive(Clone, Copy, ShaderType)]
pub struct FlareUniforms {
    pub time: f32,
    pub start_time: f32,
    pub intensity: f32,
    pub latitude: f32,
    pub longitude: f32,
    pub expansion_speed: f32,
    pub _pad0: f32,
    pub _pad1: f32,
}

impl Default for FlareUniforms {
    fn default() -> Self {
        Self {
            time: 0.0,
            start_time: 0.0,
            intensity: 0.0,
            latitude: 0.0,
            longitude: 0.0,
            expansion_speed: 1.0,
            _pad0: 0.0,
            _pad1: 0.0,
        }
    }
}

impl Material for FlareFlashMat {
    fn fragment_shader() -> ShaderRef {
        "shaders/flare_flash.wgsl".into()
    }

    fn alpha_mode(&self) -> AlphaMode {
        AlphaMode::Add
    }
}

// ── Marker components for shader-driven entities ────────────────────────────

/// Marks the entity carrying the [`SolarSurfaceMat`] (the star sphere).
#[derive(Component)]
pub struct SolarSurfaceEntity;

/// Marks the corona glow shell entity.
#[derive(Component)]
pub struct CoronaShellEntity;

/// Marks a flare flash effect entity (ephemeral — despawns after fading).
#[derive(Component)]
pub struct FlareFlashEntity {
    /// Simulation time when the flare started.
    pub start_time: f32,
    /// Duration before auto-despawn (seconds).
    pub lifetime: f32,
    /// Index of the flux rope that triggered this flare.
    pub rope_index: usize,
}
