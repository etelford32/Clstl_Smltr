/**
 * upper-atmosphere-aurora-physics.js — research-grade auroral &
 * magnetospheric scaling laws used by the magnetic-field cascade
 * visualisation
 * ═══════════════════════════════════════════════════════════════════════════
 * Pure-functions module — no Three.js, no DOM. All formulas cite the
 * standard climatologies an operator/researcher would expect:
 *
 *   • Feldstein-Starkov (2001)        auroral oval lat boundaries
 *   • Newell-Meng (1989)              polar cusp magnetic latitude
 *   • Zhang-Paxton (2008) simplified  Hemispheric Power (HPI) from Kp
 *   • Hill (1984) / Siscoe et al. (2002)  cross-polar-cap potential
 *   • Carpenter-Anderson (1992)       plasmapause Lpp from Kp_max,24h
 *   • Iijima-Potemra (1976)           Birkeland Region 1+2 currents
 *
 * Conventions:
 *   • Magnetic latitudes are absolute (|λ|), 0–90°, measured from the
 *     magnetic equator. Northern + southern hemispheres are symmetric
 *     in this layer; the visualisation handles the sign separately.
 *   • Magnetic Local Time (MLT) is the dayside-aligned hour angle around
 *     the magnetic pole: 12 = noon (sub-solar), 00 = midnight,
 *     06 = dawn, 18 = dusk.
 *   • Φ_PC (cross-polar-cap potential) is in kV.
 *   • HPI (hemispheric power) is in GW.
 *
 * The cascade visualisation reads:
 *   • `auroralOvalLatBand(kp, mlt)` for the oval ribbon path
 *   • `cuspLatitude(kp)` for the polar-cusp marker
 *   • `lShellRegime(L)` for per-line tooltip text
 *   • `magnetosphericState(...)` for the readout panel + the
 *     'ua-magnetic-state' event payload
 */

// ── Auroral oval (Feldstein-Starkov simplified) ─────────────────────────────

/**
 * Auroral oval equatorward + poleward magnetic-latitude band, in
 * absolute degrees, as a function of Kp and MLT.
 *
 *   λ_eq(MLT) = 67 − 1.5·Kp + 2·cos(MLT_rad)     (eq. edge nearer pole on dayside)
 *   λ_pw(MLT) = 75 − 0.5·Kp + 1.0·cos(MLT_rad)
 *
 * The cos(MLT) term encodes the observed day/night asymmetry: the
 * equatorward edge sits ~4° closer to the pole at noon than at
 * midnight (dayside compression toward the cusp). Width is ~5–8°
 * depending on Kp.
 *
 * @param {number} kp           geomagnetic Kp index (0–9)
 * @param {number} mltHours     magnetic local time, 0–24
 * @returns {{eq: number, pw: number}}  eq + poleward edges in |λ_mag|
 */
export function auroralOvalLatBand(kp, mltHours) {
    const k = Math.max(0, Math.min(9, kp));
    const mlt = ((mltHours ?? 0) % 24 + 24) % 24;
    const mltRad = (mlt - 12) * (Math.PI / 12);    // 0 at noon, ±π at midnight
    const cosMLT = Math.cos(mltRad);

    const eq = 67 - 1.5 * k + 2.0 * cosMLT;
    const pw = 75 - 0.5 * k + 1.0 * cosMLT;
    return {
        eq: Math.max(50, Math.min(85, eq)),
        pw: Math.max(55, Math.min(89, pw)),
    };
}

/**
 * Convenience: sample the oval band at N MLT values, returning the
 * equatorward-edge latitude at each. Caller uses these to build a
 * closed ribbon around the magnetic pole.
 */
export function auroralOvalProfile(kp, nSamples = 48) {
    const eqArr = new Float32Array(nSamples);
    const pwArr = new Float32Array(nSamples);
    const mltArr = new Float32Array(nSamples);
    for (let i = 0; i < nSamples; i++) {
        const mlt = (i / nSamples) * 24;
        const { eq, pw } = auroralOvalLatBand(kp, mlt);
        eqArr[i]  = eq;
        pwArr[i]  = pw;
        mltArr[i] = mlt;
    }
    return { mltHours: mltArr, eqLat: eqArr, pwLat: pwArr };
}

