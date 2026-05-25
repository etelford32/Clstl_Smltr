/**
 * Vercel Edge Function: /api/density/tudelft
 *
 * Proxies TU Delft's accelerometer-derived neutral-density products
 * (Doornbos v02) for GRACE-FO and Swarm-C across a requested date
 * window. Open public data — no API key.
 *
 * Source: http://thermosphere.tudelft.nl/acceldata/
 *
 * The TU Delft archive's directory layout has shifted across re-
 * processings, so URL templates are stored per-mission in a const map
 * below. If a path moves, edit MISSIONS — no code changes elsewhere.
 *
 * Query params:
 *   ?mission=grace_fo | swarm_c       (required)
 *   ?start=YYYY-MM-DD                 (required, UTC)
 *   ?end=YYYY-MM-DD                   (required, UTC; same-day allowed)
 *   ?subsample=N                      (optional, default 60 — keep every
 *                                      N-th record. Raw cadence is ~10 s;
 *                                      N=60 ≈ 10-min cadence ≈ orbit-scale
 *                                      sampling, ~88 points/satellite/day)
 *
 * Response:
 *   {
 *     source: '...',
 *     data: {
 *       mission:   'grace_fo' | 'swarm_c',
 *       window:    { start, end, subsample, n_raw, n_returned, days_404 },
 *       samples:   [ { t, alt_km, lat_deg, lon_deg, rho_kg_m3 }, ... ],
 *     },
 *     provenance: { source_file_urls, parser_version, fetched_at }
 *   }
 *
 * Errors:
 *   400 — validation (missing/bad params)
 *   503 — every daily file 404'd (path likely moved)
 *   200 — partial success (some 404s tolerated; days_404 in window)
 *
 * Cache policy: historical days are immutable. 24h CDN cache on success.
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

// ── URL templates ──────────────────────────────────────────────────
//
// Tokens: {Y}=year(4), {M}=month(2, zero-padded), {D}=day(2, zero-padded).
//
// GRACE-FO path is the same one the existing scripts/fetch-grace.mjs
// uses; per the runbook the JS + Python peers agree. Both have the
// "verify before running" caveat because TU Delft has re-organised
// this tree in the past. If GRACE-FO 404s, try one of the alternates
// below by editing the array.
//
// Swarm-C URL is documented in TU Delft's data product overview but
// hasn't been programmatically validated in this repo. Best-effort
// based on the GraceFO sibling pattern; the alternate paths cover the
// most likely re-organisations.
const MISSIONS = {
    grace_fo: {
        url_templates: [
            'http://thermosphere.tudelft.nl/acceldata/GraceFO/v02/density/{Y}/grcfo_density_{Y}_{M}_{D}.txt',
        ],
        // Reasonable altitude window for outlier-filtering (GRACE-FO at ~490 km).
        alt_min: 200,
        alt_max: 700,
        label: 'GRACE-FO accelerometer density (Doornbos v02)',
    },
    swarm_c: {
        url_templates: [
            'http://thermosphere.tudelft.nl/acceldata/Swarm/v02/density/SwarmC/{Y}/swrmc_density_{Y}_{M}_{D}.txt',
            // Alternate filename patterns seen in older releases:
            'http://thermosphere.tudelft.nl/acceldata/Swarm/v02/density/SwarmC/{Y}/swarmc_density_{Y}_{M}_{D}.txt',
            'http://thermosphere.tudelft.nl/acceldata/SwarmC/v02/density/{Y}/swrmc_density_{Y}_{M}_{D}.txt',
        ],
        // Swarm-C orbits at ~440 km (post-2014 lower-orbit configuration).
        alt_min: 200,
        alt_max: 600,
        label: 'Swarm-C accelerometer density (Doornbos v02)',
    },
};

// File format: whitespace-separated, one record per line:
//   YYYY-MM-DDThh:mm:ss   alt_km   lat_deg   lon_deg   density_kg_m3
// Lines starting with # or % are headers and skipped.
const COL_NAMES = ['t', 'alt', 'lat', 'lon', 'rho'];

const MAX_WINDOW_DAYS  = 14;
const DEFAULT_SUBSAMPLE = 60;
const MAX_SUBSAMPLE     = 600;
const CACHE_TTL         = 86_400;
const CACHE_SWR         = 3600;
const FETCH_TIMEOUT_MS  = 25_000;

function _parseISODate(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(s + 'T00:00:00Z');
    return isNaN(d) ? null : d;
}

function _daysInWindow(start, end) {
    // Inclusive of both endpoints. start == end → 1 day.
    const days = [];
    const cur  = new Date(Date.UTC(
        start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    const endDay = Date.UTC(
        end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
    while (cur.getTime() <= endDay) {
        days.push(new Date(cur.getTime()));
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return days;
}

function _expandTemplate(tpl, d) {
    const Y = String(d.getUTCFullYear());
    const M = String(d.getUTCMonth() + 1).padStart(2, '0');
    const D = String(d.getUTCDate()).padStart(2, '0');
    return tpl.replaceAll('{Y}', Y).replaceAll('{M}', M).replaceAll('{D}', D);
}

/**
 * Parse one TU Delft v02 ASCII line.
 * Returns null on headers / malformed lines / out-of-range altitudes.
 */
