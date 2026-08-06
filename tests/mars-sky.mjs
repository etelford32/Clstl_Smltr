import assert from 'node:assert/strict';
import {
    MARS_SKY_BODIES,
    interpolateHorizonsObserverSamples,
    marsPlanetocentricToGeodetic,
    parseHorizonsObserverTable,
} from '../js/horizons.js';

const table = `
Header text that must not affect parsing
$$SOE
 2026-Aug-05 20:00:00.000,*,r, 359.000000,    -5.250000,  1.48500000000000,  2.0000000,
 2026-Aug-05 21:00:00.000, , ,   1.000000,     9.750000,  1.49500000000000,  4.0000000,
$$EOE
Footer text
`;

const samples = parseHorizonsObserverTable(table);
assert.equal(samples.length, 2);
assert.equal(samples[0].observed_at, '2026-08-05T20:00:00.000Z');
assert.equal(samples[0].azimuth_deg, 359);
assert.equal(samples[0].elevation_deg, -5.25);
assert.equal(samples[1].range_rate_km_s, 4);

const halfway = interpolateHorizonsObserverSamples(samples, new Date('2026-08-05T20:30:00.000Z'));
assert.ok(Math.abs(halfway.azimuth_deg) < 1e-9, 'azimuth crosses 360° by the shortest path');
assert.ok(Math.abs(halfway.elevation_deg - 2.25) < 1e-6);
assert.ok(Math.abs(halfway.range_au - 1.49) < 1e-9);
assert.ok(Math.abs(halfway.range_rate_km_s - 3) < 1e-7);
assert.equal(halfway.above_horizon, true);

assert.ok(Math.abs(marsPlanetocentricToGeodetic(18.42638931) - 18.63021193) < 1e-8);
assert.equal(marsPlanetocentricToGeodetic(90), 90);
assert.throws(() => marsPlanetocentricToGeodetic(91), /within ±90/);

assert.deepEqual(
    MARS_SKY_BODIES.map(body => [body.key, body.command]),
    [['sun', '10'], ['earth', '399'], ['moon', '301'], ['ceres', '1;'], ['vesta', '4;']],
);

assert.throws(() => parseHorizonsObserverTable('no markers'), /missing observer table markers/);
console.log('mars-sky: Horizons observer parsing, interpolation, and five-body registry passed');
