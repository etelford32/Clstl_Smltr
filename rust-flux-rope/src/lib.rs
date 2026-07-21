//! flux-rope-core — the Flux Rope Simulator engine as a WASM module.
//!
//! 3DCORE-class semi-empirical CME forecasting: a tapered-torus rope
//! (croissant) anchored at the Sun, Gold-Hoyle or Lundquist internal field,
//! drag-based (DBM) kinematics with self-similar expansion, a virtual
//! spacecraft that synthesizes the in situ Bx/By/Bz a rope crossing produces
//! at L1, and a deterministic seeded ensemble producing percentile Bz fans,
//! arrival distributions, and threshold probabilities.
//!
//! Normative physics: FLUX_ROPE_PHYSICS_SPEC.md at the repo root — the code
//! here is a transcription of that spec. If they disagree, one has a bug and
//! the fix lands in BOTH.
//!
//! Design contract (rust-shielding / rust-ring-current precedent):
//!   * No wasm-bindgen: plain `extern "C"` exports, loaded by
//!     js/flux-rope-kernel.js with `WebAssembly.instantiate` (browser AND the
//!     Node smoke test tests/flux-rope-kernel-smoke.mjs).
//!   * One global engine behind the C ABI; series/percentile buffers are f32,
//!     refilled in place and COPIED out by the JS wrapper immediately after
//!     each call (ensemble runs may grow WASM memory — held views go stale).
//!   * Deterministic: same params + same seed → same output, native and WASM.
//!
//! `cargo test` here is the physics gate — run it after ANY edit, then
//! rebuild + commit js/flux-rope-wasm/flux_rope_core.wasm (build-wasm.sh) and
//! run `node tests/flux-rope-kernel-smoke.mjs` to re-pin the St. Patrick's
//! 2015 validation.

#![allow(static_mut_refs)]

pub mod bessel;
pub mod ensemble;
pub mod kinematics;
pub mod rope;

use ensemble::{EnsembleResult, Spreads, PCTS};
use rope::{field_at, observer_pos, synth_series, Frame, Profile, RopeParams};

/// Series buffer cap: 4 channels × MAX_STEPS samples.
pub const MAX_STEPS: usize = 4096;
/// Ensemble member cap (keeps the per-step sample matrix bounded).
pub const MAX_MEMBERS: usize = 8192;

struct Engine {
    params: RopeParams,
    frame: Frame,
    spreads: Spreads,
    series: Box<[f32; 4 * MAX_STEPS]>,
    field_probe: [f32; 4],
    ens: Option<EnsembleResult>,
}

impl Engine {
    fn new() -> Engine {
        let params = RopeParams::default();
        let frame = Frame::new(params.lon_deg, params.lat_deg, params.tilt_deg);
        Engine {
            params,
            frame,
            spreads: Spreads::default(),
            series: Box::new([0.0; 4 * MAX_STEPS]),
            field_probe: [0.0; 4],
            ens: None,
        }
    }
}

static mut ENGINE: Option<Box<Engine>> = None;

#[inline]
fn engine() -> &'static mut Engine {
    unsafe {
        if ENGINE.is_none() {
            ENGINE = Some(Box::new(Engine::new()));
        }
        ENGINE.as_mut().unwrap()
    }
}

/// (Re)initialize the engine to defaults.
#[no_mangle]
pub extern "C" fn fr_init() {
    unsafe {
        ENGINE = Some(Box::new(Engine::new()));
    }
}

