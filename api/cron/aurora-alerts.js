/**
 * Vercel Cron (Node runtime): /api/cron/aurora-alerts
 *
 * THE per-subscriber tiered aurora sender — the "alert-sender fix" that
 * rides along with flux-rope Phase 4 (FLUX_ROPE_SIMULATOR_PLAN.md §4).
 * Until now every subscriber's kp_threshold / lat / lon / city were
 * WRITE-ONLY: the only live sender (aurora-storm-blast.js) fires one
 * global broadcast at observed Kp ≥ 6. This cron finally implements the
 * documented Sender v1 contract — "forecast Kp >= kp_threshold → email" —
 * and extends it to three tiers (api/_lib/aurora-tiers.js):
 *
 *   WATCH (1–3 days) → WARNING (< 24 h) → NOWCAST (crossing now)
 *
 * driven by observed NOAA Kp, the SWPC 3-day Kp forecast, AND the
 * flux-rope ensemble engine run SERVER-SIDE — the same committed WASM +
 * shared provider (js/flux-rope-forecast.js) the pages use, with sources
 * injected (NASA DONKI + NOAA RTSW fetched here; no browser involved).
 * This is the engine's first server-side consumer — the seed of the SBIR
 * "API build" deliverable. Every layer is fail-soft: tiers degrade to
 * NOAA-only when the rope layer is unavailable.
 *
 * Per-subscriber debounce: send on tier escalation immediately, re-send
 * the same tier after 24 h (one storm = one email per tier). Ledger
 * columns last_alert_tier / last_alert_at
 * (supabase-aurora-tiered-alerts-migration.sql).
 *
 * Coexists with aurora-storm-blast.js (the anonymous G2+ audience
 * broadcast): the blast is marketing reach; THIS is the promised
 * per-subscriber product.
 *
 * Auth/env: same contract as aurora-storm-blast.js (x-vercel-cron or
 * Bearer CRON_SECRET; SUPABASE_URL + service key; RESEND_API_KEY).
 * Manual: ?dry=1 evaluates and reports without sending or ledger writes.
 */

import { readFile } from 'node:fs/promises';
import { evaluateTier, shouldSend, tierEmail } from '../_lib/aurora-tiers.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.AURORA_FROM_EMAIL || 'Parkers Physics <aurora@parkersphysics.com>';
const SITE_URL = process.env.SITE_URL || 'https://parkersphysics.com';
const CRON_SECRET = process.env.CRON_SECRET || '';
const NASA_KEY = process.env.NASA_API_KEY || 'DEMO_KEY';

const NOAA_KP_1M = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';
const NOAA_KP_FC = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json';
const NOAA_RTSW_MAG = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json';
const NOAA_RTSW_WIND = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json';

const MAX_SENDS_PER_RUN = 200;   // serverless budget guard

function isAuthorized(req) {
    const hdr = req.headers.authorization || '';
    if (CRON_SECRET && hdr === `Bearer ${CRON_SECRET}`) return true;
    if (req.headers['x-vercel-cron']) return true;
    return false;
}

async function getJson(url, timeoutMs = 9000) {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
    return r.json();
}

/** Peak observed Kp over the last ~30 one-minute readings. */
async function fetchObservedKp() {
    const rows = await getJson(NOAA_KP_1M);
    let peak = null;
    for (const r of rows.slice(-30)) {
        const kp = Number(r.kp_index ?? r.estimated_kp);
        if (Number.isFinite(kp) && (peak == null || kp > peak)) peak = kp;
    }
    return peak;
}

/** SWPC 3-day Kp forecast → [{tMs, kp}] (header row skipped). */
async function fetchKpForecast() {
    const rows = await getJson(NOAA_KP_FC);
    const out = [];
    for (const r of rows.slice(1)) {
        const tMs = Date.parse(String(r[0]).replace(' ', 'T') + 'Z');
        const kp = Number(r[1]);
        if (Number.isFinite(tMs) && Number.isFinite(kp)) out.push({ tMs, kp });
    }
    return out;
}

/**
 * The flux-rope layer, server-side: NASA DONKI cone fits + NOAA RTSW,
 * injected into the SAME shared provider the pages use, with the committed
 * WASM read from the repo. Returns the provider summary or null (fail-soft).
 */
