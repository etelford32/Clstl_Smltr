/**
 * ring-current-feed.js — data layer of the Ring Current Simulation
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Assembles the real-time driver series for js/ring-current-model.js and
 * emits fully-computed model state. No THREE / rendering here; parse helpers
 * are pure and exported so node tests can exercise them.
 *
 * ── Sources & cadence (see RING_CURRENT_SIMULATION_PLAN.md §3) ──────────────
 *   full-day RTSW wind+mag  NOAA browser-direct   on start + T3 re-sync
 *   latest-sample append    /api/solar-wind/latest T1 (Supabase cache, 30 s CDN)
 *   observed Kyoto Dst      NOAA browser-direct   T3
 *   Kp (plasmapause)        NOAA browser-direct   T2
 *
 * IMF (bt/bz/bx/by) lives in rtsw_mag_1m.json, NOT in the plasma wind feed —
 * same split js/swpc-feed.js and api/cron/refresh-solar-wind.js handle.
 *
 * Degraded mode: if browser-direct NOAA is unreachable the feed falls back to
 * /api/solar-wind/latest?series=1 (60-min window) + /api/noaa/dst — the model
 * window shrinks but the page stays live. state.window reports which.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   const feed = new RingCurrentFeed();
 *   feed.addEventListener('state', e => render(e.detail));
 *   feed.start();
 */

import { NOAA, INTERVALS } from './config.js';
import {
    integrateDst, integrateDstEnsemble, propagateToEarth, couplingVBs,
    dynamicPressure, dpsEnergyJ, ringPeakL, asymmetry, plasmapauseL,
    stormClass, toDstStar, obmQ, obmTau, skill, findThresholdCrossing, kpToAp,
} from './ring-current-model.js';

// rtsw_mag_1m is not in config.NOAA — defined locally, same as js/swpc-feed.js.
const NOAA_MAG_URL   = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json';
const API_LATEST     = '/api/solar-wind/latest';
const API_DST        = '/api/noaa/dst';

// ── Pure parse helpers (node-testable) ───────────────────────────────────────

/** NOAA fill sentinels → null; numbers otherwise. */
export function noaaNum(raw) {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    if (n <= -9990 || n > 1e20) return null;
    return n;
}

/** "YYYY-MM-DD HH:MM:SS(.ms)" (no tz) → epoch ms, or null. */
export function noaaTimeMs(tag) {
    if (!tag) return null;
    const ms = Date.parse(String(tag).replace(' ', 'T').replace(/Z?$/, 'Z'));
    return Number.isFinite(ms) ? ms : null;
}

const minuteKey = ms => Math.floor(ms / 60_000) * 60_000;

/**
 * Merge RTSW plasma rows and mag rows into one ascending 1-min driver series
 * [{t, v, n, temp, bz, bt}]. Rows join on their UTC minute; plasma-only
 * minutes keep bz = null (the model holds the last valid driver across gaps).
 */
export function mergeDriverSeries(windRows, magRows) {
    const byMin = new Map();
    for (const r of Array.isArray(windRows) ? windRows : []) {
        const t = noaaTimeMs(r?.time_tag);
        if (t == null) continue;
        const v = noaaNum(r.proton_speed ?? r.speed);
        if (v == null || v <= 0) continue;
        byMin.set(minuteKey(t), {
            t: minuteKey(t),
            v,
            n:    noaaNum(r.proton_density ?? r.density),
            temp: noaaNum(r.proton_temperature ?? r.temperature),
            bz: null, bt: null, bx: null, by: null,
        });
    }
    for (const r of Array.isArray(magRows) ? magRows : []) {
        const t = noaaTimeMs(r?.time_tag);
        if (t == null) continue;
        const row = byMin.get(minuteKey(t));
        if (!row) continue;
        row.bz = noaaNum(r.bz_gsm ?? r.bz ?? r.bz_gse);
        row.bt = noaaNum(r.bt);
        row.bx = noaaNum(r.bx_gsm ?? r.bx);
        row.by = noaaNum(r.by_gsm ?? r.by);   // Newell coupling needs By
    }
    return [...byMin.values()].sort((a, b) => a.t - b.t);
}

/**
 * kyoto-dst.json → ascending [{t, dst}]. NOAA ships either object rows or a
 * 2-D array with a header row — handle both (mirrors api/noaa/dst.js).
 */
export function parseKyotoDst(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const fill = v => {
        const n = noaaNum(v);
        return n == null || Math.abs(n) > 1000 ? null : n;
    };
    let rows;
    if (typeof raw[0] === 'object' && !Array.isArray(raw[0])) {
        rows = raw.map(r => ({ t: noaaTimeMs(r?.time_tag), dst: fill(r?.dst ?? r?.dst_index) }));
    } else {
        const head = raw[0].map(String);
        const ti = head.indexOf('time_tag'), di = head.indexOf('dst');
        rows = raw.slice(1).map(r => ({ t: noaaTimeMs(r[ti]), dst: fill(r[di]) }));
    }
    return rows.filter(r => r.t != null && r.dst != null).sort((a, b) => a.t - b.t);
}

