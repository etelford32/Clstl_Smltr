/**
 * f107-history.js — F10.7 daily series + 81-day centred average
 * ═══════════════════════════════════════════════════════════════════════════
 * Singleton client for the `/api/noaa/f107-history` proxy. Fetches the
 * merged observed + 45-day-predicted F10.7 daily series once at boot,
 * caches it in memory, and exposes:
 *
 *   • getF107A(dateMs)   — NRLMSISE-00's `f107A`: centred 81-day average
 *                          of F10.7 at the given date. Falls through to
 *                          trailing 81-day, then 27-day trailing, then
 *                          null when even the observed feed is empty.
 *   • onUpdate(fn)       — subscribe to refresh events so consumers can
 *                          recompute their analyzer caches the moment
 *                          fresh data lands.
 *   • snapshot()         — read-only view of the current series, useful
 *                          for charts and provenance badges.
 *
 * Why a singleton: NRLMSISE-00 wants a *centred* 81-day window, which
 * means the same series is needed by every drag-decay scenario the
 * fleet analyzer runs (potentially hundreds per fleet refresh). One
 * fetch per page lifetime + an in-memory closure is the right shape.
 * The endpoint is edge-cached at 1 hour anyway, so we just align.
 *
 * Failure modes (all graceful):
 *   • Endpoint down → getF107A() returns null; callers fall back to
 *     ring-buffer mean (existing pre-Phase-7 behaviour).
 *   • Partial data (predicted feed timed out) → centred avg uses
 *     observed only; same average as the trailing-81d value.
 *   • Date out of range (TLE epoch from 2010) → null; caller falls
 *     back to ring-buffer / current f107.
 */

// In-memory cache. Re-fetch only when:
//   - never fetched
//   - last fetch is older than CACHE_TTL_MS (matches edge cache)
//   - an explicit refresh() call from a consumer
const CACHE_TTL_MS = 3_600_000;   // 1 hour
const WINDOW_DAYS  = 81;

let _state = {
    rows:                  [],       // chronological merged series
    observedDays:          0,
    predictedDays:         0,
    centredF107A:          null,     // server-precomputed centred avg
    trailingF107A:         null,
    trailing27F107A:       null,
    fetchedAtMs:           0,
    fetchedOk:             false,
    source:                null,
    warnings:              [],
};
let _inFlight = null;
const _subs = new Set();

// ── Date helpers (UTC, day-resolution) ──────────────────────────────────────

function _ymdToMs(ymd) {
    if (!ymd || typeof ymd !== 'string') return NaN;
    const [y, m, d] = ymd.split('-').map(Number);
    return Date.UTC(y, m - 1, d, 12, 0, 0);   // noon-UTC anchor matches the proxy
}

function _daysBetween(aMs, bMs) {
    return Math.round((bMs - aMs) / 86400000);
}

// ── Fetcher ─────────────────────────────────────────────────────────────────

