// Local GR diagnostics for an observer in the Schwarzschild geometry.
//
// All formulae are evaluated in geometrized units (G = c = M = 1). The
// observatory uses TON 618 mass scaling (units.js) to convert results into
// SI / human units for the HUD.
//
// References:
//   Misner-Thorne-Wheeler, "Gravitation", chs. 23, 25 (Schwarzschild geometry,
//   stationary & orbiting observers).
//   Bardeen-Press-Teukolsky 1972 (ISCO, photon sphere, circular orbits).
//
// All r-values are in units of M; the horizon is r_h = 2.

import {
    M_METERS, C_SI, LIGHT_YEAR_M, LIGHT_HOUR_M, AU_M,
    R_HORIZON_GEOM, R_PHOTON_SPHERE, B_CRIT_GEOM,
    TON618_MASS_SOLAR, M_SUN_KG, G_SI,
} from './units.js';

export const R_ISCO_GEOM = 6.0;          // ISCO radius for Schwarzschild (M = 1)
export const R_MARGINAL_BOUND = 4.0;     // marginally bound circular orbit
export const SURFACE_GRAVITY = 1.0 / (4.0 * R_HORIZON_GEOM / 2.0); // kappa = 1/(4M) in geometrized

// ---------------------------------------------------------------------------
// Kerr diagnostics (Boyer-Lindquist landmarks).
// ---------------------------------------------------------------------------
// All formulas in geometrized units, M = 1, |a| ∈ [0, 1).
// Returns the outer/inner horizon r_± = M ± √(M² − a²).
export function kerrHorizons(a) {
    const aa = Math.min(Math.abs(a), 0.999999);
    const root = Math.sqrt(Math.max(1.0 - aa * aa, 0));
    return { r_plus: 1.0 + root, r_minus: 1.0 - root };
}

// Static-limit / ergosphere outer surface: r_ergo(θ) = M + √(M² − a²cos²θ).
// At the equator θ = π/2 it sits at 2M (same as Schwarzschild horizon).
// At the poles it touches r_+.
export function kerrErgosphere(a, theta = Math.PI / 2) {
    const aa = Math.min(Math.abs(a), 0.999999);
    const c = Math.cos(theta);
    return 1.0 + Math.sqrt(Math.max(1.0 - aa * aa * c * c, 0));
}

// Bardeen-Press-Teukolsky 1972 ISCO for a Kerr black hole.
// prograde sign = +1 (corotating), retrograde sign = −1.
//   Z1 = 1 + (1 − a²)^(1/3) [(1 + a)^(1/3) + (1 − a)^(1/3)]
//   Z2 = √(3 a² + Z1²)
//   r_isco = 3 + Z2 ∓ √[(3 − Z1)(3 + Z1 + 2 Z2)]
export function kerrIsco(a, sign = +1) {
    const aa = Math.max(-0.999999, Math.min(0.999999, a));
    const cube = (x) => Math.cbrt(x);
    const Z1 = 1 + cube(1 - aa * aa) * (cube(1 + aa) + cube(1 - aa));
    const Z2 = Math.sqrt(3 * aa * aa + Z1 * Z1);
    const inner = (3 - Z1) * (3 + Z1 + 2 * Z2);
    if (inner < 0) return 1.0;     // shouldn't happen for |a| < 1
    return 3 + Z2 - sign * Math.sqrt(inner);
}

// Photon sphere radii (equatorial circular photon orbits) — prograde/retrograde.
// Bardeen 1972: r_ph = 2M{1 + cos[(2/3) arccos(∓a/M)]}.
export function kerrPhotonSphere(a, sign = +1) {
    const aa = Math.max(-0.999999, Math.min(0.999999, a));
    return 2 * (1 + Math.cos((2 / 3) * Math.acos(-sign * aa)));
}

// Marginally bound radius (parabolic capture from infinity):
//   r_mb = 2M − a + 2√(M(M − a))   for prograde; +a, M+a for retrograde.
export function kerrMarginallyBound(a, sign = +1) {
    const aa = Math.max(-0.999999, Math.min(0.999999, a));
    return 2 - sign * aa + 2 * Math.sqrt(Math.max(1 - sign * aa, 0));
}

// Specific energy of a circular Keplerian orbit at r (Bardeen-Press-Teukolsky):
//   E/m = (r² − 2Mr ± a √(Mr)) / (r √(r² − 3Mr ± 2a√(Mr)))
// Returns null if the orbit is not stable (denom imaginary).
export function kerrCircularEnergy(r, a, sign = +1) {
    const sqrtMr = Math.sqrt(r);
    const denom2 = r * r - 3 * r + sign * 2 * a * sqrtMr;
    if (denom2 <= 0 || r <= 0) return null;
    const num = r * r - 2 * r + sign * a * sqrtMr;
    return num / (r * Math.sqrt(denom2));
}

