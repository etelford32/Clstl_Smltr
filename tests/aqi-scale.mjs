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
    nowcastAqi,
    nowcastPm,
    nowcastWeight,
    realtimeConcentration,
    trailingMean,
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

// ── NowCast ────────────────────────────────────────────────────────────────
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 7, 12, 14, 20);          // 14:20 → current hour 14:00
/** Build a trailing series: v[0] is the current hour, v[1] an hour ago, … */
const trail = (values, gapAt = -1) => values
    .map((value, i) => (i === gapAt ? null : { time: NOW - i * HOUR, value }))
    .filter(Boolean);

{
    // Weight factor = min/max, floored at 0.5.
    assert.equal(nowcastWeight([10, 10, 10]), 1, 'a flat window is a plain mean');
    assert.ok(Math.abs(nowcastWeight([5, 10]) - 0.5) < 1e-12, 'min/max = 0.5');
    assert.equal(nowcastWeight([1, 100]), 0.5, 'steep windows floor at 0.5');
    assert.equal(nowcastWeight([0, 0, 0]), 1, 'an all-zero window does not divide by zero');
    assert.equal(nowcastWeight([]), null);

    // A 12-hour window, most recent hour first, worked through the EPA
    // definition by hand so this pins arithmetic and not just self-consistency:
    //   min 8.6 / max 47.4 = 0.181  → w floors to 0.5
    //   Σ cᵢ·0.5ⁱ = 78.38799 ,  Σ 0.5ⁱ = 2 − 2⁻¹¹ = 1.99951172
    //   NowCast   = 78.38799 / 1.99951172 = 39.2036…
    const epa = [34.9, 43.6, 45.2, 47.4, 43.6, 33.0, 28.6, 20.5, 15.7, 12.4, 10.2, 8.6];
    const nc = nowcastPm(trail(epa), { nowMs: NOW });
    assert.ok(nc.valid, 'the worked example is valid');
    assert.equal(nc.hoursUsed, 12);
    assert.equal(nc.weight, 0.5, 'this window is steep enough to floor the weight');
    assert.ok(Math.abs(nc.value - 39.2036) < 1e-3,
        `hand-computed NowCast = 39.2036 (got ${nc.value.toFixed(4)})`);
    // The flat 12-h mean is 28.64 — NowCast leads it on a window that rose
    // and is now easing, which is the entire reason EPA publishes it.
    const flatMean = epa.reduce((a, b) => a + b, 0) / epa.length;
    assert.ok(Math.abs(flatMean - 28.6417) < 1e-3, 'flat mean cross-check');
    assert.ok(nc.value > flatMean, 'NowCast leads the flat mean here');

    // The whole point: a plume in the newest hour must move the number now.
    const quiet = nowcastPm(trail(new Array(12).fill(8)), { nowMs: NOW });
    const plume = nowcastPm(trail([200, ...new Array(11).fill(8)]), { nowMs: NOW });
    assert.equal(quiet.value, 8, 'a flat window returns the flat value');
    assert.ok(plume.value > 100,
        `a fresh plume dominates immediately (got ${plume.value.toFixed(1)})`);
    // Under the 24-h flat mean the same plume would barely register.
    const flat24 = (200 + 8 * 11) / 12;
    assert.ok(plume.value > 3 * flat24, 'NowCast reacts far faster than a flat mean');

    // A flat window makes NowCast equal to the plain mean, by construction.
    const flatSeries = trail([20, 20, 20, 20, 20, 20]);
    assert.ok(Math.abs(nowcastPm(flatSeries, { nowMs: NOW }).value - 20) < 1e-12);

    // EPA validity: 2 of the 3 most recent hours must be present.
    const gapAtNow = nowcastPm(trail([10, 10, 10, 10], 0), { nowMs: NOW });
    assert.equal(gapAtNow.valid, true, 'a gap at hour 0 still passes on hours 1 and 2');
    const oneRecent = [{ time: NOW, value: 10 }, { time: NOW - 6 * HOUR, value: 10 }];
    const bad = nowcastPm(oneRecent, { nowMs: NOW });
    assert.equal(bad.valid, false, 'only one of the last three hours → not reported');
    assert.equal(bad.value, null);
    assert.match(bad.reason, /2 of the 3 most recent/);
    assert.equal(nowcastPm([], { nowMs: NOW }).valid, false);

    // Forecast rows must never contribute to a "now" value.
    const future = [{ time: NOW + 2 * HOUR, value: 500 }, { time: NOW, value: 10 },
        { time: NOW - HOUR, value: 10 }];
    assert.equal(nowcastPm(future, { nowMs: NOW }).value, 10,
        'a future hour is excluded from NowCast');

    // Only the window's hours count; older rows fall out.
    const long = trail(new Array(30).fill(0).map((_, i) => (i < 12 ? 10 : 999)));
    assert.equal(nowcastPm(long, { nowMs: NOW }).value, 10, 'hours beyond the window are dropped');
}

