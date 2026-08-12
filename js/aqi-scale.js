/**
 * aqi-scale.js — the SINGLE SOURCE OF TRUTH for US EPA Air Quality Index
 * conversion on this site. Pure: no DOM, no fetch, no ambient time.
 *
 * WHY THIS EXISTS: before this module, three different places converted a
 * pollutant concentration into an AQI-like number, and all three disagreed:
 *
 *   js/air-quality-frame.js  a hand-rolled piecewise formula whose middle
 *                            band had a 2× slope error (PM2.5 35 µg/m³ scored
 *                            148 instead of 99 — a full category too severe)
 *                            and whose top band was unbounded linear.
 *   pollution.html           `AQI ≈ PM2.5 × 2` and `PM2.5 ≈ AQI / 2`, which is
 *                            2.8× high at clean-air levels and 0.67× low at
 *                            hazardous ones.
 *   (implicitly) upstream    Open-Meteo's `us_aqi`, which is computed
 *                            CORRECTLY — see the note on averaging below.
 *
 * Every conversion now routes here. If a surface disagrees with another about
 * what "unhealthy" means, that is a bug in the caller, not a second opinion.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE USING IT — the averaging period is part of the definition
 * ───────────────────────────────────────────────────────────────────────────
 * EPA breakpoints are NOT defined on instantaneous concentrations. Each table
 * below is defined on a specific averaging window (24 h for PM, 8 h for O₃
 * and CO, 1 h for NO₂ and SO₂), and `averagingHours` on every spec records it.
 * Feeding a single hour's concentration into the 24 h PM table produces a
 * number with no defined meaning — it is not "the AQI right now."
 *
 * For real-time reporting from hourly data, EPA uses NowCast (a weighted
 * trailing mean that reacts faster than a flat 24 h average), which is what
 * AirNow publishes. This module deliberately does NOT silently substitute one
 * for the other: `subIndex`/`aqiFromConcentration` take an already-averaged
 * concentration, and `nowcastAqi` takes raw hourly series and does the
 * averaging itself. Pick the one that matches the data you hold.
 *
 * Reference: 40 CFR Part 58 Appendix G, and EPA-454/B-24-002 "Technical
 * Assistance Document for the Reporting of Daily Air Quality". The PM2.5
 * table is the MAY 2024 REVISION (Good tops out at 9.0 µg/m³, not the old
 * 12.0). Open-Meteo's upstream `us_aqi` uses this same revised table, so a
 * disagreement between our number and theirs is ours to explain.
 */

/** AQI is capped at 500; concentrations above the top breakpoint clamp here. */
export const AQI_MAX = 500;

/**
 * The six EPA categories. `max` is inclusive. Colors are the site's existing
 * stops, moved here unchanged so the palette has one home — every previous
 * caller of airQualityMetricColor keeps its exact pixels.
 */
export const AQI_CATEGORIES = Object.freeze([
    Object.freeze({ max: 50,  key: 'good',      name: 'Good',                           rgb: Object.freeze([0.10, 0.88, 0.48]) }),
    Object.freeze({ max: 100, key: 'moderate',  name: 'Moderate',                       rgb: Object.freeze([1.00, 0.86, 0.18]) }),
    Object.freeze({ max: 150, key: 'sensitive', name: 'Unhealthy for Sensitive Groups', rgb: Object.freeze([1.00, 0.49, 0.05]) }),
    Object.freeze({ max: 200, key: 'unhealthy', name: 'Unhealthy',                      rgb: Object.freeze([1.00, 0.15, 0.18]) }),
    Object.freeze({ max: 300, key: 'very',      name: 'Very Unhealthy',                 rgb: Object.freeze([0.62, 0.25, 0.78]) }),
    Object.freeze({ max: AQI_MAX, key: 'hazardous', name: 'Hazardous',                  rgb: Object.freeze([0.55, 0.04, 0.18]) }),
]);

/** Shared "no data" gray. Not a category — absence of one. */
export const NO_DATA_RGB = Object.freeze([0.34, 0.39, 0.46]);

/**
 * Molar volume of an ideal gas at EPA's standard conditions, 25 °C and
 * 1 atm, in L/mol. NOTE: WHO guideline documents use 20 °C (24.05), which is
 * why a µg/m³ value converted for a WHO comparison and the same value
 * converted for an EPA sub-index differ by ~1.7%. These tables are EPA's, so
 * 25 °C is correct here.
 */
