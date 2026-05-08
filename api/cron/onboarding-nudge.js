/**
 * Vercel Cron: /api/cron/onboarding-nudge
 *
 * T+24h post-signup nudge for users who never finished the welcome
 * wizard. Runs once a day; reuses the same Resend + activation_events
 * plumbing the welcome email built. Idempotent at three layers:
 *
 *   1. Cron schedule fires once/day (vercel.json)
 *   2. pending_onboarding_nudges() RPC excludes anyone who already
 *      has a nudge_sent row.
 *   3. The unique partial index uq_activation_events_first guarantees
 *      "at most one nudge_sent per user" even if two cron invocations
 *      race each other.
 *
 * Why this is the highest-leverage automation: the welcome email
 * lands the URL in the user's inbox at T+0, but a chunk of fresh
 * signups close the tab before opening the wizard at all. A friendly
 * T+24h nudge with a deep link `/dashboard?welcome=1` re-opens the
 * wizard and recovers those signups without any other intervention.
 *
 * ── Auth ─────────────────────────────────────────────────────────
 *   Vercel Cron sends `x-vercel-cron: 1`; when CRON_SECRET is set,
 *   the Bearer token is also accepted so manual invocations from a
 *   shell are possible during ops triage.
 *
 * ── Env vars ─────────────────────────────────────────────────────
 *   SUPABASE_URL / SUPABASE_SERVICE_KEY  — Postgres + RPC access
 *   RESEND_API_KEY                       — outbound email
 *   WELCOME_FROM_EMAIL  (optional, falls back to INVITE_FROM_EMAIL,
 *                        then ALERT_FROM_EMAIL)
 *   CRON_SECRET                          — optional but recommended
 *
 * ── Manual invocation (ops) ──────────────────────────────────────
 *   GET /api/cron/onboarding-nudge          — nudges everyone eligible
 *   GET /api/cron/onboarding-nudge?dry=1    — dry run (no Resend, no log)
 *   GET /api/cron/onboarding-nudge?max=5    — cap to N for canary
 *
 * ── Response ─────────────────────────────────────────────────────
 *   200: { ok: true, candidates: N, sent: M, skipped: K, errors: [...] }
 *   401: { error: "unauthorized" }
 *   500: { error: "fetch_eligible_failed", detail: "..." }
 *   501: { error: "resend_not_configured" }
 */

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const RESEND_API   = 'https://api.resend.com/emails';
const RESEND_KEY   = process.env.RESEND_API_KEY || '';
const FROM_EMAIL   = process.env.WELCOME_FROM_EMAIL
                  || process.env.INVITE_FROM_EMAIL
                  || process.env.ALERT_FROM_EMAIL
                  || 'Parkers Physics <welcome@parkerphysics.com>';
const APP_URL      = process.env.APP_URL || 'https://parkerphysics.com';
const CRON_SECRET  = process.env.CRON_SECRET || '';

// Defaults match the RPC's own defaults; overridable via query string.
const DEFAULT_MIN_HOURS = 24;
const DEFAULT_MAX_DAYS  = 7;
const DEFAULT_LIMIT     = 200;

// Resend's default tier allows 10 req/s; six concurrent sends keeps
// comfortable headroom while still draining a 200-user batch in ~1 min.
const CONCURRENCY = 6;

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

function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const PLAN_LABEL = {
    free:        'Free Trial',
    tester:      'Tester',
    basic:       'Basic',
    educator:    'Educator',
    advanced:    'Advanced',
    institution: 'Institution',
    enterprise:  'Enterprise',
};

/**
 * Build the nudge HTML. Friendly tone — these users opted in 24h
 * ago and walked away; we don't want to read as pushy. Deep-link
 * URL forces ?welcome=1 so the wizard re-opens regardless of the
 * pp_welcome_done flag (the wizard's shouldShowWizard() honors the
 * URL param ahead of localStorage).
 */
function buildNudgeHtml({ name, plan }) {
    const label = PLAN_LABEL[plan] || 'Free Trial';
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0a14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#cdd">
<div style="max-width:560px;margin:0 auto;padding:28px 22px">

  <div style="text-align:center;margin-bottom:22px">
    <span style="font-size:1.05rem;font-weight:800;background:linear-gradient(45deg,#ffd700,#ff8c00);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:.04em">Parkers Physics</span>
  </div>

  <div style="background:#12111a;border:1px solid #2a2440;border-radius:12px;padding:26px 24px;margin-bottom:18px">
    <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:#c77dff;font-weight:800;margin-bottom:14px">Finish setting up · ${escHtml(label)}</div>
    <h2 style="margin:0 0 12px;font-size:1.25rem;color:#fff;font-weight:700">Hi ${escHtml(name)} — your account's ready when you are.</h2>
    <p style="margin:0 0 14px;font-size:.95rem;color:#aab;line-height:1.6">
      You signed up yesterday but didn't finish setup. Two minutes will get you personalised aurora, storm, and ISS-pass alerts for where you live.
    </p>

    <div style="margin:18px 0">
      <a href="${APP_URL}/dashboard.html?welcome=1" style="display:inline-block;padding:13px 26px;background:linear-gradient(45deg,#ff8c00,#ffd700);color:#000;font-weight:700;border-radius:8px;text-decoration:none;font-size:.92rem">Finish setup →</a>
    </div>

    <div style="font-size:.84rem;color:#9892b8;line-height:1.7;border-top:1px solid #2a2440;padding-top:16px;margin-top:18px">
      The setup flow is two steps: pin your location, choose what you want alerts about. That's it. You can fine-tune everything later from
      <a href="${APP_URL}/account.html" style="color:#a080ff;text-decoration:none">Account → Notifications</a>.
    </div>
  </div>

  <p style="margin:0;font-size:.7rem;color:#556;text-align:center;line-height:1.5">
    You're getting this because you signed up at <a href="${APP_URL}" style="color:#778;text-decoration:none">parkerphysics.com</a>. You'll only get this nudge once.<br>
    Manage email preferences in <a href="${APP_URL}/account.html#notifications" style="color:#778;text-decoration:none">Account → Notifications</a>.
  </p>
</div>
</body></html>`;
}

// ── Supabase helpers (service-role) ──────────────────────────────────────

async function fetchPending({ minHours, maxDays, limit }) {
    const url = `${SUPABASE_URL}/rest/v1/rpc/pending_onboarding_nudges`;
    const res = await fetch(url, {
        method:  'POST',
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type':'application/json',
        },
        body: JSON.stringify({
            p_min_hours: minHours,
            p_max_days:  maxDays,
            p_limit:     limit,
        }),
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`fetchPending HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    return await res.json();
}

