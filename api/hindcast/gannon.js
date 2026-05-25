/**
 * Vercel Edge Function: /api/hindcast/gannon
 *
 * Composite endpoint for the May 2024 Gannon superstorm case study.
 * Hits NASA DONKI CMEAnalysis + FLR for the storm window (May 8-13)
 * and returns a bundle-shaped payload the gannon-superstorm.html page
 * merges into its static replay JSON to lift the PLACEHOLDER stamp on
 * the `cme_events` field.
 *
 * The static bundle ships with hand-authored cme_events that match the
 * canonical NOAA SWPC catalog from memory. This endpoint replaces them
 * with the live DONKI record so:
 *   - Speed estimates (v0) reflect the latest LASCO cone-model fits
 *   - Active-region linkage is authoritative
 *   - Any subsequent re-processing automatically lifts to the page
 *
 * Historical-window queries are immutable, so the response is cached
 * on the CDN for 24 hours.
 *
 * Response shape:
 *   {
 *     source:    'NASA DONKI via Vercel Edge',
 *     data: {
 *       event:        'gannon_may_2024',
 *       window:       { start_iso, end_iso },
 *       anchor_iso:   '2024-05-10T12:00:00Z',
 *       cme_events:   [{ id, label, flare_class, launch_iso, v0_kms, ... }, ...],
 *       flares:       [{ flare_class, begin_time, peak_time, location, active_region }, ...],
 *       provenance:   { source, fetched_at, donki_endpoints: [...] },
 *     }
 *   }
 *
 * NASA API key from NASA_API_KEY env var. NEVER exposed to browser.
 */

import { jsonOk, jsonError, fetchWithTimeout, isoTag } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const DONKI_CME_BASE = 'https://api.nasa.gov/DONKI/CMEAnalysis';
const DONKI_FLR_BASE = 'https://api.nasa.gov/DONKI/FLR';
const GANNON_START   = '2024-05-08';   // catches the X1.0 from AR 13664
const GANNON_END     = '2024-05-13';   // covers the X5.8 recovery CME
const GANNON_ANCHOR  = '2024-05-10T12:00:00Z';   // h=0 anchor used by the bundle
const CACHE_TTL      = 86_400;         // 24 h
const CACHE_SWR      = 3600;

// Hand-vetted match between the canonical NOAA SWPC X-class events and
// the DONKI catalog. DONKI's CMEAnalysis records are keyed by `time21_5`
// (the moment the CME passes the 21.5 Rs sphere) rather than the flare
// onset, and the flare-CME mapping isn't always one-to-one, so this
// table gives us a stable id + label per event independent of DONKI's
// internal IDs.
const GANNON_FLARE_CATALOG = [
    { id: 'cme1', flare_class: 'X1.0', flare_begin_pat: '2024-05-08T0[345]', label: 'X1.0 flare · AR 13664' },
    { id: 'cme2', flare_class: 'X1.0', flare_begin_pat: '2024-05-08T2[01]',  label: 'X1.0 flare · 21:08 UT' },
    { id: 'cme3', flare_class: 'X2.2', flare_begin_pat: '2024-05-09T1[67]',  label: 'X2.2 flare · the SSC progenitor' },
    { id: 'cme4', flare_class: 'X3.9', flare_begin_pat: '2024-05-10T0[6]',   label: 'X3.9 flare · reinforcement' },
    { id: 'cme5', flare_class: 'X5.8', flare_begin_pat: '2024-05-11T0[01]',  label: 'X5.8 flare · recovery-phase' },
];

// Drag parameters tuned for the Gannon compound-CME-train effect (each
// CME after the first sees pre-accelerated, less-dense background).
// Matches the values in the static bundle.
const GANNON_GAMMA = {
    cme1: 1.2e-8,
    cme2: 8.0e-9,
    cme3: 4.0e-9,
    cme4: 4.0e-9,
    cme5: 3.5e-9,
};

function _matchEvent(donkiCme, donkiFlares) {
    const t = donkiCme.time21_5;
    if (!t) return null;
    // Walk the catalog and pick the first matching pattern (preserves order).
    for (const entry of GANNON_FLARE_CATALOG) {
        // Match either via a linked flare or by proximity of time21_5 to the
        // expected flare begin time (within 6 hours either side — the
        // CME-passes-21.5-Rs moment can be a few hours after flare onset).
        const flareMatch = donkiFlares.find(f =>
            new RegExp('^' + entry.flare_begin_pat).test(f.begin_time || ''));
        if (flareMatch) return { entry, flareMatch };
    }
    return null;
}

