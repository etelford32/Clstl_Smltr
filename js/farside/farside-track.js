/**
 * js/farside/farside-track.js — Phase 3: tracking + emergence ETA.
 *
 * A real far-side region keeps a roughly fixed Carrington longitude across
 * successive maps (only the sub-Earth point moves), so tracking is a
 * nearest-neighbour link in Carrington (lon, lat) — NOT an optical-flow
 * problem. Linking across the 12-hourly series buys two things:
 *
 *   - a strength TREND (growing vs. decaying), the difference between a region
 *     worth warning about and detector noise, and
 *   - rejection of one-frame transients (a track seen in ≥2 maps is real; a
 *     single-frame blob is a candidate false alarm).
 *
 * Works off "frames" — {timestamp, L0, dets[]} — so it runs identically on
 * freshly-detected synthetic maps (browser) and on the detection history the
 * ingestion cron stored in Supabase (Phase 1). The product output is, per
 * track, a predicted east-limb crossing date with a confidence band.
 */

import { emergenceETA, wrap180, wrap360, SYNODIC_DEG_PER_DAY } from './carrington.js';
import { detectSignatures, isStrong } from './farside-detect.js';
import { VALIDATION_CASES } from './farside-config.js';

const LINK_LON_DEG = 12;  // max Carrington-lon gap to call two blobs the same region
const LINK_LAT_DEG = 12;

/** Shortest angular separation in longitude (deg). */
function lonSep(a, b) { return Math.abs(wrap180(a - b)); }

/** Match a Carrington position to a known validation case, if close enough. */
function matchValidationCase(lon, lat) {
    for (const c of VALIDATION_CASES) {
        if (lonSep(c.carringtonLon, lon) <= 15 && Math.abs(c.carringtonLat - lat) <= 15) return c;
    }
    return null;
}

/** Full FarSideMaps → frames (runs the detector on each map). */
function framesFromSeries(series) {
    return series.map((map) => ({
        timestamp: map.timestamp, L0: map.L0, B0: map.B0,
        dets: detectSignatures(map),
    }));
}

/**
 * Link detections across time-ordered frames (oldest → newest) into tracks.
 * @param {{timestamp:string,L0:number,dets:object[]}[]} frames
 */
export function buildTracksFromFrames(frames) {
    if (!frames?.length) return [];
    const tracks = [];

    frames.forEach((frame, fi) => {
        for (const d of (frame.dets || [])) {
            let best = null, bestGap = Infinity;
            for (const t of tracks) {
                const last = t.points[t.points.length - 1];
                if (lonSep(last.lon, d.lon) <= LINK_LON_DEG &&
                    Math.abs(last.lat - d.lat) <= LINK_LAT_DEG) {
                    const gap = lonSep(last.lon, d.lon) + Math.abs(last.lat - d.lat);
                    if (gap < bestGap) { best = t; bestGap = gap; }
                }
            }
            if (best) best.points.push({ frame: fi, ...d, t: frame.timestamp });
            else tracks.push({
                id: `fst-${fi}-${Math.round(d.lon)}-${Math.round(d.lat)}`,
                points: [{ frame: fi, ...d, t: frame.timestamp }],
            });
        }
    });

    const latest = frames[frames.length - 1];
    return tracks.map((t) => summarizeTrack(t, latest.L0, latest.timestamp));
}

/** FarSideMaps overload (detects then links). */
export function buildTracks(series) {
    return buildTracksFromFrames(framesFromSeries(series));
}

/**
 * Re-derive the VIEWING-TIME-DEPENDENT half of a track at another instant.
 *
 * A track's identity — where it sits in Carrington longitude, how strong it
 * is, how many frames saw it — is a property of the observations and does not
 * change when you move the clock. Its central-meridian distance, its lead
 * time, and its emergence date are properties of WHERE THE OBSERVER IS, and
 * change continuously as L0 sweeps. Splitting the two is what lets the
 * simulation scrub at animation rates: the expensive half (detect + link) runs
 * once, and this runs per frame over a handful of tracks.
 *
 * This is also the ONE place emergence timing is computed — summarizeTrack()
 * calls straight through to it, so the watch list, the scrubber's emergence
 * ticks, and the globe can never quote three slightly different answers.
 *
 * @param {object} track   summarized track (needs lon, lat, etaBandDays)
 * @param {number} L0      sub-Earth Carrington longitude at the instant
 * @param {number} atMs    the instant itself (ms epoch)
 */
