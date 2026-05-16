/**
 * persona-content.js — copy + offer config for the optimized homepage
 *
 * One place to tune what each audience sees. `resolveContent(persona,
 * assignments)` returns a flat slot map the page applies to elements
 * tagged `data-pp="<slot>"`. A/B variants overlay the persona base:
 *
 *   home_hero: control → informative h1   | punch → loss/urgency h1
 *   home_cta : control → neutral CTA verb | urgency → stronger CTA verb
 *
 * Editing marketing copy or launching a headline test is a data change
 * here — no markup or JS logic edits required.
 */

export const DEFAULT_PERSONA = 'operator';

// Which "door" card is promoted to the primary highlight per persona.
const PERSONA_DOOR = {
    operator:   'operators',
    educator:   'researchers',
    enthusiast: 'researchers',
    scientist:  'government',
};

const BASE = {
    operator: {
        eyebrow: 'Physics-first space weather forecasting',
        h1: {
            control: 'LEO drag forecasts that hold up during the storm',
            punch:   'Stop losing spacecraft to drag your model never saw',
        },
        sub: 'When a geomagnetic storm hits, the empirical atmosphere models inside your conjunction and reentry tools under-predict drag — and spacecraft come down early. Parkers Physics forecasts thermospheric density from first-principles MHD, so your orbit determination stays accurate when it matters most.',
        ctaPrimary:      { control: 'Request access',  urgency: 'Get storm-resilient forecasts' },
        ctaPrimaryHref:  '#operators',
        ctaSecondary:    'Get the technical brief',
        ctaSecondaryHref:'#government',
        readout: [
            { k: 'Forecast target', v: 'LEO drag' },
            { k: 'Model basis',     v: 'MHD' },
            { k: 'Validation',      v: 'Storm-class' },
            { k: 'Live feeds',      v: '12 ●', live: true },
        ],
        finalH2: 'Is your atmosphere model losing you spacecraft?',
        finalP:  'Request access for a scoped briefing on storm-resilient drag forecasting for your constellation.',
        finalCta:{ control: 'Request access', urgency: 'Book a storm briefing' },
    },

    educator: {
        eyebrow: 'Live space science for the classroom',
        h1: {
            control: 'Bring real NASA & NOAA data into your classroom',
            punch:   'Teach space weather with the real thing, not a textbook diagram',
        },
        sub: '28+ scientifically accurate, WebGL simulations driven by live NASA and NOAA feeds — every model built on a published equation. Per-seat licensing, magic-link student enrollment, lesson-ready for grades 9–14 and undergraduate physics.',
        ctaPrimary:      { control: 'Explore simulations', urgency: 'Start a free classroom' },
        ctaPrimaryHref:  '#researchers',
        ctaSecondary:    'See educator pricing',
        ctaSecondaryHref:'/for-educators.html',
        readout: [
            { k: 'Simulations', v: '28+' },
            { k: 'Data',        v: 'Live NASA·NOAA' },
            { k: 'Grade band',  v: '9–14' },
            { k: 'Seats',       v: 'Per-class' },
        ],
        finalH2: 'Ready to run live space weather in your classroom?',
        finalP:  'Start free with three core simulations and the live space-weather dashboard. Upgrade to per-seat when your class is ready.',
        finalCta:{ control: 'Explore simulations', urgency: 'Start a free classroom' },
    },

    enthusiast: {
        eyebrow: 'Explore the universe in your browser',
        h1: {
            control: 'The universe, running live in your browser',
            punch:   'Watch the Sun erupt — on real data, right now',
        },
        sub: 'Scientifically accurate WebGL simulations of the Sun, Earth’s magnetosphere, and deep space — driven by live NASA and NOAA data, built on published equations. Free to start.',
        ctaPrimary:      { control: 'Open the simulations', urgency: 'Launch a simulation free' },
        ctaPrimaryHref:  '#researchers',
        ctaSecondary:    'See what’s inside',
        ctaSecondaryHref:'#capability',
        readout: [
            { k: 'Simulations', v: '28+' },
            { k: 'Live feeds',  v: '12 ●', live: true },
            { k: 'Cost',        v: 'Free to start' },
            { k: 'Render',      v: 'WebGL' },
        ],
        finalH2: 'Go see what the Sun is doing right now',
        finalP:  'Three core simulations and the live space-weather dashboard are free, forever. No card to start.',
        finalCta:{ control: 'Open the simulations', urgency: 'Launch a simulation free' },
    },

    scientist: {
        eyebrow: 'First-principles space weather modeling',
        h1: {
            control: 'Space weather models you can trace to an equation',
            punch:   'Reproducible MHD — not a black box you take on faith',
        },
        sub: 'Global magnetosphere modeling in the SWMF / BATS-R-US lineage. Every result traces to a published equation and is validated against the storms that push empirical models outside their calibration range — Starlink 2022, Gannon 2024.',
        ctaPrimary:      { control: 'Read the method', urgency: 'See the storm validation' },
        ctaPrimaryHref:  '#proof',
        ctaSecondary:    'Technical brief (PDF)',
        ctaSecondaryHref:'#government',
        readout: [
            { k: 'Basis',        v: 'MHD' },
            { k: 'Lineage',      v: 'SWMF·BATS-R-US' },
            { k: 'Validation',   v: 'Gannon 2024' },
            { k: 'Reproducible', v: 'Published eqns' },
        ],
        finalH2: 'Evaluate the method, not a marketing claim',
        finalP:  'Every model traces to a published equation and is defended against real storm events. Request the technical brief.',
        finalCta:{ control: 'Read the method', urgency: 'See the storm validation' },
    },
};

function pickCopy(field, variant) {
    if (field && typeof field === 'object' && !Array.isArray(field)) {
        return field[variant] ?? field.control ?? Object.values(field)[0];
    }
    return field;
}

/**
 * @param {string} persona
 * @param {{home_hero?:string, home_cta?:string}} assignments
 * @returns {object} flat slot map keyed to data-pp attributes
 */
export function resolveContent(persona, assignments = {}) {
    const p = BASE[persona] ? persona : DEFAULT_PERSONA;
    const c = BASE[p];
    const heroVar = assignments.home_hero || 'control';
    const ctaVar  = assignments.home_cta  || 'control';
    return {
        persona: p,
        activeDoor: PERSONA_DOOR[p] || PERSONA_DOOR[DEFAULT_PERSONA],
        slots: {
            'hero.eyebrow':       c.eyebrow,
            'hero.h1':            pickCopy(c.h1, heroVar),
            'hero.sub':           c.sub,
            'hero.ctaPrimary':    pickCopy(c.ctaPrimary, ctaVar),
            'hero.ctaSecondary':  c.ctaSecondary,
            'final.h2':           c.finalH2,
            'final.p':            c.finalP,
            'final.ctaPrimary':   pickCopy(c.finalCta, ctaVar),
        },
        hrefs: {
            'hero.ctaPrimary':   c.ctaPrimaryHref,
            'hero.ctaSecondary': c.ctaSecondaryHref,
            'final.ctaPrimary':  c.ctaPrimaryHref,
        },
        readout: c.readout,
    };
}

try {
    if (typeof window !== 'undefined') {
        window.ppPersonaContent = { resolveContent, DEFAULT_PERSONA, PERSONAS: Object.keys(BASE) };
    }
} catch {}
