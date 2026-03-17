/**
 * swpc-feed.js — NOAA Space Weather Prediction Center real-time data pipeline
 *
 * Polls five public SWPC JSON endpoints on a configurable interval (default 5 min),
 * normalises raw physical units to [0,1] shader-friendly scalars, and dispatches a
 * 'swpc-update' CustomEvent on window each time new data arrives.
 *
 * ENDPOINTS (all public, CORS-enabled, ~1-minute NOAA update cadence)
 * ─────────────────────────────────────────────────────────────────────
 *  wind_1m   DSCOVR / ACE L1 real-time solar wind
 *            fields: bt(nT), bz(nT), bx_gse, by_gse, density(n/cc),
 *                    speed(km/s), temperature(K)
 *  kp_index  NOAA estimated planetary Kp index (3-hour)
 *  xray_flux GOES primary 0.1–0.8 nm channel (1-day history)
 *  flares_7d GOES solar flare event list (7-day)
 *  regions   Active solar region (sunspot group) table
 *
 * STATE OBJECT  (event.detail)
 * ─────────────────────────────────────────────────────────────────────
 *  solar_wind  { speed, density, temperature, bt, bz, bx, by }
 *  kp          number  0–9  (NOAA planetary K-index)
 *  xray_flux   W/m²    current GOES X-ray flux
 *  xray_class  string  "A1.2" / "M5.4" / "X2.1" …
 *  flare_class string  class of most recent flare (may be hours old)
 *  flare_time  Date
 *  flare_location  string e.g. "N24W30"
 *  active_regions  [{ region, lat_rad, lon_rad, area_norm, is_complex }]
 *  recent_flares   [{ time, cls, parsed, location }]  (10 most recent)
 *  derived     { wind_speed_norm, wind_density_norm, kp_norm,
 *                bz_southward, bt_norm, xray_intensity, storm_level }
 *  status      'live' | 'stale' | 'offline' | 'connecting'
 *  lastUpdated Date
 *  new_major_flare  bool  — true once per M/X flare detection
 *  flare_direction  { lat_rad, lon_rad } | null
 *
 * USAGE
 * ─────────────────────────────────────────────────────────────────────
 *  import { SpaceWeatherFeed } from './js/swpc-feed.js';
 *  const feed = new SpaceWeatherFeed();
 *  window.addEventListener('swpc-update', e => console.log(e.detail));
 *  feed.start();
 */

// ── Endpoint registry ─────────────────────────────────────────────────────────
export const ENDPOINTS = {
    /** DSCOVR/ACE 1-minute real-time solar wind (Bt, Bz, speed, density, temp) */
    wind_1m:      'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json',
    /** Planetary Kp index (3-hour cadence, 2-D array) */
    kp_index:     'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
    /** GOES primary X-ray flux 1-day history (0.1–0.8 nm channel) */
    xray_flux:    'https://services.swpc.noaa.gov/json/goes/primary/xray-1-day.json',
    /** Solar flare event list — last 7 days */
    flares_7d:    'https://services.swpc.noaa.gov/json/goes/primary/xray-flares-7day.json',
    /** Active solar regions (sunspot groups) */
    regions:      'https://services.swpc.noaa.gov/json/solar_regions.json',

    // ── Extended NOAA feeds ────────────────────────────────────────────────
    /** GOES integral proton flux 1-day (>10, >50, >100 MeV channels) — SEP/radiation storm */
    protons_1d:   'https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json',
    /** GOES integral electron flux 1-day (>0.8, >2.0 MeV channels) */
    electrons_1d: 'https://services.swpc.noaa.gov/json/goes/primary/integral-electrons-1-day.json',
    /** OVATION Prime auroral power nowcast (GW) — north + south hemispheres */
    aurora_now:   'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json',
    /** Space weather alerts / warnings / watches (machine-readable JSON) */
    alerts:       'https://services.swpc.noaa.gov/products/alerts.json',
    /** Daily 10.7-cm solar radio flux (F10.7) — EUV/X-ray activity proxy */
    radio_flux:   'https://services.swpc.noaa.gov/json/f107_cm_flux.json',

    // ── NASA CCMC / DONKI (Space Weather Database Of Notifications, Knowledge, Info) ──
    /** CME Analysis — cone model, speed, direction, ENLIL model arrival times.
     *  Requires dynamic date params; base URL completed at fetch time. */
    donki_cme:    'https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/rest/CMEAnalysis',
    /** DONKI notifications — all space weather events, last 30 days */
    donki_notify: 'https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/rest/notifications',
};

