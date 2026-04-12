/**
 * model-validation.js — Deterministic model prediction tracking & analysis
 *
 * Tracks predictions made by the physics pipeline, compares them against
 * observed outcomes when they arrive, and computes accuracy metrics that
 * accumulate over time.
 *
 * ── Architecture ────────────────────────────────────────────────────────────
 *  1. PREDICTIONS — Each state snapshot can generate predictions for future
 *     conditions (e.g., "Kp will reach 5 within 24h").  These are timestamped
 *     and stored with the input state that generated them.
 *
 *  2. OBSERVATIONS — As real NOAA data arrives, it's matched against pending
 *     predictions to compute hit/miss/error metrics.
 *
 *  3. CRITICAL VALUE LOG — Every time a critical threshold is crossed (Bz
 *     goes southward, Kp exceeds G1, etc.), the crossing is logged with
 *     the full state snapshot.  This builds a history of regime transitions.
 *
 *  4. MODEL SCORECARD — Rolling accuracy metrics per prediction type.
 *     Can be exported for offline analysis.
 *
 * ── Determinism ─────────────────────────────────────────────────────────────
 *  All comparison functions are pure.  The only stateful part is the
 *  prediction/observation ring buffers, which are append-only.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   import { ModelValidator } from './js/model-validation.js';
 *
 *   const validator = new ModelValidator().start();
 *
 *   // Query accuracy metrics:
 *   const report = validator.getScorecard();
 *   // { propagation_delay: { n: 42, mae: 3.2, bias: -1.1 }, ... }
 *
 *   // Export full log for offline analysis:
 *   const log = validator.exportLog();
 */

// ── Prediction types ────────────────────────────────────────────────────────

/**
 * Each prediction type defines:
 *  - id:          Unique key
 *  - horizon_s:   How far ahead the prediction looks (seconds)
 *  - extract:     fn(state) → predicted value (number)
 *  - observe:     fn(state) → observed value (number)
 *  - unit:        Human-readable unit
 *  - tolerance:   Acceptable error for "hit" classification
 */
const PREDICTION_TYPES = [
    {
        id: 'wind_speed_persistence',
        label: 'Wind speed 1h persistence',
        horizon_s: 3600,
        extract: s => s.v_sw,
        observe: s => s.v_sw,
        unit: 'km/s',
        tolerance: 50,
    },
    {
        id: 'bz_persistence',
        label: 'IMF Bz 1h persistence',
        horizon_s: 3600,
        extract: s => s.bz,
        observe: s => s.bz,
        unit: 'nT',
        tolerance: 3,
    },
    {
        id: 'kp_persistence',
        label: 'Kp 3h persistence',
        horizon_s: 10800,
        extract: s => s.kp,
        observe: s => s.kp,
        unit: '',
        tolerance: 1,
    },
    {
        id: 'density_persistence',
        label: 'Density 1h persistence',
        horizon_s: 3600,
        extract: s => s.n,
        observe: s => s.n,
        unit: 'cm⁻³',
        tolerance: 3,
    },
    {
        id: 'propagation_delay',
        label: 'L1→Earth delay accuracy',
        horizon_s: 0,  // measured at arrival
        extract: s => s.delay_min,
        observe: s => s.delay_min,
        unit: 'min',
        tolerance: 10,
    },
];

// ── Ring buffer for bounded memory ──────────────────────────────────────────

class RingBuffer {
    constructor(maxSize) {
        this._max = maxSize;
        this._buf = [];
    }

    push(item) {
        this._buf.push(item);
        if (this._buf.length > this._max) this._buf.shift();
    }

    toArray() { return [...this._buf]; }
    get length() { return this._buf.length; }

    filter(fn) { return this._buf.filter(fn); }
    find(fn)   { return this._buf.find(fn); }
    forEach(fn) { this._buf.forEach(fn); }
}

// ── Critical value crossing log ─────────────────────────────────────────────

/**
 * Detect threshold crossings between two consecutive states.
 * A "crossing" is when a critical threshold transitions from inactive to active
 * or vice versa.
 *
 * Deterministic: pure function of prev and curr criticals.
 *
 * @param {object} prevCriticals  Previous state's criticals
 * @param {object} currCriticals  Current state's criticals
 * @returns {Array<{ id, direction, label, severity, ts_ms }>}
 */
