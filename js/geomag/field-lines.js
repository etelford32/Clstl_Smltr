/**
 * field-lines.js — tracing the REAL field, and continuing it down to the core.
 * ═══════════════════════════════════════════════════════════════════════════
 * Pure kernel, no three.js and no DOM — it returns arrays of points, and the
 * renderer decides what to do with them. Gate: `tests/geomag-diffusion.mjs`.
 *
 * Everything here is exact within IGRF-14. Field lines are integrated through
 * the actual spherical-harmonic field by RK4, not drawn as dipole arcs, so the
 * South Atlantic Anomaly and the non-dipole structure appear because they are
 * IN the coefficients — nothing is added by hand.
 *
 * ── DOWNWARD CONTINUATION IS REAL, AND IT IS DANGEROUS ───────────────────
 *
 * The potential-field expansion is valid anywhere the field is current-free,
 * so it can be evaluated at the core–mantle boundary as legitimately as at the
 * surface: each degree simply picks up (a/r)^(n+2). That is standard practice
 * — "the field at the CMB" is a real observational product, and the reversed-
 * flux patches it reveals are real features that people publish about.
 *
 * But the amplification is brutal and it is worth being explicit about:
 * at r = 3480 km, degree 1 gains a factor of (6371.2/3480)³ ≈ 6, while degree
 * 13 gains ≈ 8,600. Continuation is an INVERSE operation and it amplifies the
 * error in the high degrees along with the signal. By degree 13 the IGRF's own
 * coefficient uncertainty is being multiplied by four orders of magnitude, and
 * beyond degree 13 the crustal field — which does NOT come from the core —
 * would be amplified as if it did.
 *
 * That is why `continuationGain()` is exported and surfaced in the UI rather
 * than buried: a CMB map is a legitimate scientific object AND a place where
 * over-interpretation is easy. The truncation at degree 13 is doing real work.
 *
 * ── REVERSED FLUX IS DEFINED AGAINST THE DIPOLE, NOT THE EQUATOR ─────────
 *
 * A reversed-flux patch is a region where B_r has the opposite sign to what
 * the AXIAL DIPOLE would give THERE. Using the geographic hemisphere instead
 * produces a false band along the magnetic equator, because the magnetic
 * equator is tilted ~9° from the geographic one. That mistake was made once in
 * the research this page came from; `isReversedFlux` below is written to make
 * it hard to repeat.
 */

import {
    coeffsAt, fieldGeocentric, dipole, NMAX, REF_RADIUS_KM,
} from './igrf.js';

export const R_CMB_KM = 3480;
export const R_INNER_CORE_KM = 1221.5;

const DEG = Math.PI / 180;

/**
 * How much a degree-n term is amplified by continuing from the reference
 * radius down to `radiusKm`. Grows without bound with n — which is the whole
 * caveat, in one number.
 */
export function continuationGain(n, radiusKm = R_CMB_KM) {
    return Math.pow(REF_RADIUS_KM / radiusKm, n + 2);
}

/** Cartesian (x, y, z) in km from geocentric radius/colatitude/longitude. */
export function sphericalToCartesian(r, theta, phi) {
    const st = Math.sin(theta);
    return [r * st * Math.cos(phi), r * st * Math.sin(phi), r * Math.cos(theta)];
}

/** Field vector in CARTESIAN components at a cartesian point, nT. */
export function fieldAtCartesian(c, nmax, x, y, z) {
    const r = Math.hypot(x, y, z);
    if (r < 1e-6) return [0, 0, 0];
    const theta = Math.acos(Math.max(-1, Math.min(1, z / r)));
    const phi = Math.atan2(y, x);
    const { br, btheta, bphi } = fieldGeocentric(c, nmax, r, theta, phi);

    // Spherical unit vectors → cartesian.
    const st = Math.sin(theta), ct = Math.cos(theta);
    const sp = Math.sin(phi), cp = Math.cos(phi);
    return [
        br * st * cp + btheta * ct * cp - bphi * sp,
        br * st * sp + btheta * ct * sp + bphi * cp,
        br * ct - btheta * st,
    ];
}

/**
 * Trace one field line by RK4 on dx/ds = ±B̂.
 *
 * Arc-length parameterisation (normalising B) rather than time — the step is
 * then a distance in km and the line is sampled evenly regardless of how
 * strong the field is, which matters because |B| varies by 6× over the surface
 * and by far more with depth.
 *
 * @param {object} c              coefficients from coeffsAt()
 * @param {object} [opts]
 * @param {number[]} opts.start   [x, y, z] in km
 * @param {number} [opts.stepKm=60]
 * @param {number} [opts.maxSteps=4000]
 * @param {number} [opts.direction=1]     +1 along B, −1 against it
 * @param {number} [opts.innerKm=R_CMB_KM] stop on reaching this radius
 * @param {number} [opts.outerKm=60000]    stop on leaving this radius
 * @returns {{points:Float64Array, count:number, stopped:string, lengthKm:number}}
 */
