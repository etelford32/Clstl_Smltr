/**
 * api/_lib/prewarm.js — shared cache-prewarm fanout for Vercel Cron
 *
 * Used by api/cron/prewarm-{hot,medium,cold}.js. Filters the
 * js/pipeline-registry.js entries by `prewarm` tier and issues
 * parallel same-origin GETs against each endpoint. Vercel's Edge
 * cache absorbs the responses, so the next visitor request returns
 * from cache instead of fanning out to NOAA / Open-Meteo / etc.
 *
 * Auth (mirrors api/cron/refresh-weather-grid.js):
 *   - Vercel attaches `x-vercel-cron: 1` to every cron invocation.
 *   - When CRON_SECRET is set, Vercel also attaches
 *     `Authorization: Bearer <CRON_SECRET>`.
 *   We accept either; both being absent → 401.
 *
 * The helper is intentionally pure-fetch — no Supabase write, no KV
 * state. The whole point is that the warm Edge cache IS the storage.
 *
 * Why this is a PRO-tier unlock: Vercel Hobby caps you at 2 cron
 * jobs total. PRO raises the cap to 40, which is what makes
 * tier-based pre-warming (hot @ 5m, medium @ 30m, cold @ 6h) actually
 * fit into the budget.
 */

import { PIPELINES } from '../../js/pipeline-registry.js';
import { recordPipelineSuccess, recordPipelineFailure } from './heartbeat.js';

const TIER_TIMEOUT_MS = {
    hot:    8_000,    // small NOAA payloads — should be quick
    medium: 12_000,
    cold:   25_000,   // ssw-verify + atmosphere/profile do real compute
};

const PER_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Run a prewarm pass for the given tier. Returns a JSON summary
 * suitable for direct use as a cron-endpoint response.
 *
 * @param {string} tier  'hot' | 'medium' | 'cold'
 * @param {Request} req  the original cron Request (used for origin + auth)
 * @returns {Response}
 */
export async function prewarmTier(tier, req) {
    const authHdr  = req.headers.get('authorization') || '';
    const cronHdr  = req.headers.get('x-vercel-cron')  === '1';
    const secret   = (typeof process !== 'undefined' && process.env)
        ? process.env.CRON_SECRET : '';

    // Accept either: matching Bearer token (preferred), or the cron
    // header (fallback when CRON_SECRET isn't set yet).
    const ok = secret
        ? authHdr === `Bearer ${secret}`
        : cronHdr;

    if (!ok) {
        return Response.json({
            error: 'unauthorized',
            detail: 'expected x-vercel-cron header or Bearer CRON_SECRET',
        }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    }

    const origin = _resolveOrigin(req);
    if (!origin) {
        return Response.json({
            error: 'no_origin',
            detail: 'could not resolve same-origin URL for prewarm fanout',
        }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }

    const targets = PIPELINES.filter(p => p.prewarm === tier);
    if (targets.length === 0) {
        return Response.json({
            tier, count: 0, results: [],
            note: `no entries with prewarm='${tier}' in pipeline-registry.js`,
        }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const t0 = Date.now();
    const overallTimeout = TIER_TIMEOUT_MS[tier] ?? 15_000;
    const overallCtl = AbortSignal.timeout(overallTimeout);

    const results = await Promise.all(targets.map(p => _hitOne(origin, p, overallCtl)));
    const durMs = Date.now() - t0;

    const okCount  = results.filter(r => r.ok).length;
    const errCount = results.filter(r => !r.ok).length;

    // Heartbeat — fire-and-forget (write best-effort, swallow errors).
    // Each tier becomes a row in pipeline_heartbeat the status page can
    // surface independently. "Healthy" = at least half the fanout
    // succeeded; "failure" otherwise. The failure-streak counter +
    // last-failure-reason in pipeline_heartbeat then tells the operator
    // which specific upstreams are flapping.
    const pipelineName = `prewarm_${tier}`;
    if (errCount === 0) {
        recordPipelineSuccess(pipelineName, `cron-fanout · ${targets.length}/${targets.length} ok in ${durMs}ms`);
    } else if (okCount >= errCount) {
        // Partial success — still mark green but encode the count in
        // last_source so the UI shows operators what's degraded.
        recordPipelineSuccess(pipelineName,
            `cron-fanout · ${okCount}/${targets.length} ok in ${durMs}ms`);
    } else {
        const failed = results.filter(r => !r.ok).map(r => r.id).slice(0, 5).join(', ');
        recordPipelineFailure(pipelineName,
            `${errCount}/${targets.length} endpoints failed in ${durMs}ms (e.g. ${failed})`);
    }

    return Response.json({
        tier,
        count:    targets.length,
        ok:       okCount,
        errors:   errCount,
        dur_ms:   durMs,
        as_of:    new Date().toISOString(),
        results,
    }, {
        status: errCount > okCount ? 207 : 200,    // 207 multi-status when more failed than succeeded
        headers: { 'Cache-Control': 'no-store' },
    });
}

async function _hitOne(origin, spec, sharedSignal) {
    const tA = Date.now();
    const ctl = AbortSignal.any
        ? AbortSignal.any([sharedSignal, AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(`${origin}${spec.endpoint}`, {
            signal:  ctl,
            headers: {
                'x-prewarm':       'cron',
                'x-prewarm-tier':  spec.prewarm,
                Accept:            'application/json',
            },
        });
        // Drain the body so the upstream cache write completes before
        // we report the result.
        await res.arrayBuffer().catch(() => {});
        return {
            id:        spec.id,
            endpoint:  spec.endpoint,
            status:    res.status,
            ok:        res.ok,
            ms:        Date.now() - tA,
        };
    } catch (e) {
        return {
            id:        spec.id,
            endpoint:  spec.endpoint,
            status:    null,
            ok:        false,
            error:     e?.name === 'TimeoutError' ? 'timeout'
                      : (e?.message || String(e)),
            ms:        Date.now() - tA,
        };
    }
}

function _resolveOrigin(req) {
    // 1. URL of the request itself — works when Vercel wraps the cron
    //    call in a fetch against the canonical deploy URL.
    try {
        const u = new URL(req.url);
        if (u.origin && u.origin !== 'null') return u.origin;
    } catch (_) { /* fall through */ }

    // 2. VERCEL_URL env (omits scheme — prepend https://).
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
    if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
    if (env.VERCEL_BRANCH_URL) return `https://${env.VERCEL_BRANCH_URL}`;

    return null;
}
