/**
 * Vercel Edge Function: /api/omni/imf
 *
 * Proxies NASA SPDF's OMNI HRO 1-minute solar-wind/IMF data for a
 * requested date window. SPDF is open public data — no API key needed.
 *
 * Source files (one per calendar month, ~25 MB each):
 *   https://spdf.gsfc.nasa.gov/pub/data/omni/high_res_omni/monthly_1min/omni_min{YYYY}{MM}.asc
 *
 * Format spec:
 *   https://omniweb.gsfc.nasa.gov/html/HROdocum.html
 *   Whitespace-separated 46-column fixed-width ASCII record per minute.
 *
 * Query params (both required):
 *   ?start=YYYY-MM-DD    inclusive (UTC)
 *   ?end=YYYY-MM-DD      inclusive (UTC)
 *
 * Optional:
 *   ?step_min=N          downsample to N-minute cadence by step-after
 *                        sampling (default 5; min 1, max 60). 1 = raw.
 *   ?fields=a,b,c        subset of {t,bz_gsm,v,np,pdyn,bx_gsm,by_gsm,
 *                        bz_gse,ae,sym_h}. Default returns the core
 *                        bundle-relevant set.
 *
 * Caps: max window span = 31 days. Historical windows are immutable —
 * 24 h CDN cache; in-flight de-duplication via Vercel's standard SWR.
 *
 * Response shape:
 *   {
 *     source: '...',
 *     data: {
 *       window: { start, end, step_min, n_minutes_total, n_valid },
 *       t:        ['2024-05-08T00:00:00Z', ...],
 *       bz_gsm:   [-3.5, ...],         // nT, GSM, null when sentinel
 *       v:        [420, ...],          // km/s, scalar flow speed
 *       np:       [4.2, ...],          // n/cc
 *       pdyn:     [1.5, ...],          // nPa
 *       bx_gsm, by_gsm, bz_gse, ae, sym_h    (when requested via ?fields)
 *     },
 *     provenance: { source_file_urls: [...], parser_version }
 *   }
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SPDF_BASE       = 'https://spdf.gsfc.nasa.gov/pub/data/omni/high_res_omni/monthly_1min';
const MAX_WINDOW_DAYS = 31;
const DEFAULT_STEP    = 5;
const MAX_STEP        = 60;
const CACHE_TTL       = 86_400;     // 24 h — historical OMNI is immutable
const CACHE_SWR       = 3600;
const FETCH_TIMEOUT_MS = 30_000;    // 25 MB files can take a few seconds on cold edge

// ── OMNI HRO 1-min column map (0-indexed, verified against the public spec) ──
// IMPORTANT: do NOT reuse the indices in scripts/fetch-omni.mjs — those
// were authored against a 26-column synthetic fixture and never validated
// against the real 46-column file. The Bz_GSM that script extracts is
// actually the "Percent interp" column.
const COL = {
    YEAR:   0,
    DOY:    1,
    HOUR:   2,
    MIN:    3,
    // skip 4..12 (spacecraft IDs, point counts, timeshifts)
    B_MAG:  13,
    BX_GSM: 14,   // same in GSE
    BY_GSE: 15,
    BZ_GSE: 16,
    BY_GSM: 17,
    BZ_GSM: 18,
    // skip 19..20 (RMS B)
    V:      21,   // scalar flow speed, km/s
    VX_GSE: 22,
    VY_GSE: 23,
    VZ_GSE: 24,
    NP:     25,
    T_K:    26,
    PDYN:   27,
    E_FIELD:28,
    // skip 29..36 (beta, mach, sc position)
    AE:     37,
    AL:     38,
    AU:     39,
    SYM_D:  40,
    SYM_H:  41,
};

const MIN_COLS = 42;   // anything fewer than this is malformed

// Sentinel (= "missing") thresholds. Real values are STRICTLY below these.
const SENTINEL = {
    B:      9999.0,    // 9999.99 in spec
    V:      9999.0,    // 99999.9 in spec; use lower bound so we catch both
    VCOMP:  9999.0,
    NP:     999.0,
    T:      9.0e6,
    PDYN:   99.0,
    E:      999.0,
    AE:     99990,
    SYM:    99990,
};

function _parseISODate(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(s + 'T00:00:00Z');
    return isNaN(d) ? null : d;
}

function _isoFromDoy(year, doy, hour, minute) {
    // Construct a UTC ISO timestamp from year + DOY + hr + min.
    const jan1 = Date.UTC(year, 0, 1, hour, minute, 0);
    const ms   = jan1 + (doy - 1) * 86_400_000;
    return new Date(ms).toISOString();
}

function _monthsInRange(start, end) {
    const months = [];
    const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const endMonth = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1);
    while (cur.getTime() <= endMonth) {
        months.push({
            year:  cur.getUTCFullYear(),
            month: cur.getUTCMonth() + 1,
        });
        cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
    return months;
}

function _monthURL(year, month) {
    const mm = String(month).padStart(2, '0');
    return `${SPDF_BASE}/omni_min${year}${mm}.asc`;
}

function _nz(v, sentinel) {
    return (Number.isFinite(v) && v < sentinel) ? v : null;
}

/**
 * Parse one OMNI HRO 1-min ASCII line.
 * Returns null on malformed lines (so callers can blindly map+filter).
 */
