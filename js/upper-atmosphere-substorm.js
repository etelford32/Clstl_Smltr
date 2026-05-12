/**
 * upper-atmosphere-substorm.js — magnetospheric substorm state machine
 * ═══════════════════════════════════════════════════════════════════════════
 * Drives the cascade visualisation through the canonical three-phase
 * substorm sequence:
 *
 *     IDLE  →  GROWTH  →  EXPANSION (onset)  →  RECOVERY  →  IDLE
 *
 * Phase descriptions (McPherron 1979; Akasofu 1964):
 *
 *   • Growth (30–90 min, real time)
 *       Sustained southward IMF reconnects on the dayside; flux is
 *       stripped and transferred to the magnetotail. Tail lobes
 *       inflate, current sheet thins. Auroral oval drifts equatorward
 *       by up to 5°. AE rises slowly. A quiet pre-onset arc forms near
 *       the equatorward edge of the oval.
 *
 *   • Expansion (5–30 min)
 *       Trigger: near-Earth neutral line forms when current sheet
 *       thins below threshold (or a northward-Bz turning relaxes the
 *       loaded tail). Reconnection releases stored energy:
 *         - Onset arc brightens and breaks up near 22–23 MLT.
 *         - Westward Traveling Surge (WTS) propagates westward at
 *           5–10 km/s in MLT.
 *         - Auroral bulge expands poleward by 5–15° (the "auroral
 *           leap"); oval briefly doubles in width near the onset MLT.
 *         - Substorm current wedge: strong R1-like westward
 *           electrojet at the onset MLT, closing through field-
 *           aligned currents to the magnetotail.
 *         - Bursty Bulk Flows (BBFs): earthward plasma jets from the
 *           neutral line at ~20 R⊕, carrying 10–100 keV particles to
 *           the inner magnetosphere.
 *
 *   • Recovery (60–180 min)
 *       Activity decays. Ring current builds via injected ions; AE
 *       returns to baseline. Oval contracts back toward pre-onset
 *       latitude.
 *
 * The controller is pure-functions — no Three.js, no DOM. The
 * cascade reads `tick()` every frame for the current `(phase,
 * progress, onsetMlt, wtsMlt, bulgeMag, bbfActivity)` and modulates
 * its existing geometries via shader uniforms. No per-frame
 * allocations.
 *
 * Two timing modes:
 *   • 'demo'      compressed ~30 s end-to-end — for the "Trigger"
 *                 button. Lets users walk through a substorm in a
 *                 single viewing.
 *   • 'realtime'  literal-minutes timing — for synchronisation with
 *                 live AE / ground-magnetometer data when the
 *                 SwpcFeed is wired up.
 *
 * Auto-trigger: the controller can subscribe to a substorm-index
 * stream (Akasofu ε accumulator + Kp suppression — see
 * solar-wind-magnetosphere.js); when the index crosses a threshold
 * during IDLE the controller transitions to GROWTH automatically.
 */

const PHASES = Object.freeze({
    IDLE:      'idle',
    GROWTH:    'growth',
    EXPANSION: 'expansion',
    RECOVERY:  'recovery',
});

// ── Phase durations (seconds) ──────────────────────────────────────────────
// Real-time values match observational climatology; demo values are
// compressed by ~60× so a "trigger substorm" walks through a full
// cycle in roughly 30 seconds — enough to read the storyline without
// losing the per-phase distinct timing ratios.
const DURATION_S = {
    realtime: { growth: 45 * 60, expansion: 12 * 60, recovery: 90 * 60 },
    demo:     { growth: 8,        expansion: 6,        recovery: 14 },
};

// ── Substorm-index trigger threshold ──────────────────────────────────────
// Output of solar-wind-magnetosphere.js:substormIndex() ranges 0..1.
// Climatology: substorms typically begin once the cumulative southward-
// Bz drive crosses ~0.55 with concurrent ε > 2×10¹¹ W. The exact
// number isn't sharp — we use 0.6 as a balanced threshold. Caller can
// override via setAutoTriggerThreshold().
const DEFAULT_AUTO_THRESHOLD = 0.6;

