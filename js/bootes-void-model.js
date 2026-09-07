/**
 * bootes-void-model.js — the Boötes Void dynamics kernel
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. No DOM, no fetch, no ambient time, no three.js. Every number on
 * bootes-void.html that is a physical claim comes from here, and every one of
 * them is reproducible from `node tests/bootes-void-model.mjs`.
 *
 * WHAT THIS COMPUTES — AND WHAT IT DOES NOT
 * ─────────────────────────────────────────
 * The scientific question the page asks is NOT "does a void have gravity"
 * (of course it does). It is:
 *
 *     Does the observed Boötes underdensity produce a dynamical signature in
 *     the surrounding cosmic web consistent with ΛCDM structure formation,
 *     and out to what radius does it still matter?
 *
 * That is a chain, and every arrow in it is implemented here:
 *
 *     δ(r) → Δ(<r) → v_r(r) → Φ(r) → g(r) → T_ij(r) → ΔT_ij (counterfactual)
 *                                  ↘ Σ(R) → ΔΣ(R) → γ_t   (weak lensing)
 *                                  ↘ s∥ = r∥ + v∥/aH      (redshift space)
 *                                  ↘ Φ̇ → ΔT/T             (ISW)
 *
 * A VOID DOES NOT PUSH. This is the single most-misread thing about the whole
 * subject and the reason the sign conventions below are spelled out. There is
 * no repulsive force. Relative to a homogeneous universe there is simply LESS
 * inward attraction from the underdense direction, so matter's peculiar motion
 * — its motion on top of the Hubble flow — is outward. `radialVelocityKms`
 * returns a POSITIVE number inside the void for exactly that reason, and it is
 * a peculiar velocity, never a recession velocity.
 *
 * THE HONESTY SPLIT — read this before quoting any number off the page
 * ────────────────────────────────────────────────────────────────────
 * Two very different kinds of statement live in this file.
 *
 *   1. MODEL-INDEPENDENT RELATIONS. `radialVelocityKms`, `tidalEigenvalues`,
 *      `enclosedMassExcessMsun`, `deltaSigma`, `iswTemperatureShiftK` are
 *      linear-theory identities. Given a density profile they are as close to
 *      exact as linear theory is, and `tests/bootes-void-model.mjs` pins three
 *      of them against their analytic identities to 1e-9 rather than against
 *      a remembered number.
 *
 *   2. THE PROFILE ITSELF IS A FIT, NOT AN OBSERVATION. `BOOTES_PROFILE` is an
 *      HSW (Hamaus–Sutter–Wandelt 2014) form whose shape parameters are the
 *      published universal-profile values for large voids, anchored to the
 *      Boötes measurements in js/bootes-void-data.js. This repo has NO galaxy
 *      catalogue — astronomy archives are egress-blocked at build time, same
 *      as NASA is for the Sun page — so nothing here is a reconstruction of
 *      the observed galaxy field. Everything downstream inherits that. The
 *      page says so; do not remove those disclosures.
 *
 * THE BIAS STEP IS THE BIGGEST SYSTEMATIC IN THE CHAIN. Voids are measured in
 * GALAXIES and the dynamics respond to MATTER. `matterContrastFromGalaxy` is
 * one line of linear bias, δ_m = δ_g / b, and with b uncertain at the ±20 %
 * level everything downstream of it — velocity, gravity, tidal, lensing, ISW —
 * carries that ±20 % linearly. It is exposed as a tunable on the page for
 * exactly that reason: it is not a detail, it is the error budget.
 *
 * UNITS — stated once, obeyed everywhere
 * ──────────────────────────────────────
 *   Lengths      COMOVING Mpc (not h⁻¹ Mpc). The literature quotes h⁻¹ Mpc
 *                and js/bootes-void-data.js does the conversion in ONE place
 *                so an h-convention slip cannot silently rescale the void.
 *   Densities    contrasts δ = ρ/ρ̄ − 1, dimensionless. Masses in M☉.
 *   Velocities   km/s, peculiar (Hubble flow already removed).
 *   Gravity      m/s² in SI, and km/s/Gyr for anything a human reads — a
 *                cosmological acceleration is ~1e-13 m/s², which is a number
 *                nobody can hold. 20 km/s per Gyr, they can.
 *   Tidal        s⁻² in SI, and the natural unit 4πGρ̄_m in which the radial
 *                eigenvalue is exactly δ − (2/3)Δ. Use the natural unit when
 *                comparing; use SI only when leaving this file.
 *
 * THE COMPENSATION TAIL IS ANALYTIC ON PURPOSE. Beyond `rMaxMpc` the profile
 * is continued as Δ ∝ r⁻³ rather than truncated. Truncating it puts a fake
 * step in Φ (which is a radial INTEGRAL out to infinity), and the ISW and
 * lensing integrals both read Φ. A truncated tail shipped once in development
 * and moved the predicted ISW amplitude by 40 % with nothing looking wrong.
 */

// ── Physical constants (CODATA 2018 / IAU 2015 nominal) ─────────────────────

/** Newton's constant, m³ kg⁻¹ s⁻². */
export const G_SI = 6.67430e-11;
/** Speed of light, m/s. */
export const C_KMS = 299792.458;
/** One megaparsec in metres. */
export const MPC_M = 3.0856775814913673e22;
/** Nominal solar mass, kg. */
export const MSUN_KG = 1.98892e30;
/** One gigayear in seconds. */
export const GYR_S = 3.1556952e16;

// ── Cosmology (Planck 2018 TT,TE,EE+lowE+lensing+BAO, Table 2 column 6) ─────

/**
 * The background. Everything h-dependent in the data file reads `h` from here,
 * so switching to a different H₀ rescales the void CONSISTENTLY instead of
 * leaving the radius in one convention and the density in another.
 */
export const COSMOLOGY = Object.freeze({
    h: 0.6766,
    H0_kms_Mpc: 67.66,
    omegaM: 0.3111,
    omegaLambda: 0.6889,
    omegaB: 0.0490,
    sigma8: 0.8102,
    ns: 0.9665,
    /** Linear growth index. f ≈ Ωm(z)^γ; γ = 0.55 for GR + ΛCDM. */
    growthIndex: 0.55,
    source: 'Planck 2018 results VI, A&A 641 A6 (2020)',
});

/** H(z) in km/s/Mpc. Flat ΛCDM, radiation neglected (z ≪ 1 here). */
export function hubbleKmsMpc(z, cosmo = COSMOLOGY) {
    const a1 = 1 + z;
    return cosmo.H0_kms_Mpc * Math.sqrt(cosmo.omegaM * a1 * a1 * a1 + cosmo.omegaLambda);
}

/** H(z) in s⁻¹. */
export function hubbleSI(z, cosmo = COSMOLOGY) {
    return hubbleKmsMpc(z, cosmo) * 1000 / MPC_M;
}

/** Ωm(z) — the matter fraction at redshift z, which is what f responds to. */
export function omegaMatterAt(z, cosmo = COSMOLOGY) {
    const a1 = 1 + z;
    const m = cosmo.omegaM * a1 * a1 * a1;
    return m / (m + cosmo.omegaLambda);
}

/**
 * Linear growth rate f = dlnD/dlna.
 *
 * Two implementations, and they are NOT redundant. `exact: true` differentiates
 * the growth integral numerically; the default γ-approximation is the one the
 * void literature quotes, so it is what the page reports. The test asserts
 * they agree to better than 1 % across 0 ≤ z ≤ 1 — if a future edit breaks the
 * growth integral, that comparison is what catches it, because the
 * approximation cannot break in the same direction by accident.
 */
