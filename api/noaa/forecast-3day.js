/**
 * Vercel Edge Function: /api/noaa/forecast-3day
 *
 * Source: NOAA SWPC 3-day geomagnetic (Kp) forecast.
 *   Primary:  https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json
 *   Fallback: https://services.swpc.noaa.gov/text/3-day-forecast.txt (parsed loosely)
 *
 * SWPC issues this product 3x/day (0030, 1230, 2130 UTC). Kp values are given
 * for 8 3-hour bins per day over the next 3 days — 24 points total, each a
 * central estimate (no published uncertainty).
 *
 * Response shape:
 *   {
 *     source, age_min, freshness,
 *     data: {
 *       issued:  ISO string,
 *       entries: [ { t_utc: ISO, t_hours_from_now: number, kp: number, source_label } ]
 *     }
 *   }
 */
import { jsonOk, jsonError, fetchWithTimeout, isoTag } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SWPC_JSON = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json';
const SWPC_TEXT = 'https://services.swpc.noaa.gov/text/3-day-forecast.txt';

const CACHE_TTL = 600;   // 10 min — SWPC reissues 3x/day, so 10 min cap is ample
const CACHE_SWR = 300;   // 5 min stale-while-revalidate

function freshnessStatus(ageMin) {
    if (ageMin == null) return 'missing';
    if (ageMin < 60 * 4)  return 'fresh';     // <4h: normal (issues every 8h)
    if (ageMin < 60 * 12) return 'stale';
    return 'expired';
}

// ── JSON parser ─────────────────────────────────────────────────────────────
//
// SWPC's noaa-planetary-k-index-forecast.json is a "table" format:
//   [
//     ["model_prediction_time", "kp", "observed", "noaa_scale"],
//     ["2026-04-22 00:00:00",    "2",  "",         ""],
//     ...
//   ]
// Rows where `observed` is "predicted" are the forward forecast; other rows
// are historical observations SWPC bundles in for context. We take only the
// predicted rows with timestamps strictly in the future.
function parseJson(raw, nowMs) {
    if (!Array.isArray(raw) || raw.length < 2) return null;
    const header = raw[0].map(x => String(x).toLowerCase());
    const tIdx = header.findIndex(h => h.includes('time') || h.includes('tag'));
    const kIdx = header.findIndex(h => h === 'kp' || h.includes('k_index') || h.includes('kp_value'));
    const oIdx = header.findIndex(h => h.includes('observed'));
    if (tIdx < 0 || kIdx < 0) return null;

    const entries = [];
    for (let i = 1; i < raw.length; i++) {
        const row = raw[i];
        if (!Array.isArray(row)) continue;
        const tRaw = row[tIdx];
        const kRaw = row[kIdx];
        const observed = oIdx >= 0 ? String(row[oIdx] ?? '').toLowerCase() : '';
        // Only keep predicted rows (skip historical/observed)
        if (observed && observed !== 'predicted') continue;

        const iso = isoTag(tRaw);
        if (!iso) continue;
        const ts = new Date(iso).getTime();
        if (!Number.isFinite(ts) || ts <= nowMs - 3 * 3600e3) continue; // drop old bins

        const kp = parseFloat(kRaw);
        if (!Number.isFinite(kp)) continue;

        entries.push({
            t_utc: iso,
            t_hours_from_now: +(((ts - nowMs) / 3600e3).toFixed(2)),
            kp: Math.round(kp * 10) / 10,
            source_label: 'SWPC-3day',
        });
    }

    if (entries.length === 0) return null;
    return entries;
}

