/**
 * storm-forecast.js — kinematic 5-day extrapolation of a tropical cyclone
 *
 * Why this module exists
 * ──────────────────────
 * NHC's CurrentStorms.json carries the storm's current state and links to
 * KMZ files containing the official forecast cone, but not structured
 * forecast points. Parsing those KMZ files server-side adds a meaningful
 * dependency for a feature that, on a globe visualisation, is ultimately
 * a directional hint. So this module produces an *honest approximation*:
 * a great-circle extrapolation of the current motion vector with a slight
 * climatological recurvature, and a cone width drawn from NHC's published
 * average track errors.
 *
 * IMPORTANT: this is NOT NHC's official forecast. Callers must label it
 * as a kinematic extrapolation. The intent is to give the user a quick
 * visual cue about where each active storm is heading; it should never
 * be used for navigation or evacuation decisions.
 *
 * Method
 * ──────
 * 1. Step along a great circle from (lat, lon) using the current bearing
 *    (movementDir) at the current ground speed (movementKt) for each
 *    horizon: 12, 24, 36, 48, 72, 96, 120 hours.
 * 2. Apply a gentle recurvature: storms in the Northern Hemisphere
 *    poleward of 20° tend to curve toward 060° (NE) as they enter the
 *    westerlies. Mirror in the Southern Hemisphere toward 240° (SW).
 *    The recurvature ramps in linearly between 24 h and 120 h, never
 *    exceeds a 30° heading change, and is gated on latitude so a
 *    Caribbean storm doesn't get an artificial poleward kick.
 * 3. At each forecast point, attach an error radius drawn from NHC's
 *    Atlantic average track-forecast errors (NM):
 *
 *        12 h  → 24    24 h  → 36    36 h  → 47
 *        48 h  → 58    72 h  → 83    96 h  → 110   120 h → 137
 *
 *    These are the *2014–2023 mean radii* used for the public NHC
 *    forecast cone. Eastern/central Pacific basins are similar; West
 *    Pacific JTWC errors are larger but we don't differentiate here
 *    since this is already an approximation.
 * 4. Bearing along the cone centerline at each point is the great-
 *    circle initial bearing toward the next point — used by the
 *    overlay to compute the perpendicular cone-edge offsets.
 *
 * Units
 * ─────
 *   distance: nautical miles internally; converted via NM_PER_DEG_LAT
 *   bearing:  degrees from true north, clockwise
 *   horizons: hours from issue time
 */

// Standard NHC forecast horizons in hours.
export const FORECAST_HORIZONS_H = [12, 24, 36, 48, 72, 96, 120];

// NHC published average track-forecast errors (Atlantic basin, 2014-2023
// climatology), nautical miles. Used as the cone radius at each horizon.
// Values from the NHC verification report's published average errors;
// EPac is comparable so we use the same table for all basins.
const ERROR_RADIUS_NM = {
    12:  24,
    24:  36,
    36:  47,
    48:  58,
    72:  83,
    96:  110,
    120: 137,
};

const EARTH_RADIUS_NM = 3440.065;   // mean radius in nautical miles

// Great-circle stepper: given a start (lat, lon) in degrees, an initial
// bearing in degrees clockwise from north, and a distance in nautical
// miles, return the destination (lat, lon) on the sphere.
//
// Standard "direct geodetic problem" on a sphere — accurate enough for a
// globe-scale visualisation; we don't need WGS84 ellipsoid corrections
// when the caller is going to render onto a unit-sphere icosahedron.
function destinationPoint(latDeg, lonDeg, bearingDeg, distNm) {
    const lat1 = latDeg * Math.PI / 180;
    const lon1 = lonDeg * Math.PI / 180;
    const brng = bearingDeg * Math.PI / 180;
    const ang  = distNm / EARTH_RADIUS_NM;

    const sinLat2 = Math.sin(lat1) * Math.cos(ang)
                  + Math.cos(lat1) * Math.sin(ang) * Math.cos(brng);
    const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
    const y    = Math.sin(brng) * Math.sin(ang) * Math.cos(lat1);
    const x    = Math.cos(ang) - Math.sin(lat1) * sinLat2;
    const lon2 = lon1 + Math.atan2(y, x);

    // Normalise longitude into [-180, 180].
    let outLon = lon2 * 180 / Math.PI;
    outLon = ((outLon + 540) % 360) - 180;
    return { lat: lat2 * 180 / Math.PI, lon: outLon };
}

