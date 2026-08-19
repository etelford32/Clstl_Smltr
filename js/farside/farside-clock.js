/**
 * js/farside/farside-clock.js — the simulation clock for Far-Side Watch.
 *
 * Far-Side Watch is a forecast about ROTATION: a region sits at a fixed
 * Carrington longitude and the Sun carries it toward the east limb at the
 * synodic rate. The page used to state that forecast as a number ("~10.1 d")
 * next to a globe spinning at an admittedly "illustrative" rate — the one
 * thing a viewer could actually watch was the one thing that wasn't the
 * physics. This module makes simulated time the single source of truth so the
 * drawn rotation IS the forecast: advance the clock and every view (field
 * map, globe, watch list) re-derives from the same L0(t).
 *
 * WHAT MOVES AND WHAT DOES NOT — the invariant the whole page rests on:
 *
 *   · Active regions are PINNED in Carrington longitude. The co-rotating
 *     frame is defined so that a fixed region keeps a fixed longitude; that
 *     is the entire reason a far-side detection can be projected forward.
 *   · The sub-Earth point L0 SWEEPS past them at SYNODIC_DEG_PER_DAY.
 *
 * So scrubbing must move L0 and must NOT move the regions. Any future edit
 * that re-anchors planted regions to the scrubbed epoch instead of the
 * session anchor breaks the physics silently: ETAs would stop counting down
 * and regions would never reach the limb. tests/farside-sim.mjs pins this.
 *
 * The window is [−7 d, +one full synodic rotation]. The forward half is
 * exactly SYNODIC_PERIOD_DAYS on purpose: emergenceETA() returns a forward
 * angular distance mod 360, so its lead time can never exceed one rotation —
 * which means EVERY region on the watch list is guaranteed to cross the east
 * limb somewhere on this scrubber. That is what makes the emergence ticks a
 * complete index of the forecast rather than a sample of it.
 *
 * Pure and dependency-free apart from the geometry helpers (no DOM, no
 * ambient time — every entry point takes its instants explicitly), so it is
 * node-testable and reusable by the Sun / Space-Weather engines.
 */

import { carringtonL0, emergenceETA, SYNODIC_PERIOD_DAYS } from './carrington.js';

const DAY_MS = 86400000;

/** Scrub window, in days relative to the session anchor. */
export const SIM_WINDOW = Object.freeze({
    backDays: 7,
    forwardDays: SYNODIC_PERIOD_DAYS,   // ≈ 27.2753 — one full rotation
});

/** Playback speeds, in simulated days per wall-clock second. */
export const SIM_SPEEDS = Object.freeze([
    { id: 'slow', label: '0.5 d/s', daysPerSec: 0.5 },
    { id: 'med', label: '2 d/s', daysPerSec: 2 },
    { id: 'fast', label: '8 d/s', daysPerSec: 8 },
]);

/** Total span of the scrubber, in days. */
export function simSpanDays() {
    return SIM_WINDOW.backDays + SIM_WINDOW.forwardDays;
}

/** Absolute [start, end] epoch bounds for a session anchored at `anchorMs`. */
export function simBounds(anchorMs) {
    return {
        startMs: anchorMs - SIM_WINDOW.backDays * DAY_MS,
        endMs: anchorMs + SIM_WINDOW.forwardDays * DAY_MS,
    };
}

/** Clamp an epoch into the scrub window. */
export function clampEpoch(epochMs, anchorMs) {
    const { startMs, endMs } = simBounds(anchorMs);
    return Math.min(endMs, Math.max(startMs, epochMs));
}

/** Epoch → scrubber position in [0,1]. */
export function epochToFraction(epochMs, anchorMs) {
    const { startMs, endMs } = simBounds(anchorMs);
    return (clampEpoch(epochMs, anchorMs) - startMs) / (endMs - startMs);
}

/** Scrubber position in [0,1] → epoch. */
export function fractionToEpoch(fraction, anchorMs) {
    const { startMs, endMs } = simBounds(anchorMs);
    const f = Math.min(1, Math.max(0, Number(fraction) || 0));
    return startMs + f * (endMs - startMs);
}

/**
 * Advance playback by `dtSeconds` of wall clock.
 *
 * Returns the next epoch and whether playback should stop. Reaching the end
 * of the window HALTS rather than looping: the scrubber is a forecast horizon,
 * and silently wrapping to seven days in the past would restate history as a
 * prediction.
 *
 * @returns {{ epochMs:number, ended:boolean }}
 */
export function advanceEpoch(epochMs, dtSeconds, daysPerSec, anchorMs) {
    const { endMs } = simBounds(anchorMs);
    const next = epochMs + (Number(dtSeconds) || 0) * (Number(daysPerSec) || 0) * DAY_MS;
    if (next >= endMs) return { epochMs: endMs, ended: true };
    return { epochMs: clampEpoch(next, anchorMs), ended: false };
}

/**
 * Human-facing state of the clock at `epochMs`.
 * `offsetDays` is signed relative to the anchor; `isNow` is true within the
 * half-hour either side, so the readout does not flicker "+0.0 d" vs "NOW".
 */
export function simStatus(epochMs, anchorMs) {
    const offsetDays = (epochMs - anchorMs) / DAY_MS;
    const { L0, B0 } = carringtonL0(new Date(epochMs));
    return {
        epochMs,
        offsetDays,
        isNow: Math.abs(offsetDays) < 1 / 48,
        L0,
        B0,
        iso: new Date(epochMs).toISOString(),
    };
}

/**
 * East-limb crossing markers for the scrubber, one per tracked region.
 *
 * The crossing instant comes from the SAME emergenceETA() the watch list
 * quotes, evaluated at the anchor — so a tick sits exactly where scrubbing to
 * it makes that region's ETA read zero. Computing it any other way would let
 * the ticks and the numbers disagree.
 *
 * @param {Array<{id:string,lon:number,strong?:boolean}>} tracks
 * @returns {Array<{id:string,epochMs:number,fraction:number,etaDays:number,strong:boolean}>}
 */
export function emergenceMarkers(tracks, anchorMs) {
    const { L0 } = carringtonL0(new Date(anchorMs));
    return (tracks || [])
        .map((t) => {
            const { days } = emergenceETA(t.lon, L0);
            const epochMs = anchorMs + days * DAY_MS;
            return {
                id: t.id,
                epochMs,
                fraction: epochToFraction(epochMs, anchorMs),
                etaDays: days,
                strong: !!t.strong,
            };
        })
        .sort((a, b) => a.epochMs - b.epochMs);
}