export default async function handler(_request) {
    const nasaKey = (typeof process !== 'undefined' && process.env?.NASA_API_KEY) || 'DEMO_KEY';

    const cmeURL = `${DONKI_CME_BASE}?startDate=${GANNON_START}&endDate=${GANNON_END}&api_key=${nasaKey}`;
    const flrURL = `${DONKI_FLR_BASE}?startDate=${GANNON_START}&endDate=${GANNON_END}&api_key=${nasaKey}`;

    let donkiCmes, donkiFlares;
    try {
        const [cmeRes, flrRes] = await Promise.all([
            fetchWithTimeout(cmeURL, { headers: { Accept: 'application/json' } }),
            fetchWithTimeout(flrURL, { headers: { Accept: 'application/json' } }),
        ]);
        if (!cmeRes.ok) throw new Error(`CME: HTTP ${cmeRes.status}`);
        if (!flrRes.ok) throw new Error(`FLR: HTTP ${flrRes.status}`);
        donkiCmes   = await cmeRes.json();
        donkiFlares = await flrRes.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message,
            { source: 'NASA DONKI' });
    }

    if (!Array.isArray(donkiCmes) || !Array.isArray(donkiFlares)) {
        return jsonError('parse_error', 'Unexpected DONKI payload shape',
            { source: 'NASA DONKI' });
    }

    // Normalize the flare list (sorted by begin time, X-class only).
    const flares = donkiFlares
        .filter(f => /^X/i.test(f.classType || ''))
        .map(f => ({
            id:            f.flrID ?? null,
            flare_class:   f.classType,
            begin_time:    isoTag(f.beginTime) ?? f.beginTime,
            peak_time:     isoTag(f.peakTime)  ?? f.peakTime  ?? null,
            location:      f.sourceLocation     ?? null,
            active_region: f.activeRegionNum    ?? null,
        }))
        .sort((a, b) => (a.begin_time ?? '').localeCompare(b.begin_time ?? ''));

    // Map each canonical Gannon CME to its DONKI record (when available)
    // for v0 + lat/lon refinement.
    const cme_events = [];
    const matchedDonkiTimes = new Set();
    for (const entry of GANNON_FLARE_CATALOG) {
        const flareMatch = flares.find(f =>
            new RegExp('^' + entry.flare_begin_pat).test(f.begin_time || ''));
        if (!flareMatch) {
            // DONKI returned no X-class flare at the expected window — skip
            // this event (rare, would happen if NASA re-classified one).
            continue;
        }
        // Find the closest DONKI CME by time21_5 — the canonical Gannon CMEs
        // have time21_5 within ~6 hours of their flare begin time.
        const flareT = new Date(flareMatch.begin_time).getTime();
        const candidates = donkiCmes
            .filter(c => c.time21_5 && !matchedDonkiTimes.has(c.time21_5))
            .map(c => ({
                c,
                dt: Math.abs(new Date(c.time21_5).getTime() - flareT) / 3600_000,
            }))
            .filter(({ dt }) => dt < 12)
            .sort((a, b) => a.dt - b.dt);
        const donkiCme = candidates[0]?.c;
        if (donkiCme) matchedDonkiTimes.add(donkiCme.time21_5);

        const v0      = donkiCme?.speed       ? parseFloat(donkiCme.speed)       : null;
        const lat     = donkiCme?.latitude    != null ? parseFloat(donkiCme.latitude)  : null;
        const lon     = donkiCme?.longitude   != null ? parseFloat(donkiCme.longitude) : null;
        const halfAng = donkiCme?.halfAngle   != null ? parseFloat(donkiCme.halfAngle) : null;

        cme_events.push({
            id:            entry.id,
            label:         entry.label,
            flare_class:   entry.flare_class,
            launch_iso:    flareMatch.begin_time,
            v0_kms:        Number.isFinite(v0) ? Math.round(v0) : null,
            src_lat_deg:   lat,
            src_lon_deg:   lon,
            half_angle_deg: halfAng,
            active_region: flareMatch.active_region,
            gamma_km_inv:  GANNON_GAMMA[entry.id] ?? 4e-9,
            donki_id:      donkiCme?.activityID ?? null,
            notes:         donkiCme?.note ?? null,
        });
    }

    return jsonOk({
        source: 'NASA DONKI via Vercel Edge — Gannon May 2024 hindcast composite',
        data: {
            event:       'gannon_may_2024',
            window:      { start: GANNON_START + 'T00:00:00Z', end: GANNON_END + 'T00:00:00Z' },
            anchor_iso:  GANNON_ANCHOR,
            cme_events,
            flares,
            provenance: {
                source:           'NASA DONKI (CMEAnalysis + FLR)',
                fetched_at:       new Date().toISOString(),
                donki_endpoints:  [DONKI_CME_BASE, DONKI_FLR_BASE],
                cme_match_count:  cme_events.length,
                flare_count:      flares.length,
                catalog_version:  'gannon-may-2024-v1',
            },
        },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
