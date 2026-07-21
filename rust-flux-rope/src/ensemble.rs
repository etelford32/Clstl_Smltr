//! Ensemble layer (spec §7): deterministic seeded prior sampling around a
//! reference fit, per-step Bz/|B| percentile fans, arrival distribution, and
//! threshold probabilities. Same seed → same ensemble, bit-for-bit, native
//! and WASM — splitmix64 → xoshiro256**, Box–Muller normals, no ambient
//! entropy anywhere.

use crate::rope::{field_at_set, to_gse, RopeEntry, RopeParams, V3};

// ── PRNG ─────────────────────────────────────────────────────────────────────

pub struct Rng {
    s: [u64; 4],
}

fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        let mut sm = seed;
        Rng {
            s: [
                splitmix64(&mut sm),
                splitmix64(&mut sm),
                splitmix64(&mut sm),
                splitmix64(&mut sm),
            ],
        }
    }

    /// xoshiro256** next.
    pub fn next_u64(&mut self) -> u64 {
        let result = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        result
    }

    /// Uniform in (0, 1] — never exactly 0, safe for ln().
    pub fn uniform(&mut self) -> f64 {
        (((self.next_u64() >> 11) as f64) + 1.0) / 9_007_199_254_740_992.0
    }

    /// Standard normal via Box–Muller (one deviate per call; deterministic).
    pub fn normal(&mut self) -> f64 {
        let u1 = self.uniform();
        let u2 = self.uniform();
        (-2.0 * u1.ln()).sqrt() * (core::f64::consts::TAU * u2).cos()
    }
}

// ── Priors ───────────────────────────────────────────────────────────────────

/// Per-parameter prior spreads around the reference fit (spec §7 table).
/// Additive sigmas for angles/speed/twist; MULTIPLICATIVE (log-normal ln-σ)
/// for the positive-definite B₁AU / σ₁AU / Γ.
#[derive(Clone, Copy, Debug, Default)]
pub struct Spreads {
    pub sig_lon_deg: f64,
    pub sig_lat_deg: f64,
    pub sig_tilt_deg: f64,
    pub sig_v0_kms: f64,
    pub lnsig_b: f64,
    pub lnsig_sigma: f64,
    pub lnsig_gamma: f64,
    pub sig_twist: f64,
    /// Probability that a member flips chirality.
    pub p_flip: f64,
}

/// Draw one member around the fit. Sampling ORDER is part of the determinism
/// contract — do not reorder without bumping the smoke-test pins.
pub fn sample_member(fit: &RopeParams, sp: &Spreads, rng: &mut Rng) -> RopeParams {
    let mut m = *fit;
    m.lon_deg += sp.sig_lon_deg * rng.normal();
    m.lat_deg += sp.sig_lat_deg * rng.normal();
    m.tilt_deg += sp.sig_tilt_deg * rng.normal();
    m.v0_kms = (fit.v0_kms + sp.sig_v0_kms * rng.normal()).max(100.0);
    m.b_1au_nt = fit.b_1au_nt * (sp.lnsig_b * rng.normal()).exp();
    m.sigma_1au_au = fit.sigma_1au_au * (sp.lnsig_sigma * rng.normal()).exp();
    m.gamma_per_km = fit.gamma_per_km * (sp.lnsig_gamma * rng.normal()).exp();
    m.twist_turns = (fit.twist_turns + sp.sig_twist * rng.normal()).max(0.1);
    if rng.uniform() < sp.p_flip {
        m.handedness = -fit.handedness;
    }
    m
}

// ── Ensemble run ─────────────────────────────────────────────────────────────

pub const PCTS: [f64; 5] = [5.0, 25.0, 50.0, 75.0, 95.0];

/// Per-member sampled-parameter record stride (see `MEMBER_PARAM_FIELDS`).
pub const MEMBER_STRIDE: usize = 7;
/// Field order inside each member record: the page's heliosphere view draws
/// true member rope geometry from these (DBM + axis circle in JS).
pub const MEMBER_PARAM_FIELDS: [&str; MEMBER_STRIDE] =
    ["lon_deg", "lat_deg", "tilt_deg", "v0_kms", "gamma_per_km", "sigma_1au_au", "handedness"];

