/**
 * Vercel Edge Function: /api/invites/send
 *
 * Admin-only. Generates a fresh invite code targeted at one email
 * address, persists it in invite_codes (with invited_email / sent_at /
 * created_by populated), and emails the invitee a magic link to the
 * signup page (?code=…&email=…) via Resend.
 *
 * ── Security ─────────────────────────────────────────────────────
 *  - Requires a valid Supabase JWT in the Authorization header.
 *  - Verifies the caller's user_profiles.role is 'admin' or
 *    'superadmin'. Non-admins get 403.
 *  - All Supabase mutations use the service-role key so RLS is
 *    bypassed; the auth gate is the JWT + role check above.
 *  - The Resend API key is read from RESEND_API_KEY (server-only).
 *
 * ── Request ──────────────────────────────────────────────────────
 *  POST /api/invites/send
 *  Headers: Authorization: Bearer <admin-jwt>
 *  Body:    { email, plan?, expiry_days?, name? }
 *           plan defaults to 'free'; expiry_days defaults to 30.
 *
 * ── Response ─────────────────────────────────────────────────────
 *  200: { ok: true, code: "ABC23XYZ", invite_id: "<uuid>",
 *         link: "https://parkerphysics.com/signup?code=…&email=…" }
 *  400: { error: "missing_email" | "invalid_plan" }
 *  401: { error: "unauthorized" }   — bad / missing JWT
 *  403: { error: "forbidden" }      — JWT valid, not an admin
 *  500: { error: "send_failed", detail: "..." }
 *  501: { error: "not_configured" } — RESEND_API_KEY not set
 */

export const config = { runtime: 'edge' };

// Dual-name env vars — see api/weather/grid.js for rationale.
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://aijsboodkivnhzfstvdq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const RESEND_API   = 'https://api.resend.com/emails';
const RESEND_KEY   = process.env.RESEND_API_KEY || '';
const FROM_EMAIL   = process.env.INVITE_FROM_EMAIL
                  || process.env.ALERT_FROM_EMAIL
                  || 'Parker Physics <invites@parkerphysics.com>';
const APP_URL      = process.env.APP_URL || 'https://parkerphysics.com';

const VALID_PLANS  = new Set(['free', 'basic', 'educator', 'advanced', 'institution', 'enterprise']);

/** Display label for each tier; used in email copy + audit log subjects. */
const PLAN_LABEL = {
    free:        'Free',
    basic:       'Basic',
    educator:    'Educator',
    advanced:    'Advanced',
    institution: 'Institution',
    enterprise:  'Enterprise',
};
const CODE_ALPHA   = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1
const CODE_LEN     = 8;

// Per-admin rate limit. Higher than the alerts endpoint's 10/hr
// because admins burst-invite at launch (e.g. 100 founding users in
// one sitting). 200/hr ≈ 33,600/wk per admin — well above realistic
// hand-issued volume but tight enough to bound damage from a
// compromised admin account.
const MAX_PER_HOUR = 200;

function jsonResp(body, status = 200) {
    return Response.json(body, {
        status,
        headers: {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Cache-Control':                'no-store',
        },
    });
}

function generateCode() {
    const arr = new Uint8Array(CODE_LEN);
    crypto.getRandomValues(arr);
    let code = '';
    for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHA[arr[i] % CODE_ALPHA.length];
    return code;
}

function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Verify Supabase JWT AND assert admin role. Returns user info
 * on success, null on auth failure. Throws on transient errors.
 */