export const MOLAR_VOLUME_25C = 24.45;

/**
 * Pollutant registry. `breakpoints` rows are [cLo, cHi, iLo, iHi] in the
 * pollutant's EPA unit. `decimals` is the EPA-mandated truncation applied to
 * the concentration BEFORE the equation (truncation, not rounding — 9.09
 * µg/m³ of PM2.5 is 9.0, which is Good, not 9.1, which is Moderate).
 * `molarMass` (g/mol) enables µg/m³ → ppm/ppb for the gases; null for the
 * particulates, which EPA already defines in µg/m³.
 */
export const AQI_POLLUTANTS = Object.freeze({
    pm25: Object.freeze({
        label: 'PM2.5', epaUnit: 'µg/m³', averagingHours: 24, decimals: 1, molarMass: null,
        realtime: Object.freeze({ method: 'nowcast', hours: 12 }),
        breakpoints: Object.freeze([
            [0.0,   9.0,     0,  50],
            [9.1,   35.4,   51, 100],
            [35.5,  55.4,  101, 150],
            [55.5,  125.4, 151, 200],
            [125.5, 225.4, 201, 300],
            [225.5, 325.4, 301, 500],
        ]),
    }),
    pm10: Object.freeze({
        label: 'PM10', epaUnit: 'µg/m³', averagingHours: 24, decimals: 0, molarMass: null,
        realtime: Object.freeze({ method: 'nowcast', hours: 12 }),
        breakpoints: Object.freeze([
            [0,   54,    0,  50],
            [55,  154,  51, 100],
            [155, 254, 101, 150],
            [255, 354, 151, 200],
            [355, 424, 201, 300],
            [425, 604, 301, 500],
        ]),
    }),
    // O₃ has two tables. The 8-hour table is authoritative up to AQI 300; the
    // 1-hour table only reports AQI ≥ 101 and exists because short violent
    // ozone episodes are invisible to an 8-hour mean. compositeAqi() applies
    // EPA's "take the larger" rule.
    o3_8h: Object.freeze({
        label: 'O₃ (8 h)', epaUnit: 'ppm', averagingHours: 8, decimals: 3, molarMass: 48.00,
        realtime: Object.freeze({ method: 'mean', hours: 8 }),
        breakpoints: Object.freeze([
            [0.000, 0.054,   0,  50],
            [0.055, 0.070,  51, 100],
            [0.071, 0.085, 101, 150],
            [0.086, 0.105, 151, 200],
            [0.106, 0.200, 201, 300],
        ]),
    }),
    o3_1h: Object.freeze({
        label: 'O₃ (1 h)', epaUnit: 'ppm', averagingHours: 1, decimals: 3, molarMass: 48.00,
        realtime: Object.freeze({ method: 'mean', hours: 1 }),
        reportsFrom: 101,
        breakpoints: Object.freeze([
            [0.125, 0.164, 101, 150],
            [0.165, 0.204, 151, 200],
            [0.205, 0.404, 201, 300],
            [0.405, 0.604, 301, 500],
        ]),
    }),
    co: Object.freeze({
        label: 'CO', epaUnit: 'ppm', averagingHours: 8, decimals: 1, molarMass: 28.010,
        realtime: Object.freeze({ method: 'mean', hours: 8 }),
        breakpoints: Object.freeze([
            [0.0,   4.4,   0,  50],
            [4.5,   9.4,  51, 100],
            [9.5,  12.4, 101, 150],
            [12.5, 15.4, 151, 200],
            [15.5, 30.4, 201, 300],
            [30.5, 50.4, 301, 500],
        ]),
    }),
    // SO₂ also splits: 1-hour up to AQI 200, then EPA switches to the 24-hour
    // mean for 201+. A 1-hour reading above 304 ppb cannot be scored without
    // the 24-hour value, and this module says so rather than guessing.
    so2_1h: Object.freeze({
        label: 'SO₂ (1 h)', epaUnit: 'ppb', averagingHours: 1, decimals: 0, molarMass: 64.066,
        realtime: Object.freeze({ method: 'mean', hours: 1 }),
        reportsTo: 200,
        breakpoints: Object.freeze([
            [0,   35,    0,  50],
            [36,  75,   51, 100],
            [76,  185, 101, 150],
            [186, 304, 151, 200],
        ]),
    }),
    so2_24h: Object.freeze({
        label: 'SO₂ (24 h)', epaUnit: 'ppb', averagingHours: 24, decimals: 0, molarMass: 64.066,
        realtime: Object.freeze({ method: 'mean', hours: 24 }),
        reportsFrom: 201,
        breakpoints: Object.freeze([
            [305, 604,  201, 300],
            [605, 1004, 301, 500],
        ]),
    }),
    no2: Object.freeze({
        label: 'NO₂', epaUnit: 'ppb', averagingHours: 1, decimals: 0, molarMass: 46.0055,
        realtime: Object.freeze({ method: 'mean', hours: 1 }),
        breakpoints: Object.freeze([
            [0,    53,   0,  50],
            [54,   100, 51, 100],
            [101,  360, 101, 150],
            [361,  649, 151, 200],
            [650,  1249, 201, 300],
            [1250, 2049, 301, 500],
        ]),
    }),
});

