/**
 * sync-dataset-core.js — pure logic for the SYNCHRONIZED solar-wind ↔
 * geomagnetic minute dataset (public.sw_geomag_dataset).
 *
 * One row per UTC minute: L1 plasma/IMF alongside Kp, ap, Dst and the GOES
 * ≥2 MeV electron flux — each signal carrying its OWN native timestamp,
 * source tag, and an explicit flag. Absence is recorded, never implied:
 * a minute with no data still gets a row, flagged 'gap'.
 *
 * Pure and dependency-light (model + the tested feed helpers only) —
 * tests/sync-dataset-core.mjs runs this exact module under node; the
 * cron (api/cron/sync-dataset.js) and the read endpoint
 * (api/ring-current/dataset.js) both import from here so the dataset
 * semantics cannot fork between writer and reader.
 *
 * ── Flag semantics (documented once, enforced here) ─────────────────────────
 * sw_flag:  'ok'        plasma (speed) present for this minute
 *           'mag_only'  IMF present, plasma missing (Bz keeps flowing
 *                       through plasma outages — same rule as the live page)
 *           'gap'       no L1 data for this minute
 * kp/ap/dst/e2 *_flag:
 *           'ok'        the covering native sample is within its cadence
 *                       window (FRESH_WINDOWS_MIN)
 *           'held'      value carried from an older sample — still recorded,
 *                       with the native *_t timestamp making the hold
 *                       distance explicit — up to HOLD_LIMITS_MIN
 *           'gap'       nothing within the hold limit → value is null
 *
 * ── Provenance ──────────────────────────────────────────────────────────────
 * Every value column travels with *_t (native sample time), *_source (feed
 * identity). ap is DERIVED — kpToAp() over the definitive 3-hour planetary
 * Kp — and its source string says exactly that; derived quantities are
 * never dressed up as measurements.
 */

import { kpToAp } from '../../js/ring-current-model.js';

export const MINUTE_MS = 60_000;

/** Inside these windows a covering sample is 'ok' (native cadences). */
export const FRESH_WINDOWS_MIN = Object.freeze({
    kp: 5,      // estimated planetary Kp, 1-min product
    ap: 180,    // 3-hour blocks — a block covers its own 180 min
    dst: 60,    // Kyoto quicklook Dst, hourly
    e2: 10,     // GOES integral electrons, 5-min cadence
});

/** Beyond these holds a signal is declared 'gap' (value null). */
export const HOLD_LIMITS_MIN = Object.freeze({
    kp: 180,
    ap: 300,    // one extra block + an hour: 3-h product posts late routinely
    dst: 360,   // quicklook can lag hours before Kyoto posts the next value
    e2: 60,
});

export const SOURCES = Object.freeze({
    kp:  'noaa-swpc estimated-kp-1m',
    ap:  'derived: kpToAp(noaa-swpc planetary-k-3h)',
    dst: 'kyoto-wdc quicklook (via noaa-swpc)',
    e2:  'noaa-swpc goes-primary integral-electrons >=2 MeV',
});

const num = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
};
const normTime = (t) => String(t || '').replace(' ', 'T').replace(/Z?$/, 'Z');
export const minuteKey = (ms) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

// ── Parsers (each → ascending [{t, value}] with fills dropped) ──────────────

/** planetary_k_index_1m.json → [{t, kp}] (estimated Kp, minute cadence). */
export function parseKp1m(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const r of raw) {
        const t = Date.parse(normTime(r?.time_tag));
        const kp = num(r?.estimated_kp ?? r?.kp_index ?? r?.kp);
        if (!Number.isFinite(t) || kp == null || kp < 0 || kp > 9) continue;
        out.push({ t, kp });
    }
    return out.sort((a, b) => a.t - b.t);
}

/** products/noaa-planetary-k-index.json ([[header],[rows…]]) → [{t, kp}]
 *  where t is the 3-hour block START. Object-row form also accepted. */
export function parseKp3h(raw) {
    if (!Array.isArray(raw) || !raw.length) return [];
    let rows;
    if (Array.isArray(raw[0])) {
        const head = raw[0].map(String);
        const ti = head.indexOf('time_tag');
        const ki = head.findIndex(h => /^kp$/i.test(h));
        if (ti < 0 || ki < 0) return [];
        rows = raw.slice(1).map(r => ({ t: Date.parse(normTime(r?.[ti])), kp: num(r?.[ki]) }));
    } else {
        rows = raw.map(r => ({ t: Date.parse(normTime(r?.time_tag)), kp: num(r?.kp ?? r?.Kp) }));
    }
    return rows
        .filter(r => Number.isFinite(r.t) && r.kp != null && r.kp >= 0 && r.kp <= 9)
        .sort((a, b) => a.t - b.t);
}

/** goes/primary/integral-electrons-*.json → [{t, flux}] for one energy
 *  channel (default ≥2 MeV). Negative/fill flux dropped. */
export function parseGoesElectrons(raw, energyRe = />=\s*2(\.0)?\s*MeV/) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const r of raw) {
        if (!energyRe.test(String(r?.energy ?? ''))) continue;
        const t = Date.parse(normTime(r?.time_tag));
        const flux = num(r?.flux);
        if (!Number.isFinite(t) || flux == null || flux < 0) continue;
        out.push({ t, flux });
    }
    return out.sort((a, b) => a.t - b.t);
}

