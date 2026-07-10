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
export function stepDstStar(dstStar, vbs, dtHours, model = 'obm') {
    const q   = model === 'burton' ? burtonQ(vbs) : obmQ(vbs);
    const tau = model === 'burton' ? BURTON.TAU_H : obmTau(vbs);
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
            ({ dstStar } = stepDstStar(dstStar, vbs, step, model));
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

/** Carpenter & Anderson (1992) plasmapause L: Lpp = 5.6 − 0.46·Kp, clamped. */
export function plasmapauseL(kp) {
    const k = Number.isFinite(kp) ? kp : 2;
    return Math.max(1.8, Math.min(6.5, 5.6 - 0.46 * k));
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
