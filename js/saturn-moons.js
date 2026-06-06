/**
 * saturn-moons.js — Saturn's satellites + secular orbital evolution.
 *
 * The companion to saturn-rings.js. saturn-system.html propagates every moon
 * here *analytically*: Keplerian motion about Saturn plus first-order secular
 * precession of the node (Ω) and pericentre (ω). We do NOT run an N-body loop
 * for Saturn the way the Jupiter page does for the Galileans, because:
 *   - The scientific focus is the *ring*, whose structure is set by discrete
 *     mean-motion resonances, not by mutual moon perturbations.
 *   - Saturn's moons span 0.57 d (Pan) to 550 d (Phoebe); an N-body that
 *     resolves Pan would force a punishing timestep with no payoff for the
 *     ring story.
 * Saturn's oblateness is large (J₂ ≈ 0.0163, more than 2× Jupiter's per unit
 * mass distribution effect), so the inner moons' nodes and pericentres
 * precess quickly — their orbit rings visibly rotate over a few years of sim
 * time, which is exactly the "evolution over time" the page surfaces.
 *
 * Crucially, each moon's mean motion (recomputed from a + μ) is the *pattern
 * speed* of the spiral density wave it launches in the rings — so when the
 * moons move, the ring waves co-rotate with them in real time.
 *
 * ── Data quality ──────────────────────────────────────────────────────────
 *   Mean Keplerian elements approximated from JPL SSD natural-satellite tables
 *   and NASA planetary-satellite fact sheets (≈J2000 epoch). Good for showing
 *   structure, resonance grouping, and secular evolution — not ephemeris-grade.
 */

export const R_SATURN_KM = 60268;
export const M_SATURN_KG  = 5.6834e26;
export const J2_SATURN    = 0.016298;

// Group metadata — drives the legend, picker sections, and ring styling.
export const MOON_GROUPS = {
    ringmoon: {
        label: 'Ring moons',
        color: 0xe8c97a,
        note:  'Embedded gap-clearers & ring-edge shepherds (Pan…Pandora).',
    },
    coorbital: {
        label: 'Co-orbitals',
        color: 0xc9a35e,
        note:  'Janus & Epimetheus — share one orbit and swap every ~4 yr.',
    },
    inner: {
        label: 'Inner mid-size',
        color: 0x9fd0e0,
        note:  'Mimas → Rhea. Mimas 2:1 carves the Cassini Division.',
    },
    titan: {
        label: 'Titan group',
        color: 0xd8a24a,
        note:  'Titan, chaotic Hyperion, two-tone Iapetus.',
    },
    irregular: {
        label: 'Irregular',
        color: 0xb87868,
        note:  'Phoebe — captured, retrograde, far out.',
    },
};

