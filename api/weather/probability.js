/**
 * Vercel Edge Function: GET / POST /api/weather/probability
 *
 * Probability-of-Exceedance picker backend. Given a cell, a field, an
 * operator, a threshold, and a forward time window, returns the
 * probability that the threshold is crossed at any hour in the window
 * — computed empirically across the four NWP members already wired
 * into /api/weather/forecast?type=ensemble (GFS, ECMWF, ICON, GEM).
 *
 * Method
 * ──────
 * Each NWP member is a single deterministic forecast (one value per
 * hour per field). For the requested window:
 *   - per-hour: P(t) = fraction of members whose value at hour t
 *               crosses the threshold under op.
 *   - per-member: P_m = 1 if member m crosses at any hour in window
 *               (deterministic "would this member call it?"),
 *               0 otherwise.
 *   - aggregate: P = mean(P_m across members), which equals the
 *               4-member empirical probability of the event.
 *
 * Why not fit a distribution
 * ──────────────────────────
 * With four samples per hour, parametric fits (lognormal for precip,
 * normal for temp) over-fit far more than they help. Empirical is
 * honest about what we know: four points, four binary opinions.
 * When we later add ensemble members (Track C in the plan) the
 * granularity climbs naturally.
 *
 * Confidence
 * ──────────
 * `ensemble_iqr` is the standard deviation of per-member values at
 * the window's centre hour, normalised by a per-field reference
 * scale. It's the same uncertainty signal the picker UI shows as a
 * confidence chip — sourced from real cross-model spread, not a
 * lead-time heuristic.
 *
 * Request
 * ───────
 *   GET /api/weather/probability
 *       ?lat=40.0&lon=-105.3
 *       &field=temperature_2m
 *       &op=lt
 *       &threshold=32
 *       &window_start_h=48
 *       &window_end_h=96
 *       &units=F                     (optional — display only)
 *
 *   POST /api/weather/probability    (same body fields as JSON)
 *
 * Response
 * ────────
 *   {
 *     probability:   0.50,
 *     ensemble_iqr:  0.42,
 *     by_member: [
 *       { model_id: 'GFS',   probability: 0,   crossed_hours: [] },
 *       { model_id: 'ECMWF', probability: 1,   crossed_hours: [50, 51, 52] },
 *       ...
 *     ],
 *     by_hour: [
 *       { iso, t_offset_h, p, n_members, n_crossed },
 *       ...
 *     ],
 *     window:        { start_h, end_h, hours_evaluated },
 *     basis:         { method, models, field, op, threshold, units },
 *     ttl_seconds:   600
 *   }
 *
 * Rate limit
 * ──────────
 * 60 anonymous req / IP / hour (signed-in bypass via Bearer token).
 * Server cap is the security backstop; the client also enforces a
 * soft 5-minute "free trial" timer (js/anonymous-session-timer.js).
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { checkAnonymousQuota } from '../_lib/anonymous-rate-limit.js';

export const config = { runtime: 'edge' };

// ── Constants ──────────────────────────────────────────────────────

// Models — must match buildEnsembleParams in api/weather/forecast.js.
// We display these as friendly labels in by_member.
const ENSEMBLE_MODELS = Object.freeze([
    { key: 'gfs_seamless',  display: 'GFS'   },
    { key: 'ecmwf_ifs025',  display: 'ECMWF' },
    { key: 'icon_seamless', display: 'ICON'  },
    { key: 'gem_seamless',  display: 'GEM'   },
]);

// Permitted (field, op, default_units) tuples. The picker UI is also
// constrained to this set; the server rejects anything else.
const FIELD_CONFIG = Object.freeze({
    temperature_2m:        { units: 'F',   scale: 30,   label: 'Temperature'         },
    apparent_temperature:  { units: 'F',   scale: 30,   label: 'Apparent temperature'},
    relative_humidity_2m:  { units: '%',   scale: 30,   label: 'Relative humidity'   },
    dew_point_2m:          { units: 'F',   scale: 20,   label: 'Dew point'           },
    pressure_msl:          { units: 'hPa', scale: 20,   label: 'Sea-level pressure'  },
    wind_speed_10m:        { units: 'mph', scale: 20,   label: 'Wind speed'          },
    wind_gusts_10m:        { units: 'mph', scale: 25,   label: 'Wind gusts'          },
    precipitation:         { units: 'mm',  scale: 5,    label: 'Precipitation'       },
    cloud_cover:           { units: '%',   scale: 30,   label: 'Cloud cover'         },
});

const VALID_OPS = new Set(['lt', 'lte', 'gt', 'gte']);

// Window limits. Max horizon mirrors Open-Meteo's ensemble cap (~7d
// for the four models we use); start can be 0 (right-now check) but
// must lie before end.
const MAX_WINDOW_END_HOURS = 7 * 24;
const MAX_WINDOW_LEN_HOURS = 7 * 24;

const CACHE_TTL_SEC = 600;       // 10 min
const CACHE_SWR_SEC = 600;

// Internal call to /api/weather/forecast?type=ensemble. We hit the
// same origin so the upstream response is also edge-cached by Vercel
// (less duplicated Open-Meteo egress per cell).
function ensembleUrl(req, lat, lon, days) {
    const origin = new URL(req.url).origin;
    return `${origin}/api/weather/forecast`
        + `?type=ensemble`
        + `&lat=${encodeURIComponent(lat.toFixed(3))}`
        + `&lon=${encodeURIComponent(lon.toFixed(3))}`
        + `&days=${encodeURIComponent(days)}`;
}

// ── Input parsing + validation ─────────────────────────────────────

function _firstFinite(...xs) {
    for (const x of xs) {
        const n = typeof x === 'number' ? x : parseFloat(x);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

async function _readParams(request) {
    if (request.method === 'GET') {
        const p = new URL(request.url).searchParams;
        return {
            lat:            _firstFinite(p.get('lat')),
            lon:            _firstFinite(p.get('lon')),
            field:          (p.get('field')      || '').trim(),
            op:             (p.get('op')         || '').trim().toLowerCase(),
            threshold:      _firstFinite(p.get('threshold')),
            window_start_h: _firstFinite(p.get('window_start_h')) ?? 0,
            window_end_h:   _firstFinite(p.get('window_end_h')),
            units:          p.get('units') || null,
        };
    }
    if (request.method === 'POST') {
        let body = null;
        try { body = await request.json(); } catch { /* fall through */ }
        body = body || {};
        return {
            lat:            _firstFinite(body.lat),
            lon:            _firstFinite(body.lon),
            field:          (body.field || '').trim(),
            op:             (body.op    || '').trim().toLowerCase(),
            threshold:      _firstFinite(body.threshold),
            window_start_h: _firstFinite(body.window_start_h, body.window?.start_offset_h) ?? 0,
            window_end_h:   _firstFinite(body.window_end_h,  body.window?.end_offset_h),
            units:          body.units || null,
        };
    }
    return null;
}

