/**
 * js/farside/farside-validate.js — Phase 5: the validation moat.
 *
 * Anyone can render a far-side map; a MEASURED warning horizon is what an
 * operator pays for. This module backtests the detector+tracker against a
 * ground-truth emergence record and reports the triplet that sells it:
 *
 *   - detection rate   — fraction of ground-truth regions we flagged on the far
 *                        side BEFORE they crossed the east limb,
 *   - median lead time — how many days of warning we bought, and
 *   - false-alarm rate — fraction of alert-worthy tracks that never became a
 *                        real region.
 *
 * `runBacktest(frames, truth)` is a PURE evaluator over a time-ordered series of
 * detection frames ({timestamp, L0, dets[]}) — the exact shape the ingestion
 * cron stores (api/solar/farside?format=series), so the same harness runs over
 * the real farside_maps archive once it has history. `syntheticBacktestFrames()`
 * fabricates a labelled history so the metrics are demoable today; it plants
 * each truth region at the Carrington longitude that makes it cross the east
 * limb on its real date, so the lead-time and ETA-accuracy numbers are honest
 * given the (synthetic) detections.
 */

import {
    carringtonL0, emergenceETA, wrap180, wrap360, SYNODIC_DEG_PER_DAY,
} from './carrington.js';
import { buildTracksFromFrames } from './farside-track.js';
import { BACKTEST, VALIDATION_CASES } from './farside-config.js';

const DAY = 86400000;

function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function lonSep(a, b) { return Math.abs(wrap180(a - b)); }

/** Far-side seismic detectability vs central-meridian distance (|cmd| 90→180). */
function sensitivity(cmd) {
    const a = Math.abs(cmd);
    if (a <= 90) return 0;                       // Earth-facing — not "far side"
    // Smoothly 0 at the far-side limbs, ~1 near the antipode.
    return Math.sin(((a - 90) / 90) * (Math.PI / 2));
}

/** Deterministic PRNG so a backtest run is reproducible. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function mkDet(lon, lat, strength) {
    const peak = 1.8 + strength * 1.5;
    return {
        lon: wrap360(lon), lat,
        areaDeg2: 30 + strength * 25,
        peak,
        strength,
        confidence: 1 / (1 + Math.exp(-(peak * 0.9 - 2.2))),
    };
}

/** Augment a ground-truth case with geometry-consistent backtest fields. */
function augmentCase(c) {
    const crossingMs = Date.parse(c.eastLimbCrossingUTC);
    const L0c = carringtonL0(new Date(crossingMs)).L0;
    return {
        ...c,
        crossingMs,
        lat: c.carringtonLat,
        lonFeat: wrap360(L0c - 90),          // CMD = -90 at the crossing instant
        ampPeak: c.flareProductive ? 2.6 : 1.9, // flare-productive ⇒ stronger seismic signal
    };
}

/**
 * Fabricate a labelled synthetic detection history for ONE ground-truth case —
 * the window ending at its east-limb crossing, during which the region rotates
 * across the far side. A region only dwells on the far side ~13.6 days per
 * rotation, so a per-case window (not one continuous multi-year span) is what
 * keeps the lead-time honest and avoids cross-rotation recurrence.
 * @returns {{ frames:object[], truth:object }}
 */
export function buildCaseWindow(rawCase, opts = {}) {
    const o = { ...BACKTEST, ...opts };
    const c = augmentCase(rawCase);
    const rng = mulberry32(0x5eed ^ (c.crossingMs & 0xffffffff));
    const step = o.cadenceHours * 3600 * 1000;
    const startMs = c.crossingMs - o.windowDays * DAY;

    // A persistent far-side decoy (a non-emerging signature) so the false-alarm
    // rate is honest — placed away from the truth longitude.
    const decoyLon = wrap360(c.lonFeat + 150);

    const frames = [];
    for (let t = startMs; t <= c.crossingMs; t += step) {
        const { L0 } = carringtonL0(new Date(t));
        const dets = [];

        const cmd = wrap180(c.lonFeat - L0);
        const sens = sensitivity(cmd);
        if (sens > 0) {
            const daysToCross = (c.crossingMs - t) / DAY;
            const growth = Math.max(0.4, 1 - daysToCross / o.windowDays);
            const strength = c.ampPeak * (0.6 + 0.9 * growth) * (0.7 + 0.6 * sens);
            if (rng() < o.detectBaseProb * sens) {
                dets.push(mkDet(c.lonFeat + (rng() - 0.5) * 4, c.lat + (rng() - 0.5) * 4, strength));
            }
        }

        const dcmd = wrap180(decoyLon - L0);
        if (sensitivity(dcmd) > 0 && rng() < 0.7) {
            dets.push(mkDet(decoyLon + (rng() - 0.5) * 5, 22 + (rng() - 0.5) * 4, 1.5 + rng() * 0.5));
        }

        frames.push({ timestamp: new Date(t).toISOString(), L0, dets });
    }
    return { frames, truth: c };
}

/**
 * Evaluate the detector+tracker against ground truth.
 * @param {object[]} frames  time-ordered {timestamp, L0, dets[]}
 * @param {object[]} truth   cases with crossingMs (+ lonFeat/carringtonLon, lat)
 * @returns metrics + per-case detail
 */