function parseOmniLine(line) {
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    if (parts.length < MIN_COLS) return null;

    const year = Number(parts[COL.YEAR]);
    const doy  = Number(parts[COL.DOY]);
    const hr   = Number(parts[COL.HOUR]);
    const mn   = Number(parts[COL.MIN]);
    if (!Number.isFinite(year) || year < 1995 || year > 2100) return null;
    if (!Number.isFinite(doy)  || doy  < 1    || doy  > 366)  return null;
    if (!Number.isFinite(hr)   || hr   < 0    || hr   > 23)   return null;
    if (!Number.isFinite(mn)   || mn   < 0    || mn   > 59)   return null;

    return {
        t:      _isoFromDoy(year, doy, hr, mn),
        bz_gsm: _nz(Number(parts[COL.BZ_GSM]), SENTINEL.B),
        v:      _nz(Number(parts[COL.V]),      SENTINEL.V),
        np:     _nz(Number(parts[COL.NP]),     SENTINEL.NP),
        pdyn:   _nz(Number(parts[COL.PDYN]),   SENTINEL.PDYN),
        bx_gsm: _nz(Number(parts[COL.BX_GSM]), SENTINEL.B),
        by_gsm: _nz(Number(parts[COL.BY_GSM]), SENTINEL.B),
        bz_gse: _nz(Number(parts[COL.BZ_GSE]), SENTINEL.B),
        ae:     _nz(Number(parts[COL.AE]),     SENTINEL.AE),
        sym_h:  _nz(Number(parts[COL.SYM_H]),  SENTINEL.SYM),
    };
}

const DEFAULT_FIELDS = ['t', 'bz_gsm', 'v', 'np', 'pdyn'];
const ALL_FIELDS     = ['t', 'bz_gsm', 'v', 'np', 'pdyn',
                        'bx_gsm', 'by_gsm', 'bz_gse', 'ae', 'sym_h'];

