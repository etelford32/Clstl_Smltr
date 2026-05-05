/**
 * tracer-skill-tracker.js — learned per-channel weights for the optical-flow
 *                            tracer-blend
 *
 * The OpticalFlowForecaster pools several "tracer" channels (low/mid/high
 * cloud cover by default) into a single field before running Lucas-Kanade.
 * Equal-weighted pooling is a fine v1 baseline, but storm-scale features
 * track mid + high clouds far better than low — equal weights effectively
 * dilute the signal. This module supplies a *learned* weight vector that
 * adapts based on which channels the forecaster has historically predicted
 * accurately.
 *
 * The signal we're learning from
 * ──────────────────────────────
 * The existing WeatherForecastValidator already scores every registered
 * forecaster's output per channel × horizon. So when the optical-flow
 * forecaster's cloud_high channel matches its target observation closely
 * at +3 h, that's evidence its LK flow tracked the high-cloud motion
 * faithfully — i.e. the high-cloud component of the tracer was
 * informative. Conversely, a high MAE on cloud_low says LK didn't
 * capture low-cloud motion — increase the weight of OTHER channels
 * to shift the next LK fit toward sources of motion that *are*
 * tracked accurately.
 *
 * Mechanism
 * ─────────
 *   per-channel skill = 1 / MSE         (inverse-MSE weighting)
 *   final weight     ∝ skill_floor + skill
 * Where `skill_floor` keeps any single channel from being weighted to
 * zero — even if the model fails on one channel for a stretch, we
 * don't strand it permanently. The vector is then renormalised to
 * sum to 1.0.
 *
 * To avoid rapid weight oscillation, the result is EMA-smoothed across
 * validator updates with α = 0.25.
 *
 * Persistence
 * ───────────
 * Snapshot of the latest smoothed weight vector is written to
 * localStorage under a model-specific key. A returning visitor lands
 * back at the most recently learned weights instead of the cold prior,
 * so the LK fit doesn't relearn from scratch every reload.
 *
 * Concurrency
 * ───────────
 * One validator fires updates ≤ 1× per ingest cycle (~hourly). The
 * tracker handles them synchronously inside the event handler — no
 * debouncing needed. Constructors are cheap (just attaches the
 * listener); the work happens on validator events.
 */

const STORAGE_KEY_PREFIX = 'pp.earth.tracer-weights.v1.';

// EMA mixing for the smoothed weights. 0.25 means a step takes ~5
// validator ticks to reach 75% of the new value — slow enough to
// resist noise from a single bad forecast, fast enough that a real
// regime change (storm front passing) propagates within a few hours.
const EMA_ALPHA = 0.25;

// Skill floor — keeps any one channel from going to zero weight even
// if its MSE goes to infinity (or if no data exists yet). The floor
// is small relative to typical inverse-MSE values; expressed as
// "fraction of the *uniform* weight" so it scales with the channel
// count: with 3 channels and floor=0.20, no channel falls below ~6.7%.
const FLOOR_FRACTION = 0.20;

// Hard upper bound on any single channel's weight. Prevents LK from
// becoming a single-channel estimator if one channel happens to
// dominate the inverse-MSE ladder — multi-channel pooling is the
// whole point.
const MAX_FRACTION = 0.85;

function _storageKey(modelId) {
    return STORAGE_KEY_PREFIX + modelId;
}

function _loadStored(modelId) {
    try {
        const raw = localStorage.getItem(_storageKey(modelId));
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return null;
        if (!Array.isArray(obj.channels) || !Array.isArray(obj.weights)) return null;
        if (obj.channels.length !== obj.weights.length) return null;
        return obj;
    } catch (_) {
        return null;
    }
}

function _saveStored(modelId, channels, weights) {
    try {
        localStorage.setItem(_storageKey(modelId), JSON.stringify({
            channels: channels.slice(),
            weights:  Array.from(weights),
            updatedAt: Date.now(),
        }));
    } catch (_) {
        // Quota / privacy: silent. The next validator update will retry.
    }
}

// Renormalise a weight vector to sum to 1.0 with a per-cell floor +
// cap. Returns a fresh array; never mutates the input.
function _normalize(weights, channelCount) {
    const out = new Float32Array(channelCount);
    let sum = 0;
    for (let i = 0; i < channelCount; i++) sum += Math.max(0, weights[i] || 0);
    if (sum <= 0) {
        // All-zero input → uniform fallback. Shouldn't happen given the
        // skill_floor in the inverse-MSE pipeline, but defensive.
        const u = 1 / channelCount;
        for (let i = 0; i < channelCount; i++) out[i] = u;
        return out;
    }
    const floor = (1 / channelCount) * FLOOR_FRACTION;
    const cap   = MAX_FRACTION;
    let postSum = 0;
    for (let i = 0; i < channelCount; i++) {
        const w = (weights[i] || 0) / sum;
        const clamped = Math.min(cap, Math.max(floor, w));
        out[i] = clamped;
        postSum += clamped;
    }
    // Re-normalise after floor/cap so we still sum to 1.
    for (let i = 0; i < channelCount; i++) out[i] = out[i] / postSum;
    return out;
}

