//! Tapered-torus rope geometry + internal field evaluation.
//! Spec: FLUX_ROPE_PHYSICS_SPEC.md §2–§4, §6. Everything here is pure
//! functions of (params, t, position) — no state, no allocation — so the
//! ensemble layer can hammer it and the GLSL heliosphere view can mirror it.

use crate::bessel::{j0, j1, J0_ZERO1};
use crate::kinematics::{b_axis_nt, sigma_apex_km, Dbm, SegDbm, AU_KM, RSUN_KM};

pub type V3 = [f64; 3];

#[inline]
pub fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
pub fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
#[inline]
fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
#[inline]
fn scale(a: V3, k: f64) -> V3 {
    [a[0] * k, a[1] * k, a[2] * k]
}
#[inline]
fn add3(a: V3, b: V3, c: V3) -> V3 {
    [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]]
}

/// Field profile inside the rope.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Profile {
    GoldHoyle,
    Lundquist,
}

/// Full rope parameterization (spec §3–§5). Angles in DEGREES here — the ABI
/// boundary convention; converted to radians once in `Frame::new`.
#[derive(Clone, Copy, Debug)]
pub struct RopeParams {
    pub lon_deg: f64,
    pub lat_deg: f64,
    pub tilt_deg: f64,
    /// Chirality H = ±1 (+1 right-handed).
    pub handedness: f64,
    /// Total field-line turns footpoint→footpoint (τ > 0; sign lives in H).
    pub twist_turns: f64,
    /// Axial field at 1 AU [nT].
    pub b_1au_nt: f64,
    /// Apex minor radius at 1 AU [AU].
    pub sigma_1au_au: f64,
    /// B falloff exponent (default 1.64).
    pub n_b: f64,
    /// Expansion exponent (default 1.14).
    pub n_sigma: f64,
    /// Launch apex distance [Rsun] (DONKI/Enlil inner-boundary convention 21.5).
    pub d0_rsun: f64,
    pub v0_kms: f64,
    pub gamma_per_km: f64,
    pub w_kms: f64,
    pub profile: Profile,
    // ── Sheath (spec §14, all optional — 0 δ disables) ──────────────────────
    /// Ambient Bz variability δ [nT] the shock compresses into the sheath's
    /// stochastic Bz (std = X·δ). 0 = no sheath model.
    pub sheath_delta_nt: f64,
    /// Sheath thickness as a fraction of the local rope minor radius.
    pub sheath_k: f64,
    /// Ambient (Parker) field magnitude at 1 AU [nT] — sets the compressed
    /// |B| envelope X·B_amb inside the sheath.
    pub b_amb_1au_nt: f64,
    // ── Front compression (spec §15, v1.2 — 0 disables) ─────────────────────
    /// Leading-edge compression factor c ∈ [0, 0.6]: the snowplowed FRONT of
    /// the cross-section is squeezed to σ·(1−c) with a flux-conservation
    /// field boost — the mechanism that puts the observed Bz minimum at the
    /// rope's leading edge.
    pub front_c: f64,
    // ── Mach-dependent standoff (spec §17, v1.4 — 0 = legacy k mode) ────────
    /// Farris–Russell standoff calibration η: shell thickness becomes
    /// η·FR(M)·√(σ_eff·d/2) — Mach-dependent, GROWING as the decelerating
    /// shock weakens — and `sheath_k` is ignored for this rope. 0 keeps the
    /// §14 fixed fractional thickness bit-identical. Literature anchor
    /// η ≈ 1.1 for a quiet-wind blunt body; wake-immersed followers fit
    /// higher (pileup the flank flow cannot evacuate).
    pub sheath_eta: f64,
    // ── Pancaking (spec §18, v1.5 — 1 = circular, bit-identical) ────────────
    /// Cross-section aspect A ≥ 1: elliptical section with semi-axes σ/√A
    /// (radial — thinned) and σ·√A (transverse — widened). Area-preserving,
    /// so it carries NO field boost (only the compressive §15/§16 lobes
    /// do). Literature 1 AU aspect ratios run ~2–6; capped at 6.
    pub pancake_a: f64,
}

impl RopeParams {
    pub fn dbm(&self) -> Dbm {
        Dbm {
            d0_km: self.d0_rsun * RSUN_KM,
            v0_kms: self.v0_kms,
            w_kms: self.w_kms,
            gamma_per_km: self.gamma_per_km,
        }
    }
}

impl Default for RopeParams {
    fn default() -> Self {
        RopeParams {
            lon_deg: 0.0,
            lat_deg: 0.0,
            tilt_deg: 0.0,
            handedness: 1.0,
            twist_turns: 4.0,
            b_1au_nt: 20.0,
            sigma_1au_au: 0.115,
            n_b: 1.64,
            n_sigma: 1.14,
            d0_rsun: 21.5,
            v0_kms: 800.0,
            gamma_per_km: 0.2e-7,
            w_kms: 400.0,
            profile: Profile::GoldHoyle,
            sheath_delta_nt: 0.0, // off by default — every pre-sheath pin holds
            sheath_k: 0.8,
            b_amb_1au_nt: 5.0,
            front_c: 0.0,    // off by default — every pre-v1.2 pin holds
            sheath_eta: 0.0, // legacy k mode by default — every pre-v1.4 pin holds
            pancake_a: 1.0,  // circular by default — every pre-v1.5 pin holds
        }
    }
}

/// Orthonormal rope frame. Heliocentric base: ê_r=[1,0,0] (Sun→Earth),
/// ê_E=[0,1,0] (orbital-motion "east"), ê_N=[0,0,1] (north).
///
/// ê_p uses the LOCAL east/north at the launch direction (exact for any
/// lon/lat, reduces to the spec's ê_E/ê_N form at (0°,0°)).
#[derive(Clone, Copy, Debug)]
pub struct Frame {
    pub e_dir: V3,
    pub e_p: V3,
    pub n_hat: V3,
}

impl Frame {
    pub fn new(lon_deg: f64, lat_deg: f64, tilt_deg: f64) -> Frame {
        let (phi, theta, gamma) = (
            lon_deg.to_radians(),
            lat_deg.to_radians(),
            tilt_deg.to_radians(),
        );
        let e_dir = [
            theta.cos() * phi.cos(),
            theta.cos() * phi.sin(),
            theta.sin(),
        ];
        // Local east/north at ê_dir (degenerate only for a polar launch,
        // which is not a physical CME direction; guard anyway).
        let mut e_east = cross([0.0, 0.0, 1.0], e_dir);
        let ee = norm(e_east);
        if ee < 1e-9 {
            e_east = [0.0, 1.0, 0.0];
        } else {
            e_east = scale(e_east, 1.0 / ee);
        }
        let e_north = cross(e_dir, e_east);
        let e_p = [
            gamma.cos() * e_east[0] + gamma.sin() * e_north[0],
            gamma.cos() * e_east[1] + gamma.sin() * e_north[1],
            gamma.cos() * e_east[2] + gamma.sin() * e_north[2],
        ];
        let n_hat = cross(e_dir, e_p);
        Frame { e_dir, e_p, n_hat }
    }
}

/// Field sample: heliocentric-frame B [nT] + inside flag.
#[derive(Clone, Copy, Debug, Default)]
pub struct FieldSample {
    pub b: V3,
    pub inside: bool,
}

/// Cross-section boundary distortion (spec §15 front lobe + §16 rear lobe
/// + §18 pancaking). `shape` scales the boundary and the reference mapping
/// (σ_eff = σ·shape, ŝ = s/shape); `boost` is the flux-conservation field
/// amplification — carried ONLY by the compressive odd lobes: §18
/// pancaking is area-preserving and boosts nothing.
#[derive(Clone, Copy)]
struct Distortion {
    shape: f64,
    boost: f64,
}

const NO_DISTORTION: Distortion = Distortion { shape: 1.0, boost: 1.0 };

/// f(θ) = 1 − c_front·(1+cosθ)/2 − c_rear·(1−cosθ)/2 (odd lobes — thinnest
/// at the snowplowed leading edge for the front lobe, at the
/// follower-squeezed rear for the rear lobe), composed with the even §18
/// flattening g(θ) = 1/√(A·cos²θ + sin²θ/A). Returns the identity when all
/// mechanisms are off, on-axis, or in the (unphysical) degenerate
/// geometries near the footpoints.
#[allow(clippy::too_many_arguments)]
fn boundary_distortion(
    front_c: f64,
    rear_c: f64,
    pancake_a: f64,
    frame: &Frame,
    half_d: f64,
    psi: f64,
    qu: f64,
    w: f64,
    rho_ip: f64,
    p: V3,
    s: f64,
) -> Distortion {
    if (front_c <= 0.0 && rear_c <= 0.0 && pancake_a <= 1.0) || s < 1e-6 {
        return NO_DISTORTION;
    }
    let t_hat = [
        psi.sin() * frame.e_dir[0] + psi.cos() * frame.e_p[0],
        psi.sin() * frame.e_dir[1] + psi.cos() * frame.e_p[1],
        psi.sin() * frame.e_dir[2] + psi.cos() * frame.e_p[2],
    ];
    let q_hat_u = qu / rho_ip;
    let q_hat_w = w / rho_ip;
    let n_pt = add3(
        scale(frame.e_dir, half_d + half_d * q_hat_u),
        scale(frame.e_p, half_d * q_hat_w),
        [0.0, 0.0, 0.0],
    );
    let n_norm = dot(n_pt, n_pt).sqrt();
    if n_norm < 1e-3 {
        return NO_DISTORTION;
    }
    let r_hat = scale([p[0] - n_pt[0], p[1] - n_pt[1], p[2] - n_pt[2]], 1.0 / s);
    let u_hat = scale(n_pt, 1.0 / n_norm);
    // Anti-Sunward direction projected into the cross-section plane (⊥ t̂).
    let ut = dot(u_hat, t_hat);
    let mut o = [u_hat[0] - ut * t_hat[0], u_hat[1] - ut * t_hat[1], u_hat[2] - ut * t_hat[2]];
    let on = dot(o, o).sqrt();
    if on < 1e-9 {
        return NO_DISTORTION;
    }
    o = scale(o, 1.0 / on);
    let cos_th = dot(r_hat, o);
    let f = 1.0 - front_c.clamp(0.0, 0.6) * (1.0 + cos_th) * 0.5
        - rear_c.clamp(0.0, 0.75) * (1.0 - cos_th) * 0.5;
    // §18 even flattening: 1/√(A·cos²θ + sin²θ/A) — thinned along ô (θ = 0
    // and θ = π), widened transverse (θ = ±π/2). Area-preserving.
    let g = if pancake_a > 1.0 {
        let a = pancake_a.min(6.0);
        let c2 = cos_th * cos_th;
        1.0 / (a * c2 + (1.0 - c2) / a).sqrt()
    } else {
        1.0
    };
    Distortion { shape: g * f, boost: 1.0 / f }
}

/// Evaluate the rope field at heliocentric point `p` [km], `t_s` seconds
/// after launch. Returns B in the HELIOCENTRIC frame (§2); callers map to
/// GSE with `to_gse`. The v1 single-rope form: raw kinematics, no §16
/// rear compression.
pub fn field_at(params: &RopeParams, frame: &Frame, t_s: f64, p: V3) -> FieldSample {
    field_at_dyn(params, frame, t_s, p, &SegDbm::single(params.dbm()), 0.0)
}

