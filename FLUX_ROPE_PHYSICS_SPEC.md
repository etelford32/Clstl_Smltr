# Flux Rope Simulator — physics specification (v1)

> The normative spec for `rust-flux-rope/` (crate `flux-rope-core`). The Rust
> implementation transcribes THIS document; if code and spec disagree, one of
> them has a bug and the fix must land in both. Model class: 3DCORE-style
> semi-empirical tapered torus (Möstl et al. 2018; Weiss et al. 2021 lineage)
> with Gold-Hoyle internal field and drag-based (DBM) kinematics
> (Vršnak et al. 2013). Every symbol, unit, and sign convention used by the
> kernel is defined here.

## 1. Units and constants

Internal units: **km, s, nT, degrees at the API boundary / radians internally**.

| Constant | Value |
|---|---|
| `AU_KM` | 1.495978707e8 km |
| `RSUN_KM` | 6.957e5 km |
| L1 observer default | r = 0.99 AU, lon 0°, lat 0° (HEEQ-like) |
| Proton mass (for Pdyn) | 1.67262192e-27 kg |

Dynamic pressure (SolarWindDriver derived field):
`Pdyn [nPa] = 1.6726e-6 · n[cm⁻³] · v[km/s]²` (protons only — matches the
convention in the existing SWPC ingestion).

## 2. Heliocentric frame and the GSE mapping

Heliocentric right-handed frame `H`, fixed for a run (Earth assumed static
over the ≤5-day propagation window — orbital motion of ~1°/day is folded into
the launch-longitude prior, not modeled):

- `ê_r` — Sun → Earth unit vector (Earth at `+r ê_r`).
- `ê_N` — ecliptic/solar north.
- `ê_E = ê_N × ê_r` — Earth's orbital-motion direction ("east").

A launch direction (longitude `φ₀`, latitude `θ₀`, both **degrees**, HEEQ-like,
Earth at `(0°, 0°)`, `+φ` toward `ê_E`, `+θ` toward `ê_N`):

```
ê_dir = cosθ₀ cosφ₀ · ê_r + cosθ₀ sinφ₀ · ê_E + sinθ₀ · ê_N
```

**GSE output frame** at the observer (X Earth→Sun, Z ecliptic north,
Y = Z × X duskward):

```
Bx_GSE = −B·ê_r      By_GSE = −B·ê_E      Bz_GSE = +B·ê_N
```

(v1 ignores the ~7° GSE/GSM difference; the driver schema records the frame
per source. The downstream ring-current VBs coupling uses |Bz| south, which is
frame-insensitive at this fidelity.)

## 3. Geometry — tapered torus ("croissant")

The rope axis is a **circle through the Sun center and the apex**, in the
plane spanned by `ê_dir` and the in-plane perpendicular `ê_p`, where the
**tilt** `γ` (degrees) rotates that plane about `ê_dir`:

```
ê_E' = normalize(ê_N × ê_dir)   ê_N' = ê_dir × ê_E'   (LOCAL east/north at ê_dir)
ê_p  = cosγ · ê_E' + sinγ · ê_N'        n̂ = ê_dir × ê_p   (axis-plane normal)
```

(The local basis keeps ê_p ⊥ ê_dir for off-Sun–Earth-line launches; at
`(φ₀, θ₀) = (0, 0)` it reduces to `ê_p = cosγ·ê_E + sinγ·ê_N`.)

With apex distance `d(t)` (km, from §5), the axis is parameterized by
`ψ ∈ [0, 2π)`, `ψ = 0` at the Sun, `ψ = π` at the apex:

```
A(ψ) = (d/2)·[(1 − cosψ)·ê_dir + sinψ·ê_p]        (circle, radius d/2)
t̂(ψ) = sinψ·ê_dir + cosψ·ê_p                      (unit tangent)
```

