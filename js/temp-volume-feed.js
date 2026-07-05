/**
 * temp-volume-feed.js — upper-air anchors (temperature + winds) for the 3-D
 * volume and the multi-level advection model.
 *
 * Fetches 850 hPa and 500 hPa temperature AND wind on the same 72×36 (5°)
 * grid the surface feed uses, browser-direct from Open-Meteo (same free
 * endpoint, chunking, retry and URL conventions as
 * js/weather-forecast-feed.js — read that file's comments for the rationale
 * behind each policy). Window is past 24 h → +72 h hourly, so the
 * ray-marched temperature volume (TEMPVOL_FRAG in js/earth-skin.js) scrubs
 * through the SAME simTimeMs the rest of the page keys off.
 *
 * Two consumers:
 *   • The volume visual — sample(tMs) → RGBA level anchors. The near term
 *     (0..+24 h) is owned by the IN-BROWSER multi-level advection model when
 *     a model ring has been installed via setModelRing() (mirroring how the
 *     surface globe paints RK2 near-term and hands off to NWP — same seam-
 *     blend idea as WeatherFrameResolver's model→NWP crossfade); beyond the
 *     model span, and for the past, the Open-Meteo hourly ring paints.
 *   • The multilevel-advection-v1 forecaster — levelWindSnapshot() hands it
 *     per-level steering winds + tendencies for the registry forecast.
 *
 * Deliberately NOT part of the 9-channel CHW pipeline
 * ───────────────────────────────────────────────────
 * weather-history.js validates frames against NUM_CHANNELS=9 and persists
 * them to IDB; every forecaster, the validator, the worker protocol, and the
 * server cache share that contract. Adding two channels would invalidate
 * stored rings and touch a dozen modules. This feed keeps its own in-memory
 * ring (8 ch × ~10 KB × 96 h ≈ 8 MB) and hands consumers views into it. The
 * multi-level forecaster consumes these levels through levelWindSnapshot()
 * rather than through the 9-channel contract precisely so the durable ring,
 * the validator schema, and the worker protocol stay untouched.
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

const HOURLY_VARS = [
    'temperature_850hPa', 'temperature_500hPa',
    'wind_speed_850hPa', 'wind_direction_850hPa',
    'wind_speed_500hPa', 'wind_direction_500hPa',
    'cape', 'freezing_level_height',
].join(',');

// Per-frame channel layout (CHW over N cells). Winds are stored decomposed
// U/V in met convention ("direction FROM" → velocity), lockstep with the
// surface feed's channel 3/4 semantics. CAPE (J/kg) and freezing-level
// height (m) are NWP diagnostics — they ride the ring for the scrub but are
// NOT advected by the multi-level model (CAPE is a column integral of the
// very profile advection would deform; transporting the diagnostic instead
// of re-deriving it would be pseudo-physics).
export const LVL = Object.freeze({
    T850: 0, T500: 1, U850: 2, V850: 3, U500: 4, V500: 5, CAPE: 6, FLH: 7,
});
const LVL_CHANNELS = 8;

// Aux-texture encodings (sampleAux): CAPE normalised against the top of the
// operational scale (4000 J/kg ≈ "extreme instability"), freezing level
// against 10 km (above any real-world value).
const CAPE_FULL_SCALE_J = 4000;
const FLH_FULL_SCALE_M  = 10_000;

// Seam between the model-owned near term and the NWP ring, mirroring
// WeatherFrameResolver's DEFAULT_SEAM_BLEND_MS so the volume and the
// surface globe cross from "our model" to NWP with the same feel.
const MODEL_SEAM_MS = 4 * HOUR_MS;

const DEG2RAD = Math.PI / 180;

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
        + `&wind_speed_unit=ms`
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
 * @param {Array<{hourly:object}>} merged  GRID_N locations
 * @returns {Array<{t:number, data:Float32Array}>}  data = 6×N CHW per LVL
 */
