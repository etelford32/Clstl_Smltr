/**
 * igrf.js — IGRF-14 main-field evaluator, degree 13.
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SINGLE SOURCE OF TRUTH for field evaluation on this page. Every other
 * geomag module imports it. Three separate bugs in the research code that
 * preceded this port came from re-deriving something that already existed and
 * getting a sign or a stride wrong — so do not fork this file, extend it.
 *
 * Ported from `igrf_core.py` / `igrf_grid.py`, which were verified against
 * `ppigrf` to 3×10⁻⁴ nT at six sites. `tests/geomag-igrf.mjs` re-pins the
 * analytic gates that survive without a reference implementation to hand.
 *
 * ── TWO REGRESSION TRAPS LIVE IN THIS FILE ────────────────────────────────
 *
 * 1. LEGENDRE STRIDE. The P/dP tables are allocated at stride NMAX+1 and
 *    ALWAYS at full size, never at (nmax+1) for a truncated call. Sizing the
 *    allocation to the requested truncation produced a SILENT NaN for every
 *    n < 13 — silent because the recursion reads P[n-2][m] out of a row that
 *    exists at full stride and does not exist at truncated stride. The test
 *    walks n = 1…13 and asserts finite output at every truncation.
 *
 * 2. GEODETIC ROTATION SIGN. The rotation from geocentric to geodetic
 *    components is
 *        X_gd = X·cos ψ + Z·sin ψ
 *        Z_gd = −X·sin ψ + Z·cos ψ
 *    A flipped sign gives roughly 2× error and is EXACTLY ZERO at the
 *    equator, where ψ = 0 — so an equator-only test passes a broken sign.
 *    The test checks off-equator on purpose.
 *
 * ── FRAME AND UNITS ───────────────────────────────────────────────────────
 *   Geocentric spherical: r km from Earth's centre, θ colatitude, φ east
 *   longitude. Returns (Br, Bθ, Bφ) in nT.
 *   Local geodetic:  X north, Y east, Z DOWN (the IAGA convention — Z is
 *   positive downward, not upward; the northern hemisphere has Z > 0).
 */

import { NMAX, REF_RADIUS_KM, EPOCHS, COEFF_ROWS } from './igrf14-coefficients.js';

export { NMAX, REF_RADIUS_KM, EPOCHS };

/** WGS-84 ellipsoid — used ONLY for the geodetic⇄geocentric conversion. */
export const WGS84_A_KM = 6378.137;
export const WGS84_F = 1 / 298.257223563;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// ── Coefficients ─────────────────────────────────────────────────────────────

/**
 * Gauss coefficients at a decimal year, linearly interpolated between the
 * bracketing IGRF epochs (and extrapolated within 2025–2030 using the
 * secular-variation column, which is how the IGRF is defined to be used).
 *
 * Returns { g, h } as (NMAX+1)×(NMAX+1) arrays in nT. Index [n][m].
 */
export function coeffsAt(year) {
    const first = EPOCHS[0];
    const last = EPOCHS[EPOCHS.length - 1];
    const y = Math.min(Math.max(year, first), last);

    // Bracketing epoch indices.
    let hi = 1;
    while (hi < EPOCHS.length - 1 && EPOCHS[hi] < y) hi++;
    const lo = hi - 1;
    const span = EPOCHS[hi] - EPOCHS[lo];
    const f = span > 0 ? (y - EPOCHS[lo]) / span : 0;

    const g = [];
    const h = [];
    for (let n = 0; n <= NMAX; n++) {
        g.push(new Float64Array(NMAX + 1));
        h.push(new Float64Array(NMAX + 1));
    }
    for (const row of COEFF_ROWS) {
        const n = row[0];
        const m = row[1];
        const v = row[2 + lo] * (1 - f) + row[2 + hi] * f;
        if (m >= 0) g[n][m] = v;
        else h[n][-m] = v;
    }
    return { g, h, year: y, clamped: y !== year };
}

/**
 * Schmidt quasi-normalised associated Legendre functions and their θ
 * derivatives, evaluated at colatitude θ (radians).
 *
 * ALWAYS allocated at stride NMAX+1 — see trap 1 in the file header. `nmax`
 * only bounds how far the recursion runs, never how much is allocated.
 */
