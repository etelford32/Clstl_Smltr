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
use rope::{field_at_set, observer_pos, synth_series, Profile, RopeEntry, RopeParams};

/// Series buffer cap: 4 channels × MAX_STEPS samples.
pub const MAX_STEPS: usize = 4096;
/// Ensemble member cap (keeps the per-step sample matrix bounded).
pub const MAX_MEMBERS: usize = 8192;
/// Rope-train cap (spec §10) — page UX and uniform arrays match this.
pub const MAX_ROPES: usize = 4;

struct Engine {
    ropes: Vec<RopeEntry>,
    spreads: Spreads,
    series: Box<[f32; 4 * MAX_STEPS]>,
    field_probe: [f32; 4],
    ens: Option<EnsembleResult>,
}

impl Engine {
    fn new() -> Engine {
        Engine {
            ropes: vec![RopeEntry::new(RopeParams::default(), 0.0)],
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

#[allow(clippy::too_many_arguments)]
fn build_params(
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
) -> RopeParams {
    RopeParams {
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
    }
}

/// Reset to a SINGLE rope (spec §3–§5) launched at t = 0 — the v1 API,
/// kept verbatim so single-event pages and pinned tests are untouched.
/// Angles in degrees; `profile` 0 = Gold-Hoyle, 1 = Lundquist. Invalidates
/// any stored ensemble result.
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
    e.ropes.clear();
    e.ropes.push(RopeEntry::new(
        build_params(
            lon_deg, lat_deg, tilt_deg, handedness, twist_turns, b_1au_nt, sigma_1au_au,
            n_b, n_sigma, d0_rsun, v0_kms, gamma_per_km, w_kms, profile,
        ),
        0.0,
    ));
    e.ens = None;
}

/// Empty the rope train (spec §10). Follow with fr_push_rope calls.
#[no_mangle]
pub extern "C" fn fr_clear_ropes() {
    let e = engine();
    e.ropes.clear();
    e.ens = None;
}

/// Append a rope to the train, launched `t_launch_s` seconds after the
/// engine's t = 0 reference epoch. Same 14 leading parameters as
/// fr_set_rope. Trains are capped at MAX_ROPES (excess pushes are ignored).
/// Returns the train size.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn fr_push_rope(
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
    t_launch_s: f64,
) -> u32 {
    let e = engine();
    if e.ropes.len() < MAX_ROPES {
        e.ropes.push(RopeEntry::new(
            build_params(
                lon_deg, lat_deg, tilt_deg, handedness, twist_turns, b_1au_nt, sigma_1au_au,
                n_b, n_sigma, d0_rsun, v0_kms, gamma_per_km, w_kms, profile,
            ),
            t_launch_s,
        ));
        e.ens = None;
    }
    e.ropes.len() as u32
}

#[no_mangle]
pub extern "C" fn fr_rope_count() -> u32 {
    engine().ropes.len() as u32
}

#[no_mangle]
pub extern "C" fn fr_max_ropes() -> u32 {
    MAX_ROPES as u32
}

// ── Kinematics probes (page HUD + GLSL uniforms) ─────────────────────────────
// The _at variants take a rope index into the train; the index-free forms
// probe rope 0 (v1 back-compat). A rope not yet launched (t < t_launch)
// reports its launch state: apex at d0, launch speed, σ(d0).

fn rope_at(idx: u32) -> Option<&'static RopeEntry> {
    engine().ropes.get(idx as usize)
}

/// Apex heliocentric distance [km] of rope `idx` at t seconds after epoch.
#[no_mangle]
pub extern "C" fn fr_apex_km_at(idx: u32, t_s: f64) -> f64 {
    match rope_at(idx) {
        Some(r) => r.params.dbm().apex_km((t_s - r.t_launch_s).max(0.0)),
        None => f64::NAN,
    }
}

/// Apex speed [km/s] of rope `idx` at t seconds after epoch.
#[no_mangle]
pub extern "C" fn fr_apex_v_kms_at(idx: u32, t_s: f64) -> f64 {
    match rope_at(idx) {
        Some(r) => r.params.dbm().speed_kms((t_s - r.t_launch_s).max(0.0)),
        None => f64::NAN,
    }
}

/// Apex minor radius σ_apex [km] of rope `idx` at t seconds after epoch.
#[no_mangle]
pub extern "C" fn fr_sigma_apex_km_at(idx: u32, t_s: f64) -> f64 {
    match rope_at(idx) {
        Some(r) => {
            let d = r.params.dbm().apex_km((t_s - r.t_launch_s).max(0.0));
            kinematics::sigma_apex_km(
                r.params.sigma_1au_au * kinematics::AU_KM,
                d,
                r.params.n_sigma,
            )
        }
        None => f64::NAN,
    }
}

#[no_mangle]
pub extern "C" fn fr_apex_km(t_s: f64) -> f64 {
    fr_apex_km_at(0, t_s)
}

#[no_mangle]
pub extern "C" fn fr_apex_v_kms(t_s: f64) -> f64 {
    fr_apex_v_kms_at(0, t_s)
}

#[no_mangle]
pub extern "C" fn fr_sigma_apex_km(t_s: f64) -> f64 {
    fr_sigma_apex_km_at(0, t_s)
}

/// Launch offset [s] of rope `idx` (NaN when out of range).
#[no_mangle]
pub extern "C" fn fr_rope_t_launch_s(idx: u32) -> f64 {
    match rope_at(idx) {
        Some(r) => r.t_launch_s,
        None => f64::NAN,
    }
}

