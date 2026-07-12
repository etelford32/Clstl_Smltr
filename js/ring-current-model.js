/**
 * ring-current-model.js — physics core of the Ring Current Simulation
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure functions only: no DOM, no THREE, no fetch. tests/ring-current-model.mjs
 * runs this exact module under node, so keep it dependency-free.
 *
 * ── What is modeled ─────────────────────────────────────────────────────────
 * The ring current is a toroidal westward current at ~2–7 R_E carried by
 * 10–300 keV ions injected from the plasma sheet during southward IMF. Its
 * magnetic perturbation at the equator IS the Dst index. We integrate the
 * empirical injection/decay balance driven by measured L1 solar wind:
 *
 *   d Dst*(t) / dt = Q(VBs) − Dst*(t) / τ(VBs)
 *
 * ── References ──────────────────────────────────────────────────────────────
 *   O'Brien & McPherron (2000) JGR 105(A4) 7707    — Q, τ(VBs), pressure terms
 *   Burton, McPherron & Russell (1975) JGR 80 4204 — original linear model
 *   Dessler & Parker (1959); Sckopke (1966)        — energy ↔ ΔB relation
 *   Carpenter & Anderson (1992) JGR 97 1097        — plasmapause Lpp(Kp)
 *   Schulz & Lanzerotti (1974)                     — drift kinematics
 *   Liemohn et al. (2001) JGR 106 10883            — partial ring current
 *
 * Storm-class thresholds intentionally mirror api/noaa/dst.js — change them
 * in both places or neither.
 */

// ── Physical constants ───────────────────────────────────────────────────────
export const PHYS = Object.freeze({
    R_E_M:       6.371e6,       // Earth radius (m)
    B0_T:        3.11e-5,       // equatorial surface field (T) = 31 100 nT
    B0_NT:       3.11e4,
    MU0:         4 * Math.PI * 1e-7,
    Q_E:         1.602176634e-19,   // elementary charge (C)
    KEV_J:       1.602176634e-16,   // keV → J
    L1_KM:       1.5e6,         // Sun-Earth L1 upstream distance (km)
    MP_FACTOR:   1.67e-6,       // Pdyn(nPa) = 1.67e-6 · n(cm⁻³) · v(km/s)²
});

// Energy of the dipole field external to Earth's surface:
//   W_m = (4π / 3μ₀) · B₀² · R_E³  ≈ 8.3×10¹⁷ J
export const W_MAGNETOSPHERE_J =
    (4 * Math.PI / (3 * PHYS.MU0)) * PHYS.B0_T * PHYS.B0_T * PHYS.R_E_M ** 3;

// Dessler–Parker–Sckopke: ΔB/B₀ = −(2/3)·W_RC/W_m
//   ⇒ W_RC per nT of |Dst*| = (3/2)·W_m / B₀(nT)  ≈ 4.0×10¹³ J/nT
export const DPS_J_PER_NT = 1.5 * W_MAGNETOSPHERE_J / PHYS.B0_NT;

// ── O'Brien & McPherron (2000) parameters ────────────────────────────────────
export const OBM = Object.freeze({
    A_NT_PER_H: -4.4,    // injection efficiency, nT/h per (mV/m) above cutoff
    EC_MV_M:     0.49,   // coupling cutoff (mV/m) — no injection below this
    B_NT_SQRT:   7.26,   // pressure correction b (nT per √nPa)
    C_NT:        11.0,   // pressure correction offset (nT)
    TAU_A_H:     2.40,   // τ = TAU_A · exp( TAU_B / (TAU_C + VBs) ) hours
    TAU_B:       9.74,
    TAU_C:       4.69,
});

// Burton et al. (1975) comparison mode: fixed decay, linear injection in Ey.
export const BURTON = Object.freeze({
    D_NT_PER_H: -5.4,    // −1.5×10⁻³ nT/s per mV/m
    EC_MV_M:     0.50,
    TAU_H:       7.7,
});

// ── Solar wind coupling ──────────────────────────────────────────────────────

/** Dynamic pressure (nPa) from density (cm⁻³) and speed (km/s). */
export function dynamicPressure(n, v) {
    if (!Number.isFinite(n) || !Number.isFinite(v) || n <= 0 || v <= 0) return null;
    return PHYS.MP_FACTOR * n * v * v;
}

/**
 * Dawn–dusk electric field VBs (mV/m): v(km/s) · Bs(nT) · 10⁻³ where
 * Bs = southward IMF magnitude = max(0, −Bz GSM). Northward Bz ⇒ 0.
 */
export function couplingVBs(v, bz) {
    if (!Number.isFinite(v) || !Number.isFinite(bz)) return null;
    return v * Math.max(0, -bz) * 1e-3;
}

/**
 * Newell et al. (2007) coupling function dΦ_MP/dt — the best general-purpose
 * solar-wind–magnetosphere coupling proxy across ten magnetospheric state
 * variables:
 *
 *   dΦ/dt = v^(4/3) · B_T^(2/3) · sin^(8/3)(θc/2)
 *
 * where B_T = √(By² + Bz²) is the transverse IMF and θc = atan2(|By|, Bz)
 * the IMF clock angle (0 = due north ⇒ no coupling; π = due south ⇒ max).
 * Mixed units, as customary: v in km/s, B in nT → typical values 0 (quiet
 * northward) to ~50 000 (major storm). Fully derivable from fields already
 * stored in solar_wind_samples — no schema change needed.
 */
export function newellCoupling(v, by, bz) {
    if (!Number.isFinite(v) || !Number.isFinite(bz)) return null;
    const byV = Number.isFinite(by) ? by : 0;
    const bT = Math.sqrt(byV * byV + bz * bz);
    if (bT === 0) return 0;
    const clock = Math.atan2(Math.abs(byV), bz);        // [0, π]
    return Math.pow(Math.max(0, v), 4 / 3) *
           Math.pow(bT, 2 / 3) *
           Math.pow(Math.sin(clock / 2), 8 / 3);
}

/**
 * Pressure-corrected index: Dst* = Dst − b·√Pdyn + c.
 * Removes magnetopause-current contamination so Dst* isolates the ring
 * current. Null-safe: without pressure, returns Dst unchanged.
 */
export function toDstStar(dst, pdyn) {
    if (!Number.isFinite(dst)) return null;
    if (!Number.isFinite(pdyn) || pdyn <= 0) return dst;
    return dst - OBM.B_NT_SQRT * Math.sqrt(pdyn) + OBM.C_NT;
}

/** Inverse of toDstStar — what a magnetometer on the ground would see. */
export function toDst(dstStar, pdyn) {
    if (!Number.isFinite(dstStar)) return null;
    if (!Number.isFinite(pdyn) || pdyn <= 0) return dstStar;
    return dstStar + OBM.B_NT_SQRT * Math.sqrt(pdyn) - OBM.C_NT;
}

// ── Injection & decay ────────────────────────────────────────────────────────