/** EPA truncation: drop digits beyond `decimals`, never round up. */
export function truncate(value, decimals) {
    if (!Number.isFinite(value)) return null;
    const scale = 10 ** decimals;
    // Nudge by a float-epsilon before flooring so a value that is 34.99999999
    // purely from binary representation of 35.0 does not truncate to 34.9.
    return Math.floor(value * scale + 1e-9) / scale;
}

const MASS_TO_UG = Object.freeze({ 'ug/m3': 1, 'mg/m3': 1000 });
const PPB_PER = Object.freeze({ ppm: 1000, ppb: 1 });

/**
 * Single conversion core. Mass ↔ volume-mixing-ratio needs the molar mass, so
 * it is only defined for the gases; asking for it on a particulate returns
 * null rather than a plausible-looking number.
 *
 * Both public wrappers below route through here — the matrix exists once, so
 * the two directions cannot disagree.
 */
function convert(spec, value, fromUnit, toUnit) {
    const from = normalizeUnit(fromUnit);
    const to = normalizeUnit(toUnit);
    if (from == null || to == null || !Number.isFinite(value)) return null;
    if (from === to) return value;

    const isMass = u => u in MASS_TO_UG;
    const isVol = u => u in PPB_PER;

    if (isMass(from) && isMass(to)) return value * MASS_TO_UG[from] / MASS_TO_UG[to];
    if (isVol(from) && isVol(to)) return value * PPB_PER[from] / PPB_PER[to];
    if (!spec.molarMass) return null;               // particulate: no gas conversion
    if (isMass(from) && isVol(to)) {
        const ppb = value * MASS_TO_UG[from] * MOLAR_VOLUME_25C / spec.molarMass;
        return ppb / PPB_PER[to];
    }
    // isVol(from) && isMass(to)
    const ug = value * PPB_PER[from] * spec.molarMass / MOLAR_VOLUME_25C;
    return ug / MASS_TO_UG[to];
}

/**
 * Convert a concentration into a pollutant's EPA unit.
 * Accepts 'µg/m³' (or 'ug/m3'), 'mg/m³', 'ppm', 'ppb'. Returns null when the
 * conversion is undefined (e.g. µg/m³ → ppm for a particulate).
 */
export function toEpaUnit(pollutantKey, value, unit) {
    const spec = AQI_POLLUTANTS[pollutantKey];
    if (!spec || !Number.isFinite(value)) return null;
    return convert(spec, value, unit ?? spec.epaUnit, spec.epaUnit);
}

/** EPA unit → an arbitrary supported unit (inverse of toEpaUnit). */
export function fromEpaUnit(pollutantKey, value, unit) {
    const spec = AQI_POLLUTANTS[pollutantKey];
    if (!spec || !Number.isFinite(value)) return null;
    if (unit == null) return value;
    return convert(spec, value, spec.epaUnit, unit);
}

function normalizeUnit(unit) {
    if (unit == null) return null;
    const u = String(unit).toLowerCase().trim()
        .replace(/µ/g, 'u').replace(/μ/g, 'u').replace(/³/g, '3').replace(/\s|\^/g, '');
    if (u === 'ug/m3' || u === 'ugm3' || u === 'microgram/m3') return 'ug/m3';
    if (u === 'mg/m3' || u === 'mgm3') return 'mg/m3';
    if (u === 'ppm') return 'ppm';
    if (u === 'ppb') return 'ppb';
    return null;
}

