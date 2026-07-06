// catalog.js — the Storm Observatory's LEO population (20 k objects).
//
// One packed Float32Array, stride 8 per object:
//   [a_km, e, incl_rad, raan_rad, argp_rad, M0_rad, bc_m2_per_kg, cls]
// cls: 0 payload · 1 rocket body · 2 debris · 3 station · 4 Starlink shell ·
//      5 Starlink Group 4-7 cohort (the Feb-2022 batch).
//
// Two sources, one layout:
//   • synthCatalogInto(els, n, seed) — deterministic synthetic population whose
//     STRUCTURE is real (documented shells, debris clouds, the sun-sync band,
//     per-class ballistic coefficients) but whose individual objects are drawn
//     from distributions. Ships `_is_placeholder`-watermarked.
//   • packGpCatalog(gpJson) — packs real CelesTrak GP records into the same
//     layout (scripts/build-storm-catalog.mjs --gp …). Swapping the asset
//     clears the watermark; nothing downstream changes.
//
// Ballistic coefficient bc = Cd·A/m (m²/kg). Class medians follow the
// operations-console conventions: intact payloads ~0.010–0.02, rocket bodies
// ~0.006, fragmentation debris high-A/m ~0.02–0.5, Starlink (flat-pack,
// edge-on capable) ~0.004 operational. The G4-7 cohort uses bc=0.015 —
// a PASSIVE tumbling assumption (no thrust, no shark-fin attitude), tagged
// `assumed`; the page's "raise rate" dial owns the thrust side of the story.

import { R_EARTH_KM } from './units.js';

export const STRIDE = 8;
export const CLS = Object.freeze({
    PAYLOAD: 0, ROCKET_BODY: 1, DEBRIS: 2, STATION: 3, STARLINK: 4, COHORT: 5,
});
export const CLS_NAME = ['payload', 'rocket body', 'debris', 'station',
    'Starlink (operational)', 'Starlink G4-7 (Feb 2022)'];

/** Mulberry32 — deterministic PRNG (same generator family as the black-hole
 *  observatory's cluster sampler; catalog must be reproducible per seed). */
export function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
        s = (s + 0x6D2B79F5) >>> 0;
        let z = s;
        z = Math.imul(z ^ (z >>> 15), z | 1);
        z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
        return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
    };
}

