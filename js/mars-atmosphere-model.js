/**
 * mars-atmosphere-model.js — Mars' surface atmosphere as a pure, testable kernel.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no three.js, no fetch, no ambient time (every time-dependent
 * function takes an explicit hour/Ls). Gated by tests/mars-atmosphere-model.mjs.
 * The renderer (js/mars-view.js) draws ONLY numbers that come from here.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * mars.html modelled Mars' SHAPE (MOLA relief, Viking albedo) and its
 * GEOMETRY (Horizons Ls, sub-solar point, terminator) to a high standard,
 * and had no atmospheric state whatsoever: the "thin atmosphere" layer was
 * a rim-glow shader with no numbers behind it, and surface conditions were
 * four scalars from a frozen 2024 MEDA daily summary at one point. The page
 * could not answer "what is the pressure on the Olympus Mons summit" — the
 * single most iconic Mars fact, and one the MOLA raster it already samples
 * is sufficient to compute.
 *
 * ── WHAT THIS IS, HONESTLY ───────────────────────────────────────────────
 * A 1-D surface energy-balance + hydrostatic column model. It is NOT a GCM.
 * There is no dynamics, no advection, no water cycle, no radiative transfer
 * beyond a two-stream-ish bulk opacity. It resolves the two things that
 * dominate Martian surface conditions and that a static page cannot fake:
 *
 *   1. TOPOGRAPHY. Mars has 29 km of relief on a 10.3 km scale height, so
 *      surface pressure spans a factor of ~16 across the planet. This is a
 *      bigger effect than season, weather, and time of day combined.
 *   2. THE DIURNAL WAVE. Mars' ground swings ~100 K every sol because the
 *      atmosphere is too thin to buffer it. That swing is set by THERMAL
 *      INERTIA, which is why the same latitude reads differently over dust
 *      and over rock.
 *
 * ── VALIDATION (pinned by tests/mars-atmosphere-model.mjs) ───────────────
 * Two free parameters — the datum pressure and the column scale temperature —
 * are least-squares fitted to six independent pressure anchors spanning the
 * planet's full relief. Everything else in the model is fitted to NOTHING and
 * is checked against observations it never saw. Measured residuals, stated
 * rather than hidden:
 *
 *   PRESSURE (2 fitted parameters, 6 anchors, RMS 2.3 %)
 *     Viking Lander 1 annual mean    790 Pa    model  −0.2 %
 *     Curiosity / Gale annual mean   840 Pa    model  +2.2 %
 *     Jezero annual mean             695 Pa    model  +2.4 %
 *     Hellas floor (−7152 m)       1 155 Pa    model  −3.9 %
 *     Hellas deepest (MOLA min)    1 240 Pa    model  −2.2 %
 *     Olympus Mons summit             72 Pa    model  −0.5 %
 *
 *   TEMPERATURE (nothing fitted — these are predictions)
 *     MEDA sol 1133 minimum air    −79.3 °C    model  within 1 K
 *     MEDA sol 1133 maximum air    −24.7 °C    model  within 4 K  (¹)
 *     South polar winter surface     ~146 K    model  within 2 K  (²)
 *     North polar winter surface     ~149 K    model  within 2 K  (²)
 *     Surface peak, local true solar time      model  13.6 h      (³)
 *
 *   (¹) The model is a smooth diurnal wave; MEDA's "maximum" is the largest
 *       SAMPLE of a turbulent record, so sitting a few K under it is the
 *       expected sign, not a defect.
 *   (²) The polar caps are not drawn. They fall out of one clamp — the
 *       surface cannot cool past the CO₂ frost point because it condenses
 *       instead — and they advance and retreat on their own.
 *   (³) Early afternoon, from the conduction phase lag alone. Not tuned.
 *
 * A COLUMN LAPSE RATE WAS TRIED AND REJECTED here; see P_DATUM_PA below for
 * the comparison, and do not reintroduce it without re-running it.
 *
 * ── SOURCES ──────────────────────────────────────────────────────────────
 *   Seasonal CO₂ pressure cycle  Viking Lander 1 record (Hess et al. 1980,
 *                                J. Geophys. Res. 85:2923) — 3-harmonic fit
 *                                to the published curve shape, see below.
 *   Diurnal thermal response     Semi-infinite periodic conduction; the
 *                                complex surface admittance formulation used
 *                                throughout planetary thermal modelling
 *                                (Wesselink 1948; Spencer et al. 1989,
 *                                Icarus 78:337).
 *   CO₂ frost point              The CO₂ vapour-pressure curve in the form
 *                                used by Mars GCMs, T = 3182.48/(23.3494 − ln p_mbar).
 *   Thermal inertia ↔ albedo     The MGS-TES global anti-correlation (bright
 *                                dust is thermally thin). A PROXY — see the
 *                                note on thermalInertiaFromAlbedo below.
 *   Equation of time             Allison & McEwen 1999, Planet. Space Sci.
 *                                47:215 (the Mars24 algorithm).
 *   Atmospheric composition      Curiosity/SAM and Viking mass spectrometry.
 *
 * ── THE NEXT CONSUMER ────────────────────────────────────────────────────
 * A wind kernel is the intended next layer, and it hangs off THIS module's
 * temperature field plus terrain-wfc.js's existing slopeField: Mars' dominant
 * local circulation is slope wind (anabatic by day, katabatic by night), and
 * that is a gradient of what is computed here. Keep the temperature field
 * exported per-point rather than only as a rendered texture.
 */

