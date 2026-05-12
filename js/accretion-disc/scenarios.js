/**
 * scenarios.js — Pre-set initial conditions for the accretion-disc sim.
 *
 * v1 ships the Solar System formation scenario:
 *   - Proto-Sun (1 M_sun) + Hayashi MMSN disc
 *   - 8 embryos: proto-Mercury, proto-Venus, proto-Earth, Theia,
 *     proto-Mars, three outer planetesimals (proto-Phobos/Deimos parent + asteroid)
 *   - Giant-impact module spawns the Moon from a circumterrestrial disc
 *     after Theia merges with Earth (Canup 2012; Cuk & Stewart 2012).
 *
 * All values in SI (kg, m, s). Masses scaled so the system grows from
 * planetesimal seeds (0.01-0.1 M_earth) up to present-day values via
 * pebble accretion within the simulation, but we also expose final
 * masses for the initial-condition tab "preview present-day".
 */

import { M_SUN, M_EARTH, AU, R_EARTH, YEAR, G } from './physics.js';

export const SOLAR_SYSTEM = {
    id: 'solar-system',
    label: 'Solar System formation',
    star: {
        Mstar_solar: 1.0,
        Mstar: M_SUN,
        ageStartYr: 1e5,            // 100 kyr after CAI condensation
        ageEndYr:   4.6e9,
    },
    disc: {
        Mdisc_Msun: 0.02,           // 2% solar mass — typical Class II disc
        rInAU: 0.1,
        rOutAU: 60,
        n: 90,
        alpha: 1e-3,
    },
    embryos: [
        // seed mass ~ 0.05 M_earth at the appropriate a; pebble accretion
        // grows them up to the final mass listed.
        { name: 'proto-Mercury', a_AU: 0.45,  seed_Mearth: 0.02,  final_Mearth: 0.055, density: 5430, color: 0xa07a55, role: 'rocky' },
        { name: 'proto-Venus',   a_AU: 0.75,  seed_Mearth: 0.05,  final_Mearth: 0.815, density: 5240, color: 0xe6c89b, role: 'rocky' },
        { name: 'proto-Earth',   a_AU: 1.05,  seed_Mearth: 0.08,  final_Mearth: 1.000, density: 5515, color: 0x4a90e2, role: 'rocky', flagEarth: true },
        { name: 'Theia',         a_AU: 1.00,  seed_Mearth: 0.08,  final_Mearth: 0.110, density: 4500, color: 0xff7a5a, role: 'impactor', flagTheia: true },
        { name: 'proto-Mars',    a_AU: 1.55,  seed_Mearth: 0.05,  final_Mearth: 0.107, density: 3933, color: 0xc06030, role: 'rocky' },
        { name: 'Vesta-class',   a_AU: 2.40,  seed_Mearth: 0.005, final_Mearth: 0.0001, density: 3400, color: 0x808070, role: 'asteroid' },
        { name: 'proto-Jupiter', a_AU: 5.20,  seed_Mearth: 8.0,   final_Mearth: 317.8, density: 1326, color: 0xd2a070, role: 'gas' },
        { name: 'proto-Saturn',  a_AU: 9.50,  seed_Mearth: 5.0,   final_Mearth: 95.16, density: 687,  color: 0xeac890, role: 'gas' },
    ],
    // Atmospheric inventories used by habitable.js for present-day baseline.
    atmospheres: {
        Mercury:  { p_surf_bar: 1e-14, mix: { Na: 1 },                         albedo: 0.12 },
        Venus:    { p_surf_bar: 92,     mix: { CO2: 0.965, N2: 0.035 },         albedo: 0.77 },
        Earth:    { p_surf_bar: 1,      mix: { N2: 0.78, O2: 0.21, CO2: 0.0004, H2O: 0.01 }, albedo: 0.30 },
        Mars:     { p_surf_bar: 0.006,  mix: { CO2: 0.95, N2: 0.027, Ar: 0.016 }, albedo: 0.25 },
    },
    // Giant-impact event: when Theia and proto-Earth merge.
    giantImpact: {
        v_imp_kms: 9.7,                   // ~v_esc + small, low-velocity merger (Canup 2012)
        impact_angle_deg: 45,
        diskMassMoon: 2 * 7.342e22,        // 2 lunar masses initially in circumterrestrial disc
        roche_R_earth: 2.9,                // ~2.9 R_earth fluid Roche
    },
    // Phobos / Deimos parameters (spawned after Mars finishes accreting).
    martianMoons: {
        // Phobos at 9376 km from Mars centre, inspiralling at ~2 cm/yr.
        phobos: { a_km: 9376, m_kg: 1.0659e16, drift_cm_yr: -1.8 },
        deimos: { a_km: 23463, m_kg: 1.4762e15, drift_cm_yr: +0.6 },
    },
};

export const SCENARIOS = {
    'solar-system': SOLAR_SYSTEM,
};

export const SCENARIO_ORDER = ['solar-system'];

// Build the initial body list (heliocentric x, y, vx, vy in SI) from a
// scenario descriptor. Bodies start on circular Keplerian orbits at their
// seed a_AU values with random phases.
export function buildInitialBodies(scenario) {
    const bodies = [];
    const Mstar = scenario.star.Mstar;
    for (const emb of scenario.embryos) {
        const a = emb.a_AU * AU;
        const phase = Math.random() * 2 * Math.PI;
        const v = Math.sqrt(G * Mstar / a);
        bodies.push({
            name: emb.name,
            m: emb.seed_Mearth * M_EARTH,
            density: emb.density,
            x: a * Math.cos(phase),
            y: a * Math.sin(phase),
            vx: -v * Math.sin(phase),
            vy:  v * Math.cos(phase),
            a_init: a,
            color: emb.color,
            role: emb.role,
            // metadata for game logic
            flagEarth:  !!emb.flagEarth,
            flagTheia:  !!emb.flagTheia,
            final_Mearth: emb.final_Mearth,
            R_m: cube_root(3 * emb.seed_Mearth * M_EARTH / (4 * Math.PI * emb.density)),
            alive: true,
            absorbed_by: null,
            // Atmospheric state, lazily attached after formation completes.
            atmosphere: null,
        });
    }
    return bodies;
}

function cube_root(x) { return Math.cbrt(x); }

// Update a body's geometric radius from its mass + density.
export function updateRadius(b) {
    b.R_m = Math.cbrt(3 * b.m / (4 * Math.PI * b.density));
}
