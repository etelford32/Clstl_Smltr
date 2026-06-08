/**
 * spaceship-designer-engine.js — Design data model + performance math for the
 * Space Ship Designer page.
 *
 * This is the "rules of the rocket" layer: it defines the catalog of parts a
 * player can bolt together (engines, propellants, nosecones, cockpits,
 * liveries) and turns a design blob into real, physically-grounded numbers —
 * stage masses, thrust, the Tsiolkovsky Δv budget, and a full surface-to-orbit
 * ascent via the validated integrator in launch-physics.js.
 *
 * Nothing here touches the DOM or Three.js — it is a pure transform layer so
 * the 3D view, the stats panel and the saved-design store can all share one
 * source of truth. Design blobs round-trip losslessly through JSON, which is
 * what gets persisted to Supabase / localStorage.
 *
 * Reuses:
 *   launch-engines.js  → real engine thrust/Isp specs (single source of truth)
 *   launch-physics.js  → LAUNCH_BODIES + simulateAscent (the ascent integrator)
 */

import { ENGINES } from './launch-engines.js';
import { LAUNCH_BODIES, simulateAscent, atmosphericPressure } from './launch-physics.js';

const G0 = 9.80665;            // m/s² — standard gravity (Isp definition)

// ── Propellant catalog ───────────────────────────────────────────────────────
// `density` is the *bulk* propellant+oxidizer mixture density (kg/m³) used to
// estimate how much propellant a tank of a given volume holds. These are
// effective mixture densities at typical mass ratios, not pure-component
// densities. `flame` drives the plume tint in the 3D view.
//
// `advanced: true` parts are only offered to signed-in pilots — the sign-in
// reward is a deeper palette, not a separate paywall tier.
export const PROPELLANTS = {
    kerolox: {
        id: 'kerolox', name: 'RP-1 / LOX', short: 'Kerolox',
        density: 1030, flame: 0xffa64d, tank: 0xc9d2da,
        note: 'Dense, storable-ish, soot-rich orange flame. Falcon 9 / Saturn V.',
    },
    methalox: {
        id: 'methalox', name: 'CH₄ / LOX', short: 'Methalox',
        density: 830, flame: 0x8fd6ff, tank: 0xd7dde2,
        note: 'Clean blue flame, reusable-friendly, easy to make on Mars. Starship.',
    },
    hydrolox: {
        id: 'hydrolox', name: 'LH₂ / LOX', short: 'Hydrolox',
        density: 360, flame: 0xbcd2ff, tank: 0xe7913a,
        note: 'Highest chemical Isp, but very low density → huge tanks. SLS / Shuttle.',
    },
    hypergolic: {
        id: 'hypergolic', name: 'N₂O₄ / UDMH', short: 'Hypergolic',
        density: 1180, flame: 0xffcf7a, tank: 0xb9a07a,
        note: 'Ignites on contact, infinitely storable, toxic. Proton / many upper stages.',
    },
    solid: {
        id: 'solid', name: 'APCP Solid', short: 'Solid',
        density: 1750, flame: 0xffe6a3, tank: 0x8b8b90,
        note: 'Cast grain — huge thrust, no throttle, no shutdown. Shuttle SRBs.',
    },
    // ── Advanced (sign-in) ──
    nuclear: {
        id: 'nuclear', name: 'Nuclear Thermal (LH₂)', short: 'Nuclear',
        density: 71, flame: 0x9bffe0, tank: 0xc7ccd2, advanced: true,
        note: 'Hydrogen heated by a reactor — ~900 s Isp. Low TWR, in-space stages.',
    },
    ion: {
        id: 'ion', name: 'Xenon (Ion)', short: 'Ion',
        density: 1600, flame: 0x66ccff, tank: 0xb4c4d0, advanced: true,
        note: 'Whisper-thrust, thousands of seconds Isp. Deep-space cruise, not liftoff.',
    },
};

// ── Engine catalog ───────────────────────────────────────────────────────────
// Wraps the real specs from launch-engines.js with the extra metadata the
// designer needs: which nozzle `bell` to render, the default propellant, and
// whether it is a sign-in-only "advanced" part.
function eng(id, bell, propellant, extra = {}) {
    const base = ENGINES[id] || {};
    return { id, bell, propellant, ...base, ...extra };
}