function parseTudelftLine(line, altMin, altMax) {
    if (!line) return null;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('%')) return null;
    const parts = trimmed.split(/\s+/);
    if (parts.length < COL_NAMES.length) return null;

    // Timestamp tolerant of "T" / " " separator and missing trailing Z.
    let ts = parts[0];
    if (!ts.includes('T') && ts.length >= 19 && ts.length <= 23) ts = ts.replace(' ', 'T');
    if (!ts.endsWith('Z')) ts = ts + 'Z';
    const tMs = Date.parse(ts);
    if (!Number.isFinite(tMs)) return null;

    const alt = Number(parts[1]);
    const lat = Number(parts[2]);
    const lon = Number(parts[3]);
    const rho = Number(parts[4]);
    if (![alt, lat, lon, rho].every(Number.isFinite)) return null;
    if (rho <= 0) return null;                       // density strictly positive
    if (alt < altMin || alt > altMax) return null;   // orbit-altitude sanity

    return {
        t:         new Date(tMs).toISOString(),
        t_ms:      tMs,
        alt_km:    alt,
        lat_deg:   lat,
        lon_deg:   lon,
        rho_kg_m3: rho,
    };
}

/** Try a list of URLs in order; return the first successful response text. */
async function _fetchFirstOK(urls) {
    for (const url of urls) {
        try {
            const res = await fetchWithTimeout(url, {
                headers: { Accept: 'text/plain' },
                timeoutMs: FETCH_TIMEOUT_MS,
            });
            if (res.ok) return { url, text: await res.text() };
        } catch (_) { /* try next */ }
    }
    return null;
}

export default async function handler(request) {
    const url     = new URL(request.url);
    const mission = url.searchParams.get('mission');
    const start   = _parseISODate(url.searchParams.get('start'));
    const end     = _parseISODate(url.searchParams.get('end'));

    if (!mission || !MISSIONS[mission]) {
        return jsonError('bad_request',
            `?mission= must be one of ${Object.keys(MISSIONS).join(', ')}`,
            { source: 'TU Delft thermosphere', status: 400 });
    }
    if (!start || !end) {
        return jsonError('bad_request',
            '?start=YYYY-MM-DD and ?end=YYYY-MM-DD are required',
            { source: 'TU Delft thermosphere', status: 400 });
    }
    if (end < start) {
        return jsonError('bad_request', 'end must be on or after start',
            { source: 'TU Delft thermosphere', status: 400 });
    }
    const rangeDays = (end - start) / 86_400_000 + 1;
    if (rangeDays > MAX_WINDOW_DAYS) {
        return jsonError('bad_request',
            `window exceeds ${MAX_WINDOW_DAYS}-day cap (got ${rangeDays} d)`,
            { source: 'TU Delft thermosphere', status: 400 });
    }

    const subRaw    = parseInt(url.searchParams.get('subsample') ?? DEFAULT_SUBSAMPLE, 10);
    const subsample = Math.max(1, Math.min(
        Number.isFinite(subRaw) ? subRaw : DEFAULT_SUBSAMPLE, MAX_SUBSAMPLE));

    const mDef = MISSIONS[mission];
    const days = _daysInWindow(start, end);

    // Fetch each daily file. Per-day failure (404) tolerated — record it
    // in days_404 and keep going.
    const fetched = await Promise.all(days.map(async d => {
        const candidates = mDef.url_templates.map(t => _expandTemplate(t, d));
        const hit = await _fetchFirstOK(candidates);
        return { date: d, url_tried: candidates, hit };
    }));

    const urlsAttempted = [];
    const urlsHit       = [];
    const days_404      = [];
    let combinedText    = '';

    for (const f of fetched) {
        urlsAttempted.push(...f.url_tried);
        if (f.hit) {
            urlsHit.push(f.hit.url);
            combinedText += f.hit.text + '\n';
        } else {
            days_404.push(f.date.toISOString().slice(0, 10));
        }
    }

    if (urlsHit.length === 0) {
        return jsonError('upstream_unavailable',
            `All ${urlsAttempted.length} candidate URLs returned non-2xx. ` +
            `TU Delft may have re-organised the ${mission} tree — verify the ` +
            `template list in api/density/tudelft.js. Days attempted: ` +
            days_404.join(', '),
            { source: 'TU Delft thermosphere', urls: urlsAttempted });
    }

    // Parse + filter to window + subsample.
    const startMs = start.getTime();
    const endMs   = end.getTime() + 86_400_000;
    const raw     = [];
    for (const line of combinedText.split(/\r?\n/)) {
        const r = parseTudelftLine(line, mDef.alt_min, mDef.alt_max);
        if (!r) continue;
        if (r.t_ms < startMs || r.t_ms >= endMs) continue;
        raw.push(r);
    }
    raw.sort((a, b) => a.t_ms - b.t_ms);

    const samples = [];
    for (let i = 0; i < raw.length; i += subsample) {
        const r = raw[i];
        // Drop the internal _ms field from the output.
        samples.push({
            t:         r.t,
            alt_km:    r.alt_km,
            lat_deg:   r.lat_deg,
            lon_deg:   r.lon_deg,
            rho_kg_m3: r.rho_kg_m3,
        });
    }

    return jsonOk({
        source: 'TU Delft thermosphere density (Doornbos v02) via Vercel Edge',
        data: {
            mission,
            label: mDef.label,
            window: {
                start:       start.toISOString(),
                end:         end.toISOString(),
                subsample,
                n_raw:       raw.length,
                n_returned:  samples.length,
                days_404,
            },
            samples,
        },
        provenance: {
            source_file_urls: urlsHit,
            parser_version:   'tudelft-v02-v1',
            fetched_at:       new Date().toISOString(),
        },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
