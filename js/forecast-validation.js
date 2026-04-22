/**
 * forecast-validation.js
 *
 * Rolling skill tracker for the Forecast Timeline panel.
 *
 * Why this exists:
 *   Showing uncertainty bands on a Kp forecast without any evidence of skill
 *   is decoration. Operators who know the field will ask the obvious
 *   question first: does your forecast beat persistence? This module
 *   answers that question every time the dashboard loads.
 *
 * How it works:
 *   1. On every 'earth-forecast-update' event, snapshot the AR(p) and
 *      persistence point forecasts at t+3h, t+6h, t+12h, t+24h.
 *   2. Pending snapshots are persisted to localStorage with their target
 *      validation time, bounded to ~30 days.
 *   3. Every snapshot and every incoming Kp observation (also via
 *      'earth-forecast-update', whose detail.timing.current_g is
 *      post-state) checks pending entries: if target_ms is within ±30 min
 *      of wall clock, score against the current Kp and move to completed.
 *   4. Rolling metrics (MAE, RMSE, hit-rate, skill vs persistence) are
 *      recomputed from the completed buffer and emitted as a
 *      'forecast-validation-update' CustomEvent.
 *
 * Storage budget: 4 horizons × ~1 prediction/hour × 30 days × ~100 bytes ≈
 * 300KB worst case, well under the ~5MB localStorage cap.
 */

const STORAGE_KEY      = 'parkersphysics.forecast-validation.v1';
const MAX_RETAIN_DAYS  = 30;
const MATCH_WINDOW_MS  = 30 * 60_000;   // ±30 min against target validation time
const TRACKED_HORIZONS = [3, 6, 12, 24];

// ── Persistence helpers ─────────────────────────────────────────────────────

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { pending: [], completed: [] };
        const state = JSON.parse(raw);
        return {
            pending:   Array.isArray(state.pending)   ? state.pending   : [],
            completed: Array.isArray(state.completed) ? state.completed : [],
        };
    } catch (_) {
        return { pending: [], completed: [] };
    }
}

function saveState(state) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {
        // Quota/privacy mode: silent — validation is best-effort.
    }
}

// ── Metrics ─────────────────────────────────────────────────────────────────

function summarize(completed, modelKey) {
    const rows = completed.filter(c => c[modelKey] != null);
    if (rows.length === 0) {
        return { n: 0, mae: null, rmse: null, bias: null, hit_rate: null };
    }
    let sumAbs = 0, sumSq = 0, sumErr = 0, hits = 0;
    for (const r of rows) {
        const err = r[modelKey] - r.observed;
        sumErr += err;
        sumAbs += Math.abs(err);
        sumSq  += err * err;
        // Hit-rate: central forecast within ±1 Kp unit (matches the
        // tolerance the existing ModelValidator uses for kp_persistence).
        if (Math.abs(err) <= 1.0) hits++;
    }
    const n = rows.length;
    return {
        n,
        mae:      +(sumAbs / n).toFixed(3),
        rmse:     +Math.sqrt(sumSq / n).toFixed(3),
        bias:     +(sumErr / n).toFixed(3),
        hit_rate: +(hits / n).toFixed(3),
    };
}

// Murphy skill score (deterministic forecast): 1 - MSE_model / MSE_ref.
// >0 means model beats reference; 0 is no improvement; <0 is worse.
function skillScore(completed, modelKey, refKey) {
    const rows = completed.filter(c => c[modelKey] != null && c[refKey] != null);
    if (rows.length < 5) return null;  // need minimum sample to be meaningful
    let mseModel = 0, mseRef = 0;
    for (const r of rows) {
        const eM = r[modelKey] - r.observed;
        const eR = r[refKey]   - r.observed;
        mseModel += eM * eM;
        mseRef   += eR * eR;
    }
    if (mseRef === 0) return null;
    return +(1 - mseModel / mseRef).toFixed(3);
}

// ── ForecastValidator ──────────────────────────────────────────────────────

/**
 * Tracks AR(p) and persistence forecasts against live Kp observations,
 * exposes rolling skill metrics, and re-emits a summary event.
 */
export class ForecastValidator {
    constructor() {
        const s = loadState();
        this._pending   = s.pending;
        this._completed = s.completed;
        this._latestSnapshotMs = 0;
        this._currentKp = null;

        this._onForecast = this._onForecast.bind(this);
    }

    start() {
        window.addEventListener('earth-forecast-update', this._onForecast);
        return this;
    }

