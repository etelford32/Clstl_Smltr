/**
 * swpc-feed.js — Tiered space weather data pipeline
 *
 * NOAA data is fetched directly from the browser (CORS enabled on all
 * services.swpc.noaa.gov endpoints).  Server-side fetches via Vercel edge
 * functions are blocked by NOAA WAF (403 host_not_allowed).
 *
 * DONKI (NASA) data still flows through /api/donki/* edge functions because
 * the NASA_API_KEY must stay server-side and is not affected by WAF.
 *
 * THREE POLL TIERS
 * ─────────────────────────────────────────────────────────────────────────────
 *  T1 — 60 s   wind, Kp-1m, X-ray  (drives live globe shader; GOES ~1-min)
 *  T2 —  5 min protons, electrons, aurora, alerts
 *  T3 — 15 min flares, regions, Dst, DONKI CME/notify/flares/GST/SEP
 *
 *  T2 fires 5 s after T1; T3 fires 10 s after T1 (staggered to avoid burst).
 *  Storm-mode escalation compresses all intervals when Kp ≥ 6, X-class flare,
 *  or Earth-directed CME is detected.  Auto-reverts after calm streak.
 *
 * STATE EVENT
 * ─────────────────────────────────────────────────────────────────────────────
 *  window.addEventListener('swpc-update', e => …)
 *  e.detail — see _buildState() for full schema.
 *
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *  import { SpaceWeatherFeed } from './js/swpc-feed.js';
 *  import { TIER } from './js/config.js';
 *
 *  const feed = new SpaceWeatherFeed({ tier: TIER.FREE });
 *  feed.start();
 */

import { API, NOAA, INTERVALS, STORM, STORM_TRIGGERS, TIER, planToTier } from './config.js';

// ── Lazy auth-derived tier ──────────────────────────────────────────────────
// Read the live auth state from the same localStorage key auth.js writes to.
// Avoids importing the auth module (and its Supabase + Three.js deps) into
// pages that only want the feed. Falls back to TIER.FREE if not signed in.
const _AUTH_KEY = 'pp_auth';
function _detectTierFromStorage() {
    try {
        const raw = localStorage.getItem(_AUTH_KEY) || sessionStorage.getItem(_AUTH_KEY);
        if (!raw) return TIER.FREE;
        const a = JSON.parse(raw);
        if (!a?.signedIn) return TIER.FREE;
        return planToTier(a.plan, a.role);
    } catch { return TIER.FREE; }
}

// ── Quiet-Sun fallback state ──────────────────────────────────────────────────
export const FALLBACK = {
    speed:       400,    // km/s   — nominal slow solar wind
    density:       5.0,  // n/cc
    temperature: 1e5,    // K
    bt:            5.0,  // nT total IMF
    bz:            0.0,  // nT (0 = weakly northward Parker spiral)
    bx:            0.0,
    by:            5.0,
    kp:            2.0,  // quiet geomagnetic conditions
    kp_1min:       2.0,
    kp_forecast:   [],    // array of {time, kp, kind: 'observed'|'estimated'|'predicted'}
    xray_flux:   1e-8,   // W/m²  A-class background
    xray_class:  'A1.0',
    flare_class:  null,
    flare_time:   null,
    flare_letter: 'A',
    flare_location: null,
    flare_watts:  1e-8,
    flares:         [],
    recent_flares:  [],
    active_regions: [],
    proton_flux_10mev:  0.1,
    proton_flux_100mev: 0.01,
    electron_flux_2mev: 100,
    aurora_power_north: 2,
    aurora_power_south: 2,
    aurora_activity:    'quiet',
    active_alerts:      [],
    f107_flux:               150,    // sfu — moderate solar activity
    f107_adjusted_sfu:       null,
    f107_activity:           'moderate',
    f107_slope_sfu_per_day:  null,
    f107_trend_direction:    null,
    f107_recent:             [],
    sep_storm_level:    0,
    recent_cmes:        [],
    earth_directed_cme: null,
    cme_eta_hours:      null,
    donki_notifications: [],
    dst_index:          -5,
    proton_diff_1mev:   0.0,
    proton_diff_10mev:  0.0,
    donki_flares:       [],
    gst_events:         [],
    current_gst:        null,
    sep_events:         [],
    recent_sep_event:   null,
    radiation_storm_active: false,
};

// ── X-ray class helpers ───────────────────────────────────────────────────────
const CLASS_SCALE = { A: 1e-8, B: 1e-7, C: 1e-6, M: 1e-5, X: 1e-4 };

function fluxToClass(flux) {
    const f      = Math.max(flux, 1e-9);
    const letter = f >= 1e-4 ? 'X' : f >= 1e-5 ? 'M' : f >= 1e-6 ? 'C' :
                   f >= 1e-7 ? 'B' : 'A';
    const num    = (f / CLASS_SCALE[letter]).toFixed(1);
    return `${letter}${num}`;
}

function parseFlareClass(cls) {
    if (!cls || typeof cls !== 'string') return { letter: 'A', number: 1, watts: 1e-8 };
    const letter = cls[0].toUpperCase();
    const number = parseFloat(cls.slice(1)) || 1.0;
    const watts  = (CLASS_SCALE[letter] ?? 1e-8) * number;
    return { letter, number, watts };
}

// ── Flare deduplication ────────────────────────────────────────────────────────

/**
 * Merge NOAA and DONKI flare arrays into one deduplicated list.
 *
 * Strategy:
 *   • NOAA flares are the primary record (real-time GOES peak times).
 *   • Each NOAA flare is matched to at most one DONKI flare whose peak
 *     (or begin) time falls within FLARE_MERGE_WINDOW_MS; the pair is
 *     enriched with DONKI's id and linked_cme flag.
 *   • Unmatched DONKI flares are appended (DONKI may cover events outside
 *     the NOAA 24-hour window or not yet catalogued by NOAA).
 *   • Result is sorted most-recent-first and capped at 15 entries.
 *
 * Unified flare shape:
 *   { time, cls, parsed, location, region, linked_cme, donki_id, source }
 *   source: 'merged' | 'noaa' | 'donki'
 */
const FLARE_MERGE_WINDOW_MS = 5 * 60 * 1000;   // ±5 min — NOAA/DONKI peak times can differ