/// Set the full rope parameterization (spec §3–§5) in one call. Angles in
/// degrees; `profile` 0 = Gold-Hoyle, 1 = Lundquist. Invalidates any stored
/// ensemble result.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn fr_set_rope(
    lon_deg: f64,
    lat_deg: f64,
    tilt_deg: f64,
    handedness: f64,
    twist_turns: f64,
    b_1au_nt: f64,
    sigma_1au_au: f64,
    n_b: f64,
    n_sigma: f64,
    d0_rsun: f64,
    v0_kms: f64,
    gamma_per_km: f64,
    w_kms: f64,
    profile: f64,
) {
    let e = engine();
    e.params = RopeParams {
        lon_deg,
        lat_deg,
        tilt_deg,
        handedness: if handedness < 0.0 { -1.0 } else { 1.0 },
        twist_turns: twist_turns.max(0.1),
        b_1au_nt,
        sigma_1au_au,
        n_b,
        n_sigma,
        d0_rsun,
        v0_kms,
        gamma_per_km,
        w_kms,
        profile: if profile >= 0.5 { Profile::Lundquist } else { Profile::GoldHoyle },
    };
    e.frame = Frame::new(lon_deg, lat_deg, tilt_deg);
    e.ens = None;
}

// ── Kinematics probes (page HUD + GLSL uniforms) ─────────────────────────────

/// Apex heliocentric distance [km] at t seconds after launch.
#[no_mangle]
pub extern "C" fn fr_apex_km(t_s: f64) -> f64 {
    engine().params.dbm().apex_km(t_s)
}

/// Apex speed [km/s] at t seconds after launch.
#[no_mangle]
pub extern "C" fn fr_apex_v_kms(t_s: f64) -> f64 {
    engine().params.dbm().speed_kms(t_s)
}

/// Apex cross-section minor radius σ_apex [km] at t seconds after launch.
#[no_mangle]
pub extern "C" fn fr_sigma_apex_km(t_s: f64) -> f64 {
    let e = engine();
    let d = e.params.dbm().apex_km(t_s);
    kinematics::sigma_apex_km(e.params.sigma_1au_au * kinematics::AU_KM, d, e.params.n_sigma)
}

// ── Field sampling ───────────────────────────────────────────────────────────

/// Sample the rope field at heliocentric point (x, y, z) [km] at t seconds
/// after launch. Fills the 4-slot probe buffer with (Bx, By, Bz, inside) in
/// the HELIOCENTRIC frame (the 3D view's frame — NOT GSE) and returns its
/// pointer. The GLSL heliosphere view mirrors this math in-shader; this
/// export is its oracle.
#[no_mangle]
pub extern "C" fn fr_field_at(t_s: f64, x_km: f64, y_km: f64, z_km: f64) -> *const f32 {
    let e = engine();
    let fs = field_at(&e.params, &e.frame, t_s, [x_km, y_km, z_km]);
    e.field_probe = [fs.b[0] as f32, fs.b[1] as f32, fs.b[2] as f32, fs.inside as u32 as f32];
    e.field_probe.as_ptr()
}

// ── Virtual spacecraft series ────────────────────────────────────────────────

/// Synthesize the in situ series at an observer (spec §6): `n_steps` samples
/// from `t0_s` at `dt_s` spacing, observer at (r [AU], lon, lat [deg]).
/// Fills the series buffer with per-step (Bx, By, Bz, inside) in GSE [nT]
/// and returns the number of inside samples. `n_steps` is clamped to
/// MAX_STEPS. Read via fr_series_ptr(); copy immediately.
#[no_mangle]
pub extern "C" fn fr_series(
    t0_s: f64,
    dt_s: f64,
    n_steps: u32,
    obs_r_au: f64,
    obs_lon_deg: f64,
    obs_lat_deg: f64,
) -> u32 {
    let e = engine();
    let n = (n_steps as usize).min(MAX_STEPS);
    let obs = observer_pos(obs_r_au, obs_lon_deg, obs_lat_deg);
    synth_series(&e.params, &e.frame, t0_s, dt_s, n, obs, &mut e.series[..4 * n]) as u32
}

#[no_mangle]
pub extern "C" fn fr_series_ptr() -> *const f32 {
    engine().series.as_ptr()
}

#[no_mangle]
pub extern "C" fn fr_max_steps() -> u32 {
    MAX_STEPS as u32
}

// ── Ensemble ─────────────────────────────────────────────────────────────────