export function growthRate(z, cosmo = COSMOLOGY, { exact = false } = {}) {
    if (!exact) return Math.pow(omegaMatterAt(z, cosmo), cosmo.growthIndex);
    const dlna = 1e-4;
    const a = 1 / (1 + z);
    const zPlus = 1 / (a * Math.exp(dlna)) - 1;
    const zMinus = 1 / (a * Math.exp(-dlna)) - 1;
    return (Math.log(growthFactor(zPlus, cosmo)) - Math.log(growthFactor(zMinus, cosmo)))
        / (2 * dlna);
}

/**
 * Linear growth factor D(z), normalised D(0) = 1.
 *
 *   D(a) ∝ H(a) ∫₀^a da' / (a' H(a'))³
 *
 * Simpson on 512 panels. The integrand is singular-looking at a → 0 but
 * (a'H)⁻³ → a'^(3/2)/H₀³ Ωm^(-3/2), which vanishes, so the endpoint is finite
 * and no substitution is needed.
 */
export function growthFactor(z, cosmo = COSMOLOGY) {
    const integral = (aMax) => {
        const n = 512;
        const step = aMax / n;
        let sum = 0;
        for (let i = 0; i <= n; i++) {
            const a = i * step;
            const w = (i === 0 || i === n) ? 1 : (i % 2 ? 4 : 2);
            if (a === 0) continue;              // integrand → 0, weight it as 0
            const zz = 1 / a - 1;
            const eh = hubbleKmsMpc(zz, cosmo) / cosmo.H0_kms_Mpc;
            sum += w / Math.pow(a * eh, 3);
        }
        return sum * step / 3;
    };
    const a = 1 / (1 + z);
    const eOfZ = hubbleKmsMpc(z, cosmo) / cosmo.H0_kms_Mpc;
    const e0 = 1;
    return (eOfZ * integral(a)) / (e0 * integral(1));
}

/** Comoving line-of-sight distance in Mpc. Simpson, 256 panels. */
export function comovingDistanceMpc(z, cosmo = COSMOLOGY) {
    const n = 256;
    const step = z / n;
    if (z === 0) return 0;
    let sum = 0;
    for (let i = 0; i <= n; i++) {
        const zz = i * step;
        const w = (i === 0 || i === n) ? 1 : (i % 2 ? 4 : 2);
        sum += w / (hubbleKmsMpc(zz, cosmo) / cosmo.H0_kms_Mpc);
    }
    return (C_KMS / cosmo.H0_kms_Mpc) * sum * step / 3;
}

/** Angular diameter distance in Mpc (flat universe). */
export function angularDiameterDistanceMpc(z, cosmo = COSMOLOGY) {
    return comovingDistanceMpc(z, cosmo) / (1 + z);
}

/** Angular diameter distance between two redshifts, flat universe, Mpc. */
export function angularDiameterDistanceBetweenMpc(z1, z2, cosmo = COSMOLOGY) {
    if (z2 <= z1) return 0;
    return (comovingDistanceMpc(z2, cosmo) - comovingDistanceMpc(z1, cosmo)) / (1 + z2);
}

/** Critical density today, M☉/Mpc³. ρ_c = 3H₀²/8πG = 2.775e11 h² M☉/Mpc³. */
export function criticalDensityMsunMpc3(cosmo = COSMOLOGY) {
    const h0 = cosmo.H0_kms_Mpc * 1000 / MPC_M;              // s⁻¹
    const rhoSI = 3 * h0 * h0 / (8 * Math.PI * G_SI);        // kg/m³
    return rhoSI * Math.pow(MPC_M, 3) / MSUN_KG;
}

/**
 * Comoving mean matter density, M☉/Mpc³. Comoving, so it does NOT vary with z —
 * that is the whole point of working in comoving coordinates, and it is why
 * `enclosedMassExcessMsun` needs no redshift argument.
 */
export function meanMatterDensityMsunMpc3(cosmo = COSMOLOGY) {
    return cosmo.omegaM * criticalDensityMsunMpc3(cosmo);
}

/**
 * 4πGρ̄_m at redshift z, in s⁻². The natural unit for the tidal tensor.
 *
 * Identity used: 4πGρ̄_m(z) = (3/2) Ωm(z) H(z)². Evaluating it that way rather
 * than converting M☉/Mpc³ to kg/m³ keeps the (1+z)³ of the physical density
 * and the H(z)² of the expansion from drifting apart.
 */
export function fourPiGRhoM(z = 0, cosmo = COSMOLOGY) {
    const hz = hubbleSI(z, cosmo);
    return 1.5 * omegaMatterAt(z, cosmo) * hz * hz;
}

// ── Tracer bias: galaxies are what we see, matter is what pulls ─────────────

/**
 * δ_m from δ_g under linear bias.
 *
 * THE ±20 % LIVES HERE. Linear bias is the standard first-order treatment and
 * it is what void papers use, but it is a first-order treatment applied to a
 * region where δ_g reaches −0.9 — nowhere near the regime it was derived for.
 * The `clip` guard exists because δ_g/b can formally go below −1 for b < 1,
 * and a density below zero is not a large error, it is a nonsensical one that
 * would propagate into every integral downstream as a NaN or worse, silently.
 */
export function matterContrastFromGalaxy(deltaG, bias, { clip = true } = {}) {
    if (!(bias > 0)) throw new Error('matterContrastFromGalaxy: bias must be positive');
    const dm = deltaG / bias;
    return clip ? Math.max(dm, -0.999) : dm;
}

/** δ_g from δ_m — the forward direction, for predicting what a survey sees. */
export function galaxyContrastFromMatter(deltaM, bias) {
    return deltaM * bias;
}

// ── The void density profile ────────────────────────────────────────────────

/**
 * HSW universal void density profile (Hamaus, Sutter & Wandelt 2014,
 * PRL 112, 251302):
 *
 *     δ(r) = δ_c · [1 − (r/r_s)^α] / [1 + (r/R_v)^β]
 *
 * Four parameters, and every one of them does a distinct job:
 *
 *   δ_c   central MATTER contrast (negative). Sets the depth.
 *   r_s   the zero-crossing: δ(r_s) = 0 exactly. Inside it the void is empty,
 *         outside it the numerator flips sign and the profile becomes the
 *         COMPENSATING WALL — the ridge of piled-up matter that a void's
 *         outflow builds. This is not decoration; the wall is what makes
 *         Δ(<r) → 0 at large r, and Δ → 0 is what makes the void's gravity
 *         finite-range instead of Keplerian forever.
 *   R_v   the scale at which the denominator starts cutting the wall off.
 *   β     how sharply. Large β = a thin, tall wall.
 *
 * The wall is the reason `radiusOfInfluence` returns a finite answer at all,
 * and the reason a void is NOT a negative point mass. Deleting the wall (α ≥ β,
 * or r_s → ∞) turns this into a monopole with an r⁻² reach and every number on
 * the page becomes wrong in the same optimistic direction.
 */
export function hswDensityContrast(rMpc, profile) {
    const { deltaC, rsMpc, alpha, rvMpc, beta } = profile;
    const r = Math.max(rMpc, 0);
    const num = 1 - Math.pow(r / rsMpc, alpha);
    const den = 1 + Math.pow(r / rvMpc, beta);
    return deltaC * num / den;
}