/**
 * Insert a nudge_sent row. Uses Prefer:resolution=ignore-duplicates so
 * the unique partial index turns a race condition into a no-op instead
 * of a 409. Cron runs are minutes apart, so practical races are rare;
 * the belt-and-braces is for the case where an ops engineer manually
 * invokes the cron while the schedule is mid-flight.
 */
async function logNudgeSent({ userId, plan }) {
    try {
        await fetch(`${SUPABASE_URL}/rest/v1/activation_events`, {
            method:  'POST',
            headers: {
                apikey:        SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type':'application/json',
                Prefer:        'resolution=ignore-duplicates',
            },
            body: JSON.stringify({
                user_id: userId,
                event:   'nudge_sent',
                plan:    plan || 'free',
                metadata: {},
            }),
            signal: AbortSignal.timeout(8_000),
        });
    } catch (e) {
        console.warn('[onboarding-nudge] activation log failed:', e.message);
    }
}

async function sendNudgeEmail({ to, name, plan }) {
    const res = await fetch(RESEND_API, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${RESEND_KEY}`,
            'Content-Type':'application/json',
        },
        body: JSON.stringify({
            from:    FROM_EMAIL,
            to,
            subject: `Finish setting up Parkers Physics`,
            html:    buildNudgeHtml({ name, plan }),
        }),
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Resend HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
}

// Bounded-concurrency pump — same pattern as daily-forecast-digest.
async function processWithLimit(items, limit, worker) {
    const results = [];
    let cursor = 0;
    async function pump() {
        while (true) {
            const idx = cursor++;
            if (idx >= items.length) return;
            results[idx] = await worker(items[idx], idx);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
    return results;
}

// ── Handler ──────────────────────────────────────────────────────────────

export default async function handler(req) {
    if (!isAuthorized(req))                  return jsonResp({ error: 'unauthorized' }, 401);
    if (!SUPABASE_URL || !SUPABASE_KEY)      return jsonResp({ error: 'supabase_not_configured' }, 500);
    if (!RESEND_KEY)                         return jsonResp({ error: 'resend_not_configured' }, 501);

    const url       = new URL(req.url);
    const dryRun    = url.searchParams.get('dry') === '1';
    const minHours  = +(url.searchParams.get('min_hours') || DEFAULT_MIN_HOURS);
    const maxDays   = +(url.searchParams.get('max_days')  || DEFAULT_MAX_DAYS);
    const overrideMax = +(url.searchParams.get('max') || 0);
    const limit     = overrideMax > 0
        ? Math.min(overrideMax, DEFAULT_LIMIT)
        : DEFAULT_LIMIT;

    let pending;
    try {
        pending = await fetchPending({ minHours, maxDays, limit });
    } catch (e) {
        return jsonResp({ error: 'fetch_eligible_failed', detail: e.message }, 502);
    }

    if (!Array.isArray(pending) || pending.length === 0) {
        return jsonResp({ ok: true, candidates: 0, sent: 0, skipped: 0, dryRun });
    }

    if (dryRun) {
        // Mask the local-part to keep email addresses out of the response
        // body when CRON_SECRET isn't set. The first two chars + a hash
        // are enough for ops to reconcile against the activation_events
        // table without leaking the full plaintext.
        const masked = pending.map(p => {
            const [local, domain] = (p.email || '').split('@');
            const m = local ? `${local.slice(0, 2)}***@${domain}` : '(no email)';
            return { user_id: p.user_id, masked_email: m, plan: p.plan, signed_up_at: p.signed_up_at };
        });
        return jsonResp({ ok: true, dryRun: true, candidates: pending.length, would_send: masked });
    }

    const errors = [];
    let sent = 0;

    await processWithLimit(pending, CONCURRENCY, async (row) => {
        try {
            await sendNudgeEmail({ to: row.email, name: row.display_name, plan: row.plan });
            await logNudgeSent({ userId: row.user_id, plan: row.plan });
            sent++;
        } catch (e) {
            errors.push({ user_id: row.user_id, error: e.message?.slice(0, 200) || String(e).slice(0, 200) });
        }
    });

    return jsonResp({
        ok:         true,
        candidates: pending.length,
        sent,
        skipped:    pending.length - sent - errors.length,
        errors:     errors.slice(0, 20),
    });
}
