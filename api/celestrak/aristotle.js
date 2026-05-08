/**
 * Vercel Edge Function: /api/celestrak/aristotle
 *
 * "Aristotle" — daily-conjunction feed.
 *
 * Proxies CelesTrak SOCRATES (Satellite Orbital Conjunction Reports
 * Assessing Threatening Encounters in Space). SOCRATES runs a
 * pairwise SGP4 screen across the 18 SDS GP catalog every ~12 hours
 * and publishes the worst-case approaches.
 *
 * We rebrand to "Aristotle" in our UI because the upstream name has
 * since been adopted by an LLM and confuses operators searching for
 * the conjunction feed.
 *
 * Query params:
 *   ?sort=range | prob   — sort by minimum range (default) or by
 *                          maximum collision probability
 *   ?limit=N             — cap to N rows (default 25, max 100)
 *
 * Response:
 *   {
 *     source:    'CelesTrak SOCRATES',
 *     sort:      'range' | 'prob',
 *     fetched:   ISO-8601,
 *     conjunctions: [
 *       {
 *         primary:    { norad: number, name: string },
 *         secondary:  { norad: number, name: string },
 *         tca:        ISO-8601,
 *         minRangeKm: number,
 *         relVelKmS:  number,
 *         maxProb:    number | null,    // null when not published
 *       },
 *       ...
 *     ],
 *   }
 *
 * Caching: 1 hour at the edge — SOCRATES recomputes every 12h, but
 * we don't want a hot reload to hammer it. SWR 5 min covers refresh
 * spikes around the 00 UTC and 12 UTC publication boundaries.
 *
 * Upstream notes:
 *   CelesTrak retired sort-minRange.php / sort-totProb.php in late 2024
 *   and consolidated everything onto table-socrates.php with an ORDER
 *   query parameter (MINRANGE / MAXPROB). We request CSV (FORMAT=CSV)
 *   when available and fall back to HTML parsing if the server hands
 *   back HTML — both paths produce the same row schema documented at
 *   https://celestrak.org/SOCRATES/socrates-format.php.
 */
import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const CACHE_TTL = 3600;
const CACHE_SWR = 300;

/**
 * SOCRATES Plus query endpoint. CelesTrak deprecated the old
 * sort-minRange.php / sort-totProb.php files in late 2024 (returns 404)
 * and consolidated everything onto table-socrates.php with an ORDER
 * query parameter. The CSV column header is the contract — see
 * https://celestrak.org/SOCRATES/socrates-format.php.
 *
 * Two path roots have been observed in the wild — `/SOCRATES/` (the
 * original) and `/SOCRATES-Plus/` (referenced in some search-result
 * pages and external docs). They appear to back the same script, but
 * either can intermittently 403 / redirect, so we cycle through both.
 *
 * NAME parameter quirk: passing `NAME=` (empty) renders the search
 * form rather than running a query, and the ~80-byte stub response
 * trips our `empty_response` guard. The wildcard "show me everything"
 * sentinel that CelesTrak's own search-result URLs use is `NAME=,`
 * (a single comma); we use that to actually pull rows.
 */
const SOCRATES_PATHS = [
    'https://celestrak.org/SOCRATES/table-socrates.php',
    'https://celestrak.org/SOCRATES-Plus/table-socrates.php',
];
const SORT_PARAM = {
    range: 'MINRANGE',
    prob:  'MAXPROB',
};

function buildSocratesUrl(base, sort, limit, format) {
    const q = new URLSearchParams({
        NAME:   ',',
        ORDER:  SORT_PARAM[sort] ?? 'MINRANGE',
        MAX:    String(Math.max(1, Math.min(100, limit | 0))),
    });
    if (format === 'csv') q.set('FORMAT', 'CSV');
    return `${base}?${q.toString()}`;
}

const UA = 'ParkerPhysics/1.0 (+https://parkersphysics.com; aristotle-socrates-proxy)';

/**
 * Parse SOCRATES Plus CSV. The format is documented at
 * https://celestrak.org/SOCRATES/socrates-format.php with header:
 *
 *   NORAD_CAT_ID_1, OBJECT_NAME_1, DSE_1,
 *   NORAD_CAT_ID_2, OBJECT_NAME_2, DSE_2,
 *   TCA, TCA_RANGE, TCA_RELATIVE_SPEED, MAX_PROB, DILUTION
 *
 * One conjunction per row — the older two-row HTML format with
 * rowspan'd Time In/TCA/Time Out is gone.
 */