// a_km, e, i_deg, raan/argp/M_deg epoch angles, radius_km, color, behavior.
// `secular` (optional) overrides the computed J₂ rates (used for far moons).
export const SATURN_MOONS = [
    // ── Ring moons (gap-clearers + F-ring shepherds) ─────────────────────
    {
        key:'pan', name:'Pan', group:'ringmoon',
        a_km:133_584, e:0.00001, i_deg:0.001, raan_deg:20, argp_deg:0, M_deg:50,
        radius_km:14.1, color:0xd9c79a,
        behavior:{ icon:'🥟', title:'The “ravioli” moon · clears the Encke Gap',
            bullets:[
                'Orbits inside the Encke Gap, sweeping it clear of ring particles.',
                'A ridge of accreted ring material gives it a walnut/ravioli shape.',
                'Raises scalloped wakes on both gap edges at its synodic period.',
            ] },
    },
    {
        key:'daphnis', name:'Daphnis', group:'ringmoon',
        a_km:136_505, e:0.0000, i_deg:0.0036, raan_deg:120, argp_deg:0, M_deg:200,
        radius_km:3.8, color:0xcabfa0,
        behavior:{ icon:'🌊', title:'Wave-maker of the Keeler Gap',
            bullets:[
                'Only ~8 km across, yet it clears the 42 km Keeler Gap.',
                'Its slight inclination raises vertical waves on the gap edges.',
                'Those waves throw shadows kilometres long at Saturn’s equinox.',
            ] },
    },
    {
        key:'atlas', name:'Atlas', group:'ringmoon',
        a_km:137_670, e:0.0012, i_deg:0.003, raan_deg:200, argp_deg:0, M_deg:300,
        radius_km:15.1, color:0xd6c498,
        behavior:{ icon:'🛸', title:'Flying-saucer moon at the A-ring edge',
            bullets:[
                'A huge equatorial ridge makes it look like a flying saucer.',
                'Orbits just outside the A ring’s sharp outer edge.',
            ] },
    },
    {
        key:'prometheus', name:'Prometheus', group:'ringmoon',
        a_km:139_380, e:0.0022, i_deg:0.008, raan_deg:300, argp_deg:0, M_deg:10,
        radius_km:43.1, color:0xc9b48a,
        behavior:{ icon:'🪢', title:'Inner F-ring shepherd · streamer-channel maker',
            bullets:[
                'Its eccentric orbit periodically dips into the F ring.',
                'Each pass draws out a dark “streamer-channel” of stolen material.',
                'Together with Pandora it confines the narrow F ring.',
            ] },
    },
    {
        key:'pandora', name:'Pandora', group:'ringmoon',
        a_km:141_720, e:0.0042, i_deg:0.05, raan_deg:60, argp_deg:0, M_deg:120,
        radius_km:40.7, color:0xc4ad82,
        behavior:{ icon:'🪢', title:'Outer F-ring shepherd',
            bullets:[
                'Orbits just outside the F ring, confining it from the far side.',
                'Heavily cratered; a porous rubble pile.',
            ] },
    },

    // ── Co-orbitals — they share one orbit and swap places ───────────────
    {
        key:'epimetheus', name:'Epimetheus', group:'coorbital',
        a_km:151_410, e:0.0098, i_deg:0.351, raan_deg:80, argp_deg:0, M_deg:200,
        radius_km:58.1, color:0xc9a35e,
        behavior:{ icon:'🔁', title:'Co-orbital dancer with Janus',
            bullets:[
                'Shares an orbit with Janus — they trade inner/outer lanes every ~4 yr.',
                'They never collide: the swap is a horseshoe exchange of orbital energy.',
            ] },
    },
    {
        key:'janus', name:'Janus', group:'coorbital',
        a_km:151_460, e:0.0068, i_deg:0.163, raan_deg:150, argp_deg:0, M_deg:300,
        radius_km:89.5, color:0xd2ab66,
        behavior:{ icon:'🔁', title:'Larger co-orbital · sculptor of the A-ring edge',
            bullets:[
                'Its 7:6 resonance holds the sharp outer edge of the A ring.',
                'Swaps orbits with Epimetheus every ~4 years.',
            ] },
    },

    // ── Inner mid-size moons ─────────────────────────────────────────────
    {
        key:'mimas', name:'Mimas', group:'inner',
        a_km:185_539, e:0.0196, i_deg:1.574, raan_deg:66, argp_deg:160, M_deg:14,
        radius_km:198.2, color:0xbfe0ec,
        behavior:{ icon:'💀', title:'The “Death Star” moon · architect of the Cassini Division',
            bullets:[
                'Its 2:1 resonance clears the Cassini Division and pins the B-ring edge.',
                'The giant crater Herschel makes it look like the Death Star.',
                'Despite tidal heating debates, its surface is ancient and icy.',
            ] },
    },
    {
        key:'enceladus', name:'Enceladus', group:'inner',
        a_km:238_042, e:0.0047, i_deg:0.009, raan_deg:0, argp_deg:120, M_deg:60,
        radius_km:252.1, color:0xeaf4f7,
        behavior:{ icon:'❄️', title:'Ocean world · the source of the E ring',
            bullets:[
                'South-polar “tiger stripe” geysers vent water ice into space.',
                'That plume material continuously resupplies the broad, blue E ring.',
                'A global subsurface ocean sits beneath its bright ice shell.',
            ] },
    },
    {
        key:'tethys', name:'Tethys', group:'inner',
        a_km:294_672, e:0.0001, i_deg:1.091, raan_deg:120, argp_deg:0, M_deg:200,
        radius_km:531.1, color:0xd8e6ea,
        behavior:{ icon:'🧊', title:'Ice moon with a planet-girdling canyon',
            bullets:[
                'Almost pure water ice — one of the most reflective bodies known.',
                'Ithaca Chasma stretches three-quarters of the way around it.',
                'Holds Telesto & Calypso at its leading/trailing Lagrange points.',
            ] },
    },
    {
        key:'dione', name:'Dione', group:'inner',
        a_km:377_415, e:0.0022, i_deg:0.028, raan_deg:180, argp_deg:0, M_deg:300,
        radius_km:561.4, color:0xcdd9dc,
        behavior:{ icon:'🧊', title:'Wispy-terrain moon · in 2:1 with Enceladus',
            bullets:[
                'Bright ice cliffs (the “wispy terrain”) streak its trailing side.',
                'Its 2:1 resonance with Enceladus pumps Enceladus’ tidal heat.',
            ] },
    },
    {
        key:'rhea', name:'Rhea', group:'inner',
        a_km:527_068, e:0.0010, i_deg:0.333, raan_deg:240, argp_deg:0, M_deg:40,
        radius_km:763.8, color:0xc4cfd2,
        behavior:{ icon:'🌑', title:'Saturn’s second-largest moon',
            bullets:[
                'A heavily cratered ball of ice and rock.',
                'Tenuous oxygen–CO₂ exosphere; debated faint ring of its own.',
            ] },
    },

    // ── Titan group ──────────────────────────────────────────────────────
    {
        key:'titan', name:'Titan', group:'titan',
        a_km:1_221_865, e:0.0288, i_deg:0.349, raan_deg:300, argp_deg:0, M_deg:160,
        radius_km:2574.7, color:0xe0a64a,
        behavior:{ icon:'🟠', title:'Larger than Mercury · thick atmosphere · methane seas',
            bullets:[
                'The only moon with a dense atmosphere — 1.5× Earth’s surface pressure.',
                'Liquid-methane lakes and rivers carve its surface; a hidden water ocean below.',
                'Its 1:0 apsidal resonance shapes ringlets in the C ring.',
            ] },
    },
    {
        key:'hyperion', name:'Hyperion', group:'titan',
        a_km:1_500_880, e:0.1230, i_deg:0.43, raan_deg:30, argp_deg:90, M_deg:250,
        radius_km:135.0, color:0xb89a72,
        behavior:{ icon:'🧽', title:'Chaotically tumbling sponge-moon',
            bullets:[
                'Rotates chaotically — its spin is genuinely unpredictable.',
                'A 4:3 resonance with Titan keeps its orbit eccentric.',
                'Porous, sponge-like; deep craters with dark floors.',
            ] },
    },
    {
        key:'iapetus', name:'Iapetus', group:'titan',
        a_km:3_560_820, e:0.0286, i_deg:15.47, raan_deg:75, argp_deg:0, M_deg:130,
        radius_km:734.5, color:0x9c8a6a,
        behavior:{ icon:'🌗', title:'The two-tone moon with an equatorial ridge',
            bullets:[
                'One hemisphere is dark as coal, the other bright as snow.',
                'A 1,300 km equatorial ridge gives it a walnut profile.',
                'Highly inclined orbit — the only large moon far off the ring plane.',
            ] },
    },

    // ── Irregular (retrograde) ───────────────────────────────────────────
    {
        key:'phoebe', name:'Phoebe', group:'irregular',
        a_km:12_947_780, e:0.1562, i_deg:175.2, raan_deg:240, argp_deg:280, M_deg:20,
        radius_km:106.5, color:0xb87868,
        secular:{ node_deg_yr:-0.012, peri_deg_yr:0.012 },
        behavior:{ icon:'↩️', title:'Captured Centaur · feeds the giant Phoebe ring',
            bullets:[
                'Orbits backwards, far out and steeply inclined — a captured body.',
                'Dust knocked off it forms the enormous, tenuous Phoebe ring.',
                'Likely an escapee from the Kuiper Belt.',
            ] },
    },
];

// ── Secular precession from Saturn's oblateness (J₂) ─────────────────────
// Murray & Dermott (1999) §6.11, first-order rates. n in rad/s; a in m;
// i in rad; R_eq in m. Returns rad/s.
export function j2NodeRate(n, a, e, i, J2, R_eq) {
    const p = a * (1 - e * e);
    return -1.5 * n * J2 * (R_eq / p) * (R_eq / p) * Math.cos(i);
}
export function j2PeriRate(n, a, e, i, J2, R_eq) {
    const p = a * (1 - e * e);
    const s = Math.sin(i);
    return 1.5 * n * J2 * (R_eq / p) * (R_eq / p) * (2 - 2.5 * s * s);
}