/**
 * Concentration → EPA sub-index, with provenance about how it was resolved.
 *
 * @param {string} pollutantKey  key into AQI_POLLUTANTS
 * @param {number} value         concentration, ALREADY averaged over the
 *                               pollutant's `averagingHours` window
 * @param {object} [opts]
 * @param {string} [opts.unit]   unit of `value`; defaults to the EPA unit
 * @returns {{aqi: number|null, clamped: boolean, belowTable: boolean, note: string|null}}
 */
export function subIndex(pollutantKey, value, { unit } = {}) {
    const spec = AQI_POLLUTANTS[pollutantKey];
    const miss = note => ({ aqi: null, clamped: false, belowTable: false, note });
    if (!spec) return miss(`unknown pollutant "${pollutantKey}"`);
    if (!Number.isFinite(value)) return miss('non-finite concentration');

    const converted = toEpaUnit(pollutantKey, value, unit);
    if (converted == null) {
        return miss(`cannot convert ${unit ?? '?'} to ${spec.epaUnit} for ${pollutantKey}`);
    }
    if (converted < 0) return miss('negative concentration');

    const c = truncate(converted, spec.decimals);
    const rows = spec.breakpoints;

    // Below a partial table's floor (o3_1h, so2_24h) the pollutant simply does
    // not report at that level — that is not zero, and not an error.
    if (c < rows[0][0]) {
        return spec.reportsFrom
            ? { aqi: null, clamped: false, belowTable: true,
                note: `${pollutantKey} only reports AQI ≥ ${spec.reportsFrom}` }
            : { aqi: 0, clamped: false, belowTable: false, note: null };
    }

    for (const [cLo, cHi, iLo, iHi] of rows) {
        if (c <= cHi) {
            const aqi = Math.round((iHi - iLo) / (cHi - cLo) * (c - cLo) + iLo);
            return { aqi, clamped: false, belowTable: false, note: null };
        }
    }

    // Above the top row. For a table that tops out at 500 this is a genuine
    // clamp; for a partial table (o3_8h ends at 300, so2_1h at 200) it means
    // the caller must supply the companion averaging window instead.
    const top = rows[rows.length - 1];
    if (spec.reportsTo || top[3] < AQI_MAX) {
        return { aqi: top[3], clamped: true, belowTable: false,
            note: `${pollutantKey} exceeds its table; the companion averaging window is required above AQI ${top[3]}` };
    }
    return { aqi: AQI_MAX, clamped: true, belowTable: false,
        note: `concentration above the top breakpoint; AQI capped at ${AQI_MAX}` };
}

/** Convenience wrapper: just the integer sub-index, or null. */
export function aqiFromConcentration(pollutantKey, value, opts) {
    return subIndex(pollutantKey, value, opts).aqi;
}

/**
 * Inverse: AQI → the concentration at that index, in the pollutant's EPA unit
 * (or `opts.unit` if given). This is what replaces `PM2.5 ≈ AQI / 2`.
 */
export function concentrationFromAqi(pollutantKey, aqi, { unit } = {}) {
    const spec = AQI_POLLUTANTS[pollutantKey];
    if (!spec || !Number.isFinite(aqi)) return null;
    const rows = spec.breakpoints;
    if (aqi < rows[0][2]) return null;
    for (const [cLo, cHi, iLo, iHi] of rows) {
        if (aqi <= iHi) {
            const c = (aqi - iLo) * (cHi - cLo) / (iHi - iLo) + cLo;
            return unit ? fromEpaUnit(pollutantKey, c, unit) : c;
        }
    }
    const top = rows[rows.length - 1];
    return unit ? fromEpaUnit(pollutantKey, top[1], unit) : top[1];
}

/**
 * Composite AQI = the LARGEST sub-index across reported pollutants, with the
 * pollutant that produced it. This is EPA's definition: the AQI is not an
 * average of pollutants, it is the worst one, and naming it is the point.
 *
 * @param {object} readings  { pm25, pm10, o3_8h, o3_1h, co, so2_1h, so2_24h,
 *                             no2 } — each already averaged over its window.
 *                            Omit what you do not have; nulls are skipped.
 * @param {object} [opts]
 * @param {string|object} [opts.unit]  one unit for all, or per-pollutant map
 * @returns {{aqi: number|null, dominant: string|null, category: object|null,
 *            subIndices: object, notes: string[]}}
 */
