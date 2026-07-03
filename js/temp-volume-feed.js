/**
 * temp-volume-feed.js — upper-air temperature anchors for the 3-D volume.
 *
 * Fetches 850 hPa and 500 hPa temperature on the same 72×36 (5°) grid the
 * surface feed uses, browser-direct from Open-Meteo (same free endpoint,
 * chunking, retry and URL conventions as js/weather-forecast-feed.js — read
 * that file's comments for the rationale behind each policy). Window is
 * past 24 h → +72 h hourly, so the ray-marched temperature volume
 * (TEMPVOL_FRAG in js/earth-skin.js) scrubs through the SAME simTimeMs the
 * rest of the page keys off: the vertical structure is genuinely predictive
 * out to three days, not a frozen snapshot.
 *
 * Deliberately NOT part of the 9-channel CHW pipeline
 * ───────────────────────────────────────────────────
 * weather-history.js validates frames against NUM_CHANNELS=9 and persists
 * them to IDB; every forecaster, the validator, the worker protocol, and the
 * server cache share that contract. Adding two channels would invalidate
 * stored rings and touch a dozen modules for what is (today) a render-only
 * consumer. This feed keeps its own tiny in-memory ring (~21 KB/frame × 96 ≈
 * 2 MB) and exposes sample(tMs) → one 72×36 RGBA upload. If a forecaster
 * ever wants these levels as inputs, that's the moment to design the channel
 * migration — not before.
 *
 * Laziness / rate-limit budget
 * ────────────────────────────
 * Nothing is fetched at boot. earth.html calls start() the first time the
 * user enables the volume layer; the three grid chunks are fetched
 * SERIALLY with a short gap (the NWP feed's progressive walk already
 * budgets Open-Meteo's rate limit at boot — this feed must not stack a
 * parallel burst on top; see the 429 scar tissue in weather-forecast-feed).
 *
 * Events
 *   'temp-volume-update'  { frames, fromMs, toMs }  — ring (re)loaded
 *   'temp-volume-error'   { error }                 — load failed (ring keeps
 *                                                     whatever it had)
 */

const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';
const HOUR_MS = 3_600_000;

// Lockstep with weather-forecast-feed.js / the cron grid generator.
const GRID_W     = 72;
const GRID_H     = 36;
const GRID_N     = GRID_W * GRID_H;
const GRID_DEG   = 180 / GRID_H;
const LAT_ORIGIN = -90  + GRID_DEG / 2;
const LON_ORIGIN = -180 + GRID_DEG / 2;
const CHUNK_SIZE = 864;
const CHUNK_GAP_MS = 400;      // serial-fetch spacing, rate-limit courtesy

const PAST_HOURS   = 24;       // match the replay ring
const FUTURE_HOURS = 72;       // +3 d of real vertical structure

// Texture encoding shared with js/weather-decode.js and the shaders:
// value = (T °C + 60) / 110, domain −60…+50 °C.
const ENC_MIN = -60, ENC_SPAN = 110;

const HOURLY_VARS = 'temperature_850hPa,temperature_500hPa';

