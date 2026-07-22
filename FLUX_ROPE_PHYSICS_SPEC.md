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

## 15. Front compression (v1.2 — leading-edge asymmetry)

The §14 re-fit measured the next structural miss: the OBSERVED Bz minimum
hugs the rope's leading edge (St. Patrick's: 10 min before the rope-onset
boundary) while the symmetric §3–§4 model puts its extremum mid-passage.
Physics: a decelerating rope snowplows — its front is compressed against
the ambient wind while its wake is not.

**Model.** One parameter, `front_c = c ∈ [0, 0.6]` (0 = off, bit-identical
v1 path). The cross-section boundary is distorted by the angle θ between
the local cross-section radial r̂ and the anti-Sunward direction ô
(the Sun→axis-point direction projected ⊥ t̂):

```
f(θ) = 1 − c·(1 + cosθ)/2          σ_eff(θ) = σ(ψ)·f
```

— thinnest at the nose (θ = 0 → f = 1−c), untouched in the wake (θ = π).
The field structure maps onto the compressed geometry via the reference
radius `ŝ = s/f` (boundary → boundary), with a flux-conservation boost
`B → B/f` (one squeezed dimension, p = 1). The §14 sheath shell rides the
compressed boundary (σ_eff ≤ s < σ_eff·(1+k)). Degenerate geometries
(on-axis, footpoints) fall back to f = 1.

**Effect, unit-pinned:** the crossing's Bz extremum moves from mid-passage
into the front third of the dwell; the front boundary thins (a probe at
s = 0.8σ ahead of the apex exits the c = 0.4 rope); the front interior
field is boosted ≥ 1.2×; c = 0 is bit-identical.

**Measured value (pinned) — St. Patrick's `frontFit` (v1.2):** shock still
on the observed SSC (+51.7 vs +51.55 h), **min Bz −23.8 vs −24.25 nT
(1.9%) at Δ0.5 h timing** (v1.1: 8–12 h), minimum at 23% of the dwell,
shape r = 0.635, rope onset 4.1 h early. The geoeffective peak — value AND
time — moved from the model's weakest point to its strongest.

**Per-event honesty — Gannon:** front compression was tested and REJECTED
there (fc = 0 wins 3 of 4 metrics; Gannon's minimum sat 4.5 h into the
passage, not at the front). `front_c` is per-event physics recovered by
fitting, not a universal knob — and the pinned Gannon preset carries none.

**Remaining structural residual:** rope-onset timing (~4 h early on
St. Patrick's with shock + minimum both pinned) — the sheath-thickness /
standoff relation is the next candidate (Mach-dependent standoff), then
CME–CME interaction for the Gannon train.

## 16. CME–CME interaction (v1.3 — the train becomes a system)

The §10 train is a superposition of NON-interacting ropes, and both its
documented misses are interaction physics: rope A's Gannon fit is
suspiciously compact/strong (σ 0.085 AU, 55 nT — it absorbs real
compression by the train behind it), and rope B was left sheathless
because its front runs inside rope A's wake where the §14 fresh-upstream
assumption fails. The observed L1 series carries the signature directly:
an internal shock-like jump at +48.7 h (V 684→748 km/s, N 20→24 /cc)
while Bz already sat at −38 nT, 2.5 h before the −44.17 nT global
minimum — a follower-driven disturbance compressing the leader's rear.

**Partner selection.** Ropes interact PAIRWISE, follower→leader. Rope j's
LEADER is the most recently launched earlier rope i whose launch
direction aligns with j's: `ê_dir,i · ê_dir,j > 0.5`. Chains (A←B←C)
resolve leader-first in launch order. Misaligned ropes never interact.

**Wake kinematics (the follower).** A follower flies through wind
preconditioned by its leader, not the quiet ambient:

```
w_eff,j = max(w_j, v_i(t_launch,j − t_launch,i))     (frozen at launch)
Γ_eff,j = Γ_j · wake_gamma_frac                       (default 0.5)
```

— the leader's (already wake-modified, if chained) apex speed when the
follower launches, so the §5 closed form survives. Freezing w at launch
is the v1.3 approximation, stated: the leader keeps decelerating and the
follower may eventually outrun the wake; neither is modeled.

**Rear compression (the leader).** The follower's approach squeezes the
leader's rear — the counterpart of §15's front lobe, but DYNAMIC. At
train time t, with apex distances d, apex minor radii σ̂, and apex speeds
v from the effective kinematics:

```
gap(t)  = (d_i − σ̂_i) − (d_j + σ̂_j)                 (nose-to-tail line)
q(t)    = clamp(1 − gap / (comp_reach·σ̂_i), 0, 1)    (reach default 1.5)
M_rel   = max(0, (v_j − v_i) / V_MS)
rear_c(t) = clamp(comp_c · (1 − 1/X(M_rel)) · q, 0, 0.75)
```

X is the §14 Rankine–Hugoniot ratio (X ≤ 4 → rear_c ≤ 0.75 → boost ≤ 4,
the same cap), so a follower that is not closing super-magnetosonically
compresses nothing (X(M≤1) = 1). `comp_c ∈ [0,1]` (default 1) is the one
honest scale knob. The §15 boundary distortion generalizes to two lobes:

```
f(θ) = 1 − front_c·(1 + cosθ)/2 − rear_c·(1 − cosθ)/2
```

with the same σ_eff = σ·f boundary, ŝ = s/f reference mapping, and 1/f
flux-conservation boost — the leader's rear thins and its field
strengthens as the follower closes. A leader with several aligned
followers takes the strongest rear_c. Mutual compression of the
FOLLOWER's front by the pile-up is NOT auto-derived — it remains the
per-rope static `front_c` (§15) if a fit wants it.

**Wake-conditioned sheath (the follower).** The §14 existence test uses
the wake flow, not fresh wind: `M_j = (v_j − v_up)/V_MS` with
`v_up = max(w_j, v_i(t))` evaluated LIVE. A follower slower than its
leader's wake drives no shock (the honest kill that justified leaving
Gannon rope B sheathless in v1.1); one that genuinely outruns the wake
gains a sheath whose X(M_j) compression uses the same wake Mach. The
leader's own sheath is untouched (fresh upstream ahead of it).

