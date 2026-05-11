/**
 * nrlmsise00-bridge.js — JS adapter for the vendored NRLMSISE-00 WASM
 * ═══════════════════════════════════════════════════════════════════════════
 * Wraps the Rust/WASM exports (see rust-sgp4/src/nrlmsise00.rs) so the
 * rest of the page can call the gold-standard NRL atmosphere model with
 * a contract that matches the existing `sampleProfile()` shape from
 * upper-atmosphere-engine.js — drop-in replacement for the surrogate.
 *
 *   • Singleton WASM loader (shared instance with TrajectoryAnalyzer)
 *   • `sampleProfileMSIS({...})` returns the same `{ samples, T, ... }`
 *     shape the rest of the codebase consumes
 *   • Builds the 7-element ap_array NRLMSISE-00 wants from whatever
 *     subset of geomagnetic-history data we have available
 *   • Computes f107a (81-day centred average) from the realtime ring
 *     buffer when present, falling back to the scalar daily flux
 *
 * Why a separate module instead of folding into upper-atmosphere-engine.js?
 * The engine is sync (pure JS, no I/O); WASM init is async. Keeping the
 * bridge separate lets callers `await` once at boot and then call the
 * same sync API without sprinkling promises through every analyzer pass.
 */

import {
    nrlmsise00_density_point,
    nrlmsise00_density_profile,
    nrlmsise00_profile_stride,
    default as initWasm,
} from './sgp4-wasm/sgp4_wasm.js';
import { SPECIES, SPECIES_MASS_KG } from './upper-atmosphere-engine.js';
import {
    ensureLoaded as ensureF107HistoryLoaded,
    getF107A as getRealF107A,
    getF107AWithProvenance,
    isLoaded as isF107HistoryLoaded,
} from './f107-history.js';

// Kick the F10.7 history fetch at module-load. The endpoint is edge-
// cached at 1 hour, so this is one cheap warm-up roundtrip per page;
// every subsequent `computeF107A()` call is sync against the in-memory
// rows. Failure is swallowed — callers fall back to the ring-buffer
// proxy (existing pre-Phase-7 behaviour) automatically.
ensureF107HistoryLoaded().catch(() => {});

// ── WASM init (shared with TrajectoryAnalyzer) ──────────────────────────────

let _wasmReady = null;

export function ensureMsisReady() {
    if (_wasmReady) return _wasmReady;
    _wasmReady = (async () => {
        await initWasm();
        return true;
    })().catch(err => {
        // Surface the failure once; callers fall back to MSIS-lite.
        console.warn('[nrlmsise00-bridge] WASM init failed:', err);
        _wasmReady = null;
        return false;
    });
    return _wasmReady;
}

/** True once `ensureMsisReady()` has resolved successfully. */
export function isMsisReady() {
    // Crude but useful — `_wasmReady` is a Promise that resolves to true
    // on success. We don't wait here; just report the latest known state.
    return _wasmReady !== null && typeof nrlmsise00_density_point === 'function';
}

// ── Time helpers ────────────────────────────────────────────────────────────

/**
 * Day-of-year (1..366) for a given Date, UTC.
 */
function _doy(d) {
    const start = Date.UTC(d.getUTCFullYear(), 0, 0);
    const diff = d.getTime() - start;
    return Math.floor(diff / 86400000);
}

/** UT seconds-into-day (0..86400). */
function _utSec(d) {
    return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()
         + d.getUTCMilliseconds() / 1000;
}

/** Local apparent solar time (hours, 0..24) at longitude. */
function _lstHr(d, lonDeg) {
    return ((_utSec(d) / 3600) + lonDeg / 15 + 24) % 24;
}