function _isoHour(ms) {
    const d = new Date(ms);
    const yyyy = d.getUTCFullYear();
    const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(d.getUTCDate()).padStart(2, '0');
    const HH   = String(d.getUTCHours()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${HH}:00`;
}

function _chunkCoords(start, end) {
    const lats = [], lons = [];
    for (let idx = start; idx <= end; idx++) {
        const j = Math.floor(idx / GRID_W);
        const i = idx % GRID_W;
        lats.push((LAT_ORIGIN + j * GRID_DEG).toFixed(2));
        lons.push((LON_ORIGIN + i * GRID_DEG).toFixed(2));
    }
    return { lat: lats.join(','), lon: lons.join(',') };
}

function _chunkUrl(start, end, startMs, endMs) {
    const { lat, lon } = _chunkCoords(start, end);
    return `${OPEN_METEO_FORECAST}`
        + `?latitude=${lat}`
        + `&longitude=${lon}`
        + `&hourly=${HOURLY_VARS}`
        + `&timezone=UTC`
        + `&start_hour=${_isoHour(startMs)}`
        + `&end_hour=${_isoHour(endMs)}`;
}

function _emit(type, detail) {
    if (typeof document === 'undefined') return;
    document.dispatchEvent(new CustomEvent(type, { detail }));
}

/**
 * Pivot the merged per-location Open-Meteo response into hourly frames.
 * Pure — exported for the node smoke test.
 *
 * @param {Array<{hourly:{time:string[], temperature_850hPa:number[],
 *                temperature_500hPa:number[]}}>} merged  GRID_N locations
 * @returns {Array<{t:number, data:Float32Array}>}  data = [t850…, t500…] (2×N)
 */
export function pivotLevelResponses(merged) {
    const times = merged[0]?.hourly?.time ?? [];
    const frames = [];
    for (let h = 0; h < times.length; h++) {
        const t = Date.parse(times[h] + 'Z');
        if (!Number.isFinite(t)) continue;
        const data = new Float32Array(GRID_N * 2);
        for (let cell = 0; cell < GRID_N; cell++) {
            const loc = merged[cell]?.hourly;
            data[cell]          = loc?.temperature_850hPa?.[h] ?? NaN;
            data[GRID_N + cell] = loc?.temperature_500hPa?.[h] ?? NaN;
        }
        frames.push({ t, data });
    }
    return frames;
}

export class TempVolumeFeed {
    constructor({ refreshMinAgeMs = 3 * 60 * 60 * 1000 } = {}) {
        this._frames        = [];      // sorted by t ascending
        this._fetchedAt     = 0;
        this._refreshMinAgeMs = refreshMinAgeMs;
        this._inflight      = null;
    }

    get hasData()   { return this._frames.length >= 1; }
    get isFetching(){ return this._inflight !== null; }

    /** Idempotent lazy load; re-fetch only when the ring has gone stale. */
    start() {
        if (this._inflight) return this._inflight;
        if (this._fetchedAt && Date.now() - this._fetchedAt < this._refreshMinAgeMs) {
            return Promise.resolve(this._frames.length);
        }
        const fromMs = Date.now() - PAST_HOURS * HOUR_MS;
        const toMs   = Date.now() + FUTURE_HOURS * HOUR_MS;
        this._inflight = this._fetchRange(fromMs, toMs)
            .then((n) => {
                this._fetchedAt = Date.now();
                _emit('temp-volume-update', { frames: n, fromMs, toMs });
                return n;
            })
            .catch((err) => {
                console.warn('[TempVolumeFeed] fetch failed:', err?.message ?? err);
                _emit('temp-volume-error', { error: err?.message ?? String(err) });
                return 0;
            })
            .finally(() => { this._inflight = null; });
        return this._inflight;
    }

    /**
     * Write the encoded level anchors at time tMs into `out` (RGBA Float32,
     * GRID_N×4): R = T850, G = T500, both (T+60)/110; B unused; A = 1.
     * Lerped between bracketing hourly frames, clamped at the ring's ends.
     * NaN cells (upstream gap) encode as 0 → shader renders them as deep
     * cold; rare enough not to special-case.
     *
     * @returns {boolean} false when the ring is empty (out untouched)
     */
    sample(tMs, out) {
        const fr = this._frames;
        if (fr.length === 0) return false;
        let lo = fr[0], hi = fr[fr.length - 1], frac = 0;
        if (tMs <= lo.t)      { hi = lo; }
        else if (tMs >= hi.t) { lo = hi; }
        else {
            for (let i = 1; i < fr.length; i++) {
                if (fr[i].t >= tMs) { lo = fr[i - 1]; hi = fr[i]; break; }
            }
            frac = (tMs - lo.t) / Math.max(1, hi.t - lo.t);
        }
        const a = lo.data, b = hi.data;
        for (let k = 0; k < GRID_N; k++) {
            const t850 = a[k] + (b[k] - a[k]) * frac;
            const t500 = a[GRID_N + k] + (b[GRID_N + k] - a[GRID_N + k]) * frac;
            out[k * 4]     = Math.max(0, Math.min(1, (t850 - ENC_MIN) / ENC_SPAN)) || 0;
            out[k * 4 + 1] = Math.max(0, Math.min(1, (t500 - ENC_MIN) / ENC_SPAN)) || 0;
            out[k * 4 + 2] = 0;
            out[k * 4 + 3] = 1;
        }
        return true;
    }

    async _fetchRange(startMs, endMs) {
        const merged = [];
        for (let start = 0; start < GRID_N; start += CHUNK_SIZE) {
            const end = Math.min(start + CHUNK_SIZE - 1, GRID_N - 1);
            if (start > 0) await new Promise(r => setTimeout(r, CHUNK_GAP_MS));
            const arr = await this._fetchChunk(start, end, startMs, endMs);
            merged.push(...arr);
        }
        if (merged.length !== GRID_N) {
            throw new Error(`level merge length ${merged.length} != ${GRID_N}`);
        }
        const frames = pivotLevelResponses(merged);
        if (frames.length === 0) throw new Error('no hourly frames in response');
        this._frames = frames;
        return frames.length;
    }

    // Same retry contract as weather-forecast-feed.js::_fetchChunk (3
    // attempts, Retry-After-aware 429 handling, 20 s per-attempt abort,
    // transient network retry, fail-fast on other 4xx).
    async _fetchChunk(start, end, startMs, endMs, attempt = 1) {
        const MAX_ATTEMPTS  = 3;
        const ATTEMPT_TO_MS = 20_000;
        const url = _chunkUrl(start, end, startMs, endMs);

        const ctrl = new AbortController();
        const timeoutId = setTimeout(() => ctrl.abort(), ATTEMPT_TO_MS);

        const _retry = async (waitMs) => {
            if (attempt >= MAX_ATTEMPTS) return null;
            if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
            return this._fetchChunk(start, end, startMs, endMs, attempt + 1);
        };

        try {
            const res = await fetch(url, {
                headers: { Accept: 'application/json' },
                signal:  ctrl.signal,
            });
            if (res.status === 429) {
                const hdr = Number(res.headers.get('Retry-After'));
                const waitMs = Number.isFinite(hdr) && hdr > 0
                    ? Math.min(hdr * 1000, 10_000)
                    : (2 ** (attempt - 1)) * 1000;
                const r = await _retry(waitMs);
                if (r !== null) return r;
                throw new Error(`HTTP 429 on level chunk ${start}-${end} after ${attempt} attempts`);
            }
            if (!res.ok) {
                if (res.status >= 500 && res.status < 600) {
                    const r = await _retry((2 ** (attempt - 1)) * 1000);
                    if (r !== null) return r;
                }
                const body = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status} on level chunk ${start}-${end}: ${body.slice(0, 200)}`);
            }
            const json = await res.json();
            if (json && typeof json === 'object' && !Array.isArray(json) && json.error === true) {
                throw new Error(`upstream error level chunk ${start}-${end}: ${json.reason ?? 'unknown'}`);
            }
            const arr = Array.isArray(json) ? json : [json];
            if (arr.length === 0) throw new Error(`level chunk ${start}-${end}: empty response`);
            for (let i = 0; i < arr.length; i++) {
                const h = arr[i]?.hourly;
                if (!h || !Array.isArray(h.time)) {
                    throw new Error(`level chunk ${start}-${end}: missing hourly.time at idx ${i}`);
                }
            }
            return arr;
        } catch (err) {
            const transient = err?.name === 'AbortError'
                || (err?.name === 'TypeError' && /fetch/i.test(err?.message ?? ''));
            if (transient) {
                const r = await _retry((2 ** (attempt - 1)) * 1000);
                if (r !== null) return r;
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
        }
    }
}

export default TempVolumeFeed;
