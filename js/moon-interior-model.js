/**
 * moon-interior-model.js — the Moon's interior as a pure, testable kernel.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no three.js, no fetch, no ambient time (every time-dependent
 * function takes an explicit Date/ms). Gated by tests/moon-interior-model.mjs.
 * The renderer (js/moon-interior.js) draws ONLY numbers that come from here.
 *
 * ── WHAT THIS IS, HONESTLY ───────────────────────────────────────────────
 * A structural model of the lunar interior distilled from the published
 * seismic/gravity literature — NOT an inversion and NOT a thermal-evolution
 * simulation. Layer radii and states follow the Apollo seismic reanalysis of
 * Weber et al. (2011, Science 331:309) with GRAIL-era crustal values from
 * Wieczorek et al. (2013, Science 339:671). Densities are tuned within their
 * published uncertainty bands so the integrated mass reproduces the measured
 * lunar mass to <0.1% — the test pins that, plus surface gravity and the
 * ~5 GPa central pressure, so nobody can retune one layer without noticing
 * the planet stops adding up.
 *
 * The selenotherm is a piecewise-linear profile through accepted anchor
 * values (Gagnepain-Beyneix et al. 2006; Khan et al. 2014 class of models),
 * paired with a silicate solidus so the partial-melt layer EMERGES from
 * T ≥ T_solidus in exactly the 330–480 km band Weber detected — the melt
 * fraction is derived, not painted on.
 *
 * Deep moonquakes: tidally triggered, monthly, 700–1200 km deep
 * (Nakamura 2005, JGR 110:E01001 — ~250 located nests, ~7000 events,
 * nearside-biased because far-side events were hard to locate with a
 * nearside-only network). A1 is the real, most active nest; the other
 * entries are REPRESENTATIVE of the catalogue's spatial statistics, and say
 * so. The trigger phase is the anomalistic month (perigee→perigee).
 *
 * The dead dynamo: paleointensity timeline after Weiss & Tikoo (2014,
 * Science 346:1198) and Mighani et al. (2020, Sci. Adv. 6:eaax0883) — a
 * high-field epoch 4.25–3.56 Ga at Earth-like surface strengths, a weak
 * declining tail, cessation somewhere between 1.9 and 0.8 Ga. Today the
 * global field is ZERO; only crustal remanence remains (Reiner Gamma).
 * This is the Moon's counterpoint to TIGA's living Earth dynamo.
 */

// ── Global constants ─────────────────────────────────────────────────────────
export const R_MOON_KM = 1737.4;              // mean radius
export const MOON_MASS_MEASURED_KG = 7.342e22; // DE430; the mass the layers must reproduce
export const G_NEWTON = 6.674e-11;

// ── Layer structure (center → surface) ───────────────────────────────────────
// Radii: Weber et al. 2011 (±10–20 km bands). Crust: GRAIL mean thickness
// (34–43 km across models); 40 km used here, with the nearside/farside
// asymmetry carried separately by crustThicknessKm(). Densities sit inside
// published bands, tuned so ∫ρ dV = measured mass (see header).
export const LAYERS = Object.freeze([
    Object.freeze({
        key: 'inner-core', name: 'Inner core',
        rInnerKm: 0, rOuterKm: 240, densityKgM3: 7800,
        state: 'solid', vpKmS: 4.3, vsKmS: 2.3,
        note: 'Solid Fe(-Ni). Detected via ScS reflections — Weber et al. 2011.',
    }),
    Object.freeze({
        key: 'outer-core', name: 'Outer core',
        rInnerKm: 240, rOuterKm: 330, densityKgM3: 6200,
        state: 'fluid', vpKmS: 4.1, vsKmS: 0,
        note: 'FLUID iron alloy — S-waves do not cross it. Once hosted the dynamo.',
    }),
    Object.freeze({
        key: 'lvz', name: 'Partial-melt layer',
        rInnerKm: 330, rOuterKm: 480, densityKgM3: 3450,
        state: 'partial melt', vpKmS: 7.5, vsKmS: 3.2,
        note: 'Low-velocity zone at the mantle base; T sits at/above the solidus here.',
    }),
    Object.freeze({
        key: 'mantle', name: 'Mantle',
        rInnerKm: 480, rOuterKm: R_MOON_KM - 40, densityKgM3: 3375,
        state: 'solid', vpKmS: 7.8, vsKmS: 4.4,
        note: 'Olivine–pyroxene. Deep moonquake nests live in its lower third.',
    }),
    Object.freeze({
        key: 'crust', name: 'Crust',
        rInnerKm: R_MOON_KM - 40, rOuterKm: R_MOON_KM, densityKgM3: 2550,
        state: 'solid', vpKmS: 5.5, vsKmS: 3.2,
        note: 'Anorthositic. GRAIL bulk density 2550 kg/m³ — far more porous than pre-GRAIL estimates.',
    }),
]);

