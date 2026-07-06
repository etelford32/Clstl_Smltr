# "Abell 85 Pair" Black Hole Simulation — Research & Constraints

**Status:** Research phase complete — constraints gathered, simulation not yet started.
**Date:** 2026-07-05
**Companion file:** `ABELL85_PAIR_SOURCE_CATALOG.md` (~119 annotated sources across six domains)
**Repo precedent:** `ton618.html` + `js/ton618/` (GPU Kerr geodesic ray tracer) is the architectural
starting point for the eventual page. `sagittarius.html`, `accretion-disc.html`, `gravity-lab.html`
are siblings.

---

## 1. Executive summary — the target is not what the headline said

The project brief described: *"the most massive pair of black holes ever found, 4.4 billion
light-years away at the center of the Abell galaxy cluster, combined mass 60 billion suns,
lurking in a dark cosmic core devoid of all starlight."*

That description is a **conflation of two different Abell-cluster BCGs**. The literature sweep
resolved it cleanly:

| Claim element | Actually belongs to | Source |
|---|---|---|
| "Most massive pair, combined **60 ± 20 billion M☉**" | **Abell 402-BCG** (candidate binary — one of two allowed interpretations) | McDonald et al. 2026, ApJL 1002, L19 (arXiv:2603.10104) |
| "**4.4 billion light-years** away" | **Abell 402-BCG** | same |
| "Dark core **devoid of starlight**" (a ~3,200-ly starless cavity) | **Abell 402-BCG** | same |
| "Center of the **Abell 85** cluster" | **Holm 15A** — which hosts a **single** ultramassive BH of 2.2–4.0 × 10^10 M☉ at ~250 Mpc (~740 Mly), *not* a pair | Mehrgan et al. 2019; Liepold et al. 2025; Madrid et al. 2021 (VLA: one core, two jets) |
| "Most massive pair ever **confirmed**" (28 billion M☉ combined) | **B2 0402+379** at ~750 Mly, 7.3 pc separation | Surti, Romani et al. 2024; NOIRLab noirlab2405 |

Key facts behind the resolution:

- **Abell 85 / Holm 15A** is the famous *single* ultramassive black hole: (4.0 ± 0.8) × 10^10 M☉
  from axisymmetric Schwarzschild modeling of VLT/MUSE kinematics (Mehrgan et al. 2019), revised
  to 2.16 (+0.23/−0.18) × 10^10 M☉ by triaxial modeling of Keck KCWI data (Liepold, Ma & Walsh
  2025). Deep VLA imaging shows **one** radio core with two kpc-scale jets and explicitly rebuts
  binary/trio interpretations (Madrid et al. 2021). Binary *history* is still the leading
  explanation for its huge diffuse core — but the pair has already merged or been reduced to one.
- **Abell 402-BCG** (McDonald et al. 2026) is the new JWST/HST/MUSE result the "60 billion pair"
  headlines describe: a kiloparsec-scale **starless cavity** (~3,200 ly across) inside a flattened
  2.2 kpc core with ~2 × 10^9 M☉ of stars missing, plus **two candidate AGN** with relative
  velocity ~370 km/s. The paper allows two interpretations: (a) a **binary UMBH totaling
  60 ± 20 × 10^9 M☉**, or (b) a **single (6 ± 4) × 10^10 M☉** black hole. The binary is a
  *candidate*, not a confirmed detection.
- The **confirmed** record pair remains **B2 0402+379**: combined 2.8 ± 0.8 × 10^10 M☉ at 7.3 pc
  projected separation, orbital period ~3 × 10^4 yr, apparently **stalled for ≳3 Gyr** — the
  observational poster child of the final-parsec problem.

**Recommendation for the simulation:** build the *pair* the user described — i.e. the
**Abell 402-BCG binary interpretation** (M_total ≈ 6 × 10^10 M☉ in a starless kpc-scale cavity) —
and calibrate its dynamical stages against the three hard anchors: B2 0402+379 (parsec-scale
stalled stage), OJ 287 (sub-parsec relativistic stage), and Holm 15A (the post-merger end state
with a scoured core, which is also the genuine "Abell 85" connection and a natural comparison
mode in the UI). This gives the simulation honest physics *and* keeps the evocative framing:
Abell 402-BCG's core really is "devoid of starlight," and Holm 15A shows what's left after the
dance ends.

