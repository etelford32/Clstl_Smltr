/**
 * advection-gain-tracker.js — learned per-horizon gain α[h] for the
 *                              wind-advection forecaster
 *
 * Why this exists
 * ───────────────
 * The semi-Lagrangian step in WindAdvectionForecaster walks each
 * destination cell backward along the current U/V vector for h hours.
 * That single-step backward-Euler approximation works at short
 * horizons (h ≤ 6 h) where the wind is roughly stationary, but at
 * 12-24 h horizons the wind itself evolves a lot more than the trajectory
 * accounts for — the forecast can become *worse than persistence*.
 *
 * The fix: scale the U/V magnitude by a learned per-horizon gain α[h]
 * before advecting. α[h] = 1 is the original physics-faithful step;
 * α[h] = 0 collapses the forecast to persistence (walk back zero
 * distance, sample the current frame). The system learns α[h] from
 * the validator's MSE feedback:
 *
 *   skill[h] = 1 − MSE_advection[h] / MSE_persistence[h]
 *
 *   target[h] = clip(skill[h] mapped through a soft sigmoid, 0, 1)
 *
 *   α[h] ← (1 − β) · α[h] + β · target[h]                (EMA smooth)
 *
 * Behaviours this gives:
 *
 *   - Strongly winning advection at h (skill ≥ 0.5) ⇒ target = 1 ⇒
 *     α drifts up to the physics-faithful step.
 *   - Strongly losing advection at h (skill ≤ −0.5) ⇒ target = 0 ⇒
 *     α drifts down so the forecast collapses to persistence and
 *     regains the persistence baseline (no worse).
 *   - Marginally beating persistence (skill ≈ 0.05) ⇒ target ≈ 0.55
 *     ⇒ α stays in the middle, partially-trusting the wind.
 *
 * The "Bz-style" runtime modulator
 * ────────────────────────────────
 * On top of the learned gain, a WindShearProxy supplies a steadiness
 * scalar ∈ [0, 1]. Effective gain at forecast time is
 *
 *   α_eff[h] = α[h] · steadiness
 *
 * — analogous to how a southward IMF Bz modulates magnetospheric
 * coupling: when the runtime signal says "the steady-flow assumption
 * is breaking down right now" we back off harder than the long-term
 * skill estimate alone would suggest. Returns to α[h] when the wind
 * settles.
 *
 * Persistence
 * ───────────
 * The α vector is written to localStorage so a returning visitor lands
 * back at learned gains, not at the cold prior. Validator-side state is
 * IDB-managed and survives reloads independently — no double-counting
 * across sessions.
 */

const STORAGE_KEY = 'pp.earth.advection-gain.v1';

// EMA mixing across validator updates. 0.20 ≈ 5-update half-life, so
// a single noisy validation cycle can't yank α far. With ~hourly
// validator ticks that's ~5 hours to fully react to a regime shift —
// matches the synoptic time scale.
const EMA_ALPHA = 0.20;

// Maps Murphy skill ∈ (−∞, 1] → target gain ∈ [0, 1]. Linear in the
// useful range, saturating at the extremes. Tuned so:
//   skill ≤ -0.5 ⇒ target = 0          (clearly losing, fall back)
//   skill = 0     ⇒ target ≈ 0.5       (break-even, half-trust)
//   skill ≥ +0.5 ⇒ target = 1          (clearly winning, full trust)
function _skillToTarget(skill) {
    const s = Math.max(-0.5, Math.min(0.5, skill));
    return (s + 0.5);    // [-0.5, 0.5] → [0, 1]
}

// Channel-name lookup matches CHANNEL_NAMES in weather-forecast.js.
const CHANNEL_INDEX_TO_NAME = ['T', 'P', 'RH', 'U', 'V', 'cl_low', 'cl_mid', 'cl_high', 'precip'];

// Channels that the wind-advection forecaster predicts physically (the
// fields are advected by the stored U/V, so all of them are "in scope"
// for skill measurement). We average across these to produce the
// per-horizon scalar; using all 9 would dilute the signal with
// cloud channels that LK handles better.
const SCORE_CHANNELS = ['T', 'U', 'V', 'RH'];

function _loadStored(horizons) {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return null;
        // Defensive shape check — a stored vector for a different
        // horizon set silently reverts to defaults rather than
        // poisoning current forecasts.
        if (!Array.isArray(obj.horizons) || obj.horizons.length !== horizons.length) return null;
        for (let i = 0; i < horizons.length; i++) {
            if (obj.horizons[i] !== horizons[i]) return null;
        }
        if (!Array.isArray(obj.gains)) return null;
        return obj;
    } catch (_) {
        return null;
    }
}

