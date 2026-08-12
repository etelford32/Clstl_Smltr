/**
 * Correctness gate for js/aqi-scale.js — the EPA AQI single source of truth.
 *
 * THE POINT OF THIS FILE: the bug it replaces survived because every existing
 * AQ test asserted that the surfaces agreed with EACH OTHER
 * (tests/aqi-heatmap.mjs, tests/intl-stations.mjs) while nothing pinned a
 * single value to an EPA breakpoint. Consistency tests cannot catch a shared
 * wrong table. Every assertion below is against the published EPA numbers, so
 * they fail if the table drifts even if every consumer drifts with it.
 *
 * Reference: 40 CFR Part 58 Appendix G; EPA-454/B-24-002. PM2.5 is the MAY
 * 2024 revision (Good tops out at 9.0 µg/m³).
 *
 * Run: node tests/aqi-scale.mjs
 */
import assert from 'node:assert/strict';
import {
    AQI_CATEGORIES,
    AQI_MAX,
    AQI_POLLUTANTS,
    aqiColor,
    aqiFromConcentration,
    categoryForAqi,
    compositeAqi,
    concentrationFromAqi,
    fromEpaUnit,
    subIndex,
    toEpaUnit,
    truncate,
} from '../js/aqi-scale.js';

// ── Breakpoint corners ─────────────────────────────────────────────────────
// Every (cLo → iLo) and (cHi → iHi) pair in the published tables. If a slope
// or an endpoint is mistyped, one of these fails immediately.
{
    for (const [key, spec] of Object.entries(AQI_POLLUTANTS)) {
        for (const [cLo, cHi, iLo, iHi] of spec.breakpoints) {
            assert.equal(aqiFromConcentration(key, cLo), iLo,
                `${key}: ${cLo} ${spec.epaUnit} → AQI ${iLo}`);
            assert.equal(aqiFromConcentration(key, cHi), iHi,
                `${key}: ${cHi} ${spec.epaUnit} → AQI ${iHi}`);
        }
    }
}

// ── The specific values the old formula got wrong ──────────────────────────
// Left column is what js/air-quality-frame.js used to produce.
{
    const pm25 = [           // [µg/m³, old wrong score, true EPA AQI]
        [25, 111, 81], [30, 130, 90], [35, 148, 99],
        [40, 159, 112], [55, 189, 149], [80, 239, 168], [125, 329, 200],
    ];
    for (const [c, wrong, right] of pm25) {
        const got = aqiFromConcentration('pm25', c);
        assert.equal(got, right, `PM2.5 ${c} µg/m³ → AQI ${right} (was ${wrong})`);
        assert.notEqual(got, wrong, `PM2.5 ${c} no longer scores ${wrong}`);
    }
    const pm10 = [[110, 106, 78], [154, 150, 100], [200, 196, 123], [254, 250, 150]];
    for (const [c, wrong, right] of pm10) {
        const got = aqiFromConcentration('pm10', c);
        assert.equal(got, right, `PM10 ${c} µg/m³ → AQI ${right} (was ${wrong})`);
        assert.notEqual(got, wrong, `PM10 ${c} no longer scores ${wrong}`);
    }
}

// ── EPA truncation, not rounding ───────────────────────────────────────────
// 9.09 µg/m³ of PM2.5 is Good; rounding it to 9.1 would make it Moderate and
// flip the category on the single most common boundary in the US.
{
    assert.equal(truncate(9.09, 1), 9.0);
    assert.equal(truncate(35.49, 1), 35.4);
    assert.equal(truncate(54.9, 0), 54);
    assert.equal(truncate(0.0549, 3), 0.054);
    assert.equal(aqiFromConcentration('pm25', 9.09), 50, '9.09 µg/m³ stays Good');
    assert.equal(aqiFromConcentration('pm25', 9.1), 51, '9.1 µg/m³ is Moderate');
    assert.equal(aqiFromConcentration('pm10', 54.9), 50, '54.9 µg/m³ stays Good');
    // Float representation must not drag a clean value down a step.
    assert.equal(truncate(35.4, 1), 35.4, 'binary float does not truncate 35.4 to 35.3');
    assert.equal(aqiFromConcentration('pm25', 35.4), 100);
}

