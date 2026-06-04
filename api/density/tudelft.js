/**
 * Vercel Edge Function: /api/density/tudelft
 *
 * Serves TU Delft's accelerometer-derived neutral-density products
 * (Doornbos v02) for GRACE-FO and Swarm-C across a requested date window.
 *
 *   ┌─ R2 mirror (primary) ─ hindcast/gannon/density-<mission>-v1.json
 *   │     uploaded by scripts/build-density-mirror.mjs from files an
 *   │     operator pulls off TU Delft's FTP on a workstation.
 *   └─ live HTTP fetch (fallback) ─ http://thermosphere.tudelft.nl/acceldata/
 *
 * Why the mirror: TU Delft retired the open HTTP tree in favour of
 * FTP-only distribution, which the Edge runtime's fetch() cannot reach
 * (no ftp:// scheme). The mirror lets the page lift real density-truth
 * without the Edge ever touching the upstream. The live path is retained
 * as a graceful fallback for any window/mission still served over HTTP and
 * for environments without R2 configured. See GANNON_LIVE_DATA.md (Lift 3).
 *
 * Query params:
 *   ?mission=grace_fo | swarm_c       (required)
 *   ?start=YYYY-MM-DD                 (required, UTC)
 *   ?end=YYYY-MM-DD                   (required, UTC; same-day allowed)
 *   ?subsample=N                      (optional, default 60 — keep every
 *                                      N-th record. Raw cadence is ~10 s;
 *                                      N=60 ≈ 10-min cadence)
 *   ?source=mirror | live | auto      (optional, default auto — force a
 *                                      path for debugging)
 *
 * Response (unchanged across both paths — the page keys off data.samples):
 *   {
 *     source: '...',
 *     data: { mission, label, window:{…}, samples:[ {t,alt_km,lat_deg,lon_deg,rho_kg_m3} ] },
 *     provenance: { origin: 'r2-mirror'|'live-http', source_file_urls?, mirror_key?,
 *                   parser_version, fetched_at, ... }
 *   }
 *
 * Errors:
 *   400 — validation (missing/bad params)
 *   503 — mirror absent AND every daily file 404'd
 *   200 — success (mirror hit, or partial live success with days_404)
 *
 * Cache: historical days are immutable. 24h CDN cache on success.
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { R2_CONFIGURED, getSignedUrl } from '../_lib/r2-client.js';
import { MISSIONS, parseTudelftLine, expandTemplate, PARSER_VERSION } from '../_lib/tudelft-parse.js';

export const config = { runtime: 'edge' };

const MAX_WINDOW_DAYS   = 14;
const DEFAULT_SUBSAMPLE  = 60;
const MAX_SUBSAMPLE      = 600;
const CACHE_TTL          = 86_400;
const CACHE_SWR          = 3600;
const FETCH_TIMEOUT_MS   = 25_000;
const MIRROR_TIMEOUT_MS  = 15_000;

function _parseISODate(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(s + 'T00:00:00Z');
    return isNaN(d) ? null : d;
}

function _daysInWindow(start, end) {
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

/** Subsample + project a sorted record array to the public sample shape. */
function _toSamples(rawSorted, subsample) {
    const samples = [];
    for (let i = 0; i < rawSorted.length; i += subsample) {
        const r = rawSorted[i];
        samples.push({
            t:         r.t,
            alt_km:    r.alt_km,
            lat_deg:   r.lat_deg,
            lon_deg:   r.lon_deg,
            rho_kg_m3: r.rho_kg_m3,
        });
    }
    return samples;
}

// ── R2 mirror path ─────────────────────────────────────────────────
//
// The mirror artifact (written by scripts/build-density-mirror.mjs):
//   { schema, mission, label, source, coverage, parser_version,
//     generated_at, records: [ {t, alt_km, lat_deg, lon_deg, rho_kg_m3} ] }
// Records are already parsed + altitude-filtered; we just window + subsample.
async function _tryMirror(mDef, startMs, endMs) {
    if (!R2_CONFIGURED) return { ok: false, reason: 'r2_not_configured' };
    let url;
    try {
        url = await getSignedUrl(mDef.mirror_key, { expiresIn: 300 });
    } catch (e) {
        return { ok: false, reason: `signed_url_failed: ${e.message}` };
    }
    let res;
    try {
        res = await fetchWithTimeout(url, {
            headers: { Accept: 'application/json' },
            timeoutMs: MIRROR_TIMEOUT_MS,
        });
    } catch (e) {
        return { ok: false, reason: `mirror_fetch_failed: ${e.message}` };
    }
    if (res.status === 404) return { ok: false, reason: 'mirror_not_uploaded' };
    if (!res.ok) return { ok: false, reason: `mirror_http_${res.status}` };

    let artifact;
    try { artifact = await res.json(); }
    catch (e) { return { ok: false, reason: `mirror_parse_error: ${e.message}` }; }

    const records = artifact?.records;
    if (!Array.isArray(records)) return { ok: false, reason: 'mirror_missing_records' };

    // Window-filter. Records carry an ISO `t`; derive ms once.
    const inWindow = [];
    for (const r of records) {
        const tMs = Date.parse(r.t);
        if (!Number.isFinite(tMs) || tMs < startMs || tMs >= endMs) continue;
        if (!(r.rho_kg_m3 > 0)) continue;
        inWindow.push({ ...r, t_ms: tMs });
    }
    if (inWindow.length === 0) {
        // Mirror exists but doesn't cover this window — let the caller fall
        // through to live fetch rather than returning an empty success.
        return { ok: false, reason: 'mirror_no_records_in_window',
                 coverage: artifact?.coverage };
    }
    inWindow.sort((a, b) => a.t_ms - b.t_ms);
    return { ok: true, records: inWindow, artifact };
}

