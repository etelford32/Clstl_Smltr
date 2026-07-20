/**
 * ring-current-efield.js — M-I coupling field core (Track 0 of
 * IONOSPHERE_EXPLORATION_PLAN.md)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure functions + one small class: no DOM, no THREE, no fetch.
 * tests/ring-current-efield.mjs runs this exact module under node — keep it
 * dependency-free. Shared from day one: ring-current.html drives it on the
 * SimClock; a future SAPS page imports the same module.
 *
 * ── What is modeled ─────────────────────────────────────────────────────────
 * The inner-magnetosphere convection electric field and its SHIELDING state —
 * the quantity that couples the ring current to the ionosphere:
 *
 *   Φ(L, φ) = −A · L² · sin φ  −  C / L
 *
 * Volland–Stern convection (γ = 2, dawn–dusk symmetric; φ measured from noon,
 * +π/2 at dusk) plus corotation. The driver amplitude A_drv blends the
 * Maynard–Chen Kp parameterization with a VBs scaling (this page is L1-driven
 * and VBs leads Kp by the propagation + index latency), and the APPLIED
 * amplitude A_sh lags it through a first-order shielding ODE:
 *
 *   dA_sh/dt = (A_drv − A_sh) / τ_sh          τ_sh ≈ 25 sim-min
 *
 * The region-2 field-aligned currents that shield the inner magnetosphere
 * take tens of minutes to reconfigure; until they do, the difference
 *
 *   ΔA = A_drv − A_sh
 *
 * penetrates to low latitudes. SIGN CONVENTION (pinned by tests — Track A's
 * fountain coupling depends on it): ΔA > 0 = UNDERSHIELDING (a southward
 * turning just raised the driver; eastward prompt-penetration E-field on the
 * dayside/dusk low-latitude ionosphere — super-fountain). ΔA < 0 =
 * OVERSHIELDING (northward turning; westward, fountain suppression).
 *
 * The last closed equipotential of Φ (through the dusk stagnation point
 * L_s = (C / 2A_sh)^(1/3)) is the cold-plasma capture boundary — the
 * TEARDROP plasmapause with its dusk bulge. The circular Carpenter–Anderson
 * Lpp(Kp) stays as a validation overlay, not the geometry (the two agree
 * within ~0.5 R_E across Kp 1–8 — see tests).
 *
 * ── References ──────────────────────────────────────────────────────────────
 *   Volland (1973) JGR 78 171; Stern (1975) JGR 80 595 — convection potential
 *   Maynard & Chen (1975) JGR 80 1009                  — A(Kp) fit (γ = 2)
 *   Nishida (1968); Kelley et al. (2003)               — penetration E-fields
 *   Senior & Blanc (1984); Peymirat et al. (2000)      — shielding time scale
 *   Carpenter & Anderson (1992) JGR 97 1097            — Lpp(Kp) validation
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Corotation potential constant C (kV): Φ_r = −C/L with
 *  C = B₀·Ω·R_E² = 3.11e−5 T · 7.2921e−5 rad/s · (6.371e6 m)² ≈ 92.4 kV. */
export const COROTATION_KV = 92.4;

/** Shielding reconfiguration time (sim-seconds) — region-2 FAC response,
 *  tens of minutes (Senior & Blanc 1984 give ~20–30 min).
 *
 *  SAPS BRIDGE: the Shielding Lab (shielding-lab.html, rust-shielding/)
 *  solves the same relaxation on the region-2 CURRENT — its
 *  `tau_s_min: 25.0` default (rust-shielding/src/state.rs) deliberately
 *  equals this constant, so the two pages tell one shielding story:
 *  A_drv ↔ I_R1 driving, A_sh ↔ I_R2 (α·I_R1 equilibrium), ΔA ↔ its
 *  penetration-E strip chart. SAPS itself stays a SEPARATE simulation
 *  (2026-07-20 decision) — this module is the page-side shared core a
 *  standalone SAPS view consumes, not a place to grow a conductance grid. */
export const TAU_SHIELD_S = 25 * 60;

/** VBs → A scaling (kV/R_E² per mV/m) with a soft Hill–Siscoe-style
 *  saturation, calibrated so quiet (VBs ≈ 0.5) and extreme (VBs ≈ 10)
 *  match A(Kp 2) and A(Kp 9) respectively — see vbsAmplitude. */
