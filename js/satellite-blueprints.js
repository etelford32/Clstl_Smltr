/**
 * satellite-blueprints.js — state-of-the-art real-satellite catalogue
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Curated, ready-to-fly recreations of the spacecraft actually flying (or
 * about to fly) the modern LEO/GEO regime, expressed in the Satellite
 * Designer's own parts vocabulary — { body, thruster, thrusterCount, panel,
 * panelSpan, payload } — plus a starting orbit, propellant load, space-weather
 * preset, and a curated real-world reference card.
 *
 * The build is an *approximation*: the designer has a finite parts bay, so we
 * pick the closest bus / propulsion / array / payload and let the honest
 * numbers live in `real`. Loading a blueprint drops its parts into the bay,
 * sets the orbit sliders, and (if signed in) you can fork it from there.
 *
 * `multidirectional: true` flags birds that carry real reaction-control
 * thruster clusters — they can translate along *and* across the velocity
 * vector at once, the capability the flight model exposes via design.rcs. Such
 * a blueprint always sits on an RCS-capable bus (see BODIES[].rcs); the
 * selfTest enforces that invariant.
 *
 * Sources are listed per entry; the catalogue is a teaching aid, not a
 * spec sheet — figures are rounded representative values circa 2024–2026.
 *
 * Dependency-light: imports only the builder's data tables + deriveDesign and
 * the engine's ENGINE_PRESETS, so it stays unit-testable in plain Node.
 */

import { BODIES, THRUSTER_UNITS, PANELS, PAYLOADS, deriveDesign } from './satellite-builder.js';
import { ENGINE_PRESETS } from './satellite-designer-engine.js';

// Orbit slider envelope the designer exposes (km). Blueprints must start
// inside it; GEO/MEO birds note their real altitude in `real.altKm` and fly a
// representative high-LEO demonstration orbit instead.
export const ORBIT_MIN_KM = 100;
export const ORBIT_MAX_KM = 1200;

/**
 * The catalogue. Order is roughly "approachable → exotic" so the gallery reads
 * as a tour of the field.
 */
