/**
 * flux-rope-live.js — Phase 3 live inputs for the Flux Rope Simulator.
 *
 * Two feeds, both already used elsewhere in the platform:
 *   1. NASA DONKI CMEAnalysis via the site's edge proxy /api/donki/cme
 *      (NASA key stays server-side). DONKI's `time21_5` is the moment the
 *      CME front crosses 21.5 R☉ — EXACTLY the kernel's launch surface
 *      (d0Rsun = 21.5), and its `speed` is measured there, so a DONKI
 *      analysis seeds the engine with no unit gymnastics: launch epoch =
 *      time21_5, v0 = speed. Direction lat/lon are Stonyhurst (Earth at
 *      0°,0°), matching the kernel frame.
 *   2. SWPC real-time L1 (DSCOVR/ACE): rtsw_mag_1m.json (bx/by/bz GSM) +
 *      rtsw_wind_1m.json (plasma; PLASMA-ONLY — see js/swpc-feed.js) —
 *      browser-direct (CORS-enabled), merged by time_tag into the universal
 *      SolarWindDriver contract with source 'observed'.
 *
 * Everything network-facing is a thin wrapper over PURE parsers/seeders so
 * tests/flux-rope-live.mjs gates the logic with fixtures, no network.
 * What a DONKI cone fit does NOT give us — B₁AU, twist, tilt, chirality —
 * is seeded from climatological defaults with WIDE priors (chirality flip
 * 0.5 = "unknown"), which is the honest starting posterior the
 * assimilation loop then narrows.
 */

import { SolarWindDriver } from './solar-wind-driver.js';
import { ROPE_DEFAULTS } from './flux-rope-kernel.js';

/** Normalize the /api/donki/cme payload into event-picker entries. */
export function parseDonkiCmes(payload) {
    const cmes = payload?.data?.cmes;
    if (!Array.isArray(cmes)) return [];
    return cmes
        .filter((c) => c?.time && Number.isFinite(c.speed_km_s))
        .map((c) => ({
            id: `donki-${c.time}`,
            cmeId: c.cme_id ?? null,
            timeIso: c.time,               // time21_5 — the launch epoch
            speedKms: c.speed_km_s,
            latDeg: Number.isFinite(c.latitude_deg) ? c.latitude_deg : 0,
            lonDeg: Number.isFinite(c.longitude_deg) ? c.longitude_deg : 0,
            halfAngleDeg: Number.isFinite(c.half_angle_deg) ? c.half_angle_deg : 30,
            earthDirected: c.earth_directed === true,
            mostAccurate: c.most_accurate === true,
            note: c.note || '',
        }))
        .sort((a, b) => Date.parse(b.timeIso) - Date.parse(a.timeIso));
}

/**
 * Seed a rope + prior spreads from one DONKI analysis (spec §12).
 * Cone fits constrain WHEN/WHERE/HOW FAST — not the magnetic configuration,
 * so the magnetic parameters get climatology defaults and deliberately wide
 * spreads (p_flip 0.5 = chirality unknown). `ambientWKms` from live L1 when
 * available.
 */
export function donkiToPreset(cme, { ambientWKms = 400 } = {}) {
    const sigma = Math.min(0.2, Math.max(0.06, 0.115 * cme.halfAngleDeg / 30));
    return {
        id: cme.id,
        label: `DONKI ${cme.timeIso.slice(0, 16).replace('T', ' ')}Z · ${Math.round(cme.speedKms)} km/s${cme.earthDirected ? ' · Earth-directed' : ''}`,
        launchIso: cme.timeIso,
        bundleUrl: null,
        live: true,
        rope: {
            ...ROPE_DEFAULTS,
            lonDeg: cme.lonDeg,
            latDeg: cme.latDeg,
            v0Kms: cme.speedKms,
            sigma1AuAu: sigma,
            wKms: ambientWKms,
            // Live forecasts run the full v1.1 forward model: sheath ON
            // (spec §14) with climatological ambient variability.
            sheathDeltaNt: 2.5,
            launchOffsetS: 0,
        },
        spreads: {
            sigLonDeg: Math.max(8, cme.halfAngleDeg * 0.4),
            sigLatDeg: Math.max(6, cme.halfAngleDeg * 0.3),
            sigTiltDeg: 40,      // unconstrained by a cone fit
            sigV0Kms: Math.max(100, cme.speedKms * 0.15),
            lnsigB: 0.4,
            lnsigSigma: 0.25,
            lnsigGamma: 0.5,
            sigTwist: 1.5,
            pFlip: 0.5,          // chirality genuinely unknown pre-arrival
        },
    };
}