export const ENGINE_CATALOG = {
    merlin_1d: eng('merlin_1d', 'merlin', 'kerolox', {
        label: 'Merlin 1D', note: 'Gas-generator kerolox workhorse. 9× on Falcon 9.',
    }),
    raptor_2: eng('raptor_2', 'raptor', 'methalox', {
        label: 'Raptor 2', note: 'Full-flow staged-combustion methalox. 33× on Super Heavy.',
    }),
    // ── Advanced (sign-in) ──
    raptor_3: eng('raptor_3', 'raptor', 'methalox', {
        label: 'Raptor 3', advanced: true, note: 'Higher chamber pressure, integrated plumbing.',
    }),
    rs_25: eng('rs_25', 'rs25', 'hydrolox', {
        label: 'RS-25 (SSME)', advanced: true, note: 'Reusable hydrolox, sea-level Isp 366 s.',
    }),
    f1: eng('f1', 'generic', 'kerolox', {
        label: 'F-1', advanced: true, throatR: 0.55, exitR: 1.9, length: 3.7,
        note: 'Saturn V first stage. 5× = 34 MN. The big one.',
    }),
    rsrm: eng('rsrm', 'rsrm', 'solid', {
        label: 'RSRM (Solid)', advanced: true, note: 'Shuttle solid booster. No throttle, no off-switch.',
    }),
    raptor_vac: eng('raptor_2_vac', 'raptor_vac', 'methalox', {
        label: 'Raptor Vacuum', advanced: true, note: 'High-expansion bell for upper stages.',
    }),
    merlin_vac: eng('merlin_vac', 'merlin_vac', 'kerolox', {
        label: 'Merlin Vacuum', advanced: true, note: 'Falcon 9 second-stage engine.',
    }),
};

// ── Cosmetic / structural catalogs ───────────────────────────────────────────
// `aero` carries the measured-ish drag character of each nose shape, referenced
// to the vehicle cross-section (A = π·r_max²):
//   cdpForm — subsonic pressure (form) drag of the nose. Near-zero for a sharp
//             streamlined nose; large for a blunt body that pushes a fat
//             stagnation region of air ahead of it.
//   kWave   — supersonic wave-drag scale at a reference nose fineness (~3). The
//             dominant nose effect: a bow shock the vehicle must shove aside.
// Rankings follow the classic nose-cone drag literature (Hoerner; the model-
// rocketry "nose cone comparison" data): von-Kármán/ogive ≈ best, sharp cone a
// close second, blunt fairings worse, and a blunt crew capsule worst of all
// (it is shaped to brake on reentry, not to slip through Max-Q).
export const NOSECONE_TYPES = {
    ogive: { id: 'ogive', name: 'Ogive fairing', note: 'Smooth payload fairing.',
        aero: { cdpForm: 0.04, kWave: 0.10, dragClass: 'low',
            blurb: 'Tangent-ogive fairing — low wave drag, the all-round transonic optimum.' } },
    cone: { id: 'cone', name: 'Sharp cone', note: 'Pointed sounding-rocket nose.',
        aero: { cdpForm: 0.05, kWave: 0.13, dragClass: 'low',
            blurb: 'Sharp cone — clean attached supersonic flow; a touch more transonic drag than an ogive.' } },
    blunt: { id: 'blunt', name: 'Blunt fairing', note: 'Wide bulbous fairing.',
        aero: { cdpForm: 0.10, kWave: 0.30, dragClass: 'high',
            blurb: 'Blunt fairing — a strong detached bow shock drives heavy transonic / supersonic wave drag.' } },
    capsule: { id: 'capsule', name: 'Crew capsule', note: 'Gumdrop crew module.',
        aero: { cdpForm: 0.22, kWave: 0.55, dragClass: 'very high',
            blurb: 'Blunt crew capsule — built to brake on reentry, not to slip through Max-Q. Pays a real ascent drag penalty.' } },
    spaceplane: { id: 'spaceplane', name: 'Spaceplane', advanced: true, note: 'Winged upper stage.',
        aero: { cdpForm: 0.08, kWave: 0.18, dragClass: 'moderate', wing: true,
            blurb: 'Winged lifting body — moderate wave drag plus extra skin friction from the exposed wing area.' } },
};

export const FIN_TYPES = {
    none: { id: 'none', name: 'No fins' },
    grid: { id: 'grid', name: 'Grid fins', note: 'Lattice control surfaces (reusable boosters).' },
    delta: { id: 'delta', name: 'Delta fins', note: 'Triangular stabilisers.' },
    swept: { id: 'swept', name: 'Swept fins', advanced: true, note: 'Aggressive swept-back fins.' },
};

export const COCKPIT_LAYOUTS = {
    none: { id: 'none', name: 'Uncrewed', crewMax: 0 },
    analog: { id: 'analog', name: 'Analog gauges', crewMax: 3, note: 'Switches & dials. Apollo era.' },
    glass: { id: 'glass', name: 'Glass cockpit', crewMax: 7, advanced: true, note: 'Touchscreen flight deck. Dragon era.' },
    hybrid: { id: 'hybrid', name: 'Hybrid deck', crewMax: 4, advanced: true, note: 'Screens + physical abort handles.' },
};

