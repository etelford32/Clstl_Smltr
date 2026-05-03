/**
 * Vercel Edge Function: /api/hek/coronal-holes
 *
 * Source: HEK (Heliophysics Event Knowledgebase) — http://www.lmsal.com/hek
 *
 * Coronal holes are detected automatically by SPoCA-CH, CHIMERA, and
 * SunPy/Helioviewer pipelines, all of which publish their detections to
 * the HEK catalog.  We query the last 24 hours, prefer SPoCA-CH (the
 * most consistent automated detector calibrated against SDO/AIA 193 Å),
 * and return de-duplicated lat / Carrington-lon pairs that the client
 * converts into scene-frame coronal-hole positions for the volumetric
 * EUV shader.
 *
 * Cadence: HEK CH detections are produced every ~4 hours; we cache 30 min
 * to amortise the upstream load while still picking up fresh detections.
 *
 * Response shape (success):
 *   {
 *     source: 'HEK CH catalog (LMSAL)',
 *     data: {
 *       updated:  ISO8601,
 *       count:    int,
 *       holes:    [{ lat_deg, lon_carrington_deg, lon_helio_deg,
 *                    frm_name, time }]
 *     }
 *   }
 *
 * Falls back gracefully — on any upstream error the client keeps its
 * synthetic polar + wind-driven equatorial holes.
 */
import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const CACHE_TTL = 1800;     // 30 min
const CACHE_SWR = 300;      // 5 min stale-while-revalidate

const HEK_BASE = 'https://www.lmsal.com/hek/her';

export default async function handler() {
    // 24-hour search window.  HEK timestamps need second resolution and
    // *no* trailing milliseconds (the parser is finicky).
    const end   = new Date();
    const start = new Date(end.getTime() - 24 * 3600 * 1000);
    const fmt   = d => d.toISOString().replace(/\.\d{3}Z$/, '');

    const params = new URLSearchParams({
        cmd:              'search',
        type:             'column',
        event_type:       'ch',
        event_starttime:  fmt(start),
        event_endtime:    fmt(end),
        result_limit:     '60',
        cosec:            '2',
        return: 'frm_name,hgs_x,hgs_y,hgc_x,hgc_y,event_starttime,obs_observatory,kb_archivid',
    });

    let raw;
    try {
        const res = await fetchWithTimeout(`${HEK_BASE}?${params.toString()}`, {
            headers: { Accept: 'application/json' },
            timeoutMs: 15000,         // HEK can be slow on busy days
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'HEK' });
    }

    if (!raw || !Array.isArray(raw.result)) {
        return jsonError('parse_error', 'Unexpected HEK shape', { source: 'HEK' });
    }

    // Prefer SPoCA-CH (consistent, calibrated against AIA 193 Å); fall back
    // to other automatic detectors if SPoCA didn't run during the window.
    // Dedupe with a 5° coarse Carrington-grid key — multiple frames of the
    // same hole detected over the day collapse to one entry.
    const PREFERRED_FRMS = ['SPoCA-CH', 'CHIMERA', 'PMD-CH', 'TSPoCA'];
    const seen = new Map();   // key → { score, hole }

    const scoreFrm = name => {
        if (!name) return 0;
        const idx = PREFERRED_FRMS.findIndex(p => name.includes(p));
        return idx === -1 ? 1 : (PREFERRED_FRMS.length - idx + 1);
    };

    for (const r of raw.result) {
        const frmName = r.frm_name ?? '';
        // HEK occasionally surfaces non-CH events under event_type=ch; sanity check
        if (frmName && !/CH/i.test(frmName)) continue;

        const lat = parseFloat(r.hgs_y);
        const lonC = parseFloat(r.hgc_x);
        const lonH = parseFloat(r.hgs_x);
        if (!isFinite(lat) || !isFinite(lonC)) continue;
        if (Math.abs(lat) > 89) continue;          // skip on-axis singularities

        const key = `${Math.round(lat / 5) * 5}_${Math.round(lonC / 5) * 5}`;
        const score = scoreFrm(frmName);
        const prev = seen.get(key);
        if (prev && prev.score >= score) continue;
        seen.set(key, {
            score,
            hole: {
                lat_deg:            lat,
                lon_carrington_deg: lonC,
                lon_helio_deg:      isFinite(lonH) ? lonH : null,
                frm_name:           frmName || null,
                obs:                r.obs_observatory ?? null,
                time:               r.event_starttime ?? null,
            },
        });
    }

    // Order by absolute latitude desc (polar holes first — usually deeper),
    // cap at 12 entries (client's u_holes uniform tops out at 4 anyway, but
    // sending a few extras lets the client cherry-pick the most relevant).
    const holes = Array.from(seen.values())
        .map(s => s.hole)
        .sort((a, b) => Math.abs(b.lat_deg) - Math.abs(a.lat_deg))
        .slice(0, 12);

    return jsonOk({
        source: 'HEK CH catalog (LMSAL)',
        data: {
            updated: new Date().toISOString(),
            count:   holes.length,
            holes,
        },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
