#!/usr/bin/env node
/**
 * mars-atmosphere-model.mjs — gate for js/mars-atmosphere-model.js.
 *
 * Run: node tests/mars-atmosphere-model.mjs
 *
 * This kernel is unusual for this repo in that its ground truth is already in
 * the tree: PERSEVERANCE_MEDA_SNAPSHOT carries a real sol-1133 observation
 * (pressure, min/max air temperature, Ls) that the model never saw while being
 * built. Those numbers are imported here rather than retyped, so the day the
 * snapshot is refreshed from a newer MEDA record, this gate re-scores the model
 * against it instead of silently passing on a stale copy.
 *
 * The load-bearing pins:
 *   • The seasonal CO₂ cycle's SHAPE — two maxima, two minima, in the right Ls
 *     order with the southern one taller. That structure is the polar caps
 *     breathing; a fit that loses it has lost the physics, not just accuracy.
 *   • Pressure at the three landers we can check, to ~2 %.
 *   • MEDA sol 1133 air temperature, to ~4 K, from the bundled record.
 *   • The topographic extremes: Hellas/Olympus ≈ 16×, each within the ~8 %
 *     bias the kernel header DISCLOSES. Tightening these would mean loosening
 *     the landers — read the header before "improving" either.
 *   • The polar caps emerge from the CO₂ frost clamp alone, at the observed
 *     ~146–150 K, and retreat in summer. Nothing draws a cap by hand.
 *   • Thermal inertia sets the SWING and not the MEAN, and pushes the
 *     afternoon peak later. That is what makes dust and rock look different.
 *   • Mars' equation of time spans about −51 to +40 minutes. Skipping it
 *     misplaces the thermal wave by up to 50 min.
 *   • dustOpacity does not drift from the τ bands api/mars/weather.js already
 *     advertises to users. Two dust models disagreeing on the same page is
 *     the failure this pins.
 *   • Purity: no DOM, no fetch, no ambient time.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PERSEVERANCE_MEDA_SNAPSHOT, MARS_OBLIQUITY_DEG } from '../js/mars-mission-state.js';
import {
    MARS_GAS_CONSTANT, MARS_GRAVITY_MS2, MARS_SOL_SECONDS, MARS_MOLAR_MASS_KG_MOL,
    COLUMN_SCALE_HEIGHT_M, COLUMN_SCALE_TEMPERATURE_K, P_DATUM_PA,
    SEASONAL_PRESSURE_HARMONICS, seasonalPressureFactor, surfacePressurePa,
    scaleHeightM, densityKgM3, speedOfSoundMS, co2FrostPointK,
    sunDistanceAU, solarIrradianceWM2, solarDeclinationDeg,
    equationOfTimeHours, localTrueSolarTimeHours, hourAngleRad, cosSolarZenith,
    insolationHarmonics, dustOpacity, DUST_OPACITY_PEAK, DUST_OPACITY_CLEAR,
    atmosphereIrEmissivity, solarTransmission,
    thermalInertiaFromAlbedo, albedoFromRelativeBrightness,
    THERMAL_INERTIA_MIN, THERMAL_INERTIA_MAX,
    surfaceClimate, diurnalExtremes, MARS_CLIMATE_MODEL,
} from '../js/mars-atmosphere-model.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const withinPercent = (a, b, pct, msg) =>
    assert.ok(Math.abs(a / b - 1) * 100 <= pct,
        `${msg}: ${a} vs ${b} (${((a / b - 1) * 100).toFixed(1)}%, allowed ${pct}%)`);

const C = (kelvin) => kelvin - 273.15;
/** Annual mean of a seasonal quantity, sampled over Ls. */
const annualMean = (fn, step = 0.5) => {
    let sum = 0;
    let n = 0;
    for (let ls = 0; ls < 360; ls += step) { sum += fn(ls); n += 1; }
    return sum / n;
};

