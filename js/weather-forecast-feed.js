/**
 * weather-forecast-feed.js
 *
 * Lazy client-side fetcher for hourly forecast U/V/T/P/RH/cloud/precip
 * frames on the same 72×36 (5°) grid the past-tier WeatherFeed/cron use.
 * Pushes records into WeatherHistory.ingestForecast() so the resolver's
 * bracket() can lerp through future hours just like it does past hours.
 *
 * Design constraints (per user direction)
 * ───────────────────────────────────────
 *   1. NO server changes. We hit Open-Meteo's bulk forecast endpoint
 *      directly from the browser — same fan-out pattern as the cron
 *      (3 chunks × 864 coords).
 *   2. Lazy. Until the user scrubs forward, the ring stays empty and
 *      bracket() falls back to "clamp at newest observation". The first
 *      future-scrub kicks fetchOnce(); subsequent scrubs reuse the ring.
 *   3. Single fetch per session by default. The free Open-Meteo IP-shared
 *      rate limit is 10 000/day, and the cron already burns 72/day from
 *      the same edge IP pool. One client-initiated triplet per session
 *      keeps us safely within budget for a small audience.
 *
 * What we fetch
 * ─────────────
 *   GET https://api.open-meteo.com/v1/forecast
 *       ?latitude=…&longitude=…
 *       &hourly=temperature_2m,relative_humidity_2m,surface_pressure,
 *               wind_speed_10m,wind_direction_10m,cloud_cover_low,
 *               cloud_cover_mid,cloud_cover_high,precipitation
 *       &wind_speed_unit=ms
 *       &timezone=UTC
 *       &forecast_hours=24
 *
 * Response per location: { hourly: { time: [...], <var>: [...] } } with
 * arrays of length 24 (one entry per forecast hour). Three chunked calls
 * cover the full 2592-cell grid; we pivot the per-location arrays into
 * one CHW Float32Array per forecast hour and ingest 24 frames into the
 * history forecast ring.
 *
 * Wind decomposition
 * ──────────────────
 * Same trig as weather-feed.js _processRows(): wdir is meteorological
 * "from" degrees, so the velocity vector is (-sin(rad)·speed, -cos(rad)·speed)
 * for (eastward, northward) U/V. Storing decomposed U/V means the
 * forecast bracket lerp doesn't have to wrap-aware-average degrees.
 *
 * Failure mode
 * ────────────
 * Any error → log + leave the ring empty → resolver falls back to clamp-
 * at-newest. We never poison the past-tier or block the renderer.
 */

const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';

// Mirror the cron's grid + chunking. Keep the constants verbatim so a
// later move from 5° → 2.5° can update both files together.
const GRID_W      = 72;
const GRID_H      = 36;
const GRID_N      = GRID_W * GRID_H;   // 2592
const GRID_DEG    = 180 / GRID_H;       // 5°
const LAT_ORIGIN  = -90  + GRID_DEG / 2; // -87.5
const LON_ORIGIN  = -180 + GRID_DEG / 2; // -177.5
const CHUNK_SIZE  = 864;                 // 3 chunks × 864 = 2592
const FORECAST_HOURS = 24;               // v1 horizon; ring caps at 14d total

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

function _chunkUrl(start, end) {
    const { lat, lon } = _chunkCoords(start, end);
    return `${OPEN_METEO_FORECAST}`
        + `?latitude=${lat}`
        + `&longitude=${lon}`
        + `&hourly=${HOURLY_VARS}`
        + `&wind_speed_unit=ms`
        + `&timezone=UTC`
        + `&forecast_hours=${FORECAST_HOURS}`;
}

export class WeatherForecastFeed {
    /**
     * @param {object} opts
     * @param {import('./weather-history.js').WeatherHistory} opts.history
     * @param {number} [opts.refreshMinAgeMs=10800000] — re-fetch only if
     *   the in-flight ring is older than this (default 3 h)
     */
    constructor({ history, refreshMinAgeMs = 3 * 60 * 60 * 1000 } = {}) {
        if (!history) throw new Error('WeatherForecastFeed: history is required');
        this._history          = history;
        this._refreshMinAgeMs  = refreshMinAgeMs;
        this._inflight         = null;        // pending Promise<void>
        this._lastFetchedAt    = 0;
    }

    /**
     * Fetch + ingest, idempotent within `refreshMinAgeMs`. Returns the
     * shared in-flight promise on overlapping calls so multiple
     * future-scrub events coalesce into one network triplet.
     *
     * Resolves to the number of frames ingested (0 on cache hit / error).
     */
    fetchOnce() {
        const now = Date.now();
        if (this._inflight) return this._inflight;
        if ((now - this._lastFetchedAt) < this._refreshMinAgeMs
            && this._history.forecastSize > 0) {
            return Promise.resolve(0);
        }
        this._inflight = this._fetchAndIngest()
            .catch(err => {
                console.warn('[WeatherForecastFeed] fetch failed:', err?.message ?? err);
                return 0;
            })
            .finally(() => {
                this._inflight = null;
            });
        return this._inflight;
    }

    async _fetchAndIngest() {
        // Issue all three chunks in parallel. Open-Meteo absorbs a few
        // concurrent requests per IP without throttling; the cron uses
        // CHUNK_CONCURRENCY=3 and we mirror it.
        const chunks = [];
        for (let start = 0; start < GRID_N; start += CHUNK_SIZE) {
            const end = Math.min(start + CHUNK_SIZE - 1, GRID_N - 1);
            chunks.push({ start, end });
        }
        const responses = await Promise.all(chunks.map(({ start, end }) =>
            this._fetchChunk(start, end)));

        // Merge the per-chunk arrays into a single 2592-long list of
        // per-location hourly objects. Order matches row-major (lat slow,
        // lon fast) by construction of _chunkCoords().
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

        // Pivot per-location-hourly into per-hour-grid CHW Float32Arrays
        // and ingest one record per forecast hour. The hour-key is
        // floor(t/3.6e6)*3.6e6 (UTC hour-start) — same convention as
        // WeatherHistory.ingest, so keys collide cleanly when an ingested
        // observation supersedes a previously-predicted hour.
        const fetchedAt = Date.now();
        const firstLocTimes = merged[0]?.hourly?.time ?? [];
        const H = Math.min(firstLocTimes.length, FORECAST_HOURS);
        let ingested = 0;
        for (let h = 0; h < H; h++) {
            const t = Date.parse(firstLocTimes[h] + 'Z');   // UTC ISO without Z
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

        this._lastFetchedAt = fetchedAt;
        // Hint to the resolver that fresh forecast frames just landed —
        // the next tick should re-bracket and re-emit so the user sees
        // the forecast even without moving the slider.
        if (typeof document !== 'undefined') {
            document.dispatchEvent(new CustomEvent('weather-forecast-ingest', {
                detail: { ingested, fetchedAt },
            }));
        }
        return ingested;
    }

    async _fetchChunk(start, end) {
        const url = _chunkUrl(start, end);
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