// Novikov-Thorne radiative efficiency η = 1 − E_isco / m c² for Kerr.
// At a = 0 → 0.0572 (Schwarzschild). At a → 1 prograde → 0.4226 (max).
// Retrograde tops out at ~0.038 because ISCO recedes to 9M.
export function kerrEfficiency(a, sign = +1) {
    const r_isco = kerrIsco(a, sign);
    const E = kerrCircularEnergy(r_isco, a, sign);
    if (E == null) return novikovThorneEfficiency();
    return 1 - E;
}

// Frame-dragging angular velocity at the outer horizon: Ω_H = a / (r_+² + a²)
// = a / (2 M r_+). Geometric units.
export function kerrHorizonOmega(a) {
    const { r_plus } = kerrHorizons(a);
    const aa = Math.min(Math.abs(a), 0.999999);
    return aa / (2 * r_plus);
}

// Surface gravity κ_K = (r_+ − r_−) / (2(r_+² + a²)) = √(M² − a²) / (2 M r_+).
// Geometric units → 1/M. Reduces to 1/(4M) for a=0.
export function kerrSurfaceGravity(a) {
    const aa = Math.min(Math.abs(a), 0.999999);
    const { r_plus, r_minus } = kerrHorizons(aa);
    return (r_plus - r_minus) / (2 * (r_plus * r_plus + aa * aa));
}

// Horizon area (Kerr): A = 8π M (M + √(M² − a²)) = 8π M r_+.
// Geometric (M = 1): A = 8π r_+. Returns SI m² when scaled by M_METERS².
export function kerrHorizonAreaM2() {
    return 16 * Math.PI * M_METERS * M_METERS;   // overridden below for spin-aware version
}

// Spin-aware horizon area in m². For a = 0 returns 16π M².
export function kerrHorizonAreaSI(a) {
    const { r_plus } = kerrHorizons(a);
    return 8 * Math.PI * r_plus * M_METERS * M_METERS;
}

// Hawking temperature for a Kerr BH: T_H = (ℏ κ) / (2π k_B c) with κ above.
// At a = 0 reduces to ℏ c³ / (8π G M k_B). Returns Kelvin.
export function kerrHawkingTemperatureK(a) {
    const kappa_geom = kerrSurfaceGravity(a);                        // 1/M
    const kappa_SI   = kappa_geom * (C_SI * C_SI) / M_METERS;        // 1/s
    return (HBAR * kappa_SI) / (2 * Math.PI * KBOLTZ);
}

// Bekenstein-Hawking entropy / k_B for Kerr (in nats, dimensionless).
export function kerrEntropyOverK(a) {
    const A = kerrHorizonAreaSI(a);
    return A / (4.0 * PLANCK_LENGTH * PLANCK_LENGTH);
}
// Hawking temperature (Schwarzschild): T_H = hbar c^3 / (8 pi G M k_B). In geometrized
// units the dimensionful constant is folded in once we plug TON 618's mass below.
const HBAR     = 1.054571817e-34;
const KBOLTZ   = 1.380649e-23;
const M_KG     = TON618_MASS_SOLAR * M_SUN_KG;

// ---------------------------------------------------------------------------
// Stationary (static) observer at radius r > 2M.
// ---------------------------------------------------------------------------
// Time dilation: dt/dτ = 1/sqrt(1 - 2M/r). Diverges at the horizon.
export function lapse(r) {
    const f = 1 - 2 / r;
    if (f <= 0) return Infinity;
    return 1 / Math.sqrt(f);
}

// Proper acceleration of a static observer (radially outward, magnitude only).
// In geometric units: a_static = M / (r^2 sqrt(1 - 2M/r)).
export function staticProperAcceleration(r) {
    const f = 1 - 2 / r;
    if (f <= 0) return Infinity;
    return 1.0 / (r * r * Math.sqrt(f));
}

// Tidal acceleration per unit length (radial component, geometric units):
// (Δa/L)_r = 2M/r^3. Tangential is half this with opposite sign.
export function tidalAcceleration(r) {
    return {
        radial:     2.0 / (r * r * r),
        tangential: -1.0 / (r * r * r),
    };
}

// ---------------------------------------------------------------------------
// Circular timelike geodesics (Keplerian).
// ---------------------------------------------------------------------------
// Coordinate angular velocity Omega = sqrt(M / r^3). Same form as Newton.
export function keplerOmega(r) { return Math.sqrt(1.0 / (r * r * r)); }

// Orbital velocity measured by a local static observer:
// v_phi^(local) = r sin theta * Omega / sqrt(1 - 2M/r), but at the equator
// the practical expression is v = sqrt(M/(r-2M)).
export function circularLocalVelocity(r) {
    if (r <= 2.0) return Infinity;
    return Math.sqrt(1.0 / (r - 2.0));
}

// Lorentz factor of circular orbit relative to local static observer:
// gamma_orb = (1 - 3M/r)^(-1/2)  for r > 3M.
export function orbitalGamma(r) {
    const fac = 1.0 - 3.0 / r;
    if (fac <= 0) return Infinity;
    return 1.0 / Math.sqrt(fac);
}

