/**
 * weather-forecast-feed.js
 *
 * Progressive client-side fetcher for hourly forecast U/V/T/P/RH/cloud/
 * precip frames on the same 72×36 (5°) grid the past-tier WeatherFeed
 * and Vercel cron use. Pushes records into WeatherHistory.ingestForecast()
 * so the resolver's bracket() can lerp through future hours just like it
 * does past hours.
 *
 * Why progressive (vs. one big fetch)
 * ───────────────────────────────────
 * A full +14 d hourly fetch for 2592 cells × 9 channels weighs ~30-40 MB
 * of JSON across three chunks — too heavy for one round trip on first
 * future-scrub. Progressive loading buys us:
 *
 *   1. First future-scrub feels fast: only +24 h fetched (~2-3 MB) before
 *      the user sees forecast frames painted on the globe.
 *   2. Subsequent scrubs deeper into the future trigger incremental
 *      "next 24 h" batches; the user only pays the bytes they actually
 *      look at.
 *   3. Idle sessions stop after the user's deepest scrub; we never burn
 *      a +14 d fetch for a user who only looked at +6 h.
 *
 * Public API
 * ──────────
 *   feed.ensureLoadedUntil(targetMs)   — guarantees the forecast ring
 *      covers at least up to `targetMs`, fetching the next hour-batch
 *      if needed. Idempotent + coalesces concurrent calls.
 *   feed.fetchOnce()                   — convenience: ensure +24 h.
 *   feed.loadedUntilMs                 — absolute ms of the deepest hour
 *      currently in the ring (0 if no fetch has landed).
 *   feed.isFetching                    — true while a chunked triplet is
 *      in flight.
 *
 * Events
 * ──────
 *   'weather-forecast-fetch-start' { range: { startMs, endMs } }
 *   'weather-forecast-fetch-end'   { range, ingested, error? }
 *   'weather-forecast-ingest'      { ingested, fetchedAt }   (per existing)
 *
 * The first two power the "fetching forecast…" indicator near the slider;
 * the third (existing) tells the resolver to invalidate.
 *
 * Failure mode
 * ────────────
 * Any HTTP / parse error → log + emit fetch-end with `error` → leave the
 * ring at its current depth → resolver's bracket() falls back to clamp-
 * at-newest. We never poison the past-tier or block the renderer.
 */

const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';
const HOUR_MS = 3_600_000;

// Mirror the cron's grid + chunking. Keep the constants verbatim so a
// later move from 5° → 2.5° can update both files together.
const GRID_W      = 72;
const GRID_H      = 36;
const GRID_N      = GRID_W * GRID_H;     // 2592
const GRID_DEG    = 180 / GRID_H;        // 5°
const LAT_ORIGIN  = -90  + GRID_DEG / 2; // -87.5
const LON_ORIGIN  = -180 + GRID_DEG / 2; // -177.5
const CHUNK_SIZE  = 864;                 // 3 chunks × 864 = 2592

// Default progressive-batch granularity. Each batch covers 24 forecast
// hours (~2-3 MB JSON across the three chunks) — fast enough for first
// future-scrub, small enough that idle deep-scrub burns minimal egress.
const DEFAULT_BATCH_HOURS    = 24;
// Hard ceiling: matches time-bus FUTURE_MS (14 d). Past this point the
// forecast ring's capacity (FORECAST_CAPACITY in weather-history.js)
// also runs out, so there's no point fetching further.
const DEFAULT_MAX_HORIZON_HR = 14 * 24;

// Channel layout matches WeatherHistory NUM_CHANNELS=9 / CHW packing.
//   0 = T (°C)   1 = P (hPa)   2 = RH (%)
//   3 = U (m/s)  4 = V (m/s)
//   5 = cloud_low   6 = cloud_mid   7 = cloud_high   (% each)
//   8 = precipitation (mm)
const NUM_CHANNELS = 9;
const CH_T = 0, CH_P = 1, CH_RH = 2, CH_U = 3, CH_V = 4;
const CH_CL = 5, CH_CM = 6, CH_CH = 7, CH_PR = 8;

const HOURLY_VARS = [
    'temperature_2m', 'relative_humidity_2m', 'surface_pressure',
    'wind_speed_10m', 'wind_direction_10m',
    'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
    'precipitation',
].join(',');

const DEG2RAD = Math.PI / 180;

function _chunkCoords(start, end) {
    const lats = [];
    const lons = [];
    for (let idx = start; idx <= end; idx++) {
        const j = Math.floor(idx / GRID_W);
        const i = idx % GRID_W;
        lats.push((LAT_ORIGIN + j * GRID_DEG).toFixed(2));
        lons.push((LON_ORIGIN + i * GRID_DEG).toFixed(2));
    }
    return { lat: lats.join(','), lon: lons.join(',') };
}

