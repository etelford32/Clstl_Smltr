/**
 * jupiter-minor-moons.js — Minor Jovian satellites + secular orbital evolution.
 *
 * The live N-body integration in jupiter-system.html carries only the four
 * Galilean moons, because they are the only bodies whose mutual gravity is
 * dynamically significant (the Laplace resonance lives there). The bodies in
 * THIS file are 4–6 orders of magnitude less massive, so their mutual pull is
 * sub-pixel and integrating them in the N-body loop would also force a tiny
 * timestep (Metis orbits in 7 hours) and destabilise the Galilean integration.
 *
 * Instead these are propagated analytically: Keplerian motion about Jupiter
 * plus *linear secular precession* of the ascending node (Ω) and argument of
 * pericentre (ω). That precession is the dominant long-term ("secular")
 * orbital evolution for these bodies and is what makes their orbit rings
 * visibly rotate over years of sim time:
 *
 *   - Inner moonlets (Metis…Thebe) precess fast, driven by Jupiter's
 *     oblateness (J₂). Rates are COMPUTED from J₂ at runtime (see
 *     j2NodeRate / j2PeriRate) so they stay physically self-consistent.
 *   - Irregular outer moons (Himalia/Ananke/Carme/Pasiphae groups) feel
 *     negligible J₂ at millions of km; their precession is solar-driven.
 *     Those rates are TABULATED (`secular`) as approximate secular values.
 *
 * ── Frame note ────────────────────────────────────────────────────────────
 *   Inner-moon inclinations are referred to Jupiter's equator/Laplace plane
 *   (like the Galileans). Irregular-moon inclinations are referred to the
 *   ecliptic, as they are conventionally tabulated — so their orbit planes
 *   show the large mutual tilt that is physically real for that population.
 *
 * ── Data quality ──────────────────────────────────────────────────────────
 *   Mean elements approximated from JPL SSD natural-satellite element tables
 *   and NASA planetary-satellite fact sheets (J2000-ish epoch). These are
 *   mean (not ephemeris-grade) elements — good for showing structure, scale,
 *   resonance grouping, and secular evolution, not for predicting a transit.
 *   Mean motion is recomputed from `a` and μ at propagation time, so periods
 *   listed here are display-only.
 *
 *   Masses are nominal; because m ≪ M_Jupiter they do not measurably affect
 *   μ = G(M_J + m) and never enter the N-body energy budget.
 */

// Group metadata — drives the legend, picker sections, and ring styling.
export const MOON_GROUPS = {
    inner: {
        label: 'Inner moonlets',
        color: 0xb5704a,
        note:  'Ring shepherds, inside Io. Fast J₂-driven precession.',
    },
    galilean: {
        label: 'Galilean',
        color: 0xddc63a,
        note:  'The four live N-body moons (1:2:4 Laplace resonance).',
    },
    prograde: {
        label: 'Irregular · prograde',
        color: 0x8aa0b8,
        note:  'Himalia group — captured prograde, i ≈ 28°.',
    },
    retrograde: {
        label: 'Irregular · retrograde',
        color: 0xc08878,
        note:  'Ananke/Carme/Pasiphae groups — captured retrograde, i > 90°.',
    },
};

