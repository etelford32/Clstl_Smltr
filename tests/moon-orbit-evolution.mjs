#!/usr/bin/env node
/**
 * moon-orbit-evolution.mjs — gate for js/moon-orbit-evolution.js.
 *
 * Run: node tests/moon-orbit-evolution.mjs
 *
 * The load-bearing pins:
 *   • The distance curve passes exactly through the geological anchors and
 *     is strictly monotone — no invented wiggles between data points.
 *   • THE headline check: day length is DERIVED from angular-momentum
 *     conservation alone (calibrated only to today's 24 h), yet must
 *     reproduce the rhythmite papers' measured day lengths — 21.9 h at
 *     0.62 Ga (Williams), 18.7 h at 1.4 Ga (Meyers & Malinverno), 16.9 h
 *     at 2.46 Ga (Lantink). None of those numbers appear in the kernel.
 *   • Elatina's famous ~400-day year falls out at 0.62 Ga.
 *   • The post-impact day is ~5 h; the orbit always outruns the spin
 *     (otherwise the Moon couldn't be receding).
 *   • Total solar eclipses end of order half a Gyr from now.
 *   • The precession-dynamo window (Dwyer 48 R_E) closes INSIDE the
 *     interior kernel's 'Weak-field decline' epoch — two kernels, built
 *     from different data, telling one consistent story.
 */

import assert from 'node:assert/strict';
import { DYNAMO_EPOCHS, MOON_MASS_MEASURED_KG } from '../js/moon-interior-model.js';
import {
    DISTANCE_ANCHORS, distanceREAt, distanceKmAt,
    dayLengthHoursAt, siderealMonthDaysAt, synodicMonthDaysAt,
    localDaysPerYearAt, localDaysPerMonthAt,
    apparentSizeFactorAt, tideFactorAt, evidenceAt,
    totalEclipseEndGyr, precessionDynamoEndGa,
    TODAY_DISTANCE_RE, RECESSION_CM_PER_YR, PRECESSION_DYNAMO_MAX_RE,
    EARTH_RADIUS_KM,
} from '../js/moon-orbit-evolution.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ── 1. The distance record ───────────────────────────────────────────────────
{
    for (const a of DISTANCE_ANCHORS) {
        near(distanceREAt(a.ageGa), a.distRE, 1e-9, `curve passes through anchor at ${a.ageGa} Ga`);
        assert.ok(['measured', 'inferred', 'model'].includes(a.kind), `${a.ageGa} Ga kind labeled`);
        assert.ok(a.label.length > 15, `${a.ageGa} Ga anchor cites its source`);
    }
    assert.equal(DISTANCE_ANCHORS.filter(a => a.kind === 'measured').length, 4,
        'four measured anchors (LLR + three rhythmite records)');
    // Strictly monotone: farther back → closer Moon
    for (let g = 0; g < 4.5; g += 0.01) {
        assert.ok(distanceREAt(g + 0.01) < distanceREAt(g) + 1e-9, `monotone at ${g.toFixed(2)} Ga`);
    }
    near(distanceKmAt(0), 60.33 * EARTH_RADIUS_KM, 1, 'today in km');
    // Future: constant-rate recession, ~+6 R_E per Gyr
    near(distanceREAt(-1), TODAY_DISTANCE_RE + RECESSION_CM_PER_YR * 1e4 / EARTH_RADIUS_KM * 1, 0.01,
        'future extrapolation at the LLR rate');
    ok('distance: through all anchors, strictly monotone, sourced');
}

// ── 2. Day length: conservation of L reproduces the rhythmites ───────────────
{
    near(dayLengthHoursAt(0), 24.0, 0.05, 'today calibrates to 24 h');
    near(dayLengthHoursAt(0.62), 21.9, 0.8, 'Elatina day (Williams 2000: ~21.9 h)');
    near(dayLengthHoursAt(1.40), 18.7, 0.8, 'Xiamaling day (Meyers 2018: 18.68 h)');
    near(dayLengthHoursAt(2.46), 16.9, 0.9, 'Joffre day (Lantink 2022: ~16.9 h)');
    const dPostImpact = dayLengthHoursAt(4.5);
    assert.ok(dPostImpact > 4 && dPostImpact < 6, `post-impact day ~5 h (got ${dPostImpact.toFixed(1)})`);
    // Day lengthens monotonically as the Moon recedes
    for (let g = 4.4; g > 0; g -= 0.1) {
        assert.ok(dayLengthHoursAt(g - 0.1) > dayLengthHoursAt(g) - 1e-9, `day lengthens at ${g.toFixed(1)}`);
    }
    ok(`day length derived from L: 24.0 → 21.9 → 18.7 → 16.9 → ${dPostImpact.toFixed(1)} h`);
}