// ── Monotonicity across the whole domain ───────────────────────────────────
{
    for (const key of ['pm25', 'pm10', 'co', 'no2']) {
        const spec = AQI_POLLUTANTS[key];
        const top = spec.breakpoints[spec.breakpoints.length - 1][1];
        let prev = -1;
        for (let i = 0; i <= 400; i++) {
            const v = (top * i) / 400;
            const aqi = aqiFromConcentration(key, v);
            assert.ok(aqi >= prev, `${key} is monotonic at ${v}`);
            assert.ok(aqi >= 0 && aqi <= AQI_MAX, `${key} AQI in range at ${v}`);
            prev = aqi;
        }
    }
}

// ── Clamping above the top breakpoint ──────────────────────────────────────
// The old formula was unbounded linear: PM2.5 500 µg/m³ scored 1079.
{
    const r = subIndex('pm25', 900);
    assert.equal(r.aqi, AQI_MAX, 'PM2.5 far above the table clamps to 500');
    assert.ok(r.clamped, 'clamping is reported, not silent');
    assert.ok(r.note, 'clamping carries a reason');
    assert.equal(aqiFromConcentration('pm25', 325.4), 500, 'top breakpoint is exactly 500');
}

// ── Partial tables report honestly instead of guessing ─────────────────────
{
    // 1-hour O₃ does not report below AQI 101.
    const lowO3 = subIndex('o3_1h', 0.05);
    assert.equal(lowO3.aqi, null, '1-h O₃ below its floor yields no sub-index');
    assert.ok(lowO3.belowTable, 'and says why');
    // 1-hour SO₂ tops out at AQI 200; above that EPA requires the 24-h mean.
    const highSo2 = subIndex('so2_1h', 500);
    assert.equal(highSo2.aqi, 200, '1-h SO₂ caps at its table top');
    assert.ok(highSo2.clamped && /companion averaging window/.test(highSo2.note),
        'and names the companion window rather than extrapolating');
    assert.equal(aqiFromConcentration('so2_24h', 305), 201, '24-h SO₂ picks up at 201');
    // 8-hour O₃ ends at AQI 300.
    assert.equal(aqiFromConcentration('o3_8h', 0.200), 300);
    assert.ok(subIndex('o3_8h', 0.5).clamped, '8-h O₃ above 0.200 ppm is clamped, not extrapolated');
}