// ── Polar cusp (Newell-Meng 1989 simplified) ────────────────────────────────

/**
 * Magnetic latitude of the polar cusp footpoint (always at MLT ≈ 12).
 *   λ_cusp ≈ 78° − 1°·Kp        (Newell-Meng 1989 fit to DMSP)
 * The cusp is the throat of an open-field-line tube connecting the
 * dayside magnetopause boundary directly to the ionosphere — solar
 * wind plasma precipitates here without any reconnection delay.
 */
export function cuspLatitude(kp) {
    const k = Math.max(0, Math.min(9, kp));
    return Math.max(70, Math.min(82, 78 - 1.0 * k));
}

// ── Hemispheric Power Index (Zhang-Paxton 2008 simplified) ──────────────────

/**
 * Total power (GW) deposited in one hemisphere by precipitating
 * particles. Operator-relevant: HPI > 50 GW degrades HF; > 200 GW =
 * widespread radio blackouts and amplified GIC risk.
 *
 * Newell & Liou (2011) simplified climatology:
 *
 *   HPI[GW] ≈ 5 · 10^(0.13·Kp)
 *
 * Quiet (Kp=2): ~9 GW.  Active (Kp=5): ~22 GW.  G3 (Kp=7): ~40 GW.
 * G5 (Kp=9): ~67 GW (matches POES + DMSP HPI catalog at extreme storms).
 */
export function hemisphericPowerGW(kp) {
    const k = Math.max(0, Math.min(9, kp));
    return 5 * Math.pow(10, 0.13 * k);
}

// ── Cross-polar-cap potential (Hill-Siscoe) ─────────────────────────────────

/**
 * Cross-polar-cap potential Φ_PC (kV) — the electric-potential drop
 * across the polar cap that drives ionospheric ion convection. Hill
 * (1984) form, with Siscoe et al. (2002) saturation:
 *
 *   E_sw = V_sw · |Bz_south| · sin²(θ/2)        [mV/m, with V in km/s, B in nT]
 *   Φ_unsat = 57.6·E_sw                          [kV] (rough Burton fit)
 *   Φ_sat   = 4.4·Pdyn^(1/3)·Φ_unsat / (Φ_unsat + 0.0146·Pdyn^(1/3)·...)
 *
 * For a visualisation-grade readout we use the un-saturated Hill form
 * with a soft cap at 250 kV (matches Φ_PC observations during the
 * largest historical storms — March 1989 was ~270 kV).
 *
 * @param {number} v_sw     solar wind speed (km/s)
 * @param {number} bz       IMF Bz GSM (nT, +north)
 * @param {number} by       IMF By GSM (nT)
 * @returns {number}        Φ_PC in kV
 */
export function polarCapPotentialKV(v_sw = 400, bz = 0, by = 0) {
    const v   = Math.max(200, v_sw);
    const bt  = Math.sqrt(bz * bz + by * by);
    // Standard clock-angle convention: θ measured from +Z (northward).
    //   θ = atan2(By, Bz)   →  Bz>0,By=0 ⇒ θ=0 (no merging)
    //                          Bz<0,By=0 ⇒ θ=π (full merging)
    const theta = Math.atan2(by, bz);
    const sinHalf = Math.sin(theta / 2);
    const E_sw   = v * bt * sinHalf * sinHalf;          // km/s · nT
    // Hill (1984) coefficient — empirical Φ_un = 0.0086·V·Bs (Burton-style),
    // expressed here with V in km/s, B in nT so Φ comes out in kV.
    const phi_un = 0.0086 * E_sw;                        // kV

    // Soft saturation toward 250 kV — matches CPCP ceiling observed
    // during March 1989 + Halloween 2003 events.
    const PHI_SAT = 250;
    return PHI_SAT * (1 - Math.exp(-phi_un / PHI_SAT));
}

