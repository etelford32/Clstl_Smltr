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
                'arrival_window_early,arrival_window_late,predicted_kp_max),' +
                'cme_l1_observations(arrived,shock_arrival_utc)' +
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
            }])),
            truth: truth ? {
                arrived: truth.arrived === true,
                shock: truth.shock_arrival_utc ?? null,
            } : null,
        };
    });

    // HSS program (2026-07-23): the second weather. hole_id joins are
    // text (no FK embedding) — three flat reads, stitched here. Missing
    // tables (migration not applied on an environment) degrade to empty.
    let hss = { models: [], events: [] };
    try {
        const since = new Date(Date.now() - 37 * 86400e3).toISOString();
        const [hSkill, hEvents, hFc, hObs] = await Promise.all([
            get('hss_model_skill?select=*'),
            get('hss_events?select=hole_id,detected_at,stony_lon_deg,lat_deg'
                + `&detected_at=gte.${encodeURIComponent(since)}`
                + '&order=detected_at.desc&limit=30'),
            get('hss_arrival_forecasts?select=hole_id,model_id,issued_at,'
                + 'predicted_arrival,window_start,window_end'
                + `&issued_at=gte.${encodeURIComponent(since)}`),
            get('hss_l1_observations?select=hole_id,arrived,arrival_at,'
                + 'v_before_kms,v_peak_kms'),
        ]);
        const fcById = new Map();
        for (const f of hFc ?? []) {
            const cur = fcById.get(f.hole_id) ?? {};
            cur[f.model_id] = { issued_at: f.issued_at, predicted: f.predicted_arrival,
                window_start: f.window_start, window_end: f.window_end };
            fcById.set(f.hole_id, cur);
        }
        const obsById = new Map((hObs ?? []).map(o => [o.hole_id, o]));
        hss = {
            models: hSkill ?? [],
            events: (hEvents ?? []).map(e => ({
                hole_id: e.hole_id,
                detected_at: e.detected_at,
                stony_lon_deg: e.stony_lon_deg,
                lat_deg: e.lat_deg,
                forecasts: fcById.get(e.hole_id) ?? {},
                truth: obsById.has(e.hole_id) ? {
                    arrived: obsById.get(e.hole_id).arrived === true,
                    arrival_at: obsById.get(e.hole_id).arrival_at ?? null,
                    v_before: obsById.get(e.hole_id).v_before_kms ?? null,
                    v_peak: obsById.get(e.hole_id).v_peak_kms ?? null,
                } : null,
            })),
        };
    } catch { /* tables absent or unreachable → empty hss, CME data still served */ }

    return jsonOk({
        source: 'cme_model_skill + cme_events (issue-time-locked forecasts)'
            + ' + hss_model_skill + hss_events (corotation windows)',
        data: {
            updated: new Date().toISOString(),
            models: skill ?? [],
            events: trimmed,
            hss,
        },
    }, { maxAge: 600, swr: 120 });
}