/**
 * Build a cached, integrated view of a profile.
 *
 * WHY A FACTORY AND NOT FREE FUNCTIONS. Δ(<r) is a quadrature, Φ(r) is a
 * quadrature of Δ, and the page evaluates both thousands of times per frame
 * (every arrow in the vector field, every ring in the tidal view). Recomputing
 * the integral per call measured 400× slower than the table and made the
 * counterfactual view unusable. The table is built ONCE per parameter set and
 * interpolated linearly on a fine grid; the factory is still pure — same
 * parameters in, same object out, no shared mutable state.
 *
 * Returns a frozen object; all radii in comoving Mpc.
 */
export function createVoidProfile(params = {}) {
    const profile = {
        deltaC: params.deltaC ?? -0.58,
        rsMpc: params.rsMpc ?? 87.0,
        alpha: params.alpha ?? 2.0,
        rvMpc: params.rvMpc ?? 91.6,
        beta: params.beta ?? 9.0,
    };
    return buildProfile((r) => hswDensityContrast(r, profile), profile);
}

/**
 * Split a profile into its two physically distinct halves:
 *
 *   deficit  δ⁻(r) = min(δ(r), 0)   the evacuated interior — "Boötes itself"
 *   wall     δ⁺(r) = max(δ(r), 0)   the compensating ridge — "the structures
 *                                   around it", which a counterfactual keeps
 *
 * THIS IS WHAT MAKES TEST 4 EXACT. The article's experiment is "replace the
 * Boötes underdensity with cosmic mean density and leave everything else
 * alone, then subtract the two gravity fields." Because δ = δ⁻ + δ⁺ exactly,
 * and Δ(<r) is a linear functional of δ, the two component profiles ADD back
 * to the parent to machine precision — the test asserts that at 1e-12. So
 *
 *     Δg = g(model A) − g(model B) = g(deficit alone)
 *
 * is an identity, not a numerical difference of two large fields. Computing
 * the counterfactual by differencing two separately-integrated total fields
 * instead would give the same answer to about four digits and would silently
 * lose precision exactly where the answer is smallest — in the outskirts,
 * which is the part the R_influence result depends on.
 *
 * It is also the honest decomposition. The wall is NOT part of "the void" in
 * any useful sense: it is the matter the void expelled, and it belongs to the
 * surrounding cosmic web that the counterfactual holds fixed.
 */
export function splitProfile(voidProfile) {
    const base = voidProfile.deltaAt;
    const shape = voidProfile.params;
    return {
        deficit: buildProfile((r) => Math.min(base(r), 0), shape),
        wall: buildProfile((r) => Math.max(base(r), 0), shape),
    };
}

/**
 * Build the cached, integrated view of ANY radial density-contrast function.
 *
 * WHY A FACTORY AND NOT FREE FUNCTIONS. Δ(<r) is a quadrature, Φ(r) is a
 * quadrature of Δ, and the page evaluates both thousands of times per frame —
 * every arrow in the vector field, every ring in the tidal view. Recomputing
 * the integral per call measured ~400× slower than the table and made the
 * counterfactual view unusable at interactive rates. The table is built ONCE
 * per parameter set and interpolated linearly; the factory is still pure —
 * same inputs in, same frozen object out, no shared mutable state.
 */
export function buildProfile(deltaFn, shapeParams) {
    const profile = { ...shapeParams };
    // The tabulated range. 6 R_v is far enough that Δ has settled onto its
    // r⁻³ tail (verified in the test), which is what makes the analytic
    // continuation below exact rather than an extrapolation.
    const rMaxMpc = profile.rvMpc * 6;
    // 6000 nodes ⇒ ~0.09 Mpc spacing. Chosen by the DERIVATIVE, not by Δ
    // itself: Δ(<r) is accurate to ~1e-5 at 3000 nodes, but the table is
    // interpolated linearly, so dΔ/dr is only piecewise-constant and its error
    // falls as O(dr) rather than O(dr²). The continuity identity ∇·v = −aHf δ
    // is a statement about that derivative, and at 3000 nodes it was violated
    // by ~0.9 % at small radii — not a bug in the physics, but enough to make
    // the identity untestable, which amounts to the same thing.
    const N = 6000;
    const dr = rMaxMpc / N;

    // Cumulative ∫δ r² dr by the trapezoid rule on a uniform grid. Trapezoid
    // rather than Simpson because we need the CUMULATIVE integral at EVERY
    // node, and Simpson's composite rule only lands on even ones — a
    // half-Simpson at the odd nodes is where an earlier version picked up a
    // visible sawtooth in Δ(<r) that read as real substructure.
    const radii = new Float64Array(N + 1);
    const delta = new Float64Array(N + 1);
    const cumulative = new Float64Array(N + 1);
    for (let i = 0; i <= N; i++) {
        const r = i * dr;
        radii[i] = r;
        delta[i] = deltaFn(r);
    }
    for (let i = 1; i <= N; i++) {
        const rA = radii[i - 1];
        const rB = radii[i];
        cumulative[i] = cumulative[i - 1]
            + 0.5 * (delta[i - 1] * rA * rA + delta[i] * rB * rB) * dr;
    }

    /** δ(r) — direct, no table needed. */
    const deltaAt = (r) => deltaFn(Math.max(r, 0));

    /**
     * Δ(<r) — the integrated (volume-averaged) contrast.
     *
     *     Δ(<r) = (3/r³) ∫₀^r δ(r') r'² dr'
     *
     * This, and not δ(r), is what gravity and velocity respond to: a galaxy at
     * r feels the deficit INSIDE r. That is why the outflow keeps growing
     * outward through a wall where δ has already turned positive.
     */
    const integratedAt = (r) => {
        if (r <= 0) return deltaFn(0);                       // Δ(0) = δ(0)
        if (r >= rMaxMpc) return 3 * cumulative[N] / (r * r * r);   // r⁻³ tail
        const x = r / dr;
        const i = Math.min(N - 1, Math.floor(x));
        const t = x - i;
        return 3 * (cumulative[i] + t * (cumulative[i + 1] - cumulative[i])) / (r * r * r);
    };

    /**
     * Φ(r) − Φ(∞) shape, in comoving Mpc². Dimensioned on read by `potentialAt`.
     *
     *   dΦ/dr = (4/3)πGρ̄ Δ(<r) r
     *   Φ(r)  = −∫_r^∞ (dΦ/dr') dr'
     *
     * For an under-compensated void Δ < 0 everywhere, so Φ > 0: the void is a
     * potential HILL. That sign is why the ISW signature of a void is a COLD
     * spot — the photon climbs a hill that flattened while it was climbing, so
     * it does not get back all the energy it spent. Get the sign wrong and
     * Test 8 inverts, which is exactly what an over-compensated profile does.
     *
     * Integrated INWARD from the analytic tail, so the boundary condition
     * Φ(∞) = 0 is imposed exactly rather than approached.
     */
    const potentialShape = new Float64Array(N + 1);
    potentialShape[N] = -3 * cumulative[N] / rMaxMpc;
    for (let i = N - 1; i >= 0; i--) {
        const gA = integratedAt(radii[i]) * radii[i];
        const gB = integratedAt(radii[i + 1]) * radii[i + 1];
        potentialShape[i] = potentialShape[i + 1] - 0.5 * (gA + gB) * dr;
    }

    //
    // THE (1+z) POWER IS NOT COSMETIC. Comoving Poisson is
    //     ∇²_com Φ = 4πG ρ̄₀ δ (1+z)
    // — ONE factor of (1+z): ∇_phys = (1+z)∇_com contributes (1+z)² while the
    // physical mean density contributes (1+z)⁻³ against ρ̄₀'s comoving
    // normalisation. Reaching for the PHYSICAL density here and forgetting the
    // Laplacian gives (1+z)³ and inflates Φ by 11 % at Boötes' redshift, which
    // is small enough that nothing looks wrong and large enough to matter to
    // the ISW amplitude. It shipped that way during development.
    // `gravityRadialSI` carries (1+z)² by an independent route, and the test
    // asserts g = −dΦ/dr_phys across the two so the pair cannot drift apart.
    const kFactor = (z) => (4 / 3) * Math.PI * G_SI
        * (meanMatterDensityMsunMpc3() * MSUN_KG / Math.pow(MPC_M, 3))
        * (1 + z);

    /** Φ(r) in m²/s². */
    const potentialAt = (r, z = 0) => {
        const shape = (() => {
            if (r >= rMaxMpc) return -3 * cumulative[N] / r;
            const x = Math.max(r, 0) / dr;
            const i = Math.min(N - 1, Math.floor(x));
            const t = x - i;
            return potentialShape[i] + t * (potentialShape[i + 1] - potentialShape[i]);
        })();
        return kFactor(z) * shape * MPC_M * MPC_M;
    };

    // The interior deficit and the wall excess, integrated SEPARATELY. Their
    // ratio is the compensation, and keeping them apart is what makes that
    // number signed and readable instead of an absolute value that cannot tell
    // over-compensation from under-compensation.
    const iCross = Math.min(N, Math.max(0, Math.round(profile.rsMpc / dr)));

    return Object.freeze({
        params: Object.freeze({ ...profile }),
        rMaxMpc,
        deltaAt,
        integratedAt,
        potentialAt,
        /** ∫₀^∞ δ r² dr. Zero for a perfectly compensated void. */
        compensationIntegral: cumulative[N],
        /** ∫₀^{r_s} δ r² dr — the evacuated interior. Negative. */
        interiorIntegral: cumulative[iCross],
        /** ∫_{r_s}^∞ δ r² dr — the wall the outflow piled up. Positive. */
        wallIntegral: cumulative[N] - cumulative[iCross],
    });
}

