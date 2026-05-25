/**
 * satellite-designer-forecast.js — F10.7 / Ap forecast plumbing for the
 * Satellite Designer game.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The drag mechanic in `satellite-designer-engine.js` is fully F10.7/Ap-
 * driven, but the player has never seen the *forecast* — only the current
 * preset. This module fixes that without touching the engine: it pulls the
 * live NOAA history (observed + 45-day forecast) from our existing edge
 * functions, feeds it to the AR(1) projector in `drag-forecast-projector.js`,
 * and exposes a small surface the HUD + mission code can poll.
 *
 * Data path
 * ─────────
 *   /api/noaa/f107-history   → daily F10.7 rows (observed + predicted)
 *   /api/noaa/ap-history     → 3-hourly Ap rows (observed + predicted)
 *           │
 *           ▼
 *      merged ring ─→ projectDragState / projectDragEnvelope (AR(1))
 *           │
 *           ▼
 *    getForecast({ horizonHours })
 *
 * Caching
 * ───────
 *   F10.7 updates once a day; Ap every 3 h. We refresh on-demand with a 5-min
 *   minimum interval; concurrent calls share the in-flight promise.
 *
 * Failure mode
 * ────────────
 *   If both endpoints fail, we fall through to `fetchLiveIndices()` from
 *   `upper-atmosphere-engine.js` and synthesize a single-point history.
 *   The projector then reports persistence with σ = 0 — honest "no statistical
 *   basis for an envelope," which the HUD can render as a dimmed/uncertain
 *   readout.
 *
 * Mission override
 * ────────────────
 *   CME-survival (and any future scripted mission) needs to ride scripted
 *   spikes on top of the live baseline. `setMissionOverride(fn)` lets a
 *   mission supply  (horizonHours, baseForecast, opts) → forecast  that
 *   replaces / decorates the projector output. Pass `null` to clear.
 */

import { projectDragState, projectDragEnvelope } from './drag-forecast-projector.js';
import { fetchLiveIndices, kpToAp } from './upper-atmosphere-engine.js';

// ── Cache state ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;   // 5 min — endpoints cache 1 h upstream
const FETCH_TIMEOUT_MS   = 4000;

/** Merged history ring: [{t: epochMs, f107?: num, ap?: num, kind?: str}, …]. */
let _history = [];
/** Latest "nowcast" — the most-recent observed point, surfaced separately
 *  so the HUD can show "live F10.7 = 142, Ap = 6" without rerunning AR(1). */
let _nowcast = null;       // { f107, ap, t, source }
let _lastFetchOkMs = 0;
let _lastFetchTriedMs = 0;
let _lastStatus = { source: 'unloaded', samples: 0, stale: true };
let _inFlight = null;      // shared Promise during concurrent fetches
let _missionOverride = null;

// ── Internal: row → merged-history conversion ───────────────────────────────

function _parseT(t) {
    if (Number.isFinite(t)) return t;
    const n = Date.parse(String(t));
    return Number.isFinite(n) ? n : NaN;
}

/**
 * Turn the two NOAA payloads into a single epoch-sorted history ring suitable
 * for `projectDragState`. Each row carries only the scalar(s) known at its
 * timestamp; the projector's per-scalar resampler handles NaNs by skipping.
 */
function _mergeHistory(f107Rows, apRows) {
    const out = [];

    if (Array.isArray(f107Rows)) {
        for (const r of f107Rows) {
            if (!r || typeof r !== 'object') continue;
            // f107-history.js emits {date: 'YYYY-MM-DD', flux_sfu, kind}.
            const t = r.t != null ? _parseT(r.t)
                    : r.date ? Date.parse(r.date + 'T12:00:00Z')
                    : NaN;
            const f107 = Number.isFinite(r.flux_sfu) ? r.flux_sfu
                       : Number.isFinite(r.f107)    ? r.f107
                       : NaN;
            if (!Number.isFinite(t) || !Number.isFinite(f107)) continue;
            out.push({ t, f107, ap: NaN, kind: r.kind || 'observed' });
        }
    }

    if (Array.isArray(apRows)) {
        for (const r of apRows) {
            if (!r || typeof r !== 'object') continue;
            const t = _parseT(r.t);
            const ap = Number.isFinite(r.ap) ? r.ap : NaN;
            if (!Number.isFinite(t) || !Number.isFinite(ap)) continue;
            out.push({ t, f107: NaN, ap, kind: r.kind || 'observed' });
        }
    }

    out.sort((a, b) => a.t - b.t);
    return out;
}