/** O'Brien–McPherron injection Q (nT/h). ≤ 0; zero below the Ec cutoff. */
export function obmQ(vbs) {
    if (!Number.isFinite(vbs) || vbs <= OBM.EC_MV_M) return 0;
    return OBM.A_NT_PER_H * (vbs - OBM.EC_MV_M);
}

/**
 * O'Brien–McPherron decay time τ (hours). Driven storms decay FASTER
 * (τ ≈ 19.1 h quiet → ~5–8 h under strong VBs) because the plasmapause moves
 * inward and drift/charge-exchange losses strengthen.
 */
export function obmTau(vbs) {
    const e = Number.isFinite(vbs) && vbs > 0 ? vbs : 0;
    return OBM.TAU_A_H * Math.exp(OBM.TAU_B / (OBM.TAU_C + e));
}

/** Burton (1975) injection (nT/h) — fixed-τ comparison mode. */
export function burtonQ(vbs) {
    if (!Number.isFinite(vbs) || vbs <= BURTON.EC_MV_M) return 0;
    return BURTON.D_NT_PER_H * (vbs - BURTON.EC_MV_M);
}

/**
 * One integration step, semi-implicit in the decay term so long/irregular
 * steps stay unconditionally stable:
 *   Dst*ₖ₊₁ = (Dst*ₖ + Q·dt) / (1 + dt/τ)
 */
export function stepDstStar(dstStar, vbs, dtHours, model = 'obm', qScale = 1, tauScale = 1) {
    const q   = (model === 'burton' ? burtonQ(vbs) : obmQ(vbs)) * qScale;
    const tau = (model === 'burton' ? BURTON.TAU_H : obmTau(vbs)) * tauScale;
    const dt  = Math.max(0, dtHours);
    return { dstStar: (dstStar + q * dt) / (1 + dt / tau), q, tau };
}

/**
 * Integrate Dst* through a driver series.
 *
 * @param {Array<{t:number, v:number|null, n:number|null, bz:number|null}>} samples
 *        ascending time (ms). Gaps tolerated; a step is clamped to ≤ 10 min —
 *        longer gaps integrate as multiple driver-hold sub-steps.
 * @param {number} dst0  observed (uncorrected) Dst anchor at samples[0].t
 * @param {object} [opts] { model:'obm'|'burton' }
 * @returns {Array<{t, dstStar, dst, q, tau, vbs, pdyn}>}
 *
 * Anchoring happens ONCE, at the window start, then the model free-runs —
 * re-anchoring every tick would hide model error and fake the skill numbers.
 */
export function integrateDst(samples, dst0, opts = {}) {
    const model = opts.model === 'burton' ? 'burton' : 'obm';
    const qScale   = Number.isFinite(opts.qScale)   ? opts.qScale   : 1;
    const tauScale = Number.isFinite(opts.tauScale) ? opts.tauScale : 1;
    if (!Array.isArray(samples) || samples.length === 0 || !Number.isFinite(dst0)) return [];

    const MAX_STEP_H = 10 / 60;
    const out = [];
    let held = { v: 400, bz: 0, n: 5 };   // conservative quiet defaults until first valid row

    const first  = samples[0];
    if (Number.isFinite(first.v))  held.v  = first.v;
    if (Number.isFinite(first.bz)) held.bz = first.bz;
    if (Number.isFinite(first.n))  held.n  = first.n;

    let pdyn    = dynamicPressure(held.n, held.v);
    let dstStar = toDstStar(dst0, pdyn);
    let vbs     = couplingVBs(held.v, held.bz) ?? 0;
    out.push({ t: first.t, dstStar, dst: toDst(dstStar, pdyn), q: obmQ(vbs), tau: obmTau(vbs), vbs, pdyn });

    for (let i = 1; i < samples.length; i++) {
        const s = samples[i];
        let dtH = (s.t - samples[i - 1].t) / 3.6e6;
        if (!(dtH > 0)) continue;                    // duplicates / non-monotonic

        // Hold the previous driver across the interval (sub-step long gaps).
        while (dtH > 0) {
            const step = Math.min(dtH, MAX_STEP_H);
            ({ dstStar } = stepDstStar(dstStar, vbs, step, model, qScale, tauScale));
            dtH -= step;
        }

        // Update the held driver with whatever this row validly carries.
        if (Number.isFinite(s.v)  && s.v > 0) held.v  = s.v;
        if (Number.isFinite(s.n)  && s.n > 0) held.n  = s.n;
        if (Number.isFinite(s.bz))            held.bz = s.bz;
        vbs  = couplingVBs(held.v, held.bz) ?? vbs;
        pdyn = dynamicPressure(held.n, held.v) ?? pdyn;

        const q   = model === 'burton' ? burtonQ(vbs) : obmQ(vbs);
        const tau = model === 'burton' ? BURTON.TAU_H : obmTau(vbs);
        out.push({ t: s.t, dstStar, dst: toDst(dstStar, pdyn), q, tau, vbs, pdyn });
    }
    return out;
}

/**
 * Parameter-ensemble integration for an uncertainty band. Runs the central
 * O'Brien–McPherron fit plus the four corners of (a, τ) each perturbed by
 * ±spread (default 25% — a deliberate SENSITIVITY band on the empirical fit
 * coefficients, labeled as such in the UI; it is not a full forecast
 * uncertainty, which would also need driver and propagation error).
 * Operators need bands, not points: forecast uncertainty propagates
 * directly into conjunction probability-of-collision (Parker 2024,
 * doi:10.1029/2023SW003818 — see RING_CURRENT_USER_RESEARCH.md).
 *
 * @returns {{ central: Array, band: Array<{t, lo, hi}> }}
 */
export function integrateDstEnsemble(samples, dst0, opts = {}) {
    const spread = Number.isFinite(opts.spread) ? opts.spread : 0.25;
    const central = integrateDst(samples, dst0, opts);
    if (!central.length) return { central, band: [] };
    const corners = [
        { qScale: 1 - spread, tauScale: 1 - spread },
        { qScale: 1 - spread, tauScale: 1 + spread },
        { qScale: 1 + spread, tauScale: 1 - spread },
        { qScale: 1 + spread, tauScale: 1 + spread },
    ].map(c => integrateDst(samples, dst0, { ...opts, ...c }));
    const band = central.map((p, i) => {
        let lo = p.dst, hi = p.dst;
        for (const track of corners) {
            const d = track[i]?.dst;
            if (Number.isFinite(d)) { if (d < lo) lo = d; if (d > hi) hi = d; }
        }
        return { t: p.t, lo, hi };
    });
    return { central, band };
}

/**
 * First forecast crossing of the next storm-class threshold below the
 * current level (thresholds mirror stormClass / api/noaa/dst.js). Returns
 * { threshold, t, dst } for the first forecast point at/below a threshold
 * the present value has not already crossed, or null. This is the
 * "predictive alert 30–90 min ahead" both operator and aurora users ask
 * for — and it is genuine lead time, because the driver is already
 * measured at L1.
 */