pub struct EnsembleResult {
    pub n_members: usize,
    pub n_steps: usize,
    /// Ropes per member (the train size) — member_params carries
    /// n_members × ropes_per_member records.
    pub ropes_per_member: usize,
    /// Row-major [pct_idx][step] Bz_GSE percentiles [nT].
    pub bz_pct: Vec<f32>,
    /// Median |B| per step [nT].
    pub bt_med: Vec<f32>,
    /// Fraction of members inside the rope per step.
    pub hit_frac: Vec<f32>,
    /// Per-member arrival [hours after launch]; NaN = miss.
    pub arrival_h: Vec<f32>,
    /// Per-member min Bz over the window [nT]; NaN = miss.
    pub min_bz: Vec<f32>,
    /// Per-member sampled params, MEMBER_STRIDE f32 each (envelope rendering).
    pub member_params: Vec<f32>,
    pub p_hit: f64,
}

impl EnsembleResult {
    pub fn p_min_bz_below(&self, thr_nt: f64) -> f64 {
        if self.n_members == 0 {
            return 0.0;
        }
        let c = self.min_bz.iter().filter(|v| (**v as f64) < thr_nt).count();
        c as f64 / self.n_members as f64
    }
}

/// Inclusive linear-interpolation percentile of a SORTED slice.
fn percentile_sorted(a: &[f32], q: f64) -> f32 {
    let m = a.len();
    if m == 0 {
        return 0.0;
    }
    let rank = q / 100.0 * (m - 1) as f64;
    let lo = rank.floor() as usize;
    let frac = rank - lo as f64;
    if lo + 1 >= m {
        a[m - 1]
    } else {
        (a[lo] as f64 + (a[lo + 1] as f64 - a[lo] as f64) * frac) as f32
    }
}

