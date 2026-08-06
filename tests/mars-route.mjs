import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const route = JSON.parse(readFileSync(new URL('../data/mars/perseverance-route.json', import.meta.url), 'utf8'));
assert.equal(route.schema_version, 1);
assert.equal(route.source_name, 'NASA/JPL MMGIS Rover Waypoints');
assert.match(route.source_url, /^https:\/\/mars\.nasa\.gov\/mmgis-maps\/M20\/Layers\/json\/M20_waypoints\.json$/);
assert.equal(route.snapshot_checked_at, '2026-08-05');
assert.equal(route.point_count, route.points.length);
assert.equal(route.points.length, 690);
assert.equal(route.points[0].sol, 13);
assert.equal(route.points.at(-1).sol, 1940);
assert.equal(route.through_sol, 1940);
assert.equal(route.distance_km, 44.14);
assert.deepEqual(
    { lat: route.points.at(-1).lat_deg, lon: route.points.at(-1).lon_deg },
    { lat: 18.42638931, lon: 77.22455732 },
);

let lastSol = -Infinity;
let lastReportedDistance = -Infinity;
let nullOdometers = 0;
for (const point of route.points) {
    assert.ok(point.sol >= lastSol, `sol order regressed at ${point.sol}`);
    lastSol = point.sol;
    assert.ok(point.lat_deg >= -90 && point.lat_deg <= 90);
    assert.ok(point.lon_deg >= -180 && point.lon_deg <= 180);
    if (point.distance_km == null) {
        nullOdometers += 1;
    } else {
        assert.ok(point.distance_km >= lastReportedDistance, `reported odometer regressed at sol ${point.sol}`);
        lastReportedDistance = point.distance_km;
    }
}
assert.ok(nullOdometers > 0, 'NASA zero-valued mid-drive odometers are preserved as unknown');

console.log(`mars-route: ${route.points.length} NASA drive stops through sol ${route.through_sol} passed`);