export function pivotLevelResponses(merged) {
    const times = merged[0]?.hourly?.time ?? [];
    const frames = [];
    for (let h = 0; h < times.length; h++) {
        const t = Date.parse(times[h] + 'Z');
        if (!Number.isFinite(t)) continue;
        const data = new Float32Array(GRID_N * LVL_CHANNELS);
        for (let cell = 0; cell < GRID_N; cell++) {
            const loc = merged[cell]?.hourly;
            data[LVL.T850 * GRID_N + cell] = loc?.temperature_850hPa?.[h] ?? NaN;
            data[LVL.T500 * GRID_N + cell] = loc?.temperature_500hPa?.[h] ?? NaN;
            // Met-convention "from" → velocity (-sin·s, -cos·s), matching
            // the surface feed's decompose in weather-forecast-feed.js.
            const s850 = loc?.wind_speed_850hPa?.[h];
            const d850 = loc?.wind_direction_850hPa?.[h];
            const s500 = loc?.wind_speed_500hPa?.[h];
            const d500 = loc?.wind_direction_500hPa?.[h];
            const ok850 = Number.isFinite(s850) && Number.isFinite(d850);
            const ok500 = Number.isFinite(s500) && Number.isFinite(d500);
            data[LVL.U850 * GRID_N + cell] = ok850 ? -Math.sin(d850 * DEG2RAD) * s850 : NaN;
            data[LVL.V850 * GRID_N + cell] = ok850 ? -Math.cos(d850 * DEG2RAD) * s850 : NaN;
            data[LVL.U500 * GRID_N + cell] = ok500 ? -Math.sin(d500 * DEG2RAD) * s500 : NaN;
            data[LVL.V500 * GRID_N + cell] = ok500 ? -Math.cos(d500 * DEG2RAD) * s500 : NaN;
            data[LVL.CAPE * GRID_N + cell] = loc?.cape?.[h] ?? NaN;
            data[LVL.FLH  * GRID_N + cell] = loc?.freezing_level_height?.[h] ?? NaN;
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
        // Model-advected near-term ring (multilevelLevelsDense output):
        // { issued_ms, frames: [{h, target_ms, t850, t500}] }. Installed by
        // earth.html whenever the multi-level model recomputes; sample()
        // prefers it inside its span with a seam blend into the NWP ring.
        this._modelRing     = null;
    }

    get hasData()   { return this._frames.length >= 1; }
    get isFetching(){ return this._inflight !== null; }
    get modelRing() { return this._modelRing; }

    /**
     * Install (or clear, with null) the model-advected level ring. A stale
     * ring — issued before the newest NWP frame's own issue window — is
     * still accepted: staleness is bounded by the caller recomputing on
     * every ingest, and the seam math clamps t inside the ring span.
     */
    setModelRing(ring) {
        this._modelRing = (ring && Array.isArray(ring.frames) && ring.frames.length)
            ? ring : null;
    }

    /**
     * Newest hourly snapshot at-or-before tMs (default: now) for the
     * multi-level forecaster: named per-level views + hourly tendencies
     * from the preceding frame (null at the ring's oldest edge).
     */
    levelWindSnapshot(tMs = Date.now()) {
        const fr = this._frames;
        if (fr.length === 0) return null;
        let idx = 0;
        for (let i = 0; i < fr.length; i++) {
            if (fr[i].t <= tMs) idx = i; else break;
        }
        const cur  = fr[idx];
        const prev = idx > 0 ? fr[idx - 1] : null;
        const view = (f, ch) => f.data.subarray(ch * GRID_N, (ch + 1) * GRID_N);
        const tend = (ch) => {
            if (!prev) return null;
            const c = view(cur, ch), p = view(prev, ch);
            const d = new Float32Array(GRID_N);
            const dtH = Math.max(1, (cur.t - prev.t) / HOUR_MS);
            for (let k = 0; k < GRID_N; k++) d[k] = (c[k] - p[k]) / dtH;
            return d;
        };
        return {
            t: cur.t, gridW: GRID_W, gridH: GRID_H,
            t850: view(cur, LVL.T850), t500: view(cur, LVL.T500),
            u850: view(cur, LVL.U850), v850: view(cur, LVL.V850),
            u500: view(cur, LVL.U500), v500: view(cur, LVL.V500),
            tendU850: tend(LVL.U850), tendV850: tend(LVL.V850),
            tendU500: tend(LVL.U500), tendV500: tend(LVL.V500),
        };
    }

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

    // Bracketing NWP-ring frames for tMs, clamped at the ring's ends.
    _bracket(tMs) {
        const fr = this._frames;
        let lo = fr[0], hi = fr[fr.length - 1], frac = 0;
        if (tMs <= lo.t)      { hi = lo; }
        else if (tMs >= hi.t) { lo = hi; }
        else {
            for (let i = 1; i < fr.length; i++) {
                if (fr[i].t >= tMs) { lo = fr[i - 1]; hi = fr[i]; break; }
            }
            frac = (tMs - lo.t) / Math.max(1, hi.t - lo.t);
        }
        return { a: lo.data, b: hi.data, frac };
    }

    // NWP-ring level temperatures at tMs, lerped between bracketing hourly
    // frames and clamped at the ring's ends. Writes °C into t850/t500 (N).
    _nwpLevelsInto(tMs, t850, t500) {
        const { a, b, frac } = this._bracket(tMs);
        const o850 = LVL.T850 * GRID_N, o500 = LVL.T500 * GRID_N;
        for (let k = 0; k < GRID_N; k++) {
            t850[k] = a[o850 + k] + (b[o850 + k] - a[o850 + k]) * frac;
            t500[k] = a[o500 + k] + (b[o500 + k] - a[o500 + k]) * frac;
        }
    }

    /**
     * Write the encoded convective diagnostics at tMs into `out` (RGBA
     * Float32, GRID_N×4): R = CAPE / 4000 J/kg, G = freezing level / 10 km,
     * both clamped [0,1]; B unused; A = 1. Pure NWP-ring interpolation —
     * see the LVL comment for why these diagnostics are not model-advected.
     * NaN (upstream gap) encodes as 0 → overlay paints nothing there.
     *
     * @returns {boolean} false when the ring is empty (out untouched)
     */
    sampleAux(tMs, out) {
        if (this._frames.length === 0) return false;
        const { a, b, frac } = this._bracket(tMs);
        const oCape = LVL.CAPE * GRID_N, oFlh = LVL.FLH * GRID_N;
        for (let k = 0; k < GRID_N; k++) {
            const cape = a[oCape + k] + (b[oCape + k] - a[oCape + k]) * frac;
            const flh  = a[oFlh + k]  + (b[oFlh + k]  - a[oFlh + k])  * frac;
            out[k * 4]     = Math.max(0, Math.min(1, cape / CAPE_FULL_SCALE_J)) || 0;
            out[k * 4 + 1] = Math.max(0, Math.min(1, flh / FLH_FULL_SCALE_M)) || 0;
            out[k * 4 + 2] = 0;
            out[k * 4 + 3] = 1;
        }
        return true;
    }

    // Model-ring weight at tMs: 1 inside the model-owned span, ramping to 0
    // across the last MODEL_SEAM_MS before the ring's deepest hour, 0 for
    // the past and beyond. Mirrors the surface resolver's model→NWP seam.
    _modelWeight(tMs) {
        const ring = this._modelRing;
        if (!ring) return 0;
        const start = ring.issued_ms;
        const end   = ring.frames[ring.frames.length - 1].target_ms;
        if (tMs < start || tMs >= end) return 0;
        const seamStart = end - Math.min(MODEL_SEAM_MS, end - start);
        return tMs <= seamStart ? 1 : (end - tMs) / (end - seamStart);
    }

    // Model-ring level temperatures at tMs (assumes _modelWeight > 0, so
    // tMs is inside the span). Hourly frames → index + lerp.
    _modelLevelsInto(tMs, t850, t500) {
        const frames = this._modelRing.frames;
        let lo = frames[0], hi = frames[frames.length - 1];
        for (let i = 1; i < frames.length; i++) {
            if (frames[i].target_ms >= tMs) { lo = frames[i - 1]; hi = frames[i]; break; }
        }
        const frac = Math.max(0, Math.min(1,
            (tMs - lo.target_ms) / Math.max(1, hi.target_ms - lo.target_ms)));
        for (let k = 0; k < GRID_N; k++) {
            t850[k] = lo.t850[k] + (hi.t850[k] - lo.t850[k]) * frac;
            t500[k] = lo.t500[k] + (hi.t500[k] - lo.t500[k]) * frac;
        }
    }

    /**
     * Write the encoded level anchors at time tMs into `out` (RGBA Float32,
     * GRID_N×4): R = T850, G = T500, both (T+60)/110; B unused; A = 1.
     *
     * Source precedence mirrors the surface globe: the in-browser
     * multi-level advection ring owns [issued .. deepest−4 h], crossfades
     * into the Open-Meteo NWP ring across the 4 h seam, and the NWP ring
     * carries the past and the deep future. NaN cells (upstream gap)
     * encode as 0 → shader renders them as deep cold; rare enough not to
     * special-case.
     *
     * @returns {boolean} false when no ring has data (out untouched)
     */
    sample(tMs, out) {
        const haveNwp   = this._frames.length > 0;
        const wModelRaw = this._modelWeight(tMs);
        // Without NWP data the model ring paints alone (weight forced to 1
        // inside its span); without a model ring the NWP paints alone.
        const wModel = haveNwp ? wModelRaw : (wModelRaw > 0 ? 1 : 0);
        if (!haveNwp && wModel === 0) return false;

        if (!this._t850Tmp) {
            this._t850Tmp = new Float32Array(GRID_N);
            this._t500Tmp = new Float32Array(GRID_N);
            this._t850Mdl = new Float32Array(GRID_N);
            this._t500Mdl = new Float32Array(GRID_N);
        }
        const t850 = this._t850Tmp, t500 = this._t500Tmp;
        // NWP interpolation only when the blend actually consumes it — a
        // model-owned sample (wModel ≥ 1) overwrites it wholesale anyway.
        if (haveNwp && wModel < 1) this._nwpLevelsInto(tMs, t850, t500);
        if (wModel > 0) {
            this._modelLevelsInto(tMs, this._t850Mdl, this._t500Mdl);
            if (wModel >= 1 || !haveNwp) {
                t850.set(this._t850Mdl); t500.set(this._t500Mdl);
            } else {
                for (let k = 0; k < GRID_N; k++) {
                    t850[k] = this._t850Mdl[k] * wModel + t850[k] * (1 - wModel);
                    t500[k] = this._t500Mdl[k] * wModel + t500[k] * (1 - wModel);
                }
            }
        }
        for (let k = 0; k < GRID_N; k++) {
            out[k * 4]     = Math.max(0, Math.min(1, (t850[k] - ENC_MIN) / ENC_SPAN)) || 0;
            out[k * 4 + 1] = Math.max(0, Math.min(1, (t500[k] - ENC_MIN) / ENC_SPAN)) || 0;
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
