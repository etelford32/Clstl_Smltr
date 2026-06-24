/**
 * weather-patch.js — nested high-resolution weather focus window
 *
 * The 72×36 global grid (5° cells) destroys every front, convective cell
 * and orographic gradient at sub-synoptic scale; no forecaster downstream
 * can recover information the grid never had. Rather than bumping global
 * resolution (storage scales quadratically — 94 KB/frame becomes ~9 MB at
 * 0.5°), this module maintains a small high-res patch (≤ 64×64 cells at
 * 0.25–1.0°) that follows the camera's ground footprint, fetched
 * browser-direct from Open-Meteo with the exact same `current=` variable
 * set the global cron uses.
 *
 * Why browser-direct: Open-Meteo is free, CORS-enabled and keyless (same
 * class as the NOAA endpoints this repo already hits from the client —
 * see CLAUDE.md §8). The patch is per-camera, so the shared Supabase
 * cache that serves the global grid can't help here; per-visitor IPs also
 * sidestep the per-IP daily limit that bites the cron's shared egress.
 *
 * Pipeline
 * ────────
 *   'focus-footprint-change' (js/focus-footprint.js)
 *     → activation gate (footprint span ≤ ACTIVATE_SPAN_DEG)
 *     → chunked multi-point fetch (≤ 640 pts/URL ≈ 10 KB, 3-wide)
 *     → extract to the canonical 9-channel CHW Float32 layout
 *       (lockstep with weather-feed.js / weather-history.js)
 *     → small in-memory ring (24 hourly frames, bounds-stamped) — the
 *       "second, smaller ring" beside the global WeatherHistory ring
 *     → pack to two RGBA Float32 buffers (same normalisation as
 *       weather-feed.js _decodeCoarse, no upsample — GPU bilinear does
 *       the smoothing) → 'weather-patch-update' on document
 *
 * Time scrub honesty
 * ──────────────────
 * The patch is only as old as this session (Open-Meteo's current-weather
 * endpoint has no cheap backfill). setTimeContext(simTimeMs) re-paints
 * from the ring when the user scrubs into hours the session has lived
 * through, and clears the patch otherwise — a high-res window must never
 * silently show "now" data over a past or forecast globe.
 *
 * Events (document):
 *   'weather-patch-update'  { weatherRGBA, cloudRGBA, w, h, bounds,
 *                             stepDeg, t, source }
 *   'weather-patch-clear'   {}                — hide the patch
 *   'weather-patch-status'  { status, ... }   — fetching / ok / error
 */

import { MAX_WIND_MS } from './weather-feed.js';

const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';

// Same variable set as api/cron/refresh-weather-grid.js CURRENT_VARS —
// the patch must carry the exact channels the global grid carries so the
// shaders can blend the two without unit gymnastics.
const CURRENT_VARS = [
    'temperature_2m', 'relative_humidity_2m', 'surface_pressure',
    'wind_speed_10m', 'wind_direction_10m',
    'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
    'precipitation',
].join(',');

export const NUM_CHANNELS = 9;

// Activation: the patch turns on once the footprint is small enough that
// 64 cells across give ≤ 0.5° resolution — the "camera is clearly framing
// a region" zoom. Above this span the global 5° grid is doing its job.
export const ACTIVATE_SPAN_DEG = 32;

// Patch sizing. Step adapts to the footprint, clamped to [0.25°, 1.0°]
// (0.25° is Open-Meteo's effective model resolution — finer is fiction).
const MAX_CELLS    = 64;
const MIN_STEP_DEG = 0.25;
const MAX_STEP_DEG = 1.0;

// Fetch discipline. ≤ 640 points per URL keeps it ~10 KB (the cron's
// proven envelope); 3-wide fan-out matches the cron's concurrency.
const CHUNK_SIZE          = 640;
const CHUNK_CONCURRENCY   = 3;
const FETCH_TIMEOUT_MS    = 12_000;
const MIN_FETCH_GAP_MS    = 10_000;       // hard floor between upstream hits
const REFRESH_MS          = 15 * 60_000;  // steady-state re-fetch (matches global feed)

// Ring: 24 hourly frames ≈ this session's scrubbable past. In-memory only —
// the patch is camera-dependent, so persisting it would mostly cache
// frames for footprints the next session never revisits.
const RING_MAX = 24;
// A ring frame is an acceptable stand-in for a scrub instant within ±45 min.
const RING_MATCH_MS = 45 * 60_000;

function _hourKey(t) { return Math.floor(t / 3_600_000) * 3_600_000; }

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Open-Meteo per-location rows → CHW Float32Array, channel order in
 * lockstep with weather-feed.js. NaN gaps fill from the nearest valid
 * neighbour with BOTH axes clamped — a regional patch is not periodic in
 * longitude, unlike the global extractor.
 */