/** planetary_k_index_1m.json → latest finite Kp, or null. */
export function parseLatestKp(raw) {
    if (!Array.isArray(raw)) return null;
    for (let i = raw.length - 1; i >= 0; i--) {
        const kp = noaaNum(raw[i]?.estimated_kp ?? raw[i]?.kp_index ?? raw[i]?.kp);
        if (kp != null && kp >= 0 && kp <= 9) return kp;
    }
    return null;
}

/** Linear interpolation of the observed Dst series at time t (ms). */
export function observedDstAt(series, t) {
    if (!Array.isArray(series) || !series.length) return null;
    if (t <= series[0].t) return series[0].dst;
    for (let i = 1; i < series.length; i++) {
        if (series[i].t >= t) {
            const a = series[i - 1], b = series[i];
            const f = (t - a.t) / Math.max(1, b.t - a.t);
            return a.dst + f * (b.dst - a.dst);
        }
    }
    return series[series.length - 1].dst;
}

/**
 * Run the full model pipeline from raw ingredients. Pure — exported for
 * node tests and for hindcast reuse.
 *
 * @returns {object|null} state (see emit shape below) or null if inputs
 *          are insufficient to anchor the model.
 */
export function computeState(driverSeries, observedDst, kp, nowMs, f107 = null) {
    if (!driverSeries?.length || !observedDst?.length) return null;

    // Earth-arrival time base: the trailing samples haven't arrived yet —
    // they ARE the forecast window.
    const propagated = propagateToEarth(driverSeries)
        .map(s => ({ t: s.tArrive, tL1: s.t, v: s.v, n: s.n, bz: s.bz, bt: s.bt, temp: s.temp }));

    const dst0 = observedDstAt(observedDst, propagated[0].t);
    if (!Number.isFinite(dst0)) return null;

    // Anchor ONCE at window start, then free-run (skill would be fake
    // otherwise). The ensemble adds the (a, τ) parameter-sensitivity band
    // operators need for conjunction work (see RING_CURRENT_USER_RESEARCH.md).
    const { central: track, band } = integrateDstEnsemble(propagated, dst0);
    if (!track.length) return null;

    const arrived  = track.filter(p => p.t <= nowMs);
    const forecast = track.filter(p => p.t > nowMs);
    const nowPt    = arrived.length ? arrived[arrived.length - 1] : track[0];

    const obsWindow = observedDst.filter(o => o.t >= propagated[0].t - 30 * 60_000);
    const modelSkill = skill(arrived, obsWindow);

    // The Sun→Earth bridge: parcels measured at L1 that have NOT yet arrived.
    // These are real matter in transit — the physical content of the forecast
    // window, rendered as the incoming stream on the 3D twin.
    const parcels = propagated
        .filter(p => p.t > nowMs)
        .map(p => ({ tArrive: p.t, tL1: p.tL1, v: p.v, n: p.n, bz: p.bz, bt: p.bt, temp: p.temp }));
    let strongest = null;
    for (const p of parcels) {
        const pv = couplingVBs(p.v, p.bz);
        if (pv != null && (!strongest || pv > strongest.vbs)) {
            strongest = { vbs: pv, bz: p.bz, v: p.v, etaMin: Math.round((p.tArrive - nowMs) / 60_000) };
        }
    }

    const obsNow  = observedDst[observedDst.length - 1];
    const asym    = asymmetry(nowPt.vbs);

    return {
        updated: nowMs,
        window:  { startMs: propagated[0].t, endMs: track[track.length - 1].t },
        drivers: {
            v:  latestValid(driverSeries, 'v'),
            n:  latestValid(driverSeries, 'n'),
            bz: latestValid(driverSeries, 'bz'),
            bt: latestValid(driverSeries, 'bt'),
            by: latestValid(driverSeries, 'by'),
            vbs:  nowPt.vbs,
            pdyn: nowPt.pdyn,
        },
        now: {
            dstModel:     nowPt.dst,
            dstStarModel: nowPt.dstStar,
            dstObserved:  obsNow?.dst ?? null,
            dstObservedAt: obsNow?.t ?? null,
            energyJ:      dpsEnergyJ(nowPt.dstStar),
            injectionQ:   nowPt.q,
            tauHours:     nowPt.tau,
            decayRate:    nowPt.tau > 0 ? -nowPt.dstStar / nowPt.tau : 0,
            storm:        stormClass(obsNow?.dst ?? nowPt.dst),
            stormModel:   stormClass(nowPt.dst),
            peakL:        ringPeakL(nowPt.dstStar),
            asymmetry:    asym,
            plasmapauseL: plasmapauseL(kp),
            kp,
            apNow:        kpToAp(kp),
            f107,
        },
        // Predictive alert: first forecast crossing of the next storm-class
        // threshold — genuine lead time (the driver is already measured at L1).
        alert: (() => {
            const x = findThresholdCrossing(nowPt.dst, forecast);
            return x ? { ...x, etaMin: Math.round((x.t - nowMs) / 60_000) } : null;
        })(),
        series: {
            model:    arrived.map(p => ({ t: p.t, dst: p.dst, dstStar: p.dstStar })),
            forecast: forecast.map(p => ({ t: p.t, dst: p.dst, dstStar: p.dstStar })),
            observed: obsWindow,
            // Parameter-sensitivity band, forecast window + trailing 3 h.
            band: band.filter(b => b.t > nowMs - 3 * 3.6e6),
        },
        skill: modelSkill,
        transit: { parcels, strongest },
        forecastLeadMin: forecast.length
            ? Math.round((forecast[forecast.length - 1].t - nowMs) / 60_000)
            : 0,
    };
}

