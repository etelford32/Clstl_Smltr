/**
 * nasa-feed.js — NASA Space Weather Database Of Notifications, Knowledge,
 *                Information (DONKI) real-time data pipeline
 *
 * Polls four public NASA DONKI REST endpoints and dispatches a 'nasa-update'
 * CustomEvent on window each time new data arrives.
 *
 * ENDPOINTS (all public, CORS-enabled; free API key required — see below)
 * ─────────────────────────────────────────────────────────────────────────
 *  FLR   — Solar Flare events (NASA catalogued, with CME links)
 *  CME   — Coronal Mass Ejections (speed, half-angle, direction)
 *  GST   — Geomagnetic Storm events (Kp onset/recovery times)
 *  SEP   — Solar Energetic Particle events (onset, instruments)
 *
 * API KEY
 * ─────────────────────────────────────────────────────────────────────────
 *  NASA DONKI requires a free API key from https://api.nasa.gov/.
 *  Registration is instant — enter your email and you get a key immediately.
 *  While developing you can use 'DEMO_KEY' (30 req/hr, 50 req/day limit).
 *  Pass your key in the constructor: new NasaFeed({ apiKey: 'YOUR_KEY' })
 *
 * HOW TO ADD MORE NASA DATA STREAMS
 * ─────────────────────────────────────────────────────────────────────────
 *  1. Browse available DONKI types at: https://api.nasa.gov/DONKI/
 *     Types: FLR, CME, CMEAnalysis, GST, IPS, MPC, RBE, HSS, notifications
 *  2. Add a new key to ENDPOINTS below with the correct path.
 *  3. Write a small async fetchXxx(state, url) function (see examples below).
 *  4. Add it to the tasks[] array in _poll().
 *  5. Surface the new field in _buildState() and dispatch it in the event.
 *
 *  Other NASA open data sources you can add the same way:
 *  • NASA SDO/HMI imagery:  https://sdo.gsfc.nasa.gov/assets/img/latest/
 *  • NASA SOHO LASCO:       https://soho.nascom.nasa.gov/data/realtime/
 *  • NASA Eyes on the Heliosphere: https://eyes.nasa.gov/
 *  • STEREO beacon wind:    https://stereo-ssc.nascom.nasa.gov/
 *  • JPL Horizons (planets): https://ssd.jpl.nasa.gov/api/horizons.api
 *  • NEO Asteroid feed:      https://api.nasa.gov/neo/rest/v1/feed
 *
 * STATE OBJECT  (event.detail)
 * ─────────────────────────────────────────────────────────────────────────
 *  flares          [{ beginTime, classType, sourceLocation, linkedCMEs }]
 *  cmes            [{ startTime, speed, halfAngle, type, note }]
 *  geomag_storms   [{ startTime, allKpIndex }]
 *  sep_events      [{ eventTime, instruments, linkedEvents }]
 *  latest_cme      { startTime, speed, halfAngle, type } | null
 *  latest_gst_kp   number | null  — peak Kp of most recent geomagnetic storm
 *  status          'live' | 'stale' | 'offline' | 'connecting'
 *  lastUpdated     Date
 *
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────
 *  import { NasaFeed } from './js/nasa-feed.js';
 *  const feed = new NasaFeed({ apiKey: 'YOUR_KEY' });   // or 'DEMO_KEY'
 *  window.addEventListener('nasa-update', e => console.log(e.detail));
 *  feed.start();
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Return ISO date string N days before today (YYYY-MM-DD). */
function daysAgo(n) {
    const d = new Date(Date.now() - n * 86400e3);
    return d.toISOString().slice(0, 10);
}

async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return res.json();
}

// ── Endpoint builder ──────────────────────────────────────────────────────────

function buildEndpoints(apiKey, lookbackDays = 7) {
    const start = daysAgo(lookbackDays);
    const today = daysAgo(0);
    const base  = 'https://api.nasa.gov/DONKI';
    const q     = `startDate=${start}&endDate=${today}&api_key=${apiKey}`;
    return {
        /** Solar Flare events (NASA DONKI) */
        flares: `${base}/FLR?${q}`,
        /** Coronal Mass Ejection events */
        cmes:   `${base}/CME?${q}`,
        /** Geomagnetic Storm events */
        gst:    `${base}/GST?${q}`,
        /** Solar Energetic Particle events */
        sep:    `${base}/SEP?${q}`,
    };
}

