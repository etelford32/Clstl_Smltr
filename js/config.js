/**
 * js/config.js — Single source of truth for API keys, poll intervals, and
 * feature-tier constants used across all feed modules and edge functions.
 *
 * ── NASA API Key ────────────────────────────────────────────────────────────
 *  Register a free key at https://api.nasa.gov/
 *  Replace 'DEMO_KEY' with your key below.
 *
 *  In production the key lives in a Vercel Environment Variable (NASA_API_KEY)
 *  and is injected server-side by the /api/donki/* edge functions — it is
 *  never sent to the browser.  NASA_KEY here is only used for local dev
 *  fallback when running against the edge functions on localhost.
 *
 * ── Plan tiers ──────────────────────────────────────────────────────────────
 *  TIER.FREE  — T1 (60s) + T2 (5min).  3 most-recent flare events.
 *  TIER.PRO   — All tiers including T3 (15min) + T4 (60min), full history,
 *               storm-mode acceleration, and on-demand series endpoints.
 */

// ── NASA API key (local dev only; replaced by env var in production) ─────────
export const NASA_KEY = 'DEMO_KEY';   // ← replace with your key for local dev

// ── Plan tier constants ───────────────────────────────────────────────────────
export const TIER = Object.freeze({
    FREE: 'free',
    PRO:  'pro',
});

// ── Base poll intervals (milliseconds) ───────────────────────────────────────
// These are the CALM-sun defaults.  Storm-mode escalation multiplies them down.
export const INTERVALS = Object.freeze({
    T1:  60  * 1000,          //  60 s  — wind, Kp-1m
    T2:   5  * 60 * 1000,     //   5 min — xray, protons, electrons, aurora, dst, alerts
    T3:  15  * 60 * 1000,     //  15 min — flares, regions, DONKI CME/notify
    T4:  60  * 60 * 1000,     //  60 min — F10.7, NEO, SOHO (PRO only)
    T2_OFFSET: 5  * 1000,     //   5 s  — T2 fires this many ms after T1 to stagger bursts
    T3_OFFSET: 10 * 1000,     //  10 s  — T3 fires this many ms after T1
});

// ── Storm-mode multipliers (applied to base intervals when active) ────────────
// e.g.  T1 storm = INTERVALS.T1 * STORM.FREE.T1  = 60s * (1/3) = 20s
export const STORM = Object.freeze({
    [TIER.FREE]: Object.freeze({ T1: 1 / 3, T2: 1 / 3, T3: 1 / 3 }),  // FREE: all tiers → 1/3 of base
    [TIER.PRO]:  Object.freeze({ T1: 1 / 6, T2: 1 / 6, T3: 1 / 5 }),  // PRO:  near-real-time
});

// ── Storm-mode trigger thresholds ────────────────────────────────────────────
export const STORM_TRIGGERS = Object.freeze({
    kp_min:          6,      // Kp ≥ 6 → G2+ geomagnetic storm
    xray_letter:    'X',     // X-class or stronger flare
    earth_cme:      true,    // confirmed earth-directed CME
    calm_streak:    30,      // consecutive quiet readings before auto-revert
});

// ── FREE tier data limits ────────────────────────────────────────────────────
export const FREE_LIMITS = Object.freeze({
    flares_max:     3,       // most-recent flare events shown (full 7-day for PRO)
    series_points: 60,       // wind/xray history points (24-hr for PRO)
});

// ── Edge API base paths (browser calls these, never NOAA/NASA directly) ──────
export const API = Object.freeze({
    wind:           '/api/solar-wind/wind-speed',
    kp1m:           '/api/noaa/kp-1m',
    xray:           '/api/noaa/xray',
    protons:        '/api/noaa/protons',
    electrons:      '/api/noaa/electrons',
    aurora:         '/api/noaa/aurora',
    alerts:         '/api/noaa/alerts',
    dst:            '/api/noaa/dst',
    flares:         '/api/noaa/flares',
    regions:        '/api/noaa/regions',
    radioFlux:      '/api/noaa/radio-flux',
    donkiCME:       '/api/donki/cme',
    donkiNotify:    '/api/donki/notifications',
    donkiFlares:    '/api/donki/flares',
    donkiGST:       '/api/donki/gst',
    donkiSEP:       '/api/donki/sep',
});