function parseSocratesCsv(text) {
    const lines = text.split(/\r?\n/).filter(l => l.length > 0);
    if (lines.length < 2) return [];

    const header = lines[0].toUpperCase();
    if (!header.includes('NORAD_CAT_ID_1')) return [];

    const cols = lines[0].split(',').map(s => s.trim().toUpperCase());
    const idx = {
        n1:    cols.indexOf('NORAD_CAT_ID_1'),
        name1: cols.indexOf('OBJECT_NAME_1'),
        n2:    cols.indexOf('NORAD_CAT_ID_2'),
        name2: cols.indexOf('OBJECT_NAME_2'),
        tca:   cols.indexOf('TCA'),
        range: cols.indexOf('TCA_RANGE'),
        speed: cols.indexOf('TCA_RELATIVE_SPEED'),
        prob:  (() => {
            const p = cols.indexOf('MAX_PROB');
            return p >= 0 ? p : cols.indexOf('MAXPROB');
        })(),
    };
    if (idx.n1 < 0 || idx.n2 < 0 || idx.range < 0) return [];

    const conjunctions = [];
    for (let i = 1; i < lines.length; i++) {
        const row = parseCsvRow(lines[i]);
        if (row.length < cols.length) continue;

        const norad1 = +row[idx.n1];
        const norad2 = +row[idx.n2];
        const minRangeKm = parseFloat(row[idx.range]);
        const relVelKmS  = parseFloat(row[idx.speed]);
        if (!Number.isFinite(norad1) || !Number.isFinite(norad2)) continue;
        if (!Number.isFinite(minRangeKm) || !Number.isFinite(relVelKmS)) continue;

        const tcaStr = idx.tca >= 0 ? row[idx.tca] : '';
        const tcaIso = parseSocratesUtc(tcaStr)?.toISOString() ?? tcaStr ?? null;

        const probRaw = idx.prob >= 0 ? row[idx.prob] : '';
        const maxProb = Number.isFinite(parseFloat(probRaw)) ? +probRaw : null;

        conjunctions.push({
            primary:   { norad: norad1, name: (row[idx.name1] || '').trim() },
            secondary: { norad: norad2, name: (row[idx.name2] || '').trim() },
            tca: tcaIso,
            minRangeKm,
            relVelKmS,
            maxProb,
        });
    }
    return conjunctions;
}

/** RFC 4180 minimal CSV row parser — handles quoted commas. */
function parseCsvRow(line) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
            if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (c === '"') inQ = false;
            else cur += c;
        } else {
            if (c === '"') inQ = true;
            else if (c === ',') { out.push(cur); cur = ''; }
            else cur += c;
        }
    }
    out.push(cur);
    return out;
}

/**
 * Parse SOCRATES Plus HTML when CSV isn't available. The new
 * table-socrates.php emits one HTML row per conjunction, mirroring the
 * CSV columns above. We strip <td> cells and slide a window looking
 * for two NORAD ids three positions apart.
 */
function parseSocratesHtml(html) {
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = cellRe.exec(html)) !== null) {
        const txt = m[1]
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        cells.push(txt);
    }

    const conjunctions = [];
    const isNorad = (s) => /^\d{4,6}$/.test(s);
    const isFloat = (s) => /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(s);

    // Layout per conjunction (11 cells):
    //   0 NORAD1  1 NAME1  2 DSE1
    //   3 NORAD2  4 NAME2  5 DSE2
    //   6 TCA     7 RANGE  8 SPEED  9 MAXPROB  10 DILUTION
    for (let i = 0; i + 10 < cells.length; i++) {
        if (!isNorad(cells[i]) || !isNorad(cells[i + 3])) continue;
        const minRangeStr = cells[i + 7];
        const relVelStr   = cells[i + 8];
        if (!isFloat(minRangeStr) || !isFloat(relVelStr)) continue;

        const tcaStr   = cells[i + 6];
        const probRaw  = cells[i + 9];
        const tcaIso   = parseSocratesUtc(tcaStr)?.toISOString() ?? tcaStr;
        const maxProb  = isFloat(probRaw) ? +probRaw : null;

        conjunctions.push({
            primary:   { norad: +cells[i],     name: cells[i + 1] },
            secondary: { norad: +cells[i + 3], name: cells[i + 4] },
            tca:        tcaIso,
            minRangeKm: +minRangeStr,
            relVelKmS:  +relVelStr,
            maxProb,
        });
        i += 10;
    }
    return conjunctions;
}