// Initial bearing from one point to another along a great circle.
function initialBearing(lat1Deg, lon1Deg, lat2Deg, lon2Deg) {
    const φ1 = lat1Deg * Math.PI / 180;
    const φ2 = lat2Deg * Math.PI / 180;
    const Δλ = (lon2Deg - lon1Deg) * Math.PI / 180;
    const y  = Math.sin(Δλ) * Math.cos(φ2);
    const x  = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ  = Math.atan2(y, x);
    return ((θ * 180 / Math.PI) + 360) % 360;
}

// Recurvature heuristic. Returns a *bearing offset* in degrees (positive
// = clockwise) to apply to the storm's nominal motion vector at the
// given hour. Ramps in linearly between 24 h and 120 h so the next-12-h
// point stays close to the persistence forecast (where it's most
// reliable) and the long-range points are pulled toward climatology.
function recurvatureOffsetDeg(latDeg, currentBearingDeg, hour) {
    const absLat = Math.abs(latDeg);
    if (absLat < 20) return 0;            // tropical storms before recurvature
    const ramp = Math.max(0, Math.min(1, (hour - 24) / (120 - 24)));
    if (ramp === 0) return 0;
    // Target bearing: 060° (NE) for NH, 240° (SW) for SH.
    const targetBearing = latDeg >= 0 ? 60 : 240;
    // Smallest signed angular difference current → target.
    let diff = ((targetBearing - currentBearingDeg + 540) % 360) - 180;
    // Hard cap at ±30° so a westward-moving storm never spins around
    // entirely; the heuristic exists to bend, not to steer.
    diff = Math.max(-30, Math.min(30, diff));
    return diff * ramp;
}

/**
 * Extrapolate a 5-day kinematic forecast for one storm.
 *
 * @param {object} storm  — feed object with at minimum lat, lon,
 *                          movementDir (deg), movementKt (knots).
 * @returns {{
 *   points: Array<{ hour:number, lat:number, lon:number,
 *                   bearing:number, errorNm:number }>,
 *   recurvatureApplied: boolean,
 *   issuedAt: number       — wall-clock ms at extrapolation time
 * }}
 *
 * Returns null when the storm doesn't carry the inputs needed (no
 * movement vector or non-finite position).
 */
export function extrapolateStormTrack(storm) {
    if (!storm) return null;
    const lat = +storm.lat, lon = +storm.lon;
    const dir = +storm.movementDir;
    const kt  = +storm.movementKt;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (!Number.isFinite(dir) || !Number.isFinite(kt) || kt <= 0) return null;

    let curLat = lat;
    let curLon = lon;
    let lastHour = 0;
    let recurvatureApplied = false;

    const points = [];
    for (const hour of FORECAST_HORIZONS_H) {
        const dh = hour - lastHour;
        const rec = recurvatureOffsetDeg(curLat, dir, hour);
        if (rec !== 0) recurvatureApplied = true;
        const stepBearing = (dir + rec + 360) % 360;
        // Distance over this slice = ground speed × elapsed.
        const stepDist = kt * dh;
        const next = destinationPoint(curLat, curLon, stepBearing, stepDist);

        // Bearing *out of* this point (initial bearing toward the next
        // hypothetical point) — used by the overlay for cone-edge
        // offsets. For the last horizon we just reuse the inbound
        // bearing; the cone tip closes there anyway.
        const nominalNextBearing = (dir + recurvatureOffsetDeg(next.lat, dir, hour + 6) + 360) % 360;

        points.push({
            hour,
            lat:     next.lat,
            lon:     next.lon,
            bearing: nominalNextBearing,
            errorNm: ERROR_RADIUS_NM[hour] ?? 0,
        });
        curLat = next.lat;
        curLon = next.lon;
        lastHour = hour;
    }

    return {
        points,
        recurvatureApplied,
        issuedAt: Date.now(),
    };
}

// ── Track interpolation ────────────────────────────────────────────────────
//
// Given a storm + its extrapolated track, return the projected position
// at any hour in [0, max horizon]. The Storm Watch scrubber feeds this
// every time the user moves the slider — the panel paints the resulting
// {lat, lon} as the card's "at +Nh" readout, and the globe overlay
// places a glowing dot at the same point. Pure function so both
// callers can share it without coupling to Three.js.
//
// Interpolation method:
//   - hour ≤ 0           → snap to the storm's current position
//   - hour between two
//     bracketing wpts H1, H2 → great-circle slerp on the unit-sphere
//     positions of the bracket, with the fraction (hour - H1)/(H2 - H1)
//   - hour ≥ last wpt    → clamp to the final waypoint (we don't extrapolate
//                          past the published cone — the error radii beyond
//                          120 h grow non-linearly and we'd be making up
//                          numbers that look authoritative).
//
// errorNm is interpolated linearly between bracket radii; it's used for
// the cone-radius footprint of the scrubber dot's halo.

