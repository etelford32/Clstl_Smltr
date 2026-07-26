#!/usr/bin/env node
/**
 * geomag-igrf.mjs — numerical-correctness gate for the IGRF-14 evaluator
 * (js/geomag/igrf.js).
 *
 * Run: node tests/geomag-igrf.mjs
 *
 * These are ANALYTIC anchors, not a diff against a stored answer file. The
 * research code this was ported from was verified against `ppigrf` to
 * 3×10⁻⁴ nT at six sites; that reference is not available here, so what is
 * pinned instead is every property that can be derived from first principles
 * — which is the more useful gate anyway, because it fails for a REASON.
 *
 * It also pins the two regression traps documented in the module header. Both
 * were real bugs and both fail SILENTLY:
 *
 *   • The Legendre stride. Allocating P/dP at (nmax+1) instead of (NMAX+1)
 *     produced NaN for every truncation below 13 — silent because the
 *     recursion reads a row that exists only at full stride.
 *   • The geodetic rotation sign. A flipped sign is EXACTLY ZERO at the
 *     equator, so an equator-only test passes a broken transform. Everything
 *     here is checked off-equator on purpose.
 */

import assert from 'node:assert/strict';
import {
    coeffsAt, schmidtP, fieldGeocentric, fieldGeodetic, fieldGrid,
    geodeticToGeocentric, dipole, dipoleFraction, lowesSpectrum, findSAA,
    NMAX, REF_RADIUS_KM, R_CMB_KM, WGS84_A_KM, WGS84_F, EPOCHS,
} from '../js/geomag/igrf.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ── 1. Coefficient table integrity ───────────────────────────────────────────
{
    assert.equal(NMAX, 13, 'IGRF-14 is degree 13');
    assert.equal(EPOCHS.length, 27, '27 epochs, 1900–2030 at 5-year spacing');
    assert.equal(EPOCHS[0], 1900);
    assert.equal(EPOCHS[EPOCHS.length - 1], 2030);

    const c = coeffsAt(2025.0);
    // g₁⁰ is the single best-known number in geomagnetism; if the table were
    // mis-parsed this is what would move.
    near(c.g[1][0], -29350, 30, 'g₁⁰ at 2025.0');
    assert.ok(c.h[1][0] === 0, 'h(n,0) is identically zero by construction');

    // Interpolation must be exact AT an epoch and monotone between two.
    const a = coeffsAt(2020.0), b = coeffsAt(2025.0), mid = coeffsAt(2022.5);
    near(mid.g[1][0], 0.5 * (a.g[1][0] + b.g[1][0]), 1e-9, 'linear interpolation midpoint');

    // Out-of-range years clamp rather than extrapolating off the end of the table.
    assert.equal(coeffsAt(1850).clamped, true, 'a year before 1900 clamps');
    assert.equal(coeffsAt(2100).clamped, true, 'a year after 2030 clamps');
    ok('coefficient table: 195 coefficients, 27 epochs, exact interpolation, clamped ends');
}

// ── 2. REGRESSION TRAP 1 — the Legendre stride ───────────────────────────────
{
    // Every truncation from 1 to 13 must return finite values everywhere.
    // A stride bug gives NaN for every n < NMAX and nothing throws.
    const c = coeffsAt(2026.0);
    for (let nmax = 1; nmax <= NMAX; nmax++) {
        for (const lat of [-89.5, -44.2, -0.3, 17.9, 62.1, 89.5]) {
            const f = fieldGeodetic(c, nmax, lat, 137.4, 0);
            assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y) && Number.isFinite(f.z),
                `nmax=${nmax} lat=${lat} produced a non-finite field — Legendre stride regression`);
            assert.ok(f.f > 1000, `nmax=${nmax} lat=${lat}: |B| collapsed to ${f.f}`);
        }
    }
    // And the recursion tables themselves are allocated at full stride.
    const { P, dP } = schmidtP(1, 0.7);
    assert.equal(P.length, NMAX + 1, 'P allocated at NMAX+1 regardless of the requested nmax');
    assert.equal(dP.length, NMAX + 1, 'dP allocated at NMAX+1 regardless of the requested nmax');
    ok('trap 1 — Legendre stride: every truncation n = 1…13 is finite off-axis and on');
}