export default async function handler(request) {
    const url     = new URL(request.url);
    const mission = url.searchParams.get('mission');
    const start   = _parseISODate(url.searchParams.get('start'));
    const end     = _parseISODate(url.searchParams.get('end'));
    const force   = url.searchParams.get('source') || 'auto';   // mirror | live | auto

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

    const mDef    = MISSIONS[mission];
    const startMs = start.getTime();
    const endMs   = end.getTime() + 86_400_000;

    // ── 1. R2 mirror (primary, unless ?source=live) ────────────────
    let mirrorMiss = null;
    if (force !== 'live') {
        const m = await _tryMirror(mDef, startMs, endMs);
        if (m.ok) {
            const samples = _toSamples(m.records, subsample);
            return jsonOk({
                source: m.artifact?.source
                    || 'TU Delft thermosphere density (Doornbos v02) — R2 mirror',
                data: {
                    mission,
                    label: mDef.label,
                    window: {
                        start:      start.toISOString(),
                        end:        end.toISOString(),
                        subsample,
                        n_raw:      m.records.length,
                        n_returned: samples.length,
                        days_404:   [],
                    },
                    samples,
                },
                provenance: {
                    origin:          'r2-mirror',
                    mirror_key:      mDef.mirror_key,
                    coverage:        m.artifact?.coverage ?? null,
                    mirror_built_at: m.artifact?.generated_at ?? null,
                    parser_version:  m.artifact?.parser_version ?? PARSER_VERSION,
                    fetched_at:      new Date().toISOString(),
                },
            }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
        }
        mirrorMiss = m.reason;
        if (force === 'mirror') {
            return jsonError('upstream_unavailable',
                `R2 mirror unavailable for ${mission}: ${mirrorMiss}. ` +
                `Upload it with scripts/build-density-mirror.mjs --mission ${mission} --upload.`,
                { source: 'TU Delft thermosphere (mirror)', mirror_key: mDef.mirror_key });
        }
    }

    // ── 2. live HTTP fetch (fallback) ──────────────────────────────
    const days = _daysInWindow(start, end);
    const fetched = await Promise.all(days.map(async d => {
        const candidates = mDef.url_templates.map(t => expandTemplate(t, d));
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
            `No data available for ${mission} ${url.searchParams.get('start')}…` +
            `${url.searchParams.get('end')}. R2 mirror: ${mirrorMiss || 'skipped'}; ` +
            `live HTTP: all ${urlsAttempted.length} daily URLs returned non-2xx ` +
            `(TU Delft is FTP-only — populate the mirror via ` +
            `scripts/build-density-mirror.mjs --mission ${mission} --upload). ` +
            `Days attempted: ${days_404.join(', ')}`,
            { source: 'TU Delft thermosphere', urls: urlsAttempted,
              mirror_key: mDef.mirror_key, mirror_miss: mirrorMiss });
    }

    const raw = [];
    for (const line of combinedText.split(/\r?\n/)) {
        const r = parseTudelftLine(line, mDef.alt_min, mDef.alt_max);
        if (!r) continue;
        if (r.t_ms < startMs || r.t_ms >= endMs) continue;
        raw.push(r);
    }
    raw.sort((a, b) => a.t_ms - b.t_ms);
    const samples = _toSamples(raw, subsample);

    return jsonOk({
        source: 'TU Delft thermosphere density (Doornbos v02) via Vercel Edge (live)',
        data: {
            mission,
            label: mDef.label,
            window: {
                start:      start.toISOString(),
                end:        end.toISOString(),
                subsample,
                n_raw:      raw.length,
                n_returned: samples.length,
                days_404,
            },
            samples,
        },
        provenance: {
            origin:           'live-http',
            source_file_urls: urlsHit,
            mirror_miss:      mirrorMiss,
            parser_version:   PARSER_VERSION,
            fetched_at:       new Date().toISOString(),
        },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
