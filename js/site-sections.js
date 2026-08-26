/**
 * site-sections.js — single source of truth for the site's TOP-LEVEL structure
 * ═══════════════════════════════════════════════════════════════════════════
 * Five content sections, each with a hub page. Consumed by:
 *
 *   - js/nav.js                    the top-level dropdowns (id, label, hub
 *                                  href and the section headers inside each
 *                                  menu all come from here; nav.js owns only
 *                                  the CURATED item list per menu)
 *   - js/simulations-catalog.js    SIM_CATEGORIES is DERIVED from this list,
 *                                  so the catalog page's sections and the
 *                                  nav's top level cannot drift apart
 *   - scripts/build-section-pages.mjs
 *                                  bakes one static hub page per section
 *   - tests/site-sections.mjs      structural gate
 *
 * WHY THIS EXISTS
 * ───────────────
 * The nav grew to nine top-level items (Home · Simulations · Earth · Space
 * Weather · Hindcast Lab · Field Notes · Stars · Black Holes · Simulators) and
 * two failures followed from that, both measured on 2026-08-25:
 *
 *  1. HORIZONTAL. The bar fit every desktop width by 10–16px. That is not a
 *     margin, it is a coincidence — `.nav-menu` is `flex-wrap: nowrap` with
 *     `flex-shrink: 0` on everything except `.nav-utility-links`, over a `nav`
 *     that is `overflow: visible` on a body that does not scroll sideways, so
 *     the first item that does not fit becomes UNREACHABLE rather than
 *     clipped. One more menu, or a slightly wider system font, spent it.
 *
 *  2. VERTICAL — and this one was already live. "Space Weather" had grown to
 *     18 links across 3 sections: a 1110px panel hanging off a 50px bar. On
 *     every common laptop the bottom of it was simply off the screen, with
 *     nothing to scroll:
 *
 *          1366×768   7 links unreachable  (Jupiter … Galaxy)
 *          1536×864   5 links unreachable
 *          1440×900   4 links unreachable
 *          1920×1080  2 links unreachable
 *
 *     Exactly the same failure as the `max-height: 600px` mobile accordion
 *     bug documented in js/nav-styles.css, on the other axis, and for the same
 *     reason: a menu was allowed to grow without anything measuring it.
 *
 * The root cause behind both was an information architecture that had stopped
 * describing the product. "Space Weather" held Jupiter, Saturn, Uranus,
 * Neptune, the mission roster and the Milky Way map; "Simulators" was a
 * leftovers bin on a site where every page is a simulator; "Stars" and "Black
 * Holes" each spent a top-level slot on four to six links.
 *
 * So the top level is now FIVE physical domains plus the full catalog, each
 * one a real destination:
 *
 *      Space Weather   the Sun to the magnetosphere — the forecasting product
 *      Earth & Orbit   the near-Earth environment and the craft flying in it
 *      Local Space     the solar system and our galactic neighbourhood
 *      Deep Space      individual stars and strong-field spacetime
 *      Research        validation, methods, and the writing
 *      Simulations     the complete index (js/simulations-catalog.js)
 *
 * INVARIANT — MENUS MUST FIT THE SCREEN
 * ─────────────────────────────────────
 * A nav menu is capped at ~10 links and ~3 section headers, which lands under
 * 700px and therefore fits the 768px-tall laptop that is the floor. That cap
 * is what the hub pages are FOR: the menu is the curated way in, the hub is
 * the complete one. `tests/nav-responsive.spec.js` measures the rendered panel
 * against the viewport at 768/864/900/1080 and fails on a single link that
 * falls below the fold, so this cannot rot again by accident.
 *
 * ADDING A SECTION
 * ────────────────
 *   1. Append an entry below.
 *   2. Add its curated item list to NAV_ITEMS in js/nav.js.
 *   3. Run `node scripts/build-section-pages.mjs` to bake its hub page.
 *   4. Register the hub page in NON_SIMULATION_PAGES.
 *   5. Run `node tests/site-sections.mjs tests/simulations-catalog.mjs`
 *      and `node scripts/lint-nav.mjs`.
 * Re-measure the bar afterwards: at 1281px the widest state (admin, system
 * font) had +16px of headroom with seven dropdowns, and a sixth top-level
 * item is what spends it.
 *
 * Field reference
 *   id        kebab-case key. Also the SIM_CATEGORIES id, so every simulation
 *             filed under this section carries `category: <id>`.
 *   label     the nav's top-level button text. Short — it is bar width.
 *   href      the section's hub page, root-relative.
 *   icon      glyph id from js/glyphs.js (GLYPH_IDS).
 *   tagline   hub hero eyebrow, above the headline.
 *   headline  hub hero <h1>. Says what the domain IS, not what we sell.
 *   intro     hub hero paragraph, one or two sentences.
 *   note      one line, used as the section's blurb on simulations.html.
 *   groups    sub-groups WITHIN the section. These are the section headers in
 *             the nav menu and the sub-headings on the hub page. Every
 *             simulation in this section must name one of these group ids.
 *   extras    OPTIONAL. Sub-groups whose entries are declared inline instead
 *             of coming from the catalog, for pages that belong on a hub but
 *             are not simulations — the Field Notes essays under Research are
 *             the case this exists for. Same shape as `groups`, plus a `links`
 *             array of { href, title, blurb, icon, badge? }. They render as
 *             ordinary cards after the catalog groups. Do NOT use this to
 *             smuggle a simulation onto a hub without cataloguing it: the
 *             catalog's drift gate cannot see these, so tests/site-sections.mjs
 *             requires every extra href to be in NON_SIMULATION_PAGES.
 */