// ── 3. REGRESSION TRAP 2 — the geodetic rotation sign ────────────────────────
{
    // ψ is zero at the equator and at the poles, and positive in the northern
    // mid-latitudes. A sign flip in the rotation is invisible wherever ψ = 0.
    near(geodeticToGeocentric(0, 0).psi, 0, 1e-12, 'ψ vanishes at the equator');
    near(geodeticToGeocentric(90, 0).psi, 0, 1e-9, 'ψ vanishes at the pole');
    const psi45 = geodeticToGeocentric(45, 0).psi;
    assert.ok(psi45 > 0.15 && psi45 < 0.25, `ψ at 45°N should be ~0.19°, got ${psi45}`);
    assert.ok(geodeticToGeocentric(-45, 0).psi < 0, 'ψ is antisymmetric about the equator');

    // The rotation is orthogonal: it must preserve the field's magnitude.
    // A flipped sign still preserves magnitude, so this is necessary, not
    // sufficient — the direction check below is the one that catches it.
    const c = coeffsAt(2026.0);
    const lat = 45, lon = 10;
    const { r, latGc } = geodeticToGeocentric(lat, 0);
    const g = fieldGeocentric(c, NMAX, r, (90 - latGc) * Math.PI / 180, lon * Math.PI / 180);
    const gd = fieldGeodetic(c, NMAX, lat, lon, 0);
    near(gd.f, Math.hypot(g.br, g.btheta, g.bphi), 1e-9, 'rotation preserves |B|');

    // The direction test. With the CORRECT sign the geodetic inclination at
    // 45°N is SHALLOWER than the geocentric one by about ψ; with the sign
    // flipped it is steeper by ψ. That difference is the whole bug.
    const RAD = 180 / Math.PI;
    const incGc = Math.atan2(-g.br, Math.hypot(-g.btheta, g.bphi)) * RAD;
    assert.ok(gd.inclination < incGc,
        `geodetic inclination (${gd.inclination}) must be shallower than geocentric (${incGc}) `
        + 'at 45°N — a flipped rotation sign inverts this and is invisible at the equator');
    ok('trap 2 — geodetic rotation: ψ signed correctly, checked OFF the equator');
}

// ── 4. Pure dipole on a SPHERE: max/min = 2.000 exactly ──────────────────────
{
    // |B| at a pole is twice |B| at the equator for a centred axial dipole.
    // This is exact and independent of every constant in the model.
    const c = coeffsAt(2025.0);
    const pure = { g: c.g.map((r) => new Float64Array(r.length)), h: c.h.map((r) => new Float64Array(r.length)) };
    pure.g[1][0] = c.g[1][0];
    let mx = -Infinity, mn = Infinity;
    for (let lat = -90; lat <= 90; lat += 0.5) {
        const f = fieldGeocentric(pure, 1, REF_RADIUS_KM, (90 - lat) * Math.PI / 180, 0);
        const F = Math.hypot(f.br, f.btheta, f.bphi);
        mx = Math.max(mx, F); mn = Math.min(mn, F);
    }
    near(mx / mn, 2.0, 1e-4, 'pure dipole on a sphere, max/min');
    ok(`pure dipole on a sphere: max/min = ${(mx / mn).toFixed(6)} (gate 2.000 ± 1e-4)`);
}

