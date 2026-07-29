/**
 * Vercel Edge Function: /api/cme/skill
 *
 * Public read of the CME validation program's per-model skill ledger
 * (CME_FORECAST_VALIDATION_PLAN.md Phase 3): the cme_model_skill view
 * (timing MAE/bias, ≤12 h hits, false alarms, misses — split hindcast vs
 * realtime) plus the most recent realtime events with their issue-time-
 * locked forecasts and resolved L1 truth. This is what the space-weather
 * CME calendar renders as the prediction scorecard: skill shown, not
 * claimed — every number traces to a forecast row locked BEFORE arrival.
 *
 * The underlying tables are service-role-only (zero-policy RLS, CLAUDE.md
 * §4.2); this endpoint is the deliberate public window. Per-event rows
 * expose only forecast/observation times of public NASA-catalogued CMEs.
 *
 * Query params:
 *   ?events=N   recent realtime events to include (default 24, max 60)
 *
 * Cache: 10 min CDN (the tables change at cron cadence).
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

export default async function handler(request) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return jsonError('not_configured', 'supabase env missing', { status: 503 });
    }
    const nEvents = Math.max(1, Math.min(60,
        parseInt(new URL(request.url).searchParams.get('events') ?? '24', 10) || 24));

    const headers = {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Accept: 'application/json',
    };
    const get = async (path) => {
        const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`,
            { timeoutMs: 8000, headers });
        if (!res.ok) throw new Error(`${path.split('?')[0]} HTTP ${res.status}`);
        return res.json();
    };

    let skill, events;
    try {
        // PostgREST embeds forecasts + truth through the FKs in one call.
        [skill, events] = await Promise.all([
            get('cme_model_skill?select=*'),
            get('cme_events?is_hindcast=eq.false' +
                '&select=event_id,donki_id,launch_time_utc,speed_kms_3d,' +
                'cme_arrival_forecasts(model_id,issued_at,predicted_arrival_utc,' +
                'arrival_window_early,arrival_window_late,predicted_kp_max,' +
                'predicted_speed_at_l1,inputs),' +
                'cme_l1_observations(arrived,shock_arrival_utc,observed_bz_min_nt,observed_speed_kms)' +
                `&order=launch_time_utc.desc&limit=${nEvents}`),
        ]);
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'supabase' });
    }

    // Trim events: latest forecast per model, truth flattened.
    const trimmed = (events ?? []).map(ev => {
        const byModel = {};
        for (const f of ev.cme_arrival_forecasts ?? []) {
            const prev = byModel[f.model_id];
            if (!prev || String(f.issued_at) > String(prev.issued_at)) byModel[f.model_id] = f;
        }
        const truth = (ev.cme_l1_observations ?? [])[0]
            ?? (ev.cme_l1_observations && !Array.isArray(ev.cme_l1_observations)
                ? ev.cme_l1_observations : null);   // 1:1 FK may embed as object
        return {
            event_id: ev.event_id,
            donki_id: ev.donki_id,
            launch: ev.launch_time_utc,
            speed_kms: ev.speed_kms_3d,
            forecasts: Object.fromEntries(Object.entries(byModel).map(([m, f]) => [m, {
                issued_at: f.issued_at,
                predicted: f.predicted_arrival_utc,
                early: f.arrival_window_early,
                late: f.arrival_window_late,
                kp_max: f.predicted_kp_max,
                v_l1: f.predicted_speed_at_l1 ?? null,
                // flux-rope-v1 rows carry probabilistic content in the
                // frozen inputs — expose the COMPACT subset the ledger
                // renders (never the full replay payload).
                ...(m === 'flux-rope-v1' && f.inputs ? {
                    p_hit: f.inputs.p_hit ?? null,
                    p10: f.inputs.p10 ?? null,
                    p20: f.inputs.p20 ?? null,
                    min_bz_p50: f.inputs.min_bz_p50 ?? null,
                    min_bz_p5: f.inputs.min_bz_p5 ?? null,
                    n_train: Array.isArray(f.inputs.train) ? f.inputs.train.length : 1,
                    flare: f.inputs.flare ?? null,
                } : {}),
            }])),
            truth: truth ? {
                arrived: truth.arrived === true,
                shock: truth.shock_arrival_utc ?? null,
                min_bz_nt: truth.observed_bz_min_nt ?? null,
                v_kms: truth.observed_speed_kms ?? null,
            } : null,
        };
    });

    return jsonOk({
        source: 'cme_model_skill + cme_events (issue-time-locked forecasts)',
        data: {
            updated: new Date().toISOString(),
            models: skill ?? [],
            events: trimmed,
        },
    }, { maxAge: 600, swr: 120 });
}
