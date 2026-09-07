# Boötes Void — data provenance

`bootes-void.html` draws a picture that looks like a galaxy survey. It is not
one. This file records exactly which numbers on that page are measurements,
which are model, and what the difference costs.

## The split

| Layer | What it is | Where it lives |
|-------|-----------|----------------|
| Void position, redshift, size, galaxy deficit | **Published measurement** | `js/bootes-void-data.js` → `BOOTES_VOID` |
| Named clusters around the void | **Published, transcribed** (±0.2°, ±0.002 in z) | `js/bootes-void-data.js` → `NEIGHBOUR_ANCHORS` |
| Background cosmology | **Published** (Planck 2018) | `js/bootes-void-model.js` → `COSMOLOGY` |
| The continuous density profile δ(r) | **Fitted model** — HSW form, published shape parameters, anchored to the measurements above | `js/bootes-void-model.js` → `createVoidProfile` |
| Filaments, nodes, tracer galaxies | **Seeded synthetic realisation** | `js/bootes-web-model.js` |
| Every dynamical quantity (v, g, T, ΔΣ, ΔT) | **Linear-theory consequence** of the profile | `js/bootes-void-model.js` |

**Nothing on the page is a detection.** No peculiar-velocity outflow, tidal
alignment, lensing shear or ISW imprint reported here has been observed for this
void. They are predictions, and the page labels the two that current instruments
could not detect for a single void ("honest null") as such.

## What is measured

### The void

Kirshner, Oemler, Schechter & Shectman 1981, ApJ 248, L57 —
*A million cubic megaparsec void in Boötes*. The discovery. The effective radius
this page uses is **derived from the paper's own headline volume**: a sphere of
10⁶ h⁻³ Mpc³ has radius (3·10⁶/4π)^⅓ = 62.0 h⁻¹ Mpc. That is stored rather than
a rounded quote, so it is reproducible from a number in an abstract.

Kirshner et al. 1987, ApJ 314, 493 — the deeper survey, quoting ≈62.5 h⁻¹ Mpc
and cz ≈ 15 500 km/s at RA 14ʰ50ᵐ, Dec +46°. Consistent with the 1981 derivation.

Weistrop et al. 1992, ApJ 396, 471; Szomoru et al. 1996, AJ 111, 2150;
Cruzen et al. 2002, AJ 123, 142 — the galaxies that *are* inside the void, and
the ~60-vs-2000 count that everyone quotes.

### The h⁻¹ trap

The literature quotes sizes in **h⁻¹ Mpc**. Popular sources quote the same
numbers in Mpc and light-years having quietly set h = 1. At Planck's
h = 0.6766 that is a **factor of 1.48** — the difference between a 62 Mpc void
and a 92 Mpc one, and it propagates into every amplitude on the page as roughly
r² through the potential.

So the radius is stored **once**, in h⁻¹ Mpc, and `effectiveRadiusMpc()` in
`js/bootes-void-data.js` is the only place it becomes a physical length.
`tests/bootes-web-model.mjs` asserts the conversion and asserts that the
converted value is *larger* than the h⁻¹ number, which is the direction the
mistake goes.

### The two deficits that disagree

The page prints both and does **not** reconcile them:

- **Raw count:** 60 galaxies against ≈2000 expected ⇒ Δ_g = −0.97.
- **Fitted profile:** Δ(<R_eff) ≈ −0.19 in matter, ≈ −0.28 in galaxies.

They are not the same measurement:

1. The count comes from sparse pencil-beam surveys over a region whose boundary
   was *defined* by emptiness. Defining a volume by its own underdensity and
   then measuring that underdensity is a selection, not an independent number.
2. The count is of galaxies above a survey limit — the brightest, and therefore
   the most strongly biased tracers there are. Void interiors are exactly where
   that bias is largest.
3. The profile's Δ(<R_eff) is a volume average over a fitted smooth field, which
   by construction includes the void's inner wall.

