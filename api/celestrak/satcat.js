/**
 * Vercel Edge Function: /api/celestrak/satcat
 *
 * Proxies CelesTrak's SATCAT (Satellite Catalog) CSV — the authoritative
 * per-NORAD record of OBJECT_TYPE, RCS, and operational status. Where the
 * gp.php endpoint (used by /api/celestrak/tle) gives us orbital elements,
 * SATCAT gives us *physical* metadata: is this thing a payload, a rocket
 * body, or debris; what's its radar cross-section; is it currently
 * operating.
 *
 * Why this exists separately from /api/celestrak/tle:
 *   - TLE catalog refreshes every ~8 h with orbital deltas — SATCAT
 *     changes slowly (object types are stable; RCS measurements get
 *     refined over time but the bucket boundaries are stable). Different
 *     cache cadence (6 h s-maxage vs. 1 h).
 *   - Bulk download is one fetch of ~3 MB CSV → parsed to ~250 KB JSON.
 *     We do that once on the server and let the edge cache absorb the
 *     burst.
 *   - The CelesTrak CSV is wide (17 columns); the client only needs
 *     four. Trimming server-side keeps the gzipped response small.
 *
 * Response shape:
 *   {
 *     source: 'CelesTrak SATCAT',
 *     fetched: ISO timestamp,
 *     count:  number of records emitted,
 *     records: {
 *       '<norad>': { t?: 'PAY'|'R/B'|'DEB'|'UNK'|'TBA',
 *                    r?: 'S'|'M'|'L',
 *                    rv?: number (m²),
 *                    s?: ops_status_code }
 *     }
 *   }
 *
 * `r` is the RCS *bucket* (Small/Medium/Large) derived from `rv` using
 * CelesTrak's published thresholds — small < 0.1 m², 0.1 ≤ medium < 1.0
 * m², large ≥ 1.0 m². Records missing both OBJECT_TYPE and RCS are
 * dropped from the response (they'd add bytes without telling us
 * anything the heuristic couldn't already infer).
 */
import { jsonOk, jsonError, fetchWithTimeout, DEFAULT_USER_AGENT, CORS_HEADERS }
    from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SATCAT_URL = 'https://celestrak.org/pub/satcat.csv';
// SATCAT changes slowly. 6 h fresh + 24 h stale-while-revalidate gives
// us a single upstream fetch a day under steady traffic without ever
// serving stale-by-more-than-a-day to a user.
const CACHE_TTL  = 6 * 3600;
const CACHE_SWR  = 24 * 3600;

const VALID_OBJECT_TYPES = new Set(['PAY', 'R/B', 'DEB', 'UNK', 'TBA']);

function rcsBucket(rcs) {
    if (rcs == null || !Number.isFinite(rcs) || rcs <= 0) return null;
    if (rcs < 0.1) return 'S';
    if (rcs < 1.0) return 'M';
    return 'L';
}

/**
 * Single-line CSV splitter — handles quoted fields with embedded
 * commas (the OBJECT_NAME column occasionally contains them; we don't
 * emit it, but we still need to step past it correctly).
 */
function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            // Handle "" escape inside a quoted field by checking next char.
            if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
            else                                { inQuote = !inQuote; }
        } else if (c === ',' && !inQuote) {
            out.push(cur);
            cur = '';
        } else {
            cur += c;
        }
    }
    out.push(cur);
    return out;
}

function parseSatcatCsv(text) {
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) return null;

    const header = lines[0].split(',').map(s => s.trim());
    const idxNorad = header.indexOf('NORAD_CAT_ID');
    const idxType  = header.indexOf('OBJECT_TYPE');
    const idxRcs   = header.indexOf('RCS');
    const idxOps   = header.indexOf('OPS_STATUS_CODE');
    if (idxNorad < 0) {
        // SATCAT-debut.csv or some other variant — abort and let the
        // caller surface "parse_failed" rather than emit something
        // misleading. Header layout changes are rare; failing loud
        // protects callers.
        return null;
    }

    const records = {};
    let kept = 0;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const cols = splitCsvLine(line);

        const noradStr = cols[idxNorad];
        const norad = noradStr ? parseInt(noradStr, 10) : NaN;
        if (!Number.isFinite(norad)) continue;

        const rec = {};

        const typeRaw = idxType >= 0 ? (cols[idxType] || '').trim() : '';
        if (typeRaw && VALID_OBJECT_TYPES.has(typeRaw)) {
            rec.t = typeRaw;
        }

        const rcsStr = idxRcs >= 0 ? (cols[idxRcs] || '').trim() : '';
        if (rcsStr) {
            const rcs = parseFloat(rcsStr);
            const bucket = rcsBucket(rcs);
            if (bucket) {
                rec.r  = bucket;
                rec.rv = rcs;
            }
        }

        const opsRaw = idxOps >= 0 ? (cols[idxOps] || '').trim() : '';
        if (opsRaw && opsRaw !== '?' && opsRaw.length === 1) {
            rec.s = opsRaw;
        }

        // Drop records that wouldn't tell the client anything beyond
        // the existing heuristic. Keeps the payload tight — typically
        // ~60 % of SATCAT has neither OBJECT_TYPE nor RCS.
        if (Object.keys(rec).length === 0) continue;
        records[norad] = rec;
        kept++;
    }
    return { records, count: kept };
}

export default async function handler() {
    let text;
    try {
        const res = await fetchWithTimeout(SATCAT_URL, {
            headers: { 'User-Agent': DEFAULT_USER_AGENT },
        });
        if (!res.ok) throw new Error(`CelesTrak HTTP ${res.status}`);
        text = await res.text();
    } catch (err) {
        return jsonError('upstream_unavailable', err.message, { source: 'CelesTrak SATCAT' });
    }

    if (!text || text.trim().length === 0) {
        return jsonError('empty_response', 'CelesTrak SATCAT returned no body',
                         { source: 'CelesTrak SATCAT' });
    }

    const parsed = parseSatcatCsv(text);
    if (!parsed) {
        return jsonError('parse_failed', 'Unexpected SATCAT CSV header layout',
                         { source: 'CelesTrak SATCAT' });
    }

    return jsonOk({
        source:  'CelesTrak SATCAT',
        fetched: new Date().toISOString(),
        count:   parsed.count,
        records: parsed.records,
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