// Auto-trigger refractory period: never auto-trigger more often than
// this. Avoids retriggering during the GROWTH→EXPANSION transition
// (when the substorm index is still high but we're already injecting).
const AUTO_REFRACTORY_S = 60 * 60;   // 1 hour real-time

/**
 * @typedef {object} SubstormTick
 * @property {string} phase           one of PHASES
 * @property {number} progress        0..1 within current phase
 * @property {number} onsetMlt        MLT (0..24) of the onset arc
 * @property {number} onsetLatDeg     mag-lat where the onset is anchored
 * @property {number} wtsMlt          westward-traveling-surge head MLT
 *                                    (NaN outside expansion phase)
 * @property {number} bulgeMag        0..1 — poleward-leap intensity
 * @property {number} ovalShiftDeg    equatorward shift of the oval
 *                                    (positive = lower latitude)
 * @property {number} bbfActivity     0..1 — bursty-bulk-flow strength
 *                                    in the magnetotail
 * @property {number} aeProxy         AE-index proxy (nT, 0..2000)
 */

/**
 * One controller instance per cascade. Stateless on construction;
 * drives the state machine via update(dt).
 */
export class SubstormController {
    /**
     * @param {object} [opts]
     * @param {'demo'|'realtime'} [opts.mode='demo']
     * @param {number} [opts.autoThreshold]      override default 0.6
     * @param {boolean}[opts.autoEnabled=true]
     */
    constructor({
        mode = 'demo',
        autoThreshold = DEFAULT_AUTO_THRESHOLD,
        autoEnabled   = true,
    } = {}) {
        this.mode = mode === 'realtime' ? 'realtime' : 'demo';
        this._dur = DURATION_S[this.mode];
        this._autoThreshold = autoThreshold;
        this._autoEnabled   = autoEnabled;
        this._lastIndex     = 0;
        this._refractoryS   = 0;     // counts down after each trigger

        // State machine
        this._phase           = PHASES.IDLE;
        this._phaseElapsedS   = 0;
        this._phaseDurationS  = 0;

        // Onset geometry — sampled at trigger time so the visual is
        // stable through the run. MLT 22.5 (just dusk-of-midnight) is
        // the climatological onset peak; we add ±1 hr jitter so
        // repeated triggers don't render identical.
        this._onsetMlt    = 22.5;
        this._onsetLatDeg = 65;        // overridden at trigger from oval geometry

        // WTS travels westward at 5–10 km/s ionospheric → ~0.1–0.2
        // MLT/min. In demo mode we sweep ~6 MLT hours over the
        // expansion phase so the surge is clearly readable.
        this._wtsMltSpeed = (this.mode === 'demo')
            ? -8 / this._dur.expansion           // 8 MLT hr over the phase
            : -0.15;                              // ~9 km/s realtime

        // Last computed tick — also exposed via getTick() for UI seed.
        this._lastTick = this._buildTick(0);
    }

    // ── Public control ─────────────────────────────────────────────────────

    /**
     * Manually trigger a substorm. If already in a non-IDLE phase,
     * does nothing (substorms don't stack — one runs to completion).
     *
     * @param {object} [opts]
     * @param {number} [opts.onsetMlt]      override the onset MLT
     * @param {number} [opts.onsetLatDeg]   anchor latitude (mag-lat)
     */
    trigger(opts = {}) {
        if (this._phase !== PHASES.IDLE) return false;

        // Onset MLT: caller-specified or jittered around 22.5. Range:
        // most isolated substorms onset between 21–24 MLT, a smaller
        // population near 18 MLT (dusk).
        const onsetMlt = Number.isFinite(opts.onsetMlt)
            ? opts.onsetMlt
            : 22.5 + (Math.random() - 0.5) * 2;
        const onsetLatDeg = Number.isFinite(opts.onsetLatDeg)
            ? opts.onsetLatDeg
            : 66;

        this._onsetMlt    = ((onsetMlt % 24) + 24) % 24;
        this._onsetLatDeg = onsetLatDeg;

        this._phase           = PHASES.GROWTH;
        this._phaseElapsedS   = 0;
        this._phaseDurationS  = this._dur.growth;
        this._refractoryS     = AUTO_REFRACTORY_S;
        return true;
    }

