import assert from 'node:assert/strict';
import { MARS_LANDMARKS, MARS_LANDMARK_CATEGORIES } from '../js/mars-landmarks-data.js';

const PERSEVERANCE_LAT = 18.444677;
const PERSEVERANCE_LON = 77.450812;

const names = new Set();
for (const landmark of MARS_LANDMARKS) {
    assert.ok(!names.has(landmark.name), `duplicate landmark: ${landmark.name}`);
    names.add(landmark.name);
    assert.ok(MARS_LANDMARK_CATEGORIES[landmark.category], `${landmark.name}: known category`);
    assert.ok(landmark.latDeg >= -90 && landmark.latDeg <= 90, `${landmark.name}: latitude in range`);
    assert.ok(landmark.lonDeg >= -180 && landmark.lonDeg <= 180, `${landmark.name}: longitude in range`);
    assert.ok(landmark.diameterKm > 0, `${landmark.name}: positive official extent`);
    assert.ok([1, 2, 3].includes(landmark.priority), `${landmark.name}: valid LOD priority`);
    assert.match(landmark.source, /^https:\/\/planetarynames\.wr\.usgs\.gov\/Feature\//, `${landmark.name}: official source`);
    assert.ok(landmark.note.length > 30, `${landmark.name}: useful description`);
}

assert.equal(MARS_LANDMARKS.length, 18);
for (const category of Object.keys(MARS_LANDMARK_CATEGORIES)) {
    assert.ok(MARS_LANDMARKS.some(landmark => landmark.category === category), `${category}: populated`);
}

const olympus = MARS_LANDMARKS.find(landmark => landmark.name === 'Olympus Mons');
assert.deepEqual(
    { lat: olympus.latDeg, lon: olympus.lonDeg, diameter: olympus.diameterKm },
    { lat: 18.6528, lon: -133.8025, diameter: 610.13 },
);
const valles = MARS_LANDMARKS.find(landmark => landmark.name === 'Valles Marineris');
assert.equal(valles.diameterKm, 3761.278);
const jezero = MARS_LANDMARKS.find(landmark => landmark.name === 'Jezero Crater');
assert.ok(Math.abs(jezero.latDeg - PERSEVERANCE_LAT) < 0.1 && Math.abs(jezero.lonDeg - PERSEVERANCE_LON) < 0.5);

console.log(`mars-landmarks: ${MARS_LANDMARKS.length} official features across ${Object.keys(MARS_LANDMARK_CATEGORIES).length} categories passed`);