// Orbital period in coordinate time (same as proper time at infinity):
// T = 2 pi sqrt(r^3 / M). Returns geometric units.
export function orbitalPeriod(r) {
    return 2.0 * Math.PI * Math.sqrt(r * r * r);
}

// ---------------------------------------------------------------------------
// Photon physics
// ---------------------------------------------------------------------------
// Frequency-shift factor for a photon emitted at r_emit, received at r_recv,
// both observers static. g = sqrt((1 - 2M/r_recv)/(1 - 2M/r_emit)).
export function gravRedshiftFactor(r_emit, r_recv) {
    const f_e = 1 - 2 / r_emit;
    const f_r = 1 - 2 / r_recv;
    if (f_e <= 0 || f_r <= 0) return null;
    return Math.sqrt(f_r / f_e);
}

// Tortoise coordinate r* = r + 2M ln(r/2M − 1). Pulls the horizon out to
// −∞ in the (t, r*) plane, in which radial null geodesics are 45° lines.
// Useful as a "true distance" measure for radial light propagation.
export function tortoise(r) {
    if (r <= 2.0) return -Infinity;
    return r + 2.0 * Math.log(r / 2.0 - 1.0);
}

// Flamm's paraboloid: equatorial t = const slice embedded in 3-D Euclidean
// space has z(r) = sqrt(8M(r − 2M)). The depth of this funnel below the
// asymptotic plane is the visualisation of "how curved" space is at the
// camera location.
export function flammEmbedding(r) {
    if (r <= 2.0) return 0;
    return Math.sqrt(8.0 * (r - 2.0));
}

// Light-bending angle for a photon at impact parameter b far from the hole.
// Weak-field (Einstein) result Δφ = 4M/b is exact at first order in M/b;
// Bozza's strong-deflection expansion takes over for b near b_crit but for
// HUD purposes we just present the lowest-order value.
export function deflectionAngle(b) {
    if (b <= 0) return Infinity;
    return 4.0 / b;        // radians
}

// Black-hole thermodynamics for the host TON 618.
//   horizon area A = 16 π M^2     (geometric units)
//   Bekenstein-Hawking entropy S_BH = A c^3 / (4 G ℏ k_B)
//                                   = (k_B / 4) (A / ℓ_p^2)
const PLANCK_LENGTH = Math.sqrt(HBAR * G_SI / Math.pow(C_SI, 3));     // m
export function horizonArea() {
    // 16 π M^2 in geometric M; convert to m^2 with M_meters^2.
    return 16 * Math.PI * M_METERS * M_METERS;                          // m^2
}
export function bekensteinEntropyOverK() {
    // S/k_B = A / (4 ℓ_p^2). Returns a dimensionless count of bits-ish.
    return horizonArea() / (4.0 * PLANCK_LENGTH * PLANCK_LENGTH);
}

// ---------------------------------------------------------------------------
// Accretion-disk luminosity / Eddington diagnostics.
// ---------------------------------------------------------------------------
// Eddington luminosity L_Edd = 4 π G M m_p c / σ_T  (radiation-pressure cap
// for fully ionised hydrogen). Returns watts.
const M_PROTON = 1.67262192e-27;          // kg
const SIGMA_T  = 6.6524587321e-29;        // m^2 (Thomson cross-section)
export function eddingtonLuminosityW() {
    return (4.0 * Math.PI * G_SI * M_KG * M_PROTON * C_SI) / SIGMA_T;
}

// ṁ_Edd, the accretion rate that yields L = L_Edd at efficiency η:
//   ṁ_Edd = L_Edd / (η c²)
// Schwarzschild Novikov-Thorne efficiency (ISCO at r = 6M):
//   η = 1 − √(8/9) ≈ 0.0572
export function novikovThorneEfficiency(r_isco_M = R_ISCO_GEOM) {
    // Generalised: η = 1 − E_ISCO / m c²  with
    //   E_ISCO = (1 − 2/r_isco) / √(1 − 3/r_isco)   for prograde Schwarzschild
    const r = r_isco_M;
    if (r <= 3) return null;                // unphysical
    const E_isco = (1 - 2 / r) / Math.sqrt(1 - 3 / r);
    return 1 - E_isco;
}

export function eddingtonAccretionRateKgPerSec(eta) {
    return eddingtonLuminosityW() / (eta * C_SI * C_SI);
}

// Convert kg/s → solar masses per year.
const SECONDS_PER_YEAR = 3600 * 24 * 365.25;
export function kgPerSecToSolarPerYear(rate_kgs) {
    return rate_kgs * SECONDS_PER_YEAR / M_SUN_KG;
}