/** Layer containing radius rKm (surface belongs to the crust). */
export function layerAt(rKm) {
    if (rKm < 0 || rKm > R_MOON_KM) return null;
    for (const L of LAYERS) {
        if (rKm >= L.rInnerKm && (rKm < L.rOuterKm || L.rOuterKm === R_MOON_KM)) return L;
    }
    return null;
}

// ── Mass / gravity / pressure profiles ───────────────────────────────────────
// Hydrostatic integration on a 1 km grid, built once at module load.
//   m(r)  = ∫ 4πr²ρ dr          (center out)
//   g(r)  = G m(r) / r²
//   P(r)  = ∫ ρ g dr            (surface in, P(R)=0)
const _N = 1738;                               // grid spans exactly [0, R_MOON_KM]
const _DR_KM = R_MOON_KM / (_N - 1);           // ≈ 1.0002 km
const _massKg = new Float64Array(_N);
const _gMS2 = new Float64Array(_N);
const _pGPa = new Float64Array(_N);
{
    const dr = _DR_KM * 1e3;
    for (let i = 1; i < _N; i++) {
        const rMid = (i - 0.5) * _DR_KM;
        const rho = layerAt(rMid)?.densityKgM3 ?? 0;
        const rMidM = rMid * 1e3;
        _massKg[i] = _massKg[i - 1] + 4 * Math.PI * rMidM * rMidM * rho * dr;
    }
    for (let i = 1; i < _N; i++) {
        const rM = i * _DR_KM * 1e3;
        _gMS2[i] = G_NEWTON * _massKg[i] / (rM * rM);
    }
    for (let i = _N - 2; i >= 0; i--) {
        const rMid = (i + 0.5) * _DR_KM;
        const rho = layerAt(rMid)?.densityKgM3 ?? 0;
        const gMid = (_gMS2[i] + _gMS2[i + 1]) / 2;
        _pGPa[i] = _pGPa[i + 1] + rho * gMid * dr / 1e9;
    }
}
export const MOON_MASS_MODEL_KG = _massKg[_N - 1];

function _sample(arr, rKm) {
    const x = Math.min(Math.max(rKm, 0), R_MOON_KM) / _DR_KM;
    const i = Math.min(Math.floor(x), _N - 2);
    const f = x - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
}
export function enclosedMassKg(rKm) { return _sample(_massKg, rKm); }
export function gravityMS2(rKm) { return _sample(_gMS2, rKm); }
export function pressureGPa(rKm) { return _sample(_pGPa, rKm); }

// ── Selenotherm + solidus → derived melt fraction ────────────────────────────
// Piecewise-linear anchors; monotone decreasing outward (the test checks).
const _T_ANCHORS = [
    [0, 1700], [240, 1680], [330, 1650], [480, 1600],
    [800, 1450], [1200, 1100], [1500, 800], [R_MOON_KM - 40, 520], [R_MOON_KM, 250],
];
// Silicate solidus (pressure raises it with depth; only meaningful for r ≥ CMB).
const _SOL_ANCHORS = [
    [330, 1620], [480, 1610], [800, 1550], [1200, 1480], [R_MOON_KM, 1380],
];
const _LIQUIDUS_MINUS_SOLIDUS_K = 400;

