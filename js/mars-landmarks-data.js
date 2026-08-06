/**
 * Curated major Mars surface features from the USGS/IAU Gazetteer of
 * Planetary Nomenclature. Coordinates are planetocentric, east-positive,
 * normalized to -180..180 longitude. Diameters are the Gazetteer's listed
 * approximate feature extents, not invented marker sizes.
 *
 * Full official dataset:
 * https://planetarynames.wr.usgs.gov/Page/MARS/target
 */

export const MARS_LANDMARK_CATEGORIES = Object.freeze({
    volcano: Object.freeze({ label: 'Volcanoes', color: 0xff8a4c }),
    fracture: Object.freeze({ label: 'Canyons & fractures', color: 0x69e4ff }),
    basin: Object.freeze({ label: 'Basins & plains', color: 0x8da7ff }),
    crater: Object.freeze({ label: 'Craters & missions', color: 0x73f5a8 }),
    polar: Object.freeze({ label: 'Polar deposits', color: 0xe8f4ff }),
});

const F = Object.freeze;
export const MARS_LANDMARKS = Object.freeze([
    F({ name: 'Olympus Mons', category: 'volcano', latDeg: 18.6528, lonDeg: -133.8025, diameterKm: 610.13, priority: 1,
        note: 'The largest volcano on Mars: an immense shield with a summit caldera and a planet-scale basal escarpment.', source: 'https://planetarynames.wr.usgs.gov/Feature/4453' }),
    F({ name: 'Ascraeus Mons', category: 'volcano', latDeg: 11.9216, lonDeg: -104.0808, diameterKm: 456.396, priority: 2,
        note: 'The northern and tallest of the three Tharsis Montes shield volcanoes.', source: 'https://planetarynames.wr.usgs.gov/Feature/417' }),
    F({ name: 'Pavonis Mons', category: 'volcano', latDeg: 1.4801, lonDeg: -112.9624, diameterKm: 366.53, priority: 2,
        note: 'The equatorial middle member of the Tharsis Montes chain.', source: 'https://planetarynames.wr.usgs.gov/Feature/4620' }),
    F({ name: 'Arsia Mons', category: 'volcano', latDeg: -8.2571, lonDeg: -120.0925, diameterKm: 470, priority: 2,
        note: 'The southern Tharsis Montes shield, marked by a broad caldera and extensive lava plains.', source: 'https://planetarynames.wr.usgs.gov/Feature/394' }),
    F({ name: 'Elysium Mons', category: 'volcano', latDeg: 25.0232, lonDeg: 147.2138, diameterKm: 401, priority: 2,
        note: 'The central shield volcano of the Elysium volcanic province.', source: 'https://planetarynames.wr.usgs.gov/Feature/1783' }),
    F({ name: 'Alba Mons', category: 'volcano', latDeg: 41.082, lonDeg: -110.7094, diameterKm: 548.023, priority: 3,
        note: 'An exceptionally broad, low-slope shield volcano north of Tharsis.', source: 'https://planetarynames.wr.usgs.gov/Feature/14306' }),

    F({ name: 'Valles Marineris', category: 'fracture', latDeg: -14.0059, lonDeg: -58.5877, diameterKm: 3761.278, priority: 1,
        note: 'A linked canyon system spanning more than a quarter of Mars’ circumference.', source: 'https://planetarynames.wr.usgs.gov/Feature/6288' }),
    F({ name: 'Noctis Labyrinthus', category: 'fracture', latDeg: -6.3625, lonDeg: -101.1889, diameterKm: 1190.305, priority: 2,
        note: 'A maze of intersecting grabens and collapse pits at the western head of Valles Marineris.', source: 'https://planetarynames.wr.usgs.gov/Feature/4324' }),
    F({ name: 'Cerberus Fossae', category: 'fracture', latDeg: 11.2766, lonDeg: 166.3738, diameterKm: 1235, priority: 2,
        note: 'Young, long fissures in Elysium Planitia associated with recent volcanism and seismic activity.', source: 'https://planetarynames.wr.usgs.gov/Feature/1109' }),
    F({ name: 'Olympica Fossae', category: 'fracture', latDeg: 24.8531, lonDeg: -113.9219, diameterKm: 420, priority: 3,
        note: 'A radial fracture system on the northern flank of the Tharsis rise.', source: 'https://planetarynames.wr.usgs.gov/Feature/4452' }),

    F({ name: 'Hellas Planitia', category: 'basin', latDeg: -42.4301, lonDeg: 70.5025, diameterKm: 2299.162, priority: 1,
        note: 'One of the Solar System’s largest exposed impact basins and the deepest broad lowland on Mars.', source: 'https://planetarynames.wr.usgs.gov/Feature/2432' }),
    F({ name: 'Argyre Planitia', category: 'basin', latDeg: -49.8406, lonDeg: -43.3098, diameterKm: 892.933, priority: 2,
        note: 'A great southern impact basin ringed by rugged massifs and ancient drainage valleys.', source: 'https://planetarynames.wr.usgs.gov/Feature/371' }),
    F({ name: 'Utopia Planitia', category: 'basin', latDeg: 46.7363, lonDeg: 117.5168, diameterKm: 3560.448, priority: 2,
        note: 'A vast northern impact basin and the landing region of Viking 2 and Zhurong.', source: 'https://planetarynames.wr.usgs.gov/Feature/6260' }),
    F({ name: 'Isidis Planitia', category: 'basin', latDeg: 13.9357, lonDeg: 88.3772, diameterKm: 1224.58, priority: 2,
        note: 'An ancient impact basin immediately east of Jezero Crater and the Syrtis Major region.', source: 'https://planetarynames.wr.usgs.gov/Feature/2735' }),

    F({ name: 'Gale Crater', gazetteerName: 'Gale', category: 'crater', latDeg: -5.3672, lonDeg: 137.811, diameterKm: 154.084, priority: 2,
        note: 'Curiosity’s landing crater, containing the layered central mountain Aeolis Mons.', source: 'https://planetarynames.wr.usgs.gov/Feature/2071' }),
    F({ name: 'Jezero Crater', gazetteerName: 'Jezero', category: 'crater', latDeg: 18.4082, lonDeg: 77.6873, diameterKm: 47.521, priority: 1,
        note: 'Perseverance’s landing region: an ancient crater lake with a preserved river delta.', source: 'https://planetarynames.wr.usgs.gov/Feature/14300' }),

    F({ name: 'Planum Boreum', category: 'polar', latDeg: 87.32, lonDeg: 54.96, diameterKm: 354.63, priority: 3,
        note: 'The layered northern polar plateau, dominated by water ice with a seasonal carbon-dioxide cap.', source: 'https://planetarynames.wr.usgs.gov/Feature/4754' }),
    F({ name: 'Planum Australe', category: 'polar', latDeg: -83.35, lonDeg: 157.7, diameterKm: 1429.87, priority: 3,
        note: 'The layered southern polar plateau, with permanent water and carbon-dioxide ice deposits.', source: 'https://planetarynames.wr.usgs.gov/Feature/4753' }),
]);
