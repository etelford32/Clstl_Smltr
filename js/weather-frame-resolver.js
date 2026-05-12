/**
 * weather-frame-resolver.js
 *
 * Reconstructs the weather/wind/cloud trio for any timestamp inside the
 * 24-hour replay window. Sits between WeatherHistory (durable storage,
 * coarse frames keyed on hour) and the renderer (which consumes
 * normalised full-resolution Float32 textures via the existing
 * 'weather-update' event).
 *
 * Per-tick pipeline
 * ─────────────────
 *   simTimeMs
 *     │
 *     ├─ if t is within liveBypassMs of wall clock
 *     │     → pass through WeatherFeed's live trio. Zero work.
 *     │
 *     └─ else
 *           history.bracket(t) → { before, after, frac }
 *              ├─ decode(before) via LRU  ─┐
 *              ├─ decode(after)  via LRU  ─┤  miss → feed._decodeCoarse
 *              └─ lerp(before, after, frac) → scratch trio
 *           dispatch 'weather-update' { weatherBuffer, windBuffer,
 *                                       cloudBuffer, meta:{replay:true} }
 *
 * Driver
 *   tick() is meant to be called from the same animate() loop that
 *   already drives Earth rotation, satellite positions, and the sun
 *   terminator (see earth.html:5479 and `satTracker.tick(simTimeMs)`
 *   at earth.html:5543). Once per rAF, never on a separate setInterval
 *   timer — that's what "subscribe rather than poll" means in this
 *   codebase: hook the existing render tick instead of standing up a
 *   parallel clock.
 *
 * Throttling
 *   Internal change-detection skips work when simulated time hasn't
 *   moved by `redrawThreshMs` (default 60 s) since the last dispatch.
 *   Drag of 1 px on a 1000-px-wide 24h slider already moves time by
 *   ~86 s, so this caps the redraw rate without impacting drag feel.
 *
 * LRU
 *   Map<hourKey, {weatherBuf, windBuf, cloudBuf}>, capped at lruSize
 *   (default 4 → ~12 MB RAM). Map preserves insertion order; on hit we
 *   delete-and-reinsert to bump recency. On miss past cap, evict the
 *   oldest key. The two bracketing frames during a normal drag are the
 *   common-case working set; 4 entries gives slack for back-and-forth
 *   scrubbing without re-decoding the same frames.
 *
 * Scratch buffers
 *   Three Float32Arrays of TEX_W·TEX_H·4, allocated once. Lerp writes
 *   in place every dispatch so a 60-Hz drag doesn't allocate three
 *   1-MB buffers per frame.
 *
 * Live frame is NOT cached
 *   When tick() resolves to "live now" we hand WeatherFeed's instance
 *   buffers to the dispatch directly — no copy, no LRU entry. The
 *   feed owns those buffers and overwrites them on every refresh; the
 *   downstream consumers (DataTexture .image.data.set, windParticles)
 *   make their own copy on receipt, so passing a reference is safe
 *   between frames.
 */

import { TEX_W, TEX_H } from './weather-feed.js';

const NTEX        = TEX_W * TEX_H;
const TEX_FLOATS  = NTEX * 4;
const DEFAULT_LRU_SIZE       = 4;
const DEFAULT_REDRAW_THRESH  = 60_000;            // 1 min
const DEFAULT_LIVE_BYPASS_MS = 30 * 60_000;       // 30 min — anything newer
                                                  // than this is "live"

// ── Tiny insertion-order LRU ────────────────────────────────────────────────
// Built on Map (which preserves insertion order). Keeps the resolver
// dependency-free and small enough to inline-audit.

class LRU {
    constructor(cap) {
        this._cap = cap;
        this._m   = new Map();
    }
    get size() { return this._m.size; }

    get(k) {
        if (!this._m.has(k)) return null;
        const v = this._m.get(k);
        // Bump recency: re-insert.
        this._m.delete(k);
        this._m.set(k, v);
        return v;
    }