// ── Geomagnetic-history packing ──────────────────────────────────────────────
//
// NRLMSISE-00 wants seven ap values:
//   [0] daily Ap
//   [1] 3-h Ap at current time
//   [2] 3-h Ap, 3 h earlier
//   [3] 3-h Ap, 6 h earlier
//   [4] 3-h Ap, 9 h earlier
//   [5] mean of eight 3-h Ap from 12..33 h earlier
//   [6] mean of eight 3-h Ap from 36..57 h earlier
//
// Our realtime ring buffer holds (timeMs, ap) samples at sub-hour cadence.
// When we have history, we pick the closest sample to each lag bucket.
// When we don't (cold start, single live value), we replicate the
// instantaneous Ap across all seven slots — which is what the model's
// "scalar Ap" mode does anyway, so the result degrades gracefully.

const _AP_LAGS_HR = [0, 0, 3, 6, 9, 22.5, 46.5];

/**
 * Build the 7-element Ap history array from a (history, currentAp) pair.
 *
 * @param {Array<{simTimeMs, ap}>} history     past realtime ticks
 * @param {number} currentAp                  fallback when history empty
 * @param {number} [nowMs=Date.now()]         "now" for lag computation
 * @returns {Float64Array}                     7-element array, m³-side ready
 */
export function buildApHistory(history, currentAp, nowMs = Date.now()) {
    const out = new Float64Array(7);
    const fallback = Number.isFinite(currentAp) ? currentAp : 4;
    if (!Array.isArray(history) || history.length === 0) {
        out.fill(fallback);
        return out;
    }
    // Bucketed sample picker: scan the history once and bin into the lag
    // slots. For the two long-window slots (5 and 6) we average across
    // the lag span rather than picking a single nearest sample.
    let sum5 = 0, n5 = 0, sum6 = 0, n6 = 0;
    let nearest = new Array(5).fill(null);
    let nearDist = new Array(5).fill(Infinity);
    for (const h of history) {
        if (!Number.isFinite(h?.ap) || !Number.isFinite(h?.simTimeMs)) continue;
        const lagHr = (nowMs - h.simTimeMs) / 3600000;
        if (lagHr < 0) continue;
        // Long-window averages.
        if (lagHr >= 12 && lagHr <= 33)  { sum5 += h.ap; n5++; }
        if (lagHr >= 36 && lagHr <= 57)  { sum6 += h.ap; n6++; }
        // Nearest-sample buckets (slots 0..4).
        for (let i = 0; i < 5; i++) {
            const d = Math.abs(lagHr - _AP_LAGS_HR[i]);
            if (d < nearDist[i]) { nearDist[i] = d; nearest[i] = h.ap; }
        }
    }
    for (let i = 0; i < 5; i++) out[i] = nearest[i] ?? fallback;
    out[5] = n5 > 0 ? sum5 / n5 : fallback;
    out[6] = n6 > 0 ? sum6 / n6 : fallback;
    return out;
}

/**
 * Compute the 81-day centred F10.7 average (NRLMSISE-00's `f107A`).
 *
 * Priority order:
 *   1. Real SWPC daily series via `/api/noaa/f107-history` — centred
 *      81-day window when the predicted feed is healthy, trailing
 *      otherwise. Loaded lazily once per page (see ensureF107HistoryLoaded
 *      kick-off at module-load above).
 *   2. Mean of the realtime ring buffer's f107 samples — Phase 3/4
 *      fallback; correct to ~0.5 SFU within ±24 h of "now" because
 *      F10.7 is strongly autocorrelated (φ ≈ 0.94 typical).
 *   3. Scalar fallback (instantaneous flux) — operator default 150.
 *
 * @param {Array} history          realtime ring buffer
 * @param {number} currentF107     last-known instantaneous flux
 * @param {Date}   [forDate]       date at which to evaluate (default: now)
 * @returns {number}               F10.7 average for the requested date
 */
export function computeF107A(history, currentF107, forDate) {
    const dateMs = forDate instanceof Date ? forDate.getTime() : Date.now();

    // 1. Real SWPC daily series (preferred).
    if (isF107HistoryLoaded()) {
        const real = getRealF107A(dateMs);
        if (Number.isFinite(real)) return real;
    }

    // 2. Ring-buffer mean (the original Phase 4 implementation).
    if (Array.isArray(history) && history.length > 0) {
        let sum = 0, n = 0;
        for (const h of history) {
            if (Number.isFinite(h?.f107)) { sum += h.f107; n++; }
        }
        if (n > 0) return sum / n;
    }

    // 3. Last resort.
    return Number.isFinite(currentF107) ? currentF107 : 150;
}

