/**
 * Vercel Edge Function: /api/mars/ephemeris
 *
 * Live Mars geometry from JPL Horizons: areocentric solar longitude (Ls), the
 * sub-solar and sub-Earth points, Earth–Mars range, one-way light time, solar
 * elongation, phase angle, and apparent diameter.
 *
 * ── Why this route exists ─────────────────────────────────────────────────
 * Everything time-varying on mars.html used to come from ONE of two places: a
 * bundled 2024 MEDA snapshot, or the linear mean-motion Ls model in
 * js/mars-mission-state.js. Neither is live. Mars' orbit has e ≈ 0.0934, so a
 * constant-rate Ls runs up to ~11° off the true value — that error lands
 * directly on the terminator and on any "dust season" call.
 *
 * Horizons is the one Mars upstream in this stack that has never been retired,
 * is not rate-limited behind DEMO_KEY, and answers for any epoch. It is already
 * proxied for the Mars sky layer, so this route adds a source the page can
 * genuinely call live rather than another thing to apologise for.
 *
 * ── Degradation ladder ────────────────────────────────────────────────────
 *   source: 'jpl-horizons'     Horizons answered and the table parsed.
 *   source: 'analytic'         Horizons unreachable or unparseable; the
 *                              mars-mission-state.js model answers instead.
 *
 * The analytic block is ALWAYS present, even on the happy path, so a client can
 * show the disagreement between the two rather than trusting one blindly. The
 * `source` field is the client's cue for how to label the readout — do not
 * collapse the two into one silent number.
 *
 * Parsing lives in js/mars-ephemeris.js (pure, gated by
 * `node tests/mars-ephemeris.mjs`), not here.
 *
 * Cache-Control: s-maxage=900 / swr=900. The sub-solar longitude moves ~15°/hr
 * with Mars' rotation, so 15 minutes is ~3.7° of drift — finer than the
 * terminator is drawn, and enough to keep Horizons off the per-visitor path.
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { marsEphemerisParams, parseMarsEphemeris } from '../../js/mars-ephemeris.js';
import { marsSolarLongitudeFromJulianDate, marsSubsolarPoint } from '../../js/mars-mission-state.js';

export const config = { runtime: 'edge' };

const HORIZONS_BASE = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const CACHE_TTL = 900;
const CACHE_SWR = 900;
// Same budget the /api/horizons proxy gives JPL: ephemeris queries touch large
// SPK files and 10 s is not always enough.
const HORIZONS_TIMEOUT_MS = 20000;

function jdNowUtc() {
    return Date.now() / 86_400_000 + 2440587.5;
}

function analyticBlock(date) {
    const subsolar = marsSubsolarPoint(date);
    return {
        ls_deg: Number(subsolar.ls_deg.toFixed(3)),
        sub_solar: {
            lat_deg: Number(subsolar.lat_deg.toFixed(4)),
            lon_deg: Number(subsolar.lon_deg.toFixed(4)),
            frame: 'planetocentric · east-positive',
        },
        model: 'linear mean-motion Ls + MTC sub-solar longitude',
        accuracy_note: 'mean-anomaly approximation; up to ~11° of Ls error near the solstices',
        source: 'js/mars-mission-state.js',
    };
}

export default async function handler(request) {
    const url = new URL(request.url);
    const jdParam = parseFloat(url.searchParams.get('jd') || '');
    const jd = Number.isFinite(jdParam) ? jdParam : jdNowUtc();
    if (!Number.isFinite(jd) || jd < 2_400_000 || jd > 2_600_000) {
        return jsonError('invalid_jd',
            'jd must be a Julian date between 2400000 and 2600000',
            { status: 400, maxAge: 300 });
    }
    const date = new Date((jd - 2440587.5) * 86_400_000);
    const analytic = analyticBlock(date);

    const degraded = (reason, extra = {}) => jsonOk({
        source: 'analytic',
        degraded_reason: reason,
        // Read by status.html's _rtProxyHealth(): a 200 carrying
        // freshness:'stale' renders amber. This route always answers 200 so
        // the page keeps a season to show; without this the status board
        // would call a dead Horizons healthy.
        freshness: 'stale',
        generated_at: new Date().toISOString(),
        jd,
        ls_deg: analytic.ls_deg,
        season: null,
        sub_solar: analytic.sub_solar,
        sub_earth: null,
        earth_range_au: null,
        earth_range_km: null,
        light_time_s: null,
        light_time_text: null,
        solar_elongation_deg: null,
        solar_conjunction: null,
        analytic,
        upstream: 'JPL Horizons',
        ...extra,
    }, { maxAge: 300, swr: 600 });

    let response;
    try {
        response = await fetchWithTimeout(`${HORIZONS_BASE}?${marsEphemerisParams(jd)}`, {
            headers: { Accept: 'application/json' },
            timeoutMs: HORIZONS_TIMEOUT_MS,
        });
    } catch (error) {
        return degraded(`Horizons unreachable: ${error.message || 'fetch failed'}`);
    }
    if (!response.ok) return degraded(`Horizons HTTP ${response.status}`);

    let result;
    try {
        const payload = await response.json();
        if (typeof payload.result !== 'string') throw new Error('no result string in Horizons response');
        result = payload.result;
    } catch (error) {
        return degraded(`Horizons response unusable: ${error.message}`);
    }

    let ephemeris;
    try {
        ephemeris = parseMarsEphemeris(result);
    } catch (error) {
        return degraded(`Horizons table unparseable: ${error.message}`);
    }

    // A table that parsed but yielded no Ls is worse than the analytic model,
    // which at least always produces one. Prefer the model and say why.
    if (ephemeris.ls_deg == null && ephemeris.sub_solar.lon_deg == null) {
        return degraded('Horizons table carried neither L_s nor a sub-solar longitude', {
            horizons_fields_present: ephemeris.fields_present,
        });
    }

    return jsonOk({
        source: 'jpl-horizons',
        generated_at: new Date().toISOString(),
        jd,
        ...ephemeris,
        // Ls is the one field with an independent second opinion. Surfacing the
        // gap makes the analytic model's error visible instead of theoretical.
        ls_model_delta_deg: ephemeris.ls_deg == null ? null
            : Number((((ephemeris.ls_deg - marsSolarLongitudeFromJulianDate(jd) + 540) % 360) - 180).toFixed(3)),
        analytic,
        upstream: 'JPL Horizons',
        upstream_url: 'https://ssd.jpl.nasa.gov/horizons/',
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