// ── Quiet-Sun baseline (used as fallback when endpoints are unavailable) ──────
export const FALLBACK = {
    speed:       400,    // km/s   — nominal slow solar wind
    density:       5.0,  // n/cc
    temperature: 1e5,   // K
    bt:            5.0,  // nT total IMF
    bz:            0.0,  // nT  (0 = weakly northward Parker spiral)
    bx:            0.0,
    by:            5.0,
    kp:            2.0,  // quiet geomagnetic conditions
    xray_flux:   1e-8,   // W/m²  A-class background
    xray_class:  'A1.0',
    flare_class:  null,
    flare_time:   null,
    flare_letter: 'A',
    flare_location: null,
    flare_watts:  1e-8,
    recent_flares:  [],
    active_regions: [],
    // Extended fields
    proton_flux_10mev:  0.1,   // pfu — background >10 MeV channel
    proton_flux_100mev: 0.01,  // pfu — background >100 MeV channel
    electron_flux_2mev: 100,   // pfu — background >2 MeV channel
    aurora_power_north: 2,     // GW  — quiet auroral oval
    aurora_power_south: 2,     // GW
    active_alerts:      [],    // current NOAA alert/warning messages
    f107_flux:          150,   // sfu — moderate solar activity
    sep_storm_level:    0,     // S0–S5 radiation storm proxy
    aurora_activity:    'quiet', // 'quiet'|'active'|'storm'
    // DONKI CME fields
    recent_cmes:          [],   // parsed CME events from DONKI (last 7 days)
    earth_directed_cme:   null, // most recent Earth-directed CME object
    cme_eta_hours:        null, // float hours until Earth arrival (negative = arrived)
    donki_notifications:  [],   // recent DONKI notification messages
};

// ── X-ray class helpers ───────────────────────────────────────────────────────
const CLASS_SCALE = { A: 1e-8, B: 1e-7, C: 1e-6, M: 1e-5, X: 1e-4 };

function fluxToClass(flux) {
    const f = Math.max(flux, 1e-9);
    const letter = f >= 1e-4 ? 'X' : f >= 1e-5 ? 'M' : f >= 1e-6 ? 'C' :
                   f >= 1e-7 ? 'B' : 'A';
    const num = (f / CLASS_SCALE[letter]).toFixed(1);
    return `${letter}${num}`;
}

function parseFlareClass(cls) {
    if (!cls || typeof cls !== 'string') return { letter: 'A', number: 1, watts: 1e-8 };
    const letter = cls[0].toUpperCase();
    const number = parseFloat(cls.slice(1)) || 1.0;
    const watts  = (CLASS_SCALE[letter] ?? 1e-8) * number;
    return { letter, number, watts };
}

// ── Normalization helpers ─────────────────────────────────────────────────────
const clamp01 = v => Math.max(0, Math.min(1, v ?? 0));

/**
 * Map raw measurements to [0,1] scalars used by shaders/particles.
 * Ranges are empirically chosen to span common solar-cycle conditions.
 */