// ── Compounding trains (spec §12 — train-seeding conventions) ────────────────

const AU_KM = 1.495978707e8;

/** Headline lookback: "the most recent 24 hours of flux ropes". */
export const TRAIN_WINDOW_H = 24;
/** In-transit relevance horizon (matches the 7-day DONKI catalog window). */
export const TRAIN_TRANSIT_LOOKBACK_H = 168;
/** Rope-passage allowance beyond the ballistic arrival before a CME is
 *  considered PAST L1 and dropped from the live train. */
export const TRAIN_DWELL_MARGIN_H = 30;

/**
 * Angular-relevance test: can this CME plausibly touch Earth? Strictly
 * Earth-directed (the proxy's cone test: angular distance ≤ halfAngle), OR
 * within `marginDeg` of the cone edge — glancing candidates whose ensemble
 * lon/lat spread honestly covers the hit question, and which can §16-couple
 * to an Earth-directed partner (alignment cos > 0.5 reaches ~60°).
 */
export function earthRelevant(cme, marginDeg = 20) {
    if (cme.earthDirected === true) return true;
    const dist = Math.hypot(cme.latDeg ?? 0, cme.lonDeg ?? 0);
    return dist <= (cme.halfAngleDeg ?? 30) + marginDeg;
}

/**
 * Ballistic 1 AU arrival estimate [ms] — a RELEVANCE FILTER only (the
 * engine's DBM owns real kinematics): launch + AU / cone speed.
 */
export function ballisticArrivalMs(cme) {
    const v = Math.max(200, cme.speedKms || 400);
    return Date.parse(cme.timeIso) + (AU_KM / v) * 1000;
}

/**
 * Select the CMEs forming the CURRENT compounding train (pure,
 * fixture-gated). Membership: Earth-relevant AND (launched within the last
 * `windowH` OR still plausibly at/inside 1 AU — ballistic arrival +
 * `dwellMarginH` not yet past). A train needs at least one strictly
 * Earth-directed ANCHOR — glancing partners alone return [] (idle), and a
 * storm that fully passed returns [] rather than "forecasting" the past.
 * Over `maxRopes`, the oldest NON-anchor drops first, then the oldest
 * anchor. Result is launch-ascending — index 0 is the train epoch.
 */
export function selectTrainCmes(cmes, {
    nowMs = Date.now(),
    windowH = TRAIN_WINDOW_H,
    maxRopes = 6,
    marginDeg = 20,
    transitLookbackH = TRAIN_TRANSIT_LOOKBACK_H,
    dwellMarginH = TRAIN_DWELL_MARGIN_H,
} = {}) {
    const keep = (Array.isArray(cmes) ? cmes : []).filter((c) => {
        if (!c?.timeIso || !earthRelevant(c, marginDeg)) return false;
        const launch = Date.parse(c.timeIso);
        if (!Number.isFinite(launch) || launch > nowMs) return false;
        const ageH = (nowMs - launch) / 3600e3;
        if (ageH > transitLookbackH) return false;
        return ageH <= windowH
            || ballisticArrivalMs(c) + dwellMarginH * 3600e3 >= nowMs;
    });
    if (!keep.some((c) => c.earthDirected === true)) return [];
    keep.sort((a, b) => Date.parse(a.timeIso) - Date.parse(b.timeIso));
    while (keep.length > maxRopes) {
        const i = keep.findIndex((c) => c.earthDirected !== true);
        keep.splice(i >= 0 ? i : 0, 1);
    }
    return keep;
}

