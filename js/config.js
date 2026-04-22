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
    T1:  60  * 1000,          //  60 s  — wind, Kp-1m, X-ray (GOES ~1-min products)
    T2:   5  * 60 * 1000,     //   5 min — protons, electrons, aurora, alerts
    T3:  15  * 60 * 1000,     //  15 min — flares, regions, Dst (1-hr product), DONKI CME/notify
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
    xray_flux_min:   1e-4,   // X-class threshold (0.1–0.8 nm ≥ 10⁻⁴ W/m²) — checked live at T1
    sep_level_min:   3,      // S3+ solar radiation storm (>10 MeV protons ≥ 1000 pfu)
    earth_cme:       true,   // confirmed earth-directed CME
    calm_streak:     30,     // consecutive quiet readings before auto-revert
});

// ── FREE tier data limits ────────────────────────────────────────────────────
export const FREE_LIMITS = Object.freeze({
    flares_max:     3,       // most-recent flare events shown (full 7-day for PRO)
    series_points: 60,       // wind/xray history points (24-hr for PRO)
});

// ── NOAA SWPC direct URLs (browser fetches these directly — CORS enabled) ─────
// Server-side fetches are blocked by NOAA WAF (403 host_not_allowed); the
// browser must hit these endpoints directly.
export const NOAA = Object.freeze({
    wind:      'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json',
    kp1m:      'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',
    // 3-day Kp forecast in 3-hour bins. 2D-array payload:
    //   [[headers], [time_tag, kp, observed/estimated/predicted, noaa_scale], …]
    // Refreshed hourly by NOAA; we pull it at T3 cadence.
    kpForecast:'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
    xray:      'https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json',
    protons:   'https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json',
    electrons: 'https://services.swpc.noaa.gov/json/goes/primary/integral-electrons-1-day.json',
    aurora:    'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json',
    alerts:    'https://services.swpc.noaa.gov/products/alerts.json',
    dst:       'https://services.swpc.noaa.gov/products/kyoto-dst.json',
    flares:    null,  // NOAA retired xray-flares-7day.json — DONKI flares used instead
    regions:   'https://services.swpc.noaa.gov/json/solar_regions.json',
    radioFlux: 'https://services.swpc.noaa.gov/json/f107_cm_flux.json',
});

// ── Edge API paths (DONKI only — NASA API key must stay server-side) ──────────
export const API = Object.freeze({
    donkiCME:       '/api/donki/cme',
    donkiNotify:    '/api/donki/notifications',
    donkiFlares:    '/api/donki/flares',
    donkiGST:       '/api/donki/gst',
    donkiSEP:       '/api/donki/sep',
});

// ── NASA Earthdata ──────────────────────────────────────────────────────────
// GIBS (imagery browse) is public and CORS-enabled — no token needed.
// The Earthdata Bearer token is for raw science data via OPeNDAP / GES DISC
// (quantitative grids, not colour-mapped imagery).  Store in Vercel env var
// NASA_EARTHDATA_TOKEN; edge functions inject it server-side.
//
// Register / manage tokens: https://urs.earthdata.nasa.gov/
export const EARTHDATA = Object.freeze({
    gibsSnapshot: 'https://wvs.earthdata.nasa.gov/api/v1/snapshot',
    gibsWms:      'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi',
    gesDisc:      'https://disc.gsfc.nasa.gov',   // future: OPeNDAP numeric grids
});