// ── Plasmapause (Carpenter-Anderson 1992) ────────────────────────────────────

/**
 * Plasmapause L-shell — the inner boundary of the open
 * magnetosphere, beyond which the cold dense plasmasphere abruptly
 * thins. Relevant for whistler-wave propagation and inner-belt
 * energetic-electron lifetimes.
 *
 *   Lpp ≈ 5.39 − 0.382 · Kp_max,24h
 *
 * Quiet: Lpp ~ 5.4. Active: Lpp ~ 4. Severe: Lpp can drop below 3.
 *
 * @param {number} kpMax24h  maximum Kp over the trailing 24 hours
 */
export function plasmapauseL(kpMax24h) {
    const k = Math.max(0, Math.min(9, kpMax24h));
    return Math.max(2.0, 5.39 - 0.382 * k);
}

// ── Birkeland (field-aligned) currents — Iijima-Potemra ──────────────────────

/**
 * Total Region-1 + Region-2 current strength (MA) from solar-wind
 * driver. Same formula as in solar-wind-magnetosphere.js so the two
 * stay aligned.
 *
 *   |I_FAC| ≈ 0.046 · (v/400)^0.72 · |Bz_south|^0.95 · n^0.23   [MA]
 *
 * Northward IMF returns a ~quiet-time viscous floor.
 *
 * @param {number} v_sw     km/s
 * @param {number} bz       nT (+north)
 * @param {number} n        cm⁻³
 */
export function fieldAlignedCurrentMA(v_sw = 400, bz = 0, n = 5) {
    const vNorm = Math.pow(Math.max(200, v_sw) / 400, 0.72);
    const nNorm = Math.pow(Math.max(0.5, n), 0.23);
    if (bz >= 0) return 0.10 * vNorm * nNorm;          // viscous-only
    return 0.046 * vNorm * Math.pow(Math.abs(bz), 0.95) * nNorm;
}

// ── L-shell regime / population labels ──────────────────────────────────────

/**
 * Map an L-shell to its physical population. Used by the cascade
 * tooltip so a hover on a field line reads as "L=4.5 — outer Van
 * Allen radiation belt (relativistic e⁻)" rather than a bare number.
 *
 * @param {number} L
 * @returns {{regime: string, label: string, population: string, color: string}}
 */
export function lShellRegime(L) {
    const x = Math.max(1.0, L);
    if (x < 2.5) return {
        regime:     'plasmasphere-inner',
        label:      'Inner plasmasphere',
        population: 'cold dense corotating plasma; H⁺/He⁺',
        color:      '#88c8ff',
    };
    if (x < 4.5) return {
        regime:     'inner-belt',
        label:      'Inner Van Allen belt',
        population: 'relativistic protons (10–500 MeV); SAA hot zone',
        color:      '#ff8060',
    };
    if (x < 6.0) return {
        regime:     'slot-region',
        label:      'Slot region',
        population: 'wave-driven loss; relatively benign',
        color:      '#a0c8a0',
    };
    if (x < 8.0) return {
        regime:     'outer-belt',
        label:      'Outer Van Allen belt',
        population: 'relativistic electrons (0.1–10 MeV); "killer e⁻"',
        color:      '#ff60a0',
    };
    if (x < 10.0) return {
        regime:     'ring-current',
        label:      'Ring-current zone',
        population: '10–200 keV ions; Dst proxy',
        color:      '#ffc060',
    };
    if (x < 14.0) return {
        regime:     'auroral-acceleration',
        label:      'Auroral acceleration zone',
        population: 'inverted-V e⁻ precipitation; discrete aurora',
        color:      '#80ff80',
    };
    return {
        regime:     'polar-cap',
        label:      'Polar cap / magnetotail',
        population: 'open field lines; solar-wind direct entry',
        color:      '#a0a0ff',
    };
}

// ── Operator headline state ─────────────────────────────────────────────────

