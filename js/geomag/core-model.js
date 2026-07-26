/**
 * core-model.js — Earth's interior as a magnetic system.
 * ═══════════════════════════════════════════════════════════════════════════
 * Layer properties, the dimensionless numbers that decide whether a dynamo
 * runs at all, the free-decay times that decide which multipole survives, and
 * the mantle screening that decides what we can ever hope to observe.
 *
 * Pure kernel, everything computed from the constants below. Gate:
 * `tests/geomag-core-model.mjs`.
 *
 * ── HONEST LABEL: THIS IS A *MODEL*, NOT A SIMULATION ─────────────────────
 * Nothing here is a 3-D MHD geodynamo. A real one needs a supercomputer and
 * the best published runs still sit eight orders of magnitude from Earth's
 * Ekman number — which you can read off `dimensionlessNumbers()` below, where
 * Pm = 1.3×10⁻⁶ is precisely the number that puts Earth out of reach. Anything
 * claiming to simulate the geodynamo in a browser is lying. This layer is
 * labelled "model" on the page for that reason.
 */

const MU0 = 4e-7 * Math.PI;
const OMEGA_EARTH = 7.292115e-5;        // rad/s
export const YEAR_S = 365.25 * 86400;
export const R_CMB_M = 3480e3;
export const R_IC_M = 1221.5e3;
export const D_MANTLE_M = 2891e3;

/**
 * Radial structure. σ values are standard estimates; the ranges in the
 * literature are real and wide (the outer core is quoted anywhere from
 * 0.5–1.6×10⁶ S/m).
 */
export const LAYERS = Object.freeze([
    { name: 'Inner core',   rInnerKm: 0,      rOuterKm: 1221.5, sigma: 1e6,  state: 'solid Fe–Ni' },
    { name: 'Outer core',   rInnerKm: 1221.5, rOuterKm: 3480,   sigma: 1e6,  state: 'liquid Fe–Ni + light elements' },
    { name: 'Lower mantle', rInnerKm: 3480,   rOuterKm: 5711,   sigma: 3,    state: 'silicate, bridgmanite' },
    { name: 'Upper mantle', rInnerKm: 5711,   rOuterKm: 6336,   sigma: 1e-2, state: 'silicate' },
    { name: 'Crust',        rInnerKm: 6336,   rOuterKm: 6371,   sigma: 1e-3, state: 'silicate, partly magnetised' },
]);

/**
 * Curie temperatures, K. The point of this table:
 *
 * NOTHING BELOW THE SHALLOW CRUST IS PERMANENTLY MAGNETIC. The core runs at
 * 5000–6000 K and the lower mantle above 2000 K; every deep layer is far above
 * its Curie point. The field is carried ENTIRELY by electric currents —
 * roughly 10⁹ A in the core — not by magnetised rock. The only magnetised rock
 * on Earth is the thin cold crust, which is exactly why the Lowes–Mauersberger
 * spectrum (igrf.js `lowesSpectrum`) flattens above degree ~13.
 */
export const CURIE_K = Object.freeze({ magnetite: 858, hematite: 948, iron: 1043 });

/** Outer-core parameters used for the dimensionless numbers. */
export const CORE = Object.freeze({
    sigma: 1e6,          // S/m
    rho: 1.1e4,          // kg/m³
    nu: 1e-6,            // m²/s, molecular kinematic viscosity
    U: 4e-4,             // m/s, core-surface flow (~13 km/yr)
    B: 4e-3,             // T, internal rms field from torsional waves
    L: (3480 - 1221.5) * 1e3,  // m, shell thickness
});

/**
 * The six numbers that say a dynamo is possible.
 *
 * Rm is the one that matters: induction beats diffusion ~1000:1, against a
 * threshold near 40. Elsasser ≈ 10 says the field it makes is strong enough to
 * react back on the flow. And Pm ≈ 10⁻⁶ is why simulations cannot reach Earth.
 */
export function dimensionlessNumbers(core = CORE) {
    const eta = 1 / (MU0 * core.sigma);
    return {
        etaM2S: eta,
        magneticReynolds: (core.U * core.L) / eta,
        ekman: core.nu / (2 * OMEGA_EARTH * core.L * core.L),
        rossby: core.U / (2 * OMEGA_EARTH * core.L),
        magneticPrandtl: core.nu / eta,
        elsasser: (core.B * core.B) / (2 * OMEGA_EARTH * core.rho * MU0 * eta),
    };
}

// ── Spherical Bessel functions ───────────────────────────────────────────────

/**
 * Spherical Bessel function j_n(x) by DOWNWARD (Miller) recurrence.
 *
 * The upward recurrence j_{n+1} = (2n+1)/x·j_n − j_{n−1} is unstable wherever
 * x ≲ n, and the first zero of j_n sits just above n — precisely the region
 * this function is used in. Downward recurrence from a high seed, normalised
 * against the closed form j_0 = sin x / x, is stable everywhere.
 */
export function sphericalJn(n, x) {
    if (x === 0) return n === 0 ? 1 : 0;
    if (n === 0) return Math.sin(x) / x;
    // The recurrence must start above BOTH n and x. Starting from n alone is
    // fine while x ≲ n (which is where the first zeros live, so the zeros were
    // never wrong) but loses accuracy badly for x ≫ n — the independent
    // cross-check in tests/geomag-diffusion.mjs caught 1.8e-4 of disagreement
    // at n=1, x=28.
    const m = Math.max(n, Math.ceil(x));
    const start = m + 25 + Math.ceil(Math.sqrt(40 * m));
    let jp1 = 0;
    let j = 1e-300;
    let want = 0;
    for (let k = start; k >= 1; k--) {
        const jm1 = ((2 * k + 1) / x) * j - jp1;
        jp1 = j;
        j = jm1;
        if (k - 1 === n) want = jm1;
        // Renormalise to keep the recurrence off the overflow ceiling.
        if (Math.abs(j) > 1e250) {
            const s = 1e-250;
            j *= s; jp1 *= s; want *= s;
        }
    }
    return want * ((Math.sin(x) / x) / j);
}

