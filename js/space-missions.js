/**
 * space-missions.js — Canonical roster of active and historically-important
 * inner-solar-system space missions, grouped by science domain.
 *
 * Used by sun.html (Heliophysics Fleet panel), threejs.html (inner-planet
 * overlay), and space-weather.html (live-asset provenance) to surface
 * "who's measuring what" next to the data those missions feed.
 *
 * Status vocabulary:
 *   'operational'   — currently returning data
 *   'extended'      — past prime mission, still operating
 *   'cruising'      — launched, not yet at destination
 *   'completed'     — mission concluded (data still in archives)
 *   'retired'       — lost / deorbited / communications ended
 *   'planned'       — approved, not yet launched
 *
 * Confidence flags for data I list here:
 *   'observed'      — well-documented from primary mission pages
 *   'derived'       — computed from published mission parameters
 *   'preliminary'   — active mission, results still being refined
 */

// ═══════════════════════════════════════════════════════════════
//  HELIOPHYSICS FLEET — PSP + the Sun-observing constellation
// ═══════════════════════════════════════════════════════════════

export const HELIOPHYSICS_MISSIONS = Object.freeze([
    {
        id:             'parker-solar-probe',
        name:           'Parker Solar Probe',
        agency:         'NASA / APL',
        launched:       '2018-08-12',
        launch_vehicle: 'Delta IV Heavy',
        status:         'operational',
        orbit:          'Heliocentric; 7 Venus gravity assists; 0.046 AU perihelion after GA#7',
        closest_approach_rsun: 8.86,          // 8.86 solar radii at closest perihelion (~6.16 Mkm)
        closest_approach_km:   6.16e6,
        instruments:    ['FIELDS (B & E fields)', 'SWEAP (ion/electron analyzers)', 'ISʘIS (energetic particles)', 'WISPR (imagers)'],
        highlights: [
            'First crossing of the Alfvén surface (April 2021, ~18.8 R_sun) — literally inside the Sun\'s corona',
            'Discovery of ubiquitous magnetic "switchbacks" — sudden ~180° reversals in the solar-wind magnetic field',
            'Observed dust-free zone near the Sun, confirming theory from 1929',
            'Characterized sub-Alfvénic solar wind populations and alpha-particle acceleration',
        ],
        summary:        'First spacecraft to "touch the Sun," measuring the corona in situ to answer how the solar wind is accelerated and heated. The defining mission of Parker\'s namesake physics.',
        confidence:     'observed',
        source:         'NASA Parker Solar Probe mission site + Bale et al. (Nature 2019)',
    },
    {
        id:             'solar-orbiter',
        name:           'Solar Orbiter',
        agency:         'ESA / NASA',
        launched:       '2020-02-10',
        launch_vehicle: 'Atlas V 411',
        status:         'operational',
        orbit:          'Heliocentric inclined; up to 33° solar latitude by 2029 (polar-ecliptic climb via Venus GAs)',
        closest_approach_au: 0.28,
        instruments:    ['EUI (Extreme UV imager)', 'PHI (Polarimetric imager)', 'METIS (coronagraph)', 'SPICE (spectrometer)', 'STIX (X-ray)', 'SWA', 'MAG', 'EPD', 'RPW'],
        highlights: [
            'Highest-resolution Sun imagery ever taken (EUI "campfires" — tiny transient brightenings)',
            'First images of the solar poles (planned 2025+ ecliptic-plane departure)',
            'Joint coordinated observations with PSP — PSP sampling the corona in situ, SO imaging the source region',
        ],
        summary:        'Companion to Parker Solar Probe: PSP measures what SO images. Will be the first spacecraft to see the Sun\'s polar regions directly.',
        confidence:     'observed',
        source:         'ESA Solar Orbiter + Müller et al. (A&A 2020)',
    },
    {
        id:             'soho',
        name:           'SOHO (Solar and Heliospheric Observatory)',
        agency:         'ESA / NASA',
        launched:       '1995-12-02',
        launch_vehicle: 'Atlas IIAS',
        status:         'extended',
        orbit:          'Sun–Earth L1 halo orbit',
        instruments:    ['LASCO (coronagraph)', 'EIT (UV imager)', 'MDI (magnetogram)', 'CELIAS', 'ERNE'],
        highlights: [
            '30+ years of continuous solar-wind + CME monitoring',
            '>5,000 comet discoveries via LASCO imagery (most prolific comet-finder in history)',
            'Foundational CME arrival-time forecasting data',
        ],
        summary:        'The workhorse of space-weather operations. Every CME arrival prediction you\'ve seen since the late 90s was calibrated against SOHO/LASCO.',
        confidence:     'observed',
        source:         'ESA/NASA SOHO Science Archive',
    },
    {
        id:             'sdo',
        name:           'Solar Dynamics Observatory',
        agency:         'NASA',
        launched:       '2010-02-11',
        launch_vehicle: 'Atlas V 401',
        status:         'operational',
        orbit:          'Geosynchronous inclined (~28° / 36,000 km)',
        instruments:    ['AIA (Atmospheric Imaging Assembly, 10 UV channels)', 'HMI (Helioseismic/Magnetic Imager)', 'EVE (Extreme UV Variability)'],
        highlights: [
            '4096×4096 full-disk solar imagery every 12 seconds across 10 wavelengths',
            'Fundamental helioseismology measurements of subsurface flows',
            'Drives nearly every operational solar-flare forecast since 2010',
        ],
        summary:        'The HD camera of the Sun. If you\'ve ever seen a high-res solar-flare loop, it came from SDO/AIA.',
        confidence:     'observed',
        source:         'NASA SDO',
    },
    {
        id:             'stereo-a',
        name:           'STEREO-A',
        agency:         'NASA',
        launched:       '2006-10-26',
        launch_vehicle: 'Delta II 7925',
        status:         'operational',
        orbit:          'Heliocentric, slightly inside Earth\'s orbit, drifting ahead of Earth',
        instruments:    ['SECCHI (suite of 5 imagers)', 'IMPACT', 'PLASTIC', 'SWAVES'],
        highlights: [
            'First stereoscopic imagery of the Sun (with STEREO-B, until B was lost in 2014)',
            'Provides Sun-Earth line context for CME trajectory fitting',
            'Periodic "far-side" views when Earth and STEREO-A are ≈180° apart',
        ],
        summary:        'The second eye on the Sun. Critical for CME 3D reconstruction since STEREO-B\'s loss.',
        confidence:     'observed',
        source:         'NASA STEREO Science Center',
    },
    {
        id:             'ace',
        name:           'ACE (Advanced Composition Explorer)',
        agency:         'NASA',
        launched:       '1997-08-25',
        launch_vehicle: 'Delta II 7920',
        status:         'extended',
        orbit:          'Sun–Earth L1',
        instruments:    ['SWEPAM', 'MAG', 'SWICS', 'SWIMS', 'SIS', 'ULEIS', 'EPAM', 'CRIS', 'SEPICA (end-of-life)'],
        highlights: [
            '27+ years of solar-wind composition + velocity measurements',
            'Primary real-time solar-wind source for the NOAA SWPC space-weather operations',
            'Running low on propellant; being gradually supplemented by IMAP',
        ],
        summary:        'The L1 solar-wind sentinel. Your current Kp forecast depends on ACE telemetry (via DSCOVR backup).',
        confidence:     'observed',
        source:         'NASA/Caltech ACE Science Center',
    },
    {
        id:             'wind',
        name:           'WIND',
        agency:         'NASA',
        launched:       '1994-11-01',
        launch_vehicle: 'Delta II 7925',
        status:         'extended',
        orbit:          'Sun–Earth L1 (Lissajous)',
        instruments:    ['MFI', '3DP', 'SWE', 'EPACT', 'WAVES', 'SMS'],
        highlights: [
            'Longest-operating solar-wind mission (30+ years)',
            'Primary reference for solar-wind plasma + interplanetary magnetic field data',
        ],
        summary:        'Older than ACE, still returning clean plasma/B-field data. Calibration reference for every follower.',
        confidence:     'observed',
        source:         'NASA WIND Mission',
    },
    {
        id:             'dscovr',
        name:           'DSCOVR (Deep Space Climate Observatory)',
        agency:         'NOAA / NASA / USAF',
        launched:       '2015-02-11',
        launch_vehicle: 'Falcon 9',
        status:         'operational',
        orbit:          'Sun–Earth L1 Lissajous',
        instruments:    ['PlasMag (solar wind)', 'EPIC (Earth-facing camera)', 'NISTAR'],
        highlights: [
            'Operational backup + primary for NOAA\'s real-time solar-wind feed',
            'Continuous Earth full-disk imagery from L1 (unique Earth-facing vantage)',
        ],
        summary:        'NOAA\'s operational solar-wind monitor. The stream that feeds real-time geomagnetic-storm forecasts.',
        confidence:     'observed',
        source:         'NOAA SWPC / NASA DSCOVR',
    },
    {
        id:             'imap',
        name:           'IMAP (Interstellar Mapping and Acceleration Probe)',
        agency:         'NASA',
        launched:       '2025-09',
        launch_vehicle: 'Falcon 9',
        status:         'cruising',
        orbit:          'Sun–Earth L1 (commissioning)',
        instruments:    ['MAG', 'SWAPI', 'SWE', 'CoDICE', 'HIT', 'IDEX', 'GLOWS', 'ULTRA', 'LO', 'HI'],
        highlights: [
            'Designed to map the heliosphere boundary with neutral-atom imaging (replaces IBEX)',
            'Characterizes particle acceleration at the termination shock + heliopause',
            'Real-time space-weather relay supplements ACE + DSCOVR',
        ],
        summary:        'Successor to ACE + IBEX. Maps the heliosphere\'s outer boundary while also feeding operational solar-wind data.',
        confidence:     'preliminary',
        source:         'NASA IMAP mission page',
    },
    {
        id:             'punch',
        name:           'PUNCH (Polarimeter to Unify Corona and Heliosphere)',
        agency:         'NASA',
        launched:       '2025-03',
        launch_vehicle: 'Falcon 9 (rideshare)',
        status:         'operational',
        orbit:          'Sun-synchronous LEO (constellation of 4 smallsats)',
        instruments:    ['NFI (Narrow Field Imager)', '3× WFI (Wide Field Imagers)'],
        highlights: [
            'Continuous polarimetric imagery linking corona to heliosphere — closes the observational gap between LASCO and in-situ',
            'First mission to image the solar wind\'s polarized light signature globally',
        ],
        summary:        'Fills the spatial gap between the solar corona (imaged by SDO/SOHO) and the inner heliosphere (sampled by PSP/Solar Orbiter).',
        confidence:     'preliminary',
        source:         'NASA / SwRI PUNCH mission',
    },
    {
        id:             'hinode',
        name:           'Hinode',
        agency:         'JAXA / NASA / STFC',
        launched:       '2006-09-22',
        launch_vehicle: 'M-V-7',
        status:         'extended',
        orbit:          'Sun-synchronous LEO (~680 km)',
        instruments:    ['SOT (Solar Optical Telescope)', 'XRT (X-ray Telescope)', 'EIS (EUV Imaging Spectrometer)'],
        highlights: [
            'Highest spatial resolution X-ray imagery of active regions',
            'Definitive magnetic-field observations for flare-prediction research',
        ],
        summary:        'The X-ray + optical Sun observatory. Key workhorse for AR magnetic complexity studies.',
        confidence:     'observed',
        source:         'JAXA Hinode project',
    },
    {
        id:             'iris',
        name:           'IRIS (Interface Region Imaging Spectrograph)',
        agency:         'NASA / LMSAL',
        launched:       '2013-06-28',
        launch_vehicle: 'Pegasus XL',
        status:         'extended',
        orbit:          'Sun-synchronous LEO (~670 km)',
        instruments:    ['UV imager + spectrograph (chromosphere / transition region)'],
        highlights: [
            'Resolved fine structure in the chromosphere + transition region — the 10,000–1M K layer where the corona is heated',
            'Drove revisions to flare-loop heating models',
        ],
        summary:        'Focused on the interface region — the thin, turbulent layer where most of the Sun\'s UV + EUV emission originates.',
        confidence:     'observed',
        source:         'NASA / LMSAL IRIS',
    },
]);

