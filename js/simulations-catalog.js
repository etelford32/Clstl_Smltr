/**
 * simulations-catalog.js — single source of truth for "every simulation we ship"
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE list. Consumed by:
 *
 *   - simulations.html            the public catalog grid (STATIC markup,
 *                                 generated from here by the builder below)
 *   - scripts/build-simulations-page.mjs
 *                                 regenerates that markup between the
 *                                 <!-- SIM-CATALOG:BEGIN/END --> sentinels
 *   - tests/simulations-catalog.mjs
 *                                 drift gate — see WHY THIS EXISTS
 *
 * WHY THIS EXISTS
 * ───────────────
 * The catalog page used to be hand-written cards. By 2026-08 it claimed
 * "46 simulations" while the repo shipped 55: Pollution Lab, Lunar Colony,
 * Ring Current, Shielding Lab, Flux Rope Simulator, Compounding Watch, CME
 * Forecast and St. Patrick's Storm had all launched into the nav and never
 * reached the catalog. Nothing errored. The page just quietly stopped being
 * a catalog.
 *
 * That failure is silent by construction — a page that is missing from a
 * hand-maintained list looks exactly like a page that was deliberately left
 * out. So the list moved here and `tests/simulations-catalog.mjs` now fails
 * CI when a new `*.html` simulation is not registered. Deliberate omissions
 * are still possible; they just have to be *stated* (NON_SIMULATION_PAGES).
 *
 * ADDING A SIMULATION
 * ───────────────────
 *   1. Append an entry below (keep it inside its category block).
 *   2. Run `node scripts/build-simulations-page.mjs` to regenerate the grid.
 *   3. Run `node tests/simulations-catalog.mjs`.
 * Adding it to js/nav.js is a separate, independent step — the nav is a
 * curated menu, this is the complete index. They are allowed to differ, and
 * six pages (the arcade game, the older black-hole labs, the WASM proving
 * ground) are catalog-only on purpose.
 *
 * Field reference
 *   id        stable kebab-case key — matches the page basename
 *   href      root-relative page filename ('earth.html'); must exist on disk
 *   title     display name on the card
 *   blurb     one line, sentence case, ends with a period. This is the
 *             "little description below the title" — it is the ONLY body
 *             copy on the card, so it has to say what the thing actually
 *             simulates. Physics-first: name the model, the data, or the
 *             event. No generic "AI-powered" framing (see CLAUDE.md §7).
 *   category  must be an id in SIM_CATEGORIES below, or the card renders
 *             into no section at all
 *   tier      'public' = open to everyone, 'free' = needs a free account.
 *             Mirrors the nav's tier vocabulary (js/nav.js _tierRequired).
 *   icon      glyph id from js/glyphs.js (GLYPH_IDS). Unknown ids render as
 *             raw text — tests/glyphs.mjs is what catches that.
 *   badge     optional 'NEW' | 'PRO PREVIEW' | 'IN DEV' pill
 */

// ── Categories ──────────────────────────────────────────────────────────────
// Ordered as they appear on the page. The grouping deliberately mirrors the
// nav's dropdowns (Earth / Space Weather / Hindcast Lab / Stars / Black Holes
// / Simulators) so a visitor who found something in the menu can find it
// again here, in the same neighbourhood.
export const SIM_CATEGORIES = [
    { id: 'earth',      label: 'Earth & Orbit',
      note: 'The near-Earth environment — weather, air, orbit, and the craft flying through it.' },
    { id: 'space-weather', label: 'Space Weather',
      note: 'Sun-to-Earth forecasting: the solar wind, the storms it drives, and the systems they hit.' },
    { id: 'hindcast',   label: 'Hindcast Lab',
      note: 'Real storms, replayed hour by hour against what the models said at the time.' },
    { id: 'planetary',  label: 'Planetary Systems',
      note: 'Live orbital mechanics for the planets and their moons.' },
    { id: 'missions',   label: 'Missions & Maps',
      note: 'Where the fleet is, and where you could send one.' },
    { id: 'stars',      label: 'Stars',
      note: 'Individual stars rendered from their measured parameters.' },
    { id: 'black-holes', label: 'Black Holes',
      note: 'Strong-field spacetime, accretion, and ultramassive mergers.' },
    { id: 'labs',       label: 'Simulators & Labs',
      note: 'Solvers you can drive — the physics engines with the lid off.' },
];