export function findThresholdCrossing(dstNow, forecast) {
    if (!Number.isFinite(dstNow) || !Array.isArray(forecast)) return null;
    const THRESHOLDS = [-30, -50, -100, -200, -350];
    const next = THRESHOLDS.find(th => dstNow > th);
    if (next === undefined) return null;
    for (const p of forecast) {
        if (Number.isFinite(p.dst) && p.dst <= next) {
            return { threshold: next, t: p.t, dst: p.dst };
        }
    }
    return null;
}

// ── Kp → ap (NOAA standard conversion, exact table) ──────────────────────────
// Index = Kp in thirds (0o, 0+, 1−, 1o, … 9o). Used to drive the thermosphere
// engine (js/upper-atmosphere-engine.js density()) from the live Kp.
const AP_TABLE = [0, 2, 3, 4, 5, 6, 7, 9, 12, 15, 18, 22, 27, 32, 39, 48,
    56, 67, 80, 94, 111, 132, 154, 179, 207, 236, 300, 400];

export function kpToAp(kp) {
    if (!Number.isFinite(kp)) return null;
    const idx = Math.max(0, Math.min(27, Math.round(kp * 3)));
    return AP_TABLE[idx];
}

// ── L1 ballistic propagation (the forecast horizon) ──────────────────────────

/**
 * RTSW time_tags are observation times AT L1, ~1.5×10⁶ km upstream. A parcel
 * measured now arrives at Earth after L1_KM / v seconds (~62 min at 400 km/s).
 * Returns a copy with tArrive (ms) added, sorted by arrival. Samples whose
 * tArrive is in the future are the genuine forecast window.
 */
export function propagateToEarth(samples, l1Km = PHYS.L1_KM) {
    if (!Array.isArray(samples)) return [];
    return samples
        .map(s => {
            const v = Number.isFinite(s.v) && s.v > 100 ? s.v : 400;
            return { ...s, tArrive: s.t + (l1Km / v) * 1000 };
        })
        .sort((a, b) => a.tArrive - b.tArrive);
}

// ── Energy content ───────────────────────────────────────────────────────────

/** Total ring current energy (J) via DPS. Positive number; 0 for Dst* ≥ 0. */
export function dpsEnergyJ(dstStar) {
    if (!Number.isFinite(dstStar) || dstStar >= 0) return 0;
    return DPS_J_PER_NT * Math.abs(dstStar);
}

// ── Morphology (drives the 3D twin) ─────────────────────────────────────────

/**
 * L-shell of peak ring current density. ~4 R_E quiet; the injection boundary
 * moves earthward as the storm intensifies (≈2.5 R_E for great storms).
 * Empirical smooth fit; dstStar ≤ 0.
 */
export function ringPeakL(dstStar) {
    const d = Number.isFinite(dstStar) ? Math.min(0, dstStar) : 0;
    return 2.4 + 1.6 * Math.exp(d / 120);
}

/**
 * Relative ring current density (0..1) at L for a given Dst*. Gaussian about
 * ringPeakL with inner truncation (plasmasphere/atmosphere at L < 1.8) and a
 * broad outer skirt toward the plasma-sheet source.
 */
export function radialProfile(L, dstStar) {
    if (!Number.isFinite(L) || L < 1.15) return 0;
    const peak  = ringPeakL(dstStar);
    const sigma = L < peak ? 0.55 : 1.15;      // steep inner edge, broad outer skirt
    const g = Math.exp(-((L - peak) ** 2) / (2 * sigma * sigma));
    const innerCut = 1 / (1 + Math.exp(-(L - 1.8) / 0.12));
    const outerCut = 1 / (1 + Math.exp((L - 6.8) / 0.35));
    return g * innerCut * outerCut;
}

/**
 * Partial-ring-current asymmetry. During the main phase freshly injected
 * ions have not yet closed their drift paths, so the current peaks near
 * dusk (~19 MLT, Liemohn et al. 2001); recovery symmetrizes it.
 * amplitude 0..0.85 driven by VBs.
 */
export function asymmetry(vbs) {
    const e = Number.isFinite(vbs) && vbs > 0 ? vbs : 0;
    return { amplitude: Math.min(0.85, e / (e + 3)), mltPeakHours: 19 };
}

/** Azimuthal density weight (0..~1.85) at a given MLT for an asymmetry. */
export function azimuthalWeight(mltHours, asym) {
    const phi = ((mltHours - asym.mltPeakHours) / 24) * 2 * Math.PI;
    return 1 + asym.amplitude * Math.cos(phi);
}

/**
 * Gradient–curvature drift period (hours) for an equatorially mirroring
 * particle: T_d = 2π·q·B₀·R_E² / (3·L·E). Nonrelativistic — fine for ring
 * current ions; mildly optimistic for >300 keV electrons.
 * @param {number} eKev  kinetic energy (keV)
 * @param {number} L     drift shell
 */
export function driftPeriodHours(eKev, L) {
    if (!Number.isFinite(eKev) || !Number.isFinite(L) || eKev <= 0 || L <= 0) return null;
    const eJ = eKev * PHYS.KEV_J;
    const seconds = (2 * Math.PI * PHYS.Q_E * PHYS.B0_T * PHYS.R_E_M ** 2) / (3 * L * eJ);
    return seconds / 3600;
}

/**
 * Signed drift angular rate (rad per hour). Ions drift WESTWARD (−),
 * electrons EASTWARD (+); both carry westward current.
 */
export function driftRateRadPerHour(eKev, L, species = 'ion') {
    const T = driftPeriodHours(eKev, L);
    if (!T) return 0;
    const sign = species === 'electron' ? +1 : -1;
    return sign * 2 * Math.PI / T;
}

// ── Dipole trapped motion (drives the 3D twin's bounce) ─────────────────────

/**
 * Point on a dipole field line at L, magnetic latitude λ (rad):
 *   r(λ)  = L·cos²λ            (radial distance, R_E)
 *   ρ     = r·cosλ = L·cos³λ   (equatorial-plane distance)
 *   y     = r·sinλ             (height above the equatorial plane)
 * Returns { r, rho, y }.
 */
export function dipoleFieldLinePoint(L, latRad) {
    const c = Math.cos(latRad);
    const r = L * c * c;
    return { r, rho: r * c, y: r * Math.sin(latRad) };
}

/** Dipole field strength ratio B(λ)/B_eq = √(1 + 3sin²λ) / cos⁶λ. */
export function dipoleFieldRatio(latRad) {
    const s = Math.sin(latRad), c = Math.cos(latRad);
    return Math.sqrt(1 + 3 * s * s) / (c ** 6);
}