// ── 5. Pure dipole on the WGS-84 ELLIPSOID: 2.0203 ───────────────────────────
{
    // The departure from 2 is flattening, not a bug. It is closed-form:
    //     max/min = 2·(a/b)³   with b = a(1−f)
    // because the pole sits closer to the centre than the equator does, and the
    // dipole falls off as r⁻³. Pinning the ANALYTIC value rather than a measured
    // one means a failure here can only be the transform.
    const c = coeffsAt(2025.0);
    const pure = { g: c.g.map((r) => new Float64Array(r.length)), h: c.h.map((r) => new Float64Array(r.length)) };
    pure.g[1][0] = c.g[1][0];
    let mx = -Infinity, mn = Infinity;
    for (let lat = -90; lat <= 90; lat += 0.25) {
        const f = fieldGeodetic(pure, 1, lat, 0, 0).f;
        mx = Math.max(mx, f); mn = Math.min(mn, f);
    }
    const b = WGS84_A_KM * (1 - WGS84_F);
    const expected = 2 * (WGS84_A_KM / b) ** 3;
    near(mx / mn, expected, 1e-5, 'pure dipole on WGS-84, max/min vs 2(a/b)³');
    // Also inside the loose figure the research code reported (2.0197 ± 0.001).
    near(mx / mn, 2.0197, 1e-3, 'pure dipole on WGS-84 vs the reported figure');
    ok(`pure dipole on WGS-84: max/min = ${(mx / mn).toFixed(6)} = 2(a/b)³ exactly (flattening, not a bug)`);
}

// ── 6. The South Atlantic Anomaly ────────────────────────────────────────────
{
    const saa = findSAA(coeffsAt(2025.0), NMAX);
    near(saa.fNt, 22071, 5, 'SAA minimum intensity at epoch 2025.0');
    assert.ok(saa.latDeg > -40 && saa.latDeg < -10, `SAA latitude off: ${saa.latDeg}`);
    assert.ok(saa.lonDeg > -80 && saa.lonDeg < -30, `SAA longitude off: ${saa.lonDeg}`);
    // It deepens and drifts west — a real, measured trend, so an epoch sweep
    // that showed it strengthening would mean the interpolation runs backwards.
    const past = findSAA(coeffsAt(1975.0), NMAX);
    assert.ok(saa.fNt < past.fNt,
        `the SAA must be deeper in 2025 (${saa.fNt}) than in 1975 (${past.fNt})`);
    ok(`SAA 2025: ${saa.fNt.toFixed(1)} nT at ${saa.latDeg.toFixed(1)}°, ${saa.lonDeg.toFixed(1)}°E (gate 22,071 ± 5)`);
}

// ── 7. Dipole diagnostics ────────────────────────────────────────────────────
{
    const d = dipole(coeffsAt(2026.0));
    near(d.tiltDeg, 9.17, 0.05, 'dipole axis offset from the spin axis, 2026');
    near(d.poleLatDeg, 80.83, 0.1, 'north geomagnetic pole latitude, 2026');
    near(d.poleLonDeg, -72.80, 0.2, 'north geomagnetic pole longitude, 2026');
    near(d.momentAm2 / 1e22, 7.7, 0.15, 'dipole moment');
    // The field is dipole-DOMINATED but not purely dipolar.
    const frac = dipoleFraction(coeffsAt(2026.0));
    assert.ok(frac > 0.9 && frac < 0.95, `dipolarity should be ~0.93, got ${frac}`);

    // Lowes–Mauersberger. At the SURFACE the spectrum falls steeply — it does
    // NOT flatten there, and an earlier version of this test asserted that it
    // did, which is simply wrong physics and the gate caught it.
    //
    // What IS true, and what justifies stopping at degree 13, is that the
    // spectrum continued DOWN to the core–mantle boundary is nearly white: a
    // near-flat spectrum at r = 3480 km is the signature of a source at that
    // radius. Roughly six decades of surface spread collapse to about half a
    // decade at the CMB.
    const cf = coeffsAt(2026.0);
    const R = lowesSpectrum(cf, NMAX);
    const Rcmb = lowesSpectrum(cf, NMAX, R_CMB_KM);
    assert.ok(R[1] > R[2] && R[2] > R[3], 'the surface spectrum must fall at low degree');
    const spread = (arr) => {
        const lg = [];
        for (let n = 2; n <= NMAX; n++) lg.push(Math.log10(arr[n]));
        return Math.max(...lg) - Math.min(...lg);
    };
    const sSurface = spread(R);
    const sCmb = spread(Rcmb);
    assert.ok(sSurface > 4, `surface spectrum should span >4 decades over n = 2…13, got ${sSurface.toFixed(2)}`);
    assert.ok(sCmb < 1, `CMB-continued spectrum should be near-white (<1 decade), got ${sCmb.toFixed(2)}`);
    ok(`dipole: tilt ${d.tiltDeg.toFixed(2)}°, pole ${d.poleLatDeg.toFixed(2)}°N, dipolarity ${(frac * 100).toFixed(1)}%`);
    ok(`Lowes spectrum n = 2…13: ${sSurface.toFixed(2)} decades at the surface → ${sCmb.toFixed(2)} at the CMB (near-white ⇒ the source is there)`);
}