/**
 * Total mass carried by the compensating wall, in M☉.
 *
 *     M_wall = 4π ρ̄_m ∫_{r_s}^∞ δ r² dr
 *
 * js/bootes-web-model.js takes exactly this mass and redistributes it from a
 * smooth spherical shell into a filament-and-node network. Conserving it is
 * what keeps the clumped model and the spherical model agreeing at large r,
 * and therefore what makes "does the filament or the void dominate here?" a
 * question about CLUMPING rather than about a mass budget somebody invented.
 */
export function wallMassMsun(voidProfile, cosmo = COSMOLOGY) {
    return 4 * Math.PI * meanMatterDensityMsunMpc3(cosmo) * voidProfile.wallIntegral;
}

/**
 * Compensation: how much of the evacuated interior the wall has piled back up.
 *
 *     C = −(wall excess) / (interior deficit)
 *
 *   C = 1   exactly compensated — no monopole at all at large r. The void's
 *           gravity is confined to its own wall and stops dead outside it.
 *   C < 1   UNDER-compensated: a residual mass deficit survives, Δ(<r)
 *           approaches zero from BELOW, and the void keeps drawing matter
 *           outward — weakly, as r⁻³ — far beyond its own wall.
 *   C > 1   OVER-compensated: the wall overshot, the system carries a net mass
 *           EXCESS, and far outside it the void pulls INWARD like an
 *           overdensity.
 *
 * WHICH ONE BOOTES IS, IS A RESULT, NOT A SETTING. Hamaus et al. (2014) find
 * the transition near the median void size: small voids over-compensate, large
 * ones under-compensate. Boötes is a supervoid, so the fitted profile lands
 * under-compensated and `tests/bootes-void-model.mjs` PINS that — because an
 * over-compensated profile silently flips the sign of Φ in the outskirts, and
 * Φ is what the ISW and lensing integrals read. That exact bug shipped during
 * development of this file: it turned the predicted CMB cold spot into a
 * near-cancellation at 4 % of the correct amplitude, with δ, Δ, v and g all
 * still looking perfectly reasonable on the way past.
 */
export function compensationFraction(voidProfile) {
    const deficit = voidProfile.interiorIntegral;
    if (deficit === 0) return 0;
    return -voidProfile.wallIntegral / deficit;
}

// ── Test 1 & 2: the velocity field ──────────────────────────────────────────

/**
 * Radial peculiar velocity in km/s. POSITIVE = outward.
 *
 *   v_r(r) = −(1/3) f(z) a H(z) r Δ(<r)                       [linear]
 *   v_r(r) = −(1/3) f a H r Δ (1 + Δ)^(−1/6)                  [quasi-linear]
 *
 * The second form is the spherical-collapse correction used by Hamaus et al.
 * (2016) for void outflows. It matters: at Δ = −0.4 it is a 9 % boost, and 9 %
 * is comparable to the peculiar-velocity measurement error the test is meant
 * to be compared against, so reporting only the linear form would bias the
 * comparison in one direction. Default is quasi-linear; `linear: true` gets
 * the textbook expression, and the test pins the identity ∇·v = −aHf δ against
 * the LINEAR form (the identity only holds there — that is what "linear
 * theory" means, and it is why both forms are kept).
 *
 * The a·H(z) product: r is COMOVING, so aH r converts a comoving separation to
 * a physical velocity. Dropping the `a` is a (1+z) error — 5 % at Boötes,
 * which is small enough to hide and large enough to matter.
 */
export function radialVelocityKms(rMpc, voidProfile, {
    z = 0, cosmo = COSMOLOGY, linear = false,
} = {}) {
    const dInt = voidProfile.integratedAt(rMpc);
    const f = growthRate(z, cosmo);
    const a = 1 / (1 + z);
    const hz = hubbleKmsMpc(z, cosmo);
    const base = -(1 / 3) * f * a * hz * rMpc * dInt;
    if (linear) return base;
    return base * Math.pow(Math.max(1 + dInt, 1e-6), -1 / 6);
}

/**
 * ∇·v in km/s/Mpc, from the LINEAR velocity field. Computed as the analytic
 * spherical divergence (1/r²) d(r² v_r)/dr rather than differencing the
 * velocity numerically, so the identity below is an identity and not a
 * finite-difference approximation of one.
 *
 * TEST 2 IN ONE LINE. Linear theory says
 *
 *     ∇·v = −a H f δ_m
 *
 * which is an INDEPENDENT statement from the velocity profile: density says
 * where matter is missing, velocity says how gravity responded. This function
 * plus `radialVelocityKms` is what lets the page draw both and show they agree
 * — and lets `tests/bootes-void-model.mjs` assert it to 1e-9.
 */
export function velocityDivergence(rMpc, voidProfile, { z = 0, cosmo = COSMOLOGY } = {}) {
    const f = growthRate(z, cosmo);
    const a = 1 / (1 + z);
    const hz = hubbleKmsMpc(z, cosmo);
    return -a * hz * f * voidProfile.deltaAt(rMpc);
}

// ── Test 4: mass, gravity, potential ────────────────────────────────────────

