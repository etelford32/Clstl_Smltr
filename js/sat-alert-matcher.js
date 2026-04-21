/**
 * sat-alert-matcher.js — satellite ↔ active-weather-event matcher
 * ═══════════════════════════════════════════════════════════════════════════
 * Given a satellite catalog (with current sub-points) and live feeds of NWS
 * alerts + tropical cyclones, returns which satellites are *currently over*
 * which events. Powers the "sat over Hurricane X" overlay on satellites.html.
 *
 * ALGORITHM
 * ─────────
 * For each alert / storm, derive an effective spherical-cap radius:
 *   NWS alert — √(areaKm2 / π). Exact for a circular polygon; within
 *               ~10 % of perimeter for county-shaped polygons (most US
 *               warnings) and over-generous for elongated winter-storm
 *               watches, which errs on the side of flagging extras.
 *   Storm     — classification → rule-of-thumb radius, bumped up for
 *               cat-4/5 intensity. Refine later if we wire NHC wind-radii.
 *
 * Then, for every satellite, great-circle distance from sub-point to the
 * event centroid; flag when within (radius + padding). A cheap latitude
 * prefilter keeps the inner loop short — with ~5 000 sats and ~100 events,
 * the whole pass is sub-millisecond on a laptop.
 *
 * This function does NO network, NO DOM, NO state. Caller is responsible
 * for throttling invocations — alerts refresh every 5 min, storms every
 * 30 min, sat positions ~60 Hz, but sats move ~8 km/s so ≈1 Hz is plenty
 * to keep the "currently over" visual honest.
 *
 * RETURNS
 * ───────
 *   Map<noradId, { alerts: Alert[], storms: Storm[] }>
 * Only satellites with at least one hit appear in the map. Each matched
 * event carries a `distanceKm` property (centroid distance for reference).
 */

const DEG         = Math.PI / 180;
const R_EARTH_KM  = 6371.0088;

// Tropical-cyclone effective radius (km) per NHC classification. Based
// on the typical outer extent of tropical-storm-force (34 kt) winds.
// Single number per class — consistent across basins, easy to reason
// about. Swap to observed wind-radii once we ingest NHC forecast-cone
// data.
const STORM_RADIUS_KM = {
    TD:  150,     // tropical depression
    TS:  250,     // tropical storm
    HU:  350,     // hurricane (cat 1-2)
    TY:  350,     // typhoon
    MH:  550,     // major hurricane (cat 3+)
    STY: 550,     // super typhoon
};

// Soft-geography padding. Polygon boundaries are approximations and wind
// fields are irregular, so over-flag by ~50 km rather than miss a sat
// right at the edge. Caller can override via opts.paddingKm.
const DEFAULT_PADDING_KM = 50;

// Fallback radius for alerts whose geometry resolved only to a Point
// (state-level fallback lookups in nws-alerts.js). 75 km matches a typical
// county radius and keeps single-county warnings from flagging overhead
// sats at the opposite end of the state.
const POINT_FALLBACK_RADIUS_KM = 75;

function _gcDistKm(lat1, lon1, lat2, lon2) {
    const phi1 = lat1 * DEG;
    const phi2 = lat2 * DEG;
    const dPhi = (lat2 - lat1) * DEG;
    const dLam = (lon2 - lon1) * DEG;
    const a = Math.sin(dPhi * 0.5) ** 2
            + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam * 0.5) ** 2;
    return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function _alertRadiusKm(alert) {
    if (!alert.areaKm2 || alert.areaKm2 <= 0) return POINT_FALLBACK_RADIUS_KM;
    return Math.sqrt(alert.areaKm2 / Math.PI);
}

function _stormRadiusKm(storm) {
    const base = STORM_RADIUS_KM[storm.classification] ?? STORM_RADIUS_KM.TS;
    // Intensity bump for genuine big storms. Cat-4 (113 kt) / Cat-5
    // (137 kt) ship outer wind fields well past the class average.
    if (storm.intensityKt > 137) return Math.max(base, 650);
    if (storm.intensityKt >  96) return Math.max(base, 500);
    return base;
}

/**
 * @param {Array<{norad_id, lat, lon, name, group}>} sats
 * @param {Array<{id, event, severity, lat, lon, areaKm2}>} alerts
 * @param {Array<{id, name, lat, lon, classification, intensityKt}>} storms
 * @param {object} [opts]
 * @param {number} [opts.paddingKm=50]        — inflate radii to catch edge
 *                                              cases; negative values tighten.
 * @param {Set<string>} [opts.groupAllowList] — limit to these sat.group
 *                                              names (null → all groups).
 * @returns {Map<number, { alerts: Alert[], storms: Storm[] }>}
 */
export function findSatsOverAlerts(sats, alerts, storms, opts = {}) {
    const padding = opts.paddingKm ?? DEFAULT_PADDING_KM;
    const allow   = opts.groupAllowList ?? null;
    const out     = new Map();

    if ((!alerts || alerts.length === 0) && (!storms || storms.length === 0)) {
        return out;
    }

    // Pre-derive effective radius + latitude-band prefilter per event.
    // latBand = radius / 111 km/°; a sat more than latBand degrees away
    // in latitude from an event centroid can't possibly be inside it.
    const alertList = (alerts ?? []).map(a => {
        const r = _alertRadiusKm(a) + padding;
        return { a, r, latBand: r / 111 };
    });
    const stormList = (storms ?? []).map(s => {
        const r = _stormRadiusKm(s) + padding;
        return { s, r, latBand: r / 111 };
    });

    for (const sat of sats) {
        if (sat.lat == null || sat.lon == null) continue;
        if (allow && !allow.has(sat.group))     continue;

        let hit = null;

        for (const { a, r, latBand } of alertList) {
            if (Math.abs(sat.lat - a.lat) > latBand) continue;
            const d = _gcDistKm(sat.lat, sat.lon, a.lat, a.lon);
            if (d <= r) {
                (hit ??= { alerts: [], storms: [] }).alerts.push({
                    id:       a.id,
                    event:    a.event,
                    severity: a.severity,
                    area:     a.area,
                    expires:  a.expires,
                    lat:      a.lat,
                    lon:      a.lon,
                    distanceKm: d,
                });
            }
        }

        for (const { s, r, latBand } of stormList) {
            if (Math.abs(sat.lat - s.lat) > latBand) continue;
            const d = _gcDistKm(sat.lat, sat.lon, s.lat, s.lon);
            if (d <= r) {
                (hit ??= { alerts: [], storms: [] }).storms.push({
                    id:             s.id,
                    name:           s.name,
                    classification: s.classification,
                    intensityKt:    s.intensityKt,
                    lat:            s.lat,
                    lon:            s.lon,
                    distanceKm:     d,
                });
            }
        }

        if (hit) out.set(sat.norad_id, hit);
    }

    return out;
}

// Expose the radius helpers for debug and future UI (drawing alert
// footprints as rings on the globe etc.). Not part of the hot path.
export { _alertRadiusKm as alertRadiusKm, _stormRadiusKm as stormRadiusKm };