function _validate(p) {
    if (!p) return 'unsupported_method';
    if (p.lat == null || p.lon == null) return 'missing_lat_lon';
    if (p.lat < -90 || p.lat > 90)      return 'lat_out_of_range';
    if (p.lon < -180 || p.lon > 180)    return 'lon_out_of_range';
    if (!FIELD_CONFIG[p.field])         return 'unknown_field';
    if (!VALID_OPS.has(p.op))           return 'unknown_op';
    if (p.threshold == null)            return 'missing_threshold';
    if (p.window_end_h == null)         return 'missing_window_end';
    if (p.window_start_h < 0)           return 'window_start_negative';
    if (p.window_end_h   <= p.window_start_h) return 'window_end_before_start';
    if (p.window_end_h > MAX_WINDOW_END_HOURS) return 'window_too_far';
    if (p.window_end_h - p.window_start_h > MAX_WINDOW_LEN_HOURS)
        return 'window_too_wide';
    return null;
}

// ── Core compute ───────────────────────────────────────────────────

function _opTest(op) {
    switch (op) {
        case 'lt':  return (v, th) => v <  th;
        case 'lte': return (v, th) => v <= th;
        case 'gt':  return (v, th) => v >  th;
        case 'gte': return (v, th) => v >= th;
    }
    return () => false;
}