export function traceFieldLine(c, {
    start, stepKm = 60, maxSteps = 4000, direction = 1,
    nmax = NMAX, innerKm = R_CMB_KM, outerKm = 60000,
} = {}) {
    const pts = new Float64Array(maxSteps * 3);
    let p = [start[0], start[1], start[2]];
    let count = 0;
    let stopped = 'maxSteps';
    let lengthKm = 0;

    const dir = (q) => {
        const b = fieldAtCartesian(c, nmax, q[0], q[1], q[2]);
        const m = Math.hypot(b[0], b[1], b[2]);
        if (!(m > 0)) return null;
        return [(direction * b[0]) / m, (direction * b[1]) / m, (direction * b[2]) / m];
    };

    for (let i = 0; i < maxSteps; i++) {
        pts[count * 3] = p[0]; pts[count * 3 + 1] = p[1]; pts[count * 3 + 2] = p[2];
        count++;

        const k1 = dir(p);
        if (!k1) { stopped = 'nullField'; break; }
        const h = stepKm;
        const p2 = [p[0] + 0.5 * h * k1[0], p[1] + 0.5 * h * k1[1], p[2] + 0.5 * h * k1[2]];
        const k2 = dir(p2); if (!k2) { stopped = 'nullField'; break; }
        const p3 = [p[0] + 0.5 * h * k2[0], p[1] + 0.5 * h * k2[1], p[2] + 0.5 * h * k2[2]];
        const k3 = dir(p3); if (!k3) { stopped = 'nullField'; break; }
        const p4 = [p[0] + h * k3[0], p[1] + h * k3[1], p[2] + h * k3[2]];
        const k4 = dir(p4); if (!k4) { stopped = 'nullField'; break; }

        p = [
            p[0] + (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
            p[1] + (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]),
            p[2] + (h / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]),
        ];
        lengthKm += h;

        const r = Math.hypot(p[0], p[1], p[2]);
        if (r <= innerKm) { stopped = 'inner'; break; }
        if (r >= outerKm) { stopped = 'outer'; break; }
    }
    return { points: pts.subarray(0, count * 3), count, stopped, lengthKm };
}

/**
 * A set of field lines seeded on a ring of constant dipole latitude, traced
 * both ways from just above the CMB so they arc through the mantle and out.
 *
 * Seeding in DIPOLE latitude rather than geographic keeps the bundle
 * physically meaningful — the lines then sample comparable L-shells instead of
 * being skewed by the 9° tilt.
 */
export function seedFieldLines(c, {
    count = 24, seedLatDeg = null, seedLatitudesDeg = [30, 50, 68],
    seedRadiusKm = R_CMB_KM + 40, stepKm = 90, maxSteps = 900, nmax = NMAX,
    outerKm = 26000,
} = {}) {
    const d = dipole(c);
    const lines = [];
    // Seed latitude decides whether a line CLOSES INSIDE THE CORE or threads
    // out through the mantle, and that is physics rather than a display
    // parameter: a 30° seed re-enters the CMB within a few thousand km, a 68°
    // one runs past 25,000. Rendering several bands shows the L-shell
    // structure instead of implying every core field line escapes.
    const bands = seedLatDeg !== null ? [seedLatDeg] : seedLatitudesDeg;
    const perBand = Math.max(1, Math.round(count / bands.length));
    for (const band of bands) {
    for (let i = 0; i < perBand; i++) {
        const lonDeg = (360 * i) / perBand;
        // Dipole-frame seed → geographic direction.
        const lam = band * DEG;
        const phi = lonDeg * DEG;
        const v = [Math.cos(lam) * Math.cos(phi), Math.cos(lam) * Math.sin(phi), Math.sin(lam)];
        // Rotate the dipole frame onto geographic: z̄ = pole direction.
        const pla = d.poleLatDeg * DEG, plo = d.poleLonDeg * DEG;
        const zc = [Math.cos(pla) * Math.cos(plo), Math.cos(pla) * Math.sin(plo), Math.sin(pla)];
        const zg = [0, 0, 1];
        const dot = zg[2] * zc[2] + zg[0] * zc[0] + zg[1] * zc[1];
        let xc = [zg[0] - dot * zc[0], zg[1] - dot * zc[1], zg[2] - dot * zc[2]];
        const nx = Math.hypot(xc[0], xc[1], xc[2]);
        xc = [xc[0] / nx, xc[1] / nx, xc[2] / nx];
        const yc = [
            zc[1] * xc[2] - zc[2] * xc[1],
            zc[2] * xc[0] - zc[0] * xc[2],
            zc[0] * xc[1] - zc[1] * xc[0],
        ];
        const g = [
            v[0] * xc[0] + v[1] * yc[0] + v[2] * zc[0],
            v[0] * xc[1] + v[1] * yc[1] + v[2] * zc[1],
            v[0] * xc[2] + v[1] * yc[2] + v[2] * zc[2],
        ];
        const start = [g[0] * seedRadiusKm, g[1] * seedRadiusKm, g[2] * seedRadiusKm];

        const fwd = traceFieldLine(c, { start, stepKm, maxSteps, direction: 1, nmax, outerKm });
        const back = traceFieldLine(c, { start, stepKm, maxSteps, direction: -1, nmax, outerKm });
        // Stitch: reverse the backward half so the line reads start-to-finish.
        const total = back.count + fwd.count - 1;
        const pts = new Float64Array(total * 3);
        let k = 0;
        for (let j = back.count - 1; j >= 1; j--) {
            pts[k++] = back.points[j * 3];
            pts[k++] = back.points[j * 3 + 1];
            pts[k++] = back.points[j * 3 + 2];
        }
        for (let j = 0; j < fwd.count; j++) {
            pts[k++] = fwd.points[j * 3];
            pts[k++] = fwd.points[j * 3 + 1];
            pts[k++] = fwd.points[j * 3 + 2];
        }
        let maxR = 0;
        for (let j = 0; j < total; j++) {
            maxR = Math.max(maxR, Math.hypot(pts[j * 3], pts[j * 3 + 1], pts[j * 3 + 2]));
        }
        if (total > 3) lines.push({ points: pts, count: total, lonDeg, seedLatDeg: band, maxRadiusKm: maxR,
            escapes: maxR > REF_RADIUS_KM });
    }
    }
    return lines;
}

