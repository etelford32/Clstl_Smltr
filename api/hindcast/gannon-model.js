/**
 * Vercel Edge Function: /api/hindcast/gannon-model
 *
 * Relays the MHD-model artifact for the May 2024 Gannon hindcast — the
 * Ap* surrogates (ap_mhd / ap_gnd) and the MHD-corrected 400 km density
 * tracks (msis_apmhd / msis_apgnd) — which are PRODUCED OFFLINE by the
 * BATS-R-US / SWMF pipeline, not fetched from a public upstream.
 *
 * This is the live-data seam for the one part of the Gannon bundle that
 * is still PLACEHOLDER: the modeled tracks. The static bundle ships with
 * synthetic ap_mhd/ap_gnd + density curves and is stamped `_is_placeholder`.
 * When the workstation pipeline finishes a run it uploads a model artifact
 * to object storage; this endpoint serves it, and gannon-superstorm.html
 * splices it in and lifts the PLACEHOLDER stamp — with zero front-end
 * redeploy required.
 *
 *   pipeline run ─► upload R2: hindcast/gannon/model-v1.json
 *                       │
 *                       ▼
 *   /api/hindcast/gannon-model ─► page splice ─► VALIDATED HINDCAST
 *
 * Until that artifact exists (or when R2 isn't configured for the env),
 * the endpoint returns 200 with `{ available: false }` so the page's lift
 * is a clean no-op. See MHD_DENSITY_PHASE0_GANNON_RUNBOOK.md for the
 * pipeline side, and GANNON_LIVE_DATA.md for the end-to-end data lift.
 *
 * Artifact shape (authored by the pipeline, relayed verbatim under `data`):
 *   {
 *     event: 'gannon_may_2024',
 *     run_id, generated_at, source,
 *     window: { start, end, step_minutes, anchor_iso },
 *     drivers_compact: { ap_mhd:[…], ap_gnd:[…], phi_pc_kv:[…], hpi_gw:[…], sme_nt:[…] },
 *     density_400km:   { msis_apmhd:[…], msis_apgnd:[…] },
 *     skill:           { rmse_base, rmse_mhd, rmse_gnd, skill_mhd, skill_gnd }
 *   }
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { R2_CONFIGURED, getSignedUrl } from '../_lib/r2-client.js';

export const config = { runtime: 'edge' };

// Pipeline upload target. Bump the version suffix in lockstep with the
// pipeline when the artifact schema changes.
const ARTIFACT_KEY = 'hindcast/gannon/model-v1.json';
const CACHE_TTL = 3600;   // 1 h — the artifact is immutable per run but a
const CACHE_SWR = 600;    // new run can land; keep it reasonably fresh.

function _notAvailable(reason) {
    // 200, not an error: "no model yet" is an expected steady state until
    // the BATS-R-US run lands. The page treats this as a silent no-op.
    return jsonOk(
        { available: false, reason, artifact_key: ARTIFACT_KEY },
        { maxAge: 60, swr: 30 },
    );
}

export default async function handler(_request) {
    if (!R2_CONFIGURED) {
        return _notAvailable('object_storage_not_configured');
    }

    let url;
    try {
        url = await getSignedUrl(ARTIFACT_KEY, { expiresIn: 300, method: 'GET' });
    } catch (e) {
        return _notAvailable(`signed_url_failed: ${e.message}`);
    }

    let res;
    try {
        res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'R2 model artifact' });
    }

    if (res.status === 404) return _notAvailable('artifact_not_uploaded_yet');
    if (!res.ok) {
        return jsonError('upstream_unavailable', `R2: HTTP ${res.status}`,
            { source: 'R2 model artifact' });
    }

    let artifact;
    try {
        artifact = await res.json();
    } catch (e) {
        return jsonError('parse_error', e.message, { source: 'R2 model artifact' });
    }

    // Minimal shape guard — the page splice keys off these.
    const dc = artifact?.drivers_compact;
    const d4 = artifact?.density_400km;
    const hasModel =
        (Array.isArray(dc?.ap_mhd) || Array.isArray(dc?.ap_gnd)) &&
        (Array.isArray(d4?.msis_apmhd) || Array.isArray(d4?.msis_apgnd));
    if (!hasModel) return _notAvailable('artifact_missing_model_tracks');

    return jsonOk({
        source: artifact.source ?? 'BATS-R-US / SWMF (Gannon model run)',
        available: true,
        data: artifact,
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
