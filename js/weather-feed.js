/**
 * WeatherFeed — Real-time global weather data pipeline
 *
 * Data source:  Open-Meteo (https://open-meteo.com) — free, no API key,
 *               backed by NOAA GFS + ECMWF forecasts.
 *
 * Output:  Two Float32 RGBA DataTexture buffers at TEX_W × TEX_H resolution:
 *
 *   weatherBuffer  (RGBA)
 *     R = temperature   — normalised [0,1] spanning -60 … +50 °C
 *     G = pressure      — normalised [0,1] spanning  850 … 1060 hPa
 *     B = humidity      — normalised [0,1] spanning    0 … 100 %
 *     A = wind speed    — normalised [0,1] spanning    0 … MAX_WIND m/s
 *
 *   windBuffer  (RGBA)
 *     R = U component (eastward)   — signed [-1,1] in MAX_WIND units
 *     G = V component (northward)  — signed [-1,1] in MAX_WIND units
 *     B = wind speed normalised    — [0,1]
 *     A = 1.0
 *
 * Fires: CustomEvent 'weather-update' on document
 *   detail: { weatherBuffer, windBuffer, meta, texW, texH }
 *
 * Replace / augment _fetchGrid() to integrate additional sources:
 *   - NOAA NOMADS GRIB2 tiles (high resolution, requires server-side parsing)
 *   - Copernicus ERA5 Climate Data Store (historical + NRT)
 *   - OpenWeatherMap (requires API key, point-based)
 *   - Custom WebSocket stream for ultra-low-latency updates
 */

// Reads from /api/weather/grid, a Vercel Edge Function fronted by the CDN
// with s-maxage=3600. Upstream Open-Meteo is only hit once per hour by
// Supabase pg_cron (see supabase-weather-pgcron-migration.sql), so visitor
// count never drives upstream load.
const WEATHER_ENDPOINT = '/api/weather/grid';

// Coarse on-disk channel layout (mirrored by js/weather-history.js).
// Channel-major (CHW) so the inner loop in _bilinear walks one channel
// at a time — better L1 hit rate than HWC pixel-major, and trivially
// sliceable into per-channel views with .subarray().
//
//   0 = T (°C)   1 = P (hPa)   2 = RH (%)
//   3 = U (m/s)  4 = V (m/s)        ← post-decomposition, eastward / northward
//   5 = cloud_low   6 = cloud_mid   7 = cloud_high   (% each)
//   8 = precipitation (mm)
//
// Wind speed is *derived* on decode (hypot(U, V)) — storing it would be
// redundant with U/V and risks drift. wdir is never stored; bilinear of
// degrees wraps wrong (350°→10° averages to 180° not 0°).
const NUM_COARSE_CHANNELS = 9;
// Default coarse-grid dimensions — used by the procedural fallback and by
// _processRows() until the upstream response tells us a different resolution.
// The cron writer (api/cron/refresh-weather-grid.js) currently ships 72×36
// (5° spacing); older rows in the cache may still be 36×18 (10°). Frontend
// detects the live resolution from response.grid (preferred) or falls back
// to inferring from data.length (= 2·H², where H = sqrt(N/2)).
const DEFAULT_GRID_W = 72;
const DEFAULT_GRID_H = 36;
export const TEX_W = 360;               // output texture width  (1°/pixel)
export const TEX_H = 180;               // output texture height (1°/pixel)
export const MAX_WIND_MS = 60;          // m/s — wind-speed normalisation ceiling
const REFRESH_MS   = 15 * 60 * 1000;   // re-fetch every 15 min (cache is 1 hr w/ SWR)
// Retry staircase after a failed fetch. On each successive failure we step
// to the next entry; on success we reset to the steady-state REFRESH_MS.
// Design goal: recover quickly when the upstream comes back (30 s is
// short enough that a reload-in-tab blip barely shows) without hammering
// the edge cache when something is actually down.
const RETRY_BACKOFF_MS = [30_000, 120_000, 15 * 60 * 1000];

// ── Session-snapshot helpers ───────────────────────────────────────────────
// Cache last-known-good buffer trio into sessionStorage so a short
// /api/weather/grid outage doesn't snap the globe back to synthetic data
// on every reload.  Scoped to the browser tab — localStorage would share
// across tabs and widen the blast radius of a stale cache.
//
// Size budget:
//   TEX_W × TEX_H × 4 floats × 4 bytes × 3 buffers ≈ 3.1 MB binary
//   → base64 ≈ 4.2 MB string
// Fits inside Chrome/Firefox's ~10 MB per-origin sessionStorage cap; Safari
// is tighter (~5 MB). QuotaExceededError is swallowed — best-effort cache.
const SNAPSHOT_KEY         = 'weatherFeed-snapshot-v1';
const SNAPSHOT_MAX_AGE_MS  = 90 * 60 * 1000;   // 90 min — two feed refreshes

function _f32ToBase64(arr) {
    const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    let bin = '';
    const chunk = 0x8000;   // stay under the JS call-stack arg limit
    for (let i = 0; i < u8.length; i += chunk) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(bin);
}
function _base64ToF32(s) {
    const bin = atob(s);
    const u8  = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Float32Array(u8.buffer);
}