export function schmidtP(nmax, theta) {
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    const S = NMAX + 1;                       // ← stride, NOT nmax + 1
    const P = [];
    const dP = [];
    for (let n = 0; n < S; n++) {
        P.push(new Float64Array(S));
        dP.push(new Float64Array(S));
    }
    P[0][0] = 1;
    for (let n = 1; n <= nmax; n++) {
        for (let m = 0; m <= n; m++) {
            if (m === n) {
                const k = n > 1 ? Math.sqrt((2 * n - 1) / (2 * n)) : 1;
                P[n][n] = k * st * P[n - 1][n - 1];
                dP[n][n] = k * (st * dP[n - 1][n - 1] + ct * P[n - 1][n - 1]);
            } else {
                const d = Math.sqrt(n * n - m * m);
                const a2 = n - 2 >= m ? Math.sqrt((n - 1) * (n - 1) - m * m) : 0;
                const p2 = n - 2 >= m ? P[n - 2][m] : 0;
                const q2 = n - 2 >= m ? dP[n - 2][m] : 0;
                P[n][m] = ((2 * n - 1) * ct * P[n - 1][m] - a2 * p2) / d;
                dP[n][m] = ((2 * n - 1) * (ct * dP[n - 1][m] - st * P[n - 1][m]) - a2 * q2) / d;
            }
        }
    }
    return { P, dP };
}

/**
 * Field in geocentric spherical components.
 * @param {{g:Array,h:Array}} c   coefficients from coeffsAt()
 * @param {number} nmax           truncation degree (1…13)
 * @param {number} r              geocentric radius, km
 * @param {number} theta          colatitude, radians
 * @param {number} phi            east longitude, radians
 * @returns {{br:number, btheta:number, bphi:number}} nT
 */
export function fieldGeocentric(c, nmax, r, theta, phi) {
    const { P, dP } = schmidtP(nmax, theta);
    const st = Math.sin(theta);
    const cm = new Float64Array(NMAX + 1);
    const sm = new Float64Array(NMAX + 1);
    for (let m = 0; m <= nmax; m++) { cm[m] = Math.cos(m * phi); sm[m] = Math.sin(m * phi); }

    let br = 0, bt = 0, bp = 0;
    const onAxis = Math.abs(st) <= 1e-10;
    for (let n = 1; n <= nmax; n++) {
        const fr = Math.pow(REF_RADIUS_KM / r, n + 2);
        for (let m = 0; m <= n; m++) {
            const cc = c.g[n][m] * cm[m] + c.h[n][m] * sm[m];
            br += (n + 1) * fr * cc * P[n][m];
            bt += -fr * cc * dP[n][m];
            if (!onAxis) bp += (fr * m * (c.g[n][m] * sm[m] - c.h[n][m] * cm[m]) * P[n][m]) / st;
        }
    }
    return { br, btheta: bt, bphi: bp };
}

/**
 * WGS-84 geodetic → geocentric.
 * @returns {{r:number, latGc:number, psi:number}} r km, geocentric latitude
 *          deg, and ψ (deg) — the angle the local vertical is tilted from the
 *          radial direction. ψ is what trap 2 is about.
 */
export function geodeticToGeocentric(latGdDeg, heightKm = 0) {
    const phi = latGdDeg * DEG;
    const e2 = WGS84_F * (2 - WGS84_F);
    const sp = Math.sin(phi);
    const N = WGS84_A_KM / Math.sqrt(1 - e2 * sp * sp);
    const x = (N + heightKm) * Math.cos(phi);
    const z = (N * (1 - e2) + heightKm) * sp;
    const r = Math.hypot(x, z);
    const latGc = Math.atan2(z, x) * RAD;
    return { r, latGc, psi: latGdDeg - latGc };
}

/**
 * Field in the local geodetic frame: X north, Y east, Z DOWN (IAGA).
 * `heightKm` is height above the WGS-84 ellipsoid.
 */