    /** Force-end the current substorm and return to IDLE. */
    reset() {
        this._phase          = PHASES.IDLE;
        this._phaseElapsedS  = 0;
        this._phaseDurationS = 0;
    }

    setMode(mode) {
        this.mode = mode === 'realtime' ? 'realtime' : 'demo';
        this._dur = DURATION_S[this.mode];
        // Recompute WTS sweep so it still finishes at the end of the
        // expansion phase under the new timing.
        this._wtsMltSpeed = (this.mode === 'demo')
            ? -8 / this._dur.expansion
            : -0.15;
    }
    setAutoEnabled(v) { this._autoEnabled = !!v; }
    setAutoTriggerThreshold(t) {
        if (Number.isFinite(t)) this._autoThreshold = Math.max(0, Math.min(1, t));
    }

    /**
     * Push the latest substorm-index value (0..1) — when we're IDLE
     * and the index crosses the threshold, auto-trigger. The
     * refractory period prevents back-to-back triggers from a
     * sustained-storm tail.
     */
    setSubstormIndex(idx) {
        const v = Number.isFinite(idx) ? idx : 0;
        const crossing = (this._lastIndex < this._autoThreshold)
                      && (v >= this._autoThreshold);
        this._lastIndex = v;
        if (this._autoEnabled
            && this._phase === PHASES.IDLE
            && this._refractoryS <= 0
            && crossing) {
            this.trigger();
        }
    }

    // ── Per-frame ──────────────────────────────────────────────────────────

    /**
     * Advance the state machine by `dtSec`. Caller passes wall-clock
     * dt (i.e., from THREE.Clock); the controller decides whether the
     * mode treats that as compressed or literal.
     */
    update(dtSec) {
        const dt = Math.max(0, dtSec || 0);
        if (this._refractoryS > 0) this._refractoryS = Math.max(0, this._refractoryS - dt);
        if (this._phase === PHASES.IDLE) {
            this._lastTick = this._buildTick(0);
            return this._lastTick;
        }

        this._phaseElapsedS += dt;
        if (this._phaseElapsedS >= this._phaseDurationS) {
            // Transition to next phase.
            this._phaseElapsedS = 0;
            switch (this._phase) {
                case PHASES.GROWTH:
                    this._phase          = PHASES.EXPANSION;
                    this._phaseDurationS = this._dur.expansion;
                    break;
                case PHASES.EXPANSION:
                    this._phase          = PHASES.RECOVERY;
                    this._phaseDurationS = this._dur.recovery;
                    break;
                case PHASES.RECOVERY:
                default:
                    this._phase          = PHASES.IDLE;
                    this._phaseDurationS = 0;
                    break;
            }
        }
        const progress = this._phaseDurationS > 0
            ? Math.max(0, Math.min(1, this._phaseElapsedS / this._phaseDurationS))
            : 0;

        this._lastTick = this._buildTick(progress);
        return this._lastTick;
    }

    /** Latest tick (for UI seed without forcing a phase advance). */
    getTick() { return this._lastTick; }

    // ── State-derived modulators ──────────────────────────────────────────
    //
    // Each phase tunes the cascade's geometry uniforms differently.
    // Smooth transitions are important: an abrupt step from growth
    // values to expansion values would make the visualisation snap.
    // We use cubic / sin-shaped envelopes so progress animates feel
    // organic.