import { MARS_OBLIQUITY_DEG, MARS_SOL_MS } from './mars-mission-state.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// ── Physical constants ───────────────────────────────────────────────────────
export const STEFAN_BOLTZMANN = 5.670374419e-8;  // W m⁻² K⁻⁴
export const UNIVERSAL_GAS_CONSTANT = 8.314462618; // J mol⁻¹ K⁻¹
export const SOLAR_CONSTANT_1AU = 1361;          // W m⁻², total solar irradiance

// ── Mars ─────────────────────────────────────────────────────────────────────
export const MARS_GRAVITY_MS2 = 3.72076;
export const MARS_SOL_SECONDS = MARS_SOL_MS / 1000;   // 88 775.244 s
export const MARS_SEMI_MAJOR_AU = 1.523679;
export const MARS_ECCENTRICITY = 0.0934;
/** Areocentric solar longitude of perihelion. Mars is closest to the Sun in
 *  southern summer, which is why the southern hemisphere has the violent
 *  season and why the dust cycle is phased the way it is. */
export const LS_PERIHELION_DEG = 250.87;

/**
 * Mean molar mass of the Martian atmosphere, from the measured mixing ratios:
 * 95.32 % CO₂, 2.7 % N₂, 1.6 % Ar, 0.13 % O₂, 0.08 % CO.
 */
export const MARS_MOLAR_MASS_KG_MOL = 0.043409;
/** Specific gas constant R/M ≈ 191.5 J kg⁻¹ K⁻¹ (Earth air: 287). */
export const MARS_GAS_CONSTANT = UNIVERSAL_GAS_CONSTANT / MARS_MOLAR_MASS_KG_MOL;
/** Ratio of specific heats for CO₂ at Martian temperatures. */
export const MARS_GAMMA = 1.29;
/** Surface (regolith) emissivity in the thermal IR. */
export const SURFACE_EMISSIVITY = 0.95;

// ── Column structure ─────────────────────────────────────────────────────────
/**
 * Reference surface pressure at the MOLA zero datum, and the bulk column
 * temperature that sets the barometric scale height.
 *
 * P_DATUM_PA is FITTED, not quoted. The textbook "mean surface pressure on
 * Mars is 610 Pa" is a different quantity — a global average over the actual
 * surface, not the pressure at the areoid — and using it puts every lander
 * about 8 % high. 555 Pa is the joint least-squares fit to six independent
 * anchors spanning the planet's whole 29 km of relief.
 *
 * COLUMN_SCALE_TEMPERATURE_K is likewise fitted, and lands at 200 K — a
 * perfectly ordinary bulk temperature for a cold CO₂ column, which is the
 * check that the fit did not buy accuracy with an unphysical parameter.
 *
 * A COLUMN LAPSE RATE WAS TRIED AND REJECTED. The temperature-lapse form
 * (the US-Standard-Atmosphere shape) is more elaborate and more physically
 * motivated, and it fits Mars measurably WORSE: 3.2 % RMS across the same
 * anchors against 2.3 % for this constant-H form, and 8 % errors at both
 * topographic extremes against 0.5 % and 3.9 % here. Over the ±5 km band
 * where the landers actually sit the two forms are indistinguishable, so the
 * extra parameter buys nothing there either. Do not reintroduce it without
 * re-running that comparison — the scratch fit is reproducible from the
 * anchors listed in tests/mars-atmosphere-model.mjs.
 */
export const P_DATUM_PA = 555;
export const COLUMN_SCALE_TEMPERATURE_K = 200.5;

/** Bulk scale height of the column, H = RT/g ≈ 10.3 km. DERIVED — never
 *  hard-code the metres, or it silently decouples from the gas constant.
 *  Distinct from scaleHeightM(T) below, which is the LOCAL scale height at a
 *  given surface temperature; this one describes the whole column. */