const D2R_LOCAL = Math.PI / 180;

function _latLonToVec(lat, lon) {
    const φ = lat * D2R_LOCAL, λ = lon * D2R_LOCAL;
    const c = Math.cos(φ);
    return { x: c * Math.cos(λ), y: c * Math.sin(λ), z: Math.sin(φ) };
}
function _vecToLatLon(v) {
    const lat = Math.atan2(v.z, Math.sqrt(v.x * v.x + v.y * v.y)) / D2R_LOCAL;
    const lon = Math.atan2(v.y, v.x) / D2R_LOCAL;
    return { lat, lon };
}
function _slerp(a, b, t) {
    let dot = a.x * b.x + a.y * b.y + a.z * b.z;
    dot = Math.max(-1, Math.min(1, dot));
    const ω = Math.acos(dot);
    if (ω < 1e-6) return { x: a.x, y: a.y, z: a.z };
    const sω = Math.sin(ω);
    const wa = Math.sin((1 - t) * ω) / sω;
    const wb = Math.sin(t * ω) / sω;
    return { x: a.x * wa + b.x * wb, y: a.y * wa + b.y * wb, z: a.z * wa + b.z * wb };
}

/**
 * @param {object} args
 * @param {object} args.storm  — current storm (provides the t=0 position)
 * @param {object} args.track  — extrapolateStormTrack(storm) result
 * @param {number} args.hour   — forecast hour (0..maxHorizon)
 * @returns {{lat, lon, errorNm, hour, fromHour, toHour, frac, clamped}}
 *   `clamped`: true when the requested hour fell outside [0, last horizon]
 *   and we returned an endpoint instead of an interpolation.
 */
export function interpolateTrackAtHour({ storm, track, hour }) {
    if (!storm || !track || !Array.isArray(track.points) || track.points.length === 0) {
        return null;
    }
    const cur = { lat: +storm.lat, lon: +storm.lon, hour: 0, errorNm: 0 };
    if (!Number.isFinite(cur.lat) || !Number.isFinite(cur.lon)) return null;

    if (!(hour > 0)) {
        return { ...cur, hour: 0, fromHour: 0, toHour: 0, frac: 0, clamped: hour < 0 };
    }
    const lastPoint = track.points[track.points.length - 1];
    if (hour >= lastPoint.hour) {
        return {
            lat: lastPoint.lat, lon: lastPoint.lon, errorNm: lastPoint.errorNm,
            hour: lastPoint.hour, fromHour: lastPoint.hour, toHour: lastPoint.hour,
            frac: 1, clamped: hour > lastPoint.hour,
        };
    }
    // Find bracketing pair.
    let from = cur, to = track.points[0];
    if (hour > track.points[0].hour) {
        for (let i = 1; i < track.points.length; i++) {
            if (hour <= track.points[i].hour) {
                from = track.points[i - 1];
                to   = track.points[i];
                break;
            }
        }
    }
    const span = to.hour - from.hour;
    const frac = span > 0 ? (hour - from.hour) / span : 0;

    // Great-circle interpolation between the bracket positions.
    const va = _latLonToVec(from.lat, from.lon);
    const vb = _latLonToVec(to.lat,   to.lon);
    const vi = _slerp(va, vb, frac);
    // Re-normalise (slerp should keep |v|=1 but float drift accumulates).
    const len = Math.hypot(vi.x, vi.y, vi.z) || 1;
    vi.x /= len; vi.y /= len; vi.z /= len;
    const ll = _vecToLatLon(vi);
    const errorNm = (from.errorNm ?? 0) * (1 - frac) + (to.errorNm ?? 0) * frac;
    return {
        lat:      ll.lat,
        lon:      ll.lon,
        errorNm,
        hour,
        fromHour: from.hour,
        toHour:   to.hour,
        frac,
        clamped:  false,
    };
}

// Helpers exposed for tests / direct callers.
export { destinationPoint, initialBearing, ERROR_RADIUS_NM, EARTH_RADIUS_NM };
export default extrapolateStormTrack;
