/**
 * Vercel Edge Function: /api/atmosphere/snapshot
 *
 * Compact card payload — ρ + dominant species at 200/400/600 km — used
 * by the space-weather.html Upper Atmosphere card and by anything else
 * embedding a thumbnail of current thermospheric state.
 *
 * Mirrors dsmc/pipeline/profile.py:snapshot() exactly. Cheap: 3
 * grid-lookups instead of a full 160-point profile.
 */

import { jsonOk, jsonError } from '../_lib/responses.js';
import {
    getSnapshot,   // from upper-atmosphere-engine — same math as Python
    SPECIES,
} from '../../js/upper-atmosphere-engine.js';

export const config = { runtime: 'edge' };

const CACHE_TTL = 21_600;
const CACHE_SWR = 1_800;

export default async function handler(req) {
    const url = new URL(req.url);
    const f107 = num(url.searchParams.get('f107'), 150);
    const ap   = num(url.searchParams.get('ap'),    15);

    let snap;
    try {
        snap = getSnapshot({
            f107Sfu: f107, ap,
            altitudesKm: [200, 400, 600],
        });
    } catch (e) {
        return jsonError('compute_error', e.message,
            { source: 'atmosphere/snapshot' });
    }

    return jsonOk({
        source:        'Parker Physics atmosphere/snapshot · seed-grid lookup',
        f107_sfu:      f107,
        ap:            ap,
        f107_used:     f107,
        ap_used:       ap,
        // Same honesty principle as profile.js — the snapshot is a
        // grid-lookup, tagged as such.
        model:         'SPARTA-bootstrap',
        altitudes:     snap.altitudes.map(h => ({
            altitude_km:        h.altitudeKm,
            density_kg_m3:      h.rho,
            temperature_K:      h.T,
            dominant_species:   h.dominantSpecies,
            dominant_fraction:  h.dominantFraction,
        })),
        issued_at_utc: new Date().toISOString(),
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}

function num(v, fallback) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
}