export function compositeAqi(readings = {}, { unit } = {}) {
    const subIndices = {};
    const notes = [];
    let aqi = null, dominant = null;

    for (const key of Object.keys(AQI_POLLUTANTS)) {
        if (!(key in readings)) continue;
        const u = typeof unit === 'object' && unit !== null ? unit[key] : unit;
        const r = subIndex(key, readings[key], { unit: u });
        if (r.note) notes.push(r.note);
        if (r.aqi == null) continue;
        subIndices[key] = r.aqi;
        if (aqi == null || r.aqi > aqi) { aqi = r.aqi; dominant = key; }
    }

    return { aqi, dominant, category: aqi == null ? null : categoryForAqi(aqi), subIndices, notes };
}

// ── Real-time reporting: NowCast ───────────────────────────────────────────
//
// The EPA tables above are defined on 24-hour means (PM) and 8-hour means
// (O₃/CO). Those are DAILY reporting definitions. For a "right now" number
// from hourly data, AirNow publishes NowCast: a trailing weighted mean whose
// weight collapses toward the most recent hour when concentrations are moving
// fast, so a smoke plume shows up in an hour instead of being buried under
// eleven clean ones.
//
// PM2.5 and PM10 use the weighted scheme (EPA-454/B-24-002). O₃ and CO use
// straight running means over their EPA windows; NO₂ and SO₂ are 1-hour
// pollutants and need no averaging. Each pollutant's `realtime` descriptor
// above records which applies, so this dispatches from data, not a switch.

const HOUR = 3_600_000;

/** Bucket [{time, value}] into hours-ago 0..hours-1 relative to nowMs. */
function trailingHours(samples, nowMs, hours) {
    const nowHour = Math.floor(nowMs / HOUR) * HOUR;
    const slots = new Array(hours).fill(null);
    for (const s of Array.isArray(samples) ? samples : []) {
        const t = Number(s?.time);
        const v = Number(s?.value);
        if (!Number.isFinite(t) || !Number.isFinite(v) || v < 0) continue;
        const i = Math.round((nowHour - Math.floor(t / HOUR) * HOUR) / HOUR);
        // i === 0 is the current hour; negatives are forecast rows and are
        // never eligible for a "now" value.
        if (i >= 0 && i < hours && slots[i] == null) slots[i] = v;
    }
    return slots;
}

/**
 * EPA NowCast weight factor: w = min/max over the window, floored at 0.5.
 * (EPA states it as 1 − (max−min)/max, which is algebraically min/max.)
 * A flat window gives w = 1 (plain mean); a violently rising one gives 0.5,
 * which puts ~50% of the weight on the most recent hour.
 */
export function nowcastWeight(values) {
    const v = values.filter(x => Number.isFinite(x));
    if (!v.length) return null;
    const max = Math.max(...v);
    if (max <= 0) return 1;            // all-zero window: plain mean, no 0/0
    return Math.max(0.5, Math.min(1, Math.min(...v) / max));
}

/**
 * NowCast over a trailing window. Returns the concentration, not an AQI.
 *
 * EPA validity rule: at least 2 of the 3 most recent hours must be present.
 * Below that the value is not reported — a NowCast built from one stale hour
 * is exactly the kind of number this whole review has been removing.
 */
export function nowcastPm(samples, { nowMs, hours = 12 } = {}) {
    const slots = trailingHours(samples, nowMs, hours);
    const recent = slots.slice(0, 3).filter(v => v != null).length;
    if (recent < 2) {
        return { value: null, valid: false, hoursUsed: 0,
            reason: 'NowCast needs 2 of the 3 most recent hours' };
    }
    const w = nowcastWeight(slots.filter(v => v != null));
    let num = 0, den = 0, used = 0;
    for (let i = 0; i < slots.length; i++) {
        if (slots[i] == null) continue;
        const wi = w ** i;
        num += slots[i] * wi;
        den += wi;
        used++;
    }
    if (!(den > 0)) {
        return { value: null, valid: false, hoursUsed: 0, reason: 'no usable hours' };
    }
    return { value: num / den, valid: true, hoursUsed: used, weight: w, reason: null };
}

/**
 * Straight trailing mean over `hours`, for the pollutants EPA averages flat.
 *
 * Completeness matters as much as it does for NowCast: EPA requires 75% of
 * the hours in an averaging window (6 of 8 for O₃/CO, 18 of 24 for SO₂) for
 * the average to be valid. Without that rule a single hour would be returned
 * as an "8-hour average" and scored against the 8-hour table — which is how
 * a lone ozone reading ends up impersonating a full window.
 */
