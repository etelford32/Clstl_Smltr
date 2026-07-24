/**
 * live-driver.js — real-time SWPC driving source for the Shielding Lab.
 *
 * Primary feed: NOAA SWPC `products/geospace/propagated-solar-wind-1-hour`
 * — real-time solar wind ballistically propagated from L1 to 32 Re, the
 * upstream boundary of the operational Geospace (SWMF) model. Its
 * `propagated_time_tag` runs AHEAD of wall clock; that gap is genuine
 * forecast lead time (~30–60 min depending on wind speed), which is what
 * makes LIVE mode a short-horizon nowcast rather than a mirror.
 *
 * Fallback (after 3 consecutive primary failures): the RTSW L1 pair
 * `json/rtsw/rtsw_wind_1m.json` + `rtsw_mag_1m.json` with our own
 * ballistic shift Δt = (d_L1 − 32 Re)/v per sample. The spec'd
 * `products/solar-wind/mag-2-hour.json` fallback is NOT used because that
 * whole directory is RETIRED at NOAA (404s — see the warning block in
 * api/cron/refresh-solar-wind.js; do not "restore" those URLs).
 *
 * House rules honored here:
 *   - Product JSONs are parsed BY HEADER NAME, never positional index
 *     (`rowsFromProduct` pattern from api/cron/refresh-solar-wind.js).
 *     A missing required column throws with the actual header echoed.
 *   - The ring buffer feeds the universal SolarWindDriver contract
 *     (js/solar-wind-driver.js) — no forked per-page driver schema.
 *   - NEVER fabricate or extrapolate: interpolation happens only between
 *     two real bracketing samples; beyond the newest sample values are
 *     HELD and flagged (`held: true`), and the staleness ladder is
 *     fresh → aged (holding ≤ 10 min) → stale (verdict shows DATA GAP).
 *   - Bz/By get a 3-point median filter upstream of the Kan–Lee coupling
 *     function to kill single-sample spikes (disclosed in the page copy).
 *
 * Fetch pattern mirrors js/swpc-feed.js: browser-direct (SWPC is CORS-
 * enabled; `cache:'no-cache'` gives conditional revalidation for free),
 * then the same-origin `/api/noaa/passthrough` mirror on failure. Poll
 * every 60 s ± 5 s jitter, exponential backoff to 5 min on errors.
 *
 * Pure/parsing pieces are exported for Node tests
 * (tests/shielding-live-driver.mjs) — no DOM use in this module.
 */

import { SolarWindDriver } from '../solar-wind-driver.js';

export const PROPAGATED_PATH = 'products/geospace/propagated-solar-wind-1-hour.json';
export const RTSW_WIND_PATH = 'json/rtsw/rtsw_wind_1m.json';
export const RTSW_MAG_PATH = 'json/rtsw/rtsw_mag_1m.json';
const SWPC_BASE = 'https://services.swpc.noaa.gov/';
const F107_API = '/api/noaa/radio-flux';

export const POLL_MS = 60_000;
export const POLL_JITTER_MS = 5_000;
export const BACKOFF_MAX_MS = 300_000;
export const BUFFER_MS = 2 * 3600_000;      // ring buffer: trailing 2 h
export const HOLD_MAX_S = 600;              // hold past newest ≤ 10 min
export const STALE_RESTART_S = 2 * 3600;    // >2 h gap → solver re-seed
export const FALLBACK_AFTER_FAILS = 3;

// L1 → 32 Re ballistic distance for the self-propagated fallback.
const D_L1_KM = 1.5e6;
const D_BOUNDARY_KM = 32 * 6371;

// ── Pure parsing helpers (Node-tested) ─────────────────────────────────

/** NOAA fill sentinels → null (same policy as api/cron/refresh-solar-wind.js). */
export function cleanField(row, ...keys) {
    for (const key of keys) {
        const raw = row?.[key];
        if (raw == null || raw === '') continue;
        const n = Number(raw);
        if (!Number.isFinite(n)) continue;
        if (n <= -9990 || n > 1e20) return null;
        return n;
    }
    return null;
}

/**
 * SWPC "products" payloads are [[header...],[row...],...]. Resolve columns
 * strictly by header name. Throws (echoing the actual header) if the
 * payload shape or a required column is missing — fail loud, never guess.
 */
