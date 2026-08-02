/**
 * tests/home-sky-console.mjs — node gate for the landing page's sky console.
 *
 *   node tests/home-sky-console.mjs
 *
 * Covers the pure model layer of js/home-sky-console.js: the NOAA scale
 * mappers (official SWPC thresholds — G from Kp, R from X-ray flux, S from
 * ≥10 MeV proton flux), the personal aurora threshold (which inverts
 * verdict-engine's boundaryForKp — if that table moves, the pins here move
 * with it), the forecast-window scan, and buildSkyModel() end-to-end for
 * quiet, storm, and missing-feed states.
 */
import assert from 'node:assert/strict';
import {
    gFromKp, rFromFlux, sFromProtonPfu, kpNeededForVisibility,
    maxForecastKp, deepestSunAltitude, compoundIndex, buildSkyModel,
} from '../js/home-sky-console.js';
import { boundaryForKp, magneticLatitude } from '../js/verdict-engine.js';

// ── NOAA scale mappers — official SWPC thresholds ────────────────────────────
{
    // G from Kp
    assert.equal(gFromKp(2), 0);
    assert.equal(gFromKp(4.9), 0);
    assert.equal(gFromKp(5), 1);
    assert.equal(gFromKp(6), 2);
    assert.equal(gFromKp(7), 3);
    assert.equal(gFromKp(8.7), 4);
    assert.equal(gFromKp(9), 5);
    assert.equal(gFromKp(NaN), 0);
    assert.equal(gFromKp(undefined), 0);

    // R from X-ray flux: R1=M1, R2=M5, R3=X1, R4=X10, R5=X20
    assert.equal(rFromFlux(1e-6), 0);          // C1 — no blackout
    assert.equal(rFromFlux(1e-5), 1);          // M1
    assert.equal(rFromFlux(5e-5), 2);          // M5
    assert.equal(rFromFlux(1e-4), 3);          // X1
    assert.equal(rFromFlux(1e-3), 4);          // X10
    assert.equal(rFromFlux(2e-3), 5);          // X20
    assert.equal(rFromFlux(null), 0);

    // S from ≥10 MeV protons (pfu) — mirrors swpc-feed sep_storm_level
    assert.equal(sFromProtonPfu(0.5), 0);
    assert.equal(sFromProtonPfu(10), 1);
    assert.equal(sFromProtonPfu(100), 2);
    assert.equal(sFromProtonPfu(1e3), 3);
    assert.equal(sFromProtonPfu(1e4), 4);
    assert.equal(sFromProtonPfu(1e5), 5);
}

// ── Personal aurora threshold — inverse of boundaryForKp ─────────────────────
{
    // Round-trip: for a few Kp values, an observer sitting exactly at
    // boundary(kp) − 5° (the GO-margin edge) needs ≈ that Kp.
    for (const kp of [1, 3, 5, 7]) {
        const mlat = boundaryForKp(kp) - 5; // then |mlat| + 5 = boundary(kp)
        const need = kpNeededForVisibility(mlat);
        assert.ok(Math.abs(need - kp) <= 0.15,
            `round-trip Kp ${kp}: needed ${need} for mlat ${mlat}`);
    }

    // High-latitude observer (Fairbanks): aurora in reach at quiet field.
    const fairbanks = magneticLatitude(64.84, -147.72);
    assert.equal(kpNeededForVisibility(fairbanks), 0);

    // Tropical observer: out of reach even at Kp 9.
    assert.equal(kpNeededForVisibility(10), null);

    // Mid-latitude observer (Minneapolis ≈ 55° mlat): needs real activity,
    // but not an extreme storm. The generous-looking number is deliberate —
    // it inherits the verdict card's 5° GO margin (CLAUDE.md §4.4,
    // Gannon-calibrated), not the 2° overhead-only NOAA figure.
    const mpls = kpNeededForVisibility(magneticLatitude(44.98, -93.27));
    assert.ok(mpls > 1.5 && mpls < 6, `Minneapolis threshold ${mpls} outside (1.5,6)`);

    // A low-mid-latitude observer (Denver ≈ 48° mlat) needs a major storm.
    const denver = kpNeededForVisibility(magneticLatitude(39.74, -104.99));
    assert.ok(denver > 5, `Denver threshold ${denver} should demand a storm`);

    assert.equal(kpNeededForVisibility(NaN), null);
}

// ── Forecast window scan ─────────────────────────────────────────────────────
{
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    const H = 3600e3;
    const fc = [
        { time: new Date(now - 6 * H), kp: 8, kind: 'observed' },   // past — ignored
        { time: new Date(now + 3 * H), kp: 4.3, kind: 'estimated' },
        { time: new Date(now + 12 * H), kp: 6.7, kind: 'predicted' },
        { time: new Date(now + 40 * H), kp: 9, kind: 'predicted' }, // beyond 24 h — ignored
    ];
    assert.equal(maxForecastKp(fc, 24, now), 6.7);
    assert.equal(maxForecastKp(fc, 6, now), 4.3);
    assert.equal(maxForecastKp([], 24, now), null);
    assert.equal(maxForecastKp(null, 24, now), null);
    // ISO-string timestamps parse too
    assert.equal(maxForecastKp([{ time: new Date(now + H).toISOString(), kp: 5.5, kind: 'predicted' }], 24, now), 5.5);
}

