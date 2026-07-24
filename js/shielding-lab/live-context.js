/**
 * live-context.js — observed geomagnetic context for the Shielding Lab
 * LIVE readout (Phase 2 of live mode).
 *
 * Two small feeds ride alongside the solar-wind driver, at the site's T2
 * cadence (5 min — js/config.js INTERVALS), fetched with the same
 * direct-then-passthrough pattern as live-driver.js:
 *
 *   Kp (1-min estimated)  json/planetary_k_index_1m.json
 *     — object rows {time_tag, estimated_kp, kp_index, kp}; newest valid
 *       wins (js/swpc-feed.js fetchKp1m convention).
 *   Dst (Kyoto quicklook) products/kyoto-dst.json
 *     — object rows or [header, rows]; time_tag/dst by NAME, |dst|>1000
 *       is fill (js/ring-current-feed.js parseKyotoDst convention).
 *
 * These are CONTEXT, not drivers: nothing here feeds the solver. They
 * answer the operator's "does the real magnetosphere agree?" glance —
 * current Kp with its G-scale label, Dst with a storm-phase word, and a
 * trailing Dst series for the readout chart.
 *
 * Also here: the Boyle et al. (1997) empirical CPCP,
 *   Φ_PC [kV] = 1e-4·v² + 11.7·B_T·sin³(θ_c/2),
 * computed from the SAME live drivers the solver eats. It is the page's
 * validation-table anchor; in LIVE mode it rides the CPCP chart as the
 * dashed reference so solved-vs-empirical divergence is visible live.
 * (Boyle has no saturation — expect it to overshoot in big storms; that
 * gap IS the teaching point, not an error.)
 *
 * Pure parsing/formula pieces are Node-tested by
 * tests/shielding-live-context.mjs.
 */

export const KP_PATH = 'json/planetary_k_index_1m.json';
export const DST_PATH = 'products/kyoto-dst.json';
const SWPC_BASE = 'https://services.swpc.noaa.gov/';
export const CONTEXT_POLL_MS = 5 * 60_000;   // T2 cadence
const DST_WINDOW_MS = 24 * 3600_000;

const normTime = (t) => Date.parse(String(t || '').replace(' ', 'T').replace(/Z?$/, 'Z'));
const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/** Newest valid Kp from the 1-min product (object rows). */
export function parseKp1m(raw) {
    if (!Array.isArray(raw)) return null;
    for (let i = raw.length - 1; i >= 0; i--) {
        const r = raw[i];
        const kp = num(r?.estimated_kp ?? r?.kp_index ?? r?.kp);
        if (kp == null || kp < 0 || kp > 9.5) continue;
        const t = normTime(r?.time_tag);
        return { t: Number.isFinite(t) ? t : null, kp };
    }
    return null;
}

/** Kyoto Dst quicklook → ascending [{t, dst}] (fills dropped, |dst|>1000 = fill). */
export function parseKyotoDst(raw) {
    if (!Array.isArray(raw) || !raw.length) return [];
    const fill = (v) => {
        const n = num(v);
        return n == null || Math.abs(n) > 1000 ? null : n;
    };
    let rows;
    if (typeof raw[0] === 'object' && !Array.isArray(raw[0])) {
        rows = raw.map((r) => ({ t: normTime(r?.time_tag), dst: fill(r?.dst ?? r?.dst_index) }));
    } else {
        const head = raw[0].map((h) => String(h).trim().toLowerCase());
        const ti = head.indexOf('time_tag'), di = head.indexOf('dst');
        if (ti < 0 || di < 0) return [];
        rows = raw.slice(1).map((r) => ({ t: normTime(r[ti]), dst: fill(r[di]) }));
    }
    return rows
        .filter((r) => Number.isFinite(r.t) && r.dst != null)
        .sort((a, b) => a.t - b.t);
}

/** NOAA G-scale label for a Kp value ('' below G1). */
export function gScale(kp) {
    if (kp >= 9) return 'G5';
    if (kp >= 8) return 'G4';
    if (kp >= 7) return 'G3';
    if (kp >= 6) return 'G2';
    if (kp >= 5) return 'G1';
    return '';
}

/** Conventional Dst storm-phase word. */
export function stormPhaseFromDst(dst) {
    if (dst == null) return null;
    if (dst <= -100) return 'intense storm';
    if (dst <= -50) return 'storm';
    if (dst <= -30) return 'unsettled';
    return 'quiet';
}

/**
 * Boyle et al. (1997) empirical polar-cap potential, kV:
 *   Φ = 1e-4·v² + 11.7·B_T·sin³(θ_c/2)   (v km/s, B nT)
 * sin²(θc/2) = (1 − Bz/B_T)/2, the same clock-angle identity as
 * fac.rs::kan_lee_mvpm. No saturation — see module header.
 */
export function boyleCpcpKv(bzNt, byNt, vswKms) {
    const bt = Math.hypot(bzNt, byNt);
    const viscous = 1e-4 * vswKms * vswKms;
    if (bt < 1e-9) return viscous;
    const sin2Half = 0.5 * (1 - bzNt / bt);
    return viscous + 11.7 * bt * Math.pow(sin2Half, 1.5);
}

/** Poller for the two context feeds. Same DI seams as LiveDriver. */
export class LiveContext {
    constructor({ fetchFn, nowFn, schedule, cancel } = {}) {
        this._fetch = fetchFn || ((...a) => fetch(...a));
        this._now = nowFn || (() => Date.now());
        this._schedule = schedule || ((fn, ms) => setTimeout(fn, ms));
        this._cancel = cancel || ((id) => clearTimeout(id));
        this.kp = null;          // {t, kp} | null
        this.dstSeries = [];     // trailing 24 h [{t, dst}]
        this._timer = null;
        this._running = false;
    }

    get dst() {
        return this.dstSeries.length ? this.dstSeries[this.dstSeries.length - 1] : null;
    }

    start() {
        if (this._running) return;
        this._running = true;
        this._pollOnce();
    }

    stop() {
        this._running = false;
        if (this._timer) this._cancel(this._timer);
        this._timer = null;
    }

    async _getJson(path) {
        try {
            const res = await this._fetch(`${SWPC_BASE}${path}`, { cache: 'no-cache' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch {
            const res = await this._fetch(`/api/noaa/passthrough?path=${encodeURIComponent(path)}`, {
                cache: 'no-cache',
            });
            if (!res.ok) throw new Error(`mirror HTTP ${res.status}`);
            return await res.json();
        }
    }

    async _pollOnce() {
        if (!this._running) return;
        // Independent best-effort: one dead feed must not blank the other.
        try { this.kp = parseKp1m(await this._getJson(KP_PATH)) ?? this.kp; }
        catch { /* keep last */ }
        try {
            const series = parseKyotoDst(await this._getJson(DST_PATH));
            if (series.length) {
                const cutoff = this._now() - DST_WINDOW_MS;
                this.dstSeries = series.filter((r) => r.t >= cutoff);
            }
        } catch { /* keep last */ }
        const jitter = (Math.random() * 2 - 1) * 10_000;
        this._timer = this._schedule(() => this._pollOnce(), CONTEXT_POLL_MS + jitter);
    }
}