/// Set the prior spreads around the current fit (spec §7 table). Additive
/// sigmas for lon/lat/tilt/v0/twist; log-normal ln-sigmas for B₁AU/σ₁AU/Γ;
/// `p_flip` = chirality flip probability.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn fr_set_spreads(
    sig_lon_deg: f64,
    sig_lat_deg: f64,
    sig_tilt_deg: f64,
    sig_v0_kms: f64,
    lnsig_b: f64,
    lnsig_sigma: f64,
    lnsig_gamma: f64,
    sig_twist: f64,
    p_flip: f64,
) {
    engine().spreads = Spreads {
        sig_lon_deg,
        sig_lat_deg,
        sig_tilt_deg,
        sig_v0_kms,
        lnsig_b,
        lnsig_sigma,
        lnsig_gamma,
        sig_twist,
        p_flip: p_flip.clamp(0.0, 1.0),
    };
    engine().ens = None;
}

/// Run the ensemble: `n_members` draws (clamped to MAX_MEMBERS) around the
/// current fit with the current spreads, each flown past the observer on the
/// same time grid as fr_series. `seed` is truncated to an integer (pass
/// integers ≤ 2^53 from JS). Returns the member count actually run.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn fr_ens_run(
    seed: f64,
    n_members: u32,
    t0_s: f64,
    dt_s: f64,
    n_steps: u32,
    obs_r_au: f64,
    obs_lon_deg: f64,
    obs_lat_deg: f64,
) -> u32 {
    let e = engine();
    let n_m = (n_members as usize).clamp(1, MAX_MEMBERS);
    let n_s = (n_steps as usize).min(MAX_STEPS);
    let obs = observer_pos(obs_r_au, obs_lon_deg, obs_lat_deg);
    let res = ensemble::run(
        &e.params,
        &e.spreads,
        seed.abs().floor() as u64,
        n_m,
        t0_s,
        dt_s,
        n_s,
        obs,
    );
    let n = res.n_members as u32;
    e.ens = Some(res);
    n
}

fn ens() -> &'static EnsembleResult {
    static EMPTY: EnsembleResult = EnsembleResult {
        n_members: 0,
        n_steps: 0,
        bz_pct: Vec::new(),
        bt_med: Vec::new(),
        hit_frac: Vec::new(),
        arrival_h: Vec::new(),
        min_bz: Vec::new(),
        member_params: Vec::new(),
        p_hit: 0.0,
    };
    engine().ens.as_ref().unwrap_or(&EMPTY)
}

/// Bz percentile row `which` ∈ {0:P5, 1:P25, 2:P50, 3:P75, 4:P95} — pointer
/// to n_steps f32. Copy immediately (invalidated by the next fr_ens_run).
#[no_mangle]
pub extern "C" fn fr_ens_bz_pct_ptr(which: u32) -> *const f32 {
    let r = ens();
    let k = (which as usize).min(PCTS.len() - 1);
    if r.n_steps == 0 {
        core::ptr::null()
    } else {
        r.bz_pct[k * r.n_steps..].as_ptr()
    }
}

#[no_mangle]
pub extern "C" fn fr_ens_bt_med_ptr() -> *const f32 {
    let r = ens();
    if r.n_steps == 0 { core::ptr::null() } else { r.bt_med.as_ptr() }
}

#[no_mangle]
pub extern "C" fn fr_ens_hit_frac_ptr() -> *const f32 {
    let r = ens();
    if r.n_steps == 0 { core::ptr::null() } else { r.hit_frac.as_ptr() }
}

/// Per-member arrival hours (NaN = miss); n = fr_ens_members().
#[no_mangle]
pub extern "C" fn fr_ens_arrival_ptr() -> *const f32 {
    let r = ens();
    if r.n_members == 0 { core::ptr::null() } else { r.arrival_h.as_ptr() }
}

/// Per-member window-min Bz (NaN = miss); n = fr_ens_members().
#[no_mangle]
pub extern "C" fn fr_ens_minbz_ptr() -> *const f32 {
    let r = ens();
    if r.n_members == 0 { core::ptr::null() } else { r.min_bz.as_ptr() }
}