async function verifyAdmin(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) return { error: 'unauthorized' };
    const token = authHeader.slice(7);

    // Validate the JWT against Supabase Auth
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY || token },
        signal: AbortSignal.timeout(8000),
    });
    if (!userRes.ok) return { error: 'unauthorized' };
    const user = await userRes.json();
    if (!user?.id) return { error: 'unauthorized' };

    // Check role in user_profiles via service-role key
    const profileRes = await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?select=role&id=eq.${user.id}`,
        {
            headers: {
                apikey:        SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
            },
            signal: AbortSignal.timeout(8000),
        }
    );
    if (!profileRes.ok) return { error: 'unauthorized' };
    const rows = await profileRes.json();
    const role = Array.isArray(rows) && rows[0]?.role;
    if (role !== 'admin' && role !== 'superadmin') return { error: 'forbidden' };

    return { user_id: user.id, email: user.email, role };
}

/**
 * DB-backed per-admin rate limit + audit log via the shared
 * try_send_email_quota RPC. Atomically checks whether this admin is
 * under MAX_PER_HOUR sends and inserts a row in email_send_log
 * (throttled flag set accordingly). Returns true if the send may
 * proceed.
 *
 * Fails open on Supabase / network error — admin issuing invites
 * shouldn't be blocked by a transient infra problem when the
 * /auth/v1/user check already succeeded. Admin role gate above is
 * the primary defence.
 */
async function checkAdminRate({ userId, recipient, subject, plan }) {
    if (!SUPABASE_KEY) return true;
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/try_send_email_quota`, {
            method:  'POST',
            headers: {
                apikey:        SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type':'application/json',
            },
            body: JSON.stringify({
                p_user_id:        userId,
                p_endpoint:       'invites',
                p_recipient:      recipient,
                p_subject:        subject,
                p_metadata:       { plan },
                p_limit:          MAX_PER_HOUR,
                p_window_seconds: 3600,
            }),
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
            console.warn('[invites/send] quota RPC HTTP', res.status, '— failing open');
            return true;
        }
        const allowed = await res.json();
        return allowed === true;
    } catch (e) {
        console.warn('[invites/send] quota RPC error:', e.message, '— failing open');
        return true;
    }
}