export function fieldGeodetic(c, nmax, latGdDeg, lonEastDeg, heightKm = 0) {
    const { r, latGc, psi } = geodeticToGeocentric(latGdDeg, heightKm);
    const { br, btheta, bphi } = fieldGeocentric(
        c, nmax, r, (90 - latGc) * DEG, lonEastDeg * DEG);

    // Geocentric local components: X = −Bθ, Y = Bφ, Z = −Br.
    const xGc = -btheta;
    const y = bphi;
    const zGc = -br;

    // ── TRAP 2. Do not "simplify" these signs. Zero error at the equator. ──
    const p = psi * DEG;
    const x = xGc * Math.cos(p) + zGc * Math.sin(p);
    const z = -xGc * Math.sin(p) + zGc * Math.cos(p);

    return {
        x, y, z,
        h: Math.hypot(x, y),                            // horizontal intensity
        f: Math.sqrt(x * x + y * y + z * z),            // total intensity
        declination: Math.atan2(y, x) * RAD,
        inclination: Math.atan2(z, Math.hypot(x, y)) * RAD,
    };
}

/**
 * Field on a regular lat/lon grid, geodetic components at ellipsoid height.
 * Reuses one Legendre evaluation per latitude row — identical to the scalar
 * path, just without re-running the recursion 360 times per row.
 *
 * @returns {{lats:Float64Array, lons:Float64Array, f:Float64Array,
 *            x:Float64Array, y:Float64Array, z:Float64Array,
 *            nLat:number, nLon:number}}  arrays are row-major [lat][lon].
 */
export function fieldGrid(c, nmax, { nLat = 91, nLon = 181, heightKm = 0 } = {}) {
    const lats = new Float64Array(nLat);
    const lons = new Float64Array(nLon);
    for (let i = 0; i < nLat; i++) lats[i] = 90 - (180 * i) / (nLat - 1);
    for (let j = 0; j < nLon; j++) lons[j] = -180 + (360 * j) / (nLon - 1);

    const n = nLat * nLon;
    const out = {
        lats, lons, nLat, nLon,
        f: new Float64Array(n), x: new Float64Array(n),
        y: new Float64Array(n), z: new Float64Array(n),
    };

    const cm = new Float64Array(NMAX + 1);
    const sm = new Float64Array(NMAX + 1);

    for (let i = 0; i < nLat; i++) {
        const { r, latGc, psi } = geodeticToGeocentric(lats[i], heightKm);
        const theta = (90 - latGc) * DEG;
        const { P, dP } = schmidtP(nmax, theta);
        const st = Math.sin(theta);
        const onAxis = Math.abs(st) <= 1e-10;
        const cp = Math.cos(psi * DEG);
        const sp = Math.sin(psi * DEG);
        const radial = [];
        for (let d = 1; d <= nmax; d++) radial[d] = Math.pow(REF_RADIUS_KM / r, d + 2);

        for (let j = 0; j < nLon; j++) {
            const phi = lons[j] * DEG;
            for (let m = 0; m <= nmax; m++) { cm[m] = Math.cos(m * phi); sm[m] = Math.sin(m * phi); }
            let br = 0, bt = 0, bp = 0;
            for (let d = 1; d <= nmax; d++) {
                const fr = radial[d];
                for (let m = 0; m <= d; m++) {
                    const cc = c.g[d][m] * cm[m] + c.h[d][m] * sm[m];
                    br += (d + 1) * fr * cc * P[d][m];
                    bt += -fr * cc * dP[d][m];
                    if (!onAxis) bp += (fr * m * (c.g[d][m] * sm[m] - c.h[d][m] * cm[m]) * P[d][m]) / st;
                }
            }
            const xGc = -bt, zGc = -br;
            const x = xGc * cp + zGc * sp;
            const z = -xGc * sp + zGc * cp;
            const k = i * nLon + j;
            out.x[k] = x; out.y[k] = bp; out.z[k] = z;
            out.f[k] = Math.sqrt(x * x + bp * bp + z * z);
        }
    }
    return out;
}

// ── Dipole diagnostics ───────────────────────────────────────────────────────

/**
 * Everything that follows from the degree-1 coefficients alone.
 *
 * The pole latitude/longitude here is the CENTRED-DIPOLE (geomagnetic) pole —
 * the one SYM-H's cos-λ weighting is built on. It is NOT the dip pole (where
 * the field is vertical) and NOT the eccentric-dipole pole. Confusing two of
 * these definitions is what produced a 9.35° coordinate error in the research
 * that preceded this port; see js/geomag/dipole.js.
 */