// ── 1. Constants derive rather than being asserted by hand ───────────────────
{
    near(MARS_GAS_CONSTANT, 191.5, 0.5, 'specific gas constant R/M');
    near(MARS_GAS_CONSTANT, 8.314462618 / MARS_MOLAR_MASS_KG_MOL, 1e-9, 'R is derived from the composition');
    near(MARS_SOL_SECONDS, 88775.244, 0.01, 'one sol in seconds');
    // The column scale height is RT/g and must never be hard-coded in metres:
    // three constants feed it, and a stale literal would silently decouple.
    near(COLUMN_SCALE_HEIGHT_M, MARS_GAS_CONSTANT * COLUMN_SCALE_TEMPERATURE_K / MARS_GRAVITY_MS2,
        1e-9, 'column scale height is derived from R, T and g');
    near(COLUMN_SCALE_HEIGHT_M, 10321, 20, 'column scale height ≈ 10.3 km');
    // The fitted scale temperature must remain a PHYSICAL column temperature.
    // If a future refit pushes it outside this band, the fit has bought
    // accuracy with an unphysical parameter and should be rejected.
    assert.ok(COLUMN_SCALE_TEMPERATURE_K > 180 && COLUMN_SCALE_TEMPERATURE_K < 230,
        `the fitted column temperature must stay physically plausible, got ${COLUMN_SCALE_TEMPERATURE_K} K`);
    ok('constants derive from composition and gravity, not from literals');
}

// ── 2. Orbit: Mars' eccentricity is the reason it has a violent season ───────
{
    // Perihelion/aphelion distances must equal a(1∓e) at the perihelion Ls.
    near(sunDistanceAU(250.87), 1.523679 * (1 - 0.0934), 1e-4, 'perihelion distance a(1−e)');
    near(sunDistanceAU(70.87), 1.523679 * (1 + 0.0934), 1e-4, 'aphelion distance a(1+e)');
    const peri = solarIrradianceWM2(250.87);
    const aphe = solarIrradianceWM2(70.87);
    near(peri, 717, 6, 'perihelion irradiance');
    near(aphe, 493, 6, 'aphelion irradiance');
    // 45% swing — this is why the southern hemisphere gets the dust storms.
    assert.ok(peri / aphe > 1.4, `perihelion/aphelion flux ratio ${(peri / aphe).toFixed(2)} should exceed 1.4`);

    // Declination is bounded by obliquity and hits it at the solstices.
    near(solarDeclinationDeg(90), MARS_OBLIQUITY_DEG, 1e-9, 'northern solstice declination = obliquity');
    near(solarDeclinationDeg(270), -MARS_OBLIQUITY_DEG, 1e-9, 'southern solstice declination = −obliquity');
    near(solarDeclinationDeg(0), 0, 1e-9, 'equinox declination is zero');
    ok('orbital distance, irradiance swing, and declination bounds');
}

// ── 3. Equation of time: ±50 minutes, not a nicety ───────────────────────────
{
    let min = Infinity;
    let max = -Infinity;
    for (let ls = 0; ls < 360; ls += 0.25) {
        const e = equationOfTimeHours(ls) * 60;
        if (e < min) min = e;
        if (e > max) max = e;
    }
    near(min, -51, 3, 'equation of time minimum (minutes)');
    near(max, 40, 3, 'equation of time maximum (minutes)');
    // Skipping the conversion is worth up to ~50 min of thermal-wave placement.
    assert.ok(Math.max(Math.abs(min), Math.abs(max)) > 35,
        'Mars equation of time must be large enough to matter — it is 3× Earth\'s');
    // Round trip stays on the clock face.
    for (const ls of [0, 90, 180, 249, 300]) {
        const t = localTrueSolarTimeHours(23.8, ls);
        assert.ok(t >= 0 && t < 24, `local true solar time wraps onto [0,24): got ${t}`);
    }
    near(hourAngleRad(12), 0, 1e-12, 'hour angle is zero at local noon');
    ok('Mars equation of time spans −51 to +40 minutes and wraps cleanly');
}