/**
 * Mirror latitude (rad) for an equatorial pitch angle α_eq (rad): the λ_m
 * where the first adiabatic invariant forces v_∥ → 0,
 *   sin²α_eq = B_eq / B(λ_m).
 * α_eq = 90° ⇒ λ_m = 0 (equatorially mirroring); smaller α_eq ⇒ deeper
 * mirror. Solved by bisection (B ratio is monotonic in λ).
 */
export function mirrorLatitude(alphaEqRad) {
    const s2 = Math.sin(alphaEqRad) ** 2;
    if (!(s2 > 0) || s2 >= 1) return 0;
    const target = 1 / s2;                    // B(λm)/B_eq at the mirror point
    let lo = 0, hi = 89.9 * Math.PI / 180;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (dipoleFieldRatio(mid) < target) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

/**
 * Equatorial loss-cone half-angle (rad) at drift shell L: particles with
 * α_eq below this mirror inside the atmosphere and precipitate.
 *   sin²α_lc = 1 / √(4L⁶ − 3L⁵)
 * (Same expression as js/van-allen-particles.js — keep in sync.)
 */
export function lossConeAngle(L) {
    if (!Number.isFinite(L) || L <= 1) return Math.PI / 2;
    const s2 = 1 / Math.sqrt(4 * L ** 6 - 3 * L ** 5);
    return Math.asin(Math.min(1, Math.sqrt(s2)));
}

/** Carpenter & Anderson (1992) plasmapause L: Lpp = 5.6 − 0.46·Kp, clamped. */
export function plasmapauseL(kp) {
    const k = Number.isFinite(kp) ? kp : 2;
    return Math.max(1.8, Math.min(6.5, 5.6 - 0.46 * k));
}

// ── Magnetopause & bow shock (Shue et al. 1998 — the boundary conditions) ────

/**
 * Shue et al. (1998) subsolar magnetopause standoff distance (R_E):
 *
 *   r₀ = (10.22 + 1.29·tanh(0.184·(Bz + 8.14))) · Pdyn^(−1/6.6)
 *
 * The two live drivers do exactly what intuition says: dynamic pressure
 * pushes the nose in (r₀ ∝ Pdyn^−0.152), and southward Bz erodes it further
 * (reconnection peels flux off the dayside). Nominal wind (2 nPa, Bz 0)
 * ⇒ ~10.3 R_E; a big storm (30 nPa, −20 nT) ⇒ ~5.4 R_E — INSIDE
 * geosynchronous orbit, which is why GEO satellites sometimes find
 * themselves in the solar wind during extreme events.
 */
export function shueStandoffRe(pdynNPa, bzNT) {
    const p = Number.isFinite(pdynNPa) && pdynNPa > 0 ? pdynNPa : 2;
    const bz = Number.isFinite(bzNT) ? bzNT : 0;
    return (10.22 + 1.29 * Math.tanh(0.184 * (bz + 8.14))) * Math.pow(p, -1 / 6.6);
}

/**
 * Shue (1998) tail-flaring exponent α = (0.58 − 0.007·Bz)·(1 + 0.024·ln Pdyn).
 * α > 0.5 ⇒ the tail boundary keeps opening; southward Bz flares it more.
 */
export function shueAlpha(pdynNPa, bzNT) {
    const p = Number.isFinite(pdynNPa) && pdynNPa > 0 ? pdynNPa : 2;
    const bz = Number.isFinite(bzNT) ? bzNT : 0;
    return (0.58 - 0.007 * bz) * (1 + 0.024 * Math.log(p));
}

/**
 * Shue magnetopause radius at solar-zenith angle θ (rad from the +X nose):
 * r(θ) = r₀·(2/(1+cosθ))^α. Valid to θ ≈ 2 rad; diverges toward the tail.
 */
export function shueRadiusRe(thetaRad, r0, alpha) {
    if (!Number.isFinite(thetaRad) || !Number.isFinite(r0) || !Number.isFinite(alpha)) return null;
    return r0 * Math.pow(2 / (1 + Math.cos(Math.min(2.0, Math.abs(thetaRad)))), alpha);
}

/** Bow-shock standoff (R_E) — Farris & Russell (1994)-class ratio ≈ 1.29·r₀
 *  for typical magnetosonic Mach numbers. Order-of-magnitude for the twin. */
export function bowShockStandoffRe(pdynNPa, bzNT) {
    return 1.29 * shueStandoffRe(pdynNPa, bzNT);
}

// ── Composition (O⁺/H⁺ split — Phase 2b) ─────────────────────────────────────

/**
 * O⁺ fraction of the ring current energy density vs storm intensity.
 *
 * Quiet time the ring current is solar-wind protons (O⁺ ≲ 10%); storm-time
 * injection is fed by ionospheric outflow, so the O⁺ share GROWS with storm
 * depth — ~30% for moderate storms, ≥50% for intense ones (Hamilton et al.
 * 1988 AMPTE/CCE; Daglis et al. 1999, Space Sci. Rev. 91). Empirical smooth
 * fit through those anchors, asymptoting at 0.64 (the one-off ~80% extremes
 * of great storms are deliberately not chased):
 *
 *   f_O(Dst*) = 0.06 + 0.58 · (1 − e^(Dst* / 180)),  Dst* ≤ 0
 *
 * O⁺ matters beyond bookkeeping: at ring-current energies its charge-exchange
 * cross-section with geocoronal H exceeds H⁺'s, so an O⁺-rich storm-time ring
 * decays faster at first — part of the observed two-phase recovery. The OBM
 * τ(VBs) fit already absorbs this in aggregate; this function only PARTITIONS
 * the energy for display, it does not feed back into the integration.
 */
export function oxygenFraction(dstStar) {
    const d = Number.isFinite(dstStar) ? Math.min(0, dstStar) : 0;
    return 0.06 + 0.58 * (1 - Math.exp(d / 180));
}

// ── Bounce kinematics (physical, drives the twin's true-rate bounce) ─────────

/** Rest masses (kg). 'ion' is the H⁺ ring-current default. */
export const SPECIES_MASS_KG = Object.freeze({
    ion:      1.67262192369e-27,   // proton
    proton:   1.67262192369e-27,
    oxygen:   2.6567e-26,          // O⁺ (15.999 u)
    electron: 9.1093837015e-31,
});

/**
 * Dipole bounce period (seconds) — Lenchek/Schulz small-pitch-angle fit:
 *
 *   T_b ≈ (4·L·R_E / v) · (1.30 − 0.56·sin α_eq)
 *
 * v is relativistic (matters for ≳100 keV electrons; negligible for ions).
 * Anchors: 100 keV H⁺ at L=3, α=90° → ≈13 s; O⁺ is √16 = 4× slower at the
 * same energy; 100 keV electron ≈ 0.34 s. These are REAL times — the 3D twin
 * runs bounce at exactly this rate, uncompressed.
 */
export function bouncePeriodSeconds(eKev, L, alphaEqRad = Math.PI / 2, species = 'ion') {
    if (!Number.isFinite(eKev) || eKev <= 0 || !Number.isFinite(L) || L <= 0) return null;
    const m = SPECIES_MASS_KG[species] ?? SPECIES_MASS_KG.ion;
    const c = 2.99792458e8;
    const gamma = 1 + (eKev * PHYS.KEV_J) / (m * c * c);
    const v = c * Math.sqrt(1 - 1 / (gamma * gamma));
    const a = Math.min(Math.PI / 2, Math.max(0.01, Number.isFinite(alphaEqRad) ? alphaEqRad : Math.PI / 2));
    return (4 * L * PHYS.R_E_M / v) * (1.30 - 0.56 * Math.sin(a));
}

// ── Particle lifetimes (loss channels — the end of the Sun→surface journey) ──

/**
 * Geocoronal neutral-hydrogen density (cm⁻³) at dipole distance L. The
 * exosphere's H halo is what ring-current ions charge-exchange against.
 * Power-law fit through Rairden et al. (1986) Chamberlain-model values
 * (~4×10⁴ near the exobase, ~10³ at 3 R_E, ~10² at 5 R_E) — smooth,
 * order-of-magnitude, activity-independent.
 */
export function geocoronalDensity(L) {
    if (!Number.isFinite(L)) return null;
    return 4.4e4 * Math.pow(Math.max(1.05, L), -3.5);
}

/**
 * Charge-exchange cross-section (cm²) with geocoronal H.
 *
 *   H⁺ + H → H(ENA) + H⁺ : large (~2×10⁻¹⁵) at keV energies, collapsing
 *     steeply above tens of keV (Lindsay & Stebbings 2005 anchors).
 *   O⁺ + H → O(ENA) + H⁺ : ~10⁻¹⁵ and nearly FLAT through ring-current
 *     energies — which is why the storm-time O⁺-rich ring decays fast
 *     while the ≥100 keV proton tail survives for days: the observed
 *     two-phase recovery.
 *
 * Smooth order-of-magnitude fits for the visual twin — not for flux
 * modeling. Electrons don't charge-exchange: null.
 */
export function chargeExchangeCrossSection(eKev, species = 'ion') {
    if (!Number.isFinite(eKev) || eKev <= 0) return null;
    if (species === 'electron') return null;
    if (species === 'oxygen') return 1.0e-15 / (1 + Math.pow(eKev / 300, 1.5));
    return 2.0e-15 / (1 + Math.pow(eKev / 10, 2));            // H⁺ / proton
}

/**
 * Charge-exchange lifetime (hours): τ = 1 / (σ(E) · n_H(L) · v).
 * Anchors this produces: 50 keV H⁺ at L=3 ≈ 12 h; 100 keV H⁺ ≈ 34 h;
 * 100 keV O⁺ ≈ 3 h (dies an order of magnitude faster — two-phase decay);
 * τ ∝ L^3.5 as the geocorona thins outward. Electrons: null (their ring
 * lifetime is wave scattering, not charge exchange — no clean closed form).
 */
export function chargeExchangeLifetimeHours(eKev, L, species = 'ion') {
    const sigma = chargeExchangeCrossSection(eKev, species);
    const nH = geocoronalDensity(L);
    if (sigma == null || nH == null || !Number.isFinite(L) || L <= 0) return null;
    const m = SPECIES_MASS_KG[species] ?? SPECIES_MASS_KG.ion;
    const c = 2.99792458e8;
    const gamma = 1 + (eKev * PHYS.KEV_J) / (m * c * c);
    const vCm = c * Math.sqrt(1 - 1 / (gamma * gamma)) * 100;   // cm/s
    return 1 / (sigma * nH * vCm) / 3600;
}

// ── Sun–Earth geometry (drives the twin's accurate Earth + GSM frame) ────────

/**
 * Subsolar point (the spot on Earth where the Sun is overhead) at a UTC
 * epoch. Latitude = solar declination (Spencer 1971 Fourier fit, ±0.02°);
 * longitude from UTC hour corrected by the equation of time (±16 min/yr).
 * This is what makes the twin's Earth honest: the hemisphere facing +X
 * (the Sun) is the hemisphere actually in daylight right now.
 *
 * @returns {{latDeg:number, lonDeg:number}|null}  lonDeg east-positive, (−180,180]
 */
export function subsolarPoint(ms) {
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    const year0 = Date.UTC(d.getUTCFullYear(), 0, 1);
    const g = 2 * Math.PI * ((ms - year0) / 86400000) / 365;   // fractional-day year angle
    const decl =
        0.006918 - 0.399912 * Math.cos(g)     + 0.070257 * Math.sin(g)
                 - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
                 - 0.002697 * Math.cos(3 * g) + 0.001480 * Math.sin(3 * g);
    const eotMin = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
                                      - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const utcH = (ms / 3.6e6) % 24;
    const lon = -15 * (utcH - 12 + eotMin / 60);
    return {
        latDeg: decl * 180 / Math.PI,
        lonDeg: ((lon + 540) % 360) - 180,
    };
}

/**
 * Earth's position in its orbit at a UTC epoch — same Meeus low-precision
 * ephemeris as dipoleTiltRad, so the twin's orbital readout and its dipole
 * tilt can never disagree about where the Sun is.
 *
 * @returns {{lonDeg:number, rAU:number, dayOfYear:number}|null}
 *   lonDeg     heliocentric ecliptic longitude of EARTH, [0,360)
 *              (= geocentric solar longitude + 180°; ~0.9856°/day)
 *   rAU        Sun–Earth distance (AU): 0.9833 at perihelion (~Jan 3),
 *              1.0167 at aphelion (~Jul 4) — e = 0.0167
 *   dayOfYear  1-based UTC day of year
 */
export function earthOrbit(ms) {
    if (!Number.isFinite(ms)) return null;
    const rad = Math.PI / 180;
    const n = ms / 86400000 + 2440587.5 - 2451545.0;     // days since J2000.0
    const L = (280.460 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * rad;   // mean anomaly
    const lamSun = L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g);
    const d = new Date(ms);
    return {
        lonDeg: ((lamSun + 180) % 360 + 360) % 360,
        rAU: 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g),
        dayOfYear: Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1,
    };
}

