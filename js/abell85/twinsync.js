// twinsync.js — merger-relative time (τ) synchronization for the parallel
// dual-simulation observatory (merger-twins.html).
//
// The two target systems are the same evolutionary story at different epochs:
// Abell 402-BCG's coalescence lies ~2.4 Gyr in its future, Holm 15A's ~6.9 Gyr
// in its past. Aligning both timelines on τ = t − t_coalescence puts identical
// evolutionary phases at identical τ, while each lane keeps its own absolute
// timestamp. On the shared τ axis, each system's "today" (absolute t = 0)
// becomes a marker — the same film at two playback positions.
//
// DOM-free; unit-tested in tests/abell85-physics.mjs.

/** τ of an absolute epoch t within a history (requires a merger event). */
export function tauOf(history, t) {
    return t - history.events.merger;
}

/** Absolute epoch of a shared τ inside a history, clamped to its sample span. */
export function tAt(history, tau) {
    const t = tau + history.events.merger;
    const S = history.samples;
    return Math.min(Math.max(t, S[0].t), S[S.length - 1].t);
}

/**
 * Merged adaptive τ axis: the sorted, deduplicated union of both systems'
 * sample times expressed in τ. Scrubbing by index into this array inherits
 * the adaptive sampling of BOTH histories — dense wherever either system is
 * doing something interesting.
 */
export function buildTauAxis(histories) {
    const taus = [];
    for (const h of histories) {
        if (h.events.merger === undefined) continue;   // stalled: cannot τ-sync
        const m = h.events.merger;
        for (const s of h.samples) taus.push(s.t - m);
    }
    taus.sort((a, b) => a - b);
    const merged = [];
    let last = -Infinity;
    for (const v of taus) {
        if (v - last > 1e-9) { merged.push(v); last = v; }
    }
    return merged;
}

/**
 * Story events of one history in τ coordinates, for the shared timeline's
 * per-lane tick rows. Includes the system's "today" (absolute t = 0).
 */
export function eventsTau(history) {
    const m = history.events.merger;
    if (m === undefined) return [];
    const ev = [];
    if (history.events.binaryForms !== undefined) {
        ev.push({ tau: history.events.binaryForms - m, label: 'binary forms' });
    }
    if (history.events.gwTakeover !== undefined) {
        ev.push({ tau: history.events.gwTakeover - m, label: 'GW takeover' });
    }
    ev.push({ tau: 0, label: 'coalescence' });
    ev.push({ tau: -m, label: 'today', today: true });
    return ev.sort((a, b) => a.tau - b.tau);
}

/** Binary-search the merged axis for the index nearest a given τ. */
export function indexOfTau(axis, tau) {
    if (tau <= axis[0]) return 0;
    if (tau >= axis[axis.length - 1]) return axis.length - 1;
    let lo = 0, hi = axis.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (axis[mid] <= tau) lo = mid; else hi = mid;
    }
    return (tau - axis[lo] < axis[hi] - tau) ? lo : hi;
}