/**
 * Compute the headline operator-grade quantities for the panel.
 * Combines all the above into a single payload — the cascade
 * dispatches this on every state push so the UI can render a
 * "magnetosphere state" readout without re-deriving anything.
 *
 * @param {object} sw     {speed, density, bz, by} — solar-wind state
 * @param {number} kp     current Kp
 * @returns {object}
 */
export function magnetosphericState(sw = {}, kp = 2) {
    const speed   = Number.isFinite(sw.speed)   ? sw.speed   : 400;
    const density = Number.isFinite(sw.density) ? sw.density : 5;
    const bz      = Number.isFinite(sw.bz)      ? sw.bz      : 0;
    const by      = Number.isFinite(sw.by)      ? sw.by      : 0;

    const phi_pc = polarCapPotentialKV(speed, bz, by);
    const hpi    = hemisphericPowerGW(kp);
    const lpp    = plasmapauseL(kp);
    const fac    = fieldAlignedCurrentMA(speed, bz, density);
    const cuspLat = cuspLatitude(kp);

    // Headline auroral-oval edges at four cardinal MLT for the panel.
    const ovalNoon  = auroralOvalLatBand(kp, 12);
    const ovalDusk  = auroralOvalLatBand(kp, 18);
    const ovalMidn  = auroralOvalLatBand(kp,  0);
    const ovalDawn  = auroralOvalLatBand(kp,  6);

    // Operator implications — short text strings the panel can show.
    const implications = _operatorImplications({
        kp, hpi, phi_pc, fac, ovalEqMidn: ovalMidn.eq,
    });

    return {
        kp,
        sw: { speed, density, bz, by },
        phi_pc_kV:    phi_pc,
        hpi_GW:       hpi,
        plasmapauseL: lpp,
        fac_MA:       fac,
        cuspLatDeg:   cuspLat,
        oval: {
            noon:     ovalNoon,
            dusk:     ovalDusk,
            midnight: ovalMidn,
            dawn:     ovalDawn,
        },
        implications,
    };
}

function _operatorImplications({ kp, hpi, phi_pc, fac, ovalEqMidn }) {
    const out = [];
    if (kp >= 5)  out.push('HF radio absorption likely at high latitudes');
    if (kp >= 6)  out.push('GNSS scintillation probable across auroral oval');
    if (kp >= 7)  out.push('GIC risk on low-latitude power grids');
    if (kp >= 8)  out.push('Aurora visible to mid-latitudes (≤ 50° geog. lat)');
    if (hpi  >= 100) out.push(`Hemispheric power ${hpi.toFixed(0)} GW — extreme deposition`);
    if (phi_pc >= 150) out.push(`Φ_PC ${phi_pc.toFixed(0)} kV — saturated convection`);
    if (fac  >= 5)   out.push(`Birkeland current ${fac.toFixed(1)} MA — active current system`);
    if (ovalEqMidn <= 55) out.push(`Oval at ${ovalEqMidn.toFixed(0)}° mag-lat midnight — sub-auroral red arcs possible`);
    if (out.length === 0) out.push('Quiet conditions — no operational impact expected');
    return out;
}

// ── Geometry helpers (mag-lat/MLT → unit Cartesian) ────────────────────────

/**
 * Convert (magnetic latitude, MLT) to a unit vector in the cascade's
 * magnetic frame (where +Y is the magnetic pole, the dayside is along
 * the +X-ish axis modulo Earth's orientation in scene). Sign of the
 * latitude picks the hemisphere.
 *
 * @param {number} latDeg    magnetic latitude (°, signed; +N, -S)
 * @param {number} mltHours  0..24
 * @returns {{x: number, y: number, z: number}}
 */
export function magLatMLTToUnit(latDeg, mltHours) {
    const phi = latDeg * (Math.PI / 180);
    const lam = ((mltHours - 12) / 24) * (2 * Math.PI);
    const c = Math.cos(phi);
    return {
        x: c * Math.cos(lam),
        y: Math.sin(phi),
        z: c * Math.sin(lam),
    };
}