// IGRF-14-ish geomagnetic (dipole) north pole, epoch ~2025.
const GEOMAG_POLE = Object.freeze({ latDeg: 80.7, lonDeg: -72.7 });

/**
 * GSM dipole tilt angle ψ (radians): the angle between Earth's dipole axis
 * and the plane perpendicular to the Sun–Earth line. Positive = dipole north
 * tips SUNWARD (northern summer daytime). Range ≈ ±34°: ±23.4° seasonal
 * (obliquity) ± ~11° diurnal (the dipole axis is offset from the rotation
 * axis and swings around it once per day). By the definition of GSM, the
 * dipole axis always lies in the GSM X–Z plane — so in the twin's scene the
 * whole magnetosphere group tilts about one axis by exactly −ψ.
 *
 * Low-precision solar ephemeris + GMST (both ±0.01°-class) — plenty for a
 * visual twin; not for conjugate-point science.
 */
export function dipoleTiltRad(ms) {
    if (!Number.isFinite(ms)) return null;
    const rad = Math.PI / 180;
    const n = ms / 86400000 + 2440587.5 - 2451545.0;     // days since J2000.0
    // Sun unit vector in GEI (Meeus low-precision).
    const Lsun = (280.460 + 0.9856474 * n) % 360;
    const gsun = ((357.528 + 0.9856003 * n) % 360) * rad;
    const lam  = (Lsun + 1.915 * Math.sin(gsun) + 0.020 * Math.sin(2 * gsun)) * rad;
    const eps  = (23.439 - 4e-7 * n) * rad;
    const sx = Math.cos(lam), sy = Math.cos(eps) * Math.sin(lam), sz = Math.sin(eps) * Math.sin(lam);
    // Dipole axis: ECEF unit vector from the geomagnetic pole, spun into GEI
    // by Greenwich mean sidereal time.
    const gmst  = ((280.46061837 + 360.98564736629 * n) % 360) * rad;
    const colat = (90 - GEOMAG_POLE.latDeg) * rad, plon = GEOMAG_POLE.lonDeg * rad;
    const mx = Math.sin(colat) * Math.cos(plon), my = Math.sin(colat) * Math.sin(plon), mz = Math.cos(colat);
    const dot = (mx * Math.cos(gmst) - my * Math.sin(gmst)) * sx
              + (mx * Math.sin(gmst) + my * Math.cos(gmst)) * sy
              + mz * sz;
    return Math.asin(Math.max(-1, Math.min(1, dot)));
}

