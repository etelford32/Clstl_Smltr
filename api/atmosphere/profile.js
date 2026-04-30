/**
 * Vercel Edge Function: /api/atmosphere/profile
 *
 * Same contract as dsmc/pipeline/profile.py — vertical profile of
 * neutral density, temperature, and 7-species composition over the
 * thermosphere/exosphere. The difference is *where* the data comes
 * from:
 *
 *   • Python backend:  reads dsmc/sparta/tables/*.csv (real SPARTA-
 *                      refined or MSIS-bootstrap rows). Tagged
 *                      model="SPARTA-lookup" or "SPARTA-bootstrap".
 *   • This Edge fn:    interpolates the precomputed seed grid in
 *                      api/atmosphere/_seed.js — built from the JS
 *                      engine climatology. Tagged
 *                      model="SPARTA-bootstrap" because the values
 *                      come from a frozen lookup grid, not from a
 *                      runtime climatology call.
 *
 * The JS Edge function exists so the Vercel-served frontend can talk
 * to a same-origin endpoint without standing up the Python container.
 * As soon as someone runs `node scripts/build-atmosphere-seed.mjs`
 * after dropping SPARTA-refined CSVs into the build script, the same
 * card lights up with refined data — no frontend change.
 */

import { jsonOk, jsonError } from '../_lib/responses.js';
import {
    SEED_AXES, SEED_GRID, SEED_BUILT_AT, SEED_SOURCE_NOTE,
} from './_seed.js';
import {
    density,
    gravityWaveActivity,
    SPECIES,
    SPECIES_MASS_KG,
    ATMOSPHERIC_LAYERS,
    SATELLITE_REFERENCES,
} from '../../js/upper-atmosphere-engine.js';

export const config = { runtime: 'edge' };

const CACHE_TTL = 21_600;   // 6 h — same as polar-vortex; SPARTA grid only
                            //       changes when a new seed is committed.
const CACHE_SWR = 1_800;

// Index seed by alt for fast access.
const _byAlt = new Map();
for (const cell of SEED_GRID) {
    if (!_byAlt.has(cell.alt)) _byAlt.set(cell.alt, []);
    _byAlt.get(cell.alt).push(cell);
}

/** Linear interpolation along (f107, ap) given a list of grid cells at
 *  one altitude. Returns the interpolated cell. */
function _interpAtAlt(cells, f107, ap) {
    const F = SEED_AXES.F107S, A = SEED_AXES.APS;
    const fI = _bracket(F, f107);
    const aI = _bracket(A, ap);
    const get = (fi, ai) => cells.find(c => c.f107 === F[fi] && c.ap === A[ai]);

    const c00 = get(fI.lo, aI.lo);
    const c01 = get(fI.lo, aI.hi);
    const c10 = get(fI.hi, aI.lo);
    const c11 = get(fI.hi, aI.hi);
    if (!c00 || !c01 || !c10 || !c11) return null;

    // Bilinear interp in log-rho for ρ + n (they span many orders of
    // magnitude); linear in T, m̄, H.
    const lerp     = (a, b, t) => a + (b - a) * t;
    const lerpLog  = (a, b, t) =>
        Math.exp(lerp(Math.log(Math.max(a, 1e-30)),
                      Math.log(Math.max(b, 1e-30)), t));

    const tA = aI.t, tF = fI.t;
    const xLoApLo = c00, xLoApHi = c01, xHiApLo = c10, xHiApHi = c11;

    const rho_lo = lerpLog(xLoApLo.rho, xLoApHi.rho, tA);
    const rho_hi = lerpLog(xHiApLo.rho, xHiApHi.rho, tA);
    const rho    = lerpLog(rho_lo, rho_hi, tF);

    const n_lo = lerpLog(xLoApLo.n, xLoApHi.n, tA);
    const n_hi = lerpLog(xHiApLo.n, xHiApHi.n, tA);
    const n    = lerpLog(n_lo, n_hi, tF);

    const T = lerp(
        lerp(xLoApLo.T, xLoApHi.T, tA),
        lerp(xHiApLo.T, xHiApHi.T, tA),
        tF,
    );
    const m = lerp(
        lerp(xLoApLo.m, xLoApHi.m, tA),
        lerp(xHiApLo.m, xHiApHi.m, tA),
        tF,
    );
    const H = lerp(
        lerp(xLoApLo.H, xLoApHi.H, tA),
        lerp(xHiApLo.H, xHiApHi.H, tA),
        tF,
    );

    return { rho, T, n, m, H };
}

function _bracket(axis, v) {
    const lo0 = axis[0], hi0 = axis[axis.length - 1];
    if (v <= lo0) return { lo: 0, hi: 0, t: 0 };
    if (v >= hi0) return { lo: axis.length - 1, hi: axis.length - 1, t: 0 };
    for (let i = 0; i < axis.length - 1; i++) {
        if (v >= axis[i] && v <= axis[i + 1]) {
            const t = (v - axis[i]) / (axis[i + 1] - axis[i]);
            return { lo: i, hi: i + 1, t };
        }
    }
    return { lo: 0, hi: 0, t: 0 };
}