export function rowsFromProduct(arr, requiredCols = []) {
    if (!Array.isArray(arr) || !Array.isArray(arr[0])) {
        throw new Error('swpc product: expected [[header],[rows...]] array-of-arrays');
    }
    const head = arr[0].map((h) => String(h).trim().toLowerCase());
    for (const col of requiredCols) {
        if (!head.includes(col)) {
            throw new Error(`swpc product: missing column "${col}" in header [${head.join(', ')}]`);
        }
    }
    return arr.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const normTime = (t) => Date.parse(String(t || '').replace(' ', 'T').replace(/Z?$/, 'Z'));

/**
 * Propagated geospace feed → normalized samples keyed on Earth-arrival
 * time. Rows without a parseable propagated_time_tag are dropped; missing
 * physics fields become NaN (SolarWindDriver's explicit-gap value).
 */
export function samplesFromPropagated(json) {
    const rows = rowsFromProduct(json, ['time_tag', 'propagated_time_tag', 'speed', 'bz']);
    const out = [];
    for (const row of rows) {
        const t = normTime(row.propagated_time_tag);
        if (!Number.isFinite(t)) continue;
        const v = cleanField(row, 'speed');
        const bz = cleanField(row, 'bz_gsm', 'bz');
        if (v == null && bz == null) continue; // carries nothing usable
        out.push({
            t,
            obsT: normTime(row.time_tag),
            v: v ?? NaN,
            n: cleanField(row, 'density') ?? NaN,
            bx: cleanField(row, 'bx_gsm', 'bx') ?? NaN,
            by: cleanField(row, 'by_gsm', 'by') ?? NaN,
            bz: bz ?? NaN,
        });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
}

/**
 * RTSW L1 pair (object rows, not products format) → samples merged on the
 * UTC minute and ballistically shifted to the 32 Re boundary using each
 * sample's own measured speed. Minutes lacking a valid positive speed are
 * dropped — Δt needs v, and a mag-only minute cannot be honestly placed.
 */
export function samplesFromRtsw(windRows, magRows) {
    const minuteKey = (ms) => Math.floor(ms / 60_000) * 60_000;
    const byMin = new Map();
    for (const r of Array.isArray(windRows) ? windRows : []) {
        const t = normTime(r?.time_tag);
        if (!Number.isFinite(t)) continue;
        const v = cleanField(r, 'proton_speed', 'speed');
        if (v == null || v <= 0) continue;
        byMin.set(minuteKey(t), {
            obsT: minuteKey(t), v,
            n: cleanField(r, 'proton_density', 'density') ?? NaN,
            bx: NaN, by: NaN, bz: NaN,
        });
    }
    for (const r of Array.isArray(magRows) ? magRows : []) {
        const t = normTime(r?.time_tag);
        if (!Number.isFinite(t)) continue;
        const s = byMin.get(minuteKey(t));
        if (!s) continue;
        s.bx = cleanField(r, 'bx_gsm', 'bx') ?? NaN;
        s.by = cleanField(r, 'by_gsm', 'by') ?? NaN;
        s.bz = cleanField(r, 'bz_gsm', 'bz', 'bz_gse') ?? NaN;
    }
    const out = [];
    for (const s of byMin.values()) {
        const dtS = ((D_L1_KM - D_BOUNDARY_KM) / s.v);   // km / (km/s) = s
        out.push({ ...s, t: s.obsT + dtS * 1000 });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
}

/** 3-point running median (edges pass through). NaN-transparent: a window
 *  containing NaN falls back to the raw center value — the filter kills
 *  spikes, it must never manufacture data across a gap. */
export function medianFilter3(values) {
    const n = values.length;
    if (n < 3) return values.slice();
    const out = values.slice();
    for (let i = 1; i < n - 1; i++) {
        const a = values[i - 1], b = values[i], c = values[i + 1];
        if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c)) continue;
        out[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
    }
    return out;
}

/**
 * Ring buffer of live samples keyed by boundary-arrival time. Dedup on
 * timestamp (newest write wins), trailing-window eviction, and a
 * SolarWindDriver built over the median-filtered series on demand.
 */
export class LiveBuffer {
    constructor({ windowMs = BUFFER_MS } = {}) {
        this.windowMs = windowMs;
        this._byT = new Map();
        this._driver = null;
    }

    get size() { return this._byT.size; }

    /** Ingest a batch; returns how many samples were new/updated. */
    ingest(samples) {
        const eq = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));
        let changed = 0;
        for (const s of samples) {
            if (!Number.isFinite(s.t)) continue;
            const prev = this._byT.get(s.t);
            if (prev && eq(prev.v, s.v) && eq(prev.bz, s.bz) && eq(prev.by, s.by) && eq(prev.n, s.n)) continue;
            this._byT.set(s.t, s);
            changed++;
        }
        if (changed) {
            const newest = this.newestT();
            for (const t of this._byT.keys()) {
                if (t < newest - this.windowMs) this._byT.delete(t);
            }
            this._driver = null;
        }
        return changed;
    }

    newestT() {
        let m = -Infinity;
        for (const t of this._byT.keys()) if (t > m) m = t;
        return m;
    }

    sorted() {
        return [...this._byT.values()].sort((a, b) => a.t - b.t);
    }

    /** SolarWindDriver over the buffer, Bz/By median-filtered (Kan–Lee
     *  spike guard). Rebuilt lazily after each ingest. */
    driver() {
        if (this._driver) return this._driver;
        const rows = this.sorted();
        const bz = medianFilter3(rows.map((r) => r.bz));
        const by = medianFilter3(rows.map((r) => r.by));
        this._driver = new SolarWindDriver(
            rows.map((r, i) => ({ t: r.t, n: r.n, v: r.v, bx: r.bx, by: by[i], bz: bz[i] })),
            { source: 'observed', label: 'SWPC propagated' },
        );
        return this._driver;
    }
}