// ── Classification & skill ───────────────────────────────────────────────────

/** Storm class from (uncorrected) Dst — mirrors api/noaa/dst.js exactly. */
export function stormClass(dst) {
    if (!Number.isFinite(dst)) return { level: 0, label: 'None' };
    if (dst <= -350) return { level: 5, label: 'Extreme (Dst ≤ -350 nT)' };
    if (dst <= -200) return { level: 4, label: 'Severe (Dst ≤ -200 nT)' };
    if (dst <= -100) return { level: 3, label: 'Strong (Dst ≤ -100 nT)' };
    if (dst <= -50)  return { level: 2, label: 'Moderate (Dst ≤ -50 nT)' };
    if (dst <= -30)  return { level: 1, label: 'Minor (Dst ≤ -30 nT)' };
    return                  { level: 0, label: 'Quiet' };
}

/**
 * Model-vs-observed skill: pair each observed point with the nearest model
 * point within tolMs (default 30 min), return { rmse, bias, n }.
 * bias = mean(model − observed): negative ⇒ model too deep.
 */
export function skill(modelSeries, observedSeries, tolMs = 30 * 60 * 1000) {
    if (!Array.isArray(modelSeries) || !Array.isArray(observedSeries)) return { rmse: null, bias: null, n: 0 };
    let sumSq = 0, sum = 0, n = 0, j = 0;
    for (const obs of observedSeries) {
        if (!Number.isFinite(obs.dst) || !Number.isFinite(obs.t)) continue;
        while (j + 1 < modelSeries.length && modelSeries[j + 1].t <= obs.t) j++;
        let best = null;
        for (const cand of [modelSeries[j], modelSeries[j + 1]]) {
            if (!cand) continue;
            const d = Math.abs(cand.t - obs.t);
            if (d <= tolMs && (!best || d < Math.abs(best.t - obs.t))) best = cand;
        }
        if (!best || !Number.isFinite(best.dst)) continue;
        const err = best.dst - obs.dst;
        sumSq += err * err; sum += err; n++;
    }
    if (!n) return { rmse: null, bias: null, n: 0 };
    return { rmse: Math.sqrt(sumSq / n), bias: sum / n, n };
}

// ── Sun → Earth timing: the emission/reception ledger ───────────────────────
// The measurable gap the page surfaces as a first-class quantity: photons
// reach Earth in 8.3 minutes, but the PLASMA arriving now left the corona
// days ago — and how many days depends on each parcel's own speed, so one
// solar "moment" arrives smeared over days and what Earth receives at any
// instant is a mixture of emissions from different solar days (and, because
// the Sun rotates under the outflow, different source longitudes). That
// dispersion is the classic ballistic back-mapping question (Nolte & Roelof
// 1973) and the quantitative hook the UI exposes per parcel and in bulk.

/** Constants for the emission→reception ledger. */
export const SOLAR = Object.freeze({
    AU_KM:         1.496e8,                        // Sun–Earth distance
    RSUN_KM:       6.957e5,                        // solar radius
    OMEGA_RAD_S:   2 * Math.PI / (25.38 * 86400),  // sidereal (Carrington) rotation
    LIGHT_LAG_MIN: 1.496e8 / 299792.458 / 60,      // photon travel time ≈ 8.32 min
});

/**
 * Ballistic transit state of a CME cone analysis (DONKI: time tagged at
 * 21.5 R☉, plane-of-sky speed). Constant-speed propagation from 21.5 R☉
 * to Earth — the same disclosed method as the wind back-mapping. Real
 * CMEs drag toward the ambient wind speed, so the arrival band is set to
 * ±15 % of the remaining transit (≈ the ±10 h accuracy floor operational
 * CME models quote). Fraction can exceed 1 (already arrived).
 *
 * @returns { fraction, etaMs, etaEarlyMs, etaLateMs, hoursInFlight,
 *            arrived } | null
 */
export function cmeTransit(launchMs, vKmS, nowMs) {
    if (!Number.isFinite(launchMs) || !Number.isFinite(vKmS) || vKmS < 100 ||
        !Number.isFinite(nowMs) || nowMs < launchMs) return null;
    const distKm = SOLAR.AU_KM - 21.5 * SOLAR.RSUN_KM;
    const transitMs = (distKm / vKmS) * 1000;
    const flightMs = nowMs - launchMs;
    const etaMs = launchMs + transitMs;
    const band = Math.max(0, etaMs - nowMs) * 0.15 + 2 * 3.6e6;   // ±(15 % + 2 h floor)
    return {
        fraction: flightMs / transitMs,
        etaMs,
        etaEarlyMs: etaMs - band,
        etaLateMs:  etaMs + band,
        hoursInFlight: flightMs / 3.6e6,
        arrived: flightMs >= transitMs,
    };
}

/**
 * Ballistic solar-departure estimate: plasma measured at L1 at tL1Ms with
 * speed v left the corona (AU − L1)/v seconds earlier. Constant-speed
 * assumption — the real wind still accelerates inside ~0.1 AU and stream
 * interactions rearrange arrivals, so treat as ±½ day (the solar radius,
 * 0.5% of the leg, is ignored). ≈2.8 d at 620 km/s, ≈4.3 d at 400 km/s.
 */