/**
 * /api/omni/imf columnar payload → replay ingredients for historical event
 * hindcasts (e.g. the May 2024 Gannon G5). SYM-H is the 1-min-resolution
 * equivalent of Dst, so it slots directly into the observed series.
 * Pure — node-tested; the page's replay mode is just
 * computeState(drivers, observed, kp, endMs) over this output.
 *
 * @returns {{drivers: Array<{t,v,n,bz}>, observed: Array<{t,dst}>} | null}
 */
export function omniToReplay(payload) {
    const d = payload?.data;
    if (!Array.isArray(d?.t) || !d.t.length) return null;
    const drivers = [], observed = [];
    for (let i = 0; i < d.t.length; i++) {
        const t = Date.parse(d.t[i]);
        if (!Number.isFinite(t)) continue;
        const v = Number(d.v?.[i]), n = Number(d.np?.[i]), bz = Number(d.bz_gsm?.[i]);
        if (Number.isFinite(v) && v > 100 && v < 3000) {
            drivers.push({
                t, v,
                n:  Number.isFinite(n)  ? n  : null,
                bz: Number.isFinite(bz) ? bz : null,
            });
        }
        const sym = Number(d.sym_h?.[i]);
        if (Number.isFinite(sym) && Math.abs(sym) < 1000) observed.push({ t, dst: sym });
    }
    return drivers.length && observed.length ? { drivers, observed } : null;
}

/**
 * Historical-event hindcast state (e.g. Gannon May 2024). Unlike live
 * computeState this does NOT ballistically propagate: OMNI HRO drivers are
 * already time-shifted to the bow shock nose, so re-propagating would
 * double-shift by ~40–60 min. Anchors once on the first observed value,
 * free-runs the ensemble, scores against the full observed series.
 */
export function computeReplayState(drivers, observed, label = 'replay') {
    if (!drivers?.length || !observed?.length) return null;
    const dst0 = observedDstAt(observed, drivers[0].t);
    const { central: track, band } = integrateDstEnsemble(drivers, dst0);
    if (!track.length) return null;
    let peak = track[0];
    for (const p of track) if (p.dst < peak.dst) peak = p;
    let obsPeak = observed[0];
    for (const o of observed) if (o.dst < obsPeak.dst) obsPeak = o;
    return {
        label,
        updated: track[track.length - 1].t,
        window:  { startMs: track[0].t, endMs: track[track.length - 1].t },
        series: {
            model:    track.map(p => ({ t: p.t, dst: p.dst, dstStar: p.dstStar })),
            forecast: [],
            observed,
            band,
        },
        skill: skill(track, observed),
        peak: { model: { t: peak.t, dst: peak.dst }, observed: { t: obsPeak.t, dst: obsPeak.dst } },
    };
}

function latestValid(series, field) {
    for (let i = series.length - 1; i >= 0; i--) {
        const x = series[i][field];
        if (Number.isFinite(x)) return x;
    }
    return null;
}

// ── Live feed ────────────────────────────────────────────────────────────────