/// Run the joint ensemble over a rope TRAIN: each member draws EVERY rope's
/// parameters independently (sequential draws from one stream — the order is
/// part of the determinism contract), keeps each rope's launch offset from
/// the fit, and flies the observer through the superposed train (spec §10).
/// A 1-rope train reproduces the v1 single-rope ensemble draw-for-draw.
#[allow(clippy::too_many_arguments)]
pub fn run(
    fits: &[RopeEntry],
    sp: &Spreads,
    seed: u64,
    n_members: usize,
    t0_s: f64,
    dt_s: f64,
    n_steps: usize,
    obs: V3,
) -> EnsembleResult {
    let mut rng = Rng::new(seed);
    let n_ropes = fits.len().max(1);
    // Per-step member samples: NaN = outside. Column layout [step][member].
    let mut bz = vec![f32::NAN; n_steps * n_members];
    let mut bt = vec![f32::NAN; n_steps * n_members];
    let mut arrival_h = vec![f32::NAN; n_members];
    let mut min_bz = vec![f32::NAN; n_members];
    let mut member_params = vec![0.0f32; n_members * n_ropes * MEMBER_STRIDE];
    let mut hit_members = 0usize;
    let mut train: Vec<RopeEntry> = Vec::with_capacity(fits.len());

    for m in 0..n_members {
        train.clear();
        for (r, fit) in fits.iter().enumerate() {
            let member = sample_member(&fit.params, sp, &mut rng);
            let o = (m * n_ropes + r) * MEMBER_STRIDE;
            member_params[o..o + MEMBER_STRIDE].copy_from_slice(&[
                member.lon_deg as f32,
                member.lat_deg as f32,
                member.tilt_deg as f32,
                member.v0_kms as f32,
                member.gamma_per_km as f32,
                member.sigma_1au_au as f32,
                member.handedness as f32,
            ]);
            train.push(RopeEntry::new(member, fit.t_launch_s));
        }
        let mut member_min = f32::NAN;
        let mut member_arr = f32::NAN;
        for i in 0..n_steps {
            let t = t0_s + dt_s * i as f64;
            let (b, count) = field_at_set(&train, t, obs);
            if count > 0 {
                let g = to_gse(b);
                let bz_i = g[2] as f32;
                let bt_i =
                    ((g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt()) as f32;
                bz[i * n_members + m] = bz_i;
                bt[i * n_members + m] = bt_i;
                if member_arr.is_nan() {
                    member_arr = (t / 3600.0) as f32;
                }
                if member_min.is_nan() || bz_i < member_min {
                    member_min = bz_i;
                }
            }
        }
        if !member_arr.is_nan() {
            hit_members += 1;
        }
        arrival_h[m] = member_arr;
        min_bz[m] = member_min;
    }

    // Percentiles over INSIDE members only, gated by a minimum hit fraction
    // (spec §7): below the gate the fan is 0-filled and hit_frac tells the UI.
    let min_hits = ((0.05 * n_members as f64).ceil() as usize).max(2);
    let mut bz_pct = vec![0.0f32; PCTS.len() * n_steps];
    let mut bt_med = vec![0.0f32; n_steps];
    let mut hit_frac = vec![0.0f32; n_steps];
    let mut scratch: Vec<f32> = Vec::with_capacity(n_members);

    for i in 0..n_steps {
        scratch.clear();
        scratch.extend(
            bz[i * n_members..(i + 1) * n_members]
                .iter()
                .copied()
                .filter(|v| !v.is_nan()),
        );
        hit_frac[i] = scratch.len() as f32 / n_members.max(1) as f32;
        if scratch.len() >= min_hits {
            scratch.sort_by(|a, b| a.partial_cmp(b).unwrap());
            for (k, q) in PCTS.iter().enumerate() {
                bz_pct[k * n_steps + i] = percentile_sorted(&scratch, *q);
            }
            scratch.clear();
            scratch.extend(
                bt[i * n_members..(i + 1) * n_members]
                    .iter()
                    .copied()
                    .filter(|v| !v.is_nan()),
            );
            scratch.sort_by(|a, b| a.partial_cmp(b).unwrap());
            bt_med[i] = percentile_sorted(&scratch, 50.0);
        }
    }

    EnsembleResult {
        n_members,
        n_steps,
        ropes_per_member: n_ropes,
        bz_pct,
        bt_med,
        hit_frac,
        arrival_h,
        min_bz,
        member_params,
        p_hit: hit_members as f64 / n_members.max(1) as f64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rope::observer_pos;

    fn fit() -> Vec<RopeEntry> {
        vec![RopeEntry::new(
            RopeParams { v0_kms: 1100.0, tilt_deg: 90.0, ..Default::default() },
            0.0,
        )]
    }
    fn spreads() -> Spreads {
        Spreads {
            sig_lon_deg: 10.0,
            sig_lat_deg: 6.0,
            sig_tilt_deg: 20.0,
            sig_v0_kms: 100.0,
            lnsig_b: 0.2,
            lnsig_sigma: 0.15,
            lnsig_gamma: 0.4,
            sig_twist: 1.0,
            p_flip: 0.1,
        }
    }

    #[test]
    fn same_seed_bitwise_reproducible() {
        let obs = observer_pos(1.0, 0.0, 0.0);
        let a = run(&fit(), &spreads(), 42, 64, 0.0, 3600.0, 120, obs);
        let b = run(&fit(), &spreads(), 42, 64, 0.0, 3600.0, 120, obs);
        // Bit-pattern compare: arrival/min arrays legitimately contain NaN
        // (miss members), and NaN != NaN under assert_eq.
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&a.bz_pct), bits(&b.bz_pct));
        assert_eq!(bits(&a.arrival_h), bits(&b.arrival_h));
        assert_eq!(a.p_hit, b.p_hit);
        // A different seed must actually change the draw.
        let c = run(&fit(), &spreads(), 43, 64, 0.0, 3600.0, 120, obs);
        assert_ne!(bits(&a.arrival_h), bits(&c.arrival_h));
    }

    #[test]
    fn zero_spread_collapses_to_deterministic_run() {
        let obs = observer_pos(1.0, 0.0, 0.0);
        let r = run(&fit(), &Spreads::default(), 7, 32, 0.0, 1800.0, 300, obs);
        assert!((r.p_hit - 1.0).abs() < 1e-12, "head-on zero-spread must always hit");
        // All members identical → the 5th and 95th percentile fans coincide.
        for i in 0..r.n_steps {
            let lo = r.bz_pct[i];
            let hi = r.bz_pct[4 * r.n_steps + i];
            assert!((lo - hi).abs() < 1e-6, "step {}: {} vs {}", i, lo, hi);
        }
        // And every member records the same arrival.
        let a0 = r.arrival_h[0];
        assert!(r.arrival_h.iter().all(|a| (a - a0).abs() < 1e-6));
    }

    #[test]
    fn spread_widens_the_fan_and_loses_some_members() {
        let obs = observer_pos(1.0, 0.0, 0.0);
        let r = run(&fit(), &spreads(), 1234, 300, 0.0, 1800.0, 300, obs);
        assert!(r.p_hit > 0.5 && r.p_hit <= 1.0, "p_hit {}", r.p_hit);
        // Somewhere mid-storm the 5–95 fan must be genuinely open.
        let mut max_width = 0.0f32;
        for i in 0..r.n_steps {
            if r.hit_frac[i] > 0.3 {
                let w = r.bz_pct[4 * r.n_steps + i] - r.bz_pct[i];
                assert!(w >= -1e-6, "percentiles out of order at {}", i);
                max_width = max_width.max(w);
            }
        }
        assert!(max_width > 3.0, "fan max width {} nT", max_width);
        // Storm probability machinery: strongly-south minima exist.
        assert!(r.p_min_bz_below(-10.0) > 0.3);
        assert!(r.p_min_bz_below(-10.0) >= r.p_min_bz_below(-20.0));
    }

    #[test]
    fn train_ensemble_samples_every_rope_and_stays_deterministic() {
        let obs = observer_pos(1.0, 0.0, 0.0);
        let p = RopeParams { v0_kms: 1400.0, tilt_deg: 90.0, ..Default::default() };
        let train = vec![RopeEntry::new(p, 0.0), RopeEntry::new(p, 24.0 * 3600.0)];
        let r = run(&train, &spreads(), 99, 100, 0.0, 1800.0, 500, obs);
        assert_eq!(r.ropes_per_member, 2);
        assert_eq!(r.member_params.len(), 100 * 2 * MEMBER_STRIDE);
        // The two ropes of one member are DIFFERENT draws (independent).
        let a = &r.member_params[0..MEMBER_STRIDE];
        let b = &r.member_params[MEMBER_STRIDE..2 * MEMBER_STRIDE];
        assert!(a != b, "per-rope draws must be independent");
        // Deterministic under the same seed.
        let r2 = run(&train, &spreads(), 99, 100, 0.0, 1800.0, 500, obs);
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&r.bz_pct), bits(&r2.bz_pct));
        assert_eq!(bits(&r.member_params), bits(&r2.member_params));
        // Two chances to hit can only help: the joint train p_hit must beat
        // a single-rope ensemble of either rope under the same priors.
        let solo = run(&train[..1], &spreads(), 99, 100, 0.0, 1800.0, 500, obs);
        assert!(r.p_hit >= solo.p_hit, "train {} < solo {}", r.p_hit, solo.p_hit);
        assert!(r.p_hit > 0.6, "p_hit {}", r.p_hit);
    }

    #[test]
    fn percentile_definition_inclusive_linear() {
        let a = [1.0f32, 2.0, 3.0, 4.0];
        assert!((percentile_sorted(&a, 0.0) - 1.0).abs() < 1e-7);
        assert!((percentile_sorted(&a, 100.0) - 4.0).abs() < 1e-7);
        assert!((percentile_sorted(&a, 50.0) - 2.5).abs() < 1e-7);
        assert!((percentile_sorted(&a, 25.0) - 1.75).abs() < 1e-7);
    }
}
