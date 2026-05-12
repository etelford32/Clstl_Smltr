/**
 * upper-atmosphere-parker-wind.js — Parker (1958) transonic wind
 * applied to Earth's exosphere
 * ═══════════════════════════════════════════════════════════════════════════
 * Parker's hydrodynamic stellar-wind solution describes how a hot
 * gravitationally-bound atmosphere transitions from a subsonic regime
 * near the surface to a supersonic outflow at large radius. The
 * crossover happens at the *critical radius*
 *
 *     r_c = G M / (2 a²)
 *
 * where a² = k T / m is the isothermal sound speed squared for the
 * dominant species (single-fluid form). The transonic solution is the
 * unique branch of the dimensionless equation
 *
 *     W − ln W = 4 ln ξ + 4/ξ − 3,    ξ = r/r_c, W = (V/a)²
 *
 * that passes smoothly through (ξ=1, W=1).
 *
 * Solar physics applies this to the corona (T ~ 1–2 MK) and gets r_c
 * a few solar radii out, with V ~ 400 km/s by 1 AU. For *Earth's*
 * exosphere the same equation governs hydrodynamic escape of light
 * species (H, He) when T∞ is high enough that the critical point sits
 * inside or near the simulation ceiling. At T∞ ≈ 1500 K:
 *
 *     a_H = √(kT/m_p) ≈ 3.5 km/s
 *     r_c = GM⊕/(2 a²) ≈ 1.6×10⁷ m   →  ~9700 km altitude
 *
 * — i.e. Parker-style hydrodynamic H escape sets in well above the
 * traditional Jeans-escape regime. This module computes:
 *
 *     • criticalRadiusM(species, T)        — Parker r_c for one species
 *     • parkerWindSpeed(altKm, species, T) — V(r) along the transonic branch
 *     • jeansEscapeFlux(species, T, n_exo) — collisionless thermal escape
 *     • effectiveEscapeFlux(...)           — Jeans + Parker hydrodynamic mix
 *
 * Uses the same `_solveParker` Newton iteration as helio-physics.js so
 * the two stay in lock-step on the underlying transonic math.
 *
 * Visualisation contract: `parkerVisualSpeedRunit(...)` returns a
 * world-units-per-second drift magnitude calibrated to read as a
 * coherent outward "wind" without teleporting H out of frame on the
 * first frame. Similar in spirit to VTH_VIS_FACTOR in particles.js.
 */

import { SPECIES_MASS_KG, gravity, batesTemperature, exosphereTempK } from './upper-atmosphere-engine.js';

// ── Physical constants ─────────────────────────────────────────────
const KB        = 1.380_649e-23;     // Boltzmann   (J/K)
const G_M_EARTH = 3.986_004e14;      // GM⊕         (m³/s²)
const R_EARTH_M = 6_371_000;         // mean Earth radius (m)

// Stitch-on factor controlling how close to the critical radius we
// allow the supersonic branch to be evaluated. The Parker LUT goes
// numerically singular right at ξ = 1, so we clamp ξ ≥ 1+ε on the
// supersonic side.
const XI_EPS = 1e-3;

// ── Newton solver for the dimensionless Parker equation ────────────
// Self-contained copy of the helio-physics solver — kept local so
// changes here can't accidentally regress the heliosphere page.
function _solveParkerW(xi) {
    if (xi <= 0) return 0;
    const rhs = 4 * Math.log(Math.max(1e-9, xi)) + 4 / Math.max(1e-9, xi) - 3;
    let W;
    if (xi >= 1.0) {
        W = Math.max(1.5, rhs + 0.5);
        for (let k = 0; k < 60; k++) {
            if (W <= 1.0001) { W = 1.0001; break; }
            const dW = (W - Math.log(W) - rhs) / (1 - 1 / W);
            W = Math.max(1.0001, W - dW);
            if (Math.abs(dW) < 1e-10) break;
        }
    } else {
        if (rhs > 300) return 0.001;
        W = Math.max(0.001, Math.min(0.9999, Math.exp(-rhs)));
        for (let k = 0; k < 60; k++) {
            const dW = (W - Math.log(W) - rhs) / (1 - 1 / W);
            W = Math.max(0.001, Math.min(0.9999, W - dW));
            if (Math.abs(dW) < 1e-10) break;
        }
    }
    return Math.sqrt(Math.max(0, W));
}

/**
 * Isothermal sound speed for a single species (m/s).
 *
 *   a = √(k T / m)
 */
export function soundSpeedMs(species, T) {
    const m = SPECIES_MASS_KG[species];
    if (!m || !(T > 0)) return 0;
    return Math.sqrt(KB * T / m);
}