export function detectCrossings(prevCriticals, currCriticals, ts_ms) {
    if (!prevCriticals || !currCriticals) return [];

    const crossings = [];
    for (const id of Object.keys(currCriticals)) {
        const prev = prevCriticals[id];
        const curr = currCriticals[id];
        if (!prev || !curr) continue;

        if (!prev.active && curr.active) {
            crossings.push({
                id,
                direction: 'onset',
                label: curr.label,
                severity: curr.severity,
                ts_ms,
            });
        } else if (prev.active && !curr.active) {
            crossings.push({
                id,
                direction: 'recovery',
                label: curr.label,
                severity: null,
                ts_ms,
            });
        }
    }
    return crossings;
}

// ── Prediction-observation matching ─────────────────────────────────────────

/**
 * Score a single prediction against its observation.
 * Deterministic: pure function.
 *
 * @param {number} predicted
 * @param {number} observed
 * @param {number} tolerance
 * @returns {{ error, abs_error, hit, predicted, observed }}
 */
export function scorePrediction(predicted, observed, tolerance) {
    const error = predicted - observed;
    const abs_error = Math.abs(error);
    return {
        error,
        abs_error,
        hit: abs_error <= tolerance,
        predicted,
        observed,
    };
}

/**
 * Compute aggregate accuracy metrics from an array of scored predictions.
 * Deterministic: pure function of scores array.
 *
 * @param {Array<{error, abs_error, hit}>} scores
 * @returns {{ n, mae, rmse, bias, hit_rate, max_error }}
 */
export function computeMetrics(scores) {
    if (!scores.length) return { n: 0, mae: 0, rmse: 0, bias: 0, hit_rate: 0, max_error: 0 };

    let sumAbs = 0, sumSq = 0, sumErr = 0, hits = 0, maxErr = 0;
    for (const s of scores) {
        sumAbs += s.abs_error;
        sumSq  += s.error * s.error;
        sumErr += s.error;
        if (s.hit) hits++;
        if (s.abs_error > maxErr) maxErr = s.abs_error;
    }

    const n = scores.length;
    return {
        n,
        mae:       sumAbs / n,
        rmse:      Math.sqrt(sumSq / n),
        bias:      sumErr / n,
        hit_rate:  hits / n,
        max_error: maxErr,
    };
}

// ── ModelValidator ───────────────────────────────────────────────────────────

export class ModelValidator {
    constructor(opts = {}) {
        /** Max entries per ring buffer */
        this._maxEntries = opts.maxEntries ?? 2000;

        /** Pending predictions awaiting observation */
        this._pending = new RingBuffer(this._maxEntries);

        /** Completed prediction-observation pairs */
        this._completed = new RingBuffer(this._maxEntries);

        /** Critical threshold crossing log */
        this._crossings = new RingBuffer(this._maxEntries);

        /** State snapshot log (sampled, not every frame) */
        this._snapshots = new RingBuffer(opts.maxSnapshots ?? 500);

        /** Previous state's criticals (for crossing detection) */
        this._prevCriticals = null;

        /** Previous state (for persistence model predictions) */
        this._prevState = null;

        /** Sample counter: only log every N-th state to bound memory */
        this._sampleCounter = 0;
        this._sampleRate = opts.sampleRate ?? 60;  // log 1 per 60 updates (~1/min)

        this._onHelioState = this._onHelioState.bind(this);
    }

    /** Start listening for state updates. */
    start() {
        window.addEventListener('helio-state-update', this._onHelioState);
        return this;
    }

    /** Stop listening. */
    stop() {
        window.removeEventListener('helio-state-update', this._onHelioState);
    }

    // ── Event handler ────────────────────────────────────────────────────────