/** Most-recent observed scalar of each kind — used for the nowcast card. */
function _deriveNowcast(history) {
    let f107 = null, ap = null, latestT = 0;
    for (let i = history.length - 1; i >= 0; i--) {
        const r = history[i];
        if (r.kind && r.kind !== 'observed') continue;
        if (f107 == null && Number.isFinite(r.f107)) f107 = r.f107;
        if (ap   == null && Number.isFinite(r.ap))   ap   = r.ap;
        if (r.t > latestT) latestT = r.t;
        if (f107 != null && ap != null) break;
    }
    if (f107 == null && ap == null) return null;
    return { f107, ap, t: latestT, source: 'noaa-history' };
}

// ── Fetch helpers ───────────────────────────────────────────────────────────

async function _timedFetchJson(url, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: ctl.signal,
            headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

/** Fall-through path when the history endpoints are unreachable: pull the
 *  shared `fetchLiveIndices` nowcast and seed a one-row history. AR(1) will
 *  collapse to persistence (σ = 0); the HUD treats that as low-confidence. */
async function _fallbackLiveOnly() {
    try {
        const live = await fetchLiveIndices({ timeoutMs: FETCH_TIMEOUT_MS });
        if (!live) return null;
        const t = Date.now();
        const f107 = Number.isFinite(live.f107Sfu) ? live.f107Sfu : NaN;
        const ap   = Number.isFinite(live.ap) ? live.ap
                   : Number.isFinite(live.kp) ? kpToAp(live.kp)
                   : NaN;
        if (!Number.isFinite(f107) && !Number.isFinite(ap)) return null;
        const history = [{ t, f107, ap, kind: 'observed' }];
        return {
            history,
            nowcast: { f107, ap, t, source: live.source || 'noaa-direct' },
        };
    } catch (_) {
        return null;
    }
}

async function _doFetch() {
    _lastFetchTriedMs = Date.now();

    // Try both history endpoints in parallel. Partial success is fine — if one
    // returns and the other doesn't, the projector just won't have data for
    // the missing scalar, and `getForecast` will return NaN for that channel.
    const [f107Res, apRes] = await Promise.allSettled([
        _timedFetchJson('/api/noaa/f107-history', FETCH_TIMEOUT_MS),
        _timedFetchJson('/api/noaa/ap-history',   FETCH_TIMEOUT_MS),
    ]);

    const f107Rows = f107Res.status === 'fulfilled' ? f107Res.value?.data?.rows : null;
    const apRows   = apRes.status   === 'fulfilled' ? apRes.value?.data?.rows   : null;

    if (!f107Rows && !apRows) {
        // Both histories down — try the live-indices nowcast.
        const fallback = await _fallbackLiveOnly();
        if (!fallback) {
            _lastStatus = {
                source: 'unavailable',
                samples: _history.length,
                stale: true,
                ageSec: Math.round((Date.now() - _lastFetchOkMs) / 1000),
                error: 'noaa-unreachable',
            };
            return _lastStatus;
        }
        _history = fallback.history;
        _nowcast = fallback.nowcast;
        _lastFetchOkMs = Date.now();
        _lastStatus = {
            source: 'live-indices',
            samples: _history.length,
            stale: false,
            ageSec: 0,
        };
        return _lastStatus;
    }

    _history = _mergeHistory(f107Rows, apRows);
    _nowcast = _deriveNowcast(_history) || _nowcast;
    _lastFetchOkMs = Date.now();
    _lastStatus = {
        source: 'noaa-history',
        samples: _history.length,
        f107Samples: f107Rows?.length ?? 0,
        apSamples:   apRows?.length   ?? 0,
        stale: false,
        ageSec: 0,
    };
    return _lastStatus;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Ensure the forecast cache is warm. Safe to call repeatedly — it dedupes
 * concurrent calls and skips the network when fresh.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxAgeMs=300000] — refresh threshold in ms
 * @param {boolean} [opts.force=false]    — bypass the freshness check
 * @returns {Promise<object>} latest status snapshot
 */
export async function ensureForecastReady(opts = {}) {
    const maxAge = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS;
    const force  = !!opts.force;
    const age    = Date.now() - _lastFetchOkMs;

    if (!force && _lastFetchOkMs > 0 && age < maxAge) {
        return { ..._lastStatus, ageSec: Math.round(age / 1000), stale: false };
    }
    if (_inFlight) return _inFlight;

    _inFlight = _doFetch().finally(() => { _inFlight = null; });
    return _inFlight;
}

/**
 * Merged history ring as the projector expects it. Read-only — callers must
 * not mutate the returned array.
 */
export function getHistory() {
    return _history;
}

/**
 * Latest observed F10.7 / Ap point. Returns null until at least one
 * fetch has succeeded.
 */
export function getNowcast() {
    if (!_nowcast) return null;
    return {
        ..._nowcast,
        ageSec: Math.round((Date.now() - _nowcast.t) / 1000),
    };
}

/**
 * AR(1) projection at a single horizon. Honors any active mission override.
 *
 * @param {object} [opts]
 * @param {number} [opts.horizonHours=1]
 * @param {boolean} [opts.envelope=true] — include benign / adverse forcing
 * @returns {object} projector output (see drag-forecast-projector.js)
 */
export function getForecast(opts = {}) {
    const h = Number.isFinite(opts.horizonHours) ? Math.max(0, opts.horizonHours) : 1;
    const useEnvelope = opts.envelope !== false;

    const base = useEnvelope
        ? projectDragEnvelope(_history, h)
        : projectDragState(_history, h);

    if (typeof _missionOverride === 'function') {
        try {
            const out = _missionOverride(h, base, opts);
            if (out && typeof out === 'object') return out;
        } catch (err) {
            // Missions must not break the HUD. Log to console for dev; fall back.
            if (typeof console !== 'undefined') {
                console.warn('[satellite-designer-forecast] mission override threw:', err);
            }
        }
    }
    return base;
}

/**
 * Project multiple horizons at once (convenience for the STORM RADAR strip).
 */
export const DEFAULT_HORIZONS_HOURS = [0, 1, 3, 6, 12];

export function getForecastSeries(opts = {}) {
    const horizons = Array.isArray(opts.horizons) && opts.horizons.length
        ? opts.horizons : DEFAULT_HORIZONS_HOURS;
    const envelope = opts.envelope !== false;
    return horizons.map(h => getForecast({ horizonHours: h, envelope }));
}

/**
 * Diagnostic surface for the HUD and dev tools.
 */
export function getStatus() {
    return {
        ..._lastStatus,
        ageSec: _lastFetchOkMs ? Math.round((Date.now() - _lastFetchOkMs) / 1000) : null,
        triedAgeSec: _lastFetchTriedMs ? Math.round((Date.now() - _lastFetchTriedMs) / 1000) : null,
        hasOverride: typeof _missionOverride === 'function',
    };
}

/**
 * Register a mission-scripted forecast modifier. Pass `null` to clear.
 *
 *   fn(horizonHours, baseForecast, opts) → forecast | null
 *
 * Return `null` from the override to fall through to the live projection
 * for that horizon (useful when a scripted spike has a finite duration and
 * you want pre-/post-spike horizons to show real data).
 */
export function setMissionOverride(fn) {
    _missionOverride = typeof fn === 'function' ? fn : null;
}

/**
 * Reset all module state. Used by tests.
 */
export function __resetForTests() {
    _history = [];
    _nowcast = null;
    _lastFetchOkMs = 0;
    _lastFetchTriedMs = 0;
    _lastStatus = { source: 'unloaded', samples: 0, stale: true };
    _inFlight = null;
    _missionOverride = null;
}