function _stddev(values) {
    const xs = values.filter(Number.isFinite);
    if (xs.length < 2) return 0;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
    return Math.sqrt(variance);
}

/**
 * Build the {by_hour, by_member, probability, ensemble_iqr} payload
 * from the Open-Meteo ensemble response.
 *
 * @param {object} hourly         hourly block from Open-Meteo
 * @param {string} field          e.g. 'temperature_2m'
 * @param {(v,th)=>boolean} test  op function
 * @param {number} threshold
 * @param {number} windowStartH
 * @param {number} windowEndH
 * @param {number} nowMs
 */
function _evaluate(hourly, field, test, threshold,
                   windowStartH, windowEndH, nowMs) {
    if (!hourly || !Array.isArray(hourly.time)) {
        return null;
    }
    // Per-model arrays. Open-Meteo names them `<field>_<model>` when
    // `models=` is set, but when a single model is requested it falls
    // back to bare `<field>`. We constructed the request with 4 models
    // so we expect suffixed names; fall back gracefully if not.
    const memberArrays = ENSEMBLE_MODELS.map(m => ({
        model_id: m.display,
        key:      m.key,
        values:   hourly[`${field}_${m.key}`]
                  || hourly[field]    // single-model fallback
                  || [],
    }));

    // Each ISO comes back in the local timezone returned by Open-Meteo
    // (timezone=auto). We map indices → t_offset_h relative to nowMs;
    // a stable offset is what the window filter uses.
    const times = hourly.time;
    const indices = [];
    for (let i = 0; i < times.length; i++) {
        const ms = Date.parse(times[i]);
        if (!Number.isFinite(ms)) continue;
        const dt_h = (ms - nowMs) / 3_600_000;
        if (dt_h >= windowStartH && dt_h <= windowEndH) {
            indices.push({ i, dt_h, iso: times[i] });
        }
    }
    if (indices.length === 0) return null;

    // by_hour: per-hour fraction of members crossing threshold.
    const by_hour = indices.map(({ i, dt_h, iso }) => {
        let crossed = 0, total = 0;
        for (const m of memberArrays) {
            const v = m.values[i];
            if (!Number.isFinite(v)) continue;
            total++;
            if (test(v, threshold)) crossed++;
        }
        return {
            iso,
            t_offset_h: Math.round(dt_h * 10) / 10,
            p:          total > 0 ? crossed / total : null,
            n_members:  total,
            n_crossed:  crossed,
        };
    });

    // by_member: did this member cross at any hour in the window?
    const by_member = memberArrays.map(m => {
        const crossed_hours = [];
        for (const { i, dt_h } of indices) {
            const v = m.values[i];
            if (Number.isFinite(v) && test(v, threshold)) {
                crossed_hours.push(Math.round(dt_h * 10) / 10);
            }
        }
        return {
            model_id:      m.model_id,
            probability:   crossed_hours.length > 0 ? 1 : 0,
            crossed_hours,
        };
    });

    const valid_members = by_member.filter(m => {
        // A member is "valid" if it has at least one finite value in
        // the window. Strictly speaking we should track this from the
        // value loops; this approximation rejects members where every
        // hour is missing.
        const m_values = memberArrays.find(mm => mm.model_id === m.model_id)?.values;
        return m_values?.some((v, i) =>
            Number.isFinite(v)
            && indices.some(ix => ix.i === i));
    });
    const probability = valid_members.length > 0
        ? valid_members.reduce((acc, m) => acc + m.probability, 0) / valid_members.length
        : null;

    // ensemble_iqr — normalised standard deviation across member values
    // at the window's centre hour. Used by the picker UI as a confidence
    // chip. Normalised by per-field reference scale so different fields
    // share a [0..1+] range.
    const centerOffset = (windowStartH + windowEndH) / 2;
    let center_idx = indices[0].i;
    let best_d = Math.abs(indices[0].dt_h - centerOffset);
    for (const ix of indices) {
        const d = Math.abs(ix.dt_h - centerOffset);
        if (d < best_d) { best_d = d; center_idx = ix.i; }
    }
    const center_values = memberArrays
        .map(m => m.values[center_idx])
        .filter(Number.isFinite);
    const scale = FIELD_CONFIG[field].scale;
    const iqr = scale > 0 ? _stddev(center_values) / scale : 0;

    return {
        probability,
        ensemble_iqr:    Math.round(iqr * 1000) / 1000,
        by_member,
        by_hour,
        hours_evaluated: indices.length,
        valid_models:    valid_members.length,
    };
}

