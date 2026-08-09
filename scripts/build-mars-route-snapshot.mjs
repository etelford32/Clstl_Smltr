#!/usr/bin/env node
/**
 * Bake NASA's public MMGIS Perseverance waypoint GeoJSON into the small,
 * deterministic route snapshot bundled at data/mars/perseverance-route.json.
 *
 * Usage:
 *   node scripts/build-mars-route-snapshot.mjs INPUT.json OUTPUT.json [YYYY-MM-DD]
 *   node scripts/build-mars-route-snapshot.mjs --fetch OUTPUT.json [YYYY-MM-DD]
 *
 * Source endpoint:
 *   https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json
 *
 * The normalization rules live in js/mars-route-normalize.js because
 * api/mars/route.js serves the SAME shape live from MMGIS and the bundled file
 * is its offline fallback. Do not re-implement the parsing here — if the two
 * drift, the globe draws a different traverse depending on whether NASA's
 * endpoint happened to be up.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { MARS_ROUTE_SOURCE_URL, normalizeMarsRoute } from '../js/mars-route-normalize.js';

const [, , inputPath, outputPath, checkedAt = new Date().toISOString().slice(0, 10)] = process.argv;
if (!inputPath || !outputPath) {
    console.error('Usage: node scripts/build-mars-route-snapshot.mjs INPUT.json OUTPUT.json [YYYY-MM-DD]');
    console.error('       node scripts/build-mars-route-snapshot.mjs --fetch OUTPUT.json [YYYY-MM-DD]');
    process.exit(2);
}

const source = inputPath === '--fetch'
    ? await (async () => {
        const response = await fetch(MARS_ROUTE_SOURCE_URL, {
            headers: { Accept: 'application/json', 'User-Agent': 'ParkerPhysics/1.0 (+https://parkersphysics.com)' },
        });
        if (!response.ok) throw new Error(`MMGIS HTTP ${response.status}`);
        return response.json();
    })()
    : JSON.parse(readFileSync(inputPath, 'utf8'));

const output = normalizeMarsRoute(source, { checkedAt });

writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${outputPath}: ${output.point_count} NASA drive stops through sol ${output.through_sol} (${output.distance_km} km)`);