// ═══════════════════════════════════════════════════════════════
//  INNER-PLANET MISSIONS — Mercury + Venus
// ═══════════════════════════════════════════════════════════════

export const INNER_PLANET_MISSIONS = Object.freeze([
    {
        id:             'bepicolombo',
        name:           'BepiColombo',
        agency:         'ESA / JAXA',
        target:         'Mercury',
        launched:       '2018-10-20',
        launch_vehicle: 'Ariane 5 ECA',
        status:         'cruising',
        orbit:          'Heliocentric cruise; 6 Mercury flybys complete, orbit insertion late 2026',
        instruments:    ['MMO (JAXA orbiter)', 'MPO (ESA orbiter)', 'MTM (transfer module)'],
        highlights: [
            'First dual-orbiter mission at Mercury',
            'Will characterize Mercury\'s magnetosphere (weakest in the solar system)',
            'Carrying 16 scientific instruments across two orbiters',
        ],
        summary:        'The joint European-Japanese follow-up to MESSENGER. Arrives at Mercury in late 2026.',
        confidence:     'observed',
        source:         'ESA BepiColombo',
    },
    {
        id:             'messenger',
        name:           'MESSENGER',
        agency:         'NASA',
        target:         'Mercury',
        launched:       '2004-08-03',
        status:         'completed',
        orbit:          'Impacted Mercury 2015-04-30 (planned EOM)',
        instruments:    ['MDIS (cameras)', 'GRS', 'MASCS', 'MLA (laser altimeter)', 'XRS', 'EPPS', 'MAG'],
        highlights: [
            'First mission to orbit Mercury (2011–2015)',
            'Discovered water ice in Mercury\'s north-polar PSRs',
            'Mapped >98% of Mercury surface in high resolution',
            'Found massive iron-rich core (~85% of planet radius)',
        ],
        summary:        'Foundational Mercury dataset. Everything BepiColombo designs its science around.',
        confidence:     'observed',
        source:         'JHU/APL MESSENGER archive',
    },
    {
        id:             'akatsuki',
        name:           'Akatsuki (PLANET-C)',
        agency:         'JAXA',
        target:         'Venus',
        launched:       '2010-05-20',
        status:         'extended',
        orbit:          'Venus orbit (inserted on second attempt, 2015-12-07 after 2010 OIM failure)',
        instruments:    ['IR1, IR2, UVI, LIR (imagers across UV + IR)', 'LAC (lightning/airglow)', 'USO (radio science)'],
        highlights: [
            'Characterized Venus\' super-rotating atmosphere in unprecedented detail',
            'Discovered equatorial jet and planetary-scale bow-shaped wave in clouds',
            'Recovered from 5-year orbital-insertion failure through engine-burn improvisation',
        ],
        summary:        'The only operational Venus orbiter. Resurrected via thruster-only orbital insertion after main engine failed in 2010.',
        confidence:     'observed',
        source:         'JAXA Akatsuki mission',
    },
]);