// ─────────────────────────────────────────────────────────────────────────────
export class WeatherFeed {
    /**
     * @param {object} [opts]
     * @param {import('./weather-history.js').WeatherHistory} [opts.history]
     *   Optional 24-hr ring buffer. When provided, every successful live
     *   fetch pushes its coarse frame to history.ingest() so the resolver
     *   (next module) can replay the past day. Procedural fallback and
     *   sessionStorage-restored snapshots are *not* ingested — replay
     *   should show "no data" rather than synthetic or compressed data.
     */
    constructor({ history = null } = {}) {
        this._history    = history;
        this._timer      = null;
        this._failureCount = 0;    // consecutive-failure counter → RETRY_BACKOFF_MS index
        this._weatherBuf = new Float32Array(TEX_W * TEX_H * 4);
        this._windBuf    = new Float32Array(TEX_W * TEX_H * 4);
        // cloudBuf: R=cloud_low, G=cloud_mid, B=cloud_high, A=precipitation_rate
        this._cloudBuf   = new Float32Array(TEX_W * TEX_H * 4);
        // Live coarse-grid dims — overwritten on each fetch from the response
        // metadata (or inferred from data.length). Keep defaults so the
        // procedural fallback has something usable on the very first frame.
        this._gridW = DEFAULT_GRID_W;
        this._gridH = DEFAULT_GRID_H;
        this._meta       = {
            loaded:    false,
            // `source` is consumer-facing text; `demo` is a structured
            // boolean so UI panels can style differently without string-
            // parsing the label. Upstream names (open-meteo, open-meteo-gfs,
            // …) are passed through verbatim from /api/weather/grid so the
            // provenance panel can show which model won the cron fallback.
            source:    'DEMO DATA — synthetic circulation (initializing)',
            demo:      true,
            fetchTime: null,
            tempMin:   null, tempMax:  null, tempMean: null,
            presMin:   null, presMax:  null,
            windMax:   null,
            cloudMax:  null,
            gridW:     DEFAULT_GRID_W,
            gridH:     DEFAULT_GRID_H,
            gridDeg:   180 / DEFAULT_GRID_H,
        };

        // Prefer the session-cached snapshot on first paint — avoids the
        // flash-of-procedural that used to show for ~1 frame before the
        // snapshot overlay landed. If no snapshot exists (first-ever load,
        // expired cache, TEX size bump), fall back to procedural so the
        // shader still has something to sample.
        this._hasGoodData = this._restoreSnapshot();
        if (!this._hasGoodData) this._buildProcedural();
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Cold-start backfill — fetches up to `hours` of historical frames
     * from /api/weather/grid?since=… and pushes each one through
     * _extractCoarse → history.ingest. Lets the 24-h replay slider
     * have data to scrub through on the very first session, instead
     * of waiting 24 hours of session lifetime for the live ring to
     * fill.
     *
     * Best-effort: catches every error, returns the count of frames
     * successfully ingested, never throws. Safe to fire-and-forget.
     *
     * Race with live ingest: WeatherHistory.ingest dedupes on hour-
     * rounded `t`, replacing in place if a record for the same hour
     * already exists. Live and backfill can land in any order — both
     * pull the same Supabase row for the current hour, so dedup is
     * idempotent.
     *
     * @param {import('./weather-history.js').WeatherHistory} history
     * @param {number} [hours=24]   — lookback window in hours (capped
     *                                server-side at 72)
     * @returns {Promise<number>}   — frames ingested
     */
    async backfill(history, hours = 24) {
        if (!history) return 0;
        const sinceMs = Date.now() - hours * 3_600_000;
        const sinceISO = new Date(sinceMs).toISOString();
        try {
            const url = `${WEATHER_ENDPOINT}` +
                `?since=${encodeURIComponent(sinceISO)}` +
                `&limit=${hours}`;
            // 30 s timeout — the response can be ~10 MB JSON over a
            // slow link, well past the 20 s the live single-frame
            // fetch uses. Backfill failure is silent and decorative;
            // we'd rather time out cleanly than hold a request open.
            const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            if (body?.error) throw new Error(body.detail || body.error);
            if (!Array.isArray(body?.frames)) throw new Error('missing frames array');

            let ingested = 0;
            for (const frame of body.frames) {
                if (!Array.isArray(frame?.data) || frame.data.length === 0) continue;

                // Per-frame grid dims. The endpoint provides explicit
                // grid metadata when the cron writer attached the WxH
                // suffix; otherwise we infer from data.length the same
                // way _fetchGrid does (mirroring its 2:1 aspect logic).
                const N = frame.data.length;
                let gridW, gridH;
                if (frame.grid?.w && frame.grid?.h) {
                    gridW = frame.grid.w;
                    gridH = frame.grid.h;
                } else {
                    const inferredH = Math.round(Math.sqrt(N / 2));
                    if (2 * inferredH * inferredH !== N) continue;   // unknown shape, skip
                    gridH = inferredH;
                    gridW = 2 * inferredH;
                }

                // _extractCoarse handles NaN-fill + U/V decomposition
                // so the on-disk frame is exactly what the live path
                // would have written. CHW layout matches what
                // weather-history.js expects.
                const coarse = this._extractCoarse(frame.data, gridW, gridH);
                const t = Date.parse(frame.fetched_at);
                history.ingest({
                    t:         Number.isFinite(t) ? t : Date.now(),
                    fetchedAt: Number.isFinite(t) ? t : Date.now(),
                    source:    frame.source ?? null,
                    gridW, gridH,
                    coarse,
                });
                ingested++;
            }
            console.info(`[WeatherFeed] backfilled ${ingested} historical frame(s)`);
            return ingested;
        } catch (err) {
            console.warn('[WeatherFeed] backfill failed:', err.message);
            return 0;
        }
    }

    // Self-rescheduling timer (setTimeout, not setInterval) so each success
    // or failure can dial its own delay. Success → REFRESH_MS; failure →
    // RETRY_BACKOFF_MS[min(failureCount-1, end)].
    start()  { this._fetchAndProcess(); }
    stop()   { clearTimeout(this._timer); this._timer = null; }
    refresh(){ this._fetchAndProcess(); }

    _scheduleNext() {
        clearTimeout(this._timer);
        let delay;
        if (this._failureCount === 0) {
            delay = REFRESH_MS;
        } else {
            const idx = Math.min(this._failureCount - 1, RETRY_BACKOFF_MS.length - 1);
            delay = RETRY_BACKOFF_MS[idx];
        }
        this._timer = setTimeout(() => this._fetchAndProcess(), delay);
    }

    get weatherBuffer() { return this._weatherBuf; }
    get windBuffer()    { return this._windBuf; }
    get cloudBuffer()   { return this._cloudBuf; }
    get meta()          { return this._meta; }

    // ── Fetch → process ──────────────────────────────────────────────────────
    async _fetchAndProcess() {
        this._dispatch('weather-status', { status: 'fetching' });
        try {
            const rows = await this._fetchGrid();
            if (rows && rows.length > 0) {
                this._processRows(rows);
                // Pass the upstream provenance through so the UI can show
                // `open-meteo` vs `open-meteo-gfs` (the pg_cron fallback).
                // Falling back to 'Open-Meteo / GFS' for servers that
                // pre-date the source field keeps older clients working.
                this._meta.source    = this._meta.upstreamSource ?? 'Open-Meteo / GFS';
                this._meta.demo      = false;
                this._meta.fetchTime = new Date();
                this._meta.loaded    = true;
                this._hasGoodData    = true;
                this._failureCount   = 0;   // reset backoff on success
                // Persist for subsequent reloads within this tab session.
                this._saveSnapshot();
            } else {
                throw new Error('Empty response');
            }
        } catch (err) {
            this._failureCount++;
            // Three-tier fallback. If we've ever had live or cached data
            // in this session (_hasGoodData), keep those buffers — serving
            // stale real data beats reverting to synthetic. Only rebuild
            // procedural when we have nothing better to show.
            if (this._hasGoodData) {
                console.warn(`[WeatherFeed] upstream failed (attempt ${this._failureCount}) — keeping last-known-good buffers:`, err.message);
                this._meta.loaded    = false;
                this._meta.demo      = false;   // stale-real data is NOT demo
                this._meta.source    = `stale · last known (${err.message ?? 'upstream error'})`;
                this._meta.fetchTime = new Date();
            } else {
                console.warn(`[WeatherFeed] Falling back to procedural data (attempt ${this._failureCount}):`, err.message);
                this._buildProcedural();
                this._meta.loaded    = false;
                this._meta.demo      = true;
                this._meta.source    = 'DEMO DATA — synthetic circulation (upstream unavailable)';
                this._meta.fetchTime = new Date();
            }
        } finally {
            this._scheduleNext();
        }
        this._dispatch('weather-update', {
            weatherBuffer: this._weatherBuf,
            windBuffer:    this._windBuf,
            cloudBuffer:   this._cloudBuf,
            meta:          this._meta,
            texW:          TEX_W,
            texH:          TEX_H,
        });
    }

    // ── Cached grid fetch ─────────────────────────────────────────────────────
    // Hits /api/weather/grid — one hourly Open-Meteo pull shared across all
    // visitors via the Vercel edge CDN + Supabase persistence. Response:
    //   { source, fetched_at, age_seconds, data: [ { current: {…} }, … ] }
    // where `data` is the same 648-item array Open-Meteo would have returned.
    //
    // The proxy returns structured JSON even on failure (status 500/503 with
    // { error, detail, missing?, hint? }). Parse the body on both paths so
    // the real reason surfaces in console + the stale-state banner on
    // earth.html — losing it to a generic "HTTP 503" made production
    // debugging much harder than it needed to be.
    async _fetchGrid() {
        const res = await fetch(WEATHER_ENDPOINT, {
            signal: AbortSignal.timeout(20000),
        });

        // Try to parse JSON regardless of status; the proxy is JSON-always.
        let body = null;
        try { body = await res.json(); } catch { /* non-JSON — handled below */ }

        if (!res.ok) {
            const code   = body?.error  ?? `http_${res.status}`;
            const detail = body?.detail ?? body?.hint ?? '';
            const missing = Array.isArray(body?.missing) && body.missing.length
                ? ` (missing env: ${body.missing.join(', ')})`
                : '';
            throw new Error(detail ? `${code} — ${detail}${missing}` : `${code}${missing}`);
        }
        if (body?.error) {
            throw new Error(body.detail || body.hint || body.error);
        }
        if (!Array.isArray(body?.data)) throw new Error('Malformed cache response');

        this._meta.cacheAgeSeconds = body.age_seconds ?? null;
        this._meta.cacheFetchedAt  = body.fetched_at  ?? null;
        // Preserve the upstream model tag ('open-meteo', 'open-meteo-gfs',
        // or whatever new entry is added to the pg_cron fallback array).
        // _fetchAndProcess() reads this into _meta.source on success.
        this._meta.upstreamSource  = body.source ?? null;

        // Grid resolution — prefer the response's explicit `grid` block
        // (added in the 5°-grid bump). For older rows that ship only the
        // legacy data array, infer from length: 2·H² = N → H = √(N/2),
        // W = 2H, since every grid we ship is 2:1 aspect (lon:lat).
        const N = Array.isArray(body.data) ? body.data.length : 0;
        let gridW, gridH;
        if (body.grid && Number.isFinite(body.grid.w) && Number.isFinite(body.grid.h)) {
            gridW = body.grid.w;
            gridH = body.grid.h;
        } else if (N > 0) {
            const inferredH = Math.round(Math.sqrt(N / 2));
            // Sanity-check: 2·H² should equal N exactly. If it doesn't,
            // keep the previous-known dims rather than corrupting the
            // bilinear with a wrong shape.
            if (2 * inferredH * inferredH === N) {
                gridH = inferredH;
                gridW = 2 * inferredH;
            } else {
                gridW = this._gridW;
                gridH = this._gridH;
                console.warn(`[WeatherFeed] payload length ${N} doesn't match a 2:1 grid; keeping ${gridW}×${gridH}`);
            }
        } else {
            gridW = this._gridW;
            gridH = this._gridH;
        }
        this._gridW = gridW;
        this._gridH = gridH;
        this._meta.gridW   = gridW;
        this._meta.gridH   = gridH;
        this._meta.gridDeg = 180 / gridH;
        return body.data;
    }

    // ── Live-fetch orchestrator ───────────────────────────────────────────────
    // Extract → (history.ingest) → stats → decode → copy into instance
    // buffers. The split lets the future replay resolver call _decodeCoarse
    // directly with a frame loaded from WeatherHistory, without re-parsing
    // the upstream JSONB.
    _processRows(rows) {
        const gridW = this._gridW;
        const gridH = this._gridH;

        // 1. Extract — JSONB rows → CHW-packed coarse Float32Array.
        const coarse = this._extractCoarse(rows, gridW, gridH);

        // 2. Push to history *before* decode so the resolver has a fresh
        //    frame ready the moment the scrubber lands on this hour. Best-
        //    effort: history.ingest() is a no-op if the optional dependency
        //    wasn't injected. Procedural fallback and snapshot-restore paths
        //    deliberately don't reach here — replay should show "no data"
        //    rather than synthetic.
        if (this._history) {
            try {
                const cacheMs = this._meta.cacheFetchedAt
                    ? Date.parse(this._meta.cacheFetchedAt)
                    : NaN;
                const t = Number.isFinite(cacheMs) ? cacheMs : Date.now();
                this._history.ingest({
                    t,
                    fetchedAt: t,
                    source:    this._meta.upstreamSource ?? null,
                    gridW, gridH,
                    coarse,
                });
            } catch (err) {
                console.debug('[WeatherFeed] history ingest skipped:', err?.message);
            }
        }

        // 3. Stats — wx-panel readouts. Computed from the coarse field
        //    (one value per upstream cell, not per upsampled pixel) to
        //    match the units the panel labels expect.
        this._computeCoarseStats(coarse, gridW, gridH);

        // 4. Decode — coarse → trio of full-res packed Float32Array.
        const { weatherBuf, windBuf, cloudBuf } = this._decodeCoarse(coarse, gridW, gridH);

        // 5. Copy into the stable instance buffers. Downstream consumers
        //    receive these references via 'weather-update' and may hold
        //    them across frames, so we mutate-in-place rather than swapping
        //    references — matches the pattern _buildProcedural() uses.
        this._weatherBuf.set(weatherBuf);
        this._windBuf.set(windBuf);
        this._cloudBuf.set(cloudBuf);
    }

    // ── Extract: rows → CHW-packed coarse Float32Array ───────────────────────
    // Pure (modulo `this._fillNaN`, which is itself pure but lives on the
    // class for code-organisation reasons). Output layout matches
    // NUM_COARSE_CHANNELS at the top of this file and the on-disk format
    // in weather-history.js. NaN gap-fill happens here so on-disk frames
    // are always clean and decode is a pure bilinear path.
    _extractCoarse(rows, gridW, gridH) {
        const N    = gridW * gridH;
        const DEG  = Math.PI / 180;
        const temp = new Float32Array(N).fill(NaN);
        const hum  = new Float32Array(N).fill(NaN);
        const pres = new Float32Array(N).fill(NaN);
        const wspd = new Float32Array(N).fill(NaN);
        const wdir = new Float32Array(N).fill(NaN);
        const clLow  = new Float32Array(N).fill(0);
        const clMid  = new Float32Array(N).fill(0);
        const clHigh = new Float32Array(N).fill(0);
        const precip = new Float32Array(N).fill(0);

        rows.forEach((loc, idx) => {
            if (idx >= N) return;
            const c = loc.current ?? {};
            temp[idx]   = c.temperature_2m        ?? NaN;
            hum[idx]    = c.relative_humidity_2m  ?? 50;
            pres[idx]   = c.surface_pressure       ?? 1013;
            wspd[idx]   = c.wind_speed_10m         ?? 0;
            wdir[idx]   = c.wind_direction_10m     ?? 0;
            clLow[idx]  = c.cloud_cover_low        ?? 0;
            clMid[idx]  = c.cloud_cover_mid        ?? 0;
            clHigh[idx] = c.cloud_cover_high       ?? 0;
            precip[idx] = c.precipitation          ?? 0;
        });

        // Fill NaN gaps (missing ocean cells, polar regions, etc.) before
        // we decompose or write to disk — keeps stored frames clean and
        // avoids conditional logic in the bilinear inner loop.
        [temp, hum, pres, wspd, wdir].forEach(a => this._fillNaN(a, gridW, gridH));

        // Decompose wind speed+direction into U/V on the coarse grid BEFORE
        // anything downstream. Bilinear interpolation of angles is wrong
        // because degrees wrap at 360°→0° (e.g. avg of 350° and 10° gives
        // 180° not 0°). Interpolating the Cartesian components avoids this.
        const windU = new Float32Array(N);
        const windV = new Float32Array(N);
        for (let k = 0; k < N; k++) {
            const dir = wdir[k] * DEG;
            // Meteorological convention: FROM direction → negate for velocity.
            windU[k] = -wspd[k] * Math.sin(dir);  // eastward  m/s
            windV[k] = -wspd[k] * Math.cos(dir);  // northward m/s
        }

        // Pack CHW into a single Float32Array — channel-major so .subarray()
        // gives a zero-copy view of each channel for the decode path.
        // Channel order MUST stay in lockstep with NUM_COARSE_CHANNELS.
        const coarse = new Float32Array(N * NUM_COARSE_CHANNELS);
        coarse.set(temp,   0 * N);
        coarse.set(pres,   1 * N);
        coarse.set(hum,    2 * N);
        coarse.set(windU,  3 * N);
        coarse.set(windV,  4 * N);
        coarse.set(clLow,  5 * N);
        coarse.set(clMid,  6 * N);
        coarse.set(clHigh, 7 * N);
        coarse.set(precip, 8 * N);
        return coarse;
    }

    // ── Stats: coarse → wx-panel meta fields ─────────────────────────────────
    // Reads channels 0..7 of the coarse array and populates the same _meta
    // fields the wx-panel UI consumes (tempMin/Max/Mean, presMin/Max,
    // windMax via hypot(U,V), cloudMax across the three layers). Cloud
    // and precip channels deliberately don't contribute to tempMin/etc;
    // wspd is *derived* on the fly from U,V here exactly like _decodeCoarse
    // does, so the panel reading matches what the renderer shows.
    _computeCoarseStats(coarse, gridW, gridH) {
        const N = gridW * gridH;
        const T   = coarse.subarray(0 * N, 1 * N);
        const P   = coarse.subarray(1 * N, 2 * N);
        const U   = coarse.subarray(3 * N, 4 * N);
        const V   = coarse.subarray(4 * N, 5 * N);
        const cL  = coarse.subarray(5 * N, 6 * N);
        const cM  = coarse.subarray(6 * N, 7 * N);
        const cH  = coarse.subarray(7 * N, 8 * N);

        let tMin = Infinity, tMax = -Infinity, tSum = 0, tN = 0;
        let pMin = Infinity, pMax = -Infinity;
        let wMax = 0;
        let cMax = 0;
        for (let k = 0; k < N; k++) {
            const t = T[k];
            if (Number.isFinite(t)) {
                if (t < tMin) tMin = t;
                if (t > tMax) tMax = t;
                tSum += t; tN++;
            }
            const p = P[k];
            if (Number.isFinite(p)) {
                if (p < pMin) pMin = p;
                if (p > pMax) pMax = p;
            }
            const w = Math.hypot(U[k], V[k]);
            if (w > wMax) wMax = w;
            const cmax = Math.max(cL[k], cM[k], cH[k]);
            if (cmax > cMax) cMax = cmax;
        }

        this._meta.tempMin  = tN > 0 ? tMin : null;
        this._meta.tempMax  = tN > 0 ? tMax : null;
        this._meta.tempMean = tN > 0 ? tSum / tN : null;
        this._meta.presMin  = Number.isFinite(pMin) ? pMin : null;
        this._meta.presMax  = Number.isFinite(pMax) ? pMax : null;
        this._meta.windMax  = wMax;
        this._meta.cloudMax = cMax;
    }

    // ── Decode: coarse → trio of packed full-res Float32Arrays ───────────────
    // Pure: same coarse input always produces the same output trio. Used
    // by both the live-fetch path (via _processRows) and — once the
    // resolver lands — by historical replay, where it operates on a frame
    // pulled out of WeatherHistory. The output shape matches what
    // earth.html's updateWeatherTextures() expects so the downstream
    // shader path is unchanged.
    _decodeCoarse(coarse, gridW, gridH) {
        const N = gridW * gridH;

        // Per-channel views — zero-copy slices of the packed CHW buffer.
        const T   = coarse.subarray(0 * N, 1 * N);
        const P   = coarse.subarray(1 * N, 2 * N);
        const RH  = coarse.subarray(2 * N, 3 * N);
        const U   = coarse.subarray(3 * N, 4 * N);
        const V   = coarse.subarray(4 * N, 5 * N);
        const cL  = coarse.subarray(5 * N, 6 * N);
        const cM  = coarse.subarray(6 * N, 7 * N);
        const cH  = coarse.subarray(7 * N, 8 * N);
        const Pr  = coarse.subarray(8 * N, 9 * N);

        // Wind speed is derived on the coarse grid from U,V. Mathematically
        // identical to what the upstream wind_speed_10m would have been —
        // U,V were constructed from wspd*sin/cos(dir), so hypot(U,V) == wspd.
        const W = new Float32Array(N);
        for (let k = 0; k < N; k++) W[k] = Math.hypot(U[k], V[k]);

        // Bilinear upsample. wrapX=true so the antimeridian doesn't seam.
        const fT  = this._bilinear(T,  gridW, gridH, TEX_W, TEX_H, true);
        const fP  = this._bilinear(P,  gridW, gridH, TEX_W, TEX_H, true);
        const fH  = this._bilinear(RH, gridW, gridH, TEX_W, TEX_H, true);
        const fU  = this._bilinear(U,  gridW, gridH, TEX_W, TEX_H, true);
        const fV  = this._bilinear(V,  gridW, gridH, TEX_W, TEX_H, true);
        const fW  = this._bilinear(W,  gridW, gridH, TEX_W, TEX_H, true);

        // Cloud channels: bilinear + box-blur to soften upsample blockiness.
        // Blur radius scales to the upstream cell pitch so the blur covers
        // about one input cell — at 10° grid (legacy) one cell ≈ 11 px → R≈5,
        // at 5° (current) one cell ≈ 5 px → R≈3. Two passes ≈ Gaussian σ ≈ R·√2.
        const fCL = this._bilinear(cL, gridW, gridH, TEX_W, TEX_H, true);
        const fCM = this._bilinear(cM, gridW, gridH, TEX_W, TEX_H, true);
        const fCH = this._bilinear(cH, gridW, gridH, TEX_W, TEX_H, true);
        const fPr = this._bilinear(Pr, gridW, gridH, TEX_W, TEX_H, true);
        const cellPx  = Math.max(1, Math.round(TEX_W / gridW));
        const blurR   = Math.max(2, Math.round(cellPx * 0.55));
        const precipR = Math.max(2, Math.round(cellPx * 0.45));
        const sLow    = this._boxBlur(this._boxBlur(fCL, TEX_W, TEX_H, blurR), TEX_W, TEX_H, blurR);
        const sMid    = this._boxBlur(this._boxBlur(fCM, TEX_W, TEX_H, blurR), TEX_W, TEX_H, blurR);
        const sHigh   = this._boxBlur(this._boxBlur(fCH, TEX_W, TEX_H, blurR), TEX_W, TEX_H, blurR);
        const sPrecip = this._boxBlur(fPr, TEX_W, TEX_H, precipR);

        const NTEX = TEX_W * TEX_H;
        const weatherBuf = new Float32Array(NTEX * 4);
        const windBuf    = new Float32Array(NTEX * 4);
        const cloudBuf   = new Float32Array(NTEX * 4);

        for (let k = 0; k < NTEX; k++) {
            const t4 = k * 4;

            // weatherBuffer — normalised scalars for colour overlays
            weatherBuf[t4+0] = Math.max(0, Math.min(1, (fT[k] + 60) / 110));   // -60…+50 °C
            weatherBuf[t4+1] = Math.max(0, Math.min(1, (fP[k] - 850) / 210));  // 850…1060 hPa
            weatherBuf[t4+2] = Math.max(0, Math.min(1,  fH[k] / 100));
            weatherBuf[t4+3] = Math.max(0, Math.min(1,  fW[k] / MAX_WIND_MS));

            // windBuffer — signed U,V for particle advection (already in m/s)
            windBuf[t4+0] = fU[k] / MAX_WIND_MS;   // [-1, 1]
            windBuf[t4+1] = fV[k] / MAX_WIND_MS;   // [-1, 1]
            windBuf[t4+2] = fW[k] / MAX_WIND_MS;   // [0, 1]
            windBuf[t4+3] = 1.0;

            cloudBuf[t4+0] = Math.max(0, Math.min(1, sLow[k]    / 100));
            cloudBuf[t4+1] = Math.max(0, Math.min(1, sMid[k]    / 100));
            cloudBuf[t4+2] = Math.max(0, Math.min(1, sHigh[k]   / 100));
            cloudBuf[t4+3] = Math.max(0, Math.min(1, sPrecip[k] / 10));   // cap 10 mm/hr
        }

        return { weatherBuf, windBuf, cloudBuf };
    }

    // ── Bilinear interpolation: inW×inH → outW×outH ──────────────────────────
    // wrapX: when true, longitude (x axis) wraps so column 0 is adjacent to
    //        column inW-1 (periodic boundary).  This eliminates the 10° seam
    //        at the antimeridian where -175° meets +175°.
    _bilinear(src, inW, inH, outW, outH, wrapX = false) {
        const dst = new Float32Array(outW * outH);
        for (let j = 0; j < outH; j++) {
            const fy = (j / (outH - 1)) * (inH - 1);
            const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, inH - 1);
            const ty = fy - y0;
            for (let i = 0; i < outW; i++) {
                const fx = (i / (outW - 1)) * (inW - 1);
                const x0 = Math.floor(fx);
                const x1 = wrapX ? (x0 + 1) % inW : Math.min(x0 + 1, inW - 1);
                const tx = fx - x0;
                dst[j * outW + i] =
                    (1-tx)*(1-ty)*src[y0*inW+x0] + tx*(1-ty)*src[y0*inW+x1] +
                    (1-tx)*   ty *src[y1*inW+x0] + tx*   ty *src[y1*inW+x1];
            }
        }
        return dst;
    }