Consequences of the convention (verified by cargo tests):
- apex position `A(π) = d·ê_dir`; apex tangent `t̂(π) = −ê_p`.
- `γ = 0` → apex axis lies east–west (low-inclination rope: axial field maps
  mostly into ±By at the observer); `γ = ±90°` → axis north–south (axial
  field maps into ∓/±Bz). Sign: at `γ = +90°`, `t̂(π) = −ê_N` → axial field
  `+B` along `t̂` gives **negative** Bz_GSE.

**Tapered cross-section** (fat at apex, pinched at the footpoints):

```
σ(ψ, t) = σ_apex(t) · sin²(ψ/2)
```

`σ_apex(t)` is the apex minor radius from the self-similar expansion law (§5).

**Inside test / local field frame** for a field point `P` (km, frame `H`):

```
u = P·ê_dir     w = P·ê_p     h = P·n̂          (decompose)
q = (u − d/2, w)                                 (in-plane offset from center C)
ρ_ip = |q|                                       (in-plane distance from C)
ψ    = atan2(w, −(u − d/2))  wrapped to [0, 2π)  (ψ=0 at Sun ✓, ψ=π at apex ✓)
s    = √( (ρ_ip − d/2)² + h² )                   (distance from the axis circle)
```

`P` is **inside the rope** iff `s < σ(ψ, t)`. Local orthonormal field frame:

```
N  = C + (d/2)·q̂  (lifted to H)     r̂ = (P − N)/s     φ̂ = t̂(ψ) × r̂
```

(`s = 0` on the axis: return the pure axial field along `t̂`.)

## 4. Internal magnetic field

Two profiles behind one interface; **Gold-Hoyle (uniform twist)** is the v1
default, **Lundquist** is the alternate for comparison.

Axial field strength scales with apex distance (self-similar flux erosion):

```
B_axis(d) = B₁AU · (d / AU)^(−n_B)          n_B = 1.64 default
```

`B₁AU` (nT) is a prior/fit parameter — specifying the field at 1 AU makes
priors directly comparable to L1 data.

**Twist**: `τ` = total field-line turns from footpoint to footpoint. The axis
circle has radius `d/2`, so the footpoint-to-footpoint axis length is its full
circumference `L = 2π·(d/2) = π·d`, and the twist per unit length is
`T = 2π·τ / L = 2τ/d` [rad/km]. Total turns are
conserved as the rope lengthens — twist per length dilutes as `1/d`
(physical: winding is frozen-in).

**Gold-Hoyle** (force-free, uniform twist), with chirality `H = ±1`
(+1 right-handed):

```
B_axial(s)    = B_axis / (1 + T²s²)
B_poloidal(s) = H · B_axis · T·s / (1 + T²s²)
B(P) = B_axial·t̂ + B_poloidal·φ̂
```

**Lundquist** (linear force-free), boundary at first zero of J₀
(`α·σ = 2.4048`):

```
B_axial(s)    = B_axis · J₀(α·s)
B_poloidal(s) = H · B_axis · J₁(α·s)      α = 2.4048 / σ(ψ, t)
```

J₀/J₁ via polynomial approximations (Abramowitz & Stegun 9.4.1/9.4.4,
|error| < 5e-8 on the needed range — adequate at nT scale).

Outside the rope (`s ≥ σ`): `B = 0` and the inside flag is false. v1 has **no
sheath model** — the observed sheath interval ahead of the rope will show as a
systematic miss in validation, and that is reported honestly (sheath is
Phase 5).

## 5. Kinematics — drag-based model (DBM) + self-similar expansion

Apex equation of motion (Vršnak et al. 2013):

```
dv/dt = −Γ·(v − w)·|v − w|
```

`w` = ambient solar-wind speed (km/s, constant in v1; the Parker-solver
profile is a later tie-in), `Γ` = drag parameter [km⁻¹], typical range
0.1e-7 … 2e-7 km⁻¹.

Closed-form solution used by the kernel (no ODE integration; `Δv₀ = v₀ − w`,
`sgn = sign(Δv₀)`, launch at `t = 0` from `d₀`):

```
v(t) = w + Δv₀ / (1 + Γ·|Δv₀|·t)
d(t) = d₀ + w·t + sgn·ln(1 + Γ·|Δv₀|·t) / Γ
```

