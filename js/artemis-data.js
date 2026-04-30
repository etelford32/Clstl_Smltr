/**
 * artemis-data.js — Artemis program timeline, science returns, and landing
 * site catalog.
 *
 * Focus: data that's observable / actionable from a radiation-environment
 * simulation standpoint. Artemis I flew the first deep-space dosimetry
 * measurements since Apollo; Artemis III candidate sites sit adjacent to
 * permanently-shadowed regions (PSRs) that host the water ice LCROSS
 * confirmed in 2009. All of that maps onto moon.html's existing framing.
 *
 * Confidence flags:
 *   'observed'       — flight data from Artemis I or Apollo (primary)
 *   'published'      — NASA announcement (e.g. the 13 candidate regions)
 *   'planned'        — mission plan, subject to change
 *   'preliminary'    — early results still being refined by the PI team
 */

// ── Mission timeline ────────────────────────────────────────────────────────

export const MISSIONS = Object.freeze([
    {
        id:           'artemis-1',
        name:         'Artemis I',
        status:       'completed',
        launched:     '2022-11-16',
        returned:     '2022-12-11',
        duration_d:   25.5,
        crewed:       false,
        profile:      'Uncrewed Orion + SLS Block 1, distant retrograde orbit',
        distance_km:  2.24e6,                // 1.4 million miles
        summary:      'First integrated test of SLS + Orion. Validated TPS at lunar-return velocity and returned the first deep-space radiation dosimetry since Apollo.',
        confidence:   'observed',
    },
    {
        id:           'artemis-2',
        name:         'Artemis II',
        status:       'completed',
        launched:     '2026 (recent)',         // updated post-flight; exact dates pending public mission report
        crewed:       true,
        crew_size:    4,
        profile:      'Crewed lunar flyby, free-return trajectory, ~10 days',
        summary:      'First crewed flight beyond LEO since Apollo 17 (1972). Flew a free-return lunar flyby with a 4-person crew, validating Orion\'s life support, comms, and manual operations under actual crewed conditions. First crewed deep-space radiation dosimetry since Apollo — replaces Artemis I\'s Helga/Zohar phantom measurements with live human exposure data.',
        confidence:   'observed',
        notes:        'Mission data still being released at time of writing; specific numeric results will be added as the post-flight science report is published.',
    },
    {
        id:           'artemis-3',
        name:         'Artemis III',
        status:       'planned',
        launched:     '2027 (target)',
        crewed:       true,
        crew_size:    2,                       // two surface crew
        profile:      'Crewed south-polar landing via SpaceX Starship HLS',
        summary:      'First crewed lunar landing since Apollo 17. One of 13 announced candidate regions within 6° of the south pole, chosen for proximity to permanently-shadowed regions hosting water ice confirmed by LCROSS + LRO.',
        confidence:   'planned',
    },
    {
        id:           'artemis-4',
        name:         'Artemis IV',
        status:       'planned',
        launched:     '2028 (target)',
        crewed:       true,
        crew_size:    4,
        profile:      'Gateway rendezvous + I-Hab module delivery, crewed surface',
        summary:      'First mission to dock with the Lunar Gateway and deliver the International Habitat module; expands surface-expedition cadence.',
        confidence:   'planned',
    },
]);

// ── Artemis I science returns ──────────────────────────────────────────────