---

## 2. Target system constraints

### 2.1 System A — Abell 402-BCG (primary target; the "60-billion pair")

| Parameter | Value | Confidence / note |
|---|---|---|
| Combined BH mass (binary interp.) | **60 ± 20 × 10^9 M☉** | Candidate — one of two interpretations |
| Single-BH alternative | (6 ± 4) × 10^10 M☉ | Degenerate with binary at current data |
| Mass ratio | Unconstrained; adopt q = 1 default with q slider 0.1–1 | Both AGN candidates detected → q not extreme |
| Relative velocity of AGN candidates | ~370 km/s | Measured (MUSE) |
| Starless cavity diameter | ~3,200 ly ≈ 0.98 kpc | JWST/NIRCam + HST |
| Flattened core radius | ~2.2 kpc | Matches r_infl = GM/σ² ≈ 2.2 kpc for M = 6 × 10^10 M☉, σ ≈ 340 km/s (derived, see §3) |
| Missing stellar mass in cavity | ~2 × 10^9 M☉ | ≈ 0.03 M_BH — small vs. classic scouring deficits (0.5–5 M_BH), consistent with the cavity being the *latest* scouring episode only |
| Distance | ~4.4 billion light-years | Light-travel convention (press); z not captured in sweep — **pull z from the paper before building the lensing/redshift readout** |
| Environment | BCG of Abell 402 cluster | Cool-core cluster BCG, like Holm 15A |

### 2.2 System B — Abell 85 / Holm 15A (comparison mode; the real "Abell 85")

| Parameter | Value | Source |
|---|---|---|
| M_BH (preferred, triaxial 2025) | 2.16 (+0.23/−0.18) × 10^10 M☉ | Liepold, Ma & Walsh 2025 (Keck KCWI, TriOS) |
| M_BH (2019 axisymmetric) | (4.0 ± 0.8) × 10^10 M☉ | Mehrgan et al. 2019 (VLT/MUSE) — bracket both in UI |
| Stellar velocity dispersion σ* | ~310–346 km/s, nearly flat profile | López-Cruz 2014 (310 ± 15); Mehrgan 2019 (~340) |
| BCG stellar mass | ≈ 2 × 10^12 M☉ | Mehrgan 2019 |
| Cusp/core radius | core-Sérsic R_b ≈ 2.8 kpc; r_γ = 4.11 kpc (deeper 2019 data) — the 4.57 kpc figure is the 2014 Nuker fit; 2015–16 "no core" claims superseded; model-dependence spans 0–4.6 kpc | Mehrgan 2019 (verified 3-0); López-Cruz 2014 |
| Redshift / distance | z = 0.0555; D_L ≈ 250 Mpc (~810 Mly); D_A ≈ 222 Mpc (1″ ≈ 1.08 kpc); light-travel ~740 Mly (the press figure) | Distance conventions differ, not measurements |
| Excess above M–σ scaling | 4–9× (at the 2019 mass) | Mehrgan 2019 |
| Orbit structure in core | Tangentially biased (β < 0) inside the core — the scouring fingerprint | Mehrgan 2019; Thomas 2014 |
| AGN state | Low-power kinetic mode: one radio core + two kpc-scale bipolar jets, ~6.5 mJy at 1.4 GHz, LINER nucleus, no bright X-ray point source or large cavities | Madrid et al. 2021; López-Cruz 2014 |
| Binary status | **Single BH** (VLA rebuts binary/trio); giant core = fossil of *past* binary scouring, best reproduced by merger of two *already-cored* ellipticals (KETJU sims) | Madrid 2021; Rantala 2018/2019 |
| Cluster (Abell 85) | M200 ≈ 3–6 × 10^14 M☉, σ_v ≈ 1000–1100 km/s, r200 ≈ 2.2 Mpc; cool core (n_e0 ≈ 2.6 × 10^-2 cm^-3, β-model r_c ≈ 82 kpc; kT 4 → 6–7 keV); sloshing spiral to ~600 kpc; two infalling subclusters + 4 Mpc filament | Ichinohe 2015; Kim 2025 (WL); Chen 2007 |

