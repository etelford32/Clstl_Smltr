/**
 * Vercel Edge Function: /api/welcome/send
 *
 * Sends the post-signup welcome email. Triggered client-side by
 * signup.html the moment the success view renders, so the user gets
 * a confirmation in their inbox before they finish reading the
 * dashboard's first paint.
 *
 * Idempotent: a `welcome_email_sent` activation event with a unique
 * partial index in supabase-welcome-email-migration.sql guarantees
 * "at most one welcome email per user." The edge function pre-checks
 * the same row before calling Resend so a duplicate request from the
 * client (refresh, double-fire from the wizard) doesn't cost us a
 * Resend send.
 *
 * ── Security ─────────────────────────────────────────────────────
 *  - Requires a valid Supabase JWT in the Authorization header (the
 *    user must be signed in — they just signed up, so this is true
 *    by construction in the only call site we ship).
 *  - All Supabase mutations use the service-role key.
 *  - RESEND_API_KEY is server-only.
 *
 * ── Request ──────────────────────────────────────────────────────
 *  POST /api/welcome/send
 *  Headers: Authorization: Bearer <user-jwt>
 *  Body:    {} (no parameters; everything is read from the JWT +
 *               user_profiles)
 *
 * ── Response ─────────────────────────────────────────────────────
 *  200: { ok: true, sent: true,  recipient: "user@…" }
 *  200: { ok: true, sent: false, reason: "already_sent" }
 *  401: { error: "unauthorized" }
 *  500: { error: "send_failed", detail: "..." }
 *  501: { error: "not_configured" } — RESEND_API_KEY / SUPABASE_SERVICE_KEY missing
 */

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://aijsboodkivnhzfstvdq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const RESEND_API   = 'https://api.resend.com/emails';
const RESEND_KEY   = process.env.RESEND_API_KEY || '';
const FROM_EMAIL   = process.env.WELCOME_FROM_EMAIL
                  || process.env.INVITE_FROM_EMAIL
                  || process.env.ALERT_FROM_EMAIL
                  || 'Parkers Physics <welcome@parkerphysics.com>';
const APP_URL      = process.env.APP_URL || 'https://parkerphysics.com';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
    || 'https://parkerphysics.com,https://parkersphysics.com,https://parkerphysics.app')
    .split(',').map(s => s.trim()).filter(Boolean);

function corsHeaders(origin) {
    const ok = origin && ALLOWED_ORIGINS.includes(origin);
    return {
        'Access-Control-Allow-Origin':  ok ? origin : ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Cache-Control':                'no-store',
    };
}

function jsonResp(body, status = 200, origin = '') {
    return Response.json(body, { status, headers: corsHeaders(origin) });
}

function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Verify the Supabase JWT and read the caller's profile (email,
 * display_name, plan). Returns null on any auth failure.
 */
async function verifyUser(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);

    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY || token },
        signal: AbortSignal.timeout(8000),
    });
    if (!userRes.ok) return null;
    const user = await userRes.json();
    if (!user?.id) return null;

    const profileRes = await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${user.id}&select=display_name,plan,email`,
        {
            headers: {
                apikey:        SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
            },
            signal: AbortSignal.timeout(8000),
        }
    );
    const rows = profileRes.ok ? await profileRes.json() : [];
    const profile = Array.isArray(rows) ? rows[0] : null;

    return {
        user_id:      user.id,
        email:        profile?.email || user.email,
        plan:         profile?.plan  || 'free',
        display_name: profile?.display_name
                   || user.user_metadata?.name
                   || (user.email || '').split('@')[0]
                   || 'Explorer',
    };
}

/**
 * Pre-check: has welcome_email_sent ALREADY been logged for this user?
 * The unique partial index also enforces this server-side, but checking
 * here lets us skip the Resend round-trip + return a clean
 * `sent: false, reason: 'already_sent'` instead of a 500.
 */
async function alreadySent(userId) {
    try {
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/activation_events`
            + `?user_id=eq.${userId}`
            + `&event=eq.welcome_email_sent`
            + `&select=id&limit=1`,
            {
                headers: {
                    apikey:        SUPABASE_KEY,
                    Authorization: `Bearer ${SUPABASE_KEY}`,
                },
                signal: AbortSignal.timeout(8000),
            }
        );
        if (!res.ok) return false;
        const rows = await res.json();
        return Array.isArray(rows) && rows.length > 0;
    } catch {
        // Soft-fail: if the pre-check hiccups, the unique-index in the DB
        // will catch a real duplicate downstream. Better to attempt and
        // potentially eat one redundant Resend call than to drop the
        // welcome on a transient Supabase glitch.
        return false;
    }
}

/**
 * Insert the activation_events row. Uses the same idempotent semantics
 * as log_activation_event() — INSERT ... ON CONFLICT DO NOTHING via the
 * unique partial index.
 */
