/**
 * api/_lib/ap45.js — single source for the SWPC 45-day Ap + F10.7 forecast.
 *
 * WHY THIS EXISTS (read before "simplifying" back to one URL):
 * NOAA retired the USAF product `text/45-day-ap-forecast.txt` on 2026-03-01
 * (Service Change Notice 26-10). The legacy URL now returns HTTP 404, which
 * silently broke every consumer pointing at it — the aurora_outlook cron sat
 * at 36 consecutive failures ("compute failed: 45-day HTTP 404") and the
 * AurOracle 30-day chart fell back to its synthetic sketch for ALL users,
 * including paying intro+ accounts. The replacement is SWPC-produced and is
 * published in two formats, tried here in order:
 *
 *   1. https://services.swpc.noaa.gov/json/45-day-forecast.json   (primary)
 *   2. https://services.swpc.noaa.gov/text/45-day-forecast.txt    (new text)
 *   3. https://services.swpc.noaa.gov/text/45-day-ap-forecast.txt (legacy —
 *      kept last in case NOAA restores a redirect; costs one fast 404)
 *
 * Consumers: api/_lib/aurora-outlook.js (Ap → Kp for the AurOracle month
 * outlook), api/noaa/ap-history.js (predicted Ap ticks), and
 * api/noaa/f107-history.js (predicted F10.7 for the centred 81-day average).
 *
 * Parsers are exported individually because CI cannot reach NOAA — see
 * tests/aurora-outlook-parsers.mjs for the fixture-driven contract.
 */
import { fetchWithTimeout } from './responses.js';

export const AP45_JSON        = 'https://services.swpc.noaa.gov/json/45-day-forecast.json';
export const AP45_TEXT        = 'https://services.swpc.noaa.gov/text/45-day-forecast.txt';
export const AP45_LEGACY_TEXT = 'https://services.swpc.noaa.gov/text/45-day-ap-forecast.txt';

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
                 JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

const utcDayMs = ms => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

/** Plausibility clamps — reject parsed garbage rather than forecasting it. */
const plausibleAp   = v => Number.isFinite(v) && v >= 0 && v <= 400;
const plausibleF107 = v => Number.isFinite(v) && v >= 40 && v <= 500;

/** Parse a date-ish value ("2026-07-07", "2026-07-07T00:00:00Z",
 *  "2026-07-07 00:00:00") to UTC-midnight ms, or NaN. */
function parseDayMs(v) {
    if (v == null) return NaN;
    const s = String(v).trim();
    const ts = Date.parse(s.length === 10 ? s + 'T00:00:00Z'
        : s.replace(' ', 'T') + (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s) ? '' : 'Z'));
    return Number.isFinite(ts) ? utcDayMs(ts) : NaN;
}

/**
 * Parse the SWPC 45-day JSON product → [{ t, ap, f107 }] (t = UTC midnight ms).
 *
 * Field names are matched loosely on purpose: the product is new (March 2026)
 * and SWPC's JSON-format SCN (26-21) reshaped several feeds shortly after
 * launch, so we accept both array-of-objects (date/ap/f107-ish keys) and the
 * products-style 2-D array with a header row. Numeric strings are tolerated.
 */
export function parseForecastJson(raw) {
    // Unwrap a single-level envelope ({ forecast: [...] } / { days: [...] } /
    // { data: [...] }) — cheap insurance against SWPC nesting the array.
    if (raw && !Array.isArray(raw) && typeof raw === 'object') {
        const inner = ['forecast', 'days', 'data', 'rows'].map(k => raw[k]).find(Array.isArray);
        if (inner) raw = inner;
    }
    if (!Array.isArray(raw) || raw.length === 0) return [];

    const isDateKey = k => /time|date|day/i.test(k);
    const isApKey   = k => /^ap($|[^a-z])|(_|\b)ap$|predicted_ap|ap_index/i.test(k);
    const isF107Key = k => /f10\.?_?7|flux/i.test(k);

    let rows;
    if (Array.isArray(raw[0])) {
        // 2-D array: first row is the header.
        const head = raw[0].map(String);
        const tCol = head.findIndex(isDateKey);
        const aCol = head.findIndex(isApKey);
        const fCol = head.findIndex(isF107Key);
        if (tCol < 0 || (aCol < 0 && fCol < 0)) return [];
        rows = raw.slice(1).map(r => ({
            t: parseDayMs(r[tCol]),
            ap:   aCol >= 0 ? parseFloat(r[aCol]) : NaN,
            f107: fCol >= 0 ? parseFloat(r[fCol]) : NaN,
        }));
    } else if (typeof raw[0] === 'object' && raw[0] !== null) {
        const keys = Object.keys(raw[0]);
        const tKey = keys.find(isDateKey);
        const aKey = keys.find(isApKey);
        const fKey = keys.find(isF107Key);
        if (!tKey || (!aKey && !fKey)) return [];
        rows = raw.map(r => ({
            t: parseDayMs(r[tKey]),
            ap:   aKey ? parseFloat(r[aKey]) : NaN,
            f107: fKey ? parseFloat(r[fKey]) : NaN,
        }));
    } else {
        return [];
    }

    return rows
        .map(r => ({
            t: r.t,
            ap:   plausibleAp(r.ap)     ? r.ap   : null,
            f107: plausibleF107(r.f107) ? r.f107 : null,
        }))
        .filter(r => Number.isFinite(r.t) && (r.ap != null || r.f107 != null))
        .sort((a, b) => a.t - b.t);
}