function mergeFlares(noaaFlares, donkiFlares) {
    const noaa  = Array.isArray(noaaFlares)  ? noaaFlares  : [];
    const donki = Array.isArray(donkiFlares) ? donkiFlares : [];

    const matched = new Set();   // indices into donki already consumed

    const out = noaa.map(nf => {
        const nfMs = nf.time instanceof Date ? nf.time.getTime() : 0;

        // Find the closest DONKI flare within the merge window
        let bestIdx = -1;
        let bestDt  = FLARE_MERGE_WINDOW_MS + 1;
        for (let i = 0; i < donki.length; i++) {
            if (matched.has(i)) continue;
            const df   = donki[i];
            const dfMs = df.peak_time instanceof Date ? df.peak_time.getTime()
                       : df.begin_time instanceof Date ? df.begin_time.getTime() : 0;
            const dt = Math.abs(nfMs - dfMs);
            if (dt < bestDt) { bestDt = dt; bestIdx = i; }
        }

        if (bestIdx >= 0 && bestDt <= FLARE_MERGE_WINDOW_MS) {
            matched.add(bestIdx);
            const df = donki[bestIdx];
            return {
                time:       nf.time,
                cls:        nf.cls,
                parsed:     nf.parsed,
                location:   nf.location        ?? df.location       ?? null,
                region:     nf.region          ?? df.active_region  ?? null,
                linked_cme: df.linked_cme      ?? false,
                donki_id:   df.id              ?? null,
                source:     'merged',
            };
        }

        return {
            time:       nf.time,
            cls:        nf.cls,
            parsed:     nf.parsed,
            location:   nf.location ?? null,
            region:     nf.region   ?? null,
            linked_cme: false,
            donki_id:   null,
            source:     'noaa',
        };
    });

    // Append DONKI flares that had no NOAA counterpart
    for (let i = 0; i < donki.length; i++) {
        if (matched.has(i)) continue;
        const df  = donki[i];
        const cls = df.flare_class ?? null;
        if (!cls) continue;
        out.push({
            time:       df.peak_time instanceof Date  ? df.peak_time
                      : df.begin_time instanceof Date ? df.begin_time : null,
            cls,
            parsed:     parseFlareClass(cls),
            location:   df.location      ?? null,
            region:     df.active_region ?? null,
            linked_cme: df.linked_cme    ?? false,
            donki_id:   df.id            ?? null,
            source:     'donki',
        });
    }

    return out
        .filter(f => f.cls && f.time)
        .sort((a, b) => b.time.getTime() - a.time.getTime())
        .slice(0, 15);
}

// ── Normalisation helpers ─────────────────────────────────────────────────────
const clamp01 = v => Math.max(0, Math.min(1, v ?? 0));

function derivedFields(raw) {
    const d = {};
    d.wind_speed_norm    = clamp01((raw.speed   - 250) / 650);
    d.wind_density_norm  = clamp01( raw.density        / 25);
    d.kp_norm            = clamp01( raw.kp             / 9);
    d.bz_southward       = clamp01(-raw.bz             / 30);
    d.bt_norm            = clamp01( raw.bt             / 30);
    const logFlux        = Math.log10(Math.max(raw.xray_flux, 1e-9));
    d.xray_intensity     = clamp01((logFlux + 9) / 6);
    d.storm_level        = raw.kp >= 9 ? 5 : raw.kp >= 8 ? 4 : raw.kp >= 7 ? 3 :
                           raw.kp >= 6 ? 2 : raw.kp >= 5 ? 1 : 0;
    d.proton_10mev_norm  = clamp01((Math.log10(Math.max(raw.proton_flux_10mev,  0.1)) + 1) / 6);
    d.proton_100mev_norm = clamp01((Math.log10(Math.max(raw.proton_flux_100mev, 0.01)) + 2) / 5);
    d.electron_2mev_norm = clamp01((Math.log10(Math.max(raw.electron_flux_2mev, 10)) - 1) / 5);
    d.aurora_north_norm  = clamp01(raw.aurora_power_north / 600);
    d.aurora_south_norm  = clamp01(raw.aurora_power_south / 600);
    d.f107_norm          = clamp01((raw.f107_flux - 65) / 235);
    d.dst_norm           = clamp01(-raw.dst_index / 200);
    d.kp_1min_norm       = clamp01((raw.kp_1min ?? raw.kp) / 9);
    return d;
}

function parseLocation(loc) {
    if (!loc) return null;
    const m = loc.match(/([NS])(\d+)([EW])(\d+)/i);
    if (!m) return null;
    const lat = parseInt(m[2]) * (m[1].toUpperCase() === 'N' ?  1 : -1);
    const lon = parseInt(m[4]) * (m[3].toUpperCase() === 'E' ?  1 : -1);
    return { lat_rad: lat * Math.PI / 180, lon_rad: lon * Math.PI / 180 };
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

/**
 * Retry-with-exponential-backoff wrapper. Up to `maxAttempts` tries (default 3);
 * waits 500 ms, 1500 ms between retries.  5xx and network errors (including
 * AbortError on timeout) retry; 4xx responses throw immediately since they
 * almost always indicate a URL/config bug that no number of retries will fix.
 *
 * Matches WeatherFeed's recovery strategy so intermittent NOAA 502/504s
 * during storm traffic spikes don't instantly poison the feed's failStreak.
 */
const SWPC_RETRY_DELAYS_MS = [500, 1500];   // 3 total attempts

async function _fetchWithRetry(url, label) {
    const attempts = SWPC_RETRY_DELAYS_MS.length + 1;
    let lastErr;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (!res.ok) {
                // 4xx = likely non-transient; bubble up immediately.
                if (res.status >= 400 && res.status < 500) {
                    throw new Error(`${label} HTTP ${res.status} — ${url}`);
                }
                throw new Error(`${label} HTTP ${res.status} — ${url}`);
            }
            try {
                return await res.json();
            } catch (e) {
                throw new Error(`${label} bad JSON from ${url}: ${e.message}`);
            }
        } catch (err) {
            lastErr = err;
            // Don't retry definitive client errors (4xx).
            if (/HTTP 4\d\d/.test(err.message)) throw err;
            if (attempt < SWPC_RETRY_DELAYS_MS.length) {
                await new Promise(r => setTimeout(r, SWPC_RETRY_DELAYS_MS[attempt]));
            }
        }
    }
    throw lastErr;
}