async function insertInvite({ code, plan, invitedEmail, expiryDays, createdBy }) {
    const expiresAt = expiryDays > 0
        ? new Date(Date.now() + expiryDays * 86400_000).toISOString()
        : null;

    const res = await fetch(`${SUPABASE_URL}/rest/v1/invite_codes`, {
        method:  'POST',
        headers: {
            apikey:        SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type':'application/json',
            Prefer:        'return=representation',
        },
        body: JSON.stringify({
            code,
            plan,
            max_uses:      1,
            used_count:    0,
            invited_email: invitedEmail,
            sent_at:       new Date().toISOString(),
            expires_at:    expiresAt,
            created_by:    createdBy,
            active:        true,
        }),
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Supabase insert ${res.status}: ${txt}`);
    }
    const rows = await res.json();
    return rows?.[0]?.id;
}

function buildInviteHtml({ recipientName, recipientEmail, plan, link, code, inviterName }) {
    const planLabel = PLAN_LABEL[plan] || 'Free';
    const greeting  = recipientName
        ? `Hi ${escHtml(recipientName)},`
        : `Hi there,`;
    const inviter   = inviterName ? ` from ${escHtml(inviterName)}` : '';

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0a14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 20px">
  <div style="text-align:center;margin-bottom:20px">
    <span style="font-size:1.1rem;font-weight:800;background:linear-gradient(45deg,#ffd700,#ff8c00);-webkit-background-clip:text;-webkit-text-fill-color:transparent">Parker Physics</span>
  </div>
  <div style="background:#12111a;border:1px solid #222;border-radius:12px;padding:24px;margin-bottom:16px">
    <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:#c080ff;font-weight:700;margin-bottom:14px">You're invited${inviter}</div>
    <h2 style="margin:0 0 12px;font-size:1.25rem;color:#e8f4ff;font-weight:700">${greeting}</h2>
    <p style="margin:0 0 18px;font-size:.92rem;color:#aab;line-height:1.6">
      You've been invited to join Parker Physics on the <strong style="color:#fff">${escHtml(planLabel)}</strong> tier — a real-time space-weather, satellite tracking, and earth visualization platform.
    </p>
    <div style="text-align:center;margin:24px 0">
      <a href="${escHtml(link)}" style="display:inline-block;padding:12px 28px;background:linear-gradient(45deg,#ff8c00,#ffd700);color:#000;font-weight:700;border-radius:8px;text-decoration:none;font-size:.9rem">Accept invite →</a>
    </div>
    <p style="margin:0;font-size:.78rem;color:#778;line-height:1.6">
      Or copy this link:<br>
      <code style="word-break:break-all;color:#9ad;font-size:.74rem">${escHtml(link)}</code>
    </p>
    <p style="margin:18px 0 0;font-size:.78rem;color:#778;line-height:1.6">
      Your invite code: <code style="color:#fff;letter-spacing:.1em;background:#0a0a14;padding:3px 8px;border-radius:4px">${escHtml(code)}</code>
    </p>
  </div>
  <p style="margin-top:18px;font-size:.65rem;color:#445;text-align:center;line-height:1.5">
    This invite was sent to <strong>${escHtml(recipientEmail)}</strong>. If you weren't expecting it, you can ignore this email.
  </p>
</div>
</body></html>`;
}

export default async function handler(req) {
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin':  '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            },
        });
    }
    if (req.method !== 'POST') return jsonResp({ error: 'method_not_allowed' }, 405);
    if (!SUPABASE_KEY)         return jsonResp({ error: 'not_configured', detail: 'SUPABASE_SERVICE_KEY missing' }, 501);
    if (!RESEND_KEY)           return jsonResp({ error: 'not_configured', detail: 'RESEND_API_KEY missing' }, 501);

    // Auth gate
    let auth;
    try { auth = await verifyAdmin(req.headers.get('Authorization')); }
    catch (e) { return jsonResp({ error: 'auth_check_failed', detail: e.message }, 500); }
    if (auth.error === 'unauthorized') return jsonResp({ error: 'unauthorized' }, 401);
    if (auth.error === 'forbidden')    return jsonResp({ error: 'forbidden' }, 403);

    // Parse body
    let payload;
    try { payload = await req.json(); }
    catch { return jsonResp({ error: 'invalid_body' }, 400); }

    const recipientEmail = String(payload.email ?? '').trim().toLowerCase();
    const plan           = String(payload.plan ?? 'free').toLowerCase();
    const expiryDays     = Number.isFinite(+payload.expiry_days) ? +payload.expiry_days : 30;
    const recipientName  = payload.name ? String(payload.name).slice(0, 60) : null;

    if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
        return jsonResp({ error: 'missing_email' }, 400);
    }
    if (!VALID_PLANS.has(plan)) {
        return jsonResp({ error: 'invalid_plan', detail: `plan must be one of ${[...VALID_PLANS].join(', ')}` }, 400);
    }

    // Rate limit + audit log (atomic, global across POPs).
    // Including the tier in the subject is a defense-in-depth measure: if
    // an admin account is compromised and starts issuing Advanced/
    // Institution invites in bulk, the audit log makes the abuse pattern
    // obvious instead of burying high-value invites among Free ones.
    const subject = `You're invited to Parker Physics — ${PLAN_LABEL[plan] || 'Free'} tier`;
    const allowed = await checkAdminRate({
        userId:    auth.user_id,
        recipient: recipientEmail,
        subject,
        plan,
    });
    if (!allowed) {
        return jsonResp({ error: 'rate_limited', detail: `Max ${MAX_PER_HOUR} invites per hour per admin` }, 429);
    }

    // Generate + persist
    const code = generateCode();
    let inviteId;
    try {
        inviteId = await insertInvite({
            code,
            plan,
            invitedEmail: recipientEmail,
            expiryDays,
            createdBy:    auth.user_id,
        });
    } catch (e) {
        return jsonResp({ error: 'persist_failed', detail: e.message }, 500);
    }

    // Build the magic link. signup.html parses ?code= and ?email= and
    // pre-fills + pre-validates the invite.
    const link = `${APP_URL}/signup?code=${encodeURIComponent(code)}`
              +  `&email=${encodeURIComponent(recipientEmail)}`;

    // Send via Resend (subject defined above for the rate-limit log).
    const html    = buildInviteHtml({
        recipientName,
        recipientEmail,
        plan,
        link,
        code,
        inviterName: null,    // future: pull from user_profiles.full_name
    });

    try {
        const sendRes = await fetch(RESEND_API, {
            method:  'POST',
            headers: {
                Authorization:  `Bearer ${RESEND_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from:    FROM_EMAIL,
                to:      recipientEmail,
                subject,
                html,
            }),
            signal: AbortSignal.timeout(10000),
        });
        if (!sendRes.ok) {
            const detail = await sendRes.text().catch(() => '');
            return jsonResp({ error: 'send_failed', detail, code, invite_id: inviteId, link }, 500);
        }
    } catch (e) {
        return jsonResp({ error: 'send_failed', detail: e.message, code, invite_id: inviteId, link }, 500);
    }

    return jsonResp({ ok: true, code, invite_id: inviteId, link, sent_to: recipientEmail });
}
