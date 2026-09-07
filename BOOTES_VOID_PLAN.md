# Boötes Void — dynamical footprint

**Status:** Phase 1–2 shipped 2026-09-07. Phase 3 (the observational programme)
is not started and is not a code task.

`bootes-void.html` · `js/bootes-void-model.js` · `js/bootes-web-model.js` ·
`js/bootes-void-data.js` · `js/bootes/{page,scene,charts}.js`

---

## 1. The question, and why it is not the obvious one

The obvious framing — *does the Boötes Void have gravity?* — is not a question.
Of course it does. The one this page is built around is:

> **Does the observed Boötes underdensity produce a measurable dynamical
> signature in the surrounding cosmic web consistent with ΛCDM structure
> formation, and out to what radius does it still matter?**

That is falsifiable, and it is a chain in which every arrow is testable:

```
galaxies → δ(r) → Δ(<r) → v_r(r) → Φ(r) → g(r) → T_ij(r) → cosmic-web morphology
                                        ↘ Σ(R) → ΔΣ(R) → γ_t
                                        ↘ s∥ = r∥ + v∥/aH
                                        ↘ Φ̇ → ΔT/T
```

**A void does not push.** There is no repulsive force anywhere in this. There is
less inward attraction from the underdense direction, so peculiar motion — the
motion on top of the Hubble flow — is outward. Every sign convention in
`js/bootes-void-model.js` is spelled out because this is the thing that gets
misread, and because a sign error here produces a picture that looks fine.

---

## 2. What shipped

### Level 1 — characterisation

- HSW profile δ(r), integrated contrast Δ(<r), the zero crossing r_s and the
  compensating wall.
- Mass deficit, wall mass, and the **compensation fraction** C — the fraction of
  the evacuated interior the wall has piled back up.
- The h⁻¹ → Mpc conversion, in one place. See `data/bootes/SOURCES.md`.
- The two galaxy deficits that disagree, printed side by side and unreconciled.

### Level 2 — the physics result

- **Test 1** outflow v_r(r), linear and quasi-linear.
- **Test 2** the continuity identity ∇·v = −aHfδ, verified in integral form.
- **Test 3** the tidal tensor, with its closed-form eigenvalues.
- **Test 4** the counterfactual: fill the void to cosmic mean, subtract the
  fields. Reported as a share-of-acceleration profile with a 16–84 band across
  directions, plus a velocity horizon at a stated threshold.
- **Test 5** filament alignment against the void's compression axis, with a
  deliberately circular positive control.

### Level 3 — the cosmological signatures

- **Test 6** redshift-space distortion and the quadrupole that carries β = f/b.
- **Test 7** weak lensing ΔΣ(R), γ_t(R) and a shape-noise SNR. Honest null.
- **Test 8** the ISW imprint ΔT(θ). Honest null.

---

## 3. Decisions, and what would have to change to revisit them

### 3.1 The web's mass is the profile's own wall

**Decided.** `js/bootes-web-model.js` takes exactly `wallMassMsun(profile)` and
redistributes it. It does **not** give each named cluster a published mass.

Test 5 asks whether the void or the surrounding filaments dominate the local
force. Supercluster masses are uncertain at the factor-of-two level, so any mass
typed in would make the answer a function of what somebody typed — circular.
Constraining the total to the profile's own wall removes that freedom: the
monopole of the clumped model and the smooth model are identical by
construction, so the only thing that differs is arrangement.

To revisit this you would need a real mass reconstruction for the region, at
which point the whole page stops being a model.

### 3.2 The counterfactual is an identity, not a difference

**Decided.** `splitProfile()` splits δ into δ⁻ (the deficit) and δ⁺ (the wall),
exactly. Model A is δ⁻ + the discrete wall; model B is the discrete wall alone,
**bit-identical**. So Δg = g(δ⁻), analytically, with no cancellation error.

Differencing two independently summed particle fields would agree to about four
digits and lose precision exactly in the outskirts, which is where the
R_influence answer lives.

### 3.3 "Radius of influence" is reported three ways, and never as a fraction

**Decided, and this one took a wrong turn first.** The tempting metric is *the
radius where the void contributes less than X % of the local acceleration*. It
is backwards: the void and its own wall pull in opposite directions and nearly
cancel outside the shell, so the total field out there is small *because* the
void's contribution is large. That ratio therefore grows without bound exactly
where the void's absolute influence is vanishing.

`influenceProfile()` returns instead:

1. **velocityHorizonMpc** — absolute and observational. The radius beyond which
   the void alone could not have induced more than a stated peculiar velocity.
   Default 50 km/s, adjustable, always printed with its threshold.
2. **shareProfile** — the void's share of |g| with a 16–84 band across
   directions. **The band is the result.** Clumping widens it without moving the
   median; that anisotropy is the answer.
3. **crossover** — where the web overtakes the void, per direction, plus the
   fraction of directions in which that happens at all. For an under-compensated
   void it usually does not, and "no crossover in 70 % of directions" is a
   result, not a failure to converge.

### 3.4 The tangential eigenvectors are degenerate