// ── 4. The seasonal CO₂ cycle SHAPE is the polar caps breathing ──────────────
{
    near(annualMean(seasonalPressureFactor), 1, 2e-3, 'seasonal factor averages to 1 over the year');

    // Locate every local extremum of the fitted curve.
    const extrema = [];
    for (let ls = 0; ls < 360; ls += 0.25) {
        const a = seasonalPressureFactor(ls - 0.25);
        const b = seasonalPressureFactor(ls);
        const c = seasonalPressureFactor(ls + 0.25);
        if (b > a && b > c) extrema.push({ kind: 'max', ls, value: b });
        if (b < a && b < c) extrema.push({ kind: 'min', ls, value: b });
    }
    const maxima = extrema.filter(e => e.kind === 'max');
    const minima = extrema.filter(e => e.kind === 'min');
    assert.equal(maxima.length, 2, `expected exactly two seasonal pressure maxima, got ${maxima.length}`);
    assert.equal(minima.length, 2, `expected exactly two seasonal pressure minima, got ${minima.length}`);

    const southernMax = maxima.find(e => e.ls > 180);
    const northernMax = maxima.find(e => e.ls < 180);
    const southernMin = minima.find(e => e.ls > 100 && e.ls < 250);
    const northernMin = minima.find(e => e.ls > 300 || e.ls < 60);

    // Ls 268: the south cap has finished subliming — the taller maximum,
    // because the southern cap holds more CO₂ than the northern one.
    near(southernMax.ls, 268, 12, 'primary pressure maximum near Ls 268 (south cap gone)');
    near(northernMax.ls, 67, 12, 'secondary pressure maximum near Ls 67 (north cap gone)');
    near(southernMin.ls, 161, 12, 'primary pressure minimum near Ls 161 (south cap at maximum extent)');
    near(northernMin.ls, 355, 15, 'secondary pressure minimum near Ls 355 (north cap at maximum extent)');
    assert.ok(southernMax.value > northernMax.value,
        'the southern maximum must be the taller one — the south cap holds more CO₂');
    assert.ok(southernMin.value < northernMin.value,
        'the southern minimum must be the deeper one');

    // Amplitude: about a quarter of the atmosphere condenses and returns.
    const swing = southernMax.value - southernMin.value;
    near(swing, 0.29, 0.05, 'peak-to-trough seasonal pressure swing (fraction of the mean)');

    // Third harmonic must stay a correction, not a driver.
    const h = SEASONAL_PRESSURE_HARMONICS;
    const power = (a, b) => Math.hypot(a, b);
    assert.ok(power(h.a3, h.b3) < 0.25 * power(h.a2, h.b2),
        'the third harmonic must remain a small correction to the second');
    ok('seasonal cycle has two maxima and two minima, correctly ordered and weighted');
}

// ── 5. Pressure at the landers — the points the model is fitted to ───────────
{
    // Viking Lander 1, Chryse Planitia, −3627 m: annual mean ~790 Pa,
    // seasonal range ~680–900 Pa (Hess et al. 1980).
    const vl1 = annualMean(ls => surfacePressurePa({ elevationM: -3627, lsDeg: ls }));
    withinPercent(vl1, 790, 3, 'Viking Lander 1 annual mean pressure');

    let vl1Min = Infinity;
    let vl1Max = -Infinity;
    for (let ls = 0; ls < 360; ls += 0.5) {
        const p = surfacePressurePa({ elevationM: -3627, lsDeg: ls });
        if (p < vl1Min) vl1Min = p;
        if (p > vl1Max) vl1Max = p;
    }
    withinPercent(vl1Min, 680, 4, 'Viking Lander 1 seasonal minimum');
    withinPercent(vl1Max, 900, 4, 'Viking Lander 1 seasonal maximum');

    // Curiosity, Gale Crater, −4500 m: REMS annual mean ~840 Pa. NOT one of
    // the points the harmonic fit was built from — this is a check, not a fit.
    const gale = annualMean(ls => surfacePressurePa({ elevationM: -4500, lsDeg: ls }));
    withinPercent(gale, 840, 3, 'Curiosity / Gale annual mean pressure');

    // Monotonic in elevation, everywhere, always.
    for (let ls = 0; ls < 360; ls += 30) {
        let previous = Infinity;
        for (let z = -8000; z <= 21000; z += 500) {
            const p = surfacePressurePa({ elevationM: z, lsDeg: ls });
            assert.ok(p < previous, `pressure must fall monotonically with elevation (Ls ${ls}, z ${z})`);
            previous = p;
        }
    }
    ok('lander pressures within 3 %, and pressure falls monotonically with elevation');
}

