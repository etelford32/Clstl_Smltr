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
    /// Fraction of members inside the rope per step (weight-weighted after
    /// assimilation).
    pub hit_frac: Vec<f32>,
    /// Per-member arrival [hours after launch]; NaN = miss.
    pub arrival_h: Vec<f32>,
    /// Per-member window-min Bz [nT]; NaN = miss.
    pub min_bz: Vec<f32>,
    /// Per-member sampled params, MEMBER_STRIDE f32 each (envelope rendering).
    pub member_params: Vec<f32>,
    /// Full per-member Bz series, [step][member] layout (NaN = outside) —
    /// retained so assimilation (spec §11) can score members against
    /// observations after the run.
    pub member_bz: Vec<f32>,
    /// Full per-member |B| series, same layout.
    pub member_bt: Vec<f32>,
    /// Per-member Bz at the AUXILIARY observer (STEREO-A, spec §13) — same
    /// [step][member] layout; EMPTY when no aux observer was set for the
    /// run. Pre-arrival conditioning scores members against this.
    pub member_bz_aux: Vec<f32>,
    /// Importance weights (normalized). None = uniform (prior). Some after
    /// assimilate() — every statistic above is then weight-weighted.
    pub weights: Option<Vec<f64>>,
    /// Effective sample size 1/Σw² — n_members under uniform weights.
    pub ess: f64,
    /// Likelihood temperature λ ∈ (0, 1] applied by the last assimilate()
    /// (1 = untempered). λ < 1 means the correlated-observation likelihood
    /// was flattened to keep ESS above the floor — surfaced, never hidden.
    pub temperature: f64,
    pub p_hit: f64,
}

impl EnsembleResult {
    pub fn p_min_bz_below(&self, thr_nt: f64) -> f64 {
        if self.n_members == 0 {
            return 0.0;
        }
        match &self.weights {
            None => {
                let c = self.min_bz.iter().filter(|v| (**v as f64) < thr_nt).count();
                c as f64 / self.n_members as f64
            }
            Some(w) => self
                .min_bz
                .iter()
                .zip(w)
                .filter(|(v, _)| (**v as f64) < thr_nt)
                .map(|(_, wi)| wi)
                .sum(),
        }
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
/// `aux`: optional second observer position (STEREO-A). Recording it draws
/// NOTHING from the RNG and never touches the primary statistics — the same
/// seed yields a bit-identical L1 prior with or without it (pinned by test).
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
    aux: Option<V3>,
) -> EnsembleResult {
    let mut rng = Rng::new(seed);
    let n_ropes = fits.len().max(1);
    // Per-step member samples: NaN = outside. Column layout [step][member].
    let mut bz = vec![f32::NAN; n_steps * n_members];
    let mut bt = vec![f32::NAN; n_steps * n_members];
    let mut bz_aux = if aux.is_some() { vec![f32::NAN; n_steps * n_members] } else { Vec::new() };
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
            if let Some(aux_pos) = aux {
                let (ba, ca) = field_at_set(&train, t, aux_pos);
                if ca > 0 {
                    // Same GSE z-component convention as the primary (§2 —
                    // valid for observers near the Earth longitude; STA at
                    // ±20° keeps the error small vs the 4 nT obs sigma).
                    bz_aux[i * n_members + m] = to_gse(ba)[2] as f32;
                }
            }
        }
        if !member_arr.is_nan() {
            hit_members += 1;
        }
        arrival_h[m] = member_arr;
        min_bz[m] = member_min;
    }

    let mut res = EnsembleResult {
        n_members,
        n_steps,
        ropes_per_member: n_ropes,
        bz_pct: vec![0.0; PCTS.len() * n_steps],
        bt_med: vec![0.0; n_steps],
        hit_frac: vec![0.0; n_steps],
        arrival_h,
        min_bz,
        member_params,
        member_bz: bz,
        member_bt: bt,
        member_bz_aux: bz_aux,
        weights: None,
        ess: n_members as f64,
        temperature: 1.0,
        p_hit: hit_members as f64 / n_members.max(1) as f64,
    };
    compute_stats(&mut res);
    res
}