async function getJson(url, timeoutMs = 15_000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

export class RingCurrentFeed extends EventTarget {
    constructor() {
        super();
        this._drivers  = [];      // merged 1-min series (L1 time base)
        this._observed = [];      // [{t, dst}]
        this._kp       = null;
        this._f107     = null;    // daily F10.7 (sfu) for the density panel
        this._timers   = {};
        this._mode     = 'full';  // 'full' | 'degraded'
        this._started  = false;
        this._errors   = [];
    }

    async start() {
        if (this._started) return;
        this._started = true;

        await this._fullSync();

        this._timers.t1 = setInterval(() => this._tick(() => this._appendLatest()), INTERVALS.T1);
        this._timers.t2 = setInterval(() => this._tick(() => this._refreshKp()),    INTERVALS.T2);
        this._timers.t3 = setInterval(() => this._tick(() => this._fullSync()),     INTERVALS.T3);

        // API hygiene: no polling while the tab is hidden; catch up on return.
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) this._tick(() => this._fullSync());
            });
        }
    }

    stop() {
        for (const t of Object.values(this._timers)) clearInterval(t);
        this._timers = {};
        this._started = false;
    }

    async _tick(fn) {
        if (typeof document !== 'undefined' && document.hidden) return;
        try { await fn(); } catch (e) { this._noteError(e); }
    }

    _noteError(e) {
        this._errors.push({ t: Date.now(), message: String(e?.message || e) });
        if (this._errors.length > 20) this._errors.shift();
    }

    /** Full re-sync: 24 h RTSW wind+mag + Kyoto Dst (+Kp on first run). */
    async _fullSync() {
        let windRows = null, magRows = null;
        try {
            [windRows, magRows] = await Promise.all([
                getJson(NOAA.wind),
                getJson(NOAA_MAG_URL).catch(e => { this._noteError(e); return []; }),
            ]);
        } catch (e) {
            this._noteError(e);
        }

        if (Array.isArray(windRows) && windRows.length) {
            this._drivers = mergeDriverSeries(windRows, magRows);
            this._mode = 'full';
        } else {
            // Degraded: 60-min window from the Supabase cache.
            try {
                const alt = await getJson(`${API_LATEST}?series=1`);
                const series = alt?.data?.series || [];
                this._drivers = series.map(r => ({
                    t: Date.parse(r.timestamp),
                    v: r.speed_km_s, n: r.density_cc, bz: r.bz_nT, bt: r.bt_nT, temp: null,
                })).filter(r => Number.isFinite(r.t) && Number.isFinite(r.v))
                  .sort((a, b) => a.t - b.t);
                this._mode = 'degraded';
            } catch (e) {
                this._noteError(e);
            }
        }

        try {
            this._observed = parseKyotoDst(await getJson(NOAA.dst));
        } catch (e) {
            this._noteError(e);
            // Degraded: recent readings via the edge proxy.
            try {
                const alt = await getJson(API_DST);
                this._observed = (alt?.data?.recent || []).map(r => ({
                    t: Date.parse(r.timestamp), dst: r.dst_nT,
                })).filter(r => Number.isFinite(r.t) && Number.isFinite(r.dst));
            } catch (e2) { this._noteError(e2); }
        }

        if (this._kp == null) await this._refreshKp().catch(e => this._noteError(e));

        // F10.7 (daily cadence — T3 refresh is generous) via our own
        // normalized edge endpoint; drives the thermosphere density panel.
        try {
            const rf = await getJson('/api/noaa/radio-flux');
            const sfu = rf?.data?.current?.flux_sfu;
            if (Number.isFinite(sfu) && sfu > 40 && sfu < 500) this._f107 = sfu;
        } catch (e) { this._noteError(e); }

        this._emit();
    }

    /** T1 append: one cached row from the Supabase-backed edge endpoint. */
    async _appendLatest() {
        const body = await getJson(API_LATEST);
        const cur = body?.data?.current;
        const t = Date.parse(body?.data?.updated || '');
        if (!cur || !Number.isFinite(t) || !Number.isFinite(cur.speed_km_s)) return;
        const key = minuteKey(t);
        const row = {
            t: key, v: cur.speed_km_s, n: cur.density_cc ?? null,
            bz: cur.bz_nT ?? null, bt: cur.bt_nT ?? null,
            bx: cur.bx_nT ?? null, by: cur.by_nT ?? null,
            temp: cur.temperature_K ?? null,
        };
        const last = this._drivers[this._drivers.length - 1];
        if (last && last.t === key) this._drivers[this._drivers.length - 1] = row;
        else if (!last || key > last.t) this._drivers.push(row);
        this._emit();
    }

    async _refreshKp() {
        this._kp = parseLatestKp(await getJson(NOAA.kp1m));
    }

    _emit() {
        const state = computeState(this._drivers, this._observed, this._kp, Date.now(), this._f107);
        this.dispatchEvent(new CustomEvent('state', {
            detail: state ? { ...state, mode: this._mode, errors: this._errors.slice(-3) }
                          : { mode: this._mode, errors: this._errors.slice(-3), updated: Date.now() },
        }));
    }
}
