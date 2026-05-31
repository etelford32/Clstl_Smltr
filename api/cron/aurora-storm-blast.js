/**
 * Vercel Edge Cron: /api/cron/aurora-storm-blast
 *
 * The payoff for the anonymous aurora-capture flow (§8 of
 * AURORA_ALERT_CAPTURE_SPEC.md). Turns a one-time traffic spike into
 * recurring, on-demand returning traffic:
 *
 *   read NOAA Kp → if Kp ≥ 6 (G2+) → claim a debounced slot →
 *   fire ONE Resend Broadcast to AURORA_AUDIENCE_ID →
 *   "The sky's lighting up — watch it live: parkersphysics.com/earth.html"
 *
 * ── Debounce ─────────────────────────────────────────────────────────────
 *   try_claim_aurora_blast() only grants a slot if the last blast was more
 *   than ~12h ago, so one multi-day storm is ONE email, not five. A failed
 *   send releases the claim so the next tick retries within the same storm.
 *
 * ── Unsubscribe / compliance ─────────────────────────────────────────────
 *   The broadcast HTML embeds Resend's native {{{RESEND_UNSUBSCRIBE_URL}}}
 *   (one-click, stops future broadcasts at the audience level — CAN-SPAM /
 *   GDPR). Native unsubscribes are reconciled back into aurora_subscribers
 *   by api/subscribe/resend-webhook.js so the DB stays authoritative.
 *
 * ── Auth ─────────────────────────────────────────────────────────────────
 *   Vercel Cron sends `x-vercel-cron: 1`; when CRON_SECRET is set it also
 *   sends `Authorization: Bearer <secret>`. We accept either. Manual runs
 *   must carry the Bearer secret.
 *
 * ── Env ──────────────────────────────────────────────────────────────────
 *   SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_KEY (or SUPABASE_SECRET_KEY) — service_role
 *   RESEND_API_KEY
 *   AURORA_AUDIENCE_ID                      — the Resend Audience to blast
 *   AURORA_FROM_EMAIL (optional, default 'Parkers Physics <aurora@parkersphysics.com>')
 *   SITE_URL (optional, default 'https://parkersphysics.com')
 *   CRON_SECRET (optional but recommended)
 *
 * ── Manual / dry-run ─────────────────────────────────────────────────────
 *   GET /api/cron/aurora-storm-blast?dry=1        → evaluate, never send/claim
 *   GET /api/cron/aurora-storm-blast?kp=7.3       → override Kp (testing)
 *   GET /api/cron/aurora-storm-blast?force=1      → bypass the Kp threshold
 *   (all behind CRON_SECRET; force still honors the debounce window)
 */

import { fetchWithTimeout } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const RESEND_BROADCASTS = 'https://api.resend.com/broadcasts';
const RESEND_KEY   = process.env.RESEND_API_KEY || '';
const AUDIENCE_ID  = process.env.AURORA_AUDIENCE_ID || '';
const FROM_EMAIL   = process.env.AURORA_FROM_EMAIL || 'Parkers Physics <aurora@parkersphysics.com>';
const SITE_URL     = process.env.SITE_URL || 'https://parkersphysics.com';
const CRON_SECRET  = process.env.CRON_SECRET || '';

const NOAA_KP_1M = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';

// Fire at G2 (Kp 6) and up — strong enough that aurora reaches mid-latitudes
// where most of the list lives, but not so common that it desensitizes.
const KP_THRESHOLD = 6;
// Debounce window: one email per storm episode.
const DEBOUNCE_HOURS = 12;
// Look at the last ~30 readings (~30 min) and take the peak, so a brief dip
// between two 6+ samples doesn't make us miss onset.
const ONSET_WINDOW = 30;