export const LIVERIES = {
    classic: { id: 'classic', name: 'Classic White', primary: 0xeef2f6, secondary: 0xc6ced6, accent: 0x2b6cff },
    falcon: { id: 'falcon', name: 'Falcon Mono', primary: 0xf4f6f8, secondary: 0x1b1d22, accent: 0xd0d4da },
    retro: { id: 'retro', name: 'Retro Red', primary: 0xf2efe6, secondary: 0xd23b2e, accent: 0x2a2a2a },
    midnight: { id: 'midnight', name: 'Midnight', primary: 0x10131a, secondary: 0x2a3550, accent: 0x00c6ff, advanced: true },
    sunrise: { id: 'sunrise', name: 'Sunrise', primary: 0xffd9a0, secondary: 0xff7a59, accent: 0x6a2cff, advanced: true },
    forest: { id: 'forest', name: 'Forest', primary: 0xdfe9d8, secondary: 0x2f6b3a, accent: 0xe0b020, advanced: true },
};

export const PATTERNS = ['solid', 'stripe', 'bands', 'checker'];

export const LAUNCH_BODY_OPTIONS = Object.values(LAUNCH_BODIES).map((b) => ({
    id: b.id, name: b.name, note: b.atmosphere,
}));

// ── Default design ───────────────────────────────────────────────────────────
// A two-stage kerolox rocket — the "Falcon-ish" starting point requested as the
// default. Everything below is editable in the UI.
export function defaultDesign() {
    return {
        v: 1,
        name: 'Aurora I',
        bodyId: 'earth',
        targetAltKm: 200,
        stages: [
            { diameter_m: 3.7, length_m: 55, engineId: 'merlin_1d', engineCount: 9, propellantId: 'kerolox', fillFrac: 0.82, dryFrac: 0.06, throttle: 1 },
            { diameter_m: 3.7, length_m: 13, engineId: 'merlin_1d', engineCount: 1, propellantId: 'kerolox', fillFrac: 0.80, dryFrac: 0.09, throttle: 1 },
        ],
        payload: { mass_kg: 5000, nosecone: 'ogive', fairingLen_m: 11 },
        cockpit: { layout: 'none', crew: 0, windows: 2 },
        fins: { type: 'grid', count: 4 },
        livery: { id: 'classic', pattern: 'solid' },
    };
}

// ── Small helpers ────────────────────────────────────────────────────────────
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Is a catalog part one of the sign-in-only "advanced" options? */
export function isAdvancedDesign(design) {
    const reasons = [];
    for (const [i, s] of design.stages.entries()) {
        if (ENGINE_CATALOG[s.engineId]?.advanced) reasons.push(`Stage ${i + 1} engine`);
        if (PROPELLANTS[s.propellantId]?.advanced) reasons.push(`Stage ${i + 1} propellant`);
    }
    if (design.stages.length > 2) reasons.push('3+ stages');
    if (NOSECONE_TYPES[design.payload?.nosecone]?.advanced) reasons.push('Nosecone');
    if (FIN_TYPES[design.fins?.type]?.advanced) reasons.push('Fins');
    if (COCKPIT_LAYOUTS[design.cockpit?.layout]?.advanced) reasons.push('Cockpit');
    if (LIVERIES[design.livery?.id]?.advanced) reasons.push('Livery');
    return reasons;
}

// ── Performance math ─────────────────────────────────────────────────────────
/**
 * Compute masses, thrust and the staged Δv budget for a design.
 * Stage index 0 is the first (bottom) stage that fires at liftoff.
 *
 * Returns:
 *   stages[]  per-stage { propMass, dryMass, wetMass, thrustSL_kN, thrustVac_kN,
 *                         isp_s, dv_kms, twr }
 *   totalWet_kg, totalDry_kg, propMass_kg, payload_kg
 *   liftoffThrust_kN, liftoffTWR, totalDv_kms, maxDiameter_m, height_m
 */
