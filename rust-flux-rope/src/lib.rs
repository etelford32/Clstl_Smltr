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
use rope::{
    field_at_train, observer_pos, synth_series, train_dyn, Profile, RopeDyn, RopeEntry,
    RopeParams, TrainCfg,
};

/// Series buffer cap: 4 channels × MAX_STEPS samples.
pub const MAX_STEPS: usize = 4096;
/// Ensemble member cap (keeps the per-step sample matrix bounded).
pub const MAX_MEMBERS: usize = 8192;
/// Rope-train cap (spec §10) — page UX and uniform arrays match this.
pub const MAX_ROPES: usize = 4;

struct Engine {
    ropes: Vec<RopeEntry>,
    /// §16 CME–CME interaction config — engine-level, disabled by default.
    cfg: TrainCfg,
    /// Scratch for the ropes' effective dynamics (refreshed per probe call).
    dyns: Vec<RopeDyn>,
    spreads: Spreads,
    series: Box<[f32; 4 * MAX_STEPS]>,
    /// Observation INPUT buffer for assimilation: JS writes observed Bz
    /// (NaN = gap) aligned with the ensemble grid, then calls fr_assimilate.
    obs: Box<[f32; MAX_STEPS]>,
    /// Auxiliary-observer (STEREO-A, spec §13) observation INPUT buffer.
    obs_aux: Box<[f32; MAX_STEPS]>,
    /// Auxiliary observer position (r_au, lon_deg, lat_deg); None = unset.
    aux_observer: Option<[f64; 3]>,
    /// f32 mirror of the (f64) importance weights for the UI.
    weights_f32: Vec<f32>,
    field_probe: [f32; 4],
    ens: Option<EnsembleResult>,
}