/**
 * Staleness ladder relative to the newest boundary-arrival timestamp.
 *   fresh — t_now inside the series (lead time ≥ 0)
 *   aged  — holding past the newest sample, ≤ 10 min
 *   stale — > 10 min past the newest sample (verdict → DATA GAP)
 * `gapRestart` flips once the gap exceeds 2 h — the solver must re-seed
 * rather than integrate through it (Geospace cold-restart policy).
 */
export function statusAt(nowMs, newestT, lastGoodFetchMs) {
    if (!Number.isFinite(newestT) || newestT < 0 || newestT === -Infinity) {
        return { state: 'stale', leadS: null, ageS: null, gapRestart: false };
    }
    const leadS = (newestT - nowMs) / 1000;
    const ageS = lastGoodFetchMs ? (nowMs - lastGoodFetchMs) / 1000 : null;
    let state = 'fresh';
    if (leadS < 0) state = leadS > -HOLD_MAX_S ? 'aged' : 'stale';
    return { state, leadS, ageS, gapRestart: leadS <= -STALE_RESTART_S };
}

// ── The live driver ────────────────────────────────────────────────────

export class LiveDriver {
    /**
     * deps (all optional, injected for tests):
     *   fetchFn — fetch-compatible; nowFn — Date.now-compatible;
     *   schedule/cancel — setTimeout/clearTimeout-compatible.
     */
    constructor({ fetchFn, nowFn, schedule, cancel, onUpdate } = {}) {
        this._fetch = fetchFn || ((...a) => fetch(...a));
        this._now = nowFn || (() => Date.now());
        this._schedule = schedule || ((fn, ms) => setTimeout(fn, ms));
        this._cancel = cancel || ((id) => clearTimeout(id));
        this.onUpdate = onUpdate || null;   // ({buffer, status, mode}) each poll
        this.buffer = new LiveBuffer();
        this.mode = 'propagated';           // 'propagated' | 'l1-fallback'
        this.f107 = null;                   // sfu; null until first fetch
        this.lastGoodFetchMs = null;
        this.lastError = null;
        this._primaryFails = 0;
        this._backoffMs = 0;
        this._timer = null;
        this._f107Timer = null;
        this._running = false;
    }

    start() {
        if (this._running) return;
        this._running = true;
        this._pollOnce();
        this._pollF107();
    }

    stop() {
        this._running = false;
        if (this._timer) this._cancel(this._timer);
        if (this._f107Timer) this._cancel(this._f107Timer);
        this._timer = this._f107Timer = null;
    }

    status() {
        return {
            mode: this.mode,
            samples: this.buffer.size,
            ...statusAt(this._now(), this.buffer.newestT(), this.lastGoodFetchMs),
        };
    }