async function fluxRopeSummary() {
    try {
        const [{ computeFluxRopeForecast }, { parseRtsw, rtswDriver }] = await Promise.all([
            import('../../js/flux-rope-forecast.js'),
            import('../../js/flux-rope-live.js'),
        ]);
        const wasm = await readFile(new URL('../../js/flux-rope-wasm/flux_rope_core.wasm', import.meta.url));

        // DONKI, same filter contract as /api/donki/cme (earth_directed cone).
        const end = new Date();
        const start = new Date(end.getTime() - 7 * 86_400_000);
        const iso = (d) => d.toISOString().slice(0, 10);
        const raw = await getJson(
            `https://api.nasa.gov/DONKI/CMEAnalysis?startDate=${iso(start)}&endDate=${iso(end)}&mostAccurateOnly=true&api_key=${NASA_KEY}`,
            15_000,
        );
        const cmes = (Array.isArray(raw) ? raw : [])
            .filter((c) => Number.isFinite(c.speed) && c.time21_5)
            .map((c) => {
                const lat = Number(c.latitude), lon = Number(c.longitude), half = Number(c.halfAngle);
                return {
                    timeIso: c.time21_5.replace(/Z?$/, 'Z').replace(' ', 'T'),
                    speedKms: Number(c.speed),
                    lonDeg: Number.isFinite(lon) ? lon : 0,
                    latDeg: Number.isFinite(lat) ? lat : 0,
                    halfAngleDeg: Number.isFinite(half) ? half : 30,
                    earthDirected: Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(half)
                        && Math.sqrt(lat * lat + lon * lon) <= half,
                };
            })
            .sort((a, b) => Date.parse(b.timeIso) - Date.parse(a.timeIso));

        let rtsw = null;
        try {
            const [mag, wind] = await Promise.all([getJson(NOAA_RTSW_MAG), getJson(NOAA_RTSW_WIND)]);
            rtsw = rtswDriver(parseRtsw(mag, wind));
        } catch { /* prior-only is fine */ }

        const fc = await computeFluxRopeForecast({ sources: { cmes, rtsw, wasm } });
        return fc.idle ? null : fc.summary;
    } catch (e) {
        console.warn('aurora-alerts: flux-rope layer unavailable:', e?.message ?? e);
        return null;
    }
}

// ── Supabase REST (service role) ─────────────────────────────────────────────
const sbHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
};

async function fetchSubscribers() {
    const url = `${SUPABASE_URL}/rest/v1/aurora_subscribers`
        + '?status=eq.confirmed'
        + '&select=id,email,kp_threshold,lat,lon,city,confirm_token,last_alert_tier,last_alert_at'
        + '&limit=2000';
    const r = await fetch(url, { headers: sbHeaders, signal: AbortSignal.timeout(9000) });
    if (!r.ok) {
        const body = await r.text().catch(() => '');
        // The ledger columns come from supabase-aurora-tiered-alerts-
        // migration.sql. Until it is applied, REFUSE to run rather than
        // sending without debounce memory (a 15-min cron with no ledger
        // would spam every subscriber every tick).
        if (r.status === 400 && /last_alert/.test(body)) {
            const err = new Error('migration_not_applied');
            err.code = 'migration_not_applied';
            throw err;
        }
        throw new Error(`subscribers HTTP ${r.status}`);
    }
    return r.json();
}

async function recordSend(id, tier, nowIso) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/aurora_subscribers?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ last_alert_tier: tier, last_alert_at: nowIso }),
        signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) throw new Error(`ledger HTTP ${r.status}`);
}

async function sendEmail(to, { subject, html }) {
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
        signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`resend HTTP ${r.status}`);
}

export default async function handler(req, res) {
    if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
    if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'not_configured' });
    const dry = req.query?.dry === '1';
    const nowMs = Date.now();

    // Shared situation (one evaluation feeds every subscriber).
    let observedKp = null, kpForecast = [], fluxRope = null;
    const errors = [];
    try { observedKp = await fetchObservedKp(); } catch (e) { errors.push(`kp1m: ${e.message}`); }
    try { kpForecast = await fetchKpForecast(); } catch (e) { errors.push(`kp3day: ${e.message}`); }
    fluxRope = await fluxRopeSummary();

    let subs;
    try { subs = await fetchSubscribers(); } catch (e) {
        if (e.code === 'migration_not_applied') {
            return res.status(200).json({
                error: 'migration_not_applied', sent: 0,
                note: 'apply supabase-aurora-tiered-alerts-migration.sql to enable the tiered sender',
            });
        }
        return res.status(502).json({ error: 'subscribers_unavailable', detail: e.message });
    }

    const out = { evaluated: subs.length, sent: 0, skipped: 0, tiers: {}, dry, errors };
    for (const sub of subs) {
        const ev = evaluateTier({
            nowMs, observedKp, kpForecast, fluxRope,
            kpThreshold: Number(sub.kp_threshold),
        });
        if (!ev.tier) { out.skipped++; continue; }
        const fire = shouldSend({
            tier: ev.tier,
            lastTier: sub.last_alert_tier,
            lastAtMs: sub.last_alert_at ? Date.parse(sub.last_alert_at) : NaN,
            nowMs,
        });
        out.tiers[ev.tier] = (out.tiers[ev.tier] ?? 0) + (fire ? 1 : 0);
        if (!fire) { out.skipped++; continue; }
        if (out.sent >= MAX_SENDS_PER_RUN) { out.capped = true; break; }
        if (dry) { out.sent++; continue; }
        try {
            const unsubUrl = `${SITE_URL}/api/subscribe/unsubscribe?token=${sub.confirm_token}`;
            await sendEmail(sub.email, tierEmail({
                tier: ev.tier, detail: ev.detail, city: sub.city,
                siteUrl: SITE_URL, unsubUrl,
            }));
            await recordSend(sub.id, ev.tier, new Date(nowMs).toISOString());
            out.sent++;
        } catch (e) {
            errors.push(`send ${sub.id}: ${e.message}`);
        }
    }

    return res.status(200).json({
        ...out,
        observedKp,
        kpForecastRows: kpForecast.length,
        fluxRope: fluxRope
            ? { pHit: fluxRope.pHit, p10: fluxRope.p10, minBzP50: fluxRope.minBzP50 }
            : null,
    });
}
