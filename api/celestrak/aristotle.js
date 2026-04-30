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
 * Parser notes:
 *   The upstream HTML format has been stable for years but isn't a
 *   contract. If the table layout changes the parser will return
 *   { source, error, rawSize } so the UI can show "format drift —
 *   parser needs update" rather than a misleading empty list.
 */
import { jsonOk, jsonError, fetchWithTimeout, CORS_HEADERS } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SOCRATES_BASE = 'https://celestrak.org/SOCRATES';
const CACHE_TTL = 3600;
const CACHE_SWR = 300;

/**
 * SOCRATES sort endpoints. Both produce HTML tables with the same row
 * shape — the difference is the order of rows, so we just toggle the
 * URL and use one parser.
 */
const SORT_URLS = {
    range: `${SOCRATES_BASE}/sort-minRange.php`,
    prob:  `${SOCRATES_BASE}/sort-totProb.php`,
};

/**
 * Pull conjunction rows out of a SOCRATES HTML page.
 *
 * Historical row format (one record per conjunction, two HTML rows):
 *   <tr><td>NORAD #</td><td>Object Name</td><td>Days Since Epoch</td>
 *       <td>Max Prob</td><td>Dilution Threshold</td>
 *       <td>Min Range (km)</td><td>Rel Velocity (km/s)</td>
 *       <td rowspan=2>Start</td><td rowspan=2>TCA</td><td rowspan=2>Stop</td></tr>
 *   <tr><td>NORAD #</td><td>Object Name</td><td>Days Since Epoch</td>
 *       <td>Max Prob</td><td>Dilution Threshold</td>... (secondary object)
 *
 * Rather than build an HTML parser in an edge worker, we scrape with
 * targeted regex over the cell-stripped text. The format is forgiving
 * because numeric fields (NORAD, range, velocity, TCA) are
 * structurally distinguishable from each other.
 */
function parseSocratesHtml(html) {
    // Reduce all whitespace, drop tags, keep TD boundaries.
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = cellRe.exec(html)) !== null) {
        const txt = m[1]
            .replace(/<[^>]+>/g, ' ')           // strip nested tags (links)
            .replace(/&nbsp;/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        cells.push(txt);
    }

    // Each conjunction emits ~17 cells (10 for primary row, 7 for
    // the secondary row that shares the rowspan'd Start/TCA/Stop).
    // We slide a window and look for paired NORAD numbers.
    const conjunctions = [];
    const isNorad = (s) => /^\d{4,6}$/.test(s);
    const isFloat = (s) => /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(s);

    for (let i = 0; i < cells.length - 12; i++) {
        // Primary header: [norad1, name1, daysSinceEpoch, maxProb, dilution,
        //                  minRangeKm, relVelKmS, start, tca, stop]
        if (!isNorad(cells[i])) continue;
        const norad1 = +cells[i];
        const name1  = cells[i + 1];
        if (!name1) continue;

        // Secondary row begins after the 10 primary cells. Confirm by
        // requiring another NORAD number 10 cells out.
        const j = i + 10;
        if (j + 1 >= cells.length) continue;
        if (!isNorad(cells[j])) continue;
        const norad2 = +cells[j];
        const name2  = cells[j + 1];

        // Numeric fields from the primary row.
        const maxProbRaw = cells[i + 3];
        const minRangeStr = cells[i + 5];
        const relVelStr   = cells[i + 6];
        const tcaStr      = cells[i + 8];

        if (!isFloat(minRangeStr) || !isFloat(relVelStr)) continue;

        // SOCRATES TCA format: "YYYY MMM DD HH:MM:SS.sss" (UTC).
        // Convert to ISO. Be permissive — fall back to the raw string
        // if parsing fails so the UI can still show something.
        let tcaIso = null;
        const t = parseSocratesUtc(tcaStr);
        if (t) tcaIso = t.toISOString();

        const maxProb = isFloat(maxProbRaw) ? +maxProbRaw : null;

        conjunctions.push({
            primary:   { norad: norad1, name: name1 },
            secondary: { norad: norad2, name: name2 },
            tca:        tcaIso ?? tcaStr,
            minRangeKm: +minRangeStr,
            relVelKmS:  +relVelStr,
            maxProb,
        });

        // Skip past this record. Primary header is 10 cells + secondary
        // body is 7 cells = 17 cells per conjunction.
        i = j + 6;
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

export default async function handler(request) {
    const url = new URL(request.url);
    const sortParam = (url.searchParams.get('sort') || 'range').toLowerCase();
    const sort = sortParam === 'prob' ? 'prob' : 'range';
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '25', 10) || 25));

    const upstream = SORT_URLS[sort];

    let html;
    try {
        const res = await fetchWithTimeout(upstream, {
            headers: {
                'User-Agent': 'ParkerPhysics/1.0 (aristotle-socrates-proxy)',
                'Accept': 'text/html,application/xhtml+xml',
            },
        });
        if (!res.ok) throw new Error(`SOCRATES HTTP ${res.status}`);
        html = await res.text();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'CelesTrak SOCRATES' });
    }

    if (!html || html.length < 500) {
        return jsonError('empty_response', 'SOCRATES returned an unexpectedly small payload',
            { source: 'CelesTrak SOCRATES' });
    }

    const all = parseSocratesHtml(html);
    if (all.length === 0) {
        // Don't 503 — return success with a flagged empty list and the
        // raw HTML byte size so the UI can warn that the parser may
        // need updating without breaking the page.
        return jsonOk({
            source: 'CelesTrak SOCRATES',
            sort,
            fetched: new Date().toISOString(),
            conjunctions: [],
            warning: 'parser-no-rows',
            rawHtmlBytes: html.length,
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