// ── Dark-window detector ─────────────────────────────────────────────────────
{
    // Fairbanks in January: deep darkness exists inside any 24 h.
    const winterNight = deepestSunAltitude(64.84, -147.72, Date.UTC(2026, 0, 15, 12));
    assert.ok(winterNight < -12, `Fairbanks January deepest alt ${winterNight} should be < -12`);
    // Tromsø (69.6°N) at midsummer: the sun never sets — no dark window.
    const midnightSun = deepestSunAltitude(69.65, 18.96, Date.UTC(2026, 5, 21, 12));
    assert.ok(midnightSun > -12, `midnight-sun deepest alt ${midnightSun} should be > -12`);
}

// ── Compound index ───────────────────────────────────────────────────────────
{
    const quiet = compoundIndex({ kp: 1.7, bz: 2, speed: 380, rLevel: 0, sLevel: 0 });
    assert.ok(quiet.num < 15, `quiet compound ${quiet.num} should be < 15`);
    assert.equal(quiet.word, 'Quiet sky');

    const storm = compoundIndex({ kp: 8.3, bz: -18, speed: 750, rLevel: 3, sLevel: 3 });
    assert.ok(storm.num > 70, `storm compound ${storm.num} should be > 70`);
    assert.ok(storm.num <= 100);
    assert.ok(storm.num > quiet.num, 'compound must rank storm above quiet');

    const empty = compoundIndex({});
    assert.equal(empty.num, 0);
}

// ── buildSkyModel: quiet Sun, no location ────────────────────────────────────
{
    const m = buildSkyModel({
        solar_wind: { speed: 400, density: 5, bz: 0.5, bt: 5 },
        kp: 2.0, kp_1min: 2.1,
        xray_flux: 1e-8, xray_class: 'A1.0',
        proton_flux_10mev: 0.1, electron_flux_2mev: 100,
        f107_flux: 95, dst_index: -5,
        status: 'live', lastUpdated: Date.UTC(2026, 0, 15, 12),
    }, { now: Date.UTC(2026, 0, 15, 12) });

    assert.equal(m.g.level, 0);
    assert.equal(m.r.level, 0);
    assert.equal(m.s.level, 0);
    assert.equal(m.drag.level, 0);
    assert.equal(m.gnss.level, 0);
    assert.equal(m.rows.length, 5);
    assert.ok(m.rows.every((r) => r.chip === 'Quiet'), 'all rows quiet on a quiet Sun');
    assert.equal(m.aurora.available, false);
    assert.equal(m.alert, null);
    assert.ok(m.compound.num < 15);
    assert.match(m.headline, /quiet/i);
    // notes are complete sentences, not codes
    assert.ok(m.rows.every((r) => r.note.length > 20), 'every row carries a readable note');
}

// ── buildSkyModel: severe storm + SEP + X flare ──────────────────────────────
{
    const now = Date.UTC(2026, 0, 15, 6); // Fairbanks night
    const m = buildSkyModel({
        solar_wind: { speed: 780, density: 18, bz: -15, bt: 25 },
        kp: 8.0,
        xray_flux: 2e-4, xray_class: 'X2.0',
        proton_flux_10mev: 1500, sep_storm_level: 3,
        f107_flux: 210, dst_index: -180,
        kp_forecast: [{ time: new Date(now + 6 * 3600e3), kp: 8.7, kind: 'predicted' }],
        status: 'live', lastUpdated: now, storm_mode: true,
    }, { now, loc: { lat: 64.84, lon: -147.72, city: 'Fairbanks' }, cloudPct: 10 });

    assert.equal(m.g.level, 4, 'Kp 8 → G4');
    assert.equal(m.g.next24.label, 'G4');
    assert.equal(m.r.level, 3, 'X2 → R3');
    assert.equal(m.s.level, 3, 'feed sep_storm_level wins');
    assert.ok(m.drag.level >= 2, 'storm heating must raise the drag row');
    assert.ok(m.gnss.level >= 2, 'storm ionosphere must raise the GNSS row');
    assert.ok(m.rows.some((r) => r.chipLevel >= 2), 'risk board must show elevated chips');
    assert.ok(m.alert, 'alert band must trip during a storm');

    // Aurora: high-latitude observer, dark, clear, Kp 8 → GO.
    assert.equal(m.aurora.available, true);
    assert.equal(m.aurora.verdict.state, 'go');
    assert.equal(m.aurora.kpEff, 8.7, 'effective Kp takes the forecast max');
    assert.ok(m.compound.num > 60);
    assert.equal(m.stormMode, true);
}

// ── buildSkyModel: CME headline + empty feed never crashes ───────────────────
{
    const now = Date.UTC(2026, 0, 15, 12);
    const withCme = buildSkyModel({
        kp: 3, solar_wind: { speed: 420, density: 6, bz: 1 },
        earth_directed_cme: { time: '2026-01-14T02:00Z' }, cme_eta_hours: 14,
    }, { now });
    assert.match(withCme.headline, /CME/i);
    assert.ok(withCme.alert, 'inbound CME must trip the alert band');
    assert.equal(withCme.sun.cme.eta_hours, 14);

    const empty = buildSkyModel({}, {});
    assert.equal(empty.kp, null);
    assert.equal(empty.rows.length, 5);
    assert.match(empty.headline, /connecting/i);
    assert.equal(empty.compound.num, 0);

    // Model never emits NaN into anything the renderer prints.
    const flat = JSON.stringify(empty);
    assert.ok(!flat.includes('NaN'), 'no NaN leaks in the empty model');
}

console.log('home-sky-console: all assertions passed');