/// §16-aware rope field: same physics as `field_at` but with EFFECTIVE
/// (segmented, §19/§20-aware) kinematics and a dynamic rear-compression
/// amplitude supplied by the train layer. `rear_c = 0` + the rope's own
/// single-segment DBM reproduces `field_at` bit-for-bit.
pub fn field_at_dyn(
    params: &RopeParams,
    frame: &Frame,
    t_s: f64,
    p: V3,
    dbm: &SegDbm,
    rear_c: f64,
) -> FieldSample {
    let d = dbm.apex_km(t_s);
    if d <= 0.0 {
        return FieldSample::default();
    }
    let half_d = 0.5 * d;

    // Decompose into the rope frame (spec §3).
    let u = dot(p, frame.e_dir);
    let w = dot(p, frame.e_p);
    let h = dot(p, frame.n_hat);

    let qu = u - half_d;
    let rho_ip = (qu * qu + w * w).sqrt();
    if rho_ip < 1e-6 {
        // On the torus center axis: geometrically outside any thin rope.
        return FieldSample::default();
    }
    // ψ=0 at the Sun, ψ=π at the apex.
    let mut psi = w.atan2(-qu);
    if psi < 0.0 {
        psi += core::f64::consts::TAU;
    }
    let s = ((rho_ip - half_d).powi(2) + h * h).sqrt();

    let sigma_apex = sigma_apex_km(params.sigma_1au_au * AU_KM, d, params.n_sigma);
    let taper = (0.5 * psi).sin().powi(2);
    let sigma = sigma_apex * taper;
    if sigma <= 0.0 {
        return FieldSample::default();
    }
    // Boundary distortion (spec §15 front / §16 rear): compressed boundary
    // σ_eff = σ·f, field structure mapped to the reference profile via
    // ŝ = s/f with a flux-conservation boost 1/f. f = 1 when both are off —
    // bit-identical v1 path.
    let dist = boundary_distortion(
        params.front_c, rear_c, params.pancake_a, frame, half_d, psi, qu, w, rho_ip, p, s,
    );
    let sigma_eff = sigma * dist.shape;
    if s >= sigma_eff {
        return FieldSample::default();
    }
    let s_ref = s / dist.shape;
    let boost = dist.boost;

    // Local field frame: tangent, radial, poloidal.
    let t_hat = [
        psi.sin() * frame.e_dir[0] + psi.cos() * frame.e_p[0],
        psi.sin() * frame.e_dir[1] + psi.cos() * frame.e_p[1],
        psi.sin() * frame.e_dir[2] + psi.cos() * frame.e_p[2],
    ];
    let b_ax = b_axis_nt(params.b_1au_nt, d, params.n_b) * boost;

    let (b_axial, b_pol) = match params.profile {
        Profile::GoldHoyle => {
            // Twist per length T = 2τ/d [rad/km] — total turns conserved.
            let t_twist = 2.0 * params.twist_turns / d;
            let denom = 1.0 + t_twist * t_twist * s_ref * s_ref;
            (b_ax / denom, params.handedness * b_ax * t_twist * s_ref / denom)
        }
        Profile::Lundquist => {
            let alpha = J0_ZERO1 / sigma;
            (b_ax * j0(alpha * s_ref), params.handedness * b_ax * j1(alpha * s_ref))
        }
    };

    if s < 1e-6 {
        // On the rope axis: pure axial field (r̂ undefined).
        return FieldSample { b: scale(t_hat, b_axial), inside: true };
    }

    // Nearest axis point N = C + (d/2)·q̂ lifted to the heliocentric frame.
    let q_hat_u = qu / rho_ip;
    let q_hat_w = w / rho_ip;
    let n_pt = add3(
        scale(frame.e_dir, half_d + half_d * q_hat_u),
        scale(frame.e_p, half_d * q_hat_w),
        [0.0, 0.0, 0.0],
    );
    let r_vec = [p[0] - n_pt[0], p[1] - n_pt[1], p[2] - n_pt[2]];
    let r_hat = scale(r_vec, 1.0 / s);
    let phi_hat = cross(t_hat, r_hat);

    FieldSample {
        b: add3(scale(t_hat, b_axial), scale(phi_hat, b_pol), [0.0, 0.0, 0.0]),
        inside: true,
    }
}

/// Heliocentric → GSE at the observer (spec §2): X Earth→Sun, Y duskward,
/// Z north. Valid for observers near the reference (Earth) longitude.
#[inline]
pub fn to_gse(b: V3) -> V3 {
    [-b[0], -b[1], b[2]]
}

/// Is `p` inside this rope's SHEATH (spec §14)? The front-side shell
/// σ(ψ) ≤ s < σ(ψ)·(1 + k), present only while the apex is
/// super-magnetosonic (a shock exists) and only SUNWARD-OUTWARD of the
/// rope surface (|P| > |nearest axis point| — sheaths pile up ahead of the
/// obstacle, not in its wake). The v1 form: raw kinematics, fresh-wind
/// upstream, no §16 rear compression.
pub fn sheath_at(params: &RopeParams, frame: &Frame, t_s: f64, p: V3) -> bool {
    sheath_at_dyn(params, frame, t_s, p, &SegDbm::single(params.dbm()), params.w_kms, 0.0)
}

/// §16-aware sheath test: EFFECTIVE (segmented) kinematics and an explicit
/// upstream flow speed — a follower's shock exists only while it outruns
/// its leader's WAKE magnetosonically, not the fresh wind. The shell rides
/// the same distorted boundary as the field.
pub fn sheath_at_dyn(
    params: &RopeParams,
    frame: &Frame,
    t_s: f64,
    p: V3,
    dbm: &SegDbm,
    upstream_kms: f64,
    rear_c: f64,
) -> bool {
    if params.sheath_delta_nt <= 0.0 || (params.sheath_k <= 0.0 && params.sheath_eta <= 0.0) {
        return false;
    }
    let mach = crate::kinematics::shock_mach(dbm.speed_kms(t_s), upstream_kms);
    if mach <= 1.0 {
        return false;
    }
    let d = dbm.apex_km(t_s);
    if d <= 0.0 {
        return false;
    }
    let half_d = 0.5 * d;
    let u = dot(p, frame.e_dir);
    let w = dot(p, frame.e_p);
    let h = dot(p, frame.n_hat);
    let qu = u - half_d;
    let rho_ip = (qu * qu + w * w).sqrt();
    if rho_ip < 1e-6 {
        return false;
    }
    let mut psi = w.atan2(-qu);
    if psi < 0.0 {
        psi += core::f64::consts::TAU;
    }
    let s = ((rho_ip - half_d).powi(2) + h * h).sqrt();
    let sigma_apex = sigma_apex_km(params.sigma_1au_au * AU_KM, d, params.n_sigma);
    let sigma = sigma_apex * (0.5 * psi).sin().powi(2);
    if sigma <= 0.0 {
        return false;
    }
    // The sheath shell rides the distorted boundary (spec §15/§16).
    let dist = boundary_distortion(
        params.front_c, rear_c, params.pancake_a, frame, half_d, psi, qu, w, rho_ip, p, s,
    );
    let sigma_eff = sigma * dist.shape;
    // Shell outer edge: §17 Farris–Russell standoff on the two-curvature
    // nose proxy √(σ_eff·d/2) when η > 0 — Mach-dependent, growing as the
    // decelerating shock weakens. The η = 0 branch keeps the §14 fixed
    // fraction in its EXACT legacy expression (bit-identical pins).
    let outer_km = if params.sheath_eta > 0.0 {
        sigma_eff
            + params.sheath_eta
                * crate::kinematics::standoff_ratio(mach)
                * (sigma_eff * half_d).sqrt()
    } else {
        sigma_eff * (1.0 + params.sheath_k)
    };
    if s < sigma_eff || s >= outer_km {
        return false;
    }
    // Front side: farther from the Sun than the local axis point.
    let q_hat_u = qu / rho_ip;
    let q_hat_w = w / rho_ip;
    let n_pt = add3(
        scale(frame.e_dir, half_d + half_d * q_hat_u),
        scale(frame.e_p, half_d * q_hat_w),
        [0.0, 0.0, 0.0],
    );
    dot(p, p) > dot(n_pt, n_pt)
}

/// Count of ropes whose SHEATH contains `p` at train time `t_s`.
pub fn sheath_count_at_set(ropes: &[RopeEntry], t_s: f64, p: V3) -> u32 {
    ropes
        .iter()
        .filter(|r| t_s > r.t_launch_s && sheath_at(&r.params, &r.frame, t_s - r.t_launch_s, p))
        .count() as u32
}

/// One rope of a train: parameters + cached frame + launch time offset
/// [s] relative to the engine's t = 0 reference epoch (spec §10).
#[derive(Clone, Copy, Debug)]
pub struct RopeEntry {
    pub params: RopeParams,
    pub frame: Frame,
    pub t_launch_s: f64,
}

impl RopeEntry {
    pub fn new(params: RopeParams, t_launch_s: f64) -> RopeEntry {
        RopeEntry {
            frame: Frame::new(params.lon_deg, params.lat_deg, params.tilt_deg),
            params,
            t_launch_s,
        }
    }
}

// ── CME–CME interaction (spec §16) ───────────────────────────────────────────

/// Engine-level interaction configuration (spec §16, §19–§21), shared
/// across ensemble members (never sampled). Everything defaults OFF —
/// every earlier-generation pin is bit-identical with the defaults.
#[derive(Clone, Copy, Debug)]
pub struct TrainCfg {
    pub enabled: bool,
    /// Drag reduction inside a leader's wake: Γ_eff = Γ · this.
    pub wake_gamma_frac: f64,
    /// Scale ∈ [0, 1] on the R–H-derived rear-compression amplitude.
    pub comp_c: f64,
    /// Rear-compression gap ramp reach, in units of the leader's σ̂_apex.
    pub comp_reach: f64,
    /// §19 momentum exchange at follower→leader contact.
    pub momentum_enabled: bool,
    /// §19.2 restitution ε ∈ [0, 1]: 0 = perfectly inelastic (default),
    /// 1 = elastic. The one collision calibration knob.
    pub restitution: f64,
    /// §20 wake re-freeze cadence [h]; 0 = frozen-at-launch legacy.
    pub wake_refresh_h: f64,
    /// §21 pair wake attraction ∈ [0, 1]: fraction of the follower→leader
    /// angular separation rotated toward the leader (capped 20°). 0 = off.
    pub defl_pair: f64,
    /// §21 east–west drag drift amplitude [deg]: Δφ = this ·
    /// clamp((v₀−w)/w, −1, 1). 0 = off.
    pub defl_ew_deg: f64,
}

impl Default for TrainCfg {
    fn default() -> Self {
        TrainCfg {
            enabled: false,
            wake_gamma_frac: 0.5,
            comp_c: 1.0,
            comp_reach: 1.5,
            momentum_enabled: false,
            restitution: 0.0,
            wake_refresh_h: 0.0,
            defl_pair: 0.0,
            defl_ew_deg: 0.0,
        }
    }
}

/// Launch-direction alignment threshold for partner selection (spec §16).
pub const ALIGN_MIN_COS: f64 = 0.5;
/// §20: wake refreshes stop at this rope age — beyond ~1.3 AU the wake's
/// evolution no longer matters for the L1 crossing (and it bounds the
/// segment count).
pub const WAKE_REFRESH_MAX_AGE_S: f64 = 96.0 * 3600.0;
/// §19.1 contact-search horizon after both launches.
pub const CONTACT_HORIZON_S: f64 = 10.0 * 86_400.0;
/// §21 pair-attraction rotation cap [rad].
const DEFL_PAIR_CAP_RAD: f64 = 20.0 * core::f64::consts::PI / 180.0;

