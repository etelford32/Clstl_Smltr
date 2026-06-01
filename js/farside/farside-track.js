/**
 * js/farside/farside-track.js — Phase 3: tracking + emergence ETA.
 *
 * A real far-side region keeps a roughly fixed Carrington longitude across
 * successive maps (only the sub-Earth point moves), so tracking is a
 * nearest-neighbour link in Carrington (lon, lat) — NOT an optical-flow
 * problem. Linking across the 12-hourly series buys two things:
 *
 *   - a strength TREND (growing vs. decaying), which is the difference
 *     between a region worth warning about and detector noise, and
 *   - rejection of one-frame transients (a track seen in ≥2 maps is real;
 *     a single-frame blob is a candidate false alarm).
 *
 * The product output is, per track, a predicted east-limb crossing date with
 * a confidence band derived from the synodic-rate uncertainty + the centroid
 * longitude scatter across frames.
 */

import { emergenceETA, wrap180, wrap360, SYNODIC_DEG_PER_DAY } from './carrington.js';
import { detectSignatures, isStrong } from './farside-detect.js';
import { VALIDATION_CASES } from './farside-config.js';

/** Match a Carrington position to a known validation case, if close enough. */
function matchValidationCase(lon, lat) {
    for (const c of VALIDATION_CASES) {
        if (lonSep(c.carringtonLon, lon) <= 15 && Math.abs(c.carringtonLat - lat) <= 15) return c;
    }
    return null;
}

const LINK_LON_DEG = 12;  // max Carrington-lon gap to call two blobs the same region
const LINK_LAT_DEG = 12;

/** Shortest angular separation in longitude (deg). */
function lonSep(a, b) { return Math.abs(wrap180(a - b)); }

/**
 * Link detections across a time-ordered series of maps into tracks.
 * @param {object[]} series  oldest → newest FarSideMaps (from getMapSeries)
 * @returns {object[]} tracks
 */
export function buildTracks(series) {
    if (!series?.length) return [];
    const tracks = [];

    series.forEach((map, frame) => {
        const dets = detectSignatures(map);
        for (const d of dets) {
            // Find the closest still-open track.
            let best = null, bestGap = Infinity;
            for (const t of tracks) {
                if (t._closedAt != null) continue;
                const last = t.points[t.points.length - 1];
                const gap = lonSep(last.lon, d.lon) + Math.abs(last.lat - d.lat);
                if (lonSep(last.lon, d.lon) <= LINK_LON_DEG &&
                    Math.abs(last.lat - d.lat) <= LINK_LAT_DEG && gap < bestGap) {
                    best = t; bestGap = gap;
                }
            }
            if (best) {
                best.points.push({ frame, ...d, t: map.timestamp });
            } else {
                tracks.push({
                    id: `fst-${frame}-${Math.round(d.lon)}-${Math.round(d.lat)}`,
                    points: [{ frame, ...d, t: map.timestamp }],
                });
            }
        }
        // Close tracks not seen in this frame (a one-frame gap is tolerated by
        // not closing immediately; here we keep it simple and never hard-close,
        // letting summarize() weigh recency).
    });

    return tracks.map((t) => summarizeTrack(t, series));
}

/** Collapse a track's points into a single forecast record. */
function summarizeTrack(track, series) {
    const pts = track.points;
    const latest = series[series.length - 1];
    const last = pts[pts.length - 1];
    const first = pts[0];

    // Mean Carrington position (lon via circular mean) and scatter.
    let sx = 0, sy = 0;
    for (const p of pts) { sx += Math.cos(p.lon * Math.PI / 180); sy += Math.sin(p.lon * Math.PI / 180); }
    const lonMean = wrap360(Math.atan2(sy / pts.length, sx / pts.length) * 180 / Math.PI);
    const latMean = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
    let lonScatter = 0;
    for (const p of pts) lonScatter += Math.abs(wrap180(p.lon - lonMean));
    lonScatter = pts.length > 1 ? lonScatter / pts.length : 6;

    // Strength trend: positive = growing.
    const trend = pts.length > 1 ? (last.strength - first.strength) / (pts.length - 1) : 0;
    const peakStrength = Math.max(...pts.map((p) => p.strength));
    const meanConf = pts.reduce((a, p) => a + p.confidence, 0) / pts.length;

    // Emergence ETA from the latest map's central meridian.
    const eta = emergenceETA(lonMean, latest.L0);
    // Confidence band: longitude scatter + a half-day synodic-rate allowance.
    const bandDays = lonScatter / SYNODIC_DEG_PER_DAY + 0.5;

    const crossing = new Date(Date.parse(latest.timestamp) + eta.days * 86400000);

    return {
        id: track.id,
        lon: lonMean,
        lat: latMean,
        frames: pts.length,
        firstSeen: first.t,
        lastSeen: last.t,
        peakStrength,
        latestStrength: last.strength,
        trend,                                  // strength/day-ish
        confidence: meanConf,
        strong: isStrong(last),
        cmd: eta.cmd,                           // central-meridian distance (deg)
        onDisc: eta.onDisc,                     // already Earth-facing?
        etaDays: eta.days,
        etaBandDays: bandDays,
        emergenceUTC: crossing.toISOString(),
        points: pts,
        validationCase: matchValidationCase(lonMean, latMean),
    };
}

/**
 * Far-side watch list: tracks that are still on the far side (not yet
 * Earth-facing), seen in ≥2 frames (transient-rejected), sorted by soonest
 * emergence. This is the panel's primary data. A single-frame blob is treated
 * as a candidate false alarm and held back — UNLESS the series itself is a
 * single live map (no history to corroborate against yet).
 */
export function farSideWatchList(series) {
    const minFrames = series.length > 1 ? 2 : 1;
    return buildTracks(series)
        .filter((t) => !t.onDisc && Math.abs(t.cmd) > 90 && t.frames >= minFrames)
        .sort((a, b) => a.etaDays - b.etaDays);
}
