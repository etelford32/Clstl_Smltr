/**
 * launch-rulesets.js — Per-vehicle launch-commit overrides.
 *
 * V3 scope: WIND ONLY. Each vehicle entry overrides the ground-wind and
 * gust bands in DEFAULT_RULESET (js/launch-planner.js). Future dimensions
 * (upper-level shear, recovery sea-state, precip, thermal, lightning)
 * extend the same model — the dispatcher below doesn't need to change.
 *
 * Threshold semantics (mph at pad-height anemometer, 10 m above ground):
 *   sustained.green  — < X mph is clearly safe
 *   sustained.yellow — X–Y mph: within the vehicle's published limit but
 *                      marginal; ops teams would be tracking closely
 *   sustained > Y    — over the published ceiling, automatic no-go
 *   (gusts band reads the same way)
 *
 * Sources are cited per vehicle. Confidence flag is honest:
 *   high              — number comes from a primary public document
 *                       (payload user's guide / 45 WS Flight Commit Criteria)
 *   medium            — derived from press / FAA environmental assessments /
 *                       historical scrub behavior
 *   public-estimate   — no primary source; conservative analog from a
 *                       similar-class vehicle. UI surfaces this.
 */

import { DEFAULT_RULESET } from './launch-planner.js';

// ── Vehicle catalog ─────────────────────────────────────────────────────────
// NOTE ON MATCH ORDER: first match wins in rulesetForLaunch(), so the more
// specific vehicles (Falcon Heavy, Long March 5B) MUST be listed before
// their family siblings (Falcon 9, Long March 5).