export function sunDepartureMs(tL1Ms, vKmS) {
    if (!Number.isFinite(tL1Ms) || !Number.isFinite(vKmS) || vKmS < 100) return null;
    return tL1Ms - ((SOLAR.AU_KM - PHYS.L1_KM) / vKmS) * 1000;
}

/** Parker-spiral garden-hose angle at 1 AU: atan(Ω·r/v) — ≈45° at 430 km/s
 *  (Ω·1 AU ≈ 429 km/s, the classic coincidence). */
export function parkerSpiralDeg(vKmS) {
    if (!Number.isFinite(vKmS) || vKmS < 100) return null;
    return Math.atan2(SOLAR.OMEGA_RAD_S * SOLAR.AU_KM, vKmS) * 180 / Math.PI;
}

/** Solar rotation swept during the Sun→Earth transit, Ω·(AU/v): the wind
 *  arriving now left a source this many degrees east of the current
 *  sub-Earth longitude (the Sun turned under the outflow while it flew). */
export function sourceRotationDeg(vKmS) {
    if (!Number.isFinite(vKmS) || vKmS < 100) return null;
    return SOLAR.OMEGA_RAD_S * (SOLAR.AU_KM / vKmS) * 180 / Math.PI;
}

/**
 * Carrington coordinates of the solar disk center as seen from Earth
 * (Meeus, Astronomical Algorithms ch. 29): L0 = heliographic longitude of
 * the central meridian in the Carrington frame (decreases ~13.2°/day —
 * the SYNODIC rate, because Earth orbits while the Sun rotates), B0 = the
 * ±7.25° heliographic latitude tilt of the disk center. Apparent solar
 * longitude comes from earthOrbit (aberration ~0.006° ignored); good to
 * ~0.1°, far inside ballistic back-mapping's ±½-day (±6°) uncertainty.
 *
 * This is the bridge between the timing ledger and REAL solar imagery:
 * the wind arriving now was on the Earth-facing central meridian at
 * departure, so its source Carrington longitude is simply L0(departure) —
 * directly comparable with HEK coronal-hole detections (hgc_x).
 */
export function carringtonL0(ms) {
    const jd = ms / 86400000 + 2440587.5;
    const d2r = Math.PI / 180;
    // Sidereal rotation phase from the Carrington epoch (JD 2398220.0).
    const theta = (((jd - 2398220.0) * 360 / 25.38) % 360 + 360) % 360;
    // Ascending node of the solar equator on the ecliptic.
    const K = (73.6667 + 1.3958333 * (jd - 2396758.0) / 36525) * d2r;
    const I = 7.25 * d2r;                        // solar equator inclination
    // Apparent geocentric solar longitude = Earth's heliocentric + 180°.
    const lam = ((earthOrbit(ms).lonDeg + 180) % 360) * d2r;
    const lamK = lam - K;
    const eta = Math.atan2(Math.sin(lamK) * Math.cos(I), Math.cos(lamK)) / d2r;
    // +180: the (JD − 2398220)·360/25.38 phase convention lands the prime
    // meridian half a rotation off the operational (HEK/SDO) Carrington
    // frame. EMPIRICALLY PINNED against HEK hgc_x − hgs_x pairs: offset
    // was 180.00° exactly at 2026-07-07T20:02 and 2026-07-08T00:02 UT
    // (L0 = 339.96° / 337.75°) — found by the back-mapping validation
    // study BEFORE the constant shipped anywhere. Tests anchor these.
    const L0 = ((eta - theta + 180) % 360 + 360) % 360;
    const B0 = Math.asin(Math.sin(lamK) * Math.sin(I)) / d2r;
    return { L0, B0 };
}

/**
 * Match a back-mapped source Carrington longitude against the HEK
 * coronal-hole catalog (api/hek/coronal-holes rows: { lat_deg,
 * lon_carrington_deg, frm_name, ... }). Scoring favors low/mid-latitude
 * holes — polar-hole wind mostly misses the ecliptic — via a latitude
 * penalty above ±45°. Attribution rules follow the standard solar-wind
 * taxonomy: fast wind (≥480 km/s) traces to a CH within 20° of longitude;
 * slow wind needs a tight (≤12°) match, otherwise it is streamer-belt
 * wind by default. Returns null when there is nothing to match against.
 */
/**
 * Per-hole historical wind association — the INVERSE of attributeWindSource.
 * Every 1-min driver sample back-maps to its own source longitude (its own
 * measured speed at its own L1 time); a sample "belongs" to a hole when
 * within tolDeg of Carrington longitude. Each hole's association is then
 * the count + median speed of ITS samples: a measured record of what Earth
 * actually received from that hole's longitude. Holes with no arrivals in
 * the driver window (e.g. east of the central meridian — their wind hasn't
 * arrived yet) return assoc: null; consumers treat that as "no record this
 * rotation", not zero. Same validated mapping the back-mapping study
 * scored (82 % fast-wind hit at ±20° vs 37 % chance).
 *
 * @param {Array} holes    HEK rows ({ lat_deg, lon_carrington_deg, ... })
 * @param {Array} drivers  [{ t, v }] 1-min series (24 h typical); strided
 *                         internally to ~10-min samples
 * @param {number} strideN sample stride (default 10 — right for 1-min
 *                         series; pass 1 for pre-bucketed data, e.g. the
 *                         validation scripts' 6-h medians)
 * @returns holes decorated with assoc: { n, vMed } | null
 */
export function holeWindAssociation(holes, drivers, tolDeg = 15, strideN = 10) {
    if (!Array.isArray(holes) || !holes.length) return [];
    const src = [];
    if (Array.isArray(drivers)) {
        for (let i = 0; i < drivers.length; i += Math.max(1, strideN)) {
            const d = drivers[i];
            if (!d || !Number.isFinite(d.v) || d.v < 100 || !Number.isFinite(d.t)) continue;
            const dep = sunDepartureMs(d.t, d.v);
            if (dep == null) continue;
            src.push({ lon: carringtonL0(dep).L0, v: d.v });
        }
    }
    return holes.map(h => {
        const lon = h?.lon_carrington_deg;
        if (!Number.isFinite(lon) || !src.length) return { ...h, assoc: null };
        const vs = [];
        for (const s of src) {
            const dd = Math.abs((((s.lon - lon) % 360) + 540) % 360 - 180);
            if (dd <= tolDeg) vs.push(s.v);
        }
        if (!vs.length) return { ...h, assoc: null };
        vs.sort((a, b) => a - b);
        return { ...h, assoc: { n: vs.length, vMed: vs[Math.floor(vs.length / 2)] } };
    });
}

// ── NOAA space-weather scales (the operational vocabulary) ──────────────────
// Pure threshold maps, per SWPC's published scale definitions. Level 0 =
// below scale. These give the dashboard the same R/S/G language operators
// and SWPC products use, computed from the live feeds.

