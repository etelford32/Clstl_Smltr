/**
 * sun-flux-rope.js — sun.html's consumer of the ONE shared flux-rope
 * forecast provider (js/flux-rope-forecast.js).
 *
 * This module computes NO physics of its own. The live pipeline —
 * DONKI catalog → compounding-train selection → seeded joint WASM
 * ensemble (§16 interaction ON) → particle-filter conditioning on live
 * DSCOVR/ACE Bz — lives entirely in the shared provider; re-implementing
 * any part of it per consumer is forbidden (CLAUDE.md flux-rope row).
 *
 * What this module adds for sun.html:
 *
 *   startFluxRopeProvider()  — the page's ONE provider run loop. Publishes
 *       every result (live, idle, or {failed}) as window.__fluxRopeForecast
 *       plus a 'flux-rope-forecast' CustomEvent — the exact convention
 *       js/flux-rope-dashboard.js established, so the Sun Watch dock's
 *       Forecast tab, the scrubber event track, and any future consumer on
 *       this page all follow the ONE published result. Fail-quiet is the
 *       caller's posture: a failed run publishes {failed, reason} (a broken
 *       feed must LOOK broken, never like a quiet sun) and retries on a
 *       short leash; a live run refreshes on the 15-min DONKI cadence.
 *       First run is DEFERRED a few seconds so the WASM fetch + 500-member
 *       ensemble never competes with the 3D sun's boot.
 *
 *   trainStateAt(fc, tMs)    — PURE probe: where is each modeled rope at
 *       instant tMs? Uses the provider's own kernel probes (apexKmAt on the
 *       live kernel instance — the oracle, never a re-derived kinematic),
 *       so the scrubber's "N CMEs in transit" readout states exactly what
 *       the ensemble engine models, not a second ballistic estimate.
 *
 *   scrubMarks({timeline, summary}) — PURE assembly of the scrubber event
 *       track's draw list: Sun Watch ledger events (flares / CMEs / SEP /
 *       GST — rows the dock already fetched; this module fetches nothing)
 *       plus the modeled arrival window (P10–P90 + median) from the
 *       provider summary. Marks carry epoch-ms only — the DOM side owns
 *       the time→x mapping because the scrub axis is index-spaced.
 *
 *   The COMPOUNDING MEASUREMENT (§16 counterfactual) and its helpers used
 *       to live here; they are now the SHARED js/flux-rope-compounding.js
 *       (the daily validation cron locks + scores the same measurement
 *       against L1 outcomes). Re-exported below so this page and its
 *       gate keep one import surface.
 *
 * The pure helpers are node-gated by tests/sun-flux-rope.mjs against the
 * REAL committed WASM (no network), following tests/flux-rope-forecast.mjs.
 */

import { computeFluxRopeForecast } from './flux-rope-forecast.js';
import { L1_OBSERVER } from './flux-rope-kernel.js';
import { measureCompounding, observedMinBz } from './flux-rope-compounding.js';

// One import surface for the page + tests/sun-flux-rope.mjs — the
// implementations live in the SHARED module the validation cron also runs.
export {
    measureCompounding, observedMinBz, pBelowFromMinBz, medianFinite,
    ropeCrossingH, arrivalQuantiles,
} from './flux-rope-compounding.js';

const AU_KM = 1.495978707e8;

export const REFRESH_MS = 15 * 60e3;   // live cadence (CDN-cached, cheap)
export const RETRY_MS = 2 * 60e3;      // failed-run leash
export const FIRST_RUN_DELAY_MS = 3000;

/**
 * Per-rope transit state at epoch-ms `tMs`, from the provider's live kernel
 * instance. Returns null for anything that is not a live forecast (null,
 * idle, failed, or a forecast without kernel/preset). "Arrived" means the
 * modeled apex has reached the L1 observer radius — the same surface every
 * other consumer probes.
 */
