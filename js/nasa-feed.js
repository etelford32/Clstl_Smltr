/**
 * nasa-feed.js — NASA DONKI fetch-function module (thin wrapper)
 *
 * This module is intentionally NOT a standalone class with its own scheduler.
 * All DONKI calls are owned by SpaceWeatherFeed (swpc-feed.js) in the T3 tier,
 * which calls our /api/donki/* Vercel Edge Functions.
 *
 * The edge functions inject the NASA API key server-side from the NASA_API_KEY
 * Vercel environment variable — the key is NEVER exposed to the browser.
 *
 * WHAT THIS MODULE PROVIDES
 * ─────────────────────────────────────────────────────────────────────────────
 *  donkiState()   — returns a blank DONKI state object (used for type reference)
 *  NasaFeed       — legacy-compatible shim so existing callers don't break.
 *                   Internally delegates to SpaceWeatherFeed's T3 scheduler
 *                   rather than polling independently.
 *
 * HOW TO ADD NEW DONKI DATA STREAMS
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. Create api/donki/<type>.js following the pattern in api/donki/cme.js
 *  2. Add the route to API in js/config.js
 *  3. Write a fetchXxx(state) function below
 *  4. Add it to SpaceWeatherFeed._runT3() in swpc-feed.js
 *
 * OTHER NASA OPEN DATA SOURCES (for future edge routes)
 * ─────────────────────────────────────────────────────────────────────────────
 *  NASA SDO/HMI imagery:         https://sdo.gsfc.nasa.gov/assets/img/latest/
 *  NASA SOHO LASCO:              https://soho.nascom.nasa.gov/data/realtime/
 *  STEREO beacon wind:           https://stereo-ssc.nascom.nasa.gov/
 *  JPL Horizons (planets):       https://ssd.jpl.nasa.gov/api/horizons.api
 *  NEO Asteroid feed:            https://api.nasa.gov/neo/rest/v1/feed
 *  DONKI HSS (solar wind streams): https://api.nasa.gov/DONKI/HSS
 *  DONKI IPS (interplanetary shocks): https://api.nasa.gov/DONKI/IPS
 */

import { API } from './config.js';

// ── Blank DONKI state shape ───────────────────────────────────────────────────
export function donkiState() {
    return {
        flares:          [],
        cmes:            [],
        geomag_storms:   [],
        sep_events:      [],
        latest_cme:      null,
        latest_gst_kp:   null,
    };
}

// ── Internal helper ───────────────────────────────────────────────────────────
async function fetchEdge(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.json();
}

// ── Fetch functions (called by swpc-feed.js T3 scheduler) ────────────────────

/**
 * Fetch CME analysis from /api/donki/cme edge route.
 * Writes into the shared SpaceWeatherFeed state object.
 */
export async function fetchDONKICME(state) {
    const json = await fetchEdge(API.donkiCME);
    const list = json?.data?.cmes;
    if (!Array.isArray(list)) { state.recent_cmes = []; return; }

    const now    = Date.now();
    const parsed = list.map(c => {
        const t21_5      = c.time ? new Date(c.time) : null;
        const speed      = c.speed_km_s ?? 400;
        const etaMs      = t21_5 ? (1.345e8 / Math.max(speed, 50)) * 1e6 : null;
        const arrival    = etaMs ? new Date(t21_5.getTime() + etaMs) : null;
        const hoursUntil = arrival ? (arrival.getTime() - now) / 3.6e6 : null;
        return {
            time:          c.time            ?? null,
            speed:         speed,
            latitude:      c.latitude_deg    ?? 0,
            longitude:     c.longitude_deg   ?? 0,
            halfAngle:     c.half_angle_deg  ?? 30,
            type:          c.type            ?? 'S',
            earthDirected: c.earth_directed  ?? false,
            arrivalTime:   arrival?.toISOString() ?? null,
            hoursUntil,
            note:          c.note  ?? '',
            lat_rad:       (c.latitude_deg  ?? 0) * Math.PI / 180,
            lon_rad:       (c.longitude_deg ?? 0) * Math.PI / 180,
        };
    });

    state.recent_cmes        = parsed;
    const edList             = parsed.filter(c => c.earthDirected && (c.hoursUntil ?? 0) > -24);
    state.earth_directed_cme = edList[0] ?? null;
    state.cme_eta_hours      = state.earth_directed_cme?.hoursUntil ?? null;
}

/**
 * Fetch DONKI notifications from /api/donki/notifications edge route.
 */
export async function fetchDONKINotifications(state) {
    const json = await fetchEdge(API.donkiNotify);
    const list = json?.data?.notifications;
    if (!Array.isArray(list)) { state.donki_notifications = []; return; }
    state.donki_notifications = list.map(n => ({
        type: n.type,
        time: new Date(n.issue_time ?? 0),
        body: String(n.body ?? '').slice(0, 280),
        url:  n.url ?? null,
    })).slice(0, 12);
}

// ── NasaFeed shim — legacy compatibility ─────────────────────────────────────
// Callers that do `new NasaFeed({ apiKey }).start()` will still work.
// The shim emits 'nasa-update' events by forwarding 'swpc-update' data so
// existing listeners don't need to change until they're migrated.

export class NasaFeed {
    /**
     * @param {object} opts
     * @param {string} [opts.apiKey]  Ignored — key is now a Vercel env var.
     *                                Kept for call-site compatibility only.
     */
    constructor({ apiKey: _ignored } = {}) {
        this._handler = null;
    }

    /** Forwards 'swpc-update' → 'nasa-update' so legacy listeners still fire. */
    start() {
        this._handler = e => {
            const detail = e.detail ?? {};
            window.dispatchEvent(new CustomEvent('nasa-update', {
                detail: {
                    flares:         detail.recent_flares         ?? [],
                    cmes:           detail.recent_cmes           ?? [],
                    geomag_storms:  [],
                    sep_events:     [],
                    latest_cme:     detail.recent_cmes?.[0]     ?? null,
                    latest_gst_kp:  null,
                    notifications:  detail.donki_notifications  ?? [],
                    status:         detail.status,
                    lastUpdated:    detail.lastUpdated,
                },
            }));
        };
        window.addEventListener('swpc-update', this._handler);
        return this;
    }

    stop() {
        if (this._handler) {
            window.removeEventListener('swpc-update', this._handler);
            this._handler = null;
        }
    }

    refresh() {}  // no-op; refresh via SpaceWeatherFeed.refresh()
}

export default NasaFeed;