impl Engine {
    fn new() -> Engine {
        Engine {
            ropes: vec![RopeEntry::new(RopeParams::default(), 0.0)],
            cfg: TrainCfg::default(),
            dyns: Vec::new(),
            spreads: Spreads::default(),
            series: Box::new([0.0; 4 * MAX_STEPS]),
            obs: Box::new([f32::NAN; MAX_STEPS]),
            obs_aux: Box::new([f32::NAN; MAX_STEPS]),
            aux_observer: None,
            weights_f32: Vec::new(),
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
    sheath_delta_nt: f64,
    sheath_k: f64,
    b_amb_1au_nt: f64,
    front_c: f64,
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
        sheath_delta_nt: sheath_delta_nt.max(0.0),
        sheath_k: sheath_k.max(0.0),
        b_amb_1au_nt: b_amb_1au_nt.max(0.0),
        front_c: front_c.clamp(0.0, 0.6),
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
    sheath_delta_nt: f64,
    sheath_k: f64,
    b_amb_1au_nt: f64,
    front_c: f64,
) {
    let e = engine();
    e.ropes.clear();
    e.ropes.push(RopeEntry::new(
        build_params(
            lon_deg, lat_deg, tilt_deg, handedness, twist_turns, b_1au_nt, sigma_1au_au,
            n_b, n_sigma, d0_rsun, v0_kms, gamma_per_km, w_kms, profile,
            sheath_delta_nt, sheath_k, b_amb_1au_nt, front_c,
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
    sheath_delta_nt: f64,
    sheath_k: f64,
    b_amb_1au_nt: f64,
    front_c: f64,
    t_launch_s: f64,
) -> u32 {
    let e = engine();
    if e.ropes.len() < MAX_ROPES {
        e.ropes.push(RopeEntry::new(
            build_params(
                lon_deg, lat_deg, tilt_deg, handedness, twist_turns, b_1au_nt, sigma_1au_au,
                n_b, n_sigma, d0_rsun, v0_kms, gamma_per_km, w_kms, profile,
                sheath_delta_nt, sheath_k, b_amb_1au_nt, front_c,
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

// ── CME–CME interaction (spec §16) ───────────────────────────────────────────

/// Configure §16 interaction for ALL subsequent series / probe / ensemble
/// calls: wake kinematics for followers, dynamic rear compression of
/// leaders, wake-conditioned follower sheaths. `enabled = 0` (the default)
/// is bit-identical to the §10 non-interacting train. Independent of the
/// rope list — fr_set_rope / fr_clear_ropes leave it untouched, so set it
/// per event. Invalidates any stored ensemble.
#[no_mangle]
pub extern "C" fn fr_set_interaction(
    enabled: f64,
    wake_gamma_frac: f64,
    comp_c: f64,
    comp_reach: f64,
) {
    let e = engine();
    e.cfg = TrainCfg {
        enabled: enabled >= 0.5,
        wake_gamma_frac: wake_gamma_frac.clamp(0.0, 1.0),
        comp_c: comp_c.clamp(0.0, 1.0),
        comp_reach: comp_reach.max(0.1),
    };
    e.ens = None;
}

/// Refresh the engine's effective-dynamics scratch from the current ropes
/// + interaction config (cheap: n ≤ MAX_ROPES).
fn refresh_dyns(e: &mut Engine) {
    let Engine { ropes, cfg, dyns, .. } = e;
    train_dyn(ropes, cfg, dyns);
}

/// EFFECTIVE ambient wind [km/s] of rope `idx` under the current
/// interaction config — the frozen wake speed for a follower, the rope's
/// own w otherwise. NaN when out of range.
#[no_mangle]
pub extern "C" fn fr_rope_w_eff_kms(idx: u32) -> f64 {
    let e = engine();
    refresh_dyns(e);
    match e.dyns.get(idx as usize) {
        Some(d) => d.dbm.w_kms,
        None => f64::NAN,
    }
}

/// EFFECTIVE drag parameter Γ [km⁻¹] of rope `idx` (wake-reduced for a
/// follower). NaN when out of range.
#[no_mangle]
pub extern "C" fn fr_rope_gamma_eff(idx: u32) -> f64 {
    let e = engine();
    refresh_dyns(e);
    match e.dyns.get(idx as usize) {
        Some(d) => d.dbm.gamma_per_km,
        None => f64::NAN,
    }
}

// ── Kinematics probes (page HUD + GLSL uniforms) ─────────────────────────────
// The _at variants take a rope index into the train; the index-free forms
// probe rope 0 (v1 back-compat). A rope not yet launched (t < t_launch)
// reports its launch state: apex at d0, launch speed, σ(d0). All probes use
// the EFFECTIVE (§16 wake-modified) kinematics — identical to the raw DBM
// while interaction is disabled.

/// Apex heliocentric distance [km] of rope `idx` at t seconds after epoch.
#[no_mangle]
pub extern "C" fn fr_apex_km_at(idx: u32, t_s: f64) -> f64 {
    let e = engine();
    refresh_dyns(e);
    match e.ropes.get(idx as usize) {
        Some(r) => e.dyns[idx as usize].dbm.apex_km((t_s - r.t_launch_s).max(0.0)),
        None => f64::NAN,
    }
}

/// Apex speed [km/s] of rope `idx` at t seconds after epoch.
#[no_mangle]
pub extern "C" fn fr_apex_v_kms_at(idx: u32, t_s: f64) -> f64 {
    let e = engine();
    refresh_dyns(e);
    match e.ropes.get(idx as usize) {
        Some(r) => e.dyns[idx as usize].dbm.speed_kms((t_s - r.t_launch_s).max(0.0)),
        None => f64::NAN,
    }
}

/// Apex minor radius σ_apex [km] of rope `idx` at t seconds after epoch.
#[no_mangle]
pub extern "C" fn fr_sigma_apex_km_at(idx: u32, t_s: f64) -> f64 {
    let e = engine();
    refresh_dyns(e);
    match e.ropes.get(idx as usize) {
        Some(r) => {
            let d = e.dyns[idx as usize].dbm.apex_km((t_s - r.t_launch_s).max(0.0));
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
    match engine().ropes.get(idx as usize) {
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
    let (b, count) = {
        let Engine { ropes, cfg, dyns, .. } = &mut *e;
        train_dyn(ropes, cfg, dyns);
        field_at_train(ropes, dyns, cfg, t_s, [x_km, y_km, z_km])
    };
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
    let Engine { ropes, cfg, series, .. } = &mut *e;
    synth_series(ropes, cfg, t0_s, dt_s, n, obs, &mut series[..4 * n]) as u32
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
    let aux = e.aux_observer.map(|a| observer_pos(a[0], a[1], a[2]));
    let res = ensemble::run(
        &e.ropes,
        &e.spreads,
        seed.abs().floor() as u64,
        n_m,
        t0_s,
        dt_s,
        n_s,
        obs,
        aux,
        &e.cfg,
    );
    let n = res.n_members as u32;
    e.ens = Some(res);
    e.weights_f32.clear(); // fresh (uniform) ensemble → stale weights gone
    n
}

// ── Auxiliary observer (STEREO-A, spec §13) ──────────────────────────────────

/// Set the auxiliary observer for SUBSEQUENT fr_ens_run calls: its member
/// Bz series is recorded alongside the primary's so fr_assimilate_joint can
/// condition on off-Sun–Earth-line data. Recording draws nothing from the
/// RNG — the primary prior is bit-identical with or without it.
#[no_mangle]
pub extern "C" fn fr_aux_set(r_au: f64, lon_deg: f64, lat_deg: f64) {
    engine().aux_observer = Some([r_au, lon_deg, lat_deg]);
}

#[no_mangle]
pub extern "C" fn fr_aux_clear() {
    engine().aux_observer = None;
}

/// Auxiliary observation input buffer (MAX_STEPS f32, NaN = gap) — same grid
/// and write discipline as fr_obs_ptr.
#[no_mangle]
pub extern "C" fn fr_obs_aux_ptr() -> *mut f32 {
    engine().obs_aux.as_mut_ptr()
}

/// JOINT particle-filter update (spec §13): primary (L1) observations over
/// [i0, i1) PLUS auxiliary (STEREO-A) observations over [aux_i0, aux_i1),
/// log-likelihoods summed and tempered ONCE against the ESS floor. Reduces
/// exactly to fr_assimilate when the aux window is empty or the ensemble
/// ran without an aux observer. Returns ESS.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn fr_assimilate_joint(
    i0: u32,
    i1: u32,
    sigma_nt: f64,
    aux_i0: u32,
    aux_i1: u32,
    aux_sigma_nt: f64,
    ess_floor_frac: f64,
) -> f64 {
    let e = engine();
    match e.ens.as_mut() {
        None => 0.0,
        Some(r) => {
            let ess = ensemble::assimilate_joint(
                r,
                &e.obs[..],
                i0 as usize,
                i1 as usize,
                sigma_nt,
                &e.obs_aux[..],
                aux_i0 as usize,
                aux_i1 as usize,
                aux_sigma_nt,
                ess_floor_frac.clamp(0.0, 0.9),
            );
            e.weights_f32 = match &r.weights {
                Some(w) => w.iter().map(|x| *x as f32).collect(),
                None => vec![1.0 / r.n_members.max(1) as f32; r.n_members],
            };
            ess
        }
    }
}

/// 1 if the stored ensemble carries auxiliary-observer member series.
#[no_mangle]
pub extern "C" fn fr_ens_has_aux() -> u32 {
    (!ens().member_bz_aux.is_empty()) as u32
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
        member_bz: Vec::new(),
        member_bz_clean: Vec::new(),
        member_bt: Vec::new(),
        member_bz_aux: Vec::new(),
        weights: None,
        ess: 0.0,
        temperature: 1.0,
        p_hit: 0.0,
    };
    engine().ens.as_ref().unwrap_or(&EMPTY)
}

// ── Assimilation (spec §11): sequential importance reweighting ───────────────

/// Pointer to the observation input buffer (MAX_STEPS f32). Write observed
/// Bz_GSM [nT] aligned index-for-index with the ensemble grid (NaN = gap)
/// BEFORE calling fr_assimilate. Take a fresh view per write — the buffer
/// address is stable but WASM memory growth invalidates held JS views.
#[no_mangle]
pub extern "C" fn fr_obs_ptr() -> *mut f32 {
    engine().obs.as_mut_ptr()
}

/// Condition the stored ensemble on the observation buffer over step
/// indices [i0, i1): Gaussian importance reweighting with observation error
/// `sigma_nt` (≈4 nT default — must also absorb the unmodeled ambient IMF),
/// then all fan statistics/probabilities become weight-weighted. Returns the
/// effective sample size (n_members when nothing observed; 0 with no
/// ensemble). Reweight-only particle-filter step: each call re-conditions
/// the ORIGINAL prior on the full window, so repeated calls do not
/// accumulate degeneracy.
/// `ess_floor_frac` (0..1): anneal the likelihood so ESS never falls below
/// this fraction of the ensemble (0 = pure likelihood; 0.1 is the wrapper
/// default). The applied temperature is readable via fr_assim_temperature.
#[no_mangle]
pub extern "C" fn fr_assimilate(i0: u32, i1: u32, sigma_nt: f64, ess_floor_frac: f64) -> f64 {
    let e = engine();
    match e.ens.as_mut() {
        None => 0.0,
        Some(r) => {
            let ess = ensemble::assimilate(
                r,
                &e.obs[..],
                i0 as usize,
                i1 as usize,
                sigma_nt,
                ess_floor_frac.clamp(0.0, 0.9),
            );
            e.weights_f32 = match &r.weights {
                Some(w) => w.iter().map(|x| *x as f32).collect(),
                None => vec![1.0 / r.n_members.max(1) as f32; r.n_members],
            };
            ess
        }
    }
}

/// Likelihood temperature λ applied by the last fr_assimilate (1 = none).
#[no_mangle]
pub extern "C" fn fr_assim_temperature() -> f64 {
    ens().temperature
}

/// Drop assimilation weights: back to the uniform prior (bit-identical
/// pre-assimilation statistics).
#[no_mangle]
pub extern "C" fn fr_assim_reset() {
    let e = engine();
    if let Some(r) = e.ens.as_mut() {
        ensemble::reset_weights(r);
        e.weights_f32.clear();
    }
}

/// Current effective sample size (= member count when unweighted).
#[no_mangle]
pub extern "C" fn fr_ens_ess() -> f64 {
    ens().ess
}

/// Normalized importance weights, f32[n_members] — uniform 1/n before any
/// assimilation. The UI fades ensemble spaghetti by these.
#[no_mangle]
pub extern "C" fn fr_ens_weights_ptr() -> *const f32 {
    let e = engine();
    let n = e.ens.as_ref().map_or(0, |r| r.n_members);
    if n == 0 {
        return core::ptr::null();
    }
    if e.weights_f32.len() != n {
        e.weights_f32 = vec![1.0 / n as f32; n];
    }
    e.weights_f32.as_ptr()
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
            0.0, 0.0, 90.0, 1.0, 4.0, 20.0, 0.115, 1.64, 1.14, 21.5, 1100.0, 0.2e-7, 400.0, 0.0, 0.0, 0.8, 5.0, 0.0,
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
                0.0, 0.0, 0.8, 5.0, 0.0, t_launch_h * 3600.0,
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
            0.0, 0.0, 90.0, 1.0, 4.0, 20.0, 0.115, 1.64, 1.14, 21.5, 1100.0, 0.2e-7, 400.0, 0.0, 0.0, 0.8, 5.0, 0.0,
        );
        assert_eq!(fr_rope_count(), 1);
        assert_eq!(fr_rope_t_launch_s(0), 0.0);
    }

    /// Drive the §16 interaction surface the way the page does.
    #[test]
    fn abi_interaction_end_to_end() {
        let _guard = ABI_LOCK.lock().unwrap();
        fr_init();
        fr_clear_ropes();
        let push = |v0: f64, delta: f64, t_launch_h: f64| {
            fr_push_rope(
                0.0, 0.0, 90.0, 1.0, 5.0, 24.0, 0.10, 1.64, 1.14, 21.5, v0, 0.2e-7, 400.0,
                0.0, delta, 0.8, 5.0, 0.0, t_launch_h * 3600.0,
            )
        };
        push(900.0, 0.0, 0.0);
        push(1600.0, 3.0, 18.0);
        // Disabled (default): effective kinematics are the raw ones.
        assert_eq!(fr_rope_w_eff_kms(1), 400.0);
        assert_eq!(fr_rope_gamma_eff(1), 0.2e-7);
        let base: Vec<f32> = {
            fr_series(0.0, 1800.0, 500, 0.99, 0.0, 0.0);
            let p = fr_series_ptr();
            (0..4 * 500).map(|i| unsafe { *p.add(i) }).collect()
        };
        // Enabled: the follower reads wake kinematics, the series moves.
        fr_set_interaction(1.0, 0.5, 1.0, 1.5);
        assert!(
            fr_rope_w_eff_kms(1) > 500.0,
            "wake ambient {} must exceed the fresh wind",
            fr_rope_w_eff_kms(1)
        );
        assert_eq!(fr_rope_gamma_eff(1), 0.1e-7);
        assert_eq!(fr_rope_w_eff_kms(0), 400.0, "leader keeps the fresh wind");
        let on: Vec<f32> = {
            fr_series(0.0, 1800.0, 500, 0.99, 0.0, 0.0);
            let p = fr_series_ptr();
            (0..4 * 500).map(|i| unsafe { *p.add(i) }).collect()
        };
        assert!(base.iter().zip(&on).any(|(a, b)| a.to_bits() != b.to_bits()));
        // Ensemble under interaction: runs, deterministic, sane.
        fr_set_spreads(6.0, 4.0, 15.0, 100.0, 0.2, 0.15, 0.3, 0.8, 0.05);
        let n = fr_ens_run(16.0, 100, 0.0, 1800.0, 500, 0.99, 0.0, 0.0);
        assert_eq!(n, 100);
        assert!(fr_ens_p_hit() > 0.5, "p_hit {}", fr_ens_p_hit());
        let med1: Vec<f32> =
            (0..500).map(|i| unsafe { *fr_ens_bz_pct_ptr(2).add(i) }).collect();
        fr_ens_run(16.0, 100, 0.0, 1800.0, 500, 0.99, 0.0, 0.0);
        let med2: Vec<f32> =
            (0..500).map(|i| unsafe { *fr_ens_bz_pct_ptr(2).add(i) }).collect();
        assert_eq!(med1, med2);
        // Back off: bit-identical to the pre-interaction series.
        fr_set_interaction(0.0, 0.5, 1.0, 1.5);
        assert_eq!(fr_rope_w_eff_kms(1), 400.0);
        let off: Vec<f32> = {
            fr_series(0.0, 1800.0, 500, 0.99, 0.0, 0.0);
            let p = fr_series_ptr();
            (0..4 * 500).map(|i| unsafe { *p.add(i) }).collect()
        };
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&base), bits(&off));
        fr_init(); // leave the global engine clean for the next ABI test
    }

    /// Drive the aux-observer (STEREO-A) surface the way the page does.
    #[test]
    fn abi_aux_observer_end_to_end() {
        let _guard = ABI_LOCK.lock().unwrap();
        fr_init();
        fr_set_rope(
            6.0, 0.0, 90.0, 1.0, 4.0, 20.0, 0.115, 1.64, 1.14, 21.5, 1100.0, 0.2e-7, 400.0, 0.0, 0.0, 0.8, 5.0, 0.0,
        );
        fr_set_spreads(8.0, 5.0, 15.0, 80.0, 0.2, 0.15, 0.3, 0.8, 0.05);
        // No aux set → no aux series, joint call degrades to primary-only.
        fr_ens_run(3.0, 100, 0.0, 1800.0, 300, 0.99, 0.0, 0.0);
        assert_eq!(fr_ens_has_aux(), 0);
        // Aux set → recorded; joint conditioning on an aux-only window works.
        fr_aux_set(0.96, 14.0, 0.0);
        fr_ens_run(3.0, 100, 0.0, 1800.0, 300, 0.99, 0.0, 0.0);
        assert_eq!(fr_ens_has_aux(), 1);
        let ap = fr_obs_aux_ptr();
        for i in 0..300usize {
            // A plausible flank signature: brief southward pulse mid-window.
            unsafe {
                *ap.add(i) = if (90..130).contains(&i) { -8.0 } else { f32::NAN }
            };
        }
        let ess = fr_assimilate_joint(0, 0, 4.0, 0, 300, 2.0, 0.1);
        assert!(ess > 1.0 && ess < 100.0, "aux-only joint ESS {}", ess);
        assert!(fr_assim_temperature() <= 1.0);
        fr_assim_reset();
        assert_eq!(fr_ens_ess(), 100.0);
        fr_aux_clear();
        fr_ens_run(3.0, 100, 0.0, 1800.0, 300, 0.99, 0.0, 0.0);
        assert_eq!(fr_ens_has_aux(), 0);
    }

    /// Drive the assimilation surface the way js/flux-rope-kernel.js does.
    #[test]
    fn abi_assimilation_end_to_end() {
        let _guard = ABI_LOCK.lock().unwrap();
        fr_init();
        fr_set_rope(
            0.0, 0.0, 90.0, 1.0, 4.0, 20.0, 0.115, 1.64, 1.14, 21.5, 1100.0, 0.2e-7, 400.0, 0.0, 0.0, 0.8, 5.0, 0.0,
        );
        fr_set_spreads(8.0, 5.0, 15.0, 80.0, 0.2, 0.15, 0.3, 0.8, 0.05);
        let n = fr_ens_run(11.0, 200, 0.0, 1800.0, 300, 0.99, 0.0, 0.0);
        assert_eq!(n, 200);
        assert_eq!(fr_ens_ess(), 200.0, "prior ESS = member count");
        let w0 = unsafe { *fr_ens_weights_ptr() };
        assert!((w0 - 1.0 / 200.0).abs() < 1e-9, "uniform prior weights");

        // Feed the deterministic run's own series as observations over the
        // first 150 steps → the posterior must sharpen around it.
        let hits = fr_series(0.0, 1800.0, 300, 0.99, 0.0, 0.0);
        assert!(hits > 0);
        let sp = fr_series_ptr();
        let op = fr_obs_ptr();
        for i in 0..150usize {
            unsafe { *op.add(i) = *sp.add(4 * i + 2) };
        }
        for i in 150..300usize {
            unsafe { *op.add(i) = f32::NAN };
        }
        let ess = fr_assimilate(0, 300, 3.0, 0.1);
        assert!(ess > 1.0 && ess < 200.0, "informative obs must reweight: ESS {}", ess);
        assert_eq!(fr_ens_ess(), ess);
        assert!(fr_assim_temperature() > 0.0 && fr_assim_temperature() <= 1.0);
        // Weights now non-uniform and sum ≈ 1.
        let mut sum = 0.0f64;
        let mut maxw = 0.0f32;
        for m in 0..200usize {
            let w = unsafe { *fr_ens_weights_ptr().add(m) };
            sum += w as f64;
            maxw = maxw.max(w);
        }
        assert!((sum - 1.0).abs() < 1e-3);
        assert!(maxw as f64 > 2.0 / 200.0, "some member must gain weight");
        // Reset restores the uniform prior.
        fr_assim_reset();
        assert_eq!(fr_ens_ess(), 200.0);
    }
}