**Determinism + scope.** The interaction config
`{enabled, wake_gamma_frac, comp_c, comp_reach}` is engine-level, shared
across ensemble members (not sampled); each member's partner selection,
wake speeds and gaps derive from that member's OWN sampled parameters, so
interaction uncertainty enters the fan through the §7 draws with no new
RNG stream. `enabled = false` (default) is bit-identical to §10 —
every pre-v1.3 pin holds. NOT modeled, on record: momentum exchange (the
leader is compressed but not pushed; the follower loses no momentum at
contact beyond its wake drag), merging/reconnection, erosion, deflection.
The §10 containment count stays the honesty diagnostic where structures
overlap.

**Measured value (pinned) — Gannon `interactionRopes` (v1.3):** rope A
relaxes to plausible values (σ 0.12 AU, 38 nT vs the v1 absorbed
0.085 AU / 55 nT) with the follower squeeze supplying the minimum:
**−44.3 vs −44.17 nT (0.3%) at Δ1.5 h**; rope B's wake shock reproduces
the observed mid-storm internal disturbance **+48.9 vs +48.7 h**; shock
stays on the SSC (+43.2 vs +43.6 h); dwell 16.8 vs 15.9 h observed
(v1.1: 18.5); zero overlap superposition. Attribution pinned: disabling
interaction on the same ropes shallows the min by ~5 nT and mistimes the
internal disturbance by ~5 h. Honest trades: full-window r 0.66 vs
v1.1's 0.71 (deterministic zeros through the 54–56 h sheath handover —
§14 keeps sheath Bz ensemble-only — where v1.1's overlong rope-A dwell
happened to cover the data), and rope B's `sheath_k = 2.0` standing in
for the missing Mach-dependent shock standoff (§15 residual).

## 17. Mach-dependent sheath standoff (v1.4)

The §14 shell has a FIXED fractional thickness `k·σ(ψ)` — one number
welded to the rope surface, setting shock arrival and rope onset
together. Both hindcasts exposed it: St. Patrick's v1.2 pins the shock
ON the SSC and the minimum at Δ0.5 h yet the rope onset runs ~4 h early
(the observed sheath is ~8 h thick; a fixed k cannot thicken the shell
without dragging the shock earlier), and Gannon rope B needed
`sheath_k = 2.0` as an undisguised stand-in.

**Model.** The shell thickness becomes the blunt-body shock standoff
(Farris & Russell 1994), evaluated per point and per time:

```
Δ(ψ, t) = η · FR(M) · R_c(ψ, t)
FR(M)   = ((γ−1)M² + 2) / ((γ+1)(M² − 1))     γ = 5/3, clamped ≤ 3
R_c     = sqrt(σ_eff(ψ) · d/2)
shell:    σ_eff ≤ s < σ_eff + Δ                (front side, as before)
```

- `FR` is the classic standoff ratio: → 1/4 for a strong shock,
  diverging as M → 1⁺ where the shock detaches and dies — clamped at 3
  (η·3·R_c) so the dissolving shock fades instead of exploding.
- `R_c` is the obstacle's nose curvature proxy: the geometric mean of
  the cross-section minor radius σ_eff (distorted per §15/§16) and the
  torus major radius d/2 — a croissant nose is much blunter than its
  cross-section alone. Δ ∝ √σ(ψ) still tapers to zero at the legs.
- `M` is the §14 shock Mach, WAKE-conditioned for §16 followers.
- `η = sheath_eta` is the one calibration knob (literature anchor
  η ≈ 1.1 for a smooth blunt body). **η = 0 (default) keeps the legacy
  fixed-k shell bit-identical** — every pre-v1.4 pin holds; η > 0
  replaces k entirely for that rope.