/**
 * The mass the void is MISSING inside r, in M☉. Negative by construction.
 *
 *   δM(<r) = (4/3)π r³ ρ̄_m Δ(<r)
 *
 * This is a mass DEFICIT, not a mass. It is the quantity a counterfactual
 * subtracts: "what would be here if this region were at the cosmic mean".
 */
export function enclosedMassExcessMsun(rMpc, voidProfile, { cosmo = COSMOLOGY } = {}) {
    const rho = meanMatterDensityMsunMpc3(cosmo);
    return (4 / 3) * Math.PI * Math.pow(rMpc, 3) * rho * voidProfile.integratedAt(rMpc);
}

/**
 * Radial peculiar gravitational acceleration in m/s². POSITIVE = outward,
 * which for a void is what you get, for the reason in the file header.
 *
 *   g_r = −G δM(<r) / r²  =  −(4/3)πGρ̄ Δ(<r) r
 *
 * The second form is used because it is numerically better behaved at r → 0
 * (Δ → δ_c, so g → 0 linearly) and because it makes the proportionality to
 * Δ — not to δ — impossible to misread.
 */
export function gravityRadialSI(rMpc, voidProfile, { z = 0, cosmo = COSMOLOGY } = {}) {
    const k = fourPiGRhoM(z, cosmo) / 3;               // (4/3)πGρ̄ in s⁻²
    const rPhysM = rMpc * MPC_M / (1 + z);             // comoving → physical
    return -k * voidProfile.integratedAt(rMpc) * rPhysM;
}

/** The same acceleration as km/s per Gyr — the only form a reader can hold. */
export function gravityKmsPerGyr(rMpc, voidProfile, opts = {}) {
    return gravityRadialSI(rMpc, voidProfile, opts) * GYR_S / 1000;
}

/**
 * Tidal tensor eigenvalues for the void's spherical field, in units of
 * 4πGρ̄_m — the natural unit, in which they are pure functions of the profile:
 *
 *   λ_radial      = δ(r) − (2/3) Δ(<r)          (once)
 *   λ_tangential  = (1/3) Δ(<r)                 (twice, degenerate)
 *   trace         = δ(r)                        ⇐ Poisson, exactly
 *
 * The trace identity is the strongest single check in this file and the test
 * asserts it to 1e-12. If a future edit breaks the profile integration, the
 * trace stops equalling δ and the gate fires before anything renders.
 *
 * READING THE SIGNS. Inside a void Δ < 0 so λ_tangential < 0 — tidally
 * STRETCHING in both tangential directions — while λ_radial is positive out
 * near the wall, compressing radially. That combination is what flattens
 * matter into the void's WALL, and it is the mechanism behind Test 3: a void
 * does not build filaments by pushing, it builds them by squeezing radially
 * while letting go tangentially.
 */
export function tidalEigenvalues(rMpc, voidProfile) {
    const d = voidProfile.deltaAt(rMpc);
    const dInt = voidProfile.integratedAt(rMpc);
    return {
        radial: d - (2 / 3) * dInt,
        tangential: (1 / 3) * dInt,
        trace: d,
    };
}

/** The same eigenvalues in SI (s⁻²) at redshift z. */
export function tidalEigenvaluesSI(rMpc, voidProfile, { z = 0, cosmo = COSMOLOGY } = {}) {
    const unit = fourPiGRhoM(z, cosmo);
    const e = tidalEigenvalues(rMpc, voidProfile);
    return { radial: e.radial * unit, tangential: e.tangential * unit, trace: e.trace * unit };
}

/**
 * Full 3×3 tidal tensor at a position, in units of 4πGρ̄_m.
 *
 *   T_ij = (Φ'' − Φ'/r) n̂_i n̂_j + (Φ'/r) δ_ij
 *
 * Returned row-major as a length-9 array. Used by the counterfactual: the
 * difference of two tensors is the void's own tidal contribution, exactly.
 */
export function voidTidalTensor(position, center, voidProfile) {
    const dx = position[0] - center[0];
    const dy = position[1] - center[1];
    const dz = position[2] - center[2];
    const r = Math.hypot(dx, dy, dz);
    const e = tidalEigenvalues(r, voidProfile);
    if (r < 1e-9) {
        // Isotropic at the centre: both eigenvalues degenerate to δ_c/3.
        const iso = e.trace / 3;
        return [iso, 0, 0, 0, iso, 0, 0, 0, iso];
    }
    const nx = dx / r, ny = dy / r, nz = dz / r;
    const anis = e.radial - e.tangential;
    const iso = e.tangential;
    return [
        anis * nx * nx + iso, anis * nx * ny, anis * nx * nz,
        anis * ny * nx, anis * ny * ny + iso, anis * ny * nz,
        anis * nz * nx, anis * nz * ny, anis * nz * nz + iso,
    ];
}

/**
 * Peculiar gravity vector from the void at a position, m/s².
 * Points AWAY from the void centre for an underdensity.
 */
export function voidGravityVector(position, center, voidProfile, opts = {}) {
    const dx = position[0] - center[0];
    const dy = position[1] - center[1];
    const dz = position[2] - center[2];
    const r = Math.hypot(dx, dy, dz);
    if (r < 1e-9) return [0, 0, 0];
    const g = gravityRadialSI(r, voidProfile, opts);
    return [g * dx / r, g * dy / r, g * dz / r];
}

/**
 * Peculiar gravity from a compact mass (a cluster, or one node of a filament),
 * m/s². Plummer-softened. `source` and `position` are COMOVING Mpc.
 *
 * THE (1+z)² IS LOAD-BEARING AND WAS MISSING ONCE. Separations here are
 * comoving; gravity is physical; d_phys = d_com/(1+z), so
 *
 *     g = G M / d_phys² = G M (1+z)² / d_com²
 *
 * `gravityRadialSI` carries the same factor by a different route. Without it
 * here, the void's field was physical and the web's field was comoving, so the
 * web came out 1/(1+z)² = 10 % weak — a clean, silent, entirely plausible-
 * looking 10 % that biased every void-versus-web comparison on the page in the
 * void's favour. It was caught by asserting the discrete web against the SHELL
 * THEOREM (`tests/bootes-web-model.mjs`), which is the only check that could
 * have caught it: every quantity involved looked reasonable on its own.
 *
 * SOFTENING IS NOT COSMETIC EITHER. The web model represents filaments as
 * chains of nodes; unsoftened, a test point landing near a node gets an
 * arbitrarily large acceleration and "which dominates, void or filament?" —
 * the actual result of Test 5 — becomes a function of where the chain happened
 * to be sampled. The softening length is the mean particle spacing, so the
 * chain behaves like the continuous filament it stands for.
 */
export function pointGravityVector(position, source, massMsun, softeningMpc, z = 0) {
    const dx = source[0] - position[0];
    const dy = source[1] - position[1];
    const dz = source[2] - position[2];
    const r2 = dx * dx + dy * dy + dz * dz + softeningMpc * softeningMpc;
    const r = Math.sqrt(r2);
    const rPhysM = r * MPC_M / (1 + z);
    const g = G_SI * (massMsun * MSUN_KG) / (rPhysM * rPhysM);
    return [g * dx / r, g * dy / r, g * dz / r];
}