### 2.3 Calibration anchors (confirmed / robust systems)

| System | Masses | Separation | Period | Role in sim |
|---|---|---|---|---|
| **B2 0402+379** | 2.8 ± 0.8 × 10^10 M☉ combined | 7.3 pc projected | ~3 × 10^4 yr | The stalled parsec-scale stage; validates hardening-stall behavior (stalled ≳3 Gyr) |
| **OJ 287** | 1.8 × 10^10 + 1.5 × 10^8 M☉ (primary contested) | ~0.05 pc | ~12 yr, e ≈ 0.66, precession 39°/orbit | Sub-parsec relativistic stage; validates PN precession |
| **NGC 7727** | 1.54 × 10^8 + 6.3 × 10^6 M☉ | ~500 pc | — | Early dual-nucleus stage (merges in ~250 Myr) |
| **PKS 2131−021** | — | ~0.001–0.01 pc | 2.08 yr rest-frame | Tightest credible sub-mpc candidate |
| **NANOGrav 15 yr** | population 10^8–10^10 M☉ | sub-pc | nHz band | GW background normalization; A ≈ 2.4 × 10^-15 at 1 yr^-1 |
| Cautionary tales | NGC 7674 (refuted by deeper VLBI); SDSS J1430+2303 ("Tick-Tock" merger never confirmed) | | | Candidate reliability degrades sharply below 1 pc |

---

## 3. Derived quantities for the fiducial binary (M_total = 6 × 10^10 M☉, q = 1, σ = 340 km/s)

All derivable in-page from the formulas; values here are order-of-magnitude checks
(G M☉ = 4.301 × 10^-3 pc (km/s)²; GM/c² for M☉ = 1.48 km).

