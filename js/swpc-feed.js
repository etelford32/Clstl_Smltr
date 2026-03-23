/**
 * swpc-feed.js — Tiered space weather data pipeline
 *
 * All data now flows through Vercel Edge Functions (api/noaa/*, api/donki/*,
 * api/solar-wind/*) rather than hitting NOAA / NASA directly from the browser.
 * Benefits: CDN caching, payload slicing, NASA key isolation, CORS guarantee.
 *
 * THREE POLL TIERS
 * ─────────────────────────────────────────────────────────────────────────────
 *  T1 — 60 s   wind, Kp-1m           (drives live globe shader)
 *  T2 —  5 min xray, protons, electrons, aurora, alerts, Dst
 *  T3 — 15 min flares, regions, DONKI CME, DONKI notifications
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

import { API, INTERVALS, STORM, STORM_TRIGGERS, TIER } from './config.js';

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
    xray_flux:   1e-8,   // W/m²  A-class background
    xray_class:  'A1.0',
    flare_class:  null,
    flare_time:   null,
    flare_letter: 'A',
    flare_location: null,
    flare_watts:  1e-8,
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

// ── Edge API fetchers ─────────────────────────────────────────────────────────
// Each function calls one of our Vercel edge routes and writes normalised values
// into the shared mutable `state` object.  All throw on network/parse failure
// so Promise.allSettled can catch them individually.

async function fetchEdge(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.json();
}

// ── T1 fetchers ───────────────────────────────────────────────────────────────

async function fetchWind(state) {
    const json = await fetchEdge(API.wind);
    const cur  = json?.data?.current;
    if (!cur) return;
    if (cur.speed_km_s    != null) state.speed       = cur.speed_km_s;
    if (cur.density_cc    != null) state.density     = cur.density_cc;
    if (cur.temperature_K != null) state.temperature = cur.temperature_K;
    if (cur.bt_nT         != null) state.bt          = cur.bt_nT;
    if (cur.bz_nT         != null) state.bz          = cur.bz_nT;
    if (cur.bx_nT         != null) state.bx          = cur.bx_nT;
    if (cur.by_nT         != null) state.by          = cur.by_nT;
    state.wind_timestamp = new Date(json.data.updated);
}

async function fetchKp1m(state) {
    const json = await fetchEdge(API.kp1m);
    const cur  = json?.data?.current;
    if (!cur) return;
    if (cur.kp != null) {
        state.kp_1min = cur.kp;
        state.kp      = cur.kp;   // use 1-min Kp as primary
    }
}

// ── T2 fetchers ───────────────────────────────────────────────────────────────

async function fetchXray(state) {
    const json = await fetchEdge(API.xray);
    const cur  = json?.data?.current;
    if (!cur) return;
    if (cur.flux_W_m2  != null) state.xray_flux  = cur.flux_W_m2;
    if (cur.xray_class != null) state.xray_class = cur.xray_class;
    if (cur.xray_letter != null) {
        // derive flare_letter from current background X-ray for shader
        state.flare_letter = state.flare_letter ?? cur.xray_letter;
    }
}

async function fetchProtons(state) {
    const json = await fetchEdge(API.protons);
    const cur  = json?.data?.current;
    if (!cur) return;
    if (cur.flux_10mev_pfu  != null) state.proton_flux_10mev  = cur.flux_10mev_pfu;
    if (cur.flux_100mev_pfu != null) state.proton_flux_100mev = cur.flux_100mev_pfu;
    if (cur.sep_storm_level != null) state.sep_storm_level    = cur.sep_storm_level;
}

async function fetchElectrons(state) {
    const json = await fetchEdge(API.electrons);
    const cur  = json?.data?.current;
    if (!cur) return;
    if (cur.flux_2mev_pfu != null) state.electron_flux_2mev = cur.flux_2mev_pfu;
}

async function fetchAurora(state) {
    const json = await fetchEdge(API.aurora);
    const cur  = json?.data?.current;
    if (!cur) return;
    if (cur.aurora_power_north_GW != null) state.aurora_power_north = cur.aurora_power_north_GW;
    if (cur.aurora_power_south_GW != null) state.aurora_power_south = cur.aurora_power_south_GW;
    if (cur.aurora_activity       != null) state.aurora_activity    = cur.aurora_activity;
}

async function fetchAlerts(state) {
    const json = await fetchEdge(API.alerts);
    const list = json?.data?.alerts;
    if (!Array.isArray(list)) { state.active_alerts = []; return; }
    state.active_alerts = list.map(a => ({
        issued: new Date(a.issue_time),
        text:   String(a.message ?? a.body ?? '').trim(),
        level:  /WARNING|WATCH/i.test(a.message ?? a.body ?? '') ? 'warning'
              : /ALERT/i.test(a.message ?? a.body ?? '')          ? 'alert'
              : 'info',
    }));
}

async function fetchDst(state) {
    const json = await fetchEdge(API.dst);
    const cur  = json?.data?.current;
    if (!cur) return;
    if (cur.dst_nT != null) state.dst_index = cur.dst_nT;
}

// ── T3 fetchers ───────────────────────────────────────────────────────────────

async function fetchFlares(state) {
    const json = await fetchEdge(API.flares);
    const list = json?.data?.flares;
    if (!Array.isArray(list)) { state.recent_flares = []; return; }

    const parsed = list
        .map(f => ({
            time:     new Date(f.peak_time ?? f.begin_time ?? 0),
            cls:      f.flare_class ?? null,
            location: f.location    ?? null,
            parsed:   parseFlareClass(f.flare_class),
        }))
        .filter(f => f.cls)
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
    const json = await fetchEdge(API.regions);
    const list = json?.data?.regions;
    if (!Array.isArray(list)) { state.active_regions = []; return; }
    state.active_regions = list.slice(0, 5).map(r => ({
        region:     r.region,
        lat_deg:    r.latitude_deg      ?? 0,
        lon_deg:    r.carrington_lon_deg ?? 0,
        lat_rad:    (r.latitude_deg      ?? 0) * Math.PI / 180,
        lon_rad:    (r.carrington_lon_deg ?? 0) * Math.PI / 180,
        area_norm:  Math.min((r.area ?? 20) / 400, 1.0),
        mag_class:  r.mag_class ?? '',
        is_complex: (r.mag_class ?? '').includes('amma'),
        num_spots:  r.num_spots ?? 1,
    }));
}

async function fetchDONKICME(state) {
    const json = await fetchEdge(API.donkiCME);
    const list = json?.data?.cmes;
    if (!Array.isArray(list)) { state.recent_cmes = []; return; }

    const now    = Date.now();
    const parsed = list.map(c => {
        // Kinematic arrival estimate: distance from 21.5 Rs to Earth ≈ 1.345 × 10⁸ km
        const t21_5      = c.time ? new Date(c.time) : null;
        const speed      = c.speed_km_s ?? 400;
        const etaMs      = t21_5 ? (1.345e8 / Math.max(speed, 50)) * 1e6 : null;
        const arrival    = etaMs ? new Date(t21_5.getTime() + etaMs) : null;
        const hoursUntil = arrival ? (arrival.getTime() - now) / 3.6e6 : null;
        return {
            time:          c.time ?? null,
            speed:         speed,
            latitude:      c.latitude_deg   ?? 0,
            longitude:     c.longitude_deg  ?? 0,
            halfAngle:     c.half_angle_deg ?? 30,
            type:          c.type           ?? 'S',
            earthDirected: c.earth_directed ?? false,
            arrivalTime:   arrival?.toISOString() ?? null,
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

// ── T4 fetchers (PRO only, 60-min cadence) ────────────────────────────────────

async function fetchRadioFlux(state) {
    const json = await fetchEdge(API.radioFlux);
    const cur  = json?.data?.current;
    if (!cur) return;
    if (cur.flux_sfu != null) {
        state.f107_flux          = cur.flux_sfu;
        state.f107_adjusted_sfu  = cur.flux_adjusted_sfu ?? null;
        state.f107_activity      = cur.activity_label    ?? null;
    }
    const trend = json?.data?.trend;
    if (trend) {
        state.f107_slope_sfu_per_day = trend.slope_sfu_per_day ?? null;
        state.f107_trend_direction   = trend.direction          ?? null;
    }
    const recent = json?.data?.recent;
    if (Array.isArray(recent)) state.f107_recent = recent;
}

// ── SpaceWeatherFeed ──────────────────────────────────────────────────────────

export class SpaceWeatherFeed {
    /**
     * @param {object} opts
     * @param {string} opts.tier  TIER.FREE (default) or TIER.PRO
     */
    constructor({ tier = TIER.FREE } = {}) {
        this.tier        = tier;
        this._raw        = { ...FALLBACK };
        this._timers     = {};
        this._stormMode  = false;
        this._calmStreak = 0;
        this.status      = 'connecting';
        this.lastUpdated = null;
        this.failStreak  = 0;
        this._lastFlareKey = null;
        this._lastCmeKey   = null;
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
            fetchKp1m(this._raw),
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
                console.debug(`[SWPC T1] feed ${i}: ${r.reason?.message ?? r.reason}`);
        });
        this._checkStormMode();
        this._dispatch();
    }

    async _runT2() {
        const results = await Promise.allSettled([
            fetchXray(this._raw),
            fetchProtons(this._raw),
            fetchElectrons(this._raw),
            fetchAurora(this._raw),
            fetchAlerts(this._raw),
            fetchDst(this._raw),
        ]);
        results.forEach((r, i) => {
            if (r.status === 'rejected')
                console.debug(`[SWPC T2] feed ${i}: ${r.reason?.message ?? r.reason}`);
        });
        this._dispatch();
    }

    async _runT3() {
        const results = await Promise.allSettled([
            fetchFlares(this._raw),
            fetchRegions(this._raw),
            fetchDONKICME(this._raw),
            fetchDONKINotifications(this._raw),
        ]);
        results.forEach((r, i) => {
            if (r.status === 'rejected')
                console.debug(`[SWPC T3] feed ${i}: ${r.reason?.message ?? r.reason}`);
        });
        this._dispatch();
    }

    /** T4 — PRO only, 60-min cadence. */
    async _runT4() {
        const results = await Promise.allSettled([
            fetchRadioFlux(this._raw),
        ]);
        results.forEach((r, i) => {
            if (r.status === 'rejected')
                console.debug(`[SWPC T4] feed ${i}: ${r.reason?.message ?? r.reason}`);
        });
        this._dispatch();
    }

    _checkStormMode() {
        const raw  = this._raw;
        const trig = STORM_TRIGGERS;
        const active = (
            (raw.kp_1min ?? raw.kp) >= trig.kp_min ||
            raw.flare_letter === trig.xray_letter  ||
            !!raw.earth_directed_cme
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

        // Detect new M/X flare
        const topFlare   = raw.recent_flares[0] ?? null;
        const flareKey   = topFlare ? `${topFlare.cls}|${topFlare.time?.toISOString()}` : null;
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
            recent_flares:  raw.recent_flares  ?? [],
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
            new_cme_detected:    newCme,
            dst_index:           raw.dst_index  ?? -5,
            kp_1min:             raw.kp_1min    ?? raw.kp,
            proton_diff_1mev:    raw.proton_diff_1mev  ?? 0,
            proton_diff_10mev:   raw.proton_diff_10mev ?? 0,
        };
    }
}

export default SpaceWeatherFeed;