(Decelerates toward `w` when `v₀ > w`, accelerates toward `w` when `v₀ < w`;
`Γ = 0` degenerates to `d₀ + v₀·t` — guard the division.)

**Self-similar expansion** of the apex cross-section radius (Leitner et al.
2007 statistics: minor radius ∝ d^1.14, B ∝ d^−1.64):

```
σ_apex(d) = σ₁AU · (d / AU)^(n_σ)           n_σ = 1.14 default
```

`σ₁AU` default 0.115 AU (Lepping-class mean rope diameter ≈ 0.23 AU at 1 AU).

## 6. Virtual spacecraft

An observer at fixed heliocentric `(r_obs, φ_obs, θ_obs)` is flown through the
evolving rope: for each sample time `t` on a uniform grid, evaluate §3–§5 at
the observer position and emit `(Bx, By, Bz)_GSE` plus an inside flag. This is
the synthetic in situ time series — the money output. Arrival time = first
sample with inside flag true; duration = inside-flag dwell; min Bz over the
window is the geoeffectiveness headline.

## 7. Ensemble layer

Deterministic seeded PRNG (**splitmix64 → xoshiro256\*\***; same seed → same
ensemble, bit-for-bit, in WASM and native — no `Math.random`, no ambient
entropy). Members sample the launch parameters:

| Parameter | Prior |
|---|---|
| lon, lat, tilt | Normal(fit, σ), σ per-parameter |
| v₀ | Normal(fit, σ_v) |
| B₁AU, σ₁AU, Γ | Log-normal around fit (multiplicative spread) |
| τ (twist) | Normal, clamped to `sign(τ_fit)` half-line |
| chirality H | flips with probability `p_flip` |

Normal deviates via Box–Muller on the PRNG stream. Outputs on the common time
grid: per-time-step percentiles {5, 25, 50, 75, 95} of Bz_GSE and of |B|;
per-member arrival time (NaN if a miss); scalar probabilities
`P(hit)`, `P(min Bz < threshold)` for caller-supplied thresholds.

Percentile convention: linear interpolation between order statistics
(NIST/Excel "inclusive" definition), computed over **hit members only** for
field percentiles at times where ≥5% of members are inside; else 0-filled with
the hit-fraction channel exposed so the UI can fade the fan by coverage.

## 8. St. Patrick's 2015 reference fit (Phase 1 validation)

Ground truth: `data/hindcast/st_patrick_mar_2015_replay.json` — observed 5-min
OMNI Bz/V/N over 2015-03-16T12:00Z → 03-19T12:00Z; shock at +16.8 h
(≈ 03-17T04:48Z); obs min Bz ≈ −26 nT (read live from the bundle by the smoke
test, never hard-coded).

Reference fit (hand fit, DONKI-informed launch; recorded as a **fit**, not a
blind forecast — see plan §6): CME launch 2015-03-15T01:15Z ≈ **50 h before
shock arrival**. The smoke test pins: arrival-time error < ±6 h, min Bz within
±35% of observed, Bz-shape correlation over the rope interval > 0.55,
duration within a factor of 2. Tolerances are deliberately honest — a
sheathless single-rope v1 cannot do better without overfitting, and the gate
exists to catch *regressions*, not to flatter the model. The fitted parameter
values live in ONE place, `js/flux-rope-presets.js` (`ST_PATRICK_FIT` —
imported by both the smoke test and the page), so re-fits are diffable and
test-gated.

## 9. ABI sketch (informative)

Single global engine behind `extern "C"` (rust-ring-current precedent): one
statically-capped output buffer (`MAX_STEPS = 4096` samples × channel), maps
COPIED out by `js/flux-rope-kernel.js` (`.slice()` — every call refills the
shared buffer). `fr_set_rope(...)` resets to a single §3–§5 rope (v1 API);
`fr_clear_ropes()` / `fr_push_rope(..., t_launch_s)` build a §10 train;
`fr_series(...)` fills the synthetic in situ series (channel 3 = containment
count); `fr_field_at(t, x, y, z)` samples the superposed field at an
arbitrary heliocentric point (the page's GLSL view mirrors the same math
in-shader; the kernel is the oracle); `fr_ens_run(seed, n, ...)` +
percentile/arrival/probability getters expose §7, with
`fr_ens_member_params_ptr` laid out member-major over
`fr_ens_ropes_per_member()` records.

