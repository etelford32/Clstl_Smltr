/**
 * neptune-minor-moons.js — Neptune's distant satellites + secular evolution.
 *
 * The live N-body integration in neptune-system.html carries Neptune, the seven
 * regular moons (Naiad → Proteus), and Triton — the only bodies whose mutual
 * gravity (and Neptune's J₂) is dynamically interesting on short timescales.
 *
 * The bodies in THIS file are the captured *irregular* satellites: huge,
 * eccentric, steeply inclined orbits ranging from Nereid out to Neso, which at
 * ~49 million km is the most distant known moon of any planet. Their orbital
 * periods run from ~1 to ~26 years, so integrating them in the N-body loop would
 * add nothing visible while bloating the step count. Instead they are propagated
 * analytically: Keplerian motion about Neptune plus *linear secular precession*
 * of the ascending node (Ω) and argument of pericentre (ω), which is the
 * dominant long-term evolution for these solar-perturbed orbits.
 *
 * ── Frame note ────────────────────────────────────────────────────────────────
 *   These elements are referred (approximately) to the ecliptic, as the
 *   irregulars are conventionally tabulated. The page renders the whole system
 *   in Neptune's equatorial frame and then tilts it by the 28.32° obliquity, so
 *   the irregulars' planes are shown to within that obliquity ambiguity — fine
 *   for structure, scale, and prograde/retrograde grouping; not an ephemeris.
 *
 * ── Data quality ──────────────────────────────────────────────────────────────
 *   Mean elements approximated from JPL SSD natural-satellite tables and NASA
 *   fact sheets (J2000-ish). Masses are nominal (radius + assumed density);
 *   because m ≪ M_Neptune they never enter the energy budget. Secular rates are
 *   order-of-magnitude estimates of the solar-driven precession.
 */

// Group metadata — drives the legend, picker sections, and ring styling.
export const MOON_GROUPS = {
    regular: {
        label: 'Regular',
        color: 0x8fb0d8,
        note:  'Inner prograde moons + ring shepherds, live N-body. Near Neptune\'s equator.',
    },
    triton: {
        label: 'Triton',
        color: 0xe6b98a,
        note:  'Captured, retrograde, tidally decaying — 99.5% of the satellite mass.',
    },
    prograde: {
        label: 'Irregular · prograde',
        color: 0x9ab0a0,
        note:  'Nereid (eccentric) + Sao/Laomedeia — captured prograde.',
    },
    retrograde: {
        label: 'Irregular · retrograde',
        color: 0xc89878,
        note:  'Halimede/Psamathe/Neso — captured retrograde, out to ~49 Gm.',
    },
};