export function trailingMean(samples, { nowMs, hours = 8 } = {}) {
    const slots = trailingHours(samples, nowMs, hours);
    const present = slots.filter(v => v != null);
    if (slots[0] == null) {
        return { value: null, valid: false, hoursUsed: 0,
            reason: 'the current hour is missing' };
    }
    const required = hours === 1 ? 1 : Math.ceil(0.75 * hours);
    if (present.length < required) {
        return { value: null, valid: false, hoursUsed: present.length,
            reason: `a ${hours}-h mean needs ${required} hours, has ${present.length}` };
    }
    return {
        value: present.reduce((a, b) => a + b, 0) / present.length,
        valid: true, hoursUsed: present.length, reason: null,
    };
}

/**
 * Real-time concentration for one pollutant, dispatched on its `realtime`
 * descriptor. `samples` are [{time, value}] in `unit` (default: EPA unit).
 */
export function realtimeConcentration(pollutantKey, samples, { nowMs, unit } = {}) {
    const spec = AQI_POLLUTANTS[pollutantKey];
    if (!spec) return { value: null, valid: false, hoursUsed: 0, reason: `unknown pollutant "${pollutantKey}"` };
    const rt = spec.realtime ?? { method: 'mean', hours: spec.averagingHours };
    const converted = (Array.isArray(samples) ? samples : []).map(s => ({
        time: s?.time,
        value: unit ? toEpaUnit(pollutantKey, Number(s?.value), unit) : Number(s?.value),
    }));
    const out = rt.method === 'nowcast'
        ? nowcastPm(converted, { nowMs, hours: rt.hours })
        : trailingMean(converted, { nowMs, hours: rt.hours });
    return { ...out, method: rt.method, windowHours: rt.hours };
}

/**
 * Composite NowCast AQI from per-pollutant hourly series.
 *
 * @param {object} series  { pm25: [{time, value}], o3_8h: [...], ... } —
 *                         raw hourly concentrations, NOT pre-averaged.
 * @param {object} opts    { nowMs, unit }  unit may be a string or a
 *                         per-pollutant map, same as compositeAqi.
 * @returns {{aqi, dominant, category, subIndices, methods, notes}}
 */
export function nowcastAqi(series = {}, { nowMs, unit } = {}) {
    const subIndices = {};
    const methods = {};
    const notes = [];
    let aqi = null, dominant = null;

    for (const key of Object.keys(AQI_POLLUTANTS)) {
        if (!Array.isArray(series[key]) || !series[key].length) continue;
        const u = typeof unit === 'object' && unit !== null ? unit[key] : unit;
        const rt = realtimeConcentration(key, series[key], { nowMs, unit: u });
        if (!rt.valid) { if (rt.reason) notes.push(`${key}: ${rt.reason}`); continue; }
        const r = subIndex(key, rt.value);
        if (r.note) notes.push(`${key}: ${r.note}`);
        if (r.aqi == null) continue;
        subIndices[key] = r.aqi;
        methods[key] = { method: rt.method, windowHours: rt.windowHours, hoursUsed: rt.hoursUsed };
        if (aqi == null || r.aqi > aqi) { aqi = r.aqi; dominant = key; }
    }

    return { aqi, dominant, category: aqi == null ? null : categoryForAqi(aqi), subIndices, methods, notes };
}

/** AQI → its EPA category object (null for non-finite / negative input). */
export function categoryForAqi(aqi) {
    if (!Number.isFinite(aqi) || aqi < 0) return null;
    return AQI_CATEGORIES.find(c => aqi <= c.max) ?? AQI_CATEGORIES[AQI_CATEGORIES.length - 1];
}

/**
 * AQI → the site's category color, normalized RGB. Non-finite → gray.
 * Returns a FRESH array: the registry entries are frozen, and callers have
 * historically destructured or held onto the result.
 */
export function aqiColor(aqi) {
    const cat = categoryForAqi(aqi);
    return cat ? [...cat.rgb] : [...NO_DATA_RGB];
}

export default {
    AQI_MAX, AQI_CATEGORIES, AQI_POLLUTANTS, NO_DATA_RGB, MOLAR_VOLUME_25C,
    truncate, toEpaUnit, fromEpaUnit, subIndex, aqiFromConcentration,
    concentrationFromAqi, compositeAqi, categoryForAqi, aqiColor,
    nowcastWeight, nowcastPm, trailingMean, realtimeConcentration, nowcastAqi,
};