export function extractPatchCoarse(rows, w, h) {
    const N   = w * h;
    const DEG = Math.PI / 180;
    const ch  = Array.from({ length: NUM_CHANNELS }, () => new Float32Array(N).fill(NaN));
    const [T, P, RH, U, V, cL, cM, cH, Pr] = ch;
    const wspd = new Float32Array(N).fill(NaN);
    const wdir = new Float32Array(N).fill(NaN);

    rows.forEach((loc, idx) => {
        if (idx >= N) return;
        const c = loc?.current ?? {};
        T[idx]    = c.temperature_2m       ?? NaN;
        P[idx]    = c.surface_pressure     ?? NaN;
        RH[idx]   = c.relative_humidity_2m ?? NaN;
        wspd[idx] = c.wind_speed_10m       ?? NaN;
        wdir[idx] = c.wind_direction_10m   ?? NaN;
        cL[idx]   = c.cloud_cover_low      ?? 0;
        cM[idx]   = c.cloud_cover_mid      ?? 0;
        cH[idx]   = c.cloud_cover_high     ?? 0;
        Pr[idx]   = c.precipitation        ?? 0;
    });

    for (const a of [T, P, RH, wspd, wdir]) _fillNaNClamped(a, w, h);

    // Meteorological FROM-direction → U/V velocity, decomposed before
    // anything downstream interpolates (degrees wrap wrong under lerp).
    for (let k = 0; k < N; k++) {
        const dir = wdir[k] * DEG;
        U[k] = -wspd[k] * Math.sin(dir);
        V[k] = -wspd[k] * Math.cos(dir);
    }

    const coarse = new Float32Array(N * NUM_CHANNELS);
    for (let c = 0; c < NUM_CHANNELS; c++) coarse.set(ch[c], c * N);
    return coarse;
}

function _fillNaNClamped(arr, W, H) {
    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
            if (Number.isFinite(arr[j * W + i])) continue;
            outer: for (let r = 1; r <= Math.max(W, H); r++) {
                for (let dj = -r; dj <= r; dj++) {
                    for (let di = -r; di <= r; di++) {
                        const ni = Math.max(0, Math.min(W - 1, i + di));
                        const nj = Math.max(0, Math.min(H - 1, j + dj));
                        const v  = arr[nj * W + ni];
                        if (Number.isFinite(v)) { arr[j * W + i] = v; break outer; }
                    }
                }
            }
            if (!Number.isFinite(arr[j * W + i])) arr[j * W + i] = 0;
        }
    }
}

/**
 * CHW coarse → { weatherRGBA, cloudRGBA } at native patch resolution.
 * Identical normalisation to weather-feed.js _decodeCoarse so the shader
 * can mix() patch texels straight over global texels:
 *   weather: R=(T+60)/110  G=(P−850)/210  B=RH/100  A=hypot(U,V)/MAX_WIND
 *   cloud:   R=low/100     G=mid/100      B=high/100 A=precip/10
 * No upsample, no blur — the GPU's bilinear filter smooths a 0.25–0.5°
 * patch far better than a CPU box blur tuned for the 5° grid would.
 */
export function packPatchTrio(coarse, w, h) {
    const N  = w * h;
    const T  = coarse.subarray(0 * N, 1 * N);
    const P  = coarse.subarray(1 * N, 2 * N);
    const RH = coarse.subarray(2 * N, 3 * N);
    const U  = coarse.subarray(3 * N, 4 * N);
    const V  = coarse.subarray(4 * N, 5 * N);
    const cL = coarse.subarray(5 * N, 6 * N);
    const cM = coarse.subarray(6 * N, 7 * N);
    const cH = coarse.subarray(7 * N, 8 * N);
    const Pr = coarse.subarray(8 * N, 9 * N);

    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const weatherRGBA = new Float32Array(N * 4);
    const cloudRGBA   = new Float32Array(N * 4);
    for (let k = 0; k < N; k++) {
        const o = k * 4;
        weatherRGBA[o + 0] = clamp01((T[k] + 60) / 110);
        weatherRGBA[o + 1] = clamp01((P[k] - 850) / 210);
        weatherRGBA[o + 2] = clamp01(RH[k] / 100);
        weatherRGBA[o + 3] = clamp01(Math.hypot(U[k], V[k]) / MAX_WIND_MS);
        cloudRGBA[o + 0]   = clamp01(cL[k] / 100);
        cloudRGBA[o + 1]   = clamp01(cM[k] / 100);
        cloudRGBA[o + 2]   = clamp01(cH[k] / 100);
        cloudRGBA[o + 3]   = clamp01(Pr[k] / 10);
    }
    return { weatherRGBA, cloudRGBA };
}