    // ── NaN-gap fill (nearest valid neighbour) ────────────────────────────────
    _fillNaN(arr, W, H) {
        for (let j = 0; j < H; j++) {
            for (let i = 0; i < W; i++) {
                if (isFinite(arr[j * W + i])) continue;
                outer: for (let r = 1; r <= Math.max(W, H); r++) {
                    for (let dj = -r; dj <= r; dj++) {
                        for (let di = -r; di <= r; di++) {
                            const ni = ((i + di) % W + W) % W;
                            const nj = Math.max(0, Math.min(H-1, j + dj));
                            const v  = arr[nj * W + ni];
                            if (isFinite(v)) { arr[j * W + i] = v; break outer; }
                        }
                    }
                }
            }
        }
    }

    // ── Separable box blur (radius R → kernel width 2R+1) ───────────────────
    // Wraps longitude (x axis); clamps latitude (y axis).
    _boxBlur(src, W, H, R) {
        const tmp = new Float32Array(W * H);
        const dst = new Float32Array(W * H);
        const diam = 2 * R + 1;

        // Horizontal pass (wrap longitude)
        for (let j = 0; j < H; j++) {
            let sum = 0;
            // Seed with first window
            for (let dx = -R; dx <= R; dx++) {
                sum += src[j * W + ((dx % W) + W) % W];
            }
            tmp[j * W + 0] = sum / diam;
            for (let i = 1; i < W; i++) {
                sum += src[j * W + ((i + R) % W)] - src[j * W + (((i - R - 1) % W) + W) % W];
                tmp[j * W + i] = sum / diam;
            }
        }

        // Vertical pass (clamp latitude)
        for (let i = 0; i < W; i++) {
            let sum = 0;
            for (let dy = -R; dy <= R; dy++) {
                sum += tmp[Math.max(0, Math.min(H - 1, dy)) * W + i];
            }
            dst[0 * W + i] = sum / diam;
            for (let j = 1; j < H; j++) {
                sum += tmp[Math.min(H - 1, j + R) * W + i] - tmp[Math.max(0, j - R - 1) * W + i];
                dst[j * W + i] = sum / diam;
            }
        }

        return dst;
    }

