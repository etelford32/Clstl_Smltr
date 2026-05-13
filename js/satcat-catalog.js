/**
 * satcat-catalog.js — Client-side CelesTrak SATCAT loader.
 *
 * Fetches /api/celestrak/satcat once on demand, normalises the wire
 * format (compact short keys: t / r / rv / s) into a more readable
 * lookup object, and pushes it into debris-catalog.js so the existing
 * `annotate()` callsites pick up upstream-authoritative data for free.
 *
 * The fetch is best-effort: if it fails, debris-catalog.js falls back
 * to its name-pattern heuristic, so every consumer keeps working —
 * just less accurately. Failures don't retry automatically; a manual
 * `loadSatcat({ force: true })` from a debug console would refresh.
 *
 * Why this lives outside debris-catalog.js: keeps that module
 * dependency-free (it's also imported by the upper-atmosphere globe,
 * which builds its catalog from the same heuristic and has its own
 * load lifecycle). The setSatcatLookup() handshake is the seam.
 */

import { setSatcatLookup } from './debris-catalog.js';

const TYPE_TO_CATEGORY = {
    'PAY': 'payload',
    'R/B': 'rocket-body',
    'DEB': 'debris',
    'UNK': 'unknown',
    'TBA': 'unknown',
};

const RCS_TO_CLASS = {
    'S': 'small',
    'M': 'medium',
    'L': 'large',
};

let _records  = null;            // { [noradId]: { t?, r?, rv?, s? } } from the proxy
let _loading  = null;            // in-flight fetch promise (dedupes parallel calls)
let _lastFail = 0;
const _subscribers = new Set();

function notifyLoaded() {
    for (const fn of _subscribers) {
        try { fn(); } catch (err) { console.warn('[satcat] subscriber threw:', err); }
    }
}

/**
 * The lookup object passed to debris-catalog.setSatcatLookup(). Single
 * `get(noradId)` returns a normalised SATCAT record or null, plus a
 * couple of convenience accessors. Stable shape so debris-catalog can
 * code against it without knowing the wire format.
 */
function buildLookup() {
    return {
        get(noradId) {
            if (!_records) return null;
            const rec = _records[noradId];
            if (!rec) return null;
            return {
                objectType:     rec.t || null,
                objectCategory: TYPE_TO_CATEGORY[rec.t] || null,
                rcsSizeCode:    rec.r || null,
                rcsClass:       RCS_TO_CLASS[rec.r] || null,
                rcsRawM2:       Number.isFinite(rec.rv) ? rec.rv : null,
                opsStatusCode:  rec.s || null,
            };
        },
        has(noradId) {
            return !!(_records && _records[noradId]);
        },
        size() {
            return _records ? Object.keys(_records).length : 0;
        },
    };
}

/**
 * Kick off a SATCAT fetch. Idempotent; concurrent calls share the same
 * in-flight promise. After resolution, debris-catalog's lookup is
 * primed and subscribers are notified. Resolves to true on success,
 * false on failure (the caller can decide whether to retry — most
 * shouldn't).
 *
 * @param {{ force?: boolean }} [opts]
 */
export function loadSatcat(opts = {}) {
    if (_records && !opts.force) return Promise.resolve(true);
    if (_loading && !opts.force) return _loading;

    _loading = (async () => {
        try {
            const t0 = performance.now();
            const res = await fetch('/api/celestrak/satcat');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!data?.records || typeof data.records !== 'object') {
                throw new Error('malformed response (no records)');
            }
            _records = data.records;
            setSatcatLookup(buildLookup());
            const dt = (performance.now() - t0).toFixed(0);
            console.info(`[satcat] loaded ${data.count} records in ${dt} ms`);
            notifyLoaded();
            return true;
        } catch (err) {
            console.warn('[satcat] load failed, falling back to heuristic:', err.message);
            _lastFail = Date.now();
            return false;
        } finally {
            _loading = null;
        }
    })();

    return _loading;
}

/**
 * Subscribe to the one-shot "SATCAT just loaded" event. Fires once
 * (immediately if already loaded). Inspector / pill consumers use
 * this to repaint with upgraded data when the fetch lands after the
 * initial render.
 */
export function onSatcatLoaded(fn) {
    if (_records) { try { fn(); } catch (_) {} return () => {}; }
    _subscribers.add(fn);
    return () => _subscribers.delete(fn);
}

export function isSatcatLoaded() { return _records !== null; }