/// Recompute the fan statistics from the retained member series, honoring
/// the current importance weights (spec §7 unweighted / §11 weighted).
///
/// The `weights: None` path is bit-identical to the original v1
/// computation — the weighted path is a strict superset used only after
/// assimilate(), so the pinned Phase 1/2 numbers never move.
pub fn compute_stats(r: &mut EnsembleResult) {
    let (n_members, n_steps) = (r.n_members, r.n_steps);
    // Gate: minimum effective hit mass, expressed in member-count units so
    // the uniform case reproduces the original count gate exactly.
    let min_hits = ((0.05 * n_members as f64).ceil() as usize).max(2);
    let mut scratch: Vec<f32> = Vec::with_capacity(n_members);
    let mut wscratch: Vec<(f32, f64)> = Vec::with_capacity(n_members);

    for i in 0..n_steps {
        let row = &r.member_bz[i * n_members..(i + 1) * n_members];
        match &r.weights {
            None => {
                scratch.clear();
                scratch.extend(row.iter().copied().filter(|v| !v.is_nan()));
                r.hit_frac[i] = scratch.len() as f32 / n_members.max(1) as f32;
                if scratch.len() >= min_hits {
                    scratch.sort_by(|a, b| a.partial_cmp(b).unwrap());
                    for (k, q) in PCTS.iter().enumerate() {
                        r.bz_pct[k * n_steps + i] = percentile_sorted(&scratch, *q);
                    }
                    scratch.clear();
                    scratch.extend(
                        r.member_bt[i * n_members..(i + 1) * n_members]
                            .iter()
                            .copied()
                            .filter(|v| !v.is_nan()),
                    );
                    scratch.sort_by(|a, b| a.partial_cmp(b).unwrap());
                    r.bt_med[i] = percentile_sorted(&scratch, 50.0);
                } else {
                    for k in 0..PCTS.len() {
                        r.bz_pct[k * n_steps + i] = 0.0;
                    }
                    r.bt_med[i] = 0.0;
                }
            }
            Some(w) => {
                wscratch.clear();
                let mut hit_w = 0.0f64;
                for m in 0..n_members {
                    let v = row[m];
                    if !v.is_nan() {
                        hit_w += w[m];
                        wscratch.push((v, w[m]));
                    }
                }
                r.hit_frac[i] = hit_w as f32;
                if hit_w * n_members as f64 >= min_hits as f64 {
                    wscratch.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
                    for (k, q) in PCTS.iter().enumerate() {
                        r.bz_pct[k * n_steps + i] = weighted_quantile(&wscratch, *q);
                    }
                    wscratch.clear();
                    for m in 0..n_members {
                        let v = r.member_bt[i * n_members + m];
                        if !v.is_nan() {
                            wscratch.push((v, w[m]));
                        }
                    }
                    wscratch.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
                    r.bt_med[i] = weighted_quantile(&wscratch, 50.0);
                } else {
                    for k in 0..PCTS.len() {
                        r.bz_pct[k * n_steps + i] = 0.0;
                    }
                    r.bt_med[i] = 0.0;
                }
            }
        }
    }

    r.p_hit = match &r.weights {
        None => {
            r.arrival_h.iter().filter(|a| a.is_finite()).count() as f64
                / n_members.max(1) as f64
        }
        Some(w) => r
            .arrival_h
            .iter()
            .zip(w)
            .filter(|(a, _)| a.is_finite())
            .map(|(_, wi)| wi)
            .sum(),
    };
}

/// Weighted quantile of value-sorted (value, weight) pairs: linear
/// interpolation on the midpoint-convention weighted CDF (reduces to the
/// inclusive definition as weights → uniform).
fn weighted_quantile(sorted: &[(f32, f64)], q: f64) -> f32 {
    let tot_all: f64 = sorted.iter().map(|p| p.1).sum();
    if tot_all <= 0.0 {
        return if sorted.is_empty() { 0.0 } else { sorted[sorted.len() / 2].0 };
    }
    // Drop negligible-weight entries: a killed member (w ≈ 0) must not drag
    // the interpolation between the surviving values.
    let eps = 1e-12 * tot_all;
    let kept: Vec<(f32, f64)> = sorted.iter().copied().filter(|p| p.1 > eps).collect();
    let m = kept.len();
    if m == 0 {
        return 0.0;
    }
    if m == 1 {
        return kept[0].0;
    }
    let tot: f64 = kept.iter().map(|p| p.1).sum();
    let target = q / 100.0 * tot;
    // Midpoint CDF: c_k = cum_{k-1} + w_k/2.
    let mut cum = 0.0f64;
    let mut prev_c = 0.0f64;
    let mut prev_v = kept[0].0;
    for (k, (v, w)) in kept.iter().enumerate() {
        let c = cum + w / 2.0;
        if target <= c {
            if k == 0 {
                return *v;
            }
            let f = ((target - prev_c) / (c - prev_c).max(1e-300)) as f32;
            return prev_v + (v - prev_v) * f;
        }
        cum += w;
        prev_c = c;
        prev_v = *v;
    }
    kept[m - 1].0
}