function derivedFields(raw) {
    const d = {};

    // Wind speed: 250 km/s (slow) → 900 km/s (fast stream / CME shock)
    d.wind_speed_norm   = clamp01((raw.speed   - 250) / 650);
    // Density: background ~3 n/cc, solar energetic particle events ~20+ n/cc
    d.wind_density_norm = clamp01( raw.density        / 25);
    // Kp: 0 (quiet) → 9 (extreme storm)
    d.kp_norm           = clamp01( raw.kp             / 9);
    // Southward Bz: only negative component drives magnetospheric reconnection
    // Range: 0 (northward) → 30 nT southward
    d.bz_southward      = clamp01(-raw.bz             / 30);
    // Total IMF: 0 → 30 nT
    d.bt_norm           = clamp01( raw.bt             / 30);
    // X-ray flux (log scale): 1e-9 W/m² → 0.0,  1e-7 → 0.33,  1e-4 → 0.83,  1e-3 → 1.0
    const logFlux       = Math.log10(Math.max(raw.xray_flux, 1e-9));
    d.xray_intensity    = clamp01((logFlux + 9) / 6);

    // NOAA G-scale geomagnetic storm proxy from Kp
    d.storm_level = raw.kp >= 9 ? 5 : raw.kp >= 8 ? 4 : raw.kp >= 7 ? 3 :
                    raw.kp >= 6 ? 2 : raw.kp >= 5 ? 1 : 0;

    // Proton flux (log): 0.1 pfu (background) → 0; 1e5 pfu (S5 storm) → 1
    d.proton_10mev_norm  = clamp01((Math.log10(Math.max(raw.proton_flux_10mev,  0.1)) + 1) / 6);
    d.proton_100mev_norm = clamp01((Math.log10(Math.max(raw.proton_flux_100mev, 0.01)) + 2) / 5);

    // Electron flux: log-normalised, typical quiet ~100 pfu → 0.5
    d.electron_2mev_norm = clamp01((Math.log10(Math.max(raw.electron_flux_2mev, 10)) - 1) / 5);

    // Aurora: 0 GW (no aurora) → 600 GW (severe storm)
    d.aurora_north_norm = clamp01(raw.aurora_power_north / 600);
    d.aurora_south_norm = clamp01(raw.aurora_power_south / 600);

    // F10.7: 65 sfu (solar minimum) → 300 sfu (solar maximum)
    d.f107_norm = clamp01((raw.f107_flux - 65) / 235);

    return d;
}

// ── Normalization helpers (extended) ──────────────────────────────────────────

/**
 * NOAA S-scale Solar Radiation Storm from >10 MeV proton flux (pfu)
 * S1≥10, S2≥100, S3≥1000, S4≥10000, S5≥100000
 */
function protonToSLevel(pfu) {
    if (pfu >= 1e5) return 5;
    if (pfu >= 1e4) return 4;
    if (pfu >= 1e3) return 3;
    if (pfu >= 100) return 2;
    if (pfu >= 10)  return 1;
    return 0;
}

// ── Individual endpoint fetchers ──────────────────────────────────────────────
async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

/**
 * DSCOVR/ACE real-time solar wind
 * Response: array of 1-minute records, latest last.
 * Fields vary by instrument; we normalise the union.
 */
async function fetchWind(state) {
    const data = await fetchJSON(ENDPOINTS.wind_1m);
    if (!Array.isArray(data)) return;
    // Walk backwards to find most recent record with non-null speed + density
    const rec = [...data].reverse().find(r => r.speed != null && r.speed > 0);
    if (!rec) return;
    if (rec.speed       != null) state.speed       = rec.speed;
    if (rec.density     != null) state.density     = rec.density;
    if (rec.temperature != null) state.temperature = rec.temperature;
    if (rec.bt          != null) state.bt          = rec.bt;
    if (rec.bz          != null) state.bz          = rec.bz;
    if (rec.bx_gse      != null) state.bx          = rec.bx_gse;
    if (rec.by_gse      != null) state.by          = rec.by_gse;
    state.wind_timestamp = new Date((rec.time_tag ?? '').replace(' ', 'T') + 'Z');
}

/**
 * NOAA planetary Kp index
 * Response: 2-D array — row[0] is a header row, subsequent rows are data.
 * Column order varies; locate 'kp' column by header name.
 */
async function fetchKp(state) {
    const data = await fetchJSON(ENDPOINTS.kp_index);
    if (!Array.isArray(data) || data.length < 2) return;
    const headers = data[0].map(h => String(h).toLowerCase());
    const kpCol   = headers.indexOf('kp');
    if (kpCol < 0) return;
    const recent  = [...data.slice(1)].reverse().find(r => r[kpCol] != null && r[kpCol] !== '');
    if (recent) state.kp = parseFloat(recent[kpCol]);
}

/**
 * GOES primary X-ray flux (0.1–0.8 nm)
 * Response: array of objects with { time_tag, flux, energy }
 * Pick the most recent record with the long-channel (0.1–0.8nm) flux.
 */
async function fetchXray(state) {
    const data = await fetchJSON(ENDPOINTS.xray_flux);
    if (!Array.isArray(data)) return;
    const rec = [...data]
        .reverse()
        .find(r => r.flux != null && r.flux > 0 &&
              (!r.energy || r.energy.includes('0.1-0.8')));
    if (!rec) return;
    state.xray_flux  = rec.flux;
    state.xray_class = fluxToClass(rec.flux);
}