export const K_VBS = 0.28;
export const VBS_SAT_MV_M = 8;

/** Driver blend weight toward the VBs term when both inputs are live —
 *  VBs leads Kp (L1 lead time + 3-h index cadence), so it dominates. */
export const W_VBS = 0.6;

/** A_drv clamp (kV/R_E²): floor at deep-quiet Maynard–Chen, cap a little
 *  above A(Kp 9) so a data glitch can't fold the teardrop into Earth. */
export const A_MIN = 0.03;
export const A_MAX = 2.0;

// ── Driver amplitude ─────────────────────────────────────────────────────────

/**
 * Maynard & Chen (1975) Volland–Stern amplitude (kV/R_E², γ = 2):
 *   A(Kp) = 0.045 / (1 − 0.159·Kp + 0.0093·Kp²)³
 * Kp 0 → 0.045 · Kp 3 → 0.20 · Kp 5 → 0.54 · Kp 7 → 1.12 · Kp 9 → 1.34.
 *
 * MIRROR: ring-current-transport.js convectionAmplitude() is this same fit
 * in V/R_E² (and the Rust/WASM kernel mirrors THAT byte-for-byte, so it is
 * not imported here). tests/ring-current-efield.mjs pins the two equal —
 * change them together or neither.
 */
export function maynardChenA(kp) {
    if (!Number.isFinite(kp)) return null;
    const k = Math.max(0, Math.min(9, kp));
    const d = 1 - 0.159 * k + 0.0093 * k * k;
    return 0.045 / (d * d * d);
}

/**
 * VBs-scaled amplitude (kV/R_E²) with soft saturation:
 *   A = K_VBS · VBs / (1 + VBs / VBS_SAT)
 * Linear at small VBs (0.5 mV/m → 0.13 ≈ A(Kp 2)); saturating at storm
 * driving (10 mV/m → 1.24 ≈ A(Kp 9)) — the cross-polar-cap potential
 * saturates, so the inner-magnetosphere amplitude must too.
 */
export function vbsAmplitude(vbs) {
    if (!Number.isFinite(vbs) || vbs < 0) return null;
    return K_VBS * vbs / (1 + vbs / VBS_SAT_MV_M);
}

/** Blended, clamped driver amplitude. Either input may be missing —
 *  falls back to the other; both missing → deep-quiet floor. */
export function driverAmplitude(kp, vbs) {
    const aK = maynardChenA(kp);
    const aV = vbsAmplitude(vbs);
    let a;
    if (aK != null && aV != null) a = (1 - W_VBS) * aK + W_VBS * aV;
    else a = aV ?? aK ?? A_MIN;
    return Math.max(A_MIN, Math.min(A_MAX, a));
}

// ── Potential & boundary geometry ────────────────────────────────────────────

/** MLT hours → azimuth φ (rad) of the Volland–Stern convention used here:
 *  φ = 0 at noon, +π/2 at dusk (18 MLT), −π/2 at dawn. The globe's scene
 *  θ = atan2(z, x) relates as θ = −φ (dusk at scene −Z). */
export function mltToPhi(mlt) {
    return (mlt - 12) * Math.PI / 12;
}

/** Total equatorial potential (kV) at L (R_E), azimuth φ, amplitude A. */
export function potentialKv(L, phi, A) {
    if (!(L > 0) || !Number.isFinite(phi) || !Number.isFinite(A)) return null;
    return -A * L * L * Math.sin(phi) - COROTATION_KV / L;
}

/** Dusk stagnation point L_s = (C / 2A)^(1/3) — where the sunward
 *  convection drift exactly cancels corotation. */
export function stagnationL(A) {
    if (!(A > 0)) return null;
    return Math.cbrt(COROTATION_KV / (2 * A));
}

/**
 * Radius of the LAST CLOSED EQUIPOTENTIAL at azimuth φ for amplitude A —
 * the teardrop plasmapause. The separatrix passes through the dusk
 * stagnation point; solving Φ(L, φ) = Φ(L_s, π/2) for L at each φ:
 *
 *   f(L) = A·L²·sinφ + C/L = K,   K = A·L_s² + C/L_s
 *
 * sinφ ≤ 0 (dawn side): f is strictly decreasing → unique root.
 * sinφ > 0 (dusk side): f dips to a minimum at (C/2A·sinφ)^(1/3) ≥ L_s and
 * the INNER root is the closed boundary (they merge at L_s when φ = π/2).
 * Bisection: the bracket is guaranteed by f(→0) = ∞ and f(min) = K·sinφ^(1/3).
 */