/**
 * Seed ONE compounding-train preset from several DONKI analyses (spec §12
 * train conventions). Epoch = the EARLIEST launch — rope 0 is the reference
 * every consumer probes (kernel apexKmAt(0, …), the Stage's rope actor);
 * later launches carry `launchOffsetS`. §16 interaction is ON (engine
 * defaults): wake kinematics, dynamic rear compression, wake-conditioned
 * follower sheaths — the compounding forward model. The ensemble spreads
 * are the per-CME priors merged by MAX: the kernel samples ONE spread set
 * across all ropes, and the honest merge of unequal priors is the widest.
 */
export function donkiToTrainPreset(cmes, { ambientWKms = 400 } = {}) {
    if (!cmes?.length) return null;
    const order = cmes
        .map((c) => ({ c, p: donkiToPreset(c, { ambientWKms }), t: Date.parse(c.timeIso) }))
        .sort((a, b) => a.t - b.t);
    const epochMs = order[0].t;
    const ropes = order.map(({ p, t }) => ({ ...p.rope, launchOffsetS: (t - epochMs) / 1000 }));
    const spreads = {};
    for (const { p } of order) {
        for (const [k, v] of Object.entries(p.spreads)) {
            spreads[k] = Math.max(spreads[k] ?? 0, v);
        }
    }
    const newest = order[order.length - 1];
    const n = order.length;
    return {
        id: `donki-train-${order[0].p.launchIso}x${n}`,
        label: n > 1
            ? `Live · compounding train · ${n} CMEs (latest ${newest.p.launchIso.slice(5, 16).replace('T', ' ')}Z)`
            : `Live · ${newest.p.launchIso.slice(5, 16).replace('T', ' ')}Z · ${Math.round(newest.c.speedKms)} km/s`,
        launchIso: order[0].p.launchIso,
        live: true,
        train: true,
        cmes: order.map((o) => o.c),
        rope: ropes[0],
        ropes,
        spreads,
        interaction: { enabled: true },
    };
}

/** NOAA fill values → NaN. */
function noaaFill(v) {
    const x = typeof v === 'string' ? parseFloat(v) : v;
    return Number.isFinite(x) && x > -9990 ? x : NaN;
}

/**
 * Merge RTSW mag + wind product arrays into SolarWindDriver samples
 * (by time_tag minute; either side may be missing — honest NaN channels).
 */