// ── Unit conversion (EPA standard conditions, 25 °C / 1 atm) ───────────────
{
    // ppb = µg/m³ × 24.45 / M. Hand-checked against the molar masses.
    const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg} (${a} vs ${b})`);
    near(toEpaUnit('no2', 100, 'µg/m³'), 53.145, 0.01, 'NO₂ 100 µg/m³ → ppb');
    near(toEpaUnit('so2_1h', 100, 'µg/m³'), 38.164, 0.01, 'SO₂ 100 µg/m³ → ppb');
    near(toEpaUnit('o3_8h', 100, 'µg/m³'), 0.050937, 1e-5, 'O₃ 100 µg/m³ → ppm');
    near(toEpaUnit('co', 1000, 'µg/m³'), 0.87290, 1e-4, 'CO 1000 µg/m³ → ppm');
    near(toEpaUnit('co', 1, 'mg/m³'), 0.87290, 1e-4, 'CO 1 mg/m³ → ppm');

    // Round-trip through both directions.
    for (const [key, v] of [['no2', 87], ['so2_1h', 40], ['o3_8h', 120], ['co', 2500]]) {
        const there = toEpaUnit(key, v, 'µg/m³');
        const back = fromEpaUnit(key, there, 'µg/m³');
        near(back, v, 1e-6, `${key} unit round-trip`);
    }

    // Unicode / ASCII / spacing variants must not silently fail.
    for (const u of ['µg/m³', 'ug/m3', 'μg/m³', 'UG/M3', ' ug/m3 ']) {
        assert.equal(toEpaUnit('pm25', 20, u), 20, `pm25 accepts "${u}" as its own unit`);
    }
    // Particulates have no gas conversion — that must be an explicit null,
    // never a number that looks plausible.
    assert.equal(toEpaUnit('pm25', 20, 'ppb'), null, 'PM2.5 has no ppb conversion');
    assert.equal(subIndex('pm25', 20, { unit: 'ppb' }).aqi, null);

    // A gas passed in its own EPA unit is untouched.
    assert.equal(toEpaUnit('no2', 53, 'ppb'), 53);
    assert.equal(aqiFromConcentration('no2', 53, { unit: 'ppb' }), 50);

    // The whole point of the conversion: 140 µg/m³ of ozone is NOT green.
    // 140 × 24.45/48.00 = 71.31 ppb → 0.0713 ppm → truncates to 0.071, which
    // is exactly the floor of the 101–150 band. The truncation is load-bearing
    // here: rounding to 0.071 vs 0.072 moves the answer by 3 AQI points.
    const o3 = aqiFromConcentration('o3_8h', 140, { unit: 'µg/m³' });
    assert.equal(o3, 101, 'O₃ 140 µg/m³ → AQI 101 (Unhealthy for Sensitive Groups)');
    assert.equal(categoryForAqi(o3).key, 'sensitive');
    // And a hair below stays Moderate — the boundary is real, not decorative.
    assert.equal(categoryForAqi(aqiFromConcentration('o3_8h', 137, { unit: 'µg/m³' })).key,
        'moderate', 'O₃ 137 µg/m³ is still Moderate');
}

// ── Inverse: what replaces `PM2.5 ≈ AQI / 2` ───────────────────────────────
{
    const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg} (${a} vs ${b})`);
    near(concentrationFromAqi('pm25', 50), 9.0, 1e-9, 'AQI 50 → 9.0 µg/m³');
    near(concentrationFromAqi('pm25', 100), 35.4, 1e-9, 'AQI 100 → 35.4 µg/m³');
    near(concentrationFromAqi('pm25', 150), 55.4, 1e-9, 'AQI 150 → 55.4 µg/m³');
    near(concentrationFromAqi('pm10', 100), 154, 1e-9, 'AQI 100 → 154 µg/m³ PM10');

    // The old heuristic's error, pinned so nobody reintroduces it.
    for (const aqi of [25, 50, 100, 200, 300]) {
        const truth = concentrationFromAqi('pm25', aqi);
        assert.notEqual(Math.round(truth * 10), Math.round((aqi / 2) * 10),
            `AQI/2 is not the inverse at AQI ${aqi}`);
    }

    // Forward ∘ inverse is identity at every index breakpoint.
    for (const [, , iLo, iHi] of AQI_POLLUTANTS.pm25.breakpoints) {
        for (const aqi of [iLo, iHi]) {
            assert.equal(aqiFromConcentration('pm25', concentrationFromAqi('pm25', aqi)), aqi,
                `pm25 round-trips at AQI ${aqi}`);
        }
    }
}