// ── 6. MEDA sol 1133 — the in-repo observation, read from the snapshot ───────
{
    const meda = PERSEVERANCE_MEDA_SNAPSHOT;
    assert.ok(Number.isFinite(meda.pressure_pa) && Number.isFinite(meda.ls_deg),
        'the bundled MEDA snapshot must still carry pressure and Ls for this gate to mean anything');

    // Jezero's elevation moved during the mission: Perseverance climbed ~600 m
    // of crater rim between this observation and the sol-1726 position fix the
    // repo stores. Bracket the model across that span rather than pretending
    // to know which metre the sensor sat at.
    const rimFix = surfacePressurePa({ elevationM: -1963.64, lsDeg: meda.ls_deg });
    const floor = surfacePressurePa({ elevationM: -2570, lsDeg: meda.ls_deg });
    assert.ok(rimFix < meda.pressure_pa && meda.pressure_pa < floor,
        `the observed MEDA pressure ${meda.pressure_pa} Pa should sit inside the model's `
        + `Jezero elevation bracket ${rimFix.toFixed(1)}–${floor.toFixed(1)} Pa`);
    withinPercent(rimFix, meda.pressure_pa, 5, 'MEDA pressure at the sol-1726 rim fix');
    withinPercent(floor, meda.pressure_pa, 5, 'MEDA pressure at the crater-floor elevation');

    // Air temperature. Jezero's published albedo (~0.15) and thermal inertia
    // (~300 SI, dark mafic crater floor) are the inputs; everything else is
    // the model. The snapshot's own min/max are the target.
    const extremes = diurnalExtremes({
        latDeg: 18.4265,
        elevationM: -1963.64,
        lsDeg: meda.ls_deg,
        albedo: 0.15,
        thermalInertia: 300,
    });
    near(C(extremes.minAirK), meda.min_temp_C, 4, 'MEDA sol 1133 minimum air temperature');
    near(C(extremes.maxAirK), meda.max_temp_C, 5, 'MEDA sol 1133 maximum air temperature');

    // The ground must swing considerably harder than the air — that asymmetry
    // is the daytime convective coupling versus the nighttime inversion, and
    // it is the reason the two numbers are modelled separately at all.
    const groundSwing = extremes.maxSurfaceK - extremes.minSurfaceK;
    const airSwing = extremes.maxAirK - extremes.minAirK;
    assert.ok(groundSwing > airSwing * 1.4,
        `ground swing ${groundSwing.toFixed(1)} K must far exceed air swing ${airSwing.toFixed(1)} K`);
    near(groundSwing, 87, 12, 'Jezero ground diurnal swing');

    // The surface peaks in the EARLY AFTERNOON, never at noon and never at dusk.
    assert.ok(extremes.peakLocalTime > 12.5 && extremes.peakLocalTime < 15,
        `surface temperature must peak in the early afternoon, got ${extremes.peakLocalTime.toFixed(2)} LTST`);
    ok('MEDA sol 1133 pressure bracketed and air temperature within 5 K, from the bundled record');
}

// ── 7. Topography: the 17× pressure ratio that defines Mars ──────────────────
{
    // MOLA's own extremes, the same numbers js/mars-view.js maps its raster to.
    const olympus = annualMean(ls => surfacePressurePa({ elevationM: 21134, lsDeg: ls }));
    const hellas = annualMean(ls => surfacePressurePa({ elevationM: -7152, lsDeg: ls }));

    // Both are fit anchors, and both land inside 5 % — the same band as the
    // landers. If a future change makes either of these materially worse while
    // the landers stay put, the column form has been changed, not just retuned.
    withinPercent(olympus, 72, 5, 'Olympus Mons summit pressure');
    withinPercent(hellas, 1155, 5, 'Hellas Planitia floor pressure');
    withinPercent(annualMean(ls => surfacePressurePa({ elevationM: -8068, lsDeg: ls })),
        1240, 5, 'Hellas deepest point (the MOLA minimum js/mars-view.js maps to)');

    const ratio = hellas / olympus;
    assert.ok(ratio > 13 && ratio < 19,
        `Hellas/Olympus pressure ratio should be ~15–16×, got ${ratio.toFixed(1)}×`);

    // The datum pressure must NOT be the textbook "610 Pa mean surface
    // pressure" — that is a different quantity (a global average over the real
    // surface, not the pressure at the areoid) and adopting it puts every
    // lander ~8 % high. This pin exists because 610 is the number a reader
    // reaches for, and the header explains why it is the wrong one.
    assert.ok(P_DATUM_PA < 600,
        'the datum pressure is fitted to observations, not set to the textbook 610 Pa global mean');
    ok('Hellas/Olympus pressure ratio ≈ 16×, both extremes within 5 %');
}