// ── The catalog ─────────────────────────────────────────────────────────────
export const SIMULATIONS = [
    // ── Earth & Orbit ───────────────────────────────────────────────────────
    { id: 'earth', href: 'earth.html', title: 'EarthView', category: 'earth',
      tier: 'public', icon: 'earth',
      blurb: 'Predictive weather and the live magnetosphere on one 3D globe.' },
    { id: 'pollution', href: 'pollution.html', title: 'Pollution Lab', category: 'earth',
      tier: 'public', icon: 'atmosphere', badge: 'NEW',
      blurb: 'Live PM2.5 across ~105 cities, hotspot clustering, and a scrubbable CAMS history.' },
    { id: 'moon', href: 'moon.html', title: 'The Moon', category: 'earth',
      tier: 'public', icon: 'moon',
      blurb: 'Lunar radiation environment, interior structure, and a collisionless exosphere.' },
    { id: 'colony', href: 'colony.html', title: 'Lunar Colony', category: 'earth',
      tier: 'public', icon: 'moon', badge: 'NEW',
      blurb: 'Build a base and survive the real Sun — storms arrive on live data.' },
    { id: 'operations', href: 'operations.html', title: 'Operations', category: 'earth',
      tier: 'public', icon: 'operations', badge: 'PRO PREVIEW',
      blurb: 'Fleet and debris console: NRLMSISE-00 decay watch and storm-time orbit margin.' },
    { id: 'satellites', href: 'satellites.html', title: 'Satellite Tracker', category: 'earth',
      tier: 'public', icon: 'satellite',
      blurb: 'Real-time SGP4 tracking of the operational fleet from live TLEs.' },
    { id: 'launch-planner', href: 'launch-planner.html', title: 'Launch Planner', category: 'earth',
      tier: 'public', icon: 'rocket',
      blurb: 'Upcoming launches next to the range weather that decides whether they fly.' },
    { id: 'upper-atmosphere', href: 'upper-atmosphere.html', title: 'Upper Atmosphere', category: 'earth',
      tier: 'public', icon: 'atmosphere',
      blurb: 'Thermosphere and exosphere density — the drag that sets orbit decay.' },
    { id: 'satellite-designer', href: 'satellite-designer.html', title: 'Satellite Designer', category: 'earth',
      tier: 'public', icon: 'satellite', badge: 'NEW',
      blurb: 'Build a spacecraft, then fly drag against thrust through a real storm.' },
    { id: 'spaceship-designer', href: 'spaceship-designer.html', title: 'Space Ship Designer', category: 'earth',
      tier: 'public', icon: 'rocket', badge: 'NEW',
      blurb: 'Assemble a rocket stage by stage and fly it to orbit in 3D.' },
    { id: 'satellite-game', href: 'satellite-game.html', title: 'Satellite Game', category: 'earth',
      tier: 'public', icon: 'satellite',
      blurb: 'Fly a satellite through a live drag environment — the engine in arcade mode.' },

    // ── Space Weather ───────────────────────────────────────────────────────
    { id: 'space-weather', href: 'space-weather.html', title: 'Space Weather', category: 'space-weather',
      tier: 'public', icon: 'space-weather',
      blurb: 'The control room — live solar and geomagnetic data on a composable dashboard.' },
    { id: 'auroracle', href: 'auroracle.html', title: 'AurOracle', category: 'space-weather',
      tier: 'public', icon: 'aurora', badge: 'NEW',
      blurb: 'Aurora visibility for your location — 7-night and 30-day outlooks.' },
    { id: 'ring-current', href: 'ring-current.html', title: 'Ring Current', category: 'space-weather',
      tier: 'public', icon: 'magnet', badge: 'NEW',
      blurb: 'Bounce-averaged ring-current transport driven by L1 — a live Dst digital twin.' },
    { id: 'shielding-lab', href: 'shielding-lab.html', title: 'Shielding Lab', category: 'space-weather',
      tier: 'public', icon: 'shield', badge: 'NEW',
      blurb: 'Magnetosphere–ionosphere coupling: SAPS and penetration electric fields.' },
    { id: 'flux-rope', href: 'flux-rope.html', title: 'Flux Rope Simulator', category: 'space-weather',
      tier: 'public', icon: 'flux-rope', badge: 'NEW',
      blurb: 'CME Bz forecasting — an ensemble flown Sun to Earth, with the knobs exposed.' },
    { id: 'flux-rope-live', href: 'flux-rope-live.html', title: 'Compounding Watch', category: 'space-weather',
      tier: 'public', icon: 'flux-rope', badge: 'NEW',
      blurb: 'Real-time CME trains: interaction physics and measured background noise.' },
    { id: 'cme-forecast', href: 'cme-forecast.html', title: 'CME Forecast', category: 'space-weather',
      tier: 'public', icon: 'flux-rope', badge: 'NEW',
      blurb: 'An arrival calendar of locked forecasts, scored against what actually hit.' },
    { id: 'far-side-watch', href: 'far-side-watch.html', title: 'Far-Side Watch', category: 'space-weather',
      tier: 'public', icon: 'far-side', badge: 'NEW',
      blurb: 'Active regions rotating into view — the days-to-weeks warning horizon.' },
    { id: 'sun', href: 'sun.html', title: 'The Sun', category: 'space-weather',
      tier: 'public', icon: 'sun',
      blurb: 'The solar surface in real time — flux, flares, and active regions.' },

    // ── Hindcast Lab ────────────────────────────────────────────────────────
    { id: 'gannon-superstorm', href: 'gannon-superstorm.html', title: 'Gannon Superstorm', category: 'hindcast',
      tier: 'public', icon: 'storm',
      blurb: 'The May 2024 G5, replayed for 72 h — MHD-corrected density against the Ap ceiling.' },
    { id: 'st-patrick-storm', href: 'st-patrick-storm.html', title: "St. Patrick's Storm", category: 'hindcast',
      tier: 'public', icon: 'storm-two-step', badge: 'NEW',
      blurb: 'March 2015 G4 — the two-step main phase every model takes, and misses.' },

    // ── Planetary Systems ───────────────────────────────────────────────────
    { id: 'mars', href: 'mars.html', title: 'Real-Time Mars', category: 'planetary',
      tier: 'public', icon: 'planet', badge: 'NEW',
      blurb: 'A MOLA terrain globe with Perseverance context and timestamped MEDA observations.' },
    { id: 'solar-system', href: 'solar-system.html', title: 'Solar System', category: 'planetary',
      tier: 'public', icon: 'solar-system',
      blurb: '31 moons and a live Galilean N-body integration.' },
    { id: 'jupiter-system', href: 'jupiter-system.html', title: 'Jupiter System', category: 'planetary',
      tier: 'public', icon: 'planet',
      blurb: 'The Galilean moons locked in the 4:2:1 Laplace resonance.' },
    { id: 'saturn-system', href: 'saturn-system.html', title: 'Saturn System', category: 'planetary',
      tier: 'public', icon: 'planet', badge: 'NEW',
      blurb: 'Moon-sculpted rings, the Cassini Division, and live density waves.' },
    { id: 'uranus-system', href: 'uranus-system.html', title: 'Uranus System', category: 'planetary',
      tier: 'public', icon: 'planet-ice', badge: 'NEW',
      blurb: 'Tipped 98° — ε-ring shepherds and a crowded inner moon system.' },
    { id: 'neptune-system', href: 'neptune-system.html', title: 'Neptune System', category: 'planetary',
      tier: 'public', icon: 'planet-ice', badge: 'NEW',
      blurb: 'Retrograde Triton, rings and arcs, under J₂ N-body dynamics.' },

    // ── Missions & Maps ─────────────────────────────────────────────────────
    { id: 'missions', href: 'missions.html', title: 'Space Missions', category: 'missions',
      tier: 'public', icon: 'probe',
      blurb: 'The inner-solar-system fleet roster, positioned live.' },
    { id: 'mission-planner', href: 'mission-planner.html', title: 'Mission Planner', category: 'missions',
      tier: 'public', icon: 'target', badge: 'NEW',
      blurb: 'Launch rockets and plan Moon and Mars transfers on real trajectories.' },
    { id: 'galactic-map', href: 'galactic-map.html', title: 'Galaxy', category: 'missions',
      tier: 'free', icon: 'galaxy',
      blurb: 'A 3D Milky Way star map — find your place in the galaxy.' },

    // ── Stars ───────────────────────────────────────────────────────────────
    { id: 'sirius', href: 'sirius.html', title: 'Sirius Binary', category: 'stars',
      tier: 'public', icon: 'star-binary',
      blurb: 'An A1V primary and its white dwarf companion, in orbit.' },
    { id: 'betelgeuse', href: 'betelgeuse.html', title: 'Betelgeuse', category: 'stars',
      tier: 'public', icon: 'star-red',
      blurb: 'Red supergiant convection at close range — M1-2 Ia.' },
    { id: 'vega', href: 'vega.html', title: 'Vega', category: 'stars',
      tier: 'public', icon: 'star-bright',
      blurb: 'A rapid rotator flattened by its own spin — A0V.' },
    { id: 'achernar', href: 'achernar.html', title: 'Achernar', category: 'stars',
      tier: 'public', icon: 'star-oblate',
      blurb: 'The oblate Be star — B6Vep, spinning near breakup.' },
    { id: 'wr102', href: 'wr102.html', title: 'WR-102', category: 'stars',
      tier: 'free', icon: 'star-wr',
      blurb: 'Wolf-Rayet winds from the hottest star known.' },
    { id: 'sirius-planetary', href: 'sirius-planetary.html', title: 'Sirius Planetary', category: 'stars',
      tier: 'free', icon: 'planet',
      blurb: 'A 3D stellar-system builder with Kepler integration.' },

    // ── Black Holes ─────────────────────────────────────────────────────────
    { id: 'ton618', href: 'ton618.html', title: 'TON 618', category: 'black-holes',
      tier: 'public', icon: 'black-hole',
      blurb: 'Research observatory for a 6.6×10¹⁰ M☉ ultramassive black hole.' },
    { id: 'blackhole-observatory', href: 'blackhole-observatory.html', title: 'Black Hole Observatory', category: 'black-holes',
      tier: 'public', icon: 'observatory', badge: 'NEW',
      blurb: 'Three ultramassive systems on one canvas, synced on proper time.' },
    { id: 'sagittarius', href: 'sagittarius.html', title: 'Sagittarius A*', category: 'black-holes',
      tier: 'public', icon: 'black-hole-core',
      blurb: 'The Galactic Center — ray-marched Kerr spacetime, live.' },
    { id: 'black-hole-fluid', href: 'black-hole-fluid.html', title: 'Black Hole Accretion', category: 'black-holes',
      tier: 'public', icon: 'accretion',
      blurb: 'Fluid dynamics of an accretion flow onto a horizon.' },
    { id: 'abell85', href: 'abell85.html', title: 'Abell 85 Pair Timeline', category: 'black-holes',
      tier: 'public', icon: 'black-hole',
      blurb: "An ultramassive binary's inspiral, laid out on a timeline." },
    { id: 'holm15a', href: 'holm15a.html', title: 'Holm 15A', category: 'black-holes',
      tier: 'public', icon: 'black-hole',
      blurb: 'Merger simulation of the largest galactic core ever measured.' },
    { id: 'merger-twins', href: 'merger-twins.html', title: 'Merger Twins', category: 'black-holes',
      tier: 'public', icon: 'observatory',
      blurb: 'Two black-hole merger simulations side by side, one story.' },

    // ── Simulators & Labs ───────────────────────────────────────────────────
    { id: 'tiga', href: 'tiga.html', title: 'TIGA · Geomagnetic', category: 'labs',
      tier: 'public', icon: 'dynamo', badge: 'NEW',
      blurb: 'Core field to IGRF-14 to a live estimate that publishes its own uncertainty.' },
    { id: 'solar-fluid', href: 'solar-fluid.html', title: 'Solar Fluid', category: 'labs',
      tier: 'public', icon: 'fluid',
      blurb: 'A Navier-Stokes MHD solver you can poke while it runs.' },
    { id: 'stellar-wind', href: 'stellar-wind.html', title: 'Stellar Wind', category: 'labs',
      tier: 'public', icon: 'wind',
      blurb: 'The Parker spiral and the stream structure it winds up.' },
    { id: 'star2d', href: 'star2d.html', title: '2D Stellar Modeler', category: 'labs',
      tier: 'public', icon: 'chart',
      blurb: 'HR diagram and stellar classification, interactive.' },
    { id: 'star2d-advanced', href: 'star2d-advanced.html', title: 'Advanced 2D Solar', category: 'labs',
      tier: 'free', icon: 'microscope',
      blurb: 'CMEs, Parker spirals, and fluid dynamics in 2D.' },
    { id: 'gravity-lab', href: 'gravity-lab.html', title: 'Gravity Lab', category: 'labs',
      tier: 'public', icon: 'gravity', badge: 'NEW',
      blurb: 'Live N-body — moons, resonances, and the chaos in between.' },
    { id: 'accretion-disc', href: 'accretion-disc.html', title: 'Accretion Disc', category: 'labs',
      tier: 'public', icon: 'accretion', badge: 'NEW',
      blurb: 'α-disc evolution, pebble accretion, and the Theia impact that made the Moon.' },
    { id: 'time-machine', href: 'time-machine.html', title: 'Orbital Time Machine', category: 'labs',
      tier: 'public', icon: 'hourglass', badge: 'IN DEV',
      blurb: 'N-body propagation of the solar system from ±10 kyr out to ±1 Myr.' },
    { id: 'grs-lab', href: 'grs-lab.html', title: 'Great Red Spot Lab', category: 'labs',
      tier: 'public', icon: 'planet',
      blurb: "Jupiter's storm treated as a shallow-water system." },
    { id: 'hydro-demo', href: 'hydro-demo.html', title: 'FARGO Hydro', category: 'labs',
      tier: 'public', icon: 'fluid',
      blurb: 'The WASM hydrodynamics proving ground.' },
    { id: 'rust', href: 'rust.html', title: 'Rust/WASM Engine', category: 'labs',
      tier: 'free', icon: 'engine',
      blurb: 'The WebAssembly compute module, exposed and benchmarkable.' },
];