export const ARTEMIS_I_FINDINGS = Object.freeze([
    {
        topic:        'Deep-space radiation dose (MARE)',
        instrument:   'Matroshka AstroRad Radiation Experiment — Helga (unshielded) + Zohar (AstroRad vest)',
        measured:     '~0.30–0.70 mSv/day deep-space background',
        modelled:     '~0.35–0.65 mSv/day (CRaTER baseline)',
        delta:        'Agreement within uncertainty envelope; no major model revision required.',
        vest_effect:  '~50–60% organ-equivalent dose reduction with AstroRad (Zohar vs Helga).',
        significance: 'Validated that CRaTER-derived GCR dose predictions remain accurate for Orion-class spacecraft. Quantified benefit of localized abdominal shielding for the first time in flight.',
        confidence:   'preliminary',
        source:       'DLR GSOC + NASA JSC preliminary release (2023–2024)',
    },
    {
        topic:        'Heat shield at lunar-return velocity',
        instrument:   'AVCOAT ablative TPS, ~11 km/s re-entry',
        observation:  'Shield intact and vehicle recovered nominally; post-flight inspection revealed unexpected char spalling in the skip-entry region rather than the ballistic entry zone.',
        significance: 'Triggered a multi-year forensic investigation into charring kinetics during skip-entry heat pulses. Primary driver of the Artemis II launch-date slip from 2024 to late 2026.',
        confidence:   'observed',
        source:       'NASA Artemis I Post-Flight Report (2023)',
    },
    {
        topic:        'Distant retrograde orbit (DRO)',
        instrument:   'Orion mission planning + DSN tracking',
        observation:  '6-day DRO at ~60,000 km from the Moon\'s surface; validated fuel margin and communications geometry.',
        significance: 'Demonstrated DRO as a viable staging orbit; informs Gateway NRHO (Near-Rectilinear Halo Orbit) mission planning.',
        confidence:   'observed',
        source:       'NASA Orion Mission Operations Report (2023)',
    },
    {
        topic:        'Power Distribution Unit fault',
        instrument:   'Orion ESM (European Service Module) power subsystem',
        observation:  'Intermittent current limiter shedding during cruise; non-critical loads affected. Root cause traced and corrected for II.',
        significance: 'Known issue closed-out rather than grounding the program.',
        confidence:   'observed',
        source:       'NASA/ESA Artemis I Anomaly Report (2023)',
    },
    {
        topic:        'CubeSat deployments',
        instrument:   '10 rideshare 6U/12U CubeSats, SLS Block 1 Stage Adapter',
        observation:  '6 of 10 CubeSats operated successfully; 4 experienced comms or power anomalies. LunaH-Map (neutron mapper) reached lunar orbit; NEA Scout (solar sail) failed to deploy.',
        significance: 'Low-cost rideshare programme validated but highlighted integration/test margins that need tightening for II rideshares.',
        confidence:   'observed',
        source:       'NASA Science Mission Directorate post-flight summaries',
    },
]);

// ── Apollo landing sites (for historical continuity) ───────────────────────
// All Apollo landings were equatorial. Artemis deliberately targets the pole
// — the scientific rationale is water ice in permanently-shadowed regions,
// which Apollo couldn\'t reach.

export const APOLLO_SITES = Object.freeze([
    { id: 'a11', mission: 'Apollo 11', date: '1969-07-20', lat:  0.67,  lon:  23.47, region: 'Mare Tranquillitatis',  duration_h: 21.6 },
    { id: 'a12', mission: 'Apollo 12', date: '1969-11-19', lat: -3.01,  lon: -23.42, region: 'Oceanus Procellarum',   duration_h: 31.5 },
    { id: 'a14', mission: 'Apollo 14', date: '1971-02-05', lat: -3.65,  lon: -17.47, region: 'Fra Mauro',              duration_h: 33.5 },
    { id: 'a15', mission: 'Apollo 15', date: '1971-07-30', lat: 26.13,  lon:   3.63, region: 'Hadley–Apennine',        duration_h: 66.9 },
    { id: 'a16', mission: 'Apollo 16', date: '1972-04-21', lat: -8.97,  lon:  15.50, region: 'Descartes Highlands',    duration_h: 71.0 },
    { id: 'a17', mission: 'Apollo 17', date: '1972-12-11', lat: 20.19,  lon:  30.77, region: 'Taurus–Littrow',         duration_h: 75.0 },
]);