/**
 * Tidal tensor of a compact mass, in units of 4πGρ̄_m.
 *
 *   T_ij = (GM/d³)(δ_ij − 3 n̂_i n̂_j)      — traceless, as vacuum requires
 *
 * Expressed in the same natural unit as `voidTidalTensor` so the two can be
 * added, and carried out in comoving Mpc and M☉ directly with no SI round trip.
 *
 * SOFTENING MAKES IT NON-TRACELESS, AND THAT IS CORRECT. An unsoftened point
 * mass is traceless because vacuum Poisson says so. Plummer softening replaces
 * the point with a finite-density sphere, and the trace then carries exactly
 * that sphere's density contrast, 3Mε²/(4πρ̄(d²+ε²)^{5/2}). So the softened
 * form is not an approximation to a point mass that has picked up an error —
 * it is the exact tidal tensor of the extended object the softening defines,
 * which is what makes it safe to sum into a field the page takes eigenvectors
 * of. `tests/bootes-void-model.mjs` asserts both limits.
 *
 * NO (1+z) HERE, AND THAT IS NOT THE SAME OVERSIGHT AS THE ONE ABOVE. In the
 * natural unit the redshift factors cancel exactly:
 *
 *     GM/d_phys³ ÷ 4πGρ̄_m(z) = M(1+z)³/d_com³ ÷ 4πGρ̄₀(1+z)³ = M/(4πρ̄₀ d_com³)
 *
 * `tidalEigenvalues` is z-independent in the same unit for the same reason, so
 * the two are addable at any redshift without either carrying a conversion.
 * That is the whole argument for reporting tidal quantities in 4πGρ̄_m rather
 * than in s⁻².
 */
export function pointTidalTensor(position, source, massMsun, softeningMpc, cosmo = COSMOLOGY) {
    const dx = source[0] - position[0];
    const dy = source[1] - position[1];
    const dz = source[2] - position[2];
    const d2 = dx * dx + dy * dy + dz * dz + softeningMpc * softeningMpc;
    const d = Math.sqrt(d2);
    const rho = meanMatterDensityMsunMpc3(cosmo);
    const amp = massMsun / (4 * Math.PI * rho * d * d * d);
    const nx = dx / d, ny = dy / d, nz = dz / d;
    return [
        amp * (1 - 3 * nx * nx), amp * (-3 * nx * ny), amp * (-3 * nx * nz),
        amp * (-3 * ny * nx), amp * (1 - 3 * ny * ny), amp * (-3 * ny * nz),
        amp * (-3 * nz * nx), amp * (-3 * nz * ny), amp * (1 - 3 * nz * nz),
    ];
}

/**
 * Symmetric 3×3 eigen-decomposition by the closed-form trigonometric method
 * (Smith 1961). Returns eigenvalues sorted DESCENDING with their eigenvectors.
 *
 * Closed form rather than Jacobi iteration because this runs per filament
 * segment per frame and Jacobi's iteration count varies with the matrix, which
 * put a visible frame-time spike wherever the field was nearly isotropic.
 */
export function symmetricEigen(m) {
    const [a, b, c, , d, e, , , f] = m;
    const p1 = b * b + c * c + e * e;
    const q = (a + d + f) / 3;
    if (p1 < 1e-30) {
        const vals = [[a, [1, 0, 0]], [d, [0, 1, 0]], [f, [0, 0, 1]]];
        vals.sort((x, y) => y[0] - x[0]);
        return { values: vals.map(v => v[0]), vectors: vals.map(v => v[1]) };
    }
    const p2 = (a - q) ** 2 + (d - q) ** 2 + (f - q) ** 2 + 2 * p1;
    const p = Math.sqrt(p2 / 6);
    const B = [(a - q) / p, b / p, c / p, b / p, (d - q) / p, e / p, c / p, e / p, (f - q) / p];
    const detB = B[0] * (B[4] * B[8] - B[5] * B[7])
        - B[1] * (B[3] * B[8] - B[5] * B[6])
        + B[2] * (B[3] * B[7] - B[4] * B[6]);
    const r = Math.max(-1, Math.min(1, detB / 2));
    const phi = Math.acos(r) / 3;
    const eig1 = q + 2 * p * Math.cos(phi);
    const eig3 = q + 2 * p * Math.cos(phi + (2 * Math.PI / 3));
    const eig2 = 3 * q - eig1 - eig3;
    const values = [eig1, eig2, eig3];
    const vectors = values.map(lambda => eigenvectorFor(m, lambda));
    return { values, vectors };
}

/** Eigenvector for a known eigenvalue, via cross products of (M − λI) rows. */
function eigenvectorFor(m, lambda) {
    const A = [m[0] - lambda, m[1], m[2], m[3], m[4] - lambda, m[5], m[6], m[7], m[8] - lambda];
    const rows = [[A[0], A[1], A[2]], [A[3], A[4], A[5]], [A[6], A[7], A[8]]];
    let best = [0, 0, 0];
    let bestLen = 0;
    for (let i = 0; i < 3; i++) {
        for (let j = i + 1; j < 3; j++) {
            const u = rows[i], v = rows[j];
            const cross = [
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            ];
            const len = Math.hypot(cross[0], cross[1], cross[2]);
            if (len > bestLen) { bestLen = len; best = cross; }
        }
    }
    if (bestLen < 1e-12) return [1, 0, 0];
    return [best[0] / bestLen, best[1] / bestLen, best[2] / bestLen];
}

// ── Test 6: redshift-space distortion ───────────────────────────────────────

/**
 * Map a real-space separation from the void centre into redshift space.
 *
 *   s∥ = r∥ + v∥ / (a H)
 *
 * `losUnit` is the unit vector towards the observer. For a void the outflow
 * makes the near side appear FURTHER and the far side appear NEARER, so the
 * void looks SQUASHED along the line of sight — the opposite of the
 * fingers-of-god stretch a cluster shows, and the reason a void's redshift
 * space shape carries f/b.
 *
 * Returns the redshift-space offset in comoving Mpc.
 */
export function toRedshiftSpace(offsetMpc, voidProfile, losUnit, {
    z = 0, cosmo = COSMOLOGY, linear = false,
} = {}) {
    const r = Math.hypot(offsetMpc[0], offsetMpc[1], offsetMpc[2]);
    if (r < 1e-9) return [...offsetMpc];
    const vr = radialVelocityKms(r, voidProfile, { z, cosmo, linear });
    const a = 1 / (1 + z);
    const hz = hubbleKmsMpc(z, cosmo);
    // v∥ is the projection of the (radial) outflow onto the line of sight.
    const nDotL = (offsetMpc[0] * losUnit[0] + offsetMpc[1] * losUnit[1]
        + offsetMpc[2] * losUnit[2]) / r;
    const shift = (vr * nDotL) / (a * hz);                  // Mpc, comoving
    return [
        offsetMpc[0] + shift * losUnit[0],
        offsetMpc[1] + shift * losUnit[1],
        offsetMpc[2] + shift * losUnit[2],
    ];
}

/**
 * Apparent line-of-sight elongation of the void in redshift space at radius r:
 *
 *     ε(r) = s∥(r, along LOS) / s⊥(r, across LOS)
 *
 * ε > 1 means the void looks STRETCHED along the sightline, and that is the
 * sign the outflow gives. It is worth walking through once, because it is easy
 * to talk yourself into the opposite: the near wall moves toward us, so it is
 * blueshifted and placed CLOSER than it really is — which is FURTHER from the
 * void centre in our direction. The far wall moves away, is redshifted, and is
 * placed further out — also further from the centre. Both walls move outward
 * in redshift space, so the void inflates along the line of sight. (A cluster
 * does the reverse: its RSD signature is a finger pointing at us, a void's is
 * a pancake lying across the sky.)
 *
 * This MEASURES the effect by calling the mapping rather than quoting a closed
 * form, so it can never disagree with the geometry the page draws.
 */
