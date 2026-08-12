/**
 * pollution-sources.js — PURE normalizer for a facility-level emissions
 * inventory (Climate TRACE). No DOM, no fetch, no ambient time.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS WRITTEN DEFENSIVELY
 * ─────────────────────────────────────────────────────────────────────────
 * Climate TRACE's API is in BETA and its exact response shape could not be
 * verified when this shipped — the build environment blocks egress to
 * api.climatetrace.org. Rather than hard-code a guessed schema and serve
 * mislabeled numbers, this module RESOLVES its fields at runtime against a
 * table of candidate spellings and REPORTS what it bound to.
 *
 * That is the same posture as api/air-quality/stations-intl.js, whose header
 * records the same problem for OpenAQ's parameter ids: serving mislabeled
 * data is worse than serving none, so a mismatch degrades to stale with a
 * reason that NAMES the actual keys received. Correcting a wrong guess is
 * then a one-line edit to CANDIDATES below, guided by the status page —
 * never a silent relabel.
 *
 * When the real schema is confirmed, keep the resolver. It costs one pass
 * over the first record and it is what turns the next upstream rename from a
 * silent data corruption into a visible amber row.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS DATA IS, AND IS NOT
 * ─────────────────────────────────────────────────────────────────────────
 * Climate TRACE is primarily a GREENHOUSE GAS inventory (CO2, CH4, N2O,
 * CO2e). The site's air-quality surfaces measure PM2.5 / NO2 / SO2 / O3 —
 * different species entirely. A coal plant emits both, so the inventory is
 * excellent for WHERE the large emitters are and HOW BIG they are, but a
 * CO2e tonnage is NOT an air-quality concentration and must never be colored
 * on the EPA AQI scale. `gases` below is deliberately generic: whatever the
 * upstream reports is carried through with its unit, and nothing is
 * converted into anything else.
 *
 * Provenance kind is `inventory` — a THIRD kind alongside the air-quality
 * frame contract's `model` and `observation`. It is estimated and
 * satellite-derived, not stack-measured and not a monitor reading. The three
 * may be displayed together and must never be substituted for one another.
 *
 * LICENCE: Climate TRACE data is CC BY 4.0. The attribution string must ride
 * every response and be visible wherever the data is drawn.
 */

export const CLIMATE_TRACE_ATTRIBUTION = 'Climate TRACE · CC BY 4.0';

export const INVENTORY_PROVENANCE = Object.freeze({
    id: 'climate-trace-assets',
    provider: 'Climate TRACE',
    dataset: 'Facility-level emissions inventory',
    kind: 'inventory',
    label: 'Climate TRACE estimated facility emissions',
    isGroundObservation: false,
    isStackMeasured: false,
    attribution: CLIMATE_TRACE_ATTRIBUTION,
    note: 'Estimated and satellite-derived greenhouse-gas emissions, not an '
        + 'air-quality measurement and not a stack monitor.',
});

/**
 * Candidate key spellings per logical field, most likely first. The resolver
 * takes the FIRST candidate present on the sampled record.
 *
 * `required` fields failing to resolve is a hard error — without them a row
 * cannot be placed on a map or attributed to anything.
 */
export const CANDIDATES = Object.freeze({
    id:      Object.freeze({ required: true,  keys: ['asset_id', 'assetId', 'id', 'source_id', 'sourceId'] }),
    name:    Object.freeze({ required: true,  keys: ['asset_name', 'assetName', 'name', 'source_name', 'sourceName'] }),
    lat:     Object.freeze({ required: true,  keys: ['lat', 'latitude', 'centroid_lat', 'y'] }),
    lon:     Object.freeze({ required: true,  keys: ['lon', 'lng', 'longitude', 'centroid_lon', 'x'] }),
    sector:  Object.freeze({ required: false, keys: ['sector', 'sector_name', 'subsector', 'asset_type'] }),
    country: Object.freeze({ required: false, keys: ['country', 'iso3_country', 'country_code', 'iso3'] }),
    owner:   Object.freeze({ required: false, keys: ['owner', 'owner_name', 'company', 'operator'] }),
    period:  Object.freeze({ required: false, keys: ['end_time', 'endTime', 'period', 'year', 'start_time'] }),
});

/** Where the array of records might live in the envelope. */
const ARRAY_KEYS = ['assets', 'data', 'results', 'sources', 'items', 'features'];

/** Emissions may be a nested object, a list, or flat columns. */
const EMISSIONS_KEYS = ['emissions', 'Emissions', 'emissions_quantity', 'gases'];
const GAS_KEYS = ['co2e_100yr', 'co2e_20yr', 'co2e', 'co2', 'ch4', 'n2o', 'nox', 'so2', 'pm2_5', 'pm25'];

/**
 * Find the record array in an arbitrary envelope. Returns
 * {rows, path} — `path` is reported so a shape change is visible.
 */
export function pickArray(payload) {
    if (Array.isArray(payload)) return { rows: payload, path: '(root array)' };
    if (!payload || typeof payload !== 'object') return { rows: null, path: null };
    for (const key of ARRAY_KEYS) {
        if (Array.isArray(payload[key])) return { rows: payload[key], path: key };
    }
    // One level down, for envelopes like {data: {assets: [...]}}.
    for (const [k, v] of Object.entries(payload)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const key of ARRAY_KEYS) {
                if (Array.isArray(v[key])) return { rows: v[key], path: `${k}.${key}` };
            }
        }
    }
    return { rows: null, path: null };
}

/**
 * Bind logical fields to actual keys using a sample record.
 * Returns {map, missing, observedKeys}. `map` is logical → actual key.
 */
