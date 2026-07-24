/**
 * verdict.js — shielding-state classifier for the Shielding Lab LIVE mode.
 *
 * PURE module (no DOM, no fetch, no ambient time — the engine feeds it the
 * sim clock). Node-tested by tests/shielding-verdict.mjs.
 *
 * Per solve the engine hands over values the WASM core already exports and
 * gets back an operator verdict:
 *
 *   UNDERSHIELDING  E_pen ≥ +under_e AND S < under_s   (R2 lagging — the
 *                   high-latitude field is leaking equatorward)
 *   OVERSHIELDING   E_pen ≤ over_e AND S > over_s      (R2 overshoot after
 *                   the driver drops; thresholds asymmetric because
 *                   overshielding signatures are weaker)
 *   SHIELDED        otherwise — "quiet" below quiet_cpcp kV CPCP,
 *                   "driven, shielded" above
 *   DATA GAP        staleness override — wins immediately over everything
 *
 * Anti-flapping: a state must hold for `persistenceSolves` consecutive
 * solves to be entered, and after any change a `dwellS` dwell blocks the
 * next change (DATA GAP is exempt both ways — honesty beats hysteresis).
 *
 * Shielding fraction S:
 *   parameterized R2:  S = I_R2 / (α · I_R1), α read from the kernel
 *                      (shl_r2_alpha — never hardcoded here)
 *   drift-physics R2:  S = (I_R2/I_R1) / median₆ₕ(I_R2/I_R1) — α is not
 *                      imposed in that mode, so "keeping pace" is measured
 *                      against the trailing quiet-time ratio instead
 *
 * Severity tiers are CALIBRATED, not asserted: the committed config
 * (data/shielding-verdict-config.json, baked by
 * scripts/calibrate-shielding-verdict.mjs from the St. Patrick's 2015
 * replay) carries the 75/90/98th-percentile |E_pen| tiers and refined
 * state thresholds; defaults below are only the cold-start fallback.
 * Regenerate the config when the Gannon replay bundle bakes.
 */

export const DEFAULT_CONFIG = {
    thresholds: {
        under_e_mvpm: 0.2,     // E_pen eastward ≥ this …
        under_s: 0.85,         // … AND S below this → UNDERSHIELDING
        over_e_mvpm: -0.15,    // E_pen ≤ this …
        over_s: 1.05,          // … AND S above this → OVERSHIELDING
        quiet_cpcp_kv: 40,     // SHIELDED sub-label boundary
    },
    tiers: {                   // |E_pen| mV/m — replaced by calibration
        watch_mvpm: 0.15,
        moderate_mvpm: 0.3,
        strong_mvpm: 0.6,
    },
    saps: { active_ms: 400, strong_ms: 900, sustain_s: 300 },
    drift_quiet_ratio: 0.8,    // cold-start seed for the 6 h median (≈ α)
    persistence_solves: 3,
    dwell_s: 300,
    eta_floor_mvpm: 0.05,      // |E_uns| below this → η undefined
    trend_window_s: 600,
};

/** Deep-merge a (possibly partial) calibration config over the defaults. */
export function mergeConfig(partial) {
    const cfg = structuredClone(DEFAULT_CONFIG);
    if (!partial || typeof partial !== 'object') return cfg;
    for (const k of ['thresholds', 'tiers', 'saps']) {
        Object.assign(cfg[k], partial[k] || {});
    }
    for (const k of ['drift_quiet_ratio', 'persistence_solves', 'dwell_s', 'eta_floor_mvpm', 'trend_window_s']) {
        if (Number.isFinite(partial[k])) cfg[k] = partial[k];
    }
    return cfg;
}

/**
 * Shielding-fraction tracker. Parameterized mode divides by α·I_R1;
 * drift mode normalizes the raw ratio by its trailing 6 h median
 * (seeded with the long-run quiet value while the buffer is cold).
 */
export function createShieldingFraction({ mode, alpha, seedRatio = DEFAULT_CONFIG.drift_quiet_ratio }) {
    const buf = [];                 // {t, ratio} — 6 h trailing, drift mode
    const WINDOW_S = 6 * 3600;
    return {
        update(tS, r1Ma, r2Ma) {
            if (!(r1Ma > 1e-3)) return null;
            const ratio = r2Ma / r1Ma;
            if (mode !== 'drift') return alpha > 0 ? ratio / alpha : null;
            buf.push({ t: tS, ratio });
            while (buf.length && buf[0].t < tS - WINDOW_S) buf.shift();
            const sorted = buf.map((b) => b.ratio).sort((a, b) => a - b);
            // Blend toward the measured median as the buffer warms (1 h in).
            const median = sorted.length
                ? sorted[Math.floor(sorted.length / 2)] : seedRatio;
            const warm = Math.min(buf.length / 360, 1);
            const ref = seedRatio * (1 - warm) + median * warm;
            return ref > 1e-3 ? ratio / ref : null;
        },
    };
}

export const STATES = ['SHIELDED', 'UNDERSHIELDING', 'OVERSHIELDING', 'DATA GAP'];