async function logSent(userId, plan) {
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
                event:   'welcome_email_sent',
                plan:    plan || 'free',
                metadata: {},
            }),
            signal: AbortSignal.timeout(8000),
        });
    } catch (e) {
        // Non-fatal; the email already shipped. Log so an operator can
        // correlate "user got the email but the event row is missing"
        // against this warning if it ever happens.
        console.warn('[welcome] activation log failed:', e.message);
    }
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
 * Build the welcome HTML. Stays under 600px wide so it renders cleanly
 * in every mainstream client. Three CTAs (dashboard / Earth / account)
 * mirror the wizard's "Done" step links so a user who skipped the
 * wizard still gets the orientation cues.
 */
function buildWelcomeHtml({ name, plan }) {
    const label = PLAN_LABEL[plan] || 'Free Trial';
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0a14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#cdd">
<div style="max-width:560px;margin:0 auto;padding:28px 22px">

  <div style="text-align:center;margin-bottom:22px">
    <span style="font-size:1.05rem;font-weight:800;background:linear-gradient(45deg,#ffd700,#ff8c00);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:.04em">Parkers Physics</span>
  </div>

  <div style="background:#12111a;border:1px solid #2a2440;border-radius:12px;padding:26px 24px;margin-bottom:18px">
    <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:#c77dff;font-weight:800;margin-bottom:14px">Welcome aboard · ${escHtml(label)}</div>
    <h2 style="margin:0 0 12px;font-size:1.25rem;color:#fff;font-weight:700">Hi ${escHtml(name)} — your account is live.</h2>
    <p style="margin:0 0 14px;font-size:.95rem;color:#aab;line-height:1.6">
      Real-time space-weather data, satellite tracking, and 17+ interactive astrophysics simulations. Three quick stops to get the most out of your first session:
    </p>

    <div style="margin:18px 0">
      <a href="${APP_URL}/dashboard.html?welcome=1" style="display:inline-block;padding:13px 26px;background:linear-gradient(45deg,#ff8c00,#ffd700);color:#000;font-weight:700;border-radius:8px;text-decoration:none;font-size:.92rem">Open your dashboard →</a>
    </div>

    <div style="font-size:.84rem;color:#9892b8;line-height:1.7;border-top:1px solid #2a2440;padding-top:16px;margin-top:18px">
      <div style="margin-bottom:6px"><strong style="color:#c77dff">1. Set your location.</strong>
        Pin a city to anchor aurora alerts, ISS pass times, and storm warnings to where you live. The welcome wizard walks you through it on first dashboard load.</div>
      <div style="margin-bottom:6px"><strong style="color:#c77dff">2. See it in 3D.</strong>
        <a href="${APP_URL}/earth.html" style="color:#a080ff;text-decoration:none">The Earth globe</a> shows the live aurora oval, storm fronts, and your saved location as a glowing pin.</div>
      <div><strong style="color:#c77dff">3. Tune your alerts.</strong>
        <a href="${APP_URL}/account.html" style="color:#a080ff;text-decoration:none">Account → Notifications</a> has the granular controls — Kp threshold, storm G-scale, flare class, conjunction km, and email delivery.</div>
    </div>
  </div>

  <p style="margin:0;font-size:.7rem;color:#556;text-align:center;line-height:1.5">
    You're getting this because you signed up at <a href="${APP_URL}" style="color:#778;text-decoration:none">parkerphysics.com</a>.<br>
    Manage email preferences in <a href="${APP_URL}/account.html#notifications" style="color:#778;text-decoration:none">Account → Notifications</a>.
  </p>
</div>
</body></html>`;
}

export default async function handler(req) {
    const origin = req.headers.get('Origin') || '';

    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (req.method !== 'POST') return jsonResp({ error: 'method_not_allowed' }, 405, origin);
    if (!SUPABASE_KEY)         return jsonResp({ error: 'not_configured', detail: 'SUPABASE_SERVICE_KEY missing' }, 501, origin);
    if (!RESEND_KEY)           return jsonResp({ error: 'not_configured', detail: 'RESEND_API_KEY missing' }, 501, origin);

    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        return jsonResp({ error: 'forbidden_origin' }, 403, origin);
    }

    const auth = await verifyUser(req.headers.get('Authorization'));
    if (!auth) return jsonResp({ error: 'unauthorized' }, 401, origin);

    if (!auth.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(auth.email)) {
        return jsonResp({ error: 'no_email' }, 400, origin);
    }

    // Idempotency pre-check.
    if (await alreadySent(auth.user_id)) {
        return jsonResp({ ok: true, sent: false, reason: 'already_sent' }, 200, origin);
    }

    const subject = `Welcome to Parkers Physics`;
    const html    = buildWelcomeHtml({ name: auth.display_name, plan: auth.plan });

    try {
        const sendRes = await fetch(RESEND_API, {
            method:  'POST',
            headers: {
                Authorization:  `Bearer ${RESEND_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from:    FROM_EMAIL,
                to:      auth.email,
                subject,
                html,
            }),
            signal: AbortSignal.timeout(10000),
        });
        if (!sendRes.ok) {
            const detail = await sendRes.text().catch(() => '');
            return jsonResp({ error: 'send_failed', detail }, 500, origin);
        }
    } catch (e) {
        return jsonResp({ error: 'send_failed', detail: e.message }, 500, origin);
    }

    await logSent(auth.user_id, auth.plan);

    return jsonResp({ ok: true, sent: true, recipient: auth.email }, 200, origin);
}