// ── Handler ────────────────────────────────────────────────────────

export default async function handler(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204 });
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
        return jsonError('method_not_allowed', null, { status: 405 });
    }

    // Rate-gate FIRST so abuse can't waste an upstream call.
    const gate = checkAnonymousQuota(request, {
        feature:     'probability-picker',
        maxRequests: 60,
        windowMs:    60 * 60 * 1000,
    });
    if (!gate.allowed) {
        return new Response(JSON.stringify({
            error:        'rate_limited',
            retry_after:  gate.retryAfterSec,
            reason:       gate.reason || 'window_exhausted',
            hint:         'Sign in for unlimited queries.',
        }), {
            status:  429,
            headers: {
                'Retry-After':  String(gate.retryAfterSec),
                'Content-Type': 'application/json',
                'Cache-Control':'no-store',
                'Access-Control-Allow-Origin': '*',
            },
        });
    }

    const params = await _readParams(request);
    const err    = _validate(params);
    if (err) return jsonError('bad_request', err, { status: 400 });

    // Days needed for the upstream call. Open-Meteo's forecast endpoint
    // caps `forecast_days` at 16 for some models; the ensemble route in
    // forecast.js caps at 7. Round up + a 1-day cushion so the window's
    // last hour lands inside the returned arrays.
    const days = Math.max(1, Math.min(7, Math.ceil(params.window_end_h / 24) + 1));

    let upstream;
    try {
        const url = ensembleUrl(request, params.lat, params.lon, days);
        const res = await fetchWithTimeout(url, {
            timeoutMs: 12_000,
            headers:   { Accept: 'application/json' },
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return jsonError('upstream_unavailable',
                `ensemble ${res.status}: ${text.slice(0, 200)}`,
                { status: 502, source: 'open-meteo' });
        }
        upstream = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message,
            { status: 502, source: 'open-meteo' });
    }

    const test  = _opTest(params.op);
    const evald = _evaluate(
        upstream.hourly, params.field, test, params.threshold,
        params.window_start_h, params.window_end_h, Date.now());

    if (!evald) {
        return jsonError('no_data',
            'no ensemble hours fell inside the requested window',
            { status: 502 });
    }

    return jsonOk({
        probability:   evald.probability,
        ensemble_iqr:  evald.ensemble_iqr,
        by_member:     evald.by_member,
        by_hour:       evald.by_hour,
        window: {
            start_h:         params.window_start_h,
            end_h:           params.window_end_h,
            hours_evaluated: evald.hours_evaluated,
        },
        basis: {
            method:       'empirical_members',
            models:       evald.valid_models,
            field:        params.field,
            field_label:  FIELD_CONFIG[params.field].label,
            op:           params.op,
            threshold:    params.threshold,
            units:        params.units || FIELD_CONFIG[params.field].units,
        },
        rate_limit: gate.signedInBypass ? null : {
            remaining_requests: gate.remaining,
        },
        ttl_seconds:  CACHE_TTL_SEC,
    }, { maxAge: CACHE_TTL_SEC, swr: CACHE_SWR_SEC });
}