// Channel-name → channel-index lookup. The validator's summary keys
// channels by their textual name (T, P, RH, U, V, cl_low, cl_mid,
// cl_high, precip — see CHANNEL_NAMES in weather-forecast.js). We
// derive a map from a numeric channel index → that name so the caller
// can supply numeric indices (which is how every other module in the
// pipeline addresses channels).
const CHANNEL_INDEX_TO_NAME = ['T', 'P', 'RH', 'U', 'V', 'cl_low', 'cl_mid', 'cl_high', 'precip'];

// ── TracerSkillTracker ─────────────────────────────────────────────────────

export class TracerSkillTracker {
    /**
     * @param {object} opts
     * @param {string}   opts.modelId      Forecaster model_id whose skill
     *   feeds these weights (e.g. 'optical-flow-v1'). Unique per
     *   tracker instance — used as the localStorage key suffix.
     * @param {number[]} opts.channels     Numeric channel indices into
     *   the CHW coarse buffer (e.g. [5,6,7] for low/mid/high cloud).
     * @param {number}   [opts.horizonH=3] Which forecast horizon to
     *   harvest skill from. 3 h is the LK-relevant short-horizon
     *   target; longer horizons start being dominated by AR/climatology
     *   in the registry, not LK.
     * @param {number[]} [opts.priorWeights]  Initial weight vector,
     *   one per channels[]. Defaults to uniform.
     */
    constructor({ modelId, channels, horizonH = 3, priorWeights } = {}) {
        if (!modelId) throw new Error('TracerSkillTracker: modelId required');
        if (!Array.isArray(channels) || channels.length === 0) {
            throw new Error('TracerSkillTracker: channels[] required');
        }
        this._modelId  = modelId;
        this._channels = channels.slice();
        this._horizon  = horizonH;
        this._channelNames = channels.map(ci => CHANNEL_INDEX_TO_NAME[ci] ?? `ch${ci}`);

        // Seed weights: localStorage > priorWeights > uniform.
        const stored = _loadStored(modelId);
        let seed;
        if (stored && stored.channels.length === channels.length
                   && stored.channels.every((c, i) => c === channels[i])) {
            seed = Float32Array.from(stored.weights);
        } else if (Array.isArray(priorWeights) && priorWeights.length === channels.length) {
            seed = Float32Array.from(priorWeights);
        } else {
            seed = new Float32Array(channels.length).fill(1 / channels.length);
        }
        this._weights = _normalize(seed, channels.length);

        this._sampleCount = 0;
        this._onValidation = this._onValidation.bind(this);
        document.addEventListener('weather-forecast-validation-update', this._onValidation);
    }

    /** Current normalized weight vector (Float32Array, length = channels.length). */
    getWeights() { return this._weights.slice(); }

    /** Number of validator events the tracker has folded in. */
    get sampleCount() { return this._sampleCount; }

    /** Manual stop — for hot-reload + tests. */
    stop() {
        document.removeEventListener('weather-forecast-validation-update', this._onValidation);
    }

    // ── Internal ──────────────────────────────────────────────────────

    _onValidation(ev) {
        const summary = ev?.detail?.summary;
        if (!summary) return;
        const modelStats = summary[this._modelId];
        if (!modelStats) return;     // forecaster hasn't matched any targets yet

        // Collect MSE per channel at the target horizon. A null/undefined
        // bin (no data yet) maps to "infinite MSE" → minimum-floor weight,
        // not zero — keeps the channel in the pool until real data lands.
        const C = this._channels.length;
        const inverseMse = new Float64Array(C);
        let anyValid = false;
        for (let i = 0; i < C; i++) {
            const bin = modelStats[this._channelNames[i]]?.[this._horizon];
            const mse = bin?.mse;
            if (Number.isFinite(mse) && mse > 0) {
                // Pseudo-skill: 1/(MSE + ε) avoids division-by-zero
                // explosions when a freshly-matched perfect forecast
                // would otherwise dominate. ε is small relative to the
                // typical MSE band of cloud fractions (~10² in 0-100 %
                // units), so it's a soft floor, not a hard one.
                inverseMse[i] = 1 / (mse + 1e-3);
                anyValid = true;
            } else {
                inverseMse[i] = 0;
            }
        }
        if (!anyValid) return;

        const targetW = _normalize(inverseMse, C);
        // EMA-smooth the new target weights into the running estimate.
        // Smoothing has to happen *after* normalisation — averaging un-
        // normalised vectors and then renormalising would let a channel
        // that bursts huge inverse-MSE briefly dominate the EMA for a
        // window proportional to its burst.
        for (let i = 0; i < C; i++) {
            this._weights[i] = (1 - EMA_ALPHA) * this._weights[i] + EMA_ALPHA * targetW[i];
        }
        // Final renormalise — the EMA combination keeps the sum near
        // 1.0 but float drift would otherwise let it wander.
        this._weights = _normalize(this._weights, C);
        this._sampleCount += 1;

        _saveStored(this._modelId, this._channels, this._weights);
        // Surface the update so a debug HUD or logger can react.
        document.dispatchEvent(new CustomEvent('tracer-weights-update', {
            detail: {
                modelId: this._modelId,
                channels: this._channels.slice(),
                weights: Array.from(this._weights),
                sampleCount: this._sampleCount,
            },
        }));
    }
}

export default TracerSkillTracker;
export { _normalize as normalizeTracerWeights };