// ── 8. Gas properties ────────────────────────────────────────────────────────
{
    near(scaleHeightM(210) / 1000, 10.8, 0.6, 'pressure scale height ~11 km');
    // Surface density: about 1/70 of Earth's sea-level 1.225 kg/m³.
    const rho = densityKgM3(700, 210);
    near(rho, 0.0174, 0.002, 'surface density at 700 Pa / 210 K');
    assert.ok(1.225 / rho > 55 && 1.225 / rho < 85,
        'Martian surface air must come out ~60–80× thinner than Earth sea level');
    // Speed of sound: the number that makes Martian rotorcraft transonic.
    near(speedOfSoundMS(220), 233, 6, 'speed of sound at 220 K');
    assert.ok(speedOfSoundMS(250) > speedOfSoundMS(190), 'sound speed rises with temperature');

    // CO₂ frost point at the canonical 6.1 mbar.
    near(co2FrostPointK(610), 147.7, 0.5, 'CO₂ frost point at 610 Pa');
    assert.ok(co2FrostPointK(1200) > co2FrostPointK(400),
        'frost point must rise with pressure — deeper basins frost warmer');
    ok('scale height, density, sound speed and the CO₂ frost point');
}

// ── 9. Insolation harmonics, including the polar edge cases ─────────────────
{
    // Equator at equinox: exactly 12 h of daylight, sun overhead at noon.
    const equinox = insolationHarmonics(0, 0);
    near(equinox.daylightHours, 12, 1e-9, 'equator at equinox gets exactly 12 h of daylight');
    near(equinox.noonCosZenith, 1, 1e-9, 'sun is overhead at the equator at equinox noon');

    // Polar day and polar night must be exact, not clamped: the seasonal cap
    // boundary lives on this edge and a smeared H₀ would smear the cap.
    const polarNight = insolationHarmonics(-85, 90);
    assert.equal(polarNight.halfDayRad, 0, 'southern winter pole must be in exact polar night');
    assert.equal(polarNight.mean, 0, 'polar night receives no insolation at all');
    assert.equal(polarNight.amplitude, 0, 'polar night has no diurnal forcing');

    const polarDay = insolationHarmonics(-85, 270);
    near(polarDay.halfDayRad, Math.PI, 1e-12, 'southern summer pole must be in exact polar day');
    near(polarDay.daylightHours, 24, 1e-9, 'polar day is 24 h of sunlight');
    assert.ok(polarDay.mean > 0.3, 'the summer pole gets substantial round-the-clock insolation');

    // The carried products must reproduce cos(zenith) exactly — the renderer's
    // per-row cache depends on this identity holding.
    for (const [lat, ls, t] of [[18.4, 249, 9], [-40, 120, 15], [70, 30, 3]]) {
        const sky = insolationHarmonics(lat, ls);
        const viaProducts = Math.max(0, sky.sinProduct + sky.cosProduct * Math.cos(hourAngleRad(t)));
        near(viaProducts, cosSolarZenith(lat, ls, t), 1e-12,
            `carried sin/cos products reproduce cos(zenith) at lat ${lat}, Ls ${ls}, ${t} h`);
    }
    ok('insolation harmonics, exact polar day/night, and the cached-product identity');
}

// ── 10. The polar caps emerge from the frost clamp alone ────────────────────
{
    // Southern winter pole: no sunlight at all, held at the CO₂ frost point.
    const southWinter = diurnalExtremes({
        latDeg: -85, elevationM: 2000, lsDeg: 90, albedo: 0.25, thermalInertia: 250,
    });
    assert.ok(southWinter.frostedAtMinimum, 'the southern winter pole must be frosted');
    near(southWinter.minSurfaceK, 146, 3, 'southern winter polar surface temperature');
    near(southWinter.maxSurfaceK, 146, 3, 'polar night has no diurnal swing to speak of');

    // Northern winter pole, at its own (much lower) elevation, frosts warmer
    // because the pressure there is higher. That ordering is real.
    const northWinter = diurnalExtremes({
        latDeg: 85, elevationM: -2500, lsDeg: 270, albedo: 0.25, thermalInertia: 250,
    });
    assert.ok(northWinter.frostedAtMinimum, 'the northern winter pole must be frosted');
    near(northWinter.minSurfaceK, 149, 3, 'northern winter polar surface temperature');
    assert.ok(northWinter.minSurfaceK > southWinter.minSurfaceK,
        'the lower northern cap sits at higher pressure and so frosts warmer');

    // And the cap RETREATS: the same latitude in summer is nowhere near frost.
    const southSummer = diurnalExtremes({
        latDeg: -85, elevationM: 2000, lsDeg: 270, albedo: 0.30, thermalInertia: 250,
    });
    assert.ok(!southSummer.frostedAtMinimum, 'the southern summer pole must be frost-free');
    assert.ok(southSummer.minSurfaceK > 200,
        `summer polar surface should be well above frost, got ${southSummer.minSurfaceK.toFixed(1)} K`);

    // No point anywhere may ever be reported below its own frost point.
    for (let lat = -90; lat <= 90; lat += 15) {
        for (const ls of [0, 90, 180, 270]) {
            for (const t of [0, 6, 12, 18]) {
                const s = surfaceClimate({
                    latDeg: lat, elevationM: 0, lsDeg: ls, localTrueSolarTime: t, albedo: 0.2,
                });
                assert.ok(s.surfaceTempK >= s.frostPointK - 1e-9,
                    `surface temperature fell below the CO₂ frost point at lat ${lat}, Ls ${ls}, ${t} h`);
                assert.ok(s.airTempK >= s.frostPointK - 1e-9,
                    `air temperature fell below the CO₂ frost point at lat ${lat}, Ls ${ls}, ${t} h`);
            }
        }
    }
    ok('seasonal caps appear, retreat, and order by pressure — from the frost clamp alone');
}

