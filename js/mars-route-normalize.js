/**
 * mars-route-normalize.js — the ONE normalizer for NASA/JPL MMGIS Perseverance
 * waypoints.
 *
 * Two callers share this, and they must not drift:
 *
 *   scripts/build-mars-route-snapshot.mjs   bakes data/mars/perseverance-route.json
 *   api/mars/route.js                       serves the same shape live from MMGIS
 *
 * The bundled snapshot is the OFFLINE FALLBACK for the live route, not a second
 * source of truth. If these two ever produced different shapes, the client would
 * silently render a different route depending on whether NASA's endpoint was up
 * — which is exactly the class of bug the provenance panel exists to prevent.
 * Change the rules here and both paths move together.
 *
 * NASA quirks encoded here (do not "clean up"):
 *   - `dist_total_m` is 0 for some mid-drive localization records whose
 *     cumulative odometer was never populated. Writing that through as 0 makes
 *     the traverse scrubber look like the rover teleported back to the landing
 *     site. Those become `null` = "unknown", and the client walks backwards to
 *     the last reported value.
 *   - Coordinates are planetocentric, east-positive. Horizons wants geodetic,
 *     west-positive — that conversion lives in js/horizons.js, NOT here.
 */

export const MARS_ROUTE_SCHEMA_VERSION = 1;
export const MARS_ROUTE_SOURCE_URL = 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json';
export const MARS_ROUTE_MAP_URL = 'https://mars.nasa.gov/maps/location/?mission=M20&site=NOW';

const round = (value, places) => Number(Number(value).toFixed(places));

/**
 * Normalize an MMGIS waypoint FeatureCollection into the compact route snapshot
 * consumed by mars.html.
 *
 * @param {object} source                GeoJSON FeatureCollection from MMGIS
 * @param {object} [options]
 * @param {string} [options.checkedAt]   YYYY-MM-DD provenance stamp
 * @returns {object} route snapshot (schema_version 1)
 * @throws {Error} when the payload is not a usable waypoint collection
 */
export function normalizeMarsRoute(source, { checkedAt = new Date().toISOString().slice(0, 10) } = {}) {
    if (source?.type !== 'FeatureCollection' || !Array.isArray(source.features)) {
        throw new Error('Expected a GeoJSON FeatureCollection');
    }

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
            distance_km: index === 0 || rawDistanceKm > 0 ? round(rawDistanceKm, 3) : null,
        };
    });

    assertMonotonicRoute(points);

    const latest = points.at(-1);
    const reportedDistanceKm = points.findLast(point => point.distance_km != null)?.distance_km ?? 0;
    return {
        schema_version: MARS_ROUTE_SCHEMA_VERSION,
        mission: 'Mars 2020 Perseverance',
        source_name: 'NASA/JPL MMGIS Rover Waypoints',
        source_url: MARS_ROUTE_SOURCE_URL,
        map_url: MARS_ROUTE_MAP_URL,
        snapshot_checked_at: checkedAt,
        through_sol: latest.sol,
        distance_km: round(reportedDistanceKm, 2),
        point_count: points.length,
        points,
    };
}

/**
 * Structural guard shared by the baker and the live route. A traverse that goes
 * backwards in sol or odometer means NASA changed the payload semantics; failing
 * loudly is better than drawing a scrambled route over the globe.
 */
export function assertMonotonicRoute(points) {
    if (!Array.isArray(points) || points.length < 2) throw new Error('Route needs at least two waypoints');
    let lastReported = null;
    for (let index = 1; index < points.length; index += 1) {
        if (points[index].sol < points[index - 1].sol) throw new Error(`Sol order regressed at point ${index}`);
        if (points[index - 1].distance_km != null) lastReported = points[index - 1].distance_km;
        if (points[index].distance_km != null && lastReported != null && points[index].distance_km < lastReported) {
            throw new Error(`Odometer regressed at point ${index}`);
        }
    }
    return true;
}

export default normalizeMarsRoute;