export const VEHICLES = Object.freeze([
    {
        id:            'falcon-heavy',
        label:         'Falcon Heavy',
        operator:      'SpaceX',
        vehicle_class: 'heavy-lift',
        status:        'active',
        confidence:    'high',
        family_keys:   ['falcon heavy'],
        max_q: { alt_km: 12, t_plus_s: 70, pressure_hpa: 200 },
        wind_ruleset: {
            id:     'falcon-heavy',
            // Falcon Heavy shares LCC with Falcon 9 per SpaceX payload user's
            // guide; taller stack slightly tightens margin in practice.
            wind: { green: 20, yellow: 35 },   // 30 kt sustained published limit
            gust: { green: 25, yellow: 46 },   // ~40 kt gust published limit
            // Upper winds: balloon-release criteria have cited ~170 fps
            // (≈116 mph) as an FCC concern; heavier FH has slightly more
            // margin than F9 in absolute wind but similar shear tolerance.
            upper_wind:  { green: 100, yellow: 145 },
            upper_shear: { green: 60,  yellow: 95  },
        },
        sources: [
            'SpaceX Falcon Payload User\'s Guide (Rev. 3)',
            '45 WS Flight Commit Criteria (public)',
        ],
        notes: 'Triple-core vehicle; ASDS/RTLS recovery constraints handled separately in v5.',
    },
    {
        id:            'falcon-9',
        label:         'Falcon 9',
        operator:      'SpaceX',
        vehicle_class: 'medium-lift',
        status:        'active',
        confidence:    'high',
        family_keys:   ['falcon 9', 'falcon-9'],
        max_q: { alt_km: 12, t_plus_s: 78, pressure_hpa: 200 },
        wind_ruleset: {
            id:     'falcon-9',
            wind: { green: 20, yellow: 35 },
            gust: { green: 25, yellow: 46 },
            // F9 has scrubbed for upper-level winds repeatedly (CRS-19 and
            // several Starlink flights); 170 fps (~116 mph) is the balloon-
            // release concern, hard scrub near 140 mph.
            upper_wind:  { green: 100, yellow: 140 },
            upper_shear: { green: 60,  yellow: 90  },
        },
        variants: {
            // Crew Dragon missions ratchet the wind limit down because
            // the launch-abort system trades wind push against abort-corridor
            // safety. 15 m/s ≈ 34 mph is the commonly cited abort-wind limit.
            // Upper-winds likewise tightened because a high-q abort with
            // crew onboard has narrower trajectory margin.
            crewed: {
                id:   'falcon-9-crew',
                wind: { green: 15, yellow: 25 },
                gust: { green: 20, yellow: 34 },
                upper_wind:  { green: 80, yellow: 115 },
                upper_shear: { green: 45, yellow: 70  },
            },
        },
        sources: [
            'SpaceX Falcon Payload User\'s Guide (Rev. 3)',
            'NASA Commercial Crew Program abort-corridor analysis (public)',
        ],
    },
    {
        id:            'starship',
        label:         'Starship / Super Heavy',
        operator:      'SpaceX',
        vehicle_class: 'super-heavy-lift',
        status:        'ramping',
        confidence:    'medium',
        family_keys:   ['starship', 'super heavy'],
        // Starship max-Q is lower than F9 despite the vehicle being bigger:
        // the huge wet mass caps acceleration, so dynamic pressure peaks
        // in the denser lower stratosphere.
        max_q: { alt_km: 8, t_plus_s: 55, pressure_hpa: 300 },
        wind_ruleset: {
            id:     'starship',
            // Public statements cite ~28 mph for stacking / catch ops; flight
            // LCC is still evolving. Tall aspect ratio (120 m) makes it the
            // most wind-sensitive of the heavy vehicles on the pad.
            wind: { green: 15, yellow: 28 },
            gust: { green: 20, yellow: 40 },
            // No published upper-wind criteria. Use conservative generic
            // heavy-lift defaults pending formal SpaceX LCC.
            upper_wind:  { green: 90, yellow: 130 },
            upper_shear: { green: 55, yellow: 85  },
        },
        sources: [
            'FAA Final EIS for Starship Orbital Test Flight (2022)',
            'Public statements, SpaceX operational scrub history',
        ],
        notes: 'Thresholds will tighten/relax as SpaceX publishes formal LCC.',
    },
    {
        id:            'vulcan',
        label:         'Vulcan Centaur',
        operator:      'ULA',
        vehicle_class: 'heavy-lift',
        status:        'active',
        confidence:    'high',
        family_keys:   ['vulcan'],
        max_q: { alt_km: 12, t_plus_s: 80, pressure_hpa: 200 },
        wind_ruleset: {
            id:     'vulcan',
            wind: { green: 22, yellow: 40 },
            gust: { green: 28, yellow: 52 },
            // ULA inherits CCAFS balloon-release practice from Atlas V;
            // heavy-lift BE-4 core has similar lateral-load margin.
            upper_wind:  { green: 105, yellow: 150 },
            upper_shear: { green: 65,  yellow: 100 },
        },
        sources: [
            'ULA Vulcan Centaur Launch Vehicle User\'s Guide',
            '45 WS Flight Commit Criteria (public)',
        ],
    },
    {
        id:            'atlas-v',
        label:         'Atlas V',
        operator:      'ULA',
        vehicle_class: 'medium-lift',
        status:        'retiring',
        confidence:    'high',
        family_keys:   ['atlas v', 'atlas-v'],
        max_q: { alt_km: 12, t_plus_s: 85, pressure_hpa: 200 },
        wind_ruleset: {
            id:     'atlas-v',
            // Atlas V LCC varies with config (401 → 551); these are typical.
            wind: { green: 22, yellow: 40 },
            gust: { green: 28, yellow: 52 },
            // Atlas V's long operational record at CCAFS established the
            // balloon-release procedures ULA still uses for Vulcan.
            upper_wind:  { green: 100, yellow: 140 },
            upper_shear: { green: 60,  yellow: 90  },
        },
        sources: [
            'ULA Atlas V Launch Services User\'s Guide (Rev. 11)',
            '45 WS Flight Commit Criteria (public)',
        ],
    },
    {
        id:            'new-glenn',
        label:         'New Glenn',
        operator:      'Blue Origin',
        vehicle_class: 'heavy-lift',
        status:        'ramping',
        confidence:    'medium',
        family_keys:   ['new glenn'],
        max_q: { alt_km: 12, t_plus_s: 85, pressure_hpa: 200 },
        wind_ruleset: {
            id:     'new-glenn',
            // BO has not published granular LCC; numbers below are a
            // conservative analog to Falcon 9 (comparable lift class, similar
            // pad infrastructure at LC-36).
            wind: { green: 20, yellow: 35 },
            gust: { green: 25, yellow: 46 },
            // Tall 98 m stack; conservative shear margin vs. F9 pending BO
            // operational data.
            upper_wind:  { green: 95, yellow: 140 },
            upper_shear: { green: 55, yellow: 85  },
        },
        sources: [
            'Blue Origin New Glenn Payload User\'s Guide (v1, public)',
            'Analog to Falcon 9 LCC (45 WS FCC)',
        ],
        notes: 'Numbers will be firmed up when BO publishes vehicle-specific FCC.',
    },
    {
        id:            'electron',
        label:         'Electron',
        operator:      'Rocket Lab',
        vehicle_class: 'small-lift',
        status:        'active',
        confidence:    'high',
        family_keys:   ['electron'],
        // Small vehicle + low TWR → max-Q occurs higher than heavy-lift; at
        // ~14 km we're reading the jet-stream-adjacent 150 hPa band. v1
        // uses 200 hPa data uniformly; TODO interpolate when alt > 13 km.
        max_q: { alt_km: 14, t_plus_s: 70, pressure_hpa: 150 },
        wind_ruleset: {
            id:     'electron',
            // Electron is famously wind-sensitive — Mahia Peninsula scrubs
            // frequently near 25 kt sustained. Rocket Lab cites 30 kt as the
            // structural limit.
            wind: { green: 15, yellow: 30 },
            gust: { green: 20, yellow: 40 },
            // Small low-mass airframe is very shear-sensitive; Rocket Lab
            // has scrubbed on jet-stream incursions from Mahia multiple
            // times over the vehicle's operational life.
            upper_wind:  { green: 80, yellow: 120 },
            upper_shear: { green: 40, yellow: 65  },
        },
        sources: [
            'Rocket Lab Electron Payload User\'s Guide',
            'Rocket Lab operational scrub history (2018–2025)',
        ],
    },
    {
        id:            'neutron',
        label:         'Neutron',
        operator:      'Rocket Lab',
        vehicle_class: 'medium-lift',
        status:        'debut',
        confidence:    'public-estimate',
        family_keys:   ['neutron'],
        max_q: { alt_km: 11, t_plus_s: 75, pressure_hpa: 200 },
        wind_ruleset: {
            id:     'neutron',
            // No published LCC. Conservative medium-lift analog; composite
            // structure likely eases some thermal margins but wind limits
            // track the class.
            wind: { green: 18, yellow: 35 },
            gust: { green: 25, yellow: 45 },
            upper_wind:  { green: 85, yellow: 125 },
            upper_shear: { green: 50, yellow: 80  },
        },
        sources: [
            'Public statements, Rocket Lab investor materials',
            'Analog to medium-lift class (F9, Vulcan)',
        ],
        notes: 'Will update when Rocket Lab publishes Neutron user\'s guide.',
    },
    {
        id:            'ariane-6',
        label:         'Ariane 6',
        operator:      'Arianespace',
        vehicle_class: 'heavy-lift',
        status:        'active',
        confidence:    'high',
        family_keys:   ['ariane 6', 'ariane-6', 'ariane 62', 'ariane 64'],
        max_q: { alt_km: 11, t_plus_s: 75, pressure_hpa: 200 },
        wind_ruleset: {
            id:     'ariane-6',
            // Kourou launch pads (ELA-4) are equatorial and historically low-
            // wind. Ariane 5 typical ground-wind limit ~60 km/h (~37 mph);
            // A6 inherits similar margins.
            wind: { green: 22, yellow: 40 },
            gust: { green: 28, yellow: 52 },
            // Heavy vehicle with P120 solid strap-ons — solids are less
            // sensitive to upper-level shear than liquid stages, so A6 gets
            // slightly more generous thresholds than equivalent all-liquid
            // heavy-lift.
            upper_wind:  { green: 105, yellow: 150 },
            upper_shear: { green: 65,  yellow: 100 },
        },
        sources: [
            'Arianespace Ariane 6 User\'s Manual (Issue 2)',
            'ESA Launch Vehicle Range Safety Rules (CSG Kourou)',
        ],
    },
    {
        id:            'long-march-5',
        label:         'Long March 5',
        operator:      'CASC',
        vehicle_class: 'heavy-lift',
        status:        'active',
        confidence:    'public-estimate',
        // LL2 family string is "Long March 5" or "Long March". Matches CZ-5,
        // CZ-5B (manned/station), and CZ-5 DY variants.
        family_keys:   ['long march 5', 'cz-5'],
        max_q: { alt_km: 11, t_plus_s: 75, pressure_hpa: 200 },
        wind_ruleset: {
            id:     'long-march-5',
            // CZ-5 launches from Wenchang (Hainan, tropical). Chinese press
            // has cited 10 m/s operational wind limit (~22 mph) for nominal
            // ops; structural Level-10 wind (~55 mph) is hard ceiling.
            wind: { green: 18, yellow: 35 },
            gust: { green: 25, yellow: 50 },
            // No public upper-wind criteria. Conservative heavy-lift analog.
            upper_wind:  { green: 95, yellow: 140 },
            upper_shear: { green: 60, yellow: 95  },
        },
        sources: [
            'CASC CZ-5 User\'s Manual (public excerpt)',
            'Chinese state-media scrub reports (2017–2024)',
        ],
        notes: 'CZ-5B crewed variants share this ruleset for v3; crew overrides TBD.',
    },
    {
        id:            'soyuz-2',
        label:         'Soyuz-2',
        operator:      'Roscosmos',
        vehicle_class: 'medium-lift',
        status:        'active',
        confidence:    'medium',
        family_keys:   ['soyuz', 'soyuz-2', 'soyuz 2'],
        max_q: { alt_km: 11, t_plus_s: 66, pressure_hpa: 200 },
        wind_ruleset: {
            id:     'soyuz-2',
            // Soyuz is robust in wind — Plesetsk and Baikonur launch routinely
            // in conditions that would scrub F9. 20 m/s (~45 mph) commonly
            // cited operational limit; 25 m/s structural.
            wind: { green: 22, yellow: 45 },
            gust: { green: 30, yellow: 55 },
            // Proven tough upper-stage guidance; operational record includes
            // plenty of jet-stream flights. Most tolerant in the catalog.
            upper_wind:  { green: 115, yellow: 165 },
            upper_shear: { green: 70,  yellow: 105 },
        },
        sources: [
            'Arianespace Soyuz User\'s Manual (Issue 2, Kourou ops)',
            'Roscosmos operational guidelines (public)',
        ],
        notes: 'Cold-weather vehicle — thermal rules (v6) will relax low-temp bands for this family.',
    },
]);