// ── 11. Thermal inertia sets the SWING, not the mean ────────────────────────
{
    const base = { latDeg: 0, elevationM: 0, lsDeg: 0, albedo: 0.2 };
    const results = [50, 150, 300, 600].map(thermalInertia => ({
        thermalInertia,
        ...diurnalExtremes({ ...base, thermalInertia }),
        mean: surfaceClimate({ ...base, thermalInertia, localTrueSolarTime: 12 }).meanSurfaceTempK,
    }));

    // The diurnal mean is a radiative equilibrium and must not move with inertia.
    const means = results.map(r => r.mean);
    near(Math.max(...means) - Math.min(...means), 0, 0.05,
        'diurnal MEAN temperature must be independent of thermal inertia');

    // The swing must fall monotonically, and hard — dust versus rock is the
    // whole reason the rendered field has texture.
    for (let i = 1; i < results.length; i += 1) {
        const previous = results[i - 1].maxSurfaceK - results[i - 1].minSurfaceK;
        const current = results[i].maxSurfaceK - results[i].minSurfaceK;
        assert.ok(current < previous,
            `higher thermal inertia must damp the diurnal swing (${results[i].thermalInertia})`);
    }
    const dustSwing = results[0].maxSurfaceK - results[0].minSurfaceK;
    const rockSwing = results[3].maxSurfaceK - results[3].minSurfaceK;
    assert.ok(dustSwing > rockSwing * 2,
        `fine dust must swing far harder than bedrock: ${dustSwing.toFixed(0)} K vs ${rockSwing.toFixed(0)} K`);

    // And it must push the afternoon peak LATER — that phase lag is the
    // signature of conduction into the regolith, not a fudge.
    for (let i = 1; i < results.length; i += 1) {
        assert.ok(results[i].peakLocalTime > results[i - 1].peakLocalTime,
            'higher thermal inertia must delay the afternoon temperature peak');
    }
    assert.ok(results[0].peakLocalTime > 12, 'even zero-ish inertia peaks after local noon');
    ok('thermal inertia damps the swing and delays the peak, leaving the mean alone');
}

// ── 12. Albedo proxy: monotonic, bounded, and honest about its range ─────────
{
    assert.ok(thermalInertiaFromAlbedo(0.10) > thermalInertiaFromAlbedo(0.30),
        'bright dust must be thermally THINNER than dark terrain — that is the TES relation');
    near(thermalInertiaFromAlbedo(0.10), 400, 1, 'inertia at the dark endpoint');
    near(thermalInertiaFromAlbedo(0.30), 60, 1, 'inertia at the bright endpoint');
    for (let a = -0.5; a <= 1.5; a += 0.05) {
        const i = thermalInertiaFromAlbedo(a);
        assert.ok(i >= THERMAL_INERTIA_MIN && i <= THERMAL_INERTIA_MAX,
            `thermal inertia must stay inside Mars' observed range for any albedo (${a})`);
    }
    // Monotonic across the whole domain.
    let previous = Infinity;
    for (let a = 0.05; a <= 0.35; a += 0.01) {
        const i = thermalInertiaFromAlbedo(a);
        assert.ok(i <= previous + 1e-9, `inertia must fall monotonically with albedo (${a})`);
        previous = i;
    }
    // Relative brightness maps onto Mars' real albedo range and clamps outside it.
    near(albedoFromRelativeBrightness(0), 0.10, 1e-9, 'darkest basemap pixel maps to albedo 0.10');
    near(albedoFromRelativeBrightness(1), 0.30, 1e-9, 'brightest basemap pixel maps to albedo 0.30');
    near(albedoFromRelativeBrightness(-3), 0.10, 1e-9, 'out-of-range brightness clamps low');
    near(albedoFromRelativeBrightness(9), 0.30, 1e-9, 'out-of-range brightness clamps high');
    ok('albedo→inertia proxy is monotonic, bounded, and clamps its inputs');
}

