/**
 * Pure time-selection helpers for dated NASA Earth-observation imagery.
 *
 * GIBS products in EarthView are daily composites with a per-product publish
 * delay (`timeOffset` in earth-obs-feed.js). The shared time bus may point
 * anywhere from -7 d to +14 d, but an observation layer must never pretend a
 * future image exists. This module resolves the requested instant to one UTC
 * observation day and records whether it is replaying history or clamped to
 * the latest published frame.
 */

export const OBS_DAY_MS = 86_400_000;

export function utcDayStart(ms) {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function utcDayKey(ms) {
    return new Date(utcDayStart(ms)).toISOString().slice(0, 10);
}

/**
 * @returns {{key:string,targetMs:number,requestedMs:number,latestMs:number,
 *            mode:'latest'|'replay'|'clamped-future'}}
 */
export function resolveObservationTime({
    simTimeMs,
    nowMs = Date.now(),
    timeOffsetDays = 0,
} = {}) {
    const requestedMs = Number.isFinite(simTimeMs) ? simTimeMs : nowMs;
    const delayDays = Math.max(0, Number(timeOffsetDays) || 0);
    const latestMs = utcDayStart(nowMs - delayDays * OBS_DAY_MS);
    const requestedDayMs = utcDayStart(requestedMs);
    const targetMs = Math.min(requestedDayMs, latestMs);
    const mode = requestedMs > nowMs + 60_000
        ? 'clamped-future'
        : targetMs < latestMs ? 'replay' : 'latest';
    return {
        key: utcDayKey(targetMs),
        targetMs,
        requestedMs,
        latestMs,
        mode,
    };
}

export default resolveObservationTime;