// ═══════════════════════════════════════════════════════════════
//  SMALL-BODY + ASTEROID-DEFENSE MISSIONS
// ═══════════════════════════════════════════════════════════════

export const SMALL_BODY_MISSIONS = Object.freeze([
    {
        id:             'dart',
        name:           'DART (Double Asteroid Redirection Test)',
        agency:         'NASA / APL',
        target:         'Didymos/Dimorphos binary asteroid',
        launched:       '2021-11-24',
        impact:         '2022-09-26',
        status:         'completed',
        highlights: [
            'First human demonstration of kinetic impact planetary defense',
            'Shortened Dimorphos\'s orbital period around Didymos by ~33 min (vs predicted 10–15 min) — much more momentum transfer than expected',
            'Proved that the beta factor (momentum-enhancement from ejecta) is ≥3x for rubble-pile asteroids',
        ],
        summary:        'Turned planetary defense from theory to experiment. Beta-factor measurement rewrote deflection mission planning.',
        confidence:     'observed',
        source:         'Daly et al. (Nature 2023)',
    },
    {
        id:             'hera',
        name:           'Hera',
        agency:         'ESA',
        target:         'Didymos/Dimorphos (DART follow-up)',
        launched:       '2024-10-07',
        launch_vehicle: 'Falcon 9',
        status:         'cruising',
        orbit:          'Heliocentric cruise; arrival at Didymos late 2026',
        instruments:    ['AFC (framing cams)', 'HyperScout-H', 'TIRI', 'PALT', 'deployable cubesats Milani + Juventas'],
        highlights: [
            'Detailed post-impact survey of Dimorphos crater morphology',
            'Gravity measurements to characterize binary-asteroid internal structure',
            'First interplanetary cubesat deployments (Milani + Juventas)',
        ],
        summary:        'The forensic follow-up to DART. Will measure exactly what a kinetic impactor does to a rubble-pile target.',
        confidence:     'observed',
        source:         'ESA Hera',
    },
    {
        id:             'osiris-apex',
        name:           'OSIRIS-APEX',
        agency:         'NASA',
        target:         'Apophis (99942)',
        launched:       '2016-09-08 (as OSIRIS-REx; Bennu sample returned 2023-09-24)',
        status:         'extended',
        orbit:          'Heliocentric; Apophis rendezvous 2029-04 (after Earth close approach)',
        highlights: [
            'OSIRIS-REx successfully returned Bennu samples to Earth on Sept 2023',
            'Re-targeted to Apophis to observe Earth-tidal-flyby effects on a ~370 m rubble-pile asteroid',
            'Will arrive shortly after Apophis\'s 2029 close approach (32,000 km from Earth)',
        ],
        summary:        'The rare extended mission to a second target. Will study how Earth tides reshape a small body during close flyby.',
        confidence:     'observed',
        source:         'NASA / University of Arizona',
    },
    {
        id:             'psyche',
        name:           'Psyche',
        agency:         'NASA / ASU / SpaceX',
        target:         '(16) Psyche metallic asteroid',
        launched:       '2023-10-13',
        launch_vehicle: 'Falcon Heavy',
        status:         'cruising',
        orbit:          'Heliocentric cruise; Mars GA 2026, Psyche arrival 2029',
        instruments:    ['Multispectral imager', 'Gamma-ray + neutron spectrometer', 'Magnetometer', 'Gravity science (DSN ranging)'],
        highlights: [
            'First dedicated mission to a metallic (iron-nickel) asteroid',
            'Using Hall-effect (ion) propulsion for primary thrust — largest deep-space electric-prop mission to date',
            'Will test whether Psyche is a differentiated planetary core fragment',
        ],
        summary:        'First mission to what may be an exposed planetary core. Big for both planetary science and asteroid-mining economics.',
        confidence:     'observed',
        source:         'NASA / ASU Psyche mission',
    },
    {
        id:             'hayabusa2-extended',
        name:           'Hayabusa2 (extended SHAEM)',
        agency:         'JAXA',
        target:         '2001 CC21 (flyby), 1998 KY26 (rendezvous)',
        launched:       '2014-12-03',
        status:         'extended',
        orbit:          'Heliocentric; 1998 KY26 rendezvous ~2031',
        highlights: [
            'Prime mission: Ryugu sample return (delivered 2020)',
            'Extended: rendezvous with 1998 KY26, a ~30 m rapidly-rotating asteroid',
            'Will study rubble-pile vs monolithic structure at the smallest scales',
        ],
        summary:        'Extended mission to characterize the smallest asteroid class, which dominates the near-Earth population.',
        confidence:     'observed',
        source:         'JAXA Hayabusa2 Extended Mission',
    },
]);