/** First positive zero of j_n, by scan then bisection. */
export function jnFirstZero(n) {
    const lo = n + 1e-6;
    const hi = n + 12 + 2 * Math.cbrt(n);
    const steps = 4000;
    let a = lo;
    let fa = sphericalJn(n, a);
    for (let i = 1; i <= steps; i++) {
        const b = lo + ((hi - lo) * i) / steps;
        const fb = sphericalJn(n, b);
        if (fa === 0) return a;
        if (fa * fb < 0) {
            let x0 = a, x1 = b, f0 = fa;
            for (let k = 0; k < 200; k++) {
                const mid = 0.5 * (x0 + x1);
                const fm = sphericalJn(n, mid);
                if (f0 * fm <= 0) x1 = mid; else { x0 = mid; f0 = fm; }
                if (x1 - x0 < 1e-13) break;
            }
            return 0.5 * (x0 + x1);
        }
        a = b; fa = fb;
    }
    return NaN;
}

/**
 * Slowest ohmic free-decay time of a degree-n poloidal field in a sphere:
 *
 *     τ_n = μ₀ σ a² / k_n²,   k_n the first zero of j_n.
 *
 * ── WHY THE FIELD IS A DIPOLE, IN THREE PARTS ─────────────────────────────
 *
 * 1. No monopole exists. ∇·B = 0 forbids degree 0, so degree 1 is the lowest
 *    multipole AVAILABLE. That is a constraint of Maxwell's equations, not a
 *    preference.
 * 2. The dipole outlives everything else. Switch the dynamo off and this
 *    function gives 23,884 yr at n = 1 against 1,432 yr at n = 13 — the dipole
 *    survives 16.7× longer, so the dynamo has to work least hard to sustain it.
 * 3. Rotation SELECTS it — but only within a window. See dynamo.js
 *    `alphaOmegaParity`, which is the interesting part: a dipole is not
 *    inevitable.
 *
 * @returns {number} seconds
 */
export function freeDecayTime(n, sigma = CORE.sigma, aM = R_CMB_M) {
    const k = jnFirstZero(n);
    return (MU0 * sigma * aM * aM) / (k * k);
}

/** Free-decay table for a list of degrees, in years, plus the ratio to n = 1. */
export function freeDecayTable(degrees = [1, 2, 3, 4, 5, 8, 13, 20]) {
    const t1 = freeDecayTime(1);
    return degrees.map((n) => {
        const t = freeDecayTime(n);
        return { n, kn: jnFirstZero(n), years: t / YEAR_S, ratioToDipole: t / t1 };
    });
}

// ── Mantle screening ─────────────────────────────────────────────────────────

/**
 * |B_surface / B_CMB| for a core signal of period T diffusing outward through
 * a mantle of uniform conductivity σ:
 *
 *     δ = √(T / (π μ₀ σ)),    attenuation = exp(−d / δ)
 *
 * A deliberately simple 1-D estimate — the real mantle is radially stratified
 * and the true cutoff is debated. It is enough to make the point:
 *
 *   50% attenuation at 0.22 yr (σ = 0.1), 2.2 yr (σ = 1), 22 yr (σ = 10).
 *   At σ = 1 a ONE-DAY core signal arrives with 3×10⁻⁹ of its amplitude.
 *
 * So daily core analysis is not a data problem — it is a diffusion problem, and
 * no instrument fixes it. The logic runs backwards too, which is the better
 * half: we DO observe jerks at 1–3 yr and torsional waves at ~6 yr, so the
 * mantle cannot be as conductive as the uniform σ = 10 case. The observations
 * bound the interior.
 *
 * @param {number} periodYears
 * @param {number} sigma S/m
 */
export function mantleScreening(periodYears, sigma) {
    const T = periodYears * YEAR_S;
    const delta = Math.sqrt(T / (Math.PI * MU0 * sigma));
    return Math.exp(-D_MANTLE_M / delta);
}

/** Period, in years, at which mantle screening reaches 50% for a given σ. */
export function halfAttenuationPeriodYears(sigma) {
    // exp(−d/δ) = ½  ⇒  δ = d/ln2  ⇒  T = π μ₀ σ δ².
    const delta = D_MANTLE_M / Math.LN2;
    return (Math.PI * MU0 * sigma * delta * delta) / YEAR_S;
}

/**
 * The punchline that ties the three layers of this page together.
 *
 * Core signals at short period are ~1–3 nT. Sq is ~30 nT, storm recovery ~50,
 * main phase ~100. The core signals we most want are buried an order of
 * magnitude under external noise — so detecting them is an EXTERNAL-FIELD
 * REMOVAL problem, and the better the magnetosphere is modelled, the deeper
 * into the Earth we can see.
 *
 * Which is the whole argument for putting a nowcast on top of a field model on
 * top of a dynamo model, on one page: field modellers remove the external
 * field to see the core; space-weather modellers remove secular variation to
 * see the magnetosphere. Each community's signal is the other's noise.
 */
export const AMPLITUDE_LADDER_NT = Object.freeze([
    { label: 'Core signal, short period', nT: 2,   layer: 'core' },
    { label: 'Sq daily variation',        nT: 30,  layer: 'external' },
    { label: 'Storm recovery phase',      nT: 50,  layer: 'external' },
    { label: 'Storm main phase',          nT: 100, layer: 'external' },
]);