| Quantity | Formula | Value |
|---|---|---|
| Gravitational radius (per 3 × 10^10 M☉ hole) | GM/c² | ≈ 0.0014 pc ≈ 295 AU |
| Schwarzschild radius (per hole) | 2GM/c² | ≈ 0.0029 pc ≈ 590 AU (~4× Pluto's orbit) |
| Shadow diameter (per hole) | ≈ 10 GM/c² (spin-insensitive ≤4%) | ≈ 0.014 pc |
| Influence radius | r_infl = GM_tot/σ² | ≈ 2.2 kpc — **matches Abell 402-BCG's observed flattened core** |
| Hard-binary separation | a_h = G m₂/(4σ²) | ≈ 280 pc — "final parsec" is really "final few hundred parsecs" at this mass |
| Stellar-hardening rate | d(1/a)/dt = H Gρ/σ, H ≈ 15–20 | needs triaxial loss-cone refill to sustain (Vasiliev 2015) |
| GW-only coalescence horizon | t_c = (5/256) c⁵a⁴/(G³m₁m₂M) | from a = 1 pc: ~10^7 yr; a ≈ 5 pc coalesces within ~10 Gyr → stellar stage must close 280 → ~5 pc |
| Eccentricity boost | t_c ∝ (1−e²)^(7/2) | e = 0.9 → ~10³× faster |
| ISCO GW frequency | f_ISCO ≈ 4.4 kHz × (M☉/M) | ≈ 70 nHz — merges **inside the PTA band**; never reaches LISA |
| Radiated energy at merger (q=1, non-spinning) | ≈ 4.8% Mc² | ≈ 3 × 10^9 M☉ radiated; remnant spin a_f ≈ 0.69 |
| Recoil kick | Campanelli/Lousto–Zlochower fits | ≤175 km/s non-spinning; up to ~4,000–5,000 km/s spin superkick vs. central escape speed ~2,000 km/s → ejection possible |
| Dynamical friction sink time (from 5 kpc) | Chandrasekhar | ~20 Myr at this mass — fast; the binary spends its life in the hardening stall |
| Cavity ↔ separation relation (gas) | r_cavity ≈ 2a | circumbinary disk morphology (Farris 2014) |
| Core scouring deficit | M_def ≈ 0.5 M_bin per merger; +up to ~5 M_BH from recoil sloshing | Merritt 2006; Gualandris & Merritt 2008 |

**The five-stage physics pipeline the sim must represent** (Begelman–Blandford–Rees 1980 stages,
augmented):

1. **Dynamical friction** (kpc → ~a_h): Chandrasekhar drag; fast (~10^7 yr) at these masses.
2. **Hard binary / loss-cone scouring** (a_h → ~5 pc): three-body slingshots eject ~M_bin of
   stars, carving the starless cavity; stalls in spherical potentials (this *is* B2 0402+379's
   state), proceeds in triaxial/rotating ones over ~1–4 Gyr (Khan 2011/13; Vasiliev 2015).
3. **GW inspiral** (Peters 1964 ⟨da/dt⟩, ⟨de/dt⟩): the master clock for separation decay;
   circularizes the orbit.
4. **PN regime** (a ≲ 50 GM/c²): 1PN/2PN conservative + 2.5PN radiation reaction
   (Blanchet LRR) — produces the visible precession and chirp.
5. **Merger + ringdown**: IMRPhenomD-style closed-form waveform; NR-calibrated remnant mass,
   spin, and recoil kick; optional post-kick remnant oscillation through the core (extra
   scouring, Gualandris & Merritt 2008).

---

## 4. Web implementation blueprint (from the methods sweep + repo precedent)

Architecture mirrors `js/ton618/` (entry `boot()`, WebGL2/WebGPU backends, physics/units/
validation modules, HUD + minimap). New physics vs. TON 618: **two** holes, live N-body star
cluster, staged time compression, GW readout.

- **Two-body core (WASM or JS):** time-symmetrized leapfrog (Hut–Makino–McMillan 1995) with
  1PN/2PN + 2.5PN accelerations via the Mikkola–Merritt (2006) auxiliary-velocity trick.
  Hand off to closed-form IMRPhenomD-style merger below ~10 GM/c². Rust → WASM fits the
  existing `build-wasm.sh` pipeline.
- **Star cluster:** N ≈ 2–5 × 10^3 *test particles* in the binary's time-dependent potential
  (O(N), adequate since the binary dominates); tangential-bias initial conditions inside the
  core; slingshot ejections render the cavity being carved in real time.
- **Master clock:** Peters ODEs drive separation decay with logarithmic time compression
  (~10^5 yr/s early, real-time PN dynamics for the last orbits) — do NOT integrate 10^8 yr of
  orbits. Stage state machine per BBR 1980.
- **Rendering:** port/adapt Bruneton (2020) precomputed-texture Schwarzschild shader
  (open-source GLSL) — one lookup-texture set shared by both holes; screen-space composite for
  overlapping Einstein radii. Schwarzschild is quantitatively defensible: shadow diameter is
  spin-insensitive to ≤4% (EHT M87* Paper I). The existing TON 618 Kerr tracer is the upgrade
  path (Verbraeck & Eisemann 2021 adaptive grids for Kerr fidelity).
- **Circumbinary disk (optional visual layer):** procedural encoding of Farris 2014 /
  MacFadyen–Milosavljević 2008 morphology — cavity r ≈ 2a, two accretion streams, per-hole
  minidisks, overdense lump at ~5 binary periods. Note: for these gas-poor ellipticals the
  physically honest default is *dry* (that's why the core is dark); disk mode should be a toggle
  labeled as hypothetical.
- **GW readout:** strain plot + audio from Peters–Mathews harmonics (inspiral) →
  PhenomD amplitude/phase (merger/ringdown), frequency-shifted by an explicit displayed factor
  (~10^9; physical signal peaks near 10^-7 Hz in the PTA band).
- **Scale handling:** camera-relative float origins + logarithmic depth (Gaia Sky techniques)
  to span 2.2 kpc core → 590 AU horizons (~10^6 dynamic range).

---

## 5. Open questions before build

1. **Which system headlines the page?** Recommended: Abell 402-BCG pair as primary scenario,
   Holm 15A (single UMBH, "the real Abell 85") as a comparison mode, B2 0402+379 / OJ 287 as
   calibration presets. Needs user sign-off since the original brief said "Abell 85."
2. **Redshift of Abell 402** — the sweep captured "4.4 billion ly" but not z; read it out of
   McDonald et al. 2026 (arXiv:2603.10104) before wiring cosmological distance/redshift displays.
3. **Mass bracket UI** — Holm 15A's mass halved between 2019 and 2025 analyses (axisymmetric vs.
   triaxial). Display both with provenance rather than picking one silently.
4. **Core reality caveat** — Holm 15A's 4.57 kpc "largest core" is contested (Bonfini 2015;
   Madrid & Donzelli 2016 find a coreless, nucleated profile). The 2.2 kpc Abell 402-BCG core +
   cavity is JWST-based and cleaner for the "dark core" visual.