export function resolveFieldMap(sample) {
    const observedKeys = sample && typeof sample === 'object' ? Object.keys(sample) : [];
    const map = {};
    const missing = [];
    for (const [logical, spec] of Object.entries(CANDIDATES)) {
        const hit = spec.keys.find(k => sample != null && sample[k] != null);
        if (hit) map[logical] = hit;
        else if (spec.required) missing.push(logical);
    }
    return { map, missing, observedKeys };
}

const num = (v) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return Number.isFinite(n) ? n : null;
};

/**
 * Extract whatever gas quantities a record carries, without converting or
 * combining them. Returns [{gas, value, unit}] — an empty list is honest
 * when the upstream shape is not recognised, and `normalizeSources` reports
 * how many rows had none.
 */
export function extractGases(record) {
    const out = [];
    const push = (gas, value, unit) => {
        const v = num(value);
        if (v != null) out.push({ gas: String(gas).toLowerCase(), value: v, unit: unit ?? null });
    };

    // Flat columns on the record itself.
    for (const g of GAS_KEYS) {
        if (record?.[g] != null) push(g, record[g], record.unit ?? record.emissions_unit ?? 'tonnes');
    }

    for (const key of EMISSIONS_KEYS) {
        const e = record?.[key];
        if (!e) continue;
        if (Array.isArray(e)) {
            // [{gas, quantity, unit}, …]
            for (const row of e) {
                const gas = row?.gas ?? row?.name ?? row?.species;
                const value = row?.quantity ?? row?.value ?? row?.emissions_quantity ?? row?.amount;
                if (gas != null) push(gas, value, row?.unit ?? row?.units);
            }
        } else if (typeof e === 'object') {
            // {co2e_100yr: 123, …} or {gas: 'co2', quantity: 123}
            if (e.gas != null) {
                push(e.gas, e.quantity ?? e.value ?? e.amount, e.unit ?? e.units);
            } else {
                for (const [gas, value] of Object.entries(e)) {
                    if (typeof value === 'number' || typeof value === 'string') {
                        push(gas, value, e.unit ?? e.units ?? 'tonnes');
                    }
                }
            }
        } else {
            push('co2e', e, record?.unit ?? 'tonnes');
        }
    }

    // De-duplicate on gas, keeping the first (flat columns win over nested).
    const seen = new Set();
    return out.filter(g => (seen.has(g.gas) ? false : seen.add(g.gas)));
}

/**
 * Normalize one upstream payload into the stable source-row contract.
 *
 * THROWS with an actionable message when the shape is unrecognisable — the
 * route turns that into freshness:'stale' + reason, so a schema change shows
 * up as an amber status row naming the keys actually received, not as
 * plausible-looking wrong data.
 *
 * @returns {{sources, fieldMap, arrayPath, stats}}
 */
export function normalizeSources(payload, { max = 2000 } = {}) {
    const { rows, path } = pickArray(payload);
    if (!rows) {
        const keys = payload && typeof payload === 'object' ? Object.keys(payload) : [];
        throw new Error(
            `no record array found; looked for [${ARRAY_KEYS.join(', ')}], `
            + `payload keys were [${keys.join(', ') || 'none'}] — fix ARRAY_KEYS in js/pollution-sources.js`);
    }
    if (!rows.length) throw new Error('upstream returned an empty record array');

    const { map, missing, observedKeys } = resolveFieldMap(rows[0]);
    if (missing.length) {
        throw new Error(
            `could not resolve required field(s) [${missing.join(', ')}]; `
            + `record keys were [${observedKeys.join(', ')}] — fix CANDIDATES in js/pollution-sources.js`);
    }

    const sources = [];
    let withoutGases = 0;
    for (const r of rows) {
        const lat = num(r[map.lat]);
        const lon = num(r[map.lon]);
        if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
        const gases = extractGases(r);
        if (!gases.length) withoutGases++;
        sources.push({
            id: String(r[map.id]),
            name: r[map.name] != null ? String(r[map.name]) : String(r[map.id]),
            lat, lon,
            sector: map.sector ? (r[map.sector] ?? null) : null,
            country: map.country ? (r[map.country] ?? null) : null,
            owner: map.owner ? (r[map.owner] ?? null) : null,
            period: map.period ? (r[map.period] ?? null) : null,
            gases,
        });
        if (sources.length >= max) break;
    }
    if (!sources.length) {
        throw new Error(
            `resolved ${rows.length} records but none had usable coordinates via `
            + `"${map.lat}"/"${map.lon}" — fix CANDIDATES in js/pollution-sources.js`);
    }

    return {
        sources,
        fieldMap: map,
        arrayPath: path,
        stats: {
            received: rows.length,
            kept: sources.length,
            truncated: rows.length > sources.length && sources.length >= max,
            withoutGases,
            // Loud if the gas extraction found nothing at all — the rows are
            // placeable but carry no magnitude, which is worth an amber flag.
            gasesUnresolved: withoutGases === sources.length,
        },
    };
}

/** Total a chosen gas per sector, for a legend or a ranked list. */
export function summarizeSectors(sources = [], gas = 'co2e_100yr') {
    const bySector = new Map();
    for (const s of sources) {
        const hit = s.gases.find(g => g.gas === gas) ?? s.gases[0];
        if (!hit) continue;
        const key = s.sector ?? 'unknown';
        const cur = bySector.get(key) ?? { sector: key, total: 0, count: 0, unit: hit.unit };
        cur.total += hit.value;
        cur.count++;
        bySector.set(key, cur);
    }
    return [...bySector.values()].sort((a, b) => b.total - a.total);
}

export default {
    CLIMATE_TRACE_ATTRIBUTION, INVENTORY_PROVENANCE, CANDIDATES,
    pickArray, resolveFieldMap, extractGases, normalizeSources, summarizeSectors,
};