/// Normalized weights + ESS for tempered log-weights λ·logw.
fn weights_at(logw: &[f64], lambda: f64) -> (Vec<f64>, f64) {
    let max_lw = logw.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let mut w: Vec<f64> = logw.iter().map(|l| ((l - max_lw) * lambda).exp()).collect();
    let tot: f64 = w.iter().sum();
    for wi in w.iter_mut() {
        *wi /= tot;
    }
    let ess = 1.0 / w.iter().map(|wi| wi * wi).sum::<f64>();
    (w, ess)
}

/// Sequential-importance assimilation step (spec §11): Gaussian
/// log-likelihood of each member's Bz series against observations `obs`
/// (same time grid as the run; NaN = gap) over step indices [i0, i1),
/// converted to normalized importance weights, then every fan statistic is
/// recomputed weighted. Model prediction outside the rope is 0 nT (quiet
/// ambient — `sigma_nt` must absorb the unmodeled ±5 nT background, hence
/// the 4 nT default at the ABI).
///
/// DEGENERACY GUARD (`ess_floor_frac`): a naive product likelihood over
/// hundreds of 5-min samples is wildly overconfident — real Bz observations
/// are strongly autocorrelated and the model has irreducible
/// representativeness error (no sheath, no ambient IMF), so untempered
/// weights collapse onto one least-bad member. When ESS would fall below
/// `ess_floor_frac · n_members`, the log-likelihood is annealed (λ·logw,
/// bisected λ ∈ (0,1]) to hold ESS at the floor, and the applied
/// temperature is stored on the result — surfaced to the UI, never hidden.
/// `ess_floor_frac = 0` disables tempering (pure likelihood).
///
/// Returns the effective sample size 1/Σw². Deterministic; no RNG.
/// Reweight-only (no resampling): each call re-conditions the ORIGINAL
/// prior ensemble on the full observed window, so there is no
/// weight-degeneracy accumulation across calls.
pub fn assimilate(
    r: &mut EnsembleResult,
    obs: &[f32],
    i0: usize,
    i1: usize,
    sigma_nt: f64,
    ess_floor_frac: f64,
) -> f64 {
    assimilate_joint(r, obs, i0, i1, sigma_nt, &[], 0, 0, sigma_nt, ess_floor_frac)
}

/// Accumulate Gaussian log-likelihood terms from one observer's series
/// matrix ([step][member], NaN = model-outside → predicts 0 nT) into `logw`.
/// Returns the number of finite observations consumed.
fn accumulate_loglik(
    series: &[f32],
    n_members: usize,
    n_steps: usize,
    obs: &[f32],
    i0: usize,
    i1: usize,
    sigma_nt: f64,
    logw: &mut [f64],
) -> usize {
    if series.is_empty() {
        return 0;
    }
    let i1 = i1.min(n_steps).min(obs.len());
    let inv2s2 = 0.5 / (sigma_nt * sigma_nt).max(1e-12);
    let mut n_obs = 0usize;
    for i in i0..i1 {
        let y = obs[i];
        if !y.is_finite() {
            continue;
        }
        n_obs += 1;
        let row = &series[i * n_members..(i + 1) * n_members];
        for m in 0..n_members {
            let pred = if row[m].is_nan() { 0.0 } else { row[m] as f64 };
            let d = pred - y as f64;
            logw[m] -= d * d * inv2s2;
        }
    }
    n_obs
}

