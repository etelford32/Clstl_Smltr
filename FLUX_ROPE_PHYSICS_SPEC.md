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
shared buffer). `fr_set_rope(...)` sets all §3–§5 parameters in one call;
`fr_series(...)` fills the synthetic in situ series; `fr_field_at(t, x, y, z)`
samples the field at an arbitrary heliocentric point (the page's GLSL view
mirrors the same math in-shader; the kernel is the oracle);
`fr_ens_run(seed, n, ...)` + percentile/arrival/probability getters expose §7.