/**
 * Radial field B_r on a sphere of radius `radiusKm`, on a lat/lon grid.
 *
 * At the CMB this is the map geomagnetists actually work with — the one that
 * shows reversed-flux patches under the South Atlantic.
 *
 * @returns {{br:Float64Array, nLat:number, nLon:number, min:number, max:number,
 *            reversed:Uint8Array, reversedAreaFraction:number}}
 */
export function radialFieldSphere(c, {
    radiusKm = R_CMB_KM, nLat = 91, nLon = 181, nmax = NMAX,
} = {}) {
    const br = new Float64Array(nLat * nLon);
    const reversed = new Uint8Array(nLat * nLon);
    const d = dipole(c);
    let min = Infinity, max = -Infinity;
    let revArea = 0, totArea = 0;

    // The reversed-flux comparison is made against the DIPOLE'S OWN B_r,
    // evaluated from the degree-1 coefficients at the same point. Writing it
    // this way rather than as a sign rule on magnetic colatitude is
    // deliberate: the sign rule needs sign(g10) AND the pole hemisphere to
    // agree, they double-flip in a reversed epoch, and getting it backwards
    // flags ~80% of the planet as reversed — which is exactly what the first
    // version of this function did.
    const gain = Math.pow(REF_RADIUS_KM / radiusKm, 3);
    const dipoleBr = (theta, phi) => 2 * gain * (
        d.g10 * Math.cos(theta)
        + (d.g11 * Math.cos(phi) + d.h11 * Math.sin(phi)) * Math.sin(theta));

    for (let i = 0; i < nLat; i++) {
        const latDeg = 90 - (180 * i) / (nLat - 1);
        const theta = (90 - latDeg) * DEG;
        const w = Math.sin(theta);                 // area weight
        for (let j = 0; j < nLon; j++) {
            const lonDeg = -180 + (360 * j) / (nLon - 1);
            const phi = lonDeg * DEG;
            const v = fieldGeocentric(c, nmax, radiusKm, theta, phi).br;
            const k = i * nLon + j;
            br[k] = v;
            if (v < min) min = v;
            if (v > max) max = v;

            // ── Reversed flux: opposite in sign to the DIPOLE's own B_r ──
            // Not "opposite to the geographic hemisphere". The magnetic
            // equator is tilted ~9° from the geographic one, so a hemisphere
            // test paints a false band right around the planet.
            const bd = dipoleBr(theta, phi);
            if (bd !== 0 && Math.sign(v) !== Math.sign(bd)) {
                reversed[k] = 1;
                revArea += w;
            }
            totArea += w;
        }
    }
    return {
        br, nLat, nLon, min, max, reversed,
        reversedAreaFraction: totArea > 0 ? revArea / totArea : 0,
        radiusKm,
    };
}

/**
 * Ratio of the field's RMS at the CMB to its RMS at the surface, per degree.
 * Used to label the "continuation amplifies small scales" caution with a real
 * number rather than an adjective.
 */
export function continuationSpectrum(c, nmax = NMAX, radiusKm = R_CMB_KM) {
    const out = [];
    for (let n = 1; n <= nmax; n++) {
        let s = 0;
        for (let m = 0; m <= n; m++) s += c.g[n][m] ** 2 + c.h[n][m] ** 2;
        out.push({ n, gain: continuationGain(n, radiusKm), surfacePower: (n + 1) * s });
    }
    return out;
}