    stop() {
        window.removeEventListener('earth-forecast-update', this._onForecast);
    }

    /**
     * Latest summary. Returns per-horizon metrics for AR(p) and persistence
     * plus Murphy skill score.
     */
    getSummary() {
        const byHorizon = {};
        for (const h of TRACKED_HORIZONS) {
            const subset = this._completed.filter(c => c.horizon_h === h);
            byHorizon[h] = {
                horizon_h: h,
                arp:         summarize(subset, 'arp_kp'),
                persistence: summarize(subset, 'persistence_kp'),
                skill_vs_persistence: skillScore(subset, 'arp_kp', 'persistence_kp'),
            };
        }
        return {
            updated_at: Date.now(),
            by_horizon: byHorizon,
            total_completed: this._completed.length,
            total_pending:   this._pending.length,
        };
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    _onForecast(ev) {
        const f = ev?.detail;
        if (!f?.forecast_timeline) return;

        const nowMs = Date.now();
        const timeline = f.forecast_timeline;

        // Observed Kp is on the live state via the G-scale feed — but the
        // earth-forecast-update event doesn't carry the raw Kp directly. We
        // reconstruct it from forecast_timeline.trajectory if present (the
        // AR(p) at t=1h is not Kp_now; however the AR fit is demeaned, so
        // the previous hour's observation is what we need). Simpler and
        // more accurate: infer Kp_now from the persistence trajectory at
        // step 0, since persistenceForecast uses kpNow verbatim.
        const currentKp = timeline.trajectory?.persistence?.mean?.[0];
        if (Number.isFinite(currentKp)) this._currentKp = currentKp;

        // ── 1. Match pending predictions ────────────────────────────────────
        if (this._currentKp != null) {
            const stillPending = [];
            for (const p of this._pending) {
                const dt = Math.abs(nowMs - p.target_ms);
                if (dt <= MATCH_WINDOW_MS) {
                    this._completed.push({
                        horizon_h:      p.horizon_h,
                        issued_ms:      p.issued_ms,
                        target_ms:      p.target_ms,
                        matched_ms:     nowMs,
                        arp_kp:         p.arp_kp,
                        persistence_kp: p.persistence_kp,
                        swpc_kp:        p.swpc_kp,
                        observed:       +this._currentKp.toFixed(2),
                    });
                } else if (nowMs < p.target_ms + MATCH_WINDOW_MS) {
                    // Still in the future (or inside match window but not centred)
                    stillPending.push(p);
                }
                // Otherwise: expired unmatched — drop silently
            }
            this._pending = stillPending;
        }

        // ── 2. Emit new predictions from current forecast ──────────────────
        // Debounce: only snapshot once per hour to avoid duplicating the
        // same forecast every 60s tick.
        if (nowMs - this._latestSnapshotMs >= 55 * 60_000) {
            const horizons = timeline.horizons ?? [];
            const traj = timeline.trajectory ?? {};
            for (const hh of TRACKED_HORIZONS) {
                const idx = hh - 1;     // trajectory is 1..h
                const arp  = traj.arp?.mean?.[idx];
                const per  = traj.persistence?.mean?.[idx];
                if (!Number.isFinite(arp) || !Number.isFinite(per)) continue;
                // Horizons snapshot may have an SWPC cross-check at this hh
                const horizonEntry = horizons.find(x => x.horizon_h === hh);
                const swpc = horizonEntry?.swpc_kp ?? null;
                this._pending.push({
                    horizon_h:      hh,
                    issued_ms:      nowMs,
                    target_ms:      nowMs + hh * 3600e3,
                    arp_kp:         +arp.toFixed(2),
                    persistence_kp: +per.toFixed(2),
                    swpc_kp:        swpc,
                });
            }
            this._latestSnapshotMs = nowMs;
        }

        // ── 3. Retention: trim completed + pending ──────────────────────────
        const retentionCutoff = nowMs - MAX_RETAIN_DAYS * 86400e3;
        this._completed = this._completed.filter(c => c.matched_ms >= retentionCutoff);
        // Pending older than 2h past target = unmatched, drop
        this._pending = this._pending.filter(p => p.target_ms + 2 * 3600e3 > nowMs);

        saveState({ pending: this._pending, completed: this._completed });

        // ── 4. Emit summary ────────────────────────────────────────────────
        window.dispatchEvent(new CustomEvent('forecast-validation-update', {
            detail: this.getSummary(),
        }));
    }
}