// Bundle disk diagnostics for a chosen ṁ relative to Eddington.
// mdot_rel ∈ [0, ∞): 1.0 = Eddington-limited, 0.1 = typical AGN, 0.01 = LLAGN
// (the regime where translucent / RIAF disks live).
export function diskDiagnostics(mdot_rel = 0.10, r_isco_M = R_ISCO_GEOM) {
    const eta = novikovThorneEfficiency(r_isco_M) ?? 0.057;
    const L_edd = eddingtonLuminosityW();
    const mdot_edd_kgs = eddingtonAccretionRateKgPerSec(eta);
    const mdot_kgs = mdot_rel * mdot_edd_kgs;
    const L_disk = mdot_rel * L_edd;
    return {
        eta,
        L_edd_W:                 L_edd,
        L_edd_solar_lum:         L_edd / 3.828e26,
        L_disk_W:                L_disk,
        L_disk_solar_lum:        L_disk / 3.828e26,
        mdot_edd_solar_per_year: kgPerSecToSolarPerYear(mdot_edd_kgs),
        mdot_solar_per_year:     kgPerSecToSolarPerYear(mdot_kgs),
        mdot_rel,
        r_isco_M,
    };
}

// Coordinate light-travel time r_emit -> r_recv (radial null geodesic, infall
// path, integrated). Closed form: ∫ dr / (1 - 2M/r) = (r2 - r1) + 2M ln |...|.
export function coordinateLightTime(r1, r2) {
    const f = (r) => r + 2.0 * Math.log(Math.abs(r - 2.0));
    return Math.abs(f(r2) - f(r1));
}

// Proper radial distance from r1 to r2 (r1 < r2, both > 2M):
// L_proper = ∫_{r1}^{r2} dr / sqrt(1 - 2M/r). Numeric quadrature; handles
// near-horizon mildly singular endpoint.
export function properRadialDistance(r1, r2) {
    if (r1 < 2.001) r1 = 2.001;
    if (r2 <= r1) return 0;
    const N = 96;
    const h = (r2 - r1) / N;
    let s = 0;
    for (let i = 0; i <= N; ++i) {
        const r = r1 + h * i;
        const f = 1 - 2 / r;
        const w = (i === 0 || i === N) ? 1 : (i % 2 === 0 ? 2 : 4);
        s += w / Math.sqrt(f);
    }
    return s * h / 3.0; // composite Simpson's
}

// ---------------------------------------------------------------------------
// Free-fall observer from rest at infinity (Painlevé-Gullstrand).
// ---------------------------------------------------------------------------
// Local infall speed seen by a static observer: v_PG/c = sqrt(2M/r).
export function freefallLocalSpeed(r) {
    return Math.sqrt(2.0 / r);
}

// Lorentz factor of PG observer relative to static observer at same r.
// gamma_PG = 1/sqrt(1 - v^2) = 1/sqrt(1 - 2M/r) — same as static lapse, because
// the PG observer rides through the static frame at exactly the escape speed.
export function freefallGamma(r) {
    return lapse(r);
}

// ---------------------------------------------------------------------------
// Hawking temperature for the host black hole (TON 618 mass).
// ---------------------------------------------------------------------------
// Constant — depends only on M, not on the camera position.
export function hawkingTemperatureK() {
    return (HBAR * Math.pow(C_SI, 3)) / (8.0 * Math.PI * G_SI * M_KG * KBOLTZ);
}

// ---------------------------------------------------------------------------
// Tier 2A — Accretion-flow regime classification (ṁ-driven).
// ---------------------------------------------------------------------------
// Three regimes share the disk renderer; ṁ_rel ≡ Ṁ / Ṁ_Edd selects between
// them with smooth sigmoidal transitions:
//
//   ṁ < 0.01      RIAF / ADAF  (Narayan-Yi 1994). Geometrically thick
//                 (H/r ≈ 0.5), optically thin, ion-electron-decoupled,
//                 hot. Renders as a faint thick torus with bluish
//                 Compton-broadened color rather than a pure blackbody.
//
//   0.01 ≤ ṁ ≤ 0.3  Thin disk (Shakura-Sunyaev 1973 / Novikov-Thorne 1973).
//                 H/r ≈ 0.05, optically thick blackbody. T(r) = the
//                 standard Shakura-Sunyaev profile. Default Phase 0/1
//                 regime.
//
//   ṁ > 0.3       Slim disk (Abramowicz et al. 1988). Inner edge puffs
//                 toward H/r → 1; advection of energy inward "traps"
//                 photons and caps T_eff so the emergent luminosity
//                 saturates at a few × L_Edd despite super-Eddington Ṁ.
//
// The function returns a single bundle that drives the shader's H(r)
// profile, T-scaling, brightness multiplier, regime index (for color
// branching in disk_emission), and a human-readable label for the HUD.
const REGIME_RIAF = 0;
const REGIME_THIN = 1;
const REGIME_SLIM = 2;