// ── Composite = worst pollutant, and it names which ────────────────────────
{
    const c = compositeAqi(
        { pm25: 12, pm10: 40, o3_8h: 150, no2: 30 },
        { unit: 'µg/m³' });
    assert.equal(c.dominant, 'o3_8h', 'ozone drives this composite');
    assert.equal(c.aqi, aqiFromConcentration('o3_8h', 150, { unit: 'µg/m³' }));
    assert.equal(c.category.key, 'sensitive');
    assert.ok(c.subIndices.pm25 != null && c.subIndices.no2 != null,
        'every reported pollutant keeps its own sub-index');

    // Missing pollutants are skipped, not treated as zero.
    const sparse = compositeAqi({ pm25: 40 }, { unit: 'µg/m³' });
    assert.equal(sparse.dominant, 'pm25');
    assert.equal(Object.keys(sparse.subIndices).length, 1);
    // Nothing usable → null, never 0. "Good" and "no data" are different.
    assert.equal(compositeAqi({}).aqi, null);
    assert.equal(compositeAqi({ pm25: null }).aqi, null);
    assert.equal(compositeAqi({ pm25: NaN }).aqi, null);
}

// ── Categories and colors ──────────────────────────────────────────────────
{
    assert.equal(categoryForAqi(0).key, 'good');
    assert.equal(categoryForAqi(50).key, 'good');
    assert.equal(categoryForAqi(51).key, 'moderate');
    assert.equal(categoryForAqi(100).key, 'moderate');
    assert.equal(categoryForAqi(101).key, 'sensitive');
    assert.equal(categoryForAqi(200).key, 'unhealthy');
    assert.equal(categoryForAqi(201).key, 'very');
    assert.equal(categoryForAqi(301).key, 'hazardous');
    assert.equal(categoryForAqi(9999).key, 'hazardous', 'above 500 still reads Hazardous');
    assert.equal(categoryForAqi(null), null);
    assert.equal(categoryForAqi(-1), null, 'negative AQI is not a category');

    // The palette must be byte-identical to what shipped, or every AQ surface
    // silently changes color.
    assert.deepEqual(aqiColor(25), [0.10, 0.88, 0.48]);
    assert.deepEqual(aqiColor(75), [1.00, 0.86, 0.18]);
    assert.deepEqual(aqiColor(125), [1.00, 0.49, 0.05]);
    assert.deepEqual(aqiColor(175), [1.00, 0.15, 0.18]);
    assert.deepEqual(aqiColor(250), [0.62, 0.25, 0.78]);
    assert.deepEqual(aqiColor(400), [0.55, 0.04, 0.18]);
    assert.deepEqual(aqiColor(NaN), [0.34, 0.39, 0.46]);
    // Callers destructure and hold these; they must not share frozen state.
    const a = aqiColor(25);
    a[0] = 9;
    assert.equal(aqiColor(25)[0], 0.10, 'aqiColor returns a fresh array each call');
}

// ── The averaging window is carried, not lost ──────────────────────────────
// #2 in the AQI review depends on this metadata existing; if someone deletes
// it the fix for hourly-vs-24h averaging loses its anchor.
{
    assert.equal(AQI_POLLUTANTS.pm25.averagingHours, 24);
    assert.equal(AQI_POLLUTANTS.pm10.averagingHours, 24);
    assert.equal(AQI_POLLUTANTS.o3_8h.averagingHours, 8);
    assert.equal(AQI_POLLUTANTS.co.averagingHours, 8);
    assert.equal(AQI_POLLUTANTS.no2.averagingHours, 1);
    assert.equal(AQI_POLLUTANTS.so2_1h.averagingHours, 1);
    assert.equal(AQI_CATEGORIES.length, 6);
    assert.equal(AQI_CATEGORIES[AQI_CATEGORIES.length - 1].max, AQI_MAX);
}

// ── Garbage in → null out, never a plausible-looking number ────────────────
{
    for (const bad of [null, undefined, NaN, Infinity, -Infinity, 'abc', {}, []]) {
        assert.equal(aqiFromConcentration('pm25', bad), null, `pm25 rejects ${String(bad)}`);
    }
    assert.equal(aqiFromConcentration('pm25', -5), null, 'negative concentration rejected');
    assert.equal(aqiFromConcentration('nonsense', 20), null, 'unknown pollutant rejected');
    assert.ok(subIndex('nonsense', 20).note, 'and says so');
}

console.log('aqi-scale: all assertions passed');