function gauss(rand) {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** log-normal around median m with log10 sigma s, clamped. */
function logn(rand, m, s, lo, hi) {
    const v = m * Math.pow(10, gauss(rand) * s);
    return Math.min(Math.max(v, lo), hi);
}

const D2R = Math.PI / 180;
const TAU = 2 * Math.PI;

/** Sun-synchronous inclination for altitude h (km) — linearized fit to the
 *  J2 SSO condition over 400–1000 km (97.03° @400 → 99.48° @1000). */
function ssoIncl(hKm) {
    return (97.03 + (hKm - 400) * (2.45 / 600)) * D2R;
}

function put(els, i, aKm, e, incl, raan, argp, m0, bc, cls) {
    const j = i * STRIDE;
    els[j] = aKm; els[j + 1] = e; els[j + 2] = incl; els[j + 3] = raan;
    els[j + 4] = argp; els[j + 5] = m0; els[j + 6] = bc; els[j + 7] = cls;
}

function circ(els, i, rand, hKm, inclRad, e, bc, cls) {
    put(els, i, R_EARTH_KM + hKm, e, inclRad,
        rand() * TAU, rand() * TAU, rand() * TAU, bc, cls);
}

// Population blocks: [count, filler(els, i, rand)] — structure documented in
// each block. Counts sum to exactly 20 000 with the default n.
function blocks(rand) {
    return [
        // ── Starlink operational shells (design shells, near-circular) ──────
        ['Starlink shell 1 · 53.05° × 550 km', 1580, (els, i) =>
            circ(els, i, rand, 550 + gauss(rand) * 4, (53.05 + gauss(rand) * 0.05) * D2R,
                0.0002 + rand() * 0.0008, 0.004, CLS.STARLINK)],
        ['Starlink shell 4 · 53.22° × 540 km', 1580, (els, i) =>
            circ(els, i, rand, 540 + gauss(rand) * 4, (53.22 + gauss(rand) * 0.05) * D2R,
                0.0002 + rand() * 0.0008, 0.004, CLS.STARLINK)],
        ['Starlink shell 2 · 70° × 570 km', 700, (els, i) =>
            circ(els, i, rand, 570 + gauss(rand) * 4, (70.0 + gauss(rand) * 0.05) * D2R,
                0.0002 + rand() * 0.0008, 0.004, CLS.STARLINK)],
        ['Starlink polar · 97.65° × 560 km', 500, (els, i) =>
            circ(els, i, rand, 560 + gauss(rand) * 4, (97.65 + gauss(rand) * 0.05) * D2R,
                0.0002 + rand() * 0.0008, 0.004, CLS.STARLINK)],

        // ── the Feb-2022 cohort: 49 sats at the 210×340 km injection ───────
        // (SpaceX statement Feb 2022: deployment perigee ≈ 210 km; i = 53.22°.
        //  bc = 0.015 m²/kg is the PASSIVE-tumbling assumption — see header.)
        ['Starlink Group 4-7 · 49 @ 210×340 km', 49, (els, i) => {
            const rp = R_EARTH_KM + 210 + gauss(rand) * 2;
            const ra = R_EARTH_KM + 340 + gauss(rand) * 6;
            const a = (rp + ra) / 2, e = (ra - rp) / (ra + rp);
            put(els, i, a, e, (53.22 + gauss(rand) * 0.03) * D2R,
                rand() * TAU, rand() * TAU, rand() * TAU, 0.015, CLS.COHORT);
        }],

        // ── stations ────────────────────────────────────────────────────────
        ['ISS · 418 km × 51.64°', 1, (els, i) =>
            circ(els, i, rand, 418, 51.64 * D2R, 0.0007, 0.009, CLS.STATION)],
        ['Tiangong · 390 km × 41.47°', 1, (els, i) =>
            circ(els, i, rand, 390, 41.47 * D2R, 0.0006, 0.008, CLS.STATION)],

        // ── sun-synchronous band (EO payloads; the crowded 98° ridge) ───────
        ['sun-sync payloads · 490–850 km', 3200, (els, i) => {
            const h = 490 + rand() * 360;
            circ(els, i, rand, h, ssoIncl(h) + gauss(rand) * 0.15 * D2R,
                0.001 + rand() * 0.012, logn(rand, 0.012, 0.25, 0.004, 0.06), CLS.PAYLOAD);
        }],

        // ── fragmentation clouds (the three canonical ones) ─────────────────
        ['Cosmos-2251 debris · ~780 km × 74°', 1000, (els, i) =>
            circ(els, i, rand, 620 + Math.abs(gauss(rand)) * 160,
                (74.0 + gauss(rand) * 0.4) * D2R, 0.002 + rand() * 0.05,
                logn(rand, 0.07, 0.35, 0.01, 0.5), CLS.DEBRIS)],
        ['Iridium-33 debris · ~780 km × 86.4°', 450, (els, i) =>
            circ(els, i, rand, 650 + Math.abs(gauss(rand)) * 140,
                (86.4 + gauss(rand) * 0.3) * D2R, 0.002 + rand() * 0.04,
                logn(rand, 0.07, 0.35, 0.01, 0.5), CLS.DEBRIS)],
        ['Fengyun-1C debris · ~850 km × 98.8°', 2400, (els, i) =>
            circ(els, i, rand, 550 + Math.abs(gauss(rand)) * 250,
                (98.8 + gauss(rand) * 0.6) * D2R, 0.002 + rand() * 0.08,
                logn(rand, 0.07, 0.35, 0.01, 0.5), CLS.DEBRIS)],

        // ── general population (inclination clusters of real launch history) ─
        ['LEO payloads · mixed', 3000, (els, i) => {
            const incs = [51.6, 63.4, 74, 82.5, 87.9, 90, 97.8, 28.5, 53];
            const h = 400 + Math.pow(rand(), 0.7) * 580;
            circ(els, i, rand, h,
                (incs[(rand() * incs.length) | 0] + gauss(rand) * 0.8) * D2R,
                0.001 + rand() * 0.02, logn(rand, 0.015, 0.3, 0.004, 0.08), CLS.PAYLOAD);
        }],
        ['rocket bodies', 1200, (els, i) => {
            const incs = [51.6, 63.4, 74, 82.5, 97.8, 28.5];
            const h = 450 + Math.pow(rand(), 0.8) * 540;
            circ(els, i, rand, h,
                (incs[(rand() * incs.length) | 0] + gauss(rand) * 1.0) * D2R,
                0.005 + rand() * 0.05, logn(rand, 0.006, 0.2, 0.003, 0.02),
                CLS.ROCKET_BODY);
        }],
        ['debris · background', 4339, (els, i) => {
            const incs = [51.6, 65, 74, 82, 86.4, 90, 96, 98.5, 100];
            const h = 350 + Math.pow(rand(), 0.75) * 640;
            circ(els, i, rand, h,
                (incs[(rand() * incs.length) | 0] + gauss(rand) * 1.5) * D2R,
                0.002 + rand() * 0.09, logn(rand, 0.07, 0.4, 0.008, 0.5), CLS.DEBRIS);
        }],
    ];
}

export const CATALOG_N_DEFAULT = 20000;

/**
 * Fill `els` (Float32Array, n*STRIDE) with the synthetic population.
 * Returns meta: { cohorts:[{name, cls, start, count}], named:[{i, name}] }.
 */
export function synthCatalogInto(els, n, seed = 2022) {
    const rand = mulberry32(seed);
    const bl = blocks(rand);
    const total = bl.reduce((s, [, c]) => s + c, 0);
    if (n !== total) throw new Error(`synth catalog is sized for n=${total}, got ${n}`);
    const cohorts = [];
    const named = [];
    let i = 0;
    for (const [name, count, fill] of bl) {
        const start = i;
        for (let k = 0; k < count; k++, i++) fill(els, i);
        const cls = els[start * STRIDE + 7];
        cohorts.push({ name, cls, start, count });
        if (count === 1) named.push({ i: start, name: name.split(' · ')[0] });
        if (cls === CLS.COHORT) {
            for (let k = 0; k < count; k++) {
                named.push({ i: start + k, name: `STARLINK G4-7 #${k + 1}` });
            }
        }
    }
    return { n, seed, cohorts, named };
}

/** Pack real CelesTrak GP records (OMM JSON) into the shared layout.
 *  Keeps objects with perigee ≤ maxPerigeeKm; B* → bc via the SGP4 reference
 *  atmosphere convention bc ≈ B* / (0.157 kg·m⁻²·(Earth radii)⁻¹) · 2/ρ₀R —
 *  in practice bc[m²/kg] ≈ B*[1/ER] × 12.741621. */
export function packGpCatalog(gp, { maxPerigeeKm = 1000, maxN = CATALOG_N_DEFAULT } = {}) {
    const rows = [];
    for (const o of gp) {
        const a = Math.cbrt(398600.4418 / Math.pow(o.MEAN_MOTION * TAU / 86400, 2));
        const e = o.ECCENTRICITY;
        const perigee = a * (1 - e) - R_EARTH_KM;
        if (!(perigee > 120 && perigee <= maxPerigeeKm)) continue;
        const bc = Math.max(Math.abs(o.BSTAR ?? 0) * 12.741621, 1e-4);
        const cls = /R\/B/.test(o.OBJECT_NAME ?? '') ? CLS.ROCKET_BODY
            : /DEB/.test(o.OBJECT_NAME ?? '') ? CLS.DEBRIS
            : /STARLINK/.test(o.OBJECT_NAME ?? '') ? CLS.STARLINK : CLS.PAYLOAD;
        rows.push([a, e, o.INCLINATION * D2R, o.RA_OF_ASC_NODE * D2R,
            o.ARG_OF_PERICENTER * D2R, o.MEAN_ANOMALY * D2R, bc, cls,
            o.OBJECT_NAME, o.NORAD_CAT_ID]);
        if (rows.length >= maxN) break;
    }
    const els = new Float32Array(rows.length * STRIDE);
    const named = [];
    rows.forEach((r, i) => {
        for (let k = 0; k < 8; k++) els[i * STRIDE + k] = r[k];
        named.push({ i, name: r[8], norad: r[9] });
    });
    return { els, meta: { n: rows.length, cohorts: [], named } };
}