/**
 * Parker critical radius for one species (m, measured from Earth
 * centre).  At T = T(z) and m = m_species,
 *
 *   r_c = G M⊕ / (2 a²) = G M⊕ m / (2 k T)
 *
 * For atomic H at T = 1500 K: r_c ≈ 1.6×10⁷ m (~9700 km altitude).
 * For atomic O at T = 1500 K: r_c ≈ 2.6×10¹¹ m — so much larger than
 * Earth's exosphere that O is fully bound (no Parker wind for O).
 */
export function criticalRadiusM(species, T) {
    const a2 = (KB * T) / SPECIES_MASS_KG[species];
    if (!(a2 > 0)) return Infinity;
    return G_M_EARTH / (2 * a2);
}

/**
 * Parker wind speed (m/s) at altitude for one species, on the
 * transonic branch. Returns 0 below the species' subsonic floor where
 * the wind is negligible vs. thermal motion.
 *
 * For altitudes inside r_c we're on the subsonic branch (V < a); for
 * altitudes above r_c we're supersonic. The visualisation cares
 * mostly about the supersonic regime since that's the regime where
 * the wind is a coherent outward flow.
 */
export function parkerWindSpeed(altKm, species, T) {
    if (!(T > 0)) return 0;
    const r   = R_EARTH_M + altKm * 1000;
    const a   = soundSpeedMs(species, T);
    const r_c = criticalRadiusM(species, T);
    if (!(a > 0) || !Number.isFinite(r_c)) return 0;

    let xi = r / r_c;
    if (Math.abs(xi - 1) < XI_EPS) xi = 1 + XI_EPS;
    const W_ratio = _solveParkerW(xi);   // V/a
    return W_ratio * a;
}

/**
 * Jeans (collisionless thermal) escape flux for one species at the
 * exobase, particles per m² per s.
 *
 *   Φ_J = n_exo · (a / 2√π) · (1 + λ) · exp(−λ)
 *
 * where λ = G M⊕ m / (k T r_exo) is the Jeans escape parameter (the
 * ratio of gravitational PE to thermal KE at the exobase).  λ < 1.5
 * is the "blow-off" regime where Jeans no longer applies and the
 * Parker hydrodynamic wind takes over.
 *
 * @param {string}  species
 * @param {number}  T_K       exobase temperature (K)
 * @param {number}  n_exo     species number density at exobase (m⁻³)
 * @param {number}  altKm     exobase altitude (km), default 500
 */
export function jeansEscapeFlux(species, T_K, n_exo, altKm = 500) {
    const m   = SPECIES_MASS_KG[species];
    if (!m || !(T_K > 0) || !(n_exo > 0)) return 0;
    const a   = soundSpeedMs(species, T_K);                         // m/s
    const r   = R_EARTH_M + altKm * 1000;
    const lam = (G_M_EARTH * m) / (KB * T_K * r);
    return n_exo * (a / (2 * Math.sqrt(Math.PI))) * (1 + lam) * Math.exp(-lam);
}

/**
 * Combined escape flux: Jeans for λ ≳ 1.5 (collisionless thermal),
 * Parker hydrodynamic above (when λ → 1, the Jeans formula
 * underestimates the flux dramatically). Smoothly blends between the
 * two so visualisation reads continuously across thermal regimes.
 *
 * Returns particles per m² per s.
 */
export function effectiveEscapeFlux(species, T_K, n_exo, altKm = 500) {
    const m   = SPECIES_MASS_KG[species];
    if (!m || !(T_K > 0) || !(n_exo > 0)) return 0;
    const r   = R_EARTH_M + altKm * 1000;
    const lam = (G_M_EARTH * m) / (KB * T_K * r);

    const phi_jeans = jeansEscapeFlux(species, T_K, n_exo, altKm);

    // Hydrodynamic Parker outflow flux: n_exo × V_Parker(altKm).
    const v_parker = parkerWindSpeed(altKm, species, T_K);
    const phi_par  = n_exo * v_parker;

    // Blend: λ > 3 → pure Jeans; λ < 1 → pure Parker; smooth in between.
    const w = _smoothstep(1.0, 3.0, lam);
    return w * phi_jeans + (1 - w) * phi_par;
}

function _smoothstep(a, b, x) {
    if (x <= a) return 0;
    if (x >= b) return 1;
    const t = (x - a) / (b - a);
    return t * t * (3 - 2 * t);
}

/**
 * Visualisation-grade Parker wind speed in world units (Earth radii)
 * per simulation second. Compresses the SI velocity so that even a
 * fast hydrodynamic H escape (~5 km/s at high altitude) reads as a
 * coherent drift in a 5–30 second viewing window without teleporting
 * particles past the simulation ceiling.
 *
 * The compression is the same flavour as particles.js's
 * VTH_VIS_FACTOR but a touch more aggressive — wind is a *coherent*
 * advection, so it accumulates to a noticeable displacement even with
 * a small per-frame step. The intent: a 4 km/s outward Parker wind
 * gives the user-visible impression of an outflow rather than thermal
 * jitter.
 *
 * @param {number} altKm
 * @param {string} species   one of SPECIES_MASS_KG keys ("H", "He", …)
 * @param {number} Tinf      exospheric asymptotic temperature (K)
 * @returns {number}         outward speed in R⊕/s, ≥ 0
 */