/** Newest series entry with t ≤ atMs (series ascending), or null. */
export function latestAtOrBefore(series, atMs) {
    let best = null;
    for (const r of series) {
        if (r.t > atMs) break;
        best = r;
    }
    return best;
}

/** value+flag+provenance for one signal at one minute — the flag policy. */
function signalAt(series, key, atMs, valueKey) {
    const s = latestAtOrBefore(series, atMs);
    if (!s) return { value: null, t: null, source: null, flag: 'gap' };
    const ageMin = (atMs - s.t) / MINUTE_MS;
    if (ageMin > HOLD_LIMITS_MIN[key]) {
        return { value: null, t: null, source: null, flag: 'gap' };
    }
    return {
        value: s[valueKey],
        t: new Date(s.t).toISOString(),
        source: SOURCES[key],
        flag: ageMin <= FRESH_WINDOWS_MIN[key] ? 'ok' : 'held',
    };
}

/**
 * Build the synchronized minute rows for [t0Ms, t1Ms) — the writer's core.
 *
 * @param {object} src
 * @param {Array}  src.sw    mergeMinuteSeries() output (refresh-solar-wind):
 *                           [{t, v, n, temp, bt, bz, bx, by}] ascending
 * @param {string} src.swSource  feed tag for the L1 rows ('rtsw', …)
 * @param {Array}  src.dst   parseKyotoHourly() output [{t, dst}]
 * @param {Array}  src.kp1m  parseKp1m() output
 * @param {Array}  src.kp3h  parseKp3h() output
 * @param {Array}  src.e2    parseGoesElectrons() output
 * @returns rows matching sw_geomag_dataset columns (t ISO, ascending)
 */
export function buildMinuteRows(t0Ms, t1Ms, src) {
    const swByMin = new Map((src.sw ?? []).map(r => [minuteKey(r.t), r]));
    const dst = (src.dst ?? []).map(r => ({ t: r.t, dst: r.dst }));
    const ap3h = (src.kp3h ?? []).map(r => ({ t: r.t, ap: kpToAp(r.kp) }));
    const rows = [];
    for (let m = minuteKey(t0Ms); m < t1Ms; m += MINUTE_MS) {
        const s = swByMin.get(m);
        const swFlag = !s ? 'gap' : (s.v != null ? 'ok' : ((s.bz != null || s.bt != null) ? 'mag_only' : 'gap'));
        const kp = signalAt(src.kp1m ?? [], 'kp', m, 'kp');
        const ap = signalAt(ap3h, 'ap', m, 'ap');
        const ds = signalAt(dst, 'dst', m, 'dst');
        const e2 = signalAt(src.e2 ?? [], 'e2', m, 'flux');
        rows.push({
            t: new Date(m).toISOString(),
            sw_v_km_s:  s?.v ?? null,
            sw_n_cc:    s?.n ?? null,
            sw_temp_k:  s?.temp ?? null,
            sw_bt_nt:   s?.bt ?? null,
            sw_bz_nt:   s?.bz ?? null,
            sw_bx_nt:   s?.bx ?? null,
            sw_by_nt:   s?.by ?? null,
            sw_source:  swFlag === 'gap' ? null : (src.swSource ?? 'rtsw'),
            sw_flag:    swFlag,
            kp:         kp.value,  kp_t: kp.t,   kp_source: kp.source,  kp_flag: kp.flag,
            ap:         ap.value,  ap_t: ap.t,   ap_source: ap.source,  ap_flag: ap.flag,
            dst_nt:     ds.value,  dst_t: ds.t,  dst_source: ds.source, dst_flag: ds.flag,
            e2_flux_pfu: e2.value, e2_t: e2.t,   e2_source: e2.source,  e2_flag: e2.flag,
        });
    }
    return rows;
}

/** Per-signal flag counts — the dataset's own honesty summary. */
export function gapSummary(rows) {
    const mk = () => ({ ok: 0, held: 0, mag_only: 0, gap: 0 });
    const out = { sw: mk(), kp: mk(), ap: mk(), dst: mk(), e2: mk(), minutes: rows.length };
    for (const r of rows) {
        out.sw[r.sw_flag]++;
        out.kp[r.kp_flag]++;
        out.ap[r.ap_flag]++;
        out.dst[r.dst_flag]++;
        out.e2[r.e2_flag]++;
    }
    return out;
}

/** Columns in canonical order — shared by the CSV writer and the endpoint. */
export const DATASET_COLUMNS = Object.freeze([
    't',
    'sw_v_km_s', 'sw_n_cc', 'sw_temp_k', 'sw_bt_nt', 'sw_bz_nt', 'sw_bx_nt', 'sw_by_nt',
    'sw_source', 'sw_flag',
    'kp', 'kp_t', 'kp_source', 'kp_flag',
    'ap', 'ap_t', 'ap_source', 'ap_flag',
    'dst_nt', 'dst_t', 'dst_source', 'dst_flag',
    'e2_flux_pfu', 'e2_t', 'e2_source', 'e2_flag',
]);

/** Rows → CSV (RFC-ish: quote only when needed; nulls are empty cells). */
export function toCsv(rows) {
    const cell = (v) => {
        if (v == null) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [DATASET_COLUMNS.join(',')];
    for (const r of rows) lines.push(DATASET_COLUMNS.map(c => cell(r[c])).join(','));
    return lines.join('\n') + '\n';
}