**The physics this buys.** M falls as the rope decelerates, so FR — and
the sheath — GROWS toward 1 AU, exactly the observed behavior a fixed k
cannot represent: the shock pulls ahead of the rope late in transit.
The rope onset decouples from the shock arrival through measurable
physics rather than a hand-tuned fraction.

**Honesty note.** The blunt-body relation describes a QUIET-WIND
sheath. A §16 follower ramming its leader's wake accumulates pileup the
flank flow cannot evacuate; its fitted η is expected ABOVE the
literature ~1 and is reported as such, not hidden inside the geometry.

**Measured value (pinned).** St. Patrick's `standoffFit` (v1.4), at the
LITERATURE η = 1.1 with no retuning of the coefficient: shock ON the
observed SSC (error 0.0 h), **rope-onset error 1.4 h (v1.2: 4.1 h — the
residual that motivated this section)**, min Bz −24.6 vs −24.25 nT
(1.3%) at Δ1.8 h, shape r = 0.686 (the best of any generation),
southward dwell 14.0 vs 17.8 h (< −5 nT). Remaining residual: the
observed minimum sits AT the leading edge (10 min after onset); the
model's sits at 22% of the dwell — the §15 clamp (c ≤ 0.6) is now the
limiting mechanism. Gannon `standoffRopes` (v1.4): η replaces both fixed
fractions on the interacting train with the rope fields BIT-IDENTICAL
(the shell carries flags, not deterministic field); shock −0.8 h,
internal disturbance **+48.8 vs +48.7 h observed**; η_B = 3.0 ≈ 2.7×
blunt-body (wake pileup, as predicted above), η_A = 0.3 sub-blunt-body
(the pre-train wind was itself disturbed; documented, not hidden).

## 18. Cross-section pancaking (v1.5 — elliptical deformation)

Real magnetic clouds at 1 AU are not circular: lateral expansion in the
diverging wind flattens the cross-section perpendicular to the radial
direction — literature aspect ratios run ~2–6 (Riley & Crooker 2004;
Savani et al. 2011). The circular §3 section conflates two things a
flattened one separates: the RADIAL thickness (what one spacecraft's
dwell measures) and the TRANSVERSE footprint (what decides who gets
hit). The v1 σ fits carry both jobs in one number.

**Model.** One parameter per rope, `pancake_a = A ≥ 1` (1 = circular,
bit-identical). The boundary becomes an ellipse in the cross-section
plane with principal axes along ô (the §15 anti-Sunward projection —
radial) and ⊥ ô (transverse):

```
g(θ) = 1 / sqrt(A·cos²θ + sin²θ/A)        (even in cosθ)
σ_eff(θ) = σ(ψ) · g(θ) · f(θ)              (f = the §15/§16 odd lobes)
ŝ = s / (g·f)                              boost = 1/f  (NOT 1/(g·f))
```

— semi-axes σ/√A (radial, thinned) and σ·√A (transverse, widened).
Deformation factorizes cleanly: `g` is EVEN (pure flattening), `f` is
ODD (front/rear asymmetry). Pancaking is AREA-PRESERVING (π·σ²/√A·√A =
π·σ²): flux per unit length is conserved, so it carries NO field boost —
only the genuinely compressive f lobes do. The §14/§17 sheath shell
rides the same distorted boundary.

**What it buys, honestly scoped.** For a nose crossing, A is largely
DEGENERATE with σ in a single time series (both set the radial dwell) —
one spacecraft cannot measure it alone. Its testable content is
geometric: at FIXED nose dwell, a pancaked rope has a √A-wider
transverse footprint (flank observers that a circular rope misses get
hit — pinned in the kernel tests), flatter duration-vs-impact-parameter,
and correspondingly different ensemble hit statistics. Hindcast fits may
therefore accept or reject A per event exactly like §15's front_c; a
rejection is a result, not a failure.

**Approximations, stated.** A is constant with distance (real pancaking
GROWS in transit; a distance-dependent A(d) is future work). A is NOT
ensemble-sampled — the §7 draw order is a determinism contract, and the
parameter is structural. The GLSL view renders the circular section
(display-only omission, like the sheath and the lobes — the kernel
remains the oracle). DONKI live seeds keep A = 1 until a validated
half-angle → (σ, A) mapping exists.

**Measured value (pinned).** Mechanism: an 8° flank observer misses the
circular rope and catches A = 2.5 (kernel + WASM pinned); the nose dwell
shrinks by the thinned radial axis; the on-axis field is boost-free
(area preservation). Hindcast outcome — REJECTED per event, the §15
precedent: St. Patrick's co-scaled A = 2 gives r 0.676 vs 0.686 with
the minimum still at 22% of dwell; Gannon co-scaled A = 2 trades the
minimum (0.3% → 10.1%) for r +0.006. The fitted presets stay circular.
The pinned calibration warning: at IDENTICAL spreads, co-scaled A = 2
lifts ensemble P(hit) 0.54 → 0.83 — the aspect is unconstrained by
single-point data, and storm-probability calibration inherits that
sensitivity. Resolving it needs multi-point data (the §13 machinery) or
a population prior; both are future work, stated.
