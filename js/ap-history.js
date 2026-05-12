/**
 * ap-history.js — 3-hourly Ap series + NRLMSISE-00 ap_array assembler
 * ═══════════════════════════════════════════════════════════════════════════
 * Singleton client for the `/api/noaa/ap-history` proxy. Mirrors the
 * f107-history client pattern: lazy fetch, in-memory cache, subscribe-on-
 * refresh, plus a date-keyed `getApArray(dateMs)` that builds the
 * NRLMSISE-00 7-element ap_array at any time within the cached window.
 *
 * The endpoint precomputes `current_ap_array` for "now" so the steady-state
 * NRLMSISE-00 call doesn't have to reassemble it from rows on every tick;
 * we mirror that on the client. For arbitrary dates (TLE epoch in the
 * past, MC sample at a future tick) we recompute from rows locally.
 *
 * ap_array shape, matching Brodowski's struct exactly:
 *
 *   [0] daily Ap (mean of the 8 most-recent 3-h observed ticks, 24 h)
 *   [1] 3-h Ap at current time
 *   [2] 3-h Ap, 3 h earlier
 *   [3] 3-h Ap, 6 h earlier
 *   [4] 3-h Ap, 9 h earlier
 *   [5] mean of 3-h Ap, 12..33 h prior
 *   [6] mean of 3-h Ap, 36..57 h prior
 *
 * Failure modes (graceful):
 *   - Endpoint down → getApArray() returns null; bridge falls back to
 *     the in-page ring-buffer assembler (Phase 4 default).
 *   - Partial data (predicted feed unavailable) → ap_array uses observed
 *     only; for past-dated lookups still works exactly the same.
 *   - Date outside cached window → returns null + provenance hint.
 */

const CACHE_TTL_MS = 3_600_000;   // 1 h, aligned with the edge cache

let _state = {
    rows:             [],            // [{ t: ISO, tMs: number, ap, kind }]
    observedTicks:    0,
    predictedTicks:   0,
    currentApArray:   null,          // server-precomputed for "now"
    currentDailyAp:   null,
    fetchedAtMs:      0,
    fetchedOk:        false,
    source:           null,
    warnings:         [],
};
let _inFlight = null;
const _subs = new Set();

