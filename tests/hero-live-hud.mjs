/**
 * tests/hero-live-hud.mjs — node gate for the landing hero's live readout.
 *
 *   node tests/hero-live-hud.mjs
 *
 * Covers buildHudModel() (pure view-model), its shared conditions headline,
 * and the inlined Shue standoff,
 * which MIRRORS computeShue() in js/magnetosphere-engine.js — if the physics
 * there changes, the pins here must move with it.
 */
import assert from 'node:assert/strict';
import { buildHudModel, shueStandoffRe } from '../js/hero-live-hud.js';

// ── Shue standoff mirror ─────────────────────────────────────────────────────
{
    // Nominal quiet wind: ~10–11 Re (canonical textbook value)
    const quiet = shueStandoffRe(5, 400, 0);
    assert.ok(quiet > 9.5 && quiet < 11.5, `quiet standoff ${quiet} outside 9.5–11.5 Re`);

    // Storm wind compresses the magnetopause
    const storm = shueStandoffRe(15, 750, -18);
    assert.ok(storm < quiet, `storm standoff ${storm} not compressed vs quiet ${quiet}`);
    assert.ok(storm >= 3.5, 'standoff floor (3.5 Re) violated');

    // Degenerate inputs never NaN/blow up
    assert.ok(Number.isFinite(shueStandoffRe(0, 0, 0)), 'degenerate inputs must stay finite');
}

// ── Quiet conditions ─────────────────────────────────────────────────────────
{
    const m = buildHudModel({
        solar_wind: { speed: 420, density: 5, bz: 1.2 },
        kp: 2.3,
        xray_class: 'B4.1',
        derived: { storm_level: 0 },
    });
    assert.equal(m.status.label, 'Quiet');
    assert.equal(m.status.tone, 'quiet');
    assert.equal(m.headline.label, 'Space Weather Calm');
    assert.equal(m.headline.tone, 'quiet');
    assert.equal(m.kp.text, '2.3');
    assert.equal(m.wind.text, '420');
    assert.equal(m.bz.text, '+1.2');
    assert.equal(m.xray.hot, false);
    assert.equal(m.cme, null);
    assert.ok(parseFloat(m.standoff.text) > 9.5, 'quiet standoff chip should read ~10+ Re');
}

// ── Storm conditions with inbound CME ────────────────────────────────────────
{
    const m = buildHudModel({
        solar_wind: { speed: 750, density: 15, bz: -18 },
        kp: 7.2,
        flare_class: 'X1.4',
        derived: { storm_level: 3 },
        earth_directed_cme: { time: '2026-07-25T02:00Z' },
        cme_eta_hours: 22.4,
    });
    assert.equal(m.status.label, 'G3 · Strong storm');
    assert.equal(m.status.tone, 'severe');
    assert.equal(m.headline.label, 'G3 Strong Geomagnetic Storm');
    assert.equal(m.headline.tone, 'severe');
    assert.equal(m.bz.color, '#ff3050', 'strongly southward Bz shows danger color');
    assert.equal(m.xray.hot, true, 'X-class flags hot');
    assert.ok(m.cme, 'CME chip present');
    assert.equal(m.cme.text, '~22 h');
    assert.equal(m.cme.urgent, true, '<36 h is urgent');
    assert.ok(parseFloat(m.standoff.text) < 9, 'storm standoff chip visibly compressed');
}

// ── Headline uses current conditions, not misleading "flare incoming" copy ──
{
    const flare = buildHudModel({
        status: 'live',
        solar_wind: { speed: 410, bz: 0.6 },
        kp: 1.2,
        xray_class: 'M2.3',
    });
    assert.equal(flare.headline.label, 'M2.3 M-Class Solar Flare');
    assert.match(flare.headline.detail, /X-ray M2\.3/);

    const cme = buildHudModel({
        status: 'live',
        solar_wind: { speed: 411, bz: 0.6 },
        kp: 0,
        xray_class: 'B3.6',
        earth_directed_cme: { hoursUntil: 22.4 },
        cme_eta_hours: 22.4,
    });
    assert.equal(cme.headline.label, 'CME Inbound · ~22 h');
    assert.equal(cme.headline.tone, 'active');
}

// ── Fast, southward wind is surfaced before it becomes a Kp storm ────────────
{
    const m = buildHudModel({
        status: 'live',
        solar_wind: { speed: 620, bz: -8 },
        kp: 2.4,
        xray_class: 'B2.0',
    });
    assert.equal(m.headline.label, 'Solar Wind Disturbance');
    assert.equal(m.headline.tone, 'active');
}

// ── Feed honesty: missing/stale data never reads as calm ─────────────────────
{
    assert.equal(buildHudModel({ status: 'offline' }).headline.label, 'SWPC Data Offline');
    assert.equal(buildHudModel({ status: 'stale', kp: 1 }).headline.label, 'SWPC Data Stale');
    assert.equal(buildHudModel({}).headline.label, 'Awaiting Space Weather Data');
}

// ── storm_level fallback derived from Kp when derived{} is absent ────────────
{
    const m = buildHudModel({ solar_wind: {}, kp: 5.7 });
    assert.equal(m.status.label, 'G1 · Minor storm');
    assert.equal(m.status.tone, 'storm');
}

// ── Kp 4 without storm reads Active ──────────────────────────────────────────
{
    const m = buildHudModel({ solar_wind: {}, kp: 4.1, derived: { storm_level: 0 } });
    assert.equal(m.status.label, 'Active');
    assert.equal(m.status.tone, 'active');
}

// ── Empty / partial feed degrades to placeholders, never throws ──────────────
{
    const m = buildHudModel({});
    assert.equal(m.kp.text, '—');
    assert.equal(m.wind.text, '—');
    assert.equal(m.bz.text, '—');
    assert.equal(m.standoff.text, '—');
    assert.equal(m.xray.text, '—');
    assert.equal(m.status.label, 'Quiet');
    assert.equal(m.cme, null);
    assert.doesNotThrow(() => buildHudModel());
    assert.doesNotThrow(() => buildHudModel({ solar_wind: { speed: NaN, bz: Infinity } }));
}

// CME without ETA (or non-Earth-directed) never shows the chip
{
    assert.equal(buildHudModel({ earth_directed_cme: {} }).cme, null);
    assert.equal(buildHudModel({ cme_eta_hours: 12 }).cme, null);
}

console.log('hero-live-hud: all tests passed');