function stormLabel(kp) {
    if (kp >= 9.0) return 'G5 — Extreme';
    if (kp >= 8.0) return 'G4 — Severe';
    if (kp >= 7.0) return 'G3 — Strong';
    if (kp >= 6.0) return 'G2 — Moderate';
    if (kp >= 5.0) return 'G1 — Minor';
    return 'Quiet';
}
function stormLevel(kp) {
    if (kp >= 9.0) return 5;
    if (kp >= 8.0) return 4;
    if (kp >= 7.0) return 3;
    if (kp >= 6.0) return 2;
    if (kp >= 5.0) return 1;
    return 0;
}

function isAuthorized(req) {
    const hdr = req.headers.get('authorization') || '';
    if (CRON_SECRET && hdr === `Bearer ${CRON_SECRET}`) return true;
    if (req.headers.get('x-vercel-cron')) return true;
    return false;
}

function jsonResp(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}

// ── Service-role RPC helper ────────────────────────────────────────────────
async function rpc(name, args) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
        method: 'POST',
        timeoutMs: 8_000,
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(args || {}),
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`rpc ${name} HTTP ${res.status}: ${t.slice(0, 240)}`);
    }
    return res.json().catch(() => null);
}

// ── NOAA Kp (peak over the onset window) ────────────────────────────────────
async function fetchPeakKp() {
    const res = await fetchWithTimeout(NOAA_KP_1M, {
        timeoutMs: 10_000,
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`NOAA HTTP ${res.status}`);
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('unexpected NOAA format');

    const fill = v => (v == null || v < 0) ? null : v;
    const rows = raw
        .filter(r => r?.time_tag)
        .map(r => ({ time_tag: r.time_tag, kp: fill(r.estimated_kp ?? r.kp_index ?? r.kp) }))
        .filter(r => r.kp != null);
    if (rows.length === 0) throw new Error('all Kp readings null');

    const window = rows.slice(-ONSET_WINDOW);
    let peak = window[0];
    for (const r of window) if (r.kp > peak.kp) peak = r;
    const latest = rows[rows.length - 1];
    return {
        peakKp:    Math.round(peak.kp * 100) / 100,
        peakAt:    peak.time_tag,
        currentKp: Math.round(latest.kp * 100) / 100,
        updated:   latest.time_tag,
    };
}

// ── Broadcast HTML (amber storm track) ──────────────────────────────────────
function buildBroadcastHtml(kp, label) {
    const watchUrl = `${SITE_URL}/earth.html?utm_source=aurora_alert&utm_medium=email&utm_campaign=storm_blast`;
    return `
      <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#03010e;color:#d6dee6;padding:32px;border-radius:12px;max-width:560px;margin:auto">
        <div style="color:#ffb066;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700">Aurora Alert · ${label}</div>
        <h1 style="color:#ffb066;font-size:22px;margin:6px 0 12px">The sky's lighting up.</h1>
        <p style="color:#b0c8d8;line-height:1.6;margin:0 0 8px">
          The planetary Kp index just hit <strong style="color:#ffd0a0">${kp}</strong> — a ${label.toLowerCase()} geomagnetic storm.
          The aurora is pushing toward lower latitudes right now. Step outside after dark and look toward the poles,
          and watch the storm hit Earth's magnetosphere live:
        </p>
        <p style="margin:24px 0">
          <a href="${watchUrl}" style="background:#ffb066;color:#03010e;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block">Watch it live →</a>
        </p>
        <p style="color:#7a98a8;font-size:12px;line-height:1.6">
          You're getting this because you subscribed to Parkers Physics aurora alerts.
          <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#7a98a8">Unsubscribe</a> anytime.
        </p>
      </div>`;
}

// ── Resend Broadcast: create then send ──────────────────────────────────────
async function fireBroadcast(kp, label) {
    const createRes = await fetchWithTimeout(RESEND_BROADCASTS, {
        method: 'POST',
        timeoutMs: 12_000,
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            audience_id: AUDIENCE_ID,
            from:        FROM_EMAIL,
            subject:     `Aurora alert: ${label} storm — watch it live`,
            name:        `Aurora storm blast Kp ${kp} ${new Date().toISOString().slice(0, 16)}`,
            html:        buildBroadcastHtml(kp, label),
        }),
    });
    if (!createRes.ok) {
        const t = await createRes.text().catch(() => '');
        throw new Error(`broadcast create HTTP ${createRes.status}: ${t.slice(0, 240)}`);
    }
    const created = await createRes.json().catch(() => ({}));
    const broadcastId = created?.id;
    if (!broadcastId) throw new Error('broadcast create returned no id');

    const sendRes = await fetchWithTimeout(`${RESEND_BROADCASTS}/${broadcastId}/send`, {
        method: 'POST',
        timeoutMs: 12_000,
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    if (!sendRes.ok) {
        const t = await sendRes.text().catch(() => '');
        throw new Error(`broadcast send HTTP ${sendRes.status}: ${t.slice(0, 240)}`);
    }
    return broadcastId;
}

// ── Handler ──────────────────────────────────────────────────────────────
export default async function handler(req) {
    if (!isAuthorized(req)) return jsonResp({ error: 'unauthorized' }, 401);
    if (!SUPABASE_URL || !SUPABASE_KEY) return jsonResp({ error: 'supabase_not_configured' }, 500);
    if (!RESEND_KEY)  return jsonResp({ error: 'resend_not_configured' }, 501);
    if (!AUDIENCE_ID) return jsonResp({ error: 'audience_not_configured' }, 501);

    const url    = new URL(req.url);
    const dryRun = url.searchParams.get('dry') === '1';
    const force  = url.searchParams.get('force') === '1';
    const kpOverride = url.searchParams.get('kp');

    // 1) Determine the storm level.
    let kpInfo;
    if (kpOverride != null && kpOverride !== '') {
        const v = Number(kpOverride);
        if (!Number.isFinite(v)) return jsonResp({ error: 'bad_kp_override' }, 400);
        kpInfo = { peakKp: v, currentKp: v, peakAt: null, updated: null, overridden: true };
    } else {
        try { kpInfo = await fetchPeakKp(); }
        catch (e) { return jsonResp({ error: 'kp_fetch_failed', detail: e.message }, 502); }
    }

    const kp    = kpInfo.peakKp;
    const level = stormLevel(kp);
    const label = stormLabel(kp);

    // 2) Threshold gate.
    if (kp < KP_THRESHOLD && !force) {
        return jsonResp({ ok: true, blasted: false, reason: 'below_threshold', kp, threshold: KP_THRESHOLD, ...kpInfo });
    }

    // 3) Dry run: report intent without claiming or sending.
    if (dryRun) {
        return jsonResp({ ok: true, dryRun: true, wouldBlast: true, kp, level, label, ...kpInfo });
    }

    // 4) Claim a debounced slot.
    let claim;
    try { claim = (await rpc('try_claim_aurora_blast', { p_kp: kp, p_storm_level: level, p_window_hours: DEBOUNCE_HOURS }))?.[0]; }
    catch (e) { return jsonResp({ error: 'claim_failed', detail: e.message }, 502); }

    if (!claim?.claimed) {
        return jsonResp({ ok: true, blasted: false, reason: 'debounced', kp, last_blast_at: claim?.last_blast_at || null });
    }

    // 5) Fire the broadcast. Release the claim on failure so a later tick can
    //    retry during the same active storm instead of being suppressed 12h.
    let broadcastId;
    try {
        broadcastId = await fireBroadcast(kp, label);
    } catch (e) {
        try { await rpc('release_aurora_blast', { p_id: claim.claim_id }); } catch { /* best effort */ }
        return jsonResp({ error: 'broadcast_failed', detail: e.message, kp, level }, 502);
    }

    // 6) Record the result (best-effort).
    try {
        await rpc('record_aurora_blast', {
            p_id: claim.claim_id,
            p_broadcast_id: broadcastId,
            p_recipients: null,
            p_metadata: { kp, level, label, current_kp: kpInfo.currentKp, peak_at: kpInfo.peakAt },
        });
    } catch { /* swallow */ }

    return jsonResp({ ok: true, blasted: true, kp, level, label, broadcast_id: broadcastId });
}
