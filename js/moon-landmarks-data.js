/**
 * moon-landmarks-data.js — named lunar surface features for the Moon page.
 * ═══════════════════════════════════════════════════════════════════════════
 * Pure data, no three.js (the renderer is js/moon-landmarks.js) — so the
 * Node gate tests/moon-landmarks.mjs can import it directly, following the
 * artemis-data.js / js/data/major-cities.js pattern.
 *
 * Positions are IAU Gazetteer of Planetary Nomenclature center coordinates
 * (planetocentric, east-positive longitude), rounded to the precision a
 * globe marker can honestly carry. `diameterKm` is the feature's listed
 * diameter/length — the renderer draws it as a true-extent ring on the
 * sphere, so Clavius really is ~2.7× Tycho and South Pole–Aitken really
 * does span a third of the globe. Farside features are deliberately well
 * represented: the far side is half the Moon and most visitors have never
 * seen a map of it.
 *
 * Reiner Gamma's coordinates MUST match CRUSTAL_ANOMALIES in
 * moon-interior-model.js (the interior view marks the same spot as a
 * magnetic anomaly; the surface view marks it as a swirl) — the test pins
 * the two modules together.
 */

// Category keys → panel labels + marker colors (renderer + page read BOTH
// from here; a legend with its own copies drifts silently).
export const LANDMARK_CATEGORIES = Object.freeze({
    crater: Object.freeze({ label: 'Craters', color: 0xff8a70 }),
    mare: Object.freeze({ label: 'Maria (lava seas)', color: 0x6f9dff }),
    basin: Object.freeze({ label: 'Impact basins', color: 0xc9a0ff }),
    relief: Object.freeze({ label: 'Mountains & valleys', color: 0x7dedb0 }),
    swirl: Object.freeze({ label: 'Swirls', color: 0xd18fff }),
});