function _saveStored(horizons, gains) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            horizons: horizons.slice(),
            gains:    Array.from(gains),
            updatedAt: Date.now(),
        }));
    } catch (_) {
        // Quota / privacy: silent. Next validator update retries.
    }
}

// ── AdvectionGainTracker ───────────────────────────────────────────────────

export class AdvectionGainTracker {
    /**
     * @param {object} opts
     * @param {string}   opts.modelId           Forecaster being tracked
     *   (default 'wind-advection-v1'). One tracker per forecaster keeps
     *   the localStorage shape simple.
     * @param {number[]} opts.horizons          Horizons in hours, must
     *   match the validator's bins. Defaults to [1, 3, 6, 12, 24].
     * @param {string}   [opts.referenceModel]  Skill is computed against
     *   this model's MSE. Defaults to 'persistence-v1'.
     */
    constructor({
        modelId = 'wind-advection-v1',
        horizons = [1, 3, 6, 12, 24],
        referenceModel = 'persistence-v1',
    } = {}) {
        this._modelId   = modelId;
        this._horizons  = horizons.slice();
        this._refModel  = referenceModel;

        // Seed: localStorage > defaults (1.0 across the board, the
        // physics-faithful starting point).
        const stored = _loadStored(this._horizons);
        if (stored && stored.gains.length === this._horizons.length) {
            this._gains = Float32Array.from(stored.gains);
        } else {
            this._gains = new Float32Array(this._horizons.length).fill(1);
        }

        this._sampleCount = 0;
        this._onValidation = this._onValidation.bind(this);
        document.addEventListener('weather-forecast-validation-update', this._onValidation);
    }

    /**
     * Per-horizon learned gain α[h] (∈ [0, 1]). Returns 1.0 for any
     * horizon not in our table — caller should be passing a horizon
     * we registered for, but defensive fallback prevents a stray
     * forecaster from getting a NaN gain.
     */
    getGain(hourAhead) {
        const idx = this._horizons.indexOf(hourAhead);
        return idx >= 0 ? this._gains[idx] : 1.0;
    }

    /** Snapshot — used by debug HUDs and the SW-panel diagnostic strip. */
    getAllGains() {
        const out = {};
        for (let i = 0; i < this._horizons.length; i++) {
            out[this._horizons[i]] = this._gains[i];
        }
        return out;
    }

    get sampleCount() { return this._sampleCount; }

    stop() {
        document.removeEventListener('weather-forecast-validation-update', this._onValidation);
    }

    // ── Internal ──────────────────────────────────────────────────────

    _onValidation(ev) {
        const summary = ev?.detail?.summary;
        if (!summary) return;
        const modelStats = summary[this._modelId];
        const refStats   = summary[this._refModel];
        if (!modelStats || !refStats) return;

        let dirty = false;
        for (let i = 0; i < this._horizons.length; i++) {
            const h = this._horizons[i];
            // Average MSE across SCORE_CHANNELS for both model and reference.
            // Skip the horizon entirely if any channel is missing — a
            // partial average would penalise the model on whichever
            // channel happened to land first.
            let mseM = 0, mseR = 0, ok = true;
            for (const ch of SCORE_CHANNELS) {
                const m = modelStats[ch]?.[h];
                const r = refStats[ch]?.[h];
                if (!m || !r ||
                    !Number.isFinite(m.mse) || !Number.isFinite(r.mse) || r.mse <= 0 ||
                    (m.n | 0) < 5 || (r.n | 0) < 5) { ok = false; break; }
                mseM += m.mse;
                mseR += r.mse;
            }
            if (!ok) continue;
            const skill = 1 - (mseM / mseR);
            const target = _skillToTarget(skill);
            this._gains[i] = (1 - EMA_ALPHA) * this._gains[i] + EMA_ALPHA * target;
            // Hard clamp [0, 1] in case a numerical glitch pushes us
            // outside; the EMA combination of values in [0, 1] should
            // keep us in range, but defensive.
            this._gains[i] = Math.max(0, Math.min(1, this._gains[i]));
            dirty = true;
        }

        if (dirty) {
            this._sampleCount += 1;
            _saveStored(this._horizons, this._gains);
            document.dispatchEvent(new CustomEvent('advection-gain-update', {
                detail: {
                    modelId:    this._modelId,
                    horizons:   this._horizons.slice(),
                    gains:      Array.from(this._gains),
                    sampleCount: this._sampleCount,
                },
            }));
        }
    }
}

export default AdvectionGainTracker;
export { _skillToTarget as skillToGainTarget };