export function parkerVisualSpeedRunit(altKm, species, Tinf) {
    const T = batesTemperature(altKm, Tinf);
    const v = parkerWindSpeed(altKm, species, T);   // m/s
    if (!(v > 0)) return 0;
    // 1 R⊕ = 6.371e6 m. We compress by 8e4× so 4 km/s reads as ~7.8e-6 R⊕/s ×
    // 60 fps ≈ 5e-4 R⊕/frame — a few % of an exosphere shell per second.
    const VIS_COMPRESSION = 1 / 8e4;
    return v * VIS_COMPRESSION;
}

/**
 * Convenience: the dominant escape species at this T∞. Above T∞ ~ 1200 K,
 * H is in the hydrodynamic regime; below, He's contribution is
 * negligible too — both are just slowly Jeans-escaping. Used by the
 * visualisation to decide whether to draw a "Parker wind" annotation.
 */
export function parkerRegime(Tinf) {
    const r_cH  = criticalRadiusM('H',  Tinf);
    const altKmH = (r_cH - R_EARTH_M) / 1000;
    if (altKmH < 2000)  return 'hydrodynamic';   // critical point inside our band
    if (altKmH < 8000)  return 'transonic';       // critical point in geocorona
    return 'jeans';                                // pure thermal escape regime
}

/**
 * Build a per-altitude profile of Parker-wind speed for both light
 * escape species, useful for plot overlays. Returns arrays in km and
 * m/s; the caller can render them however it likes.
 */
export function parkerProfile({ Tinf, nPoints = 64, minKm = 200, maxKm = 2000 } = {}) {
    const altKm = new Float32Array(nPoints);
    const vH    = new Float32Array(nPoints);
    const vHe   = new Float32Array(nPoints);
    for (let i = 0; i < nPoints; i++) {
        const alt = minKm + (maxKm - minKm) * (i / (nPoints - 1));
        const T   = batesTemperature(alt, Tinf);
        altKm[i] = alt;
        vH[i]    = parkerWindSpeed(alt, 'H',  T);
        vHe[i]   = parkerWindSpeed(alt, 'He', T);
    }
    return {
        Tinf,
        altKm,
        vH_ms:  vH,
        vHe_ms: vHe,
        regime: parkerRegime(Tinf),
        rcH_alt_km: (criticalRadiusM('H',  Tinf) - R_EARTH_M) / 1000,
        rcHe_alt_km: (criticalRadiusM('He', Tinf) - R_EARTH_M) / 1000,
    };
}

/**
 * Dynamic-pressure proxy of the *atmospheric* outflow at the
 * simulation ceiling — analogous to ρv² for the solar wind hitting
 * the magnetopause but flipped: how hard our exospheric Parker wind
 * is pushing against the magnetopause from below. Used to drive the
 * field-cascade animation's intensity.
 *
 * @param {object} state    {f107, ap, n_top, ap}
 * @param {number} altCeil  upper bound of integration (default 2000 km)
 */
export function exosphereDynamicPressure(state, altCeil = 2000) {
    const Tinf = exosphereTempK(state?.f107 ?? 150, state?.ap ?? 15);
    const T    = batesTemperature(altCeil, Tinf);
    const m_H  = SPECIES_MASS_KG.H;
    const v    = parkerWindSpeed(altCeil, 'H', T);   // m/s
    const n    = state?.nH_top ?? 1e10;              // m⁻³ default
    return n * m_H * v * v;
}

// ── Tiny self-test for dev consoles ────────────────────────────────
export function _selfTestParker() {
    const out = [];
    const push = (pass, msg) => out.push({ pass, msg });

    // r_c for H at 1500 K should sit between 5 and 30 Mm altitude.
    const rcH = (criticalRadiusM('H', 1500) - R_EARTH_M) / 1000;
    push(rcH > 5_000 && rcH < 30_000, `r_c[H, 1500K] alt = ${rcH.toFixed(0)} km`);

    // r_c for O should sit far outside our 2000-km simulation ceiling
    // (no Parker wind for O at any realistic thermosphere temperature).
    const rcO = (criticalRadiusM('O', 1500) - R_EARTH_M) / 1000;
    push(rcO > 1e5, `r_c[O, 1500K] alt = ${rcO.toExponential(1)} km (expect > 1e5)`);

    // Parker wind at 2000 km altitude for H at T∞ = 2000 K should be
    // a finite, non-trivial fraction of the sound speed.
    const vH = parkerWindSpeed(2000, 'H', batesTemperature(2000, 2000));
    push(vH > 1e3 && vH < 2e4, `V_H @ 2000 km, T∞=2000K = ${(vH/1e3).toFixed(2)} km/s`);

    return out;
}