// ── Field sampling ───────────────────────────────────────────────────────────

/// Sample the TRAIN's superposed field at heliocentric point (x, y, z) [km]
/// at t seconds after the reference epoch. Fills the 4-slot probe buffer
/// with (Bx, By, Bz, containment_count) in the HELIOCENTRIC frame (the 3D
/// view's frame — NOT GSE) and returns its pointer. The GLSL heliosphere
/// view mirrors this math in-shader; this export is its oracle.
#[no_mangle]
pub extern "C" fn fr_field_at(t_s: f64, x_km: f64, y_km: f64, z_km: f64) -> *const f32 {
    let e = engine();
    let (b, count) = field_at_set(&e.ropes, t_s, [x_km, y_km, z_km]);
    e.field_probe = [b[0] as f32, b[1] as f32, b[2] as f32, count as f32];
    e.field_probe.as_ptr()
}

// ── Virtual spacecraft series ────────────────────────────────────────────────

/// Synthesize the in situ series at an observer (spec §6, §10): `n_steps`
/// samples from `t0_s` at `dt_s` spacing, observer at (r [AU], lon, lat
/// [deg]). Fills the series buffer with per-step (Bx, By, Bz,
/// containment_count) in GSE [nT] — count ≥ 2 marks where the v1
/// no-interaction assumption breaks — and returns the number of steps with
/// count ≥ 1. `n_steps` is clamped to MAX_STEPS. Read via fr_series_ptr();
/// copy immediately.
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
    synth_series(&e.ropes, t0_s, dt_s, n, obs, &mut e.series[..4 * n]) as u32
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
        &e.ropes,
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
        ropes_per_member: 0,
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

/// Per-member sampled params, fr_ens_member_stride() f32 per RECORD in the
/// order lon_deg, lat_deg, tilt_deg, v0_kms, gamma_per_km, sigma_1au_au,
/// handedness — the heliosphere view draws true member rope geometry from
/// these. fr_ens_members() × fr_ens_ropes_per_member() records, member-major
/// (record (m, r) at index (m·R + r)·stride).
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
pub extern "C" fn fr_ens_ropes_per_member() -> u32 {
    ens().ropes_per_member as u32
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
    use std::sync::Mutex;

    /// The extern-C surface drives ONE global engine; parallel test threads
    /// would race it. Every ABI test serializes on this.
    static ABI_LOCK: Mutex<()> = Mutex::new(());

    /// Drive the whole C ABI the way js/flux-rope-kernel.js does.
    #[test]
    fn abi_end_to_end() {
        let _guard = ABI_LOCK.lock().unwrap();
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

    /// Drive the TRAIN surface the way the multi-rope page does.
    /// NOTE: the ABI tests share the one global ENGINE, so they must not run
    /// concurrently — this one takes the same serialization lock.
    #[test]
    fn abi_train_end_to_end() {
        let _guard = ABI_LOCK.lock().unwrap();
        fr_init();
        fr_clear_ropes();
        assert_eq!(fr_rope_count(), 0);
        let push = |v0: f64, t_launch_h: f64| {
            fr_push_rope(
                0.0, 0.0, 90.0, 1.0, 5.0, 24.0, 0.10, 1.64, 1.14, 21.5, v0, 0.2e-7, 400.0,
                0.0, t_launch_h * 3600.0,
            )
        };
        assert_eq!(push(1400.0, 0.0), 1);
        assert_eq!(push(1600.0, 20.0), 2);
        assert_eq!(fr_rope_count(), 2);
        assert_eq!(fr_rope_t_launch_s(1), 20.0 * 3600.0);

        // Per-rope kinematics probes: rope 1 sits at d0 before its launch.
        assert!(fr_apex_km_at(1, 10.0 * 3600.0) < fr_apex_km_at(0, 10.0 * 3600.0));
        assert!(fr_apex_km_at(2, 0.0).is_nan(), "out-of-range rope probe is NaN");

        // The train series has two crossings and both counted in hits.
        let hits = fr_series(0.0, 1800.0, 500, 0.99, 0.0, 0.0);
        assert!(hits > 30, "train hits {}", hits);
        let ptr = fr_series_ptr();
        let max_count = (0..500)
            .map(|i| unsafe { *ptr.add(4 * i + 3) })
            .fold(0.0f32, f32::max);
        assert!(max_count >= 1.0);

        // Joint ensemble over the train: reproducible, exposes per-rope draws.
        fr_set_spreads(6.0, 4.0, 15.0, 100.0, 0.2, 0.15, 0.3, 0.8, 0.05);
        let n = fr_ens_run(7.0, 100, 0.0, 1800.0, 500, 0.99, 0.0, 0.0);
        assert_eq!(n, 100);
        assert_eq!(fr_ens_ropes_per_member(), 2);
        assert!(!fr_ens_member_params_ptr().is_null());
        assert!(fr_ens_p_hit() > 0.7, "train p_hit {}", fr_ens_p_hit());

        // fr_set_rope resets to a single-rope engine (v1 back-compat).
        fr_set_rope(
            0.0, 0.0, 90.0, 1.0, 4.0, 20.0, 0.115, 1.64, 1.14, 21.5, 1100.0, 0.2e-7, 400.0, 0.0,
        );
        assert_eq!(fr_rope_count(), 1);
        assert_eq!(fr_rope_t_launch_s(0), 0.0);
    }
}