export function diskRegime(mdot_rel) {
    const m = Math.max(1e-5, mdot_rel || 0);
    let regimeIdx, hOverR, T_factor, brightness_factor, regime;
    if (m < 0.01) {
        // ── RIAF / ADAF ─────────────────────────────────────────────
        regimeIdx = REGIME_RIAF;
        // H/r grows toward 0.5 as cooling becomes inefficient. Soft
        // saturation around ṁ ~ 1e-4 (deep ADAF) at H/r = 0.5.
        hOverR = 0.50 - 0.10 * Math.tanh(Math.log10(m / 1e-4) * 0.6);
        T_factor = 0.85;                            // dim and harder spectrum
        brightness_factor = Math.max(0.05, m / 0.01);
        regime = 'RIAF / ADAF (Narayan-Yi)';
    } else if (m < 0.3) {
        // ── Thin disk (standard Shakura-Sunyaev / Novikov-Thorne) ───
        regimeIdx = REGIME_THIN;
        // H/r mild growth with ṁ; ~0.05 at typical AGN, ~0.10 toward
        // sub-Eddington upper edge. Smooth log-linear interp.
        const t = Math.log10(m / 0.01) / Math.log10(30);
        hOverR = 0.04 + 0.08 * t;
        T_factor = 1.0;
        brightness_factor = 1.0;
        regime = 'thin disk (Shakura-Sunyaev / Novikov-Thorne)';
    } else {
        // ── Slim disk (Abramowicz, super-Eddington) ─────────────────
        regimeIdx = REGIME_SLIM;
        // Geometric puff at inner edge; H/r → 1 as ṁ → ∞.
        hOverR = 0.18 + 0.55 * Math.tanh(Math.log10(m / 0.3));
        // Photon-trapping factor: the deeper into super-Eddington we go,
        // the more energy gets advected onto the BH instead of radiated.
        // L_disk saturates at a few × L_Edd; T_eff drops correspondingly.
        T_factor = 1.0 / Math.pow(1.0 + (m - 0.3) / 1.0, 0.25);
        brightness_factor = Math.min(3.5, 1.0 + 0.6 * Math.log(m / 0.3));
        regime = 'slim disk (Abramowicz, advection-dominated)';
    }
    return {
        regimeIdx,
        hOverR,
        T_factor,
        brightness_factor,
        regime,
    };
}

// ---------------------------------------------------------------------------
// Tier 2B — Blandford-Znajek jet power + MAD state.
// ---------------------------------------------------------------------------
// The 1977 Blandford-Znajek mechanism extracts rotational energy from a
// spinning BH through magnetic field lines threading the horizon. Power
// scales as
//     P_BZ ∝ Φ_H² Ω_H² ∝ Φ_H² · a²/(2r₊)²
// where Φ_H is the magnetic flux on the horizon and Ω_H = a/(2 M r₊) is
// the horizon angular velocity. As accretion piles up flux on the
// horizon, the disk eventually transitions into a "magnetically
// arrested" (MAD) state in which Φ_H saturates at Φ_MAD ≈ 50 √(Ṁ M).
//
// Tchekhovskoy, Narayan, McKinney 2011 measured the dimensionless
// efficiency η = L_jet / Ṁc² in MAD GRMHD simulations:
//     η_MAD(a) ≈ 1.3 a² + 0.6 a⁴
// which can exceed 1 — meaning more energy comes out as jet than was
// fed in as accretion (the difference is mined from the BH's rotational
// kinetic energy). Below MAD the disk is "SANE" (Standard And Normal
// Evolution) and η scales as ~ (Φ/Φ_MAD)² η_MAD.
//
// `magnetization` is the user's slider: φ = Φ / Φ_MAD ∈ [0, 1.5].
//   φ < 1     SANE regime, jet building up.
//   φ = 1     MAD threshold.
//   φ > 1     "super-MAD" with mild jet over-saturation.

export function bzEfficiency(spin, magnetization) {
    const a   = Math.max(0, Math.min(0.999, spin || 0));
    const phi = Math.max(0, magnetization || 0);
    const eta_MAD = 1.3 * a * a + 0.6 * Math.pow(a, 4);
    const isMAD = phi >= 1.0;
    let eta;
    if (isMAD) {
        // Plateau at η_MAD with mild over-saturation when φ > 1 ("super-MAD").
        const overshoot = Math.min(0.4, (phi - 1.0) * 0.5);
        eta = eta_MAD * (1.0 + overshoot);
    } else {
        // SANE: efficiency rises like φ² as flux accumulates toward MAD.
        eta = phi * phi * eta_MAD;
    }
    return {
        a,
        phi,
        eta,                                // total jet η = L_jet / Ṁc²
        eta_MAD,                            // saturation value at given a
        isMAD,
        omega_H: a / (2.0 * (1.0 + Math.sqrt(Math.max(1 - a * a, 0)))),
        // Disk dimming when MAD: the magnetosphere extracts energy that
        // would otherwise heat the inner accretion flow, so the disk
        // visibly fades. McKinney+ 2012, Tchekhovskoy+ 2014.
        disk_mad_dim: isMAD ? (0.55 + 0.10 / Math.max(phi, 1.0)) : 1.0,
    };
}