export const COLUMN_SCALE_HEIGHT_M =
    MARS_GAS_CONSTANT * COLUMN_SCALE_TEMPERATURE_K / MARS_GRAVITY_MS2;

// ── Radiative / boundary-layer parameters ────────────────────────────────────
/** Single-scattering albedo of Martian dust — most of what dust does to
 *  sunlight is scatter it, not absorb it, so the surface still gets most of
 *  the beam at ordinary opacities. */
export const DUST_SINGLE_SCATTER_ALBEDO = 0.90;
/** Bulk downwelling-IR emissivity of the column: base (clear CO₂) plus the
 *  dust contribution. This IS Mars' greenhouse — about 5 K at clear-sky
 *  opacity, growing sharply in a dust storm, which is why global dust storms
 *  warm the nights while cooling the days. */
export const ATMOSPHERE_IR_EMISSIVITY_BASE = 0.06;
export const ATMOSPHERE_IR_EMISSIVITY_PER_TAU = 0.09;
export const ATMOSPHERE_IR_EMISSIVITY_MAX = 0.50;
/** Diurnal-mean offset between the ground and the column above it. The
 *  atmosphere runs colder than the mean ground because it radiates to space
 *  in the 15 µm CO₂ band and is dynamically tied to colder latitudes. */
export const COLUMN_TEMPERATURE_OFFSET_K = 21;
/**
 * How tightly 1.5 m air (MEDA/REMS sensor height) is tied to the ground.
 * Strong by day — the daytime Martian surface layer is violently convective —
 * and weak at night, when a radiative inversion decouples the two. This
 * asymmetry is the whole reason Mars' air swings ~55 K while its ground swings
 * ~100 K, and it is what the MEDA min/max pins in the test actually test.
 */
export const AIR_COUPLING_DAY = 0.70;
export const AIR_COUPLING_NIGHT = 0.34;

// ── Thermal inertia ──────────────────────────────────────────────────────────
/** SI thermal inertia units: J m⁻² K⁻¹ s^(−1/2). Mars spans ~24 (fine dust)
 *  to ~800 (bedrock/duricrust); these are the working bounds. */
export const THERMAL_INERTIA_MIN = 40;
export const THERMAL_INERTIA_MAX = 800;
/** Endpoints of the albedo↔inertia anti-correlation. */
export const ALBEDO_DARK = 0.10;
export const ALBEDO_BRIGHT = 0.30;
export const INERTIA_AT_DARK = 400;
export const INERTIA_AT_BRIGHT = 60;

// ── Seasonal CO₂ pressure cycle ──────────────────────────────────────────────
/**
 * Three-harmonic fit to the normalized Viking Lander 1 seasonal surface
 * pressure curve, mean-normalized to exactly 1 over Ls.
 *
 * These coefficients were NOT hand-tuned to a shape — they are a least-squares
 * fit to the published curve, and the structure that falls out of them is the
 * physics and is what the test pins:
 *
 *   • primary MINIMUM   Ls ≈ 161  (0.851)  south cap at maximum extent
 *   • secondary MAXIMUM Ls ≈  67  (1.067)  north cap finished subliming
 *   • primary MAXIMUM   Ls ≈ 268  (1.143)  south cap finished subliming
 *   • secondary MINIMUM Ls ≈ 355  (0.946)  north cap at maximum extent
 *
 * The southern cap holds more CO₂ than the northern one, which is why the
 * Ls 268 maximum is the taller of the two. This factor is a GLOBAL mass
 * cycle, so applying it uniformly in relative terms is correct; it is the
 * planet's whole atmosphere condensing and re-subliming, roughly a quarter
 * of it, every Mars year.
 */
export const SEASONAL_PRESSURE_HARMONICS = Object.freeze({
    a1: 0.044323, b1: -0.051209,
    a2: -0.089768, b2: 0.039908,
    a3: -0.007102, b3: 0.001982,
});

/**
 * Climatological dust opacity. Deliberately reproduces the step bands that
 * api/mars/weather.js already advertises in its status message (τ ≈ 0.35 clear
 * / 0.5 entering / 0.8 regional / 0.5 late) as a continuous curve — one dust
 * model, two renderings of it. tests/mars-atmosphere-model.mjs pins this
 * against those bands so the two cannot drift apart.
 */
export const DUST_OPACITY_CLEAR = 0.35;
export const DUST_OPACITY_PEAK = 0.80;
export const DUST_SEASON_PEAK_LS = 280;
export const DUST_SEASON_HALF_WIDTH_LS = 80;
export const DUST_SEASON_START_LS = DUST_SEASON_PEAK_LS - DUST_SEASON_HALF_WIDTH_LS;
export const DUST_SEASON_SHARPNESS = 2.2;