**Load-bearing.** A spherical void's tidal tensor has λ_tangential *twice*. The
two tangential eigenvectors are therefore not defined, and any alignment
measured against e₂ or e₃ is an artefact of the eigen-solver. `filamentAlignment`
defaults to `axis: 1` and reports `minEigenGap` so the degeneracy is visible
rather than silent. `tests/bootes-web-model.mjs` asserts the gap collapses.

### 3.5 Under-compensation is pinned by a test

**Load-bearing.** An over-compensated profile flips the sign of Φ in the
outskirts, which inverts the ISW prediction. During development that turned the
predicted cold spot into a near-cancellation at 4 % of the correct amplitude,
with δ, Δ, v and g all still looking perfectly reasonable on the way past.
`tests/bootes-void-model.mjs` asserts 0 < C < 1 and Φ > 0 everywhere.

---

## 4. Bugs that shipped during development, and the checks that caught them

These are recorded because each was silent and plausible-looking.

| Bug | Symptom | What caught it |
|-----|---------|----------------|
| `(1+z)³` in the comoving Poisson factor instead of `(1+z)` | Φ inflated 11 %; ISW amplitude wrong; nothing looked odd | `g = −dΦ/dr_phys` across two independent chains |
| Missing `(1+z)²` in `pointGravityVector` | The void's field was physical, the web's comoving — a silent 10 % bias in the void's favour on every comparison | the **shell theorem** check in `tests/bootes-web-model.mjs` |
| Over-compensated profile parameters | ISW cold spot became a 4 %-amplitude near-cancellation | `compensationFraction` + the Φ > 0 assertions |
| `Map` of `data-bv` key → element | Three headline readouts frozen on their em-dash forever, looking like "not available" | `tests/bootes-void-page.mjs` duplicate-key check |
| `#bv-stage-fallback` with author `display:flex` | "WebGL is unavailable" rendered over a working canvas | the `[hidden]` specificity check; same failure as `.feature-item[hidden]` on Mars |
| Float-accumulated axis ticks | An axis label reading `−5.6e-17` where zero should be | eyes on a screenshot; now fixed at the tick generator *and* the formatter |

The velocity-divergence identity also could not be tested by numerical
differentiation at all — Δ(<r) is a linearly interpolated table, so its
derivative is piecewise constant, and δ has a kink at the wall. A narrow stencil
measures the interpolation; a wide one straddles the kink. It is tested in
**integral form** (the divergence theorem) instead, against a quadrature that
shares no code with the kernel.

---

## 5. What is deliberately NOT here

- **No galaxy catalogue.** Astronomy archives are egress-blocked at build time.
  Everything past the published bulk parameters is model, disclosed permanently
  on the page. `scripts/fetch-bootes-anchors.mjs` is the refresher for a
  networked machine.
- **No claim of detection.** Two of the eight tests are labelled *honest null*
  because current instruments cannot detect them for a single void. That is the
  correct answer and saying so is the point.
- **No N-body.** The dynamics are linear theory plus a spherical-collapse
  correction, which is what the void literature uses at these scales and what
  makes every relation checkable as an identity.
- **No WASM.** The whole kernel is ~1 ms per profile rebuild and ~80 ms for the
  influence scan. There is nothing here that needs Rust, and adding it would put
  a compiled artefact between the reader and numbers whose selling point is that
  they are traceable.

---

## 6. Phase 3 — the observational programme (not started)

This is the part that would turn the page into a paper, and none of it is a code
task in this repo:

1. **Reconstruct δ(r) from a real tracer catalogue** (SDSS / 2MRS / DESI) rather
   than fitting an HSW form. This is the single change that would move the most:
   every amplitude on the page inherits the profile.
2. **Compare against Cosmicflows peculiar velocities.** Test 1 becomes a
   measurement rather than a prediction the moment observed v_r(r) can be laid
   over the predicted curve.
3. **Test 2 as a real consistency check.** Density and velocity are independent
   observations; agreement between them is the strongest available evidence that
   the void is a dynamically evolving structure rather than a sampling gap.
4. **Replace the synthetic web with a reconstructed density field**, at which
   point Test 5's alignment statistic stops being circular in its control and
   becomes a real measurement of whether Boötes organises its surroundings.

Until (1) and (4) are done, the honest summary of this page is: *the chain is
right, the identities hold, and the inputs are literature values with a fitted
profile in the middle.*

---

## 7. Gates

```
node tests/bootes-void-model.mjs      # 17 checks — the physics kernel
node tests/bootes-web-model.mjs       # 12 checks — the web + published inputs
node tests/bootes-void-page.mjs       #  7 checks — the DOM contract
npx playwright test tests/bootes-void-smoke.spec.js
node tests/site-sections.mjs tests/simulations-catalog.mjs tests/glyphs.mjs
node scripts/lint-nav.mjs
```

After any IA edit also re-run `node scripts/build-section-pages.mjs` and
`node scripts/build-simulations-page.mjs` — the hub pages are generated whole,
and hand-editing them is reverted by the next run.

**Deep Space is now at the nav cap.** Three section headers (Stars · Black
holes · Cosmic web) and ten links is the editorial limit documented in
`js/site-sections.js`; the next thing that lands in this section goes into an
existing group or onto the hub page only.