// ── Individual fetchers ───────────────────────────────────────────────────────

/**
 * NASA DONKI Solar Flare catalogue.
 * Fields: flrID, beginTime, peakTime, endTime, classType, sourceLocation,
 *         activeRegionNum, linkedEvents (CME associations).
 */
async function fetchFlares(state, url) {
    const data = await fetchJSON(url);
    if (!Array.isArray(data)) { state.flares = []; return; }
    state.flares = data
        .filter(f => f.beginTime && f.classType)
        .map(f => ({
            flrID:          f.flrID ?? null,
            beginTime:      new Date(f.beginTime),
            peakTime:       f.peakTime   ? new Date(f.peakTime)  : null,
            endTime:        f.endTime    ? new Date(f.endTime)   : null,
            classType:      f.classType,
            sourceLocation: f.sourceLocation ?? null,
            activeRegion:   f.activeRegionNum ?? null,
            // IDs of associated CMEs (if any)
            linkedCMEs:     (f.linkedEvents ?? [])
                                .filter(e => e.activityID?.includes('CME'))
                                .map(e => e.activityID),
        }))
        .sort((a, b) => b.beginTime - a.beginTime)
        .slice(0, 20);
}

/**
 * NASA DONKI CME catalogue.
 * Key sub-array: cmeAnalyses — pick fastest analysis per event.
 */
async function fetchCMEs(state, url) {
    const data = await fetchJSON(url);
    if (!Array.isArray(data)) { state.cmes = []; return; }
    state.cmes = data
        .filter(c => c.startTime)
        .map(c => {
            // Pick the analysis with highest speed
            const analyses = c.cmeAnalyses ?? [];
            const best = analyses.length
                ? analyses.reduce((a, b) => ((b.speed ?? 0) > (a.speed ?? 0) ? b : a))
                : null;
            return {
                cmeID:     c.activityID ?? null,
                startTime: new Date(c.startTime),
                speed:     best?.speed     ?? null,   // km/s
                halfAngle: best?.halfAngle ?? null,   // degrees
                type:      best?.type      ?? null,   // 'C'=cone, 'S'=spherical
                note:      c.note          ?? null,
            };
        })
        .sort((a, b) => b.startTime - a.startTime)
        .slice(0, 15);

    state.latest_cme = state.cmes[0] ?? null;
}

/**
 * NASA DONKI Geomagnetic Storm events.
 * allKpIndex is an array of [{observedTime, kpIndex, source}] over the storm.
 */
async function fetchGST(state, url) {
    const data = await fetchJSON(url);
    if (!Array.isArray(data)) { state.geomag_storms = []; return; }
    state.geomag_storms = data
        .filter(g => g.startTime)
        .map(g => {
            const kpArr = g.allKpIndex ?? [];
            const peakKp = kpArr.reduce((mx, r) => Math.max(mx, parseFloat(r.kpIndex ?? 0)), 0);
            return {
                gstID:     g.gstID ?? null,
                startTime: new Date(g.startTime),
                peakKp,
                allKpIndex: kpArr.map(r => ({
                    time:   new Date(r.observedTime),
                    kp:     parseFloat(r.kpIndex ?? 0),
                    source: r.source ?? null,
                })),
            };
        })
        .sort((a, b) => b.startTime - a.startTime)
        .slice(0, 5);

    state.latest_gst_kp = state.geomag_storms[0]?.peakKp ?? null;
}

/**
 * NASA DONKI Solar Energetic Particle events.
 */
async function fetchSEP(state, url) {
    const data = await fetchJSON(url);
    if (!Array.isArray(data)) { state.sep_events = []; return; }
    state.sep_events = data
        .filter(s => s.eventTime)
        .map(s => ({
            sepID:        s.sepID        ?? null,
            eventTime:    new Date(s.eventTime),
            instruments:  (s.instruments ?? []).map(i => i.displayName ?? i),
            linkedEvents: (s.linkedEvents ?? []).map(e => e.activityID),
        }))
        .sort((a, b) => b.eventTime - a.eventTime)
        .slice(0, 10);
}

// ── NasaFeed class ────────────────────────────────────────────────────────────