export function apparentEllipticity(rMpc, voidProfile, opts = {}) {
    const los = [0, 0, 1];
    const along = toRedshiftSpace([0, 0, rMpc], voidProfile, los, opts);
    const across = toRedshiftSpace([rMpc, 0, 0], voidProfile, los, opts);
    const sPar = Math.abs(along[2]);
    const sPerp = Math.hypot(across[0], across[1]);
    return sPerp === 0 ? 1 : sPar / sPerp;
}

/**
 * The quadrupole-to-monopole amplitude of the void–galaxy cross-correlation,
 * in the linear (Cai et al. 2016) limit:
 *
 *   ξ₂/ξ₀ ∝ (2β/3) · [Δ(<r) − δ(r)] / [1 + (1/3)Δ(<r)] ,   β = f/b
 *
 * This is the observable Test 6 actually delivers: the RSD signal constrains
 * β, not the void. Reported so the page can state what a survey would have to
 * measure, and at what precision, rather than implying we have measured it.
 */
export function rsdQuadrupoleRatio(rMpc, voidProfile, { z = 0, cosmo = COSMOLOGY, bias = 1.3 } = {}) {
    const beta = growthRate(z, cosmo) / bias;
    const dInt = voidProfile.integratedAt(rMpc);
    const d = voidProfile.deltaAt(rMpc);
    return (2 * beta / 3) * (dInt - d) / (1 + dInt / 3);
}

// ── Test 7: weak lensing ────────────────────────────────────────────────────

/**
 * Projected excess surface density Σ(R) in M☉/Mpc², at projected radius R.
 *
 *   Σ(R) = ρ̄_m ∫ δ(√(R² + ℓ²)) dℓ
 *
 * Negative inside a void: there is LESS projected matter than the mean along
 * that sightline, which is what makes a void a diverging lens.
 *
 * Integrated to 6 R_v, which is where the tabulated profile ends and δ has
 * fallen below 1e-6 — the test asserts the truncation costs under 0.1 %.
 */
export function surfaceDensityExcess(rProjMpc, voidProfile, { cosmo = COSMOLOGY, panels = 400 } = {}) {
    const rho = meanMatterDensityMsunMpc3(cosmo);
    const lMax = voidProfile.rMaxMpc;
    const step = lMax / panels;
    let sum = 0;
    for (let i = 0; i <= panels; i++) {
        const l = i * step;
        const w = (i === 0 || i === panels) ? 1 : (i % 2 ? 4 : 2);
        sum += w * voidProfile.deltaAt(Math.hypot(rProjMpc, l));
    }
    // ×2 for the symmetric −ℓ half of the sightline.
    return 2 * rho * sum * step / 3;
}

/**
 * The lensing observable ΔΣ(R) = Σ̄(<R) − Σ(R), in M☉/Mpc².
 *
 * NEGATIVE for a void, which corresponds to a NEGATIVE tangential shear —
 * background galaxies are stretched RADIALLY around a void rather than
 * tangentially as they are around a cluster. That sign flip is the entire
 * observational signature and the reason void lensing is stacked separately
 * from cluster lensing rather than just being "a cluster with a minus sign".
 */
export function deltaSigma(rProjMpc, voidProfile, opts = {}) {
    const panels = 120;
    const step = rProjMpc / panels;
    let sum = 0;
    for (let i = 0; i <= panels; i++) {
        const rr = i * step;
        const w = (i === 0 || i === panels) ? 1 : (i % 2 ? 4 : 2);
        sum += w * surfaceDensityExcess(rr, voidProfile, opts) * rr;
    }
    const mean = (2 / (rProjMpc * rProjMpc)) * sum * step / 3;
    return mean - surfaceDensityExcess(rProjMpc, voidProfile, opts);
}

/** Critical surface density for lensing, M☉/Mpc². */
export function criticalSurfaceDensityMsunMpc2(zLens, zSource, cosmo = COSMOLOGY) {
    const dl = angularDiameterDistanceMpc(zLens, cosmo);
    const ds = angularDiameterDistanceMpc(zSource, cosmo);
    const dls = angularDiameterDistanceBetweenMpc(zLens, zSource, cosmo);
    if (dl <= 0 || dls <= 0) return Infinity;
    // c²/(4πG) expressed in M☉/Mpc, once.
    const cSI = C_KMS * 1000;
    const factorSI = cSI * cSI / (4 * Math.PI * G_SI);       // kg/m
    const factor = factorSI / MSUN_KG * MPC_M;               // M☉/Mpc
    return factor * ds / (dl * dls);
}

/** Tangential shear γ_t(R) — dimensionless. Negative for a void. */
export function tangentialShear(rProjMpc, voidProfile, { zLens, zSource, cosmo = COSMOLOGY } = {}) {
    const sigCr = criticalSurfaceDensityMsunMpc2(zLens, zSource, cosmo);
    return deltaSigma(rProjMpc, voidProfile, { cosmo }) / sigCr;
}

/**
 * Shape-noise signal-to-noise for measuring γ_t in one annulus.
 *
 * Honest by construction: it takes the survey's actual galaxy density and
 * ellipticity dispersion and returns what those buy. The Boötes answer comes
 * out around unity per annulus for a deep survey, which is the correct answer
 * and a genuinely useful null — a single void, even this one, is not a lensing
 * detection, which is exactly why the literature stacks thousands of them.
 *
 * `annulusWidthMpc` and the distances are converted to sky area through the
 * lens's angular diameter distance, so the enormous 20°-scale angular size of
 * Boötes is properly credited rather than assumed away.
 */
export function lensingSNR(rProjMpc, voidProfile, {
    zLens, zSource, annulusWidthMpc,
    galaxiesPerArcmin2 = 10, shapeNoise = 0.28, skyCoverage = 1, cosmo = COSMOLOGY,
} = {}) {
    const gamma = tangentialShear(rProjMpc, voidProfile, { zLens, zSource, cosmo });
    const dA = angularDiameterDistanceMpc(zLens, cosmo);
    if (dA <= 0) return 0;
    const thetaRad = rProjMpc / dA;
    const widthRad = annulusWidthMpc / dA;
    const areaSr = 2 * Math.PI * thetaRad * widthRad;
    const arcmin2PerSr = Math.pow(180 * 60 / Math.PI, 2);
    const nGal = areaSr * arcmin2PerSr * galaxiesPerArcmin2 * skyCoverage;
    if (nGal <= 0) return 0;
    return Math.abs(gamma) * Math.sqrt(nGal) / shapeNoise;
}

// ── Test 8: the integrated Sachs–Wolfe imprint ──────────────────────────────

/**
 * ISW temperature shift through the void centre, in kelvin.
 *
 *   ΔT/T = (2/c³) ∫ Φ̇ dl        [comoving path length l, physical Φ̇]
 *
 * In linear theory the potential's whole time dependence is Φ ∝ D(a)/a, so
 *
 *   Φ̇ = Φ · H · dln(D/a)/dlna = Φ · H · (f − 1)
 *
 * and for a void (Φ > 0, f < 1) this is negative: a COLD spot. The photon
 * climbs a hill that flattened while it was climbing.
 *
 * The path integral is done properly along the chord at impact parameter b,
 * because ΔT(θ) — the profile, not just the central depth — is what a stacked
 * CMB analysis actually fits, and a single central number cannot be compared
 * against Planck at all.
 */