// ---------------------------------------------------------------------------
// Phase 2.1 — Lyman-α blob diagnostics.
// ---------------------------------------------------------------------------
// Compute observable quantities from the user's LAB parameters so the HUD
// can report L_Lyα, half-light radius, central optical depth, escape
// fraction, and the asymptotic Doppler peak displacement. None of this
// runs in the shader; the shader does the actual rendering, this just
// lets the user see what they've dialed in.
//
// References:
//   Cantalupo et al. 2014       — Slug nebula discovery / luminosity
//   Steidel et al. 2000         — Lyman-α blobs at z ~ 3
//   Neufeld 1990, Bonilha 1979  — resonance-line escape / peak displacement
//   Cantalupo et al. 2008       — fluorescent Lyα in cooling halos

const LAB_VOIGT_a0    = 4.7e-4;     // Voigt parameter at T = 10⁴ K
const LAB_LYA_REST_NM = 121.567;    // Lyα rest-frame wavelength

// Half-light radius for the LAB density profile ρ ∝ (r_in/r)^α (with the
// soft outer cutoff already baked in). Cooling-mechanism luminosity goes
// as ρ², photoionization as ρ/r², shock as ρ²·|∇ρ|. For HUD purposes we
// use a closed-form for cooling (it dominates when fully ionized) and
// numerically integrate to find the half-light radius.
function _labLumDensity(r, params) {
    const { rInner, rOuter, alpha, mechanism } = params;
    if (r < rInner || r > rOuter * 1.2) return 0;
    const rho = Math.pow(rInner / Math.max(r, 1e-3), alpha);
    const taper = 1 - Math.max(0, Math.min(1, (r - rOuter * 0.7) / (rOuter * 0.3)));
    const rhoT = rho * taper;
    if (mechanism === 1) return rhoT * (rInner * rInner) / Math.max(r * r, 1);   // photoionization
    if (mechanism === 2) return rhoT * rhoT * 0.6;                                // shock proxy
    return rhoT * rhoT;                                                            // cooling
}

export function labDiagnostics(labState) {
    const {
        intensity, radiusKpc, innerKpc, alpha, clump, filament,
        mechanism, z, outflowKms, outflowBeta,
        logNHI, tempK, neufeld,
    } = labState;

    // Observer-frame line center (Doppler-shifted by cosmology).
    const lambda_obs_nm = LAB_LYA_REST_NM * (1 + z);

    // Voigt parameter at user gas temperature.
    const a_voigt = LAB_VOIGT_a0 * Math.sqrt(1e4 / Math.max(tempK, 1e3));
    // Line-center optical depth from central column density (σ₀ ≈ 5.9e-14 cm² · √(10⁴/T)).
    const sigma_0  = 5.9e-14 * Math.sqrt(1e4 / Math.max(tempK, 1e3));
    const N_HI_cen = Math.pow(10, logNHI);
    const tau0_cen = N_HI_cen * sigma_0;
    // Neufeld escape probability at the central column.
    const aTau3       = Math.pow(a_voigt * tau0_cen, 1 / 3);
    const P_esc_pure  = 1 / (1 + 1.8 * aTau3);
    const P_esc_cen   = 1 + (P_esc_pure - 1) * neufeld;     // user-blended
    // Neufeld peak Doppler displacement Δν_peak ≈ 0.92 (a τ₀)^{1/3} Doppler widths.
    // Convert to km/s: Δv = c · Δν/ν₀ · √(2 k_B T / m_p) / c. Doppler width
    // v_th ≈ 12.85 √(T/10⁴) km/s for hydrogen.
    const v_th_kms   = 12.85 * Math.sqrt(Math.max(tempK, 1e3) / 1e4);
    const peak_kms   = 0.92 * aTau3 * v_th_kms;             // each peak from line center

    // Numerically integrate luminosity ∝ ∫ j(r) 4π r² dr (in arbitrary units —
    // intensity slider absorbs the absolute calibration).
    const params = { rInner: innerKpc, rOuter: radiusKpc, alpha, mechanism };
    const N = 120;
    const lr0 = Math.log(innerKpc);
    const lr1 = Math.log(radiusKpc * 1.05);
    let totalL = 0;
    const cumulative = new Float64Array(N + 1);
    const radii = new Float64Array(N + 1);
    for (let i = 0; i <= N; ++i) {
        const u = i / N;
        const r = Math.exp(lr0 + (lr1 - lr0) * u);
        const j = _labLumDensity(r, params);
        const dV = 4 * Math.PI * r * r * (r - (i > 0 ? Math.exp(lr0 + (lr1 - lr0) * (i - 1) / N) : 0));
        totalL += j * dV * P_esc_cen;       // P_esc applied uniformly (proxy)
        cumulative[i] = totalL;
        radii[i] = r;
    }
    // Half-light radius.
    const half = totalL / 2;
    let R_half_kpc = radiusKpc * 0.5;
    for (let i = 1; i <= N; ++i) {
        if (cumulative[i] >= half) {
            const f = (half - cumulative[i - 1]) / Math.max(cumulative[i] - cumulative[i - 1], 1e-9);
            R_half_kpc = radii[i - 1] + f * (radii[i] - radii[i - 1]);
            break;
        }
    }

    // Calibrate to a Slug-class luminosity. The user's "intensity" slider
    // multiplies a reference 10⁴⁴ erg/s anchor; the dimensionless integral
    // value is normalized to that reference at the default settings.
    // Reference integral value at defaults (Slug-class) ≈ ~8e2 in our units.
    const L_ref_erg_s   = 1.0e44;
    const integral_ref  = 8.0e2;     // empirical at defaults; user can re-calibrate
    const L_Lya_erg_s   = intensity * (totalL / integral_ref) * L_ref_erg_s;

    // (1+z)⁻⁴ surface-brightness dimming for context.
    const SB_dim = Math.pow(1 + z, -4);

    return {
        lambda_obs_nm,
        a_voigt,
        N_HI_central:        N_HI_cen,
        tau0_central:        tau0_cen,
        P_esc_central:       P_esc_cen,
        peak_displacement_kms: peak_kms,
        v_thermal_kms:       v_th_kms,
        R_half_kpc,
        L_Lya_erg_s,
        SB_dim_factor:       SB_dim,
        outflow_at_rLAB:     outflowKms,
    };
}