async function _fetchOnce() {
    try {
        const res = await fetch('/api/noaa/f107-history', { cache: 'default' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const d = body?.data || {};
        const rows = Array.isArray(d.rows) ? d.rows : [];
        _state = {
            rows,
            observedDays:    d.observed_days  || 0,
            predictedDays:   d.predicted_days || 0,
            centredF107A:    Number.isFinite(d.computed_f107a_centred)
                ? d.computed_f107a_centred : null,
            trailingF107A:   Number.isFinite(d.computed_f107a_trailing)
                ? d.computed_f107a_trailing : null,
            trailing27F107A: Number.isFinite(d.computed_f107a_27d_trailing)
                ? d.computed_f107a_27d_trailing : null,
            fetchedAtMs:     Date.now(),
            fetchedOk:       true,
            source:          body?.source ?? null,
            warnings:        Array.isArray(d.warnings) ? d.warnings : [],
        };
        for (const fn of _subs) { try { fn(snapshot()); } catch (_) {} }
        return _state;
    } catch (err) {
        _state.fetchedAtMs = Date.now();
        _state.fetchedOk = false;
        console.warn('[f107-history] fetch failed:', err?.message || err);
        return _state;
    }
}

/**
 * Ensure we have a recent series in memory. Cheap when already loaded:
 * returns the cached state without re-fetching unless past the TTL.
 */
export async function ensureLoaded() {
    const age = Date.now() - _state.fetchedAtMs;
    if (_state.fetchedOk && age < CACHE_TTL_MS) return _state;
    if (_inFlight) return _inFlight;
    _inFlight = _fetchOnce().finally(() => { _inFlight = null; });
    return _inFlight;
}

/** Force a re-fetch regardless of TTL — for manual refresh buttons. */
export async function refresh() {
    _inFlight = _fetchOnce().finally(() => { _inFlight = null; });
    return _inFlight;
}

// ── Centred 81-day average computed locally ──────────────────────────────────
//
// For arbitrary `dateMs` (most usefully a past TLE epoch) we recompute the
// centred avg from the cached series rather than using the server's
// precomputed `centredF107A`. The server number is for "today" only.

export function getF107A(dateMs = Date.now()) {
    if (!_state.fetchedOk || _state.rows.length === 0) return null;
    const half = Math.floor(WINDOW_DAYS / 2);
    let sum = 0, n = 0;
    for (const r of _state.rows) {
        const t = _ymdToMs(r.date);
        if (!Number.isFinite(t)) continue;
        const dDays = _daysBetween(t, dateMs);
        if (Math.abs(dDays) <= half) {
            sum += r.flux_sfu;
            n++;
        }
    }
    if (n === 0) return null;
    return sum / n;
}

/**
 * Same as getF107A but explicit about what the caller is getting. Useful
 * when the consumer wants to surface a provenance badge ("real / proxy /
 * ring-buffer-fallback") rather than just the number.
 */
export function getF107AWithProvenance(dateMs = Date.now()) {
    const value = getF107A(dateMs);
    if (value == null) {
        return {
            value: null,
            kind:  _state.rows.length > 0 ? 'out-of-range' : 'unavailable',
            windowDays: WINDOW_DAYS,
        };
    }
    // Count how much of the window we filled from observed vs predicted.
    // This tells the user whether the centred avg is operationally
    // bias-free (mostly predicted = bias-free) or trailing-biased
    // (mostly observed = biased during a fast solar climb).
    const half = Math.floor(WINDOW_DAYS / 2);
    let nObs = 0, nPred = 0;
    for (const r of _state.rows) {
        const t = _ymdToMs(r.date);
        if (!Number.isFinite(t)) continue;
        if (Math.abs(_daysBetween(t, dateMs)) > half) continue;
        if (r.kind === 'predicted') nPred++; else nObs++;
    }
    return {
        value,
        kind: nPred > 0 ? 'centred' : 'trailing',
        observedSamples:  nObs,
        predictedSamples: nPred,
        windowDays: WINDOW_DAYS,
    };
}

/** Subscribe to refresh events. fn(snapshot) fires once per successful refetch. */
export function onUpdate(fn) {
    _subs.add(fn);
    return () => _subs.delete(fn);
}

/** Read-only snapshot. */
export function snapshot() {
    return {
        rows:           _state.rows.slice(),
        observedDays:   _state.observedDays,
        predictedDays:  _state.predictedDays,
        centredF107A:   _state.centredF107A,
        trailingF107A:  _state.trailingF107A,
        trailing27F107A: _state.trailing27F107A,
        fetchedAtMs:    _state.fetchedAtMs,
        fetchedOk:      _state.fetchedOk,
        source:         _state.source,
        warnings:       _state.warnings.slice(),
    };
}

/** True iff the series is loaded and at least one row is usable. */
export function isLoaded() {
    return _state.fetchedOk && _state.rows.length > 0;
}