/** Direct browser→NOAA fetch (CORS enabled; WAF only blocks server-side). */
async function fetchNoaa(url) {
    return _fetchWithRetry(url, 'NOAA');
}

/** Edge function fetch (DONKI only — NASA key stays server-side). */
async function fetchEdge(url) {
    return _fetchWithRetry(url, 'Edge');
}

// ── 2D-array helpers (NOAA "CSV-in-JSON" format used by several endpoints) ───

/** Parse a NOAA 2D-array response into an array of plain objects. */
function parse2D(raw) {
    if (!Array.isArray(raw) || raw.length < 2) return [];
    const headers = raw[0].map(h => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
    return raw.slice(1).map(row =>
        Object.fromEntries(headers.map((h, i) => [h, row[i]]))
    );
}

/** Fill sentinel for NOAA numeric columns (values ≤ −9990 or > 1e20). */
const noaaFill = v => (v == null || Number(v) <= -9990 || Number(v) > 1e20) ? null : Number(v);

// ── T1 fetchers ───────────────────────────────────────────────────────────────

async function fetchWind(state) {
    const raw = await fetchNoaa(NOAA.wind);
    // Format: array of objects {time_tag, speed, density, temperature, bt, bz_gsm, bx_gsm, by_gsm}
    // Rows are 1-minute samples; last non-fill entry is current.
    if (!Array.isArray(raw) || raw.length === 0) return;

    // Walk backwards to find the most recent ACTIVE row with a valid speed.
    // Rows with active=false may be from an inactive instrument or data gap.
    // Prefer DSCOVR proton_* fields; apply noaaFill to each independently.
    for (let i = raw.length - 1; i >= 0; i--) {
        const r   = raw[i];
        // Skip inactive rows (instrument offline or data gap)
        if (r.active === false) continue;
        const spd = noaaFill(r.proton_speed) ?? noaaFill(r.speed);
        if (spd == null) continue;
        if (spd > 0)     state.speed = spd;
        const den = noaaFill(r.proton_density) ?? noaaFill(r.density);
        if (den != null && den > 0) state.density = den;
        const tmp = noaaFill(r.proton_temperature) ?? noaaFill(r.temperature);
        if (tmp != null && tmp > 0) state.temperature = tmp;
        // IMF data: rtsw_wind_1m.json may NOT include bt/bz — those are in
        // rtsw_mag_1m.json.  Try all known field name variants.
        const bt  = noaaFill(r.bt) ?? noaaFill(r.bt_gsm);
        if (bt  != null) state.bt = Math.abs(bt);
        const bz  = noaaFill(r.bz_gsm) ?? noaaFill(r.bz) ?? noaaFill(r.bz_gse);
        if (bz  != null) state.bz = bz;
        const bx  = noaaFill(r.bx_gsm) ?? noaaFill(r.bx) ?? noaaFill(r.bx_gse);
        if (bx  != null) state.bx = bx;
        const by  = noaaFill(r.by_gsm) ?? noaaFill(r.by) ?? noaaFill(r.by_gse);
        if (by  != null) state.by = by;
        if (r.time_tag) state.wind_timestamp = new Date(r.time_tag);
        break;
    }
}

// ── IMF magnetometer data (separate NOAA endpoint) ──────────────────────────
// rtsw_wind_1m.json contains PLASMA data only (speed, density, temperature).
// IMF Bt/Bz/Bx/By come from the MAGNETOMETER on a separate endpoint.
// This was previously assumed to be in the same file but NOAA splits them.
async function fetchMag(state) {
    const MAG_URL = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json';
    let raw;
    try {
        raw = await fetchNoaa(MAG_URL);
    } catch {
        return;  // mag data unavailable — retain previous values
    }
    if (!Array.isArray(raw) || raw.length === 0) return;

    for (let i = raw.length - 1; i >= 0; i--) {
        const r = raw[i];
        if (r.active === false) continue;
        // Try all known IMF field name variants
        const bt = noaaFill(r.bt) ?? noaaFill(r.bt_gsm);
        if (bt == null) continue;
        state.bt = Math.abs(bt);
        const bz = noaaFill(r.bz_gsm) ?? noaaFill(r.bz) ?? noaaFill(r.bz_gse);
        if (bz != null) state.bz = bz;
        const bx = noaaFill(r.bx_gsm) ?? noaaFill(r.bx) ?? noaaFill(r.bx_gse);
        if (bx != null) state.bx = bx;
        const by = noaaFill(r.by_gsm) ?? noaaFill(r.by) ?? noaaFill(r.by_gse);
        if (by != null) state.by = by;
        if (r.time_tag) state.mag_timestamp = new Date(r.time_tag);
        break;
    }
}

async function fetchKp1m(state) {
    const raw = await fetchNoaa(NOAA.kp1m);
    // Format: array of objects {time_tag, estimated_kp, kp_index, kp}
    if (!Array.isArray(raw) || raw.length === 0) return;
    for (let i = raw.length - 1; i >= 0; i--) {
        const r  = raw[i];
        const kp = noaaFill(r.estimated_kp ?? r.kp_index ?? r.kp);
        if (kp == null) continue;
        state.kp_1min = kp;
        state.kp      = kp;   // use 1-min Kp as primary
        break;
    }
}

// ── T2 fetchers ───────────────────────────────────────────────────────────────

async function fetchXray(state) {
    const raw = await fetchNoaa(NOAA.xray);
    // Format: object-array OR 2D array depending on NOAA product version
    if (!Array.isArray(raw) || raw.length < 2) return;

    let rows;
    if (Array.isArray(raw[0])) {
        rows = parse2D(raw);
    } else {
        rows = raw.filter(r => r && typeof r === 'object');
    }
    // Filter to long-band (0.1–0.8 nm) rows; NOAA uses 'energy', 'wavelength', or 'band'
    const bandKey = rows[0] && (
        'energy'     in rows[0] ? 'energy'     :
        'wavelength' in rows[0] ? 'wavelength' :
        'band'       in rows[0] ? 'band'        : null
    );
    const longBand = bandKey
        ? rows.filter(r => {
            const w = String(r[bandKey] ?? '').toLowerCase();
            return w.includes('0.1') || w.includes('long') || w.includes('1-8') || w.includes('0.8');
          })
        : rows;
    const candidates = longBand.length > 0 ? longBand : rows;

    for (let i = candidates.length - 1; i >= 0; i--) {
        const r    = candidates[i];
        const flux = noaaFill(r.flux ?? r.observed_flux);
        if (flux == null || flux <= 0) continue;
        state.xray_flux  = flux;
        state.xray_class = fluxToClass(flux);
        // Seed flare_letter from background X-ray (won't overwrite real flare data)
        state.flare_letter = state.flare_letter ?? state.xray_class[0];
        break;
    }
}

async function fetchProtons(state) {
    const raw = await fetchNoaa(NOAA.protons);
    // Format: object-array OR 2D array with energy column
    if (!Array.isArray(raw) || raw.length < 2) return;
    let rows;
    if (Array.isArray(raw[0])) {
        rows = parse2D(raw);
    } else {
        rows = raw.filter(r => r && typeof r === 'object');
    }

    const byEnergy = {};
    for (const r of rows) {
        const e   = String(r.energy ?? r.channel ?? '');
        const fl  = noaaFill(r.flux);
        if (fl == null) continue;
        if (!byEnergy[e] || r.time_tag > byEnergy[e].time_tag) byEnergy[e] = { flux: fl, time_tag: r.time_tag };
    }

    // Map energy labels to state fields — NOAA uses formats like ">=10 MeV", "P10", "10 MeV"
    for (const [energy, val] of Object.entries(byEnergy)) {
        const e = energy.toLowerCase().replace(/\s/g, '');
        if (/p10$|>=?10m|^10m/.test(e))  state.proton_flux_10mev  = val.flux;
        if (/p100$|>=?100m|^100m/.test(e)) state.proton_flux_100mev = val.flux;
    }

    // S-scale SEP storm level based on >=10 MeV channel
    const p10 = state.proton_flux_10mev ?? 0;
    state.sep_storm_level = p10 >= 100000 ? 5 : p10 >= 10000 ? 4 : p10 >= 1000 ? 3 :
                            p10 >=    100 ? 2 : p10 >= 10    ? 1 : 0;
}

async function fetchElectrons(state) {
    const raw = await fetchNoaa(NOAA.electrons);
    // Format: object-array OR 2D array with energy column
    if (!Array.isArray(raw) || raw.length < 2) return;
    let rows;
    if (Array.isArray(raw[0])) {
        rows = parse2D(raw);
    } else {
        rows = raw.filter(r => r && typeof r === 'object');
    }

    let latest2mev = null;
    for (const r of rows) {
        const e  = String(r.energy ?? r.channel ?? '').toLowerCase().replace(/\s/g, '');
        if (!/e2$|>=?2\.?0?m|^2\.?0?m/.test(e)) continue;
        const fl = noaaFill(r.flux);
        if (fl == null) continue;
        if (!latest2mev || r.time_tag > latest2mev.time_tag) latest2mev = { flux: fl, time_tag: r.time_tag };
    }
    if (latest2mev) state.electron_flux_2mev = latest2mev.flux;
}

// Calibration constant: weighted-probability sum → GW. Empirically tuned
// against published OVATION nowcast hemispheric-power values: a quiet
// day's grid sums to ~150-300 weighted units → ~4-8 GW; a Kp 7 storm
// hits ~3500 → ~85 GW; an extreme event ~6000 → ~150 GW. The value is
// not a published NOAA constant — it's reverse-engineered from the
// relationship between the grid integral and the separately-published
// hemi-power text file. Re-tune if NOAA changes the OVATION model
// output range.
const _OVATION_PROB_TO_GW = 0.025;

/**
 * Integrate a 1°×1° OVATION probability grid into a per-hemisphere
 * power estimate (GW). Each cell's contribution is its probability
 * (0-100) multiplied by cos(lat) to area-weight, then summed and
 * scaled by the empirical calibration constant.
 *
 * Returns null if the grid is malformed — caller falls back to the
 * previous tick's value.
 */
function _integrateOvationGrid(coordinates) {
    if (!Array.isArray(coordinates) || coordinates.length === 0) return null;
    let north = 0, south = 0;
    let nN = 0, nS = 0;
    for (const row of coordinates) {
        if (!Array.isArray(row) || row.length < 3) continue;
        const lat = parseFloat(row[1]);
        const prob = parseFloat(row[2]);
        if (!Number.isFinite(lat) || !Number.isFinite(prob)) continue;
        // Area weight on a unit sphere: dA ∝ cos(lat) for equal-Δlat,Δlon.
        const cosLat = Math.cos(lat * Math.PI / 180);
        const weighted = prob * cosLat;
        if (lat >= 0) { north += weighted; nN++; }
        else          { south += weighted; nS++; }
    }
    if (nN === 0 && nS === 0) return null;
    return {
        north_gw: north * _OVATION_PROB_TO_GW,
        south_gw: south * _OVATION_PROB_TO_GW,
    };
}

async function fetchAurora(state) {
    const raw = await fetchNoaa(NOAA.aurora);
    if (!raw || typeof raw !== 'object') return;

    // OVATION's published JSON delivers a coordinates grid (1° × 1°,
    // 64,800 points: [lon, lat, probability_0_100]). Pre-2024 docs and
    // some mirrors mention top-level "Hemispheric Power" fields; the
    // *live* services.swpc.noaa.gov payload doesn't carry them, so the
    // earlier code silently returned null and the shader sat at the
    // default-2-GW fallback even during major storms. Fix: derive
    // hemi-power by integrating the grid we already have in hand,
    // and fall back to whatever top-level keys are present (some
    // mirrors and the .txt nowcast feed do publish them).
    let north = noaaFill(
        raw['Hemispheric Power North'] ??
        raw['hemispheric_power_north'] ??
        raw.north_power
    );
    let south = noaaFill(
        raw['Hemispheric Power South'] ??
        raw['hemispheric_power_south'] ??
        raw.south_power
    );
    if ((north == null || south == null) && Array.isArray(raw.coordinates)) {
        const integrated = _integrateOvationGrid(raw.coordinates);
        if (integrated) {
            if (north == null) north = integrated.north_gw;
            if (south == null) south = integrated.south_gw;
        }
    }
    if (north != null) state.aurora_power_north = north;
    if (south != null) state.aurora_power_south = south;

    // Stash the upstream forecast timestamp so the resolver / HUD can
    // distinguish a stale grid from a fresh one. NOAA publishes the
    // OVATION nowcast at 5-minute cadence; anything older than ~30 min
    // is suspect and we tag the resolver source accordingly.
    const ftime = raw['Forecast Time'] ?? raw.forecast_time;
    if (ftime) {
        const t = Date.parse(ftime);
        if (Number.isFinite(t)) state.aurora_forecast_ms = t;
    }

    // Derive activity label from total hemispheric power.
    const total = (north ?? 0) + (south ?? 0);
    state.aurora_activity = total > 200 ? 'severe'
        : total > 100 ? 'active'
        : total > 40  ? 'moderate'
        : total > 10  ? 'low'
        : 'quiet';
}

// Surfaced for the AuroraHistory module and any direct tests — keeps
// the integration logic in one place rather than a duplicate in the
// edge function.
export { _integrateOvationGrid as integrateOvationGrid };

async function fetchAlerts(state) {
    const raw = await fetchNoaa(NOAA.alerts);
    // Format: array of objects {product_id, issue_datetime, message}
    if (!Array.isArray(raw)) { state.active_alerts = []; return; }
    state.active_alerts = raw.map(a => {
        const msg = String(a.message ?? a.body ?? '').trim();
        return {
            issued: new Date(a.issue_datetime ?? a.issue_time ?? 0),
            text:   msg,
            level:  /WARNING|WATCH/i.test(msg) ? 'warning'
                  : /ALERT/i.test(msg)          ? 'alert'
                  : 'info',
        };
    }).slice(0, 20);
}

/**
 * NOAA 3-day Kp forecast — 3-hour bins mixing observed, estimated, and
 * predicted values. Format is a 2D array:
 *   [ ['time_tag','kp','observed','noaa_scale'],
 *     ['2025-11-01 00:00:00', '3.00', 'observed',  'G0'],
 *     ['2025-11-01 03:00:00', '2.67', 'estimated', 'G0'],
 *     ['2025-11-01 06:00:00', '3.33', 'predicted', 'G0'], … ]
 * `observed` column is literally the string label — not a boolean.
 */
async function fetchKpForecast(state) {
    const raw = await fetchNoaa(NOAA.kpForecast);
    if (!Array.isArray(raw) || raw.length < 2) { state.kp_forecast = []; return; }
    const rows = parse2D(raw);
    state.kp_forecast = rows.map(r => {
        const t  = r.time_tag ? new Date(r.time_tag.replace(' ', 'T') + 'Z') : null;
        const kp = Number(r.kp);
        const kind = String(r.observed ?? '').toLowerCase();   // 'observed' | 'estimated' | 'predicted'
        if (!t || isNaN(t.getTime()) || !isFinite(kp)) return null;
        return { time: t, kp, kind: kind || 'predicted' };
    }).filter(Boolean);
}

async function fetchDst(state) {
    const raw = await fetchNoaa(NOAA.dst);
    // Format: object-array OR 2D array [time_tag, dst]; fill |dst| > 1000
    if (!Array.isArray(raw) || raw.length < 2) return;
    let rows;
    if (Array.isArray(raw[0])) {
        rows = parse2D(raw);
    } else {
        rows = raw.filter(r => r && typeof r === 'object');
    }
    for (let i = rows.length - 1; i >= 0; i--) {
        const r   = rows[i];
        const dst = Number(r.dst ?? r.dst_index ?? NaN);
        if (isNaN(dst) || Math.abs(dst) > 1000) continue;
        state.dst_index = dst;
        break;
    }
}

// ── T3 fetchers ───────────────────────────────────────────────────────────────

async function fetchFlares(state) {
    // NOAA retired xray-flares-7day.json; rely on DONKI flares (fetched separately)
    if (!NOAA.flares) { return; }
    const raw = await fetchNoaa(NOAA.flares);
    // Format: array of objects {begin_time, peak_time, end_time, max_class,
    //         goes_location, noaa_active_region}
    if (!Array.isArray(raw)) { state.recent_flares = []; return; }

    const parsed = raw
        .map(f => ({
            time:     new Date(f.peak_time ?? f.begin_time ?? 0),
            cls:      f.max_class ?? f.flare_class ?? null,
            location: f.goes_location ?? f.location ?? null,
            region:   f.noaa_active_region ?? f.region ?? null,
            parsed:   parseFlareClass(f.max_class ?? f.flare_class),
        }))
        .filter(f => f.cls)
        .sort((a, b) => b.time - a.time)   // most recent first
        .slice(0, 12);

    state.recent_flares = parsed;
    if (parsed.length > 0) {
        const top            = parsed[0];
        state.flare_class    = top.cls;
        state.flare_watts    = top.parsed.watts;
        state.flare_letter   = top.parsed.letter;
        state.flare_time     = top.time;
        state.flare_location = top.location;
    }
}

async function fetchRegions(state) {
    const raw = await fetchNoaa(NOAA.regions);
    // Format: array of objects {region/Region, location/Location, latitude,
    //         carrington_longitude, area, z_class/Z, mag_class/Mag, num_spots/Spots}
    if (!Array.isArray(raw)) { state.active_regions = []; return; }
    state.active_regions = raw.slice(0, 5).map(r => {
        const lat = Number(r.latitude         ?? r.Latitude  ?? 0);
        const lon = Number(r.carrington_longitude ?? r.Longitude ?? r.carrington_lon ?? 0);
        const mag = String(r.mag_class ?? r.Mag ?? r.magclass ?? '');
        return {
            region:     r.region     ?? r.Region     ?? null,
            lat_deg:    lat,
            lon_deg:    lon,
            lat_rad:    lat * Math.PI / 180,
            lon_rad:    lon * Math.PI / 180,
            area_norm:  Math.min((Number(r.area ?? r.Area ?? 20)) / 400, 1.0),
            mag_class:  mag,
            is_complex: mag.includes('gamma') || mag.includes('delta'),
            num_spots:  Number(r.num_spots ?? r.Spots ?? r.numspot ?? 1),
        };
    });
}

async function fetchDONKICME(state) {
    const json = await fetchEdge(API.donkiCME);
    const list = json?.data?.cmes;
    if (!Array.isArray(list)) { state.recent_cmes = []; return; }

    const now    = Date.now();
    const parsed = list.map(c => {
        // Kinematic arrival estimate: distance from 21.5 Rs to Earth ≈ 1.345 × 10⁸ km
        const t21_5      = c.time ? new Date(c.time) : null;
        const t21_5Valid = t21_5 !== null && !isNaN(t21_5.getTime());
        const speed      = c.speed_km_s ?? 400;
        const etaMs      = t21_5Valid ? (1.345e8 / Math.max(speed, 50)) * 1e6 : null;
        const arrival    = etaMs ? new Date(t21_5.getTime() + etaMs) : null;
        const arrivalValid = arrival !== null && !isNaN(arrival.getTime());
        const hoursUntil = arrivalValid ? (arrival.getTime() - now) / 3.6e6 : null;
        return {
            time:          c.time ?? null,
            speed:         speed,
            latitude:      c.latitude_deg   ?? 0,
            longitude:     c.longitude_deg  ?? 0,
            halfAngle:     c.half_angle_deg ?? 30,
            type:          c.type           ?? 'S',
            earthDirected: c.earth_directed ?? false,
            arrivalTime:   arrivalValid ? arrival.toISOString() : null,
            hoursUntil,
            note:          c.note ?? '',
            lat_rad:       (c.latitude_deg  ?? 0) * Math.PI / 180,
            lon_rad:       (c.longitude_deg ?? 0) * Math.PI / 180,
        };
    });

    state.recent_cmes = parsed;
    const edList             = parsed.filter(c => c.earthDirected && (c.hoursUntil ?? 0) > -24);
    state.earth_directed_cme = edList[0] ?? null;
    state.cme_eta_hours      = state.earth_directed_cme?.hoursUntil ?? null;
}

async function fetchDONKINotifications(state) {
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

async function fetchDONKIFlares(state) {
    const json = await fetchEdge(API.donkiFlares);
    const list = json?.data?.flares;
    if (!Array.isArray(list)) { state.donki_flares = []; return; }
    state.donki_flares = list.map(f => ({
        id:           f.id           ?? null,
        begin_time:   new Date(f.begin_time ?? 0),
        peak_time:    f.peak_time  ? new Date(f.peak_time)  : null,
        flare_class:  f.flare_class  ?? null,
        class_letter: f.class_letter ?? 'A',
        location:     f.location     ?? null,
        active_region: f.active_region ?? null,
        linked_cme:   f.linked_cme   ?? false,
    })).slice(0, 12);
}

async function fetchDONKIGST(state) {
    const json = await fetchEdge(API.donkiGST);
    const list = json?.data?.events;
    if (!Array.isArray(list)) { state.gst_events = []; state.current_gst = null; return; }
    state.gst_events = list.map(g => ({
        id:         g.id         ?? null,
        start_time: new Date(g.start_time ?? 0),
        max_kp:     g.max_kp     ?? null,
        g_scale:    g.g_scale    ?? 0,
        linked_cme: g.linked_cme ?? false,
    }));
    const cs = json?.data?.current_storm ?? null;
    state.current_gst = cs ? { ...cs, start_time: new Date(cs.start_time ?? 0) } : null;
}

async function fetchDONKISEP(state) {
    const json = await fetchEdge(API.donkiSEP);
    const list = json?.data?.events;
    if (!Array.isArray(list)) { state.sep_events = []; state.recent_sep_event = null; state.radiation_storm_active = false; return; }
    state.sep_events = list.map(s => ({
        id:           s.id          ?? null,
        event_time:   new Date(s.event_time ?? 0),
        linked_flare: s.linked_flare ?? false,
        linked_cme:   s.linked_cme   ?? false,
    }));
    const re = json?.data?.recent_event ?? null;
    state.recent_sep_event = re ? { ...re, event_time: new Date(re.event_time ?? 0) } : null;
    state.radiation_storm_active = json?.data?.radiation_storm_active ?? false;
}

// ── T4 fetchers (PRO only, 60-min cadence) ────────────────────────────────────

async function fetchRadioFlux(state) {
    const raw = await fetchNoaa(NOAA.radioFlux);
    // Format: either array of objects [{time_tag, flux, adjusted_flux}]
    //         OR 2D array [[headers], [row], …]
    let rows;
    if (Array.isArray(raw) && Array.isArray(raw[0])) {
        rows = parse2D(raw);
    } else if (Array.isArray(raw)) {
        rows = raw;
    } else {
        return;
    }
    if (rows.length === 0) return;

    // Most recent valid flux entry
    let cur = null;
    for (let i = rows.length - 1; i >= 0; i--) {
        const fl = noaaFill(rows[i].flux ?? rows[i].observed_flux);
        if (fl != null && fl > 0) { cur = rows[i]; break; }
    }
    if (!cur) return;

    const flux = noaaFill(cur.flux ?? cur.observed_flux);
    if (flux != null) {
        state.f107_flux = flux;
        state.f107_adjusted_sfu = noaaFill(cur.adjusted_flux ?? cur.flux_adjusted) ?? null;
        // Activity label from flux level
        state.f107_activity = flux >= 200 ? 'very high'
            : flux >= 150 ? 'high'
            : flux >= 120 ? 'moderate'
            : flux >= 80  ? 'low'
            : 'very low';
    }

    // Simple trend: slope over last N entries
    const recent = rows
        .filter(r => noaaFill(r.flux ?? r.observed_flux) != null)
        .slice(-30)
        .map(r => ({ t: new Date(r.time_tag).getTime(), f: Number(r.flux ?? r.observed_flux) }))
        .filter(r => !isNaN(r.t) && !isNaN(r.f));
    if (recent.length >= 2) {
        const n      = recent.length;
        const dt_ms  = recent[n - 1].t - recent[0].t;
        const df     = recent[n - 1].f - recent[0].f;
        const slope  = dt_ms > 0 ? df / (dt_ms / 86400000) : 0;
        state.f107_slope_sfu_per_day = parseFloat(slope.toFixed(2));
        state.f107_trend_direction   = slope >  1 ? 'rising'
                                     : slope < -1 ? 'falling'
                                     : 'steady';
    }
    state.f107_recent = recent.slice(-10).map(r => ({ flux: r.f }));
}

// ── SpaceWeatherFeed ──────────────────────────────────────────────────────────

export class SpaceWeatherFeed {
    /**
     * @param {object}  opts
     * @param {string} [opts.tier]  Override the auto-detected tier. Pass
     *                              TIER.PRO to force T4 + faster storm
     *                              multipliers (e.g. for an admin preview);
     *                              omit to derive from the signed-in user's
     *                              plan via planToTier().
     */
    constructor({ tier } = {}) {
        // Auto-derive from auth when not explicitly specified. Historical
        // call sites (`new SpaceWeatherFeed()` without a tier arg) used to
        // get TIER.FREE unconditionally — meaning Advanced/Institution/
        // Enterprise users were silently downgraded to free-tier polling
        // intervals + no T4. Now those tiers correctly land in TIER.PRO.
        this.tier        = tier ?? _detectTierFromStorage();
        this._raw        = { ...FALLBACK };
        this._timers     = {};
        this._stormMode  = false;
        this._calmStreak = 0;
        this.status      = 'connecting';
        this.lastUpdated = null;
        this.failStreak  = 0;
        this._lastFlareKey = null;
        this._lastCmeKey   = null;

        // Re-evaluate tier on auth changes (sign-in, plan upgrade via
        // checkout). Reschedule active timers if the bucket flipped, so a
        // user who upgrades mid-session immediately gets the faster
        // intervals + T4 without a page reload.
        if (typeof window !== 'undefined' && tier == null) {
            this._authListener = () => {
                const next = _detectTierFromStorage();
                if (next === this.tier) return;
                const wasRunning = !!this._timers.t1;
                this.tier = next;
                if (!wasRunning) return;
                // Tear down + re-start so T4 schedule respects the new tier.
                this.stop();
                this.start();
            };
            window.addEventListener('auth-changed', this._authListener);
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** Start all tiers. Returns `this` for chaining. */
    start() {
        // T1 — immediate, then every ~60 s
        this._runT1();
        this._timers.t1 = setInterval(() => this._runT1(), this._interval('T1'));

        // T2 — slight delay to stagger burst, then every ~5 min
        setTimeout(() => {
            this._runT2();
            this._timers.t2 = setInterval(() => this._runT2(), this._interval('T2'));
        }, INTERVALS.T2_OFFSET);

        // T3 — slight delay, then every ~15 min
        setTimeout(() => {
            this._runT3();
            this._timers.t3 = setInterval(() => this._runT3(), this._interval('T3'));
        }, INTERVALS.T3_OFFSET);

        // T4 — PRO only, 60-min cadence; fires immediately so first state is complete
        if (this.tier === TIER.PRO) {
            this._runT4();
            this._timers.t4 = setInterval(() => this._runT4(), INTERVALS.T4);
        }

        return this;
    }

    /** Stop all polling. */
    stop() {
        Object.values(this._timers).forEach(clearInterval);
        this._timers = {};
    }

    /** Immediately fire all tiers (T4 only if PRO). */
    refresh() {
        const tiers = [this._runT1(), this._runT2(), this._runT3()];
        if (this.tier === TIER.PRO) tiers.push(this._runT4());
        return Promise.all(tiers);
    }

    /** Current normalised state snapshot (does not trigger a fetch). */
    get state() { return this._buildState(); }

    // ── Internals ─────────────────────────────────────────────────────────────

    _interval(tier) {
        const base = INTERVALS[tier];
        return this._stormMode
            ? Math.round(base * STORM[this.tier][tier])
            : base;
    }

    /** Restart timers with current storm-mode intervals. (T4 is fixed; no reschedule.) */
    _reschedule() {
        ['t1', 't2', 't3'].forEach(k => {
            clearInterval(this._timers[k]);
            delete this._timers[k];
        });
        this._timers.t1 = setInterval(() => this._runT1(), this._interval('T1'));
        this._timers.t2 = setInterval(() => this._runT2(), this._interval('T2'));
        this._timers.t3 = setInterval(() => this._runT3(), this._interval('T3'));
    }

    async _runT1() {
        const results = await Promise.allSettled([
            fetchWind(this._raw),
            fetchMag(this._raw),      // IMF Bt/Bz — separate from plasma data
            fetchKp1m(this._raw),
            fetchXray(this._raw),
        ]);
        const ok = results.some(r => r.status === 'fulfilled');
        if (ok) {
            this.status      = 'live';
            this.lastUpdated = new Date();
            this.failStreak  = 0;
        } else {
            this.failStreak++;
            this.status = this.failStreak > 2 ? 'offline' : 'stale';
        }
        results.forEach((r, i) => {
            if (r.status === 'rejected')
                console.warn(`[SWPC T1] feed ${i}: ${r.reason?.message ?? r.reason}`);
        });
        this._checkStormMode();
        this._dispatch();
    }

    async _runT2() {
        const results = await Promise.allSettled([
            fetchProtons(this._raw),
            fetchElectrons(this._raw),
            fetchAurora(this._raw),
            fetchAlerts(this._raw),
        ]);
        results.forEach((r, i) => {
            if (r.status === 'rejected')
                console.warn(`[SWPC T2] feed ${i}: ${r.reason?.message ?? r.reason}`);
        });
        this._checkStormMode();
        this._dispatch();
    }

    async _runT3() {
        const results = await Promise.allSettled([
            fetchFlares(this._raw),
            fetchRegions(this._raw),
            fetchDst(this._raw),
            fetchKpForecast(this._raw),
            fetchDONKICME(this._raw),
            fetchDONKINotifications(this._raw),
            fetchDONKIFlares(this._raw),
            fetchDONKIGST(this._raw),
            fetchDONKISEP(this._raw),
        ]);
        results.forEach((r, i) => {
            if (r.status === 'rejected')
                console.warn(`[SWPC T3] feed ${i}: ${r.reason?.message ?? r.reason}`);
        });
        this._checkStormMode();
        this._dispatch();
    }

    /** T4 — PRO only, 60-min cadence. */
    async _runT4() {
        const results = await Promise.allSettled([
            fetchRadioFlux(this._raw),
        ]);
        results.forEach((r, i) => {
            if (r.status === 'rejected')
                console.warn(`[SWPC T4] feed ${i}: ${r.reason?.message ?? r.reason}`);
        });
        this._dispatch();
    }

    _checkStormMode() {
        const raw  = this._raw;
        const trig = STORM_TRIGGERS;
        const active = (
            (raw.kp_1min ?? raw.kp) >= trig.kp_min      ||  // G2+ geomagnetic storm
            (raw.xray_flux         ?? 0) >= trig.xray_flux_min ||  // live X-class (T1 cadence)
            (raw.sep_storm_level   ?? 0) >= trig.sep_level_min  ||  // S3+ radiation storm
            !!raw.earth_directed_cme                             // imminent CME arrival
        );

        if (active && !this._stormMode) {
            this._stormMode  = true;
            this._calmStreak = 0;
            console.info('[SWPC] Storm mode ACTIVATED — intervals compressed');
            this._reschedule();
        } else if (!active && this._stormMode) {
            this._calmStreak++;
            if (this._calmStreak >= trig.calm_streak) {
                this._stormMode  = false;
                this._calmStreak = 0;
                console.info('[SWPC] Storm mode DEACTIVATED — intervals restored');
                this._reschedule();
            }
        } else if (active) {
            this._calmStreak = 0;
        }
    }

    _dispatch() {
        window.dispatchEvent(new CustomEvent('swpc-update', { detail: this._buildState() }));
    }

    _buildState() {
        const raw = this._raw;
        const d   = derivedFields(raw);

        // Detect new M/X flare — use merged flares so DONKI-only events also trigger
        const flares     = mergeFlares(raw.recent_flares, raw.donki_flares);
        const topFlare   = flares[0] ?? null;
        const flareKey   = topFlare ? `${topFlare.cls}|${topFlare.time instanceof Date && !isNaN(topFlare.time) ? topFlare.time.toISOString() : topFlare.time}` : null;
        const newMajor   = !!(
            topFlare &&
            (topFlare.parsed.letter === 'M' || topFlare.parsed.letter === 'X') &&
            flareKey !== this._lastFlareKey
        );
        if (newMajor) this._lastFlareKey = flareKey;

        // Detect new Earth-directed CME
        const topCme     = (raw.recent_cmes ?? []).find(c => c.earthDirected) ?? null;
        const cmeKey     = topCme?.time ?? null;
        const newCme     = !!(topCme && cmeKey !== this._lastCmeKey);
        if (newCme) this._lastCmeKey = cmeKey;

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
            flares,                             // unified NOAA+DONKI, deduped by peak time
            recent_flares:  raw.recent_flares  ?? [],   // raw NOAA source (backward compat)
            derived:        d,
            status:         this.status,
            lastUpdated:    this.lastUpdated,
            storm_mode:     this._stormMode,
            new_major_flare: newMajor,
            flare_direction: flareDir,
            proton_flux_10mev:  raw.proton_flux_10mev,
            proton_flux_100mev: raw.proton_flux_100mev,
            electron_flux_2mev: raw.electron_flux_2mev,
            sep_storm_level:    raw.sep_storm_level ?? 0,
            aurora_power_north: raw.aurora_power_north,
            aurora_power_south: raw.aurora_power_south,
            aurora_activity:    raw.aurora_activity ?? 'quiet',
            active_alerts:      raw.active_alerts   ?? [],
            f107_flux:               raw.f107_flux,
            f107_adjusted_sfu:       raw.f107_adjusted_sfu       ?? null,
            f107_activity:           raw.f107_activity           ?? null,
            f107_slope_sfu_per_day:  raw.f107_slope_sfu_per_day  ?? null,
            f107_trend_direction:    raw.f107_trend_direction     ?? null,
            f107_recent:             raw.f107_recent              ?? [],
            recent_cmes:         raw.recent_cmes        ?? [],
            earth_directed_cme:  raw.earth_directed_cme ?? null,
            cme_eta_hours:       raw.cme_eta_hours      ?? null,
            donki_notifications: raw.donki_notifications ?? [],
            donki_flares:        raw.donki_flares        ?? [],
            gst_events:          raw.gst_events          ?? [],
            current_gst:         raw.current_gst         ?? null,
            sep_events:          raw.sep_events          ?? [],
            recent_sep_event:    raw.recent_sep_event    ?? null,
            radiation_storm_active: raw.radiation_storm_active ?? false,
            new_cme_detected:    newCme,
            dst_index:           raw.dst_index  ?? -5,
            kp_1min:             raw.kp_1min    ?? raw.kp,
            proton_diff_1mev:    raw.proton_diff_1mev  ?? 0,
            proton_diff_10mev:   raw.proton_diff_10mev ?? 0,

            // ── Nested groups — clean API for new consumers ───────────────
            kp_forecast:   raw.kp_forecast ?? [],
            geomagnetic: {
                kp:           raw.kp,
                kp_1min:      raw.kp_1min      ?? raw.kp,
                dst_nT:       raw.dst_index    ?? -5,
                storm_level:  d.storm_level,
                kp_norm:      d.kp_norm,
                kp_1min_norm: d.kp_1min_norm,
                dst_norm:     d.dst_norm,
                kp_forecast:  raw.kp_forecast ?? [],
            },
            particles: {
                proton_10mev_pfu:   raw.proton_flux_10mev,
                proton_100mev_pfu:  raw.proton_flux_100mev,
                electron_2mev_pfu:  raw.electron_flux_2mev,
                sep_storm_level:    raw.sep_storm_level     ?? 0,
                proton_10mev_norm:  d.proton_10mev_norm,
                proton_100mev_norm: d.proton_100mev_norm,
                electron_2mev_norm: d.electron_2mev_norm,
            },
            aurora: {
                north_gw:   raw.aurora_power_north,
                south_gw:   raw.aurora_power_south,
                activity:   raw.aurora_activity  ?? 'quiet',
                north_norm: d.aurora_north_norm,
                south_norm: d.aurora_south_norm,
            },
            solar_activity: {
                f107_sfu:          raw.f107_flux,
                f107_adjusted_sfu: raw.f107_adjusted_sfu       ?? null,
                activity_label:    raw.f107_activity           ?? null,
                slope_per_day:     raw.f107_slope_sfu_per_day  ?? null,
                trend:             raw.f107_trend_direction    ?? null,
                recent:            raw.f107_recent             ?? [],
                f107_norm:         d.f107_norm,
            },
            meta: {
                status:      this.status,
                lastUpdated: this.lastUpdated,
                storm_mode:  this._stormMode,
                tier:        this.tier,
            },
        };
    }
}

export default SpaceWeatherFeed;