export function parseRtsw(magRows, windRows) {
    const byT = new Map();
    const at = (iso) => {
        const t = Date.parse(iso.endsWith('Z') ? iso : iso + 'Z');
        if (!byT.has(t)) byT.set(t, { t, n: NaN, v: NaN, bx: NaN, by: NaN, bz: NaN });
        return byT.get(t);
    };
    for (const r of Array.isArray(magRows) ? magRows : []) {
        if (!r?.time_tag) continue;
        const s = at(r.time_tag);
        s.bx = noaaFill(r.bx_gsm) ?? NaN;
        s.by = noaaFill(r.by_gsm) ?? NaN;
        s.bz = noaaFill(r.bz_gsm ?? r.bz ?? r.bz_gse);
    }
    for (const r of Array.isArray(windRows) ? windRows : []) {
        if (!r?.time_tag) continue;
        const s = at(r.time_tag);
        s.v = noaaFill(r.proton_speed ?? r.speed);
        s.n = noaaFill(r.proton_density ?? r.density);
    }
    return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** Build the 'observed' L1 driver from parsed RTSW samples. */
export function rtswDriver(magRows, windRows) {
    return new SolarWindDriver(parseRtsw(magRows, windRows), {
        source: 'observed', frame: 'gsm', label: 'DSCOVR/ACE RTSW',
    });
}

// ── STEREO-A (spec §13) ──────────────────────────────────────────────────────

/**
 * Approximate STEREO-A heliocentric position (HEE-like frame, Earth at
 * lon 0). Anchored at the 2023-08-12 Earth conjunction and drifting AHEAD
 * of Earth at the mean synodic rate (sidereal period 346 d →
 * ≈ +0.0549°/day = +20.0°/yr in our +lon = orbital-motion-direction
 * convention); r ≈ 0.96 AU, lat ≈ 0. Good to roughly ±3° / ±0.01 AU over
 * 2023–2028 — adequate for flank-hit geometry priors (the page DISPLAYS
 * the assumed position and lets the user edit it; σ_obs absorbs the rest).
 * Sanity anchor: Gannon epoch (2024-05-10) → ≈ +15°, matching the ~13°
 * "west of the Sun–Earth line" in the event literature within tolerance.
 */
export function staPositionApprox(dateMs) {
    const CONJUNCTION_MS = Date.UTC(2023, 7, 12);
    const DRIFT_DEG_PER_DAY = 0.0549;
    const lon = (dateMs - CONJUNCTION_MS) / 86_400_000 * DRIFT_DEG_PER_DAY;
    return { rAu: 0.96, lonDeg: Math.round(lon * 10) / 10, latDeg: 0, approx: true };
}

/** Build the 'observed' STEREO-A beacon driver from parsed mag rows. */
export function stereoBeaconDriver(magRows) {
    return new SolarWindDriver(parseRtsw(magRows, []), {
        source: 'observed', frame: 'gsm', label: 'STEREO-A beacon',
    });
}

// ── Network wrappers (browser only; parsers above carry the logic) ───────────

const RTSW_MAG_URL = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json';
const RTSW_WIND_URL = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json';

// STEREO-A beacon magnetometer candidates. NOTE: could not be live-verified
// from the dev sandbox (outbound proxy blocks SWPC) — the parser is
// fixture-gated and field-variant tolerant, and the fetcher fails QUIET, so
// a moved/renamed product degrades to "no STA data", never a broken page.
// If NOAA relocates the product, fix the list here (see the retired
// products/solar-wind saga in api/cron/refresh-solar-wind.js).
const STA_MAG_URLS = [
    'https://services.swpc.noaa.gov/json/stereo/stereo_a_1m.json',
    'https://services.swpc.noaa.gov/json/stereo/stereo_a_mag_1m.json',
];

/** Fetch the live STEREO-A beacon driver; null when unavailable. */
export async function fetchStereoBeaconDriver() {
    for (const url of STA_MAG_URLS) {
        try {
            const r = await fetch(url);
            if (!r.ok) continue;
            const rows = await r.json();
            const drv = stereoBeaconDriver(rows);
            if (drv.length) return drv;
        } catch { /* try next candidate */ }
    }
    return null;
}

/** Fetch recent DONKI CME analyses through the site's edge proxy. */
export async function fetchDonkiCmes({ days = 7 } = {}) {
    const resp = await fetch(`/api/donki/cme?days=${days}`);
    if (!resp.ok) throw new Error(`donki proxy: HTTP ${resp.status}`);
    return parseDonkiCmes(await resp.json());
}

// Direct → same-origin mirror fallback, the js/swpc-feed.js fetchNoaa
// pattern: some client networks block services.swpc.noaa.gov outright;
// /api/noaa/passthrough re-serves the byte-identical product.
async function fetchNoaaJson(url) {
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (r.ok) return await r.json();
    } catch { /* fall through to the mirror */ }
    const path = url.replace('https://services.swpc.noaa.gov/', '');
    const m = await fetch(`/api/noaa/passthrough?path=${encodeURIComponent(path)}`,
        { signal: AbortSignal.timeout(15_000) });
    return m.ok ? m.json() : [];
}

/** Fetch the live L1 driver (last ~24 h at 1-min cadence). */
export async function fetchRtswDriver() {
    const [mag, wind] = await Promise.all([
        fetchNoaaJson(RTSW_MAG_URL),
        fetchNoaaJson(RTSW_WIND_URL),
    ]);
    return rtswDriver(mag, wind);
}