export const SITE_SECTIONS = [
    {
        id: 'space-weather',
        label: 'Space Weather',
        // NOT 'space-weather.html' — that is the sign-in-gated live console
        // (SPACE_WEATHER_DASHBOARD_PLAN.md §3), which bounces signed-out
        // visitors to signin.html and so cannot be the public landing page
        // for a whole nav section. The hub carries the -hub suffix and links
        // the console as its first card.
        href: 'space-weather-hub.html',
        icon: 'space-weather',
        tagline: 'Sun to Earth',
        headline: 'Space weather, forecast from the physics',
        intro: 'The Sun erupts, the wind carries it, and 1–4 days later something happens to the magnetosphere. '
             + 'These pages run that chain end to end on live NOAA and NASA feeds — and score themselves against what actually arrived.',
        note: 'Sun-to-Earth forecasting: the solar wind, the storms it drives, and the systems they hit.',
        groups: [
            { id: 'live', label: 'Live conditions',
              note: 'What the Sun and the magnetosphere are doing right now.' },
            { id: 'forecast', label: 'Forecasting',
              note: 'Arrival times, Bz, and the uncertainty around both — with the skill scores attached.' },
            { id: 'geospace', label: 'Geospace response',
              note: 'What the storm does once it gets here: ring current, electric fields, the ground.' },
            { id: 'solar-physics', label: 'Solar physics',
              note: 'The solvers underneath — MHD in the convection zone and out along the Parker spiral.' },
        ],
    },
    {
        id: 'earth-orbit',
        label: 'Earth & Orbit',
        href: 'earth-orbit.html',
        icon: 'earth',
        tagline: 'The near-Earth environment',
        headline: 'Earth, its air, and everything flying through it',
        intro: 'Low Earth orbit is a fluid, not a vacuum. These pages cover the weather below, the density above, '
             + 'and the drag budget that decides whether a satellite keeps its altitude through a storm.',
        note: 'The near-Earth environment — weather, air, orbit, and the craft flying through it.',
        groups: [
            { id: 'earth-systems', label: 'Earth systems',
              note: 'The globe itself: predictive weather, air quality, and the thermosphere on top.' },
            { id: 'orbital-ops', label: 'Orbital operations',
              note: 'Where the fleet is, what the debris is doing, and when it is safe to launch.' },
            { id: 'build-fly', label: 'Build & fly',
              note: 'Design a spacecraft, then fly it against the same drag environment the operators see.' },
        ],
    },
    {
        id: 'local-space',
        label: 'Local Space',
        href: 'local-space.html',
        icon: 'solar-system',
        tagline: 'Our system, live',
        headline: 'The solar system, on real ephemerides',
        intro: 'Every world here is drawn from measured data — JPL ephemerides, MOLA and LRO terrain, IAU coordinates — '
             + 'and every orbit is integrated rather than animated. Zoom out far enough and the Milky Way map takes over.',
        note: 'Worlds, planetary systems and orbital mechanics — integrated, not animated.',
        groups: [
            { id: 'worlds', label: 'Worlds',
              note: 'Surfaces you can descend to, on real terrain rasters.' },
            { id: 'planetary', label: 'Planetary systems',
              note: 'Moons, rings and resonances under live N-body integration.' },
            { id: 'maps-missions', label: 'Maps & missions',
              note: 'Where the fleet is, where you could send one, and where all of it sits in the galaxy.' },
            { id: 'orbital-mechanics', label: 'Orbital mechanics',
              note: 'The integrators themselves — N-body, secular drift, and disc accretion.' },
        ],
    },
    {
        id: 'deep-space',
        label: 'Deep Space',
        href: 'deep-space.html',
        icon: 'black-hole',
        tagline: 'Beyond the heliosphere',
        headline: 'Stars and strong-field spacetime',
        intro: 'Each star here is rendered from its own measured parameters — radius, temperature, rotation, mass loss — '
             + 'not from an artist’s reference. The black holes are ray-marched against the metric.',
        note: 'Individual stars rendered from measured parameters, and strong-field spacetime.',
        groups: [
            { id: 'stars', label: 'Stars',
              note: 'Named stars at close range, each one built from its published parameters.' },
            { id: 'stellar-modelling', label: 'Stellar modelling',
              note: 'Structure and classification you can drive — the HR diagram with the lid off.' },
            { id: 'black-holes', label: 'Black holes',
              note: 'Ray-marched horizons, accretion flows, and ultramassive mergers.' },
        ],
    },
    {
        id: 'research',
        label: 'Research',
        href: 'research.html',
        icon: 'notebook',
        tagline: 'Show your working',
        headline: 'How we know the physics holds',
        intro: 'A forecast that is never scored is a guess with a chart. This is the evidence surface: real storms '
             + 'replayed hour by hour against what the models said at the time, the write-ups, and the engine underneath.',
        note: 'Validation, methods, and the writing — real storms replayed against what the models said.',
        groups: [
            { id: 'hindcast', label: 'Hindcast Lab',
              note: 'Real storms, replayed hour by hour against the models that missed them.' },
            { id: 'engine', label: 'Engine & methods',
              note: 'The compute layer: Rust compiled to WebAssembly, benchmarkable in the browser.' },
        ],
        // Field Notes are the WRITING, and writing is not a simulation, so it
        // has no place in js/simulations-catalog.js. Without this block the
        // Research hub listed four replay pages and not one word of the
        // analysis the section exists to publish — the nav menu carried the
        // papers and the hub, which is meant to be the complete view of the
        // section, silently did not.
        //
        // The 2026-07-25 "run vs read" split is preserved: the Hindcast Lab
        // group above is run, this is read.
        extras: [
            {
                id: 'field-notes',
                label: 'Field Notes',
                note: 'Post-mortems, hindcast papers and method notes — the analysis behind the replays.',
                countNoun: 'field note',
                links: [
                    { href: 'blog.html', title: 'All Field Notes', icon: 'notebook',
                      blurb: 'Every post in one place: post-mortems, hindcast papers, method notes.' },
                    { href: 'blog-why-aurora-forecasts-miss.html', title: 'NOAA said G1. Earth got G3.',
                      icon: 'chart-down', badge: 'NEW',
                      blurb: 'July 2026 — why the Bz gap keeps turning quiet forecasts into real storms.' },
                    { href: 'blog-gannon-hindcast.html', title: 'The Index That Lied', icon: 'paper',
                      blurb: 'The Gannon G5 write-up, and the density the Ap ceiling could not report.' },
                    { href: 'blog-stpatrick-hindcast.html', title: 'The Storm Every Model Takes',
                      icon: 'paper',
                      blurb: "March 2015 — the community benchmark, and the second step models miss." },
                ],
            },
        ],
    },
];

/** Section ids, in nav order. */
export const SECTION_IDS = SITE_SECTIONS.map(section => section.id);

/** The section with `id`, or undefined. */
export function sectionById(id) {
    return SITE_SECTIONS.find(section => section.id === id);
}

/**
 * Every `{ sectionId, group }` pair, flattened.
 *
 * Group ids are only unique WITHIN a section (two sections may both want a
 * 'live' group), so anything keying on a group globally has to carry the
 * section with it. That is what this returns.
 */
export function allGroups() {
    return SITE_SECTIONS.flatMap(section =>
        section.groups.map(group => ({ sectionId: section.id, group })));
}
