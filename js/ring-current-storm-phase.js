/**
 * Storm-phase auto-detector + Dessler–Parker–Sckopke energy ledger.
 *
 * Classifies the CURRENT geomagnetic storm phase from the model Dst/Dst*
 * series (feed state.series.model rows: {t, dst, dstStar}) and integrates
 * the ring-current energy budget over the detected storm — turning the sim
 * from a nowcast display into an event analyzer:
 *
 *   quiet     — no significant ring current in the window
 *   initial   — positive Dst excursion (magnetopause compression: an SSC /
 *               initial phase reads as +ΔDst before injection wins)
 *   main      — Dst(*) falling hard: injection outrunning decay
 *   recovery  — past the minimum, decay draining the ring; a log-linear fit
 *               over the post-minimum tail yields the observed recovery τ
 *
 * Energy ledger (DPS: W = |Dst*| · DPS_J_PER_NT):
 *   wNowJ, wPeakJ (at the Dst* minimum), shedJ = peak − now (recovery loss),
 *   builtJ = peak − onset level (main-phase injection net of decay).
 *
 * Pure functions, no DOM/fetch/clock — node-tested by
 * tests/ring-current-storm-phase.mjs.
 */

import { DPS_J_PER_NT } from './ring-current-model.js';

const MAIN_SLOPE_NT_H = -3;     // sustained fall steeper than this = main phase
const STORM_NT        = -30;    // |Dst| beyond this counts as a storm
const INITIAL_NT      = +12;    // positive excursion = compression/initial
const RECOVER_FRAC    = 0.10;   // must rise ≥10% off the minimum to be recovery

/** Least-squares slope (nT/h) of {t(ms), v} pairs; null if degenerate. */
function slopePerHour(pts) {
    const n = pts.length;
    if (n < 2) return null;
    let st = 0, sv = 0, stt = 0, stv = 0;
    for (const p of pts) {
        const th = p.t / 3.6e6;
        st += th; sv += p.v; stt += th * th; stv += th * p.v;
    }
    const d = n * stt - st * st;
    return d !== 0 ? (n * stv - st * sv) / d : null;
}

/**
 * @param {Array<{t:number, dst:number, dstStar?:number}>} model  ascending
 * @param {number} nowMs
 * @returns {null | {
 *   phase: 'quiet'|'initial'|'main'|'recovery',
 *   dstNow: number, minDst: number, minT: number, onsetT: number|null,
 *   recoveryTauH: number|null,
 *   ledger: { wNowJ, wPeakJ, shedJ, builtJ } | null,
 * }}
 */
export function detectStormPhase(model, nowMs) {
    if (!Array.isArray(model) || model.length < 4) return null;
    const win = model.filter(p => Number.isFinite(p.dst) && p.t <= nowMs + 1);
    if (win.length < 4) return null;
    const star = (p) => Number.isFinite(p.dstStar) ? p.dstStar : p.dst;
    const last = win[win.length - 1];
    const dstNow = last.dst;

    // Window minimum (the storm peak).
    let iMin = 0;
    for (let i = 1; i < win.length; i++) if (win[i].dst < win[iMin].dst) iMin = i;
    const minDst = win[iMin].dst, minT = win[iMin].t;

    // Onset: last upward crossing of STORM_NT before the minimum.
    let onsetT = null;
    for (let i = iMin; i > 0; i--) {
        if (win[i].dst <= STORM_NT && win[i - 1].dst > STORM_NT) { onsetT = win[i].t; break; }
    }

    // Recent slope (last 2 h).
    const recent = win.filter(p => p.t >= last.t - 2 * 3.6e6)
        .map(p => ({ t: p.t, v: p.dst }));
    const slope = slopePerHour(recent);

    // Recovery τ: log-linear fit of |Dst*| over the post-minimum tail
    // (needs ≥ 2 h past the minimum and a genuinely decaying ring).
    let recoveryTauH = null;
    if (last.t - minT >= 2 * 3.6e6 && minDst <= STORM_NT) {
        const tail = win.filter(p => p.t >= minT && star(p) < -5)
            .map(p => ({ t: p.t, v: Math.log(-star(p)) }));
        const s = slopePerHour(tail);
        if (s != null && s < -1e-3) recoveryTauH = -1 / s;
    }

    // Phase decision, most-specific first.
    let phase;
    if (dstNow >= INITIAL_NT) {
        phase = 'initial';
    } else if (dstNow <= STORM_NT && slope != null && slope <= MAIN_SLOPE_NT_H) {
        phase = 'main';
    } else if (minDst <= STORM_NT && last.t > minT
               && (dstNow - minDst) >= RECOVER_FRAC * Math.abs(minDst)) {
        phase = 'recovery';
    } else if (dstNow <= STORM_NT) {
        // Deep but neither falling hard nor clearly off the minimum yet —
        // call it main (the min may BE now).
        phase = 'main';
    } else {
        phase = 'quiet';
    }

    // DPS energy ledger over the detected storm.
    let ledger = null;
    if (minDst <= STORM_NT) {
        const starNow = star(last), starMin = star(win[iMin]);
        const onsetP = onsetT != null ? win.find(p => p.t === onsetT) : null;
        const wOnset = onsetP ? Math.abs(Math.min(0, star(onsetP))) * DPS_J_PER_NT : 0;
        const wPeakJ = Math.abs(Math.min(0, starMin)) * DPS_J_PER_NT;
        const wNowJ  = Math.abs(Math.min(0, starNow)) * DPS_J_PER_NT;
        ledger = {
            wNowJ, wPeakJ,
            shedJ:  Math.max(0, wPeakJ - wNowJ),
            builtJ: Math.max(0, wPeakJ - wOnset),
        };
    }

    return { phase, dstNow, minDst, minT, onsetT, recoveryTauH, ledger };
}

/** Compact human line for the chart head, e.g.
 *  "MAIN · onset 03:20 · min −85 nT" / "RECOVERY · τ 8.3 h · shed 44%". */
export function formatStormPhase(r) {
    if (!r) return null;
    const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
    switch (r.phase) {
        case 'quiet':   return 'quiet';
        case 'initial': return `INITIAL · compression +${r.dstNow.toFixed(0)} nT`;
        case 'main':    return `MAIN${r.onsetT ? ` · onset ${hhmm(r.onsetT)}` : ''}` +
                               ` · min ${r.minDst.toFixed(0)} nT`;
        case 'recovery': {
            const shed = r.ledger && r.ledger.wPeakJ > 0
                ? ` · shed ${Math.round(100 * r.ledger.shedJ / r.ledger.wPeakJ)}%` : '';
            const tau = r.recoveryTauH ? ` · τ ${r.recoveryTauH.toFixed(1)} h` : '';
            return `RECOVERY · min ${r.minDst.toFixed(0)} nT${tau}${shed}`;
        }
        default: return null;
    }
}
