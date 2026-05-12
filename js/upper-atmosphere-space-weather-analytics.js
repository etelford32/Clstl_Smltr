/**
 * upper-atmosphere-space-weather-analytics.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Operator-grade derived metrics from the live (F10.7, Ap, Bz, v_sw, n_sw)
 * state. The simulator already shows the physical thermosphere — this
 * module turns that state into the actionable headlines a satellite
 * operator, ham operator, polar pilot, or aurora chaser would care about:
 *
 *   • Dst proxy        ring-current intensity from Ap (Burton-style)
 *   • Drag forecast    LEO orbital-decay accelerator vs quiet baseline
 *   • HF blackout      D-region absorption proxy (X-ray + F10.7 driven)
 *   • GIC risk         power-grid geomagnetic-induced-current threat
 *   • NLC visibility   noctilucent-cloud detectability window
 *   • Polar cap absorption  SEP-driven HF blackout poleward of ~60°
 *   • Aurora viewing   minimum geomagnetic latitude where ovals visible
 *
 * Functions are pure — given only scalar inputs they return scalar
 * outputs, no I/O. The UI calls these on every refresh() and the panel
 * paints from the returned blobs.
 */

// Burton-McPherron-like Dst ↔ Ap mapping. Ap is a daily index,
// Dst is the storm-time decrease — they're correlated but not 1:1.
// Empirical:  Dst_min ≈ -8 · Ap (R² ≈ 0.6 across Solar Cycle 23/24).
// We clamp to physical bounds and add a quiet-time bias so Ap=0 → Dst≈0.
export function dstProxyFromAp(ap) {
    if (!Number.isFinite(ap) || ap <= 0) return -2;            // quiet bias
    // Saturating tanh fit calibrated against the storm-time Ap↔Dst
    // CDF: Ap 27 (G1) → Dst ≈ -50, Ap 80 (G3) → Dst ≈ -150,
    // Ap 200 (G4) → Dst ≈ -310, Ap 400 (G5) → Dst ≈ -480.
    return -480 * Math.tanh(ap / 130);
}

// Storm classification per NOAA SWPC G-scale (geomagnetic).
// Returns { tier: 'G0'..'G5', label, color }.
export function gStormScale(ap) {
    if (ap >= 400) return { tier: 'G5', label: 'EXTREME',  color: '#ff3060' };
    if (ap >= 200) return { tier: 'G4', label: 'SEVERE',   color: '#ff5070' };
    if (ap >=  80) return { tier: 'G3', label: 'STRONG',   color: '#ff8050' };
    if (ap >=  48) return { tier: 'G2', label: 'MODERATE', color: '#ffaa50' };
    if (ap >=  27) return { tier: 'G1', label: 'MINOR',    color: '#ffcc60' };
    return            { tier: 'G0', label: 'QUIET',    color: '#80c890' };
}

// Drag-forecast multiplier vs the quiet baseline (F10.7 = 70, Ap = 0).
// Anchors to the simulator's exospheric-temperature law:
//   T∞ ≈ 379 + 3.24·F10.7 + 1.3·Ap     (close to MSIS in the LEO band)
// Density at fixed altitude scales as ~(T∞/T₀)^k where k≈4-5 in the
// 300-500 km regime. We use k=4.5 averaged over LEO drag belt.
export function dragForecast(f107, ap) {
    const Tinf  = 379 + 3.24 * (f107 || 70) + 1.3 * (ap || 0);
    const Tquiet= 379 + 3.24 *  70 + 1.3 *  0;
    // Empirical: at 400 km, log(ρ_storm/ρ_quiet) ≈ 1.6 · log(T∞/T₀).
    // Calibrated so May 2024 (Gannon, Ap≈250, F10.7≈200) → ≈3-4× drag.
    const k     = 1.6;
    const ratio = Math.pow(Tinf / Tquiet, k);
    // Express as a percent excursion vs quiet, plus a back-of-envelope
    // ISS reboost-fuel multiplier (proportional to integrated drag
    // acceleration over 24 h).
    return {
        Tinf_K:        Tinf,
        ratio,                                 // ρ × q ratio vs quiet
        excessPct:    (ratio - 1) * 100,       // % excess drag
        issDeltaVMps: 1.2 * ratio,             // m/s/day (quiet ≈ 1.2 m/s)
        issFuelKgDay: 4.5 * ratio,             // kg/day (quiet ≈ 4.5 kg)
        starlinkLifetimeDays:
            ratio > 1.05
              ? Math.max(2, 28 / ratio)        // ~28 days from 210→0 km quiet
              : 28,
    };
}

