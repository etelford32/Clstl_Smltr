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

// ── Network wrappers (browser only; parsers above carry the logic) ───────────

const RTSW_MAG_URL = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json';
const RTSW_WIND_URL = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json';

/** Fetch recent DONKI CME analyses through the site's edge proxy. */
export async function fetchDonkiCmes({ days = 7 } = {}) {
    const resp = await fetch(`/api/donki/cme?days=${days}`);
    if (!resp.ok) throw new Error(`donki proxy: HTTP ${resp.status}`);
    return parseDonkiCmes(await resp.json());
}

/** Fetch the live L1 driver (last ~24 h at 1-min cadence). */
export async function fetchRtswDriver() {
    const [mag, wind] = await Promise.all([
        fetch(RTSW_MAG_URL).then((r) => (r.ok ? r.json() : [])),
        fetch(RTSW_WIND_URL).then((r) => (r.ok ? r.json() : [])),
    ]);
    return rtswDriver(mag, wind);
}