export const BLUEPRINTS = [
  // ── LEO mega-constellation comms ─────────────────────────────────────────
  {
    id: 'starlink_v2mini',
    name: 'Starlink V2 Mini',
    operator: 'SpaceX',
    era: '2023–',
    klass: 'LEO broadband',
    icon: '📡',
    build: { body: 'bus_med', thruster: 'hall_ion', thrusterCount: 1,
             panel: 'rosa', panelSpan: 6, payload: 'sar_radar' },
    fuelKg: 90,
    orbit: { periKm: 550, apoKm: 550 },
    sw: 'nominal',
    multidirectional: false,
    real: {
      massKg: 740, powerW: 8000, altKm: 550,
      propellant: 'Argon Hall-effect thruster',
      notes: 'Two 52.5 m² roll-out arrays (~30 m tip-to-tip), flat phased-array bus, argon Hall thrusters (≈2.4× thrust of the krypton predecessor). Reaction wheels + a single thrust axis — it points, it doesn’t strafe.',
    },
    blurb: 'The bird that made LEO broadband a commodity. A flat phased-array slab on a roll-out wing, sipping practically-free argon to dodge debris and de-orbit on command.',
    source: 'https://space.skyrocket.de/doc_sdat/starlink-v2-mini.htm',
  },
  {
    id: 'oneweb_gen1',
    name: 'OneWeb (Gen-1)',
    operator: 'Eutelsat OneWeb',
    era: '2019–',
    klass: 'LEO broadband',
    icon: '🛰',
    build: { body: 'smallsat', thruster: 'gridded_ion', thrusterCount: 1,
             panel: 'dual', panelSpan: 3.5, payload: 'commsat_dish' },
    fuelKg: 16,
    orbit: { periKm: 1200, apoKm: 1200 },
    sw: 'nominal',
    multidirectional: false,
    real: {
      massKg: 150, powerW: 1500, altKm: 1200,
      propellant: 'Xenon gridded-ion (electric)',
      notes: 'Compact ~150 kg Ku-band bus mass-produced on an aircraft-style line, raised to a high 1200 km polar shell by a single xenon ion thruster.',
    },
    blurb: 'Built like an airliner, by the hundred. A featherweight Ku-band bus that ion-crawls to a 1200 km polar shell and stays there.',
    source: 'https://www.eoportal.org/satellite-missions/oneweb',
  },
  {
    id: 'iridium_next',
    name: 'Iridium NEXT',
    operator: 'Iridium',
    era: '2017–',
    klass: 'LEO comms (L-band)',
    icon: '✨',
    build: { body: 'bus_med', thruster: 'monoprop', thrusterCount: 4,
             panel: 'dual', panelSpan: 3, payload: 'commsat_dish' },
    fuelKg: 130,
    orbit: { periKm: 780, apoKm: 780 },
    sw: 'nominal',
    multidirectional: true,
    real: {
      massKg: 860, powerW: 2200, altKm: 780,
      propellant: 'Hydrazine monopropellant + RCS clusters',
      notes: 'Cross-linked L-band constellation flying in a tightly-phased 780 km lattice — hydrazine RCS holds each plane’s geometry and dumps momentum.',
    },
    blurb: 'The original cross-linked mesh, reborn. Hydrazine reaction-control clusters keep 66 birds in a flawless cross-stitched lattice you can phone from a liferaft.',
    source: 'https://www.eoportal.org/satellite-missions/iridium-next',
  },

  // ── Earth observation ────────────────────────────────────────────────────
  {
    id: 'pleiades_neo',
    name: 'Pléiades Neo',
    operator: 'Airbus',
    era: '2021–',
    klass: 'EO · very-high-res optical',
    icon: '🔭',
    build: { body: 'bus_med', thruster: 'monoprop', thrusterCount: 4,
             panel: 'dual', panelSpan: 2.5, payload: 'optical_cam' },
    fuelKg: 60,
    orbit: { periKm: 620, apoKm: 620 },
    sw: 'solar_max',
    multidirectional: true,
    real: {
      massKg: 920, powerW: 2400, altKm: 620,
      propellant: 'Hydrazine + control-moment gyros (CMG)',
      notes: '30 cm-class imager that slews like a sports car — CMGs plus RCS let it whip between targets and squeeze many strips out of a single pass.',
    },
    blurb: 'A 30 cm-class eye that pirouettes. Control-moment gyros and reaction-control jets fling it target-to-target so fast it images a city block and the airport in one breath.',
    source: 'https://www.eoportal.org/satellite-missions/pleiades-neo',
  },
  {
    id: 'iceye_sar',
    name: 'ICEYE SAR',
    operator: 'ICEYE',
    era: '2018–',
    klass: 'EO · SAR microsat',
    icon: '🛰',
    build: { body: 'smallsat', thruster: 'cold_gas', thrusterCount: 1,
             panel: 'dual', panelSpan: 2, payload: 'sar_radar' },
    fuelKg: 5,
    orbit: { periKm: 570, apoKm: 570 },
    sw: 'nominal',
    multidirectional: false,
    real: {
      massKg: 100, powerW: 600, altKm: 570,
      propellant: 'Cold-gas / butane micro-thruster',
      notes: 'A ~100 kg X-band SAR microsat that sees through cloud and dark — proof that synthetic-aperture radar fits on a coffee-table bus.',
    },
    blurb: 'Radar vision in a suitcase. A hundred-kilo X-band SAR that stares through storms and midnight, nudged along its track by a whisper of cold gas.',
    source: 'https://www.eoportal.org/satellite-missions/iceye-constellation',
  },

  // ── GEO comms (flown at a high-LEO demo orbit here) ──────────────────────
  {
    id: 'geo_allelectric',
    name: 'All-Electric GEO Comsat',
    operator: 'Lanteris 1300 / Boeing 702SP class',
    era: '2015–',
    klass: 'GEO comms (all-electric)',
    icon: '🌍',
    build: { body: 'bus_med', thruster: 'hall_shielded', thrusterCount: 2,
             panel: 'quad', panelSpan: 6, payload: 'commsat_dish' },
    fuelKg: 220,
    orbit: { periKm: 1200, apoKm: 1200, note: 'Real orbit is GEO (35 786 km); flown here at the sim’s 1200 km ceiling.' },
    sw: 'nominal',
    multidirectional: true,
    real: {
      massKg: 2200, powerW: 18000, altKm: 35786,
      propellant: 'Xenon Hall (SPT-140 class) + chemical RCS',
      notes: 'All-electric orbit-raising (months of patient xenon thrust) halves launch mass; chemical RCS handles momentum and the precise N-S/E-W station-keeping box.',
    },
    blurb: 'The satellite that traded a fuel tank for time. It xenon-spirals to the GEO belt over months, then holds a station-keeping box tighter than a parking space — electric for the long haul, RCS for the fine print.',
    source: 'https://en.wikipedia.org/wiki/SSL_1300',
  },

  // ── Direct-to-cell ──────────────────────────────────────────────────────
  {
    id: 'ast_bluebird',
    name: 'AST SpaceMobile BlueBird',
    operator: 'AST SpaceMobile',
    era: '2024–',
    klass: 'LEO direct-to-cell',
    icon: '📶',
    build: { body: 'bus_med', thruster: 'hall_ion', thrusterCount: 1,
             panel: 'large', panelSpan: 6, payload: 'sar_radar' },
    fuelKg: 80,
    orbit: { periKm: 700, apoKm: 700 },
    sw: 'solar_max',
    multidirectional: false,
    real: {
      massKg: 1500, powerW: 7000, altKm: 700,
      propellant: 'Hall-effect electric',
      notes: 'Carries the largest commercial phased array ever flown (~64 m²) to talk straight to an unmodified phone — a giant, drag-prone sail in LEO.',
    },
    blurb: 'A 64 m² phased array unfurled to call your bare phone from orbit. The biggest commercial antenna ever flown — and the biggest drag headache, fighting the thermosphere with electric thrust.',
    source: 'https://www.ast-science.com/spacemobile-network/',
  },

  // ── CubeSat-class ────────────────────────────────────────────────────────
  {
    id: 'iodine_cubesat',
    name: 'Iodine-Ion CubeSat',
    operator: 'ThrustMe NPT30-I2 class',
    era: '2020–',
    klass: 'CubeSat · iodine electric',
    icon: '🧊',
    build: { body: 'cubesat_12u', thruster: 'iodine_ion', thrusterCount: 1,
             panel: 'dual', panelSpan: 1.5, payload: 'optical_cam' },
    fuelKg: 1.2,
    orbit: { periKm: 500, apoKm: 500 },
    sw: 'nominal',
    multidirectional: false,
    real: {
      massKg: 24, powerW: 120, altKm: 500,
      propellant: 'Solid iodine gridded ion',
      notes: 'First in-orbit demonstration of an iodine electric thruster — propellant you can store as a solid block and sublimate, on a 12U bus.',
    },
    blurb: 'A propellant you can hold in your hand. This 12U cubesat sublimates a solid iodine brick into an ion beam — the cheapest, densest electric propulsion ever flown.',
    source: 'https://www.nature.com/articles/s41586-021-04015-y',
  },

  // ── Servicing / orbital logistics ────────────────────────────────────────
  {
    id: 'mev_servicer',
    name: 'Mission Extension Vehicle',
    operator: 'Northrop Grumman SpaceLogistics',
    era: '2019–',
    klass: 'GEO life-extension servicer',
    icon: '🤝',
    build: { body: 'tug', thruster: 'biprop', thrusterCount: 2,
             panel: 'quad', panelSpan: 5, payload: 'none' },
    fuelKg: 500,
    orbit: { periKm: 1200, apoKm: 1200, note: 'Docks clients in GEO (35 786 km); flown here at the sim’s 1200 km ceiling.' },
    sw: 'nominal',
    multidirectional: true,
    real: {
      massKg: 2330, powerW: 3000, altKm: 35786,
      propellant: 'Bipropellant + electric, hydrazine RCS clusters',
      notes: 'The first commercial satellite ever to dock with and fly another. Electric propulsion to reach GEO, bipropellant + RCS for the millimetre-careful capture and 15 years of taking over a client’s station-keeping.',
    },
    blurb: 'The tow truck of the GEO belt — and the flagship of multidirectional thrust. RCS clusters let it creep up on a tumbling client, grapple, and fly the pair as one for fifteen years.',
    source: 'https://www.eoportal.org/satellite-missions/mev-1',
  },
  {
    id: 'impulse_mira',
    name: 'Mira Orbital Transfer Vehicle',
    operator: 'Impulse Space',
    era: '2023–',
    klass: 'Last-mile orbital tug',
    icon: '🚚',
    build: { body: 'tug', thruster: 'biprop', thrusterCount: 1,
             panel: 'dual', panelSpan: 2, payload: 'none' },
    fuelKg: 200,
    orbit: { periKm: 400, apoKm: 700 },
    sw: 'solar_max',
    multidirectional: true,
    real: {
      massKg: 300, powerW: 500, altKm: 500,
      propellant: 'High-thrust bipropellant + agile RCS',
      notes: 'A nimble last-mile tug that takes a rideshare drop-off and delivers each payload to its exact slot — high-thrust bipropellant for the big moves, RCS for the precise placement.',
    },
    blurb: 'Rideshare’s last mile. A punchy bipropellant tug that catches a bulk drop-off and hand-delivers each satellite to its precise address, strafing into position on RCS.',
    source: 'https://www.impulsespace.com/',
  },
];