export function dipole(c) {
    const g10 = c.g[1][0], g11 = c.g[1][1], h11 = c.h[1][1];
    const m = Math.sqrt(g10 * g10 + g11 * g11 + h11 * h11);   // nT
    const poleLat = 90 - Math.acos(-g10 / m) * RAD;
    const poleLon = Math.atan2(h11, g11) * RAD + 180;
    // Dipole moment in A·m²:  m = 4π a³ B / μ₀ with B in T, a in m.
    const a = REF_RADIUS_KM * 1e3;
    const moment = (4 * Math.PI * a ** 3 * (m * 1e-9)) / (4e-7 * Math.PI);
    return {
        g10, g11, h11,
        strengthNt: m,
        momentAm2: moment,
        poleLatDeg: poleLat,
        poleLonDeg: ((poleLon + 180) % 360) - 180,
        tiltDeg: 90 - poleLat,        // dipole axis offset from the spin axis
    };
}

/**
 * Dipolarity: the fraction of the mean-square field at the surface carried by
 * degree 1, via the Lowes–Mauersberger spectrum
 *     R_n = (n+1) Σ_m (g² + h²).
 */
export function dipoleFraction(c, nmax = NMAX) {
    let r1 = 0, tot = 0;
    for (let n = 1; n <= nmax; n++) {
        let s = 0;
        for (let m = 0; m <= n; m++) s += c.g[n][m] ** 2 + c.h[n][m] ** 2;
        const rn = (n + 1) * s;
        if (n === 1) r1 = rn;
        tot += rn;
    }
    return r1 / tot;
}

/**
 * Lowes–Mauersberger power spectrum R_n, nT², indexed by degree.
 *
 *     R_n(r) = (n+1) (a/r)^(2n+4) Σ_m (g² + h²)
 *
 * ── WHY THE TRUNCATION IS AT 13, AND WHY THAT IS PHYSICAL ────────────────
 * At the SURFACE this falls by nearly six decades from degree 2 to degree 13 —
 * it does not flatten, and any claim that it does at r = a is wrong.
 *
 * Continue it DOWN to the core–mantle boundary and it becomes almost flat:
 * about half a decade of spread across the same degrees. That near-white
 * spectrum at the CMB is the signature of a source AT the CMB, and it is what
 * makes degree 13 the crossover — beyond it the observed spectrum is dominated
 * by the thin magnetised crust instead, a different source at a different
 * radius. The IGRF stops at 13 for that reason, not for convenience.
 *
 * @param {number} [radiusKm=REF_RADIUS_KM] evaluation radius. Pass 3480 for the
 *        core–mantle boundary.
 */
export function lowesSpectrum(c, nmax = NMAX, radiusKm = REF_RADIUS_KM) {
    const out = new Float64Array(nmax + 1);
    for (let n = 1; n <= nmax; n++) {
        let s = 0;
        for (let m = 0; m <= n; m++) s += c.g[n][m] ** 2 + c.h[n][m] ** 2;
        out[n] = (n + 1) * Math.pow(REF_RADIUS_KM / radiusKm, 2 * n + 4) * s;
    }
    return out;
}

/** Core–mantle boundary radius, km. The radius the spectrum is white at. */
export const R_CMB_KM = 3480;

/**
 * Locate the South Atlantic Anomaly — the global minimum of total intensity —
 * by coarse grid scan then golden-ratio refinement.
 *
 * Gate: 22,071 ± 5 nT at epoch 2025.0 (tests/geomag-igrf.mjs).
 */
export function findSAA(c, nmax = NMAX) {
    const F = (lat, lon) => fieldGeodetic(c, nmax, lat, lon, 0).f;
    let best = { lat: 0, lon: 0, f: Infinity };
    for (let lat = -70; lat <= 10; lat += 2) {
        for (let lon = -120; lon <= 60; lon += 2) {
            const f = F(lat, lon);
            if (f < best.f) best = { lat, lon, f };
        }
    }
    let step = 2;
    for (let it = 0; it < 40 && step > 1e-5; it++) {
        let improved = false;
        for (const [dLat, dLon] of [[step, 0], [-step, 0], [0, step], [0, -step],
            [step, step], [step, -step], [-step, step], [-step, -step]]) {
            const f = F(best.lat + dLat, best.lon + dLon);
            if (f < best.f) { best = { lat: best.lat + dLat, lon: best.lon + dLon, f }; improved = true; }
        }
        if (!improved) step *= 0.5;
    }
    return { latDeg: best.lat, lonDeg: best.lon, fNt: best.f };
}