export function computeStats(design, body = LAUNCH_BODIES[design.bodyId] || LAUNCH_BODIES.earth) {
    const g_body = (body.mu_km3s2 * 1e9) / Math.pow(body.R_km * 1000, 2);   // surface gravity (m/s²)
    const payloadMass = Math.max(0, design.payload?.mass_kg || 0);
    const crewMass = (design.cockpit?.crew || 0) * 120;                     // ~120 kg per crew incl. seat/suit
    const topMass = payloadMass + crewMass;

    const stages = design.stages.map((s) => {
        const e = ENGINE_CATALOG[s.engineId] || ENGINE_CATALOG.merlin_1d;
        const prop = PROPELLANTS[s.propellantId] || PROPELLANTS.kerolox;
        const r = s.diameter_m / 2;
        const volume = Math.PI * r * r * s.length_m * clamp(s.fillFrac, 0.2, 0.95);
        const propMass = volume * prop.density;
        const dryFrac = clamp(s.dryFrac, 0.03, 0.5);
        const wetMass = propMass / (1 - dryFrac);
        const dryMass = wetMass - propMass;
        const thrustSL = (e.sl_kn || 0) * s.engineCount * clamp(s.throttle ?? 1, 0.4, 1);
        const thrustVac = (e.vac_kn || e.sl_kn || 0) * s.engineCount * clamp(s.throttle ?? 1, 0.4, 1);
        // Lower stages quote sea-level Isp, upper stages vacuum Isp.
        const isp = (e.isp_vac && e.isp_sl) ? e.isp_sl : (e.isp_vac || e.isp_sl || 300);
        return { ...s, engine: e, prop, propMass, dryMass, wetMass, thrustSL_kN: thrustSL, thrustVac_kN: thrustVac, isp_s: isp, ispVac_s: e.isp_vac || isp };
    });

    const totalWet = stages.reduce((a, s) => a + s.wetMass, 0) + topMass;
    const totalDry = stages.reduce((a, s) => a + s.dryMass, 0) + topMass;
    const propMassTotal = stages.reduce((a, s) => a + s.propMass, 0);

    // Staged Δv: each stage burns with everything above it (and payload) as its
    // payload. Lower stages use sea-level Isp, upper stages use vacuum Isp.
    let dvTotal = 0;
    for (let i = 0; i < stages.length; i++) {
        const above = stages.slice(i + 1).reduce((a, s) => a + s.wetMass, 0) + topMass;
        const m0 = stages[i].wetMass + above;
        const mf = stages[i].dryMass + above;
        const ispUse = i === 0 ? stages[i].isp_s : stages[i].ispVac_s;
        const ve = ispUse * G0;
        const dv = (mf > 0 && m0 > mf) ? ve * Math.log(m0 / mf) : 0;
        stages[i].dv_kms = dv / 1000;
        stages[i].twr = stages[i].thrustSL_kN * 1000 / Math.max(m0 * g_body, 1e-9);
        dvTotal += dv;
    }

    const liftoffThrust = stages[0]?.thrustSL_kN || 0;
    const liftoffTWR = liftoffThrust * 1000 / Math.max(totalWet * g_body, 1e-9);
    const maxDiameter = Math.max(...stages.map((s) => s.diameter_m), 1);
    const noseLen = design.payload?.fairingLen_m || 8;
    const height = stages.reduce((a, s) => a + s.length_m, 0) + noseLen;

    return {
        stages,
        totalWet_kg: totalWet,
        totalDry_kg: totalDry,
        propMass_kg: propMassTotal,
        payload_kg: topMass,
        liftoffThrust_kN: liftoffThrust,
        liftoffTWR,
        totalDv_kms: dvTotal / 1000,
        maxDiameter_m: maxDiameter,
        height_m: height,
        g_body,
        bodyName: body.name,
    };
}

// ── Nozzle physics (de Laval) ────────────────────────────────────────────────
/**
 * The catalog gives sea-level & vacuum thrust + Isp. Combined with a per-engine
 * expansion ratio ε = Aₑ/Aₜ and the propellant's combustion gas properties, that
 * is enough to reconstruct the actual converging-diverging nozzle: the exit Mach
 * number from the isentropic area–Mach relation, the exit pressure pₑ, the exit
 * velocity, the thrust coefficient C_F, and — crucially — the altitude at which
 * the nozzle is perfectly expanded (pₑ = pₐ). Off that point the engine runs
 * over- or under-expanded; far enough over-expanded the flow separates from the
 * nozzle wall (Summerfield: pₑ/pₐ ≲ 0.35) and the engine cannot run there at all.
 *
 * Thrust *magnitude* still comes from the measured catalog ratings (more accurate
 * than ideal nozzle theory); this layer adds the physical nozzle state on top —
 * for the telemetry readout and to drive the plume's real expansion shape.
 */

// Combustion-gas properties per propellant: ratio of specific heats γ,
// characteristic velocity c* (m/s), chamber temperature Tc (K). Representative
// equilibrium values from standard propellant performance tables.
export const PROP_GAS = {
    kerolox:    { gamma: 1.21, cstar: 1715, Tc_K: 3670 },
    methalox:   { gamma: 1.17, cstar: 1800, Tc_K: 3550 },
    hydrolox:   { gamma: 1.20, cstar: 2360, Tc_K: 3550 },
    hypergolic: { gamma: 1.23, cstar: 1700, Tc_K: 3400 },
    solid:      { gamma: 1.18, cstar: 1550, Tc_K: 3300 },
    nuclear:    { gamma: 1.30, cstar: 2800, Tc_K: 2700 },
    ion:        { electrostatic: true },     // not a thermal de Laval nozzle
};