// ═══════════════════════════════════════════════════════════════
//  LEGACY / HISTORICAL (for "what built the baseline" context)
// ═══════════════════════════════════════════════════════════════

export const LEGACY_MISSIONS = Object.freeze([
    {
        id:          'helios-a',
        name:        'Helios-A',
        agency:      'NASA / DLR',
        launched:    '1974-12-10',
        status:      'retired',
        note:        'Prior closest-approach record holder (0.29 AU) until Parker Solar Probe broke it in 2018.',
    },
    {
        id:          'ulysses',
        name:        'Ulysses',
        agency:      'ESA / NASA',
        launched:    '1990-10-06',
        retired:     '2009-06-30',
        status:      'retired',
        note:        'First polar-orbit Sun mission. Solar Orbiter is the direct scientific successor.',
    },
    {
        id:          'ibex',
        name:        'IBEX (Interstellar Boundary Explorer)',
        agency:      'NASA',
        launched:    '2008-10-19',
        status:      'extended',
        note:        'Heliosphere-boundary imager; IMAP replaces + supersedes.',
    },
    {
        id:          'mariner-10',
        name:        'Mariner 10',
        agency:      'NASA',
        launched:    '1973-11-03',
        status:      'retired',
        note:        'First Mercury + Venus flyby vehicle. First gravity-assist demonstration. The grandparent of BepiColombo.',
    },
]);

// ═══════════════════════════════════════════════════════════════
//  CONVENIENCE DISPATCHERS
// ═══════════════════════════════════════════════════════════════

export const ALL_MISSIONS = Object.freeze([
    ...HELIOPHYSICS_MISSIONS,
    ...INNER_PLANET_MISSIONS,
    ...SMALL_BODY_MISSIONS,
    ...LEGACY_MISSIONS,
]);

export function missionsByStatus(status) {
    return ALL_MISSIONS.filter(m => m.status === status);
}

export function missionById(id) {
    return ALL_MISSIONS.find(m => m.id === id) || null;
}