    // ── Procedural fallback: physically motivated zonal circulation ───────────
    // Reproduces major features: Hadley cell, Ferrel cell, polar cell,
    // trade winds, mid-latitude westerlies, Intertropical Convergence Zone.
    _buildProcedural() {
        const TWO_PI = Math.PI * 2;
        for (let j = 0; j < TEX_H; j++) {
            for (let i = 0; i < TEX_W; i++) {
                const k   = j * TEX_W + i;
                const lat = (j / (TEX_H - 1) - 0.5) * Math.PI;   // -π/2 … +π/2
                const lon = (i / (TEX_W - 1) - 0.5) * TWO_PI;    // -π … +π
                const t4  = k * 4;

                // Temperature: equatorial maximum, polar minimum, Rossby wave perturbation
                const tBase = Math.cos(lat * 1.05) * 0.5 + 0.5;
                const wave  = 0.18 * Math.sin(lon * 3.0 + lat * 1.5)
                            + 0.10 * Math.sin(lon * 5.0 - lat * 2.5)
                            + 0.06 * Math.sin(lon * 7.0 + lat * 0.8);
                const tNorm = Math.max(0, Math.min(1, tBase + wave));

                // Pressure: subtropical highs (±30°), equatorial low, polar lows
                const pNorm = 0.5 + 0.30 * Math.cos(lat * 3.0)
                                  + 0.10 * Math.sin(lon * 4.0 + lat);

                // Humidity: ITCZ near equator, dry subtropics, moist storm tracks
                const hNorm = Math.max(0, Math.cos(lat * 1.8) * 0.8
                            + 0.20 * Math.abs(Math.sin(lat * 3.0 + lon * 2.0)));

                // Wind — idealised 3-cell zonal circulation. `−sin(6φ)·cos(φ)`
                // goes cleanly through zeros at lat = 0, ±30°, ±60°, ±90°:
                //   peaks easterly at ±15° (Hadley / trade winds)
                //   peaks westerly at ±45° (Ferrel mid-lat westerlies)
                //   peaks easterly at ±75° (polar easterlies)
                //   cos(φ) attenuates the polar amplitude so the ±75° band
                //     ends up visibly weaker than the mid-lat jet.
                // The earlier `-sin(3φ)` formula had the sign inverted in
                // mid-latitudes — westerlies came out as easterlies, which
                // on a correctly-oriented globe (post flipY fix) was obviously
                // wrong. `sin(6φ)` matches the real 3-cell structure.
                //
                // This is the LAST-RESORT fallback when Open-Meteo fails;
                // the wx-panel source label still reads "procedural (GFS
                // unavailable)" so users can tell they're on synthetic data.
                // A small longitudinal ripple sin(2λ)·0.08 breaks the
                // monotonous ring so particles don't stream in a perfect
                // latitude band (which reads as fake immediately).
                const windU = (-0.55 * Math.sin(lat * 6.0) * Math.cos(lat))
                            + 0.08 * Math.sin(lon * 2.0) * Math.cos(lat * 3.0);
                const windV = 0.05 * Math.sin(lon * 2.0 + lat * 1.5) * Math.cos(lat);
                const wMag  = Math.sqrt(windU * windU + windV * windV);

                this._weatherBuf[t4+0] = tNorm;
                this._weatherBuf[t4+1] = Math.max(0, Math.min(1, pNorm));
                this._weatherBuf[t4+2] = Math.max(0, Math.min(1, hNorm));
                this._weatherBuf[t4+3] = Math.min(1, wMag * 1.3);

                this._windBuf[t4+0] = windU;
                this._windBuf[t4+1] = windV;
                this._windBuf[t4+2] = Math.min(1, wMag * 1.3);
                this._windBuf[t4+3] = 1.0;

                // Procedural cloud layers — neutral low-coverage field.
                // Previously this used abs(lat)-based ITCZ/mid-lat/polar
                // bands, which produced strong horizontal strips during
                // the ~5-10 s window before Open-Meteo resolved (and any
                // time the fetch fails outright). Now we emit a constant
                // half-strength cover plus a quiet longitudinal ripple so
                // the shader has SOMETHING to modulate without teaching
                // the user's eye to expect zonal bands as the default.
                const ripple = 0.06 * Math.sin(lon * 4.0 + lat * 1.3);
                const jitter = 0.04 * Math.sin(lon * 9.0 - lat * 5.1);
                const base   = 0.50 + ripple + jitter;
                this._cloudBuf[t4+0] = Math.max(0.25, Math.min(0.75, base));
                this._cloudBuf[t4+1] = Math.max(0.20, Math.min(0.70, base - 0.05));
                this._cloudBuf[t4+2] = Math.max(0.15, Math.min(0.60, base - 0.12));
                this._cloudBuf[t4+3] = 0.0;  // no procedural precipitation
            }
        }
    }