    _buildTick(progress) {
        const phase = this._phase;
        let onsetMlt    = this._onsetMlt;
        let onsetLatDeg = this._onsetLatDeg;
        let wtsMlt      = NaN;
        let bulgeMag    = 0;
        let ovalShiftDeg = 0;
        let bbfActivity  = 0;
        let aeProxy      = 0;

        if (phase === PHASES.GROWTH) {
            // Growth: linear-ish equatorward shift of the oval (up to
            // ~5° at end of phase). AE rises gently from 50 → 200 nT.
            ovalShiftDeg = 5 * progress;
            aeProxy      = 50 + 200 * progress;
            // No bulge / WTS / BBF in growth.
        } else if (phase === PHASES.EXPANSION) {
            // Expansion: oval still shifted (decaying slightly), bulge
            // rises sharply from 0 → 1 in the first 25 % of the phase
            // (the "leap"), then slowly contracts. WTS sweeps westward
            // throughout. BBF activity peaks early.
            ovalShiftDeg = 5 * (1 - 0.4 * progress);
            // Sharp poleward leap then exponential relaxation.
            const leapEnv = (progress < 0.25)
                ? _smoothstep(0, 0.25, progress)
                : Math.exp(-(progress - 0.25) / 0.45);
            bulgeMag = leapEnv;
            // Shift onset latitude slightly poleward as the bulge grows.
            onsetLatDeg = this._onsetLatDeg + 6 * leapEnv;

            // WTS: starts at onsetMlt and propagates westward.
            const dtPhase = progress * this._phaseDurationS;
            wtsMlt = this._onsetMlt + this._wtsMltSpeed * dtPhase;
            // Wrap into [0, 24).
            wtsMlt = ((wtsMlt % 24) + 24) % 24;

            // BBF activity: peaks at progress ~0.15 (the energetic
            // first injection), then decays.
            bbfActivity = Math.exp(-((progress - 0.15) ** 2) / 0.025);
            bbfActivity = Math.max(0, Math.min(1, bbfActivity));

            // AE classic substorm bay: rapid rise to 800–1500 nT,
            // then slow decay through the recovery.
            aeProxy = 250 + 1100 * leapEnv;
        } else if (phase === PHASES.RECOVERY) {
            // Recovery: bulge collapsed; oval drifts back to
            // pre-substorm latitude. AE decays exponentially.
            ovalShiftDeg = 3 * (1 - progress);
            bulgeMag     = 0.15 * (1 - progress);
            aeProxy      = 350 * Math.exp(-progress * 2);
            bbfActivity  = 0.05 * (1 - progress);
        } else {
            // IDLE — quiet baseline.
            aeProxy = 50;
        }

        return {
            phase,
            progress,
            onsetMlt,
            onsetLatDeg,
            wtsMlt,
            bulgeMag,
            ovalShiftDeg,
            bbfActivity,
            aeProxy,
        };
    }

    // ── Convenience labels ────────────────────────────────────────────────

    /** Human-readable phase name for the UI panel. */
    static phaseLabel(p) {
        switch (p) {
            case PHASES.GROWTH:    return 'Growth';
            case PHASES.EXPANSION: return 'Expansion (onset)';
            case PHASES.RECOVERY:  return 'Recovery';
            default:               return 'Idle';
        }
    }

    static get PHASES() { return PHASES; }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function _smoothstep(a, b, x) {
    if (x <= a) return 0;
    if (x >= b) return 1;
    const t = (x - a) / (b - a);
    return t * t * (3 - 2 * t);
}

/**
 * Tail neutral-line altitude — fixed visualisation distance for the
 * BBF arrows. Real value is ~20 R⊕ but we render at 12 R⊕ so the
 * arrows sit inside the climatological magnetopause and read as
 * "energy injection from the magnetotail" without dwarfing the
 * scene at typical zoom levels.
 */
export const BBF_SOURCE_R = 12.0;          // R⊕ from Earth centre, antisunward
export const BBF_TARGET_R =  6.0;          // R⊕ — Earthward end of the BBFs
