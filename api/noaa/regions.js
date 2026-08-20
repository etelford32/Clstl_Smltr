/**
 * Vercel Edge Function: /api/noaa/regions
 *
 * Source: NOAA SWPC active solar regions (sunspot groups)
 *   json/solar_regions.json
 *
 * T3 endpoint (15-minute cadence).
 * Returns the full active region list — the file is small so no slicing needed.
 *
 * Relays SWPC's per-region C/M/X flare probabilities (the numbers on the Solar
 * Region Summary) alongside the position and classification fields. They are
 * what js/farside/flare-climatology.js rank-matches a far-side detection
 * against, and they were previously dropped on the floor here.
 *
 * Field resolution and the `field_map` / `unmapped_keys` diagnostics live in
 * api/_lib/noaa-regions.js — read that header before touching the candidate
 * lists. Values are relayed AS PUBLISHED (whole percents); the
 * percent-vs-fraction decision belongs to the client, once, over the whole
 * feed.
 */
import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { normalizeSolarRegions, PROBABILITY_FIELDS } from '../_lib/noaa-regions.js';

export const config = { runtime: 'edge' };

const NOAA_REGIONS = 'https://services.swpc.noaa.gov/json/solar_regions.json';
const CACHE_TTL    = 900;
const CACHE_SWR    = 120;

export default async function handler() {
    let raw;
    try {
        const res = await fetchWithTimeout(NOAA_REGIONS, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'NOAA SWPC' });
    }

    let norm;
    try {
        norm = normalizeSolarRegions(raw);
    } catch (e) {
        return jsonError('parse_error', e.message, { source: 'NOAA SWPC' });
    }

    // The region list is still real and useful without probabilities (position
    // and area drive other consumers), so this is not an error — but the flare
    // base rate downstream is dead without them, and a 200 with no probability
    // in it would be scored as healthy. Say so out loud.
    const probabilitiesMissing = PROBABILITY_FIELDS.every((f) => norm.field_map[f] === null);

    return jsonOk({
        source:    'NOAA SWPC solar_regions via Vercel Edge',
        ...(probabilitiesMissing && norm.region_count ? { freshness: 'stale' } : {}),
        data: {
            updated:       new Date().toISOString(),
            region_count:  norm.region_count,
            regions:       norm.regions,
            // Schema diagnostics — which upstream key fed each field, what we
            // did not claim, and how much of the list is actually usable for
            // the flare base rate. See api/_lib/noaa-regions.js.
            field_map:            norm.field_map,
            unmapped_keys:        norm.unmapped_keys,
            probability_coverage: norm.probability_coverage,
            ...(probabilitiesMissing && norm.region_count
                ? { note: 'No per-region flare probability field matched. Compare '
                        + 'unmapped_keys against FIELD_CANDIDATES in api/_lib/noaa-regions.js.' }
                : {}),
        },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