5. **Naming** — page copy must not claim Abell 85 hosts the 60-billion pair. Honest framing:
   "the candidate ultramassive pair of Abell 402 — and the Abell 85 giant that shows the
   aftermath."

## 6. Verification status

Compiled from six parallel literature sweeps (~119 annotated entries, ≈100 unique sources; see
`ABELL85_PAIR_SOURCE_CATALOG.md`), then adversarially verified by a 105-agent deep-research
workflow (fan-out search → fetch → 3-vote refutation attempts per claim → synthesis). The
verified findings are in §7 below. Corrections the verification pass forced on this document:

- **Core radius, best value:** core-Sérsic **R_b ≈ 2.8 kpc**, with cusp radius **r_γ = 4.11 kpc**
  from the deeper Mehrgan et al. 2019 photometry — the famous 4.57 kpc is the 2014 Nuker-fit
  value. The literature spans 0–4.6 kpc across parameterizations; any adopted core radius must
  carry explicit model-dependence uncertainty (verified 3-0).
- **The 2015–2016 "no depleted core" position (Bonfini+; Madrid & Donzelli) is superseded** —
  its sub-claims were refuted 0-3 in verification; deeper 2019 data confirm a real core.
- **Same-data systematic bracket on the mass:** axisymmetrized refit of the 2025 KCWI data gives
  2.55 ± 0.20 ×10^10 M☉ (vs 2.16 triaxial) — the method-dependence is now quantified (3-0).
- **New scaling for constraint-building:** R_b ∝ M_BH^(0.83±0.10) (Dullo 2019, 11 galaxies with
  direct masses); for large-core galaxies (R_b > 0.5 kpc), σ- and L-based mass predictions are
  systematically undermassive (3-0).
- **Binary separation limit:** any surviving pair in Holm 15A is unconstrained below the ~200 pc
  VLA beam; mass ratio, eccentricity, spins, inspiral timescales survived *no* verified claim —
  free parameters, as this document already treated them.
- **Distance conventions confirmed:** z = 0.0555, D_A = 222.3 Mpc, 1″ ≈ 1.08 kpc, light-travel
  ~700–745 Mly. The 2.7 Gly figure in circulation belongs to Abell 2261-BCG and 4.4 Gly to the
  Abell 402-BCG story (2-1 medium confidence), consistent with §1's identity resolution.
- A verifier note: the claim that earlier Holm 15A double-nucleus reports were "atmospheric
  seeing artifacts" was itself refuted 0-3 as overreach — the single-nucleus conclusion stands
  on the VLA/Chandra data, not on that framing. The source catalog entry is softened accordingly.

---

## 7. Adversarially verified findings (deep-research workflow, 105 agents, completed 2026-07-05)

Each claim below survived 3-vote adversarial verification (vote shown; REFUTED claims noted).