// Per-engine nozzle: area ratio ε and chamber pressure (Pa). Public data.
const ENGINE_NOZZLE = {
    merlin_1d:    { eps: 16,  pc_pa: 9.7e6 },
    merlin_vac:   { eps: 165, pc_pa: 9.7e6 },
    raptor_2:     { eps: 34,  pc_pa: 30e6 },
    raptor_2_vac: { eps: 80,  pc_pa: 30e6 },
    raptor_3:     { eps: 35,  pc_pa: 35e6 },
    rs_25:        { eps: 69,  pc_pa: 20.6e6 },
    rsrm:         { eps: 12,  pc_pa: 6.3e6 },
    f1:           { eps: 16,  pc_pa: 7.0e6 },
};
const BELL_EPS = { merlin: 16, raptor: 34, raptor_vac: 80, merlin_vac: 165, rs25: 69, rsrm: 12, generic: 16 };
const PC_BY_PROP = { kerolox: 9.7e6, methalox: 30e6, hydrolox: 20e6, hypergolic: 15e6, solid: 6e6, nuclear: 5e6 };

/** Vandenkerckhove function Γ(γ) — appears in choked-flow / c* relations. */
const vdk = (g) => Math.sqrt(g) * Math.pow(2 / (g + 1), (g + 1) / (2 * (g - 1)));

/** Isentropic area ratio A/A* for a supersonic Mach number. */
function areaRatio(M, g) {
    return (1 / M) * Math.pow((2 / (g + 1)) * (1 + (g - 1) / 2 * M * M), (g + 1) / (2 * (g - 1)));
}

/** Solve the area–Mach relation for the supersonic exit Mach given ε. */
function machFromAreaRatio(eps, g) {
    let lo = 1.0001, hi = 30;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (areaRatio(mid, g) > eps) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
}

/**
 * Reconstruct the nozzle for one engine. Intensive quantities (ε, Mₑ, pₑ, vₑ,
 * C_F) are per-engine; throat/exit areas scale with the engine count.
 */
export function computeNozzle(engineDef, propId, count = 1, body = LAUNCH_BODIES.earth) {
    const gas = PROP_GAS[propId] || PROP_GAS.kerolox;
    if (gas.electrostatic) {
        return { electrostatic: true, eps: 0, exitMach: 0, pe_pa: 0,
            ve_ms: (engineDef.isp_vac || 3000) * G0, note: 'Electrostatic thruster — no gas-dynamic nozzle.' };
    }
    const g = gas.gamma, cstar = gas.cstar, Tc = gas.Tc_K;
    const eps = ENGINE_NOZZLE[engineDef.id]?.eps || BELL_EPS[engineDef.bell] || 16;
    const pc = ENGINE_NOZZLE[engineDef.id]?.pc_pa || PC_BY_PROP[propId] || 9.7e6;

    const Me = machFromAreaRatio(eps, g);
    const tempRatio = 1 + (g - 1) / 2 * Me * Me;
    const pe = pc * Math.pow(tempRatio, -g / (g - 1));        // exit static pressure
    const Te = Tc / tempRatio;

    const Rspec = Math.pow(cstar * vdk(g), 2) / Tc;           // from c* = √(R·Tc)/Γ
    const ae = Math.sqrt(g * Rspec * Te);                     // exit speed of sound
    const ve = Me * ae;                                       // exit gas velocity

    const F_vac1 = (engineDef.vac_kn || engineDef.sl_kn || 0) * 1000;
    const ispVac = engineDef.isp_vac || engineDef.isp_sl || 300;
    const mdot1 = ispVac > 0 ? F_vac1 / (ispVac * G0) : 0;
    const At1 = pc > 0 ? mdot1 * cstar / pc : 0;              // throat area (choked flow)
    const Ae1 = eps * At1;
    const CF_vac = (pc > 0 && At1 > 0) ? F_vac1 / (pc * At1) : 0;

    // Altitude where this nozzle is perfectly expanded (pₐ = pₑ) on this body.
    const p0 = body.p0_pa || 0, H_m = (body.H_km || 8.5) * 1000;
    const optAlt_m = (p0 > 0 && pe < p0 && pe > 0) ? H_m * Math.log(p0 / pe) : 0;

    return {
        electrostatic: false,
        eps, pc_pa: pc, pe_pa: pe, Te_K: Te, exitMach: Me, ve_ms: ve,
        cstar, gamma: g, CF_vac,
        At_m2: At1 * count, Ae_m2: Ae1 * count,
        optAlt_m,
    };
}

/**
 * Classify the nozzle's expansion against ambient pressure and return a 0..1
 * "expansion" figure for the plume shader (0 = tight overexpanded sea-level
 * plume, 1 = wide billowing vacuum plume).
 */