    set(k, v) {
        if (this._m.has(k)) this._m.delete(k);
        if (this._m.size >= this._cap) {
            // Map.keys().next().value gives the oldest entry.
            const oldest = this._m.keys().next().value;
            this._m.delete(oldest);
        }
        this._m.set(k, v);
    }

    clear() { this._m.clear(); }
}

// ── WeatherFrameResolver ────────────────────────────────────────────────────

export class WeatherFrameResolver {
    /**
     * @param {object} opts
     * @param {import('./weather-feed.js').WeatherFeed}        opts.feed
     * @param {import('./weather-history.js').WeatherHistory}  opts.history
     * @param {number} [opts.lruSize=4]                — LRU capacity (frames)
     * @param {number} [opts.redrawThreshMs=60000]     — quantize window for tick()
     * @param {number} [opts.liveBypassMs=1800000]     — within this of now → live
     */
    constructor({
        feed,
        history,
        lruSize       = DEFAULT_LRU_SIZE,
        redrawThreshMs = DEFAULT_REDRAW_THRESH,
        liveBypassMs   = DEFAULT_LIVE_BYPASS_MS,
    } = {}) {
        if (!feed)    throw new Error('WeatherFrameResolver: feed is required');
        if (!history) throw new Error('WeatherFrameResolver: history is required');

        this._feed    = feed;
        this._history = history;
        this._lru     = new LRU(lruSize);
        this._redrawThreshMs = redrawThreshMs;
        this._liveBypassMs   = liveBypassMs;

        // Scratch buffers — one allocation per resolver, mutated in place
        // every dispatch. Sized to match earth.html's u_weather DataTexture
        // and the WindParticles input (TEX_W × TEX_H × 4 floats).
        this._weatherScratch = new Float32Array(TEX_FLOATS);
        this._windScratch    = new Float32Array(TEX_FLOATS);
        this._cloudScratch   = new Float32Array(TEX_FLOATS);

        // Change-detection state. -Infinity guarantees the first tick()
        // dispatches regardless of where simTimeMs lands.
        this._lastRenderT = -Infinity;
        this._lastWasLive = null;

        // Subscribe to weather-update events so the resolver knows when
        // the feed has fresh data; that lets us invalidate the
        // "_lastWasLive" memo so the next tick re-dispatches with the
        // new live frame.
        this._onFeedUpdate = this._onFeedUpdate.bind(this);
        document.addEventListener('weather-update', this._onFeedUpdate);

        // Free the LRU when the tab goes hidden — historical replay can
        // resume from disk on return; ~12 MB of decoded textures isn't
        // worth holding while backgrounded.
        this._onVisibility = this._onVisibility.bind(this);
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this._onVisibility);
        }
    }

    /**
     * Per-frame entry point. Cheap when nothing has visibly changed —
     * just an absolute-difference compare and an early return.
     *
     * Dispatch policy
     * ───────────────
     * Live mode: the feed's own 'weather-update' (fired every 15 min)
     *   is what drives the renderer. The resolver only emits a live
     *   dispatch on the **replay→live transition**, to flush the live
     *   buffers back onto the globe immediately when the user releases
     *   the slider (otherwise the renderer keeps painting the last
     *   replay frame until the next feed fetch, up to 15 min later).
     *
     * Replay mode: the resolver emits on every threshold-crossing
     *   tick, since the feed's dispatch is irrelevant to a past frame.
     *
     * @param {number} simTimeMs  — single source of truth from animate()
     */
    tick(simTimeMs) {
        // Future and past flow through the same path. Live bypass kicks
        // in only when simTimeMs is within liveBypassMs of wall clock
        // AND the user isn't explicitly forecast-scrubbing (forecast
        // beats live for any t > now + liveBypassMs because the user
        // dragged the slider there on purpose).
        const wallNow = Date.now();
        const tEff    = simTimeMs;
        const isLive  = Math.abs(wallNow - tEff) < this._liveBypassMs;

        const modeChanged = isLive !== this._lastWasLive;
        const movedEnough = Math.abs(tEff - this._lastRenderT) >= this._redrawThreshMs;

        if (!modeChanged && !movedEnough) return;

        if (isLive) {
            // Only flush live on the transition (or first tick). When
            // already parked at live, we leave the renderer alone — the
            // feed's own 15-min dispatch is the live update channel.
            if (this._lastWasLive !== true) this._dispatchLive();
        } else {
            this._dispatchReplay(tEff);
        }

        this._lastRenderT = tEff;
        this._lastWasLive = isLive;
    }

    /**
     * Force a re-dispatch on the next tick — useful when something
     * external invalidates the cached state (e.g. a fresh live fetch
     * landed and we want the renderer to see it even though simTimeMs
     * hasn't moved).
     */
    invalidate() {
        this._lastRenderT = -Infinity;
        this._lastWasLive = null;
    }

    /** Tear down: remove listeners, clear LRU. */
    stop() {
        document.removeEventListener('weather-update', this._onFeedUpdate);
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._onVisibility);
        }
        this._lru.clear();
    }

    // ── Internal ────────────────────────────────────────────────────────────

    _dispatchLive() {
        // Pass-through. Buffers are owned by the feed; we hand them to
        // the listener, which copies them into its DataTexture and the
        // WindParticles state. Safe across frames.
        document.dispatchEvent(new CustomEvent('weather-update', {
            detail: {
                weatherBuffer: this._feed.weatherBuffer,
                windBuffer:    this._feed.windBuffer,
                cloudBuffer:   this._feed.cloudBuffer,
                meta:          this._feed.meta,
                texW: TEX_W, texH: TEX_H,
                replay: false,
            },
        }));
    }

    _dispatchReplay(tEff) {
        const br = this._history.bracket(tEff);
        if (!br) {
            // Ring is empty — the very first session before any live
            // frame has landed. Fall back to whatever the feed currently
            // shows (procedural or sessionStorage snapshot) so the globe
            // doesn't go blank. After the first ingest the resolver will
            // pick up the normal replay path on the next tick.
            this._dispatchLive();
            return;
        }

        // Resolve bracketing frames into decoded full-res trios. The LRU
        // returns the same object reference for the same hourKey, so
        // back-and-forth drag through a frame doesn't re-decode it.
        const a = this._decodeCached(br.before ?? br.after);
        const b = br.after && br.before
            ? this._decodeCached(br.after)
            : a;                                  // clamp case → same frame
        const frac = (br.before && br.after) ? br.frac : 0;

        // Lerp into scratch. Special-case frac=0 / a===b so we skip the
        // multiply-add loop on every clamp tick.
        if (a === b || frac <= 0) {
            this._weatherScratch.set(a.weatherBuf);
            this._windScratch   .set(a.windBuf);
            this._cloudScratch  .set(a.cloudBuf);
        } else if (frac >= 1) {
            this._weatherScratch.set(b.weatherBuf);
            this._windScratch   .set(b.windBuf);
            this._cloudScratch  .set(b.cloudBuf);
        } else {
            this._lerpInto(this._weatherScratch, a.weatherBuf, b.weatherBuf, frac);
            this._lerpInto(this._windScratch,    a.windBuf,    b.windBuf,    frac);
            this._lerpInto(this._cloudScratch,   a.cloudBuf,   b.cloudBuf,   frac);
        }

        // Synthesise replay/forecast meta. The wx-panel listener at
        // earth.html:3389-3395 expects `meta.source`, `meta.fetchTime`,
        // `meta.demo`, `meta.loaded`, plus the grid metadata read from
        // _fetchGrid (gridW/H/Deg, cacheAgeSeconds, cacheFetchedAt).
        // We hand it a fully-formed meta so the panel renders correctly
        // for the instant the user is viewing — past or future.
        const baseFrame = br.before ?? br.after;
        const isForecast = !!baseFrame.isForecast;
        const dtSec   = Math.floor((tEff - Date.now()) / 1000);
        const absSec  = Math.abs(dtSec);
        const absMin  = Math.round(absSec / 60);
        const dtLabel = absMin < 60
            ? `${absMin}m`
            : `${(absMin / 60).toFixed(1)}h`;
        const sourceLabel = isForecast
            ? `forecast · in ${dtLabel}`
            : `replay · ${dtLabel} ago`;
        const provenance = baseFrame.source ? ` · ${baseFrame.source}` : '';
        const live = this._feed.meta;
        const meta = {
            // Inherit grid metadata + min/max stats from the feed. Stats
            // pertain to the live frame, not the replay/forecast frame,
            // so a future polish pass would compute these per-frame at
            // ingest time (cheap: ~2 ms on the coarse grid).
            ...live,
            source:    `${sourceLabel}${provenance}`,
            fetchTime: new Date(baseFrame.fetchedAt ?? baseFrame.t),
            demo:      false,
            loaded:    true,
            replay:    !isForecast,
            isForecast,
            replayT:   tEff,
            cacheAgeSeconds: Math.max(0, -dtSec),  // 0 for future frames
            cacheFetchedAt:  new Date(baseFrame.fetchedAt ?? baseFrame.t).toISOString(),
            gridW: baseFrame.gridW,
            gridH: baseFrame.gridH,
            gridDeg: 180 / baseFrame.gridH,
        };

        document.dispatchEvent(new CustomEvent('weather-update', {
            detail: {
                weatherBuffer: this._weatherScratch,
                windBuffer:    this._windScratch,
                cloudBuffer:   this._cloudScratch,
                meta,
                texW: TEX_W, texH: TEX_H,
                replay: true,
            },
        }));
    }

    /**
     * Decode a coarse history record into full-res trio, caching by
     * hour key. Misses pay one bilinear+blur+pack pass (~30-50 ms);
     * hits return the cached trio in O(1).
     */
    _decodeCached(record) {
        const cached = this._lru.get(record.t);
        if (cached) return cached;
        // Reuse the feed's _decodeCoarse — single source of truth for
        // the bilinear+blur+normalise+pack pipeline. Underscore here is
        // convention, not enforcement; the resolver and feed are
        // tightly coupled by design (mirrors how solar-weather-history's
        // seedSyntheticHistory writes directly into history._rings[1]).
        const trio = this._feed._decodeCoarse(record.coarse, record.gridW, record.gridH);
        this._lru.set(record.t, trio);
        return trio;
    }

    /**
     * Lerp two equal-length Float32Arrays into `out`:
     *   out[i] = a[i] * (1 - frac) + b[i] * frac
     *
     * ~1 ms for the trio (256k values × 3 buffers) on warm V8.
     */
    _lerpInto(out, a, b, frac) {
        const f1 = 1 - frac;
        for (let i = 0; i < out.length; i++) {
            out[i] = a[i] * f1 + b[i] * frac;
        }
    }

    // ── Listeners ───────────────────────────────────────────────────────────

    _onFeedUpdate(ev) {
        // Discriminator: resolver dispatches always carry a `replay`
        // field (true for historical, false for live transition); feed
        // dispatches never set it. So `replay !== undefined` means
        // "this is our own echo" — drop it to avoid a feedback loop.
        if (ev.detail?.replay !== undefined) return;
        // Real feed update just landed. Only react when we're in
        // replay mode — that's the case where the feed's dispatch just
        // clobbered our historical view with a live frame, and we need
        // the next tick to restore it. When at live, the feed already
        // updated the renderer correctly and a resolver re-dispatch
        // would be redundant.
        if (this._lastWasLive === false) {
            this.invalidate();
        }
    }

    _onVisibility() {
        if (document.hidden) {
            // Free decoded trios. They'll re-decode on demand when the
            // tab returns; coarse history stays in IDB throughout.
            this._lru.clear();
        }
    }
}

export default WeatherFrameResolver;