// Open-Meteo's `start_hour` / `end_hour` accept ISO 8601 datetimes
// without seconds, e.g. "2026-05-08T03:00". Range is closed-closed —
// the response includes both endpoints. We always align to UTC hour
// boundaries so each call returns a clean (endHour-startHour+1) row
// count and the hour-keys collide with ingest()'s _hourKey rounding.
function _isoHour(ms) {
    const d = new Date(ms);
    const yyyy = d.getUTCFullYear();
    const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(d.getUTCDate()).padStart(2, '0');
    const HH   = String(d.getUTCHours()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${HH}:00`;
}

function _chunkUrl(start, end, startMs, endMs) {
    const { lat, lon } = _chunkCoords(start, end);
    return `${OPEN_METEO_FORECAST}`
        + `?latitude=${lat}`
        + `&longitude=${lon}`
        + `&hourly=${HOURLY_VARS}`
        + `&wind_speed_unit=ms`
        + `&timezone=UTC`
        + `&start_hour=${_isoHour(startMs)}`
        + `&end_hour=${_isoHour(endMs)}`;
}

function _emit(type, detail) {
    if (typeof document === 'undefined') return;
    document.dispatchEvent(new CustomEvent(type, { detail }));
}

export class WeatherForecastFeed {
    /**
     * @param {object} opts
     * @param {import('./weather-history.js').WeatherHistory} opts.history
     * @param {number} [opts.refreshMinAgeMs=10800000] — re-fetch even
     *   already-loaded hours when the entire ring is older than this
     *   (default 3 h). Forecast accuracy decays past ~3 h of "valid as
     *   of"; refetching keeps the deepest already-explored hours fresh.
     * @param {number} [opts.batchHours=24]            — granularity of
     *   each progressive call.
     * @param {number} [opts.maxHorizonHours=336]      — hard ceiling on
     *   how far forward we'll fetch (default 14 d, matching time-bus
     *   FUTURE_MS and the forecast ring capacity).
     */
    constructor({
        history,
        refreshMinAgeMs = 3 * 60 * 60 * 1000,
        batchHours      = DEFAULT_BATCH_HOURS,
        maxHorizonHours = DEFAULT_MAX_HORIZON_HR,
    } = {}) {
        if (!history) throw new Error('WeatherForecastFeed: history is required');
        this._history          = history;
        this._refreshMinAgeMs  = refreshMinAgeMs;
        this._batchHours       = Math.max(1, batchHours);
        this._maxHorizonMs     = maxHorizonHours * HOUR_MS;
        // _loadedUntilMs is an absolute hour-aligned timestamp. 0 means
        // nothing fetched yet; otherwise the ring covers up to (and
        // including) the hour at this ms.
        this._loadedUntilMs    = 0;
        this._inflight         = null;
        this._inflightTargetMs = 0;
        this._lastFetchedAt    = 0;
    }

    get loadedUntilMs() { return this._loadedUntilMs; }
    get isFetching()    { return this._inflight !== null; }

    /**
     * Ensure the forecast ring covers at least up to `targetMs`. If the
     * ring is already deep enough (and not stale), resolves with 0
     * immediately. Otherwise issues exactly one chunked triplet for the
     * uncovered tail and resolves with the count of frames ingested.
     *
     * Concurrent overlapping calls coalesce: the second caller waits on
     * the first's promise (or, if the first won't reach `targetMs`,
     * triggers a follow-up batch on completion — but that's a future
     * optimisation; for now overlapping calls past the in-flight target
     * trigger a fresh fetch on resolution).
     */
    ensureLoadedUntil(targetMs) {
        const nowMs       = Date.now();
        const nowHourMs   = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
        const horizonMs   = nowHourMs + this._maxHorizonMs;
        const cappedTgt   = Math.min(targetMs, horizonMs);

        // Stale: entire ring older than refresh window → reset and refetch.
        const isStale = this._lastFetchedAt > 0
            && (nowMs - this._lastFetchedAt) > this._refreshMinAgeMs;
        if (isStale) this._loadedUntilMs = 0;

        // Already deep enough.
        if (cappedTgt <= this._loadedUntilMs) return Promise.resolve(0);

        // In-flight covers it: ride along.
        if (this._inflight && cappedTgt <= this._inflightTargetMs) {
            return this._inflight;
        }

        // Build the next batch: from the deeper of (current loaded edge)
        // and (next hour from now), out to `cappedTgt`, snapped to
        // batchHours boundaries so we make round-numbered fetches.
        const startMs = Math.max(
            this._loadedUntilMs > 0 ? this._loadedUntilMs + HOUR_MS : 0,
            nowHourMs + HOUR_MS,
        );
        const minBatchEndMs = startMs + (this._batchHours - 1) * HOUR_MS;
        const endMs = Math.min(horizonMs, Math.max(cappedTgt, minBatchEndMs));
        if (endMs < startMs) return Promise.resolve(0);

        this._inflightTargetMs = endMs;
        const range = { startMs, endMs };
        _emit('weather-forecast-fetch-start', { range });
        this._inflight = this._fetchRange(startMs, endMs)
            .then((ingested) => {
                this._loadedUntilMs = Math.max(this._loadedUntilMs, endMs);
                this._lastFetchedAt = Date.now();
                _emit('weather-forecast-fetch-end', { range, ingested });
                return ingested;
            })
            .catch((err) => {
                console.warn('[WeatherForecastFeed] fetch failed:', err?.message ?? err);
                _emit('weather-forecast-fetch-end',
                    { range, ingested: 0, error: err?.message ?? String(err) });
                return 0;
            })
            .finally(() => {
                this._inflight         = null;
                this._inflightTargetMs = 0;
            });
        return this._inflight;
    }

    /**
     * Convenience: fetch the next 24 h. Equivalent to
     * ensureLoadedUntil(Date.now() + 24h). Kept as a stable entry point
     * for callers who don't track simTime.
     */
    fetchOnce() {
        return this.ensureLoadedUntil(Date.now() + this._batchHours * HOUR_MS);
    }

    async _fetchRange(startMs, endMs) {
        // Fan three chunks out in parallel. Each chunk asks Open-Meteo
        // for the same hour-window (start_hour / end_hour) but a
        // different slice of the 2592-coord grid.
        const chunks = [];
        for (let start = 0; start < GRID_N; start += CHUNK_SIZE) {
            const end = Math.min(start + CHUNK_SIZE - 1, GRID_N - 1);
            chunks.push({ start, end });
        }
        const responses = await Promise.all(chunks.map(({ start, end }) =>
            this._fetchChunk(start, end, startMs, endMs)));

        // Merge per-chunk arrays into a single 2592-long list, in the
        // same row-major (lat slow, lon fast) order _chunkCoords laid out.
        const merged = [];
        for (const arr of responses) {
            if (!Array.isArray(arr)) {
                throw new Error('forecast chunk returned non-array');
            }
            merged.push(...arr);
        }
        if (merged.length !== GRID_N) {
            throw new Error(`forecast merge length ${merged.length} != ${GRID_N}`);
        }

        // Pivot per-location-hourly into per-hour-grid CHW Float32Arrays.
        // Time strings come back as "YYYY-MM-DDTHH:MM" — UTC because we
        // sent timezone=UTC. Append 'Z' before parsing to be explicit.
        const fetchedAt     = Date.now();
        const firstLocTimes = merged[0]?.hourly?.time ?? [];
        let ingested = 0;
        for (let h = 0; h < firstLocTimes.length; h++) {
            const t = Date.parse(firstLocTimes[h] + 'Z');
            if (!Number.isFinite(t)) continue;
            const coarse = new Float32Array(GRID_N * NUM_CHANNELS);
            for (let cell = 0; cell < GRID_N; cell++) {
                const loc = merged[cell]?.hourly;
                if (!loc) continue;
                const tempC  = loc.temperature_2m       ?.[h] ?? 0;
                const presH  = loc.surface_pressure     ?.[h] ?? 1013;
                const rhPct  = loc.relative_humidity_2m ?.[h] ?? 0;
                const sp     = loc.wind_speed_10m       ?.[h] ?? 0;
                const dirDeg = loc.wind_direction_10m   ?.[h] ?? 0;
                const cl     = loc.cloud_cover_low      ?.[h] ?? 0;
                const cm     = loc.cloud_cover_mid      ?.[h] ?? 0;
                const ch     = loc.cloud_cover_high     ?.[h] ?? 0;
                const pr     = loc.precipitation        ?.[h] ?? 0;
                // Met-convention "from" → velocity (-sin·s, -cos·s).
                const dirRad = dirDeg * DEG2RAD;
                const u = -Math.sin(dirRad) * sp;
                const v = -Math.cos(dirRad) * sp;
                // CHW layout: channel offsets stride by GRID_N.
                coarse[CH_T  * GRID_N + cell] = tempC;
                coarse[CH_P  * GRID_N + cell] = presH;
                coarse[CH_RH * GRID_N + cell] = rhPct;
                coarse[CH_U  * GRID_N + cell] = u;
                coarse[CH_V  * GRID_N + cell] = v;
                coarse[CH_CL * GRID_N + cell] = cl;
                coarse[CH_CM * GRID_N + cell] = cm;
                coarse[CH_CH * GRID_N + cell] = ch;
                coarse[CH_PR * GRID_N + cell] = pr;
            }
            this._history.ingestForecast({
                t,
                fetchedAt,
                source: 'open-meteo:72x36 forecast',
                gridW:  GRID_W,
                gridH:  GRID_H,
                coarse,
            });
            ingested++;
        }

        // Per-batch ingest event for the resolver's invalidate hook.
        _emit('weather-forecast-ingest', { ingested, fetchedAt });
        return ingested;
    }

    async _fetchChunk(start, end, startMs, endMs) {
        const url = _chunkUrl(start, end, startMs, endMs);
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} on chunk ${start}-${end}: ${body.slice(0, 200)}`);
        }
        const json = await res.json();
        // Open-Meteo error envelope: {"error":true,"reason":"..."}
        if (json && typeof json === 'object' && !Array.isArray(json) && json.error === true) {
            throw new Error(`upstream error chunk ${start}-${end}: ${json.reason ?? 'unknown'}`);
        }
        return Array.isArray(json) ? json : [json];
    }
}

export default WeatherForecastFeed;
