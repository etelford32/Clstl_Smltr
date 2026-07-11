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
