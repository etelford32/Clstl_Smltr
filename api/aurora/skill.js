/**
 * Vercel Edge Function: GET /api/aurora/skill
 *
 * Public read of AurOracle's rolling forecast skill (AURORACLE_ML_PLAN.md §6,
 * Phase 2). Calls the aurora_forecast_skill() RPC, which aggregates matured
 * planetary-Kp predictions in forecast_log into per-model MAE/RMSE/bias and
 * Murphy skill vs persistence + vs recurrence — the evidence that the
 * historically-driven baseline works, and the gate the Phase 3 Kp-LSTM must
 * clear before it ships.
 *
 * Returns aggregate skill numbers only (no row contents), so it's safe to serve
 * publicly. Empty until the first logged forecasts mature (a few nights).
 *
 * Env: SUPABASE_URL / SUPABASE_SERVICE_KEY (service_role; forecast_log is
 * server-only, and aurora_forecast_skill() is granted to service_role only).
 */
import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

export default async function handler() {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return jsonError('supabase_not_configured', 'SUPABASE_URL / SUPABASE_SERVICE_KEY missing',
            { status: 500, maxAge: 60 });
    }
    try {
        const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/aurora_forecast_skill`, {
            method: 'POST',
            timeoutMs: 6000,
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: '{}',
        });
        if (!res.ok) throw new Error(`Supabase ${res.status}`);
        const data = await res.json();
        return jsonOk({ source: 'forecast_log/aurora skill leaderboard', data }, { maxAge: 1800, swr: 600 });
    } catch (e) {
        return jsonError('skill_unavailable', e.message, { source: 'forecast_log' });
    }
}