// ── Artemis III candidate landing regions ──────────────────────────────────
// Announced by NASA in August 2022. Each is a ~15 km² region within 6° of
// the south pole, selected for proximity to permanently-shadowed craters
// (water ice), communications windows with Earth, and illumination for
// surface ops + solar power. Final selection depends on launch date
// (which sets the illumination geometry) and Starship HLS landing
// performance.

export const ARTEMIS_III_CANDIDATES = Object.freeze([
    { id: 'faustini-a',          name: 'Faustini Rim A',            lat: -87.2, lon:  78.0, note: 'Rim of Faustini crater; cold trap inside' },
    { id: 'peak-near-shackleton',name: 'Peak Near Shackleton',      lat: -88.8, lon: 128.0, note: 'Near-permanent illumination peak' },
    { id: 'connecting-ridge',    name: 'Connecting Ridge',          lat: -89.5, lon: 222.7, note: 'Ridge between Shackleton + de Gerlache' },
    { id: 'connecting-ridge-ext',name: 'Connecting Ridge Extension',lat: -89.7, lon: 220.0, note: 'Extended illumination line adjacent to CR' },
    { id: 'de-gerlache-1',       name: 'de Gerlache Rim 1',         lat: -89.0, lon: 255.0, note: 'Rim access to de Gerlache PSR' },
    { id: 'de-gerlache-2',       name: 'de Gerlache Rim 2',         lat: -88.6, lon: 280.0, note: 'Alternate de Gerlache rim approach' },
    { id: 'de-gerlache-kocher',  name: 'de Gerlache–Kocher Massif', lat: -88.4, lon: 293.0, note: 'Highland massif between two PSRs' },
    { id: 'haworth',             name: 'Haworth',                   lat: -87.3, lon:  -5.1, note: 'Crater rim; deep cold trap' },
    { id: 'malapert-massif',     name: 'Malapert Massif',           lat: -86.0, lon:   2.9, note: 'High illumination + direct Earth view' },
    { id: 'nobile-1',            name: 'Nobile Rim 1',              lat: -85.5, lon:  45.0, note: 'Access to Nobile crater volatiles' },
    { id: 'nobile-2',            name: 'Nobile Rim 2',              lat: -85.3, lon:  47.0, note: 'Alternate Nobile approach vector' },
    { id: 'amundsen',            name: 'Amundsen Rim',              lat: -84.3, lon:  85.0, note: 'Well-characterized by Kaguya SELENE' },
    { id: 'leibnitz-beta',       name: 'Leibnitz Beta Plateau',     lat: -85.5, lon:  33.0, note: 'Highland plateau near far-side PSRs' },
]);

// ── Comparative dose rates (for moon.html Dose Comparison card) ────────────

export const ARTEMIS_DOSE_POINTS = Object.freeze([
    { label: 'Artemis I — deep-space (unshielded, Helga)', mSv_per_day: 0.52, cGy_per_yr: 19,  source: 'MARE preliminary', confidence: 'preliminary' },
    { label: 'Artemis I — deep-space (AstroRad, Zohar)',   mSv_per_day: 0.24, cGy_per_yr:  9,  source: 'MARE preliminary', confidence: 'preliminary' },
    { label: 'Apollo 14 (lunar-surface mean dose rate)',   mSv_per_day: 0.27, cGy_per_yr: 10,  source: 'PLSS dosimeters',  confidence: 'observed'    },
]);

// ── 3D conversion helper — lat/lon (degrees) to unit-sphere Cartesian ──────

export function latLonToXYZ(lat, lon, radius = 1.0) {
    const phi    = (lat)       * Math.PI / 180;   // north positive
    const lambda = (lon)       * Math.PI / 180;   // east positive
    return {
        x:  radius * Math.cos(phi) * Math.cos(lambda),
        y:  radius * Math.sin(phi),
        z: -radius * Math.cos(phi) * Math.sin(lambda),
    };
}