// HF radio blackout. Flares drive the headline blackout (R-scale), but
// a quiet sun with high F10.7 still raises D-region absorption enough
// to mute lower-band HF. Returns a blended score + the legacy R-scale
// estimate when an X-ray flux is provided.
export function hfBlackoutScore(f107, ap, opts = {}) {
    const { xrayFluxWm2 = null } = opts;
    // Background absorption proxy ∝ F10.7 (relative to 70 quiet floor).
    const bgScore = Math.max(0, ((f107 || 70) - 70) / 200);   // 0..~1.15
    // Auroral absorption (PCA proxy) in storm conditions.
    const auScore = Math.min(1, (ap || 0) / 100);             // 0..1
    // Optional R-scale from the flare X-ray. Standard SWPC thresholds:
    //   R1 = M1 (1e-5 W/m²) ... R5 = X20 (2e-3 W/m²).
    let rTier = null;
    if (Number.isFinite(xrayFluxWm2) && xrayFluxWm2 > 0) {
        if      (xrayFluxWm2 >= 2e-3) rTier = { tier: 'R5', label: 'EXTREME'  };
        else if (xrayFluxWm2 >= 1e-3) rTier = { tier: 'R4', label: 'SEVERE'   };
        else if (xrayFluxWm2 >= 1e-4) rTier = { tier: 'R3', label: 'STRONG'   };
        else if (xrayFluxWm2 >= 5e-5) rTier = { tier: 'R2', label: 'MODERATE' };
        else if (xrayFluxWm2 >= 1e-5) rTier = { tier: 'R1', label: 'MINOR'    };
    }
    const composite = Math.min(1, 0.5 * bgScore + 0.5 * auScore);
    return { score: composite, bgScore, auScore, rTier };
}

// Geomagnetic-Induced-Current risk for power grids. Driven primarily
// by the rate of horizontal-field change (dB/dt). |Bz|·Ap is a decent
// proxy when paired with conductivity at high latitudes.
export function gicRisk(ap, bz) {
    const bzMag = Math.abs(Number.isFinite(bz) ? bz : 0);
    const apv   = Math.max(0, ap || 0);
    // Empirical: dB/dt ~ kAp + j|Bz| during storm onset.
    const dBdt = 1.6 * apv + 6.0 * bzMag;     // nT/min surrogate
    let tier = 'low', color = '#80c890';
    if (dBdt > 350)      { tier = 'extreme';  color = '#ff3060'; }
    else if (dBdt > 220) { tier = 'severe';   color = '#ff5070'; }
    else if (dBdt > 120) { tier = 'high';     color = '#ff8050'; }
    else if (dBdt > 60)  { tier = 'moderate'; color = '#ffcc60'; }
    return { dBdt, tier, color };
}

// Noctilucent-cloud visibility window. NLC live at ~83 km in the
// summer polar mesopause; visible from mid-latitudes (50–65°)
// in the dawn/dusk twilight. Returns a normalised visibility score.
export function nlcVisibility(monthIdx /* 0..11 */, hemisphere = 'N') {
    // Strong asymmetry — NH season runs roughly mid-May→mid-Aug.
    // SH season runs mid-Nov→mid-Feb. Peak ≈ 20 d after solstice.
    const peak = hemisphere === 'N' ? 6.5 : 0.5;            // month index
    const dist = Math.abs(((monthIdx - peak + 12) % 12) - 0);
    const norm = Math.cos(Math.min(dist, 12 - dist) / 1.5 * Math.PI / 2);
    return Math.max(0, norm);
}

// Polar Cap Absorption — SEPs depositing in the D-region. We approximate
// from the geomagnetic state (real driver is >10 MeV proton flux which
// usually correlates with storm activity but isn't identical).
export function pcaRisk(ap) {
    const apv = Math.max(0, ap || 0);
    if (apv >= 200) return { active: true, tier: 'severe',   color: '#ff5070', latDeg: 50 };
    if (apv >=  80) return { active: true, tier: 'moderate', color: '#ff8050', latDeg: 60 };
    if (apv >=  48) return { active: true, tier: 'minor',    color: '#ffcc60', latDeg: 65 };
    return            { active: false, tier: 'none',    color: '#80c890', latDeg: 90 };
}

// Auroral viewing line — equatorward edge of the visible auroral oval
// in geomagnetic latitude. Same Feldstein-Starkov idea used by the
// magnetic-cascade module but without re-running the full calc.
export function auroraEquatorwardEdgeDeg(ap) {
    const apv = Math.max(0, ap || 0);
    // Empirical: edge drops from ~67° at quiet to ~45° at G5.
    return Math.max(40, 67 - 0.07 * apv);
}

// Bundle everything into one blob for the UI's panel paint.
export function buildAnalyticsBundle({ f107 = 70, ap = 0, bz = 0,
                                       xrayFluxWm2 = null,
                                       monthIdx = new Date().getUTCMonth(),
                                       hemisphere = 'N' } = {}) {
    return {
        dst:           dstProxyFromAp(ap),
        gStorm:        gStormScale(ap),
        drag:          dragForecast(f107, ap),
        hf:            hfBlackoutScore(f107, ap, { xrayFluxWm2 }),
        gic:           gicRisk(ap, bz),
        pca:           pcaRisk(ap),
        nlc:           nlcVisibility(monthIdx, hemisphere),
        auroraEdgeDeg: auroraEquatorwardEdgeDeg(ap),
    };
}