/// Per-rope effective dynamics under interaction (spec §16/§19/§20/§21):
/// segmented wake-modified kinematics, the leader index (−1 = none), the
/// EFFECTIVE frame (§21 deflection applied; the raw entry's frame
/// otherwise), and the §19 contact time (s after epoch; NaN = none).
/// With interaction disabled every rope keeps its raw single-segment DBM,
/// its raw frame, and no partners exist.
#[derive(Clone, Copy, Debug)]
pub struct RopeDyn {
    pub dbm: SegDbm,
    pub lead: i32,
    pub frame: Frame,
    pub contact_s: f64,
}

#[inline]
fn sigma_hat_km(r: &RopeEntry, d_km: f64) -> f64 {
    sigma_apex_km(r.params.sigma_1au_au * AU_KM, d_km, r.params.n_sigma)
}

/// §19.1 contact time for follower j on leader i: first root of the
/// nose-to-tail gap over the CURRENT segment chains. Coarse 4-h scan for
/// the sign change, then 60-iteration bisection. None = no contact within
/// the horizon.
fn contact_time(ropes: &[RopeEntry], dyns: &[RopeDyn], i: usize, j: usize) -> Option<f64> {
    let gap = |t: f64| {
        let d_i = dyns[i].dbm.apex_km(t - ropes[i].t_launch_s);
        let d_j = dyns[j].dbm.apex_km(t - ropes[j].t_launch_s);
        (d_i - sigma_hat_km(&ropes[i], d_i)) - (d_j + sigma_hat_km(&ropes[j], d_j))
    };
    let t0 = ropes[i].t_launch_s.max(ropes[j].t_launch_s) + 60.0;
    if gap(t0) <= 0.0 {
        return Some(t0); // overlapping already at the later launch
    }
    let step = 4.0 * 3600.0;
    let mut t_prev = t0;
    let mut t = t0 + step;
    while t <= t0 + CONTACT_HORIZON_S {
        if gap(t) <= 0.0 {
            let (mut lo, mut hi) = (t_prev, t);
            for _ in 0..60 {
                let mid = 0.5 * (lo + hi);
                if gap(mid) > 0.0 {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            return Some(0.5 * (lo + hi));
        }
        t_prev = t;
        t += step;
    }
    None
}

/// Rotate `from` toward `to` by `frac` of their separation, capped (§21).
fn rotate_toward(from: V3, to: V3, frac: f64, cap_rad: f64) -> V3 {
    let c = dot(from, to).clamp(-1.0, 1.0);
    let ang = c.acos();
    if ang < 1e-9 {
        return from;
    }
    let step = (frac.clamp(0.0, 1.0) * ang).min(cap_rad);
    // Slerp in the from–to plane.
    let sin_ang = ang.sin();
    let a = ((ang - step).sin()) / sin_ang;
    let b = (step.sin()) / sin_ang;
    let v = [
        a * from[0] + b * to[0],
        a * from[1] + b * to[1],
        a * from[2] + b * to[2],
    ];
    let n = norm(v);
    scale(v, 1.0 / n.max(1e-12))
}

/// Resolve the train's interaction structure (spec §16 + v1.6 §19–§21) in
/// three passes, leader-first in launch order so chains (A←B←C) see their
/// leader's already-modified state:
///   0. partner selection on RAW directions + §21 effective frames;
///   1. wake kinematics — §16 frozen w_eff at launch, then §20 refresh
///      segments from the leader's LIVE chain, with overtake → fresh wind;
///   2. §19 contacts in time order — bisected gap roots, momentum-conserving
///      impulses, follower re-frozen at the leader's post-impulse speed.
/// Fills `out` (cleared) with one entry per rope, in rope order.
pub fn train_dyn(ropes: &[RopeEntry], cfg: &TrainCfg, out: &mut Vec<RopeDyn>) {
    out.clear();
    for r in ropes {
        out.push(RopeDyn {
            dbm: SegDbm::single(r.params.dbm()),
            lead: -1,
            frame: r.frame,
            contact_s: f64::NAN,
        });
    }
    if !cfg.enabled || ropes.len() < 2 {
        return;
    }
    // Launch order, stable on ties by index (n ≤ MAX_ROPES → O(n²) is fine).
    let mut order: Vec<usize> = (0..ropes.len()).collect();
    order.sort_by(|&a, &b| {
        ropes[a]
            .t_launch_s
            .partial_cmp(&ropes[b].t_launch_s)
            .unwrap()
            .then(a.cmp(&b))
    });

    // Pass 0 — partners (raw directions; deflection is a small correction
    // and must not feed back into its own pairing) + §21 effective frames.
    for oi in 1..order.len() {
        let j = order[oi];
        let lead = order[..oi]
            .iter()
            .rev()
            .copied()
            .find(|&i| dot(ropes[i].frame.e_dir, ropes[j].frame.e_dir) > ALIGN_MIN_COS);
        if let Some(i) = lead {
            out[j].lead = i as i32;
        }
    }
    if cfg.defl_pair > 0.0 || cfg.defl_ew_deg != 0.0 {
        for k in 0..ropes.len() {
            let mut dir = ropes[k].frame.e_dir;
            if cfg.defl_pair > 0.0 && out[k].lead >= 0 {
                dir = rotate_toward(
                    dir,
                    ropes[out[k].lead as usize].frame.e_dir,
                    cfg.defl_pair,
                    DEFL_PAIR_CAP_RAD,
                );
            }
            let mut lon = dir[1].atan2(dir[0]).to_degrees();
            let lat = dir[2].clamp(-1.0, 1.0).asin().to_degrees();
            if cfg.defl_ew_deg != 0.0 {
                let p = &ropes[k].params;
                lon += cfg.defl_ew_deg * ((p.v0_kms - p.w_kms) / p.w_kms.max(1.0)).clamp(-1.0, 1.0);
            }
            out[k].frame = Frame::new(lon, lat, ropes[k].params.tilt_deg);
        }
    }

    // Pass 1 — wake kinematics (§16 freeze + §20 refreshes), leader-first.
    for oi in 1..order.len() {
        let j = order[oi];
        if out[j].lead < 0 {
            continue;
        }
        let i = out[j].lead as usize;
        let p_j = &ropes[j].params;
        let g_eff = p_j.gamma_per_km * cfg.wake_gamma_frac.max(0.0);
        let dt = (ropes[j].t_launch_s - ropes[i].t_launch_s).max(0.0);
        let w_eff = out[i].dbm.speed_kms(dt).max(p_j.w_kms);
        out[j].dbm = SegDbm::single(Dbm {
            w_kms: w_eff,
            gamma_per_km: g_eff,
            ..p_j.dbm()
        });
        if cfg.wake_refresh_h > 0.0 {
            let step = cfg.wake_refresh_h * 3600.0;
            let mut age = step;
            while age <= WAKE_REFRESH_MAX_AGE_S {
                let t_abs = ropes[j].t_launch_s + age;
                let age_i = t_abs - ropes[i].t_launch_s;
                let d_j = out[j].dbm.apex_km(age);
                let d_i = out[i].dbm.apex_km(age_i);
                if d_j + sigma_hat_km(&ropes[j], d_j) > d_i {
                    // Overtaken the leader's apex → fresh wind, raw drag.
                    out[j].dbm.push_regime(age, p_j.w_kms, p_j.gamma_per_km);
                    break;
                }
                let w_new = out[i].dbm.speed_kms(age_i).max(p_j.w_kms);
                out[j].dbm.push_regime(age, w_new, g_eff);
                age += step;
            }
        }
    }

    // Pass 2 — §19 contacts, earliest first (chains see post-impulse speeds).
    if cfg.momentum_enabled {
        loop {
            let mut best: Option<(f64, usize)> = None;
            for j in 0..ropes.len() {
                if out[j].lead < 0 || !out[j].contact_s.is_nan() {
                    continue;
                }
                let i = out[j].lead as usize;
                if let Some(tc) = contact_time(ropes, out, i, j) {
                    if best.map_or(true, |(bt, _)| tc < bt) {
                        best = Some((tc, j));
                    }
                }
            }
            let Some((tc, j)) = best else { break };
            let i = out[j].lead as usize;
            let age_i = tc - ropes[i].t_launch_s;
            let age_j = tc - ropes[j].t_launch_s;
            let v_i = out[i].dbm.speed_kms(age_i);
            let v_j = out[j].dbm.speed_kms(age_j);
            out[j].contact_s = tc;
            let u = v_j - v_i;
            if u <= 0.0 {
                continue; // expansion-driven touch, no closing momentum
            }
            // §19.2: masses ∝ σ₁AU² (fixed exponent), restitution ε.
            let m_i = ropes[i].params.sigma_1au_au * ropes[i].params.sigma_1au_au;
            let m_j = ropes[j].params.sigma_1au_au * ropes[j].params.sigma_1au_au;
            let r = (m_j / m_i.max(1e-12)).max(1e-6);
            let e = cfg.restitution.clamp(0.0, 1.0);
            let v_i2 = v_i + (1.0 + e) * r / (1.0 + r) * u;
            let v_j2 = v_j - (1.0 + e) / (1.0 + r) * u;
            // Leader: keep its CURRENT flow regime, jump the speed.
            let (w_i_cur, g_i_cur) = out[i].dbm.regime_at(age_i);
            out[i].dbm.truncate_after(age_i);
            out[i].dbm.push_impulse(age_i, v_i2, w_i_cur, g_i_cur);
            // Follower: the pair is now one system — it adopts the LEADER's
            // flow regime (merged-system approximation, spec §19.2). With
            // ε = 0 the identical (v, w, Γ) keep the two chains EXACTLY
            // co-moving, so the §16 rear squeeze relaxes (M_rel = 0)
            // instead of a stale frozen wake artificially re-closing them.
            out[j].dbm.truncate_after(age_j);
            out[j].dbm.push_impulse(age_j, v_j2, w_i_cur, g_i_cur);
        }
    }
}

/// Rear-compression amplitude on rope k at train time t (spec §16): the
/// strongest follower-driven squeeze; 0 unless a follower is closing
/// super-magnetosonically within `comp_reach·σ̂` of the leader's tail line.
pub fn rear_c_at(
    ropes: &[RopeEntry],
    dyns: &[RopeDyn],
    cfg: &TrainCfg,
    k: usize,
    t_s: f64,
) -> f64 {
    if !cfg.enabled || cfg.comp_c <= 0.0 {
        return 0.0;
    }
    let age_k = t_s - ropes[k].t_launch_s;
    if age_k <= 0.0 {
        return 0.0;
    }
    let d_i = dyns[k].dbm.apex_km(age_k);
    let sig_i = sigma_apex_km(ropes[k].params.sigma_1au_au * AU_KM, d_i, ropes[k].params.n_sigma);
    if sig_i <= 0.0 {
        return 0.0;
    }
    let v_i = dyns[k].dbm.speed_kms(age_k);
    let mut c = 0.0f64;
    for (j, dj) in dyns.iter().enumerate() {
        if dj.lead != k as i32 {
            continue;
        }
        let age_j = t_s - ropes[j].t_launch_s;
        if age_j <= 0.0 {
            continue;
        }
        let d_j = dj.dbm.apex_km(age_j);
        let sig_j =
            sigma_apex_km(ropes[j].params.sigma_1au_au * AU_KM, d_j, ropes[j].params.n_sigma);
        let gap = (d_i - sig_i) - (d_j + sig_j);
        let q = (1.0 - gap / (cfg.comp_reach.max(1e-6) * sig_i)).clamp(0.0, 1.0);
        if q <= 0.0 {
            continue;
        }
        let m_rel =
            ((dj.dbm.speed_kms(age_j) - v_i) / crate::kinematics::V_MS_KMS).max(0.0);
        let x = crate::kinematics::compression_ratio(m_rel);
        c = c.max((cfg.comp_c.clamp(0.0, 1.0) * (1.0 - 1.0 / x) * q).clamp(0.0, 0.75));
    }
    c
}

/// Upstream flow speed for rope k's sheath Mach (spec §16): a follower rams
/// its leader's LIVE wake flow (proxied by the leader's apex speed), never
/// slower than the rope's own ambient; a leader sees the fresh wind.
pub fn upstream_kms(ropes: &[RopeEntry], dyns: &[RopeDyn], k: usize, t_s: f64) -> f64 {
    let w = ropes[k].params.w_kms;
    if dyns[k].lead < 0 {
        return w;
    }
    let li = dyns[k].lead as usize;
    let age_l = t_s - ropes[li].t_launch_s;
    if age_l <= 0.0 {
        return w;
    }
    dyns[li].dbm.speed_kms(age_l).max(w)
}

/// §16-aware train field: superposition with wake kinematics + dynamic rear
/// compression, evaluated in each rope's EFFECTIVE (§21-deflected) frame.
/// With interaction disabled this is exactly `field_at_set`.
pub fn field_at_train(
    ropes: &[RopeEntry],
    dyns: &[RopeDyn],
    cfg: &TrainCfg,
    t_s: f64,
    p: V3,
) -> (V3, u32) {
    let mut b = [0.0, 0.0, 0.0];
    let mut count = 0u32;
    for (k, r) in ropes.iter().enumerate() {
        let dt = t_s - r.t_launch_s;
        if dt <= 0.0 {
            continue; // not launched yet — DBM is undefined for dt < 0
        }
        let rc = rear_c_at(ropes, dyns, cfg, k, t_s);
        let fs = field_at_dyn(&r.params, &dyns[k].frame, dt, p, &dyns[k].dbm, rc);
        if fs.inside {
            count += 1;
            b[0] += fs.b[0];
            b[1] += fs.b[1];
            b[2] += fs.b[2];
        }
    }
    (b, count)
}

/// §16-aware sheath containment count over the train.
pub fn sheath_count_at_train(
    ropes: &[RopeEntry],
    dyns: &[RopeDyn],
    cfg: &TrainCfg,
    t_s: f64,
    p: V3,
) -> u32 {
    ropes
        .iter()
        .enumerate()
        .filter(|(k, r)| {
            let dt = t_s - r.t_launch_s;
            dt > 0.0
                && sheath_at_dyn(
                    &r.params,
                    &dyns[*k].frame,
                    dt,
                    p,
                    &dyns[*k].dbm,
                    upstream_kms(ropes, dyns, *k, t_s),
                    rear_c_at(ropes, dyns, cfg, *k, t_s),
                )
        })
        .count() as u32
}

/// Evaluate a rope TRAIN at heliocentric point `p` [km], `t_s` seconds after
/// the reference epoch: field SUPERPOSITION over all launched ropes, plus
/// the containment count. count ≥ 2 marks exactly where the v1
/// no-interaction assumption breaks (spec §10) — report it, never hide it.
pub fn field_at_set(ropes: &[RopeEntry], t_s: f64, p: V3) -> (V3, u32) {
    let mut b = [0.0, 0.0, 0.0];
    let mut count = 0u32;
    for r in ropes {
        let dt = t_s - r.t_launch_s;
        if dt <= 0.0 {
            continue; // not launched yet — DBM is undefined for dt < 0
        }
        let fs = field_at(&r.params, &r.frame, dt, p);
        if fs.inside {
            count += 1;
            b[0] += fs.b[0];
            b[1] += fs.b[1];
            b[2] += fs.b[2];
        }
    }
    (b, count)
}

/// Observer heliocentric position from (r [AU], lon, lat [deg]).
pub fn observer_pos(r_au: f64, lon_deg: f64, lat_deg: f64) -> V3 {
    let (phi, theta) = (lon_deg.to_radians(), lat_deg.to_radians());
    scale(
        [
            theta.cos() * phi.cos(),
            theta.cos() * phi.sin(),
            theta.sin(),
        ],
        r_au * AU_KM,
    )
}

/// Synthesize the virtual-spacecraft series (spec §6, §10, §14, §16): n GSE
/// samples starting `t0_s` after the reference epoch at `dt_s` spacing,
/// over a rope TRAIN under the given interaction config. Writes
/// (bx, by, bz, count_code) per step into `out` (len ≥ 4·n), where
/// `count_code = rope_count + 100·sheath_count` — decode with % 100 (rope
/// containment) and / 100 (sheath containment).
/// The DETERMINISTIC series carries no sheath field (its Bz is zero-mean
/// stochastic and lives in the ensemble, spec §14) — only the flags.
/// Returns the number of steps with rope containment ≥ 1. A single
/// sheathless rope reproduces the v1 behavior exactly (code is 0/1).
pub fn synth_series(
    ropes: &[RopeEntry],
    cfg: &TrainCfg,
    t0_s: f64,
    dt_s: f64,
    n: usize,
    obs: V3,
    out: &mut [f32],
) -> usize {
    let mut dyns: Vec<RopeDyn> = Vec::with_capacity(ropes.len());
    train_dyn(ropes, cfg, &mut dyns);
    let mut hits = 0;
    for i in 0..n {
        let t = t0_s + dt_s * i as f64;
        let (b, count) = field_at_train(ropes, &dyns, cfg, t, obs);
        let sheath = sheath_count_at_train(ropes, &dyns, cfg, t, obs);
        let g = to_gse(b);
        out[4 * i] = g[0] as f32;
        out[4 * i + 1] = g[1] as f32;
        out[4 * i + 2] = g[2] as f32;
        out[4 * i + 3] = (count + 100 * sheath) as f32;
        if count > 0 {
            hits += 1;
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn earth() -> V3 {
        observer_pos(1.0, 0.0, 0.0)
    }

    /// Time at which the apex reaches the observer distance (bisection).
    fn arrival_time_s(p: &RopeParams, r_km: f64) -> f64 {
        let dbm = p.dbm();
        let (mut lo, mut hi) = (0.0, 10.0 * 86_400.0);
        for _ in 0..200 {
            let mid = 0.5 * (lo + hi);
            if dbm.apex_km(mid) < r_km {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        0.5 * (lo + hi)
    }

    #[test]
    fn frame_is_orthonormal_and_matches_conventions() {
        for (lon, lat, tilt) in [(0.0, 0.0, 0.0), (-12.0, 8.0, 55.0), (30.0, -20.0, -90.0)] {
            let f = Frame::new(lon, lat, tilt);
            assert!(dot(f.e_dir, f.e_p).abs() < 1e-12);
            assert!(dot(f.e_dir, f.n_hat).abs() < 1e-12);
            assert!((norm(f.e_p) - 1.0).abs() < 1e-12);
        }
        // Spec §3 conventions at Earth-directed launch:
        let f0 = Frame::new(0.0, 0.0, 0.0);
        assert!((f0.e_p[1] - 1.0).abs() < 1e-12, "tilt 0 → ê_p = ê_E");
        let f90 = Frame::new(0.0, 0.0, 90.0);
        assert!((f90.e_p[2] - 1.0).abs() < 1e-12, "tilt 90 → ê_p = ê_N");
    }

    #[test]
    fn apex_geometry() {
        // The rope apex must carry field exactly at distance d along ê_dir.
        let p = RopeParams::default();
        let f = Frame::new(0.0, 0.0, 0.0);
        let t = 40.0 * 3600.0;
        let d = p.dbm().apex_km(t);
        // Just inside the apex (the boundary itself is exclusive).
        let probe = [d * 0.999, 0.0, 0.0];
        assert!(field_at(&p, &f, t, probe).inside, "apex interior should be inside");
        // Well beyond the apex: outside.
        let probe_out = [d * 1.3, 0.0, 0.0];
        assert!(!field_at(&p, &f, t, probe_out).inside);
    }

    #[test]
    fn tilt_maps_axial_field_into_the_expected_gse_component() {
        // Head-on apex crossing. tilt 90° → apex tangent = −ê_N → axial field
        // gives NEGATIVE Bz_GSE (spec §3). tilt 0° → tangent −ê_E → +By_GSE.
        let mut p = RopeParams { tilt_deg: 90.0, ..Default::default() };
        let t = arrival_time_s(&p, AU_KM) + 3600.0;
        let f90 = Frame::new(0.0, 0.0, 90.0);
        let fs = field_at(&p, &f90, t, earth());
        assert!(fs.inside, "head-on rope must engulf Earth just after arrival");
        let g = to_gse(fs.b);
        assert!(g[2] < 0.0, "tilt +90 axial → Bz south, got {:?}", g);
        assert!(g[2].abs() > g[1].abs(), "Bz should dominate By at 90° tilt");

        p.tilt_deg = 0.0;
        let f0 = Frame::new(0.0, 0.0, 0.0);
        let g0 = to_gse(field_at(&p, &f0, t, earth()).b);
        assert!(g0[1] > 0.0, "tilt 0 axial → +By, got {:?}", g0);
        assert!(g0[1].abs() > g0[2].abs());
    }

    #[test]
    fn handedness_flips_the_poloidal_rotation_only() {
        let base = RopeParams { tilt_deg: 90.0, ..Default::default() };
        let flip = RopeParams { handedness: -1.0, ..base };
        let fr = Frame::new(0.0, 0.0, 90.0);
        // Off-apex-center probe so the poloidal component is nonzero: sit
        // slightly north of Earth inside the rope.
        let t = arrival_time_s(&base, AU_KM) + 3600.0;
        let probe = [AU_KM * 0.98, 0.0, AU_KM * 0.02];
        let b1 = field_at(&base, &fr, t, probe);
        let b2 = field_at(&flip, &fr, t, probe);
        assert!(b1.inside && b2.inside);
        // Axial parts equal; poloidal parts opposite → sum = 2×axial.
        let sum = [b1.b[0] + b2.b[0], b1.b[1] + b2.b[1], b1.b[2] + b2.b[2]];
        let t_hat_dir = scale(sum, 0.5);
        // The averaged field must be (numerically) the pure axial part: check
        // it is parallel to the difference-free direction by re-evaluating the
        // magnitudes: |b1| == |b2| under a pure poloidal sign flip.
        assert!((norm(b1.b) - norm(b2.b)).abs() < 1e-9);
        assert!(norm(t_hat_dir) > 0.0);
    }

    #[test]
    fn gold_hoyle_profile_shape() {
        // On-axis field = pure axial with magnitude B_axis(d); poloidal/axial
        // ratio = T·s off axis (uniform twist).
        let p = RopeParams { tilt_deg: 90.0, ..Default::default() };
        let f = Frame::new(0.0, 0.0, 90.0);
        let t = arrival_time_s(&p, AU_KM);
        let d = p.dbm().apex_km(t);
        let apex_axis_probe = [d - 1.0, 0.0, 0.0]; // 1 km inside the apex axis
        let fs = field_at(&p, &f, t, apex_axis_probe);
        assert!(fs.inside);
        let expected = b_axis_nt(p.b_1au_nt, d, p.n_b);
        assert!(
            (norm(fs.b) - expected).abs() / expected < 1e-3,
            "axis |B| {} vs B_axis {}",
            norm(fs.b),
            expected
        );
    }

    #[test]
    fn lundquist_vanishing_axial_at_boundary() {
        let p = RopeParams { profile: Profile::Lundquist, tilt_deg: 90.0, ..Default::default() };
        let f = Frame::new(0.0, 0.0, 90.0);
        let t = arrival_time_s(&p, AU_KM);
        let d = p.dbm().apex_km(t);
        let sigma = sigma_apex_km(p.sigma_1au_au * AU_KM, d, p.n_sigma);
        // Probe just inside the boundary at the apex, offset radially inward
        // along x from the apex axis point (d,0,0):
        let probe = [d - 0.999 * sigma, 0.0, 0.0];
        let fs = field_at(&p, &f, t, probe);
        assert!(fs.inside);
        // Near the J0 zero, the axial component ~0 → field ≈ purely poloidal.
        let axial = dot(fs.b, [0.0, 0.0, -1.0]); // apex tangent at tilt 90 = −ê_N
        assert!(axial.abs() < 0.05 * norm(fs.b), "axial {} of |B| {}", axial, norm(fs.b));
    }

    #[test]
    fn synth_series_head_on_has_rope_class_duration() {
        // St-Patrick-class rope: ~1 AU crossing at ~600 km/s with σ₁AU=0.115
        // AU should dwell 10–30 h — the Lepping statistical envelope.
        let p = RopeParams { v0_kms: 1100.0, tilt_deg: 90.0, ..Default::default() };
        let n = 400;
        let dt = 1800.0;
        let mut out = vec![0.0f32; 4 * n];
        let hits = synth_series(&[RopeEntry::new(p, 0.0)], &TrainCfg::default(), 0.0, dt, n, earth(), &mut out);
        let dwell_h = hits as f64 * dt / 3600.0;
        assert!(
            (10.0..=30.0).contains(&dwell_h),
            "rope dwell {} h outside the statistical envelope",
            dwell_h
        );
        // Bz must go south hard for this configuration (tilt +90, H +1).
        let min_bz = (0..n).map(|i| out[4 * i + 2]).fold(f32::INFINITY, f32::min);
        assert!(min_bz < -5.0, "min Bz {}", min_bz);
    }

    #[test]
    fn far_flank_miss_produces_no_signal() {
        // 90° away in longitude: the rope never reaches the observer.
        let p = RopeParams { lon_deg: 90.0, ..Default::default() };
        let n = 400;
        let mut out = vec![0.0f32; 4 * n];
        let hits = synth_series(&[RopeEntry::new(p, 0.0)], &TrainCfg::default(), 0.0, 1800.0, n, earth(), &mut out);
        assert_eq!(hits, 0);
    }

    #[test]
    fn train_sequential_ropes_arrive_in_launch_order() {
        // Two identical head-on ropes launched 30 h apart → two disjoint
        // crossing intervals in launch order, no overlap (they never share
        // the observer because the expansion keeps pace with separation).
        let p = RopeParams { v0_kms: 1400.0, tilt_deg: 90.0, sigma_1au_au: 0.06, ..Default::default() };
        let train = [RopeEntry::new(p, 0.0), RopeEntry::new(p, 30.0 * 3600.0)];
        let n = 600;
        let dt = 1800.0;
        let mut out = vec![0.0f32; 4 * n];
        synth_series(&train, &TrainCfg::default(), 0.0, dt, n, earth(), &mut out);
        let counts: Vec<u32> = (0..n).map(|i| out[4 * i + 3] as u32).collect();
        let first_a = counts.iter().position(|&c| c > 0).expect("rope 1 must arrive");
        let last = counts.iter().rposition(|&c| c > 0).unwrap();
        // Second crossing exists and there is a clean gap between them.
        let gap = (first_a..last).any(|i| counts[i] == 0);
        assert!(gap, "two 30 h-spaced ropes must produce disjoint crossings");
        // Arrival separation ≈ launch separation (same kinematics): 30 h ± 4 h.
        let mut edges = vec![];
        for i in 1..n {
            if counts[i] > 0 && counts[i - 1] == 0 {
                edges.push(i as f64 * dt / 3600.0);
            }
        }
        assert_eq!(edges.len(), 2, "exactly two onsets, got {:?}", edges);
        assert!((edges[1] - edges[0] - 30.0).abs() < 4.0, "onsets {:?}", edges);
    }

    #[test]
    fn train_superposition_sums_fields_and_counts_overlap() {
        // Two ropes launched close together: where both contain the point,
        // the field is the vector SUM and the count is 2 — the honest
        // no-interaction diagnostic (spec §10).
        let p = RopeParams { v0_kms: 1100.0, tilt_deg: 90.0, ..Default::default() };
        let a = RopeEntry::new(p, 0.0);
        let b = RopeEntry::new(p, 4.0 * 3600.0);
        let t = 55.0 * 3600.0;
        // Find an overlap point near the trailing edge of rope 1.
        let mut probe = None;
        for k in 0..200 {
            let x = (0.5 + 0.5 * k as f64 / 200.0) * AU_KM;
            let pt = [x, 0.0, 0.0];
            let ia = field_at(&a.params, &a.frame, t, pt).inside;
            let ib = field_at(&b.params, &b.frame, t - b.t_launch_s, pt).inside;
            if ia && ib {
                probe = Some(pt);
                break;
            }
        }
        let pt = probe.expect("4 h-spaced identical ropes must overlap somewhere");
        let fa = field_at(&a.params, &a.frame, t, pt).b;
        let fb = field_at(&b.params, &b.frame, t - b.t_launch_s, pt).b;
        let (sum, count) = field_at_set(&[a, b], t, pt);
        assert_eq!(count, 2);
        for i in 0..3 {
            assert!((sum[i] - (fa[i] + fb[i])).abs() < 1e-9);
        }
    }

    #[test]
    fn sheath_flags_precede_the_rope_and_need_a_shock() {
        // Fast rope with sheath: the deterministic series must flag a sheath
        // interval (count code ≥ 100) BEFORE first rope containment, carry
        // zero deterministic Bz there, and a sub-magnetosonic rope must
        // produce no sheath at all.
        let fast = RopeParams {
            v0_kms: 1100.0,
            tilt_deg: 90.0,
            sheath_delta_nt: 3.0,
            ..Default::default()
        };
        let n = 400;
        let mut out = vec![0.0f32; 4 * n];
        synth_series(&[RopeEntry::new(fast, 0.0)], &TrainCfg::default(), 0.0, 1800.0, n, earth(), &mut out);
        let codes: Vec<u32> = (0..n).map(|i| out[4 * i + 3] as u32).collect();
        let first_rope = codes.iter().position(|c| c % 100 > 0).expect("rope must arrive");
        let first_sheath = codes.iter().position(|c| c / 100 > 0).expect("sheath must exist");
        assert!(
            first_sheath < first_rope,
            "shock/sheath at step {} must precede rope at {}",
            first_sheath,
            first_rope
        );
        for i in first_sheath..first_rope {
            if codes[i] / 100 > 0 && codes[i] % 100 == 0 {
                assert_eq!(out[4 * i + 2], 0.0, "deterministic sheath Bz must be 0");
            }
        }
        // Slow rope (v0 = w + 50 < w + V_MS): no shock, no sheath, ever.
        let slow = RopeParams {
            v0_kms: 450.0,
            sheath_delta_nt: 3.0,
            ..Default::default()
        };
        let mut out2 = vec![0.0f32; 4 * n];
        synth_series(&[RopeEntry::new(slow, 0.0)], &TrainCfg::default(), 0.0, 3600.0, n, earth(), &mut out2);
        assert!(
            (0..n).all(|i| (out2[4 * i + 3] as u32) / 100 == 0),
            "sub-magnetosonic rope must have no sheath"
        );
    }

    #[test]
    fn front_compression_thins_the_front_and_boosts_its_field() {
        // At the apex, the FRONT boundary sits at d + σ(1−c) while the back
        // stays at d − σ; a point inside the compressed front carries a
        // flux-conservation-boosted field vs the same c = 0 rope.
        let base = RopeParams { v0_kms: 1100.0, tilt_deg: 90.0, ..Default::default() };
        let comp = RopeParams { front_c: 0.4, ..base };
        let fr = Frame::new(0.0, 0.0, 90.0);
        let t = arrival_time_s(&base, AU_KM);
        let d = base.dbm().apex_km(t);
        let sigma = sigma_apex_km(base.sigma_1au_au * AU_KM, d, base.n_sigma);
        // s = 0.8σ on the FRONT: inside for c = 0, OUTSIDE for c = 0.4
        // (σ_eff = 0.6σ at the nose).
        let front_probe = [d + 0.8 * sigma, 0.0, 0.0];
        assert!(field_at(&base, &fr, t, front_probe).inside);
        assert!(!field_at(&comp, &fr, t, front_probe).inside);
        // The BACK boundary is untouched (θ = π → f = 1).
        let back_probe = [d - 0.9 * sigma, 0.0, 0.0];
        assert!(field_at(&base, &fr, t, back_probe).inside);
        assert!(field_at(&comp, &fr, t, back_probe).inside);
        // Inside the compressed front (s = 0.3σ < 0.6σ): |B| boosted.
        let mid_front = [d + 0.3 * sigma, 0.0, 0.0];
        let b0 = field_at(&base, &fr, t, mid_front);
        let bc = field_at(&comp, &fr, t, mid_front);
        assert!(b0.inside && bc.inside);
        let mag = |b: V3| dot(b, b).sqrt();
        assert!(
            mag(bc.b) > 1.2 * mag(b0.b),
            "front field must be compressed-boosted: {} vs {}",
            mag(bc.b),
            mag(b0.b)
        );
    }

    #[test]
    fn front_compression_moves_the_bz_minimum_toward_onset() {
        // THE v1.2 claim (spec §15): the crossing's Bz extremum shifts toward
        // the leading edge — measured as the min-index fraction of the dwell.
        let base = RopeParams { v0_kms: 1100.0, tilt_deg: 90.0, ..Default::default() };
        let comp = RopeParams { front_c: 0.45, ..base };
        let n = 800;
        let dt = 900.0;
        let frac_of_dwell_at_min = |p: RopeParams| {
            let mut out = vec![0.0f32; 4 * n];
            synth_series(&[RopeEntry::new(p, 0.0)], &TrainCfg::default(), 0.0, dt, n, earth(), &mut out);
            let codes: Vec<u32> = (0..n).map(|i| out[4 * i + 3] as u32 % 100).collect();
            let first = codes.iter().position(|&c| c > 0).unwrap();
            let last = codes.iter().rposition(|&c| c > 0).unwrap();
            let mut i_min = first;
            for i in first..=last {
                if out[4 * i + 2] < out[4 * i_min + 2] {
                    i_min = i;
                }
            }
            (i_min - first) as f64 / (last - first).max(1) as f64
        };
        let f0 = frac_of_dwell_at_min(base);
        let fc = frac_of_dwell_at_min(comp);
        assert!(
            fc < f0 - 0.1,
            "min must move toward the leading edge: {:.2} vs {:.2} of dwell",
            fc,
            f0
        );
        assert!(fc < 0.35, "compressed rope min must sit in the front third: {:.2}", fc);
    }

    #[test]
    fn front_compression_zero_is_bit_identical() {
        let a = RopeParams { v0_kms: 1100.0, tilt_deg: 90.0, ..Default::default() };
        let b = RopeParams { front_c: 0.0, ..a };
        let n = 300;
        let (mut oa, mut ob) = (vec![0.0f32; 4 * n], vec![0.0f32; 4 * n]);
        synth_series(&[RopeEntry::new(a, 0.0)], &TrainCfg::default(), 0.0, 1800.0, n, earth(), &mut oa);
        synth_series(&[RopeEntry::new(b, 0.0)], &TrainCfg::default(), 0.0, 1800.0, n, earth(), &mut ob);
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&oa), bits(&ob));
    }

    #[test]
    fn unlaunched_rope_is_silent() {
        // Before its launch offset a rope contributes nothing (DBM is
        // undefined for negative time — the guard must skip, not extrapolate).
        let p = RopeParams { tilt_deg: 90.0, ..Default::default() };
        let train = [RopeEntry::new(p, 48.0 * 3600.0)];
        let (b, count) = field_at_set(&train, 24.0 * 3600.0, earth());
        assert_eq!(count, 0);
        assert_eq!(b, [0.0, 0.0, 0.0]);
    }

    // ── CME–CME interaction (spec §16) ───────────────────────────────────────

    fn icfg() -> TrainCfg {
        TrainCfg { enabled: true, ..TrainCfg::default() }
    }

    /// Arrival time of an effective (segmented) Dbm at radius r (bisection).
    fn dbm_arrival_s(dbm: &SegDbm, r_km: f64) -> f64 {
        let (mut lo, mut hi) = (0.0, 20.0 * 86_400.0);
        for _ in 0..200 {
            let mid = 0.5 * (lo + hi);
            if dbm.apex_km(mid) < r_km {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        0.5 * (lo + hi)
    }

    #[test]
    fn interaction_disabled_train_matches_the_v1_superposition_bitwise() {
        // synth_series with the default (disabled) cfg must reproduce the
        // §10 field_at_set / sheath_count_at_set path bit-for-bit.
        let a = RopeParams {
            v0_kms: 1000.0,
            tilt_deg: 90.0,
            sheath_delta_nt: 2.0,
            ..Default::default()
        };
        let b = RopeParams { v0_kms: 1400.0, tilt_deg: 45.0, ..a };
        let train = [RopeEntry::new(a, 0.0), RopeEntry::new(b, 20.0 * 3600.0)];
        let n = 500;
        let dt = 1800.0;
        let mut out = vec![0.0f32; 4 * n];
        synth_series(&train, &TrainCfg::default(), 0.0, dt, n, earth(), &mut out);
        for i in 0..n {
            let t = dt * i as f64;
            let (bv, count) = field_at_set(&train, t, earth());
            let sheath = sheath_count_at_set(&train, t, earth());
            let g = to_gse(bv);
            assert_eq!(out[4 * i].to_bits(), (g[0] as f32).to_bits(), "step {}", i);
            assert_eq!(out[4 * i + 2].to_bits(), (g[2] as f32).to_bits(), "step {}", i);
            assert_eq!(out[4 * i + 3] as u32, count + 100 * sheath, "step {}", i);
        }
    }

    #[test]
    fn single_rope_with_interaction_enabled_is_bit_identical() {
        // No partner → no wake, no rear compression: cfg on must change
        // nothing for a lone rope.
        let p = RopeParams { v0_kms: 1100.0, tilt_deg: 90.0, sheath_delta_nt: 3.0, ..Default::default() };
        let n = 400;
        let (mut oa, mut ob) = (vec![0.0f32; 4 * n], vec![0.0f32; 4 * n]);
        synth_series(&[RopeEntry::new(p, 0.0)], &TrainCfg::default(), 0.0, 1800.0, n, earth(), &mut oa);
        synth_series(&[RopeEntry::new(p, 0.0)], &icfg(), 0.0, 1800.0, n, earth(), &mut ob);
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&oa), bits(&ob));
    }

    // ── v1.6 (spec §19–§21): momentum exchange, evolving wake, deflection ────

    /// Slow leader / fast aligned follower — the canonical §19 collision.
    fn collision_train() -> [RopeEntry; 2] {
        let lead = RopeParams {
            v0_kms: 600.0, sigma_1au_au: 0.09, tilt_deg: 90.0, ..Default::default()
        };
        let foll = RopeParams {
            v0_kms: 1500.0, sigma_1au_au: 0.11, tilt_deg: 90.0, ..Default::default()
        };
        [RopeEntry::new(lead, 0.0), RopeEntry::new(foll, 12.0 * 3600.0)]
    }

    #[test]
    fn v16_knobs_off_are_bitwise_identical_to_v15() {
        // momentum_enabled=false must ignore ε; wake_refresh 0 and defl 0
        // are the legacy path — bit-for-bit.
        let train = collision_train();
        let n = 500;
        let base = {
            let mut o = vec![0.0f32; 4 * n];
            synth_series(&train, &icfg(), 0.0, 1800.0, n, earth(), &mut o);
            o
        };
        let cfg = TrainCfg {
            restitution: 0.7, // ignored while momentum_enabled=false
            momentum_enabled: false,
            wake_refresh_h: 0.0,
            defl_pair: 0.0,
            defl_ew_deg: 0.0,
            ..icfg()
        };
        let mut o = vec![0.0f32; 4 * n];
        synth_series(&train, &cfg, 0.0, 1800.0, n, earth(), &mut o);
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&base), bits(&o));
    }

    #[test]
    fn contact_impulse_conserves_momentum_and_respects_restitution() {
        let train = collision_train();
        let m_i = train[0].params.sigma_1au_au.powi(2);
        let m_j = train[1].params.sigma_1au_au.powi(2);

        // Pre-contact speeds from the momentum-OFF dynamics at the SAME tc.
        let mut off = Vec::new();
        train_dyn(&train, &icfg(), &mut off);

        for eps in [0.0, 0.5, 1.0] {
            let cfg = TrainCfg { momentum_enabled: true, restitution: eps, ..icfg() };
            let mut dyns = Vec::new();
            train_dyn(&train, &cfg, &mut dyns);
            let tc = dyns[1].contact_s;
            assert!(tc.is_finite(), "fast follower must contact its leader");
            // The contact sits ON the gap root of the pre-impulse chains.
            let gap = |t: f64| {
                let d_i = off[0].dbm.apex_km(t);
                let d_j = off[1].dbm.apex_km(t - train[1].t_launch_s);
                (d_i - sigma_hat_km(&train[0], d_i)) - (d_j + sigma_hat_km(&train[1], d_j))
            };
            assert!(gap(tc).abs() < 1.0, "gap at contact = {} km (ε {})", gap(tc), eps);
            let v_i0 = off[0].dbm.speed_kms(tc);
            let v_j0 = off[1].dbm.speed_kms(tc - train[1].t_launch_s);
            let v_i1 = dyns[0].dbm.speed_kms(tc + 1.0);
            let v_j1 = dyns[1].dbm.speed_kms(tc + 1.0 - train[1].t_launch_s);
            assert!(
                ((m_i * v_i0 + m_j * v_j0) - (m_i * v_i1 + m_j * v_j1)).abs() < 0.5,
                "momentum must be conserved (ε {}): {} vs {}",
                eps, m_i * v_i0 + m_j * v_j0, m_i * v_i1 + m_j * v_j1
            );
            let u0 = v_j0 - v_i0;
            let u1 = v_j1 - v_i1;
            assert!(
                (u1 + eps * u0).abs() < 1.0,
                "restitution: post-closing {} must be −ε·{} (ε {})",
                u1, u0, eps
            );
        }

        // Trajectory consequence: the pushed leader arrives EARLIER, the
        // decelerated follower LATER, than without momentum exchange.
        let cfg = TrainCfg { momentum_enabled: true, restitution: 0.0, ..icfg() };
        let mut on = Vec::new();
        train_dyn(&train, &cfg, &mut on);
        let t_lead_on = dbm_arrival_s(&on[0].dbm, AU_KM);
        let t_lead_off = dbm_arrival_s(&off[0].dbm, AU_KM);
        assert!(
            t_lead_on < t_lead_off - 1800.0,
            "pushed leader must arrive earlier: {:.1} vs {:.1} h",
            t_lead_on / 3600.0, t_lead_off / 3600.0
        );
        let arr_j = |d: &RopeDyn| {
            let (mut lo, mut hi) = (0.0, 20.0 * 86_400.0);
            for _ in 0..200 {
                let mid = 0.5 * (lo + hi);
                if d.dbm.apex_km(mid) < AU_KM { lo = mid; } else { hi = mid; }
            }
            0.5 * (lo + hi)
        };
        assert!(
            arr_j(&on[1]) > arr_j(&off[1]) + 1800.0,
            "decelerated follower must arrive later"
        );
    }

    #[test]
    fn rear_compression_relaxes_after_the_contact() {
        let train = collision_train();
        let cfg = TrainCfg { momentum_enabled: true, restitution: 0.0, ..icfg() };
        let mut dyns = Vec::new();
        train_dyn(&train, &cfg, &mut dyns);
        let tc = dyns[1].contact_s;
        assert!(tc.is_finite());
        let before = rear_c_at(&train, &dyns, &cfg, 0, tc - 3600.0);
        let after = rear_c_at(&train, &dyns, &cfg, 0, tc + 4.0 * 3600.0);
        assert!(before > 0.05, "closing follower must squeeze pre-contact: {}", before);
        assert!(
            after < 0.02,
            "co-moving (ε=0) pair must relax the squeeze: {} → {}",
            before, after
        );
    }

    #[test]
    fn wake_refresh_decays_entrainment_and_overtake_restores_fresh_wind() {
        let train = collision_train();
        // Frozen legacy vs 6-h refreshes: the decelerating leader's wake
        // weakens over time, so the refreshed follower is entrained LESS
        // and reaches 1 AU later than the frozen-wake approximation said.
        let mut frozen = Vec::new();
        train_dyn(&train, &icfg(), &mut frozen);
        let cfg = TrainCfg { wake_refresh_h: 6.0, ..icfg() };
        let mut fresh = Vec::new();
        train_dyn(&train, &cfg, &mut fresh);
        assert!(fresh[1].dbm.n > 1, "refreshes must add segments");
        // Monotone non-increasing wake ambient across refresh segments.
        for k in 1..fresh[1].dbm.n {
            let w_prev = fresh[1].dbm.segs[k - 1].1.w_kms;
            let w_k = fresh[1].dbm.segs[k].1.w_kms;
            // (until an overtake segment restores the raw ambient)
            if (w_k - train[1].params.w_kms).abs() < 1e-9 { break; }
            assert!(w_k <= w_prev + 1e-9, "wake must decay: seg {} {} → {}", k, w_prev, w_k);
        }
        let t_frozen = dbm_arrival_s(&frozen[1].dbm, AU_KM);
        let t_refresh = dbm_arrival_s(&fresh[1].dbm, AU_KM);
        assert!(
            t_refresh > t_frozen,
            "decaying wake must slow the follower vs the launch freeze: {:.1} vs {:.1} h",
            t_refresh / 3600.0, t_frozen / 3600.0
        );
        // A genuinely overtaking follower re-enters fresh wind: raw regime
        // at late age.
        let (w_late, g_late) = fresh[1].dbm.regime_at(WAKE_REFRESH_MAX_AGE_S * 2.0);
        if fresh[1].dbm.n > 2 && w_late == train[1].params.w_kms {
            assert_eq!(g_late, train[1].params.gamma_per_km, "overtake restores raw drag");
        }
        // wake_refresh 0 stays bitwise the frozen path.
        let n = 400;
        let (mut oa, mut ob) = (vec![0.0f32; 4 * n], vec![0.0f32; 4 * n]);
        synth_series(&train, &icfg(), 0.0, 1800.0, n, earth(), &mut oa);
        let zero = TrainCfg { wake_refresh_h: 0.0, ..icfg() };
        synth_series(&train, &zero, 0.0, 1800.0, n, earth(), &mut ob);
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&oa), bits(&ob));
    }

    #[test]
    fn deflection_rotates_the_follower_and_shifts_slow_ropes_east() {
        // Leader on the Sun–Earth line, follower 30° west: defl_pair 0.5
        // rotates the follower's EFFECTIVE direction 15° toward the leader
        // (cap 20° not hit); raw entries stay untouched.
        let lead = RopeParams { v0_kms: 900.0, ..Default::default() };
        let foll = RopeParams { lon_deg: 30.0, v0_kms: 1300.0, ..Default::default() };
        let train = [RopeEntry::new(lead, 0.0), RopeEntry::new(foll, 10.0 * 3600.0)];
        let cfg = TrainCfg { defl_pair: 0.5, ..icfg() };
        let mut dyns = Vec::new();
        train_dyn(&train, &cfg, &mut dyns);
        let lon_eff = dyns[1].frame.e_dir[1].atan2(dyns[1].frame.e_dir[0]).to_degrees();
        assert!(
            (lon_eff - 15.0).abs() < 0.5,
            "0.5 of 30° separation → ~15°, got {:.2}°",
            lon_eff
        );
        assert!(
            (train[1].frame.e_dir[1].atan2(train[1].frame.e_dir[0]).to_degrees() - 30.0).abs()
                < 1e-9,
            "raw entry frames must never move"
        );
        // Cap: a 60°-apart pair… would not partner (cos < 0.5); verify the
        // cap with a 35° separation and defl_pair 1.0 → 20° max rotation.
        let far = RopeParams { lon_deg: 35.0, v0_kms: 1300.0, ..Default::default() };
        let train2 = [RopeEntry::new(lead, 0.0), RopeEntry::new(far, 10.0 * 3600.0)];
        let cfg2 = TrainCfg { defl_pair: 1.0, ..icfg() };
        let mut d2 = Vec::new();
        train_dyn(&train2, &cfg2, &mut d2);
        let lon2 = d2[1].frame.e_dir[1].atan2(d2[1].frame.e_dir[0]).to_degrees();
        assert!((lon2 - 15.0).abs() < 0.5, "35° − 20° cap = 15°, got {:.2}°", lon2);

        // §21 east–west drift: slow rope (v0 < w) shifts EAST (negative).
        let slow = RopeParams { v0_kms: 300.0, w_kms: 400.0, ..Default::default() };
        let fast = RopeParams { lon_deg: 3.0, v0_kms: 1200.0, w_kms: 400.0, ..Default::default() };
        let t3 = [RopeEntry::new(slow, 0.0), RopeEntry::new(fast, 8.0 * 3600.0)];
        let cfg3 = TrainCfg { defl_ew_deg: 5.0, ..icfg() };
        let mut d3 = Vec::new();
        train_dyn(&t3, &cfg3, &mut d3);
        let lon_slow = d3[0].frame.e_dir[1].atan2(d3[0].frame.e_dir[0]).to_degrees();
        let lon_fast = d3[1].frame.e_dir[1].atan2(d3[1].frame.e_dir[0]).to_degrees();
        assert!((lon_slow - (-1.25)).abs() < 0.01, "slow → east: {:.3}°", lon_slow);
        assert!(lon_fast > 3.0, "fast → west of its raw lon: {:.3}°", lon_fast);

        // Both knobs 0 → effective frames ARE the raw frames (bitwise).
        let mut d0 = Vec::new();
        train_dyn(&train, &icfg(), &mut d0);
        assert_eq!(d0[1].frame.e_dir[0].to_bits(), train[1].frame.e_dir[0].to_bits());
        assert_eq!(d0[1].frame.e_dir[1].to_bits(), train[1].frame.e_dir[1].to_bits());
    }

    #[test]
    fn wake_kinematics_entrain_the_follower() {
        // Aligned follower: elevated frozen-at-launch ambient, reduced drag,
        // and an EARLIER 1 AU arrival than the fresh-wind DBM predicts.
        let lead = RopeParams { v0_kms: 1000.0, ..Default::default() };
        let foll = RopeParams { v0_kms: 1400.0, ..Default::default() };
        let train = [
            RopeEntry::new(lead, 0.0),
            RopeEntry::new(foll, 20.0 * 3600.0),
        ];
        let mut dyns = Vec::new();
        train_dyn(&train, &icfg(), &mut dyns);
        assert_eq!(dyns[0].lead, -1);
        assert_eq!(dyns[1].lead, 0);
        let w_expect = lead.dbm().speed_kms(20.0 * 3600.0);
        assert!(
            (dyns[1].dbm.w_kms() - w_expect).abs() < 1e-9 && w_expect > 600.0,
            "wake ambient {} must be the leader's launch-time speed {}",
            dyns[1].dbm.w_kms(),
            w_expect
        );
        assert!((dyns[1].dbm.gamma_per_km() - 0.5 * foll.gamma_per_km).abs() < 1e-20);
        assert!((dyns[0].dbm.w_kms() - lead.w_kms).abs() < 1e-12, "leader untouched");
        let t_wake = dbm_arrival_s(&dyns[1].dbm, AU_KM);
        let t_fresh = dbm_arrival_s(&SegDbm::single(foll.dbm()), AU_KM);
        assert!(
            t_wake < t_fresh - 3600.0,
            "wake must speed the follower up: {} vs {} h",
            t_wake / 3600.0,
            t_fresh / 3600.0
        );
    }

    #[test]
    fn misaligned_ropes_never_partner() {
        let lead = RopeParams { v0_kms: 1000.0, ..Default::default() };
        let flank = RopeParams { lon_deg: 90.0, v0_kms: 1400.0, ..Default::default() };
        let train = [
            RopeEntry::new(lead, 0.0),
            RopeEntry::new(flank, 20.0 * 3600.0),
        ];
        let mut dyns = Vec::new();
        train_dyn(&train, &icfg(), &mut dyns);
        assert_eq!(dyns[1].lead, -1, "90°-apart launches must not interact");
        assert!((dyns[1].dbm.w_kms() - flank.w_kms).abs() < 1e-12);
    }

    #[test]
    fn rear_compression_ramps_with_approach_and_boosts_the_rear_field() {
        // Slow leader, fast follower 12 h behind: early on the follower is
        // far (rear_c = 0); as it closes, rear_c grows (≤ 0.75) and the
        // leader's REAR interior field is flux-conservation-boosted while
        // its FRONT stays bit-identical.
        let lead = RopeParams { v0_kms: 800.0, tilt_deg: 90.0, sigma_1au_au: 0.10, ..Default::default() };
        let foll = RopeParams { v0_kms: 1900.0, tilt_deg: 90.0, sigma_1au_au: 0.08, ..lead };
        let train = [
            RopeEntry::new(lead, 0.0),
            RopeEntry::new(foll, 12.0 * 3600.0),
        ];
        let cfg = icfg();
        let mut dyns = Vec::new();
        train_dyn(&train, &cfg, &mut dyns);
        // Just after the follower launches: no squeeze yet.
        assert_eq!(rear_c_at(&train, &dyns, &cfg, 0, 13.0 * 3600.0), 0.0);
        // Sweep for the squeeze window.
        let mut t_sq = None;
        for k in 0..400 {
            let t = 13.0 * 3600.0 + k as f64 * 900.0;
            let c = rear_c_at(&train, &dyns, &cfg, 0, t);
            assert!((0.0..=0.75).contains(&c), "rear_c {} out of range", c);
            if c > 0.2 {
                t_sq = Some(t);
                break;
            }
        }
        let t = t_sq.expect("a 1900 km/s follower must catch a 800 km/s leader");
        let d = dyns[0].dbm.apex_km(t);
        let sigma = sigma_apex_km(lead.sigma_1au_au * AU_KM, d, lead.n_sigma);
        let mag = |fs: FieldSample| dot(fs.b, fs.b).sqrt();
        // Rear interior point (Sunward of the apex axis).
        let rear_p = [d - 0.5 * sigma, 0.0, 0.0];
        let rc = rear_c_at(&train, &dyns, &cfg, 0, t);
        let plain = field_at(&lead, &train[0].frame, t, rear_p);
        let squeezed = field_at_dyn(&lead, &train[0].frame, t, rear_p, &dyns[0].dbm, rc);
        assert!(plain.inside && squeezed.inside);
        assert!(
            mag(squeezed) > 1.15 * mag(plain),
            "rear field must be boosted: {} vs {}",
            mag(squeezed),
            mag(plain)
        );
        // Front interior point: the rear lobe vanishes at θ = 0, so the
        // squeezed field matches the plain one to rounding.
        let front_p = [d + 0.5 * sigma, 0.0, 0.0];
        let pf = field_at(&lead, &train[0].frame, t, front_p);
        let sf = field_at_dyn(&lead, &train[0].frame, t, front_p, &dyns[0].dbm, rc);
        assert!(pf.inside && sf.inside);
        for i in 0..3 {
            assert!(
                (pf.b[i] - sf.b[i]).abs() <= 1e-9 * mag(pf).max(1.0),
                "front must be untouched: {:?} vs {:?}",
                pf.b,
                sf.b
            );
        }
    }

    #[test]
    fn wake_conditioned_sheath_follows_the_relative_mach() {
        // KILL: a follower that outruns the FRESH wind but not its leader's
        // wake must lose the sheath the §14 fresh-upstream test would grant.
        // (Ballistic leader so its live wake speed never sags below the
        // entrained follower's — the kill is then exact at every step.)
        let lead = RopeParams { v0_kms: 1500.0, gamma_per_km: 0.0, ..Default::default() };
        let slow_foll = RopeParams { v0_kms: 800.0, sheath_delta_nt: 3.0, ..Default::default() };
        let train = [
            RopeEntry::new(lead, 0.0),
            RopeEntry::new(slow_foll, 10.0 * 3600.0),
        ];
        let cfg = icfg();
        let mut dyns = Vec::new();
        train_dyn(&train, &cfg, &mut dyns);
        let n = 500;
        let dt = 1800.0;
        let mut fresh_sheath = 0u32;
        let mut wake_sheath = 0u32;
        for i in 0..n {
            let t = dt * i as f64;
            fresh_sheath += sheath_count_at_set(&train, t, earth());
            wake_sheath += sheath_count_at_train(&train, &dyns, &cfg, t, earth());
        }
        assert!(
            fresh_sheath > 0,
            "fresh-wind test would grant the 800 km/s follower a sheath"
        );
        assert_eq!(
            wake_sheath, 0,
            "a follower slower than its leader's wake drives no shock"
        );
        // GAIN: a follower that genuinely outruns the wake keeps its sheath.
        let fast_foll = RopeParams { v0_kms: 1900.0, sheath_delta_nt: 3.0, ..Default::default() };
        let train2 = [
            RopeEntry::new(RopeParams { v0_kms: 700.0, ..Default::default() }, 0.0),
            RopeEntry::new(fast_foll, 10.0 * 3600.0),
        ];
        let mut dyns2 = Vec::new();
        train_dyn(&train2, &cfg, &mut dyns2);
        let got: u32 = (0..n)
            .map(|i| sheath_count_at_train(&train2, &dyns2, &cfg, dt * i as f64, earth()))
            .sum();
        assert!(got > 0, "a wake-outrunning follower must keep its sheath");
    }

    // ── Mach-dependent standoff (spec §17) ───────────────────────────────────

    /// Shell outer edge along the nose line, in units of σ_apex (bisection).
    fn shell_edge_sigma(p: &RopeParams, f: &Frame, t: f64, dbm: &Dbm, upstream: f64) -> f64 {
        let d = dbm.apex_km(t);
        let sigma = sigma_apex_km(p.sigma_1au_au * AU_KM, d, p.n_sigma);
        let (mut lo, mut hi) = (1.0, 12.0);
        for _ in 0..60 {
            let mid = 0.5 * (lo + hi);
            if sheath_at_dyn(p, f, t, [d + mid * sigma, 0.0, 0.0], &SegDbm::single(*dbm), upstream, 0.0) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        0.5 * (lo + hi)
    }

    #[test]
    fn standoff_shell_thickens_as_the_decelerating_shock_weakens() {
        // η mode: FR(M) grows as M falls, so the σ-relative shell must WIDEN
        // through the transit — the fixed-k shell is constant by construction.
        let p = RopeParams {
            v0_kms: 1400.0,
            tilt_deg: 90.0,
            sheath_delta_nt: 3.0,
            sheath_eta: 1.1,
            sheath_k: 0.0,
            ..Default::default()
        };
        let f = Frame::new(0.0, 0.0, 90.0);
        let dbm = p.dbm();
        let t1 = 20.0 * 3600.0;
        let t2 = 45.0 * 3600.0;
        let d1 = dbm.apex_km(t1);
        let s1 = sigma_apex_km(p.sigma_1au_au * AU_KM, d1, p.n_sigma);
        assert!(
            sheath_at(&p, &f, t1, [d1 + 1.01 * s1, 0.0, 0.0]),
            "just outside the rope nose must be sheath"
        );
        let early = shell_edge_sigma(&p, &f, t1, &dbm, p.w_kms) - 1.0;
        let late = shell_edge_sigma(&p, &f, t2, &dbm, p.w_kms) - 1.0;
        assert!(
            late > early * 1.1,
            "shell must widen as M falls: early {:.2}σ, late {:.2}σ",
            early,
            late
        );
    }

    #[test]
    fn weaker_shock_stands_farther_off_until_it_dies() {
        // Same rope, same instant, faster upstream (lower M): the shell must
        // be THICKER — the detaching shock stands farther out — until M ≤ 1
        // kills the sheath entirely (the §16 wake-conditioned kill).
        let p = RopeParams {
            v0_kms: 1200.0,
            tilt_deg: 90.0,
            sheath_delta_nt: 3.0,
            sheath_eta: 1.1,
            ..Default::default()
        };
        let f = Frame::new(0.0, 0.0, 90.0);
        let t = 30.0 * 3600.0;
        let dbm = p.dbm();
        let v = dbm.speed_kms(t);
        let fresh = shell_edge_sigma(&p, &f, t, &dbm, p.w_kms);
        let wakey = shell_edge_sigma(&p, &f, t, &dbm, v - 150.0);
        assert!(
            wakey > fresh + 0.05,
            "weaker shock must stand farther off: {:.2}σ vs {:.2}σ",
            wakey,
            fresh
        );
        let d = dbm.apex_km(t);
        let sigma = sigma_apex_km(p.sigma_1au_au * AU_KM, d, p.n_sigma);
        assert!(
            !sheath_at_dyn(&p, &f, t, [d + 1.1 * sigma, 0.0, 0.0], &SegDbm::single(dbm), v - 50.0, 0.0),
            "sub-magnetosonic upstream must kill the sheath"
        );
    }

    #[test]
    fn eta_zero_keeps_the_legacy_fixed_fraction_shell() {
        // η = 0 must be the exact §14 geometry: outer edge at σ·(1+k).
        let p = RopeParams {
            v0_kms: 1100.0,
            tilt_deg: 90.0,
            sheath_delta_nt: 3.0,
            sheath_k: 0.8,
            ..Default::default()
        };
        let f = Frame::new(0.0, 0.0, 90.0);
        let t = 30.0 * 3600.0;
        let edge = shell_edge_sigma(&p, &f, t, &p.dbm(), p.w_kms);
        assert!((edge - 1.8).abs() < 0.01, "legacy shell edge {:.3}σ vs 1.8σ", edge);
    }

    // ── Pancaking (spec §18) ─────────────────────────────────────────────────

    #[test]
    fn pancake_one_is_bit_identical() {
        let a = RopeParams { v0_kms: 1100.0, tilt_deg: 90.0, front_c: 0.3, ..Default::default() };
        let b = RopeParams { pancake_a: 1.0, ..a };
        let n = 300;
        let (mut oa, mut ob) = (vec![0.0f32; 4 * n], vec![0.0f32; 4 * n]);
        synth_series(&[RopeEntry::new(a, 0.0)], &TrainCfg::default(), 0.0, 1800.0, n, earth(), &mut oa);
        synth_series(&[RopeEntry::new(b, 0.0)], &TrainCfg::default(), 0.0, 1800.0, n, earth(), &mut ob);
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&oa), bits(&ob));
    }

    #[test]
    fn pancaking_thins_the_radial_axis_and_widens_the_transverse() {
        // At the apex of a tilt-90 rope the radial direction is x̂ and the
        // transverse is ŷ: A = 2 pulls the boundary in to σ/√2 along x̂ and
        // pushes it out to σ·√2 along ŷ.
        let round = RopeParams { v0_kms: 1100.0, tilt_deg: 90.0, ..Default::default() };
        let flat = RopeParams { pancake_a: 2.0, ..round };
        let fr = Frame::new(0.0, 0.0, 90.0);
        let t = arrival_time_s(&round, AU_KM);
        let d = round.dbm().apex_km(t);
        let sigma = sigma_apex_km(round.sigma_1au_au * AU_KM, d, round.n_sigma);
        // Radial probe at 0.8σ: inside the circle, OUTSIDE the ellipse
        // (0.8 > 1/√2 = 0.707).
        let radial = [d + 0.8 * sigma, 0.0, 0.0];
        assert!(field_at(&round, &fr, t, radial).inside);
        assert!(!field_at(&flat, &fr, t, radial).inside);
        // Transverse probe at 1.2σ: outside the circle, INSIDE the ellipse
        // (1.2 < √2 = 1.414).
        let transverse = [d, 1.2 * sigma, 0.0];
        assert!(!field_at(&round, &fr, t, transverse).inside);
        assert!(field_at(&flat, &fr, t, transverse).inside);
    }

    #[test]
    fn pancaking_is_flux_neutral_on_the_axis() {
        // Area-preserving deformation carries NO boost: the on-axis field
        // magnitude must match the circular rope's exactly.
        let round = RopeParams { v0_kms: 1100.0, tilt_deg: 90.0, ..Default::default() };
        let flat = RopeParams { pancake_a: 3.0, ..round };
        let fr = Frame::new(0.0, 0.0, 90.0);
        let t = arrival_time_s(&round, AU_KM);
        let d = round.dbm().apex_km(t);
        let probe = [d - 1.0, 0.0, 0.0]; // 1 km inside the apex axis
        let br = field_at(&round, &fr, t, probe);
        let bf = field_at(&flat, &fr, t, probe);
        assert!(br.inside && bf.inside);
        let mag = |fs: &FieldSample| dot(fs.b, fs.b).sqrt();
        assert!(
            (mag(&br) - mag(&bf)).abs() < 1e-9 * mag(&br).max(1.0),
            "axis field must be boost-free: {} vs {}",
            mag(&br),
            mag(&bf)
        );
    }

    #[test]
    fn pancaking_widens_the_hit_footprint() {
        // The §18 claim one spacecraft CAN'T measure but geometry pins: a
        // flank observer beyond the circular footprint gets hit once the
        // section flattens (transverse half-width σ√A).
        let round = RopeParams { v0_kms: 1100.0, tilt_deg: 90.0, ..Default::default() };
        let flat = RopeParams { pancake_a: 2.5, ..round };
        let flank = observer_pos(1.0, 8.0, 0.0);
        let n = 400;
        let mut out = vec![0.0f32; 4 * n];
        let hits_round =
            synth_series(&[RopeEntry::new(round, 0.0)], &TrainCfg::default(), 0.0, 1800.0, n, flank, &mut out);
        let hits_flat =
            synth_series(&[RopeEntry::new(flat, 0.0)], &TrainCfg::default(), 0.0, 1800.0, n, flank, &mut out);
        assert_eq!(hits_round, 0, "8° flank must miss the circular rope");
        assert!(hits_flat > 0, "8° flank must catch the A=2.5 pancaked rope");
        // And the nose dwell shrinks with the thinned radial axis.
        let mut o2 = vec![0.0f32; 4 * n];
        let nose_round =
            synth_series(&[RopeEntry::new(round, 0.0)], &TrainCfg::default(), 0.0, 1800.0, n, earth(), &mut o2);
        let nose_flat =
            synth_series(&[RopeEntry::new(flat, 0.0)], &TrainCfg::default(), 0.0, 1800.0, n, earth(), &mut o2);
        assert!(
            nose_flat < nose_round,
            "nose dwell must shrink: {} vs {} steps",
            nose_flat,
            nose_round
        );
    }

    #[test]
    fn twist_dilution_conserves_turns() {
        // Twist per length T = 2τ/d must fall as the rope lengthens: the
        // poloidal/axial ratio at fixed PHYSICAL offset from the apex axis
        // shrinks with distance.
        let p = RopeParams { tilt_deg: 90.0, ..Default::default() };
        let f = Frame::new(0.0, 0.0, 90.0);
        let ratio_at = |t: f64| {
            let d = p.dbm().apex_km(t);
            let s_off = 1.0e6; // 1e6 km off-axis, inside σ at both distances
            let probe = [d - 1.0 - 0.0, s_off, 0.0]; // offset along ê_E ⊥ axis...
            let fs = field_at(&p, &f, t, [probe[0], probe[1], probe[2]]);
            assert!(fs.inside);
            // Poloidal fraction proxy: component ⊥ apex tangent (−ê_N).
            let axial = dot(fs.b, [0.0, 0.0, -1.0]).abs();
            let total = norm(fs.b);
            (total * total - axial * axial).sqrt() / axial
        };
        let t1 = arrival_time_s(&p, 0.6 * AU_KM);
        let t2 = arrival_time_s(&p, 1.2 * AU_KM);
        assert!(ratio_at(t2) < ratio_at(t1), "twist per length must dilute");
    }
}