    // ── Session snapshot (last-known-good) ───────────────────────────────────

    /**
     * Serialize the current buffer trio to sessionStorage so the next page
     * load in this tab can restore real data instead of booting to
     * procedural while the fetch is in flight (or while the upstream is
     * down).  Fires after every successful _fetchAndProcess.
     * Swallows QuotaExceededError — best-effort cache.
     */
    _saveSnapshot() {
        try {
            if (typeof sessionStorage === 'undefined') return;
            const snap = {
                version:     1,
                savedAt:     Date.now(),
                source:      this._meta.source,
                fetchTime:   this._meta.fetchTime?.getTime?.() ?? null,
                weather_b64: _f32ToBase64(this._weatherBuf),
                wind_b64:    _f32ToBase64(this._windBuf),
                cloud_b64:   _f32ToBase64(this._cloudBuf),
            };
            sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
        } catch (err) {
            // Quota full or encoding error — cache is optional, keep going.
            console.debug('[WeatherFeed] snapshot save skipped:', err?.message);
        }
    }

    /**
     * Attempt to restore a snapshot from sessionStorage. Returns true if
     * buffers were populated from cache (caller should treat this as
     * "_hasGoodData = true"), false otherwise.
     *
     * A stale-but-restored cache gets a visible `source: "cached · ..."`
     * tag in meta so the UI can flag the user that this isn't live data.
     */
    _restoreSnapshot() {
        try {
            if (typeof sessionStorage === 'undefined') return false;
            const raw = sessionStorage.getItem(SNAPSHOT_KEY);
            if (!raw) return false;
            const snap = JSON.parse(raw);
            if (snap.version !== 1) return false;

            const age = Date.now() - (snap.savedAt ?? 0);
            if (age < 0 || age > SNAPSHOT_MAX_AGE_MS) {
                sessionStorage.removeItem(SNAPSHOT_KEY);
                return false;
            }

            const w  = _base64ToF32(snap.weather_b64);
            const wi = _base64ToF32(snap.wind_b64);
            const c  = _base64ToF32(snap.cloud_b64);
            // Size sanity — mismatched TEX_W/TEX_H between versions would
            // blow up set() below; bail loudly and rebuild procedural.
            if (w.length  !== this._weatherBuf.length ||
                wi.length !== this._windBuf.length    ||
                c.length  !== this._cloudBuf.length) {
                sessionStorage.removeItem(SNAPSHOT_KEY);
                return false;
            }

            this._weatherBuf.set(w);
            this._windBuf.set(wi);
            this._cloudBuf.set(c);

            const ageMin = Math.round(age / 60_000);
            this._meta.loaded    = false;   // cached ≠ live
            this._meta.source    = `cached (${snap.source ?? 'previous session'} · ${ageMin}m ago)`;
            this._meta.fetchTime = snap.fetchTime ? new Date(snap.fetchTime) : null;
            console.info(`[WeatherFeed] restored session snapshot (${ageMin}m old) — bridging until live fetch lands`);
            return true;
        } catch (err) {
            console.debug('[WeatherFeed] snapshot restore skipped:', err?.message);
            return false;
        }
    }

    // ── Event helpers ─────────────────────────────────────────────────────────
    _dispatch(type, detail) {
        document.dispatchEvent(new CustomEvent(type, { detail }));
    }
}