**V1 [HIGH]** (Merged claims [8], [9], [16] — each 3-0)
Current best black hole mass: (2.16 +0.23/−0.18)×10^10 M_sun (~22 billion), from Liepold, Ma & Walsh 2025 (ApJ 980, 58) triaxial Schwarzschild (TriOS) modeling of Keck KCWI stellar kinematics — approximately a factor of 2 below the widely cited (4.0 ± 0.8)×10^10 M_sun of Mehrgan et al. 2019 (ApJ 887, 195). This ties Holm 15A with NGC 4889 as the most massive SMBH known in the local universe, and it makes the popular '40 billion' figure (and any '60 billion combined pair' arithmetic built on it) no longer the best available value.
*Sources: https://iopscience.iop.org/article/10.3847/1538-4357/ada4b0 · https://arxiv.org/pdf/2501.01493 · https://arxiv.org/abs/1907.10608*

**V2 [HIGH]** (Merged claims [2], [10] — each 3-0)
Measurement methodology: both mass determinations are direct orbit-based Schwarzschild dynamical modeling of stellar kinematics, not scaling-relation estimates. 2019: USM Wendelstein photometry + wide-field VLT/MUSE integral-field spectroscopy, axisymmetric orbit models. 2025: Keck KCWI kinematics in 313 spatial bins over a ~100″×100″ field (observed 2018–2021), 2500 kinematic constraints (313 bins × 8 Gauss–Hermite moments) fed into the TriOS triaxial Schwarzschild code, with a search over ~40,000 galaxy models that simultaneously fit black hole mass, stellar mass-to-light ratio, dark-matter halo mass (M50, enclosed within 50 kpc), and intrinsic 3D shape (p, q, u) — exactly the quantities needed for a simulation-constraints table.
*Sources: https://www.mpe.mpg.de/7387190/news-publication-03122019 · https://iopscience.iop.org/article/10.3847/1538-4357/ada4b0 · https://arxiv.org/abs/1907.10608*

**V3 [HIGH]** (Claim [17] — 3-0)
The mass is method-dependent and the galaxy is intrinsically triaxial: refitting the same KCWI data with the axisymmetrized version of TriOS yields worse fits and a higher mass, (2.55 ± 0.20)×10^10 M_sun. The velocity field shows low-amplitude (~20 km/s) rotation along a kinematic axis prominently misaligned from the photometric major axis — a misalignment axisymmetric models cannot reproduce — indicating the earlier axisymmetric 4.0×10^10 M_sun estimate was likely biased high.
*Sources: https://arxiv.org/pdf/2501.01493 · https://iopscience.iop.org/article/10.3847/1538-4357/ada4b0*

**V4 [HIGH]** (Claim [7] — 3-0; corroborated by [16] 3-0. Related claim asserting the pair hypothesis rests on a seeing artifact was REFUTED 0-3 (the artifact framing overreached).)
The SMBH BINARY (pair) claim is NOT observationally supported: new high-resolution VLA 10 GHz A-configuration radio imaging plus Chandra X-ray data show no evidence that Holm 15A harbors a binary black hole — the nucleus appears as a single compact source (Madrid 2021, PASP 133, 014101). The purported 'third' black hole is a background quasar at z = 1.560. Every dynamical measurement (2019 and 2025) models a single central point mass. The popular 'most massive black hole pair, combined 60 billion solar masses' claim conflates garbled 2019 press coverage (a 'two-thirds of the Milky Way = 60 billion suns' stellar-mass analogy) and/or a different system entirely (the Science News 'largest pair' story at 4.4 billion ly). Caveat: the VLA beam (~0.2″ ≈ 200 pc at this distance) cannot resolve a parsec-scale bound binary, so this is a non-detection, not an absolute exclusion.
*Sources: https://arxiv.org/pdf/2012.10774 · https://arxiv.org/pdf/2501.01493 · https://www.syfy.com/syfy-wire/so-how-many-supermassive-black-holes-are-there-in-holmberg-15a-anyway*

**V5 [HIGH]** (Merged claims [4], [13] — each 3-0)
The binary enters the Holm 15A story only as a PAST core-scouring agent: the extremely diffuse, flat inner light profile (depleted core, ~2 mag fainter than any previously dynamically modeled core) is attributed to stars expelled by three-body interactions with SMBH binaries formed in dry (gas-poor) galaxy mergers — the standard core-scouring mechanism. Mehrgan et al. 2019 conclude Holm 15A is the remnant of a merger of two early-type galaxies with pre-existing depleted cores; follow-up N-body work (Nasim et al. 2021, arXiv:2011.04663) reproduces Holm 15A-scale cores via binary scouring plus gravitational-wave recoil. This supports a merged/merging PAST pair, not a currently resolved binary.
*Sources: https://www.mpe.mpg.de/7387190/news-publication-03122019 · https://arxiv.org/pdf/1610.00801 · https://arxiv.org/abs/1907.10608*