/**
 * Provenance breakdown for the value `computeF107A()` would return at
 * the given date. Lets UI surfaces (the model-state badge, the per-card
 * skill chip) tell the operator which f107A source was used —
 * 'centred' (real SWPC, with predicted samples in the window) is the
 * gold standard, 'trailing' (real SWPC, observed-only) is biased on
 * fast solar climbs, 'ring-buffer' is the in-page proxy.
 */
export function f107AProvenance(history, forDate) {
    const dateMs = forDate instanceof Date ? forDate.getTime() : Date.now();
    if (isF107HistoryLoaded()) {
        const p = getF107AWithProvenance(dateMs);
        if (p && Number.isFinite(p.value)) return p;
    }
    return {
        value: null,
        kind:  Array.isArray(history) && history.length > 0
            ? 'ring-buffer' : 'fallback',
        windowDays: 81,
    };
}

// ── Public API: profile sampling ────────────────────────────────────────────

/**
 * Sample the NRLMSISE-00 atmosphere on a dense altitude grid and return a
 * shape compatible with `upper-atmosphere-engine.js#sampleProfile()`.
 * Each entry: `{ altitudeKm, T, Tinf, rho, nTotal, mBar, fractions, n }`.
 *
 * If WASM isn't ready or the call throws, returns null — callers should
 * fall back to the JS surrogate (`sampleProfile`).
 *
 * @param {object} opts
 * @param {number} [opts.f107Sfu=150]   daily F10.7
 * @param {number} [opts.f107a]         81-day F10.7 (defaults to f107Sfu)
 * @param {number} [opts.ap=15]         instantaneous Ap (used when ap_a missing)
 * @param {Float64Array} [opts.apHistory]  7-element ap_array; built from history if absent
 * @param {Array} [opts.history]        realtime ring buffer (for ap/f107a derivation)
 * @param {number} [opts.minKm=80]
 * @param {number} [opts.maxKm=2000]
 * @param {number} [opts.nPoints=200]
 * @param {number} [opts.latDeg=0]      sub-satellite latitude (sun-relative diurnal effects)
 * @param {number} [opts.lonDeg=0]
 * @param {Date}   [opts.nowDate=new Date()]
 */