export function runBacktest(frames, truth, opts = {}) {
    const o = { ...BACKTEST, ...opts };
    const tracks = buildTracksFromFrames(frames);

    const matched = new Set();
    const perCase = truth.map((c) => {
        const truthLon = c.lonFeat ?? c.carringtonLon;
        const truthLat = c.lat ?? c.carringtonLat;
        const crossingMs = c.crossingMs ?? Date.parse(c.eastLimbCrossingUTC);

        // Tracks whose mean position matches this region.
        const hits = tracks.filter((t) =>
            lonSep(t.lon, truthLon) <= o.matchLonDeg && Math.abs(t.lat - truthLat) <= o.matchLatDeg);

        // Earliest far-side detection across matching tracks, before crossing.
        let firstMs = Infinity, matchedTrack = null;
        for (const t of hits) {
            for (const p of t.points) {
                const pMs = Date.parse(p.t);
                const cmd = wrap180(p.lon - frameL0At(frames, p.t));
                if (Math.abs(cmd) > 90 && pMs <= crossingMs && pMs < firstMs) {
                    firstMs = pMs; matchedTrack = t;
                }
            }
        }
        const detected = matchedTrack != null && Number.isFinite(firstMs);
        if (detected) matched.add(matchedTrack.id);

        // ETA accuracy: predicted crossing from the first-detection frame.
        let etaErrorDays = null, predictedCrossingUTC = null;
        if (detected) {
            const L0first = frameL0At(frames, new Date(firstMs).toISOString());
            const eta = emergenceETA(truthLon, L0first);
            const predMs = firstMs + eta.days * DAY;
            predictedCrossingUTC = new Date(predMs).toISOString();
            etaErrorDays = (predMs - crossingMs) / DAY;
        }

        return {
            id: c.id, label: c.label, noaaRegion: c.noaaRegion ?? null,
            detected,
            leadDays: detected ? (crossingMs - firstMs) / DAY : null,
            firstDetectedUTC: detected ? new Date(firstMs).toISOString() : null,
            crossingUTC: new Date(crossingMs).toISOString(),
            predictedCrossingUTC, etaErrorDays,
            matchedTrackId: matchedTrack?.id ?? null,
        };
    });

    // False alarms: alert-worthy tracks that matched no truth region.
    const alertWorthy = tracks.filter((t) =>
        t.latestStrength >= o.minAlertStrength && Math.abs(t.cmd) > 90);
    const falseTracks = alertWorthy.filter((t) => !matched.has(t.id));

    const detectedCases = perCase.filter((c) => c.detected);
    const spanDays = frames.length
        ? (Date.parse(frames[frames.length - 1].timestamp) - Date.parse(frames[0].timestamp)) / DAY
        : 0;

    return {
        nTruth: truth.length,
        nDetected: detectedCases.length,
        detectionRate: truth.length ? detectedCases.length / truth.length : 0,
        medianLeadDays: median(detectedCases.map((c) => c.leadDays)),
        meanEtaErrorDays: detectedCases.length
            ? detectedCases.reduce((a, c) => a + Math.abs(c.etaErrorDays ?? 0), 0) / detectedCases.length
            : null,
        totalTracks: tracks.length,
        alertWorthyTracks: alertWorthy.length,
        falseAlarms: falseTracks.length,
        falseAlarmRate: alertWorthy.length ? falseTracks.length / alertWorthy.length : 0,
        falseAlarmsPerWeek: spanDays > 0 ? falseTracks.length / (spanDays / 7) : 0,
        spanDays,
        perCase,
    };
}

/** L0 at the frame nearest a timestamp (frames carry their own L0). */
function frameL0At(frames, iso) {
    const ms = Date.parse(iso);
    let best = frames[0], bestGap = Infinity;
    for (const f of frames) {
        const g = Math.abs(Date.parse(f.timestamp) - ms);
        if (g < bestGap) { bestGap = g; best = f; }
    }
    return best?.L0 ?? carringtonL0(new Date(ms)).L0;
}

/**
 * Aggregate per-case backtest segments into one report. Each segment is an
 * independent window ({frames, truth}) — synthetic now, or real archive slices
 * (one per known emergence) later.
 */
export function aggregateBacktest(segments, opts = {}) {
    const perCase = [];
    let falseAlarms = 0, alertWorthyTracks = 0, totalTracks = 0, totalFrames = 0, spanDays = 0;

    for (const seg of segments) {
        const r = runBacktest(seg.frames, [seg.truth], opts);
        perCase.push(r.perCase[0]);
        falseAlarms += r.falseAlarms;
        alertWorthyTracks += r.alertWorthyTracks;
        totalTracks += r.totalTracks;
        totalFrames += seg.frames.length;
        spanDays += r.spanDays;
    }

    const detected = perCase.filter((c) => c.detected);
    return {
        nTruth: perCase.length,
        nDetected: detected.length,
        detectionRate: perCase.length ? detected.length / perCase.length : 0,
        medianLeadDays: median(detected.map((c) => c.leadDays)),
        meanEtaErrorDays: detected.length
            ? detected.reduce((a, c) => a + Math.abs(c.etaErrorDays ?? 0), 0) / detected.length
            : null,
        totalTracks, alertWorthyTracks, falseAlarms,
        falseAlarmRate: alertWorthyTracks ? falseAlarms / alertWorthyTracks : 0,
        falseAlarmsPerWeek: spanDays > 0 ? falseAlarms / (spanDays / 7) : 0,
        spanDays, frames: totalFrames,
        perCase,
    };
}

/** Convenience: run the demo backtest over the canonical validation cases. */
export function runSyntheticBacktest(opts = {}) {
    const segments = VALIDATION_CASES.map((c) => buildCaseWindow(c, opts));
    return { ...aggregateBacktest(segments, opts), synthetic: true };
}