function _interp(anchors, rKm) {
    const r = Math.min(Math.max(rKm, anchors[0][0]), anchors[anchors.length - 1][0]);
    for (let i = 1; i < anchors.length; i++) {
        if (r <= anchors[i][0]) {
            const [r0, v0] = anchors[i - 1];
            const [r1, v1] = anchors[i];
            return v0 + (v1 - v0) * (r - r0) / (r1 - r0);
        }
    }
    return anchors[anchors.length - 1][1];
}

export function selenothermK(rKm) { return _interp(_T_ANCHORS, rKm); }
export function solidusK(rKm) { return _interp(_SOL_ANCHORS, rKm); }

/**
 * Silicate melt fraction φ = (T − T_sol)/(T_liq − T_sol), clamped ≥ 0.
 * Zero in the core (iron, different phase diagram) — the fluid outer core's
 * state is carried by LAYERS, not by this silicate solidus.
 */
export function meltFraction(rKm) {
    if (rKm < 330 || rKm > R_MOON_KM) return 0;
    const dT = selenothermK(rKm) - solidusK(rKm);
    return Math.max(0, Math.min(1, dT / _LIQUIDUS_MINUS_SOLIDUS_K));
}

// ── Crustal thickness — degree-1 approximation of the GRAIL map ──────────────
// Nearside (facing Earth, lon 0) ~30 km, farside ~52 km. A one-term cosine in
// angular distance from the sub-Earth point (0°N, 0°E); the real GRAIL map has
// much more structure (mare floors <25 km, farside highlands to ~60 km).
export function crustThicknessKm(latDeg, lonDeg) {
    const lat = latDeg * Math.PI / 180;
    const lon = lonDeg * Math.PI / 180;
    const cosGamma = Math.cos(lat) * Math.cos(lon); // angular distance from (0,0)
    return 41 - 11 * cosGamma;
}

// ── Deep moonquakes ──────────────────────────────────────────────────────────
export const ANOMALISTIC_MONTH_DAYS = 27.554550;
/** Reference perigee: 2016-11-14 11:23 UTC — closest perigee since 1948 (356,509 km). */
export const REF_PERIGEE_MS = Date.UTC(2016, 10, 14, 11, 23, 0);

/** Anomalistic phase ∈ [0,1): 0 = perigee, 0.5 = apogee. */
export function anomalisticPhase(dateOrMs) {
    const ms = typeof dateOrMs === 'number' ? dateOrMs : dateOrMs.getTime();
    const cycles = (ms - REF_PERIGEE_MS) / (ANOMALISTIC_MONTH_DAYS * 86400000);
    return ((cycles % 1) + 1) % 1;
}

/**
 * Relative deep-moonquake occurrence rate vs tidal phase (dimensionless,
 * ~1 at the quiet floor). Activity clusters at the tidal-stress extremes:
 * a strong peak near perigee and a weaker one near apogee — some nests fire
 * preferentially at one, some at the other (Nakamura 2005). Schematic shape;
 * the periodicity and the peak locations are the physical content.
 */
export function deepMoonquakeRate(phase) {
    const p = ((phase % 1) + 1) % 1;
    const gauss = (x, mu, sigma) => {
        let d = Math.abs(x - mu);
        if (d > 0.5) d = 1 - d;               // wrap on the circle
        return Math.exp(-(d * d) / (2 * sigma * sigma));
    };
    return 1 + 3.0 * gauss(p, 0, 0.06) + 1.2 * gauss(p, 0.5, 0.08);
}

/**
 * Deep moonquake nests. A1 is the real, most active nest of the Apollo
 * network era. The remainder are REPRESENTATIVE of the Nakamura (2005)
 * catalogue's statistics — nearside-clustered (the network couldn't locate
 * farside events), depths 750–1100 km — not verbatim catalogue entries.
 */