export function sampleProfileMSIS({
    f107Sfu = 150,
    f107a,
    ap = 15,
    apHistory,
    history,
    minKm = 80,
    maxKm = 2000,
    nPoints = 200,
    latDeg = 0,
    lonDeg = 0,
    nowDate = new Date(),
} = {}) {
    if (!isMsisReady()) return null;

    const f107   = f107Sfu;
    const f107A  = Number.isFinite(f107a) ? f107a : computeF107A(history, f107, nowDate);
    const f107AProv = Number.isFinite(f107a)
        ? { value: f107a, kind: 'caller-supplied', windowDays: 81 }
        : f107AProvenance(history, nowDate);
    const apArr  = apHistory instanceof Float64Array && apHistory.length === 7
        ? apHistory
        : buildApHistory(history, ap, nowDate.getTime());

    const doy   = _doy(nowDate);
    const sec   = _utSec(nowDate);
    const lstHr = _lstHr(nowDate, lonDeg);

    const alts = new Float64Array(nPoints);
    for (let i = 0; i < nPoints; i++) {
        alts[i] = minKm + (maxKm - minKm) * (i / (nPoints - 1));
    }

    let flat;
    try {
        flat = nrlmsise00_density_profile(
            nowDate.getUTCFullYear(), doy, sec,
            latDeg, lonDeg, lstHr,
            f107A, f107, apArr,
            alts,
        );
    } catch (err) {
        console.warn('[nrlmsise00-bridge] density_profile threw:', err);
        return null;
    }
    if (!flat || flat.length === 0) return null;

    const stride = nrlmsise00_profile_stride();
    // Stride layout: [alt, He, O, N2, O2, Ar, mass_kg_m3, H, N, anomO, T_exo, T_alt]
    const samples = new Array(nPoints);
    for (let i = 0; i < nPoints; i++) {
        const o = i * stride;
        const altitudeKm = flat[o];
        const He   = flat[o + 1];
        const Oat  = flat[o + 2];
        const N2   = flat[o + 3];
        const O2   = flat[o + 4];
        const Ar   = flat[o + 5];
        const rho  = flat[o + 6];
        const H    = flat[o + 7];
        const Nat  = flat[o + 8];
        const anomO = flat[o + 9];
        const Tinf  = flat[o + 10];
        const T     = flat[o + 11];
        // Map NRLMSISE-00 species onto the engine's 7-species vocabulary.
        // We don't have NO from MSIS (it's not a major composition driver
        // above 80 km — peaks at the D/E layer transition); seed it from
        // the engine's anchor curve fraction. For drag-decay all that
        // matters is the total mass density, which IS bit-exact.
        const n = {
            He: He, O: Oat, N2: N2, O2: O2, N: Nat, H: H,
            // Anomalous oxygen contributes a tiny extra density above
            // 500 km that's important for drag but not for chemistry —
            // fold it into atomic O for the species panel.
            NO: 0,
        };
        n.O += anomO;
        const nTotal = He + Oat + N2 + O2 + Ar + Nat + H + anomO;
        const fractions = {};
        for (const s of SPECIES) {
            fractions[s] = nTotal > 0 ? (n[s] || 0) / nTotal : 0;
        }
        // Ar isn't in our SPECIES list — its mass density still goes
        // into rho via the model; for the panel it's negligible above
        // ~150 km (~1% by mass max).
        let mBar = 0;
        for (const s of SPECIES) mBar += fractions[s] * SPECIES_MASS_KG[s];
        samples[i] = { altitudeKm, T, Tinf, rho, nTotal, mBar, fractions, n };
    }

    return {
        f107Sfu: f107,
        f107a:   f107A,
        ap,
        apHistory: Array.from(apArr),
        T: samples[samples.length - 1].Tinf,    // exobase temp
        samples,
        provenance: {
            model:   'NRLMSISE-00',
            source:  'rust-sgp4 + Brodowski 2002 C port',
            issuedAt: nowDate.toISOString(),
            // f107a provenance — 'centred' (real SWPC w/ predicted samples
            // in the window, ideal), 'trailing' (real SWPC, observed-only,
            // biased on fast climbs), 'ring-buffer' (in-page proxy), or
            // 'caller-supplied' / 'fallback'.
            f107a: f107AProv,
        },
    };
}

/**
 * Single-point density evaluation (kg/m³ + temperatures), matching the
 * engine's `density()` shape minimally. Useful when callers just want
 * the live `q = ½ρv²` number under MSIS rather than the full profile.
 */
export function densityPointMSIS({
    altitudeKm,
    f107Sfu = 150, f107a, ap = 15, apHistory, history,
    latDeg = 0, lonDeg = 0, nowDate = new Date(),
}) {
    if (!isMsisReady()) return null;
    const f107A  = Number.isFinite(f107a) ? f107a : computeF107A(history, f107Sfu);
    const apArr  = apHistory instanceof Float64Array && apHistory.length === 7
        ? apHistory : buildApHistory(history, ap, nowDate.getTime());
    const arr = nrlmsise00_density_point(
        nowDate.getUTCFullYear(), _doy(nowDate), _utSec(nowDate),
        altitudeKm, latDeg, lonDeg, _lstHr(nowDate, lonDeg),
        f107A, f107Sfu, apArr,
    );
    return {
        altitudeKm,
        rho:  arr[5],
        Tinf: arr[9],
        T:    arr[10],
        n:    { He: arr[0], O: arr[1] + arr[8], N2: arr[2], O2: arr[3], N: arr[7], H: arr[6], NO: 0 },
    };
}