// Each entry: jovicentric mean Keplerian elements at the reference epoch.
//   a_km           semi-major axis (km)
//   e              eccentricity
//   i_deg          inclination (deg; >90 = retrograde)
//   raan_deg       longitude of ascending node Ω (deg)
//   argp_deg       argument of pericentre ω (deg)
//   M_deg          mean anomaly at epoch (deg)
//   period_d       orbital period (days, display only)
//   mass / radius_km / color / behavior  → presentation
//   secular        OPTIONAL { node_deg_yr, peri_deg_yr } — if present, used
//                  instead of the computed J₂ rates (for the irregulars).
export const MINOR_MOONS = [
    // ── Inner moonlets (J₂-driven precession computed at runtime) ─────────
    {
        key:'metis', name:'Metis', group:'inner',
        a_km:128_000, e:0.0002, i_deg:0.06, raan_deg:146.0, argp_deg:184.0, M_deg:276.0,
        period_d:0.2948, mass:3.6e16, radius_km:21.5, color:0x9a8d80,
        behavior:{ icon:'🪨', title:'Innermost moon · main-ring source',
            bullets:[
                'Orbits below the synchronous radius — tides pull it slowly inward.',
                'Sheds dust that feeds Jupiter\'s main ring.',
                'Orbits Jupiter in 7 hours — faster than Jupiter spins.',
            ] },
    },
    {
        key:'adrastea', name:'Adrastea', group:'inner',
        a_km:129_000, e:0.0015, i_deg:0.03, raan_deg:228.0, argp_deg:48.0, M_deg:11.0,
        period_d:0.2983, mass:2.0e15, radius_km:8.2, color:0x8f8478,
        behavior:{ icon:'🪨', title:'Tiny ring shepherd at the main ring\'s edge',
            bullets:[
                'One of the smallest named moons — ~16 km across.',
                'Orbits just outside the main ring\'s outer edge.',
                'Also sub-synchronous — spiralling toward Jupiter.',
            ] },
    },
    {
        key:'amalthea', name:'Amalthea', group:'inner',
        a_km:181_366, e:0.0032, i_deg:0.374, raan_deg:108.0, argp_deg:155.0, M_deg:185.0,
        period_d:0.4982, mass:2.08e18, radius_km:83.45, color:0xb5462e,
        behavior:{ icon:'🟥', title:'Reddest object in the Solar System · gossamer-ring source',
            bullets:[
                'Redder than Mars — likely sulfur from Io painting its surface.',
                'Radiates more heat than it receives; may flex tidally.',
                'Its dust feeds the inner gossamer ring.',
            ] },
    },
    {
        key:'thebe', name:'Thebe', group:'inner',
        a_km:221_889, e:0.0176, i_deg:1.076, raan_deg:235.0, argp_deg:234.0, M_deg:135.0,
        period_d:0.6745, mass:4.3e17, radius_km:49.3, color:0xa05a40,
        behavior:{ icon:'🟫', title:'Outermost inner moonlet · outer gossamer-ring source',
            bullets:[
                'Its eccentric orbit\'s apsidal line precesses visibly under J₂.',
                'Feeds the fainter outer gossamer ring.',
                'Bears one giant crater, Zethus, nearly its own size.',
            ] },
    },

    // ── Irregular prograde — Himalia group (solar-driven precession) ──────
    {
        key:'leda', name:'Leda', group:'prograde',
        a_km:11_165_000, e:0.1636, i_deg:27.46, raan_deg:218.0, argp_deg:271.0, M_deg:230.0,
        period_d:240.92, mass:6.3e15, radius_km:10, color:0x7c8aa0,
        secular:{ node_deg_yr:-0.28, peri_deg_yr:0.40 },
        behavior:{ icon:'🌑', title:'Smallest Himalia-group member',
            bullets:[
                'Captured prograde object orbiting ~160× farther than Io.',
                'Shares its inclination band with Himalia — a collisional family.',
                'Takes ~8 months to circle Jupiter.',
            ] },
    },
    {
        key:'himalia', name:'Himalia', group:'prograde',
        a_km:11_461_000, e:0.1623, i_deg:27.50, raan_deg:44.0, argp_deg:332.0, M_deg:67.0,
        period_d:250.56, mass:6.7e18, radius_km:85, color:0x8aa0b8,
        secular:{ node_deg_yr:-0.27, peri_deg_yr:0.39 },
        behavior:{ icon:'🌑', title:'Largest irregular moon of Jupiter',
            bullets:[
                'Biggest of the captured satellites — the namesake of its family.',
                'Imaged as a faint elongated dot by Cassini in 2000.',
                'Orbit plane precesses slowly under solar tugs.',
            ] },
    },
    {
        key:'lysithea', name:'Lysithea', group:'prograde',
        a_km:11_717_000, e:0.1124, i_deg:28.30, raan_deg:6.0, argp_deg:50.0, M_deg:330.0,
        period_d:259.20, mass:6.3e16, radius_km:18, color:0x768498,
        secular:{ node_deg_yr:-0.26, peri_deg_yr:0.37 },
        behavior:{ icon:'🌑', title:'Himalia-group prograde irregular',
            bullets:[
                'Low-eccentricity member of the prograde cluster.',
                'Likely a fragment from the break-up that formed the family.',
                'Inclination ~28° to the ecliptic.',
            ] },
    },
    {
        key:'elara', name:'Elara', group:'prograde',
        a_km:11_741_000, e:0.2174, i_deg:26.63, raan_deg:110.0, argp_deg:144.0, M_deg:25.0,
        period_d:259.64, mass:8.7e17, radius_km:43, color:0x809ab0,
        secular:{ node_deg_yr:-0.26, peri_deg_yr:0.37 },
        behavior:{ icon:'🌑', title:'Second-largest prograde irregular',
            bullets:[
                'Most eccentric of the main Himalia group.',
                'Its pericentre swings inward and out as ω precesses.',
                'Discovered photographically in 1905.',
            ] },
    },

    // ── Irregular retrograde — Ananke/Carme/Pasiphae groups ───────────────
    {
        key:'ananke', name:'Ananke', group:'retrograde',
        a_km:21_276_000, e:0.2435, i_deg:148.89, raan_deg:8.0, argp_deg:101.0, M_deg:60.0,
        period_d:610.45, mass:3.0e16, radius_km:14, color:0xc08070,
        secular:{ node_deg_yr:0.30, peri_deg_yr:-0.34 },
        behavior:{ icon:'↩️', title:'Namesake of the Ananke retrograde family',
            bullets:[
                'Orbits backwards (i ≈ 149°) — captured, not formed in place.',
                'Defines a tight cluster of small retrograde fragments.',
                'Highly inclined orbit precesses against the prograde moons.',
            ] },
    },
    {
        key:'carme', name:'Carme', group:'retrograde',
        a_km:23_404_000, e:0.2533, i_deg:164.91, raan_deg:114.0, argp_deg:28.0, M_deg:200.0,
        period_d:702.28, mass:1.3e17, radius_km:23, color:0xb87868,
        secular:{ node_deg_yr:0.27, peri_deg_yr:-0.30 },
        behavior:{ icon:'↩️', title:'Largest retrograde irregular · family namesake',
            bullets:[
                'Steeply retrograde (i ≈ 165°), nearly polar-reversed.',
                'Parent of the Carme collisional family.',
                'D-type reddish surface — a captured outer-Solar-System body.',
            ] },
    },
    {
        key:'pasiphae', name:'Pasiphae', group:'retrograde',
        a_km:23_624_000, e:0.4090, i_deg:151.43, raan_deg:266.0, argp_deg:170.0, M_deg:120.0,
        period_d:708.0, mass:3.0e17, radius_km:30, color:0xc88878,
        secular:{ node_deg_yr:0.26, peri_deg_yr:-0.29 },
        behavior:{ icon:'↩️', title:'Most eccentric large irregular',
            bullets:[
                'e ≈ 0.41 — its distance from Jupiter nearly doubles each orbit.',
                'Pericentre and node both precess under the Sun\'s pull.',
                'Parent of the Pasiphae retrograde family.',
            ] },
    },
    {
        key:'sinope', name:'Sinope', group:'retrograde',
        a_km:23_939_000, e:0.2495, i_deg:158.11, raan_deg:303.0, argp_deg:347.0, M_deg:15.0,
        period_d:724.5, mass:7.5e16, radius_km:19, color:0xbe8070,
        secular:{ node_deg_yr:0.25, peri_deg_yr:-0.28 },
        behavior:{ icon:'↩️', title:'Outermost classical moon · ~2-year orbit',
            bullets:[
                'One of the most distant of the classical (pre-2000) moons.',
                'Retrograde and inclined ~158° — a captured straggler.',
                'Nearly 335 Jupiter-radii out at apoapsis.',
            ] },
    },
];

// ── Secular precession from Jupiter's oblateness (J₂) ────────────────────
// Standard first-order secular rates (Murray & Dermott 1999, §6.11).
// Valid for close-in, modest-e/i satellites. Returns rad/s.
// n is mean motion (rad/s); a in m; i in rad; R_eq in m.

/** dΩ/dt — nodal regression (negative for prograde). */
export function j2NodeRate(n, a, e, i, J2, R_eq) {
    const p = a * (1 - e * e);
    return -1.5 * n * J2 * (R_eq / p) * (R_eq / p) * Math.cos(i);
}

/** dω/dt — apsidal precession. */
export function j2PeriRate(n, a, e, i, J2, R_eq) {
    const p = a * (1 - e * e);
    const s = Math.sin(i);
    return 1.5 * n * J2 * (R_eq / p) * (R_eq / p) * (2 - 2.5 * s * s);
}