/**
 * GOES flare event list (7-day)
 * Response: array of flare event objects.
 */
async function fetchFlares(state) {
    const data = await fetchJSON(ENDPOINTS.flares_7d);
    if (!Array.isArray(data)) { state.recent_flares = []; return; }

    const parsed = data
        .filter(f => f.begin_time && f.class)
        .map(f => ({
            time:     new Date((f.begin_time ?? '').replace(' ', 'T') + 'Z'),
            cls:      f.class,
            location: f.location ?? null,
            parsed:   parseFlareClass(f.class),
        }))
        .sort((a, b) => b.time - a.time)
        .slice(0, 12);

    state.recent_flares = parsed;
    if (parsed.length > 0) {
        const top          = parsed[0];
        state.flare_class  = top.cls;
        state.flare_watts  = top.parsed.watts;
        state.flare_letter = top.parsed.letter;
        state.flare_time   = top.time;
        state.flare_location = top.location;
    }
}

/**
 * Active solar regions (sunspot groups)
 * Response: array of region objects.
 * We cap at 5 — matching the shader array size.
 */
async function fetchRegions(state) {
    const data = await fetchJSON(ENDPOINTS.regions);
    if (!Array.isArray(data)) { state.active_regions = []; return; }

    state.active_regions = data
        .filter(r => r.region && r.latitude != null)
        .slice(0, 5)
        .map(r => ({
            region:     r.region,
            lat_deg:    r.latitude            ?? 0,
            lon_deg:    r.carrington_longitude ?? 0,
            lat_rad:    (r.latitude            ?? 0) * Math.PI / 180,
            // Carrington longitude in radians — sun-rotation offset applied by caller
            lon_rad:    (r.carrington_longitude ?? 0) * Math.PI / 180,
            // Normalised area: typical range 10–500 μHem
            area_norm:  Math.min((r.area ?? 20) / 400, 1.0),
            mag_class:  r.mag_class ?? '',
            // Complex (Beta-Gamma / Gamma) regions are most likely to flare
            is_complex: (r.mag_class ?? '').includes('amma'),
            num_spots:  r.num_spots ?? 1,
        }));
}

// ── Extended NOAA fetchers ────────────────────────────────────────────────────

/**
 * GOES integral proton flux — picks the most recent >10 MeV and >100 MeV values.
 * Response: array of {time_tag, energy, flux} objects.
 */
async function fetchProtons(state) {
    const data = await fetchJSON(ENDPOINTS.protons_1d);
    if (!Array.isArray(data)) return;
    // Walk backwards; pick latest non-null record per channel
    const byEnergy = {};
    for (const rec of [...data].reverse()) {
        if (rec.flux == null || rec.flux <= 0) continue;
        const key = String(rec.energy ?? '');
        if (!byEnergy[key]) byEnergy[key] = rec.flux;
    }
    // >10 MeV key varies by satellite; match any key containing '10'
    for (const [k, v] of Object.entries(byEnergy)) {
        if (k.includes('10') && !k.includes('100')) state.proton_flux_10mev  = v;
        if (k.includes('100'))                       state.proton_flux_100mev = v;
    }
    state.sep_storm_level = protonToSLevel(state.proton_flux_10mev);
}

/**
 * GOES integral electron flux — picks the most recent >2 MeV value.
 */
async function fetchElectrons(state) {
    const data = await fetchJSON(ENDPOINTS.electrons_1d);
    if (!Array.isArray(data)) return;
    const rec = [...data].reverse().find(r => r.flux != null && r.flux > 0 &&
        String(r.energy ?? '').includes('2'));
    if (rec) state.electron_flux_2mev = rec.flux;
}

/**
 * OVATION Prime auroral power nowcast.
 * Response: { Forecast: { North: { Power: N }, South: { Power: N } } }
 *           or flat { north: N, south: N } depending on version.
 */