export function expansionState(nozzle, p_a) {
    if (!nozzle || nozzle.electrostatic) return { state: 'electrostatic', ratio: 0, separated: false, expansion01: 1 };
    const pe = nozzle.pe_pa;
    if (p_a <= 1e-6) return { state: 'under', ratio: Infinity, separated: false, expansion01: 1 };
    const ratio = pe / p_a;                              // pₑ/pₐ
    const separated = ratio < 0.35;                      // Summerfield separation
    let state;
    if (separated)       state = 'separated';
    else if (ratio > 1.05) state = 'under';
    else if (ratio < 0.95) state = 'over';
    else                   state = 'optimal';
    const expansion01 = clamp(0.5 + 0.5 * Math.log10(ratio), 0, 1);
    return { state, ratio, separated, expansion01 };
}

/** Convenience: stage-N nozzle expansion at a given altitude on the design's body. */
export function designStageExpansion01(design, stageIndex, alt_m) {
    const body = LAUNCH_BODIES[design.bodyId] || LAUNCH_BODIES.earth;
    const s = design.stages?.[stageIndex];
    if (!s) return 0.2;
    const e = ENGINE_CATALOG[s.engineId] || ENGINE_CATALOG.merlin_1d;
    const noz = computeNozzle(e, s.propellantId, 1, body);
    const p_a = (body.p0_pa || 0) * Math.exp(-((alt_m || 0) / 1000) / (body.H_km || 8.5));
    return expansionState(noz, p_a).expansion01;
}

// ── Aerodynamics ──────────────────────────────────────────────────────────────
/**
 * Measured-ish aerodynamic model for a design. Total drag coefficient
 * (referenced to the cross-sectional area A = π·r_max²) is split into the three
 * physical contributions a real rocket fights on the way up:
 *
 *   • Skin friction  — viscous shear in the boundary layer over the whole
 *     wetted surface. Turbulent above Re≈5·10⁵ (it almost always is), with a
 *     Van-Driest compressibility correction at high Mach. Scales with how long
 *     and slender the vehicle is (wetted-area / reference-area ratio).
 *   • Pressure drag  — base drag behind the engines + the nose's subsonic form
 *     drag. Base drag is bled down while the engines fire (the plume fills the
 *     near-wake).
 *   • Wave drag      — the energy radiated into the bow shock once the flow goes
 *     transonic. This is the dominant nose-shape effect: it switches on near the
 *     drag-divergence Mach (~0.8), overshoots at the transonic peak (~M 1.05),
 *     then settles to a slowly-falling supersonic plateau.
 *
 * Re/Cf use Schlichting flat-plate correlations; the body form factor follows
 * Hoerner. These are engineering correlations, not CFD — good to tens of
 * percent, which is the right fidelity for a design-it-yourself sandbox.
 */
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a || 1e-9), 0, 1); return t * t * (3 - 2 * t); };

// Transonic/supersonic wave-drag shape factor (×kWave gives the nose's Cd_wave).
function waveFactor(M) {
    if (M <= 0.8) return 0;
    const onset = smoothstep(0.8, 1.05, M);              // drag divergence
    const spike = 0.35 * Math.exp(-Math.pow((M - 1.08) / 0.16, 2)); // transonic overshoot
    const decay = M > 1.2 ? Math.pow(1.2 / M, 0.42) : 1; // slow supersonic falloff
    return onset * decay + spike;
}

function flowRegime(M) {
    if (M < 0.8) return 'subsonic';
    if (M < 1.2) return 'transonic';
    if (M < 5)   return 'supersonic';
    return 'hypersonic';
}

/**
 * Build the aero profile for a design. Returns geometry, a Mach-dependent total
 * Cd (for the integrator), a per-state `components` breakdown (for telemetry),
 * and a few measured reference points for the static readout.
 */