## 10. Multi-rope trains (v1.1, Phase 2)

A CME **train** is a sequence of up to `MAX_ROPES = 4` ropes, each with its
own §3–§5 parameterization and a launch offset `t_launch` [s] relative to
one reference epoch (the first rope's launch by convention). The v1 train
model makes exactly one assumption, stated loudly:

> **The ropes do not interact.** Each propagates §5 kinematics
> independently; where two ropes contain the same point, the field is the
> plain vector **superposition** and the sample's `containment count` is
> ≥ 2. No momentum exchange, no compression, no deflection, no merging.

A rope contributes nothing before its launch (`t < t_launch` — the DBM is
undefined for negative time; the guard skips, never extrapolates). The
containment-count channel replaces the boolean inside flag in the series
output (0/1 for single ropes — bitwise-compatible with v1 consumers) and is
the **honest diagnostic**: count ≥ 2 marks exactly where the no-interaction
assumption breaks. Real trains also break it *without* overlap — the Gannon
fit's compact, strong rope A (σ 0.085 AU, 55 nT at 1 AU) is absorbing real
compression by the train behind it — so validation reports state both the
overlap fraction and the compression-shaped parameter fits. CME–CME
interaction physics (momentum exchange + compression heuristics) is the
Phase 5 fix.

The ensemble layer (§7) samples **every rope of the train independently per
member** (sequential draws from one stream — order is part of the
determinism contract; launch offsets stay fixed at the fit values), then
flies the observer through each member's superposed train. A 1-rope train
reproduces the v1 single-rope ensemble draw-for-draw.

**Gannon May 2024 reference fit** (`GANNON_FIT` in
`js/flux-rope-presets.js`, pinned by the smoke test against
`data/hindcast/gannon_may_2024_l1_replay.json` — baked from the SWMF OMNI fixture
by `scripts/build-gannon-l1-replay.mjs`): two ropes anchored to the AR 13664
flare catalog (X1.0 2024-05-08T21:08Z → launch 21:30 = epoch; X2.2
2024-05-09T~17:20Z → launch 17:45, +20.25 h), X3.9/X5.8 CMEs unmodeled.
Holds: global min Bz −43.8 vs −44.17 nT observed (0.9%), min-Bz timing
Δ1.0 h, full-window shape r = 0.71, both southward episodes reproduced,
southward dwell (< −10 nT) 18.5 vs 15.9 h.

## 11. Assimilation — sequential importance reweighting (Phase 3)

The particle-filter step conditions a stored ensemble (§7) on observed Bz
without re-running any member. Observations `y_i` [nT, GSM] live on the SAME
time grid as the run (NaN = gap), over step indices `[i0, i1)` — the page's
"now-line". Per member m:

```
log w_m = −(1 / 2σ²) · Σ_i (bz_m(t_i) − y_i)²      (finite y_i only)
```

with the convention that a member OUTSIDE the rope predicts **0 nT** (the
engine models no ambient IMF), so `σ` is a combined observation +
representativeness error — default **4 nT** to absorb the unmodeled ±5 nT
background and sheath. Weights are normalized via log-sum-exp; every fan
statistic, hit fraction, P(hit) and P(min Bz < thr) becomes weight-weighted
(weighted quantiles use the midpoint-CDF convention, with negligible-weight
members excluded so killed members cannot drag interpolation).

**Degeneracy guard (likelihood tempering).** A product likelihood over
hundreds of strongly-autocorrelated 5-min samples is wildly overconfident:
untempered, ESS collapses to ~1 on real data. When ESS would fall below
`ess_floor_frac · n` (default 0.1), the log-likelihood is annealed —
`λ · log w`, λ bisected in (0, 1] — to hold ESS at the floor, and **the
applied temperature λ is stored on the result and shown in the UI**, never
hidden. λ ≈ 0.05 reads as "these correlated observations carry ≈ 1/20 the
nominal information."

**Semantics.** Reweight-only, no resampling: every call re-conditions the
ORIGINAL prior ensemble on the full observed window, so an advancing
now-line never accumulates degeneracy across calls, and `reset` restores
bit-identical prior statistics. The unweighted (`weights: None`) statistics
path is bit-identical to the pre-Phase-3 computation — pinned Phase 1/2
numbers never move.

**Validated behavior on St. Patrick's 2015** (pinned by the smoke test):
conditioning on the pre-shock QUIET window kills too-early members and
raises P(min Bz < −10) from 0.61 to 0.75; conditioning through the sheath
interval temporarily dips it (**known v1 artifact — the model has no
sheath**, Phase 5); once the now-line passes the rope front the call
recovers to 0.80–0.93 and the 5–95% fan over the remaining passage narrows
from ≈34 to ≈15 nT. Native gates additionally pin: posterior collapse onto
a synthetic truth member, held-out mid-storm RMSE improvement, uniform
prior on all-gap windows, and determinism.

## 12. Live launch seeding — DONKI conventions (Phase 3)

NASA DONKI CMEAnalysis cone fits map onto the engine with no unit
conversion (`js/flux-rope-live.js`, fixture-gated by
tests/flux-rope-live.mjs):

| DONKI field | Engine parameter |
|---|---|
| `time21_5` | launch epoch — the 21.5 R☉ crossing IS the launch surface `d0` |
| `speed` | `v0` [km/s] (measured at 21.5 R☉) |
| `latitude`/`longitude` (Stonyhurst; Earth at 0°,0°) | launch `lat`/`lon` |
| `halfAngle` | apex-size prior: σ₁AU = clamp(0.115 · halfAngle/30°, 0.06, 0.2 AU) |

What a cone fit does NOT constrain — B₁AU, twist, tilt, chirality — gets
climatological defaults with deliberately WIDE priors (tilt σ 40°,
chirality flip probability 0.5 = "unknown"): that honest prior is the
starting posterior the §11 filter narrows as STEREO-A / L1 data arrives.
Ambient wind `w` is seeded from the live RTSW plasma mean when available.

## 13. STEREO-A pre-arrival conditioning (Phase 3 close-out)

The off-Sun–Earth-line constraint: a spacecraft the CME's flank brushes
hours before L1 turns the §11 filter into a genuine EARLY-WARNING update.

**Auxiliary observer.** The ensemble run optionally records each member's
Bz at ONE auxiliary position (STEREO-A) alongside the primary L1 series.
Recording draws nothing from the PRNG and never touches the primary
statistics — the L1 prior is bit-identical with or without it (pinned).
The §2 GSE z-mapping is reused at the aux position; at STA offsets of
±20° the frame error is small against the 4 nT observation sigma.

**Joint update.** L1 and STA observations are independent, so their
log-likelihoods ADD, and the §11 degeneracy guard tempers the JOINT
likelihood once — a Bayesian combination, not two chained filters. An
empty aux window (or a run without aux recording) reduces bit-exactly to
the primary-only update. ABI: `fr_aux_set/clear`, `fr_obs_aux_ptr`,
`fr_assimilate_joint(i0, i1, σ, aux_i0, aux_i1, σ_aux, floor)`.

**Ephemeris.** STA's assumed position comes from a disclosed drift
approximation (`staPositionApprox`): anchored at the 2023-08-12 Earth
conjunction, +0.0549°/day ahead, r 0.96 AU, good to ≈ ±3° over 2023–2028
(Gannon epoch: +14.9° vs ≈ +13° in the event literature). The page
DISPLAYS the assumption and lets the user edit it; live beacon data rides
the same fixture-gated parser as RTSW with a fail-quiet candidate-URL
fetcher (SWPC unreachable from the dev sandbox — see js/flux-rope-live.js).

**Validation — the OSSE.** With no committed STA fixture for the hindcast
events, the claim is validated as an Observing System Simulation
Experiment (standard practice, labeled synthetic everywhere): a truth rope
(OSSE_STA.truth, kernel-verified to graze STA at +38.5 h with −18 nT and
reach L1 only at +41.2 h) generates "observations" at both spacecraft;
conditioning the deliberately-off prior on the pre-arrival window pins,
in cargo AND against the committed WASM:
- the posterior collapses (ESS → floor, λ ≈ 0.2–0.6 — information, not
  noise) with the truth member carrying the top weight;
- P(Earth hit) RISES before L1 measures anything (0.51 → 0.60);
- the forecast median for the entirely-in-the-future L1 storm moves
  toward the truth (Σ|median − truth| 774 → 342 nT);
- depth probabilities firm only as the flank crossing deepens — the
  honest information ordering of a graze: arrival first, amplitude later.
Real-storm STA validation (Gannon-era beacon archive → a committed
fixture bundle) is the natural follow-on once archived beacon data is
baked, and slots into this exact machinery unchanged.

## 14. Sheath model (v1.1 — the first Phase 5 increment)

The single biggest documented v1 miss: both hindcasts showed a shocked
SHEATH between the SSC and the rope onset that the pure rope model could
not represent, forcing fits to slide the rope into the sheath window.

**Existence + geometry.** A sheath exists only while the apex outruns the
ambient wind faster than the fast-magnetosonic speed (`V_MS = 70 km/s`
fixed, §1-class ambient): `M = (v_apex − w)/V_MS > 1`. The sheath is the
FRONT-SIDE shell around the rope surface,

```
σ(ψ) ≤ s < σ(ψ)·(1 + k)        (k = sheath_k, default 0.8)
```

restricted to points farther from the Sun than the local axis (sheaths
pile up ahead of the obstacle, never in its wake). Thickness rides the
rope's own taper — thickest at the nose, vanishing at the legs.

**Compression.** Perpendicular fast-shock Rankine–Hugoniot ratio, γ = 5/3:

```
X(M) = (γ+1)M² / ((γ−1)M² + 2)      → 1 at M = 1, capped at 4
```

**Sheath field — the honesty decision.** Sheath Bz is compressed upstream
turbulence: its AMPLITUDE is predictable, its sign/phase is not. So:

- The DETERMINISTIC series carries no sheath Bz — only phase flags
  (series count code = rope_count + 100·sheath_count).
- Each ENSEMBLE member gets its own zero-mean Ornstein–Uhlenbeck Bz
  realization (correlation time 1 h, std X(M)·δ with δ = `sheath_delta_nt`,
  the ambient variability; compressed |B| envelope X·B_amb for |B|), from
  SEPARATE per-member seeded streams — parameter draws stay bit-identical
  with the sheath on or off, and δ = 0 disables everything (every v1 pin
  holds untouched).
- Fans, hit fractions, and min-Bz statistics use the FULL series (the fan
  shows the sheath band; P(min Bz < thr) includes sheath-driven storms);
  ASSIMILATION scores the rope-only clean series (§11/§13) — the filter
  matches structure, never each member's private noise.

**Measured value (pinned).** St. Patrick's v1.1 `sheathFit`: the model
shock lands ON the observed SSC (+51.6 vs +51.55 h; the baseline's first
disturbance was 2.3 h early) and the rope-onset error drops 10.5 → 3.3 h,
with min Bz −20.6 (15%) and shape r = 0.62. Gannon `sheathRopes`: sheath
on rope A only (rope B runs in A's wake, where the fresh-upstream
assumption fails — honest until CME–CME interaction lands); model shock
+43.3 vs observed SSC +43.6 h with the validated rope train untouched.
Storm probabilities never drop vs the sheathless baseline (pinned ≥).

**Next miss, on record.** The observed Bz minimum hugs the rope's LEADING
EDGE (front compression/erosion); the model's minimum sits mid-passage —
that asymmetry is now the largest remaining structural error, and it is
the natural next Phase 5 increment (deformation/erosion).
