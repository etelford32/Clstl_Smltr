/**
 * uranus-minor-moons.js — Uranus's analytically-propagated satellites.
 *
 * The live N-body integration in uranus-system.html carries Uranus, seven inner
 * ring-moons (Cordelia, Ophelia, Cressida, Desdemona, Juliet, Portia, Puck) and
 * the five major moons (Miranda → Oberon) — the bodies whose mutual gravity and
 * Uranus's J₂ are dynamically interesting on short timescales.
 *
 * The bodies in THIS file are propagated analytically instead:
 *   - the remaining small inner moons (Bianca, Rosalind, Cupid, Belinda,
 *     Perdita, Mab) — Keplerian motion in Uranus's equatorial plane plus J₂
 *     secular precession of Ω and ω, and
 *   - the nine captured irregular satellites (Francisco → Ferdinand) on huge,
 *     eccentric, steeply inclined orbits out to ~20 million km, propagated with
 *     Keplerian motion plus a small solar-driven secular precession.
 *
 * ── Frame note ────────────────────────────────────────────────────────────────
 *   Uranus is tipped 97.77°, so its EQUATORIAL plane (rings + regular/major
 *   moons) is nearly perpendicular to its ORBITAL plane. We honour that here:
 *     frame:'equatorial' — elements referred to Uranus's equator; rendered in
 *                          the tilted system with the rings (inner ring-moons).
 *     frame:'orbital'    — elements referred to Uranus's orbital (ecliptic-ish)
 *                          plane; the captured irregulars are Sun-controlled and
 *                          orbit close to this plane, NOT the equator. They are
 *                          drawn un-tilted, so they visibly lie in a different
 *                          plane from the rings — a real consequence of the tilt.
 *
 * ── Data quality ──────────────────────────────────────────────────────────────
 *   Mean elements approximated from JPL SSD natural-satellite tables and NASA
 *   fact sheets (J2000-ish). Masses are nominal (radius + assumed density);
 *   because m ≪ M_Uranus they never enter the energy budget. Secular rates are
 *   order-of-magnitude estimates. Structure & grouping, not an ephemeris.
 */

// Group metadata — drives the legend, picker sections, and ring styling.
export const MOON_GROUPS = {
    inner: {
        label: 'Inner ring-moons',
        color: 0x9fb8c0,
        note:  'Crowded prograde moonlets among the rings — live N-body + analytic. In Uranus\'s equatorial plane.',
    },
    major: {
        label: 'Major moons',
        color: 0xbfe0e0,
        note:  'Miranda → Oberon — hold essentially all the satellite mass. Live N-body.',
    },
    prograde: {
        label: 'Irregular · prograde',
        color: 0x9ab0a0,
        note:  'Margaret — the lone prograde captured irregular.',
    },
    retrograde: {
        label: 'Irregular · retrograde',
        color: 0xc89878,
        note:  'Caliban, Sycorax, Setebos… captured retrograde, out to ~20 Gm.',
    },
};