async function fetchAurora(state) {
    const data = await fetchJSON(ENDPOINTS.aurora_now);
    // Attempt multiple response shapes
    const north = data?.Forecast?.North?.Power
               ?? data?.north
               ?? data?.[0]?.power
               ?? null;
    const south = data?.Forecast?.South?.Power
               ?? data?.south
               ?? data?.[1]?.power
               ?? null;
    if (north != null) state.aurora_power_north = north;
    if (south != null) state.aurora_power_south = south;

    const totalGW = (state.aurora_power_north ?? 0) + (state.aurora_power_south ?? 0);
    state.aurora_activity = totalGW > 200 ? 'storm' : totalGW > 80 ? 'active' : 'quiet';
}

/**
 * NOAA space weather alerts/warnings/watches.
 * Response: array of {message, issue_datetime, ...} objects.
 * We keep only current (non-cancelled) messages, capped at 10.
 */
async function fetchAlerts(state) {
    const data = await fetchJSON(ENDPOINTS.alerts);
    if (!Array.isArray(data)) { state.active_alerts = []; return; }
    state.active_alerts = data
        .filter(a => a.message && !/CANCEL/i.test(a.message))
        .slice(0, 10)
        .map(a => ({
            issued: new Date((a.issue_datetime ?? '').replace(' ', 'T') + 'Z'),
            text:   String(a.message ?? '').trim(),
            // Classify severity by first line of message
            level:  /WARNING|WATCH/i.test(a.message) ? 'warning'
                  : /ALERT/i.test(a.message)         ? 'alert'
                  : 'info',
        }));
}

/**
 * F10.7-cm solar radio flux.
 * Response: array of {time_tag, flux} objects — most recent last.
 */
async function fetchRadioFlux(state) {
    const data = await fetchJSON(ENDPOINTS.radio_flux);
    if (!Array.isArray(data)) return;
    const rec = [...data].reverse().find(r => r.flux != null && r.flux > 0);
    if (rec) state.f107_flux = rec.flux;
}

/**
 * NASA DONKI CME Analysis — cone model, speed, direction, ENLIL arrival forecast.
 *
 * Key fields returned per CME:
 *   time21_5   ISO datetime when CME reached 21.5 solar radii
 *   latitude   CME axis ecliptic latitude (°N positive)
 *   longitude  Stonyhurst heliographic longitude (0° = Sun-Earth direction, +W)
 *   halfAngle  Angular half-width of the eruption cone (degrees)
 *   speed      CME leading-edge speed at 21.5 Rs (km/s)
 *   type       S (slow), C (common), O (halo), R (partial halo)
 *   enlilList  WSA-ENLIL model run(s) with estimatedShockArrivalTime
 *
 * Earth-directed criterion: |longitude| ≤ halfAngle + 30° buffer
 *   (Earth is in the cone ± a generous buffer for partial halos).
 */