**V6 [HIGH]** (Merged claims [0], [1], [5], [6] — each 3-0. Note: three related Madrid & Donzelli 2016 no-core sub-claims were REFUTED (0-3, 1-2, 0-3), consistent with that position being superseded.)
Depleted-core history and controversy (resolved in favor of a real core): (a) 2014 — López-Cruz et al. (ApJL 795, L31) report the largest depleted core known: Nuker cusp radius 4.57 ± 0.06 kpc from 2D fits to R-band imaging out to ~80 kpc, >18× the mean BCG cusp radius and ≥1 kpc larger than prior record-holder A2261-BCG, predicting via core-size scaling a BH of ~10^9–10^11 M_sun (a range that bracketed, five years early, the 2019 direct measurement). (b) 2015–2016 — Bonfini, Dullo & Graham (ApJ 807, 136, 'Too big to be real? No depleted core in Holm 15A') re-fit the same imaging and conclude a coreless low-index Sérsic + outer exponential halo suffices, arguing the 4.57 kpc core is a Nuker-parameterization artifact; Madrid & Donzelli 2016 independently called it 'a nucleated, core-less galaxy.' (c) 2019 — Mehrgan et al., with much deeper Wendelstein photometry and MUSE kinematics, confirm a real, extreme depleted core: core-Sérsic break radius ~2.8 kpc, r_γ = 4.11 ± 0.11 kpc, retained in the 2025 Keck KCWI triaxial study.
*Sources: https://arxiv.org/abs/1405.7758 · https://arxiv.org/pdf/1506.08560 · https://arxiv.org/abs/1907.10608*

**V7 [HIGH]** (Claim [14] — 3-0)
Methodological caution for the simulation-constraints table: depleted-core sizes are strongly fit/model-dependent. Bonfini & Graham 2016 shrank 2MASX J09194427+5622012's break radius 3× (to 0.55 kpc) under careful core-Sérsic re-fitting, while measuring A2261-BCG at R_b ≈ 3.6 kpc; Holm 15A's own literature spans 0 (no core, 2015–16) to 4.57 kpc (Nuker, 2014), with core-Sérsic R_b ≈ 2.8 kpc (2019) the best current value. Any adopted core radius must carry an explicit model-dependence uncertainty.
*Sources: https://arxiv.org/pdf/1610.00801 · https://arxiv.org/abs/1907.10608*

