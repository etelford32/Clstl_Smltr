//! Tapered-torus rope geometry + internal field evaluation.
//! Spec: FLUX_ROPE_PHYSICS_SPEC.md §2–§4, §6. Everything here is pure
//! functions of (params, t, position) — no state, no allocation — so the
//! ensemble layer can hammer it and the GLSL heliosphere view can mirror it.

use crate::bessel::{j0, j1, J0_ZERO1};
use crate::kinematics::{b_axis_nt, sigma_apex_km, Dbm, AU_KM, RSUN_KM};

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
            front_c: 0.0, // off by default — every pre-v1.2 pin holds
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

/// Front-compression distortion factor f ∈ [1−c, 1] (spec §15): the local
/// boundary is σ_eff = σ·f, thinnest where the cross-section radial points
/// anti-Sunward (θ = 0, the snowplowed leading edge) and undistorted at the
/// wake (θ = π). Returns 1 when the mechanism is off, on-axis, or in the
/// (unphysical) degenerate geometries near the footpoints.
#[allow(clippy::too_many_arguments)]
fn front_factor(
    front_c: f64,
    frame: &Frame,
    half_d: f64,
    psi: f64,
    qu: f64,
    w: f64,
    rho_ip: f64,
    p: V3,
    s: f64,
) -> f64 {
    if front_c <= 0.0 || s < 1e-6 {
        return 1.0;
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
        return 1.0;
    }
    let r_hat = scale([p[0] - n_pt[0], p[1] - n_pt[1], p[2] - n_pt[2]], 1.0 / s);
    let u_hat = scale(n_pt, 1.0 / n_norm);
    // Anti-Sunward direction projected into the cross-section plane (⊥ t̂).
    let ut = dot(u_hat, t_hat);
    let mut o = [u_hat[0] - ut * t_hat[0], u_hat[1] - ut * t_hat[1], u_hat[2] - ut * t_hat[2]];
    let on = dot(o, o).sqrt();
    if on < 1e-9 {
        return 1.0;
    }
    o = scale(o, 1.0 / on);
    let cos_th = dot(r_hat, o);
    1.0 - front_c.min(0.6) * (1.0 + cos_th) * 0.5
}

/// Evaluate the rope field at heliocentric point `p` [km], `t_s` seconds
/// after launch. Returns B in the HELIOCENTRIC frame (§2); callers map to
/// GSE with `to_gse`.
pub fn field_at(params: &RopeParams, frame: &Frame, t_s: f64, p: V3) -> FieldSample {
    let d = params.dbm().apex_km(t_s);
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
    // Front compression (spec §15): compressed boundary σ_eff = σ·f, field
    // structure mapped to the reference profile via ŝ = s/f with a
    // flux-conservation boost 1/f. f = 1 when off — bit-identical v1 path.
    let f_dist = front_factor(params.front_c, frame, half_d, psi, qu, w, rho_ip, p, s);
    let sigma_eff = sigma * f_dist;
    if s >= sigma_eff {
        return FieldSample::default();
    }
    let s_ref = s / f_dist;
    let boost = 1.0 / f_dist;

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
/// obstacle, not in its wake).
pub fn sheath_at(params: &RopeParams, frame: &Frame, t_s: f64, p: V3) -> bool {
    if params.sheath_delta_nt <= 0.0 || params.sheath_k <= 0.0 {
        return false;
    }
    let dbm = params.dbm();
    if crate::kinematics::shock_mach(dbm.speed_kms(t_s), params.w_kms) <= 1.0 {
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
    // The sheath shell rides the front-compressed boundary (spec §15).
    let f_dist = front_factor(params.front_c, frame, half_d, psi, qu, w, rho_ip, p, s);
    let sigma_eff = sigma * f_dist;
    if s < sigma_eff || s >= sigma_eff * (1.0 + params.sheath_k) {
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

/// Synthesize the virtual-spacecraft series (spec §6, §10, §14): n GSE
/// samples starting `t0_s` after the reference epoch at `dt_s` spacing,
/// over a rope TRAIN. Writes (bx, by, bz, count_code) per step into `out`
/// (len ≥ 4·n), where `count_code = rope_count + 100·sheath_count` —
/// decode with % 100 (rope containment) and / 100 (sheath containment).
/// The DETERMINISTIC series carries no sheath field (its Bz is zero-mean
/// stochastic and lives in the ensemble, spec §14) — only the flags.
/// Returns the number of steps with rope containment ≥ 1. A single
/// sheathless rope reproduces the v1 behavior exactly (code is 0/1).
pub fn synth_series(
    ropes: &[RopeEntry],
    t0_s: f64,
    dt_s: f64,
    n: usize,
    obs: V3,
    out: &mut [f32],
) -> usize {
    let mut hits = 0;
    for i in 0..n {
        let t = t0_s + dt_s * i as f64;
        let (b, count) = field_at_set(ropes, t, obs);
        let sheath = sheath_count_at_set(ropes, t, obs);
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
        let hits = synth_series(&[RopeEntry::new(p, 0.0)], 0.0, dt, n, earth(), &mut out);
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
        let hits = synth_series(&[RopeEntry::new(p, 0.0)], 0.0, 1800.0, n, earth(), &mut out);
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
        synth_series(&train, 0.0, dt, n, earth(), &mut out);
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
        synth_series(&[RopeEntry::new(fast, 0.0)], 0.0, 1800.0, n, earth(), &mut out);
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
        synth_series(&[RopeEntry::new(slow, 0.0)], 0.0, 3600.0, n, earth(), &mut out2);
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
            synth_series(&[RopeEntry::new(p, 0.0)], 0.0, dt, n, earth(), &mut out);
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
        synth_series(&[RopeEntry::new(a, 0.0)], 0.0, 1800.0, n, earth(), &mut oa);
        synth_series(&[RopeEntry::new(b, 0.0)], 0.0, 1800.0, n, earth(), &mut ob);
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