export function projectTrack(track, L0, atMs) {
    const eta = emergenceETA(track.lon, L0);
    return {
        ...track,
        cmd: eta.cmd,
        onDisc: eta.onDisc,
        etaDays: eta.days,
        emergenceUTC: new Date(atMs + eta.days * 86400000).toISOString(),
    };
}

/**
 * Project every track to `atMs`, far-side soonest-first with already-emerged
 * regions last.
 *
 * On-disc regions are KEPT rather than filtered out the way watchFilter()
 * drops them. Scrubbing a region across the limb is the payoff of the whole
 * page; dropping it from the list at the instant it arrives would delete the
 * event the user was watching for. They sort last and carry onDisc so the UI
 * can say "emerged" instead of quoting the ~27 d wait for their NEXT
 * rotation, which is what emergenceETA correctly returns once they are past
 * the limb.
 */
export function projectTracks(tracks, L0, atMs) {
    return (tracks || [])
        .map((t) => projectTrack(t, L0, atMs))
        .sort((a, b) => (a.onDisc ? 1 : 0) - (b.onDisc ? 1 : 0) || a.etaDays - b.etaDays);
}

/** Collapse a track's points into a single forecast record. */
function summarizeTrack(track, latestL0, latestTimestamp) {
    const pts = track.points;
    const last = pts[pts.length - 1];
    const first = pts[0];

    // Circular mean longitude + scatter.
    let sx = 0, sy = 0;
    for (const p of pts) { sx += Math.cos(p.lon * Math.PI / 180); sy += Math.sin(p.lon * Math.PI / 180); }
    const lonMean = wrap360(Math.atan2(sy / pts.length, sx / pts.length) * 180 / Math.PI);
    const latMean = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
    let lonScatter = 0;
    for (const p of pts) lonScatter += Math.abs(wrap180(p.lon - lonMean));
    lonScatter = pts.length > 1 ? lonScatter / pts.length : 6;

    const trend = pts.length > 1 ? (last.strength - first.strength) / (pts.length - 1) : 0;
    const peakStrength = Math.max(...pts.map((p) => p.strength));
    const meanConf = pts.reduce((a, p) => a + p.confidence, 0) / pts.length;

    const bandDays = lonScatter / SYNODIC_DEG_PER_DAY + 0.5;

    // Time-invariant half here; the ETA half comes from projectTrack so there
    // is exactly one implementation of the emergence projection.
    return projectTrack({
        id: track.id,
        lon: lonMean, lat: latMean,
        lonScatter,
        frames: pts.length,
        firstSeen: first.t, lastSeen: last.t,
        peakStrength, latestStrength: last.strength,
        // Latest apparent footprint. Carried on the summary because the
        // flare climatology ranks regions BY SIZE and would otherwise have to
        // reach into `points` and pick a frame itself — two consumers, two
        // choices of frame, two different answers.
        areaDeg2: last.areaDeg2 ?? null,
        peakAreaDeg2: Math.max(...pts.map((p) => p.areaDeg2 ?? 0)) || null,
        trend, confidence: meanConf,
        strong: isStrong(last),
        etaBandDays: bandDays,
        points: pts,
        validationCase: matchValidationCase(lonMean, latMean),
    }, latestL0, Date.parse(latestTimestamp));
}

/** Far-side, transient-rejected, soonest-first. The panel's primary data. */
function watchFilter(tracks, nFrames) {
    const minFrames = nFrames > 1 ? 2 : 1;
    return tracks
        .filter((t) => !t.onDisc && Math.abs(t.cmd) > 90 && t.frames >= minFrames)
        .sort((a, b) => a.etaDays - b.etaDays);
}

/** Watch list from full FarSideMaps. */
export function farSideWatchList(series) {
    return watchFilter(buildTracks(series), series.length);
}

/** Watch list from stored detection frames (from /api/solar/farside?format=series). */
export function farSideWatchListFromFrames(frames) {
    return watchFilter(buildTracksFromFrames(frames), frames.length);
}