/** Look up a blueprint by id. Returns undefined if not found. */
export function findBlueprint(id) {
  return BLUEPRINTS.find(b => b.id === id);
}

/**
 * Derive the same flight design the bay would, for a blueprint — handy for
 * UI cards ("dry mass / Δv / thrust at a glance") without standing up the bay.
 * @returns the deriveDesign() output, or null for an unknown id.
 */
export function blueprintDesign(bp) {
  const b = typeof bp === 'string' ? findBlueprint(bp) : bp;
  if (!b) return null;
  return deriveDesign(b.build, ENGINE_PRESETS);
}

// ── self-test ────────────────────────────────────────────────────────────────
export function selfTest() {
  const out = [];
  const T = (c, m) => out.push({ pass: !!c, msg: m });

  T(BLUEPRINTS.length >= 8, `catalogue has a decent spread (${BLUEPRINTS.length} blueprints)`);

  const ids = new Set();
  let multidir = 0;
  for (const b of BLUEPRINTS) {
    // Unique ids.
    T(!ids.has(b.id), `unique id: ${b.id}`);
    ids.add(b.id);

    // Every part key resolves against the live builder tables.
    T(!!BODIES[b.build.body],        `${b.id}: valid body (${b.build.body})`);
    T(!!THRUSTER_UNITS[b.build.thruster], `${b.id}: valid thruster (${b.build.thruster})`);
    T(!!PANELS[b.build.panel],       `${b.id}: valid panel (${b.build.panel})`);
    T(!!PAYLOADS[b.build.payload],   `${b.id}: valid payload (${b.build.payload})`);

    // Orbit sits inside the slider envelope.
    const { periKm, apoKm } = b.orbit;
    T(periKm >= ORBIT_MIN_KM && periKm <= ORBIT_MAX_KM
      && apoKm >= periKm && apoKm <= ORBIT_MAX_KM,
      `${b.id}: orbit in range (${periKm}–${apoKm} km)`);

    // Derived physics is sane.
    const d = blueprintDesign(b);
    T(d && d.dryMass > 0 && d.area > 0, `${b.id}: derives sane design (${d?.dryMass} kg, ${d?.area} m²)`);

    // Invariant: a blueprint flagged multidirectional must ride an RCS bus.
    if (b.multidirectional) {
      multidir++;
      T(!!BODIES[b.build.body].rcs && d.rcs === true,
        `${b.id}: multidirectional ⇒ RCS-capable bus`);
    }
  }
  T(multidir >= 3, `at least 3 multidirectional-thrust blueprints (${multidir})`);

  return out;
}
