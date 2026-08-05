#!/usr/bin/env node
/**
 * Normalize NASA's public MMGIS Perseverance waypoint GeoJSON into the small,
 * deterministic route snapshot consumed by mars.html.
 *
 * Usage:
 *   node scripts/build-mars-route-snapshot.mjs INPUT.json OUTPUT.json [YYYY-MM-DD]
 *
 * Source endpoint:
 *   https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json
 *
 * NASA's source includes panorama metadata and duplicate localization fields
 * that the globe does not need. This keeps every drive stop but retains only
 * its sol, RMC, coordinate, elevation, and cumulative odometer value.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [, , inputPath, outputPath, checkedAt = new Date().toISOString().slice(0, 10)] = process.argv;
if (!inputPath || !outputPath) {
    console.error('Usage: node scripts/build-mars-route-snapshot.mjs INPUT.json OUTPUT.json [YYYY-MM-DD]');
    process.exit(2);
}

const source = JSON.parse(readFileSync(inputPath, 'utf8'));
if (source?.type !== 'FeatureCollection' || !Array.isArray(source.features)) {
    throw new Error('Expected a GeoJSON FeatureCollection');
}

const round = (value, places) => Number(Number(value).toFixed(places));
const points = source.features.map((feature, index) => {
    const properties = feature?.properties || {};
    const coordinates = feature?.geometry?.coordinates || [];
    const [lon, lat, elevation] = coordinates;
    const sol = Number(properties.sol);
    const rawDistanceKm = Number(properties.dist_total_m) / 1000;
    if (![lon, lat, sol, rawDistanceKm].every(Number.isFinite)) {
        throw new Error(`Invalid waypoint at feature ${index}`);
    }
    return {
        sol,
        site: Number(properties.site),
        drive: Number(properties.drive),
        lon_deg: round(lon, 8),
        lat_deg: round(lat, 8),
        elevation_m: Number.isFinite(Number(elevation)) ? round(elevation, 2) : null,
        // NASA uses 0 for some mid-drive localizations whose cumulative
        // odometer is not populated. Preserve that as unknown, not zero.
        distance_km: index === 0 || rawDistanceKm > 0 ? round(rawDistanceKm, 3) : null,
    };
});

if (points.length < 2) throw new Error('Route needs at least two waypoints');
for (let index = 1; index < points.length; index += 1) {
    if (points[index].sol < points[index - 1].sol) throw new Error(`Sol order regressed at point ${index}`);
    const previousReported = points.slice(0, index).findLast(point => point.distance_km != null)?.distance_km;
    if (points[index].distance_km != null && previousReported != null && points[index].distance_km < previousReported) {
        throw new Error(`Odometer regressed at point ${index}`);
    }
}

const latest = points.at(-1);
const output = {
    schema_version: 1,
    mission: 'Mars 2020 Perseverance',
    source_name: 'NASA/JPL MMGIS Rover Waypoints',
    source_url: 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json',
    map_url: 'https://mars.nasa.gov/maps/location/?mission=M20&site=NOW',
    snapshot_checked_at: checkedAt,
    through_sol: latest.sol,
    distance_km: Number(latest.distance_km.toFixed(2)),
    point_count: points.length,
    points,
};

writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${outputPath}: ${points.length} NASA drive stops through sol ${latest.sol} (${output.distance_km} km)`);