export function computeAero(design, stats = computeStats(design), body = LAUNCH_BODIES[design.bodyId] || LAUNCH_BODIES.earth) {
    const D = Math.max(0.5, stats.maxDiameter_m);
    const r = D / 2;
    const refArea = Math.PI * r * r;
    const L = Math.max(D, stats.height_m);
    const noseLen = Math.max(0.5, design.payload?.fairingLen_m || 8);
    const fineness = L / D;                       // whole-vehicle slenderness
    const noseFineness = noseLen / D;             // nose slenderness
    const mu = body.mu_pas || 1.81e-5;            // dynamic viscosity

    const nose = NOSECONE_TYPES[design.payload?.nosecone] || NOSECONE_TYPES.ogive;
    const na = nose.aero || NOSECONE_TYPES.ogive.aero;

    // Wetted area: body cylinder + cone-approximated nose (+ wings if present).
    let wetted = Math.PI * D * Math.max(0, L - noseLen) + Math.PI * r * Math.hypot(noseLen, r);
    if (na.wing) wetted *= 1.35;                  // exposed wing surfaces
    const wetRatio = wetted / refArea;

    // Hoerner slender-body form factor (interference of the boundary layer with
    // the body's own pressure field). ~1.05 for a slender booster, higher stubby.
    const formFactor = 1 + 1.5 / Math.pow(fineness, 1.5) + 7 / Math.pow(fineness, 3);

    // Nose wave-drag scale, adjusted for how pointed this particular nose is.
    const finenessAdj = clamp(Math.pow(3.0 / Math.max(0.4, noseFineness), 0.6), 0.4, 2.5);
    const cdWaveBase = na.kWave * finenessAdj;

    // Per-state breakdown. `powered` lets base drag be bled by the plume.
    function components(M, rho, v, { powered = true } = {}) {
        const Re = (rho > 0 && v > 0) ? (rho * v * L) / mu : 0;

        // Skin friction — laminar below the transition Re, turbulent above.
        let cf = 0, boundaryLayer = 'none';
        if (Re > 1e3) {
            if (Re < 5e5) { cf = 1.328 / Math.sqrt(Re); boundaryLayer = 'laminar'; }
            else { cf = 0.455 / Math.pow(Math.log10(Re), 2.58); boundaryLayer = 'turbulent'; }
            cf /= Math.pow(1 + 0.144 * M * M, 0.65);   // Van-Driest compressibility
        }
        const cdFriction = cf * wetRatio * formFactor;

        // Base drag (referenced to A): subsonic plateau, transonic bump, then a
        // supersonic decline. Bled to ~half while the engines are firing.
        let cdBase;
        if (M < 0.8)      cdBase = 0.13;
        else if (M < 1.2) cdBase = 0.13 + 0.12 * smoothstep(0.8, 1.05, M);
        else              cdBase = Math.max(0.05, 0.25 / (1 + 0.5 * (M - 1.2)));
        if (powered) cdBase *= 0.5;

        // Nose: subsonic form drag (always present) + wave drag (transonic+).
        const cdForm = na.cdpForm;
        const cdWave = cdWaveBase * waveFactor(M);
        const cdPressure = cdBase + cdForm;

        const cdTotal = cdFriction + cdPressure + cdWave;
        return {
            reynolds: Re, cf, boundaryLayer, regime: flowRegime(M),
            cdFriction, cdBase, cdForm, cdPressure, cdWave, cdTotal,
        };
    }

    // Total Cd in the (mach, v, alt, rho) signature the integrator calls with.
    const cd = (M, v, _alt, rho) => components(M, rho, v).cdTotal;

    // Measured reference points for the static panel (use surface density).
    const rho0 = body.rho0_kg_m3;
    const a = body.a_sound_ms || 340;
    const ref = {
        subsonic:   components(0.5,  rho0, 0.5 * a),
        transonic:  components(1.05, rho0, 1.05 * a),
        supersonic: components(3.0,  rho0, 3.0 * a),
    };

    return {
        refArea_m2: refArea, wettedArea_m2: wetted, wetRatio,
        fineness, noseFineness,
        noseId: nose.id, noseName: nose.name, dragClass: na.dragClass, blurb: na.blurb,
        hasAtmosphere: rho0 > 1e-6,
        cd, components, reference: ref,
    };
}

/**
 * Run a full surface-to-orbit ascent for the design by collapsing it into the
 * effective single-stage vehicle that launch-physics.simulateAscent expects.
 * The integrator is the validated one from the launch planner; we just feed it
 * design-derived parameters.
 */