export const DEEP_NESTS = Object.freeze([
    Object.freeze({ id: 'A1', latDeg: -15.7, lonDeg: -36.6, depthKm: 867, events: 400, real: true }),
    Object.freeze({ id: 'N2', latDeg: 12.0, lonDeg: -8.0, depthKm: 910, events: 180, real: false }),
    Object.freeze({ id: 'N3', latDeg: -32.0, lonDeg: 18.0, depthKm: 1050, events: 140, real: false }),
    Object.freeze({ id: 'N4', latDeg: 24.0, lonDeg: 42.0, depthKm: 790, events: 120, real: false }),
    Object.freeze({ id: 'N5', latDeg: 4.0, lonDeg: 61.0, depthKm: 980, events: 90, real: false }),
    Object.freeze({ id: 'N6', latDeg: -8.0, lonDeg: -62.0, depthKm: 1100, events: 85, real: false }),
    Object.freeze({ id: 'N7', latDeg: 38.0, lonDeg: -15.0, depthKm: 840, events: 70, real: false }),
    Object.freeze({ id: 'N8', latDeg: -22.0, lonDeg: -12.0, depthKm: 760, events: 60, real: false }),
]);

/**
 * Shallow moonquakes — the colony-relevant hazard. 28 events recorded
 * 1969–1977, depths 50–220 km, several ≥ magnitude 5 (largest ≈ 5.5;
 * minutes-long shaking because dry regolith barely attenuates). Watters
 * et al. (2019) tie some to young thrust-fault scarps: the Moon is still
 * tectonically active.
 */
export const SHALLOW_QUAKE_FACTS = Object.freeze({
    recorded: 28, years: '1969–1977',
    depthRangeKm: [50, 220], largestMagnitude: 5.5,
    note: 'Rare but energetic; shaking persists for tens of minutes — a real structural design constraint for surface habitats.',
});

// ── The dead dynamo ──────────────────────────────────────────────────────────
export const DYNAMO_EPOCHS = Object.freeze([
    Object.freeze({ fromGa: 4.42, toGa: 4.25, label: 'Onset', fieldMicroT: [0, 20] }),
    Object.freeze({ fromGa: 4.25, toGa: 3.56, label: 'High-field epoch', fieldMicroT: [20, 110] }),
    Object.freeze({ fromGa: 3.56, toGa: 1.9, label: 'Weak-field decline', fieldMicroT: [3, 20] }),
    Object.freeze({ fromGa: 1.9, toGa: 0.8, label: 'Dying', fieldMicroT: [0, 3] }),
    Object.freeze({ fromGa: 0.8, toGa: 0, label: 'Dead — crustal remanence only', fieldMicroT: [0, 0] }),
]);

/**
 * Estimated GLOBAL surface field strength (µT) at age Ga before present.
 * Piecewise through the paleointensity record (Weiss & Tikoo 2014; Mighani
 * et al. 2020). Central estimates — individual samples scatter widely.
 * Today's value is exactly 0: the dynamo is off.
 */
export function dynamoSurfaceFieldMicroT(ageGa) {
    const a = ageGa;
    if (a <= 0.8) return 0;
    if (a <= 1.9) return 3 * (a - 0.8) / (1.9 - 0.8);
    if (a <= 3.56) {
        // exponential-ish decline 50 → 3 µT going forward in time
        const f = (3.56 - a) / (3.56 - 1.9);   // 0 at 3.56 Ga, 1 at 1.9 Ga
        return 50 * Math.pow(3 / 50, f);
    }
    if (a <= 4.25) return 50;
    if (a <= 4.42) return 50 * (4.42 - a) / (4.42 - 4.25);
    return 0;
}

/** Named crustal magnetic anomalies — what remains of the field today. */
export const CRUSTAL_ANOMALIES = Object.freeze([
    Object.freeze({ name: 'Reiner Gamma', latDeg: 7.4, lonDeg: -59.1, note: 'The archetypal lunar swirl — magnetic anomaly deflecting solar wind.' }),
    Object.freeze({ name: 'Descartes', latDeg: -9.0, lonDeg: 15.7, note: 'Strongest surface field measured during Apollo 16 traverses.' }),
    Object.freeze({ name: 'Mare Ingenii', latDeg: -34.0, lonDeg: 164.0, note: 'Farside swirl field, antipodal to Mare Imbrium.' }),
    Object.freeze({ name: 'Gerasimovich', latDeg: -23.0, lonDeg: -123.0, note: 'Farside anomaly group, antipodal to Mare Crisium.' }),
]);