async function fetchDONKICME(state) {
    const now   = new Date();
    const start = new Date(now - 7 * 86400e3);   // 7-day window
    const fmt   = d => d.toISOString().split('T')[0];
    const url   = `${ENDPOINTS.donki_cme}` +
                  `?mostAccurateOnly=true` +
                  `&startDate=${fmt(start)}&endDate=${fmt(now)}`;

    let data;
    try { data = await fetchJSON(url); }
    catch { return; }  // DONKI is occasionally slow/down — gracefully degrade

    if (!Array.isArray(data)) { state.recent_cmes = []; return; }

    const parsed = data
        .filter(c => c.time21_5 && c.speed > 0)
        .map(c => {
            // ── Arrival time ─────────────────────────────────────────────
            // t21_5 = when CME crosses 21.5 Rs (the model inner boundary, ~0.1 AU)
            // Remaining distance to Earth: (215 - 21.5) Rs = 193.5 Rs ≈ 1.345 × 10⁸ km
            const t21_5   = new Date(c.time21_5.endsWith('Z') ? c.time21_5 : c.time21_5 + 'Z');
            const distKm  = 1.345e8;
            const etaMs   = (distKm / Math.max(c.speed, 50)) * 1e6; // km/s → ms
            const kinetic = new Date(t21_5.getTime() + etaMs);

            // Prefer ENLIL model if available (more accurate)
            let enlilArrival = null, enlilKp = null, enlilDuration = null;
            if (Array.isArray(c.enlilList) && c.enlilList.length > 0) {
                const run = c.enlilList.find(r => r.estimatedShockArrivalTime)
                         ?? c.enlilList[0];
                if (run?.estimatedShockArrivalTime) {
                    const ts = run.estimatedShockArrivalTime;
                    enlilArrival = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
                }
                enlilKp       = run?.kp18 ?? run?.kp90 ?? null;
                enlilDuration = run?.estimatedDuration ?? null;
            }

            const arrival      = enlilArrival ?? kinetic;
            const hoursUntil   = (arrival.getTime() - now.getTime()) / 3.6e6;

            // ── Earth-directed flag ──────────────────────────────────────
            // longitude 0° = Sun→Earth direction; ±half+30° inclusive cone
            const lon          = c.longitude   ?? 0;
            const half         = c.halfAngle   ?? 30;
            const earthDir     = Math.abs(lon) <= (half + 30);

            return {
                time:         t21_5,
                speed:        c.speed,
                latitude:     c.latitude  ?? 0,
                longitude:    lon,
                halfAngle:    half,
                type:         c.type      ?? 'S',
                earthDirected: earthDir,
                arrivalTime:  arrival,
                hoursUntil,
                hasEnlil:     !!enlilArrival,
                enlilKp,
                enlilDuration,
                note:         c.note ?? '',
                link:         c.link ?? '',
                lat_rad:      (c.latitude ?? 0) * Math.PI / 180,
                lon_rad:      lon * Math.PI / 180,
            };
        })
        .sort((a, b) => b.time - a.time)   // most recent first
        .slice(0, 10);

    state.recent_cmes = parsed;

    // Most recent Earth-directed CME (arrived within last 24h or future)
    const edList = parsed.filter(c => c.earthDirected && c.hoursUntil > -24);
    state.earth_directed_cme = edList[0] ?? null;
    state.cme_eta_hours      = state.earth_directed_cme?.hoursUntil ?? null;
}

/**
 * DONKI all-event notifications (last 7 days).
 * Returns compact notification objects for display in the alert feed.
 */
async function fetchDONKINotifications(state) {
    const now   = new Date();
    const start = new Date(now - 7 * 86400e3);
    const fmt   = d => d.toISOString().split('T')[0];
    const url   = `${ENDPOINTS.donki_notify}?type=all&startDate=${fmt(start)}&endDate=${fmt(now)}`;

    let data;
    try { data = await fetchJSON(url); }
    catch { return; }
    if (!Array.isArray(data)) { state.donki_notifications = []; return; }

    state.donki_notifications = data
        .filter(n => n.messageType && n.messageTime)
        .map(n => ({
            type:    n.messageType,
            time:    new Date(n.messageTime.endsWith('Z') ? n.messageTime : n.messageTime + 'Z'),
            body:    (n.messageBody ?? '').slice(0, 280),
            url:     n.messageURL ?? null,
        }))
        .sort((a, b) => b.time - a.time)
        .slice(0, 12);
}

// ── Parse NOAA location string to lat/lon (e.g. "N24W30") ────────────────────
function parseLocation(loc) {
    if (!loc) return null;
    const m = loc.match(/([NS])(\d+)([EW])(\d+)/i);
    if (!m) return null;
    const lat = parseInt(m[2]) * (m[1].toUpperCase() === 'N' ?  1 : -1);
    const lon = parseInt(m[4]) * (m[3].toUpperCase() === 'E' ?  1 : -1);
    return { lat_rad: lat * Math.PI / 180, lon_rad: lon * Math.PI / 180 };
}