// ── Text fallback parser ────────────────────────────────────────────────────
//
// The human-readable 3-day-forecast.txt bulletin contains a Kp-Index table
// roughly of the form:
//
//     NOAA Kp index breakdown Apr 22-Apr 24
//                   Apr 22     Apr 23     Apr 24
//     00-03UT       2.00       2.33       3.00
//     03-06UT       2.33       2.67       3.33
//     ... (8 bins)
//
// We look for the header line ("NOAA Kp index breakdown"), the date header,
// and then 8 rows of 3 Kp values. This is inherently fragile — only used as
// a fallback when the JSON endpoint fails.
function parseText(text, nowMs) {
    if (typeof text !== 'string' || text.length < 100) return null;

    const lines = text.split(/\r?\n/);
    const breakdownIdx = lines.findIndex(l => /Kp index breakdown/i.test(l));
    if (breakdownIdx < 0) return null;

    // Find the date header — next non-empty line with 3 month-day tokens
    let dateLineIdx = -1;
    const dateTokens = [];
    for (let i = breakdownIdx + 1; i < Math.min(breakdownIdx + 6, lines.length); i++) {
        const matches = lines[i].match(/([A-Z][a-z]{2}\s+\d{1,2})/g);
        if (matches && matches.length >= 3) {
            dateLineIdx = i;
            dateTokens.push(...matches.slice(0, 3));
            break;
        }
    }
    if (dateLineIdx < 0) return null;

    // Parse each day label into a UTC date (assume current year, roll forward if < today)
    const nowDate = new Date(nowMs);
    const year = nowDate.getUTCFullYear();
    const dayStart = dateTokens.map(tok => {
        const d = new Date(`${tok} ${year} 00:00:00 UTC`);
        if (!Number.isFinite(d.getTime())) return null;
        // If parsed date is >180 days before now, assume next year (Dec→Jan wrap)
        if (d.getTime() < nowMs - 180 * 86400e3) d.setUTCFullYear(year + 1);
        return d.getTime();
    });

    const entries = [];
    const binRe = /^(\d{2})-(\d{2})UT\s+([\d.]+)\s*(?:\([A-Z0-9]+\))?\s+([\d.]+)\s*(?:\([A-Z0-9]+\))?\s+([\d.]+)/i;
    for (let i = dateLineIdx + 1; i < Math.min(dateLineIdx + 12, lines.length); i++) {
        const m = lines[i].match(binRe);
        if (!m) continue;
        const binStartH = parseInt(m[1], 10);
        const kps = [parseFloat(m[3]), parseFloat(m[4]), parseFloat(m[5])];
        for (let d = 0; d < 3; d++) {
            if (!Number.isFinite(kps[d]) || dayStart[d] == null) continue;
            const ts = dayStart[d] + binStartH * 3600e3;
            if (ts <= nowMs - 3 * 3600e3) continue;
            entries.push({
                t_utc: new Date(ts).toISOString(),
                t_hours_from_now: +(((ts - nowMs) / 3600e3).toFixed(2)),
                kp: Math.round(kps[d] * 10) / 10,
                source_label: 'SWPC-3day',
            });
        }
    }
    entries.sort((a, b) => a.t_hours_from_now - b.t_hours_from_now);
    return entries.length ? entries : null;
}

export default async function handler() {
    const nowMs = Date.now();

    // ── Try primary JSON source ─────────────────────────────────────────────
    let entries = null;
    let usedSource = null;
    let issuedMs = null;

    try {
        const res = await fetchWithTimeout(SWPC_JSON, { headers: { Accept: 'application/json' } });
        if (res.ok) {
            const raw = await res.json();
            entries = parseJson(raw, nowMs);
            if (entries) {
                usedSource = 'json';
                // Issued time = earliest predicted bin minus epsilon — SWPC's
                // products JSON has no issued-at field, so approximate from
                // the first bin.
                const firstTs = new Date(entries[0].t_utc).getTime();
                issuedMs = firstTs - 3 * 3600e3;
            }
        }
    } catch (_) {
        // Fall through to text fallback
    }

    // ── Fallback to text bulletin ───────────────────────────────────────────
    if (!entries) {
        try {
            const res = await fetchWithTimeout(SWPC_TEXT, { headers: { Accept: 'text/plain' } });
            if (res.ok) {
                const text = await res.text();
                entries = parseText(text, nowMs);
                if (entries) {
                    usedSource = 'text';
                    // Try to extract "Issued: YYYY Mon DD HHMM UTC" from header
                    const m = text.match(/Issued[:\s]+(\d{4}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{4}\s*UTC)/);
                    if (m) {
                        const d = new Date(m[1].replace(
                            /(\d{4})\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2})(\d{2})\s*UTC/,
                            '$1 $2 $3 $4:$5 UTC',
                        ));
                        if (Number.isFinite(d.getTime())) issuedMs = d.getTime();
                    }
                }
            }
        } catch (_) {
            // Both sources failed
        }
    }

    if (!entries || entries.length === 0) {
        return jsonError('upstream_unavailable',
            'SWPC 3-day forecast unavailable (both JSON and text endpoints failed)',
            { source: 'NOAA SWPC' });
    }

    const issuedISO = issuedMs ? new Date(issuedMs).toISOString() : null;
    const ageMin = issuedMs ? (nowMs - issuedMs) / 60_000 : null;

    return jsonOk({
        source: `NOAA SWPC 3-day Kp forecast (${usedSource}) via Vercel Edge`,
        age_min: ageMin != null ? Math.round(ageMin * 10) / 10 : null,
        freshness: freshnessStatus(ageMin),
        data: {
            issued: issuedISO,
            entries,
        },
        units: { kp: '0–9 (NOAA G-scale, 3-hour bins)' },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