// ── 8. The grid path is IDENTICAL to the scalar path ─────────────────────────
{
    // Not "close to". The grid evaluator hoists the Legendre recursion out of
    // the longitude loop and must otherwise be the same arithmetic — a stride
    // or an index slip here would show up as a smooth, plausible, wrong map.
    const c = coeffsAt(2026.0);
    const g = fieldGrid(c, NMAX, { nLat: 19, nLon: 37 });
    let worst = 0;
    for (let i = 0; i < g.nLat; i++) {
        for (let j = 0; j < g.nLon; j++) {
            const s = fieldGeodetic(c, NMAX, g.lats[i], g.lons[j], 0);
            const k = i * g.nLon + j;
            worst = Math.max(worst,
                Math.abs(s.x - g.x[k]), Math.abs(s.y - g.y[k]),
                Math.abs(s.z - g.z[k]), Math.abs(s.f - g.f[k]));
        }
    }
    assert.ok(worst < 1e-8, `grid vs scalar path differ by ${worst} nT — they must be the same arithmetic`);
    ok(`grid evaluator identical to the scalar path (max diff ${worst.toExponential(1)} nT)`);
}

// ── 9. Physical plausibility at real observatories ───────────────────────────
{
    // Coordinates are the USGS sites' published geodetic positions; the point is
    // not the third decimal, it is that a wholesale sign or frame error would
    // put inclination or intensity somewhere impossible.
    const c = coeffsAt(2026.0);
    const sites = [
        { name: 'Boulder',   lat: 40.137, lon: -105.237, fLo: 48000, fHi: 55000, incLo: 60, incHi: 70 },
        { name: 'Honolulu',  lat: 21.316, lon: -158.000, fLo: 32000, fHi: 40000, incLo: 30, incHi: 45 },
        { name: 'Hermanus',  lat: -34.425, lon: 19.225,  fLo: 24000, fHi: 32000, incLo: -70, incHi: -60 },
    ];
    for (const s of sites) {
        const f = fieldGeodetic(c, NMAX, s.lat, s.lon, 0);
        assert.ok(f.f > s.fLo && f.f < s.fHi, `${s.name}: |B| = ${f.f.toFixed(0)} nT outside [${s.fLo}, ${s.fHi}]`);
        assert.ok(f.inclination > s.incLo && f.inclination < s.incHi,
            `${s.name}: inclination = ${f.inclination.toFixed(1)}° outside [${s.incLo}, ${s.incHi}]`);
    }
    // Southern hemisphere ⇒ Z points UP (negative, in the IAGA down-positive
    // convention). A frame flip would sail past every magnitude test above.
    assert.ok(fieldGeodetic(c, NMAX, -34.425, 19.225, 0).z < 0,
        'Z must be negative (upward) in the southern hemisphere — IAGA is down-positive');
    assert.ok(fieldGeodetic(c, NMAX, 40.137, -105.237, 0).z > 0,
        'Z must be positive (downward) in the northern hemisphere');
    ok('real observatories: intensity, inclination and Z sign all physical');
}

console.log(`\n✅ geomag-igrf — ${passed} checks passed`);