/// JOINT assimilation over the primary (L1) and auxiliary (STEREO-A, spec
/// §13) observers: independent observations, so the log-likelihoods ADD,
/// and the degeneracy guard tempers the JOINT likelihood once — the
/// Bayesian combination, not two sequential filters. The aux terms use the
/// member series recorded when the ensemble ran with an aux observer set;
/// with no aux recording or an empty aux window this reduces exactly to the
/// primary-only update (pinned by test).
#[allow(clippy::too_many_arguments)]
pub fn assimilate_joint(
    r: &mut EnsembleResult,
    obs: &[f32],
    i0: usize,
    i1: usize,
    sigma_nt: f64,
    obs_aux: &[f32],
    aux_i0: usize,
    aux_i1: usize,
    aux_sigma_nt: f64,
    ess_floor_frac: f64,
) -> f64 {
    let n_members = r.n_members;
    if n_members == 0 {
        return 0.0;
    }
    let mut logw = vec![0.0f64; n_members];
    let mut n_obs = accumulate_loglik(
        &r.member_bz, n_members, r.n_steps, obs, i0, i1, sigma_nt, &mut logw,
    );
    n_obs += accumulate_loglik(
        &r.member_bz_aux, n_members, r.n_steps, obs_aux, aux_i0, aux_i1, aux_sigma_nt, &mut logw,
    );
    if n_obs == 0 {
        // Nothing observed: stay on the prior (uniform), bit-identical stats.
        r.weights = None;
        r.ess = n_members as f64;
        r.temperature = 1.0;
        compute_stats(r);
        return r.ess;
    }

    let floor = (ess_floor_frac * n_members as f64).clamp(0.0, n_members as f64 - 1.0);
    let (mut w, mut ess) = weights_at(&logw, 1.0);
    let mut lambda = 1.0;
    if ess < floor {
        // Anneal: ESS(λ) is monotone-decreasing in λ; bisect to the floor.
        let (mut lo, mut hi) = (0.0f64, 1.0f64);
        for _ in 0..50 {
            let mid = 0.5 * (lo + hi);
            let (_, e) = weights_at(&logw, mid);
            if e < floor {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        lambda = lo;
        let (wl, el) = weights_at(&logw, lambda);
        w = wl;
        ess = el;
    }
    r.weights = Some(w);
    r.ess = ess;
    r.temperature = lambda;
    compute_stats(r);
    ess
}

/// Drop assimilation: back to the uniform prior (bit-identical stats).
pub fn reset_weights(r: &mut EnsembleResult) {
    r.weights = None;
    r.ess = r.n_members as f64;
    r.temperature = 1.0;
    compute_stats(r);
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
        let a = run(&fit(), &spreads(), 42, 64, 0.0, 3600.0, 120, obs, None);
        let b = run(&fit(), &spreads(), 42, 64, 0.0, 3600.0, 120, obs, None);
        // Bit-pattern compare: arrival/min arrays legitimately contain NaN
        // (miss members), and NaN != NaN under assert_eq.
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&a.bz_pct), bits(&b.bz_pct));
        assert_eq!(bits(&a.arrival_h), bits(&b.arrival_h));
        assert_eq!(a.p_hit, b.p_hit);
        // A different seed must actually change the draw.
        let c = run(&fit(), &spreads(), 43, 64, 0.0, 3600.0, 120, obs, None);
        assert_ne!(bits(&a.arrival_h), bits(&c.arrival_h));
    }

    #[test]
    fn zero_spread_collapses_to_deterministic_run() {
        let obs = observer_pos(1.0, 0.0, 0.0);
        let r = run(&fit(), &Spreads::default(), 7, 32, 0.0, 1800.0, 300, obs, None);
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
        let r = run(&fit(), &spreads(), 1234, 300, 0.0, 1800.0, 300, obs, None);
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
        let r = run(&train, &spreads(), 99, 100, 0.0, 1800.0, 500, obs, None);
        assert_eq!(r.ropes_per_member, 2);
        assert_eq!(r.member_params.len(), 100 * 2 * MEMBER_STRIDE);
        // The two ropes of one member are DIFFERENT draws (independent).
        let a = &r.member_params[0..MEMBER_STRIDE];
        let b = &r.member_params[MEMBER_STRIDE..2 * MEMBER_STRIDE];
        assert!(a != b, "per-rope draws must be independent");
        // Deterministic under the same seed.
        let r2 = run(&train, &spreads(), 99, 100, 0.0, 1800.0, 500, obs, None);
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&r.bz_pct), bits(&r2.bz_pct));
        assert_eq!(bits(&r.member_params), bits(&r2.member_params));
        // Two chances to hit can only help: the joint train p_hit must beat
        // a single-rope ensemble of either rope under the same priors.
        let solo = run(&train[..1], &spreads(), 99, 100, 0.0, 1800.0, 500, obs, None);
        assert!(r.p_hit >= solo.p_hit, "train {} < solo {}", r.p_hit, solo.p_hit);
        assert!(r.p_hit > 0.6, "p_hit {}", r.p_hit);
    }

    #[test]
    fn assimilation_collapses_onto_truth() {
        let obs_pos = observer_pos(1.0, 0.0, 0.0);
        let mut r = run(&fit(), &spreads(), 4242, 200, 0.0, 1800.0, 300, obs_pos, None);
        let n = r.n_members;
        // Synthetic truth: a member that genuinely HITS with signal inside
        // the observed window (a missing member predicts 0 everywhere and
        // would leave every other quiet member equally weighted).
        let tm = (0..n)
            .find(|m| {
                r.arrival_h[*m].is_finite()
                    && r.arrival_h[*m] < 55.0
                    && r.min_bz[*m] < -8.0
            })
            .expect("ensemble must contain an early strong hit");
        let truth: Vec<f32> = (0..r.n_steps)
            .map(|i| {
                let v = r.member_bz[i * n + tm];
                if v.is_nan() { 0.0 } else { v }
            })
            .collect();
        // The mid-storm-correction scenario (the product claim): observe up
        // to shortly after the truth's FRONT arrival, hold out the rest of
        // the rope passage, and require the corrected median to beat the
        // prior median there.
        let i_arr = (r.arrival_h[tm] as f64 * 3600.0 / 1800.0).round() as usize;
        let (obs_end, held) = (i_arr + 8, i_arr + 8..(i_arr + 34).min(300));
        let prior_med: Vec<f32> = held.clone().map(|i| r.bz_pct[2 * r.n_steps + i]).collect();
        let ess = assimilate(&mut r, &truth, 0, obs_end, 1.0, 0.0);
        assert!(ess < n as f64 / 4.0, "posterior must collapse: ESS {}", ess);
        let w = r.weights.as_ref().unwrap();
        let best = (0..n).max_by(|a, b| w[*a].partial_cmp(&w[*b]).unwrap()).unwrap();
        assert_eq!(best, tm, "the generating member must carry the top weight");
        let (mut err_post, mut err_prior) = (0.0f64, 0.0f64);
        for (k, i) in held.enumerate() {
            let t = truth[i] as f64;
            err_post += (r.bz_pct[2 * r.n_steps + i] as f64 - t).abs();
            err_prior += (prior_med[k] as f64 - t).abs();
        }
        assert!(err_prior > 1.0, "held-out storm segment must have real signal");
        assert!(
            err_post < err_prior,
            "mid-storm correction must sharpen the remaining passage: post {} vs prior {}",
            err_post,
            err_prior
        );
    }

    #[test]
    fn assimilation_with_no_observations_is_the_prior() {
        let obs_pos = observer_pos(1.0, 0.0, 0.0);
        let mut r = run(&fit(), &spreads(), 99, 100, 0.0, 1800.0, 200, obs_pos, None);
        let prior_pct = r.bz_pct.clone();
        let prior_phit = r.p_hit;
        let ess = assimilate(&mut r, &vec![f32::NAN; 200], 0, 200, 4.0, 0.1);
        assert_eq!(ess, 100.0, "all-gap obs → uniform ESS");
        assert!(r.weights.is_none());
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&r.bz_pct), bits(&prior_pct), "prior stats must be bit-identical");
        assert_eq!(r.p_hit, prior_phit);
    }

    #[test]
    fn assimilation_deterministic_and_resettable() {
        let obs_pos = observer_pos(1.0, 0.0, 0.0);
        let mut r = run(&fit(), &spreads(), 7, 100, 0.0, 1800.0, 200, obs_pos, None);
        let prior_pct = r.bz_pct.clone();
        let obs: Vec<f32> = (0..200)
            .map(|i| if (80..120).contains(&i) { -12.0 } else { f32::NAN })
            .collect();
        let e1 = assimilate(&mut r, &obs, 0, 200, 4.0, 0.0);
        let post1 = r.bz_pct.clone();
        let e2 = assimilate(&mut r, &obs, 0, 200, 4.0, 0.0);
        assert_eq!(e1, e2);
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&r.bz_pct), bits(&post1), "assimilation must be deterministic");
        assert!(e1 > 1.0 && e1 < 100.0, "informative obs must reweight: ESS {}", e1);
        reset_weights(&mut r);
        assert_eq!(bits(&r.bz_pct), bits(&prior_pct), "reset must restore the prior");
        assert_eq!(r.ess, 100.0);
    }

    #[test]
    fn aux_observer_recording_never_touches_the_primary_prior() {
        let l1 = observer_pos(1.0, 0.0, 0.0);
        let sta = observer_pos(0.96, 14.0, 0.0);
        let plain = run(&fit(), &spreads(), 77, 100, 0.0, 1800.0, 300, l1, None);
        let with_aux = run(&fit(), &spreads(), 77, 100, 0.0, 1800.0, 300, l1, Some(sta));
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&plain.bz_pct), bits(&with_aux.bz_pct), "L1 prior must be bit-identical");
        assert_eq!(bits(&plain.arrival_h), bits(&with_aux.arrival_h));
        assert!(plain.member_bz_aux.is_empty());
        assert_eq!(with_aux.member_bz_aux.len(), 300 * 100);
        // The flank observer genuinely sees some members.
        let aux_hits = with_aux.member_bz_aux.iter().filter(|v| !v.is_nan()).count();
        assert!(aux_hits > 0, "STA at +14 deg must catch flanks");
    }

    /// The OSSE (Observing System Simulation Experiment) at the core of the
    /// STEREO-A claim (spec §13): condition on the aux observer's data from
    /// BEFORE the truth reaches L1, and the L1 forecast must sharpen.
    #[test]
    fn osse_sta_pre_arrival_conditioning_sharpens_the_l1_forecast() {
        let l1 = observer_pos(1.0, 0.0, 0.0);
        let sta = observer_pos(0.96, 14.0, 0.0);
        // Launch aimed between Earth and STA so flanks brush both.
        let fits = vec![RopeEntry::new(
            RopeParams { v0_kms: 1100.0, tilt_deg: 90.0, lon_deg: 6.0, ..Default::default() },
            0.0,
        )];
        let mut r = run(&fits, &spreads(), 2468, 300, 0.0, 1800.0, 300, l1, Some(sta));
        let n = r.n_members;
        // Truth: a member that hits BOTH observers, STA first.
        let first_aux = |m: usize| {
            (0..r.n_steps).find(|i| !r.member_bz_aux[i * n + m].is_nan())
        };
        let first_l1 = |m: usize| {
            (0..r.n_steps).find(|i| !r.member_bz[i * n + m].is_nan())
        };
        let tm = (0..n)
            .find(|m| {
                matches!((first_aux(*m), first_l1(*m)), (Some(a), Some(l)) if a + 4 < l)
                    && r.min_bz[*m] < -8.0
            })
            .expect("some member must brush STA clearly before L1");
        let ia = first_aux(tm).unwrap();
        let il = first_l1(tm).unwrap();
        // Observe ONLY the aux signal, ending BEFORE the truth reaches L1.
        let obs_aux: Vec<f32> = (0..r.n_steps)
            .map(|i| {
                if i < il - 2 {
                    let v = r.member_bz_aux[i * n + tm];
                    if v.is_nan() { 0.0 } else { v }
                } else {
                    f32::NAN
                }
            })
            .collect();
        // Prior L1 median over the truth's storm passage (all held out).
        let held: Vec<usize> = (il..(il + 40).min(r.n_steps)).collect();
        let prior_med: Vec<f32> = held.iter().map(|&i| r.bz_pct[2 * r.n_steps + i]).collect();
        let prior_p10 = r.p_min_bz_below(-10.0);

        let ess = assimilate_joint(&mut r, &[], 0, 0, 4.0, &obs_aux, ia, il - 2, 1.5, 0.0);
        assert!(ess < n as f64 / 3.0, "STA flank data must collapse the posterior: ESS {}", ess);
        let w = r.weights.as_ref().unwrap();
        let best = (0..n).max_by(|a, b| w[*a].partial_cmp(&w[*b]).unwrap()).unwrap();
        assert_eq!(best, tm, "the generating member must dominate");
        // The ENTIRE L1 storm is still in the future — and the forecast for
        // it must beat the prior. This is the pre-arrival lead-time claim.
        let (mut err_post, mut err_prior) = (0.0f64, 0.0f64);
        for (k, &i) in held.iter().enumerate() {
            let t = {
                let v = r.member_bz[i * n + tm];
                if v.is_nan() { 0.0 } else { v }
            } as f64;
            err_post += (r.bz_pct[2 * r.n_steps + i] as f64 - t).abs();
            err_prior += (prior_med[k] as f64 - t).abs();
        }
        assert!(err_prior > 1.0, "held-out storm must have signal");
        assert!(
            err_post < err_prior,
            "pre-arrival STA conditioning must sharpen the L1 forecast: post {} vs prior {}",
            err_post,
            err_prior
        );
        // And the storm call moves toward the truth's severity.
        let post_p10 = r.p_min_bz_below(-10.0);
        if r.min_bz[tm] < -10.0 {
            assert!(post_p10 > prior_p10, "P(<-10): post {} vs prior {}", post_p10, prior_p10);
        }
    }

    #[test]
    fn joint_with_empty_aux_window_equals_primary_only() {
        let l1 = observer_pos(1.0, 0.0, 0.0);
        let sta = observer_pos(0.96, 14.0, 0.0);
        let mut r1 = run(&fit(), &spreads(), 7, 100, 0.0, 1800.0, 200, l1, Some(sta));
        let mut r2 = run(&fit(), &spreads(), 7, 100, 0.0, 1800.0, 200, l1, Some(sta));
        let obs: Vec<f32> = (0..200)
            .map(|i| if (80..120).contains(&i) { -12.0 } else { f32::NAN })
            .collect();
        let e1 = assimilate(&mut r1, &obs, 0, 200, 4.0, 0.1);
        let e2 = assimilate_joint(&mut r2, &obs, 0, 200, 4.0, &[], 0, 0, 4.0, 0.1);
        assert_eq!(e1, e2);
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&r1.bz_pct), bits(&r2.bz_pct));
    }

    #[test]
    fn tempering_holds_the_ess_floor_and_reports_temperature() {
        // Overconfident likelihood (hundreds of tight obs) must NOT collapse
        // to one member when a floor is requested — and the applied
        // temperature must be surfaced.
        let obs_pos = observer_pos(1.0, 0.0, 0.0);
        let mut r = run(&fit(), &spreads(), 4242, 200, 0.0, 1800.0, 300, obs_pos, None);
        let n = r.n_members;
        let tm = (0..n)
            .find(|m| r.arrival_h[*m].is_finite() && r.min_bz[*m] < -8.0)
            .unwrap();
        let truth: Vec<f32> = (0..r.n_steps)
            .map(|i| {
                let v = r.member_bz[i * n + tm];
                if v.is_nan() { 0.0 } else { v }
            })
            .collect();
        // Untempered: near-total collapse.
        let e0 = assimilate(&mut r, &truth, 0, 300, 1.0, 0.0);
        assert!(e0 < 5.0, "untempered ESS should collapse: {}", e0);
        assert_eq!(r.temperature, 1.0);
        // Floor at 15%: ESS held at the floor, λ < 1 and REPORTED.
        let e1 = assimilate(&mut r, &truth, 0, 300, 1.0, 0.15);
        assert!(
            e1 >= 0.15 * n as f64 * 0.98,
            "floor must hold: ESS {} < {}",
            e1,
            0.15 * n as f64
        );
        assert!(r.temperature < 1.0 && r.temperature > 0.0);
        // The truth member still carries the top weight after tempering.
        let w = r.weights.as_ref().unwrap();
        let best = (0..n).max_by(|a, b| w[*a].partial_cmp(&w[*b]).unwrap()).unwrap();
        assert_eq!(best, tm);
    }

    #[test]
    fn weighted_quantile_reduces_to_inclusive_for_uniform() {
        let vals = [1.0f32, 2.0, 3.0, 4.0];
        let wpairs: Vec<(f32, f64)> = vals.iter().map(|v| (*v, 0.25)).collect();
        // Midpoint convention differs from inclusive by < half a gap at the
        // extremes; interior quantiles agree.
        assert!((weighted_quantile(&wpairs, 50.0) - 2.5).abs() < 1e-6);
        // Degenerate all-weight-on-one collapses to that value.
        let point: Vec<(f32, f64)> = vec![(1.0, 0.0), (2.0, 1.0), (3.0, 0.0)];
        assert!((weighted_quantile(&point, 5.0) - 2.0).abs() < 1e-6);
        assert!((weighted_quantile(&point, 95.0) - 2.0).abs() < 1e-6);
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