/**
 * Extract one date+value section of the 45-day text product. Two token
 * styles are accepted, because the product has used both:
 *   "20Jan26 010"  — legacy USAF 45DF layout (DDMmmYY, 2-digit year attached)
 *   "20 JAN 010"   — spaced layout (year taken from the :Issued: line,
 *                    with a Dec→Jan wrap guard)
 */
function parseTextSection(lines, headerRe, nowMs, plausible) {
    const headerIdx = lines.findIndex(l => headerRe.test(l));
    if (headerIdx < 0) return new Map();

    let baseYear = new Date(nowMs).getUTCFullYear();
    const issued = lines.find(l => /^:Issued:/i.test(l));
    if (issued) { const m = issued.match(/(\d{4})/); if (m) baseYear = +m[1]; }

    const tripletRe = /(\d{1,2})\s*([A-Za-z]{3})(\d{2})?\s+(\d{1,4})\b/g;
    const byDay = new Map();
    let seenData = false;
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line || /^\s*$/.test(line)) { if (seenData) break; continue; }
        // Section break: the next "45-DAY …" section header (which starts
        // with a digit, so the all-caps check below never catches it), or
        // any other all-caps header line.
        if (/45-DAY/i.test(line)) { if (seenData) break; continue; }
        if (/^[A-Z][A-Z\s.-]+$/.test(line.trim()) && !/^\d/.test(line.trim())) {
            if (seenData) break; continue;
        }
        let m;
        tripletRe.lastIndex = 0;
        while ((m = tripletRe.exec(line)) != null) {
            const day = +m[1], mon = MONTHS[m[2].toUpperCase()], yy = m[3], val = +m[4];
            if (mon === undefined || !plausible(val)) continue;
            let ts;
            if (yy != null) {
                ts = Date.UTC(2000 + +yy, mon, day);
            } else {
                // Year wrap: the file straddles Dec 31 in early January.
                ts = Date.UTC(baseYear, mon, day);
                if (ts < nowMs - 60 * 86400000) ts = Date.UTC(baseYear + 1, mon, day);
            }
            byDay.set(ts, val);
            seenData = true;
        }
    }
    return byDay;
}

/**
 * Parse the 45-day TEXT product (new SWPC file or the legacy USAF layout —
 * both use the same two "45-DAY …" sections of DD MMM NNN triplets)
 * → [{ t, ap, f107 }] sorted ascending.
 */
export function parseForecastText(text, nowMs = Date.now()) {
    if (!text || typeof text !== 'string') return [];
    const lines = text.split(/\r?\n/);
    const ap    = parseTextSection(lines, /45-DAY\s+AP\s+FORECAST/i,  nowMs, plausibleAp);
    const f107  = parseTextSection(lines, /45-DAY\s+F10\.?7/i,        nowMs, plausibleF107);
    const days  = [...new Set([...ap.keys(), ...f107.keys()])].sort((a, b) => a - b);
    return days.map(t => ({ t, ap: ap.get(t) ?? null, f107: f107.get(t) ?? null }));
}

/**
 * Fetch the 45-day forecast, trying JSON → new text → legacy text.
 *
 * @param {number} [nowMs]
 * @returns {Promise<{ rows: Array<{t:number, ap:number|null, f107:number|null}>,
 *                     source: '45-day-forecast.json'|'45-day-forecast.txt'|'45-day-ap-forecast.txt' }>}
 * @throws when every source fails or parses to zero rows
 */
export async function fetch45DayForecast(nowMs = Date.now()) {
    const attempts = [
        { url: AP45_JSON, source: '45-day-forecast.json', accept: 'application/json',
          parse: async res => parseForecastJson(await res.json()) },
        { url: AP45_TEXT, source: '45-day-forecast.txt', accept: 'text/plain',
          parse: async res => parseForecastText(await res.text(), nowMs) },
        { url: AP45_LEGACY_TEXT, source: '45-day-ap-forecast.txt', accept: 'text/plain',
          parse: async res => parseForecastText(await res.text(), nowMs) },
    ];
    const errors = [];
    for (const a of attempts) {
        try {
            const res = await fetchWithTimeout(a.url, { headers: { Accept: a.accept } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const rows = await a.parse(res);
            if (rows.length) return { rows, source: a.source };
            throw new Error('parsed 0 rows');
        } catch (e) {
            errors.push(`${a.source}: ${e.message}`);
        }
    }
    throw new Error(`45-day forecast unavailable (${errors.join('; ')})`);
}