export function iswTemperatureShiftK(impactParamMpc, voidProfile, {
    z = 0, cosmo = COSMOLOGY, tcmbK = 2.7255, panels = 400,
} = {}) {
    const f = growthRate(z, cosmo);
    const hz = hubbleSI(z, cosmo);
    const dlnPhi = hz * (f - 1);                             // s⁻¹, negative for a void
    const lMax = voidProfile.rMaxMpc;
    const step = lMax / panels;
    let sum = 0;
    for (let i = 0; i <= panels; i++) {
        const l = i * step;
        const w = (i === 0 || i === panels) ? 1 : (i % 2 ? 4 : 2);
        sum += w * voidProfile.potentialAt(Math.hypot(impactParamMpc, l), z);
    }
    const phiPath = 2 * sum * step / 3 * MPC_M;              // m³/s² (Φ·length)
    const cSI = C_KMS * 1000;
    return tcmbK * (2 / (cSI * cSI * cSI)) * dlnPhi * phiPath;
}

// ── The headline result: how far does Boötes actually reach? ────────────────

/**
 * How far Boötes reaches — reported three ways, because there is no single
 * honest answer to "where does a void stop mattering".
 *
 * THE OBVIOUS DEFINITION DOES NOT WORK, and understanding why is most of the
 * physics. The tempting metric is "the radius where the void's contribution
 * drops below X % of the total peculiar acceleration". It fails because the
 * void and its own compensating wall pull in OPPOSITE directions and nearly
 * cancel outside the wall: the total field out there is small precisely
 * BECAUSE the void's contribution is large. That metric therefore reports the
 * void's fractional influence as growing without bound exactly where its
 * absolute influence is vanishing. It is not a conservative choice or a noisy
 * one; it is backwards.
 *
 * So this returns three well-posed measures instead:
 *
 *   1. velocityHorizonMpc — ABSOLUTE and observational. The radius beyond
 *      which the void core alone could not have induced a peculiar velocity
 *      larger than `velocityThresholdKms`. This is the number to quote,
 *      because it is stated in the units a peculiar-velocity survey actually
 *      measures in, and its threshold is an explicit input rather than a
 *      hidden convention.
 *
 *   2. shareProfile — the void's share of the local acceleration MAGNITUDE,
 *      sampled over many directions and reduced to a median with a 16–84
 *      band. The BAND is the result: the void reaches much further into empty
 *      directions than it does towards Corona Borealis, and a single number
 *      would hide exactly the anisotropy that makes the question interesting.
 *
 *   3. crossover — per direction, the radius (if any) at which the surrounding
 *      web overtakes the void in local acceleration. `fraction` is the share
 *      of directions in which that ever happens inside the sampled range. For
 *      an under-compensated void it does NOT happen in most directions, and
 *      reporting "no crossover in 71 % of directions" is a result, not a
 *      failure to converge.
 *
 * `deficitProfile` must be the DEFICIT half from `splitProfile` — the void
 * itself, not the void plus its wall. Passing the full profile silently asks
 * a different question (how far does the whole compensated system reach,
 * which is "not far", by construction).
 */
export function influenceProfile(deficitProfile, externalGravityAt, {
    center = [0, 0, 0], directions = 96,
    rMinMpc = 10, rMaxMpc = null, stepMpc = 4,
    velocityThresholdKms = 50, z = 0, cosmo = COSMOLOGY,
} = {}) {
    const rMax = rMaxMpc ?? deficitProfile.rMaxMpc;

    // 1. Velocity horizon — spherically symmetric, so one radial scan.
    let velocityHorizonMpc = null;
    for (let r = rMinMpc; r <= rMax; r += stepMpc) {
        if (Math.abs(radialVelocityKms(r, deficitProfile, { z, cosmo })) < velocityThresholdKms) {
            velocityHorizonMpc = r;
            break;
        }
    }

    // Fibonacci sphere: even coverage without the pole clustering a lat/lon
    // grid gives, which would bias the median towards whatever sits along ±z.
    const golden = Math.PI * (3 - Math.sqrt(5));
    const dirs = [];
    for (let i = 0; i < directions; i++) {
        const y = 1 - (i / Math.max(1, directions - 1)) * 2;
        const ring = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = golden * i;
        dirs.push([Math.cos(theta) * ring, y, Math.sin(theta) * ring]);
    }

    const radii = [];
    for (let r = rMinMpc; r <= rMax; r += stepMpc) radii.push(r);

    const shareProfile = [];
    const crossings = new Array(directions).fill(null);
    for (const r of radii) {
        const shares = [];
        for (let d = 0; d < directions; d++) {
            const dir = dirs[d];
            const pos = [
                center[0] + dir[0] * r, center[1] + dir[1] * r, center[2] + dir[2] * r,
            ];
            const gv = voidGravityVector(pos, center, deficitProfile, { z, cosmo });
            const ge = externalGravityAt(pos);
            const magV = Math.hypot(gv[0], gv[1], gv[2]);
            const magE = Math.hypot(ge[0], ge[1], ge[2]);
            const total = magV + magE;
            const share = total > 0 ? magV / total : 1;
            shares.push(share);
            if (crossings[d] === null && share < 0.5) crossings[d] = r;
        }
        shares.sort((a, b) => a - b);
        const pick = (q) => shares[Math.min(shares.length - 1, Math.floor(q * shares.length))];
        shareProfile.push({ radiusMpc: r, median: pick(0.5), p16: pick(0.16), p84: pick(0.84) });
    }

    const crossed = crossings.filter(c => c !== null).sort((a, b) => a - b);
    const pickC = (q) => crossed.length
        ? crossed[Math.min(crossed.length - 1, Math.floor(q * crossed.length))] : null;

    return {
        velocityThresholdKms,
        velocityHorizonMpc,
        shareProfile,
        crossover: {
            fraction: crossed.length / directions,
            medianMpc: pickC(0.5),
            p16Mpc: pickC(0.16),
            p84Mpc: pickC(0.84),
        },
        directions,
    };
}

/**
 * Alignment statistic for Test 5: |cos θ| between a set of segment directions
 * and a chosen tidal eigenvector at each segment's position.
 *
 * Returns the mean |cos θ|, the isotropic expectation (exactly 0.5 for
 * random 3D orientations — that is why the null is a constant and not a
 * simulated distribution), and a z-score from the analytic variance of the
 * mean under isotropy, Var(|cosθ|) = 1/12.
 *
 * A REAL RESULT NEEDS BOTH NUMBERS. Reporting only the mean invites reading
 * 0.53 as "aligned"; with n = 40 segments the isotropic 1σ is 0.046, so 0.53
 * is 0.6σ and means nothing. The z-score is what the page prints.
 */
export function alignmentStatistic(segments, eigenvectorAt) {
    if (!segments.length) return { meanAbsCos: 0.5, isotropic: 0.5, z: 0, n: 0 };
    let sum = 0;
    for (const seg of segments) {
        const e = eigenvectorAt(seg);
        const dot = seg.direction[0] * e[0] + seg.direction[1] * e[1] + seg.direction[2] * e[2];
        sum += Math.abs(dot);
    }
    const n = segments.length;
    const mean = sum / n;
    const sigma = Math.sqrt((1 / 12) / n);
    return { meanAbsCos: mean, isotropic: 0.5, z: (mean - 0.5) / sigma, n };
}