/** Parse "2025 Apr 30 12:34:56.789" UTC into a Date. */
function parseSocratesUtc(s) {
    const months = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5,
                     Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
    const m = /^(\d{4})\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(s);
    if (!m) return null;
    const [, yyyy, mon, dd, hh, mm, ss] = m;
    const monIdx = months[mon];
    if (monIdx == null) return null;
    const t = Date.UTC(+yyyy, monIdx, +dd, +hh, +mm, Math.floor(+ss),
        Math.round((+ss - Math.floor(+ss)) * 1000));
    return new Date(t);
}

/**
 * Fetch one upstream variant. Returns { body, contentType } on success,
 * or throws on transport / HTTP errors. Treats < MIN_BODY_BYTES as a
 * failure too so the caller can fall through to the next variant
 * instead of returning a search-form stub up the stack.
 */
const MIN_BODY_BYTES = 200;

async function fetchVariant(url, accept) {
    const res = await fetchWithTimeout(url, {
        headers: {
            'User-Agent': UA,
            'Accept':     accept,
        },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const body = await res.text();
    if (!body || body.length < MIN_BODY_BYTES) {
        throw new Error(`short payload (${body?.length ?? 0} bytes)`);
    }
    return { body, contentType };
}

export default async function handler(request) {
    const url = new URL(request.url);
    const sortParam = (url.searchParams.get('sort') || 'range').toLowerCase();
    const sort = sortParam === 'prob' ? 'prob' : 'range';
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '25', 10) || 25));

    // Walk path roots × formats. We prefer CSV (cleaner parse) but the
    // newer /SOCRATES-Plus/ root sometimes only honours HTML, so each
    // root is tried in both formats before giving up. Per-attempt errors
    // are collected so the client can see exactly what upstream did.
    const attempts = [];
    let body, contentType;
    outer: for (const base of SOCRATES_PATHS) {
        for (const fmt of ['csv', 'html']) {
            const target = buildSocratesUrl(base, sort, limit, fmt === 'csv' ? 'csv' : null);
            const accept = fmt === 'csv'
                ? 'text/csv, text/plain, text/html;q=0.5'
                : 'text/html,application/xhtml+xml';
            try {
                const r = await fetchVariant(target, accept);
                body = r.body;
                contentType = r.contentType;
                attempts.push({ url: target, status: 'ok', bytes: body.length });
                break outer;
            } catch (e) {
                attempts.push({ url: target, status: 'error', error: e.message });
            }
        }
    }

    if (!body) {
        return jsonError('upstream_unavailable',
            'SOCRATES returned no usable payload from any known endpoint',
            { source: 'CelesTrak SOCRATES', detail: attempts });
    }

    // Detect CSV by content-type or by sniffing the first line for the
    // documented header. Fall back to HTML parsing otherwise.
    const looksCsv = contentType.includes('csv')
        || /^\s*NORAD_CAT_ID_1\b/i.test(body);

    let all = looksCsv ? parseSocratesCsv(body) : parseSocratesHtml(body);

    // If CSV parsing yielded nothing but the body is HTML-shaped, retry
    // as HTML — CelesTrak occasionally serves HTML even when CSV is
    // requested if the query is malformed.
    if (all.length === 0 && /<td/i.test(body)) {
        all = parseSocratesHtml(body);
    }

    if (all.length === 0) {
        // Don't 503 — return success with a flagged empty list and the
        // raw byte size so the UI can warn that the parser may need
        // updating without breaking the page.
        return jsonOk({
            source: 'CelesTrak SOCRATES',
            sort,
            fetched: new Date().toISOString(),
            conjunctions: [],
            warning: 'parser-no-rows',
            rawBytes: body.length,
            attempts,
        }, { maxAge: 300, swr: 60 });   // shorter cache so a parser fix lands fast
    }

    const conjunctions = all.slice(0, limit);
    return jsonOk({
        source: 'CelesTrak SOCRATES',
        sort,
        fetched: new Date().toISOString(),
        totalAvailable: all.length,
        conjunctions,
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