export default async function handler(request) {
    const url   = new URL(request.url);
    const start = _parseISODate(url.searchParams.get('start'));
    const end   = _parseISODate(url.searchParams.get('end'));

    if (!start || !end) {
        return jsonError('bad_request',
            '?start=YYYY-MM-DD and ?end=YYYY-MM-DD are required',
            { source: 'NASA SPDF OMNI HRO', status: 400 });
    }
    // end == start is allowed and means "one full UTC day". end < start is
    // rejected.
    if (end < start) {
        return jsonError('bad_request', 'end must be on or after start',
            { source: 'NASA SPDF OMNI HRO', status: 400 });
    }
    const rangeDays = (end - start) / 86_400_000 + 1;
    if (rangeDays > MAX_WINDOW_DAYS) {
        return jsonError('bad_request',
            `window exceeds ${MAX_WINDOW_DAYS}-day cap (got ${rangeDays} d)`,
            { source: 'NASA SPDF OMNI HRO', status: 400 });
    }

    const stepRaw = parseInt(url.searchParams.get('step_min') ?? DEFAULT_STEP, 10);
    const stepMin = Math.max(1, Math.min(isNaN(stepRaw) ? DEFAULT_STEP : stepRaw, MAX_STEP));

    const fieldsParam = (url.searchParams.get('fields') || '').split(',').map(s => s.trim()).filter(Boolean);
    const fields = fieldsParam.length > 0
        ? fieldsParam.filter(f => ALL_FIELDS.includes(f))
        : DEFAULT_FIELDS;
    if (!fields.includes('t')) fields.unshift('t');

    // SPDF month-bucket fetches in parallel (usually 1; Gannon window is all in May).
    const months = _monthsInRange(start, end);
    const urls = months.map(({ year, month }) => _monthURL(year, month));

    let monthTexts;
    try {
        monthTexts = await Promise.all(urls.map(async u => {
            const res = await fetchWithTimeout(u, {
                headers: { Accept: 'text/plain' },
                timeoutMs: FETCH_TIMEOUT_MS,
            });
            if (!res.ok) throw new Error(`${u}: HTTP ${res.status}`);
            return res.text();
        }));
    } catch (e) {
        return jsonError('upstream_unavailable', e.message,
            { source: 'NASA SPDF OMNI HRO', urls });
    }

    // Parse + filter + downsample.
    const startMs = start.getTime();
    const endMs   = end.getTime() + 86_400_000;   // make end inclusive of full day
    const stepMs  = stepMin * 60_000;

    // First pass: minute-cadence parsed records within [startMs, endMs).
    const minutes = [];   // each {t_ms, bz_gsm, v, ...}
    let nValid = 0;
    for (const text of monthTexts) {
        for (const line of text.split(/\r?\n/)) {
            const r = parseOmniLine(line);
            if (!r) continue;
            const tMs = Date.parse(r.t);
            if (tMs < startMs || tMs >= endMs) continue;
            minutes.push({ ...r, t_ms: tMs });
            if (r.bz_gsm != null && r.v != null) nValid++;
        }
    }

    // Second pass: downsample by stepMin. Step-after: take the sample
    // whose t_ms is the floor of the grid tick. Equivalent to sampling
    // the first record in each stepMin-sized bin.
    const downsampled = [];
    let nextBin = startMs;
    let i = 0;
    while (nextBin < endMs) {
        // Find first record at or after nextBin (binary-search would be
        // overkill; the array is already time-ordered and we only walk
        // forward).
        while (i < minutes.length && minutes[i].t_ms < nextBin) i++;
        if (i >= minutes.length) break;
        const r = minutes[i];
        // Only emit if the record is within the next bin; otherwise the
        // grid tick has no observation (gap).
        if (r.t_ms < nextBin + stepMs) {
            downsampled.push(r);
        }
        nextBin += stepMs;
    }

    // Project columns into the response.
    const out = {};
    for (const f of fields) {
        if (f === 't') {
            out.t = downsampled.map(r => r.t);
        } else if (ALL_FIELDS.includes(f)) {
            out[f] = downsampled.map(r => r[f]);
        }
    }

    return jsonOk({
        source: 'NASA SPDF OMNI HRO 1-min via Vercel Edge',
        data: {
            window: {
                start:           start.toISOString(),
                end:             end.toISOString(),
                step_min:        stepMin,
                n_minutes_total: minutes.length,
                n_valid:         nValid,
                n_samples:       downsampled.length,
            },
            ...out,
        },
        provenance: {
            source_file_urls: urls,
            parser_version:   'omni-hro-1min-v1',
            fetched_at:       new Date().toISOString(),
        },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