// ── Fallback when vehicle can\'t be identified ──────────────────────────────

export const GENERIC_VEHICLE = Object.freeze({
    id:            'generic',
    label:         'Unrecognized vehicle',
    operator:      '—',
    vehicle_class: '—',
    status:        'unknown',
    confidence:    'generic',
    family_keys:   [],
    wind_ruleset:  {},         // empty override → uses DEFAULT_RULESET wind
    sources:       ['Generic default ruleset (no vehicle-specific override)'],
    notes:         'Vehicle family not in catalog; verdict uses conservative default thresholds.',
});

// ── Dispatcher ──────────────────────────────────────────────────────────────

function _haystack(launch) {
    return [
        launch?.vehicle,
        launch?.vehicle_family,
        launch?.rocket,
    ].filter(Boolean).join(' ').toLowerCase();
}

/**
 * Pick the vehicle model that best matches a launch record. Uses the
 * projected Launch-Library-2 fields (vehicle, vehicle_family) set by
 * api/launches/upcoming.js.
 */
export function vehicleForLaunch(launch) {
    if (!launch) return GENERIC_VEHICLE;
    const hay = _haystack(launch);
    if (!hay) return GENERIC_VEHICLE;
    for (const v of VEHICLES) {
        for (const k of v.family_keys) {
            if (hay.includes(k)) return v;
        }
    }
    return GENERIC_VEHICLE;
}