/**
 * Pages that are `*.html` at the repo root but are NOT simulations.
 *
 * This list is the OTHER half of the drift gate: the test walks the repo,
 * subtracts SIMULATIONS and this set, and fails on whatever is left. So a
 * new page must be classified as one or the other — it can never be
 * silently neither, which is how eight simulations went missing from the
 * catalog in the first place.
 *
 * Keep it sorted; it makes the diff readable when a marketing page lands.
 */
export const NON_SIMULATION_PAGES = new Set([
    '404.html',
    'account.html',
    'admin.html',
    'api-policy.html',
    'auth-callback.html',
    'blog-gannon-hindcast.html',
    'blog-stpatrick-hindcast.html',
    'blog-why-aurora-forecasts-miss.html',
    'blog.html',
    'contact-enterprise.html',
    'dashboard.html',
    'design-tokens.html',
    'eula.html',
    'feedback.html',
    'for-educators.html',
    'for-operators.html',
    'home-v2.html',
    'index.html',
    'pricing.html',
    'privacy.html',
    'request-access.html',
    'reset-password.html',
    'settings.html',
    'signin.html',
    'signup.html',
    'simulations.html',
    'status.html',
    'superadmin.html',
    'welcome.html',
]);

/** Total shipped simulations. The catalog page headline reads from this. */
export const SIM_COUNT = SIMULATIONS.length;

/** Simulations in `categoryId`, in declaration order. */
export function simulationsByCategory(categoryId) {
    return SIMULATIONS.filter(sim => sim.category === categoryId);
}

/** Categories paired with their entries, skipping any that came out empty. */
export function catalogSections() {
    return SIM_CATEGORIES
        .map(category => ({ category, sims: simulationsByCategory(category.id) }))
        .filter(section => section.sims.length > 0);
}
