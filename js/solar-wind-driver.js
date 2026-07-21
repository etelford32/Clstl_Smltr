/**
 * solar-wind-driver.js — the UNIVERSAL solar-wind driver contract (Phase 0 of
 * the Flux Rope Simulator plan — see FLUX_ROPE_SIMULATOR_PLAN.md §3).
 *
 * One schema, every sim: a driver is a time-ordered stream of samples
 *
 *   { t, n, v, bx, by, bz, pdyn, source, confidence? }
 *
 *   t          epoch milliseconds (UTC)
 *   n          proton density   [cm^-3]        (NaN when unknown)
 *   v          bulk speed       [km/s]         (NaN when unknown)
 *   bx/by/bz   IMF components   [nT]           (frame recorded in meta)
 *   pdyn       dynamic pressure [nPa]          (derived from n,v if absent)
 *   source     'observed' | 'forecast' | 'hindcast' | 'synthetic'
 *   confidence optional 0..1 (ensembles attach spread elsewhere; this is a
 *              per-sample weight for blending observed→forecast handoffs)
 *
 * Consumers (ring-current, Shielding Lab E-field, EarthView outlook, the
 * space-weather dashboard, AurOracle) receive a SolarWindDriver and MUST NOT
 * care which source produced it — that indifference is what makes forecast /
 * hindcast / what-if modes free on every page that adopts the contract.
 *
 * Pure module: no DOM, no fetch, no ambient time. Unit-tested by
 * tests/solar-wind-driver.mjs (node).
 */

export const DRIVER_SOURCES = ['observed', 'forecast', 'hindcast', 'synthetic'];

/** Pdyn [nPa] from n [cm^-3] and v [km/s] — protons only, the SWPC convention. */
export function dynamicPressureNPa(n, v) {
    if (!Number.isFinite(n) || !Number.isFinite(v)) return NaN;
    return 1.6726e-6 * n * v * v;
}

function finiteOr(x, fallback) {
    return Number.isFinite(x) ? x : fallback;
}

/**
 * Normalize one raw sample into the contract shape (fills pdyn, coerces
 * non-finite fields to NaN so gaps are explicit, never undefined).
 */
export function normalizeSample(raw, source = 'synthetic') {
    const n = finiteOr(raw.n, NaN);
    const v = finiteOr(raw.v, NaN);
    const s = {
        t: raw.t,
        n, v,
        bx: finiteOr(raw.bx, NaN),
        by: finiteOr(raw.by, NaN),
        bz: finiteOr(raw.bz, NaN),
        pdyn: finiteOr(raw.pdyn, dynamicPressureNPa(n, v)),
        source: DRIVER_SOURCES.includes(raw.source) ? raw.source : source,
    };
    if (Number.isFinite(raw.confidence)) s.confidence = Math.min(1, Math.max(0, raw.confidence));
    return s;
}

/**
 * SolarWindDriver — an immutable, time-sorted sample series with
 * interpolating lookup. `meta.frame` records the IMF frame ('gsm' | 'gse').
 */
export class SolarWindDriver {
    /**
     * @param {Array<object>} samples raw samples (any order; normalized here)
     * @param {object} meta { source?, frame?, label? }
     */
    constructor(samples, meta = {}) {
        const src = DRIVER_SOURCES.includes(meta.source) ? meta.source : 'synthetic';
        this.samples = samples
            .filter((s) => Number.isFinite(s?.t))
            .map((s) => normalizeSample(s, src))
            .sort((a, b) => a.t - b.t);
        this.meta = { frame: 'gsm', source: src, label: '', ...meta };
    }

    get length() { return this.samples.length; }
    get tStart() { return this.length ? this.samples[0].t : NaN; }
    get tEnd() { return this.length ? this.samples[this.length - 1].t : NaN; }