    /**
     * Drivers at wall-clock t (ms). Linear interpolation strictly inside
     * the series; past the newest sample values are held (`held: true`).
     * Returns null while the buffer is empty — the solver keeps its
     * current controls rather than being fed an invention.
     */
    controlsAt(tMs) {
        if (!this.buffer.size) return null;
        const driver = this.buffer.driver();
        const newest = this.buffer.newestT();
        const tEff = Math.min(tMs, newest);
        const s = driver.at(tEff);
        if (!s) return null;
        // A NaN channel (gap in the series) HOLDS the newest finite value
        // at or before t — never a made-up default. Only a buffer that has
        // never carried the field at all yields null → caller keeps its
        // current controls.
        const rows = this.buffer.sorted();
        const held = { value: tMs > newest };
        const pick = (x, key) => {
            if (Number.isFinite(x)) return x;
            for (let i = rows.length - 1; i >= 0; i--) {
                if (rows[i].t <= tEff && Number.isFinite(rows[i][key])) {
                    held.value = true;
                    return rows[i][key];
                }
            }
            return null;
        };
        const bz = pick(s.bz, 'bz');
        const vsw = pick(s.v, 'v');
        if (bz == null || vsw == null) return null; // Kan–Lee needs both
        return {
            bz,
            by: pick(s.by, 'by') ?? 0,
            vsw,
            n: pick(s.n, 'n') ?? 5,
            f107: this.f107 ?? undefined,
            held: held.value,
        };
    }

    // ── internals ──────────────────────────────────────────────────────

    async _getJson(path) {
        // Browser-direct first (CORS-enabled, conditional revalidation via
        // no-cache), same-origin passthrough mirror second — the
        // js/swpc-feed.js fetchNoaa pattern.
        const direct = `${SWPC_BASE}${path}`;
        try {
            const res = await this._fetch(direct, {
                cache: 'no-cache',
                signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
                    ? AbortSignal.timeout(15_000) : undefined,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            const res = await this._fetch(`/api/noaa/passthrough?path=${encodeURIComponent(path)}`, {
                cache: 'no-cache',
            });
            if (!res.ok) throw new Error(`direct: ${err?.message}; mirror: HTTP ${res.status}`);
            return await res.json();
        }
    }

    async _pollOnce() {
        if (!this._running) return;
        let ok = false;
        try {
            const json = await this._getJson(PROPAGATED_PATH);
            const samples = samplesFromPropagated(json);
            if (!samples.length) throw new Error('propagated feed: 0 usable rows');
            this.buffer.ingest(samples);
            this.mode = 'propagated';
            this._primaryFails = 0;
            this.lastGoodFetchMs = this._now();
            this.lastError = null;
            ok = true;
        } catch (err) {
            this._primaryFails++;
            this.lastError = String(err?.message || err);
            if (this._primaryFails >= FALLBACK_AFTER_FAILS) {
                try {
                    const [wind, mag] = await Promise.all([
                        this._getJson(RTSW_WIND_PATH),
                        this._getJson(RTSW_MAG_PATH),
                    ]);
                    const samples = samplesFromRtsw(wind, mag);
                    if (!samples.length) throw new Error('rtsw fallback: 0 usable rows');
                    this.buffer.ingest(samples);
                    this.mode = 'l1-fallback';
                    this.lastGoodFetchMs = this._now();
                    this.lastError = null;
                    ok = true;
                } catch (err2) {
                    this.lastError = `${this.lastError} | ${String(err2?.message || err2)}`;
                }
            }
        }
        this._backoffMs = ok ? 0 : Math.min(Math.max(this._backoffMs * 2, POLL_MS), BACKOFF_MAX_MS);
        try { this.onUpdate?.({ buffer: this.buffer, status: this.status(), mode: this.mode }); }
        catch { /* listener errors must not kill the poll loop */ }
        const jitter = (Math.random() * 2 - 1) * POLL_JITTER_MS;
        const delay = (this._backoffMs || POLL_MS) + jitter;
        this._timer = this._schedule(() => this._pollOnce(), Math.max(delay, 1000));
    }

    async _pollF107() {
        if (!this._running) return;
        try {
            const res = await this._fetch(F107_API, { cache: 'no-cache' });
            if (res.ok) {
                const data = await res.json();
                const flux = Number(data?.current?.flux_sfu);
                if (Number.isFinite(flux) && flux > 40 && flux < 500) this.f107 = flux;
            }
        } catch { /* non-fatal: F10.7 holds its last value */ }
        this._f107Timer = this._schedule(() => this._pollF107(), 3600_000);
    }
}

/** Kan–Lee merging E-field, mV/m — EXACT mirror of rust-shielding
 *  fac.rs::kan_lee_mvpm (display only; the kernel computes its own). */
export function kanLeeMvpm(bzNt, byNt, vswKms) {
    const bt = Math.hypot(bzNt, byNt);
    if (bt < 1e-9) return 0;
    return vswKms * bt * 0.5 * (1 - bzNt / bt) * 1e-3;
}
