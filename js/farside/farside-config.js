/**
 * js/farside/farside-config.js — constants for the Far-Side Watch layer.
 *
 * Single source of truth for the grid geometry, detection thresholds, data
 * sources, and the ground-truth validation cases. Kept separate from the
 * site-wide js/config.js so the whole far-side package stays self-contained
 * and importable by other engines (Sun, Space Weather) without dragging in
 * the feed-polling machinery.
 */

/**
 * Far-side data sources, in the honest priority order:
 *   - GONG seismic holography is ALWAYS available (12-hourly, free, also fed
 *     to NOAA SWPC). It is the backbone.
 *   - Solar Orbiter / STEREO-A EUV imaging is direct (not inference) but only
 *     when the spacecraft geometry gives a far-side view — opportunistic.
 *   - HMI/JSOC seismic is an alternate pipeline to cross-check GONG against.
 *
 * `endpoint` is the in-app edge proxy (keeps upstream rate limits + CORS off
 * the browser). The proxy resolves the real upstream, overridable per source
 * via Vercel env vars — see api/solar/farside.js.
 */
export const SOURCES = Object.freeze({
    gong: {
        id: 'gong',
        label: 'GONG far-side',
        kind: 'seismic',
        endpoint: '/api/solar/farside?source=gong',
        cadenceHours: 12,
        always: true,
        note: 'NSO/NISP seismic holography — the backbone feed.',
    },
    solo: {
        id: 'solo',
        label: 'Solar Orbiter EUV',
        kind: 'imaging',
        endpoint: '/api/solar/farside?source=solo',
        cadenceHours: null,        // opportunistic — depends on orbit geometry
        always: false,
        note: 'ESA Solar Orbiter Archive — direct imaging when geometry cooperates.',
    },
    stereo: {
        id: 'stereo',
        label: 'STEREO-A EUVI',
        kind: 'imaging',
        endpoint: '/api/solar/farside?source=stereo',
        cadenceHours: null,
        always: false,
        note: 'SECCHI/EUVI — angle-dependent direct imaging.',
    },
    hmi: {
        id: 'hmi',
        label: 'HMI/JSOC seismic',
        kind: 'seismic',
        endpoint: '/api/solar/farside?source=hmi',
        cadenceHours: 12,
        always: false,
        note: 'Alternate seismic pipeline — cross-check against GONG.',
    },
});

/** Carrington map grid: 1° longitude × 1° latitude. */
export const GRID = Object.freeze({
    nLon: 360,
    nLat: 180,        // -90 .. +90
    lonStep: 1,
    latStep: 1,
    latMin: -90,
});

/**
 * Detection thresholds for the classical (pre-ML) blob detector.
 * Far-side magnetic regions show up as NEGATIVE phase-shift signatures
 * (faster sound speed → earlier wave arrival). Values are normalized to the
 * map's own units in farside-feed; thresholds are in those normalized σ.
 */
export const DETECT = Object.freeze({
    sigma: 2.2,        // |z| threshold below background to flag a pixel
    minAreaDeg2: 12,   // reject specks smaller than this (deg²)
    maxLatDeg: 60,     // active-region belt — ignore polar artifacts
    mergeGapDeg: 6,    // merge blobs whose centroids fall within this gap
    strongStrength: 1.6, // integrated-strength cut for a "strong" callout
});

/** Alert trigger: warn when a tracked region is within this lead window. */
export const ALERT = Object.freeze({
    leadDaysMax: 5,        // "rotating into view" fires inside this horizon
    minStrengthForAlert: 1.2,
    notifyKey: 'notify_region_emergence', // future user_profiles toggle (Phase 4+)
});

/**
 * Ground-truth validation cases (Phase 5 moat). These are the demos that sell
 * an operator: did we flag the region on the far side before it crossed the
 * limb? Carrington longitudes are approximate emergence-time values; refine
 * against the NOAA SWPC solar-region record when the backtest harness lands.
 */
export const VALIDATION_CASES = Object.freeze([
    {
        id: 'ar13664',
        label: 'AR13664 — Gannon G5 (May 2024)',
        noaaRegion: 13664,
        eastLimbCrossingUTC: '2024-05-02T00:00:00Z',
        carringtonLon: 270,    // approx Carrington longitude at emergence
        carringtonLat: 17,
        flareProductive: true,
        note: 'Produced the X-class flares + CMEs that drove the May 2024 superstorm.',
    },
    {
        id: 'farside-2026-05',
        label: 'Late-May 2026 far-side region',
        noaaRegion: null,
        eastLimbCrossingUTC: '2026-05-28T00:00:00Z',
        carringtonLon: 132,
        carringtonLat: -12,
        flareProductive: null,
        note: 'Recent far-side signature — live validation target.',
    },
]);

/** How many successive maps to retain for tracking + trend. */
export const SERIES_LEN = 6; // 6 × 12 h ≈ 3 days of history

/**
 * Phase-5 backtest harness settings. The validation story is the moat: a
 * MEASURED warning horizon (detection rate, median lead time, false-alarm rate)
 * over historical maps vs. the NOAA emergence record. These tune the matching
 * and the demo's synthetic-history window.
 */
export const BACKTEST = Object.freeze({
    // A detected track matches a ground-truth region when its PREDICTED east-limb
    // emergence lands within matchDays of the real crossing and its latitude is
    // within matchLatDeg. Date-based matching is the physically meaningful test
    // ("did we forecast an emergence when one really happened") and is robust to
    // longitude bookkeeping drift between the truth record and the detector.
    matchDays: 4,
    matchLatDeg: 18,
    matchLonDeg: 25,        // fallback spatial gate (used only if a track lacks a date)
    windowDays: 16,         // synthetic history span before each truth crossing
    cadenceHours: 12,       // GONG cadence
    // Far-side seismic sensitivity vs central-meridian distance: best near the
    // antipode (|cmd|≈180), degrades toward the far-side limbs (|cmd|≈90).
    detectBaseProb: 0.82,
    minAlertStrength: 1.2,  // a false track must clear this to count as a false alarm
});