export function boundaryL(phi, A) {
    if (!(A > 0) || !Number.isFinite(phi)) return null;
    const C = COROTATION_KV;
    const Ls = stagnationL(A);
    const K = A * Ls * Ls + C / Ls;
    const s = Math.sin(phi);
    const f = (L) => A * L * L * s + C / L;
    let lo = 1e-3;
    let hi = s > 1e-9 ? Math.cbrt(C / (2 * A * s)) : 60;
    // f(lo) ≫ K (corotation term), f(hi) ≤ K — bisect the decreasing branch.
    for (let i = 0; i < 60; i++) {
        const mid = 0.5 * (lo + hi);
        if (f(mid) > K) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
}

/**
 * The teardrop as a polyline: n points {phi, mlt, L}, φ swept 0..2π.
 * Rendering maps each to scene (x, z) = (L·cosφ, −L·sinφ).
 */
export function teardropPoints(A, n = 180) {
    const pts = [];
    for (let i = 0; i < n; i++) {
        const phi = (i / n) * 2 * Math.PI;
        pts.push({ phi, mlt: (12 + phi * 12 / Math.PI) % 24, L: boundaryL(phi, A) });
    }
    return pts;
}

// ── The shielding state machine ──────────────────────────────────────────────

export class ConvectionEField {
    /**
     * @param {object} [opts]
     * @param {number} [opts.tauShieldS]  shielding time constant (sim-s)
     * @param {number} [opts.kp]          initial Kp (default deep quiet)
     * @param {number} [opts.vbs]         initial VBs (mV/m)
     */
    constructor(opts = {}) {
        this._tau = Number.isFinite(opts.tauShieldS) ? opts.tauShieldS : TAU_SHIELD_S;
        this._kp = Number.isFinite(opts.kp) ? opts.kp : 1;
        this._vbs = Number.isFinite(opts.vbs) ? opts.vbs : 0;
        this._aDrv = driverAmplitude(this._kp, this._vbs);
        // Start fully shielded (equilibrium): no synthetic penetration
        // transient at start. Explicit initial-condition opts count as
        // priming; a default-constructed instance instead snaps its shield
        // to the FIRST live driver it sees — a page opening mid-storm must
        // not paint boot-vs-storm as "penetration" (the real region-2
        // currents have been tracking that storm for hours).
        this._aSh = this._aDrv;
        this._primed = Number.isFinite(opts.kp) || Number.isFinite(opts.vbs);
    }

    /** Update the live driver inputs (either may be omitted / non-finite —
     *  the previous value is kept, matching the feed's partial updates). */
    setDriver({ kp, vbs } = {}) {
        if (Number.isFinite(kp)) this._kp = kp;
        if (Number.isFinite(vbs)) this._vbs = Math.max(0, vbs);
        this._aDrv = driverAmplitude(this._kp, this._vbs);
        if (!this._primed) {
            this._aSh = this._aDrv;   // first REAL driver = the equilibrium
            this._primed = true;
        }
    }

    /**
     * Advance the shielding ODE by dtSimSec SIM-seconds. Exact exponential
     * relaxation — unconditionally stable at any τ-compressed step size
     * (a ×1000 scrub jump lands on the curve, it doesn't overshoot).
     */
    step(dtSimSec) {
        if (!Number.isFinite(dtSimSec) || dtSimSec <= 0) return;
        this._aSh += (this._aDrv - this._aSh) * (1 - Math.exp(-dtSimSec / this._tau));
    }

    /** { A_drv, A_sh, dA, stagnationL } — dA = A_drv − A_sh (signed; see
     *  header for the undershielding/overshielding convention). */
    state() {
        return {
            A_drv: this._aDrv,
            A_sh: this._aSh,
            dA: this._aDrv - this._aSh,
            stagnationL: stagnationL(this._aSh),
        };
    }

    /** Shielded potential (kV) at (L, φ) — the field the plasmasphere sees. */
    potentialKv(L, phi) {
        return potentialKv(L, phi, this._aSh);
    }

    /** Teardrop boundary polyline at the current shielded amplitude. */
    teardrop(n = 180) {
        return teardropPoints(this._aSh, n);
    }
}