// ── SpaceWeatherFeed ──────────────────────────────────────────────────────────
export class SpaceWeatherFeed {
    /**
     * @param {object} opts
     * @param {number} opts.pollInterval  milliseconds between polls (default 5 min)
     */
    constructor({ pollInterval = 5 * 60 * 1000 } = {}) {
        this.pollInterval  = pollInterval;
        this._timer        = null;
        this.status        = 'connecting';
        this.lastUpdated   = null;
        this.failStreak    = 0;
        // Mutable raw state; endpoints mutate fields in place
        this._raw          = { ...FALLBACK };
        this._lastFlareKey = null;  // used to detect new flare events
        this._lastCmeKey   = null;  // used to detect new CME events
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** Start polling. Returns `this` for chaining. */
    start() {
        this._poll();  // immediate first call
        this._timer = setInterval(() => this._poll(), this.pollInterval);
        return this;
    }

    /** Stop polling. */
    stop() {
        clearInterval(this._timer);
        this._timer = null;
    }

    /** Trigger an out-of-band refresh immediately. */
    refresh() { return this._poll(); }

    /** Current normalised state snapshot (does not trigger a fetch). */
    get state() { return this._buildState(); }

    // ── Internals ─────────────────────────────────────────────────────────────

    async _poll() {
        const tasks = [
            fetchWind(this._raw),
            fetchKp(this._raw),
            fetchXray(this._raw),
            fetchFlares(this._raw),
            fetchRegions(this._raw),
            // Extended NOAA feeds
            fetchProtons(this._raw),
            fetchElectrons(this._raw),
            fetchAurora(this._raw),
            fetchAlerts(this._raw),
            fetchRadioFlux(this._raw),
            // NASA DONKI — run independently so CCMC slowness doesn't block NOAA feeds
            fetchDONKICME(this._raw),
            fetchDONKINotifications(this._raw),
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

        // Debug-level logging only
        results.forEach((r, i) => {
            if (r.status === 'rejected')
                console.debug(`[SWPC] ${Object.keys(ENDPOINTS)[i]}: ${r.reason?.message ?? r.reason}`);
        });

        window.dispatchEvent(new CustomEvent('swpc-update', { detail: this._buildState() }));
    }

    _buildState() {
        const raw = this._raw;
        const d   = derivedFields(raw);

        // Detect whether a new M-class or stronger flare just appeared
        const topFlare    = raw.recent_flares[0] ?? null;
        const flareKey    = topFlare ? `${topFlare.cls}|${topFlare.time?.toISOString()}` : null;
        const newMajor    = !!(
            topFlare &&
            (topFlare.parsed.letter === 'M' || topFlare.parsed.letter === 'X') &&
            flareKey !== this._lastFlareKey
        );
        if (newMajor) this._lastFlareKey = flareKey;

        // Detect new Earth-directed CME from DONKI
        const topCme    = (raw.recent_cmes ?? []).find(c => c.earthDirected) ?? null;
        const cmeKey    = topCme ? topCme.time?.toISOString() : null;
        const newCme    = !!(topCme && cmeKey !== this._lastCmeKey);
        if (newCme) this._lastCmeKey = cmeKey;

        // Direction of the most recent flare (from NOAA location string)
        const flareDir = parseLocation(raw.flare_location);

        return {
            solar_wind: {
                speed:       raw.speed,
                density:     raw.density,
                temperature: raw.temperature,
                bt:          raw.bt,
                bz:          raw.bz,
                bx:          raw.bx,
                by:          raw.by,
            },
            kp:             raw.kp,
            xray_flux:      raw.xray_flux,
            xray_class:     raw.xray_class ?? fluxToClass(raw.xray_flux),
            flare_class:    raw.flare_class  ?? null,
            flare_letter:   raw.flare_letter ?? 'A',
            flare_time:     raw.flare_time   ?? null,
            flare_location: raw.flare_location ?? null,
            flare_watts:    raw.flare_watts  ?? 1e-8,
            active_regions: raw.active_regions ?? [],
            recent_flares:  raw.recent_flares  ?? [],
            derived:        d,
            status:         this.status,
            lastUpdated:    this.lastUpdated,
            new_major_flare: newMajor,
            flare_direction: flareDir,
            // Extended fields
            proton_flux_10mev:  raw.proton_flux_10mev,
            proton_flux_100mev: raw.proton_flux_100mev,
            electron_flux_2mev: raw.electron_flux_2mev,
            sep_storm_level:    raw.sep_storm_level ?? 0,
            aurora_power_north: raw.aurora_power_north,
            aurora_power_south: raw.aurora_power_south,
            aurora_activity:    raw.aurora_activity ?? 'quiet',
            active_alerts:      raw.active_alerts ?? [],
            f107_flux:          raw.f107_flux,
            // DONKI CME fields
            recent_cmes:         raw.recent_cmes ?? [],
            earth_directed_cme:  raw.earth_directed_cme ?? null,
            cme_eta_hours:       raw.cme_eta_hours ?? null,
            donki_notifications: raw.donki_notifications ?? [],
            new_cme_detected:    newCme,
        };
    }
}

export default SpaceWeatherFeed;