export function createClassifier(config = {}) {
    const cfg = mergeConfig(config);
    let state = 'SHIELDED';
    let stateSinceS = null;
    let lastChangeS = -Infinity;
    let candidate = null;
    let candidateCount = 0;
    const trendBuf = [];            // {t, absE}
    let sapsAboveSinceS = null;     // continuous > active_ms since …
    let sapsStrongSinceS = null;

    function rawState({ penE, s, stale }) {
        if (stale) return 'DATA GAP';
        const th = cfg.thresholds;
        if (s != null && penE >= th.under_e_mvpm && s < th.under_s) return 'UNDERSHIELDING';
        if (s != null && penE <= th.over_e_mvpm && s > th.over_s) return 'OVERSHIELDING';
        return 'SHIELDED';
    }

    return {
        get config() { return cfg; },

        /**
         * One solve. `tS` sim-seconds (monotonic), `penE`/`penEUns` mV/m,
         * `s` shielding fraction (null when undefined), `cpcpKv`,
         * `sapsMs` westward jet peak, `stale` from the live driver ladder.
         */
        update({ tS, penE, penEUns, s, cpcpKv, sapsMs = 0, stale = false }) {
            const want = rawState({ penE, s, stale });

            if (want === 'DATA GAP') {
                // Honesty overrides hysteresis — enter immediately.
                if (state !== 'DATA GAP') { state = 'DATA GAP'; stateSinceS = tS; lastChangeS = tS; }
                candidate = null; candidateCount = 0;
            } else if (want !== state) {
                if (want === candidate) candidateCount++;
                else { candidate = want; candidateCount = 1; }
                const dwellOk = state === 'DATA GAP' || tS - lastChangeS >= cfg.dwell_s;
                if (candidateCount >= cfg.persistence_solves && dwellOk) {
                    state = want; stateSinceS = tS; lastChangeS = tS;
                    candidate = null; candidateCount = 0;
                }
            } else {
                candidate = null; candidateCount = 0;
            }
            if (stateSinceS == null) stateSinceS = tS;

            // |E_pen| trend over the last trend_window_s.
            const absE = Math.abs(penE);
            trendBuf.push({ t: tS, absE });
            while (trendBuf.length && trendBuf[0].t < tS - cfg.trend_window_s) trendBuf.shift();
            let trend = 'flat';
            if (trendBuf.length >= 2) {
                const d = absE - trendBuf[0].absE;
                if (d > 0.02) trend = 'rising';
                else if (d < -0.02) trend = 'falling';
            }

            // SAPS chip: sustained thresholds (Foster & Vo climatology).
            if (sapsMs > cfg.saps.active_ms) { sapsAboveSinceS ??= tS; }
            else sapsAboveSinceS = null;
            if (sapsMs > cfg.saps.strong_ms) { sapsStrongSinceS ??= tS; }
            else sapsStrongSinceS = null;
            let saps = 'off';
            if (sapsStrongSinceS != null && tS - sapsStrongSinceS >= cfg.saps.sustain_s) saps = 'strong';
            else if (sapsAboveSinceS != null && tS - sapsAboveSinceS >= cfg.saps.sustain_s) saps = 'active';

            // Severity from the calibrated |E_pen| tiers.
            let severity = null;
            if (state === 'UNDERSHIELDING' || state === 'OVERSHIELDING') {
                if (absE >= cfg.tiers.strong_mvpm) severity = 'strong';
                else if (absE >= cfg.tiers.moderate_mvpm) severity = 'moderate';
                else if (absE >= cfg.tiers.watch_mvpm) severity = 'watch';
            }

            // Shielding efficiency η — undefined near a zero reference.
            const eta = Math.abs(penEUns) > cfg.eta_floor_mvpm ? 1 - penE / penEUns : null;

            let subLabel = null;
            if (state === 'SHIELDED') {
                subLabel = cpcpKv < cfg.thresholds.quiet_cpcp_kv ? 'quiet' : 'driven, shielded';
            }

            return {
                state, subLabel, severity, trend, saps, eta,
                sinceS: tS - stateSinceS,
                pendingState: candidate,
            };
        },
    };
}

/** Plain-language operator line per state (the card's impact sentence). */
export const IMPACT_COPY = {
    'UNDERSHIELDING': 'High-latitude electric field is leaking equatorward — elevated risk of mid/low-latitude GNSS degradation and post-sunset spread-F.',
    'OVERSHIELDING': 'Residual Region-2 current has reversed the low-latitude electric field — expect westward flow surges and dusk-sector disturbance.',
    'SHIELDED:driven, shielded': 'Region-2 shielding is keeping pace with the solar wind driver.',
    'SHIELDED:quiet': 'Quiet driving — nominal convection.',
    'DATA GAP': 'Real-time feed interrupted — nowcast degraded. Showing last known state.',
};

export function impactSentence(state, subLabel) {
    return IMPACT_COPY[subLabel ? `${state}:${subLabel}` : state]
        || IMPACT_COPY[state] || '';
}