async function _fetchOnce() {
    try {
        const res = await fetch('/api/noaa/ap-history', { cache: 'default' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const d = body?.data || {};
        const rowsRaw = Array.isArray(d.rows) ? d.rows : [];
        // Parse the ISO timestamps once at ingestion. The rest of the
        // client uses tMs directly so we don't re-parse on every
        // ap_array recomputation.
        const rows = rowsRaw.map(r => ({
            t:    r.t,
            tMs:  Date.parse(r.t),
            ap:   Number(r.ap),
            kind: r.kind,
        })).filter(r => Number.isFinite(r.tMs) && Number.isFinite(r.ap));
        _state = {
            rows,
            observedTicks:   d.observed_ticks  || 0,
            predictedTicks:  d.predicted_ticks || 0,
            currentApArray:  Array.isArray(d.current_ap_array) ? d.current_ap_array : null,
            currentDailyAp:  Number.isFinite(d.current_daily_ap) ? d.current_daily_ap : null,
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
        console.warn('[ap-history] fetch failed:', err?.message || err);
        return _state;
    }
}

export async function ensureLoaded() {
    const age = Date.now() - _state.fetchedAtMs;
    if (_state.fetchedOk && age < CACHE_TTL_MS) return _state;
    if (_inFlight) return _inFlight;
    _inFlight = _fetchOnce().finally(() => { _inFlight = null; });
    return _inFlight;
}

export async function refresh() {
    _inFlight = _fetchOnce().finally(() => { _inFlight = null; });
    return _inFlight;
}

// ── ap_array assembler (mirrors server logic) ───────────────────────────────
//
// Computes the 7-element ap_array at an arbitrary `dateMs`. For dateMs ≈ now
// we could return the server-precomputed `currentApArray`, but we recompute
// locally anyway because:
//   1. Date-arithmetic is microseconds — not worth a special case.
//   2. Date inside the predicted window (e.g. an MC sample at "now+12h")
//      gets a future-anchored ap_array assembled from observed PAST +
//      predicted FUTURE ticks; the server only does the "now" anchor.

function _nearest(rows, targetMs) {
    let best = null, bestD = Infinity;
    for (const r of rows) {
        const d = Math.abs(r.tMs - targetMs);
        if (d < bestD) { bestD = d; best = r; }
    }
    // Reject "nearest" matches that are more than 6 h away — that means
    // we're outside the cached window and shouldn't pretend otherwise.
    return (best && bestD < 6 * 3600000) ? best.ap : null;
}
function _meanInWindow(rows, loTMs, hiTMs) {
    let sum = 0, n = 0;
    for (const r of rows) {
        if (r.tMs >= loTMs && r.tMs <= hiTMs) { sum += r.ap; n++; }
    }
    return n > 0 ? sum / n : null;
}

/**
 * Build the 7-element ap_array for the given date. Returns null if the
 * series isn't loaded or the date is outside the cached window. The
 * fallback (climatology Ap=4) is the bridge's responsibility — we
 * surface null here so the caller can tell "real data" from "fallback".
 */
export function getApArray(dateMs = Date.now()) {
    if (!_state.fetchedOk || _state.rows.length === 0) return null;
    const rows = _state.rows;
    // Sanity: the date should fall within ~observed-start to predicted-end.
    if (dateMs < rows[0].tMs - 3600000 || dateMs > rows[rows.length - 1].tMs + 3600000) {
        return null;
    }
    const out = [
        _meanInWindow(rows, dateMs - 24 * 3600000, dateMs),                       // [0] daily Ap
        _nearest(rows, dateMs),                                                   // [1] 0 h
        _nearest(rows, dateMs - 3  * 3600000),                                    // [2] 3 h
        _nearest(rows, dateMs - 6  * 3600000),                                    // [3] 6 h
        _nearest(rows, dateMs - 9  * 3600000),                                    // [4] 9 h
        _meanInWindow(rows, dateMs - 33 * 3600000, dateMs - 12 * 3600000),        // [5] 12..33 h
        _meanInWindow(rows, dateMs - 57 * 3600000, dateMs - 36 * 3600000),        // [6] 36..57 h
    ];
    // Any null slot → degrade to climatology Ap=4 for that slot. The bridge
    // will see the array is non-null and use it; the operator's UI shows
    // the slot's degraded value via the provenance helper below.
    return out.map(v => Number.isFinite(v) ? v : 4);
}

/**
 * Same as `getApArray` but explicit about how the array was assembled. Used
 * by the UI to show "real / partial / fallback" badges.
 */
export function getApArrayWithProvenance(dateMs = Date.now()) {
    const arr = getApArray(dateMs);
    if (!arr) {
        return {
            value: null,
            kind:  _state.rows.length > 0 ? 'out-of-range' : 'unavailable',
        };
    }
    // Tally how many slots fell back to the climatology Ap=4 because their
    // window was empty. Most of the time this is 0 (full series), but
    // during a cold-start fetch or right after a feed outage, slot 6 (36-
    // 57 h) might be empty while slots 1-4 are still good.
    let slotsObserved = 0, slotsPredicted = 0, slotsFallback = 0;
    const rows = _state.rows;
    const isObs = (t) => {
        const row = rows.find(r => Math.abs(r.tMs - t) < 1.5 * 3600000);
        return row?.kind === 'observed';
    };
    // For the 4 nearest-pick slots, classify by the source of the nearest tick.
    for (let i = 1; i <= 4; i++) {
        const lag = [0, 3, 6, 9][i - 1] * 3600000;
        const row = rows.reduce((b, r) => {
            const d = Math.abs(r.tMs - (dateMs - lag));
            return (!b || d < b.d) ? { r, d } : b;
        }, null);
        if (!row || row.d > 6 * 3600000) slotsFallback++;
        else if (row.r.kind === 'predicted') slotsPredicted++;
        else slotsObserved++;
    }
    // Slot 0 (daily) and 5/6 (long means) — mostly observed since they
    // look back, but we attribute to observed if any observed sample is
    // in the window.
    for (const [lo, hi] of [[0, 24], [12, 33], [36, 57]]) {
        const loMs = dateMs - hi * 3600000, hiMs = dateMs - lo * 3600000;
        const any = rows.some(r => r.tMs >= loMs && r.tMs <= hiMs);
        if (!any) slotsFallback++;
        else slotsObserved++;
    }
    return {
        value: arr,
        kind: slotsFallback > 0
            ? (slotsObserved > 0 ? 'partial' : 'fallback')
            : (slotsPredicted > 0 ? 'mixed-observed-predicted' : 'observed'),
        slotsObserved,
        slotsPredicted,
        slotsFallback,
    };
}

export function onUpdate(fn) {
    _subs.add(fn);
    return () => _subs.delete(fn);
}

export function snapshot() {
    return {
        rows:           _state.rows.slice(),
        observedTicks:  _state.observedTicks,
        predictedTicks: _state.predictedTicks,
        currentApArray: _state.currentApArray ? _state.currentApArray.slice() : null,
        currentDailyAp: _state.currentDailyAp,
        fetchedAtMs:    _state.fetchedAtMs,
        fetchedOk:      _state.fetchedOk,
        source:         _state.source,
        warnings:       _state.warnings.slice(),
    };
}

export function isLoaded() {
    return _state.fetchedOk && _state.rows.length > 0;
}

/**
 * Daily-mean Ap at a given date — operator-grade lookup for backtests.
 * Averages the eight 3-h Ap ticks centred on the requested day's UTC
 * midnight (i.e. within ±12 h). Returns null when:
 *   - the series isn't loaded
 *   - the date predates the cached window (we don't extrapolate)
 *   - fewer than 4 of the 8 ticks fall inside the window (the day is
 *     too data-poor to call a "daily mean")
 *
 * `observedOnly` defaults to true: backtests only see what the model
 * HAD when it was being run historically.
 */
export function getApDailyMeanAt(dateMs, { observedOnly = true } = {}) {
    if (!_state.fetchedOk || _state.rows.length === 0) return null;
    const loMs = dateMs - 12 * 3600000;
    const hiMs = dateMs + 12 * 3600000;
    let sum = 0, n = 0;
    for (const r of _state.rows) {
        if (observedOnly && r.kind !== 'observed') continue;
        if (r.tMs >= loMs && r.tMs <= hiMs) { sum += r.ap; n++; }
    }
    return n >= 4 ? sum / n : null;
}