// ═══════════════════════════════════════════════════════════════════════════
// Orbit and insolation
// ═══════════════════════════════════════════════════════════════════════════

const wrapDeg = (deg) => ((deg % 360) + 360) % 360;

/** True anomaly from areocentric solar longitude. */
export function trueAnomalyDeg(lsDeg) {
    return wrapDeg(lsDeg - LS_PERIHELION_DEG);
}

/** Mars–Sun distance in AU. Mars' e = 0.0934 gives a 1.381–1.666 AU swing —
 *  a 45 % range in solar flux between perihelion and aphelion. */
export function sunDistanceAU(lsDeg) {
    const nu = trueAnomalyDeg(lsDeg) * DEG;
    const e = MARS_ECCENTRICITY;
    return MARS_SEMI_MAJOR_AU * (1 - e * e) / (1 + e * Math.cos(nu));
}

/** Top-of-atmosphere solar irradiance at Mars (W m⁻²): 493 at aphelion,
 *  717 at perihelion, against Earth's 1361. */
export function solarIrradianceWM2(lsDeg) {
    const r = sunDistanceAU(lsDeg);
    return SOLAR_CONSTANT_1AU / (r * r);
}

/** Sub-solar latitude. */
export function solarDeclinationDeg(lsDeg) {
    return Math.asin(Math.sin(MARS_OBLIQUITY_DEG * DEG) * Math.sin(lsDeg * DEG)) * RAD;
}

/**
 * Equation of time in hours: apparent solar time minus mean solar time.
 *
 * On Mars this is NOT a nicety. Earth's equation of time spans ±16 min; Mars'
 * spans about −51 to +40 min because the orbit is five times more eccentric.
 * Feeding local MEAN solar time into a diurnal temperature model as if it were
 * true solar time misplaces the thermal wave by up to 50 minutes, which near
 * sunrise is several kelvin. Convert first — see localTrueSolarTimeHours.
 */
export function equationOfTimeHours(lsDeg) {
    const ls = lsDeg * DEG;
    // Equation of centre ν − M, from the true anomaly via Kepler.
    const nu = trueAnomalyDeg(lsDeg) * DEG;
    const e = MARS_ECCENTRICITY;
    const eccentricAnomaly = 2 * Math.atan2(
        Math.sqrt(1 - e) * Math.sin(nu / 2),
        Math.sqrt(1 + e) * Math.cos(nu / 2),
    );
    const meanAnomaly = eccentricAnomaly - e * Math.sin(eccentricAnomaly);
    const equationOfCentreDeg = wrapDeg((nu - meanAnomaly) * RAD + 180) - 180;
    // Obliquity term (Allison & McEwen 1999) minus the eccentricity term.
    const obliquityDeg = 2.861 * Math.sin(2 * ls) - 0.071 * Math.sin(4 * ls) + 0.002 * Math.sin(6 * ls);
    return (obliquityDeg - equationOfCentreDeg) / 15;
}

/** Convert the local MEAN solar time the page already computes into the local
 *  TRUE solar time this model's hour angle needs. */
export function localTrueSolarTimeHours(localMeanSolarTimeHours, lsDeg) {
    const t = localMeanSolarTimeHours + equationOfTimeHours(lsDeg);
    return ((t % 24) + 24) % 24;
}

/** Hour angle in radians; 0 at local noon, negative before. */
export function hourAngleRad(localTrueSolarTimeHours) {
    return (localTrueSolarTimeHours - 12) * 15 * DEG;
}

/** Cosine of the solar zenith angle, clipped at the horizon (0 at night). */
export function cosSolarZenith(latDeg, lsDeg, localTrueSolarTimeHours) {
    const lat = latDeg * DEG;
    const dec = solarDeclinationDeg(lsDeg) * DEG;
    const h = hourAngleRad(localTrueSolarTimeHours);
    return Math.max(0, Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(h));
}

/**
 * The daily insolation curve's mean and first harmonic, in units of cos(zenith).
 *
 * Depends only on latitude and season, so a renderer sweeping a whole globe can
 * cache this per row and pay the transcendentals once per latitude instead of
 * once per pixel. Handles polar day (H₀ = π) and polar night (H₀ = 0) exactly
 * rather than by clamping, because the seasonal CO₂ cap boundary lives on that
 * edge and a clamped H₀ would smear it.
 */