// ---------------------------------------------------------------------------
// Convenience: bundle everything for the HUD at a given observer state.
// ---------------------------------------------------------------------------
// `spin` ∈ [0, 0.999) is treated as a *diagnostic* quantity: the geodesic
// kernel currently runs Schwarzschild, but landmark radii (ISCO, ergosphere,
// r_+) and thermodynamics (T_H, A, η_NT) update so the HUD tells the truth
// about the rotating geometry the user is dialing in.
export function diagnostics(cam, mdot_rel = 0.10, spin = 0.0) {
    const r = cam.r;
    const f = Math.max(1 - 2 / r, 0);
    const td = lapse(r);
    const tidal = tidalAcceleration(r);
    const v_orb = circularLocalVelocity(r);
    const period_geom = orbitalPeriod(r);

    // Convert orbital period to seconds: time unit T = M_geom / c = M_meters / c.
    const T_sec_per_M = M_METERS / C_SI;
    const period_seconds = period_geom * T_sec_per_M;
    const period_years = period_seconds / (3600 * 24 * 365.25);


    // Convert tidal accel: 1/M^2 in geometric -> SI via c^4 / (G M)^2
    const tidal_SI_factor = Math.pow(C_SI, 4) / (G_SI * M_KG) / (G_SI * M_KG); // 1/(time^2 * length) in SI form
    // Easier: a_geom is dimensionless per-length-per-length in M units; convert directly:
    //   a_SI [1/s^2] = a_geom * c^2 / M_meters^2 * M_meters = a_geom * c^2 / M_meters.
    // Actually tidal "Δa/L" has units 1/time^2; geometric form is per-M^2 in length.
    //   (Δa/L)_SI = (Δa/L)_geom * c^2 / M_meters^2.
    const tidal_per_s2 = tidal.radial * (C_SI * C_SI) / (M_METERS * M_METERS);

    // Static proper acceleration in SI (m/s^2):
    //   a_SI = a_geom * c^2 / M_meters.
    const a_SI = staticProperAcceleration(r) * (C_SI * C_SI) / M_METERS;

    // Proper distance to horizon (geometric, in M).
    const d_proper_to_horizon = (r > 2.001) ? properRadialDistance(2.001, r) : 0;
    // Coordinate light travel time from horizon to here (geometric M units → seconds).
    const t_light_geom = coordinateLightTime(2.001, r);
    const t_light_seconds = t_light_geom * T_sec_per_M;

    // Radial-distance / embedding diagnostics.
    const r_star_geom        = tortoise(r);
    const z_flamm_geom       = flammEmbedding(r);
    // Asymptotic deflection of a photon grazing the camera at the FOV edge.
    // b ≈ r * tan(fov/2) for a static observer at large r.
    const b_edge = (cam.fovY != null) ? r * Math.tan(0.5 * cam.fovY) : r;
    const defl_rad           = deflectionAngle(b_edge);

    // ── Kerr landmarks (diagnostic only — render is Schwarzschild) ───
    const aSpin = Math.max(0, Math.min(0.999, spin || 0));
    const { r_plus, r_minus }   = kerrHorizons(aSpin);
    const r_isco_pro            = kerrIsco(aSpin, +1);
    const r_isco_retro          = kerrIsco(aSpin, -1);
    const r_ph_pro              = kerrPhotonSphere(aSpin, +1);
    const r_ph_retro            = kerrPhotonSphere(aSpin, -1);
    const r_ergo_eq             = kerrErgosphere(aSpin, Math.PI / 2);
    const eta_kerr_pro          = kerrEfficiency(aSpin, +1);
    const Omega_H               = kerrHorizonOmega(aSpin);

    // Black-hole thermodynamics. Use Kerr formulas — they reduce to
    // Schwarzschild values continuously at a = 0.
    const A_horizon_m2       = kerrHorizonAreaSI(aSpin);
    const S_over_k           = kerrEntropyOverK(aSpin);
    const T_H_kerr           = kerrHawkingTemperatureK(aSpin);

    // Accretion luminosity / Eddington fraction. Use spin-aware ISCO so the
    // Novikov-Thorne efficiency η(a) drives the disk-luminosity HUD.
    const disk_d             = diskDiagnostics(mdot_rel, r_isco_pro);

    return {
        // fundamentals
        r_M:           r,
        r_rs:          r / 2.0,
        f,                                         // metric coefficient 1 - 2M/r
        valid_static:  r > 2.0,

        // radial-distance math
        r_star_geom:                  r_star_geom,
        z_flamm_geom:                 z_flamm_geom,
        proper_circumference_geom:    2 * Math.PI * r,
        deflection_angle_rad_at_fov:  defl_rad,

        // global thermodynamics
        horizon_area_m2:              A_horizon_m2,
        bekenstein_entropy_over_k:    S_over_k,

        // disk luminosity (parameter-driven; not a function of camera)
        disk_efficiency:              disk_d.eta,
        eddington_W:                  disk_d.L_edd_W,
        eddington_solar_lum:          disk_d.L_edd_solar_lum,
        disk_lum_W:                   disk_d.L_disk_W,
        disk_lum_solar_lum:           disk_d.L_disk_solar_lum,
        mdot_solar_per_year:          disk_d.mdot_solar_per_year,
        mdot_edd_solar_per_year:      disk_d.mdot_edd_solar_per_year,
        mdot_rel:                     disk_d.mdot_rel,

        // observer kinematics
        gamma_static:  td,                          // static-observer time dilation
        a_static_geom: staticProperAcceleration(r),
        a_static_SI:   a_SI,

        // free-fall observer
        v_freefall:        freefallLocalSpeed(r),     // c units
        gamma_freefall:    freefallGamma(r),

        // circular orbit (prograde Keplerian)
        v_orbital:     v_orb,                         // c units
        gamma_orbit:   orbitalGamma(r),
        omega_orbit:   keplerOmega(r),
        period_orbit_geom:    period_geom,
        period_orbit_seconds: period_seconds,
        period_orbit_years:   period_years,

        // tides
        tidal_radial_geom:     tidal.radial,
        tidal_tangential_geom: tidal.tangential,
        tidal_radial_per_s2:   tidal_per_s2,

        // distances & travel times
        proper_distance_to_horizon_geom: d_proper_to_horizon,
        light_time_to_horizon_seconds:   t_light_seconds,

        // landmark radii (Schwarzschild constants — what the renderer
        // actually integrates against — kept first so the HUD lines up with
        // the visible geometry)
        r_horizon:     R_HORIZON_GEOM,
        r_photon:      R_PHOTON_SPHERE,
        r_isco:        R_ISCO_GEOM,
        b_crit:        B_CRIT_GEOM,

        // ── Reference clock: ISCO orbit period at the user's spin (used by
        //    the time scrubber to anchor "1 sim-second ≈ N days" labels).
        //    Schwarzschild Kepler period in geometric units is 2π r^(3/2);
        //    Kerr prograde adds an a√r term to the denominator → use the
        //    full BPT formula for fidelity.
        isco_period_seconds: 2.0 * Math.PI * (Math.pow(r_isco_pro, 1.5) + aSpin) * T_sec_per_M,
        isco_period_years:  (2.0 * Math.PI * (Math.pow(r_isco_pro, 1.5) + aSpin) * T_sec_per_M) / (3600 * 24 * 365.25),
        sim_seconds_per_M:  T_sec_per_M,

        // ── Kerr-derived diagnostics (drive HUD when spin > 0) ──
        spin:          aSpin,
        r_plus_kerr:        r_plus,
        r_minus_kerr:       r_minus,
        r_isco_kerr_pro:    r_isco_pro,
        r_isco_kerr_retro:  r_isco_retro,
        r_photon_kerr_pro:  r_ph_pro,
        r_photon_kerr_retro: r_ph_retro,
        r_ergo_eq_kerr:     r_ergo_eq,
        eta_kerr_pro:       eta_kerr_pro,
        omega_horizon_kerr: Omega_H,
        T_hawking_kerr_K:   T_H_kerr,

        // global thermodynamics (Kerr-corrected; reduces to Schwarzschild at a=0)
        T_hawking_K:   T_H_kerr,
    };
}