// ── 3. Months and local calendars ────────────────────────────────────────────
{
    near(siderealMonthDaysAt(0), 27.32, 0.01, 'Kepler recovers today\'s sidereal month');
    near(synodicMonthDaysAt(0), 29.53, 0.05, 'and today\'s synodic month');
    near(localDaysPerYearAt(0), 365.25, 1, '365 days/year today');
    near(localDaysPerYearAt(0.62), 400, 15, 'Elatina\'s ~400-day year');
    assert.ok(localDaysPerYearAt(2.46) > 480 && localDaysPerYearAt(2.46) < 560,
        'Archean year > 500 short days');
    // The orbit must always outrun the spin — that's WHY the Moon recedes
    for (let g = 0; g <= 4.5; g += 0.05) {
        assert.ok(siderealMonthDaysAt(g) * 24 > dayLengthHoursAt(g),
            `orbit outruns spin at ${g.toFixed(2)} Ga`);
    }
    ok(`calendars: ${localDaysPerYearAt(0.62).toFixed(0)} days/yr at Elatina time; orbit > spin always`);
}

// ── 4. Sky geometry and tides ────────────────────────────────────────────────
{
    near(apparentSizeFactorAt(0), 1, 1e-9, 'apparent size ×1 today');
    assert.ok(apparentSizeFactorAt(4.5) > 12, 'formation Moon >12× wider in the sky');
    near(tideFactorAt(0), 1, 1e-9, 'tides ×1 today');
    assert.ok(tideFactorAt(4.5) > 2000, 'formation tides thousands× today');
    assert.ok(tideFactorAt(2.46) > 1.5 && tideFactorAt(2.46) < 2.2, 'Archean tides ~1.7×');
    ok('apparent size ∝ 1/a; tides ∝ 1/a³');
}

// ── 5. Evidence labels ───────────────────────────────────────────────────────
{
    assert.equal(evidenceAt(0.6).kind, 'measured', 'near Elatina → measured');
    assert.ok(evidenceAt(0.6).label.includes('Elatina'), 'names the record');
    assert.equal(evidenceAt(2.5).kind, 'measured', 'near Joffre → measured');
    assert.equal(evidenceAt(4.5).kind, 'model', 'formation → model');
    assert.ok(evidenceAt(-0.5).extrapolated, 'future flagged as extrapolation');
    ok('every scrubbed age can say what its numbers rest on');
}

// ── 6. Grand cross-links ─────────────────────────────────────────────────────
{
    const end = totalEclipseEndGyr();
    assert.ok(end > 0.25 && end < 1.2, `total solar eclipses end ~0.5 Gyr out (got ${end.toFixed(2)})`);

    const dynamoEnd = precessionDynamoEndGa();
    assert.ok(dynamoEnd > 2.3 && dynamoEnd < 3.5,
        `Moon crosses ${PRECESSION_DYNAMO_MAX_RE} R_E around 2.5–3.5 Ga (got ${dynamoEnd.toFixed(2)})`);
    // …and that crossing must land INSIDE the interior kernel's weak-field
    // decline epoch: precession stirring fading as the Moon recedes.
    const decline = DYNAMO_EPOCHS.find(e => e.label === 'Weak-field decline');
    assert.ok(dynamoEnd <= decline.fromGa && dynamoEnd >= decline.toGa,
        'precession-dynamo cutoff falls inside the weak-field decline epoch');
    // One Moon, one mass — imported, not redeclared
    assert.ok(MOON_MASS_MEASURED_KG > 7e22 && MOON_MASS_MEASURED_KG < 7.5e22, 'shared moon mass');
    ok(`eclipses end +${end.toFixed(2)} Gyr; precession dynamo dies ${dynamoEnd.toFixed(1)} Ga — inside the decline epoch`);
}

console.log(`\nmoon-orbit-evolution: ${passed} groups passed`);