export function runAscent(design) {
    const body = LAUNCH_BODIES[design.bodyId] || LAUNCH_BODIES.earth;
    const stats = computeStats(design, body);
    if (!stats.totalWet_kg || stats.propMass_kg <= 0) {
        return { ...emptyAscent(body), stats };
    }

    // Effective (flight-averaged) Isp — kept for display / legacy fallback only.
    let ispW = 0, propW = 0;
    stats.stages.forEach((s, i) => {
        const isp = i === 0 ? (s.isp_s + s.ispVac_s) / 2 : s.ispVac_s;
        ispW += isp * s.propMass; propW += s.propMass;
    });
    const ispEff = propW > 0 ? ispW / propW : 300;

    // Real, nose-shape-dependent drag: a Mach-varying Cd from the aero model.
    const aero = computeAero(design, stats, body);

    // Build the real multi-stage propulsion spec. Each stage carries its own
    // sea-level & vacuum thrust (so thrust rises with altitude) and a fixed
    // turbopump mass flow set by its vacuum rating; the integrator jettisons the
    // spent stage's dry mass at burnout. This replaces the old single-stage
    // collapse with a genuine staged thrust/TWR profile.
    const nozzles = stats.stages.map((s) => computeNozzle(s.engine, s.propellantId, s.engineCount, body));
    const stagesSpec = stats.stages.map((s) => {
        const thr = clamp(s.throttle ?? 1, 0.4, 1);
        const F_sl_N  = (s.thrustSL_kN  || 0) * 1000;   // already includes count × throttle
        const F_vac_N = (s.thrustVac_kN || 0) * 1000;
        const ispVac  = s.ispVac_s || s.isp_s || 300;
        const mdot    = ispVac > 0 ? F_vac_N / (ispVac * G0) : 0;   // kg/s, ~constant per stage
        return { propMass_kg: s.propMass, dryMass_kg: s.dryMass,
                 F_sl_N, F_vac_N, mdot_kgs: mdot, Isp_vac_s: ispVac, throttle: thr };
    });

    const vehicle = {
        id: 'custom', name: design.name || 'Custom vehicle',
        m0_kg: stats.totalWet_kg,
        payload_kg: stats.payload_kg,
        stages: stagesSpec,
        Cd: aero.cd,                 // Mach-dependent (function) — integrator handles both
        A_m2: aero.refArea_m2,
        // Legacy fields kept so non-staged readers still have something sane.
        Isp_s: ispEff,
        TWR_E: stats.liftoffThrust_kN * 1000 / (stats.totalWet_kg * G0),
        dry_frac: clamp((stats.totalDry_kg) / stats.totalWet_kg, 0.02, 0.6),
    };

    const result = simulateAscent({ body, vehicle, target_alt_km: design.targetAltKm || 200 });

    // Enrich each powered-ascent sample with the aero force breakdown and the
    // active nozzle's expansion state (drives the live panels and the plume).
    const A = aero.refArea_m2;
    for (const p of result.trajectory) {
        const c = aero.components(p.mach || 0, p.rho || 0, (p.v_kms || 0) * 1000);
        const q_pa = (p.q_kPa || 0) * 1000;
        p.cdFriction = c.cdFriction; p.cdPressure = c.cdPressure; p.cdWave = c.cdWave;
        p.reynolds = c.reynolds; p.boundaryLayer = c.boundaryLayer; p.regime = c.regime;
        p.dragFriction_kN = q_pa * c.cdFriction * A / 1000;
        p.dragPressure_kN = q_pa * c.cdPressure * A / 1000;
        p.dragWave_kN     = q_pa * c.cdWave     * A / 1000;

        const noz = nozzles[(p.stage || 1) - 1] || nozzles[0];
        const p_a = atmosphericPressure(body, (p.alt_km || 0) * 1000);
        const ex = expansionState(noz, p_a);
        p.pa_pa = p_a; p.pe_pa = noz?.pe_pa || 0;
        p.exitMach = noz?.exitMach || 0;
        p.nozzleState = ex.state; p.peOverPa = ex.ratio; p.expansion01 = ex.expansion01;
        p.separated = ex.separated;
    }

    return { ...result, stats, ispEff, aero, nozzles };
}

function emptyAscent(body) {
    return {
        body: body.name, body_id: body.id, status: 'invalid', time_s: 0,
        final_alt_km: 0, final_vt_kms: 0, v_orb_circ_kms: body.v_orb_low_kms,
        dv_used_kms: 0, dv_orbital_kms: 0, dv_grav_loss_kms: 0, dv_drag_loss_kms: 0,
        dv_steer_loss_kms: 0, max_q_kPa: 0, trajectory: [],
    };
}

/** Human-readable verdict for the scorecard. */
export function gradeAscent(result) {
    if (result.status === 'orbit') {
        const margin = result.final_vt_kms - result.v_orb_circ_kms;
        if (margin > 0.5) return { grade: 'S', label: 'Orbit with margin to spare', tone: 'good' };
        return { grade: 'A', label: 'Made orbit', tone: 'good' };
    }
    if (result.status === 'fuel-out') {
        const frac = result.final_vt_kms / (result.v_orb_circ_kms || 1);
        if (frac > 0.8) return { grade: 'B', label: 'So close — short on Δv', tone: 'warn' };
        if (frac > 0.4) return { grade: 'C', label: 'Suborbital — needs more propellant', tone: 'warn' };
        return { grade: 'D', label: 'Barely off the pad', tone: 'bad' };
    }
    if (result.status === 'crashed') return { grade: 'F', label: 'Lithobraking event', tone: 'bad' };
    if (result.status === 'invalid') return { grade: '—', label: 'Add propellant to fly', tone: 'bad' };
    return { grade: 'C', label: 'Flight ended early', tone: 'warn' };
}

export { LAUNCH_BODIES, G0 };