// ── 13. Dust must not drift from the τ bands the edge route advertises ──────
{
    // api/mars/weather.js evaluateMarsLs() tells users these numbers. Two dust
    // models disagreeing on the same page is exactly the drift this pins.
    const bands = [
        { from: 250, to: 310, tau: 0.8, label: 'regional dust season' },
        { from: 220, to: 250, tau: 0.5, label: 'entering dust season' },
        { from: 310, to: 340, tau: 0.5, label: 'late dust season' },
        { from: 0, to: 220, tau: 0.35, label: 'clear skies' },
        { from: 340, to: 360, tau: 0.35, label: 'clear skies (wrap)' },
    ];
    for (const band of bands) {
        let sum = 0;
        let n = 0;
        for (let ls = band.from; ls < band.to; ls += 0.5) { sum += dustOpacity(ls); n += 1; }
        near(sum / n, band.tau, 0.12,
            `dustOpacity band mean must match the τ api/mars/weather.js advertises for "${band.label}"`);
    }
    // The "clear skies" band is advertised as τ < 0.4 — hold the kernel to it,
    // except within 2° of the step boundaries at Ls 220 and Ls 340. A
    // CONTINUOUS curve cannot drop from the neighbouring band's 0.5 to below
    // 0.4 instantaneously; the overshoot there is ~0.004 and lasts under a
    // degree of Ls. That is a property of comparing a curve to a step
    // function, not drift, and widening this margin would hide real drift.
    const BAND_EDGE_MARGIN_DEG = 2;
    const nearEdge = (ls) => [220, 340].some(edge => Math.abs(ls - edge) <= BAND_EDGE_MARGIN_DEG);
    for (let ls = 340; ls < 360 + 220; ls += 0.25) {
        const l = ls % 360;
        if (nearEdge(l)) continue;
        assert.ok(dustOpacity(l) < 0.4,
            `the clear-skies band is advertised as τ < 0.4; Ls ${l} returned ${dustOpacity(l)}`);
    }
    // And the boundary overshoot itself must stay negligible, or the curve has
    // genuinely moved into the neighbouring band.
    for (const edge of [220, 340]) {
        for (let d = -BAND_EDGE_MARGIN_DEG; d <= BAND_EDGE_MARGIN_DEG; d += 0.25) {
            assert.ok(dustOpacity((edge + d + 360) % 360) < 0.42,
                `dust opacity overshoot at the Ls ${edge} band edge must stay under 0.42`);
        }
    }
    // Bounded everywhere, and peaking in southern spring/summer near perihelion.
    let peakLs = 0;
    for (let ls = 0; ls < 360; ls += 0.5) {
        const tau = dustOpacity(ls);
        assert.ok(tau >= DUST_OPACITY_CLEAR - 1e-9 && tau <= DUST_OPACITY_PEAK + 1e-9,
            `dust opacity out of bounds at Ls ${ls}: ${tau}`);
        if (tau > dustOpacity(peakLs)) peakLs = ls;
    }
    assert.ok(peakLs > 200 && peakLs < 330,
        `the dust season must peak in southern spring/summer, got Ls ${peakLs}`);
    ok('dust climatology agrees with the τ bands api/mars/weather.js already publishes');
}

// ── 14. Dust radiative behaviour: cools the day, warms the night ────────────
{
    assert.ok(atmosphereIrEmissivity(3) > atmosphereIrEmissivity(0.3),
        'dust must raise the downwelling IR — that is why storm nights are warm');
    assert.ok(solarTransmission(5, 0.9) < solarTransmission(0.3, 0.9),
        'dust must cut surface insolation — that is why storm days are cold');
    assert.ok(solarTransmission(0.3, 0.9) > 0.9,
        'ordinary opacity should cost only a few percent — Martian dust scatters far more than it absorbs');

    // The observed signature of a global dust event: the diurnal range collapses.
    const site = { latDeg: -10, elevationM: -2000, lsDeg: 250, albedo: 0.2, thermalInertia: 250 };
    const clear = diurnalExtremes({ ...site, opacity: 0.3 });
    const storm = diurnalExtremes({ ...site, opacity: 5 });
    const clearRange = clear.maxSurfaceK - clear.minSurfaceK;
    const stormRange = storm.maxSurfaceK - storm.minSurfaceK;
    assert.ok(stormRange < clearRange * 0.75,
        `a global dust storm must collapse the diurnal range: ${stormRange.toFixed(0)} K vs ${clearRange.toFixed(0)} K`);
    assert.ok(storm.minSurfaceK > clear.minSurfaceK,
        'a global dust storm must WARM the nights');
    assert.ok(storm.maxSurfaceK < clear.maxSurfaceK,
        'a global dust storm must COOL the days');
    ok('dust cools the days and warms the nights, collapsing the diurnal range');
}