/**
 * Build the ruleset object to feed into scoreLaunch() for this launch.
 * Composes base vehicle ruleset + crewed variant if applicable.
 * Returns the merged ruleset only — for UI-side metadata (label, confidence,
 * sources) read vehicleForLaunch(launch) directly.
 */
export function rulesetForLaunch(launch) {
    const v = vehicleForLaunch(launch);
    let r = { ...DEFAULT_RULESET, ...(v.wind_ruleset || {}) };

    const mt = (launch?.mission_type || '').toLowerCase();
    const isCrewed = mt.includes('crewed') || mt.includes('human') || mt.includes('astronaut');
    if (isCrewed && v.variants?.crewed) {
        r = { ...r, ...v.variants.crewed };
    }

    // Preserve the DEFAULT_RULESET `id` if the override didn't specify one so
    // scoreWeather's ruleset_id field is always meaningful.
    if (!r.id) r.id = DEFAULT_RULESET.id;
    return r;
}

/**
 * Convenience for the UI: a one-object bundle of everything renderDetail
 * needs to surface the active ruleset (vehicle + ruleset + citations +
 * confidence).
 */
export function resolveRuleset(launch) {
    const v = vehicleForLaunch(launch);
    const ruleset = rulesetForLaunch(launch);
    return {
        vehicle:    v,
        ruleset,
        ruleset_id: ruleset.id,
        label:      v.label,
        confidence: v.confidence,
        sources:    v.sources || [],
        notes:      v.notes || '',
    };
}