/**
 * Footprint → snapped patch grid. Cell centres land on a global
 * step-aligned lattice so a small pan re-fetches mostly-identical
 * coordinates (CDN-friendly, and visually stable under camera drift).
 * Returns null when the footprint is too wide for the patch to matter.
 */
export function patchGridFromFootprint(fp) {
    if (!fp || fp.spanLatDeg > ACTIVATE_SPAN_DEG) return null;

    const rawStep = Math.max(fp.spanLatDeg / MAX_CELLS, fp.spanLonDeg / MAX_CELLS);
    // Snap step to a tidy set so boundsKey changes are discrete.
    const step = [0.25, 0.5, 1.0].find(s => s >= rawStep - 1e-9) ?? MAX_STEP_DEG;

    const h = Math.max(8, Math.min(MAX_CELLS, Math.round(fp.spanLatDeg / step)));
    const w = Math.max(8, Math.min(MAX_CELLS, Math.round(fp.spanLonDeg / step)));

    // Snap the south-west corner onto the step lattice.
    const latMin = Math.max(-90 + step, Math.floor(fp.latMin / step) * step);
    const lonMin = Math.floor(fp.lonMin / step) * step;
    const latSpan = Math.min(h * step, 90 - latMin);
    const lonSpan = w * step;

    return { w, h, step, latMin, lonMin, latSpan, lonSpan };
}

// ── WeatherPatchFeed ────────────────────────────────────────────────────────

export class WeatherPatchFeed {
    constructor() {
        this._grid    = null;     // active patch grid (or null = inactive)
        this._ring    = [];       // [{ t, key, w, h, coarse }], oldest first
        this._ringKey = null;     // boundsKey the ring belongs to
        this._lastFetchAt   = 0;
        this._refreshTimer  = null;
        this._abort         = null;
        this._timeCtxMs     = null;   // null = live; number = scrub instant
        this._visibleT      = null;   // t of the frame currently painted
        this._stopped       = false;

        this._onFootprint = this._onFootprint.bind(this);
        document.addEventListener('focus-footprint-change', this._onFootprint);
    }

    stop() {
        this._stopped = true;
        document.removeEventListener('focus-footprint-change', this._onFootprint);
        clearTimeout(this._refreshTimer);
        this._abort?.abort();
        this._clear();
    }

    /**
     * Couple to the time scrubber. null → live (paint the freshest patch,
     * fetch as needed). A past timestamp → re-paint from the ring when a
     * frame within RING_MATCH_MS exists for the CURRENT bounds, else hide.
     * Future timestamps always hide — there is no high-res forecast model
     * behind this window yet, and faking one with "now" data would be
     * exactly the dishonesty the replay slider was built to avoid.
     */
    setTimeContext(simTimeMs) {
        const next = Number.isFinite(simTimeMs) ? simTimeMs : null;
        if (next === this._timeCtxMs) return;
        this._timeCtxMs = next;
        this._repaintForTimeCtx();
    }

    // ── Internal: footprint / activation ───────────────────────────────────

    _onFootprint(ev) {
        if (this._stopped) return;
        const grid = patchGridFromFootprint(ev.detail);
        if (!grid) {
            if (this._grid) this._deactivate();
            return;
        }
        const key = this._boundsKey(grid);
        if (this._grid && this._boundsKey(this._grid) === key) return;   // unchanged

        this._grid = grid;
        if (this._ringKey !== key) {
            // New footprint → the old ring's frames describe ground we are
            // no longer looking at. Drop them rather than mis-painting.
            this._ring = [];
            this._ringKey = key;
        }
        this._scheduleFetch();
    }

    _deactivate() {
        this._grid = null;
        this._abort?.abort();
        clearTimeout(this._refreshTimer);
        this._clear();
    }

    _boundsKey(g) {
        return `${g.w}x${g.h}@${g.step}:${g.latMin.toFixed(2)},${g.lonMin.toFixed(2)}`;
    }

    // ── Internal: fetch ─────────────────────────────────────────────────────

    _scheduleFetch() {
        clearTimeout(this._refreshTimer);
        const wait = Math.max(0, this._lastFetchAt + MIN_FETCH_GAP_MS - Date.now());
        this._refreshTimer = setTimeout(() => this._fetch(), wait);
    }