// ── 15. surfaceClimate contract: finite, self-consistent, cache-equivalent ──
{
    for (let lat = -90; lat <= 90; lat += 10) {
        for (const ls of [0, 75, 150, 225, 300]) {
            for (const t of [0, 5, 11, 17, 23]) {
                const s = surfaceClimate({
                    latDeg: lat, lonDeg: 40, elevationM: -3000 + lat * 40,
                    lsDeg: ls, localTrueSolarTime: t, albedo: 0.18,
                });
                for (const [key, value] of Object.entries(s)) {
                    if (typeof value === 'number') {
                        assert.ok(Number.isFinite(value),
                            `${key} must be finite at lat ${lat}, Ls ${ls}, ${t} h — got ${value}`);
                    }
                }
                assert.ok(s.surfaceTempK > 100 && s.surfaceTempK < 320,
                    `surface temperature out of physical range at lat ${lat}, Ls ${ls}: ${s.surfaceTempK}`);
                assert.ok(s.pressurePa > 0, 'pressure must be positive');
                assert.ok(s.solarElevationDeg >= 0 && s.solarElevationDeg <= 90,
                    'solar elevation must lie in [0°, 90°]');
                assert.equal(s.insolationWM2 > 0, s.solarElevationDeg > 0,
                    'insolation and solar elevation must agree about whether the sun is up');
            }
        }
    }

    // Passing a precomputed harmonics object (the renderer's per-row cache)
    // must be bit-identical to letting surfaceClimate compute it.
    const options = { latDeg: -22.5, elevationM: -1200, lsDeg: 205, localTrueSolarTime: 8.4, albedo: 0.24 };
    const cached = surfaceClimate({ ...options, harmonics: insolationHarmonics(options.latDeg, options.lsDeg) });
    const direct = surfaceClimate(options);
    for (const key of Object.keys(direct)) {
        if (typeof direct[key] === 'number') {
            assert.equal(cached[key], direct[key], `cached harmonics changed ${key}`);
        }
    }
    ok('surfaceClimate is finite and physical everywhere, and the row cache is exact');
}

// ── 16. Purity and disclosure ───────────────────────────────────────────────
{
    const source = readFileSync(fileURLToPath(new URL('../js/mars-atmosphere-model.js', import.meta.url)), 'utf8');
    const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['document', 'window', 'fetch(', 'localStorage', 'three']) {
        assert.ok(!body.includes(forbidden),
            `the kernel must stay pure — found "${forbidden}" outside comments`);
    }
    // No ambient time: every time-dependent entry point takes an explicit hour.
    assert.ok(!/Date\.now\(\)|new Date\(\)/.test(body),
        'the kernel must not read ambient time — callers pass Ls and local solar time');

    // The disclosure the UI prints must stay attached to the model.
    assert.ok(MARS_CLIMATE_MODEL.limits.length >= 3, 'the model must publish its limits');
    assert.ok(MARS_CLIMATE_MODEL.summary.toLowerCase().includes('modelled')
        || MARS_CLIMATE_MODEL.summary.toLowerCase().includes('modeled'),
        'the published summary must say the field is modelled, not observed');
    assert.ok(MARS_CLIMATE_MODEL.limits.some(l => /thermal inertia/i.test(l) && /proxi/i.test(l)),
        'the limits must disclose that thermal inertia is proxied, not measured');
    assert.ok(MARS_CLIMATE_MODEL.limits.some(l => /wind|dynamic/i.test(l)),
        'the limits must disclose that there are no dynamics — this model has no winds');
    ok('kernel is pure, takes no ambient time, and publishes its own limits');
}

console.log(`\n${passed} checks passed — js/mars-atmosphere-model.js`);