// Each entry: Neptune-centric mean Keplerian elements at the reference epoch.
//   a_km, e, i_deg (>90 = retrograde), raan_deg Ω, argp_deg ω, M_deg,
//   period_d (display only), mass, radius_km, color, behavior,
//   secular { node_deg_yr, peri_deg_yr }.
export const MINOR_MOONS = [
    // ── Nereid — large, wildly eccentric prograde irregular ───────────────
    {
        key:'nereid', name:'Nereid', group:'prograde',
        a_km:5_513_818, e:0.7507, i_deg:7.09, raan_deg:326.0, argp_deg:281.0, M_deg:318.0,
        period_d:360.13, mass:3.1e19, radius_km:178.5, color:0x9ab0a0,
        secular:{ node_deg_yr:-0.05, peri_deg_yr:0.08 },
        behavior:{ icon:'🥚', title:'One of the most eccentric moons known (e ≈ 0.75)',
            bullets:[
                'Its distance from Neptune swings from ~1.4 to ~9.7 million km each orbit.',
                'Discovered by Gerard Kuiper in 1949 — the second Neptunian moon found.',
                'May be a regular moon flung onto this orbit when Triton was captured.',
            ] },
    },

    // ── Irregular prograde — Sao group ────────────────────────────────────
    {
        key:'sao', name:'Sao', group:'prograde',
        a_km:22_422_000, e:0.2827, i_deg:49.9, raan_deg:60.0, argp_deg:110.0, M_deg:25.0,
        period_d:2914.1, mass:6.0e15, radius_km:22, color:0x8aa090,
        secular:{ node_deg_yr:-0.012, peri_deg_yr:0.018 },
        behavior:{ icon:'🌑', title:'Small captured prograde irregular',
            bullets:[
                'Takes nearly 8 years to circle Neptune.',
                'Inclined ~50° — a captured planetesimal, not formed in place.',
                'Discovered in 2002 from ground-based surveys.',
            ] },
    },
    {
        key:'laomedeia', name:'Laomedeia', group:'prograde',
        a_km:23_571_000, e:0.4339, i_deg:34.7, raan_deg:200.0, argp_deg:40.0, M_deg:300.0,
        period_d:3167.9, mass:5.0e15, radius_km:21, color:0x86a08c,
        secular:{ node_deg_yr:-0.010, peri_deg_yr:0.015 },
        behavior:{ icon:'🌑', title:'Eccentric prograde irregular',
            bullets:[
                'Its orbit ranges over ~20 million km between peri- and apoapsis.',
                'Discovered 2002 together with Sao and Halimede.',
                'Roughly an 8.7-year orbital period.',
            ] },
    },

    // ── Irregular retrograde — Halimede / Psamathe / Neso ─────────────────
    {
        key:'halimede', name:'Halimede', group:'retrograde',
        a_km:15_728_000, e:0.2909, i_deg:134.1, raan_deg:175.0, argp_deg:200.0, M_deg:80.0,
        period_d:1879.7, mass:1.6e17, radius_km:31, color:0xc89878,
        secular:{ node_deg_yr:0.020, peri_deg_yr:-0.028 },
        behavior:{ icon:'↩️', title:'Retrograde irregular · likely Nereid fragment',
            bullets:[
                'Grey colour matches Nereid — the two may share a collisional origin.',
                'Orbits backwards (i ≈ 134°), tilted far from Neptune\'s equator.',
                'About a 5.1-year orbit; discovered 2002.',
            ] },
    },
    {
        key:'psamathe', name:'Psamathe', group:'retrograde',
        a_km:46_695_000, e:0.4617, i_deg:137.4, raan_deg:280.0, argp_deg:170.0, M_deg:120.0,
        period_d:9115.0, mass:4.0e15, radius_km:20, color:0xc09070,
        secular:{ node_deg_yr:0.004, peri_deg_yr:-0.006 },
        behavior:{ icon:'↩️', title:'Extremely distant retrograde moon (~25-yr orbit)',
            bullets:[
                'Shares an orbit family with Neso — probably one body that split.',
                'Apoapsis carries it nearly 70 million km from Neptune.',
                'Highly retrograde (i ≈ 137°); discovered 2003.',
            ] },
    },
    {
        key:'neso', name:'Neso', group:'retrograde',
        a_km:49_285_000, e:0.4243, i_deg:131.3, raan_deg:50.0, argp_deg:60.0, M_deg:210.0,
        period_d:9374.0, mass:6.0e15, radius_km:30, color:0xcc9c7c,
        secular:{ node_deg_yr:0.0035, peri_deg_yr:-0.005 },
        behavior:{ icon:'↩️', title:'The most distant known moon in the Solar System',
            bullets:[
                'Orbits ~49 million km out — a ~26-year, retrograde, eccentric path.',
                'So far away it nearly escapes Neptune\'s gravitational reach.',
                'Likely a sibling fragment of Psamathe; discovered 2002.',
            ] },
    },
];

// ── Secular precession from Neptune's oblateness (J₂) ────────────────────
// Standard first-order secular rates (Murray & Dermott 1999, §6.11). Provided
// for completeness / parity with the Jupiter module; the irregulars above all
// carry explicit `secular` rates so these are only a fallback. Returns rad/s.
export function j2NodeRate(n, a, e, i, J2, R_eq) {
    const p = a * (1 - e * e);
    return -1.5 * n * J2 * (R_eq / p) * (R_eq / p) * Math.cos(i);
}
export function j2PeriRate(n, a, e, i, J2, R_eq) {
    const p = a * (1 - e * e);
    const s = Math.sin(i);
    return 1.5 * n * J2 * (R_eq / p) * (R_eq / p) * (2 - 2.5 * s * s);
}