/** Bracket the seed altitude axis and bilinear-interp at the two
 *  bracketing altitudes, then linearly interp in altitude (in log-rho). */
function _interpCell(altKm, f107, ap) {
    const Z = SEED_AXES.ALTS;
    const zI = _bracket(Z, altKm);
    const cellsLo = _byAlt.get(Z[zI.lo]);
    const cellsHi = _byAlt.get(Z[zI.hi]);
    if (!cellsLo || !cellsHi) return null;
    const lo = _interpAtAlt(cellsLo, f107, ap);
    const hi = _interpAtAlt(cellsHi, f107, ap);
    if (!lo || !hi) return null;

    const t = zI.t;
    const lerp = (a, b) => a + (b - a) * t;
    const lerpLog = (a, b) =>
        Math.exp(lerp(Math.log(Math.max(a, 1e-30)),
                      Math.log(Math.max(b, 1e-30))));
    return {
        rho: lerpLog(lo.rho, hi.rho),
        T:   lerp(lo.T, hi.T),
        n:   lerpLog(lo.n, hi.n),
        m:   lerp(lo.m, hi.m),
        H:   lerp(lo.H, hi.H),
    };
}

export default async function handler(req) {
    const url = new URL(req.url);
    const f107   = num(url.searchParams.get('f107'),   150);
    const ap     = num(url.searchParams.get('ap'),      15);
    const minKm  = clamp(num(url.searchParams.get('min_km'),  80),  50, 500);
    const maxKm  = clamp(num(url.searchParams.get('max_km'), 2000), 200, 10_000);
    const n      = clamp(Math.round(num(url.searchParams.get('n_points'), 160)), 8, 600);
    const lat    = num(url.searchParams.get('lat'), 0);
    const lon    = num(url.searchParams.get('lon'), 0);

    if (maxKm <= minKm) {
        return jsonError('bad_request', 'max_km must exceed min_km',
            { source: 'atmosphere/profile' });
    }

    const samples = [];
    for (let i = 0; i < n; i++) {
        const altKm = minKm + (maxKm - minKm) * (i / (n - 1));
        const cell = _interpCell(altKm, f107, ap);
        if (!cell) continue;

        // Composition from the engine's smooth blending. Only fractions —
        // we use the seed's n_total for absolute number densities.
        const r = density({ altitudeKm: altKm, f107Sfu: f107, ap });
        const fractions = r.fractions;

        const number_densities = {};
        for (const s of SPECIES) number_densities[s] = fractions[s] * cell.n;

        samples.push({
            altitude_km:             round(altKm, 2),
            density_kg_m3:           cell.rho,
            temperature_K:           cell.T,
            scale_height_km:         cell.H,
            total_number_density:    cell.n,
            mean_molecular_mass_kg:  cell.m,
            fractions:               Object.fromEntries(
                SPECIES.map(s => [s, round(fractions[s], 8)])),
            number_densities,
        });
    }

    if (samples.length === 0) {
        return jsonError('parse_error',
            'Seed grid produced no samples — check axis coverage',
            { source: 'atmosphere/profile' });
    }

    // Compute the GW activity field on the resulting profile.
    const gwSamples = samples.map(s => ({
        altitudeKm: s.altitude_km, rho: s.density_kg_m3,
    }));
    const gw = gravityWaveActivity(gwSamples);
    const gravity_wave = {
        state:           gw.state,
        rms_pct:         gw.rmsPct,
        peak_alt_km:     gw.peakAltKm,
        peak_pct:        gw.peakPct,
        fit_scale_h_km:  gw.fitScaleHkm,
        n_points:        gw.nPoints,
        residuals:       gw.residuals.map(r => ({
            altitude_km: r.altitudeKm, residual_pct: r.residualPct,
        })),
    };

    return jsonOk({
        source:           'Parker Physics atmosphere/profile · seed-grid lookup',
        seed_built_at:    SEED_BUILT_AT,
        seed_note:        SEED_SOURCE_NOTE,
        f107_sfu:         f107,
        ap:               ap,
        f107_used:        f107,   // for parity with Python serve_drag.py
        ap_used:          ap,
        min_km:           minKm,
        max_km:           maxKm,
        n_points:         n,
        lat_deg:          lat,
        lon_deg:          lon,
        // The whole point: we're a precomputed-table source, so be
        // honest about it.
        model:            'SPARTA-bootstrap',
        layers:           ATMOSPHERIC_LAYERS.map(L => ({
            id: L.id, name: L.name,
            min_km: L.minKm, max_km: L.maxKm,
            description: L.description,
        })),
        satellites:       SATELLITE_REFERENCES.map(S => ({
            id: S.id, name: S.name, altitude_km: S.altitudeKm,
            color: S.color,
        })),
        gravity_wave,
        samples,
        issued_at_utc:    new Date().toISOString(),
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}

function num(v, fallback) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round(v, decimals = 0) {
    if (!Number.isFinite(v)) return null;
    const m = 10 ** decimals;
    return Math.round(v * m) / m;
}