// Each entry: Uranus-centric mean Keplerian elements at the reference epoch.
//   a_km, e, i_deg (>90 = retrograde), raan_deg Ω, argp_deg ω, M_deg,
//   period_d (display only), mass, radius_km, color, frame, behavior,
//   secular { node_deg_yr, peri_deg_yr } (optional; else J₂ fallback).
export const MINOR_MOONS = [
    // ── Remaining inner ring-moons (equatorial, J₂-precessing) ────────────────
    {
        key:'bianca', name:'Bianca', group:'inner', frame:'equatorial',
        a_km:59_166, e:0.0009, i_deg:0.193, raan_deg: 20.0, argp_deg: 50.0, M_deg:140.0,
        period_d:0.4346, mass:9.3e16, radius_km:27, color:0x9fb8c0,
        behavior:{ icon:'💠', title:'Tiny moonlet just outside the main rings',
            bullets:[
                'One of the densely-packed Portia-group moonlets.',
                'Orbits Uranus in about 10½ hours.',
                'Discovered by Voyager 2 in 1986.',
            ] },
    },
    {
        key:'rosalind', name:'Rosalind', group:'inner', frame:'equatorial',
        a_km:69_927, e:0.0001, i_deg:0.279, raan_deg:200.0, argp_deg: 90.0, M_deg: 25.0,
        period_d:0.5585, mass:2.5e17, radius_km:36, color:0x9fb8c0,
        behavior:{ icon:'💠', title:'Portia-group moonlet',
            bullets:[
                'Sits between Portia and the dusty ν (nu) ring.',
                'Part of the most crowded moon system known.',
                'Discovered by Voyager 2 in 1986.',
            ] },
    },
    {
        key:'cupid', name:'Cupid', group:'inner', frame:'equatorial',
        a_km:74_392, e:0.0013, i_deg:0.099, raan_deg: 80.0, argp_deg:150.0, M_deg:300.0,
        period_d:0.6128, mass:3.8e15, radius_km:9, color:0x9fb8c0,
        behavior:{ icon:'🌑', title:'~18 km moonlet · found only in 2003',
            bullets:[
                'One of the smallest and faintest Uranian moons.',
                'Orbits perilously close to Belinda.',
                'Discovered in Hubble images by Showalter & Lissauer (2003).',
            ] },
    },
    {
        key:'belinda', name:'Belinda', group:'inner', frame:'equatorial',
        a_km:75_255, e:0.0001, i_deg:0.031, raan_deg:130.0, argp_deg:240.0, M_deg: 60.0,
        period_d:0.6235, mass:4.9e17, radius_km:45, color:0x9fb8c0,
        behavior:{ icon:'💠', title:'Larger Portia-group moonlet',
            bullets:[
                'Tiny Cupid orbits just inside Belinda\'s path.',
                'Elongated, dark, irregular rubble like its neighbours.',
                'Discovered by Voyager 2 in 1986.',
            ] },
    },
    {
        key:'perdita', name:'Perdita', group:'inner', frame:'equatorial',
        a_km:76_417, e:0.0012, i_deg:0.470, raan_deg:300.0, argp_deg: 20.0, M_deg:210.0,
        period_d:0.6383, mass:1.8e16, radius_km:15, color:0x9fb8c0,
        behavior:{ icon:'🌑', title:'Lost, then re-found',
            bullets:[
                'Spotted in one 1986 Voyager frame, then lost for 13 years.',
                'Recovered in 1999 and confirmed in Hubble images in 2003.',
                'Drifts chaotically among its packed neighbours.',
            ] },
    },
    {
        key:'mab', name:'Mab', group:'inner', frame:'equatorial',
        a_km:97_736, e:0.0025, i_deg:0.134, raan_deg: 45.0, argp_deg:100.0, M_deg:330.0,
        period_d:0.9230, mass:1.0e16, radius_km:12, color:0x9fb8c0,
        behavior:{ icon:'💍', title:'Source of the outer μ (mu) dust ring',
            bullets:[
                'Micrometeoroid impacts knock dust off Mab to feed the blue μ ring.',
                'Outermost of the inner moons; orbits in ~22 hours.',
                'Discovered in Hubble images in 2003.',
            ] },
    },

    // ── Captured irregulars — retrograde, far out, in the ORBITAL plane ───────
    {
        key:'francisco', name:'Francisco', group:'retrograde', frame:'orbital',
        a_km:4_276_000, e:0.146, i_deg:147.5, raan_deg: 90.0, argp_deg:130.0, M_deg: 40.0,
        period_d:266.6, mass:7.0e14, radius_km:11, color:0xc89878,
        secular:{ node_deg_yr:0.10, peri_deg_yr:-0.14 },
        behavior:{ icon:'↩️', title:'Innermost irregular · retrograde',
            bullets:[
                'Closest of the captured moons; ~8.7-month orbit.',
                'Retrograde (i ≈ 148°) — not formed with Uranus.',
                'Discovered in 2001 ground-based imaging.',
            ] },
    },
    {
        key:'caliban', name:'Caliban', group:'retrograde', frame:'orbital',
        a_km:7_231_000, e:0.159, i_deg:141.5, raan_deg:160.0, argp_deg:300.0, M_deg:200.0,
        period_d:579.7, mass:2.5e17, radius_km:36, color:0xc89878,
        secular:{ node_deg_yr:0.045, peri_deg_yr:-0.060 },
        behavior:{ icon:'↩️', title:'Second-largest irregular · reddish',
            bullets:[
                'Light-red colour hints at a captured Kuiper-belt origin.',
                'May share a parent body with Stephano (similar orbits).',
                'Discovered 1997 — the first Uranian irregular found.',
            ] },
    },
    {
        key:'stephano', name:'Stephano', group:'retrograde', frame:'orbital',
        a_km:8_004_000, e:0.229, i_deg:144.1, raan_deg: 40.0, argp_deg: 80.0, M_deg:120.0,
        period_d:677.4, mass:2.2e16, radius_km:16, color:0xc09070,
        secular:{ node_deg_yr:0.038, peri_deg_yr:-0.050 },
        behavior:{ icon:'↩️', title:'Member of the Caliban family',
            bullets:[
                'Similar orbit & colour to Caliban — likely collisional siblings.',
                'Roughly a 1.9-year retrograde orbit.',
                'Discovered in 1999.',
            ] },
    },
    {
        key:'trinculo', name:'Trinculo', group:'retrograde', frame:'orbital',
        a_km:8_504_000, e:0.220, i_deg:167.1, raan_deg:220.0, argp_deg:190.0, M_deg: 60.0,
        period_d:749.2, mass:3.0e15, radius_km:9, color:0xc89878,
        secular:{ node_deg_yr:0.034, peri_deg_yr:-0.045 },
        behavior:{ icon:'↩️', title:'Small, steeply retrograde moonlet',
            bullets:[
                'Inclined ~167° — almost exactly orbiting backwards.',
                'Only ~18 km across; very faint.',
                'Discovered in 2001.',
            ] },
    },
    {
        key:'sycorax', name:'Sycorax', group:'retrograde', frame:'orbital',
        a_km:12_179_000, e:0.522, i_deg:159.4, raan_deg:300.0, argp_deg: 20.0, M_deg:280.0,
        period_d:1288.3, mass:2.5e18, radius_km:78, color:0xcc7a5a,
        secular:{ node_deg_yr:0.020, peri_deg_yr:-0.028 },
        behavior:{ icon:'🔴', title:'Largest irregular moon of Uranus · distinctly red',
            bullets:[
                'About 160 km across — by far the biggest captured moon.',
                'Strongly reddened, like many Kuiper-belt objects.',
                'Its orbit swings from ~5.8 to ~18.5 million km (e ≈ 0.52).',
            ] },
    },
    {
        key:'margaret', name:'Margaret', group:'prograde', frame:'orbital',
        a_km:14_345_000, e:0.661, i_deg:56.6, raan_deg:120.0, argp_deg:240.0, M_deg:160.0,
        period_d:1687.0, mass:5.5e14, radius_km:10, color:0x9ab0a0,
        secular:{ node_deg_yr:-0.012, peri_deg_yr:0.018 },
        behavior:{ icon:'🥚', title:'The only prograde irregular of Uranus',
            bullets:[
                'Highest eccentricity of any Uranian moon (e ≈ 0.66).',
                'Orbits the "right" way (i ≈ 57°) — unlike the retrograde swarm.',
                'Its distance ranges over ~19 million km each orbit.',
            ] },
    },
    {
        key:'prospero', name:'Prospero', group:'retrograde', frame:'orbital',
        a_km:16_256_000, e:0.445, i_deg:152.0, raan_deg: 70.0, argp_deg:110.0, M_deg: 20.0,
        period_d:1978.3, mass:8.5e15, radius_km:25, color:0xc09070,
        secular:{ node_deg_yr:0.014, peri_deg_yr:-0.020 },
        behavior:{ icon:'↩️', title:'Distant retrograde irregular',
            bullets:[
                'Grey-red; a ~5.4-year retrograde orbit.',
                'Part of the outer Prospero/Setebos pair.',
                'Discovered in 1999.',
            ] },
    },
    {
        key:'setebos', name:'Setebos', group:'retrograde', frame:'orbital',
        a_km:17_418_000, e:0.591, i_deg:158.2, raan_deg:200.0, argp_deg:300.0, M_deg:140.0,
        period_d:2225.2, mass:7.5e15, radius_km:24, color:0xc09070,
        secular:{ node_deg_yr:0.012, peri_deg_yr:-0.017 },
        behavior:{ icon:'↩️', title:'Far retrograde irregular',
            bullets:[
                'Companion to Prospero on a similar distant path.',
                'About a 6.1-year, highly eccentric retrograde orbit.',
                'Discovered in 1999.',
            ] },
    },
    {
        key:'ferdinand', name:'Ferdinand', group:'retrograde', frame:'orbital',
        a_km:20_430_000, e:0.368, i_deg:169.8, raan_deg: 10.0, argp_deg: 60.0, M_deg:250.0,
        period_d:2790.0, mass:3.0e15, radius_km:10, color:0xc89878,
        secular:{ node_deg_yr:0.009, peri_deg_yr:-0.012 },
        behavior:{ icon:'↩️', title:'The most distant moon of Uranus',
            bullets:[
                'Orbits ~20 million km out — a ~7.6-year retrograde path.',
                'Inclined ~170°, nearly orbiting straight backwards.',
                'Spotted in 2001, recovered and confirmed in 2003.',
            ] },
    },
];

// ── Secular precession from Uranus's oblateness (J₂) ──────────────────────────
// Standard first-order secular rates (Murray & Dermott 1999, §6.11). The inner
// ring-moons carry no explicit `secular`, so these drive their nodal/peri
// precession; the irregulars override with solar-driven `secular` rates.
// Returns rad/s.
export function j2NodeRate(n, a, e, i, J2, R_eq) {
    const p = a * (1 - e * e);
    return -1.5 * n * J2 * (R_eq / p) * (R_eq / p) * Math.cos(i);
}
export function j2PeriRate(n, a, e, i, J2, R_eq) {
    const p = a * (1 - e * e);
    const s = Math.sin(i);
    return 1.5 * n * J2 * (R_eq / p) * (R_eq / p) * (2 - 2.5 * s * s);
}