    /**
     * Interpolated sample at epoch-ms `t`. Linear between neighbors, clamped
     * at the ends; NaN channels stay NaN rather than inventing data. Returns
     * null for an empty driver.
     */
    at(t) {
        const ss = this.samples;
        if (!ss.length) return null;
        if (t <= ss[0].t) return { ...ss[0] };
        if (t >= ss[ss.length - 1].t) return { ...ss[ss.length - 1] };
        // Binary search for the bracketing pair.
        let lo = 0, hi = ss.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (ss[mid].t <= t) lo = mid; else hi = mid;
        }
        const a = ss[lo], b = ss[hi];
        const f = (t - a.t) / (b.t - a.t);
        const lerp = (x, y) => (Number.isFinite(x) && Number.isFinite(y)) ? x + (y - x) * f : NaN;
        const out = {
            t,
            n: lerp(a.n, b.n), v: lerp(a.v, b.v),
            bx: lerp(a.bx, b.bx), by: lerp(a.by, b.by), bz: lerp(a.bz, b.bz),
            pdyn: lerp(a.pdyn, b.pdyn),
            source: a.source,
        };
        if (Number.isFinite(a.confidence) || Number.isFinite(b.confidence)) {
            out.confidence = lerp(a.confidence ?? NaN, b.confidence ?? NaN);
        }
        return out;
    }

    /** Uniform resample: n steps from t0 (ms) at dtMs spacing. */
    resample(t0, dtMs, nSteps) {
        const out = new Array(nSteps);
        for (let i = 0; i < nSteps; i++) out[i] = this.at(t0 + i * dtMs);
        return out;
    }

    /**
     * Stitch observed past onto forecast future at `tSplit` (default: end of
     * `this`). The dashboard's "live trace + fan" timeline uses this shape.
     */
    concat(future, tSplit = this.tEnd) {
        const past = this.samples.filter((s) => s.t <= tSplit);
        const next = future.samples.filter((s) => s.t > tSplit);
        return new SolarWindDriver([...past, ...next], {
            ...this.meta,
            label: `${this.meta.label}+${future.meta.label}`.replace(/^\+|\+$/g, ''),
        });
    }
}

/**
 * Build a driver from parallel arrays (the shape the flux-rope kernel and
 * most feed modules already produce).
 */
export function fromArrays({ t, n, v, bx, by, bz }, meta = {}) {
    const len = t.length;
    const samples = new Array(len);
    for (let i = 0; i < len; i++) {
        samples[i] = {
            t: t[i],
            n: n ? n[i] : NaN, v: v ? v[i] : NaN,
            bx: bx ? bx[i] : NaN, by: by ? by[i] : NaN, bz: bz ? bz[i] : NaN,
        };
    }
    return new SolarWindDriver(samples, meta);
}

/**
 * Build an 'hindcast' driver from a pp.hindcast.replay.v1 bundle
 * (data/hindcast/*_replay.json): window.start/end + step_minutes, series
 * bz_nt / v_kms / n_cc. Bz there is GSM per the bundles' series_meta.
 */
export function fromReplayBundle(bundle) {
    if (bundle?.schema !== 'pp.hindcast.replay.v1') {
        throw new Error(`fromReplayBundle: unsupported schema ${bundle?.schema}`);
    }
    const t0 = Date.parse(bundle.window.start);
    const dt = bundle.window.step_minutes * 60_000;
    const bzS = bundle.series.bz_nt || [];
    const vS = bundle.series.v_kms || [];
    const nS = bundle.series.n_cc || [];
    const len = Math.max(bzS.length, vS.length, nS.length);
    const samples = new Array(len);
    for (let i = 0; i < len; i++) {
        samples[i] = { t: t0 + i * dt, n: nS[i], v: vS[i], bx: NaN, by: NaN, bz: bzS[i] };
    }
    return new SolarWindDriver(samples, {
        source: 'hindcast', frame: 'gsm',
        label: bundle.label || bundle.event_id || 'hindcast',
    });
}