export class NasaFeed {
    /**
     * @param {object} opts
     * @param {string} opts.apiKey       NASA API key (default: 'DEMO_KEY')
     * @param {number} opts.lookbackDays Days of history to request (default: 7)
     * @param {number} opts.pollInterval Milliseconds between polls (default: 15 min)
     *
     * TIP: Register a free key at https://api.nasa.gov/ to raise rate limits.
     *      DEMO_KEY allows 30 requests/hour and 50 requests/day.
     *      Each poll makes 4 requests, so DEMO_KEY supports ~7 polls/hour.
     */
    constructor({
        apiKey       = 'DEMO_KEY',
        lookbackDays = 7,
        pollInterval = 15 * 60 * 1000,
    } = {}) {
        this.apiKey       = apiKey;
        this.lookbackDays = lookbackDays;
        this.pollInterval = pollInterval;
        this._timer       = null;
        this.status       = 'connecting';
        this.lastUpdated  = null;
        this.failStreak   = 0;
        this._raw = {
            flares:        [],
            cmes:          [],
            geomag_storms: [],
            sep_events:    [],
            latest_cme:    null,
            latest_gst_kp: null,
        };
    }

    /** Start polling. Returns `this` for chaining. */
    start() {
        this._poll();
        this._timer = setInterval(() => this._poll(), this.pollInterval);
        return this;
    }

    /** Stop polling. */
    stop() {
        clearInterval(this._timer);
        this._timer = null;
    }

    /** Trigger an immediate out-of-band refresh. */
    refresh() { return this._poll(); }

    /** Current state snapshot without triggering a fetch. */
    get state() { return this._buildState(); }

    async _poll() {
        const ep = buildEndpoints(this.apiKey, this.lookbackDays);
        const tasks = [
            fetchFlares(this._raw, ep.flares),
            fetchCMEs(this._raw,   ep.cmes),
            fetchGST(this._raw,    ep.gst),
            fetchSEP(this._raw,    ep.sep),
        ];
        const results = await Promise.allSettled(tasks);
        const ok  = results.some(r => r.status === 'fulfilled');
        const all = results.every(r => r.status === 'rejected');

        if (ok) {
            this.status      = 'live';
            this.lastUpdated = new Date();
            this.failStreak  = 0;
        } else if (all) {
            this.failStreak++;
            this.status = this.failStreak > 2 ? 'offline' : 'stale';
        }

        results.forEach((r, i) => {
            if (r.status === 'rejected')
                console.debug(`[NASA] ${Object.keys(ep)[i]}: ${r.reason?.message ?? r.reason}`);
        });

        window.dispatchEvent(new CustomEvent('nasa-update', { detail: this._buildState() }));
    }

    _buildState() {
        const raw = this._raw;
        return {
            flares:        raw.flares,
            cmes:          raw.cmes,
            geomag_storms: raw.geomag_storms,
            sep_events:    raw.sep_events,
            latest_cme:    raw.latest_cme,
            latest_gst_kp: raw.latest_gst_kp,
            status:        this.status,
            lastUpdated:   this.lastUpdated,
        };
    }
}

export default NasaFeed;

/* ── QUICK-START EXAMPLE ─────────────────────────────────────────────────────
 *
 *  import { NasaFeed }         from './js/nasa-feed.js';
 *  import { SpaceWeatherFeed } from './js/swpc-feed.js';
 *
 *  // NOAA — free, no key, 5-minute poll
 *  const noaa = new SpaceWeatherFeed().start();
 *
 *  // NASA DONKI — free key from api.nasa.gov, 15-minute poll
 *  const nasa = new NasaFeed({ apiKey: 'YOUR_KEY_HERE' }).start();
 *
 *  window.addEventListener('swpc-update', e => {
 *      const { solar_wind, kp, xray_class, aurora_activity,
 *              sep_storm_level, active_alerts } = e.detail;
 *      // → drive shaders / UI with live NOAA data
 *  });
 *
 *  window.addEventListener('nasa-update', e => {
 *      const { latest_cme, cmes, flares, geomag_storms } = e.detail;
 *      if (latest_cme && latest_cme.speed > 1500) triggerCMEAnimation(latest_cme);
 *  });
 *
 * ──────────────────────────────────────────────────────────────────────────── */