**V8 [HIGH]** (Claim [15] — 3-0)
Mass-deficit budget for scouring simulations: binary SMBH scouring displaces roughly M_def ≈ 0.5·N·M_BH per dry major merger (Merritt 2006 calibration). The A2261-BCG benchmark shows the limit: its ~3.6 kpc core implies up to ~10^11 M_sun displaced — more than pure binary scouring can achieve — leading Bonfini & Graham to favor a 'stalled infalling perturber' scenario (a cannibalized satellite's remnant core whose dynamical-friction-driven decay stalled) or substantial gravitational-wave-recoil events. With M_BH ≈ 2–4×10^10 M_sun, Holm 15A's ~2.8 kpc core is broadly consistent with scouring across a few dry mergers (possibly plus recoil), so a scouring-only simulation is plausible for Holm 15A but must respect this deficit ceiling.
*Sources: https://arxiv.org/pdf/1610.00801 · https://arxiv.org/abs/1707.02277*

**V9 [HIGH]** (Merged claims [11], [12] — each 3-0. Note: a related claim tying Holm 15A's extension of the M_BH–R_b sequence to specific 2× figures was REFUTED 0-3; only the relation itself and the factor-40 offset are verified.)
Scaling relations relevant to constraint-building: (a) a strong log-linear break-radius–BH-mass relation, R_b ∝ M_BH^(0.83 ± 0.10), from the 11 galaxies with directly determined SMBH masses in Dullo 2019's 41-galaxy core-Sérsic sample — usable to predict M_BH from core size and vice versa for depleted-core galaxies like Holm 15A. (b) For the most luminous 'large-core' galaxies (R_b > 0.5 kpc), masses predicted from M_BH–σ (velocity dispersion) and core-Sérsic M_BH–L relations are UNDERMASSIVE by up to a factor of ~40 relative to break-radius expectations — σ-based estimates systematically underpredict ultramassive BHs (Holm 15A's directly measured mass is 4–9× above its σ- and bulge-mass expectations per Mehrgan et al. 2019). Simulations should therefore anchor on the direct dynamical mass and R_b, not on σ-relations.
*Sources: https://iopscience.iop.org/article/10.3847/1538-4357/ab4d4f · https://iopscience.iop.org/article/10.3847/1538-4357/abceae · https://arxiv.org/abs/1907.10608*

**V10 [MEDIUM]** (Claims [3] and [18] — each 2-1)
Distance and environment: Abell 85 is a cluster of more than 500 galaxies at z = 0.0555, corresponding to angular diameter distance D_A = 222.3 Mpc (flat ΛCDM, H0 = 70 km/s/Mpc) — a light-travel distance of roughly 700–745 million light-years. This was, in 2019, roughly twice the distance of prior direct stellar-dynamical BH mass measurements. Popular figures of 2.7 or 4.4 billion light-years for 'the' system belong to OTHER objects (2.7 Gly matches Abell 2261's BCG; 4.4 Gly is the Science News 'largest pair, combined ~60 billion M_sun' story about a different galaxy) and are falsified for Holm 15A, since z = 0.0555 cannot correspond to 4.4 Gly under any standard distance measure.
*Sources: https://www.mpe.mpg.de/7387190/news-publication-03122019 · https://arxiv.org/pdf/2501.01493 · https://iopscience.iop.org/article/10.3847/1538-4357/ada4b0*

**V11 [HIGH]** (Synthesis — component claims 3-0)
DISTILLED SIMULATION-CONSTRAINTS TABLE (all values from 3-0-verified claims unless noted). MASSES — adopt M_BH,total = 2.16 (+0.23/−0.18)×10^10 M_sun (Liepold 2025, triaxial); sensitivity-test alternative 4.0 ± 0.8×10^10 (Mehrgan 2019, axisymmetric); same-data axisymmetric value 2.55 ± 0.20×10^10 brackets the systematic. BINARY PARAMETERS — no observed binary: separation unconstrained below ~200 pc (VLA beam); mass ratio, eccentricity, and spins have NO verified constraints — treat as free parameters; simulate a PAST binary whose merged mass equals today's M_BH. CORE / DENSITY PROFILE — core-Sérsic break radius R_b ≈ 2.8 kpc (best), Nuker r_γ = 4.11 ± 0.11 kpc (2019) to 4.57 ± 0.06 kpc (2014); model-dependence spans 0–4.6 kpc; ultra-diffuse core ~2 mag fainter than any previously modeled. SCOURING BUDGET — M_def ≈ 0.5·N·M_BH per dry merger; deficits ≳10^11 M_sun require GW recoil or a stalled infalling perturber. HOST — intrinsically triaxial (shape p, q, u fit by TriOS), low rotation ~20 km/s, kinematic axis misaligned from photometric major axis; stellar M/L and DM halo mass M50 (within 50 kpc) fit simultaneously in Liepold 2025 (pull numeric values from that paper's tables). FORMATION SCENARIO — remnant of a merger of two early-type galaxies with PRE-EXISTING depleted cores (multi-generation scouring), per Mehrgan 2019 and Nasim 2021. SCALE — z = 0.0555, D_A = 222.3 Mpc, 1″ ≈ 1.08 kpc.
*Sources: https://iopscience.iop.org/article/10.3847/1538-4357/ada4b0 · https://arxiv.org/abs/1907.10608 · https://arxiv.org/pdf/1610.00801*