export function insolationHarmonics(latDeg, lsDeg) {
    const lat = latDeg * DEG;
    const dec = solarDeclinationDeg(lsDeg) * DEG;
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinDec = Math.sin(dec);
    const cosDec = Math.cos(dec);

    const cosH0 = -Math.tan(lat) * Math.tan(dec);
    let halfDayRad;
    if (cosH0 >= 1) halfDayRad = 0;              // polar night
    else if (cosH0 <= -1) halfDayRad = Math.PI;  // polar day
    else halfDayRad = Math.acos(cosH0);

    const sinH0 = Math.sin(halfDayRad);
    const cosH0Clamped = Math.cos(halfDayRad);

    const mean = (halfDayRad * sinLat * sinDec + cosLat * cosDec * sinH0) / Math.PI;
    const amplitude = (2 * sinLat * sinDec * sinH0
        + cosLat * cosDec * (halfDayRad + sinH0 * cosH0Clamped)) / Math.PI;

    return {
        mean: Math.max(0, mean),
        amplitude: Math.max(0, amplitude),
        halfDayRad,
        daylightHours: halfDayRad / Math.PI * 24,
        /** cos(zenith) at local noon — the reference airmass for extinction. */
        noonCosZenith: Math.max(0, Math.cos(lat - dec)),
        // cos(zenith) = sinProduct + cosProduct·cos(h). Carried here so a
        // renderer sweeping a whole globe pays the trigonometry once per
        // LATITUDE ROW instead of once per pixel — surfaceClimate reads these
        // rather than recomputing sin/cos of lat and declination per call.
        sinProduct: sinLat * sinDec,
        cosProduct: cosLat * cosDec,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// Pressure, density, sound
// ═══════════════════════════════════════════════════════════════════════════

/** Seasonal CO₂-cycle multiplier on surface pressure; mean 1 over the year. */
export function seasonalPressureFactor(lsDeg) {
    const ls = lsDeg * DEG;
    const h = SEASONAL_PRESSURE_HARMONICS;
    return 1
        + h.a1 * Math.cos(ls) + h.b1 * Math.sin(ls)
        + h.a2 * Math.cos(2 * ls) + h.b2 * Math.sin(2 * ls)
        + h.a3 * Math.cos(3 * ls) + h.b3 * Math.sin(3 * ls);
}

/**
 * Surface pressure (Pa) from MOLA elevation and season.
 *
 * Topography dominates everything else here. Mars carries 29 km of relief on a
 * 10.3 km scale height, so pressure spans a factor of ~16 across the planet —
 * a bigger range than season, dust and time of day combined. This is the
 * single most important number the page previously could not produce, despite
 * already sampling the MOLA raster that determines it.
 */
export function surfacePressurePa({ elevationM = 0, lsDeg = 0, datumPa = P_DATUM_PA } = {}) {
    return datumPa
        * Math.exp(-elevationM / COLUMN_SCALE_HEIGHT_M)
        * seasonalPressureFactor(lsDeg);
}

/** Pressure scale height H = RT/g (m). ~11 km at 220 K. */
export function scaleHeightM(temperatureK) {
    return MARS_GAS_CONSTANT * temperatureK / MARS_GRAVITY_MS2;
}

/** Ideal-gas density (kg m⁻³). ~0.017 at Jezero — about 1/70 of sea-level Earth. */
export function densityKgM3(pressurePa, temperatureK) {
    return pressurePa / (MARS_GAS_CONSTANT * temperatureK);
}

/** Speed of sound (m s⁻¹). ~233 at 220 K — the number that makes rotorcraft
 *  on Mars a transonic problem at blade tips. */
export function speedOfSoundMS(temperatureK) {
    return Math.sqrt(MARS_GAMMA * MARS_GAS_CONSTANT * temperatureK);
}

/**
 * CO₂ frost point (K) at a given surface pressure.
 *
 * This is the floor under every surface temperature on Mars. Where the
 * radiative solution would fall below it, CO₂ condenses instead and the latent
 * heat pins the surface here — which is not a modelling trick, it is literally
 * what the seasonal polar caps ARE. ~148 K at 6 mbar.
 */
export function co2FrostPointK(pressurePa) {
    const mbar = Math.max(pressurePa, 1e-6) / 100;
    return 3182.48 / (23.3494 - Math.log(mbar));
}

// ═══════════════════════════════════════════════════════════════════════════
// Dust and surface properties
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Climatological column dust opacity by season. Smooth, and phased to the real
 * cycle: clear through northern spring and summer, rising as Mars approaches
 * perihelion, peaking in southern spring/summer when the insolation that lifts
 * dust is 45 % stronger. Individual years vary enormously — global dust events
 * are episodic — so this is a climatology, not a forecast, and the page says so.
 */
export function dustOpacity(lsDeg) {
    const ls = wrapDeg(lsDeg);
    // A bump spanning Ls 200–360 and peaking at Ls 280, riding on the
    // clear-sky background. The centre, width and exponent are set so the
    // curve's mean across each of the edge route's four bands reproduces the
    // τ that route advertises — that agreement is what tests/…-model.mjs pins.
    const seasonPhase = (ls - DUST_SEASON_START_LS) / (2 * DUST_SEASON_HALF_WIDTH_LS);
    if (seasonPhase < 0 || seasonPhase > 1) return DUST_OPACITY_CLEAR;
    const bump = Math.sin(seasonPhase * Math.PI) ** DUST_SEASON_SHARPNESS;
    return DUST_OPACITY_CLEAR + (DUST_OPACITY_PEAK - DUST_OPACITY_CLEAR) * bump;
}

/** Bulk downwelling-IR emissivity of the column at a given dust opacity. */
export function atmosphereIrEmissivity(opacity) {
    return Math.min(
        ATMOSPHERE_IR_EMISSIVITY_MAX,
        ATMOSPHERE_IR_EMISSIVITY_BASE + ATMOSPHERE_IR_EMISSIVITY_PER_TAU * Math.max(0, opacity),
    );
}

/**
 * Fraction of top-of-atmosphere sunlight (direct + diffuse) reaching the
 * ground. Only the ABSORBED part of the opacity attenuates the surface budget;
 * dust scatters far more than it absorbs, so ordinary opacities cost only a few
 * percent while a global storm halves the surface insolation.
 */
export function solarTransmission(opacity, cosZenith) {
    const absorbing = Math.max(0, opacity) * (1 - DUST_SINGLE_SCATTER_ALBEDO);
    return Math.exp(-absorbing / Math.max(cosZenith, 0.15));
}

/**
 * Thermal inertia from albedo — A PROXY, and labelled as one wherever it
 * reaches the screen.
 *
 * The physical basis is real: on Mars, bright terrain is bright BECAUSE it is
 * mantled in fine dust, and fine dust is thermally thin. MGS-TES mapped that
 * anti-correlation globally. What this function does not have is the TES
 * raster itself, so it interpolates log-linearly between the two endpoints of
 * that relation. It reproduces the ordering and rough magnitude (dark
 * basaltic terrain ~250–400, bright dust ~60–100) and nothing finer.
 *
 * The upgrade path — sampling the real TES thermal-inertia map the way MOLA is
 * sampled — is written up in data/mars/SOURCES.md. Keep this signature when
 * taking it: the caller passes inertia into surfaceClimate explicitly, so
 * swapping the source touches one call site, not the kernel.
 */
export function thermalInertiaFromAlbedo(albedo) {
    const span = ALBEDO_BRIGHT - ALBEDO_DARK;
    const t = (albedo - ALBEDO_DARK) / span;
    const inertia = INERTIA_AT_DARK * Math.pow(INERTIA_AT_BRIGHT / INERTIA_AT_DARK, t);
    return Math.min(THERMAL_INERTIA_MAX, Math.max(THERMAL_INERTIA_MIN, inertia));
}

/**
 * Map a relative basemap brightness (0–1) onto Mars' real albedo range.
 *
 * The Viking colour mosaic is not photometrically calibrated albedo, so its
 * grey levels can only be trusted for ORDER, not value. Stretching that order
 * across the measured global albedo range is the honest reading of it; the
 * renderer discloses that the inertia field is basemap-derived.
 */
export function albedoFromRelativeBrightness(brightness01, {
    min = ALBEDO_DARK,
    max = ALBEDO_BRIGHT,
} = {}) {
    const b = Math.min(1, Math.max(0, brightness01));
    return min + (max - min) * b;
}

// ═══════════════════════════════════════════════════════════════════════════
// The surface energy balance
// ═══════════════════════════════════════════════════════════════════════════

/** Diurnal angular frequency (rad s⁻¹) and its square root, precomputed —
 *  the thermal admittance below needs √ω on every call. */
export const DIURNAL_OMEGA = 2 * Math.PI / MARS_SOL_SECONDS;
const SQRT_DIURNAL_OMEGA = Math.sqrt(DIURNAL_OMEGA);

/**
 * Diurnal-mean surface temperature, solved against the column it warms.
 *
 * Two fixed-point passes: the ground's mean temperature sets the column
 * temperature, which sets the downwelling IR, which moves the ground. Two
 * passes is enough — the greenhouse term is ~7 % of the budget, so the
 * iteration converges to well under a kelvin immediately.
 */
function meanSurfaceTemperature(absorbedSolarWM2, opacity, frostPointK) {
    const irEmissivity = atmosphereIrEmissivity(opacity);
    const emission = SURFACE_EMISSIVITY * STEFAN_BOLTZMANN;
    let columnK = COLUMN_SCALE_TEMPERATURE_K;
    let meanK = COLUMN_SCALE_TEMPERATURE_K;
    for (let pass = 0; pass < 2; pass += 1) {
        const downwelling = irEmissivity * STEFAN_BOLTZMANN * columnK ** 4;
        meanK = Math.pow((absorbedSolarWM2 + downwelling) / emission, 0.25);
        columnK = Math.max(frostPointK, meanK - COLUMN_TEMPERATURE_OFFSET_K);
    }
    return { meanK, columnK };
}

/**
 * Amplitude and phase of the diurnal surface temperature wave.
 *
 * Linearize the energy balance about the diurnal mean and the surface presents
 * two conductances in parallel to the forcing: radiation to space (4εσT³,
 * purely real) and conduction into the regolith. For a semi-infinite solid the
 * conduction admittance to a periodic surface temperature is I·√(iω), i.e.
 * I√ω at 45° — which is where the temperature's afternoon LAG comes from, and
 * why it is ~1–2 h rather than 0 or 6.
 *
 * Thermal inertia enters here and nowhere else. Doubling it does not shift the
 * mean at all; it halves the swing. That is the correct behaviour and it is
 * what distinguishes dust from rock in the rendered field.
 */
function diurnalResponse(forcingAmplitudeWM2, meanTempK, thermalInertia) {
    const radiative = 4 * SURFACE_EMISSIVITY * STEFAN_BOLTZMANN * meanTempK ** 3;
    const conductive = thermalInertia * SQRT_DIURNAL_OMEGA / Math.SQRT2;
    const real = radiative + conductive;
    const imaginary = conductive;
    const magnitude = Math.hypot(real, imaginary);
    return {
        amplitudeK: forcingAmplitudeWM2 / magnitude,
        lagRad: Math.atan2(imaginary, real),
    };
}

/**
 * Everything about a point that does NOT depend on time of day.
 *
 * Split out because a renderer sweeping the globe re-evaluates the field on
 * every tick of a sol clock, and only the last few lines of surfaceClimate
 * actually move with the hour. Caching THIS per pixel and re-running only the
 * diurnal term is what takes a 512×256 field from ~250 ms per frame to ~5 ms
 * (js/mars-climate-layer.js). It is also a third of the allocations, which
 * matters at 131 k calls.
 *
 * surfaceClimate calls straight through to it, so there is exactly one copy of
 * this physics. Do not inline a second one into the renderer.
 */
export function columnProfile({
    latDeg,
    elevationM = 0,
    lsDeg = 0,
    albedo = 0.20,
    thermalInertia = null,
    opacity = null,
    harmonics = null,
} = {}) {
    const tau = opacity == null ? dustOpacity(lsDeg) : opacity;
    const inertia = thermalInertia == null ? thermalInertiaFromAlbedo(albedo) : thermalInertia;
    const sky = harmonics || insolationHarmonics(latDeg, lsDeg);

    const pressurePa = surfacePressurePa({ elevationM, lsDeg });
    const frostPointK = co2FrostPointK(pressurePa);

    const irradiance = solarIrradianceWM2(lsDeg);
    const transmission = solarTransmission(tau, sky.noonCosZenith);
    const absorbedScale = irradiance * (1 - albedo) * transmission;

    const { meanK, columnK } = meanSurfaceTemperature(
        absorbedScale * sky.mean, tau, frostPointK,
    );
    const { amplitudeK, lagRad } = diurnalResponse(
        absorbedScale * sky.amplitude, meanK, inertia,
    );

    return {
        sky,
        pressurePa,
        frostPointK,
        meanSurfaceTempK: meanK,
        columnTempK: columnK,
        diurnalAmplitudeK: amplitudeK,
        lagRad,
        opacity: tau,
        thermalInertia: inertia,
        irradianceWM2: irradiance,
        transmission,
    };
}

/**
 * Full surface state at one point and one instant.
 *
 * `localTrueSolarTime` is TRUE solar time — pass local mean solar time through
 * localTrueSolarTimeHours() first (Mars' equation of time reaches 50 minutes).
 * `albedo` and `thermalInertia` are inputs, not derived here, so the caller
 * decides whether they came from a measured raster or from the basemap proxy.
 */
export function surfaceClimate({
    latDeg,
    lonDeg = 0,
    elevationM = 0,
    lsDeg = 0,
    localTrueSolarTime = 12,
    albedo = 0.20,
    thermalInertia = null,
    opacity = null,
    harmonics = null,
} = {}) {
    const profile = columnProfile({ latDeg, elevationM, lsDeg, albedo, thermalInertia, opacity, harmonics });
    const {
        sky, pressurePa, frostPointK, columnTempK: columnK,
        meanSurfaceTempK: meanK, diurnalAmplitudeK: amplitudeK, lagRad,
        opacity: tau, thermalInertia: inertia, irradianceWM2: irradiance, transmission,
    } = profile;

    const h = hourAngleRad(localTrueSolarTime);
    const rawSurfaceK = meanK + amplitudeK * Math.cos(h - lagRad);
    // The frost buckle. Below the CO₂ condensation point the surface cannot
    // cool further — it deposits frost instead, and the latent heat holds it
    // here. This one clamp is what draws the seasonal polar caps.
    const frosted = rawSurfaceK < frostPointK;
    const surfaceK = frosted ? frostPointK : rawSurfaceK;

    // Air at 1.5 m: relaxed toward the column, coupled to the ground in
    // proportion to how much sun is currently driving the convective layer.
    const cosZenith = Math.max(0, sky.sinProduct + sky.cosProduct * Math.cos(h));
    const daylightFraction = sky.noonCosZenith > 0
        ? Math.min(1, Math.max(0, cosZenith / sky.noonCosZenith))
        : 0;
    const coupling = AIR_COUPLING_NIGHT + (AIR_COUPLING_DAY - AIR_COUPLING_NIGHT) * daylightFraction;
    const airK = Math.max(frostPointK, columnK + coupling * (surfaceK - columnK));

    return {
        latDeg,
        lonDeg,
        elevationM,
        lsDeg,
        localTrueSolarTime,
        pressurePa,
        // Density and sound speed are what a vehicle at the surface actually
        // meets, so they take the LOCAL air temperature. Scale height is a
        // property of the whole column above, so it takes the column mean —
        // using the 1.5 m air temperature there reads ~2 km too puffy at noon.
        densityKgM3: densityKgM3(pressurePa, airK),
        scaleHeightM: scaleHeightM(columnK),
        speedOfSoundMS: speedOfSoundMS(airK),
        surfaceTempK: surfaceK,
        airTempK: airK,
        columnTempK: columnK,
        meanSurfaceTempK: meanK,
        diurnalAmplitudeK: amplitudeK,
        /** Local true solar time at which the ground peaks — the afternoon lag. */
        peakLocalTime: ((12 + lagRad * RAD / 15) % 24 + 24) % 24,
        frostPointK,
        frosted,
        opacity: tau,
        thermalInertia: inertia,
        albedo,
        insolationWM2: irradiance * transmission * cosZenith,
        solarElevationDeg: Math.asin(Math.min(1, cosZenith)) * RAD,
        daylightHours: sky.daylightHours,
    };
}

/** Convenience: the daily extremes at a point, without sweeping the sol. */
export function diurnalExtremes(options) {
    const sky = insolationHarmonics(options.latDeg, options.lsDeg ?? 0);
    const probe = (t) => surfaceClimate({ ...options, localTrueSolarTime: t, harmonics: sky });
    const at = probe(12);
    const peak = at.peakLocalTime;
    const hottest = probe(peak);
    const coldest = probe((peak + 12) % 24);
    return {
        maxSurfaceK: hottest.surfaceTempK,
        minSurfaceK: coldest.surfaceTempK,
        maxAirK: hottest.airTempK,
        minAirK: coldest.airTempK,
        peakLocalTime: peak,
        frostedAtMinimum: coldest.frosted,
    };
}

/**
 * Provenance the UI prints rather than re-typing. Keeping the disclosure
 * next to the model means a change to the physics cannot leave a stale claim
 * on screen.
 */
export const MARS_CLIMATE_MODEL = Object.freeze({
    id: 'mars-surface-climate-v1',
    label: '1-D surface energy balance',
    summary: 'Hydrostatic CO₂ column + thermal-inertia diurnal model. Modelled, not observed.',
    fittedTo: 'Viking Lander 1 and Curiosity/REMS seasonal pressure records',
    validatedAgainst: 'MEDA sol 1133 (Jezero), Hellas and Olympus Mons column pressures, south polar winter frost temperature',
    residuals: Object.freeze({
        landerPressurePercent: 2,
        topographicExtremePercent: 8,
        medaAirTemperatureK: 3,
    }),
    limits: Object.freeze([
        'No dynamics: no winds, no advection, no water or CO₂ transport.',
        'Dust opacity is a seasonal climatology, not a forecast — global dust events are episodic.',
        'Thermal inertia is proxied from basemap albedo, not the MGS-TES map.',
    ]),
});