/// Per-member sampled params, fr_ens_member_stride() f32 per member in the
/// order lon_deg, lat_deg, tilt_deg, v0_kms, gamma_per_km, sigma_1au_au,
/// handedness — the heliosphere view draws true member rope geometry from
/// these. n = fr_ens_members() records.
#[no_mangle]
pub extern "C" fn fr_ens_member_params_ptr() -> *const f32 {
    let r = ens();
    if r.n_members == 0 { core::ptr::null() } else { r.member_params.as_ptr() }
}

#[no_mangle]
pub extern "C" fn fr_ens_member_stride() -> u32 {
    ensemble::MEMBER_STRIDE as u32
}

#[no_mangle]
pub extern "C" fn fr_ens_members() -> u32 {
    ens().n_members as u32
}

#[no_mangle]
pub extern "C" fn fr_ens_steps() -> u32 {
    ens().n_steps as u32
}

#[no_mangle]
pub extern "C" fn fr_ens_p_hit() -> f64 {
    ens().p_hit
}

/// P(min Bz over the window < thr) across all members (misses count false).
#[no_mangle]
pub extern "C" fn fr_ens_p_minbz_below(thr_nt: f64) -> f64 {
    ens().p_min_bz_below(thr_nt)
}

#[cfg(test)]
mod abi_tests {
    use super::*;

    /// Drive the whole C ABI the way js/flux-rope-kernel.js does.
    #[test]
    fn abi_end_to_end() {
        fr_init();
        fr_set_rope(
            0.0, 0.0, 90.0, 1.0, 4.0, 20.0, 0.115, 1.64, 1.14, 21.5, 1100.0, 0.2e-7, 400.0, 0.0,
        );
        // Deterministic series: head-on rope must cross L1.
        let hits = fr_series(0.0, 1800.0, 400, 0.99, 0.0, 0.0);
        assert!(hits > 20, "hits {}", hits);
        let ptr = fr_series_ptr();
        let bz_mid = unsafe { *ptr.add(4 * 110 + 2) }; // some in-storm sample
        assert!(bz_mid.is_finite());

        // Kinematics probes are monotone.
        assert!(fr_apex_km(7200.0) > fr_apex_km(3600.0));
        assert!(fr_apex_v_kms(72_000.0) < 1100.0);
        assert!(fr_sigma_apex_km(72_000.0) > 0.0);

        // Ensemble: seeded, reproducible, sane probabilities.
        fr_set_spreads(8.0, 5.0, 15.0, 80.0, 0.2, 0.15, 0.3, 0.8, 0.05);
        let n = fr_ens_run(20260721.0, 200, 0.0, 1800.0, 400, 0.99, 0.0, 0.0);
        assert_eq!(n, 200);
        assert_eq!(fr_ens_steps(), 400);
        let p_hit = fr_ens_p_hit();
        assert!(p_hit > 0.5, "p_hit {}", p_hit);
        assert!(fr_ens_p_minbz_below(-5.0) >= fr_ens_p_minbz_below(-15.0));
        let p50 = fr_ens_bz_pct_ptr(2);
        assert!(!p50.is_null());
        // A second identical run reproduces the median fan exactly.
        let med1: Vec<f32> =
            (0..400).map(|i| unsafe { *fr_ens_bz_pct_ptr(2).add(i) }).collect();
        fr_ens_run(20260721.0, 200, 0.0, 1800.0, 400, 0.99, 0.0, 0.0);
        let med2: Vec<f32> =
            (0..400).map(|i| unsafe { *fr_ens_bz_pct_ptr(2).add(i) }).collect();
        assert_eq!(med1, med2);

        // Field probe: mid-storm the point 1 AU sunward-line is inside.
        let t_mid = 55.0 * 3600.0;
        let fp = fr_field_at(t_mid, fr_apex_km(t_mid) * 0.98, 0.0, 0.0);
        let inside = unsafe { *fp.add(3) };
        assert!(inside == 1.0, "apex-adjacent probe should be inside");
    }
}