    _onHelioState(ev) {
        const state = ev.detail;
        if (!state?.seq) return;

        const ts = state.ts_ms ?? Date.now();

        // ── Critical threshold crossing detection ────────────────────────────
        if (state.criticals) {
            const crossings = detectCrossings(this._prevCriticals, state.criticals, ts);
            for (const c of crossings) {
                this._crossings.push({
                    ...c,
                    state_seq: state.seq,
                    v_sw: state.v_sw,
                    bz: state.bz,
                    kp: state.kp,
                    n: state.n,
                });
            }
            this._prevCriticals = state.criticals;
        }

        // ── Match pending predictions against current observation ─────────────
        const nowMs = ts;
        this._pending.forEach(pred => {
            if (pred.matched) return;

            const ageMs = nowMs - pred.ts_ms;
            const horizonMs = pred.horizon_s * 1000;

            // Match if we're within ±30s of the prediction horizon
            if (Math.abs(ageMs - horizonMs) < 30_000) {
                const pType = PREDICTION_TYPES.find(p => p.id === pred.type_id);
                if (!pType) return;

                const observed = pType.observe(state);
                if (observed == null) return;

                const score = scorePrediction(pred.predicted, observed, pType.tolerance);
                pred.matched = true;

                this._completed.push({
                    type_id:   pred.type_id,
                    ts_predicted: pred.ts_ms,
                    ts_observed:  nowMs,
                    horizon_s: pred.horizon_s,
                    ...score,
                    input_seq:  pred.state_seq,
                    output_seq: state.seq,
                });
            }
        });

        // ── Generate new predictions from current state ──────────────────────
        for (const pType of PREDICTION_TYPES) {
            if (pType.horizon_s === 0) continue;  // observational, not predictive

            const predicted = pType.extract(state);
            if (predicted == null) continue;

            this._pending.push({
                type_id:   pType.id,
                ts_ms:     ts,
                horizon_s: pType.horizon_s,
                predicted,
                state_seq: state.seq,
                matched:   false,
            });
        }

        // ── Sample state snapshots at reduced rate ───────────────────────────
        this._sampleCounter++;
        if (this._sampleCounter >= this._sampleRate) {
            this._sampleCounter = 0;
            this._snapshots.push({
                seq:    state.seq,
                ts_ms:  ts,
                quality: state.quality,
                v_sw:   state.v_sw,
                n:      state.n,
                bz:     state.bz,
                bt:     state.bt,
                by:     state.by,
                kp:     state.kp,
                p_dyn:  state.p_dyn,
                beta:   state.beta,
                v_alfven: state.v_alfven,
                T:      state.T,
                delay_min: state.delay_min,
                n_warnings: state.validation?.n_warnings ?? 0,
                criticals: state.criticals ? Object.fromEntries(
                    Object.entries(state.criticals)
                        .filter(([, v]) => v.active)
                        .map(([k, v]) => [k, v.severity])
                ) : {},
            });
        }

        this._prevState = state;
    }

    // ── Query API ────────────────────────────────────────────────────────────

    /**
     * Get accuracy scorecard: per-prediction-type metrics.
     * Deterministic: pure computation over completed predictions.
     *
     * @returns {object} { [type_id]: { label, unit, n, mae, rmse, bias, hit_rate, max_error } }
     */
    getScorecard() {
        const card = {};
        for (const pType of PREDICTION_TYPES) {
            const scores = this._completed.filter(c => c.type_id === pType.id);
            card[pType.id] = {
                label: pType.label,
                unit:  pType.unit,
                tolerance: pType.tolerance,
                ...computeMetrics(scores),
            };
        }
        return card;
    }

    /**
     * Get recent critical threshold crossings.
     * @param {number} maxAge_ms  Maximum age in ms (default 24h)
     * @returns {Array}
     */
    getRecentCrossings(maxAge_ms = 86400_000) {
        const cutoff = Date.now() - maxAge_ms;
        return this._crossings.filter(c => c.ts_ms > cutoff);
    }

    /**
     * Get sampled state snapshot history.
     * @param {number} maxAge_ms  Maximum age in ms (default 24h)
     * @returns {Array}
     */
    getHistory(maxAge_ms = 86400_000) {
        const cutoff = Date.now() - maxAge_ms;
        return this._snapshots.filter(s => s.ts_ms > cutoff);
    }

    /**
     * Get current data quality summary.
     * @returns {{ quality, n_warnings, staleness_s, buffer_depth }}
     */
    getDataQuality() {
        const prev = this._prevState;
        return {
            quality:      prev?.quality ?? 'unknown',
            n_warnings:   prev?.validation?.n_warnings ?? 0,
            warnings:     prev?.validation?.warnings ?? [],
            staleness_s:  prev?.ts_ms ? (Date.now() - prev.ts_ms) / 1000 : null,
            buffer_depth: this._snapshots.length,
        };
    }

    /**
     * Export the complete log for offline analysis.
     * Includes all snapshots, predictions, crossings, and scorecard.
     *
     * @returns {object}
     */
    exportLog() {
        return {
            exported_at: new Date().toISOString(),
            scorecard:   this.getScorecard(),
            snapshots:   this._snapshots.toArray(),
            crossings:   this._crossings.toArray(),
            completed:   this._completed.toArray(),
            pending:     this._pending.toArray().filter(p => !p.matched),
            data_quality: this.getDataQuality(),
        };
    }
}