The honest statement is that the void is nearly empty of *bright galaxies* over
its core and about 20 % underdense in *matter* averaged inside R_eff. Both are
true; only the second one drives gravity. `tests/bootes-web-model.mjs` asserts
that the two differ, so a future edit cannot quietly make them agree.

### Cluster anchors

Nine rich clusters, transcribed from the Abell catalogue via NED. Good to about
**±0.2° and ±0.002 in redshift** — fine for placing structures tens of Mpc
apart, and **not** fine for cross-matching or identification. Do not use these
coordinates to look anything up.

They supply **no mass** to the gravity calculation. See below.

## What is modelled

### The density profile

Hamaus, Sutter & Wandelt 2014, PRL 112, 251302 — the universal void density
profile:

    δ(r) = δ_c · [1 − (r/r_s)^α] / [1 + (r/R_v)^β]

Shape parameters (α ≈ 2, β ≈ 9, r_s ≈ 0.95 R_v) are the published values fitted
to the largest voids. The depth comes from the measured central galaxy contrast
through one step of linear bias, δ_m = δ_g / b.

**Nobody has published a matter-density profile for this void.** That would
require a peculiar-velocity reconstruction over the whole region, which is the
observation this page is arguing for. The profile is a plausible, literature-
shaped stand-in and the page says so.

### The bias step is the error budget

Void-galaxy bias is measured between about 1.2 and 2.0 depending on the tracer
sample, and every downstream amplitude scales as 1/b. That ±20 % dwarfs every
other uncertainty on the page, which is why `b` is a slider rather than a
constant and why the control is labelled as the error budget rather than as a
tuning knob.

### The cosmic web

`js/bootes-web-model.js`. Seeded, deterministic, and constrained in three ways:

1. **Mass.** The web carries *exactly* the profile's own compensating-wall mass.
   Nobody typed a cluster mass in.
2. **Radial distribution.** Particle radii are drawn from the profile's own
   δ⁺(r)r² measure, so the clumped model's spherically-averaged wall *is* the
   smooth wall.
3. **Directions.** Angular placement is biased towards the real cluster
   directions above.

**Why not give each cluster its published mass?** Because the page asks whether
the void or the surrounding filaments dominate the local force. Supercluster
masses are uncertain at the factor-of-two level, so any mass typed in would make
the answer a function of what somebody typed. Constraining the total to the
profile's own wall removes that freedom entirely: the monopole of the clumped
model and of the smooth model are identical by construction, so the only thing
that differs is *arrangement*, and "void or filament?" becomes a question about
geometry. `tests/bootes-web-model.mjs` pins the mass conservation and checks the
discrete web against the shell theorem.

## Why nothing is fetched

Astronomy archives — VizieR, SDSS SkyServer, NED — are **egress-blocked in this
repo's build environment**, the same as NASA is for `sun.html`'s SDO fixtures.
Every coordinate above is transcribed at the precision the literature quotes.

`scripts/fetch-bootes-anchors.mjs` refreshes `NEIGHBOUR_ANCHORS` from VizieR on
a machine that has the network, in the same pattern as
`scripts/fetch-sdo-fixtures.mjs`. Run it, check the diff, commit the result, and
update `ANCHOR_ACCURACY` in `js/bootes-void-data.js` to say the coordinates are
catalogue-sourced rather than transcribed.

**The page fetches nothing at runtime either.** Every input is a literal or is
computed in the browser, which is why `tests/bootes-void-smoke.spec.js` needs no
route mocking. If a future edit makes this page fetch, that is a change to its
provenance story and belongs in this file first.

## Gates

```
node tests/bootes-void-model.mjs    # the physics kernel — identities, signs, magnitudes
node tests/bootes-web-model.mjs     # the web + the published inputs, incl. the h⁻¹ conversion
node tests/bootes-void-page.mjs     # the DOM contract between the markup and page.js
npx playwright test tests/bootes-void-smoke.spec.js
```