{
    // Straight trailing means for the flat-averaged pollutants. EPA wants 75%
    // of the window present — 6 of 8 hours here.
    const m = trailingMean(trail([0.06, 0.055, 0.05, 0.045, 0.04, 0.035]), { nowMs: NOW, hours: 8 });
    assert.ok(m.valid, '6 of 8 hours is a valid 8-h mean');
    assert.ok(Math.abs(m.value - 0.0475) < 1e-12, 'mean over present hours');
    assert.equal(m.hoursUsed, 6);
    // 4 of 8 is not an 8-hour average, and must not be scored as one.
    const thin = trailingMean(trail([0.06, 0.05, 0.04, 0.03]), { nowMs: NOW, hours: 8 });
    assert.equal(thin.valid, false, '4 of 8 hours fails the 75% rule');
    assert.equal(thin.value, null);
    assert.match(thin.reason, /needs 6 hours, has 4/);
    // A 1-hour pollutant needs exactly its one hour.
    assert.equal(trailingMean(trail([20]), { nowMs: NOW, hours: 1 }).valid, true);
    // 24-h SO₂ needs 18 hours.
    assert.match(trailingMean(trail(new Array(10).fill(5)), { nowMs: NOW, hours: 24 }).reason,
        /needs 18 hours, has 10/);
    // The current hour is required — a mean of only stale hours is not "now".
    const stale = trailingMean([{ time: NOW - 5 * HOUR, value: 0.06 }], { nowMs: NOW, hours: 8 });
    assert.equal(stale.valid, false);
    assert.match(stale.reason, /current hour is missing/);

    // Dispatch comes from the registry, not a switch statement.
    assert.equal(realtimeConcentration('pm25', trail([10, 10, 10]), { nowMs: NOW }).method, 'nowcast');
    assert.equal(realtimeConcentration('o3_8h', trail([0.05, 0.05]), { nowMs: NOW }).method, 'mean');
    assert.equal(realtimeConcentration('o3_8h', trail([0.05]), { nowMs: NOW }).windowHours, 8);
    assert.equal(realtimeConcentration('no2', trail([20]), { nowMs: NOW }).windowHours, 1);
    assert.equal(realtimeConcentration('nope', trail([1]), { nowMs: NOW }).valid, false);

    // Units are converted before averaging, not after. Needs 6 of 8 hours.
    const o3 = realtimeConcentration('o3_8h', trail(new Array(8).fill(140)),
        { nowMs: NOW, unit: 'µg/m³' });
    assert.ok(o3.valid, 'a full 8-h window is valid');
    assert.ok(Math.abs(o3.value - 0.0713125) < 1e-6, 'µg/m³ → ppm happens inside the average');
}

{
    // Composite NowCast: worst sub-index wins and names itself.
    const series = {
        pm25: trail([30, 28, 26, 24, 20, 18, 15, 12, 10, 9, 8, 8]),
        o3_8h: trail([60, 58, 55, 52, 50, 48, 45, 44]),
        no2: trail([40]),
    };
    const nc = nowcastAqi(series, { nowMs: NOW, unit: 'µg/m³' });
    assert.ok(isFinite(nc.aqi), 'a composite is produced');
    assert.equal(nc.dominant, 'pm25', 'PM2.5 drives this one');
    assert.equal(nc.category.key, categoryForAqi(nc.aqi).key);
    assert.ok(nc.methods.pm25.method === 'nowcast' && nc.methods.pm25.windowHours === 12,
        'the method used rides the result');
    assert.ok(nc.methods.o3_8h.method === 'mean');

    // A pollutant that fails its validity rule is skipped with a reason, and
    // must not silently drag the composite down.
    const partial = nowcastAqi({
        pm25: [{ time: NOW - 8 * HOUR, value: 300 }],       // fails 2-of-3
        no2: trail([40]),
    }, { nowMs: NOW, unit: 'µg/m³' });
    assert.equal(partial.dominant, 'no2', 'the invalid PM2.5 is excluded, not zero-filled');
    assert.ok(partial.notes.some(n => /pm25/.test(n)), 'and the exclusion is reported');

    // Nothing usable → null, never 0.
    assert.equal(nowcastAqi({}, { nowMs: NOW }).aqi, null);
    assert.equal(nowcastAqi({ pm25: [] }, { nowMs: NOW }).aqi, null);

    // NowCast vs the flat 24-h table on the same plume: the whole reason for
    // this code. A fresh smoke hour must not be averaged into invisibility.
    const smoke = trail([180, 12, 10, 9, 9, 8, 8, 8, 8, 8, 8, 8]);
    const ncSmoke = nowcastAqi({ pm25: smoke }, { nowMs: NOW, unit: 'µg/m³' });
    const flat = smoke.reduce((a, s) => a + s.value, 0) / smoke.length;
    assert.ok(ncSmoke.aqi > aqiFromConcentration('pm25', flat) + 40,
        `NowCast AQI ${ncSmoke.aqi} clears the flat-mean AQI by a wide margin`);
}

console.log('aqi-scale: all assertions passed');