/** R (radio blackout) from GOES 0.1–0.8 nm X-ray flux (W/m²):
 *  R1=M1(1e-5), R2=M5, R3=X1(1e-4), R4=X10, R5=X20. */
export function noaaRScale(xrayWm2) {
    if (!Number.isFinite(xrayWm2) || xrayWm2 < 1e-5) return { level: 0, label: 'R0' };
    const level = xrayWm2 >= 2e-3 ? 5 : xrayWm2 >= 1e-3 ? 4
                : xrayWm2 >= 1e-4 ? 3 : xrayWm2 >= 5e-5 ? 2 : 1;
    return { level, label: `R${level}` };
}

/** S (solar radiation storm) from GOES ≥10 MeV integral proton flux (pfu):
 *  S1=10, S2=100, S3=10³, S4=10⁴, S5=10⁵. */
export function noaaSScale(p10pfu) {
    if (!Number.isFinite(p10pfu) || p10pfu < 10) return { level: 0, label: 'S0' };
    const level = Math.min(5, Math.floor(Math.log10(p10pfu)));
    return { level, label: `S${level}` };
}

/** G (geomagnetic storm) from Kp: G1=5 … G5=9. */
export function noaaGScale(kp) {
    if (!Number.isFinite(kp) || kp < 5) return { level: 0, label: 'G0' };
    const level = Math.min(5, Math.floor(kp) - 4);
    return { level, label: `G${level}` };
}

/**
 * GEO internal-charging risk from the GOES ≥2 MeV electron flux (pfu).
 * The 1 000 pfu NOAA alert threshold anchors the 'high' tier — sustained
 * ≥2 MeV fluence is the classic deep-dielectric charging driver (the
 * "killer electrons" of the outer radiation belt, the same population
 * this page's ring current feeds during storm recovery).
 */
export function geoChargingRisk(e2MeVpfu) {
    if (!Number.isFinite(e2MeVpfu)) return { level: 0, label: 'unknown' };
    if (e2MeVpfu >= 1e4)  return { level: 3, label: 'severe' };
    if (e2MeVpfu >= 1000) return { level: 2, label: 'high' };
    if (e2MeVpfu >= 100)  return { level: 1, label: 'elevated' };
    return { level: 0, label: 'low' };
}

/** Synodic solar rotation as seen from Earth (Carrington period 27.2753 d). */
export const SYNODIC_DEG_PER_DAY = 360 / 27.2753;

/**
 * Recurrence (persistence) forecast — NOAA's operational technique for
 * recurrent high-speed streams, run over the HEK catalog: a hole's wind
 * record from one central-meridian crossing is the prediction for its
 * next one.
 *
 * For each non-polar hole, both the LAST and NEXT meridian crossings are
 * considered (a hole that crossed 2 days ago has its stream arriving
 * ~now — the most actionable case); arrival = crossing + ballistic
 * transit. Speed: the hole's own measured record (holeWindAssociation)
 * with a ±60 km/s band — for west holes this projects THIS rotation's
 * record to the next crossing, the classic 27-day recurrence — or, for
 * holes with no record yet, a coronal-hole fast-wind climatology band
 * [450, 650] km/s, labeled as such (basis: 'climatology'). Once the
 * driver archive exceeds one rotation, east holes inherit last-rotation
 * records through holeWindAssociation automatically — no new code.
 *
 * Returns holes decorated with .forecast, sorted by soonest arrival:
 *   { lonWDeg, crossing:'last'|'next', crossMs, arriveMs,
 *     arriveEarlyMs, arriveLateMs, vUsed|null, basis, daysToArrival }
 */
export function holeArrivalForecast(holes, nowMs, opts = {}) {
    const latMax = opts.latMax ?? 65;
    const [vClimLo, vClimHi] = opts.climatology ?? [450, 650];
    if (!Array.isArray(holes) || !Number.isFinite(nowMs)) return [];
    const DAY = 86.4e6;
    const L0 = carringtonL0(nowMs).L0;
    const transitDays = v => (SOLAR.AU_KM - PHYS.L1_KM) / v / 86400;
    const out = [];
    for (const h of holes) {
        const lonCar = h?.lon_carrington_deg;
        if (!Number.isFinite(lonCar) || Math.abs(h?.lat_deg ?? 90) > latMax) continue;
        const lonW = ((lonCar - L0) % 360 + 540) % 360 - 180;   // + = west of CM
        const sinceCross = (lonW >= 0 ? lonW : 360 + lonW) / SYNODIC_DEG_PER_DAY;
        const untilCross = (lonW >= 0 ? 360 - lonW : -lonW) / SYNODIC_DEG_PER_DAY;
        const rec = Number.isFinite(h?.assoc?.vMed) ? h.assoc.vMed : null;
        const vLo = rec ? Math.max(250, rec - 60) : vClimLo;
        const vHi = rec ? rec + 60 : vClimHi;
        const vMid = rec ?? (vClimLo + vClimHi) / 2;
        let best = null;
        for (const [crossing, dDays] of [['last', -sinceCross], ['next', untilCross]]) {
            const crossMs = nowMs + dDays * DAY;
            const arriveLateMs = crossMs + transitDays(vLo) * DAY;
            // +1 d grace: streams persist beyond onset — an arrival window
            // that ended less than a day ago is spent, older ones expired.
            if (arriveLateMs + DAY < nowMs) continue;
            const f = {
                lonWDeg: lonW, crossing, crossMs,
                arriveMs:      crossMs + transitDays(vMid) * DAY,
                arriveEarlyMs: crossMs + transitDays(vHi) * DAY,
                arriveLateMs,
                vUsed: rec, basis: rec ? 'record' : 'climatology',
            };
            f.daysToArrival = (f.arriveMs - nowMs) / DAY;
            if (!best || f.arriveMs < best.arriveMs) best = f;
        }
        if (best) out.push({ ...h, forecast: best });
    }
    return out.sort((a, b) => a.forecast.arriveMs - b.forecast.arriveMs);
}

export function attributeWindSource(holes, srcCarringtonLon, vKmS) {
    if (!Array.isArray(holes) || !holes.length || !Number.isFinite(srcCarringtonLon)) return null;
    let best = null;
    for (const h of holes) {
        const lon = h?.lon_carrington_deg;
        if (!Number.isFinite(lon)) continue;
        const dLon = Math.abs((((lon - srcCarringtonLon) % 360) + 540) % 360 - 180);
        const latPen = Math.max(0, Math.abs(h.lat_deg ?? 90) - 45) * 0.8;
        const score = dLon + latPen;
        if (!best || score < best.score) best = { hole: h, dLon, score };
    }
    if (!best) return null;
    const fast = Number.isFinite(vKmS) && vKmS >= 480;
    const matched = best.dLon <= (fast ? 20 : 12);
    return {
        matched,
        kind: matched ? 'coronal-hole' : (fast ? 'unattributed-fast' : 'streamer-belt'),
        dLonDeg: best.dLon,
        hole: matched ? best.hole : null,
    };
}