const F = Object.freeze;
export const LANDMARKS = Object.freeze([
    // ── Craters ──────────────────────────────────────────────────────────────
    F({ name: 'Tycho', category: 'crater', latDeg: -43.31, lonDeg: -11.36, diameterKm: 85,
        note: 'Only ~108 Myr old — its bright rays streak across half the nearside.' }),
    F({ name: 'Copernicus', category: 'crater', latDeg: 9.62, lonDeg: -20.08, diameterKm: 93,
        note: 'The archetypal complex crater: terraced walls, central peaks. Names the Copernican period.' }),
    F({ name: 'Kepler', category: 'crater', latDeg: 8.12, lonDeg: -38.01, diameterKm: 32,
        note: 'Bright ray crater standing alone in Oceanus Procellarum.' }),
    F({ name: 'Aristarchus', category: 'crater', latDeg: 23.73, lonDeg: -47.49, diameterKm: 40,
        note: 'The brightest spot on the Moon, on a plateau rich in volcanic glass.' }),
    F({ name: 'Plato', category: 'crater', latDeg: 51.62, lonDeg: -9.38, diameterKm: 101,
        note: 'Lava-flooded dark floor on Imbrium’s northern shore.' }),
    F({ name: 'Clavius', category: 'crater', latDeg: -58.4, lonDeg: -14.4, diameterKm: 231,
        note: 'Giant of the southern highlands; SOFIA detected molecular water here in 2020.' }),
    F({ name: 'Archimedes', category: 'crater', latDeg: 29.7, lonDeg: -4.0, diameterKm: 83,
        note: 'Lava-filled: younger than the Imbrium basin, older than the lavas that filled both.' }),
    F({ name: 'Eratosthenes', category: 'crater', latDeg: 14.47, lonDeg: -11.32, diameterKm: 59,
        note: 'Names the Eratosthenian period (3.2–1.1 Ga) of lunar history.' }),
    F({ name: 'Langrenus', category: 'crater', latDeg: -8.86, lonDeg: 60.77, diameterKm: 132,
        note: 'Terraced eastern-limb crater, brilliant at full moon.' }),
    F({ name: 'Petavius', category: 'crater', latDeg: -25.39, lonDeg: 60.75, diameterKm: 177,
        note: 'A giant rille runs from its central peak straight to the wall.' }),
    F({ name: 'Grimaldi', category: 'crater', latDeg: -5.5, lonDeg: -68.3, diameterKm: 173,
        note: 'Basin-like, with one of the darkest floors on the Moon — and a strong mascon.' }),
    F({ name: 'Gassendi', category: 'crater', latDeg: -17.55, lonDeg: -39.96, diameterKm: 110,
        note: 'Fractured-floor crater on Mare Humorum’s northern shore.' }),
    F({ name: 'Posidonius', category: 'crater', latDeg: 31.88, lonDeg: 29.99, diameterKm: 95,
        note: 'Fractured floor threaded by the sinuous Rimae Posidonius.' }),
    F({ name: 'Theophilus', category: 'crater', latDeg: -11.45, lonDeg: 26.28, diameterKm: 99,
        note: 'Sharp complex crater punched into its older neighbour Cyrillus.' }),
    F({ name: 'Shackleton', category: 'crater', latDeg: -89.9, lonDeg: 0.0, diameterKm: 21,
        note: 'At the south pole: rim in near-perpetual sunlight, floor in permanent shadow with cold-trapped ice — the Artemis magnet.' }),
    F({ name: 'Tsiolkovskiy', category: 'crater', latDeg: -20.4, lonDeg: 129.1, diameterKm: 185,
        note: 'Farside rarity: a jet-black mare-lava floor amid pale highlands.' }),
    F({ name: 'Giordano Bruno', category: 'crater', latDeg: 35.9, lonDeg: 102.8, diameterKm: 22,
        note: 'Youngest sizeable crater (~4 Myr) — its rays are still razor fresh.' }),
    F({ name: 'Von Kármán', category: 'crater', latDeg: -44.45, lonDeg: 176.3, diameterKm: 180,
        note: 'Inside South Pole–Aitken; Chang’e-4 made the first farside landing here (2019).' }),
    F({ name: 'Daedalus', category: 'crater', latDeg: -5.9, lonDeg: 179.4, diameterKm: 93,
        note: 'Dead-centre farside — proposed radio-quiet observatory site, shielded from Earth’s chatter.' }),

    // ── Maria — the lava seas ────────────────────────────────────────────────
    F({ name: 'Mare Tranquillitatis', category: 'mare', latDeg: 8.5, lonDeg: 31.4, diameterKm: 873,
        note: 'The Sea of Tranquility — Apollo 11’s footprints are on its southwest shore.' }),
    F({ name: 'Mare Serenitatis', category: 'mare', latDeg: 28.0, lonDeg: 17.5, diameterKm: 707,
        note: 'A mascon sea; Apollo 17 sampled its southeastern rim.' }),
    F({ name: 'Mare Imbrium', category: 'mare', latDeg: 32.8, lonDeg: -15.6, diameterKm: 1145,
        note: 'The ~3.9 Ga impact that dug this basin shook the entire crust.' }),
    F({ name: 'Mare Crisium', category: 'mare', latDeg: 17.0, lonDeg: 59.1, diameterKm: 556,
        note: 'The isolated oval on the eastern limb; Luna 24 returned samples in 1976.' }),
    F({ name: 'Mare Fecunditatis', category: 'mare', latDeg: -7.8, lonDeg: 51.3, diameterKm: 909,
        note: 'Site of the first robotic sample return — Luna 16, 1970.' }),
    F({ name: 'Mare Nectaris', category: 'mare', latDeg: -15.2, lonDeg: 35.5, diameterKm: 333,
        note: 'Its basin-forming impact names the Nectarian period (~3.9 Ga).' }),
    F({ name: 'Mare Nubium', category: 'mare', latDeg: -21.3, lonDeg: -16.6, diameterKm: 715,
        note: 'The Sea of Clouds; Rupes Recta runs along its eastern edge.' }),
    F({ name: 'Mare Humorum', category: 'mare', latDeg: -24.4, lonDeg: -38.6, diameterKm: 389,
        note: 'A compact mascon basin ringed by arcuate rilles.' }),
    F({ name: 'Mare Frigoris', category: 'mare', latDeg: 56.0, lonDeg: 1.4, diameterKm: 1596,
        note: 'The Sea of Cold, stretched thin along the whole northern nearside.' }),
    F({ name: 'Oceanus Procellarum', category: 'mare', latDeg: 18.4, lonDeg: -57.4, diameterKm: 2568,
        note: 'The only “ocean” — vast, KREEP-rich, volcanically active for billions of years.' }),
    F({ name: 'Mare Orientale', category: 'mare', latDeg: -19.4, lonDeg: -92.8, diameterKm: 327,
        note: 'Heart of the textbook multi-ring basin — a 930 km bullseye on the western limb.' }),
    F({ name: 'Mare Moscoviense', category: 'mare', latDeg: 27.3, lonDeg: 147.9, diameterKm: 276,
        note: 'One of the very few farside maria, sunk deep in its basin.' }),
    F({ name: 'Mare Ingenii', category: 'mare', latDeg: -33.7, lonDeg: 163.5, diameterKm: 318,
        note: 'The Sea of Cleverness — farside home of swirls antipodal to Imbrium.' }),

    // ── Basins ───────────────────────────────────────────────────────────────
    F({ name: 'South Pole–Aitken basin', category: 'basin', latDeg: -53.0, lonDeg: -169.0, diameterKm: 2500,
        note: 'Oldest, largest, deepest impact scar on the Moon — 13 km of relief; the impact may have exposed mantle.' }),

    // ── Mountains, valleys, scarps ───────────────────────────────────────────
    F({ name: 'Montes Apenninus', category: 'relief', latDeg: 18.9, lonDeg: -3.7, diameterKm: 600,
        note: 'Imbrium’s uplifted rim, peaks to ~5 km; Apollo 15 landed at its foot.' }),
    F({ name: 'Vallis Alpes', category: 'relief', latDeg: 48.5, lonDeg: 3.2, diameterKm: 166,
        note: 'A graben slicing clean through the lunar Alps, a slim rille on its floor.' }),
    F({ name: 'Vallis Schröteri', category: 'relief', latDeg: 26.2, lonDeg: -50.8, diameterKm: 168,
        note: 'The largest sinuous rille — a collapsed lava channel off the Aristarchus plateau.' }),
    F({ name: 'Rima Hadley', category: 'relief', latDeg: 25.0, lonDeg: 3.8, diameterKm: 80,
        note: 'The lava channel Apollo 15 drove beside in 1971.' }),
    F({ name: 'Rupes Recta', category: 'relief', latDeg: -22.1, lonDeg: -7.8, diameterKm: 110,
        note: 'The “Straight Wall” — a 110 km normal-fault scarp, knife-sharp at low sun.' }),
    F({ name: 'Mons Rümker', category: 'relief', latDeg: 40.8, lonDeg: -58.1, diameterKm: 70,
        note: 'A pile of volcanic domes; Chang’e-5 returned the youngest samples (2.0 Ga) from nearby.' }),

    // ── Swirls ───────────────────────────────────────────────────────────────
    F({ name: 'Reiner Gamma', category: 'swirl', latDeg: 7.4, lonDeg: -59.1, diameterKm: 70,
        note: 'The archetypal lunar swirl: bright ribbons painted by a crustal magnetic bubble deflecting solar wind. The interior view marks the anomaly itself.' }),
]);