    async _fetch() {
        const grid = this._grid;
        if (!grid || this._stopped) return;
        this._lastFetchAt = Date.now();
        this._abort?.abort();
        const ac = new AbortController();
        this._abort = ac;

        this._dispatch('weather-patch-status', { status: 'fetching', grid });
        try {
            const rows = await this._fetchRows(grid, ac.signal);
            if (ac.signal.aborted || this._grid !== grid) return;

            const coarse = extractPatchCoarse(rows, grid.w, grid.h);
            const t = Date.now();
            this._ringPush({ t: _hourKey(t), key: this._boundsKey(grid), w: grid.w, h: grid.h, coarse, fetchedAt: t });

            // Paint immediately unless the user is parked in the past/future.
            this._repaintForTimeCtx();
            this._dispatch('weather-patch-status', { status: 'ok', t, grid });
        } catch (err) {
            if (!ac.signal.aborted) {
                console.warn('[WeatherPatch] fetch failed:', err?.message);
                this._dispatch('weather-patch-status', { status: 'error', error: err?.message });
            }
        } finally {
            // Steady-state refresh while the footprint stays put.
            if (this._grid === grid && !this._stopped) {
                clearTimeout(this._refreshTimer);
                this._refreshTimer = setTimeout(() => this._fetch(), REFRESH_MS);
            }
        }
    }

    async _fetchRows(grid, signal) {
        const { w, h, step, latMin, lonMin } = grid;
        const N = w * h;
        const chunks = [];
        for (let start = 0; start < N; start += CHUNK_SIZE) {
            chunks.push([start, Math.min(start + CHUNK_SIZE - 1, N - 1)]);
        }
        const out = new Array(chunks.length).fill(null);
        let cursor = 0;
        let failure = null;

        const worker = async () => {
            while (failure === null) {
                const idx = cursor++;
                if (idx >= chunks.length) return;
                const [s, e] = chunks[idx];
                const lats = [], lons = [];
                for (let k = s; k <= e; k++) {
                    const j = Math.floor(k / w), i = k % w;
                    lats.push((latMin + (j + 0.5) * step).toFixed(3));
                    // Cell centres normalised into Open-Meteo's [-180, 180).
                    const lon = lonMin + (i + 0.5) * step;
                    lons.push((((lon + 540) % 360) - 180).toFixed(3));
                }
                const url = `${OPEN_METEO_BASE}?latitude=${lats.join(',')}&longitude=${lons.join(',')}`
                    + `&current=${CURRENT_VARS}&wind_speed_unit=ms&timezone=UTC`;
                const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });
                if (!res.ok) { failure = `HTTP ${res.status}`; return; }
                const body = await res.json();
                if (body?.error) { failure = body.reason ?? 'upstream error'; return; }
                out[idx] = Array.isArray(body) ? body : [body];
            }
        };
        await Promise.all(Array.from({ length: CHUNK_CONCURRENCY }, worker));
        if (failure) throw new Error(failure);

        const rows = out.flat();
        if (rows.length !== N) throw new Error(`merged ${rows.length} != ${N}`);
        return rows;
    }

    // ── Internal: ring + paint ──────────────────────────────────────────────

    _ringPush(rec) {
        const i = this._ring.findIndex(r => r.t === rec.t);
        if (i >= 0) this._ring[i] = rec;
        else {
            this._ring.push(rec);
            if (this._ring.length > RING_MAX) this._ring.shift();
        }
    }

    _ringNearest(tMs) {
        let best = null, bestDt = Infinity;
        for (const r of this._ring) {
            const dt = Math.abs(r.t - tMs);
            if (dt < bestDt) { best = r; bestDt = dt; }
        }
        return bestDt <= RING_MATCH_MS ? best : null;
    }

    _repaintForTimeCtx() {
        if (!this._grid) { this._clear(); return; }
        const ctx = this._timeCtxMs;
        let frame = null;
        if (ctx === null) {
            frame = this._ring[this._ring.length - 1] ?? null;
        } else if (ctx <= Date.now() + 60_000) {
            frame = this._ringNearest(ctx);           // past: ring or nothing
        }                                              // future: nothing
        if (!frame || frame.key !== this._boundsKey(this._grid)) { this._clear(); return; }
        this._paint(frame);
    }

    _paint(frame) {
        const grid = this._grid;
        const { weatherRGBA, cloudRGBA } = packPatchTrio(frame.coarse, frame.w, frame.h);
        this._visibleT = frame.t;
        this._dispatch('weather-patch-update', {
            weatherRGBA, cloudRGBA,
            w: frame.w, h: frame.h,
            bounds: {
                latMin: grid.latMin, lonMin: grid.lonMin,
                latSpan: grid.latSpan, lonSpan: grid.lonSpan,
            },
            stepDeg: grid.step,
            t: frame.t,
            source: 'open-meteo:patch',
        });
    }

    _clear() {
        if (this._visibleT === null) return;
        this._visibleT = null;
        this._dispatch('weather-patch-clear', {});
    }

    _dispatch(type, detail) {
        document.dispatchEvent(new CustomEvent(type, { detail }));
    }
}

export default WeatherPatchFeed;