export function trainStateAt(fc, tMs) {
    if (!fc || fc.idle || fc.failed || !fc.kernel || !fc.preset?.ropes?.length
        || !Number.isFinite(fc.launchMs) || !Number.isFinite(tMs)) return null;
    const l1Km = L1_OBSERVER.rAu * AU_KM;
    const tS = (tMs - fc.launchMs) / 1000;
    const ropes = fc.preset.ropes.map((r, i) => {
        const launched = tS > (r.launchOffsetS ?? 0);
        const apexKm = launched ? fc.kernel.apexKmAt(i, tS) : 0;
        return {
            i,
            launched,
            apexAu: launched ? apexKm / AU_KM : 0,
            arrived: launched && apexKm >= l1Km,
        };
    });
    let launched = 0, arrived = 0;
    for (const r of ropes) { if (r.launched) launched++; if (r.arrived) arrived++; }
    return { ropes, launched, arrived, inTransit: launched - arrived };
}

/** Ledger kinds that earn a tick on the scrubber's event track. */
const MARK_KINDS = new Set(['flare', 'cme', 'sep', 'gst']);

/**
 * Assemble the event-track draw list (pure). `timeline` is the Sun Watch
 * ledger (js/sun-watch-model.js buildTimeline rows: {t, kind, color, badge,
 * title, earth}); `summary` is a provider summary ({arrivalP10Ms/P50Ms/
 * P90Ms}) or null/absent. Marks come back time-ascending; rows without a
 * finite epoch or outside MARK_KINDS are dropped, never guessed at.
 */
export function scrubMarks({ timeline = [], summary = null } = {}) {
    const marks = (Array.isArray(timeline) ? timeline : [])
        .filter((ev) => Number.isFinite(ev?.t) && MARK_KINDS.has(ev.kind))
        .map((ev) => ({
            t: ev.t,
            kind: ev.kind,
            color: ev.color || '#ffaa44',
            label: ev.title || ev.kind,
            earth: ev.earth === true,
        }))
        .sort((a, b) => a.t - b.t);
    const band = Number.isFinite(summary?.arrivalP10Ms) && Number.isFinite(summary?.arrivalP90Ms)
        ? { t0: summary.arrivalP10Ms, t1: summary.arrivalP90Ms, t50: summary.arrivalP50Ms ?? null }
        : null;
    return { marks, band };
}

/**
 * Start the page's provider loop. Every outcome is published (live / idle /
 * {failed, reason}) so consumers can render honest states. Returns a
 * disposer handle. Options exist for tests (delayMs) — production callers
 * take the defaults.
 */
export function startFluxRopeProvider({ delayMs = FIRST_RUN_DELAY_MS } = {}) {
    let timer = 0;
    let running = false;
    let disposed = false;

    async function run() {
        if (running || disposed) return;
        running = true;
        let fc;
        let failed = false;
        try {
            fc = await computeFluxRopeForecast({});
            if (!fc.idle) {
                // The compounding measurement rides every live train run —
                // its failure degrades to "no measurement", never a failed
                // forecast. Single ropes honestly carry null.
                try {
                    fc.compounding = fc.train ? await measureCompounding(fc) : null;
                } catch (e) {
                    fc.compounding = null;
                    console.info('[sun] compounding counterfactual failed:', e?.message ?? e);
                }
                // Ground-truth hook: deepest L1 Bz observed inside the
                // forecast window so far (null until coverage exists).
                fc.observedL1 = observedMinBz(fc.rtsw, fc.launchMs,
                    Math.min(Date.now(), fc.launchMs + fc.grid.n * fc.grid.dtS * 1000));
            }
        } catch (e) {
            failed = true;
            fc = { idle: true, failed: true, reason: e?.message ?? String(e) };
            console.info('[sun] flux-rope provider run failed:', fc.reason);
        }
        try {
            window.__fluxRopeForecast = fc;
            window.dispatchEvent(new CustomEvent('flux-rope-forecast', { detail: fc }));
        } catch { /* consumers absent — publishing is best-effort */ }
        running = false;
        if (!disposed) timer = setTimeout(run, failed ? RETRY_MS : REFRESH_MS);
    }

    timer = setTimeout(run, delayMs);
    return {
        refresh: run,
        dispose() { disposed = true; clearTimeout(timer); },
    };
}
